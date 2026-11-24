import type { SqliteData } from '@socio/data/open';

import type { ScheduleRepositories, TaskRepositories } from '../../domain/repositories.js';

import { SqliteGoals } from './goals.js';
import { SqliteJobRuns, SqliteJobs } from './jobs.js';
import { SqliteLongRuns } from './long-runs.js';
import { SqliteTaskEvents, SqliteTaskRuns, SqliteTaskThreads, SqliteTasks } from './tasks.js';

/**
 * The Scheduling and jobs context's repositories on a migrated connection
 * (CB-110): the only code that reads or writes its tables. Tasks, their
 * runs and events are on the core store's connection, the rest on the
 * workspace's: one connection in production, two in some tests.
 */
export function sqliteTaskRepositories(data: SqliteData): TaskRepositories {
    return {
        tasks: new SqliteTasks(data),
        runs: new SqliteTaskRuns(data),
        events: new SqliteTaskEvents(data),
    };
}

/** The conversations of scheduled tasks, on the workspace's connection. */
export const sqliteTaskThreads = (data: SqliteData) => new SqliteTaskThreads(data);

/** The rest, on the workspace's connection once `schedules` migrated. */
export function sqliteScheduleRepositories(data: SqliteData): ScheduleRepositories {
    return {
        taskThreads: new SqliteTaskThreads(data),
        jobs: new SqliteJobs(data),
        jobRuns: new SqliteJobRuns(data),
        goals: new SqliteGoals(data),
        longRuns: new SqliteLongRuns(data),
    };
}
