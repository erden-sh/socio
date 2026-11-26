import { INSTALL_HEADER, installIdSchema } from '@socio/shared/device-sign-in';
import { UPLOAD_HEADER } from '@socio/shared/media-types';
import { browserTimeZone, TIME_ZONE_HEADER } from '@socio/shared/time-zone';

import type { CookieJar, Outgoing } from './cookie-jar';
import { AbortedError, NetworkError, OutsideOriginError, RedirectRefusedError } from './errors';
import {
    type FetchFunction,
    isRedirectFailure,
    mergeHeaders,
    type RequestHeaders,
    setCookieHeaders,
} from './fetch-function';
import { classifyUnauthorized, type SessionEnd, sessionEndOf, wipesCopy } from './session';

// authedFetch: every request to a workspace.
// - Only the workspace's exact origin: any other URL is refused before anything
//   is sent, and a redirect is never followed (`redirect: 'error'`), so the
//   jar's cookies reach no other host.
// - `credentials: 'omit'`, with the jar's cookies sent by hand, so the system's
//   cookie store stays out of it.
// - `Origin: <the workspace's origin>` on every request: the edge accepts
//   exactly that origin, and Better Auth refuses a write that carries a cookie
//   but no Origin (403 MISSING_OR_NULL_ORIGIN, as update-user does).
// - Writes are JSON, as the server requires (a 415 otherwise).
// - Set-Cookie applies on every status, 304s and 401s included, so the daily
//   slide and the server's clearing cookie both land, and the jar is stored
//   before the response comes back.
// - A 401 is classified (expired or ended) against what the jar knew of the
//   session as the request went (`jar.outgoing`), not as the answer came: by
//   then that 401's clearing cookie, or an earlier one, may have erased it. A
//   401 to a request the jar sent without a session cookie it held, judging it
//   expired, is never `ended`: the server never saw the cookie. If the 401's
//   Date shows the cookie live (the device clock moved since the offset was
//   measured), that 401 has put the offset right, and the request goes once
//   more, with the cookie.
// - The workspace scope's AbortSignal stops every request it made; a request
//   after the scope closed isn't sent, and an answer that comes after changes
//   nothing. A request's own signal (one run, one stream, one upload) stops it
//   alone, the same way, and keeps stopping its body as it is read.
// - The answer comes back with its body unread, so a stream (readSse) is read
//   as it arrives; nothing here reads or buffers a body.
// - A raw body (a file's bytes) goes only to the upload path or a dataset's
//   files (CB-469), with the headers the server asks for there; every other
//   write is JSON.
// - `onAnswer` sees each answer with what its request carried, once its
//   Set-Cookie has applied: the sync engine records contact from it
//   (src/sync/contact.ts).
// - The workspace's install id, when it has one, goes on every request
//   as `X-Socio-Install`: only here, so only to this origin, sign-in included.
//   publicFetch, the relay's fetch and the link domain never carry it. A 401 to
//   a request that carried it may say why in its JSON `code`
//   (`session_expired`, `session_ended`, `device_revoked`, `deactivated`), read
//   from a clone so the caller still has the whole body, only from a JSON body
//   and at most its first 4 KB; without one of those, the rules above decide.
//   A code that wipes the copy is confirmed first: one `GET /api/auth/devices`
//   (behind the session check) with the install id must answer the same code, or the 401 is read without
//   it (Ended locks, and needs no confirmation).

/** An answer authedFetch got, with what its request carried. */
export interface Answered {
    readonly url: URL;
    readonly status: number;
    /** The answer's Date header, or null. */
    readonly date: string | null;
    /** What the request took from the jar as it went (`jar.outgoing`). */
    readonly sent: Outgoing;
}

export interface AuthedFetchOptions {
    /** The workspace's exact origin, as `new URL(address).origin` gives it (`https://brain.example.com`). */
    origin: string;
    /** The workspace's jar, for the same origin. */
    jar: CookieJar;
    /** The app's one fetch (src/platform/fetch.ts). */
    fetch: FetchFunction;
    /** The app's User-Agent (`userAgent`), which carries nothing about the person. */
    userAgent: string;
    /** The workspace scope's signal: aborting it stops every request it made. */
    signal: AbortSignal;
    /**
     * Called on each 401 with what it means, worked out from the jar as the
     * request went, and awaited before the 401's Set-Cookie applies.
     */
    onUnauthorized?: (end: SessionEnd, url: string) => void | Promise<void>;
    /**
     * Called with each answer authedFetch hands back, or refuses as a redirect,
     * once its Set-Cookie has applied. Not with a 401 it sends again. It must not throw.
     */
    onAnswer?: (answer: Answered) => void;
    /** The device's time zone, for `timeZone` requests; shared's `browserTimeZone` by default. */
    timeZone?: () => string | undefined;
    /**
     * This install's id for the workspace (keys.ts' `install`), sent as
     * `X-Socio-Install` on every request; none on a copy made before install ids.
     */
    installId?: string | null;
}

