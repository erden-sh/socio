/**
 * The operator's routes at the HTTP edge. The routes read the environment
 * (`RuntimeConfig`), the drain (`Lifecycle`) and page search's stats
 * (`PageStore`) through the app's runtime (`appHandle`).
 *
 * Not yet: `WorkControl`, which the runtime's step doesn't provide (its
 * counts and force stop need the task runner, made after the graph), so the
 * work view and the force stop are built here over the app's services and
 * the runner (`runningWork`, `forceStop`); and `Backups`, set late
 * (`useBackups`), so the replication status reads its port.
 */
import { Context, Effect } from 'effect';
import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';

import { abortComputerActions, computerActionsInFlight } from '../../computers/computer-service.js';
import type { AppEdge } from '../../main.js';
import { operatorRoutes as operatorApiRoutes } from '../../operator/operator-routes.js';
import { PageStore } from '../../pages/contract.js';
import { Lifecycle, RuntimeConfig, type WorkControlShape } from '../../runtime/contract.js';
import { forceStop, runningWork, type WorkPlatform, type WorkSources } from '../../runtime/force-stop.js';
import type { Runner } from '../../turns/runner.js';
import { runSourceOf } from '../app/conversations.js';
import { LeaderWork } from '../app/work.js';
import { LegacyModuleContext, LegacyRunner, LegacyWorkspace } from '../base.js';
import { Ports } from '../ports.js';
import { LegacyJobs } from '../schedules.js';

import { appHandle } from './handle.js';

/** The operator's reads, over the tags the graph provides. */
const reads = {
    environment: Effect.gen(function* () {
        return (yield* RuntimeConfig).environment;
    }),
    draining: Effect.gen(function* () {
        return yield* (yield* Lifecycle).draining;
    }),
    pageSearch: Effect.gen(function* () {
        const pages = yield* PageStore;
        return { ...pages.searchStats(30), revisions: pages.revisionStats() };
    }),
};

export function mountOperatorRoutes(app: Hono<AppEnv>, edge: AppEdge, runner: Runner) {
    const { services } = edge;
    const leaderWork = Context.get(services, LeaderWork);
    const context = Context.get(services, LegacyModuleContext);
    const backups = Context.get(services, Ports).backups;
    // What the work view and the force stop read: the turns, the job runs,
    // the drain (`LeaderWork`) and a stopped run's source.
    const platform: WorkPlatform = {
        runner: Context.get(services, LegacyRunner),
        jobs: Context.get(services, LegacyJobs),
        drain: () => leaderWork.drain(),
        runSource: runSourceOf(Context.get(services, LegacyWorkspace)),
    };
    // Run to their end if the client goes away, as the plain handlers did:
    // a force stop that started is always logged, and a request nobody
    // waits for causes no interruption failure (no logged 500).
    const sources: WorkSources<WorkPlatform> = {
        platform,
        scheduler: runner,
        computers: { inFlight: computerActionsInFlight, abort: abortComputerActions },
    };
    const work: WorkControlShape = {
        running: () => runningWork(sources),
        forceStop: (options) => forceStop(sources, options),
    };
    app.route(
        '/api',
        operatorApiRoutes(
            { work, backups: () => backups.peek(), log: (line) => context.log(line) },
            reads,
            appHandle(app).uninterruptible,
        ),
    );
}

/** The operator's step, as index.ts mounts it: its routes. */
export const operatorRoutes = { routes: mountOperatorRoutes };
