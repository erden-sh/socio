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
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import type { SecretBox } from '@socio/foundation/keys/secret-box';

import {
    SecretSettings,
    WorkspaceSettings,
    type SecretSettingsShape,
    type WorkspaceSettingsShape,
} from '../settings/contract.js';
import { Releases, type ReleasesShape } from '../updates/contract.js';
import { Audit, type AuditShape } from '../workspace/contract.js';

import {
    CLOUD_ISSUER_DEFAULT,
    Cloud,
    CloudConfig,
    ReplyReports,
    type CloudConfigShape,
    type CloudEnvironment,
    type CloudShape,
} from './contract.js';
import { ReplyReportsService } from './reply-reports.js';
import { CloudService } from './service.js';
import { reportsOrigin } from './settings.js';
import { CloudSocial } from './social.js';

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
    /** The workspace connection: the reply reports' outbox sits beside the reactions (CB-382). */
    readonly db: DatabaseSync;
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

/** The sealed settings' store: a secret setting is added with a settings save (its unit of work). */
function sealedStore(settings: Pick<WorkspaceSettingsShape, 'updateSettings'>, secrets: SecretSettingsShape) {
    return {
        secretSetting: (name: string) => secrets.secretSetting(name),
        replaceSecretSetting: (name: string, previous: string, next: string) =>
            secrets.replaceSecretSetting(name, previous, next),
        // This one changes no setting.
        addSecretSetting: async (name: string, value: string) => {
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
    };
}

/** The cloud connection, over the settings' slices, the running build's version and the host. */
export function cloudService(deps: {
    config: CloudConfigShape;
    settings: Pick<WorkspaceSettingsShape, 'updateSettings'>;
    secrets: SecretSettingsShape;
    releases: ReleasesShape;
    host: Pick<CloudHostShape, 'box' | 'origin' | 'notifyAdmins'>;
    transport?: typeof fetch;
    now?: () => number;
}): CloudService {
    const { settings, secrets, host } = deps;
    return new CloudService({
        config: cloudEnvironment(deps.config),
        store: sealedStore(settings, secrets),
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

/** The AI reply reports (CB-382) over the connection, the sealed settings, the audit and the host. */
export function replyReportsService(deps: {
    config: CloudConfigShape;
    cloud: Pick<CloudShape, 'status' | 'token'>;
    settings: Pick<WorkspaceSettingsShape, 'updateSettings'>;
    secrets: SecretSettingsShape;
    audit: Pick<AuditShape, 'audit'>;
    host: Pick<CloudHostShape, 'box' | 'db'>;
    transport?: typeof fetch;
    now?: () => number;
}): ReplyReportsService {
    return new ReplyReportsService({
        db: deps.host.db,
        cloud: deps.cloud,
        reportsOrigin: reportsOrigin(cloudEnvironment(deps.config)),
        box: deps.host.box,
        secrets: sealedStore(deps.settings, deps.secrets),
        audit: (entry) => deps.audit.audit(entry),
        log: (line) => console.log(line),
        transport: deps.transport,
        now: deps.now,
    });
}

/** `replyReportsService` over its tags; needs `Cloud` besides `makeCloud`'s, and `Audit`. */
export const makeReplyReports = Effect.gen(function* () {
    return replyReportsService({
        config: yield* CloudConfig,
        cloud: yield* Cloud,
        settings: yield* WorkspaceSettings,
        secrets: yield* SecretSettings,
        audit: yield* Audit,
        host: yield* CloudHost,
    });
});

/** Google and Apple sign-in's verification through the cloud (CB-570), on the issuer's origin. */
export function socialVerification(deps: {
    config: CloudConfigShape;
    cloud: Pick<CloudShape, 'status' | 'token' | 'issuerKey'>;
    transport?: typeof fetch;
    now?: () => number;
}): CloudSocial {
    return new CloudSocial({
        cloud: deps.cloud,
        issuer: cloudEnvironment(deps.config).issuer,
        log: (line) => console.log(line),
        transport: deps.transport,
        now: deps.now,
    });
}

/** `ReplyReports`, built once. */
export const ReplyReportsLive = Layer.effect(ReplyReports, makeReplyReports);
