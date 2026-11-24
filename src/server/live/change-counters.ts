import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { SchemaSet } from '@socio/data/migrate';
import { transactionSync } from '@socio/data/open';

import type { CountersShape } from './contract.js';

/**
 * Change counters: one
 * number per key, bumped by SQLite triggers on the tables the polled views
 * read, so a poll can tell "nothing changed for this user" without building
 * its view. Triggers see every write, from every connection, module, CLI
 * and raw SQL; a soft delete is an update and bumps like an edit.
 *
 * A key follows who may see the row: `tasks:<userId>` for a user's own rows,
 * one key (`issues`, `spaces`) for what the team shares. The numbers only ever
 * go up while the server runs. They are routing state, not user content: the
 * table may be emptied while the server is stopped, since every version also
 * holds the process's boot id (@socio/foundation/http/conditional), so nothing
 * compares numbers across a restart.
 */

/** `$.` stands for the row: `NEW.` after an insert, `OLD.` before a delete. */
interface Watch {
    table: string;
    /** SQL for each key a row bumps; NULL bumps nothing. */
    keys: string[];
    /**
     * Only changes of these columns count on an update (a hot table's other
     * columns, or an upsert that rewrites the same values). All when unset.
     */
    columns?: string[];
}

/**
 * What each polled view reads, by table, and the keys that table bumps. A
 * table that isn't in a database (a store opened alone, as tests do) is
 * skipped.
 */
