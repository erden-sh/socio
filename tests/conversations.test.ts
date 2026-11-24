import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventType, type BaseEvent, type Message } from '@ag-ui/client';
import { Context } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { pageReviewTool } from '@socio/shared/pages/page-review';

import { ConversationAdmin } from '../src/server/composition/app/conversations.js';

import { completion } from './fixtures/model-stream.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { testDatabaseFile } from './helpers/test-database.js';
import type { TestPlatform } from './helpers/test-platform.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// End to end through the CopilotKit runtime (SSE mode) and the local runner.
// Only the model's HTTP endpoint is mocked.
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

function databasePath() {
    const dir = mkdtempSync(join(tmpdir(), 'company-brain-conversations-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return testDatabaseFile(join(dir, 'brain.sqlite'));
}
async function open(path: string) {
    // One connection for both stores, as in production (CB-110); the
    // runner's over the same file.
    const { platform, workspace, edge, dispose } = await makeTestRuntime({
        database: path,
        config: {
            baseUrl: 'https://model.invalid/v1',
            apiKey: 'unused',
            model: 'qwen-test',
        },
        runner: new LocalAgentRunner(path, { flushIntervalMs: 5 }),
    });
    cleanup.push(dispose);
    return { platform, workspace, edge, dot: workspace.dots()[0], close: dispose };
}
const input = (threadId: string, runId: string, messages: Message[], tools: unknown[] = []) => ({
    threadId,
    runId,
    messages,
    tools,
    context: [],
    state: {},
    forwardedProps: {},
});
async function post(
    platform: TestPlatform,
    path: string,
    body: unknown,
): Promise<{ status: number; events: BaseEvent[] }> {
    const response = await platform.handle(
        new Request(`http://localhost/api/copilotkit/${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
        'owner',
    );
    const text = await response.text();
    const events = text
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)) as BaseEvent);
    return { status: response.status, events };
}
const textOf = (events: BaseEvent[]) =>
    events
        .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT || event.type === EventType.TEXT_MESSAGE_CHUNK)
        .map((event) => (event as { delta?: string }).delta ?? '')
        .join('');
/**
 * Mocks the model endpoint: title requests (identified by their system
 * prompt) get a JSON reply; agent requests take the queued responses in order.
 */
function mockModel(...queue: Array<Response | ((init?: RequestInit) => Promise<Response>)>) {
    const agentCalls: RequestInit[] = [];
    const titleCalls: RequestInit[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        if (String(init?.body).includes('Write a short title')) {
            titleCalls.push(init!);
            return Response.json({
                choices: [{ message: { content: '"Generated Title."' } }],
            });
        }
        agentCalls.push(init!);
        const next = queue.shift();
        if (!next) {
            throw new Error('Unexpected model request');
        }
        return typeof next === 'function' ? next(init) : next;
    });
    return { agentCalls, titleCalls };
}
const user = (id: string, content: string): Message => ({
    id,
    role: 'user',
    content,
});

it('keeps a conversation across a server restart and replays it on connect', async () => {
    const path = databasePath();
    const first = await open(path);
    const thread = await first.platform.createConversation(first.dot.id, 'Memory', 'owner');
    const model = mockModel(completion({ role: 'assistant', content: 'Stored answer' }));
    const run = await post(
        first.platform,
        `agent/${first.dot.id}/run`,
        input(thread.id, 'run-1', [user('u1', 'Remember this')]),
    );
    expect(run.status).toBe(200);
    expect(textOf(run.events)).toBe('Stored answer');
    // The first successful run names the conversation, once.
    await first.platform.titles.idle();
    expect(model.titleCalls).toHaveLength(1);
    expect((await first.workspace.conversations('owner')).find((t) => t.id === thread.id)?.title).toBe(
        'Generated Title',
    );
    await first.close();

    const second = await open(path);
    const replay = await post(second.platform, `agent/${second.dot.id}/connect`, input(thread.id, 'connect-1', []));
    expect(replay.status).toBe(200);
    expect(textOf(replay.events)).toBe('Stored answer');
    expect(await second.platform.history(thread.id)).toBe('user: Remember this\nassistant: Stored answer');
});

it('stores scheduled turns in the thread so the browser sees them', async () => {
    const { platform, dot } = await open(databasePath());
    const thread = await platform.createConversation(dot.id, 'Scheduled', 'owner');
    mockModel(completion({ role: 'assistant', content: 'Daily summary ready' }));
    expect(await platform.turn(thread.id, 'Summarise today', new AbortController().signal)).toBe('Daily summary ready');
    const replay = await post(platform, `agent/${dot.id}/connect`, input(thread.id, 'connect-1', []));
    expect(textOf(replay.events)).toBe('Daily summary ready');
});

it('continues after a human approval delivered as a frontend tool result', async () => {
    const { platform, dot } = await open(databasePath());
    const thread = await platform.createConversation(dot.id, 'Review', 'owner');
    const model = mockModel(
        completion(
            {
                role: 'assistant',
                tool_calls: [
                    {
                        index: 0,
                        id: 'review-1',
                        type: 'function',
                        function: {
                            name: pageReviewTool.name,
                            arguments: JSON.stringify({ title: 'Plan', content: '# Plan' }),
                        },
                    },
                ],
            },
            'tool_calls',
        ),
        completion({ role: 'assistant', content: 'Saved after approval.' }),
    );
    const first = await post(
        platform,
        `agent/${dot.id}/run`,
        input(thread.id, 'run-1', [user('u1', 'Draft a plan')], [pageReviewTool]),
    );
    expect(first.events).toEqual(
        expect.arrayContaining([
            expect.objectContaining({
                type: EventType.TOOL_CALL_START,
                toolCallName: pageReviewTool.name,
            }),
        ]),
    );
    // The browser renders the review card; on approval it sends the tool result.
    const history = await platform.runner.messages(thread.id);
    const second = await post(
        platform,
        `agent/${dot.id}/run`,
        input(
            thread.id,
            'run-2',
            [
                ...history,
                {
                    id: 'tool-result',
                    role: 'tool',
                    toolCallId: 'review-1',
                    content: JSON.stringify({ approved: true }),
                } as Message,
            ],
            [pageReviewTool],
        ),
    );
    expect(textOf(second.events)).toBe('Saved after approval.');
    const continuation = JSON.parse(String(model.agentCalls[1].body));
    expect(continuation.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: 'tool', tool_call_id: 'review-1' })]),
    );
});

it('keeps two review drafts from one turn whole, live and after a reload (CB-81)', async () => {
    const path = databasePath();
    const first = await open(path);
    const thread = await first.platform.createConversation(first.dot.id, 'Two drafts', 'owner');
    const drafts = {
        'review-a': { title: 'First', content: '# One' },
        'review-b': {
            title: 'Second',
            content: '# Two',
            spaceId: first.dot.spaceId,
        },
    };
    mockModel(
        completion(
            {
                role: 'assistant',
                tool_calls: Object.entries(drafts).map(([id, args], index) => ({
                    index,
                    id,
                    type: 'function',
                    function: {
                        name: pageReviewTool.name,
                        arguments: JSON.stringify(args),
                    },
                })),
            },
            'tool_calls',
        ),
    );
    const run = await post(
        first.platform,
        `agent/${first.dot.id}/run`,
        input(thread.id, 'run-1', [user('u1', 'Draft two pages')], [pageReviewTool]),
    );
    const argsOf = (events: BaseEvent[], id: string) =>
        events
            .filter(
                (event) =>
                    event.type === EventType.TOOL_CALL_ARGS && (event as { toolCallId?: string }).toolCallId === id,
            )
            .map((event) => (event as { delta?: string }).delta ?? '')
            .join('');
    for (const [id, args] of Object.entries(drafts)) {
        expect(JSON.parse(argsOf(run.events, id))).toEqual(args);
    }
    await first.close();
    // A reload replays both calls with their whole drafts and no results, so
    // the browser asks for each review again.
    const second = await open(path);
    const replay = await post(second.platform, `agent/${second.dot.id}/connect`, input(thread.id, 'connect-1', []));
    for (const [id, args] of Object.entries(drafts)) {
        expect(JSON.parse(argsOf(replay.events, id))).toEqual(args);
    }
    expect(replay.events.some((event) => event.type === EventType.TOOL_CALL_RESULT)).toBe(false);
    const history = await second.platform.runner.messages(thread.id);
    expect(
        history.flatMap((message) =>
            message.role === 'assistant'
                ? (message.toolCalls ?? []).map((call) => [call.id, JSON.parse(call.function.arguments)])
                : [],
        ),
    ).toEqual(Object.entries(drafts));
    expect(history.some((message) => message.role === 'tool')).toBe(false);
});

it('stops a running turn through the runtime stop route', async () => {
    const { platform, dot } = await open(databasePath());
    const thread = await platform.createConversation(dot.id, 'Long', 'owner');
    const model = mockModel(
        (init) =>
            new Promise<Response>((_resolve, reject) =>
                init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
            ),
    );
    const running = post(platform, `agent/${dot.id}/run`, input(thread.id, 'run-1', [user('u1', 'Take your time')]));
    for (let i = 0; i < 100 && !platform.runner.activeRunId(thread.id); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const stopped = await platform.handle(
        new Request(`http://localhost/api/copilotkit/agent/${dot.id}/stop/${thread.id}`, { method: 'POST' }),
        'owner',
    );
    expect(stopped.status).toBe(200);
    await running;
    // Exactly one terminal event, so the thread still replays cleanly.
    expect(platform.runner.events(thread.id).filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(1);
    expect(await platform.runner.isRunning({ threadId: thread.id })).toBe(false);
    // Stopped runs do not name the conversation.
    await platform.titles.idle();
    expect(model.titleCalls).toHaveLength(0);
    // The user's message survives the stop.
    expect((await platform.runner.messages(thread.id)).map((m) => m.content)).toContain('Take your time');
});

it('deletes a conversation only once it is idle, keeping its stored history (CB-64)', async () => {
    const { platform, workspace, dot } = await open(databasePath());
    const thread = await platform.createConversation(dot.id, 'Heron', 'owner');
    let release!: () => void;
    mockModel(
        () =>
            new Promise<Response>((resolve) => {
                release = () => resolve(completion({ role: 'assistant', content: 'heron' }));
            }),
    );
    const running = post(platform, `agent/${dot.id}/run`, input(thread.id, 'run-1', [user('u1', 'Reply with heron')]));
    for (let i = 0; i < 100 && !platform.runner.activeRunId(thread.id); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await expect(platform.deleteConversation(thread.id, 'owner')).rejects.toThrow('Stop the current run');
    expect(workspace.thread(thread.id)).toBeDefined();
    for (let i = 0; i < 100 && !release; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    release();
    await running;
    await platform.titles.idle();
    expect(platform.runner.hasHistory(thread.id)).toBe(true);
    await expect(platform.deleteConversation(thread.id, 'someone')).rejects.toThrow();
    await platform.deleteConversation(thread.id, 'owner');
    expect(workspace.thread(thread.id)).toBeUndefined();
    expect(await workspace.conversations('owner')).toEqual([]);
    // Hidden, not lost: the row and its history are still stored.
    expect(platform.runner.hasHistory(thread.id)).toBe(true);
    expect(workspace.withDeletedThread(thread.id)).toMatchObject({
        dotId: dot.id,
        deletedBy: 'owner',
        deletedAt: expect.any(Number),
    });
    expect(workspace.auditOf('conversation', thread.id)).toMatchObject([{ actor: 'owner', action: 'delete' }]);
    // Its runtime refuses it like a missing conversation.
    expect((await post(platform, `agent/${dot.id}/run`, input(thread.id, 'run-2', [user('u2', 'Again')]))).status).toBe(
        403,
    );
    await expect(platform.deleteConversation(thread.id, 'owner')).rejects.toThrow();
});

it('hides a conversation and stamps its tasks in one unit of work: a failure leaves all of them live (soft delete 16.3b, CB-110)', async () => {
    const { platform, workspace, dot } = await open(databasePath());
    const store = platform.store;
    const thread = await platform.createConversation(dot.id, 'Herons', 'owner');
    const tasks = [];
    for (const prompt of ['Count herons', 'Watch herons']) {
        const task = await store.createTask(prompt, 3600, 'owner');
        await workspace.bindTask(task.id, thread.id);
        tasks.push(task);
    }
    // The conversation's own stamp fails, after the tasks were stamped.
    const deleteThread = vi.spyOn(workspace, 'deleteThread').mockImplementationOnce(() => {
        throw new Error('disk I/O error');
    });
    await expect(platform.deleteConversation(thread.id, 'owner')).rejects.toThrow('disk I/O error');
    // Rolled back together: the conversation and its tasks are live.
    expect(workspace.thread(thread.id)).toBeDefined();
    expect(workspace.withDeletedThread(thread.id)?.deletedAt).toBeNull();
    for (const task of tasks) {
        expect(await store.task(task.id)).toBeDefined();
        expect((await store.withDeletedTask(task.id))?.deletedAt).toBeNull();
    }
    expect(workspace.auditOf('conversation', thread.id)).toEqual([]);

    // Deleting it again takes all of it, and the audit counts both tasks.
    deleteThread.mockRestore();
    await platform.deleteConversation(thread.id, 'owner');
    expect(workspace.thread(thread.id)).toBeUndefined();
    for (const task of tasks) {
        expect(await store.task(task.id)).toBeUndefined();
        expect(await store.withDeletedTask(task.id)).toMatchObject({
            deletedBy: 'owner',
            deletedWith: `conversation:${thread.id}`,
        });
    }
    expect(await store.claim(Date.now() + 10 * 3600_000)).toBeNull();
    expect(workspace.auditOf('conversation', thread.id)).toMatchObject([
        { actor: 'owner', action: 'delete', detail: 'with 2 scheduled tasks' },
    ]);
});

it('leaves the conversation and every task live when stamping a task fails', async () => {
    const { platform, workspace, dot } = await open(databasePath());
    const store = platform.store;
    const thread = await platform.createConversation(dot.id, 'Herons', 'owner');
    const task = await store.createTask('Count herons', 3600, 'owner');
    await workspace.bindTask(task.id, thread.id);
    vi.spyOn(store.scheduled, 'deleteTask').mockImplementationOnce(() => {
        throw new Error('disk I/O error');
    });
    await expect(platform.deleteConversation(thread.id, 'owner')).rejects.toThrow('disk I/O error');
    expect(workspace.thread(thread.id)).toBeDefined();
    expect(await store.task(task.id)).toBeDefined();
});

it('rolls back the stamps already made when a later task stamp fails, through ConversationAdmin', async () => {
    const { platform, workspace, dot, edge } = await open(databasePath());
    const admin = Context.get(edge.services, ConversationAdmin);
    const store = platform.store;
    const thread = await admin.create(dot.id, 'Herons', 'owner');
    const tasks = [];
    for (const prompt of ['Count herons', 'Watch herons']) {
        const task = await store.createTask(prompt, 3600, 'owner');
        await workspace.bindTask(task.id, thread.id);
        tasks.push(task);
    }
    // The first task is stamped, then the second one's stamp fails.
    const stamp = store.scheduled.deleteTask.bind(store.scheduled);
    const deleteTask = vi.spyOn(store.scheduled, 'deleteTask');
    deleteTask.mockImplementationOnce(stamp).mockImplementationOnce(() => {
        throw new Error('disk I/O error');
    });
    const hide = vi.spyOn(workspace, 'deleteThread');
    // `Platform` delegates to the one service the graph built.
    await expect(platform.deleteConversation(thread.id, 'owner')).rejects.toThrow('disk I/O error');
    expect(deleteTask).toHaveBeenCalledTimes(2);
    expect(hide).not.toHaveBeenCalled();
    // One unit: the first stamp is undone, and the conversation was never hidden.
    expect(workspace.thread(thread.id)).toBeDefined();
    for (const task of tasks) {
        expect((await store.withDeletedTask(task.id))?.deletedAt).toBeNull();
    }
    expect(workspace.auditOf('conversation', thread.id)).toEqual([]);
    expect(await admin.deletion(thread.id, 'owner')).toEqual({ scheduledTasks: 2, blocked: null });
});

it('stamps the conversation and its audit line in one transaction', async () => {
    const { platform, workspace, dot } = await open(databasePath());
    const thread = await platform.createConversation(dot.id, 'Herons', 'owner');
    vi.spyOn(workspace, 'audit').mockImplementationOnce(() => {
        throw new Error('disk I/O error');
    });
    await expect(platform.deleteConversation(thread.id, 'owner')).rejects.toThrow('disk I/O error');
    // Rolled back: still live, so deleting it again is clean.
    expect(workspace.thread(thread.id)).toBeDefined();
    await platform.deleteConversation(thread.id, 'owner');
    expect(workspace.thread(thread.id)).toBeUndefined();
    expect(workspace.auditOf('conversation', thread.id)).toHaveLength(1);
});

it('refuses runs on threads that are not bound to the Dot', async () => {
    const { platform, dot } = await open(databasePath());
    const run = await post(platform, `agent/${dot.id}/run`, input('not-a-thread', 'run-1', [user('u1', 'hi')]));
    expect(run.status).toBe(403);
});
