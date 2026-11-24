import { z } from 'zod';

import { OPS_PAGE_LIMIT } from '@socio/shared/operations/operations';
import {
    GOAL_STATES,
    HEALTH_COVERAGE,
    HEALTH_METRICS,
    HEALTH_REASONING_KINDS,
    SCHEDULE_STATES,
    type HealthFacts,
    type HealthLongRunRow,
    type HealthMetric,
    type HealthPoint,
    type HealthRunRow,
    type HealthScheduleRow,
} from '@socio/shared/operations/operations-health';

import type { OpsPage, OpsPageRequest, OpsScope } from './scope.js';

/**
 * Health's questions to the analytics store (CB-192), spread into
 * `OPS_QUERIES`: each is the `OpsReader` method of the same name, its
 * params the scope (with a metric or a page), its answer what the method
 * returns. The scope's and cursor's schemas are `OPS_QUERIES`' own.
 */
export function healthQueries<S extends z.ZodRawShape, C extends z.ZodTypeAny>(scope: S, cursor: C) {
    const count = z.number().int().min(0);
    const ms = z.number();
    const spread = z.object({ n: count, p50: ms.nullable(), p95: ms.nullable() }).strict();
    const tokenRow = z
        .object({
            key: z.string(),
            name: z.string().nullable(),
            turns: count,
            input: count,
            output: count,
            cached: count,
        })
        .strict();
    const latencyRow = spread.extend({ key: z.string(), errors: count }).strict();
    const page = <T extends z.ZodTypeAny>(item: T) => ({
        params: z
            .object({
                ...scope,
                cursor: cursor.optional(),
                limit: z.number().int().min(1).max(OPS_PAGE_LIMIT.max),
            })
            .strict(),
        answer: z.object({ items: z.array(item), next: cursor.nullable() }).strict(),
    });
    const states = <T extends readonly [string, ...string[]]>(names: T) =>
        Object.fromEntries(names.map((name) => [name, count])) as {
            [K in T[number]]: typeof count;
        };
    const text = z.string().nullable();
    return {
        /** `OpsReader.health(scope)`: null until the store has data. */
        health: {
            params: z.object(scope).strict(),
            answer: z
                .object({
                    tokens: z
                        .object({
                            byModel: z.array(tokenRow),
                            bySocio: z.array(tokenRow),
                            byPerson: z.array(tokenRow),
                            byReasoning: z.array(
                                z
                                    .object({
                                        kind: z.enum(HEALTH_REASONING_KINDS),
                                        turns: count,
                                        output: count,
                                        reportedTurns: count,
                                        reasoning: count.nullable(),
                                    })
                                    .strict(),
                            ),
                        })
                        .strict(),
                    latency: z
                        .object({
                            firstOutput: spread,
                            firstOutputByModel: z.array(latencyRow),
                            tools: spread,
                            byTool: z.array(latencyRow),
                        })
                        .strict(),
                    queues: z
                        .object({
                            turns: spread,
                            jobWait: spread,
                            jobWake: spread,
                            scheduleLate: spread,
                        })
                        .strict(),
                    schedules: z
                        .object({
                            ...states(SCHEDULE_STATES),
                            runs: count,
                            failedRuns: count,
                            lateRuns: count,
                        })
                        .strict(),
                    goals: z
                        .object({
                            ...states(GOAL_STATES),
                            doneInRange: count,
                            cancelledInRange: count,
                        })
                        .strict(),
                    longRuns: z
                        .object({
                            running: count,
                            waiting: count,
                            deadItems: count,
                            done: count,
                            failed: count,
                            cancelled: count,
                        })
                        .strict(),
                    jobRuns: z.object({ total: count, failed: count }).strict(),
                    coverage: z.array(
                        z
                            .object({
                                id: z.enum(HEALTH_COVERAGE),
                                covered: count,
                                total: count,
                            })
                            .strict(),
                    ),
                    sources: z.array(z.object({ source: z.string(), at: ms }).strict()),
                })
                .strict()
                .nullable(),
        },
        /** `OpsReader.healthSeries(scope, metric)`: every bucket of the window. */
        healthSeries: {
            params: z.object({ ...scope, metric: z.enum(HEALTH_METRICS) }).strict(),
            answer: z.array(z.object({ at: ms, n: count, p95: ms.nullable() }).strict()),
        },
        /** `OpsReader.healthSchedules(scope, page)`: schedules that need a look. */
        healthSchedules: page(
            z
                .object({
                    id: z.string(),
                    title: text,
                    socioId: text,
                    socioName: text,
                    personId: text,
                    state: z.enum(SCHEDULE_STATES),
                    status: z.string(),
                    cadence: text,
                    nextRunAt: ms.nullable(),
                    lastRunAt: ms.nullable(),
                    updatedAt: ms,
                    error: text,
                })
                .strict(),
        ),
        /** `OpsReader.healthRuns(scope, page)`: late or failed scheduled runs. */
        healthRuns: page(
            z
                .object({
                    id: z.string(),
                    taskId: z.string(),
                    title: text,
                    socioId: text,
                    socioName: text,
                    status: z.string(),
                    dueAt: ms.nullable(),
                    startedAt: ms,
                    finishedAt: ms.nullable(),
                    lateMs: ms.nullable(),
                })
                .strict(),
        ),
        /** `OpsReader.healthLongRuns(scope, page)`: open, or changed in the window. */
        healthLongRuns: page(
            z
                .object({
                    id: z.string(),
                    jobId: z.string(),
                    jobName: text,
                    socioId: text,
                    socioName: text,
                    personId: text,
                    status: z.string(),
                    batches: count,
                    retries: count,
                    itemsDone: count,
                    itemsDead: count,
                    itemsPending: count,
                    createdAt: ms,
                    updatedAt: ms,
                    finishedAt: ms.nullable(),
                    waitReason: text,
                    lastError: text,
                })
                .strict(),
        ),
    };
}

/** Health's `OpsReader` methods (CB-192); `OpsReader` extends this. */
export interface HealthReader {
    /** Health's numbers over the window; null when the store has no data. */
    health(scope: OpsScope): Promise<HealthFacts | null>;
    /** A metric's p95 per bucket, every bucket present (null when empty). */
    healthSeries(scope: OpsScope, metric: HealthMetric): Promise<HealthPoint[]>;
    /** Schedules failing, paused or overdue now, last changed first. */
    healthSchedules(scope: OpsScope, page: OpsPageRequest): Promise<OpsPage<HealthScheduleRow>>;
    /** Scheduled runs started in the window that failed or started late, newest first. */
    healthRuns(scope: OpsScope, page: OpsPageRequest): Promise<OpsPage<HealthRunRow>>;
    /** Long runs open now or changed in the window, last changed first. */
    healthLongRuns(scope: OpsScope, page: OpsPageRequest): Promise<OpsPage<HealthLongRunRow>>;
}
