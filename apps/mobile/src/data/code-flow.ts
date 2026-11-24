import { type AppVariant, type DevicePlatform, normalizeCode, SIGN_IN_CODE_LENGTH } from '@socio/shared/device-sign-in';

import { base64url, type Sha256Base64, toBase64url } from '../net/sheet-sign-in';
import type { SignInResult } from '../net/sign-in';
import {
    type CodeChannel,
    type CodeLinkConfig,
    type CodeRequestProblem,
    type CodeRequestResult,
    codeRefusal,
    readCodeLink,
    SIGN_IN_CODE_MS,
} from '../net/sign-in-codes';

import type { Keys, RandomBytes } from './keys';
import type { StagedLogo } from './logo';
import type { SignInOutcome } from './sign-in-flow';

// A sign-in code's pending request, under Node; src/platform/code-sign-in.ts binds it.
//
// - One request at a time, under `socio.code` through `store.keys` (indexed, so a reinstall's
//   cleanup finds it): `{ v, requestId, verifier, origin, name, email, channel, variant, sentAt }`.
//   It is the only place the request id and the verifier are kept, and they leave it only for the
//   redeem's body. Kept in secure storage because the person leaves the app to read the code, and
//   Android may kill it meanwhile: the code's link still fills it in, and the screen comes back.
// - Each send has a fresh verifier and challenge (the server uses each challenge once), and
//   replaces the entry only once the server answered with a request id: a Send again that is
//   refused keeps the code already sent.
// - It lives SIGN_IN_CODE_MS (15 minutes) from its send. It is deleted once the code is used (any
//   answer that took it: signed in, or refused for good), when the person starts over, and on
//   expiry (read past its time, and at launch: `sweep`).
// - A code link (`readCodeLink`) fills the code in only when the entry is live and the link's
//   workspace host is the entry's; otherwise it only shows the code, and nothing is redeemed.
// - Reads and changes run one at a time.
// - The code, the verifier and the request id are never logged, thrown or put in a problem.

/** The secure-store name of the pending request. */
export const CODE_PENDING_KEY = 'socio.code';
const VERSION = 1;
const PKCE_BYTES = 32;

interface PendingCode {
    readonly v: number;
    readonly requestId: string;
    readonly verifier: string;
    readonly origin: string;
    readonly name: string;
    readonly email: string;
    readonly channel: CodeChannel;
    readonly variant: AppVariant;
    readonly sentAt: number;
}

/** What the screen may know of the pending request: never its id or verifier. */
export interface PendingCodeView {
    readonly origin: string;
    readonly name: string;
    readonly email: string;
    readonly channel: CodeChannel;
    readonly sentAt: number;
}

/** What a send asks the server (net's `requestSignInCode` without the fetch). */
export interface CodeRequestInput {
    readonly origin: string;
    readonly email: string;
    readonly challenge: string;
    readonly platform: DevicePlatform;
    readonly variant: AppVariant;
}

/** What a redeem sends (net's `redeemSignInCode` without the staging options). */
export interface CodeRedeemJob {
    readonly origin: string;
    readonly email: string;
    readonly requestId: string;
    readonly code: string;
    readonly verifier: string;
    readonly variant: AppVariant;
}

export interface CodeFlowDeps {
    readonly keys: Pick<Keys, 'read' | 'write' | 'delete'>;
    readonly randomBytes: RandomBytes;
    readonly sha256: Sha256Base64;
    readonly platform: DevicePlatform;
    readonly variant: AppVariant;
    /** This build's code links, or null when it has no link host. */
    readonly links: CodeLinkConfig | null;
    readonly request: (input: CodeRequestInput) => Promise<CodeRequestResult>;
    /**
     * Redeems and commits (`signInAndCommit` with the email and `redeemSignInCode` as its stage).
     * `stage` is handed the install id the commit chose.
     */
    readonly signIn: (input: {
        readonly origin: string;
        readonly email: string;
        readonly logo: StagedLogo;
        readonly stage: (installId: string) => Promise<SignInResult>;
    }) => Promise<SignInOutcome>;
    /** The staged redeem, with the install id. */
    readonly redeem: (job: CodeRedeemJob, installId: string) => Promise<SignInResult>;
    readonly now?: () => number;
}

export type CodeSend =
    | { readonly kind: 'sent'; readonly pending: PendingCodeView }
    | { readonly kind: 'problem'; readonly problem: CodeRequestProblem };

export type CodeRedeem =
    /** No live request for this workspace: the screen starts over. */
    | { readonly kind: 'no-request' }
    /** What's typed isn't a code (the button is off then, so only a race gets here). */
    | { readonly kind: 'not-a-code' }
    /** The sign-in's outcome; `startOver` when a refusal left the request dead (it is deleted). */
    | { readonly kind: 'outcome'; readonly outcome: SignInOutcome; readonly startOver: boolean };

/** What a link did: filled the pending request's code in, only showed it, or wasn't a code link. */
export type CodeLinkResult =
    | { readonly kind: 'fill'; readonly code: string }
    | { readonly kind: 'show'; readonly code: string }
    | { readonly kind: 'not-code-link' };

