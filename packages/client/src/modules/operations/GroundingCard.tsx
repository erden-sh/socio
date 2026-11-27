import { Link } from 'react-router';

import { useTranslation } from '@socio/i18n/react';
import { formatNumber } from '@socio/shared/locale';
import type { OpsBucket } from '@socio/shared/operations/operations';
import type { OpsGrounding, OpsGroundingView } from '@socio/shared/operations/operations-grounding';

import { formatWhen, useOpsFormat } from './format';
import { useOpsAnswer, useOpsSettings } from './use-ops';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** The heatmap's rows: the Spaces read most. */
const MAX_SPACES = 12;
/** One hue, light to dark (dark to bright on a dark card): 0 is empty. */
const LEVELS = [0, 18, 36, 56, 78, 100];
const shade = (level: number) =>
    level ? `color-mix(in oklab, var(--chart-1) ${LEVELS[level]}%, var(--card))` : undefined;
const levelOf = (reads: number, max: number) =>
    reads <= 0 || max <= 0 ? 0 : Math.min(LEVELS.length - 1, Math.ceil((reads / max) * (LEVELS.length - 1)));

/**
 * Knowledge → what grounded chats (CB-194): every kind of reference turns
 * recorded, a heatmap of each Space's reads over the range (pages read,
 * found in a search or open as the chat's page; each turn and page once),
 * and the pages that grounded the most chats. Recalls and dataset
 * queries are counted, but have no Space: they stay off the heatmap.
 */
export function GroundingCard({ search, spaceLink }: { search: string; spaceLink: (space: string) => string }) {
    const { t } = useTranslation(['operations.grounding']);
    const answer = useOpsAnswer<OpsGroundingView>(`/operations/knowledge/grounding${search}`);
    const grounding = answer.data?.grounding;
    return (
        <Card data-slot="ops-grounding" className="min-w-0 gap-4">
            <CardHeader>
                <CardTitle>{t('operations.grounding:title')}</CardTitle>
                <CardDescription>{t('operations.grounding:description')}</CardDescription>
            </CardHeader>
            <CardContent className="grid min-w-0 gap-5">
                {answer.error && !grounding ? (
                    <p role="alert" className="m-0 text-sm text-destructive">
                        {answer.error}
                    </p>
                ) : grounding ? (
                    <>
                        <Kinds grounding={grounding} />
                        <Heatmap grounding={grounding} bucket={answer.data!.window.bucket} spaceLink={spaceLink} />
                        <TopPages grounding={grounding} />
                    </>
                ) : answer.data ? (
                    <p className="m-0 py-6 text-center text-sm text-muted-foreground">
                        {t('operations.grounding:none')}
                    </p>
                ) : (
                    <Skeleton className="h-40 w-full" />
                )}
            </CardContent>
        </Card>
    );
}

function Kinds({ grounding }: { grounding: OpsGrounding }) {
    const { t } = useTranslation(['operations.grounding']);
    return (
        <dl
            data-slot="ops-grounding-kinds"
            className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-7"
        >
            <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">{t('operations.grounding:kinds.turns')}</dt>
                <dd className="m-0 font-semibold tabular-nums">{formatNumber(grounding.runs)}</dd>
            </div>
            <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">{t('operations.grounding:kinds.chats')}</dt>
                <dd className="m-0 font-semibold tabular-nums">{formatNumber(grounding.chats)}</dd>
            </div>
            {grounding.kinds.map((kind) => (
                <div key={kind.kind} data-kind={kind.kind} className="min-w-0">
                    <dt className="text-xs text-muted-foreground">{t(`operations.grounding:kinds.${kind.kind}`)}</dt>
                    <dd className="m-0 font-semibold tabular-nums">
                        {formatNumber(kind.refs)}
                        <span className="ml-1 text-xs font-normal text-muted-foreground">
                            {t('operations.grounding:kinds.in-turns', { count: kind.runs })}
                        </span>
                    </dd>
                </div>
            ))}
        </dl>
    );
}

