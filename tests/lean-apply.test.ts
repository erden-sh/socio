import { AbstractAgent, EventType, type BaseEvent, type Message, type RunAgentInput } from '@ag-ui/client';
import { Observable } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { runAgentLean } from '../src/server/turns/lean-apply.js';

// CB-318: a server-side run hands every event to the runner's onEvent, in
// order, without deep-copying the thread's history on each one (which
// blocked the live app's main thread for over a minute on a long thread).

class Scripted extends AbstractAgent {
    constructor(private script: BaseEvent[]) {
        super({});
    }
    run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable((subscriber) => {
            subscriber.next({
                type: EventType.RUN_STARTED,
                threadId: input.threadId,
                runId: input.runId,
            } as BaseEvent);
            for (const event of this.script) {
                subscriber.next(event);
            }
            subscriber.next({
                type: EventType.RUN_FINISHED,
                threadId: input.threadId,
                runId: input.runId,
            } as BaseEvent);
            subscriber.complete();
        });
    }
}

const deltas = (count: number): BaseEvent[] =>
    [
        { type: EventType.TEXT_MESSAGE_START, messageId: 'a1', role: 'assistant' },
        ...Array.from({ length: count }, (_, at) => ({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: 'a1',
            delta: `w${at} `,
        })),
        { type: EventType.TEXT_MESSAGE_END, messageId: 'a1' },
    ] as BaseEvent[];

/** A long thread: 400 messages of about 2 KB each. */
const history = (): Message[] =>
    Array.from({ length: 400 }, (_, at) => ({
        id: `m${at}`,
        role: at % 2 ? 'assistant' : 'user',
        content: 'x'.repeat(2000),
    })) as Message[];

afterEach(() => vi.restoreAllMocks());

it('passes every event to onEvent in order and leaves the messages alone', async () => {
    const agent = new Scripted(deltas(3));
    agent.threadId = 't1';
    agent.setMessages(history());
    const before = agent.messages;
    const seen: string[] = [];
    await runAgentLean(
        agent,
        { runId: 'r1' },
        {
            onEvent: ({ event }) => {
                seen.push(event.type + ('delta' in event ? `:${(event as unknown as { delta: string }).delta}` : ''));
            },
        },
    );
    expect(seen).toEqual([
        'RUN_STARTED',
        'TEXT_MESSAGE_START',
        'TEXT_MESSAGE_CONTENT:w0 ',
        'TEXT_MESSAGE_CONTENT:w1 ',
        'TEXT_MESSAGE_CONTENT:w2 ',
        'TEXT_MESSAGE_END',
        'RUN_FINISHED',
    ]);
    // The runner reads stored events, not the agent's list: unchanged.
    expect(agent.messages).toBe(before);
    expect(agent.messages).toHaveLength(400);
});

it('copies the history a fixed number of times, not once per event', async () => {
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const run = async (events: number) => {
        clone.mockClear();
        const agent = new Scripted(deltas(events));
        agent.threadId = 't1';
        agent.setMessages(history());
        await runAgentLean(agent, { runId: `r${events}` }, { onEvent: () => {} });
        return clone.mock.calls.length;
    };
    // The same few copies (the run's input) for 10 deltas and for 500.
    expect(await run(500)).toBe(await run(10));
});

it('the default applier, for contrast, rebuilds the agent’s messages', async () => {
    // Before AG-UI 1.0 it also deep-copied the history on every event; since
    // 1.0 its copies are a fixed number too, but it still keeps the messages.
    const agent = new Scripted(deltas(200));
    agent.threadId = 't1';
    agent.setMessages(history());
    await agent.runAgent({ runId: 'r-default' }, { onEvent: () => {} });
    expect(agent.messages).toHaveLength(401);
});

it('puts the agent’s own apply back after the run, also when it fails', async () => {
    const agent = new Scripted([]);
    agent.threadId = 't1';
    const own = (agent as unknown as { apply: unknown }).apply;
    await runAgentLean(agent, { runId: 'ok' }, {});
    expect((agent as unknown as { apply: unknown }).apply).toBe(own);
    expect(Object.prototype.hasOwnProperty.call(agent, 'apply')).toBe(false);
    vi.spyOn(agent, 'runAgent').mockRejectedValueOnce(new Error('boom'));
    await expect(runAgentLean(agent, { runId: 'fail' }, {})).rejects.toThrow('boom');
    expect(Object.prototype.hasOwnProperty.call(agent, 'apply')).toBe(false);
});
