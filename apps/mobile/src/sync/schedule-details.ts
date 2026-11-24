import type {
    JobDetail,
    JobRunsPage,
    JobRunView,
    ScheduleDetail,
    ScheduleRunsPage,
} from '@socio/shared/schedule-types';
import type { Detail } from '@socio/shared/types';

import type { SqlConnection } from '../data';
import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';

import { type BoundedKindDefinition, type BoundedStore, createBoundedStore } from './bounded-kind';
import { SnapshotShapeError } from './errors';

// The details behind Scheduled & activity and Schedules: a scheduled task's
// (`GET /api/tasks/:id`), a schedule's (`GET /api/schedules/:id`) and a
// job's (`GET /api/schedules/jobs/:id`), each a bounded kind
// (bounded-kind.ts) kept in cache.db, so a detail opened once shows offline
// with its age. Each is read as its screen opens (`use()`) and
// again when its list row changes (the list polls every 10 s while shown, as
// the web's pages do) or after an action on it; never on a timer of its own. A
// 404 drops it ("no longer here").
//
// Older runs past a detail's first page (`…/runs?before=`) and a job run's
// logs (`/schedules/runs/:id`) are read online only, as the person asks, and
// never kept: the first page is what shows offline.
// No React Native: tests/sync runs it under Node.

export const TASK_DETAILS_KIND = 'task-details';
export const SCHEDULE_DETAILS_KIND = 'schedule-details';
export const JOB_DETAILS_KIND = 'job-details';

const BOUNDS = { items: 20, chars: 2_000_000 };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function check(path: string, body: unknown, head: string, lists: readonly string[]): Record<string, unknown> {
    if (!isObject(body) || !isObject(body[head]) || typeof body[head].id !== 'string') {
        throw new SnapshotShapeError(path, `no ${head}.`);
    }
    for (const name of lists) {
        if (!Array.isArray(body[name])) {
            throw new SnapshotShapeError(path, `no ${name}.`);
        }
    }
    return body;
}

/** A scheduled task with its runs and events (the web's Activity detail). */
export const TASK_DETAILS: BoundedKindDefinition<Detail> = {
    name: TASK_DETAILS_KIND,
    format: 1,
    bounds: BOUNDS,
    path: (id) => `/api/tasks/${encodeURIComponent(id)}`,
    parse: (path, body) => check(path, body, 'task', ['runs', 'events']) as unknown as Detail,
    version: (detail) => detail.task.updatedAt,
};

/** A schedule in full: its facts, next runs, goal and first page of runs (CB-88). */
export const SCHEDULE_DETAILS: BoundedKindDefinition<ScheduleDetail> = {
    name: SCHEDULE_DETAILS_KIND,
    format: 1,
    bounds: BOUNDS,
    path: (id) => `/api/schedules/${encodeURIComponent(id)}`,
    parse: (path, body) => check(path, body, 'schedule', ['runs', 'upcoming']) as unknown as ScheduleDetail,
};

/** A job: its versions, long run and first page of runs. */
export const JOB_DETAILS: BoundedKindDefinition<JobDetail> = {
    name: JOB_DETAILS_KIND,
    format: 1,
    bounds: BOUNDS,
    path: (id) => `/api/schedules/jobs/${encodeURIComponent(id)}`,
    parse: (path, body) => check(path, body, 'job', ['runs', 'versions']) as unknown as JobDetail,
    version: (detail) => detail.job.updatedAt,
};

/** What each of the three kinds holds. */
export interface ScheduleDetailItems {
    readonly tasks: Detail;
    readonly schedules: ScheduleDetail;
    readonly jobs: JobDetail;
}

/** The three detail kinds of one scope. */
export interface ScheduleDetails {
    readonly tasks: BoundedStore<Detail>;
    readonly schedules: BoundedStore<ScheduleDetail>;
    readonly jobs: BoundedStore<JobDetail>;
    close(): Promise<void>;
}

export interface ScheduleDetailsOptions {
    readonly db: SqlConnection;
    readonly fetch: AuthedFetch;
    readonly signal?: AbortSignal;
    readonly onError?: (error: unknown) => void;
    readonly now?: () => number;
}

/** Opens the scope's task, schedule and job details on its cache.db. */
export function createScheduleDetails(options: ScheduleDetailsOptions): ScheduleDetails {
    const tasks = createBoundedStore<Detail>({ definition: TASK_DETAILS, ...options });
    const schedules = createBoundedStore<ScheduleDetail>({ definition: SCHEDULE_DETAILS, ...options });
    const jobs = createBoundedStore<JobDetail>({ definition: JOB_DETAILS, ...options });
    return {
        tasks,
        schedules,
        jobs,
        async close() {
            await Promise.allSettled([tasks.close(), schedules.close(), jobs.close()]);
        },
    };
}

// ---- Online only ---------------------------------------------------------------

async function readOnline(fetch: AuthedFetch, path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(path, signal === undefined ? {} : { signal });
    if (!response.ok) {
        throw new Error(`${path} answered ${response.status}.`);
    }
    return readJson(response, signal);
}

const runsPage = <T>(path: string, body: unknown): { runs: T[]; more: boolean } => {
    if (!isObject(body) || !Array.isArray(body.runs)) {
        throw new SnapshotShapeError(path, 'no runs.');
    }
    return { runs: body.runs as T[], more: body.more === true };
};

/** The path of a schedule's (`schedule`) or a job's (`job`) runs older than run `before`. */
export function olderRunsPath(of: 'schedule' | 'job', id: string, before: string): string {
    const base =
        of === 'job' ? `/api/schedules/jobs/${encodeURIComponent(id)}` : `/api/schedules/${encodeURIComponent(id)}`;
    return `${base}/runs?before=${encodeURIComponent(before)}`;
}

/** A schedule's runs older than run `before` (online only, never kept). Rejects offline or on a refusal. */
export async function readOlderScheduleRuns(
    fetch: AuthedFetch,
    input: { scheduleId: string; before: string },
    signal?: AbortSignal,
): Promise<ScheduleRunsPage> {
    const path = olderRunsPath('schedule', input.scheduleId, input.before);
    return runsPage(path, await readOnline(fetch, path, signal));
}

/** A job's runs older than run `before` (online only, never kept). */
export async function readOlderJobRuns(
    fetch: AuthedFetch,
    input: { jobId: string; before: string },
    signal?: AbortSignal,
): Promise<JobRunsPage> {
    const path = olderRunsPath('job', input.jobId, input.before);
    return runsPage(path, await readOnline(fetch, path, signal));
}

/** One job run with its logs (`/schedules/runs/:id`, online only, never kept: logs may hold a job's output). */
export async function readJobRun(fetch: AuthedFetch, runId: string, signal?: AbortSignal): Promise<JobRunView> {
    const path = `/api/schedules/runs/${encodeURIComponent(runId)}`;
    const body = await readOnline(fetch, path, signal);
    if (!isObject(body) || typeof body.id !== 'string') {
        throw new SnapshotShapeError(path, 'no run.');
    }
    return body as unknown as JobRunView;
}
