import { Context, Effect, Layer } from 'effect';
import { expect, it, vi } from 'vitest';

import type { Settings } from '@socio/shared/types';

import { LegacyConfig, LegacyStore, LegacyWorkspace } from '../src/server/composition/base.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { LegacyResourcePolicy, operationsLayers } from '../src/server/composition/operations.js';
import type { AppWorkspace as WorkspaceStore } from '../src/server/composition/workspace-parts.js';
import type { AnalyticsClient } from '../src/server/operations/analytics/client.js';
import { AnalyticsStore } from '../src/server/operations/analytics/connect.js';
import {
    AccessAudit,
    Analytics,
    OperationsConfig,
    Resources,
    RunSource,
    type OperationsConfigShape,
} from '../src/server/operations/contract.js';
import {
    AccessAuditLive,
    AnalyticsLive,
    AnalyticsNudgeLive,
    OperationsDatabase,
    ResourcesLive,
    RunSourceLive,
} from '../src/server/operations/layer.js';
import { WorkspaceSettings, type WorkspaceSettingsShape } from '../src/server/settings/contract.js';
import { Runner, type RunnerShape } from '../src/server/turns/contract.js';

import type { Store } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

// Operations' tags are implemented in operations/layer.ts and wired by
// composition/operations.ts, each layer naming what it needs by tag. These
// build the layers on their own, with fakes for what other features provide.

/** Workspace settings whose operations section a test changes between reads. */
function savedSettings(initial: Settings['operations']) {
    let operations = initial;
    const settings = { settingsSnapshot: () => ({ operations }) as Settings } as unknown as WorkspaceSettingsShape;
    return { settings, save: (next: Settings['operations']) => (operations = next) };
}

const build = <A, E>(layer: Layer.Layer<A, E, never>) => Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));

it('reads the resource policy on every call: env defaults under what an admin saved', async () => {
    const { settings, save } = savedSettings(undefined);
    const config: OperationsConfigShape = { operations: { resources: { sampleDays: 30 } } };
    const context = await build(
        ResourcesLive.pipe(
            Layer.provide(Layer.succeed(WorkspaceSettings, settings)),
            Layer.provide(Layer.succeed(OperationsConfig, config)),
        ),
    );
    const resources = Context.get(context, Resources);
    expect(resources.policy().sampleDays).toBe(30);
    save({ resources: { sampleDays: 7, sampleEverySeconds: 120 } });
    expect(resources.policy()).toMatchObject({ sampleDays: 7, sampleEverySeconds: 120 });
});

it('offers the access log and the stored turns over the workspace connection', async () => {
    const db = testDatabase();
    const context = await build(
        Layer.mergeAll(AccessAuditLive, RunSourceLive).pipe(Layer.provide(Layer.succeed(OperationsDatabase, db))),
    );
    expect(typeof Context.get(context, AccessAudit).audit).toBe('function');
    expect(Context.get(context, RunSource).ready()).toBe(true);
    expect(Context.get(context, RunSource).runsAfter(0, 10)).toEqual([]);
    db.close();
});

it('has no analytics store with analytics off, and the same client as both tags when configured', async () => {
    const off = await build(AnalyticsLive.pipe(Layer.provide(Layer.succeed(OperationsConfig, {}))));
    expect(Context.get(off, Analytics)).toBeUndefined();
    expect(Context.get(off, AnalyticsStore)).toBeUndefined();

    const on = await build(
        AnalyticsLive.pipe(
            Layer.provide(
                Layer.succeed(OperationsConfig, {
                    analytics: { mode: 'service', url: 'http://analytics.invalid:4340', secret: 'not-a-secret' },
                }),
            ),
        ),
    );
    const client = Context.get(on, AnalyticsStore);
    expect(client?.mode).toBe('service');
    expect(Context.get(on, Analytics)).toBe(client);
});

it('nudges the analytics store after each finished run, off the run, and listens for nothing without one', async () => {
    const listeners: (() => void)[] = [];
    const runner = { onRunFinished: (listener: () => void) => listeners.push(listener) } as unknown as RunnerShape;
    const nudge = vi.fn();
    const store = { mode: 'service', nudge } as unknown as AnalyticsClient;

    await build(AnalyticsNudgeLive.pipe(Layer.provide(Layer.succeed(Runner, runner))));
    expect(listeners).toHaveLength(0);

    await build(
        AnalyticsNudgeLive.pipe(
            Layer.provide(Layer.succeed(Runner, runner)),
            Layer.provide(Layer.succeed(AnalyticsStore, store)),
        ),
    );
    expect(listeners).toHaveLength(1);
    listeners[0]!();
    expect(nudge).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(nudge).toHaveBeenCalledTimes(1);
});

it("wires the graph's step: the config, the policy the notifications and pages read, the access log and turns", async () => {
    const db = testDatabase();
    const { settings, save } = savedSettings({ resources: { sampleDays: 9 } });
    const config = { operations: { resources: { sampleDays: 30 } }, priceSyncUrl: 'https://prices.invalid' };
    const context = await build(
        operationsLayers.resourcePolicy.pipe(
            Layer.provide(
                Layer.mergeAll(
                    Layer.succeed(LegacyConfig, config as unknown as PlatformConfig),
                    Layer.succeed(LegacyStore, { slices: { settings } } as unknown as Store),
                    Layer.succeed(LegacyWorkspace, { db } as unknown as WorkspaceStore),
                    Layer.succeed(WorkspaceSettings, settings),
                ),
            ),
        ),
    );
    expect(Context.get(context, OperationsConfig)).toEqual({
        operations: config.operations,
        priceSyncUrl: 'https://prices.invalid',
        analytics: undefined,
    });
    const policy = Context.get(context, LegacyResourcePolicy);
    expect(policy().sampleDays).toBe(9);
    save(undefined);
    expect(policy().sampleDays).toBe(30);
    expect(Context.get(context, Resources).policy().sampleDays).toBe(30);
    expect(Context.get(context, RunSource).ready()).toBe(true);
    // The settings slice it read stays inside: the graph offers its own, later.
    expect(Context.getOrUndefined(context as Context.Context<unknown>, WorkspaceSettings)).toBeUndefined();
    db.close();
});
