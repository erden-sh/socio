import { useMemo } from 'react';

import { useTranslation } from '@socio/i18n/react';
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

/** A request's board status, by its key in `requests.statuses`. */
const STATUSES = {
    triage: 'triage',
    open: 'open',
    ready: 'ready',
    in_progress: 'in-progress',
    in_review: 'in-review',
    blocked: 'blocked',
    done: 'done',
    wont_fix: 'wont-fix',
} as const;
const statusKey = (status: string) =>
    Object.hasOwn(STATUSES, status) ? STATUSES[status as keyof typeof STATUSES] : undefined;

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
    const { t } = useTranslation(['operations.capabilities']);
    const { search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const answer = useOpsAnswer<OpsCapabilitiesView>(`/operations/capabilities${search}`);
    const requests = useCursorList<OpsRequestRow>('/operations/capabilities/requests');
    const coverage = answer.data?.coverage;
    const tools = useMemo(() => [...(coverage?.tools ?? [])].sort(order), [coverage]);
    const offered = tools.filter((tool) => tool.offered);
    const used = offered.filter((tool) => tool.calls > 0);
    const status = (id: string) => {
        const key = statusKey(id);
        return key ? t(`operations.capabilities:requests.statuses.${key}`) : id;
    };
    return (
        <>
            <OpsStatusNote status={answer.data?.status} error={answer.error} />
            <OpsStats label={t('operations.capabilities:totals')} loading={answer.loading} count={4}>
                {coverage && (
                    <>
                        <OpsStat
                            id="tools"
                            label={t('operations.capabilities:tiles.tools')}
                            value={formatNumber(offered.length)}
                            note={t('operations.capabilities:tiles.tools-note', {
                                count: coverage.capabilities.length,
                            })}
                        />
                        <OpsStat
                            id="used"
                            label={t('operations.capabilities:tiles.used')}
                            value={formatNumber(used.length)}
                            note={t('operations.capabilities:tiles.used-note', { n: offered.length - used.length })}
                        />
                        <OpsStat
                            id="unregistered"
                            label={t('operations.capabilities:tiles.unregistered')}
                            value={formatNumber(coverage.unregistered.length)}
                            tone={coverage.unregistered.length ? 'bad' : undefined}
                            note={t('operations.capabilities:tiles.unregistered-note')}
                        />
                        <OpsStat
                            id="unoffered"
                            label={t('operations.capabilities:tiles.unoffered')}
                            value={formatNumber(coverage.unoffered.length)}
                            note={t('operations.capabilities:tiles.unoffered-note')}
                        />
                    </>
                )}
            </OpsStats>

            <Card data-slot="ops-gaps" className="min-w-0 gap-4">
                <CardHeader>
                    <CardTitle>{t('operations.capabilities:gaps.title')}</CardTitle>
                    <CardDescription>{t('operations.capabilities:gaps.description')}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 text-sm">
                    {coverage ? (
                        <>
                            <GapList
                                label={t('operations.capabilities:gaps.unregistered')}
                                names={coverage.unregistered}
                                empty={t('operations.capabilities:gaps.unregistered-empty')}
                                variant="destructive"
                            />
                            <GapList
                                label={t('operations.capabilities:gaps.unoffered')}
                                names={coverage.unoffered}
                                empty={t('operations.capabilities:gaps.unoffered-empty')}
                                variant="secondary"
                            />
                            <GapList
                                label={t('operations.capabilities:gaps.no-tools')}
                                names={coverage.modules
                                    .filter((module) => module.tools === 0)
                                    .map((module) => module.id)}
                                empty={t('operations.capabilities:gaps.no-tools-empty')}
                                variant="outline"
                            />
                            {coverage.modules.some((module) => !module.listed) && (
                                <p className="m-0 text-xs text-muted-foreground">
                                    {t('operations.capabilities:gaps.unlisted', {
                                        modules: coverage.modules
                                            .filter((module) => !module.listed)
                                            .map((module) => module.id),
                                    })}
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
                    <CardTitle>{t('operations.capabilities:coverage.title')}</CardTitle>
                    <CardDescription>{t('operations.capabilities:coverage.description')}</CardDescription>
                </CardHeader>
                <CardContent>
                    {coverage ? (
                        <Table data-slot="ops-coverage-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('operations.capabilities:coverage.tool')}</TableHead>
                                    <TableHead>{t('operations.capabilities:coverage.feature')}</TableHead>
                                    <TableHead>{t('operations.capabilities:coverage.capability')}</TableHead>
                                    <TableHead className="text-right">
                                        {t('operations.capabilities:coverage.calls')}
                                    </TableHead>
                                    <TableHead className="text-right">
                                        {t('operations.capabilities:coverage.failed')}
                                    </TableHead>
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
                                        <TableCell>
                                            {tool.module ?? t('operations.capabilities:coverage.not-given')}
                                        </TableCell>
                                        <TableCell>
                                            {tool.capability ??
                                                (tool.name === 'capabilities' ? (
                                                    t('operations.capabilities:coverage.registry')
                                                ) : (
                                                    <Badge variant="destructive">
                                                        {t('operations.capabilities:coverage.no-entry')}
                                                    </Badge>
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
                    <CardTitle>{t('operations.capabilities:requests.title')}</CardTitle>
                    <CardDescription>{t('operations.capabilities:requests.description')}</CardDescription>
                </CardHeader>
                <CardContent>
                    <InfiniteList
                        list={requests}
                        label={t('operations.capabilities:requests.title')}
                        itemKey={(row) => row.issueId}
                        empty={t('operations.capabilities:requests.empty')}
                        renderItem={(row) => (
                            <div
                                data-slot="ops-request"
                                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
                            >
                                <span className="min-w-0 truncate font-medium">{row.capability}</span>
                                {row.status && <Badge variant="secondary">{status(row.status)}</Badge>}
                                {row.number !== null && (
                                    <span className="text-xs text-muted-foreground">{`CB-${row.number}`}</span>
                                )}
                                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                                    {[
                                        t('operations.capabilities:requests.people', { count: row.people }),
                                        t('operations.capabilities:requests.socios', { count: row.socios }),
                                        t('operations.capabilities:requests.last', {
                                            when: formatWhen(row.lastAt, timeZone),
                                        }),
                                    ].join(' · ')}
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
