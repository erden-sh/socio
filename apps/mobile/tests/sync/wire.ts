import type { FetchRequestInit } from 'expo/fetch';

import { type Store, workspaceKeyName } from '../../src/data';
import { memoryJarStore, openCookieJar } from '../../src/net/cookie-jar';
import type { FetchFunction } from '../../src/net/fetch-function';
import { addWorkspace } from '../helpers/store';
import { httpDate } from '../net/helpers';

import type { FakeWorkspaceServer } from './helpers';

// The phone's network to fake workspace servers, and a workspace signed in to
// one, for the scope's tests (scope.test.ts, active-scope.test.ts).

export interface Wire {
    readonly fetch: FetchFunction;
    readonly calls: { url: string; ifNoneMatch: string | undefined; signal: AbortSignal | undefined }[];
    /** Holds every answer until `release`, or answers at once. */
    hold(on: boolean): void;
    /** Requests held from now on miss their signal's abort, so their answers come whenever released. */
    missAbort(on: boolean): void;
    release(): void;
    readonly held: number;
    /** The answers that reached the phone so far: not those of a request its abort already rejected. */
    readonly answered: number;
}

/**
 * The phone's network to the fake servers, by origin. Like a real fetch, an
 * aborted signal rejects a request, sent or held (unless `missAbort`).
 */
export function wire(servers: ReadonlyMap<string, FakeWorkspaceServer>): Wire {
    const calls: Wire['calls'] = [];
    const held: (() => void)[] = [];
    let holding = false;
    let missing = false;
    let answered = 0;
    const fetch: FetchFunction = (url: string, init: FetchRequestInit) =>
        new Promise<Response>((resolve, reject) => {
            const headers = (init.headers ?? {}) as Record<string, string>;
            const signal = init.signal ?? undefined;
            calls.push({ url, ifNoneMatch: headers['if-none-match'], signal });
            if (signal?.aborted) {
                reject(new Error('fetch failed: aborted'));
                return;
            }
            const server = servers.get(new URL(url).origin);
            if (server === undefined) {
                reject(new Error('fetch failed: no route'));
                return;
            }
            let rejected = false;
            const answer = () => {
                if (!rejected) {
                    answered += 1;
                }
                resolve(server.handle(url, init));
            };
            if (!holding) {
                answer();
                return;
            }
            held.push(answer);
            if (!missing) {
                const abort = () => {
                    rejected = true;
                    reject(new Error('fetch failed: aborted'));
                };
                signal?.addEventListener('abort', abort, { once: true });
            }
        });
    return {
        fetch,
        calls,
        hold(on) {
            holding = on;
        },
        missAbort(on) {
            missing = on;
        },
        release() {
            held.shift()?.();
        },
        get held() {
            return held.length;
        },
        get answered() {
            return answered;
        },
    };
}

/** A ready workspace on the phone for `origin`, signed in to `server`: its jar holds the session. */
export async function signedIn(store: Store, origin: string, server: FakeWorkspaceServer, clock: { server: number }) {
    const added = await addWorkspace(store, origin, 'u-ada');
    // addWorkspace's cache.db holds a stand-in row; the first pull replaces it.
    const staging = await openCookieJar({ origin, store: memoryJarStore() });
    await staging.apply(new URL(`${origin}/api/auth/sign-in/email`), [server.signIn()], httpDate(clock.server));
    await store.keys.write(workspaceKeyName(added.id, 'jar'), staging.serialize());
    return added.id;
}
