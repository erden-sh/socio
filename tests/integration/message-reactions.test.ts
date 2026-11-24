import type { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import { endpointOf } from '@socio/foundation/inference/endpoints';
import { teamOwner } from '@socio/foundation/telegram/team-owner';
import { REACTIONS, type MessageReactions, type ReactionsView } from '@socio/shared/chat/reactions';
import { notesForWrite } from '@socio/shared/live/change-notes';
import type { TraceEntry } from '@socio/shared/runs/run-trace';
import { SENDER_METADATA } from '@socio/shared/types';

import { DEFAULT_MOCK_USERS } from '../../src/server/auth/config.js';
import { MockAuthProvider } from '../../src/server/auth/mock.js';
import { messageReactions, reactionNews } from '../../src/server/context/reactions.js';
import { TraceRecorder, traceEntry } from '../../src/server/turns/turn-trace.js';
import { WorkspaceStore } from '../helpers/stores.js';
import { testDatabase } from '../helpers/test-database.js';
import type { TestPlatform } from '../helpers/test-platform.js';
import { makeTestRuntime } from '../helpers/test-runtime.js';

// CB-133: reactions on a Dot's messages. Added and removed per person,
// readable only by those who may read the conversation, shared between
// devices, told to the Dot once on its next turn, and kept in the trace.
const SECRET = 'reactions-secret-0123456789abcdef';
const REPLY_AT = Date.UTC(2026, 9, 21, 14, 2, 30);
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** One finished turn: the person asked, the Dot answered with `a1`. */
const turn = (threadId: string, runId: string, sender?: string) => {
    let at = REPLY_AT - 5_000;
    const stamp = <T extends object>(event: T) => ({
        ...event,
        timestamp: (at += 1_000),
    });
    return [
        stamp({
            type: 'RUN_STARTED',
            threadId,
            runId,
            input: {
                threadId,
                runId,
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
                messages: [
                    {
                        id: `u-${runId}`,
                        role: 'user',
                        content: 'What is on the agenda?',
                        ...(sender ? { metadata: { [SENDER_METADATA]: sender } } : {}),
                    },
                ],
            },
        }),
        stamp({ type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' }),
        stamp({
            type: 'TEXT_MESSAGE_CONTENT',
            messageId: 'a1',
            delta: 'The offsite agenda: talks, then lunch.',
        }),
        stamp({ type: 'TEXT_MESSAGE_END', messageId: 'a1' }),
        stamp({ type: 'RUN_FINISHED', threadId, runId }),
    ];
};

async function fixture() {
    const config = { mode: 'live' as const, baseUrl: 'https://model.invalid/v1' };
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            baseUrl: config.baseUrl,
            apiKey: 'unused',
            model: 'qwen-test',
            runtimeUrl: '',
        },
        app: {
            config,
            auth: {
                provider: new MockAuthProvider(
                    [...DEFAULT_MOCK_USERS, { id: 'carol', name: 'Carol', role: 'member' }],
                    SECRET,
                ),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    const signIn = async (userId: string) => {
        const response = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        return response.headers.get('set-cookie')!.split(';')[0];
    };
    const as =
        (cookie: string) =>
        (path: string, method = 'GET', headers: Record<string, string> = {}) =>
            app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                    ...headers,
                },
            });
    const dot = workspace.dots()[0];
    const db = (platform.runner as unknown as { db: DatabaseSync }).db;
    const insert = (threadId: string, runId: string, sender?: string) =>
        db
            .prepare(
                "INSERT INTO agent_runs(threadId, runId, status, events, startedAt, finishedAt) VALUES (?, ?, 'finished', ?, 1, 2)",
            )
            .run(threadId, runId, JSON.stringify(turn(threadId, runId, sender)));
    // alice's own chat, and a Telegram team topic that alice and bob are in.
    workspace.bindThread('solo', dot.id, 'Plans', 'alice');
    insert('solo', 'r1');
    workspace.bindThread('topic', dot.id, 'Team plans', teamOwner('chat-1'));
    await workspace.telegram.bindThread('tg:chat-1:topic:7', 'topic', 'topic', 'chat-1', '7');
    await workspace.telegram.recordMember('chat-1', 'alice');
    await workspace.telegram.recordMember('chat-1', 'bob');
    insert('topic', 'r2', 'bob');
    return {
        alice: as(await signIn('alice')),
        bob: as(await signIn('bob')),
        carol: as(await signIn('carol')),
        workspace,
        platform,
        dot,
        store: messageReactions(workspace.db),
    };
}
type Caller = Awaited<ReturnType<typeof fixture>>['alice'];

const react = (who: Caller, thread: string, kind: string, message = 'a1') =>
    who(`/conversations/${thread}/messages/${message}/reactions/${kind}`, 'PUT');
const unreact = (who: Caller, thread: string, kind: string, message = 'a1') =>
    who(`/conversations/${thread}/messages/${message}/reactions/${kind}`, 'DELETE');
const view = async (response: Response) => {
    expect(response.status).toBe(200);
    return (await response.json()) as ReactionsView;
};
const mine = async (who: Caller, thread: string): Promise<MessageReactions> =>
    (await view(await who(`/conversations/${thread}/reactions`))).messages.a1 ?? {
        counts: {},
        mine: [],
    };

it('adds and removes a reaction, and a thumbs up and a thumbs down exclude each other', async () => {
    const f = await fixture();
    expect(await mine(f.alice, 'solo')).toEqual({ counts: {}, mine: [] });
    expect((await view(await react(f.alice, 'solo', 'up'))).messages.a1).toEqual({
        counts: { up: 1 },
        mine: ['up'],
    });
    // Again is the same reaction, once.
    await react(f.alice, 'solo', 'up');
    expect(await mine(f.alice, 'solo')).toEqual({
        counts: { up: 1 },
        mine: ['up'],
    });
    // The thumbs down takes the thumbs up's place; the others stand beside it.
    await react(f.alice, 'solo', 'down');
    await react(f.alice, 'solo', 'needs-work');
    await react(f.alice, 'solo', 'retry');
    expect(await mine(f.alice, 'solo')).toEqual({
        counts: { down: 1, 'needs-work': 1, retry: 1 },
        mine: ['down', 'needs-work', 'retry'],
    });
    for (const kind of REACTIONS) {
        await unreact(f.alice, 'solo', kind);
    }
    expect(await mine(f.alice, 'solo')).toEqual({ counts: {}, mine: [] });
    // Taking back what was never given is fine.
    expect((await unreact(f.alice, 'solo', 'up')).status).toBe(200);
});

it('reacts only with a known reaction, to a stored reply from the Dot', async () => {
    const f = await fixture();
    expect((await react(f.alice, 'solo', 'love')).status).toBe(400);
    expect((await react(f.alice, 'solo', 'up', 'missing')).status).toBe(404);
    // The person's own message is not the Dot's.
    expect((await react(f.alice, 'solo', 'up', 'u-r1')).status).toBe(404);
    expect((await react(f.alice, 'solo', 'up', 'a b')).status).toBe(404);
    expect((await react(f.alice, 'nowhere', 'up')).status).toBe(404);
    expect(f.store.view('solo', 'alice')).toEqual({});
});

it('lets only those who can read the conversation react in it', async () => {
    const f = await fixture();
    // bob can't see alice's chat: not found, and nothing is stored.
    for (const response of [
        await f.bob('/conversations/solo/reactions'),
        await react(f.bob, 'solo', 'up'),
        await unreact(f.bob, 'solo', 'up'),
    ]) {
        expect(response.status).toBe(404);
    }
    expect(f.store.view('solo', 'bob')).toEqual({});
    // Nor the team topic's non-member.
    expect((await f.carol('/conversations/topic/reactions')).status).toBe(404);
    expect((await react(f.carol, 'topic', 'up')).status).toBe(404);
    // Its members can, and see each other's in the counts.
    await react(f.alice, 'topic', 'up');
    const seen = await view(await react(f.bob, 'topic', 'up'));
    expect(seen).toEqual({
        shared: true,
        messages: { a1: { counts: { up: 2 }, mine: ['up'] } },
    });
    expect((await mine(f.alice, 'topic')).mine).toEqual(['up']);
    // A chat of your own is not shared; a deleted one is gone.
    expect((await view(await f.alice('/conversations/solo/reactions'))).shared).toBe(false);
    await f.platform.deleteConversation('solo', 'alice');
    expect((await f.alice('/conversations/solo/reactions')).status).toBe(404);
    expect((await react(f.alice, 'solo', 'up')).status).toBe(404);
});

it('shows a change to another device and tab: a new answer, then a 304 until the next change', async () => {
    const f = await fixture();
    const first = await f.alice('/conversations/solo/reactions');
    const tag = first.headers.get('ETag')!;
    expect(tag).toBeTruthy();
    const same = await f.alice('/conversations/solo/reactions', 'GET', {
        'If-None-Match': tag,
    });
    expect(same.status).toBe(304);
    // Another device of alice reacts: the next poll answers in full.
    await react(f.alice, 'solo', 'retry');
    const changed = await f.alice('/conversations/solo/reactions', 'GET', {
        'If-None-Match': tag,
    });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as ReactionsView).messages.a1.mine).toEqual(['retry']);
    // The tab's change channel tells the others of the conversation, by id only.
    expect(notesForWrite('/conversations/solo/messages/a1/reactions/retry')).toEqual([
        { topic: 'conversation', id: 'solo' },
    ]);
});

