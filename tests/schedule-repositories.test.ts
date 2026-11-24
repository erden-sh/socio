import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { getTableName } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { migrate, migrateDatabase, type SchemaSet } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';

import { schemas } from '../src/server/modules/index.js';
import type { JobVersion } from '../src/server/schedules/domain/repositories.js';
import {
    sqliteScheduleRepositories,
    sqliteTaskRepositories,
    sqliteTaskThreads,
} from '../src/server/schedules/infra/sqlite/index.js';
import { scheduleTables, taskTables, taskThreads } from '../src/server/schedules/infra/sqlite/schema.js';
import { scheduleTasksSchema, schedulesSchema } from '../src/server/schedules/migrations.js';
import { coreSchema } from '../src/server/settings/store.js';
import { workspaceSchema } from '../src/server/workspace/workspace.js';

/*
 * The Scheduling and jobs context's repository contract (CB-110): what any
 * implementation of `schedules/domain/repositories.ts` must keep, run
 * against the SQLite one. `tasks`, `runs`, `events` and `task_threads`
 * moved out of `core` and `workspace` (Q7): their history stays there,
 * and the context's baseline is adopted over it.
 */

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);

const OWN = [scheduleTasksSchema, schedulesSchema];

function scratch(sets: readonly SchemaSet[] = OWN) {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, sets);
    return db;
}

function schedules() {
    const db = scratch();
    const data = sqliteData(db);
    return {
        db,
        uow: data.uow,
        ...sqliteTaskRepositories(data),
        ...sqliteScheduleRepositories(data),
    };
}

/** The moved tables' columns and indexes, as SQLite describes them. */
function shape(db: DatabaseSync) {
    return Object.fromEntries(
        [...taskTables, taskThreads].map((table) => {
            const name = getTableName(table);
            const indexes = db
                .prepare(`PRAGMA index_list("${name}")`)
                .all()
                .map((index) => ({
                    name: index.name,
                    unique: index.unique,
                    partial: index.partial,
                    columns: db
                        .prepare(`PRAGMA index_info("${String(index.name)}")`)
                        .all()
                        .map((column) => column.name),
                }))
                .sort((a, b) => String(a.name).localeCompare(String(b.name)));
            const columns = db
                .prepare(`PRAGMA table_xinfo("${name}")`)
                .all()
                .map(({ cid: _, ...column }) => column)
                .sort((a, b) => String(a.name).localeCompare(String(b.name)));
            return [name, { columns, indexes }];
        }),
    );
}

const version = (jobId: string, n: number, extra: Partial<JobVersion> = {}): JobVersion => ({
    jobId,
    version: n,
    entry: 'main.sh',
    files: [{ path: 'main.sh', size: 4 }],
    digest: `d${n}`,
    timeoutSeconds: 30,
    datasets: ['scratch'],
    approvalId: null,
    createdAt: n,
    untilDone: false,
    ...extra,
});

it('mirrors the migrated Scheduling tables exactly, however they were made', () => {
    // By the context's own sets, by core's and the workspace's frozen
    // history (then the context's later versions), by every set.
    const own = scratch();
    const history = scratch([coreSchema, workspaceSchema, ...OWN]);
    const all = scratch(schemas);
    for (const db of [own, history, all]) {
        expect(schemaDrift(db, scheduleTables)).toEqual([]);
    }
    // The baseline makes the moved tables as that history left them.
    expect(shape(own)).toEqual(shape(history));
    expect(shape(all)).toEqual(shape(history));
    const created = own
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
        )
        .all()
        .map((row) => String(row.name));
    expect(scheduleTables.map((table) => getTableName(table)).sort()).toEqual(created);
});

it('reports a column the mirror does not know', () => {
    const db = scratch();
    db.exec('ALTER TABLE tasks ADD COLUMN pinned INTEGER');
    expect(schemaDrift(db, scheduleTables)).toEqual([expect.stringContaining('pinned')]);
});

