import type { DuckDBConnection } from '@duckdb/node-api';

import { bucketStarts, type OpsFilters } from '@socio/shared/operations/operations';
import {
    GOAL_STATES,
    HEALTH_REASONING_KINDS,
    HEALTH_TOP,
    SCHEDULE_LATE_MS,
    SCHEDULE_STATES,
    type CoverageRow,
    type GoalState,
    type HealthFacts,
    type HealthLongRunRow,
    type HealthMetric,
    type HealthReasoningKind,
    type HealthRunRow,
    type HealthScheduleRow,
    type LatencyRow,
    type ReasoningRow,
    type ScheduleState,
    type Spread,
    type TokenRow,
} from '@socio/shared/operations/operations-health';

import type { OpsQueries, OpsQueryParams } from '../../domain/ops-queries.js';

import { rows } from './open.js';
import { earliest, range, spaceFilter, Sql, turnFilters } from './sql.js';

type HealthQueries = Pick<OpsQueries, 'health' | 'healthSeries' | 'healthSchedules' | 'healthRuns' | 'healthLongRuns'>;

const spreadSql = (value: string) =>
    `count(${value}) AS n, quantile_disc(${value}, 0.5)::BIGINT AS p50,
  quantile_disc(${value}, 0.95)::BIGINT AS p95`;

const spreadOf = (row: Partial<Spread> | undefined): Spread => ({
    n: Number(row?.n ?? 0),
    p50: row?.p50 ?? null,
    p95: row?.p95 ?? null,
});

/**
 * Filters on what a socio does for a person outside turns (job runs,
 * schedules, goals, long runs): the socio, its Space, the person. Sources
 * are a turn's, so they don't narrow these.
 */
function ownedFilters(sql: Sql, filters: OpsFilters, alias = '') {
    return [
        ...(filters.socio ? [`${alias}socio_id = ${sql.text(filters.socio)}`] : []),
        ...(filters.space ? [spaceFilter(sql, `${alias}socio_id`, filters.space)] : []),
        ...(filters.person ? [`${alias}person_id = ${sql.text(filters.person)}`] : []),
    ];
}

/** Scheduled runs narrowed by their schedule's socio, Space and person. */
function taskRunFilters(sql: Sql, filters: OpsFilters, column = 'task_id') {
    const owned = ownedFilters(sql, filters);
    return owned.length ? [`${column} IN (SELECT id FROM s_schedule WHERE ${owned.join(' AND ')})`] : [];
}

const where = (parts: string[]) => parts.join(' AND ') || 'true';

/** Whether the store holds any data to answer from. */
async function hasData(connection: DuckDBConnection) {
    const [row] = await rows<{ n: number }>(
        connection,
        `SELECT (SELECT count(*) FROM f_turn) + (SELECT count(*) FROM f_job_run)
      + (SELECT count(*) FROM s_schedule) + (SELECT count(*) FROM s_long_run) AS n`,
    );
    return Number(row?.n ?? 0) > 0;
}

/**
 * Health's analytics SQL (CB-192), on the analytics process's connection.
 * Percentiles are DuckDB's `quantile_disc` (nearest rank: a duration
 * that happened, never one made up between two); breakdowns are the `HEALTH_TOP` largest,
 * ties by key. Reasoning tokens are added up only within one kind and
 * only for turns whose model reported them.
 */
