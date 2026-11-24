import { z, type ZodRawShape } from 'zod';

import type { OpsChatGrounding, OpsGrounding } from '@socio/shared/operations/operations-grounding';
import { RUN_REF_KINDS } from '@socio/shared/runs/run-refs';

const count = z.number().int().min(0);
const ms = z.number();
const kind = z.enum(RUN_REF_KINDS);

/**
 * The grounding questions (CB-194), spread into `OPS_QUERIES` with the
 * scope shape they share. Each is one `OpsReader` method of the same name.
 */
export function groundingQueries<S extends ZodRawShape>({ scope }: { scope: S }) {
    return {
        /** `OpsReader.grounding(scope)`: Spaces' reads by bucket, top pages. */
        grounding: {
            params: z.object(scope).strict(),
            answer: z
                .object({
                    runs: count,
                    chats: count,
                    kinds: z.array(z.object({ kind, refs: count, runs: count }).strict()),
                    buckets: z.array(ms),
                    spaces: z.array(
                        z
                            .object({
                                spaceId: z.string(),
                                name: z.string().nullable(),
                                reads: count,
                                pages: count,
                                chats: count,
                            })
                            .strict(),
                    ),
                    cells: z.array(z.object({ spaceId: z.string(), at: ms, reads: count }).strict()),
                    pages: z.array(
                        z
                            .object({
                                pageId: z.string(),
                                spaceId: z.string().nullable(),
                                spaceName: z.string().nullable(),
                                title: z.string().nullable(),
                                reads: count,
                                chats: count,
                                lastAt: ms,
                            })
                            .strict(),
                    ),
                })
                .strict(),
        },
        /** `OpsReader.chatGrounding(threadId)`: what one chat's turns read. */
        chatGrounding: {
            params: z.object({ threadId: z.string().regex(/^[\w.:@+-]{1,128}$/) }).strict(),
            answer: z
                .object({
                    refs: z.array(
                        z
                            .object({
                                kind,
                                spaceId: z.string().nullable(),
                                spaceName: z.string().nullable(),
                                refId: z.string(),
                                title: z.string().nullable(),
                                runs: count,
                                firstAt: ms,
                                lastAt: ms,
                            })
                            .strict(),
                    ),
                    more: z.boolean(),
                })
                .strict(),
        },
    } as const;
}

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;
type Answer<N extends 'grounding' | 'chatGrounding'> = z.infer<ReturnType<typeof groundingQueries>[N]['answer']>;
/** The queries answer exactly what the `OpsReader` methods do. */
export type GroundingReaderQueries = [
    Holds<Same<Answer<'grounding'>, OpsGrounding>>,
    Holds<Same<Answer<'chatGrounding'>, OpsChatGrounding>>,
];
