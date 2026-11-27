import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import { compareText } from '@socio/shared/locale';
import {
    DEFAULT_POOL_WEIGHTS,
    POOL_CATEGORIES,
    POOL_PERIODS,
    PRICE_SOURCE_IDS,
    type CostPool,
    type OpsCostPool,
    type PoolCategory,
    type PoolPeriod,
    type PriceSyncView,
    type PricingView,
} from '@socio/shared/operations/operations-cost';

import { onDemand } from '../../i18n/on-demand';
import { api } from '../../lib/api';

import { dayInput, dayOf, formatUsd, useFormatPerM, useOriginLabel } from './cost-format';
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
    const { t } = useTranslation(['operations.cost-admin']);
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
            setError(e instanceof Error ? e.message : t('operations.cost-admin:save-failed'));
            return false;
        } finally {
            setBusy(false);
        }
    };
    return { busy, error, run };
}

/** What a pool costs, in a phrase. */
function usePoolTerms() {
    const { t } = useTranslation(['operations.cost-admin']);
    return (pool: CostPool) => {
        const amount = formatUsd(pool.amount);
        if (pool.kind === 'variable') {
            return t('operations.cost-admin:pools.terms.variable', { amount });
        }
        if (pool.depreciationMonths) {
            return t('operations.cost-admin:pools.terms.depreciated', { amount, count: pool.depreciationMonths });
        }
        return t('operations.cost-admin:pools.terms.per', { amount, context: pool.period });
    };
}

/**
 * Cost pools (CB-196): what self-hosted backends and subscriptions cost
 * over the range, what their turns took and what idled, with the forms
 * to add, change and remove them and a metered pool's readings.
 */
