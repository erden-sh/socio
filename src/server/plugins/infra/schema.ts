import { sqliteTable } from 'drizzle-orm/sqlite-core';

import { enumText, flag, id, int, json, ms, str } from '@socio/data/columns.sqlite';
import type { PluginManifest } from '@socio/shared/plugins/plugins';

/** The typed mirror of `plugins/migrations.ts`. */
export const pluginInstalls = sqliteTable('plugin_installs', {
    id: id().primaryKey(),
    version: str().notNull(),
    enabled: flag().notNull(),
    display: enumText(['tab', 'embed']).notNull(),
    config: json<Record<string, string>>().notNull(),
    permissions: json<string[]>().notNull(),
    manifest: json<PluginManifest>().notNull(),
    replicas: int().notNull(),
    audience: enumText(['admins', 'members']).notNull().default('admins'),
    installedAt: ms().notNull(),
    updatedAt: ms().notNull(),
});

export const pluginCodes = sqliteTable('plugin_codes', {
    hash: str().primaryKey(),
    pluginId: str().notNull(),
    userId: str().notNull(),
    next: str().notNull(),
    createdAt: ms().notNull(),
    expiresAt: ms().notNull(),
});

export const pluginSessions = sqliteTable('plugin_sessions', {
    hash: str().primaryKey(),
    pluginId: str().notNull(),
    userId: str().notNull(),
    createdAt: ms().notNull(),
    expiresAt: ms().notNull(),
    generation: int().notNull(),
});

/** Bumped when plugin sessions and launch codes for a person are ended. */
export const pluginAccessGeneration = sqliteTable('plugin_access_generation', {
    userId: str().primaryKey(),
    generation: int().notNull(),
});
