/**
 * Dates, windows and buckets of the query spec (CB-451),
 * worked out on calendar days in the spec's time zone. "Today" is the
 * date in that zone, so a person in Los Angeles at 17:00 on November 30
 * (01:00 on December 1 in UTC) is still in November. Ranges are
 * inclusive calendar dates (`YYYY-MM-DD`); `zoneStart` turns a date into
 * the instant it starts in a zone, for `datetime` fields.
 */
import type { DateBucket, DatePeriod, QueryWindow, RelativeUnit } from './spec.js';

/** An inclusive range of calendar dates; `from: null` is all history. */
export interface DateRange {
    from: string | null;
    to: string | null;
}
export interface ClosedRange {
    from: string;
    to: string;
}

interface Ymd {
    y: number;
    m: number; // 1-12
    d: number;
}
const parse = (date: string): Ymd => {
    const [y, m, d] = date.split('-').map(Number);
    return { y, m, d };
};
const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const format = ({ y, m, d }: Ymd) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
/** Through `Date.UTC`, which normalizes overflowing months and days. */
const make = (y: number, m: number, d: number): string => {
    const date = new Date(Date.UTC(y, m - 1, d));
    return format({ y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() });
};
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The calendar date in `timeZone` at `now`. */
export function todayIn(timeZone: string, now: number | Date = Date.now()): string {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(now);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return format({ y: get('year'), m: get('month'), d: get('day') });
}

/** `date` plus `count` days (negative to go back). */
export function addDays(date: string, count: number) {
    const { y, m, d } = parse(date);
    return make(y, m, d + count);
}
/**
 * `date` plus `count` months, kept on the month's last day when the day
 * doesn't exist (January 31 plus one month is February 28 or 29).
 */
export function addMonths(date: string, count: number) {
    const { y, m, d } = parse(date);
    const total = y * 12 + (m - 1) + count;
    const ny = Math.floor(total / 12);
    const nm = (total % 12) + 1;
    return format({ y: ny, m: nm, d: Math.min(d, daysInMonth(ny, nm)) });
}
/** `date` plus `count` of `unit`. */
export function addUnits(date: string, unit: RelativeUnit, count: number) {
    switch (unit) {
        case 'day':
            return addDays(date, count);
        case 'week':
            return addDays(date, count * 7);
        case 'month':
            return addMonths(date, count);
        case 'quarter':
            return addMonths(date, count * 3);
        case 'year':
            return addMonths(date, count * 12);
    }
}

/** The first day of the bucket `date` falls in. Weeks start on Monday (ISO). */
export function bucketStart(date: string, bucket: DateBucket): string {
    const { y, m, d } = parse(date);
    switch (bucket) {
        case 'day':
            return date;
        case 'week': {
            const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday 0
            return make(y, m, d - weekday);
        }
        case 'month':
            return make(y, m, 1);
        case 'quarter':
            return make(y, m - ((m - 1) % 3), 1);
        case 'year':
            return make(y, 1, 1);
    }
}
/** The last day of the bucket `date` falls in. */
export function bucketEnd(date: string, bucket: DateBucket): string {
    const start = bucketStart(date, bucket);
    switch (bucket) {
        case 'day':
            return start;
        case 'week':
            return addDays(start, 6);
        case 'month':
            return addDays(addMonths(start, 1), -1);
        case 'quarter':
            return addDays(addMonths(start, 3), -1);
        case 'year':
            return addDays(addMonths(start, 12), -1);
    }
}

/** Whether a range contains `today` (marked `partial`). */
export const containsDay = (range: DateRange, day: string) =>
    (range.from === null || range.from <= day) && (range.to === null || day <= range.to);

/**
 * Every bucket from the one `range.from` falls in through the one
 * `range.to` falls in, each with its own dates and `partial` when it
 * contains today. Fills empty buckets, so it is capped: a range
 * of more than `max` buckets is refused.
 */
