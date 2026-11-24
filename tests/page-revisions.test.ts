import { afterEach, expect, it } from 'vitest';

import type { Page } from '@socio/shared/pages/page-library';
import type { SearchStatsView } from '@socio/shared/pages/page-search';
import type { User } from '@socio/shared/types';

import { createApp } from '../src/server/app.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { pageAccess, pageTools } from '../src/server/pages/page-tools.js';
import { REVISION_FOLD_MS, revisionBody, revisionText } from '../src/server/pages/pages.js';

import { LocalAgentRunner, Runner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testAuth } from './helpers/test-auth.js';
import { testDatabase } from './helpers/test-database.js';
import { startWithTestPlatform } from './helpers/test-platform.js';

// Page edits keep the state they replace.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const MINUTE = 60_000;

function store() {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    return { workspace, space: workspace.spaces()[0].id };
}

const USERS: User[] = [
    { id: 'olga', name: 'Olga', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
    { id: 'dave', name: 'Dave', role: 'member' },
];

async function fixture() {
    const db = testDatabase();
    const core = new Store(testDatabase());
    const workspace = new WorkspaceStore(db);
    // The server's graph and runtime: the operator's routes read page
    // search through it (appHandle).
    const { runtime, edge, platform } = await startWithTestPlatform({
        db,
        store: core,
        workspace,
        config: {
            baseUrl: '',
            apiKey: '',
            model: '',
            voiceName: 'marin',
            runtimeUrl: '',
        },
        runner: new LocalAgentRunner(testDatabase()),
        auth: testAuth(),
    });
    cleanup.push(async () => {
        await platform.stop();
        await runtime.dispose();
        core.close();
        workspace.close();
    });
    const app = createApp({
        store: core,
        runner: new Runner(core, { mode: 'live', baseUrl: '' }),
        config: { mode: 'live', baseUrl: '' },
        edge,
        auth: {
            provider: new MockAuthProvider(USERS, 'secret-0123456789abcdef-xyz'),
            secureCookies: false,
        },
        runtime,
    });
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return async <T>(path: string, method = 'GET', body?: unknown) => {
            const response = await app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return { status: response.status, body: (await response.json()) as T };
        };
    };
    return {
        workspace,
        space: workspace.spaces()[0].id,
        olga: await as('olga'),
        bob: await as('bob'),
        dave: await as('dave'),
    };
}

it('keeps the replaced title and body when a page changes', async () => {
    const { workspace, space } = store();
    const page = await workspace.pages.create(space, {
        title: 'Plan',
        content: 'First draft',
    });
    const edited = await workspace.pages.update(
        space,
        page.id,
        { expectedRevision: 1, title: 'Plan v2', content: 'Second draft' },
        { by: 'bob', now: page.updatedAt + 1000 },
    );
    expect(edited).toMatchObject({ title: 'Plan v2', content: 'Second draft' });
    expect(workspace.pages.revisionsOf(page.id)).toEqual([
        {
            id: expect.any(Number),
            pageId: page.id,
            spaceId: space,
            revision: 1,
            title: 'Plan',
            body: 'First draft',
            authorId: 'bob',
            createdAt: page.createdAt,
            replacedAt: page.updatedAt + 1000,
        },
    ]);
    // The page itself carries no revision fields, and reads don't change.
    expect(workspace.pages.get(space, page.id)).toEqual(edited);
    expect(Object.keys(edited)).not.toContain('body');
});

it('folds one author’s saves within 10 minutes into one revision, at the editor’s autosave cadence', async () => {
    const { workspace, space } = store();
    const page = await workspace.pages.create(space, {
        title: 'Notes',
        content: '',
    });
    // The editor saves 800 ms after typing stops: an hour of steady typing
    // by one person is a save every second or so.
    const start = page.updatedAt + 1000;
    let revision = 1;
    for (let at = 0; at < 60 * MINUTE; at += 1000) {
        revision = (
            await workspace.pages.update(
                space,
                page.id,
                { expectedRevision: revision, content: `text up to ${at}` },
                { by: 'bob', now: start + at },
            )
        ).revision;
    }
    const kept = workspace.pages.revisionsOf(page.id);
    expect(kept).toHaveLength(6);
    // Newest first; each holds the state just before its 10 minutes began.
    expect(kept.map((entry) => entry.replacedAt - start).reverse()).toEqual([
        0,
        10 * MINUTE,
        20 * MINUTE,
        30 * MINUTE,
        40 * MINUTE,
        50 * MINUTE,
    ]);
    expect(kept.at(-1)).toMatchObject({ body: '', revision: 1 });
    expect(kept[0]).toMatchObject({
        body: `text up to ${50 * MINUTE - 1000}`,
        authorId: 'bob',
    });
    // A save exactly 10 minutes after the latest revision keeps another.
    await workspace.pages.update(
        space,
        page.id,
        { expectedRevision: revision, content: 'later' },
        { by: 'bob', now: start + 50 * MINUTE + REVISION_FOLD_MS },
    );
    expect(workspace.pages.revisionsOf(page.id)).toHaveLength(7);
});

