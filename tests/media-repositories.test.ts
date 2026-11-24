import { DatabaseSync } from 'node:sqlite';

import { getTableName } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { migrate } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';

import type { Attachment } from '../src/server/media/contract.js';
import { sqliteMediaRepositories } from '../src/server/media/infra/sqlite/index.js';
import { mediaTables } from '../src/server/media/infra/sqlite/schema.js';
import { mediaSchema } from '../src/server/media/migrations.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

/*
 * The Media repository contract (CB-110): what any implementation of
 * `media/domain/repositories.ts` must keep, run against the SQLite one,
 * and the drift check of its Drizzle mirror.
 */

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);

function context() {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [mediaSchema]);
    const data = sqliteData(db);
    return { db, uow: data.uow, repos: sqliteMediaRepositories(data) };
}

const attachment = (fields: Partial<Attachment> = {}): Attachment => ({
    id: 'a1',
    fileId: 'f1',
    ownerUserId: 'alice',
    threadId: null,
    dotId: null,
    messageId: null,
    name: 'photo.png',
    mediaType: 'image/png',
    kind: 'image',
    size: 4,
    source: 'web',
    createdAt: 10,
    boundAt: null,
    ...fields,
});

const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);

it('mirrors the migrated Media tables exactly, and only those', () => {
    const { db } = context();
    expect(schemaDrift(db, mediaTables)).toEqual([]);
    const created = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
        )
        .all()
        .map((row) => String(row.name));
    expect(created).toHaveLength(3);
    expect(mediaTables.map((table) => getTableName(table)).sort()).toEqual(created);
    // Every module's migrations together leave them as mirrored.
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    expect(schemaDrift(workspace.db, mediaTables)).toEqual([]);
});

it('reports a column the mirror does not know', () => {
    const { db } = context();
    db.exec('ALTER TABLE media_attachments ADD COLUMN width INTEGER');
    expect(schemaDrift(db, mediaTables)).toEqual([expect.stringContaining('width')]);
});

it('reads live attachments, and deleted ones only when asked', async () => {
    const { repos } = context();
    await repos.attachments.insert(attachment());
    expect(await repos.attachments.byId('a1')).toEqual({
        ...attachment(),
        deletedAt: null,
        deletedBy: null,
        deletedWith: null,
    });
    expect(await repos.attachments.removePending('a1', 'alice', 20)).toBe(true);
    expect(await repos.attachments.byId('a1')).toBeUndefined();
    expect(await repos.attachments.withDeleted('a1')).toMatchObject({
        deletedAt: 20,
        deletedBy: 'alice',
        deletedWith: null,
    });
    // Gone already: nothing to remove.
    expect(await repos.attachments.removePending('a1', 'alice', 30)).toBe(false);
    expect(await repos.attachments.byId('missing')).toBeUndefined();
});

it('binds a pending attachment once, to its own thread only', async () => {
    const { repos } = context();
    await repos.attachments.insert(attachment());
    await repos.attachments.insert(attachment({ id: 'a2', threadId: 't2' }));
    const binding = { threadId: 't1', dotId: 'dot-1', messageId: 'm1' };
    expect(await repos.attachments.bind('a1', binding, 50)).toBe(true);
    expect(await repos.attachments.byId('a1')).toMatchObject({
        ...binding,
        boundAt: 50,
    });
    // Bound already, or waiting in another thread: unchanged.
    expect(await repos.attachments.bind('a1', { ...binding, messageId: 'm2' }, 60)).toBe(false);
    expect(await repos.attachments.bind('a2', binding, 60)).toBe(false);
    expect((await repos.attachments.byId('a2'))?.boundAt).toBeNull();
    // A sent one is no longer pending: it can't be removed as one.
    expect(await repos.attachments.removePending('a1', 'alice', 70)).toBe(false);
});