it('adopts its baseline on a database core and the workspace made the tables in, changing nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-schedules-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'app.sqlite');
    const backupDirectory = join(dir, 'backups');
    // A database from before the move: every set but the tasks' baseline.
    const before = schemas.filter((set) => set.id !== scheduleTasksSchema.id);
    migrateDatabase(path, before, { backupDirectory });
    const db = new DatabaseSync(path);
    db.exec(`INSERT INTO tasks (id, prompt, status, createdAt, updatedAt, userId) VALUES ('t', 'Count herons', 'queued', 1, 1, 'alice');
    INSERT INTO runs (id, taskId, status, startedAt) VALUES ('r', 't', 'running', 2);
    INSERT INTO events (taskId, runId, text, createdAt) VALUES ('t', 'r', 'Started.', 3);
    INSERT INTO task_threads (taskId, threadId) VALUES ('t', 'chat');`);
    const rows = () =>
        ['tasks', 'runs', 'events', 'task_threads'].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const kept = rows();
    const schema = shape(db);
    // The baseline alone: later versions change the tables (as on any database).
    const baseline = schemas.map((set) =>
        set.id === scheduleTasksSchema.id ? { ...set, migrations: set.migrations!.slice(0, 1) } : set,
    );
    const { steps } = migrateDatabase(path, baseline, { backupDirectory });
    expect(steps).toEqual([{ module: 'schedule-tasks', version: 1, name: 'baseline', action: 'adopt' }]);
    expect(rows()).toEqual(kept);
    expect(shape(db)).toEqual(schema);
    // Core's and the workspace's history are still theirs: none of it moved.
    expect(
        db
            .prepare(
                "SELECT module, COUNT(*) AS n FROM schema_migrations WHERE module IN ('core', 'workspace', 'schedule-tasks') GROUP BY module ORDER BY module",
            )
            .all()
            .map((row) => `${String(row.module)} ${String(row.n)}`),
    ).toEqual([
        `core ${coreSchema.migrations!.length}`,
        'schedule-tasks 1',
        `workspace ${workspaceSchema.migrations!.length}`,
    ]);
    db.close();
});

it('keeps a person’s tasks, live ones only, and finds what is due', async () => {
    const { tasks } = schedules();
    await tasks.insert({
        id: 'old',
        prompt: 'Count herons',
        status: 'queued',
        intervalSeconds: null,
        createdAt: 1,
        userId: 'alice',
    });
    await tasks.insert({
        id: 'daily',
        prompt: 'Summarise the news',
        status: 'scheduled',
        intervalSeconds: null,
        createdAt: 2,
        userId: 'alice',
        title: 'News',
        cadence: 'every day at 09:00',
        timezone: 'UTC',
        dotId: 'dot-1',
        kind: 'turn',
        origin: 'dot',
    });
    await tasks.insert({
        id: 'bobs',
        prompt: 'Goal G-12345678: “Tidy”',
        status: 'scheduled',
        intervalSeconds: null,
        createdAt: 3,
        userId: 'bob',
        cadence: 'every day at 10:00',
        timezone: 'UTC',
        dotId: 'dot-1',
        kind: 'turn',
        origin: 'dot',
    });
    expect(await tasks.get('old')).toEqual({
        id: 'old',
        prompt: 'Count herons',
        status: 'queued',
        intervalSeconds: null,
        nextRunAt: null,
        createdAt: 1,
        updatedAt: 1,
        error: null,
        lease: null,
        leaseUntil: null,
        userId: 'alice',
        title: null,
        cadence: null,
        timezone: null,
        dotId: null,
        kind: null,
        jobId: null,
        origin: null,
        lastRunAt: null,
    });
    expect((await tasks.list('alice')).map((task) => task.id)).toEqual(['daily', 'old']);
    expect((await tasks.schedules('alice')).map((task) => task.id)).toEqual(['daily']);
    expect(await tasks.activeScheduleCount('alice')).toBe(1);
    expect(await tasks.scheduleCounts()).toEqual({ scheduled: 2 });
    expect((await tasks.idsOfDot('dot-1')).sort()).toEqual(['bobs', 'daily']);
    expect(await tasks.goalCandidates()).toEqual([{ id: 'bobs', prompt: 'Goal G-12345678: “Tidy”' }]);
    // Queued now, or a schedule whose time came: the oldest first.
    expect((await tasks.due(5))?.id).toBe('old');
    // Only while it has the status asked for.
    expect(await tasks.update('old', { status: 'running' }, 'paused')).toBe(false);
    expect(await tasks.update('old', { status: 'running', lease: 'l1', leaseUntil: 10 }, 'queued')).toBe(true);
    expect((await tasks.expired(9)).map((task) => task.id)).toEqual([]);
    expect((await tasks.expired(10)).map((task) => task.id)).toEqual(['old']);
    await tasks.update('daily', { nextRunAt: 7 });
    expect(await tasks.due(6)).toBeUndefined();
    expect((await tasks.due(7))?.id).toBe('daily');
    // Deleting stamps it: gone from every read but `withDeleted`.
    expect(await tasks.remove('daily', 'alice', 'conversation:c', 8)).toBe(true);
    expect(await tasks.remove('daily', 'alice', null, 9)).toBe(false);
    expect(await tasks.get('daily')).toBeUndefined();
    expect(await tasks.schedules('alice')).toEqual([]);
    expect(await tasks.due(7)).toBeUndefined();
    expect(await tasks.withDeleted('daily')).toMatchObject({
        deletedAt: 8,
        deletedBy: 'alice',
        deletedWith: 'conversation:c',
    });
    expect((await tasks.idsOfDot('dot-1')).sort()).toEqual(['bobs', 'daily']);
});

