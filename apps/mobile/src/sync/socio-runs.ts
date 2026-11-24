import type { AgentRunStatus, DotRun } from '@socio/shared/types';

import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';

// A socio's latest turns for its page (CB-431): the web's own DotHome read,
// `GET /api/dots/:id/runs` (CB-89: the latest 10 of the person's own chats with
// it, archived ones too; another person's own socio is a 404). Online only and
// never kept: the page asks once as it opens and again as it comes back into
// view; offline it says so. No React Native, so tests/sync runs it under Node.

export const socioRunsPath = (socioId: string) => `/api/dots/${encodeURIComponent(socioId)}/runs`;

const STATUSES: readonly AgentRunStatus[] = ['running', 'finished', 'stopped', 'failed', 'interrupted'];

const isRun = (value: unknown): value is DotRun => {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const run = value as Record<string, unknown>;
    return (
        typeof run.runId === 'string' &&
        typeof run.threadId === 'string' &&
        typeof run.title === 'string' &&
        typeof run.startedAt === 'number' &&
        STATUSES.includes(run.status as AgentRunStatus)
    );
};

/** The socio's turns, newest first as the server lists them. A refusal or another shape throws. */
export async function readSocioRuns(fetch: AuthedFetch, socioId: string, signal?: AbortSignal): Promise<DotRun[]> {
    const response = await fetch(socioRunsPath(socioId), signal === undefined ? {} : { signal });
    if (!response.ok) {
        throw new Error(`The socio's turns answered ${response.status}.`);
    }
    const body = await readJson(response, signal);
    if (!Array.isArray(body) || !body.every(isRun)) {
        throw new Error("The socio's turns answered something else.");
    }
    return body;
}
