import { useEffect, useState } from 'react';

import { formatNumber, numberFormat } from '@socio/shared/locale';
import type { PageRevisionStats, SearchIndexSizes, SearchStatsView } from '@socio/shared/pages/page-search';

import { api } from '../../lib/api';
import { formatBytes } from '../dataspace/format';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const oneDecimal = numberFormat({ maximumFractionDigits: 1 });
const megabytes = (bytes: number) => `${oneDecimal.format(bytes / 1024 / 1024)} MB`;
const millis = (value: number | null) => (value === null ? '–' : `${oneDecimal.format(value)} ms`);

/** The index's parts, in a line. */
export function sizesLine(sizes: SearchIndexSizes) {
    return `${formatNumber(sizes.pages)} ${sizes.pages === 1 ? 'page' : 'pages'} · words ${megabytes(sizes.wordBytes)} · trigram ${megabytes(sizes.trigramBytes)} · text ${megabytes(sizes.textBytes)}`;
}

/**
 * Earlier versions of pages kept on edits: only here, as counts; search
 * never reads them.
 */
export function revisionsLine(stats: PageRevisionStats) {
    return `Earlier versions kept: ${formatNumber(stats.revisions)} ${stats.revisions === 1 ? 'revision' : 'revisions'} of ${formatNumber(stats.pages)} ${stats.pages === 1 ? 'page' : 'pages'} · ${formatBytes(stats.bytes)}, not searched`;
}

/**
 * Page search over time: each day's searches, how many found nothing or
 * were corrected, their p50, p95 and p99, and the index's sizes then
 * and now. Counts and timings only: the rollup never keeps what anyone
 * searched for.
 */
export function PageSearchCard() {
    const [stats, setStats] = useState<SearchStatsView>();
    const [error, setError] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        api<SearchStatsView>('/operator/page-search', 'GET', undefined, controller.signal)
            .then((next) => !controller.signal.aborted && setStats(next))
            .catch((e: unknown) => {
                if (!controller.signal.aborted) {
                    setError(e instanceof Error ? e.message : 'Could not load.');
                }
            });
        return () => controller.abort();
    }, []);
    return (
        <Card className="mt-6" data-slot="page-search-stats">
            <CardHeader>
                <CardTitle>Page search</CardTitle>
                <CardDescription>
                    How fast searches answer, by day (UTC), from ⌘K, the Space libraries and the socios. Counts and
                    timings only; no search words are kept.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
                {error && <p className="text-destructive">{error}</p>}
                {!stats && !error && <Skeleton className="h-16" />}
                {stats && (
                    <p className="text-muted-foreground" data-slot="page-search-index">
                        Index now: {sizesLine(stats.now)}
                    </p>
                )}
                {stats?.revisions && (
                    <p className="text-muted-foreground" data-slot="page-revisions-kept">
                        {revisionsLine(stats.revisions)}
                    </p>
                )}
                {stats && !stats.days.length && <p className="text-muted-foreground">No searches yet.</p>}
                {stats && !!stats.days.length && (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Day</TableHead>
                                <TableHead className="text-right">Searches</TableHead>
                                <TableHead className="text-right">Nothing found</TableHead>
                                <TableHead className="text-right">Corrected</TableHead>
                                <TableHead className="text-right">p50</TableHead>
                                <TableHead className="text-right">p95</TableHead>
                                <TableHead className="text-right">p99</TableHead>
                                <TableHead>Index</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {stats.days.map((day) => (
                                <TableRow key={day.day} data-slot="page-search-day">
                                    <TableCell>{day.day}</TableCell>
                                    <TableCell className="text-right">{formatNumber(day.queries)}</TableCell>
                                    <TableCell className="text-right">{formatNumber(day.empty)}</TableCell>
                                    <TableCell className="text-right">{formatNumber(day.corrected)}</TableCell>
                                    <TableCell className="text-right">{millis(day.p50)}</TableCell>
                                    <TableCell className="text-right">{millis(day.p95)}</TableCell>
                                    <TableCell className="text-right">{millis(day.p99)}</TableCell>
                                    <TableCell className="text-muted-foreground">
                                        {day.sizes
                                            ? megabytes(
                                                  day.sizes.wordBytes + day.sizes.trigramBytes + day.sizes.textBytes,
                                              )
                                            : '–'}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </CardContent>
        </Card>
    );
}
