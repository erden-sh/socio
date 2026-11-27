import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import { migrate } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';
import type { Page, PageSummary, PageTreeItem } from '@socio/shared/pages/page-library';
import type { SpaceRadar } from '@socio/shared/pages/page-radar';
import type { PageSearchResult } from '@socio/shared/pages/page-search';
import type { Space } from '@socio/shared/types';

import { pageAccess } from '../src/server/pages/page-tools.js';
import { pagesSchema } from '../src/server/pages/pages.js';
import { workspaceSchema } from '../src/server/workspace/workspace.js';

import { roomsFixture } from './fixtures/rooms.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

/*
 * CB-426: folders. A folder is a page marked as one (pages migration 14):
 * it shows its name and what it holds, and its body is kept but hidden.
 * Any page can be turned into a folder and back.
 */

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** Ada's private Space with Mo, and a page with text in it. */
async function fixture() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = await roomsFixture(cleanup);
    const json = async <T>(response: Promise<Response> | Response) => (await response).json() as Promise<T>;
    const made = await f.as('ada')('/spaces', 'POST', {
        name: 'Projects',
        description: 'Ada’s.',
        private: true,
        people: [{ userId: 'mo', role: 'member' }],
    });
    expect(made.status).toBe(201);
    const space = ((await made.json()) as Space).id;
    const page = await json<Page>(
        f.as('ada')(`/spaces/${space}/pages`, 'POST', { title: 'Roadmap', content: 'Ship the garden.' }),
    );
    const folder = (person: string, pageId: string, body: unknown) =>
        f.as(person)(`/spaces/${space}/pages/${pageId}/folder`, 'PUT', body);
    return { ...f, json, space, page, folder };
}

it('adds a folder mark to pages, off for every page there was (pages 14)', () => {
    const upgraded = new DatabaseSync(':memory:');
    const fresh = new DatabaseSync(':memory:');
    cleanup.push(
        () => upgraded.close(),
        () => fresh.close(),
    );
    migrate(upgraded, [workspaceSchema, { ...pagesSchema, migrations: pagesSchema.migrations!.slice(0, 13) }]);
    upgraded.exec(`INSERT INTO pages (id, spaceId, parentId, title, content, revision, createdAt, updatedAt, sourceThreadId, createdBy) VALUES
    ('p1', 's1', NULL, 'One', 'Body', 3, 1, 2, NULL, 'ada');`);
    const before = upgraded.prepare('SELECT * FROM pages').all();
    expect(migrate(upgraded, [workspaceSchema, pagesSchema])).toEqual([
        { module: 'pages', version: 14, name: 'page folders', action: 'apply' },
        { module: 'pages', version: 15, name: 'folder search rows without body', action: 'apply' },
    ]);
    expect(upgraded.prepare('SELECT * FROM pages').all()).toEqual(before.map((row) => ({ ...row, folder: 0 })));
    const column = (db: DatabaseSync) =>
        db.prepare("SELECT * FROM pragma_table_info('pages') WHERE name='folder'").get();
    migrate(fresh, [workspaceSchema, pagesSchema]);
    expect(column(upgraded)).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
    expect(column(upgraded)).toEqual(column(fresh));
});

it('lets a socio create a folder, and lists and reads it as one', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    const space = workspace.spaces()[0].id;
    const thread = workspace.bindThread('t1', workspace.dots()[0].id, 'Chat', 'bob');
    const access = pageAccess(workspace, space, thread.id, () => {});
    const folder = await access.create({ title: 'Clients', folder: true });
    const page = await access.create({ title: 'Acme notes', content: 'x', parentId: folder.id });
    expect(folder.folder).toBe(true);
    expect(page.folder).toBe(false);
    expect((await access.read(folder.id, space)).folder).toBe(true);
    expect(access.list(space).map(({ title, folder: isFolder }) => [title, isFolder])).toEqual([
        ['Clients', true],
        ['Acme notes', false],
    ]);
});

