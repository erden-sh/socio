/**
 * Socio Secrets' construction: `workspace-secrets/layer.ts` builds the service
 * and offers it as `Secrets` and `SecretsAdmin`; this file provides its
 * `SecretsHost` (the apps, the late-bound plugins, the admins' notices from
 * `AdminNotices`), adds the tag the other steps read it from, and hands the
 * apps their redaction and setup checks.
 *
 * Socio Secrets reads no `PlatformConfig` field, so it has no `XConfig`:
 * its data keyring comes from `PlatformKeys`, which is made from the
 * supplied config (`composition/keys.ts`).
 */
import { Context, Effect, Layer } from 'effect';

import { appInRuntime } from '@socio/foundation/apps/runtime-status';

import type { AppsService } from '../apps/service.js';
import type { PluginService } from '../plugins/service.js';
import {
    makeWorkspaceSecrets,
    secretsContext,
    SecretsHost,
    type SecretsHostShape,
} from '../workspace-secrets/layer.js';
import type { WorkspaceSecrets } from '../workspace-secrets/service.js';

import { AdminNotices } from './app/notices.js';
import { LegacyApps } from './apps.js';
import { LegacyWorkspace, type PlatformNotice } from './base.js';
import { PlatformKeys } from './keys.js';
import { type PlatformPorts, Ports } from './ports.js';

/**
 * The workloads Socio Secrets serves: workspace apps in the workspace app
 * runtime, and installed service plugins through their late-bound port
 * (the plugins are built later); and the admins' notices.
 */
export function secretsHost(
    apps: AppsService,
    ports: Pick<PlatformPorts, 'plugins'>,
    notifyAdmins: (notice: PlatformNotice) => Promise<void>,
): SecretsHostShape {
    const workspaceApp = (app: ReturnType<AppsService['get']>) =>
        app && appInRuntime(app) ? { id: app.id, name: app.name, status: app.status } : undefined;
    const secretPlugin = (row: ReturnType<PluginService['get']>) =>
        row?.mode === 'service'
            ? { id: row.id, name: row.manifest.name, status: row.enabled ? 'enabled' : 'disabled' }
            : undefined;
    return {
        apps: {
            list: () => apps.all().flatMap((app) => workspaceApp(app) ?? []),
            get: (id) => workspaceApp(apps.get(id)),
            declared: (appId) => {
                const app = apps.get(appId);
                return (app && apps.promotions.manifestOf(appId, app.liveVersion)?.secrets) ?? [];
            },
        },
        plugins: {
            list: () =>
                ports.plugins
                    .get()
                    .list()
                    .flatMap((row) => secretPlugin(row) ?? []),
            get: (id) => secretPlugin(ports.plugins.get().get(id)),
            declared: (id) => {
                const row = ports.plugins.get().get(id);
                return (row?.mode === 'service' && row.manifest.secrets) || [];
            },
            identity: (id) => ports.plugins.get().identityIssue(id),
        },
        notifyAdmins: (notice) => notifyAdmins(notice),
    };
}

/** The apps keep what a workload read out of its logs, and show what it still needs. */
function useWorkloadSecrets(apps: AppsService, secrets: WorkspaceSecrets) {
    apps.useWorkloadSecrets({
        values: (appId) => secrets.redactionValues(appId),
        needsSetup: (appId) => secrets.needsSetup(appId),
    });
}

/** Socio Secrets, under the graph's `LegacyWorkspaceSecrets` tag (the class). */
export class LegacyWorkspaceSecrets extends Context.Service<LegacyWorkspaceSecrets, WorkspaceSecrets>()(
    'socio/composition/workspace-secrets/WorkspaceSecrets',
) {}

/** `SecretsHost`, over the apps, the plugins' port and the admins' notices (`AdminNotices`). */
const SecretsHostLive = Layer.effect(
    SecretsHost,
    Effect.gen(function* () {
        const notices = yield* AdminNotices;
        return secretsHost(yield* LegacyApps, yield* Ports, (notice) => notices.notifyAdmins(notice));
    }),
);

/**
 * Socio Secrets' step of the graph: `workspace-secrets/layer.ts`'s service
 * on the workspace connection and the data keyring, offered as `Secrets`,
 * `SecretsAdmin` and `LegacyWorkspaceSecrets`; the apps get its redaction
 * and setup checks.
 */
export const workspaceSecretsLayers = {
    workspaceSecrets: Layer.effectContext(
        Effect.gen(function* () {
            const { db } = yield* LegacyWorkspace;
            const { keys } = yield* PlatformKeys;
            const secrets = yield* makeWorkspaceSecrets(db, keys);
            useWorkloadSecrets(yield* LegacyApps, secrets);
            return secretsContext(secrets).pipe(Context.add(LegacyWorkspaceSecrets, secrets));
        }),
    ).pipe(Layer.provide(SecretsHostLive)),
};
