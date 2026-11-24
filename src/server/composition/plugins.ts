/**
 * Workspace plugins' construction: `plugins/layer.ts` builds the service and
 * offers it as `Plugins` and `PluginCatalog`; this file builds `PluginsConfig`
 * from the supplied startup configuration (the `PlatformConfig` the boot step
 * built, not the environment again; moving env parsing here is a later change),
 * provides the service's `PluginsHost` (the apps runtime's client, operations'
 * and profiles' time zones, the workspace's counters), fills the late-bound port
 * and adds the tag the other steps read it from.
 */
import { Context, Effect, Layer } from 'effect';

import { operationsSettingsView } from '@socio/foundation/operations/settings-view';
import { parseRegistryCredential, PLUGIN_REGISTRY_SECRET } from '@socio/shared/plugins/registry-auth';

import { AppsRuntimeClient } from '../apps/runtime-client.js';
import { PluginsConfig, PluginsInApps, type PluginsConfigShape, type PluginsInAppsShape } from '../plugins/contract.js';
import { makePlugins, pluginsContext, PluginsHost, type PluginsHostShape } from '../plugins/layer.js';
import type { PluginService } from '../plugins/service.js';
import { PluginServiceTag } from '../plugins/tags.js';
import { Secrets, type WorkspaceSecretsShape } from '../workspace-secrets/contract.js';

import { LegacyApps } from './apps.js';
import { LegacyConfig, LegacyStore, LegacyWorkspace } from './base.js';
import type { PlatformConfig } from './config.js';
import type { CoreStore } from './core-store.js';
import { LegacyData } from './dataspace.js';
import { bindPluginDatasets } from './plugin-datasets.js';
import { Ports } from './ports.js';
import type { AppWorkspace } from './workspace-parts.js';

/**
 * What plugins read of the startup configuration: `PLUGIN_CATALOGS`,
 * `PLUGIN_SERVICE_TOKEN` (and a test's runtime), the apps' settings, the
 * apps runtime's token and ingress, and `APP_ORIGIN`.
 */
export function pluginsConfigOf(
    config: Pick<PlatformConfig, 'plugins' | 'apps' | 'appsRuntime' | 'appOrigin'>,
): PluginsConfigShape {
    return {
        catalogs: config.plugins?.catalogs ?? [],
        serviceToken: config.plugins?.serviceToken,
        runtime: config.plugins?.runtime,
        apps: config.apps,
        runtimeToken: config.appsRuntime?.token,
        ingress: config.appsRuntime?.ingress,
        parentOrigin: config.appOrigin ?? '',
    };
}

/**
 * The plugin service's host: the apps runtime's client when it is set, the
 * workspace's time zone (operations' settings), a person's (their profile)
 * and the workspace's counters.
 */
export function pluginsHost(
    store: CoreStore,
    workspace: AppWorkspace,
    config: PlatformConfig,
    secrets?: Pick<WorkspaceSecretsShape, 'platformRead'>,
): PluginsHostShape {
    return {
        appsRuntime: config.appsRuntime ? new AppsRuntimeClient(config.appsRuntime) : undefined,
        workspaceTimeZone: () => operationsSettingsView(store.slices.settings.settings(), config.operations).timeZone,
        personTimeZone: async (userId) => (await store.profiles.get(userId))?.fields.timezone,
        sync: () => workspace.counters.sync(),
        registryCredential: pluginRegistryCredential(config.plugins?.registryAuth, secrets),
    };
}

/**
 * The plugin registry login: an admin's `PLUGIN_REGISTRY_AUTH` workspace
 * secret (Settings → Secrets) when set, else the deployment's
 * `PLUGIN_REGISTRY_AUTH` (`_FILE`). Read at each use, so a new or rotated
 * secret is in force at the next provision or reconcile.
 */
export function pluginRegistryCredential(
    environment: string | undefined,
    secrets?: Pick<WorkspaceSecretsShape, 'platformRead'>,
) {
    return () => {
        const saved = secrets?.platformRead(PLUGIN_REGISTRY_SECRET, 'system:plugins');
        const text = saved ?? environment;
        return text ? parseRegistryCredential(text) : undefined;
    };
}

/** Workspace plugins, under the graph's `LegacyPlugins` tag (the class): plugins' own tag. */
export { PluginServiceTag as LegacyPlugins };

/** Binds the plugins to the mini apps, for the plugins module's `capabilities` (`PluginsInApps`). */
export const pluginsInApps = (
    apps: { usePlugins(plugins: PluginService): void },
    plugins: PluginService,
): PluginsInAppsShape => ({ usePlugins: () => apps.usePlugins(plugins) });

/** `PluginsHost`, over the store, the workspace and the startup configuration. */
const PluginsHostLive = Layer.effect(
    PluginsHost,
    Effect.gen(function* () {
        return pluginsHost(yield* LegacyStore, yield* LegacyWorkspace, yield* LegacyConfig, yield* Secrets);
    }),
);

/**
 * Plugins' step of the graph: `plugins/layer.ts`'s service on the
 * workspace connection fills its port and is offered as `Plugins`,
 * `PluginCatalog` (read from the catalog on first use) and
 * `LegacyPlugins`, with `PluginsConfig` from the supplied startup
 * configuration, and the binding to the apps (built before) the module
 * makes once (`PluginsInApps`). Built at the same point of the chain as
 * before.
 */
export const pluginsLayers = {
    plugins: Layer.effectContext(
        Effect.gen(function* () {
            const config = PluginsConfig.of(pluginsConfigOf(yield* LegacyConfig));
            const { db } = yield* LegacyWorkspace;
            const plugins = (yield* Ports).plugins.fill(
                yield* makePlugins(db).pipe(Effect.provideService(PluginsConfig, config)),
            );
            // Service plugins' dataset needs, bound to workspace datasets (CB-451): the data space is built before.
            bindPluginDatasets(plugins, yield* LegacyData);
            return pluginsContext(plugins, config).pipe(
                Context.add(PluginServiceTag, plugins),
                Context.add(PluginsConfig, config),
                Context.add(PluginsInApps, pluginsInApps(yield* LegacyApps, plugins)),
            );
        }),
    ).pipe(Layer.provide(PluginsHostLive)),
};
