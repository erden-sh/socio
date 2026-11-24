import { and, eq, isNull, sql } from 'drizzle-orm';

import type { NewPage, PageDeletion, PageEdit, PageRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { pages as p } from './schema.js';

/** The Spaces' pages, hidden and kept once deleted (CB-64). */
export class SqlitePages extends SqliteRepository implements PageRepository {
    insert(page: NewPage) {
        return this.write('add page', async () => {
            await this.db.insert(p).values({
                ...page,
                revision: 1,
                updatedAt: page.createdAt,
            });
        });
    }

    edit(id: string, revision: number, edit: PageEdit, now: number) {
        return this.write('edit page', async () => {
            await this.db
                .update(p)
                .set({ ...edit, revision: sql`${p.revision} + 1`, updatedAt: now })
                .where(and(eq(p.id, id), eq(p.revision, revision)));
        });
    }

    move(id: string, spaceId: string, parentId: string | null, now: number, content?: string) {
        return this.write('move page', async () => {
            await this.db
                .update(p)
                .set({
                    spaceId,
                    parentId,
                    ...(content === undefined ? {} : { content }),
                    revision: sql`${p.revision} + 1`,
                    updatedAt: now,
                })
                .where(eq(p.id, id));
        });
    }

    cover(id: string, coverId: string | null, now: number) {
        return this.write('set page cover', async () => {
            await this.db
                .update(p)
                .set({ coverId, updatedAt: now })
                .where(and(eq(p.id, id), isNull(p.deletedAt)));
        });
    }

    hide(id: string, deletion: PageDeletion) {
        return this.write('delete page', async () => {
            await this.db
                .update(p)
                .set({
                    deletedAt: deletion.at,
                    deletedBy: deletion.by,
                    deletedWith: deletion.with,
                })
                .where(and(eq(p.id, id), isNull(p.deletedAt)));
        });
    }
}
