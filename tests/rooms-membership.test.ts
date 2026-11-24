import { afterEach, expect, it, vi } from 'vitest';

import {
    ROOM_DISCLOSURE_TEXT,
    ROOM_DISCLOSURE_VERSION,
    ROOM_INVITE_TTL_MS,
    type RoomInvite,
    type RoomPerson,
    type RoomView,
} from '@socio/shared/rooms/rooms';

import { accountLifecycle } from '../src/server/auth/accounts.js';

import { roomsFixture, type Caller } from './fixtures/rooms.js';

// CB-208: rooms' membership and lifecycle through the API. Invites that
// give nothing until accepted with the history disclosure and expire
// after 7 days, roles with an admin always left, leaving and removal that
// take effect at once, archiving, company socios a workspace admin lets
// in, a room admin's lower limits, and the room's own audit.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const json = async <T>(response: Response | Promise<Response>) => (await (await response).json()) as T;
const accept = (as: Caller, roomId: string, version = ROOM_DISCLOSURE_VERSION) =>
    as(`/rooms/${roomId}/accept`, 'POST', { disclosureVersion: version });

async function room(f: Awaited<ReturnType<typeof roomsFixture>>, members: string[] = []) {
    const ada = f.as('ada');
    const { id } = await json<{ id: string }>(ada('/rooms', 'POST', { dotId: f.company.id, title: 'Launch' }));
    for (const person of members) {
        await ada(`/rooms/${id}/invites`, 'POST', { userId: person });
        await accept(f.as(person), id);
    }
    return id;
}

const events = async (f: Awaited<ReturnType<typeof roomsFixture>>, id: string) =>
    (await f.platform.rooms.events(id, { id: 'alice', admin: true })).map(
        (event) => `${event.action}:${event.actor}:${event.targetId ?? ''}:${event.outcome}`,
    );

it('makes rooms only with Rooms on, a company socio and a name, and converts a private chat only with the history confirmed', async () => {
    const off = await roomsFixture(cleanup, { enabled: false });
    expect(
        (
            await off.as('ada')('/rooms', 'POST', {
                dotId: off.company.id,
                title: 'T',
            })
        ).status,
    ).toBe(409);

    const f = await roomsFixture(cleanup);
    const ada = f.as('ada');
    const personal = f.workspace.createDot(
        f.company.spaceId,
        'Bo',
        '',
        true,
        true,
        [f.company.spaceId],
        null,
        false,
        null,
        false,
        'ada',
    );
    expect((await ada('/rooms', 'POST', { dotId: personal.id, title: 'T' })).status).toBe(400);
    expect((await ada('/rooms', 'POST', { dotId: f.company.id, title: ' ' })).status).toBe(400);
    const made = await ada('/rooms', 'POST', {
        dotId: f.company.id,
        title: 'Launch',
    });
    expect(made.status).toBe(201);
    const { id } = await json<{ id: string }>(made);
    const view = await json<RoomView>(ada(`/rooms/${id}`));
    expect(view).toMatchObject({
        title: 'Launch',
        dotId: f.company.id,
        role: 'admin',
        roomsEnabled: true,
        members: [{ userId: 'ada', role: 'admin', status: 'active' }],
        socios: [{ dotId: f.company.id, status: 'active', lead: true }],
    });

    // Converting her own chat: the history confirmation first.
    f.workspace.bindThread('ada-chat', f.company.id, 'Mine', 'ada');
    expect((await ada('/rooms/ada-chat/convert', 'POST', { confirmHistory: false })).status).toBe(400);
    expect(
        (
            await f.as('mo')('/rooms/ada-chat/convert', 'POST', {
                confirmHistory: true,
            })
        ).status,
    ).toBe(404);
    expect((await ada('/rooms/ada-chat/convert', 'POST', { confirmHistory: true })).status).toBe(201);
    expect(f.workspace.thread('ada-chat')).toMatchObject({
        kind: 'room',
        ownerId: 'room:ada-chat',
    });
});

