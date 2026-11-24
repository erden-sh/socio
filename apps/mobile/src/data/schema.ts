// The two files in each workspace's directory and their tables.
// Tables are STRICT, so a value of the wrong type is refused rather than
// stored. Times are milliseconds since the epoch.

/** The copy of what the server sent: disposable, rebuilt when its version changes. */
export const CACHE_DB = 'cache.db';
/** What the person wrote and the server hasn't confirmed: migrated, never rebuilt. */
export const USER_DB = 'user.db';

/** A file's tables at one version: the statements that create them on an empty file. */
export interface CacheSchema {
    readonly version: number;
    readonly statements: readonly string[];
}

/**
 * One step of user.db's migrations: from `version - 1` to `version`. Steps
 * after the first only add (a table, an index, a column), so a build one
 * version behind still reads the file.
 */
export interface Migration {
    readonly version: number;
    readonly statements: readonly string[];
}

/**
 * cache.db's tables. Their version is the file's `user_version`: a file at any
 * other version, lower or higher, is deleted and built again.
 * `meta.schemaVersion` is something else: the format of one collection's rows,
 * which sync reads.
 */
export const CACHE_SCHEMA: CacheSchema = {
    version: 1,
    statements: [
        // Every cached record. Removes go by all three key columns. `version` is
        // the server's updatedAt, revision or seq when there is one, of
        // whichever type the server gives. A whole collection's scope is ''.
        // A rowid table, unlike the small ones: a record can be large (up to
        // 4 MB), and SQLite keeps large rows better outside the key's tree.
        `CREATE TABLE rows (
            collection TEXT NOT NULL,
            scope TEXT NOT NULL,
            key TEXT NOT NULL,
            json TEXT NOT NULL,
            version ANY,
            seenAt INTEGER NOT NULL,
            PRIMARY KEY (collection, scope, key)
        ) STRICT`,
        // Sync state per collection and scope, written in the same transaction
        // as the rows it describes.
        `CREATE TABLE meta (
            collection TEXT NOT NULL,
            scope TEXT NOT NULL,
            cursor TEXT,
            etag TEXT,
            serverVersion TEXT,
            schemaVersion INTEGER NOT NULL,
            syncedAt INTEGER,
            PRIMARY KEY (collection, scope)
        ) STRICT, WITHOUT ROWID`,
        // LRU bookkeeping for the bounded kinds: eviction is a real DELETE, then
        // PRAGMA incremental_vacuum.
        `CREATE TABLE scopes (
            scope TEXT PRIMARY KEY NOT NULL,
            lastUsed INTEGER NOT NULL,
            bytes INTEGER NOT NULL
        ) STRICT, WITHOUT ROWID`,
        // The last screen and other per-workspace view state.
        `CREATE TABLE kv (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
        ) STRICT, WITHOUT ROWID`,
    ],
};

/** user.db's migrations, in order. Its `user_version` is the last one applied. */
export const USER_MIGRATIONS: readonly Migration[] = [
    {
        version: 1,
        statements: [
            // Intended writes, sent in order per lane. The payload holds local
            // ids, the base values it changes and the write's watermark;
            // `dependsOn` is the outbox row it waits for; `state` covers
            // queued, in flight, unknown and held. Never dropped silently.
            `CREATE TABLE outbox (
                id TEXT PRIMARY KEY NOT NULL,
                lane TEXT NOT NULL,
                kind TEXT NOT NULL,
                payload TEXT NOT NULL,
                payloadVersion INTEGER NOT NULL,
                dependsOn TEXT,
                idempotencyKey TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                revision INTEGER NOT NULL DEFAULT 0,
                createdAt INTEGER NOT NULL,
                lastError TEXT
            ) STRICT`,
            // Composer and page drafts, by the web's chat-drafts.ts rules:
            // `sending` is the JSON list of sends from the draft not yet known
            // to have arrived.
            `CREATE TABLE drafts (
                scope TEXT PRIMARY KEY NOT NULL,
                text TEXT NOT NULL,
                payloadVersion INTEGER NOT NULL,
                updatedAt INTEGER NOT NULL,
                sending TEXT
            ) STRICT`,
            // Writes the server refused, or that conflicted, kept until the
            // person copies, retries or discards them.
            `CREATE TABLE unsent (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                payload TEXT NOT NULL,
                payloadVersion INTEGER NOT NULL,
                reason TEXT NOT NULL,
                createdAt INTEGER NOT NULL
            ) STRICT`,
            // The server id each local create got, written in the transaction
            // that marks the create done.
            `CREATE TABLE ids (
                kind TEXT NOT NULL,
                localId TEXT NOT NULL,
                serverId TEXT NOT NULL,
                PRIMARY KEY (kind, localId)
            ) STRICT, WITHOUT ROWID`,
            // Attachments picked but not sent yet, copied into the workspace's
            // directory; `path` is relative to it.
            `CREATE TABLE files (
                id TEXT PRIMARY KEY NOT NULL,
                path TEXT NOT NULL,
                mime TEXT NOT NULL,
                bytes INTEGER NOT NULL,
                lane TEXT NOT NULL
            ) STRICT`,
        ],
    },
    {
        // Attachments: what an attachment's upload needs. Columns
        // only, each nullable or with a default, so a build at migration 1
        // still reads the rows (read-only, as for any newer file).
        version: 2,
        statements: [
            // The name the upload sends (`X-File-Name`).
            `ALTER TABLE files ADD COLUMN name TEXT NOT NULL DEFAULT ''`,
            // `uploading`, `ready` or `failed` (src/sync/attachments.ts).
            `ALTER TABLE files ADD COLUMN state TEXT NOT NULL DEFAULT 'uploading'`,
            // The server's attachment id (`cbatt_…`) once uploaded, and when:
            // the server drops an unsent upload after 24 h.
            `ALTER TABLE files ADD COLUMN serverId TEXT`,
            `ALTER TABLE files ADD COLUMN uploadedAt INTEGER`,
            // The composer's draft scope while it sits in the tray, else null.
            `ALTER TABLE files ADD COLUMN draftScope TEXT`,
            // The outbox row (a message) that carries it once sent, else null.
            `ALTER TABLE files ADD COLUMN outboxId TEXT`,
            // Why it failed (a code, never the server's text), and the tray's order.
            `ALTER TABLE files ADD COLUMN error TEXT`,
            `ALTER TABLE files ADD COLUMN createdAt INTEGER NOT NULL DEFAULT 0`,
        ],
    },
    {
        // Preferences: the person's choices for this workspace on this phone, small
        // strings by key, kept here so Clear cache keeps them: the Spaces kept
        // offline (src/sync/kept-spaces.ts). A table only, so a build at
        // migration 2 still reads the file (read-only: it stops sending, and
        // says "Update Socio to send these").
        version: 3,
        statements: [
            `CREATE TABLE prefs (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            ) STRICT, WITHOUT ROWID`,
        ],
    },
];
