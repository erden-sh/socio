/**
 * The leader's work and the drain (`LeaderWork`): `lead`, `succeed`, `start`,
 * `stopBackground`, `stop`, the modules' ticks and the hourly re-seal, `drain`,
 * `inProgress`, the listening wait, and `useTelegram`/`useBackups`, read
 * through the tag. Placed in the graph (`composition/index.ts`) after every
 * service it reads (`liveLayers.counters`), last of the app's steps; it
 * registers no listener, so the graph's order doesn't change. One per runtime:
 * the ticks, the hand-over and the listening wait are its state.
 *
 * No layer finalizer: stopping stays the explicit `stop()` the shutdown
 * calls (`composition/lifecycle/index.ts`), in the same sequence, before
 * the runtime is disposed.
 */
import { Context, Effect, Layer } from 'effect';

import { reportFailure, safeFailure } from '@socio/foundation/observability/failures';

import type { ActorAccess } from '../../actors/service.js';
import type { ApprovalContinuations } from '../../approvals/continue.js';
import type { ApprovalService } from '../../approvals/service.js';
import type { BackupService } from '../../backup/backup-service.js';
import type { ChatNameSuggestions } from '../../chat-name-suggestions/service.js';
import type { ThreadTitler } from '../../chat-name-suggestions/thread-titles.js';
import type { SteeringTurns } from '../../context/steering-turns.js';
import type { ModuleContext, ServerModule } from '../../modules/contract.js';
import {
    releaseModules,
    runTick,
    startModules,
    stopModules,
    succeedModules,
    type ModuleEffectRunner,
} from '../../modules/lifecycle.js';
import type { AnalyticsClient } from '../../operations/analytics/client.js';
import type { RoomOrchestrator } from '../../rooms/orchestrator.js';
import type { RoomStreams } from '../../rooms/streams.js';
import type { RoomTopics } from '../../rooms/telegram-topics.js';
import type { GoalService } from '../../schedules/goals.js';
import type { JobService } from '../../schedules/jobs.js';
import type { LongRunService } from '../../schedules/long-runs.js';
import type { TelegramChannel } from '../../telegram/telegram-channel.js';
import type { LocalAgentRunner } from '../../turns/local-runner.js';
import { Dictation, type DictationShape } from '../../voice/contract.js';
import { LegacyActors } from '../actors.js';
import { LegacyApprovals, LegacyContinuations } from '../approvals.js';
import { LegacyConfig, LegacyRunner, ModuleHost } from '../base.js';
import { LegacyChatNames, LegacyThreadTitles } from '../chat-name-suggestions.js';
import type { PlatformConfig } from '../config.js';
import { LegacySteering } from '../context.js';
import { LegacyAnalytics } from '../operations.js';
import { Ports, type PlatformPorts } from '../ports.js';
import { LegacyOrchestrator, LegacyRoomStreams, LegacyRoomTopics } from '../rooms.js';
import { LegacyGoals, LegacyJobs, LegacyLongRuns } from '../schedules.js';
import { LegacyTraceExporter } from '../turns.js';

import { DataKeyAdmin, type DataKeyAdminShape } from './data-keys.js';

/** The leader's work, the drain and the listening wait. */
export interface LeaderWorkShape {
    /** A process that is the only one (tests, a single instance): `lead()` and at once `succeed()`. */
    start(): Promise<void>;
    /** The leader's work (CB-108): the modules' ticks, the hourly re-seal, then the modules start. */
    lead(): Promise<void>;
    /** Picks up what dead processes left (CB-108): the modules' `succeed`, then what waited. */
    succeed(): Promise<void>;
    /** The leader hands over (CB-108). Idempotent until the next `lead()`: the same promise. */
    stopBackground(): Promise<void>;
    /** Stops everything, the modules last but the runner; the first module failure is rethrown. */
    stop(): Promise<void>;
    /** SIGTERM (CB-37): new turns are refused, the ones running finish. Once. */
    drain(): void;
    /** Turns, Telegram replies and job runs in progress. */
    inProgress(): number;
    /** The server will start listening later (CB-161): fills the `listening` port. */
    awaitListening(): void;
    /** The server is listening. */
    markListening(): void;
    /** The Telegram channel, set at boot: its port, and what its commands act on (CB-145). */
    useTelegram(channel: TelegramChannel): void;
    /** Scheduled backups, set at boot: their port. */
    useBackups(service: BackupService): void;
}

/** The leader's work, one per runtime (`composition/app/work.ts`). */
export class LeaderWork extends Context.Service<LeaderWork, LeaderWorkShape>()('socio/composition/app/LeaderWork') {}

