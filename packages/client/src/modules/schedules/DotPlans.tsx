import { CalendarClock, Target } from 'lucide-react';

import { useTranslation } from '@socio/i18n/react';
import { dateTimeFormat } from '@socio/shared/locale';
import type { GoalStatus, SchedulesState } from '@socio/shared/schedule-types';
import type { Dot } from '@socio/shared/types';

import { useInlinedOrOnDemand } from '../../i18n/on-demand';
import { LocalTime } from '../../lib/local-time';
import { DotPanel, DotPanelItem, DotPanelAction, useDotPanelData } from '../../shell/DotPanel';

import { useScheduleWords } from './schedule-words';

/** "Mon, Oct 19, 09:00", in the reader's words once hydrated. */
const nextRunFormat = dateTimeFormat({
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
});
const nextRun = (value: number) => nextRunFormat.format(value);

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
 * listed twice. Only theirs (`/api/schedules` is). Its words load on
 * demand (schedules.plans, schedules), with its data: nothing until both.
 */
export function DotPlans({ dot }: { dot: Dot }) {
    const { data, failed } = useDotPanelData<SchedulesState>('/schedules', 'schedules');
    const worded = useInlinedOrOnDemand(['schedules.plans', 'schedules']);
    const { t } = useTranslation(['schedules.plans']);
    const words = useScheduleWords();
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
    if (!worded) {
        return null;
    }
    return (
        <>
            <DotPanel
                slot="goals"
                icon={Target}
                tone="emerald"
                title={t('schedules.plans:goals.title')}
                count={goals.length}
                loading={loading}
                failed={failed}
                empty={
                    failed
                        ? t('schedules.plans:goals.failed')
                        : dot.archivedAt
                          ? t('schedules.plans:goals.none')
                          : t('schedules.plans:goals.empty', { name: dot.name })
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
                                ? t('schedules.plans:goals.meta', {
                                      status: words.goalStatus(goal.status),
                                      count: goal.comments.length,
                                  })
                                : words.goalStatus(goal.status)
                        }
                        detail={goal.progress ?? t('schedules.plans:goals.no-progress')}
                    />
                ))}
            </DotPanel>
            <DotPanel
                slot="schedules"
                icon={CalendarClock}
                tone="violet"
                title={t('schedules.plans:scheduled.title')}
                count={schedules.length}
                loading={loading}
                failed={failed}
                empty={failed ? t('schedules.plans:scheduled.failed') : t('schedules.plans:scheduled.empty')}
                action={<DotPanelAction to="/schedules">{t('schedules.plans:scheduled.all')}</DotPanelAction>}
            >
                {schedules.map((item) => (
                    <DotPanelItem
                        key={item.id}
                        to={item.threadId ? `/chats/${encodeURIComponent(item.threadId)}` : '/schedules'}
                        icon={<CalendarClock />}
                        title={item.title}
                        meta={
                            item.status === 'paused' ? (
                                t('schedules.plans:scheduled.paused')
                            ) : item.status === 'running' ? (
                                t('schedules.plans:scheduled.running')
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
