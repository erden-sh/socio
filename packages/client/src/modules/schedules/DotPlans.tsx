import { CalendarClock, Target } from 'lucide-react';

import type { GoalStatus, SchedulesState } from '@socio/shared/schedule-types';
import type { Dot } from '@socio/shared/types';

import { LocalTime } from '../../lib/local-time';
import { DotPanel, DotPanelItem, DotPanelAction, useDotPanelData } from '../../shell/DotPanel';

/** "Mon, Oct 19, 09:00", in the reader's words once hydrated. */
const nextRun = (value: number) =>
    new Date(value).toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });

const goalStatus: Record<GoalStatus, string> = {
    active: 'Active',
    paused: 'Paused',
    done: 'Done',
    cancelled: 'Canceled',
};
// Open goals first, then the newest.
const goalOrder: Record<GoalStatus, number> = {
    active: 0,
    paused: 1,
    done: 2,
    cancelled: 3,
};

/**
 * A Dot's home page, Next (CB-89): the signed-in person's goals for it,
 * with status and the latest progress note, and its schedules that will
 * run again, soonest first. A goal's own schedule is the goal's, not
 * listed twice. Only theirs (`/api/schedules` is).
 */
export function DotPlans({ dot }: { dot: Dot }) {
    const { data, failed } = useDotPanelData<SchedulesState>('/schedules', 'schedules');
    const loading = !data && !failed;
    const goals = (data?.goals ?? [])
        .filter((goal) => goal.dotId === dot.id && goal.status !== 'cancelled')
        .sort((a, b) => goalOrder[a.status] - goalOrder[b.status]);
    const goalSchedules = new Set(data?.goals.map((goal) => goal.scheduleId));
    const schedules = (data?.schedules ?? [])
        .filter(
            (item) =>
                item.dotId === dot.id &&
                !goalSchedules.has(item.id) &&
                item.status !== 'cancelled' &&
                item.status !== 'completed',
        )
        .sort((a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER));
    return (
        <>
            <DotPanel
                slot="goals"
                icon={Target}
                tone="emerald"
                title="Goals"
                count={goals.length}
                loading={loading}
                failed={failed}
                empty={
                    failed
                        ? 'Could not load goals.'
                        : dot.archivedAt
                          ? 'No goals.'
                          : `Ask ${dot.name} in a chat to work toward a goal for you.`
                }
            >
                {goals.map((goal) => (
                    <DotPanelItem
                        key={goal.id}
                        to={goal.threadId ? `/chats/${encodeURIComponent(goal.threadId)}` : '/schedules'}
                        icon={<Target />}
                        title={goal.title}
                        meta={
                            goal.comments.length
                                ? `${goalStatus[goal.status]} · ${goal.comments.length === 1 ? '1 comment' : `${goal.comments.length} comments`}`
                                : goalStatus[goal.status]
                        }
                        detail={goal.progress ?? 'No progress yet'}
                    />
                ))}
            </DotPanel>
            <DotPanel
                slot="schedules"
                icon={CalendarClock}
                tone="violet"
                title="Scheduled"
                count={schedules.length}
                loading={loading}
                failed={failed}
                empty={failed ? 'Could not load schedules.' : 'Nothing scheduled.'}
                action={<DotPanelAction to="/schedules">Schedules</DotPanelAction>}
            >
                {schedules.map((item) => (
                    <DotPanelItem
                        key={item.id}
                        to={item.threadId ? `/chats/${encodeURIComponent(item.threadId)}` : '/schedules'}
                        icon={<CalendarClock />}
                        title={item.title}
                        meta={
                            item.status === 'paused' ? (
                                'Paused'
                            ) : item.status === 'running' ? (
                                'Running'
                            ) : item.nextRunAt ? (
                                <LocalTime value={item.nextRunAt} format={nextRun} />
                            ) : undefined
                        }
                        detail={item.cadence ?? undefined}
                    />
                ))}
            </DotPanel>
        </>
    );
}
