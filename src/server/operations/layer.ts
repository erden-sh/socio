/**
 * Operations' services as layers: each implements a tag of `contract.ts`
 * (or the whole analytics client, `AnalyticsStore`) and names what it needs
 * by other features' tags, so a missing dependency is a compile error at
 * the composition root, the only importer of this file
 * (`composition/operations.ts`).
 *
 * Nothing here migrates, loads or starts anything: the store's tables are
 * migrated at boot, and the analytics client is started and stopped with
 * the runtime's leadership, as before. The module's hooks (`module.ts`:
 * routes, the sampler, the price sync) still get their dependencies from
 * the module context, which the modules' runner hands every module.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import { sqliteData } from '@socio/data/open';

import { WorkspaceSettings } from '../settings/contract.js';
import { Runner, type RunnerShape } from '../turns/contract.js';

import { auditor } from './access-log.js';
import type { AnalyticsClient } from './analytics/client.js';
import { analyticsClient, AnalyticsStore } from './analytics/connect.js';
import {
    AccessAudit,
    Analytics,
    OperationsConfig,
    Resources,
    RunSource,
    type OperationsConfigShape,
} from './contract.js';
import { sqliteOperationsRepositories } from './infra/sqlite/access-log.js';
import { sqliteSourceReader } from './infra/sqlite/source-reader.js';
import { resourcesOver } from './retention.js';

/**
 * The workspace's connection, opened and migrated by the boot step, which
 * operations' stores (the access log, the stored turns) read. A stand-in for
 * the app's `Database` tag, which no feature offers yet: the composition root
 * provides it from the workspace store.
 */
export class OperationsDatabase extends Context.Service<OperationsDatabase, DatabaseSync>()(
    'socio/operations/OperationsDatabase',
) {}

/** `AccessAudit` (CB-188): the access log's route wrapper, over the access log on that connection. */
export const AccessAuditLive = Layer.effect(
    AccessAudit,
    Effect.gen(function* () {
        const db = yield* OperationsDatabase;
        return AccessAudit.of({ audit: auditor({ log: sqliteOperationsRepositories(sqliteData(db)).accessLog }) });
    }),
);

/** `RunSource` (CB-187): the stored turns, read by `seq` on the app's database. */
export const RunSourceLive = Layer.effect(
    RunSource,
    Effect.gen(function* () {
        return RunSource.of(sqliteSourceReader(yield* OperationsDatabase));
    }),
);

/**
 * `Resources`: the resource policy in force, the workspace settings'
 * operations section over the environment's defaults, read on every call.
 */
export const ResourcesLive = Layer.effect(
    Resources,
    Effect.gen(function* () {
        const settings = yield* WorkspaceSettings;
        const { operations } = yield* OperationsConfig;
        return Resources.of(resourcesOver(settings, operations));
    }),
);

/** The analytics client for the configured mode (`OPS_ANALYTICS_*`), or none. */
export const analyticsOf = (config: Pick<OperationsConfigShape, 'analytics'>): AnalyticsClient | undefined =>
    config.analytics ? analyticsClient(config.analytics) : undefined;

/**
 * The analytics store (CB-186): the client, made (not started) when one is
 * configured, offered whole (`AnalyticsStore`) and as the `Analytics` slice;
 * both stay unset (undefined) with analytics off.
 */
export const AnalyticsLive = Layer.effect(
    Analytics,
    Effect.gen(function* () {
        return yield* AnalyticsStore;
    }),
).pipe(
    Layer.provideMerge(
        Layer.effect(
            AnalyticsStore,
            Effect.gen(function* () {
                return analyticsOf(yield* OperationsConfig);
            }),
        ),
    ),
);

/**
 * The analytics store reads a finished turn soon (CB-187): after each run
 * the runner stores, a fire and forget nudge to its process, off the
 * turn's path. Nothing is listened for with analytics off.
 */
export const AnalyticsNudgeLive = Layer.effectDiscard(
    Effect.gen(function* () {
        const analytics = yield* AnalyticsStore;
        if (analytics) {
            nudgeOnFinishedRuns(yield* Runner, () => analytics);
        }
    }),
);

/** The nudge itself, on the runner's finished runs; `analytics` is read at each one. */
export function nudgeOnFinishedRuns(
    runner: Pick<RunnerShape, 'onRunFinished'>,
    analytics: () => Pick<AnalyticsClient, 'nudge'> | undefined,
) {
    runner.onRunFinished(() => setImmediate(() => analytics()?.nudge()));
}
