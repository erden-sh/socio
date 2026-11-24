import { AbstractAgent, EventType, type BaseEvent, type Message, type RunAgentInput } from '@ag-ui/client';
import { lastValueFrom, Observable } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import type { AgentRunSource } from '@socio/shared/types';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { turnLogLine } from '../src/server/turns/local-runner.js';

import { ScriptAgent } from './fixtures/script-agent.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const SECRET = 'private-plan-for-the-merger';

/** Streams part of an answer, then fails like a provider error. */
class FailingAgent extends AbstractAgent {
    run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable<BaseEvent>((subscriber) => {
            subscriber.next({
                type: EventType.RUN_STARTED,
                threadId: input.threadId,
                runId: input.runId,
            } as BaseEvent);
            subscriber.next({
                type: EventType.TEXT_MESSAGE_START,
                messageId: `answer-${input.runId}`,
                role: 'assistant',
            } as BaseEvent);
            subscriber.next({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: `answer-${input.runId}`,
                delta: `Half an answer about ${SECRET}`,
            } as BaseEvent);
            subscriber.next({
                type: EventType.RUN_ERROR,
                message: 'Provider returned HTTP 500: upstream overloaded',
                code: 'PROVIDER_ERROR',
                errorDetail: '500 upstream overloaded (operator detail)',
            } as BaseEvent);
            subscriber.complete();
        });
    }
}

