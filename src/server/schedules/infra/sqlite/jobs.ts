import { and, count, desc, eq, gt, inArray, isNull, lte, max, notInArray, sql, type SQL } from 'drizzle-orm';

import { JOB_RUN_STATUSES, type JobFileView, type JobRunStatus } from '@socio/shared/schedule-types';

import type { JobRun } from '../../contract.js';
import type {
    Job,
    JobRepository,
    JobRunPatch,
    JobRunRepository,
    JobVersion,
    NewJobRun,
} from '../../domain/repositories.js';

import { SqliteRepository, insertionOrder } from './base.js';
import { jobRunCounts, jobRuns, jobVersions, jobs } from './schema.js';

const JOB = {
    id: jobs.id,
    userId: jobs.userId,
    dotId: jobs.dotId,
    name: jobs.name,
    version: jobs.version,
    createdAt: jobs.createdAt,
    updatedAt: jobs.updatedAt,
};
const liveJob = isNull(jobs.deletedAt);

const versionOf = (row: typeof jobVersions.$inferSelect): JobVersion => ({
    ...row,
    files: JSON.parse(row.files) as JobFileView[],
    datasets: JSON.parse(row.datasets) as string[],
    untilDone: !!row.untilDone,
});

/** Jobs and their versions, on the shared SQLite connection. */
export class SqliteJobs extends SqliteRepository implements JobRepository {
    async get(id: string): Promise<Job | undefined> {
        return this.db
            .select(JOB)
            .from(jobs)
            .where(and(eq(jobs.id, id), liveJob))
            .get();
    }

    async withDeleted(id: string) {
        return this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    }

    async named(userId: string, dotId: string, name: string) {
        return this.db
            .select(JOB)
            .from(jobs)
            .where(and(eq(jobs.userId, userId), eq(jobs.dotId, dotId), eq(jobs.name, name), liveJob))
            .get();
    }

    async list(userId: string, dotId?: string) {
        return this.db
            .select(JOB)
            .from(jobs)
            .where(and(eq(jobs.userId, userId), ...(dotId ? [eq(jobs.dotId, dotId)] : []), liveJob))
            .orderBy(desc(jobs.updatedAt))
            .all();
    }

    async count() {
        return (await this.db.select({ n: count() }).from(jobs).where(liveJob).get())?.n ?? 0;
    }

    save(job: Pick<Job, 'id' | 'userId' | 'dotId' | 'name'>, version: JobVersion, isNew: boolean, now: number) {
        return this.write('save schedule job', async () => {
            if (isNew) {
                await this.db.insert(jobs).values({
                    ...job,
                    version: version.version,
                    createdAt: now,
                    updatedAt: now,
                });
            } else {
                await this.db.update(jobs).set({ version: version.version, updatedAt: now }).where(eq(jobs.id, job.id));
            }
            await this.db.insert(jobVersions).values({
                ...version,
                files: JSON.stringify(version.files),
                datasets: JSON.stringify(version.datasets),
                untilDone: version.untilDone ? 1 : 0,
            });
        });
    }

    async version(jobId: string, version: number) {
        const row = await this.db
            .select()
            .from(jobVersions)
            .where(and(eq(jobVersions.jobId, jobId), eq(jobVersions.version, version)))
            .get();
        return row && versionOf(row);
    }

    async versions(jobId: string) {
        const rows = await this.db
            .select()
            .from(jobVersions)
            .where(eq(jobVersions.jobId, jobId))
            .orderBy(desc(jobVersions.version))
            .all();
        return rows.map(versionOf);
    }

    remove(id: string, by: string, now: number) {
        return this.write('delete job', async () => {
            await this.db
                .update(jobs)
                .set({ deletedAt: now, deletedBy: by })
                .where(and(eq(jobs.id, id), liveJob));
        });
    }
}

const OPEN: JobRunStatus[] = ['queued', 'starting', 'running'];
const FINISHED: JobRunStatus[] = JOB_RUN_STATUSES.filter((status) => !OPEN.includes(status));
const newestRuns = [desc(jobRuns.queuedAt), desc(insertionOrder(jobRuns))];
/** Older than the run `before`, in the newest-first order. */
const olderThan = (before: string) =>
    sql`(${jobRuns.queuedAt}, ${insertionOrder(jobRuns)}) < (SELECT ${jobRuns.queuedAt}, rowid FROM ${jobRuns} WHERE ${jobRuns.id} = ${before})`;

