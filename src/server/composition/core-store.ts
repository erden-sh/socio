import type { DatabaseSync } from 'node:sqlite';

import { sqliteData } from '@socio/data/open';

import type { DotTurnStore } from '../dots/contract.js';
import { ChangeCounters } from '../live/change-counters.js';
import type { StateStore } from '../live/contract.js';
import type {
    EpisodeRepository,
    MemoryRepository,
    ProfileRepository,
    SpaceMemoryRepository,
    TimeZoneNoteRepository,
} from '../memory/contract.js';
import { sqliteMemoryRepositories } from '../memory/infra/sqlite/index.js';
import type { Claim } from '../schedules/contract.js';
import { sqliteTaskRepositories } from '../schedules/infra/sqlite/index.js';
import type { SchedulesStore } from '../schedules/slices.js';
import { TaskService } from '../schedules/tasks.js';
import { seedSettings, settingsSlices, type StoreSlices } from '../settings/store.js';
import type { TaskRunnerStore } from '../turns/contract.js';

/**
 * What the boot step builds on the app's connection beside the workspace: the
 * settings slices (`WorkspaceSettings` and `SecretSettings`,
 * `settings/contract.ts`), the change counters, memory's repositories and the
 * Scheduling context's task service. A record of the parts, not a facade: each
 * caller reads the part it uses. The root offers it under `LegacyStore`
 * (`composition/base.ts`), and the settings layer provides its slices as the
 * settings' tags.
 *
 * It builds memory's and schedules' repositories on its connection, so it
 * lives in the composition, which may import every feature; the settings
 * keep their schema and slices (`settings/store.ts`).
 */
export interface CoreStore {
    /** The connection, for the Scheduling context's units of work. */
    readonly connection: DatabaseSync;
    /** The settings slices on this connection; the root's layers provide them. */
    readonly slices: StoreSlices;
    /** Bumped by triggers on settings, tasks and memories. */
    readonly counters: ChangeCounters;
    /**
     * The users' memories and profiles (CB-106), the Memory context's
     * repositories on this connection (CB-110).
     */
    readonly memoryItems: MemoryRepository;
    readonly profiles: ProfileRepository;
    /** The notes of a detected time zone that moved (CB-176). */
    readonly timeZoneNotes: TimeZoneNoteRepository;
    /** What happened in each person's own chats (CB-180). */
    readonly episodes: EpisodeRepository;
    /** Each Space's shared memory (CB-181). */
    readonly spaceMemories: SpaceMemoryRepository;
    /** Scheduled tasks and their runs, the Scheduling context's service on this connection (CB-110). */
    readonly scheduled: TaskService;
    /**
     * Closes what the store opened: nothing on the server, which shares its
     * connection with the workspace and closes it itself. The shutdown
     * calls it before the workspace's (`closeDatabase`).
     */
    close(): void;
}

/**
 * The core store's parts on `db`, the one connection the server shares with
 * the workspace (`openDatabase`, CB-110). Seeds the settings row first.
 */
export function openCoreStore(db: DatabaseSync): CoreStore {
    seedSettings(db);
    const counters = new ChangeCounters(db);
    const data = sqliteData(db);
    const memory = sqliteMemoryRepositories(data);
    // The task service reads the settings slice built just after it, as
    // the slice interrupts its running tasks: each reaches the other lazily.
    let slices: StoreSlices | undefined;
    const scheduled = new TaskService(data.uow, sqliteTaskRepositories(data), () => slices!.settings.settings());
    slices = settingsSlices(db, (reason) => scheduled.interruptRunning(reason));
    return {
        connection: db,
        slices,
        counters,
        memoryItems: memory.memories,
        profiles: memory.profiles,
        timeZoneNotes: memory.timeZoneNotes,
        episodes: memory.episodes,
        spaceMemories: memory.spaceMemories,
        scheduled,
        close: () => {},
    };
}

/** Gives tasks and memories from before user accounts to a user; how many. */
export async function assignUnowned(store: Pick<CoreStore, 'scheduled' | 'memoryItems'>, userId: string) {
    const tasks = await store.scheduled.assignUnowned(userId);
    return tasks + (await store.memoryItems.assignUnowned(userId));
}

/*
 * The core store as the features that read several of its parts at once
 * type it: each is that feature's own shape (in its contract), filled from
 * the parts at the moment of each call.
 */

/** A Dot's turn: the settings, the episodes and the time zone notes (`DotTurnStore`). */
export const dotTurnStoreOf = (store: CoreStore): DotTurnStore => ({
    settings: () => store.slices.settings.settings(),
    episodes: store.episodes,
    timeZoneNotes: store.timeZoneNotes,
});

/** `GET /api/state`: the settings, a person's tasks and memories (`StateStore`). */
export const stateStoreOf = (store: CoreStore): StateStore => ({
    settings: () => store.slices.settings.settings(),
    tasks: (userId) => store.scheduled.list(userId),
    memoryItems: store.memoryItems,
});

/** Schedules, jobs, goals and long runs: the settings and the task service (`SchedulesStore`). */
export function schedulesStoreOf(store: CoreStore): SchedulesStore {
    const tasks = store.scheduled;
    return {
        settings: () => store.slices.settings.settings(),
        // Read by the task service, set by the schedules (`ScheduleService`).
        get scheduleMinGapMs() {
            return tasks.scheduleMinGapMs;
        },
        set scheduleMinGapMs(gap: () => number) {
            tasks.scheduleMinGapMs = gap;
        },
        action: (id, action) => tasks.action(id, action),
        activeScheduleCount: (userId) => tasks.activeScheduleCount(userId),
        createSchedule: (input) => tasks.createSchedule(input),
        endAfterRun: (id) => tasks.endAfterRun(id),
        goalScheduleCandidates: () => tasks.goalScheduleCandidates(),
        jobSchedules: (jobId) => tasks.jobSchedules(jobId),
        recentRuns: (taskId, limit) => tasks.recentRuns(taskId, limit),
        scheduleCounts: () => tasks.scheduleCounts(),
        schedules: (userId) => tasks.schedules(userId),
        taskRuns: (taskId, limit, before) => tasks.taskRuns(taskId, limit, before),
        ownedTask: (id, userId) => tasks.owned(id, userId),
    };
}

/** The task runner: the task claims, the settings and a person's memories (`TaskRunnerStore`). */
export function taskRunnerStoreOf(store: CoreStore): TaskRunnerStore {
    const tasks = store.scheduled;
    return {
        get leaseMs() {
            return tasks.leaseMs;
        },
        set leaseMs(ms: number) {
            tasks.leaseMs = ms;
        },
        claim: (now, admitted) => tasks.claim(now, admitted),
        owns: (claim) => tasks.owns(claim as Claim),
        finish: (claim, result) => tasks.finish(claim as Claim, result),
        fail: (claim, error) => tasks.fail(claim as Claim, error),
        interrupt: (claim, reason) => tasks.interrupt(claim as Claim, reason),
        event: (taskId, runId, text) => tasks.event(taskId, runId, text),
        settings: () => store.slices.settings.settings(),
        memoryItems: store.memoryItems,
    };
}
