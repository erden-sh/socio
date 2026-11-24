import { DEACTIVATED_MESSAGE } from '@socio/shared/auth';
import {
    type AppVariant,
    DEVICE_AUTH_PATH,
    type DevicePlatform,
    normalizeCode,
    PAIRING_CODE_LENGTH,
    pairClaimAnswerSchema,
    parseAppLink,
} from '@socio/shared/device-sign-in';

import { type AddressCheck, addressRules, checkAddress, LOCAL_HTTP_HOSTS } from './address';
import { createAuthedFetch } from './authed-fetch';
import { memoryJarStore, openCookieJar } from './cookie-jar';
import { AbortedError, NetworkError } from './errors';
import type { FetchFunction } from './fetch-function';
import { readJson, readText } from './read-body';
import type { SignInProblem } from './sign-in';
import { SERVER_ERROR, UNREACHABLE, waitText, WORKSPACE_CHANGED } from './sign-in-copy';

// Add a device, on the new device, the parts with no React Native: the QR code's link read back,
// the claim, and the words and view models the AddDevice screen draws from. src/data/add-device.ts
// runs the steps; src/net/sign-in.ts's `redeemPairing` polls.
//
// - The QR link is the server's
//   `https://<link host>/<variant path>/d/<workspace host>#c=<12-symbol code>`, read with
//   @socio/shared's `parseAppLink` on this build's link host and taken only for this build's
//   variant. Its workspace host is checked as a typed address is (`checkAddress`).
// - `POST /api/auth/device/pair/claim {code, challenge, label, platform, variant}` (no cookie) uses
//   the pairing code up, whoever claims it first, and answers the claim: its id, the 6 digits the
//   server made, its expiry, the workspace and the account it would sign in as. The digits go to
//   this device only, and the web never sees them: the person types them there.
// - Nothing here logs, and no problem holds the code, the digits, the claim id or the verifier.

/** The server's claim. */
export const PAIR_CLAIM_PATH = `${DEVICE_AUTH_PATH}/pair/claim`;
/** The server's claim cancel: always 200 `{ state: 'denied' }`, safe to repeat; it ends the claim and its QR code at once. */
export const PAIR_CANCEL_PATH = `${DEVICE_AUTH_PATH}/pair/cancel`;
/** A cancel is one try, cut off after this: the claim dies by itself in 2 minutes anyway. */
export const CANCEL_TIMEOUT_MS = 3000;
/** How long a claim lives (the server's CLAIM_MS): the countdown starts at the claim's answer. */
export const CLAIM_MS = 2 * 60_000;
/** How often the redeem is polled: the server allows one a second per claim, so every 2 s stays clear of `too_many`. */
export const POLL_MS = 2000;

/** What this build reads Add a device links with: its variant and the link host from its config. */
export interface DeviceLinkConfig {
    readonly variant: AppVariant;
    readonly linkHost: string;
}

/** The link host from the build's embedded config (`extra.linkHost`), or null without one. */
export function deviceLinkConfig(
    extra: { readonly [key: string]: unknown } | null | undefined,
    variant: AppVariant,
): DeviceLinkConfig | null {
    const linkHost = extra?.linkHost;
    return typeof linkHost === 'string' && linkHost !== '' ? { variant, linkHost } : null;
}

/** An Add a device link read back: the pairing code (canonical) and the workspace host it is for. */
export interface DeviceLink {
    readonly code: string;
    /** `URL.host` of the workspace that made it (a port kept). */
    readonly host: string;
}

/**
 * The Add a device link in `url`, or null when it isn't this build's: another host, kind or
 * variant, a query, a missing or extra field, or a value that isn't a pairing code.
 */
export function readDeviceLink(url: string, config: DeviceLinkConfig): DeviceLink | null {
    const link = parseAppLink(url, config.linkHost);
    if (link === null || link.kind !== 'd' || link.variant !== config.variant) {
        return null;
    }
    const code = normalizeCode((link.fields as { c: string }).c, PAIRING_CODE_LENGTH);
    return code === null ? null : { code, host: link.host };
}

