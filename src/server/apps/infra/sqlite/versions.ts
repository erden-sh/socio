import { and, asc, eq } from 'drizzle-orm';

import type { AppVersion, AppVersionRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { appVersions as v } from './schema.js';

/** Packaged versions of mini apps; bundles live in the data space. */
export class SqliteAppVersions extends SqliteRepository implements AppVersionRepository {
    async forApp(appId: string): Promise<AppVersion[]> {
        return this.db.select().from(v).where(eq(v.appId, appId)).orderBy(asc(v.version));
    }

    add(version: AppVersion) {
        return this.write('add app version', async () => {
            await this.db.insert(v).values(version);
        });
    }

    rekey(from: string, to: string, bundles: Array<{ version: number; bundlePath: string }>) {
        return this.write('rekey app versions', async () => {
            for (const bundle of bundles) {
                await this.db
                    .update(v)
                    .set({ appId: to, bundlePath: bundle.bundlePath })
                    .where(and(eq(v.appId, from), eq(v.version, bundle.version)));
            }
        });
    }
}