export function bucketsOf(range: ClosedRange, bucket: DateBucket, today: string, max = 5_000) {
    const out: Array<{ start: string; end: string; partial: boolean }> = [];
    for (let start = bucketStart(range.from, bucket); start <= range.to;) {
        const end = bucketEnd(start, bucket);
        out.push({ start, end, partial: containsDay({ from: start, to: end }, today) });
        if (out.length > max) {
            throw new RangeError(`More than ${max} ${bucket} buckets.`);
        }
        start = addDays(end, 1);
    }
    return out;
}

/**
 * A relative date of a filter: the last or next `count` units,
 * today included (`past 30 day` is the 30 days ending today).
 */
export function relativeRange(
    direction: 'past' | 'next',
    count: number,
    unit: RelativeUnit,
    today: string,
): ClosedRange {
    return direction === 'past'
        ? { from: addDays(addUnits(today, unit, -count), 1), to: today }
        : { from: today, to: addDays(addUnits(today, unit, count), -1) };
}

/** A whole calendar period of a filter, by today. */
export function periodRange(period: DatePeriod, today: string): ClosedRange {
    const [when, unit] = period.split('_') as ['this' | 'previous' | 'next', 'week' | 'month' | 'quarter' | 'year'];
    const shift = when === 'this' ? 0 : when === 'previous' ? -1 : 1;
    const day = addUnits(bucketStart(today, unit), unit, shift);
    return { from: bucketStart(day, unit), to: bucketEnd(day, unit) };
}

/**
 * A window, relative to today in the spec's zone. Windows to date
 * end today: `ytd`, `this_month`, `trailing_12_months` (the current
 * month, partial, and the 11 whole months before it) and `last_n` (the
 * last `count` units, today included). `previous_year` and
 * `previous_month` are whole periods; `between` is fixed.
 */
export function windowRange(window: QueryWindow, today: string): ClosedRange {
    if (typeof window === 'object') {
        if ('between' in window) {
            return { from: window.between[0], to: window.between[1] };
        }
        return relativeRange('past', window.last_n.count, window.last_n.unit, today);
    }
    switch (window) {
        case 'ytd':
            return { from: bucketStart(today, 'year'), to: today };
        case 'previous_year':
            return periodRange('previous_year', today);
        case 'trailing_12_months':
            return { from: addMonths(bucketStart(today, 'month'), -11), to: today };
        case 'this_month':
            return { from: bucketStart(today, 'month'), to: today };
        case 'previous_month':
            return periodRange('previous_month', today);
    }
}

/**
 * The rows a query must read: the display window, widened back to
 * the earliest date a running value needs (all history for `from: "all"`,
 * the date for `from: <date>`, the window for `from: "window"`) and to
 * every comparison window. Without a display window or comparison
 * windows, every row is read.
 */
export function sourceRange(input: {
    window?: QueryWindow;
    windows?: QueryWindow[];
    /** Each running value's `from` (default `all`). */
    running?: Array<'window' | 'all' | string | undefined>;
    today: string;
}): DateRange {
    const ranges = [
        ...(input.window ? [windowRange(input.window, input.today)] : []),
        ...(input.windows ?? []).map((w) => windowRange(w, input.today)),
    ];
    if (!ranges.length) {
        return { from: null, to: null };
    }
    let from: string | null = ranges.reduce((min, r) => (r.from < min ? r.from : min), ranges[0].from);
    const to = ranges.reduce((max, r) => (r.to > max ? r.to : max), ranges[0].to);
    for (const start of input.running ?? []) {
        if (start === undefined || start === 'all') {
            from = null;
        } else if (start !== 'window' && from !== null && start < from) {
            from = start;
        }
    }
    return { from, to };
}

/**
 * The instant (ms since the epoch) a calendar date starts in `timeZone`:
 * its local midnight, or, where a clock change skips midnight, the first
 * instant of that date. `datetime` bounds compare against it.
 */
