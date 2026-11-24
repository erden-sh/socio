/**
 * The schedules layers: they implement `contract.ts`, yielding what they need
 * from other features' contracts below this folder (`Approvals`, `Computers`,
 * `Notifier`, `NotificationsConfig`), this folder's ports over the ones
 * above it (`JobData` over the data space, `ScheduleBoard` over the Board,
 * which the composition provides) and `SchedulesConfig`.
 * Only the composition root (`composition/`) and tests import this file.
 *
 * Each layer is one step of the graph, in the graph's order (data, jobs,
 * long runs, their reports, schedules, goals): the services register
 * approval handlers and listeners as they are built, so the order is
 * behavior.
 *
 * What no contract offers yet comes from `SchedulesHost`, which the
 * composition provides: the store's task forwarders and the workspace's
 * sub-stores (`slices.ts`), the runner, the data space's write, the
 * admin's overrides, and the composition's late-bound ports (the drain, the
 * Telegram channel, the server listening, a turn).
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import { Approvals, type ApprovalsShape } from '../approvals/contract.js';
import { Computers, type ComputersShape } from '../computers/contract.js';
import { NotificationsConfig, Notifier } from '../notifications/contract.js';
import type { RuntimeIdentityShape } from '../runtime/contract.js';
import type { PlatformTurnOptions, RunnerShape, TurnOutcome } from '../turns/contract.js';

import {
    Goals,
    JobData,
    Jobs,
    LongRunReporting,
    LongRuns,
    ScheduleBoard,
    ScheduleDetails,
    Schedules,
    SchedulesConfig,
    SchedulesViews,
    type JobDataShape,
    type JobSettings,
    type ScheduleSettings,
} from './contract.js';
import { ScheduleDetailViews, type ScheduleViewSources } from './detail.js';
import { GoalService } from './goals.js';
import { JobService } from './jobs.js';
import { LongRunReports, type LongRunReportSources } from './long-run-reports.js';
import { LongRunService, type LongRunData } from './long-runs.js';
import { ScheduleService } from './service.js';
import { sqliteSchedules, type ScheduleData } from './services.js';
import type { SchedulesStore, SchedulesWorkspace } from './slices.js';
import { FullGoals, FullJobs, FullLongRunReports, FullLongRuns, FullSchedules, SchedulesData } from './tags.js';

// ── What the composition hands in ───────────────────────────────────────

/**
 * What the schedules layers take from the composition root because no
 * feature's contract offers it yet. Each member says where it comes from.
 */
export interface SchedulesHostShape {
    /** The workspace's connection, migrated at boot: the Scheduling context's repositories share it. */
    readonly db: DatabaseSync;
    /** The process's runtime identity, which the runner made (`RuntimeIdentity` is offered after this step). */
    readonly runtime: RuntimeIdentityShape;
    /** The settings and this folder's `TaskService` (`schedulesStoreOf`). */
    readonly store: SchedulesStore;
    /** The workspace's slices and the sub-stores that have no tag yet. */
    readonly workspace: SchedulesWorkspace;
    /** The runner: its runs (a report waits for the conversation's) and its stored turns. */
    readonly runner: Pick<RunnerShape, 'onRunFinished' | 'activeRunId' | 'turnsBetween'>;
    /** The data space's write, for a batch's `done` (not in `DataSpaceShape`). */
    readonly data: LongRunData;
    /** What an admin saved in Settings over the jobs' limits (CB-108), read on every use. */
    jobOverrides(): Partial<JobSettings>;
    /** What an admin saved in Settings over the schedules' limits, read on every use. */
    scheduleOverrides(): Partial<ScheduleSettings>;
    /** Resolves once the server listens (CB-161); undefined until the wait begins. */
    listening(): Promise<void> | undefined;
    /** Set on SIGTERM (CB-37), read at the moment of use. */
    draining(): boolean;
    /** The Telegram channel, when configured: set after the graph is built. */
    telegram(): LongRunReportSources['telegram'];
    /** A Dot's turn in a conversation (`AppTurns.turnOutcome`). */
    turnOutcome(
        threadId: string,
        prompt: string,
        signal: AbortSignal,
        options?: PlatformTurnOptions,
    ): Promise<TurnOutcome>;
    /** Operational lines only. */
    log(line: string): void;
}