/**
 * The workspace's address from a link's host, checked as a typed address is (`checkAddress`, the
 * variant's rules): https, except a development build's local server (`10.0.2.2:4351`), which is
 * the plain http the build already takes for it.
 */
export function deviceLinkAddress(host: string, variant: AppVariant): AddressCheck {
    const hostname = host.replace(/:\d+$/, '');
    const local = addressRules(variant) === 'development' && LOCAL_HTTP_HOSTS.includes(hostname);
    return checkAddress(local ? `http://${host}` : host, variant);
}

/** What the claim answered: who the device would sign in as, and the digits to show. */
export interface PairClaim {
    readonly claimId: string;
    readonly digits: string;
    readonly workspace: { readonly name: string; readonly host: string };
    readonly account: { readonly name: string; readonly email: string };
}

/** Why a claim didn't work. Only kinds and the status, never the code. */
export type ClaimProblem =
    /** 400 `code_invalid`: the QR code was used already (by any device), or it ran out. */
    | { readonly kind: 'code-used'; readonly status: number }
    /** 400 `wrong_variant`: the QR code was made for another of Socio's builds. */
    | { readonly kind: 'wrong-variant'; readonly status: number }
    /** 429: 10 claims a minute from this address. */
    | { readonly kind: 'rate-limited'; readonly status: number; readonly retryAfterSeconds: number | null }
    | { readonly kind: 'unreachable'; readonly status: null }
    | { readonly kind: 'server-error'; readonly status: number }
    /** Anything else, an answer that can't be read, or one for another workspace than the link's. */
    | { readonly kind: 'unknown'; readonly status: number | null };

export type ClaimResult =
    | { readonly ok: true; readonly claim: PairClaim }
    | { readonly ok: false; readonly problem: ClaimProblem };

export interface ClaimOptions {
    readonly origin: string;
    readonly code: string;
    readonly challenge: string;
    readonly label: string;
    readonly platform: DevicePlatform;
    readonly variant: AppVariant;
    readonly fetch: FetchFunction;
    readonly userAgent: string;
    readonly signal?: AbortSignal;
}

const SECONDS = /^\d{1,9}$/;
const CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Claims the QR code's pairing code at `origin`. No cookie goes or is kept: a fresh jar in
 * memory, discarded after. Resolves with the claim, or why not; rejects only with AbortedError.
 */
export async function claimPairing(options: ClaimOptions): Promise<ClaimResult> {
    const { origin, fetch, userAgent, signal } = options;
    const jar = await openCookieJar({ origin, store: memoryJarStore() });
    const scope = new AbortController();
    const stop = () => scope.abort(signal?.reason);
    if (signal?.aborted) {
        stop();
    } else {
        signal?.addEventListener('abort', stop, { once: true });
    }
    try {
        const request = createAuthedFetch({ origin, jar, fetch, userAgent, signal: scope.signal });
        let answer: Response;
        try {
            answer = await request(PAIR_CLAIM_PATH, {
                method: 'POST',
                json: {
                    code: options.code,
                    challenge: options.challenge,
                    label: options.label,
                    platform: options.platform,
                    variant: options.variant,
                },
            });
        } catch (error) {
            onlyAbort(error);
            return {
                ok: false,
                problem: error instanceof NetworkError ? { kind: 'unreachable', status: null } : unknown(null),
            };
        }
        const { status } = answer;
        let body: unknown = null;
        try {
            body = await readJson(answer, scope.signal);
        } catch (error) {
            onlyAbort(error);
            if (answer.ok) {
                return { ok: false, problem: unknown(status) };
            }
            await readText(answer, scope.signal).catch(onlyAbort);
        }
        if (answer.ok) {
            const parsed = pairClaimAnswerSchema.safeParse(body);
            if (!parsed.success || parsed.data.workspace.host !== new URL(origin).host) {
                return { ok: false, problem: unknown(status) };
            }
            const { claimId, digits, workspace, account } = parsed.data;
            return { ok: true, claim: { claimId, digits, workspace, account } };
        }
        if (status === 429) {
            const wait = ['x-retry-after', 'retry-after']
                .map((name) => answer.headers.get(name)?.trim())
                .find((value) => value !== undefined && SECONDS.test(value));
            return {
                ok: false,
                problem: { kind: 'rate-limited', status, retryAfterSeconds: wait === undefined ? null : Number(wait) },
            };
        }
        const code =
            typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string'
                ? (body as { code: string }).code
                : null;
        if (code !== null && CODE.test(code)) {
            if (code === 'code_invalid' || code === 'code_expired') {
                return { ok: false, problem: { kind: 'code-used', status } };
            }
            if (code === 'wrong_variant') {
                return { ok: false, problem: { kind: 'wrong-variant', status } };
            }
        }
        return { ok: false, problem: status >= 500 ? { kind: 'server-error', status } : unknown(status) };
    } finally {
        signal?.removeEventListener('abort', stop);
        scope.abort();
        await jar.close().catch(() => undefined);
    }
}

