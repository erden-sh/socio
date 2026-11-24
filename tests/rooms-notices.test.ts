import { EventType, type AbstractAgent, type BaseEvent, type Message } from '@ag-ui/client';
import { lastValueFrom } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import type { QueuedMessage } from '@socio/shared/chat/steering';
import type { RoomNotifySetting, RoomPresenceView, TranscriptMention } from '@socio/shared/rooms/room-notices';
import { ROOM_DISCLOSURE_VERSION } from '@socio/shared/rooms/rooms';
import { SENDER_METADATA, type Conversation } from '@socio/shared/types';

import type { RenderedNotification } from '../src/server/notifications/contract.js';
import { TAB_FRESH_MS } from '../src/server/notifications/presence.js';
import type { RunFinishedListener } from '../src/server/turns/contract.js';
import type { LocalAgentRunner } from '../src/server/turns/local-runner.js';

import { matrixChats, roomsFixture, ToolAgent, type Caller } from './fixtures/rooms.js';
import { ScriptAgent } from './fixtures/script-agent.js';

// CB-216: mentions of people, each member's notices (mentions, their own turns
// and reports finishing, invitations, others' turns at "everything"), per-room
// levels and the room's presence.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

type Fixture = Awaited<ReturnType<typeof roomsFixture>>;
interface Sent {
    userId: string;
    title: string;
    body: string;
    path: string;
}

/**
 * A channel that reaches everyone, on for the room's people: what it was
 * asked to send, by person.
 */
function channel(f: Fixture) {
    const sent: Sent[] = [];
    f.platform.notifications.register({
        id: 'fake',
        label: 'Fake',
        targets: () => [{ id: 'device', label: 'Device' }],
        send: async (userId, _target, notification: RenderedNotification) => {
            sent.push({
                userId,
                title: notification.title,
                body: notification.body,
                path: notification.path,
            });
            return { outcome: 'sent' };
        },
    });
    for (const person of ['alice', 'olive', 'ada', 'mo', 'rex', 'ivy', 'nina']) {
        f.workspace.setPreferences(person, {
            notifications: { fake: { enabled: true, content: 'message' } },
        });
    }
    return sent;
}