/** The one path a raw body may go to (the edge's `rawUpload`, `MEDIA_UPLOAD_PATH` on the server). */
export const UPLOAD_PATH = '/api/media/uploads';

/**
 * A dataset's attachments (CB-469, CB-451, `viewRoutes(id).files`), which take a file's
 * bytes as the media upload does: one dataset id, encoded, and nothing after it.
 */
export const DATASET_FILES_PATH = /^\/api\/data\/datasets\/[^/]+\/files$/;

/** Whether a raw body may go to `pathname`. */
export const takesRawUpload = (pathname: string) => pathname === UPLOAD_PATH || DATASET_FILES_PATH.test(pathname);

/** A file's bytes for `POST /api/media/uploads`, sent raw (never base64 JSON). */
export interface RawUpload {
    /** The bytes: a Blob (expo-file-system's File is one) or a buffer. */
    readonly body: Blob | ArrayBuffer | Uint8Array<ArrayBuffer>;
    /** The file's name, sent URI-encoded in `X-File-Name`. */
    readonly name: string;
    /** Its MIME type, sent in `X-File-Type` when known. */
    readonly type?: string;
}

export interface AuthedRequestInit {
    /** GET by default. */
    method?: string;
    /** More headers (If-None-Match, Accept, ...). Cookie, Origin, User-Agent and Content-Type are authedFetch's own. */
    headers?: RequestHeaders;
    /** The body of a write, sent as JSON. */
    json?: unknown;
    /**
     * The body of a write already written as JSON, sent as it is (an issue
     * file's base64 is joined into its body, not stringified again).
     */
    jsonText?: string;
    /** A raw body, only to `UPLOAD_PATH` (POST, the default with it). */
    upload?: RawUpload;
    /**
     * This request's own signal, besides the scope's: aborting it stops this
     * request, its body included, and no other.
     */
    signal?: AbortSignal;
    /**
     * Send the device's time zone in `X-Time-Zone` (an IANA name, checked with
     * shared's `ianaTimeZone`), as the web does on chat requests. Left out when
     * the device's zone isn't one.
     */
    timeZone?: boolean;
}

/**
 * A request to the workspace: `input` is a path (`/api/state`) or a URL on its
 * origin. Resolves with the answer, whatever its status; rejects with
 * OutsideOriginError (nothing sent), RedirectRefusedError, NetworkError or
 * AbortedError, or with the store's error when the jar couldn't be stored (the
 * jar in memory has the new cookies all the same, and the next write stores them).
 */
export type AuthedFetch = (input: string, init?: AuthedRequestInit) => Promise<Response>;

/** Headers authedFetch sets itself. */
const RESERVED = [
    'cookie',
    'origin',
    'user-agent',
    'content-type',
    UPLOAD_HEADER.toLowerCase(),
    'x-file-name',
    'x-file-type',
    TIME_ZONE_HEADER.toLowerCase(),
    INSTALL_HEADER.toLowerCase(),
];

/** The longest 401 body read for its code: the server's are a few dozen bytes. Reading stops past it. */
export const CODE_BODY_LIMIT = 4096;
/**
 * Where a wiping code is confirmed: a route behind the server's session check, which answers the
 * device code to a request with an install id. Not `/api/auth/session`: the server serves that
 * sign-in view before the check, to anyone, so it answers 200 and a revoked device would only lock.
 */
export const CONFIRM_PATH = '/api/auth/devices';

