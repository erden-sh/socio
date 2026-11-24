import type { AppVariant, DevicePlatform } from '@socio/shared/device-sign-in';

import type { SheetConfig } from '../net/auth-sheet';
import { deviceStartUrl, newSheetSecrets, readSheetCallback, type Sha256Base64 } from '../net/sheet-sign-in';

import type { Keys, RandomBytes } from './keys';

// The sign-in sheet's pending flow: what the app needs to
// redeem the sheet's code, kept in secure storage while the sheet is open, so a callback that
// comes after Android killed the app (it reopens it through the verified App Link, links.ts)
// still signs in. Under Node; src/platform/sheet-sign-in.ts binds it.
//
// - One flow at a time, under `socio.sheet` through `store.keys` (indexed, so a reinstall's
//   cleanup finds it): `{ v, verifier, state, origin, variant, startedAt, name }`. A new flow
//   replaces the last one.
// - It lives SHEET_PENDING_MS (15 minutes: the server's 10-minute request plus its code's 5, then
//   it is abandoned). It is deleted on use (the
//   callback that matches it), on cancel (only the flow that was cancelled: a later one stays),
//   and on expiry (read past its time, and at launch: `sweep`).
// - A callback is taken only when it is this build's (`readSheetCallback`), a flow is pending,
//   and its state and workspace host are the flow's. Anything else does nothing, and the flow
//   stays for the callback that is its own.
// - Reads and changes run one at a time, so the two ways a callback can come (the sheet's answer
//   and the App Link) take it once.
// - The verifier, the state and the code are never logged, thrown or put in a problem.

/** The secure-store name of the pending flow. */
export const SHEET_PENDING_KEY = 'socio.sheet';
/** How long a pending flow lasts: the request's 10 minutes plus the code's 5. */
export const SHEET_PENDING_MS = 15 * 60_000;
const VERSION = 1;

/** What is kept while the sheet is open. */
interface PendingSheet {
    readonly v: number;
    readonly verifier: string;
    readonly state: string;
    /** The workspace's exact origin, where the sheet was started. */
    readonly origin: string;
    readonly variant: AppVariant;
    readonly startedAt: number;
    /** The workspace's name, for the screen that finishes the sign-in. */
    readonly name: string;
}

/** A callback that matched the pending flow: what the redeem needs. The flow is gone by then. */
export interface TakenSheet {
    readonly origin: string;
    readonly name: string;
    readonly code: string;
    readonly verifier: string;
    /** The flow's state, which the platform keeps beside what it holds in memory. */
    readonly state: string;
    readonly variant: AppVariant;
}

/**
 * Why a callback was not taken. Only the kind, never a value: the screen may show it in test builds.
 * - `not-callback`: not this build's `cb` link (another host, path, variant or scheme);
 * - `no-flow`: nothing pending (none started, used, cancelled or swept);
 * - `expired`: the flow was past its 10 minutes, or unreadable (it is deleted);
 * - `state`, `host`, `variant`: the pending flow's differs (it stays).
 */
export type SheetRefusal = 'not-callback' | 'no-flow' | 'expired' | 'state' | 'host' | 'variant';

/** What `take` found: the flow's secrets, or why not. */
export type SheetTake = { readonly taken: TakenSheet } | { readonly refused: SheetRefusal };

export interface SheetFlowDeps {
    readonly keys: Pick<Keys, 'read' | 'write' | 'delete'>;
    readonly randomBytes: RandomBytes;
    readonly sha256: Sha256Base64;
    /** This build's sheet config (src/platform/auth-sheet.ts' SHEET_CONFIG): its variant and link host. */
    readonly config: SheetConfig;
    readonly platform: DevicePlatform;
    readonly now?: () => number;
}

export interface SheetFlow {
    /** Starts a flow for `origin`: keeps it, and resolves the device start page to open and the flow's state. */
    begin(workspace: { readonly origin: string; readonly name: string }): Promise<{ url: string; state: string }>;
    /** The callback in `url`, if it is the pending flow's: the flow is deleted and its secrets handed back. Else why not. */
    take(url: string): Promise<SheetTake>;
    /** Deletes the flow with `state`, if it is the one pending (the person cancelled, or the sheet failed). */
    cancel(state: string): Promise<void>;
    /** Deletes a flow past its time, or one this build can't read. */
    sweep(): Promise<void>;
}

function parsePending(text: string | null): PendingSheet | null | 'unreadable' {
    if (text === null) {
        return null;
    }
    try {
        const value: unknown = JSON.parse(text);
        if (typeof value !== 'object' || value === null) {
            return 'unreadable';
        }
        const row = value as Record<string, unknown>;
        if (
            row.v !== VERSION ||
            typeof row.verifier !== 'string' ||
            typeof row.state !== 'string' ||
            typeof row.origin !== 'string' ||
            typeof row.variant !== 'string' ||
            typeof row.startedAt !== 'number' ||
            typeof row.name !== 'string'
        ) {
            return 'unreadable';
        }
        return row as unknown as PendingSheet;
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

export function createSheetFlow(deps: SheetFlowDeps): SheetFlow {
    const now = deps.now ?? Date.now;
    let queue: Promise<unknown> = Promise.resolve();
    const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
        const next = queue.then(work, work);
        queue = next.catch(() => undefined);
        return next;
    };
    const read = async () => parsePending(await deps.keys.read(SHEET_PENDING_KEY));
    const remove = () => deps.keys.delete([SHEET_PENDING_KEY]);
    const expired = (pending: PendingSheet) => {
        const age = now() - pending.startedAt;
        return age >= SHEET_PENDING_MS || age < -SHEET_PENDING_MS;
    };

    return {
        begin: ({ origin, name }) =>
            inTurn(async () => {
                const secrets = await newSheetSecrets(deps.randomBytes, deps.sha256);
                const pending: PendingSheet = {
                    v: VERSION,
                    verifier: secrets.verifier,
                    state: secrets.state,
                    origin,
                    variant: deps.config.variant,
                    startedAt: now(),
                    name,
                };
                await deps.keys.write(SHEET_PENDING_KEY, JSON.stringify(pending));
                const url = deviceStartUrl(origin, {
                    challenge: secrets.challenge,
                    state: secrets.state,
                    platform: deps.platform,
                    variant: deps.config.variant,
                });
                return { url, state: secrets.state };
            }),
        take: (url) =>
            inTurn(async (): Promise<SheetTake> => {
                const callback = readSheetCallback(url, deps.config);
                if (callback === null) {
                    return { refused: 'not-callback' };
                }
                const pending = await read();
                if (pending === null) {
                    return { refused: 'no-flow' };
                }
                if (pending === 'unreadable' || expired(pending)) {
                    await remove();
                    return { refused: 'expired' };
                }
                if (callback.state !== pending.state) {
                    return { refused: 'state' };
                }
                if (callback.host !== hostOf(pending.origin)) {
                    return { refused: 'host' };
                }
                if (pending.variant !== deps.config.variant) {
                    return { refused: 'variant' };
                }
                await remove();
                return {
                    taken: {
                        origin: pending.origin,
                        name: pending.name,
                        code: callback.code,
                        verifier: pending.verifier,
                        state: pending.state,
                        variant: pending.variant,
                    },
                };
            }),
        cancel: (state) =>
            inTurn(async () => {
                const pending = await read();
                if (pending !== null && pending !== 'unreadable' && pending.state === state) {
                    await remove();
                }
            }),
        sweep: () =>
            inTurn(async () => {
                const pending = await read();
                if (pending === 'unreadable' || (pending !== null && expired(pending))) {
                    await remove();
                }
            }),
    };
}
