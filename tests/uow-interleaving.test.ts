import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import { sqliteData, transaction, transactionSync } from '@socio/data/open';
import { RuntimeSession } from '@socio/data/runtime-ownership';
import { SqliteUnitOfWork, UnitOfWorkError } from '@socio/data/uow';

import type { ApprovalService } from '../src/server/approvals/service.js';
import type { ComputerService } from '../src/server/computers/computer-service.js';
import type { DataSpace } from '../src/server/dataspace/space.js';
import { fakeByoKind } from '../src/server/inference/fake-byo.js';
import { InferenceService } from '../src/server/inference/service.js';
import { JobService } from '../src/server/schedules/jobs.js';
import { sqliteSchedules } from '../src/server/schedules/services.js';

import { boardOf } from './helpers/board.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

/*
 * CB-110 review: a unit of work awaits, so other async work that is ready
 * in the same turn of the event loop (parallel tool calls in one model
 * step, a Promise.all) runs while it is open, on the same connection. Its
 * legacy writes must queue behind the unit, never join it or fail.
 */

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);

/** The server's shape: the core store and the workspace on one connection. */
function app() {
    const connection = testDatabase();
    const store = new Store(connection);
    const workspace = new WorkspaceStore(connection);
    cleanup.push(() => {
        store.close();
        workspace.close();
        connection.close();
    });
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    return { connection, store, workspace };
}

const hops = async (n: number) => {
    for (let i = 0; i < n; i++) {
        await Promise.resolve();
    }
};

it('queues a profile save and a core store write behind an issue being filed, however they interleave', async () => {
    const { connection, store, workspace } = app();
    // The reviewer's repro: the save started 2 to 26 microtask hops after the
    // create failed with "cannot start a transaction within a transaction".
    for (let n = 0; n <= 30; n++) {
        const filing = boardOf(workspace).issues.create({ title: `Issue ${n}` }, 'alice');
        await hops(n);
        const [issue, profile, settings] = await Promise.all([
            filing,
            store.profiles.save('alice', {
                fields: { name: `Alice ${n}` },
                shareable: false,
            }),
            store.updateSettings({ name: `Socio ${n}` }),
        ]);
        expect(issue.title).toBe(`Issue ${n}`);
        expect(profile?.fields.name).toBe(`Alice ${n}`);
        expect(settings.name).toBe(`Socio ${n}`);
        expect(connection.isTransaction).toBe(false);
    }
    expect(await boardOf(workspace).issues.list()).toHaveLength(31);
    expect((await store.profiles.get('alice'))?.fields.name).toBe('Alice 30');
    expect(store.settings().name).toBe('Socio 30');
});

it('queues a turn’s response time, a connection save and a backend change behind an issue being filed', async () => {
    const { connection, workspace } = app();
    const inference = new InferenceService(connection, {
        secret: 'uow-interleaving-secret-0123456789',
        log: () => {},
    });
    inference.register(fakeByoKind({ baseUrl: 'http://byo.invalid/v1' }));
    const backend = await inference.createBackend({
        label: 'Homelab',
        baseUrl: 'http://orion.invalid/v1',
        model: 'qwen',
    });
    await inference.updateSettings({ allowedByoKinds: ['byo-fake'] });
    for (let n = 0; n <= 20; n++) {
        const filing = boardOf(workspace).issues.create({ title: `Issue ${n}` }, 'alice');
        await hops(n);
        // As a turn does: the sample is stored off the stream's path.
        const sample = inference.timings.record({
            key: 'shared:b1:qwen',
            round: 'first',
            promptTokens: 100,
            uncachedTokens: 100,
            ttftMs: 1_000 + n,
        });
        await Promise.all([
            filing,
            sample,
            inference.connect('bob', 'byo-fake', {}),
            inference.updateBackend(backend.id, {
                label: `Homelab ${n}`,
                baseUrl: 'http://orion.invalid/v1',
                model: 'qwen',
            }),
        ]);
        expect(connection.isTransaction).toBe(false);
    }
    expect(await boardOf(workspace).issues.list()).toHaveLength(21);
    expect((await inference.timings.estimate('shared:b1:qwen', 'first', {}))?.samples).toBe(21);
    expect((await inference.operatorState()).backends[0].label).toBe('Homelab 20');
    // Its connect steps alternate: the 21st asks for the code again.
    expect((await inference.userKind('bob', 'byo-fake'))?.state).toBe('pending');
});

