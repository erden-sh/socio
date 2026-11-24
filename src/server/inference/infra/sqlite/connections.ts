import { and, asc, eq, sql } from 'drizzle-orm';

import type { ByoConnectionRepository, StoredConnection } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { userInferenceConnections } from './schema.js';

/** People's own connections, credentials sealed. */
export class SqliteByoConnections extends SqliteRepository implements ByoConnectionRepository {
    /** A person's turns read their connections: prepared once. */
    private oneQuery = this.data.uow
        .executor()
        .select()
        .from(userInferenceConnections)
        .where(
            and(
                eq(userInferenceConnections.userId, sql.placeholder('userId')),
                eq(userInferenceConnections.kind, sql.placeholder('kind')),
            ),
        )
        .prepare();

    async get(userId: string, kind: string) {
        this.data.uow.executor();
        return this.oneQuery.get({ userId, kind });
    }

    save(connection: StoredConnection) {
        return this.write('save inference connection', async () => {
            const { credentials, meta, updatedAt } = connection;
            await this.db
                .insert(userInferenceConnections)
                .values(connection)
                .onConflictDoUpdate({
                    target: [userInferenceConnections.userId, userInferenceConnections.kind],
                    set: { credentials, meta, updatedAt },
                });
        });
    }

    remove(userId: string, kind: string) {
        return this.write('remove inference connection', async () => {
            await this.db
                .delete(userInferenceConnections)
                .where(and(eq(userInferenceConnections.userId, userId), eq(userInferenceConnections.kind, kind)));
        });
    }

    async kinds(userId: string) {
        const rows = await this.db
            .select({ kind: userInferenceConnections.kind })
            .from(userInferenceConnections)
            .where(eq(userInferenceConnections.userId, userId))
            .orderBy(asc(userInferenceConnections.kind));
        return rows.map((row) => row.kind);
    }

    async all(): Promise<StoredConnection[]> {
        return this.db.select().from(userInferenceConnections);
    }

    replaceCredentials(userId: string, kind: string, current: string, next: string) {
        return this.write('re-seal inference connection', async () => {
            const changed = await this.db
                .update(userInferenceConnections)
                .set({ credentials: next })
                .where(
                    and(
                        eq(userInferenceConnections.userId, userId),
                        eq(userInferenceConnections.kind, kind),
                        eq(userInferenceConnections.credentials, current),
                    ),
                )
                .returning({ kind: userInferenceConnections.kind });
            return changed.length > 0;
        });
    }

    /**
     * Acquire the cross-runtime refresh lease (per-user providers step 5):
     * if no lease is held (or it has expired), set it to `until` for `by`;
     * return whether this runtime acquired it, or the lease's expiry when
     * another runtime holds it. A CAS update so two runtimes can't both grab
     * a single-use refresh token.
     */
    tryLeaseRefresh(
        userId: string,
        kind: string,
        by: string,
        until: number,
        now: number,
    ): Promise<{ acquired: boolean; leasedUntil: number }> {
        return this.write('lease inference refresh', async () => {
            const row = await this.oneQuery.get({ userId, kind });
            if (!row) {
                return { acquired: false, leasedUntil: 0 };
            }
            if (row.refreshLeasedUntil > now && row.refreshLeasedBy !== by) {
                return { acquired: false, leasedUntil: row.refreshLeasedUntil };
            }
            await this.db
                .update(userInferenceConnections)
                .set({ refreshLeasedUntil: until, refreshLeasedBy: by })
                .where(and(eq(userInferenceConnections.userId, userId), eq(userInferenceConnections.kind, kind)));
            return { acquired: true, leasedUntil: until };
        });
    }

    /** Release the lease this runtime holds (after a refresh settles). */
    releaseLease(userId: string, kind: string, by: string): Promise<void> {
        return this.write('release inference refresh lease', async () => {
            await this.db
                .update(userInferenceConnections)
                .set({ refreshLeasedUntil: 0, refreshLeasedBy: null })
                .where(
                    and(
                        eq(userInferenceConnections.userId, userId),
                        eq(userInferenceConnections.kind, kind),
                        eq(userInferenceConnections.refreshLeasedBy, by),
                    ),
                );
        });
    }
}
