import { useState } from 'react';
import { Link } from 'react-router';

import { Trans, useTranslation } from '@socio/i18n/react';
import { formatNumber } from '@socio/shared/locale';
import {
    OPS_OUTCOMES,
    OPS_VALUE_TILES,
    type OpsOutcome,
    type OpsSessionRow,
    type OpsSocioRow,
    type OpsValue,
} from '@socio/shared/operations/operations-activity';

import { SeriesChart } from '../../components/charts/SeriesChart';
import { InfiniteList } from '../../components/infinite-list/InfiniteList';
import { useCursorList } from '../../components/infinite-list/use-cursor-list';

import {
    BreakdownRow,
    counts,
    filterLink,
    formatShare,
    RowLink,
    StatusNote,
    Tiles,
    useActivityWords,
} from './activity-parts';
import { formatWhen, useOpsFormat } from './format';
import { IntentTable, OUTCOME_MARK } from './outcome-parts';
import { opsPath } from './sections';
import { transcriptPath } from './transcript-path';
import { useOpsAnswer, useOpsQuery, useOpsSettings } from './use-ops';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

/**
 * Value (CB-190): which work gets finished, which is left, and what
 * people come back for. Sessions' outcomes by the design's definitions
 * (completed needs an outcome signal; answered is its own band, not
 * success), chats resumed, the approvals funnel and how many answers get
 * a reaction; then socios' usefulness and the sessions themselves.
 */
