import type { GrantAccess } from '@socio/shared/data-types';
import type { FieldSettingsValues } from '@socio/shared/dataset-views/field-settings';

import type { Dataset, DeletedStamp, FileRepository } from '../contract.js';

/**
 * The data space's repositories (CB-110): one per aggregate,
 * taking and returning plain domain types; only `dataspace/infra`
 * implements them. Async writes work inside or outside a unit of work:
 * outside one they open their own.
 *
 * Methods named `…Now` are synchronous: they run at once on the connection,
 * in the caller's transaction if one is open, exactly as the raw statements
 * they replaced did. They serve the data space's synchronous calls (a
 * socio's scratch dataset made on first sight, dataset and grant changes,
 * forgetting a deleted socio), which callers outside this module (mini
 * app promotion, page tools, views) make without waiting. Records nothing
 * reads back at once (`recordSizes`, the audit) are written soon, as
 * `writeSoon` writes them.
 */

/** What a new dataset starts with: empty, unshared, kept. */
export type NewDataset = Pick<
    Dataset,
    'id' | 'ownerUserId' | 'name' | 'description' | 'createdByDotId' | 'scratchForDotId' | 'createdAt' | 'updatedAt'
>;

/** A dataset's sizes as a write measured them. */
export interface DatasetSizes {
    sizeBytes: number;
    historyBytes: number;
    tableCount: number;
}

/** The settings its owner changes. */
export type DatasetSettings = Pick<Dataset, 'name' | 'description' | 'retentionDays' | 'sharedSpaceId'> &
    Pick<Dataset, 'historyDays'> &
    Partial<DatasetPlacement>;

/** Where a dataset sits in its Space (CB-451). */
export type DatasetPlacement = Pick<Dataset, 'spaceParentId' | 'spacePosition' | 'spaceAddedAt'>;

/** Dataset metadata. Its writes are the data space's synchronous ones. */
export interface DatasetRepository {
    insertNow(dataset: NewDataset): void;
    /**
     * A Dot's scratch dataset, unless its owner has a live one for that Dot
     * already (two first uses at once); whether this one was made.
     */
    insertScratchNow(dataset: NewDataset): boolean;
    updateNow(id: string, settings: DatasetSettings): void;
    /** Its live analytical parts' bytes after an append (CB-369), and its change time. */
    recordAnalyticalBytesNow(id: string, bytes: number, at: number): void;
    /** Asks for (a time) or clears (null) a compaction at the next nightly run (CB-369). */
    requestCompactNow(id: string, at: number | null): void;
    /** Clears the compaction request made at `at`, and no newer one. */
    clearCompactNow(id: string, at: number): void;
    /** Its sizes after maintenance, leaving its change time as it was (CB-369). */
    recordSizesNow(id: string, sizes: DatasetSizes): void;
    /** Its sizes and change time, written soon (never awaited). */
    recordSizes(id: string, sizes: DatasetSizes, at: number): void;
    /** Hides a live one (CB-64); a deleted one keeps its stamp. */
    markDeletedNow(id: string, stamp: DeletedStamp): void;
    /** Removes the row: only a dataset a failed move half made. */
    removeNow(id: string): void;
    /** Gives a dataset of `from` to `to` (CB-451's move of plugin datasets to the workspace); whether it moved. */
    moveOwnerNow(id: string, from: string, to: string): boolean;
    /**
     * Moves the live datasets of `spaceId` placed under any of `pageIds` to
     * `parentId` (CB-451: their pages were deleted or left the Space),
     * keeping their keys, so their order among themselves; how many.
     */
    reparentNow(spaceId: string, pageIds: readonly string[], parentId: string | null): number;
    /** Marks a deleted Dot's scratch datasets, once; how many. */
    markDotDeletedNow(dotId: string, at: number): number;
}

/** A Dot's access to one of its user's datasets or folders: one, never both. */
export interface DataGrant {
    id: string;
    ownerUserId: string;
    dotId: string;
    datasetId: string | null;
    folder: string | null;
    access: GrantAccess;
    createdBy: string;
    createdAt: number;
}

/** A folder grant a folder move carried (CB-65). */
export interface MovedGrant extends DataGrant {
    folder: string;
    /** Where it went. */
    to: string;
    /** The access of the Dot's grant already there, which it merged into. */
    mergedInto?: GrantAccess;
}

export interface GrantRepository {
    /**
     * Grants `grant`'s access on its target: the Dot's grant there already
     * keeps its id and creation time and takes the access and `createdBy`;
     * else `grant` is added. The grant's id.
     */
    setNow(grant: DataGrant): string;
    /** Ends a dataset's grants; the ones that ended. */
    removeForDatasetNow(datasetId: string): DataGrant[];
    /** Moves a dataset's grants to its new owner (CB-451), keeping them as they are. */
    moveDatasetOwnerNow(datasetId: string, to: string): void;
    /** Ends a deleted Dot's grants; the users they were from, each once. */
    removeForDotNow(dotId: string): string[];
    /** Ends one of a user's grants; undefined when there is none. */
    remove(ownerUserId: string, id: string): Promise<DataGrant | undefined>;
    /**
     * Moves the folder grants on `from` and its subfolders under `to`,
     * by folder. One that lands where the Dot has a grant already merges
     * into it, which keeps its access.
     */
    moveFolders(ownerUserId: string, from: string, to: string): Promise<MovedGrant[]>;
    /** Ends the folder grants on `folder` and its subfolders; those, by folder. */
    removeUnder(ownerUserId: string, folder: string): Promise<Array<DataGrant & { folder: string }>>;
}

