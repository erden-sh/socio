// The plugins contract: the tags other features will reach `plugins/` through,
// the plugin service serving `Plugins`, and the moved constants, unchanged.
import { Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import type { User } from '@socio/shared/types';

import { catalogsFromEnv, pluginOAuthScopes } from '../src/server/plugins/catalog.js';
import {
    PLUGIN_PERSON_HEADER,
    PLUGIN_TIME_ZONE_HEADER,
    PluginCatalog,
    Plugins,
    PluginsConfig,
} from '../src/server/plugins/contract.js';
import { PluginService } from '../src/server/plugins/service.js';

import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

const ana: User = { id: 'ana', name: 'Ana', role: 'admin' };

it('declares its tags under socio/plugins', () => {
    expect(Plugins.key).toBe('socio/plugins/Plugins');
    expect(PluginCatalog.key).toBe('socio/plugins/PluginCatalog');
    expect(PluginsConfig.key).toBe('socio/plugins/PluginsConfig');
});

it('serves Plugins with the plugin service as it is', async () => {
    const db = testDatabase();
    cleanup.push(() => db.close());
    const service = new PluginService(db, {
        catalogs: catalogsFromEnv({ PLUGIN_CATALOGS: 'bundled:calendar' }),
        parentOrigin: 'https://socio.example',
        users: () => [ana],
    });
    await service.install('calendar');
    const program = Effect.gen(function* () {
        const plugins = yield* Plugins;
        return {
            ids: plugins.list().map((row) => row.id),
            mode: plugins.get('calendar')?.mode,
            mayUse: plugins.mayUse(plugins.get('calendar'), plugins.activeUser('ana')),
            parentOrigin: plugins.parentOrigin,
            actors: plugins.actors,
            launcher: plugins.launcher(ana).map((entry) => entry.id),
            target: yield* Effect.promise(() => plugins.target('calendar')),
            ended: yield* Effect.promise(() => plugins.endAccessOf('ana')),
        };
    });
    const result = await Effect.runPromise(program.pipe(Effect.provide(Layer.succeed(Plugins, service))));
    expect(result).toEqual({
        ids: ['calendar'],
        mode: 'bundled',
        mayUse: true,
        parentOrigin: 'https://socio.example',
        actors: undefined,
        launcher: ['calendar'],
        target: { state: 'not_configured' },
        ended: 0,
    });
});

it('serves PluginCatalog with the catalog scopes auth reads today', async () => {
    const catalogs = catalogsFromEnv({ PLUGIN_CATALOGS: 'bundled:calendar' });
    const program = Effect.gen(function* () {
        const catalog = yield* PluginCatalog;
        const config = yield* PluginsConfig;
        return { scopes: catalog.oauthScopes(), catalogs: config.catalogs };
    });
    const result = await Effect.runPromise(
        program.pipe(
            Effect.provide(
                Layer.mergeAll(
                    Layer.succeed(PluginCatalog, { oauthScopes: () => pluginOAuthScopes(catalogs) }),
                    Layer.succeed(PluginsConfig, { catalogs, parentOrigin: '' }),
                ),
            ),
        ),
    );
    expect(result.scopes).toEqual(pluginOAuthScopes(catalogsFromEnv({ PLUGIN_CATALOGS: 'bundled:calendar' })));
    expect(result.catalogs).toEqual(catalogs);
});

it('keeps the header names', () => {
    expect(PLUGIN_PERSON_HEADER).toBe('x-cb-person');
    expect(PLUGIN_TIME_ZONE_HEADER).toBe('x-cb-time-zone');
});