const queue = async (as: Caller, roomId: string, text: string, mentions?: { userId: string; label: string }[]) => {
    const response = await as(`/conversations/${roomId}/steering`, 'POST', {
        text,
        ...(mentions ? { mentions } : {}),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { message: QueuedMessage }).message;
};

/**
 * A turn that took `message` (queued by `person`), as the steering queue
 * starts it: the message keeps its id, and the turn is the person's.
 */
const turnWith = async (
    runner: LocalAgentRunner,
    dotId: string,
    roomId: string,
    runId: string,
    person: string,
    message: Pick<QueuedMessage, 'id' | 'text'>,
    agent: AbstractAgent = new ScriptAgent('Here is the plan.'),
    extra: { news?: true } = {},
) => {
    const messages: Message[] = [
        {
            id: message.id,
            role: 'user',
            content: message.text,
            metadata: { [SENDER_METADATA]: person },
        } as Message,
    ];
    agent.agentId = dotId;
    agent.threadId = roomId;
    agent.setMessages(messages);
    await lastValueFrom(
        runner.run({
            threadId: roomId,
            agent,
            input: {
                threadId: roomId,
                runId,
                messages,
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
            },
            signals: { trigger: { kind: 'person', id: person }, ...extra },
        }),
        { defaultValue: undefined },
    ).catch(() => undefined);
};

/**
 * Notifications recorded for the person (sent, shown or held back), but
 * the invitations the room's setup sent.
 */
const recorded = (f: Fixture, userId: string) =>
    f.workspace.db
        .prepare(
            "SELECT trigger, title, message, link, presence FROM notifications WHERE userId=? AND trigger != 'room_invite' ORDER BY createdAt, rowid",
        )
        .all(userId)
        .map((row) => ({ ...row }));

it('tells only the members a message really mentions, once, with the room’s own words', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    vi.spyOn(f.platform.steering, 'consider').mockResolvedValue(false);
    const sent = channel(f);
    // Nina joins; Rex was removed, Ivy only invited, Olive never in it.
    await f.as('ada')(`/rooms/${roomId}/invites`, 'POST', { userId: 'nina' });
    await f.as('nina')(`/rooms/${roomId}/accept`, 'POST', {
        disclosureVersion: ROOM_DISCLOSURE_VERSION,
    });
    // Nina's invitation told her; from here, the turn's notices.
    sent.length = 0;
    const finished: Parameters<RunFinishedListener>[] = [];
    f.platform.runner.onRunFinished((...args) => finished.push(args));
    const text = '@Mo can you check this? @Rex @Ivy @Olive @Ada and @Nina';
    const message = await queue(f.as('ada'), roomId, text, [
        { userId: 'mo', label: 'Mo' },
        // Not members, the author herself: never kept, never told.
        { userId: 'rex', label: 'Rex' },
        { userId: 'ivy', label: 'Ivy' },
        { userId: 'olive', label: 'Olive' },
        { userId: 'ada', label: 'Ada' },
        // A pick naming someone else than the person: nobody.
        { userId: 'nina', label: 'Mo' },
    ]);
    expect(
        f.workspace.db
            .prepare('SELECT userId, status FROM room_mentions')
            .all()
            .map((row) => ({ ...row })),
    ).toEqual([{ userId: 'mo', status: 'pending' }]);

    await turnWith(f.platform.runner, f.company.id, roomId, 'run-1', 'ada', message);
    await vi.waitFor(() => expect(sent.map((notice) => notice.userId).sort()).toEqual(['ada', 'mo']));
    const toMo = sent.find((notice) => notice.userId === 'mo')!;
    expect(toMo).toMatchObject({
        title: 'Launch: Ada mentioned you',
        body: text,
        path: `/chats/${roomId}`,
    });
    // Ada's own turn finished while she was away: the reply.
    expect(sent.find((notice) => notice.userId === 'ada')).toMatchObject({
        title: `Launch: ${f.company.name} answered you`,
        body: 'Here is the plan.',
    });
    // Nina's name was typed, never picked: nothing for her.
    expect(recorded(f, 'nina')).toEqual([]);
    for (const person of ['rex', 'ivy', 'olive']) {
        expect(recorded(f, person), person).toEqual([]);
    }

    // The transcript marks the mention for Mo, by name, for others too.
    const transcript = async (person: string) =>
        (
            (await (await f.as(person)(`/conversations/${roomId}/transcript`)).json()) as {
                messages: { id: string; mentions?: TranscriptMention[] }[];
            }
        ).messages.find((item) => item.id === message.id)?.mentions;
    expect(await transcript('mo')).toEqual([{ name: 'Mo', you: true }]);
    expect(await transcript('nina')).toEqual([{ name: 'Mo', you: false }]);

    // A replay (the same run's end again, the tick's sweep) sends nothing more.
    const before = sent.length;
    expect(finished).toHaveLength(1);
    await f.platform.roomNotices.runFinished(...finished[0]!);
    await f.platform.roomNotices.sweep();
    expect(sent).toHaveLength(before);
    expect(
        f.workspace.db
            .prepare("SELECT cause FROM room_notices WHERE cause NOT LIKE 'invite:%' ORDER BY cause")
            .all()
            .map((row) => String(row.cause).split(':')[0]),
    ).toEqual(['mention', 'turn']);
});