function CostPoolsCard({
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
    const { t } = useTranslation(['operations.cost-admin']);
    const poolTerms = usePoolTerms();
    const [editing, setEditing] = useState<CostPool | 'new'>();
    const [metering, setMetering] = useState<string>();
    const change = useChange(reload);
    const numbers = new Map((pools ?? []).map((pool) => [pool.poolId, pool]));
    const labels = new Map((view?.backends ?? []).map((backend) => [backend.id, backend.label]));
    return (
        <Card className="min-w-0 gap-4" data-slot="ops-cost-pools">
            <CardHeader>
                <CardTitle>{t('operations.cost-admin:pools.title')}</CardTitle>
                <CardDescription>{t('operations.cost-admin:pools.description')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
                <ErrorLine error={change.error} />
                {!view ? (
                    <Skeleton className="h-24 w-full" />
                ) : view.pools.length ? (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t('operations.cost-admin:pools.pool')}</TableHead>
                                <TableHead className="text-right">{t('operations.cost-admin:pools.cost')}</TableHead>
                                <TableHead className="text-right">{t('operations.cost-admin:pools.took')}</TableHead>
                                <TableHead className="text-right">{t('operations.cost-admin:pools.idle')}</TableHead>
                                <TableHead>
                                    <span className="sr-only">{t('operations.cost-admin:actions')}</span>
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
                                                <Badge variant="outline">
                                                    {t(`operations.cost-admin:categories.${pool.category}`)}
                                                </Badge>
                                                {pool.category === 'subscription' && (
                                                    <Badge variant="secondary">
                                                        {t('operations.cost-admin:pools.estimate')}
                                                    </Badge>
                                                )}
                                                {pool.allocation === 'gpu_seconds' && (
                                                    <Badge variant="secondary">
                                                        {t('operations.cost-admin:pools.gpu')}
                                                    </Badge>
                                                )}
                                            </div>
                                            <div className="text-xs text-muted-foreground">
                                                {poolTerms(pool)} ·{' '}
                                                {pool.backendIds.length
                                                    ? pool.backendIds.map((id) => labels.get(id) ?? id).join(', ')
                                                    : t('operations.cost-admin:pools.no-backends')}
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
                                                        {t('operations.cost-admin:pools.readings')}
                                                    </Button>
                                                )}
                                                <Button size="sm" variant="ghost" onClick={() => setEditing(pool)}>
                                                    {t('operations.cost-admin:pools.edit')}
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
                                                            t('operations.cost-admin:pools.removed'),
                                                        )
                                                    }
                                                >
                                                    {t('operations.cost-admin:remove')}
                                                </Button>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                ) : (
                    <p className="m-0 text-sm text-muted-foreground">{t('operations.cost-admin:pools.none')}</p>
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
                                {t('operations.cost-admin:pools.add')}
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
    const { t } = useTranslation(['operations.cost-admin']);
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
            pool ? t('operations.cost-admin:pool-form.saved') : t('operations.cost-admin:pool-form.added'),
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
            <h3 className="m-0 font-medium">
                {pool
                    ? t('operations.cost-admin:pool-form.change', { name: pool.name })
                    : t('operations.cost-admin:pool-form.new')}
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
                <label className={field}>
                    {t('operations.cost-admin:pool-form.name')}
                    <Input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
                </label>
                <div className={field}>
                    <span id="pool-category">{t('operations.cost-admin:pool-form.category')}</span>
                    <Select value={category} onValueChange={(next) => setCategory(next as PoolCategory)}>
                        <SelectTrigger aria-labelledby="pool-category">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {POOL_CATEGORIES.map((item) => (
                                <SelectItem key={item} value={item}>
                                    {t(`operations.cost-admin:categories.${item}`)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                    <Checkbox checked={metered} onCheckedChange={(checked) => setMetered(checked === true)} />
                    {t('operations.cost-admin:pool-form.metered')}
                </label>
                <label className={field}>
                    {t('operations.cost-admin:pool-form.amount', {
                        context: metered ? 'metered' : depreciation ? 'purchase' : undefined,
                    })}
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
                            <span id="pool-period">{t('operations.cost-admin:pool-form.per')}</span>
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
                                            {t(`operations.cost-admin:periods.${item}`)}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <label className={field}>
                            {t('operations.cost-admin:pool-form.months')}
                            <Input
                                inputMode="numeric"
                                value={months}
                                onChange={(event) => setMonths(event.target.value.trim())}
                            />
                        </label>
                    </>
                )}
                <label className={field}>
                    {t('operations.cost-admin:pool-form.from')}
                    <Input type="date" value={starts} onChange={(event) => setStarts(event.target.value)} />
                </label>
                <label className={field}>
                    {t('operations.cost-admin:pool-form.until')}
                    <Input
                        type="date"
                        value={ends}
                        aria-invalid={endsAt !== null && startsAt !== null && endsAt <= startsAt}
                        onChange={(event) => setEnds(event.target.value)}
                    />
                </label>
            </div>
            <fieldset className="m-0 grid gap-2 border-0 p-0">
                <legend className="mb-1 text-sm font-medium">{t('operations.cost-admin:pool-form.backends')}</legend>
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
                    <p className="m-0 text-sm text-muted-foreground">
                        {t('operations.cost-admin:pool-form.no-backends')}
                    </p>
                )}
            </fieldset>
            <fieldset className="m-0 grid gap-2 border-0 p-0">
                <legend className="mb-1 text-sm font-medium">{t('operations.cost-admin:pool-form.weights')}</legend>
                <div className="grid grid-cols-3 gap-3">
                    {(['input', 'cached', 'output'] as const).map((key) => (
                        <label key={key} className={field}>
                            {t(`operations.cost-admin:pool-form.${key}`)}
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
                    {pool ? t('operations.cost-admin:pool-form.save') : t('operations.cost-admin:pool-form.add')}
                </Button>
                <Button type="button" variant="outline" onClick={done}>
                    {t('operations.cost-admin:pool-form.cancel')}
                </Button>
            </div>
        </form>
    );
}

/** A metered pool's readings, newest first, and a form for the next one. */
function Readings({ view, pool, reload }: { view: PricingView; pool: CostPool | undefined; reload: Reload }) {
    const { t } = useTranslation(['operations.cost-admin']);
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
            <h3 className="m-0 font-medium">{t('operations.cost-admin:readings.title', { name: pool.name })}</h3>
            <p className="m-0 text-sm text-muted-foreground">{t('operations.cost-admin:readings.description')}</p>
            {readings.length > 0 && (
                <ul className="m-0 grid list-none gap-1 p-0 text-sm">
                    {readings.map((reading) => (
                        <li key={reading.id} className="flex flex-wrap items-center gap-2">
                            <span className="tabular-nums">{formatWhen(reading.at, timeZone)}</span>
                            <span>
                                {t('operations.cost-admin:readings.reading', {
                                    quantity: reading.quantity,
                                    measure: reading.unit,
                                    price: formatUsd(reading.unitPrice ?? pool.amount),
                                })}
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
                                        t('operations.cost-admin:readings.removed'),
                                    )
                                }
                            >
                                {t('operations.cost-admin:remove')}
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
                            t('operations.cost-admin:readings.added'),
                        )
                        .then((saved) => saved && setQuantity(''));
                }}
            >
                <label className={field}>
                    {t('operations.cost-admin:readings.read-on')}
                    <Input type="date" value={at} onChange={(event) => setAt(event.target.value)} />
                </label>
                <label className={field}>
                    {t('operations.cost-admin:readings.used')}
                    <Input
                        inputMode="decimal"
                        value={quantity}
                        onChange={(event) => setQuantity(event.target.value.trim())}
                    />
                </label>
                <label className={field}>
                    {t('operations.cost-admin:readings.unit')}
                    <Input value={unit} maxLength={32} onChange={(event) => setUnit(event.target.value)} />
                </label>
                <label className={field}>
                    {t('operations.cost-admin:readings.unit-price')}
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
                        {t('operations.cost-admin:readings.add')}
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
function PriceSyncCard({ view, reload }: { view: PricingView | undefined; reload: Reload }) {
    const { t } = useTranslation(['operations.cost-admin']);
    const { timeZone } = useOpsSettings();
    const change = useChange(reload);
    const sync = view?.sync;
    const runs = new Map((sync?.runs ?? []).map((run) => [run.source, run]));
    return (
        <Card className="min-w-0 gap-4" data-slot="ops-price-sync">
            <CardHeader>
                <CardTitle>{t('operations.cost-admin:sync.title')}</CardTitle>
                <CardDescription>
                    {sync ? (
                        <>
                            {sync.enabled
                                ? t('operations.cost-admin:sync.on', { count: sync.watched.length })
                                : t('operations.cost-admin:sync.off')}{' '}
                        </>
                    ) : null}
                    <Link to={opsPath('settings')} className="underline">
                        {t('operations.cost-admin:sync.switch')}
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
                                <TableHead>{t('operations.cost-admin:sync.list')}</TableHead>
                                <TableHead>{t('operations.cost-admin:sync.last-read')}</TableHead>
                                <TableHead className="text-right">{t('operations.cost-admin:sync.kept')}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {PRICE_SOURCE_IDS.map((id) => {
                                const run = runs.get(id);
                                return (
                                    <TableRow key={id} data-source={id}>
                                        <TableCell className="font-medium">
                                            {t(`operations.cost-admin:sources.${id}`)}
                                        </TableCell>
                                        <TableCell>
                                            {run ? (
                                                <>
                                                    {formatWhen(run.at, timeZone)}{' '}
                                                    {run.ok ? null : (
                                                        <Badge variant="destructive">
                                                            {t('operations.cost-admin:sync.failed', {
                                                                error: run.error ?? '',
                                                            })}
                                                        </Badge>
                                                    )}
                                                </>
                                            ) : (
                                                t('operations.cost-admin:sync.never')
                                            )}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {run?.ok
                                                ? t('operations.cost-admin:sync.matched', {
                                                      matched: run.matched,
                                                      fetched: run.fetched,
                                                  })
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
                                    t('operations.cost-admin:sync.started'),
                                )
                            }
                        >
                            {sync.running
                                ? t('operations.cost-admin:sync.syncing')
                                : t('operations.cost-admin:sync.now')}
                        </Button>
                        {sync.nextAt !== null && !sync.running && (
                            <span className="text-sm text-muted-foreground">
                                {t('operations.cost-admin:sync.next', {
                                    when: formatWhen(Math.max(sync.nextAt, Date.now()), timeZone),
                                })}
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
function PricesCard({
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
    const { t } = useTranslation(['operations.cost-admin']);
    const formatPerM = useFormatPerM();
    const originLabel = useOriginLabel();
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
                <CardTitle>{t('operations.cost-admin:prices.title')}</CardTitle>
                <CardDescription>{t('operations.cost-admin:prices.description')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
                <ErrorLine error={error || change.error} />
                <label className="grid max-w-sm gap-1.5 text-sm">
                    {t('operations.cost-admin:prices.find')}
                    <Input value={filter} onChange={(event) => setFilter(event.target.value)} />
                </label>
                {!view ? (
                    <Skeleton className="h-24 w-full" />
                ) : prices.length ? (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t('operations.cost-admin:prices.model')}</TableHead>
                                <TableHead>{t('operations.cost-admin:prices.provider')}</TableHead>
                                <TableHead className="text-right">{t('operations.cost-admin:prices.input')}</TableHead>
                                <TableHead className="text-right">{t('operations.cost-admin:prices.cached')}</TableHead>
                                <TableHead className="text-right">{t('operations.cost-admin:prices.output')}</TableHead>
                                <TableHead>{t('operations.cost-admin:prices.from')}</TableHead>
                                <TableHead>{t('operations.cost-admin:prices.source')}</TableHead>
                                <TableHead>
                                    <span className="sr-only">{t('operations.cost-admin:actions')}</span>
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
                                                        t('operations.cost-admin:prices.removed'),
                                                    )
                                                }
                                            >
                                                {t('operations.cost-admin:remove')}
                                            </Button>
                                        )}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                ) : (
                    <p className="m-0 text-sm text-muted-foreground">
                        {wanted ? t('operations.cost-admin:prices.no-match') : t('operations.cost-admin:prices.none')}
                    </p>
                )}
                {view && <PriceForm reload={reload} prefill={prefill} />}
            </CardContent>
        </Card>
    );
}

function PriceForm({ reload, prefill }: { reload: Reload; prefill?: { model: string; provider: string } }) {
    const { t } = useTranslation(['operations.cost-admin']);
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
                        t('operations.cost-admin:price-form.saved'),
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
            <h3 className="m-0 font-medium">{t('operations.cost-admin:price-form.title')}</h3>
            <div className="grid gap-3 sm:grid-cols-3">
                <label className={field}>
                    {t('operations.cost-admin:price-form.model')}
                    <Input value={model} maxLength={200} onChange={(event) => setModel(event.target.value)} />
                </label>
                <label className={field}>
                    {t('operations.cost-admin:price-form.provider')}
                    <Input value={provider} maxLength={64} onChange={(event) => setProvider(event.target.value)} />
                </label>
                <label className={field}>
                    {t('operations.cost-admin:price-form.from')}
                    <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
                </label>
                <label className={field}>
                    {t('operations.cost-admin:price-form.input')}
                    <Input
                        inputMode="decimal"
                        value={input}
                        onChange={(event) => setInput(event.target.value.trim())}
                    />
                </label>
                <label className={field}>
                    {t('operations.cost-admin:price-form.cached')}
                    <Input
                        inputMode="decimal"
                        value={cached}
                        onChange={(event) => setCached(event.target.value.trim())}
                    />
                </label>
                <label className={field}>
                    {t('operations.cost-admin:price-form.output')}
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
                    {t('operations.cost-admin:price-form.save')}
                </Button>
            </div>
        </form>
    );
}

// Words of the cards at the foot of Cost, below the fold: they load when
// the page shows them (docs/I18N.md), so the route inlines less.
const ADMIN_WORDS = ['operations.cost-admin'] as const;
export const CostPools = onDemand(ADMIN_WORDS, CostPoolsCard);
export const PriceSyncStatus = onDemand(ADMIN_WORDS, PriceSyncCard);
export const Prices = onDemand(ADMIN_WORDS, PricesCard);
