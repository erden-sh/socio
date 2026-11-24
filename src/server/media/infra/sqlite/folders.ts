import { and, asc, eq, sql } from 'drizzle-orm';

import type { MediaFolderRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { mediaFolders } from './schema.js';

/** `folder` and every path under it. */
const under = (folder: string) => sql`substr(${mediaFolders.path}, 1, length(${folder})) = ${folder}`;

/** The Media page's empty folders. */
export class SqliteMediaFolders extends SqliteRepository implements MediaFolderRepository {
    async paths(ownerUserId: string) {
        const rows = await this.db
            .select({ path: mediaFolders.path })
            .from(mediaFolders)
            .where(eq(mediaFolders.ownerUserId, ownerUserId))
            .orderBy(asc(mediaFolders.path));
        return rows.map((row) => row.path);
    }

    add(ownerUserId: string, path: string, now: number) {
        return this.write('add media folder', async () => {
            await this.db.insert(mediaFolders).values({ ownerUserId, path, createdAt: now });
        });
    }

    move(ownerUserId: string, from: string, to: string, now: number) {
        return this.write('move media folders', async () => {
            const moving = await this.db
                .select({ path: mediaFolders.path })
                .from(mediaFolders)
                .where(and(eq(mediaFolders.ownerUserId, ownerUserId), under(from)))
                .orderBy(asc(mediaFolders.path));
            for (const { path } of moving) {
                await this.db
                    .insert(mediaFolders)
                    .values({
                        ownerUserId,
                        path: `${to}${path.slice(from.length)}`,
                        createdAt: now,
                    })
                    .onConflictDoNothing();
            }
            await this.db.delete(mediaFolders).where(and(eq(mediaFolders.ownerUserId, ownerUserId), under(from)));
        });
    }

    removeUnder(ownerUserId: string, folder: string) {
        return this.write('remove media folders', async () => {
            await this.db.delete(mediaFolders).where(and(eq(mediaFolders.ownerUserId, ownerUserId), under(folder)));
        });
    }
}
