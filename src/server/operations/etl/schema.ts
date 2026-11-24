/**
 * The analytics store's facts, dimensions and rollups (CB-164,
 * CB-187). Times are ms since the epoch (BIGINT); AT is a DuckDB keyword,
 * so no column is called that. Fact tables have no keys: each batch
 * deletes the rows it rewrites (by the turn's `seq`) and appends them
 * again, which keeps it idempotent without DuckDB's index costs. A change
 * here needs `ETL_VERSION` bumped (`analytics/steps.ts`): the file is then
 * rebuilt from SQLite.
 */

/**
 * One row per turn (`agent_runs`). `failure_category` and `failure_rule`
 * are the failure taxonomy's (CB-189, `packages/shared/src/failure-taxonomy.ts`) over
 * the turn's raw codes kept beside them (`status`, `end_reason`,
 * `failure_code`, `last_stop`, `fallback_reason`, `has_detail`), so a new
 * `TAXONOMY_VERSION` re-runs the rules here without a rebuild. The cost
 * columns (CB-195, CB-196) are the `cost` step's, null until it priced the
 * turn: `cost_backend` the backend it is priced by, `cost_usd` and
 * `cost_basis` (`price`, `pool` or `none`), `cost_source` the price's
 * origin, and `ref_cost_usd` a pooled turn at the cheapest cloud price.
 *
 * Rooms (CB-218): `container_kind` is where it ran then (`person`, `team`
 * or `room`); `cycle_id` and `hop` its work cycle (CB-211); `acting_id`
 * whose access it used; `payer_kind` (`person` or `workspace`) and
 * `payer_id` who paid. Null where the turn recorded no cycle: unknown,
 * never filled in from the chat's owner. `socio_id` is the socio that ran
 * the turn, so a room with several socios (CB-206) has a row per socio's
 * step with no change here.
 */
export const TURN_DDL = `CREATE TABLE f_turn (
  seq BIGINT NOT NULL,
  run_id VARCHAR NOT NULL,
  thread_id VARCHAR NOT NULL,
  socio_id VARCHAR,
  source VARCHAR NOT NULL,
  trigger_kind VARCHAR NOT NULL,
  trigger_id VARCHAR,
  attribution VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  end_reason VARCHAR,
  failure_code VARCHAR,
  received_at BIGINT,
  started_at BIGINT NOT NULL,
  finished_at BIGINT,
  rounds INTEGER NOT NULL,
  input_tokens BIGINT,
  output_tokens BIGINT,
  cached_tokens BIGINT,
  reasoning_tokens BIGINT,
  reasoning_kind VARCHAR NOT NULL,
  reasoning_tokens_reported BOOLEAN NOT NULL,
  model VARCHAR,
  backend_key VARCHAR,
  tool_calls INTEGER NOT NULL,
  tool_errors INTEGER NOT NULL,
  tool_refusals INTEGER NOT NULL,
  approval_waits INTEGER NOT NULL,
  person_waits INTEGER NOT NULL,
  retries INTEGER NOT NULL,
  fallback_reason VARCHAR,
  last_stop VARCHAR,
  has_detail BOOLEAN NOT NULL,
  failure_category VARCHAR,
  failure_rule VARCHAR,
  backend_id VARCHAR,
  cost_backend VARCHAR,
  cost_usd DOUBLE,
  cost_basis VARCHAR,
  cost_source VARCHAR,
  ref_cost_usd DOUBLE,
  container_kind VARCHAR NOT NULL,
  cycle_id VARCHAR,
  hop INTEGER,
  acting_id VARCHAR,
  payer_kind VARCHAR,
  payer_id VARCHAR
)`;

/**
 * One row per message a turn added, with its author: several people and
 * socios can write in one chat. The turn's socio and source are copied in,
 * so filters need no join.
 */
export const MESSAGE_DDL = `CREATE TABLE f_message (
  run_seq BIGINT NOT NULL,
  message_id VARCHAR NOT NULL,
  run_id VARCHAR NOT NULL,
  thread_id VARCHAR NOT NULL,
  socio_id VARCHAR,
  source VARCHAR NOT NULL,
  sent_at BIGINT NOT NULL,
  author_kind VARCHAR NOT NULL,
  author_id VARCHAR,
  attribution VARCHAR NOT NULL,
  chars INTEGER,
  attachments INTEGER NOT NULL
)`;

/** One row per tool call (`trace.tools`), with its failure category (CB-189). */
export const TOOL_DDL = `CREATE TABLE f_tool (
  run_seq BIGINT NOT NULL,
  run_id VARCHAR NOT NULL,
  idx INTEGER NOT NULL,
  thread_id VARCHAR NOT NULL,
  socio_id VARCHAR,
  source VARCHAR NOT NULL,
  trigger_kind VARCHAR NOT NULL,
  trigger_id VARCHAR,
  round INTEGER NOT NULL,
  tool VARCHAR NOT NULL,
  outcome VARCHAR NOT NULL,
  code VARCHAR,
  started_at BIGINT NOT NULL,
  duration_ms BIGINT NOT NULL,
  category VARCHAR,
  category_rule VARCHAR
)`;

