import { bucketStarts, nextBucket, type OpsWindow } from '@socio/shared/operations/operations';
import {
    OPS_STORAGE_KINDS,
    type OpsStorage,
    type OpsStorageKind,
    type OpsStorageNow,
} from '@socio/shared/operations/operations-knowledge';
import { percentile } from '@socio/shared/pages/search-timing';

/**
 * The Knowledge and Capabilities facts (CB-191), as the analytics store
 * keeps them (`etl/knowledge-schema.ts`) and `MemoryOpsReader` takes them,
 * with what both readers compute the same way in code.
 */

export interface SpaceFact {
    id: string;
    name: string;
    deletedAt?: number | null;
}
export interface PageFact {
    pageId: string;
    spaceId: string;
    title: string;
    chars: number;
    revision: number;
    createdAt: number;
    updatedAt: number;
}
export interface PageUseFact {
    pageId: string;
    usedAt: number;
}
export interface PageEditFact {
    revisionId: number;
    pageId: string;
    spaceId: string;
    authorKind: 'person' | 'socio' | 'unknown';
    authorId: string | null;
    at: number;
}
export interface SearchDayFact {
    /** The UTC day's start. */
    at: number;
    queries: number;
    empty: number;
    corrected: number;
    trigram: number;
    maxMs: number;
    histogram: Record<number, number>;
}
export interface DataAccessFact {
    id: string;
    at: number;
    ownerId: string;
    actorKind: string;
    actorId: string | null;
    socioId: string | null;
    datasetId: string | null;
    action: string;
    outcome: string;
    /** The chat a socio's tool acted in (CB-194). */
    threadId?: string | null;
}
export interface DatasetFact {
    id: string;
    ownerId: string;
    name: string;
    scratch: boolean;
    sizeBytes: number;
    historyBytes: number;
    tables: number;
    createdAt: number;
    updatedAt: number;
    deletedAt: number | null;
}
export interface DatasetDayFact {
    datasetId: string;
    sizeBytes: number;
    historyBytes: number;
    measuredAt: number;
}
/** Items of a kind made in one hour and deleted in another (null: live). */
export interface LifetimeFact {
    kind: 'datasets' | 'files' | 'attachments' | 'apps';
    createdAt: number;
    deletedAt: number | null;
    items: number;
    bytes: number;
}
export interface OwnerFilesFact {
    ownerId: string;
    files: number;
    bytes: number;
    largest: number;
}
export interface DatabaseFact {
    bytes: number;
    freeBytes: number;
    agentRunsBytes: number | null;
    measuredAt: number;
}

/** What `storageOf` needs, read whole from the store. */
export interface StorageFacts {
    datasets: readonly DatasetFact[];
    days: readonly DatasetDayFact[];
    lifetimes: readonly LifetimeFact[];
    owners: readonly OwnerFilesFact[];
    database: DatabaseFact | null;
}

/** A search timing in ms, as `page_search_daily` gives it to operators. */
export function searchTimings(histogram: Record<number, number>, maxMs: number | null) {
    const at = (p: number) => {
        const value = percentile(histogram, p);
        return value === null || maxMs === null ? null : Math.min(value, maxMs);
    };
    return { p50: at(50), p95: at(95) };
}

/** The store keeps a day's slowest search in whole microseconds. */
export const storedMs = (ms: number) => Math.round(ms * 1000) / 1000;

/**
 * Bytes stored now and over a window (CB-191), from the store's
 * snapshots: datasets and their row history from their sizes per day
 * (each dataset counts its latest measurement before a moment, until it
 * is deleted), the other kinds from their items' lifetimes (to the
 * hour). A point is the total at its bucket's end, or the window's.
 */