it('invites give nothing until accepted with the disclosure, and expire after 7 days', async () => {
    let now = Date.UTC(2026, 9, 1);
    const f = await roomsFixture(cleanup, { now: () => now });
    const id = await room(f);
    const ada = f.as('ada');
    const ivy = f.as('ivy');

    // Only an admin invites; only people who use Socio, once.
    expect((await f.as('nina')(`/rooms/${id}/invites`, 'POST', { userId: 'ivy' })).status).toBe(404);
    expect((await f.as('alice')(`/rooms/${id}/invites`, 'POST', { userId: 'ivy' })).status).toBe(404);
    for (const userId of ['nobody', 'room:x', 'telegram-team:1']) {
        expect((await ada(`/rooms/${id}/invites`, 'POST', { userId })).status, userId).toBe(400);
    }
    const invited = await ada(`/rooms/${id}/invites`, 'POST', { userId: 'ivy' });
    expect(invited.status).toBe(201);
    expect(await json(invited)).toMatchObject({
        status: 'invited',
        inviteExpiresAt: now + ROOM_INVITE_TTL_MS,
    });
    expect((await ada(`/rooms/${id}/invites`, 'POST', { userId: 'ivy' })).status).toBe(409);

    // The invite shows its room's name and what joining shares; no history.
    expect(await json<RoomInvite[]>(ivy('/rooms/invites'))).toEqual([
        expect.objectContaining({
            roomId: id,
            title: 'Launch',
            invitedBy: 'ada',
            invitedByName: 'Ada',
            memberCount: 1,
            disclosure: {
                version: ROOM_DISCLOSURE_VERSION,
                text: ROOM_DISCLOSURE_TEXT,
            },
        }),
    ]);
    for (const path of [`/rooms/${id}`, `/conversations/${id}/transcript`, `/conversations/${id}/history`]) {
        expect((await ivy(path)).status, path).toBe(404);
    }

    // Accepting needs the disclosure, the current one.
    expect((await ivy(`/rooms/${id}/accept`, 'POST', {})).status).toBe(400);
    expect((await accept(ivy, id, ROOM_DISCLOSURE_VERSION + 1)).status).toBe(400);
    expect(
        (
            await f.as('nina')(`/rooms/${id}/accept`, 'POST', {
                disclosureVersion: 1,
            })
        ).status,
    ).toBe(404);
    const joined = await accept(ivy, id);
    expect(joined.status).toBe(200);
    expect((await ivy(`/conversations/${id}/transcript`)).status).toBe(200);
    expect((await f.platform.rooms.events(id, { id: 'ada', admin: false }))[0]).toMatchObject({
        action: 'accept',
        actor: 'ivy',
        detail: 'disclosure v1',
    });
    // Accepted already: nothing more to accept.
    expect((await accept(ivy, id)).status).toBe(404);

    // An invite past its 7 days is refused and marked expired; another one
    // can be sent.
    await ada(`/rooms/${id}/invites`, 'POST', { userId: 'nina' });
    now += ROOM_INVITE_TTL_MS;
    expect(await json(f.as('nina')('/rooms/invites'))).toEqual([]);
    const late = await accept(f.as('nina'), id);
    expect(late.status).toBe(410);
    expect((await f.platform.rooms.members(id)).find((m) => m.userId === 'nina')).toMatchObject({
        status: 'expired',
        endedBy: 'system',
    });
    expect((await ada(`/rooms/${id}/invites`, 'POST', { userId: 'nina' })).status).toBe(201);
    // The tick marks invites that ran out without anyone trying them.
    await ada(`/rooms/${id}/invites`, 'POST', { userId: 'rex' });
    now += ROOM_INVITE_TTL_MS + 1;
    expect(await f.platform.rooms.expireInvites()).toBe(2);
    expect(
        (await f.platform.rooms.members(id))
            .filter((m) => m.status === 'expired')
            .map((m) => m.userId)
            .sort(),
    ).toEqual(['nina', 'rex']);

    // Declining ends it too.
    now += 1;
    await ada(`/rooms/${id}/invites`, 'POST', { userId: 'rex' });
    expect((await f.as('rex')(`/rooms/${id}/decline`, 'POST')).status).toBe(200);
    expect((await accept(f.as('rex'), id)).status).toBe(404);
});

