import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DataError } from '@socio/foundation/dataspace/data-error';
import { WORKSPACE_OWNER_ID, type DatasetView } from '@socio/shared/data-types';
import type { PageTreeItem } from '@socio/shared/pages/page-library';
import {
    SPACE_PLACE_REFUSED,
    spaceItemKey,
    spaceItemTree,
    spaceItemVersion,
    type PrivateItemsResponse,
    type SpaceDatasetItem,
    type SpaceItemsResponse,
} from '@socio/shared/spaces/space-items';
import type { Space } from '@socio/shared/types';

import { dataSchema } from '../src/server/dataspace/migrations.js';

import { roomsFixture } from './fixtures/rooms.js';

// Datasets in Spaces (CB-451): a Space's items list (pages and
// the datasets placed in it), editor-only placement, datasets under pages
// and never the reverse, existing shares at the root, the Private group per
// person, and plugin datasets only where an admin placed them.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const json = async <T>(response: Promise<Response> | Response) => (await response).json() as Promise<T>;

/**
 * Ada's private Space "Deals" (she is its editor, Mo its member), with a
 * page tree: Plan > Detail, and Notes. Alice is a workspace admin, Nina is
 * outside it. The workspace's open Space is read by every member.
 */
async function fixture() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = await roomsFixture(cleanup);
    const made = await f.as('ada')('/spaces', 'POST', {
        name: 'Deals',
        description: 'Not for everyone.',
        private: true,
        people: [{ userId: 'mo', role: 'member' }],
    });
    expect(made.status).toBe(201);
    const deals = ((await made.json()) as Space).id;
    const other = (
        (await json<Space>(
            f.as('ada')('/spaces', 'POST', { name: 'Elsewhere', description: '', private: true }),
        )) as Space
    ).id;
    const page = async (spaceId: string, title: string, parentId: string | null = null) =>
        (await json<{ id: string }>(f.as('ada')(`/spaces/${spaceId}/pages`, 'POST', { title, content: '', parentId })))
            .id;
    const plan = await page(deals, 'Plan');
    const detail = await page(deals, 'Detail', plan);
    const notes = await page(deals, 'Notes');
    const dataset = async (who: string, name: string, place?: { sharedSpaceId: string; spaceParentId?: string }) => {
        const response = await f.as(who)('/data/datasets', 'POST', { name, ...place });
        expect(response.status, name).toBe(201);
        return json<DatasetView>(response);
    };
    const items = (who: string, spaceId = deals) => f.as(who)(`/spaces/${spaceId}/items`);
    /** A table `orders` with two rows, written by the company socio with a grant (approved). */
    const seed = async (owner: string, datasetId: string) => {
        f.platform.data.setGrant(owner, { dotId: f.company.id, datasetId, access: 'write' });
        const actor = { kind: 'dot' as const, userId: owner, dotId: f.company.id };
        await f.platform.data.write(
            actor,
            datasetId,
            { op: 'create_table', input: { table: 'orders', columns: [{ name: 'total', type: 'REAL' }] } },
            true,
        );
        await f.platform.data.write(
            actor,
            datasetId,
            { op: 'insert', table: 'orders', rows: [{ total: 1 }, { total: 2 }] },
            true,
        );
    };
    /** A conditional poll: `If-None-Match` with a tag the person was given. */
    const poll = async (who: string, path: string, etag: string) => {
        const login = await f.app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: who }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        return f.app.request(`/api${path}`, { headers: { cookie, 'If-None-Match': etag } });
    };
    return { ...f, deals, other, open: f.company.spaceId, plan, detail, notes, page, dataset, items, poll, seed };
}

const shape = (answer: SpaceItemsResponse | PrivateItemsResponse) =>
    answer.items.map((item) => [item.kind, item.title, item.parentId]);