it('runs parallel tool calls started in one loop, as a model step does, each in its own transaction', async () => {
    const { store, workspace } = app();
    const space = workspace.spaces()[0].id;
    // A tool does a little async work (checks, reads) before it writes: each
    // call here waits `delay` microtask hops first, so the legacy writes land
    // at every point of the issue's unit of work.
    for (let delay = 0; delay <= 12; delay++) {
        const page = await workspace.pages.create(space, { title: `Notes ${delay}`, content: 'One' }, null, 'alice');
        const after = (call: () => Promise<unknown>) => async (): Promise<unknown> => {
            await hops(delay);
            return call();
        };
        // ai@6 starts the step's queued tool calls in one synchronous loop.
        const calls: Array<() => Promise<unknown>> = [
            () => boardOf(workspace).issues.create({ title: `From a socio ${delay}` }, 'alice'),
            after(() =>
                store.memoryItems.add({
                    userId: 'alice',
                    text: `Likes short answers ${delay}.`,
                    source: 'person',
                }),
            ),
            // A new page too: its own savepoint used to fail inside the unit.
            after(() => workspace.pages.create(space, { title: `Made ${delay}`, content: '' })),
            after(() =>
                workspace.pages.update(space, page.id, {
                    content: 'Two',
                    expectedRevision: page.revision,
                }),
            ),
            after(() => workspace.transaction(() => workspace.markReleaseSeen('alice', `0.6.${delay}`))),
            after(() => store.updateSettings({ name: `Socio ${delay}` })),
        ];
        const started = calls.map((call) => call());
        const results = await Promise.allSettled(started);
        expect(results.map((result) => result.status)).toEqual(calls.map(() => 'fulfilled'));
        expect(workspace.pages.get(space, page.id).content).toBe('Two');
        expect(store.settings().name).toBe(`Socio ${delay}`);
    }
    expect(await boardOf(workspace).issues.list()).toHaveLength(13);
    expect(await store.memoryItems.list('alice')).toHaveLength(13);
});

it('keeps a queued legacy write when the unit of work it waited for rolls back', async () => {
    const { connection, store } = app();
    const { uow } = sqliteData(connection);
    const failing = uow.run(
        async () => {
            connection
                .prepare('UPDATE settings SET value=json_set(value, ?, ?) WHERE id=1')
                .run('$.name', 'Rolled back');
            await hops(5);
            throw new Error('The unit fails');
        },
        { label: 'failing unit' },
    );
    await hops(1);
    // Started while the unit is open: it waits, then commits on its own.
    const saved = store.updateSettings({ researchAllowed: false });
    await expect(failing).rejects.toThrow('The unit fails');
    expect((await saved).researchAllowed).toBe(false);
    expect(store.settings().name).toBe('Socio');
});

it('fails loudly on writes from outside an open unit of work, never joining it', async () => {
    const { connection, workspace } = app();
    const { uow } = sqliteData(connection);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const unit = uow
        .run(
            async () => {
                // Not real work (a unit's body is database work only): it holds the
                // unit open across microtasks so the checks below run inside it.
                await held;
            },
            { label: 'held unit' },
        )
        .catch(() => undefined);
    await hops(2);
    expect(uow.foreignUnit).toBe('held unit');
    // A plain write (strict under tests), a transaction of its own, and a
    // caller that can't wait all fail, naming the unit.
    expect(() => connection.prepare("INSERT INTO settings VALUES (2, '{}')").run()).toThrow(UnitOfWorkError);
    expect(() => connection.exec('BEGIN')).toThrow(/held unit/);
    expect(() => transactionSync(connection, 'sync change', () => undefined)).toThrow(
        /"sync change" can't start while the unit of work "held unit"/,
    );
    // A caller that can wait queues instead.
    let ran = false;
    const queued = transaction(connection, 'queued change', () => {
        ran = true;
        return workspace.markReleaseSeen('alice', '0.6.1');
    });
    await hops(5);
    expect(ran).toBe(false);
    release();
    await unit;
    expect(await queued).toBe('0.6.1');
    expect(ran).toBe(true);
    expect(uow.foreignUnit).toBeUndefined();
});

it('runs a legacy transaction inside the unit that calls it as a savepoint', async () => {
    const { connection, store } = app();
    const { uow } = sqliteData(connection);
    await uow.run(
        async () => {
            await store.updateSettings({ name: 'Inside' });
            await expect(
                transaction(connection, 'fails alone', () => {
                    connection
                        .prepare('UPDATE settings SET value=json_set(value, ?, ?) WHERE id=1')
                        .run('$.name', 'Undone');
                    throw new Error('Nope');
                }),
            ).rejects.toThrow('Nope');
            expect(store.settings().name).toBe('Inside');
        },
        { label: 'outer' },
    );
    expect(store.settings().name).toBe('Inside');
});

