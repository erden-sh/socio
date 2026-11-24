import type { AgentRunStatus } from '../types.js';

import type { AnalyticsSettings } from './operations-analytics.js';
import type { ResourcePolicy } from './operations-resources.js';

/**
 * Operations (CB-164): what the client and the server share about the
 * admins' dashboard. One range and filter state, kept in the page's
 * address so a view can be shared (`readOpsQuery`, `opsSearch`); the
 * window it names, cut in the workspace's reporting time zone
 * (`opsWindow`); and the answers the `/api/operations/*` routes give.
 */

/** The ranges the range bar offers, newest data last. */
export const OPS_RANGES = ['24h', '7d', '30d', '90d', '12m', 'all'] as const;
export type OpsRange = (typeof OPS_RANGES)[number];
export const DEFAULT_OPS_RANGE: OpsRange = '7d';
export const OPS_RANGE_LABELS: Record<OpsRange, string> = {
    '24h': '24 hours',
    '7d': '7 days',
    '30d': '30 days',
    '90d': '90 days',
    '12m': '12 months',
    all: 'All time',
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RANGE_MS: Record<Exclude<OpsRange, 'all'>, number> = {
    '24h': DAY,
    '7d': 7 * DAY,
    '30d': 30 * DAY,
    '90d': 90 * DAY,
    '12m': 365 * DAY,
};

/** How a chart's points are cut, finest first. */
export const OPS_BUCKETS = ['hour', 'day', 'week', 'month'] as const;
export type OpsBucket = (typeof OPS_BUCKETS)[number];
export const OPS_BUCKET_LABELS: Record<OpsBucket, string> = {
    hour: 'By hour',
    day: 'By day',
    week: 'By week',
    month: 'By month',
};
/** Hourly points for ranges up to 30 days, daily up to two years. */
const HOURLY_UP_TO = 30 * DAY;
const DAILY_UP_TO = 731 * DAY;
/** Hourly by default up to 7 days. */
const HOURLY_DEFAULT_UP_TO = 7 * DAY;

/**
 * What a view can be narrowed to. Each is one id: a socio, a person, a
 * Space, or a source key from the source registry (web, telegram, …).
 */
export const OPS_FILTERS = ['socio', 'person', 'space', 'source'] as const;
export type OpsFilter = (typeof OPS_FILTERS)[number];
export type OpsFilters = Partial<Record<OpsFilter, string>>;
export const OPS_FILTER_LABELS: Record<OpsFilter, string> = {
    socio: 'Socio',
    person: 'Person',
    space: 'Space',
    source: 'Source',
};
// Ids and source keys: printable, no spaces, not too long.
const FILTER_VALUE = /^[\w.:@+-]{1,128}$/;

/**
 * The range and filters as the address has them: a named `range`, or a
 * custom one from `from` (and `to`, else now). Each bound is a day
 * (`2026-10-01`, in the reporting time zone; `to` takes the whole day) or
 * an instant with its offset (`2026-10-01T14:00:00Z`, a chart's hour).
 */
export interface OpsQuery {
    range: OpsRange;
    from?: string;
    to?: string;
    /** A coarser cut than the default, when the window allows it. */
    bucket?: OpsBucket;
    filters: OpsFilters;
}

export const DEFAULT_OPS_QUERY: OpsQuery = {
    range: DEFAULT_OPS_RANGE,
    filters: {},
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const validBound = (value: string) =>
    (DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))) ||
    (INSTANT.test(value) && !Number.isNaN(Date.parse(value)));

const isOneOf = <T extends string>(list: readonly T[], value: string): value is T =>
    (list as readonly string[]).includes(value);

/**
 * The range and filters in `params`, and the names of those it had to
 * leave out (the server answers 400 for them; the page drops them).
 * Other parameters (a list's `cursor`, a section's own) are ignored.
 */
