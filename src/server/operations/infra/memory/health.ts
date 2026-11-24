import { bucketStarts, type OpsFilters } from '@socio/shared/operations/operations';
import {
    GOAL_STATES,
    HEALTH_REASONING_KINDS,
    HEALTH_TOP,
    SCHEDULE_LATE_MS,
    SCHEDULE_STATES,
    type GoalState,
    type HealthFacts,
    type HealthLongRunRow,
    type HealthMetric,
    type HealthPoint,
    type HealthRunRow,
    type HealthScheduleRow,
    type LatencyRow,
    type ReasoningRow,
    type ScheduleState,
    type Spread,
    type TokenRow,
} from '@socio/shared/operations/operations-health';

import { afterCursor, type OpsCursor } from '../../domain/cursor.js';
import type { OpsPage, OpsPageRequest, OpsScope } from '../../domain/reader.js';

import type { TurnFact } from './facts.js';

/** Where a fact came from, for the turn filters (as `f_round`, `f_tool`). */
interface TurnScoped {
    runId: string;
    socioId: string | null;
    spaceId?: string | null;
    source: string;
    /** The person who started the turn, when a person did. */
    personId?: string | null;
    startedAt: number;
}

/** A model round, as `f_round` keeps it. */
export interface RoundFact extends TurnScoped {
    model: string | null;
    firstOutputMs: number | null;
}
/** A tool call, as `f_tool` keeps it. */
export interface ToolFact extends TurnScoped {
    tool: string;
    outcome: string;
    durationMs: number;
}
/** What a socio does for a person outside turns. */
interface Owned {
    socioId: string | null;
    personId: string | null;
}
export interface JobRunFact extends Owned {
    id: string;
    status: string;
    queuedAt: number;
    startedAt: number | null;
    wakeMs: number | null;
}
export interface TaskRunFact {
    id: string;
    taskId: string;
    status: string;
    dueAt: number | null;
    startedAt: number;
    finishedAt: number | null;
}
export type ScheduleFact = Omit<HealthScheduleRow, 'socioName'>;
export interface GoalFact extends Owned {
    id: string;
    status: string;
    state: GoalState;
    closedAt: number | null;
}
export type LongRunFact = Omit<HealthLongRunRow, 'socioName'>;

export interface HealthMemoryFacts {
    rounds?: readonly RoundFact[];
    tools?: readonly ToolFact[];
    jobRuns?: readonly JobRunFact[];
    taskRuns?: readonly TaskRunFact[];
    schedules?: readonly ScheduleFact[];
    goals?: readonly GoalFact[];
    longRuns?: readonly LongRunFact[];
    /** Names and Spaces, as `d_socio` and `d_person`. */
    socios?: readonly { id: string; name: string; spaceId: string }[];
    people?: readonly { id: string; name: string }[];
    /** The ETL's sources and when each last ran, as `etl_state`. */
    sources?: readonly { source: string; at: number }[];
}

const inRange = (at: number, from: number | null, to: number) => (from === null || at >= from) && at < to;

/**
 * The index of the last bucket start at or before `at`: an ASOF match, like the
 * analytics store's `ASOF JOIN … ON ts >= b`. Bucketing each point back through
 * `bucketStart` instead would fold the repeated fall-back hour into the one
 * before it (and drift across the spring-forward gap), so the store and the
 * reader disagree on DST days (CB-324).
 */
function bucketIndexOf(starts: readonly number[], at: number) {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (starts[mid]! <= at) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo - 1;
}

/** DuckDB's `quantile_disc`: the nearest rank, a value that is in the list. */
export function quantile(sorted: readonly number[], q: number) {
    if (!sorted.length) {
        return null;
    }
    return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]!;
}

function spread(values: number[]): Spread {
    const sorted = [...values].sort((a, b) => a - b);
    return {
        n: sorted.length,
        p50: quantile(sorted, 0.5),
        p95: quantile(sorted, 0.95),
    };
}

