import type { ToolDefinition } from '@copilotkit/runtime/v2';
import { afterEach, expect, it, vi } from 'vitest';

import { sqliteData } from '@socio/data/open';
import type { DotTurn } from '@socio/foundation/turns/turn';
import { SPACE_NAME_ERROR, SPACE_NAME_MAX } from '@socio/shared/spaces/create-input';
import type { Space, WorkspaceState } from '@socio/shared/types';

import { matrixChats, roomsFixture } from './fixtures/rooms.js';

// Renaming a Space (CB-366): its editors may (workspace admins edit every
// Space), in its Settings (`PATCH /api/spaces/:id`) or through a socio's
// rename_space, by the name rule a new Space has. Only the name changes:
// the id, which every link to the Space and its pages names, stays.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

type Result = Record<string, unknown> & { error?: string; code?: string };

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
    // Ada's Space of her own, which Mo can't read.
    const secret = await json<Space>(f.as('ada')('/spaces', 'POST', { name: 'Acquisition', private: true }));
    // An admin's Space for everyone, Ada one of its editors.
    const open = await json<Space>(f.as('alice')('/spaces', 'POST', { name: 'Wiki' }));
    await f.as('alice')(`/spaces/${open.id}/people/ada`, 'PUT', { role: 'editor' });
    const handbook = await json<Space>(f.as('alice')('/spaces', 'POST', { name: 'Handbook' }));
    const rename = (person: string, spaceId: string, body: unknown) =>
        f.as(person)(`/spaces/${spaceId}`, 'PATCH', body);
    const named = async (person: string, spaceId: string) =>
        (await json<WorkspaceState>(f.as(person)('/workspace'))).spaces.find((space) => space.id === spaceId)?.name;
    // The company socio, given both Spaces, in a person's own chat.
    const socio = f.company;
    const dot = f.workspace.dot(socio.id)!;
    f.workspace.updateDot(socio.id, {
        name: dot.name,
        instructions: dot.instructions,
        researchAllowed: dot.researchAllowed,
        memoryAllowed: dot.memoryAllowed,
        spaceId: dot.spaceId,
        spaceIds: [dot.spaceId, closed.id, open.id, secret.id, handbook.id],
    });
    const turn = (userId: string, room?: string): DotTurn => {
        const threadId = room ?? `${userId}-chat`;
        if (!room && !f.workspace.thread(threadId)) {
            f.workspace.bindThread(threadId, socio.id, 'Chat', userId);
        }
        return {
            dot: f.workspace.dot(socio.id)!,
            userId,
            threadId,
            channel: false,
            purpose: 'chat',
            check: () => {},
            signal: new AbortController().signal,
            toolNames: () => [],
        };
    };
    /** The registered rename_space of a person's turn, as the socio calls it. */
    const renameTool = (userId: string, room?: string) => {
        const found = f.platform.dotExtensions
            .tools(turn(userId, room))
            .find((tool) => tool.name === 'rename_space') as
            | (ToolDefinition & { execute: (input: unknown) => Promise<unknown> })
            | undefined;
        if (!found) {
            throw new Error('No rename_space tool.');
        }
        return (input: Record<string, unknown>) => found.execute(input) as Promise<Result>;
    };
    return { ...f, json, closed, open, secret, rename, named, renameTool };
}

it('lets a Space’s editors rename it, and refuses everyone else', async () => {
    const f = await fixture();
    const answer = async (response: Promise<Response>) => {
        const done = await response;
        return { status: done.status, body: await done.text() };
    };
    // Outside it: the 404 of a Space that isn't there, word for word.
    expect(await answer(f.rename('nina', f.closed.id, { name: 'Peek' }))).toEqual(
        await answer(f.rename('nina', 'no-such-space', { name: 'Peek' })),
    );
    expect((await f.rename('nina', 'no-such-space', { name: 'Peek' })).status).toBe(404);
    // Its member reads it but can't rename it; nor a reader of an open one.
    const member = await f.rename('mo', f.closed.id, { name: 'Mo’s' });
    expect(member.status).toBe(403);
    expect(await member.json()).toEqual({ error: 'Only this Space’s editors can do that.' });
    expect((await f.rename('nina', f.open.id, { name: 'Nina’s' })).status).toBe(403);
    expect(await f.named('mo', f.closed.id)).toBe('Deals');
    expect(await f.named('nina', f.open.id)).toBe('Wiki');
    // Its editors rename it, an open one too; an admin any Space.
    const renamed = await f.rename('ada', f.closed.id, { name: '  Big deals  ' });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: f.closed.id, name: 'Big deals' });
    expect((await f.rename('ada', f.open.id, { name: 'Handbook' })).status).toBe(200);
    expect((await f.rename('alice', f.closed.id, { name: 'Pipeline' })).status).toBe(200);
    for (const person of ['ada', 'mo', 'alice']) {
        expect(await f.named(person, f.closed.id), person).toBe('Pipeline');
    }
    expect(await f.named('nina', f.open.id)).toBe('Handbook');
    // A deleted Space is one that isn't there, for its admin too.
    await f.as('alice')(`/spaces/${f.open.id}`, 'DELETE');
    expect((await f.rename('alice', f.open.id, { name: 'Back' })).status).toBe(404);
    // Audited by id, never the names.
    expect(f.workspace.auditOf('space', f.closed.id)).toMatchObject([
        { actor: 'ada', action: 'update', targetKind: 'space', detail: 'renamed' },
        { actor: 'alice', action: 'update', targetKind: 'space', detail: 'renamed' },
    ]);
});

