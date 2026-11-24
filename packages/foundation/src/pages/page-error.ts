/**
 * The pages error (moved from `src/server/pages/pages.ts`, which re-exports
 * it): five features catch or throw it, so it lives below them. A plain
 * `Error` subclass on purpose: its `name`, `String()` and JSON stay what
 * they were (a tagged error comes later, after a check of what callers
 * show).
 */

/** Raised for anything the caller can fix; the message is safe to show. */
export class PageError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 403 | 404 | 409 | 410 = 400,
    ) {
        super(message);
    }
}
