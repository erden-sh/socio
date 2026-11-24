import { and, eq, sql } from 'drizzle-orm';

import type { InferenceSettingsRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { inferenceSettings } from './schema.js';

/** The workspace's inference settings: key and value. */
export class SqliteInferenceSettings extends SqliteRepository implements InferenceSettingsRepository {
    /** Every turn reads the default backend and the allowed kinds: prepared once. */
    private valueQuery = this.data.uow
        .executor()
        .select({ value: inferenceSettings.value })
        .from(inferenceSettings)
        .where(eq(inferenceSettings.key, sql.placeholder('key')))
        .prepare();

    async get(key: string) {
        this.data.uow.executor();
        return (await this.valueQuery.get({ key }))?.value;
    }

    set(key: string, value: string) {
        return this.write('save inference setting', async () => {
            await this.db
                .insert(inferenceSettings)
                .values({ key, value })
                .onConflictDoUpdate({ target: inferenceSettings.key, set: { value } });
        });
    }

    remove(key: string) {
        return this.write('remove inference setting', async () => {
            await this.db.delete(inferenceSettings).where(eq(inferenceSettings.key, key));
        });
    }

    replace(key: string, current: string, next: string) {
        return this.write('replace inference setting', async () => {
            const changed = await this.db
                .update(inferenceSettings)
                .set({ value: next })
                .where(and(eq(inferenceSettings.key, key), eq(inferenceSettings.value, current)))
                .returning({ key: inferenceSettings.key });
            return changed.length > 0;
        });
    }
}
