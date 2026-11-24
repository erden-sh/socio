import type { DuckDBConnection } from '@duckdb/node-api';

import type { OpsFilters } from '@socio/shared/operations/operations';
import { OPS_STALE_DAYS, type OpsKnowledge, type OpsSpaceRow } from '@socio/shared/operations/operations-knowledge';

import { searchTimings, storageOf } from '../../domain/knowledge.js';
import type { OpsQueries } from '../../domain/ops-queries.js';

import { rows } from './open.js';
import { range, Sql, turnFilters } from './sql.js';

const DAY = 86_400_000;

type KnowledgeQueries = Pick<OpsQueries, 'knowledge' | 'pages' | 'datasets' | 'storage' | 'toolUse' | 'requests'>;

/** Edits by who made them: a socio's by its id, a person's by theirs. */
function editFilters(sql: Sql, filters: OpsFilters) {
    return [
        ...(filters.space ? [`space_id = ${sql.text(filters.space)}`] : []),
        ...(filters.socio ? [`author_kind = 'socio' AND author_id = ${sql.text(filters.socio)}`] : []),
        ...(filters.person ? [`author_kind = 'person' AND author_id = ${sql.text(filters.person)}`] : []),
    ];
}

/** Dataset access by the socio that acted and the person whose data it is. */
function accessFilters(sql: Sql, filters: OpsFilters) {
    return [
        ...(filters.socio ? [`socio_id = ${sql.text(filters.socio)}`] : []),
        ...(filters.person ? [`owner_id = ${sql.text(filters.person)}`] : []),
    ];
}

const where = (terms: string[]) => terms.join(' AND ') || 'true';

/**
 * The Knowledge and Capabilities queries (CB-191) on the analytics
 * process's connection, answering as `OpsReader` says: pages and
 * datasets "now" from the latest snapshot, what happened from the facts
 * in the window, lists keyset-paged.
 */
