import { useState } from 'react';
import { Link } from 'react-router';

import type { SharedAreaView } from '@socio/shared/data-types';
import { formatNumber } from '@socio/shared/locale';
import { opsSearch } from '@socio/shared/operations/operations';
import {
    OPS_STALE_DAYS,
    OPS_STORAGE_KINDS,
    OPS_STORAGE_LABELS,
    type OpsDatasetRow,
    type OpsKnowledgeView,
    type OpsPageRow,
    type OpsStorageKind,
    type OpsStorageView,
} from '@socio/shared/operations/operations-knowledge';

import { SeriesChart } from '../../components/charts/SeriesChart';
import { InfiniteList } from '../../components/infinite-list/InfiniteList';
import { useCursorList } from '../../components/infinite-list/use-cursor-list';
import { formatBytes } from '../dataspace/format';

import { bucketLabel, formatWhen } from './format';
import { GroundingCard } from './GroundingCard';
import { OpsStat, OpsStats, OpsStatusNote } from './OpsParts';
import { opsPath } from './sections';
import { useOpsAnswer, useOpsQuery, useOpsSettings } from './use-ops';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const count = (value: number | null | undefined) => (value === null || value === undefined ? '–' : formatNumber(value));
const plural = (n: number, word: string) => `${formatNumber(n)} ${word}${n === 1 ? '' : 's'}`;
const ms = (value: number | null) => (value === null ? '–' : `${formatNumber(Math.round(value * 10) / 10)} ms`);

/**
 * Knowledge (CB-191): Spaces and their pages (how many, how long, edited,
 * stale), what grounded chats (CB-194), page search, dataset access, what
 * is stored and how full the data space quotas are. Picking a Space narrows the page to it.
 */
