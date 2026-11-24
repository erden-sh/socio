import { Context, Effect, Layer } from 'effect';

/**
 * Scheduling's construction: its layers (`schedules/layer.ts`), over
 * `SchedulesHost` and `SchedulesConfig`, which this file builds. A socio's turn
 * (`AppTurns`, built after schedules) is read through its port; long runs wait
 * for the server to listen, through the `listening` port.
 */
import { Data } from '../dataspace/contract.js';
import { Board } from '../issues/contract.js';
import { NotificationGoals } from '../notifications/contract.js';
import { TaskClaims, type TaskClaimsShape } from '../schedules/contract.js';
import { Goals, JobData, ScheduleBoard, SchedulesConfig, Tasks } from '../schedules/contract.js';
import {
    FullGoals,
    FullJobs,
    FullLongRunReports,
    FullLongRuns,
    FullSchedules,
    GoalsLive,
    JobsLive,
    LongRunReportsLive,
    LongRunsLive,
    ScheduleDataLive,
    SchedulesData,
    SchedulesHost,
    SchedulesLive,
} from '../schedules/layer.js';
import { sqliteSchedules } from '../schedules/services.js';
import { ScheduleStore } from '../schedules/tags.js';
import { jobOverrides, scheduleOverrides } from '../settings/limits.js';
import type { LocalAgentRunner } from '../turns/local-runner.js';

import { LegacyConfig, LegacyRunner, LegacyStore, LegacyWorkspace } from './base.js';
import { schedulesStoreOf } from './core-store.js';
import { LegacyData } from './dataspace.js';
import { Ports } from './ports.js';
import type { AppWorkspace } from './workspace-parts.js';

const log = (line: string) => console.log(line);

/**
 * Jobs, goals and long runs: the Scheduling context on the workspace's
 * connection (CB-110).
 */
export function scheduleData(workspace: AppWorkspace, runner: LocalAgentRunner) {
    return sqliteSchedules(workspace.db, runner.runtime);
}
export type ScheduleData = ReturnType<typeof scheduleData>;

/** The Scheduling context on the workspace's connection. */
export { SchedulesData as LegacyScheduleData };

/** Jobs, under the graph's `LegacyJobs` tag: the layer's whole class. */
export { FullJobs as LegacyJobs };

/** Long runs, under the graph's `LegacyLongRuns` tag. */
export { FullLongRuns as LegacyLongRuns };

/** A long run's report back, under the graph's `LegacyLongRunReports` tag. */
export { FullLongRunReports as LegacyLongRunReports };

/** Schedules, under the graph's `LegacySchedules` tag. */
export { FullSchedules as LegacySchedules };

/** Goals, under the graph's `LegacyGoals` tag. */
export { FullGoals as LegacyGoals };

/**
 * What the schedules layers take from the root (`SchedulesHost`): the
 * boot step's stores and runner, the data space, the admin's overrides
 * over the store's settings, and the late-bound members (a socio's turn
 * among them) through their ports, each read at the moment of use. With
 * `SchedulesConfig`, from the supplied startup configuration
 * (`PlatformConfig.schedules` and `.jobs`, which `index.ts` reads from the
 * environment; moving that here is a later change).
 */
const host = Layer.effectContext(
    Effect.gen(function* () {
        const store = yield* LegacyStore;
        const workspace = yield* LegacyWorkspace;
        const runner = yield* LegacyRunner;
        const data = yield* LegacyData;
        const config = yield* LegacyConfig;
        const ports = yield* Ports;
        return Context.make(
            SchedulesHost,
            SchedulesHost.of({
                db: workspace.db,
                runtime: runner.runtime,
                store: schedulesStoreOf(store),
                workspace,
                runner,
                data,
                jobOverrides: () => jobOverrides(store.slices.settings.settings()),
                scheduleOverrides: () => scheduleOverrides(store.slices.settings.settings()),
                listening: () => ports.listening.peek(),
                draining: () => ports.draining.get(),
                telegram: () => ports.telegram.peek(),
                turnOutcome: (threadId, prompt, signal, options) =>
                    ports.turns.get().turnOutcome(threadId, prompt, signal, options),
                log,
            }),
        ).pipe(Context.add(SchedulesConfig, { schedules: config.schedules, jobs: config.jobs, data: config.data }));
    }),
);

