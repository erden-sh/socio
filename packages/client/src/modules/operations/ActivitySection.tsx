import { useState } from 'react';

import { formatNumber } from '@socio/shared/locale';
import {
    OPS_ACTIVITY_TILE_LABELS,
    type OpsActivity,
    type OpsActivityPoint,
    type OpsChatRow,
    type OpsPersonRow,
    type OpsSocioRow,
} from '@socio/shared/operations/operations-activity';

import { SeriesChart } from '../../components/charts/SeriesChart';
import { InfiniteList } from '../../components/infinite-list/InfiniteList';
import { useCursorList } from '../../components/infinite-list/use-cursor-list';

import {
    BreakdownRow,
    counts,
    filterLink,
    personLabel,
    previousLabel,
    RowLink,
    StatusNote,
    Tiles,
} from './activity-parts';
import { bucketLabel, formatWhen } from './format';
import { transcriptPath } from './transcript-path';
import { useOpsAnswer, useOpsQuery, useOpsSettings } from './use-ops';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type ChartMetric = keyof Omit<OpsActivityPoint, 'at'>;
const CHART: { id: ChartMetric; label: string }[] = [
    { id: 'people', label: 'Active people' },
    { id: 'sessions', label: 'Sessions' },
    { id: 'messages', label: 'Messages from people' },
];

const KIND_LABEL = {
    human: 'People',
    automation: 'Automation',
    unknown: 'Unregistered',
} as const;

/**
 * Activity (CB-190): who works with which socios, how often and through
 * which channels. Tiles against the period before, a chart, sources
 * (people and automation apart, as the source registry says), who takes
 * part in chats, feature use by capability and Space use; then people,
 * socios and chats, last active first, loading more as they scroll. A
 * person's or socio's name narrows the whole page to them.
 */
