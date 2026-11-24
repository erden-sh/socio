import { useMemo } from 'react';

import { compareText, formatNumber } from '@socio/shared/locale';
import type {
    OpsCapabilitiesView,
    OpsCoverageTool,
    OpsRequestRow,
} from '@socio/shared/operations/operations-knowledge';

import { InfiniteList } from '../../components/infinite-list/InfiniteList';
import { useCursorList } from '../../components/infinite-list/use-cursor-list';

import { formatWhen } from './format';
import { OpsStat, OpsStats, OpsStatusNote } from './OpsParts';
import { useOpsAnswer, useOpsQuery, useOpsSettings } from './use-ops';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const STATUS_LABELS: Record<string, string> = {
    triage: 'Triage',
    open: 'Open',
    ready: 'Ready',
    in_progress: 'In progress',
    in_review: 'In review',
    blocked: 'Blocked',
    done: 'Done',
    wont_fix: 'Won’t fix',
};

/** Gaps first, then by capability and name. */
const order = (a: OpsCoverageTool, b: OpsCoverageTool) =>
    Number(!!a.capability) - Number(!!b.capability) ||
    compareText(a.capability ?? '', b.capability ?? '') ||
    compareText(a.name, b.name);

/**
 * Capabilities (CB-191): the coverage matrix of the workspace's features
 * against the socio tools they give and the capability registry, each
 * tool's use in the range, the gaps, and what socios asked for and lack.
 */
export function CapabilitiesPage() {
    const { search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const answer = useOpsAnswer<OpsCapabilitiesView>(`/operations/capabilities${search}`);
    const requests = useCursorList<OpsRequestRow>('/operations/capabilities/requests');
    const coverage = answer.data?.coverage;
    const tools = useMemo(() => [...(coverage?.tools ?? [])].sort(order), [coverage]);
    const offered = tools.filter((tool) => tool.offered);
    const used = offered.filter((tool) => tool.calls > 0);
    return (
        <>
            <OpsStatusNote status={answer.data?.status} error={answer.error} />
            <OpsStats label="Capability totals" loading={answer.loading} count={4}>
                {coverage && (
                    <>
                        <OpsStat
                            id="tools"
                            label="Socio tools"
                            value={formatNumber(offered.length)}
                            note={`${formatNumber(coverage.capabilities.length)} capabilities`}
                        />
                        <OpsStat
                            id="used"
                            label="Used in the range"
                            value={formatNumber(used.length)}
                            note={`${formatNumber(offered.length - used.length)} not used`}
                        />
                        <OpsStat
                            id="unregistered"
                            label="Without an entry"
                            value={formatNumber(coverage.unregistered.length)}
                            tone={coverage.unregistered.length ? 'bad' : undefined}
                            note="socios can’t discover them"
                        />
                        <OpsStat
                            id="unoffered"
                            label="Not given here"
                            value={formatNumber(coverage.unoffered.length)}
                            note="declared, but off in this deployment"
                        />
                    </>
                )}
            </OpsStats>

            <Card data-slot="ops-gaps" className="min-w-0 gap-4">
                <CardHeader>
                    <CardTitle>Gaps</CardTitle>
                    <CardDescription>
                        Tools no capability declares don’t show in what socios learn they can do. Declared tools nothing
                        gives here usually wait for a service, such as computers.
                    </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 text-sm">
                    {coverage ? (
                        <>
                            <GapList
                                label="Without a registry entry"
                                names={coverage.unregistered}
                                empty="Every tool is declared."
                                variant="destructive"
                            />
                            <GapList
                                label="Declared, not given here"
                                names={coverage.unoffered}
                                empty="Every declared tool is given."
                                variant="secondary"
                            />
                            <GapList
                                label="Features with no socio tools"
                                names={coverage.modules
                                    .filter((module) => module.tools === 0)
                                    .map((module) => module.id)}
                                empty="Every feature gives tools."
                                variant="outline"
                            />
                            {coverage.modules.some((module) => !module.listed) && (
                                <p className="m-0 text-xs text-muted-foreground">
                                    Couldn’t list the tools of{' '}
                                    {coverage.modules
                                        .filter((module) => !module.listed)
                                        .map((module) => module.id)
                                        .join(', ')}
                                    .
                                </p>
                            )}
                        </>
                    ) : (
                        <Skeleton className="h-24 w-full" />
                    )}
                </CardContent>
            </Card>

            <Card data-slot="ops-coverage" className="min-w-0 gap-4">
                <CardHeader>
                    <CardTitle>Coverage</CardTitle>
                    <CardDescription>
                        Each socio tool, the feature that gives it, the capability that declares it, and its calls in
                        the range. Gaps first.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {coverage ? (
                        <Table data-slot="ops-coverage-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Tool</TableHead>
                                    <TableHead>Feature</TableHead>
                                    <TableHead>Capability</TableHead>
                                    <TableHead className="text-right">Calls</TableHead>
                                    <TableHead className="text-right">Failed</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {tools.map((tool) => (
                                    <TableRow
                                        key={tool.name}
                                        data-tool={tool.name}
                                        className={tool.offered ? undefined : 'opacity-60'}
                                    >
                                        <TableCell className="font-mono text-xs">{tool.name}</TableCell>
                                        <TableCell>{tool.module ?? 'Not given'}</TableCell>
                                        <TableCell>
                                            {tool.capability ??
                                                (tool.name === 'capabilities' ? (
                                                    'The registry'
                                                ) : (
                                                    <Badge variant="destructive">No entry</Badge>
                                                ))}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {formatNumber(tool.calls)}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {formatNumber(tool.errors)}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    ) : (
                        <Skeleton className="h-60 w-full" />
                    )}
                </CardContent>
            </Card>

            <Card data-slot="ops-requests" className="min-w-0 gap-4">
                <CardHeader>
                    <CardTitle>Capability requests</CardTitle>
                    <CardDescription>
                        What socios asked for and couldn’t do, latest asked first, whatever the range. Each is an item
                        on the Improvements board.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <InfiniteList
                        list={requests}
                        label="Capability requests"
                        itemKey={(row) => row.issueId}
                        empty="No socio has asked for a capability yet."
                        renderItem={(row) => (
                            <div
                                data-slot="ops-request"
                                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
                            >
                                <span className="min-w-0 truncate font-medium">{row.capability}</span>
                                {row.status && (
                                    <Badge variant="secondary">{STATUS_LABELS[row.status] ?? row.status}</Badge>
                                )}
                                {row.number !== null && (
                                    <span className="text-xs text-muted-foreground">CB-{row.number}</span>
                                )}
                                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                                    {formatNumber(row.people)} people · {formatNumber(row.socios)} socios · last{' '}
                                    {formatWhen(row.lastAt, timeZone)}
                                </span>
                            </div>
                        )}
                    />
                </CardContent>
            </Card>
        </>
    );
}

function GapList({
    label,
    names,
    empty,
    variant,
}: {
    label: string;
    names: string[];
    empty: string;
    variant: 'destructive' | 'secondary' | 'outline';
}) {
    return (
        <div className="grid gap-1.5">
            <span className="text-xs text-muted-foreground">{label}</span>
            {names.length ? (
                <ul aria-label={label} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                    {names.map((name) => (
                        <li key={name}>
                            <Badge variant={variant} className="font-mono">
                                {name}
                            </Badge>
                        </li>
                    ))}
                </ul>
            ) : (
                <span>{empty}</span>
            )}
        </div>
    );
}
