import { eq } from 'drizzle-orm';

import type { NotificationSettingRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { notificationSettings } from './schema.js';

/** Notifications' own settings: key and value. */
export class SqliteNotificationSettings extends SqliteRepository implements NotificationSettingRepository {
    async get(key: string) {
        return (
            await this.db
                .select({ value: notificationSettings.value })
                .from(notificationSettings)
                .where(eq(notificationSettings.key, key))
                .get()
        )?.value;
    }

    set(key: string, value: string) {
        return this.write('save notification setting', async () => {
            await this.db.insert(notificationSettings).values({ key, value }).onConflictDoUpdate({
                target: notificationSettings.key,
                set: { value },
            });
        });
    }
}
