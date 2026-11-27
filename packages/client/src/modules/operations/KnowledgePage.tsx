import { useState } from 'react';
import { Link } from 'react-router';

import { useTranslation } from '@socio/i18n/react';
import type { SharedAreaView } from '@socio/shared/data-types';
import { formatNumber } from '@socio/shared/locale';
import { opsSearch } from '@socio/shared/operations/operations';
import {
    OPS_STALE_DAYS,
    OPS_STORAGE_KINDS,
    type OpsDatasetRow,
    type OpsKnowledgeView,
    type OpsPageRow,
    type OpsQuota,
    type OpsStorageKind,
    type OpsStorageView,
} from '@socio/shared/operations/operations-knowledge';

import { SeriesChart } from '../../components/charts/SeriesChart';
import { InfiniteList } from '../../components/infinite-list/InfiniteList';
import { useCursorList } from '../../components/infinite-list/use-cursor-list';
import { onDemand } from '../../i18n/on-demand';
import { formatBytes } from '../dataspace/format';

import { formatWhen, useOpsFormat } from './format';
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

/**
 * Knowledge (CB-191): Spaces and their pages (how many, how long, edited,
 * stale), what grounded chats (CB-194), page search, dataset access, what
 * is stored and how full the data space quotas are. Picking a Space narrows the page to it.
 */
export function KnowledgePage() {
    const { t } = useTranslation(['operations.knowledge']);
    const ms = (value: number | null) => (value === null ? '–' : t('operations.knowledge:ms', { n: value }));
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
            <OpsStats label={t('operations.knowledge:totals')} loading={answer.loading} count={8}>
                {answer.data && (
                    <>
                        <OpsStat
                            id="pages"
                            label={t('operations.knowledge:tiles.pages')}
                            value={count(knowledge?.totals.pages)}
                            note={
                                knowledge && t('operations.knowledge:tiles.pages-note', { n: knowledge.totals.created })
                            }
                        />
                        <OpsStat
                            id="chars"
                            label={t('operations.knowledge:tiles.chars')}
                            value={
                                knowledge?.totals.pages
                                    ? `${formatNumber(Math.round(knowledge.totals.chars / knowledge.totals.pages))}`
                                    : '–'
                            }
                            note={t('operations.knowledge:tiles.chars-note')}
                        />
                        <OpsStat
                            id="edits"
                            label={t('operations.knowledge:tiles.edits')}
                            value={count(knowledge?.totals.edits)}
                            note={
                                knowledge && t('operations.knowledge:tiles.edits-note', { n: knowledge.totals.editors })
                            }
                        />
                        <OpsStat
                            id="stale"
                            label={t('operations.knowledge:tiles.stale')}
                            value={count(knowledge?.totals.stale)}
                            note={t('operations.knowledge:tiles.stale-note', { days: OPS_STALE_DAYS })}
                        />
                        <OpsStat
                            id="searches"
                            label={t('operations.knowledge:tiles.searches')}
                            value={count(knowledge?.search.queries)}
                            note={
                                knowledge &&
                                t('operations.knowledge:tiles.searches-note', { n: knowledge.search.empty })
                            }
                        />
                        <OpsStat
                            id="search-p95"
                            label={t('operations.knowledge:tiles.search-p95')}
                            value={knowledge ? ms(knowledge.search.p95) : '–'}
                            note={
                                knowledge &&
                                t('operations.knowledge:tiles.search-p95-note', { time: ms(knowledge.search.p50) })
                            }
                        />
                        <OpsStat
                            id="access"
                            label={t('operations.knowledge:tiles.access')}
                            value={count(knowledge?.access.total)}
                            note={
                                knowledge &&
                                t('operations.knowledge:tiles.access-note', { count: knowledge.access.datasets })
                            }
                        />
                        <OpsStat
                            id="denied"
                            label={t('operations.knowledge:tiles.denied')}
                            value={count(knowledge?.access.denied)}
                            tone={knowledge?.access.denied ? 'bad' : undefined}
                            note={
                                knowledge &&
                                t('operations.knowledge:tiles.denied-note', { count: knowledge.access.errors })
                            }
                        />
                    </>
                )}
            </OpsStats>

            <Card data-slot="ops-spaces" className="min-w-0 gap-4">
                <CardHeader>
                    <CardTitle>{t('operations.knowledge:spaces.title')}</CardTitle>
                    <CardDescription>
                        {t('operations.knowledge:spaces.description')}
                        {query.filters.space && (
                            <>
                                {' '}
                                <Link to={spaceLink(undefined)} className="underline">
                                    {t('operations.knowledge:spaces.show-all')}
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
                                    <TableHead>{t('operations.knowledge:spaces.space')}</TableHead>
                                    <TableHead className="text-right">
                                        {t('operations.knowledge:spaces.pages')}
                                    </TableHead>
                                    <TableHead className="text-right">
                                        {t('operations.knowledge:spaces.length')}
                                    </TableHead>
                                    <TableHead className="text-right">
                                        {t('operations.knowledge:spaces.edits')}
                                    </TableHead>
                                    <TableHead className="text-right">
                                        {t('operations.knowledge:spaces.stale')}
                                    </TableHead>
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
                        <p className="m-0 py-6 text-center text-sm text-muted-foreground">
                            {t('operations.knowledge:none')}
                        </p>
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
            <SharedAreasCard shared={shared} />
        </>
    );
}

/** Below the fold: its words load when it mounts (`onDemand`). */
const SharedAreasCard = onDemand(
    ['operations.knowledge-storage'],
    function SharedAreasCard({ shared }: { shared: { data?: SharedAreaView[]; error: string } }) {
        const { t } = useTranslation(['operations.knowledge-storage']);
        return (
            <Card>
                <CardHeader>
                    <CardTitle>{t('operations.knowledge-storage:shared.title')}</CardTitle>
                    <CardDescription>{t('operations.knowledge-storage:shared.description')}</CardDescription>
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
                                        {area.dotName ?? t('operations.knowledge-storage:shared.deleted')} ·{' '}
                                        {formatBytes(area.totalBytes)}
                                    </p>
                                ))
                            ) : (
                                <p>{t('operations.knowledge-storage:shared.empty')}</p>
                            )}
                            <Link to="/data?tab=shared" className="underline">
                                {t('operations.knowledge-storage:shared.manage')}
                            </Link>
                        </div>
                    )}
                </CardContent>
            </Card>
        );
    },
);