it('in production, lets an outside write join the unit and reports it if the unit rolls back', async () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    db.exec('CREATE TABLE t(x)');
    const lines: string[] = [];
    const uow = new SqliteUnitOfWork(db, db, {
        strict: false,
        error: (line) => lines.push(line),
    });
    const unit = uow.run(
        async () => {
            db.prepare('INSERT INTO t VALUES (1)').run();
            await hops(3);
            throw new Error('Nope');
        },
        { label: 'production unit' },
    );
    await hops(1);
    db.prepare('INSERT INTO t VALUES (2)').run();
    await expect(unit).rejects.toThrow('Nope');
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
    expect(lines).toEqual([
        'Data loss: writes from outside the unit of work were rolled back with it: production unit',
    ]);
    // Transaction control from outside still fails in production.
    const open = uow.run(async () => hops(3), { label: 'second unit' });
    await hops(1);
    expect(() => db.exec('COMMIT')).toThrow(/second unit/);
    await open;
});

it('queues the scheduler’s, the jobs’ and the goals’ writes behind an issue being filed, however they interleave', async () => {
    const { connection, store, workspace } = app();
    const { repos } = sqliteSchedules(connection, new RuntimeSession());
    await repos.jobRuns.insert({
        id: 'run-1',
        jobId: 'job-1',
        version: 1,
        userId: 'alice',
        dotId: 'dot-1',
        trigger: 'manual',
        scheduleId: null,
        queuedAt: 1,
        longRunId: null,
    });
    await repos.goals.insert({
        id: 'G-1',
        userId: 'alice',
        dotId: 'dot-1',
        title: 'Herons',
        detail: '',
        scheduleId: 'task-0',
        status: 'active',
        progress: null,
        createdAt: 1,
        updatedAt: 1,
    });
    for (let n = 0; n <= 30; n++) {
        const filing = boardOf(workspace).issues.create({ title: `Issue ${n}` }, 'alice');
        await hops(n);
        const [, task] = await Promise.all([
            filing,
            store.createTask(`Count herons ${n}`, null, 'alice'),
            repos.jobRuns.update('run-1', { status: 'running', wakeMs: n }),
            repos.goals.comment({
                id: `GC-${n}`,
                goalId: 'G-1',
                authorKind: 'dot',
                authorId: 'dot-1',
                body: `Step ${n}.`,
                createdAt: n,
            }),
        ]);
        // Its claim, progress and end, behind the next issue.
        const next = boardOf(workspace).issues.create({ title: `Next ${n}` }, 'alice');
        await hops(n);
        const claim = (await store.claim())!;
        expect(claim.id).toBe(task.id);
        await Promise.all([
            next,
            store.event(claim.id, claim.lease, 'Halfway.'),
            store.finish(claim, { text: 'Done', sources: [], sample: false }),
        ]);
        expect(connection.isTransaction).toBe(false);
    }
    expect(await store.tasks('alice')).toHaveLength(31);
    expect((await store.tasks('alice')).every((task) => task.status === 'completed')).toBe(true);
    expect(await repos.jobRuns.get('run-1')).toMatchObject({ wakeMs: 30 });
    expect(await repos.goals.comments('G-1')).toHaveLength(31);
    expect(await boardOf(workspace).issues.list()).toHaveLength(62);
});

it('starts one job run when two starts land in the same turn (CB-110)', async () => {
    const { connection, workspace } = app();
    const schedules = sqliteSchedules(connection, new RuntimeSession());
    const dot = workspace.dots()[0]!;
    const jobs = new JobService(schedules, {
        data: {} as DataSpace,
        approvals: { register: () => {} } as unknown as ApprovalService,
        computers: () => ({ configured: true }) as ComputerService,
        workspace,
        // Nothing runs: the starts are only queued.
        settings: { concurrency: 0 },
    });
    await schedules.repos.jobs.save(
        { id: 'job-1', userId: 'alice', dotId: dot.id, name: 'Crawl' },
        {
            jobId: 'job-1',
            version: 1,
            entry: 'main.sh',
            files: [],
            digest: 'd',
            timeoutSeconds: 30,
            datasets: [],
            approvalId: null,
            createdAt: 1,
            untilDone: false,
        },
        true,
        1,
    );
    for (let n = 0; n <= 6; n++) {
        const filing = boardOf(workspace).issues.create({ title: `Issue ${n}` }, 'alice');
        await hops(n);
        const [, first, second] = await Promise.all([
            filing,
            jobs.start('alice', 'job-1', { trigger: 'manual' }),
            jobs.start('alice', 'job-1', { trigger: 'manual' }),
        ]);
        expect(second.id).toBe(first.id);
        jobs.forceStop('Stopped.');
        await vi.waitFor(async () => expect((await jobs.runRecord(first.id))?.status).toBe('interrupted'));
    }
    expect((await schedules.repos.jobRuns.page('job-1', 50)).runs).toHaveLength(7);
});