it('takes only a name a new Space could have', async () => {
    const f = await fixture();
    for (const body of [
        { name: '' },
        { name: '   ' },
        { name: 'x'.repeat(SPACE_NAME_MAX + 1) },
        {},
        { name: 7 },
        { name: 'Fine', description: 'Not this route’s' },
        null,
    ]) {
        const refused = await f.rename('ada', f.closed.id, body);
        expect(refused.status, JSON.stringify(body)).toBe(400);
        expect(await refused.json()).toEqual({ error: SPACE_NAME_ERROR });
    }
    expect(await f.named('ada', f.closed.id)).toBe('Deals');
    const longest = 'x'.repeat(SPACE_NAME_MAX);
    expect((await f.rename('ada', f.closed.id, { name: longest })).status).toBe(200);
    expect(await f.named('ada', f.closed.id)).toBe(longest);
    // The same name again changes nothing, and audits nothing more.
    expect((await f.rename('ada', f.closed.id, { name: longest })).status).toBe(200);
    expect(f.workspace.auditOf('space', f.closed.id)).toHaveLength(1);
});

it('keeps the Space’s pages and every link to them, which name its id', async () => {
    const f = await fixture();
    const page = await f.json<{ id: string; spaceId: string }>(
        f.as('ada')(`/spaces/${f.closed.id}/pages`, 'POST', { title: 'Q3', content: 'Numbers.' }),
    );
    const child = await f.json<{ id: string }>(
        f.as('ada')(`/spaces/${f.closed.id}/pages`, 'POST', {
            title: 'Q3 detail',
            content: `See [Q3](/spaces/${f.closed.id}/pages/${page.id}).`,
            parentId: page.id,
        }),
    );
    expect((await f.rename('ada', f.closed.id, { name: 'Pipeline' })).status).toBe(200);
    // The same addresses open the same pages, with their text.
    const read = await f.as('mo')(`/spaces/${f.closed.id}/pages/${page.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id: page.id, spaceId: f.closed.id, content: 'Numbers.' });
    expect(
        await f.json<{ content: string; parentId: string }>(f.as('mo')(`/spaces/${f.closed.id}/pages/${child.id}`)),
    ).toMatchObject({ parentId: page.id, content: `See [Q3](/spaces/${f.closed.id}/pages/${page.id}).` });
    expect(await f.json(f.as('mo')(`/pages/${page.id}/location`))).toMatchObject({ spaceId: f.closed.id });
    // Its people and privacy stay too.
    expect(await f.json(f.as('ada')(`/spaces/${f.closed.id}/people`))).toMatchObject({
        membersOnly: true,
        people: [
            { userId: 'ada', role: 'editor' },
            { userId: 'mo', role: 'member' },
        ],
    });
    expect((await f.as('nina')(`/spaces/${f.closed.id}/pages/${page.id}`)).status).toBe(404);
});

it('gives socios rename_space, for the Space’s editors only, by the same name rule', async () => {
    const f = await fixture();
    // A member's socio: refused, as the Settings would refuse them.
    expect(await f.renameTool('mo')({ spaceId: f.closed.id, name: 'Mine' })).toEqual({
        error: 'Only this Space’s editors can do that.',
        code: 'http_403',
    });
    // A Space the person (so the socio, in their chat) can't read: as none at all.
    expect(await f.renameTool('nina')({ spaceId: f.closed.id, name: 'Peek' })).toEqual({
        error: 'Space not found.',
        code: 'http_404',
    });
    // A Space the socio wasn't given: as none at all, for an admin too.
    const ungranted = f.workspace.createSpace('Elsewhere', '');
    expect(await f.renameTool('alice')({ spaceId: ungranted.id, name: 'Other' })).toMatchObject({
        code: 'http_404',
    });
    // The create rule's name, and never another Space's this chat may use.
    for (const name of ['', '   ', 'x'.repeat(SPACE_NAME_MAX + 1)]) {
        expect(await f.renameTool('ada')({ spaceId: f.closed.id, name })).toEqual({
            error: SPACE_NAME_ERROR,
            code: 'http_400',
        });
    }
    expect(await f.renameTool('ada')({ spaceId: f.closed.id, name: ' wiki ' })).toMatchObject({ code: 'http_409' });
    expect(await f.named('ada', f.closed.id)).toBe('Deals');
    // Its editor's socio renames it; recorded as the socio's, for Ada.
    expect(await f.renameTool('ada')({ spaceId: f.closed.id, name: '  Pipeline ' })).toEqual({
        renamed: true,
        space: { id: f.closed.id, name: 'Pipeline' },
        url: `/spaces/${f.closed.id}`,
    });
    expect(await f.named('mo', f.closed.id)).toBe('Pipeline');
    expect(f.workspace.auditOf('space', f.closed.id)).toMatchObject([
        { actor: `dot:${f.company.id}`, action: 'update', detail: 'renamed for ada' },
    ]);
});

it('names a clashing Space only when the chat may read it (a room never learns a private one)', async () => {
    const f = await fixture();
    const { roomId } = await matrixChats(f);
    // In Ada's own chat, her private Space is one the chat may use: refused, named.
    expect(await f.renameTool('ada')({ spaceId: f.open.id, name: 'acquisition' })).toEqual({
        error: 'Another Space is named “Acquisition”. Choose another name.',
        code: 'http_409',
    });
    // In her room, a Space everyone there reads still clashes, by name.
    expect(await f.renameTool('ada', roomId)({ spaceId: f.open.id, name: 'handbook' })).toEqual({
        error: 'Another Space is named “Handbook”. Choose another name.',
        code: 'http_409',
    });
    // Her private Spaces are hidden there: nothing says they exist, as Settings allows the name.
    expect(await f.renameTool('ada', roomId)({ spaceId: f.open.id, name: 'deals' })).toMatchObject({ renamed: true });
    const done = await f.renameTool('ada', roomId)({ spaceId: f.open.id, name: 'Acquisition' });
    expect(JSON.stringify(done)).not.toMatch(/another space/i);
    expect(done).toEqual({ renamed: true, space: { id: f.open.id, name: 'Acquisition' }, url: `/spaces/${f.open.id}` });
});

it('checks the editor again under the write lock, after a change of its people queued before it', async () => {
    const f = await fixture();
    const { uow } = sqliteData(f.workspace.db);
    const gate = () => {
        let open!: () => void;
        const opened = new Promise<void>((resolve) => (open = resolve));
        return { open, opened };
    };
    // Ada is an editor when she asks; her removal commits before her rename runs.
    const start = gate();
    const removal = uow.run(async () => {
        await start.opened;
        await f.as('alice')(`/spaces/${f.open.id}/people/ada`, 'PUT', { role: 'member' });
    });
    const late = f.workspace.renameSpace(f.open.id, 'ada', 'Late').catch((error: unknown) => error);
    start.open();
    await removal;
    expect(await late).toMatchObject({ status: 403 });
    expect(await f.named('alice', f.open.id)).toBe('Wiki');
    // Nina is made an editor in a change that then rolls back: her rename,
    // asked while the grant showed and queued behind it, is refused.
    const granted = gate();
    const finish = gate();
    const grant = uow.run(async () => {
        await f.as('alice')(`/spaces/${f.open.id}/people/nina`, 'PUT', { role: 'editor' });
        granted.open();
        await finish.opened;
        throw new Error('rolled back');
    });
    await granted.opened;
    const borrowed = f.workspace.renameSpace(f.open.id, 'nina', 'Borrowed').catch((error: unknown) => error);
    finish.open();
    await expect(grant).rejects.toThrow('rolled back');
    expect(await borrowed).toMatchObject({ status: 403 });
    expect(await f.named('alice', f.open.id)).toBe('Wiki');
});

it('checks a socio’s grant and the clash again under the write lock', async () => {
    const f = await fixture();
    const { uow } = sqliteData(f.workspace.db);
    /** Holds the write lock until it is let go, then makes `change` and commits. */
    const queued = (change: () => unknown) => {
        let go!: () => void;
        const let_ = new Promise<void>((resolve) => (go = resolve));
        const done = uow.run(async () => {
            await let_;
            await change();
        });
        return { go, done };
    };
    // The Space is taken from the socio after Ada asks, before her rename runs.
    const revoke = queued(() => {
        const dot = f.workspace.dot(f.company.id)!;
        return f.workspace.updateDot(f.company.id, {
            name: dot.name,
            instructions: dot.instructions,
            researchAllowed: dot.researchAllowed,
            memoryAllowed: dot.memoryAllowed,
            spaceId: dot.spaceId,
            spaceIds: (dot.spaceIds ?? []).filter((id) => id !== f.open.id),
        });
    });
    const ungranted = f.renameTool('ada')({ spaceId: f.open.id, name: 'Late' });
    revoke.go();
    await revoke.done;
    expect(await ungranted).toEqual({ error: 'Space not found.', code: 'http_404' });
    expect(await f.named('ada', f.open.id)).toBe('Wiki');
    // Another Space takes the name after Ada asks: refused, named.
    const taken = queued(() => f.workspace.renameSpace(f.closed.id, 'ada', 'Atlas'));
    const clash = f.renameTool('ada')({ spaceId: f.secret.id, name: 'atlas' });
    taken.go();
    await taken.done;
    expect(await clash).toEqual({ error: 'Another Space is named “Atlas”. Choose another name.', code: 'http_409' });
    expect(await f.named('ada', f.secret.id)).toBe('Acquisition');
});
