import { z, type ZodRawShape, type ZodType } from 'zod';

import { OPS_PAGE_LIMIT } from '@socio/shared/operations/operations';
import { OPS_STORAGE_KINDS } from '@socio/shared/operations/operations-knowledge';

const count = z.number().int().min(0);
const ms = z.number();
const page = <T extends ZodType, C extends ZodType>(item: T, cursor: C) =>
    z.object({ items: z.array(item), next: cursor.nullable() }).strict();

const spaceRow = {
    pages: count,
    chars: count,
    created: count,
    edits: count,
    stale: count,
};

/**
 * The Knowledge and Capabilities questions (CB-191), spread into
 * `OPS_QUERIES` with the scope and cursor shapes they share. Each is one
 * `OpsReader` method of the same name, as CB-187's are.
 */
export function knowledgeQueries<S extends ZodRawShape, C extends ZodType>({ scope, cursor }: { scope: S; cursor: C }) {
    const paged = {
        cursor: cursor.optional(),
        limit: z.number().int().min(1).max(OPS_PAGE_LIMIT.max),
    };
    return {
        /** `OpsReader.knowledge(scope)`: Spaces, search and dataset access. */
        knowledge: {
            params: z.object(scope).strict(),
            answer: z
                .object({
                    spaces: z.array(
                        z
                            .object({
                                spaceId: z.string(),
                                name: z.string().nullable(),
                                ...spaceRow,
                            })
                            .strict(),
                    ),
                    totals: z.object({ ...spaceRow, editors: count }).strict(),
                    search: z
                        .object({
                            queries: count,
                            empty: count,
                            corrected: count,
                            trigram: count,
                            p50: z.number().nullable(),
                            p95: z.number().nullable(),
                            maxMs: z.number().nullable(),
                            days: z.array(z.object({ at: ms, queries: count, empty: count }).strict()),
                        })
                        .strict(),
                    access: z
                        .object({
                            total: count,
                            denied: count,
                            errors: count,
                            datasets: count,
                            chats: count,
                            actions: z.array(
                                z
                                    .object({
                                        action: z.string(),
                                        outcome: z.string(),
                                        count,
                                    })
                                    .strict(),
                            ),
                            actors: z.array(z.object({ kind: z.string(), count }).strict()),
                        })
                        .strict(),
                })
                .strict(),
        },
        /** `OpsReader.pages(scope, page)`: least recently active first. */
        pages: {
            params: z.object({ ...scope, ...paged }).strict(),
            answer: page(
                z
                    .object({
                        pageId: z.string(),
                        spaceId: z.string(),
                        spaceName: z.string().nullable(),
                        title: z.string(),
                        chars: count,
                        revision: z.number().int(),
                        edits: count,
                        createdAt: ms,
                        updatedAt: ms,
                        usedAt: ms.nullable(),
                        activeAt: ms,
                        stale: z.boolean(),
                    })
                    .strict(),
                cursor,
            ),
        },
        /** `OpsReader.datasets(scope, page)`: largest first. */
        datasets: {
            params: z.object({ ...scope, ...paged }).strict(),
            answer: page(
                z
                    .object({
                        datasetId: z.string(),
                        name: z.string(),
                        scratch: z.boolean(),
                        sizeBytes: count,
                        historyBytes: count,
                        tables: count,
                        createdAt: ms,
                        updatedAt: ms,
                        accesses: count,
                        denied: count,
                        lastAccessAt: ms.nullable(),
                    })
                    .strict(),
                cursor,
            ),
        },
        /** `OpsReader.storage(scope)`: bytes now and over the range. */
        storage: {
            params: z.object(scope).strict(),
            answer: z
                .object({
                    kinds: z.array(
                        z
                            .object({
                                kind: z.enum(OPS_STORAGE_KINDS),
                                items: count,
                                bytes: count,
                                deletedItems: count,
                                deletedBytes: count,
                            })
                            .strict(),
                    ),
                    database: z
                        .object({
                            bytes: count,
                            freeBytes: count,
                            agentRunsBytes: count.nullable(),
                            measuredAt: ms,
                        })
                        .strict()
                        .nullable(),
                    series: z.array(
                        z
                            .object({
                                kind: z.enum(OPS_STORAGE_KINDS),
                                points: z.array(z.object({ at: ms, value: z.number() }).strict()),
                            })
                            .strict(),
                    ),
                    owners: z.array(z.object({ bytes: count, datasets: count }).strict()),
                    largestDatasetBytes: count,
                    largestFileBytes: count,
                })
                .strict(),
        },
        /** `OpsReader.toolUse(scope)`: calls per socio tool, most first. */
        toolUse: {
            params: z.object(scope).strict(),
            answer: z.array(
                z
                    .object({
                        tool: z.string(),
                        calls: count,
                        errors: count,
                        refused: count,
                    })
                    .strict(),
            ),
        },
        /** `OpsReader.requests(page)`: capability requests, latest asked first. */
        requests: {
            params: z.object(paged).strict(),
            answer: page(
                z
                    .object({
                        issueId: z.string(),
                        number: z.number().int().nullable(),
                        title: z.string().nullable(),
                        status: z.string().nullable(),
                        capability: z.string(),
                        createdAt: ms,
                        requesters: count,
                        socios: count,
                        people: count,
                        lastAt: ms,
                    })
                    .strict(),
                cursor,
            ),
        },
    } as const;
}