/** Job runs, on the shared SQLite connection. */
export class SqliteJobRuns extends SqliteRepository implements JobRunRepository {
    /** Every poll of a run in progress reads it: prepared once. */
    private byId = this.data.uow
        .executor()
        .select()
        .from(jobRuns)
        .where(eq(jobRuns.id, sql.placeholder('id')))
        .prepare();

    async get(id: string): Promise<JobRun | undefined> {
        this.data.uow.executor();
        return this.byId.get({ id });
    }

    private async newest(...where: SQL[]) {
        return this.db
            .select()
            .from(jobRuns)
            .where(and(...where))
            .orderBy(...newestRuns)
            .limit(1)
            .get();
    }

    latest(jobId: string) {
        return this.newest(eq(jobRuns.jobId, jobId));
    }

    latestOfSchedule(scheduleId: string) {
        return this.newest(eq(jobRuns.scheduleId, scheduleId));
    }

    async open(jobId: string) {
        return this.db
            .select()
            .from(jobRuns)
            .where(and(eq(jobRuns.jobId, jobId), inArray(jobRuns.status, OPEN)))
            .orderBy(desc(jobRuns.queuedAt))
            .limit(1)
            .get();
    }

    private async paged(where: SQL[], limit: number, before?: string) {
        const rows = await this.db
            .select()
            .from(jobRuns)
            .where(and(...where, ...(before ? [olderThan(before)] : [])))
            .orderBy(...newestRuns)
            .limit(limit + 1)
            .all();
        return { runs: rows.slice(0, limit), more: rows.length > limit };
    }

    page(jobId: string, limit: number, before?: string) {
        return this.paged([eq(jobRuns.jobId, jobId)], limit, before);
    }

    ofSchedule(scheduleId: string, userId: string, limit: number, before?: string) {
        return this.paged([eq(jobRuns.scheduleId, scheduleId), eq(jobRuns.userId, userId)], limit, before);
    }

    async ofDot(dotId: string, before: number, limit: number) {
        return this.db
            .select()
            .from(jobRuns)
            .where(and(eq(jobRuns.dotId, dotId), lte(jobRuns.queuedAt, before)))
            .orderBy(desc(jobRuns.queuedAt))
            .limit(limit)
            .all();
    }

    async lastOfDot(dotId: string) {
        const row = await this.db
            .select({ at: max(jobRuns.queuedAt) })
            .from(jobRuns)
            .where(eq(jobRuns.dotId, dotId))
            .get();
        return row?.at ?? null;
    }

    insert(run: NewJobRun) {
        return this.write('add job run', async () => {
            await this.db.insert(jobRuns).values({ ...run, status: 'queued' });
        });
    }

    update(id: string, patch: JobRunPatch) {
        if (!Object.keys(patch).length) {
            return Promise.resolve();
        }
        return this.write('update job run', async () => {
            await this.db.update(jobRuns).set(patch).where(eq(jobRuns.id, id));
        });
    }

    trimOutput(jobId: string, keep: number, now: number) {
        return this.write('trim job output', async () => {
            const kept = this.db
                .select({ id: jobRuns.id })
                .from(jobRuns)
                .where(eq(jobRuns.jobId, jobId))
                .orderBy(...newestRuns)
                .limit(keep);
            await this.db
                .update(jobRuns)
                .set({ stdout: null, stderr: null, outputTrimmedAt: now })
                .where(
                    and(
                        eq(jobRuns.jobId, jobId),
                        isNull(jobRuns.outputTrimmedAt),
                        inArray(jobRuns.status, FINISHED),
                        notInArray(jobRuns.id, kept),
                    ),
                );
        });
    }

    interruptOpen(now: number, error: string, recover: (id: string, interrupt: () => void) => void) {
        // The ownership guard and row transition share the same writer unit.
        return this.data.uow.transact(
            () => {
                const open = this.db
                    .select({ id: jobRuns.id })
                    .from(jobRuns)
                    .where(inArray(jobRuns.status, OPEN))
                    .all();
                for (const { id } of open) {
                    recover(id, () => {
                        this.db
                            .update(jobRuns)
                            .set({ status: 'interrupted', finishedAt: now, error })
                            .where(and(eq(jobRuns.id, id), inArray(jobRuns.status, OPEN)))
                            .run();
                    });
                }
            },
            { label: 'recover orphan job runs' },
        );
    }

    async counts() {
        const rows = await this.db
            .select()
            .from(jobRunCounts)
            .where(gt(jobRunCounts.n, 0))
            .orderBy(jobRunCounts.status)
            .all();
        return Object.fromEntries(rows.map((row) => [row.status, row.n]));
    }
}
