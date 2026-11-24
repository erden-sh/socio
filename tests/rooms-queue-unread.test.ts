import { EventType, type BaseEvent } from '@ag-ui/client';
import { Context } from 'effect';
import { lastValueFrom } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import type { QueuedMessage, SteeringView } from '@socio/shared/chat/steering';
import { ROOM_DISCLOSURE_VERSION, ROOM_UNREAD_CAP, unreadLabel, type RoomReadState } from '@socio/shared/rooms/rooms';
import type { Conversation } from '@socio/shared/types';

import { AppTurns } from '../src/server/composition/app/turns.js';
import { steeringQueue } from '../src/server/context/steering.js';
import type { TurnOutcome } from '../src/server/turns/contract.js';

import { matrixChats, roomsFixture, runAs, type Caller } from './fixtures/rooms.js';
import { ScriptAgent } from './fixtures/script-agent.js';

/** The app's turns edge (`AppTurns`), which the graph's steps run a socio's turn through. */
const appTurns = (f: { edge: { services: unknown } }) =>
    Context.getUnsafe(f.edge.services as Context.Context<never>, AppTurns);

// CB-215: in a room each member has their own queued messages (seen, edited
// and canceled by them alone), a room admin may cancel anyone's but never edit
// it, a turn's claim wins over a late edit or cancel, Stop keeps what waits,
// and each member has their own read cursor and unread count, cleared as they
// look at the room.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const steering = (roomId: string) => `/conversations/${roomId}/steering`;
const viewOf = async (as: Caller, roomId: string) => {
    const response = await as(steering(roomId));
    expect(response.status).toBe(200);
    return (await response.json()) as SteeringView;
};
const queueAs = async (as: Caller, roomId: string, text: string) => {
    const response = await as(steering(roomId), 'POST', { text });
    expect(response.status).toBe(201);
    return ((await response.json()) as { message: QueuedMessage }).message;
};

it('gives each member their own queue; a room admin sees and cancels others’ messages, never edits them, audited', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId, privateId } = await matrixChats(f);
    // A queued message would start a turn: not here.
    vi.spyOn(f.platform.steering, 'consider').mockResolvedValue(false);
    const ada = f.as('ada'); // the room's admin
    const mo = f.as('mo'); // a member

    const adas = await queueAs(ada, roomId, 'Ada here');
    const mos = await queueAs(mo, roomId, 'Mo here');

    // Each reads only their own; only the admin gets the others', by name.
    const moView = await viewOf(mo, roomId);
    expect(moView.messages.map((message) => message.text)).toEqual(['Mo here']);
    expect(moView.others).toBeUndefined();
    const adaView = await viewOf(ada, roomId);
    expect(adaView.messages.map((message) => message.text)).toEqual(['Ada here']);
    expect(adaView.others).toEqual([
        {
            id: mos.id,
            text: 'Mo here',
            files: 0,
            author: { name: 'Mo' },
            createdAt: mos.createdAt,
            updatedAt: mos.updatedAt,
        },
    ]);

    // A member can't touch anyone else's: it reads as gone, and stays.
    expect((await mo(`${steering(roomId)}/${adas.id}`, 'PATCH', { text: 'Mine' })).status).toBe(409);
    expect((await mo(`${steering(roomId)}/${adas.id}`, 'DELETE')).status).toBe(409);
    expect((await viewOf(ada, roomId)).messages.map((message) => message.text)).toEqual(['Ada here']);

    // Nor can the admin rewrite Mo's text.
    expect((await ada(`${steering(roomId)}/${mos.id}`, 'PATCH', { text: 'Rewritten' })).status).toBe(409);
    // Mo edits their own.
    const edited = await mo(`${steering(roomId)}/${mos.id}`, 'PATCH', {
        text: 'Mo, edited',
    });
    expect(edited.status).toBe(200);
    expect((await viewOf(ada, roomId)).others?.[0]?.text).toBe('Mo, edited');

    // The admin cancels it: gone from Mo's queue, and the audit says who
    // canceled whose, never what it said.
    const cancelled = await ada(`${steering(roomId)}/${mos.id}`, 'DELETE');
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as SteeringView).others).toEqual([]);
    expect((await viewOf(mo, roomId)).messages).toEqual([]);
    const events = (await (await ada(`/rooms/${roomId}/events`)).json()) as {
        action: string;
        actor: string;
        targetId: string | null;
        detail: string;
    }[];
    const line = events.find((event) => event.action === 'queue_cancel');
    expect(line).toMatchObject({
        actor: 'ada',
        targetKind: 'person',
        targetId: 'mo',
        detail: '',
    });
    expect(JSON.stringify(events)).not.toContain('Mo, edited');
    // Canceling it again finds it gone.
    expect((await ada(`${steering(roomId)}/${mos.id}`, 'DELETE')).status).toBe(409);

    // A private chat's queue is as before: its owner's, no `others`.
    await queueAs(f.as('olive'), privateId, 'Olive alone');
    const own = await viewOf(f.as('olive'), privateId);
    expect(own.messages.map((message) => message.text)).toEqual(['Olive alone']);
    expect(own.others).toBeUndefined();
});

