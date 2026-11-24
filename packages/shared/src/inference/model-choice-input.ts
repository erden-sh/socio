import { z } from 'zod';

/**
 * A `ModelChoice` (`@socio/shared/inference`) in a request body: a Dot's
 * default, a conversation's model. Moved from `inference/routes.ts`.
 */
export const modelChoiceInput = z.union([
    z
        .object({
            source: z.literal('shared'),
            backendId: z.string().min(1).max(80),
        })
        .strict(),
    z
        .object({
            source: z.literal('byo'),
            kind: z.string().min(1).max(40),
            model: z.string().min(1).max(80).optional(),
        })
        .strict(),
]);
