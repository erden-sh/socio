import type { FetchRequestInit } from 'expo/fetch';

import type { FetchFunction } from '../../src/net/fetch-function';

// Fakes for src/net's tests: a fetch that records what it was asked, answers
// with Node's Response, and a server that slides and ends sessions the way
// Better Auth does (src/server/auth/better-auth.ts: 7 days, renewed once a day
// of use; a clearing cookie with the 401 for a session it doesn't know).

export const ORIGIN = 'https://brain.example.test';
export const LOCAL_ORIGIN = 'http://localhost:4352';
/** Mon, 02 Nov 2026 09:00:00 GMT. */
export const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
export const WEEK_SECONDS = 604_800;
export const SESSION = '__Host-cb.session_token';
const SESSION_ATTRIBUTES = '; Path=/; HttpOnly; Secure; SameSite=Strict';

/** An HTTP date, as a server's Date header gives it. */
export const httpDate = (ms: number) => new Date(ms).toUTCString();

/** The session cookie as the server sets it over https (`Max-Age=0` clears it). */
export const sessionSetCookie = (value: string, maxAge = WEEK_SECONDS) =>
    `${SESSION}=${value}; Max-Age=${maxAge}${SESSION_ATTRIBUTES}`;

export interface Call {
    url: string;
    init: FetchRequestInit;
}

/** A fetch that records each call and answers with `respond`. */
export function fakeFetch(
    respond: (url: string, init: FetchRequestInit) => Response | Promise<Response> = () => answer(200),
): FetchFunction & { calls: Call[] } {
    const calls: Call[] = [];
    const fetch = async (url: string, init: FetchRequestInit) => {
        calls.push({ url, init });
        return respond(url, init);
    };
    return Object.assign(fetch, { calls });
}

/** The headers a call sent, by lower-case name (src/net passes them as a record). */
export const sentHeaders = (call: Call | undefined) => (call?.init.headers ?? {}) as Record<string, string>;

export interface AnswerOptions {
    setCookie?: readonly string[];
    date?: string;
    headers?: Record<string, string>;
    body?: unknown;
    /**
     * Give the Set-Cookie headers only as one value joined with `, `, as React
     * Native's Headers does (and iOS natively): no getSetCookie.
     */
    joined?: boolean;
}

/** A response, as expo/fetch would hand it back. */
export function answer(status: number, options: AnswerOptions = {}): Response {
    const headers = new Headers(options.headers);
    for (const cookie of options.setCookie ?? []) {
        headers.append('set-cookie', cookie);
    }
    if (options.date !== undefined) {
        headers.set('date', options.date);
    }
    const empty = status === 204 || status === 304 || (status >= 300 && status < 400);
    const body = empty || options.body === undefined ? null : JSON.stringify(options.body);
    const response = new Response(body, { status, headers });
    if (options.joined) {
        Object.defineProperty(response.headers, 'getSetCookie', { value: undefined });
    }
    return response;
}

/** The value a Cookie header gives `name`, or undefined. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
    for (const pair of (header ?? '').split('; ')) {
        const equals = pair.indexOf('=');
        if (equals !== -1 && pair.slice(0, equals) === name) {
            return pair.slice(equals + 1);
        }
    }
    return undefined;
}

/** A clock pair: the server's time, and the device's, `skew` off it. */
export function clocks(start = T0, skew = 0) {
    const clock = { server: start, skew };
    return Object.assign(clock, { device: () => clock.server + clock.skew });
}

/**
 * A workspace server with Better Auth's session rules, over https:
 * - sign-in sets the session cookie, Max-Age 604800 (7 days);
 * - any request with the live session's cookie renews it when it was last
 *   renewed 24 hours ago or more, with a fresh Set-Cookie;
 * - update-user (`POST /api/auth/update-user`) sets the session cookie again
 *   with the full Max-Age 604800 but leaves the session's expiry where it was,
 *   as better-auth's setSessionCookie does (1.7.10: dist/cookies/index.mjs);
 * - a cookie for a session it doesn't have (ended, expired) gets the 401 with a
 *   clearing cookie; no cookie gets the 401 alone.
 * Every answer carries its Date header.
 */
