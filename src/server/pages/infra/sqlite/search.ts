import { eq, lt } from 'drizzle-orm';

import type { PageSearchEntry, PageSearchIndex, PageUseRepository, StoredPageUse } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { pageSearch, pageSearch as s, pageUse, pageUse as u, pageUseDays, pageUseDays as d } from './schema.js';

/**
 * The search index's rows. `page_search` is the FTS5 indexes' external
 * content: its triggers (pages migration 5) keep both indexes in step.
 */
export class SqlitePageSearchIndex extends SqliteRepository implements PageSearchIndex {
    put({ pageId, spaceId, title, body }: PageSearchEntry) {
        return this.write('index page', async () => {
            await this.db
                .insert(s)
                .values({ pageId, spaceId, title, body })
                .onConflictDoUpdate({ target: s.pageId, set: { title, body } });
        });
    }

    remove(pageId: string) {
        return this.write('unindex page', async () => {
            await this.db.delete(pageSearch).where(eq(s.pageId, pageId));
        });
    }

    moveSpace(pageId: string, spaceId: string) {
        return this.write('move indexed page', async () => {
            await this.db.update(s).set({ spaceId }).where(eq(s.pageId, pageId));
        });
    }
}

/** Pages' freshness from use, and the days that counted toward it. */
export class SqlitePageUse extends SqliteRepository implements PageUseRepository {
    async use(pageId: string): Promise<StoredPageUse | undefined> {
        return this.db
            .select({ score: u.score, scoredAt: u.scoredAt, usedAt: u.usedAt })
            .from(u)
            .where(eq(u.pageId, pageId))
            .get();
    }

    put(pageId: string, use: StoredPageUse) {
        return this.write('score page use', async () => {
            await this.db
                .insert(u)
                .values({ pageId, ...use })
                .onConflictDoUpdate({ target: u.pageId, set: use });
        });
    }

    addDay(pageId: string, userId: string, day: number) {
        return this.write('count page use', async () => {
            const { changes } = await this.db.insert(d).values({ pageId, userId, day }).onConflictDoNothing();
            return Number(changes) > 0;
        });
    }

    pruneDaysBefore(day: number) {
        return this.write('prune page use days', async () => {
            await this.db.delete(pageUseDays).where(lt(d.day, day));
        });
    }

    removeForPage(pageId: string) {
        return this.write('forget page use', async () => {
            await this.db.delete(pageUse).where(eq(u.pageId, pageId));
            await this.db.delete(pageUseDays).where(eq(d.pageId, pageId));
        });
    }
}
