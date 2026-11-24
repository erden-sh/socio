import { primaryKey, sqliteTable } from 'drizzle-orm/sqlite-core';

import { enumText, id, int, json, ms, str } from '@socio/data/columns.sqlite';
import type { ComputerPermissions } from '@socio/shared/computers/computer-types';
import type { DomainStep } from '@socio/shared/domains';

/**
 * The Integrations tables (CB-110), as `integrations/migrations.ts` makes
 * them: the typed mirror the repositories query. The migrations stay the
 * source of truth; tests/integration-repositories.test.ts holds these to
 * them.
 */

// Telegram

export const telegramLinkCodes = sqliteTable('telegram_link_codes', {
    hash: str().primaryKey(),
    userId: str().notNull(),
    expiresAt: ms().notNull(),
    usedAt: ms(),
});

export const telegramLinks = sqliteTable('telegram_links', {
    telegramUserId: str().primaryKey(),
    userId: str().notNull(),
    username: str(),
    linkedAt: ms().notNull(),
});

export const telegramMembers = sqliteTable(
    'telegram_members',
    {
        chatId: str().notNull(),
        userId: str().notNull(),
        seenAt: ms().notNull(),
    },
    (table) => [primaryKey({ columns: [table.chatId, table.userId] })],
);

export const telegramThreads = sqliteTable('telegram_threads', {
    key: str().primaryKey(),
    threadId: str().notNull(),
    kind: str().$type<'dm' | 'topic' | 'group'>().notNull(),
    chatId: str().notNull(),
    topicId: str(),
    createdAt: ms().notNull(),
});

/** The socio reply each bot message in a direct message shows (CB-145). */
export const telegramReplies = sqliteTable(
    'telegram_replies',
    {
        chatId: str().notNull(),
        messageId: str().notNull(),
        threadId: str().notNull(),
        replyId: str().notNull(),
        createdAt: ms().notNull(),
    },
    (table) => [primaryKey({ columns: [table.chatId, table.messageId] })],
);

/** Codes that bind a forum topic to a room, stored hashed (CB-214). */
export const telegramRoomCodes = sqliteTable('telegram_room_codes', {
    hash: str().primaryKey(),
    userId: str().notNull(),
    purpose: enumText(['bind', 'convert']).notNull(),
    target: str().notNull(),
    expiresAt: ms().notNull(),
    usedAt: ms(),
    createdAt: ms().notNull(),
});

/** Who addressed the socio in a bound topic and was not answered (CB-214). */
export const telegramTopicSenders = sqliteTable(
    'telegram_topic_senders',
    {
        sourceKey: str().notNull(),
        roomId: str().notNull(),
        telegramUserId: str().notNull(),
        reason: enumText(['unlinked', 'not_member', 'closed']).notNull(),
        username: str(),
        firstSeenAt: ms().notNull(),
        lastSeenAt: ms().notNull(),
        seen: int().notNull(),
        noticedAt: ms(),
    },
    (table) => [
        primaryKey({
            columns: [table.sourceKey, table.roomId, table.telegramUserId, table.reason],
        }),
    ],
);

// Web

export const webIdentity = sqliteTable('web_identity', {
    dotId: id().primaryKey(),
    identity: enumText(['agent', 'browser']).notNull(),
    updatedAt: ms().notNull(),
});

export const webAudit = sqliteTable('web_audit', {
    id: id().primaryKey(),
    dotId: id().notNull(),
    userId: str(),
    method: str().notNull(),
    host: str().notNull(),
    path: str().notNull(),
    status: int(),
    bytes: int().notNull(),
    outcome: str().notNull(),
    createdAt: ms().notNull(),
});

// Computers

export const computerPermissions = sqliteTable('computer_permissions', {
    dotId: id().primaryKey(),
    value: json<ComputerPermissions>().notNull(),
});

export const computerAudit = sqliteTable('computer_audit', {
    id: id().primaryKey(),
    dotId: id().notNull(),
    action: str().notNull(),
    actor: str().$type<'owner' | 'agent' | 'platform'>().notNull(),
    outcome: str().$type<'pending' | 'succeeded' | 'failed'>().notNull(),
    createdAt: ms().notNull(),
    userId: str(),
});

// Domains

export const domainHosts = sqliteTable('domain_hosts', {
    hostname: str().primaryKey(),
    kind: enumText(['base', 'custom']).notNull(),
    dnsRecordId: str(),
    dnsContent: str(),
    dnsCreated: int().notNull(),
    certificateId: int(),
    certificateCreated: int().notNull(),
    proxyHostId: int(),
    proxyHostCreated: int().notNull(),
    createdBy: str().notNull(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
});

export const domainOps = sqliteTable('domain_ops', {
    id: id().primaryKey(),
    kind: enumText(['ensure_base', 'provision', 'remove']).notNull(),
    hostname: str().notNull(),
    actor: str().notNull(),
    status: enumText(['running', 'ok', 'failed']).notNull(),
    steps: json<DomainStep[]>().notNull(),
    error: str(),
    startedAt: ms().notNull(),
    finishedAt: ms(),
});

/** Every table Integrations owns, for the drift test and the SQL check. */
export const integrationTables = [
    telegramLinkCodes,
    telegramLinks,
    telegramMembers,
    telegramThreads,
    telegramReplies,
    telegramRoomCodes,
    telegramTopicSenders,
    webIdentity,
    webAudit,
    computerPermissions,
    computerAudit,
    domainHosts,
    domainOps,
] as const;
