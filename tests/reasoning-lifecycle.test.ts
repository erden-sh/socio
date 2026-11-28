import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { verifyEvents } from '@ag-ui/client';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it } from 'vitest';

import { DotAgent } from './helpers/dot-agent.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

// A Qwen-style thinking model on an OpenAI-compatible server streams its
// thinking as `delta.reasoning_content` (or `delta.reasoning`). Every shape
// below must reach the browser as AG-UI events its verifier accepts: a
// reasoning message ended only after it started, and once.

type Delta = Record<string, unknown>;
interface Round {
    deltas: Delta[];
    finish: string;
}

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** A loopback chat-completions server answering each request with the next round. */
async function fakeChatCompletions(rounds: Round[]) {
    const queue = [...rounds];
    let requests = 0;
    const server: Server = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            requests += 1;
            const round = queue.shift() ?? { deltas: [{ content: 'Done.' }], finish: 'stop' };
            const chunk = (delta: Delta, finish: string | null) => ({
                id: `completion-${requests}`,
                object: 'chat.completion.chunk',
                created: 1,
                model: 'qwen-thinking',
                choices: [{ index: 0, delta, finish_reason: finish }],
            });
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            for (const delta of round.deltas) {
                res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
            }
            res.write(`data: ${JSON.stringify(chunk({}, round.finish))}\n\n`);
            res.end('data: [DONE]\n\n');
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${port}/v1`, requests: () => requests };
}

async function runTurn(rounds: Round[]) {
    const fake = await fakeChatCompletions(rounds);
    const store = new Store(testDatabase());
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(
        () => store.close(),
        () => workspace.close(),
    );
    const dot = workspace.dots()[0];
    workspace.recordUser({ id: 'owner', name: 'Owner', role: 'member' });
    workspace.bindThread('thread', dot.id, 'Thinking', 'owner');
    const agent = new DotAgent(
        store,
        workspace,
        { apiKey: 'fixture', model: 'qwen-thinking', baseUrl: fake.baseUrl },
        dot.id,
    );
    const input: RunAgentInput = {
        threadId: 'thread',
        runId: 'run',
        state: {},
        context: [],
        messages: [{ id: 'user', role: 'user', content: 'What time is it?' }],
        tools: [],
        forwardedProps: {},
    };
    // As the browser's client checks them.
    const events: BaseEvent[] = await lastValueFrom(agent.run(input).pipe(verifyEvents(false), toArray()));
    return { events, requests: fake.requests() };
}

/** A tool call; the tool is unknown, so the model gets an error result and goes on. */
const toolCall = (id: string) => ({
    tool_calls: [
        {
            index: 0,
            id,
            type: 'function',
            function: { name: 'look_at_clock', arguments: '{}' },
        },
    ],
});

const reasoningText = (events: BaseEvent[]) =>
    events
        .filter((event) => event.type === EventType.REASONING_MESSAGE_CONTENT)
        .map((event) => (event as unknown as { delta: string }).delta)
        .join('');
const answerText = (events: BaseEvent[]) =>
    events
        .filter((event) => event.type === EventType.TEXT_MESSAGE_CHUNK || event.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((event) => (event as unknown as { delta: string }).delta)
        .join('');

/** Every reasoning message started once, then ended once, in order. */
function expectBalancedReasoning(events: BaseEvent[]) {
    const open = new Set<string>();
    const ended = new Set<string>();
    for (const event of events) {
        const id = (event as unknown as { messageId?: string }).messageId ?? '';
        if (event.type === EventType.REASONING_MESSAGE_START) {
            expect(open.has(id) || ended.has(id)).toBe(false);
            open.add(id);
        } else if (event.type === EventType.REASONING_MESSAGE_CONTENT) {
            expect(open.has(id)).toBe(true);
        } else if (event.type === EventType.REASONING_MESSAGE_END) {
            expect(open.delete(id)).toBe(true);
            ended.add(id);
        }
    }
    expect(open.size).toBe(0);
}

function expectFinished(events: BaseEvent[]) {
    expect(events.map((event) => event.type)).not.toContain(EventType.RUN_ERROR);
    expect(events.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(1);
    expectBalancedReasoning(events);
}

it('passes reasoning_content, then the answer', async () => {
    const { events } = await runTurn([
        {
            deltas: [
                { reasoning_content: 'The person ' },
                { reasoning_content: 'wants a greeting.' },
                { content: 'Hi.' },
            ],
            finish: 'stop',
        },
    ]);
    expectFinished(events);
    expect(reasoningText(events)).toBe('The person wants a greeting.');
    expect(answerText(events)).toBe('Hi.');
});

it('closes reasoning before a tool call, and reasons again in the next round', async () => {
    // The shape that failed every turn: thinking, then a tool call with no
    // content in between. The library closes the reasoning only when the
    // round's stream ends, after the call; CopilotKit's converter has closed
    // it at the call already and passed the late end on as a second one.
    const { events, requests } = await runTurn([
        { deltas: [{ reasoning_content: 'I should check the clock.' }, toolCall('call-1')], finish: 'tool_calls' },
        {
            deltas: [{ reasoning: 'Now I know the time.' }, { content: 'It is now.' }],
            finish: 'stop',
        },
    ]);
    expect(requests).toBe(2);
    expectFinished(events);
    expect(reasoningText(events)).toBe('I should check the clock.Now I know the time.');
    expect(answerText(events)).toBe('It is now.');
    // Each round's thinking is its own message, ended before what follows it.
    const types = events.map((event) => event.type);
    expect(types.indexOf(EventType.REASONING_MESSAGE_END)).toBeLessThan(types.indexOf(EventType.TOOL_CALL_START));
});

it('takes a closing </think> without an opening one as text', async () => {
    const { events } = await runTurn([
        { deltas: [{ content: 'thinking</think>' }, { content: 'Hi.' }], finish: 'stop' },
    ]);
    expectFinished(events);
    expect(answerText(events)).toBe('thinking</think>Hi.');
});

it('opens a new reasoning message for reasoning after the answer started', async () => {
    const { events } = await runTurn([
        {
            deltas: [
                { reasoning_content: 'First.' },
                { content: 'Hi' },
                { reasoning_content: 'Second.' },
                { content: ' there.' },
            ],
            finish: 'stop',
        },
    ]);
    expectFinished(events);
    expect(reasoningText(events)).toBe('First.Second.');
    expect(answerText(events)).toBe('Hi there.');
});

it('ignores empty reasoning, and reasoning after a tool call in the same round', async () => {
    const { events } = await runTurn([
        {
            deltas: [
                { reasoning_content: '' },
                { reasoning_content: 'Check.' },
                toolCall('call-1'),
                { reasoning_content: 'More.' },
                { reasoning_content: '' },
            ],
            finish: 'tool_calls',
        },
        { deltas: [{ reasoning_content: '' }, { content: 'Done.' }], finish: 'stop' },
    ]);
    expectFinished(events);
    expect(reasoningText(events)).toBe('Check.More.');
    expect(answerText(events)).toBe('Done.');
});
