import type { ToolDefinition } from '@copilotkit/runtime/v2';
import { afterEach, expect, it, vi } from 'vitest';

import type { DotTurn } from '@socio/foundation/turns/turn';
import { APPROVAL_CAPABILITIES } from '@socio/shared/approvals';
import { ROOM_DISCLOSURE_VERSION } from '@socio/shared/rooms/rooms';
import type { Space, WorkspaceState } from '@socio/shared/types';

import { pageAccess } from '../src/server/pages/page-tools.js';

import { roomsFixture } from './fixtures/rooms.js';

// CB-271: a socio's create_space. The owner's decision of 2026-10-28: a
// member's socio makes a private Space only, with the member as editor;
// an admin's, private or for the whole workspace; always on the person's
// approval card (name, description, who will see it), never skipped; the
// new Space is granted to the socio, which reads it by the private-Space
// rules for socios in chats (SpaceAccess.reads).

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const CAPABILITY = APPROVAL_CAPABILITIES.spaceCreate;
type Result = Record<string, unknown> & {
    status?: string;
    id?: string;
    error?: string;
    code?: string;
};

async function fixture() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = await roomsFixture(cleanup);
    const socio = f.company;
    const chat = (userId: string) => {
        const threadId = `${userId}-chat`;
        if (!f.workspace.thread(threadId)) {
            f.workspace.bindThread(threadId, socio.id, 'Chat', userId);
        }
        return threadId;
    };
    const turn = (userId: string, threadId = chat(userId)): DotTurn => ({
        dot: f.workspace.dot(socio.id)!,
        userId,
        threadId,
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
    });
    /** The registered create_space of a turn, as the socio calls it. */
    const createSpace = (userId: string, threadId?: string) => {
        const tools = f.platform.dotExtensions.tools(turn(userId, threadId));
        const found = tools.find((tool) => tool.name === 'create_space') as
            | (ToolDefinition & { execute: (input: unknown) => Promise<unknown> })
            | undefined;
        if (!found) {
            throw new Error('No create_space tool.');
        }
        return (input: Record<string, unknown>) => found.execute(input) as Promise<Result>;
    };
    const named = (name: string) => f.workspace.spaces().filter((space) => space.name === name);
    const sees = async (userId: string, spaceId: string) =>
        ((await (await f.as(userId)('/workspace')).json()) as WorkspaceState).spaces.some(
            (space) => space.id === spaceId,
        );
    const decide = (id: string, userId: string, approve: boolean) => f.platform.approvals.decide(id, userId, approve);
    return { ...f, socio, chat, turn, createSpace, named, sees, decide };
}

it('lets a member’s socio make a private Space on their approval, with them as its editor, and add a page to it at once', async () => {
    const f = await fixture();
    const asked = await f.createSpace('nina')({
        name: 'Design',
        description: 'Mood boards and articles.',
    });
    expect(asked).toMatchObject({
        status: 'pending_approval',
        usableHere: true,
    });
    // Nothing is made before the person decides.
    expect(f.named('Design')).toEqual([]);
    // The card: the name, the description and who will see it.
    const card = await f.platform.approvals.get(asked.id!, 'nina');
    expect(card).toMatchObject({
        capability: CAPABILITY,
        summary: 'Create the private Space “Design”',
        status: 'pending',
    });
    expect(card.details).toEqual([
        'Name: Design',
        'Description: Mood boards and articles.',
        expect.stringMatching(/^Who can see it: only its people.*You are its editor/),
        expect.stringContaining(`${f.socio.name} gets the Space`),
    ]);
    // Only its person decides it.
    await expect(f.decide(asked.id!, 'alice', true)).rejects.toThrow('not found');
    const decided = await f.decide(asked.id!, 'nina', true);
    expect(decided.status).toBe('approved');
    const [space] = f.named('Design') as [Space];
    expect(space.description).toBe('Mood boards and articles.');
    expect(decided.outcome).toBe(
        `Created the private Space “Design” (spaceId ${space.id}). ${f.socio.name} has it and may add pages to it.`,
    );
    // Private, Nina its editor, as when she makes one herself.
    expect(f.workspace.spaceAccess.level(space.id, 'nina')).toBe('editor');
    expect(await f.sees('nina', space.id)).toBe(true);
    expect(await f.sees('mo', space.id)).toBe(false);
    expect(await f.sees('alice', space.id)).toBe(true);
    // Granted to the socio, recorded in its audit as Nina's change.
    expect(f.workspace.dot(f.socio.id)!.spaceIds).toContain(space.id);
    expect(f.workspace.dotAudit(f.socio.id)).toContainEqual(
        expect.objectContaining({
            actor: 'nina',
            action: 'update',
            detail: 'Space access',
        }),
    );
    // The socio adds a page to it straight away, in Nina's chat.
    const pages = pageAccess(f.workspace, f.socio.spaceId, f.chat('nina'), () => {});
    expect(pages.spaces().map((one) => one.id)).toContain(space.id);
    const page = await pages.create({ title: 'An article', content: 'Saved.', parentId: null }, space.id);
    expect(f.workspace.pages.get(space.id, page.id).title).toBe('An article');
    // Mo's chat with the same socio: not his to read.
    const his = pageAccess(f.workspace, f.socio.spaceId, f.chat('mo'), () => {});
    expect(his.spaces().map((one) => one.id)).not.toContain(space.id);
    expect(() => his.list(space.id)).toThrow('Space access has been revoked or was not granted.');
});