function PagesCard({ search }: { search: string }) {
    const { t } = useTranslation(['operations.knowledge']);
    const { timeZone } = useOpsSettings();
    const pages = useCursorList<OpsPageRow>(`/operations/knowledge/pages${search}`);
    return (
        <Card data-slot="ops-pages" className="min-w-0 gap-4">
            <CardHeader>
                <CardTitle>{t('operations.knowledge:pages.title')}</CardTitle>
                <CardDescription>{t('operations.knowledge:pages.description')}</CardDescription>
            </CardHeader>
            <CardContent>
                <InfiniteList
                    list={pages}
                    label={t('operations.knowledge:pages.title')}
                    itemKey={(row) => row.pageId}
                    empty={t('operations.knowledge:pages.empty')}
                    renderItem={(row) => (
                        <div data-slot="ops-page" className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                            <span className="min-w-0 truncate font-medium">{row.title}</span>
                            {row.stale && <Badge variant="secondary">{t('operations.knowledge:pages.stale')}</Badge>}
                            <span className="text-xs text-muted-foreground">{row.spaceName ?? row.spaceId}</span>
                            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                                {[
                                    t('operations.knowledge:pages.chars', { count: row.chars }),
                                    t('operations.knowledge:pages.edits', { count: row.edits }),
                                    t('operations.knowledge:pages.active', {
                                        when: formatWhen(row.activeAt, timeZone),
                                    }),
                                ].join(' · ')}
                            </span>
                        </div>
                    )}
                />
            </CardContent>
        </Card>
    );
}

function SearchCard({ view }: { view: OpsKnowledgeView | undefined }) {
    const { t } = useTranslation(['operations.knowledge']);
    const { bucketLabel } = useOpsFormat();
    const search = view?.knowledge?.search;
    return (
        <Card data-slot="ops-search" className="min-w-0 gap-4">
            <CardHeader>
                <CardTitle>{t('operations.knowledge:search.title')}</CardTitle>
                <CardDescription>{t('operations.knowledge:search.description')}</CardDescription>
            </CardHeader>
            <CardContent>
                {search && search.days.length ? (
                    <SeriesChart
                        kind="bar"
                        label={t('operations.knowledge:search.chart')}
                        xName={t('operations.knowledge:search.x')}
                        yName={t('operations.knowledge:search.y')}
                        points={search.days.map((day) => ({
                            label: bucketLabel(day.at, 'day', 'UTC'),
                            value: day.queries,
                        }))}
                    />
                ) : view ? (
                    <p className="m-0 py-6 text-center text-sm text-muted-foreground">
                        {t('operations.knowledge:search.empty')}
                    </p>
                ) : (
                    <Skeleton className="h-60 w-full" />
                )}
            </CardContent>
        </Card>
    );
}