describe('GET /api/spaces/:spaceId/items', () => {
    it('lists the pages and the datasets placed in the Space in tree order, the same for every reader', async () => {
        const f = await fixture();
        const pipeline = await f.dataset('ada', 'Pipeline', { sharedSpaceId: f.deals, spaceParentId: f.plan });
        const leads = await f.dataset('ada', 'Leads');
        expect((await f.as('ada')(`/data/datasets/${leads.id}`, 'PATCH', { sharedSpaceId: f.deals })).status).toBe(200);
        const asMo = await json<SpaceItemsResponse>(f.items('mo'));
        expect(asMo.schema).toBe(1);
        expect(asMo.spaceId).toBe(f.deals);
        expect(shape(asMo)).toEqual([
            ['page', 'Plan', null],
            ['page', 'Detail', f.plan],
            ['dataset', 'Pipeline', f.plan],
            ['page', 'Notes', null],
            ['dataset', 'Leads', null],
        ]);
        const item = asMo.items.find((entry) => entry.id === pipeline.id) as SpaceDatasetItem;
        expect(item).toMatchObject({ kind: 'dataset', owner: 'person', tables: [] });
        expect(item.version).toBe(spaceItemVersion(item));
        expect(item.position).toMatch(/^\d{15}\./);
        const page = asMo.items.find((entry) => entry.id === f.plan)!;
        expect(page.version).toBe(1);
        expect(page.position).toMatch(new RegExp(`^\\d{15}\\.${f.plan}$`));
        // Every reader gets the same answer: its editor, its member, an admin.
        expect(await json(f.items('ada'))).toEqual(asMo);
        expect(await json(f.items('alice'))).toEqual(asMo);
        // Outside the private Space: the same 404 as one that isn't there.
        expect((await f.items('nina')).status).toBe(404);
        expect((await f.items('nina', 'no-such-space')).status).toBe(404);
        // The page tree stays pages only.
        const tree = await json<PageTreeItem[]>(f.as('mo')(`/spaces/${f.deals}/page-tree`));
        expect(tree.map((entry) => entry.title)).toEqual(['Plan', 'Detail', 'Notes']);
    });

    it('lists a dataset’s tables with their row counts', async () => {
        const f = await fixture();
        const sales = await f.dataset('ada', 'Sales');
        await f.seed('ada', sales.id);
        expect((await f.as('ada')(`/data/datasets/${sales.id}`, 'PATCH', { sharedSpaceId: f.deals })).status).toBe(200);
        const listed = (await json<SpaceItemsResponse>(f.items('mo'))).items.find(
            (entry) => entry.id === sales.id,
        ) as SpaceDatasetItem;
        expect(listed.tables).toEqual([{ name: 'orders', title: 'orders', rows: 2, analytical: false }]);
        expect(listed.version).toBe(spaceItemVersion(listed));
    });

    it('answers 304 until something it lists changes', async () => {
        const f = await fixture();
        const pipeline = await f.dataset('ada', 'Pipeline', { sharedSpaceId: f.deals });
        const path = `/spaces/${f.deals}/items`;
        const tag = (await f.items('mo')).headers.get('etag')!;
        expect(tag).toBeTruthy();
        expect((await f.poll('mo', path, tag)).status).toBe(304);
        // A rename of a dataset in it changes the answer.
        await f.as('ada')(`/data/datasets/${pipeline.id}`, 'PATCH', { name: 'Funnel' });
        expect((await f.poll('mo', path, tag)).status).toBe(200);
        const renamed = (await f.items('mo')).headers.get('etag')!;
        // So does a write to its tables (their row counts).
        await f.seed('ada', pipeline.id);
        expect((await f.poll('mo', path, renamed)).status).toBe(200);
        const written = (await f.items('mo')).headers.get('etag')!;
        // And an edit of one of its pages.
        await f.as('ada')(`/spaces/${f.deals}/pages/${f.notes}`, 'PATCH', { title: 'Notes 2', expectedRevision: 1 });
        expect((await f.poll('mo', path, written)).status).toBe(200);
        const edited = (await f.items('mo')).headers.get('etag')!;
        // A dataset placed in another Space changes nothing here.
        await f.dataset('ada', 'Elsewhere data', { sharedSpaceId: f.other });
        expect((await f.poll('mo', path, edited)).status).toBe(304);
    });
});

