import type { EtlStep } from '../infra/duckdb/etl.js';
import { rows } from '../infra/duckdb/open.js';

import { recompute } from './rollups.js';
import { participants } from './runs-step.js';

const DAY = 86_400_000;

/**
 * Retention (CB-164): with `factDays` set (0, the default, keeps
 * everything the database keeps), facts and rollups older than that go,
 * and the day it cuts through is recomputed from what is left. Hourly
 * rollups' own limit (`hourlyDays`, 0 keeps history) is kept with the rollups. The
 * watermark is the last cutoff.
 */
export const retentionStep: EtlStep = {
    source: 'retention',
    ddl: [],
    async batch({ duck, context }) {
        const days = context.settings.factDays;
        if (!days) {
            return { watermark: '0', caughtUp: true };
        }
        const cutoff = context.now - days * DAY;
        // Health's facts (CB-192).
        await duck.run('DELETE FROM f_round WHERE started_at < $1', [cutoff]);
        await duck.run('DELETE FROM f_job_run WHERE queued_at < $1', [cutoff]);
        await duck.run('DELETE FROM f_task_run WHERE started_at < $1', [cutoff]);
        // Work cycles (CB-218), by when they started.
        await duck.run('DELETE FROM f_cycle WHERE started_at < $1', [cutoff]);
        const [old] = await rows<{ n: number }>(
            duck,
            `SELECT (SELECT count(*) FROM f_turn WHERE started_at < $1)
        + (SELECT count(*) FROM f_message WHERE sent_at < $1) AS n`,
            [cutoff],
        );
        if (!old?.n) {
            return { watermark: String(cutoff), caughtUp: true };
        }
        const threads = await rows<{ thread_id: string }>(
            duck,
            `SELECT DISTINCT thread_id FROM f_turn WHERE started_at < $1
        UNION SELECT DISTINCT thread_id FROM f_message WHERE sent_at < $1`,
            [cutoff],
        );
        // Sessions' intent and themes (CB-199) go with their turns.
        await duck.run('DELETE FROM f_intent WHERE run_id IN (SELECT run_id FROM f_turn WHERE started_at < $1)', [
            cutoff,
        ]);
        await duck.run('DELETE FROM f_theme WHERE run_id IN (SELECT run_id FROM f_turn WHERE started_at < $1)', [
            cutoff,
        ]);
        await duck.run('DELETE FROM f_turn WHERE started_at < $1', [cutoff]);
        await duck.run('DELETE FROM f_message WHERE sent_at < $1', [cutoff]);
        await duck.run('DELETE FROM f_tool WHERE started_at < $1', [cutoff]);
        // The chats it cut: their participants from what is left.
        await participants(
            duck,
            threads.map(({ thread_id }) => thread_id),
        );
        const [day] = await rows<{ k: number | null }>(
            duck,
            'SELECT day_at AS k FROM d_calendar WHERE utc_at <= $1 ORDER BY utc_at DESC LIMIT 1',
            [cutoff],
        );
        if (day?.k != null) {
            await duck.run('DELETE FROM r_daily WHERE day_at < $1', [day.k]);
            await duck.run('DELETE FROM r_hourly WHERE hour_at < $1', [day.k]);
            await recompute(duck, cutoff, cutoff);
        }
        return { watermark: String(cutoff), caughtUp: true };
    },
};
