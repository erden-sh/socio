import type { CachedRow, RowVersion } from './rows';

// How a snapshot meets the copy on the device. A 200 replaces its scope: what
// it lacks is removed and what changed is set, except where the device knows
// better because one of its own writes was confirmed while the pull was in
// flight.
//
// Ported from the web client's mergePageSnapshot
// (packages/client/src/modules/pages/page-snapshots.ts, with the poll counting
// in packages/client/src/modules/spaces/SpaceWorkspace.tsx), not imported: the
// app can't load packages/client. The plan applies its rules to every kind:
// - each pull notes when it started (a counter, as the web's `polls.started`,
//   so the device clock plays no part), and an answer to a pull that started
//   before the last one applied is dropped (the web's `poll > applied`);
// - an item this device created or deleted stays that way for any pull that
//   started before the confirmation (the web's `fresh` and `deleted`); a pull
//   that started after it is the truth again;
// - an item is set only when its incoming version (revision, updatedAt or seq)
//   is at least the stored one (the web's `keepsLocal`);
// - removes go by collection, scope and key: a merge sees one scope's rows, so
//   an older snapshot of one Space never removes a page that moved to another.
// Changes from the web's:
// - one version per row, compared as numbers or as strings (`compareVersions`),
//   where the web compares revision then updatedAt; a source that has both
//   folds them into one;
// - a confirmed change of any kind holds, not only creates and deletes: most of
//   the shell's records (conversations, spaces, socios) carry no version, so
//   only the pull's start can order them (5.1). A versioned row the device
//   changed still takes a newer version from a pull that started before the
//   confirmation: someone changed it again after;
// - a deleted item comes back once a pull that started after the delete's
//   confirmation has it, where the web keeps it out while the view lives;
// - the merge says where a hold kept the device's copy against the snapshot
//   (`withheld`): the device then holds no body the server sent, so the cache
//   keeps no ETag for it, and the rerun (5.2) is a full pull.
// Keep the two in step.

/** A record as a snapshot brings it. */
export interface SnapshotItem {
    readonly key: string;
    readonly json: string;
    readonly version: RowVersion;
    readonly value: unknown;
}

/** One of this device's writes the server confirmed: when (the pull counter then), and whether it deleted the row. */
export interface Confirmation {
    readonly at: number;
    readonly deleted: boolean;
}

export interface MergeOptions {
    /** The pull counter when this pull started. */
    readonly startedAt: number;
    /** This device's confirmed writes in the scope, by key. */
    readonly confirmed?: ReadonlyMap<string, Confirmation>;
    /** Keep rows the snapshot lacks (notices outlive the server's 24 h, 4.3). */
    readonly retain?: boolean;
}

export interface Merged {
    readonly upserts: readonly SnapshotItem[];
    /** Keys of `known` to remove. */
    readonly removes: readonly string[];
    /**
     * Keys where a confirmation kept the device's copy against the snapshot: a
     * row it set, removed or lacked that the snapshot has otherwise. The scope
     * then isn't the snapshot's body, so its ETag doesn't name it.
     */
    readonly withheld: readonly string[];
}

/**
 * How two versions compare: negative, zero or positive, or undefined when
 * either is missing or they aren't of one type (a format change), and the
 * incoming one is taken.
 */
export function compareVersions(a: RowVersion, b: RowVersion): number | undefined {
    if (typeof a === 'number' && typeof b === 'number') {
        return a - b;
    }
    if (typeof a === 'string' && typeof b === 'string') {
        return a < b ? -1 : a > b ? 1 : 0;
    }
    return undefined;
}

/**
 * What `incoming`, a whole snapshot of one scope, changes in `known`, that
 * scope's rows. An item in `incoming` twice counts once, the last.
 */
export function mergeSnapshot(
    known: ReadonlyMap<string, CachedRow>,
    incoming: readonly SnapshotItem[],
    { startedAt, confirmed, retain = false }: MergeOptions,
): Merged {
    const items = new Map(incoming.map((item) => [item.key, item]));
    /** A confirmation this pull started before, so it can't undo. */
    const holding = (key: string) => {
        const confirmation = confirmed?.get(key);
        return confirmation !== undefined && startedAt <= confirmation.at ? confirmation : undefined;
    };
    const upserts: SnapshotItem[] = [];
    const withheld: string[] = [];
    for (const item of items.values()) {
        const held = holding(item.key);
        if (held?.deleted) {
            withheld.push(item.key);
            continue;
        }
        const local = known.get(item.key);
        if (local === undefined) {
            upserts.push(item);
            continue;
        }
        if (local.json === item.json) {
            continue;
        }
        const order = compareVersions(item.version, local.version);
        // Held, only a newer version gets through; otherwise anything but an older one.
        const takes = held !== undefined ? order !== undefined && order > 0 : order === undefined || order >= 0;
        if (takes) {
            upserts.push(item);
        } else if (held !== undefined) {
            withheld.push(item.key);
        }
    }
    const removes: string[] = [];
    if (!retain) {
        for (const key of known.keys()) {
            if (items.has(key)) {
                continue;
            }
            if (holding(key) === undefined) {
                removes.push(key);
            } else {
                withheld.push(key);
            }
        }
    }
    return { upserts, removes, withheld };
}
