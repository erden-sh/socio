import {
    FORCE_STOP_CODE,
    FORCE_STOP_MESSAGE,
    type AppEnvironment,
    type ForceStopResult,
    type RunningWork,
} from '@socio/shared/operator';
import type { PageRevisionStats, SearchStatsView } from '@socio/shared/pages/page-search';
import type { AgentRunSource, BackupStatus } from '@socio/shared/types';

import type { ComputerWorkShape } from '../computers/contract.js';
import type { RunnerShape, TaskRunnerShape } from '../turns/contract.js';

/**
 * What the running counts and the force stop use of the platform: slices
 * of its services, typed by their contracts or by the members read
 * (the composition builds it from the graph's tags where it is passed in).
 */
export interface WorkPlatform {
    /** The turns (`Runner`, turns/contract). */
    readonly runner: Pick<RunnerShape, 'running' | 'stopAll'>;
    /** The job runs: the members of `JobsShape` (schedules/contract) read here. */
    readonly jobs: { readonly running: number; forceStop(reason: string): number };
    /** Starts the platform's drain (`Lifecycle.drain`). */
    drain(): void;
    /** Where a stopped turn came from, for the result's counts. */
    runSource(threadId: string, recorded?: AgentRunSource | null): Promise<AgentRunSource>;
}

/**
 * The operator's routes (`operator/operator-routes.ts`) take the work's
 * sources and read these members of the platform beside them, until they
 * move to `WorkControl`, `Lifecycle`, `RuntimeConfig` and their features'
 * tags.
 */
export interface OperatorPlatform extends WorkPlatform {
    readonly backups?: { status(): Pick<BackupStatus, 'continuous'> };
    readonly config: { readonly environment?: AppEnvironment };
    readonly context: { log: (line: string) => void };
    readonly draining: boolean;
    readonly workspace: {
        readonly pages: { searchStats(days?: number): SearchStatsView; revisionStats(): PageRevisionStats };
    };
}

/**
 * The platform (the operator's view by default), the scheduled-task runner
 * and the computer actions in progress (computers' `ComputerWork`, which the
 * composition hands in).
 */
export interface WorkSources<P extends WorkPlatform = OperatorPlatform> {
    platform: P;
    /** The scheduled-task runner. */
    scheduler: TaskRunnerShape;
    /** The computer actions in progress, across every computer. */
    computers: ComputerWorkShape;
}

/** What is running now (the Platform page's counts). */
export async function runningWork({ platform, scheduler, computers }: WorkSources<WorkPlatform>): Promise<RunningWork> {
    return {
        turns: platform.runner.running,
        scheduledTasks: scheduler.running,
        computerActions: computers.inFlight(),
        jobRuns: platform.jobs.running,
    };
}

/**
 * Stops running work at once, for a deploy that shouldn't wait (development
 * only; the route and the shutdown check that). In order:
 *
 * 1. With `hold`, the platform and the scheduler drain: new turns and runs
 *    are refused ("updating") until the restart, Telegram stops polling,
 *    and scheduled tasks wait for the next process.
 * 2. Computer actions in progress are aborted (the requests only: the
 *    containers keep running; the turn needs no more to end).
 * 3. Every turn (web, Telegram, scheduled, voice compute) ends with
 *    FORCE_STOP_MESSAGE, stored as interrupted.
 * 4. Scheduled tasks in progress end as interrupted with the same message.
 * 5. Job runs end as interrupted too; their processes in the
 *    computers are killed, and queued runs are dropped.
 *
 * Resolves once the cancels are sent; the stopped turns finish storing
 * within moments.
 */
export async function forceStop(
    { platform, scheduler, computers }: WorkSources<WorkPlatform>,
    options: { by: string; hold: boolean },
): Promise<ForceStopResult> {
    if (options.hold) {
        scheduler.drain();
        platform.drain();
    }
    const computerActions = computers.abort();
    const stopped = platform.runner.stopAll({
        message: FORCE_STOP_MESSAGE,
        code: FORCE_STOP_CODE,
    });
    const scheduledTasks = scheduler.interruptAll(FORCE_STOP_MESSAGE);
    const jobRuns = platform.jobs.forceStop(FORCE_STOP_MESSAGE);
    const turnSources: ForceStopResult['turnSources'] = {};
    for (const run of stopped) {
        const source = await platform.runSource(run.threadId, run.source);
        turnSources[source] = (turnSources[source] ?? 0) + 1;
    }
    return {
        turns: stopped.length,
        turnSources,
        scheduledTasks,
        computerActions,
        jobRuns,
        held: options.hold,
    };
}
