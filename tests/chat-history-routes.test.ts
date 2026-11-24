import type { DatabaseSync } from 'node:sqlite';

import { EventType, type BaseEvent, type Message } from '@ag-ui/client';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it } from 'vitest';

import { teamOwner } from '@socio/foundation/telegram/team-owner';
import {
    HISTORY_AFTER_HEADER,
    HISTORY_PAGE_RUNS,
    LIGHT_RESULT_CHARS,
    type HistoryPage,
} from '@socio/shared/chat/chat-history';
import { pageReviewTool } from '@socio/shared/pages/page-review';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { longChatRuns } from './fixtures/long-chat.js';
import { ScriptAgent } from './fixtures/script-agent.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-136: the history a chat syncs into the browser's store. Its runs by
// sequence number (newest page first, then what came after, or older
// pages), long tool results as previews with the whole one on request,
// and only for the conversation's owner, as its connection is.
const SECRET = 'chat-history-secret-0123456789abcdef';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture() {
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: { baseUrl: 'https://model.invalid/v1', apiKey: 'unused', model: 'qwen-test', runtimeUrl: '' },
        app: {
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, SECRET),
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
    const as = (cookie: string) => (path: string) => app.request(`/api${path}`, { headers: { cookie } });
    const dot = workspace.dots()[0];
    const db = (platform.runner as unknown as { db: DatabaseSync }).db;
    const insert = (threadId: string, runId: string, events: BaseEvent[], status = 'finished', at = 1) =>
        db
            .prepare(
                'INSERT INTO agent_runs(threadId, runId, status, events, startedAt, finishedAt) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run(threadId, runId, status, JSON.stringify(events), at, at + 1);
    workspace.bindThread('long', dot.id, 'Pipeline review', 'alice');
    for (const run of longChatRuns({ threadId: 'long' })) {
        insert('long', run.runId, run.events, 'finished', run.startedAt);
    }
    return {
        alice: as(await signIn('alice')),
        bob: as(await signIn('bob')),
        platform,
        workspace,
        dot,
        insert,
    };
}

const page = async (response: Response) => {
    expect(response.status).toBe(200);
    return (await response.json()) as HistoryPage;
};
const text = (turn: number) => `user-${turn}`;
const ids = (history: HistoryPage) => history.runs.flatMap((run) => run.messages.map((message) => message.id));

it('pages a long chat from its newest turns, then older ones, chained without gaps', async () => {
    const f = await fixture();
    const newest = await page(await f.alice('/conversations/long/history'));
    // The newest turns, up to a page or about 300 KB of previews.
    expect(newest.runs.length).toBeGreaterThan(0);
    expect(newest.runs.length).toBeLessThanOrEqual(HISTORY_PAGE_RUNS);
    expect(newest.runs.at(-1)!.runId).toBe('run-31');
    expect(ids(newest)).toContain(text(31));
    expect(newest.more).toBe(false);
    // Each run names the one before it.
    for (const [index, run] of newest.runs.entries()) {
        if (index) {
            expect(run.prev).toBe(newest.runs[index - 1].seq);
        }
    }
    const first = newest.runs[0];
    expect(first.prev).not.toBeNull();
    // Older: the page that ends where this one starts.
    const older = await page(await f.alice(`/conversations/long/history?before=${first.seq}`));
    expect(older.runs.at(-1)!.seq).toBe(first.prev);
    // Paging back to the start, the first run has none before it.
    let oldest = older.runs[0];
    while (oldest.prev !== null) {
        const next = await page(await f.alice(`/conversations/long/history?before=${oldest.seq}`));
        expect(next.runs.at(-1)!.seq).toBe(oldest.prev);
        oldest = next.runs[0];
    }
    expect(oldest.runId).toBe('run-0');
    // Its whole transcript, run by run, is the conversation's.
    const all: Message[] = [];
    let before: number | undefined;
    for (;;) {
        const part = await page(await f.alice(`/conversations/long/history${before ? `?before=${before}` : ''}`));
        all.unshift(...part.runs.flatMap((run) => run.messages));
        if (part.runs[0].prev === null) {
            break;
        }
        before = part.runs[0].seq;
    }
    expect(all.map((message) => message.id)).toEqual(
        (await f.platform.runner.messages('long')).map((message) => message.id),
    );
});

it('sends only what came after a cursor, and says when it is more than a page', async () => {
    const f = await fixture();
    const newest = await page(await f.alice('/conversations/long/history'));
    const cursor = newest.runs.at(-1)!.seq;
    expect((await page(await f.alice(`/conversations/long/history?after=${cursor}`))).runs).toEqual([]);
    // Two turns later (and one still running, which is never history).
    f.insert('long', 'run-32', longChatRuns({ threadId: 'long', turns: 33 })[32].events);
    f.insert('long', 'run-33', longChatRuns({ threadId: 'long', turns: 34 })[33].events);
    f.insert('long', 'run-34', [], 'running');
    const after = await page(await f.alice(`/conversations/long/history?after=${cursor}`));
    expect(after.runs.map((run) => run.runId)).toEqual(['run-32', 'run-33']);
    expect(after.runs[0].prev).toBe(cursor);
    expect(after.more).toBe(false);
    // From the start: more than a page after it.
    const far = await page(await f.alice('/conversations/long/history?after=0'));
    expect(far.runs[0].runId).toBe('run-0');
    expect(far.more).toBe(true);
    // Nonsense cursors are refused.
    for (const query of ['after=-1', 'before=x', 'after=1&before=2']) {
        expect((await f.alice(`/conversations/long/history?${query}`)).status, query).toBe(400);
    }
});

it('sends long tool results as previews and the whole result on request', async () => {
    const f = await fixture();
    const newest = await page(await f.alice('/conversations/long/history'));
    const big = newest.runs.find((run) => run.runId === 'run-31')!;
    const result = big.messages.find(
        (message) => message.role === 'tool' && message.toolCallId === 'call-31-0',
    ) as Message & { content: string };
    // The preview keeps the short fields a step's line and outcome read.
    expect(big.light['call-31-0']).toBeGreaterThan(200_000);
    expect(result.content.length).toBeLessThan(LIGHT_RESULT_CHARS);
    expect(JSON.parse(result.content)).toEqual({
        status: 'ok',
        title: 'Opportunities, batch 32',
    });
    // A page of previews is far smaller than the stored events.
    expect(JSON.stringify(newest).length).toBeLessThan(400_000);
    const full = await f.alice('/conversations/long/tool-results/call-31-0');
    expect(full.status).toBe(200);
    const { content } = (await full.json()) as { content: string };
    expect(content.length).toBe(big.light['call-31-0']);
    expect(JSON.parse(content).rows.length).toBeGreaterThan(1000);
    expect((await f.alice('/conversations/long/tool-results/call-none')).status).toBe(404);
});

it('keeps the results cards read whole: approvals and page reviews', async () => {
    const f = await fixture();
    f.workspace.bindThread('cards', f.dot.id, 'Cards', 'alice');
    const pending = {
        status: 'pending_approval',
        approval: { id: 'approval-1', title: 'Send the report' },
        padding: 'x'.repeat(LIGHT_RESULT_CHARS),
    };
    const review = { approved: true, note: 'y'.repeat(LIGHT_RESULT_CHARS) };
    f.insert('cards', 'cards-1', [
        {
            type: EventType.RUN_STARTED,
            threadId: 'cards',
            runId: 'cards-1',
            input: { messages: [{ id: 'u1', role: 'user', content: 'Go' }] },
        },
        {
            type: EventType.TOOL_CALL_START,
            toolCallId: 'call-review',
            toolCallName: pageReviewTool.name,
            parentMessageId: 'a1',
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call-review', delta: '{}' },
        { type: EventType.TOOL_CALL_END, toolCallId: 'call-review' },
        {
            type: EventType.TOOL_CALL_RESULT,
            messageId: 'r-review',
            toolCallId: 'call-review',
            content: JSON.stringify(review),
        },
        {
            type: EventType.TOOL_CALL_START,
            toolCallId: 'call-approval',
            toolCallName: 'send_report',
            parentMessageId: 'a1',
        },
        { type: EventType.TOOL_CALL_END, toolCallId: 'call-approval' },
        {
            type: EventType.TOOL_CALL_RESULT,
            messageId: 'r-approval',
            toolCallId: 'call-approval',
            content: JSON.stringify(pending),
        },
        { type: EventType.RUN_FINISHED, threadId: 'cards', runId: 'cards-1' },
    ] as BaseEvent[]);
    const { runs } = await page(await f.alice('/conversations/cards/history'));
    expect(runs[0].light).toEqual({});
    const results = runs[0].messages.filter((message) => message.role === 'tool');
    expect(results.map((message) => JSON.parse(String(message.content)))).toEqual([review, pending]);
});

it('serves a chat’s history to its owner only, as its connection', async () => {
    const f = await fixture();
    // bob is a member: alice's chat is missing for him, as is a team topic.
    for (const path of [
        '/conversations/long/history',
        '/conversations/long/history?after=0',
        '/conversations/long/tool-results/call-31-0',
    ]) {
        expect((await f.bob(path)).status, path).toBe(404);
    }
    f.workspace.bindThread('topic', f.dot.id, 'Team plans', teamOwner('chat-1'));
    expect((await f.alice('/conversations/topic/history')).status).toBe(404);
    expect((await f.alice('/conversations/missing/history')).status).toBe(404);
    // A deleted chat goes with it.
    f.workspace.bindThread('gone', f.dot.id, 'Gone', 'alice');
    await f.platform.deleteConversation('gone', 'alice');
    expect((await f.alice('/conversations/gone/history')).status).toBe(404);
});

it('replays only the runs after the chat’s cursor on connect, then the live one', async () => {
    const f = await fixture();
    const runner = f.platform.runner;
    const newest = await page(await f.alice('/conversations/long/history'));
    const last = newest.runs.at(-1)!;
    const connect = (headers?: Record<string, string>) =>
        lastValueFrom(runner.connect({ threadId: 'long', headers }).pipe(toArray()));
    const started = (events: BaseEvent[]) => events.filter((event) => event.type === EventType.RUN_STARTED).length;
    // As before without it: the whole conversation.
    expect(started(await connect())).toBe(32);
    // From the run before the newest: the newest only.
    const tail = await connect({ [HISTORY_AFTER_HEADER]: String(last.prev) });
    expect(started(tail)).toBe(1);
    expect(tail[0]).toMatchObject({
        type: EventType.RUN_STARTED,
        runId: 'run-31',
    });
    // A header that isn't a sequence number is ignored.
    expect(started(await connect({ [HISTORY_AFTER_HEADER]: 'all' }))).toBe(32);
    // A run in progress streams after the replay.
    const agent = new ScriptAgent('live', true);
    agent.threadId = 'long';
    runner
        .run({
            threadId: 'long',
            agent,
            input: {
                threadId: 'long',
                runId: 'live',
                messages: [{ id: 'u-live', role: 'user', content: 'And now?' }],
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
            },
        })
        .subscribe();
    const live = connect({ 'X-CB-History-After': String(last.seq) });
    agent.abortRun();
    const events = await live;
    expect(started(events)).toBe(1);
    expect(events[0]).toMatchObject({ runId: 'live' });
});

it('gives the model the whole stored conversation when the chat sends only its newest turns', async () => {
    const f = await fixture();
    const runner = f.platform.runner;
    const stored = await runner.messages('long');
    let seen: Message[] = [];
    const agent = new ScriptAgent('ok');
    const run = agent.run.bind(agent);
    agent.run = (input) => {
        seen = input.messages;
        return run(input);
    };
    agent.threadId = 'long';
    // The chat's agent holds the newest turn (whole) and the new message.
    const newestTurn = stored.slice(stored.findIndex((message) => message.id === 'user-31'));
    const message: Message = { id: 'u-new', role: 'user', content: 'Thanks' };
    await lastValueFrom(
        runner.run({
            threadId: 'long',
            agent,
            input: {
                threadId: 'long',
                runId: 'r-new',
                messages: [...newestTurn, message],
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
            },
        }),
    );
    expect(seen.map((shown) => shown.id)).toEqual([...stored.map((shown) => shown.id), 'u-new']);
    // Whole results, as stored, never a preview.
    expect(seen.find((shown) => shown.role === 'tool' && shown.toolCallId === 'call-31-0')?.content).toBe(
        stored.find((shown) => shown.role === 'tool' && shown.toolCallId === 'call-31-0')?.content,
    );
    // The run stores only what it brought.
    const first = runner.runEvents('r-new')[0] as BaseEvent & {
        input: { messages: Message[] };
    };
    expect(first.input.messages.map((shown) => shown.id)).toEqual(['u-new']);
});

it('serves stopped runs stored before CB-108, and runs that went on past their error', async () => {
    const f = await fixture();
    f.workspace.bindThread('old', f.dot.id, 'Old', 'alice');
    const turn = (runId: string, n: number, end: Record<string, unknown>[]) =>
        [
            {
                type: EventType.RUN_STARTED,
                threadId: 'old',
                runId,
                input: { messages: [{ id: `u${n}`, role: 'user', content: `Q${n}` }] },
            },
            {
                type: EventType.TEXT_MESSAGE_START,
                messageId: `a${n}`,
                role: 'assistant',
            },
            {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: `a${n}`,
                delta: `A${n}`,
            },
            { type: EventType.TEXT_MESSAGE_END, messageId: `a${n}` },
            ...end,
        ] as BaseEvent[];
    // A stop as finalizeRunEvents left it: a RUN_FINISHED without ids.
    f.insert('old', 'old-1', turn('old-1', 1, [{ type: EventType.RUN_FINISHED }]), 'stopped');
    f.insert(
        'old',
        'old-2',
        turn('old-2', 2, [
            { type: EventType.RUN_ERROR, message: 'The model failed.' },
            {
                type: EventType.TEXT_MESSAGE_START,
                messageId: 'late',
                role: 'assistant',
            },
            {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: 'late',
                delta: 'Late',
            },
            { type: EventType.TEXT_MESSAGE_END, messageId: 'late' },
        ]),
        'failed',
    );
    f.insert('old', 'old-3', turn('old-3', 3, [{ type: EventType.RUN_FINISHED, threadId: 'old', runId: 'old-3' }]));
    const history = await page(await f.alice('/conversations/old/history'));
    expect(history.runs.map((run) => run.status)).toEqual(['stopped', 'failed', 'finished']);
    expect(ids(history)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
});
