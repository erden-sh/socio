/**
 * The analytics store's tables for Health (CB-192), beside CB-187's
 * (`schema.ts`): model rounds from the turns' traces, job and scheduled
 * runs read incrementally, and copies of the schedules, goals and long
 * runs as they are now. A change here needs `ETL_VERSION` bumped.
 */

/** One row per model round of a turn (`trace.rounds`, not summaries). */
export const ROUND_DDL = `CREATE TABLE f_round (
  run_seq BIGINT NOT NULL,
  run_id VARCHAR NOT NULL,
  round INTEGER NOT NULL,
  socio_id VARCHAR,
  source VARCHAR NOT NULL,
  trigger_kind VARCHAR NOT NULL,
  trigger_id VARCHAR,
  model VARCHAR,
  started_at BIGINT NOT NULL,
  duration_ms BIGINT NOT NULL,
  first_output_ms BIGINT,
  reasoning_kind VARCHAR NOT NULL
)`;

/** One row per job run (`job_runs`), without its output. */
export const JOB_RUN_DDL = `CREATE TABLE f_job_run (
  id VARCHAR NOT NULL,
  job_id VARCHAR NOT NULL,
  socio_id VARCHAR,
  person_id VARCHAR,
  trigger VARCHAR NOT NULL,
  schedule_id VARCHAR,
  long_run_id VARCHAR,
  status VARCHAR NOT NULL,
  queued_at BIGINT NOT NULL,
  started_at BIGINT,
  wake_ms BIGINT,
  finished_at BIGINT
)`;

/** One row per scheduled run (`runs` of a schedule's task). */
export const TASK_RUN_DDL = `CREATE TABLE f_task_run (
  id VARCHAR NOT NULL,
  task_id VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  due_at BIGINT,
  started_at BIGINT NOT NULL,
  finished_at BIGINT
)`;

/**
 * Copies as of the last cycle, rewritten when they change: live schedules
 * with their state (`scheduleState`), goals with theirs, long runs with
 * their items counted, and job names.
 */
export const SNAPSHOT_DDL = [
    `CREATE TABLE s_schedule (id VARCHAR PRIMARY KEY, title VARCHAR, socio_id VARCHAR, person_id VARCHAR, kind VARCHAR, status VARCHAR NOT NULL, state VARCHAR NOT NULL, cadence VARCHAR, next_run_at BIGINT, last_run_at BIGINT, updated_at BIGINT NOT NULL, error VARCHAR)`,
    `CREATE TABLE s_goal (id VARCHAR PRIMARY KEY, socio_id VARCHAR, person_id VARCHAR, schedule_id VARCHAR, status VARCHAR NOT NULL, state VARCHAR NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, closed_at BIGINT)`,
    `CREATE TABLE s_long_run (id VARCHAR PRIMARY KEY, job_id VARCHAR NOT NULL, job_name VARCHAR, socio_id VARCHAR, person_id VARCHAR, status VARCHAR NOT NULL, batches INTEGER NOT NULL, retries INTEGER NOT NULL, items_done INTEGER NOT NULL, items_dead INTEGER NOT NULL, items_pending INTEGER NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, finished_at BIGINT, wait_reason VARCHAR, last_error VARCHAR)`,
];
