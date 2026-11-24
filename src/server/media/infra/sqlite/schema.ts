import { primaryKey, sqliteTable } from 'drizzle-orm/sqlite-core';

import { enumText, id, int, ms, str } from '@socio/data/columns.sqlite';

/**
 * Media's tables (CB-110), as `media/migrations.ts` makes them: the typed
 * mirror the repositories query. The migrations stay the source of truth;
 * tests/media-repositories.test.ts holds these to them.
 */

export const mediaAttachments = sqliteTable('media_attachments', {
    id: id().primaryKey(),
    fileId: id().notNull(),
    ownerUserId: str().notNull(),
    threadId: str(),
    dotId: str(),
    messageId: str(),
    name: str().notNull(),
    mediaType: str().notNull(),
    kind: enumText(['image', 'text', 'file']).notNull(),
    size: int().notNull(),
    source: enumText(['web', 'telegram', 'tool']).notNull(),
    createdAt: ms().notNull(),
    boundAt: ms(),
    deletedAt: ms(),
    deletedBy: str(),
    deletedWith: str(),
});

export const mediaFolders = sqliteTable(
    'media_folders',
    {
        ownerUserId: str().notNull(),
        path: str().notNull(),
        createdAt: ms().notNull(),
    },
    (table) => [primaryKey({ columns: [table.ownerUserId, table.path] })],
);

export const mediaEmbeds = sqliteTable('media_embeds', {
    id: id().primaryKey(),
    fileId: id().notNull(),
    ownerUserId: str().notNull(),
    dotId: str(),
    spaceId: str().notNull(),
    sourceUrl: str().notNull(),
    createdAt: ms().notNull(),
    origin: enumText(['upload']),
    pageId: str(),
    contentHash: str(),
    uploadedAt: ms(),
    checkedAt: ms(),
});

/** Every table Media owns, for the drift test and the SQL check. */
export const mediaTables = [mediaAttachments, mediaFolders, mediaEmbeds] as const;
