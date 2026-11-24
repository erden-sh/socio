import type { LongRunView } from '@socio/shared/schedule-types';

import { RunBadge, When } from './SchedulesPage';

import { Button } from '@/components/ui/button';

/** "412 of 726 done" and a bar: a long run's items at a glance. */
export function LongRunLine({ run }: { run: LongRunView }) {
    const { done, total, failed } = run.items;
    const share = total ? Math.round(((done + failed) / total) * 100) : 0;
    return (
        <div className="grid gap-1" data-slot="long-run-line">
            <span className="whitespace-nowrap">
                <RunBadge status={run.status} />{' '}
                <span className="text-xs text-muted-foreground">
                    {total ? `${done} of ${total} done${failed ? ` · ${failed} failed` : ''}` : 'No items yet'}
                </span>
            </span>
            {total > 0 && (
                <div
                    className="h-1.5 w-32 overflow-hidden rounded-full bg-muted"
                    role="meter"
                    aria-label="Items finished"
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

/**
 * A job that runs until done (CB-122), in its detail: where its long run
 * stands (items, batches, the last checkpoint, the retry or wait it is in),
 * the items set aside and, once it ended, the outcome.
 */
export function LongRunProgress({ run, onStop }: { run: LongRunView; onStop?: () => void }) {
    const open = run.status === 'running' || run.status === 'waiting';
    const { items } = run;
    return (
        <div className="grid gap-2" data-slot="job-progress">
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Progress</h3>
                {open && onStop && (
                    <Button size="sm" variant="outline" onClick={onStop}>
                        Stop
                    </Button>
                )}
            </div>
            <LongRunLine run={run} />
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Items</dt>
                <dd data-slot="job-progress-items">
                    {items.done} done · {items.remaining} left
                    {items.inProgress ? ` (${items.inProgress} in progress)` : ''} · {items.failed} failed ·{' '}
                    {items.total} in all
                    {run.listComplete ? '' : ' so far'}
                </dd>
                <dt className="text-muted-foreground">Batches</dt>
                <dd>
                    {run.batches} of at most {run.maxBatches} · started <When value={run.createdAt} />
                </dd>
                <dt className="text-muted-foreground">Last checkpoint</dt>
                <dd>
                    {run.checkpointAt ? (
                        <>
                            <When value={run.checkpointAt} />
                            {run.checkpoint && (
                                <code className="ml-2 break-all text-xs text-muted-foreground">{run.checkpoint}</code>
                            )}
                        </>
                    ) : (
                        'None'
                    )}
                </dd>
                {open && (
                    <>
                        <dt className="text-muted-foreground">Retries in a row</dt>
                        <dd>
                            {run.retries} of {run.maxRetries}
                        </dd>
                    </>
                )}
                {run.status === 'waiting' && run.nextAt && (
                    <>
                        <dt className="text-muted-foreground">Next batch</dt>
                        <dd>
                            <When value={run.nextAt} />
                        </dd>
                    </>
                )}
                {open && run.waitReason && (
                    <>
                        <dt className="text-muted-foreground">Waiting</dt>
                        <dd data-slot="job-progress-wait">{run.waitReason}</dd>
                    </>
                )}
                {run.lastError && (
                    <>
                        <dt className="text-muted-foreground">Last error</dt>
                        <dd className="text-destructive">{run.lastError}</dd>
                    </>
                )}
                {run.outcome && (
                    <>
                        <dt className="text-muted-foreground">Outcome</dt>
                        <dd data-slot="job-progress-outcome">{run.outcome}</dd>
                    </>
                )}
            </dl>
            {run.deadLetters.length > 0 && (
                <div className="grid gap-1" data-slot="job-dead-letters">
                    <div className="text-xs text-muted-foreground">
                        Set aside after {run.deadLetters[0].attempts > 1 ? 'retries' : 'a try'}
                        {items.failed > run.deadLetters.length
                            ? ` (latest ${run.deadLetters.length} of ${items.failed})`
                            : ''}
                    </div>
                    <ul className="grid gap-0.5 text-xs">
                        {run.deadLetters.map((item) => (
                            <li key={item.key} className="flex gap-2">
                                <code className="shrink-0">{item.key}</code>
                                <span className="truncate text-muted-foreground">
                                    {item.error ?? 'Failed.'} · {item.attempts} {item.attempts === 1 ? 'try' : 'tries'}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
