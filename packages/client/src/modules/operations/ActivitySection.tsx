import { useState } from 'react';

import { useTranslation } from '@socio/i18n/react';
import { formatNumber } from '@socio/shared/locale';
import {
    OPS_ACTIVITY_TILES,
    type OpsActivity,
    type OpsActivityPoint,
    type OpsChatRow,
    type OpsPersonRow,
    type OpsSocioRow,
} from '@socio/shared/operations/operations-activity';

import { SeriesChart } from '../../components/charts/SeriesChart';
import { InfiniteList } from '../../components/infinite-list/InfiniteList';
import { useCursorList } from '../../components/infinite-list/use-cursor-list';

import { BreakdownRow, counts, filterLink, RowLink, StatusNote, Tiles, useActivityWords } from './activity-parts';
import { formatWhen, useOpsFormat } from './format';
import { transcriptPath } from './transcript-path';
import { useOpsAnswer, useOpsQuery, useOpsSettings } from './use-ops';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type ChartMetric = keyof Omit<OpsActivityPoint, 'at'>;
/** The chart's metrics, in its menu's order; named by the `metrics.<id>` keys. */
const CHART: ChartMetric[] = ['people', 'sessions', 'messages'];

/**
 * Activity (CB-190): who works with which socios, how often and through
 * which channels. Tiles against the period before, a chart, sources
 * (people and automation apart, as the source registry says), who takes
 * part in chats, feature use by capability and Space use; then people,
 * socios and chats, last active first, loading more as they scroll. A
 * person's or socio's name narrows the whole page to them.
 */
