import { UNREADABLE_RESPONSE } from '@socio/shared/reconnect';

import { readText } from '../net/read-body';

// What a pull fails with besides src/net's errors (no answer, a redirect, a
// stop). Shaped for `serverAway` (src/net/reconnect.ts), which reads `status`,
// `code`, `payload` and the message: a 503 `draining`, a 502 or 504, or a 503
// whose body isn't the API's JSON means the server is away.

/** The server answered with a status other than 2xx or 304. */
export class HttpError extends Error {
    override name = 'HttpError';

    constructor(
        readonly url: string,
        readonly status: number,
        message: string,
        /** The API's `code`, when the body is its JSON (`sign_in`, `draining`, …). */
        readonly code: string | undefined,
        /** The body: the API's JSON, or the text when it isn't JSON. */
        readonly payload: unknown,
    ) {
        super(message);
    }
}

/** A 200 whose body isn't the snapshot it should be: nothing of it is applied. */
export class SnapshotShapeError extends Error {
    override name = 'SnapshotShapeError';

    constructor(
        readonly path: string,
        detail: string,
    ) {
        super(`${path} answered with something else than its snapshot: ${detail}`);
    }
}

/**
 * The HttpError for a failed answer, reading its body as the web's api.ts
 * does: the API's `{error, code}` gives the message and code; any other body
 * gives UNREADABLE_RESPONSE, with the text as the payload. A body that breaks
 * off rejects with readText's NetworkError instead.
 */
export async function httpError(response: Response, signal?: AbortSignal): Promise<HttpError> {
    const text = await readText(response, signal);
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = undefined;
    }
    if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
        const { error, code } = parsed as { error: string; code?: unknown };
        return new HttpError(response.url, response.status, error, typeof code === 'string' ? code : undefined, parsed);
    }
    return new HttpError(response.url, response.status, UNREADABLE_RESPONSE, undefined, text);
}
