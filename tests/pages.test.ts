import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, it } from 'vitest';

import { migrateDatabase } from '@socio/data/migrate';

import { schemas } from '../src/server/modules/index.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase, testDatabaseFile } from './helpers/test-database.js';

it('persists nested page content and revision across restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dots-pages-'));
    let store = new WorkspaceStore(testDatabaseFile(join(dir, 'db')));
    const space = store.spaces()[0].id;
    const parent = await store.pages.create(space, {
        title: 'Plan',
        content: 'A plan',
    });
    const child = await store.pages.create(space, {
        title: 'Detail',
        parentId: parent.id,
    });
    await store.pages.update(space, child.id, {
        expectedRevision: 1,
        title: 'New detail',
        content: 'Markdown **body**',
    });
    store.close();
    store = new WorkspaceStore(testDatabaseFile(join(dir, 'db')));
    expect(store.pages.get(space, child.id)).toMatchObject({
        title: 'New detail',
        content: 'Markdown **body**',
        revision: 2,
        parentId: parent.id,
    });
    store.close();
    rmSync(dir, { recursive: true });
});
it('rejects cross-space parents, cycles and stale writes without losing content', async () => {
    const store = new WorkspaceStore(testDatabase());
    const a = store.spaces()[0].id;
    const b = store.createSpace('Other', '').id;
    const root = await store.pages.create(a, { title: 'Root' });
    const child = await store.pages.create(a, {
        title: 'Child',
        parentId: root.id,
    });
    await expect(store.pages.create(b, { title: 'Wrong', parentId: root.id })).rejects.toThrow();
    await expect(store.pages.update(a, root.id, { expectedRevision: 1, parentId: child.id })).rejects.toThrow();
    await store.pages.update(a, root.id, { expectedRevision: 1, content: 'New' });
    await expect(store.pages.update(a, root.id, { expectedRevision: 1, content: 'Stale' })).rejects.toThrow(/changed/);
    expect(store.pages.get(a, root.id).content).toBe('New');
    expect(() => store.pages.get(b, root.id)).toThrow();
    store.close();
});
it('migrates review receipts and retains their original draft after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dots-reviews-'));
    const path = join(dir, 'db');
    const legacy = new DatabaseSync(path);
    legacy.exec(
        'CREATE TABLE page_reviews(threadId TEXT NOT NULL, toolCallId TEXT NOT NULL, pageId TEXT NOT NULL, spaceId TEXT NOT NULL, PRIMARY KEY(threadId,toolCallId))',
    );
    legacy.close();
    migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
    let store = new WorkspaceStore(path);
    const space = store.spaces()[0].id;
    await store.pages.createReviewed(space, { title: 'Original', content: 'Reviewed content' }, 'thread', 'call');
    const olderPage = await store.pages.create(space, {
        title: 'Earlier approval',
        content: 'Earlier draft',
    });
    store.close();
    const oldReceipt = new DatabaseSync(path);
    oldReceipt
        .prepare('INSERT INTO page_reviews (threadId,toolCallId,pageId,spaceId) VALUES (?,?,?,?)')
        .run('earlier-thread', 'earlier-call', olderPage.id, space);
    oldReceipt.close();
    store = new WorkspaceStore(path);
    expect(store.pages.reviewReceipt('thread', 'call')?.draft).toMatchObject({
        title: 'Original',
        content: 'Reviewed content',
        spaceId: space,
    });
    await expect(
        store.pages.createReviewed(space, { title: 'Changed', content: 'Reviewed content' }, 'thread', 'call'),
    ).rejects.toThrow('different draft');
    expect(store.pages.reviewReceipt('earlier-thread', 'earlier-call')?.draft).toBeNull();
    expect(
        (
            await store.pages.createReviewed(
                space,
                { title: 'Earlier approval', content: 'Earlier draft' },
                'earlier-thread',
                'earlier-call',
            )
        ).id,
    ).toBe(olderPage.id);
    store.close();
    rmSync(dir, { recursive: true });
});