it('keeps a task’s runs newest first, pages them, and its history in order', async () => {
    const { tasks, runs, events } = schedules();
    await tasks.insert({
        id: 't',
        prompt: 'Count herons',
        status: 'queued',
        intervalSeconds: null,
        createdAt: 1,
        userId: 'alice',
    });
    // Two in the same millisecond: the later one first.
    for (const [id, at] of [
        ['r1', 10],
        ['r2', 20],
        ['r3', 20],
    ] as const) {
        await runs.start(id, 't', at);
    }
    await runs.end('r1', {
        status: 'completed',
        finishedAt: 11,
        result: { text: 'Done', sources: [], sample: false },
    });
    // Only a run still running, when asked.
    await runs.end('r1', { status: 'interrupted', finishedAt: 12, error: 'Late' }, true);
    await runs.end('r2', { status: 'failed', finishedAt: 21, error: 'No' });
    expect((await runs.list('t')).map((run) => run.id)).toEqual(['r3', 'r2', 'r1']);
    expect((await runs.list('t'))[2]).toEqual({
        id: 'r1',
        taskId: 't',
        status: 'completed',
        startedAt: 10,
        finishedAt: 11,
        result: { text: 'Done', sources: [], sample: false },
        error: null,
        dueAt: null,
    });
    expect(await runs.recent('t', 2)).toEqual([
        {
            id: 'r3',
            status: 'running',
            startedAt: 20,
            finishedAt: null,
            error: null,
        },
        { id: 'r2', status: 'failed', startedAt: 20, finishedAt: 21, error: 'No' },
    ]);
    const first = (await runs.page('t', 2))!;
    expect(first.runs.map((run) => run.id)).toEqual(['r3', 'r2']);
    expect(first.more).toBe(true);
    const next = (await runs.page('t', 2, 'r2'))!;
    expect(next.runs.map((run) => run.id)).toEqual(['r1']);
    expect(next.more).toBe(false);
    expect(await runs.page('other', 2, 'r2')).toBeUndefined();
    await events.add('t', null, 'Added.', 1);
    await events.add('t', 'r1', 'Started.', 10);
    expect((await events.list('t')).map((event) => [event.runId, event.text])).toEqual([
        [null, 'Added.'],
        ['r1', 'Started.'],
    ]);
});