it('gives each room message’s mentions in its history, as the transcript does, on a cold load, after and before (CB-416)', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId, privateId } = await matrixChats(f);
    vi.spyOn(f.platform.steering, 'consider').mockResolvedValue(false);
    // Three turns: one mentioning Mo, one mentioning nobody, one mentioning Mo again.
    const first = await queue(f.as('ada'), roomId, '@Mo can you check this?', [{ userId: 'mo', label: 'Mo' }]);
    await turnWith(f.platform.runner, f.company.id, roomId, 'run-1', 'ada', first);
    const plain = await queue(f.as('ada'), roomId, 'Nobody in particular');
    await turnWith(f.platform.runner, f.company.id, roomId, 'run-2', 'ada', plain);
    const third = await queue(f.as('ada'), roomId, 'And this, @Mo?', [{ userId: 'mo', label: 'Mo' }]);
    await turnWith(f.platform.runner, f.company.id, roomId, 'run-3', 'ada', third);
    await vi.waitFor(async () => expect([...(await f.platform.roomNotices.mentions(roomId)).keys()]).toHaveLength(2));

    type Page = { runs: { seq: number; messages: { id: string; mentions?: TranscriptMention[] }[] }[] };
    const history = async (person: string, query = '') => {
        const response = await f.as(person)(`/conversations/${roomId}/history${query}`);
        expect(response.status).toBe(200);
        return (await response.json()) as Page;
    };
    const mentionsIn = (page: Page) =>
        new Map(page.runs.flatMap((run) => run.messages.map((message) => [message.id, message] as const)));

    // A cold load: Mo reads "you", Ada (who wrote them) the name; the plain message has none.
    const cold = await history('mo');
    expect(cold.runs).toHaveLength(3);
    const coldById = mentionsIn(cold);
    expect(coldById.get(first.id)?.mentions).toEqual([{ name: 'Mo', you: true }]);
    expect(coldById.get(third.id)?.mentions).toEqual([{ name: 'Mo', you: true }]);
    expect(coldById.get(plain.id)).toBeDefined();
    expect(coldById.get(plain.id)).not.toHaveProperty('mentions');
    // The same as the transcript gives the web.
    const transcript = (
        (await (await f.as('ada')(`/conversations/${roomId}/transcript`)).json()) as {
            messages: { id: string; mentions?: TranscriptMention[] }[];
        }
    ).messages.find((item) => item.id === first.id)?.mentions;
    expect(mentionsIn(await history('ada')).get(first.id)?.mentions).toEqual(transcript);
    expect(transcript).toEqual([{ name: 'Mo', you: false }]);
    // Only people's messages: the socio's replies never carry any.
    for (const run of cold.runs) {
        for (const message of run.messages) {
            if (message.id !== first.id && message.id !== third.id) {
                expect(message).not.toHaveProperty('mentions');
            }
        }
    }

    const [one, two, three] = cold.runs.map((run) => run.seq);
    // After the first run: the plain one has none, the third has Mo's.
    const after = mentionsIn(await history('ada', `?after=${one}`));
    expect([...after.keys()]).not.toContain(first.id);
    expect(after.get(plain.id)).not.toHaveProperty('mentions');
    expect(after.get(third.id)?.mentions).toEqual([{ name: 'Mo', you: false }]);
    // Before the third: the first has Mo's, the plain one none.
    const before = mentionsIn(await history('mo', `?before=${three}`));
    expect([...before.keys()]).not.toContain(third.id);
    expect(before.get(first.id)?.mentions).toEqual([{ name: 'Mo', you: true }]);
    expect(before.get(plain.id)).not.toHaveProperty('mentions');
    expect(two).toBeGreaterThan(one!);

    // A private chat's history is as before: no mentions anywhere.
    await turnWith(f.platform.runner, f.company.id, privateId, 'run-private', 'olive', {
        id: 'private-message',
        text: '@Mo hello',
    });
    const own = await (await f.as('olive')(`/conversations/${privateId}/history`)).json();
    expect(JSON.stringify(own)).not.toContain('"mentions"');
});

it('drops a mention whose name left the text before it was delivered, and one cancelled', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    vi.spyOn(f.platform.steering, 'consider').mockResolvedValue(false);
    const sent = channel(f);
    const edited = await queue(f.as('ada'), roomId, '@Mo first', [{ userId: 'mo', label: 'Mo' }]);
    // Edited without the name: the pick stays recorded but is no mention.
    const patched = await f.as('ada')(`/conversations/${roomId}/steering/${edited.id}`, 'PATCH', {
        text: 'Never mind',
    });
    expect(patched.status).toBe(200);
    const cancelled = await queue(f.as('ada'), roomId, '@Mo second', [{ userId: 'mo', label: 'Mo' }]);
    expect((await f.as('ada')(`/conversations/${roomId}/steering/${cancelled.id}`, 'DELETE')).status).toBe(200);
    expect(
        f.workspace.db
            .prepare('SELECT messageId FROM room_mentions')
            .all()
            .map((row) => row.messageId),
    ).toEqual([edited.id]);
    await turnWith(f.platform.runner, f.company.id, roomId, 'run-1', 'ada', {
        id: edited.id,
        text: 'Never mind',
    });
    await vi.waitFor(() => expect(sent.map((notice) => notice.userId)).toEqual(['ada']));
    expect(recorded(f, 'mo')).toEqual([]);
    expect(f.workspace.db.prepare('SELECT COUNT(*) AS n FROM room_mentions').get()).toEqual({ n: 0 });
});

