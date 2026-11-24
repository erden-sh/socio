// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';

import type { DotTurn } from '@socio/foundation/turns/turn';
import { rankByWords } from '@socio/shared/text/rank-words';

import type { ContextNotes } from './notes.js';

/**
 * `search_notes` (CB-134): with the `pointer` selection, a long chat's
 * prompt carries only a core of its pinned facts and a line saying the
 * rest are stored; the Dot finds them here, in the thread's own fact store
 * and its notes' names. Facts best first by words, the newer on a tie.
 */

const FACT_HITS = 12;
const NAME_HITS = 12;

export function searchNotesTool(
    turn: Pick<DotTurn, 'threadId' | 'check'>,
    notes: ContextNotes,
    /** The chat has other people in it (CB-210): only notes written for it. */
    shared: () => Promise<boolean> = async () => false,
) {
    return defineTool({
        name: 'search_notes',
        description:
            'Search the pinned facts kept from earlier in this conversation (what the person is working on, their goals, decisions and preferences, results) and the names, ids, paths and links it mentioned. Use words from what you need ("report cadence", "dataset for churn"). Returns matching facts word for word, newest last; recall reads the original messages.',
        parameters: z.object({ query: z.string().min(1).max(300) }),
        execute: async ({ query }) => {
            turn.check();
            const kept = notes.get(turn.threadId);
            // Notes kept for one person's chat alone, before it had others in
            // it, are not for them (CB-210): until they start over, nothing.
            const usable = !(await shared()) || kept?.audience === 'shared';
            turn.check();
            const facts = usable ? notes.facts(turn.threadId).map((stored) => stored.fact) : [];
            const names = (usable && kept?.names) || [];
            const found = rankByWords(query, facts).slice(0, FACT_HITS);
            const named = rankByWords(query, names).slice(0, NAME_HITS);
            return {
                query,
                facts: found.sort((a, b) => a - b).map((index) => facts[index]),
                names: named.sort((a, b) => a - b).map((index) => names[index]),
                storedFacts: facts.length,
                ...(found.length || named.length
                    ? {}
                    : {
                          note: 'No stored fact matches. Try other words, or recall with a query to search the messages themselves.',
                      }),
            };
        },
    });
}
