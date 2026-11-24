import type { DatabaseSync } from 'node:sqlite';

import type { SchemaSet } from '@socio/data/migrate';
import { openDatabase, sqliteData, transaction } from '@socio/data/open';
import type { DataContext } from '@socio/data/uow';
import { legacyCharacterFor } from '@socio/shared/mascot';

import { RoomAccessError } from '../rooms/contract.js';

import { AccessChanges } from './access-changes.js';
import { SqliteAudit } from './audit.js';
import type {
    AccessChange,
    AuditShape,
    ConversationsShape,
    SociosShape,
    PeopleShape,
    SpacesShape,
} from './contract.js';
import { SqliteConversations, type RoomRule } from './conversations.js';
import { SqlitePeople } from './people.js';
import { SqliteSocios, type SocioSouls } from './socios.js';
import { SqliteSpaces, type SpaceRule } from './spaces.js';

/**
 * Spaces, Dots and their Space grants, conversations, calls and users. The
 * baseline is the former constructor DDL; the dot_spaces copy dropped its
 * own BEGIN/COMMIT, because every migration runs in a transaction. Its
 * baseline also made `task_threads`: that stays here, frozen, and the
 * Scheduling context owns the table (`schedules/migrations.ts`, CB-110).
 */
export const workspaceSchema: SchemaSet = {
    id: 'workspace',
    migrations: [
        {
            version: 1,
            name: 'baseline',
            // Recorded before the formatting pass of v0.30.0 (dba875569), which
            // changed only the source's form: same DDL and data.
            formerChecksums: ['022a7c32680594db'],
            baseline: true,
            up: (db) => {
                db.exec(`CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_threads(taskId TEXT PRIMARY KEY, threadId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, startedAt INTEGER NOT NULL, endedAt INTEGER, status TEXT NOT NULL, transcript TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS captures(threadId TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')), createdAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL);`);
                for (const [table, column, definition] of [
                    ['dots', 'learningContainerId', 'TEXT'],
                    ['dots', 'skillDeliveryEnabled', 'INTEGER NOT NULL DEFAULT 0'],
                    ['thread_bindings', 'learningContainerId', 'TEXT'],
                    ['thread_bindings', 'titled', 'INTEGER NOT NULL DEFAULT 0'],
                ]) {
                    if (
                        !db
                            .prepare(`PRAGMA table_info(${table})`)
                            .all()
                            .some((field) => field.name === column)
                    ) {
                        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
                    }
                }
                // Migrate only once: restarting must never restore a revoked grant.
                if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dot_spaces'").get()) {
                    db.exec(`CREATE TABLE dot_spaces(dotId TEXT NOT NULL, spaceId TEXT NOT NULL, PRIMARY KEY(dotId, spaceId));
        INSERT INTO dot_spaces SELECT id, spaceId FROM dots;`);
                }
                if (
                    !db
                        .prepare('PRAGMA table_info(calls)')
                        .all()
                        .some((column) => column.name === 'anchorMessageId')
                ) {
                    db.exec('ALTER TABLE calls ADD COLUMN anchorMessageId TEXT');
                }
            },
        },
        {
            // SQLite can't change a CHECK constraint in place: rebuild the table.
            version: 2,
            name: 'operator role',
            up: `CREATE TABLE users_v2(id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('operator','admin','member')), createdAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL);
      INSERT INTO users_v2 SELECT id, name, role, createdAt, lastSeenAt FROM users;
      DROP TABLE users;
      ALTER TABLE users_v2 RENAME TO users;`,
        },
        {
            // JSON `ModelChoice`s: a Dot's default, a conversation's override.
            version: 3,
            name: 'model choices',
            up: `ALTER TABLE dots ADD COLUMN inference TEXT;
      ALTER TABLE thread_bindings ADD COLUMN inference TEXT;`,
        },
        {
            // CB-57: service accounts (users nobody signs in as) and their keys.
            version: 4,
            name: 'service accounts',
            up: `CREATE TABLE service_accounts(userId TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', createdAt INTEGER NOT NULL, createdBy TEXT, disabledAt INTEGER);
      CREATE TABLE service_keys(id TEXT PRIMARY KEY, userId TEXT NOT NULL, name TEXT NOT NULL, hint TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, createdAt INTEGER NOT NULL, createdBy TEXT, expiresAt INTEGER NOT NULL, lastUsedAt INTEGER, lastUsedIp TEXT, revokedAt INTEGER);
      CREATE INDEX service_keys_user ON service_keys(userId);`,
        },
        {
            // CB-64: deleting a conversation, Dot or Space hides it and keeps the
            // row. `workspace_audit` records deletes that have no audit of their
            // own (conversations, pages, memories, jobs, apps).
            version: 5,
            name: 'soft delete',
            up: `ALTER TABLE spaces ADD COLUMN deletedAt INTEGER;
      ALTER TABLE spaces ADD COLUMN deletedBy TEXT;
      ALTER TABLE dots ADD COLUMN deletedAt INTEGER;
      ALTER TABLE dots ADD COLUMN deletedBy TEXT;
      ALTER TABLE thread_bindings ADD COLUMN deletedAt INTEGER;
      ALTER TABLE thread_bindings ADD COLUMN deletedBy TEXT;
      CREATE TABLE workspace_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, targetKind TEXT NOT NULL, targetId TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', createdAt INTEGER NOT NULL);
      CREATE INDEX workspace_audit_target ON workspace_audit(targetKind, targetId);`,
        },
        {
            // CB-66: a chat its owner renamed keeps that title; a generated
            // title never replaces it.
            version: 6,
            name: 'renamed conversations',
            up: 'ALTER TABLE thread_bindings ADD COLUMN renamed INTEGER NOT NULL DEFAULT 0',
        },
        {
            // The shell's conversation list (`conversations`) read every row of
            // every owner: with this, its own rows, newest first. On the bench
            // seed (5,000 chats, an owner of 500) the list's SELECT went from
            // about 2.0 ms to 1.3 ms (p50), the whole list from 5.0 to 4.4 ms.
            version: 7,
            name: 'conversations by owner',
            up: 'CREATE INDEX thread_bindings_owner ON thread_bindings(ownerId, createdAt)',
        },
        {
            // An archived chat leaves its owner's lists and stays theirs, by
            // link, with everything it had. Archive is not a delete: no stamp,
            // no audit line, its tasks keep running.
            version: 8,
            name: 'archived conversations',
            up: `ALTER TABLE thread_bindings ADD COLUMN archivedAt INTEGER;
      ALTER TABLE thread_bindings ADD COLUMN archivedBy TEXT;`,
        },
        {
            // CB-31: a Dot files on the Improvements board only once an admin
            // turns it on; every existing Dot starts off.
            version: 9,
            name: 'dot board filing',
            up: 'ALTER TABLE dots ADD COLUMN issuesAllowed INTEGER NOT NULL DEFAULT 0',
        },
        {
            // A person's own Dots: `ownerId` set, private to them; NULL is a
            // company Dot, managed by admins. Every existing Dot is the company's.
            version: 10,
            name: 'personal dots',
            up: `ALTER TABLE dots ADD COLUMN ownerId TEXT;
      CREATE INDEX dots_owner ON dots(ownerId);`,
        },
        {
            // Dots are archived, never deleted (an archived Dot keeps its chats,
            // filings and audit, and can come back); `dot_audit` records who
            // made, changed, archived and unarchived each Dot, and what changed.
            version: 11,
            name: 'dot archive and audit',
            up: `ALTER TABLE dots ADD COLUMN archivedAt INTEGER;
      ALTER TABLE dots ADD COLUMN archivedBy TEXT;
      CREATE TABLE dot_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, dotId TEXT NOT NULL CHECK(length(dotId) > 0), actor TEXT NOT NULL CHECK(length(actor) > 0), action TEXT NOT NULL CHECK(action IN ('create','update','archive','unarchive')), detail TEXT NOT NULL DEFAULT '', createdAt INTEGER NOT NULL);
      CREATE INDEX dot_audit_dot ON dot_audit(dotId, id);`,
        },
        {
            // A Dot's chats (the admins' Dots page, archiving a Dot).
            version: 12,
            name: 'conversations by dot',
            up: 'CREATE INDEX thread_bindings_dot ON thread_bindings(dotId, createdAt)',
        },
        {
            // A person's own preferences, as JSON (CB-101: how they dictate).
            version: 13,
            name: 'user preferences',
            up: 'CREATE TABLE user_preferences(userId TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt INTEGER NOT NULL)',
        },
        {
            // CB-166: the newest release each person has seen in What's new.
            version: 14,
            name: 'release seen',
            up: 'CREATE TABLE release_seen(userId TEXT PRIMARY KEY, version TEXT NOT NULL CHECK(version IS NOT NULL AND length(version) BETWEEN 5 AND 64), seenAt INTEGER NOT NULL)',
        },
        {
            // CB-166: when each person was first shown each release's card, for
            // support ("you never saw the release that fixed it").
            version: 15,
            name: 'release views',
            up: 'CREATE TABLE release_views(userId TEXT NOT NULL, version TEXT NOT NULL CHECK(version IS NOT NULL AND length(version) BETWEEN 5 AND 64), firstSeenAt INTEGER NOT NULL, PRIMARY KEY(userId, version))',
        },
        {
            // CB-207: a conversation is a person's
            // (`private`, every existing row) or a room, whose owner is the
            // sentinel `room:<id>`, so every owner check not yet moved to the
            // room rules, and an older build, finds no person in it. Who made or
            // converted a room, and when it was converted; NULL on existing rows,
            // never back-filled. Columns with constant defaults and a partial
            // index: no table rewrite. The triggers keep kind and owner together:
            // a room always has its sentinel, a person's chat never has one, and
            // a room never turns back into a private chat.
            version: 16,
            name: 'rooms',
            compatible:
                "The triggers refuse only rows that mix a room's kind and owner. A build before rooms inserts every chat with the default kind 'private' and a person as its owner, and moves owners only between people, so none of its writes is refused; it reads rooms as chats nobody owns (CB-108).",
            up: `ALTER TABLE thread_bindings ADD COLUMN kind TEXT NOT NULL DEFAULT 'private' CHECK(kind IN ('private','room'));
      ALTER TABLE thread_bindings ADD COLUMN createdBy TEXT;
      ALTER TABLE thread_bindings ADD COLUMN convertedAt INTEGER;
      CREATE INDEX thread_bindings_kind ON thread_bindings(kind) WHERE kind = 'room';
      CREATE TRIGGER thread_bindings_room_owner_insert BEFORE INSERT ON thread_bindings
        WHEN (NEW.kind = 'room') <> (NEW.ownerId = 'room:' || NEW.id) OR (NEW.kind = 'private' AND NEW.ownerId LIKE 'room:%')
        BEGIN SELECT RAISE(ABORT, 'A room is owned by room:<id>, and only a room is'); END;
      CREATE TRIGGER thread_bindings_room_owner_update BEFORE UPDATE OF kind, ownerId ON thread_bindings
        WHEN (NEW.kind = 'room') <> (NEW.ownerId = 'room:' || NEW.id) OR (NEW.kind = 'private' AND NEW.ownerId LIKE 'room:%') OR (OLD.kind = 'room' AND NEW.kind <> 'room')
        BEGIN SELECT RAISE(ABORT, 'A room is owned by room:<id>, and only a room is'); END;`,
        },
        {
            // CB-179: each socio's Soul, every version kept (souls.ts). Version
            // 1 of every socio, archived and deleted ones too, is its role
            // instructions word for word, dated and signed by the audit line
            // that last set them (else its creation, by `system`).
            // `dots.instructions` stays, a copy of the Soul's instructions.
            version: 17,
            name: 'socio souls',
            up: (db) => {
                db.exec(
                    `CREATE TABLE socio_souls(dotId TEXT NOT NULL CHECK(length(dotId) > 0), version INTEGER NOT NULL CHECK(version >= 1), instructions TEXT NOT NULL, voice TEXT NOT NULL DEFAULT '', "values" TEXT NOT NULL DEFAULT '', style TEXT NOT NULL DEFAULT '', createdAt INTEGER NOT NULL, createdBy TEXT NOT NULL CHECK(length(createdBy) > 0), source TEXT NOT NULL CHECK(source IN ('migrated','created','edited','restored')), restoredFrom INTEGER, PRIMARY KEY(dotId, version))`,
                );
                db.exec(
                    `INSERT INTO socio_souls (dotId, version, instructions, createdAt, createdBy, source) SELECT socio.id, 1, socio.instructions, COALESCE(setBy.createdAt, socio.createdAt), COALESCE(NULLIF(setBy.actor, ''), 'system'), 'migrated' FROM dots AS socio LEFT JOIN dot_audit AS setBy ON setBy.id = (SELECT id FROM dot_audit WHERE dotId = socio.id AND (action = 'create' OR (action = 'update' AND (detail = 'instructions' OR detail LIKE 'instructions;%' OR detail LIKE '%; instructions' OR detail LIKE '%; instructions;%'))) ORDER BY id DESC LIMIT 1)`,
                );
            },
        },
        {
            // CB-256: the Local someone chose for a socio. NULL keeps the look
            // its id hashes to (mascot.ts), so every existing socio stays as it
            // is. No CHECK: the cast may grow, and an unknown value reads as NULL.
            version: 18,
            name: 'dot character',
            up: 'ALTER TABLE dots ADD COLUMN character TEXT',
        },
        {
            // CB-294: adding Locals (CB-272) changed the modulo in characterFor(),
            // which shifted automatic assignments for socios whose character was
            // still NULL. Freeze their pre-expansion assignment by backfilling with
            // the legacy four-Local roster, and persist resolved defaults for any
            // future socio that reaches this migration with no explicit character.
            version: 19,
            name: 'freeze dot character assignments',
            // Recorded before the formatting pass of v0.30.0 (dba875569), which
            // changed only the source's form: same DDL and data.
            formerChecksums: ['2267d9c425b3fcd4'],
            up: (db) => {
                const rows = db.prepare('SELECT id FROM dots WHERE character IS NULL').all() as { id: string }[];
                if (!rows.length) {
                    return;
                }
                const update = db.prepare('UPDATE dots SET character=? WHERE id=?');
                for (const { id } of rows) {
                    update.run(legacyCharacterFor(id), id);
                }
            },
        },
        {
            // Socio Secrets: the read-anomaly rules scan one kind of
            // audit line by time (`workspace_secret` reads and refusals).
            // Expand only: a plain index an older build ignores.
            version: 20,
            name: 'audit lines by kind and time',
            phase: 'expand',
            up: 'CREATE INDEX workspace_audit_kind_time ON workspace_audit(targetKind, createdAt)',
        },
        {
            // CB-338: the id a renamed person's derived ids (apps', plugins',
            // coding volumes') keep coming from (@socio/data/person-seed).
            // Written only by the offline `backup rename-user`. Expand only:
            // an older build ignores the table.
            version: 21,
            name: 'person seeds of renamed users',
            phase: 'expand',
            up: 'CREATE TABLE person_seeds(userId TEXT PRIMARY KEY, seed TEXT NOT NULL)',
        },
    ],
};

