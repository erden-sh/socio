// Store split into WorkspaceSettings and SecretSettings: the slices are what
// the store forwards to, so the tags and the legacy facade share one state;
// `Limits` is the functional tag over limits.ts.
import { Context, Effect, Layer, ManagedRuntime } from 'effect';
import { afterEach, expect, it } from 'vitest';

import { limitsInForce } from '@socio/shared/settings/limits';
import { TRANSCRIPTION_KEY_SETTING } from '@socio/shared/voice/settings-keys';

import { LegacyConfig, LegacyStore } from '../src/server/composition/base.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { settingsLayers } from '../src/server/composition/settings.js';
import {
    Limits,
    SecretSettings,
    SettingsConfig,
    WorkspaceSettings,
    type SecretSettingsShape,
    type WorkspaceSettingsShape,
} from '../src/server/settings/contract.js';
import { SettingsLive } from '../src/server/settings/layer.js';
import { cycleLimits, limitDefaults, limitsFor, turnTimeLimitMs } from '../src/server/settings/limits.js';

import { Store } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

function store() {
    const made = new Store(testDatabase());
    cleanup.push(() => made.close());
    return made;
}

function runtimeOf(made: Store) {
    const runtime = ManagedRuntime.make(
        Layer.mergeAll(
            Layer.succeed(WorkspaceSettings, made.slices.settings),
            Layer.succeed(SecretSettings, made.slices.secrets),
        ),
    );
    cleanup.push(() => runtime.dispose());
    return runtime;
}

it('the store is both slices, and its slices satisfy the tags', () => {
    const made = store();
    const settings: WorkspaceSettingsShape = made;
    const secrets: SecretSettingsShape = made;
    expect(WorkspaceSettings.of(made.slices.settings)).toBe(made.slices.settings);
    expect(SecretSettings.of(made.slices.secrets)).toBe(made.slices.secrets);
    expect(settings.settings()).toEqual(made.slices.settings.settings());
    expect(secrets.secretSetting('missing')).toBeUndefined();
});

it('a save through the facade reads back through the tag, and the other way', async () => {
    const made = store();
    const runtime = runtimeOf(made);

    await made.updateSettings({ name: 'Garden' });
    const settings = Context.get(await runtime.context(), WorkspaceSettings);
    expect(settings.settings().name).toBe('Garden');

    await runtime.runPromise(
        WorkspaceSettings.use((slice) => Effect.promise(() => slice.updateSettings({ paused: true }))),
    );
    expect(made.settings()).toMatchObject({ name: 'Garden', paused: true });
    expect(made.settingsSnapshot()).toEqual(made.settings());
});

it('secret settings saved with the settings read back through either, and a new URL clears its key', async () => {
    const made = store();
    const runtime = runtimeOf(made);
    const transcription = { url: 'https://dictation.example.invalid', model: 'small' };

    await made.slices.settings.updateSettings({ transcription }, () => ({
        [TRANSCRIPTION_KEY_SETTING]: { value: 'sealed-1', url: transcription.url },
    }));
    expect(made.secretSetting(TRANSCRIPTION_KEY_SETTING)).toEqual({ value: 'sealed-1', url: transcription.url });

    const secrets = Context.get(await runtime.context(), SecretSettings);
    expect(await secrets.replaceSecretSetting(TRANSCRIPTION_KEY_SETTING, 'stale', 'sealed-2')).toBe(false);
    expect(await secrets.replaceSecretSetting(TRANSCRIPTION_KEY_SETTING, 'sealed-1', 'sealed-2')).toBe(true);
    expect(made.secretSetting(TRANSCRIPTION_KEY_SETTING)?.value).toBe('sealed-2');

    await made.updateSettings({ transcription: { ...transcription, url: 'https://elsewhere.example.invalid' } });
    expect(made.slices.secrets.secretSetting(TRANSCRIPTION_KEY_SETTING)).toBeUndefined();
});

it('turning work off through the slice interrupts the running tasks, as through the store', async () => {
    const made = store();
    const task = await made.createTask('Water the plants', null, 'alice');
    const claim = await made.claim();
    expect(claim?.id).toBe(task.id);

    await made.slices.settings.updateSettings({ researchAllowed: false });
    expect((await made.task(task.id))?.status).toBe('interrupted');
    expect(await made.owns(claim!)).toBe(false);
});

it('Limits over the configuration reads the same functions on every call', async () => {
    const config = { turnTimeLimitSeconds: 90 } as PlatformConfig;
    const runtime = ManagedRuntime.make(Layer.succeed(Limits, limitsFor(config)));
    cleanup.push(() => runtime.dispose());
    const limits = Context.get(await runtime.context(), Limits);
    const made = store();

    expect(limits.defaults()).toEqual(limitDefaults(config));
    expect(limits.inForce(made.settings())).toEqual(limitsInForce(made.settings(), limitDefaults(config)));
    expect(limits.turnTimeLimitMs(made.settings())).toBe(90_000);
    expect(limits.cycleLimits(made.settings())).toEqual(cycleLimits(made.settings(), config));

    await made.updateSettings({ limits: { turnTimeLimitSeconds: 120 } });
    expect(limits.turnTimeLimitMs(made.settings())).toBe(turnTimeLimitMs(made.settings(), config));
    expect(limits.turnTimeLimitMs(made.settings())).toBe(120_000);
});

it('the settings layer provides the store slices, SettingsConfig, and Limits over it', async () => {
    const made = store();
    const config = { turnTimeLimitSeconds: 90, roomCycleSpendUsd: 2 } as PlatformConfig;
    const runtime = ManagedRuntime.make(SettingsLive(made.slices, { limitDefaults: limitDefaults(config) }));
    cleanup.push(() => runtime.dispose());
    const context = await runtime.context();

    expect(Context.get(context, WorkspaceSettings)).toBe(made.slices.settings);
    expect(Context.get(context, SecretSettings)).toBe(made.slices.secrets);
    expect(Context.get(context, SettingsConfig).limitDefaults).toEqual(limitDefaults(config));

    const limits = Context.get(context, Limits);
    const over = limitsFor(config);
    expect(limits.defaults()).toEqual(over.defaults());
    expect(limits.defaults()).not.toBe(limits.defaults());
    await made.updateSettings({ limits: { turnTimeLimitSeconds: 120 } });
    expect(limits.inForce(made.settings())).toEqual(over.inForce(made.settings()));
    expect(limits.turnTimeLimitMs(made.settings())).toBe(120_000);
    expect(limits.cycleLimits(made.settings())).toEqual(over.cycleLimits(made.settings()));
    expect(limits.cycleLimits(made.settings())).toEqual(cycleLimits(made.settings(), config));
});

it("the settings' step of the graph builds from the boot step's store and config", async () => {
    const made = store();
    const config = { steeringMaxQueued: 7 } as PlatformConfig;
    const runtime = ManagedRuntime.make(
        settingsLayers.bridges.pipe(
            Layer.provide(Layer.mergeAll(Layer.succeed(LegacyStore, made), Layer.succeed(LegacyConfig, config))),
        ),
    );
    cleanup.push(() => runtime.dispose());
    const context = await runtime.context();

    expect(Context.get(context, WorkspaceSettings)).toBe(made.slices.settings);
    expect(Context.get(context, SecretSettings)).toBe(made.slices.secrets);
    expect(Context.get(context, SettingsConfig)).toEqual({ limitDefaults: limitDefaults(config) });
    expect(Context.get(context, Limits).defaults().steeringMaxQueued).toBe(7);
});
