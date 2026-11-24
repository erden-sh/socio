/**
 * What other features may know of updates (the release feed, the hand-off
 * to the updater sidecar, and the running build's releases): its tags, the
 * slice of `UpdateService` they call, its error, and plain types and
 * constants. It imports only `effect` and `@socio/*`, and holds no logic.
 *
 * The types, the error and the constants here moved from the files that defined
 * them. Their re-exports are gone, except `ReleaseData`'s at `releases.ts`
 * (`composition/http/index.ts` still names it there).
 *
 * Not here, on purpose:
 * - `releaseData` and `loadReleaseData` (`updates/releases.ts`): they read
 *   the build's files relative to their own module, so they can't move to a
 *   package. Other folders get the `Releases` tag below instead.
 * - `UpdateService`, `updatesFromEnv`, the feed and the updater client: the
 *   layer (`updates/layer.ts`) and the composition build them
 *   (`composition/updates.ts`, `index.ts`).
 * - `updateRoutes`, `releaseRoutes`, `releaseSeenRoutes` and
 *   `updatesModule`: the composition and the module registry mount them.
 */
import { Context } from 'effect';

import type { User } from '@socio/shared/types';
import type { Release } from '@socio/shared/updates/releases';
import type { UpdateFeed, UpdateSettings, UpdatesView } from '@socio/shared/updates/updates';
import type { PluginReleaseNotesCard } from '@socio/shared/updates/whats-new';

// ── Plain types and constants ─────────────────────────────────────────────

/** GitHub's API, where `github:` feeds are read unless the environment fakes it. */
export const GITHUB_API_URL = 'https://api.github.com';
/** GHCR, where `ghcr:` feeds are read unless the environment fakes it. */
export const GHCR_URL = 'https://ghcr.io';

/** Where the operator's feed read token is kept (`Store.secretSetting`). */
export const FEED_TOKEN_SETTING = 'updates.feed-token';

/** The updater sidecar the app hands an update to, over the internal network. */
export interface UpdaterEndpoint {
    /** `UPDATER_URL`, e.g. http://company-brain-updater:4350. */
    url: string;
    /** `UPDATER_TOKEN` (`UPDATER_TOKEN_FILE`): shared with the updater only. */
    token: string;
}

/**
 * UPDATES_* and UPDATER_* (CB-259), as `updatesFromEnv` reads them.
 */
export interface UpdatesEnvironment {
    /** The environment's defaults; operators' settings replace them. */
    defaults: UpdateSettings;
    /** `UPDATES_FEED_TOKEN` (`_FILE`): sent to the environment's feed only. */
    token?: string;
    /** Testing only: fakes in place of GitHub's API and GHCR. */
    githubApiUrl: string;
    ghcrUrl: string;
    updater?: UpdaterEndpoint;
    /** Why the updater is off, when UPDATER_URL is set but can't be used. */
    updaterProblem?: string;
}

/**
 * Socio's version and releases (CB-165, CB-168), from the build's
 * `releases.json` or the source tree.
 */
/**
 * Installed plugins' release notes, as What's new reads them (CB-527): the
 * composition passes the plugins' own, so updates never imports plugins.
 * Both answer only for plugins the person may open now.
 */
export interface PluginReleaseNotesSource {
    cards(person: User): Promise<PluginReleaseNotesCard[]>;
    markSeen(person: User, plugins: Readonly<Record<string, string>>): Promise<void>;
}

export interface ReleaseData {
    version: string;
    commit: string | null;
    /** Newest first. */
    releases: Release[];
}

/** The input of `PUT /api/updates/settings`; omitted fields stay. */
export interface UpdateSettingsInput {
    feed?: UpdateFeed | null;
    checkHours?: number;
    autoApply?: boolean;
    staleDays?: number;
    /** A new read token; null removes the saved one. */
    token?: string | null;
}

// ── Errors ────────────────────────────────────────────────────────────────

export type UpdatesErrorCode =
    | 'invalid'
    | 'no_feed'
    | 'not_configured'
    | 'no_backups'
    | 'unknown_release'
    | 'not_newer'
    | 'confirm_required'
    | 'busy'
    | 'updater_unavailable';

/**
 * A refused settings change or update, by code (the routes map it to a
 * status). Still a plain `Error`: `Updates` stays a promise API, which
 * other folders and the routes call, and a tagged error would change its
 * name, `String()` and JSON. It becomes tagged when the service's methods
 * return Effects.
 */
export class UpdatesError extends Error {
    constructor(
        readonly code: UpdatesErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'UpdatesError';
    }
}

// ── Services ──────────────────────────────────────────────────────────────

/**
 * What `DataKeyAdmin` (the data key's counts and re-seal), the scheduled check
 * and the `/api/updates` routes call on `UpdateService`, which implements
 * it.
 */
export interface UpdatesShape {
    /** The settings in force: an operator's over the environment's. */
    settings(): UpdateSettings & { source: 'settings' | 'environment' };
    /** Saves an operator's settings; a token goes sealed, for one feed only. */
    saveSettings(input: UpdateSettingsInput): Promise<void>;
    /** Back to the environment's settings; the saved token goes too. */
    resetSettings(): Promise<void>;
    /** Whether a scheduled check is due now. */
    due(): boolean;
    /** Checks the feed now (one check at a time); never throws. */
    check(): Promise<void>;
    /** Starts an update to `tag`; throws `UpdatesError` when it can't. */
    apply(
        tag: string,
        requestedBy: string,
        options: { confirmed: boolean },
    ): Promise<NonNullable<UpdatesView['preparing']>>;
    /** `GET /api/updates`. */
    view(): Promise<UpdatesView>;
    /** The saved token's seal, for the data key's counts (CB-62). */
    sealStates(): { current: number; previous: number; legacy: number; unknown: number };
    /** Seals the saved token again under the current data key; idempotent. */
    reseal(): Promise<{ resealed: number; unreadable: number }>;
}

export class Updates extends Context.Service<Updates, UpdatesShape>()('socio/updates/Updates') {}

/**
 * The running build's version and releases (`releaseData()`, read once):
 * the gateway's user agent, the live state's version, the release routes.
 */
export interface ReleasesShape {
    data(): ReleaseData;
}

export class Releases extends Context.Service<Releases, ReleasesShape>()('socio/updates/Releases') {}

// ── Config ───────────────────────────────────────────────────────────────

/** The `PlatformConfig` field updates reads; none when unset. */
export interface UpdatesConfigShape {
    readonly updates?: UpdatesEnvironment;
}

export class UpdatesConfig extends Context.Service<UpdatesConfig, UpdatesConfigShape>()(
    'socio/updates/UpdatesConfig',
) {}
