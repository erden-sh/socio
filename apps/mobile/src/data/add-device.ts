import type { AppVariant, DevicePlatform, WorkspaceManifest } from '@socio/shared/device-sign-in';

import {
    CLAIM_DEAD,
    CLAIM_MS,
    type ClaimResult,
    claimLine,
    deviceLinkAddress,
    type DeviceLink,
    type PairClaim,
    POLL_MS,
    pollVerdict,
} from '../net/add-device';
import { AbortedError } from '../net/errors';
import type { ProbeResult } from '../net/probe';
import { probeCopy } from '../net/probe-copy';
import { base64url, type Sha256Base64, toBase64url } from '../net/sheet-sign-in';
import type { SignInProblem, SignInResult } from '../net/sign-in';
import { UNFINISHED } from '../net/sign-in-copy';

import type { RandomBytes } from './keys';
import { countUnsentItems, sameEmail, type UnsentCounter } from './person-check';
import type { SignInOutcome, StageSignIn } from './sign-in-flow';
import type { Store } from './wipe';

// Add a device, on the new device, under Node:
// src/platform/add-device.ts binds it, the AddDevice screen draws its view.
//
// 1. A QR link (`readDeviceLink`) names the workspace by host: it is checked as a typed address is
//    (`deviceLinkAddress`, `checkAddress`), then probed (the manifest, then the sign-in view). Nothing
//    is claimed yet: opening a link uses nothing up.
// 2. "Sign in on this device", the workspace's name and host: Continue claims the pairing code with
//    a fresh verifier and its S256 challenge, the device label and the platform (nothing about the
//    person). The claim answers who it would sign in as and the 6 digits.
// 3. When this device holds the workspace for someone else (by email), "This device is signed in to
//    Acme as <email>. Sign in as <other email> instead?" comes first, Cancel the default; going on
//    agrees to remove exactly those copies, so the commit's own another-person question isn't asked
//    again for them (it is for anyone else).
// 4. "Sign in on this device" with who signs in, "On your computer, type this code" over the
//    digits, and the claim's 2-minute countdown, by this device's clock from the claim's answer. The
//    redeem is polled every POLL_MS (2 s, never faster: the server answers `too_many` past one a
//    second) inside `signInAndCommit`'s stage, with the claim's email (the workspace keys'
//    install id for the same person), so the person check, BANNED_USER and the commit are every sign-in's.
// 5. Polling pauses while the app is in the background and goes on when it comes back within the
//    claim; leaving the screen (`leave`: Cancel, Back, unmount) stops it at once, after asking the
//    server to end a claim still live (`pair/cancel`, best effort, never awaited), so the web shows
//    it refused. Never after the claim ended, ran out or was redeemed; a redeem in flight that
//    answers `denied` after it says nothing. The claim ending (signed in, refused, run
//    out, left) takes the digits off the view.
// The digits, the claim id and the verifier live in this closure's memory only: never stored, logged,
// thrown or put in a problem. A kill loses the claim; the person makes a new code on the computer.

/** Whether the app is in the foreground ('inactive' counts, as sync's triggers read it). */
export interface Foreground {
    active(): boolean;
    subscribe(listener: () => void): () => void;
}

/** Someone else's copy of the workspace on this device. */
export interface OtherAccount {
    readonly id: string;
    readonly email: string | null;
}

export interface OtherAccounts {
    readonly previous: readonly OtherAccount[];
    /** Their unsent items together; null when any count failed (never taken as none). */
    readonly unsent: number | null;
}

/**
 * The copies of the workspace at `origin` that belong to someone other than `email`: rows settled
 * on the device (not being added or wiped) whose email differs, or is unknown. Their unsent count
 * as the commit's another-person question counts it.
 */
