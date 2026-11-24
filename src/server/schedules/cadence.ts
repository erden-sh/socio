/**
 * Schedule cadences: when a Dot-proposed schedule runs. Two notations,
 * both read in an IANA time zone (UTC unless the user's zone is known):
 *
 * - **Phrases**: `every 15 minutes`, `every 6 hours`, `every 2 hours at
 *   :30`, `every day at 09:00`, `every 3 days at 7pm`, `every monday at
 *   08:30`, `every 2 weeks on friday at 17:00`, `hourly`, `daily at 9am`,
 *   `weekly on sunday`. Minutes and hours are fixed durations (DST doesn't
 *   change them); days and weeks follow the wall clock, so "every day at
 *   09:00" stays at 09:00 across DST.
 * - **Cron**: five fields `minute hour day-of-month month day-of-week` with
 *   `*`, lists, ranges and steps (`*\/15`, `1-5`, `0,30`), names for months
 *   and weekdays, `@hourly`, `@daily`, `@weekly`, `@monthly`. When both day
 *   fields are restricted, either matching is enough (as in cron).
 *
 * Wall-clock times are resolved per zone: a time that doesn't exist (the
 * spring-forward gap) runs at the same clock time after the gap (02:30 →
 * 03:30); a time that happens twice (fall back) runs once, the first time.
 * Everything is stored and compared as UTC instants.
 */

export type Cadence =
    | {
          kind: 'cron';
          text: string;
          minute: ReadonlySet<number>;
          hour: ReadonlySet<number>;
          dom: ReadonlySet<number>;
          month: ReadonlySet<number>;
          dow: ReadonlySet<number>;
          domAll: boolean;
          dowAll: boolean;
      }
    | {
          /** A fixed duration; `at` anchors the first run to a clock time. */
          kind: 'interval';
          text: string;
          everyMs: number;
          at?: ClockTime;
          /** `at :MM`: minutes past the hour, not a clock time. */
          pastHour?: boolean;
      }
    | {
          /** Every N days (or 7N for weeks) at a clock time, on the wall clock. */
          kind: 'days';
          text: string;
          every: number;
          at?: ClockTime;
          weekday?: number;
      };
export interface ClockTime {
    hour: number;
    minute: number;
}

export class CadenceError extends Error {}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ALIASES: Record<string, string> = {
    '@hourly': '0 * * * *',
    '@daily': '0 0 * * *',
    '@midnight': '0 0 * * *',
    '@weekly': '0 0 * * 0',
    '@monthly': '0 0 1 * *',
};

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (at: ClockTime) => `${pad(at.hour)}:${pad(at.minute)}`;

/** Whether `zone` is an IANA time zone this runtime knows. */
export function validTimeZone(zone: string) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

function weekday(word: string): number | undefined {
    const index = WEEKDAYS.indexOf(word.slice(0, 3));
    if (index === -1) {
        return undefined;
    }
    const full = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][index];
    return full.startsWith(word) || word === WEEKDAYS[index] ? index : undefined;
}

/** `09:00`, `9:30`, `9am`, `7:15 pm`, `:30` (minutes past the hour). */
function parseClock(raw: string, minuteOnly = false): ClockTime {
    const text = raw.trim();
    const past = /^:(\d{2})$/.exec(text);
    if (past) {
        const minute = Number(past[1]);
        if (minute > 59) {
            throw new CadenceError(`Invalid time "${raw}".`);
        }
        return { hour: 0, minute };
    }
    if (minuteOnly) {
        throw new CadenceError('With hours, give minutes past the hour (at :30) or a clock time.');
    }
    const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
    if (!match) {
        throw new CadenceError(`Invalid time "${raw}". Use HH:MM.`);
    }
    let hour = Number(match[1]);
    const minute = Number(match[2] ?? 0);
    if (match[3]) {
        if (hour < 1 || hour > 12) {
            throw new CadenceError(`Invalid time "${raw}".`);
        }
        hour = (hour % 12) + (match[3] === 'pm' ? 12 : 0);
    }
    if (hour > 23 || minute > 59) {
        throw new CadenceError(`Invalid time "${raw}".`);
    }
    return { hour, minute };
}

