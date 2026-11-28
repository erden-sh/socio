import { X } from 'lucide-react';
import { useState } from 'react';

import { useTranslation } from '@socio/i18n/react';
import {
    OPS_FILTERS,
    OPS_RANGES,
    opsWindow,
    type OpsBucket,
    type OpsFilter,
} from '@socio/shared/operations/operations';

import { useShell } from '../../shell/shell-context';

import { useOpsQuery, useOpsSettings } from './use-ops';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const DAY = 86_400_000;
/** A day as a date input has it, in UTC. */
const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10);

const segment =
    'h-7 shrink-0 rounded-md px-2.5 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-xs dark:aria-pressed:bg-input/50';

/** A filter's value as people know it: a socio's or a Space's name. */
function useFilterName() {
    const { workspace } = useShell();
    return (name: OpsFilter, value: string) =>
        (name === 'socio'
            ? workspace.dots.find((dot) => dot.id === value)?.name
            : name === 'space'
              ? workspace.spaces.find((space) => space.id === value)?.name
              : undefined) ?? value;
}

/**
 * The range bar (CB-164): the range (24 hours to all time, or custom
 * days), how the charts cut it, the reporting time zone, and the filters
 * a drill-down set, each with a way to clear it. Everything it sets is
 * in the address, so the view can be shared.
 */
export function RangeBar() {
    const { t } = useTranslation(['operations', 'operations.dashboard']);
    const { query, update } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const filterName = useFilterName();
    const [custom, setCustom] = useState(!!query.from);
    const [from, setFrom] = useState(query.from?.slice(0, 10) ?? '');
    const [to, setTo] = useState(query.to?.slice(0, 10) ?? '');
    // The cuts this range allows; they don't depend on the moment.
    const window = opsWindow(query, { now: Date.now(), timeZone });
    const filters = OPS_FILTERS.filter((name) => query.filters[name]);
    return (
        <div data-slot="ops-range-bar" className="grid min-w-0 grid-cols-1 gap-2">
            <div className="flex flex-wrap items-center gap-2">
                <div
                    role="group"
                    aria-label={t('operations.dashboard:range.label')}
                    className="flex max-w-full gap-0.5 overflow-x-auto rounded-lg border bg-muted/60 p-0.5 [scrollbar-width:none] dark:bg-input/20"
                >
                    {OPS_RANGES.map((range) => (
                        <button
                            key={range}
                            type="button"
                            data-slot="ops-range"
                            className={segment}
                            aria-pressed={!query.from && !custom && query.range === range}
                            title={t(`operations.dashboard:range.long.${range}`)}
                            onClick={() => {
                                setCustom(false);
                                update({
                                    range,
                                    from: undefined,
                                    to: undefined,
                                    bucket: undefined,
                                });
                            }}
                        >
                            {t(`operations.dashboard:range.short.${range}`)}
                        </button>
                    ))}
                    <button
                        type="button"
                        data-slot="ops-range"
                        className={segment}
                        aria-pressed={custom || !!query.from}
                        aria-expanded={custom}
                        onClick={() => {
                            if (!from) {
                                const now = Date.now();
                                setFrom(isoDay(now - 6 * DAY));
                                setTo(isoDay(now));
                            }
                            setCustom(true);
                        }}
                    >
                        {t('operations.dashboard:range.custom')}
                    </button>
                </div>
                <Select value={window.bucket} onValueChange={(bucket) => update({ bucket: bucket as OpsBucket })}>
                    <SelectTrigger size="sm" aria-label={t('operations.dashboard:range.points')} className="w-32">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {window.buckets.map((bucket) => (
                            <SelectItem key={bucket} value={bucket}>
                                {t(`operations.dashboard:range.bucket.${bucket}`)}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <span data-slot="ops-time-zone" className="text-xs text-muted-foreground">
                    {t('operations.dashboard:range.time-zone', { zone: timeZone })}
                </span>
            </div>
            {custom && (
                <form
                    data-slot="ops-custom-range"
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!from) {
                            return;
                        }
                        update({ from, to: to || undefined, bucket: undefined });
                    }}
                >
                    <label className="grid gap-1 text-xs text-muted-foreground">
                        {t('operations.dashboard:range.from')}
                        <Input
                            type="date"
                            required
                            value={from}
                            max={to || undefined}
                            onChange={(event) => setFrom(event.target.value)}
                            className="h-8 w-40 text-sm"
                        />
                    </label>
                    <label className="grid gap-1 text-xs text-muted-foreground">
                        {t('operations.dashboard:range.to')}
                        <Input
                            type="date"
                            value={to}
                            min={from || undefined}
                            onChange={(event) => setTo(event.target.value)}
                            className="h-8 w-40 text-sm"
                        />
                    </label>
                    <Button type="submit" size="sm" variant="outline">
                        {t('operations.dashboard:range.show')}
                    </Button>
                </form>
            )}
            {filters.length > 0 && (
                <ul
                    aria-label={t('operations.dashboard:range.filters')}
                    className="m-0 flex list-none flex-wrap gap-1.5 p-0"
                >
                    {filters.map((name) => {
                        const text = t('operations.dashboard:range.filter-value', {
                            filter: t(`operations.dashboard:range.filter.${name}`),
                            value: filterName(name, query.filters[name]!),
                        });
                        return (
                            <li
                                key={name}
                                data-slot="ops-filter"
                                className="flex h-7 items-center gap-1 rounded-full border bg-card pr-1 pl-2.5 text-xs"
                            >
                                <span className="max-w-48 truncate">{text}</span>
                                <button
                                    type="button"
                                    data-slot="ops-filter-clear"
                                    aria-label={t('operations.dashboard:range.clear', { filter: text })}
                                    className="grid size-5 place-items-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                                    onClick={() =>
                                        update({
                                            filters: { ...query.filters, [name]: undefined },
                                        })
                                    }
                                >
                                    <X className="size-3" />
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
