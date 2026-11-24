import type { RunTraceView } from '@socio/shared/runs/run-trace';
import type { AgentRunSummary } from '@socio/shared/types';

import { runTracePath } from '../chat/run-trace';
import type { SqlConnection } from '../data';
import type { AuthedFetch } from '../net/authed-fetch';

import { type BoundedKindDefinition, type BoundedStore, createBoundedStore } from './bounded-kind';
import { SnapshotShapeError } from './errors';

// Runs' traces: `GET /api/runs/:runId/trace`
// (run-trace.ts's path), a bounded kind read only when the person taps a run:
// never by the Runs list, never preloaded from the network, never on a timer.
// An admin's open of someone else's trace writes the server's access log
// (run-routes.ts, CB-188, `once: 'always'`), so each read is one the person
// asked for.
// - The person's own traces stay on disk (30, LRU), so one opened once shows
//   offline with its age.
// - Someone else's never reach disk (`memoryOnly`): whose a run is comes from
//   the `runs` kind's row (`ownerId`, the server's own test for the log), and a
//   run the phone can't place is treated as someone else's.
// - A 404 (another person's turn, a deleted chat) drops it: "isn't available".
// No React Native: tests/sync runs it under Node.

export const RUN_TRACES_KIND = 'run-traces';

const BOUNDS = { items: 30, chars: 3_000_000 };

/** A run's trace, as `/api/runs/:runId/trace` answers it. */
export const RUN_TRACES: BoundedKindDefinition<RunTraceView> = {
    name: RUN_TRACES_KIND,
    format: 1,
    bounds: BOUNDS,
    path: runTracePath,
    parse(path, body) {
        const view = body as Partial<RunTraceView> | null;
        if (
            view === null ||
            typeof view !== 'object' ||
            typeof view.runId !== 'string' ||
            typeof view.status !== 'string' ||
            typeof view.startedAt !== 'number' ||
            !('trace' in view)
        ) {
            throw new SnapshotShapeError(path, 'not a run trace.');
        }
        if (runTracePath(view.runId) !== path) {
            // Another run's trace under this key: never shown or kept as this one's.
            throw new SnapshotShapeError(path, 'another run’s trace.');
        }
        return view as RunTraceView;
    },
};

export interface RunTracesOptions {
    readonly db: SqlConnection;
    readonly fetch: AuthedFetch;
    /** Whether run `runId` is the person's own (its `runs` row's `ownerId`): only those reach disk. */
    readonly ownRun: (runId: string) => boolean;
    readonly signal?: AbortSignal;
    readonly onError?: (error: unknown) => void;
    readonly now?: () => number;
}

/** Opens the scope's run traces on its cache.db. */
export function createRunTraces(options: RunTracesOptions): BoundedStore<RunTraceView> {
    const { ownRun, ...rest } = options;
    return createBoundedStore<RunTraceView>({
        definition: RUN_TRACES,
        ...rest,
        memoryOnly: (runId) => !ownRun(runId),
    });
}

/** Whether `run` is `me`'s own: the server's test before it writes the access log. */
export const isOwnRun = (run: Pick<AgentRunSummary, 'ownerId'> | null | undefined, me: string): boolean =>
    run !== null && run !== undefined && run.ownerId === me;
