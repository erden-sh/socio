import { z } from 'zod';

import { OPS_QUERY_NAMES } from '../domain/ops-queries.js';

/**
 * The analytics process's one protocol (CB-186), the same over IPC (child
 * mode) and over HTTP (service mode, `POST /v1/rpc` with the shared
 * secret). Every answer carries the store's status, so the app's view of
 * it stays current without polling while it is in use.
 */
export const analyticsRequest = z.discriminatedUnion('op', [
    z.object({ op: z.literal('status') }).strict(),
    z
        .object({
            op: z.literal('query'),
            query: z.enum(OPS_QUERY_NAMES),
            params: z.record(z.string(), z.unknown()).default({}),
        })
        .strict(),
    // Read SQLite now rather than at the next tick (after a finished turn).
    z.object({ op: z.literal('nudge') }).strict(),
    // An admin's Rebuild analytics: a fresh file, swapped in when caught up.
    z.object({ op: z.literal('rebuild') }).strict(),
]);
export type AnalyticsRequest = z.infer<typeof analyticsRequest>;

export const engineStatus = z.object({
    state: z.enum(['starting', 'ready', 'rebuilding', 'unavailable']),
    progress: z.number().min(0).max(100).optional(),
    asOf: z.number().optional(),
    detail: z.string().max(200).optional(),
});
export type EngineStatus = z.infer<typeof engineStatus>;

export const ANALYTICS_ERRORS = [
    // No file to answer from yet: the store is starting or rebuilding.
    'not_ready',
    'bad_request',
    'failed',
    // Set by the app's side: the process is down or didn't answer.
    'unavailable',
] as const;
export type AnalyticsErrorCode = (typeof ANALYTICS_ERRORS)[number];

export const analyticsAnswer = z.union([
    z.object({ ok: z.literal(true), value: z.unknown(), status: engineStatus }),
    z.object({
        ok: z.literal(false),
        code: z.enum(ANALYTICS_ERRORS),
        error: z.string().max(300),
        status: engineStatus,
    }),
]);
export type AnalyticsAnswer = z.infer<typeof analyticsAnswer>;

/** IPC, app to child: a request with its id, or the order to stop. */
export const toChild = z.union([
    z.object({ id: z.number().int(), request: z.unknown() }),
    z.object({ shutdown: z.literal(true) }),
]);
/** IPC, child to app: an answer to a request, or a status change. */
export const fromChild = z.union([
    z.object({ id: z.number().int(), answer: analyticsAnswer }),
    z.object({ status: engineStatus }),
]);
