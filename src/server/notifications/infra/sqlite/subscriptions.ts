import { and, asc, eq, sql } from 'drizzle-orm';

import type { PushSubscriptionInput, PushSubscriptionRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { pushSubscriptions } from './schema.js';

/** Push subscriptions (CB-114): one row per browser endpoint. */
export class SqlitePushSubscriptions extends SqliteRepository implements PushSubscriptionRepository {
    async forUser(userId: string) {
        return this.db
            .select()
            .from(pushSubscriptions)
            .where(eq(pushSubscriptions.userId, userId))
            .orderBy(asc(pushSubscriptions.createdAt))
            .all();
    }

    async byId(id: string) {
        return this.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, id)).get();
    }

    async byEndpoint(endpoint: string) {
        return this.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).get();
    }

    save(id: string, userId: string, input: PushSubscriptionInput, createdAt: number) {
        return this.write('save push subscription', async () => {
            await this.db
                .insert(pushSubscriptions)
                .values({ id, userId, ...input, createdAt, failures: 0 })
                .onConflictDoUpdate({
                    target: pushSubscriptions.endpoint,
                    set: {
                        userId,
                        p256dh: input.p256dh,
                        auth: input.auth,
                        device: input.device,
                        failures: 0,
                    },
                });
        });
    }

    removeOwn(userId: string, id: string) {
        return this.write('remove push subscription', async () => {
            const removed = await this.db
                .delete(pushSubscriptions)
                .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)))
                .returning({ id: pushSubscriptions.id });
            return removed.length > 0;
        });
    }

    remove(id: string) {
        return this.write('drop push subscription', async () => {
            await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
        });
    }

    removeAll() {
        return this.write('drop every push subscription', async () => {
            await this.db.delete(pushSubscriptions);
        });
    }

    sent(id: string, now: number) {
        return this.write('record push result', async () => {
            await this.db
                .update(pushSubscriptions)
                .set({ lastSentAt: now, failures: 0 })
                .where(eq(pushSubscriptions.id, id));
        });
    }

    failed(id: string) {
        return this.write('record push result', async () => {
            await this.db
                .update(pushSubscriptions)
                .set({ failures: sql`${pushSubscriptions.failures} + 1` })
                .where(eq(pushSubscriptions.id, id));
        });
    }
}
