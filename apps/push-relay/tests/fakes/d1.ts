// D1 for tests: the relay's migrations on node:sqlite in memory, with D1's prepare/bind/first/run
// shape. `broken` makes every query fail the way D1 does when its table is gone.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type { Database, Registration } from '../../src/registrations';

const MIGRATIONS = join(import.meta.dirname, '../../migrations');

export class FakeD1 implements Database {
    readonly sqlite = new DatabaseSync(':memory:');
    broken = false;
    /** Every statement run, in order. */
    readonly queries: string[] = [];
    /** Runs before each statement, so a test can pause one and interleave another request. */
    before: ((query: string) => Promise<void> | void) | undefined;

    constructor() {
        for (const file of readdirSync(MIGRATIONS)
            .filter((name) => name.endsWith('.sql'))
            .sort()) {
            this.sqlite.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
        }
    }

    prepare(query: string) {
        const check = async () => {
            this.queries.push(query);
            await this.before?.(query);
            if (this.broken) {
                throw new Error('D1_ERROR: no such table: registrations: SQLITE_ERROR');
            }
        };
        return {
            bind: (...values: unknown[]) => ({
                first: async <T = Record<string, unknown>>() => {
                    await check();
                    return ((this.sqlite.prepare(query).get(...(values as SQLInputValue[])) as T | undefined) ??
                        null) as T | null;
                },
                run: async () => {
                    await check();
                    const result = this.sqlite.prepare(query).run(...(values as SQLInputValue[]));
                    return { success: true, meta: { changes: Number(result.changes) } };
                },
            }),
        };
    }

    rows(): Registration[] {
        return this.sqlite.prepare('SELECT * FROM registrations ORDER BY id').all() as unknown as Registration[];
    }
}
