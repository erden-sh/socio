import type { SqlStatements, SqlValue } from '../data';

// cache.db's rows and meta as sync reads and writes them
// (the tables are src/data/schema.ts's).
// A whole kind's scope is ''. A batch of changes goes in one transaction with
// the meta rows that describe them, so a file never holds a source's new ETag
// without its rows, nor its rows without the ETag (5.1).

/** A row's version: the server's revision, updatedAt or seq when the record has one (4.2), else null. */
export type RowVersion = number | string | null;

/** One cached record: its key, its JSON and its version. */
export interface CachedRow {
    readonly key: string;
    readonly json: string;
    readonly version: RowVersion;
}

/** A collection and a scope in it ('' for a whole kind). */
export interface RowScope {
    readonly collection: string;
    readonly scope: string;
}

/** A row a pull or a confirmation set, with its value as the server sent it. */
export interface RowUpsert extends RowScope, CachedRow {
    readonly value: unknown;
}

/** A row a pull or a confirmation removed, by all three key columns (4.2). */
export interface RowRemove extends RowScope {
    readonly key: string;
}

/** A source's sync state: its meta row. */
export interface SyncMeta {
    readonly cursor: string | null;
    /** The ETag as the server sent it, `W/` and quotes included. */
    readonly etag: string | null;
    readonly serverVersion: string | null;
    /** The format of the source's rows (the app's, not the server's). */
    readonly schemaVersion: number;
    /** When the server last answered for it (device clock), or null. */
    readonly syncedAt: number | null;
}

/** What one write puts in cache.db: rows set (null removes the row) and meta rows. */
export interface WriteBatch {
    readonly rows: readonly (RowScope & {
        readonly key: string;
        readonly row: CachedRow | null;
        readonly seenAt: number;
    })[];
    readonly meta: readonly (RowScope & SyncMeta)[];
}

/** Rows per statement: 6 values each, well under SQLite's 32766 bound values. */
const CHUNK = 100;

const asVersion = (value: SqlValue | undefined): RowVersion =>
    typeof value === 'number' || typeof value === 'string' ? value : null;

/** Every row of one collection and scope, by key. */
export async function readRows(db: SqlStatements, { collection, scope }: RowScope): Promise<Map<string, CachedRow>> {
    const rows = await db.all<{ key: string; json: string; version: SqlValue }>(
        'SELECT key, json, version FROM rows WHERE collection = ? AND scope = ?',
        [collection, scope],
    );
    return new Map(rows.map((row) => [row.key, { key: row.key, json: row.json, version: asVersion(row.version) }]));
}

/** A source's meta row, or null when it has none. */
export async function readMeta(db: SqlStatements, { collection, scope }: RowScope): Promise<SyncMeta | null> {
    const row = await db.get<{
        cursor: string | null;
        etag: string | null;
        serverVersion: string | null;
        schemaVersion: number;
        syncedAt: number | null;
    }>('SELECT cursor, etag, serverVersion, schemaVersion, syncedAt FROM meta WHERE collection = ? AND scope = ?', [
        collection,
        scope,
    ]);
    return row === null
        ? null
        : {
              cursor: row.cursor,
              etag: row.etag,
              serverVersion: row.serverVersion,
              schemaVersion: Number(row.schemaVersion),
              syncedAt: row.syncedAt === null ? null : Number(row.syncedAt),
          };
}

/** Writes `batch` with `tx`, inside the caller's transaction. */
export async function writeBatch(tx: SqlStatements, batch: WriteBatch): Promise<void> {
    const sets = batch.rows.filter((change) => change.row !== null);
    for (let start = 0; start < sets.length; start += CHUNK) {
        const chunk = sets.slice(start, start + CHUNK);
        await tx.run(
            `INSERT INTO rows (collection, scope, key, json, version, seenAt) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}
             ON CONFLICT (collection, scope, key) DO UPDATE SET json = excluded.json, version = excluded.version, seenAt = excluded.seenAt`,
            chunk.flatMap(({ collection, scope, key, row, seenAt }) => [
                collection,
                scope,
                key,
                row?.json ?? '',
                row?.version ?? null,
                seenAt,
            ]),
        );
    }
    // Removes go by collection, scope and key, a scope's keys at a time.
    const removes = new Map<string, { collection: string; scope: string; keys: string[] }>();
    for (const { collection, scope, key, row } of batch.rows) {
        if (row !== null) {
            continue;
        }
        const id = `${collection}\u0000${scope}`;
        const group = removes.get(id) ?? { collection, scope, keys: [] };
        group.keys.push(key);
        removes.set(id, group);
    }
    for (const { collection, scope, keys } of removes.values()) {
        for (let start = 0; start < keys.length; start += CHUNK) {
            const chunk = keys.slice(start, start + CHUNK);
            await tx.run(
                `DELETE FROM rows WHERE collection = ? AND scope = ? AND key IN (${chunk.map(() => '?').join(', ')})`,
                [collection, scope, ...chunk],
            );
        }
    }
    for (const meta of batch.meta) {
        await tx.run(
            `INSERT INTO meta (collection, scope, cursor, etag, serverVersion, schemaVersion, syncedAt) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (collection, scope) DO UPDATE SET cursor = excluded.cursor, etag = excluded.etag,
             serverVersion = excluded.serverVersion, schemaVersion = excluded.schemaVersion, syncedAt = excluded.syncedAt`,
            [
                meta.collection,
                meta.scope,
                meta.cursor,
                meta.etag,
                meta.serverVersion,
                meta.schemaVersion,
                meta.syncedAt,
            ],
        );
    }
}