export function knowledgeOpsQueries(connection: DuckDBConnection): KnowledgeQueries {
    return {
        async knowledge({ window, filters }) {
            const sql = new Sql();
            const space = filters.space ? sql.text(filters.space) : null;
            const staleBefore = sql.int(window.to - OPS_STALE_DAYS * DAY);
            const created = range(sql, 'created_at', window.from, window.to);
            const edits = [...range(sql, 'edited_at', window.from, window.to), ...editFilters(sql, filters)];
            const found = await rows<{
                space_id: string;
                name: string | null;
                pages: number;
                chars: number;
                created: number;
                stale: number;
                edits: number;
            }>(
                connection,
                `WITH p AS (
          SELECT p.space_id, p.chars, p.created_at,
            greatest(p.updated_at, COALESCE(u.used_at, 0)) AS active_at
          FROM d_page p LEFT JOIN d_page_use u ON u.page_id = p.page_id
          ${space ? `WHERE p.space_id = ${space}` : ''}
        ), e AS (
          SELECT space_id FROM f_page_edit WHERE ${where(edits)}
        ), pc AS (
          SELECT space_id, count(*) AS pages, sum(chars)::BIGINT AS chars,
            count(*) FILTER (WHERE ${created.join(' AND ')}) AS created,
            count(*) FILTER (WHERE active_at < ${staleBefore}) AS stale
          FROM p GROUP BY space_id
        ), ec AS (
          SELECT space_id, count(*) AS edits FROM e GROUP BY space_id
        ), s AS (
          SELECT space_id FROM pc UNION SELECT space_id FROM ec
          UNION SELECT id FROM d_space WHERE deleted_at IS NULL ${space ? `AND id = ${space}` : ''}
        )
        SELECT s.space_id, d.name, COALESCE(pc.pages, 0) AS pages,
          COALESCE(pc.chars, 0) AS chars, COALESCE(pc.created, 0) AS created,
          COALESCE(pc.stale, 0) AS stale, COALESCE(ec.edits, 0) AS edits
        FROM s LEFT JOIN pc ON pc.space_id = s.space_id
        LEFT JOIN ec ON ec.space_id = s.space_id
        LEFT JOIN d_space d ON d.id = s.space_id
        ORDER BY pages DESC, s.space_id`,
                sql.values,
            );
            const spaces = found.map((row): OpsSpaceRow => ({
                spaceId: row.space_id,
                name: row.name,
                pages: row.pages,
                chars: row.chars,
                created: row.created,
                edits: row.edits,
                stale: row.stale,
            }));
            const editors = new Sql();
            const [authors] = await rows<{ n: number }>(
                connection,
                `SELECT count(DISTINCT author_kind || ':' || author_id) AS n FROM f_page_edit
        WHERE author_id IS NOT NULL AND ${where([
            ...range(editors, 'edited_at', window.from, window.to),
            ...editFilters(editors, filters),
        ])}`,
                editors.values,
            );
            const sum = (key: keyof Omit<OpsSpaceRow, 'spaceId' | 'name'>) =>
                spaces.reduce((total, row) => total + row[key], 0);
            return {
                spaces,
                totals: {
                    pages: sum('pages'),
                    chars: sum('chars'),
                    created: sum('created'),
                    edits: sum('edits'),
                    stale: sum('stale'),
                    editors: authors?.n ?? 0,
                },
                search: await search(connection, window.from, window.to),
                access: await access(connection, filters, window.from, window.to),
            };
        },

        async pages({ window, filters, cursor, limit }) {
            if (cursor && typeof cursor.key !== 'number') {
                return { items: [], next: null };
            }
            const sql = new Sql();
            const edits = [
                ...range(sql, 'edited_at', window.from, window.to),
                ...editFilters(sql, { ...filters, space: undefined }),
            ];
            const terms = [
                ...(filters.space ? [`space_id = ${sql.text(filters.space)}`] : []),
                // Keyset, least recently active first: after (activeAt, pageId).
                ...(cursor
                    ? [
                          `(active_at > ${sql.int(cursor.key as number)} OR (active_at = ${sql.int(cursor.key as number)} AND page_id > ${sql.text(cursor.id)}))`,
                      ]
                    : []),
            ];
            const found = await rows<{
                page_id: string;
                space_id: string;
                space_name: string | null;
                title: string;
                chars: number;
                revision: number;
                edits: number;
                created_at: number;
                updated_at: number;
                used_at: number | null;
                active_at: number;
                stale: boolean;
            }>(
                connection,
                `SELECT * FROM (
          SELECT p.page_id, p.space_id, d.name AS space_name, p.title, p.chars,
            p.revision, COALESCE(e.n, 0) AS edits, p.created_at, p.updated_at,
            u.used_at, greatest(p.updated_at, COALESCE(u.used_at, 0)) AS active_at
          FROM d_page p
          LEFT JOIN d_page_use u ON u.page_id = p.page_id
          LEFT JOIN d_space d ON d.id = p.space_id
          LEFT JOIN (SELECT page_id, count(*) AS n FROM f_page_edit WHERE ${where(edits)} GROUP BY page_id) e
            ON e.page_id = p.page_id
        ) WHERE ${where(terms)}
        ORDER BY active_at, page_id
        LIMIT ${limit + 1}`,
                sql.values,
            );
            const before = window.to - OPS_STALE_DAYS * DAY;
            const items = found.slice(0, limit).map((row) => ({
                pageId: row.page_id,
                spaceId: row.space_id,
                spaceName: row.space_name,
                title: row.title,
                chars: row.chars,
                revision: row.revision,
                edits: row.edits,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                usedAt: row.used_at,
                activeAt: row.active_at,
                stale: row.active_at < before,
            }));
            const last = items.at(-1);
            return {
                items,
                next: found.length > limit && last ? { key: last.activeAt, id: last.pageId } : null,
            };
        },

        async datasets({ window, filters, cursor, limit }) {
            if (cursor && typeof cursor.key !== 'number') {
                return { items: [], next: null };
            }
            const sql = new Sql();
            const accessed = [...range(sql, 'accessed_at', window.from, window.to), ...accessFilters(sql, filters)];
            const terms = [
                'd.deleted_at IS NULL',
                ...(filters.person ? [`d.owner_id = ${sql.text(filters.person)}`] : []),
                // A socio's: the datasets it touched in the window.
                ...(filters.socio ? ['a.n > 0'] : []),
                // Keyset, largest first: after (bytes, id), both descending.
                ...(cursor
                    ? [
                          `(d.size_bytes + d.history_bytes < ${sql.int(cursor.key as number)} OR (d.size_bytes + d.history_bytes = ${sql.int(cursor.key as number)} AND d.id < ${sql.text(cursor.id)}))`,
                      ]
                    : []),
            ];
            const found = await rows<{
                id: string;
                name: string;
                scratch: boolean;
                size_bytes: number;
                history_bytes: number;
                tables: number;
                created_at: number;
                updated_at: number;
                accesses: number;
                denied: number;
                last_at: number | null;
            }>(
                connection,
                `SELECT d.id, d.name, d.scratch, d.size_bytes, d.history_bytes, d.tables,
          d.created_at, d.updated_at, COALESCE(a.n, 0) AS accesses,
          COALESCE(a.denied, 0) AS denied, a.last_at
        FROM d_dataset d
        LEFT JOIN (
          SELECT dataset_id, count(*) AS n,
            count(*) FILTER (WHERE outcome = 'denied') AS denied,
            max(accessed_at) AS last_at
          FROM f_data_access WHERE ${where(accessed)} GROUP BY dataset_id
        ) a ON a.dataset_id = d.id
        WHERE ${where(terms)}
        ORDER BY d.size_bytes + d.history_bytes DESC, d.id DESC
        LIMIT ${limit + 1}`,
                sql.values,
            );
            const items = found.slice(0, limit).map((row) => ({
                datasetId: row.id,
                name: row.name,
                scratch: row.scratch,
                sizeBytes: row.size_bytes,
                historyBytes: row.history_bytes,
                tables: row.tables,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                accesses: row.accesses,
                denied: row.denied,
                lastAccessAt: row.last_at,
            }));
            const last = items.at(-1);
            return {
                items,
                next:
                    found.length > limit && last
                        ? { key: last.sizeBytes + last.historyBytes, id: last.datasetId }
                        : null,
            };
        },

        async storage({ window }) {
            const [datasets, days, lifetimes, owners, [database]] = await Promise.all([
                rows<{
                    id: string;
                    owner_id: string;
                    name: string;
                    scratch: boolean;
                    size_bytes: number;
                    history_bytes: number;
                    tables: number;
                    created_at: number;
                    updated_at: number;
                    deleted_at: number | null;
                }>(connection, 'SELECT * FROM d_dataset ORDER BY id'),
                rows<{
                    dataset_id: string;
                    size_bytes: number;
                    history_bytes: number;
                    measured_at: number;
                }>(
                    connection,
                    'SELECT dataset_id, size_bytes, history_bytes, measured_at FROM f_dataset_day ORDER BY measured_at, dataset_id',
                ),
                rows<{
                    kind: 'datasets' | 'files' | 'attachments' | 'apps';
                    created_at: number;
                    deleted_at: number | null;
                    items: number;
                    bytes: number;
                }>(connection, 'SELECT * FROM s_lifetime ORDER BY kind, created_at, deleted_at'),
                rows<{
                    owner_id: string;
                    files: number;
                    bytes: number;
                    largest: number;
                }>(connection, 'SELECT * FROM s_owner_files ORDER BY owner_id'),
                rows<{
                    bytes: number;
                    free_bytes: number;
                    agent_runs_bytes: number | null;
                    measured_at: number;
                }>(connection, 'SELECT bytes, free_bytes, agent_runs_bytes, measured_at FROM s_database'),
            ] as const);
            return storageOf(
                {
                    datasets: datasets.map((row) => ({
                        id: row.id,
                        ownerId: row.owner_id,
                        name: row.name,
                        scratch: row.scratch,
                        sizeBytes: row.size_bytes,
                        historyBytes: row.history_bytes,
                        tables: row.tables,
                        createdAt: row.created_at,
                        updatedAt: row.updated_at,
                        deletedAt: row.deleted_at,
                    })),
                    days: days.map((row) => ({
                        datasetId: row.dataset_id,
                        sizeBytes: row.size_bytes,
                        historyBytes: row.history_bytes,
                        measuredAt: row.measured_at,
                    })),
                    lifetimes: lifetimes.map((row) => ({
                        kind: row.kind,
                        createdAt: row.created_at,
                        deletedAt: row.deleted_at,
                        items: row.items,
                        bytes: row.bytes,
                    })),
                    owners: owners.map((row) => ({
                        ownerId: row.owner_id,
                        files: row.files,
                        bytes: row.bytes,
                        largest: row.largest,
                    })),
                    database: database
                        ? {
                              bytes: database.bytes,
                              freeBytes: database.free_bytes,
                              agentRunsBytes: database.agent_runs_bytes,
                              measuredAt: database.measured_at,
                          }
                        : null,
                },
                window,
            );
        },

        async toolUse({ window, filters }) {
            const sql = new Sql();
            const terms = [...range(sql, 'started_at', window.from, window.to), ...turnFilters(sql, filters)];
            return rows<{
                tool: string;
                calls: number;
                errors: number;
                refused: number;
            }>(
                connection,
                `SELECT tool, count(*) AS calls,
          count(*) FILTER (WHERE outcome IN ('error', 'timeout')) AS errors,
          count(*) FILTER (WHERE outcome = 'refused') AS refused
        FROM f_tool WHERE ${where(terms)}
        GROUP BY tool ORDER BY calls DESC, tool`,
                sql.values,
            );
        },

        async requests({ cursor, limit }) {
            if (cursor && typeof cursor.key !== 'number') {
                return { items: [], next: null };
            }
            const sql = new Sql();
            const terms = cursor
                ? [
                      `(last_at < ${sql.int(cursor.key as number)} OR (last_at = ${sql.int(cursor.key as number)} AND issue_id < ${sql.text(cursor.id)}))`,
                  ]
                : [];
            const found = await rows<{
                issue_id: string;
                number: number | null;
                title: string | null;
                status: string | null;
                capability: string;
                created_at: number;
                requesters: number;
                socios: number;
                people: number;
                last_at: number;
            }>(
                connection,
                `SELECT * FROM f_request WHERE ${where(terms)}
        ORDER BY last_at DESC, issue_id DESC LIMIT ${limit + 1}`,
                sql.values,
            );
            const items = found.slice(0, limit).map((row) => ({
                issueId: row.issue_id,
                number: row.number,
                title: row.title,
                status: row.status,
                capability: row.capability,
                createdAt: row.created_at,
                requesters: row.requesters,
                socios: row.socios,
                people: row.people,
                lastAt: row.last_at,
            }));
            const last = items.at(-1);
            return {
                items,
                next: found.length > limit && last ? { key: last.lastAt, id: last.issueId } : null,
            };
        },
    };
}

