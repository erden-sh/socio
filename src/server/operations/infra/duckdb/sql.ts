/**
 * The analytics SQL's building blocks (CB-164), shared by every query
 * file of this folder: positional parameters, the filters, the rollups'
 * metadata and the calendar to bucket facts by. Split from
 * `ops-queries.ts`, which builds the queries from these and the query
 * files, so no query file imports it back.
 */
import { listValue, type DuckDBConnection } from '@duckdb/node-api';

import type { OpsBucket, OpsFilters, OpsWindow } from '@socio/shared/operations/operations';

import { append } from '../../etl/append.js';
import { calendarRows } from '../../etl/calendar.js';

import { rows } from './open.js';

/** Positional parameters, BIGINT for whole numbers. */
export class Sql {
    readonly values: (bigint | string | ReturnType<typeof listValue>)[] = [];
    private add(value: (typeof this.values)[number]) {
        this.values.push(value);
        return `$${this.values.length}`;
    }
    int(value: number) {
        return this.add(BigInt(Math.trunc(value)));
    }
    text(value: string) {
        return this.add(value);
    }
    ints(values: readonly number[]) {
        return this.add(listValue(values.map((value) => BigInt(value))));
    }
    texts(values: readonly string[]) {
        return this.add(listValue([...values]));
    }
}

export function range(sql: Sql, column: string, from: number | null, to: number) {
    return [...(from === null ? [] : [`${column} >= ${sql.int(from)}`]), `${column} < ${sql.int(to)}`];
}

/** A Space's turns are its socios'. */
export function spaceFilter(sql: Sql, column: string, space: string) {
    return `${column} IN (SELECT id FROM d_socio WHERE space_id = ${sql.text(space)})`;
}

/** Filters on turns: the person is who started the turn. */
export function turnFilters(sql: Sql, filters: OpsFilters, alias = '') {
    return [
        ...(filters.socio ? [`${alias}socio_id = ${sql.text(filters.socio)}`] : []),
        ...(filters.space ? [spaceFilter(sql, `${alias}socio_id`, filters.space)] : []),
        ...(filters.source ? [`${alias}source = ${sql.text(filters.source)}`] : []),
        ...(filters.person
            ? [`${alias}trigger_kind = 'person' AND ${alias}trigger_id = ${sql.text(filters.person)}`]
            : []),
    ];
}

/** Filters on people's messages: the person is who wrote them. */
export function messageFilters(sql: Sql, filters: OpsFilters) {
    return [
        `author_kind = 'person'`,
        ...(filters.socio ? [`socio_id = ${sql.text(filters.socio)}`] : []),
        ...(filters.space ? [spaceFilter(sql, 'socio_id', filters.space)] : []),
        ...(filters.source ? [`source = ${sql.text(filters.source)}`] : []),
        ...(filters.person ? [`author_id = ${sql.text(filters.person)}`] : []),
    ];
}

/** Filters on a rollup's rows: `person_id` is both, as the facts' filters. */
export function rollupFilters(sql: Sql, filters: OpsFilters) {
    return [
        ...(filters.socio ? [`socio_id = ${sql.text(filters.socio)}`] : []),
        ...(filters.space ? [spaceFilter(sql, 'socio_id', filters.space)] : []),
        ...(filters.source ? [`source = ${sql.text(filters.source)}`] : []),
        ...(filters.person ? [`person_id = ${sql.text(filters.person)}`] : []),
    ];
}

export async function earliest(connection: DuckDBConnection) {
    return (await factSpan(connection))?.lo ?? null;
}

/** The oldest and newest fact times, if there are facts. */
export async function factSpan(connection: DuckDBConnection) {
    const [row] = await rows<{ lo: number | null; hi: number | null }>(
        connection,
        `SELECT least((SELECT min(started_at) FROM f_turn), (SELECT min(sent_at) FROM f_message)) AS lo,
      greatest((SELECT max(started_at) FROM f_turn), (SELECT max(sent_at) FROM f_message)) AS hi`,
    );
    return row?.lo == null || row.hi == null ? undefined : { lo: row.lo, hi: row.hi };
}

export const KEY_COLUMN: Record<OpsBucket, string> = {
    hour: 'hour_at',
    day: 'day_at',
    week: 'week_at',
    month: 'month_at',
};

export async function rollupMeta(connection: DuckDBConnection) {
    const list = await rows<{ key: string; value: string }>(
        connection,
        `SELECT key, value FROM ops_meta WHERE key IN ('rollup_tz', 'cal_from', 'cal_to', 'hourly_from')`,
    );
    return Object.fromEntries(list.map(({ key, value }) => [key, value]));
}

/** Calendars made for a query in another time zone, kept a little. */
const calendars = new Map<string, ReturnType<typeof calendarRows>>();
const DAY = 86_400_000;

/**
 * The calendar to bucket facts by: the store's, when the window is cut in
 * its time zone and it covers `lo`..`hi`; else one made for the query, in
 * a temporary table of this connection.
 */
export async function calendarTable(
    connection: DuckDBConnection,
    window: OpsWindow,
    meta: Record<string, string>,
    lo: number,
    hi: number,
) {
    if (meta.rollup_tz === window.timeZone && Number(meta.cal_from) <= lo && Number(meta.cal_to) >= hi) {
        return 'd_calendar';
    }
    const from = Math.floor(lo / DAY) * DAY - DAY;
    const to = Math.ceil(hi / DAY) * DAY + DAY;
    const key = `${window.timeZone}\u0000${from}\u0000${to}`;
    let made = calendars.get(key);
    if (!made) {
        made = calendarRows(from, to, window.timeZone);
        calendars.set(key, made);
        while (calendars.size > 8) {
            calendars.delete(calendars.keys().next().value!);
        }
    }
    await connection.run(
        'CREATE OR REPLACE TEMP TABLE q_calendar (utc_at BIGINT, hour_at BIGINT, day_at BIGINT, week_at BIGINT, month_at BIGINT)',
    );
    await append(
        connection,
        'q_calendar',
        made.map((row) => [row.utcAt, row.hourAt, row.dayAt, row.weekAt, row.monthAt]),
        { schema: 'main', catalog: 'temp' },
    );
    return 'q_calendar';
}