/**
 * Schedules' ports over the features above it: the data space as jobs use
 * it, and the Board as a schedule's details read it, each the very
 * instance under `Data` and `Board`, read at the step that read them
 * before.
 */
const JobDataLive = Layer.effect(
    JobData,
    Effect.gen(function* () {
        return yield* Data;
    }),
);
const ScheduleBoardLive = Layer.effect(
    ScheduleBoard,
    Effect.gen(function* () {
        return yield* Board;
    }),
);

/**
 * Scheduling's steps of the graph, in the graph's order, after the
 * computers: its data (with `SchedulesHost` and `SchedulesConfig`), jobs
 * (`Jobs`), long runs (`LongRuns`), their reports (`LongRunReporting`),
 * schedules (`Schedules`) and goals (`Goals`, with `ScheduleDetails` and
 * `SchedulesViews`). Each layer also offers its whole class, which the
 * other steps and the boot steps read (`Legacy*` above).
 */
export const schedulesLayers = {
    data: ScheduleDataLive.pipe(Layer.provideMerge(host)),
    jobs: JobsLive.pipe(Layer.provide(JobDataLive)),
    longRuns: LongRunsLive,
    longRunReports: LongRunReportsLive,
    schedules: SchedulesLive,
    goals: GoalsLive.pipe(Layer.provide(ScheduleBoardLive)),
    /**
     * `Tasks`, `ScheduleStore` and `ScheduleBoard` for the module's hooks;
     * notifications' `NotificationGoals` (`Goals` itself); and
     * `TaskClaims`, over the core store's task service (the lease is read
     * and set on it). `Tasks` is the task service itself
     * (`CoreStore.scheduled`): its `assignUnowned` assigns tasks only, where
     * `assignUnowned` in `core-store.ts` also assigns memories, so the first
     * admin's boot step calls that one.
     */
    bridges: Layer.mergeAll(
        // What the module's hooks read: the store's task service
        // (`Tasks`, the very `TaskService` the core store holds), the store
        // as the routes read it (`ScheduleStore`, `schedulesStoreOf`), and the Board's port.
        Layer.effect(
            Tasks,
            Effect.gen(function* () {
                return (yield* LegacyStore).scheduled;
            }),
        ),
        // The one view of the core store the schedules layers were handed.
        Layer.effect(
            ScheduleStore,
            Effect.gen(function* () {
                return (yield* SchedulesHost).store;
            }),
        ),
        ScheduleBoardLive,
        // A goal by its task, for notifications' `notify_user`
        // (`NotificationGoals`, the port notifications declares below
        // schedules): `Goals` itself.
        Layer.effect(
            NotificationGoals,
            Effect.gen(function* () {
                return yield* Goals;
            }),
        ),
        Layer.effect(
            TaskClaims,
            Effect.gen(function* () {
                const store = yield* LegacyStore;
                const claims: TaskClaimsShape = {
                    get leaseMs() {
                        return store.scheduled.leaseMs;
                    },
                    set leaseMs(ms: number) {
                        store.scheduled.leaseMs = ms;
                    },
                    claim: (now, admitted) => store.scheduled.claim(now, admitted),
                    owns: (claim) => store.scheduled.owns(claim),
                    finish: (claim, result, now) => store.scheduled.finish(claim, result, now),
                    fail: (claim, error) => store.scheduled.fail(claim, error),
                    interrupt: (claim, reason) => store.scheduled.interrupt(claim, reason),
                    event: (taskId, runId, text) => store.scheduled.event(taskId, runId, text),
                };
                return claims;
            }),
        ),
    ),
};