it('binds a scheduled task to its conversation', async () => {
    const db = scratch([coreSchema, workspaceSchema]);
    const threads = sqliteTaskThreads(sqliteData(db));
    await threads.bind('t1', 'chat');
    await threads.bind('t2', 'chat');
    await threads.bind('t3', 'other');
    expect(await threads.threadOf('t1')).toBe('chat');
    expect(await threads.threadOf('nope')).toBeUndefined();
    expect((await threads.tasksOf(['chat'])).sort()).toEqual(['t1', 't2']);
    expect((await threads.tasksOf(['chat', 'other'])).sort()).toEqual(['t1', 't2', 't3']);
    expect(await threads.tasksOf([])).toEqual([]);
    // One conversation per task.
    await expect(threads.bind('t1', 'other')).rejects.toThrow();
});

it('saves a job’s versions together with it, and frees its name when deleted', async () => {
    const { jobs } = schedules();
    const job = { id: 'j1', userId: 'alice', dotId: 'dot-1', name: 'Crawl' };
    await jobs.save(job, version('j1', 1), true, 1);
    await jobs.save(job, version('j1', 2, { untilDone: true }), false, 2);
    expect(await jobs.get('j1')).toEqual({
        ...job,
        version: 2,
        createdAt: 1,
        updatedAt: 2,
    });
    expect(await jobs.named('alice', 'dot-1', 'Crawl')).toMatchObject({
        id: 'j1',
    });
    expect(await jobs.version('j1', 2)).toEqual(version('j1', 2, { untilDone: true }));
    expect((await jobs.versions('j1')).map((row) => row.version)).toEqual([2, 1]);
    await jobs.save({ ...job, id: 'j2', name: 'Other', dotId: 'dot-2' }, version('j2', 1), true, 3);
    expect((await jobs.list('alice')).map((row) => row.id)).toEqual(['j2', 'j1']);
    expect((await jobs.list('alice', 'dot-1')).map((row) => row.id)).toEqual(['j1']);
    expect(await jobs.count()).toBe(2);
    // A version that is already there fails, and the job keeps its number.
    await expect(jobs.save(job, version('j1', 2), false, 4)).rejects.toThrow();
    expect((await jobs.get('j1'))?.updatedAt).toBe(2);
    await jobs.remove('j1', 'alice', 5);
    expect(await jobs.get('j1')).toBeUndefined();
    expect(await jobs.named('alice', 'dot-1', 'Crawl')).toBeUndefined();
    expect(await jobs.withDeleted('j1')).toMatchObject({
        deletedAt: 5,
        deletedBy: 'alice',
    });
    // Its name is free again (CB-64).
    await jobs.save({ ...job, id: 'j3' }, version('j3', 1), true, 6);
    expect(await jobs.count()).toBe(2);
});

