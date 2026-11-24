import type { SqliteData } from '@socio/data/open';

import type { NotificationRepositories } from '../../domain/repositories.js';

import { SqliteNotificationImages } from './images.js';
import { SqliteInAppNotices } from './in-app.js';
import { SqliteNotifications } from './notifications.js';
import { SqliteNotificationSettings } from './settings.js';
import { SqlitePushSubscriptions } from './subscriptions.js';

/**
 * The Notifications repositories on a migrated connection (CB-110): the
 * only code that reads or writes its tables. The polled read (in-app
 * notices) is prepared once here.
 */
export function sqliteNotificationRepositories(data: SqliteData): NotificationRepositories {
    return {
        subscriptions: new SqlitePushSubscriptions(data),
        notifications: new SqliteNotifications(data),
        inApp: new SqliteInAppNotices(data),
        images: new SqliteNotificationImages(data),
        settings: new SqliteNotificationSettings(data),
    };
}
