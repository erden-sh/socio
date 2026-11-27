import { useState } from 'react';

import { useTranslation } from '@socio/i18n/react';
import { formatNumber } from '@socio/shared/locale';
import type {
    OpsCostRow,
    OpsCostView,
    OpsCycleSummary,
    OpsRoomCost,
    PricingBackend,
} from '@socio/shared/operations/operations-cost';

import { SeriesChart } from '../../components/charts/SeriesChart';

import { formatUsd, perMillion, useFormatPerM, usePricing } from './cost-format';
import { CostPools, PriceSyncStatus, Prices } from './CostAdmin';
import { useOpsFormat } from './format';
import { formatMs } from './health-format';
import { OpsStat, OpsStats, OpsStatusNote } from './OpsParts';
import { useOpsAnswer, useOpsQuery, useOpsSettings } from './use-ops';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const count = (value: number | null | undefined) => (value === null || value === undefined ? '–' : formatNumber(value));

/** "+12% vs the period before", or nothing to compare with. */
function useChangeNote() {
    const { t } = useTranslation(['operations.cost']);
    return (now: number, before: number | null) => {
        if (before === null) {
            return undefined;
        }
        if (before === 0) {
            return now ? t('operations.cost:change.new') : t('operations.cost:change.same');
        }
        return t('operations.cost:change.percent', { change: Math.round(((now - before) / before) * 100) / 100 });
    };
}

/**
 * Operations → Cost (CB-195, CB-196): what turns cost over the range, by
 * model, socio, person and backend; turns with no price, shown as
 * unknown rather than free; self-hosted backends' cost pools with their
 * idle capacity and the cloud's price for the same turns; and the prices
 * Socio keeps, with the daily sync's state. Rooms (CB-218): who paid,
 * each room's cost and work cycles, and the cycles limits stopped.
 */