it('tells the Dot of reactions since its last turn, once, in a compact note', async () => {
    const f = await fixture();
    const sent: TraceEntry[] = [];
    const turn = {
        threadId: 'topic',
        userId: 'alice',
        trace: (e: TraceEntry) => sent.push(e),
    };
    const news = (at: number) =>
        reactionNews(f.store, turn, (id) => f.workspace.users().find((u) => u.id === id)?.name, at);
    expect(news(10)).toBe('');
    await react(f.alice, 'topic', 'down');
    await react(f.bob, 'topic', 'needs-work');
    await react(f.bob, 'topic', 'retry');
    await unreact(f.bob, 'topic', 'retry');
    const note = news(Date.now() + 1_000);
    // The reaction, the message (by its words and time), and who when it
    // wasn't the person the turn is for; the one taken back is not there.
    expect(note).toContain('"reaction":"👎 down"');
    expect(note).toContain('"reaction":"🛠 needs-work"');
    expect(note).toContain('"message":"The offsite agenda: talks, then lunch."');
    expect(note).toContain('"at":"2026-10-21T14:02Z"');
    expect(note).toContain('"by":"Bob"');
    expect(note).not.toContain('🔁');
    expect(note).not.toContain('"by":"Alice"');
    expect(sent).toEqual([
        {
            kind: 'reactions',
            at: expect.any(Number),
            counts: { down: 1, 'needs-work': 1 },
        },
    ]);
    // Told once: the next turn hears nothing, until there is something new.
    expect(news(Date.now() + 2_000)).toBe('');
    expect(sent).toHaveLength(1);
    await react(f.alice, 'topic', 'up');
    const later = news(Date.now() + 3_000);
    expect(later).toContain('👍 up');
    expect(later).not.toContain('🛠');
    expect(sent[1]).toMatchObject({ counts: { up: 1 } });
    // Another chat's turn is not told of this one's.
    expect(reactionNews(f.store, { threadId: 'solo', userId: 'alice' }, () => undefined)).toBe('');
});

