import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import { compareText, formatNumber } from '@socio/shared/locale';
import {
    DEFAULT_POOL_WEIGHTS,
    POOL_CATEGORIES,
    POOL_PERIODS,
    PRICE_SOURCES,
    type CostPool,
    type OpsCostPool,
    type PoolCategory,
    type PoolPeriod,
    type PriceSyncView,
    type PricingView,
} from '@socio/shared/operations/operations-cost';

import { api } from '../../lib/api';

import { dayInput, dayOf, formatPerM, formatUsd, originLabel } from './cost-format';
import { formatWhen } from './format';
import { opsPath } from './sections';
import { useOpsSettings } from './use-ops';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Reload = () => Promise<void>;

const CATEGORY_LABELS: Record<PoolCategory, string> = {
    hardware: 'Hardware',
    power: 'Power',
    hosting: 'Hosting',
    subscription: 'Subscription',
    other: 'Other',
};
const PERIOD_LABELS: Record<PoolPeriod, string> = {
    hour: 'an hour',
    day: 'a day',
    month: 'a month',
    year: 'a year',
};

const field = 'grid min-w-0 gap-1.5 text-sm';
/** A non-negative number from a field, or null when it isn't one. */
const amountOf = (raw: string) => {
    const value = Number(raw);
    return raw.trim() !== '' && Number.isFinite(value) && value >= 0 ? value : null;
};

function ErrorLine({ error }: { error: string }) {
    return error ? (
        <p role="alert" className="m-0 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {error}
        </p>
    ) : null;
}

/** Runs a change, tells how it went, and reads the prices again. */
function useChange(reload: Reload) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const run = async (work: () => Promise<unknown>, done: string) => {
        setBusy(true);
        setError('');
        try {
            await work();
            toast.success(done);
            await reload();
            return true;
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not save.');
            return false;
        } finally {
            setBusy(false);
        }
    };
    return { busy, error, run };
}

/** What a pool costs, in a phrase. */
function poolTerms(pool: CostPool) {
    if (pool.kind === 'variable') {
        return `${formatUsd(pool.amount)} a unit, from meter readings`;
    }
    if (pool.depreciationMonths) {
        return `${formatUsd(pool.amount)} written off over ${pool.depreciationMonths} months`;
    }
    return `${formatUsd(pool.amount)} ${PERIOD_LABELS[pool.period]}`;
}

/**
 * Cost pools (CB-196): what self-hosted backends and subscriptions cost
 * over the range, what their turns took and what idled, with the forms
 * to add, change and remove them and a metered pool's readings.
 */