it('honours each member’s level, holds back for whoever is looking, and tells nobody once they are out', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    vi.spyOn(f.platform.steering, 'consider').mockResolvedValue(false);
    const sent = channel(f);
    const level = (person: string, value?: string) =>
        f.as(person)(`/rooms/${roomId}/notifications`, value ? 'PUT' : 'GET', value ? { level: value } : undefined);
    // The default is mentions and one's own turns.
    expect((await (await level('mo')).json()) as RoomNotifySetting).toEqual({
        level: 'mentions',
    });
    // Only members choose, and only the levels there are.
    expect((await level('olive')).status).toBe(404);
    expect((await level('rex', 'all')).status).toBe(404);
    expect((await level('mo', 'loud')).status).toBe(400);

    // Mo mutes the room: no mention reaches him, and his list says so.
    expect((await level('mo', 'mute')).status).toBe(200);
    const listed = (await (await f.as('mo')('/workspace')).json()) as {
        conversations: Conversation[];
    };
    expect(listed.conversations.find((chat) => chat.id === roomId)?.roomNotify).toBe('mute');
    const one = await queue(f.as('ada'), roomId, '@Mo one', [{ userId: 'mo', label: 'Mo' }]);
    await turnWith(f.platform.runner, f.company.id, roomId, 'run-1', 'ada', one);
    await vi.waitFor(() => expect(sent.map((notice) => notice.userId)).toEqual(['ada']));
    expect(recorded(f, 'mo')).toEqual([]);

    // At "everything" he hears of Ada's turns too, once per work cycle.
    expect((await level('mo', 'all')).status).toBe(200);
    const two = await queue(f.as('ada'), roomId, 'Plain question');
    await turnWith(f.platform.runner, f.company.id, roomId, 'run-2', 'ada', two);
    await vi.waitFor(() =>
        expect(sent.filter((notice) => notice.userId === 'mo').map((n) => n.title)).toEqual([
            `Launch: ${f.company.name} answered Ada`,
        ]),
    );

    // Ada looks at the room: her own turn's end interrupts nothing (it is
    // recorded as seen there); Mo, elsewhere in Socio, gets a toast.
    f.platform.notifications.presence.tab('ada', 'tab-ada-001', `/chats/${roomId}`);
    f.platform.notifications.presence.tab('mo', 'tab-mo-0001', '/');
    const before = sent.length;
    const three = await queue(f.as('ada'), roomId, 'Another');
    await turnWith(f.platform.runner, f.company.id, roomId, 'run-3', 'ada', three);
    await vi.waitFor(() =>
        expect(recorded(f, 'ada').at(-1)).toMatchObject({
            trigger: 'room_turn',
            presence: 'present',
        }),
    );
    await vi.waitFor(() =>
        expect(recorded(f, 'mo').at(-1)).toMatchObject({
            trigger: 'room_activity',
            presence: 'in_app',
        }),
    );
    expect(sent).toHaveLength(before);
    const notices = await f.platform.notifications.inApp('mo');
    expect(notices.at(-1)).toMatchObject({ link: `/chats/${roomId}` });
    f.platform.notifications.presence.away('ada', 'tab-ada-001');
    f.platform.notifications.presence.away('mo', 'tab-mo-0001');

    // Mo leaves: nothing more for him, mentioned or not; and a mention by
    // someone removed after writing tells nobody.
    expect((await f.as('mo')(`/rooms/${roomId}/leave`, 'POST')).status).toBe(200);
    const four = await queue(f.as('ada'), roomId, '@Mo are you there?');
    await turnWith(f.platform.runner, f.company.id, roomId, 'run-4', 'ada', four);
    await vi.waitFor(() => expect(recorded(f, 'ada').filter((row) => row.trigger === 'room_turn')).toHaveLength(4));
    expect(sent.filter((notice) => notice.userId === 'mo')).toHaveLength(1);
});

