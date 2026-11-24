import { dateTimeFormat } from '@socio/shared/locale';

/** A turn's or a step's duration in Runs: "820 ms", "1.5 s", "2m 05s". */
export function formatDuration(ms: number) {
    if (ms < 1000) {
        return `${ms} ms`;
    }
    if (ms < 60_000) {
        return `${(ms / 1000).toFixed(1)} s`;
    }
    const seconds = Math.round(ms / 1000);
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

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