it('creates a folder, and lists it as one everywhere pages are listed', async () => {
    const f = await fixture();
    const made = await f.as('ada')(`/spaces/${f.space}/pages`, 'POST', {
        title: 'Design',
        parentId: f.page.id,
        folder: true,
    });
    expect(made.status).toBe(201);
    const folder = (await made.json()) as Page;
    expect(folder).toMatchObject({ title: 'Design', folder: true, parentId: f.page.id, content: '' });
    // A page is a page unless it says so.
    expect(f.page.folder).toBe(false);
    const tree = await f.json<PageTreeItem[]>(f.as('mo')(`/spaces/${f.space}/page-tree`));
    expect(tree).toEqual([
        { id: f.page.id, parentId: null, title: 'Roadmap', folder: false },
        { id: folder.id, parentId: f.page.id, title: 'Design', folder: true },
    ]);
    const library = await f.json<PageSummary[]>(f.as('mo')(`/spaces/${f.space}/pages`));
    expect(library.find((item) => item.id === folder.id)).toMatchObject({ folder: true });
    expect(f.workspace.pages.items(f.space).find((item) => item.id === folder.id)).toMatchObject({ folder: true });
});

it('turns a page into a folder and back for whoever may edit it, keeping its body', async () => {
    const f = await fixture();
    const turned = await f.folder('mo', f.page.id, { folder: true });
    expect(turned.status).toBe(200);
    const asFolder = (await turned.json()) as Page;
    expect(asFolder).toMatchObject({ folder: true, title: 'Roadmap', content: 'Ship the garden.' });
    // A new revision, so other tabs and devices follow; no revision of the text is kept.
    expect(asFolder.revision).toBe(f.page.revision + 1);
    expect(f.workspace.pages.revisionsOf(f.page.id)).toEqual([]);
    // The library hides a folder's body: no excerpt of it.
    const library = await f.json<PageSummary[]>(f.as('ada')(`/spaces/${f.space}/pages`));
    expect(library.find((item) => item.id === f.page.id)).toMatchObject({ folder: true, excerpt: '' });
    // The same again changes nothing.
    const again = await f.json<Page>(f.folder('ada', f.page.id, { folder: true }));
    expect(again.revision).toBe(asFolder.revision);
    // Back into a page: the text is all there.
    const back = await f.json<Page>(f.folder('ada', f.page.id, { folder: false }));
    expect(back).toMatchObject({ folder: false, content: 'Ship the garden.', revision: asFolder.revision + 1 });
    const read = await f.json<Page>(f.as('mo')(`/spaces/${f.space}/pages/${f.page.id}`));
    expect(read).toMatchObject({ folder: false, content: 'Ship the garden.' });
    // An editor's save on the new revision goes through.
    expect(
        (
            await f.as('ada')(`/spaces/${f.space}/pages/${f.page.id}`, 'PATCH', {
                title: 'Roadmap, kept',
                expectedRevision: back.revision,
            })
        ).status,
    ).toBe(200);
});

it('refuses the switch to anyone who may not edit the page', async () => {
    const f = await fixture();
    // Outside the private Space: as for a Space that isn't there.
    const outside = await f.folder('nina', f.page.id, { folder: true });
    expect(outside.status).toBe(404);
    expect(await outside.json()).toEqual({ error: 'Space not found.' });
    // Someone who reads it but may not edit its pages (a read-only key).
    vi.spyOn(f.workspace.pages, 'canEdit').mockReturnValue(false);
    const reader = await f.folder('mo', f.page.id, { folder: true });
    expect(reader.status).toBe(403);
    vi.mocked(f.workspace.pages.canEdit).mockRestore();
    // Not a yes or no.
    for (const body of [{}, { folder: 'yes' }, { folder: true, title: 'x' }]) {
        expect((await f.folder('ada', f.page.id, body)).status).toBe(400);
    }
    // Nothing changed.
    expect(f.workspace.pages.get(f.space, f.page.id)).toMatchObject({ folder: false, revision: f.page.revision });
    // A deleted page, as any other edit of it.
    expect((await f.as('ada')(`/spaces/${f.space}/pages/${f.page.id}`, 'DELETE')).status).toBe(200);
    expect((await f.folder('ada', f.page.id, { folder: true })).status).toBe(410);
});

