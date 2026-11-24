// The updates' layer and the composition's step build one `UpdateService`,
// offered under every tag, from `UpdatesConfig`, the settings' slices and the
// host.
import { Context, Effect, Layer } from 'effect';
import { expect, it } from 'vitest';

import type { SecretBox } from '@socio/foundation/keys/secret-box';
import type { Settings } from '@socio/shared/types';

import { AdminNotices } from '../src/server/composition/app/notices.js';
import { LegacyConfig, LegacyStore } from '../src/server/composition/base.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { PlatformKeys } from '../src/server/composition/keys.js';
import { platformPorts, Ports } from '../src/server/composition/ports.js';
import { LegacyUpdates, updatesLayers } from '../src/server/composition/updates.js';
import { SecretSettings, WorkspaceSettings } from '../src/server/settings/contract.js';
import { Releases, Updates, UpdatesConfig } from '../src/server/updates/contract.js';
import { UpdatesHost, UpdatesLive } from '../src/server/updates/layer.js';
import { releaseData } from '../src/server/updates/releases.js';
import { UpdateService } from '../src/server/updates/service.js';
import { updatesFromEnv } from '../src/server/updates/settings.js';

import type { Store } from './helpers/stores.js';

/** Settings kept in memory, as the store's slices offer them. */
function memorySettings() {
    let settings = {} as Settings;
    return {
        settings: () => settings,
        settingsSnapshot: () => settings,
        updateSettings: async (patch: Partial<Settings>) => (settings = { ...settings, ...patch }),
        secretSetting: () => undefined,
        replaceSecretSetting: async () => false,
    };
}

it('offers the service as Updates, from UpdatesConfig, the settings and Releases', async () => {
    const store = memorySettings();
    const layer = UpdatesLive.pipe(
        Layer.provide(
            Layer.mergeAll(
                Layer.succeed(UpdatesConfig, { updates: updatesFromEnv({ UPDATES_FEED: 'github:acme/socio' }) }),
                Layer.succeed(WorkspaceSettings, store),
                Layer.succeed(SecretSettings, store),
                Layer.succeed(Releases, {
                    data: () => ({ version: '1.2.3', commit: 'abc', releases: [] }),
                }),
                Layer.succeed(UpdatesHost, {
                    box: {} as SecretBox,
                    backups: () => undefined,
                    notifyOperators: async () => {},
                }),
            ),
        ),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    const updates = Context.get(context, Updates);
    expect(updates).toBeInstanceOf(UpdateService);
    expect(updates.settings()).toMatchObject({ feed: { kind: 'github', repository: 'acme/socio' } });
    // Saved through the settings' slice; the environment's other defaults stay.
    await updates.saveSettings({ checkHours: 6 });
    expect(store.settings().updates).toEqual({ checkHours: 6 });
    expect(updates.settings()).toMatchObject({ checkHours: 6, source: 'settings' });
    const view = await updates.view();
    expect(view.current).toEqual({ version: '1.2.3', commit: 'abc' });
    expect(view.backups).toEqual({ running: false, offsite: false });
});

it("builds the graph's step from the config and the store, under the legacy tag too", async () => {
    const store = memorySettings();
    const layer = updatesLayers.updates.pipe(
        Layer.provide(
            Layer.mergeAll(
                Layer.succeed(LegacyConfig, {} as PlatformConfig),
                Layer.succeed(LegacyStore, store as unknown as Store),
                // The settings' tags, as the graph's leaf bridges offer them.
                Layer.succeed(WorkspaceSettings, store),
                Layer.succeed(SecretSettings, store),
                Layer.succeed(AdminNotices, { notifyAdmins: async () => {}, notifyOperators: async () => {} }),
                Layer.succeed(PlatformKeys, { secret: 'secret', keys: { legacy: 'secret' } }),
                Layer.succeed(Ports, platformPorts()),
            ),
        ),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    const updates = Context.get(context, LegacyUpdates);
    expect(updates).toBeInstanceOf(UpdateService);
    expect(Context.get(context, Updates)).toBe(updates);
    expect(Context.get(context, UpdatesConfig)).toEqual({ updates: undefined });
    expect(Context.get(context, Releases).data).toBe(releaseData);
    // No environment feed: today's defaults (none, checks only by hand).
    expect(updates.settings()).toEqual({
        feed: null,
        checkHours: 0,
        autoApply: false,
        staleDays: 90,
        source: 'environment',
    });
    expect(updates.due()).toBe(false);
});