export function CostPage() {
    const { t } = useTranslation(['operations.cost', 'operations']);
    const { bucketLabel } = useOpsFormat();
    const change = useChangeNote();
    const formatPerM = useFormatPerM();
    const backendName = useBackendName();
    const payerLabel = usePayerLabel();
    const { search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const answer = useOpsAnswer<OpsCostView>(`/operations/cost${search}`);
    const pricing = usePricing();
    const [prefill, setPrefill] = useState<{ model: string; provider: string }>();
    const cost = answer.data?.cost;
    const backends = new Map((pricing.view?.backends ?? []).map((backend) => [backend.id, backend]));
    const totals = cost?.totals;
    return (
        <>
            <OpsStatusNote status={answer.data?.status} error={answer.error} />
            <OpsStats label={t('operations.cost:stats.label')} loading={answer.loading} count={4}>
                {answer.data && (
                    <>
                        <OpsStat
                            id="cost"
                            label={t('operations.cost:stats.cost')}
                            value={totals ? formatUsd(totals.costUsd) : '–'}
                            note={totals && change(totals.costUsd, totals.previousCostUsd)}
                        />
                        <OpsStat
                            id="priced"
                            label={t('operations.cost:stats.priced')}
                            value={count(totals && totals.priced + totals.pooled)}
                            note={totals && t('operations.cost:stats.priced-of', { count: totals.turns })}
                        />
                        <OpsStat
                            id="unpriced"
                            label={t('operations.cost:stats.unpriced')}
                            value={count(totals?.unpriced)}
                            tone={totals?.unpriced ? 'bad' : undefined}
                            note={t('operations.cost:stats.unpriced-note')}
                        />
                        <OpsStat
                            id="idle"
                            label={t('operations.cost:stats.idle')}
                            value={totals ? formatUsd(totals.idleUsd) : '–'}
                            note={t('operations.cost:stats.idle-note')}
                        />
                    </>
                )}
            </OpsStats>

            <Card className="min-w-0 gap-4">
                <CardHeader>
                    <CardTitle>{t('operations.cost:chart.title')}</CardTitle>
                    <CardDescription>
                        {t('operations.cost:chart.description', {
                            bucket: t('operations.cost:chart.x', { context: answer.data?.window.bucket }),
                        })}
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {cost?.series.length ? (
                        <SeriesChart
                            kind="bar"
                            label={t('operations.cost:chart.title')}
                            xName={t('operations.cost:chart.x', { context: answer.data!.window.bucket })}
                            yName={t('operations.cost:chart.y')}
                            points={cost.series.map((point) => ({
                                label: bucketLabel(point.at, answer.data!.window.bucket, timeZone),
                                value: point.priceUsd + point.poolUsd,
                            }))}
                        />
                    ) : answer.data ? (
                        <Empty loaded none={!cost} />
                    ) : (
                        <Skeleton className="h-60 w-full" />
                    )}
                </CardContent>
            </Card>

            <CostTable
                title={t('operations.cost:by-model.title')}
                description={t('operations.cost:by-model.description')}
                rows={cost?.byModel}
                loaded={!!answer.data}
                none={!cost}
                column={t('operations.cost:columns.model')}
            />
            <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                <CostTable
                    title={t('operations.cost:by-socio.title')}
                    rows={cost?.bySocio}
                    loaded={!!answer.data}
                    none={!cost}
                    column={t('operations.cost:columns.socio')}
                />
                <CostTable
                    title={t('operations.cost:by-person.title')}
                    description={t('operations.cost:by-person.description')}
                    rows={cost?.byPerson}
                    loaded={!!answer.data}
                    none={!cost}
                    column={t('operations.cost:columns.person')}
                />
            </div>
            <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                <CostTable
                    title={t('operations.cost:payers.title')}
                    description={t('operations.cost:payers.description')}
                    rows={cost?.byPayer}
                    loaded={!!answer.data}
                    none={!cost}
                    column={t('operations.cost:columns.paid-by')}
                    label={payerLabel}
                    slot="ops-cost-payers"
                />
                <CycleCard cycles={cost?.cycles} loaded={!!answer.data} />
            </div>
            <RoomTable rows={cost?.byRoom} loaded={!!answer.data} none={!cost} />

            <Card className="min-w-0 gap-4" data-slot="ops-cost-backends">
                <CardHeader>
                    <CardTitle>{t('operations.cost:backends.title')}</CardTitle>
                    <CardDescription>{t('operations.cost:backends.description')}</CardDescription>
                </CardHeader>
                <CardContent>
                    {cost?.backends.length ? (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('operations.cost:columns.backend')}</TableHead>
                                    <TableHead className="text-right">{t('operations.cost:columns.turns')}</TableHead>
                                    <TableHead className="text-right">{t('operations.cost:columns.tokens')}</TableHead>
                                    <TableHead className="text-right">{t('operations.cost:columns.cost')}</TableHead>
                                    <TableHead className="text-right">
                                        {t('operations.cost:columns.self-hosted')}
                                    </TableHead>
                                    <TableHead className="text-right">
                                        {t('operations.cost:columns.cloud-price')}
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {cost.backends.map((row) => {
                                    const backend = backends.get(row.backend);
                                    return (
                                        <TableRow key={row.backend} data-backend={row.backend}>
                                            <TableCell className="max-w-56">
                                                <div className="truncate font-medium">
                                                    {backendName(row.backend, backend)}
                                                </div>
                                                {backend && (
                                                    <div className="truncate text-xs text-muted-foreground">
                                                        {backend.provider}
                                                        {backend.model ? ` · ${backend.model}` : ''}
                                                    </div>
                                                )}
                                            </TableCell>
                                            <TableCell className="text-right tabular-nums">
                                                {formatNumber(row.turns)}
                                                {row.unpriced > 0 && (
                                                    <div className="text-xs text-destructive">
                                                        {t('operations.cost:unpriced', { count: row.unpriced })}
                                                    </div>
                                                )}
                                            </TableCell>
                                            <TableCell className="text-right tabular-nums">
                                                {formatNumber(row.inputTokens + row.outputTokens)}
                                            </TableCell>
                                            <TableCell className="text-right tabular-nums">
                                                {formatUsd(row.costUsd)}
                                            </TableCell>
                                            <TableCell className="text-right tabular-nums">
                                                {row.pooledTokens
                                                    ? formatPerM(perMillion(row.poolUsd, row.pooledTokens))
                                                    : '–'}
                                            </TableCell>
                                            <TableCell className="text-right tabular-nums">
                                                {row.pooledTokens && row.referenceUsd !== null
                                                    ? formatPerM(perMillion(row.referenceUsd, row.pooledTokens))
                                                    : '–'}
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    ) : (
                        <Empty loaded={!!answer.data} none={!cost} />
                    )}
                </CardContent>
            </Card>

            {cost && cost.unpricedModels.length > 0 && (
                <Card className="min-w-0 gap-4" data-slot="ops-cost-unpriced">
                    <CardHeader>
                        <CardTitle>{t('operations.cost:unpriced-models.title')}</CardTitle>
                        <CardDescription>{t('operations.cost:unpriced-models.description')}</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <ul className="m-0 grid list-none gap-2 p-0">
                            {cost.unpricedModels.map((row) => {
                                const backend = backends.get(row.backend);
                                return (
                                    <li
                                        key={`${row.model} ${row.backend}`}
                                        className="flex min-w-0 flex-wrap items-center gap-2 text-sm"
                                    >
                                        <span className="min-w-0 truncate font-medium">{row.model}</span>
                                        <span className="text-muted-foreground">
                                            {t('operations.cost:unpriced-models.on', {
                                                backend: backendName(row.backend, backend),
                                                count: row.turns,
                                            })}
                                        </span>
                                        <button
                                            type="button"
                                            className="text-sm underline"
                                            onClick={() =>
                                                setPrefill({
                                                    model: row.model,
                                                    provider: backend?.provider ?? '*',
                                                })
                                            }
                                        >
                                            {t('operations.cost:unpriced-models.add')}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </CardContent>
                </Card>
            )}

            <CostPools view={pricing.view} pools={cost?.pools} loaded={!!answer.data} reload={pricing.reload} />
            <PriceSyncStatus view={pricing.view} reload={pricing.reload} />
            <Prices view={pricing.view} error={pricing.error} reload={pricing.reload} prefill={prefill} />
        </>
    );
}

/** A backend as people know it: its label, ChatGPT connections, or its key. */
export function useBackendName() {
    const { t } = useTranslation(['operations.cost']);
    return (id: string, backend: PricingBackend | undefined) => {
        if (backend) {
            return backend.label;
        }
        if (id === 'shared') {
            return t('operations.cost:backends.shared');
        }
        if (id.startsWith('byo:')) {
            return t('operations.cost:backends.connections', { name: id.slice(4) });
        }
        return id === 'unknown'
            ? t('operations.cost:not-recorded')
            : t('operations.cost:backends.removed', { id: id.slice(0, 8) });
    };
}

/** An empty table: no turns in the range, or no numbers yet (the store isn't answering). */
function Empty({ loaded, none }: { loaded: boolean; none?: boolean }) {
    const { t } = useTranslation(['operations.cost']);
    return loaded ? (
        <p className="m-0 py-6 text-center text-sm text-muted-foreground">
            {none ? t('operations.cost:empty.none') : t('operations.cost:empty.no-turns')}
        </p>
    ) : (
        <Skeleton className="h-32 w-full" />
    );
}

/** Who paid, as people know it (CB-218). */
function usePayerLabel() {
    const { t } = useTranslation(['operations.cost']);
    return (row: OpsCostRow) => {
        if (row.key === 'workspace') {
            return t('operations.cost:payers.workspace');
        }
        if (!row.key) {
            return t('operations.cost:not-recorded');
        }
        return row.name ?? t('operations.cost:payers.person');
    };
}

/**
 * Work cycles in the range (CB-218): one person's message and every step
 * it led to. Cycles a limit stopped, by limit; spend a provider didn't
 * report, as unknown; and how long their steps ran beside start to end.
 */
function CycleCard({ cycles, loaded }: { cycles: OpsCycleSummary | undefined; loaded: boolean }) {
    const { t } = useTranslation(['operations.cost']);
    const facts: [string, string][] = cycles
        ? [
              [
                  t('operations.cost:cycles.cycles'),
                  t('operations.cost:cycles.cycles-value', { cycles: cycles.cycles, rooms: cycles.inRooms }),
              ],
              [
                  t('operations.cost:cycles.steps'),
                  t('operations.cost:cycles.steps-value', { steps: cycles.steps, handoffs: cycles.handoffs }),
              ],
              [t('operations.cost:cycles.deadline'), formatNumber(cycles.exhausted.deadline)],
              [t('operations.cost:cycles.tokens'), formatNumber(cycles.exhausted.tokens)],
              [t('operations.cost:cycles.handoffs'), formatNumber(cycles.exhausted.handoffs)],
              [t('operations.cost:cycles.spend'), formatNumber(cycles.exhausted.spend)],
              [t('operations.cost:cycles.stopped'), formatNumber(cycles.stopped)],
              [t('operations.cost:cycles.spend-unknown'), formatNumber(cycles.spendUnknown)],
              [t('operations.cost:cycles.running'), formatMs(cycles.runningMs)],
              [t('operations.cost:cycles.wall'), formatMs(cycles.wallMs)],
          ]
        : [];
    return (
        <Card className="min-w-0 gap-4" data-slot="ops-cost-cycles">
            <CardHeader>
                <CardTitle>{t('operations.cost:cycles.title')}</CardTitle>
                <CardDescription>{t('operations.cost:cycles.description')}</CardDescription>
            </CardHeader>
            <CardContent>
                {cycles ? (
                    <dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-sm">
                        {facts.map(([term, value]) => (
                            <div key={term} className="contents">
                                <dt className="min-w-0 text-muted-foreground">{term}</dt>
                                <dd className="m-0 text-right tabular-nums">{value}</dd>
                            </div>
                        ))}
                    </dl>
                ) : (
                    <Empty loaded={loaded} none />
                )}
            </CardContent>
        </Card>
    );
}

/** Each room's cost and work cycles (CB-218), the costliest first. */
function RoomTable({ rows, loaded, none }: { rows: OpsRoomCost[] | undefined; loaded: boolean; none: boolean }) {
    const { t } = useTranslation(['operations.cost']);
    return (
        <Card className="min-w-0 gap-4" data-slot="ops-cost-rooms">
            <CardHeader>
                <CardTitle>{t('operations.cost:rooms.title')}</CardTitle>
                <CardDescription>{t('operations.cost:rooms.description')}</CardDescription>
            </CardHeader>
            <CardContent>
                {rows?.length ? (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t('operations.cost:columns.room')}</TableHead>
                                <TableHead className="text-right">{t('operations.cost:columns.cycles')}</TableHead>
                                <TableHead className="text-right">{t('operations.cost:columns.turns')}</TableHead>
                                <TableHead className="text-right">{t('operations.cost:columns.tokens')}</TableHead>
                                <TableHead className="text-right">{t('operations.cost:columns.cost')}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rows.map((row) => (
                                <TableRow key={row.key} data-room={row.key}>
                                    <TableCell className="max-w-56">
                                        <div className="truncate font-medium">
                                            {row.name ?? t('operations.cost:rooms.unnamed')}
                                        </div>
                                        <div className="truncate text-xs text-muted-foreground">
                                            {t('operations.cost:rooms.people', { count: row.people })} ·{' '}
                                            {t('operations.cost:rooms.socios', { count: row.socios })}
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {formatNumber(row.cycles)}
                                        {row.exhausted > 0 && (
                                            <div className="text-xs text-muted-foreground">
                                                {t('operations.cost:rooms.hit-limit', { count: row.exhausted })}
                                            </div>
                                        )}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {formatNumber(row.turns)}
                                        {row.handoffs > 0 && (
                                            <div className="text-xs text-muted-foreground">
                                                {t('operations.cost:rooms.handed-on', { count: row.handoffs })}
                                            </div>
                                        )}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {formatNumber(row.tokens)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {formatUsd(row.costUsd)}
                                        {row.unpriced > 0 && (
                                            <Badge variant="outline" className="ml-2">
                                                {t('operations.cost:unpriced', { count: row.unpriced })}
                                            </Badge>
                                        )}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                ) : (
                    <Empty loaded={loaded} none={none} />
                )}
            </CardContent>
        </Card>
    );
}

function CostTable({
    title,
    description,
    rows,
    loaded,
    none,
    column,
    label,
    slot,
}: {
    title: string;
    description?: string;
    rows: OpsCostRow[] | undefined;
    loaded: boolean;
    none: boolean;
    column: string;
    /** How a row is named; else its name, or its key. */
    label?: (row: OpsCostRow) => string;
    slot?: string;
}) {
    const { t } = useTranslation(['operations.cost']);
    return (
        <Card className="min-w-0 gap-4" data-slot={slot}>
            <CardHeader>
                <CardTitle>{title}</CardTitle>
                {description && <CardDescription>{description}</CardDescription>}
            </CardHeader>
            <CardContent>
                {rows?.length ? (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{column}</TableHead>
                                <TableHead className="text-right">{t('operations.cost:columns.turns')}</TableHead>
                                <TableHead className="text-right">{t('operations.cost:columns.tokens')}</TableHead>
                                <TableHead className="text-right">{t('operations.cost:columns.cost')}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rows.map((row) => (
                                <TableRow key={row.key}>
                                    <TableCell className="max-w-56 truncate font-medium">
                                        {label
                                            ? label(row)
                                            : (row.name ?? (row.key || t('operations.cost:not-recorded')))}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">{formatNumber(row.turns)}</TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {formatNumber(row.tokens)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {formatUsd(row.costUsd)}
                                        {row.unpriced > 0 && (
                                            <Badge variant="outline" className="ml-2">
                                                {t('operations.cost:unpriced', { count: row.unpriced })}
                                            </Badge>
                                        )}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                ) : (
                    <Empty loaded={loaded} none={none} />
                )}
            </CardContent>
        </Card>
    );
}
