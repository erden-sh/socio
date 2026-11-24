import {
    and,
    asc,
    count,
    desc,
    eq,
    inArray,
    isNotNull,
    isNull,
    like,
    lte,
    notInArray,
    or,
    sql,
    type SQL,
} from 'drizzle-orm';

import { unstamped } from '@socio/data/soft-delete';
import type { Result, Run, Status, Task } from '@socio/shared/types';

import type { StoredTask, TaskThreadRepository } from '../../contract.js';
import type {
    NewTask,
    TaskEventRepository,
    TaskPatch,
    TaskRepository,
    TaskRunRepository,
} from '../../domain/repositories.js';

import { SqliteRepository, insertionOrder } from './base.js';
import { events, runs, taskThreads, tasks } from './schema.js';

type TaskRow = typeof tasks.$inferSelect;
type RunRow = typeof runs.$inferSelect;

/** A task as the API shows it: without its stamp (CB-64). */
const taskOf = (row: TaskRow): Task => unstamped(row);

const runOf = (row: RunRow): Run => ({
    ...row,
    result: row.result ? (JSON.parse(row.result) as Result) : null,
});

const live = isNull(tasks.deletedAt);
const newestFirst = desc(tasks.createdAt);
const runsNewestFirst = [desc(runs.startedAt), desc(insertionOrder(runs))];

/** Tasks and schedules, on the shared SQLite connection. */
export class SqliteTasks extends SqliteRepository implements TaskRepository {
    /** The runner looks a claimed task up ten times a second: prepared once. */
    private byId = this.data.uow
        .executor()
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, sql.placeholder('id')), live))
        .prepare();

    async get(id: string) {
        this.data.uow.executor();
        const row = await this.byId.get({ id });
        return row && taskOf(row);
    }

    async withDeleted(id: string): Promise<StoredTask | undefined> {
        return this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    }

    private async live(...where: SQL[]) {
        const rows = await this.db
            .select()
            .from(tasks)
            .where(and(...where, live))
            .orderBy(newestFirst)
            .all();
        return rows.map(taskOf);
    }

    list(userId: string) {
        return this.live(eq(tasks.userId, userId));
    }

    all() {
        return this.live();
    }

    schedules(userId: string) {
        return this.live(eq(tasks.userId, userId), or(isNotNull(tasks.cadence), isNotNull(tasks.intervalSeconds))!);
    }

    async activeScheduleCount(userId: string) {
        const row = await this.db
            .select({ n: count() })
            .from(tasks)
            .where(
                and(
                    eq(tasks.userId, userId),
                    isNotNull(tasks.cadence),
                    notInArray(tasks.status, ['cancelled', 'failed']),
                    live,
                ),
            )
            .get();
        return row?.n ?? 0;
    }

    async scheduleCounts() {
        const rows = await this.db
            .select({ status: tasks.status, n: count() })
            .from(tasks)
            .where(and(isNotNull(tasks.cadence), live))
            .groupBy(tasks.status)
            .all();
        return Object.fromEntries(rows.map((row) => [row.status, row.n]));
    }

    async forJob(jobId: string) {
        const rows = await this.db
            .select()
            .from(tasks)
            .where(and(eq(tasks.kind, 'job'), eq(tasks.jobId, jobId), live))
            .orderBy(asc(tasks.createdAt))
            .all();
        return rows.map(taskOf);
    }

    async idsOfDot(dotId: string) {
        const rows = await this.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.dotId, dotId)).all();
        return rows.map((row) => row.id);
    }

    async goalCandidates() {
        return this.db
            .select({ id: tasks.id, prompt: tasks.prompt })
            .from(tasks)
            .where(
                and(
                    eq(tasks.origin, 'dot'),
                    like(tasks.prompt, 'Goal G-%'),
                    notInArray(tasks.status, ['cancelled']),
                    live,
                ),
            )
            .all();
    }

    async expired(now: number) {
        const rows = await this.db
            .select()
            .from(tasks)
            .where(and(eq(tasks.status, 'running'), lte(tasks.leaseUntil, now), live))
            .all();
        return rows.map(taskOf);
    }

    async due(now: number) {
        const row = await this.db
            .select()
            .from(tasks)
            .where(
                and(
                    or(
                        eq(tasks.status, 'queued'),
                        and(
                            inArray(tasks.status, ['completed', 'scheduled']),
                            isNotNull(tasks.nextRunAt),
                            lte(tasks.nextRunAt, now),
                        ),
                    ),
                    live,
                ),
            )
            .orderBy(asc(tasks.createdAt))
            .limit(1)
            .get();
        return row && taskOf(row);
    }

    insert(task: NewTask) {
        return this.write('add task', async () => {
            await this.db.insert(tasks).values({
                id: task.id,
                prompt: task.prompt,
                status: task.status,
                intervalSeconds: task.intervalSeconds,
                nextRunAt: null,
                createdAt: task.createdAt,
                updatedAt: task.createdAt,
                userId: task.userId,
                ...(task.cadence !== undefined
                    ? {
                          title: task.title ?? null,
                          cadence: task.cadence,
                          timezone: task.timezone ?? null,
                          dotId: task.dotId ?? null,
                          kind: task.kind ?? null,
                          jobId: task.jobId ?? null,
                          origin: task.origin ?? null,
                      }
                    : {}),
            });
        });
    }

    update(id: string, patch: TaskPatch, status?: Status) {
        return this.write('update task', async () => {
            const { changes } = await this.db
                .update(tasks)
                .set(patch)
                .where(and(eq(tasks.id, id), ...(status ? [eq(tasks.status, status)] : [])))
                .run();
            return Number(changes) > 0;
        });
    }

    remove(id: string, by: string, withParent: string | null, now: number) {
        return this.write('delete task', async () => {
            const { changes } = await this.db
                .update(tasks)
                .set({ deletedAt: now, deletedBy: by, deletedWith: withParent })
                .where(and(eq(tasks.id, id), live))
                .run();
            return Number(changes) > 0;
        });
    }

    assignUnowned(userId: string) {
        return this.write('assign unowned tasks', async () => {
            const { changes } = await this.db.update(tasks).set({ userId }).where(isNull(tasks.userId)).run();
            return Number(changes);
        });
    }
}