it('refuses an edit or a cancel once a turn claimed the message, and holds a removed member’s message for an admin to cancel', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    vi.spyOn(f.platform.steering, 'consider').mockResolvedValue(false);
    const ada = f.as('ada');
    const mo = f.as('mo');
    const queue = steeringQueue(f.workspace.db);

    // A turn claims Mo's message (one statement): edits and cancels after
    // it, Mo's or the admin's, find it gone.
    const claimed = await queueAs(mo, roomId, 'Claimed');
    expect((await queue.take(roomId, 'mo')).map((message) => message.id)).toEqual([claimed.id]);
    const late = await mo(`${steering(roomId)}/${claimed.id}`, 'PATCH', {
        text: 'Too late',
    });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ code: 'delivered' });
    expect((await mo(`${steering(roomId)}/${claimed.id}`, 'DELETE')).status).toBe(409);
    expect((await ada(`${steering(roomId)}/${claimed.id}`, 'DELETE')).status).toBe(409);

    // Mo is removed with a message waiting: it never goes, and isn't lost.
    const waiting = await queueAs(mo, roomId, 'Still waiting');
    expect((await ada(`/rooms/${roomId}/members/mo`, 'DELETE')).status).toBe(200);
    expect(await f.platform.cycles.mayDispatch(roomId, 'mo')).toBe(false);
    expect(await queue.list(roomId, 'mo')).toHaveLength(1);
    expect((await viewOf(ada, roomId)).others).toEqual([
        expect.objectContaining({
            id: waiting.id,
            author: { name: 'Mo' },
            held: true,
        }),
    ]);
    // Mo can't read the room's queue any more.
    expect((await mo(steering(roomId))).status).toBe(404);
    // The admin cancels it.
    expect((await ada(`${steering(roomId)}/${waiting.id}`, 'DELETE')).status).toBe(200);
    expect(await queue.list(roomId, 'mo')).toEqual([]);

    // In an archived room nothing is canceled for someone else: the admin
    // no longer gets the others' messages, and the cancel is refused.
    const stuck = await queue.add(roomId, 'mo', 'From before the archive');
    expect((await ada(`/conversations/${roomId}`, 'PATCH', { archived: true })).status).toBe(200);
    expect((await viewOf(ada, roomId)).others).toBeUndefined();
    expect((await ada(`${steering(roomId)}/${stuck.id}`, 'DELETE')).status).toBe(409);
    expect(await queue.list(roomId, 'mo')).toHaveLength(1);
});

it('stops the running answer and keeps the other members’ queued messages queued', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    const { runner } = f.platform;
    // Ada's turn runs until it is stopped.
    const agent = new ScriptAgent('Working on it', true);
    const running = runAs(runner, f.company.id, roomId, 'run-ada', 'ada', agent);
    await vi.waitFor(() => expect(runner.activeRunId(roomId)).toBeTruthy());
    await queueAs(f.as('mo'), roomId, 'Then mine');

    // Stop (the room admin's, or Ada's own): her turn ends, Mo's message
    // waits for its own turn, as Mo's.
    await runner.stop({ threadId: roomId });
    await running;
    await vi.waitFor(() => expect(runner.activeRunId(roomId)).toBeFalsy());
    const view = await viewOf(f.as('mo'), roomId);
    expect(view.messages.map((message) => message.text)).toEqual(['Then mine']);
    expect(await f.platform.cycles.mayDispatch(roomId, 'mo')).toBe(true);
});

