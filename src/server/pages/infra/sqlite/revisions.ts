import { desc, eq } from 'drizzle-orm';

import type { PageRevisionRepository, StoredPageRevision } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { pageRevisions as r } from './schema.js';

/** A page's kept revisions, compressed as stored (`revisionBody`). */
export class SqlitePageRevisions extends SqliteRepository implements PageRevisionRepository {
    async latest(pageId: string) {
        return this.db
            .select({ authorId: r.authorId, replacedAt: r.replacedAt })
            .from(r)
            .where(eq(r.pageId, pageId))
            .orderBy(desc(r.replacedAt), desc(r.id))
            .limit(1)
            .get();
    }

    insert(revision: StoredPageRevision) {
        return this.write('keep page revision', async () => {
            await this.db.insert(r).values(revision);
        });
    }
}