function cronField(
    raw: string,
    min: number,
    max: number,
    names?: readonly string[],
): { values: Set<number>; all: boolean } {
    const values = new Set<number>();
    const value = (token: string) => {
        const named = names?.indexOf(token.slice(0, 3));
        if (names && named !== undefined && named >= 0 && /^[a-z]+$/.test(token)) {
            return named + (min === 1 ? 1 : 0);
        }
        if (!/^\d+$/.test(token)) {
            throw new CadenceError(`Invalid cron "${raw}".`);
        }
        return Number(token);
    };
    for (const part of raw.split(',')) {
        const [range, stepText] = part.split('/');
        const step = stepText === undefined ? 1 : Number(stepText);
        if (!Number.isInteger(step) || step < 1) {
            throw new CadenceError(`Invalid cron step in "${raw}".`);
        }
        let from: number;
        let to: number;
        if (range === '*') {
            from = min;
            to = max;
        } else if (range.includes('-')) {
            const [a, b] = range.split('-');
            from = value(a);
            to = value(b);
        } else {
            from = value(range);
            to = stepText === undefined ? from : max;
        }
        // Sunday may be 7.
        if (max === 6 && to === 7) {
            to = 7;
        }
        if (from < min || to > (max === 6 ? 7 : max) || from > to) {
            throw new CadenceError(`Cron value out of range in "${raw}".`);
        }
        for (let n = from; n <= to; n += step) {
            values.add(max === 6 ? n % 7 : n);
        }
    }
    return { values, all: raw === '*' || raw === '*/1' };
}

function parseCron(text: string): Cadence {
    const fields = text.split(/\s+/);
    if (fields.length !== 5) {
        throw new CadenceError('A cron cadence has five fields: minute hour day-of-month month day-of-week.');
    }
    const minute = cronField(fields[0], 0, 59);
    const hour = cronField(fields[1], 0, 23);
    const dom = cronField(fields[2], 1, 31);
    const month = cronField(fields[3], 1, 12, MONTHS);
    const dow = cronField(fields[4], 0, 6, WEEKDAYS);
    return {
        kind: 'cron',
        text,
        minute: minute.values,
        hour: hour.values,
        dom: dom.values,
        month: month.values,
        dow: dow.values,
        domAll: dom.all,
        dowAll: dow.all,
    };
}

const UNITS: Record<string, 'minute' | 'hour' | 'day' | 'week'> = {
    minute: 'minute',
    minutes: 'minute',
    min: 'minute',
    mins: 'minute',
    hour: 'hour',
    hours: 'hour',
    hr: 'hour',
    hrs: 'hour',
    day: 'day',
    days: 'day',
    week: 'week',
    weeks: 'week',
};

