import { createHash } from 'node:crypto';

import { listValue, type DuckDBConnection } from '@duckdb/node-api';

import { SOCIO_OWNER_PREFIX, reservedUserId, sharedAreaLabel } from '@socio/shared/data-types';

import type { EtlStep } from '../infra/duckdb/etl.js';
import { rows } from '../infra/duckdb/open.js';
import { sqliteKnowledgeSource } from '../infra/sqlite/knowledge-source.js';

import { append } from './append.js';
import {
    DATA_ACCESS_DDL,
    DATASET_DAY_DDL,
    PAGE_DDL,
    PAGE_EDIT_DDL,
    REQUEST_DDL,
    STORAGE_DDL,
} from './knowledge-schema.js';
import { ETL_BATCH } from './source-reader.js';

const DAY = 86_400_000;
const MINUTE = 60_000;

/**
 * How long a row written with `writeSoon` may take to commit after the
 * time it carries: rows younger than this wait for the next cycle, so one
 * that commits late, behind another chain's unit of work, isn't skipped.
 */
export const COMMIT_LAG_MS = MINUTE;

const hashOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 22);

function parsed<T extends object>(watermark: string | null, fallback: T): T {
    if (!watermark) {
        return fallback;
    }
    try {
        const value: unknown = JSON.parse(watermark);
        return value && typeof value === 'object' ? { ...fallback, ...(value as Partial<T>) } : fallback;
    } catch {
        return fallback;
    }
}

async function replace(
    duck: DuckDBConnection,
    table: string,
    values: readonly (readonly (string | number | boolean | null)[])[],
) {
    await duck.run(`DELETE FROM ${table}`);
    await append(duck, table, values);
}

/**
 * Space pages (CB-191): the live pages are listed from SQLite's covering
 * index each cycle and compared with the store's, so only pages that were
 * added, edited, moved or deleted are read in full (their length, never
 * their text), at most `ETL_BATCH` per batch. Page use and the daily
 * search timings are small tables, read whole and written when they
 * changed (the watermark holds their hashes), which also mirrors
 * SQLite's pruning of old search days.
 */
export const pagesStep: EtlStep = {
    source: 'pages',
    ddl: PAGE_DDL,
    async batch({ sqlite, duck, watermark }) {
        const reader = sqliteKnowledgeSource(sqlite);
        if (!reader.has('pages')) {
            return { caughtUp: true };
        }
        const held = new Map(
            (
                await rows<{
                    row_key: number;
                    space_id: string;
                    updated_at: number;
                    title: string;
                }>(duck, 'SELECT row_key, space_id, updated_at, title FROM d_page')
            ).map((row) => [row.row_key, row]),
        );
        sqlite.exec('BEGIN');
        let read;
        try {
            const keys = reader.livePageKeys();
            const changed = keys.filter((key) => {
                const was = held.get(key.rowKey);
                return (
                    !was || was.space_id !== key.spaceId || was.updated_at !== key.updatedAt || was.title !== key.title
                );
            });
            read = {
                keys,
                changed: changed.length,
                more: changed.length > ETL_BATCH,
                pages: reader.pagesByKey(changed.slice(0, ETL_BATCH).map((key) => key.rowKey)),
                use: reader.pageUse(),
                search: reader.searchDays(),
            };
        } finally {
            sqlite.exec('COMMIT');
        }
        const live = new Set(read.keys.map((key) => key.rowKey));
        const rewrite = [...[...held.keys()].filter((key) => !live.has(key)), ...read.pages.map((page) => page.rowKey)];
        if (rewrite.length) {
            await duck.run('DELETE FROM d_page WHERE row_key IN (SELECT unnest($1))', [
                listValue(rewrite.map((key) => BigInt(key))),
            ]);
        }
        await append(
            duck,
            'd_page',
            read.pages.map((page) => [
                page.rowKey,
                page.id,
                page.spaceId,
                page.title,
                page.chars,
                page.revision,
                page.createdAt,
                page.updatedAt,
                page.createdBy,
            ]),
        );
        const state = parsed(watermark, { use: '', search: '' });
        const next = { use: hashOf(read.use), search: hashOf(read.search) };
        if (next.use !== state.use) {
            await replace(
                duck,
                'd_page_use',
                read.use.map((use) => [use.pageId, use.usedAt]),
            );
        }
        if (next.search !== state.search) {
            const days = read.search.map((day) => ({
                ...day,
                at: Date.parse(`${day.day}T00:00:00Z`),
            }));
            await replace(
                duck,
                'f_search_day',
                days.map((day) => [
                    day.at,
                    day.queries,
                    day.empty,
                    day.corrected,
                    day.trigram,
                    Math.round(day.maxMs * 1000),
                ]),
            );
            await replace(
                duck,
                'f_search_latency',
                days.flatMap((day) =>
                    Object.entries(histogramOf(day.histogram)).map(([bucket, n]) => [day.at, Number(bucket), n]),
                ),
            );
        }
        return {
            watermark: JSON.stringify(next),
            caughtUp: !read.more,
            // How much of the pages the store holds as they are.
            progress: read.keys.length ? 1 - (read.changed - read.pages.length) / read.keys.length : 1,
        };
    },
};