/** The five slices `WorkspaceStore` is made of (`workspace/contract.ts`). */
export interface WorkspaceSlices {
    readonly people: SqlitePeople;
    readonly spaces: SqliteSpaces;
    readonly socios: SqliteSocios;
    readonly audit: SqliteAudit;
    readonly conversations: SqliteConversations;
}

/** What the Conversations slice is handed (`SqliteConversations`). */
type ConversationDeps = ConstructorParameters<typeof SqliteConversations>[1];

/**
 * The classes of the stores `WorkspaceStore` holds beside its slices, which
 * other folders own (pages, souls, computers, telegram, learning, live,
 * rooms, spaces, schedules). The workspace sits below most of them in the
 * folder order and can't import them, so each is, here, what the workspace
 * itself reads of it; the composition root names the real classes when it
 * opens the store (`AppWorkspace`, `composition/workspace-parts.ts`), and
 * `WorkspaceStore`'s type parameter carries them.
 */
export interface WorkspaceStoreTypes {
    pages: { flushSearchStats(): void };
    souls: SocioSouls;
    computers: ConversationDeps['computers'];
    telegram: ConversationDeps['telegram'];
    evidence: object;
    skills: object;
    counters: object;
    roomAccess: RoomRule;
    spaceAccess: SpaceRule & ConversationDeps['spaceAccess'];
    taskThreads: ConversationDeps['taskThreads'];
    /** Opens the learning analysis job over this workspace's evidence (`LearningAnalysis`). */
    openAnalysis: (...args: never[]) => unknown;
}

