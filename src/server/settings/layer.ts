/**
 * The settings' layers: they implement `contract.ts`. Only the composition root
 * (`composition/settings.ts`) and tests import this file.
 */
import { Effect, Layer } from 'effect';

import {
    Limits,
    SecretSettings,
    SettingsConfig,
    WorkspaceSettings,
    type SecretSettingsShape,
    type SettingsConfigShape,
    type WorkspaceSettingsShape,
} from './contract.js';
import { limitsOver } from './limits.js';

/** The two slices of the boot step's store (`Store.slices`). */
export interface SettingsSlices {
    readonly settings: WorkspaceSettingsShape;
    readonly secrets: SecretSettingsShape;
}

/**
 * `WorkspaceSettings` and `SecretSettings`: the very objects the store
 * forwards to, so the root's services and the legacy facade share one
 * state and one connection.
 */
export const SettingsSlicesLive = (slices: SettingsSlices) =>
    Layer.mergeAll(
        Layer.succeed(WorkspaceSettings, WorkspaceSettings.of(slices.settings)),
        Layer.succeed(SecretSettings, SecretSettings.of(slices.secrets)),
    );

/**
 * `Limits` over `SettingsConfig`'s defaults: a fresh copy of them on each
 * call, and the admin's saved values read on every call, as `limitsFor`
 * does over the configuration.
 */
export const LimitsLive = Layer.effect(
    Limits,
    Effect.gen(function* () {
        const { limitDefaults } = yield* SettingsConfig;
        return Limits.of(limitsOver(() => ({ ...limitDefaults })));
    }),
);

/**
 * Every settings tag: the store's slices, `SettingsConfig` as the
 * composition root built it, and `Limits` over it.
 */
export const SettingsLive = (slices: SettingsSlices, config: SettingsConfigShape) =>
    Layer.merge(SettingsSlicesLive(slices), LimitsLive).pipe(
        Layer.provideMerge(Layer.succeed(SettingsConfig, SettingsConfig.of(config))),
    );
