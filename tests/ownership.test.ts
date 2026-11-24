import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { transaction } from '@socio/data/open';
import { ASSET_KINDS, type TransferParties } from '@socio/shared/auth';

import { sqliteApprovals } from '../src/server/approvals/services.js';
import { appOwnership } from '../src/server/apps/infra/sqlite/ownership.js';
import { contextThreadOwnership } from '../src/server/ask/infra/sqlite/ownership.js';
import { assetTransfers, DEACTIVATED_SCHEDULE } from '../src/server/auth/accounts.js';
import { freePath } from '../src/server/dataspace/infra/sqlite/ownership.js';
import { DataSpace } from '../src/server/dataspace/space.js';
import { telegramThreadOwnership } from '../src/server/integrations/infra/sqlite/ownership.js';
import { evidenceOwnership } from '../src/server/learning/infra/sqlite/ownership.js';
import { mediaOwnership } from '../src/server/media/infra/sqlite/ownership.js';
import { memoryOwnership } from '../src/server/memory/infra/sqlite/ownership.js';
import { pageThreadOwnership } from '../src/server/pages/infra/sqlite/ownership.js';
import { OWNERSHIP } from '../src/server/purge/ownership.js';
import { REFERENCES } from '../src/server/purge/references.js';
import { reserveBackupDir } from '../src/server/purge/run.js';
import { scheduleOwnership } from '../src/server/schedules/infra/sqlite/ownership.js';
import { spaceMembershipOwnership } from '../src/server/spaces/infra/sqlite/ownership.js';
import { S3ObjectStore } from '../src/server/storage/s3-store.js';
import { conversationOwnership, socioOwnership } from '../src/server/workspace/infra/ownership.js';

import { startFakeS3 } from './fixtures/fake-s3.js';
import { dataSpaceStorage } from './helpers/data-space-storage.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const personColumns = REFERENCES.filter((ref) => ref.ids === 'users' || ref.ids === 'owners');
const key = (ref: { table: string; column: string }) => `${ref.table}.${ref.column}`;

describe('what a transfer does with each column that names a person (CB-360)', () => {
    it('has a decision for every one: purge history is history; anything else is listed', () => {
        const missing = personColumns.filter((ref) => ref.how !== 'history' && !OWNERSHIP[key(ref)]).map(key);
        // A new table that names a person: decide in src/server/purge/ownership.ts
        // whether a transfer moves it, leaves it the person's, or keeps it as history.
        expect(missing).toEqual([]);
    });
    it('lists only columns references.ts has', () => {
        const known = new Set(personColumns.map(key));
        expect(Object.keys(OWNERSHIP).filter((column) => !known.has(column))).toEqual([]);
    });
    it('moves something of every kind, and gives a reason for what stays', () => {
        const kinds = new Set(
            Object.values(OWNERSHIP).flatMap((entry) => (entry.as === 'transferred' ? [entry.kind] : [])),
        );
        expect([...kinds].sort()).toEqual([...ASSET_KINDS].sort());
        for (const [column, entry] of Object.entries(OWNERSHIP)) {
            if (entry.as === 'personal') {
                expect(entry.why, column).toBeTruthy();
            }
        }
    });
});

it('gives each purge a backup folder of its own, even in the same second', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-purge-dirs-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const now = new Date(T);
    const first = reserveBackupDir(dir, now);
    const second = reserveBackupDir(dir, now);
    expect(first).not.toBe(second);
    expect(second).toBe(`${first}-2`);
    expect(readdirSync(dir).sort()).toEqual([basename(first), basename(second)].sort());
});

it('frees a path beside a taken one', () => {
    const taken = new Set(['a/report.md', 'a/report 2.md', 'notes']);
    expect(freePath('a/report.md', (path) => taken.has(path))).toBe('a/report 3.md');
    expect(freePath('notes', (path) => taken.has(path))).toBe('notes 2');
    expect(freePath('x.md', () => false)).toBe('x.md');
});

