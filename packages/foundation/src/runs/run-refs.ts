import type { DatabaseSync } from 'node:sqlite';

import { RUN_REF_KINDS, RUN_REF_MAX, type RunRef, type RunRefRecorder } from '@socio/shared/runs/run-refs';

// Moved from the server's `runs/infra/sqlite/run-refs.ts`: the turn runner,
// below the runs feature, records each turn's references with it, and runs'
// `RunRefs` tag serves it.

/** Connections known to have `run_refs` (a test's may not). */
const ready = new WeakSet<DatabaseSync>();
function hasTable(db: DatabaseSync) {
    if (ready.has(db)) {
        return true;
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='run_refs'").get()) {
        ready.add(db);
    }
    return ready.has(db);
}

/**
 * What grounded a turn (CB-194), written to `run_refs` (the Runs module's,
 * migration 5) as the turn's tools read: references only. Each is kept
 * once per turn (the first time it was read); a write that fails, or a
 * reference too long to keep, is skipped, never failing the tool. On the
 * runner's own connection, as `agent_runs` is written (`LocalAgentRunner`):
 * one autocommit statement per reference, with no unit of work to join.
 */
export function runRefRecorder(
    db: DatabaseSync,
    runId: string,
    threadId: string,
    now: () => number = Date.now,
): RunRefRecorder {
    return (input) => {
        const refs = (Array.isArray(input) ? input : [input]) as RunRef[];
        const kept = refs.filter(
            (ref) =>
                RUN_REF_KINDS.includes(ref.kind) &&
                typeof ref.refId === 'string' &&
                ref.refId.length > 0 &&
                ref.refId.length <= RUN_REF_MAX,
        );
        if (!kept.length) {
            return;
        }
        const at = now();
        try {
            if (!hasTable(db)) {
                return;
            }
            const insert = db.prepare(
                'INSERT OR IGNORE INTO run_refs (runId, threadId, kind, spaceId, refId, at) VALUES (?, ?, ?, ?, ?, ?)',
            );
            for (const ref of kept) {
                insert.run(runId, threadId, ref.kind, ref.spaceId ?? null, ref.refId, at);
            }
        } catch {
            // A busy or older database must not fail the read.
        }
    };
}
