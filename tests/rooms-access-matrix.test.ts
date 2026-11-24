import { Context } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import type { User } from '@socio/shared/types';

import { AppTurns } from '../src/server/composition/app/turns.js';
import { runTraceView } from '../src/server/runs/views.js';
import type { TurnOutcome } from '../src/server/turns/contract.js';
import { validateRuntimeScope } from '../src/server/turns/runtime-scope.js';

import { ROOM_PEOPLE, ToolAgent, matrixChats, roomsFixture, runAs, type Caller } from './fixtures/rooms.js';
import { ScriptAgent } from './fixtures/script-agent.js';
import { testWorkspaceViews } from './helpers/page-views.js';

/** The app's turns edge (`AppTurns`), which the graph's steps run a socio's turn through. */
const appTurns = (f: { edge: { services: unknown } }) =>
    Context.getUnsafe(f.edge.services as Context.Context<never>, AppTurns);

// CB-208: every site that checks a chat's owner answers by the one rule
// (`roomAllows` through `WorkspaceStore.roomAccess`). Each site is checked for
// the whole matrix: a private chat's owner and a non-owner, a room's admin and
// member, a removed member, an invited person who has not joined, and a
// workspace admin, who gets no room access from the role.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const PEOPLE = ['olive', 'nina', 'ada', 'mo', 'rex', 'ivy', 'alice'] as const;
type Person = (typeof PEOPLE)[number];

/** Each person's statuses for each request, as one table to compare. */
async function table(
    as: (id: string) => Caller,
    requests: Record<string, [path: string, method?: string, body?: unknown]>,
    people: readonly Person[] = PEOPLE,
) {
    const out: Record<string, Record<string, number>> = {};
    for (const person of people) {
        out[person] = {};
        for (const [name, [path, method, body]] of Object.entries(requests)) {
            out[person][name] = (await as(person)(path, method, body)).status;
        }
    }
    return out;
}

/** The same row for everyone, but those given. */
const rows = (
    others: Record<string, number>,
    given: Partial<Record<Person, Record<string, number>>>,
    people: readonly Person[] = PEOPLE,
) =>
    Object.fromEntries(people.map((person) => [person, given[person] ?? others])) as Record<
        string,
        Record<string, number>
    >;

const reads = (id: string, room: boolean) => ({
    transcript: [`/conversations/${id}/transcript`] as [string],
    history: [`/conversations/${id}/history`] as [string],
    queue: [`/conversations/${id}/steering`] as [string],
    skill: [`/chat-skills/threads/${id}`] as [string],
    reactions: [`/conversations/${id}/reactions`] as [string],
    ...(room ? { room: [`/rooms/${id}`] as [string] } : {}),
    // Private only: deletion's preview and a capture are an owner's.
    deletion: [`/conversations/${id}/deletion`] as [string],
    capture: [`/conversations/${id}/capture`] as [string],
});

const listed = async (as: (id: string) => Caller, person: string) => {
    const view = (await (await as(person)('/workspace')).json()) as {
        conversations: Array<{ id: string; roomRole?: string }>;
        archived: Array<{ id: string }>;
    };
    return view;
};

it('reads a private chat as before and a room by membership: every read site, the whole matrix', async () => {
    const f = await roomsFixture(cleanup);
    const { privateId, roomId } = await matrixChats(f);

    const ok = (names: string[], code = 200) => Object.fromEntries(names.map((name) => [name, code]));
    const missing = (requests: object) => Object.fromEntries(Object.keys(requests).map((name) => [name, 404]));

    // The private chat: Olive, as before; nobody else, room people included.
    const privateReads = reads(privateId, false);
    expect(await table(f.as, privateReads)).toEqual(
        rows(missing(privateReads), {
            olive: ok(Object.keys(privateReads)),
        }),
    );

    // The room: its active members read it; deletion and capture are no
    // room's; a removed member, an invite and a workspace admin read nothing.
    const roomReads = reads(roomId, true);
    const member = {
        ...ok(['transcript', 'history', 'queue', 'skill', 'reactions', 'room']),
        deletion: 404,
        capture: 404,
    };
    expect(await table(f.as, roomReads)).toEqual(rows(missing(roomReads), { ada: member, mo: member }));

    // The chat lists (`conversations`, sites 1-2): the room is its members',
    // with their role; a pending invite lists nothing.
    for (const person of PEOPLE) {
        const view = await listed(f.as, person);
        const ids = view.conversations.map((row) => row.id);
        expect(ids.includes(roomId), person).toBe(['ada', 'mo'].includes(person));
        expect(ids.includes(privateId), person).toBe(person === 'olive');
    }
    expect((await listed(f.as, 'ada')).conversations.find((row) => row.id === roomId)).toMatchObject({
        kind: 'room',
        roomRole: 'admin',
    });
    expect((await listed(f.as, 'mo')).conversations.find((row) => row.id === roomId)).toMatchObject({
        kind: 'room',
        roomRole: 'member',
    });

    // A socio's shared area (site 6): a room membership counts as a chat.
    for (const person of PEOPLE) {
        expect(f.workspace.usedDot(person, f.company.id), person).toBe(['olive', 'ada', 'mo'].includes(person));
    }

    // Owner-only checks (sites 4, 5, 19, 23, 31: calls, scheduled tasks,
    // research, deletion, voice) never take a room, for anyone.
    for (const person of PEOPLE) {
        expect(() => f.workspace.requireOwnedThread(person, roomId)).toThrow();
        if (person !== 'olive') {
            expect(() => f.workspace.requireOwnedThread(person, privateId)).toThrow();
        }
    }
    expect(f.workspace.requireOwnedThread('olive', privateId).id).toBe(privateId);
    expect(f.workspace.callsFor('ada')).toEqual([]);
});