/** A data context on the workspace's connection (`sqliteData`). */
type WorkspaceData = ReturnType<typeof sqliteData>;

/**
 * How `WorkspaceStore` builds the stores beside its slices: the composition
 * root's (`composition/workspace-parts.ts`). Each is called once, in the
 * order the constructor always built them, on the store's connection.
 */
export interface WorkspaceStoreParts<T extends WorkspaceStoreTypes = WorkspaceStoreTypes> {
    counters(db: DatabaseSync): T['counters'];
    /** The one room access rule (CB-208), over the rooms' data on `data`. */
    roomAccess(
        data: WorkspaceData,
        deps: {
            /** Whether the person reaches the thread through a linked Telegram topic. */
            topicReader: (userId: string, threadId: string) => boolean;
            /** Settings → General → Rooms in force. */
            enabled: () => boolean;
        },
    ): T['roomAccess'];
    /** Who reads and approves each Space's shared memory (CB-181), over the Spaces' data on `data`. */
    spaceAccess(
        data: WorkspaceData,
        deps: {
            users: () => ReturnType<SqlitePeople['users']>;
            isDeactivated: (id: string) => boolean;
            spaces: () => ReturnType<SqliteSpaces['spaces']>;
            socioHas: (dotId: string, spaceId: string) => boolean;
            changed: (spaceId: string) => void;
            /** A change of people or access, as a `space_member` line of the workspace audit. */
            audit: (entry: {
                actor: string;
                action: 'create' | 'update' | 'remove';
                targetId: string;
                detail: string;
            }) => void;
        },
    ): T['spaceAccess'];
    /** The refusal Space access throws (`SpaceAccessError`). */
    spaceAccessError(message: string, status: 400 | 404 | 409): Error;
    /** Each socio's Soul; `audit` records a change on the socio's own audit. */
    souls(db: DatabaseSync, audit: (dotId: string, actor: string, detail: string, now: number) => void): T['souls'];
    computers(db: DatabaseSync): T['computers'];
    telegram(db: DatabaseSync): T['telegram'];
    taskThreads(data: WorkspaceData): T['taskThreads'];
    skills(db: DatabaseSync): T['skills'];
    /** The evidence ledger; `containerOf` is a thread's learning container, if it has one. */
    evidence(
        db: DatabaseSync,
        containerOf: (threadId: string) => { containerId: string; dotId: string; ownerId: string } | undefined,
    ): T['evidence'];
    /** The pages; `spaceExists` and `isPerson` check a page's Space and author. */
    pages(db: DatabaseSync, spaceExists: (id: string) => boolean, isPerson: (id: string) => boolean): T['pages'];
    /** The learning analysis job over `evidence`, opened when asked. */
    openAnalysis(db: DatabaseSync, evidence: T['evidence']): T['openAnalysis'];
}

