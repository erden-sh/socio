/**
 * The data space's error (moved from `src/server/dataspace/sql.ts`, which
 * re-exports it): eight features throw or catch it, so it lives below them.
 * A plain `Error` subclass on purpose: its `name`, `String()` and JSON stay
 * what they were (a tagged error comes later, after a check of what callers
 * show).
 */

/** Raised for anything the caller can fix; the message is safe to show. */
export class DataError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 403 | 404 | 409 | 413 | 429 | 503 | 504 = 400,
    ) {
        super(message);
    }
}
