/**
 * The settings' construction: the settings layer (`settings/layer.ts`) over the
 * store's two slices, and `SettingsConfig` built here from the configuration
 * the boot step read from the environment. The boot step opens the store
 * (`index.ts`); nothing here builds anything else.
 */
import { Effect, Layer } from 'effect';

import type { SettingsConfigShape } from '../settings/contract.js';
import { SettingsLive } from '../settings/layer.js';
import { limitDefaults, type LimitSources } from '../settings/limits.js';

import { LegacyConfig, LegacyStore } from './base.js';

/** `SettingsConfig` from the configuration: the server's own limits. */
export const settingsConfig = (config: LimitSources): SettingsConfigShape => ({
    limitDefaults: limitDefaults(config),
});

/**
 * The settings' step of the graph: `WorkspaceSettings` and
 * `SecretSettings`, the core store's very slices (`CoreStore.slices`); `SettingsConfig`;
 * `Limits` over it.
 */
export const settingsLayers = {
    bridges: Layer.unwrap(
        Effect.gen(function* () {
            const store = yield* LegacyStore;
            const config = yield* LegacyConfig;
            return SettingsLive(store.slices, settingsConfig(config));
        }),
    ),
};
