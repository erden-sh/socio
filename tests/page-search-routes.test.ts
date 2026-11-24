import { afterEach, expect, it, vi } from 'vitest';

import type { Page } from '@socio/shared/pages/page-library';
import type { PageSearchResult, SearchStatsView } from '@socio/shared/pages/page-search';
import { toolActivity } from '@socio/shared/runs/run-phase';
import type { CreatedServiceKey, ServiceAccountView } from '@socio/shared/service-accounts';
import type { User } from '@socio/shared/types';

import { createApp } from '../src/server/app.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { pageAccess, pageTools } from '../src/server/pages/page-tools.js';

import { LocalAgentRunner, Runner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testAuth } from './helpers/test-auth.js';
import { testDatabase } from './helpers/test-database.js';
import { startWithTestPlatform } from './helpers/test-platform.js';

// GET /api/spaces/search, the freshness signal and the operator rollup.
const USERS: User[] = [
    { id: 'olga', name: 'Olga', role: 'admin' },
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
];
const CONFIG: PlatformConfig = {
    baseUrl: '',
    apiKey: '',
    model: '',
    voiceName: 'marin',
    runtimeUrl: '',
    sessionSecret: 'page-search-routes-secret-0123456789',
};
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

async function fixture() {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logs.push(line));
    const db = testDatabase();
    const store = new Store(testDatabase());
    const workspace = new WorkspaceStore(db);
    // The server's graph and runtime: the operator's routes read page
    // search through it (appHandle).
    const { runtime, edge, platform } = await startWithTestPlatform({
        db,
        store,
        workspace,
        config: CONFIG,
        runner: new LocalAgentRunner(testDatabase()),
        auth: testAuth(),
    });
    cleanup.push(async () => {
        await platform.stop();
        await runtime.dispose();
        store.close();
        workspace.close();
    });
    const app = createApp({
        store,
        runner: new Runner(store, { mode: 'live', baseUrl: '' }),
        config: { mode: 'live', baseUrl: '' },
        edge,
        auth: {
            provider: new MockAuthProvider(USERS, 'secret-0123456789abcdef-xyz'),
            secureCookies: false,
        },
        runtime,
    });
    const call =
        (headers: Record<string, string>) =>
        (path: string, method = 'GET', body?: unknown) =>
            app.request(`/api${path}`, {
                method,
                headers: {
                    ...headers,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        return call({ cookie: login.headers.get('set-cookie')!.split(';')[0]! });
    };
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    return { app, workspace, as, call, logs };
}
const json = async <T>(response: Response | Promise<Response>) => (await (await response).json()) as T;

it('searches every live Space for members and admins, or one Space', async () => {
    const { workspace, as, logs } = await fixture();
    const alice = await as('alice');
    const bob = await as('bob');
    const everyday = workspace.spaces()[0]!;
    const finance = workspace.createSpace('Finance', '');
    const create = (space: string, title: string, content: string) =>
        json<Page>(alice(`/spaces/${space}/pages`, 'POST', { title, content }));
    const first = await create(everyday.id, 'Offsite', 'Book the **travel** for the offsite.');
    await create(finance.id, 'Budget', 'Travel budget for the year.');
    const search = (who: typeof bob, query: string) => json<PageSearchResult>(who(`/spaces/search?${query}`));
    const member = await search(bob, 'q=travel');
    expect(member.results.map((hit) => hit.title).sort()).toEqual(['Budget', 'Offsite']);
    expect(await search(alice, 'q=travel')).toEqual(member);
    const offsite = member.results.find((hit) => hit.id === first.id)!;
    expect(offsite).toMatchObject({
        spaceId: everyday.id,
        matched: 'word',
        freshness: { basis: 'edited', at: first.updatedAt },
    });
    expect(offsite.snippet).toContainEqual({ text: 'travel', match: true });
    expect((await search(bob, `q=travel&space=${finance.id}`)).results.map((hit) => hit.title)).toEqual(['Budget']);
    // Text inside a word, a correction, and "search instead".
    expect((await search(bob, 'q=ffsit')).results.map((hit) => hit.matched)).toEqual(['text']);
    expect(await search(bob, 'q=travle')).toMatchObject({ corrected: 'travel' });
    expect(await search(bob, 'q=travle&exact=true')).toMatchObject({
        corrected: null,
        results: [],
    });
    // Unknown and deleted Spaces are 404s, as everywhere.
    workspace.db.prepare('UPDATE spaces SET deletedAt=1 WHERE id=?').run(finance.id);
    for (const space of [finance.id, 'nope']) {
        const response = await bob(`/spaces/search?q=travel&space=${space}`);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'Space not found.' });
    }
    // Limits and offsets.
    for (const query of ['limit=0', 'limit=21', 'offset=-1', 'offset=181']) {
        expect((await bob(`/spaces/search?q=travel&${query}`)).status).toBe(400);
    }
    expect(await search(bob, 'q=')).toEqual({
        query: '',
        corrected: null,
        results: [],
        more: false,
    });
    // Query text is never logged.
    expect(logs.join('\n')).not.toMatch(/travel|ffsit/);
});