export function readOpsQuery(params: URLSearchParams): {
    query: OpsQuery;
    invalid: string[];
} {
    const invalid: string[] = [];
    const query: OpsQuery = { range: DEFAULT_OPS_RANGE, filters: {} };
    const range = params.get('range');
    if (range !== null) {
        if (isOneOf(OPS_RANGES, range)) {
            query.range = range;
        } else {
            invalid.push('range');
        }
    }
    const from = params.get('from');
    const to = params.get('to');
    if (from !== null || to !== null) {
        if (from === null || !validBound(from)) {
            invalid.push('from');
        } else if (to !== null && !validBound(to)) {
            invalid.push('to');
        } else {
            query.from = from;
            if (to !== null) {
                query.to = to;
            }
        }
    }
    const bucket = params.get('bucket');
    if (bucket !== null) {
        if (isOneOf(OPS_BUCKETS, bucket)) {
            query.bucket = bucket;
        } else {
            invalid.push('bucket');
        }
    }
    for (const name of OPS_FILTERS) {
        const value = params.get(name);
        if (value === null) {
            continue;
        }
        if (FILTER_VALUE.test(value)) {
            query.filters[name] = value;
        } else {
            invalid.push(name);
        }
    }
    return { query, invalid };
}

/**
 * The query as an address's search (`?range=30d&socio=d1`, or '' for the
 * default), always in the same order, so equal views have equal links.
 * A custom range leaves `range` out.
 */
export function opsSearch(query: OpsQuery): string {
    const params = new URLSearchParams();
    if (query.from) {
        params.set('from', query.from);
        if (query.to) {
            params.set('to', query.to);
        }
    } else if (query.range !== DEFAULT_OPS_RANGE) {
        params.set('range', query.range);
    }
    if (query.bucket) {
        params.set('bucket', query.bucket);
    }
    for (const name of OPS_FILTERS) {
        const value = query.filters[name];
        if (value) {
            params.set(name, value);
        }
    }
    const text = params.toString();
    return text ? `?${text}` : '';
}

/** The window a query names, as the server answers it and charts it. */
export interface OpsWindow {
    /** Start, inclusive (ms); null for all time. */
    from: number | null;
    /** End, exclusive (ms). */
    to: number;
    bucket: OpsBucket;
    /** The cuts this window may use, finest first. */
    buckets: OpsBucket[];
    /** The period of the same length just before, for each tile's change. */
    previous: { from: number; to: number } | null;
    /** The reporting time zone days are cut in. */
    timeZone: string;
}

/**
 * The cuts a window of `span` ms may use (null: all time, its span not
 * known): hourly up to 30 days, daily up to two years, and any coarser.
 */
export function opsBuckets(span: number | null): OpsBucket[] {
    const finest =
        span !== null && span <= HOURLY_UP_TO ? 'hour' : span !== null && span <= DAILY_UP_TO ? 'day' : 'week';
    return OPS_BUCKETS.slice(OPS_BUCKETS.indexOf(finest));
}

/** Hourly up to 7 days, then the finest the window may use. */
const defaultBucket = (span: number | null): OpsBucket =>
    span !== null && span <= HOURLY_DEFAULT_UP_TO ? 'hour' : opsBuckets(span).find((bucket) => bucket !== 'hour')!;

/**
 * The window of a query at `now`: a named range ends now, a custom one at
 * its `to` (the end of that day) or now. All time starts at `earliest`
 * (the oldest data) when it is known. The query's bucket is used only
 * when the window allows it.
 */
export function opsWindow(
    query: OpsQuery,
    { now, timeZone, earliest = null }: { now: number; timeZone: string; earliest?: number | null },
): OpsWindow {
    let from: number | null;
    let to = now;
    if (query.from) {
        from = boundAt(query.from, timeZone, false);
        if (query.to) {
            to = boundAt(query.to, timeZone, true);
            // A backwards custom range is read the right way round, both days in.
            if (to <= from) {
                from = boundAt(query.to, timeZone, false);
                to = boundAt(query.from, timeZone, true);
            }
        }
    } else if (query.range === 'all') {
        from = earliest;
    } else {
        from = now - RANGE_MS[query.range];
    }
    const span = from === null ? null : to - from;
    const buckets = opsBuckets(span);
    const bucket = query.bucket && buckets.includes(query.bucket) ? query.bucket : defaultBucket(span);
    return {
        from,
        to,
        bucket,
        buckets,
        previous: from === null || query.range === 'all' ? null : { from: from - (to - from), to: from },
        timeZone,
    };
}