export const WATCHES: readonly Watch[] = [
    // core: the shell's `/api/state`.
    { table: 'settings', keys: [`'settings'`] },
    { table: 'tasks', keys: [`'tasks:' || $.userId`] },
    { table: 'memories', keys: [`'memories:' || $.userId`] },
    // The person's profile shows with their memories (CB-106).
    { table: 'user_profiles', keys: [`'memories:' || $.userId`] },
    // And their episodes (CB-180): captured, deleted or expired.
    { table: 'memory_episodes', keys: [`'memories:' || $.userId`] },
    // Notifications shown in the app while their person uses it (CB-114).
    { table: 'notification_in_app', keys: [`'notices:' || $.userId`] },
    // workspace: the shell's `/api/workspace`, and names in other views.
    { table: 'spaces', keys: [`'spaces'`] },
    // Who may read each Space (CB-181): every list of Spaces follows them.
    { table: 'space_members', keys: [`'spaces'`] },
    { table: 'space_settings', keys: [`'spaces'`] },
    { table: 'dots', keys: [`'dots'`] },
    { table: 'dot_spaces', keys: [`'dots'`] },
    // A socio's Soul (CB-179): its new version is the socio's instructions.
    { table: 'socio_souls', keys: [`'dots'`] },
    // Every request records its user: only a new name or role counts.
    { table: 'users', keys: [`'users'`], columns: ['id', 'name', 'role'] },
    // A Telegram team topic's owner is `telegram-team:<chatId>`: its
    // members read that key for each chat they are in.
    { table: 'thread_bindings', keys: [`'threads:' || $.ownerId`] },
    {
        table: 'calls',
        keys: [`'calls:' || (SELECT ownerId FROM thread_bindings WHERE id = $.threadId)`],
    },
    {
        table: 'telegram_threads',
        keys: [
            `(SELECT 'threads:' || ownerId FROM thread_bindings WHERE id = $.threadId)`,
            `CASE WHEN $.kind = 'topic' THEN 'threads:telegram-team:' || $.chatId END`,
        ],
    },
    // A room is owned by `room:<id>` (CB-207), so its row bumps
    // `threads:room:<id>`, which each active member reads; a change to a
    // person's membership (invited, joined, left, removed, a new role) bumps
    // their own list and the room's members' (CB-208).
    {
        table: 'room_members',
        keys: [`'threads:' || $.userId`, `'threads:room:' || $.roomId`],
        columns: ['status', 'role'],
    },
    // The room's socios (asked for, let in, taken out; the lead is the
    // thread's own `dotId`) and its lower limits are part of what each
    // member's room view shows (CB-212): they bump the room's key. Socios
    // asked for are also the workspace admins' to let in (`room-socios`).
    {
        table: 'room_socios',
        keys: [`'threads:room:' || $.roomId`, `'room-socios'`],
        columns: ['status'],
    },
    {
        table: 'room_settings',
        keys: [`'threads:room:' || $.roomId`],
        columns: ['limits'],
    },
    // A member read a room (CB-215): their own list, on each of their
    // devices, clears its unread count. Only a cursor that moved counts.
    {
        table: 'room_read_state',
        keys: [`'threads:' || $.userId`],
        columns: ['lastSeq'],
    },
    // A member's notifications in a room (CB-216): their own list, on each
    // of their devices, shows it muted or not.
    { table: 'room_notify_settings', keys: [`'threads:' || $.userId`] },
    // Each message in a group rewrites `seenAt`: only joining or leaving counts.
    {
        table: 'telegram_members',
        keys: [`'telegram-members:' || $.userId`],
        columns: ['chatId', 'userId'],
    },
    // Setup: backends, the default, allowed kinds, a user's own connections;
    // `seals` is the data key's counts (admins).
    { table: 'inference_backends', keys: [`'inference'`, `'seals'`] },
    { table: 'inference_settings', keys: [`'inference'`] },
    {
        table: 'user_inference_connections',
        keys: [`'inference:' || $.userId`, `'seals'`],
    },
    { table: 'data_files', keys: [`'seals'`], columns: ['sealKey'] },
    // Settings that are secrets (CB-204): set, cleared or re-sealed.
    { table: 'secret_settings', keys: [`'settings'`, `'seals'`] },
    // A person's own preferences (CB-101).
    { table: 'user_preferences', keys: [`'preferences:' || $.userId`] },
    // The launcher's promoted apps.
    { table: 'apps', keys: [`'apps'`] },
    // Feature flags (CB-169, CB-182): rules and plans for everyone.
    // `flag_choices` is retired (CB-503: flags 2 empties it and keeps it
    // empty); its watch stays until a contract migration drops the table,
    // since removing a watched key is a contract change.
    { table: 'flag_rules', keys: [`'flags'`] },
    { table: 'flag_tiers', keys: [`'flags'`] },
    { table: 'flag_tenant_tiers', keys: [`'flags'`] },
    { table: 'flag_choices', keys: [`'flags:' || $.userId`] },
    // Installed plugins and their audiences (everyone's launcher, CB-254).
    // A plugin's own tables are not the launcher.
    { table: 'plugin_installs', keys: [`'plugins'`] },
    // A Space's pages: its list, library and sidebar tree.
    { table: 'pages', keys: [`'pages:' || $.spaceId`] },
    // Datasets in Spaces (CB-451): the Space a dataset is in
    // (before and after a change) for its items list, and its owner for
    // their Private group. Only what those lists show counts; a write's new
    // `updatedAt` does (its tables' row counts), a size measured after
    // maintenance doesn't.
    {
        table: 'data_datasets',
        keys: [`'space-data:' || $.sharedSpaceId`, `'private-data:' || $.ownerUserId`],
        columns: [
            'ownerUserId',
            'name',
            'sharedSpaceId',
            'spaceParentId',
            'spacePosition',
            'spaceAddedAt',
            'scratchForDotId',
            'tableCount',
            'updatedAt',
            'deletedAt',
        ],
    },
    // The plugin that writes a placed dataset is on its item ("Written by",
    // CB-451): a binding made or ended bumps the dataset's Space.
    {
        table: 'data_plugin_bindings',
        keys: [`(SELECT 'space-data:' || sharedSpaceId FROM data_datasets WHERE id = $.datasetId)`],
    },
    // The board: issues, labels, votes and Dot requests' demand.
    { table: 'issues', keys: [`'issues'`] },
    { table: 'issue_labels', keys: [`'issues'`] },
    // The plugins and apps an issue is about (CB-442).
    { table: 'issue_components', keys: [`'issues'`] },
    { table: 'issue_votes', keys: [`'issues'`] },
    // Blocked-by links show on cards, and a proposal on the open issue (CB-29, CB-30).
    { table: 'issue_links', keys: [`'issues'`] },
    // Related links show on the open issue too (CB-274).
    { table: 'issue_relations', keys: [`'issues'`] },
    { table: 'issue_triage', keys: [`'issues'`] },
    { table: 'dot_requests', keys: [`'issues'`] },
    // Telling a Dot the outcome stamps `announcedAt`: not in the count.
    {
        table: 'dot_request_requesters',
        keys: [`'issues'`],
        columns: ['id', 'issueId'],
    },
];

const PREFIX = 'change_';