it('refuses a whole-workspace Space for a member’s socio, and asks nothing', async () => {
    const f = await fixture();
    const refused = await f.createSpace('nina')({
        name: 'Everyone',
        visibility: 'workspace',
    });
    expect(refused).toMatchObject({ code: 'http_403' });
    expect(refused.error).toContain('Only workspace admins make a Space for the whole workspace.');
    expect(f.named('Everyone')).toEqual([]);
    expect(await f.platform.approvals.list('nina')).toEqual([]);
});

it('refuses a member’s socio while only admins may create Spaces, and asks nothing; an admin’s still asks', async () => {
    const f = await fixture();
    await f.store.updateSettings({ spaceCreators: 'admins' });
    const refused = await f.createSpace('nina')({ name: 'Mine' });
    expect(refused).toMatchObject({ code: 'http_403' });
    expect(refused.error).toContain('Only workspace admins can create Spaces in this workspace.');
    expect(f.named('Mine')).toEqual([]);
    expect(await f.platform.approvals.list('nina')).toEqual([]);
    expect(await f.createSpace('alice')({ name: 'Admins' })).toMatchObject({ status: 'pending_approval' });
});

it('checks the create-Spaces permission again when it runs: approved after an admin kept it to admins, it makes nothing', async () => {
    const f = await fixture();
    const asked = await f.createSpace('nina')({ name: 'Later' });
    expect(asked).toMatchObject({ status: 'pending_approval' });
    await f.store.updateSettings({ spaceCreators: 'admins' });
    const decided = await f.decide(asked.id!, 'nina', true);
    expect(decided.status).toBe('failed');
    expect(decided.outcome).toContain('Only workspace admins can create Spaces');
    expect(f.named('Later')).toEqual([]);
});

