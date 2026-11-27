import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';

import { useTranslation } from '@socio/i18n/react';
import { STATUS_LABEL } from '@socio/shared/issues/issue-board';
import type { IssueWatchList, IssueWatchView } from '@socio/shared/issues/issue-subscriptions';
import { ISSUE_STATUSES, type IssueStatus } from '@socio/shared/issues/issue-types';

import { api } from '../../lib/api';

import { SettingsCard } from './AccountSettings';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const STATE_KEYS = {
    watching: 'settings.notifications:issues.states.watching',
    ready: 'settings.notifications:issues.states.ready',
    triggered: 'settings.notifications:issues.states.triggered',
    cancelled: 'settings.notifications:issues.states.cancelled',
} as const satisfies Record<IssueWatchView['state'], string>;

/** Explicit, owner-managed one-shot subscriptions; creating one never sends a historical notice. */
export function IssueSubscriptionsSection() {
    const { t } = useTranslation(['settings.notifications']);
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
        void load().catch((e) =>
            setError(e instanceof Error ? e.message : t('settings.notifications:issues.loadFailed')),
        );
    }, [load, t]);
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
                    ? t('settings.notifications:issues.alreadyMatched')
                    : result.outcome === 'already_watching'
                      ? t('settings.notifications:issues.alreadyWatching')
                      : t('settings.notifications:issues.subscribed'),
            );
            setKeys('');
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : t('settings.notifications:issues.subscribeFailed'));
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
            setError(e instanceof Error ? e.message : t('settings.notifications:issues.unsubscribeFailed'));
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
            setError(e instanceof Error ? e.message : t('settings.notifications:issues.moreFailed'));
        } finally {
            setBusy(false);
        }
    };
    return (
        <SettingsCard>
            <section className="grid gap-3" data-slot="issue-subscriptions">
                <h3 className="font-medium">{t('settings.notifications:issues.title')}</h3>
                <p className="text-muted-foreground">{t('settings.notifications:issues.intro')}</p>
                <form
                    className="grid gap-2"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void create();
                    }}
                >
                    <label className="grid gap-1">
                        {t('settings.notifications:issues.keys')}
                        <Input
                            aria-label={t('settings.notifications:issues.keysLabel')}
                            value={keys}
                            onChange={(e) => setKeys(e.target.value)}
                            // oxlint-disable-next-line socio/no-literal-text -- sample issue keys, not copy
                            placeholder="CB-12, CB-34"
                            disabled={busy}
                            maxLength={300}
                        />
                    </label>
                    <label className="grid gap-1">
                        {t('settings.notifications:issues.status')}
                        <select
                            aria-label={t('settings.notifications:issues.statusLabel')}
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
                            {t('settings.notifications:issues.subscribe')}
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
                {answer?.items.length === 0 && (
                    <p className="text-muted-foreground">{t('settings.notifications:issues.empty')}</p>
                )}
                {answer?.next != null && (
                    <div>
                        <Button variant="outline" disabled={busy} onClick={() => void more()}>
                            {t('settings.notifications:issues.more')}
                        </Button>
                    </div>
                )}
            </section>
        </SettingsCard>
    );
}
function Watch({ watch, busy, cancel }: { watch: IssueWatchView; busy: boolean; cancel: () => void }) {
    const { t } = useTranslation(['settings.notifications']);
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
                    {t('settings.notifications:issues.target', { status: STATUS_LABEL[watch.targetStatus] })}
                </p>
                <p className="text-muted-foreground">{t(STATE_KEYS[watch.state])}</p>
            </div>
            {['watching', 'ready'].includes(watch.state) && (
                <Button
                    variant="outline"
                    disabled={busy}
                    onClick={cancel}
                    aria-label={t('settings.notifications:issues.unsubscribeLabel', {
                        issues: watch.issues.join(', '),
                    })}
                >
                    {t('settings.notifications:issues.unsubscribe')}
                </Button>
            )}
        </li>
    );
}