it('acts by role: members send, admins manage, nobody deletes a room, private-only sites stay closed', async () => {
    const f = await roomsFixture(cleanup);
    const { privateId, roomId } = await matrixChats(f);
    // A queued message would start a turn: not here.
    vi.spyOn(f.platform.steering, 'consider').mockResolvedValue(false);

    const room = await table(f.as, {
        rename: [`/conversations/${roomId}`, 'PATCH', { title: 'Renamed' }],
        renameRoom: [`/rooms/${roomId}`, 'PATCH', { title: 'Renamed again' }],
        model: [`/conversations/${roomId}`, 'PATCH', { inference: null }],
        queue: [`/conversations/${roomId}/steering`, 'POST', { text: 'Hi' }],
        call: ['/voice/calls', 'POST', { threadId: roomId, backend: 'self-hosted' }],
        remove: [`/conversations/${roomId}`, 'DELETE'],
    });
    const nobody = {
        rename: 404,
        renameRoom: 404,
        model: 404,
        queue: 404,
        call: 404,
        remove: 404,
    };
    expect(room).toEqual(
        rows(nobody, {
            ada: {
                rename: 200,
                renameRoom: 200,
                model: 200,
                queue: 201,
                call: 404,
                remove: 409,
            },
            mo: {
                rename: 403,
                renameRoom: 403,
                model: 403,
                queue: 201,
                call: 404,
                remove: 409,
            },
        }),
    );
    expect(f.workspace.thread(roomId)?.title).toBe('Renamed again');

    // The private chat, as before: Olive alone.
    const own = await table(f.as, {
        rename: [`/conversations/${privateId}`, 'PATCH', { title: 'Mine' }],
        queue: [`/conversations/${privateId}/steering`, 'POST', { text: 'Hi' }],
    });
    expect(own).toEqual(rows({ rename: 404, queue: 404 }, { olive: { rename: 200, queue: 201 } }));

    // Uploading an attachment to the chat (site 16): `send`.
    const upload = async (person: string, threadId: string) =>
        f.platform.media
            .upload(person, {
                name: 'note.txt',
                bytes: new TextEncoder().encode('hello'),
                purpose: 'attachment',
                threadId,
            })
            .then(
                () => 200,
                (error: { status?: number }) => error.status ?? 500,
            );
    for (const person of PEOPLE) {
        expect(await upload(person, roomId), person).toBe(['ada', 'mo'].includes(person) ? 200 : 404);
        expect(await upload(person, privateId), person).toBe(person === 'olive' ? 200 : 404);
    }

    // The runtime's routes (site 13): `run` sends, `stop` is checked
    // against the cycle after; `connect` reads, served as the member's own
    // filtered stream (CB-212). A private chat's owner does all three, as
    // before.
    const scope = (person: string, threadId: string, path: string) => {
        const agent = f.company.id;
        const url = `http://localhost/api/copilotkit/agent/${agent}/${path}`;
        try {
            validateRuntimeScope(new Request(url, { method: 'POST' }), f.workspace, { threadId }, person);
            return 'ok';
        } catch {
            return 'denied';
        }
    };
    for (const person of PEOPLE) {
        const member = ['ada', 'mo'].includes(person);
        expect(scope(person, roomId, 'run'), person).toBe(member ? 'ok' : 'denied');
        expect(scope(person, roomId, 'connect'), person).toBe(member ? 'ok' : 'denied');
        expect(scope(person, roomId, `stop/${roomId}`), person).toBe(member ? 'ok' : 'denied');
        for (const path of ['run', 'connect', `stop/${privateId}`]) {
            expect(scope(person, privateId, path), `${person} ${path}`).toBe(person === 'olive' ? 'ok' : 'denied');
        }
    }
    // Stop in a room: the cycle's initiator or a room admin (`mayStop`).
    expect(await f.platform.cycles.mayStop(roomId, 'ada')).toBe(true);
    expect(await f.platform.cycles.mayStop(roomId, 'mo')).toBe(false);
    expect(await f.platform.cycles.mayStop(roomId, 'alice')).toBe(false);

    // The MCP runtime and an approval's continuation (sites 21, 29) ask
    // whether the acting person may send there.
    for (const person of PEOPLE) {
        expect(f.workspace.allows(person, roomId, 'send'), person).toBe(['ada', 'mo'].includes(person));
        expect(f.workspace.allows(person, privateId, 'send'), person).toBe(person === 'olive');
    }

    // The owner deletes her own chat, as before; nobody else can.
    expect((await f.as('ada')(`/conversations/${privateId}`, 'DELETE')).status).toBe(404);
    expect((await f.as('olive')(`/conversations/${privateId}`, 'DELETE')).status).toBe(200);
});

