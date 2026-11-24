/**
 * The work cycles' layer: one `WorkCycles` on the workspace connection, offered
 * as `Cycles` (what other folders ask) and `CycleUpkeep` (the module's tick).
 * It reads `CycleSources`, which the composition provides. Only the composition
 * (`composition/cycles.ts`) and tests import this file.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import { CycleSources, Cycles, CycleUpkeep, type CycleSourcesShape } from './contract.js';
import type { WorkCycles } from './service.js';
import { sqliteCycles } from './services.js';

/**
 * Work cycles on `db`, over `sources`, with the start's reconciliation
 * begun: what the last process left running is reconciled first, so each
 * run after is a step of a work cycle (CB-211). A step a live runtime
 * still runs (a start-first deploy's previous task, CB-108) is that
 * runtime's to end, never parked here.
 */
export function workCycles(db: DatabaseSync, sources: CycleSourcesShape): WorkCycles {
    const cycles = sqliteCycles(db, {
        conversation: (id) => sources.conversation(id),
        socio: (id) => sources.socio(id),
        limits: () => sources.limits(),
        log: (line) => console.log(line),
    });
    void cycles
        .recover((runId) => sources.alive(runId))
        .catch(() => console.error('Work cycles: the last process’s could not be reconciled.'));
    return cycles;
}

/** `workCycles` over the `CycleSources` tag. */
export const makeCycles = (db: DatabaseSync) =>
    Effect.gen(function* () {
        return workCycles(db, yield* CycleSources);
    });

/** One service under both of its tags: the same instance. */
export const cyclesContext = (cycles: WorkCycles) =>
    Context.make(Cycles, cycles).pipe(Context.add(CycleUpkeep, cycles));

/** `Cycles` and `CycleUpkeep`, built once over `db`; needs `CycleSources`. */
export const CyclesLive = (db: DatabaseSync) => Layer.effectContext(Effect.map(makeCycles(db), cyclesContext));
