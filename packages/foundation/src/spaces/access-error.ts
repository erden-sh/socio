/*
 * The refusal Space access throws (CB-181). Moved from
 * `src/server/spaces/contract.ts`, which re-exports it, so the workspace's
 * routes, which sit below spaces in the folder order, can catch it with
 * `instanceof` too.
 */

/**
 * A refusal: 404 when the person can't see the Space, else 403, 409 or 400.
 * Caught with `instanceof` in spaces, workspace, pages, agents and web; kept a plain `Error` so its
 * name, message and JSON stay what they are today.
 */
export class SpaceAccessError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 403 | 404 | 409,
    ) {
        super(message);
        this.name = 'SpaceAccessError';
    }
}
