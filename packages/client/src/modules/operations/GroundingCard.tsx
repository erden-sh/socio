import { Link } from 'react-router';

import { formatNumber } from '@socio/shared/locale';
import type { OpsBucket } from '@socio/shared/operations/operations';
import type { OpsGrounding, OpsGroundingView } from '@socio/shared/operations/operations-grounding';
import type { RunRefKind } from '@socio/shared/runs/run-refs';

import { bucketLabel, formatWhen } from './format';
import { useOpsAnswer, useOpsSettings } from './use-ops';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** What each kind of reference is called on the page. */
export const REF_KIND_LABELS: Record<RunRefKind, string> = {
    page: 'Page reads',
    search: 'Search results',
    context: 'The chat’s page',
    dataset: 'Dataset queries',
    recall: 'Recalls of the chat',
};

/** The heatmap's rows: the Spaces read most. */
const MAX_SPACES = 12;
/** One hue, light to dark (dark to bright on a dark card): 0 is empty. */
const LEVELS = [0, 18, 36, 56, 78, 100];
const shade = (level: number) =>
    level ? `color-mix(in oklab, var(--chart-1) ${LEVELS[level]}%, var(--card))` : undefined;
const levelOf = (reads: number, max: number) =>
    reads <= 0 || max <= 0 ? 0 : Math.min(LEVELS.length - 1, Math.ceil((reads / max) * (LEVELS.length - 1)));
const plural = (n: number, word: string) => `${formatNumber(n)} ${word}${n === 1 ? '' : 's'}`;

/**
 * Knowledge → what grounded chats (CB-194): every kind of reference turns
 * recorded, a heatmap of each Space's reads over the range (pages read,
 * found in a search or open as the chat's page; each turn and page once),
 * and the pages that grounded the most chats. Recalls and dataset
 * queries are counted, but have no Space: they stay off the heatmap.
 */
export function GroundingCard({ search, spaceLink }: { search: string; spaceLink: (space: string) => string }) {
    const answer = useOpsAnswer<OpsGroundingView>(`/operations/knowledge/grounding${search}`);
    const grounding = answer.data?.grounding;
    return (
        <Card data-slot="ops-grounding" className="min-w-0 gap-4">
            <CardHeader>
                <CardTitle>What grounded chats</CardTitle>
                <CardDescription>
                    What socios read to answer in the range: pages they read, found in a search or had open as the
                    chat’s page, by Space; dataset queries and recalls of the chat are counted below the map. Titles and
                    counts only.
                </CardDescription>
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
                    <p className="m-0 py-6 text-center text-sm text-muted-foreground">No numbers yet.</p>
                ) : (
                    <Skeleton className="h-40 w-full" />
                )}
            </CardContent>
        </Card>
    );
}

function Kinds({ grounding }: { grounding: OpsGrounding }) {
    return (
        <dl
            data-slot="ops-grounding-kinds"
            className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-7"
        >
            <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Turns grounded</dt>
                <dd className="m-0 font-semibold tabular-nums">{formatNumber(grounding.runs)}</dd>
            </div>
            <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Chats</dt>
                <dd className="m-0 font-semibold tabular-nums">{formatNumber(grounding.chats)}</dd>
            </div>
            {grounding.kinds.map((kind) => (
                <div key={kind.kind} data-kind={kind.kind} className="min-w-0">
                    <dt className="text-xs text-muted-foreground">{REF_KIND_LABELS[kind.kind]}</dt>
                    <dd className="m-0 font-semibold tabular-nums">
                        {formatNumber(kind.refs)}
                        <span className="ml-1 text-xs font-normal text-muted-foreground">
                            in {plural(kind.runs, 'turn')}
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
    const { timeZone } = useOpsSettings();
    const spaces = grounding.spaces.slice(0, MAX_SPACES);
    if (!spaces.length || !grounding.buckets.length) {
        return (
            <p className="m-0 py-4 text-center text-sm text-muted-foreground">
                No Space’s pages grounded a chat in this range.
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
                aria-label="Reads by Space over the range"
                className="min-w-0 overflow-x-auto rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                tabIndex={0}
            >
                <table data-slot="ops-grounding-heatmap" className="w-full border-separate border-spacing-0.5 text-xs">
                    <caption className="sr-only">
                        Reads of each Space’s pages per {bucket}: each turn and page once.
                    </caption>
                    <thead>
                        <tr>
                            <th scope="col" className="text-left font-medium">
                                <span className="sr-only">Space</span>
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
                                Reads
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {spaces.map((space) => (
                            <tr key={space.spaceId} data-space={space.spaceId}>
                                <th scope="row" className="max-w-40 truncate pr-2 text-left font-medium">
                                    <Link to={spaceLink(space.spaceId)} className="hover:underline">
                                        {space.name ?? 'A removed Space'}
                                    </Link>
                                </th>
                                {grounding.buckets.map((at) => {
                                    const reads = cells.get(`${space.spaceId}\u0000${at}`)?.reads ?? 0;
                                    const label = `${space.name ?? 'A removed Space'}, ${bucketLabel(at, bucket, timeZone)}: ${plural(reads, 'read')}`;
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
                                        · {plural(space.pages, 'page')} · {plural(space.chats, 'chat')}
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div aria-hidden className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                Fewer
                {LEVELS.map((_, level) => (
                    <span
                        key={level}
                        className="inline-block size-3 rounded-sm bg-muted/40"
                        style={{ background: shade(level) }}
                    />
                ))}
                More
                {grounding.spaces.length > MAX_SPACES &&
                    ` · the ${MAX_SPACES} Spaces read most of ${formatNumber(grounding.spaces.length)}`}
            </div>
        </div>
    );
}

function TopPages({ grounding }: { grounding: OpsGrounding }) {
    const { timeZone } = useOpsSettings();
    if (!grounding.pages.length) {
        return null;
    }
    return (
        <div className="grid min-w-0 gap-2">
            <h3 className="m-0 text-sm font-medium">Pages that grounded most chats</h3>
            <Table data-slot="ops-grounding-pages">
                <TableHeader>
                    <TableRow>
                        <TableHead>Page</TableHead>
                        <TableHead className="max-sm:hidden">Space</TableHead>
                        <TableHead className="text-right">Chats</TableHead>
                        <TableHead className="text-right">Turns</TableHead>
                        <TableHead className="text-right max-sm:hidden">Last read</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {grounding.pages.map((page) => (
                        <TableRow key={page.pageId} data-page={page.pageId}>
                            <TableCell className="max-w-56 truncate font-medium">
                                {page.title ?? <span className="text-muted-foreground">A removed page</span>}
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
