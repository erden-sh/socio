import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventType, type BaseEvent, type Message, type RunAgentInput } from '@ag-ui/client';
import { defineTool } from '@copilotkit/runtime/v2';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { isTurnNote, partsOf, steeringMessage, withTurnNote } from '@socio/foundation/context/turn-note';
import { DEFAULT_STEERING_MAX_QUEUED, type QueuedMessage, type SteeringView } from '@socio/shared/chat/steering';
import { MEDIA_LIMITS } from '@socio/shared/media-types';
import { pageReviewTool } from '@socio/shared/pages/page-review';
import type { User } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import { steeringMaxQueuedFromEnv, type PlatformConfig } from '../src/server/composition/config.js';
import { resetCalibration } from '../src/server/context/budget.js';
import { turnStarts } from '../src/server/context/compact.js';
import { steeringQueue } from '../src/server/context/steering.js';

import { PNG } from './fixtures/media.js';
import { completion } from './fixtures/model-stream.js';
import { DotAgent } from './helpers/dot-agent.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// The steering queue (CB-151): what the person sends while a turn runs
// reaches the turn after its tool calls, before its next model round, as
// their message; once, in order, and never lost.

const cleanup: Array<() => unknown> = [];
beforeEach(() => resetCalibration());
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'member' },
    { id: 'bob', name: 'Bob', role: 'member' },
    { id: 'carol', name: 'Carol', role: 'admin' },
];
const SECRET = 'steering-secret-0123456789abcdef';
const MODEL_URL = 'https://model.invalid/v1';
const realFetch = globalThis.fetch.bind(globalThis);

interface Request {
    tools?: unknown[];
    messages: Array<{
        role: string;
        content?: unknown;
        tool_call_id?: string;
        tool_calls?: Array<{ id: string }>;
    }>;
}

const call = (id: string, page = 1) =>
    completion(
        {
            role: 'assistant',
            tool_calls: [
                {
                    index: 0,
                    id,
                    type: 'function',
                    function: {
                        name: 'fetch_rows',
                        arguments: JSON.stringify({ page }),
                    },
                },
            ],
        },
        'tool_calls',
    );