/** A signed-in request to the app with headers (an ETag), as `userId`. */
async function client(f: Awaited<ReturnType<typeof roomsFixture>>, userId: string) {
    const login = await f.app.request('/api/auth/mock/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    return (path: string, headers: Record<string, string> = {}) =>
        f.app.request(`/api${path}`, { headers: { cookie, ...headers } });
}

it('counts each member’s unread turns by others since they joined, clears them as they read, on every device, and moves the shell’s version', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId, privateId } = await matrixChats(f);
    const { runner } = f.platform;
    const turn = (runId: string, person: string, failure?: BaseEvent) =>
        runAs(runner, f.company.id, roomId, runId, person, new ScriptAgent('Answer', false, failure));
    const unread = async (person: string) => {
        const view = (await (await f.as(person)('/workspace')).json()) as {
            conversations: Conversation[];
        };
        return view.conversations.find((chat) => chat.id === roomId)?.unread;
    };

    await turn('run-1', 'mo');
    await turn('run-2', 'ada');
    // Each other's turn, never their own.
    expect(await unread('ada')).toBe(1);
    expect(await unread('mo')).toBe(1);
    await turn('run-3', 'mo');
    expect(await unread('ada')).toBe(2);
    expect(await unread('mo')).toBe(1);
    // A turn that failed shows nothing to the room: not new to anyone.
    await turn('run-4', 'mo', {
        type: EventType.RUN_ERROR,
        message: 'No model',
    } as BaseEvent);
    expect(await unread('ada')).toBe(2);

    // Nina joins afterwards: the history is hers to read, nothing in it new.
    await f.as('ada')(`/rooms/${roomId}/invites`, 'POST', { userId: 'nina' });
    await f.as('nina')(`/rooms/${roomId}/accept`, 'POST', {
        disclosureVersion: ROOM_DISCLOSURE_VERSION,
    });
    expect(await unread('nina')).toBeUndefined();

    // The shell's version (ETag) holds Ada's count.
    const adaApp = await client(f, 'ada');
    const first = await adaApp('/workspace');
    const tag = first.headers.get('etag')!;
    expect(tag).toBeTruthy();
    expect((await adaApp('/workspace', { 'If-None-Match': tag })).status).toBe(304);

    // Ada reads the room: her count clears, Mo's doesn't.
    const last = runner.lastFinished(roomId);
    const read = await f.as('ada')(`/rooms/${roomId}/read`, 'POST', {});
    expect(read.status).toBe(200);
    expect((await read.json()) as RoomReadState).toEqual({
        lastSeq: last,
        unread: 0,
    });
    expect(await unread('ada')).toBeUndefined();
    expect(await unread('mo')).toBe(1);
    const afterRead = await adaApp('/workspace', { 'If-None-Match': tag });
    expect(afterRead.status).toBe(200);
    const tag2 = afterRead.headers.get('etag')!;

    // Another device of hers, behind: the cursor never moves back.
    const behind = await f.as('ada')(`/rooms/${roomId}/read`, 'POST', {
        seq: 1,
    });
    expect(((await behind.json()) as RoomReadState).lastSeq).toBe(last);
    expect((await adaApp('/workspace', { 'If-None-Match': tag2 })).status).toBe(304);
    // Nor past the room's last finished turn.
    const ahead = await f.as('mo')(`/rooms/${roomId}/read`, 'POST', {
        seq: last + 1000,
    });
    expect((await ahead.json()) as RoomReadState).toEqual({
        lastSeq: last,
        unread: 0,
    });

    // Mo's next turn: new to Ada again, her version moves at her next poll.
    await turn('run-5', 'mo');
    const moved = await adaApp('/workspace', { 'If-None-Match': tag2 });
    expect(moved.status).toBe(200);
    expect(
        ((await moved.json()) as { conversations: Conversation[] }).conversations.find((chat) => chat.id === roomId)
            ?.unread,
    ).toBe(1);

    // Only the room's active members have a cursor there.
    for (const person of ['rex', 'ivy', 'alice', 'olive']) {
        expect((await f.as(person)(`/rooms/${roomId}/read`, 'POST', {})).status, person).toBe(404);
    }
    expect((await f.as('olive')(`/rooms/${privateId}/read`, 'POST', {})).status).toBe(404);
    expect((await f.as('ada')(`/rooms/${roomId}/read`, 'POST', { seq: -1 })).status).toBe(400);

    // An archived room is still read, and marked read, by its members.
    expect(
        (
            await f.as('ada')(`/conversations/${roomId}`, 'PATCH', {
                archived: true,
            })
        ).status,
    ).toBe(200);
    expect((await f.as('mo')(`/rooms/${roomId}/read`, 'POST', {})).status).toBe(200);
});

