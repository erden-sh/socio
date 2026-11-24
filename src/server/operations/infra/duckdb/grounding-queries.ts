import type { DuckDBConnection } from '@duckdb/node-api';

import { bucketStarts, type OpsFilters, type OpsWindow } from '@socio/shared/operations/operations';
import { OPS_CHAT_GROUNDING_MAX, OPS_GROUNDING_TOP_PAGES } from '@socio/shared/operations/operations-grounding';
import { RUN_REF_KINDS, SPACE_REF_KINDS, type RunRefKind } from '@socio/shared/runs/run-refs';

import type { OpsQueries } from '../../domain/ops-queries.js';

import { rows } from './open.js';
import { calendarTable, KEY_COLUMN, range, rollupMeta, Sql, turnFilters } from './sql.js';

type GroundingQueries = Pick<OpsQueries, 'grounding' | 'chatGrounding'>;

const PAGE_KINDS = SPACE_REF_KINDS.map((kind) => `'${kind}'`).join(', ');

/**
 * The window's references (`f_run_ref`) as a CTE `r`: in the window, of
 * the page's Space, and of turns of the socio, person and source (the
 * turn's, `f_turn`; a reference whose turn isn't copied yet is left out
 * only when one of those filters is set).
 */
function windowRefs(sql: Sql, window: OpsWindow, filters: OpsFilters) {
    const turned = !!(filters.socio || filters.person || filters.source);
    const where = [
        ...range(sql, 'r.ref_at', window.from, window.to),
        ...(filters.space ? [`r.space_id = ${sql.text(filters.space)}`] : []),
        ...(turned ? turnFilters(sql, { ...filters, space: undefined }, 't.') : []),
    ];
    return `WITH r AS (
    SELECT r.run_id, r.thread_id, r.kind, r.space_id, r.ref_id, r.ref_at
    FROM f_run_ref r ${turned ? 'JOIN f_turn t ON t.run_id = r.run_id' : ''}
    WHERE ${where.join(' AND ')}
  )`;
}

/**
 * Grounding (CB-194) on the analytics process's connection, answering as
 * `MemoryGrounding` does: a Space's reads are `(turn, page)` pairs,
 * however the turn reached the page; recalls and datasets have no Space.
 */