const say = (content: string) => completion({ role: 'assistant', content });
const tooLong = () =>
    new Response(
        JSON.stringify({
            error: {
                message: "This model's maximum context length is 16384 tokens.",
                type: 'invalid_request_error',
                code: 'context_length_exceeded',
            },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
const busy = () =>
    new Response(JSON.stringify({ error: { message: 'Slow down.' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
    });

/** The text a request message carries, its parts joined. */
const textOf = (content: unknown): string =>
    typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((part: { text?: string }) => part.text ?? '').join('\n')
          : '';
const count = (body: string, text: string) => body.split(text).length - 1;

async function fixture(config: Partial<PlatformConfig> = {}) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const full: PlatformConfig = {
        baseUrl: MODEL_URL,
        apiKey: 'unused',
        model: 'custom-model',
        voiceName: 'marin',
        runtimeUrl: '',
        sessionSecret: SECRET,
        modelRetry: { baseMs: 5 },
        ...config,
    };
    const { app, store, workspace, platform, dispose } = await makeTestRuntime({
        config: full,
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(USERS, SECRET),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    const dot = workspace.dots()[0];
    const thread = workspace.bindThread('chat', dot.id, 'Chat', 'alice');
    const queue = steeringQueue(workspace.db);
    /** The Dot's model requests (not titles or notes), as sent. */
    const bodies: string[] = [];
    /** The next answers of the Dot's model; then "Done." */
    const replies: Array<() => Response | Promise<Response>> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if (!String(input).startsWith(MODEL_URL)) {
            return realFetch(input, init);
        }
        const body = String(init?.body ?? '');
        if (body.includes('Write a short title')) {
            return Response.json({ choices: [{ message: { content: 'Title' } }] });
        }
        if (body.includes('running notes')) {
            return say('PINNED:\n- Rows\nSUMMARY:\nThe Dot fetched rows.');
        }
        bodies.push(body);
        return (replies.shift() ?? (() => say('Done.')))();
    });
    /** What the tool does while it runs, call by call. */
    const during: Array<() => unknown> = [];
    const fetchRows = defineTool({
        name: 'fetch_rows',
        description: 'Fetch a page of rows.',
        parameters: z.object({ page: z.number() }),
        execute: async ({ page }: { page: number }) => {
            await during.shift()?.();
            return rows(page);
        },
    });
    let runs = 0;
    /** A web turn as Alice with `fetch_rows`; its events. */
    const turn = async (
        messages: Message[] = [{ id: 'u1', role: 'user', content: 'Fetch rows.' }],
        options: { channel?: boolean; tools?: RunAgentInput['tools'] } = {},
    ) => {
        const runId = `run-${(runs += 1)}`;
        const agent = new DotAgent(
            store,
            workspace,
            full,
            dot.id,
            !!options.channel,
            options.channel ? 'alice' : undefined,
            {
                inference: platform.inference,
                extensions: { ...platform.dotExtensions, tools: () => [fetchRows] },
            },
        );
        agent.threadId = thread.id;
        agent.setMessages(messages);
        return lastValueFrom(
            platform.runner
                .run({
                    threadId: thread.id,
                    agent,
                    input: {
                        threadId: thread.id,
                        runId,
                        messages,
                        state: {},
                        tools: options.tools ?? [],
                        context: [],
                        forwardedProps: {},
                    },
                })
                .pipe(toArray()),
        );
    };
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return async <T = unknown>(path: string, method = 'GET', body?: unknown) => {
            const response = await app.request(path, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return {
                status: response.status,
                body: (await response.json().catch(() => null)) as T,
            };
        };
    };
    const requests = () => bodies.map((body) => JSON.parse(body) as Request);
    const stored = () => platform.runner.messages(thread.id);
    /** No turn runs in the conversation, and none is about to. */
    const idle = () =>
        vi.waitFor(() => expect(platform.runner.activeRunId(thread.id)).toBeUndefined(), {
            timeout: 10_000,
            interval: 10,
        });
    return {
        store,
        workspace,
        platform,
        dot,
        thread,
        queue,
        bodies,
        replies,
        during,
        turn,
        as,
        requests,
        stored,
        idle,
    };
}

/** Characters of filler that read like a data result. */
const rows = (page: number, chars = 200) => {
    const row = `{"id":${page},"name":"row ${page}","value":${page * 7}},`;
    return `[${row.repeat(Math.ceil(chars / row.length))}`.slice(0, chars);
};

/** The person's messages the turn's events delivered (CB-151), in order. */
const delivered = (events: BaseEvent[]) =>
    events.flatMap((event) =>
        event.type === EventType.TEXT_MESSAGE_START && (event as { role?: string }).role === 'user'
            ? [(event as unknown as { messageId: string }).messageId]
            : [],
    );

it('delivers a message queued during a tool call after it, and the next round reads it', async () => {
    const f = await fixture();
    let queued!: QueuedMessage;
    f.during.push(async () => {
        queued = await f.queue.add(f.thread.id, 'alice', 'Use page 2 instead.');
    });
    f.replies.push(
        () => call('c1'),
        () => say('Switching to page 2.'),
    );
    const events = await f.turn();
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);

    // The second round reads it, last, as the person's message after the
    // call's result; the request before it is unchanged, byte for byte.
    const [first, second] = f.requests();
    expect(f.bodies).toHaveLength(2);
    expect(second.messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(second.messages[3].tool_call_id).toBe('c1');
    expect(textOf(second.messages[4].content)).toBe('Use page 2 instead.');
    expect(JSON.stringify(second.messages.slice(0, 2))).toBe(JSON.stringify(first.messages));
    // The first round never had it: it was sent while the call ran.
    expect(f.bodies[0]).not.toContain('Use page 2 instead.');

    // The chat gets it after the call's result, before the answer that
    // follows it, which is a message of its own.
    expect(delivered(events)).toEqual([queued.id]);
    const at = (predicate: (event: BaseEvent) => boolean) => events.findIndex(predicate);
    const userAt = at(
        (event) => event.type === EventType.TEXT_MESSAGE_START && (event as { role?: string }).role === 'user',
    );
    expect(userAt).toBeGreaterThan(at((event) => event.type === EventType.TOOL_CALL_RESULT));
    const answers = events.filter(
        (event) => event.type === EventType.TEXT_MESSAGE_START && (event as { role?: string }).role !== 'user',
    ) as unknown as { messageId: string }[];
    expect(events.indexOf(answers.at(-1) as unknown as BaseEvent)).toBeGreaterThan(userAt);
    const calls = events.filter((event) => event.type === EventType.TOOL_CALL_START) as unknown as {
        parentMessageId: string;
    }[];
    expect(answers.at(-1)!.messageId).not.toBe(calls[0].parentMessageId);

    // Stored as the conversation went: every call with its result, and
    // taken from the queue.
    const messages = await f.stored();
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);
    expect(messages[3]).toMatchObject({
        id: queued.id,
        content: 'Use page 2 instead.',
        metadata: { socioSender: 'alice', socioSenderName: 'Alice' },
    });
    expect(messages[1]).toMatchObject({
        toolCalls: [expect.objectContaining({ id: 'c1' })],
    });
    expect(messages[4]).toMatchObject({ content: 'Switching to page 2.' });
    expect(await f.queue.list(f.thread.id, 'alice')).toEqual([]);

    // The next turn reads it from the stored conversation, in its place.
    f.replies.push(() => say('Still on page 2.'));
    await f.turn([...messages, { id: 'u2', role: 'user', content: 'Carry on.' }]);
    const next = f.requests()[2];
    expect(next.messages.map((message) => message.role)).toEqual([
        'system',
        'user',
        'assistant',
        'tool',
        'user',
        'assistant',
        'user',
    ]);
    expect(textOf(next.messages[4].content)).toBe('Use page 2 instead.');
    // The system prompt never changed.
    const system = f.requests().map((request) => request.messages[0]);
    expect(new Set(system.map((message) => JSON.stringify(message))).size).toBe(1);
});

it('delivers several in order, once each, after edits and cancels', async () => {
    const f = await fixture();
    const sent: Record<string, QueuedMessage> = {};
    f.during.push(
        async () => {
            for (const text of ['First thing.', 'Second thing.', 'Third thing.']) {
                sent[text] = await f.queue.add(f.thread.id, 'alice', text);
            }
            // Edited and canceled while they wait.
            expect(
                await f.queue.edit(f.thread.id, 'alice', sent['Second thing.'].id, 'Second thing, edited.'),
            ).toMatchObject({ text: 'Second thing, edited.' });
            expect(await f.queue.cancel(f.thread.id, 'alice', sent['Third thing.'].id)).toBe(true);
            // Someone else's never reaches this turn.
            await f.queue.add(f.thread.id, 'bob', 'Not Alice’s.');
        },
        async () => {
            sent['Fourth thing.'] = await f.queue.add(f.thread.id, 'alice', 'Fourth thing.');
        },
    );
    f.replies.push(
        () => call('c1'),
        () => call('c2', 2),
        () => say('Done all.'),
    );
    const events = await f.turn();
    const [, second, third] = f.requests();
    // The two of round 2 as one message of the person's (CB-147), in order.
    expect(second.messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(textOf(second.messages[4].content)).toBe('First thing.\nSecond thing, edited.');
    expect(third.messages.map((message) => message.role)).toEqual([
        'system',
        'user',
        'assistant',
        'tool',
        'user',
        'assistant',
        'tool',
        'user',
    ]);
    expect(textOf(third.messages[7].content)).toBe('Fourth thing.');
    // Each once, in every round after it; the rest never.
    for (const text of ['First thing.', 'Second thing, edited.']) {
        expect(count(f.bodies[2], text)).toBe(1);
    }
    for (const body of f.bodies) {
        expect(body).not.toContain('Third thing.');
        expect(body).not.toContain('Second thing.');
        expect(body).not.toContain('Not Alice’s.');
    }
    expect(delivered(events)).toEqual([sent['First thing.'].id, sent['Second thing.'].id, sent['Fourth thing.'].id]);
    // The rounds' prompts only ever grew at their end.
    expect(JSON.stringify(third.messages.slice(0, 5))).toBe(JSON.stringify(second.messages));

    // Delivered: no longer to edit or cancel; Bob's still waits for his.
    expect(await f.queue.edit(f.thread.id, 'alice', sent['First thing.'].id, 'No.')).toBeUndefined();
    expect(await f.queue.cancel(f.thread.id, 'alice', sent['Fourth thing.'].id)).toBe(false);
    expect(await f.queue.list(f.thread.id, 'alice')).toEqual([]);
    expect((await f.queue.list(f.thread.id, 'bob')).map((message) => message.text)).toEqual(['Not Alice’s.']);
    const messages = await f.stored();
    expect(messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'user',
        'user',
        'assistant',
        'tool',
        'user',
        'assistant',
    ]);
    expect(messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual([
        'Fetch rows.',
        'First thing.',
        'Second thing, edited.',
        'Fourth thing.',
    ]);
});

it('starts the next turn with them when the turn ends first', async () => {
    const f = await fixture();
    let queued!: QueuedMessage;
    f.replies.push(
        // Sent while the model writes its answer: no round comes after it.
        async () => {
            queued = await f.queue.add(f.thread.id, 'alice', 'Also page 3, please.');
            return say('Here are the rows.');
        },
        () => say('Page 3 too.'),
    );
    await f.turn([{ id: 'u1', role: 'user', content: 'Fetch rows.' }]);
    await vi.waitFor(() => expect(f.bodies).toHaveLength(2), {
        timeout: 10_000,
        interval: 10,
    });
    await f.idle();
    const second = f.requests()[1];
    expect(second.messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(textOf(second.messages[3].content)).toContain('Also page 3, please.');
    const messages = await f.stored();
    expect(messages.map((message) => [message.role, message.content])).toEqual([
        ['user', 'Fetch rows.'],
        ['assistant', 'Here are the rows.'],
        ['user', 'Also page 3, please.'],
        ['assistant', 'Page 3 too.'],
    ]);
    expect(messages[2].id).toBe(queued.id);
    expect(await f.queue.list(f.thread.id, 'alice')).toEqual([]);

    // Sent with no turn running: it starts one at once.
    f.replies.push(() => say('On it.'));
    const alice = await f.as('alice');
    const sent = await alice<SteeringView & { message: QueuedMessage }>(
        `/api/conversations/${f.thread.id}/steering`,
        'POST',
        { text: 'And page 4.' },
    );
    expect(sent.status).toBe(201);
    await vi.waitFor(() => expect(f.bodies).toHaveLength(3), {
        timeout: 10_000,
        interval: 10,
    });
    await f.idle();
    expect((await f.stored()).slice(-2)).toEqual([
        expect.objectContaining({
            id: sent.body.message.id,
            role: 'user',
            content: 'And page 4.',
        }),
        expect.objectContaining({ role: 'assistant', content: 'On it.' }),
    ]);
});

it('puts them back when the turn they start ends before storing them', async () => {
    const f = await fixture();
    // The person's model went away while their turn ran (connect_byo).
    const resolve = vi.spyOn(f.platform.inference, 'resolve').mockResolvedValue({ ok: false, reason: 'connect_byo' });
    const queued = await f.queue.add(f.thread.id, 'alice', 'Probe text A.');
    expect(await f.platform.steering.consider(f.thread.id)).toBe(true);
    await f.idle();
    // Time for a turn the end could start (none should).
    await new Promise((done) => setTimeout(done, 50));
    const runs = () => f.platform.runner.recentRuns({ only: [f.thread.id] });
    expect(runs().map((run) => run.status)).toEqual(['failed']);
    expect(await f.stored()).toEqual([]);
    expect(await f.queue.list(f.thread.id, 'alice')).toEqual([queued]);
    expect(f.bodies).toHaveLength(0);

    // With a model again, the next turn takes it.
    resolve.mockRestore();
    f.replies.push(() => say('Got it.'));
    expect(await f.platform.steering.consider(f.thread.id)).toBe(true);
    await f.idle();
    expect((await f.stored()).map((m) => [m.id, m.role, m.content])).toEqual([
        [queued.id, 'user', 'Probe text A.'],
        [expect.any(String), 'assistant', 'Got it.'],
    ]);
    expect(await f.queue.list(f.thread.id, 'alice')).toEqual([]);
});

it('does not start a turn after a turn waiting for a review', async () => {
    const f = await fixture();
    let queued!: QueuedMessage;
    f.replies.push(async () => {
        queued = await f.queue.add(f.thread.id, 'alice', 'Call it Rows.');
        return completion(
            {
                role: 'assistant',
                tool_calls: [
                    {
                        index: 0,
                        id: 'review-page',
                        type: 'function',
                        function: {
                            name: pageReviewTool.name,
                            arguments: JSON.stringify({
                                title: 'Notes',
                                content: '# Review me',
                                spaceId: f.dot.spaceId,
                            }),
                        },
                    },
                ],
            },
            'tool_calls',
        );
    });
    await f.turn([{ id: 'u1', role: 'user', content: 'Draft a page.' }], {
        tools: [pageReviewTool],
    });
    await f.idle();
    await new Promise((done) => setTimeout(done, 50));
    // The turn that carries on after the review takes it.
    expect(f.bodies).toHaveLength(1);
    expect(f.platform.runner.recentRuns({ only: [f.thread.id] })).toHaveLength(1);
    expect(await f.queue.list(f.thread.id, 'alice')).toEqual([queued]);
});

it('waits while Socio is paused, and never starts a turn twice', async () => {
    const f = await fixture();
    await f.store.updateSettings({ paused: true });
    await f.queue.add(f.thread.id, 'alice', 'When you are back.');
    expect(await f.platform.steering.consider(f.thread.id)).toBe(false);
    expect(await f.queue.list(f.thread.id, 'alice')).toHaveLength(1);
    await f.store.updateSettings({ paused: false });
    f.replies.push(() => say('Back.'));
    const [one, two] = await Promise.all([
        f.platform.steering.consider(f.thread.id),
        f.platform.steering.consider(f.thread.id),
    ]);
    expect([one, two].filter(Boolean)).toHaveLength(1);
    await f.idle();
    expect(f.bodies).toHaveLength(1);
    expect(count(f.bodies[0], 'When you are back.')).toBe(1);
});

it('delivers once through a busy model’s retry and a too-long prompt’s refit', async () => {
    const f = await fixture({ contextWindow: 16_384 });
    // Waiting before the turn: the person's own message starts round 1, so
    // it goes after round 1's call.
    const queued = await f.queue.add(f.thread.id, 'alice', 'Mind the totals row.');
    // Long earlier turns, so the refused round can be fitted.
    const history: Message[] = [];
    for (let index = 0; index < 8; index++) {
        history.push(
            { id: `h${index}`, role: 'user', content: `Fetch page ${index}.` },
            {
                id: `a${index}`,
                role: 'assistant',
                content: '',
                toolCalls: [
                    {
                        id: `old${index}`,
                        type: 'function',
                        function: {
                            name: 'fetch_rows',
                            arguments: JSON.stringify({ page: index }),
                        },
                    },
                ],
            },
            {
                id: `r${index}`,
                role: 'tool',
                toolCallId: `old${index}`,
                content: rows(index, 12_000),
            },
            {
                id: `b${index}`,
                role: 'assistant',
                content: `Page ${index} done. ${'The totals match the last report. '.repeat(40)}`,
            },
        );
    }
    f.replies.push(
        () => call('c1'),
        // Round 2: busy, then too long, then the answer.
        busy,
        tooLong,
        () => say('Totals row noted.'),
    );
    const events = await f.turn([...history, { id: 'u-last', role: 'user', content: 'Fetch the next page.' }]);
    expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(false);
    // Round 1 never had it; every request of round 2 had it once, last.
    const requests = f.requests();
    const round1 = requests.filter((request) => !JSON.stringify(request).includes('"c1"'));
    expect(round1.length).toBeGreaterThan(0);
    for (const request of round1) {
        expect(JSON.stringify(request)).not.toContain('Mind the totals row.');
    }
    const round2 = f.bodies.filter((body) => body.includes('"c1"'));
    expect(round2.length).toBe(3);
    for (const body of round2) {
        expect(count(body, 'Mind the totals row.')).toBe(1);
        const last = (JSON.parse(body) as Request).messages.at(-1)!;
        expect(last.role).toBe('user');
        expect(textOf(last.content)).toBe('Mind the totals row.');
    }
    // The refit sent less than the refused prompt, with it still last.
    expect(round2[2].length).toBeLessThan(round2[1].length);
    // Taken and shown once.
    expect(delivered(events)).toEqual([queued.id]);
    const messages = await f.stored();
    expect(messages.filter((message) => message.id === queued.id)).toHaveLength(1);
    expect(await f.queue.list(f.thread.id, 'alice')).toEqual([]);
});

it('keeps the prompt before it the same in a chat compacted into notes', async () => {
    const f = await fixture({ contextWindow: 16_384 });
    await f.queue.add(f.thread.id, 'alice', 'Skip page 5.');
    const history: Message[] = [];
    for (let index = 0; index < 8; index++) {
        history.push(
            { id: `h${index}`, role: 'user', content: `Fetch page ${index}.` },
            {
                id: `b${index}`,
                role: 'assistant',
                content: `Page ${index} done. ${'The totals match the last report. '.repeat(300)}`,
            },
        );
    }
    f.replies.push(
        () => call('c1'),
        () => say('Skipping page 5.'),
    );
    await f.turn([...history, { id: 'u-last', role: 'user', content: 'Fetch the next page.' }]);
    const [first, second] = f.requests();
    // Fitted (the chat's notes first), and unchanged up to the round's own
    // messages: the turn's note stays with the message that started it.
    expect(f.bodies[0].length).toBeLessThan(JSON.stringify(history).length);
    expect(JSON.stringify(second.messages.slice(0, first.messages.length))).toBe(JSON.stringify(first.messages));
    expect(textOf(second.messages.at(-1)!.content)).toBe('Skip page 5.');
    const roles = second.messages.map((message) => message.role);
    expect(roles.slice(-3)).toEqual(['assistant', 'tool', 'user']);
    // Roles take turns throughout (CB-147).
    const chat = roles.filter((role) => role !== 'system' && role !== 'tool');
    for (let at = 1; at < chat.length; at++) {
        expect(chat[at]).not.toBe(chat[at - 1]);
    }
});

it('leaves the queue to web turns: Telegram turns never take it', async () => {
    const f = await fixture();
    await f.workspace.telegram.bindThread('dm:1', f.thread.id, 'dm', '1', null);
    await f.queue.add(f.thread.id, 'alice', 'For the web chat.');
    f.replies.push(
        () => call('c1'),
        () => say('Done in Telegram.'),
    );
    const events = await f.turn(undefined, { channel: true });
    expect(delivered(events)).toEqual([]);
    for (const body of f.bodies) {
        expect(body).not.toContain('For the web chat.');
    }
    // Nor does a turn of its own start for it there.
    await f.idle();
    expect(f.bodies).toHaveLength(2);
    expect(await f.queue.list(f.thread.id, 'alice')).toHaveLength(1);
});

it('lets only the conversation’s owner queue, edit and cancel, and never in Telegram', async () => {
    const f = await fixture();
    // A turn in progress: what is sent waits for it.
    let release!: () => void;
    f.during.push(() => new Promise<void>((resolve) => (release = resolve)));
    f.replies.push(
        () => call('c1'),
        () => say('Read them.'),
    );
    const running = f.turn();
    await vi.waitFor(() => expect(release).toBeDefined());
    const alice = await f.as('alice');
    const bob = await f.as('bob');
    const path = `/api/conversations/${f.thread.id}/steering`;

    const first = await alice<SteeringView & { message: QueuedMessage }>(path, 'POST', { text: 'One.' });
    expect(first.status).toBe(201);
    expect(first.body.messages.map((message) => message.text)).toEqual(['One.']);
    const second = await alice<SteeringView & { message: QueuedMessage }>(path, 'POST', { text: 'Two.' });
    expect((await alice<SteeringView>(path)).body.messages.map((message) => message.text)).toEqual(['One.', 'Two.']);
    // Not another person's, not empty, not too long.
    expect((await bob(path)).status).toBe(404);
    expect((await bob(path, 'POST', { text: 'Hi.' })).status).toBe(404);
    expect((await bob(`${path}/${first.body.message.id}`, 'DELETE')).status).toBe(404);
    expect((await alice(path, 'POST', { text: '   ' })).status).toBe(400);
    expect((await alice(path, 'POST', { text: 'x'.repeat(8001) })).status).toBe(400);
    // Edit and cancel while it waits.
    const edited = await alice<SteeringView>(`${path}/${first.body.message.id}`, 'PATCH', { text: 'One, edited.' });
    expect(edited.status).toBe(200);
    expect(edited.body.messages.map((message) => message.text)).toEqual(['One, edited.', 'Two.']);
    const cancelled = await alice<SteeringView>(`${path}/${second.body.message.id}`, 'DELETE');
    expect(cancelled.body.messages.map((message) => message.text)).toEqual(['One, edited.']);

    // The call ends; the next round takes what waits.
    release();
    const events = await running;
    expect(delivered(events)).toEqual([first.body.message.id]);
    expect(f.bodies[1]).toContain('One, edited.');
    expect(f.bodies[1]).not.toContain('Two.');
    // Delivered: too late to change.
    const late = await alice<{ code: string }>(`${path}/${first.body.message.id}`, 'PATCH', { text: 'Too late.' });
    expect(late).toMatchObject({ status: 409, body: { code: 'delivered' } });
    expect((await alice(`${path}/${first.body.message.id}`, 'DELETE')).status).toBe(409);

    // A cap on what may wait (CB-170).
    await f.store.updateSettings({ paused: true });
    for (let index = 0; index < DEFAULT_STEERING_MAX_QUEUED; index++) {
        await f.queue.add(f.thread.id, 'alice', `Note ${index}.`);
    }
    expect((await alice(path, 'POST', { text: 'One more.' })).status).toBe(429);

    // A Telegram conversation takes its messages in Telegram.
    await f.workspace.telegram.bindThread('dm:1', f.thread.id, 'dm', '1', null);
    expect((await alice(path, 'POST', { text: 'Hi.' })).status).toBe(409);
});

/** Queues `texts` as Alice, through the API, while a turn's tool call waits. */
async function stoppedWithQueue(f: Awaited<ReturnType<typeof fixture>>, texts: string[]) {
    let release!: () => void;
    f.during.push(() => new Promise<void>((resolve) => (release = resolve)));
    f.replies.push(() => call('c1'));
    const running = f.turn();
    await vi.waitFor(() => expect(release).toBeDefined());
    const alice = await f.as('alice');
    const path = `/api/conversations/${f.thread.id}/steering`;
    const sent: QueuedMessage[] = [];
    for (const text of texts) {
        const response = await alice<{ message: QueuedMessage }>(path, 'POST', {
            text,
        });
        expect(response.status).toBe(201);
        sent.push(response.body.message);
    }
    // Stop, as the chat's Stop button does: the call still finishes.
    expect(await f.platform.runner.stop({ threadId: f.thread.id })).toBe(true);
    return { release, running, alice, path, sent };
}

it('sends what waits as the next turn after a Stop, in order and once (CB-170)', async () => {
    const f = await fixture();
    const stopped = await stoppedWithQueue(f, ['First thing.', 'Second thing.']);
    // Still waiting, and still theirs to change, until the turn has ended.
    const waiting = await stopped.alice<SteeringView>(stopped.path);
    expect(waiting.body.messages.map((message) => message.text)).toEqual(['First thing.', 'Second thing.']);
    expect(waiting.body.turn).toBeUndefined();
    // The next turn waits on its model, so the chat can see it running.
    let answer!: () => void;
    f.replies.push(() => new Promise<Response>((resolve) => (answer = () => resolve(say('Both read.')))));
    stopped.release();
    const events = await stopped.running;
    // The stopped turn took none of them.
    expect(delivered(events)).toEqual([]);
    await vi.waitFor(() => expect(answer).toBeDefined(), {
        timeout: 10_000,
        interval: 10,
    });
    const during = await stopped.alice<SteeringView>(stopped.path);
    expect(during.body.messages).toEqual([]);
    expect(during.body.turn).toBe(f.platform.runner.activeRunId(f.thread.id));
    answer();
    await f.idle();
    // Time for another turn to start (none should).
    await new Promise((done) => setTimeout(done, 50));
    expect(f.platform.runner.recentRuns({ only: [f.thread.id] }).map((run) => run.status)).toEqual([
        'finished',
        'stopped',
    ]);
    expect(f.bodies).toHaveLength(2);
    for (const text of ['First thing.', 'Second thing.']) {
        expect(count(f.bodies[1], text)).toBe(1);
    }
    expect(f.bodies[1].indexOf('First thing.')).toBeLessThan(f.bodies[1].indexOf('Second thing.'));
    const messages = await f.stored();
    const users = messages.filter((message) => message.role === 'user');
    expect(users.map((message) => [message.id, message.content])).toEqual([
        ['u1', 'Fetch rows.'],
        [stopped.sent[0].id, 'First thing.'],
        [stopped.sent[1].id, 'Second thing.'],
    ]);
    expect(messages.at(-1)).toMatchObject({
        role: 'assistant',
        content: 'Both read.',
    });
    expect(await f.queue.list(f.thread.id, 'alice')).toEqual([]);
    expect((await stopped.alice<SteeringView>(stopped.path)).body.turn).toBeUndefined();
});

it('lets the person cancel and edit what waits after a Stop (CB-170)', async () => {
    const f = await fixture();
    const stopped = await stoppedWithQueue(f, ['Drop this.', 'Keep this.']);
    const { alice, path, sent } = stopped;
    expect((await alice(`${path}/${sent[0].id}`, 'DELETE')).status).toBe(200);
    expect(
        (
            await alice(`${path}/${sent[1].id}`, 'PATCH', {
                text: 'Keep this, edited.',
            })
        ).status,
    ).toBe(200);
    f.replies.push(() => say('Edited one read.'));
    stopped.release();
    await stopped.running;
    await vi.waitFor(() => expect(f.bodies).toHaveLength(2), {
        timeout: 10_000,
        interval: 10,
    });
    await f.idle();
    expect(f.bodies[1]).not.toContain('Drop this.');
    expect(count(f.bodies[1], 'Keep this, edited.')).toBe(1);
    const users = (await f.stored()).filter((message) => message.role === 'user');
    expect(users.map((message) => message.content)).toEqual(['Fetch rows.', 'Keep this, edited.']);

    // Everything canceled: a Stop starts no turn.
    const again = await stoppedWithQueue(f, ['Never mind.']);
    expect((await again.alice(`${again.path}/${again.sent[0].id}`, 'DELETE')).status).toBe(200);
    again.release();
    await again.running;
    await f.idle();
    await new Promise((done) => setTimeout(done, 50));
    expect(f.bodies).toHaveLength(3);
    expect(f.bodies.join('\n')).not.toContain('Never mind.');
});

it('keeps what waits through a Stop while paused, and sends it on resume (CB-170)', async () => {
    const f = await fixture();
    const stopped = await stoppedWithQueue(f, ['After the pause.']);
    await f.store.updateSettings({ paused: true });
    stopped.release();
    await stopped.running;
    await f.idle();
    await new Promise((done) => setTimeout(done, 50));
    expect(f.bodies).toHaveLength(1);
    expect((await f.queue.list(f.thread.id, 'alice')).map((message) => message.text)).toEqual(['After the pause.']);
    // An admin resumes Socio: it goes then, once.
    f.replies.push(() => say('Back to it.'));
    const carol = await f.as('carol');
    expect((await carol('/api/settings', 'PATCH', { paused: false })).status).toBe(200);
    await vi.waitFor(() => expect(f.bodies).toHaveLength(2), {
        timeout: 10_000,
        interval: 10,
    });
    await f.idle();
    expect(count(f.bodies[1], 'After the pause.')).toBe(1);
    expect(await f.queue.list(f.thread.id, 'alice')).toEqual([]);
});

it('holds the queue to the admin’s limit, 5 by default, on the server (CB-170)', async () => {
    const f = await fixture();
    // No turn starts while paused: what is sent waits.
    await f.store.updateSettings({ paused: true });
    const alice = await f.as('alice');
    const path = `/api/conversations/${f.thread.id}/steering`;
    expect((await alice<SteeringView>(path)).body.limit).toBe(5);
    for (let index = 0; index < 5; index++) {
        expect((await alice(path, 'POST', { text: `Note ${index}.` })).status).toBe(201);
    }
    const over = await alice<{ error: string; code: string; limit: number }>(path, 'POST', { text: 'One more.' });
    expect(over).toMatchObject({
        status: 429,
        body: { code: 'queue_full', limit: 5 },
    });
    expect(over.body.error).toBe(
        'Up to 5 messages can wait for your socio. Send this one once it has read them, or cancel one.',
    );
    expect(await f.queue.count(f.thread.id, 'alice')).toBe(5);

    // Lower: what waits stays, nothing more goes in.
    await f.store.updateSettings({ limits: { steeringMaxQueued: 2 } });
    const view = await alice<SteeringView>(path);
    expect(view.body.limit).toBe(2);
    expect(view.body.messages).toHaveLength(5);
    expect((await alice(path, 'POST', { text: 'More.' })).status).toBe(429);
    // Higher: room again. Another person's queue is their own.
    await f.store.updateSettings({ limits: { steeringMaxQueued: 6 } });
    expect((await alice(path, 'POST', { text: 'Sixth.' })).status).toBe(201);
    expect((await alice(path, 'POST', { text: 'Seventh.' })).status).toBe(429);
    expect(await f.queue.addIfRoom(f.thread.id, 'bob', 'Bob’s first.', 6)).toMatchObject({ text: 'Bob’s first.' });

    // The environment's starting value, under the admin's.
    const g = await fixture({ steeringMaxQueued: 3 });
    await g.store.updateSettings({ paused: true });
    const gAlice = await g.as('alice');
    expect((await gAlice<SteeringView>(`/api/conversations/${g.thread.id}/steering`)).body.limit).toBe(3);
});

it('reads STEERING_MAX_QUEUED as a whole number from 1 to 20 (CB-170)', () => {
    expect(steeringMaxQueuedFromEnv({})).toBeUndefined();
    expect(steeringMaxQueuedFromEnv({ STEERING_MAX_QUEUED: ' 8 ' })).toBe(8);
    for (const bad of ['0', '21', '2.5', 'five']) {
        expect(() => steeringMaxQueuedFromEnv({ STEERING_MAX_QUEUED: bad })).toThrow(
            'STEERING_MAX_QUEUED must be a whole number from 1 to 20.',
        );
    }
});

it('keeps the turn’s note, facts and turns where the turn started', () => {
    const started = [
        { role: 'user' as const, content: 'Fetch rows.' },
        {
            role: 'assistant' as const,
            content: '',
            toolCalls: [
                {
                    id: 'c1',
                    type: 'function' as const,
                    function: { name: 'fetch_rows', arguments: '{}' },
                },
            ],
        },
        { role: 'tool' as const, content: '[]', toolCallId: 'c1' },
    ];
    const messages = [...started, steeringMessage('Use page 2.')];
    // Fitting's facts go with the person's message that started the turn,
    // as they did before the steering message came.
    const noted = withTurnNote(messages, 'Facts: rows.');
    expect(partsOf(noted[0].content).filter(isTurnNote)).toHaveLength(1);
    expect(noted[3]).toBe(messages[3]);
    expect(JSON.stringify(withTurnNote(started, 'Facts: rows.')[0])).toBe(JSON.stringify(noted[0]));
    // One turn, not two, for compaction.
    expect(turnStarts(messages)).toEqual([0]);
});

// CB-223: what the person sends while a turn runs is queued through the
// route the chat uses, shows as queued, and runs after the turn, in order;
// a message with a screenshot too, which the composer used to refuse.
it('queues two messages sent through the route while a turn runs, shows them, and runs them after it in order (CB-223)', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const path = `/api/conversations/${f.thread.id}/steering`;
    const answers: Array<{ status: number; body: unknown }> = [];
    let shown: SteeringView | undefined;
    f.replies.push(
        // Sent while the model writes its answer: no round comes after it.
        async () => {
            answers.push(await alice(path, 'POST', { text: 'Then page 3.' }));
            answers.push(await alice(path, 'POST', { text: 'And page 4.' }));
            shown = (await alice<SteeringView>(path)).body;
            return say('Here are the rows.');
        },
        () => say('Pages 3 and 4.'),
    );
    await f.turn();
    expect(answers.map(({ status }) => status)).toEqual([201, 201]);
    // Both shown as queued, oldest first, while the turn ran.
    expect(shown!.messages.map((message) => message.text)).toEqual(['Then page 3.', 'And page 4.']);
    await vi.waitFor(() => expect(f.bodies).toHaveLength(2), {
        timeout: 10_000,
        interval: 10,
    });
    await f.idle();
    // After the turn, the next one reads them, in order, once.
    const next = f.requests()[1];
    const words = next.messages
        .slice(2)
        .map((message) => textOf(message.content))
        .join('\n');
    expect(words.indexOf('Then page 3.')).toBeGreaterThan(-1);
    expect(words.indexOf('And page 4.')).toBeGreaterThan(words.indexOf('Then page 3.'));
    expect((await f.stored()).map((message) => [message.role, message.content])).toEqual([
        ['user', 'Fetch rows.'],
        ['assistant', 'Here are the rows.'],
        ['user', 'Then page 3.'],
        ['user', 'And page 4.'],
        ['assistant', 'Pages 3 and 4.'],
    ]);
    expect((await alice<SteeringView>(path)).body.messages).toEqual([]);
});

it('queues a message with an attachment while a turn runs; the round takes the text before it, the next turn reads its file (CB-223)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-steering-media-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const f = await fixture({ data: { userDataDir: dir } });
    const alice = await f.as('alice');
    const path = `/api/conversations/${f.thread.id}/steering`;
    const upload = async (userId: string, threadId?: string) =>
        (
            await f.platform.media.upload(userId, {
                name: 'screenshot.png',
                bytes: PNG,
                purpose: 'attachment',
                ...(threadId && { threadId }),
            })
        ).attachment!;
    const shot = await upload('alice', f.thread.id);
    const sent: Array<SteeringView & { message: QueuedMessage }> = [];
    let shown: SteeringView | undefined;
    f.during.push(async () => {
        for (const body of [
            { text: 'Page 2 first.' },
            { text: 'This is what I see.', attachments: [{ id: shot.id }] },
            { text: 'Then page 5.' },
        ]) {
            const answer = await alice<SteeringView & { message: QueuedMessage }>(path, 'POST', body);
            expect(answer.status).toBe(201);
            sent.push(answer.body);
        }
        shown = (await alice<SteeringView>(path)).body;
    });
    f.replies.push(
        () => call('c1'),
        () => say('Page 2 it is.'),
        () => say('I see the screenshot.'),
    );
    await f.turn();
    // Shown as queued with its file's reference, never its bytes.
    expect(shown!.messages).toEqual([
        expect.objectContaining({ text: 'Page 2 first.' }),
        expect.objectContaining({
            text: 'This is what I see.',
            attachments: [
                {
                    id: shot.id,
                    name: 'screenshot.png',
                    mediaType: 'image/png',
                    size: PNG.length,
                    kind: 'image',
                },
            ],
        }),
        expect.objectContaining({ text: 'Then page 5.' }),
    ]);
    expect(shown!.messages[0].attachments).toBeUndefined();

    // The round after the tool call took only the text before it.
    const second = f.requests()[1];
    const roundWords = second.messages
        .slice(2)
        .map((message) => textOf(message.content))
        .join('\n');
    expect(roundWords).toContain('Page 2 first.');
    expect(roundWords).not.toContain('This is what I see.');
    expect(roundWords).not.toContain('Then page 5.');

    // The rest started the next turn once this one ended, in order, the
    // screenshot read as a sent message's is.
    await vi.waitFor(() => expect(f.bodies).toHaveLength(3), {
        timeout: 10_000,
        interval: 10,
    });
    await f.idle();
    const third = f.bodies[2];
    expect(third).toContain(`Image attached ${shot.id}`);
    expect(third.indexOf('This is what I see.')).toBeLessThan(third.indexOf('Then page 5.'));
    const stored = await f.stored();
    expect(stored.slice(-3)).toEqual([
        expect.objectContaining({
            id: sent[1].message.id,
            role: 'user',
            metadata: { socioSender: 'alice', socioSenderName: 'Alice' },
            content: [
                { type: 'text', text: 'This is what I see.' },
                // The 1.0 media part, never the pre-1.0 `binary` one.
                {
                    type: 'image',
                    source: { type: 'file', value: shot.id, provider: 'socio', mimeType: 'image/png' },
                    metadata: { filename: 'screenshot.png' },
                },
            ],
        }),
        expect.objectContaining({
            id: sent[2].message.id,
            role: 'user',
            metadata: { socioSender: 'alice', socioSenderName: 'Alice' },
            content: 'Then page 5.',
        }),
        expect.objectContaining({
            role: 'assistant',
            content: 'I see the screenshot.',
        }),
    ]);
    // Sent with that message: bound to the chat, never pending again.
    expect(await f.platform.media.attachment(shot.id)).toMatchObject({
        threadId: f.thread.id,
        messageId: sent[1].message.id,
    });
    expect(await f.queue.list(f.thread.id, 'alice')).toEqual([]);

    // Only the person's own files, of this chat or none yet; files alone
    // are a message, nothing at all is not.
    const bobs = await upload('bob');
    const other = await f.workspace.bindThread('other', f.dot.id, 'Other', 'alice');
    const elsewhere = await upload('alice', other.id);
    const pending = await upload('alice');
    for (const id of [bobs.id, elsewhere.id, 'cbatt_AAAAAAAAAAAAAAAAAAAAAA']) {
        expect((await alice(path, 'POST', { text: 'Look.', attachments: [{ id }] })).status).toBe(400);
    }
    expect((await alice(path, 'POST', { text: '  ' })).status).toBe(400);
    expect((await alice(path, 'POST', { text: '', attachments: [] })).status).toBe(400);
    // No turn runs: one with files alone starts one at once.
    f.replies.push(() => say('Got the file.'));
    const alone = await alice<SteeringView & { message: QueuedMessage }>(path, 'POST', {
        text: '',
        attachments: [{ id: pending.id }],
    });
    expect(alone.status).toBe(201);
    expect(alone.body.message).toMatchObject({
        text: '',
        attachments: [expect.objectContaining({ id: pending.id })],
    });
    await vi.waitFor(() => expect(f.bodies).toHaveLength(4), {
        timeout: 10_000,
        interval: 10,
    });
    await f.idle();
    expect((await f.stored()).at(-2)).toMatchObject({
        id: alone.body.message.id,
        content: [{ type: 'image', source: { type: 'file', value: pending.id } }],
    });
});

it('keeps a queued message’s attachments when it is put back (CB-223)', async () => {
    const f = await fixture();
    const ref = {
        id: 'cbatt_AAAAAAAAAAAAAAAAAAAAAA',
        name: 'shot.png',
        mediaType: 'image/png',
        size: 4,
        kind: 'image' as const,
    };
    const text = await f.queue.add(f.thread.id, 'alice', 'Words.', 1);
    const files = await f.queue.add(f.thread.id, 'alice', '', 2, [ref]);
    const after = await f.queue.add(f.thread.id, 'alice', 'More words.', 3);
    // A round takes the words before the files only.
    expect(await f.queue.takeText(f.thread.id, 'alice')).toEqual([text]);
    expect(await f.queue.takeText(f.thread.id, 'alice')).toEqual([]);
    // A turn takes the rest; one that couldn't store them puts them back.
    const taken = await f.queue.take(f.thread.id, 'alice');
    expect(taken).toEqual([files, after]);
    await f.queue.restore(f.thread.id, 'alice', taken);
    expect(await f.queue.list(f.thread.id, 'alice')).toEqual([files, after]);
    expect(files.attachments).toEqual([ref]);
});

it('says whether a turn runs now, so a chat reloaded during one can queue (CB-223)', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const path = `/api/conversations/${f.thread.id}/steering`;
    expect((await alice<SteeringView>(path)).body.running).toBeUndefined();
    let during: SteeringView | undefined;
    f.during.push(async () => {
        during = (await alice<SteeringView>(path)).body;
    });
    f.replies.push(
        () => call('c1'),
        () => say('Done.'),
    );
    await f.turn();
    expect(during).toMatchObject({ running: true, messages: [] });
    await f.idle();
    expect((await alice<SteeringView>(path)).body.running).toBeUndefined();
});

it('keeps a queued message’s files from the cleanup of unsent ones, until it is cancelled (CB-223)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-steering-media-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const f = await fixture({ data: { userDataDir: dir } });
    const upload = async () =>
        (
            await f.platform.media.upload('alice', {
                name: 'screenshot.png',
                bytes: PNG,
                purpose: 'attachment',
                threadId: f.thread.id,
            })
        ).attachment!;
    const queued = await upload();
    const loose = await upload();
    const message = await f.queue.add(f.thread.id, 'alice', 'Look.', Date.now(), [queued]);
    // A day on (Socio paused, say): the loose one goes, the queued one stays.
    const later = Date.now() + MEDIA_LIMITS.pendingMs + 60_000;
    expect(await f.platform.media.collectPending(later)).toBe(1);
    expect(await f.platform.media.attachment(loose.id)).toBeUndefined();
    expect(await f.platform.media.attachment(queued.id)).toMatchObject({
        id: queued.id,
        boundAt: null,
    });
    // Canceled, its file is left unsent, and cleaned up as any other.
    expect(await f.queue.cancel(f.thread.id, 'alice', message.id)).toBe(true);
    expect(await f.platform.media.collectPending(later)).toBe(1);
    expect(await f.platform.media.attachment(queued.id)).toBeUndefined();
});

it('claims a queued message’s files when its turn takes them, so a turn that fails first leaves them (CB-223)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-steering-media-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const f = await fixture({ data: { userDataDir: dir } });
    const alice = await f.as('alice');
    const shot = (
        await f.platform.media.upload('alice', {
            name: 'screenshot.png',
            bytes: PNG,
            purpose: 'attachment',
            threadId: f.thread.id,
        })
    ).attachment!;
    // The turn fails before it reads the files.
    const reading = vi.spyOn(f.platform.media, 'resolveForModel').mockRejectedValue(new Error('Storage is away.'));
    const sent = await alice<SteeringView & { message: QueuedMessage }>(
        `/api/conversations/${f.thread.id}/steering`,
        'POST',
        { text: 'Look.', attachments: [{ id: shot.id }] },
    );
    expect(sent.status).toBe(201);
    await vi.waitFor(() => expect(reading).toHaveBeenCalled(), {
        timeout: 10_000,
        interval: 10,
    });
    await f.idle();
    // The turn has the message; its file is claimed, not left unsent.
    expect(await f.stored()).toContainEqual(expect.objectContaining({ id: sent.body.message.id }));
    expect(await f.queue.list(f.thread.id, 'alice')).toEqual([]);
    const later = Date.now() + MEDIA_LIMITS.pendingMs + 60_000;
    expect(await f.platform.media.collectPending(later)).toBe(0);
    expect(await f.platform.media.attachment(shot.id)).toMatchObject({
        threadId: f.thread.id,
        messageId: sent.body.message.id,
    });
});

