import '@socio/foundation/no-vendor-telemetry';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BaseEvent, Message, RunAgentInput } from '@ag-ui/client';
import { ProxiedCopilotRuntimeAgent } from '@copilotkit/core';
import { afterEach, expect, it, vi } from 'vitest';

import { requestMessages } from '@socio/shared/chat/chat-history';
import type { User } from '@socio/shared/types';

import { sendNewMessagesOnly } from '../../packages/client/src/modules/chat/sync/new-messages.js';
import { CHAT_REQUEST_BYTES } from '../../src/server/app.js';
import { MockAuthProvider } from '../../src/server/auth/mock.js';
import { NEW_MESSAGE_BYTES } from '../../src/server/composition/app/turns.js';
import { longChatRuns } from '../fixtures/long-chat.js';
import { completion } from '../fixtures/model-stream.js';
import { makeTestRuntime } from '../helpers/test-runtime.js';

// CB-156: a long chat with browser work failed with "Request is too
// large." The browser sent the whole conversation with every run and
// connect, a 1.7 MB screenshot result included, and the app refused any
// request over 1 MB before the runner or fitting saw it. A chat's
// requests now carry only what the server doesn't have; the runner
// rebuilds the rest from storage, and fitting cuts what the model can't
// take.
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});
vi.setConfig({ testTimeout: 30_000 });

const USERS: User[] = [{ id: 'alice', name: 'Alice', role: 'member' }];
const SECRET = 'secret-0123456789abcdef-xyz';
const realFetch = globalThis.fetch.bind(globalThis);
/** A 1280×800 PNG screenshot as the computer's tool returns it: ~1.7 MB. */
const screenshot = () =>
    JSON.stringify({
        base64: randomBytes(1_275_000).toString('base64'),
        width: 1280,
        height: 800,
        capturedAt: '2026-10-22T07:50:19.131Z',
        url: 'http://127.0.0.1:4310/',
    });

/** A finished run that plays the game in the browser, as the owner's did. */
function browserRun(threadId: string, turn: number, startedAt: number) {
    const runId = `play-${turn}`;
    const events: Array<Record<string, unknown>> = [];
    let ms = 0;
    const at = (event: Record<string, unknown>) => events.push({ ...event, timestamp: startedAt + (ms += 300) });
    at({
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
            messages: [{ id: `ask-${turn}`, role: 'user', content: `Play ${turn}` }],
        },
    });
    const reply = `played-${turn}`;
    const calls: Array<[string, string]> = [
        ['computer_screenshot', screenshot()],
        ['computer_click', JSON.stringify({ ok: true, ref: 'f1e77' })],
        ['computer_snapshot', JSON.stringify({ title: 'Game', tree: 'x'.repeat(900) })],
    ];
    for (const [index, [name, content]] of calls.entries()) {
        const id = `call-play-${turn}-${index}`;
        at({
            type: 'TOOL_CALL_START',
            toolCallId: id,
            toolCallName: name,
            parentMessageId: reply,
        });
        at({ type: 'TOOL_CALL_ARGS', toolCallId: id, delta: '{}' });
        at({ type: 'TOOL_CALL_END', toolCallId: id });
        at({
            type: 'TOOL_CALL_RESULT',
            messageId: `${id}-result`,
            toolCallId: id,
            role: 'tool',
            content,
        });
    }
    at({ type: 'TEXT_MESSAGE_START', messageId: reply, role: 'assistant' });
    at({
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: reply,
        delta: `You can watch: I played build ${turn} and paused it.`,
    });
    at({ type: 'TEXT_MESSAGE_END', messageId: reply });
    at({ type: 'RUN_FINISHED', threadId, runId });
    return { runId, startedAt, events: events as unknown as BaseEvent[] };
}

