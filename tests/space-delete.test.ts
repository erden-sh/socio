import { afterEach, expect, it, vi } from 'vitest';

import { sqliteData } from '@socio/data/open';
import type { DeletedSpace, Space, WorkspaceState } from '@socio/shared/types';

import { roomsFixture } from './fixtures/rooms.js';

// Deleting a Space (CB-277): who may (a private Space's editors, admins
// any Space), what stops it, and an admin's restore, each audited. What a
// deleted Space reads as on every path is tests/spaces-access-matrix.test.ts.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = await roomsFixture(cleanup);
    const json = async <T>(response: Promise<Response> | Response) => (await response).json() as Promise<T>;
    // Ada's private Space, Mo a member of it.
    const closed = await json<Space>(
        f.as('ada')('/spaces', 'POST', {
            name: 'Deals',
            private: true,
            people: [{ userId: 'mo', role: 'member' }],
        }),
    );
    // An admin's Space for everyone, Ada one of its editors.
    const open = await json<Space>(f.as('alice')('/spaces', 'POST', { name: 'Wiki' }));
    await f.as('alice')(`/spaces/${open.id}/people/ada`, 'PUT', {
        role: 'editor',
    });
    const remove = (person: string, spaceId: string) => f.as(person)(`/spaces/${spaceId}`, 'DELETE');
    const sidebar = async (person: string) =>
        (await json<WorkspaceState>(f.as(person)('/workspace'))).spaces.map((space) => space.id);
    return { ...f, json, closed, open, remove, sidebar };
}

it('lets a private Space’s editors delete it, and only admins one for the whole workspace', async () => {
    const f = await fixture();
    const answer = async (response: Promise<Response>) => {
        const done = await response;
        return { status: done.status, body: await done.text() };
    };
    // Outside it: the 404 of a Space that isn't there, word for word.
    expect(await answer(f.remove('nina', f.closed.id))).toEqual(await answer(f.remove('nina', 'no-such-space')));
    // Its member reads it but can't delete it.
    expect((await f.remove('mo', f.closed.id)).status).toBe(403);
    // A whole-workspace Space: not even by its editor, nor a member.
    const editor = await f.remove('ada', f.open.id);
    expect(editor.status).toBe(403);
    expect(await editor.json()).toEqual({
        error: 'Only workspace admins delete a Space for the whole workspace.',
    });
    expect((await f.remove('nina', f.open.id)).status).toBe(403);
    expect(await f.sidebar('nina')).toContain(f.open.id);
    // Its editor deletes the private one; an admin the open one.
    expect((await f.remove('ada', f.closed.id)).status).toBe(200);
    expect((await f.remove('alice', f.open.id)).status).toBe(200);
    for (const person of ['ada', 'mo', 'nina', 'alice']) {
        const ids = await f.sidebar(person);
        expect(ids, person).not.toContain(f.closed.id);
        expect(ids, person).not.toContain(f.open.id);
    }
    // Deleted already: as one that isn't there, for its admin too.
    expect(await answer(f.remove('alice', f.closed.id))).toEqual(await answer(f.remove('alice', 'no-such-space')));
    // An admin deletes any Space, a private one they aren't in too.
    const mine = await f.json<Space>(f.as('nina')('/spaces', 'POST', { name: 'Just me' }));
    expect((await f.remove('alice', mine.id)).status).toBe(200);
    // Audited by id: who, and what it was.
    expect(f.workspace.auditOf('space', f.closed.id)).toMatchObject([
        {
            actor: 'ada',
            action: 'delete',
            targetKind: 'space',
            detail: 'private; 0 pages',
        },
    ]);
    expect(f.workspace.auditOf('space', f.open.id)).toMatchObject([
        { actor: 'alice', action: 'delete', detail: 'whole workspace; 0 pages' },
    ]);
});

