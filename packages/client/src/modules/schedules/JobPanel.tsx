import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import { jobEntryCommand } from '@socio/shared/job-entry';
import type { JobDetail, JobRunsPage, JobRunView } from '@socio/shared/schedule-types';

import { onDemand } from '../../i18n/on-demand';
import { api } from '../../lib/api';
import { formatDuration, formatSeconds } from '../runs/format';

import { LongRunProgress } from './LongRunProgress';
import { RunBadge, When } from './schedule-words';

import { ConfirmDelete } from '@/components/confirm-delete';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);

/**
 * A job's panel on the Jobs tab, opened by its Details button: its code's
 * state, its long run's progress, its versions and code, its runs and
 * logs, and Delete. Its words (`schedules.job`) load on demand when it
 * opens.
 */
function JobPanelView({
    jobId,
    refresh,
    onChanged,
    onDeleted,
}: {
    jobId: string;
    /** Reloads with the page's poll. */
    refresh: unknown;
    onChanged: () => void;
    onDeleted: () => void;
}) {
    const { t } = useTranslation(['schedules.job', 'schedules']);
    const [detail, setDetail] = useState<JobDetail>();
    const [run, setRun] = useState<JobRunView>();
    const [code, setCode] = useState<{
        version: number;
        files: Record<string, string>;
    }>();
    const [confirming, setConfirming] = useState(false);
    // Runs past the detail's latest, read with "Load more" (every run is kept).
    const [older, setOlder] = useState<JobRunsPage>({ runs: [], more: false });
    const loaded = useRef(0);
    useEffect(() => {
        loaded.current = 0;
        setOlder({ runs: [], more: false });
    }, [jobId]);
    useEffect(() => {
        let current = true;
        void (async () => {
            const next = await api<JobDetail>(`/schedules/jobs/${jobId}`);
            // A reload reads the older runs shown again, after the new latest.
            const last = next.runs.at(-1);
            const again =
                loaded.current && last && next.moreRuns
                    ? await api<JobRunsPage>(
                          `/schedules/jobs/${jobId}/runs?before=${encodeURIComponent(last.id)}&limit=${Math.min(loaded.current, 200)}`,
                      )
                    : undefined;
            if (!current) {
                return;
            }
            setDetail(next);
            if (loaded.current) {
                setOlder(again ?? { runs: [], more: false });
            }
        })().catch((e) => failed(e, t('schedules.job:load-failed')));
        return () => {
            current = false;
        };
    }, [jobId, refresh, t]);
    const runs = detail ? [...detail.runs, ...older.runs] : [];
    const moreRuns = older.runs.length ? older.more : !!detail?.moreRuns;
    const loadMore = () => {
        const last = runs.at(-1);
        if (!last) {
            return;
        }
        void api<JobRunsPage>(`/schedules/jobs/${jobId}/runs?before=${encodeURIComponent(last.id)}`)
            .then((page) => {
                setOlder((shown) => {
                    const runs = [...shown.runs, ...page.runs];
                    loaded.current = runs.length;
                    return { runs, more: page.more };
                });
            })
            .catch((e) => failed(e, t('schedules:actions.older-failed')));
    };
    const showRun = (id: string) =>
        void api<JobRunView>(`/schedules/runs/${id}`)
            .then(setRun)
            .catch((e) => failed(e, t('schedules.job:run-failed')));
    const showCode = (version: number) =>
        void api<{ version: number; files: Record<string, string> }>(`/schedules/jobs/${jobId}/code?version=${version}`)
            .then(setCode)
            .catch((e) => failed(e, t('schedules.job:code-failed')));
    const stop = async () => {
        try {
            await api(`/schedules/jobs/${jobId}/stop`, 'POST', {});
            toast.success(t('schedules.job:stopped', { name: detail?.job.name ?? '' }));
            onChanged();
        } catch (e) {
            failed(e, t('schedules.job:stop-failed'));
        }
    };
    const retry = async () => {
        try {
            await api(`/schedules/jobs/${jobId}/retry`, 'POST', {});
            toast.success(t('schedules.job:restored', { name: detail?.job.name ?? '' }));
            onChanged();
        } catch (e) {
            failed(e, t('schedules.job:restore-failed'));
        }
    };
    const remove = async () => {
        try {
            await api(`/schedules/jobs/${jobId}`, 'DELETE', {});
            toast.success(t('schedules.job:deleted', { name: detail?.job.name ?? '' }));
            setConfirming(false);
            onDeleted();
        } catch (e) {
            failed(e, t('schedules.job:delete-failed'));
        }
    };
    if (!detail) {
        return <Skeleton className="h-32" />;
    }
    const granted = detail.job.datasets.filter((id) => id !== 'scratch').length;
    return (
        <Card data-slot="job-detail">
            <CardHeader>
                <CardTitle>{detail.job.name}</CardTitle>
                <CardDescription>
                    {t('schedules.job:description', {
                        command: jobEntryCommand(detail.job.entry),
                        ...(granted ? { context: 'granted', count: granted } : {}),
                    })}
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
                {detail.code.state !== 'stored' && (
                    <div
                        className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 p-2 text-sm"
                        data-slot="job-code-missing"
                    >
                        <span>
                            {t('schedules.job:missing', {
                                version: detail.job.version,
                                files: detail.code.missing,
                                context: detail.code.missing.length ? 'files' : undefined,
                            })}
                        </span>
                        <Button size="sm" variant="outline" onClick={() => void retry()}>
                            {t('schedules.job:restore')}
                        </Button>
                    </div>
                )}
                {detail.longRun && <LongRunProgress run={detail.longRun} onStop={() => void stop()} />}
                <div className="grid gap-2">
                    <h3 className="text-sm font-medium">{t('schedules.job:versions')}</h3>
                    <ul className="grid gap-1 text-sm">
                        {detail.versions.map((version) => (
                            <li key={version.version} className="flex items-center gap-2">
                                <span>{t('schedules.job:version', { version: version.version })}</span>
                                <span className="text-muted-foreground">
                                    <When value={version.createdAt} />
                                    {' · '}
                                    {t('schedules.job:version-meta', {
                                        timeout: formatSeconds(version.timeoutSeconds),
                                        files: version.files.map((file) => file.path),
                                        context: version.untilDone ? 'until-done' : undefined,
                                    })}
                                </span>
                                <Button size="sm" variant="ghost" onClick={() => showCode(version.version)}>
                                    {t('schedules.job:code')}
                                </Button>
                            </li>
                        ))}
                    </ul>
                    {code && (
                        <div className="grid gap-2" data-slot="job-code">
                            {Object.entries(code.files).map(([path, contents]) => (
                                <div key={path}>
                                    <div className="text-xs text-muted-foreground">
                                        {t('schedules.job:code-file', { version: code.version, path })}
                                    </div>
                                    <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-2 text-xs">
                                        {contents}
                                    </pre>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                <div className="grid gap-2">
                    <h3 className="text-sm font-medium">{t('schedules.job:runs')}</h3>
                    {!detail.runs.length ? (
                        <p className="text-sm text-muted-foreground">{t('schedules:no-runs')}</p>
                    ) : (
                        <Table data-slot="job-runs">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('schedules.job:columns.started')}</TableHead>
                                    <TableHead>{t('schedules.job:columns.trigger')}</TableHead>
                                    <TableHead>{t('schedules.job:columns.status')}</TableHead>
                                    <TableHead>{t('schedules.job:columns.exit')}</TableHead>
                                    <TableHead>{t('schedules.job:columns.took')}</TableHead>
                                    <TableHead />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {runs.map((item) => (
                                    <TableRow key={item.id}>
                                        <TableCell className="whitespace-nowrap">
                                            <When value={item.startedAt ?? item.queuedAt} />
                                        </TableCell>
                                        <TableCell>
                                            {t(`schedules.job:trigger.${item.trigger}`, {
                                                version: item.version,
                                                context: item.longRunId ? 'batch' : undefined,
                                            })}
                                        </TableCell>
                                        <TableCell>
                                            <RunBadge status={item.status} />
                                        </TableCell>
                                        <TableCell>{item.exitCode ?? '—'}</TableCell>
                                        <TableCell className="whitespace-nowrap">
                                            {item.finishedAt && item.startedAt
                                                ? formatDuration(item.finishedAt - item.startedAt)
                                                : '—'}
                                            {item.wakeMs
                                                ? ` ${t('schedules.job:wake', { duration: formatDuration(item.wakeMs) })}`
                                                : ''}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <Button size="sm" variant="ghost" onClick={() => showRun(item.id)}>
                                                {t('schedules.job:logs')}
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                    {moreRuns && (
                        <Button variant="outline" size="sm" className="justify-self-center" onClick={loadMore}>
                            {t('schedules:actions.load-more')}
                        </Button>
                    )}
                    {run && (
                        <div className="grid gap-2" data-slot="job-logs">
                            <div className="text-sm">
                                {t('schedules.job:run')} <When value={run.startedAt ?? run.queuedAt} />
                                {': '}
                                <RunBadge status={run.status} />
                                {run.error ? ` ${run.error}` : ''}
                            </div>
                            {run.outputNotKept ? (
                                <p className="text-sm text-muted-foreground" data-slot="job-output-not-kept">
                                    {run.outputNotKept}
                                </p>
                            ) : (
                                <>
                                    <div className="text-xs text-muted-foreground">{t('schedules.job:stdout')}</div>
                                    <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-2 text-xs">
                                        {run.stdout || t('schedules.job:empty-output')}
                                    </pre>
                                    <div className="text-xs text-muted-foreground">{t('schedules.job:stderr')}</div>
                                    <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-2 text-xs">
                                        {run.stderr || t('schedules.job:empty-output')}
                                    </pre>
                                </>
                            )}
                        </div>
                    )}
                </div>
                <div>
                    <Button size="sm" variant="destructive" onClick={() => setConfirming(true)}>
                        {t('schedules.job:delete')}
                    </Button>
                </div>
                {confirming && (
                    <ConfirmDelete
                        title={t('schedules.job:confirm.title')}
                        slot="job-confirm-delete"
                        action={t('schedules.job:confirm.delete')}
                        onClose={() => setConfirming(false)}
                        onConfirm={remove}
                    >
                        {t('schedules.job:confirm.body', { name: detail.job.name })}
                    </ConfirmDelete>
                )}
            </CardContent>
        </Card>
    );
}

export const JobPanel = onDemand(['schedules.job', 'schedules'], JobPanelView);