/**
 * Who took part in each chat (derived from the facts, per chat the batch
 * touched): every author, whoever started turns, and each socio that ran
 * them. `turns` are the turns they started (a socio: ran); `acting` the
 * turns that used a person's access and `paid` those billed to them
 * (CB-218): in a room both are the person who started the turn, so two
 * people and two socios keep a row each and no turn counts twice.
 */
export const PARTICIPANT_DDL = `CREATE TABLE f_participant (
  thread_id VARCHAR NOT NULL,
  kind VARCHAR NOT NULL,
  id VARCHAR NOT NULL,
  first_at BIGINT NOT NULL,
  last_at BIGINT NOT NULL,
  messages INTEGER NOT NULL,
  turns INTEGER NOT NULL,
  acting INTEGER NOT NULL,
  paid INTEGER NOT NULL
)`;

/**
 * One row per work cycle (CB-211's `work_cycles`, CB-218): one person's
 * message and every step it led to. `kind` private or room; who started
 * it, whose access it used and who paid; `socio_id` the socio of its last
 * step; `elapsed_ms` the time its steps ran (waits between steps, such as
 * an approval, left out; `ended_at - started_at` is the wall time);
 * `steps` its turns and `handoffs` the steps after the first; its
 * tokens and spend as its ledger counted them (`cost_usd` null when a
 * request reported none: unknown, never 0); the limits it started with;
 * and `end_reason`, a limit (`deadline`, `tokens`, `handoffs`,
 * `spend`) when one stopped it. Never its message.
 */
export const CYCLE_DDL = `CREATE TABLE f_cycle (
  id VARCHAR NOT NULL,
  thread_id VARCHAR NOT NULL,
  kind VARCHAR NOT NULL,
  initiator_kind VARCHAR NOT NULL,
  initiator_id VARCHAR,
  acting_id VARCHAR NOT NULL,
  socio_id VARCHAR NOT NULL,
  payer_kind VARCHAR,
  payer_id VARCHAR,
  status VARCHAR NOT NULL,
  started_at BIGINT NOT NULL,
  ended_at BIGINT,
  elapsed_ms BIGINT NOT NULL,
  steps INTEGER NOT NULL,
  handoffs INTEGER NOT NULL,
  tokens_used BIGINT NOT NULL,
  cost_usd DOUBLE,
  cost_known BOOLEAN NOT NULL,
  token_limit BIGINT,
  spend_limit DOUBLE,
  end_reason VARCHAR
)`;

export const DIMENSION_DDL = [
    `CREATE TABLE d_person (id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL, role VARCHAR NOT NULL, created_at BIGINT NOT NULL)`,
    `CREATE TABLE d_socio (id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL, space_id VARCHAR NOT NULL, owner_id VARCHAR, created_at BIGINT NOT NULL, archived_at BIGINT, deleted_at BIGINT)`,
    `CREATE TABLE d_space (id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL, created_at BIGINT NOT NULL, deleted_at BIGINT)`,
    // owner_kind: person, team (a shared Telegram topic's owner) or room
    // (CB-218: its owner is the room itself, `room:<id>`). title: a room's
    // name only, never a private chat's title.
    `CREATE TABLE d_chat (id VARCHAR PRIMARY KEY, socio_id VARCHAR NOT NULL, owner_id VARCHAR NOT NULL, owner_kind VARCHAR NOT NULL, title VARCHAR, created_at BIGINT NOT NULL, archived_at BIGINT, deleted_at BIGINT)`,
    // The source registry, and every key the facts hold (unknown ones too).
    `CREATE TABLE d_source (key VARCHAR PRIMARY KEY, label VARCHAR NOT NULL, kind VARCHAR NOT NULL, channel VARCHAR NOT NULL)`,
];

/**
 * The reporting time zone's buckets (`etl/calendar.ts`), and the rollups
 * cut by them: recomputed per batch for the buckets it touched, and in
 * full when the time zone changes. Hourly ones are kept `hourlyDays`.
 * `person_id` is who started the turns (when a person did) and who wrote
 * the messages, as the Overview's person filter reads them.
 */
export const ROLLUP_DDL = [
    `CREATE TABLE d_calendar (utc_at BIGINT NOT NULL, hour_at BIGINT NOT NULL, day_at BIGINT NOT NULL, week_at BIGINT NOT NULL, month_at BIGINT NOT NULL)`,
    `CREATE TABLE r_hourly (hour_at BIGINT NOT NULL, socio_id VARCHAR, source VARCHAR NOT NULL, person_id VARCHAR, turns INTEGER NOT NULL, failed INTEGER NOT NULL, tokens BIGINT NOT NULL, messages INTEGER NOT NULL)`,
    `CREATE TABLE r_daily (day_at BIGINT NOT NULL, week_at BIGINT NOT NULL, month_at BIGINT NOT NULL, socio_id VARCHAR, source VARCHAR NOT NULL, person_id VARCHAR, turns INTEGER NOT NULL, failed INTEGER NOT NULL, tokens BIGINT NOT NULL, messages INTEGER NOT NULL)`,
];
