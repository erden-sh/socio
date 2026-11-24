/** The task runner's boot step, where the process entry built it. */
import { Context } from 'effect';

import type { AppEdge } from '../../main.js';
import { scheduledTaskExecutor, type ScheduledTaskSources } from '../../schedules/scheduled.js';
import { turnTimeLimitMs } from '../../settings/limits.js';
import { Runner } from '../../turns/runner.js';
import { AppTurns } from '../app/turns.js';
import { LegacyWorkspace } from '../base.js';
import type { PlatformConfig } from '../config.js';
import { taskRunnerStoreOf, type CoreStore } from '../core-store.js';
import { LegacyLongRuns } from '../schedules.js';

/** What a scheduled task's run uses, from the graph's tags: long runs, the workspace and a socio's turn (`AppTurns`). */
function scheduledTaskSources(edge: AppEdge): ScheduledTaskSources {
    const { services } = edge;
    const turns = Context.get(services, AppTurns);
    return {
        longRuns: Context.get(services, LegacyLongRuns),
        workspace: Context.get(services, LegacyWorkspace),
        turnOutcome: (threadId, prompt, signal, options) => turns.turnOutcome(threadId, prompt, signal, options),
    };
}

/**
 * The research config the API and the pages report, and the task runner.
 * A scheduled turn has the turn limit in force (Settings over
 * TURN_TIME_LIMIT_SECONDS) and a margin; a job schedule only starts its run.
 */
export function taskRunner({
    store,
    config,
    edge,
    isUser,
    leading,
}: {
    store: CoreStore;
    config: PlatformConfig;
    edge: AppEdge;
    isUser: (userId: string) => boolean;
    /** Claims only while leading, rechecked inside the claim's transaction. */
    leading: () => boolean;
}) {
    const researchConfig = {
        mode: 'live' as const,
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl,
        maxCompletionTokens: config.maxCompletionTokens,
        webSearchProvider: config.webSearchProvider,
        parallelApiKey: config.parallelApiKey,
        searxngUrl: config.searxngUrl,
    };
    const runner = new Runner(
        taskRunnerStoreOf(store),
        scheduledTaskExecutor(scheduledTaskSources(edge), isUser),
        () => turnTimeLimitMs(store.slices.settings.settings(), config) + 15_000,
        leading,
    );
    return { researchConfig, runner };
}

/** Turns' step, as lifecycle/index.ts runs it: the task runner. */
export const turnsLifecycle = { taskRunner };
