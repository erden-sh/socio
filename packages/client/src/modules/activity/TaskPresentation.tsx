import { CheckCheck, ChevronRight, LoaderCircle, MessageCircle } from 'lucide-react';

import type { Task } from '@socio/shared/types';

import { LocalTime } from '../../lib/local-time';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export const relative = (value: number) => {
    const minutes = Math.floor((Date.now() - value) / 60000);
    return minutes < 1
        ? 'Just now'
        : minutes < 60
          ? `${minutes}m ago`
          : minutes < 1440
            ? `${Math.floor(minutes / 60)}h ago`
            : new Date(value).toLocaleDateString();
};
export const statusLabel = (task: Task) =>
    task.status === 'completed' && task.nextRunAt
        ? 'Scheduled'
        : task.status.charAt(0).toUpperCase() + task.status.slice(1);
// The status chip's tones, as the Activity list had them.
const STATUS_TONE: Partial<Record<Task['status'], string>> = {
    completed: 'bg-emerald-50 text-emerald-900/55 dark:bg-emerald-500/5 dark:text-emerald-100/60',
    running: 'bg-indigo-50 text-indigo-800/55 dark:bg-indigo-500/5 dark:text-indigo-200/70',
    failed: 'bg-red-50 text-red-900/55 dark:bg-red-500/5 dark:text-red-200/70',
    paused: 'bg-amber-50 text-amber-900/55 dark:bg-amber-500/5 dark:text-amber-100/60',
};
STATUS_TONE.interrupted = STATUS_TONE.failed;

export function Status({ task }: { task: Task }) {
    return (
        <Badge
            variant="secondary"
            data-slot="task-status"
            data-status={task.status}
            className={cn(
                'gap-1.25 rounded-[5px] px-1.75 py-1 text-xs font-normal text-muted-foreground max-[700px]:px-1.25',
                STATUS_TONE[task.status],
            )}
        >
            <span className="size-1 rounded-full bg-current" />
            {statusLabel(task)}
        </Badge>
    );
}

export function TaskRow({ task, onClick }: { task: Task; onClick: () => void }) {
    return (
        <button
            data-slot="task-row"
            className="flex w-full items-center gap-3.25 rounded-[9px] border bg-card p-4.25 text-left transition-colors outline-none hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 max-[700px]:gap-2.25 max-[700px]:px-2.5 max-[700px]:py-3.25"
            onClick={onClick}
        >
            <span className="grid size-9.25 shrink-0 place-items-center rounded-[10px] border bg-slate-50 text-slate-400 max-[700px]:size-7.5 max-[700px]:rounded-lg dark:bg-muted dark:text-slate-400">
                {task.status === 'completed' ? (
                    <CheckCheck size={19} />
                ) : task.status === 'running' ? (
                    <LoaderCircle className="animate-spin" size={19} />
                ) : (
                    <MessageCircle size={19} />
                )}
            </span>
            <div className="min-w-0 flex-1">
                <strong className="block truncate text-xs leading-[normal] font-medium max-[700px]:text-[11px]">
                    {task.prompt}
                </strong>
                <span className="mt-1.5 block text-xs leading-[normal] text-muted-foreground">
                    {task.intervalSeconds
                        ? `Repeats every ${task.intervalSeconds < 3600 ? task.intervalSeconds / 60 + ' min' : task.intervalSeconds / 3600 + ' hr'} · `
                        : ''}
                    <LocalTime value={task.updatedAt} format={relative} />
                </span>
            </div>
            <Status task={task} />
            <ChevronRight size={16} className="shrink-0 text-muted-foreground/60 max-[700px]:hidden" />
        </button>
    );
}
