import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterEach, expect, it, vi } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { migrate, migrateDatabase, planMigrations, type SchemaSet } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';
import { roomsSettings, roomsSettingsFromEnv } from '@socio/foundation/rooms/settings';
import { legacyCharacterFor } from '@socio/shared/mascot';
import { ROOM_DISCLOSURE_VERSION } from '@socio/shared/rooms/rooms';

import { schemas } from '../src/server/modules/index.js';
import { roomNoticeTables } from '../src/server/rooms/infra/sqlite/notices.js';
import { sqliteRoomRepositories } from '../src/server/rooms/infra/sqlite/repositories.js';
import { roomConversations, roomTables } from '../src/server/rooms/infra/sqlite/schema.js';
import { roomsSchema } from '../src/server/rooms/migrations.js';
import { RoomStorageError } from '../src/server/rooms/service.js';
import { sqliteRooms } from '../src/server/rooms/services.js';
import { workspaceSchema } from '../src/server/workspace/workspace.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

// CB-207: the dark schema for rooms. Workspace
// migration 16 gives every conversation a kind (all private) and a room the
// sentinel owner `room:<id>`; the rooms module's own tables hold members,
// socios, limits, Telegram bindings and events. Private chats answer every
// reader exactly as before, and an older build hides rooms.

vi.setConfig({ testTimeout: 30_000 });

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);
const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'socio-rooms-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};
const open = (path: string) => {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 2000');
    cleanup.push(() => db.isOpen && db.close());
    return db;
};
const store = (path?: string) => {
    const workspace = new WorkspaceStore(path ?? testDatabase());
    cleanup.push(() => workspace.close());
    return workspace;
};

/** The database's own reason a repository write was refused. */
const refused = async (write: Promise<unknown>, reason: RegExp) =>
    expect(
        await write.then(
            () => 'written',
            (error: Error & { cause?: Error }) => error.cause?.message ?? error.message,
        ),
    ).toMatch(reason);

/** The schemas of the build before rooms: workspace up to 15, no rooms module. */
const OLDER: readonly SchemaSet[] = schemas
    .filter((set) => set.id !== roomsSchema.id)
    .map((set) => (set.id === workspaceSchema.id ? { ...set, migrations: set.migrations!.slice(0, 15) } : set));
const boot = (path: string, sets = schemas) =>
    migrateDatabase(path, sets, { backupDirectory: join(path, '..', 'backups') });

const PEOPLE = ['alice', 'bob', 'carol', 'dan'];
const TEAM = 'telegram-team:-100';

/**
 * A workspace as the build before rooms left it, written with that build's
 * statements: company and personal socios, private chats (renamed,
 * archived, deleted, with a call and a task), a personal socio's chat,
 * Telegram DM and team topic, a page chat, and run history.
 */
