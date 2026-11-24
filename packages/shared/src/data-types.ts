import type { AnalyticalTableStats, TableKind } from './dataspace/analytics.js';

export type { AnalyticalTableStats, TableKind } from './dataspace/analytics.js';

/**
 * The owner id of a company socio's shared area (CB-224), `socio:<id>`: the
 * dataset and files its computer reaches, which are no person's. No user
 * id may start with it.
 */
export const SOCIO_OWNER_PREFIX = 'socio:';
/** Whether an id is kept for socios' shared areas (never a user's). */
export const reservedUserId = (id: string) => id.startsWith(SOCIO_OWNER_PREFIX);
/** How reports name a socio's shared area. */
export const sharedAreaLabel = (socioName: string | null | undefined) =>
    `${socioName ?? 'A deleted socio'} (shared computer)`;
/**
 * The owner id of a service plugin's datasets, `plugin:<pluginId>`: the
 * datasets its manifest declares (`datasets`), which are the company's, not
 * a person's, as a company socio's area is. No user id may start with it.
 */
export const PLUGIN_OWNER_PREFIX = 'plugin:';
export const pluginOwnerId = (pluginId: string) => `${PLUGIN_OWNER_PREFIX}${pluginId}`;
/** Whether an owner id is a plugin's (`plugin:<id>`), never a user's. */
export const isPluginOwner = (id: string) => id.startsWith(PLUGIN_OWNER_PREFIX);
/** The plugin a `plugin:<id>` owner id names; undefined for any other owner. */
export const pluginOfOwner = (id: string) => (isPluginOwner(id) ? id.slice(PLUGIN_OWNER_PREFIX.length) : undefined);
/**
 * The workspace's own datasets (CB-451): plugin datasets are
 * allocated by the workspace, owned by this reserved owner, and bound to
 * the plugins that read or write them (`data_plugin_bindings`). Outside
 * every person's quota, transfer and purge. Its `ws:` prefix can't be a
 * person's: user ids are lowercase letters, digits, `_` and `-` only, and
 * every place that takes one refuses a non-person owner id as well.
 */
export const WORKSPACE_OWNER_PREFIX = 'ws:';
export const WORKSPACE_OWNER_ID = `${WORKSPACE_OWNER_PREFIX}workspace`;
/** Whether an owner id is the workspace's (`ws:…`). */
export const isWorkspaceOwner = (id: string) => id.startsWith(WORKSPACE_OWNER_PREFIX);
/**
 * Whether a dataset's owner is the company rather than a person or a
 * socio's area: the workspace's datasets, and a plugin's from before
 * CB-451 (`plugin:<id>`, which the boot step moves to the workspace).
 * Admins manage them.
 */
export const isCompanyOwner = (id: string) => isWorkspaceOwner(id) || isPluginOwner(id);
/**
 * Whether an id is kept for an owner that is no person: a company socio's
 * shared area (`socio:`), a plugin (`plugin:`) or the workspace
 * (`ws:`). User ids never are one.
 */
export const nonPersonOwnerId = (id: string) => reservedUserId(id) || isCompanyOwner(id);

/**
 * The user's data space: datasets (one SQLite file each),
 * files (encrypted at rest), grants to Dots, audit, quotas.
 */

/** Column types a Dot may declare; SQLite keeps them as declared. */
export const COLUMN_TYPES = ['TEXT', 'INTEGER', 'REAL', 'NUMERIC', 'BLOB', 'BOOLEAN', 'DATETIME', 'JSON'] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

/** Retention choices, in days; null keeps a dataset until it is deleted. */
export const RETENTION_DAYS = [7, 30, 90, 365] as const;
/** How long row history may be kept, in days (CB-369); null keeps all of it. */
export const HISTORY_DAYS = [7, 30, 90, 365] as const;

export type DatasetKind = 'scratch' | 'dataset';
export type GrantAccess = 'read' | 'write';