export class SchedulesHost extends Context.Service<SchedulesHost, SchedulesHostShape>()(
    'socio/schedules/SchedulesHost',
) {}

// ── This folder's services, whole ───────────────────────────────────────

/** The whole classes' tags: in `tags.ts` so the module can read them. */
export { FullGoals, FullJobs, FullLongRunReports, FullLongRuns, FullSchedules, SchedulesData };

// ── Construction ─────────────────────────────────────────────────────────

/** Jobs: code in the data space, run in the Dot's computer without the model. */
export function makeJobs(deps: {
    schedules: ScheduleData;
    data: JobDataShape;
    approvals: ApprovalsShape;
    computers: ComputersShape;
    workspace: SchedulesWorkspace;
    store: Pick<SchedulesStore, 'settings'>;
    /** `DATA_API_URL`: without it, runs get no data token. */
    apiUrl: string | undefined;
    settings: Partial<JobSettings> | undefined;
    overrides: () => Partial<JobSettings>;
    log: (line: string) => void;
}): JobService {
    const { store, computers } = deps;
    return new JobService(deps.schedules, {
        data: deps.data,
        approvals: deps.approvals,
        computers: () => computers,
        workspace: deps.workspace,
        paused: () => store.settings().paused,
        apiUrl: deps.apiUrl,
        settings: deps.settings,
        overrides: deps.overrides,
        log: deps.log,
    });
}

/** Jobs that run until done (CB-122): long runs, in batches, owned by the server. */
export function makeLongRuns(deps: {
    schedules: ScheduleData;
    jobs: JobService;
    data: LongRunData;
    workspace: SchedulesWorkspace;
    store: Pick<SchedulesStore, 'settings'>;
    listening: () => Promise<void> | undefined;
    log: (line: string) => void;
}): LongRunService {
    const { store } = deps;
    return new LongRunService(deps.schedules.repos.longRuns, deps.jobs, {
        data: deps.data,
        workspace: deps.workspace,
        paused: () => store.settings().paused,
        log: deps.log,
        listening: deps.listening,
    });
}

/** Schedules: cadence tasks that run a Dot turn or a job. */
export function makeSchedules(deps: {
    store: SchedulesStore;
    workspace: SchedulesWorkspace;
    approvals: ApprovalsShape;
    jobs: JobService;
    settings: Partial<ScheduleSettings> | undefined;
    overrides: () => Partial<ScheduleSettings>;
    log: (line: string) => void;
}): ScheduleService {
    return new ScheduleService(
        deps.store,
        deps.workspace,
        deps.approvals,
        deps.jobs,
        deps.settings,
        deps.log,
        deps.overrides,
    );
}

/** Persistent goals, each worked on by a schedule of its own. */
export function makeGoals(deps: {
    schedules: ScheduleData;
    store: SchedulesStore;
    workspace: SchedulesWorkspace;
    approvals: ApprovalsShape;
    scheduleService: ScheduleService;
    log: (line: string) => void;
}): GoalService {
    return new GoalService(deps.schedules, deps.store, deps.workspace, deps.approvals, deps.scheduleService, deps.log);
}

// ── The layers, one per step ────────────────────────────────────────────

/** The Scheduling context's repositories on the workspace's connection, owned by the runner's runtime. */
export const ScheduleDataLive = Layer.effect(
    SchedulesData,
    Effect.gen(function* () {
        const host = yield* SchedulesHost;
        return sqliteSchedules(host.db, host.runtime);
    }),
);

