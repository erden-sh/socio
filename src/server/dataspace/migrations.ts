import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * The data space's metadata. The data itself is outside the app's
 * database: `USER_DATA_DIR/<user>/datasets/<id>.sqlite`, and encrypted
 * files in the object store (`storage`: the local disk's `files/<id>.bin`,
 * or S3 since CB-54), sealed under `sealKey`. A grant names a dataset or a folder, never both.
 */
export const dataSchema: SchemaSet = {
    id: MODULE_IDS.data,
    migrations: [
        {
            version: 1,
            name: 'data space',
            up: `CREATE TABLE data_datasets(id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', createdByDotId TEXT, scratchForDotId TEXT, dotDeletedAt INTEGER, sharedSpaceId TEXT, retentionDays INTEGER, sizeBytes INTEGER NOT NULL DEFAULT 0, tableCount INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE UNIQUE INDEX data_datasets_scratch ON data_datasets(ownerUserId, scratchForDotId) WHERE scratchForDotId IS NOT NULL;
      CREATE INDEX data_datasets_owner ON data_datasets(ownerUserId);
      CREATE TABLE data_grants(id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL, dotId TEXT NOT NULL, datasetId TEXT, folder TEXT, access TEXT NOT NULL CHECK(access IN ('read','write')), createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL, CHECK((datasetId IS NULL) <> (folder IS NULL)));
      CREATE UNIQUE INDEX data_grants_target ON data_grants(ownerUserId, dotId, COALESCE(datasetId, ''), COALESCE(folder, ''));
      CREATE TABLE data_files(id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, storedSize INTEGER NOT NULL, mediaType TEXT NOT NULL, createdByDotId TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, UNIQUE(ownerUserId, path));
      CREATE TABLE data_audit(id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL, actorKind TEXT NOT NULL, actorId TEXT, dotId TEXT, datasetId TEXT, target TEXT, action TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT, createdAt INTEGER NOT NULL);
      CREATE INDEX data_audit_owner ON data_audit(ownerUserId, createdAt);`,
        },
        {
            // CB-54: where each file's sealed bytes are ('local' | 's3') and the
            // original display name (null: the path's last segment). No digest of
            // the plaintext: it would tell equal files apart from the database
            // alone, and the seal already checks the bytes.
            version: 2,
            name: 'file storage',
            up: `ALTER TABLE data_files ADD COLUMN storage TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE data_files ADD COLUMN name TEXT;
      CREATE INDEX data_files_storage ON data_files(storage);`,
        },
        {
            // CB-64 pass 2: deleted datasets and files are hidden and kept, with
            // their bytes. A deleted file's path is free again: `data_files` is
            // rebuilt without its inline UNIQUE, which becomes a partial index
            // over live files; a deleted scratch dataset makes room for a new one.
            version: 3,
            name: 'soft delete',
            up: `ALTER TABLE data_datasets ADD COLUMN deletedAt INTEGER;
      ALTER TABLE data_datasets ADD COLUMN deletedBy TEXT;
      ALTER TABLE data_datasets ADD COLUMN deletedWith TEXT;
      DROP INDEX data_datasets_scratch;
      CREATE UNIQUE INDEX data_datasets_scratch ON data_datasets(ownerUserId, scratchForDotId) WHERE scratchForDotId IS NOT NULL AND deletedAt IS NULL;
      CREATE TABLE data_files_v3(id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, storedSize INTEGER NOT NULL, mediaType TEXT NOT NULL, createdByDotId TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, storage TEXT NOT NULL DEFAULT 'local', name TEXT, deletedAt INTEGER, deletedBy TEXT, deletedWith TEXT);
      INSERT INTO data_files_v3(id, ownerUserId, path, size, storedSize, mediaType, createdByDotId, createdAt, updatedAt, storage, name) SELECT id, ownerUserId, path, size, storedSize, mediaType, createdByDotId, createdAt, updatedAt, storage, name FROM data_files;
      DROP TABLE data_files;
      ALTER TABLE data_files_v3 RENAME TO data_files;
      CREATE UNIQUE INDEX data_files_path ON data_files(ownerUserId, path) WHERE deletedAt IS NULL;
      CREATE INDEX data_files_storage ON data_files(storage);`,
        },
        {
            // CB-62: the data key that sealed each file (its id), or `legacy` for
            // the key from SESSION_SECRET, which sealed every file until now. The
            // re-seal finds what is left by it, and setup counts them.
            version: 4,
            name: 'file seal keys',
            up: `ALTER TABLE data_files ADD COLUMN sealKey TEXT NOT NULL DEFAULT 'legacy';
      CREATE INDEX data_files_seal ON data_files(sealKey);`,
        },
        {
            // SOFT-DELETE 17.2: the versions an overwrite kept of a file are
            // found by `deletedWith` (`file:<id>`), which only deleted rows have.
            // Partial: live files, nearly all of them, stay out of it.
            version: 5,
            name: 'file versions index',
            up: `CREATE INDEX data_files_versions ON data_files(deletedWith) WHERE deletedWith IS NOT NULL;`,
        },
        {
            // SOFT-DELETE 17.3: the bytes of a dataset file that are row history,
            // kept beside `sizeBytes` (the rest of the file, what the quota
            // counts). Zero until the dataset's next write gives it history.
            version: 6,
            name: 'dataset row history',
            up: `ALTER TABLE data_datasets ADD COLUMN historyBytes INTEGER NOT NULL DEFAULT 0;`,
        },
        {
            // A Dot's audit, newest first (the admins' Dots page).
            version: 7,
            name: 'audit by dot',
            up: 'CREATE INDEX data_audit_dot ON data_audit(dotId, createdAt)',
        },
        {
            // CB-191: each dataset's sizes per UTC day (`day`: days since the
            // epoch), the day's last measurement winning, so Operations can show
            // them over time; started from each dataset's sizes now. The audit
            // gets an index in time order, which the analytics ETL reads it by.
            version: 8,
            name: 'dataset size days',
            up: `CREATE TABLE data_dataset_days(datasetId TEXT NOT NULL, day INTEGER NOT NULL, sizeBytes INTEGER NOT NULL, historyBytes INTEGER NOT NULL, tableCount INTEGER NOT NULL, measuredAt INTEGER NOT NULL, PRIMARY KEY(datasetId, day));
      CREATE INDEX data_dataset_days_measured ON data_dataset_days(measuredAt);
      INSERT INTO data_dataset_days SELECT id, updatedAt / 86400000, sizeBytes, historyBytes, tableCount, updatedAt FROM data_datasets;
      CREATE INDEX data_audit_time ON data_audit(createdAt, id);`,
        },
        {
            // CB-229: the company socio's shared area an audit row is about
            // (`socio:<id>`, CB-224), whoever acted, so its view can say who put
            // each item there. Rows about its shared dataset say so already.
            version: 9,
            name: 'shared area audit',
            up: `ALTER TABLE data_audit ADD COLUMN area TEXT;
      CREATE INDEX data_audit_area ON data_audit(area, createdAt) WHERE area IS NOT NULL;
      UPDATE data_audit SET area = (SELECT d.ownerUserId FROM data_datasets d WHERE d.id = data_audit.datasetId) WHERE datasetId IN (SELECT id FROM data_datasets WHERE ownerUserId LIKE 'socio:%');`,
        },
        {
            // CB-194: the chat a socio's tool acted in, so Operations can say
            // which chats a dataset grounded. Older rows, and a user's or a
            // token's, have none.
            version: 10,
            name: 'audit chat',
            up: `ALTER TABLE data_audit ADD COLUMN threadId TEXT;`,
        },
        {
            // CB-369 Phase H: how many days a dataset keeps the rows its writes
            // replace (null: all of them, as before), and an owner's request to
            // compact its file at the next nightly run. Expand only: the
            // previous release reads and writes rows without them.
            version: 11,
            name: 'dataset history retention',
            up: `ALTER TABLE data_datasets ADD COLUMN historyDays INTEGER;
      ALTER TABLE data_datasets ADD COLUMN compactRequestedAt INTEGER;`,
        },
        {
            // CB-369 Phase 1: the bytes of a dataset's live analytical parts
            // (Parquet files beside it), which its owner's analytical budget
            // counts apart from `sizeBytes`. Zero for every dataset until its
            // first append. Expand only.
            version: 12,
            name: 'dataset analytical bytes',
            up: `ALTER TABLE data_datasets ADD COLUMN analyticalBytes INTEGER NOT NULL DEFAULT 0;`,
        },
        {
            // CB-451: which workspace dataset each plugin need is bound to,
            // with its access. A binding ends (`unboundAt`), never goes:
            // reinstalling offers the last one again. At most one live writer
            // per dataset, and one live binding per need. Expand only: moving
            // `plugin:<id>` datasets to the workspace is the data space's boot
            // step (`adoptPluginOwnedDatasets`), as it moves files.
            version: 13,
            name: 'plugin dataset bindings',
            compatible:
                'Its unique indexes are on data_plugin_bindings, a table it creates, which no older build uses (CB-451).',
            up: `CREATE TABLE data_plugin_bindings(id TEXT PRIMARY KEY, pluginId TEXT NOT NULL, need TEXT NOT NULL, datasetId TEXT NOT NULL, access TEXT NOT NULL CHECK(access IN ('read','write')), boundBy TEXT NOT NULL, boundAt INTEGER NOT NULL, unboundAt INTEGER);
      CREATE UNIQUE INDEX data_plugin_bindings_writer ON data_plugin_bindings(datasetId) WHERE access = 'write' AND unboundAt IS NULL;
      CREATE UNIQUE INDEX data_plugin_bindings_need ON data_plugin_bindings(pluginId, need COLLATE NOCASE) WHERE unboundAt IS NULL;
      CREATE INDEX data_plugin_bindings_dataset ON data_plugin_bindings(datasetId, unboundAt);
      CREATE INDEX data_plugin_bindings_plugin ON data_plugin_bindings(pluginId, boundAt);`,
        },
        {
            // CB-473: an admin's data operation budget for one plugin's
            // token, over the workspace's plugin default. A row only while
            // an override is set. Expand only: a new table no older build reads.
            version: 14,
            name: 'plugin data budgets',
            up: `CREATE TABLE data_plugin_budgets(pluginId TEXT PRIMARY KEY, statementsPerMinute INTEGER NOT NULL CHECK(statementsPerMinute > 0), setBy TEXT NOT NULL, setAt INTEGER NOT NULL);`,
        },
        {
            // CB-451: a dataset is an item of the Space it is shared with,
            // under one of its pages (`spaceParentId`) or at its root, at a
            // stored place among its siblings (`spacePosition`) or in the order
            // it joined (`spaceAddedAt`). Every existing share stays at the
            // root, in the order it was last changed. Expand only.
            version: 15,
            name: 'datasets in Spaces',
            up: `ALTER TABLE data_datasets ADD COLUMN spaceParentId TEXT;
      ALTER TABLE data_datasets ADD COLUMN spacePosition TEXT;
      ALTER TABLE data_datasets ADD COLUMN spaceAddedAt INTEGER;
      UPDATE data_datasets SET spaceAddedAt = updatedAt WHERE sharedSpaceId IS NOT NULL;
      CREATE INDEX data_datasets_space ON data_datasets(sharedSpaceId, spaceParentId) WHERE sharedSpaceId IS NOT NULL AND deletedAt IS NULL;`,
        },
        {
            // CB-451: a column's field kind, label and
            // kind-specific settings, per table, beside the dataset's
            // metadata. One row per column, its name matched as SQLite
            // matches column names (without regard to case); a setting
            // whose column is gone stays (orphaned, not deleted). `version`
            // is what a save is checked against; `declaredBy` is the plugin
            // whose manifest set it, until a person saves it. Expand only:
            // a new table no older build reads.
            version: 16,
            name: 'field settings',
            up: `CREATE TABLE data_field_settings(datasetId TEXT NOT NULL, tableName TEXT NOT NULL COLLATE NOCASE, columnName TEXT NOT NULL COLLATE NOCASE, kind TEXT NOT NULL, label TEXT, settings TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL CHECK(version > 0), declaredBy TEXT, updatedBy TEXT NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(datasetId, tableName, columnName));`,
        },
        {
            // Data API tokens: an admin's credential for a script of theirs
            // on the company's datasets, kept by SHA-256 hash only, with its
            // scopes, expiry, budget and maker. A revoked one keeps its row,
            // so the list and the audit still name it. `byUserId` on the data
            // audit: the admin a token's line is attributed to. Expand only.
            version: 17,
            name: 'data api tokens',
            up: `CREATE TABLE data_api_tokens(id TEXT PRIMARY KEY, name TEXT NOT NULL, hint TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, statementsPerMinute INTEGER NOT NULL CHECK(statementsPerMinute > 0), createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, lastUsedAt INTEGER, uses INTEGER NOT NULL DEFAULT 0, revokedAt INTEGER, revokedBy TEXT);
      CREATE INDEX data_api_tokens_created ON data_api_tokens(createdAt);
      ALTER TABLE data_audit ADD COLUMN byUserId TEXT;`,
        },
    ],
};
