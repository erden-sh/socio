import { useState } from 'react';

import { formatNumber } from '@socio/shared/locale';
import type {
    OpsCostRow,
    OpsCostView,
    OpsCycleSummary,
    OpsRoomCost,
    PricingBackend,
} from '@socio/shared/operations/operations-cost';

import { SeriesChart } from '../../components/charts/SeriesChart';

import { formatUsd, formatPerM, perMillion, usePricing } from './cost-format';
import { CostPools, PriceSyncStatus, Prices } from './CostAdmin';
import { bucketLabel } from './format';
import { formatMs } from './health-format';
import { OpsStat, OpsStats, OpsStatusNote } from './OpsParts';
import { useOpsAnswer, useOpsQuery, useOpsSettings } from './use-ops';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const count = (value: number | null | undefined) => (value === null || value === undefined ? '–' : formatNumber(value));

/** "+12% vs the period before", or nothing to compare with. */
function change(now: number, before: number | null) {
    if (before === null) {
        return undefined;
    }
    if (before === 0) {
        return now ? 'new vs the period before' : 'same as before';
    }
    const percent = Math.round(((now - before) / before) * 100);
    return `${percent > 0 ? '+' : ''}${percent}% vs the period before`;
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
            <OpsStats label="Cost totals" loading={answer.loading} count={4}>
                {answer.data && (
                    <>
                        <OpsStat
                            id="cost"
                            label="Cost"
                            value={totals ? formatUsd(totals.costUsd) : '–'}
                            note={totals && change(totals.costUsd, totals.previousCostUsd)}
                        />
                        <OpsStat
                            id="priced"
                            label="Priced turns"
                            value={count(totals && totals.priced + totals.pooled)}
                            note={totals && `of ${formatNumber(totals.turns)} turns`}
                        />
                        <OpsStat
                            id="unpriced"
                            label="Turns without a price"
                            value={count(totals?.unpriced)}
                            tone={totals?.unpriced ? 'bad' : undefined}
                            note="their cost is unknown, not zero"
                        />
                        <OpsStat
                            id="idle"
                            label="Idle capacity"
                            value={totals ? formatUsd(totals.idleUsd) : '–'}
                            note="cost pools’ hours without turns"
                        />
                    </>
                )}
            </OpsStats>

            <Card className="min-w-0 gap-4">
                <CardHeader>
                    <CardTitle>Cost over the range</CardTitle>
                    <CardDescription>
                        Turns’ cost per {answer.data?.window.bucket ?? 'bucket'}, priced and pooled together. Idle
                        capacity is not in it.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {cost?.series.length ? (
                        <SeriesChart
                            kind="bar"
                            label="Cost over the range"
                            xName={answer.data!.window.bucket}
                            yName="US dollars"
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
                title="By model"
                description="What each model’s turns cost."
                rows={cost?.byModel}
                loaded={!!answer.data}
                none={!cost}
                column="Model"
            />
            <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                <CostTable title="By socio" rows={cost?.bySocio} loaded={!!answer.data} none={!cost} column="Socio" />
                <CostTable
                    title="By person"
                    description="Turns a person started."
                    rows={cost?.byPerson}
                    loaded={!!answer.data}
                    none={!cost}
                    column="Person"
                />
            </div>
            <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                <CostTable
                    title="Who paid"
                    description="A person’s own model subscription, or the workspace’s models. Turns before work cycles didn’t record it."
                    rows={cost?.byPayer}
                    loaded={!!answer.data}
                    none={!cost}
                    column="Paid by"
                    label={payerLabel}
                    slot="ops-cost-payers"
                />
                <CycleCard cycles={cost?.cycles} loaded={!!answer.data} />
            </div>
            <RoomTable rows={cost?.byRoom} loaded={!!answer.data} none={!cost} />

            <Card className="min-w-0 gap-4" data-slot="ops-cost-backends">
                <CardHeader>
                    <CardTitle>Backends</CardTitle>
                    <CardDescription>
                        What each backend’s turns cost. For a self-hosted backend, its cost pools’ share per million
                        tokens beside what the cheapest listed cloud provider charges for the same turns.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {cost?.backends.length ? (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Backend</TableHead>
                                    <TableHead className="text-right">Turns</TableHead>
                                    <TableHead className="text-right">Tokens</TableHead>
                                    <TableHead className="text-right">Cost</TableHead>
                                    <TableHead className="text-right">Self-hosted</TableHead>
                                    <TableHead className="text-right">Cloud price</TableHead>
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
                                                        {formatNumber(row.unpriced)} unpriced
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
                        <CardTitle>Models without a price</CardTitle>
                        <CardDescription>
                            Turns on these show as unpriced. Add a price below, or a cost pool for a self-hosted
                            backend.
                        </CardDescription>
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
                                            on {backendName(row.backend, backend)} · {formatNumber(row.turns)} turns
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
                                            Add a price
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
export function backendName(id: string, backend: PricingBackend | undefined) {
    if (backend) {
        return backend.label;
    }
    if (id === 'shared') {
        return 'A shared backend (older turns)';
    }
    if (id.startsWith('byo:')) {
        return `${id.slice(4)} connections`;
    }
    return id === 'unknown' ? 'Not recorded' : `Removed backend (${id.slice(0, 8)})`;
}

/** An empty table: no turns in the range, or no numbers yet (the store isn't answering). */
function Empty({ loaded, none }: { loaded: boolean; none?: boolean }) {
    return loaded ? (
        <p className="m-0 py-6 text-center text-sm text-muted-foreground">
            {none ? 'No numbers yet.' : 'No turns in this range.'}
        </p>
    ) : (
        <Skeleton className="h-32 w-full" />
    );
}

/** Who paid, as people know it (CB-218). */
function payerLabel(row: OpsCostRow) {
    if (row.key === 'workspace') {
        return 'The workspace';
    }
    if (!row.key) {
        return 'Not recorded';
    }
    return row.name ?? 'A person';
}

/**
 * Work cycles in the range (CB-218): one person's message and every step
 * it led to. Cycles a limit stopped, by limit; spend a provider didn't
 * report, as unknown; and how long their steps ran beside start to end.
 */
function CycleCard({ cycles, loaded }: { cycles: OpsCycleSummary | undefined; loaded: boolean }) {
    const facts: [string, string][] = cycles
        ? [
              ['Work cycles', `${formatNumber(cycles.cycles)} (${formatNumber(cycles.inRooms)} in rooms)`],
              ['Steps', `${formatNumber(cycles.steps)}, ${formatNumber(cycles.handoffs)} handed on`],
              ['Stopped at the time limit', formatNumber(cycles.exhausted.deadline)],
              ['Stopped at the token limit', formatNumber(cycles.exhausted.tokens)],
              ['Stopped at the handoff limit', formatNumber(cycles.exhausted.handoffs)],
              ['Stopped at the spend limit', formatNumber(cycles.exhausted.spend)],
              ['Stopped by a person', formatNumber(cycles.stopped)],
              ['Spend not reported', formatNumber(cycles.spendUnknown)],
              ['Time working', formatMs(cycles.runningMs)],
              ['Start to end', formatMs(cycles.wallMs)],
          ]
        : [];
    return (
        <Card className="min-w-0 gap-4" data-slot="ops-cost-cycles">
            <CardHeader>
                <CardTitle>Work cycles</CardTitle>
                <CardDescription>
                    A cycle is one person’s message and everything it led to. Time working leaves out waits, such as for
                    an approval.
                </CardDescription>
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
    return (
        <Card className="min-w-0 gap-4" data-slot="ops-cost-rooms">
            <CardHeader>
                <CardTitle>By room</CardTitle>
                <CardDescription>
                    Each room’s turns, people and socios, and its work cycles: one per message a person sent there.
                </CardDescription>
            </CardHeader>
            <CardContent>
                {rows?.length ? (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Room</TableHead>
                                <TableHead className="text-right">Cycles</TableHead>
                                <TableHead className="text-right">Turns</TableHead>
                                <TableHead className="text-right">Tokens</TableHead>
                                <TableHead className="text-right">Cost</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rows.map((row) => (
                                <TableRow key={row.key} data-room={row.key}>
                                    <TableCell className="max-w-56">
                                        <div className="truncate font-medium">{row.name ?? 'A room'}</div>
                                        <div className="truncate text-xs text-muted-foreground">
                                            {formatNumber(row.people)} {row.people === 1 ? 'person' : 'people'} ·{' '}
                                            {formatNumber(row.socios)} {row.socios === 1 ? 'socio' : 'socios'}
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {formatNumber(row.cycles)}
                                        {row.exhausted > 0 && (
                                            <div className="text-xs text-muted-foreground">
                                                {formatNumber(row.exhausted)} hit a limit
                                            </div>
                                        )}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {formatNumber(row.turns)}
                                        {row.handoffs > 0 && (
                                            <div className="text-xs text-muted-foreground">
                                                {formatNumber(row.handoffs)} handed on
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
                                                {formatNumber(row.unpriced)} unpriced
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
                                <TableHead className="text-right">Turns</TableHead>
                                <TableHead className="text-right">Tokens</TableHead>
                                <TableHead className="text-right">Cost</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rows.map((row) => (
                                <TableRow key={row.key}>
                                    <TableCell className="max-w-56 truncate font-medium">
                                        {label ? label(row) : (row.name ?? (row.key || 'Not recorded'))}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">{formatNumber(row.turns)}</TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {formatNumber(row.tokens)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {formatUsd(row.costUsd)}
                                        {row.unpriced > 0 && (
                                            <Badge variant="outline" className="ml-2">
                                                {formatNumber(row.unpriced)} unpriced
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