it('keeps the workspace’s last Space and every socio’s default destination', async () => {
    const f = await fixture();
    // The company socio saves new pages to its default Space.
    const used = await f.remove('alice', f.company.spaceId);
    expect(used.status).toBe(409);
    expect(((await used.json()) as { error: string }).error).toBe(
        `A socio saves new pages to this Space by default (${f.company.name}). Choose another default Space in its settings first.`,
    );
    // A member is told only of the socios they use: Olive, added to the
    // private Space, saves her own socio's pages there.
    await f.as('ada')(`/spaces/${f.closed.id}/people/olive`, 'PUT', {
        role: 'member',
    });
    const olives = await f.json<{ id: string }>(
        f.as('olive')('/dots', 'POST', {
            name: 'Olive’s',
            instructions: 'Helps.',
            researchAllowed: true,
            memoryAllowed: true,
            spaceId: f.closed.id,
            spaceIds: [f.closed.id],
        }),
    );
    const refused = await f.remove('ada', f.closed.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain('(1 other socio)');
    // Moved elsewhere, it may go.
    await f.as('olive')(`/dots/${olives.id}`, 'PUT', {
        name: 'Olive’s',
        researchAllowed: true,
        memoryAllowed: true,
        spaceId: f.company.spaceId,
        spaceIds: [f.company.spaceId, f.closed.id],
    });
    expect((await f.remove('ada', f.closed.id)).status).toBe(200);
    // The last Space stays, whatever else.
    expect((await f.remove('alice', f.open.id)).status).toBe(200);
    for (const dot of f.workspace.dots()) {
        f.workspace.db.prepare('UPDATE dots SET deletedAt=?, deletedBy=? WHERE id=?').run(Date.now(), 'alice', dot.id);
    }
    const last = await f.remove('alice', f.company.spaceId);
    expect(last.status).toBe(409);
    expect(((await last.json()) as { error: string }).error).toBe(
        'This is the workspace’s only Space. Make another one before deleting it.',
    );
});

it('deletes no Space while a runtime that would still show it is alive', async () => {
    const f = await fixture();
    f.workspace.spaceAccess.useDeleteContract(() => false);
    const refused = await f.remove('ada', f.closed.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(
        'Socio is being updated: try deleting the Space again in a few minutes.',
    );
    // Still a 404 outside it, and a 403 for a member: nothing is said first.
    expect((await f.remove('nina', f.closed.id)).status).toBe(404);
    expect((await f.remove('mo', f.closed.id)).status).toBe(403);
    expect(await f.sidebar('mo')).toContain(f.closed.id);
    f.workspace.spaceAccess.useDeleteContract(() => true);
    expect((await f.remove('ada', f.closed.id)).status).toBe(200);
});

it('lists deleted Spaces for admins, who restore them, audited', async () => {
    const f = await fixture();
    await f.as('ada')(`/spaces/${f.closed.id}/pages`, 'POST', { title: 'Q3' });
    expect((await f.remove('ada', f.closed.id)).status).toBe(200);
    // Admins only.
    for (const person of ['ada', 'mo', 'nina']) {
        expect((await f.as(person)('/admin/spaces/deleted')).status).toBe(403);
        expect((await f.as(person)(`/admin/spaces/${f.closed.id}/restore`, 'POST')).status).toBe(403);
    }
    const { spaces } = await f.json<{ spaces: DeletedSpace[] }>(f.as('alice')('/admin/spaces/deleted'));
    expect(spaces).toEqual([
        {
            id: f.closed.id,
            name: 'Deals',
            description: '',
            createdAt: f.closed.createdAt,
            deletedAt: expect.any(Number),
            deletedBy: 'ada',
            deletedByName: 'Ada',
            private: true,
            pages: 1,
        },
    ]);
    // A live Space, or none, is not there to restore.
    for (const id of [f.open.id, 'no-such-space']) {
        expect((await f.as('alice')(`/admin/spaces/${id}/restore`, 'POST')).status).toBe(404);
    }
    const restored = await f.as('alice')(`/admin/spaces/${f.closed.id}/restore`, 'POST');
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({
        id: f.closed.id,
        name: 'Deals',
    });
    // Back as it was: private, its people its readers, the rest outside.
    expect(await f.sidebar('mo')).toContain(f.closed.id);
    expect(await f.sidebar('nina')).not.toContain(f.closed.id);
    expect((await f.json<{ spaces: DeletedSpace[] }>(f.as('alice')('/admin/spaces/deleted'))).spaces).toEqual([]);
    expect(f.workspace.auditOf('space', f.closed.id)).toMatchObject([
        { actor: 'ada', action: 'delete', detail: 'private; 1 page' },
        { actor: 'alice', action: 'restore', detail: 'deleted by ada' },
    ]);
    // A private one waits, as making one private does, during a deploy.
    expect((await f.remove('ada', f.closed.id)).status).toBe(200);
    f.workspace.spaceAccess.usePrivacyContract(() => false);
    expect((await f.as('alice')(`/admin/spaces/${f.closed.id}/restore`, 'POST')).status).toBe(409);
});

it('checks the editor again under the write lock, after a change of its people queued before it', async () => {
    const f = await fixture();
    const { uow } = sqliteData(f.workspace.db);
    const gate = () => {
        let open!: () => void;
        const opened = new Promise<void>((resolve) => (open = resolve));
        return { open, opened };
    };
    // Ada is an editor when she asks; her removal commits before her delete runs.
    const start = gate();
    const removal = uow.run(async () => {
        await start.opened;
        await f.as('alice')(`/spaces/${f.closed.id}/people/ada`, 'PUT', { role: 'member' });
    });
    const late = f.workspace.deleteSpace(f.closed.id, 'ada').catch((error: unknown) => error);
    start.open();
    await removal;
    expect(await late).toMatchObject({ status: 403 });
    expect(await f.sidebar('mo')).toContain(f.closed.id);
    // Mo is made an editor in a change that then rolls back: his delete,
    // asked while the grant showed and queued behind it, is refused.
    const granted = gate();
    const finish = gate();
    const grant = uow.run(async () => {
        await f.as('alice')(`/spaces/${f.closed.id}/people/mo`, 'PUT', { role: 'editor' });
        granted.open();
        await finish.opened;
        throw new Error('rolled back');
    });
    await granted.opened;
    const borrowed = f.workspace.deleteSpace(f.closed.id, 'mo').catch((error: unknown) => error);
    finish.open();
    await expect(grant).rejects.toThrow('rolled back');
    expect(await borrowed).toMatchObject({ status: 403 });
    expect(await f.sidebar('mo')).toContain(f.closed.id);
    expect(f.workspace.auditOf('space', f.closed.id).filter((entry) => entry.action === 'delete')).toEqual([]);
});