export function groundingOpsQueries(connection: DuckDBConnection): GroundingQueries {
    return {
        async grounding({ window, filters }) {
            const ask = async <T>(body: string) => {
                const sql = new Sql();
                const cte = windowRefs(sql, window, filters);
                return rows<T>(connection, `${cte} ${body}`, sql.values);
            };
            const [totals] = await ask<{
                runs: number;
                chats: number;
                lo: number | null;
            }>('SELECT count(DISTINCT run_id) AS runs, count(DISTINCT thread_id) AS chats, min(ref_at) AS lo FROM r');
            const kinds = new Map(
                (
                    await ask<{ kind: RunRefKind; refs: number; runs: number }>(
                        'SELECT kind, count(*) AS refs, count(DISTINCT run_id) AS runs FROM r GROUP BY kind',
                    )
                ).map((row) => [row.kind, row]),
            );
            const start = window.from ?? totals?.lo ?? null;
            const buckets = start === null ? [] : bucketStarts(start, window.to, window.bucket, window.timeZone);
            const spaces = await ask<{
                space_id: string;
                name: string | null;
                reads: number;
                pages: number;
                chats: number;
            }>(
                `, p AS (SELECT * FROM r WHERE kind IN (${PAGE_KINDS}) AND space_id IS NOT NULL)
        SELECT g.space_id, d.name, g.reads, c.pages, c.chats
        FROM (
          SELECT space_id, count(*) AS reads
          FROM (SELECT DISTINCT space_id, run_id, ref_id FROM p) GROUP BY space_id
        ) g
        JOIN (
          SELECT space_id, count(DISTINCT ref_id) AS pages,
            count(DISTINCT thread_id) AS chats
          FROM p GROUP BY space_id
        ) c ON c.space_id = g.space_id
        LEFT JOIN d_space d ON d.id = g.space_id
        ORDER BY g.reads DESC, g.space_id`,
            );
            let cells: { spaceId: string; at: number; reads: number }[] = [];
            if (buckets.length && spaces.length) {
                const calendar = await calendarTable(
                    connection,
                    window,
                    await rollupMeta(connection),
                    start!,
                    window.to,
                );
                const columns = new Set(buckets);
                cells = (
                    await ask<{ space_id: string; k: number; reads: number }>(
                        `SELECT space_id, k, count(*) AS reads FROM (
              SELECT DISTINCT f.space_id, c.${KEY_COLUMN[window.bucket]} AS k, f.run_id, f.ref_id
              FROM (SELECT space_id, run_id, ref_id, ref_at AS ts FROM r
                WHERE kind IN (${PAGE_KINDS}) AND space_id IS NOT NULL) f
              ASOF JOIN ${calendar} c ON f.ts >= c.utc_at
            ) GROUP BY space_id, k ORDER BY space_id, k`,
                    )
                )
                    .map((row) => ({
                        spaceId: row.space_id,
                        at: Number(row.k),
                        reads: row.reads,
                    }))
                    .filter((cell) => columns.has(cell.at));
            }
            const pages = await ask<{
                page_id: string;
                space_id: string | null;
                space_name: string | null;
                title: string | null;
                reads: number;
                chats: number;
                last_at: number;
            }>(
                `SELECT g.page_id, p.space_id, d.name AS space_name, p.title, g.reads, g.chats, g.last_at
        FROM (
          SELECT ref_id AS page_id, count(DISTINCT run_id) AS reads,
            count(DISTINCT thread_id) AS chats, max(ref_at) AS last_at
          FROM r WHERE kind IN (${PAGE_KINDS}) GROUP BY ref_id
        ) g
        LEFT JOIN d_page p ON p.page_id = g.page_id
        LEFT JOIN d_space d ON d.id = p.space_id
        ORDER BY g.chats DESC, g.reads DESC, g.page_id
        LIMIT ${OPS_GROUNDING_TOP_PAGES}`,
            );
            return {
                runs: totals?.runs ?? 0,
                chats: totals?.chats ?? 0,
                kinds: RUN_REF_KINDS.map((kind) => ({
                    kind,
                    refs: kinds.get(kind)?.refs ?? 0,
                    runs: kinds.get(kind)?.runs ?? 0,
                })),
                buckets,
                spaces: spaces.map((row) => ({
                    spaceId: row.space_id,
                    name: row.name,
                    reads: row.reads,
                    pages: row.pages,
                    chats: row.chats,
                })),
                cells,
                pages: pages.map((row) => ({
                    pageId: row.page_id,
                    spaceId: row.space_id,
                    spaceName: row.space_name,
                    title: row.title,
                    reads: row.reads,
                    chats: row.chats,
                    lastAt: row.last_at,
                })),
            };
        },

        async chatGrounding({ threadId }) {
            const found = await rows<{
                kind: RunRefKind;
                space_id: string | null;
                space_name: string | null;
                ref_id: string;
                title: string | null;
                runs: number;
                first_at: number;
                last_at: number;
            }>(
                connection,
                `SELECT g.kind, g.space_id, d.name AS space_name, g.ref_id,
          CASE WHEN g.kind = 'dataset' THEN ds.name
            WHEN g.kind = 'recall' THEN NULL ELSE p.title END AS title,
          g.runs, g.first_at, g.last_at
        FROM (
          SELECT kind, space_id, ref_id, count(DISTINCT run_id) AS runs,
            min(ref_at) AS first_at, max(ref_at) AS last_at
          FROM f_run_ref WHERE thread_id = $1 GROUP BY kind, space_id, ref_id
        ) g
        LEFT JOIN d_space d ON d.id = g.space_id
        LEFT JOIN d_page p ON p.page_id = g.ref_id AND g.kind IN (${PAGE_KINDS})
        LEFT JOIN d_dataset ds ON ds.id = g.ref_id AND g.kind = 'dataset'
        ORDER BY g.last_at DESC, g.kind, g.ref_id, COALESCE(g.space_id, '')
        LIMIT ${OPS_CHAT_GROUNDING_MAX + 1}`,
                [threadId],
            );
            return {
                refs: found.slice(0, OPS_CHAT_GROUNDING_MAX).map((row) => ({
                    kind: row.kind,
                    spaceId: row.space_id,
                    spaceName: row.space_name,
                    refId: row.ref_id,
                    title: row.title,
                    runs: row.runs,
                    firstAt: row.first_at,
                    lastAt: row.last_at,
                })),
                more: found.length > OPS_CHAT_GROUNDING_MAX,
            };
        },
    };
}