/** What the leader's work reads: the services built before it, the modules and the late ports. */
export interface WorkSources {
    readonly config: Pick<PlatformConfig, 'dataKeys' | 'appOrigin'>;
    readonly modules: readonly ServerModule[];
    readonly context: ModuleContext;
    readonly runEffects: ModuleEffectRunner;
    readonly runner: Pick<LocalAgentRunner, 'running' | 'close'>;
    readonly ports: Pick<PlatformPorts, 'telegram' | 'backups' | 'draining' | 'listening'>;
    readonly dataKeys: Pick<DataKeyAdminShape, 'reseal'>;
    readonly goals: Pick<GoalService, 'reconcile'>;
    readonly jobs: JobService;
    readonly longRuns: LongRunService;
    readonly approvals: ApprovalService;
    readonly roomTopics: RoomTopics;
    readonly actors: Pick<ActorAccess, 'drain' | 'stop'>;
    readonly continuations: Pick<ApprovalContinuations, 'resume' | 'stop'>;
    readonly orchestrator: Pick<RoomOrchestrator, 'resume' | 'stop'>;
    readonly steering: Pick<SteeringTurns, 'resume' | 'stop'>;
    readonly roomStreams: Pick<RoomStreams, 'stop'>;
    readonly titles: Pick<ThreadTitler, 'stop'>;
    readonly chatNames: Pick<ChatNameSuggestions, 'stop'>;
    readonly dictation: Pick<DictationShape, 'closeAll'>;
    readonly analytics?: Pick<AnalyticsClient, 'start' | 'stop'>;
    readonly traceExporter?: { shutdown(): Promise<unknown> };
}

/** The leader's work over its sources (`LeaderWork`). */
export class Work implements LeaderWorkShape {
    private ticks: ReturnType<typeof setInterval>[] = [];
    private background?: Promise<void>;
    /** Resolves the `listening` port, which `awaitListening()` sets, with `markListening()` (CB-161). */
    private listeningNow?: () => void;
    constructor(private readonly sources: WorkSources) {}

    /** The Telegram channel, when configured: its late-bound port. */
    private get telegram(): TelegramChannel | undefined {
        return this.sources.ports.telegram.peek();
    }
    /** Scheduled backups (CB-63), when the server set them up: their late-bound port. */
    private get backups(): BackupService | undefined {
        return this.sources.ports.backups.peek();
    }

    useTelegram(channel: TelegramChannel) {
        this.sources.ports.telegram.fill(channel);
        // What its direct messages' commands and buttons act on (CB-145); a
        // stand-in channel may not take them.
        channel.useServices?.({
            approvals: this.sources.approvals,
            jobs: this.sources.jobs,
            longRuns: this.sources.longRuns,
            appOrigin: this.sources.config.appOrigin,
            // Forum topics bound to rooms (CB-214).
            topics: this.sources.roomTopics,
        });
    }

    useBackups(service: BackupService) {
        this.sources.ports.backups.fill(service);
    }

    /**
     * Set on SIGTERM (CB-37): new web and Telegram turns are refused
     * ("updating, try again in a minute"); the ones running finish. Telegram
     * stops polling, so messages sent meanwhile wait for the next process.
     */
    drain() {
        const { draining } = this.sources.ports;
        if (draining.get()) {
            return;
        }
        draining.fill(true);
        this.sources.jobs.drain();
        void this.telegram?.drain();
        // Broker contexts' leases go to the next task (CB-232).
        this.sources.actors.drain();
    }

    /**
     * Turns, Telegram replies and job runs in progress; not a long run's
     * batches, which resume after the restart.
     */
    inProgress() {
        return this.sources.runner.running + this.sources.jobs.holdingDrain + (this.telegram?.handling ?? 0);
    }

    /**
     * The server will start listening later (call before it does): boot-time
     * work that calls the app, as resumed long runs do, waits for
     * `markListening()` (CB-161).
     */
    awaitListening() {
        const { listening } = this.sources.ports;
        if (!listening.peek()) {
            listening.fill(
                new Promise<void>((resolve) => {
                    this.listeningNow = resolve;
                }),
            );
        }
    }

    markListening() {
        this.listeningNow?.();
    }

    async start() {
        await this.lead();
        await this.succeed();
    }

    /**
     * The leader's work (CB-108): schedules every module's tick, then starts
     * the modules in order. Only the runtime that holds the leader lease
     * calls it (index.ts), so it runs once among the app's instances.
     */
    async lead() {
        const { config, context, dataKeys, modules, runEffects } = this.sources;
        this.background = undefined;
        // A goal's schedule without its goal (a crash between the two) ends.
        await this.sources.goals.reconcile();
        for (const module of modules) {
            const tick = module.tick;
            if (!tick) {
                continue;
            }
            // An async run that is still going skips the next tick (CB-110).
            let running = false;
            const timer = setInterval(() => {
                if (running) {
                    return;
                }
                const run = runTick(tick, context, runEffects);
                if (!(run instanceof Promise)) {
                    return;
                }
                running = true;
                run.catch((error: unknown) => reportFailure(`Tick of ${module.id}`, [safeFailure(error)])).finally(
                    () => {
                        running = false;
                    },
                );
            }, tick.everyMs);
            timer.unref();
            this.ticks.push(timer);
        }
        const reseal = () =>
            void dataKeys.reseal().catch(() => context.log('Data key: the re-seal failed; it runs again later.'));
        if (config.dataKeys?.current) {
            const timer = setInterval(reseal, 60 * 60_000);
            timer.unref();
            this.ticks.push(timer);
        }
        await startModules(modules, context, runEffects);
        // In the background: S3 may be slow or unreachable.
        reseal();
        this.backups?.start();
        this.sources.analytics?.start();
    }