/** A task's runs, on the shared SQLite connection. */
export class SqliteTaskRuns extends SqliteRepository implements TaskRunRepository {
    start(id: string, taskId: string, now: number, dueAt: number | null = null) {
        return this.write('start task run', async () => {
            await this.db.insert(runs).values({ id, taskId, status: 'running', startedAt: now, dueAt });
        });
    }

    end(
        id: string,
        end: {
            status: string;
            finishedAt: number;
            result?: Result;
            error?: string;
        },
        running = false,
    ) {
        return this.write('end task run', async () => {
            await this.db
                .update(runs)
                .set({
                    status: end.status,
                    finishedAt: end.finishedAt,
                    ...(end.result ? { result: JSON.stringify(end.result) } : {}),
                    ...(end.error !== undefined ? { error: end.error } : {}),
                })
                .where(and(eq(runs.id, id), ...(running ? [eq(runs.status, 'running')] : [])))
                .run();
        });
    }

    async list(taskId: string) {
        const rows = await this.db
            .select()
            .from(runs)
            .where(eq(runs.taskId, taskId))
            .orderBy(...runsNewestFirst)
            .all();
        return rows.map(runOf);
    }

    async recent(taskId: string, limit: number) {
        return this.db
            .select({
                id: runs.id,
                status: runs.status,
                startedAt: runs.startedAt,
                finishedAt: runs.finishedAt,
                error: runs.error,
            })
            .from(runs)
            .where(eq(runs.taskId, taskId))
            .orderBy(...runsNewestFirst)
            .limit(limit)
            .all();
    }

    async page(taskId: string, limit: number, before?: string) {
        if (
            before &&
            !(await this.db
                .select({ id: runs.id })
                .from(runs)
                .where(and(eq(runs.id, before), eq(runs.taskId, taskId)))
                .get())
        ) {
            return undefined;
        }
        const rows = await this.db
            .select()
            .from(runs)
            .where(
                and(
                    eq(runs.taskId, taskId),
                    ...(before
                        ? [
                              sql`(${runs.startedAt}, ${insertionOrder(runs)}) < (SELECT ${runs.startedAt}, rowid FROM ${runs} WHERE ${runs.id} = ${before})`,
                          ]
                        : []),
                ),
            )
            .orderBy(...runsNewestFirst)
            .limit(limit + 1)
            .all();
        return {
            runs: rows.slice(0, limit).map(runOf),
            more: rows.length > limit,
        };
    }
}

/** A task's history lines, on the shared SQLite connection. */
export class SqliteTaskEvents extends SqliteRepository implements TaskEventRepository {
    add(taskId: string, runId: string | null, text: string, now: number) {
        return this.write('add task event', async () => {
            await this.db.insert(events).values({ taskId, runId, text, createdAt: now });
        });
    }

    async list(taskId: string) {
        return this.db.select().from(events).where(eq(events.taskId, taskId)).orderBy(asc(events.id)).all();
    }
}

/** The conversations scheduled tasks run in, on the shared connection. */
export class SqliteTaskThreads extends SqliteRepository implements TaskThreadRepository {
    bind(taskId: string, threadId: string) {
        return this.write('bind task', async () => {
            await this.db.insert(taskThreads).values({ taskId, threadId });
        });
    }

    async threadOf(taskId: string) {
        const row = await this.db
            .select({ threadId: taskThreads.threadId })
            .from(taskThreads)
            .where(eq(taskThreads.taskId, taskId))
            .get();
        return row?.threadId;
    }

    async tasksOf(threadIds: readonly string[]) {
        if (!threadIds.length) {
            return [];
        }
        const rows = await this.db
            .select({ taskId: taskThreads.taskId })
            .from(taskThreads)
            .where(inArray(taskThreads.threadId, [...threadIds]))
            .all();
        return rows.map((row) => row.taskId);
    }
}
