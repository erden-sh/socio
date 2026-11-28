import { Clock3, Pause, Play, Square } from 'lucide-react';

import { useTranslation } from '@socio/i18n/react';
import type { Action, Settings, Task } from '@socio/shared/types';

import { Button } from '@/components/ui/button';

// The task card's quiet, small controls.
const control = 'h-8 rounded-[9px] px-2.5 text-xs font-normal text-muted-foreground shadow-none';
export function TaskActions({
    task,
    busy,
    settings,
    onAction,
    onSchedule,
}: {
    task: Task;
    busy: boolean;
    settings: Settings;
    onAction: (action: Action) => void;
    onSchedule: () => void;
}) {
    const { t } = useTranslation(['activity']);
    const active = task.status === 'running' || task.status === 'queued';
    return (
        <div data-slot="task-controls" className="my-6 flex flex-wrap gap-2">
            {active ? (
                <Button variant="outline" className={control} disabled={busy} onClick={() => onAction('pause')}>
                    <Pause className="size-3.5" />
                    {t('activity:actions.pause')}
                </Button>
            ) : (
                <Button
                    variant="outline"
                    className={control}
                    disabled={busy || settings.paused || !settings.researchAllowed}
                    onClick={() => onAction('run')}
                >
                    <Play className="size-3.5" />
                    {task.status === 'interrupted'
                        ? t('activity:actions.retry-review')
                        : task.status === 'failed'
                          ? t('activity:actions.retry')
                          : task.status === 'paused'
                            ? t('activity:actions.resume')
                            : t('activity:actions.run')}
                </Button>
            )}
            {task.status === 'completed' && !!task.intervalSeconds && (
                <Button variant="outline" className={control} disabled={busy} onClick={() => onAction('pause')}>
                    <Pause className="size-3.5" />
                    {t('activity:actions.pause-schedule')}
                </Button>
            )}
            <Button variant="outline" className={control} onClick={onSchedule}>
                <Clock3 className="size-3.5" />
                {task.intervalSeconds ? t('activity:actions.edit-schedule') : t('activity:actions.set-schedule')}
            </Button>
            {task.status !== 'cancelled' && (
                <Button variant="ghost" className={control} disabled={busy} onClick={() => onAction('cancel')}>
                    <Square className="size-3" />
                    {t('activity:actions.cancel')}
                </Button>
            )}
        </div>
    );
}
