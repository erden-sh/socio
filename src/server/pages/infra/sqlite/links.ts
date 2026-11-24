import { and, eq, isNull, sql } from 'drizzle-orm';

import type { NewPageLink, PageLinkRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { pageLinks } from './schema.js';

/** Page links (CB-328): typed, directed, cross-Space edges on a migrated connection. */
export class SqlitePageLinks extends SqliteRepository implements PageLinkRepository {
    upsert(link: NewPageLink) {
        return this.write('link pages', async () => {
            // Raw SQL because the live-edge uniqueness is a partial index
            // (WHERE removedAt IS NULL); drizzle's onConflictDoNothing emits
            // the partial-index WHERE in the wrong place for node-sqlite.
            await this.db
                .run(sql`INSERT INTO page_links(id, fromPageId, toPageId, fromSpaceId, toSpaceId, kind, createdBy, createdAt, removedAt, removedBy)
                VALUES (${link.id}, ${link.fromPageId}, ${link.toPageId}, ${link.fromSpaceId}, ${link.toSpaceId}, ${link.kind}, ${link.createdBy}, ${link.createdAt}, NULL, NULL)
                ON CONFLICT(fromPageId, toPageId, kind) WHERE removedAt IS NULL DO NOTHING`);
        });
    }

    remove(fromPageId: string, toPageId: string, kind: NewPageLink['kind'], at: number, by: string | null) {
        return this.write('unlink pages', async () => {
            const result = await this.db
                .update(pageLinks)
                .set({ removedAt: at, removedBy: by })
                .where(
                    and(
                        eq(pageLinks.fromPageId, fromPageId),
                        eq(pageLinks.toPageId, toPageId),
                        eq(pageLinks.kind, kind),
                        isNull(pageLinks.removedAt),
                    ),
                );
            return result.changes > 0;
        });
    }
}
