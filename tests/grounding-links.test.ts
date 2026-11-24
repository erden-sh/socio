import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { Message } from '@ag-ui/client';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { runRefRecorder } from '@socio/foundation/runs/run-refs';
import type { RunRef } from '@socio/shared/runs/run-refs';
import type { User } from '@socio/shared/types';

import { recallTool } from '../src/server/context/recall.js';
import { serverModules } from '../src/server/modules/index.js';

import { completion } from './fixtures/model-stream.js';
import { staticAuth } from './fixtures/static-auth.js';
import { DotAgent } from './helpers/dot-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-194: what grounds a turn is recorded as it reads (pages, search
// results, the chat's page, datasets, recalls: references only), dataset
// audit rows keep their chat, and an item filed from a run is linked to
// it, for its person or an admin only. The Operations answers built on
// them are tests/operations-grounding.test.ts.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const carol: User = { id: 'carol', name: 'Carol', role: 'admin' };
const bob: User = { id: 'bob', name: 'Bob', role: 'member' };
const alice: User = { id: 'alice', name: 'Alice', role: 'member' };

async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'cb194-'));
    cleanup.push(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    const runner = new LocalAgentRunner(testDatabase());
    const config = {
        apiKey: 'fixture',
        model: 'custom-model',
        baseUrl: 'https://unused.invalid/v1',
        runtimeUrl: '',
        voiceName: 'marin',
        data: { userDataDir: dir },
    };
    const { store, workspace, platform, makeApp, dispose } = await makeTestRuntime({
        config,
        runner,
        modules: serverModules,
    });
    cleanup.push(dispose);
    for (const user of [carol, bob, alice]) {
        workspace.db
            .prepare('INSERT OR IGNORE INTO users (id, name, role, createdAt, lastSeenAt) VALUES (?, ?, ?, 1, 1)')
            .run(user.id, user.name, user.role);
    }
    const dot = workspace.dots()[0]!;
    workspace.bindThread('t-bob', dot.id, 'Numbers', 'bob');
    workspace.bindThread('t-alice', dot.id, 'Plans', 'alice');
    const runs = (runner as unknown as { db: DatabaseSync }).db;
    for (const [threadId, runId] of [
        ['t-bob', 'run-bob'],
        ['t-alice', 'run-alice'],
    ]) {
        runs.prepare(
            "INSERT INTO agent_runs(threadId, runId, status, events, startedAt, finishedAt, errorDetail) VALUES (?, ?, 'failed', '[]', 1000, 2000, 'boom')",
        ).run(threadId, runId);
    }
    const apps = new Map<string, ReturnType<typeof makeApp>>();
    const as = (user: User) => {
        let app = apps.get(user.id);
        if (!app) {
            app = makeApp({ config: { mode: 'live', baseUrl: '' }, auth: staticAuth(user) });
            apps.set(user.id, app);
        }
        return (path: string, init?: RequestInit) => app.request(`/api${path}`, init);
    };
    const post = (user: User, body: unknown) =>
        as(user)('/issues', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    const links = () =>
        workspace.db
            .prepare(
                'SELECT r.runId, r.threadId, r.via, r.linkedBy, i.number FROM issue_runs r JOIN issues i ON i.id = r.issueId ORDER BY i.number',
            )
            .all()
            .map((row) => ({ ...row }));
    const refs = (runId?: string) =>
        runs
            .prepare(
                `SELECT runId, threadId, kind, spaceId, refId FROM run_refs${runId ? ' WHERE runId = ?' : ''} ORDER BY id`,
            )
            .all(...(runId ? [runId] : []))
            .map((row) => ({ ...row }));
    return {
        dir,
        config,
        store,
        workspace,
        runner,
        runs,
        platform,
        dot,
        as,
        post,
        links,
        refs,
    };
}

const call = (name: string, args: unknown, id = name) =>
    completion(
        {
            role: 'assistant',
            tool_calls: [
                {
                    index: 0,
                    id,
                    type: 'function',
                    function: { name, arguments: JSON.stringify(args) },
                },
            ],
        },
        'tool_calls',
    );

it('records what a turn read: the pages a search showed, a page read, the chat’s page and a dataset queried', async () => {
    const f = await fixture();
    const page = await f.workspace.pages.create(
        f.dot.spaceId,
        {
            title: 'Pricing policy',
            content: 'Discounts for partners.',
            parentId: null,
        },
        null,
        'bob',
    );
    // The chat is about the page: its note grounds every turn.
    f.workspace.db
        .prepare('INSERT INTO page_threads (pageId, dotId, userId, threadId, ready) VALUES (?, ?, ?, ?, 1)')
        .run(page.id, f.dot.id, 'bob', 't-bob');
    vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(call('search_space_pages', { query: 'discounts' }))
        .mockResolvedValueOnce(call('read_space_page', { id: page.id }))
        .mockResolvedValueOnce(call('data_query', { sql: 'SELECT 1 AS one' }))
        .mockResolvedValueOnce(completion({ role: 'assistant', content: 'Done.' }));
    const agent = new DotAgent(f.store, f.workspace, f.config, f.dot.id, false, undefined, {
        extensions: f.platform.dotExtensions,
    });
    const input: RunAgentInput = {
        threadId: 't-bob',
        runId: 'run-grounded',
        state: {},
        context: [],
        messages: [{ id: 'user', role: 'user', content: 'What discounts?' }],
        tools: [],
        forwardedProps: {},
    };
    const events = await lastValueFrom(agent.run(input).pipe(toArray()));
    const results = events.filter((event) => event.type === EventType.TOOL_CALL_RESULT) as unknown as {
        toolCallId: string;
        content: string;
    }[];
    const query = JSON.parse(results.find((result) => result.toolCallId === 'data_query')!.content) as Record<
        string,
        unknown
    >;
    // The model sees what it saw before: no dataset id was added.
    expect(query.rows).toEqual([[1]]);
    expect(query).not.toHaveProperty('datasetId');
    // Sebas is a company socio: its scratch is its shared dataset (CB-337).
    const scratch = f.platform.data
        .visible({ kind: 'dot', userId: 'bob', dotId: f.dot.id }, false)
        .find((item) => item.scratch)!.row;
    const recorded = f.refs('run-grounded');
    expect(recorded).toEqual(
        expect.arrayContaining([
            {
                runId: 'run-grounded',
                threadId: 't-bob',
                kind: 'search',
                spaceId: page.spaceId,
                refId: page.id,
            },
            {
                runId: 'run-grounded',
                threadId: 't-bob',
                kind: 'page',
                spaceId: page.spaceId,
                refId: page.id,
            },
            {
                runId: 'run-grounded',
                threadId: 't-bob',
                kind: 'context',
                spaceId: page.spaceId,
                refId: page.id,
            },
            {
                runId: 'run-grounded',
                threadId: 't-bob',
                kind: 'dataset',
                spaceId: null,
                refId: scratch.id,
            },
        ]),
    );
    // Ids only: no page text, query or rows.
    expect(JSON.stringify(recorded)).not.toMatch(/Discounts|SELECT/);
    // The dataset audit keeps the chat the socio's tool acted in.
    expect(
        f.workspace.db
            .prepare("SELECT threadId FROM data_audit WHERE action = 'query'")
            .all()
            .map((row) => row.threadId),
    ).toEqual(['t-bob']);
});

it('keeps each reference once per turn, skips ones it can’t keep, and never fails the read', async () => {
    const f = await fixture();
    const record = runRefRecorder(f.runs, 'run-x', 't-bob', () => 5);
    const page: RunRef = { kind: 'page', spaceId: 's1', refId: 'p1' };
    record(page);
    record([page, { kind: 'search', spaceId: 's1', refId: 'p1' }]);
    record({ kind: 'page', spaceId: 's1', refId: 'x'.repeat(201) });
    record({ kind: 'nonsense' as RunRef['kind'], spaceId: null, refId: 'p2' });
    expect(f.refs('run-x').map((ref) => ref.kind)).toEqual(['page', 'search']);
    // A connection without the table (an older or a test database).
    const bare = new WorkspaceStore(testDatabase());
    cleanup.push(() => bare.close());
    expect(() => runRefRecorder(bare.db, 'run-y', 't')(page)).not.toThrow();
});

it('records a recall by ref, and not a recall search', async () => {
    const recorded: RunRef[] = [];
    const messages: Message[] = [{ id: 'm1', role: 'user', content: 'The launch is on Friday.' }];
    const tool = recallTool(
        {
            threadId: 't-bob',
            check: () => {},
            ref: (refs) => recorded.push(...(Array.isArray(refs) ? refs : [refs])),
        },
        async () => messages,
    );
    const run = (args: object) => (tool as unknown as { execute: (input: object) => Promise<unknown> }).execute(args);
    await run({ query: 'launch' });
    expect(recorded).toEqual([]);
    await run({ ref: 'message:m1' });
    await run({ ref: 'message:nope' });
    expect(recorded).toEqual([{ kind: 'recall', spaceId: null, refId: 'message:m1' }]);
});

it('links an item filed from a run to it, for the run’s person or an admin only', async () => {
    const f = await fixture();
    const fields = { title: 'Run failed: boom', body: 'It failed.' };
    // Bob files about his own failed run: linked as a report.
    const own = await f.post(bob, { ...fields, runId: 'run-bob' });
    expect(own.status).toBe(201);
    // Not someone else's run, nor one that isn't there: nothing is filed.
    for (const runId of ['run-alice', 'run-none', 'bad id', 7]) {
        const refused = await f.post(bob, { ...fields, runId });
        expect(refused.status, String(runId)).toBe(404);
    }
    // Fields are checked as before.
    expect((await f.post(bob, { runId: 'run-bob' })).status).toBe(400);
    // An admin may file about anyone's run (Runs shows them every run).
    expect((await f.post(carol, { ...fields, runId: 'run-alice' })).status).toBe(201);
    // Filed without a run: no link.
    expect((await f.post(alice, fields)).status).toBe(201);
    expect(f.links()).toEqual([
        {
            runId: 'run-bob',
            threadId: 't-bob',
            via: 'report',
            linkedBy: 'bob',
            number: expect.any(Number),
        },
        {
            runId: 'run-alice',
            threadId: 't-alice',
            via: 'report',
            linkedBy: 'carol',
            number: expect.any(Number),
        },
    ]);
    expect(f.workspace.db.prepare('SELECT count(*) AS n FROM issues').get()).toEqual({ n: 3 });
});

it('answers grounding to admins only, and logs who opened a chat’s', async () => {
    const f = await fixture();
    for (const path of ['/operations/knowledge/grounding', '/operations/chats/t-bob/grounding']) {
        expect((await f.as(bob)(path)).status, path).toBe(403);
    }
    const heatmap = await f.as(carol)('/operations/knowledge/grounding?range=7d');
    expect(heatmap.status).toBe(200);
    // No analytics in this fixture: no numbers, never zeros.
    expect(await heatmap.json()).toMatchObject({ grounding: null });
    const chat = await f.as(carol)('/operations/chats/t-bob/grounding?via=overview');
    expect(chat.status).toBe(200);
    expect(await chat.json()).toBeNull();
    expect((await f.as(carol)('/operations/chats/nope/grounding')).status).toBe(404);
    const logged = f.workspace.db
        .prepare(
            "SELECT viewerId, surface, subjectKind, subjectId, content FROM access_log WHERE surface = 'chat-grounding'",
        )
        .all()
        .map((row) => ({ ...row }));
    expect(logged).toEqual([
        {
            viewerId: 'carol',
            surface: 'chat-grounding',
            subjectKind: 'chat',
            subjectId: 't-bob',
            content: 0,
        },
    ]);
});

it('links a socio’s filing to the turn it filed in', async () => {
    const f = await fixture();
    const filed = await f.platform.board.filings.file(
        {
            dotId: f.dot.id,
            userId: 'bob',
            trigger: 'chat',
            causeId: null,
            threadId: 't-bob',
            runId: 'run-bob',
        },
        {
            title: 'Calendar sync',
            kind: 'feature',
            problem: 'Meetings are typed in twice.',
        },
    );
    expect(filed.outcome).toBe('filed');
    // Without a run (an older caller), nothing is linked.
    await f.platform.board.filings.file(
        {
            dotId: f.dot.id,
            userId: 'bob',
            trigger: 'chat',
            causeId: null,
            threadId: 't-bob',
        },
        {
            title: 'Export to CSV',
            kind: 'feature',
            problem: 'Numbers are copied by hand.',
            fileAnyway: true,
        },
    );
    expect(f.links()).toEqual([
        {
            runId: 'run-bob',
            threadId: 't-bob',
            via: 'socio',
            linkedBy: `dot:${f.dot.id}`,
            number: expect.any(Number),
        },
    ]);
});