function AccessCard({ view }: { view: OpsKnowledgeView | undefined }) {
    const { t } = useTranslation(['operations.knowledge']);
    const access = view?.knowledge?.access;
    return (
        <Card data-slot="ops-access" className="min-w-0 gap-4">
            <CardHeader>
                <CardTitle>{t('operations.knowledge:access.title')}</CardTitle>
                <CardDescription>{t('operations.knowledge:access.description')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
                {access && access.total ? (
                    <>
                        <div className="flex flex-wrap gap-2">
                            {access.actors.map((actor) => (
                                <Badge key={actor.kind} variant="outline">
                                    {t('operations.knowledge:access.actor', {
                                        actor: isActor(actor.kind)
                                            ? t(`operations.knowledge:access.actors.${actor.kind}`)
                                            : actor.kind,
                                        n: actor.count,
                                    })}
                                </Badge>
                            ))}
                            {access.chats > 0 && (
                                <Badge variant="outline" data-slot="ops-access-chats">
                                    {t('operations.knowledge:access.chats', { count: access.chats })}
                                </Badge>
                            )}
                        </div>
                        <Table data-slot="ops-access-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('operations.knowledge:access.action')}</TableHead>
                                    <TableHead>{t('operations.knowledge:access.outcome')}</TableHead>
                                    <TableHead className="text-right">
                                        {t('operations.knowledge:access.times')}
                                    </TableHead>
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
                        {t('operations.knowledge:access.empty')}
                    </p>
                ) : (
                    <Skeleton className="h-40 w-full" />
                )}
            </CardContent>
        </Card>
    );
}

const ACTORS = ['user', 'dot', 'token', 'system'] as const;
const isActor = (kind: string): kind is (typeof ACTORS)[number] => (ACTORS as readonly string[]).includes(kind);

function DatasetsCard({ search }: { search: string }) {
    const { t } = useTranslation(['operations.knowledge']);
    const { timeZone } = useOpsSettings();
    const datasets = useCursorList<OpsDatasetRow>(`/operations/knowledge/datasets${search}`);
    return (
        <Card data-slot="ops-datasets" className="min-w-0 gap-4">
            <CardHeader>
                <CardTitle>{t('operations.knowledge:datasets.title')}</CardTitle>
                <CardDescription>{t('operations.knowledge:datasets.description')}</CardDescription>
            </CardHeader>
            <CardContent>
                <InfiniteList
                    list={datasets}
                    label={t('operations.knowledge:datasets.title')}
                    itemKey={(row) => row.datasetId}
                    empty={t('operations.knowledge:datasets.empty')}
                    renderItem={(row) => (
                        <div
                            data-slot="ops-dataset"
                            className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
                        >
                            <span className="min-w-0 truncate font-medium">{row.name}</span>
                            {row.scratch && (
                                <Badge variant="secondary">{t('operations.knowledge:datasets.scratch')}</Badge>
                            )}
                            <span className="text-xs text-muted-foreground tabular-nums">
                                {row.historyBytes > 0
                                    ? t('operations.knowledge:datasets.history', {
                                          size: formatBytes(row.sizeBytes),
                                          history: formatBytes(row.historyBytes),
                                      })
                                    : formatBytes(row.sizeBytes)}
                                {' · '}
                                {t('operations.knowledge:datasets.tables', { count: row.tables })}
                            </span>
                            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                                {row.denied > 0
                                    ? t('operations.knowledge:datasets.denied', {
                                          uses: t('operations.knowledge:datasets.uses', { count: row.accesses }),
                                          n: row.denied,
                                      })
                                    : t('operations.knowledge:datasets.uses', { count: row.accesses })}
                                {row.lastAccessAt !== null &&
                                    ` · ${t('operations.knowledge:datasets.last', { when: formatWhen(row.lastAccessAt, timeZone) })}`}
                            </span>
                        </div>
                    )}
                />
            </CardContent>
        </Card>
    );
}

const StorageCard = onDemand(
    ['operations.knowledge-storage'],
    function StorageCard({ view, error }: { view: OpsStorageView | undefined; error: string }) {
        const { t } = useTranslation(['operations.knowledge-storage']);
        const { bucketLabel } = useOpsFormat();
        const [kind, setKind] = useState<OpsStorageKind>('datasets');
        const storage = view?.storage;
        const points = storage?.series.find((line) => line.kind === kind)?.points;
        return (
            <Card data-slot="ops-storage" className="min-w-0 gap-4">
                <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                    <div className="grid gap-1.5">
                        <CardTitle>{t('operations.knowledge-storage:storage.title')}</CardTitle>
                        <CardDescription>{t('operations.knowledge-storage:storage.description')}</CardDescription>
                    </div>
                    <Select value={kind} onValueChange={(value) => setKind(value as OpsStorageKind)}>
                        <SelectTrigger
                            size="sm"
                            aria-label={t('operations.knowledge-storage:storage.chart-picker')}
                            className="w-52"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {OPS_STORAGE_KINDS.map((item) => (
                                <SelectItem key={item} value={item}>
                                    {t(`operations.knowledge-storage:storage.kinds.${item}`)}
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
                                        label={t(`operations.knowledge-storage:storage.kinds.${row.kind}`)}
                                        value={formatBytes(row.bytes)}
                                        note={t('operations.knowledge-storage:storage.kind-note', {
                                            items: row.items,
                                            deleted: formatBytes(row.deletedBytes),
                                        })}
                                    />
                                ))}
                                <OpsStat
                                    id="storage-database"
                                    label={t('operations.knowledge-storage:storage.database')}
                                    value={storage.database ? formatBytes(storage.database.bytes) : '–'}
                                    note={
                                        storage.database?.agentRunsBytes != null
                                            ? t('operations.knowledge-storage:storage.chat-history', {
                                                  size: formatBytes(storage.database.agentRunsBytes),
                                              })
                                            : undefined
                                    }
                                />
                            </>
                        ) : (
                            Array.from({ length: 6 }, (_, index) => (
                                <Skeleton key={index} className="h-21 rounded-xl" />
                            ))
                        )}
                    </div>
                    {storage && points?.length ? (
                        <SeriesChart
                            kind="line"
                            label={t('operations.knowledge-storage:storage.chart', {
                                kind: t(`operations.knowledge-storage:storage.kinds.${kind}`),
                            })}
                            xName={t('operations.knowledge-storage:storage.bucket', { context: view!.window.bucket })}
                            yName={t('operations.knowledge-storage:storage.mb')}
                            points={points.map((point) => ({
                                label: bucketLabel(point.at, view!.window.bucket, view!.window.timeZone),
                                value: Math.round((point.value / 1024 / 1024) * 10) / 10,
                            }))}
                        />
                    ) : view ? (
                        <p className="m-0 py-6 text-center text-sm text-muted-foreground">
                            {t('operations.knowledge-storage:storage.empty')}
                        </p>
                    ) : null}
                    {storage && points?.length ? (
                        <p className="m-0 text-xs text-muted-foreground">
                            {t('operations.knowledge-storage:storage.unit', { context: view!.window.bucket })}
                        </p>
                    ) : null}
                </CardContent>
            </Card>
        );
    },
);