describe('placing datasets (editors only)', () => {
    it('lets only the Space’s editors who manage a dataset place it; a reader gets 403, an outsider 404', async () => {
        const f = await fixture();
        const mine = await f.dataset('mo', 'Mine');
        // Mo reads Deals but doesn't edit it.
        const refused = await f.as('mo')(`/data/datasets/${mine.id}`, 'PATCH', { sharedSpaceId: f.deals });
        expect(refused.status).toBe(403);
        expect(await refused.json()).toEqual({ error: SPACE_PLACE_REFUSED });
        // The open Space: every member reads it, none edits it.
        expect((await f.as('mo')(`/data/datasets/${mine.id}`, 'PATCH', { sharedSpaceId: f.open })).status).toBe(403);
        // "New dataset" in a Space: refused before anything is made.
        const before = await json<PrivateItemsResponse>(f.as('mo')('/data/private-items'));
        expect((await f.as('mo')('/data/datasets', 'POST', { name: 'New', sharedSpaceId: f.deals })).status).toBe(403);
        expect(await json(f.as('mo')('/data/private-items'))).toEqual(before);
        // Nina can't read Deals: as if it weren't there.
        const hers = await f.dataset('nina', 'Hers');
        expect((await f.as('nina')(`/data/datasets/${hers.id}`, 'PATCH', { sharedSpaceId: f.deals })).status).toBe(404);
        // Ada edits Deals but doesn't manage Mo's dataset.
        expect((await f.as('ada')(`/data/datasets/${mine.id}`, 'PATCH', { sharedSpaceId: f.deals })).status).toBe(404);
        // Nothing was placed.
        expect((await json<SpaceItemsResponse>(f.items('ada'))).items.filter((i) => i.kind === 'dataset')).toEqual([]);
        // The editor places her own; an admin edits every Space.
        const ok = await f.dataset('ada', 'Ok');
        expect((await f.as('ada')(`/data/datasets/${ok.id}`, 'PATCH', { sharedSpaceId: f.deals })).status).toBe(200);
        const admins = await f.dataset('alice', 'Admins');
        expect((await f.as('alice')(`/data/datasets/${admins.id}`, 'PATCH', { sharedSpaceId: f.deals })).status).toBe(
            200,
        );
        expect(
            (await json<SpaceItemsResponse>(f.items('mo'))).items
                .filter((i) => i.kind === 'dataset')
                .map((i) => i.title),
        ).toEqual(['Ok', 'Admins']);
    });

    it('moves within a Space and to another only for its editors; taking a dataset out needs only managing it', async () => {
        const f = await fixture();
        const leads = await f.dataset('ada', 'Leads', { sharedSpaceId: f.deals });
        // Within: under a page of the Space.
        const moved = await f.as('ada')(`/data/datasets/${leads.id}`, 'PATCH', { spaceParentId: f.notes });
        expect(moved.status).toBe(200);
        // Never under a dataset, nor under a page of another Space.
        const pipeline = await f.dataset('ada', 'Pipeline', { sharedSpaceId: f.deals });
        expect((await f.as('ada')(`/data/datasets/${leads.id}`, 'PATCH', { spaceParentId: pipeline.id })).status).toBe(
            404,
        );
        const away = await f.page(f.other, 'Away');
        expect((await f.as('ada')(`/data/datasets/${leads.id}`, 'PATCH', { spaceParentId: away })).status).toBe(404);
        // A place needs a Space.
        const loose = await f.dataset('ada', 'Loose');
        expect((await f.as('ada')(`/data/datasets/${loose.id}`, 'PATCH', { spaceParentId: f.plan })).status).toBe(400);
        // A stored position among siblings.
        expect(
            (await f.as('ada')(`/data/datasets/${leads.id}`, 'PATCH', { spaceParentId: null, spacePosition: '0' }))
                .status,
        ).toBe(200);
        expect(shape(await json<SpaceItemsResponse>(f.items('ada')))[0]).toEqual(['dataset', 'Leads', null]);
        expect((await f.as('ada')(`/data/datasets/${leads.id}`, 'PATCH', { spacePosition: 'not a key!' })).status).toBe(
            400,
        );
        // To another Space she only reads (the open one): refused, and it stays.
        expect((await f.as('ada')(`/data/datasets/${leads.id}`, 'PATCH', { sharedSpaceId: f.open })).status).toBe(403);
        // To one she edits: its place starts at that Space's root.
        const there = await f.as('ada')(`/data/datasets/${leads.id}`, 'PATCH', { sharedSpaceId: f.other });
        expect(there.status).toBe(200);
        expect(shape(await json<SpaceItemsResponse>(f.items('ada', f.other)))).toEqual([
            ['page', 'Away', null],
            ['dataset', 'Leads', null],
        ]);
        expect((await json<SpaceItemsResponse>(f.items('ada'))).items.some((i) => i.id === leads.id)).toBe(false);
        // A dataset a reader shared before the rule stays theirs to manage:
        // they can't move it under a page, but always take it back.
        const old = await f.dataset('mo', 'Old share');
        f.workspace.db.prepare('UPDATE data_datasets SET sharedSpaceId=? WHERE id=?').run(f.deals, old.id);
        expect((await f.as('mo')(`/data/datasets/${old.id}`, 'PATCH', { spaceParentId: f.plan })).status).toBe(403);
        // Unchanged placement is no move: renaming it is fine.
        expect(
            (await f.as('mo')(`/data/datasets/${old.id}`, 'PATCH', { name: 'Old share 2', sharedSpaceId: f.deals }))
                .status,
        ).toBe(200);
        expect((await f.as('mo')(`/data/datasets/${old.id}`, 'PATCH', { sharedSpaceId: null })).status).toBe(200);
        expect((await json<SpaceItemsResponse>(f.items('mo'))).items.some((i) => i.id === old.id)).toBe(false);
        expect((await json<PrivateItemsResponse>(f.as('mo')('/data/private-items'))).items.map((i) => i.id)).toContain(
            old.id,
        );
        // A Space editor who doesn't manage it can't take it out.
        expect((await f.as('ada')(`/data/datasets/${pipeline.id}`, 'PATCH', { sharedSpaceId: null })).status).toBe(200);
        const monly = await f.dataset('mo', 'Mo only');
        f.workspace.db.prepare('UPDATE data_datasets SET sharedSpaceId=? WHERE id=?').run(f.deals, monly.id);
        expect((await f.as('ada')(`/data/datasets/${monly.id}`, 'PATCH', { sharedSpaceId: null })).status).toBe(404);
    });

    it('creates and places a dataset from a Space’s "New" menu, under a page or at the root', async () => {
        const f = await fixture();
        const under = await f.dataset('ada', 'Under', { sharedSpaceId: f.deals, spaceParentId: f.detail });
        expect(under.sharedSpaceId).toBe(f.deals);
        expect(shape(await json<SpaceItemsResponse>(f.items('mo')))).toContainEqual(['dataset', 'Under', f.detail]);
        // A parent that isn't a live page of the Space: nothing is made.
        const before = await json<PrivateItemsResponse>(f.as('ada')('/data/private-items'));
        expect(
            (
                await f.as('ada')('/data/datasets', 'POST', {
                    name: 'Bad',
                    sharedSpaceId: f.deals,
                    spaceParentId: under.id,
                })
            ).status,
        ).toBe(404);
        expect((await f.as('ada')('/data/datasets', 'POST', { name: 'Bad', spaceParentId: f.plan })).status).toBe(400);
        expect(await json(f.as('ada')('/data/private-items'))).toEqual(before);
    });

    it('refuses moving a socio’s shared tables into a Space the person only reads', async () => {
        const f = await fixture();
        // Mo may see the company socio's shared area once he used it.
        f.workspace.db
            .prepare(
                "INSERT INTO data_audit(id, ownerUserId, actorKind, dotId, action, outcome, createdAt) VALUES ('a1', 'mo', 'dot', ?, 'query', 'ok', 1)",
            )
            .run(f.company.id);
        expect(f.platform.data.canSeeShared('mo', f.company.id)).toBe(true);
        const attempt = () =>
            f.platform.data.moveSharedToWorkspaceDataset('mo', f.company.id, {
                name: 'App data',
                sharedSpaceId: f.open,
            });
        expect(attempt).toThrow(DataError);
        expect(attempt).toThrow(SPACE_PLACE_REFUSED);
    });
});

