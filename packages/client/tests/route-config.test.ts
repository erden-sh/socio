// @vitest-environment jsdom
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { RouteConfigEntry } from '@react-router/dev/routes';
import { matchRoutes, type RouteObject } from 'react-router';
import { expect, it, vi } from 'vitest';

import { pluginAddress } from '@socio/shared/plugins/plugins';

import { clientModules } from '../src/modules/registry';
import { moduleRoutes } from '../src/modules/routes';
import config from '../src/routes';
import type { RouteHandle } from '../src/shell/shell-context';

import { loadRouteModule } from './helpers/app-router';

vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));

const client = join(import.meta.dirname, '../src');
const flat = (entries: readonly RouteConfigEntry[]): RouteConfigEntry[] =>
    entries.flatMap((entry) => [entry, ...flat(entry.children ?? [])]);
const routes = flat(config);
const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((item) =>
        item.isDirectory() ? files(join(dir, item.name)) : [relative(client, join(dir, item.name))],
    );
const sources = files(client);

it('gives every route a unique, fixed id and a file that exists', () => {
    const ids = routes.map((entry) => entry.id);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of routes) {
        expect(existsSync(join(client, entry.file)), entry.file).toBe(true);
    }
    // Every route module is in the config (none left behind by a move).
    const used = new Set(routes.map((entry) => entry.file));
    const modules = sources.filter((file) => file.endsWith('.route.tsx'));
    expect(modules.filter((file) => !used.has(file))).toEqual([]);
});

it('matches each module gate to a registry module, and every module routes file is listed', async () => {
    const registry = new Set(clientModules.map((module) => module.id));
    const gates = routes.filter((entry) => entry.id?.startsWith('module:'));
    expect(gates.length).toBe(moduleRoutes.length);
    for (const gate of gates) {
        const id = gate.id!.slice('module:'.length);
        expect(registry.has(id as never), gate.id).toBe(true);
        // A pathless layout on the module's own gate file.
        expect(gate.path, gate.id).toBeUndefined();
        expect(gate.file, gate.id).toMatch(/^modules\/[^/]+\/gate\.route\.tsx$/);
        const module = await loadRouteModule(gate.file);
        expect((module.handle as RouteHandle).moduleId, gate.file).toBe(id);
        expect(module.ErrorBoundary, gate.file).toBeDefined();
        // The server's check of the same access rule (gateMiddleware).
        expect(module.middleware, gate.file).toHaveLength(1);
    }
    // Each module's routes.ts is one line in modules/routes.ts.
    const listed = sources.filter((file) => /^modules\/[^/]+\/routes\.ts$/.test(file));
    expect(listed.length).toBe(moduleRoutes.length);
    expect(moduleRoutes.map((entry) => entry.file.replace('gate.route.tsx', 'routes.ts')).sort()).toEqual(
        listed.sort(),
    );
});

it('keeps the route config files free of app code', () => {
    // React Router evaluates them in Node at build time, where components,
    // icons and CSS can't load.
    const configFiles = sources.filter(
        (file) => file === 'routes.ts' || file === 'modules/routes.ts' || /^modules\/[^/]+\/routes\.ts$/.test(file),
    );
    for (const file of configFiles) {
        const text = readFileSync(join(client, file), 'utf8');
        const imports = [...text.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
        for (const specifier of imports) {
            expect(
                specifier === '@react-router/dev/routes' || /(^|\/)routes$/.test(specifier!),
                `${file} imports ${specifier}`,
            ).toBe(true);
        }
    }
});

it('gives the plugin every address under /plugins/:id, exactly as pluginAddress reads it (CB-446)', () => {
    const objects = (entries: readonly RouteConfigEntry[]): RouteObject[] =>
        entries.map((entry) => ({
            id: entry.id,
            path: entry.path,
            index: entry.index,
            children: entry.children ? objects(entry.children) : undefined,
        })) as RouteObject[];
    const tree = objects(config);
    const leaf = (path: string) => matchRoutes(tree, path)?.at(-1);
    // The router, the page's frame-src (`embedOrigin`) and the bridge all
    // read the address with `pluginAddress`: they must agree on every path,
    // the odd ones included (the review's `/open//`, `/manage//`, `/%6fpen`).
    const paths = [
        '/plugins',
        '/plugins/',
        '/plugins//events',
        '/plugins/events',
        '/plugins/events/',
        '/plugins/events/events',
        '/plugins/events/events/42',
        '/plugins/events/open',
        '/plugins/events/open/',
        '/plugins/events/open//',
        '/plugins/events/OPEN',
        '/plugins/events/%6fpen',
        '/plugins/events/manage',
        '/plugins/events/manage//',
        '/plugins/events/Manage/',
        '/plugins/events/manage/x',
        '/plugins/events//x',
        '/plugins/events///',
        '/plugins/events/__cb/auth',
        '/plugins/events/a/../b',
        '/PLUGINS/events/x',
        '/Plugins/events',
        '/plugins/my%2Devents/x',
        '/plugins/EVENTS',
        '/settings/plugins/events',
        '/settings/plugins/events/',
        '/x/plugins/events',
    ];
    for (const path of paths) {
        const match = leaf(path);
        const address = pluginAddress(path);
        if (match?.route.id === 'plugins:frame') {
            expect(address?.pluginId, path).toBe(match.params.pluginId);
        } else {
            expect(address, `${path} -> ${match?.route.id}`).toBeUndefined();
        }
    }
    // No platform page under a plugin's address: settings live under Settings.
    expect(leaf('/plugins/events/manage')?.route.id).toBe('plugins:frame');
    expect(leaf('/plugins/events/open')?.route.id).toBe('plugins:frame');
    expect(leaf('/settings/plugins/events')?.route.id).toBe('plugins:manage');
    expect(leaf('/plugins')?.route.id).toBe('plugins');
    expect(leaf('/plugins/events/events/42')?.params).toMatchObject({ pluginId: 'events', '*': 'events/42' });
    // Nothing else in the table sits under /plugins/:id.
    expect(
        routes.filter((entry) => /^\/?plugins\/:pluginId\//.test(entry.path ?? '')).map((entry) => entry.id),
    ).toEqual(['plugins:frame']);
});
