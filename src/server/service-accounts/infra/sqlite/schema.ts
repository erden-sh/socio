import { sqliteTable } from 'drizzle-orm/sqlite-core';

import { enumText, json, ms, str } from '@socio/data/columns.sqlite';
import type { ServiceScope } from '@socio/shared/service-accounts';

/**
 * Service accounts' tables (CB-110), as the workspace's migrations make
 * them (workspace.ts): the typed mirror the repositories query. The
 * migrations stay the source of truth; tests/service-account-repositories.test.ts
 * holds these to them.
 */

/**
 * The workspace's people (`users`): a service account is one of them, made
 * and renamed with its account. Mirrored here for those writes until the
 * workspace's identity tables have repositories of their own.
 */
export const users = sqliteTable('users', {
    id: str().primaryKey(),
    name: str().notNull(),
    // The table's CHECK still accepts the retired `operator`, so an older
    // backup restores; boot rewrites it to `admin` (CB-390).
    role: enumText(['operator', 'admin', 'member']).notNull(),
    createdAt: ms().notNull(),
    lastSeenAt: ms().notNull(),
});

export const serviceAccounts = sqliteTable('service_accounts', {
    userId: str().primaryKey(),
    description: str().notNull(),
    createdAt: ms().notNull(),
    createdBy: str(),
    disabledAt: ms(),
});

export const serviceKeys = sqliteTable('service_keys', {
    id: str().primaryKey(),
    userId: str().notNull(),
    name: str().notNull(),
    hint: str().notNull(),
    /** SHA-256 of the token: the secret itself is never stored. */
    hash: str().notNull(),
    scopes: json<ServiceScope[]>().notNull(),
    createdAt: ms().notNull(),
    createdBy: str(),
    expiresAt: ms().notNull(),
    lastUsedAt: ms(),
    lastUsedIp: str(),
    revokedAt: ms(),
});

export const serviceAccountTables = [users, serviceAccounts, serviceKeys];