export function duckHealthQueries(connection: DuckDBConnection): HealthQueries {
    return {
        async health({ window, filters }) {
            if (!(await hasData(connection))) {
                return null;
            }
            const { from, to } = window;
            const turnWhere = (sql: Sql, column = 'started_at') =>
                where([...range(sql, column, from, to), ...turnFilters(sql, filters)]);

            const tokenRows = async (key: string, name: string, join: string, extra: string[] = []) => {
                const sql = new Sql();
                return (
                    await rows<TokenRow>(
                        connection,
                        `SELECT ${key} AS key, ${name} AS name, count(*)::BIGINT AS turns,
              COALESCE(sum(t.input_tokens), 0)::BIGINT AS input,
              COALESCE(sum(t.output_tokens), 0)::BIGINT AS output,
              COALESCE(sum(t.cached_tokens), 0)::BIGINT AS cached
            FROM f_turn t ${join}
            WHERE ${where([...range(sql, 't.started_at', from, to), ...turnFilters(sql, filters, 't.'), ...extra])}
            GROUP BY 1, 2
            ORDER BY (COALESCE(sum(t.input_tokens), 0) + COALESCE(sum(t.output_tokens), 0)) DESC, 1
            LIMIT ${HEALTH_TOP}`,
                        sql.values,
                    )
                ).map(numbers);
            };
            const byModel = await tokenRows(`COALESCE(t.model, 'unknown')`, 'NULL', '');
            const bySocio = await tokenRows('t.socio_id', 's.name', 'LEFT JOIN d_socio s ON s.id = t.socio_id', [
                't.socio_id IS NOT NULL',
            ]);
            const byPerson = await tokenRows('t.trigger_id', 'p.name', 'LEFT JOIN d_person p ON p.id = t.trigger_id', [
                `t.trigger_kind = 'person'`,
                't.trigger_id IS NOT NULL',
            ]);

            let sql = new Sql();
            const reasoning = await rows<{
                kind: string;
                turns: number;
                output: number;
                reported_turns: number;
                reasoning: number | null;
            }>(
                connection,
                `SELECT reasoning_kind AS kind, count(*)::BIGINT AS turns,
          COALESCE(sum(output_tokens), 0)::BIGINT AS output,
          count(*) FILTER (WHERE reasoning_tokens_reported)::BIGINT AS reported_turns,
          sum(reasoning_tokens) FILTER (WHERE reasoning_tokens_reported)::BIGINT AS reasoning
        FROM f_turn WHERE ${turnWhere(sql)} GROUP BY 1`,
                sql.values,
            );
            const byReasoning: ReasoningRow[] = HEALTH_REASONING_KINDS.flatMap((kind) => {
                // A kind the facts hold that this list doesn't know counts as unknown.
                const found = reasoning.filter((row) =>
                    kind === 'unknown'
                        ? !(HEALTH_REASONING_KINDS as readonly string[]).includes(row.kind) || row.kind === 'unknown'
                        : row.kind === kind,
                );
                if (!found.length) {
                    return [];
                }
                const reported = found.reduce((sum, row) => sum + Number(row.reported_turns), 0);
                return [
                    {
                        kind: kind as HealthReasoningKind,
                        turns: found.reduce((sum, row) => sum + Number(row.turns), 0),
                        output: found.reduce((sum, row) => sum + Number(row.output), 0),
                        reportedTurns: reported,
                        reasoning: reported ? found.reduce((sum, row) => sum + Number(row.reasoning ?? 0), 0) : null,
                    },
                ];
            });

            const spread = async (sql: Sql, value: string, from: string, at: string) =>
                spreadOf(
                    (
                        await rows<Spread>(
                            connection,
                            `SELECT ${spreadSql(value)} FROM ${from} WHERE ${at}`,
                            sql.values,
                        )
                    )[0],
                );
            const latencyRows = async (
                sql: Sql,
                key: string,
                value: string,
                errors: string,
                table: string,
                at: string,
            ) =>
                (
                    await rows<LatencyRow>(
                        connection,
                        `SELECT ${key} AS key, ${spreadSql(value)}, (${errors})::BIGINT AS errors
            FROM ${table} WHERE ${at} GROUP BY 1
            ORDER BY count(${value}) DESC, 1 LIMIT ${HEALTH_TOP}`,
                        sql.values,
                    )
                ).map((row) => ({
                    ...spreadOf(row),
                    key: row.key,
                    errors: Number(row.errors),
                }));

            sql = new Sql();
            const roundWhere = `${turnWhere(sql)} AND first_output_ms IS NOT NULL`;
            const firstOutput = await spread(sql, 'first_output_ms', 'f_round', roundWhere);
            const firstOutputByModel = await latencyRows(
                sql,
                `COALESCE(model, 'unknown')`,
                'first_output_ms',
                '0',
                'f_round',
                roundWhere,
            );
            sql = new Sql();
            const toolWhere = turnWhere(sql);
            const tools = await spread(sql, 'duration_ms', 'f_tool', toolWhere);
            const byTool = await latencyRows(
                sql,
                'tool',
                'duration_ms',
                `count(*) FILTER (WHERE outcome IN ('error', 'timeout'))`,
                'f_tool',
                toolWhere,
            );

            sql = new Sql();
            const turnQueue = await spread(
                sql,
                'started_at - received_at',
                'f_turn',
                `${turnWhere(sql)} AND received_at IS NOT NULL AND received_at <= started_at`,
            );
            sql = new Sql();
            const jobWhere = where([...range(sql, 'queued_at', from, to), ...ownedFilters(sql, filters)]);
            const jobWait = await spread(
                sql,
                'started_at - queued_at',
                'f_job_run',
                `${jobWhere} AND started_at IS NOT NULL AND started_at >= queued_at`,
            );
            const jobWake = await spread(sql, 'wake_ms', 'f_job_run', `${jobWhere} AND wake_ms IS NOT NULL`);
            const [jobs] = await rows<{ total: number; failed: number }>(
                connection,
                `SELECT count(*)::BIGINT AS total,
          count(*) FILTER (WHERE status IN ('failed', 'timed_out', 'interrupted'))::BIGINT AS failed
        FROM f_job_run WHERE ${jobWhere}`,
                sql.values,
            );
            sql = new Sql();
            const taskWhere = where([...range(sql, 'started_at', from, to), ...taskRunFilters(sql, filters)]);
            const scheduleLate = await spread(
                sql,
                'greatest(started_at - due_at, 0)',
                'f_task_run',
                `${taskWhere} AND due_at IS NOT NULL`,
            );
            const late = sql.int(SCHEDULE_LATE_MS);
            const [taskRuns] = await rows<{
                runs: number;
                failed: number;
                late: number;
                due: number;
            }>(
                connection,
                `SELECT count(*)::BIGINT AS runs,
          count(*) FILTER (WHERE status IN ('failed', 'interrupted'))::BIGINT AS failed,
          count(*) FILTER (WHERE due_at IS NOT NULL AND started_at - due_at > ${late})::BIGINT AS late,
          count(due_at)::BIGINT AS due
        FROM f_task_run WHERE ${taskWhere}`,
                sql.values,
            );

            sql = new Sql();
            const scheduleStates = await rows<{ state: string; n: number }>(
                connection,
                `SELECT state, count(*)::BIGINT AS n FROM s_schedule
        WHERE ${where(ownedFilters(sql, filters))} GROUP BY 1`,
                sql.values,
            );
            sql = new Sql();
            const goalWhere = where(ownedFilters(sql, filters));
            const goalStates = await rows<{ state: string; n: number }>(
                connection,
                `SELECT state, count(*)::BIGINT AS n FROM s_goal WHERE ${goalWhere} GROUP BY 1`,
                sql.values,
            );
            const closed = where(range(sql, 'closed_at', from, to));
            const [goalsClosed] = await rows<{ done: number; cancelled: number }>(
                connection,
                `SELECT count(*) FILTER (WHERE status = 'done')::BIGINT AS done,
          count(*) FILTER (WHERE status = 'cancelled')::BIGINT AS cancelled
        FROM s_goal WHERE ${goalWhere} AND closed_at IS NOT NULL AND ${closed}`,
                sql.values,
            );
            sql = new Sql();
            const longWhere = where(ownedFilters(sql, filters));
            const finished = where(range(sql, 'finished_at', from, to));
            const [long] = await rows<Record<string, number>>(
                connection,
                `SELECT count(*) FILTER (WHERE status = 'running')::BIGINT AS running,
          count(*) FILTER (WHERE status = 'waiting')::BIGINT AS waiting,
          COALESCE(sum(items_dead) FILTER (WHERE status IN ('running', 'waiting')), 0)::BIGINT AS dead_items,
          count(*) FILTER (WHERE status = 'done' AND finished_at IS NOT NULL AND ${finished})::BIGINT AS done,
          count(*) FILTER (WHERE status = 'failed' AND finished_at IS NOT NULL AND ${finished})::BIGINT AS failed,
          count(*) FILTER (WHERE status = 'cancelled' AND finished_at IS NOT NULL AND ${finished})::BIGINT AS cancelled
        FROM s_long_run WHERE ${longWhere}`,
                sql.values,
            );

            sql = new Sql();
            const [cover] = await rows<Record<string, number>>(
                connection,
                `SELECT count(*)::BIGINT AS turns,
          count(*) FILTER (WHERE rounds > 0 OR model IS NOT NULL)::BIGINT AS traced,
          count(*) FILTER (WHERE rounds > 0 AND reasoning_kind <> 'unknown')::BIGINT AS kinds,
          count(*) FILTER (WHERE rounds > 0 AND reasoning_tokens_reported)::BIGINT AS reported,
          count(received_at)::BIGINT AS received,
          count(*) FILTER (WHERE attribution = 'exact')::BIGINT AS exact
        FROM f_turn WHERE ${turnWhere(sql)}`,
                sql.values,
            );
            sql = new Sql();
            const [roundCover] = await rows<{ rounds: number; timed: number }>(
                connection,
                `SELECT count(*)::BIGINT AS rounds, count(first_output_ms)::BIGINT AS timed
        FROM f_round WHERE ${turnWhere(sql)}`,
                sql.values,
            );
            const c = (key: string, row: Record<string, number> | undefined) => Number(row?.[key] ?? 0);
            const coverage: CoverageRow[] = [
                { id: 'trace', covered: c('traced', cover), total: c('turns', cover) },
                {
                    id: 'firstOutput',
                    covered: c('timed', roundCover),
                    total: c('rounds', roundCover),
                },
                {
                    id: 'reasoningKind',
                    covered: c('kinds', cover),
                    total: c('traced', cover),
                },
                {
                    id: 'reasoningTokens',
                    covered: c('reported', cover),
                    total: c('traced', cover),
                },
                {
                    id: 'receivedAt',
                    covered: c('received', cover),
                    total: c('turns', cover),
                },
                { id: 'trigger', covered: c('exact', cover), total: c('turns', cover) },
                {
                    id: 'dueAt',
                    covered: c('due', taskRuns),
                    total: c('runs', taskRuns),
                },
            ];

            const sources = await rows<{ source: string; at: number }>(
                connection,
                'SELECT source, "at" FROM etl_state ORDER BY source',
            );
            const stateCounts = <T extends string>(names: readonly T[], found: { state: string; n: number }[]) =>
                Object.fromEntries(
                    names.map((name) => [name, Number(found.find((row) => row.state === name)?.n ?? 0)]),
                ) as Record<T, number>;
            const answer: HealthFacts = {
                tokens: { byModel, bySocio, byPerson, byReasoning },
                latency: { firstOutput, firstOutputByModel, tools, byTool },
                queues: { turns: turnQueue, jobWait, jobWake, scheduleLate },
                schedules: {
                    ...stateCounts<ScheduleState>(SCHEDULE_STATES, scheduleStates),
                    runs: c('runs', taskRuns),
                    failedRuns: c('failed', taskRuns),
                    lateRuns: c('late', taskRuns),
                },
                goals: {
                    ...stateCounts<GoalState>(GOAL_STATES, goalStates),
                    doneInRange: c('done', goalsClosed),
                    cancelledInRange: c('cancelled', goalsClosed),
                },
                longRuns: {
                    running: c('running', long),
                    waiting: c('waiting', long),
                    deadItems: c('dead_items', long),
                    done: c('done', long),
                    failed: c('failed', long),
                    cancelled: c('cancelled', long),
                },
                jobRuns: { total: c('total', jobs), failed: c('failed', jobs) },
                coverage,
                sources: sources.map((row) => ({
                    source: row.source,
                    at: Number(row.at),
                })),
            };
            return answer;
        },

        healthSeries: (params) => series(connection, params),

        async healthSchedules({ filters, cursor, limit }) {
            const sql = new Sql();
            const parts = [`s.state IN ('failing', 'paused', 'overdue')`, ...ownedFilters(sql, filters, 's.')];
            if (cursor) {
                if (typeof cursor.key !== 'number') {
                    return { items: [], next: null };
                }
                parts.push(keyset(sql, 's.updated_at', 's.id', cursor.key, cursor.id));
            }
            const found = await rows<Record<string, unknown>>(
                connection,
                `SELECT s.id, s.title, s.socio_id, d.name AS socio_name, s.person_id, s.state,
          s.status, s.cadence, s.next_run_at, s.last_run_at, s.updated_at, s.error
        FROM s_schedule s LEFT JOIN d_socio d ON d.id = s.socio_id
        WHERE ${where(parts)}
        ORDER BY s.updated_at DESC, s.id DESC LIMIT ${limit + 1}`,
                sql.values,
            );
            return paged(
                found.map((row): HealthScheduleRow => ({
                    id: row.id as string,
                    title: (row.title as string | null) ?? null,
                    socioId: (row.socio_id as string | null) ?? null,
                    socioName: (row.socio_name as string | null) ?? null,
                    personId: (row.person_id as string | null) ?? null,
                    state: row.state as ScheduleState,
                    status: row.status as string,
                    cadence: (row.cadence as string | null) ?? null,
                    nextRunAt: nullable(row.next_run_at),
                    lastRunAt: nullable(row.last_run_at),
                    updatedAt: Number(row.updated_at),
                    error: (row.error as string | null) ?? null,
                })),
                limit,
                (row) => ({ key: row.updatedAt, id: row.id }),
            );
        },

        async healthRuns({ window, filters, cursor, limit }) {
            const sql = new Sql();
            const late = sql.int(SCHEDULE_LATE_MS);
            const parts = [
                ...range(sql, 'r.started_at', window.from, window.to),
                ...taskRunFilters(sql, filters, 'r.task_id'),
                `(r.status IN ('failed', 'interrupted') OR (r.due_at IS NOT NULL AND r.started_at - r.due_at > ${late}))`,
            ];
            if (cursor) {
                if (typeof cursor.key !== 'number') {
                    return { items: [], next: null };
                }
                parts.push(keyset(sql, 'r.started_at', 'r.id', cursor.key, cursor.id));
            }
            const found = await rows<Record<string, unknown>>(
                connection,
                `SELECT r.id, r.task_id, s.title, s.socio_id, d.name AS socio_name, r.status,
          r.due_at, r.started_at, r.finished_at
        FROM f_task_run r LEFT JOIN s_schedule s ON s.id = r.task_id
          LEFT JOIN d_socio d ON d.id = s.socio_id
        WHERE ${where(parts)}
        ORDER BY r.started_at DESC, r.id DESC LIMIT ${limit + 1}`,
                sql.values,
            );
            return paged(
                found.map((row): HealthRunRow => {
                    const dueAt = nullable(row.due_at);
                    const startedAt = Number(row.started_at);
                    return {
                        id: row.id as string,
                        taskId: row.task_id as string,
                        title: (row.title as string | null) ?? null,
                        socioId: (row.socio_id as string | null) ?? null,
                        socioName: (row.socio_name as string | null) ?? null,
                        status: row.status as string,
                        dueAt,
                        startedAt,
                        finishedAt: nullable(row.finished_at),
                        lateMs: dueAt === null ? null : Math.max(0, startedAt - dueAt),
                    };
                }),
                limit,
                (row) => ({ key: row.startedAt, id: row.id }),
            );
        },

        async healthLongRuns({ window, filters, cursor, limit }) {
            const sql = new Sql();
            const parts = [
                `(l.status IN ('running', 'waiting') OR (${where(range(sql, 'l.updated_at', window.from, window.to))}))`,
                ...ownedFilters(sql, filters, 'l.'),
            ];
            if (cursor) {
                if (typeof cursor.key !== 'number') {
                    return { items: [], next: null };
                }
                parts.push(keyset(sql, 'l.updated_at', 'l.id', cursor.key, cursor.id));
            }
            const found = await rows<Record<string, unknown>>(
                connection,
                `SELECT l.*, d.name AS socio_name
        FROM s_long_run l LEFT JOIN d_socio d ON d.id = l.socio_id
        WHERE ${where(parts)}
        ORDER BY l.updated_at DESC, l.id DESC LIMIT ${limit + 1}`,
                sql.values,
            );
            return paged(
                found.map((row): HealthLongRunRow => ({
                    id: row.id as string,
                    jobId: row.job_id as string,
                    jobName: (row.job_name as string | null) ?? null,
                    socioId: (row.socio_id as string | null) ?? null,
                    socioName: (row.socio_name as string | null) ?? null,
                    personId: (row.person_id as string | null) ?? null,
                    status: row.status as string,
                    batches: Number(row.batches),
                    retries: Number(row.retries),
                    itemsDone: Number(row.items_done),
                    itemsDead: Number(row.items_dead),
                    itemsPending: Number(row.items_pending),
                    createdAt: Number(row.created_at),
                    updatedAt: Number(row.updated_at),
                    finishedAt: nullable(row.finished_at),
                    waitReason: (row.wait_reason as string | null) ?? null,
                    lastError: (row.last_error as string | null) ?? null,
                })),
                limit,
                (row) => ({ key: row.updatedAt, id: row.id }),
            );
        },
    };
}

