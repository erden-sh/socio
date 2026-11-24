import { Clock3, Pause, Play, Square } from 'lucide-react';

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
    const active = task.status === 'running' || task.status === 'queued';
    return (
        <div data-slot="task-controls" className="my-6 flex flex-wrap gap-2">
            {active ? (
                <Button variant="outline" className={control} disabled={busy} onClick={() => onAction('pause')}>
                    <Pause className="size-3.5" />
                    Pause task
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
                        ? 'Retry after review'
                        : task.status === 'failed'
                          ? 'Retry task'
                          : task.status === 'paused'
                            ? 'Resume task'
                            : 'Run again'}
                </Button>
            )}
            {task.status === 'completed' && !!task.intervalSeconds && (
                <Button variant="outline" className={control} disabled={busy} onClick={() => onAction('pause')}>
                    <Pause className="size-3.5" />
                    Pause schedule
                </Button>
            )}
            <Button variant="outline" className={control} onClick={onSchedule}>
                <Clock3 className="size-3.5" />
                {task.intervalSeconds ? 'Edit schedule' : 'Set a schedule'}
            </Button>
            {task.status !== 'cancelled' && (
                <Button variant="ghost" className={control} disabled={busy} onClick={() => onAction('cancel')}>
                    <Square className="size-3" />
                    Cancel
                </Button>
            )}
        </div>
    );
}