/** Jobs, under `Jobs` and whole; registers the `job.save` approval. */
export const JobsLive = Layer.effectContext(
    Effect.gen(function* () {
        const host = yield* SchedulesHost;
        const config = yield* SchedulesConfig;
        const jobs = makeJobs({
            schedules: yield* SchedulesData,
            data: yield* JobData,
            approvals: yield* Approvals,
            computers: yield* Computers,
            workspace: host.workspace,
            store: host.store,
            apiUrl: config.data?.apiUrl,
            settings: config.jobs,
            overrides: () => host.jobOverrides(),
            log: host.log,
        });
        return Context.make(FullJobs, jobs).pipe(Context.add(Jobs, jobs));
    }),
);

/** Long runs, under `LongRuns` and whole; they follow the jobs' run ends. */
export const LongRunsLive = Layer.effectContext(
    Effect.gen(function* () {
        const host = yield* SchedulesHost;
        const longRuns = makeLongRuns({
            schedules: yield* SchedulesData,
            jobs: yield* FullJobs,
            data: host.data,
            workspace: host.workspace,
            store: host.store,
            listening: () => host.listening(),
            log: host.log,
        });
        return Context.make(FullLongRuns, longRuns).pipe(Context.add(LongRuns, longRuns));
    }),
);

/**
 * The reports of long runs' ends, under `LongRunReporting` and whole;
 * they follow the long runs' ends and the runner's runs. The drain, the
 * Telegram channel and the turn are read when a report is sent.
 */
export const LongRunReportsLive = Layer.effectContext(
    Effect.gen(function* () {
        const host = yield* SchedulesHost;
        const sources: LongRunReportSources = {
            longRuns: yield* FullLongRuns,
            jobs: yield* FullJobs,
            runner: host.runner,
            workspace: host.workspace,
            store: host.store,
            approvals: yield* Approvals,
            notifications: yield* Notifier,
            notificationLimits: (yield* NotificationsConfig).notificationLimits,
            get telegram() {
                return host.telegram();
            },
            get draining() {
                return host.draining();
            },
            turnOutcome: (threadId, prompt, signal, options) => host.turnOutcome(threadId, prompt, signal, options),
            log: host.log,
        };
        const reports = new LongRunReports(sources);
        return Context.make(FullLongRunReports, reports).pipe(Context.add(LongRunReporting, reports));
    }),
);

/** Schedules, under `Schedules` and whole; registers the `schedule.create` approval. */
export const SchedulesLive = Layer.effectContext(
    Effect.gen(function* () {
        const host = yield* SchedulesHost;
        const schedules = makeSchedules({
            store: host.store,
            workspace: host.workspace,
            approvals: yield* Approvals,
            jobs: yield* FullJobs,
            settings: (yield* SchedulesConfig).schedules,
            overrides: () => host.scheduleOverrides(),
            log: host.log,
        });
        return Context.make(FullSchedules, schedules).pipe(Context.add(Schedules, schedules));
    }),
);

/**
 * Goals, under `Goals` and whole; registers the `goal.set` approval. With
 * them, the views over every service of this folder: `ScheduleDetails`
 * and `SchedulesViews`, which build nothing and register nothing.
 */
export const GoalsLive = Layer.effectContext(
    Effect.gen(function* () {
        const host = yield* SchedulesHost;
        const approvals = yield* Approvals;
        const schedules = yield* FullSchedules;
        const goals = makeGoals({
            schedules: yield* SchedulesData,
            store: host.store,
            workspace: host.workspace,
            approvals,
            scheduleService: schedules,
            log: host.log,
        });
        const sources: ScheduleViewSources = {
            schedules,
            goals,
            jobs: yield* FullJobs,
            longRuns: yield* FullLongRuns,
            store: host.store,
            approvals,
            runner: host.runner,
            board: yield* ScheduleBoard,
        };
        const views = new ScheduleDetailViews(sources);
        return Context.make(FullGoals, goals).pipe(
            Context.add(Goals, goals),
            Context.add(ScheduleDetails, views),
            Context.add(SchedulesViews, views),
        );
    }),
);