it('does not fold across authors, and an unknown author never folds', async () => {
    const { workspace, space } = store();
    const page = await workspace.pages.create(space, {
        title: 'Doc',
        content: 'a',
    });
    const t = page.updatedAt;
    const save = (content: string, by: string | null, at: number) =>
        workspace.pages.update(
            space,
            page.id,
            {
                expectedRevision: workspace.pages.get(space, page.id).revision,
                content,
            },
            { by, now: t + at },
        );
    await save('b', 'bob', 1000);
    await save('c', 'bob', 2000);
    await save('d', 'dave', 3000);
    await save('e', 'bob', 4000);
    await save('f', 'dot:writer', 5000);
    await save('g', 'dot:writer', 6000);
    await save('h', null, 7000);
    await save('i', null, 8000);
    expect(
        workspace.pages
            .revisionsOf(page.id)
            .map(({ body, authorId }) => [body, authorId])
            .reverse(),
    ).toEqual([
        ['a', 'bob'],
        ['c', 'dave'],
        ['d', 'bob'],
        ['e', 'dot:writer'],
        ['g', null],
        ['h', null],
    ]);
});

it('skips saves that change neither the title nor the body', async () => {
    const { workspace, space } = store();
    const parent = await workspace.pages.create(space, { title: 'Parent' });
    const page = await workspace.pages.create(space, {
        title: 'Doc',
        content: 'a',
    });
    // The same title and body, and a move: no revision.
    let saved = await workspace.pages.update(
        space,
        page.id,
        { expectedRevision: 1, title: 'Doc', content: 'a' },
        { by: 'bob' },
    );
    saved = await workspace.pages.update(
        space,
        page.id,
        { expectedRevision: saved.revision, parentId: parent.id },
        { by: 'bob' },
    );
    expect(saved).toMatchObject({ revision: 3, parentId: parent.id });
    expect(workspace.pages.revisionsOf(page.id)).toEqual([]);
    // A title-only change keeps both.
    await workspace.pages.update(space, page.id, { expectedRevision: saved.revision, title: 'Renamed' }, { by: 'bob' });
    expect(workspace.pages.revisionsOf(page.id)).toMatchObject([{ title: 'Doc', body: 'a', revision: 3 }]);
    // A refused save (a stale revision) keeps nothing.
    await expect(
        workspace.pages.update(space, page.id, { expectedRevision: 1, content: 'stale' }, { by: 'dave' }),
    ).rejects.toThrow(/changed/);
    expect(workspace.pages.revisionsOf(page.id)).toHaveLength(1);
});

it('keeps revisions of deleted pages and their subpages, and refuses edits to them', async () => {
    const { workspace, space } = store();
    const page = await workspace.pages.create(space, {
        title: 'Doc',
        content: 'a',
    });
    const child = await workspace.pages.create(space, {
        title: 'Child',
        content: 'x',
        parentId: page.id,
    });
    await workspace.pages.update(space, page.id, { expectedRevision: 1, content: 'b' }, { by: 'bob' });
    await workspace.pages.update(space, child.id, { expectedRevision: 1, content: 'y' }, { by: 'dave' });
    await workspace.pages.delete(space, page.id, { subpages: true, by: 'bob' });
    expect(workspace.pages.revisionsOf(page.id)).toMatchObject([{ body: 'a' }]);
    expect(workspace.pages.revisionsOf(child.id)).toMatchObject([{ body: 'x' }]);
    await expect(
        workspace.pages.update(space, page.id, { expectedRevision: 2, content: 'c' }, { by: 'bob' }),
    ).rejects.toThrow('This page was deleted.');
    expect(workspace.pages.revisionsOf(page.id)).toHaveLength(1);
});

it('never finds revision text in page search', async () => {
    const { workspace, space } = store();
    const page = await workspace.pages.create(space, {
        title: 'Vendor zephyrine plan',
        content: 'The quarantined quokka budget.',
    });
    await workspace.pages.update(
        space,
        page.id,
        { expectedRevision: 1, title: 'Vendor plan', content: 'The budget.' },
        { by: 'bob' },
    );
    expect(workspace.pages.revisionsOf(page.id)).toHaveLength(1);
    for (const query of ['quokka', 'quarantined', 'zephyrine', 'quok']) {
        expect(workspace.pages.search({ query, spaces: [space], exact: true }).results, query).toEqual([]);
    }
    expect(workspace.pages.search({ query: 'budget', spaces: [space] }).results.map((hit) => hit.id)).toEqual([
        page.id,
    ]);
});

/** About 4 kB of Markdown, like the bench seed's pages. */
const markdown = (seed: number) =>
    Array.from(
        { length: 60 },
        (_, n) =>
            `## Part ${n + seed}\n\n- The vendor budget review ${(n * seed) % 7}\n- Quarter ${n % 4} invoice run and the hiring plan.`,
    )
        .join('\n\n')
        .slice(0, 4000);

