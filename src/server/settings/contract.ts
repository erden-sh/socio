/**
 * What other features may know of the settings: tags and types only,
 * importing nothing from other server features.
 *
 * The settings are two slices: `WorkspaceSettings` (the settings every feature
 * reads, and their save) and `SecretSettings` (the sealed ones, CB-204). Each
 * is a tag over the methods callers use, with the signatures they have today,
 * synchronous where they are today. The core store
 * (`composition/core-store.ts`) holds both (`CoreStore.slices`, built by
 * `settingsSlices` in `store.ts`).
 *
 * What else the core store holds belongs to other features and gets its tags in
 * their contracts: the Memory context's repositories (`memoryItems`,
 * `profiles`, `timeZoneNotes`, `episodes`, `spaceMemories`), the Scheduling
 * context's tasks (`scheduled` and the task methods it forwards to it) and
 * the change counters (`live`). Those folders rank above `settings`
 * (scripts/feature-ranks.json), so this contract can't name their types.
 *
 * `Limits` is a functional tag over `limits.ts` (the limits in force, an
 * admin's over the server's); `SettingsConfig` is what settings reads of
 * the platform's configuration.
 */
import { Context } from 'effect';

import type { LimitValues } from '@socio/shared/limits';
import type { RoomLimits } from '@socio/shared/rooms/rooms';
import type { Settings } from '@socio/shared/types';

// ── Plain types ──────────────────────────────────────────────────────────

/** A secret setting as kept: its sealed value, and the URL it is for. */
export interface SecretSetting {
    value: string;
    url?: string | null;
}

/**
 * Secret settings to set (sealed) or clear (null) with a settings save,
 * from the settings as saved (`updateSettings`).
 */
export type SecretSettingChanges = (next: Settings) => Record<string, SecretSetting | null>;

/** A change to the settings: the fields to set, or worked out from the settings as saved. */
export type SettingsPatch = Partial<Settings> | ((current: Settings) => Partial<Settings>);

// ── WorkspaceSettings ────────────────────────────────────────────────────

/** The workspace's settings (`settings`): read on every use, saved by admins. */
export interface WorkspaceSettingsShape {
    settings(): Settings;
    /**
     * Live settings, or the final snapshot captured before the store closed
     * its own connection: for teardown work that outlives it.
     */
    settingsSnapshot(): Settings;
    /**
     * Saves the settings; turning work off (a pause, research or memory)
     * interrupts the tasks running, in the same unit of work (CB-110).
     * `secrets` sets (sealed) or clears secret settings with them; it may
     * throw to save nothing. A new transcription URL clears its key first
     * (CB-204). A function patch is worked out from the settings as saved,
     * inside the unit of work, so two partial changes to one nested setting
     * can't undo each other (CB-379).
     */
    updateSettings(patch: SettingsPatch, secrets?: SecretSettingChanges): Promise<Settings>;
}

export class WorkspaceSettings extends Context.Service<WorkspaceSettings, WorkspaceSettingsShape>()(
    'socio/settings/WorkspaceSettings',
) {}

// ── SecretSettings ───────────────────────────────────────────────────────

/** Settings that are secrets (CB-204): sealed values by name, never in `settings()`. */
export interface SecretSettingsShape {
    /** A secret setting's sealed value and URL. */
    secretSetting(name: string): SecretSetting | undefined;
    /** A secret setting sealed again, unless it changed meanwhile (CB-62). */
    replaceSecretSetting(name: string, previous: string, next: string): Promise<boolean>;
}

export class SecretSettings extends Context.Service<SecretSettings, SecretSettingsShape>()(
    'socio/settings/SecretSettings',
) {}

// ── Limits ───────────────────────────────────────────────────────────────

/**
 * The limits an admin tunes in Settings (CB-108) over the server's own,
 * read on every use, so a saved value applies at once (`limits.ts`).
 */
export interface LimitsShape {
    /** The limits as the environment and built-in defaults set them. */
    defaults(): LimitValues;
    /** The limits in force: an admin's over the server's. */
    inForce(settings: Settings): LimitValues;
    /** How long a turn may run now (CB-123), in ms. */
    turnTimeLimitMs(settings: Settings): number;
    /** A message's work cycle bounds in the workspace now (CB-211). */
    cycleLimits(settings: Settings): RoomLimits;
}

export class Limits extends Context.Service<Limits, LimitsShape>()('socio/settings/Limits') {}

// ── SettingsConfig ───────────────────────────────────────────────────────

/**
 * What settings reads of the platform's configuration: the server's own
 * limits, from the environment or built in (`limitDefaults(config)`).
 */
export interface SettingsConfigShape {
    readonly limitDefaults: LimitValues;
}

export class SettingsConfig extends Context.Service<SettingsConfig, SettingsConfigShape>()(
    'socio/settings/SettingsConfig',
) {}
