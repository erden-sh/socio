// The workspace's views behind a tag: `WorkspaceViews`, which the root
// provides, answers as the same views over the platform's members (as live/'s
// copies, since deleted, read them), and `ChatHistory` reads the runner's
// turns.
import type { DatabaseSync } from 'node:sqlite';

import { EventType, type BaseEvent } from '@ag-ui/client';
import { Context } from 'effect';
import { afterEach, expect, it } from 'vitest';

import type { User } from '@socio/shared/types';

import { issuesModule } from '../src/server/issues/module.js';
import { ChatHistory, WorkspaceViews } from '../src/server/workspace/contract.js';

import { testWorkspaceViews } from './helpers/page-views.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testAuth } from './helpers/test-auth.js';
import { testDatabase } from './helpers/test-database.js';
import { startWithTestPlatform } from './helpers/test-platform.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const ADMIN: User = { id: 'alice', name: 'Alice', role: 'admin' };
const MEMBER: User = { id: 'bob', name: 'Bob', role: 'member' };

async function root() {
    const ws = new WorkspaceStore(testDatabase());
    cleanup.push(() => ws.close());
    const store = new Store(testDatabase());
    cleanup.push(() => store.close());
    const runner = new LocalAgentRunner(testDatabase());
    const { runtime, platform } = await startWithTestPlatform({
        db: ws.db,
        store,
        workspace: ws,
        config: {
            baseUrl: '',
            apiKey: '',
            model: '',
            voiceName: 'marin',
            runtimeUrl: '',
            appOrigin: 'https://app.example.invalid',
        },
        runner,
        auth: testAuth(),
        modules: [issuesModule],
        log: () => {},
    });
    cleanup.push(() => platform.stop());
    cleanup.push(() => runtime.dispose());
    return { ws, platform, runner, context: await runtime.context() };
}

it('WorkspaceViews answers as the views over the platform’s members', async () => {
    const { ws, platform, context } = await root();
    ws.recordUser(ADMIN);
    ws.recordUser(MEMBER);
    const space = ws.createSpace('Ops', 'Operations');
    const dot = ws.createDot(space.id, 'Ana', 'Answers questions.', true, true);
    await platform.createConversation(dot.id, 'Hello', MEMBER.id);
    const views = Context.get(context, WorkspaceViews);
    const plain = testWorkspaceViews(platform);
    for (const user of [ADMIN, MEMBER]) {
        expect(await views.workspaceView(user)).toEqual(await plain.workspaceView(user));
        expect(await views.workspaceVersion(user)).toBe(await plain.workspaceVersion(user));
        expect(views.dotForViewer(user.id, dot)).toEqual(plain.dotForViewer(user.id, dot));
    }
});

it('ChatHistory pages the turns stored in the runner the root was given', async () => {
    const { ws, runner, context } = await root();
    ws.recordUser(MEMBER);
    const space = ws.createSpace('Ops', 'Operations');
    const dot = ws.createDot(space.id, 'Ana', 'Answers questions.', true, true);
    ws.bindThread('chat', dot.id, 'Hello', MEMBER.id);
    const db = (runner as unknown as { db: DatabaseSync }).db;
    const turn = (n: number) =>
        [
            {
                type: EventType.RUN_STARTED,
                threadId: 'chat',
                runId: `run-${n}`,
                input: { messages: [{ id: `u${n}`, role: 'user', content: `Q${n}` }] },
            },
            { type: EventType.TEXT_MESSAGE_START, messageId: `a${n}`, role: 'assistant' },
            { type: EventType.TEXT_MESSAGE_CONTENT, messageId: `a${n}`, delta: `A${n}` },
            { type: EventType.TEXT_MESSAGE_END, messageId: `a${n}` },
            { type: EventType.RUN_FINISHED, threadId: 'chat', runId: `run-${n}` },
        ] as BaseEvent[];
    for (const n of [1, 2, 3]) {
        db.prepare(
            'INSERT INTO agent_runs(threadId, runId, status, events, startedAt, finishedAt) VALUES (?, ?, ?, ?, ?, ?)',
        ).run('chat', `run-${n}`, 'finished', JSON.stringify(turn(n)), n * 10, n * 10 + 1);
    }
    const history = Context.get(context, ChatHistory);
    const newest = await history.historyPage('chat', {});
    expect(newest.runs.map((run) => run.runId)).toEqual(['run-1', 'run-2', 'run-3']);
    expect(newest.runs.map((run) => run.messages.map((message) => message.id))).toEqual([
        ['u1', 'a1'],
        ['u2', 'a2'],
        ['u3', 'a3'],
    ]);
    expect(newest.runs.map((run) => run.prev)).toEqual([null, newest.runs[0].seq, newest.runs[1].seq]);
    const [first, second, third] = newest.runs;
    // After a run: only the ones after it.
    const after = await history.historyPage('chat', { after: first.seq });
    expect(after.runs.map((run) => run.runId)).toEqual(['run-2', 'run-3']);
    expect(after.more).toBe(false);
    // Before a run: only the ones before it.
    const before = await history.historyPage('chat', { before: third.seq });
    expect(before.runs.map((run) => run.runId)).toEqual(['run-1', 'run-2']);
    expect(before.runs[1].seq).toBe(second.seq);
    // Another chat has nothing.
    expect((await history.historyPage('other', {})).runs).toEqual([]);
});