export interface DatasetView {
    id: string;
    name: string;
    description: string;
    kind: DatasetKind;
    ownerUserId: string;
    /** The owner's name, for datasets other users shared with a Space. */
    ownerName?: string;
    createdByDotId: string | null;
    /** For scratch datasets: the Dot it belongs to. */
    scratchForDotId: string | null;
    dotName?: string | null;
    /** The scratch Dot was deleted; the data stays until the user deletes it. */
    fromDeletedDot: boolean;
    sharedSpaceId: string | null;
    /** Its parent page in that Space, or null at its root (CB-451); absent from older servers. */
    spaceParentId?: string | null;
    retentionDays: number | null;
    sizeBytes: number;
    /** Its row history's bytes, which no quota counts (CB-369); for its owner. */
    historyBytes?: number;
    /** Days its row history is kept; null keeps all of it (CB-369); for its owner. */
    historyDays?: number | null;
    /** When its owner asked to compact its file at the next nightly run (CB-369). */
    compactRequestedAt?: number | null;
    /** Its analytical tables' bytes on disk (CB-369), which no person's quota counts. */
    analyticalBytes?: number;
    tableCount: number;
    createdAt: number;
    updatedAt: number;
    /**
     * What the viewer may do: their own, read-only (shared with a Space), or
     * a company socio's shared dataset, whose tables and rows they may
     * delete (CB-229). An admin manages a plugin's datasets as `owner`.
     */
    access: 'owner' | 'read' | 'shared';
    /**
     * The service plugin that writes it (CB-451): its live `write` binding's
     * plugin, or a `plugin:<id>` owner from before. Nobody else writes it.
     */
    plugin?: { id: string; name: string };
    /** A workspace dataset with no writer now: the plugin whose write binding ended last (uninstalled, rebound). */
    wasWrittenBy?: { id: string; name: string };
    /** Plugins bound to read it (CB-451), for the admins who manage it. */
    readers?: Array<{ id: string; name: string }>;
}

export interface ColumnInfo {
    name: string;
    type: string;
    notNull: boolean;
    primaryKey: boolean;
    defaultValue: string | null;
}
/**
 * A secondary index declared on a table (CB-355): its columns in order,
 * and whether it is unique. Not the automatic ones of PRIMARY KEY and
 * UNIQUE columns.
 */
export interface IndexInfo {
    name: string;
    columns: string[];
    unique: boolean;
}
export interface TableInfo {
    name: string;
    columns: ColumnInfo[];
    rowCount: number;
    /** Its declared secondary indexes (CB-355); a reader from before them has none. */
    indexes?: IndexInfo[];
    /**
     * Whether it keeps row history now (CB-369): false for a table made
     * with `history: false` or switched off. Absent from older servers.
     */
    history?: boolean;
    /** `analytical` for an append-only Parquet table (CB-369); absent: transactional. */
    kind?: TableKind;
    /** An analytical table's parts, bytes and partitions (CB-369). */
    analytical?: AnalyticalTableStats;
}
export interface DatasetDetail {
    dataset: DatasetView;
    tables: TableInfo[];
}

export type CellValue = string | number | boolean | null | { $blob: string };
export interface QueryResult {
    columns: string[];
    rows: CellValue[][];
    /** More rows (or bytes) than the caps allowed were left out. */
    truncated: boolean;
    ms: number;
}
export interface RowsPage extends QueryResult {
    table: string;
    offset: number;
    limit: number;
    total: number;
    /**
     * Each row's rowid, for a socio's shared dataset (CB-229), whose rows
     * the viewer may delete; left out for a table without rowids.
     */
    rowids?: number[];
}

export interface GrantView {
    id: string;
    dotId: string;
    dotName: string;
    datasetId: string | null;
    datasetName: string | null;
    folder: string | null;
    access: GrantAccess;
    createdBy: string;
    createdAt: number;
}

export interface DataFileView {
    path: string;
    size: number;
    mediaType: string;
    createdByDotId: string | null;
    createdAt: number;
    updatedAt: number;
}

export interface DataAuditEntry {
    id: string;
    actorKind: 'user' | 'dot' | 'token' | 'system' | 'plugin';
    actorId: string | null;
    dotId: string | null;
    dotName?: string | null;
    datasetId: string | null;
    target: string | null;
    action: string;
    outcome: 'ok' | 'denied' | 'error' | 'pending';
    detail: string | null;
    createdAt: number;
}

