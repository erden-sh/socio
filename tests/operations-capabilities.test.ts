// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { defineTool } from '@copilotkit/runtime/v2';
import { Hono } from 'hono';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import type { CursorPage } from '@socio/shared/operations/operations';
import type {
    OpsCapabilitiesView,
    OpsKnowledgeView,
    OpsPageRow,
    OpsRequestRow,
    OpsStorage,
    OpsStorageView,
} from '@socio/shared/operations/operations-knowledge';
import { limitsInForce } from '@socio/shared/settings/limits';
import type { User } from '@socio/shared/types';

import type { ServerModule } from '../src/server/modules/contract.js';
import { serverModules } from '../src/server/modules/index.js';
import { MemoryOpsReader } from '../src/server/operations/infra/memory/reader.js';
import { capabilityCoverage } from '../src/server/operations/queries/coverage.js';
import { quotasOf } from '../src/server/operations/queries/storage.js';
import { operationsRoutes } from '../src/server/operations/routes.js';
import { limitDefaults } from '../src/server/settings/limits.js';

import { staticAuth } from './fixtures/static-auth.js';
import { makeTestRuntime, type TestRuntime } from './helpers/test-runtime.js';

// Operations → Knowledge and Capabilities (CB-191) through the API: admins
// only, the quotas in force, and the coverage matrix of socio tools.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const alice: User = { id: 'alice', name: 'Alice', role: 'admin' };
const bob: User = { id: 'bob', name: 'Bob', role: 'member' };
const DAY = 86_400_000;
const MB = 1024 * 1024;
const NOW = Date.UTC(2026, 9, 22, 12);

async function platform() {
    const test = await makeTestRuntime({
        config: { baseUrl: '', voiceName: 'marin', runtimeUrl: '' },
        modules: serverModules,
    });
    cleanup.push(test.dispose);
    return test;
}
const appFor = ({ makeApp }: TestRuntime, user: User) => makeApp({ auth: staticAuth(user) });

it('answers admins only, with no numbers until analytics runs, and the quotas in force', async () => {
    const rt = await platform();
    const built = rt.platform;
    for (const path of [
        '/api/operations/knowledge',
        '/api/operations/knowledge/pages',
        '/api/operations/knowledge/datasets?range=30d&person=alice',
        '/api/operations/storage',
        '/api/operations/capabilities',
        '/api/operations/capabilities/requests',
    ]) {
        expect((await appFor(rt, bob).request(path)).status, path).toBe(403);
        expect((await appFor(rt, alice).request(path)).status, path).toBe(200);
    }
    const app = appFor(rt, alice);
    const knowledge = (await (await app.request('/api/operations/knowledge')).json()) as OpsKnowledgeView;
    expect(knowledge).toMatchObject({
        status: { state: 'unavailable' },
        knowledge: null,
    });
    // An admin's limit over the server's: the quotas are what is in force.
    await built.store.updateSettings({ limits: { dataUserMaxMb: 5 } });
    const inForce = limitsInForce(built.store.settings(), limitDefaults(built.config));
    const storage = (await (await app.request('/api/operations/storage')).json()) as OpsStorageView;
    expect(storage.storage).toBeNull();
    expect(storage.quotas.map(({ key, limit, highest }) => ({ key, limit, highest }))).toEqual([
        { key: 'dataUserMaxMb', limit: 5, highest: null },
        { key: 'dataMaxDatasets', limit: inForce.dataMaxDatasets, highest: null },
        {
            key: 'dataDatasetMaxMb',
            limit: inForce.dataDatasetMaxMb,
            highest: null,
        },
        { key: 'dataFileMaxMb', limit: inForce.dataFileMaxMb, highest: null },
    ]);
    expect((await app.request('/api/operations/knowledge/pages?cursor=nope')).status).toBe(400);
    expect((await app.request('/api/operations/capabilities/requests?limit=0')).status).toBe(400);
});

it('counts people near and at the data space limits, never who', () => {
    const storage = {
        owners: [
            { bytes: 100 * MB, datasets: 3 },
            { bytes: 85 * MB, datasets: 50 },
            { bytes: 10 * MB, datasets: 41 },
        ],
        largestDatasetBytes: 64.04 * MB,
        largestFileBytes: 2 * MB,
    } as OpsStorage;
    const limits = {
        dataUserMaxMb: 100,
        dataMaxDatasets: 50,
        dataDatasetMaxMb: 100,
        dataFileMaxMb: 25,
    };
    expect(
        quotasOf(limits, storage).map(({ key, highest, near, at }) => ({
            key,
            highest,
            near,
            at,
        })),
    ).toEqual([
        { key: 'dataUserMaxMb', highest: 100, near: 2, at: 1 },
        { key: 'dataMaxDatasets', highest: 50, near: 2, at: 1 },
        { key: 'dataDatasetMaxMb', highest: 64, near: null, at: null },
        { key: 'dataFileMaxMb', highest: 2, near: null, at: null },
    ]);
});

