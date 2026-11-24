/**
 * The calendar plugin's own words (CB-254), shared by its server side, its
 * tools and its page. Stored times are UTC epoch milliseconds; every event
 * also keeps the wall-clock times it was given and the IANA zone they are
 * in, so an event at 9:00 in New York stays at 9:00 there across a clock
 * change, and a person in another zone sees the same instant.
 */

export const CALENDAR_PLUGIN_ID = 'calendar';

export const EVENT_STATUSES = ['confirmed', 'tentative', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EVENT_STATUS_LABEL: Record<EventStatus, string> = {
    confirmed: 'Confirmed',
    tentative: 'Hold',
    cancelled: 'Canceled',
};

/**
 * `workspace`: everyone who may open the calendar sees it. `private`: only
 * the person who created it (an admin does not see someone else's).
 */
export const EVENT_VISIBILITIES = ['workspace', 'private'] as const;
export type EventVisibility = (typeof EVENT_VISIBILITIES)[number];

/** Limits of one event's fields. */
export const EVENT_LIMITS = {
    title: 200,
    description: 8000,
    location: 200,
    source: 40,
    sourceId: 200,
    sourceUrl: 2000,
} as const;

/** The longest event, and the widest range one list returns. */
export const MAX_EVENT_DAYS = 366;
export const MAX_RANGE_DAYS = 400;
export const MAX_LIST = 500;

/** An event as the calendar's routes, tools and page see it. */
export interface CalendarEventView {
    id: string;
    title: string;
    description: string;
    location: string;
    status: EventStatus;
    allDay: boolean;
    /** IANA zone the local times are in. */
    timeZone: string;
    /** ISO instants (UTC). An all-day event starts at midnight in `timeZone`. */
    start: string;
    end: string;
    startAt: number;
    endAt: number;
    /**
     * Wall-clock times in `timeZone`: `YYYY-MM-DDTHH:mm`, or `YYYY-MM-DD`
     * for an all-day event, whose `endLocal` is its last day (inclusive).
     */
    startLocal: string;
    endLocal: string;
    /** Where it was copied from (`notion`) and that system's id, for dedupe. */
    source: string;
    sourceId: string;
    sourceUrl: string;
    visibility: EventVisibility;
    createdBy: { id: string; name: string };
    /** The connected agent or socio that created it, when one did. */
    createdVia: string;
    updatedBy: { id: string; name: string };
    createdAt: string;
    updatedAt: string;
    /** Whether the person asking may change or delete it. */
    canEdit: boolean;
}

/** What the calendar page loads. */
export interface CalendarState {
    events: CalendarEventView[];
    /** The calendar's zone: the install's setting, else the workspace's. */
    timeZone: string;
    /** Whether this person may add events. */
    canWrite: boolean;
    /** The person's own subscription feed, when they made one. */
    feed: { active: boolean; createdAt?: string };
    now: number;
}

/** A new event, from a tool, the page or a sync. */
export interface CalendarEventInput {
    title: string;
    start: string;
    end?: string;
    allDay?: boolean;
    timeZone?: string;
    location?: string;
    description?: string;
    status?: EventStatus;
    visibility?: EventVisibility;
    source?: string;
    sourceId?: string;
    sourceUrl?: string;
}

export class CalendarInputError extends Error {}

const pad = (value: number, size = 2) => String(value).padStart(size, '0');

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
    let format = formatters.get(timeZone);
    if (!format) {
        format = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            weekday: 'short',
            hourCycle: 'h23',
        });
        formatters.set(timeZone, format);
    }
    return format;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The wall clock in `timeZone` at `at`; `weekday` 0 is Monday. */
export function wallClock(at: number, timeZone: string) {
    const parts: Record<string, string> = {};
    for (const part of formatter(timeZone).formatToParts(new Date(at))) {
        parts[part.type] = part.value;
    }
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour) % 24,
        minute: Number(parts.minute),
        second: Number(parts.second),
        weekday: WEEKDAYS.indexOf(parts.weekday!),
    };
}

/** How far `timeZone`'s wall clock is ahead of UTC at `at`, in ms. */
function offsetAt(at: number, timeZone: string) {
    const p = wallClock(at, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}

/**
 * The instant a wall-clock minute in `timeZone` is. Days and months past
 * their end roll over. A time a clock change skips (2:30 on the spring
 * change in New York) is read with the offset before the change, so it
 * lands an hour later; a time that happens twice (1:30 on the autumn
 * change) is the first of the two.
 */
export function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string) {
    const wall = Date.UTC(year, month - 1, day, hour, minute);
    const before = offsetAt(wall - 86_400_000, timeZone);
    const after = offsetAt(wall + 86_400_000, timeZone);
    // Try the larger offset first: of two readings it is the earlier instant.
    const offsets = before >= after ? [before, after] : [after, before];
    for (const offset of offsets) {
        const at = wall - offset;
        if (offsetAt(at, timeZone) === offset) {
            return at;
        }
    }
    // Skipped: the offset before the change.
    return wall - before;
}