it('accepts an invite once, and an accept beside a removal leaves the person out', async () => {
    const f = await roomsFixture(cleanup);
    const id = await room(f);
    const ada = f.as('ada');
    await ada(`/rooms/${id}/invites`, 'POST', { userId: 'mo' });
    const twice = await Promise.all([accept(f.as('mo'), id), accept(f.as('mo'), id)]);
    expect(twice.map((response) => response.status).sort()).toEqual([200, 404]);
    expect((await events(f, id)).filter((line) => line.startsWith('accept:'))).toHaveLength(1);

    for (let round = 0; round < 3; round += 1) {
        await ada(`/rooms/${id}/invites`, 'POST', { userId: 'ivy' });
        await Promise.all([accept(f.as('ivy'), id), ada(`/rooms/${id}/members/ivy`, 'DELETE')]);
        const ivy = (await f.platform.rooms.members(id)).find((m) => m.userId === 'ivy');
        expect(ivy?.status).toBe('removed');
        expect((await f.as('ivy')(`/conversations/${id}/transcript`)).status).toBe(404);
    }
});

it('keeps an admin: the last one hands the role on or archives first, also when two leave at once', async () => {
    const f = await roomsFixture(cleanup);
    const id = await room(f, ['mo', 'rex']);
    const ada = f.as('ada');
    const mo = f.as('mo');

    expect((await ada(`/rooms/${id}/leave`, 'POST')).status).toBe(409);
    expect((await ada(`/rooms/${id}/members/ada`, 'PATCH', { role: 'member' })).status).toBe(409);
    // Only admins change roles; members are refused, others find nothing.
    expect((await mo(`/rooms/${id}/members/mo`, 'PATCH', { role: 'admin' })).status).toBe(403);
    expect((await f.as('nina')(`/rooms/${id}/members/mo`, 'PATCH', { role: 'admin' })).status).toBe(404);
    expect((await ada(`/rooms/${id}/members/mo`, 'PATCH', { role: 'admin' })).status).toBe(200);
    // Two admins leaving at once: one goes, the other stays the admin.
    const left = await Promise.all([ada(`/rooms/${id}/leave`, 'POST'), mo(`/rooms/${id}/leave`, 'POST')]);
    expect(left.map((response) => response.status).sort()).toEqual([200, 409]);
    const members = await f.platform.rooms.members(id);
    expect(members.filter((m) => m.status === 'active' && m.role === 'admin')).toHaveLength(1);

    // Archived too, the last admin hands the role on before leaving (after
    // unarchiving: an archived room takes no changes): a room never ends up
    // without an admin.
    const stays = left[0]!.status === 409 ? 'ada' : 'mo';
    const admin = f.as(stays);
    expect((await admin(`/rooms/${id}/archive`, 'POST')).status).toBe(200);
    expect((await admin(`/rooms/${id}/leave`, 'POST')).status).toBe(409);
    expect((await admin(`/rooms/${id}/members/${stays}`, 'DELETE')).status).toBe(400);
    expect((await admin(`/rooms/${id}/members/rex`, 'PATCH', { role: 'admin' })).status).toBe(409);
});