it('matches modules’ tools against the registry, flagging tools no entry declares', async () => {
    const rt = await platform();
    const built = rt.platform;
    const app = appFor(rt, alice);
    const { coverage } = (await (await app.request('/api/operations/capabilities')).json()) as OpsCapabilitiesView;
    const tool = (name: string) => coverage.tools.find((t) => t.name === name);
    expect(tool('read_space_page')).toMatchObject({
        module: 'spaces',
        capability: 'pages',
        offered: true,
    });
    // The registry's own tool counts as covered.
    expect(tool('capabilities')).toMatchObject({ module: 'platform' });
    expect(coverage.unregistered).not.toContain('capabilities');
    // A skill's end and the web reads have no entry (CB-164).
    expect(coverage.unregistered).toEqual(expect.arrayContaining(['end_skill', 'http_get', 'http_json']));
    for (const row of coverage.tools.filter((t) => t.offered && t.name !== 'capabilities')) {
        expect(!!row.capability || coverage.unregistered.includes(row.name), row.name).toBe(true);
    }
    // No computer service here: its declared tools aren't given.
    expect(coverage.unoffered).toContain('computer_screenshot');
    expect(coverage.capabilities.find((capability) => capability.id === 'computer')).toMatchObject({ offered: 0 });
    // Features socios have no tools for are listed with none.
    expect(coverage.modules.find((module) => module.id === 'runs')).toEqual({
        id: 'runs',
        tools: 0,
        listed: true,
    });
    // Every module's tools could be listed for the made-up socio.
    expect(coverage.modules.filter((module) => !module.listed)).toEqual([]);
    // Research and memory are given whatever the workspace switches say now,
    // and listing never changes them.
    await built.store.updateSettings({ researchAllowed: false });
    const again = (await (await app.request('/api/operations/capabilities')).json()) as OpsCapabilitiesView;
    expect(again.coverage.tools.map((t) => t.name)).toEqual(coverage.tools.map((t) => t.name));
    expect(built.store.settings().researchAllowed).toBe(false);

    // A module whose tool no entry declares is a gap, with its calls.
    const extra: ServerModule = {
        id: 'extra',
        dotTools: () => [
            defineTool({
                name: 'mystery_tool',
                description: 'A tool for the test.',
                parameters: z.object({}),
                execute: async () => ({}),
            }),
        ],
    };
    const matrix = capabilityCoverage(
        {
            modules: [...built.modules, extra],
            context: built.context,
            capabilities: built.capabilities,
        },
        [{ tool: 'mystery_tool', calls: 4, errors: 1, refused: 0 }],
    );
    expect(matrix.unregistered).toContain('mystery_tool');
    expect(matrix.tools.find((t) => t.name === 'mystery_tool')).toEqual({
        name: 'mystery_tool',
        module: 'extra',
        capability: null,
        offered: true,
        calls: 4,
        errors: 1,
    });
});

it('pages pages, datasets and requests by cursor, with no row twice or left out', async () => {
    const pages = Array.from({ length: 130 }, (_, index) => ({
        pageId: `p${String(index).padStart(3, '0')}`,
        spaceId: index % 2 ? 's1' : 's2',
        title: `Page ${index}`,
        chars: index * 10,
        revision: 1,
        createdAt: NOW - 400 * DAY,
        // Some share a time: the id breaks the tie.
        updatedAt: NOW - Math.floor(index / 3) * 5 * DAY,
    }));
    const requests: OpsRequestRow[] = Array.from({ length: 23 }, (_, index) => ({
        issueId: `i${index}`,
        number: index + 1,
        title: `Request ${index}`,
        status: 'open',
        capability: `Thing ${index}`,
        createdAt: NOW - 10 * DAY,
        requesters: 1,
        socios: 1,
        people: 1,
        lastAt: NOW - (index % 4) * DAY,
    }));
    const reader = new MemoryOpsReader({
        knowledge: {
            spaces: [
                { id: 's1', name: 'Handbook' },
                { id: 's2', name: 'Sales' },
            ],
            pages,
            requests,
        },
    });
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
        c.set('user', alice);
        await next();
    });
    let settings = {};
    app.route(
        '/api',
        operationsRoutes({
            reader,
            settings: {
                settings: () => settings as never,
                updateSettings: async (patch) => (settings = { ...settings, ...patch }) as never,
            },
            now: () => NOW,
        }),
    );
    const all = async <T>(path: string, limit: number) => {
        const seen: T[] = [];
        let cursor: string | null = '';
        while (cursor !== null) {
            const response = await app.request(
                `${path}${path.includes('?') ? '&' : '?'}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
            );
            expect(response.status).toBe(200);
            const page = (await response.json()) as CursorPage<T>;
            seen.push(...page.items);
            cursor = page.next;
        }
        return seen;
    };
    const listed = await all<OpsPageRow>('/api/operations/knowledge/pages?range=30d', 17);
    expect(listed.map((page) => page.pageId).sort()).toEqual(pages.map((page) => page.pageId));
    // Least recently active first: the stalest pages on top.
    expect(listed[0]).toMatchObject({ stale: true, spaceName: 'Handbook' });
    expect(listed.at(-1)!.stale).toBe(false);
    for (const [a, b] of listed.slice(1).map((page, i) => [listed[i]!, page])) {
        expect(a!.activeAt <= b!.activeAt).toBe(true);
    }
    const handbook = await all<OpsPageRow>('/api/operations/knowledge/pages?space=s1', 50);
    expect(handbook).toHaveLength(65);
    const asked = await all<OpsRequestRow>('/api/operations/capabilities/requests', 5);
    expect(asked.map((request) => request.issueId).sort()).toEqual(requests.map((request) => request.issueId).sort());
    expect(asked[0]!.lastAt).toBe(NOW);
});
