import { listValue, type DuckDBConnection } from '@duckdb/node-api';

import { runFacts, type RunFacts } from '@socio/foundation/operations/run-facts';
import { readRunsWatermark, type RunsWatermark } from '@socio/foundation/operations/runs-watermark';
import type { SourceRun } from '@socio/foundation/operations/source-run';

import type { EtlStep } from '../infra/duckdb/etl.js';
import { rows } from '../infra/duckdb/open.js';
import { sqliteSourceReader } from '../infra/sqlite/source-reader.js';

import { append, type Cell } from './append.js';
import { ROUND_DDL } from './health-schema.js';
import { applyLabels } from './labels-step.js';
import { syncRollups } from './rollups.js';
import { MESSAGE_DDL, PARTICIPANT_DDL, ROLLUP_DDL, TOOL_DDL, TURN_DDL } from './schema.js';
import { ETL_BATCH, ETL_BATCH_BYTES } from './source-reader.js';

const DAY = 86_400_000;

/**
 * Turns, their messages and tool calls (CB-187), from `agent_runs` by
 * `seq`: at most `ETL_BATCH` new turns and `ETL_BATCH_BYTES` of their
 * stored text a batch, read in one short read transaction, then the turns
 * still running when the scan has caught up.
 * A batch deletes the facts of the turns it read and appends them again,
 * then derives their chats' participants and recomputes the rollups of the
 * hours and days it touched, all in the engine's one DuckDB transaction
 * with the watermark: running it twice changes nothing.
 */
export const runsStep: EtlStep = {
    source: 'agent_runs',
    ddl: [TURN_DDL, MESSAGE_DDL, TOOL_DDL, PARTICIPANT_DDL, ...ROLLUP_DDL, ROUND_DDL],
    async batch({ sqlite, duck, watermark, context }) {
        const reader = sqliteSourceReader(sqlite);
        const state = readRunsWatermark(watermark);
        if (!reader.ready()) {
            return { caughtUp: true };
        }
        let fresh: SourceRun[];
        let again: SourceRun[] = [];
        let last: number;
        // The scan has reached the newest turn (in this read's snapshot).
        let caughtUp: boolean;
        sqlite.exec('BEGIN');
        try {
            last = reader.lastRunSeq();
            fresh = reader.runsAfter(state.seq, ETL_BATCH, ETL_BATCH_BYTES);
            caughtUp = (fresh.at(-1)?.seq ?? state.seq) >= last;
            if (caughtUp) {
                again = reader.runsBySeq(state.running);
            }
        } finally {
            sqlite.exec('COMMIT');
        }
        const cutoff = context.settings.factDays ? context.now - context.settings.factDays * DAY : -Infinity;
        const seen = new Set(fresh.map((run) => run.seq));
        const runs = [...fresh, ...again.filter((run) => !seen.has(run.seq))];
        const facts = runs.filter((run) => run.startedAt >= cutoff).map((run) => runFacts(run));
        const seq = fresh.at(-1)?.seq ?? state.seq;
        // The running turns were read again only once the scan caught up.
        const reread = caughtUp;
        const gone = reread ? state.running.filter((old) => !runs.some((run) => run.seq === old)) : [];
        const next: RunsWatermark = {
            seq,
            running: [
                ...new Set([
                    ...(reread ? [] : state.running),
                    ...runs.filter((run) => run.status === 'running').map((run) => run.seq),
                ]),
            ],
        };
        // A turn that left the database (none do today) leaves the store too.
        const touched = await write(duck, [...runs.map((run) => run.seq), ...gone], facts);
        // The failure labels in force (CB-198) over the turns just copied.
        await applyLabels(
            duck,
            facts.map(({ turn }) => turn.seq),
        );
        await syncRollups(
            duck,
            {
                timeZone: context.timeZone,
                hourlyDays: context.settings.hourlyDays,
                now: context.now,
            },
            touched,
        );
        return {
            watermark: JSON.stringify(next),
            caughtUp,
            progress: last ? Math.min(1, seq / last) : 1,
        };
    },
};

/**
 * Replaces the facts of the turns `seqs` with `facts`, and the
 * participants of their chats; returns the span of time it touched (the
 * old rows' and the new), for the rollups.
 */
