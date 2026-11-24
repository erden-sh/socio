import type { DatabaseSync } from 'node:sqlite';

/** One day's row of the search timing rollup (`page_search_daily`). */
export interface SearchDay {
    /** The UTC date, `YYYY-MM-DD`. */
    day: string;
    queries: number;
    empty: number;
    corrected: number;
    trigram: number;
    maxMs: number;
    /** Bucket → count, as JSON text. */
    histogram: string;
    /** The index's sizes when the day's first searches were written, as JSON text. */
    sizes: string | null;
}

const dayOf = (row: Record<string, unknown>): SearchDay => ({
    day: String(row.day),
    queries: Number(row.queries),
    empty: Number(row.empty),
    corrected: Number(row.corrected),
    trigram: Number(row.trigram),
    maxMs: Number(row.maxMs),
    histogram: String(row.histogram),
    sizes: row.sizes === null || row.sizes === undefined ? null : String(row.sizes),
});

/**
 * The page search's timing rollup, kept with the FTS5
 * index it measures: a SQLite adapter with raw SQL (CB-110),
 * and synchronous, because the search that records timings and the
 * shutdown that writes the last ones can't wait. Its caller writes only
 * when the connection is free (`uow.writable`), never inside another
 * chain's unit of work. A Postgres store would bring its own.
 */
export class SqliteSearchStats {
    constructor(private db: DatabaseSync) {}

    day(day: string): SearchDay | undefined {
        const row = this.db.prepare('SELECT * FROM page_search_daily WHERE day = ?').get(day);
        return row ? dayOf(row) : undefined;
    }

    /** The newest `limit` days, newest first. */
    latest(limit: number): SearchDay[] {
        return this.db.prepare('SELECT * FROM page_search_daily ORDER BY day DESC LIMIT ?').all(limit).map(dayOf);
    }

    /**
     * Writes these days over the stored ones and forgets the days before
     * `pruneBefore`, all or nothing (a savepoint inside an open transaction).
     */
    save(days: readonly SearchDay[], pruneBefore?: string) {
        const write = this.db.prepare(
            'INSERT INTO page_search_daily(day, queries, empty, corrected, trigram, maxMs, histogram, sizes) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET queries=excluded.queries, empty=excluded.empty, corrected=excluded.corrected, trigram=excluded.trigram, maxMs=excluded.maxMs, histogram=excluded.histogram, sizes=excluded.sizes',
        );
        this.db.exec('SAVEPOINT page_search_daily');
        try {
            for (const row of days) {
                write.run(
                    row.day,
                    row.queries,
                    row.empty,
                    row.corrected,
                    row.trigram,
                    row.maxMs,
                    row.histogram,
                    row.sizes,
                );
            }
            if (pruneBefore !== undefined) {
                this.db.prepare('DELETE FROM page_search_daily WHERE day < ?').run(pruneBefore);
            }
            this.db.exec('RELEASE page_search_daily');
        } catch (error) {
            this.db.exec('ROLLBACK TO page_search_daily; RELEASE page_search_daily');
            throw error;
        }
    }
}
