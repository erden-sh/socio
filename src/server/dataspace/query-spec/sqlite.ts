/**
 * SQLite expressions for field values (CB-451): how the
 * compiler reads a stored cell as a number, a day, an instant, a list or
 * a checkbox. Each one is the SQL twin of a reader in
 * `@socio/shared/dataset-views/format` (`cellNumber`, `cellDay`,
 * `cellInstant`, `cellItems`, `isChecked`), so a filter computed here and
 * one computed by a client's evaluator agree on every value
 * (`tests/dataset-query-crosscheck.test.ts` holds them to it).
 *
 * Every function takes SQL that names a column alias the compiler made;
 * none takes a value a person sent. Constants are SQL literals the
 * compiler wrote; values are bound by the caller.
 */
import type { DateBucket } from '@socio/shared/dataset-query/spec';

/** The characters JavaScript's `String.prototype.trim` removes. */
const JS_SPACE =
    'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)';
const DIGIT = '[0-9]';
const DATE_GLOB = `'${DIGIT}${DIGIT}${DIGIT}${DIGIT}-${DIGIT}${DIGIT}-${DIGIT}${DIGIT}'`;
const DATETIME_GLOB = `'${DIGIT}${DIGIT}${DIGIT}${DIGIT}-${DIGIT}${DIGIT}-${DIGIT}${DIGIT}[T ]${DIGIT}${DIGIT}:${DIGIT}${DIGIT}*'`;

/** A text cell trimmed as JavaScript trims; null for any other type. */
export const trimmedText = (c: string) => `CASE WHEN typeof(${c}) = 'text' THEN trim(${c}, ${JS_SPACE}) END`;

/** Null or `''`: empty for every kind that isn't a list (`isEmpty`). */
export const isBlank = (c: string) => `(${c} IS NULL OR ${c} COLLATE BINARY = '')`;

/**
 * `cellNumber`: a number, or text that is a JSON number with spaces
 * around it. `json_valid` (RFC 8259 by default) and the character check
 * hold it to exactly the JSON number grammar.
 */
export function numberOf(c: string) {
    const t = `trim(${c}, ' ')`;
    return `CASE typeof(${c}) WHEN 'integer' THEN ${c} WHEN 'real' THEN ${c} WHEN 'text' THEN CASE WHEN ${t} <> '' AND ${t} NOT GLOB '*[^0-9eE.+-]*' AND json_valid(${t}) AND json_type(${t}) IN ('integer', 'real') THEN CAST(${t} AS REAL) END END`;
}

/**
 * `cellDay`: a `date` cell's calendar day. A number is ms since the epoch
 * (its UTC day); text starts with a real `YYYY-MM-DD` (years 0100 on, as
 * JavaScript's `Date.UTC` reads years below 100 as 19xx).
 */
export function dayOf(c: string) {
    const d = `substr(${c}, 1, 10)`;
    return `CASE WHEN typeof(${c}) IN ('integer', 'real') THEN CASE WHEN abs(${c}) <= 8.64e15 THEN date(${c} / 1000.0, 'unixepoch') END WHEN typeof(${c}) = 'text' AND ${d} GLOB ${DATE_GLOB} AND substr(${c}, 1, 2) <> '00' AND date(${d}) = ${d} THEN ${d} END`;
}

/**
 * `cellInstant`: a `datetime` cell as ms since the epoch. A number is
 * one already; text is `YYYY-MM-DD` (midnight UTC) or `YYYY-MM-DD[T ]HH:MM`
 * with optional seconds and fraction and an optional `Z`, `+HH:MM` or
 * `+HHMM`, and without an offset it is UTC. Fractions past milliseconds
 * are cut, as `Date.parse` cuts them. `s` is the cell trimmed
 * (`trimmedText`), `c` the cell itself.
 */
