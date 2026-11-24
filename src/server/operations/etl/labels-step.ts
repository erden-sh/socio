import { listValue, type DuckDBConnection } from '@duckdb/node-api';

import type { EtlStep } from '../infra/duckdb/etl.js';
import { sqliteSourceReader } from '../infra/sqlite/source-reader.js';

import { append } from './append.js';
import { ETL_BATCH } from './source-reader.js';

/**
 * Failure labels (CB-198): the label in force per failed turn
 * (`idx` -1) or tool call (its place in the trace), an admin's or the
 * model's once applied, as the app's `classify_labels` has them. A label
 * replaces the rules' category only where the rules say Unclassified,
 * so a rule that learns to sort a failure wins over its label. Its rule
 * reads `label:admin`, or `label:` and the provider.
 */
export const LABEL_DDL = `CREATE TABLE f_label (
  run_id VARCHAR NOT NULL,
  idx INTEGER NOT NULL,
  category VARCHAR NOT NULL,
  rule VARCHAR NOT NULL,
  label_seq BIGINT NOT NULL
)`;

/**
 * Writes the labels in force over the facts the rules left Unclassified
 * (or labeled before): every turn and tool call, or only the turns
 * `seqs` (the runs step's batch).
 */
export async function applyLabels(duck: DuckDBConnection, seqs?: number[]) {
    const only = seqs ? listValue(seqs.map((seq) => BigInt(seq))) : undefined;
    if (only && !seqs!.length) {
        return;
    }
    const turnScope = only ? 'AND f_turn.seq IN (SELECT unnest($1))' : '';
    const toolScope = only ? 'AND f_tool.run_seq IN (SELECT unnest($1))' : '';
    await duck.run(
        `UPDATE f_turn SET failure_category = l.category, failure_rule = l.rule
    FROM f_label l
    WHERE l.run_id = f_turn.run_id AND l.idx = -1
      AND (f_turn.failure_category = 'unclassified' OR f_turn.failure_rule LIKE 'label:%')
      ${turnScope}`,
        only ? [only] : [],
    );
    await duck.run(
        `UPDATE f_tool SET category = l.category, category_rule = l.rule
    FROM f_label l
    WHERE l.run_id = f_tool.run_id AND l.idx = f_tool.idx
      AND (f_tool.category = 'unclassified' OR f_tool.category_rule LIKE 'label:%')
      ${toolScope}`,
        only ? [only] : [],
    );
}

/**
 * Copies new labels by `seq` (the watermark), at most `ETL_BATCH` a
 * batch, keeping the newest per subject, then applies them. The taxonomy
 * step applies them again after it re-runs the rules, and the runs step
 * to the turns it copies, so neither undoes a label.
 */
export const labelsStep: EtlStep = {
    source: 'labels',
    ddl: [LABEL_DDL],
    async batch({ sqlite, duck, watermark }) {
        const after = Number(watermark ?? 0) || 0;
        const reader = sqliteSourceReader(sqlite);
        const found = reader.labelsAfter(after, ETL_BATCH);
        if (!found.length) {
            return { caughtUp: true };
        }
        const newest = new Map<string, (typeof found)[number]>();
        for (const label of found) {
            newest.set(`${label.runId} ${label.idx}`, label);
        }
        const labels = [...newest.values()];
        await duck.run(`DELETE FROM f_label WHERE run_id || ' ' || idx IN (SELECT unnest($1))`, [
            listValue([...newest.keys()]),
        ]);
        await append(
            duck,
            'f_label',
            labels.map((label) => [
                label.runId,
                label.idx,
                label.label,
                label.source === 'admin' ? 'label:admin' : `label:${label.provider}`,
                label.seq,
            ]),
        );
        await applyLabels(duck);
        return {
            watermark: String(found.at(-1)!.seq),
            caughtUp: found.length < ETL_BATCH,
        };
    },
};
