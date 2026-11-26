/**
 * The cloud connection's layers: they implement `contract.ts`. Only the
 * composition root (`composition/cloud.ts`) and tests import this file.
 *
 * What it needs of the features below it it yields by their contracts'
 * tags: `WorkspaceSettings` and `SecretSettings` (the sealed identity) and
 * `Releases` (the running version), with its own `CloudConfig`. What it
 * needs of the rest it declares here, and the composition root provides:
 *
 * - `CloudHost`: the seal for the identity (the data keys), the app's
 *   public origin, and `AdminNotices.notifyAdmins`, read at the moment of use.
 */
import { Context, Effect, Layer } from 'effect';

import type { SecretBox } from '@socio/foundation/keys/secret-box';

import {
    SecretSettings,
    WorkspaceSettings,
    type SecretSettingsShape,
    type WorkspaceSettingsShape,
} from '../settings/contract.js';
import { Releases, type ReleasesShape } from '../updates/contract.js';

import { CLOUD_ISSUER_DEFAULT, Cloud, CloudConfig, type CloudConfigShape, type CloudEnvironment } from './contract.js';
import { CloudService } from './service.js';

// ── What the composition root provides ───────────────────────────────────

/** A notice to the admins (`AdminNotices.notifyAdmins`). */
export interface AdminNotice {
    trigger: string;
    title: string;
    message: string;
    path: string;
}

/** What the cloud connection asks of the platform, at the moment of use. */
export interface CloudHostShape {
    /** Seals the identity (`settings-secrets`, CB-62). */
    readonly box: SecretBox;
    /** The app's public origin (the first of `APP_ORIGIN`). */
    readonly origin: string | undefined;
    notifyAdmins(notice: AdminNotice): Promise<void>;
}

export class CloudHost extends Context.Service<CloudHost, CloudHostShape>()('socio/cloud/CloudHost') {}

// ── The service ──────────────────────────────────────────────────────────

/** The environment's cloud settings; none configured (a platform built without them): off. */
export function cloudEnvironment(config: CloudConfigShape): CloudEnvironment {
    return config.cloud ?? { off: true, issuer: CLOUD_ISSUER_DEFAULT };
}

/** Thrown inside a settings save to add nothing: the identity is already there. */
class AlreadyStored extends Error {}

/** The cloud connection, over the settings' slices, the running build's version and the host. */
export function cloudService(deps: {
    config: CloudConfigShape;
    settings: Pick<WorkspaceSettingsShape, 'updateSettings'>;
    secrets: SecretSettingsShape;
    releases: ReleasesShape;
    host: CloudHostShape;
    transport?: typeof fetch;
    now?: () => number;
}): CloudService {
    const { settings, secrets, host } = deps;
    return new CloudService({
        config: cloudEnvironment(deps.config),
        store: {
            secretSetting: (name) => secrets.secretSetting(name),
            replaceSecretSetting: (name, previous, next) => secrets.replaceSecretSetting(name, previous, next),
            // A secret setting is added with a settings save (its unit of work); this one changes no setting.
            addSecretSetting: async (name, value) => {
                try {
                    await settings.updateSettings({}, () => {
                        if (secrets.secretSetting(name)) {
                            throw new AlreadyStored();
                        }
                        return { [name]: { value, url: null } };
                    });
                    return true;
                } catch (error) {
                    if (error instanceof AlreadyStored) {
                        return false;
                    }
                    throw error;
                }
            },
        },
        box: host.box,
        origin: () => host.origin,
        version: () => deps.releases.data().version,
        notifyAdmins: (notice) => host.notifyAdmins(notice),
        log: (line) => console.log(line),
        transport: deps.transport,
        now: deps.now,
    });
}

/** `cloudService` over its tags. */
export const makeCloud = Effect.gen(function* () {
    return cloudService({
        config: yield* CloudConfig,
        settings: yield* WorkspaceSettings,
        secrets: yield* SecretSettings,
        releases: yield* Releases,
        host: yield* CloudHost,
    });
});

/**
 * `Cloud`, built once; needs `CloudConfig`, `WorkspaceSettings`,
 * `SecretSettings`, `Releases` and `CloudHost`.
 */
export const CloudLive = Layer.effect(Cloud, makeCloud);