const byKey = <T>(items: Map<string, T>) => [...items.entries()];
const ordered = <T extends { key: string }>(rows: T[], weight: (row: T) => number) =>
    rows
        .sort((a, b) => (weight(b) !== weight(a) ? weight(b) - weight(a) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .slice(0, HEALTH_TOP);

function page<T>(rows: T[], key: (row: T) => OpsCursor, request: OpsPageRequest): OpsPage<T> {
    const sorted = rows
        .map((row) => ({ row, key: key(row) }))
        .filter(({ key }) => afterCursor(key, request.cursor))
        .sort((a, b) =>
            b.key.key !== a.key.key ? (b.key.key as number) - (a.key.key as number) : b.key.id < a.key.id ? -1 : 1,
        );
    const items = sorted.slice(0, request.limit);
    return {
        items: items.map(({ row }) => row),
        next: sorted.length > request.limit ? items.at(-1)!.key : null,
    };
}

/**
 * Health's answers from facts in memory (CB-192): `MemoryOpsReader`'s
 * half for Health, answering as the DuckDB queries do.
 */
export class MemoryHealth {
    constructor(
        private turns: () => readonly TurnFact[],
        private facts: HealthMemoryFacts,
    ) {}

    private socio(id: string | null | undefined) {
        return this.facts.socios?.find((socio) => socio.id === id);
    }

    private turnScoped<T extends TurnScoped>(rows: readonly T[], { window, filters }: OpsScope) {
        return rows.filter(
            (row) =>
                inRange(row.startedAt, window.from, window.to) &&
                (!filters.socio || row.socioId === filters.socio) &&
                (!filters.space || (row.spaceId ?? this.socio(row.socioId)?.spaceId) === filters.space) &&
                (!filters.source || row.source === filters.source) &&
                (!filters.person || row.personId === filters.person),
        );
    }

    private owned(row: Owned, filters: OpsFilters) {
        return (
            (!filters.socio || row.socioId === filters.socio) &&
            (!filters.space || this.socio(row.socioId)?.spaceId === filters.space) &&
            (!filters.person || row.personId === filters.person)
        );
    }

    private taskRunsIn({ window, filters }: OpsScope) {
        const owned = filters.socio || filters.space || filters.person;
        return (this.facts.taskRuns ?? []).filter((run) => {
            if (!inRange(run.startedAt, window.from, window.to)) {
                return false;
            }
            if (!owned) {
                return true;
            }
            const schedule = this.facts.schedules?.find((item) => item.id === run.taskId);
            return !!schedule && this.owned(schedule, filters);
        });
    }

    health(scope: OpsScope): HealthFacts {
        const { window, filters } = scope;
        const turns = this.turnScoped(this.turns(), scope);
        const tokens = (key: (turn: TurnFact) => string | null, named: boolean) => {
            const groups = new Map<string, TokenRow>();
            for (const turn of turns) {
                const id = key(turn);
                if (id === null) {
                    continue;
                }
                const row = groups.get(id) ?? {
                    key: id,
                    name: null,
                    turns: 0,
                    input: 0,
                    output: 0,
                    cached: 0,
                };
                row.turns++;
                row.input += turn.inputTokens ?? 0;
                row.output += turn.outputTokens ?? 0;
                row.cached += turn.cachedTokens ?? 0;
                if (named) {
                    row.name = this.name(id, turn);
                }
                groups.set(id, row);
            }
            return ordered([...groups.values()], (row) => row.input + row.output);
        };
        const byReasoning: ReasoningRow[] = HEALTH_REASONING_KINDS.flatMap((kind) => {
            const found = turns.filter(
                (turn) =>
                    (turn.reasoningKind ?? 'unknown') === kind ||
                    (kind === 'unknown' &&
                        !(HEALTH_REASONING_KINDS as readonly string[]).includes(turn.reasoningKind ?? 'unknown')),
            );
            if (!found.length) {
                return [];
            }
            const reported = found.filter((turn) => turn.reasoningTokensReported);
            return [
                {
                    kind,
                    turns: found.length,
                    output: found.reduce((sum, turn) => sum + (turn.outputTokens ?? 0), 0),
                    reportedTurns: reported.length,
                    reasoning: reported.length
                        ? reported.reduce((sum, turn) => sum + (turn.reasoningTokens ?? 0), 0)
                        : null,
                },
            ];
        });

        const rounds = this.turnScoped(this.facts.rounds ?? [], scope);
        const timed = rounds.filter((round) => round.firstOutputMs !== null);
        const latencyRows = <T>(
            items: T[],
            key: (item: T) => string,
            value: (item: T) => number,
            error: (item: T) => boolean,
        ) => {
            const groups = new Map<string, { values: number[]; errors: number }>();
            for (const item of items) {
                const group = groups.get(key(item)) ?? { values: [], errors: 0 };
                group.values.push(value(item));
                if (error(item)) {
                    group.errors++;
                }
                groups.set(key(item), group);
            }
            return ordered(
                byKey(groups).map(([id, group]): LatencyRow => ({
                    key: id,
                    ...spread(group.values),
                    errors: group.errors,
                })),
                (row) => row.n,
            );
        };
        const tools = this.turnScoped(this.facts.tools ?? [], scope);

        const jobRuns = (this.facts.jobRuns ?? []).filter(
            (run) => inRange(run.queuedAt, window.from, window.to) && this.owned(run, filters),
        );
        const taskRuns = this.taskRunsIn(scope);
        const schedules = (this.facts.schedules ?? []).filter((item) => this.owned(item, filters));
        const goals = (this.facts.goals ?? []).filter((item) => this.owned(item, filters));
        const longRuns = (this.facts.longRuns ?? []).filter((item) => this.owned(item, filters));
        const open = (status: string) => status === 'running' || status === 'waiting';
        const finishedIn = (run: LongRunFact, status: string) =>
            run.status === status && run.finishedAt !== null && inRange(run.finishedAt, window.from, window.to);
        const closedIn = (goal: GoalFact, status: string) =>
            goal.status === status && goal.closedAt !== null && inRange(goal.closedAt, window.from, window.to);
        const traced = turns.filter((turn) => (turn.rounds ?? 0) > 0 || !!turn.model);
        const withRounds = turns.filter((turn) => (turn.rounds ?? 0) > 0);
        const count = <T extends string>(names: readonly T[], items: readonly { state: string }[]) =>
            Object.fromEntries(
                names.map((name) => [name, items.filter((item) => item.state === name).length]),
            ) as Record<T, number>;

        return {
            tokens: {
                byModel: tokens((turn) => turn.model ?? 'unknown', false),
                bySocio: tokens((turn) => turn.socioId || null, true),
                byPerson: tokens((turn) => turn.personId ?? null, true),
                byReasoning,
            },
            latency: {
                firstOutput: spread(timed.map((round) => round.firstOutputMs!)),
                firstOutputByModel: latencyRows(
                    timed,
                    (round) => round.model ?? 'unknown',
                    (round) => round.firstOutputMs!,
                    () => false,
                ),
                tools: spread(tools.map((tool) => tool.durationMs)),
                byTool: latencyRows(
                    tools,
                    (tool) => tool.tool,
                    (tool) => tool.durationMs,
                    (tool) => tool.outcome === 'error' || tool.outcome === 'timeout',
                ),
            },
            queues: {
                turns: spread(
                    turns
                        .filter((turn) => turn.receivedAt != null && turn.receivedAt <= turn.startedAt)
                        .map((turn) => turn.startedAt - turn.receivedAt!),
                ),
                jobWait: spread(
                    jobRuns
                        .filter((run) => run.startedAt !== null && run.startedAt >= run.queuedAt)
                        .map((run) => run.startedAt! - run.queuedAt),
                ),
                jobWake: spread(jobRuns.filter((run) => run.wakeMs !== null).map((run) => run.wakeMs!)),
                scheduleLate: spread(
                    taskRuns.filter((run) => run.dueAt !== null).map((run) => Math.max(0, run.startedAt - run.dueAt!)),
                ),
            },
            schedules: {
                ...count<ScheduleState>(SCHEDULE_STATES, schedules),
                runs: taskRuns.length,
                failedRuns: taskRuns.filter((run) => run.status === 'failed' || run.status === 'interrupted').length,
                lateRuns: taskRuns.filter((run) => run.dueAt !== null && run.startedAt - run.dueAt > SCHEDULE_LATE_MS)
                    .length,
            },
            goals: {
                ...count<GoalState>(GOAL_STATES, goals),
                doneInRange: goals.filter((goal) => closedIn(goal, 'done')).length,
                cancelledInRange: goals.filter((goal) => closedIn(goal, 'cancelled')).length,
            },
            longRuns: {
                running: longRuns.filter((run) => run.status === 'running').length,
                waiting: longRuns.filter((run) => run.status === 'waiting').length,
                deadItems: longRuns.filter((run) => open(run.status)).reduce((sum, run) => sum + run.itemsDead, 0),
                done: longRuns.filter((run) => finishedIn(run, 'done')).length,
                failed: longRuns.filter((run) => finishedIn(run, 'failed')).length,
                cancelled: longRuns.filter((run) => finishedIn(run, 'cancelled')).length,
            },
            jobRuns: {
                total: jobRuns.length,
                failed: jobRuns.filter((run) => ['failed', 'timed_out', 'interrupted'].includes(run.status)).length,
            },
            coverage: [
                { id: 'trace', covered: traced.length, total: turns.length },
                { id: 'firstOutput', covered: timed.length, total: rounds.length },
                {
                    id: 'reasoningKind',
                    covered: withRounds.filter((turn) => (turn.reasoningKind ?? 'unknown') !== 'unknown').length,
                    total: traced.length,
                },
                {
                    id: 'reasoningTokens',
                    covered: withRounds.filter((turn) => turn.reasoningTokensReported).length,
                    total: traced.length,
                },
                {
                    id: 'receivedAt',
                    covered: turns.filter((turn) => turn.receivedAt != null).length,
                    total: turns.length,
                },
                {
                    id: 'trigger',
                    covered: turns.filter((turn) => turn.attribution === 'exact').length,
                    total: turns.length,
                },
                {
                    id: 'dueAt',
                    covered: taskRuns.filter((run) => run.dueAt !== null).length,
                    total: taskRuns.length,
                },
            ],
            sources: [...(this.facts.sources ?? [])]
                .sort((a, b) => (a.source < b.source ? -1 : 1))
                .map((source) => ({ ...source })),
        };
    }

    /** A socio's or person's name, as `d_socio` and `d_person` have it. */
    private name(id: string, turn: TurnFact) {
        if (turn.socioId === id) {
            return this.socio(id)?.name ?? turn.socioName ?? null;
        }
        return this.facts.people?.find((person) => person.id === id)?.name ?? null;
    }

    series(scope: OpsScope, metric: HealthMetric, earliest: number | null): HealthPoint[] {
        const { window } = scope;
        const start = window.from ?? earliest;
        if (start === null) {
            return [];
        }
        const starts = bucketStarts(start, window.to, window.bucket, window.timeZone);
        const scoped = { ...scope, window: { ...window, from: start } };
        let points: { at: number; value: number }[];
        switch (metric) {
            case 'first_output':
                points = this.turnScoped(this.facts.rounds ?? [], scoped)
                    .filter((round) => round.firstOutputMs !== null)
                    .map((round) => ({
                        at: round.startedAt,
                        value: round.firstOutputMs!,
                    }));
                break;
            case 'tool_duration':
                points = this.turnScoped(this.facts.tools ?? [], scoped).map((tool) => ({
                    at: tool.startedAt,
                    value: tool.durationMs,
                }));
                break;
            case 'turn_queue':
                points = this.turnScoped(this.turns(), scoped)
                    .filter((turn) => turn.receivedAt != null && turn.receivedAt <= turn.startedAt)
                    .map((turn) => ({
                        at: turn.startedAt,
                        value: turn.startedAt - turn.receivedAt!,
                    }));
                break;
            case 'job_wait':
                points = (this.facts.jobRuns ?? [])
                    .filter(
                        (run) =>
                            inRange(run.queuedAt, start, window.to) &&
                            this.owned(run, scope.filters) &&
                            run.startedAt !== null &&
                            run.startedAt >= run.queuedAt,
                    )
                    .map((run) => ({
                        at: run.queuedAt,
                        value: run.startedAt! - run.queuedAt,
                    }));
                break;
            case 'schedule_late':
                points = this.taskRunsIn(scoped)
                    .filter((run) => run.dueAt !== null)
                    .map((run) => ({
                        at: run.startedAt,
                        value: Math.max(0, run.startedAt - run.dueAt!),
                    }));
                break;
        }
        // Assign each point to its bucket the way the analytics store does — by an
        // ASOF match on the shared bucket starts, not by re-bucketing the point's
        // wall clock, which misresolves the hour a DST change repeats or skips.
        const groups = new Map(starts.map((at) => [at, [] as number[]]));
        for (const point of points) {
            const i = bucketIndexOf(starts, point.at);
            if (i >= 0) {
                groups.get(starts[i]!)?.push(point.value);
            }
        }
        return starts.map((at) => {
            const values = groups.get(at)!.sort((a, b) => a - b);
            return { at, n: values.length, p95: quantile(values, 0.95) };
        });
    }

    schedules(scope: OpsScope, request: OpsPageRequest) {
        return page<HealthScheduleRow>(
            (this.facts.schedules ?? [])
                .filter(
                    (item) =>
                        (item.state === 'failing' || item.state === 'paused' || item.state === 'overdue') &&
                        this.owned(item, scope.filters),
                )
                .map((item) => ({
                    ...item,
                    socioName: this.socio(item.socioId)?.name ?? null,
                })),
            (row) => ({ key: row.updatedAt, id: row.id }),
            request,
        );
    }

    runs(scope: OpsScope, request: OpsPageRequest) {
        return page<HealthRunRow>(
            this.taskRunsIn(scope)
                .filter(
                    (run) =>
                        run.status === 'failed' ||
                        run.status === 'interrupted' ||
                        (run.dueAt !== null && run.startedAt - run.dueAt > SCHEDULE_LATE_MS),
                )
                .map((run) => {
                    const schedule = this.facts.schedules?.find((item) => item.id === run.taskId);
                    return {
                        id: run.id,
                        taskId: run.taskId,
                        title: schedule?.title ?? null,
                        socioId: schedule?.socioId ?? null,
                        socioName: this.socio(schedule?.socioId)?.name ?? null,
                        status: run.status,
                        dueAt: run.dueAt,
                        startedAt: run.startedAt,
                        finishedAt: run.finishedAt,
                        lateMs: run.dueAt === null ? null : Math.max(0, run.startedAt - run.dueAt),
                    };
                }),
            (row) => ({ key: row.startedAt, id: row.id }),
            request,
        );
    }

    longRuns({ window, filters }: OpsScope, request: OpsPageRequest) {
        return page<HealthLongRunRow>(
            (this.facts.longRuns ?? [])
                .filter(
                    (run) =>
                        (run.status === 'running' ||
                            run.status === 'waiting' ||
                            inRange(run.updatedAt, window.from, window.to)) &&
                        this.owned(run, filters),
                )
                .map((run) => ({
                    ...run,
                    socioName: this.socio(run.socioId)?.name ?? null,
                })),
            (row) => ({ key: row.updatedAt, id: row.id }),
            request,
        );
    }
}