export function storageOf(facts: StorageFacts, window: OpsWindow): OpsStorage {
    const deltas: { kind: OpsStorageKind; at: number; delta: number }[] = [];
    for (const row of facts.lifetimes) {
        if (row.kind === 'datasets') {
            continue;
        }
        deltas.push({ kind: row.kind, at: row.createdAt, delta: row.bytes });
        if (row.deletedAt !== null) {
            deltas.push({ kind: row.kind, at: row.deletedAt, delta: -row.bytes });
        }
    }
    const gone = new Map(facts.datasets.map((dataset) => [dataset.id, dataset.deletedAt]));
    const level = new Map<string, { size: number; history: number }>();
    const levels = [
        ...facts.days.map((day) => ({
            id: day.datasetId,
            at: day.measuredAt,
            size: day.sizeBytes,
            history: day.historyBytes,
            deletion: false,
        })),
        ...facts.datasets
            .filter((dataset) => dataset.deletedAt !== null)
            .map((dataset) => ({
                id: dataset.id,
                at: dataset.deletedAt!,
                size: 0,
                history: 0,
                deletion: true,
            })),
    ].sort((a, b) => a.at - b.at || Number(a.deletion) - Number(b.deletion));
    for (const change of levels) {
        const deletedAt = gone.get(change.id);
        // Measured after it was deleted, or a dataset the store doesn't hold.
        if (deletedAt === undefined) {
            continue;
        }
        if (deletedAt !== null && change.at > deletedAt) {
            continue;
        }
        const was = level.get(change.id) ?? { size: 0, history: 0 };
        deltas.push(
            { kind: 'datasets', at: change.at, delta: change.size - was.size },
            { kind: 'history', at: change.at, delta: change.history - was.history },
        );
        level.set(change.id, { size: change.size, history: change.history });
    }
    deltas.sort((a, b) => a.at - b.at);

    const start = window.from ?? deltas[0]?.at ?? null;
    const starts = start === null ? [] : bucketStarts(start, window.to, window.bucket, window.timeZone);
    const totals = new Map<OpsStorageKind, number>(OPS_STORAGE_KINDS.map((kind) => [kind, 0]));
    const points = new Map<OpsStorageKind, { at: number; value: number }[]>(
        OPS_STORAGE_KINDS.map((kind) => [kind, []]),
    );
    let next = 0;
    for (const at of starts) {
        const end = Math.min(nextBucket(at, window.bucket, window.timeZone), window.to);
        while (next < deltas.length && deltas[next]!.at < end) {
            const { kind, delta } = deltas[next++]!;
            totals.set(kind, totals.get(kind)! + delta);
        }
        for (const kind of OPS_STORAGE_KINDS) {
            points.get(kind)!.push({ at, value: totals.get(kind)! });
        }
    }

    const live = facts.datasets.filter((dataset) => dataset.deletedAt === null);
    const deleted = facts.datasets.filter((dataset) => dataset.deletedAt !== null);
    const sum = <T>(list: readonly T[], value: (item: T) => number) =>
        list.reduce((total, item) => total + value(item), 0);
    const fromLifetimes = (kind: LifetimeFact['kind']): OpsStorageNow => {
        const rows = facts.lifetimes.filter((row) => row.kind === kind);
        const now = rows.filter((row) => row.deletedAt === null);
        const kept = rows.filter((row) => row.deletedAt !== null);
        return {
            kind,
            items: sum(now, (row) => row.items),
            bytes: sum(now, (row) => row.bytes),
            deletedItems: sum(kept, (row) => row.items),
            deletedBytes: sum(kept, (row) => row.bytes),
        };
    };
    const withHistory = (list: readonly DatasetFact[]) => list.filter((dataset) => dataset.historyBytes > 0);
    const kinds: OpsStorageNow[] = [
        {
            kind: 'datasets',
            items: live.length,
            bytes: sum(live, (dataset) => dataset.sizeBytes),
            deletedItems: deleted.length,
            deletedBytes: sum(deleted, (dataset) => dataset.sizeBytes),
        },
        {
            kind: 'history',
            items: withHistory(live).length,
            bytes: sum(live, (dataset) => dataset.historyBytes),
            deletedItems: withHistory(deleted).length,
            deletedBytes: sum(deleted, (dataset) => dataset.historyBytes),
        },
        fromLifetimes('files'),
        fromLifetimes('attachments'),
        fromLifetimes('apps'),
    ];

    // Each person's quota use: live datasets (sizes) and files (as stored).
    const owners = new Map<string, { bytes: number; datasets: number }>();
    const owner = (id: string) => {
        let found = owners.get(id);
        if (!found) {
            owners.set(id, (found = { bytes: 0, datasets: 0 }));
        }
        return found;
    };
    for (const dataset of live) {
        const use = owner(dataset.ownerId);
        use.bytes += dataset.sizeBytes;
        // Scratch datasets don't count toward the number allowed.
        if (!dataset.scratch) {
            use.datasets++;
        }
    }
    for (const files of facts.owners) {
        owner(files.ownerId).bytes += files.bytes;
    }

    return {
        kinds,
        database: facts.database,
        series: OPS_STORAGE_KINDS.map((kind) => ({
            kind,
            points: points.get(kind)!,
        })),
        owners: [...owners.values()].sort((a, b) => b.bytes - a.bytes || b.datasets - a.datasets),
        largestDatasetBytes: live.reduce((most, dataset) => Math.max(most, dataset.sizeBytes), 0),
        largestFileBytes: facts.owners.reduce((most, files) => Math.max(most, files.largest), 0),
    };
}
