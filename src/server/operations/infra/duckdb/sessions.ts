/**
 * People's sessions in the analytics store (CB-164), which Activity,
 * Value and Themes all read: split from `activity.ts`, so the themes'
 * queries (`themes/duckdb.ts`) read them without importing Activity, which
 * imports the themes back.
 */
import type { DuckDBConnection } from '@duckdb/node-api';

import type { OpsFilters, OpsWindow } from '@socio/shared/operations/operations';
import { OPS_OUTCOME_WINDOW_MS } from '@socio/shared/operations/operations-activity';

import { rows } from './open.js';
import { range, spaceFilter, Sql } from './sql.js';

/**
 * People's sessions that start in `from`..`to`, with their outcome
 * (CB-164): a chat's messages from anyone, cut where the gap since the
 * one before is the session gap or more (`LAG`). A session is people's
 * when one of its messages is a person's from a `human` source. Messages
 * from a gap before `from` on are read, so a session that started before
 * the window isn't taken for one that starts in it; none after `to` are
 * left out, so the sessions in it are whole and the next one's start is
 * known.
 */
export function sessions(
    sql: Sql,
    { from, to, gapMs, filters }: { from: number | null; to: number; gapMs: number; filters: OpsFilters },
) {
    const gap = sql.int(gapMs);
    const day = sql.int(OPS_OUTCOME_WINDOW_MS);
    const read = from === null ? 'true' : `m.sent_at >= ${sql.int(from - gapMs)}`;
    const keep = [
        'human',
        ...range(sql, 'started_at', from, to),
        ...(filters.socio ? [`socio_id = ${sql.text(filters.socio)}`] : []),
        ...(filters.space ? [spaceFilter(sql, 'socio_id', filters.space)] : []),
        ...(filters.source ? [`source = ${sql.text(filters.source)}`] : []),
        ...(filters.person ? [`list_contains(people_ids, ${sql.text(filters.person)})`] : []),
    ];
    return `(WITH marked AS (
      SELECT m.thread_id, m.socio_id, m.source, m.sent_at, m.author_kind,
        m.author_id, m.run_id, m.message_id, COALESCE(src.kind, 'unknown') AS source_kind,
        CASE WHEN m.sent_at - lag(m.sent_at) OVER (PARTITION BY m.thread_id ORDER BY m.sent_at, m.message_id) < ${gap}
          THEN 0 ELSE 1 END AS opens
      FROM f_message m LEFT JOIN d_source src ON src.key = m.source
      WHERE ${read}
    ), numbered AS (
      SELECT *, sum(opens) OVER (PARTITION BY thread_id ORDER BY sent_at, message_id ROWS UNBOUNDED PRECEDING) AS n
      FROM marked
    ), grouped AS (
      SELECT thread_id, n, min(sent_at) AS started_at, max(sent_at) AS ended_at,
        max(socio_id) AS socio_id, first(source ORDER BY sent_at, message_id) AS source,
        count(*)::INTEGER AS messages,
        (count(DISTINCT author_id) FILTER (WHERE author_kind = 'person'))::INTEGER AS people,
        (count(DISTINCT author_id) FILTER (WHERE author_kind = 'socio'))::INTEGER AS socios,
        list(DISTINCT author_id) FILTER (WHERE author_kind = 'person' AND author_id IS NOT NULL) AS people_ids,
        bool_or(author_kind = 'person' AND source_kind = 'human') AS human,
        first(run_id ORDER BY sent_at DESC, message_id DESC) AS last_run
      FROM numbered GROUP BY thread_id, n
    ), linked AS (
      SELECT *, lead(started_at) OVER (PARTITION BY thread_id ORDER BY started_at) AS next_at
      FROM grouped
    ), kept AS MATERIALIZED (
      SELECT *, concat(thread_id, '@', started_at) AS id, ended_at + ${day} AS until
      FROM linked WHERE ${keep.join(' AND ')}
    ), signals AS (
      -- What a chat's session can end with: outcome signals, and expiries.
      SELECT thread_id, reacted_at AS happened, 'good' AS kind FROM f_reaction WHERE kind = 'up'
      UNION ALL SELECT thread_id, happened_at, CASE event WHEN 'executed' THEN 'good' ELSE 'expired' END
        FROM f_approval WHERE event IN ('executed', 'expired') AND thread_id IS NOT NULL
      -- A page the socio wrote from the chat; a person's "Save as page" is not one.
      UNION ALL SELECT thread_id, written_at, 'good' FROM f_space_write
        WHERE thread_id IS NOT NULL AND author_kind = 'socio'
      UNION ALL SELECT thread_id, kept_at, 'good' FROM f_memory WHERE status = 'active' AND deleted_at IS NULL
    ), flags AS (
      SELECT k.id, bool_or(g.kind = 'good') AS good, bool_or(g.kind = 'expired') AS expired
      FROM kept k JOIN signals g ON g.thread_id = k.thread_id
        AND g.happened BETWEEN k.started_at AND k.until
      GROUP BY k.id
    ), written AS (
      -- A socio's page edits record no chat: one counts for the sessions
      -- of that socio it was made during.
      SELECT DISTINCT k.id FROM kept k JOIN f_space_write w ON w.thread_id IS NULL
        AND w.author_kind = 'socio' AND w.author_id = k.socio_id
        AND w.written_at BETWEEN k.started_at AND k.ended_at
    ), reacted AS (
      SELECT k.id, first(r.kind ORDER BY r.reacted_at DESC, r.message_id DESC, r.person_id DESC, r.kind DESC) AS kind
      FROM kept k JOIN f_reaction r ON r.thread_id = k.thread_id
        AND r.reacted_at BETWEEN k.started_at AND k.until
      GROUP BY k.id
    )
    SELECT k.id, k.thread_id, k.socio_id, k.source, k.started_at, k.ended_at,
      k.messages, k.people, k.socios, k.people_ids,
      CASE
        WHEN (k.next_at IS NULL OR k.next_at > k.until) AND (
          t.status IN ('failed', 'interrupted', 'stopped')
          OR COALESCE(f.expired, false)
          OR r.kind IN ('down', 'retry', 'needs-work'))
        THEN 'abandoned'
        WHEN t.status = 'finished' AND COALESCE(t.end_reason, 'completed') = 'completed'
          AND (COALESCE(f.good, false) OR w.id IS NOT NULL)
        THEN 'completed'
        ELSE 'answered'
      END AS outcome
    FROM kept k LEFT JOIN f_turn t ON t.run_id = k.last_run
    LEFT JOIN flags f ON f.id = k.id LEFT JOIN written w ON w.id = k.id
    LEFT JOIN reacted r ON r.id = k.id)`;
}

/**
 * The sessions of `from`..`to` in a temporary table of this connection,
 * derived once for a request's tiles, both periods and chart; each then
 * takes the sessions that start in its own span (`inSessions`).
 */
export async function sessionTable(connection: DuckDBConnection, options: Parameters<typeof sessions>[1]) {
    const sql = new Sql();
    await connection.run(
        `CREATE OR REPLACE TEMP TABLE q_sessions AS SELECT * FROM ${sessions(sql, options)}`,
        sql.values,
    );
}
export const inSessions = (sql: Sql, from: number, to: number) =>
    `(SELECT * FROM q_sessions WHERE started_at >= ${sql.int(from)} AND started_at < ${sql.int(to)})`;

/** The window's start: all time starts at the oldest fact. */
export async function startOf(connection: DuckDBConnection, window: OpsWindow) {
    if (window.from !== null) {
        return window.from;
    }
    const [row] = await rows<{ lo: number | null }>(
        connection,
        `SELECT least((SELECT min(started_at) FROM f_turn), (SELECT min(sent_at) FROM f_message)) AS lo`,
    );
    return row?.lo ?? null;
}
