import type { ViewState } from './view-state';

// Why a run failed, kept on the device. `/history` sends a
// failed run's code as `failure` since CB-406, which wins; a server before it
// keeps only the run's status, so a run stored there reads only "wasn't
// answered". The live stream (follow.ts) and this
// device's own run POSTs (chat-send.ts's `startRun`) do see the RUN_ERROR:
// its `code` (a shared `TurnFailure` kind) is kept here by run id, so the run's
// problem keeps its specific wording (shared's `problemText`) once it is stored
// and after a restart. Only the code, never the server's text. In
// cache.db's `kv` (`RUN_FAILURES_KEY`), the newest RUN_FAILURES_KEPT: it goes
// with Clear cache and every wipe, and a run it no longer names falls back to
// the plain line.
// No React Native: tests/sync runs it under Node.

/** cache.db's `kv` key: `[[runId, code], …]`, oldest first. */
export const RUN_FAILURES_KEY = 'runs.failures';
/** Failed runs whose code is kept at most. */
export const RUN_FAILURES_KEPT = 200;
/** A code is a short identifier (`cycle_tokens`): anything else isn't kept. */
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

export interface RunFailures {
    /** The RUN_ERROR code run `runId` ended with, as this device saw it, or undefined. */
    codeOf(runId: string): string | undefined;
    /** A RUN_ERROR came for run `runId`. A code that isn't one is ignored. */
    note(runId: string, code: unknown): void;
    /** Calls `listener` after each new code. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
}

function read(text: string | null): [string, string][] {
    if (text === null) {
        return [];
    }
    try {
        const value: unknown = JSON.parse(text);
        return Array.isArray(value)
            ? value.filter(
                  (entry): entry is [string, string] =>
                      Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string',
              )
            : [];
    } catch {
        return [];
    }
}

export function createRunFailures(viewState: Pick<ViewState, 'get' | 'set'>): RunFailures {
    const codes = new Map(read(viewState.get(RUN_FAILURES_KEY)));
    const listeners = new Set<() => void>();
    return {
        codeOf: (runId) => codes.get(runId),
        note(runId, code) {
            if (!runId || typeof code !== 'string' || !CODE.test(code) || codes.get(runId) === code) {
                return;
            }
            codes.delete(runId);
            codes.set(runId, code);
            while (codes.size > RUN_FAILURES_KEPT) {
                codes.delete(codes.keys().next().value!);
            }
            viewState.set(RUN_FAILURES_KEY, JSON.stringify([...codes]));
            for (const listener of [...listeners]) {
                listener();
            }
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
    };
}
