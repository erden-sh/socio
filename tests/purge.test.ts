import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bootDatabase } from '../src/server/modules/boot.js';
import { planLines, readProtectFile, readPurgeList } from '../src/server/purge/list.js';
import {
    applyPurgeRows,
    cleanupOf,
    contentDigest,
    finishCleanup,
    planPurge,
    type PurgeList,
} from '../src/server/purge/purge.js';
import { NESTED, NOT_REFERENCES, REFERENCES } from '../src/server/purge/references.js';

let dir: string;
let db: DatabaseSync;
let userDataDir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'purge-'));
    const path = join(dir, 'db.sqlite');
    bootDatabase(path, { backupDirectory: join(dir, 'backups'), log: () => {} });
    db = new DatabaseSync(path);
    userDataDir = join(dir, 'userdata');
});
afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

const T = 1_790_000_000_000;
function person(id: string, role: 'admin' | 'member', options: { deactivated?: boolean; account?: boolean } = {}) {
    db.prepare('INSERT INTO users (id, name, role, createdAt, lastSeenAt) VALUES (?, ?, ?, ?, ?)').run(
        id,
        id,
        role,
        T,
        T,
    );
    if (options.account !== false) {
        db.prepare(
            'INSERT INTO auth_user (id, name, email, emailVerified, createdAt, updatedAt, appUserId, role, banned) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)',
        ).run(`auth-${id}`, id, `${id}@example.invalid`, T, T, id, role, options.deactivated ? 1 : 0);
        db.prepare(
            'INSERT INTO auth_session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(`session-${id}`, T, `token-${id}`, T, T, `auth-${id}`);
    }
}
const space = (id: string) =>
    db.prepare("INSERT INTO spaces (id, name, description, createdAt) VALUES (?, ?, '', ?)").run(id, id, T);
const page = (id: string, spaceId: string, createdBy: string) =>
    db
        .prepare(
            "INSERT INTO pages (id, spaceId, title, content, revision, createdAt, updatedAt, createdBy) VALUES (?, ?, ?, '', 1, ?, ?, ?)",
        )
        .run(id, spaceId, id, T, T, createdBy);
function socio(id: string, spaceId: string, ownerId: string | null) {
    db.prepare(
        "INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt, ownerId) VALUES (?, ?, ?, '', 0, 0, ?, ?)",
    ).run(id, spaceId, id, T, ownerId);
    db.prepare('INSERT INTO dot_spaces (dotId, spaceId) VALUES (?, ?)').run(id, spaceId);
}
function conversation(id: string, dotId: string, ownerId: string) {
    db.prepare('INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt) VALUES (?, ?, ?, ?, ?)').run(
        id,
        dotId,
        ownerId,
        id,
        T,
    );
    db.prepare(
        "INSERT INTO agent_runs (threadId, runId, status, events, startedAt) VALUES (?, ?, 'done', '[]', ?)",
    ).run(id, `run-${id}`, T);
}
function dataset(id: string, ownerUserId: string) {
    db.prepare('INSERT INTO data_datasets (id, ownerUserId, name, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)').run(
        id,
        ownerUserId,
        id,
        T,
        T,
    );
    const folder = join(userDataDir, ownerUserId, 'datasets');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${id}.sqlite`), 'x'.repeat(100));
}
function comment(id: string, authorId: string) {
    db.prepare(
        "INSERT INTO issue_comments (id, issueId, authorKind, authorId, body, createdAt) VALUES (?, 'issue-1', 'user', ?, 'hi', ?)",
    ).run(id, authorId, T);
}

function codingSession(
    id: string,
    personId: string,
    socioId: string,
    threadId: string,
    state: { ended?: boolean; sandboxGone?: boolean; volumeGone?: boolean } = {},
) {
    db.prepare(
        `INSERT INTO coding_sessions (id, personId, socioId, threadId, conversationKind, repository, repositoryKey, base, branch, shortId, model, push, volumeKey, opencodeSession, state, createdAt, endsAt, lastPromptAt, endedAt, sandboxGoneAt, volumeGoneAt)
         VALUES (?, ?, ?, ?, 'private', 'acme/app', 'acme/app', 'main', ?, ?, 'model', 0, ?, 'oc', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        id,
        personId,
        socioId,
        threadId,
        `socio/${id}`,
        `short-${id}`.slice(0, 16),
        id.padEnd(64, '0'),
        state.ended ? 'ended' : 'ready',
        T,
        T,
        T,
        state.ended ? T : null,
        state.sandboxGone ? T : null,
        state.volumeGone ? T : null,
    );
    db.prepare("INSERT INTO coding_runs (id, sessionId, kind, state, startedAt) VALUES (?, ?, 'setup', 'done', ?)").run(
        `run-${id}`,
        id,
        T,
    );
    db.prepare("INSERT INTO coding_denials (sessionId, target, firstAt, count) VALUES (?, 'example.com', ?, 1)").run(
        id,
        T,
    );
}
function codingEvent(id: string, sessionId: string, personId: string, requesterId: string) {
    db.prepare(
        "INSERT INTO coding_thread_events (id, sessionId, personId, requesterId, kind, ordinal, payload, createdAt) VALUES (?, ?, ?, ?, 'turn.terminal', 0, '{}', ?)",
    ).run(id, sessionId, personId, requesterId, T);
}

/** A workspace with a real operator and a deactivated test person who made things. */
function seed() {
    person('alice', 'admin');
    person('tester', 'admin', { deactivated: true });
    space('everyday');
    space('test-space');
    space('testing');
    page('real-page', 'everyday', 'alice');
    page('test-page', 'test-space', 'tester');
    socio('librarian', 'everyday', 'alice');
    socio('test-socio', 'everyday', 'tester');
    conversation('real-chat', 'librarian', 'alice');
    conversation('test-chat', 'test-socio', 'tester');
    dataset('test-data', 'tester');
    dataset('real-data', 'alice');
    comment('real-comment', 'alice');
    comment('test-comment', 'tester');
    db.prepare(
        "INSERT INTO space_members (spaceId, userId, role, addedBy, addedAt, updatedAt) VALUES ('test-space', 'tester', 'editor', 'alice', ?, ?)",
    ).run(T, T);
}

const options = () => ({ userDataDir, tenantId: 'main', protect: ['alice', 'testing'] });
function plan(list: PurgeList) {
    db.exec('BEGIN');
    try {
        return planPurge(db, list, options());
    } finally {
        db.exec('ROLLBACK');
    }
}
async function apply(list: PurgeList) {
    db.exec('BEGIN IMMEDIATE');
    const planned = planPurge(db, list, options());
    try {
        const deleted = applyPurgeRows(db, list, planned, options());
        db.exec('COMMIT');
        await finishCleanup(cleanupOf(planned, userDataDir, { computers: false }));
        return deleted;
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}
const rows = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
const FULL: PurgeList = {
    users: ['tester'],
    socios: ['test-socio'],
    spaces: ['test-space'],
    pages: ['test-page'],
    datasets: ['test-data'],
    conversations: ['test-chat'],
};

describe('purge references', () => {
    it('places every column of the migrated database that names a record', () => {
        const NAMES =
            /^(?:.*(?:[uU]serId|[oO]wnerId|[dD]otId|[sS]ocioId|[pP]ersonId|[sS]paceId|[pP]ageId|[dD]atasetId|[aA]ppId|[jJ]obId|[rR]oomId|[tT]hreadId|[cC]onversationId|[aA]ctorId|[aA]uthorId|[rR]eporterId|[aA]ssigneeId|[rR]equesterId|[hH]olderId|[iI]nitiatorId|[uU]ploaderId)|.*By|actor|appUserId)$/;
        const placed = new Set([
            ...REFERENCES.map((ref) => `${ref.table}.${ref.column}`),
            ...NESTED.map((ref) => `${ref.table}.${ref.column}`),
            ...Object.keys(NOT_REFERENCES),
        ]);
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            .all() as { name: string }[];
        const missing: string[] = [];
        for (const { name } of tables) {
            for (const column of db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]) {
                if (NAMES.test(column.name) && !placed.has(`${name}.${column.name}`)) {
                    missing.push(`${name}.${column.name}`);
                }
            }
        }
        // A new column that names a person, socio, Space, page, dataset,
        // app, job, room or conversation: place it in references.ts.
        expect(missing).toEqual([]);
    });

    it('names only tables and columns that exist', () => {
        const has = (table: string, column: string) =>
            (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).some((c) => c.name === column);
        const stale = [...REFERENCES, ...NESTED]
            .filter((ref) => !has(ref.table, ref.column))
            .map((ref) => `${ref.table}.${ref.column}`);
        expect(stale).toEqual([]);
    });
});

describe('purge', () => {
    it('plans without changing anything', () => {
        seed();
        const before = rows('users') + rows('dots') + rows('thread_bindings') + rows('agent_runs');
        const result = plan(FULL);
        expect(result.refusals).toEqual([]);
        const byTable = Object.fromEntries(result.tables.map((entry) => [entry.table, entry.rows]));
        expect(byTable).toMatchObject({
            users: 1,
            auth_user: 1,
            auth_session: 1,
            dots: 1,
            dot_spaces: 1,
            thread_bindings: 1,
            agent_runs: 1,
            spaces: 1,
            pages: 1,
            data_datasets: 1,
            space_members: 1,
        });
        expect(result.files.map((file) => file.path)).toEqual([
            join(userDataDir, 'tester', 'datasets', 'test-data.sqlite'),
        ]);
        expect(result.kept).toContainEqual({ table: 'issue_comments', column: 'authorId', rows: 1 });
        expect(rows('users') + rows('dots') + rows('thread_bindings') + rows('agent_runs')).toBe(before);
        expect(planLines(result, false).join('\n')).toContain('dry run');
    });

    it('removes the records, their dependents and files, and keeps history', async () => {
        seed();
        await apply(FULL);
        expect(
            db
                .prepare('SELECT id FROM users ORDER BY id')
                .all()
                .map((row) => (row as { id: string }).id),
        ).toEqual(['alice']);
        expect(rows('auth_user')).toBe(1);
        expect(rows('auth_session')).toBe(1);
        expect(db.prepare('SELECT id FROM dots').all()).toEqual([{ id: 'librarian' }]);
        expect(db.prepare('SELECT threadId FROM agent_runs').all()).toEqual([{ threadId: 'real-chat' }]);
        expect(
            db
                .prepare('SELECT id FROM spaces ORDER BY id')
                .all()
                .map((row) => (row as { id: string }).id),
        ).toEqual(['everyday', 'testing']);
        expect(rows('space_members')).toBe(0);
        expect(existsSync(join(userDataDir, 'tester'))).toBe(false);
        expect(existsSync(join(userDataDir, 'alice', 'datasets', 'real-data.sqlite'))).toBe(true);
        // The board's history stays, naming the id.
        expect(rows('issue_comments')).toBe(2);
    });

    it('leaves a plugin’s datasets alone when a person and their socio are purged', async () => {
        seed();
        // A service plugin's dataset (`plugin:<id>`): the company's. The test
        // person granted their socio read on it and their actions on it are
        // in the audit; none of that makes it theirs.
        dataset('plugin-marts', 'plugin:datasync');
        db.prepare(
            "INSERT INTO data_grants (id, ownerUserId, dotId, datasetId, folder, access, createdBy, createdAt) VALUES ('g-plugin', 'plugin:datasync', 'test-socio', 'plugin-marts', NULL, 'read', 'tester', ?)",
        ).run(T);
        db.prepare(
            "INSERT INTO data_audit (id, ownerUserId, actorKind, actorId, dotId, datasetId, target, action, outcome, createdAt, area) VALUES ('a-plugin', 'tester', 'user', 'tester', NULL, 'plugin-marts', 'marts', 'export_csv', 'ok', ?, NULL)",
        ).run(T);
        const planned = plan(FULL);
        expect(planned.refusals).toEqual([]);
        await apply(FULL);
        expect(db.prepare("SELECT ownerUserId, deletedAt FROM data_datasets WHERE id='plugin-marts'").get()).toEqual({
            ownerUserId: 'plugin:datasync',
            deletedAt: null,
        });
        expect(existsSync(join(userDataDir, 'plugin:datasync', 'datasets', 'plugin-marts.sqlite'))).toBe(true);
        // The purged socio's grant goes with the socio; the history stays.
        expect(db.prepare("SELECT 1 FROM data_grants WHERE id='g-plugin'").get()).toBeUndefined();
        expect(db.prepare("SELECT 1 FROM data_audit WHERE id='a-plugin'").get()).toBeDefined();
        expect(db.prepare("SELECT 1 FROM data_datasets WHERE id='test-data'").get()).toBeUndefined();
    });

    it('purges a dataset’s analytical parts with it, read-only files included', async () => {
        seed();
        // An owner whose folder is its id, as the helper lays files out.
        dataset('plugin-events', 'plugin-owner');
        const parts = join(userDataDir, 'plugin-owner', 'datasets', 'plugin-events.parts');
        mkdirSync(join(parts, 't1', 'p=2026-11-09'), { recursive: true });
        const part = join(parts, 't1', 'p=2026-11-09', 'part-1.parquet');
        writeFileSync(part, 'PARQUET');
        chmodSync(part, 0o444);
        const list = { datasets: ['plugin-events'] };
        expect(plan(list).files.map((file) => file.path)).toEqual([
            join(userDataDir, 'plugin-owner', 'datasets', 'plugin-events.sqlite'),
            part,
        ]);
        await apply(list);
        expect(existsSync(join(userDataDir, 'plugin-owner', 'datasets', 'plugin-events.sqlite'))).toBe(false);
        expect(existsSync(parts)).toBe(false);
    });

    it('refuses a record under a listed one unless the list cascades to it', async () => {
        seed();
        const list = { users: ['tester'] };
        const refused = plan(list);
        expect(refused.refusals.join('\n')).toMatch(/socios test-socio is under a listed users/);
        expect(refused.refusals.join('\n')).toMatch(/conversations test-chat is under a listed users/);
        await expect(apply(list)).rejects.toThrow(/Refused/);
        expect(rows('users')).toBe(2);

        const cascading = plan({ users: ['tester'], cascade: true });
        expect(cascading.refusals).toEqual([]);
        expect(cascading.cascaded.socios).toEqual(['test-socio']);
        expect(cascading.cascaded.conversations).toEqual(['test-chat']);
        expect(cascading.cascaded.datasets).toEqual(['test-data']);
    });

    it('refuses protected ids, rows that belong to them, and active operators and admins', () => {
        seed();
        person('helper', 'admin');
        person('service', 'admin', { account: false });
        expect(plan({ users: ['alice'], cascade: true }).refusals.join('\n')).toMatch(/users alice is protected/);
        expect(plan({ users: ['helper'] }).refusals).toEqual([
            'users helper is an active admin: deactivate the account first (auth deactivate).',
        ]);
        expect(plan({ users: ['service'] }).refusals.join('\n')).toMatch(/users service is an active admin/);
        db.prepare(
            "INSERT INTO space_members (spaceId, userId, role, addedAt, updatedAt) VALUES ('testing', 'tester', 'member', ?, ?)",
        ).run(T, T);
        expect(plan(FULL).refusals.join('\n')).toMatch(/space_members that would go belong to a protected id/);
    });

    it('refuses schedules and unknown ids', () => {
        seed();
        db.prepare(
            "INSERT INTO tasks (id, prompt, status, createdAt, updatedAt, userId, dotId) VALUES ('daily', 'p', 'active', ?, ?, 'tester', 'test-socio')",
        ).run(T, T);
        const refusals = plan({ ...FULL, jobs: ['nope'] }).refusals.join('\n');
        expect(refusals).toMatch(/No jobs nope here/);
        expect(refusals).toMatch(/tasks.userId name a listed users/);
        expect(refusals).toMatch(/tasks.dotId name a listed socios/);
    });

    it('removes coding sessions that hold nothing any more, with their runs and events', async () => {
        seed();
        // Ended, sandbox and volume gone: only their requests and reports are left.
        codingSession('old-1', 'tester', 'test-socio', 'test-chat', {
            ended: true,
            sandboxGone: true,
            volumeGone: true,
        });
        codingSession('old-2', 'tester', 'librarian', 'real-chat', {
            ended: true,
            sandboxGone: true,
            volumeGone: true,
        });
        codingSession('alice-live', 'alice', 'librarian', 'real-chat');
        codingEvent('e-old', 'old-1', 'tester', 'tester');
        codingEvent('e-alice', 'alice-live', 'alice', 'alice');
        const planned = plan(FULL);
        expect(planned.refusals).toEqual([]);
        expect(Object.fromEntries(planned.tables.map((entry) => [entry.table, entry.rows]))).toMatchObject({
            coding_sessions: 2,
            coding_runs: 2,
            coding_denials: 2,
            coding_thread_events: 1,
        });
        await apply(FULL);
        expect(db.prepare('SELECT id FROM coding_sessions').all()).toEqual([{ id: 'alice-live' }]);
        expect(db.prepare('SELECT sessionId FROM coding_runs').all()).toEqual([{ sessionId: 'alice-live' }]);
        expect(db.prepare('SELECT sessionId FROM coding_denials').all()).toEqual([{ sessionId: 'alice-live' }]);
        expect(db.prepare('SELECT id FROM coding_thread_events').all()).toEqual([{ id: 'e-alice' }]);
    });

    it('refuses coding sessions that still hold a sandbox or a volume', async () => {
        seed();
        person('bob', 'member');
        codingSession('live', 'tester', 'test-socio', 'test-chat');
        codingSession('kept-volume', 'tester', 'test-socio', 'test-chat', { ended: true, sandboxGone: true });
        // Someone else's live session that the purged person asked for something in.
        codingSession('bob-live', 'bob', 'librarian', 'real-chat');
        codingEvent('e-asked', 'bob-live', 'bob', 'tester');
        const refusals = plan(FULL).refusals;
        expect(refusals).toContain(
            "2 row(s) of coding_sessions.personId name a listed users: the purge doesn't remove those; end them in the app first.",
        );
        expect(refusals.join('\n')).toMatch(/2 row\(s\) of coding_sessions.socioId name a listed socios/);
        expect(refusals.join('\n')).toMatch(/1 row\(s\) of coding_thread_events.requesterId name a listed users/);
        await expect(apply(FULL)).rejects.toThrow(/Refused/);
        expect(rows('coding_sessions')).toBe(3);
        expect(rows('coding_thread_events')).toBe(1);
    });

    it('removes an ended session’s events that name someone else, and nothing else of theirs', async () => {
        seed();
        person('bob', 'member');
        codingSession('old-1', 'tester', 'test-socio', 'test-chat', {
            ended: true,
            sandboxGone: true,
            volumeGone: true,
        });
        // Bob's turns in the purged person's session: only the session takes them.
        codingEvent('e-bob-in-old', 'old-1', 'bob', 'bob');
        // Bob's own sessions, live and ended, outside the purged one.
        codingSession('bob-live', 'bob', 'librarian', 'real-chat');
        codingSession('bob-old', 'bob', 'librarian', 'real-chat', { ended: true, sandboxGone: true, volumeGone: true });
        codingEvent('e-bob-live', 'bob-live', 'bob', 'bob');
        codingEvent('e-bob-old', 'bob-old', 'bob', 'bob');
        const planned = plan(FULL);
        expect(planned.refusals).toEqual([]);
        expect(Object.fromEntries(planned.tables.map((entry) => [entry.table, entry.rows]))).toMatchObject({
            coding_sessions: 1,
            coding_runs: 1,
            coding_denials: 1,
            coding_thread_events: 1,
        });
        await apply(FULL);
        expect(
            db
                .prepare('SELECT id FROM coding_sessions ORDER BY id')
                .all()
                .map((row) => (row as { id: string }).id),
        ).toEqual(['bob-live', 'bob-old']);
        expect(
            db
                .prepare('SELECT id FROM coding_thread_events ORDER BY id')
                .all()
                .map((row) => (row as { id: string }).id),
        ).toEqual(['e-bob-live', 'e-bob-old']);
        expect(rows('coding_runs')).toBe(2);
        expect(rows('coding_denials')).toBe(2);
        expect(db.prepare("SELECT 1 FROM users WHERE id='bob'").get()).toBeDefined();
    });

    it.each<[string, { starting?: boolean; ended?: boolean; sandboxGone?: boolean; volumeGone?: boolean }]>([
        ['ended with its sandbox kept', { ended: true, volumeGone: true }],
        ['ended with its volume kept', { ended: true, sandboxGone: true }],
        ['ready, both gone', { sandboxGone: true, volumeGone: true }],
        ['starting, both gone', { starting: true, sandboxGone: true, volumeGone: true }],
    ])('refuses a coding session %s', async (_, { starting, ...state }) => {
        seed();
        codingSession('held', 'tester', 'test-socio', 'test-chat', state);
        if (starting) {
            db.prepare("UPDATE coding_sessions SET state='starting' WHERE id='held'").run();
        }
        codingEvent('e-held', 'held', 'tester', 'tester');
        const refusals = plan(FULL).refusals.join('\n');
        expect(refusals).toMatch(/1 row\(s\) of coding_sessions.personId name a listed users/);
        expect(refusals).toMatch(/1 row\(s\) of coding_sessions.socioId name a listed socios/);
        expect(refusals).toMatch(/1 row\(s\) of coding_sessions.threadId name a listed threads/);
        expect(refusals).toMatch(/1 row\(s\) of coding_thread_events.personId name a listed users/);
        await expect(apply(FULL)).rejects.toThrow(/Refused/);
        expect(rows('coding_sessions')).toBe(1);
        expect(rows('coding_thread_events')).toBe(1);
    });

    it('stops when a coding session holds something again after the plan', () => {
        seed();
        codingSession('old-1', 'tester', 'test-socio', 'test-chat', {
            ended: true,
            sandboxGone: true,
            volumeGone: true,
        });
        db.exec('BEGIN IMMEDIATE');
        const planned = planPurge(db, FULL, options());
        expect(planned.refusals).toEqual([]);
        db.prepare("UPDATE coding_sessions SET volumeGoneAt=NULL WHERE id='old-1'").run();
        expect(() => applyPurgeRows(db, FULL, planned, options())).toThrow(/changed since the plan/);
        db.exec('ROLLBACK');
        expect(rows('coding_sessions')).toBe(1);
        expect(rows('users')).toBe(2);
    });

    it('stops when the data changed after the plan', () => {
        seed();
        db.exec('BEGIN IMMEDIATE');
        const planned = planPurge(db, FULL, options());
        conversation('late-chat', 'test-socio', 'tester');
        expect(() => applyPurgeRows(db, FULL, planned, options())).toThrow(/changed since the plan/);
        db.exec('ROLLBACK');
        expect(rows('users')).toBe(2);
    });

    it('stops when a row that goes was edited after the backup, counts unchanged', () => {
        seed();
        db.exec('BEGIN');
        planPurge(db, FULL, options());
        const backedUp = contentDigest(db);
        db.exec('ROLLBACK');
        db.prepare("UPDATE pages SET content='edited later' WHERE id='test-page'").run();
        db.exec('BEGIN IMMEDIATE');
        const planned = planPurge(db, FULL, options());
        expect(() => applyPurgeRows(db, FULL, planned, { ...options(), content: backedUp })).toThrow(
            /changed since the backup/,
        );
        db.exec('ROLLBACK');
        expect(rows('pages')).toBe(2);
    });

    it('finishes a cleanup that failed part way when run again', async () => {
        seed();
        db.exec('BEGIN IMMEDIATE');
        const planned = planPurge(db, FULL, options());
        applyPurgeRows(db, FULL, planned, options());
        db.exec('COMMIT');
        const cleanup = {
            ...cleanupOf(planned, userDataDir, { computers: false }),
            objects: [{ key: 'tenants/main/x', bytes: 3 }],
        };
        const deleted: string[] = [];
        let down = true;
        const store = {
            delete: async (key: string) => {
                if (down) {
                    throw new Error('storage is down');
                }
                deleted.push(key);
            },
        };
        await expect(finishCleanup(cleanup, store)).rejects.toThrow(/storage is down/);
        expect(existsSync(join(userDataDir, 'tester', 'datasets', 'test-data.sqlite'))).toBe(false);
        down = false;
        expect(await finishCleanup(cleanup, store)).toEqual({
            files: 1,
            bytes: 0,
            objects: 1,
            containers: 0,
            volumes: 0,
        });
        expect(deleted).toEqual(['tenants/main/x']);
        expect(existsSync(join(userDataDir, 'tester'))).toBe(false);
    });

    it('has the supervisor remove each purged socio’s computer, and finishes on a retry', async () => {
        seed();
        db.exec('BEGIN IMMEDIATE');
        const planned = planPurge(db, FULL, options());
        applyPurgeRows(db, FULL, planned, options());
        db.exec('COMMIT');
        const cleanup = cleanupOf(planned, userDataDir);
        expect(cleanup.computers).toEqual(['test-socio']);
        await expect(finishCleanup(cleanup)).rejects.toThrow(/COMPUTER_SUPERVISOR_URL/);
        const destroy = vi
            .fn()
            .mockRejectedValueOnce(new Error('supervisor down'))
            .mockResolvedValue({ container: true, volumes: ['p', 'w', 'x'] });
        await expect(finishCleanup(cleanup, undefined, { destroy })).rejects.toThrow(/supervisor down/);
        expect(await finishCleanup(cleanup, undefined, { destroy })).toMatchObject({ containers: 1, volumes: 3 });
        expect(destroy).toHaveBeenLastCalledWith('test-socio');
        expect(cleanupOf(planned, userDataDir, { computers: false }).computers).toEqual([]);
    });

    it('reads the list and protect files strictly', () => {
        const list = join(dir, 'list.json');
        writeFileSync(list, JSON.stringify({ users: ['a'], cascade: ['conversations'], $comment: 'ok' }));
        expect(readPurgeList(list)).toEqual({ users: ['a'], cascade: ['conversations'] });
        writeFileSync(list, JSON.stringify({ people: ['a'] }));
        expect(() => readPurgeList(list)).toThrow(/Unknown key people/);
        writeFileSync(list, JSON.stringify({ cascade: ['schedules'] }));
        expect(() => readPurgeList(list)).toThrow(/cascade must be/);
        const protect = join(dir, 'protect.txt');
        writeFileSync(protect, '# keep\nalice\n\n  testing # the owner’s\n');
        expect(readProtectFile(protect)).toEqual(['alice', 'testing']);
    });
});
