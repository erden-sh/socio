import { Trans, useTranslation } from '@socio/i18n/react';
import type { LongRunView } from '@socio/shared/schedule-types';

import { RunBadge, When } from './schedule-words';

import { Button } from '@/components/ui/button';

/** "412 of 726 done" and a bar: a long run's items at a glance (`schedules.list`). */
export function LongRunLine({ run }: { run: LongRunView }) {
    const { t } = useTranslation(['schedules.list']);
    const { done, total, failed } = run.items;
    const share = total ? Math.round(((done + failed) / total) * 100) : 0;
    return (
        <div className="grid gap-1" data-slot="long-run-line">
            <span className="whitespace-nowrap">
                <RunBadge status={run.status} />{' '}
                <span className="text-xs text-muted-foreground">
                    {total
                        ? t('schedules.list:long-run.done', {
                              done,
                              total,
                              failed,
                              context: failed ? 'failed' : undefined,
                          })
                        : t('schedules.list:long-run.empty')}
                </span>
            </span>
            {total > 0 && (
                <div
                    className="h-1.5 w-32 overflow-hidden rounded-full bg-muted"
                    role="meter"
                    aria-label={t('schedules.list:long-run.meter')}
                    aria-valuenow={share}
                    aria-valuemin={0}
                    aria-valuemax={100}
                >
                    <div className="h-full rounded-full bg-primary" style={{ width: `${share}%` }} />
                </div>
            )}
        </div>
    );
}

/** Which items line fits: with items in progress or not, the list complete or not. */
const itemsContext = (run: LongRunView) =>
    run.items.inProgress ? (run.listComplete ? 'working' : 'working-so-far') : run.listComplete ? undefined : 'so-far';

/**
 * A job that runs until done (CB-122), in its detail: where its long run
 * stands (items, batches, the last checkpoint, the retry or wait it is in),
 * the items set aside and, once it ended, the outcome. In the job's panel,
 * whose words (`schedules.job`) load on demand.
 */
export function LongRunProgress({ run, onStop }: { run: LongRunView; onStop?: () => void }) {
    const { t } = useTranslation(['schedules.job']);
    const open = run.status === 'running' || run.status === 'waiting';
    const { items } = run;
    const retried = run.deadLetters[0] && run.deadLetters[0].attempts > 1 ? 'retries' : undefined;
    return (
        <div className="grid gap-2" data-slot="job-progress">
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">{t('schedules.job:progress.title')}</h3>
                {open && onStop && (
                    <Button size="sm" variant="outline" onClick={onStop}>
                        {t('schedules.job:progress.stop')}
                    </Button>
                )}
            </div>
            <LongRunLine run={run} />
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">{t('schedules.job:progress.items')}</dt>
                <dd data-slot="job-progress-items">
                    {t('schedules.job:progress.items-line', {
                        done: items.done,
                        left: items.remaining,
                        working: items.inProgress,
                        failed: items.failed,
                        total: items.total,
                        context: itemsContext(run),
                    })}
                </dd>
                <dt className="text-muted-foreground">{t('schedules.job:progress.batches')}</dt>
                <dd>
                    <Trans
                        t={t}
                        i18nKey="schedules.job:progress.batches-line"
                        values={{ batches: run.batches, max: run.maxBatches }}
                        components={{ time: <When value={run.createdAt} /> }}
                    />
                </dd>
                <dt className="text-muted-foreground">{t('schedules.job:progress.checkpoint')}</dt>
                <dd>
                    {run.checkpointAt ? (
                        <>
                            <When value={run.checkpointAt} />
                            {run.checkpoint && (
                                <code className="ml-2 break-all text-xs text-muted-foreground">{run.checkpoint}</code>
                            )}
                        </>
                    ) : (
                        t('schedules.job:progress.none')
                    )}
                </dd>
                {open && (
                    <>
                        <dt className="text-muted-foreground">{t('schedules.job:progress.retries')}</dt>
                        <dd>
                            {t('schedules.job:progress.retries-line', { retries: run.retries, max: run.maxRetries })}
                        </dd>
                    </>
                )}
                {run.status === 'waiting' && run.nextAt && (
                    <>
                        <dt className="text-muted-foreground">{t('schedules.job:progress.next')}</dt>
                        <dd>
                            <When value={run.nextAt} />
                        </dd>
                    </>
                )}
                {open && run.waitReason && (
                    <>
                        <dt className="text-muted-foreground">{t('schedules.job:progress.waiting')}</dt>
                        <dd data-slot="job-progress-wait">{run.waitReason}</dd>
                    </>
                )}
                {run.lastError && (
                    <>
                        <dt className="text-muted-foreground">{t('schedules.job:progress.last-error')}</dt>
                        <dd className="text-destructive">{run.lastError}</dd>
                    </>
                )}
                {run.outcome && (
                    <>
                        <dt className="text-muted-foreground">{t('schedules.job:progress.outcome')}</dt>
                        <dd data-slot="job-progress-outcome">{run.outcome}</dd>
                    </>
                )}
            </dl>
            {run.deadLetters.length > 0 && (
                <div className="grid gap-1" data-slot="job-dead-letters">
                    <div className="text-xs text-muted-foreground">
                        {items.failed > run.deadLetters.length
                            ? t('schedules.job:progress.set-aside-latest', {
                                  shown: run.deadLetters.length,
                                  failed: items.failed,
                                  context: retried,
                              })
                            : t('schedules.job:progress.set-aside', { context: retried })}
                    </div>
                    <ul className="grid gap-0.5 text-xs">
                        {run.deadLetters.map((item) => (
                            <li key={item.key} className="flex gap-2">
                                <code className="shrink-0">{item.key}</code>
                                <span className="truncate text-muted-foreground">
                                    {t('schedules.job:progress.tries', {
                                        error: item.error ?? t('schedules.job:progress.item-failed'),
                                        count: item.attempts,
                                    })}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
