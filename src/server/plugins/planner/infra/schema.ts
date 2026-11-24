import { sqliteTable } from 'drizzle-orm/sqlite-core';

import { enumText, id, json, ms, str } from '@socio/data/columns.sqlite';
import type { PostStatus, ReplyStatus } from '@socio/shared/planner';
import type { ThreadPart } from '@socio/shared/x-post';

/** The typed mirror of `planner/migrations.ts`. */
export const plannedPosts = sqliteTable('planned_posts', {
    id: id().primaryKey(),
    status: enumText(['idea', 'draft', 'ready', 'scheduled-for-manual-posting', 'posted', 'skipped'])
        .notNull()
        .$type<PostStatus>(),
    account: str().notNull(),
    plannedAt: ms().notNull(),
    topic: str().notNull(),
    notes: str().notNull(),
    parts: json<ThreadPart[]>().notNull(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
});

export const replyQueue = sqliteTable('reply_queue', {
    id: id().primaryKey(),
    sourceUrl: str().notNull(),
    sourceId: str().notNull(),
    author: str().notNull(),
    excerpt: str().notNull().default(''),
    why: str().notNull(),
    draft: str().notNull(),
    status: enumText(['todo', 'replied', 'skip']).notNull().$type<ReplyStatus>(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
});

export const plannerVoice = sqliteTable('planner_voice', {
    id: str().primaryKey(),
    notes: str().notNull(),
    updatedAt: ms().notNull(),
});
