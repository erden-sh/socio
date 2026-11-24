import type { FetchRequestInit } from 'expo/fetch';

import { splitSetCookie } from './set-cookie';

/**
 * The app's one fetch, which src/platform/fetch.ts binds to expo/fetch: its
 * signature, narrowed to what src/net calls, so tests hand in a fake. Nothing in
 * src/net reaches the global fetch.
 */
export type FetchFunction = (url: string, init: FetchRequestInit) => Promise<Response>;

/** Headers a caller passes, by name. */
export type RequestHeaders = Readonly<Record<string, string>>;

/**
 * The Set-Cookie headers of a response, one per cookie. React Native's Headers
 * has no getSetCookie and joins repeated headers with `, `, so the joined value
 * is split (`splitSetCookie`); where getSetCookie exists (Node), it is used.
 */
export function setCookieHeaders(headers: Headers): string[] {
    const separate = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    if (separate.length > 0) {
        return separate;
    }
    const joined = headers.get('set-cookie');
    return joined === null ? [] : splitSetCookie(joined);
}

/**
 * The caller's headers with their names in lower case, then `own` over them.
 * A caller may not set any of `reserved`, which the wrapper sets itself or
 * never sends.
 */
export function mergeHeaders(
    given: RequestHeaders | undefined,
    own: Readonly<Record<string, string | null>>,
    reserved: readonly string[],
): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(given ?? {})) {
        const lower = name.toLowerCase();
        if (reserved.includes(lower)) {
            throw new TypeError(`The ${name} header is the request wrapper's own; don't pass it.`);
        }
        headers[lower] = value;
    }
    for (const [name, value] of Object.entries(own)) {
        if (value !== null) {
            headers[name] = value;
        }
    }
    return headers;
}

/** Whether a rejected fetch refused a redirect: expo/fetch's FetchRedirectException, or undici's "unexpected redirect". */
export function isRedirectFailure(error: unknown): boolean {
    for (let cause = error, depth = 0; cause instanceof Error && depth < 3; cause = cause.cause, depth++) {
        if (/redirect/i.test(cause.message)) {
            return true;
        }
    }
    return false;
}

/**
 * `fetch` with `Cache-Control: no-store` on every request, over any the caller
 * set (CB-356). OkHttp, React Native's client that expo/fetch builds on on
 * Android, keeps no answer to such a request in `cache/http-cache`. iOS's
 * URLCache keeps it anyway, so on iOS socio-device gives URLSession a cache
 * that keeps nothing (modules/socio-device/README.md).
 */
export function noStore(fetch: FetchFunction): FetchFunction {
    return (url, init) => {
        const headers = Object.fromEntries(new Headers(init.headers ?? undefined));
        headers['cache-control'] = 'no-store';
        return fetch(url, { ...init, headers });
    };
}
