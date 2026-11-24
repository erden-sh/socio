import type { DuckDBConnection } from '@duckdb/node-api';

import { rows } from '../infra/duckdb/open.js';
import { setMeta } from '../infra/duckdb/schema.js';

import { append } from './append.js';
import { calendarRows } from './calendar.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How far the calendar reaches past the facts, so most cycles add none. */
const AHEAD = 7 * DAY;

/** What the rollups follow: the reporting time zone and retention. */
export interface RollupSettings {
    timeZone: string;
    /** Hourly rollups older than this many days are dropped. */
    hourlyDays: number;
    now: number;
}

async function meta(duck: DuckDBConnection) {
    const list = await rows<{ key: string; value: string }>(
        duck,
        `SELECT key, value FROM ops_meta WHERE key IN ('rollup_tz', 'cal_from', 'cal_to', 'hourly_from')`,
    );
    return Object.fromEntries(list.map(({ key, value }) => [key, value]));
}

async function addCalendar(duck: DuckDBConnection, from: number, to: number, timeZone: string) {
    if (to <= from) {
        return;
    }
    await append(
        duck,
        'd_calendar',
        calendarRows(from, to, timeZone).map((row) => [row.utcAt, row.hourAt, row.dayAt, row.weekAt, row.monthAt]),
    );
}

/** The oldest and newest fact times, if there are facts. */
async function factSpan(duck: DuckDBConnection) {
    const [span] = await rows<{ lo: number | null; hi: number | null }>(
        duck,
        `SELECT least((SELECT min(started_at) FROM f_turn), (SELECT min(sent_at) FROM f_message)) AS lo,
      greatest((SELECT max(started_at) FROM f_turn), (SELECT max(sent_at) FROM f_message)) AS hi`,
    );
    return span?.lo == null || span.hi == null ? undefined : { lo: span.lo, hi: span.hi };
}

/**
 * Keeps the calendar covering `lo`..`hi` (and a week ahead) in the
 * reporting time zone. When the zone changed, the calendar is made again
 * and every rollup recomputed from the facts. Inside the caller's
 * transaction.
 */
export async function syncRollups(
    duck: DuckDBConnection,
    settings: RollupSettings,
    touched?: { lo: number; hi: number },
) {
    const known = await meta(duck);
    const span = await factSpan(duck);
    const hourlyFrom = settings.hourlyDays ? settings.now - settings.hourlyDays * DAY : (span?.lo ?? settings.now);
    const want = {
        lo: Math.min(touched?.lo ?? Infinity, span?.lo ?? Infinity, hourlyFrom) - 2 * DAY,
        hi: Math.max(touched?.hi ?? 0, span?.hi ?? 0, settings.now) + DAY,
    };
    if (known.rollup_tz !== settings.timeZone) {
        await duck.run('DELETE FROM d_calendar');
        await duck.run('DELETE FROM r_hourly');
        await duck.run('DELETE FROM r_daily');
        const from = Math.floor(want.lo / DAY) * DAY;
        const to = want.hi + AHEAD;
        await addCalendar(duck, from, to, settings.timeZone);
        await setMeta(duck, 'rollup_tz', settings.timeZone);
        await setMeta(duck, 'cal_from', String(from));
        await setMeta(duck, 'cal_to', String(to));
        await setMeta(duck, 'hourly_from', String(await hourKey(duck, hourlyFrom)));
        if (span) {
            await recompute(duck, span.lo, span.hi);
        }
        return;
    }
    const from = Number(known.cal_from);
    const to = Number(known.cal_to);
    if (want.lo < from) {
        const start = Math.floor(want.lo / DAY) * DAY;
        await addCalendar(duck, start, from, settings.timeZone);
        await setMeta(duck, 'cal_from', String(start));
    }
    if (want.hi > to) {
        await addCalendar(duck, to, want.hi + AHEAD, settings.timeZone);
        await setMeta(duck, 'cal_to', String(want.hi + AHEAD));
    }
    // Hourly rollups for `hourlyDays`: older ones go; when the setting
    // grows, the hours it brings back are recomputed from the facts.
    const keep = await hourKey(duck, hourlyFrom);
    const kept = Number(known.hourly_from);
    if (keep !== kept) {
        await duck.run('DELETE FROM r_hourly WHERE hour_at < $1', [keep]);
        await setMeta(duck, 'hourly_from', String(keep));
        if (keep < kept && span) {
            await recompute(duck, keep, Math.min(kept, span.hi));
        }
    }
    if (touched) {
        await recompute(duck, touched.lo, touched.hi);
    }
}