describe('datasets under pages', () => {
    it('never puts a page under a dataset', async () => {
        const f = await fixture();
        const sheet = await f.dataset('ada', 'Sheet', { sharedSpaceId: f.deals });
        const page = await f.as('ada')(`/spaces/${f.deals}/pages`, 'POST', {
            title: 'Inside',
            content: '',
            parentId: sheet.id,
        });
        expect(page.status).toBeGreaterThanOrEqual(400);
        expect((await json<SpaceItemsResponse>(f.items('ada'))).items.some((i) => i.title === 'Inside')).toBe(false);
    });

    it('moves the datasets under a deleted page to its nearest surviving ancestor, and keeps them there on restore', async () => {
        const f = await fixture();
        const deep = await f.dataset('ada', 'Deep', { sharedSpaceId: f.deals, spaceParentId: f.detail });
        const mid = await f.dataset('ada', 'Mid', { sharedSpaceId: f.deals, spaceParentId: f.plan });
        expect((await f.as('ada')(`/spaces/${f.deals}/pages/${f.detail}`, 'DELETE')).status).toBe(200);
        expect(shape(await json<SpaceItemsResponse>(f.items('mo')))).toEqual([
            ['page', 'Plan', null],
            ['dataset', 'Deep', f.plan],
            ['dataset', 'Mid', f.plan],
            ['page', 'Notes', null],
        ]);
        // A whole subtree: to the root, in their order.
        expect((await f.as('ada')(`/spaces/${f.deals}/pages/${f.plan}?subpages=true`, 'DELETE')).status).toBe(200);
        expect(shape(await json<SpaceItemsResponse>(f.items('mo')))).toEqual([
            ['page', 'Notes', null],
            ['dataset', 'Deep', null],
            ['dataset', 'Mid', null],
        ]);
        expect(f.platform.data.detailFor('ada', deep.id).dataset.sharedSpaceId).toBe(f.deals);
        expect(f.platform.data.detailFor('ada', mid.id).dataset.sharedSpaceId).toBe(f.deals);
    });

    it('leaves a moved page’s datasets in the old Space, at its root', async () => {
        const f = await fixture();
        const kept = await f.dataset('ada', 'Kept', { sharedSpaceId: f.deals, spaceParentId: f.notes });
        const move = await f.as('ada')(`/spaces/${f.deals}/pages/${f.notes}/move`, 'POST', { spaceId: f.other });
        expect(move.status).toBe(200);
        expect(shape(await json<SpaceItemsResponse>(f.items('ada')))).toContainEqual(['dataset', 'Kept', null]);
        expect((await json<SpaceItemsResponse>(f.items('ada', f.other))).items.some((i) => i.id === kept.id)).toBe(
            false,
        );
        // Moving the page back doesn't bring the dataset under it again.
        await f.as('ada')(`/spaces/${f.other}/pages/${f.notes}/move`, 'POST', { spaceId: f.deals });
        expect(shape(await json<SpaceItemsResponse>(f.items('ada')))).toContainEqual(['dataset', 'Kept', null]);
    });
});

