import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * The Scheduling and jobs context's tasks (CB-110): `tasks`, `runs` and
 * `events` were made by `core` 1 to 3, and `task_threads` by `workspace` 1,
 * which stay as they are, frozen. Version 1 is a baseline of the tables as
 * they are: on a database that has them, the runner adopts it without
 * running it (one `schema_migrations` row, no data change). Core and the
 * workspace migrate first, so where it runs instead (a fresh database) its
 * `IF NOT EXISTS` finds everything made already and changes nothing; it
 * only makes the tables on a database migrated with this set alone.
 * Changes to these tables come here from now on, as version 2 and up.
 */
export const scheduleTasksSchema: SchemaSet = {
    id: 'schedule-tasks',
    migrations: [
        {
            version: 1,
            name: 'baseline',
            baseline: true,
            up: `CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, intervalSeconds INTEGER, nextRunAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, error TEXT, lease TEXT, leaseUntil INTEGER, userId TEXT, title TEXT, cadence TEXT, timezone TEXT, dotId TEXT, kind TEXT, jobId TEXT, origin TEXT, lastRunAt INTEGER, deletedAt INTEGER, deletedBy TEXT, deletedWith TEXT);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, taskId TEXT NOT NULL, status TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER, result TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL, runId TEXT, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_threads(taskId TEXT PRIMARY KEY, threadId TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status, nextRunAt);
      CREATE INDEX IF NOT EXISTS tasks_user ON tasks(userId, createdAt);
      CREATE INDEX IF NOT EXISTS runs_task ON runs(taskId, startedAt);
      CREATE INDEX IF NOT EXISTS events_task ON events(taskId, id);`,
        },
        {
            version: 2,
            name: 'run due times',
            // CB-185: when a task's run came due (its schedule's time, or when
            // it was queued), so how late it started is kept. Runs from before
            // have none.
            up: 'ALTER TABLE runs ADD COLUMN dueAt INTEGER',
        },
    ],
};

/**
 * Jobs. A job's code is not here: each version's files are in the
 * owner's data space, `dots/<dotId>/jobs/<jobId>/v<version>/<path>`
 * (encrypted at rest); a version records their paths, sizes and digest,
 * which a run checks before copying them into the computer. Schedules are
 * tasks (`tasks`, `scheduleTasksSchema`); a goal is worked on by one (v5).
 * A job that runs until done keeps its long runs and items here too (v8).
 * The repositories in `infra/sqlite` are the only code on these tables.
 */
