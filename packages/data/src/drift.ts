import type { DatabaseSync } from 'node:sqlite';

import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';

interface Column {
    name: string;
    type: string;
    notNull: boolean;
    /** 1-based position in the primary key; 0 when not in it. */
    pk: number;
}

function migrated(db: DatabaseSync, table: string): Column[] {
    return db
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((row) => ({
            name: String(row.name),
            type: String(row.type).toUpperCase(),
            notNull: Number(row.notnull) === 1,
            pk: Number(row.pk),
        }));
}

function mirrored(table: SQLiteTable): Column[] {
    const config = getTableConfig(table);
    const composite = config.primaryKeys[0]?.columns.map((column) => column.name);
    return config.columns.map((column) => ({
        name: column.name,
        type: column.getSQLType().toUpperCase(),
        notNull: column.notNull,
        pk: composite ? composite.indexOf(column.name) + 1 : column.primary ? 1 : 0,
    }));
}

/**
 * Where the Drizzle schemas differ from a migrated database (CB-110):
 * hand-written migrations stay the source of truth, and `schema.ts` is
 * their typed mirror, so each table's columns, types, nullability and
 * primary key must match `PRAGMA table_info`. One line per difference;
 * none when they agree. A primary key column's nullability isn't compared:
 * SQLite reports `TEXT PRIMARY KEY` as nullable, Drizzle as not null.
 */
export function schemaDrift(db: DatabaseSync, tables: readonly SQLiteTable[]): string[] {
    const drift: string[] = [];
    for (const table of tables) {
        const name = getTableConfig(table).name;
        const actual = new Map(migrated(db, name).map((c) => [c.name, c]));
        if (!actual.size) {
            drift.push(`${name}: no such table in the migrated database`);
            continue;
        }
        const expected = new Map(mirrored(table).map((c) => [c.name, c]));
        for (const column of actual.keys()) {
            if (!expected.has(column)) {
                drift.push(`${name}.${column}: migrated, missing from the schema`);
            }
        }
        for (const [column, want] of expected) {
            const have = actual.get(column);
            if (!have) {
                drift.push(`${name}.${column}: in the schema, not migrated`);
                continue;
            }
            if (have.type !== want.type) {
                drift.push(`${name}.${column}: type ${have.type} migrated, ${want.type} in the schema`);
            }
            if (!have.pk && !want.pk && have.notNull !== want.notNull) {
                drift.push(
                    `${name}.${column}: ${have.notNull ? 'NOT NULL' : 'nullable'} migrated, ${want.notNull ? 'NOT NULL' : 'nullable'} in the schema`,
                );
            }
            if (have.pk !== want.pk) {
                drift.push(`${name}.${column}: primary key position ${have.pk} migrated, ${want.pk} in the schema`);
            }
        }
    }
    return drift;
}