describe('existing shares', () => {
    it('stay at the Space’s top level, in the order they were last changed (migration 15)', () => {
        const db = new DatabaseSync(':memory:');
        const migrations = dataSchema.migrations ?? [];
        for (const migration of migrations.filter((m) => m.version < 15)) {
            db.exec(migration.up as string);
        }
        const insert = db.prepare(
            'INSERT INTO data_datasets(id, ownerUserId, name, sharedSpaceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, ?)',
        );
        insert.run('shared', 'mo', 'Shared', 'space-1', 500);
        insert.run('mine', 'mo', 'Mine', null, 600);
        db.exec(migrations.find((m) => m.version === 15)!.up as string);
        const rows = db
            .prepare('SELECT id, spaceParentId, spacePosition, spaceAddedAt FROM data_datasets ORDER BY id')
            .all();
        expect(rows.map((row) => ({ ...row }))).toEqual([
            { id: 'mine', spaceParentId: null, spacePosition: null, spaceAddedAt: null },
            { id: 'shared', spaceParentId: null, spacePosition: null, spaceAddedAt: 500 },
        ]);
        db.close();
    });

    it('read as root items after the Space’s pages made before they joined', async () => {
        const f = await fixture();
        const old = await f.dataset('ada', 'Old');
        // As the migration leaves a share made before it: no place, joined at its last change.
        f.workspace.db
            .prepare('UPDATE data_datasets SET sharedSpaceId=?, spaceAddedAt=updatedAt WHERE id=?')
            .run(f.deals, old.id);
        expect(shape(await json<SpaceItemsResponse>(f.items('mo'))).at(-1)).toEqual(['dataset', 'Old', null]);
    });
});

describe('GET /api/data/private-items', () => {
    it('lists each person’s own datasets in no Space, a socio’s scratch ones included, and only theirs', async () => {
        const f = await fixture();
        const a = await f.dataset('olive', 'A');
        const b = await f.dataset('olive', 'B');
        const c = await f.dataset('mo', 'C');
        const scratch = f.platform.data.scratch('olive', f.company.id, true)!;
        // A workspace dataset is no person's: never in a Private group.
        f.platform.data.createDataset(WORKSPACE_OWNER_ID, { name: 'Company' });
        const olive = await json<PrivateItemsResponse>(f.as('olive')('/data/private-items'));
        expect(olive.schema).toBe(1);
        expect(olive.scope).toBe('private');
        expect(olive.items.map((item) => item.id).sort()).toEqual([a.id, b.id, scratch.id].sort());
        expect(olive.items.every((item) => item.kind === 'dataset' && item.parentId === null)).toBe(true);
        // Oldest first.
        expect(olive.items.map((item) => item.position)).toEqual(olive.items.map((item) => item.position).sort());
        expect(olive.items.find((item) => item.id === a.id)!.position).toBe(spaceItemKey(a.createdAt, a.id));
        const marked = olive.items.find((item) => item.id === scratch.id) as SpaceDatasetItem;
        expect(marked.socio).toEqual({ id: f.company.id, name: f.company.name });
        expect((await json<PrivateItemsResponse>(f.as('mo')('/data/private-items'))).items.map((i) => i.id)).toEqual([
            c.id,
        ]);
        expect((await json<PrivateItemsResponse>(f.as('alice')('/data/private-items'))).items).toEqual([]);
        // Placed in a Space: out of the group; taken out: back in it.
        const d = await f.dataset('ada', 'D');
        expect((await json<PrivateItemsResponse>(f.as('ada')('/data/private-items'))).items.map((i) => i.id)).toEqual([
            d.id,
        ]);
        await f.as('ada')(`/data/datasets/${d.id}`, 'PATCH', { sharedSpaceId: f.deals });
        expect((await json<PrivateItemsResponse>(f.as('ada')('/data/private-items'))).items).toEqual([]);
        await f.as('ada')(`/data/datasets/${d.id}`, 'PATCH', { sharedSpaceId: null });
        expect((await json<PrivateItemsResponse>(f.as('ada')('/data/private-items'))).items.map((i) => i.id)).toEqual([
            d.id,
        ]);
    });

    it('has a per-person ETag: one person’s change never changes another’s', async () => {
        const f = await fixture();
        await f.dataset('olive', 'A');
        const c = await f.dataset('mo', 'C');
        const tag = async (who: string) => (await f.as(who)('/data/private-items')).headers.get('etag')!;
        const olive = await tag('olive');
        const mo = await tag('mo');
        expect(olive).not.toBe(mo);
        // A poll with the tag is a 304.
        const poll = (etag: string) => f.poll('olive', '/data/private-items', etag);
        expect((await poll(olive)).status).toBe(304);
        // Mo renames his: Olive's tag holds, his changes.
        await f.as('mo')(`/data/datasets/${c.id}`, 'PATCH', { name: 'C2' });
        expect((await poll(olive)).status).toBe(304);
        expect(await tag('mo')).not.toBe(mo);
        // Olive makes one: hers changes.
        await f.dataset('olive', 'B');
        expect((await poll(olive)).status).toBe(200);
    });
});

