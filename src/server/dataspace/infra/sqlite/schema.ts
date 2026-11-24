import { primaryKey, sqliteTable } from 'drizzle-orm/sqlite-core';

import { enumText, id, int, json, ms, str } from '@socio/data/columns.sqlite';
import type { StorageDriver } from '@socio/data/object-store';
import type { GrantAccess } from '@socio/shared/data-types';
import type { FieldSettingsValues } from '@socio/shared/dataset-views/field-settings';

/**
 * The data space tables on the new data layer (CB-110), as
 * `dataspace/migrations.ts` makes them: the typed mirror the repositories
 * query. The migrations stay the source of truth;
 * tests/dataspace-repositories.test.ts holds these to them. Defaults (an
 * empty description, zero sizes, `local` storage, the `legacy` seal key)
 * are the migrations'; the repositories write every column.
 */

export const dataDatasets = sqliteTable('data_datasets', {
    id: id().primaryKey(),
    ownerUserId: str().notNull(),
    name: str().notNull(),
    description: str().notNull(),
    createdByDotId: str(),
    scratchForDotId: str(),
    dotDeletedAt: ms(),
    sharedSpaceId: str(),
    retentionDays: int(),
    sizeBytes: int().notNull(),
    tableCount: int().notNull(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
    deletedAt: ms(),
    deletedBy: str(),
    deletedWith: str(),
    historyBytes: int().notNull(),
    historyDays: int(),
    compactRequestedAt: ms(),
    analyticalBytes: int().notNull(),
    spaceParentId: str(),
    spacePosition: str(),
    spaceAddedAt: ms(),
});

export const dataGrants = sqliteTable('data_grants', {
    id: id().primaryKey(),
    ownerUserId: str().notNull(),
    dotId: str().notNull(),
    datasetId: str(),
    folder: str(),
    access: enumText(['read', 'write']).$type<GrantAccess>().notNull(),
    createdBy: str().notNull(),
    createdAt: ms().notNull(),
});

export const dataFiles = sqliteTable('data_files', {
    id: id().primaryKey(),
    ownerUserId: str().notNull(),
    path: str().notNull(),
    size: int().notNull(),
    storedSize: int().notNull(),
    mediaType: str().notNull(),
    createdByDotId: str(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
    storage: str().$type<StorageDriver>().notNull(),
    name: str(),
    deletedAt: ms(),
    deletedBy: str(),
    deletedWith: str(),
    sealKey: str().notNull(),
});

export const dataAudit = sqliteTable('data_audit', {
    id: id().primaryKey(),
    ownerUserId: str().notNull(),
    actorKind: str().notNull(),
    actorId: str(),
    dotId: str(),
    datasetId: str(),
    target: str(),
    action: str().notNull(),
    outcome: str().notNull(),
    detail: str(),
    createdAt: ms().notNull(),
    area: str(),
    threadId: str(),
    byUserId: str(),
});

export const dataDatasetDays = sqliteTable(
    'data_dataset_days',
    {
        datasetId: id().notNull(),
        day: int().notNull(),
        sizeBytes: int().notNull(),
        historyBytes: int().notNull(),
        tableCount: int().notNull(),
        measuredAt: ms().notNull(),
    },
    (table) => [primaryKey({ columns: [table.datasetId, table.day] })],
);

/** Plugin needs bound to workspace datasets (CB-451); a binding ends, never goes. */
export const dataPluginBindings = sqliteTable('data_plugin_bindings', {
    id: id().primaryKey(),
    pluginId: str().notNull(),
    need: str().notNull(),
    datasetId: str().notNull(),
    access: enumText(['read', 'write']).$type<GrantAccess>().notNull(),
    boundBy: str().notNull(),
    boundAt: ms().notNull(),
    unboundAt: ms(),
});

/** Admins' data API tokens: by hash only, revoked ones kept. */
export const dataApiTokens = sqliteTable('data_api_tokens', {
    id: id().primaryKey(),
    name: str().notNull(),
    hint: str().notNull(),
    hash: str().notNull(),
    scopes: json<string[]>().notNull(),
    statementsPerMinute: int().notNull(),
    createdBy: str().notNull(),
    createdAt: ms().notNull(),
    expiresAt: ms().notNull(),
    lastUsedAt: ms(),
    uses: int().notNull(),
    revokedAt: ms(),
    revokedBy: str(),
});

/** An admin's data operation budget for one plugin's token (CB-473). */
export const dataPluginBudgets = sqliteTable('data_plugin_budgets', {
    pluginId: str().primaryKey(),
    statementsPerMinute: int().notNull(),
    setBy: str().notNull(),
    setAt: ms().notNull(),
});

/**
 * Columns' field settings (CB-451): kind, label and kind-specific
 * settings per dataset table and column, versioned for saves.
 */
export const dataFieldSettings = sqliteTable(
    'data_field_settings',
    {
        datasetId: id().notNull(),
        tableName: str().notNull(),
        columnName: str().notNull(),
        kind: str().notNull(),
        label: str(),
        settings: json<FieldSettingsValues>().notNull(),
        version: int().notNull(),
        declaredBy: str(),
        updatedBy: str().notNull(),
        updatedAt: ms().notNull(),
    },
    (table) => [primaryKey({ columns: [table.datasetId, table.tableName, table.columnName] })],
);

/** Every table the data space's migrations make, for the drift test. */
export const dataTables = [
    dataDatasets,
    dataGrants,
    dataFiles,
    dataAudit,
    dataDatasetDays,
    dataPluginBindings,
    dataPluginBudgets,
    dataFieldSettings,
    dataApiTokens,
] as const;
