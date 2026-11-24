import { and, count, eq, gt, inArray, isNotNull, lt } from 'drizzle-orm';

import type { NotificationDelivery, NotificationRecord, NotificationRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { notificationDeliveries, notifications } from './schema.js';

/** Each notification sent, what the daily limits count, and where it went. */
export class SqliteNotifications extends SqliteRepository implements NotificationRepository {
    insert(id: string, record: NotificationRecord, createdAt: number) {
        return this.write('record notification', async () => {
            await this.db.insert(notifications).values({ id, ...record, kind: 'message', createdAt });
        });
    }

    addDelivery(delivery: NotificationDelivery) {
        return this.write('record notification delivery', async () => {
            await this.db.insert(notificationDeliveries).values(delivery);
        });
    }

    async usage(dotId: string, userId: string, since: number) {
        const counted = async (...where: Parameters<typeof and>) =>
            (
                await this.db
                    .select({ n: count() })
                    .from(notifications)
                    .where(and(...where))
                    .get()
            )?.n ?? 0;
        return {
            byDot: await counted(
                eq(notifications.dotId, dotId),
                eq(notifications.userId, userId),
                gt(notifications.createdAt, since),
            ),
            byUser: await counted(
                isNotNull(notifications.dotId),
                eq(notifications.userId, userId),
                gt(notifications.createdAt, since),
            ),
        };
    }

    removeBefore(before: number) {
        return this.write('prune notifications', async () => {
            const old = this.db
                .select({ id: notifications.id })
                .from(notifications)
                .where(lt(notifications.createdAt, before));
            await this.db.delete(notificationDeliveries).where(inArray(notificationDeliveries.notificationId, old));
            await this.db.delete(notifications).where(lt(notifications.createdAt, before));
        });
    }
    removeDeliveriesBefore(before: number) {
        return this.write('prune notification deliveries', async () => {
            await this.db.delete(notificationDeliveries).where(lt(notificationDeliveries.at, before));
        });
    }
    removeRecordsBefore(before: number) {
        return this.write('prune notification records', async () => {
            await this.db.delete(notifications).where(lt(notifications.createdAt, before));
        });
    }
}
