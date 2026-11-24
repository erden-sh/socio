import type { DuckDBConnection } from '@duckdb/node-api';

import { bucketStarts, type OpsBucket, type OpsFilters, type OpsWindow } from '@socio/shared/operations/operations';
import {
    OPS_ACTIVITY_TILES,
    OPS_REPEAT_DAYS,
    OPS_RETURN_DAYS,
    OPS_VALUE_TILES,
    type OpsActivityPoint,
    type OpsActivityTileId,
    type OpsChatRow,
    type OpsOutcome,
    type OpsPersonRow,
    type OpsSessionRow,
    type OpsSocioRow,
    type OpsValuePoint,
    type OpsValueTileId,
} from '@socio/shared/operations/operations-activity';

import type { OpsQueries, OpsQueryParams } from '../../domain/ops-queries.js';
import { intentRows } from '../../themes/aggregate.js';
import { labelledSessions } from '../../themes/duckdb.js';

import { rows } from './open.js';
import { inSessions, sessions, sessionTable, startOf } from './sessions.js';
import { calendarTable, messageFilters, range, rollupMeta, spaceFilter, Sql, turnFilters } from './sql.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const KEY_COLUMN: Record<OpsBucket, string> = {
    hour: 'hour_at',
    day: 'day_at',
    week: 'week_at',
    month: 'month_at',
};

type Sessioned = OpsQueryParams<'value'>;

/** People's messages in turns from a `human` source (CB-164). */
function humanMessages(sql: Sql, from: number | null, to: number, filters: OpsFilters) {
    return `SELECT * FROM f_message WHERE ${[
        ...range(sql, 'sent_at', from, to),
        ...messageFilters(sql, filters),
        `source IN (SELECT key FROM d_source WHERE kind = 'human')`,
    ].join(' AND ')}`;
}

/** Every message (anyone's) in the window, by the socio, Space and source filters. */
function chatMessages(sql: Sql, from: number | null, to: number, filters: OpsFilters) {
    return `SELECT * FROM f_message WHERE ${[
        ...range(sql, 'sent_at', from, to),
        ...(filters.socio ? [`socio_id = ${sql.text(filters.socio)}`] : []),
        ...(filters.space ? [spaceFilter(sql, 'socio_id', filters.space)] : []),
        ...(filters.source ? [`source = ${sql.text(filters.source)}`] : []),
    ].join(' AND ')}`;
}

/** The chats whose turns came from a source, for facts that only know their chat. */
const threadsOf = (sql: Sql, source: string) =>
    `(SELECT DISTINCT thread_id FROM f_turn WHERE source = ${sql.text(source)})`;

/** The calendar covering `lo`..`hi` in the window's time zone. */
async function calendar(connection: DuckDBConnection, window: OpsWindow, lo: number, hi: number) {
    return calendarTable(connection, window, await rollupMeta(connection), lo, hi);
}

const shareOf = (part: number, whole: number) => (whole > 0 ? part / whole : null);

/** Activity's tiles over one period. */
async function activityTiles(
    connection: DuckDBConnection,
    cal: string,
    params: Sessioned,
    from: number,
    to: number,
    before: { from: number; to: number } | null,
): Promise<Record<OpsActivityTileId, number | null>> {
    const { filters } = params;
    const sql = new Sql();
    const days = bucketStarts(from, to, 'day', params.window.timeZone);
    const [row] = await rows<{
        people: number;
        returning: number;
        sessions: number;
        chats: number;
        messages: number;
        dau: number;
        wau: number;
    }>(
        connection,
        `WITH now_m AS (${humanMessages(sql, from, to, filters)}),
      s AS ${inSessions(sql, from, to)},
      a AS (
        SELECT DISTINCT m.author_id AS p, c.day_at AS d
        FROM (${humanMessages(sql, from - 8 * DAY, to, filters)}) m
        ASOF JOIN ${cal} c ON m.sent_at >= c.utc_at
      ), days AS (${days.length ? `SELECT unnest(${sql.ints(days)}) AS d` : 'SELECT NULL::BIGINT AS d WHERE false'})
    SELECT
      (SELECT count(DISTINCT author_id) FROM now_m) AS people,
      ${
          before
              ? `(SELECT count(*) FROM (SELECT DISTINCT author_id FROM now_m
              INTERSECT SELECT DISTINCT author_id FROM (${humanMessages(sql, before.from, before.to, filters)})))`
              : 'NULL'
      } AS returning,
      (SELECT count(*) FROM s) AS sessions,
      (SELECT COALESCE(sum(messages), 0)::BIGINT FROM s) AS messages,
      (SELECT count(DISTINCT thread_id) FROM now_m) AS chats,
      (SELECT count(*) FROM a JOIN days USING (d)) AS dau,
      (SELECT count(*) FROM (SELECT DISTINCT days.d, a.p FROM days JOIN a
        ON a.d <= days.d AND a.d > days.d - ${sql.int(7 * DAY - 2 * HOUR)})) AS wau`,
        sql.values,
    );
    const r = row!;
    return {
        people: r.people,
        returning: before ? r.returning : null,
        stickiness: shareOf(r.dau, r.wau),
        sessions: r.sessions,
        chats: r.chats,
        length: shareOf(r.messages, r.sessions),
    };
}

