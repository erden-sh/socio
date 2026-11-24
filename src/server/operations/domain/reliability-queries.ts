import { z } from 'zod';

import { FAILURE_CATEGORIES } from '@socio/shared/failure-taxonomy';
import { OPS_PAGE_LIMIT } from '@socio/shared/operations/operations';
import { RELIABILITY_DIMENSIONS } from '@socio/shared/operations/operations-reliability';

const category = z.enum(FAILURE_CATEGORIES);
const count = z.number().int().min(0);
const maybe = count.nullable();
const code = z.string().max(160);

/**
 * Reliability's questions to the analytics store (CB-189), each one
 * `OpsReader` method of the same name: `OPS_QUERIES` takes them in with
 * the scope, cursor and run status schemas it defines (passed in, so the
 * two files don't import each other at load).
 */
export function reliabilityQueries<Shape extends z.ZodRawShape, Cursor extends z.ZodType, RunStatus extends z.ZodType>({
    scope,
    cursor,
    runStatus,
}: {
    scope: Shape;
    cursor: Cursor;
    runStatus: RunStatus;
}) {
    return {
        /** `OpsReader.reliability(scope)`: the totals and every category's count. */
        reliability: {
            params: z.object(scope).strict(),
            answer: z
                .object({
                    turns: maybe,
                    failures: maybe,
                    previousTurns: maybe,
                    previousFailures: maybe,
                    stopped: maybe,
                    interrupted: maybe,
                    retries: maybe,
                    retriedTurns: maybe,
                    fallbacks: maybe,
                    toolCalls: maybe,
                    toolFailures: maybe,
                    categories: z.array(z.object({ category, turns: count, tools: count }).strict()),
                })
                .strict(),
        },
        /** `OpsReader.failureSeries(scope)`: every bucket of the window. */
        failureSeries: {
            params: z.object(scope).strict(),
            answer: z.array(
                z
                    .object({
                        at: z.number(),
                        turns: count,
                        failures: count,
                        counts: z.array(count).length(FAILURE_CATEGORIES.length),
                    })
                    .strict(),
            ),
        },
        /** `OpsReader.failureBreakdown(scope, by)`: the most failing first. */
        failureBreakdown: {
            params: z.object({ ...scope, by: z.enum(RELIABILITY_DIMENSIONS) }).strict(),
            answer: z.array(
                z
                    .object({
                        key: z.string(),
                        label: z.string().nullable(),
                        total: count,
                        failed: count,
                        category: category.nullable(),
                        code: code.nullable(),
                        p50Ms: z.number().nullable(),
                        p95Ms: z.number().nullable(),
                    })
                    .strict(),
            ),
        },
        /** `OpsReader.failures(scope, page, filter)`: newest first, keyset-paged. */
        failures: {
            params: z
                .object({
                    ...scope,
                    cursor: cursor.optional(),
                    limit: z.number().int().min(1).max(OPS_PAGE_LIMIT.max),
                    category: category.optional(),
                    tool: code.optional(),
                })
                .strict(),
            answer: z
                .object({
                    items: z.array(
                        z
                            .object({
                                runId: z.string(),
                                threadId: z.string(),
                                socioId: z.string(),
                                socioName: z.string().nullable(),
                                source: z.string(),
                                status: runStatus,
                                startedAt: z.number(),
                                finishedAt: z.number().nullable(),
                                level: z.enum(['turn', 'tool']),
                                category,
                                rule: z.string(),
                                code: code.nullable(),
                                endReason: z.string().nullable(),
                                model: z.string().nullable(),
                                tool: z.string().nullable(),
                                toolFailures: count,
                            })
                            .strict(),
                    ),
                    next: cursor.nullable(),
                })
                .strict(),
        },
        /** `OpsReader.friction(scope)`: recurring friction in the last 7 days. */
        friction: {
            params: z.object(scope).strict(),
            answer: z
                .object({
                    from: z.number(),
                    rows: z.array(
                        z
                            .object({
                                category,
                                code: code.nullable(),
                                tool: z.string().nullable(),
                                people: count,
                                failures: count,
                                mostForOne: count,
                                lastAt: z.number(),
                            })
                            .strict(),
                    ),
                })
                .strict(),
        },
        /** `OpsReader.issueVelocity(scope)`: the board's filed and closed items. */
        issueVelocity: {
            params: z.object(scope).strict(),
            answer: z
                .object({
                    reported: maybe,
                    resolved: maybe,
                    previousReported: maybe,
                    previousResolved: maybe,
                    bugsReported: maybe,
                    open: maybe,
                    medianResolveMs: z.number().nullable(),
                    p90ResolveMs: z.number().nullable(),
                    failuresReported: maybe,
                    medianReportMs: z.number().nullable(),
                    p90ReportMs: z.number().nullable(),
                    points: z.array(z.object({ at: z.number(), reported: count, resolved: count }).strict()),
                })
                .strict(),
        },
    } as const;
}