function seedOlder(db: DatabaseSync) {
    db.exec(`INSERT INTO users (id, name, role, createdAt, lastSeenAt) VALUES
      ('alice', 'Alice', 'admin', 1, 1), ('bob', 'Bob', 'member', 2, 2),
      ('carol', 'Carol', 'member', 3, 3), ('dan', 'Dan', 'member', 4, 4);
    INSERT INTO spaces (id, name, description, createdAt) VALUES ('s1', 'Everyday', '', 1);
    INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt, learningContainerId) VALUES
      ('company', 's1', 'Sebas', '', 1, 1, 1, 'lc1'),
      ('archived', 's1', 'Rulo', '', 1, 1, 2, NULL);
    UPDATE dots SET archivedAt = 5, archivedBy = 'alice' WHERE id = 'archived';
    INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt, ownerId) VALUES
      ('mine', 's1', 'Bo', '', 1, 1, 3, 'bob');
    INSERT INTO dot_spaces VALUES ('company', 's1'), ('archived', 's1'), ('mine', 's1');
    INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt, learningContainerId, inference) VALUES
      ('a-plain', 'company', 'alice', 'Plans', 10, 'lc1', NULL),
      ('a-renamed', 'company', 'alice', 'Budget', 11, NULL, '{"backendId":"b1","model":"m"}'),
      ('a-archived', 'company', 'alice', 'Old', 12, NULL, NULL),
      ('a-deleted', 'company', 'alice', 'Gone', 13, NULL, NULL),
      ('a-call', 'company', 'alice', 'Call', 14, NULL, NULL),
      ('a-task', 'company', 'alice', 'Daily', 15, NULL, NULL),
      ('a-page', 'company', 'alice', 'Page chat', 16, NULL, NULL),
      ('b-plain', 'company', 'bob', 'Bob''s', 20, NULL, NULL),
      ('b-mine', 'mine', 'bob', 'With Bo', 21, NULL, NULL),
      ('b-dm', 'company', 'bob', 'Telegram', 22, NULL, NULL),
      ('topic', 'company', '${TEAM}', 'Team topic', 30, NULL, NULL);
    UPDATE thread_bindings SET renamed = 1, titled = 1 WHERE id = 'a-renamed';
    UPDATE thread_bindings SET archivedAt = 40, archivedBy = 'alice' WHERE id = 'a-archived';
    UPDATE thread_bindings SET deletedAt = 41, deletedBy = 'alice' WHERE id = 'a-deleted';
    INSERT INTO calls (id, threadId, startedAt, status, transcript) VALUES ('call1', 'a-call', 50, 'connected', '');
    INSERT INTO task_threads VALUES ('task1', 'a-task');
    INSERT INTO page_threads (pageId, dotId, userId, threadId, ready) VALUES ('p1', 'company', 'alice', 'a-page', 1);
    INSERT INTO telegram_threads (key, threadId, kind, chatId, topicId, createdAt) VALUES
      ('dm:7', 'b-dm', 'dm', '7', NULL, 22),
      ('topic:-100:3', 'topic', 'topic', '-100', '3', 30);
    INSERT INTO telegram_members (chatId, userId, seenAt) VALUES ('-100', 'alice', 31), ('-100', 'carol', 32);
    INSERT INTO agent_runs (threadId, runId, status, events, startedAt, finishedAt) VALUES
      ('a-plain', 'r1', 'finished', '[{"type":"TEXT_MESSAGE_CONTENT","delta":"hi"}]', 10, 11),
      ('topic', 'r2', 'finished', '[]', 30, 31);`);
}

/**
 * The readers as the build before rooms answered them: its SQL, verbatim
 * (workspace.ts at 1ad96b1), runnable on either schema.
 */
const legacy = {
    team: (db: DatabaseSync, userId: string) =>
        db
            .prepare(
                "SELECT telegram_threads.threadId AS id FROM telegram_threads JOIN telegram_members ON telegram_members.chatId = telegram_threads.chatId AND telegram_members.userId = ? WHERE telegram_threads.kind = 'topic'",
            )
            .all(userId)
            .map((row) => String(row.id)),
    conversations: (db: DatabaseSync, userId: string) =>
        db
            .prepare(
                `SELECT * FROM thread_bindings WHERE (ownerId=? OR id IN (SELECT value FROM json_each(?))) AND deletedAt IS NULL AND archivedAt IS NULL
         ORDER BY createdAt DESC`,
            )
            .all(userId, JSON.stringify(legacy.team(db, userId)))
            .map((row) => String(row.id)),
    archived: (db: DatabaseSync, userId: string) =>
        db
            .prepare(
                `SELECT * FROM thread_bindings WHERE ownerId=? AND deletedAt IS NULL AND archivedAt IS NOT NULL
         ORDER BY archivedAt DESC, createdAt DESC`,
            )
            .all(userId)
            .map((row) => String(row.id)),
    readable: (db: DatabaseSync, userId: string, id: string) => {
        const row = db.prepare('SELECT * FROM thread_bindings WHERE id=? AND deletedAt IS NULL').get(id);
        if (!row) {
            return false;
        }
        return row.ownerId === userId || legacy.team(db, userId).includes(id);
    },
    owned: (db: DatabaseSync, userId: string, id: string) =>
        !!db.prepare('SELECT 1 FROM thread_bindings WHERE id=? AND deletedAt IS NULL AND ownerId=?').get(id, userId),
};
const ids = (db: DatabaseSync) =>
    db
        .prepare('SELECT id FROM thread_bindings ORDER BY id')
        .all()
        .map((row) => String(row.id));