it('keeps a folder a folder when it moves to another Space', async () => {
    const f = await fixture();
    const folder = await f.json<Page>(
        f.as('ada')(`/spaces/${f.space}/pages`, 'POST', { title: 'Archive', folder: true }),
    );
    const inside = await f.json<Page>(
        f.as('ada')(`/spaces/${f.space}/pages`, 'POST', { title: 'Old notes', parentId: folder.id }),
    );
    const open = f.company.spaceId;
    const moved = await f.as('ada')(`/spaces/${f.space}/pages/${folder.id}/move`, 'POST', { spaceId: open });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { page: Page }).page).toMatchObject({ spaceId: open, folder: true });
    expect(f.workspace.pages.get(open, folder.id).folder).toBe(true);
    expect(f.workspace.pages.get(open, inside.id)).toMatchObject({ folder: false, parentId: folder.id });
});

/** What a search finds, by title, with each hit's snippet as text. */
const hitsOf = (found: PageSearchResult) =>
    found.results.map((hit) => [hit.title, hit.snippet.map((part) => part.text).join('')]);

it('finds a folder by its title only, with no snippet; never by its hidden body', async () => {
    const f = await fixture();
    await f.as('ada')(`/spaces/${f.space}/pages`, 'POST', { title: 'Garden folder', folder: true });
    const search = async (q: string) =>
        f.json<PageSearchResult>(f.as('ada')(`/spaces/search?${new URLSearchParams({ q, space: f.space })}`));
    // A page: found by its body, with a snippet of it.
    expect(hitsOf(await search('garden'))).toEqual([
        ['Garden folder', ''],
        ['Roadmap', 'Ship the garden.'],
    ]);
    // Into a folder: its body alone no longer finds it, by word, inside a word or as a typo.
    await f.folder('ada', f.page.id, { folder: true });
    expect(hitsOf(await search('garden'))).toEqual([['Garden folder', '']]);
    expect(hitsOf(await search('ship'))).toEqual([]);
    expect(hitsOf(await search('arde'))).toEqual([['Garden folder', '']]);
    expect((await search('shiip')).corrected).toBeNull();
    // Its title still finds it, with no snippet.
    expect(hitsOf(await search('roadmap'))).toEqual([['Roadmap', '']]);
    // Back into a page, its body finds it again, with a snippet.
    await f.folder('ada', f.page.id, { folder: false });
    expect(hitsOf(await search('ship'))).toEqual([['Roadmap', 'Ship the garden.']]);
});

it('keeps a folder’s body out of search through a combined edit and a move to another Space', async () => {
    const f = await fixture();
    const search = (spaceId: string, query: string) => hitsOf(f.workspace.pages.search({ query, spaces: [spaceId] }));
    // A patch that makes it a folder, then one that turns it back.
    const asFolder = await f.json<Page>(
        f.as('ada')(`/spaces/${f.space}/pages/${f.page.id}`, 'PATCH', {
            folder: true,
            expectedRevision: f.page.revision,
        }),
    );
    expect(search(f.space, 'ship')).toEqual([]);
    // A move to another Space keeps it out.
    const open = f.company.spaceId;
    expect((await f.as('ada')(`/spaces/${f.space}/pages/${f.page.id}/move`, 'POST', { spaceId: open })).status).toBe(
        200,
    );
    expect(search(open, 'ship')).toEqual([]);
    expect(search(open, 'roadmap')).toEqual([['Roadmap', '']]);
    await f.workspace.pages.update(open, f.page.id, { folder: false, expectedRevision: asFolder.revision + 1 });
    expect(search(open, 'ship')).toEqual([['Roadmap', 'Ship the garden.']]);
});

it('keeps a folder’s body out of a socio’s page search', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    const space = workspace.spaces()[0].id;
    const thread = workspace.bindThread('t1', workspace.dots()[0].id, 'Chat', 'bob');
    const access = pageAccess(workspace, space, thread.id, () => {});
    const folder = await access.create({ title: 'Clients', content: 'Sprocket invoices.', folder: true });
    await access.create({ title: 'Sprocket box', folder: true });
    const titles = async (query: string) =>
        (await access.search({ query, spaceId: space })).results.map((hit) => [hit.title, hit.snippet]);
    expect(await titles('sprocket')).toEqual([['Sprocket box', '']]);
    expect(await titles('clients')).toEqual([['Clients', '']]);
    await workspace.pages.setFolder(space, folder.id, false);
    expect(await titles('invoices')).toEqual([['Clients', 'Sprocket **invoices**.']]);
});

