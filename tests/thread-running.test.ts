import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/client';
import { lastValueFrom, Observable, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { THREAD_RUNNING_CODE, THREAD_RUNNING_MESSAGE, threadRunning } from '@socio/shared/chat/thread-running';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { LocalAgentRunner } from './helpers/runners.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-357: a run sent while the conversation's turn runs is refused with a
// stable code, before anything is stored.
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** Streams the start of an answer and finishes when `release` is called. */
class GatedAgent extends AbstractAgent {
    release?: () => void;
    run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable<BaseEvent>((subscriber) => {
            const id = `answer-${input.runId}`;
            subscriber.next({
                type: EventType.RUN_STARTED,
                threadId: input.threadId,
                runId: input.runId,
            } as BaseEvent);
            subscriber.next({
                type: EventType.TEXT_MESSAGE_START,
                messageId: id,
                role: 'assistant',
            } as BaseEvent);
            this.release = () => {
                subscriber.next({
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: id,
                    delta: 'Finished after the signal.',
                } as BaseEvent);
                subscriber.next({
                    type: EventType.TEXT_MESSAGE_END,
                    messageId: id,
                } as BaseEvent);
                subscriber.next({
                    type: EventType.RUN_FINISHED,
                    threadId: input.threadId,
                    runId: input.runId,
                } as BaseEvent);
                subscriber.complete();
            };
        });
    }
}

async function fixture() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Titles ask the model after a turn; it is never reached.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const runner = new LocalAgentRunner(testDatabase(), { flushIntervalMs: 5 });
    const { platform, workspace, app, dispose } = await makeTestRuntime({
        config: {
            baseUrl: 'https://model.invalid/v1',
            apiKey: 'unused',
            model: 'qwen-test',
        },
        runner,
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    const dot = workspace.dots()[0];
    return { platform, workspace, runner, dot, app };
}

const input = (threadId: string, runId: string) => ({
    threadId,
    runId,
    messages: [{ id: `user-${runId}`, role: 'user' as const, content: 'Hi' }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
});

it('refuses a run while the turn runs with 409 thread_running, storing nothing', async () => {
    const f = await fixture();
    const thread = await f.platform.createConversation(f.dot.id, 'Chat', 'owner');
    const agent = new GatedAgent({});
    const events = lastValueFrom(
        f.runner.run({ threadId: thread.id, agent, input: input(thread.id, 'r1') }).pipe(toArray()),
    );
    await vi.waitFor(() => expect(agent.release).toBeTypeOf('function'));
    const post = (runId: string) =>
        f.platform.handle(
            new Request(`http://localhost/api/copilotkit/agent/${f.dot.id}/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input(thread.id, runId)),
            }),
            'owner',
        );
    const refused = await post('r2');
    expect(refused.status).toBe(409);
    // The text is unchanged; the code is what clients match.
    expect(await refused.json()).toEqual({ error: THREAD_RUNNING_MESSAGE, code: THREAD_RUNNING_CODE });
    agent.release!();
    expect((await events).at(-1)?.type).toBe(EventType.RUN_FINISHED);
    // Only the running turn's run, and none of the refused one's message.
    expect(f.runner.recentRuns().map((run) => run.runId)).toEqual(['r1']);
    expect(f.runner.knownMessageIds(thread.id).has('user-r2')).toBe(false);
    await f.platform.titles.idle();
});

it('reads the refusal from its code, its payload’s or a cause’s, never its text', () => {
    expect(threadRunning({ code: 'thread_running' })).toBe(true);
    expect(threadRunning({ status: 409, payload: { error: 'x', code: 'thread_running' } })).toBe(true);
    expect(threadRunning(new Error('wrapped', { cause: { code: 'thread_running' } }))).toBe(true);
    expect(threadRunning(new Error(THREAD_RUNNING_MESSAGE))).toBe(false);
    expect(threadRunning({ payload: { error: THREAD_RUNNING_MESSAGE } })).toBe(false);
    expect(threadRunning(undefined)).toBe(false);
    expect(threadRunning('thread_running')).toBe(false);
});