async function fixture() {
    // No model URL: finished runs are not sent off to be titled.
    const { workspace, platform, app, dispose } = await makeTestRuntime({
        config: { apiKey: '', model: '' },
        app: {
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return (path: string) => app.request(`/api${path}`, { headers: { cookie } });
    };
    const dot = workspace.dots()[0];
    workspace.bindThread('alice-thread', dot.id, 'Alice’s notes', 'alice');
    workspace.bindThread('bob-thread', dot.id, 'Bob’s report', 'bob');
    // Users appear in the directory once they have signed in.
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    const turn = async (agent: AbstractAgent, threadId: string, runId: string, source?: AgentRunSource) => {
        const messages: Message[] = [{ id: `u-${runId}`, role: 'user', content: `Tell me the ${SECRET}` }];
        agent.threadId = threadId;
        agent.setMessages(messages);
        await lastValueFrom(
            platform.runner.run({
                threadId,
                agent,
                source,
                input: {
                    threadId,
                    runId,
                    messages,
                    state: {},
                    tools: [],
                    context: [],
                    forwardedProps: {},
                },
            }),
        ).catch(() => undefined);
    };
    return { as, dot, turn };
}

it('lists recent turns across users for admins, with the error of failed ones', async () => {
    const f = await fixture();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await f.turn(new ScriptAgent('Done'), 'alice-thread', 'run-1');
    await f.turn(new ScriptAgent('Daily'), 'bob-thread', 'run-2', 'scheduled');
    await f.turn(new FailingAgent({}), 'bob-thread', 'run-3');

    const alice = await f.as('alice');
    const response = await alice('/runs');
    expect(response.status).toBe(200);
    const body = await response.text();
    const { runs, limit } = JSON.parse(body);
    expect(limit).toBe(200);
    expect(runs.map((run: { runId: string }) => run.runId)).toEqual(['run-3', 'run-2', 'run-1']);
    expect(runs[0]).toMatchObject({
        threadId: 'bob-thread',
        status: 'failed',
        source: 'web',
        error: 'Provider returned HTTP 500: upstream overloaded',
        errorDetail: '500 upstream overloaded (operator detail)',
        title: 'Bob’s report',
        dotName: f.dot.name,
        ownerId: 'bob',
        ownerName: 'Bob',
        // An admin sees the row, but cannot open another user's conversation.
        readable: false,
    });
    expect(runs[0].finishedAt).toBeGreaterThanOrEqual(runs[0].startedAt);
    expect(runs[1]).toMatchObject({
        status: 'finished',
        source: 'scheduled',
        error: null,
        errorDetail: null,
    });
    expect(runs[2]).toMatchObject({
        ownerId: 'alice',
        ownerName: 'Alice',
        readable: true,
    });
    // Metadata and error text only: no messages, answers or event payloads.
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('Done');
    expect(body).not.toContain('events');

    const failed = await (await alice('/runs?status=failed')).json();
    expect(failed.runs.map((run: { runId: string }) => run.runId)).toEqual(['run-3']);
    expect((await alice('/runs?status=broken')).status).toBe(400);
});

it('lists only a member’s own turns, without the operator’s detail', async () => {
    const f = await fixture();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await f.turn(new FailingAgent({}), 'bob-thread', 'run-1');
    await f.turn(new ScriptAgent('Done'), 'alice-thread', 'run-2');
    const bob = await f.as('bob');
    const response = await bob('/runs');
    expect(response.status).toBe(200);
    const body = await response.text();
    const { runs } = JSON.parse(body);
    expect(runs).toEqual([
        expect.objectContaining({
            runId: 'run-1',
            ownerId: 'bob',
            readable: true,
            error: 'Provider returned HTTP 500: upstream overloaded',
            errorDetail: null,
            trace: { reason: 'error', rounds: 0 },
        }),
    ]);
    expect(body).not.toContain('operator detail');
    expect(body).not.toContain('alice-thread');
});

it('logs one line per finished turn, without content', async () => {
    const f = await fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await f.turn(new FailingAgent({}), 'bob-thread', 'run-fail');
    await f.turn(new ScriptAgent('Done'), 'alice-thread', 'run-ok', 'scheduled');
    const lines = log.mock.calls.map((call) => call.join(' '));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
        /^Turn: failed run=run-fail thread=bob-thread user=bob source=web ms=\d+ cycle=[\w-]+ hop=0 reason=error rounds=0 error=PROVIDER_ERROR$/,
    );
    // Each a step of its work cycle (CB-211).
    expect(lines[1]).toMatch(
        /^Turn: finished run=run-ok thread=alice-thread user=alice source=scheduled ms=\d+ cycle=[\w-]+ hop=0 reason=completed rounds=0$/,
    );
    for (const line of lines) {
        expect(line).not.toContain(SECRET);
        expect(line).not.toContain('Provider returned');
    }
});

it('keeps the turn log line to one line of safe tokens', () => {
    expect(
        turnLogLine({
            status: 'failed',
            runId: 'run\nTurn: finished fake',
            threadId: 't 1',
            source: 'telegram',
            ms: 1234.4,
            error: 'run_error',
        }),
    ).toBe('Turn: failed run=run_Turn:_finished_fake thread=t_1 user=unknown source=telegram ms=1234 error=run_error');
});

it('lists only the latest runs asked for (the page loader’s first screen)', async () => {
    const f = await fixture();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await f.turn(new ScriptAgent('One'), 'alice-thread', 'run-1');
    await f.turn(new ScriptAgent('Two'), 'bob-thread', 'run-2');
    await f.turn(new ScriptAgent('Three'), 'bob-thread', 'run-3');
    const alice = await f.as('alice');
    const first = await (await alice('/runs?limit=2')).json();
    expect(first.limit).toBe(2);
    expect(first.runs.map((run: { runId: string }) => run.runId)).toEqual(['run-3', 'run-2']);
    expect((await (await alice('/runs')).json()).limit).toBe(200);
    for (const limit of ['0', '201', 'many']) {
        expect((await alice(`/runs?limit=${limit}`)).status, limit).toBe(400);
    }
});

it('shows a turn’s trace to admins and to its owner, and no one else (CB-128)', async () => {
    const f = await fixture();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await f.turn(new ScriptAgent('Done'), 'alice-thread', 'alice-run');
    await f.turn(new FailingAgent({}), 'bob-thread', 'bob-run');
    const alice = await f.as('alice');
    const bob = await f.as('bob');
    // The owner reads their own; an admin reads anyone's.
    for (const [who, runId] of [
        [bob, 'bob-run'],
        [alice, 'bob-run'],
        [alice, 'alice-run'],
    ] as const) {
        const response = await who(`/runs/${runId}/trace`);
        expect(response.status, runId).toBe(200);
        const view = await response.json();
        expect(view).toMatchObject({ runId, trace: { rounds: [], tools: [] } });
        expect(JSON.stringify(view)).not.toContain(SECRET);
    }
    expect((await (await bob('/runs/bob-run/trace')).json()).trace.end).toMatchObject({
        reason: 'error',
        inferred: true,
    });
    // A member can't read another person's turn, nor tell that it exists.
    const other = await bob('/runs/alice-run/trace');
    expect(other.status).toBe(404);
    expect(await other.text()).not.toContain('alice');
    expect((await bob('/runs/missing/trace')).status).toBe(404);
});
