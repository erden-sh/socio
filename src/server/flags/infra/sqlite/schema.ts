import { primaryKey, sqliteTable } from 'drizzle-orm/sqlite-core';

import { enumText, flag, json, ms, str } from '@socio/data/columns.sqlite';
import type { Role } from '@socio/shared/types';

/**
 * Feature flags' tables (CB-110), as `flagsSchema` (flags/service.ts)
 * makes them: the typed mirror the repositories query. The migrations stay
 * the source of truth; tests/flag-repositories.test.ts holds these to them.
 */

export const flagRules = sqliteTable(
    'flag_rules',
    {
        scope: enumText(['instance', 'tenant']).notNull(),
        scopeId: str().notNull(),
        flag: str().notNull(),
        enabled: flag().notNull(),
        roles: json<Role[]>().notNull(),
        people: json<string[]>().notNull(),
        locked: flag().notNull(),
        // Retired (CB-503): kept 0 by flags migration 2's triggers, never
        // written or read here; a later contract migration drops it.
        optIn: flag().notNull().default(false),
        updatedBy: str().notNull(),
        updatedAt: ms().notNull(),
    },
    (t) => [primaryKey({ columns: [t.scope, t.scopeId, t.flag] })],
);

/** Retired (CB-503): emptied by flags migration 2, never written or read here. */
export const flagChoices = sqliteTable(
    'flag_choices',
    {
        userId: str().notNull(),
        flag: str().notNull(),
        enabled: flag().notNull(),
        updatedAt: ms().notNull(),
    },
    (t) => [primaryKey({ columns: [t.userId, t.flag] })],
);

export const flagTiers = sqliteTable('flag_tiers', {
    id: str().primaryKey(),
    name: str().notNull(),
    description: str().notNull(),
    flags: json<Record<string, boolean>>().notNull(),
    createdAt: ms().notNull(),
    updatedBy: str().notNull(),
    updatedAt: ms().notNull(),
});

export const flagTenantTiers = sqliteTable('flag_tenant_tiers', {
    tenantId: str().primaryKey(),
    tierId: str().notNull(),
    updatedBy: str().notNull(),
    updatedAt: ms().notNull(),
});

export const flagTables = [flagRules, flagChoices, flagTiers, flagTenantTiers];
