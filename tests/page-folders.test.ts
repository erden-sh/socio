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

it('finds a folder by its title, with no snippet of its hidden body', async () => {
    const f = await fixture();
    await f.as('ada')(`/spaces/${f.space}/pages`, 'POST', { title: 'Garden folder', folder: true });
    await f.folder('ada', f.page.id, { folder: true });
    const found = await f.json<PageSearchResult>(
        f.as('ada')(`/spaces/search?${new URLSearchParams({ q: 'garden', space: f.space })}`),
    );
    expect(found.results.map((hit) => hit.title).sort()).toEqual(['Garden folder', 'Roadmap']);
    expect(found.results.every((hit) => hit.snippet.length === 0)).toBe(true);
    // Back into a page, its text shows in the snippet again.
    await f.folder('ada', f.page.id, { folder: false });
    const again = await f.json<PageSearchResult>(
        f.as('ada')(`/spaces/search?${new URLSearchParams({ q: 'garden', space: f.space })}`),
    );
    expect(again.results.find((hit) => hit.id === f.page.id)!.snippet.length).toBeGreaterThan(0);
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
