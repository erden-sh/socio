import { z } from 'zod';

import { THEME_OUTCOMES } from '@socio/shared/classify';
import { OPS_SESSION_GAP } from '@socio/shared/operations/operations-activity';

const count = z.number().int().min(0);
const outcomes = { completed: count, answered: count, abandoned: count };

/** One intent's sessions (CB-199); Value's answer has these too. */
export const intentRow = z
    .object({
        intent: z.string().nullable(),
        sessions: count,
        people: count,
        ...outcomes,
    })
    .strict();

/**
 * Themes' question to the analytics store (CB-199), for `OPS_QUERIES`:
 * the section's scope and the session gap in force, as Value's.
 */
export function themesQueries<S extends z.ZodRawShape>(scope: S) {
    return {
        /** `OpsReader.themes(scope, options)`: intents, themes and their weeks. */
        themes: {
            params: z
                .object({
                    ...scope,
                    sessionGapMinutes: z.number().int().min(OPS_SESSION_GAP.min).max(OPS_SESSION_GAP.max),
                })
                .strict(),
            answer: z
                .object({
                    sessions: count,
                    withIntent: count,
                    withThemes: count,
                    minPeople: count,
                    weeks: z.array(z.number()),
                    weekSessions: z.array(count),
                    intents: z.array(intentRow),
                    themes: z.array(
                        z
                            .object({
                                key: z.string(),
                                topic: z.string(),
                                sessions: count,
                                people: count,
                                ...outcomes,
                                hints: z
                                    .object(
                                        Object.fromEntries(THEME_OUTCOMES.map((hint) => [hint, count])) as Record<
                                            (typeof THEME_OUTCOMES)[number],
                                            typeof count
                                        >,
                                    )
                                    .strict(),
                                weeks: z.array(count),
                                intents: z.array(z.object({ intent: z.string().nullable(), sessions: count }).strict()),
                            })
                            .strict(),
                    ),
                    hidden: z.object({ themes: count, sessions: count }).strict(),
                    more: count,
                })
                .strict(),
        },
    } as const;
}