it('stores revision bodies compressed and reads them back exactly', async () => {
    // Pages migration 7: Brotli, or the plain bytes when that is no smaller.
    for (const text of ['', 'a', 'Naïve — 東京 🙂\r\n', markdown(1), 'x'.repeat(100_000)]) {
        const stored = revisionBody(text);
        expect(stored.body).toBeInstanceOf(Uint8Array);
        expect(revisionText(stored.body, stored.encoding)).toBe(text);
        expect(stored.body.length).toBeLessThanOrEqual(Buffer.byteLength(text));
    }
    expect(revisionBody(markdown(1)).encoding).toBe('br');
    expect(revisionBody('a').encoding).toBe('utf8');
    expect(() => revisionText(new Uint8Array([1]), 'zstd')).toThrow(/Unknown page revision encoding/);

    const { workspace, space } = store();
    const page = await workspace.pages.create(space, {
        title: 'Handbook',
        content: markdown(1),
    });
    const bodies = [markdown(1), markdown(2), 'Café 🙂', markdown(3)];
    for (const [index, content] of bodies.slice(1).entries()) {
        await workspace.pages.update(
            space,
            page.id,
            { expectedRevision: index + 1, content },
            { by: index % 2 ? 'bob' : 'dave', now: page.updatedAt + index + 1 },
        );
    }
    expect(
        workspace.pages
            .revisionsOf(page.id)
            .map(({ body }) => body)
            .reverse(),
    ).toEqual(bodies.slice(0, -1));
    const rows = workspace.db
        .prepare('SELECT encoding, typeof(body) AS type, length(body) AS size FROM page_revisions ORDER BY id')
        .all()
        .map((row) => ({ ...row }));
    expect(rows.map(({ encoding, type }) => [encoding, type])).toEqual([
        ['br', 'blob'],
        ['br', 'blob'],
        ['utf8', 'blob'],
    ]);
    expect(Number(rows[0].size)).toBeLessThan(4000 / 3);
});

it('reports the stored, compressed size of the revisions', async () => {
    const { workspace, space } = store();
    let plain = 0;
    for (let n = 0; n < 40; n++) {
        const page = await workspace.pages.create(space, {
            title: `Page ${n}`,
            content: markdown(n),
        });
        plain += Buffer.byteLength(page.content);
        await workspace.pages.update(space, page.id, { expectedRevision: 1, content: markdown(n + 1) }, { by: 'bob' });
    }
    const stats = workspace.pages.revisionStats();
    const stored = Number(workspace.db.prepare('SELECT SUM(length(body)) AS n FROM page_revisions').get()!.n);
    expect(stats).toMatchObject({ revisions: 40, pages: 40 });
    // The table and its index on disk, holding the compressed bodies.
    expect(stats.bytes).toBeGreaterThan(stored);
    expect(stored).toBeLessThan(plain / 3);
    expect(stats.bytes).toBeLessThan(plain / 2);
});

it('records the person for API edits and the Dot for its page tools', async () => {
    const { workspace, space, bob, dave, olga } = await fixture();
    const created = await bob<Page>(`/spaces/${space}/pages`, 'POST', {
        title: 'Shared',
        content: 'one',
    });
    const page = created.body;
    const patch = (as: typeof bob, content: string) =>
        as<Page>(`/spaces/${space}/pages/${page.id}`, 'PATCH', {
            content,
            expectedRevision: workspace.pages.get(space, page.id).revision,
        });
    expect((await patch(bob, 'two')).status).toBe(200);
    expect((await patch(bob, 'three')).status).toBe(200);
    expect((await patch(dave, 'four')).status).toBe(200);
    // A Dot's edit, through its tool and through insert_dataset_view's path.
    const dot = workspace.dots()[0];
    workspace.bindThread('t1', dot.id, 'Chat', 'bob');
    const access = pageAccess(workspace, space, 't1', () => {});
    const tool = pageTools(access).find((entry) => entry.name === 'edit_space_page');
    expect(tool).toBeDefined();
    await access.edit(page.id, {
        content: 'five',
        expectedRevision: workspace.pages.get(space, page.id).revision,
    });
    expect(
        workspace.pages
            .revisionsOf(page.id)
            .map(({ body, authorId }) => [body, authorId])
            .reverse(),
    ).toEqual([
        ['one', 'bob'],
        ['three', 'dave'],
        ['four', `dot:${dot.id}`],
    ]);
    // Nobody reads revisions through the page API or the Dot's tools.
    const read = await bob<Page>(`/spaces/${space}/pages/${page.id}`);
    expect(JSON.stringify(read.body)).not.toMatch(/"three"|revisions/);
    expect(JSON.stringify(await access.read(page.id))).not.toMatch(/"three"/);
    // Operators see how many are kept; nobody else gets the route.
    const stats = await olga<SearchStatsView>('/operator/page-search');
    expect(stats.body.revisions).toMatchObject({ revisions: 3, pages: 1 });
    expect(stats.body.revisions!.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(stats.body)).not.toMatch(/"three"|"one"|"four"/);
    expect((await bob('/operator/page-search')).status).toBe(403);
});
