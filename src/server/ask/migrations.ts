import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * The "Ask a socio" panel's tables (CB-26). `context_threads` binds one
 * conversation to each (item, socio, person), like `page_threads` does for
 * a page's own conversation, for every kind of item the panel knows; the
 * row says nothing about access, which is checked again on every use.
 * `ask_preferences` keeps the socio the person last asked.
 */
export const askSchema: SchemaSet = {
    id: MODULE_IDS.ask,
    migrations: [
        {
            version: 1,
            name: 'context threads',
            up: `CREATE TABLE context_threads(contextKind TEXT NOT NULL, contextId TEXT NOT NULL, dotId TEXT NOT NULL, userId TEXT NOT NULL, threadId TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, PRIMARY KEY(contextKind, contextId, dotId, userId));
        CREATE TABLE ask_preferences(userId TEXT PRIMARY KEY, dotId TEXT NOT NULL, updatedAt INTEGER NOT NULL);`,
        },
    ],
};