export async function otherAccounts(
    store: Store,
    origin: string,
    email: string,
    countUnsent: UnsentCounter = countUnsentItems,
): Promise<OtherAccounts> {
    const rows = (await store.registry.byOrigin(origin)).filter(
        (row) => row.origin === origin && row.state !== 'pending' && row.state !== 'wiping',
    );
    const previous: OtherAccount[] = [];
    let unsent: number | null = 0;
    for (const row of rows) {
        if (sameEmail(row.personEmail, email)) {
            continue;
        }
        previous.push({ id: row.id, email: row.personEmail });
        const count = await countUnsent(store, row.id).catch(() => null);
        unsent = unsent === null || count === null ? null : unsent + count;
    }
    return { previous, unsent };
}

export interface ClaimInput {
    readonly origin: string;
    readonly code: string;
    readonly challenge: string;
    readonly label: string;
    readonly platform: DevicePlatform;
    readonly variant: AppVariant;
}

export interface PairRedeemJob {
    readonly origin: string;
    readonly claimId: string;
    readonly verifier: string;
    readonly installId: string;
    readonly email: string;
}

export interface AddDeviceDeps {
    readonly variant: AppVariant;
    readonly platform: DevicePlatform;
    /** What the person's device list calls this device (`deviceLabel`). */
    readonly label: string;
    /** `probeWorkspace` with this build's rules, never answering `known`: the workspace is asked every time. */
    readonly probe: (text: string, signal: AbortSignal) => Promise<ProbeResult>;
    readonly claim: (input: ClaimInput, signal: AbortSignal) => Promise<ClaimResult>;
    /** One poll of the redeem (`redeemPairing`). */
    readonly redeem: (job: PairRedeemJob, signal: AbortSignal) => Promise<SignInResult>;
    /** `signInAndCommit` with the claim's email and `stage`, then the logo and the gate. */
    readonly signIn: (input: {
        readonly origin: string;
        readonly email: string;
        readonly manifest: WorkspaceManifest | null;
        readonly signal: AbortSignal;
        readonly stage: StageSignIn;
    }) => Promise<SignInOutcome>;
    readonly others: (origin: string, email: string) => Promise<OtherAccounts>;
    /**
     * Ends a live claim on the server (`cancelPairing`): best effort, never rejecting, never awaited
     * by the screen.
     */
    readonly cancel: (origin: string, claimId: string) => Promise<void>;
    readonly randomBytes: RandomBytes;
    readonly sha256: Sha256Base64;
    readonly foreground: Foreground;
    readonly now?: () => number;
    /** Waits `ms`; rejects with AbortedError once `signal` aborts. Timers by default. */
    readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** What the AddDevice screen shows. Only `digits` holds the digits. */
export type AddDeviceView =
    | { readonly step: 'idle' }
    | { readonly step: 'checking'; readonly host: string }
    /** The link can't be used: its host, the workspace, or the claim refused. The line says what to do. */
    | { readonly step: 'refused'; readonly host: string; readonly line: string; readonly detail: string | null }
    | { readonly step: 'confirm'; readonly host: string; readonly name: string }
    | { readonly step: 'claiming'; readonly host: string; readonly name: string }
    | {
          readonly step: 'other-account';
          readonly host: string;
          readonly name: string;
          /** The first other person's email, null when the device doesn't know it. */
          readonly current: string | null;
          readonly next: string;
          readonly unsent: number | null;
      }
    | {
          readonly step: 'digits';
          readonly host: string;
          readonly name: string;
          readonly account: { readonly name: string; readonly email: string };
          readonly digits: string;
          /** When the claim ends, by this device's clock. */
          readonly deadline: number;
          /** False while polls get no answer (it keeps trying). */
          readonly reaching: boolean;
      }
    | { readonly step: 'signing-in'; readonly host: string; readonly name: string }
    /** The commit found another person's copy the person wasn't asked about: the another-person question. */
    | { readonly step: 'commit-question'; readonly host: string; readonly name: string; readonly unsent: number | null }
    | { readonly step: 'signed-in' }
    /** The claim is over without signing in. */
    | { readonly step: 'ended'; readonly host: string; readonly name: string; readonly line: string };

export interface AddDevice {
    view(): AddDeviceView;
    subscribe(listener: () => void): () => void;
    /** A QR link (a new one replaces what shows, unless a sign-in is committing). */
    start(link: DeviceLink): void;
    /** Continue: claims, then the other-account question or the digits. */
    continue(): void;
    /** "Sign in as <other> instead": shows the digits. */
    switchAccount(): void;
    /** The commit's another-person question answered. */
    answerCommit(confirm: boolean): void;
    /** The screen goes (Cancel, Back, unmount): polling stops, the claim and digits are dropped. */
    leave(): void;
}

const PKCE_BYTES = 32;

const defaultSleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
            reject(new AbortedError(''));
            return;
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', stop);
            resolve();
        }, ms);
        const stop = () => {
            clearTimeout(timer);
            reject(new AbortedError(''));
        };
        signal.addEventListener('abort', stop, { once: true });
    });