async function fixture() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'cb-too-large-'));
    /** Bodies of the Dot's model calls (not notes or titles). */
    const chats: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        if (!url.startsWith('https://model.invalid/')) {
            return realFetch(input, init);
        }
        const body = String(init?.body);
        if (body.includes('Write a short title')) {
            return Response.json({ choices: [{ message: { content: 'Title' } }] });
        }
        // Compaction's notes of the older turns.
        if (body.includes('You keep the running notes')) {
            return completion({
                role: 'assistant',
                content: 'Notes: the person reviews the pipeline, then plays the game.',
            });
        }
        chats.push(body);
        return completion({ role: 'assistant', content: 'Watching it now.' });
    });
    const { workspace, platform, app, dispose } = await makeTestRuntime({
        config: {
            baseUrl: 'https://model.invalid/v1',
            apiKey: 'unused',
            model: 'qwen-test',
            runtimeUrl: '',
            sessionSecret: SECRET,
            data: { userDataDir: dir },
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(USERS, SECRET),
                secureCookies: false,
            },
        },
    });
    cleanup.push(async () => {
        await dispose();
        rmSync(dir, { recursive: true, force: true });
    });
    const dot = workspace.dots()[0];
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    // "Scheduled: Go…": a long chat of data work, then browser play with a
    // screenshot each turn.
    const threadId = 'scheduled-go';
    workspace.bindThread(threadId, dot.id, 'Scheduled: Go', 'alice');
    const db = (platform.runner as unknown as { db: import('node:sqlite').DatabaseSync }).db;
    const insert = (run: { runId: string; startedAt: number; events: BaseEvent[] }) =>
        db
            .prepare(
                "INSERT INTO agent_runs(threadId, runId, status, events, startedAt, finishedAt) VALUES (?, ?, 'finished', ?, ?, ?)",
            )
            .run(threadId, run.runId, JSON.stringify(run.events), run.startedAt, run.startedAt + 60_000);
    const runs = longChatRuns({ threadId, turns: 12, largest: 60_000 });
    for (const run of runs) {
        insert(run);
    }
    const last = runs.at(-1)!.startedAt;
    for (let turn = 1; turn <= 3; turn++) {
        insert(browserRun(threadId, turn, last + turn * 15 * 60_000));
    }
    const signIn = async () => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 'alice' }),
        });
        return login.headers.get('set-cookie')!.split(';')[0];
    };
    /** The browser's runtime agent for this chat, as CopilotKit makes it. */
    const browserAgent = (messages: Message[]) => {
        const agent = new ProxiedCopilotRuntimeAgent({
            runtimeUrl: '/api/copilotkit',
            agentId: dot.id,
            transport: 'rest',
        });
        agent.threadId = threadId;
        agent.setMessages(messages);
        return agent;
    };
    /** The body the agent sends for a run with its messages. */
    const body = (agent: ProxiedCopilotRuntimeAgent, runId: string) =>
        String(
            (agent as unknown as { requestInit(input: RunAgentInput): RequestInit }).requestInit({
                threadId,
                runId,
                messages: agent.messages,
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
            }).body,
        );
    const run = async (cookie: string, json: string) => {
        const response = await app.request(`/api/copilotkit/agent/${dot.id}/run`, {
            method: 'POST',
            headers: {
                cookie,
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
            },
            body: json,
        });
        return { status: response.status, text: await response.text() };
    };
    return {
        app,
        platform,
        dot,
        threadId,
        chats,
        insert,
        signIn,
        browserAgent,
        body,
        run,
    };
}

/** The model request's messages (Chat Completions). */
const modelMessages = (body: string) =>
    (JSON.parse(body) as { messages: { role: string; content: unknown }[] }).messages;

it('sends only what the server lacks: older turns, their steps and the screenshots stay on the server', () => {
    const turn = (n: number): Message[] => [
        { id: `u${n}`, role: 'user', content: `Q${n}` },
        {
            id: `a${n}`,
            role: 'assistant',
            content: '',
            toolCalls: [
                {
                    id: `c${n}`,
                    type: 'function',
                    function: { name: 'computer_screenshot', arguments: '{}' },
                },
            ],
        },
        { id: `t${n}`, role: 'tool', toolCallId: `c${n}`, content: 'png' },
        { id: `r${n}`, role: 'assistant', content: `A${n}` },
    ];
    const ids = (messages: Message[]) => messages.map((message) => message.id);
    const fresh: Message = { id: 'new', role: 'user', content: 'Watch me' };
    expect(ids(requestMessages([...turn(1), ...turn(2), fresh]))).toEqual(['new']);
    // A turn that never arrived stays, before the new one.
    const lost: Message = { id: 'lost', role: 'user', content: 'Earlier' };
    expect(ids(requestMessages([...turn(1), lost, fresh]))).toEqual(['lost', 'new']);
    // A turn stopped before its answer: its question and steps are stored.
    expect(ids(requestMessages([...turn(1), ...turn(2).slice(0, 3), fresh]))).toEqual(['new']);
    // A page review's answer goes with the run that carries on.
    const review: Message = {
        id: 'review',
        role: 'tool',
        toolCallId: 'c2',
        content: '{"decision":"approved"}',
    };
    expect(ids(requestMessages([...turn(1), ...turn(2).slice(0, 2), review]))).toEqual(['review']);
    // A new chat sends its first message.
    expect(ids(requestMessages([fresh]))).toEqual(['new']);
});