it('keeps an archived room, and every room with Rooms off, read-only for its members, who can still leave', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    vi.spyOn(f.platform.steering, 'consider').mockResolvedValue(false);
    const ada = f.as('ada');
    const mo = f.as('mo');

    // Only an admin archives (site 8).
    expect((await mo(`/conversations/${roomId}`, 'PATCH', { archived: true })).status).toBe(403);
    expect((await ada(`/conversations/${roomId}`, 'PATCH', { archived: true })).status).toBe(200);
    const archived = await table(
        f.as,
        {
            read: [`/conversations/${roomId}/transcript`],
            history: [`/conversations/${roomId}/history`],
            queue: [`/conversations/${roomId}/steering`, 'POST', { text: 'Hi' }],
            rename: [`/rooms/${roomId}`, 'PATCH', { title: 'Nope' }],
            invite: [`/rooms/${roomId}/invites`, 'POST', { userId: 'nina' }],
        },
        ['ada', 'mo', 'alice'],
    );
    expect(archived).toEqual({
        ada: { read: 200, history: 200, queue: 409, rename: 409, invite: 409 },
        // The rule says archived before it asks for the admin role.
        mo: { read: 200, history: 200, queue: 409, rename: 409, invite: 409 },
        alice: { read: 404, history: 404, queue: 404, rename: 404, invite: 404 },
    });
    // Listed with the archived chats (site 2), for its members.
    for (const person of ['ada', 'mo', 'alice']) {
        expect(
            (await listed(f.as, person)).archived.some((row) => row.id === roomId),
            person,
        ).toBe(person !== 'alice');
    }
    expect((await mo(`/rooms/${roomId}/unarchive`, 'POST')).status).toBe(403);
    expect((await ada(`/rooms/${roomId}/unarchive`, 'POST')).status).toBe(200);

    // Rooms off: read and leave, nothing else.
    f.store.updateSettings({ rooms: { enabled: false } });
    expect(
        await table(
            f.as,
            {
                read: [`/conversations/${roomId}/transcript`],
                queue: [`/conversations/${roomId}/steering`, 'POST', { text: 'Hi' }],
                rename: [`/rooms/${roomId}`, 'PATCH', { title: 'Nope' }],
            },
            ['ada', 'mo'],
        ),
    ).toEqual({
        ada: { read: 200, queue: 409, rename: 409 },
        mo: { read: 200, queue: 409, rename: 409 },
    });
    expect((await mo(`/rooms/${roomId}/leave`, 'POST')).status).toBe(200);
    expect((await mo(`/conversations/${roomId}/transcript`)).status).toBe(404);
});