export function KnowledgePage() {
    const { query, search } = useOpsQuery();
    const answer = useOpsAnswer<OpsKnowledgeView>(`/operations/knowledge${search}`);
    const storage = useOpsAnswer<OpsStorageView>(`/operations/storage${search}`);
    const shared = useOpsAnswer<SharedAreaView[]>('/data/shared');
    const knowledge = answer.data?.knowledge;
    const spaceLink = (space: string | undefined) =>
        opsPath('knowledge', opsSearch({ ...query, filters: { ...query.filters, space } }));
    return (
        <>
            <OpsStatusNote status={answer.data?.status} error={answer.error} />
            <OpsStats label="Knowledge totals" loading={answer.loading} count={8}>
                {answer.data && (
                    <>
                        <OpsStat
                            id="pages"
                            label="Pages"
                            value={count(knowledge?.totals.pages)}
                            note={knowledge && `${count(knowledge.totals.created)} new`}
                        />
                        <OpsStat
                            id="chars"
                            label="Average length"
                            value={
                                knowledge?.totals.pages
                                    ? `${formatNumber(Math.round(knowledge.totals.chars / knowledge.totals.pages))}`
                                    : '–'
                            }
                            note="characters a page"
                        />
                        <OpsStat
                            id="edits"
                            label="Edits"
                            value={count(knowledge?.totals.edits)}
                            note={knowledge && `by ${count(knowledge.totals.editors)}`}
                        />
                        <OpsStat
                            id="stale"
                            label="Stale pages"
                            value={count(knowledge?.totals.stale)}
                            note={`untouched ${OPS_STALE_DAYS} days`}
                        />
                        <OpsStat
                            id="searches"
                            label="Searches"
                            value={count(knowledge?.search.queries)}
                            note={knowledge && `${count(knowledge.search.empty)} found nothing`}
                        />
                        <OpsStat
                            id="search-p95"
                            label="Search time (95%)"
                            value={knowledge ? ms(knowledge.search.p95) : '–'}
                            note={knowledge && `half under ${ms(knowledge.search.p50)}`}
                        />
                        <OpsStat
                            id="access"
                            label="Dataset access"
                            value={count(knowledge?.access.total)}
                            note={knowledge && `${count(knowledge.access.datasets)} datasets`}
                        />
                        <OpsStat
                            id="denied"
                            label="Access denied"
                            value={count(knowledge?.access.denied)}
                            tone={knowledge?.access.denied ? 'bad' : undefined}
                            note={knowledge && `${count(knowledge.access.errors)} errors`}
                        />
                    </>
                )}
            </OpsStats>

            <Card data-slot="ops-spaces" className="min-w-0 gap-4">
                <CardHeader>
                    <CardTitle>Spaces</CardTitle>
                    <CardDescription>
                        Pages now, and what was created and edited in the range. Pick a Space to see only its pages.
                        {query.filters.space && (
                            <>
                                {' '}
                                <Link to={spaceLink(undefined)} className="underline">
                                    Show every Space
                                </Link>
                            </>
                        )}
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {knowledge ? (
                        <Table data-slot="ops-spaces-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Space</TableHead>
                                    <TableHead className="text-right">Pages</TableHead>
                                    <TableHead className="text-right">Avg length</TableHead>
                                    <TableHead className="text-right">Edits</TableHead>
                                    <TableHead className="text-right">Stale</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {knowledge.spaces.map((space) => (
                                    <TableRow key={space.spaceId} data-space={space.spaceId}>
                                        <TableCell className="max-w-48 truncate font-medium">
                                            <Link to={spaceLink(space.spaceId)} className="hover:underline">
                                                {space.name ?? space.spaceId}
                                            </Link>
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {formatNumber(space.pages)}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {space.pages ? formatNumber(Math.round(space.chars / space.pages)) : '–'}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {formatNumber(space.edits)}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {formatNumber(space.stale)}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    ) : answer.data ? (
                        <p className="m-0 py-6 text-center text-sm text-muted-foreground">No numbers yet.</p>
                    ) : (
                        <Skeleton className="h-40 w-full" />
                    )}
                </CardContent>
            </Card>

            <GroundingCard search={search} spaceLink={spaceLink} />
            <PagesCard search={search} />
            <SearchCard view={answer.data} />
            <AccessCard view={answer.data} />
            <DatasetsCard search={search} />
            <StorageCard view={storage.data} error={storage.error} />
            <QuotasCard view={storage.data} />
            <Card>
                <CardHeader>
                    <CardTitle>Socios’ shared areas</CardTitle>
                    <CardDescription>Storage shared by everyone who uses each company socio.</CardDescription>
                </CardHeader>
                <CardContent>
                    {shared.error ? (
                        <p>{shared.error}</p>
                    ) : !shared.data ? (
                        <Skeleton className="h-16" />
                    ) : (
                        <div className="grid gap-2">
                            {shared.data.length ? (
                                shared.data.map((area) => (
                                    <p key={area.dotId}>
                                        {area.dotName ?? 'Deleted socio'} · {formatBytes(area.totalBytes)}
                                    </p>
                                ))
                            ) : (
                                <p>No shared data yet.</p>
                            )}
                            <Link to="/data?tab=shared" className="underline">
                                Manage shared data
                            </Link>
                        </div>
                    )}
                </CardContent>
            </Card>
        </>
    );
}

function PagesCard({ search }: { search: string }) {
    const { timeZone } = useOpsSettings();
    const pages = useCursorList<OpsPageRow>(`/operations/knowledge/pages${search}`);
    return (
        <Card data-slot="ops-pages" className="min-w-0 gap-4">
            <CardHeader>
                <CardTitle>Pages</CardTitle>
                <CardDescription>
                    Least recently edited or used first: the top of the list is what goes stale. Titles only.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <InfiniteList
                    list={pages}
                    label="Pages"
                    itemKey={(row) => row.pageId}
                    empty="No pages."
                    renderItem={(row) => (
                        <div data-slot="ops-page" className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                            <span className="min-w-0 truncate font-medium">{row.title}</span>
                            {row.stale && <Badge variant="secondary">Stale</Badge>}
                            <span className="text-xs text-muted-foreground">{row.spaceName ?? row.spaceId}</span>
                            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                                {formatNumber(row.chars)} characters · {plural(row.edits, 'edit')} · active{' '}
                                {formatWhen(row.activeAt, timeZone)}
                            </span>
                        </div>
                    )}
                />
            </CardContent>
        </Card>
    );
}

function SearchCard({ view }: { view: OpsKnowledgeView | undefined }) {
    const search = view?.knowledge?.search;
    return (
        <Card data-slot="ops-search" className="min-w-0 gap-4">
            <CardHeader>
                <CardTitle>Page search</CardTitle>
                <CardDescription>
                    Searches a day across the workspace (days in UTC); no query text is kept.
                </CardDescription>
            </CardHeader>
            <CardContent>
                {search && search.days.length ? (
                    <SeriesChart
                        kind="bar"
                        label="Searches a day"
                        xName="day"
                        yName="searches"
                        points={search.days.map((day) => ({
                            label: bucketLabel(day.at, 'day', 'UTC'),
                            value: day.queries,
                        }))}
                    />
                ) : view ? (
                    <p className="m-0 py-6 text-center text-sm text-muted-foreground">No searches in this range.</p>
                ) : (
                    <Skeleton className="h-60 w-full" />
                )}
            </CardContent>
        </Card>
    );
}

function AccessCard({ view }: { view: OpsKnowledgeView | undefined }) {
    const access = view?.knowledge?.access;
    return (
        <Card data-slot="ops-access" className="min-w-0 gap-4">
            <CardHeader>
                <CardTitle>Dataset access</CardTitle>
                <CardDescription>
                    What people, socios and apps did with datasets in the range, and how it went.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
                {access && access.total ? (
                    <>
                        <div className="flex flex-wrap gap-2">
                            {access.actors.map((actor) => (
                                <Badge key={actor.kind} variant="outline">
                                    {ACTOR_LABELS[actor.kind] ?? actor.kind}: {formatNumber(actor.count)}
                                </Badge>
                            ))}
                            {access.chats > 0 && (
                                <Badge variant="outline" data-slot="ops-access-chats">
                                    In {plural(access.chats, 'chat')}
                                </Badge>
                            )}
                        </div>
                        <Table data-slot="ops-access-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Action</TableHead>
                                    <TableHead>Outcome</TableHead>
                                    <TableHead className="text-right">Times</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {access.actions.map((row) => (
                                    <TableRow key={`${row.action} ${row.outcome}`}>
                                        <TableCell className="font-mono text-xs">{row.action}</TableCell>
                                        <TableCell>
                                            <Badge variant={row.outcome === 'ok' ? 'secondary' : 'destructive'}>
                                                {row.outcome}
                                            </Badge>
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {formatNumber(row.count)}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </>
                ) : view ? (
                    <p className="m-0 py-6 text-center text-sm text-muted-foreground">
                        No dataset access in this range.
                    </p>
                ) : (
                    <Skeleton className="h-40 w-full" />
                )}
            </CardContent>
        </Card>
    );
}

const ACTOR_LABELS: Record<string, string> = {
    user: 'People',
    dot: 'Socios',
    token: 'Apps and computers',
    system: 'The app',
};

function DatasetsCard({ search }: { search: string }) {
    const { timeZone } = useOpsSettings();
    const datasets = useCursorList<OpsDatasetRow>(`/operations/knowledge/datasets${search}`);
    return (
        <Card data-slot="ops-datasets" className="min-w-0 gap-4">
            <CardHeader>
                <CardTitle>Datasets</CardTitle>
                <CardDescription>Largest first, row history included, with their access in the range.</CardDescription>
            </CardHeader>
            <CardContent>
                <InfiniteList
                    list={datasets}
                    label="Datasets"
                    itemKey={(row) => row.datasetId}
                    empty="No datasets."
                    renderItem={(row) => (
                        <div
                            data-slot="ops-dataset"
                            className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
                        >
                            <span className="min-w-0 truncate font-medium">{row.name}</span>
                            {row.scratch && <Badge variant="secondary">Scratch</Badge>}
                            <span className="text-xs text-muted-foreground tabular-nums">
                                {formatBytes(row.sizeBytes)}
                                {row.historyBytes > 0 && ` + ${formatBytes(row.historyBytes)} history`} ·{' '}
                                {formatNumber(row.tables)} tables
                            </span>
                            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                                {plural(row.accesses, 'use')}
                                {row.denied > 0 && `, ${formatNumber(row.denied)} denied`}
                                {row.lastAccessAt !== null && ` · last ${formatWhen(row.lastAccessAt, timeZone)}`}
                            </span>
                        </div>
                    )}
                />
            </CardContent>
        </Card>
    );
}

function StorageCard({ view, error }: { view: OpsStorageView | undefined; error: string }) {
    const [kind, setKind] = useState<OpsStorageKind>('datasets');
    const storage = view?.storage;
    const points = storage?.series.find((line) => line.kind === kind)?.points;
    return (
        <Card data-slot="ops-storage" className="min-w-0 gap-4">
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                <div className="grid gap-1.5">
                    <CardTitle>Storage</CardTitle>
                    <CardDescription>
                        What is kept now, deleted items included (they are kept too), and over the range.
                    </CardDescription>
                </div>
                <Select value={kind} onValueChange={(value) => setKind(value as OpsStorageKind)}>
                    <SelectTrigger size="sm" aria-label="Chart" className="w-52">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {OPS_STORAGE_KINDS.map((item) => (
                            <SelectItem key={item} value={item}>
                                {OPS_STORAGE_LABELS[item]}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </CardHeader>
            <CardContent className="grid gap-4">
                {error && (
                    <p role="alert" className="m-0 text-sm text-destructive">
                        {error}
                    </p>
                )}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {storage ? (
                        <>
                            {storage.kinds.map((row) => (
                                <OpsStat
                                    key={row.kind}
                                    id={`storage-${row.kind}`}
                                    label={OPS_STORAGE_LABELS[row.kind]}
                                    value={formatBytes(row.bytes)}
                                    note={`${formatNumber(row.items)} · ${formatBytes(row.deletedBytes)} deleted`}
                                />
                            ))}
                            <OpsStat
                                id="storage-database"
                                label="Database"
                                value={storage.database ? formatBytes(storage.database.bytes) : '–'}
                                note={
                                    storage.database?.agentRunsBytes != null
                                        ? `${formatBytes(storage.database.agentRunsBytes)} chat history`
                                        : undefined
                                }
                            />
                        </>
                    ) : (
                        Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-21 rounded-xl" />)
                    )}
                </div>
                {storage && points?.length ? (
                    <SeriesChart
                        kind="line"
                        label={`${OPS_STORAGE_LABELS[kind]} over the range`}
                        xName={view!.window.bucket}
                        yName="MB"
                        points={points.map((point) => ({
                            label: bucketLabel(point.at, view!.window.bucket, view!.window.timeZone),
                            value: Math.round((point.value / 1024 / 1024) * 10) / 10,
                        }))}
                    />
                ) : view ? (
                    <p className="m-0 py-6 text-center text-sm text-muted-foreground">
                        Nothing to chart in this range.
                    </p>
                ) : null}
                {storage && points?.length ? (
                    <p className="m-0 text-xs text-muted-foreground">
                        In MB, at the end of each {view!.window.bucket === 'hour' ? 'hour' : view!.window.bucket}.
                    </p>
                ) : null}
            </CardContent>
        </Card>
    );
}

function QuotasCard({ view }: { view: OpsStorageView | undefined }) {
    return (
        <Card data-slot="ops-quotas" className="min-w-0 gap-4">
            <CardHeader>
                <CardTitle>Data space limits</CardTitle>
                <CardDescription>
                    The limits in force (Settings → General), the fullest use of each, and how many people are near one
                    (80%) or at it.
                </CardDescription>
            </CardHeader>
            <CardContent>
                {view ? (
                    <Table data-slot="ops-quotas-table">
                        <TableHeader>
                            <TableRow>
                                <TableHead>Limit</TableHead>
                                <TableHead className="text-right">In force</TableHead>
                                <TableHead className="text-right">Fullest</TableHead>
                                <TableHead className="text-right">Near</TableHead>
                                <TableHead className="text-right">At it</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {view.quotas.map((quota) => (
                                <TableRow key={quota.key} data-quota={quota.key}>
                                    <TableCell className="font-medium">{quota.label}</TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {formatNumber(quota.limit)} {quota.unit}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {quota.highest === null ? '–' : `${formatNumber(quota.highest)} ${quota.unit}`}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">{count(quota.near)}</TableCell>
                                    <TableCell className="text-right tabular-nums">{count(quota.at)}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                ) : (
                    <Skeleton className="h-40 w-full" />
                )}
            </CardContent>
        </Card>
    );
}