it('hands a room on when its last admin is deactivated, and keeps an empty room archived', async () => {
    let now = Date.UTC(2026, 9, 1);
    const f = await roomsFixture(cleanup, { now: () => now });
    const deactivated = new Set<string>();
    f.workspace.useDeactivated(() => [...deactivated]);
    const id = await room(f);
    // Ivy joins before Mo, Rex last: Ivy is the earliest member.
    for (const person of ['ivy', 'mo', 'rex']) {
        now += 1000;
        await f.as('ada')(`/rooms/${id}/invites`, 'POST', { userId: person });
        await accept(f.as(person), id);
    }
    // A deactivated admin counts for nothing: the last active one can't
    // step down or leave on its strength.
    await f.as('ada')(`/rooms/${id}/members/mo`, 'PATCH', { role: 'admin' });
    deactivated.add('mo');
    expect((await f.as('ada')(`/rooms/${id}/leave`, 'POST')).status).toBe(409);
    deactivated.delete('mo');
    await f.as('ada')(`/rooms/${id}/members/mo`, 'PATCH', { role: 'member' });

    // The preview (CB-360) says the room would be handed on; Ivy's, an
    // ordinary member's, says nothing changes.
    expect(await f.platform.rooms.handOverPreview('ada')).toEqual({ handedOver: 1, archived: 0 });
    expect(await f.platform.rooms.handOverPreview('ivy')).toEqual({ handedOver: 0, archived: 0 });
    // Ada is deactivated: her account change hands the room to Ivy.
    deactivated.add('ada');
    await accountLifecycle(f.platform)({
        action: 'deactivate',
        userId: 'ada',
        name: 'Ada',
        by: 'alice',
    });
    const roles = async () =>
        Object.fromEntries(
            (await f.platform.rooms.members(id))
                .filter((member) => member.status === 'active')
                .map((member) => [member.userId, member.role]),
        );
    expect(await roles()).toEqual({
        ada: 'admin',
        ivy: 'admin',
        mo: 'member',
        rex: 'member',
    });
    expect((await f.platform.rooms.events(id, { id: 'alice', admin: true }))[0]).toMatchObject({
        action: 'role',
        actor: 'system',
        targetId: 'ivy',
        detail: 'member to admin: no active admin left',
    });
    // Ivy is an admin now: she manages the room.
    expect((await f.as('ivy')(`/rooms/${id}`, 'PATCH', { title: 'Ivy’s now' })).status).toBe(200);
    // Nothing more to hand on.
    expect(await f.platform.rooms.handOver()).toBe(0);

    // Everyone else deactivated too (the auth CLI, which runs no platform):
    // the tick finds no active member and archives the room, kept.
    for (const person of ['mo', 'rex']) {
        deactivated.add(person);
    }
    // Ivy is the last one: deactivating her would archive the room.
    expect(await f.platform.rooms.handOverPreview('ivy')).toEqual({ handedOver: 0, archived: 1 });
    deactivated.add('ivy');
    expect(await f.platform.rooms.handOver()).toBe(1);
    expect(f.workspace.thread(id)?.archivedAt).toBeDefined();
    expect(await f.platform.rooms.members(id)).toHaveLength(4);
    expect(await f.platform.rooms.handOver()).toBe(0);
});

it('removes members and takes back invites at once; only admins remove, never themselves', async () => {
    const f = await roomsFixture(cleanup);
    const id = await room(f, ['mo', 'rex']);
    const ada = f.as('ada');
    expect((await f.as('mo')(`/rooms/${id}/members/rex`, 'DELETE')).status).toBe(403);
    expect((await ada(`/rooms/${id}/members/ada`, 'DELETE')).status).toBe(400);
    expect((await ada(`/rooms/${id}/members/nina`, 'DELETE')).status).toBe(404);
    expect((await ada(`/rooms/${id}/members/rex`, 'DELETE')).status).toBe(200);
    expect((await f.as('rex')(`/rooms/${id}`)).status).toBe(404);
    await ada(`/rooms/${id}/invites`, 'POST', { userId: 'ivy' });
    expect((await ada(`/rooms/${id}/members/ivy`, 'DELETE')).status).toBe(200);
    expect((await accept(f.as('ivy'), id)).status).toBe(404);
    const view = await json<RoomView>(ada(`/rooms/${id}`));
    expect(view.members.map((m) => m.userId)).toEqual(['ada', 'mo']);
});

