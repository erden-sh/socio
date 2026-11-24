/**
 * What other features may know of Operations (CB-164): its tags, the slices
 * of its services they call, and plain types and constants. It imports only
 * `effect`, `@socio/*` and, with `import type`, `hono`, and holds no logic.
 *
 * What moved here is imported from here, and the old paths are gone.
 * `layer.ts` implements the tags, and the composition root provides them
 * (`composition/operations.ts`).
 *
 * Moved to packages, not here (pure helpers):
 * - `requireAdminPerson`: `@socio/foundation/operations/require-admin-person`;
 * - `operationsSettingsView`, `validSessionGap`:
 *   `@socio/foundation/operations/settings-view`;
 * - `runFacts` and its fact types: `@socio/foundation/operations/run-facts`,
 *   with `SourceRun` (`.../source-run`) and `readRunsWatermark`
 *   (`.../runs-watermark`);
 * - `AccessSubject` and `AuditOptions`, the access log's route options:
 *   `@socio/foundation/operations/audit-options`, re-exported below (the
 *   features below Operations name them from there);
 * - the `DeploymentMetrics` port and its disk usage proxy adapter
 *   (`DiskUsageDeploymentMetrics`, which needs `zod`):
 *   `@socio/shared/operations/deployment-metrics`.
 */
import { Context } from 'effect';
import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import type { AuditOptions } from '@socio/foundation/operations/audit-options';
import type { SourceRun } from '@socio/foundation/operations/source-run';
import type { OperationsSettings } from '@socio/shared/operations/operations';
import type { AnalyticsHealth, AnalyticsMode } from '@socio/shared/operations/operations-analytics';
import type { ResourcePolicy } from '@socio/shared/operations/operations-resources';

import type { BackupsShape } from '../backup/contract.js';

export type { AccessSubject, AuditOptions } from '@socio/foundation/operations/audit-options';
export type { SourceRun } from '@socio/foundation/operations/source-run';
export {
    DEPLOYMENT_STATS_PATH,
    DEPLOYMENT_STATS_TIMEOUT_MS,
    type DeploymentMetrics,
    type DeploymentStatsRead,
} from '@socio/shared/operations/deployment-metrics';

// ── The access log (CB-188) ──────────────────────────────────────────────

/**
 * The access log's route wrapper, as `classify/`, `rooms/` and `runs/` use
 * it today (`auditor({ log: sqliteOperationsRepositories(data).accessLog })`):
 * put before a handler that answers person-level rows or content, it lets
 * only signed-in admins pass and writes the entry before the answer is sent,
 * or refuses the answer (503) when it can't. `access-log.ts`'s `auditor`
 * builds `audit` over the workspace connection's access log.
 */
export interface AccessAuditShape {
    readonly audit: (options: AuditOptions) => MiddlewareHandler<AppEnv>;
}

export class AccessAudit extends Context.Service<AccessAudit, AccessAuditShape>()('socio/operations/AccessAudit') {}

// ── The turns as stored (CB-187) ─────────────────────────────────────────

/**
 * The stored turns, read by `seq` on the app's database, as `classify/`
 * reads them (`sqliteSourceReader(db)` today): synchronous, as SQLite is,
 * each method one short read. `etl/source-reader.ts`'s `SourceReader`
 * extends it, and `infra/sqlite/source-reader.ts` implements that.
 */
export interface RunSourceShape {
    /** Whether the app has made its tables yet (a new database hasn't). */
    ready(): boolean;
    /**
     * Turns after `seq`, oldest first: at most `limit`, and no more than
     * `maxBytes` of stored text unless the first alone is larger.
     */
    runsAfter(seq: number, limit: number, maxBytes?: number): SourceRun[];
    /** These turns again (the ones still running last time). */
    runsBySeq(seqs: readonly number[]): SourceRun[];
}

export class RunSource extends Context.Service<RunSource, RunSourceShape>()('socio/operations/RunSource') {}

