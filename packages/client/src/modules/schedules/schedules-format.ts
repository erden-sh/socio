import { compareText, lowerText } from '@socio/shared/locale';
import type { ScheduleView } from '@socio/shared/schedule-types';
import type { Status } from '@socio/shared/types';

/**
 * The Schedules grid's words and order (CB-392): the same data-grid
 * treatment as the People grid in Settings — search, a status filter, a
 * socio filter, and a default sort that keeps active work above the rest.
 */

/** Friendly status labels, matching the detail page's `standing()`. */
export const STATUS_LABELS: Record<Status, string> = {
    scheduled: 'Active',
    running: 'Running',
    queued: 'Queued',
    paused: 'Paused',
    failed: 'Stopped',
    interrupted: 'Interrupted',
    completed: 'Completed',
    cancelled: 'Canceled',
};

/** A status badge's tone, like the run badges. */
export const STATUS_TONE: Record<Status, 'default' | 'secondary' | 'destructive'> = {
    scheduled: 'default',
    running: 'default',
    queued: 'secondary',
    paused: 'secondary',
    failed: 'destructive',
    interrupted: 'secondary',
    completed: 'secondary',
    cancelled: 'secondary',
};

/** Default sort: running now first, then active, then paused, then terminal. */
const STATUS_ORDER: Record<Status, number> = {
    running: 0,
    scheduled: 1,
    queued: 2,
    paused: 3,
    failed: 4,
    interrupted: 5,
    completed: 6,
    cancelled: 7,
};

export const byStatusThenTitle = (a: ScheduleView, b: ScheduleView) =>
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || compareText(a.title, b.title);

export interface ScheduleFilter {
    /** Free text: matches a schedule's title, socio or job name. */
    query: string;
    /** A status, or '' for any. */
    status: Status | '';
    /** A socio's `dotId`, '__none' for a deleted socio, or '' for any. */
    dot: string;
}

/**
 * The socio options on the list: each distinct `dotId` the schedules name,
 * sorted by name. A schedule whose socio was deleted groups under
 * '__none' ("A deleted socio").
 */
export function dotOptions(schedules: ScheduleView[]): Array<{ value: string; label: string }> {
    const seen = new Map<string, string>();
    for (const schedule of schedules) {
        const key = schedule.dotId ?? '__none';
        if (!seen.has(key)) {
            seen.set(key, schedule.dotName ?? 'A deleted socio');
        }
    }
    return [...seen.entries()]
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => compareText(a.label, b.label));
}

export const matches = (schedule: ScheduleView, { query, status, dot }: ScheduleFilter) => {
    const words = lowerText(query.trim());
    return (
        (!words ||
            lowerText(`${schedule.title} ${schedule.dotName ?? ''} ${schedule.jobName ?? ''}`).includes(words)) &&
        (!status || schedule.status === status) &&
        (!dot || (schedule.dotId ?? '__none') === dot)
    );
};
