import { sqliteTable } from 'drizzle-orm/sqlite-core';

import { bytes, enumText, id, int, ms, str } from '@socio/data/columns.sqlite';

/**
 * The Notifications tables (CB-110), as `notifications/migrations.ts`
 * makes them: the typed mirror the repositories query. The migrations stay
 * the source of truth; tests/notification-repositories.test.ts holds these
 * to them.
 */

export const pushSubscriptions = sqliteTable('notification_push_subscriptions', {
    id: id().primaryKey(),
    userId: str().notNull(),
    endpoint: str().notNull(),
    p256dh: str().notNull(),
    auth: str().notNull(),
    device: str().notNull(),
    createdAt: ms().notNull(),
    lastSentAt: ms(),
    failures: int().notNull(),
});

export const notifications = sqliteTable('notifications', {
    id: id().primaryKey(),
    userId: str().notNull(),
    dotId: str(),
    threadId: str(),
    trigger: str().notNull(),
    causeId: str(),
    kind: str().notNull(),
    title: str().notNull(),
    message: str().notNull(),
    link: str().notNull(),
    imageToken: str(),
    presence: enumText(['present', 'in_app', 'away']).notNull(),
    createdAt: ms().notNull(),
});

export const notificationDeliveries = sqliteTable('notification_deliveries', {
    notificationId: id().notNull(),
    channel: str().notNull(),
    target: str().notNull(),
    outcome: enumText(['sent', 'gone', 'failed']).notNull(),
    error: str(),
    at: ms().notNull(),
});

export const notificationInApp = sqliteTable('notification_in_app', {
    id: id().primaryKey(),
    userId: str().notNull(),
    notificationId: id().notNull(),
    title: str().notNull(),
    body: str().notNull(),
    link: str().notNull(),
    createdAt: ms().notNull(),
    seenAt: ms(),
});

export const notificationImages = sqliteTable('notification_images', {
    token: str().primaryKey(),
    userId: str().notNull(),
    mediaType: str().notNull(),
    bytes: bytes().notNull(),
    expiresAt: ms().notNull(),
});

export const notificationSettings = sqliteTable('notification_settings', {
    key: str().primaryKey(),
    value: str().notNull(),
});

/** Every table Notifications owns, for the drift test and the SQL check. */
export const notificationTables = [
    pushSubscriptions,
    notifications,
    notificationDeliveries,
    notificationInApp,
    notificationImages,
    notificationSettings,
] as const;