    /**
     * Picks up what dead processes left (CB-108): the modules' `succeed`,
     * then decisions and messages left waiting. The leader calls it once no
     * other runtime is alive, so a draining predecessor's turns and
     * continuations are never taken for abandoned ones.
     */
    async succeed() {
        const { context, modules, runEffects } = this.sources;
        await succeedModules(modules, context, runEffects);
        // Decisions left waiting by the last process (Telegram is up by now).
        await this.sources.continuations.resume();
        // A room's socio that was to answer next (CB-206), then the queues.
        await this.sources.orchestrator.resume();
        void this.sources.steering.resume();
    }

    /**
     * The leader hands over (a drain, CB-108): its ticks, the modules'
     * `release`, backups and analytics stop, so the next leader can start
     * them; requests, turns and runs in progress carry on until `stop()`.
     * Idempotent; `stop()` runs it first.
     */
    stopBackground(): Promise<void> {
        return (this.background ??= (async () => {
            const { context, modules, runEffects } = this.sources;
            for (const timer of this.ticks.splice(0)) {
                clearInterval(timer);
            }
            this.backups?.stop();
            let failure: { error: unknown } | undefined;
            await releaseModules(modules, context, runEffects).catch((error: unknown) => {
                failure = { error };
            });
            // Analytics' own store (DuckDB) has one writer: the next leader's.
            await this.sources.analytics?.stop();
            if (failure) {
                throw failure.error;
            }
        })());
    }

    /**
     * Stops the modules in reverse order, each even if an earlier one failed,
     * then closes the runner; the first failure is rethrown.
     */
    async stop() {
        const { context, modules, runEffects } = this.sources;
        await this.stopBackground().catch((error: unknown) =>
            reportFailure('Stopping the leader work failed', [safeFailure(error)]),
        );
        // Live dictation (CB-222): each composer sends its recording instead.
        this.sources.dictation.closeAll();
        this.sources.roomStreams.stop();
        this.sources.continuations.stop();
        this.sources.steering.stop();
        this.sources.orchestrator.stop();
        this.sources.actors.stop();
        this.backups?.stop();
        await this.sources.titles.stop();
        await this.sources.chatNames.stop();
        await this.sources.analytics?.stop();
        // The last turns' spans, for a moment at most.
        await this.sources.traceExporter?.shutdown();
        let failure: { error: unknown } | undefined;
        await stopModules(modules, context, runEffects).catch((error: unknown) => {
            failure = { error };
        });
        this.sources.runner.close();
        if (failure) {
            throw failure.error;
        }
    }
}

/**
 * `LeaderWork` over the services built before it, the modules, the data
 * keys, `Dictation` and the late ports. Each service is the instance its
 * tag holds, so a spy on the tests' view (`platform.<member>`) sees its
 * calls.
 */
const LeaderWorkLive = Layer.effect(
    LeaderWork,
    Effect.gen(function* () {
        const { modules, context, runEffects } = (yield* ModuleHost).use((modules, context, runEffects) => ({
            modules,
            context,
            runEffects,
        }));
        return LeaderWork.of(
            new Work({
                config: yield* LegacyConfig,
                modules,
                context,
                runEffects,
                runner: yield* LegacyRunner,
                ports: yield* Ports,
                dataKeys: yield* DataKeyAdmin,
                goals: yield* LegacyGoals,
                jobs: yield* LegacyJobs,
                longRuns: yield* LegacyLongRuns,
                approvals: yield* LegacyApprovals,
                roomTopics: yield* LegacyRoomTopics,
                actors: yield* LegacyActors,
                continuations: yield* LegacyContinuations,
                orchestrator: yield* LegacyOrchestrator,
                steering: yield* LegacySteering,
                roomStreams: yield* LegacyRoomStreams,
                titles: yield* LegacyThreadTitles,
                chatNames: yield* LegacyChatNames,
                dictation: yield* Dictation,
                analytics: yield* LegacyAnalytics,
                traceExporter: yield* LegacyTraceExporter,
            }),
        );
    }),
);

/** The step, as `composition/index.ts` places it. */
export const appWorkLayers = { step: LeaderWorkLive };