export const schedulesSchema: SchemaSet = {
    id: MODULE_IDS.schedules,
    migrations: [
        {
            version: 1,
            name: 'jobs',
            up: `CREATE TABLE jobs(id TEXT PRIMARY KEY, userId TEXT NOT NULL, dotId TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, UNIQUE(userId, dotId, name));
      CREATE TABLE job_versions(jobId TEXT NOT NULL, version INTEGER NOT NULL, entry TEXT NOT NULL, files TEXT NOT NULL, digest TEXT NOT NULL, timeoutSeconds INTEGER NOT NULL, datasets TEXT NOT NULL, approvalId TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY(jobId, version));
      CREATE TABLE job_runs(id TEXT PRIMARY KEY, jobId TEXT NOT NULL, version INTEGER NOT NULL, userId TEXT NOT NULL, dotId TEXT NOT NULL, trigger TEXT NOT NULL, scheduleId TEXT, status TEXT NOT NULL, queuedAt INTEGER NOT NULL, startedAt INTEGER, wakeMs INTEGER, finishedAt INTEGER, exitCode INTEGER, stdout TEXT, stderr TEXT, error TEXT);
      CREATE INDEX job_runs_job ON job_runs(jobId, queuedAt);
      CREATE INDEX job_runs_user ON job_runs(userId, queuedAt);
      CREATE INDEX job_runs_schedule ON job_runs(scheduleId, queuedAt);`,
        },
        {
            // CB-64: deleting a job hides it and keeps it with its versions and
            // runs. The name must be free again for a new job, so the inline
            // UNIQUE becomes a partial index over live jobs; SQLite can't drop a
            // table constraint in place, so the table is rebuilt.
            version: 2,
            name: 'soft delete',
            up: `CREATE TABLE jobs_v2(id TEXT PRIMARY KEY, userId TEXT NOT NULL, dotId TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, deletedAt INTEGER, deletedBy TEXT);
      INSERT INTO jobs_v2(id, userId, dotId, name, version, createdAt, updatedAt) SELECT id, userId, dotId, name, version, createdAt, updatedAt FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_v2 RENAME TO jobs;
      CREATE UNIQUE INDEX jobs_name ON jobs(userId, dotId, name) WHERE deletedAt IS NULL;`,
        },
        {
            // Every run is kept (it used to keep the newest keepRuns per job).
            // Past them, a run's stdout and stderr are emptied and
            // `outputTrimmedAt` says when, so "not kept" isn't confused with a
            // run that never had output. Runs whose output is still there are
            // few per job; the partial index finds them without reading the
            // rest.
            version: 3,
            name: 'keep runs, trim output',
            up: `ALTER TABLE job_runs ADD COLUMN outputTrimmedAt INTEGER;
      CREATE INDEX job_runs_untrimmed ON job_runs(jobId, queuedAt) WHERE outputTrimmedAt IS NULL;`,
        },
        {
            // With every run kept, counting runs by status for the operators'
            // counts would read the whole table on each poll (31 ms at 100,000
            // runs). Triggers keep the counts instead, whoever writes the runs.
            version: 4,
            name: 'run counts',
            up: `CREATE TABLE job_run_counts(status TEXT PRIMARY KEY, n INTEGER NOT NULL);
      INSERT INTO job_run_counts(status, n) SELECT status, COUNT(*) FROM job_runs GROUP BY status;
      CREATE TRIGGER job_run_counts_insert AFTER INSERT ON job_runs BEGIN
        INSERT INTO job_run_counts(status, n) VALUES (NEW.status, 1) ON CONFLICT(status) DO UPDATE SET n = n + 1;
      END;
      CREATE TRIGGER job_run_counts_update AFTER UPDATE OF status ON job_runs WHEN OLD.status IS NOT NEW.status BEGIN
        UPDATE job_run_counts SET n = n - 1 WHERE status = OLD.status;
        INSERT INTO job_run_counts(status, n) VALUES (NEW.status, 1) ON CONFLICT(status) DO UPDATE SET n = n + 1;
      END;
      CREATE TRIGGER job_run_counts_delete AFTER DELETE ON job_runs BEGIN
        UPDATE job_run_counts SET n = n - 1 WHERE status = OLD.status;
      END;`,
        },
        {
            // Persistent goals: a person's goal for a Dot, worked on by its
            // schedule (`scheduleId`, a task) until done or canceled. The person
            // and the Dot are both required.
            version: 5,
            name: 'goals',
            up: `CREATE TABLE goals(id TEXT PRIMARY KEY, userId TEXT NOT NULL CHECK(length(userId) > 0), dotId TEXT NOT NULL CHECK(length(dotId) > 0), title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', scheduleId TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('active','done','cancelled')), progress TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, closedAt INTEGER);
      CREATE INDEX goals_user ON goals(userId, dotId, createdAt);`,
        },
        {
            // A Dot's job runs and goals by time (the admins' Dots page).
            version: 6,
            name: 'by dot',
            up: `CREATE INDEX job_runs_dot ON job_runs(dotId, queuedAt);
      CREATE INDEX goals_dot ON goals(dotId, createdAt);`,
        },
        {
            // CB-135: a goal's comment thread. The person or the Dot wrote each
            // one (authorId is the user or the Dot); they go with the goal.
            version: 7,
            name: 'goal comments',
            up: `CREATE TABLE goal_comments(id TEXT PRIMARY KEY, goalId TEXT NOT NULL, authorKind TEXT NOT NULL CHECK(authorKind IN ('person','dot')), authorId TEXT NOT NULL CHECK(length(authorId) > 0), body TEXT NOT NULL CHECK(length(body) > 0), createdAt INTEGER NOT NULL);
      CREATE INDEX goal_comments_goal ON goal_comments(goalId, createdAt);`,
        },
        {
            // CB-122: jobs that run until done. A version says whether it does
            // (`untilDone`); such a job's run is a long run, owned by the server,
            // that starts batches (job runs, `longRunId`) until its job says it
            // is complete, resuming from its checkpoint and items after a stop.
            // An item is done once: a batch claims it, and only that batch marks
            // it done or failed. At most one long run of a job is open.
            version: 8,
            name: 'long runs',
            up: `ALTER TABLE job_versions ADD COLUMN untilDone INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE job_runs ADD COLUMN longRunId TEXT;
      CREATE INDEX job_runs_long ON job_runs(longRunId, queuedAt) WHERE longRunId IS NOT NULL;
      CREATE TABLE job_long_runs(id TEXT PRIMARY KEY, jobId TEXT NOT NULL, userId TEXT NOT NULL CHECK(length(userId) > 0), dotId TEXT NOT NULL CHECK(length(dotId) > 0), trigger TEXT NOT NULL, scheduleId TEXT, threadId TEXT, status TEXT NOT NULL CHECK(status IN ('running','waiting','done','failed','cancelled')), batches INTEGER NOT NULL DEFAULT 0, retries INTEGER NOT NULL DEFAULT 0, sealed INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, checkpoint TEXT, checkpointAt INTEGER, currentRunId TEXT, nextAt INTEGER, waitReason TEXT, mark TEXT, lastError TEXT, jobSummary TEXT, outcome TEXT, reportedAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, finishedAt INTEGER);
      CREATE INDEX job_long_runs_job ON job_long_runs(jobId, createdAt);
      CREATE UNIQUE INDEX job_long_runs_open ON job_long_runs(jobId) WHERE status IN ('running','waiting');
      CREATE TABLE job_items(id INTEGER PRIMARY KEY, longRunId TEXT NOT NULL, key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 200), status TEXT NOT NULL CHECK(status IN ('pending','claimed','done','dead')), attempts INTEGER NOT NULL DEFAULT 0, claimedBy TEXT, nextAt INTEGER, error TEXT, updatedAt INTEGER NOT NULL, doneAt INTEGER, UNIQUE(longRunId, key));
      CREATE INDEX job_items_status ON job_items(longRunId, status, nextAt);`,
        },
    ],
};