it('lets company socios in only through a workspace admin, who may take them out again; the lead must be in the room', async () => {
    const f = await roomsFixture(cleanup);
    const id = await room(f, ['mo']);
    const ada = f.as('ada');
    const alice = f.as('alice');
    const other = f.workspace.createDot(f.company.spaceId, 'Rulo', '', true, true);
    const personal = f.workspace.createDot(
        f.company.spaceId,
        'Bo',
        '',
        true,
        true,
        [f.company.spaceId],
        null,
        false,
        null,
        false,
        'ada',
    );
    const hooks = f.platform.rooms.cycleHooks();

    expect((await ada(`/rooms/${id}/socios`, 'POST', { dotId: personal.id })).status).toBe(400);
    expect((await f.as('mo')(`/rooms/${id}/socios`, 'POST', { dotId: other.id })).status).toBe(403);
    expect((await ada(`/rooms/${id}/socios`, 'POST', { dotId: other.id })).status).toBe(201);
    expect(await hooks.socio!(id, other.id)).toBe('requested');
    // Requested, it can't lead or answer.
    expect((await ada(`/rooms/${id}/lead`, 'PUT', { dotId: other.id })).status).toBe(400);
    // Only workspace admins see and decide the requests; no room access comes with it.
    expect((await ada('/rooms/socio-requests')).status).toBe(403);
    expect(await json(alice('/rooms/socio-requests'))).toEqual([
        expect.objectContaining({
            roomId: id,
            dotId: other.id,
            requestedBy: 'ada',
            dotName: 'Rulo',
        }),
    ]);
    expect((await ada(`/rooms/${id}/socios/${other.id}/authorize`, 'POST')).status).toBe(403);
    expect((await alice(`/rooms/${id}/socios/${other.id}/authorize`, 'POST')).status).toBe(200);
    expect((await alice(`/rooms/${id}`)).status).toBe(404);
    expect(await hooks.socio!(id, other.id)).toBe('active');
    expect((await ada(`/rooms/${id}/lead`, 'PUT', { dotId: other.id })).status).toBe(200);
    expect(f.workspace.thread(id)?.dotId).toBe(other.id);
    // The lead can't be taken out by a room admin; its owner withdraws it.
    expect((await ada(`/rooms/${id}/socios/${other.id}`, 'DELETE')).status).toBe(409);
    expect((await alice(`/rooms/${id}/socios/${other.id}/withdraw`, 'POST')).status).toBe(200);
    expect(await hooks.socio!(id, other.id)).toBe('withdrawn');
    // Withdrawn, the socio's turns are refused at once (CB-211's check).
    const start = await f.platform.cycles.begin({
        conversationId: id,
        runId: 'r1',
        dotId: other.id,
        trigger: { kind: 'person', id: 'mo' },
    });
    expect(start).toMatchObject({ ok: false, failure: 'room_access' });
});

it('lets room admins only lower the room’s limits, which its work cycles then run under', async () => {
    const f = await roomsFixture(cleanup);
    const id = await room(f, ['mo']);
    const ada = f.as('ada');
    // Only its admins read them, unless Settings shows members (CB-218).
    expect((await f.as('mo')(`/rooms/${id}/limits`)).status).toBe(403);
    const view = await json<{
        workspace: { cycleTokens: number; messagesPerMinute: number };
    }>(ada(`/rooms/${id}/limits`));
    const raised = await ada(`/rooms/${id}/limits`, 'PUT', {
        cycleTokens: view.workspace.cycleTokens + 1,
    });
    expect(raised.status).toBe(400);
    expect(await json(raised)).toMatchObject({
        code: 'raised',
        fields: ['cycleTokens'],
    });
    expect((await f.as('mo')(`/rooms/${id}/limits`, 'PUT', { cycleTokens: 10 })).status).toBe(403);
    expect((await ada(`/rooms/${id}/limits`, 'PUT', { cycleTokens: 0 })).status).toBe(400);
    const lowered = await ada(`/rooms/${id}/limits`, 'PUT', {
        cycleTokens: 1000,
        messagesPerMinute: 2,
    });
    expect(lowered.status).toBe(200);
    expect(await json(lowered)).toMatchObject({
        room: { cycleTokens: 1000, messagesPerMinute: 2 },
        effective: { cycleTokens: 1000, messagesPerMinute: 2 },
    });
    expect(await f.platform.cycles.limitsFor(id)).toMatchObject({
        cycleTokens: 1000,
        messagesPerMinute: 2,
    });
});

