import { refusedForUpdate, serverAway as awayFrom, UNREADABLE_RESPONSE, type Failure } from '@socio/shared/reconnect';

import { NetworkError } from './errors';

// Riding out a restart (CB-108): the app's
// side of @socio/shared/reconnect, which the web shares. Shared decides from a
// `Failure`; this reads the app's errors into one. How they differ from the
// web's:
// - no ApiError class: an HTTP failure is any error with a numeric `status`,
//   and its body didn't read as the API's JSON when its message is
//   UNREADABLE_RESPONSE or its `payload` is text;
// - "no answer" is authedFetch's and publicFetch's NetworkError, since
//   expo/fetch rejects with a plain Error ("fetch failed: ..."), not the
//   browsers' TypeError; a body that breaks off is readText's and readJson's
//   NetworkError, for the same reason (read-body.ts); a TypeError that reads
//   like a network failure counts too, as on the web;
// - an abort is any error named `AbortError` (AbortedError is), as on the web.

// What browsers (and Node) say when a request or its stream breaks off.
const NETWORK = /fetch|network|load failed|input stream|terminated/i;

/** What a failed request of the app's says, for shared's `serverAway`. */
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
        return { status, code, unreadable: message === UNREADABLE_RESPONSE || typeof payload === 'string' };
    }
    return {
        code,
        network:
            error instanceof NetworkError ||
            (error instanceof TypeError && typeof message === 'string' && NETWORK.test(message)),
    };
}

/**
 * Whether a failed request means the server is away or restarting, so waiting
 * and trying again will do (shared's `serverAway`): never a stop the person or
 * the app asked for, nor an error the server explained.
 */
export function serverAway(error: unknown): boolean {
    return awayFrom(failureOf(error));
}
