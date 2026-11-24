import { AbortedError, NetworkError } from './errors';
import { type FetchFunction, mergeHeaders, type RequestHeaders } from './fetch-function';

// publicFetch: requests that carry no credentials, for an address before it is
// a workspace: the address probe's
// `GET /api/auth/session` and the workspace's logo. No cookies, and no Origin
// (the edge refuses any Origin that isn't the server's own, GETs included).
// `redirect: 'manual'` hands back a 3xx with its Location, so the probe decides
// whether to follow it, once. It never touches a jar: a Set-Cookie in its
// answer goes nowhere.

export interface PublicFetchOptions {
    /** The app's one fetch (src/platform/fetch.ts). */
    fetch: FetchFunction;
    /** The app's User-Agent (`userAgent`). */
    userAgent: string;
}

export interface PublicRequestInit {
    /** More headers (Accept, ...). Cookie, Origin and User-Agent are publicFetch's own: it sends no Cookie or Origin. */
    headers?: RequestHeaders;
    /** Stops the request (the add-workspace screen closing). */
    signal?: AbortSignal;
}

/**
 * A GET with no credentials to an absolute http or https URL. Resolves with the
 * answer, whatever its status, a 3xx included; rejects with NetworkError or
 * AbortedError, or with a TypeError for a URL it won't send to.
 */
export type PublicFetch = (url: string, init?: PublicRequestInit) => Promise<Response>;

const RESERVED = ['cookie', 'origin', 'user-agent'];

export function createPublicFetch({ fetch, userAgent }: PublicFetchOptions): PublicFetch {
    return async (input, init = {}) => {
        const url = new URL(input);
        if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') {
            throw new TypeError(
                `publicFetch takes an http or https URL with no user name or password, not "${input}".`,
            );
        }
        const headers = mergeHeaders(init.headers, { 'user-agent': userAgent }, RESERVED);
        const { signal } = init;
        if (signal?.aborted) {
            throw new AbortedError(url.href, signal.reason);
        }
        try {
            return await fetch(url.href, {
                method: 'GET',
                headers,
                credentials: 'omit',
                redirect: 'manual',
                signal,
            });
        } catch (error) {
            if (signal?.aborted) {
                throw new AbortedError(url.href, signal.reason);
            }
            throw new NetworkError(url.href, error);
        }
    };
}