function Heatmap({
    grounding,
    bucket,
    spaceLink,
}: {
    grounding: OpsGrounding;
    bucket: OpsBucket;
    spaceLink: (space: string) => string;
}) {
    const { t } = useTranslation(['operations.grounding']);
    const { bucketLabel } = useOpsFormat();
    const { timeZone } = useOpsSettings();
    const spaces = grounding.spaces.slice(0, MAX_SPACES);
    if (!spaces.length || !grounding.buckets.length) {
        return (
            <p className="m-0 py-4 text-center text-sm text-muted-foreground">
                {t('operations.grounding:heatmap.empty')}
            </p>
        );
    }
    const cells = new Map(grounding.cells.map((cell) => [`${cell.spaceId}\u0000${cell.at}`, cell]));
    const max = Math.max(1, ...grounding.cells.map((cell) => cell.reads));
    // Every column has a label for screen readers; only some are shown.
    const every = Math.max(1, Math.ceil(grounding.buckets.length / 8));
    return (
        <div className="grid min-w-0 gap-2">
            {/* Scrolls sideways on a narrow screen, by keyboard too. */}
            <div
                role="region"
                aria-label={t('operations.grounding:heatmap.label')}
                className="min-w-0 overflow-x-auto rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                tabIndex={0}
            >
                <table data-slot="ops-grounding-heatmap" className="w-full border-separate border-spacing-0.5 text-xs">
                    <caption className="sr-only">
                        {t('operations.grounding:heatmap.caption', { context: bucket })}
                    </caption>
                    <thead>
                        <tr>
                            <th scope="col" className="text-left font-medium">
                                <span className="sr-only">{t('operations.grounding:heatmap.space')}</span>
                            </th>
                            {grounding.buckets.map((at, index) => (
                                <th
                                    key={at}
                                    scope="col"
                                    className="min-w-4 px-0 text-left font-normal whitespace-nowrap text-muted-foreground"
                                >
                                    <span className={index % every ? 'sr-only' : undefined}>
                                        {bucketLabel(at, bucket, timeZone)}
                                    </span>
                                </th>
                            ))}
                            <th scope="col" className="pl-2 text-right font-medium whitespace-nowrap">
                                {t('operations.grounding:heatmap.reads')}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {spaces.map((space) => (
                            <tr key={space.spaceId} data-space={space.spaceId}>
                                <th scope="row" className="max-w-40 truncate pr-2 text-left font-medium">
                                    <Link to={spaceLink(space.spaceId)} className="hover:underline">
                                        {space.name ?? t('operations.grounding:removed-space')}
                                    </Link>
                                </th>
                                {grounding.buckets.map((at) => {
                                    const reads = cells.get(`${space.spaceId}\u0000${at}`)?.reads ?? 0;
                                    const label = t('operations.grounding:heatmap.cell', {
                                        space: space.name ?? t('operations.grounding:removed-space'),
                                        when: bucketLabel(at, bucket, timeZone),
                                        reads: t('operations.grounding:heatmap.cell-reads', { count: reads }),
                                    });
                                    return (
                                        <td
                                            key={at}
                                            title={label}
                                            data-reads={reads}
                                            className="h-6 min-w-4 rounded-sm bg-muted/40 p-0"
                                            style={{ background: shade(levelOf(reads, max)) }}
                                        >
                                            <span className="sr-only">{formatNumber(reads)}</span>
                                        </td>
                                    );
                                })}
                                <td className="pl-2 text-right whitespace-nowrap tabular-nums">
                                    {formatNumber(space.reads)}
                                    <span className="ml-1 text-muted-foreground">
                                        ·{' '}
                                        {[
                                            t('operations.grounding:heatmap.pages', { count: space.pages }),
                                            t('operations.grounding:heatmap.chats', { count: space.chats }),
                                        ].join(' · ')}
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div aria-hidden className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                {t('operations.grounding:heatmap.fewer')}
                {LEVELS.map((_, level) => (
                    <span
                        key={level}
                        className="inline-block size-3 rounded-sm bg-muted/40"
                        style={{ background: shade(level) }}
                    />
                ))}
                {t('operations.grounding:heatmap.more')}
                {grounding.spaces.length > MAX_SPACES &&
                    ` · ${t('operations.grounding:heatmap.top', { shown: MAX_SPACES, total: grounding.spaces.length })}`}
            </div>
        </div>
    );
}

function TopPages({ grounding }: { grounding: OpsGrounding }) {
    const { t } = useTranslation(['operations.grounding']);
    const { timeZone } = useOpsSettings();
    if (!grounding.pages.length) {
        return null;
    }
    return (
        <div className="grid min-w-0 gap-2">
            <h3 className="m-0 text-sm font-medium">{t('operations.grounding:pages.title')}</h3>
            <Table data-slot="ops-grounding-pages">
                <TableHeader>
                    <TableRow>
                        <TableHead>{t('operations.grounding:pages.page')}</TableHead>
                        <TableHead className="max-sm:hidden">{t('operations.grounding:pages.space')}</TableHead>
                        <TableHead className="text-right">{t('operations.grounding:pages.chats')}</TableHead>
                        <TableHead className="text-right">{t('operations.grounding:pages.turns')}</TableHead>
                        <TableHead className="text-right max-sm:hidden">
                            {t('operations.grounding:pages.last')}
                        </TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {grounding.pages.map((page) => (
                        <TableRow key={page.pageId} data-page={page.pageId}>
                            <TableCell className="max-w-56 truncate font-medium">
                                {page.title ?? (
                                    <span className="text-muted-foreground">
                                        {t('operations.grounding:removed-page')}
                                    </span>
                                )}
                            </TableCell>
                            <TableCell className="max-w-40 truncate text-muted-foreground max-sm:hidden">
                                {page.spaceName ?? '–'}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{formatNumber(page.chats)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatNumber(page.reads)}</TableCell>
                            <TableCell className="text-right text-muted-foreground tabular-nums max-sm:hidden">
                                {formatWhen(page.lastAt, timeZone)}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}