async function search(connection: DuckDBConnection, from: number | null, to: number): Promise<OpsKnowledge['search']> {
    const sql = new Sql();
    const days = await rows<{
        day_at: number;
        queries: number;
        empty: number;
        corrected: number;
        trigram: number;
        max_us: number;
    }>(
        connection,
        `SELECT * FROM f_search_day WHERE ${range(sql, 'day_at', from, to).join(' AND ')} ORDER BY day_at`,
        sql.values,
    );
    const buckets = new Sql();
    const histogram = Object.fromEntries(
        (
            await rows<{ bucket: number; n: number }>(
                connection,
                `SELECT bucket, sum(n)::BIGINT AS n FROM f_search_latency
        WHERE ${range(buckets, 'day_at', from, to).join(' AND ')} GROUP BY bucket`,
                buckets.values,
            )
        ).map((row) => [row.bucket, row.n]),
    );
    const maxMs = days.length ? Math.max(...days.map((day) => day.max_us)) / 1000 : null;
    const total = (key: 'queries' | 'empty' | 'corrected' | 'trigram') => days.reduce((sum, day) => sum + day[key], 0);
    return {
        queries: total('queries'),
        empty: total('empty'),
        corrected: total('corrected'),
        trigram: total('trigram'),
        ...searchTimings(histogram, maxMs),
        maxMs,
        days: days.map((day) => ({
            at: day.day_at,
            queries: day.queries,
            empty: day.empty,
        })),
    };
}

