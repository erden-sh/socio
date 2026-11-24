/**
 * A run sent to a conversation whose turn is still running (CB-357): the
 * server refuses it with a 409 and takes nothing, so sending it again once
 * the turn ends is safe. Clients match the stable `code`, never the text.
 */

/** The error code of a run refused because the conversation's turn is running. */
export const THREAD_RUNNING_CODE = 'thread_running';

/** Its text, unchanged from before it had a code. */
export const THREAD_RUNNING_MESSAGE = 'Thread already running';

/**
 * Whether `error` is that refusal: its own `code`, its `payload`'s (the API's
 * JSON body, as the clients' errors carry it), or a `cause`'s.
 */
export function threadRunning(error: unknown): boolean {
    for (let at = error, depth = 0; at && typeof at === 'object' && depth < 5; depth++) {
        const { code, payload, cause } = at as { code?: unknown; payload?: unknown; cause?: unknown };
        if (
            code === THREAD_RUNNING_CODE ||
            (!!payload && typeof payload === 'object' && (payload as { code?: unknown }).code === THREAD_RUNNING_CODE)
        ) {
            return true;
        }
        at = cause;
    }
    return false;
}