/** What the commit's another-person outcome waits on, while the screen asks. */
type CommitAnswer = (confirm: boolean) => void;

export function createAddDevice(deps: AddDeviceDeps): AddDevice {
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? defaultSleep;
    const listeners = new Set<() => void>();
    let shown: AddDeviceView = { step: 'idle' };
    /** Everything of the link in hand; replaced whole by each `start`, dropped by `leave`. */
    let run: {
        readonly scope: AbortController;
        readonly host: string;
        origin: string | null;
        name: string;
        manifest: WorkspaceManifest | null;
        code: string;
        claim: (PairClaim & { readonly verifier: string; readonly deadline: number }) | null;
        agreed: ReadonlySet<string>;
        commitAnswer: CommitAnswer | null;
    } | null = null;

    const set = (view: AddDeviceView) => {
        shown = view;
        for (const listener of listeners) {
            listener();
        }
    };
    const current = (scope: AbortController) => run !== null && run.scope === scope && !scope.signal.aborted;
    const report = (where: string, error: unknown) => {
        if (!(error instanceof AbortedError)) {
            console.warn(`[add-device] ${where}`, error instanceof Error ? error.name : 'unknown');
        }
    };
    /** The claim ends: its secrets go, and the line shows. */
    const end = (line: string) => {
        if (run === null) {
            return;
        }
        run.claim = null;
        set({ step: 'ended', host: run.host, name: run.name, line });
    };

    async function check(scope: AbortController, link: DeviceLink) {
        const address = deviceLinkAddress(link.host, deps.variant);
        if (!address.ok) {
            set({ step: 'refused', host: link.host, line: probeCopy(address.problem), detail: address.problem });
            return;
        }
        const result = await deps.probe(address.address.origin, scope.signal);
        if (!current(scope) || run === null) {
            return;
        }
        if (result.kind !== 'found') {
            const problem = result.kind === 'failed' ? result.problem : 'not-socio';
            set({ step: 'refused', host: link.host, line: probeCopy(problem), detail: problem });
            return;
        }
        const manifest = result.workspace.manifest;
        if (manifest !== null && !manifest.methods.addDevice) {
            set({ step: 'refused', host: link.host, line: ADD_DEVICE_OFF, detail: null });
            return;
        }
        run.origin = result.address.origin;
        run.name = result.workspace.name;
        run.manifest = manifest;
        set({ step: 'confirm', host: link.host, name: result.workspace.name });
    }

    async function claim(scope: AbortController) {
        if (run === null || run.origin === null) {
            return;
        }
        const { host, name, origin } = run;
        set({ step: 'claiming', host, name });
        const bytes = deps.randomBytes(PKCE_BYTES);
        if (bytes.length !== PKCE_BYTES) {
            throw new Error(`The random source gave ${bytes.length} bytes, not ${PKCE_BYTES}.`);
        }
        const verifier = base64url(bytes);
        const challenge = toBase64url(await deps.sha256(verifier));
        const answer = await deps.claim(
            { origin, code: run.code, challenge, label: deps.label, platform: deps.platform, variant: deps.variant },
            scope.signal,
        );
        if (!current(scope) || run === null) {
            return;
        }
        if (!answer.ok) {
            set({ step: 'refused', host, line: claimLine(answer.problem), detail: answer.problem.kind });
            return;
        }
        run.claim = { ...answer.claim, verifier, deadline: now() + CLAIM_MS };
        const others = await deps.others(origin, answer.claim.account.email);
        if (!current(scope) || run === null || run.claim === null) {
            return;
        }
        if (others.previous.length > 0) {
            run.agreed = new Set(others.previous.map((person) => person.id));
            set({
                step: 'other-account',
                host,
                name,
                current: others.previous.find((person) => person.email !== null)?.email ?? null,
                next: answer.claim.account.email,
                unsent: others.unsent,
            });
            return;
        }
        await poll(scope);
    }

    /** Resolves once the app is in the foreground, or the claim's time is up. */
    function inForeground(scope: AbortController, deadline: number): Promise<void> {
        if (deps.foreground.active()) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const done = () => {
                stop();
                timer.abort();
                scope.signal.removeEventListener('abort', aborted);
                resolve();
            };
            const stop = deps.foreground.subscribe(() => {
                if (deps.foreground.active()) {
                    done();
                }
            });
            const timer = new AbortController();
            const aborted = () => {
                stop();
                timer.abort();
                reject(new AbortedError(''));
            };
            scope.signal.addEventListener('abort', aborted, { once: true });
            sleep(Math.max(0, deadline - now()), timer.signal).then(done, () => undefined);
        });
    }

    async function poll(scope: AbortController) {
        if (run === null || run.claim === null || run.origin === null) {
            return;
        }
        const { host, name, origin, manifest } = run;
        const claimed = run.claim;
        const showDigits = (reaching: boolean) => {
            if (current(scope) && run?.claim === claimed) {
                set({
                    step: 'digits',
                    host,
                    name,
                    account: claimed.account,
                    digits: claimed.digits,
                    deadline: claimed.deadline,
                    reaching,
                });
            }
        };
        showDigits(true);
        const expired = () => now() >= claimed.deadline;
        const expiredProblem: SignInProblem = { kind: 'code-expired', status: null, code: null };
        const stage: StageSignIn = async (installId) => {
            let last = now();
            for (;;) {
                // Never sooner than POLL_MS after the last poll, a return from the background included.
                await sleep(Math.max(0, POLL_MS - (now() - last)), scope.signal);
                await inForeground(scope, claimed.deadline);
                if (expired()) {
                    return { ok: false, problem: expiredProblem };
                }
                last = now();
                const result = await deps.redeem(
                    {
                        origin,
                        claimId: claimed.claimId,
                        verifier: claimed.verifier,
                        installId,
                        email: claimed.account.email,
                    },
                    scope.signal,
                );
                if (result.ok) {
                    if (current(scope) && run !== null) {
                        run.claim = null;
                        set({ step: 'signing-in', host, name });
                    }
                    return result;
                }
                const verdict = pollVerdict(result.problem, expired());
                if (verdict.kind === 'ended') {
                    return result;
                }
                if (expired()) {
                    return { ok: false, problem: expiredProblem };
                }
                showDigits(verdict.reaching);
            }
        };
        const outcome = await deps.signIn({
            origin,
            email: claimed.account.email,
            manifest,
            signal: scope.signal,
            stage,
        });
        await settle(scope, outcome);
    }

    async function settle(scope: AbortController, outcome: SignInOutcome): Promise<void> {
        if (run === null || run.scope !== scope) {
            // Left while committing: a committed sign-in stays (the gate shows it); a question is cancelled.
            if (outcome.kind === 'other-person') {
                await outcome.cancel();
            }
            return;
        }
        const { host, name } = run;
        switch (outcome.kind) {
            case 'committed':
                run.claim = null;
                set({ step: 'signed-in' });
                return;
            case 'problem':
                end(endLine(outcome.problem));
                return;
            case 'unfinished':
                end(UNFINISHED);
                return;
            case 'commit-failed':
                end(COMMIT_FAILED);
                return;
            case 'other-person': {
                const agreed = run.agreed;
                if (outcome.previous.every((person) => agreed.has(person.id))) {
                    await settle(scope, await outcome.confirm());
                    return;
                }
                const answer = await new Promise<boolean>((resolve) => {
                    if (run !== null) {
                        run.commitAnswer = resolve;
                    }
                    set({ step: 'commit-question', host, name, unsent: outcome.unsent });
                });
                if (answer && current(scope)) {
                    set({ step: 'signing-in', host, name });
                    await settle(scope, await outcome.confirm());
                } else {
                    await outcome.cancel();
                    if (current(scope)) {
                        end(SWITCH_CANCELLED);
                    }
                }
            }
        }
    }

    const go = (scope: AbortController, work: () => Promise<void>, where: string) => {
        work().catch((error: unknown) => {
            report(where, error);
            if (current(scope) && !(error instanceof AbortedError)) {
                end(COMMIT_FAILED);
            }
        });
    };

    return {
        view: () => shown,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        start(link) {
            if (shown.step === 'signing-in') {
                return;
            }
            run?.scope.abort();
            const scope = new AbortController();
            run = {
                scope,
                host: link.host,
                origin: null,
                name: '',
                manifest: null,
                code: link.code,
                claim: null,
                agreed: new Set(),
                commitAnswer: null,
            };
            set({ step: 'checking', host: link.host });
            check(scope, link).catch((error: unknown) => {
                report('the workspace was not checked', error);
                if (current(scope)) {
                    set({ step: 'refused', host: link.host, line: CANT_CHECK_LINK, detail: null });
                }
            });
        },
        continue() {
            if (run === null || shown.step !== 'confirm') {
                return;
            }
            const { scope } = run;
            go(scope, () => claim(scope), 'the claim failed');
        },
        switchAccount() {
            if (run === null || shown.step !== 'other-account') {
                return;
            }
            const { scope } = run;
            go(scope, () => poll(scope), 'the sign-in failed');
        },
        answerCommit(confirm) {
            const answer = run?.commitAnswer;
            if (run === null || answer == null) {
                return;
            }
            run.commitAnswer = null;
            answer(confirm);
        },
        leave() {
            const left = run;
            run = null;
            if (left !== null) {
                // A claim still live (the question or the digits; not ended, not redeemed, not past its
                // time) is ended on the server first, so the web shows it refused at once.
                const live = left.claim;
                if (live !== null && left.origin !== null && now() < live.deadline) {
                    deps.cancel(left.origin, live.claimId).catch(() => undefined);
                }
                left.claim = null;
                left.scope.abort();
                left.commitAnswer?.(false);
            }
            set({ step: 'idle' });
        },
    };
}

/** A sign-in that ended on a problem: its pair words, or (one only polling rides out) the claim being dead. */
function endLine(problem: SignInProblem): string {
    const verdict = pollVerdict(problem, problem.kind === 'code-expired');
    return verdict.kind === 'ended' ? verdict.line : CLAIM_DEAD;
}

/** The manifest says this workspace doesn't offer Add a device. */
export const ADD_DEVICE_OFF =
    "This workspace doesn't let you add a device this way. Sign in with its address instead, or ask your admin.";
/** The link's workspace couldn't be checked (an error of this device's, not the server's answer). */
export const CANT_CHECK_LINK = "Couldn't check this workspace. Scan the code again.";
export const COMMIT_FAILED = "Couldn't finish signing in on this device. Make a new code on your computer.";
/** The commit's another-person question was cancelled: the new session was signed out. */
export const SWITCH_CANCELLED = 'Nothing changed on this device. The other account is still signed in.';