export function CostPools({
    view,
    pools,
    loaded,
    reload,
}: {
    view: PricingView | undefined;
    pools: OpsCostPool[] | undefined;
    loaded: boolean;
    reload: Reload;
}) {
    const [editing, setEditing] = useState<CostPool | 'new'>();
    const [metering, setMetering] = useState<string>();
    const change = useChange(reload);
    const numbers = new Map((pools ?? []).map((pool) => [pool.poolId, pool]));
    const labels = new Map((view?.backends ?? []).map((backend) => [backend.id, backend.label]));
    return (
        <Card className="min-w-0 gap-4" data-slot="ops-cost-pools">
            <CardHeader>
                <CardTitle>Cost pools</CardTitle>
                <CardDescription>
                    What self-hosted backends and subscriptions cost: each hour’s cost is shared among that hour’s turns
                    on the pool’s backends by weighted tokens; hours without turns are idle capacity. Pools are the
                    workspace’s, whatever the filters. Subscription pools are estimates.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
                <ErrorLine error={change.error} />
                {!view ? (
                    <Skeleton className="h-24 w-full" />
                ) : view.pools.length ? (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Pool</TableHead>
                                <TableHead className="text-right">Cost</TableHead>
                                <TableHead className="text-right">Turns took</TableHead>
                                <TableHead className="text-right">Idle</TableHead>
                                <TableHead>
                                    <span className="sr-only">Actions</span>
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {view.pools.map((pool) => {
                                const row = numbers.get(pool.id);
                                return (
                                    <TableRow key={pool.id} data-pool={pool.id}>
                                        <TableCell className="max-w-72 align-top">
                                            <div className="flex flex-wrap items-center gap-1.5">
                                                <span className="font-medium">{pool.name}</span>
                                                <Badge variant="outline">{CATEGORY_LABELS[pool.category]}</Badge>
                                                {pool.category === 'subscription' && (
                                                    <Badge variant="secondary">Estimate</Badge>
                                                )}
                                                {pool.allocation === 'gpu_seconds' && (
                                                    <Badge variant="secondary">By GPU time: no meter yet</Badge>
                                                )}
                                            </div>
                                            <div className="text-xs text-muted-foreground">
                                                {poolTerms(pool)} ·{' '}
                                                {pool.backendIds.length
                                                    ? pool.backendIds.map((id) => labels.get(id) ?? id).join(', ')
                                                    : 'no backends'}
                                            </div>
                                        </TableCell>
                                        <TableCell className="text-right align-top tabular-nums">
                                            {loaded ? formatUsd(row?.costUsd ?? 0) : '–'}
                                        </TableCell>
                                        <TableCell className="text-right align-top tabular-nums">
                                            {loaded ? formatUsd(row?.allocatedUsd ?? 0) : '–'}
                                        </TableCell>
                                        <TableCell className="text-right align-top tabular-nums">
                                            {loaded ? formatUsd(row?.idleUsd ?? 0) : '–'}
                                        </TableCell>
                                        <TableCell className="align-top">
                                            <div className="flex flex-wrap justify-end gap-1">
                                                {pool.kind === 'variable' && (
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={() =>
                                                            setMetering(metering === pool.id ? undefined : pool.id)
                                                        }
                                                    >
                                                        Readings
                                                    </Button>
                                                )}
                                                <Button size="sm" variant="ghost" onClick={() => setEditing(pool)}>
                                                    Edit
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    disabled={change.busy}
                                                    onClick={() =>
                                                        void change.run(
                                                            () =>
                                                                api(
                                                                    `/operations/pricing/pools/${encodeURIComponent(pool.id)}`,
                                                                    'DELETE',
                                                                ),
                                                            'Cost pool removed',
                                                        )
                                                    }
                                                >
                                                    Remove
                                                </Button>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                ) : (
                    <p className="m-0 text-sm text-muted-foreground">
                        No cost pools yet. Add one for a self-hosted backend (its hardware, power, hosting) or for
                        ChatGPT subscriptions.
                    </p>
                )}
                {view && metering && (
                    <Readings view={view} pool={view.pools.find((pool) => pool.id === metering)} reload={reload} />
                )}
                {view && editing ? (
                    <PoolForm
                        view={view}
                        pool={editing === 'new' ? undefined : editing}
                        done={() => setEditing(undefined)}
                        reload={reload}
                    />
                ) : (
                    view && (
                        <div>
                            <Button variant="outline" onClick={() => setEditing('new')}>
                                Add a cost pool
                            </Button>
                        </div>
                    )
                )}
            </CardContent>
        </Card>
    );
}

function PoolForm({
    view,
    pool,
    done,
    reload,
}: {
    view: PricingView;
    pool: CostPool | undefined;
    done: () => void;
    reload: Reload;
}) {
    const [name, setName] = useState(pool?.name ?? '');
    const [category, setCategory] = useState<PoolCategory>(pool?.category ?? 'hardware');
    const [metered, setMetered] = useState(pool?.kind === 'variable');
    const [amount, setAmount] = useState(pool ? String(pool.amount) : '');
    const [period, setPeriod] = useState<PoolPeriod>(pool?.period ?? 'month');
    const [months, setMonths] = useState(pool?.depreciationMonths ? String(pool.depreciationMonths) : '');
    const [starts, setStarts] = useState(dayInput(pool?.startsAt ?? Date.now()));
    const [ends, setEnds] = useState(pool?.endsAt ? dayInput(pool.endsAt) : '');
    const [backends, setBackends] = useState<string[]>(pool?.backendIds ?? []);
    const weightsOf = pool?.weights ?? DEFAULT_POOL_WEIGHTS;
    const [weights, setWeights] = useState({
        input: String(weightsOf.input),
        cached: String(weightsOf.cached),
        output: String(weightsOf.output),
    });
    const change = useChange(reload);
    const startsAt = dayOf(starts);
    const endsAt = ends ? dayOf(ends) : null;
    const value = amountOf(amount);
    const depreciation = !metered && months.trim() ? Number(months) : null;
    const weightValues = {
        input: amountOf(weights.input),
        cached: amountOf(weights.cached),
        output: amountOf(weights.output),
    };
    const valid =
        name.trim() !== '' &&
        value !== null &&
        startsAt !== null &&
        (endsAt === null || endsAt > startsAt) &&
        (depreciation === null || (Number.isInteger(depreciation) && depreciation >= 1 && depreciation <= 600)) &&
        Object.values(weightValues).every((weight) => weight !== null);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!valid) {
            return;
        }
        const body = {
            name: name.trim(),
            kind: metered ? 'variable' : 'fixed',
            category,
            amount: value,
            period,
            depreciationMonths: depreciation,
            startsAt,
            endsAt,
            backendIds: backends,
            allocation: pool?.allocation ?? 'tokens',
            weights: weightValues,
        };
        const saved = await change.run(
            () =>
                pool
                    ? api(`/operations/pricing/pools/${encodeURIComponent(pool.id)}`, 'PUT', body)
                    : api('/operations/pricing/pools', 'POST', body),
            pool ? 'Cost pool saved' : 'Cost pool added',
        );
        if (saved) {
            done();
        }
    };
    return (
        <form
            className="grid gap-4 rounded-lg border p-4"
            data-slot="ops-pool-form"
            onSubmit={(event) => void submit(event)}
        >
            <h3 className="m-0 font-medium">{pool ? `Change ${pool.name}` : 'New cost pool'}</h3>
            <div className="grid gap-4 sm:grid-cols-2">
                <label className={field}>
                    Name
                    <Input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
                </label>
                <div className={field}>
                    <span id="pool-category">Category</span>
                    <Select value={category} onValueChange={(next) => setCategory(next as PoolCategory)}>
                        <SelectTrigger aria-labelledby="pool-category">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {POOL_CATEGORIES.map((item) => (
                                <SelectItem key={item} value={item}>
                                    {CATEGORY_LABELS[item]}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                    <Checkbox checked={metered} onCheckedChange={(checked) => setMetered(checked === true)} />
                    Metered: its cost comes from meter readings (power, for one)
                </label>
                <label className={field}>
                    {metered
                        ? 'US dollars a unit (unless a reading says)'
                        : depreciation
                          ? 'Purchase price, US dollars'
                          : 'US dollars'}
                    <Input
                        inputMode="decimal"
                        value={amount}
                        aria-invalid={!!amount && value === null}
                        onChange={(event) => setAmount(event.target.value.trim())}
                    />
                </label>
                {!metered && (
                    <>
                        <div className={field}>
                            <span id="pool-period">Per</span>
                            <Select
                                value={period}
                                disabled={!!depreciation}
                                onValueChange={(next) => setPeriod(next as PoolPeriod)}
                            >
                                <SelectTrigger aria-labelledby="pool-period">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {POOL_PERIODS.map((item) => (
                                        <SelectItem key={item} value={item}>
                                            {item}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <label className={field}>
                            Write off over months (a purchase; empty for a running cost)
                            <Input
                                inputMode="numeric"
                                value={months}
                                onChange={(event) => setMonths(event.target.value.trim())}
                            />
                        </label>
                    </>
                )}
                <label className={field}>
                    From (UTC)
                    <Input type="date" value={starts} onChange={(event) => setStarts(event.target.value)} />
                </label>
                <label className={field}>
                    Until (UTC, optional)
                    <Input
                        type="date"
                        value={ends}
                        aria-invalid={endsAt !== null && startsAt !== null && endsAt <= startsAt}
                        onChange={(event) => setEnds(event.target.value)}
                    />
                </label>
            </div>
            <fieldset className="m-0 grid gap-2 border-0 p-0">
                <legend className="mb-1 text-sm font-medium">Backends it pays for</legend>
                {view.backends.length ? (
                    view.backends.map((backend) => (
                        <label key={backend.id} className="flex items-center gap-2 text-sm">
                            <Checkbox
                                checked={backends.includes(backend.id)}
                                onCheckedChange={(checked) =>
                                    setBackends(
                                        checked === true
                                            ? [...backends, backend.id]
                                            : backends.filter((id) => id !== backend.id),
                                    )
                                }
                            />
                            <span className="min-w-0 truncate">
                                {backend.label}{' '}
                                <span className="text-muted-foreground">
                                    ({backend.provider}
                                    {backend.model ? `, ${backend.model}` : ''})
                                </span>
                            </span>
                        </label>
                    ))
                ) : (
                    <p className="m-0 text-sm text-muted-foreground">No backends yet: add one on the Platform page.</p>
                )}
            </fieldset>
            <fieldset className="m-0 grid gap-2 border-0 p-0">
                <legend className="mb-1 text-sm font-medium">Token weights for sharing an hour</legend>
                <div className="grid grid-cols-3 gap-3">
                    {(['input', 'cached', 'output'] as const).map((key) => (
                        <label key={key} className={field}>
                            {key === 'input' ? 'Input' : key === 'cached' ? 'Cached input' : 'Output'}
                            <Input
                                inputMode="decimal"
                                value={weights[key]}
                                aria-invalid={weightValues[key] === null}
                                onChange={(event) => setWeights({ ...weights, [key]: event.target.value.trim() })}
                            />
                        </label>
                    ))}
                </div>
            </fieldset>
            <ErrorLine error={change.error} />
            <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={!valid || change.busy}>
                    {pool ? 'Save' : 'Add'}
                </Button>
                <Button type="button" variant="outline" onClick={done}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}

/** A metered pool's readings, newest first, and a form for the next one. */
function Readings({ view, pool, reload }: { view: PricingView; pool: CostPool | undefined; reload: Reload }) {
    const { timeZone } = useOpsSettings();
    const [at, setAt] = useState(dayInput(Date.now()));
    const [quantity, setQuantity] = useState('');
    const [unit, setUnit] = useState('kWh');
    const [unitPrice, setUnitPrice] = useState('');
    const change = useChange(reload);
    if (!pool) {
        return null;
    }
    const readings = view.readings.filter((reading) => reading.poolId === pool.id);
    const when = dayOf(at);
    const amount = amountOf(quantity);
    const price = unitPrice.trim() ? amountOf(unitPrice) : null;
    const valid = when !== null && amount !== null && unit.trim() !== '' && (unitPrice.trim() === '' || price !== null);
    return (
        <div className="grid gap-3 rounded-lg border p-4" data-slot="ops-readings">
            <h3 className="m-0 font-medium">{pool.name}: meter readings</h3>
            <p className="m-0 text-sm text-muted-foreground">
                Each reading is what was used since the one before (or since the pool started), spread evenly over that
                time.
            </p>
            {readings.length > 0 && (
                <ul className="m-0 grid list-none gap-1 p-0 text-sm">
                    {readings.map((reading) => (
                        <li key={reading.id} className="flex flex-wrap items-center gap-2">
                            <span className="tabular-nums">{formatWhen(reading.at, timeZone)}</span>
                            <span>
                                {formatNumber(reading.quantity)} {reading.unit} at{' '}
                                {formatUsd(reading.unitPrice ?? pool.amount)}
                            </span>
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={change.busy}
                                onClick={() =>
                                    void change.run(
                                        () =>
                                            api(
                                                `/operations/pricing/readings/${encodeURIComponent(reading.id)}`,
                                                'DELETE',
                                            ),
                                        'Reading removed',
                                    )
                                }
                            >
                                Remove
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            <form
                className="grid gap-3 sm:grid-cols-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (!valid) {
                        return;
                    }
                    void change
                        .run(
                            () =>
                                api(`/operations/pricing/pools/${encodeURIComponent(pool.id)}/readings`, 'POST', {
                                    at: when,
                                    quantity: amount,
                                    unit: unit.trim(),
                                    unitPrice: price,
                                }),
                            'Reading added',
                        )
                        .then((saved) => saved && setQuantity(''));
                }}
            >
                <label className={field}>
                    Read on (UTC)
                    <Input type="date" value={at} onChange={(event) => setAt(event.target.value)} />
                </label>
                <label className={field}>
                    Used
                    <Input
                        inputMode="decimal"
                        value={quantity}
                        onChange={(event) => setQuantity(event.target.value.trim())}
                    />
                </label>
                <label className={field}>
                    Unit
                    <Input value={unit} maxLength={32} onChange={(event) => setUnit(event.target.value)} />
                </label>
                <label className={field}>
                    US dollars a unit (optional)
                    <Input
                        inputMode="decimal"
                        value={unitPrice}
                        placeholder={String(pool.amount)}
                        onChange={(event) => setUnitPrice(event.target.value.trim())}
                    />
                </label>
                <ErrorLine error={change.error} />
                <div className="sm:col-span-4">
                    <Button type="submit" disabled={!valid || change.busy}>
                        Add reading
                    </Button>
                </div>
            </form>
        </div>
    );
}

/**
 * The daily price sync's state (CB-195): on or off (switched in
 * Settings), each source's last run, and "Sync now".
 */
export function PriceSyncStatus({ view, reload }: { view: PricingView | undefined; reload: Reload }) {
    const { timeZone } = useOpsSettings();
    const change = useChange(reload);
    const sync = view?.sync;
    const runs = new Map((sync?.runs ?? []).map((run) => [run.source, run]));
    return (
        <Card className="min-w-0 gap-4" data-slot="ops-price-sync">
            <CardHeader>
                <CardTitle>Price sync</CardTitle>
                <CardDescription>
                    {sync ? (
                        sync.enabled ? (
                            <>
                                On: once a day Socio reads providers’ and community price lists and keeps the prices of
                                the {formatNumber(sync.watched.length)} models in use. The requests carry nothing about
                                this workspace.{' '}
                            </>
                        ) : (
                            <>
                                Off: Socio reads no price lists, and turns are priced only by the prices it already has
                                and admins’ own.{' '}
                            </>
                        )
                    ) : null}
                    <Link to={opsPath('settings')} className="underline">
                        Switch it in Settings
                    </Link>
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
                <ErrorLine error={change.error} />
                {!sync ? (
                    <Skeleton className="h-24 w-full" />
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>List</TableHead>
                                <TableHead>Last read</TableHead>
                                <TableHead className="text-right">Models kept</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {Object.entries(PRICE_SOURCES).map(([id, source]) => {
                                const run = runs.get(id as keyof typeof PRICE_SOURCES);
                                return (
                                    <TableRow key={id} data-source={id}>
                                        <TableCell className="font-medium">{source.label}</TableCell>
                                        <TableCell>
                                            {run ? (
                                                <>
                                                    {formatWhen(run.at, timeZone)}{' '}
                                                    {run.ok ? null : (
                                                        <Badge variant="destructive">Failed: {run.error}</Badge>
                                                    )}
                                                </>
                                            ) : (
                                                'Never'
                                            )}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {run?.ok
                                                ? `${formatNumber(run.matched)} of ${formatNumber(run.fetched)}`
                                                : '–'}
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                )}
                {sync?.enabled && (
                    <div className="flex flex-wrap items-center gap-3">
                        <Button
                            variant="outline"
                            disabled={change.busy || sync.running}
                            onClick={() =>
                                void change.run(
                                    () => api<PriceSyncView>('/operations/pricing/sync', 'POST', {}),
                                    'Price sync started',
                                )
                            }
                        >
                            {sync.running ? 'Syncing…' : 'Sync now'}
                        </Button>
                        {sync.nextAt !== null && !sync.running && (
                            <span className="text-sm text-muted-foreground">
                                Next: {formatWhen(Math.max(sync.nextAt, Date.now()), timeZone)}
                            </span>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

/**
 * The prices Socio keeps (CB-195): synced ones, and admins’, which win
 * from their date onward; a form for an admin’s price.
 */
export function Prices({
    view,
    error,
    reload,
    prefill,
}: {
    view: PricingView | undefined;
    error: string;
    reload: Reload;
    prefill?: { model: string; provider: string };
}) {
    const { timeZone } = useOpsSettings();
    const [filter, setFilter] = useState('');
    const change = useChange(reload);
    const wanted = filter.trim().toLowerCase();
    const prices = (view?.prices ?? [])
        .filter(
            (price) =>
                !wanted || price.model.toLowerCase().includes(wanted) || price.provider.toLowerCase().includes(wanted),
        )
        .sort(
            (a, b) =>
                compareText(a.model, b.model) ||
                compareText(a.provider, b.provider) ||
                b.effectiveFrom - a.effectiveFrom,
        );
    return (
        <Card className="min-w-0 gap-4" data-slot="ops-prices">
            <CardHeader>
                <CardTitle>Prices</CardTitle>
                <CardDescription>
                    US dollars per million tokens. A turn takes its provider’s price in force when it started: an
                    admin’s from its date onward, then the provider’s own list, then a community list. Provider * holds
                    for every provider, such as a self-hosted one.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
                <ErrorLine error={error || change.error} />
                <label className="grid max-w-sm gap-1.5 text-sm">
                    Find a model or provider
                    <Input value={filter} onChange={(event) => setFilter(event.target.value)} />
                </label>
                {!view ? (
                    <Skeleton className="h-24 w-full" />
                ) : prices.length ? (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Model</TableHead>
                                <TableHead>Provider</TableHead>
                                <TableHead className="text-right">Input</TableHead>
                                <TableHead className="text-right">Cached</TableHead>
                                <TableHead className="text-right">Output</TableHead>
                                <TableHead>From</TableHead>
                                <TableHead>Source</TableHead>
                                <TableHead>
                                    <span className="sr-only">Actions</span>
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {prices.slice(0, 200).map((price) => (
                                <TableRow key={price.id} data-price={price.id}>
                                    <TableCell className="max-w-56 truncate font-medium">{price.model}</TableCell>
                                    <TableCell>{price.provider}</TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {formatPerM(price.inputPerM)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {formatPerM(price.cachedInputPerM)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {formatPerM(price.outputPerM)}
                                    </TableCell>
                                    <TableCell className="tabular-nums">
                                        {formatWhen(price.effectiveFrom, timeZone)}
                                    </TableCell>
                                    <TableCell>{originLabel(price.source)}</TableCell>
                                    <TableCell>
                                        {price.source === 'admin' && (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                disabled={change.busy}
                                                onClick={() =>
                                                    void change.run(
                                                        () =>
                                                            api(
                                                                `/operations/pricing/prices/${encodeURIComponent(price.id)}`,
                                                                'DELETE',
                                                            ),
                                                        'Price removed',
                                                    )
                                                }
                                            >
                                                Remove
                                            </Button>
                                        )}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                ) : (
                    <p className="m-0 text-sm text-muted-foreground">
                        {wanted ? 'No price matches.' : 'No prices yet. Turn the price sync on, or add a price.'}
                    </p>
                )}
                {view && <PriceForm reload={reload} prefill={prefill} />}
            </CardContent>
        </Card>
    );
}

function PriceForm({ reload, prefill }: { reload: Reload; prefill?: { model: string; provider: string } }) {
    const [provider, setProvider] = useState('*');
    const [model, setModel] = useState('');
    const [input, setInput] = useState('');
    const [cached, setCached] = useState('');
    const [output, setOutput] = useState('');
    const [from, setFrom] = useState(dayInput(Date.now()));
    const change = useChange(reload);
    useEffect(() => {
        if (!prefill) {
            return;
        }
        setModel(prefill.model);
        setProvider(prefill.provider);
    }, [prefill]);
    const inputPerM = amountOf(input);
    const outputPerM = amountOf(output);
    const cachedPerM = cached.trim() ? amountOf(cached) : null;
    const effectiveFrom = dayOf(from);
    const valid =
        /^[\w.*:@+-]{1,64}$/.test(provider.trim()) &&
        model.trim() !== '' &&
        inputPerM !== null &&
        outputPerM !== null &&
        (cached.trim() === '' || cachedPerM !== null) &&
        effectiveFrom !== null;
    return (
        <form
            className="grid gap-3 rounded-lg border p-4"
            data-slot="ops-price-form"
            onSubmit={(event) => {
                event.preventDefault();
                if (!valid) {
                    return;
                }
                void change
                    .run(
                        () =>
                            api('/operations/pricing/prices', 'POST', {
                                provider: provider.trim(),
                                model: model.trim(),
                                inputPerM,
                                cachedInputPerM: cachedPerM,
                                outputPerM,
                                reasoningPerM: null,
                                effectiveFrom,
                            }),
                        'Price saved',
                    )
                    .then((saved) => {
                        if (saved) {
                            setInput('');
                            setCached('');
                            setOutput('');
                        }
                    });
            }}
        >
            <h3 className="m-0 font-medium">Add a price</h3>
            <div className="grid gap-3 sm:grid-cols-3">
                <label className={field}>
                    Model
                    <Input value={model} maxLength={200} onChange={(event) => setModel(event.target.value)} />
                </label>
                <label className={field}>
                    Provider (* for any)
                    <Input value={provider} maxLength={64} onChange={(event) => setProvider(event.target.value)} />
                </label>
                <label className={field}>
                    From (UTC)
                    <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
                </label>
                <label className={field}>
                    Input, $ per million
                    <Input
                        inputMode="decimal"
                        value={input}
                        onChange={(event) => setInput(event.target.value.trim())}
                    />
                </label>
                <label className={field}>
                    Cached input (optional)
                    <Input
                        inputMode="decimal"
                        value={cached}
                        onChange={(event) => setCached(event.target.value.trim())}
                    />
                </label>
                <label className={field}>
                    Output, $ per million
                    <Input
                        inputMode="decimal"
                        value={output}
                        onChange={(event) => setOutput(event.target.value.trim())}
                    />
                </label>
            </div>
            <ErrorLine error={change.error} />
            <div>
                <Button type="submit" disabled={!valid || change.busy}>
                    Save price
                </Button>
            </div>
        </form>
    );
}