/** The start of the hour `at` falls in, by the calendar. */
async function hourKey(duck: DuckDBConnection, at: number) {
    const [row] = await rows<{ k: number }>(
        duck,
        'SELECT hour_at AS k FROM d_calendar WHERE utc_at <= $1 ORDER BY utc_at DESC LIMIT 1',
        [at],
    );
    return row?.k ?? at;
}

/** The facts the rollups add up, one row per turn or person message. */
const FACT_ROWS = `SELECT started_at AS ts, socio_id, source,
    CASE WHEN trigger_kind = 'person' THEN trigger_id END AS person_id,
    1 AS turns, CASE WHEN status = 'failed' THEN 1 ELSE 0 END AS failed,
    COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) AS tokens,
    0 AS messages
  FROM f_turn WHERE started_at >= $1 AND started_at < $2
  UNION ALL
  SELECT sent_at, socio_id, source, author_id, 0, 0, 0, 1
  FROM f_message WHERE author_kind = 'person' AND sent_at >= $1 AND sent_at < $2`;

/**
 * Recomputes the hourly and daily rollups of every bucket that holds an
 * instant in `lo`..`hi`, from the facts: delete and insert per bucket, so
 * running it again changes nothing.
 */
export async function recompute(duck: DuckDBConnection, lo: number, hi: number) {
    const [keys] = await rows<{
        hour_lo: number | null;
        hour_hi: number | null;
        day_lo: number | null;
        day_hi: number | null;
        hourly_from: string | null;
    }>(
        duck,
        `SELECT
      (SELECT hour_at FROM d_calendar WHERE utc_at <= $1 ORDER BY utc_at DESC LIMIT 1) AS hour_lo,
      (SELECT hour_at FROM d_calendar WHERE utc_at <= $2 ORDER BY utc_at DESC LIMIT 1) AS hour_hi,
      (SELECT day_at FROM d_calendar WHERE utc_at <= $1 ORDER BY utc_at DESC LIMIT 1) AS day_lo,
      (SELECT day_at FROM d_calendar WHERE utc_at <= $2 ORDER BY utc_at DESC LIMIT 1) AS day_hi,
      (SELECT value FROM ops_meta WHERE key = 'hourly_from') AS hourly_from`,
        [lo, hi],
    );
    if (!keys || keys.day_lo === null || keys.day_hi === null) {
        return;
    }
    // The instants of those days, whole: the facts to add up.
    const [span] = await rows<{ start: number | null; end: number | null }>(
        duck,
        `SELECT (SELECT min(utc_at) FROM d_calendar WHERE day_at = $1) AS start,
      (SELECT min(utc_at) FROM d_calendar WHERE day_at > $2) AS "end"`,
        [keys.day_lo, keys.day_hi],
    );
    const start = span?.start ?? lo;
    const end = span?.end ?? Number.MAX_SAFE_INTEGER;
    await duck.run('DELETE FROM r_daily WHERE day_at BETWEEN $1 AND $2', [keys.day_lo, keys.day_hi]);
    await duck.run(
        `INSERT INTO r_daily
    SELECT c.day_at, any_value(c.week_at), any_value(c.month_at), f.socio_id,
      f.source, f.person_id, sum(f.turns)::INTEGER, sum(f.failed)::INTEGER,
      sum(f.tokens)::BIGINT, sum(f.messages)::INTEGER
    FROM (${FACT_ROWS}) f ASOF JOIN d_calendar c ON f.ts >= c.utc_at
    WHERE c.day_at BETWEEN $3 AND $4
    GROUP BY c.day_at, f.socio_id, f.source, f.person_id`,
        [start, end, keys.day_lo, keys.day_hi],
    );
    const hourLo = Math.max(keys.hour_lo ?? 0, Number(keys.hourly_from ?? 0));
    const hourHi = keys.hour_hi ?? 0;
    if (hourHi < hourLo) {
        return;
    }
    await duck.run('DELETE FROM r_hourly WHERE hour_at BETWEEN $1 AND $2', [hourLo, hourHi]);
    await duck.run(
        `INSERT INTO r_hourly
    SELECT c.hour_at, f.socio_id, f.source, f.person_id, sum(f.turns)::INTEGER,
      sum(f.failed)::INTEGER, sum(f.tokens)::BIGINT, sum(f.messages)::INTEGER
    FROM (${FACT_ROWS}) f ASOF JOIN d_calendar c ON f.ts >= c.utc_at
    WHERE c.hour_at BETWEEN $3 AND $4
    GROUP BY c.hour_at, f.socio_id, f.source, f.person_id`,
        [start, end, hourLo, hourHi],
    );
}