it('keeps every job run, pages them, trims old output and counts them by status', async () => {
    const { jobRuns } = schedules();
    const run = (id: string, queuedAt: number, scheduleId: string | null) =>
        jobRuns.insert({
            id,
            jobId: 'j1',
            version: 1,
            userId: 'alice',
            dotId: 'dot-1',
            trigger: scheduleId ? 'schedule' : 'manual',
            scheduleId,
            queuedAt,
            longRunId: null,
        });
    await run('a', 1, 's1');
    await run('b', 2, null);
    await run('c', 2, 's1');
    expect(await jobRuns.get('a')).toMatchObject({
        status: 'queued',
        stdout: null,
        outputTrimmedAt: null,
    });
    expect((await jobRuns.open('j1'))?.queuedAt).toBe(2);
    for (const id of ['a', 'b']) {
        await jobRuns.update(id, {
            status: 'succeeded',
            finishedAt: 3,
            stdout: `out ${id}`,
            stderr: '',
            exitCode: 0,
        });
    }
    expect((await jobRuns.latest('j1'))?.id).toBe('c');
    expect((await jobRuns.latestOfSchedule('s1'))?.id).toBe('c');
    const page = await jobRuns.page('j1', 2);
    expect(page.runs.map((row) => row.id)).toEqual(['c', 'b']);
    expect(page.more).toBe(true);
    expect((await jobRuns.page('j1', 2, 'b')).runs.map((row) => row.id)).toEqual(['a']);
    expect((await jobRuns.ofSchedule('s1', 'alice', 5)).runs.map((row) => row.id)).toEqual(['c', 'a']);
    expect(await jobRuns.ofSchedule('s1', 'bob', 5)).toEqual({
        runs: [],
        more: false,
    });
    expect((await jobRuns.ofDot('dot-1', 1, 5)).map((row) => row.id)).toEqual(['a']);
    expect(await jobRuns.lastOfDot('dot-1')).toBe(2);
    expect(await jobRuns.lastOfDot('dot-2')).toBeNull();
    // Past the newest two, finished runs lose their output; c still runs.
    await jobRuns.trimOutput('j1', 2, 9);
    expect(await jobRuns.get('a')).toMatchObject({
        stdout: null,
        stderr: null,
        outputTrimmedAt: 9,
    });
    expect(await jobRuns.get('b')).toMatchObject({
        stdout: 'out b',
        outputTrimmedAt: null,
    });
    expect(await jobRuns.counts()).toEqual({ queued: 1, succeeded: 2 });
    // A new process interrupts what the last one left open.
    await jobRuns.interruptOpen(10, 'Restarted.', (_id, interrupt) => interrupt());
    expect(await jobRuns.get('c')).toMatchObject({
        status: 'interrupted',
        finishedAt: 10,
        error: 'Restarted.',
    });
    expect(await jobRuns.open('j1')).toBeUndefined();
    expect(await jobRuns.counts()).toEqual({ interrupted: 1, succeeded: 2 });
});

it('keeps goals newest first, their notes and their comments in order', async () => {
    const { goals } = schedules();
    const goal = {
        id: 'G-1',
        userId: 'alice',
        dotId: 'dot-1',
        title: 'Keep the doc current',
        detail: '',
        scheduleId: 's1',
        status: 'active' as const,
        progress: null,
        createdAt: 1,
        updatedAt: 1,
    };
    await goals.insert(goal);
    await goals.insert({ ...goal, id: 'G-2', scheduleId: 's2', createdAt: 2 });
    await goals.insert({
        ...goal,
        id: 'G-3',
        userId: 'bob',
        dotId: 'dot-2',
        scheduleId: 's3',
        createdAt: 3,
    });
    expect((await goals.list('alice')).map((row) => row.id)).toEqual(['G-2', 'G-1']);
    expect(await goals.list('alice', 'dot-2')).toEqual([]);
    expect((await goals.forDot('dot-1')).map((row) => row.id)).toEqual(['G-2', 'G-1']);
    expect(await goals.lastOfDot('dot-1')).toBe(2);
    expect((await goals.bySchedule('s3'))?.id).toBe('G-3');
    // A note keeps the status; a status keeps the note, and closes it.
    await goals.update('G-1', { progress: 'Half way' }, 5);
    expect(await goals.get('G-1')).toMatchObject({
        progress: 'Half way',
        status: 'active',
        updatedAt: 5,
        closedAt: null,
    });
    await goals.update('G-1', { status: 'done' }, 6);
    expect(await goals.get('G-1')).toMatchObject({
        progress: 'Half way',
        status: 'done',
        closedAt: 6,
    });
    for (const [id, at] of [
        ['GC-1', 10],
        ['GC-2', 10],
        ['GC-3', 9],
    ] as const) {
        await goals.comment({
            id,
            goalId: 'G-2',
            authorKind: 'person',
            authorId: 'alice',
            body: id,
            createdAt: at,
        });
    }
    expect((await goals.comments('G-2')).map((row) => row.id)).toEqual(['GC-3', 'GC-1', 'GC-2']);
});

