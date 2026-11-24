import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * Mini apps. `apps` holds the registered apps (the id is the host label);
 * `app_sessions` the sessions on the apps' own origins, stored as hashes
 * and bound to one app. `public` is stored for later and always 0.
 *
 * Promotion (migration 2): `apps` is rebuilt for its states (the first
 * migration's `active` becomes `ephemeral`) with the live and previous
 * version, the owner's settings for the manifest's env and when it was
 * promoted; the port stays unique per Dot only while the computer serves
 * the app.
 * `app_versions` holds each packaged bundle's metadata (the bundle itself
 * is a sealed file in the owner's data space); `app_grants` the datasets a
 * promoted app's token may use, and which of them its promotion created.
 * `app_attempts` (migration 4) keeps each build and start attempt's log;
 * `app_launch_codes` (migration 6) the one-time launch codes, hashed;
 * `app_health` (migration 8) each app's self-healing state (CB-291).
 */
export const appsSchema: SchemaSet = {
    id: MODULE_IDS.apps,
    migrations: [
        {
            version: 1,
            name: 'mini apps',
            up: `CREATE TABLE apps(id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', dotId TEXT NOT NULL, ownerUserId TEXT NOT NULL, port INTEGER NOT NULL, datasets TEXT NOT NULL DEFAULT '[]', public INTEGER NOT NULL DEFAULT 0, sharedSpaceId TEXT, startCommand TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active')), createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE UNIQUE INDEX apps_dot_port ON apps(dotId, port);
      CREATE INDEX apps_owner ON apps(ownerUserId);
      CREATE TABLE app_sessions(hash TEXT PRIMARY KEY, appId TEXT NOT NULL, userId TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
      CREATE INDEX app_sessions_app ON app_sessions(appId);`,
        },
        {
            version: 2,
            name: 'promotion',
            up: `CREATE TABLE apps_v2(id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', dotId TEXT NOT NULL, ownerUserId TEXT NOT NULL, port INTEGER NOT NULL, datasets TEXT NOT NULL DEFAULT '[]', public INTEGER NOT NULL DEFAULT 0, sharedSpaceId TEXT, startCommand TEXT, status TEXT NOT NULL DEFAULT 'ephemeral' CHECK(status IN ('ephemeral','packaged','promoted','unpublished')), liveVersion INTEGER, previousVersion INTEGER, config TEXT NOT NULL DEFAULT '{}', promotedAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      INSERT INTO apps_v2(id, slug, name, description, dotId, ownerUserId, port, datasets, public, sharedSpaceId, startCommand, status, createdAt, updatedAt) SELECT id, slug, name, description, dotId, ownerUserId, port, datasets, public, sharedSpaceId, startCommand, 'ephemeral', createdAt, updatedAt FROM apps;
      DROP TABLE apps;
      ALTER TABLE apps_v2 RENAME TO apps;
      CREATE UNIQUE INDEX apps_dot_port ON apps(dotId, port) WHERE status IN ('ephemeral','packaged');
      CREATE INDEX apps_owner ON apps(ownerUserId);
      CREATE TABLE app_versions(appId TEXT NOT NULL, version INTEGER NOT NULL, manifest TEXT NOT NULL, bundlePath TEXT NOT NULL, sha256 TEXT NOT NULL, sizeBytes INTEGER NOT NULL, files INTEGER NOT NULL, fileList TEXT NOT NULL DEFAULT '[]', createdByDotId TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY(appId, version));
      CREATE TABLE app_grants(appId TEXT NOT NULL, datasetId TEXT NOT NULL, ref TEXT NOT NULL, access TEXT NOT NULL CHECK(access IN ('read','write')), createdByPromotion INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, PRIMARY KEY(appId, datasetId));`,
        },
        {
            // CB-64: deleting an app hides it and keeps it. Its id is its
            // address, so a deleted app is re-keyed to `deleted-<uuid>` (with its
            // versions and grants) and `deletedLabel` keeps the old id; a new app
            // can take the address. The port is unique among live apps only.
            version: 3,
            name: 'soft delete',
            up: `ALTER TABLE apps ADD COLUMN deletedAt INTEGER;
      ALTER TABLE apps ADD COLUMN deletedBy TEXT;
      ALTER TABLE apps ADD COLUMN deletedWith TEXT;
      ALTER TABLE apps ADD COLUMN deletedLabel TEXT;
      DROP INDEX apps_dot_port;
      CREATE UNIQUE INDEX apps_dot_port ON apps(dotId, port) WHERE status IN ('ephemeral','packaged') AND deletedAt IS NULL;`,
        },
        {
            // CB-146: each build and start attempt of a promoted app's versions,
            // as the runtime reported it (which keeps nothing across restarts):
            // how it ended and its last lines, redacted. `attempt` counts per app;
            // `runtimeId` is the runtime's id for it. Bounded per app and version
            // (`domain/attempts.ts`); a deleted app's attempts are re-keyed with it.
            version: 4,
            name: 'start attempts',
            up: `CREATE TABLE app_attempts(appId TEXT NOT NULL, attempt INTEGER NOT NULL, runtimeId TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IS NOT NULL AND kind IN ('build','start')), state TEXT NOT NULL CHECK(state IS NOT NULL AND state IN ('running','succeeded','failed','stopped')), reason TEXT CHECK(reason IS NULL OR reason IN ('exit','signal','oom','health_check','spawn','build','stopped','lost')), exitCode INTEGER, signal TEXT, message TEXT, log TEXT NOT NULL DEFAULT '', dropped INTEGER NOT NULL DEFAULT 0, startedAt INTEGER NOT NULL, upAt INTEGER, endedAt INTEGER, updatedAt INTEGER NOT NULL, PRIMARY KEY(appId, attempt));
      CREATE UNIQUE INDEX app_attempts_runtime ON app_attempts(appId, runtimeId);
      CREATE INDEX app_attempts_version ON app_attempts(appId, version, attempt);`,
        },
        {
            version: 5,
            name: 'app OOM telemetry index',
            up: "CREATE INDEX app_attempts_oom_time ON app_attempts(COALESCE(endedAt,startedAt),appId) WHERE reason='oom'",
        },
        {
            // CB-108: one-time launch codes in the database, not one process's
            // memory, so a code made on one runtime redeems on another during a
            // blue/green deploy. Only the code's SHA-256 hash is kept; codes live
            // 60 s and go when redeemed, so the table stays tiny.
            version: 6,
            name: 'shared launch codes',
            phase: 'expand',
            up: 'CREATE TABLE app_launch_codes(hash TEXT PRIMARY KEY, appId TEXT NOT NULL, userId TEXT NOT NULL, next TEXT NOT NULL, expiresAt INTEGER NOT NULL)',
        },
        {
            // CB-232: the epoch each app's actor-envelope key is derived
            // under. A new table, so an older runtime that never reads it is
            // unaffected; an app without a row uses its createdAt.
            version: 7,
            name: 'app actor key epochs',
            phase: 'expand',
            up: 'CREATE TABLE app_actor_keys(appId TEXT PRIMARY KEY, epoch INTEGER NOT NULL, previousEpoch INTEGER, rotatedAt INTEGER NOT NULL)',
        },
        {
            // CB-291: each app's self-healing state (healthy, recovering,
            // degraded, failed), its repairs and the last that held, and the
            // hashes of its last data tokens, so a refused token still names
            // its app after a restart. Upserted only; a new table, so an older
            // runtime that never reads it is unaffected.
            version: 8,
            name: 'app health',
            phase: 'expand',
            up: "CREATE TABLE app_health(appId TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'healthy' CHECK(state IN ('healthy','recovering','degraded','failed')), reason TEXT, attempts INTEGER NOT NULL DEFAULT 0, episode TEXT, nextAttemptAt INTEGER, lastRecoveryAt INTEGER, lastRecoveryReason TEXT, lastError TEXT, escalatedAt INTEGER, tokenHashes TEXT NOT NULL DEFAULT '[]', tokenRepair TEXT, leaseUntil INTEGER, leaseClaim TEXT, updatedAt INTEGER NOT NULL)",
        },
    ],
};
