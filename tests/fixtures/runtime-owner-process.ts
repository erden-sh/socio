// Disposable subprocess fixture: no provider endpoints, credentials or network work.
import { join, dirname } from 'node:path';

import { openDatabase, transactionSync } from '@socio/data/open';
import { RuntimeSession } from '@socio/data/runtime-ownership';

import { sqliteSchedules } from '../../src/server/schedules/services.js';
import { LocalAgentRunner } from '../helpers/runners.js';
import { Store, WorkspaceStore } from '../helpers/stores.js';
import { testAuth } from '../helpers/test-auth.js';
import { startWithTestPlatform } from '../helpers/test-platform.js';

import { ScriptAgent } from './script-agent.js';

// Loading the modules above takes seconds, and many times that on a busy
// machine: the test starts this process ahead and says which database to
// open when it needs the owner, so only what follows is part of the test.
process.send?.({ loaded: true });
const { path, heartbeat } = await new Promise<{ path: string; heartbeat: boolean }>((resolve) =>
    process.once('message', resolve as (message: unknown) => void),
);
const runtime = new RuntimeSession({
    leaseMs: 1500,
    heartbeatMs: 100,
    heartbeat,
});
const runner = new LocalAgentRunner(path, { runtime, flushIntervalMs: 5 });
const db = openDatabase(path);
const store = new Store(db);
const workspace = new WorkspaceStore(db);
// The server's layer graph over this process's connection and runner, as
// `makeTestRuntime` builds it (`startAppRuntime`, main.ts).
const { platform } = await startWithTestPlatform({
    db,
    store,
    workspace,
    config: {
        baseUrl: '',
        runtimeUrl: '',
        voiceName: 'marin',
        data: { userDataDir: join(dirname(path), 'userdata') },
    },
    runner,
    auth: testAuth(),
});
const schedules = sqliteSchedules(db, runtime);
const owner = runtime.attach(db);
transactionSync(db, 'fixture probe', () =>
    db.exec(
        'CREATE TABLE IF NOT EXISTS ownership_test_probe(n INTEGER NOT NULL); INSERT INTO ownership_test_probe SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM ownership_test_probe)',
    ),
);
const snapshot = (runId: string, jobId: string) => {
    const turn = db.prepare('SELECT status, events FROM agent_runs WHERE runId=?').get(runId);
    const job = db.prepare('SELECT status FROM job_runs WHERE id=?').get(jobId);
    const instance = db
        .prepare(
            "SELECT expiresAt, releasedAt FROM runtime_instances WHERE id=(SELECT ownerId FROM runtime_work WHERE kind='turn' AND id=?)",
        )
        .get(runId);
    return {
        turn: turn?.status ?? null,
        job: job?.status ?? null,
        partialPreserved: String(turn?.events ?? '').includes('partial answer'),
        userPreserved: String(turn?.events ?? '').includes('survive this'),
        recoveries: db.prepare('SELECT COUNT(*) n FROM runtime_recoveries').get()?.n,
        probe: db.prepare('SELECT n FROM ownership_test_probe').get()?.n,
        longRunCurrent:
            db.prepare("SELECT currentRunId FROM job_long_runs WHERE id='long-run-a'").get()?.currentRunId ?? null,
        claimedItems: db
            .prepare("SELECT COUNT(*) n FROM job_items WHERE longRunId='long-run-a' AND status='claimed'")
            .get()?.n,
        expiresAt: instance?.expiresAt,
        releasedAt: instance?.releasedAt,
    };
};
process.on(
    'message',
    (message: { id: number; action: string; runId?: string; jobId?: string; threadId?: string; kind?: string }) => {
        void (async () => {
            const runId = message.runId ?? 'run-a',
                jobId = message.jobId ?? 'job-run-a';
            switch (message.action) {
                case 'turn': {
                    const threadId = message.threadId ?? 'thread-a';
                    const messages = [
                        {
                            id: `user-${runId}`,
                            role: 'user' as const,
                            content: 'survive this',
                        },
                    ];
                    const agent = new ScriptAgent('partial answer', true);
                    agent.threadId = threadId;
                    agent.setMessages(messages);
                    try {
                        runner
                            .run({
                                threadId,
                                agent,
                                input: {
                                    threadId,
                                    runId,
                                    messages,
                                    state: {},
                                    tools: [],
                                    context: [],
                                    forwardedProps: {},
                                },
                            })
                            .subscribe({ error: () => {} });
                        return { accepted: true };
                    } catch {
                        return { accepted: false };
                    }
                }
                case 'job':
                    await schedules.uow.run(async () => {
                        owner.claim('job', jobId, 'job:shared-job', () => {});
                        await schedules.repos.jobRuns.insert({
                            id: jobId,
                            jobId: 'shared-job',
                            version: 1,
                            userId: 'alice',
                            dotId: 'dot-a',
                            trigger: 'manual',
                            scheduleId: null,
                            queuedAt: Date.now(),
                            longRunId: null,
                        });
                    });
                    await schedules.repos.longRuns.create({
                        id: 'long-run-a',
                        jobId: 'shared-job',
                        userId: 'alice',
                        dotId: 'dot-a',
                        trigger: 'manual',
                        scheduleId: null,
                        threadId: null,
                        createdAt: Date.now(),
                    });
                    await schedules.repos.longRuns.update(
                        'long-run-a',
                        { status: 'running', currentRunId: jobId },
                        Date.now(),
                    );
                    await schedules.repos.longRuns.addItems('long-run-a', ['item-a'], Date.now());
                    await schedules.repos.longRuns.claim('long-run-a', jobId, 1, Date.now());
                    return { claimed: true };
                case 'drain':
                    platform.drain();
                    return { draining: true };
                case 'snapshot':
                    return snapshot(runId, jobId);
                case 'recover':
                    runner.recoverOrphans();
                    await platform.jobs.recoverOrphans();
                    return snapshot(runId, jobId);
                case 'write': {
                    const lease = db
                        .prepare('SELECT resource, ownerId, epoch FROM runtime_work WHERE kind=? AND id=?')
                        .get(message.kind ?? 'turn', runId) as unknown as {
                        resource: string;
                        ownerId: string;
                        epoch: number;
                    };
                    const result = owner.guarded(lease, () => {
                        db.prepare('UPDATE ownership_test_probe SET n=n+1').run();
                        db.prepare("UPDATE agent_runs SET status='finished' WHERE runId=?").run(runId);
                    });
                    return { owned: result.owned };
                }
                case 'release':
                    await runtime.detach(db);
                    runner.close();
                    db.close();
                    return { released: true };
                default:
                    throw Error('Unknown fixture operation');
            }
        })().then(
            (result) => process.send?.({ id: message.id, result }),
            (error) =>
                process.send?.({
                    id: message.id,
                    error: error instanceof Error ? error.message : 'Fixture failed',
                }),
        );
    },
);
await platform.jobs.recoverOrphans();
process.send?.({ ready: true });
