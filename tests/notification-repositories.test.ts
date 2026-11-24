import { DatabaseSync } from 'node:sqlite';

import { getTableName } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { migrate } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';

import type { NotificationRecord } from '../src/server/notifications/domain/repositories.js';
import { sqliteNotificationRepositories } from '../src/server/notifications/infra/sqlite/index.js';
import { notificationTables } from '../src/server/notifications/infra/sqlite/schema.js';
import { notificationsSchema } from '../src/server/notifications/migrations.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

/*
 * The Notifications repository contract (CB-110): what any implementation
 * of `notifications/domain/repositories.ts` must keep, run against the
 * SQLite one, and the drift check of its Drizzle mirror.
 */

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);

function context() {
    const db = testDatabase();
    cleanup.push(() => db.close());
    const data = sqliteData(db);
    return { db, uow: data.uow, repos: sqliteNotificationRepositories(data) };
}

const record = (fields: Partial<NotificationRecord> = {}): NotificationRecord => ({
    userId: 'alice',
    dotId: 'dot-1',
    threadId: 't1',
    trigger: 'chat',
    causeId: null,
    title: '',
    message: 'Hello',
    link: '/chats/t1',
    imageToken: null,
    presence: 'away',
    ...fields,
});

const keys = (n: number) => ({
    endpoint: `https://fcm.googleapis.com/fcm/send/${n}`,
    p256dh: `p256dh-${n}`,
    auth: `auth-${n}`,
    device: `Device ${n}`,
});

it('mirrors the migrated Notifications tables exactly, and only those', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [notificationsSchema]);
    expect(schemaDrift(db, notificationTables)).toEqual([]);
    const created = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
        )
        .all()
        .map((row) => String(row.name));
    expect(created).toHaveLength(6);
    expect(notificationTables.map((table) => getTableName(table)).sort()).toEqual(created);
    // Every module's migrations together leave them as mirrored.
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    migrate(workspace.db, [notificationsSchema]);
    expect(schemaDrift(workspace.db, notificationTables)).toEqual([]);
});

it('reports a column the mirror does not know', () => {
    const { db } = context();
    db.exec('ALTER TABLE notification_in_app ADD COLUMN pinned INTEGER');
    expect(schemaDrift(db, notificationTables)).toEqual([expect.stringContaining('pinned')]);
});

it('keeps one subscription per endpoint, moved to whoever subscribed last', async () => {
    const { repos } = context();
    await repos.subscriptions.save('s1', 'alice', keys(1), 10);
    await repos.subscriptions.save('s2', 'alice', keys(2), 5);
    expect((await repos.subscriptions.forUser('alice')).map((row) => row.id)).toEqual(['s2', 's1']);
    await repos.subscriptions.failed('s1');
    await repos.subscriptions.failed('s1');
    expect((await repos.subscriptions.byId('s1'))?.failures).toBe(2);
    // The same browser again, for Bob: its id and creation stay, the
    // person, keys and device move, and its failures are cleared.
    await repos.subscriptions.save('ignored', 'bob', { ...keys(1), p256dh: 'new', device: 'Firefox on Linux' }, 99);
    expect(await repos.subscriptions.byEndpoint(keys(1).endpoint)).toEqual({
        id: 's1',
        userId: 'bob',
        ...keys(1),
        p256dh: 'new',
        device: 'Firefox on Linux',
        createdAt: 10,
        lastSentAt: null,
        failures: 0,
    });
    await repos.subscriptions.sent('s2', 50);
    expect(await repos.subscriptions.byId('s2')).toMatchObject({
        lastSentAt: 50,
        failures: 0,
    });
    // Only the person's own is removed by them.
    expect(await repos.subscriptions.removeOwn('alice', 's1')).toBe(false);
    expect(await repos.subscriptions.removeOwn('bob', 's1')).toBe(true);
    await repos.subscriptions.remove('s2');
    expect(await repos.subscriptions.forUser('alice')).toEqual([]);
    await repos.subscriptions.save('s3', 'alice', keys(3), 1);
    await repos.subscriptions.removeAll();
    expect(await repos.subscriptions.byId('s3')).toBeUndefined();
});

it('counts the last day’s notifications by socio and person, not the app’s own', async () => {
    const { repos } = context();
    await repos.notifications.insert('n1', record(), 100);
    await repos.notifications.insert('n2', record({ dotId: 'dot-2' }), 200);
    await repos.notifications.insert('n3', record({ dotId: null }), 300);
    await repos.notifications.insert('n4', record({ userId: 'bob' }), 300);
    await repos.notifications.insert('n5', record(), 50);
    expect(await repos.notifications.usage('dot-1', 'alice', 50)).toEqual({
        byDot: 1,
        byUser: 2,
    });
    expect(await repos.notifications.usage('dot-2', 'bob', 0)).toEqual({
        byDot: 0,
        byUser: 1,
    });
});

