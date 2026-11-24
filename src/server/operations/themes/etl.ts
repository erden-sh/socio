import { listValue } from '@duckdb/node-api';

import { parseTheme, topicKey } from '@socio/shared/classify';

import { append } from '../etl/append.js';
import { ETL_BATCH } from '../etl/source-reader.js';
import type { EtlStep } from '../infra/duckdb/etl.js';
import { sqliteSourceReader } from '../infra/sqlite/source-reader.js';

/**
 * Sessions' intent and themes in force (CB-199), as the app's
 * `classify_labels` has them: one row per labeled turn (the one that
 * opened a session) in `f_intent`, one per topic in `f_theme` with its
 * cluster key (`topicKey`) and the session's outcome hint. Queries give
 * each session the labels of its earliest labeled turn. Topics are the
 * model's or an admin's few words, scrubbed before the model read the
 * chat; nothing else of the chat is copied.
 */
export const INTENT_DDL = `CREATE TABLE f_intent (
  run_id VARCHAR NOT NULL,
  intent VARCHAR NOT NULL,
  rule VARCHAR NOT NULL,
  label_seq BIGINT NOT NULL
)`;
export const THEME_DDL = `CREATE TABLE f_theme (
  run_id VARCHAR NOT NULL,
  topic VARCHAR NOT NULL,
  topic_key VARCHAR NOT NULL,
  outcome VARCHAR NOT NULL,
  rule VARCHAR NOT NULL,
  label_seq BIGINT NOT NULL
)`;

/**
 * Copies new labels by `seq` (the watermark), at most `ETL_BATCH` a
 * batch, the newest per turn and use replacing what was there.
 */
export const sessionLabelsStep: EtlStep = {
    source: 'session_labels',
    ddl: [INTENT_DDL, THEME_DDL],
    async batch({ sqlite, duck, watermark }) {
        const after = Number(watermark ?? 0) || 0;
        const found = sqliteSourceReader(sqlite).sessionLabelsAfter(after, ETL_BATCH);
        if (!found.length) {
            return { caughtUp: true };
        }
        const newest = new Map<string, (typeof found)[number]>();
        for (const label of found) {
            newest.set(`${label.use} ${label.runId}`, label);
        }
        const rule = (label: (typeof found)[number]) =>
            label.source === 'admin' ? 'label:admin' : `label:${label.provider}`;
        const intents = [...newest.values()].filter((l) => l.use === 'intent');
        const themes = [...newest.values()].filter((l) => l.use === 'themes');
        if (intents.length) {
            await duck.run('DELETE FROM f_intent WHERE run_id IN (SELECT unnest($1))', [
                listValue(intents.map((label) => label.runId)),
            ]);
            await append(
                duck,
                'f_intent',
                intents.map((label) => [label.runId, label.label, rule(label), label.seq]),
            );
        }
        if (themes.length) {
            await duck.run('DELETE FROM f_theme WHERE run_id IN (SELECT unnest($1))', [
                listValue(themes.map((label) => label.runId)),
            ]);
            await append(
                duck,
                'f_theme',
                themes.flatMap((label) => {
                    const theme = parseTheme(label.label);
                    if (!theme) {
                        return [];
                    }
                    return theme.topics.flatMap((topic) => {
                        const key = topicKey(topic);
                        return key ? [[label.runId, topic, key, theme.outcome, rule(label), label.seq]] : [];
                    });
                }),
            );
        }
        return {
            watermark: String(found.at(-1)!.seq),
            caughtUp: found.length < ETL_BATCH,
        };
    },
};