it('lets every member read the room’s handoff limit, which is no budget data, while its other limits stay hidden', async () => {
    const f = await roomsFixture(cleanup);
    const id = await room(f, ['mo']);
    const ada = f.as('ada');
    const mo = f.as('mo');
    const workspace = (await json<{ workspace: { handoffsPerCycle: number } }>(ada(`/rooms/${id}/limits`))).workspace
        .handoffsPerCycle;
    expect(workspace).toBeGreaterThan(1);
    // Mo can't see the room's use or budget (Settings → Rooms is off)...
    expect((await mo(`/rooms/${id}/limits`)).status).toBe(403);
    expect((await mo(`/rooms/${id}/usage`)).status).toBe(403);
    // ...but reads the handoff limit, and only it.
    const before = await mo(`/rooms/${id}/limits/handoffs`);
    expect(before.status).toBe(200);
    expect(await json(before)).toEqual({
        workspace,
        room: null,
        effective: workspace,
    });
    // A room admin lowers it (and a budget): Mo sees the new limit, never
    // the tokens or spend.
    await ada(`/rooms/${id}/limits`, 'PUT', {
        handoffsPerCycle: 1,
        cycleTokens: 1000,
        cycleSpendUsd: 2,
    });
    const after = await mo(`/rooms/${id}/limits/handoffs`);
    const body = await after.text();
    expect(JSON.parse(body)).toEqual({ workspace, room: 1, effective: 1 });
    expect(body).not.toMatch(/token|spend|Usd|time/i);
    // Someone outside the room learns nothing, as for a room not there.
    const stranger = await f.as('nina')(`/rooms/${id}/limits/handoffs`);
    const nowhere = await f.as('nina')('/rooms/no-such-room/limits/handoffs');
    expect(stranger.status).toBe(404);
    expect({ status: stranger.status, body: await stranger.text() }).toEqual({
        status: nowhere.status,
        body: await nowhere.text(),
    });
});

it('audits every change with actor and outcome, never content; refusals once per window; admins read it', async () => {
    const f = await roomsFixture(cleanup);
    const id = await room(f, ['mo']);
    const ada = f.as('ada');
    await ada(`/rooms/${id}`, 'PATCH', { title: 'A secret project name' });
    await ada(`/rooms/${id}/members/mo`, 'PATCH', { role: 'admin' });
    await f.as('mo')(`/rooms/${id}/leave`, 'POST');
    // Nina probes twice: one refusal line.
    await f.as('nina')(`/rooms/${id}`);
    await f.as('nina')(`/conversations/${id}/transcript`);
    await f.as('nina')(`/rooms/${id}`);
    expect(await events(f, id)).toEqual([
        `denied:nina:${id}:denied`,
        'leave:mo:mo:ok',
        'role:ada:mo:ok',
        `rename:ada:${id}:ok`,
        'accept:mo:mo:ok',
        'invite:ada:mo:ok',
        `create:ada:${id}:ok`,
    ]);
    const all = await f.platform.rooms.events(id, { id: 'alice', admin: true });
    expect(JSON.stringify(all)).not.toContain('secret project');
    expect(all[0]).toMatchObject({ detail: 'read: not_found' });

    // Room admins and workspace admins read it; members are refused.
    await ada(`/rooms/${id}/invites`, 'POST', { userId: 'ivy' });
    await accept(f.as('ivy'), id);
    expect((await ada(`/rooms/${id}/events`)).status).toBe(200);
    expect((await f.as('alice')(`/rooms/${id}/events`)).status).toBe(200);
    expect((await f.as('ivy')(`/rooms/${id}/events`)).status).toBe(403);
    expect((await f.as('nina')(`/rooms/${id}/events`)).status).toBe(404);
});