describe('plugin datasets', () => {
    it('appear only in a Space an admin placed them in, with the plugin that writes them', async () => {
        const f = await fixture();
        const events = f.platform.data.createDataset(WORKSPACE_OWNER_ID, { name: 'Events' });
        f.workspace.db
            .prepare(
                "INSERT INTO data_plugin_bindings(id, pluginId, need, datasetId, access, boundBy, boundAt) VALUES ('b1', 'events', 'log', ?, 'write', 'alice', 1)",
            )
            .run(events.id);
        const listed = async (who: string, spaceId: string) =>
            (await json<SpaceItemsResponse>(f.items(who, spaceId))).items.some((item) => item.id === events.id);
        expect(await listed('mo', f.deals)).toBe(false);
        expect(await listed('mo', f.open)).toBe(false);
        // A Space's editor who isn't an admin doesn't manage it.
        expect((await f.as('ada')(`/data/datasets/${events.id}`, 'PATCH', { sharedSpaceId: f.deals })).status).toBe(
            404,
        );
        expect((await f.as('mo')(`/data/datasets/${events.id}`, 'PATCH', { sharedSpaceId: f.deals })).status).toBe(404);
        expect(await listed('mo', f.deals)).toBe(false);
        // An admin places it.
        expect((await f.as('alice')(`/data/datasets/${events.id}`, 'PATCH', { sharedSpaceId: f.deals })).status).toBe(
            200,
        );
        const item = (await json<SpaceItemsResponse>(f.items('mo'))).items.find(
            (entry) => entry.id === events.id,
        ) as SpaceDatasetItem;
        expect(item).toMatchObject({ owner: 'workspace', plugin: { id: 'events' }, parentId: null });
        expect(await listed('mo', f.open)).toBe(false);
        expect(await listed('nina', f.open)).toBe(false);
    });
});

describe('plugin bindings', () => {
    it('changes the items’ ETag when the plugin writing a placed dataset changes (review r1)', async () => {
        const f = await fixture();
        const events = f.platform.data.createDataset(WORKSPACE_OWNER_ID, { name: 'Events' });
        f.workspace.db
            .prepare(
                "INSERT INTO data_plugin_bindings(id, pluginId, need, datasetId, access, boundBy, boundAt) VALUES ('b1', 'events', 'log', ?, 'write', 'alice', 1)",
            )
            .run(events.id);
        await f.as('alice')(`/data/datasets/${events.id}`, 'PATCH', { sharedSpaceId: f.deals });
        const path = `/spaces/${f.deals}/items`;
        const tag = (await f.items('mo')).headers.get('etag')!;
        expect((await f.poll('mo', path, tag)).status).toBe(304);
        // The binding ends, with no write to the dataset: its "Written by" goes.
        f.workspace.db.prepare("UPDATE data_plugin_bindings SET unboundAt=2 WHERE id='b1'").run();
        const after = await f.poll('mo', path, tag);
        expect(after.status).toBe(200);
        const item = ((await after.json()) as SpaceItemsResponse).items.find((i) => i.id === events.id);
        expect(item).not.toHaveProperty('plugin');
    });
});

