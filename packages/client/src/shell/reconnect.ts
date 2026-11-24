import {
    reconnectDelay,
    recoverTurn as recoverTurnWith,
    refusedForUpdate,
    serverAway as awayFrom,
    sleep,
    type Failure,
} from '@socio/shared/reconnect';

import { ApiError, UNREADABLE_RESPONSE } from '../lib/api';

/**
 * Riding out a restart (CB-108): the browser's side of
 * `@socio/shared/reconnect`, which the native app shares. Here, how the
 * browser's errors read (`failureOf`), how it waits for the server
 * (`waitForServer`, `pause`), and `recoverTurn` wired to both.
 */

/** Liveness (index.ts): `ok`, and `draining` while the old server drains. */
export const HEALTH_PATH = '/healthz';

// What browsers (and Node) say when a request or its stream breaks off.
const NETWORK = /fetch|network|load failed|input stream|terminated/i;

/**
 * What a failed request says, for shared's `serverAway`: the API's errors
 * (ApiError), the runtime client's (`status` and the body it read, as
 * `payload`), a stop (`AbortError`), and the browser's TypeError when no
 * answer came.
 */
export function failureOf(error: unknown): Failure {
    if (!error || typeof error !== 'object') {
        return {};
    }
    if ((error as { name?: unknown }).name === 'AbortError') {
        return { aborted: true };
    }
    const { status, payload, message } = error as {
        status?: unknown;
        payload?: unknown;
        message?: unknown;
    };
    const code = refusedForUpdate(error) ? 'draining' : undefined;
    if (typeof status === 'number') {
        // The API answers in JSON; a proxy's error page doesn't.
        const unreadable = error instanceof ApiError ? message === UNREADABLE_RESPONSE : typeof payload === 'string';
        return { status, code, unreadable };
    }
    return {
        code,
        network: error instanceof TypeError && typeof message === 'string' && NETWORK.test(message),
    };
}

/**
 * Whether a failed request means the server is away or restarting, so
 * waiting and trying again will do (shared's `serverAway`).
 */
export function serverAway(error: unknown): boolean {
    return awayFrom(failureOf(error));
}

/**
 * Waits `ms` between attempts, as `sleep`, but no longer once the browser
 * says it is back online: the next attempt goes at once.
 */
export async function pause(ms: number, signal?: AbortSignal) {
    if (typeof window === 'undefined') {
        return sleep(ms, signal);
    }
    const online = new AbortController();
    const wake = () => online.abort();
    window.addEventListener('online', wake, { once: true });
    try {
        await sleep(ms, signal ? AbortSignal.any([signal, online.signal]) : online.signal);
    } catch (error) {
        if (signal?.aborted || !online.signal.aborted) {
            throw error;
        }
    } finally {
        window.removeEventListener('online', wake);
    }
}

/**
 * Whether a server is up and taking new turns: `/healthz` answers `ok`,
 * not `draining`. Never from a cache.
 */
export async function serverReady(request: typeof fetch = fetch, signal?: AbortSignal) {
    try {
        const response = await request(HEALTH_PATH, { cache: 'no-store', signal });
        if (!response.ok) {
            return false;
        }
        const health = (await response.json()) as {
            ok?: unknown;
            draining?: unknown;
        };
        return health.ok === true && !health.draining;
    } catch {
        if (signal?.aborted) {
            throw signal.reason;
        }
        return false;
    }
}

/** Asks `serverReady` with backoff until it says yes, or `signal` aborts. */
export async function waitForServer({
    signal,
    request,
    random,
}: {
    signal?: AbortSignal;
    request?: typeof fetch;
    random?: () => number;
} = {}) {
    for (let attempt = 0; ; attempt++) {
        if (await serverReady(request, signal)) {
            return;
        }
        await pause(reconnectDelay(attempt, random), signal);
    }
}

/**
 * Shared's `recoverTurn`, waiting with `waitForServer` and `pause` and
 * reading errors with `serverAway`.
 */
export function recoverTurn<M extends { id: string }, T>(
    options: Omit<Parameters<typeof recoverTurnWith<M, T>>[0], 'ready' | 'away'> & {
        ready?: (options: { signal: AbortSignal }) => Promise<void>;
    },
) {
    return recoverTurnWith<M, T>({ ready: waitForServer, pause, away: serverAway, ...options });
}
