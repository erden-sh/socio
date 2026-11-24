import type { SchemaSet } from '@socio/data/migrate';

/**
 * Workspace bundles (CB-380): what an import brought in, so a second run
 * of the same bundle changes nothing and a later bundle updates only what
 * nobody here edited since.
 *
 * `import_runs`: one row per applied import (a dry run writes nothing):
 * the bundle's sha256 (of its manifest, which holds every file's), the
 * source's origin, who started it, when, and the counts as JSON.
 *
 * `import_map`: one row per imported record, keyed by the source's origin,
 * the record's kind and its id there. `targetId` is its id here (the same
 * id today: ids are kept). `hash` is the hash of the record as the import
 * last wrote it, so a later run can tell a record nobody touched (update it
 * from the bundle) from one edited here (leave it: edits here win). A
 * bundle issue the import gave another number here (its own was another
 * issue's) also has an `issue_number` row: `sourceId` its id, `targetId`
 * its number here, `hash` its number at the source.
 *
 * Expand-only: new tables, so the build before it runs on the schema it
 * leaves.
 */
export const bundleSchema: SchemaSet = {
    id: 'bundle',
    migrations: [
        {
            version: 1,
            name: 'import runs and map',
            phase: 'expand',
            up: `CREATE TABLE import_runs(
        id TEXT PRIMARY KEY,
        bundleSha256 TEXT NOT NULL CHECK (length(bundleSha256) = 64),
        sourceOrigin TEXT NOT NULL CHECK (length(sourceOrigin) > 0),
        startedBy TEXT NOT NULL CHECK (length(startedBy) > 0),
        startedAt INTEGER NOT NULL,
        finishedAt INTEGER,
        backupPath TEXT,
        counts TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE import_map(
        sourceOrigin TEXT NOT NULL CHECK (length(sourceOrigin) > 0),
        kind TEXT NOT NULL CHECK (length(kind) > 0),
        sourceId TEXT NOT NULL CHECK (length(sourceId) > 0),
        targetId TEXT NOT NULL CHECK (length(targetId) > 0),
        hash TEXT NOT NULL,
        runId TEXT NOT NULL,
        importedAt INTEGER NOT NULL,
        PRIMARY KEY (sourceOrigin, kind, sourceId)
      );
      CREATE INDEX import_map_target ON import_map(kind, targetId);`,
        },
        {
            // How each applied import was started: 'web' (POST
            // /api/operator/bundles/import), 'cli' (`bundle-cli.js import
            // --live`, handed to the running server on its local socket, on
            // behalf of `startedBy`) or 'offline'. NULL: before this column.
            version: 2,
            name: 'import runs via',
            phase: 'expand',
            up: `ALTER TABLE import_runs ADD COLUMN via TEXT CHECK (via IN ('web','cli','offline'));`,
        },
    ],
};