const SECRET = 'secret-0123456789abcdef-xyz';
const T = 1_790_000_000_000;
const ALICE: TransferParties = { from: 'alice', to: 'bob', fromName: 'Alice', toName: 'Bob' };

async function fixture(options: { s3?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-ownership-'));
    const workspace = new WorkspaceStore(testDatabase());
    for (const [id, name, role] of [
        ['alice', 'Alice', 'member'],
        ['bob', 'Bob', 'member'],
    ] as const) {
        workspace.recordUser({ id, name, role });
    }
    let objects: S3ObjectStore | undefined;
    let s3: Awaited<ReturnType<typeof startFakeS3>> | undefined;
    if (options.s3) {
        s3 = await startFakeS3();
        objects = new S3ObjectStore(s3.settings(), { backoffMs: 1 });
        cleanup.push(() => s3!.close());
    }
    const data = new DataSpace(workspace.db, {
        dir,
        ...dataSpaceStorage(dir),
        secret: SECRET,
        approvals: sqliteApprovals(workspace.db),
        workspace,
        ...(objects ? { objects, tenantId: 'acme' } : {}),
    });
    cleanup.push(() => {
        data.close();
        workspace.close();
        rmSync(dir, { recursive: true, force: true });
    });
    if (objects) {
        expect(await data.probeStorage()).toBe(true);
    }
    const db = workspace.db;
    const memories = memoryOwnership(db);
    /** The apps service's restart after the commit: who it was called for, and the owner it saw. */
    const handedOver: Array<{ appIds: readonly string[]; owner: unknown }> = [];
    const spaces = spaceMembershipOwnership(db);
    const transfers = assetTransfers({
        apps: appOwnership(db),
        schedules: scheduleOwnership(db),
        socios: socioOwnership(db),
        spaces,
        data,
        media: mediaOwnership(db),
        conversations: conversationOwnership(db),
        memories,
        threadFollowers: [
            contextThreadOwnership(db),
            pageThreadOwnership(db),
            evidenceOwnership(db),
            telegramThreadOwnership(db),
        ],
        workspace,
        appsHandedOver: async (appIds) => {
            handedOver.push({
                appIds,
                owner: (
                    db.prepare('SELECT ownerUserId FROM apps WHERE id=?').get(appIds[0]!) as { ownerUserId: string }
                ).ownerUserId,
            });
            return appIds.map((id) => `restarted ${id}`);
        },
        transaction: (work) => transaction(db, 'account transfer', work),
    });
    const dot = workspace.dots()[0];
    return { dir, workspace, db, data, transfers, spaces, dot, s3, handedOver };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A row in every table a transfer moves, for Alice; some the same for Bob, to clash. */
async function seed(f: Fixture) {
    const { db, data, dot } = f;
    const run = (sql: string, ...params: (string | number | null)[]) => db.prepare(sql).run(...params);
    // A personal socio, and Bob's of the same name.
    for (const [id, owner] of [
        ['helper-a', 'alice'],
        ['helper-b', 'bob'],
    ]) {
        run(
            "INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt, ownerId) VALUES (?, ?, 'Helper', '', 0, 0, ?, ?)",
            id,
            dot.spaceId,
            T,
            owner,
        );
    }
    run(
        "INSERT INTO apps (id, slug, name, dotId, ownerUserId, port, createdAt, updatedAt) VALUES ('app-1', 'tracker', 'Tracker', ?, 'alice', 3001, ?, ?)",
        dot.id,
        T,
        T,
    );
    // Schedules: a paused task (a deactivation's), a job Bob has a namesake of, a goal.
    run(
        "INSERT INTO tasks (id, prompt, status, createdAt, updatedAt, userId, dotId, error) VALUES ('task-1', 'Weekly report', 'paused', ?, ?, 'alice', ?, ?)",
        T,
        T,
        dot.id,
        DEACTIVATED_SCHEDULE,
    );
    run("INSERT INTO task_threads (taskId, threadId) VALUES ('task-1', 'thread-task')");
    for (const [id, owner] of [
        ['job-a', 'alice'],
        ['job-b', 'bob'],
    ]) {
        run(
            "INSERT INTO jobs (id, userId, dotId, name, version, createdAt, updatedAt) VALUES (?, ?, ?, 'sync', 1, ?, ?)",
            id,
            owner,
            dot.id,
            T,
            T,
        );
    }
    run(
        "INSERT INTO goals (id, userId, dotId, title, scheduleId, status, createdAt, updatedAt) VALUES ('goal-1', 'alice', ?, 'Ship it', 'task-1', 'active', ?, ?)",
        dot.id,
        T,
        T,
    );
    // Spaces: an editor where Bob is a member (the higher role stays), and one of her own.
    run(
        "INSERT INTO spaces (id, name, description, createdAt) VALUES ('space-shared', 'Shared', '', ?), ('space-own', 'Own', '', ?)",
        T,
        T,
    );
    run(
        `INSERT INTO space_members (spaceId, userId, role, addedAt, updatedAt) VALUES
           ('space-shared', 'alice', 'editor', ${T}, ${T}), ('space-shared', 'bob', 'member', ${T}, ${T}),
           ('space-own', 'alice', 'editor', ${T}, ${T})`,
    );
    // Conversations: one of her own, the task's, and their followers.
    for (const id of ['thread-own', 'thread-task']) {
        run(
            "INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt) VALUES (?, ?, 'alice', ?, ?)",
            id,
            dot.id,
            id,
            T,
        );
    }
    run(
        "INSERT INTO context_threads (contextKind, contextId, dotId, userId, threadId, createdAt) VALUES ('issue', 'CB-1', ?, 'alice', 'thread-own', ?)",
        dot.id,
        T,
    );
    run(
        "INSERT INTO page_threads (pageId, dotId, userId, threadId) VALUES ('page-1', ?, 'alice', 'thread-own')",
        dot.id,
    );
    run(
        "INSERT INTO learning_evidence (threadId, containerId, dotId, ownerId, eligible, finishedAt) VALUES ('thread-own', 'c', ?, 'alice', 1, ?)",
        dot.id,
        T,
    );
    run(
        "INSERT INTO memory_episodes (id, userId, threadId, kind, key, text, occurredAt, createdAt) VALUES ('ep-1', 'alice', 'thread-own', 'summary', 'k', 'Talked.', ?, ?)",
        T,
        T,
    );
    run(
        "INSERT INTO telegram_threads (key, threadId, kind, chatId, createdAt) VALUES ('dm:1', 'thread-own', 'dm', '1', ?)",
        T,
    );
    run("INSERT INTO memories (id, text, createdAt, userId) VALUES ('mem-1', 'The client is Acme.', ?, 'alice')", T);
    // The data space: a file at a path Bob uses, an overwritten one (a kept
    // version), a dataset with rows, a scratch area for a socio Bob has one
    // for, grants and media.
    const alice = { kind: 'user' as const, userId: 'alice' };
    const bob = { kind: 'user' as const, userId: 'bob' };
    await data.putFile(alice, 'notes/plan.md', Buffer.from('alice plan'), 'text/markdown');
    await data.putFile(bob, 'notes/plan.md', Buffer.from('bob plan'), 'text/markdown');
    await data.putFile(alice, 'apps/app-1/bundles/v1.cbapp', Buffer.from('bundle v1'));
    await data.putFile(alice, 'apps/app-1/bundles/v1.cbapp', Buffer.from('bundle v1, again'));
    const dataset = data.createDataset('alice', { name: 'Leads' });
    const file = new DatabaseSync(data.datasetPath({ id: dataset.id, ownerUserId: 'alice' }));
    file.exec(
        "CREATE TABLE leads(name TEXT); INSERT INTO leads VALUES ('Acme'); CREATE INDEX leads_by_name ON leads(name)",
    );
    file.close();
    data.scratch('alice', dot.id);
    data.scratch('bob', dot.id);
    run(
        "INSERT INTO data_grants (id, ownerUserId, dotId, datasetId, access, createdBy, createdAt) VALUES ('grant-a', 'alice', ?, ?, 'write', 'alice', ?)",
        dot.id,
        dataset.id,
        T,
    );
    run(
        "INSERT INTO data_grants (id, ownerUserId, dotId, folder, access, createdBy, createdAt) VALUES ('grant-f', 'alice', ?, 'notes/', 'read', 'alice', ?)",
        dot.id,
        T,
    );
    const fileId = (
        db.prepare("SELECT id FROM data_files WHERE ownerUserId='alice' AND path='notes/plan.md'").get() as {
            id: string;
        }
    ).id;
    run(
        "INSERT INTO media_attachments (id, fileId, ownerUserId, name, mediaType, kind, size, source, createdAt) VALUES ('att-1', ?, 'alice', 'plan.md', 'text/markdown', 'text', 10, 'web', ?)",
        fileId,
        T,
    );
    run(
        "INSERT INTO media_folders (ownerUserId, path, createdAt) VALUES ('alice', 'notes', ?), ('bob', 'notes', ?)",
        T,
        T,
    );
    run(
        "INSERT INTO media_embeds (id, fileId, ownerUserId, spaceId, sourceUrl, createdAt) VALUES ('emb-1', ?, 'alice', 'space-own', 'https://example.invalid/a', ?)",
        fileId,
        T,
    );
    return { dataset, fileId };
}

/** Rows that still name `userId`, by `table.column`, for every column a transfer moves. */
function leftWith(db: DatabaseSync, userId: string) {
    const left: Record<string, number> = {};
    for (const [column, entry] of Object.entries(OWNERSHIP)) {
        if (entry.as !== 'transferred') {
            continue;
        }
        const [table, name] = column.split('.');
        const n = Number(
            (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE "${name}"=?`).get(userId) as { n: number }).n,
        );
        if (n) {
            left[column] = n;
        }
    }
    return left;
}

describe('transfer of ownership (CB-360)', () => {
    it('moves every kind in one go, renaming and merging where the new owner has one already', async () => {
        const f = await fixture();
        const { dataset } = await seed(f);
        // Every column a transfer moves has a row here, so none is left out of it.
        expect(Object.keys(leftWith(f.db, 'alice')).sort()).toEqual(
            Object.entries(OWNERSHIP)
                .filter(([, entry]) => entry.as === 'transferred')
                .map(([column]) => column)
                .sort(),
        );
        const before = Object.fromEntries(f.transfers.assets('alice').map((kind) => [kind.kind, kind.count]));
        expect(before).toEqual({
            apps: 1,
            schedules: 3,
            socios: 1,
            spaces: 2,
            data: 5,
            conversations: 2,
            memories: 1,
        });

        const result = await f.transfers.transfer(ALICE, [], 'admin-1');
        expect(leftWith(f.db, 'alice')).toEqual({});
        // Its app restarts after the commit, as Bob's, and says so under Apps.
        expect(f.handedOver).toEqual([{ appIds: ['app-1'], owner: 'bob' }]);
        expect(result.find((entry) => entry.kind === 'apps')!.notes).toEqual(['restarted app-1']);
        const moved = Object.fromEntries(result.map((entry) => [entry.kind, entry.moved]));
        expect(moved.schedules).toEqual({ tasks: 1, jobs: 1, goals: 1, jobsRenamed: 1 });
        expect(moved.spaces).toEqual({ memberships: 1, membershipsMerged: 1 });
        expect(moved.data).toMatchObject({ datasets: 2, files: 3, filesRenamed: 1, scratchAreasRenamed: 1 });
        expect(moved.conversations).toMatchObject({
            conversations: 2,
            contextLinks: 1,
            pageChats: 1,
            learningEvidence: 1,
            episodes: 1,
            telegramChatsUnbound: 1,
        });

        const bob = { kind: 'user' as const, userId: 'bob' };
        // Bob's file stays; Alice's is beside it.
        expect((await f.data.getFile(bob, 'notes/plan.md')).data.toString()).toBe('bob plan');
        expect((await f.data.getFile(bob, 'notes/plan 2.md')).data.toString()).toBe('alice plan');
        expect((await f.data.getFile(bob, 'apps/app-1/bundles/v1.cbapp')).data.toString()).toBe('bundle v1, again');
        // The overwritten version's bytes moved too.
        const versions = f.db
            .prepare("SELECT id FROM data_files WHERE ownerUserId='bob' AND deletedAt IS NOT NULL")
            .all() as { id: string }[];
        expect(versions).toHaveLength(1);
        expect((await f.data.withDeletedContent(versions[0].id)).toString()).toBe('bundle v1');
        // The dataset's rows, at its new owner's path; nothing left under Alice.
        const moved1 = new DatabaseSync(f.data.datasetPath({ id: dataset.id, ownerUserId: 'bob' }), { readOnly: true });
        expect(moved1.prepare('SELECT name FROM leads').all()).toEqual([{ name: 'Acme' }]);
        // Its declared indexes go with it (CB-355).
        expect(moved1.prepare("SELECT name FROM sqlite_master WHERE type='index'").all()).toEqual([
            { name: 'leads_by_name' },
        ]);
        moved1.close();
        expect(existsSync(f.data.datasetPath({ id: dataset.id, ownerUserId: 'alice' }))).toBe(false);
        const aliceFiles = join(f.dir, 'alice', 'files');
        expect(existsSync(aliceFiles) ? readdirSync(aliceFiles) : []).toEqual([]);

        const row = (sql: string) => f.db.prepare(sql).get() as Record<string, unknown>;
        expect(row("SELECT name, ownerId FROM dots WHERE id='helper-a'")).toEqual({ name: 'Helper 2', ownerId: 'bob' });
        expect(row("SELECT name FROM jobs WHERE id='job-a'")).toEqual({ name: 'sync 2' });
        expect(row("SELECT status, error FROM tasks WHERE id='task-1'")).toEqual({
            status: 'paused',
            error: 'Paused: it moved from Alice, whose account is deactivated. Resume it to run it.',
        });
        expect(row("SELECT role FROM space_members WHERE spaceId='space-shared' AND userId='bob'")).toEqual({
            role: 'editor',
        });
        expect(row("SELECT status, userId FROM memories WHERE id='mem-1'")).toEqual({
            status: 'proposed',
            userId: 'bob',
        });
        expect(row("SELECT access FROM data_grants WHERE id='grant-a'")).toEqual({ access: 'write' });
        expect(row('SELECT COUNT(*) AS n FROM telegram_threads')).toEqual({ n: 0 });
        expect(row("SELECT COUNT(*) AS n FROM media_folders WHERE ownerUserId='bob'")).toEqual({ n: 1 });
        // Audited for both, with counts per kind.
        const audit = f.workspace.auditOf('user', 'alice');
        expect(audit).toEqual([
            expect.objectContaining({
                actor: 'admin-1',
                action: 'transfer',
                detail: expect.stringContaining('gave to Bob'),
            }),
        ]);
        expect(audit[0].detail).toContain('schedules: tasks 1, jobs 1, goals 1, jobsRenamed 1');
        expect(f.workspace.auditOf('user', 'bob')).toEqual([
            expect.objectContaining({ action: 'transfer', detail: expect.stringContaining('received from Alice') }),
        ]);
        expect(f.transfers.assets('alice').every((kind) => kind.count === 0)).toBe(true);
    });

    it('moves only the chosen kinds; apps bring the data space, schedules their conversations', async () => {
        const f = await fixture();
        await seed(f);
        const result = await f.transfers.transfer(ALICE, ['apps', 'schedules'], 'admin-1');
        expect(result.map((entry) => entry.kind)).toEqual(['apps', 'schedules', 'data']);
        const left = Object.fromEntries(f.transfers.assets('alice').map((kind) => [kind.kind, kind.count]));
        expect(left).toEqual({ apps: 0, schedules: 0, socios: 1, spaces: 2, data: 0, conversations: 1, memories: 1 });
        expect(f.db.prepare("SELECT ownerId FROM thread_bindings WHERE id='thread-task'").get()).toEqual({
            ownerId: 'bob',
        });
    });

    it('leaves everything as it was when the transaction fails, and moves it all on the next try, over S3', async () => {
        const f = await fixture({ s3: true });
        const { dataset } = await seed(f);
        const keys = () => [...f.s3!.objects.keys()].sort();
        const before = keys();
        expect(before.every((k) => k.includes('/users/alice/') || k.includes('/users/bob/'))).toBe(true);
        // A clash the rows can't take: the commit throws after the files were copied and linked.
        f.db.exec(
            "CREATE TEMP TRIGGER refuse BEFORE UPDATE OF ownerUserId ON media_embeds BEGIN SELECT RAISE(ABORT, 'no'); END",
        );
        await expect(f.transfers.transfer(ALICE, ['data'], 'admin-1')).rejects.toThrow('no');
        expect(keys()).toEqual(before);
        expect(f.transfers.assets('alice').find((kind) => kind.kind === 'data')!.count).toBe(5);
        expect(existsSync(f.data.datasetPath({ id: dataset.id, ownerUserId: 'bob' }))).toBe(false);
        expect((await f.data.getFile({ kind: 'user', userId: 'alice' }, 'notes/plan.md')).data.toString()).toBe(
            'alice plan',
        );
        expect(f.workspace.auditOf('user', 'alice')).toEqual([]);

        f.db.exec('DROP TRIGGER temp.refuse');
        await f.transfers.transfer(ALICE, ['data'], 'admin-1');
        expect(keys().filter((k) => k.includes('/users/alice/'))).toEqual([]);
        expect((await f.data.getFile({ kind: 'user', userId: 'bob' }, 'notes/plan 2.md')).data.toString()).toBe(
            'alice plan',
        );
    });

    it('stops when a file changed after its bytes were copied', async () => {
        const f = await fixture();
        await seed(f);
        const handle = await f.data.prepareTransfer(ALICE);
        // A re-seal recorded under another key meanwhile (it takes the same lock; this one is forced).
        f.db.prepare("UPDATE data_files SET sealKey='other' WHERE ownerUserId='alice' AND path='notes/plan.md'").run();
        expect(() => transactionSyncCommit(f, handle)).toThrow('changed while they were copied');
        await handle.abort();
        expect(existsSync(join(f.dir, 'bob', 'files'))).toBe(true);
        expect(
            (f.db.prepare("SELECT COUNT(*) AS n FROM data_files WHERE ownerUserId='alice'").get() as { n: number }).n,
        ).toBe(3);
    });

    it('renames a job clear of both people’s names', async () => {
        const f = await fixture();
        const add = (id: string, userId: string, name: string) =>
            f.db
                .prepare(
                    'INSERT INTO jobs (id, userId, dotId, name, version, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, ?, ?)',
                )
                .run(id, userId, f.dot.id, name, T, T);
        add('a1', 'alice', 'sync');
        add('a2', 'alice', 'sync 2');
        add('b1', 'bob', 'sync');
        const [schedules] = await f.transfers.transfer(ALICE, ['schedules'], 'admin-1');
        expect(schedules.moved).toMatchObject({ jobs: 2, jobsRenamed: 1 });
        // No apps moved: none restarts.
        expect(f.handedOver).toEqual([]);
        expect(f.db.prepare("SELECT id, name FROM jobs WHERE userId='bob' ORDER BY id").all()).toEqual([
            { id: 'a1', name: 'sync 3' },
            { id: 'a2', name: 'sync 2' },
            { id: 'b1', name: 'sync' },
        ]);
    });

    it('counts a Space whose only editor someone is', async () => {
        const f = await fixture();
        await seed(f);
        expect(f.spaces.soleEditorOf('alice')).toBe(2);
        expect(f.spaces.soleEditorOf('bob')).toBe(0);
    });
});

function transactionSyncCommit(f: Fixture, handle: Awaited<ReturnType<DataSpace['prepareTransfer']>>) {
    f.db.exec('BEGIN');
    try {
        handle.commit();
        f.db.exec('COMMIT');
    } catch (error) {
        f.db.exec('ROLLBACK');
        throw error;
    }
}