/**
 * The workspace on one connection. It is the legacy facade over its slices,
 * `People`, `Spaces`, `Socios`, `Audit` and `Conversations` (`contract.ts`): it
 * builds them, and forwards their methods with today's names, so every caller
 * keeps working until it switches to the slice it uses; the root provides the
 * same five as tags (`workspace/layer.ts`). The stores beside them, which other
 * folders own, come from `parts`: the composition root passes its own
 * (`workspaceStoreParts`, `composition/workspace-parts.ts`), and `W` names
 * their classes. The transaction and the rooms switch stay here.
 */
export class WorkspaceStore<W extends WorkspaceStoreTypes = WorkspaceStoreTypes>
    implements PeopleShape, SpacesShape, SociosShape, AuditShape, ConversationsShape
{
    /** Shared with the sub-stores and modules (`ModuleContext.db`). */
    readonly db: DatabaseSync;
    /** The slices, built on this connection; the root's layers provide them. */
    readonly slices: WorkspaceSlices;
    readonly pages: W['pages'];
    /** Each socio's Soul and its versions (CB-179). */
    readonly souls: W['souls'];
    readonly computers: W['computers'];
    readonly telegram: W['telegram'];
    readonly evidence: W['evidence'];
    readonly skills: W['skills'];
    /**
     * Bumped by triggers on what the polled views read; the platform syncs them
     * again once the modules' tables exist.
     */
    readonly counters: W['counters'];
    /** Who hears each `AccessChange` (`onAccessChange`); the slices that make one share it. */
    private accessChanges = new AccessChanges();
    /** The data layer on this connection: its unit of work (CB-110). */
    readonly data: DataContext;
    /**
     * The conversation each scheduled task runs in: the Scheduling
     * context's repository on this connection (CB-110).
     */
    readonly taskThreads: W['taskThreads'];
    /** Whether this store opened its connection, and so closes it. */
    private owned: boolean;
    /**
     * The one access rule (CB-208) with each person's room
     * memberships: every reader and request check below goes through it.
     */
    readonly roomAccess: W['roomAccess'];
    /**
     * Who reads and approves each Space's shared memory (CB-181): its
     * people, their roles and whether it is theirs alone, asked afresh at
     * every read.
     */
    readonly spaceAccess: W['spaceAccess'];
    /** The learning analysis job's opener (`openAnalysis`). */
    private analysis: W['openAnalysis'];
    /** Settings → General → Rooms in force (`useRooms`); off until set. */
    private roomsOn: () => boolean = () => false;
    /**
     * A path opens a connection of its own (tests); the server passes the
     * one connection it shares with the core store (`openDatabase`, CB-110).
     * `parts` builds the stores beside the slices.
     */
    constructor(database: string | DatabaseSync, parts: WorkspaceStoreParts<W>) {
        this.owned = typeof database === 'string';
        this.db = typeof database === 'string' ? openDatabase(database) : database;
        this.data = { uow: sqliteData(this.db).uow };
        this.counters = parts.counters(this.db);
        const roomData = sqliteData(this.db);
        this.roomAccess = parts.roomAccess(roomData, {
            topicReader: (userId, threadId) => this.telegram.teamThreadsForNow(userId).includes(threadId),
            enabled: () => this.roomsOn(),
        });
        // The slices. Spaces and Socios need each other (a socio's grants name
        // live Spaces; deleting a Space asks which socios save to it), so
        // Spaces reaches the socios lazily, as the store did through `this`.
        const people = new SqlitePeople(this.db, this.accessChanges);
        const audit = new SqliteAudit(this.db);
        this.spaceAccess = parts.spaceAccess(roomData, {
            users: () => people.users(),
            isDeactivated: (id) => people.isDeactivated(id),
            spaces: () => spaces.spaces(),
            socioHas: (dotId, spaceId) => socios.canAccessSpace(dotId, spaceId),
            changed: (spaceId) => spaces.spaceChanged(spaceId),
            audit: (entry) => audit.audit({ ...entry, targetKind: 'space_member' }),
        });
        this.souls = parts.souls(this.db, (dotId, actor, detail, now) =>
            socios.auditDot(dotId, actor, 'update', detail, now),
        );
        const spaces: SqliteSpaces = new SqliteSpaces(this.db, {
            uow: this.data.uow,
            spaceAccess: this.spaceAccess,
            people,
            audit,
            socios: () => socios,
            changes: this.accessChanges,
            error: (message, status) => parts.spaceAccessError(message, status),
        });
        const socios = new SqliteSocios(this.db, { souls: this.souls, spaces, changes: this.accessChanges });
        this.computers = parts.computers(this.db);
        this.telegram = parts.telegram(this.db);
        this.taskThreads = parts.taskThreads(sqliteData(this.db));
        const conversations = new SqliteConversations(this.db, {
            roomAccess: this.roomAccess,
            spaceAccess: this.spaceAccess,
            telegram: this.telegram,
            computers: this.computers,
            taskThreads: this.taskThreads,
            socios,
            spaces,
            changes: this.accessChanges,
            denied: (reason) => new RoomAccessError(reason),
        });
        this.slices = { people, spaces, socios, audit, conversations };
        this.skills = parts.skills(this.db);
        this.evidence = parts.evidence(this.db, (threadId) => {
            const thread = this.thread(threadId);
            return thread?.learningContainerId
                ? {
                      containerId: thread.learningContainerId,
                      dotId: thread.dotId,
                      ownerId: thread.ownerId,
                  }
                : undefined;
        });
        this.pages = parts.pages(
            this.db,
            (id) => this.spaces().some((space) => space.id === id),
            (id) =>
                !!this.db
                    .prepare('SELECT 1 FROM users WHERE id=? AND id NOT IN (SELECT userId FROM service_accounts)')
                    .get(id),
        );
        this.analysis = parts.openAnalysis(this.db, this.evidence);
        if (!this.spaces().length) {
            const space = this.createSpace('Everyday', 'A little space for your day.');
            // A new workspace's first socio is Sebas, one of the mascot cast
            // (CB-177), with Sebas's look (CB-256); existing workspaces keep the
            // socios they have.
            this.createDot(
                space.id,
                'Sebas',
                'Be thoughtful, practical, and concise. Help the user think clearly and follow through.',
                true,
                true,
                [space.id],
                null,
                false,
                null,
                false,
                null,
                'system',
                'sebas',
            );
        }
    }
    /** Called after each `AccessChange` (platform.ts: socio access). */
    onAccessChange(listener: (change: AccessChange) => void) {
        return this.accessChanges.on(listener);
    }
    // ── People (`slices.people`) ──
    recordUser(...args: Parameters<PeopleShape['recordUser']>) {
        return this.slices.people.recordUser(...args);
    }
    users(...args: Parameters<PeopleShape['users']>) {
        return this.slices.people.users(...args);
    }
    hasUser(...args: Parameters<PeopleShape['hasUser']>) {
        return this.slices.people.hasUser(...args);
    }
    useDeactivated(...args: Parameters<PeopleShape['useDeactivated']>) {
        return this.slices.people.useDeactivated(...args);
    }
    deactivatedUsers(...args: Parameters<PeopleShape['deactivatedUsers']>) {
        return this.slices.people.deactivatedUsers(...args);
    }
    isDeactivated(...args: Parameters<PeopleShape['isDeactivated']>) {
        return this.slices.people.isDeactivated(...args);
    }
    migrateLegacyOwner(...args: Parameters<PeopleShape['migrateLegacyOwner']>) {
        return this.slices.people.migrateLegacyOwner(...args);
    }
    preferences(...args: Parameters<PeopleShape['preferences']>) {
        return this.slices.people.preferences(...args);
    }
    setPreferences(...args: Parameters<PeopleShape['setPreferences']>) {
        return this.slices.people.setPreferences(...args);
    }
    lastSeenRelease(...args: Parameters<PeopleShape['lastSeenRelease']>) {
        return this.slices.people.lastSeenRelease(...args);
    }
    markReleaseSeen(...args: Parameters<PeopleShape['markReleaseSeen']>) {
        return this.slices.people.markReleaseSeen(...args);
    }
    recordReleaseViews(...args: Parameters<PeopleShape['recordReleaseViews']>) {
        return this.slices.people.recordReleaseViews(...args);
    }
    releaseViews(...args: Parameters<PeopleShape['releaseViews']>) {
        return this.slices.people.releaseViews(...args);
    }
    // ── Spaces (`slices.spaces`) ──
    spaces(...args: Parameters<SpacesShape['spaces']>) {
        return this.slices.spaces.spaces(...args);
    }
    createSpace(...args: Parameters<SpacesShape['createSpace']>) {
        return this.slices.spaces.createSpace(...args);
    }
    createSpaceFor(...args: Parameters<SpacesShape['createSpaceFor']>) {
        return this.slices.spaces.createSpaceFor(...args);
    }
    renameSpace(...args: Parameters<SpacesShape['renameSpace']>) {
        return this.slices.spaces.renameSpace(...args);
    }
    deleteSpace(...args: Parameters<SpacesShape['deleteSpace']>) {
        return this.slices.spaces.deleteSpace(...args);
    }
    spaceDeleteBlocker(...args: Parameters<SpacesShape['spaceDeleteBlocker']>) {
        return this.slices.spaces.spaceDeleteBlocker(...args);
    }
    restoreSpace(...args: Parameters<SpacesShape['restoreSpace']>) {
        return this.slices.spaces.restoreSpace(...args);
    }
    withDeletedSpace(...args: Parameters<SpacesShape['withDeletedSpace']>) {
        return this.slices.spaces.withDeletedSpace(...args);
    }
    deletedSpaces(...args: Parameters<SpacesShape['deletedSpaces']>) {
        return this.slices.spaces.deletedSpaces(...args);
    }
    readsSpace(...args: Parameters<SpacesShape['readsSpace']>) {
        return this.slices.spaces.readsSpace(...args);
    }
    editsSpace(...args: Parameters<SpacesShape['editsSpace']>) {
        return this.slices.spaces.editsSpace(...args);
    }
    onSpaceAccessChange(...args: Parameters<SpacesShape['onSpaceAccessChange']>) {
        return this.slices.spaces.onSpaceAccessChange(...args);
    }
    // ── Dots (`slices.socios`) ──
    dots(...args: Parameters<SociosShape['dots']>) {
        return this.slices.socios.dots(...args);
    }
    allDots(...args: Parameters<SociosShape['allDots']>) {
        return this.slices.socios.allDots(...args);
    }
    companyDots(...args: Parameters<SociosShape['companyDots']>) {
        return this.slices.socios.companyDots(...args);
    }
    dotsFor(...args: Parameters<SociosShape['dotsFor']>) {
        return this.slices.socios.dotsFor(...args);
    }
    dot(...args: Parameters<SociosShape['dot']>) {
        return this.slices.socios.dot(...args);
    }
    canUseDot(...args: Parameters<SociosShape['canUseDot']>) {
        return this.slices.socios.canUseDot(...args);
    }
    personalDotCount(...args: Parameters<SociosShape['personalDotCount']>) {
        return this.slices.socios.personalDotCount(...args);
    }
    createDot(...args: Parameters<SociosShape['createDot']>) {
        return this.slices.socios.createDot(...args);
    }
    updateDot(...args: Parameters<SociosShape['updateDot']>) {
        return this.slices.socios.updateDot(...args);
    }
    archiveDot(...args: Parameters<SociosShape['archiveDot']>) {
        return this.slices.socios.archiveDot(...args);
    }
    unarchiveDot(...args: Parameters<SociosShape['unarchiveDot']>) {
        return this.slices.socios.unarchiveDot(...args);
    }
    dotAudit(...args: Parameters<SociosShape['dotAudit']>) {
        return this.slices.socios.dotAudit(...args);
    }
    canAccessSpace(...args: Parameters<SociosShape['canAccessSpace']>) {
        return this.slices.socios.canAccessSpace(...args);
    }
    // ── Audit (`slices.audit`) ──
    audit(...args: Parameters<AuditShape['audit']>) {
        return this.slices.audit.audit(...args);
    }
    auditNow(...args: Parameters<AuditShape['auditNow']>) {
        return this.slices.audit.auditNow(...args);
    }
    auditOf(...args: Parameters<AuditShape['auditOf']>) {
        return this.slices.audit.auditOf(...args);
    }
    // ── Conversations (`slices.conversations`) ──
    dotThreadTaskIds(...args: Parameters<ConversationsShape['dotThreadTaskIds']>) {
        return this.slices.conversations.dotThreadTaskIds(...args);
    }
    chatReaders(...args: Parameters<ConversationsShape['chatReaders']>) {
        return this.slices.conversations.chatReaders(...args);
    }
    socioReader(...args: Parameters<ConversationsShape['socioReader']>) {
        return this.slices.conversations.socioReader(...args);
    }
    addChatPages(...args: Parameters<ConversationsShape['addChatPages']>) {
        return this.slices.conversations.addChatPages(...args);
    }
    chatSpace(...args: Parameters<ConversationsShape['chatSpace']>) {
        return this.slices.conversations.chatSpace(...args);
    }
    chatHidden(...args: Parameters<ConversationsShape['chatHidden']>) {
        return this.slices.conversations.chatHidden(...args);
    }
    socioReads(...args: Parameters<ConversationsShape['socioReads']>) {
        return this.slices.conversations.socioReads(...args);
    }
    usedDot(...args: Parameters<ConversationsShape['usedDot']>) {
        return this.slices.conversations.usedDot(...args);
    }
    conversations(...args: Parameters<ConversationsShape['conversations']>) {
        return this.slices.conversations.conversations(...args);
    }
    archivedConversations(...args: Parameters<ConversationsShape['archivedConversations']>) {
        return this.slices.conversations.archivedConversations(...args);
    }
    setArchived(...args: Parameters<ConversationsShape['setArchived']>) {
        return this.slices.conversations.setArchived(...args);
    }
    access(...args: Parameters<ConversationsShape['access']>) {
        return this.slices.conversations.access(...args);
    }
    answeringSocios(...args: Parameters<ConversationsShape['answeringSocios']>) {
        return this.slices.conversations.answeringSocios(...args);
    }
    answers(...args: Parameters<ConversationsShape['answers']>) {
        return this.slices.conversations.answers(...args);
    }
    allows(...args: Parameters<ConversationsShape['allows']>) {
        return this.slices.conversations.allows(...args);
    }
    requireAccess(...args: Parameters<ConversationsShape['requireAccess']>) {
        return this.slices.conversations.requireAccess(...args);
    }
    readableThread(...args: Parameters<ConversationsShape['readableThread']>) {
        return this.slices.conversations.readableThread(...args);
    }
    thread(...args: Parameters<ConversationsShape['thread']>) {
        return this.slices.conversations.thread(...args);
    }
    convertedFrom(...args: Parameters<ConversationsShape['convertedFrom']>) {
        return this.slices.conversations.convertedFrom(...args);
    }
    withDeletedThread(...args: Parameters<ConversationsShape['withDeletedThread']>) {
        return this.slices.conversations.withDeletedThread(...args);
    }
    deletedThreadIds(...args: Parameters<ConversationsShape['deletedThreadIds']>) {
        return this.slices.conversations.deletedThreadIds(...args);
    }
    setThreadInference(...args: Parameters<ConversationsShape['setThreadInference']>) {
        return this.slices.conversations.setThreadInference(...args);
    }
    bindThread(...args: Parameters<ConversationsShape['bindThread']>) {
        return this.slices.conversations.bindThread(...args);
    }
    isTitled(...args: Parameters<ConversationsShape['isTitled']>) {
        return this.slices.conversations.isTitled(...args);
    }
    setAutomaticTitle(...args: Parameters<ConversationsShape['setAutomaticTitle']>) {
        return this.slices.conversations.setAutomaticTitle(...args);
    }
    renameThread(...args: Parameters<ConversationsShape['renameThread']>) {
        return this.slices.conversations.renameThread(...args);
    }
    requireThread(...args: Parameters<ConversationsShape['requireThread']>) {
        return this.slices.conversations.requireThread(...args);
    }
    requireOwnedThread(...args: Parameters<ConversationsShape['requireOwnedThread']>) {
        return this.slices.conversations.requireOwnedThread(...args);
    }
    requireOwnedCall(...args: Parameters<ConversationsShape['requireOwnedCall']>) {
        return this.slices.conversations.requireOwnedCall(...args);
    }
    callsFor(...args: Parameters<ConversationsShape['callsFor']>) {
        return this.slices.conversations.callsFor(...args);
    }
    bindTask(...args: Parameters<ConversationsShape['bindTask']>) {
        return this.slices.conversations.bindTask(...args);
    }
    threadTasks(...args: Parameters<ConversationsShape['threadTasks']>) {
        return this.slices.conversations.threadTasks(...args);
    }
    deleteThread(...args: Parameters<ConversationsShape['deleteThread']>) {
        return this.slices.conversations.deleteThread(...args);
    }
    deleteBlocker(...args: Parameters<ConversationsShape['deleteBlocker']>) {
        return this.slices.conversations.deleteBlocker(...args);
    }
    taskThread(...args: Parameters<ConversationsShape['taskThread']>) {
        return this.slices.conversations.taskThread(...args);
    }
    calls(...args: Parameters<ConversationsShape['calls']>) {
        return this.slices.conversations.calls(...args);
    }
    createCall(...args: Parameters<ConversationsShape['createCall']>) {
        return this.slices.conversations.createCall(...args);
    }
    call(...args: Parameters<ConversationsShape['call']>) {
        return this.slices.conversations.call(...args);
    }
    setCall(...args: Parameters<ConversationsShape['setCall']>) {
        return this.slices.conversations.setCall(...args);
    }
    saveLateTranscript(...args: Parameters<ConversationsShape['saveLateTranscript']>) {
        return this.slices.conversations.saveLateTranscript(...args);
    }
    anchorCall(...args: Parameters<ConversationsShape['anchorCall']>) {
        return this.slices.conversations.anchorCall(...args);
    }
    setCallError(...args: Parameters<ConversationsShape['setCallError']>) {
        return this.slices.conversations.setCallError(...args);
    }
    saveCapture(...args: Parameters<ConversationsShape['saveCapture']>) {
        return this.slices.conversations.saveCapture(...args);
    }
    capture(...args: Parameters<ConversationsShape['capture']>) {
        return this.slices.conversations.capture(...args);
    }
    // ── The store itself ──
    /** Saves the search stats; closes the connection if this store opened it. */
    close() {
        if (!this.db.isOpen) {
            return;
        }
        this.pages.flushSearchStats();
        if (this.owned) {
            this.db.close();
        }
    }
    /**
     * Runs `fn` in one transaction on this connection (the sub-stores share
     * it): queued behind another context's open unit of work, or inside this
     * context's (CB-110). Await it.
     */
    transaction<T>(fn: () => T, label = 'workspace change'): Promise<T> {
        return transaction(this.db, label, fn);
    }
    /** The learning analysis job over this workspace's evidence. */
    openAnalysis(...args: Parameters<W['openAnalysis']>): ReturnType<W['openAnalysis']> {
        return this.analysis(...args) as ReturnType<W['openAnalysis']>;
    }
    /**
     * Settings → General → Rooms in force (CB-208): the platform's switch,
     * which the access rule reads; off until set (a store opened alone).
     */
    useRooms(enabled: () => boolean) {
        this.roomsOn = enabled;
    }
    roomsEnabled() {
        return this.roomsOn();
    }
}