/** One line of the data audit: who did what to which data, and how it went. */
export interface DataAuditRecord {
    id: string;
    /** The user whose data it is (a shared area's owner too). */
    ownerUserId: string;
    actorKind: 'user' | 'dot' | 'token' | 'system' | 'plugin';
    actorId: string | null;
    dotId: string | null;
    datasetId: string | null;
    target: string | null;
    action: string;
    outcome: 'ok' | 'denied' | 'error' | 'pending';
    detail: string | null;
    createdAt: number;
    /** The company socio's shared area it is about (CB-229). */
    area: string | null;
    /** The chat a socio's tool acted in (CB-194). */
    threadId: string | null;
    /** A data API token's line: the admin who made the token. */
    byUserId: string | null;
}

/** The data audit: written soon, in order, never making the action wait. */
export interface DataAuditLog {
    record(entry: DataAuditRecord): void;
}

/** A plugin need bound to a workspace dataset (CB-451); live while `unboundAt` is null. */
export interface PluginBinding {
    id: string;
    pluginId: string;
    /** The need's name in the plugin's manifest. */
    need: string;
    datasetId: string;
    access: GrantAccess;
    /** Who bound it: an admin's id, or `system` for an automatic binding. */
    boundBy: string;
    boundAt: number;
    unboundAt: number | null;
}

/**
 * Plugin needs' bindings (CB-451). Synchronous, as the install, update and
 * token paths that read and write them are. The unique indexes hold one
 * live writer per dataset and one live binding per need.
 */
export interface PluginBindingRepository {
    /** Adds a live binding; throws when the dataset already has a live writer or the need a live binding. */
    bindNow(binding: Omit<PluginBinding, 'unboundAt'>): void;
    /** Ends one live binding; whether it was live. */
    unbindNow(id: string, at: number): boolean;
    /** The plugin's live bindings, oldest first. */
    liveForPlugin(pluginId: string): PluginBinding[];
    /** A dataset's live bindings, oldest first. */
    liveForDataset(datasetId: string): PluginBinding[];
    /** Every live binding, oldest first. */
    live(): PluginBinding[];
    /** Whether any binding, live or ended, ever named the dataset. */
    everBound(datasetId: string): boolean;
    /** The plugin's bindings that ended, newest first. */
    endedForPlugin(pluginId: string): PluginBinding[];
    /** The newest ended write binding of each dataset in `ids` with no live writer. */
    lastWriters(ids: readonly string[]): Map<string, PluginBinding>;
}

/** An admin's data operation budget for one plugin's token (CB-473). */
export interface PluginBudget {
    pluginId: string;
    statementsPerMinute: number;
    /** The admin who set it. */
    setBy: string;
    setAt: number;
}

/** Plugins' budgets (CB-473): a row only while an admin's override is set. */
export interface PluginBudgetRepository {
    get(pluginId: string): PluginBudget | undefined;
    /** Sets or replaces the plugin's override. */
    set(budget: PluginBudget): void;
    /** Clears it; whether there was one. */
    clear(pluginId: string): boolean;
}

/** A column's field setting (CB-451), as `data_field_settings` keeps it. */
export interface FieldSettingRow {
    datasetId: string;
    tableName: string;
    columnName: string;
    kind: string;
    label: string | null;
    settings: FieldSettingsValues;
    /** 1 when first saved, one more on every save. */
    version: number;
    /** The plugin whose manifest set it, until a person saves it. */
    declaredBy: string | null;
    /** A user id, or `plugin:<id>` for a manifest's. */
    updatedBy: string;
    updatedAt: number;
}

/**
 * Field settings (CB-451). Synchronous, as the reads that check specs
 * and the install path are. Table and column names match without regard
 * to case, as SQLite's do.
 */
export interface FieldSettingRepository {
    /** A table's settings, orphaned ones too, in the order they were first saved. */
    forTable(datasetId: string, table: string): FieldSettingRow[];
    get(datasetId: string, table: string, column: string): FieldSettingRow | undefined;
    /**
     * Saves one setting if it is still at `baseVersion` (0: none saved),
     * at `baseVersion + 1`; whether it saved. Never overwrites a newer one.
     */
    saveNow(row: Omit<FieldSettingRow, 'version'>, baseVersion: number): boolean;
}

/** An admin's data API token, as `data_api_tokens` keeps it: never its value. */
export interface DataApiTokenRow {
    id: string;
    name: string;
    hint: string;
    hash: string;
    scopes: string[];
    statementsPerMinute: number;
    createdBy: string;
    createdAt: number;
    expiresAt: number;
    lastUsedAt: number | null;
    uses: number;
    revokedAt: number | null;
    revokedBy: string | null;
}

/** Data API tokens. Synchronous: the request's check reads one at once. */
export interface DataApiTokenRepository {
    insertNow(row: DataApiTokenRow): void;
    byHash(hash: string): DataApiTokenRow | undefined;
    byId(id: string): DataApiTokenRow | undefined;
    /** Every token, newest first. */
    all(): DataApiTokenRow[];
    /** Revokes a live one; whether it was live (not revoked before). */
    revokeNow(id: string, at: number, by: string): boolean;
    /** Revokes every live token this person made; the rows it revoked. */
    revokeMadeByNow(createdBy: string, at: number, by: string): DataApiTokenRow[];
    /** Adds requests to its count and its last use, soon. */
    recordUse(id: string, at: number, requests: number): void;
}

export interface DataSpaceRepositories {
    datasets: DatasetRepository;
    grants: GrantRepository;
    files: FileRepository;
    audit: DataAuditLog;
    bindings: PluginBindingRepository;
    budgets: PluginBudgetRepository;
    fields: FieldSettingRepository;
    apiTokens: DataApiTokenRepository;
}