function histogramOf(text: string): Record<string, number> {
    try {
        const value: unknown = JSON.parse(text);
        if (!value || typeof value !== 'object') {
            return {};
        }
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).filter(
                (entry): entry is [string, number] =>
                    /^\d{1,3}$/.test(entry[0]) && typeof entry[1] === 'number' && entry[1] > 0,
            ),
        );
    } catch {
        return {};
    }
}

/** Who made an edit: `dot:<id>` is a socio's page tool. */
export function editAuthor(authorId: string | null) {
    if (!authorId) {
        return { kind: 'unknown', id: null };
    }
    return authorId.startsWith('dot:') ? { kind: 'socio', id: authorId.slice(4) } : { kind: 'person', id: authorId };
}

/**
 * Page edits (CB-191): `page_revisions` is append-only with an integer
 * key, read by it in batches; each batch deletes its key range first, so
 * running it again changes nothing.
 */
export const pageEditsStep: EtlStep = {
    source: 'page_revisions',
    ddl: PAGE_EDIT_DDL,
    async batch({ sqlite, duck, watermark }) {
        const reader = sqliteKnowledgeSource(sqlite);
        const after = Number(watermark ?? 0) || 0;
        const edits = reader.pageEditsAfter(after, ETL_BATCH);
        if (!edits.length) {
            return { caughtUp: true };
        }
        const last = edits.at(-1)!.id;
        await duck.run('DELETE FROM f_page_edit WHERE revision_id > $1 AND revision_id <= $2', [
            BigInt(after),
            BigInt(last),
        ]);
        await append(
            duck,
            'f_page_edit',
            edits.map((edit) => {
                const author = editAuthor(edit.authorId);
                return [edit.id, edit.pageId, edit.spaceId, author.kind, author.id, edit.replacedAt];
            }),
        );
        const top = reader.lastPageEditId();
        return {
            watermark: String(last),
            caughtUp: edits.length < ETL_BATCH,
            progress: top ? Math.min(1, last / top) : 1,
        };
    },
};

/**
 * Dataset access (CB-191): `data_audit` is append-only, read in time
 * order through its index by (`createdAt`, `id`), and only up to
 * `COMMIT_LAG_MS` ago (rows are written with `writeSoon`). A batch
 * replaces the rows it read, so it is idempotent.
 */
export const dataAccessStep: EtlStep = {
    source: 'data_audit',
    ddl: DATA_ACCESS_DDL,
    async batch({ sqlite, duck, watermark, context }) {
        const reader = sqliteKnowledgeSource(sqlite);
        const after = parsed(watermark, { at: -1, id: '' });
        const read = reader.dataAccessAfter(after, context.now - COMMIT_LAG_MS, ETL_BATCH);
        if (!read.length) {
            return { caughtUp: true };
        }
        await duck.run('DELETE FROM f_data_access WHERE id IN (SELECT unnest($1))', [
            listValue(read.map((row) => row.id)),
        ]);
        await append(
            duck,
            'f_data_access',
            read.map((row) => [
                row.id,
                row.createdAt,
                row.ownerUserId,
                row.actorKind,
                row.actorId,
                row.dotId,
                row.datasetId,
                row.action,
                row.outcome,
                row.threadId,
            ]),
        );
        const last = read.at(-1)!;
        return {
            watermark: JSON.stringify({ at: last.createdAt, id: last.id }),
            caughtUp: read.length < ETL_BATCH,
        };
    },
};

/**
 * Dataset sizes per day (CB-191, `data_dataset_days`): a day's row is
 * updated in place, its `measuredAt` moving on, so it is read by
 * (`measuredAt`, row key) up to `COMMIT_LAG_MS` ago and replaces the
 * store's row for that dataset and day.
 */
export const datasetDaysStep: EtlStep = {
    source: 'data_dataset_days',
    ddl: DATASET_DAY_DDL,
    async batch({ sqlite, duck, watermark, context }) {
        const reader = sqliteKnowledgeSource(sqlite);
        const after = parsed(watermark, { at: -1, rowKey: 0 });
        const read = reader.datasetDaysAfter(after, context.now - COMMIT_LAG_MS, ETL_BATCH);
        if (!read.length) {
            return { caughtUp: true };
        }
        await duck.run(`DELETE FROM f_dataset_day WHERE dataset_id || ':' || day_at IN (SELECT unnest($1))`, [
            listValue(read.map((row) => `${row.datasetId}:${row.day * DAY}`)),
        ]);
        await append(
            duck,
            'f_dataset_day',
            read.map((row) => [
                row.datasetId,
                row.day * DAY,
                row.sizeBytes,
                row.historyBytes,
                row.tableCount,
                row.measuredAt,
            ]),
        );
        const last = read.at(-1)!;
        return {
            watermark: JSON.stringify({ at: last.measuredAt, rowKey: last.rowKey }),
            caughtUp: read.length < ETL_BATCH,
        };
    },
};

