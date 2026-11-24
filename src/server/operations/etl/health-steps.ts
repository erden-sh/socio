import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { listValue } from '@duckdb/node-api';

import { goalState, scheduleState, type ScheduleState } from '@socio/shared/operations/operations-health';

import type { EtlStep } from '../infra/duckdb/etl.js';
import { rows } from '../infra/duckdb/open.js';
import { sqliteHealthSourceReader } from '../infra/sqlite/health-source-reader.js';

import { append, appendTyped, type Cell, type TypedCell } from './append.js';
import { JOB_RUN_DDL, SNAPSHOT_DDL, TASK_RUN_DDL } from './health-schema.js';
import type { HealthSourceReader, KeysetMark, SourceJobRun, SourceTaskRun } from './health-source.js';
import { ETL_BATCH } from './source-reader.js';

const DAY = 86_400_000;

/**
 * Where a keyset copy got to: every row up to `(at, id)` has been read,
 * and `open` are the ones that hadn't finished, read again until they do
 * (as the turns' `RunsWatermark`).
 */
export interface KeysetWatermark extends KeysetMark {
    open: string[];
}

export function readKeysetWatermark(text: string | null): KeysetWatermark {
    const start = { at: -1, id: '', open: [] };
    if (!text) {
        return start;
    }
    try {
        const value = JSON.parse(text) as Partial<KeysetWatermark>;
        return {
            at: Number.isFinite(value.at) ? value.at! : -1,
            id: typeof value.id === 'string' ? value.id : '',
            open: Array.isArray(value.open) ? value.open.filter((id) => typeof id === 'string') : [],
        };
    } catch {
        return start;
    }
}

/** Reads in one short read transaction, as every ETL read is. */
function reading<T>(sqlite: DatabaseSync, read: () => T): T {
    sqlite.exec('BEGIN');
    try {
        return read();
    } finally {
        sqlite.exec('COMMIT');
    }
}

/**
 * A table copied by a keyset over (time, id) that never changes once set
 * (a run's queue or start time), re-reading the rows still open. Each
 * batch deletes the rows it read and appends them again: idempotent.
 * `reader` is the port it reads through (Health's, or CB-218's cycles);
 * `typed` appends numbers as DOUBLEs and BigInts as BIGINTs.
 */
export function keysetStep<R extends { id: string }, P = HealthSourceReader>(
    spec: {
        source: string;
        ddl: string;
        table: string;
        reader: (sqlite: DatabaseSync) => P;
        ready: (reader: P) => boolean;
        after: (reader: P, mark: KeysetMark) => R[];
        byId: (reader: P, ids: readonly string[]) => R[];
        at: (row: R) => number;
        open: (row: R) => boolean;
    } & ({ cells: (row: R) => Cell[]; typed?: undefined } | { cells: (row: R) => TypedCell[]; typed: true }),
): EtlStep {
    return {
        source: spec.source,
        ddl: [spec.ddl],
        async batch({ sqlite, duck, watermark, context }) {
            const reader = spec.reader(sqlite);
            const state = readKeysetWatermark(watermark);
            if (!spec.ready(reader)) {
                return { caughtUp: true };
            }
            const { fresh, again } = reading(sqlite, () => {
                const fresh = spec.after(reader, state);
                return {
                    fresh,
                    again: fresh.length < ETL_BATCH ? spec.byId(reader, state.open) : [],
                };
            });
            const reread = fresh.length < ETL_BATCH;
            const seen = new Set(fresh.map((row) => row.id));
            const read = [...fresh, ...again.filter((row) => !seen.has(row.id))];
            const cutoff = context.settings.factDays ? context.now - context.settings.factDays * DAY : -Infinity;
            const ids = [...new Set([...read.map((row) => row.id), ...(reread ? state.open : [])])];
            if (ids.length) {
                await duck.run(`DELETE FROM ${spec.table} WHERE id IN (SELECT unnest($1))`, [listValue(ids)]);
                const kept = read.filter((row) => spec.at(row) >= cutoff);
                if (spec.typed) {
                    await appendTyped(duck, spec.table, kept.map(spec.cells));
                } else {
                    await append(duck, spec.table, kept.map(spec.cells));
                }
            }
            const last = fresh.at(-1);
            const next: KeysetWatermark = {
                at: last ? spec.at(last) : state.at,
                id: last ? last.id : state.id,
                open: [...new Set([...(reread ? [] : state.open), ...read.filter(spec.open).map((row) => row.id)])],
            };
            return { watermark: JSON.stringify(next), caughtUp: reread };
        },
    };
}

const JOB_OPEN = new Set(['queued', 'starting', 'running']);

/** Job runs (CB-192): queue wait and wake time, by `queuedAt`. */
export const jobRunsStep = keysetStep<SourceJobRun>({
    source: 'job_runs',
    ddl: JOB_RUN_DDL,
    table: 'f_job_run',
    reader: sqliteHealthSourceReader,
    ready: (reader) => reader.hasJobs(),
    after: (reader, mark) => reader.jobRunsAfter(mark, ETL_BATCH),
    byId: (reader, ids) => reader.jobRunsById(ids),
    at: (run) => run.queuedAt,
    open: (run) => JOB_OPEN.has(run.status),
    cells: (run) => [
        run.id,
        run.jobId,
        run.dotId,
        run.userId,
        run.trigger,
        run.scheduleId,
        run.longRunId,
        run.status,
        run.queuedAt,
        run.startedAt,
        run.wakeMs,
        run.finishedAt,
    ],
});

