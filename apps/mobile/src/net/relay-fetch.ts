import { AbortedError, NetworkError, OutsideOriginError, RedirectRefusedError } from './errors';
import { type FetchFunction, isRedirectFailure } from './fetch-function';

// relayFetch: the app's requests to the push relay (apps/push-relay), and
// nothing else may send there. Only the one relay origin it is made for
// (relay-origin.ts, a build constant: the build's own, or one an earlier build
// registered with), any other URL refused before
// sending; no cookies (`credentials: 'omit'`) and no Origin, since the relay
// knows nobody: a registration's secret is the only credential, in the body;
// `redirect: 'error'`, so a body holding the secret never follows a redirect
// anywhere; no-store; JSON bodies; the app's User-Agent, which says nothing
// about the person or the phone (user-agent.ts). Kept out of src/sync
// (tests/dependency-graph.test.ts): a workspace's requests never come here.
//
// Every exchange, the answer's body included, has a time limit
// (`RELAY_TIMEOUT_MS`): on Android expo/fetch's OkHttp client has none, so one
// stalled connection (a captive portal, a half-open socket after a network
// switch) would hold the push manager's queue, and a wipe behind it, forever.
// Past the limit it is a NetworkError, as no answer is.

/** The longest one exchange with the relay may take, the body read included. */
export const RELAY_TIMEOUT_MS = 15_000;

/** HTTP statuses whose answer has no body (fetch's null body statuses). */
const NO_BODY = new Set([101, 103, 204, 205, 304]);

export interface RelayFetchOptions {
    /** The app's one fetch (src/platform/fetch.ts). */
    fetch: FetchFunction;
    /** The app's User-Agent. */
    userAgent: string;
    /** The relay's origin, the build's (`extra.relayOrigin`). */
    origin: string;
    /** The time limit of one exchange; `RELAY_TIMEOUT_MS` unless a test sets it. */
    timeoutMs?: number;
}

export interface RelayRequestInit {
    method: 'POST' | 'PUT' | 'DELETE';
    /** Sent as JSON. */
    json: unknown;
    signal?: AbortSignal;
}

/**
 * A request to `path` on the relay. Resolves with the answer, whatever its
 * status, its body already read; rejects with NetworkError (no answer within
 * the time limit too), AbortedError or RedirectRefusedError, or
 * OutsideOriginError for a path that leaves the relay (nothing sent).
 */
export type RelayFetch = (path: string, init: RelayRequestInit) => Promise<Response>;

export function createRelayFetch({
    fetch,
    userAgent,
    origin,
    timeoutMs = RELAY_TIMEOUT_MS,
}: RelayFetchOptions): RelayFetch {
    if (new URL(origin).origin !== origin) {
        throw new TypeError(`relayFetch takes an origin alone, not "${origin}".`);
    }
    return async (path, { method, json, signal }) => {
        const url = new URL(path, origin);
        if (!path.startsWith('/') || path.startsWith('//') || url.origin !== origin) {
            throw new OutsideOriginError(url.href, origin);
        }
        if (signal?.aborted) {
            throw new AbortedError(url.href, signal.reason);
        }
        // The caller's signal or the time limit, whichever comes first (Hermes has no AbortSignal.any).
        const stop = new AbortController();
        const fromCaller = () => stop.abort(signal?.reason);
        signal?.addEventListener('abort', fromCaller, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            stop.abort(new Error(`No answer from the relay within ${timeoutMs} ms.`));
        }, timeoutMs);
        // Settles on abort even when the fetch underneath doesn't heed its signal.
        const stopped = new Promise<never>((_, reject) => {
            stop.signal.addEventListener('abort', () => reject(stop.signal.reason), { once: true });
        });
        const exchange = (async () => {
            const answer = await fetch(url.href, {
                method,
                headers: {
                    'content-type': 'application/json',
                    'user-agent': userAgent,
                    'cache-control': 'no-store',
                },
                // oxlint-disable-next-line unicorn/no-invalid-fetch-options -- the method is POST, PUT or DELETE, never GET
                body: JSON.stringify(json),
                credentials: 'omit',
                redirect: 'error',
                signal: stop.signal,
            });
            // Read within the limit too: a stalled body would hold the caller as long as no answer.
            const text = await answer.text();
            return new Response(NO_BODY.has(answer.status) ? null : text, {
                status: answer.status,
                statusText: answer.statusText,
                headers: answer.headers,
            });
        })();
        exchange.catch(() => {});
        stopped.catch(() => {});
        try {
            return await Promise.race([exchange, stopped]);
        } catch (error) {
            if (signal?.aborted) {
                throw new AbortedError(url.href, signal.reason);
            }
            if (!timedOut && isRedirectFailure(error)) {
                throw new RedirectRefusedError(url.href, error);
            }
            throw new NetworkError(url.href, error);
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', fromCaller);
        }
    };
}