/** The bump for a list of keys, distinct and not NULL. */
function bump(keys: string[]) {
    const rows = keys.map((key, index) => (index ? `SELECT ${key}` : `SELECT ${key} AS k`));
    return `INSERT INTO change_counters(key, n) SELECT DISTINCT k, 1 FROM (${rows.join(' UNION ALL ')}) WHERE k IS NOT NULL ON CONFLICT(key) DO UPDATE SET n = n + 1;`;
}
const row = (keys: string[], alias: 'NEW' | 'OLD') => keys.map((key) => key.replaceAll('$.', `${alias}.`));

/** Each trigger's name and its exact `CREATE TRIGGER` text. */
export function triggerSql(watch: Watch): Array<[string, string]> {
    const { table, keys, columns } = watch;
    const name = (op: string) => `${PREFIX}${table}_${op}`;
    const changed = columns
        ? ` OF ${columns.join(', ')} ON ${table} WHEN ${columns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')}`
        : ` ON ${table}`;
    return [
        [
            name('insert'),
            `CREATE TRIGGER ${name('insert')} AFTER INSERT ON ${table} BEGIN ${bump(row(keys, 'NEW'))} END`,
        ],
        [
            name('update'),
            `CREATE TRIGGER ${name('update')} AFTER UPDATE${changed} BEGIN ${bump([...row(keys, 'OLD'), ...row(keys, 'NEW')])} END`,
        ],
        [
            name('delete'),
            `CREATE TRIGGER ${name('delete')} AFTER DELETE ON ${table} BEGIN ${bump(row(keys, 'OLD'))} END`,
        ],
    ];
}

/**
 * Makes the database's `change_` triggers exactly those `WATCHES` describe
 * for the tables it has: missing ones are created, changed ones replaced,
 * others dropped. Runs in the caller's transaction. Returns how many
 * triggers it wrote or dropped.
 */
export function syncTriggers(db: DatabaseSync): number {
    const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
            (entry) => entry.name,
        ),
    );
    const existing = new Map(
        (
            db
                .prepare(
                    "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'change\\_%' ESCAPE '\\'",
                )
                .all() as Array<{ name: string; sql: string }>
        ).map((entry) => [entry.name, entry.sql]),
    );
    const wanted = new Map(WATCHES.filter((watch) => tables.has(watch.table)).flatMap(triggerSql));
    let written = 0;
    for (const [name, sql] of existing) {
        if (wanted.get(name) !== sql) {
            db.exec(`DROP TRIGGER ${name}`);
            existing.delete(name);
            written++;
        }
    }
    for (const [name, sql] of wanted) {
        if (!existing.has(name)) {
            db.exec(sql);
            written++;
        }
    }
    return written;
}

/**
 * The counters and their triggers. Version 1 makes the table and installs
 * the triggers on every table that has one in `WATCHES`. It must come after
 * every other schema (modules/index.ts): its triggers name their tables.
 * The set takes no other module's migration numbers; the stores re-sync the
 * triggers on open (`ChangeCounters`), so a later migration that rebuilds a
 * table, or a new entry in `WATCHES`, needs no migration here.
 */
export const changeCountersSchema: SchemaSet = {
    id: 'change-counters',
    migrations: [
        {
            version: 1,
            name: 'counters and triggers',
            up: (db) => {
                db.exec('CREATE TABLE change_counters(key TEXT PRIMARY KEY, n INTEGER NOT NULL)');
                syncTriggers(db);
            },
        },
    ],
};

/** Reads change counters on one database connection. */
export class ChangeCounters implements CountersShape {
    private select: StatementSync;
    constructor(private db: DatabaseSync) {
        this.sync();
        this.select = db.prepare('SELECT key, n FROM change_counters WHERE key IN (SELECT value FROM json_each(?))');
    }
    /**
     * Installs the triggers for tables made since (a module's migrations ran
     * after this store opened) and repairs any a rebuilt table lost.
     */
    sync(): number {
        return transactionSync(this.db, 'sync change counters', () => {
            const written = syncTriggers(this.db);
            return written;
        });
    }
    /** `key=n` for each key, in the order given; 0 for one never bumped. */
    read(keys: readonly string[]): string {
        const found = new Map(
            (
                this.select.all(JSON.stringify(keys)) as Array<{
                    key: string;
                    n: number;
                }>
            ).map((entry) => [entry.key, entry.n]),
        );
        return keys.map((key) => `${key}=${found.get(key) ?? 0}`).join(',');
    }
}
