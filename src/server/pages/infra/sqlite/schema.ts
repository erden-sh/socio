import { primaryKey, sqliteTable } from 'drizzle-orm/sqlite-core';

import { bytes, enumText, flag, float, id, int, ms, str } from '@socio/data/columns.sqlite';

/**
 * The Spaces pages tables the repositories write (CB-110), as
 * `pagesSchema` (pages.ts) makes them: the typed mirror they query. The
 * migrations stay the source of truth; tests/integration/page-repositories.test.ts
 * holds these to them. The FTS5 indexes over `page_search` are filled by
 * its triggers, and the search's daily rollup by `search-stats.ts`.
 */

export const pages = sqliteTable('pages', {
    id: id().primaryKey(),
    spaceId: id().notNull(),
    parentId: id(),
    title: str().notNull(),
    content: str().notNull(),
    revision: int().notNull(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
    sourceThreadId: str(),
    createdBy: str(),
    deletedAt: ms(),
    deletedBy: str(),
    deletedWith: str(),
    coverId: str(),
    sourceUrl: str(),
    sourceTitle: str(),
});

export const pageTags = sqliteTable(
    'page_tags',
    {
        pageId: id().notNull(),
        spaceId: id().notNull(),
        tag: str().notNull(),
        createdBy: str(),
        createdAt: ms().notNull(),
    },
    (table) => [primaryKey({ columns: [table.pageId, table.tag] })],
);

export const pageLinks = sqliteTable('page_links', {
    id: id().primaryKey(),
    fromPageId: id().notNull(),
    toPageId: id().notNull(),
    fromSpaceId: id().notNull(),
    toSpaceId: id().notNull(),
    kind: enumText(['index', 'derived_from', 'cites', 'related']).notNull(),
    createdBy: str(),
    createdAt: ms().notNull(),
    removedAt: ms(),
    removedBy: str(),
});

export const pageRevisions = sqliteTable('page_revisions', {
    id: int().primaryKey(),
    pageId: id().notNull(),
    spaceId: id().notNull(),
    revision: int().notNull(),
    title: str().notNull(),
    body: bytes().notNull(),
    encoding: enumText(['br', 'utf8']).notNull(),
    authorId: str(),
    createdAt: ms().notNull(),
    replacedAt: ms().notNull(),
});

export const pageReviews = sqliteTable(
    'page_reviews',
    {
        threadId: str().notNull(),
        toolCallId: str().notNull(),
        pageId: id().notNull(),
        spaceId: id().notNull(),
        draft: str(),
    },
    (table) => [primaryKey({ columns: [table.threadId, table.toolCallId] })],
);

export const pageThreads = sqliteTable(
    'page_threads',
    {
        pageId: id().notNull(),
        dotId: str().notNull(),
        userId: str().notNull(),
        threadId: str().notNull(),
        ready: flag().notNull(),
        leaseUntil: ms().notNull(),
    },
    (table) => [primaryKey({ columns: [table.pageId, table.dotId, table.userId] })],
);

export const pageSearch = sqliteTable('page_search', {
    id: int().primaryKey(),
    pageId: id().notNull(),
    spaceId: id().notNull(),
    title: str().notNull(),
    body: str().notNull(),
});

export const pageUse = sqliteTable('page_use', {
    pageId: id().primaryKey(),
    score: float().notNull(),
    scoredAt: ms().notNull(),
    usedAt: ms().notNull(),
});

export const pageUseDays = sqliteTable(
    'page_use_days',
    {
        pageId: id().notNull(),
        userId: str().notNull(),
        day: int().notNull(),
    },
    (table) => [primaryKey({ columns: [table.pageId, table.userId, table.day] })],
);

/** Every table the pages repositories write, for the drift test. */
export const pageTables = [
    pages,
    pageTags,
    pageLinks,
    pageRevisions,
    pageReviews,
    pageThreads,
    pageSearch,
    pageUse,
    pageUseDays,
] as const;