export function createAuthedFetch({
    origin,
    jar,
    fetch,
    userAgent,
    signal: scopeSignal,
    onUnauthorized,
    onAnswer,
    timeZone = browserTimeZone,
    installId = null,
}: AuthedFetchOptions): AuthedFetch {
    if (jar.origin !== origin) {
        throw new TypeError(`authedFetch for ${origin} was given ${jar.origin}'s jar.`);
    }
    if (installId !== null && !installIdSchema.safeParse(installId).success) {
        throw new TypeError('An install id is 43 base64url characters.');
    }
    return async (input, init = {}) => {
        const url = resolveOnOrigin(input, origin);
        const { upload } = init;
        const method = (init.method ?? (upload ? 'POST' : 'GET')).toUpperCase();
        const write = method !== 'GET' && method !== 'HEAD';
        if (!write && (init.json !== undefined || init.jsonText !== undefined)) {
            throw new TypeError(`A ${method} request has no body.`);
        }
        if (init.json !== undefined && init.jsonText !== undefined) {
            throw new TypeError('A request takes JSON or JSON text, not both.');
        }
        if (upload) {
            checkUpload(url, method, upload, init.json ?? init.jsonText);
        }
        const zone = init.timeZone ? timeZone() : undefined;
        const signal = either(scopeSignal, init.signal);
        /**
         * Asks `GET <CONFIRM_PATH>` once, with the install id and the jar's
         * cookies, for the 401 code it answers. No answer, or anything but a
         * 401 with a JSON code, is no code. Only a stop rejects.
         */
        const confirmCode = async (): Promise<{
            code: string | null;
            cookies: { url: URL; setCookies: string[]; date: string | null } | null;
        }> => {
            const target = new URL(CONFIRM_PATH, origin);
            const carried = jar.outgoing(target);
            let answer: Response;
            try {
                answer = await fetch(target.href, {
                    method: 'GET',
                    headers: mergeHeaders(
                        { accept: 'application/json' },
                        {
                            origin,
                            cookie: carried.cookie,
                            'user-agent': userAgent,
                            [INSTALL_HEADER.toLowerCase()]: installId,
                        },
                        RESERVED,
                    ),
                    credentials: 'omit',
                    redirect: 'error',
                    signal,
                });
            } catch {
                if (signal.aborted) {
                    throw new AbortedError(target.href, signal.reason);
                }
                return { code: null, cookies: null };
            }
            const cookies = {
                url: target,
                setCookies: setCookieHeaders(answer.headers),
                date: answer.headers.get('date'),
            };
            if (answer.status !== 401 || answer.redirected) {
                await answer.body?.cancel().catch(() => undefined);
                return { code: null, cookies };
            }
            return { code: await unauthorizedCode(answer, signal), cookies };
        };
        const send = async (again: boolean): Promise<Response> => {
            const sent = jar.outgoing(url);
            const headers = mergeHeaders(
                { accept: 'application/json', ...init.headers },
                {
                    origin,
                    cookie: sent.cookie,
                    'user-agent': userAgent,
                    'content-type': upload ? 'application/octet-stream' : write ? 'application/json' : null,
                    [UPLOAD_HEADER.toLowerCase()]: upload ? '1' : null,
                    'x-file-name': upload ? encodeURIComponent(upload.name) : null,
                    'x-file-type': upload?.type || null,
                    [TIME_ZONE_HEADER.toLowerCase()]: zone ?? null,
                    [INSTALL_HEADER.toLowerCase()]: installId,
                },
                RESERVED,
            );
            if (signal.aborted) {
                throw new AbortedError(url.href, signal.reason);
            }

            let response: Response;
            try {
                response = await fetch(url.href, {
                    method,
                    headers,
                    body: upload
                        ? upload.body
                        : init.jsonText !== undefined
                          ? init.jsonText
                          : init.json === undefined
                            ? undefined
                            : JSON.stringify(init.json),
                    credentials: 'omit',
                    redirect: 'error',
                    signal,
                });
            } catch (error) {
                if (signal.aborted) {
                    throw new AbortedError(url.href, signal.reason);
                }
                if (isRedirectFailure(error)) {
                    throw new RedirectRefusedError(url.href, error);
                }
                throw new NetworkError(url.href, error);
            }
            // The scope closed, or the request was stopped, while the answer came: it changes nothing, the jar included.
            if (signal.aborted) {
                throw new AbortedError(url.href, signal.reason);
            }
            // A fetch that followed a redirect anyway: the answer, cookies and all, may be another origin's.
            if (response.redirected || (response.url !== '' && new URL(response.url).origin !== origin)) {
                throw new RedirectRefusedError(url.href);
            }

            const setCookies = setCookieHeaders(response.headers);
            const date = response.headers.get('date');
            if (response.status !== 401) {
                await jar.apply(url, setCookies, date);
            } else {
                const serverNow = jar.serverNow(date);
                if (
                    sent.sessionWithheld &&
                    !again &&
                    sent.sessionExpiresAt !== null &&
                    serverNow < sent.sessionExpiresAt
                ) {
                    // The jar kept back a cookie the server's clock says is live. This 401's Date puts the offset
                    // right. The server turned the request away for want of a cookie, before any route ran it,
                    // so sending it again is safe, a write included.
                    await jar.apply(url, setCookies, date);
                    return send(true);
                }
                let code = installId !== null && onUnauthorized ? await unauthorizedCode(response, signal) : null;
                let confirmCookies: { url: URL; setCookies: string[]; date: string | null } | null = null;
                const said = sessionEndOf(code, sent.sessionWithheld);
                if (said !== null && wipesCopy(said)) {
                    const confirmed = await confirmCode();
                    confirmCookies = confirmed.cookies;
                    if (confirmed.code !== code) {
                        code = null;
                    }
                }
                const end =
                    sessionEndOf(code, sent.sessionWithheld) ??
                    (sent.sessionWithheld ? 'expired' : classifyUnauthorized(sent.sessionExpiresAt, serverNow));
                try {
                    await onUnauthorized?.(end, url.href);
                } finally {
                    await jar.apply(url, setCookies, date);
                    if (confirmCookies !== null) {
                        await jar.apply(confirmCookies.url, confirmCookies.setCookies, confirmCookies.date);
                    }
                }
            }
            onAnswer?.({ url, status: response.status, date, sent });
            // A 3xx handed back despite `redirect: 'error'`: its cookies were the workspace's, but it isn't followed.
            if (response.status >= 300 && response.status < 400 && response.status !== 304) {
                throw new RedirectRefusedError(url.href);
            }
            return response;
        };
        return send(false);
    };
}