/** What every person reads, through the legacy SQL. */
function legacyReaders(db: DatabaseSync) {
    return Object.fromEntries(
        PEOPLE.map((userId) => [
            userId,
            {
                conversations: legacy.conversations(db, userId),
                archived: legacy.archived(db, userId),
                readable: ids(db).filter((id) => legacy.readable(db, userId, id)),
                owned: ids(db).filter((id) => legacy.owned(db, userId, id)),
            },
        ]),
    );
}

/** What every person reads, through this build's WorkspaceStore. */
async function storeReaders(workspace: WorkspaceStore) {
    const all = ids(workspace.db);
    const out: Record<string, unknown> = {};
    for (const userId of PEOPLE) {
        const readable: string[] = [];
        for (const id of all) {
            if (await workspace.readableThread(userId, id)) {
                readable.push(id);
            }
        }
        out[userId] = {
            conversations: (await workspace.conversations(userId)).map((row) => row.id),
            archived: (await workspace.archivedConversations(userId)).map((row) => row.id),
            readable,
            owned: all.filter((id) => {
                try {
                    workspace.requireOwnedThread(userId, id);
                    return true;
                } catch {
                    return false;
                }
            }),
        };
    }
    return out;
}

/** Every row of every table but the migration log. */
function rowsOf(db: DatabaseSync) {
    const tables = db
        .prepare(
            "SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'page_search%' AND name <> 'schema_migrations' ORDER BY name",
        )
        .all() as { name: string }[];
    return Object.fromEntries(
        tables.map(({ name }) => [
            name,
            db
                .prepare(`SELECT * FROM "${name}" ORDER BY rowid`)
                .all()
                .map((row) => ({ ...row })),
        ]),
    );
}

/** An upgraded copy of the older build's workspace, and what it read before. */
function upgraded() {
    const dir = scratch();
    const path = join(dir, 'socio.sqlite');
    boot(path, OLDER);
    const old = open(path);
    seedOlder(old);
    const before = { readers: legacyReaders(old), rows: rowsOf(old) };
    old.close();
    const result = boot(path);
    return { dir, path, before, result };
}

it('upgrades a realistic workspace with every chat private and every reader unchanged', async () => {
    const { path, before, result } = upgraded();
    // Only the new migrations run (the Soul's, CB-179, and the character's,
    // CB-256, come after rooms'), after a backup of the older file.
    expect(result.steps.map((step) => `${step.module} ${step.version} ${step.action}`)).toEqual([
        'workspace 16 apply',
        'workspace 17 apply',
        'workspace 18 apply',
        'workspace 19 apply',
        // The audit by kind and time (Socio Secrets phase 4).
        'workspace 20 apply',
        // Renamed people's person seeds (CB-338).
        'workspace 21 apply',
        'rooms 1 apply',
        // Members' read cursors (CB-215).
        'rooms 2 apply',
        // Members' notifications and mentions (CB-216).
        'rooms 3 apply',
        // The handoffs between a room's socios (CB-206).
        'rooms 4 apply',
        // A room's optional description / purpose (CB-278).
        'rooms 5 apply',
    ]);
    expect(result.backup).toBeDefined();
    expect(rowsOf(open(result.backup!))).toEqual(before.rows);

    const db = open(path);
    const after = rowsOf(db);
    // Every row is kept: conversations get `private`, no creator and no
    // conversion time (never back-filled); the room tables start empty.
    expect(after.thread_bindings).toEqual(
        before.rows.thread_bindings!.map((row) => ({
            ...row,
            kind: 'private',
            createdBy: null,
            convertedAt: null,
        })),
    );
    for (const table of [
        'room_members',
        'room_socios',
        'room_settings',
        'room_source_bindings',
        'room_events',
        'room_read_state',
        'room_notify_settings',
        'room_mentions',
        'room_notices',
        'room_handoffs',
    ]) {
        expect(after[table], table).toEqual([]);
    }
    // CB-256 + CB-294: socios with no chosen character get the legacy four-Local
    // assignment frozen, so roster expansion never changes their look again.
    expect(after.dots).toEqual(
        before.rows.dots!.map((row) => ({
            ...row,
            character: legacyCharacterFor(row.id as string),
        })),
    );
    // Every other table is as it was.
    const others = (rows: Record<string, unknown>) =>
        Object.fromEntries(
            Object.entries(rows).filter(
                ([name]) =>
                    name !== 'thread_bindings' && name !== 'dots' && name !== 'change_counters' && name in before.rows,
            ),
        );
    expect(others(after)).toEqual(others(before.rows));
    // The reconcile before Rooms is turned on: only private chats.
    expect(
        db
            .prepare('SELECT kind, COUNT(*) AS n FROM thread_bindings GROUP BY kind ORDER BY kind')
            .all()
            .map((row) => ({ ...row })),
    ).toEqual([{ kind: 'private', n: 11 }]);
    // The older build's readers and this build's agree, person by person.
    expect(legacyReaders(db)).toEqual(before.readers);
    const workspace = store(path);
    expect(await storeReaders(workspace)).toEqual(before.readers);
    // Spot checks of what that means: Alice's own live chats and the topic
    // she spoke in; Carol only the topic; Dan nothing.
    expect(before.readers.alice!.conversations).toEqual([
        'topic',
        'a-page',
        'a-task',
        'a-call',
        'a-renamed',
        'a-plain',
    ]);
    expect(before.readers.carol!.readable).toEqual(['topic']);
    expect(before.readers.dan).toEqual({
        conversations: [],
        archived: [],
        readable: [],
        owned: [],
    });
    // Links, titles, models and flags are as they were.
    expect(await workspace.readableThread('alice', 'a-renamed')).toEqual({
        id: 'a-renamed',
        dotId: 'company',
        ownerId: 'alice',
        title: 'Budget',
        createdAt: 11,
        kind: 'private',
        learningContainerId: null,
        inference: { backendId: 'b1', model: 'm' },
        renamed: true,
    });
    expect(await workspace.readableThread('carol', 'topic')).toMatchObject({
        kind: 'private',
        ownerId: TEAM,
        source: 'telegram',
        team: true,
    });
    // Every new socio chat is private too.
    const fresh = workspace.bindThread('n1', 'company', 'New', 'dan');
    expect(fresh.kind).toBe('private');
    expect(workspace.thread('n1')).toMatchObject({
        kind: 'private',
        ownerId: 'dan',
    });
    expect(db.prepare("SELECT createdBy FROM thread_bindings WHERE id='n1'").get()).toEqual({ createdBy: null });
});