/** `YYYY-MM-DD` of an instant in `timeZone`. */
export function dayKeyIn(at: number, timeZone: string) {
    const p = wallClock(at, timeZone);
    return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** `YYYY-MM-DDTHH:mm` of an instant in `timeZone`. */
export function localStampIn(at: number, timeZone: string) {
    const p = wallClock(at, timeZone);
    return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** A `YYYY-MM-DD` key moved by whole days. */
export function addDaysToKey(key: string, days: number) {
    const [year, month, day] = key.split('-').map(Number);
    const date = new Date(Date.UTC(year!, month! - 1, day! + days));
    return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Midnight at the start of a `YYYY-MM-DD` day in `timeZone`. */
export function dayStart(key: string, timeZone: string) {
    const [year, month, day] = key.split('-').map(Number);
    return zonedInstant(year!, month!, day!, 0, 0, timeZone);
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?$/;
const ABSOLUTE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

function validDate(year: number, month: number, day: number) {
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day &&
        year >= 1970 &&
        year <= 9999
    );
}

/**
 * A time as an instant: an ISO time with `Z` or an offset is that instant;
 * `YYYY-MM-DDTHH:mm` is a wall-clock time in `timeZone`. Undefined for
 * anything else (a bare date is not a time).
 */
export function parseEventTime(value: string, timeZone: string) {
    const text = value.trim();
    if (ABSOLUTE.test(text)) {
        const at = Date.parse(text.replace(' ', 'T'));
        return Number.isFinite(at) ? at : undefined;
    }
    const local = LOCAL.exec(text);
    if (!local) {
        return undefined;
    }
    const [year, month, day, hour, minute] = local.slice(1, 6).map(Number) as [number, number, number, number, number];
    if (!validDate(year, month, day) || hour > 23 || minute > 59) {
        return undefined;
    }
    return zonedInstant(year, month, day, hour, minute, timeZone);
}

/** `YYYY-MM-DD`, or the date part of a time, as a day key. */
export function parseEventDay(value: string) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
    if (!match) {
        return undefined;
    }
    const [year, month, day] = match.slice(1, 4).map(Number) as [number, number, number];
    return validDate(year, month, day) ? match[0] : undefined;
}

/** The stored times of an event. */
export interface EventTimes {
    allDay: boolean;
    timeZone: string;
    startAt: number;
    endAt: number;
    startLocal: string;
    endLocal: string;
}

/**
 * The times an event input names, in `timeZone`. A timed event's `end`
 * defaults to an hour after its start; an all-day event's `end` is its
 * last day (inclusive) and defaults to its first. Throws
 * `CalendarInputError` with a sentence an agent can act on.
 */
export function eventTimes(input: { start: string; end?: string; allDay?: boolean; timeZone: string }): EventTimes {
    const { timeZone } = input;
    const allDay = input.allDay ?? DATE.test(input.start.trim());
    let startAt: number;
    let endAt: number;
    let startLocal: string;
    let endLocal: string;
    if (allDay) {
        const first = parseEventDay(input.start);
        if (!first) {
            throw new CalendarInputError('An all-day event’s start is a date, YYYY-MM-DD.');
        }
        const last = input.end ? parseEventDay(input.end) : first;
        if (!last) {
            throw new CalendarInputError('An all-day event’s end is its last day, YYYY-MM-DD.');
        }
        if (last < first) {
            throw new CalendarInputError('An all-day event’s last day is before its first.');
        }
        startAt = dayStart(first, timeZone);
        endAt = dayStart(addDaysToKey(last, 1), timeZone);
        startLocal = first;
        endLocal = last;
    } else {
        const start = parseEventTime(input.start, timeZone);
        if (start === undefined) {
            throw new CalendarInputError(
                `Start must be YYYY-MM-DDTHH:mm in ${timeZone}, or an ISO time with Z or an offset.`,
            );
        }
        const end =
            input.end === undefined || input.end === '' ? start + 3_600_000 : parseEventTime(input.end, timeZone);
        if (end === undefined) {
            throw new CalendarInputError(
                `End must be YYYY-MM-DDTHH:mm in ${timeZone}, or an ISO time with Z or an offset.`,
            );
        }
        if (end <= start) {
            throw new CalendarInputError('An event must end after it starts.');
        }
        startAt = start;
        endAt = end;
        startLocal = localStampIn(start, timeZone);
        endLocal = localStampIn(end, timeZone);
    }
    if (endAt - startAt > MAX_EVENT_DAYS * 86_400_000) {
        throw new CalendarInputError(`An event can last at most ${MAX_EVENT_DAYS} days.`);
    }
    return { allDay, timeZone, startAt, endAt, startLocal, endLocal };
}

/**
 * The source a sync names, lowercased (`Notion` and `notion` are one).
 * Letters, digits, periods, dashes and underscores.
 */
export function normalizeSource(value: string | undefined) {
    const source = (value ?? '').trim().toLowerCase();
    if (!source) {
        return '';
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(source)) {
        throw new CalendarInputError(
            'Source is a short name such as notion: letters, digits, periods, dashes and underscores.',
        );
    }
    return source;
}

/**
 * The id an event is deduplicated on. A Notion page id is the same page
 * with or without dashes, in either case, or as its page URL, so all of
 * those become the 32 lowercase hex digits.
 */
export function normalizeSourceId(source: string, value: string | undefined) {
    const id = (value ?? '').trim();
    if (!id) {
        return '';
    }
    if (source === 'notion') {
        const bare = id.replace(/-/g, '').toLowerCase();
        if (/^[0-9a-f]{32}$/.test(bare)) {
            return bare;
        }
        const fromUrl = /([0-9a-f]{32})(?:[?#].*)?$/i.exec(id.replace(/-/g, ''));
        if (fromUrl) {
            return fromUrl[1]!.toLowerCase();
        }
    }
    return id;
}