/** A custom bound as an instant: a day's start, or with `end` the next day's. */
function boundAt(value: string, timeZone: string, end: boolean) {
    if (!DATE.test(value)) {
        return Date.parse(value);
    }
    const [year, month, day] = value.split('-').map(Number) as [number, number, number];
    return zonedTime(year, month, day + (end ? 1 : 0), 0, timeZone);
}

// One formatter per time zone: building them is slow.
const formatters = new Map<string, Intl.DateTimeFormat>();
function partsFormat(timeZone: string) {
    let format = formatters.get(timeZone);
    if (!format) {
        format = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
            weekday: 'short',
        });
        formatters.set(timeZone, format);
    }
    return format;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The wall clock in `timeZone` at `at`; `weekday` 0 is Monday. */
export function zonedParts(at: number, timeZone: string) {
    const parts: Record<string, string> = {};
    for (const part of partsFormat(timeZone).formatToParts(new Date(at))) {
        parts[part.type] = part.value;
    }
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        second: Number(parts.second),
        weekday: WEEKDAYS.indexOf(parts.weekday!),
    };
}

/** How far `timeZone`'s wall clock is ahead of UTC at `at`, in ms. */
function offsetAt(at: number, timeZone: string) {
    const p = zonedParts(at, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}

/**
 * The instant a wall-clock hour in `timeZone` starts. Days and months past
 * their end roll over (day 32 is the next month's 1st). An hour a clock
 * change skips is read with the offset before the change.
 */
export function zonedTime(year: number, month: number, day: number, hour: number, timeZone: string) {
    const wall = Date.UTC(year, month - 1, day, hour);
    const guess = wall - offsetAt(wall, timeZone);
    return wall - offsetAt(guess, timeZone);
}

/** The start of the bucket `at` falls in; weeks start on Monday. */
export function bucketStart(at: number, bucket: OpsBucket, timeZone: string) {
    const p = zonedParts(at, timeZone);
    switch (bucket) {
        case 'hour':
            return zonedTime(p.year, p.month, p.day, p.hour, timeZone);
        case 'day':
            return zonedTime(p.year, p.month, p.day, 0, timeZone);
        case 'week':
            return zonedTime(p.year, p.month, p.day - p.weekday, 0, timeZone);
        case 'month':
            return zonedTime(p.year, p.month, 1, 0, timeZone);
    }
}

/** The start of the bucket after the one starting at `start`. */
export function nextBucket(start: number, bucket: OpsBucket, timeZone: string) {
    if (bucket === 'hour') {
        return start + HOUR;
    }
    const p = zonedParts(start, timeZone);
    if (bucket === 'month') {
        return zonedTime(p.year, p.month + 1, 1, 0, timeZone);
    }
    const days = bucket === 'week' ? 7 : 1;
    return zonedTime(p.year, p.month, p.day + days, 0, timeZone);
}

/** The most points a series has; a longer window gets a coarser cut. */
export const OPS_MAX_POINTS = 1000;

/** The starts of the buckets that cover `from`..`to`, oldest first. */
export function bucketStarts(from: number, to: number, bucket: OpsBucket, timeZone: string) {
    const starts: number[] = [];
    for (
        let at = bucketStart(from, bucket, timeZone);
        at < to && starts.length < OPS_MAX_POINTS;
        at = nextBucket(at, bucket, timeZone)
    ) {
        starts.push(at);
    }
    return starts;
}

/**
 * What an admin saves under `settings.operations` (Operations → Settings),
 * only the ones changed: the reporting time zone over the server's
 * (`OPS_TIME_ZONE`), and the analytics store's limits over the `OPS_*` env
 * defaults (CB-186, `analyticsInForce`).
 */
export interface OperationsSettings {
    /** The reporting time zone days are cut in: an IANA name. */
    timeZone?: string;
    /** The gap that ends a session, in minutes (CB-190, `OPS_SESSION_GAP_MINUTES`). */
    sessionGapMinutes?: number;
    analytics?: Partial<AnalyticsSettings>;
    resources?: Partial<ResourcePolicy>;
    /** The daily price sync (CB-195), over `OPS_PRICE_SYNC`. */
    pricing?: { sync?: boolean };
}

/** What Operations → Settings shows: what is in force, and the server's. */
export interface OperationsSettingsView {
    timeZone: string;
    sessionGapMinutes: number;
    defaults: { timeZone: string; sessionGapMinutes: number };
}

/**
 * How the analytics store is doing, as its client's `health()` says
 * (CB-186): `unavailable` while it is off or down (and until it is
 * wired), so the dashboard says so instead of showing zeros.
 */
export type OpsState = 'unavailable' | 'starting' | 'rebuilding' | 'ready';
export interface OpsStatus {
    state: OpsState;
    /** When the store last caught up with SQLite ("Data as of …"). */
    asOf: number | null;
    /** The oldest data it holds, which starts "All time". */
    earliest: number | null;
    /** While rebuilding: how far, 0 to 100. */
    progress?: number;
}

/** The Overview's tiles. */
export const OPS_TILES = ['turns', 'failed', 'people', 'messages', 'chats', 'tokens'] as const;
export type OpsTileId = (typeof OPS_TILES)[number];
export const OPS_TILE_LABELS: Record<OpsTileId, string> = {
    turns: 'Turns',
    failed: 'Failed turns',
    people: 'Active people',
    messages: 'Messages from people',
    chats: 'Chats with activity',
    tokens: 'Tokens',
};
/** For each, whether more is better (a tile's change is colored by it). */
export const OPS_TILE_UP_IS_GOOD: Record<OpsTileId, boolean> = {
    turns: true,
    failed: false,
    people: true,
    messages: true,
    chats: true,
    tokens: true,
};

/** A tile: its value in the window and in the period before; null: no data. */
export interface OpsTile {
    id: OpsTileId;
    value: number | null;
    previous: number | null;
}

/** What every answer carries: the store's status and the window it read. */
export interface OpsAnswer {
    status: OpsStatus;
    window: OpsWindow;
}

export interface OpsOverview extends OpsAnswer {
    tiles: OpsTile[];
}

/** The metrics a series can chart. */
export const OPS_METRICS = ['turns', 'failed', 'messages', 'people', 'tokens'] as const;
export type OpsMetric = (typeof OPS_METRICS)[number];

export interface OpsPoint {
    /** The bucket's start. */
    at: number;
    value: number;
}
export interface OpsSeries extends OpsAnswer {
    metric: OpsMetric;
    /** Every bucket in the window, empty ones as 0. */
    points: OpsPoint[];
}

/**
 * One page of a drill-down list (`GET …?cursor=&limit=`): `next` is the
 * opaque cursor for the page after, null at the end. Keyset, newest
 * first: no offsets, no page numbers.
 */
export interface CursorPage<T> {
    items: T[];
    next: string | null;
}
export const OPS_PAGE_LIMIT = { default: 50, max: 200 } as const;

/** A turn in a drill-down list: who, where and how it went, no content. */
export interface OpsTurnRow {
    runId: string;
    threadId: string;
    socioId: string;
    socioName: string | null;
    /** The source registry's key (web, telegram, scheduled, …). */
    source: string;
    status: AgentRunStatus;
    startedAt: number;
    finishedAt: number | null;
    tokens: number;
    toolCalls: number;
    toolErrors: number;
}