it('lets an admin’s socio make a Space for the whole workspace, or a private one', async () => {
    const f = await fixture();
    const open = await f.createSpace('alice')({
        name: 'Handbook',
        visibility: 'workspace',
    });
    const card = await f.platform.approvals.get(open.id!, 'alice');
    expect(card.summary).toBe('Create the Space “Handbook” for the whole workspace');
    expect(card.details).toEqual(
        expect.arrayContaining([
            'Description: (none)',
            'Who can see it: the whole workspace. Everyone sees it and everything in it.',
        ]),
    );
    await f.decide(open.id!, 'alice', true);
    const [handbook] = f.named('Handbook') as [Space];
    for (const person of ['mo', 'nina', 'alice']) {
        expect(await f.sees(person, handbook.id), person).toBe(true);
    }
    expect(f.workspace.dot(f.socio.id)!.spaceIds).toContain(handbook.id);

    const closed = await f.createSpace('alice')({ name: 'Board minutes' });
    expect((await f.platform.approvals.get(closed.id!, 'alice')).details[2]).toMatch(
        /^Who can see it: only its people, and workspace admins \(you/,
    );
    await f.decide(closed.id!, 'alice', true);
    const [minutes] = f.named('Board minutes') as [Space];
    expect(await f.sees('mo', minutes.id)).toBe(false);
    expect(await f.sees('alice', minutes.id)).toBe(true);
    // An admin edits every Space; no member row, as from the create dialog.
    expect(f.workspace.spaceAccess.level(minutes.id, 'alice')).toBe('editor');
    expect(f.workspace.spaceAccess.people(minutes.id, 'alice').people).toEqual([]);
});

it('never skips the person’s approval: no bypass, no automatic review', async () => {
    const f = await fixture();
    for (const policy of ['bypass', 'auto'] as const) {
        await expect(f.platform.approvals.setPolicy('alice', f.socio.id, CAPABILITY, policy)).rejects.toThrow(
            'requires your approval for every call',
        );
    }
    expect(f.platform.approvals.capabilities().find((capability) => capability.id === CAPABILITY)).toMatchObject({
        manualOnly: true,
        auto: { allowed: false },
    });
    // A policy stored before (or by hand) is still manual.
    f.workspace.db
        .prepare('INSERT INTO approval_policies(userId,dotId,capability,policy,updatedAt) VALUES(?,?,?,?,?)')
        .run('alice', f.socio.id, CAPABILITY, 'bypass', 1);
    const asked = await f.createSpace('alice')({
        name: 'Fast',
        visibility: 'workspace',
    });
    expect(asked.status).toBe('pending_approval');
    expect(f.named('Fast')).toEqual([]);
});

it('makes nothing when the person denies it', async () => {
    const f = await fixture();
    const asked = await f.createSpace('nina')({ name: 'Maybe' });
    const denied = await f.decide(asked.id!, 'nina', false);
    expect(denied.status).toBe('denied');
    expect(f.named('Maybe')).toEqual([]);
    expect(f.workspace.dot(f.socio.id)!.spaceIds).toEqual(f.socio.spaceIds);
    await expect(f.decide(asked.id!, 'nina', true)).rejects.toThrow('already decided');
});

it('refuses an invalid name, or one the person already sees, and asks once for the same name', async () => {
    const f = await fixture();
    const create = f.createSpace('nina');
    for (const name of ['', '   ', 'x'.repeat(61)]) {
        expect(await create({ name }), JSON.stringify(name)).toMatchObject({
            code: 'http_400',
            error: expect.stringContaining('Enter a Space name (up to 60 characters).'),
        });
    }
    expect(await create({ name: 'Notes', description: 'y'.repeat(501) })).toMatchObject({ code: 'http_400' });
    // The workspace's Space, by another case and spacing.
    const general = f.workspace.spaces()[0]!;
    const taken = await create({ name: `  ${general.name.toUpperCase()} ` });
    expect(taken).toMatchObject({ code: 'http_409' });
    expect(taken.error).toContain(`A Space named “${general.name}” already exists.`);
    // A private Space Nina can't see is no reason to refuse, and isn't named.
    const hidden = (await (await f.as('ada')('/spaces', 'POST', { name: 'Deals' })).json()) as Space;
    expect(await f.sees('nina', hidden.id)).toBe(false);
    const deals = await create({ name: 'Deals' });
    expect(deals.status).toBe('pending_approval');
    // Asking again while it waits is the same request, not a second.
    expect((await create({ name: 'deals' })).id).toBe(deals.id);
    expect((await f.platform.approvals.list('nina', { status: 'pending' })).length).toBe(1);
    // Made meanwhile (by Nina herself): the approved request makes no second.
    await f.as('nina')('/spaces', 'POST', { name: 'Deals' });
    const late = await f.decide(deals.id!, 'nina', true);
    expect(late.status).toBe('failed');
    expect(late.outcome).toContain('already exists');
    expect(f.workspace.spaceAccess.readable({ userId: 'nina' }).filter((space) => space.name === 'Deals')).toHaveLength(
        1,
    );
});

it('in a room, names a Space it refuses only when everyone there reads it (never one of the person’s private Spaces)', async () => {
    const f = await fixture();
    const room = (await (
        await f.as('ada')('/rooms', 'POST', {
            dotId: f.socio.id,
            title: 'Design room',
        })
    ).json()) as { id: string };
    await f.as('ada')(`/rooms/${room.id}/invites`, 'POST', { userId: 'mo' });
    await f.as('mo')(`/rooms/${room.id}/accept`, 'POST', {
        disclosureVersion: ROOM_DISCLOSURE_VERSION,
    });
    const secret = (await (
        await f.as('ada')('/spaces', 'POST', { name: 'Acquisition', private: true })
    ).json()) as Space;
    expect(await f.sees('mo', secret.id)).toBe(false);
    // In Ada's own chat, her private Space is hers to be told of: refused, named.
    const own = await f.createSpace('ada')({ name: 'acquisition' });
    expect(own).toMatchObject({ code: 'http_409' });
    expect(own.error).toContain('A Space named “Acquisition” already exists.');
    // In the room, a Space everyone there reads still clashes, by name.
    const general = f.workspace.spaces()[0]!;
    const shared = await f.createSpace('ada', room.id)({ name: general.name.toLowerCase() });
    expect(shared).toMatchObject({ code: 'http_409' });
    expect(shared.error).toContain(`A Space named “${general.name}” already exists.`);
    // Her private one is hidden there: nothing says it exists, on asking or approving.
    const asked = await f.createSpace('ada', room.id)({ name: 'Acquisition' });
    expect(JSON.stringify(asked)).not.toMatch(/already exists/i);
    expect(asked.status).toBe('pending_approval');
    const done = await f.decide(asked.id!, 'ada', true);
    expect(done.outcome).not.toMatch(/already exists/i);
    expect(done.status).not.toBe('failed');
});

it('checks the person’s role again when it runs: an admin made a member makes no open Space', async () => {
    const f = await fixture();
    const asked = await f.createSpace('alice')({
        name: 'Open later',
        visibility: 'workspace',
    });
    f.workspace.recordUser({ id: 'alice', name: 'Alice', role: 'member' });
    const decided = await f.decide(asked.id!, 'alice', true);
    expect(decided.status).toBe('failed');
    expect(decided.outcome).toContain('Only workspace admins');
    expect(f.named('Open later')).toEqual([]);
});

it('in a room, makes the private Space for its person only: the socio uses it in their own chat, not the room', async () => {
    const f = await fixture();
    const room = (await (
        await f.as('ada')('/rooms', 'POST', {
            dotId: f.socio.id,
            title: 'Design room',
        })
    ).json()) as { id: string };
    await f.as('ada')(`/rooms/${room.id}/invites`, 'POST', { userId: 'mo' });
    await f.as('mo')(`/rooms/${room.id}/accept`, 'POST', {
        disclosureVersion: ROOM_DISCLOSURE_VERSION,
    });
    const asked = await f.createSpace('ada', room.id)({ name: 'Room notes' });
    expect(asked).toMatchObject({
        status: 'pending_approval',
        usableHere: false,
        note: expect.stringContaining('not this one'),
    });
    const card = await f.platform.approvals.get(asked.id!, 'ada');
    expect(card.details).toEqual(
        expect.arrayContaining([
            'Not usable by the socio in this chat: not everyone here can see a private Space.',
            expect.stringContaining('Asked in the room “Design room”'),
        ]),
    );
    // Mo, a member of the room, can't decide Ada's request.
    await expect(f.decide(asked.id!, 'mo', true)).rejects.toThrow('not found');
    await f.decide(asked.id!, 'ada', true);
    const [notes] = f.named('Room notes') as [Space];
    expect(f.workspace.spaceAccess.level(notes.id, 'ada')).toBe('editor');
    expect(f.workspace.spaceAccess.canRead(notes.id, 'mo')).toBe(false);
    // In the room the socio may not read it (Mo can't)...
    const inRoom = pageAccess(f.workspace, f.socio.spaceId, room.id, () => {});
    expect(inRoom.spaces().map((one) => one.id)).not.toContain(notes.id);
    await expect(inRoom.create({ title: 'Leak', content: 'No.', parentId: null }, notes.id)).rejects.toThrow(
        'Space access has been revoked or was not granted.',
    );
    // ...and in Ada's own chat it adds a page at once.
    const own = pageAccess(f.workspace, f.socio.spaceId, f.chat('ada'), () => {});
    const page = await own.create({ title: 'Kept', content: 'Here.', parentId: null }, notes.id);
    expect(f.workspace.pages.get(notes.id, page.id).title).toBe('Kept');
    // Once Mo is one of its people, the room may use it too.
    await f.as('ada')(`/spaces/${notes.id}/people/mo`, 'PUT', {
        role: 'member',
    });
    expect(inRoom.spaces().map((one) => one.id)).toContain(notes.id);
});

it('in a Telegram group, a private Space is never the socio’s to use there; one for the whole workspace is', async () => {
    const f = await fixture();
    f.workspace.bindThread('group', f.socio.id, 'Team group', 'alice');
    await f.workspace.telegram.bindThread('-100:', 'group', 'group', '-100', null);
    const closed = await f.createSpace('alice', 'group')({ name: 'Quiet' });
    expect(closed).toMatchObject({ usableHere: false });
    await f.decide(closed.id!, 'alice', true);
    const open = await f.createSpace(
        'alice',
        'group',
    )({
        name: 'Loud',
        visibility: 'workspace',
    });
    expect(open).toMatchObject({ usableHere: true });
    expect(open.note).toBeUndefined();
    await f.decide(open.id!, 'alice', true);
    const [quiet] = f.named('Quiet') as [Space];
    const [loud] = f.named('Loud') as [Space];
    const group = pageAccess(f.workspace, f.socio.spaceId, 'group', () => {});
    const ids = group.spaces().map((one) => one.id);
    expect(ids).toContain(loud.id);
    expect(ids).not.toContain(quiet.id);
    const page = await group.create({ title: 'For all', content: 'Hi.', parentId: null }, loud.id);
    expect(f.workspace.pages.get(loud.id, page.id).title).toBe('For all');
    await expect(group.create({ title: 'No', content: 'No.', parentId: null }, quiet.id)).rejects.toThrow();
});

it('lists create_space with the Space pages capability', async () => {
    const f = await fixture();
    const tools = f.platform.dotExtensions.tools(f.turn('nina'));
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('create_space');
    expect(names.filter((name) => name === 'create_space')).toHaveLength(1);
});
