import { dateTimeFormat, listFormat, numberFormat } from '@socio/shared/locale';

// Units as the reader's locale writes them ("820 ms", "1.5 sec", "2 min,
// 5 sec"): the locale's own words, from Intl, as Operations' formatMs.
const unit = (name: 'millisecond' | 'second' | 'minute' | 'hour', digits = 0) =>
    numberFormat({ style: 'unit', unit: name, unitDisplay: 'short', maximumFractionDigits: digits });
const units = {
    millisecond: unit('millisecond'),
    tenths: unit('second', 1),
    second: unit('second'),
    minute: unit('minute'),
    hour: unit('hour'),
};
const parts = listFormat({ type: 'unit', style: 'short' });

/**
 * A turn's or a step's duration in Runs (and a job's in Schedules): "820
 * ms", "1.5 sec", "2 min, 5 sec", "1 hr, 3 min"; the zero parts left out.
 */
export function formatDuration(ms: number) {
    if (ms < 1000) {
        return units.millisecond.format(Math.round(ms));
    }
    if (ms < 60_000) {
        return units.tenths.format(Math.round(ms / 100) / 10);
    }
    const total = Math.round(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return parts.format(
        [
            hours > 0 && units.hour.format(hours),
            minutes > 0 && units.minute.format(minutes),
            seconds > 0 && units.second.format(seconds),
        ].filter((part): part is string => !!part),
    );
}

/** A number of whole seconds, as a limit reads: "120 sec". */
export const formatSeconds = (seconds: number) => units.second.format(seconds);

const thisYear = dateTimeFormat({
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
});
const otherYear = dateTimeFormat({
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
});
const full = dateTimeFormat({ dateStyle: 'full', timeStyle: 'medium' });

/**
 * When a run started, one format across Runs (CB-308): `Oct 31, 1:53 PM`,
 * with the year only when it isn't this one. Render it through
 * `<LocalTime>`, with `fullRunTime` as its tooltip.
 */
export const formatRunTime = (value: number) =>
    (new Date(value).getFullYear() === new Date().getFullYear() ? thisYear : otherYear).format(value);

/** The whole timestamp, for the tooltip: `Saturday, October 31, 2026 at 1:53:21 PM`. */
export const fullRunTime = (value: number) => full.format(value);
