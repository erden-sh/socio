/**
 * Updates' layers: they implement `contract.ts`. Only the composition root
 * (`composition/updates.ts`) and tests import this file.
 *
 * What updates needs of the features below it it yields by their
 * contracts' tags: `WorkspaceSettings` and `SecretSettings` (its settings
 * and the sealed feed token), with its own `UpdatesConfig` and
 * `Releases`. What it needs of the rest it declares here, and the
 * composition root provides:
 *
 * - `UpdatesHost`: the seal for the feed token (the data keys), the
 *   backups (a late-bound port: they start after the platform is built)
 *   and `AdminNotices.notifyOperators`, read at the moment of use.
 *
 * `updateService` makes the service; both the layer and the composition's
 * builder call it (through `composition/updates.ts`), so the two
 * build the same service.
 */
import { Context, Effect, Layer } from 'effect';

import type { SecretBox } from '@socio/foundation/keys/secret-box';
import { UPDATE_STALE_DEFAULT_DAYS } from '@socio/shared/updates/updates';

import type { BackupsShape } from '../backup/contract.js';
import {
    SecretSettings,
    WorkspaceSettings,
    type SecretSettingsShape,
    type WorkspaceSettingsShape,
} from '../settings/contract.js';

import {
    GHCR_URL,
    GITHUB_API_URL,
    Releases,
    Updates,
    UpdatesConfig,
    type ReleasesShape,
    type UpdatesConfigShape,
    type UpdatesEnvironment,
} from './contract.js';
import { releaseData } from './releases.js';
import { UpdateService } from './service.js';

// ── What the composition root provides ───────────────────────────────────

/** An operator notice (`AdminNotices.notifyOperators`). */
export interface OperatorNotice {
    trigger: string;
    title: string;
    message: string;
    path: string;
}

/** What updates asks of the platform and its late-bound ports, at the moment of use. */
export interface UpdatesHostShape {
    /** Seals the feed's read token (`settings-secrets`, CB-62). */
    readonly box: SecretBox;
    /** The scheduled backups, once they run (`LeaderWork.useBackups`). */
    backups(): BackupsShape | undefined;
    /** Tells every active operator (`AdminNotices.notifyOperators`). */
    notifyOperators(notice: OperatorNotice): Promise<void>;
}

export class UpdatesHost extends Context.Service<UpdatesHost, UpdatesHostShape>()('socio/updates/UpdatesHost') {}

// ── The service ──────────────────────────────────────────────────────────

/** The environment's update settings; none configured: no feed, checks only by hand. */
export function updatesEnvironment(config: UpdatesConfigShape): UpdatesEnvironment {
    return (
        config.updates ?? {
            defaults: { feed: null, checkHours: 0, autoApply: false, staleDays: UPDATE_STALE_DEFAULT_DAYS },
            githubApiUrl: GITHUB_API_URL,
            ghcrUrl: GHCR_URL,
        }
    );
}

/** The build's releases (`releaseData()`, read once). */
export const releases: ReleasesShape = { data: releaseData };

/**
 * Updates (CB-259): the release feed's newer releases, and the hand-off to
 * the updater, over the settings' slices, the running build's releases
 * and the host.
 */
export function updateService(deps: {
    config: UpdatesConfigShape;
    settings: Pick<WorkspaceSettingsShape, 'settings' | 'updateSettings'>;
    secrets: SecretSettingsShape;
    releases: ReleasesShape;
    host: UpdatesHostShape;
}): UpdateService {
    const { settings, secrets, host } = deps;
    return new UpdateService({
        config: updatesEnvironment(deps.config),
        store: {
            settings: () => settings.settings(),
            updateSettings: (patch, changes) => settings.updateSettings(patch, changes),
            secretSetting: (name) => secrets.secretSetting(name),
            replaceSecretSetting: (name, previous, next) => secrets.replaceSecretSetting(name, previous, next),
        },
        box: host.box,
        running: () => {
            const { version, commit } = deps.releases.data();
            return { version, commit };
        },
        // The running release's date, from its release notes (CB-323).
        runningDate: () => {
            const { version, releases } = deps.releases.data();
            return releases.find((release) => release.version === version)?.date;
        },
        backups: () => host.backups(),
        notifyOperators: (notice) => host.notifyOperators(notice),
        log: (line) => console.log(line),
    });
}

/** `updateService` over its tags. */
export const makeUpdates = Effect.gen(function* () {
    return updateService({
        config: yield* UpdatesConfig,
        settings: yield* WorkspaceSettings,
        secrets: yield* SecretSettings,
        releases: yield* Releases,
        host: yield* UpdatesHost,
    });
});

/** `Releases`: the build's release data. */
export const ReleasesLive = Layer.succeed(Releases, Releases.of(releases));

/**
 * `Updates`, built once; needs `UpdatesConfig`, `WorkspaceSettings`,
 * `SecretSettings`, `Releases` and `UpdatesHost`.
 */
export const UpdatesLive = Layer.effect(Updates, makeUpdates);