it('makes a room with several socios and initial people, the creator admin and the rest invited (CB-278)', async () => {
    const f = await roomsFixture(cleanup);
    const ada = f.as('ada');
    // A second company socio to ask for alongside the lead.
    const other = f.workspace.createDot(
        f.company.spaceId,
        'Mingo',
        '',
        true,
        true,
        [f.company.spaceId],
        null,
        false,
        null,
        false,
        null,
    );
    // The people the maker may invite: everyone signed in but the maker and
    // sentinels, by name. Ada and Mo are listed; Ada (the maker) is not.
    const candidates = await json<RoomPerson[]>(ada('/rooms/people', 'GET'));
    expect(candidates.map((person) => person.userId)).toContain('mo');
    expect(candidates.map((person) => person.userId)).not.toContain('ada');

    const made = await ada('/rooms', 'POST', {
        dotId: f.company.id,
        title: 'Launch',
        dotIds: [other.id],
        userIds: ['mo', 'ivy'],
        description: 'Plan the launch together.',
    });
    expect(made.status).toBe(201);
    const { id } = await json<{ id: string }>(made);

    // The creator is the admin; the lead socio is active; the further socio
    // is `requested`, for a workspace admin to let in. The invited people
    // show as `invited` (their invites are usable).
    const view = await json<RoomView>(ada(`/rooms/${id}`));
    expect(view).toMatchObject({ role: 'admin', dotId: f.company.id });
    const byId = Object.fromEntries(view.members.map((member) => [member.userId, member]));
    expect(byId.ada).toMatchObject({ role: 'admin', status: 'active' });
    expect(byId.mo).toMatchObject({ role: 'member', status: 'invited' });
    expect(byId.ivy).toMatchObject({ role: 'member', status: 'invited' });
    expect(view.socios).toEqual([
        { dotId: f.company.id, name: 'Sebas', status: 'active', lead: true },
        { dotId: other.id, name: 'Mingo', status: 'requested', lead: false },
    ]);

    // The invited people see their invites; the maker is already in.
    const moInvites = await json<RoomInvite[]>(f.as('mo')('/rooms/invites'));
    const ivyInvites = await json<RoomInvite[]>(f.as('ivy')('/rooms/invites'));
    expect(moInvites.map((invite) => invite.roomId)).toEqual([id]);
    expect(ivyInvites.map((invite) => invite.roomId)).toEqual([id]);
    expect(await json<RoomInvite[]>(ada('/rooms/invites'))).toEqual([]);

    // The description is kept in the room's settings.
    const row = f.workspace.db.prepare('SELECT description FROM room_settings WHERE roomId = ?').get(id) as
        | { description: string | null }
        | undefined;
    expect(row?.description).toBe('Plan the launch together.');

    // Inviting someone not eligible (a non-user) is refused; the room is
    // not made. Reserved sentinels and the maker are dropped silently.
    expect(
        (
            await ada('/rooms', 'POST', {
                dotId: f.company.id,
                title: 'Bad',
                userIds: ['nobody'],
            })
        ).status,
    ).toBe(400);
    // The maker and sentinels are dropped silently, not refused: a room
    // made with only those is still made.
    const solo = await ada('/rooms', 'POST', {
        dotId: f.company.id,
        title: 'Solo',
        userIds: ['ada', 'room:x'],
    });
    expect(solo.status).toBe(201);
});
