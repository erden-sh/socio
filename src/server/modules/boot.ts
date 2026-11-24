import { migrateDatabase, MigrationError } from '@socio/data/migrate';

import { installedPluginSchemas } from '../plugins/plugin-schemas.js';

import { schemas } from './index.js';

/**
 * The one step that migrates the app's database: every process that opens
 * it for writing runs this first (the server, the auth CLI), so constructors
 * take a database that is already migrated and never migrate one themselves.
 * It refuses a database from a newer build and backs up one that has tables
 * before writing to it. Installed plugins' sets follow the registry's, whose
 * `plugin_installs` table says which those are.
 */
export function bootDatabase(
    path: string,
    options: {
        backupDirectory: string;
        keep?: number;
        log?: (line: string) => void;
    },
) {
    // Every connection to `:memory:` is its own empty database, and the server
    // opens several, so the stores would find no tables.
    if (path === ':memory:') {
        throw new MigrationError('DATABASE_PATH must be a file: each connection to :memory: is a separate database.');
    }
    return migrateDatabase(path, schemas, { ...options, conditional: installedPluginSchemas });
}
