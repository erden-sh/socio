/**
 * Soft delete (CB-64). Deleting user content
 * stamps `deletedAt` (ms) and `deletedBy` and keeps the row; children that
 * went with a parent also get `deletedWith` (`<kind>:<id>` of the parent).
 * Every read that serves a user, a Dot or a token filters on `LIVE`;
 * lookups that must see deleted rows are named `withDeleted…`.
 */

/** The live-row filter, for a table without an alias. */
export const LIVE = 'deletedAt IS NULL';

/** The live-row filter for an aliased or joined table (`live('i')`). */
export const live = (table: string) => `${table}.deletedAt IS NULL`;

/** Who deleted a row: a user id, `system`, or `dot:<id>` for a Dot tool. */
export const SYSTEM = 'system';
export const byDot = (dotId: string) => `dot:${dotId}`;

/** What a cascaded child records it went with. */
export const deletedWith = (kind: string, id: string) => `${kind}:${id}`;

/** The stamp columns, which API views don't carry. */
export type Stamp = {
    deletedAt?: unknown;
    deletedBy?: unknown;
    deletedWith?: unknown;
};

/** A row without its stamp columns, for API views of live rows. */
export function unstamped<T extends object>(row: T): Omit<T, keyof Stamp> {
    const copy = { ...row } as T & Stamp;
    delete copy.deletedAt;
    delete copy.deletedBy;
    delete copy.deletedWith;
    return copy;
}