/**
 * What is stored (CB-191), at most every `everyMs` (always when
 * rebuilding): the datasets, every kind's items grouped by the hours
 * they were made and deleted (one aggregate statement per kind, not a
 * row per file), each person's live files and the database file's size.
 * `agent_runs`' own bytes need `dbstat`, which reads every page of the
 * table, so they are measured at most every `tableEveryMs`, outside the
 * other reads' transaction.
 */
export function storageStep(everyMs = 5 * MINUTE, tableEveryMs = 60 * MINUTE): EtlStep {
    return {
        source: 'storage',
        ddl: STORAGE_DDL,
        async batch({ sqlite, duck, watermark, rebuilding, context }) {
            const reader = sqliteKnowledgeSource(sqlite);
            // When it last measured: kept with the measurements, so the
            // watermark is only what was read, and a fresh file measures at once.
            const [was] = await rows<{
                measured_at: number;
                agent_runs_bytes: number | null;
                agent_runs_at: number | null;
            }>(duck, 'SELECT measured_at, agent_runs_bytes, agent_runs_at FROM s_database');
            if (!rebuilding && was && context.now - was.measured_at < everyMs) {
                return { caughtUp: true };
            }
            sqlite.exec('BEGIN');
            let read;
            try {
                read = {
                    datasets: reader.datasets(),
                    lifetimes: reader.lifetimes(),
                    owners: reader.ownerFiles(),
                    socios: reader.socioNames(),
                    database: reader.databaseSize(),
                };
            } finally {
                sqlite.exec('COMMIT');
            }
            let runs = {
                bytes: was?.agent_runs_bytes ?? null,
                at: was?.agent_runs_at ?? null,
            };
            if (reader.has('agent_runs') && (rebuilding || runs.at === null || context.now - runs.at >= tableEveryMs)) {
                runs = { bytes: reader.tableBytes('agent_runs'), at: context.now };
            }
            await replace(duck, 's_database', [
                [read.database.bytes, read.database.freeBytes, runs.bytes, context.now, runs.at],
            ]);
            const hash = hashOf([read.datasets, read.lifetimes, read.owners, read.socios]);
            if (hash !== watermark) {
                // A company socio's shared area is no person's (CB-224): named for
                // its socio, so it never counts as, or filters as, someone.
                const names = new Map(read.socios.map((socio) => [socio.id, socio.name]));
                const owner = (id: string) =>
                    reservedUserId(id) ? sharedAreaLabel(names.get(id.slice(SOCIO_OWNER_PREFIX.length))) : id;
                await replace(
                    duck,
                    'd_dataset',
                    read.datasets.map((dataset) => [
                        dataset.id,
                        owner(dataset.ownerUserId),
                        dataset.name,
                        !!dataset.scratch,
                        dataset.sizeBytes,
                        dataset.historyBytes,
                        dataset.tableCount,
                        dataset.createdAt,
                        dataset.updatedAt,
                        dataset.deletedAt,
                    ]),
                );
                await replace(
                    duck,
                    's_lifetime',
                    read.lifetimes.map((row) => [row.kind, row.createdAt, row.deletedAt, row.items, row.bytes]),
                );
                await replace(
                    duck,
                    's_owner_files',
                    read.owners.map((row) => [owner(row.ownerUserId), row.files, row.bytes, row.largest]),
                );
            }
            return { watermark: hash, caughtUp: true };
        },
    };
}

/**
 * Capability requests (CB-191): a small table and its askers, counted in
 * SQLite and written when they changed. No request's wording is read.
 */
export const requestsStep: EtlStep = {
    source: 'dot_requests',
    ddl: REQUEST_DDL,
    async batch({ sqlite, duck, watermark }) {
        const read = sqliteKnowledgeSource(sqlite).requests();
        const hash = hashOf(read);
        // None yet: nothing to write (and no watermark, as for other sources).
        if (hash === watermark || (!read.length && watermark === null)) {
            return { caughtUp: true };
        }
        await replace(
            duck,
            'f_request',
            read.map((row) => [
                row.issueId,
                row.number,
                row.title,
                row.status,
                row.capability,
                row.createdAt,
                row.requesters,
                row.socios,
                row.people,
                row.lastAt,
            ]),
        );
        return { watermark: hash, caughtUp: true };
    },
};

/** The Knowledge and Capabilities steps, in `ETL_STEPS` order. */
export const KNOWLEDGE_STEPS: readonly EtlStep[] = [
    pagesStep,
    pageEditsStep,
    dataAccessStep,
    datasetDaysStep,
    storageStep(),
    requestsStep,
];
