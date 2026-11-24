import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * Notifications (CB-114):
 * - `notification_push_subscriptions`: each browser a person turned push on
 *   in. `device` is a short label from its browser ("Edge on Windows").
 * - `notifications`: each one a Dot sent (or a person's test, without a
 *   Dot), what its limits count and its audit; `presence` is what the
 *   server judged: the person was looking at the chat, elsewhere in the
 *   brain, or away.
 * - `notification_deliveries`: per channel and target, how it went.
 * - `notification_in_app`: shown as a toast while the person is in the app.
 * - `notification_images`: an image's bytes behind a random token, for
 *   7 days.
 * - `notification_settings`: the sealed Web Push key pair.
 */
export const notificationsSchema: SchemaSet = {
    id: MODULE_IDS.notifications,
    migrations: [
        {
            version: 1,
            name: 'notifications',
            up: `CREATE TABLE notification_push_subscriptions(id TEXT PRIMARY KEY, userId TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, device TEXT NOT NULL, createdAt INTEGER NOT NULL, lastSentAt INTEGER, failures INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX notification_push_subscriptions_user ON notification_push_subscriptions(userId);
      CREATE TABLE notifications(id TEXT PRIMARY KEY, userId TEXT NOT NULL, dotId TEXT, threadId TEXT, trigger TEXT NOT NULL, causeId TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, link TEXT NOT NULL, imageToken TEXT, presence TEXT NOT NULL CHECK(presence IN ('present','in_app','away')), createdAt INTEGER NOT NULL);
      CREATE INDEX notifications_dot ON notifications(dotId, userId, createdAt);
      CREATE INDEX notifications_user ON notifications(userId, createdAt);
      CREATE TABLE notification_deliveries(notificationId TEXT NOT NULL, channel TEXT NOT NULL, target TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('sent','gone','failed')), error TEXT, at INTEGER NOT NULL);
      CREATE INDEX notification_deliveries_notification ON notification_deliveries(notificationId);
      CREATE TABLE notification_in_app(id TEXT PRIMARY KEY, userId TEXT NOT NULL, notificationId TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, link TEXT NOT NULL, createdAt INTEGER NOT NULL, seenAt INTEGER);
      CREATE INDEX notification_in_app_unseen ON notification_in_app(userId, createdAt) WHERE seenAt IS NULL;
      CREATE TABLE notification_images(token TEXT PRIMARY KEY, userId TEXT NOT NULL, mediaType TEXT NOT NULL, bytes BLOB NOT NULL, expiresAt INTEGER NOT NULL);
      CREATE INDEX notification_images_expiry ON notification_images(expiresAt);
      CREATE TABLE notification_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
        },
        {
            version: 2,
            name: 'notification retention indexes',
            up: `CREATE INDEX notification_deliveries_time ON notification_deliveries(at);
        CREATE INDEX notifications_time ON notifications(createdAt);
        CREATE INDEX notification_in_app_time ON notification_in_app(createdAt);`,
        },
    ],
};
