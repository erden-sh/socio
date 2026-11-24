import { z } from 'zod';

import { OPS_PAGE_LIMIT } from '@socio/shared/operations/operations';
import {
    OPS_ACTIVITY_TILES,
    OPS_OUTCOMES,
    OPS_SESSION_GAP,
    OPS_VALUE_TILES,
} from '@socio/shared/operations/operations-activity';

import { intentRow } from '../themes/queries.js';

const count = z.number().int().min(0);
const share = z.number().min(0).max(1).nullable();
const tile = <T extends readonly [string, ...string[]]>(ids: T) =>
    z
        .object({
            id: z.enum(ids),
            value: z.number().nullable(),
            previous: z.number().nullable(),
        })
        .strict();
const page = <T extends z.ZodTypeAny, C extends z.ZodTypeAny>(item: T, cursor: C) =>
    z.object({ items: z.array(item), next: cursor.nullable() }).strict();

/**
 * Activity's and Value's questions to the analytics store (CB-190), for
 * `OPS_QUERIES`: each takes the section's scope (CB-184's `OpsScope`) and
 * the session gap in force, since sessions are derived when asked. Made
 * from the registry's own scope and cursor schemas, so both stay one.
 */
export function activityQueries<S extends z.ZodRawShape, C extends z.ZodTypeAny>(scope: S, cursor: C) {
    const sessioned = {
        ...scope,
        sessionGapMinutes: z.number().int().min(OPS_SESSION_GAP.min).max(OPS_SESSION_GAP.max),
    };
    const paged = {
        ...sessioned,
        cursor: cursor.optional(),
        limit: z.number().int().min(1).max(OPS_PAGE_LIMIT.max),
    };
    return {
        /** `OpsReader.activity(scope, options)`: tiles, chart and breakdowns. */
        activity: {
            params: z
                .object({
                    ...sessioned,
                    // The app's capability registry, which the analytics process lacks.
                    capabilities: z
                        .array(
                            z
                                .object({
                                    tool: z.string().max(128),
                                    capability: z.string().max(128),
                                })
                                .strict(),
                        )
                        .max(2000),
                })
                .strict(),
            answer: z
                .object({
                    tiles: z.array(tile(OPS_ACTIVITY_TILES)),
                    points: z.array(
                        z
                            .object({
                                at: z.number(),
                                people: count,
                                sessions: count,
                                messages: count,
                            })
                            .strict(),
                    ),
                    sources: z.array(
                        z
                            .object({
                                key: z.string(),
                                label: z.string(),
                                kind: z.enum(['human', 'automation', 'unknown']),
                                turns: count,
                                messages: count,
                                people: count,
                            })
                            .strict(),
                    ),
                    participation: z
                        .object({
                            chats: count,
                            withSeveralPeople: count,
                            withSeveralSocios: count,
                            collaboration: count,
                        })
                        .strict(),
                    features: z.array(
                        z
                            .object({
                                id: z.string(),
                                tools: z.array(z.string()),
                                calls: count,
                                people: count,
                                socios: count,
                                errors: count,
                                refusals: count,
                            })
                            .strict(),
                    ),
                    spaces: z.array(
                        z
                            .object({
                                spaceId: z.string(),
                                name: z.string().nullable(),
                                writesByPeople: count,
                                writesBySocios: count,
                                pages: count,
                                people: count,
                                socios: count,
                                turns: count,
                            })
                            .strict(),
                    ),
                })
                .strict(),
        },
        /** `OpsReader.value(scope, options)`: outcomes, approvals, reactions. */
        value: {
            params: z.object(sessioned).strict(),
            answer: z
                .object({
                    tiles: z.array(tile(OPS_VALUE_TILES)),
                    points: z.array(
                        z
                            .object({
                                at: z.number(),
                                completed: count,
                                answered: count,
                                abandoned: count,
                            })
                            .strict(),
                    ),
                    approvals: z.array(
                        z
                            .object({
                                capability: z.string(),
                                requested: count,
                                approved: count,
                                denied: count,
                                expired: count,
                                executed: count,
                                failed: count,
                            })
                            .strict(),
                    ),
                    reactions: z
                        .object({
                            socioMessages: count,
                            reacted: count,
                            up: count,
                            down: count,
                            retry: count,
                            needsWork: count,
                        })
                        .strict(),
                    /** Sessions by intent (CB-199), no intent last. */
                    intents: z.array(intentRow),
                })
                .strict(),
        },
        /** `OpsReader.activityPeople`: people active in the window, last active first. */
        activityPeople: {
            params: z.object(paged).strict(),
            answer: page(
                z
                    .object({
                        personId: z.string(),
                        name: z.string().nullable(),
                        messages: count,
                        sessions: count,
                        chats: count,
                        socios: count,
                        activeDays: count,
                        toolCalls: count,
                        completed: count,
                        lastAt: z.number(),
                    })
                    .strict(),
                cursor,
            ),
        },
        /** `OpsReader.activitySocios`: socios with people's sessions, last active first. */
        activitySocios: {
            params: z.object(paged).strict(),
            answer: page(
                z
                    .object({
                        socioId: z.string(),
                        name: z.string().nullable(),
                        people: count,
                        sessions: count,
                        chats: count,
                        messages: count,
                        turns: count,
                        perChat: z.number().min(0),
                        repeatUse: share,
                        collaboration: count,
                        completed: count,
                        answered: count,
                        abandoned: count,
                        returnRate: share,
                        lastAt: z.number(),
                    })
                    .strict(),
                cursor,
            ),
        },
        /** `OpsReader.activityChats`: chats people wrote in, last active first. */
        activityChats: {
            params: z.object(paged).strict(),
            answer: page(
                z
                    .object({
                        threadId: z.string(),
                        socioId: z.string().nullable(),
                        socioName: z.string().nullable(),
                        ownerKind: z.enum(['person', 'team', 'room']).nullable(),
                        people: count,
                        socios: count,
                        messages: count,
                        sessions: count,
                        activeDays: count,
                        resumed: z.boolean(),
                        lastAt: z.number(),
                    })
                    .strict(),
                cursor,
            ),
        },
        /** `OpsReader.activitySessions`: people's sessions, newest first. */
        activitySessions: {
            params: z.object({ ...paged, outcome: z.enum(OPS_OUTCOMES).optional() }).strict(),
            answer: page(
                z
                    .object({
                        id: z.string(),
                        threadId: z.string(),
                        socioId: z.string().nullable(),
                        socioName: z.string().nullable(),
                        source: z.string(),
                        startedAt: z.number(),
                        endedAt: z.number(),
                        messages: count,
                        people: count,
                        socios: count,
                        outcome: z.enum(OPS_OUTCOMES),
                    })
                    .strict(),
                cursor,
            ),
        },
    } as const;
}
