import { and, asc, count, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';

import type { EmbedMedia, EmbedMediaRepository } from '../../domain/repositories.js';

import { SqliteRepository, insertionOrder } from './base.js';
import { mediaEmbeds as e } from './schema.js';

/** Link cards' media (CB-230) and page covers (CB-308). */
export class SqliteEmbedMedia extends SqliteRepository implements EmbedMediaRepository {
    async byId(id: string): Promise<EmbedMedia | undefined> {
        return this.db.select().from(e).where(eq(e.id, id)).get();
    }

    byIdNow(id: string): EmbedMedia | undefined {
        // Drizzle on node:sqlite runs a query when it is asked.
        return this.db.select().from(e).where(eq(e.id, id)).get();
    }

    async forSpace(spaceId: string, limit: number): Promise<EmbedMedia[]> {
        return this.db
            .select()
            .from(e)
            .where(eq(e.spaceId, spaceId))
            .orderBy(desc(e.createdAt), desc(insertionOrder(e)))
            .limit(limit)
            .all();
    }

    insert(row: EmbedMedia) {
        return this.write('add link card media', async () => {
            await this.db.insert(e).values(row);
        });
    }

    async uploads(spaceId: string, pageId: string | null, contentHash: string): Promise<EmbedMedia[]> {
        return this.db
            .select()
            .from(e)
            .where(
                and(
                    eq(e.spaceId, spaceId),
                    eq(e.contentHash, contentHash),
                    eq(e.origin, 'upload'),
                    pageId === null ? isNull(e.pageId) : eq(e.pageId, pageId),
                ),
            )
            .orderBy(asc(e.createdAt), asc(insertionOrder(e)))
            .all();
    }

    touch(id: string, now: number) {
        return this.write('reuse space upload', async () => {
            await this.db.update(e).set({ uploadedAt: now, checkedAt: null }).where(eq(e.id, id));
        });
    }

    async staleUploads(before: number, checkedBefore: number, limit: number): Promise<EmbedMedia[]> {
        return this.db
            .select()
            .from(e)
            .where(
                and(
                    eq(e.origin, 'upload'),
                    lt(e.uploadedAt, before),
                    or(isNull(e.checkedAt), lt(e.checkedAt, checkedBefore)),
                ),
            )
            .orderBy(asc(e.uploadedAt), asc(insertionOrder(e)))
            .limit(limit)
            .all();
    }

    checked(ids: readonly string[], now: number) {
        return this.write('check space uploads', async () => {
            if (ids.length) {
                await this.db
                    .update(e)
                    .set({ checkedAt: now })
                    .where(inArray(e.id, [...ids]));
            }
        });
    }

    async countForFile(ownerUserId: string, fileId: string): Promise<number> {
        const row = this.db
            .select({ n: count() })
            .from(e)
            .where(and(eq(e.ownerUserId, ownerUserId), eq(e.fileId, fileId)))
            .get();
        return row?.n ?? 0;
    }

    remove(id: string) {
        return this.write('remove space upload', async () => {
            const { changes } = await this.db.delete(e).where(eq(e.id, id));
            return Number(changes) > 0;
        });
    }
}
