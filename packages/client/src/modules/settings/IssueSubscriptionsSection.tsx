import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';

import { STATUS_LABEL } from '@socio/shared/issues/issue-board';
import type { IssueWatchList, IssueWatchView } from '@socio/shared/issues/issue-subscriptions';
import { ISSUE_STATUSES, type IssueStatus } from '@socio/shared/issues/issue-types';

import { api } from '../../lib/api';

import { SettingsCard } from './AccountSettings';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** Explicit, owner-managed one-shot subscriptions; creating one never sends a historical notice. */
export function IssueSubscriptionsSection() {
    const [answer, setAnswer] = useState<IssueWatchList>();
    const [keys, setKeys] = useState('');
    const [status, setStatus] = useState<IssueStatus>('done');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [note, setNote] = useState('');
    const load = useCallback(async () => {
        setAnswer(await api<IssueWatchList>('/issues/subscriptions'));
    }, []);
    useEffect(() => {
        void load().catch((e) => setError(e instanceof Error ? e.message : 'Could not load subscriptions.'));
    }, [load]);
    const create = async () => {
        setBusy(true);
        setError('');
        setNote('');
        try {
            const issues = keys.split(/[\s,]+/).filter(Boolean);
            const result = await api<{ alreadyMatched: boolean; outcome: string }>('/issues/subscriptions', 'POST', {
                issues,
                targetStatus: status,
            });
            setNote(
                result.alreadyMatched
                    ? 'These issues already match. No historical notice was sent; this waits for a later transition.'
                    : result.outcome === 'already_watching'
                      ? 'You already have this subscription.'
                      : 'Subscribed. You will be notified once when all these issues match.',
            );
            setKeys('');
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not subscribe.');
        } finally {
            setBusy(false);
        }
    };
    const cancel = async (id: string) => {
        setBusy(true);
        setError('');
        try {
            await api('/issues/subscriptions/' + encodeURIComponent(id), 'DELETE');
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not unsubscribe.');
        } finally {
            setBusy(false);
        }
    };
    const more = async () => {
        if (answer?.next == null) {
            return;
        }
        setBusy(true);
        try {
            const next = await api<IssueWatchList>('/issues/subscriptions?offset=' + answer.next);
            setAnswer({ items: [...answer.items, ...next.items], next: next.next });
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not load more.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <SettingsCard>
            <section className="grid gap-3" data-slot="issue-subscriptions">
                <h3 className="font-medium">Issue subscriptions</h3>
                <p className="text-muted-foreground">
                    Get one notice when all chosen issues reach a status after a future change. Existing matches are not
                    announced. Device delivery uses your notification channels above; a notice also appears in Socio.
                </p>
                <form
                    className="grid gap-2"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void create();
                    }}
                >
                    <label className="grid gap-1">
                        Issue keys
                        <Input
                            aria-label="Subscribed issue keys"
                            value={keys}
                            onChange={(e) => setKeys(e.target.value)}
                            placeholder="CB-12, CB-34"
                            disabled={busy}
                            maxLength={300}
                        />
                    </label>
                    <label className="grid gap-1">
                        When all reach
                        <select
                            aria-label="Subscription target status"
                            value={status}
                            onChange={(e) => setStatus(e.target.value as IssueStatus)}
                            disabled={busy}
                            className="rounded-md border bg-background p-2"
                        >
                            {ISSUE_STATUSES.map((s) => (
                                <option key={s} value={s}>
                                    {STATUS_LABEL[s]}
                                </option>
                            ))}
                        </select>
                    </label>
                    <div>
                        <Button type="submit" disabled={busy || !keys.trim()}>
                            Subscribe once
                        </Button>
                    </div>
                </form>
                {note && <p role="status">{note}</p>}
                {error && (
                    <p role="alert" className="text-destructive">
                        {error}
                    </p>
                )}
                {answer && (
                    <ul className="grid gap-3">
                        {answer.items.map((watch) => (
                            <Watch key={watch.id} watch={watch} busy={busy} cancel={() => void cancel(watch.id)} />
                        ))}
                    </ul>
                )}
                {answer?.items.length === 0 && <p className="text-muted-foreground">No issue subscriptions.</p>}
                {answer?.next != null && (
                    <div>
                        <Button variant="outline" disabled={busy} onClick={() => void more()}>
                            Load more subscriptions
                        </Button>
                    </div>
                )}
            </section>
        </SettingsCard>
    );
}
function Watch({ watch, busy, cancel }: { watch: IssueWatchView; busy: boolean; cancel: () => void }) {
    return (
        <li className="flex flex-wrap items-center gap-2 rounded-md border p-2">
            <div className="min-w-0 flex-1">
                <p>
                    {watch.issues.map((key, index) => (
                        <span key={key}>
                            {index ? ', ' : ''}
                            <Link to={'/issues/' + key} className="underline">
                                {key}
                            </Link>
                        </span>
                    ))}{' '}
                    → {STATUS_LABEL[watch.targetStatus]}
                </p>
                <p className="text-muted-foreground">
                    {watch.state === 'triggered'
                        ? 'Matched; notification recorded'
                        : watch.state === 'cancelled'
                          ? 'Canceled'
                          : watch.state === 'ready'
                            ? 'Matched; notice pending'
                            : 'Watching future changes'}
                </p>
            </div>
            {['watching', 'ready'].includes(watch.state) && (
                <Button
                    variant="outline"
                    disabled={busy}
                    onClick={cancel}
                    aria-label={'Unsubscribe ' + watch.issues.join(', ')}
                >
                    Unsubscribe
                </Button>
            )}
        </li>
    );
}