export function ActivitySection() {
    const { query, search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const [metric, setMetric] = useState<ChartMetric>('people');
    const answer = useOpsAnswer<OpsActivity>(`/operations/activity${search}`);
    const data = answer.data;
    const metricLabel = CHART.find((item) => item.id === metric)!.label;
    return (
        <>
            <StatusNote answer={data} timeZone={timeZone} error={answer.error} />
            <Tiles
                tiles={data?.tiles}
                labels={OPS_ACTIVITY_TILE_LABELS}
                against={previousLabel(query)}
                loading={answer.loading}
                count={6}
            />
            {data && (
                <p className="m-0 text-xs text-muted-foreground">
                    A session is a chat’s messages with less than {data.sessionGapMinutes} minutes between them; a
                    shared one counts once here and for each person in it. Stickiness is daily people over the people of
                    the last 7 days.
                </p>
            )}
            <Card data-slot="ops-activity-chart" className="gap-4">
                <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle>{metricLabel}</CardTitle>
                    <Select value={metric} onValueChange={(value) => setMetric(value as ChartMetric)}>
                        <SelectTrigger size="sm" aria-label="Chart" className="w-52">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {CHART.map((item) => (
                                <SelectItem key={item.id} value={item.id}>
                                    {item.label}
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
                            yName={metricLabel.toLowerCase()}
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
            <div className="grid gap-6 lg:grid-cols-2">
                <Card data-slot="ops-sources" className="gap-3">
                    <CardHeader>
                        <CardTitle>Channels</CardTitle>
                        <CardDescription>
                            Turns and people’s messages by where they came from. Automation, such as schedules, is
                            counted apart from people.
                        </CardDescription>
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
                                                    {KIND_LABEL[source.kind]}
                                                </Badge>
                                            }
                                            numbers={counts(
                                                [source.turns, 'turn', 'turns'],
                                                [source.people, 'person', 'people'],
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
                        <CardTitle>Who takes part</CardTitle>
                        <CardDescription>
                            Chats can have several people and several socios. Turns one socio starts for another are
                            collaboration, not use.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        {data ? (
                            <dl className="m-0 grid grid-cols-2 gap-3 text-sm">
                                {(
                                    [
                                        ['Chats with people', data.participation.chats],
                                        ['With several people', data.participation.withSeveralPeople],
                                        ['With several socios', data.participation.withSeveralSocios],
                                        ['Socio-to-socio turns', data.participation.collaboration],
                                    ] as const
                                ).map(([label, value]) => (
                                    <div key={label} className="grid gap-0.5">
                                        <dt className="text-xs text-muted-foreground">{label}</dt>
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
                        <CardTitle>Feature use</CardTitle>
                        <CardDescription>
                            Tool calls by capability.{' '}
                            {query.filters.person
                                ? 'Only the turns this person started.'
                                : 'Pick a person below to see theirs.'}
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
                                            numbers={`${counts(
                                                [feature.calls, 'call', 'calls'],
                                                [feature.people, 'person', 'people'],
                                            )}${feature.errors || feature.refusals ? ` · ${counts([feature.errors, 'error', 'errors'], [feature.refusals, 'refusal', 'refusals'])}` : ''}`}
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
                        <CardTitle>Spaces</CardTitle>
                        <CardDescription>
                            Pages made and edited in each Space, by people and by socios, and who works with its socios.
                        </CardDescription>
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
                                            numbers={`${counts(
                                                [space.writesByPeople, 'write by people', 'writes by people'],
                                                [space.writesBySocios, 'by socios', 'by socios'],
                                            )} · ${counts([space.people, 'person', 'people'])}`}
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
    return loading ? (
        <Skeleton className="h-24 w-full" />
    ) : (
        <p className="m-0 py-2 text-sm text-muted-foreground">Nothing in this range.</p>
    );
}

/** People, socios and chats: cursor-paged, last active first. */
function Drilldowns() {
    const [tab, setTab] = useState('people');
    return (
        <Card data-slot="ops-activity-lists" className="gap-4">
            <CardHeader>
                <CardTitle>Who and where</CardTitle>
                <CardDescription>
                    Last active first, without what anyone wrote. Opening a chat is recorded in the access log.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <Tabs value={tab} onValueChange={setTab}>
                    <TabsList>
                        <TabsTrigger value="people">People</TabsTrigger>
                        <TabsTrigger value="socios">Socios</TabsTrigger>
                        <TabsTrigger value="chats">Chats</TabsTrigger>
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
    const { query, search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const list = useCursorList<OpsPersonRow>(`/operations/activity/people${search}`);
    return (
        <InfiniteList
            list={list}
            label="People"
            itemKey={(row) => row.personId}
            empty="No one wrote to a socio in this range."
            renderItem={(row) => (
                <BreakdownRow
                    slot="ops-person"
                    name={
                        <RowLink to={filterLink('activity', query, { person: row.personId })}>
                            {personLabel(row.personId, row.name)}
                        </RowLink>
                    }
                    numbers={`${counts(
                        [row.sessions, 'session', 'sessions'],
                        [row.messages, 'message', 'messages'],
                        [row.activeDays, 'day', 'days'],
                        [row.socios, 'socio', 'socios'],
                        [row.toolCalls, 'tool call', 'tool calls'],
                    )} · ${formatWhen(row.lastAt, timeZone)}`}
                />
            )}
        />
    );
}

function SociosList() {
    const { query, search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const list = useCursorList<OpsSocioRow>(`/operations/activity/socios${search}`);
    return (
        <InfiniteList
            list={list}
            label="Socios"
            itemKey={(row) => row.socioId}
            empty="No socio had people’s messages in this range."
            renderItem={(row) => (
                <BreakdownRow
                    slot="ops-socio"
                    name={
                        <RowLink to={filterLink('activity', query, { socio: row.socioId })}>
                            {row.name ?? row.socioId}
                        </RowLink>
                    }
                    numbers={`${counts(
                        [row.people, 'person', 'people'],
                        [row.sessions, 'session', 'sessions'],
                        [row.chats, 'chat', 'chats'],
                    )} · ${row.perChat.toFixed(1)} messages a chat${
                        row.collaboration
                            ? ` · ${counts([row.collaboration, 'turn for socios', 'turns for socios'])}`
                            : ''
                    } · ${formatWhen(row.lastAt, timeZone)}`}
                />
            )}
        />
    );
}

function ChatsList() {
    const { search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const list = useCursorList<OpsChatRow>(`/operations/activity/chats${search}`);
    return (
        <InfiniteList
            list={list}
            label="Chats"
            itemKey={(row) => row.threadId}
            empty="No chats with people in this range."
            renderItem={(row) => (
                <BreakdownRow
                    slot="ops-chat"
                    name={
                        <RowLink to={transcriptPath(row.threadId, 'activity')}>
                            {row.socioName ?? row.socioId ?? 'A chat'}
                        </RowLink>
                    }
                    meta={
                        <>
                            {row.ownerKind === 'team' && <Badge variant="outline">Shared</Badge>}
                            {row.ownerKind === 'room' && <Badge variant="outline">Room</Badge>}
                            {row.resumed && <Badge variant="secondary">Resumed</Badge>}
                        </>
                    }
                    numbers={`${counts(
                        [row.people, 'person', 'people'],
                        [row.socios, 'socio', 'socios'],
                        [row.sessions, 'session', 'sessions'],
                        [row.messages, 'message', 'messages'],
                    )} · ${formatWhen(row.lastAt, timeZone)}`}
                />
            )}
        />
    );
}