describe('item versions', () => {
    const itemIn = async (f: Awaited<ReturnType<typeof fixture>>, id: string, spaceId?: string) =>
        (await json<SpaceItemsResponse>(f.items('ada', spaceId))).items.find((entry) => entry.id === id)!;
    const privateItem = async (f: Awaited<ReturnType<typeof fixture>>, who: string, id: string) =>
        (await json<PrivateItemsResponse>(f.as(who)('/data/private-items'))).items.find(
            (entry) => entry.id === id,
        ) as SpaceDatasetItem;

    it('gives a dataset item a new version, and the list a new ETag, on a rename, a move and a new place', async () => {
        const f = await fixture();
        const report = await f.dataset('ada', 'Report', { sharedSpaceId: f.deals });
        const path = `/spaces/${f.deals}/items`;
        // Each change against the version just before it: the same fields
        // again (back where it was) are the same version, as a cache wants.
        let last = 0;
        let tag = (await f.items('mo')).headers.get('etag')!;
        const changed = async (label: string, change: () => Promise<unknown>, spaceId = f.deals) => {
            await change();
            const item = await itemIn(f, report.id, spaceId);
            expect(item.version, label).not.toBe(last);
            last = item.version;
            if (spaceId === f.deals) {
                expect((await f.poll('mo', path, tag)).status, label).toBe(200);
                tag = (await f.items('mo')).headers.get('etag')!;
                expect((await f.poll('mo', path, tag)).status, label).toBe(304);
            }
            return item;
        };
        last = (await itemIn(f, report.id)).version;
        const patch = (body: object) => f.as('ada')(`/data/datasets/${report.id}`, 'PATCH', body);
        // A rename keeps the dataset's `updatedAt`: the version changes anyway.
        const renamed = await changed('rename', () => patch({ name: 'Report 2' }));
        expect(renamed.title).toBe('Report 2');
        expect(f.platform.data.detailFor('ada', report.id).dataset.updatedAt).toBe(report.updatedAt);
        // Moved under a page, then to a stored position among siblings.
        expect((await changed('move under a page', () => patch({ spaceParentId: f.notes }))).parentId).toBe(f.notes);
        expect((await changed('re-place', () => patch({ spacePosition: '0' }))).position).toBe('0');
        expect((await changed('back to the root', () => patch({ spaceParentId: null }))).parentId).toBeNull();
        // Its page deleted: lifted to the root of the Space, a new version.
        await changed('under a subpage', () => patch({ spaceParentId: f.detail }));
        await changed('page deleted', () => f.as('ada')(`/spaces/${f.deals}/pages/${f.plan}?subpages=true`, 'DELETE'));
        // Moved to another Space: a new place there.
        await changed('another Space', () => patch({ sharedSpaceId: f.other }), f.other);
        // Unchanged, it keeps its version.
        const still = await itemIn(f, report.id, f.other);
        expect((await itemIn(f, report.id, f.other)).version).toBe(still.version);
    });

    it('gives a dataset item a new version when its tables or its badges change', async () => {
        const f = await fixture();
        const scratch = f.platform.data.scratch('olive', f.company.id, true)!;
        const before = await privateItem(f, 'olive', scratch.id);
        expect(before.socio).toEqual({ id: f.company.id, name: f.company.name });
        // The socio's badge: its name changes with no write to the dataset.
        f.workspace.db.prepare('UPDATE dots SET name=? WHERE id=?').run('Renamed socio', f.company.id);
        const after = await privateItem(f, 'olive', scratch.id);
        expect(after.socio?.name).toBe('Renamed socio');
        expect(after.version).not.toBe(before.version);
        // A plugin's badge: a binding that ends drops "Written by".
        const events = f.platform.data.createDataset(WORKSPACE_OWNER_ID, { name: 'Log' });
        f.workspace.db
            .prepare(
                "INSERT INTO data_plugin_bindings(id, pluginId, need, datasetId, access, boundBy, boundAt) VALUES ('b1', 'events', 'log', ?, 'write', 'alice', 1)",
            )
            .run(events.id);
        await f.as('alice')(`/data/datasets/${events.id}`, 'PATCH', { sharedSpaceId: f.deals });
        const bound = (await itemIn(f, events.id)) as SpaceDatasetItem;
        expect(bound.plugin?.id).toBe('events');
        f.workspace.db.prepare("UPDATE data_plugin_bindings SET unboundAt=2 WHERE id='b1'").run();
        const unbound = (await itemIn(f, events.id)) as SpaceDatasetItem;
        expect(unbound.plugin).toBeUndefined();
        expect(unbound.version).not.toBe(bound.version);
        // Its tables: a new table and its rows.
        const sheet = await f.dataset('ada', 'Sheet', { sharedSpaceId: f.deals });
        const empty = await itemIn(f, sheet.id);
        await f.seed('ada', sheet.id);
        const seeded = (await itemIn(f, sheet.id)) as SpaceDatasetItem;
        expect(seeded.tables).toHaveLength(1);
        expect(seeded.version).not.toBe(empty.version);
    });

    it('gives a private item a new version on a rename', async () => {
        const f = await fixture();
        const draft = await f.dataset('ada', 'Draft');
        const before = await privateItem(f, 'ada', draft.id);
        const tag = (await f.as('ada')('/data/private-items')).headers.get('etag')!;
        await f.as('ada')(`/data/datasets/${draft.id}`, 'PATCH', { name: 'Draft 2' });
        const after = await privateItem(f, 'ada', draft.id);
        expect(after.title).toBe('Draft 2');
        expect(after.version).not.toBe(before.version);
        expect((await f.poll('ada', '/data/private-items', tag)).status).toBe(200);
    });

    it('gives a page item a new revision on a rename and a move, and keeps it otherwise', async () => {
        const f = await fixture();
        const page = await itemIn(f, f.notes);
        const path = `/spaces/${f.deals}/items`;
        const tag = (await f.items('mo')).headers.get('etag')!;
        await f.as('ada')(`/spaces/${f.deals}/pages/${f.notes}`, 'PATCH', {
            title: 'Notes 2',
            expectedRevision: page.version,
        });
        const renamed = await itemIn(f, f.notes);
        expect(renamed).toMatchObject({ title: 'Notes 2', version: page.version + 1, position: page.position });
        expect((await f.poll('mo', path, tag)).status).toBe(200);
        await f.as('ada')(`/spaces/${f.deals}/pages/${f.notes}`, 'PATCH', {
            parentId: f.plan,
            expectedRevision: renamed.version,
        });
        const moved = await itemIn(f, f.notes);
        expect(moved).toMatchObject({ parentId: f.plan, version: renamed.version + 1, position: page.position });
        // A dataset change elsewhere in the Space leaves the page's version.
        await f.dataset('ada', 'Other', { sharedSpaceId: f.deals });
        expect((await itemIn(f, f.notes)).version).toBe(moved.version);
    });

    it('hashes every listed field', () => {
        const base: Omit<SpaceDatasetItem, 'version'> = {
            kind: 'dataset',
            id: 'd1',
            parentId: null,
            title: 'Dataset',
            position: '0',
            owner: 'person',
            tables: [{ name: 't', title: 't', rows: 1, analytical: false }],
        };
        const variants: Array<Omit<SpaceDatasetItem, 'version'>> = [
            base,
            { ...base, title: 'Dataset 2' },
            { ...base, parentId: 'p1' },
            { ...base, position: '1' },
            { ...base, owner: 'workspace' },
            { ...base, tables: [{ name: 't', title: 't', rows: 2, analytical: false }] },
            { ...base, tables: [{ name: 't', title: 't', rows: 1, analytical: true }] },
            { ...base, tables: [] },
            { ...base, socio: { id: 's1', name: 'Socio' } },
            { ...base, socio: { id: 's1', name: 'Socio 2' } },
            { ...base, plugin: { id: 'p', name: 'Plugin' } },
            { ...base, plugin: { id: 'p', name: 'Plugin 2' } },
        ];
        const versions = variants.map(spaceItemVersion);
        expect(new Set(versions).size).toBe(variants.length);
        expect(versions.every((v) => Number.isSafeInteger(v) && v >= 0)).toBe(true);
        expect(spaceItemVersion({ ...base })).toBe(versions[0]);
    });
});

describe('spaceItemTree', () => {
    it('orders siblings by position, parents before children, and keeps orphans at the root', () => {
        const items = [
            { id: 'd1', kind: 'dataset', parentId: 'p1', position: '2' },
            { id: 'p2', kind: 'page', parentId: null, position: '3' },
            { id: 'p1', kind: 'page', parentId: null, position: '1' },
            { id: 'c1', kind: 'page', parentId: 'p1', position: '1' },
            { id: 'o1', kind: 'dataset', parentId: 'gone', position: '0' },
            // A parent that is a dataset is no parent.
            { id: 'x1', kind: 'page', parentId: 'd1', position: '9' },
        ];
        expect(spaceItemTree(items).map((item) => item.id)).toEqual(['o1', 'p1', 'c1', 'd1', 'p2', 'x1']);
    });
});
