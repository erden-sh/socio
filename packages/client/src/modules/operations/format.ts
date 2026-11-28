import { useTranslation } from '@socio/i18n/react';
import { activeLocale, dateTimeFormat, formatNumber, numberFormat } from '@socio/shared/locale';
import type { OpsStatus, OpsBucket, OpsTileId } from '@socio/shared/operations/operations';

// Dates are written in the reporting time zone, the same on the server
// and in every browser: one formatter per locale, zone and shape. The
// locale is the request's (`activeLocale`), so a page rendered for one
// person never reuses another's.
const formats = new Map<string, Intl.DateTimeFormat>();
const format = (timeZone: string, shape: 'hour' | 'day' | 'month' | 'time') => {
    const locale = activeLocale();
    const key = `${locale} ${timeZone} ${shape}`;
    let found = formats.get(key);
    if (!found) {
        found = dateTimeFormat(
            {
                timeZone,
                hourCycle: 'h23',
                ...(shape === 'month'
                    ? { month: 'short', year: 'numeric' }
                    : shape === 'day'
                      ? { month: 'short', day: 'numeric' }
                      : shape === 'hour'
                        ? {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                          }
                        : { hour: '2-digit', minute: '2-digit' }),
            },
            locale,
        );
        formats.set(key, found);
    }
    return found;
};

/**
 * A chart point's date: "Oct 22, 14:00", "Oct 22", "Oct 2026"; a week's
 * first day ("Oct 19"). On screen, a week reads "Week of Oct 19"
 * (`useOpsFormat().bucketLabel`).
 */
export function bucketDate(at: number, bucket: OpsBucket, timeZone: string) {
    switch (bucket) {
        case 'hour':
            return format(timeZone, 'hour').format(at);
        case 'day':
        case 'week':
            return format(timeZone, 'day').format(at);
        case 'month':
            return format(timeZone, 'month').format(at);
    }
}

/** A moment in a list: "Oct 22, 14:05". */
export const formatWhen = (at: number, timeZone: string) => format(timeZone, 'hour').format(at);

const compact = numberFormat({ notation: 'compact', maximumFractionDigits: 1 });
const percent = numberFormat({ style: 'percent', maximumFractionDigits: 0 });

/** A tile's value; "–" when there is no data. */
export function tileValue(id: OpsTileId, value: number | null) {
    if (value === null) {
        return '–';
    }
    return id === 'tokens' && value >= 10_000 ? compact.format(value) : formatNumber(value);
}

/**
 * The dashboard's words that format.ts's numbers and dates go in, in the
 * reader's language: a chart point's label ("Oct 22, 14:00", "Week of
 * Oct 19"), a tile's change against the period before ("+12%", "−3%",
 * "Same", or "New" from nothing; undefined when either side has no data),
 * and what the store's status says above the numbers, in the reporting
 * time zone.
 */
export function useOpsFormat() {
    const { t } = useTranslation(['operations', 'operations.dashboard']);
    return {
        bucketLabel: (at: number, bucket: OpsBucket, timeZone: string) =>
            bucket === 'week'
                ? t('operations.dashboard:week-of', { day: bucketDate(at, bucket, timeZone) })
                : bucketDate(at, bucket, timeZone),
        tileChange: (
            value: number | null,
            previous: number | null,
        ): { text: string; direction: 'up' | 'down' | 'same' } | undefined => {
            if (value === null || previous === null) {
                return undefined;
            }
            if (value === previous) {
                return { text: t('operations.dashboard:change.same'), direction: 'same' };
            }
            if (previous === 0) {
                return { text: t('operations.dashboard:change.new'), direction: 'up' };
            }
            const change = (value - previous) / previous;
            return {
                text: `${change > 0 ? '+' : '−'}${percent.format(Math.abs(change))}`,
                direction: change > 0 ? 'up' : 'down',
            };
        },
        statusLine: (status: OpsStatus, timeZone: string) => {
            switch (status.state) {
                case 'unavailable':
                    return t('operations.dashboard:status.unavailable');
                case 'starting':
                    return t('operations.dashboard:status.starting');
                case 'rebuilding':
                    return status.progress === undefined
                        ? t('operations.dashboard:status.rebuilding')
                        : t('operations.dashboard:status.rebuilding-progress', {
                              progress: Math.round(status.progress) / 100,
                          });
                case 'ready':
                    return status.asOf === null
                        ? t('operations.dashboard:status.empty')
                        : t('operations.dashboard:status.as-of', {
                              when: formatWhen(status.asOf, timeZone),
                              zone: timeZone,
                          });
            }
        },
    };
}