export function ValueSection() {
    const { t } = useTranslation(['operations.value', 'operations', 'operations.dashboard']);
    const { bucketLabel } = useOpsFormat();
    const { previousLabel } = useActivityWords();
    const { query, search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const [metric, setMetric] = useState<OpsOutcome>('completed');
    const answer = useOpsAnswer<OpsValue>(`/operations/value${search}`);
    const data = answer.data;
    const total = data
        ? OPS_OUTCOMES.reduce((sum, id) => sum + (data.tiles.find((tile) => tile.id === id)?.value ?? 0), 0)
        : 0;
    const reactions = data?.reactions;
    const labels = Object.fromEntries(OPS_VALUE_TILES.map((id) => [id, t(`operations.value:tiles.${id}`)])) as Record<
        (typeof OPS_VALUE_TILES)[number],
        string
    >;
    return (
        <>
            <StatusNote answer={data} timeZone={timeZone} error={answer.error} />
            <Tiles
                tiles={data?.tiles}
                labels={labels}
                against={previousLabel(query)}
                // Answered is a band of its own, neither success nor failure.
                upIsGood={(id) => (id === 'answered' ? undefined : id !== 'abandoned')}
                loading={answer.loading}
                count={5}
            />
            <Card data-slot="ops-outcomes" className="gap-4">
                <CardHeader>
                    <CardTitle>{t('operations.value:outcomes.title')}</CardTitle>
                    <CardDescription>{t('operations.value:outcomes.description')}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3">
                    {data ? (
                        <>
                            <div
                                role="img"
                                aria-label={OPS_OUTCOMES.map((id) =>
                                    t('operations.dashboard:outcomes.share', {
                                        outcome: t(`operations.dashboard:outcomes.${id}`),
                                        share: formatShare(
                                            total
                                                ? (data.tiles.find((tile) => tile.id === id)?.value ?? 0) / total
                                                : null,
                                        ),
                                    }),
                                ).join(', ')}
                                className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-muted"
                            >
                                {total > 0 &&
                                    OPS_OUTCOMES.map((id) => {
                                        const value = data.tiles.find((tile) => tile.id === id)?.value ?? 0;
                                        return value ? (
                                            <span
                                                key={id}
                                                className={cn('h-full', OUTCOME_MARK[id])}
                                                style={{ width: `${(value / total) * 100}%` }}
                                            />
                                        ) : null;
                                    })}
                            </div>
                            <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-muted-foreground">
                                {OPS_OUTCOMES.map((id) => {
                                    const value = data.tiles.find((tile) => tile.id === id)?.value ?? 0;
                                    return (
                                        <li key={id} className="flex items-center gap-1.5">
                                            <span aria-hidden className={cn('size-2 rounded-full', OUTCOME_MARK[id])} />
                                            {t('operations.value:outcomes.legend', {
                                                outcome: t(`operations.dashboard:outcomes.${id}`),
                                                n: value,
                                                share: formatShare(total ? value / total : null),
                                            })}
                                        </li>
                                    );
                                })}
                            </ul>
                        </>
                    ) : (
                        <Skeleton className="h-8 w-full" />
                    )}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                        <span className="text-sm font-medium">
                            {t('operations.value:chart.title', { context: metric })}
                        </span>
                        <Select value={metric} onValueChange={(value) => setMetric(value as OpsOutcome)}>
                            <SelectTrigger size="sm" aria-label={t('operations.value:chart.label')} className="w-40">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {OPS_OUTCOMES.map((id) => (
                                    <SelectItem key={id} value={id}>
                                        {t(`operations.dashboard:outcomes.${id}`)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    {data && data.points.length ? (
                        <SeriesChart
                            kind={data.window.bucket === 'hour' ? 'line' : 'bar'}
                            label={t('operations.value:chart.series', { context: metric })}
                            xName={data.window.bucket}
                            yName={t('operations.value:chart.axis')}
                            points={data.points.map((point) => ({
                                label: bucketLabel(point.at, data.window.bucket, data.window.timeZone),
                                value: point[metric],
                            }))}
                        />
                    ) : data ? (
                        <p className="m-0 py-6 text-center text-sm text-muted-foreground">
                            {t('operations.value:chart.empty')}
                        </p>
                    ) : (
                        <Skeleton className="h-60 w-full" />
                    )}
                </CardContent>
            </Card>
            <Card data-slot="ops-value-intents" className="gap-4">
                <CardHeader>
                    <CardTitle>{t('operations.value:intents.title')}</CardTitle>
                    <CardDescription>
                        <Trans
                            t={t}
                            i18nKey="operations.value:intents.description"
                            components={{ link: <Link to={opsPath('themes', search)} className="underline" /> }}
                        />
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {data?.intents.length ? (
                        <IntentTable rows={data.intents} slot="ops-value-intent-table" />
                    ) : data ? (
                        <p className="m-0 py-2 text-sm text-muted-foreground">{t('operations.value:intents.empty')}</p>
                    ) : (
                        <Skeleton className="h-24 w-full" />
                    )}
                </CardContent>
            </Card>
            <div className="grid gap-6 lg:grid-cols-2">
                <Card data-slot="ops-approvals" className="gap-3">
                    <CardHeader>
                        <CardTitle>{t('operations.value:approvals.title')}</CardTitle>
                        <CardDescription>{t('operations.value:approvals.description')}</CardDescription>
                    </CardHeader>
                    <CardContent>
                        {data?.approvals.length ? (
                            <ul className="m-0 grid list-none divide-y p-0">
                                {data.approvals.map((row) => (
                                    <li key={row.capability}>
                                        <BreakdownRow
                                            slot="ops-approval"
                                            name={row.capability}
                                            numbers={t('operations.value:approvals.row', {
                                                context: row.failed ? 'failed' : undefined,
                                                asked: row.requested,
                                                allowed: row.approved,
                                                denied: row.denied,
                                                expired: row.expired,
                                                done: row.executed,
                                                failed: row.failed,
                                            })}
                                        />
                                    </li>
                                ))}
                            </ul>
                        ) : data ? (
                            <p className="m-0 py-2 text-sm text-muted-foreground">
                                {t('operations.value:approvals.empty')}
                            </p>
                        ) : (
                            <Skeleton className="h-24 w-full" />
                        )}
                    </CardContent>
                </Card>
                <Card data-slot="ops-reactions" className="gap-3">
                    <CardHeader>
                        <CardTitle>{t('operations.value:reactions.title')}</CardTitle>
                        <CardDescription>{t('operations.value:reactions.description')}</CardDescription>
                    </CardHeader>
                    <CardContent>
                        {reactions ? (
                            <dl className="m-0 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                                {(
                                    [
                                        [
                                            'reacted',
                                            t('operations.value:reactions.reacted-value', {
                                                reacted: reactions.reacted,
                                                total: reactions.socioMessages,
                                                share: formatShare(
                                                    reactions.socioMessages
                                                        ? reactions.reacted / reactions.socioMessages
                                                        : null,
                                                ),
                                            }),
                                        ],
                                        ['up', formatNumber(reactions.up)],
                                        ['down', formatNumber(reactions.down)],
                                        ['retry', formatNumber(reactions.retry)],
                                        ['needs-work', formatNumber(reactions.needsWork)],
                                    ] as const
                                ).map(([id, value]) => (
                                    <div key={id} className="grid gap-0.5">
                                        <dt className="text-xs text-muted-foreground">
                                            {t(`operations.value:reactions.${id}`)}
                                        </dt>
                                        <dd className="m-0 font-semibold tabular-nums">{value}</dd>
                                    </div>
                                ))}
                            </dl>
                        ) : (
                            <Skeleton className="h-24 w-full" />
                        )}
                    </CardContent>
                </Card>
            </div>
            <ValueLists />
        </>
    );
}

function ValueLists() {
    const { t } = useTranslation(['operations.value']);
    const [tab, setTab] = useState('socios');
    return (
        <Card data-slot="ops-value-lists" className="gap-4">
            <CardHeader>
                <CardTitle>{t('operations.value:lists.title')}</CardTitle>
                <CardDescription>{t('operations.value:lists.description')}</CardDescription>
            </CardHeader>
            <CardContent>
                <Tabs value={tab} onValueChange={setTab}>
                    <TabsList>
                        <TabsTrigger value="socios">{t('operations.value:lists.socios')}</TabsTrigger>
                        <TabsTrigger value="sessions">{t('operations.value:lists.sessions')}</TabsTrigger>
                    </TabsList>
                    <TabsContent value="socios">
                        <UsefulnessList />
                    </TabsContent>
                    <TabsContent value="sessions">
                        <SessionsList />
                    </TabsContent>
                </Tabs>
            </CardContent>
        </Card>
    );
}

function UsefulnessList() {
    const { t } = useTranslation(['operations.value']);
    const { query, search } = useOpsQuery();
    const list = useCursorList<OpsSocioRow>(`/operations/activity/socios${search}`);
    return (
        <InfiniteList
            list={list}
            label={t('operations.value:lists.socios')}
            itemKey={(row) => row.socioId}
            empty={t('operations.value:lists.socios-empty')}
            renderItem={(row) => (
                <BreakdownRow
                    slot="ops-usefulness"
                    name={
                        <RowLink to={filterLink('value', query, { socio: row.socioId })}>
                            {row.name ?? row.socioId}
                        </RowLink>
                    }
                    numbers={counts(
                        t('operations.value:usefulness.completed', {
                            count: row.sessions,
                            share: formatShare(row.sessions ? row.completed / row.sessions : null),
                        }),
                        t('operations.value:usefulness.back', { share: formatShare(row.returnRate) }),
                        t('operations.value:usefulness.repeat', { share: formatShare(row.repeatUse) }),
                    )}
                />
            )}
        />
    );
}

function SessionsList() {
    const { t } = useTranslation(['operations.value', 'operations', 'operations.dashboard']);
    const { search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const [outcome, setOutcome] = useState<OpsOutcome | 'all'>('all');
    const path = `/operations/value/sessions${search}${
        outcome === 'all' ? '' : `${search ? '&' : '?'}outcome=${outcome}`
    }`;
    const list = useCursorList<OpsSessionRow>(path);
    return (
        <div className="grid gap-3">
            <Select value={outcome} onValueChange={(value) => setOutcome(value as OpsOutcome | 'all')}>
                <SelectTrigger size="sm" aria-label={t('operations.value:sessions.outcome')} className="w-40">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="all">{t('operations.value:sessions.every-outcome')}</SelectItem>
                    {OPS_OUTCOMES.map((id) => (
                        <SelectItem key={id} value={id}>
                            {t(`operations.dashboard:outcomes.${id}`)}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <InfiniteList
                list={list}
                label={t('operations.value:lists.sessions')}
                itemKey={(row) => row.id}
                empty={t('operations.value:sessions.empty')}
                renderItem={(row) => (
                    <BreakdownRow
                        slot="ops-session"
                        name={
                            <RowLink to={transcriptPath(row.threadId, 'value')}>
                                {row.socioName ?? row.socioId ?? t('operations.value:sessions.a-chat')}
                            </RowLink>
                        }
                        meta={
                            <Badge
                                variant={
                                    row.outcome === 'abandoned'
                                        ? 'destructive'
                                        : row.outcome === 'completed'
                                          ? 'default'
                                          : 'secondary'
                                }
                            >
                                {t(`operations.dashboard:outcomes.${row.outcome}`)}
                            </Badge>
                        }
                        numbers={counts(
                            t('operations.value:sessions.messages', { count: row.messages }),
                            t('operations.value:sessions.people', { count: row.people }),
                            row.source,
                            formatWhen(row.startedAt, timeZone),
                        )}
                    />
                )}
            />
        </div>
    );
}