/** Value's tiles over one period. */
async function valueTiles(
    connection: DuckDBConnection,
    cal: string,
    params: Sessioned,
    from: number,
    to: number,
): Promise<Record<OpsValueTileId, number | null>> {
    const sql = new Sql();
    const [row] = await rows<{
        completed: number;
        answered: number;
        abandoned: number;
        chats: number;
        resumed: number;
    }>(
        connection,
        `WITH s AS ${inSessions(sql, from, to)},
      d AS (
        SELECT m.thread_id, count(DISTINCT c.day_at) AS days
        FROM (${humanMessages(sql, from, to, params.filters)}) m
        ASOF JOIN ${cal} c ON m.sent_at >= c.utc_at GROUP BY m.thread_id
      )
    SELECT
      (SELECT count(*) FROM s WHERE outcome = 'completed') AS completed,
      (SELECT count(*) FROM s WHERE outcome = 'answered') AS answered,
      (SELECT count(*) FROM s WHERE outcome = 'abandoned') AS abandoned,
      (SELECT count(*) FROM d) AS chats,
      (SELECT count(*) FROM d WHERE days >= 2) AS resumed`,
        sql.values,
    );
    const r = row!;
    return {
        completed: r.completed,
        answered: r.answered,
        abandoned: r.abandoned,
        completedShare: shareOf(r.completed, r.completed + r.answered + r.abandoned),
        resumption: shareOf(r.resumed, r.chats),
    };
}

/** Per-bucket values from rows keyed by a time, bucketed by the calendar. */
async function bucketed<T extends string>(
    connection: DuckDBConnection,
    sql: Sql,
    cal: string,
    bucket: OpsBucket,
    facts: string,
    values: Record<T, string>,
) {
    const key = KEY_COLUMN[bucket];
    const found = await rows<Record<T | 'k', number>>(
        connection,
        `SELECT c.${key} AS k, ${Object.entries(values)
            .map(([name, value]) => `(${value as string})::BIGINT AS ${name}`)
            .join(', ')}
    FROM (${facts}) f ASOF JOIN ${cal} c ON f.ts >= c.utc_at GROUP BY c.${key}`,
        sql.values,
    );
    return new Map(found.map((row) => [row.k, row]));
}

/** Keyset, newest first: after the cursor's (key, id). */
function after(sql: Sql, cursor: { key: number | string; id: string } | undefined, key: string, id: string) {
    if (!cursor) {
        return [];
    }
    if (typeof cursor.key !== 'number') {
        return ['false'];
    }
    const at = sql.int(cursor.key);
    return [`(${key} < ${at} OR (${key} = ${at} AND ${id} < ${sql.text(cursor.id)}))`];
}

function paged<T>(found: T[], limit: number, key: (row: T) => [number, string]) {
    const items = found.slice(0, limit);
    const last = items.at(-1);
    return {
        items,
        next: found.length > limit && last ? { key: key(last)[0], id: key(last)[1] } : null,
    };
}

