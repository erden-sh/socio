import { useState } from 'react';
import { Link } from 'react-router';

import { formatNumber } from '@socio/shared/locale';
import {
    OPS_OUTCOME_LABELS,
    OPS_OUTCOMES,
    OPS_VALUE_TILE_LABELS,
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
    previousLabel,
    RowLink,
    StatusNote,
    Tiles,
} from './activity-parts';
import { bucketLabel, formatWhen } from './format';
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
    const { query, search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const [metric, setMetric] = useState<OpsOutcome>('completed');
    const answer = useOpsAnswer<OpsValue>(`/operations/value${search}`);
    const data = answer.data;
    const total = data
        ? OPS_OUTCOMES.reduce((sum, id) => sum + (data.tiles.find((tile) => tile.id === id)?.value ?? 0), 0)
        : 0;
    const reactions = data?.reactions;
    return (
        <>
            <StatusNote answer={data} timeZone={timeZone} error={answer.error} />
            <Tiles
                tiles={data?.tiles}
                labels={OPS_VALUE_TILE_LABELS}
                against={previousLabel(query)}
                // Answered is a band of its own, neither success nor failure.
                upIsGood={(id) => (id === 'answered' ? undefined : id !== 'abandoned')}
                loading={answer.loading}
                count={5}
            />
            <Card data-slot="ops-outcomes" className="gap-4">
                <CardHeader>
                    <CardTitle>How people’s sessions ended</CardTitle>
                    <CardDescription>
                        Completed: the last turn finished and something came of it within a day (a thumbs up, an
                        approval carried out, a page the socio wrote, a memory kept). Abandoned: nobody came back within
                        a day after a failure, a stop, an expired approval or a thumbs down. Answered: the rest.
                    </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3">
                    {data ? (
                        <>
                            <div
                                role="img"
                                aria-label={OPS_OUTCOMES.map(
                                    (id) =>
                                        `${OPS_OUTCOME_LABELS[id]} ${formatShare(
                                            total
                                                ? (data.tiles.find((tile) => tile.id === id)?.value ?? 0) / total
                                                : null,
                                        )}`,
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
                                            {OPS_OUTCOME_LABELS[id]}: {formatNumber(value)} (
                                            {formatShare(total ? value / total : null)})
                                        </li>
                                    );
                                })}
                            </ul>
                        </>
                    ) : (
                        <Skeleton className="h-8 w-full" />
                    )}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                        <span className="text-sm font-medium">{OPS_OUTCOME_LABELS[metric]} sessions over time</span>
                        <Select value={metric} onValueChange={(value) => setMetric(value as OpsOutcome)}>
                            <SelectTrigger size="sm" aria-label="Chart" className="w-40">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {OPS_OUTCOMES.map((id) => (
                                    <SelectItem key={id} value={id}>
                                        {OPS_OUTCOME_LABELS[id]}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    {data && data.points.length ? (
                        <SeriesChart
                            kind={data.window.bucket === 'hour' ? 'line' : 'bar'}
                            label={`${OPS_OUTCOME_LABELS[metric]} sessions`}
                            xName={data.window.bucket}
                            yName="sessions"
                            points={data.points.map((point) => ({
                                label: bucketLabel(point.at, data.window.bucket, data.window.timeZone),
                                value: point[metric],
                            }))}
                        />
                    ) : data ? (
                        <p className="m-0 py-6 text-center text-sm text-muted-foreground">
                            Nothing to chart in this range.
                        </p>
                    ) : (
                        <Skeleton className="h-60 w-full" />
                    )}
                </CardContent>
            </Card>
            <Card data-slot="ops-value-intents" className="gap-4">
                <CardHeader>
                    <CardTitle>Completion by intent</CardTitle>
                    <CardDescription>
                        How sessions ended by what people came for. Intents come from the session intent labels
                        (Operations → Settings); sessions without one are counted apart.{' '}
                        <Link to={opsPath('themes', search)} className="underline">
                            Themes
                        </Link>{' '}
                        breaks them down by topic.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {data?.intents.length ? (
                        <IntentTable rows={data.intents} slot="ops-value-intent-table" />
                    ) : data ? (
                        <p className="m-0 py-2 text-sm text-muted-foreground">No sessions in this range.</p>
                    ) : (
                        <Skeleton className="h-24 w-full" />
                    )}
                </CardContent>
            </Card>
            <div className="grid gap-6 lg:grid-cols-2">
                <Card data-slot="ops-approvals" className="gap-3">
                    <CardHeader>
                        <CardTitle>Approvals</CardTitle>
                        <CardDescription>
                            What socios asked to do, what people allowed, and what was carried out, by capability.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        {data?.approvals.length ? (
                            <ul className="m-0 grid list-none divide-y p-0">
                                {data.approvals.map((row) => (
                                    <li key={row.capability}>
                                        <BreakdownRow
                                            slot="ops-approval"
                                            name={row.capability}
                                            numbers={`${formatNumber(row.requested)} asked → ${formatNumber(row.approved)} allowed, ${formatNumber(row.denied)} denied, ${formatNumber(row.expired)} expired → ${formatNumber(row.executed)} done${row.failed ? `, ${formatNumber(row.failed)} failed` : ''}`}
                                        />
                                    </li>
                                ))}
                            </ul>
                        ) : data ? (
                            <p className="m-0 py-2 text-sm text-muted-foreground">No approvals in this range.</p>
                        ) : (
                            <Skeleton className="h-24 w-full" />
                        )}
                    </CardContent>
                </Card>
                <Card data-slot="ops-reactions" className="gap-3">
                    <CardHeader>
                        <CardTitle>Reactions</CardTitle>
                        <CardDescription>
                            How many socio answers got a reaction, and which. Few reactions say little either way.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        {reactions ? (
                            <dl className="m-0 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                                {(
                                    [
                                        [
                                            'Answers with a reaction',
                                            `${formatNumber(reactions.reacted)} of ${formatNumber(reactions.socioMessages)} (${formatShare(reactions.socioMessages ? reactions.reacted / reactions.socioMessages : null)})`,
                                        ],
                                        ['Thumbs up', formatNumber(reactions.up)],
                                        ['Thumbs down', formatNumber(reactions.down)],
                                        ['Retry', formatNumber(reactions.retry)],
                                        ['Needs work', formatNumber(reactions.needsWork)],
                                    ] as const
                                ).map(([label, value]) => (
                                    <div key={label} className="grid gap-0.5">
                                        <dt className="text-xs text-muted-foreground">{label}</dt>
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
    const [tab, setTab] = useState('socios');
    return (
        <Card data-slot="ops-value-lists" className="gap-4">
            <CardHeader>
                <CardTitle>Usefulness and sessions</CardTitle>
                <CardDescription>
                    Each socio’s completed share next to how often its people come back, and people’s sessions, newest
                    first.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <Tabs value={tab} onValueChange={setTab}>
                    <TabsList>
                        <TabsTrigger value="socios">Socios</TabsTrigger>
                        <TabsTrigger value="sessions">Sessions</TabsTrigger>
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
    const { query, search } = useOpsQuery();
    const list = useCursorList<OpsSocioRow>(`/operations/activity/socios${search}`);
    return (
        <InfiniteList
            list={list}
            label="Socios"
            itemKey={(row) => row.socioId}
            empty="No socio had people’s sessions in this range."
            renderItem={(row) => (
                <BreakdownRow
                    slot="ops-usefulness"
                    name={
                        <RowLink to={filterLink('value', query, { socio: row.socioId })}>
                            {row.name ?? row.socioId}
                        </RowLink>
                    }
                    numbers={`${formatShare(row.sessions ? row.completed / row.sessions : null)} completed of ${counts([row.sessions, 'session', 'sessions'])} · ${formatShare(row.returnRate)} back within 7 days · ${formatShare(row.repeatUse)} came on 2+ days of 28`}
                />
            )}
        />
    );
}

function SessionsList() {
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
                <SelectTrigger size="sm" aria-label="Outcome" className="w-40">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="all">Every outcome</SelectItem>
                    {OPS_OUTCOMES.map((id) => (
                        <SelectItem key={id} value={id}>
                            {OPS_OUTCOME_LABELS[id]}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <InfiniteList
                list={list}
                label="Sessions"
                itemKey={(row) => row.id}
                empty="No sessions like that in this range."
                renderItem={(row) => (
                    <BreakdownRow
                        slot="ops-session"
                        name={
                            <RowLink to={transcriptPath(row.threadId, 'value')}>
                                {row.socioName ?? row.socioId ?? 'A chat'}
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
                                {OPS_OUTCOME_LABELS[row.outcome]}
                            </Badge>
                        }
                        numbers={`${counts(
                            [row.messages, 'message', 'messages'],
                            [row.people, 'person', 'people'],
                        )} · ${row.source} · ${formatWhen(row.startedAt, timeZone)}`}
                    />
                )}
            />
        </div>
    );
}
