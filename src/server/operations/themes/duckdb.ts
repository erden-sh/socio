import type { DuckDBConnection } from '@duckdb/node-api';

import { THEMES_MIN_PEOPLE, type ThemeOutcome } from '@socio/shared/classify';
import type { OpsOutcome } from '@socio/shared/operations/operations-activity';
import type { OpsLabelledSession } from '@socio/shared/operations/operations-themes';

import type { OpsQueries } from '../domain/ops-queries.js';
import { rows } from '../infra/duckdb/open.js';
import { inSessions, sessionTable, startOf } from '../infra/duckdb/sessions.js';
import { Sql } from '../infra/duckdb/sql.js';

import { aggregateThemes } from './aggregate.js';

/**
 * The sessions of `q_sessions` (`sessionTable`) that start in
 * `from`..`to`, each with the intent and themes of its earliest labeled
 * turn (CB-199): a turn is in a session when one of its messages is.
 */
export async function labelledSessions(
    connection: DuckDBConnection,
    from: number,
    to: number,
): Promise<OpsLabelledSession[]> {
    const sql = new Sql();
    const found = await rows<{
        id: string;
        started_at: number;
        outcome: OpsOutcome;
        people: string;
        intent: string | null;
        topic: string | null;
        topic_key: string | null;
        hint: ThemeOutcome | null;
    }>(
        connection,
        `WITH s AS ${inSessions(sql, from, to)},
      sm AS (
        SELECT s.id, m.run_id, m.sent_at, m.message_id
        FROM s JOIN f_message m ON m.thread_id = s.thread_id
          AND m.sent_at BETWEEN s.started_at AND s.ended_at
      ), si AS (
        SELECT sm.id, first(i.intent ORDER BY sm.sent_at, sm.message_id) AS intent
        FROM sm JOIN f_intent i ON i.run_id = sm.run_id GROUP BY sm.id
      ), st AS (
        SELECT sm.id, first(sm.run_id ORDER BY sm.sent_at, sm.message_id) AS theme_run
        FROM sm WHERE sm.run_id IN (SELECT run_id FROM f_theme) GROUP BY sm.id
      )
    SELECT s.id, s.started_at, s.outcome,
      to_json(COALESCE(s.people_ids, []::VARCHAR[]))::VARCHAR AS people,
      si.intent, t.topic, t.topic_key, t.outcome AS hint
    FROM s LEFT JOIN si ON si.id = s.id LEFT JOIN st ON st.id = s.id
      LEFT JOIN f_theme t ON t.run_id = st.theme_run
    ORDER BY s.started_at, s.id, t.topic`,
        sql.values,
    );
    const sessions = new Map<string, OpsLabelledSession & { topics: { topic: string; key: string }[] }>();
    for (const row of found) {
        let session = sessions.get(row.id);
        if (!session) {
            sessions.set(
                row.id,
                (session = {
                    id: row.id,
                    startedAt: row.started_at,
                    outcome: row.outcome,
                    people: JSON.parse(row.people) as string[],
                    intent: row.intent,
                    topics: [],
                    hint: row.hint,
                }),
            );
        }
        if (row.topic !== null && row.topic_key !== null) {
            session.topics.push({ topic: row.topic, key: row.topic_key });
        }
    }
    return [...sessions.values()];
}

/** Themes' query (CB-199), on the analytics connection. */
export function themesQueries(connection: DuckDBConnection): Pick<OpsQueries, 'themes'> {
    return {
        async themes(params) {
            const { window, filters } = params;
            const from = await startOf(connection, window);
            if (from === null) {
                return aggregateThemes([], {
                    from: window.to,
                    to: window.to,
                    timeZone: window.timeZone,
                });
            }
            await sessionTable(connection, {
                from,
                to: window.to,
                gapMs: params.sessionGapMinutes * 60_000,
                filters,
            });
            return aggregateThemes(await labelledSessions(connection, from, window.to), {
                from,
                to: window.to,
                timeZone: window.timeZone,
                minPeople: THEMES_MIN_PEOPLE,
            });
        },
    };
}
