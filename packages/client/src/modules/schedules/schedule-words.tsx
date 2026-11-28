import { useTranslation } from '@socio/i18n/react';
import { dateTimeFormat } from '@socio/shared/locale';
import type { GoalStatus } from '@socio/shared/schedule-types';
import type { Status } from '@socio/shared/types';

import { LocalTime } from '../../lib/local-time';

import { Badge } from '@/components/ui/badge';

/** "Oct 19, 2026, 9:00 AM": a time in the reader's locale. */
export const dateTime = dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' });
const formatDateTime = (at: number) => dateTime.format(at);

/** A time in the reader's words once the page has hydrated; else a dash. */
export function When({ value }: { value: number | null | undefined }) {
    return value ? <LocalTime value={value} format={formatDateTime} /> : '—';
}

/** The run statuses a badge has words for: a schedule's, a job run's and a long run's. */
const RUN_STATUSES = [
    'queued',
    'starting',
    'running',
    'waiting',
    'succeeded',
    'completed',
    'done',
    'failed',
    'timed_out',
    'interrupted',
    'cancelled',
    'paused',
    'scheduled',
] as const;
type RunStatus = (typeof RUN_STATUSES)[number];
const isRunStatus = (status: string): status is RunStatus => (RUN_STATUSES as readonly string[]).includes(status);

/**
 * The words Schedules shows for what it stores (`schedules`): a schedule's
 * status, a run's, a goal's, and a conversation task's repeat interval.
 * A run status the client doesn't know shows as stored.
 */
export function useScheduleWords() {
    const { t } = useTranslation(['schedules']);
    return {
        status: (status: Status) => t(`schedules:status.${status}`),
        runStatus: (status: string) =>
            isRunStatus(status) ? t(`schedules:run-status.${status}`) : status.replace('_', ' '),
        goalStatus: (status: GoalStatus) => t(`schedules:goal-status.${status}`),
        /** A task's repeat interval, after each successful run: "Every day, …", "Every 2 hours, …". */
        interval: (seconds: number) =>
            seconds === 604_800
                ? t('schedules:interval.week')
                : seconds === 86_400
                  ? t('schedules:interval.day')
                  : seconds === 3600
                    ? t('schedules:interval.hour')
                    : seconds % 3600 === 0
                      ? t('schedules:interval.hours', { count: seconds / 3600 })
                      : t('schedules:interval.minutes', { count: Math.round(seconds / 60) }),
    };
}

const RUN_TONE: Record<string, 'default' | 'secondary' | 'destructive'> = {
    succeeded: 'default',
    completed: 'default',
    done: 'default',
    cancelled: 'secondary',
    failed: 'destructive',
    timed_out: 'destructive',
    interrupted: 'secondary',
};
export function RunBadge({ status }: { status: string }) {
    const words = useScheduleWords();
    return (
        <Badge variant={RUN_TONE[status] ?? 'outline'} data-status={status}>
            {words.runStatus(status)}
        </Badge>
    );
}