export function instantOf(c: string, s: string) {
    // Named once each through nested selects: the rest after HH:MM, the
    // zone's length, and the seconds and fraction between them.
    const zone = `CASE WHEN r GLOB '*[Zz]' THEN 1 WHEN r GLOB '*[+-]${DIGIT}${DIGIT}:${DIGIT}${DIGIT}' THEN 6 WHEN r GLOB '*[+-]${DIGIT}${DIGIT}${DIGIT}${DIGIT}' THEN 5 ELSE 0 END`;
    // The offset in ms, worked out here rather than by SQLite, whose range for offsets varies by version.
    const offsetMs = `CASE WHEN z >= 5 THEN (CASE substr(r, -z, 1) WHEN '-' THEN -1 ELSE 1 END) * (CAST(substr(r, -z + 1, 2) AS INTEGER) * 60 + CAST(substr(r, -2) AS INTEGER)) * 60000 ELSE 0 END`;
    const secondsOk = `(m = '' OR m GLOB ':${DIGIT}${DIGIT}' OR (m GLOB ':${DIGIT}${DIGIT}.${DIGIT}*' AND substr(m, 5) NOT GLOB '*[^0-9]*'))`;
    // The clock as Date.parse holds it, whatever the SQLite version forgives:
    // hours to 23, or 24:00 exactly; minutes and seconds to 59; offsets to 23:59.
    const clockOk = `(substr(s, 15, 2) <= '59' AND (m = '' OR substr(m, 2, 2) <= '59') AND (substr(s, 12, 2) < '24' OR (substr(s, 12, 2) = '24' AND substr(s, 15, 2) = '00' AND (m = '' OR substr(m, 2) NOT GLOB '*[^0.]*'))) AND (z < 5 OR (substr(r, -z + 1, 2) <= '23' AND substr(r, -2) <= '59')))`;
    const fraction = `CASE WHEN length(m) > 4 THEN CAST(substr(substr(m, 5) || '00', 1, 3) AS INTEGER) ELSE 0 END`;
    const parsed = `(SELECT CASE WHEN ${secondsOk} AND ${clockOk} THEN unixepoch(substr(s, 1, 10) || 'T' || substr(s, 12, 5) || substr(m, 1, 3) || 'Z') * 1000 + ${fraction} - ${offsetMs} END FROM (SELECT s, r, z, substr(r, 1, length(r) - z) AS m FROM (SELECT s, r, ${zone} AS z FROM (SELECT ${s} AS s, substr(${s}, 17) AS r))))`;
    return `CASE WHEN typeof(${c}) IN ('integer', 'real') THEN CASE WHEN abs(${c}) <= 8.64e15 THEN ${c} END WHEN ${s} GLOB ${DATE_GLOB} THEN unixepoch(${s}) * 1000 WHEN ${s} GLOB ${DATETIME_GLOB} THEN ${parsed} END`;
}

/** `isChecked`: `true` (stored 1), `1`, `"1"` or `"true"`. */
export const checkedOf = (c: string) =>
    `(CASE WHEN typeof(${c}) IN ('integer', 'real') THEN ${c} = 1 WHEN typeof(${c}) = 'text' THEN ${c} COLLATE BINARY IN ('1', 'true') ELSE 0 END)`;

/**
 * `cellItems` as JSON text for `json_each`: an array's items, stored as
 * JSON text (`'[ ]'` too), or one item for any other non-empty text or a
 * number. Only text and number items count (`ITEM_TYPES`).
 */
export const itemsOf = (c: string) =>
    `CASE WHEN ${c} IS NULL OR typeof(${c}) = 'blob' OR ${c} = '' THEN '[]' WHEN typeof(${c}) = 'text' AND json_valid(${c}) AND json_type(${c}) = 'array' THEN ${c} ELSE json_array(${c}) END`;
export const ITEM_TYPES = `type IN ('text', 'integer', 'real')`;
/** A list cell with no items. */
export const noItems = (c: string) => `NOT EXISTS (SELECT 1 FROM json_each(${itemsOf(c)}) WHERE ${ITEM_TYPES})`;

/** A day's bucket start (`bucketStart`). Weeks start on Monday. */
export function bucketOf(day: string, bucket: DateBucket) {
    switch (bucket) {
        case 'day':
            return day;
        case 'week':
            return `date(${day}, '-' || ((CAST(strftime('%w', ${day}) AS INTEGER) + 6) % 7) || ' days')`;
        case 'month':
            return `strftime('%Y-%m-01', ${day})`;
        case 'quarter':
            return `(strftime('%Y', ${day}) || '-' || printf('%02d', ((CAST(strftime('%m', ${day}) AS INTEGER) - 1) / 3) * 3 + 1) || '-01')`;
        case 'year':
            return `strftime('%Y-01-01', ${day})`;
    }
}

/** The start of the bucket after the one starting on `start`. */
export function nextBucket(start: string, bucket: DateBucket) {
    const step = { day: '+1 day', week: '+7 days', month: '+1 month', quarter: '+3 months', year: '+1 year' }[bucket];
    return `date(${start}, '${step}')`;
}

/**
 * A value as JavaScript's `String()` spells it, for ids compared as text:
 * a whole real as an integer (`5.0` is `"5"`), anything else as SQLite
 * casts it.
 */
export const textOf = (c: string) =>
    `CASE WHEN typeof(${c}) = 'real' AND ${c} = CAST(${c} AS INTEGER) AND abs(${c}) < 1e15 THEN CAST(CAST(${c} AS INTEGER) AS TEXT) ELSE CAST(${c} AS TEXT) END`;
