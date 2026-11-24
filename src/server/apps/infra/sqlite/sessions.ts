import { and, count, eq, gt, lte, ne } from 'drizzle-orm';

import type { AppOriginSession, AppSessionRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { appSessions, appSessions as s } from './schema.js';

/** Sessions on the apps' own origins, by their cookie value's hash. */
export class SqliteAppSessions extends SqliteRepository implements AppSessionRepository {
    async byHash(hash: string): Promise<AppOriginSession | undefined> {
        return this.db.select().from(s).where(eq(s.hash, hash)).get();
    }

    async countLive(appId: string, now: number) {
        const row = await this.db
            .select({ n: count() })
            .from(s)
            .where(and(eq(s.appId, appId), gt(s.expiresAt, now)))
            .get();
        return row?.n ?? 0;
    }

    add(session: AppOriginSession, now: number) {
        return this.write('add app session', async () => {
            await this.db.delete(appSessions).where(lte(s.expiresAt, now));
            await this.db.insert(s).values(session);
        });
    }

    remove(hash: string) {
        return this.write('end app session', async () => {
            await this.db.delete(appSessions).where(eq(s.hash, hash));
        });
    }

    removeForApp(appId: string) {
        return this.write('end app sessions', async () => {
            await this.db.delete(appSessions).where(eq(s.appId, appId));
        });
    }

    removeForAppExcept(appId: string, userId: string) {
        return this.write('end app sessions', async () => {
            await this.db.delete(appSessions).where(and(eq(s.appId, appId), ne(s.userId, userId)));
        });
    }

    async countOf(userId: string) {
        const row = await this.db.select({ n: count() }).from(s).where(eq(s.userId, userId)).get();
        return row?.n ?? 0;
    }

    removeOf(userId: string) {
        return this.write('end app sessions of a person', async () => {
            const apps = await this.db.selectDistinct({ appId: s.appId }).from(s).where(eq(s.userId, userId));
            const { changes } = await this.db.delete(appSessions).where(eq(s.userId, userId));
            return { apps: apps.map((row) => row.appId), ended: Number(changes) };
        });
    }
}
