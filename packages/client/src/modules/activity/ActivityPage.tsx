import { Clock3, Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { Trans, useTranslation } from '@socio/i18n/react';
import { lowerText } from '@socio/shared/locale';
import { MODULE_IDS } from '@socio/shared/modules';
import type { Detail } from '@socio/shared/types';

import { api } from '../../lib/api';
import { useShell } from '../../shell/shell-context';
import { WorkspacePage } from '../../views/WorkspacePage';
import { Purpose } from '../schedules/Purpose';

import { TaskActions } from './TaskActions';
import { TaskRow } from './TaskPresentation';

import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

/** `/activity`: scheduled tasks and their runs, in the route's words (`activity`). */
export function ActivityPage() {
    const { t } = useTranslation(['activity']);
    const shell = useShell();
    const { state } = shell;
    const [search, setSearch] = useState('');
    const [detail, setDetail] = useState<Detail>();
    // Reloads the open task after a change, as the old App-level mutate did.
    const mutate = async (path: string, method: string, body?: unknown) => {
        const done = await shell.mutate(path, method, body);
        if (done && detail) {
            await api<Detail>(`/tasks/${detail.task.id}`)
                .then(setDetail)
                .catch((e) => shell.setError(e instanceof Error ? e.message : t('activity:save-failed')));
        }
        return done;
    };
    const tasks = state.tasks.filter((task) => lowerText(task.prompt).includes(lowerText(search)));
    return (
        <WorkspacePage
            slot="activity-page"
            module={MODULE_IDS.activity}
            title={t('activity:title')}
            description={t('activity:description')}
        >
            <div className="relative mb-5.5 max-w-95">
                <Search
                    size={16}
                    className="pointer-events-none absolute top-1/2 left-3.25 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                    aria-label={t('activity:search')}
                    placeholder={t('activity:search-placeholder')}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-10 rounded-[9px] bg-card pl-9.5 shadow-none md:text-xs dark:bg-card"
                />
            </div>
            <div data-slot="task-list" className="flex flex-col gap-2">
                {tasks.map((task) => (
                    <TaskRow
                        key={task.id}
                        task={task}
                        onClick={() =>
                            void api<Detail>(`/tasks/${task.id}`)
                                .then(setDetail)
                                .catch((e) => shell.setError(e.message))
                        }
                    />
                ))}
            </div>
            {!state.tasks.length && (
                <div data-slot="activity-empty" className="mx-auto my-15 max-w-110 text-center max-[700px]:mt-7.5">
                    <Clock3 size={32} className="mx-auto" />
                    <h2 className="mb-4.5 text-[22px] font-semibold tracking-tight">{t('activity:empty.title')}</h2>
                    <p className="text-xs leading-[1.9] text-muted-foreground">{t('activity:empty.description')}</p>
                </div>
            )}
            {detail && (
                <Card data-slot="task-detail" className="mt-5.5 gap-0 rounded-[10px] p-5.5 shadow-none">
                    <h2 className="mb-2 truncate text-base font-semibold tracking-tight">
                        {detail.task.title ?? detail.task.prompt.split('\n')[0]}
                    </h2>
                    <Purpose text={detail.task.prompt} />
                    <TaskActions
                        task={detail.task}
                        busy={shell.busy}
                        settings={state.settings}
                        onAction={(action) =>
                            void mutate(`/tasks/${detail.task.id}/actions`, 'POST', {
                                action,
                            })
                        }
                        onSchedule={async () => {
                            const raw = window.prompt(
                                t('activity:interval-prompt'),
                                String((detail.task.intervalSeconds ?? 0) / 60),
                            );
                            if (raw === null) {
                                return;
                            }
                            const value = Number(raw);
                            if (!Number.isFinite(value) || value < 0) {
                                shell.setError(t('activity:interval-invalid'));
                                return;
                            }
                            await mutate(`/tasks/${detail.task.id}/schedule`, 'PUT', {
                                intervalSeconds: value ? Math.round(value * 60) : null,
                            });
                        }}
                    />
                    {detail.task.error && (
                        <p className="mb-3 rounded-lg bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
                            {detail.task.error}
                        </p>
                    )}
                    {detail.events.slice(-6).map((event) => (
                        <p key={event.id} className="mb-3 text-xs leading-[1.7] text-muted-foreground">
                            {event.text}
                        </p>
                    ))}
                    <small className="text-xs text-muted-foreground">
                        <Trans
                            t={t}
                            i18nKey="activity:runs"
                            count={detail.runs.length}
                            components={{
                                details: (
                                    <Link
                                        className="underline underline-offset-2"
                                        to={`/schedules/${detail.task.id}`}
                                    />
                                ),
                            }}
                        />
                    </small>
                </Card>
            )}
        </WorkspacePage>
    );
}