it('runs a room turn as its sender, withholds their private results from other members, and gives each their own traces', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const runner = f.platform.runner;
    await runAs(
        runner,
        f.company.id,
        roomId,
        'run-ada',
        'ada',
        new ToolAgent({ id: 'call-ada', result: 'ADA-PRIVATE-CANARY 3pm dentist' }),
    );
    // The work cycle acted as Ada, the sender.
    const adaRun = runner.runTrace('run-ada');
    expect(adaRun?.status).toBe('finished');
    expect(adaRun?.trace?.trigger).toEqual({ kind: 'person', id: 'ada' });
    expect(adaRun?.trace?.cycle).toMatchObject({ actingUserId: 'ada' });

    // History (site 12): Ada reads her result; Mo gets it withheld.
    const history = async (person: string) =>
        JSON.stringify(await (await f.as(person)(`/conversations/${roomId}/history`)).json());
    expect(await history('ada')).toContain('ADA-PRIVATE-CANARY');
    const forMo = await history('mo');
    expect(forMo).not.toContain('ADA-PRIVATE-CANARY');
    expect(forMo).toContain('withheld');
    const full = async (person: string) =>
        (await f.as(person)(`/conversations/${roomId}/tool-results/call-ada`)).json();
    expect(JSON.stringify(await full('ada'))).toContain('ADA-PRIVATE-CANARY');
    expect(JSON.stringify(await full('mo'))).not.toContain('ADA-PRIVATE-CANARY');
    expect((await f.as('rex')(`/conversations/${roomId}/tool-results/call-ada`)).status).toBe(404);

    // Traces (site 28): the initiator's; a room admin who didn't start it
    // sees none, a workspace admin sees it (and it is logged as theirs).
    const trace = (person: User['id']) =>
        runTraceView(
            f.platform,
            {
                id: person,
                admin: ROOM_PEOPLE.find((user) => user.id === person)!.role === 'admin',
            },
            'run-ada',
        );
    expect(trace('ada')?.ownerId).toBe('ada');
    expect(trace('mo')).toBeNull();
    expect(trace('rex')).toBeNull();
    expect(trace('alice')).not.toBeNull();
    expect(trace('alice')?.ownerId).not.toBe('alice');

    // Run summaries say which runs the viewer can open (site 27).
    expect(await f.workspace.readableThread('mo', roomId)).toMatchObject({
        roomRole: 'member',
    });

    // Reactions (site 18): members react while they may send.
    const react = (person: string) => f.as(person)(`/conversations/${roomId}/messages/t-run-ada/reactions/up`, 'PUT');
    expect((await react('mo')).status).toBe(200);
    expect((await react('ivy')).status).toBe(404);
    expect((await react('alice')).status).toBe(404);
    expect(
        (
            (await (await f.as('mo')(`/conversations/${roomId}/reactions`)).json()) as {
                shared: boolean;
            }
        ).shared,
    ).toBe(true);

    // A turn nobody in the room sent is refused, never run as its owner.
    for (const person of ['ivy', 'rex', 'nina', 'alice']) {
        await runAs(runner, f.company.id, roomId, `run-${person}`, person, new ScriptAgent('No.'));
        expect(runner.runTrace(`run-${person}`)?.status, person).toBe('failed');
    }
});

it('ends a removed member’s access at once: their next request, their running turn and queued work', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const agent = new ScriptAgent('Thinking…', true);
    const running = runAs(f.platform.runner, f.company.id, roomId, 'run-mo', 'mo', agent);
    // Its work cycle is open, as Mo's (CB-211).
    await vi.waitFor(async () =>
        expect(await f.platform.cycles.running(roomId)).toMatchObject({
            initiator: { kind: 'person', id: 'mo' },
            actingUserId: 'mo',
        }),
    );
    expect(await f.platform.cycles.mayStop(roomId, 'mo')).toBe(true);
    expect(await f.platform.cycles.mayDispatch(roomId, 'mo')).toBe(true);

    expect((await f.as('ada')(`/rooms/${roomId}/members/mo`, 'DELETE')).status).toBe(200);
    // Their turn is stopped, their next request refused as if the room
    // weren't there, and their queued messages are not dispatched.
    await vi.waitFor(() => expect(agent.aborted).toBe(true));
    await running;
    expect((await f.as('mo')(`/conversations/${roomId}/transcript`)).status).toBe(404);
    expect((await f.as('mo')(`/rooms/${roomId}`)).status).toBe(404);
    expect(await f.platform.cycles.mayDispatch(roomId, 'mo')).toBe(false);
    expect(f.workspace.allows('mo', roomId, 'send')).toBe(false);
    expect(f.workspace.usedDot('mo', f.company.id)).toBe(false);
});

