import { customType, integer, real, text } from 'drizzle-orm/sqlite-core';

/**
 * The only column helpers `infra/sqlite/schema.ts` files use (CB-110), so a `columns.pg.ts` with the same names can mirror them for
 * Postgres. Names come from the schema's keys and stay camelCase as stored.
 * Constraints (CHECKs, defaults, indexes) live in the hand-written
 * migrations; these only type the columns, and the drift test (drift.ts)
 * holds them to the migrated tables.
 */

/** A text id (a UUID): `text` here, `text`/`uuid` on Postgres. */
export const id = () => text();

/** Epoch milliseconds as a number: `bigint` with mode number on Postgres. */
export const ms = () => integer();

/** 0/1 read as a boolean. */
export const flag = () => integer({ mode: 'boolean' });

/** JSON as text: `jsonb` on Postgres. */
export const json = <T>() => text({ mode: 'json' }).$type<T>();

/** Text from a fixed list; its CHECK (`IS NOT NULL AND …`) is the migration's. */
export const enumText = <const Values extends readonly [string, ...string[]]>(values: Values) =>
    text({ enum: values as unknown as [Values[number], ...Values[number][]] });

/** Plain text. */
export const str = () => text();

/** A plain integer (counts, numbers, sizes). */
export const int = () => integer();

/** A floating-point number (dollars): `double precision` on Postgres. */
export const float = () => real();

/** Bytes, as node:sqlite gives them: a `Uint8Array` (`bytea` on Postgres). */
export const bytes = customType<{ data: Uint8Array; driverData: Uint8Array }>({
    dataType: () => 'blob',
});
