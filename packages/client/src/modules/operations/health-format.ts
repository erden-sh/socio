import { numberFormat, relativeTimeFormat } from '@socio/shared/locale';

const percent = numberFormat({ style: 'percent', maximumFractionDigits: 0 });
const usd = numberFormat({ style: 'currency', currency: 'USD' });

// Units as the reader's locale writes them ("3.2 sec", "4.5 min"), and
// how long ago ("4 minutes ago"): the locale's own words, from Intl.
const unitFormat = (unit: 'millisecond' | 'second' | 'minute' | 'hour', digits: number) =>
    numberFormat({ style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: digits });
const units = {
    millisecond: unitFormat('millisecond', 0),
    second: unitFormat('second', 1),
    minute: unitFormat('minute', 1),
    hour: unitFormat('hour', 1),
};
const ago = relativeTimeFormat({ numeric: 'always' });

/** A duration: "420 ms", "3.2 sec", "4.5 min", "2.1 hr"; "–" with none. */
export function formatMs(ms: number | null | undefined) {
    if (ms === null || ms === undefined) {
        return '–';
    }
    if (ms < 1000) {
        return units.millisecond.format(Math.round(ms));
    }
    if (ms < 60_000) {
        return units.second.format(ms / 1000);
    }
    if (ms < 3_600_000) {
        return units.minute.format(ms / 60_000);
    }
    return units.hour.format(ms / 3_600_000);
}

/** How long ago: "35 seconds ago", "4 minutes ago", "2 hours ago", "3 days ago". */
export function formatAgo(at: number, now: number) {
    const ms = Math.max(0, now - at);
    if (ms < 60_000) {
        return ago.format(-Math.round(ms / 1000), 'second');
    }
    if (ms < 3_600_000) {
        return ago.format(-Math.round(ms / 60_000), 'minute');
    }
    if (ms < 86_400_000) {
        return ago.format(-Math.round(ms / 3_600_000), 'hour');
    }
    return ago.format(-Math.round(ms / 86_400_000), 'day');
}

export const formatShare = (covered: number, total: number) => (total ? percent.format(covered / total) : '–');

export const formatUsd = (value: number) => usd.format(value);