it('keeps a long chat with screenshots working: the request stays small and the model gets the stored conversation', async () => {
    const f = await fixture();
    const cookie = await f.signIn();
    const stored = await f.platform.runner.messages(f.threadId);
    const shots = stored.filter(
        (message) => message.role === 'tool' && String(message.content).startsWith('{"base64"'),
    );
    expect(shots).toHaveLength(3);
    // The chat's agent holds the whole conversation (a chat opened without
    // its store, or a long session), then the new message.
    const ask: Message = {
        id: 'ask-new',
        role: 'user',
        content: 'I wanna watch you play',
    };
    const agent = f.browserAgent([...stored, ask]);
    // As it was: over the app's 1 MB request limit, refused before any run.
    const whole = f.body(agent, 'run-whole');
    expect(whole.length).toBeGreaterThan(5_000_000);
    // Now: only the new message goes.
    const undo = sendNewMessagesOnly(agent);
    const slim = f.body(agent, 'run-new');
    expect(slim.length).toBeLessThan(2_000);
    expect((JSON.parse(slim) as RunAgentInput).messages.map((message) => message.id)).toEqual(['ask-new']);
    // The agent still shows everything.
    expect(agent.messages).toHaveLength(stored.length + 1);

    const answer = await f.run(cookie, slim);
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('Watching it now.');
    expect(answer.text).toContain('RUN_FINISHED');
    expect(answer.text).not.toMatch(/too large/i);
    // The model got the stored conversation, the newest turns word for word,
    // and at most an excerpt of each screenshot: fitting cut them.
    expect(f.chats).toHaveLength(1);
    const request = f.chats[0];
    expect(request.length).toBeLessThan(1_000_000);
    expect(request).toContain('Play 3');
    expect(request).toContain('I played build 3 and paused it.');
    expect(request).toContain('I wanna watch you play');
    const runs = request.match(/[A-Za-z0-9+/=]{1000,}/g) ?? [];
    expect(Math.max(0, ...runs.map((run) => run.length))).toBeLessThan(20_000);
    const sent = modelMessages(request);
    expect(sent.at(-1)).toMatchObject({ role: 'user' });
    // Nothing was lost from history: the screenshots are stored whole.
    const after = await f.platform.runner.messages(f.threadId);
    expect(after.filter((message) => shots.some((shot) => shot.content === message.content))).toHaveLength(3);
    expect(after.at(-1)).toMatchObject({
        role: 'assistant',
        content: 'Watching it now.',
    });

    // The next turn the same way; the system prompt is byte for byte the same.
    agent.setMessages([...after, { id: 'ask-next', role: 'user', content: 'Again, slower' }]);
    const next = await f.run(cookie, f.body(agent, 'run-next'));
    expect(next.status).toBe(200);
    expect(next.text).toContain('Watching it now.');
    expect(f.chats).toHaveLength(2);
    const system = (body: string) => modelMessages(body).find((message) => message.role === 'system');
    expect(system(f.chats[1])).toEqual(system(f.chats[0]));
    undo();
    expect(f.body(agent, 'run-undone').length).toBeGreaterThan(5_000_000);
});

it('takes the whole conversation from a tab opened before the fix, screenshots included', async () => {
    const f = await fixture();
    const cookie = await f.signIn();
    const stored = await f.platform.runner.messages(f.threadId);
    const agent = f.browserAgent([...stored, { id: 'ask-old-tab', role: 'user', content: 'I wanna watch you play' }]);
    const whole = f.body(agent, 'run-old-tab');
    expect(whole.length).toBeGreaterThan(1_000_000);
    expect(whole.length).toBeLessThan(CHAT_REQUEST_BYTES);
    const answer = await f.run(cookie, whole);
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('Watching it now.');
    expect(f.chats).toHaveLength(1);
    expect(f.chats[0].length).toBeLessThan(1_000_000);
    // Past the chat's limit, the refusal is the app's JSON, not a proxy page.
    const huge = await f.run(cookie, 'x'.repeat(CHAT_REQUEST_BYTES + 1));
    expect(huge.status).toBe(413);
    // Other API requests keep their 1 MB limit.
    const other = await f.app.request('/api/conversations', {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'x'.repeat(1_000_001) }),
    });
    expect(other.status).toBe(413);
});

