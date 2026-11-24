import type { AgentRunSummary } from '@socio/shared/types';

import type { SnapshotDefinition } from './snapshot-cache';
import { keyed, list, object } from './snapshot-shape';

// The runs kind: Runs'
// list as the server gives it, `GET /api/runs` with no query (the latest 200,
// newest first: src/server/runs/run-routes.ts, through conditionalJsonAsync,
// so a poll with no change is a 304), the shape of the server's RunsList.
// - `runs` holds the summaries by run id, unversioned (a run's status and end
//   change with no version; only a pull's start orders them). Rows are kept by
//   key, so the order isn't: the screen sorts by `startedAt`.
// A trace is never in it: Runs fetches one only on a tap (CB-188). Runs polls it
// every 10 s while in view, as the web's RunsView does.

export const RUNS = 'runs';

/** How often Runs, in view, asks again (the web's RunsView). */
export const RUNS_POLL_MS = 10_000;

const RUNS_PATH = '/api/runs';

/** `GET /api/runs`: the latest runs by id. */
export const RUNS_SNAPSHOT: SnapshotDefinition = {
    id: 'runs',
    path: RUNS_PATH,
    format: 1,
    feeds: [{ collection: RUNS }],
    split(body) {
        const fields = object(RUNS_PATH, body, 'the body');
        return [keyed(RUNS_PATH, list(RUNS_PATH, fields.runs, 'runs'), 'runs', { key: 'runId' })];
    },
};

/** A run's row as its collection holds it: the summary the server sent. */
export const runRow = (_key: string, value: unknown): AgentRunSummary => value as AgentRunSummary;
