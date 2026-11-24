/**
 * What the Knowledge and Capabilities ETL reads from the system of record
 * (CB-191), beside CB-187's `SourceReader`: Space pages, their edits and
 * use, search timings, dataset access and sizes, stored bytes and
 * capability requests. Each method is one short read: a batch of at most
 * `ETL_BATCH` rows, a small table whole, or an aggregate. Nothing here
 * writes, and no page text, revision body, query or request wording is
 * read: lengths and counts only.
 */

/** A live page's key, from the covering index (no page text is read). */
export interface SourcePageKey {
    /** SQLite's row key, which the details are read by. */
    rowKey: number;
    spaceId: string;
    updatedAt: number;
    title: string;
}

export interface SourcePage extends SourcePageKey {
    id: string;
    /** Its Markdown's length in characters. */
    chars: number;
    revision: number;
    createdAt: number;
    createdBy: string | null;
}

export interface SourcePageUse {
    pageId: string;
    usedAt: number;
}

/** An edit: the state it replaced, kept as a revision. */
export interface SourcePageEdit {
    id: number;
    pageId: string;
    spaceId: string;
    /** A person's id, `dot:<id>` for a socio's page tool, or null. */
    authorId: string | null;
    replacedAt: number;
}

/** A day of page search timings (`page_search_daily`), UTC. */
export interface SourceSearchDay {
    day: string;
    queries: number;
    empty: number;
    corrected: number;
    trigram: number;
    maxMs: number;
    /** JSON: timing bucket → count. */
    histogram: string;
}

/** One dataset access (`data_audit`), without its target or detail. */
export interface SourceDataAccess {
    id: string;
    createdAt: number;
    ownerUserId: string;
    actorKind: string;
    actorId: string | null;
    dotId: string | null;
    datasetId: string | null;
    action: string;
    outcome: string;
    /** The chat a socio's tool acted in (CB-194); null before data 10. */
    threadId: string | null;
}

export interface SourceDataset {
    id: string;
    ownerUserId: string;
    name: string;
    scratch: number;
    sizeBytes: number;
    historyBytes: number;
    tableCount: number;
    createdAt: number;
    updatedAt: number;
    deletedAt: number | null;
}

export interface SourceDatasetDay {
    rowKey: number;
    datasetId: string;
    day: number;
    sizeBytes: number;
    historyBytes: number;
    tableCount: number;
    measuredAt: number;
}

/**
 * Stored items of one kind, grouped by the hours they were made and
 * deleted (null: live): enough to say what was stored at any hour.
 */
export interface SourceLifetime {
    kind: 'datasets' | 'files' | 'attachments' | 'apps';
    createdAt: number;
    deletedAt: number | null;
    items: number;
    bytes: number;
}

/** A person's live files: what counts against their data space quota. */
export interface SourceOwnerFiles {
    ownerUserId: string;
    files: number;
    bytes: number;
    /** The largest file's own size, for the per-file limit. */
    largest: number;
}

export interface SourceDatabaseSize {
    bytes: number;
    freeBytes: number;
}

/** A capability request (`dot_requests`) and who asked, counted. */
export interface SourceRequest {
    issueId: string;
    number: number | null;
    title: string | null;
    status: string | null;
    capability: string;
    createdAt: number;
    requesters: number;
    socios: number;
    people: number;
    lastAt: number;
}

export interface KnowledgeSourceReader {
    /** Whether the app has made this table yet. */
    has(table: string): boolean;
    livePageKeys(): SourcePageKey[];
    pagesByKey(keys: readonly number[]): SourcePage[];
    pageUse(): SourcePageUse[];
    pageEditsAfter(id: number, limit: number): SourcePageEdit[];
    lastPageEditId(): number;
    searchDays(): SourceSearchDay[];
    /** Accesses after (`at`, `id`) and before `before`, oldest first. */
    dataAccessAfter(after: { at: number; id: string }, before: number, limit: number): SourceDataAccess[];
    datasets(): SourceDataset[];
    /** Day rows measured after (`at`, `rowKey`) and before `before`. */
    datasetDaysAfter(after: { at: number; rowKey: number }, before: number, limit: number): SourceDatasetDay[];
    lifetimes(): SourceLifetime[];
    ownerFiles(): SourceOwnerFiles[];
    /** Every socio's name, deleted ones too: a shared area's label (CB-224). */
    socioNames(): Array<{ id: string; name: string }>;
    databaseSize(): SourceDatabaseSize;
    /** One table's bytes with its indexes (`dbstat`): reads all its pages. */
    tableBytes(table: string): number;
    requests(): SourceRequest[];
}