export interface DataLimitsView {
    datasetMaxBytes: number;
    userMaxBytes: number;
    fileMaxBytes: number;
    maxDatasets: number;
    queryTimeoutMs: number;
    queryMaxRows: number;
    queryMaxBytes: number;
    statementsPerMinute: number;
    insertMaxRows: number;
    /**
     * Days an item in a company socio's shared area is kept without changes
     * (CB-229); 0 keeps it until someone deletes it.
     */
    sharedRetentionDays: number;
    /** What one service plugin's dataset may grow to (its own quota, no person's). */
    pluginDatasetMaxBytes: number;
    /** The most rows one query of a plugin's dataset returns. */
    pluginQueryMaxRows: number;
    /**
     * Data operations a minute for each plugin's data token (CB-473), apart
     * from `statementsPerMinute`, which people's socios and tokens keep. An
     * admin raises it for one plugin on its page. Optional: an older server
     * sends none.
     */
    pluginStatementsPerMinute?: number;
    /** The most statements in one batch (`POST …/batch`, `POST …/read-batch`). */
    batchMaxStatements: number;
    /** How long one batch may run before its process is stopped and it rolls back. */
    batchTimeoutMs: number;
    /**
     * Analytical tables (CB-369). Optional: a server from before them sends
     * none. Bytes of live Parquet parts one owner (a person, a socio's
     * area, a plugin) may keep, apart from `userMaxBytes`.
     */
    analyticalMaxBytes?: number;
    /** How long one analytical query may run. */
    analyticsQueryTimeoutMs?: number;
    /** The most rows, and bytes, one analytical query returns. */
    analyticsQueryMaxRows?: number;
    analyticsQueryMaxBytes?: number;
    /** DuckDB's memory and threads for one analytical query, and its spill space. */
    analyticsQueryMemoryMb?: number;
    analyticsThreads?: number;
    analyticsQueryTempMb?: number;
    /** The most rows, and bytes, of transactional tables one analytical query loads. */
    analyticsJoinMaxRows?: number;
    analyticsJoinMaxBytes?: number;
    /** Analytical queries at a time in the analytics process. */
    analyticsQueryConcurrency?: number;
    /** The most rows, and request bytes, one append takes. */
    appendMaxRows?: number;
    appendMaxBytes?: number;
    /**
     * Days an analytical table keeps its partitions when neither an admin's
     * override nor its plugin sets a retention (CB-387); 0 keeps everything.
     */
    analyticalRetainDays?: number;
    /**
     * Days a deleted row's stamp is kept for changes reads (CB-451): a
     * cache whose last sync is older reconciles. `DATA_STAMP_TOMBSTONE_DAYS`.
     */
    stampTombstoneDays?: number;
}
/**
 * One plugin's data operation budget (CB-473): what its data token may make
 * a minute, an admin's override for it (null: none), and the workspace's
 * plugin default it falls back to (Settings over
 * `DATA_PLUGIN_STATEMENTS_PER_MINUTE`).
 */
export interface PluginDataBudget {
    pluginId: string;
    statementsPerMinute: number;
    override: number | null;
    workspaceDefault: number;
    /** The most an override may be. */
    max: number;
    /** Who set the override, and when. */
    setBy?: string;
    setAt?: number;
}
export interface DataUsageView {
    userId: string;
    userName?: string;
    datasets: number;
    datasetBytes: number;
    files: number;
    fileBytes: number;
    totalBytes: number;
    /**
     * Operators only (`usageAll`, CB-64): what the user deleted, which is
     * kept and doesn't count against their quota.
     */
    deletedDatasets?: number;
    deletedFiles?: number;
    deletedBytes?: number;
    /**
     * Operators only (`usageAll`): the row history kept in the user's dataset
     * files, not counted against their quota.
     */
    historyBytes?: number;
}
export interface DataUsageState {
    limits: DataLimitsView;
    /** Without `userId` for a data token (CB-224). */
    own: Omit<DataUsageView, 'userId'> & { userId?: string };
    /** Operators only: every user's usage. */
    all?: DataUsageView[];
}

export interface DataSpaceState {
    datasets: DatasetView[];
    grants: GrantView[];
    /** Left out when asked (`?files=false`): Media lists files. */
    files?: DataFileView[];
    usage: DataUsageState;
    /** The company socios' shared areas this person may see (CB-229). */
    shared?: SharedAreaView[];
}

/**
 * Who put an item in a company socio's shared area, and when (CB-229), from
 * the data audit: the person whose turn or command did it, and how. `by`
 * is null when the audit doesn't say (the platform itself, or an item from
 * before the audit marked the area).
 */
export interface SharedOrigin {
    by: string | null;
    via: 'computer' | 'chat' | 'app' | 'system';
    at: number;
}
export interface SharedTableView {
    name: string;
    rowCount: number;
    /** The table and its indexes, row history left out. */
    sizeBytes: number;
    created: SharedOrigin | null;
    changed: SharedOrigin | null;
}
export interface SharedFileView {
    /** Its path in the area: `shared/<path>` in a chat, `<path>` on the computer. */
    path: string;
    size: number;
    mediaType: string;
    updatedAt: number;
    added: SharedOrigin | null;
}
/**
 * A company socio's shared area (CB-224, CB-229): the dataset and files its
 * computer reaches, which are no person's. Shown to the people who have
 * used the socio, and to admins.
 */
export interface SharedAreaView {
    dotId: string;
    /** Null: the socio was deleted. */
    dotName: string | null;
    archived: boolean;
    dataset: {
        id: string;
        name: string;
        sizeBytes: number;
        updatedAt: number;
        tables: SharedTableView[];
    } | null;
    files: SharedFileView[];
    totalBytes: number;
    /** In force for every shared area; 0 keeps items until deleted. */
    retentionDays: number;
}