/** Activity's and Value's queries (CB-190), on the analytics connection. */
export function activityQueries(
    connection: DuckDBConnection,
): Pick<OpsQueries, 'activity' | 'value' | 'activityPeople' | 'activitySocios' | 'activityChats' | 'activitySessions'> {
    return {
        async activity(params) {
            const { window, filters } = params;
            const from = await startOf(connection, window);
            const empty = {
                tiles: OPS_ACTIVITY_TILES.map((id) => ({
                    id,
                    value: null,
                    previous: null,
                })),
                points: [],
                sources: [],
                participation: {
                    chats: 0,
                    withSeveralPeople: 0,
                    withSeveralSocios: 0,
                    collaboration: 0,
                },
                features: [],
                spaces: [],
            };
            if (from === null) {
                return empty;
            }
            const { to, previous } = window;
            const lo = Math.min(from, previous?.from ?? from) - 9 * DAY;
            const cal = await calendar(connection, window, lo, to + DAY);
            const gapMs = params.sessionGapMinutes * 60_000;
            await sessionTable(connection, {
                from: Math.min(from, previous?.from ?? from),
                to,
                gapMs,
                filters,
            });
            const now = await activityTiles(connection, cal, params, from, to, previous);
            const before = previous
                ? await activityTiles(connection, cal, params, previous.from, previous.to, {
                      from: previous.from - (to - from),
                      to: previous.from,
                  })
                : undefined;
            const tiles = OPS_ACTIVITY_TILES.map((id) => ({
                id,
                value: now[id],
                previous: before ? before[id] : null,
            }));

            // The chart: people, sessions and people's messages per bucket.
            const starts = bucketStarts(from, to, window.bucket, window.timeZone);
            const sql = new Sql();
            const byBucket = await bucketed(
                connection,
                sql,
                cal,
                window.bucket,
                `SELECT sent_at AS ts, author_id AS person, 1 AS message, 0 AS session
          FROM (${humanMessages(sql, from, to, filters)})
        UNION ALL SELECT started_at, NULL, 0, 1 FROM ${inSessions(sql, from, to)}`,
                {
                    people: 'count(DISTINCT f.person)',
                    sessions: 'sum(f.session)',
                    messages: 'sum(f.message)',
                },
            );
            const points = starts.map((at): OpsActivityPoint => {
                const row = byBucket.get(at);
                return {
                    at,
                    people: row?.people ?? 0,
                    sessions: row?.sessions ?? 0,
                    messages: row?.messages ?? 0,
                };
            });

            const q = new Sql();
            const turns = `SELECT * FROM f_turn WHERE ${[...range(q, 'started_at', from, to), ...turnFilters(q, filters)].join(' AND ')}`;
            const sources = await rows<{
                key: string;
                label: string;
                kind: 'human' | 'automation' | 'unknown';
                turns: number;
                messages: number;
                people: number;
            }>(
                connection,
                `WITH t AS (SELECT source, count(*) AS n FROM (${turns}) GROUP BY source),
          m AS (SELECT source, count(*) AS n, count(DISTINCT author_id) AS p
            FROM (${messageOnly(q, from, to, filters)}) GROUP BY source)
        SELECT k.key, COALESCE(d.label, k.key) AS label, COALESCE(d.kind, 'unknown') AS kind,
          COALESCE(t.n, 0)::BIGINT AS turns, COALESCE(m.n, 0)::BIGINT AS messages,
          COALESCE(m.p, 0)::BIGINT AS people
        FROM (SELECT source AS key FROM t UNION SELECT source FROM m) k
        LEFT JOIN t ON t.source = k.key LEFT JOIN m ON m.source = k.key
        LEFT JOIN d_source d ON d.key = k.key
        ORDER BY turns DESC, messages DESC, k.key`,
                q.values,
            );

            const p = new Sql();
            const [participation] = await rows<{
                chats: number;
                several_people: number;
                several_socios: number;
                collaboration: number;
            }>(
                connection,
                `WITH c AS (
            SELECT thread_id, count(DISTINCT author_id) AS people
            FROM (${humanMessages(p, from, to, filters)}) GROUP BY thread_id
          ), s AS (
            SELECT thread_id, count(DISTINCT author_id) AS socios
            FROM (${chatMessages(p, from, to, filters)}) WHERE author_kind = 'socio' GROUP BY thread_id
          )
        SELECT (SELECT count(*) FROM c) AS chats,
          (SELECT count(*) FROM c WHERE people >= 2) AS several_people,
          (SELECT count(*) FROM c JOIN s USING (thread_id) WHERE socios >= 2) AS several_socios,
          (SELECT count(*) FROM (SELECT * FROM f_turn WHERE ${[...range(p, 'started_at', from, to), ...turnFilters(p, filters)].join(' AND ')})
            WHERE trigger_kind = 'socio' AND trigger_id IS DISTINCT FROM socio_id) AS collaboration`,
                p.values,
            );

            const f = new Sql();
            const map = params.capabilities;
            const features = await rows<{
                id: string;
                tools: unknown;
                calls: number;
                people: number;
                socios: number;
                errors: number;
                refusals: number;
            }>(
                connection,
                `WITH caps AS (${
                    map.length
                        ? `SELECT unnest(${f.texts(map.map((m) => m.tool))}) AS tool,
            unnest(${f.texts(map.map((m) => m.capability))}) AS capability`
                        : 'SELECT NULL::VARCHAR AS tool, NULL::VARCHAR AS capability WHERE false'
                })
        SELECT COALESCE(c.capability, 'tool:' || x.tool) AS id,
          list(DISTINCT x.tool ORDER BY x.tool) AS tools,
          count(*)::BIGINT AS calls,
          (count(DISTINCT x.trigger_id) FILTER (WHERE x.trigger_kind = 'person'))::BIGINT AS people,
          count(DISTINCT x.socio_id)::BIGINT AS socios,
          (count(*) FILTER (WHERE x.outcome IN ('error', 'timeout')))::BIGINT AS errors,
          (count(*) FILTER (WHERE x.outcome = 'refused'))::BIGINT AS refusals
        FROM (SELECT * FROM f_tool WHERE ${[...range(f, 'started_at', from, to), ...turnFilters(f, filters)].join(' AND ')}) x
        LEFT JOIN (SELECT tool, min(capability) AS capability FROM caps GROUP BY tool) c ON c.tool = x.tool
        GROUP BY 1 ORDER BY calls DESC, id`,
                f.values,
            );

            const w = new Sql();
            const writes = [
                ...range(w, 'written_at', from, to),
                ...(filters.space ? [`space_id = ${w.text(filters.space)}`] : []),
                ...(filters.socio ? [`author_kind = 'socio' AND author_id = ${w.text(filters.socio)}`] : []),
                ...(filters.person ? [`author_kind = 'person' AND author_id = ${w.text(filters.person)}`] : []),
                ...(filters.source ? [`thread_id IN ${threadsOf(w, filters.source)}`] : []),
            ];
            const spaceTurns = `SELECT * FROM f_turn WHERE ${[...range(w, 'started_at', from, to), ...turnFilters(w, filters)].join(' AND ')}`;
            const spaces = await rows<{
                space_id: string;
                name: string | null;
                by_people: number;
                by_socios: number;
                pages: number;
                people: number;
                socios: number;
                turns: number;
            }>(
                connection,
                `WITH wr AS (
            SELECT space_id, (count(*) FILTER (WHERE author_kind = 'person'))::BIGINT AS by_people,
              (count(*) FILTER (WHERE author_kind = 'socio'))::BIGINT AS by_socios,
              count(DISTINCT page_id)::BIGINT AS pages
            FROM f_space_write WHERE ${writes.join(' AND ')} GROUP BY space_id
          ), pe AS (
            SELECT s.space_id, count(DISTINCT m.author_id)::BIGINT AS people
            FROM (${humanMessages(w, from, to, filters)}) m JOIN d_socio s ON s.id = m.socio_id
            GROUP BY s.space_id
          ), tu AS (
            SELECT s.space_id, count(*)::BIGINT AS turns, count(DISTINCT t.socio_id)::BIGINT AS socios
            FROM (${spaceTurns}) t JOIN d_socio s ON s.id = t.socio_id GROUP BY s.space_id
          ), k AS (SELECT space_id FROM wr UNION SELECT space_id FROM pe UNION SELECT space_id FROM tu)
        SELECT k.space_id, sp.name, COALESCE(wr.by_people, 0) AS by_people,
          COALESCE(wr.by_socios, 0) AS by_socios, COALESCE(wr.pages, 0) AS pages,
          COALESCE(pe.people, 0) AS people, COALESCE(tu.socios, 0) AS socios,
          COALESCE(tu.turns, 0) AS turns
        FROM k LEFT JOIN wr USING (space_id) LEFT JOIN pe USING (space_id)
        LEFT JOIN tu USING (space_id) LEFT JOIN d_space sp ON sp.id = k.space_id
        ORDER BY COALESCE(wr.by_people, 0) + COALESCE(wr.by_socios, 0) DESC,
          COALESCE(tu.turns, 0) DESC, k.space_id`,
                w.values,
            );

            return {
                tiles,
                points,
                sources: sources.map((row) => ({ ...row })),
                participation: {
                    chats: participation!.chats,
                    withSeveralPeople: participation!.several_people,
                    withSeveralSocios: participation!.several_socios,
                    collaboration: participation!.collaboration,
                },
                features: features.map((row) => ({
                    ...row,
                    tools: textList(row.tools),
                })),
                spaces: spaces.map((row) => ({
                    spaceId: row.space_id,
                    name: row.name,
                    writesByPeople: row.by_people,
                    writesBySocios: row.by_socios,
                    pages: row.pages,
                    people: row.people,
                    socios: row.socios,
                    turns: row.turns,
                })),
            };
        },

        async value(params) {
            const { window, filters } = params;
            const from = await startOf(connection, window);
            if (from === null) {
                return {
                    tiles: OPS_VALUE_TILES.map((id) => ({
                        id,
                        value: null,
                        previous: null,
                    })),
                    points: [],
                    approvals: [],
                    reactions: {
                        socioMessages: 0,
                        reacted: 0,
                        up: 0,
                        down: 0,
                        retry: 0,
                        needsWork: 0,
                    },
                    intents: [],
                };
            }
            const { to, previous } = window;
            const cal = await calendar(connection, window, Math.min(from, previous?.from ?? from) - DAY, to + DAY);
            await sessionTable(connection, {
                from: Math.min(from, previous?.from ?? from),
                to,
                gapMs: params.sessionGapMinutes * 60_000,
                filters,
            });
            const now = await valueTiles(connection, cal, params, from, to);
            const before = previous ? await valueTiles(connection, cal, params, previous.from, previous.to) : undefined;
            const tiles = OPS_VALUE_TILES.map((id) => ({
                id,
                value: now[id],
                previous: before ? before[id] : null,
            }));

            const sql = new Sql();
            const byBucket = await bucketed(
                connection,
                sql,
                cal,
                window.bucket,
                `SELECT started_at AS ts, outcome FROM ${inSessions(sql, from, to)}`,
                {
                    completed: `count(*) FILTER (WHERE f.outcome = 'completed')`,
                    answered: `count(*) FILTER (WHERE f.outcome = 'answered')`,
                    abandoned: `count(*) FILTER (WHERE f.outcome = 'abandoned')`,
                },
            );
            const points = bucketStarts(from, to, window.bucket, window.timeZone).map((at): OpsValuePoint => {
                const row = byBucket.get(at);
                return {
                    at,
                    completed: row?.completed ?? 0,
                    answered: row?.answered ?? 0,
                    abandoned: row?.abandoned ?? 0,
                };
            });

            const a = new Sql();
            const approvals = await rows<{
                capability: string;
                requested: number;
                approved: number;
                denied: number;
                expired: number;
                executed: number;
                failed: number;
            }>(
                connection,
                `SELECT capability,
          (count(*) FILTER (WHERE event = 'requested'))::BIGINT AS requested,
          (count(*) FILTER (WHERE event IN ('approved', 'auto_approved', 'bypassed')))::BIGINT AS approved,
          (count(*) FILTER (WHERE event IN ('denied', 'auto_denied')))::BIGINT AS denied,
          (count(*) FILTER (WHERE event = 'expired'))::BIGINT AS expired,
          (count(*) FILTER (WHERE event = 'executed'))::BIGINT AS executed,
          (count(*) FILTER (WHERE event = 'failed'))::BIGINT AS failed
        FROM f_approval WHERE ${[
            ...range(a, 'happened_at', from, to),
            `event IN ('requested', 'approved', 'auto_approved', 'bypassed', 'denied', 'auto_denied', 'expired', 'executed', 'failed')`,
            ...(filters.socio ? [`socio_id = ${a.text(filters.socio)}`] : []),
            ...(filters.space ? [spaceFilter(a, 'socio_id', filters.space)] : []),
            ...(filters.person ? [`person_id = ${a.text(filters.person)}`] : []),
            ...(filters.source ? [`thread_id IN ${threadsOf(a, filters.source)}`] : []),
        ].join(' AND ')}
        GROUP BY capability ORDER BY requested DESC, capability`,
                a.values,
            );

            const r = new Sql();
            const socioMessages = `SELECT * FROM (${chatMessages(r, from, to, filters)}) WHERE author_kind = 'socio'${
                filters.person
                    ? ` AND run_id IN (SELECT run_id FROM f_turn WHERE trigger_kind = 'person' AND trigger_id = ${r.text(filters.person)})`
                    : ''
            }`;
            const [reactions] = await rows<{
                socio_messages: number;
                reacted: number;
                up: number;
                down: number;
                retry: number;
                needs_work: number;
            }>(
                connection,
                `WITH sm AS (${socioMessages}),
          rx AS (SELECT r.* FROM f_reaction r JOIN sm ON sm.thread_id = r.thread_id AND sm.message_id = r.message_id)
        SELECT (SELECT count(*) FROM sm) AS socio_messages,
          (SELECT count(*) FROM (SELECT DISTINCT thread_id, message_id FROM rx)) AS reacted,
          (SELECT count(*) FROM rx WHERE kind = 'up') AS up,
          (SELECT count(*) FROM rx WHERE kind = 'down') AS down,
          (SELECT count(*) FROM rx WHERE kind = 'retry') AS retry,
          (SELECT count(*) FROM rx WHERE kind = 'needs-work') AS needs_work`,
                r.values,
            );
            return {
                tiles,
                points,
                approvals: approvals.filter(
                    (row) => row.requested + row.approved + row.denied + row.expired + row.executed + row.failed > 0,
                ),
                reactions: {
                    socioMessages: reactions!.socio_messages,
                    reacted: reactions!.reacted,
                    up: reactions!.up,
                    down: reactions!.down,
                    retry: reactions!.retry,
                    needsWork: reactions!.needs_work,
                },
                intents: intentRows(await labelledSessions(connection, from, to)),
            };
        },

        async activityPeople(params) {
            const { window, filters, cursor, limit } = params;
            const from = await startOf(connection, window);
            if (from === null) {
                return { items: [], next: null };
            }
            const cal = await calendar(connection, window, from - DAY, window.to + DAY);
            const sql = new Sql();
            const gapMs = params.sessionGapMinutes * 60_000;
            const found = await rows<{
                person_id: string;
                name: string | null;
                messages: number;
                sessions: number;
                chats: number;
                socios: number;
                active_days: number;
                tool_calls: number;
                completed: number;
                last_at: number;
            }>(
                connection,
                `WITH m AS (${humanMessages(sql, from, window.to, filters)}),
          per AS (
            SELECT m.author_id AS person_id, count(*)::BIGINT AS messages,
              count(DISTINCT m.thread_id)::BIGINT AS chats,
              count(DISTINCT m.socio_id)::BIGINT AS socios,
              count(DISTINCT c.day_at)::BIGINT AS active_days,
              max(m.sent_at) AS last_at
            FROM m ASOF JOIN ${cal} c ON m.sent_at >= c.utc_at GROUP BY m.author_id
          ), s AS (
            SELECT unnest(people_ids) AS person_id, outcome
            FROM ${sessions(sql, { from, to: window.to, gapMs, filters })}
          ), ss AS (
            SELECT person_id, count(*)::BIGINT AS sessions,
              (count(*) FILTER (WHERE outcome = 'completed'))::BIGINT AS completed
            FROM s GROUP BY person_id
          ), tl AS (
            SELECT trigger_id AS person_id, count(*)::BIGINT AS tool_calls
            FROM f_tool WHERE ${[...range(sql, 'started_at', from, window.to), ...turnFilters(sql, filters), `trigger_kind = 'person'`].join(' AND ')}
            GROUP BY trigger_id
          )
        SELECT per.*, d.name, COALESCE(ss.sessions, 0) AS sessions,
          COALESCE(ss.completed, 0) AS completed, COALESCE(tl.tool_calls, 0) AS tool_calls
        FROM per LEFT JOIN ss USING (person_id) LEFT JOIN tl USING (person_id)
        LEFT JOIN d_person d ON d.id = per.person_id
        WHERE ${['true', ...after(sql, cursor, 'per.last_at', 'per.person_id')].join(' AND ')}
        ORDER BY per.last_at DESC, per.person_id DESC LIMIT ${limit + 1}`,
                sql.values,
            );
            return paged(
                found.map((row): OpsPersonRow => ({
                    personId: row.person_id,
                    name: row.name,
                    messages: row.messages,
                    sessions: row.sessions,
                    chats: row.chats,
                    socios: row.socios,
                    activeDays: row.active_days,
                    toolCalls: row.tool_calls,
                    completed: row.completed,
                    lastAt: row.last_at,
                })),
                limit,
                (row) => [row.lastAt, row.personId],
            );
        },

        async activitySocios(params) {
            const { window, filters, cursor, limit } = params;
            const from = await startOf(connection, window);
            if (from === null) {
                return { items: [], next: null };
            }
            const to = window.to;
            const repeatFrom = to - OPS_REPEAT_DAYS * DAY;
            const cal = await calendar(connection, window, Math.min(from, repeatFrom) - DAY, to + DAY);
            const sql = new Sql();
            const gapMs = params.sessionGapMinutes * 60_000;
            // Return visits: any people's session with the socio, unfiltered.
            const later = sessions(sql, {
                from,
                to: to + OPS_RETURN_DAYS * DAY + DAY,
                gapMs,
                filters: {},
            });
            const found = await rows<{
                socio_id: string;
                name: string | null;
                people: number;
                messages: number;
                chats: number;
                sessions: number;
                session_messages: number;
                session_chats: number;
                turns: number;
                collaboration: number;
                completed: number;
                answered: number;
                abandoned: number;
                repeat_people: number;
                repeat_twice: number;
                session_people: number;
                returned: number;
                last_at: number;
            }>(
                connection,
                `WITH m AS (${humanMessages(sql, from, to, filters)}),
          per AS (
            SELECT socio_id, count(DISTINCT author_id)::BIGINT AS people, count(*)::BIGINT AS messages,
              count(DISTINCT thread_id)::BIGINT AS chats, max(sent_at) AS last_at
            FROM m WHERE socio_id IS NOT NULL GROUP BY socio_id
          ), s AS (SELECT * FROM ${sessions(sql, { from, to, gapMs, filters })}),
          ss AS (
            SELECT socio_id, count(*)::BIGINT AS sessions, sum(messages)::BIGINT AS session_messages,
              count(DISTINCT thread_id)::BIGINT AS session_chats,
              (count(*) FILTER (WHERE outcome = 'completed'))::BIGINT AS completed,
              (count(*) FILTER (WHERE outcome = 'answered'))::BIGINT AS answered,
              (count(*) FILTER (WHERE outcome = 'abandoned'))::BIGINT AS abandoned
            FROM s GROUP BY socio_id
          ), tu AS (
            SELECT socio_id, count(*)::BIGINT AS turns,
              (count(*) FILTER (WHERE trigger_kind = 'socio' AND trigger_id IS DISTINCT FROM socio_id))::BIGINT AS collaboration
            FROM f_turn WHERE ${[...range(sql, 'started_at', from, to), ...turnFilters(sql, filters)].join(' AND ')}
            GROUP BY socio_id
          ), rp AS (
            SELECT socio_id, count(*)::BIGINT AS repeat_people,
              (count(*) FILTER (WHERE days >= 2))::BIGINT AS repeat_twice
            FROM (
              SELECT r.socio_id, r.author_id, count(DISTINCT c.day_at) AS days
              FROM (${humanMessages(sql, repeatFrom, to, filters)}) r
              ASOF JOIN ${cal} c ON r.sent_at >= c.utc_at GROUP BY r.socio_id, r.author_id
            ) GROUP BY socio_id
          ), sp AS (
            SELECT DISTINCT s.socio_id, unnest(s.people_ids) AS person_id, s.ended_at FROM s
          ), lt AS (SELECT socio_id, unnest(people_ids) AS person_id, started_at FROM ${later}),
          rr AS (
            SELECT socio_id, count(DISTINCT person_id)::BIGINT AS session_people,
              (count(DISTINCT person_id) FILTER (WHERE back))::BIGINT AS returned
            FROM (
              SELECT sp.socio_id, sp.person_id, EXISTS (
                SELECT 1 FROM lt WHERE lt.socio_id = sp.socio_id AND lt.person_id = sp.person_id
                  AND lt.started_at > sp.ended_at AND lt.started_at <= sp.ended_at + ${sql.int(OPS_RETURN_DAYS * DAY)}
              ) AS back FROM sp
            ) GROUP BY socio_id
          )
        SELECT per.*, d.name, COALESCE(ss.sessions, 0) AS sessions,
          COALESCE(ss.session_messages, 0) AS session_messages, COALESCE(ss.session_chats, 0) AS session_chats,
          COALESCE(ss.completed, 0) AS completed, COALESCE(ss.answered, 0) AS answered,
          COALESCE(ss.abandoned, 0) AS abandoned, COALESCE(tu.turns, 0) AS turns,
          COALESCE(tu.collaboration, 0) AS collaboration, COALESCE(rp.repeat_people, 0) AS repeat_people,
          COALESCE(rp.repeat_twice, 0) AS repeat_twice, COALESCE(rr.session_people, 0) AS session_people,
          COALESCE(rr.returned, 0) AS returned
        FROM per LEFT JOIN ss USING (socio_id) LEFT JOIN tu USING (socio_id)
        LEFT JOIN rp USING (socio_id) LEFT JOIN rr USING (socio_id)
        LEFT JOIN d_socio d ON d.id = per.socio_id
        WHERE ${['true', ...after(sql, cursor, 'per.last_at', 'per.socio_id')].join(' AND ')}
        ORDER BY per.last_at DESC, per.socio_id DESC LIMIT ${limit + 1}`,
                sql.values,
            );
            return paged(
                found.map((row): OpsSocioRow => ({
                    socioId: row.socio_id,
                    name: row.name,
                    people: row.people,
                    sessions: row.sessions,
                    chats: row.chats,
                    messages: row.messages,
                    turns: row.turns,
                    perChat: row.session_chats ? row.session_messages / row.session_chats : 0,
                    repeatUse: shareOf(row.repeat_twice, row.repeat_people),
                    collaboration: row.collaboration,
                    completed: row.completed,
                    answered: row.answered,
                    abandoned: row.abandoned,
                    returnRate: shareOf(row.returned, row.session_people),
                    lastAt: row.last_at,
                })),
                limit,
                (row) => [row.lastAt, row.socioId],
            );
        },

        async activityChats(params) {
            const { window, filters, cursor, limit } = params;
            const from = await startOf(connection, window);
            if (from === null) {
                return { items: [], next: null };
            }
            const to = window.to;
            const cal = await calendar(connection, window, from - DAY, to + DAY);
            const sql = new Sql();
            const gapMs = params.sessionGapMinutes * 60_000;
            const found = await rows<{
                thread_id: string;
                socio_id: string | null;
                socio_name: string | null;
                owner_kind: 'person' | 'team' | 'room' | null;
                people: number;
                socios: number;
                messages: number;
                sessions: number;
                active_days: number;
                last_at: number;
            }>(
                connection,
                `WITH p AS (${humanMessages(sql, from, to, { ...filters, person: undefined })}),
          a AS (${chatMessages(sql, from, to, filters)}),
          pc AS (
            SELECT p.thread_id, count(DISTINCT p.author_id)::BIGINT AS people,
              count(DISTINCT c.day_at)::BIGINT AS active_days
            FROM p ASOF JOIN ${cal} c ON p.sent_at >= c.utc_at GROUP BY p.thread_id
            ${filters.person ? `HAVING bool_or(p.author_id = ${sql.text(filters.person)})` : ''}
          ), ac AS (
            SELECT thread_id, max(socio_id) AS socio_id, count(*)::BIGINT AS messages,
              (count(DISTINCT author_id) FILTER (WHERE author_kind = 'socio'))::BIGINT AS socios,
              max(sent_at) AS last_at
            FROM a GROUP BY thread_id
          ), ss AS (
            SELECT thread_id, count(*)::BIGINT AS sessions
            FROM ${sessions(sql, { from, to, gapMs, filters })} GROUP BY thread_id
          )
        SELECT pc.thread_id, COALESCE(ch.socio_id, ac.socio_id) AS socio_id, d.name AS socio_name,
          ch.owner_kind, pc.people, ac.socios, ac.messages, COALESCE(ss.sessions, 0) AS sessions,
          pc.active_days, ac.last_at
        FROM pc JOIN ac USING (thread_id) LEFT JOIN ss USING (thread_id)
        LEFT JOIN d_chat ch ON ch.id = pc.thread_id
        LEFT JOIN d_socio d ON d.id = COALESCE(ch.socio_id, ac.socio_id)
        WHERE ${['true', ...after(sql, cursor, 'ac.last_at', 'pc.thread_id')].join(' AND ')}
        ORDER BY ac.last_at DESC, pc.thread_id DESC LIMIT ${limit + 1}`,
                sql.values,
            );
            return paged(
                found.map((row): OpsChatRow => ({
                    threadId: row.thread_id,
                    socioId: row.socio_id,
                    socioName: row.socio_name,
                    ownerKind: row.owner_kind,
                    people: row.people,
                    socios: row.socios,
                    messages: row.messages,
                    sessions: row.sessions,
                    activeDays: row.active_days,
                    resumed: row.active_days >= 2,
                    lastAt: row.last_at,
                })),
                limit,
                (row) => [row.lastAt, row.threadId],
            );
        },

        async activitySessions(params) {
            const { window, filters, cursor, limit, outcome } = params;
            const from = await startOf(connection, window);
            if (from === null) {
                return { items: [], next: null };
            }
            const sql = new Sql();
            const where = [
                'true',
                ...(outcome ? [`s.outcome = ${sql.text(outcome)}`] : []),
                ...after(sql, cursor, 's.started_at', 's.id'),
            ];
            const found = await rows<{
                id: string;
                thread_id: string;
                socio_id: string | null;
                socio_name: string | null;
                source: string;
                started_at: number;
                ended_at: number;
                messages: number;
                people: number;
                socios: number;
                outcome: OpsOutcome;
            }>(
                connection,
                `SELECT s.id, s.thread_id, s.socio_id, d.name AS socio_name, s.source, s.started_at,
          s.ended_at, s.messages, s.people, s.socios, s.outcome
        FROM ${sessions(sql, { from, to: window.to, gapMs: params.sessionGapMinutes * 60_000, filters })} s
        LEFT JOIN d_socio d ON d.id = s.socio_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.started_at DESC, s.id DESC LIMIT ${limit + 1}`,
                sql.values,
            );
            return paged(
                found.map((row): OpsSessionRow => ({
                    id: row.id,
                    threadId: row.thread_id,
                    socioId: row.socio_id,
                    socioName: row.socio_name,
                    source: row.source,
                    startedAt: row.started_at,
                    endedAt: row.ended_at,
                    messages: row.messages,
                    people: row.people,
                    socios: row.socios,
                    outcome: row.outcome,
                })),
                limit,
                (row) => [row.startedAt, row.id],
            );
        },
    };
}

/** A DuckDB LIST as strings (the binding gives `{ items }`). */
function textList(value: unknown): string[] {
    const items = Array.isArray(value) ? value : ((value as { items?: unknown[] } | null)?.items ?? []);
    return items.map(String);
}

/** People's messages in the window by any source (for the sources table). */
function messageOnly(sql: Sql, from: number | null, to: number, filters: OpsFilters) {
    return `SELECT * FROM f_message WHERE ${[...range(sql, 'sent_at', from, to), ...messageFilters(sql, filters)].join(
        ' AND ',
    )}`;
}
