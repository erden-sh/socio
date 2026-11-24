import { and, eq, inArray, isNull, ne } from 'drizzle-orm';

import type { AppStatus } from '@socio/shared/apps/app-types';

import type { AppDeletion, AppRegistration, AppRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { apps } from './schema.js';

/** The registered mini apps, hidden and kept once deleted (CB-64). */
export class SqliteApps extends SqliteRepository implements AppRepository {
    async portHolder(dotId: string, port: number, exceptId: string) {
        const row = await this.db
            .select({ id: apps.id })
            .from(apps)
            .where(
                and(
                    eq(apps.dotId, dotId),
                    eq(apps.port, port),
                    ne(apps.id, exceptId),
                    inArray(apps.status, ['ephemeral', 'packaged']),
                    isNull(apps.deletedAt),
                ),
            )
            .get();
        return row?.id;
    }

    register(app: AppRegistration) {
        return this.write('register app', async () => {
            await this.db
                .insert(apps)
                .values({
                    ...app,
                    public: false,
                    sharedSpaceId: null,
                    status: 'ephemeral',
                    config: {},
                })
                .onConflictDoUpdate({
                    target: apps.id,
                    set: {
                        name: app.name,
                        description: app.description,
                        port: app.port,
                        datasets: app.datasets,
                        startCommand: app.startCommand,
                        updatedAt: app.updatedAt,
                    },
                });
        });
    }

    setStatus(id: string, status: AppStatus, now: number) {
        return this.write('set app status', async () => {
            await this.db.update(apps).set({ status, updatedAt: now }).where(eq(apps.id, id));
        });
    }

    share(id: string, spaceId: string | null, now: number) {
        return this.write('share app', async () => {
            await this.db.update(apps).set({ sharedSpaceId: spaceId, updatedAt: now }).where(eq(apps.id, id));
        });
    }

    promote(id: string, promotion: { version: number; config: Record<string, string> }, now: number) {
        return this.write('promote app', async () => {
            await this.db
                .update(apps)
                .set({
                    status: 'promoted',
                    liveVersion: promotion.version,
                    previousVersion: null,
                    config: promotion.config,
                    promotedAt: now,
                    updatedAt: now,
                })
                .where(eq(apps.id, id));
        });
    }

    setVersions(id: string, live: number, previous: number | null, now: number) {
        return this.write('set app versions', async () => {
            await this.db
                .update(apps)
                .set({ liveVersion: live, previousVersion: previous, updatedAt: now })
                .where(eq(apps.id, id));
        });
    }

    retire(id: string, as: string, stamp: AppDeletion) {
        return this.write('retire app', async () => {
            await this.db
                .update(apps)
                .set({
                    id: as,
                    deletedLabel: id,
                    deletedAt: stamp.at,
                    deletedBy: stamp.by,
                    deletedWith: stamp.with,
                })
                .where(and(eq(apps.id, id), isNull(apps.deletedAt)));
        });
    }
}
