import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { useTranslation } from '@socio/i18n/react';
import { formatNumber, numberFormat } from '@socio/shared/locale';
import { opsSearch, type OpsAnswer, type OpsFilters, type OpsQuery } from '@socio/shared/operations/operations';
import { OPS_SHARE_TILES, type OpsValueTile } from '@socio/shared/operations/operations-activity';

import { useOpsFormat } from './format';
import { opsPath, type OpsSectionId } from './sections';

import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const share = numberFormat({ style: 'percent', maximumFractionDigits: 0 });
const decimal = numberFormat({ maximumFractionDigits: 1 });

/** A share as a percentage ("42%"), "–" when there is none. */
export const formatShare = (value: number | null) => (value === null ? '–' : share.format(value));

/** A tile's value: a count, a share, or an average. */
function tileText(id: string, value: number | null) {
    if (value === null) {
        return '–';
    }
    if (OPS_SHARE_TILES.has(id)) {
        return share.format(value);
    }
    return Number.isInteger(value) ? formatNumber(value) : decimal.format(value);
}

/**
 * A person's name; a shared Telegram topic's team, or the id, when there
 * is none (`personLabel`), and what the tiles compare with, "the 7 days
 * before" (`previousLabel`), in the reader's words.
 */
export function useActivityWords() {
    const { t } = useTranslation(['operations', 'operations.dashboard']);
    return {
        personLabel: (id: string, name: string | null) =>
            name || (id.startsWith('telegram-team:') ? t('operations.dashboard:telegram-team') : id),
        previousLabel: (query: OpsQuery) =>
            t('operations.dashboard:previous', {
                context: query.from || query.range === 'all' ? undefined : query.range,
            }),
    };
}

/** The same section narrowed further: a filter link that can be shared. */
export function filterLink(section: OpsSectionId, query: OpsQuery, filters: OpsFilters) {
    return opsPath(section, opsSearch({ ...query, filters: { ...query.filters, ...filters } }));
}

/** The store's status above the numbers, as Overview has it. */
export function StatusNote({
    answer,
    timeZone,
    error,
}: {
    answer: OpsAnswer | undefined;
    timeZone: string;
    error: string;
}) {
    const { statusLine } = useOpsFormat();
    return (
        <>
            {answer && (
                <p
                    data-slot="ops-status"
                    data-state={answer.status.state}
                    className={cn(
                        'm-0 text-xs text-muted-foreground',
                        answer.status.state !== 'ready' && 'rounded-lg border bg-card px-4 py-3 text-sm',
                    )}
                >
                    {statusLine(answer.status, timeZone)}
                </p>
            )}
            {error && (
                <p role="alert" className="m-0 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                    {error}
                </p>
            )}
        </>
    );
}

/** Stat tiles, each against the period before; skeletons while loading. */
export function Tiles<Id extends string>({
    tiles,
    labels,
    against,
    upIsGood = () => true,
    loading,
    count,
}: {
    tiles: OpsValueTile<Id>[] | undefined;
    labels: Record<Id, string>;
    against: string;
    /** Whether more is better; undefined leaves its change uncolored. */
    upIsGood?: (id: Id) => boolean | undefined;
    loading: boolean;
    count: number;
}) {
    const { t } = useTranslation(['operations', 'operations.dashboard']);
    const { tileChange } = useOpsFormat();
    return (
        <section
            aria-label={t('operations.dashboard:totals')}
            aria-busy={loading}
            className="grid grid-cols-2 gap-3 sm:grid-cols-3"
        >
            {tiles
                ? tiles.map((tile) => {
                      const change = tileChange(tile.value, tile.previous);
                      const better = upIsGood(tile.id);
                      const good =
                          change && change.direction !== 'same' && better !== undefined
                              ? (change.direction === 'up') === better
                              : undefined;
                      return (
                          <Card
                              key={tile.id}
                              data-slot="ops-tile"
                              data-tile={tile.id}
                              className="gap-1 px-4 py-3 shadow-xs"
                          >
                              <span className="text-xs text-muted-foreground">{labels[tile.id]}</span>
                              <strong className="text-2xl font-semibold tabular-nums">
                                  {tileText(tile.id, tile.value)}
                              </strong>
                              <span
                                  className={cn(
                                      'min-h-4 text-xs text-muted-foreground',
                                      good === true && 'text-emerald-700 dark:text-emerald-400',
                                      good === false && 'text-destructive',
                                  )}
                              >
                                  {change && t('operations.dashboard:change.versus', { change: change.text, against })}
                              </span>
                          </Card>
                      );
                  })
                : Array.from({ length: count }, (_, index) => <Skeleton key={index} className="h-21 rounded-xl" />)}
        </section>
    );
}

/** A row of a breakdown: a name (often a link) and its numbers. */
export function BreakdownRow({
    name,
    meta,
    numbers,
    slot,
}: {
    name: ReactNode;
    meta?: ReactNode;
    numbers: ReactNode;
    slot: string;
}) {
    return (
        <div data-slot={slot} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm">
            <span className="min-w-0 truncate font-medium">{name}</span>
            {meta}
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">{numbers}</span>
        </div>
    );
}

/** A link inside a row, styled as the Overview's. */
export function RowLink({ to, children }: { to: string; children: ReactNode }) {
    return (
        <Link to={to} className="min-w-0 truncate hover:underline">
            {children}
        </Link>
    );
}

/** "3 people · 12 messages": counts (each a plural string from `t`), joined; zero ones kept. */
export const counts = (...parts: string[]) => parts.join(' · ');