it('works a long run’s items: claimed once, done once, retried, then set aside', async () => {
    const { longRuns } = schedules();
    const row = await longRuns.create({
        id: 'lr1',
        jobId: 'j1',
        userId: 'alice',
        dotId: 'dot-1',
        trigger: 'manual',
        scheduleId: null,
        threadId: null,
        createdAt: 1,
    });
    expect(row).toMatchObject({
        status: 'waiting',
        batches: 0,
        sealed: 0,
        nextAt: 1,
        updatedAt: 1,
    });
    // One open long run per job.
    expect((await longRuns.create({ ...row, id: 'lr2', createdAt: 2 })).id).toBe('lr1');
    expect((await longRuns.openRuns()).map((open) => open.id)).toEqual(['lr1']);
    expect(await longRuns.addItems('lr1', ['a', 'b', 'c'], 2)).toBe(3);
    expect(await longRuns.addItems('lr1', ['c', 'd'], 2)).toBe(1);
    expect(await longRuns.claim('lr1', 'batch-1', 2, 3)).toEqual(['a', 'b']);
    expect(await longRuns.claim('lr1', 'batch-2', 5, 3)).toEqual(['c', 'd']);
    expect(await longRuns.done('lr1', 'batch-2', 'a', 4)).toBe('not_claimed');
    expect(await longRuns.done('lr1', 'batch-1', 'a', 4)).toBe('done');
    expect(await longRuns.done('lr1', 'batch-1', 'a', 4)).toBe('already');
    expect(await longRuns.done('lr1', 'batch-1', 'zz', 4)).toBe('unknown');
    const fail = {
        error: 'Timed out',
        retry: true,
        refund: false,
        maxAttempts: 2,
        waitMs: () => 100,
    };
    expect(await longRuns.fail('lr1', 'batch-1', 'b', fail, 5)).toBe('retry');
    expect(await longRuns.nextDue('lr1')).toBe(105);
    expect(await longRuns.claim('lr1', 'batch-3', 5, 104)).toEqual([]);
    expect(await longRuns.claim('lr1', 'batch-3', 5, 105)).toEqual(['b']);
    expect(await longRuns.fail('lr1', 'batch-3', 'b', fail, 106)).toBe('dead');
    // Batch 2 ended on c: c is charged, d wasn't reached and costs nothing.
    expect(
        await longRuns.release(
            'lr1',
            'batch-2',
            { refund: false, maxAttempts: 2, error: 'Crashed', waitMs: () => 10 },
            7,
        ),
    ).toEqual({ released: 2, dead: 0 });
    expect(await longRuns.counts('lr1')).toEqual({
        pending: 2,
        claimed: 0,
        done: 1,
        dead: 1,
        total: 4,
        tries: 4,
    });
    expect(await longRuns.dead('lr1', 5)).toEqual([{ key: 'b', error: 'Timed out', attempts: 2, at: 106 }]);
    await longRuns.update('lr1', { status: 'done', finishedAt: 8, outcome: 'Done.' }, 8);
    expect(await longRuns.open('j1')).toBeUndefined();
    expect((await longRuns.latest('j1'))?.id).toBe('lr1');
    expect((await longRuns.unreported(8)).map((ended) => ended.id)).toEqual(['lr1']);
    expect(await longRuns.unreported(9)).toEqual([]);
});

it('rolls back every repository write in a failed unit of work', async () => {
    const { uow, tasks, events, goals } = schedules();
    await expect(
        uow.run(async () => {
            await tasks.insert({
                id: 't',
                prompt: 'Count herons',
                status: 'queued',
                intervalSeconds: null,
                createdAt: 1,
                userId: 'alice',
            });
            await events.add('t', null, 'Added.', 1);
            await goals.insert({
                id: 'G-1',
                userId: 'alice',
                dotId: 'dot-1',
                title: 'Herons',
                detail: '',
                scheduleId: 't',
                status: 'active',
                progress: null,
                createdAt: 1,
                updatedAt: 1,
            });
            throw new Error('then it fails');
        }),
    ).rejects.toThrow('then it fails');
    expect(await tasks.get('t')).toBeUndefined();
    expect(await events.list('t')).toEqual([]);
    expect(await goals.get('G-1')).toBeUndefined();
});
