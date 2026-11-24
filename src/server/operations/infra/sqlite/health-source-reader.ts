import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type {
    HealthSourceReader,
    KeysetMark,
    SourceGoal,
    SourceJobRun,
    SourceLongRun,
    SourceSchedule,
    SourceTaskRun,
} from '../../etl/health-source.js';

const readers = new WeakMap<DatabaseSync, SqliteHealthSourceReader>();

/**
 * Health's reads of the app's database (CB-192), on the analytics
 * process's read-only connection, like `sqliteSourceReader`: one
 * statement each, never the job runs' output columns. One per connection.
 */
export function sqliteHealthSourceReader(db: DatabaseSync): HealthSourceReader {
    let reader = readers.get(db);
    if (!reader) {
        readers.set(db, (reader = new SqliteHealthSourceReader(db)));
    }
    return reader;
}

const JOB_RUN = `SELECT id, jobId, dotId, userId, trigger, scheduleId, longRunId,
  status, queuedAt, startedAt, wakeMs, finishedAt FROM job_runs`;
// Only schedules' runs: a schedule has a cadence or repeats.
const TASK_RUN = `SELECT r.id, r.taskId, r.status, r.dueAt, r.startedAt, r.finishedAt
  FROM runs r JOIN tasks t ON t.id = r.taskId
  WHERE (t.cadence IS NOT NULL OR t.intervalSeconds IS NOT NULL)`;

class SqliteHealthSourceReader implements HealthSourceReader {
    private statements = new Map<string, StatementSync>();
    constructor(private db: DatabaseSync) {}

    private statement(sql: string) {
        let statement = this.statements.get(sql);
        if (!statement) {
            this.statements.set(sql, (statement = this.db.prepare(sql)));
        }
        return statement;
    }
    private has(...tables: string[]) {
        return tables.every(
            (table) => !!this.statement("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
        );
    }

    hasJobs() {
        return this.has('job_runs', 'job_long_runs', 'job_items', 'jobs', 'goals');
    }
    hasTasks() {
        return this.has('tasks', 'runs');
    }

    jobRunsAfter(mark: KeysetMark, limit: number) {
        return this.statement(
            `${JOB_RUN} WHERE queuedAt > ? OR (queuedAt = ? AND id > ?) ORDER BY queuedAt, id LIMIT ?`,
        ).all(mark.at, mark.at, mark.id, limit) as unknown as SourceJobRun[];
    }
    jobRunsById(ids: readonly string[]) {
        if (!ids.length) {
            return [];
        }
        return this.statement(`${JOB_RUN} WHERE id IN (SELECT value FROM json_each(?)) ORDER BY queuedAt, id`).all(
            JSON.stringify(ids),
        ) as unknown as SourceJobRun[];
    }

    taskRunsAfter(mark: KeysetMark, limit: number) {
        return this.statement(
            `${TASK_RUN} AND (r.startedAt > ? OR (r.startedAt = ? AND r.id > ?)) ORDER BY r.startedAt, r.id LIMIT ?`,
        ).all(mark.at, mark.at, mark.id, limit) as unknown as SourceTaskRun[];
    }
    taskRunsById(ids: readonly string[]) {
        if (!ids.length) {
            return [];
        }
        return this.statement(
            `${TASK_RUN} AND r.id IN (SELECT value FROM json_each(?)) ORDER BY r.startedAt, r.id`,
        ).all(JSON.stringify(ids)) as unknown as SourceTaskRun[];
    }

    schedules() {
        return this.statement(
            `SELECT id, title, dotId, userId, kind, status, cadence, nextRunAt, lastRunAt,
        updatedAt, substr(error, 1, 200) AS error
      FROM tasks
      WHERE deletedAt IS NULL AND (cadence IS NOT NULL OR intervalSeconds IS NOT NULL)
      ORDER BY id`,
        ).all() as unknown as SourceSchedule[];
    }

    goals() {
        return this.statement(
            'SELECT id, dotId, userId, scheduleId, status, createdAt, updatedAt, closedAt FROM goals ORDER BY id',
        ).all() as unknown as SourceGoal[];
    }

    longRuns() {
        return this.statement(
            `SELECT l.id, l.jobId, j.name AS jobName, l.dotId, l.userId, l.status, l.batches,
        l.retries, l.createdAt, l.updatedAt, l.finishedAt,
        substr(l.waitReason, 1, 200) AS waitReason, substr(l.lastError, 1, 200) AS lastError
      FROM job_long_runs l LEFT JOIN jobs j ON j.id = l.jobId
      ORDER BY l.id`,
        ).all() as unknown as SourceLongRun[];
    }

    itemCounts(longRunIds: readonly string[]) {
        if (!longRunIds.length) {
            return [];
        }
        // `job_items_status` (longRunId, status, nextAt) covers this.
        return this.statement(
            `SELECT longRunId, status, count(*) AS n FROM job_items
      WHERE longRunId IN (SELECT value FROM json_each(?))
      GROUP BY longRunId, status`,
        ).all(JSON.stringify(longRunIds)) as unknown as {
            longRunId: string;
            status: string;
            n: number;
        }[];
    }
}