it('drops the body of the folders there are from their search rows, and only theirs (pages 15)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [workspaceSchema, { ...pagesSchema, migrations: pagesSchema.migrations!.slice(0, 14) }]);
    db.exec(`INSERT INTO pages (id, spaceId, parentId, title, content, revision, createdAt, updatedAt, sourceThreadId, createdBy, folder) VALUES
    ('p1', 's1', NULL, 'Clients', 'Sprocket invoices', 1, 1, 1, NULL, 'ada', 1),
    ('p2', 's1', NULL, 'Notes', 'Sprocket notes', 1, 1, 1, NULL, 'ada', 0);
    INSERT INTO page_search (pageId, spaceId, title, body) VALUES ('p1', 's1', 'Clients', 'Sprocket invoices'), ('p2', 's1', 'Notes', 'Sprocket notes');`);
    const matches = (q: string) =>
        db
            .prepare(
                'SELECT s.pageId FROM page_search_fts f JOIN page_search s ON s.id = f.rowid WHERE page_search_fts MATCH ? ORDER BY s.pageId',
            )
            .all(q)
            .map((row) => row.pageId);
    expect(matches('sprocket')).toEqual(['p1', 'p2']);
    migrate(db, [workspaceSchema, pagesSchema]);
    expect(matches('sprocket')).toEqual(['p2']);
    expect(matches('clients')).toEqual(['p1']);
    expect(db.prepare('SELECT pageId, body FROM page_search ORDER BY pageId').all()).toEqual([
        { pageId: 'p1', body: '' },
        { pageId: 'p2', body: 'Sprocket notes' },
    ]);
});

it('keeps a folder’s hidden body out of the Space’s radar: no excerpt and no open decision from it', async () => {
    const f = await fixture();
    const plan = await f.json<Page>(
        f.as('ada')(`/spaces/${f.space}/pages`, 'POST', {
            title: 'Plans',
            content: 'TBD: kept body should be hidden.',
        }),
    );
    const radar = () => f.json<SpaceRadar>(f.as('ada')(`/spaces/${f.space}/radar`));
    const before = await radar();
    expect(before.recent.find((entry) => entry.id === plan.id)?.excerpt).toContain('kept body');
    expect(before.open.some((entry) => entry.id === plan.id)).toBe(true);

    await f.folder('ada', plan.id, { folder: true });
    const folded = await radar();
    expect(folded.recent.find((entry) => entry.id === plan.id)?.excerpt).toBe('');
    expect(folded.open.some((entry) => entry.id === plan.id)).toBe(false);
    expect(JSON.stringify(folded)).not.toContain('kept body');

    // Back into a page, its text and its open decision show again.
    await f.folder('ada', plan.id, { folder: false });
    expect((await radar()).open.some((entry) => entry.id === plan.id)).toBe(true);
});

it('checks a folder switch’s expected revision in the unit that writes it, behind an edit that lands first', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const space = workspace.spaces()[0].id;
    const page = await workspace.pages.create(space, { title: 'Notes', content: 'Mine.' });
    const { uow } = sqliteData(workspace.db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Another edit, its unit open first and committing revision 2 after the switch was asked for.
    const other = uow.run(
        async () => {
            await gate;
            await workspace.pages.update(space, page.id, { content: 'Theirs.', expectedRevision: 1 });
        },
        { label: 'another edit' },
    );
    while (!uow.foreignUnit) {
        await Promise.resolve();
    }
    const stale = workspace.pages.setFolder(space, page.id, true, { expectedRevision: 1 });
    const combined = workspace.pages.update(space, page.id, { title: 'Mine', folder: true, expectedRevision: 1 });
    release();
    await other;
    await expect(stale).rejects.toMatchObject({ status: 409 });
    await expect(combined).rejects.toMatchObject({ status: 409 });
    expect(workspace.pages.get(space, page.id)).toMatchObject({
        title: 'Notes',
        content: 'Theirs.',
        folder: false,
        revision: 2,
    });
    // At the current revision, both go, each one revision.
    expect(await workspace.pages.setFolder(space, page.id, true, { expectedRevision: 2 })).toMatchObject({
        folder: true,
        revision: 3,
    });
    expect(
        await workspace.pages.update(space, page.id, { title: 'Mine', folder: false, expectedRevision: 3 }),
    ).toMatchObject({ title: 'Mine', folder: false, content: 'Theirs.', revision: 4 });
});