const nullable = (value: unknown) => (value === null || value === undefined ? null : Number(value));

const numbers = (row: TokenRow): TokenRow => ({
    key: row.key,
    name: row.name ?? null,
    turns: Number(row.turns),
    input: Number(row.input),
    output: Number(row.output),
    cached: Number(row.cached),
});

/** Newest first, after the cursor's (key, id). */
function keyset(sql: Sql, column: string, idColumn: string, key: number, id: string) {
    const at = sql.int(key);
    return `(${column} < ${at} OR (${column} = ${at} AND ${idColumn} < ${sql.text(id)}))`;
}

function paged<T>(found: T[], limit: number, key: (row: T) => { key: number; id: string }) {
    const items = found.slice(0, limit);
    const last = items.at(-1);
    return { items, next: found.length > limit && last ? key(last) : null };
}

/** Each metric: its table, its start time, its value and its filters. */
function metricSql(sql: Sql, metric: HealthMetric, filters: OpsFilters) {
    switch (metric) {
        case 'first_output':
            return {
                table: 'f_round',
                at: 'started_at',
                value: 'first_output_ms',
                where: ['first_output_ms IS NOT NULL', ...turnFilters(sql, filters)],
            };
        case 'tool_duration':
            return {
                table: 'f_tool',
                at: 'started_at',
                value: 'duration_ms',
                where: turnFilters(sql, filters),
            };
        case 'turn_queue':
            return {
                table: 'f_turn',
                at: 'started_at',
                value: 'started_at - received_at',
                where: ['received_at IS NOT NULL AND received_at <= started_at', ...turnFilters(sql, filters)],
            };
        case 'job_wait':
            return {
                table: 'f_job_run',
                at: 'queued_at',
                value: 'started_at - queued_at',
                where: ['started_at IS NOT NULL AND started_at >= queued_at', ...ownedFilters(sql, filters)],
            };
        case 'schedule_late':
            return {
                table: 'f_task_run',
                at: 'started_at',
                value: 'greatest(started_at - due_at, 0)',
                where: ['due_at IS NOT NULL', ...taskRunFilters(sql, filters)],
            };
    }
}