async function access(
    connection: DuckDBConnection,
    filters: OpsFilters,
    from: number | null,
    to: number,
): Promise<OpsKnowledge['access']> {
    const sql = new Sql();
    const terms = where([...range(sql, 'accessed_at', from, to), ...accessFilters(sql, filters)]);
    const [totals] = await rows<{
        total: number;
        denied: number;
        errors: number;
        datasets: number;
        chats: number;
    }>(
        connection,
        `SELECT count(*) AS total, count(*) FILTER (WHERE outcome = 'denied') AS denied,
      count(*) FILTER (WHERE outcome = 'error') AS errors,
      count(DISTINCT dataset_id) AS datasets,
      count(DISTINCT thread_id) AS chats
    FROM f_data_access WHERE ${terms}`,
        sql.values,
    );
    const actions = await rows<{
        action: string;
        outcome: string;
        count: number;
    }>(
        connection,
        `SELECT action, outcome, count(*) AS count FROM f_data_access WHERE ${terms}
    GROUP BY action, outcome ORDER BY count DESC, action, outcome`,
        sql.values,
    );
    const actors = await rows<{ kind: string; count: number }>(
        connection,
        `SELECT actor_kind AS kind, count(*) AS count FROM f_data_access WHERE ${terms}
    GROUP BY actor_kind ORDER BY count DESC, kind`,
        sql.values,
    );
    return { ...totals!, actions, actors };
}
