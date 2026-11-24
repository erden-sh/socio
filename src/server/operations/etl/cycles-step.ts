import { sqliteSourceReader } from '../infra/sqlite/source-reader.js';

import type { TypedCell } from './append.js';
import { keysetStep } from './health-steps.js';
import { CYCLE_DDL } from './schema.js';
import { ETL_BATCH, type SourceCycle, type SourceReader } from './source-reader.js';

/** A positive number from the cycle's stored limits, else null. */
function limitOf(limits: string, key: string): number | null {
    try {
        const value = (JSON.parse(limits) as Record<string, unknown>)[key];
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
    } catch {
        return null;
    }
}

/**
 * Work cycles (CB-211) into `f_cycle` (CB-218), by `(startedAt, id)`:
 * one person's message and every step it led to, with who started it,
 * whose access it used, who paid, its ledger's tokens and spend and why
 * it ended. A cycle not yet ended is read again until it is, as Health's
 * job runs are. Ids, kinds, counts and times only.
 */
export const cyclesStep = keysetStep<SourceCycle, SourceReader>({
    source: 'work_cycles',
    ddl: CYCLE_DDL,
    table: 'f_cycle',
    reader: sqliteSourceReader,
    ready: (reader) => reader.ready() && reader.hasCycles(),
    after: (reader, mark) => reader.cyclesAfter(mark, ETL_BATCH),
    byId: (reader, ids) => reader.cyclesById(ids),
    at: (cycle) => cycle.startedAt,
    open: (cycle) => cycle.status !== 'ended',
    typed: true,
    cells: (cycle): TypedCell[] => {
        const payer = cycle.billingKind === 'person' || cycle.billingKind === 'workspace' ? cycle.billingKind : null;
        const tokenLimit = limitOf(cycle.limits, 'cycleTokens');
        const known = !!cycle.costKnown;
        return [
            cycle.id,
            cycle.conversationId,
            cycle.kind === 'room' ? 'room' : 'private',
            cycle.initiatorKind,
            cycle.initiatorId,
            cycle.actingUserId,
            cycle.dotId,
            payer,
            payer === 'person' ? cycle.billingUserId : null,
            cycle.status,
            BigInt(cycle.startedAt),
            cycle.endedAt === null ? null : BigInt(cycle.endedAt),
            BigInt(Math.max(0, Math.trunc(cycle.elapsedMs))),
            BigInt(cycle.steps),
            BigInt(cycle.handoffs),
            BigInt(Math.max(0, Math.trunc(cycle.tokensUsed))),
            // Unknown once any request reported none: never 0.
            known && cycle.costUsd !== null ? cycle.costUsd : null,
            known,
            tokenLimit === null ? null : BigInt(Math.trunc(tokenLimit)),
            limitOf(cycle.limits, 'cycleSpendUsd'),
            cycle.endReason,
        ];
    },
});