export function betterAuthServer(clock: { server: number }) {
    let session: { token: string; expiresAt: number; renewedAt: number } | null = null;
    let issued = 0;
    const handle = (url: string, init: FetchRequestInit): Response => {
        const now = clock.server;
        const date = httpDate(now);
        if (new URL(url).pathname === '/api/auth/sign-in/email') {
            issued += 1;
            // A Better Auth cookie value: the token and its signature, URL-encoded.
            session = { token: `t${issued}.c2lnbmF0dXJl%3D`, expiresAt: now + 7 * DAY, renewedAt: now };
            return answer(200, { date, setCookie: [sessionSetCookie(session.token)], body: { redirect: false } });
        }
        const sent = cookieValue(sentHeaders({ url, init }).cookie, SESSION);
        if (session !== null && sent === session.token && now < session.expiresAt) {
            const setCookie: string[] = [];
            if (now - session.renewedAt >= DAY) {
                session = { ...session, expiresAt: now + 7 * DAY, renewedAt: now };
                setCookie.push(sessionSetCookie(session.token));
            }
            if (new URL(url).pathname === '/api/auth/update-user') {
                // A full week's Max-Age, though the session's expiry didn't move.
                setCookie.push(sessionSetCookie(session.token));
            }
            return answer(200, { date, setCookie, body: {} });
        }
        if (session !== null && now >= session.expiresAt) {
            session = null;
        }
        return answer(401, {
            date,
            setCookie: sent === undefined ? [] : [sessionSetCookie('', 0)],
            body: { error: 'Sign in to continue.', code: 'sign_in' },
        });
    };
    return {
        handle,
        /** Ends the session on the server: sign-out everywhere, an admin, the access policy. */
        end() {
            session = null;
        },
        get session() {
            return session;
        },
    };
}

/** A promise and its resolve, for holding a fake's answer or write until the test lets it go. */
export function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

/** Lets pending promise callbacks run. */
export const settle = () => new Promise<void>((done) => setTimeout(done, 0));

/**
 * A streamed answer the test writes to as it goes, as expo/fetch hands one
 * back: chunks arrive as `push` sends them, and once `signal` aborts the read
 * rejects with an AbortError, as expo/fetch's reader does.
 */
export function streamedAnswer(
    options: {
        status?: number;
        headers?: Record<string, string>;
        setCookie?: readonly string[];
        signal?: AbortSignal | null;
    } = {},
) {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled: unknown = null;
    const body = new ReadableStream<Uint8Array>({
        start(streamController) {
            controller = streamController;
        },
        cancel(reason) {
            cancelled = reason ?? true;
        },
    });
    const headers = new Headers({ 'content-type': 'text/event-stream', ...options.headers });
    for (const cookie of options.setCookie ?? []) {
        headers.append('set-cookie', cookie);
    }
    const response = new Response(body, { status: options.status ?? 200, headers });
    options.signal?.addEventListener('abort', () => {
        try {
            controller.error(new DOMException('signal is aborted without reason', 'AbortError'));
        } catch {
            // Already closed.
        }
    });
    return {
        response,
        /** Sends text, or bytes as they are; nothing once the reader has cancelled. */
        push(chunk: string | Uint8Array) {
            if (cancelled === null) {
                controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
            }
        },
        end() {
            controller.close();
        },
        /** Breaks the body off, as a dropped connection does (a plain Error, as expo/fetch's). */
        fail(error: unknown = new Error('stream was reset')) {
            controller.error(error);
        },
        /** What the reader cancelled the body with, or null. */
        get cancelled() {
            return cancelled;
        },
    };
}