/** Whether a Content-Type is `application/json`, with any parameters. */
function isJsonType(contentType: string | null): boolean {
    return (contentType ?? '').split(';')[0].trim().toLowerCase() === 'application/json';
}

/**
 * A 401's JSON `code`, read from a clone so the answer goes back whole, or
 * null: no clone or body, not `application/json`, a body past CODE_BODY_LIMIT
 * (reading stops there, without waiting for the rest), cut short, or with no
 * string code. Only a stop rejects (AbortedError).
 */
async function unauthorizedCode(response: Response, signal: AbortSignal): Promise<string | null> {
    if (typeof response.clone !== 'function' || !isJsonType(response.headers.get('content-type'))) {
        return null;
    }
    const text = await readCapped(response.clone(), signal);
    if (text === null) {
        return null;
    }
    try {
        const body: unknown = JSON.parse(text);
        return typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string'
            ? (body as { code: string }).code
            : null;
    } catch {
        return null;
    }
}

/**
 * The body as text, read as it arrives and given up past CODE_BODY_LIMIT
 * bytes, or null then, and when it breaks off or has no body. Only a stop
 * rejects (AbortedError).
 */
async function readCapped(response: Response, signal: AbortSignal): Promise<string | null> {
    const body = response.body;
    if (body === null) {
        return null;
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        for (;;) {
            if (signal.aborted) {
                throw new AbortedError(response.url, signal.reason);
            }
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            length += value.byteLength;
            if (length > CODE_BODY_LIMIT) {
                // Not awaited: a clone's cancel settles only once the other branch is done with too.
                reader.cancel().catch(() => undefined);
                return null;
            }
            chunks.push(value);
        }
    } catch (error) {
        if (error instanceof AbortedError || signal.aborted) {
            throw error instanceof AbortedError ? error : new AbortedError(response.url, signal.reason);
        }
        return null;
    }
    const all = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
        all.set(chunk, at);
        at += chunk.byteLength;
    }
    return new TextDecoder().decode(all);
}

/** A raw body goes only to the upload paths, by POST, with a name and no JSON beside it. */
function checkUpload(url: URL, method: string, upload: RawUpload, json: unknown): void {
    if (!takesRawUpload(url.pathname)) {
        throw new TypeError(`A raw body goes only to ${UPLOAD_PATH} or a dataset's files, not ${url.pathname}.`);
    }
    if (method !== 'POST') {
        throw new TypeError(`An upload is a POST, not a ${method}.`);
    }
    if (json !== undefined) {
        throw new TypeError('A request takes a raw body or JSON, not both.');
    }
    if (upload.name.trim() === '') {
        throw new TypeError('An upload needs the file’s name.');
    }
}

/**
 * A signal that aborts when `scope` or `own` does, with its reason. Hermes has
 * no AbortSignal.any. The listeners go once either aborts; a request with no
 * signal of its own takes the scope's as it is, so only runs, streams and
 * uploads add any.
 */
function either(scope: AbortSignal, own: AbortSignal | undefined): AbortSignal {
    if (own === undefined || own === scope) {
        return scope;
    }
    if (scope.aborted || own.aborted) {
        return scope.aborted ? scope : own;
    }
    const both = new AbortController();
    const stop = (from: AbortSignal) => () => {
        scope.removeEventListener('abort', fromScope);
        own.removeEventListener('abort', fromOwn);
        both.abort(from.reason);
    };
    const fromScope = stop(scope);
    const fromOwn = stop(own);
    scope.addEventListener('abort', fromScope, { once: true });
    own.addEventListener('abort', fromOwn, { once: true });
    return both.signal;
}

/**
 * `input` as a URL on `origin`, or OutsideOriginError. A path resolves against
 * the origin; `//host/...`, `/\host/...` and an absolute URL elsewhere don't
 * land on it, and a URL with a user name or password is refused even when its
 * origin matches.
 */
function resolveOnOrigin(input: string, origin: string): URL {
    let url: URL;
    try {
        url = new URL(input, origin);
    } catch {
        throw new OutsideOriginError(input, origin);
    }
    if (url.origin !== origin || url.username !== '' || url.password !== '') {
        throw new OutsideOriginError(input, origin);
    }
    return url;
}
