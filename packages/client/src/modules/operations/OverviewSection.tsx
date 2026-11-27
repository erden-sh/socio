import { useState } from 'react';
import { Link } from 'react-router';

import { useTranslation } from '@socio/i18n/react';
import {
    OPS_TILE_UP_IS_GOOD,
    opsSearch,
    type OpsMetric,
    type OpsOverview,
    type OpsSeries,
    type OpsTile,
    type OpsTurnRow,
} from '@socio/shared/operations/operations';

import { SeriesChart } from '../../components/charts/SeriesChart';
import { InfiniteList } from '../../components/infinite-list/InfiniteList';
import { useCursorList } from '../../components/infinite-list/use-cursor-list';

import { useActivityWords } from './activity-parts';
import { formatWhen, tileValue, useOpsFormat } from './format';
import { OpsStatusNote } from './OpsParts';
import { opsPath } from './sections';
import { transcriptPath } from './transcript-path';
import { useOpsAnswer, useOpsQuery, useOpsSettings } from './use-ops';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** The chart's metrics, in its menu's order; named by the `metrics.<id>` keys. */
const METRICS: OpsMetric[] = ['turns', 'messages', 'people', 'failed', 'tokens'];

function Tile({ tile, against }: { tile: OpsTile; against: string }) {
    const { t } = useTranslation(['operations.overview', 'operations', 'operations.dashboard']);
    const { tileChange } = useOpsFormat();
    const change = tileChange(tile.value, tile.previous);
    const good =
        change && change.direction !== 'same'
            ? (change.direction === 'up') === OPS_TILE_UP_IS_GOOD[tile.id]
            : undefined;
    return (
        <Card data-slot="ops-tile" data-tile={tile.id} className="gap-1 px-4 py-3 shadow-xs">
            <span className="text-xs text-muted-foreground">{t(`operations.overview:tiles.${tile.id}`)}</span>
            <strong className="text-2xl font-semibold tabular-nums">{tileValue(tile.id, tile.value)}</strong>
            <span
                className={cn(
                    'min-h-4 text-xs text-muted-foreground',
                    good === true && 'text-emerald-700 dark:text-emerald-400',
                    good === false && 'text-destructive',
                )}
            >
                {change && t('operations.dashboard:change.versus', { change: change.text, against })}
            </span>
        </Card>
    );
}

/**
 * Overview (CB-164): the tiles, a chart of one metric over the range,
 * and the turns in it, newest first, loading more as the list scrolls.
 * A socio's name narrows the whole view to it (a shareable link).
 */
export function OverviewSection() {
    const { t } = useTranslation(['operations.overview', 'operations', 'operations.dashboard']);
    const { bucketLabel } = useOpsFormat();
    const { previousLabel } = useActivityWords();
    const { query, search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const [metric, setMetric] = useState<OpsMetric>('turns');
    const overview = useOpsAnswer<OpsOverview>(`/operations/overview${search}`);
    const series = useOpsAnswer<OpsSeries>(`/operations/series/${metric}${search}`);
    const turns = useCursorList<OpsTurnRow>(`/operations/turns${search}`);
    const against = previousLabel(query);
    const metricLabel = t(`operations.overview:metrics.${metric}`);
    const points = series.data?.points ?? [];
    return (
        <>
            <OpsStatusNote status={overview.data?.status} error={overview.error} />
            <section
                aria-label={t('operations.dashboard:totals')}
                aria-busy={overview.loading}
                className="grid grid-cols-2 gap-3 sm:grid-cols-3"
            >
                {overview.data
                    ? overview.data.tiles.map((tile) => <Tile key={tile.id} tile={tile} against={against} />)
                    : Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-21 rounded-xl" />)}
            </section>
            <Card data-slot="ops-chart" className="gap-4">
                <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle>{metricLabel}</CardTitle>
                    <Select value={metric} onValueChange={(value) => setMetric(value as OpsMetric)}>
                        <SelectTrigger size="sm" aria-label={t('operations.overview:chart')} className="w-52">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {METRICS.map((id) => (
                                <SelectItem key={id} value={id}>
                                    {t(`operations.overview:metrics.${id}`)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </CardHeader>
                <CardContent>
                    {series.data && points.length ? (
                        <SeriesChart
                            kind={series.data.window.bucket === 'hour' ? 'line' : 'bar'}
                            label={metricLabel}
                            xName={series.data.window.bucket}
                            yName={t(`operations.overview:axis.${metric}`)}
                            points={points.map((point) => ({
                                label: bucketLabel(point.at, series.data!.window.bucket, series.data!.window.timeZone),
                                value: point.value,
                            }))}
                        />
                    ) : series.data ? (
                        <p className="m-0 py-6 text-center text-sm text-muted-foreground">
                            {t('operations.overview:no-chart')}
                        </p>
                    ) : (
                        <Skeleton className="h-60 w-full" />
                    )}
                </CardContent>
            </Card>
            <Card data-slot="ops-turns" className="gap-4">
                <CardHeader>
                    <CardTitle>{t('operations.overview:turns.title')}</CardTitle>
                    <CardDescription>{t('operations.overview:turns.description')}</CardDescription>
                </CardHeader>
                <CardContent>
                    <InfiniteList
                        list={turns}
                        label={t('operations.overview:turns.title')}
                        itemKey={(row) => row.runId}
                        empty={t('operations.overview:turns.empty')}
                        renderItem={(row) => (
                            <div
                                data-slot="ops-turn"
                                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
                            >
                                <Link
                                    to={opsPath(
                                        'overview',
                                        opsSearch({
                                            ...query,
                                            filters: { ...query.filters, socio: row.socioId },
                                        }),
                                    )}
                                    className="min-w-0 truncate font-medium hover:underline"
                                >
                                    {row.socioName ?? row.socioId}
                                </Link>
                                <Badge variant={row.status === 'failed' ? 'destructive' : 'secondary'}>
                                    {t(`operations.overview:status.${row.status}`)}
                                </Badge>
                                <span className="text-xs text-muted-foreground">{row.source}</span>
                                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                                    {t('operations.overview:turns.tokens', { count: row.tokens })} ·{' '}
                                    {formatWhen(row.startedAt, timeZone)}
                                </span>
                                <Link
                                    to={transcriptPath(row.threadId, 'overview')}
                                    aria-label={t('operations.overview:turns.open-label', {
                                        socio: row.socioName ?? row.socioId,
                                        when: formatWhen(row.startedAt, timeZone),
                                    })}
                                    className="text-xs font-medium hover:underline"
                                >
                                    {t('operations.overview:turns.open')}
                                </Link>
                            </div>
                        )}
                    />
                </CardContent>
            </Card>
        </>
    );
}
