import type { DatabaseSync } from 'node:sqlite';

import { migrate, type SchemaSet } from '@socio/data/migrate';

import { calendarSchema } from './calendar/migrations.js';
import { plannerSchema } from './planner/migrations.js';

/**
 * The tables of bundled plugins, by plugin id. They aren't in the module
 * registry (`modules/index.ts`): an instance only has a plugin's tables once
 * an admin installs it. So these are the two places a schema is conditional:
 * boot brings the installed ones up to date, and an install makes its own.
 */
const bundledPluginSchemas: Readonly<Record<string, SchemaSet>> = {
    'social-strategy': plannerSchema,
    calendar: calendarSchema,
};

/** Boot: the sets of the bundled plugins this database has installed. */
export function installedPluginSchemas(db: DatabaseSync): SchemaSet[] {
    return (db.prepare('SELECT id FROM plugin_installs').all() as { id: string }[]).flatMap(
        ({ id }) => bundledPluginSchemas[id] ?? [],
    );
}

/** An install at runtime: its tables, on the connection the install is on. */
export function migrateBundledPlugin(db: DatabaseSync, id: string) {
    const schema = bundledPluginSchemas[id];
    if (schema) {
        migrate(db, [schema]);
    }
}
