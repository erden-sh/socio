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

/** A chart point's label: "Oct 22, 14:00", "Oct 22", "Week of Oct 19", "Oct 2026". */
export function bucketLabel(at: number, bucket: OpsBucket, timeZone: string) {
    switch (bucket) {
        case 'hour':
            return format(timeZone, 'hour').format(at);
        case 'day':
            return format(timeZone, 'day').format(at);
        case 'week':
            return `Week of ${format(timeZone, 'day').format(at)}`;
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
 * A tile's change against the period before: "+12%", "−3%", "Same", or
 * "New" from nothing. Undefined when either side has no data.
 */
export function tileChange(
    value: number | null,
    previous: number | null,
): { text: string; direction: 'up' | 'down' | 'same' } | undefined {
    if (value === null || previous === null) {
        return undefined;
    }
    if (value === previous) {
        return { text: 'Same', direction: 'same' };
    }
    if (previous === 0) {
        return { text: 'New', direction: 'up' };
    }
    const change = (value - previous) / previous;
    return {
        text: `${change > 0 ? '+' : '−'}${percent.format(Math.abs(change))}`,
        direction: change > 0 ? 'up' : 'down',
    };
}

/** What the store's status says above the numbers, in the reporting time zone. */
export function statusLine(status: OpsStatus, timeZone: string) {
    switch (status.state) {
        case 'unavailable':
            return 'Analytics isn’t running yet, so there are no numbers to show. They appear here once it is set up.';
        case 'starting':
            return 'Analytics is starting. Numbers appear in a moment.';
        case 'rebuilding':
            return `Analytics is rebuilding${status.progress === undefined ? '' : ` (${Math.round(status.progress)}%)`}. Numbers appear when it is done.`;
        case 'ready':
            return status.asOf === null
                ? 'No data yet.'
                : `Data as of ${formatWhen(status.asOf, timeZone)} (${timeZone}).`;
    }
}