it('migrates once, resumes after a failure with the legacy access intact, and keeps writes from another connection', () => {
    const dir = scratch();
    const path = join(dir, 'socio.sqlite');
    boot(path, OLDER);
    seedOlder(open(path));
    const before = legacyReaders(open(path));
    // Another connection's statement, prepared by the older build.
    const other = open(path);
    const legacyInsert = other.prepare(
        "INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt, learningContainerId, inference) VALUES (?, 'company', ?, 'Late', ?, NULL, NULL)",
    );

    // The rooms migration fails: the workspace migration before it is kept
    // (its own transaction), the rooms tables are not made, nothing is half
    // applied, and every reader answers as before.
    const failing = schemas.map((set) =>
        set.id === roomsSchema.id
            ? {
                  ...set,
                  migrations: [
                      {
                          ...set.migrations![0]!,
                          up: `${set.migrations![0]!.up as string}; SELECT * FROM nowhere`,
                      },
                  ],
              }
            : set,
    );
    expect(() => boot(path, failing)).toThrow(/nowhere/);
    const db = open(path);
    expect(
        db
            .prepare(
                "SELECT module, version FROM schema_migrations WHERE module IN ('workspace', 'rooms') AND version >= 15 ORDER BY module, version",
            )
            .all()
            .map((row) => ({ ...row })),
    ).toEqual([
        { module: 'workspace', version: 15 },
        { module: 'workspace', version: 16 },
        { module: 'workspace', version: 17 },
        { module: 'workspace', version: 18 },
        { module: 'workspace', version: 19 },
        { module: 'workspace', version: 20 },
        { module: 'workspace', version: 21 },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'room_%'").all()).toEqual([]);
    expect(legacyReaders(db)).toEqual(before);

    // A failing workspace 16 leaves `thread_bindings` as it was.
    const scratchPath = join(dir, 'other.sqlite');
    boot(scratchPath, OLDER);
    const broken = schemas.map((set) =>
        set.id === workspaceSchema.id
            ? {
                  ...set,
                  migrations: set.migrations!.map((migration) =>
                      migration.version === 16
                          ? {
                                ...migration,
                                up: `${migration.up as string}; SELECT * FROM nowhere`,
                            }
                          : migration,
                  ),
              }
            : set,
    );
    expect(() => boot(scratchPath, broken)).toThrow(/nowhere/);
    expect(
        open(scratchPath)
            .prepare('PRAGMA table_info(thread_bindings)')
            .all()
            .map((column) => String(column.name)),
    ).not.toContain('kind');

    // The next boot finishes the job, and the one after does nothing.
    expect(boot(path).steps.map((step) => `${step.module} ${step.version}`)).toEqual([
        'rooms 1',
        'rooms 2',
        'rooms 3',
        'rooms 4',
        'rooms 5',
    ]);
    expect(boot(path).steps).toEqual([]);
    // Another connection migrating the same file finds nothing to do.
    expect(migrate(other, schemas)).toEqual([]);
    // Its older statement still writes, and the row is a private chat.
    legacyInsert.run('late', 'bob', 99);
    expect(db.prepare("SELECT kind, ownerId, createdBy FROM thread_bindings WHERE id='late'").get()).toEqual({
        kind: 'private',
        ownerId: 'bob',
        createdBy: null,
    });
});

it('keeps kind and owner together, one membership per person and one room per topic', async () => {
    const workspace = store();
    migrate(workspace.db, [roomsSchema]);
    const db = workspace.db;
    const dot = workspace.companyDots()[0]!.id;
    const insert = db.prepare(
        'INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt, kind) VALUES (?, ?, ?, ?, 1, ?)',
    );
    // A room is owned by its own sentinel, and only a room is.
    expect(() => insert.run('r1', dot, 'alice', 'R', 'room')).toThrow(/owned by room:<id>/);
    expect(() => insert.run('r1', dot, 'room:r2', 'R', 'room')).toThrow(/owned by room:<id>/);
    expect(() => insert.run('p1', dot, 'room:p1', 'P', 'private')).toThrow(/owned by room:<id>/);
    expect(() => insert.run('p1', dot, 'room:x', 'P', 'private')).toThrow(/owned by room:<id>/);
    expect(() => insert.run('p1', dot, 'alice', 'P', 'shared')).toThrow(/CHECK constraint/);
    insert.run('r1', dot, 'room:r1', 'R', 'room');
    insert.run('p1', dot, 'alice', 'P', 'private');
    // A room never goes back to a person, and a chat never takes a sentinel
    // without becoming a room.
    for (const sql of [
        "UPDATE thread_bindings SET kind='private', ownerId='alice' WHERE id='r1'",
        "UPDATE thread_bindings SET ownerId='alice' WHERE id='r1'",
        "UPDATE thread_bindings SET ownerId='room:p1' WHERE id='p1'",
        "UPDATE thread_bindings SET kind='room' WHERE id='p1'",
    ]) {
        expect(() => db.exec(sql), sql).toThrow(/owned by room:<id>/);
    }
    db.exec("UPDATE thread_bindings SET kind='room', ownerId='room:p1' WHERE id='p1'");
    // Not even the legacy owner move can give a room to a person.
    expect(() => workspace.migrateLegacyOwner('room:r1', 'mallory')).toThrow(/owned by room:<id>/);

    const repos = sqliteRoomRepositories(sqliteData(db));
    const member = {
        roomId: 'r1',
        userId: 'alice',
        role: 'admin' as const,
        status: 'active' as const,
        invitedBy: null,
        invitedAt: 1,
        inviteExpiresAt: null,
        acceptedAt: 1,
        disclosureVersion: 1,
        endedAt: null,
        endedBy: null,
        updatedAt: 1,
    };
    await repos.members.insert(member);
    await refused(repos.members.insert({ ...member, role: 'member' }), /UNIQUE|PRIMARY KEY/);
    await refused(
        repos.members.insert({
            ...member,
            userId: 'bob',
            status: 'joined' as never,
        }),
        /CHECK/,
    );
    // A re-invite writes over the ended row: still one per person.
    await repos.members.save({ ...member, status: 'left', endedAt: 2 });
    await repos.members.save({
        ...member,
        status: 'invited',
        role: 'member',
        invitedBy: 'bob',
        invitedAt: 3,
        acceptedAt: null,
        endedAt: null,
        updatedAt: 3,
    });
    expect(await repos.members.list('r1')).toEqual([expect.objectContaining({ userId: 'alice', status: 'invited' })]);
    expect(await repos.members.forUser('alice', ['active'])).toEqual([]);

    const socio = {
        roomId: 'r1',
        dotId: dot,
        status: 'active' as const,
        requestedBy: 'alice',
        authorizedBy: 'system',
        authorizedAt: 1,
        endedAt: null,
        updatedAt: 1,
    };
    await repos.socios.insert(socio);
    await refused(repos.socios.insert(socio), /UNIQUE|PRIMARY KEY/);

    const binding = {
        id: 'b1',
        roomId: 'r1',
        source: 'telegram' as const,
        sourceKey: 'topic:-100:3',
        status: 'active' as const,
        bridge: false,
        boundBy: 'alice',
        boundAt: 1,
        endedAt: null,
    };
    await repos.sources.insert(binding);
    // One room per topic, even after the binding is stopped.
    await repos.sources.disable('b1', 2);
    await refused(repos.sources.insert({ ...binding, id: 'b2', roomId: 'p1' }), /UNIQUE/);
    expect(await repos.sources.bySource('telegram', 'topic:-100:3')).toEqual({
        ...binding,
        status: 'disabled',
        endedAt: 2,
    });
    await refused(
        repos.sources.insert({
            ...binding,
            id: 'b3',
            sourceKey: 'slack:1',
            source: 'slack' as never,
        }),
        /CHECK/,
    );

    await repos.settings.save({
        roomId: 'r1',
        limits: { cycleTokens: 1000 },
        updatedBy: 'alice',
        updatedAt: 1,
        description: null,
    });
    expect((await repos.settings.get('r1'))?.limits).toEqual({
        cycleTokens: 1000,
    });

    // The typed mirrors match the migrated tables.
    expect(schemaDrift(db, roomTables)).toEqual([]);
    expect(schemaDrift(db, roomNoticeTables)).toEqual([]);
    const columns = new Map(
        db
            .prepare('PRAGMA table_info(thread_bindings)')
            .all()
            .map((row) => [String(row.name), String(row.type).toUpperCase()]),
    );
    for (const column of getTableConfig(roomConversations).columns) {
        expect(columns.get(column.name), column.name).toBe(column.getSQLType().toUpperCase());
    }
});

/** A workspace with Rooms storage over it and a switch the test turns. */
function roomsFixture() {
    const workspace = store();
    const switchOn = { enabled: false };
    const rooms = sqliteRooms(workspace.db, {
        workspace,
        enabled: () => switchOn.enabled,
    });
    for (const id of PEOPLE) {
        workspace.recordUser({
            id,
            name: id,
            role: id === 'alice' ? 'admin' : 'member',
        });
    }
    const company = workspace.companyDots()[0]!;
    const personal = workspace.createDot(
        company.spaceId,
        'Bo',
        '',
        true,
        true,
        [company.spaceId],
        null,
        false,
        null,
        false,
        'bob',
    );
    return { workspace, rooms, switchOn, company, personal };
}

it('makes and converts rooms only with Rooms on, leaving private chats unchanged and each room to its members alone', async () => {
    const { workspace, rooms, switchOn, company, personal } = roomsFixture();
    const aliceChat = workspace.bindThread('a1', company.id, 'Mine', 'alice');
    workspace.bindThread('a2', company.id, 'Keep', 'alice');
    workspace.bindThread('b1', company.id, 'Bob', 'bob');
    workspace.bindThread('b2', personal.id, 'With Bo', 'bob');
    const before = await storeReaders(workspace);

    // Off by default: nothing can be made or converted.
    await expect(rooms.createRoom({ dotId: company.id, title: 'Team', createdBy: 'alice' })).rejects.toMatchObject({
        reason: 'rooms_off',
    });
    await expect(rooms.convertToRoom('a1', 'alice')).rejects.toMatchObject({
        reason: 'rooms_off',
    });
    expect(await rooms.readiness()).toEqual({
        enabled: false,
        conversations: { private: 4, room: 0 },
        allPrivate: true,
    });

    switchOn.enabled = true;
    // Company socios only; a real name.
    await expect(rooms.createRoom({ dotId: personal.id, title: 'T', createdBy: 'bob' })).rejects.toMatchObject({
        reason: 'personal_socio',
    });
    await expect(rooms.createRoom({ dotId: company.id, title: ' ', createdBy: 'bob' })).rejects.toMatchObject({
        reason: 'invalid_title',
    });
    workspace.archiveDot(workspace.createDot(company.spaceId, 'Rulo', '', true, true).id, 'alice');
    const archived = workspace.allDots().find((dot) => dot.name === 'Rulo')!;
    await expect(rooms.createRoom({ dotId: archived.id, title: 'T', createdBy: 'bob' })).rejects.toMatchObject({
        reason: 'archived',
    });

    const room = await rooms.createRoom({
        id: 'room1',
        dotId: company.id,
        title: ' Team ',
        createdBy: 'bob',
        now: 100,
    });
    expect(room).toEqual({
        id: 'room1',
        kind: 'room',
        ownerId: 'room:room1',
        dotId: company.id,
        title: 'Team',
        createdAt: 100,
        createdBy: 'bob',
        convertedAt: null,
        archivedAt: null,
    });
    expect(await rooms.members('room1')).toEqual([
        {
            roomId: 'room1',
            userId: 'bob',
            role: 'admin',
            status: 'active',
            invitedBy: null,
            invitedAt: 100,
            inviteExpiresAt: null,
            acceptedAt: 100,
            disclosureVersion: ROOM_DISCLOSURE_VERSION,
            endedAt: null,
            endedBy: null,
            updatedAt: 100,
        },
    ]);
    expect(await rooms.socios('room1')).toEqual([expect.objectContaining({ dotId: company.id, status: 'active' })]);
    expect(workspace.thread('room1')).toMatchObject({
        kind: 'room',
        ownerId: 'room:room1',
        learningContainerId: null,
    });

    // Conversion: the person's own private web chat only.
    await expect(rooms.convertToRoom('a1', 'bob')).rejects.toMatchObject({
        reason: 'not_found',
    });
    await expect(rooms.convertToRoom('b2', 'bob')).rejects.toMatchObject({
        reason: 'personal_socio',
    });
    await expect(rooms.convertToRoom('room1', 'bob')).rejects.toMatchObject({
        reason: 'not_found',
    });
    await expect(rooms.convertToRoom('nope', 'bob')).rejects.toBeInstanceOf(RoomStorageError);
    workspace.setArchived('a2', true, 'alice');
    await expect(rooms.convertToRoom('a2', 'alice')).rejects.toMatchObject({
        reason: 'archived',
    });
    workspace.setArchived('a2', false, 'alice');
    await workspace.bindTask('t1', 'a2');
    await expect(rooms.convertToRoom('a2', 'alice')).rejects.toMatchObject({
        reason: 'scheduled_tasks',
    });
    await workspace.telegram.bindThread('dm:1', 'b1', 'dm', '1', null);
    await expect(rooms.convertToRoom('b1', 'bob')).rejects.toMatchObject({
        reason: 'not_convertible',
    });

    const converted = await rooms.convertToRoom('a1', 'alice', 200);
    expect(converted).toEqual({
        id: 'a1',
        kind: 'room',
        ownerId: 'room:a1',
        dotId: company.id,
        title: 'Mine',
        createdAt: aliceChat.createdAt,
        createdBy: 'alice',
        convertedAt: 200,
        archivedAt: null,
    });
    expect((await rooms.events('a1')).map((event) => event.action)).toEqual(['convert']);
    expect((await rooms.events('a1'))[0]).toMatchObject({
        actor: 'alice',
        targetKind: 'room',
        outcome: 'ok',
        at: 200,
    });
    // A second conversion finds no private chat, and adds nothing.
    await expect(rooms.convertToRoom('a1', 'alice')).rejects.toMatchObject({
        reason: 'not_found',
    });
    expect(await rooms.members('a1')).toHaveLength(1);

    // Every other chat answers exactly as before; each room answers its
    // maker, its one active member, through the readers (CB-208), nobody
    // else, and fails every owner-only check.
    const after = (await storeReaders(workspace)) as typeof before;
    const withoutRooms = (readers: typeof before) =>
        JSON.parse(
            JSON.stringify(readers, (_key, value) =>
                Array.isArray(value) ? value.filter((id) => !['a1', 'room1'].includes(id)) : value,
            ),
        );
    expect(withoutRooms(after)).toEqual(withoutRooms({ ...before }));
    for (const person of PEOPLE) {
        const mine = person === 'bob' ? ['room1'] : person === 'alice' ? ['a1'] : [];
        expect(
            (await workspace.conversations(person)).map((row) => row.id).filter((id) => ['a1', 'room1'].includes(id)),
        ).toEqual(mine);
        expect(!!(await workspace.readableThread(person, 'room1'))).toBe(person === 'bob');
        expect(!!(await workspace.readableThread(person, 'a1'))).toBe(person === 'alice');
        expect(() => workspace.requireOwnedThread(person, 'a1')).toThrow();
        expect(() => workspace.requireOwnedThread(person, 'room1')).toThrow();
        expect(workspace.usedDot(person, company.id)).toBe(['alice', 'bob'].includes(person));
    }
    expect(() => workspace.requireOwnedThread('room:a1', 'a1')).toThrow();
    expect(workspace.callsFor('alice')).toEqual([]);
    expect(await rooms.readiness()).toEqual({
        enabled: true,
        conversations: { private: 3, room: 2 },
        allPrivate: false,
    });
    // Turned off again, nothing new is made; existing rooms stay.
    switchOn.enabled = false;
    await expect(rooms.convertToRoom('a2', 'alice')).rejects.toMatchObject({
        reason: 'rooms_off',
    });
    expect(await rooms.room('room1')).toBeDefined();
    expect(await rooms.room('a2')).toBeUndefined();
});

it('hides rooms from an older build, which runs on the migrated database', async () => {
    const { path, result } = upgraded();
    const workspace = store(path);
    const rooms = sqliteRooms(workspace.db, { workspace, enabled: () => true });
    await rooms.convertToRoom('a-plain', 'alice');
    await rooms.createRoom({
        id: 'r',
        dotId: 'company',
        title: 'R',
        createdBy: 'bob',
    });
    workspace.close();

    // Workspace 16 only expands (CB-108), so an older build that has the
    // expand/contract rule runs on it, as during a start-first deploy or
    // after a rollback; a build from before that rule refuses it.
    const db = open(path);
    expect(() => planMigrations(db, OLDER, { strict: true })).not.toThrow();
    expect(() => planMigrations(db, OLDER)).not.toThrow();
    // Its readers show the rooms to no one: the sentinel owner is nobody,
    // and no topic lists them.
    for (const person of PEOPLE) {
        const readers = legacyReaders(db)[person]!;
        for (const list of Object.values(readers)) {
            expect(list).not.toContain('a-plain');
            expect(list).not.toContain('r');
        }
    }
    // And what it writes is never refused by the room triggers: a new
    // private chat, owned by a person.
    db.prepare(
        "INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt) VALUES ('old-new', 'company', 'carol', 'New', 9)",
    ).run();
    expect(legacyReaders(db).carol!.conversations).toContain('old-new');
    // Rolling back to the backup taken before the migration gives the older
    // build its database as it was (the rooms made since are not in it).
    const restored = open(result.backup!);
    expect(() => planMigrations(restored, OLDER, { strict: true })).not.toThrow();
    expect(legacyReaders(restored).alice!.conversations).toContain('a-plain');
});

it('reserves room and team owner ids, and reads the switch off unless set', () => {
    const workspace = store();
    for (const id of ['room:x', 'telegram-team:-1', 'socio:d']) {
        expect(() => workspace.recordUser({ id, name: 'Mallory', role: 'member' })).toThrow(/may not start with/);
    }
    expect(roomsSettingsFromEnv({})).toMatchObject({ enabled: false });
    expect(roomsSettingsFromEnv({ ROOMS_ENABLED: 'maybe' })).toMatchObject({
        enabled: false,
    });
    expect(roomsSettingsFromEnv({ ROOMS_ENABLED: ' On ' })).toMatchObject({
        enabled: true,
    });
    expect(roomsSettings({})).toMatchObject({ enabled: false });
    expect(roomsSettings({}, { enabled: true })).toMatchObject({ enabled: true });
    expect(roomsSettings({ rooms: { enabled: false } }, { enabled: true })).toEqual({
        enabled: false,
        budgetVisible: false,
    });
});