it('shows a person’s unseen notices of the window, oldest first, until seen', async () => {
    const { repos } = context();
    for (let i = 1; i <= 7; i++) {
        await repos.inApp.insert({
            id: `i${i}`,
            userId: 'alice',
            notificationId: `n${i}`,
            title: `Notice ${i}`,
            body: 'Body',
            link: '/',
            createdAt: i * 10,
        });
    }
    const ids = async () => (await repos.inApp.unseen('alice', 15, 5)).map((notice) => notice.id);
    expect(await ids()).toEqual(['i2', 'i3', 'i4', 'i5', 'i6']);
    expect(await repos.inApp.unseen('alice', 0, 5)).toContainEqual({
        id: 'i1',
        title: 'Notice 1',
        body: 'Body',
        link: '/',
        createdAt: 10,
    });
    // Someone else's ids change nothing; a second look keeps the first stamp.
    await repos.inApp.markSeen('bob', ['i2'], 100);
    await repos.inApp.markSeen('alice', ['i2', 'i3'], 100);
    await repos.inApp.markSeen('alice', [], 100);
    expect(await ids()).toEqual(['i4', 'i5', 'i6', 'i7']);
    await repos.inApp.removeBefore(65);
    expect(await ids()).toEqual(['i7']);
    expect(await repos.inApp.unseen('bob', 0, 5)).toEqual([]);
});

it('serves an image until it expires, then prunes it', async () => {
    const { repos } = context();
    const bytes = new Uint8Array([1, 2, 3]);
    await repos.images.insert({
        token: 'tok',
        userId: 'alice',
        mediaType: 'image/png',
        bytes,
        expiresAt: 100,
    });
    const live = await repos.images.live('tok', 99);
    expect(live?.mediaType).toBe('image/png');
    expect([...live!.bytes]).toEqual([1, 2, 3]);
    expect(await repos.images.live('tok', 100)).toBeUndefined();
    expect(await repos.images.live('other', 0)).toBeUndefined();
    await repos.images.removeExpired(99);
    expect(await repos.images.live('tok', 0)).toBeDefined();
    await repos.images.removeExpired(100);
    expect(await repos.images.live('tok', 0)).toBeUndefined();
});

it('prunes old notifications with their deliveries, and keeps settings', async () => {
    const { db, repos } = context();
    await repos.notifications.insert('old', record(), 10);
    await repos.notifications.insert('new', record(), 100);
    for (const notificationId of ['old', 'new']) {
        await repos.notifications.addDelivery({
            notificationId,
            channel: 'push',
            target: 's1',
            outcome: 'failed',
            error: 'Nope',
            at: 100,
        });
    }
    await repos.notifications.removeBefore(50);
    const left = (table: string) =>
        db
            .prepare(`SELECT ${table === 'notifications' ? 'id' : 'notificationId'} AS id FROM ${table}`)
            .all()
            .map((row) => row.id);
    expect(left('notifications')).toEqual(['new']);
    expect(left('notification_deliveries')).toEqual(['new']);
    expect(await repos.settings.get('vapid')).toBeUndefined();
    await repos.settings.set('vapid', 'one');
    await repos.settings.set('vapid', 'two');
    expect(await repos.settings.get('vapid')).toBe('two');
});

it('rolls back every repository write in a failed unit of work', async () => {
    const { db, uow, repos } = context();
    await expect(
        uow.run(
            async () => {
                await repos.images.insert({
                    token: 'tok',
                    userId: 'alice',
                    mediaType: 'image/png',
                    bytes: new Uint8Array([1]),
                    expiresAt: 100,
                });
                await repos.notifications.insert('n1', record({ imageToken: 'tok' }), 1);
                await repos.inApp.insert({
                    id: 'i1',
                    userId: 'alice',
                    notificationId: 'n1',
                    title: 'T',
                    body: 'B',
                    link: '/',
                    createdAt: 1,
                });
                throw new Error('Nope');
            },
            { label: 'notify' },
        ),
    ).rejects.toThrow('Nope');
    expect(await repos.images.live('tok', 0)).toBeUndefined();
    expect(await repos.notifications.usage('dot-1', 'alice', 0)).toEqual({
        byDot: 0,
        byUser: 0,
    });
    expect(await repos.inApp.unseen('alice', 0, 5)).toEqual([]);
    expect(db.isTransaction).toBe(false);
});
