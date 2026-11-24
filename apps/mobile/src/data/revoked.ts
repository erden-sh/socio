import { type Store, wipe, type WipeOptions } from './wipe';

// The silent wipe a 401 asks for (by the server's device codes):
// `device_revoked` ("Sign out and erase" on the web) and
// `deactivated` (the account was deactivated) erase the copy with no question
// and nothing sent, since the server has already ended the session. "Sign out
// this device" (`revoked`) answers `session_ended` instead, which only locks
// (Ended) and keeps the copy, unsent work included.
//
// The scope has already stopped its sync and kept `endedAt` (src/sync/scope.ts),
// so the copy is hidden while this runs. Then, as the lease's wipe does: the
// scope is held closed, the copy wiped through `wipe()` (marked first, so a
// kill is finished by the next launch's resumeWipes; push revoked at the relay;
// files, keys and the install id deleted), the images held in memory and the
// WebViews' data cleared, and the most recently used workspace left becomes
// active when this one was.

/** What a wiping 401 means: the reason its wipe is kept under. */
export type RevokedEnd = 'device-revoked' | 'deactivated';

export interface RevokedWipeDeps {
    readonly store: Store;
    /** Stops the workspace's scope and its jar: resolves once nothing of it writes. */
    readonly stopScope: () => Promise<void>;
    /** Drops the images held in memory (expo-image's memory cache). Best effort. */
    readonly clearImageMemory?: () => Promise<unknown>;
    /** Clears the WebViews' data (socio-device's `clearWebViewData`). Best effort. */
    readonly clearWebViewData?: () => Promise<unknown>;
    readonly wipeOptions?: WipeOptions;
}

/**
 * Wipes workspace `id` for a wiping 401, in silence. After the scope stops,
 * the row is read again: only a copy still `ready` and locked (`endedAt`, as
 * the scope kept it) is wiped; one signed in again meanwhile (the commit
 * clears `endedAt`), or already gone, is left (`skipped`). Resolves once the
 * wipe is verified; rejects with the wipe's failure, the row still marked, so
 * the next launch finishes it.
 */
export async function wipeRevoked(deps: RevokedWipeDeps, id: string, end: RevokedEnd): Promise<'wiped' | 'skipped'> {
    const { store } = deps;
    const active = await store.registry.active();
    await deps.stopScope();
    const row = await store.registry.get(id);
    if (row === null || row.state !== 'ready' || row.endedAt === null) {
        return 'skipped';
    }
    await wipe(store, id, end, deps.wipeOptions);
    await deps.clearImageMemory?.().catch(() => undefined);
    await deps.clearWebViewData?.().catch(() => undefined);
    if (active === id) {
        const next = (await store.registry.list())
            .filter((other) => other.state === 'ready')
            .sort((x, y) => y.lastUsed - x.lastUsed)[0];
        await store.registry.setActive(next?.id ?? null);
    }
    return 'wiped';
}

export interface RevokedWipesDeps {
    /** The store launch opened, or null before it has. */
    readonly store: () => Store | null;
    /** The lease pass running, if one is: a wipe waits for it, since it may be wiping the same copy. */
    readonly leasePass: () => Promise<unknown> | null;
    /** Holds `id`'s scope closed (active-scope's `holdScope`), resolving once it has disposed. */
    readonly holdScope: (id: string) => Promise<void>;
    /** Ends that hold (`releaseScope(id)`). */
    readonly releaseScope: (id: string) => Promise<void>;
    /** Reads the root gate again (`rootState.refresh`). */
    readonly refresh: () => Promise<void>;
    readonly clearImageMemory?: () => Promise<unknown>;
    readonly clearWebViewData?: () => Promise<unknown>;
    /** A wipe that failed (left marked for the next launch), or a release or refresh that did. */
    readonly onError?: (error: unknown) => void;
}

/**
 * The app's silent wipes (src/platform/session.ts binds it to `copyRevoked`):
 * one at a time per workspace (a second ask while one runs joins it), each
 * after any lease pass running, its scope held from before the wipe until
 * after, then the gate read again. The returned function never rejects.
 */
export function createRevokedWipes(deps: RevokedWipesDeps): (id: string, end: RevokedEnd) => Promise<void> {
    const running = new Map<string, Promise<void>>();
    const report = (error: unknown) => deps.onError?.(error);
    return (id, end) => {
        const already = running.get(id);
        if (already !== undefined) {
            return already;
        }
        const run = (async () => {
            const store = deps.store();
            if (store === null) {
                return;
            }
            await Promise.resolve(deps.leasePass()).catch(() => undefined);
            let held = false;
            try {
                await wipeRevoked(
                    {
                        store,
                        stopScope: async () => {
                            held = true;
                            await deps.holdScope(id);
                        },
                        clearImageMemory: deps.clearImageMemory,
                        clearWebViewData: deps.clearWebViewData,
                    },
                    id,
                    end,
                );
            } catch (error) {
                report(error);
            } finally {
                running.delete(id);
                await deps.refresh().catch(report);
                if (held) {
                    await deps.releaseScope(id).catch(report);
                }
            }
        })();
        running.set(id, run);
        return run;
    };
}
