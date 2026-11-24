import { z, type ZodRawShape } from 'zod';

const count = z.number().int().min(0);
const dollars = z.number();
const row = z
    .object({
        key: z.string(),
        name: z.string().nullable(),
        turns: count,
        tokens: z.number(),
        costUsd: dollars,
        unpriced: count,
    })
    .strict();

/**
 * Cost's questions (CB-195, CB-196), spread into `OPS_QUERIES`: each is
 * the `OpsReader` method of the same name, as CB-187's are.
 */
export function costQueries<S extends ZodRawShape>(scope: S) {
    return {
        /** `OpsReader.cost(scope)`: turns' cost, by model, socio, person, payer, room and backend, cycles, and pools. */
        cost: {
            params: z.object(scope).strict(),
            answer: z
                .object({
                    totals: z
                        .object({
                            costUsd: dollars,
                            previousCostUsd: dollars.nullable(),
                            turns: count,
                            priced: count,
                            pooled: count,
                            unpriced: count,
                            tokens: z.number(),
                            idleUsd: dollars,
                        })
                        .strict(),
                    series: z.array(z.object({ at: z.number(), priceUsd: dollars, poolUsd: dollars }).strict()),
                    byModel: z.array(row),
                    bySocio: z.array(row),
                    byPerson: z.array(row),
                    byPayer: z.array(row),
                    byRoom: z.array(
                        row
                            .extend({
                                cycles: count,
                                handoffs: count,
                                exhausted: count,
                                people: count,
                                socios: count,
                            })
                            .strict(),
                    ),
                    cycles: z
                        .object({
                            cycles: count,
                            inRooms: count,
                            steps: count,
                            handoffs: count,
                            exhausted: z
                                .object({
                                    deadline: count,
                                    tokens: count,
                                    handoffs: count,
                                    spend: count,
                                })
                                .strict(),
                            stopped: count,
                            spendUnknown: count,
                            runningMs: z.number().min(0),
                            wallMs: z.number().min(0),
                        })
                        .strict(),
                    backends: z.array(
                        z
                            .object({
                                backend: z.string(),
                                turns: count,
                                inputTokens: z.number(),
                                cachedTokens: z.number(),
                                outputTokens: z.number(),
                                costUsd: dollars,
                                poolUsd: dollars,
                                pooledTokens: z.number(),
                                referenceUsd: dollars.nullable(),
                                unpriced: count,
                            })
                            .strict(),
                    ),
                    pools: z.array(
                        z
                            .object({
                                poolId: z.string(),
                                costUsd: dollars,
                                allocatedUsd: dollars,
                                idleUsd: dollars,
                                turns: count,
                            })
                            .strict(),
                    ),
                    unpricedModels: z.array(
                        z.object({ model: z.string(), backend: z.string(), turns: count }).strict(),
                    ),
                })
                .strict(),
        },
        /** `OpsReader.costModels()`: the models turns used, for the price sync. */
        costModels: {
            params: z.object({}).strict(),
            answer: z.array(z.string()),
        },
    };
}
