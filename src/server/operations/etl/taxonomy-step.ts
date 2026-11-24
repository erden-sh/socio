import type { DuckDBConnection } from '@duckdb/node-api';

import { failureCategory, TAXONOMY_VERSION } from '@socio/shared/failure-taxonomy';

import type { EtlStep } from '../infra/duckdb/etl.js';
import { rows } from '../infra/duckdb/open.js';

import { append } from './append.js';
import { applyLabels } from './labels-step.js';

/**
 * The failure taxonomy over the stored codes (CB-189): new turns and
 * tool calls get their category as they are copied (`run-facts.ts`);
 * when `TAXONOMY_VERSION` changes, this re-runs the rules over every
 * distinct set of raw codes the facts hold and writes the categories
 * back, so a rule change costs a few updates, not a rebuild. The
 * watermark is the version last applied.
 */
export const taxonomyStep: EtlStep = {
    source: 'taxonomy',
    ddl: [],
    async batch({ duck, watermark }) {
        const version = String(TAXONOMY_VERSION);
        if (watermark === version) {
            return { caughtUp: true };
        }
        await recategorize(duck);
        // Failure labels (CB-198) stand over the rules' Unclassified again.
        await applyLabels(duck);
        return { watermark: version, caughtUp: true };
    },
};

/** Writes the rules' categories over every turn and tool call. */
export async function recategorize(duck: DuckDBConnection) {
    const turns = await rows<{
        status: string;
        end_reason: string | null;
        failure_code: string | null;
        last_stop: string | null;
        fallback: boolean;
        has_detail: boolean;
    }>(
        duck,
        `SELECT DISTINCT status, end_reason, failure_code, last_stop,
      fallback_reason IS NOT NULL AS fallback, has_detail
    FROM f_turn`,
    );
    await duck.run(
        `CREATE OR REPLACE TEMP TABLE q_turn_class (status VARCHAR, end_reason VARCHAR,
      failure_code VARCHAR, last_stop VARCHAR, fallback BOOLEAN, has_detail BOOLEAN,
      category VARCHAR, rule VARCHAR)`,
    );
    await append(
        duck,
        'q_turn_class',
        turns.map((row) => {
            const found = failureCategory({
                level: 'turn',
                status: row.status,
                endReason: row.end_reason,
                code: row.failure_code,
                stop: row.last_stop,
                fallback: row.fallback,
                detail: row.has_detail,
            });
            return [
                row.status,
                row.end_reason,
                row.failure_code,
                row.last_stop,
                row.fallback,
                row.has_detail,
                found.category,
                found.ruleId,
            ];
        }),
        { schema: 'main', catalog: 'temp' },
    );
    await duck.run(
        `UPDATE f_turn SET failure_category = c.category, failure_rule = c.rule
    FROM temp.main.q_turn_class c
    WHERE f_turn.status = c.status
      AND f_turn.end_reason IS NOT DISTINCT FROM c.end_reason
      AND f_turn.failure_code IS NOT DISTINCT FROM c.failure_code
      AND f_turn.last_stop IS NOT DISTINCT FROM c.last_stop
      AND (f_turn.fallback_reason IS NOT NULL) = c.fallback
      AND f_turn.has_detail = c.has_detail`,
    );
    const tools = await rows<{
        tool: string;
        outcome: string;
        code: string | null;
    }>(duck, 'SELECT DISTINCT tool, outcome, code FROM f_tool');
    await duck.run(
        `CREATE OR REPLACE TEMP TABLE q_tool_class (tool VARCHAR, outcome VARCHAR,
      code VARCHAR, category VARCHAR, rule VARCHAR)`,
    );
    await append(
        duck,
        'q_tool_class',
        tools.map((row) => {
            const found = failureCategory({
                level: 'tool',
                tool: row.tool,
                outcome: row.outcome,
                code: row.code,
            });
            return [row.tool, row.outcome, row.code, found.category, found.ruleId];
        }),
        { schema: 'main', catalog: 'temp' },
    );
    await duck.run(
        `UPDATE f_tool SET category = c.category, category_rule = c.rule
    FROM temp.main.q_tool_class c
    WHERE f_tool.tool = c.tool AND f_tool.outcome = c.outcome
      AND f_tool.code IS NOT DISTINCT FROM c.code`,
    );
    await duck.run('DROP TABLE temp.main.q_turn_class');
    await duck.run('DROP TABLE temp.main.q_tool_class');
}