const unknown = (status: number | null): ClaimProblem => ({ kind: 'unknown', status });

export interface CancelOptions {
    readonly origin: string;
    readonly claimId: string;
    readonly fetch: FetchFunction;
    readonly userAgent: string;
    /** Defaults to CANCEL_TIMEOUT_MS. */
    readonly timeoutMs?: number;
}

/**
 * Ends a live claim on the server (the person's Cancel, or leaving the screen): one try, no cookie,
 * cut off after `timeoutMs`. Best effort: it never rejects and reports nothing, so the claim id goes
 * into the request's body and nowhere else.
 */
export async function cancelPairing(options: CancelOptions): Promise<void> {
    const { origin, fetch, userAgent } = options;
    const scope = new AbortController();
    const timer = setTimeout(() => scope.abort(), options.timeoutMs ?? CANCEL_TIMEOUT_MS);
    try {
        const jar = await openCookieJar({ origin, store: memoryJarStore() });
        try {
            const request = createAuthedFetch({ origin, jar, fetch, userAgent, signal: scope.signal });
            const answer = await request(PAIR_CANCEL_PATH, { method: 'POST', json: { claimId: options.claimId } });
            await readText(answer, scope.signal);
        } finally {
            await jar.close().catch(() => undefined);
        }
    } catch {
        // Ignored: the claim still ends at its 2 minutes.
    } finally {
        clearTimeout(timer);
        scope.abort();
    }
}

function onlyAbort(error: unknown): void {
    if (error instanceof AbortedError) {
        throw error;
    }
}

// ---------------------------------------------------------------------------
// The words: "Add a device", never "phone"; nothing about phone numbers.

/** The first step's title, before the claim. */
export const ADD_DEVICE_TITLE = 'Sign in on this device';
/** The first step's line: what Continue does. */
export const ADD_DEVICE_LINE = 'Continue shows a code here. You type it on your computer to sign in.';
/** Under the digits. */
export const DIGITS_INSTRUCTION = 'Type this code on your computer to sign in';

/** The digits step's question: who this device would sign in as. */
export const signInAsQuestion = (workspace: string, account: { readonly name: string; readonly email: string }) =>
    account.name.trim() === ''
        ? `Sign in to ${workspace} as ${account.email}?`
        : `Sign in to ${workspace} as ${account.name} (${account.email})?`;

/** Someone else's copy of the workspace is on this device: Cancel is the default. */
export const otherAccountQuestion = (workspace: string, current: string | null, next: string) =>
    current === null
        ? `This device is signed in to ${workspace} as someone else. Sign in as ${next} instead?`
        : `This device is signed in to ${workspace} as ${current}. Sign in as ${next} instead?`;