it('tells the starter when their turn fails, never shows a tool’s result, and reports a long run to its starter and to “everything”', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    vi.spyOn(f.platform.steering, 'consider').mockResolvedValue(false);
    const sent = channel(f);
    const canary = 'PRIVATE-CALENDAR-CANARY';
    const one = await queue(f.as('mo'), roomId, 'What is on my calendar?');
    await turnWith(
        f.platform.runner,
        f.company.id,
        roomId,
        'run-1',
        'mo',
        one,
        new ToolAgent({ id: 'call-1', result: canary }),
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ userId: 'mo', body: 'Done.' });
    expect(JSON.stringify(recorded(f, 'mo'))).not.toContain(canary);

    const two = await queue(f.as('mo'), roomId, 'Again');
    await turnWith(
        f.platform.runner,
        f.company.id,
        roomId,
        'run-2',
        'mo',
        two,
        new ScriptAgent('', false, {
            type: EventType.RUN_ERROR,
            message: 'No model',
        } as BaseEvent),
    );
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.title).toBe(`Launch: ${f.company.name} couldn’t finish`);

    // A long run's report (news): its starter hears, and Ada at "everything".
    await f.as('ada')(`/rooms/${roomId}/notifications`, 'PUT', { level: 'all' });
    await turnWith(
        f.platform.runner,
        f.company.id,
        roomId,
        'run-3',
        'mo',
        { id: 'note-1', text: '[Job finished.]' },
        new ScriptAgent('The import is done.'),
        { news: true },
    );
    await vi.waitFor(() => expect(sent).toHaveLength(4));
    expect(sent.slice(2).map((notice) => [notice.userId, notice.title, notice.body])).toEqual(
        expect.arrayContaining([
            ['mo', `Launch: ${f.company.name} reported on a job`, 'The import is done.'],
            ['ada', `Launch: ${f.company.name} reported on a job`, 'The import is done.'],
        ]),
    );
});

it('tells an invited person, and no one else', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    const sent = channel(f);
    expect((await f.as('ada')(`/rooms/${roomId}/invites`, 'POST', { userId: 'nina' })).status).toBe(201);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
        userId: 'nina',
        title: 'Launch: Ada invited you',
        path: '/',
    });
    // A refused invite (a member already) tells nobody.
    expect((await f.as('ada')(`/rooms/${roomId}/invites`, 'POST', { userId: 'mo' })).status).toBe(409);
    expect(sent).toHaveLength(1);
});

it('shows who else of the room is looking, to its members only, and never who hides it', async () => {
    let now = 1_000_000;
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    const presence = f.platform.notifications.presence;
    (f.platform.roomNotices as unknown as { now: () => number }).now = () => now;
    const look = (person: string, path = `/chats/${roomId}`) => presence.tab(person, `tab-${person}-0001`, path, now);
    const who = async (person: string) => {
        const response = await f.as(person)(`/rooms/${roomId}/presence`);
        return response.status === 200
            ? ((await response.json()) as RoomPresenceView).people.map((entry) => entry.name)
            : response.status;
    };
    look('ada');
    look('mo');
    // Rex was removed, Olive was never in it: even looking at its address,
    // they never show, and can't ask.
    look('rex');
    look('olive');
    expect(await who('ada')).toEqual(['Mo']);
    expect(await who('mo')).toEqual(['Ada']);
    for (const person of ['rex', 'olive', 'ivy', 'alice']) {
        expect(await who(person), person).toBe(404);
    }

    // Mo hides his presence: Ada no longer sees him; he still sees her.
    expect((await f.as('mo')('/preferences', 'PATCH', { roomPresence: 'hidden' })).status).toBe(200);
    expect(await who('ada')).toEqual([]);
    expect(await who('mo')).toEqual(['Ada']);
    await f.as('mo')('/preferences', 'PATCH', { roomPresence: 'shown' });

    // Elsewhere in Socio, a hidden tab, a stale report: gone.
    look('mo', '/');
    expect(await who('ada')).toEqual([]);
    look('mo');
    expect(await who('ada')).toEqual(['Mo']);
    presence.away('mo', 'tab-mo-0001');
    expect(await who('ada')).toEqual([]);
    look('mo');
    now += TAB_FRESH_MS + 1;
    expect(await who('ada')).toEqual([]);
});
