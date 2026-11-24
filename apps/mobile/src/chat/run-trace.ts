import type { RunTraceView } from '@socio/shared/runs/run-trace';

import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';
import { httpError, SnapshotShapeError } from '../sync/errors';

// A run's trace for Advanced mode: `GET /api/runs/:runId/trace`, through the
// workspace's authedFetch. The server answers its owner (and admins); anyone
// else, and a deleted chat's run, get a 404, which is null here: the sheet
// says the detail isn't there. Any other failure throws, and the sheet offers
// Try again. No React Native here.

export const runTracePath = (runId: string) => `/api/runs/${encodeURIComponent(runId)}/trace`;

export async function loadRunTrace(
    fetch: AuthedFetch,
    runId: string,
    signal?: AbortSignal,
): Promise<RunTraceView | null> {
    const path = runTracePath(runId);
    const response = await fetch(path, signal ? { signal } : undefined);
    if (response.status === 404) {
        await response.body?.cancel().catch(() => {});
        return null;
    }
    if (!response.ok) {
        throw await httpError(response, signal);
    }
    const body = (await readJson(response, signal)) as Partial<RunTraceView> | null;
    if (
        body === null ||
        typeof body !== 'object' ||
        body.runId !== runId ||
        typeof body.status !== 'string' ||
        typeof body.startedAt !== 'number' ||
        !('trace' in body)
    ) {
        throw new SnapshotShapeError(path, 'not a run trace.');
    }
    return body as RunTraceView;
}