it('refuses a queued message whose file the cleanup removed while it was queued (CB-223)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-steering-media-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const f = await fixture({ data: { userDataDir: dir } });
    const alice = await f.as('alice');
    const shot = (
        await f.platform.media.upload('alice', {
            name: 'screenshot.png',
            bytes: PNG,
            purpose: 'attachment',
            threadId: f.thread.id,
        })
    ).attachment!;
    // The hourly cleanup runs between the route's check and its insert.
    const add = f.queue.addIfRoom.bind(f.queue);
    vi.spyOn(f.queue, 'addIfRoom').mockImplementationOnce(async (...args: Parameters<typeof add>) => {
        await f.platform.media.collectPending(Date.now() + MEDIA_LIMITS.pendingMs + 60_000);
        return add(...args);
    });
    const sent = await alice(`/api/conversations/${f.thread.id}/steering`, 'POST', {
        text: 'Look.',
        attachments: [{ id: shot.id }],
    });
    expect(sent).toMatchObject({
        status: 400,
        body: { error: expect.stringContaining('no longer there') },
    });
    expect(await f.queue.list(f.thread.id, 'alice')).toEqual([]);
    expect(f.bodies).toEqual([]);
});

it('edits a queued message with files down to its files, or takes a file off (CB-223)', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const ref = (id: string) => ({
        id,
        name: `${id}.png`,
        mediaType: 'image/png',
        size: 4,
        kind: 'image' as const,
    });
    const [one, two] = [ref('cbatt_AAAAAAAAAAAAAAAAAAAAAA'), ref('cbatt_BBBBBBBBBBBBBBBBBBBBBB')];
    const queued = await f.queue.add(f.thread.id, 'alice', 'Look.', 1, [one, two]);
    const plain = await f.queue.add(f.thread.id, 'alice', 'Words.', 2);
    const path = (id: string) => `/api/conversations/${f.thread.id}/steering/${id}`;
    type Edited = SteeringView & { message: QueuedMessage };

    // Its words gone: its files alone are still a message.
    const trimmed = await alice<Edited>(path(queued.id), 'PATCH', { text: '' });
    expect(trimmed.status).toBe(200);
    expect(trimmed.body.message).toMatchObject({
        text: '',
        attachments: [one, two],
    });
    // A file taken off; the other stays.
    const fewer = await alice<Edited>(path(queued.id), 'PATCH', {
        text: '',
        attachments: [{ id: two.id }],
    });
    expect(fewer.body.message).toMatchObject({ text: '', attachments: [two] });
    // Neither words nor files: refused, as it was.
    expect((await alice(path(queued.id), 'PATCH', { text: ' ', attachments: [] })).status).toBe(400);
    // Only its own files can stay: none is added by an edit.
    expect(
        (
            await alice(path(queued.id), 'PATCH', {
                text: 'Look.',
                attachments: [{ id: one.id }],
            })
        ).status,
    ).toBe(400);
    // Words back and the last file off: a message of words.
    const words = await alice<Edited>(path(queued.id), 'PATCH', {
        text: 'Just words now.',
        attachments: [],
    });
    expect(words.body.message.attachments).toBeUndefined();
    expect(words.body.message.text).toBe('Just words now.');
    // One without files still needs words.
    expect((await alice(path(plain.id), 'PATCH', { text: '' })).status).toBe(400);
    expect((await f.queue.list(f.thread.id, 'alice')).map((message) => message.id)).toEqual([queued.id, plain.id]);
});

it('answers a queued message a turn took before its file check undid it as delivered (CB-223)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-steering-media-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const f = await fixture({ data: { userDataDir: dir } });
    const alice = await f.as('alice');
    const shot = (
        await f.platform.media.upload('alice', {
            name: 'screenshot.png',
            bytes: PNG,
            purpose: 'attachment',
            threadId: f.thread.id,
        })
    ).attachment!;
    // The cleanup removes the file between the check and the insert, and a
    // turn takes the message before the route can take it back.
    const add = f.queue.addIfRoom.bind(f.queue);
    vi.spyOn(f.queue, 'addIfRoom').mockImplementationOnce(async (...args: Parameters<typeof add>) => {
        await f.platform.media.collectPending(Date.now() + MEDIA_LIMITS.pendingMs + 60_000);
        const message = await add(...args);
        await f.queue.take(f.thread.id, 'alice');
        return message;
    });
    const sent = await alice<SteeringView & { message: QueuedMessage }>(
        `/api/conversations/${f.thread.id}/steering`,
        'POST',
        { text: 'Look.', attachments: [{ id: shot.id }] },
    );
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({
        delivered: true,
        message: { text: 'Look.' },
        messages: [],
    });
});