export interface CodeFlow {
    /** The live pending request, or null (one past its time is deleted). */
    pending(): Promise<PendingCodeView | null>;
    /** Asks for a code with a fresh challenge; a request id replaces the pending request. */
    send(input: {
        readonly origin: string;
        readonly name: string;
        readonly email: string;
        readonly channel: CodeChannel;
    }): Promise<CodeSend>;
    /** Redeems `typed` for the pending request on `origin`, then commits. */
    redeem(input: { readonly origin: string; readonly typed: string; readonly logo: StagedLogo }): Promise<CodeRedeem>;
    /** Reads a link: the code, and whether it is the pending request's. Changes nothing. */
    readLink(url: string): Promise<CodeLinkResult>;
    /** Deletes the pending request (the person starts over). */
    clear(): Promise<void>;
    /** Deletes a request past its time, or one this build can't read. */
    sweep(): Promise<void>;
}

function parsePending(text: string | null): PendingCode | null | 'unreadable' {
    if (text === null) {
        return null;
    }
    try {
        const row = JSON.parse(text) as Record<string, unknown> | null;
        if (
            typeof row !== 'object' ||
            row === null ||
            row.v !== VERSION ||
            typeof row.requestId !== 'string' ||
            typeof row.verifier !== 'string' ||
            typeof row.origin !== 'string' ||
            typeof row.name !== 'string' ||
            typeof row.email !== 'string' ||
            (row.channel !== 'email' && row.channel !== 'telegram') ||
            typeof row.variant !== 'string' ||
            typeof row.sentAt !== 'number'
        ) {
            return 'unreadable';
        }
        return row as unknown as PendingCode;
    } catch {
        return 'unreadable';
    }
}

const hostOf = (origin: string) => {
    try {
        return new URL(origin).host;
    } catch {
        return null;
    }
};

const view = ({ origin, name, email, channel, sentAt }: PendingCode): PendingCodeView => ({
    origin,
    name,
    email,
    channel,
    sentAt,
});

export function createCodeFlow(deps: CodeFlowDeps): CodeFlow {
    const now = deps.now ?? Date.now;
    let queue: Promise<unknown> = Promise.resolve();
    const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
        const next = queue.then(work, work);
        queue = next.catch(() => undefined);
        return next;
    };
    const remove = () => deps.keys.delete([CODE_PENDING_KEY]);
    const expired = (pending: PendingCode) => {
        const age = now() - pending.sentAt;
        return age >= SIGN_IN_CODE_MS || age < -SIGN_IN_CODE_MS;
    };
    /** The live entry, deleting one past its time or unreadable. */
    const live = async (): Promise<PendingCode | null> => {
        const pending = parsePending(await deps.keys.read(CODE_PENDING_KEY));
        if (pending === null) {
            return null;
        }
        if (pending === 'unreadable' || expired(pending) || pending.variant !== deps.variant) {
            await remove();
            return null;
        }
        return pending;
    };

    return {
        pending: () =>
            inTurn(async () => {
                const pending = await live();
                return pending === null ? null : view(pending);
            }),
        send: (input) =>
            inTurn(async (): Promise<CodeSend> => {
                const bytes = deps.randomBytes(PKCE_BYTES);
                if (bytes.length !== PKCE_BYTES) {
                    throw new Error(`The random source gave ${bytes.length} bytes, not ${PKCE_BYTES}.`);
                }
                const verifier = base64url(bytes);
                const challenge = toBase64url(await deps.sha256(verifier));
                const email = input.email.trim();
                const answer = await deps.request({
                    origin: input.origin,
                    email,
                    challenge,
                    platform: deps.platform,
                    variant: deps.variant,
                });
                if (!answer.ok) {
                    return { kind: 'problem', problem: answer.problem };
                }
                const pending: PendingCode = {
                    v: VERSION,
                    requestId: answer.requestId,
                    verifier,
                    origin: input.origin,
                    name: input.name,
                    email,
                    channel: input.channel,
                    variant: deps.variant,
                    sentAt: now(),
                };
                await deps.keys.write(CODE_PENDING_KEY, JSON.stringify(pending));
                return { kind: 'sent', pending: view(pending) };
            }),
        redeem: (input) =>
            inTurn(async (): Promise<CodeRedeem> => {
                const pending = await live();
                if (pending === null || pending.origin !== input.origin) {
                    return { kind: 'no-request' };
                }
                const code = normalizeCode(input.typed, SIGN_IN_CODE_LENGTH);
                if (code === null) {
                    return { kind: 'not-a-code' };
                }
                const job: CodeRedeemJob = {
                    origin: pending.origin,
                    email: pending.email,
                    requestId: pending.requestId,
                    code,
                    verifier: pending.verifier,
                    variant: pending.variant,
                };
                let used = false;
                const outcome = await deps.signIn({
                    origin: pending.origin,
                    email: pending.email,
                    logo: input.logo,
                    stage: async (installId) => {
                        const result = await deps.redeem(job, installId);
                        // A staged session means the server used the code up.
                        used = result.ok;
                        return result;
                    },
                });
                const startOver = outcome.kind === 'problem' && codeRefusal(outcome.problem).startOver;
                if (used || startOver) {
                    await remove();
                }
                return { kind: 'outcome', outcome, startOver };
            }),
        readLink: (url) =>
            inTurn(async (): Promise<CodeLinkResult> => {
                const link = deps.links === null ? null : readCodeLink(url, deps.links);
                if (link === null) {
                    return { kind: 'not-code-link' };
                }
                const pending = await live();
                return pending !== null && hostOf(pending.origin) === link.host
                    ? { kind: 'fill', code: link.code }
                    : { kind: 'show', code: link.code };
            }),
        clear: () => inTurn(remove),
        sweep: () =>
            inTurn(async () => {
                await live();
            }),
    };
}
