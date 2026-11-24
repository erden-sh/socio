import { and, eq } from 'drizzle-orm';
import { sqliteTable } from 'drizzle-orm/sqlite-core';

import { str } from '@socio/data/columns.sqlite';
import type { SqliteData } from '@socio/data/open';

/**
 * The GitHub App's rows (`github.*` keys) still live in the key-value table
 * dispatch made (`dispatch/migrations.ts`), where release 2 saved them.
 * Dispatch is gone (CB-325) and nothing else reads or writes that table.
 * The later migration that drops the dispatch tables must first move these
 * rows to a table of the GitHub module's own.
 */
export const githubSettingsTable = sqliteTable('dispatch_settings', {
    key: str().primaryKey(),
    value: str().notNull(),
});

/** The GitHub App's key-value rows; every key starts with `github.`. */
export interface GitHubSettingsRepository {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
    /** Sets `key` to `next` only while it is still `current`; whether it did. */
    replace(key: string, current: string, next: string): Promise<boolean>;
}

const PREFIX = 'github.';
const own = (key: string) => {
    if (!key.startsWith(PREFIX)) {
        throw new Error(`Not a GitHub setting: ${key}`);
    }
    return key;
};

class SqliteGitHubSettings implements GitHubSettingsRepository {
    constructor(private data: SqliteData) {}

    private get db() {
        return this.data.uow.executor();
    }

    private write<T>(label: string, work: () => Promise<T>) {
        return this.data.uow.run(work, { label });
    }

    async get(key: string) {
        const row = await this.db
            .select({ value: githubSettingsTable.value })
            .from(githubSettingsTable)
            .where(eq(githubSettingsTable.key, own(key)))
            .get();
        return row?.value;
    }

    set(key: string, value: string) {
        return this.write('save GitHub setting', async () => {
            await this.db
                .insert(githubSettingsTable)
                .values({ key: own(key), value })
                .onConflictDoUpdate({ target: githubSettingsTable.key, set: { value } });
        });
    }

    remove(key: string) {
        return this.write('remove GitHub setting', async () => {
            await this.db.delete(githubSettingsTable).where(eq(githubSettingsTable.key, own(key)));
        });
    }

    replace(key: string, current: string, next: string) {
        return this.write('replace GitHub setting', async () => {
            const changed = await this.db
                .update(githubSettingsTable)
                .set({ value: next })
                .where(and(eq(githubSettingsTable.key, own(key)), eq(githubSettingsTable.value, current)))
                .returning({ key: githubSettingsTable.key });
            return changed.length > 0;
        });
    }
}

/**
 * The GitHub App's rows on a migrated connection's data layer; the settings
 * service (`layer.ts`) is built over them.
 */
export function sqliteGitHubSettings(data: SqliteData): GitHubSettingsRepository {
    return new SqliteGitHubSettings(data);
}
