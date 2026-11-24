import { primaryKey, sqliteTable } from 'drizzle-orm/sqlite-core';

import { enumText, flag, int, json, ms, str } from '@socio/data/columns.sqlite';
import type { BundleEntry } from '@socio/foundation/apps/bundle';
import type { AppManifest } from '@socio/shared/apps/app-manifest';

/**
 * Mini apps' tables (CB-110), as `apps/migrations.ts` makes them: the
 * typed mirror the repositories query. The migrations stay the source of
 * truth; tests/apps-repositories.test.ts holds these to them. An app's id
 * is its host label, not a UUID, so it is plain text here.
 */

export const apps = sqliteTable('apps', {
    id: str().primaryKey(),
    slug: str().notNull(),
    name: str().notNull(),
    description: str().notNull(),
    dotId: str().notNull(),
    ownerUserId: str().notNull(),
    port: int().notNull(),
    datasets: json<string[]>().notNull(),
    /** Stored for later; always false. */
    public: flag().notNull(),
    sharedSpaceId: str(),
    startCommand: str(),
    status: enumText(['ephemeral', 'packaged', 'promoted', 'unpublished']).notNull(),
    liveVersion: int(),
    previousVersion: int(),
    config: json<Record<string, string>>().notNull(),
    promotedAt: ms(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
    deletedAt: ms(),
    deletedBy: str(),
    deletedWith: str(),
    deletedLabel: str(),
});

export const appSessions = sqliteTable('app_sessions', {
    hash: str().primaryKey(),
    appId: str().notNull(),
    userId: str().notNull(),
    createdAt: ms().notNull(),
    expiresAt: ms().notNull(),
});

export const appVersions = sqliteTable(
    'app_versions',
    {
        appId: str().notNull(),
        version: int().notNull(),
        manifest: json<AppManifest>().notNull(),
        bundlePath: str().notNull(),
        sha256: str().notNull(),
        sizeBytes: int().notNull(),
        files: int().notNull(),
        fileList: json<BundleEntry[]>().notNull(),
        createdByDotId: str(),
        createdAt: ms().notNull(),
    },
    (table) => [primaryKey({ columns: [table.appId, table.version] })],
);

export const appGrants = sqliteTable(
    'app_grants',
    {
        appId: str().notNull(),
        datasetId: str().notNull(),
        ref: str().notNull(),
        access: enumText(['read', 'write']).notNull(),
        createdByPromotion: flag().notNull(),
        createdAt: ms().notNull(),
    },
    (table) => [primaryKey({ columns: [table.appId, table.datasetId] })],
);

export const appAttempts = sqliteTable(
    'app_attempts',
    {
        appId: str().notNull(),
        attempt: int().notNull(),
        runtimeId: str().notNull(),
        version: int().notNull(),
        kind: enumText(['build', 'start']).notNull(),
        state: enumText(['running', 'succeeded', 'failed', 'stopped']).notNull(),
        reason: enumText(['exit', 'signal', 'oom', 'health_check', 'spawn', 'build', 'stopped', 'lost']),
        exitCode: int(),
        signal: str(),
        message: str(),
        log: str().notNull(),
        dropped: int().notNull(),
        startedAt: ms().notNull(),
        upAt: ms(),
        endedAt: ms(),
        updatedAt: ms().notNull(),
    },
    (table) => [primaryKey({ columns: [table.appId, table.attempt] })],
);

/**
 * The one-time launch codes (CB-108). Mirrored for the drift test only:
 * `infra/launch-codes.ts` keeps its raw SQL, since redeeming a code is a
 * synchronous `DELETE … RETURNING` on the proxy's path.
 */
export const appLaunchCodes = sqliteTable('app_launch_codes', {
    hash: str().primaryKey(),
    appId: str().notNull(),
    userId: str().notNull(),
    next: str().notNull(),
    expiresAt: ms().notNull(),
});

/**
 * Each app's actor-envelope key epoch (apps 7, CB-232); written by
 * `infra/actor-keys.ts`.
 */
export const appActorKeys = sqliteTable('app_actor_keys', {
    appId: str().primaryKey(),
    epoch: ms().notNull(),
    previousEpoch: ms(),
    rotatedAt: ms().notNull(),
});

/** Each app's self-healing state (CB-291, apps 8); `health.ts` reads and writes it. */
export const appHealth = sqliteTable('app_health', {
    appId: str().primaryKey(),
    state: enumText(['healthy', 'recovering', 'degraded', 'failed']).notNull().default('healthy'),
    reason: str(),
    attempts: int().notNull().default(0),
    episode: str(),
    nextAttemptAt: ms(),
    lastRecoveryAt: ms(),
    lastRecoveryReason: str(),
    lastError: str(),
    escalatedAt: ms(),
    tokenHashes: str().notNull().default('[]'),
    tokenRepair: str(),
    leaseUntil: ms(),
    leaseClaim: str(),
    updatedAt: ms().notNull(),
});

/** Every table the apps module owns, for the drift test. */
export const appsTables = [
    apps,
    appSessions,
    appVersions,
    appGrants,
    appAttempts,
    appLaunchCodes,
    appActorKeys,
    appHealth,
] as const;
