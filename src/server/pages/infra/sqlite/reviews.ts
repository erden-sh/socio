import { eq } from 'drizzle-orm';

import type { PageReviewReceipt, PageReviewRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { pageReviews as r } from './schema.js';

/** Review receipts: a reviewed draft saved as a page, once per tool call. */
export class SqlitePageReviews extends SqliteRepository implements PageReviewRepository {
    insert(receipt: PageReviewReceipt) {
        return this.write('add page review receipt', async () => {
            await this.db.insert(r).values(receipt);
        });
    }

    moveSpace(pageId: string, spaceId: string) {
        return this.write('move page review receipts', async () => {
            await this.db.update(r).set({ spaceId }).where(eq(r.pageId, pageId));
        });
    }
}
