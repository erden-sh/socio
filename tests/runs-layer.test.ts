// Runs' tags are layers over the tags of what they read (`runs/layer.ts`), the
// run views answer as the plain views over the platform do, and in the
// server's graph `RunsViews` reads the platform's own runner, workspace and
// run sources.
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { LegacyWorkspace } from '../src/server/composition/base.js';
import { runsLayers } from '../src/server/composition/runs.js';
import { Access } from '../src/server/rooms/contract.js';
import { RunRefs, RunsViews } from '../src/server/runs/contract.js';
import { sqliteRunRefs } from '../src/server/runs/infra/sqlite/run-refs.js';
import { RunsHost, RunsLive } from '../src/server/runs/layer.js';
import { runsView as plainRunsView, runTraceView as plainRunTraceView } from '../src/server/runs/views.js';
import { Runner } from '../src/server/turns/contract.js';
import { WorkspaceLive } from '../src/server/workspace/layer.js';

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
    vi.restoreAllMocks();
});

const config = { baseUrl: '', apiKey: '', model: '', voiceName: 'marin', runtimeUrl: '' };

/** A workspace with an admin and a member, the member's chat, and two of its turns. */
function seeded() {
    const workspace = new WorkspaceStore(testDatabase());
    const runner = new LocalAgentRunner(testDatabase());
    cleanup.push(() => workspace.close());
    workspace.recordUser({ id: 'carol', name: 'Carol', role: 'admin' });
    workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    const dot = workspace.dots()[0]!;
    workspace.bindThread('t-bob', dot.id, 'Quarterly numbers', 'bob');
    const db = (runner as unknown as { db: DatabaseSync }).db;
    const insert = db.prepare(
        'INSERT INTO agent_runs(threadId, runId, status, events, startedAt, finishedAt) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run('t-bob', 'run-1', 'finished', '[]', 1, 2);
    insert.run('t-bob', 'run-2', 'failed', '[]', 3, 4);
    return { workspace, runner };
}

const runSource = async (threadId: string, recorded?: string | null) => (recorded ?? `web:${threadId}`) as never;

it('declares RunsViews under socio/runs', () => {
    expect(RunsViews.key).toBe('socio/runs/RunsViews');
});

it('offers RunRefs and RunsViews over the tags they read, answering as live’s views', async () => {
    const { workspace, runner } = seeded();
    const layer = RunsLive.pipe(
        Layer.provide(
            Layer.mergeAll(
                WorkspaceLive(workspace),
                Layer.succeed(Access, workspace.roomAccess),
                Layer.succeed(Runner, runner),
                Layer.succeed(RunsHost, { runSource }),
            ),
        ),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    expect(Context.get(context, RunRefs)).toBe(sqliteRunRefs);
    const views = Context.get(context, RunsViews);
    const platform = { runner, workspace, runSource };

    for (const [viewer, own] of [
        ['carol', false],
        ['bob', true],
        ['carol', true],
    ] as const) {
        for (const status of [undefined, 'failed'] as const) {
            const options = { status, limit: 10, own };
            expect(await views.runsView(viewer, options)).toEqual(await plainRunsView(platform, viewer, options));
        }
    }
    const listed = await views.runsView('carol', { limit: 10 });
    expect(listed.runs.map((run) => [run.runId, run.source, run.ownerName])).toEqual([
        ['run-2', 'web:t-bob', 'Bob'],
        ['run-1', 'web:t-bob', 'Bob'],
    ]);

    for (const viewer of [
        { id: 'carol', admin: true },
        { id: 'bob', admin: false },
        { id: 'alice', admin: false },
    ]) {
        for (const runId of ['run-1', 'missing']) {
            expect(views.runTraceView(viewer, runId)).toEqual(plainRunTraceView(platform, viewer, runId));
        }
    }
    expect(views.runTraceView({ id: 'bob', admin: false }, 'run-1')).toMatchObject({
        view: { runId: 'run-1', status: 'finished' },
        ownerId: 'bob',
    });
    expect(views.runTraceView({ id: 'alice', admin: false }, 'run-1')).toBeNull();
});

it("builds the graph's step with each run's source from the workspace's links (runSourceOf)", async () => {
    const { workspace, runner } = seeded();
    const links = vi.spyOn(workspace.telegram, 'threadInfo');
    const layer = runsLayers.bridges.pipe(
        Layer.provide(
            Layer.mergeAll(
                WorkspaceLive(workspace),
                Layer.succeed(Access, workspace.roomAccess),
                Layer.succeed(Runner, runner),
                Layer.succeed(LegacyWorkspace, workspace),
            ),
        ),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    expect(Context.get(context, RunRefs)).toBe(sqliteRunRefs);
    const { runs } = await Context.get(context, RunsViews).runsView('carol', { limit: 1 });
    // No Telegram link: the conversation's channel is the web.
    expect(runs.map((run) => run.source)).toEqual(['web']);
    expect(links).toHaveBeenCalledWith('t-bob');
});

it('in the server’s graph, RunsViews reads the platform’s runner, workspace and run sources', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = testDatabase();
    const workspace = new WorkspaceStore(db);
    const store = new Store(db);
    const runner = new LocalAgentRunner(testDatabase());
    const { runtime, platform } = await startWithTestPlatform({
        db,
        store,
        workspace,
        config,
        runner,
        auth: testAuth(),
    });
    cleanup.push(async () => {
        await platform.stop();
        await runtime.dispose();
        store.close();
        workspace.close();
    });
    workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    workspace.bindThread('t-bob', workspace.dots()[0]!.id, 'Quarterly numbers', 'bob');
    (runner as unknown as { db: DatabaseSync }).db
        .prepare(
            "INSERT INTO agent_runs(threadId, runId, status, events, startedAt, finishedAt) VALUES ('t-bob', 'run-1', 'finished', '[]', 1, 2)",
        )
        .run();
    const context = await runtime.context();
    expect(Context.get(context, RunRefs)).toBe(sqliteRunRefs);
    const views = Context.get(context, RunsViews);
    const listed = await views.runsView('bob', { limit: 5, own: true });
    expect(listed).toEqual(await plainRunsView(platform, 'bob', { limit: 5, own: true }));
    expect(listed.runs.map((run) => [run.runId, run.source])).toEqual([['run-1', 'web']]);
    expect(views.runTraceView({ id: 'bob', admin: false }, 'run-1')).toEqual(
        plainRunTraceView(platform, { id: 'bob', admin: false }, 'run-1'),
    );
});
