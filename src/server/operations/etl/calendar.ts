import { zonedParts, zonedTime } from '@socio/shared/operations/operations';

const QUARTER = 900_000;
const HOUR = 3_600_000;
/** Further than any UTC offset (14 h) from a clock change. */
const NEAR = 30 * HOUR;

/**
 * From `utcAt` until the next row, every instant falls in these buckets of
 * the reporting time zone: exactly `bucketStart(at, bucket, timeZone)`
 * (CB-184's), so DuckDB can bucket facts with an ASOF join instead of
 * time zone rules it doesn't have offline.
 */
export interface CalendarRow {
    utcAt: number;
    hourAt: number;
    dayAt: number;
    weekAt: number;
    monthAt: number;
}

/**
 * The calendar of `timeZone` over `from`..`to`: a row wherever the local
 * hour changes, about 8,800 a year. Every UTC offset since 1970 is a whole
 * number of quarter hours and changes on one, so it steps an hour at a
 * time and looks at each quarter only around a clock change: a repeated
 * hour stays one bucket, a skipped one has none, and half-hour zones cut
 * their hours on the half hour, as `bucketStart` does.
 */
export function calendarRows(from: number, to: number, timeZone: string): CalendarRow[] {
    const rows: CalendarRow[] = [];
    const starts = new Map<string, number>();
    const start = (y: number, m: number, d: number, h: number) => {
        const key = `${y}-${m}-${d}-${h}`;
        let at = starts.get(key);
        if (at === undefined) {
            starts.set(key, (at = zonedTime(y, m, d, h, timeZone)));
        }
        return at;
    };
    let lastHour: number | undefined;
    /** The local hour at `at`, as a number that goes up by one an hour. */
    const localHour = (p: ReturnType<typeof zonedParts>) => Date.UTC(p.year, p.month - 1, p.day, p.hour) / HOUR;
    const hours: { at: number; p: ReturnType<typeof zonedParts> }[] = [];
    /** Where the clock changed (or moved off the hour). */
    const changes: number[] = [];
    const visit = (at: number, p: ReturnType<typeof zonedParts>) => {
        const hour = localHour(p);
        if (hour === lastHour) {
            return;
        }
        lastHour = hour;
        hours.push({ at, p });
    };
    let at = Math.floor(from / QUARTER) * QUARTER;
    let parts = zonedParts(at, timeZone);
    visit(at, parts);
    while (at < to) {
        // The next local hour, if the clock doesn't change before it.
        const next = at + (60 - parts.minute) * 60_000;
        const nextParts = zonedParts(next, timeZone);
        if (localHour(nextParts) !== localHour(parts) + 1 || nextParts.minute !== 0) {
            changes.push(at);
            for (let quarter = at + QUARTER; quarter < next; quarter += QUARTER) {
                visit(quarter, zonedParts(quarter, timeZone));
            }
        }
        if (next < to) {
            visit(next, nextParts);
        }
        at = next;
        parts = nextParts;
    }
    // An hour starts where it is seen, unless a clock change is near enough
    // for `zonedTime` (which looks up to a day's offset away) to read it
    // otherwise: then it is asked, as `bucketStart` does.
    // The first row may start mid-hour.
    let change = 0;
    for (const [index, { at: hourAt, p }] of hours.entries()) {
        while (change < changes.length && changes[change]! < hourAt - NEAR) {
            change++;
        }
        const near = index === 0 || (change < changes.length && changes[change]! <= hourAt + NEAR);
        rows.push({
            utcAt: hourAt,
            hourAt: near ? start(p.year, p.month, p.day, p.hour) : hourAt,
            dayAt: start(p.year, p.month, p.day, 0),
            weekAt: start(p.year, p.month, p.day - p.weekday, 0),
            monthAt: start(p.year, p.month, 1, 0),
        });
    }
    return rows;
}
