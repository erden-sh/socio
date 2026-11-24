import { and, desc, eq, gte, like, lt, sql } from 'drizzle-orm';

import type { SqliteData } from '@socio/data/open';
import {
    RESOURCE_METRICS,
    type ResourceHistory,
    type ResourceMetric,
    type ResourceSample,
} from '@socio/shared/operations/operations-resources';

import { opsSamples, opsSamplesHourly } from './schema.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export class StaleResourceSample extends Error {}

/** The scopes with a sample at exactly `at` whose id starts with `prefix` (CB-321's per-service samples). */
export async function scopesSampledAt(data: SqliteData, prefix: string, at: number, limit = 500): Promise<string[]> {
    const rows = await data.uow
        .executor()
        .select({ scopeId: opsSamples.scopeId })
        .from(opsSamples)
        .where(and(eq(opsSamples.at, at), like(opsSamples.scopeId, `${prefix}%`)))
        .limit(limit)
        .all();
    // LIKE's wildcards in a prefix would match more: check it exactly.
    return rows.map((row) => row.scopeId).filter((scopeId) => scopeId.startsWith(prefix));
}

/** App-owned sample history; shares the writer queue with all workspace data. */
export class SqliteResourceSamples<Metric extends string = ResourceMetric> {
    constructor(
        private data: SqliteData,
        private scopeId = '',
        private metrics: Readonly<Record<Metric, string>> = RESOURCE_METRICS as unknown as Readonly<
            Record<Metric, string>
        >,
    ) {}
    private get db() {
        return this.data.uow.executor();
    }

    async latest() {
        const row = await this.db
            .select()
            .from(opsSamples)
            .where(eq(opsSamples.scopeId, this.scopeId))
            .orderBy(desc(opsSamples.at))
            .limit(1)
            .get();
        return row ? { at: row.at, values: row.data as Record<Metric, number | null> } : null;
    }
    async dailyCollectedSince(at: number) {
        return (
            await this.db
                .select()
                .from(opsSamples)
                .where(and(eq(opsSamples.scopeId, this.scopeId), gte(opsSamples.at, at)))
                .all()
        ).some((row) => row.data.datasetBytes !== null);
    }
    record(sample: ResourceSample<Metric>, keepDays: number, current: () => boolean = () => true) {
        return this.data.uow.run(
            async () => {
                if (!current()) {
                    return false;
                }
                await this.db
                    .insert(opsSamples)
                    .values({
                        scopeId: this.scopeId,
                        at: sample.at,
                        data: sample.values,
                    })
                    .onConflictDoUpdate({
                        target: [opsSamples.scopeId, opsSamples.at],
                        set: { data: sample.values },
                    });
                const hour = Math.floor(sample.at / HOUR) * HOUR;
                const rows = await this.db
                    .select()
                    .from(opsSamples)
                    .where(
                        and(
                            eq(opsSamples.scopeId, this.scopeId),
                            gte(opsSamples.at, hour),
                            lt(opsSamples.at, hour + HOUR),
                        ),
                    )
                    .all();
                const values = Object.fromEntries(
                    (Object.keys(this.metrics) as Metric[]).map((key) => {
                        const observed = rows.flatMap((row) => (row.data[key] == null ? [] : [row.data[key]!]));
                        return [
                            key,
                            observed.length ? observed.reduce((sum, value) => sum + value, 0) / observed.length : null,
                        ];
                    }),
                ) as Record<Metric, number | null>;
                const observedAt = Object.fromEntries(
                    (Object.keys(this.metrics) as Metric[]).map((key) => {
                        const times = rows.flatMap((row) => (row.data[key] == null ? [] : [row.at]));
                        return [key, times.length ? Math.max(...times) : null];
                    }),
                ) as Record<Metric, number | null>;
                await this.db
                    .insert(opsSamplesHourly)
                    .values({
                        scopeId: this.scopeId,
                        at: hour,
                        samples: rows.length,
                        data: values,
                        observedAt,
                    })
                    .onConflictDoUpdate({
                        target: [opsSamplesHourly.scopeId, opsSamplesHourly.at],
                        set: { samples: rows.length, data: values, observedAt },
                    });
                // Never delete any source records (especially agent_runs); zero skips pruning.
                if (keepDays > 0) {
                    const cutoff = sample.at - keepDays * DAY;
                    await this.db.delete(opsSamples).where(lt(opsSamples.at, cutoff));
                    await this.db
                        .delete(opsSamplesHourly)
                        .where(lt(opsSamplesHourly.at, Math.floor(cutoff / HOUR) * HOUR));
                }
                if (!current()) {
                    throw new StaleResourceSample('The computer stopped while collecting measurements.');
                }
                return true;
            },
            { label: 'record resource sample' },
        );
    }
    async history(now: number, intervalSeconds: number): Promise<ResourceHistory<Metric>> {
        const observedColumns = Object.fromEntries(
            (Object.keys(this.metrics) as Metric[]).map((key) => [
                key,
                sql<number | null>`MAX(json_extract(${opsSamplesHourly.observedAt}, ${'$.'.concat(key)}))`.as(key),
            ]),
        );
        const [latest, rows, observed] = await Promise.all([
            this.latest(),
            this.db
                .select()
                .from(opsSamplesHourly)
                .where(eq(opsSamplesHourly.scopeId, this.scopeId))
                .orderBy(desc(opsSamplesHourly.at))
                .limit(744)
                .all(),
            this.db
                .select(observedColumns)
                .from(opsSamplesHourly)
                .where(eq(opsSamplesHourly.scopeId, this.scopeId))
                .get(),
        ]);
        const gaps = (Object.keys(this.metrics) as Metric[]).flatMap((metric) => {
            const lastAt = observed?.[metric] ?? null;
            const daily = ['userdataBytes', 'datasetBytes', 'fileBytes', 'mediaBytes'].includes(metric);
            const stale = lastAt === null || now - lastAt > (daily ? 2 * DAY : 3 * intervalSeconds * 1000);
            return stale
                ? [
                      {
                          metric,
                          label: this.metrics[metric],
                          lastAt,
                          state: lastAt === null ? ('missing' as const) : ('stale' as const),
                      },
                  ]
                : [];
        });
        return {
            latest,
            hourly: rows.reverse().map((row) => ({
                at: row.at,
                samples: row.samples,
                values: row.data as Record<Metric, number | null>,
                observedAt: row.observedAt as Record<Metric, number | null>,
            })),
            gaps,
            collectedEverySeconds: intervalSeconds,
        };
    }
}
