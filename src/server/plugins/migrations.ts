import type { SchemaSet } from '@socio/data/migrate';

/**
 * Workspace plugins. `plugin_installs` is one row per installed plugin on
 * this instance (empty everywhere until an admin installs one). Launch
 * codes and sessions live here, not in memory, so a second replica of Socio
 * — and any replica of the plugin — can redeem and recognize them.
 */
export const pluginsSchema: SchemaSet = {
    id: 'plugins',
    migrations: [
        {
            version: 1,
            name: 'plugin installs',
            up: `CREATE TABLE plugin_installs(id TEXT PRIMARY KEY, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, display TEXT NOT NULL CHECK(display IN ('tab','embed')), config TEXT NOT NULL DEFAULT '{}', permissions TEXT NOT NULL DEFAULT '[]', manifest TEXT NOT NULL, replicas INTEGER NOT NULL DEFAULT 1, installedAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
CREATE TABLE plugin_codes(hash TEXT PRIMARY KEY, pluginId TEXT NOT NULL, userId TEXT NOT NULL, next TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
CREATE INDEX plugin_codes_plugin ON plugin_codes(pluginId);
CREATE TABLE plugin_sessions(hash TEXT PRIMARY KEY, pluginId TEXT NOT NULL, userId TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
CREATE INDEX plugin_sessions_plugin ON plugin_sessions(pluginId);`,
        },
        {
            version: 2,
            name: 'plugin session generation',
            up: `ALTER TABLE plugin_sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
CREATE TABLE plugin_access_generation(userId TEXT PRIMARY KEY, generation INTEGER NOT NULL);`,
        },
        {
            // CB-254. Who may use an installed plugin: admins (every install
            // before this one) or members too. Expand only: an older build
            // ignores the column and keeps treating the plugin as admin-only.
            version: 3,
            name: 'plugin audience',
            phase: 'expand',
            up: `ALTER TABLE plugin_installs ADD COLUMN audience TEXT NOT NULL DEFAULT 'admins' CHECK(audience IN ('admins','members'));`,
        },
        {
            // Each plugin's own identity token, hashed, by version (one
            // `current`; a `previous` one until `retireAt`, while the old
            // tasks drain; `retired` is never accepted). Rows are kept as the
            // record of what was issued. Expand only: an older build ignores
            // the table and keeps the shared service token.
            version: 4,
            name: 'plugin identity tokens',
            phase: 'expand',
            compatible:
                'Its unique indexes are on plugin_identities, a table it creates, which no older build uses (CB-108).',
            up: `CREATE TABLE plugin_identities(pluginId TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('current','previous','retired')), createdAt INTEGER NOT NULL, retireAt INTEGER, PRIMARY KEY(pluginId, version));
CREATE UNIQUE INDEX plugin_identities_hash ON plugin_identities(hash);
CREATE UNIQUE INDEX plugin_identities_current ON plugin_identities(pluginId) WHERE state='current';`,
        },
        {
            // CB-527: each installed plugin's release notes, read from its
            // manifest at install and update (at most 50 versions kept), the
            // version they were last read for, and the newest version each
            // person has seen of each plugin. Expand only: an older build
            // ignores the tables.
            version: 5,
            name: 'plugin release notes',
            phase: 'expand',
            up: `CREATE TABLE plugin_release_notes(pluginId TEXT NOT NULL, version TEXT NOT NULL, date TEXT NOT NULL, title TEXT, notes TEXT NOT NULL, recordedAt INTEGER NOT NULL, PRIMARY KEY(pluginId, version));
CREATE TABLE plugin_release_state(pluginId TEXT PRIMARY KEY, version TEXT NOT NULL, recordedAt INTEGER NOT NULL);
CREATE TABLE plugin_release_seen(userId TEXT NOT NULL, pluginId TEXT NOT NULL, version TEXT NOT NULL, seenAt INTEGER NOT NULL, PRIMARY KEY(userId, pluginId));
CREATE INDEX plugin_release_seen_plugin ON plugin_release_seen(pluginId);`,
        },
    ],
};