it('caps the count it shows', () => {
    expect(unreadLabel(3)).toBe('3');
    expect(unreadLabel(ROOM_UNREAD_CAP - 1)).toBe('99');
    expect(unreadLabel(ROOM_UNREAD_CAP)).toBe('99+');
});

it('counts a long run’s report as unread for every member, the job’s starter included; their own turns still not', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    const { runner } = f.platform;
    const unread = async (person: string) => {
        const view = (await (await f.as(person)('/workspace')).json()) as {
            conversations: Conversation[];
        };
        return view.conversations.find((chat) => chat.id === roomId)?.unread;
    };
    // Mo's own turn: new to Ada, not to Mo.
    await runAs(runner, f.company.id, roomId, 'run-mo', 'mo', new ScriptAgent('Started.'));
    expect(await unread('mo')).toBeUndefined();
    expect(await unread('ada')).toBe(1);

    // The report of Mo's job arrives later, as Mo's turn (CB-209) marked as
    // news (`turnOutcome`'s `news`): new to everyone, Mo included.
    const agent = new ScriptAgent('Your job is done.');
    agent.agentId = f.company.id;
    agent.threadId = roomId;
    const note = {
        id: 'socio:approval_decided:report',
        role: 'user' as const,
        content: 'The job finished.',
    };
    agent.setMessages([note]);
    await lastValueFrom(
        runner.run({
            threadId: roomId,
            agent,
            input: {
                threadId: roomId,
                runId: 'run-report',
                messages: [note],
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
            },
            signals: { trigger: { kind: 'person', id: 'mo' }, news: true },
        }),
        { defaultValue: undefined },
    );
    expect(await unread('mo')).toBe(1);
    expect(await unread('ada')).toBe(2);
    // Read, it clears like any other.
    await f.as('mo')(`/rooms/${roomId}/read`, 'POST', {});
    expect(await unread('mo')).toBeUndefined();

    // The report itself asks for that: news, as the job's starter.
    // A socio's turn, as the graph's steps reach it: `AppTurns`.
    const turns = vi.spyOn(appTurns(f), 'turnOutcome').mockResolvedValue({ text: '' } as TurnOutcome);
    vi.spyOn(f.platform.approvals, 'recordNote').mockResolvedValue(undefined);
    vi.spyOn(f.platform.longRuns, 'reported').mockResolvedValue(undefined as never);
    vi.spyOn(f.platform.longRuns, 'view').mockRejectedValue(new Error('none'));
    vi.spyOn(f.platform.jobs, 'job').mockRejectedValue(new Error('none'));
    await f.platform.longRunReports.report({
        id: 'long-mo',
        userId: 'mo',
        dotId: f.company.id,
        threadId: roomId,
        jobId: 'job',
        status: 'done',
        outcome: 'Done.',
    } as unknown as Parameters<typeof f.platform.longRunReports.report>[0]);
    expect(turns.mock.calls[0]?.[3]).toMatchObject({
        trigger: { kind: 'person', id: 'mo' },
        news: true,
    });
});
