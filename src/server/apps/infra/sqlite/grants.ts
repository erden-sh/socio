import { asc, eq } from 'drizzle-orm';

import type { AppGrant, AppGrantRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { appGrants, appGrants as g } from './schema.js';

/** The datasets promoted apps' tokens may use. */
export class SqliteAppGrants extends SqliteRepository implements AppGrantRepository {
    async forApp(appId: string): Promise<AppGrant[]> {
        return this.db.select().from(g).where(eq(g.appId, appId)).orderBy(asc(g.createdAt), asc(g.ref));
    }

    replace(appId: string, grants: Array<Omit<AppGrant, 'appId' | 'createdAt'>>, now: number) {
        return this.write('replace app grants', async () => {
            await this.db.delete(appGrants).where(eq(g.appId, appId));
            for (const grant of grants) {
                const row = {
                    ref: grant.ref,
                    access: grant.access,
                    createdByPromotion: grant.createdByPromotion,
                    createdAt: now,
                };
                await this.db
                    .insert(g)
                    .values({ appId, datasetId: grant.datasetId, ...row })
                    .onConflictDoUpdate({ target: [g.appId, g.datasetId], set: row });
            }
        });
    }

    rekey(from: string, to: string) {
        return this.write('rekey app grants', async () => {
            await this.db.update(g).set({ appId: to }).where(eq(g.appId, from));
        });
    }
}