async function write(duck: DuckDBConnection, seqs: number[], facts: RunFacts[]) {
    if (!seqs.length) {
        return undefined;
    }
    const keys = listValue(seqs.map((seq) => BigInt(seq)));
    const [old] = await rows<{ lo: number | null; hi: number | null }>(
        duck,
        `SELECT least(min(t.started_at), (SELECT min(sent_at) FROM f_message WHERE run_seq IN (SELECT unnest($1)))) AS lo,
      greatest(max(t.started_at), (SELECT max(sent_at) FROM f_message WHERE run_seq IN (SELECT unnest($1)))) AS hi
    FROM f_turn t WHERE t.seq IN (SELECT unnest($1))`,
        [keys],
    );
    const oldThreads = await rows<{ thread_id: string }>(
        duck,
        'SELECT DISTINCT thread_id FROM f_turn WHERE seq IN (SELECT unnest($1))',
        [keys],
    );
    for (const table of ['f_turn', 'f_message', 'f_tool', 'f_round']) {
        await duck.run(`DELETE FROM ${table} WHERE ${table === 'f_turn' ? 'seq' : 'run_seq'} IN (SELECT unnest($1))`, [
            keys,
        ]);
    }
    await append(
        duck,
        'f_turn',
        facts.map(({ turn }) => turnRow(turn)),
    );
    await append(
        duck,
        'f_message',
        facts.flatMap(({ turn, messages }) =>
            messages.map((message): Cell[] => [
                turn.seq,
                message.messageId,
                turn.runId,
                turn.threadId,
                turn.socioId,
                turn.source,
                message.sentAt,
                message.authorKind,
                message.authorId,
                message.attribution,
                message.chars,
                message.attachments,
            ]),
        ),
    );
    await append(
        duck,
        'f_tool',
        facts.flatMap(({ turn, tools }) =>
            tools.map((tool): Cell[] => [
                turn.seq,
                turn.runId,
                tool.idx,
                turn.threadId,
                turn.socioId,
                turn.source,
                turn.triggerKind,
                turn.triggerId,
                tool.round,
                tool.tool,
                tool.outcome,
                tool.code,
                tool.startedAt,
                tool.durationMs,
                tool.category,
                tool.categoryRule,
            ]),
        ),
    );
    // Model rounds, for Health (CB-192).
    await append(
        duck,
        'f_round',
        facts.flatMap(({ turn, rounds }) =>
            rounds.map((round): Cell[] => [
                turn.seq,
                turn.runId,
                round.round,
                turn.socioId,
                turn.source,
                turn.triggerKind,
                turn.triggerId,
                turn.model,
                round.startedAt,
                round.durationMs,
                round.firstOutputMs,
                round.reasoningKind,
            ]),
        ),
    );
    const threads = [
        ...new Set([...oldThreads.map(({ thread_id }) => thread_id), ...facts.map(({ turn }) => turn.threadId)]),
    ];
    await participants(duck, threads);
    let lo = old?.lo ?? Infinity;
    let hi = old?.hi ?? -Infinity;
    for (const { turn, messages } of facts) {
        lo = Math.min(lo, turn.startedAt);
        hi = Math.max(hi, turn.startedAt);
        for (const message of messages) {
            lo = Math.min(lo, message.sentAt);
            hi = Math.max(hi, message.sentAt);
        }
    }
    return Number.isFinite(lo) ? { lo, hi } : undefined;
}

/**
 * Who took part in these chats, from their facts: authors, starters and
 * the socios that ran turns, with the turns each person's access ran and
 * those billed to them (CB-218).
 */
export async function participants(duck: DuckDBConnection, threads: string[]) {
    if (!threads.length) {
        return;
    }
    const list = listValue(threads);
    await duck.run('DELETE FROM f_participant WHERE thread_id IN (SELECT unnest($1))', [list]);
    await duck.run(
        `INSERT INTO f_participant
    SELECT thread_id, kind, id, min(first_at), max(last_at),
      sum(messages)::INTEGER, sum(turns)::INTEGER, sum(acting)::INTEGER,
      sum(paid)::INTEGER
    FROM (
      SELECT thread_id, author_kind AS kind, author_id AS id, sent_at AS first_at,
        sent_at AS last_at, 1 AS messages, 0 AS turns, 0 AS acting, 0 AS paid
      FROM f_message WHERE thread_id IN (SELECT unnest($1)) AND author_id IS NOT NULL
      UNION ALL
      SELECT thread_id, trigger_kind, trigger_id, started_at, started_at, 0, 1, 0, 0
      FROM f_turn WHERE thread_id IN (SELECT unnest($1)) AND trigger_id IS NOT NULL
      UNION ALL
      SELECT thread_id, 'socio', socio_id, started_at, started_at, 0, 1, 0, 0
      FROM f_turn WHERE thread_id IN (SELECT unnest($1)) AND socio_id IS NOT NULL
        AND NOT (trigger_kind = 'socio' AND trigger_id = socio_id)
      UNION ALL
      SELECT thread_id, 'person', acting_id, started_at, started_at, 0, 0, 1,
        (payer_kind = 'person' AND payer_id = acting_id)::INTEGER
      FROM f_turn WHERE thread_id IN (SELECT unnest($1)) AND acting_id IS NOT NULL
    )
    GROUP BY thread_id, kind, id`,
        [list],
    );
}

function turnRow(turn: RunFacts['turn']): Cell[] {
    return [
        turn.seq,
        turn.runId,
        turn.threadId,
        turn.socioId,
        turn.source,
        turn.triggerKind,
        turn.triggerId,
        turn.attribution,
        turn.status,
        turn.endReason,
        turn.failureCode,
        turn.receivedAt,
        turn.startedAt,
        turn.finishedAt,
        turn.rounds,
        turn.inputTokens,
        turn.outputTokens,
        turn.cachedTokens,
        turn.reasoningTokens,
        turn.reasoningKind,
        turn.reasoningTokensReported,
        turn.model,
        turn.backendKey,
        turn.toolCalls,
        turn.toolErrors,
        turn.toolRefusals,
        turn.approvalWaits,
        turn.personWaits,
        turn.retries,
        turn.fallbackReason,
        turn.lastStop,
        turn.hasDetail,
        turn.failureCategory,
        turn.failureRule,
        turn.backendId,
        // Priced by the cost step (CB-195).
        null,
        null,
        null,
        null,
        null,
        // Where it ran, its cycle, and who acted and paid (CB-218).
        turn.containerKind,
        turn.cycleId,
        turn.hop,
        turn.actingId,
        turn.payerKind,
        turn.payerId,
    ];
}
