import type { GoalView, JobView, ScheduleView, SchedulesState } from '@socio/shared/schedule-types';

import type { SnapshotDefinition } from './snapshot-cache';
import { keyed, list, object, singleton } from './snapshot-shape';

// The schedules kind: the
// Schedules page as the server gives it, `GET /api/schedules`
// (src/server/schedules/routes.ts, through conditionalJson, so a poll with no
// change is a 304), the shape packages/shared's SchedulesState.
// - `schedules` holds the schedules by id, unversioned (they have no
//   `updatedAt`: only a pull's start orders them against a confirmed write);
// - `goals` holds the goals by id, each with all its comments, versioned by
//   `updatedAt`;
// - `jobs` holds the jobs by id, versioned by `updatedAt`;
// - `schedule-limits` holds the limits, the person's usage and an operator's
//   counts as one row, `limits`, under the same ETag.
// Scheduled tasks aren't here: they stay in the shell's `/api/state` row
// (`state.tasks`), which the shell syncs. Schedules polls it every 10 s while in view,
// as the web's SchedulesPage does.

export const SCHEDULES = 'schedules';
export const GOALS = 'goals';
export const JOBS = 'jobs';
export const SCHEDULE_LIMITS = 'schedule-limits';
/** The `schedule-limits` collection's one row. */
export const LIMITS_KEY = 'limits';

/** How often Schedules, in view, asks again (the web's SchedulesPage). */
export const SCHEDULES_POLL_MS = 10_000;

/** The `schedule-limits` row: what the body says besides its lists. */
export interface ScheduleLimitsRow extends Pick<SchedulesState, 'limits' | 'usage' | 'counts'> {
    readonly id: typeof LIMITS_KEY;
}

const SCHEDULES_PATH = '/api/schedules';

/** `GET /api/schedules`: schedules, goals and jobs by id, and the limits as one row. */
export const SCHEDULES_SNAPSHOT: SnapshotDefinition = {
    id: 'schedules',
    path: SCHEDULES_PATH,
    format: 1,
    feeds: [{ collection: SCHEDULES }, { collection: GOALS }, { collection: JOBS }, { collection: SCHEDULE_LIMITS }],
    split(body) {
        const fields = object(SCHEDULES_PATH, body, 'the body');
        const limits = object(SCHEDULES_PATH, fields.limits, 'limits');
        const usage = object(SCHEDULES_PATH, fields.usage, 'usage');
        const counts = fields.counts === undefined ? {} : { counts: object(SCHEDULES_PATH, fields.counts, 'counts') };
        const of = (name: string) => list(SCHEDULES_PATH, fields[name], name);
        return [
            keyed(SCHEDULES_PATH, of('schedules'), 'schedules', { key: 'id' }),
            keyed(SCHEDULES_PATH, of('goals'), 'goals', { key: 'id', version: 'updatedAt' }),
            keyed(SCHEDULES_PATH, of('jobs'), 'jobs', { key: 'id', version: 'updatedAt' }),
            [singleton(LIMITS_KEY, { limits, usage, ...counts })],
        ];
    },
};

/** A schedule's row as its collection holds it. */
export const scheduleRow = (_key: string, value: unknown): ScheduleView => value as ScheduleView;
/** A goal's row, with its comments. */
export const goalRow = (_key: string, value: unknown): GoalView => value as GoalView;
/** A job's row. */
export const jobRow = (_key: string, value: unknown): JobView => value as JobView;
/** The `schedule-limits` row from its stored value. */
export const scheduleLimitsRow = (key: string, value: unknown): ScheduleLimitsRow =>
    ({ id: key, ...(value as object) }) as ScheduleLimitsRow;
