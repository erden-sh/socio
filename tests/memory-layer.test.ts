// Memory's tags are made by its layer (memory/layer.ts) from other features'
// tags, and give what the functions they wrap give; the retention in force is
// Settings' rule for its two limits; MemoryConfig comes from the environment.
import { Context, Layer, ManagedRuntime } from 'effect';
import { afterEach, expect, it } from 'vitest';

import { limitsInForce } from '@socio/shared/settings/limits';

import { LegacyConfig, LegacyStore, LegacyWorkspace } from '../src/server/composition/base.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { memoryConfig, memoryLayers } from '../src/server/composition/memory.js';
import {
    DEFAULT_EPISODE_RETENTION_DAYS,
    DEFAULT_SPACE_MEMORY_RETENTION_DAYS,
    Episodes,
    MemoriesView,
    MemoryConfig,
    MemoryItems,
    Profiles,
    SpaceMemories,
    SpaceMemory,
    TimeZoneNotes,
    TimeZones,
    TurnMemory,
    type MemoryConfigShape,
} from '../src/server/memory/contract.js';
import { MemoryLive } from '../src/server/memory/layer.js';
import { episodeRetentionDays, spaceMemoryRetentionDays } from '../src/server/memory/module.js';
import { retentionInForce } from '../src/server/memory/retention.js';
import { memoriesView } from '../src/server/memory/routes.js';
import { Access as RoomAccess } from '../src/server/rooms/contract.js';
import { WorkspaceSettings } from '../src/server/settings/contract.js';
import { limitDefaults } from '../src/server/settings/limits.js';
import { Access as SpaceAccess, type SpaceAccessShape } from '../src/server/spaces/contract.js';
import { Links } from '../src/server/telegram/contract.js';
import { WorkspaceLive } from '../src/server/workspace/layer.js';

import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const base = { baseUrl: '', apiKey: '', model: '', voiceName: 'marin', runtimeUrl: '' } as PlatformConfig;

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

function stores() {
    const db = testDatabase();
    const workspace = new WorkspaceStore(db);
    const store = new Store(db);
    cleanup.push(() => {
        store.close();
        workspace.close();
    });
    return { store, workspace };
}

/** What the graph offers memory's layer before its step, over one boot's stores. */
const needs = (store: Store, workspace: WorkspaceStore, config: MemoryConfigShape = {}) =>
    Layer.mergeAll(
        WorkspaceLive(workspace),
        Layer.succeed(RoomAccess, workspace.roomAccess),
        Layer.succeed(SpaceAccess, workspace.spaceAccess),
        Layer.succeed(Links, workspace.telegram),
        Layer.succeed(WorkspaceSettings, store.slices.settings),
        Layer.succeed(MemoryConfig, config),
    );

function runtimeOf<A>(layer: Layer.Layer<A>) {
    const runtime = ManagedRuntime.make(layer);
    cleanup.push(() => runtime.dispose());
    return runtime;
}

it('offers the store’s own repositories, and services that answer as the functions they wrap', async () => {
    const { store, workspace } = stores();
    const above = { telegram: workspace.telegram, spaceAccess: workspace.spaceAccess };
    const runtime = runtimeOf(MemoryLive(store, above).pipe(Layer.provide(needs(store, workspace))));
    const context = await runtime.context();
    expect(Context.get(context, MemoryItems)).toBe(store.memoryItems);
    expect(Context.get(context, Profiles)).toBe(store.profiles);
    expect(Context.get(context, TimeZoneNotes)).toBe(store.timeZoneNotes);
    expect(Context.get(context, Episodes)).toBe(store.episodes);
    expect(Context.get(context, SpaceMemories)).toBe(store.spaceMemories);

    await store.memoryItems.add({ userId: 'alice', text: 'Prefers metric units.', source: 'person' });
    await store.profiles.save('alice', { fields: { timezone: 'Europe/Madrid' }, shareable: false });
    const view = await Context.get(context, MemoriesView).view('alice');
    expect(view).toEqual(await memoriesView(store, 'alice'));
    expect(view.memories.map((memory) => memory.text)).toEqual(['Prefers metric units.']);

    const zone = await Context.get(context, TimeZones).turnTimeZone('alice');
    expect(zone).toMatchObject({ zone: 'Europe/Madrid', source: 'profile' });

    // An unknown chat counts as shared; a turn with no words recalls no Space memory.
    const turns = Context.get(context, TurnMemory);
    expect(await turns.sharedChat('nowhere', 'alice')).toBe(true);
    expect(await turns.spaceMemoryForTurn({ dotId: 'd', threadId: 't', userId: 'alice', query: ' ' })).toEqual([]);
    const personal = await turns.personalContext({ userId: 'alice', shared: false, query: 'units' });
    expect(personal.memoryIds).toHaveLength(1);
});

