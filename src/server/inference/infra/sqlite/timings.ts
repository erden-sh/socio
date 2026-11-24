import { and, desc, eq, notInArray, sql } from 'drizzle-orm';

import type { InferenceTimingRepository, StoredTiming } from '../../domain/repositories.js';

import { insertionOrder, SqliteRepository } from './base.js';
import { inferenceTimings } from './schema.js';

/** Response times per model; a key keeps its latest samples only. */
export class SqliteInferenceTimings extends SqliteRepository implements InferenceTimingRepository {
    /** Each model round of a turn reads them for its estimate: prepared once. */
    private latestQuery = this.data.uow
        .executor()
        .select({
            round: inferenceTimings.round,
            promptChars: inferenceTimings.promptChars,
            promptTokens: inferenceTimings.promptTokens,
            uncachedTokens: inferenceTimings.uncachedTokens,
            ttftMs: inferenceTimings.ttftMs,
        })
        .from(inferenceTimings)
        .where(eq(inferenceTimings.key, sql.placeholder('key')))
        .orderBy(desc(inferenceTimings.at), desc(insertionOrder(inferenceTimings)))
        .limit(sql.placeholder('limit'))
        .prepare();

    add(sample: StoredTiming, keep: number) {
        return this.write('record response time', async () => {
            await this.db.insert(inferenceTimings).values(sample);
            const kept = this.db
                .select({ rowid: insertionOrder(inferenceTimings) })
                .from(inferenceTimings)
                .where(eq(inferenceTimings.key, sample.key))
                .orderBy(desc(inferenceTimings.at), desc(insertionOrder(inferenceTimings)))
                .limit(keep);
            await this.db
                .delete(inferenceTimings)
                .where(and(eq(inferenceTimings.key, sample.key), notInArray(insertionOrder(inferenceTimings), kept)));
        });
    }

    async latest(key: string, limit: number) {
        this.data.uow.executor();
        return this.latestQuery.all({ key, limit });
    }
}
