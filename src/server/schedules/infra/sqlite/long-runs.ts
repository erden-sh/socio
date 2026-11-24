import { and, asc, count, desc, eq, gte, inArray, isNull, lte, min, not, or, sql, sum } from 'drizzle-orm';

import type { LongRunRow } from '../../contract.js';
import type { FailResult, ItemCounts, LongRunPatch, LongRunRepository, NewLongRun } from '../../domain/repositories.js';

import { SqliteRepository, insertionOrder } from './base.js';
import { jobItems, jobLongRuns } from './schema.js';

const OPEN = inArray(jobLongRuns.status, ['running', 'waiting']);

/** Long runs and their items (CB-122), on the shared SQLite connection. */
export class SqliteLongRuns extends SqliteRepository implements LongRunRepository {
    create(row: NewLongRun) {
        return this.write('start long run', async () => {
            const open = await this.open(row.jobId);
            if (open) {
                return open;
            }
            await this.db.insert(jobLongRuns).values({
                ...row,
                status: 'waiting',
                batches: 0,
                retries: 0,
                sealed: 0,
                completed: 0,
                nextAt: row.createdAt,
                updatedAt: row.createdAt,
            });
            return (await this.get(row.id))!;
        });
    }

    async get(id: string): Promise<LongRunRow | undefined> {
        return this.db.select().from(jobLongRuns).where(eq(jobLongRuns.id, id)).get();
    }

    async open(jobId: string) {
        return this.db
            .select()
            .from(jobLongRuns)
            .where(and(eq(jobLongRuns.jobId, jobId), OPEN))
            .get();
    }

    async latest(jobId: string) {
        return this.db
            .select()
            .from(jobLongRuns)
            .where(eq(jobLongRuns.jobId, jobId))
            .orderBy(desc(jobLongRuns.createdAt), desc(insertionOrder(jobLongRuns)))
            .limit(1)
            .get();
    }

    async openRuns() {
        return this.db
            .select()
            .from(jobLongRuns)
            .where(OPEN)
            .orderBy(asc(jobLongRuns.createdAt), asc(insertionOrder(jobLongRuns)))
            .all();
    }

    async unreported(since: number) {
        return this.db
            .select()
            .from(jobLongRuns)
            .where(and(not(OPEN), isNull(jobLongRuns.reportedAt), gte(jobLongRuns.finishedAt, since)))
            .orderBy(asc(jobLongRuns.finishedAt))
            .all();
    }

    update(id: string, patch: LongRunPatch, now: number) {
        return this.write('update long run', async () => {
            await this.db
                .update(jobLongRuns)
                .set({ ...patch, updatedAt: now })
                .where(eq(jobLongRuns.id, id));
        });
    }

    addItems(longRunId: string, keys: string[], now: number) {
        return this.write('add long run items', async () => {
            let added = 0;
            for (const key of keys) {
                const { changes } = await this.db
                    .insert(jobItems)
                    .values({
                        longRunId,
                        key,
                        status: 'pending',
                        attempts: 0,
                        updatedAt: now,
                    })
                    .onConflictDoNothing({ target: [jobItems.longRunId, jobItems.key] })
                    .run();
                added += Number(changes);
            }
            return added;
        });
    }

    claim(longRunId: string, batchId: string, limit: number, now: number) {
        return this.write('claim long run items', async () => {
            const rows = await this.db
                .select({ id: jobItems.id, key: jobItems.key })
                .from(jobItems)
                .where(
                    and(
                        eq(jobItems.longRunId, longRunId),
                        eq(jobItems.status, 'pending'),
                        or(isNull(jobItems.nextAt), lte(jobItems.nextAt, now)),
                    ),
                )
                .orderBy(asc(jobItems.id))
                .limit(limit)
                .all();
            for (const row of rows) {
                await this.db
                    .update(jobItems)
                    .set({
                        status: 'claimed',
                        claimedBy: batchId,
                        attempts: sql`${jobItems.attempts} + 1`,
                        updatedAt: now,
                    })
                    .where(eq(jobItems.id, row.id));
            }
            return rows.map((row) => row.key);
        });
    }

    private state(longRunId: string, key: string) {
        return this.db
            .select({
                status: jobItems.status,
                claimedBy: jobItems.claimedBy,
                attempts: jobItems.attempts,
            })
            .from(jobItems)
            .where(and(eq(jobItems.longRunId, longRunId), eq(jobItems.key, key)))
            .get();
    }