it('counts a page opened from a search once per person and day', async () => {
    const { workspace, as } = await fixture();
    const alice = await as('alice');
    const bob = await as('bob');
    const space = workspace.spaces()[0]!.id;
    const page = await json<Page>(alice(`/spaces/${space}/pages`, 'POST', { title: 'Runbook', content: '' }));
    workspace.db.prepare('UPDATE pages SET updatedAt=? WHERE id=?').run(Date.now() - 200 * 86_400_000, page.id);
    for (const who of [bob, bob, alice]) {
        expect((await who(`/spaces/${space}/pages/${page.id}/used`, 'POST')).status).toBe(204);
    }
    expect(workspace.db.prepare('SELECT COUNT(*) AS n FROM page_use_days').get()).toEqual({ n: 2 });
    const [hit] = (await json<PageSearchResult>(bob('/spaces/search?q=runbook'))).results;
    expect(hit!.freshness.basis).toBe('used');
    // Who used it is never in the answer.
    expect(JSON.stringify(hit)).not.toMatch(/bob|alice/);
    // A deleted page: ignored.
    await alice(`/spaces/${space}/pages/${page.id}`, 'DELETE');
    expect((await bob(`/spaces/${space}/pages/${page.id}/used`, 'POST')).status).toBe(204);
    expect(workspace.db.prepare('SELECT COUNT(*) AS n FROM page_use_days').get()).toEqual({ n: 0 });
});

it('serves pages:read keys, and only them', async () => {
    const { workspace, as, call } = await fixture();
    const alice = await as('alice');
    const space = workspace.spaces()[0]!.id;
    await alice(`/spaces/${space}/pages`, 'POST', {
        title: 'Release notes',
        content: 'shipping',
    });
    const key = async (scopes: string[]) => {
        const made = await json<ServiceAccountView>(
            alice('/service-accounts', 'POST', {
                name: `Agent ${scopes.join()}`,
                role: 'member',
                description: '',
            }),
        );
        const created = await json<CreatedServiceKey>(
            alice(`/service-accounts/${made.id}/keys`, 'POST', {
                name: 'k',
                scopes,
                days: 30,
            }),
        );
        return call({ Authorization: `Bearer ${created.token}` });
    };
    const reader = await key(['pages:read']);
    const found = await json<PageSearchResult>(reader('/spaces/search?q=shipping'));
    expect(found.results.map((hit) => hit.title)).toEqual(['Release notes']);
    const other = await key(['issues:read']);
    expect((await other('/spaces/search?q=shipping')).status).toBe(403);
    // A key can't record uses (POST is outside its scope).
    expect((await reader(`/spaces/${space}/pages/x/used`, 'POST')).status).toBe(403);
});

it('shows operators the timing rollup, and nobody else', async () => {
    const { workspace, as } = await fixture();
    const alice = await as('alice');
    const olga = await as('olga');
    const space = workspace.spaces()[0]!.id;
    await alice(`/spaces/${space}/pages`, 'POST', {
        title: 'Plan',
        content: 'private words',
    });
    await alice('/spaces/search?q=private');
    await alice('/spaces/search?q=nothinghere');
    const stats = await json<SearchStatsView>(olga('/operator/page-search'));
    expect(stats.days[0]).toMatchObject({ queries: 2, empty: 1 });
    expect(stats.now.pages).toBe(1);
    expect(JSON.stringify(stats)).not.toMatch(/private|nothinghere/);
    // Admins are not operators here (mock auth's alice is an admin).
    expect((await (await as('bob'))('/operator/page-search')).status).toBe(403);
});

it('gives Dots search over their granted Spaces, re-checked on every call', async () => {
    const { workspace } = await fixture();
    const [everyday] = workspace.spaces();
    const secret = workspace.createSpace('Secret', '');
    const dot = workspace.dots()[0]!;
    await workspace.pages.create(everyday!.id, {
        title: 'Hiring plan',
        content: 'Interview loop for **engineers**.',
    });
    const hidden = await workspace.pages.create(secret.id, {
        title: 'Hiring freeze',
        content: 'engineers',
    });
    workspace.bindThread('t1', dot.id, 'Chat', 'bob');
    let allowed = true;
    const access = pageAccess(workspace, everyday!.id, 't1', () => {
        if (!allowed) {
            throw new Error('This turn was stopped.');
        }
    });
    const tool = pageTools(access).find((entry) => entry.name === 'search_space_pages')!;
    expect(tool).toBeDefined();
    const found = access.search({ query: 'engineers' });
    expect(found).toMatchObject({
        corrected: null,
        more: false,
        results: [
            {
                title: 'Hiring plan',
                url: expect.stringMatching(/^\/spaces\/.+\/pages\/.+$/),
                snippet: 'Interview loop for **engineers**.',
                freshness: 'Edited today',
            },
        ],
    });
    // Not granted: refused when asked for, and never searched.
    expect(() => access.search({ query: 'freeze', spaceId: secret.id })).toThrow(
        'Space access has been revoked or was not granted.',
    );
    expect(access.search({ query: 'freeze' }).results).toEqual([]);
    // Granted mid-turn: found on the next call; revoked: gone again.
    workspace.updateDot(dot.id, { ...dot, spaceIds: [everyday!.id, secret.id] });
    expect(access.search({ query: 'freeze' }).results.map((hit) => hit.id)).toEqual([hidden.id]);
    workspace.updateDot(dot.id, { ...dot, spaceIds: [everyday!.id] });
    expect(access.search({ query: 'freeze' }).results).toEqual([]);
    allowed = false;
    expect(() => access.search({ query: 'engineers' })).toThrow('stopped');
    // Reading a page counts as a use for the turn's person; not in a turn
    // nobody waits on (scheduled ones: usedBy null).
    allowed = true;
    pageAccess(workspace, everyday!.id, 't1', () => {}, null).read(found.results[0]!.id);
    expect(workspace.db.prepare('SELECT COUNT(*) AS n FROM page_use_days').get()).toEqual({ n: 0 });
    await access.read(found.results[0]!.id);
    expect(workspace.db.prepare('SELECT userId FROM page_use_days').all()).toEqual([{ userId: 'bob' }]);
    expect(toolActivity('search_space_pages')).toBe('Searching pages');
});
