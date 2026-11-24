import { SnapshotShapeError } from './errors';
import type { SnapshotItem } from './merge';

// The checks a snapshot's `split` makes on a 200's body before anything
// applies (snapshot-cache.ts): each throws SnapshotShapeError, so a body that
// isn't the snapshot changes no row.

export type Fields = Record<string, unknown>;

export function object(path: string, value: unknown, what: string): Fields {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new SnapshotShapeError(path, `${what} is not an object.`);
    }
    return value as Fields;
}

export function list(path: string, value: unknown, what: string): readonly unknown[] {
    if (!Array.isArray(value)) {
        throw new SnapshotShapeError(path, `${what} is not a list.`);
    }
    return value;
}

/** A row the source owns alone in its collection or under its key: no version. */
export const singleton = (key: string, value: unknown): SnapshotItem => ({
    key,
    json: JSON.stringify(value),
    version: null,
    value,
});

/**
 * A list of records keyed by their text field `key` (an id), each versioned
 * by its number field `version` (`updatedAt`), or unversioned without one:
 * each record must have them.
 */
export function keyed(
    path: string,
    values: readonly unknown[],
    what: string,
    { key, version }: { readonly key: string; readonly version?: string },
): SnapshotItem[] {
    return values.map((value) => {
        const fields = object(path, value, `an item of ${what}`);
        const id = fields[key];
        if (typeof id !== 'string' || id === '') {
            throw new SnapshotShapeError(path, `an item of ${what} has no ${key}.`);
        }
        if (version === undefined) {
            return { key: id, json: JSON.stringify(value), version: null, value };
        }
        const at = fields[version];
        if (typeof at !== 'number' || !Number.isFinite(at)) {
            throw new SnapshotShapeError(path, `${id} in ${what} has no ${version}.`);
        }
        return { key: id, json: JSON.stringify(value), version: at, value };
    });
}
