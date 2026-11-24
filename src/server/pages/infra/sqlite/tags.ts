import { and, eq } from 'drizzle-orm';

import type { NewPageTag, PageTagRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { pageTags } from './schema.js';

/** Page tags (CB-328) on a migrated connection. */
export class SqlitePageTags extends SqliteRepository implements PageTagRepository {
    upsert(tag: NewPageTag) {
        return this.write('tag page', async () => {
            await this.db
                .insert(pageTags)
                .values(tag)
                .onConflictDoNothing({ target: [pageTags.pageId, pageTags.tag] });
        });
    }

    remove(pageId: string, tag: string) {
        return this.write('untag page', async () => {
            const result = await this.db
                .delete(pageTags)
                .where(and(eq(pageTags.pageId, pageId), eq(pageTags.tag, tag)));
            return result.changes > 0;
        });
    }
}