// ── The analytics store (CB-186) ─────────────────────────────────────────

/** How the app reaches the analytics store (`OPS_ANALYTICS_*`). */
export type AnalyticsConfig =
    | {
          mode: 'child';
          /** `OPS_ANALYTICS_DIR`: `analytics/` next to the database by default. */
          dir: string;
          databasePath: string;
          /** What the child reads its settings' defaults from. */
          env: Record<string, string>;
      }
    | {
          mode: 'service';
          /** `OPS_ANALYTICS_URL`: e.g. http://socio-analytics:4340. */
          url: string;
          /** `OPS_ANALYTICS_SECRET` (`_FILE`): shared with the service only. */
          secret: string;
      };

/**
 * The analytics store, as the composition uses it (`LegacyAnalytics`): started
 * and stopped with the runtime's leadership, its health in `setup()` and the
 * health view, and a nudge after each finished turn. `analytics/client.ts`'s
 * `AnalyticsClient` extends it with the dashboard's queries and rebuild.
 */
export interface AnalyticsShape {
    readonly mode: AnalyticsMode;
    start(): void;
    stop(): Promise<void>;
    /** The latest known health, without a round trip (`setup()`). */
    health(): AnalyticsHealth;
    /** Read SQLite soon (after a finished turn); fire and forget. */
    nudge(): void;
}

/**
 * The analytics store, or none: with `OPS_ANALYTICS_MODE=off` there is no
 * store (`LegacyAnalytics` is undefined today), so the default is
 * undefined and callers keep checking for it.
 */
export const Analytics = Context.Reference<AnalyticsShape | undefined>('socio/operations/Analytics', {
    defaultValue: () => undefined,
});

// ── Backups (the dashboard's health) ─────────────────────────────────────

/**
 * Scheduled backups (CB-63), when the server set them up: their status for
 * the dashboard's health. Read at each use, since the boot step sets them
 * after the graph is built; the composition provides it over its
 * late-bound port.
 */
export interface OperationsBackupsShape {
    readonly backups: Pick<BackupsShape, 'status'> | undefined;
}

export class OperationsBackups extends Context.Service<OperationsBackups, OperationsBackupsShape>()(
    'socio/operations/OperationsBackups',
) {}

// ── The resource policy (CB-321) ─────────────────────────────────────────

/**
 * The resource policy in force: how often the server samples itself, and
 * how long samples and other history are kept, the environment's defaults
 * (`OPS_*`) under what an admin saved in the operations settings. Read on
 * every use, so a saved value applies at once; the notifications and the
 * pages' retention read it today (`composition/operations.ts`'s
 * `LegacyResourcePolicy`, over this tag).
 */
export interface ResourcesShape {
    policy(): ResourcePolicy;
}

export class Resources extends Context.Service<Resources, ResourcesShape>()('socio/operations/Resources') {}

// ── OperationsConfig ─────────────────────────────────────────────────────

/**
 * The `PlatformConfig` fields `operations/` and its construction in
 * `composition/operations.ts` read. `PlatformConfig` has each of them with this type, so the
 * composition root can provide the tag from it.
 *
 * Not here: the config `operations/` hands whole to `settings/`'s
 * `limitDefaults` (the Limits view), which settings' own config tag carries.
 */
export interface OperationsConfigShape {
    /** The operations settings' env defaults (`OPS_*`): time zone, session gap, resources, price sync. */
    readonly operations?: OperationsSettings;
    /** `OPS_PRICE_SYNC_URL` (CB-195): an origin every price list is read from instead of its own. */
    readonly priceSyncUrl?: string;
    /** The analytics store (`OPS_ANALYTICS_*`); none when off. */
    readonly analytics?: AnalyticsConfig;
}

export class OperationsConfig extends Context.Service<OperationsConfig, OperationsConfigShape>()(
    'socio/operations/OperationsConfig',
) {}
