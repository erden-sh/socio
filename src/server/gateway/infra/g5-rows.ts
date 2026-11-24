import type { DatabaseSync } from 'node:sqlite';

/**
 * The SQL of the gateway's options (CB-239), on the shared connection.
 * Every write here runs inside the caller's `transaction()`
 * (docs/DATA-LAYER.md); nothing here opens one itself.
 */

/** Settings → Coding's switches (`gateway_options`). */
export class OptionRows {
    constructor(private db: DatabaseSync) {}
    get(key: string): string | undefined {
        const row = this.db.prepare('SELECT value FROM gateway_options WHERE key=?').get(key) as
            | { value: string }
            | undefined;
        return row?.value;
    }
    /** Saves a value, or removes it (`null`: back to the default). */
    set(key: string, value: string | null, by: string, at: number) {
        if (value === null) {
            this.db.prepare('DELETE FROM gateway_options WHERE key=?').run(key);
        } else {
            this.db
                .prepare(
                    `INSERT INTO gateway_options(key, value, updatedAt, updatedBy) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt, updatedBy=excluded.updatedBy`,
                )
                .run(key, value, at, by);
        }
    }
}