it('keeps a request without a session to 1 MB, and each new message a run brings to about 1 MB', async () => {
    const f = await fixture();
    // Without a session, a chunked body isn't read past the check.
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(120);
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (pulled >= 3_000_000) {
                return controller.close();
            }
            pulled += chunk.length;
            controller.enqueue(chunk);
        },
    });
    const anonymous = await f.app.request(
        new Request(`http://localhost/api/copilotkit/agent/${f.dot.id}/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: stream,
            duplex: 'half',
        } as RequestInit),
    );
    expect(anonymous.status).toBe(401);
    expect(pulled).toBeLessThan(1_000_000);
    // Signed in, a new message over the bound is refused, and not stored.
    const cookie = await f.signIn();
    const stored = await f.platform.runner.messages(f.threadId);
    const send = (messages: Message[]) =>
        f.run(
            cookie,
            JSON.stringify({
                threadId: f.threadId,
                runId: `run-${messages.at(-1)!.id}`,
                messages,
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
            }),
        );
    const long = 'x'.repeat(NEW_MESSAGE_BYTES);
    const paste = await send([{ id: 'paste', role: 'user', content: long }]);
    expect(paste.status).toBe(413);
    expect(JSON.parse(paste.text)).toEqual({
        error: 'This message is too long to send.',
    });
    // So is anything else a client makes up, a tool result say.
    const made = await send([
        ...stored,
        { id: 'made-up', role: 'tool', toolCallId: 'call-play-3-0', content: long },
        { id: 'after', role: 'user', content: 'Hi' },
    ]);
    expect(made.status).toBe(413);
    expect(f.platform.runner.knownMessageIds(f.threadId).has('paste')).toBe(false);
    expect(f.chats).toHaveLength(0);
    // A stored screenshot sent again is no new message: it passes.
    const again = await send([...stored, { id: 'short', role: 'user', content: 'Short' }]);
    expect(again.status).toBe(200);
    expect(again.text).toContain('Watching it now.');
});

it('never drops or repeats a steering message the chat holds after the newest reply', async () => {
    const f = await fixture();
    const cookie = await f.signIn();
    // A turn that took a queued message (CB-151), then stopped before it
    // answered: the message is stored, after the newest reply.
    const steer = 'Also check the pause menu';
    f.insert({
        runId: 'steered',
        startedAt: Date.UTC(2026, 9, 22, 7, 55),
        events: [
            {
                type: 'RUN_STARTED',
                threadId: f.threadId,
                runId: 'steered',
                input: {
                    threadId: f.threadId,
                    runId: 'steered',
                    state: {},
                    tools: [],
                    context: [],
                    forwardedProps: {},
                    messages: [{ id: 'ask-steered', role: 'user', content: 'Go on' }],
                },
            },
            { type: 'TEXT_MESSAGE_START', messageId: 'steer-1', role: 'user' },
            { type: 'TEXT_MESSAGE_CONTENT', messageId: 'steer-1', delta: steer },
            { type: 'TEXT_MESSAGE_END', messageId: 'steer-1' },
            { type: 'RUN_FINISHED', threadId: f.threadId, runId: 'steered' },
        ] as unknown as BaseEvent[],
    });
    const stored = await f.platform.runner.messages(f.threadId);
    expect(stored.at(-1)).toMatchObject({ id: 'steer-1', role: 'user' });
    const agent = f.browserAgent([...stored, { id: 'ask-after', role: 'user', content: 'And the joystick?' }]);
    sendNewMessagesOnly(agent);
    const json = f.body(agent, 'run-after');
    expect((JSON.parse(json) as RunAgentInput).messages.map((message) => message.id)).toEqual([
        'ask-steered',
        'steer-1',
        'ask-after',
    ]);
    const answer = await f.run(cookie, json);
    expect(answer.status).toBe(200);
    const request = f.chats[0];
    expect(request.split(steer)).toHaveLength(2);
    expect(request.split('And the joystick?')).toHaveLength(2);
    // The run stores only what it brought.
    const first = f.platform.runner.runEvents('run-after')[0] as BaseEvent & {
        input: { messages: Message[] };
    };
    expect(first.input.messages.map((message) => message.id)).toEqual(['ask-after']);
});