/**
 * A metric's p95 per bucket: the buckets are cut in JS
 * (`bucketStarts`, in the window's time zone) and each value goes to the
 * last bucket that starts at or before it.
 */
async function series(connection: DuckDBConnection, { window, filters, metric }: OpsQueryParams<'healthSeries'>) {
    const start = window.from ?? (await earliest(connection));
    if (start === null) {
        return [];
    }
    const starts = bucketStarts(start, window.to, window.bucket, window.timeZone);
    if (!starts.length) {
        return [];
    }
    const sql = new Sql();
    const spec = metricSql(sql, metric, filters);
    const parts = [
        ...range(sql, `f.${spec.at}`, Math.max(start, starts[0]!), window.to),
        ...spec.where.map((part) => part),
    ];
    const found = await rows<{ b: number; n: number; p95: number | null }>(
        connection,
        `SELECT s.b, count(*)::BIGINT AS n, quantile_disc(f.v, 0.95)::BIGINT AS p95
    FROM (SELECT ${spec.at} AS ts, ${spec.value} AS v FROM ${spec.table} f WHERE ${where(parts)}) f
    ASOF JOIN (SELECT unnest(${sql.ints(starts)}) AS b) s ON f.ts >= s.b
    GROUP BY s.b`,
        sql.values,
    );
    const byStart = new Map(found.map((row) => [Number(row.b), row]));
    return starts.map((at) => {
        const row = byStart.get(at);
        return {
            at,
            n: Number(row?.n ?? 0),
            p95: row?.p95 === undefined || row.p95 === null ? null : Number(row.p95),
        };
    });
}