/** Parses a cadence; throws a CadenceError that says what to write instead. */
export function parseCadence(input: string): Cadence {
    const text = input.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!text) {
        throw new CadenceError('Give a cadence.');
    }
    if (text.length > 120) {
        throw new CadenceError('The cadence is too long.');
    }
    if (ALIASES[text]) {
        return { ...parseCron(ALIASES[text]), text };
    }
    if (/^[\d*@]/.test(text) && text.split(' ').length === 5) {
        return parseCron(text);
    }
    let rest = text
        .replace(/^hourly\b/, 'every hour')
        .replace(/^daily\b/, 'every day')
        .replace(/^weekly\b/, 'every week');
    const at = / at (.+)$/.exec(rest);
    if (at) {
        rest = rest.slice(0, at.index);
    }
    const on = / on ([a-z]+)$/.exec(rest);
    if (on) {
        rest = rest.slice(0, on.index);
    }
    const every = /^every (?:(\d+) )?([a-z]+)$/.exec(rest);
    if (!every) {
        throw new CadenceError(
            'Use a phrase like "every 6 hours", "every day at 09:00", "every monday at 08:30", or a five-field cron.',
        );
    }
    const count = every[1] === undefined ? 1 : Number(every[1]);
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
        throw new CadenceError('The count must be 1 to 1000.');
    }
    let unit = UNITS[every[2]];
    let day = on ? weekday(on[1]) : undefined;
    if (on && day === undefined) {
        throw new CadenceError(`Unknown weekday "${on[1]}".`);
    }
    // "every monday" is "every week on monday".
    if (!unit && every[1] === undefined) {
        const named = weekday(every[2]);
        if (named !== undefined && !on) {
            unit = 'week';
            day = named;
        }
    }
    if (!unit) {
        throw new CadenceError(`Unknown unit "${every[2]}".`);
    }
    if (day !== undefined && unit !== 'week') {
        throw new CadenceError('"on <weekday>" goes with weeks.');
    }
    if (unit === 'minute') {
        if (at) {
            throw new CadenceError('Minutes take no "at".');
        }
        return {
            kind: 'interval',
            text: `every ${count} minute${count === 1 ? '' : 's'}`,
            everyMs: count * MINUTE,
        };
    }
    if (unit === 'hour') {
        const time = at ? parseClockForHours(at[1]) : undefined;
        return {
            kind: 'interval',
            text: `every ${count === 1 ? '' : `${count} `}hour${count === 1 ? '' : 's'}${time ? ` at ${time.past ? `:${pad(time.at.minute)}` : clock(time.at)}` : ''}`,
            everyMs: count * HOUR,
            ...(time ? { at: time.at, ...(time.past ? { pastHour: true } : {}) } : {}),
        };
    }
    const time = at ? parseClock(at[1]) : undefined;
    const days = unit === 'week' ? count * 7 : count;
    const label =
        unit === 'week'
            ? `every ${count === 1 ? '' : `${count} `}week${count === 1 ? '' : 's'}${day !== undefined ? ` on ${['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][day]}` : ''}`
            : `every ${count === 1 ? '' : `${count} `}day${count === 1 ? '' : 's'}`;
    return {
        kind: 'days',
        text: `${label}${time ? ` at ${clock(time)}` : ''}`,
        every: days,
        ...(time ? { at: time } : {}),
        ...(day !== undefined ? { weekday: day } : {}),
    };
}

/** For hours, `at :30` is minutes past the hour; `at 09:15` anchors to that time. */
function parseClockForHours(raw: string) {
    const text = raw.trim();
    if (text.startsWith(':')) {
        return { at: parseClock(text, true), past: true as const };
    }
    return { at: parseClock(text), past: false as const };
}

// ---- time zones -----------------------------------------------------------

interface Wall {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string) {
    let format = formatters.get(zone);
    if (!format) {
        format = new Intl.DateTimeFormat('en-US', {
            timeZone: zone,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
        });
        formatters.set(zone, format);
    }
    return format;
}
/** The wall clock in `zone` at instant `t`. */
export function wallClock(zone: string, t: number): Wall {
    const parts: Record<string, number> = {};
    for (const part of formatter(zone).formatToParts(new Date(t))) {
        if (part.type !== 'literal') {
            parts[part.type] = Number(part.value);
        }
    }
    return {
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour: parts.hour % 24,
        minute: parts.minute,
    };
}
const naive = (w: Wall) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
/** The zone's offset from UTC at instant `t`, in ms (to the minute). */
function offset(zone: string, t: number) {
    return naive(wallClock(zone, t)) - Math.floor(t / MINUTE) * MINUTE;
}
/**
 * The instant a wall-clock time happens in `zone`: the first one when it
 * happens twice, and the same clock time after the gap when it is skipped.
 */
export function instantOf(zone: string, wall: Wall): number {
    const local = naive(wall);
    // Zones change offset months apart: a day either side brackets one change.
    const before = offset(zone, local - DAY);
    const after = offset(zone, local + DAY);
    const candidates = [local - before, local - after].filter((t) => naive(wallClock(zone, t)) === local);
    return candidates.length ? Math.min(...candidates) : local - before;
}
const wallOfNaive = (t: number): Wall => {
    const d = new Date(t);
    return {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes(),
    };
};
const dayNumber = (w: Pick<Wall, 'year' | 'month' | 'day'>) => Math.floor(Date.UTC(w.year, w.month - 1, w.day) / DAY);

// ---- next runs ------------------------------------------------------------

/**
 * The first run strictly after `after`, for a schedule created at
 * `anchor` (which fixes the phase of "every N …" cadences and the default
 * clock time of days and weeks: the creation time, to the minute). Null
 * when the cadence never runs (a cron for 30 February).
 */
export function nextRun(cadence: Cadence, zone: string, after: number, anchor: number): number | null {
    if (cadence.kind === 'interval') {
        let start = anchor;
        if (cadence.at) {
            // The first time on or after the anchor that the clock shows `at`
            // (minutes past the hour for "at :MM" with hours).
            const wall = wallClock(zone, anchor);
            start = Number.POSITIVE_INFINITY;
            for (let h = 0; h <= 48 && start === Number.POSITIVE_INFINITY; h++) {
                const candidate = wallOfNaive(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour + h));
                if (!cadence.pastHour && candidate.hour !== cadence.at.hour) {
                    continue;
                }
                const t = instantOf(zone, { ...candidate, minute: cadence.at.minute });
                if (t > anchor) {
                    start = t;
                }
            }
            if (start > after) {
                return start;
            }
        }
        // Without `at`, the first run is one period after the anchor.
        const periods = Math.max(1, Math.floor((after - start) / cadence.everyMs) + 1);
        return start + periods * cadence.everyMs;
    }
    if (cadence.kind === 'days') {
        const anchorWall = wallClock(zone, anchor);
        const at = cadence.at ?? {
            hour: anchorWall.hour,
            minute: anchorWall.minute,
        };
        let first = dayNumber(anchorWall);
        if (cadence.weekday !== undefined) {
            // Day 0 (1970-01-01) was a Thursday.
            const today = (first + 4) % 7;
            first += (cadence.weekday - today + 7) % 7;
        }
        const at0 = (day: number) => {
            const date = new Date(day * DAY);
            return instantOf(zone, {
                year: date.getUTCFullYear(),
                month: date.getUTCMonth() + 1,
                day: date.getUTCDate(),
                hour: at.hour,
                minute: at.minute,
            });
        };
        const from = dayNumber(wallClock(zone, Math.max(after, anchor)));
        let k = Math.max(0, Math.floor((from - first) / cadence.every) - 1);
        for (let tries = 0; tries < 6; tries++, k++) {
            const t = at0(first + k * cadence.every);
            if (t > after && t > anchor) {
                return t;
            }
        }
        return null;
    }
    return nextCron(cadence, zone, Math.max(after, anchor));
}

