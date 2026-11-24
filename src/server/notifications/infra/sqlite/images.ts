import { and, eq, gt, lte } from 'drizzle-orm';

import type { NotificationImageRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { notificationImages } from './schema.js';

/** Notifications' images, behind their random tokens until they expire. */
export class SqliteNotificationImages extends SqliteRepository implements NotificationImageRepository {
    insert(image: { token: string; userId: string; mediaType: string; bytes: Uint8Array; expiresAt: number }) {
        return this.write('keep notification image', async () => {
            await this.db.insert(notificationImages).values(image);
        });
    }

    async live(token: string, now: number) {
        return this.db
            .select({
                mediaType: notificationImages.mediaType,
                bytes: notificationImages.bytes,
            })
            .from(notificationImages)
            .where(and(eq(notificationImages.token, token), gt(notificationImages.expiresAt, now)))
            .get();
    }

    removeExpired(now: number) {
        return this.write('prune notification images', async () => {
            await this.db.delete(notificationImages).where(lte(notificationImages.expiresAt, now));
        });
    }
}