/** Under the other-account question: what signing in as the other person deletes. */
export function otherAccountLine(unsent: number | null): string {
    const removed = 'Their copy of this workspace will be removed from this device.';
    if (unsent === null) {
        return `${removed} Anything they haven't sent yet will be deleted.`;
    }
    if (unsent === 0) {
        return `${removed} Nothing of theirs is waiting to be sent.`;
    }
    return `${removed} ${unsent === 1 ? '1 unsent item' : `${unsent} unsent items`} will be deleted.`;
}

/** The 6 digits as shown: two groups of three. */
export const shownDigits = (digits: string) => `${digits.slice(0, 3)} ${digits.slice(3)}`;

/** Whole seconds left of the claim, 0 once it ended. */
export function secondsLeft(deadline: number, now: number): number {
    return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** "Expires in 1:42". */
export function countdownLabel(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `Expires in ${minutes}:${String(rest).padStart(2, '0')}`;
}

export const CODE_USED = 'This code was already used. Make a new one on your computer.';
export const CLAIM_WRONG_APP =
    'This QR code was made for another Socio app on this device. Open it with that app, or make a new one on your computer.';
export const CLAIM_EXPIRED = 'The 2 minutes ran out before your computer confirmed. Make a new code on your computer.';
export const CLAIM_DENIED =
    'Your computer didn’t confirm this sign-in: it was turned down there, the code was typed wrong 3 times, or the page was closed. Make a new code on your computer.';
export const CLAIM_SIGNED_OUT =
    'You signed out on your computer before this device finished. Sign in there again, then make a new code.';
export const CLAIM_METHOD_OFF =
    'The way you signed in on your computer is turned off for this workspace now. Sign in there another way, then make a new code.';
export const CLAIM_DEAD = 'This sign-in can’t finish any more. Make a new code on your computer.';
/** Polling got no answer: it keeps trying until the claim ends. */
export const STILL_TRYING = 'Can’t reach the workspace right now. Still trying.';
export const CLAIM_TOO_MANY = (seconds: number | null) =>
    `Too many tries from this network. Wait ${waitText(seconds)}, then scan the code again.`;

/** The line for a claim that didn't work. */
export function claimLine(problem: ClaimProblem): string {
    switch (problem.kind) {
        case 'code-used':
            return CODE_USED;
        case 'wrong-variant':
            return CLAIM_WRONG_APP;
        case 'rate-limited':
            return CLAIM_TOO_MANY(problem.retryAfterSeconds);
        case 'unreachable':
            return UNREACHABLE;
        case 'server-error':
            return SERVER_ERROR;
        case 'unknown':
            return CLAIM_DEAD;
    }
}

/**
 * What a poll's answer means: keep polling (the web hasn't typed the digits, the network blinked,
 * the server was busy), or the claim is over with its line. `expired` says whether the claim's 2
 * minutes passed by this device's clock, which tells a run-out claim's `denied` from a refused one.
 * `code-expired` is this device's own end of the claim (its countdown reached 0).
 */
export type PollVerdict =
    | { readonly kind: 'wait'; readonly reaching: boolean }
    | { readonly kind: 'ended'; readonly line: string };

export function pollVerdict(problem: SignInProblem, expired: boolean): PollVerdict {
    switch (problem.kind) {
        case 'not-allowed-yet':
        case 'rate-limited':
            return { kind: 'wait', reaching: true };
        case 'unreachable':
        case 'server-error':
            return { kind: 'wait', reaching: false };
        case 'sheet-denied':
            return { kind: 'ended', line: expired ? CLAIM_EXPIRED : CLAIM_DENIED };
        case 'code-expired':
            return { kind: 'ended', line: CLAIM_EXPIRED };
        case 'workspace-changed':
            return { kind: 'ended', line: WORKSPACE_CHANGED };
        case 'not-authorized':
            return { kind: 'ended', line: CLAIM_SIGNED_OUT };
        case 'sheet-off':
            return { kind: 'ended', line: CLAIM_METHOD_OFF };
        case 'deactivated':
            return { kind: 'ended', line: DEACTIVATED_MESSAGE };
        default:
            return { kind: 'ended', line: CLAIM_DEAD };
    }
}
