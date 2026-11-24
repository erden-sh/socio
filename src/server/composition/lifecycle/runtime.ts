/**
 * The process runtime's boot steps: its identity, the leader lease and the
 * pruning of dead runtimes, where the process entry ran them.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context } from 'effect';

import { reportFailure, safeFailure } from '@socio/foundation/observability/failures';

import type { AppEdge } from '../../main.js';
import { LeaderLease } from '../../runtime/background.js';
import type { Runner } from '../../turns/runner.js';
import { LeaderWork } from '../app/work.js';
import { LegacyRunner } from '../base.js';

/**
 * This process's runtime identity (CB-108), shared by its turns, job runs
 * and data tokens, alive while its heartbeat runs. Old and new tasks of a
 * start-first deploy run side by side on the same database; the leader
 * lease gives one of them the work that must run once: the scheduler,
 * Telegram polling, the modules' ticks, backups and analytics.
 */
export function leadership({
    edge,
    runner,
    connection,
    superseded,
}: {
    edge: AppEdge;
    runner: Runner;
    connection: DatabaseSync;
    /** Another task led while this one stalled. */
    superseded: () => void;
}) {
    const work = Context.get(edge.services, LeaderWork);
    const runtime = Context.get(edge.services, LegacyRunner).runtime;
    const ownership = runtime.attach(connection);
    runtime.keepAlive();
    const leader: LeaderLease = new LeaderLease(ownership, 'leader', {
        start: async () => {
            runner.start();
            await work.lead();
        },
        // Recovery of a dead process's work, once no other runtime is alive.
        succeed: () => work.succeed(),
        stop: async () => {
            runner.drain();
            await work.stopBackground();
        },
        superseded: () => {
            // Another task led while this one stalled: restart as a follower.
            console.warn('Leader: superseded by another runtime; restarting.');
            superseded();
        },
        error: (error) => reportFailure('Leader lease failed', [safeFailure(error)]),
        log: (line) => console.log(line),
    });
    // What dead runtimes left (their rows, tokens and signals), hourly.
    const pruning = setInterval(() => {
        if (leader.current()) {
            void ownership.prune().catch(() => undefined);
        }
    }, 60 * 60_000);
    pruning.unref();
    return { leader, pruning };
}

/** The runtime's step, as lifecycle/index.ts runs it: the leader lease. */
export const runtimeLifecycle = { leadership };
