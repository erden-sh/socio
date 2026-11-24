// Workspace plugins on Effect: the layer builds one plugin service from
// `PluginsConfig` and `PluginsHost` and offers it as `Plugins`, with the
// catalog's scopes; the composition builds `PluginsConfig` from the supplied
// startup configuration.
import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import type { PlatformConfig } from '../src/server/composition/config.js';
import { pluginsConfigOf } from '../src/server/composition/plugins.js';
import { catalogsFromEnv, pluginOAuthScopes } from '../src/server/plugins/catalog.js';
import {
    PluginCatalog,
    Plugins,
    PluginsConfig,
    type PluginRuntime,
    type PluginsConfigShape,
} from '../src/server/plugins/contract.js';
import { PluginsHost, PluginsLive, type PluginsHostShape } from '../src/server/plugins/layer.js';
import { PluginService } from '../src/server/plugins/service.js';

import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

const runtime = (name: string): PluginRuntime & { name: string } => ({
    name,
    provisionService: async () => ({ state: 'running', running: 1, replicas: 1 }) as never,
    scaleService: async () => ({ state: 'running', running: 1, replicas: 1 }) as never,
    removeService: async () => undefined,
    serviceStatus: async () => undefined,
});

function host(patch: Partial<PluginsHostShape> = {}) {
    const calls = { sync: 0 };
    const shape: PluginsHostShape = {
        workspaceTimeZone: () => 'Europe/Madrid',
        personTimeZone: async (userId) => (userId === 'ana' ? 'America/New_York' : undefined),
        sync: () => {
            calls.sync += 1;
        },
        ...patch,
    };
    return { shape, calls };
}

const build = (config: PluginsConfigShape, hostShape: PluginsHostShape) => {
    const db = testDatabase();
    cleanup.push(() => db.close());
    return Effect.runPromise(
        Effect.context<Plugins | PluginCatalog>().pipe(
            Effect.provide(
                PluginsLive(db).pipe(
                    Layer.provide(Layer.succeed(PluginsConfig, config)),
                    Layer.provide(Layer.succeed(PluginsHost, hostShape)),
                ),
            ),
        ),
    );
};

it('offers one plugin service as Plugins, with the catalog scopes as PluginCatalog', async () => {
    const catalogs = catalogsFromEnv({ PLUGIN_CATALOGS: 'bundled:calendar' });
    const { shape, calls } = host();
    const context = await build({ catalogs, parentOrigin: 'https://socio.example' }, shape);
    const plugins = Context.get(context, Plugins);
    expect(plugins).toBeInstanceOf(PluginService);
    expect(plugins.parentOrigin).toBe('https://socio.example');
    expect(Context.get(context, PluginCatalog).oauthScopes()).toEqual(pluginOAuthScopes(catalogs));
    // The counters are synced around the service's first read, as before.
    expect(calls.sync).toBe(2);
    expect(await plugins.timeZoneOf('ana')).toBe('America/New_York');
    expect(await plugins.timeZoneOf('ben')).toBe('Europe/Madrid');
});

it('runs service plugins on the config runtime (tests), else the host apps runtime', async () => {
    const options = (plugins: unknown) => (plugins as { options: { runtime?: { name: string } } }).options;
    const fromHost = await build(
        { catalogs: [], parentOrigin: '' },
        host({ appsRuntime: runtime('apps-runtime') }).shape,
    );
    expect(options(Context.get(fromHost, Plugins)).runtime?.name).toBe('apps-runtime');
    const fromConfig = await build(
        { catalogs: [], parentOrigin: '', runtime: runtime('test') },
        host({ appsRuntime: runtime('apps-runtime') }).shape,
    );
    expect(options(Context.get(fromConfig, Plugins)).runtime?.name).toBe('test');
    const none = await build({ catalogs: [], parentOrigin: '' }, host().shape);
    expect(options(Context.get(none, Plugins)).runtime).toBeUndefined();
});

it('builds PluginsConfig from the supplied startup configuration', () => {
    const catalogs = catalogsFromEnv({ PLUGIN_CATALOGS: 'bundled:calendar' });
    const config = {
        plugins: { catalogs, serviceToken: 'shared-token' },
        apps: { host: 'apps.socio.example' },
        appsRuntime: { url: 'http://runtime:4330', token: 'runtime-token', ingress: { host: 'runtime', port: 4331 } },
        appOrigin: 'https://socio.example',
    } as unknown as PlatformConfig;
    expect(pluginsConfigOf(config)).toEqual({
        catalogs,
        serviceToken: 'shared-token',
        runtime: undefined,
        apps: { host: 'apps.socio.example' },
        runtimeToken: 'runtime-token',
        ingress: { host: 'runtime', port: 4331 },
        parentOrigin: 'https://socio.example',
    });
    expect(pluginsConfigOf({} as PlatformConfig)).toEqual({
        catalogs: [],
        serviceToken: undefined,
        runtime: undefined,
        apps: undefined,
        runtimeToken: undefined,
        ingress: undefined,
        parentOrigin: '',
    });
});