export function zoneStart(date: string, timeZone: string): number {
    const { y, m, d } = parse(date);
    const utcMidnight = Date.UTC(y, m - 1, d);
    // The zone's offset at a guess, twice: the second absorbs a clock change.
    let guess = utcMidnight - offsetAt(utcMidnight, timeZone);
    guess = utcMidnight - offsetAt(guess, timeZone);
    // A skipped midnight lands on the day before: step to the date's first instant.
    while (todayIn(timeZone, guess) < date) {
        guess += 15 * 60_000;
    }
    while (todayIn(timeZone, guess - 60_000) === date) {
        guess -= 60_000;
    }
    return guess;
}

/** The zone's offset from UTC at an instant, in ms (positive east of Greenwich). */
export function offsetAt(at: number, timeZone: string) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return local - Math.floor(at / 1000) * 1000;
}

/**
 * A date and time a filter names, as an instant (ms): with an offset as
 * given, without one in `timeZone`. Undefined when it names none.
 * The evaluator and the compilers bound `datetime` conditions with it.
 */
export function wallInstant(value: string, timeZone: string): number | undefined {
    const text = value.replace(' ', 'T');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) {
        return undefined;
    }
    if (/(Z|[+-]\d{2}:\d{2})$/.test(text)) {
        const at = Date.parse(text);
        return Number.isNaN(at) ? undefined : at;
    }
    const wall = Date.parse(`${text}Z`);
    return Number.isNaN(wall) ? undefined : wall - offsetAt(wall - offsetAt(wall, timeZone), timeZone);
}

/**
 * A comparison window's label: its name, `last_<count>_<unit>`,
 * or `between_<from>_<to>`. Result columns of a window are
 * `<measure>:<label>`.
 */
export function windowLabel(window: QueryWindow): string {
    if (typeof window === 'string') {
        return window;
    }
    if ('between' in window) {
        return `between_${window.between[0]}_${window.between[1]}`;
    }
    return `last_${window.last_n.count}_${window.last_n.unit}`;
}

/** One stretch of a zone's offset: from `at` (ms, inclusive) until the next stretch. */
export interface ZoneStretch {
    at: number;
    offset: number;
}

const DAY_MS = 86_400_000;
const stretchCache = new Map<string, ZoneStretch[]>();
/** The span `zoneStretches` works out once per zone: 1970 through 2100. */
const STRETCH_FROM = Date.UTC(1970, 0, 1);
const STRETCH_TO = Date.UTC(2101, 0, 1);

/**
 * A zone's offsets from 1970 through 2100, as stretches: the first starts
 * at 1970 and each later one where the offset changes (to the minute).
 * The compilers turn instants into the zone's calendar days with them,
 * since SQLite has no zones; an instant outside the span takes the
 * nearest stretch's offset. Worked out once per zone.
 */
export function zoneStretches(timeZone: string): ZoneStretch[] {
    const cached = stretchCache.get(timeZone);
    if (cached) {
        return cached;
    }
    const format = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
    const offset = (at: number) => {
        const parts = format.formatToParts(at);
        const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
        const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
        return local - Math.floor(at / 1000) * 1000;
    };
    // Offsets change at most every few weeks: step a week at a time, then
    // find each change in the week to the minute.
    const step = 7 * DAY_MS;
    const out: ZoneStretch[] = [{ at: STRETCH_FROM, offset: offset(STRETCH_FROM) }];
    let current = out[0].offset;
    for (let at = STRETCH_FROM + step; at <= STRETCH_TO; at += step) {
        const end = offset(at);
        let lo = at - step;
        while (end !== current) {
            // The first minute in (lo, at] whose offset isn't `current`.
            let a = lo;
            let b = at;
            while (b - a > 60_000) {
                const mid = a + Math.max(60_000, Math.floor((b - a) / 120_000) * 60_000);
                if (offset(mid) === current) {
                    a = mid;
                } else {
                    b = mid;
                }
            }
            current = offset(b);
            out.push({ at: b, offset: current });
            lo = b;
        }
    }
    stretchCache.set(timeZone, out);
    return out;
}