function nextCron(cron: Extract<Cadence, { kind: 'cron' }>, zone: string, after: number): number | null {
    const dayMatches = (t: number) => {
        const d = new Date(t);
        const dom = cron.dom.has(d.getUTCDate());
        const dow = cron.dow.has(d.getUTCDay());
        if (cron.domAll && cron.dowAll) {
            return true;
        }
        if (cron.domAll) {
            return dow;
        }
        if (cron.dowAll) {
            return dom;
        }
        return dom || dow;
    };
    // Search the zone's wall clock (as a naive UTC calendar), field by field.
    let t = naive(wallClock(zone, after)) + MINUTE;
    const limit = t + 5 * 366 * DAY;
    for (let steps = 0; t < limit && steps < 200_000; steps++) {
        const d = new Date(t);
        if (!cron.month.has(d.getUTCMonth() + 1)) {
            t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
            continue;
        }
        if (!dayMatches(t)) {
            t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
            continue;
        }
        if (!cron.hour.has(d.getUTCHours())) {
            t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
            continue;
        }
        if (!cron.minute.has(d.getUTCMinutes())) {
            t += MINUTE;
            continue;
        }
        const instant = instantOf(zone, wallOfNaive(t));
        if (instant > after) {
            return instant;
        }
        t += MINUTE;
    }
    return null;
}

/**
 * The shortest time between two runs, over the next `samples` runs from
 * `from` (the exact period for fixed intervals). The minimum-interval rule
 * checks it; the store also never runs a schedule sooner than that rule
 * after its previous run.
 */