/** Schedules' runs (CB-192): how late each started, by `startedAt`. */
export const taskRunsStep = keysetStep<SourceTaskRun>({
    source: 'runs',
    ddl: TASK_RUN_DDL,
    table: 'f_task_run',
    reader: sqliteHealthSourceReader,
    ready: (reader) => reader.hasTasks(),
    after: (reader, mark) => reader.taskRunsAfter(mark, ETL_BATCH),
    byId: (reader, ids) => reader.taskRunsById(ids),
    at: (run) => run.startedAt,
    open: (run) => run.status === 'running',
    cells: (run) => [run.id, run.taskId, run.status, run.dueAt, run.startedAt, run.finishedAt],
});

const LONG_OPEN = new Set(['running', 'waiting']);

/**
 * Schedules, goals and long runs as they are now (CB-192): small tables,
 * read whole each cycle, with each schedule's and goal's state worked out
 * at the cycle's time, and rewritten when any of it changed (the
 * watermark is a hash of it). A long run's items are counted while it is
 * open or changed since the last copy; a finished one keeps its counts.
 */
export const schedulesStep: EtlStep = {
    source: 'schedules',
    ddl: SNAPSHOT_DDL,
    async batch({ sqlite, duck, watermark, context }) {
        const reader = sqliteHealthSourceReader(sqlite);
        const jobs = reader.hasJobs();
        if (!reader.hasTasks() && !jobs) {
            return { caughtUp: true };
        }
        const kept = new Map(
            (
                await rows<{
                    id: string;
                    updated_at: number;
                    items_done: number;
                    items_dead: number;
                    items_pending: number;
                }>(duck, 'SELECT id, updated_at, items_done, items_dead, items_pending FROM s_long_run')
            ).map((row) => [row.id, row]),
        );
        const read = reading(sqlite, () => {
            const longRuns = jobs ? reader.longRuns() : [];
            const count = longRuns
                .filter((run) => LONG_OPEN.has(run.status) || kept.get(run.id)?.updated_at !== run.updatedAt)
                .map((run) => run.id);
            return {
                schedules: reader.hasTasks() ? reader.schedules() : [],
                goals: jobs ? reader.goals() : [],
                longRuns,
                counts: jobs ? reader.itemCounts(count) : [],
                counted: new Set(count),
            };
        });
        const now = context.now;
        const states = new Map<string, ScheduleState>();
        const schedules = read.schedules.map((task): Cell[] => {
            const state = scheduleState(task, now);
            states.set(task.id, state);
            return [
                task.id,
                task.title,
                task.dotId,
                task.userId,
                task.kind,
                task.status,
                state,
                task.cadence,
                task.nextRunAt,
                task.lastRunAt,
                task.updatedAt,
                task.error,
            ];
        });
        const goals = read.goals.map((goal): Cell[] => [
            goal.id,
            goal.dotId,
            goal.userId,
            goal.scheduleId,
            goal.status,
            goalState(goal, states.get(goal.scheduleId), now),
            goal.createdAt,
            goal.updatedAt,
            goal.closedAt,
        ]);
        const counts = new Map<string, { done: number; dead: number; pending: number }>();
        for (const { longRunId, status, n } of read.counts) {
            const entry = counts.get(longRunId) ?? { done: 0, dead: 0, pending: 0 };
            if (status === 'done') {
                entry.done += n;
            } else if (status === 'dead') {
                entry.dead += n;
            } else {
                entry.pending += n;
            }
            counts.set(longRunId, entry);
        }
        const longRuns = read.longRuns.map((run): Cell[] => {
            const old = kept.get(run.id);
            const items = read.counted.has(run.id)
                ? (counts.get(run.id) ?? { done: 0, dead: 0, pending: 0 })
                : {
                      done: old?.items_done ?? 0,
                      dead: old?.items_dead ?? 0,
                      pending: old?.items_pending ?? 0,
                  };
            return [
                run.id,
                run.jobId,
                run.jobName,
                run.dotId,
                run.userId,
                run.status,
                run.batches,
                run.retries,
                items.done,
                items.dead,
                items.pending,
                run.createdAt,
                run.updatedAt,
                run.finishedAt,
                run.waitReason,
                run.lastError,
            ];
        });
        const hash = createHash('sha256')
            .update(JSON.stringify([schedules, goals, longRuns]))
            .digest('base64url')
            .slice(0, 22);
        if (hash === watermark) {
            return { caughtUp: true };
        }
        for (const table of ['s_schedule', 's_goal', 's_long_run']) {
            await duck.run(`DELETE FROM ${table}`);
        }
        await append(duck, 's_schedule', schedules);
        await append(duck, 's_goal', goals);
        await append(duck, 's_long_run', longRuns);
        return { watermark: hash, caughtUp: true };
    },
};