it('the module gives the note to the turn, not to the system prompt’s news', async () => {
    const f = await fixture();
    await react(f.alice, 'solo', 'down');
    const turn = {
        dot: f.dot,
        userId: 'alice',
        threadId: 'solo',
    } as Parameters<NonNullable<TestPlatform['dotExtensions']['turnNote']>>[0];
    const { news, turnNote } = f.platform.dotExtensions;
    expect(await news!(turn)).not.toContain('👎');
    expect(await turnNote!(turn)).toContain('👎 down');
    expect(await turnNote!(turn)).not.toContain('👎');
});

it('keeps the told reactions in the turn’s trace, as counts', () => {
    const entry = {
        kind: 'reactions',
        at: 5,
        counts: { down: 2, up: 0, bogus: 3 },
    };
    expect(traceEntry(entry)).toEqual({
        kind: 'reactions',
        at: 5,
        counts: { down: 2 },
    });
    expect(traceEntry({ ...entry, counts: {} })).toBeUndefined();
    expect(traceEntry({ ...entry, counts: 'x' })).toBeUndefined();
    const recorder = new TraceRecorder();
    recorder.add(entry);
    expect(recorder.trace.reactions).toEqual({
        kind: 'reactions',
        at: 5,
        counts: { down: 2 },
    });
    expect(recorder.finish('finished').reactions?.counts).toEqual({ down: 2 });
});

it('rejects a reaction kind the table does not know, NULL included', async () => {
    const f = await fixture();
    const insert = (kind: string | null) =>
        f.workspace.db
            .prepare(
                "INSERT INTO message_reactions (threadId, messageId, userId, kind, createdAt) VALUES ('t', 'm', 'u', ?, 1)",
            )
            .run(kind);
    expect(() => insert('love')).toThrow(/CHECK|constraint/i);
    expect(() => insert(null)).toThrow(/NOT NULL|CHECK|constraint/i);
    expect(() => insert('up')).not.toThrow();
    expect(() => insert('up')).toThrow(/UNIQUE|constraint/i);
});

it('gives the Learning analysis the reactions to a reply as evidence', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const dot = workspace.dots()[0];
    workspace.updateDot(dot.id, { ...dot, learningContainerId: 'research' });
    workspace.bindThread('t1', dot.id, 't1', 'alice');
    const store = messageReactions(workspace.db);
    const said = { text: 'Here is the summary.' };
    store.add('t1', 'a1', 'alice', 'down', said);
    store.add('t1', 'a1', 'bob', 'down', said);
    store.add('t1', 'a1', 'alice', 'retry', said);
    const requests: Array<{ messages: Array<{ content: string }> }> = [];
    const analysis = workspace.openAnalysis(
        {
            messages: async () => [
                { id: 'u1', role: 'user', content: 'Summarise the week' },
                { id: 'a1', role: 'assistant', content: 'Here is the summary.' },
                { id: 'a2', role: 'assistant', content: 'Anything else?' },
            ],
        },
        () => endpointOf({ baseUrl: 'http://model.test/v1', apiKey: 'k', model: 'qwen' }),
        vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            requests.push(JSON.parse(String(init?.body)));
            return Response.json({ choices: [{ message: { tool_calls: [] } }] });
        }) as typeof fetch,
        (threadId) => store.labels(threadId),
    );
    workspace.evidence.record('t1', 'finished', 1_000);
    await (
        await analysis.analyze('research', 'manual')
    ).done;
    const sent = requests[0].messages[1].content;
    expect(sent).toContain('assistant: Here is the summary.\n[reactions: 👎 down x2, 🔁 retry]');
    // Replies nobody reacted to carry no line.
    expect(sent).toContain('assistant: Anything else?\n');
    expect(sent.match(/\[reactions:/g)).toHaveLength(1);
});
