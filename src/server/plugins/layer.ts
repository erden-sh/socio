/**
 * Workspace plugins' layer: one `PluginService` on the workspace connection,
 * offered as `Plugins` (what other folders read), with the catalog's
 * connected-agent scopes (`PluginCatalog`). Only the composition root
 * (`composition/plugins.ts`) and tests import this file.
 *
 * What it reads of the server's config it yields as `PluginsConfig`. What it
 * needs of the features around it at the moment of use it declares here,
 * and the composition root provides:
 *
 * - `PluginsHost`: the apps runtime's client, the workspace's and a
 *   person's time zone (operations' settings, settings' profiles), and the
 *   workspace's change counters. Those features' tags are offered after
 *   plugins' step of the graph (the bridges at its end), so the root builds
 *   the host from the classes it already holds.
 *
 * Socio-actor access (`useActors`), the active accounts (`useActiveUsers`)
 * and the apps' late binding (`usePlugins`) stay where they are wired today:
 * the plugins module's `capabilities` hook and `createApp`.
 *
 * `pluginService` makes the service the layer offers.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import type { RegistryCredential } from '@socio/shared/plugins/registry-auth';

import { pluginOAuthScopes } from './catalog.js';
import {
    PluginCatalog,
    Plugins,
    PluginsConfig,
    type PluginCatalogShape,
    type PluginRuntime,
    type PluginsConfigShape,
} from './contract.js';
import { PluginService } from './service.js';

// ── What the composition root provides ───────────────────────────────────

/** What the plugin service asks of the features around it, at the moment of use. */
export interface PluginsHostShape {
    /**
     * The apps runtime's client (`APPS_RUNTIME_URL`), where service plugins
     * run unless the config sets a runtime (tests); undefined when unset.
     */
    readonly appsRuntime?: PluginRuntime;
    /** Operations' time zone (CB-254): plugins get times in a zone, never one they assume. */
    workspaceTimeZone(): string;
    /** A person's own zone from their profile, when they set one. */
    personTimeZone(userId: string): Promise<string | undefined>;
    /** The workspace's change counters, synced around the service's first read. */
    sync(): void;
    /**
     * The registry login plugin images pull with: the `PLUGIN_REGISTRY_AUTH`
     * workspace secret over the environment's. Throws when the one in force
     * isn't valid JSON of that shape.
     */
    registryCredential?(): RegistryCredential | undefined;
}

export class PluginsHost extends Context.Service<PluginsHost, PluginsHostShape>()('socio/plugins/PluginsHost') {}

// ── The service ──────────────────────────────────────────────────────────

/** Workspace plugins: a service on the apps runtime, installed per instance. */
export function pluginService(db: DatabaseSync, config: PluginsConfigShape, host: PluginsHostShape): PluginService {
    const service = new PluginService(db, {
        catalogs: config.catalogs,
        settings: config.apps,
        runtimeToken: config.runtimeToken,
        ingress: config.ingress,
        serviceToken: config.serviceToken,
        runtime: config.runtime ?? host.appsRuntime,
        parentOrigin: config.parentOrigin,
        // Fail closed until createApp wires the auth provider's active accounts.
        users: () => [],
        // Plugins get times in a zone, never one they assume (CB-254).
        workspaceTimeZone: () => host.workspaceTimeZone(),
        personTimeZone: (userId) => host.personTimeZone(userId),
        sync: () => host.sync(),
        log: (line) => console.log(line),
    });
    if (host.registryCredential) {
        service.useRegistryCredential(() => host.registryCredential!());
    }
    return service;
}

/** `pluginService` over `PluginsConfig` and `PluginsHost`. */
export const makePlugins = (db: DatabaseSync) =>
    Effect.gen(function* () {
        const config = yield* PluginsConfig;
        const host = yield* PluginsHost;
        return pluginService(db, config, host);
    });

/** The catalog's connected-agent scopes, read from the catalog on first use. */
export function pluginCatalog(config: Pick<PluginsConfigShape, 'catalogs'>): PluginCatalogShape {
    let scopes: ReturnType<typeof pluginOAuthScopes> | undefined;
    return { oauthScopes: () => (scopes ??= pluginOAuthScopes(config.catalogs)) };
}

/** The service as `Plugins`, with the catalog's scopes (`PluginCatalog`). */
export const pluginsContext = (plugins: PluginService, config: Pick<PluginsConfigShape, 'catalogs'>) =>
    Context.make(Plugins, plugins).pipe(Context.add(PluginCatalog, pluginCatalog(config)));

/**
 * `Plugins` and `PluginCatalog`, built once over `db`; needs
 * `PluginsConfig` and `PluginsHost`.
 */
export const PluginsLive = (db: DatabaseSync) =>
    Layer.effectContext(
        Effect.gen(function* () {
            const config = yield* PluginsConfig;
            return pluginsContext(yield* makePlugins(db), config);
        }),
    );