it('reads Space memory’s retention at each use: an admin’s over MemoryConfig’s', async () => {
    const { store, workspace } = stores();
    // An editor of every Space, so the view answers.
    const editor = { require: () => 'editor' } as unknown as SpaceAccessShape;
    const runtime = runtimeOf(
        MemoryLive(store, { telegram: workspace.telegram, spaceAccess: editor }).pipe(
            Layer.provide(needs(store, workspace, { spaceMemoryRetentionDays: 90 })),
        ),
    );
    const spaceMemory = Context.get(await runtime.context(), SpaceMemory);
    expect((await spaceMemory.view('space', 'alice')).retentionDays).toBe(90);
    await store.updateSettings({ limits: { spaceMemoryRetentionDays: 30 } });
    expect((await spaceMemory.view('space', 'alice')).retentionDays).toBe(30);
});

it('is Settings’ rule for its two limits: saved, else the environment’s, else built in', async () => {
    const { store } = stores();
    const configs: MemoryConfigShape[] = [
        {},
        { episodeRetentionDays: 90 },
        { spaceMemoryRetentionDays: 120 },
        { episodeRetentionDays: 7, spaceMemoryRetentionDays: 8 },
    ];
    for (const saved of [{}, { episodeRetentionDays: 30 }, { spaceMemoryRetentionDays: 40 }]) {
        await store.updateSettings({ limits: saved });
        for (const config of configs) {
            const settings = limitsInForce(store.settings(), limitDefaults({ ...base, ...config }));
            expect(retentionInForce(store.settings(), config)).toEqual({
                episodeRetentionDays: settings.episodeRetentionDays,
                spaceMemoryRetentionDays: settings.spaceMemoryRetentionDays,
            });
            expect(episodeRetentionDays({ store, config })).toBe(settings.episodeRetentionDays);
            expect(spaceMemoryRetentionDays({ store, config })).toBe(settings.spaceMemoryRetentionDays);
        }
    }
    await store.updateSettings({ limits: {} });
    expect(retentionInForce(store.settings(), {})).toEqual({
        episodeRetentionDays: DEFAULT_EPISODE_RETENTION_DAYS,
        spaceMemoryRetentionDays: DEFAULT_SPACE_MEMORY_RETENTION_DAYS,
    });
});

it('builds MemoryConfig from the startup configuration, not the environment', () => {
    expect(memoryConfig({})).toEqual({ episodeRetentionDays: undefined, spaceMemoryRetentionDays: undefined });
    expect(memoryConfig({ episodeRetentionDays: 30, spaceMemoryRetentionDays: 90 })).toEqual({
        episodeRetentionDays: 30,
        spaceMemoryRetentionDays: 90,
    });
});

it('is the graph’s memory step: over the boot’s store and workspace, with the graph’s Telegram links', async () => {
    const { store, workspace } = stores();
    const step = memoryLayers.bridges.pipe(
        Layer.provide(
            Layer.mergeAll(
                Layer.succeed(LegacyStore, store),
                Layer.succeed(LegacyWorkspace, workspace),
                Layer.succeed(LegacyConfig, { ...base, episodeRetentionDays: 45 }),
                WorkspaceLive(workspace),
                Layer.succeed(RoomAccess, workspace.roomAccess),
                Layer.succeed(SpaceAccess, workspace.spaceAccess),
                Layer.succeed(WorkspaceSettings, store.slices.settings),
                Layer.succeed(Links, workspace.telegram),
            ),
        ),
    );
    const context = await runtimeOf(step).context();
    expect(Context.get(context, MemoryItems)).toBe(store.memoryItems);
    expect(Context.get(context, MemoryConfig)).toEqual({
        episodeRetentionDays: 45,
        spaceMemoryRetentionDays: undefined,
    });
    expect(Context.getOrUndefined(context, Links)).toBeUndefined();
});