    done(longRunId: string, batchId: string, key: string, now: number) {
        return this.write('long run item done', async () => {
            const { changes } = await this.db
                .update(jobItems)
                .set({
                    status: 'done',
                    claimedBy: null,
                    error: null,
                    doneAt: now,
                    updatedAt: now,
                })
                .where(
                    and(
                        eq(jobItems.longRunId, longRunId),
                        eq(jobItems.key, key),
                        eq(jobItems.status, 'claimed'),
                        eq(jobItems.claimedBy, batchId),
                    ),
                )
                .run();
            if (Number(changes)) {
                return 'done' as const;
            }
            const item = await this.state(longRunId, key);
            return !item
                ? ('unknown' as const)
                : item.status === 'done'
                  ? ('already' as const)
                  : ('not_claimed' as const);
        });
    }

    fail(
        longRunId: string,
        batchId: string,
        key: string,
        options: Parameters<LongRunRepository['fail']>[3],
        now: number,
    ): Promise<FailResult> {
        return this.write('long run item failed', async () => {
            const item = await this.state(longRunId, key);
            if (!item) {
                return 'unknown';
            }
            if (item.status === 'done' || item.status === 'dead') {
                return 'already';
            }
            if (item.status !== 'claimed' || item.claimedBy !== batchId) {
                return 'not_claimed';
            }
            const error = options.error.slice(0, 500);
            const set = (status: 'pending' | 'dead', attempts: number, nextAt: number | null) =>
                this.db
                    .update(jobItems)
                    .set({
                        status,
                        claimedBy: null,
                        attempts,
                        nextAt,
                        error,
                        updatedAt: now,
                    })
                    .where(and(eq(jobItems.longRunId, longRunId), eq(jobItems.key, key)))
                    .run();
            if (options.refund) {
                await set('pending', Math.max(0, item.attempts - 1), null);
                return 'refunded';
            }
            if (!options.retry || item.attempts >= options.maxAttempts) {
                await set('dead', item.attempts, null);
                return 'dead';
            }
            await set('pending', item.attempts, now + options.waitMs(item.attempts));
            return 'retry';
        });
    }

    release(longRunId: string, batchId: string, options: Parameters<LongRunRepository['release']>[2], now: number) {
        return this.write('release long run items', async () => {
            const held = await this.db
                .select({ id: jobItems.id, attempts: jobItems.attempts })
                .from(jobItems)
                .where(
                    and(
                        eq(jobItems.longRunId, longRunId),
                        eq(jobItems.status, 'claimed'),
                        eq(jobItems.claimedBy, batchId),
                    ),
                )
                .orderBy(asc(jobItems.id))
                .all();
            let dead = 0;
            for (const [index, item] of held.entries()) {
                // A batch works through its items in claim order: the first one
                // it still held is the one it was on when it failed, and is
                // charged its try; the others weren't reached and cost nothing.
                if (options.refund || index > 0) {
                    await this.db
                        .update(jobItems)
                        .set({
                            status: 'pending',
                            claimedBy: null,
                            attempts: sql`MAX(0, ${jobItems.attempts} - 1)`,
                            updatedAt: now,
                        })
                        .where(eq(jobItems.id, item.id));
                    continue;
                }
                const out = item.attempts >= options.maxAttempts;
                if (out) {
                    dead++;
                }
                await this.db
                    .update(jobItems)
                    .set({
                        status: out ? 'dead' : 'pending',
                        claimedBy: null,
                        nextAt: out ? null : now + options.waitMs(item.attempts),
                        error: options.error.slice(0, 500),
                        updatedAt: now,
                    })
                    .where(eq(jobItems.id, item.id));
            }
            return { released: held.length - dead, dead };
        });
    }

    async counts(longRunId: string): Promise<ItemCounts> {
        const counts = {
            pending: 0,
            claimed: 0,
            done: 0,
            dead: 0,
            total: 0,
            tries: 0,
        };
        for (const row of await this.db
            .select({
                status: jobItems.status,
                n: count(),
                tries: sum(jobItems.attempts).mapWith(Number),
            })
            .from(jobItems)
            .where(eq(jobItems.longRunId, longRunId))
            .groupBy(jobItems.status)
            .all()) {
            counts[row.status] = row.n;
            counts.total += row.n;
            counts.tries += row.tries ?? 0;
        }
        return counts;
    }

    async dead(longRunId: string, limit: number) {
        const rows = await this.db
            .select({
                key: jobItems.key,
                error: jobItems.error,
                attempts: jobItems.attempts,
                at: jobItems.updatedAt,
            })
            .from(jobItems)
            .where(and(eq(jobItems.longRunId, longRunId), eq(jobItems.status, 'dead')))
            .orderBy(desc(jobItems.updatedAt), desc(jobItems.id))
            .limit(limit)
            .all();
        return rows;
    }

    async nextDue(longRunId: string) {
        const row = await this.db
            .select({
                n: count(),
                due: min(sql<number>`COALESCE(${jobItems.nextAt}, 0)`),
            })
            .from(jobItems)
            .where(and(eq(jobItems.longRunId, longRunId), eq(jobItems.status, 'pending')))
            .get();
        return row?.n ? Number(row.due ?? 0) : null;
    }
}