export function shortestGap(cadence: Cadence, zone: string, from: number, samples = 200): number {
    if (cadence.kind === 'interval') {
        return cadence.everyMs;
    }
    if (cadence.kind === 'days') {
        return cadence.every * DAY - HOUR;
    }
    let previous = nextRun(cadence, zone, from, from);
    let gap = Number.POSITIVE_INFINITY;
    for (let i = 0; previous !== null && i < samples; i++) {
        const next = nextRun(cadence, zone, previous, from);
        if (next === null) {
            break;
        }
        gap = Math.min(gap, next - previous);
        previous = next;
    }
    return gap;
}

/** The cadence as shown and stored: normalized, with its zone. */
export function describeCadence(cadence: Cadence, zone: string) {
    return `${cadence.text} (${zone})`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
];
const listed = (items: string[]) =>
    items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
/** Evenly spaced values from 0 (`*\/15`): the step; else undefined. */
function stepOf(values: ReadonlySet<number>, size: number) {
    const sorted = [...values].sort((a, b) => a - b);
    const step = sorted[1] - sorted[0];
    return sorted.length > 1 &&
        sorted[0] === 0 &&
        size % step === 0 &&
        sorted.length === size / step &&
        sorted.every((value, index) => value === index * step)
        ? step
        : undefined;
}

/**
 * A cadence in words, for people (the schedule's details, CB-88): phrases
 * as written (`Every day at 09:00`), and crons spelled out where they are
 * common (`Every weekday at 09:00`, `Every 15 minutes`); any other cron
 * as itself.
 */
export function cadenceInWords(text: string): string {
    let cadence: Cadence;
    try {
        cadence = parseCadence(text);
    } catch {
        return text;
    }
    if (cadence.kind !== 'cron') {
        return (cadence.text.charAt(0).toUpperCase() + cadence.text.slice(1)).replace(/\b[a-z]+day\b/, (day) =>
            DAY_NAMES.includes(day.charAt(0).toUpperCase() + day.slice(1))
                ? day.charAt(0).toUpperCase() + day.slice(1)
                : day,
        );
    }
    const minutes = [...cadence.minute].sort((a, b) => a - b);
    const hours = [...cadence.hour].sort((a, b) => a - b);
    const allHours = hours.length === 24;
    const minuteStep = stepOf(cadence.minute, 60);
    const times =
        allHours && minutes.length === 1
            ? minutes[0] === 0
                ? 'every hour'
                : `every hour at :${pad(minutes[0])}`
            : allHours && minuteStep
              ? `every ${minuteStep} minutes`
              : minutes.length * hours.length <= 4
                ? `at ${listed(hours.flatMap((hour) => minutes.map((minute) => clock({ hour, minute }))))}`
                : undefined;
    if (!times) {
        return `Cron: ${cadence.text}`;
    }
    const dow = [...cadence.dow].sort((a, b) => a - b);
    const dom = [...cadence.dom].sort((a, b) => a - b);
    const weekdays = dow.join() === '1,2,3,4,5' ? 'weekday' : listed(dow.map((day) => DAY_NAMES[day]));
    const monthDays = `on day ${listed(dom.map(String))} of the month`;
    const months =
        cadence.month.size === 12
            ? ''
            : `in ${listed([...cadence.month].sort((a, b) => a - b).map((month) => MONTH_NAMES[month - 1]))}`;
    // "Every weekday at 09:00", "On day 1 of the month at 00:00", "Every
    // 15 minutes on Monday".
    const days = cadence.dowAll
        ? cadence.domAll
            ? ''
            : monthDays
        : cadence.domAll
          ? `${times.startsWith('at ') ? 'every' : 'on'} ${weekdays}${times.startsWith('at ') || weekdays !== 'weekday' ? '' : 's'}`
          : `${monthDays} or on ${weekdays}${weekdays === 'weekday' ? 's' : ''}`;
    const words = times.startsWith('at ') ? [days || 'every day', times, months] : [times, days, months];
    const said = words.filter(Boolean).join(' ');
    return said.charAt(0).toUpperCase() + said.slice(1);
}