it('lists a thread’s carried attachments, oldest bound first', async () => {
    const { repos } = context();
    await repos.attachments.insert(attachment({ id: 'late', threadId: 't1', boundAt: 30, createdAt: 1 }));
    await repos.attachments.insert(attachment({ id: 'early', threadId: 't1', boundAt: 20, createdAt: 5 }));
    await repos.attachments.insert(attachment({ id: 'tie', threadId: 't1', boundAt: 20, createdAt: 6 }));
    await repos.attachments.insert(attachment({ id: 'pending', threadId: 't1' }));
    await repos.attachments.insert(attachment({ id: 'other', threadId: 't2', boundAt: 1 }));
    expect(ids(await repos.attachments.forThread('t1'))).toEqual(['early', 'tie', 'late']);
    expect(await repos.attachments.carried('alice', 't1', 'f1')).toBe(true);
    expect(await repos.attachments.carried('bob', 't1', 'f1')).toBe(false);
    expect(await repos.attachments.carried('alice', 't3', 'f1')).toBe(false);
    // A file's deletion takes its live attachments, stamped with it.
    await repos.attachments.removeWithFile('alice', 'f1', {
        at: 90,
        by: 'alice',
        with: 'file:f1',
    });
    expect(await repos.attachments.forThread('t1')).toEqual([]);
    expect(await repos.attachments.carried('alice', 't1', 'f1')).toBe(false);
    expect(await repos.attachments.withDeleted('late')).toMatchObject({
        deletedAt: 90,
        deletedWith: 'file:f1',
    });
});

it('finds a file’s attachments and kinds, and web uploads never sent', async () => {
    const { repos } = context();
    await repos.attachments.insert(attachment({ id: 'new', createdAt: 30 }));
    await repos.attachments.insert(attachment({ id: 'old', createdAt: 10, kind: 'file' }));
    await repos.attachments.insert(attachment({ id: 'tg', fileId: 'f2', source: 'telegram', createdAt: 5 }));
    await repos.attachments.insert(attachment({ id: 'bobs', ownerUserId: 'bob', createdAt: 1 }));
    expect(ids(await repos.attachments.forFile('alice', 'f1'))).toEqual(['old', 'new']);
    expect(await repos.attachments.kinds('alice')).toEqual([
        { fileId: 'f1', kind: 'image' },
        { fileId: 'f1', kind: 'file' },
        { fileId: 'f2', kind: 'image' },
    ]);
    // Telegram's are bound at once in practice; only web ones are collected.
    expect(ids(await repos.attachments.pendingBefore(30))).toEqual(['bobs', 'old']);
});

it('keeps a person’s empty folders, moves and removes them by prefix', async () => {
    const { repos } = context();
    for (const path of ['b/', 'a/x/', 'a/', 'ab/', 'final/x/']) {
        await repos.folders.add('alice', path, 1);
    }
    await repos.folders.add('bob', 'a/', 1);
    expect(await repos.folders.paths('alice')).toEqual(['a/', 'a/x/', 'ab/', 'b/', 'final/x/']);
    // One already at the target stays as it was.
    await repos.folders.move('alice', 'a/', 'final/', 2);
    expect(await repos.folders.paths('alice')).toEqual(['ab/', 'b/', 'final/', 'final/x/']);
    expect(await repos.folders.paths('bob')).toEqual(['a/']);
    await repos.folders.removeUnder('alice', 'final/');
    expect(await repos.folders.paths('alice')).toEqual(['ab/', 'b/']);
    await expect(repos.folders.add('alice', 'b/', 3)).rejects.toThrow();
});

it('rolls back every repository write in a failed unit of work', async () => {
    const { db, uow, repos } = context();
    await expect(
        uow.run(
            async () => {
                await repos.attachments.insert(attachment());
                await repos.folders.add('alice', 'a/', 1);
                throw new Error('Nope');
            },
            { label: 'upload' },
        ),
    ).rejects.toThrow('Nope');
    expect(await repos.attachments.withDeleted('a1')).toBeUndefined();
    expect(await repos.folders.paths('alice')).toEqual([]);
    expect(db.isTransaction).toBe(false);
});
