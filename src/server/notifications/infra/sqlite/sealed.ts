/**
 * Where Notifications keeps a sealed value (CB-322): the Web Push key pair,
 * as a column `v`, for a recovery key check of a restored copy of the
 * database. The SQL stays inside Notifications' infra.
 */
export const NOTIFICATIONS_SEALED_SQL = ["SELECT value AS v FROM notification_settings WHERE key='vapid'"] as const;
