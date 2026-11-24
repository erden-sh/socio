import { and, count, desc, eq, gte, lt, lte, max, ne, sql } from 'drizzle-orm';

import type { AppLogRetention } from '@socio/shared/apps/app-log-retention';
import type { AppAttemptSummary } from '@socio/shared/apps/app-types';
import type { RuntimeAttempt } from '@socio/shared/apps/apps-runtime-types';

import { ATTEMPTS_PER_APP, boundLog } from '../../domain/attempts.js';
import type { AppAttemptRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { apps, appAttempts, appAttempts as a } from './schema.js';

type AttemptRow = typeof a.$inferSelect;

const summary = (row: AttemptRow): AppAttemptSummary => ({
    attempt: row.attempt,
    version: row.version,
    kind: row.kind,
    state: row.state,
    reason: row.reason,
    exitCode: row.exitCode,
    signal: row.signal,
    message: row.message,
    startedAt: row.startedAt,
    upAt: row.upAt,
    endedAt: row.endedAt,
});

/** When an attempt ended, or started if it hasn't. */
const endedOrStarted = sql<number>`coalesce(${a.endedAt}, ${a.startedAt})`;

/** The build and start attempts of promoted apps (CB-146). */
export class SqliteAppAttempts extends SqliteRepository implements AppAttemptRepository {
    async oomsByDot(from: number, to: number) {
        return this.db
            .select({
                dotId: apps.dotId,
                count: count(),
                lastAt: sql<number>`max(${endedOrStarted})`.mapWith(Number),
            })
            .from(a)
            .innerJoin(apps, eq(apps.id, a.appId))
            .where(
                and(
                    // A literal, so the partial index `app_attempts_oom_time` (its
                    // WHERE is reason='oom') stays usable.
                    sql`${a.reason} = 'oom'`,
                    gte(endedOrStarted, from),
                    lt(endedOrStarted, to),
                ),
            )
            .groupBy(apps.dotId);
    }

    sync(appId: string, boot: string, reported: RuntimeAttempt[], now = Date.now()) {
        return this.write('sync app attempts', async () => {
            const known = new Map(
                (
                    await this.db
                        .select({
                            runtimeId: a.runtimeId,
                            attempt: a.attempt,
                            state: a.state,
                        })
                        .from(a)
                        .where(eq(a.appId, appId))
                ).map((row) => [row.runtimeId, row]),
            );
            const newest = await this.db
                .select({ startedAt: max(a.startedAt), attempt: max(a.attempt) })
                .from(a)
                .where(eq(a.appId, appId))
                .get();
            // Attempts the runtime still lists but `prune` removed are older than
            // the newest stored one: they must not come back as new ones.
            const newestStart = newest?.startedAt ?? null;
            let next = (newest?.attempt ?? 0) + 1;
            const seen = new Set<string>();
            for (const item of [...reported].sort((x, y) => x.startedAt - y.startedAt)) {
                seen.add(item.id);
                const { log, cut } = boundLog(item.lines);
                const values = {
                    state: item.state,
                    reason: item.exit?.reason ?? null,
                    exitCode: item.exit?.code ?? null,
                    signal: item.exit?.signal ?? null,
                    message: item.exit?.message ?? null,
                    log,
                    dropped: item.dropped + cut,
                    upAt: item.upAt,
                    endedAt: item.endedAt,
                    updatedAt: now,
                };
                const row = known.get(item.id);
                if (!row && newestStart !== null && item.startedAt < newestStart) {
                    continue;
                }
                if (row) {
                    // While the runtime has it, it is right (output can trail an exit).
                    await this.db
                        .update(a)
                        .set(values)
                        .where(and(eq(a.appId, appId), eq(a.attempt, row.attempt)));
                    continue;
                }
                await this.db.insert(a).values({
                    ...values,
                    appId,
                    attempt: next++,
                    runtimeId: item.id,
                    version: item.version,
                    kind: item.kind,
                    startedAt: item.startedAt,
                });
            }
            for (const [runtimeId, row] of known) {
                if (row.state === 'running' && !seen.has(runtimeId)) {
                    await this.db
                        .update(a)
                        .set({
                            state: 'stopped',
                            reason: 'lost',
                            message:
                                boot && runtimeId.startsWith(`${boot}:`)
                                    ? 'The runtime no longer keeps this attempt (newer ones took its place); how it ended wasn’t seen.'
                                    : 'The runtime restarted before this attempt ended; how it ended is unknown.',
                            endedAt: now,
                            updatedAt: now,
                        })
                        .where(and(eq(a.appId, appId), eq(a.attempt, row.attempt)));
                }
            }
            // Bounded: the newest per app stay (retention is `prune`'s).
            await this.dropPast(appId, ATTEMPTS_PER_APP);
        });
    }

    /**
     * Drops the app's attempts that are not among its newest `kept` (by
     * number, running ones counted), unless running, or `before` is given and
     * they ended (or started) at or after it. How many went.
     */
    private async dropPast(appId: string, kept: number, before?: number) {
        const edge = await this.db
            .select({ attempt: a.attempt })
            .from(a)
            .where(eq(a.appId, appId))
            .orderBy(desc(a.attempt))
            .limit(1)
            .offset(kept)
            .get();
        if (!edge) {
            return 0;
        }
        const { changes } = await this.db
            .delete(appAttempts)
            .where(
                and(
                    eq(a.appId, appId),
                    ne(a.state, 'running'),
                    lte(a.attempt, edge.attempt),
                    before === undefined ? undefined : lt(endedOrStarted, before),
                ),
            );
        return Number(changes);
    }

    prune(retention: AppLogRetention, now = Date.now()) {
        const cutoff = now - retention.days * 86_400_000;
        return this.write('prune app attempts', async () => {
            let dropped = 0;
            for (const { appId } of await this.db.selectDistinct({ appId: a.appId }).from(a)) {
                dropped += await this.dropPast(appId, retention.attempts, cutoff);
            }
            return dropped;
        });
    }

    async find(appId: string, query: { version?: number; attempt?: number } = {}) {
        const row = await this.db
            .select()
            .from(a)
            .where(
                and(
                    eq(a.appId, appId),
                    query.attempt !== undefined
                        ? eq(a.attempt, query.attempt)
                        : query.version !== undefined
                          ? eq(a.version, query.version)
                          : undefined,
                ),
            )
            .orderBy(desc(a.attempt))
            .limit(1)
            .get();
        if (!row) {
            return undefined;
        }
        return {
            ...summary(row),
            lines: row.log ? row.log.split('\n') : [],
            dropped: row.dropped,
        };
    }

    async list(appId: string, limit = ATTEMPTS_PER_APP) {
        const rows = await this.db.select().from(a).where(eq(a.appId, appId)).orderBy(desc(a.attempt)).limit(limit);
        return rows.map(summary);
    }

    rekey(from: string, to: string) {
        return this.write('rekey app attempts', async () => {
            await this.db.update(a).set({ appId: to }).where(eq(a.appId, from));
        });
    }
}