it('moves the room’s live-update keys with membership: invited, joined, removed', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    const user = (id: string) => ROOM_PEOPLE.find((person) => person.id === id)!;
    const version = (id: string) => testWorkspaceViews(f.platform).workspaceVersion(user(id));
    const before = { nina: await version('nina'), mo: await version('mo') };
    await f.as('ada')(`/rooms/${roomId}/invites`, 'POST', { userId: 'nina' });
    const invited = { nina: await version('nina'), mo: await version('mo') };
    // Nina's own list moves (her invite); Mo reads the room's key.
    expect(invited.nina).not.toBe(before.nina);
    expect(invited.mo).not.toBe(before.mo);
    // A rename bumps the room's key, which each member reads.
    const olive = await version('olive');
    await f.as('ada')(`/rooms/${roomId}`, 'PATCH', { title: 'New name' });
    const renamed = await version('mo');
    expect(renamed).not.toBe(invited.mo);
    expect(await version('olive')).toBe(olive);

    // The room's socios and its limits are in each member's room view
    // (CB-212): they move the room's key; a socio asked for moves the
    // workspace admins' too, who let it in.
    const other = f.workspace.createDot(f.company.spaceId, 'Rulo', '', true, true, [f.company.spaceId]);
    const admin = await version('alice');
    const outside = await version('olive');
    expect(
        (
            await f.as('ada')(`/rooms/${roomId}/socios`, 'POST', {
                dotId: other.id,
            })
        ).status,
    ).toBe(201);
    const asked = await version('mo');
    expect(asked).not.toBe(renamed);
    expect(await version('alice')).not.toBe(admin);
    expect(await version('olive')).toBe(outside);
    await f.as('ada')(`/rooms/${roomId}/limits`, 'PUT', {
        messagesPerMinute: 5,
    });
    expect(await version('mo')).not.toBe(asked);
    expect(await version('olive')).toBe(outside);
});

it('carries an approval or a long run on in a room only for a member who may still send (sites 29, 30)', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // A socio's turn, as the graph's steps reach it: `AppTurns`.
    const turns = vi.spyOn(appTurns(f), 'turnOutcome').mockResolvedValue({ text: '' } as TurnOutcome);
    vi.spyOn(f.platform.approvals, 'recordNote').mockResolvedValue(undefined);
    const marked = vi.spyOn(f.platform.approvals, 'markContinuation').mockResolvedValue(undefined as never);
    const decided = (userId: string) => [
        {
            id: `req-${userId}`,
            userId,
            dotId: f.company.id,
            summary: 'Read the calendar',
            status: 'approved' as const,
            outcome: 'Done.',
        },
    ];
    for (const person of ['rex', 'ivy', 'mo']) {
        vi.spyOn(f.platform.approvals, 'readyToContinue').mockResolvedValueOnce(decided(person)).mockResolvedValue([]);
        await f.platform.continuations.consider(roomId);
    }
    // Rex (removed) and Ivy (invited) are skipped; Mo's carries on as Mo.
    expect(
        marked.mock.calls
            .filter(([, status]) => status === 'skipped')
            .map(([ids, , options]) => [ids[0], options?.detail]),
    ).toEqual([
        ['req-rex', expect.stringContaining('no longer work in this room')],
        ['req-ivy', expect.stringContaining('no longer work in this room')],
    ]);
    await vi.waitFor(() => expect(turns).toHaveBeenCalledTimes(1));
    expect(turns.mock.calls[0]?.[3]).toMatchObject({
        trigger: { kind: 'person', id: 'mo' },
    });

    // A long run's report: the person who started it, still a member.
    turns.mockClear();
    vi.spyOn(f.platform.longRuns, 'reported').mockResolvedValue(undefined as never);
    vi.spyOn(f.platform.longRuns, 'view').mockRejectedValue(new Error('none'));
    vi.spyOn(f.platform.jobs, 'job').mockRejectedValue(new Error('none'));
    const row = (userId: string) =>
        ({
            id: `long-${userId}`,
            userId,
            dotId: f.company.id,
            threadId: roomId,
            jobId: 'job',
        }) as unknown as Parameters<typeof f.platform.longRunReports.report>[0];
    await f.platform.longRunReports.report(row('rex'));
    expect(turns).not.toHaveBeenCalled();
    await f.platform.longRunReports.report(row('mo'));
    expect(turns).toHaveBeenCalledTimes(1);
    expect(turns.mock.calls[0]?.[3]).toMatchObject({ actingUserId: 'mo' });
});

it('lets members read a room’s attachments and nobody else (site 15)', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    const ref = (
        await f.platform.media.upload('ada', {
            name: 'plan.txt',
            bytes: new TextEncoder().encode('plan'),
            purpose: 'attachment',
            threadId: roomId,
        })
    ).attachment!;
    for (const person of PEOPLE) {
        expect(!!(await f.platform.media.readable(person, ref.id)), person).toBe(['ada', 'mo'].includes(person));
    }
});
