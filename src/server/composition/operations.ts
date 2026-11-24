/**
 * The operations feature's construction: its layers (`operations/layer.ts`),
 * wired into the graph at the steps the server has always built them at.
 */
import { Context, Effect, Layer } from 'effect';

import { AnalyticsStore } from '../operations/analytics/connect.js';
import {
    OperationsBackups,
    OperationsConfig,
    Resources,
    type OperationsBackupsShape,
    type OperationsConfigShape,
} from '../operations/contract.js';
import {
    AccessAuditLive,
    AnalyticsLive,
    AnalyticsNudgeLive,
    OperationsDatabase,
    ResourcesLive,
    RunSourceLive,
} from '../operations/layer.js';
import { CoverageModules } from '../operations/queries/coverage.js';
import { resourcesOver } from '../operations/retention.js';

import { LegacyConfig, LegacyWorkspace, ModuleHost } from './base.js';
import type { PlatformConfig } from './config.js';
import type { CoreStore } from './core-store.js';
import { Ports } from './ports.js';

/**
 * `OperationsConfig`: the `PlatformConfig` fields operations reads, which
 * the boot step parses from the environment (`OPS_*`, `index.ts`).
 */
export function operationsConfigOf(config: PlatformConfig): OperationsConfigShape {
    return { operations: config.operations, priceSyncUrl: config.priceSyncUrl, analytics: config.analytics };
}

/** The resource policy, read from settings each time. */
export function resourcePolicyOf(store: CoreStore, config: PlatformConfig) {
    const resources = resourcesOver(store.slices.settings, config.operations);
    return () => resources.policy();
}
export type ResourcePolicy = ReturnType<typeof resourcePolicyOf>;

/** The resource policy, as the notifications and the pages' search read it (over `Resources`). */
export class LegacyResourcePolicy extends Context.Service<LegacyResourcePolicy, ResourcePolicy>()(
    'socio/composition/operations/ResourcePolicy',
) {}

/** The analytics client, under the graph's `LegacyAnalytics` tag: none unless configured (`AnalyticsStore`). */
export const LegacyAnalytics = AnalyticsStore;

/** `OperationsConfig` over the boot step's config. */
const OperationsConfigLive = Layer.effect(
    OperationsConfig,
    Effect.gen(function* () {
        return OperationsConfig.of(operationsConfigOf(yield* LegacyConfig));
    }),
);

/** The workspace's connection, from the boot step's workspace store. */
const DatabaseFromWorkspace = Layer.effect(
    OperationsDatabase,
    Effect.gen(function* () {
        return (yield* LegacyWorkspace).db;
    }),
);

/** The backups when the server set them up, read from their late-bound port at each use (`OperationsBackups`). */
export const operationsBackups = (backups: () => OperationsBackupsShape['backups']): OperationsBackupsShape => ({
    get backups() {
        return backups();
    },
});

/**
 * What the module's hooks read that only the root holds: the backups
 * (`OperationsBackups`) and the modules and their context, for the
 * coverage matrix (`CoverageModules`). Build nothing, start nothing.
 */
const ModulePortsLive = Layer.mergeAll(
    Layer.effect(
        OperationsBackups,
        Effect.gen(function* () {
            const ports = yield* Ports;
            return operationsBackups(() => ports.backups.peek());
        }),
    ),
    Layer.effect(
        CoverageModules,
        Effect.gen(function* () {
            return (yield* ModuleHost).use((modules, context) => ({ modules, context }));
        }),
    ),
);

/**
 * Operations' steps of the graph, in the graph's order:
 * `resourcePolicy` provides `OperationsConfig`, `Resources` (and the
 * notifications' and pages' `LegacyResourcePolicy` over it), `AccessAudit`
 * and `RunSource` over the workspace's connection; `analytics` the client
 * (`Analytics`, `AnalyticsStore`), unset unless configured, with the
 * module's ports (`ModulePortsLive`); `nudge` the
 * analytics nudge on each finished turn.
 */
export const operationsLayers = {
    resourcePolicy: Layer.effect(
        LegacyResourcePolicy,
        Effect.gen(function* () {
            const resources = yield* Resources;
            return () => resources.policy();
        }),
    ).pipe(
        Layer.provideMerge(ResourcesLive),
        Layer.provideMerge(Layer.mergeAll(AccessAuditLive, RunSourceLive)),
        Layer.provide(DatabaseFromWorkspace),
        Layer.provideMerge(OperationsConfigLive),
    ),
    analytics: AnalyticsLive.pipe(Layer.provideMerge(ModulePortsLive)),
    nudge: AnalyticsNudgeLive,
};
