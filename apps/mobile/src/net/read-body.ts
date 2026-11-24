import { AbortedError, NetworkError } from './errors';

// Reading an answer's body. The
// headers come back before the body, so a connection can still break off
// while the body is read: the proxy cutting it in a restart (CB-108), say. The
// web sees a TypeError then ("network error", "terminated"), which its
// `serverAway` counts as the server being away. expo/fetch doesn't: a body
// stream fails with `new Error(...)` and text() or json() with the native
// module's coded error. So src/net reads bodies here, and a read that breaks
// off fails with the same NetworkError as no answer at all, or AbortedError
// once the scope has stopped, as authedFetch and publicFetch do for the
// headers.

/** The body as text; rejects with NetworkError when it breaks off, AbortedError once `signal` has aborted. */
export async function readText(response: Response, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) {
        throw new AbortedError(response.url, signal.reason);
    }
    try {
        return await response.text();
    } catch (error) {
        if (signal?.aborted) {
            throw new AbortedError(response.url, signal.reason);
        }
        throw new NetworkError(response.url, error);
    }
}

/**
 * The body read as JSON, as `readText` reads it. A whole body that isn't JSON
 * (a proxy's error page) rejects with JSON.parse's SyntaxError, which the
 * caller turns into the failure it means, never the network's.
 */
export async function readJson(response: Response, signal?: AbortSignal): Promise<unknown> {
    return JSON.parse(await readText(response, signal)) as unknown;
}