export function ActivitySection() {
    const { t } = useTranslation(['operations.activity', 'operations']);
    const { bucketLabel } = useOpsFormat();
    const { previousLabel } = useActivityWords();
    const { query, search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const [metric, setMetric] = useState<ChartMetric>('people');
    const answer = useOpsAnswer<OpsActivity>(`/operations/activity${search}`);
    const data = answer.data;
    const metricLabel = t(`operations.activity:metrics.${metric}`);
    const labels = Object.fromEntries(
        OPS_ACTIVITY_TILES.map((id) => [id, t(`operations.activity:tiles.${id}`)]),
    ) as Record<(typeof OPS_ACTIVITY_TILES)[number], string>;
    return (
        <>
            <StatusNote answer={data} timeZone={timeZone} error={answer.error} />
            <Tiles
                tiles={data?.tiles}
                labels={labels}
                against={previousLabel(query)}
                loading={answer.loading}
                count={6}
            />
            {data && (
                <p className="m-0 text-xs text-muted-foreground">
                    {t('operations.activity:sessions-note', { minutes: data.sessionGapMinutes })}
                </p>
            )}
            <Card data-slot="ops-activity-chart" className="gap-4">
                <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle>{metricLabel}</CardTitle>
                    <Select value={metric} onValueChange={(value) => setMetric(value as ChartMetric)}>
                        <SelectTrigger size="sm" aria-label={t('operations.activity:chart')} className="w-52">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {CHART.map((id) => (
                                <SelectItem key={id} value={id}>
                                    {t(`operations.activity:metrics.${id}`)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </CardHeader>
                <CardContent>
                    {data && data.points.length ? (
                        <SeriesChart
                            kind={data.window.bucket === 'hour' ? 'line' : 'bar'}
                            label={metricLabel}
                            xName={data.window.bucket}
                            yName={t(`operations.activity:axis.${metric}`)}
                            points={data.points.map((point) => ({
                                label: bucketLabel(point.at, data.window.bucket, data.window.timeZone),
                                value: point[metric],
                            }))}
                        />
                    ) : data ? (
                        <p className="m-0 py-6 text-center text-sm text-muted-foreground">
                            {t('operations.activity:no-chart')}
                        </p>
                    ) : (
                        <Skeleton className="h-60 w-full" />
                    )}
                </CardContent>
            </Card>
            <div className="grid gap-6 lg:grid-cols-2">
                <Card data-slot="ops-sources" className="gap-3">
                    <CardHeader>
                        <CardTitle>{t('operations.activity:sources.title')}</CardTitle>
                        <CardDescription>{t('operations.activity:sources.description')}</CardDescription>
                    </CardHeader>
                    <CardContent>
                        {data?.sources.length ? (
                            <ul className="m-0 grid list-none divide-y p-0">
                                {data.sources.map((source) => (
                                    <li key={source.key}>
                                        <BreakdownRow
                                            slot="ops-source"
                                            name={
                                                <RowLink
                                                    to={filterLink('activity', query, {
                                                        source: source.key,
                                                    })}
                                                >
                                                    {source.label}
                                                </RowLink>
                                            }
                                            meta={
                                                <Badge variant={source.kind === 'human' ? 'secondary' : 'outline'}>
                                                    {t(`operations.activity:sources.kind.${source.kind}`)}
                                                </Badge>
                                            }
                                            numbers={counts(
                                                t('operations.activity:count.turns', { count: source.turns }),
                                                t('operations.activity:count.people', { count: source.people }),
                                            )}
                                        />
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <Empty loading={!data} />
                        )}
                    </CardContent>
                </Card>
                <Card data-slot="ops-participation" className="gap-3">
                    <CardHeader>
                        <CardTitle>{t('operations.activity:participation.title')}</CardTitle>
                        <CardDescription>{t('operations.activity:participation.description')}</CardDescription>
                    </CardHeader>
                    <CardContent>
                        {data ? (
                            <dl className="m-0 grid grid-cols-2 gap-3 text-sm">
                                {(
                                    [
                                        ['chats', data.participation.chats],
                                        ['several-people', data.participation.withSeveralPeople],
                                        ['several-socios', data.participation.withSeveralSocios],
                                        ['collaboration', data.participation.collaboration],
                                    ] as const
                                ).map(([id, value]) => (
                                    <div key={id} className="grid gap-0.5">
                                        <dt className="text-xs text-muted-foreground">
                                            {t(`operations.activity:participation.${id}`)}
                                        </dt>
                                        <dd className="m-0 text-lg font-semibold tabular-nums">
                                            {formatNumber(value)}
                                        </dd>
                                    </div>
                                ))}
                            </dl>
                        ) : (
                            <Empty loading />
                        )}
                    </CardContent>
                </Card>
                <Card data-slot="ops-features" className="gap-3">
                    <CardHeader>
                        <CardTitle>{t('operations.activity:features.title')}</CardTitle>
                        <CardDescription>
                            {query.filters.person
                                ? t('operations.activity:features.description_person')
                                : t('operations.activity:features.description')}
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        {data?.features.length ? (
                            <ul className="m-0 grid list-none divide-y p-0">
                                {data.features.map((feature) => (
                                    <li key={feature.id}>
                                        <BreakdownRow
                                            slot="ops-feature"
                                            name={<span title={feature.tools.join(', ')}>{feature.label}</span>}
                                            numbers={counts(
                                                t('operations.activity:count.calls', { count: feature.calls }),
                                                t('operations.activity:count.people', { count: feature.people }),
                                                ...(feature.errors || feature.refusals
                                                    ? [
                                                          t('operations.activity:count.errors', {
                                                              count: feature.errors,
                                                          }),
                                                          t('operations.activity:count.refusals', {
                                                              count: feature.refusals,
                                                          }),
                                                      ]
                                                    : []),
                                            )}
                                        />
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <Empty loading={!data} />
                        )}
                    </CardContent>
                </Card>
                <Card data-slot="ops-spaces" className="gap-3">
                    <CardHeader>
                        <CardTitle>{t('operations.activity:spaces.title')}</CardTitle>
                        <CardDescription>{t('operations.activity:spaces.description')}</CardDescription>
                    </CardHeader>
                    <CardContent>
                        {data?.spaces.length ? (
                            <ul className="m-0 grid list-none divide-y p-0">
                                {data.spaces.map((space) => (
                                    <li key={space.spaceId}>
                                        <BreakdownRow
                                            slot="ops-space"
                                            name={
                                                <RowLink
                                                    to={filterLink('activity', query, {
                                                        space: space.spaceId,
                                                    })}
                                                >
                                                    {space.name ?? space.spaceId}
                                                </RowLink>
                                            }
                                            numbers={counts(
                                                t('operations.activity:count.writes-by-people', {
                                                    count: space.writesByPeople,
                                                }),
                                                t('operations.activity:count.writes-by-socios', {
                                                    count: space.writesBySocios,
                                                }),
                                                t('operations.activity:count.people', { count: space.people }),
                                            )}
                                        />
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <Empty loading={!data} />
                        )}
                    </CardContent>
                </Card>
            </div>
            <Drilldowns />
        </>
    );
}

function Empty({ loading }: { loading: boolean }) {
    const { t } = useTranslation(['operations.activity']);
    return loading ? (
        <Skeleton className="h-24 w-full" />
    ) : (
        <p className="m-0 py-2 text-sm text-muted-foreground">{t('operations.activity:empty')}</p>
    );
}

/** People, socios and chats: cursor-paged, last active first. */
function Drilldowns() {
    const { t } = useTranslation(['operations.activity']);
    const [tab, setTab] = useState('people');
    return (
        <Card data-slot="ops-activity-lists" className="gap-4">
            <CardHeader>
                <CardTitle>{t('operations.activity:lists.title')}</CardTitle>
                <CardDescription>{t('operations.activity:lists.description')}</CardDescription>
            </CardHeader>
            <CardContent>
                <Tabs value={tab} onValueChange={setTab}>
                    <TabsList>
                        <TabsTrigger value="people">{t('operations.activity:lists.people')}</TabsTrigger>
                        <TabsTrigger value="socios">{t('operations.activity:lists.socios')}</TabsTrigger>
                        <TabsTrigger value="chats">{t('operations.activity:lists.chats')}</TabsTrigger>
                    </TabsList>
                    <TabsContent value="people">
                        <PeopleList />
                    </TabsContent>
                    <TabsContent value="socios">
                        <SociosList />
                    </TabsContent>
                    <TabsContent value="chats">
                        <ChatsList />
                    </TabsContent>
                </Tabs>
            </CardContent>
        </Card>
    );
}

function PeopleList() {
    const { t } = useTranslation(['operations.activity']);
    const { personLabel } = useActivityWords();
    const { query, search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const list = useCursorList<OpsPersonRow>(`/operations/activity/people${search}`);
    return (
        <InfiniteList
            list={list}
            label={t('operations.activity:lists.people')}
            itemKey={(row) => row.personId}
            empty={t('operations.activity:lists.people-empty')}
            renderItem={(row) => (
                <BreakdownRow
                    slot="ops-person"
                    name={
                        <RowLink to={filterLink('activity', query, { person: row.personId })}>
                            {personLabel(row.personId, row.name)}
                        </RowLink>
                    }
                    numbers={counts(
                        t('operations.activity:count.sessions', { count: row.sessions }),
                        t('operations.activity:count.messages', { count: row.messages }),
                        t('operations.activity:count.days', { count: row.activeDays }),
                        t('operations.activity:count.socios', { count: row.socios }),
                        t('operations.activity:count.tool-calls', { count: row.toolCalls }),
                        formatWhen(row.lastAt, timeZone),
                    )}
                />
            )}
        />
    );
}

function SociosList() {
    const { t } = useTranslation(['operations.activity']);
    const { query, search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const list = useCursorList<OpsSocioRow>(`/operations/activity/socios${search}`);
    return (
        <InfiniteList
            list={list}
            label={t('operations.activity:lists.socios')}
            itemKey={(row) => row.socioId}
            empty={t('operations.activity:lists.socios-empty')}
            renderItem={(row) => (
                <BreakdownRow
                    slot="ops-socio"
                    name={
                        <RowLink to={filterLink('activity', query, { socio: row.socioId })}>
                            {row.name ?? row.socioId}
                        </RowLink>
                    }
                    numbers={counts(
                        t('operations.activity:count.people', { count: row.people }),
                        t('operations.activity:count.sessions', { count: row.sessions }),
                        t('operations.activity:count.chats', { count: row.chats }),
                        t('operations.activity:count.per-chat', { n: row.perChat }),
                        ...(row.collaboration
                            ? [t('operations.activity:count.turns-for-socios', { count: row.collaboration })]
                            : []),
                        formatWhen(row.lastAt, timeZone),
                    )}
                />
            )}
        />
    );
}

function ChatsList() {
    const { t } = useTranslation(['operations.activity']);
    const { search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const list = useCursorList<OpsChatRow>(`/operations/activity/chats${search}`);
    return (
        <InfiniteList
            list={list}
            label={t('operations.activity:lists.chats')}
            itemKey={(row) => row.threadId}
            empty={t('operations.activity:lists.chats-empty')}
            renderItem={(row) => (
                <BreakdownRow
                    slot="ops-chat"
                    name={
                        <RowLink to={transcriptPath(row.threadId, 'activity')}>
                            {row.socioName ?? row.socioId ?? t('operations.activity:lists.a-chat')}
                        </RowLink>
                    }
                    meta={
                        <>
                            {row.ownerKind === 'team' && (
                                <Badge variant="outline">{t('operations.activity:lists.shared')}</Badge>
                            )}
                            {row.ownerKind === 'room' && (
                                <Badge variant="outline">{t('operations.activity:lists.room')}</Badge>
                            )}
                            {row.resumed && <Badge variant="secondary">{t('operations.activity:lists.resumed')}</Badge>}
                        </>
                    }
                    numbers={counts(
                        t('operations.activity:count.people', { count: row.people }),
                        t('operations.activity:count.socios', { count: row.socios }),
                        t('operations.activity:count.sessions', { count: row.sessions }),
                        t('operations.activity:count.messages', { count: row.messages }),
                        formatWhen(row.lastAt, timeZone),
                    )}
                />
            )}
        />
    );
}
