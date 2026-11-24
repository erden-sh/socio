import { useState } from 'react';
import { Link } from 'react-router';

import { formatNumber } from '@socio/shared/locale';
import {
    OPS_RANGE_LABELS,
    OPS_TILE_LABELS,
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

import { bucketLabel, formatWhen, statusLine, tileChange, tileValue } from './format';
import { opsPath } from './sections';
import { transcriptPath } from './transcript-path';
import { useOpsAnswer, useOpsQuery, useOpsSettings } from './use-ops';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const METRICS: { id: OpsMetric; label: string }[] = [
    { id: 'turns', label: 'Turns' },
    { id: 'messages', label: 'Messages from people' },
    { id: 'people', label: 'Active people' },
    { id: 'failed', label: 'Failed turns' },
    { id: 'tokens', label: 'Tokens' },
];

/** What the tiles compare with: "the 7 days before". */
function previousLabel(range: keyof typeof OPS_RANGE_LABELS, custom: boolean) {
    return custom || range === 'all' ? 'the period before' : `the ${OPS_RANGE_LABELS[range].toLowerCase()} before`;
}

function Tile({ tile, against }: { tile: OpsTile; against: string }) {
    const change = tileChange(tile.value, tile.previous);
    const good =
        change && change.direction !== 'same'
            ? (change.direction === 'up') === OPS_TILE_UP_IS_GOOD[tile.id]
            : undefined;
    return (
        <Card data-slot="ops-tile" data-tile={tile.id} className="gap-1 px-4 py-3 shadow-xs">
            <span className="text-xs text-muted-foreground">{OPS_TILE_LABELS[tile.id]}</span>
            <strong className="text-2xl font-semibold tabular-nums">{tileValue(tile.id, tile.value)}</strong>
            <span
                className={cn(
                    'min-h-4 text-xs text-muted-foreground',
                    good === true && 'text-emerald-700 dark:text-emerald-400',
                    good === false && 'text-destructive',
                )}
            >
                {change && `${change.text} vs ${against}`}
            </span>
        </Card>
    );
}

const STATUS_LABEL: Record<OpsTurnRow['status'], string> = {
    running: 'Running',
    finished: 'Finished',
    stopped: 'Stopped',
    failed: 'Failed',
    interrupted: 'Interrupted',
};

/**
 * Overview (CB-164): the tiles, a chart of one metric over the range,
 * and the turns in it, newest first, loading more as the list scrolls.
 * A socio's name narrows the whole view to it (a shareable link).
 */
export function OverviewSection() {
    const { query, search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const [metric, setMetric] = useState<OpsMetric>('turns');
    const overview = useOpsAnswer<OpsOverview>(`/operations/overview${search}`);
    const series = useOpsAnswer<OpsSeries>(`/operations/series/${metric}${search}`);
    const turns = useCursorList<OpsTurnRow>(`/operations/turns${search}`);
    const status = overview.data?.status;
    const against = previousLabel(query.range, !!query.from);
    const metricLabel = METRICS.find((item) => item.id === metric)!.label;
    const points = series.data?.points ?? [];
    return (
        <>
            {status && (
                <p
                    data-slot="ops-status"
                    data-state={status.state}
                    className={cn(
                        'm-0 text-xs text-muted-foreground',
                        status.state !== 'ready' && 'rounded-lg border bg-card px-4 py-3 text-sm',
                    )}
                >
                    {statusLine(status, timeZone)}
                </p>
            )}
            {overview.error && (
                <p role="alert" className="m-0 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                    {overview.error}
                </p>
            )}
            <section aria-label="Totals" aria-busy={overview.loading} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {overview.data
                    ? overview.data.tiles.map((tile) => <Tile key={tile.id} tile={tile} against={against} />)
                    : Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-21 rounded-xl" />)}
            </section>
            <Card data-slot="ops-chart" className="gap-4">
                <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle>{metricLabel}</CardTitle>
                    <Select value={metric} onValueChange={(value) => setMetric(value as OpsMetric)}>
                        <SelectTrigger size="sm" aria-label="Chart" className="w-52">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {METRICS.map((item) => (
                                <SelectItem key={item.id} value={item.id}>
                                    {item.label}
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
                            yName={metricLabel.toLowerCase()}
                            points={points.map((point) => ({
                                label: bucketLabel(point.at, series.data!.window.bucket, series.data!.window.timeZone),
                                value: point.value,
                            }))}
                        />
                    ) : series.data ? (
                        <p className="m-0 py-6 text-center text-sm text-muted-foreground">
                            Nothing to chart in this range.
                        </p>
                    ) : (
                        <Skeleton className="h-60 w-full" />
                    )}
                </CardContent>
            </Card>
            <Card data-slot="ops-turns" className="gap-4">
                <CardHeader>
                    <CardTitle>Turns</CardTitle>
                    <CardDescription>
                        Newest first, without their content. Pick a socio to see only its turns, or open a turn’s chat
                        to read it: that is written to the access log.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <InfiniteList
                        list={turns}
                        label="Turns"
                        itemKey={(row) => row.runId}
                        empty="No turns in this range."
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
                                    {STATUS_LABEL[row.status]}
                                </Badge>
                                <span className="text-xs text-muted-foreground">{row.source}</span>
                                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                                    {formatNumber(row.tokens)} tokens · {formatWhen(row.startedAt, timeZone)}
                                </span>
                                <Link
                                    to={transcriptPath(row.threadId, 'overview')}
                                    aria-label={`Open the chat of ${row.socioName ?? row.socioId}’s turn at ${formatWhen(row.startedAt, timeZone)}`}
                                    className="text-xs font-medium hover:underline"
                                >
                                    Open chat
                                </Link>
                            </div>
                        )}
                    />
                </CardContent>
            </Card>
        </>
    );
}