const QUOTA_LABELS = {
    dataFileMaxMb: 'file',
    dataDatasetMaxMb: 'dataset',
    dataUserMaxMb: 'person',
    dataMaxDatasets: 'datasets',
} as const satisfies Record<OpsQuota['key'], string>;

const QuotasCard = onDemand(
    ['operations.knowledge-storage'],
    function QuotasCard({ view }: { view: OpsStorageView | undefined }) {
        const { t } = useTranslation(['operations.knowledge-storage']);
        const amount = (quota: OpsQuota, n: number) =>
            quota.key === 'dataMaxDatasets'
                ? t('operations.knowledge-storage:quotas.datasets', { count: n })
                : t('operations.knowledge-storage:quotas.mb', { n });
        return (
            <Card data-slot="ops-quotas" className="min-w-0 gap-4">
                <CardHeader>
                    <CardTitle>{t('operations.knowledge-storage:quotas.title')}</CardTitle>
                    <CardDescription>{t('operations.knowledge-storage:quotas.description')}</CardDescription>
                </CardHeader>
                <CardContent>
                    {view ? (
                        <Table data-slot="ops-quotas-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('operations.knowledge-storage:quotas.limit')}</TableHead>
                                    <TableHead className="text-right">
                                        {t('operations.knowledge-storage:quotas.in-force')}
                                    </TableHead>
                                    <TableHead className="text-right">
                                        {t('operations.knowledge-storage:quotas.fullest')}
                                    </TableHead>
                                    <TableHead className="text-right">
                                        {t('operations.knowledge-storage:quotas.near')}
                                    </TableHead>
                                    <TableHead className="text-right">
                                        {t('operations.knowledge-storage:quotas.at')}
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {view.quotas.map((quota) => (
                                    <TableRow key={quota.key} data-quota={quota.key}>
                                        <TableCell className="font-medium">
                                            {t(`operations.knowledge-storage:quotas.labels.${QUOTA_LABELS[quota.key]}`)}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {amount(quota, quota.limit)}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {quota.highest === null ? '–' : amount(quota, quota.highest)}
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
    },
);
