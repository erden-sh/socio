import type { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '@socio/data/open';
import type { Action, Result, Settings } from '@socio/shared/types';

import { openCoreStore, type CoreStore } from '../../src/server/composition/core-store.js';
import { workspaceStoreParts, type AppWorkspaceTypes } from '../../src/server/composition/workspace-parts.js';
import type { ChangeCounters } from '../../src/server/live/change-counters.js';
import type {
    EpisodeRepository,
    MemoryRepository,
    ProfileRepository,
    SpaceMemoryRepository,
    TimeZoneNoteRepository,
} from '../../src/server/memory/contract.js';
import type { Claim, ScheduleInput } from '../../src/server/schedules/contract.js';
import type { TaskService } from '../../src/server/schedules/tasks.js';
import type {
    SecretSetting,
    SecretSettingChanges,
    SecretSettingsShape,
    WorkspaceSettingsShape,
} from '../../src/server/settings/contract.js';
import type { StoreSlices } from '../../src/server/settings/store.js';
import { WorkspaceStore as WorkspaceSlicesStore } from '../../src/server/workspace/workspace.js';

/**
 * The workspace as the tests open it: the server's (`AppWorkspace`, over
 * `workspaceStoreParts`) with the old one-argument constructor. A path opens a
 * connection of its own.
 */
export class WorkspaceStore extends WorkspaceSlicesStore<AppWorkspaceTypes> {
    constructor(database: string | DatabaseSync) {
        super(database, workspaceStoreParts);
    }
}

/**
 * The core store as the tests open it: the boot step's parts (`openCoreStore`,
 * `composition/core-store.ts`), which this class is, with the old constructor
 * (a path opens a connection of its own) and the old forwarding methods over
 * `slices` and `scheduled`, so the tests keep their calls. The server reads
 * the parts themselves.
 */
export class Store implements CoreStore, WorkspaceSettingsShape, SecretSettingsShape {
    private db: DatabaseSync;
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
    /**
     * Scheduled tasks and their runs, the Scheduling context's service on
     * this connection (CB-110); the methods below keep their old names.
     */
    readonly scheduled: TaskService;
    /** Whether this store opened its connection, and so closes it. */
    private owned: boolean;
    /** A path opens a connection of its own; a connection is shared. */
    constructor(database: string | DatabaseSync) {
        this.owned = typeof database === 'string';
        this.db = typeof database === 'string' ? openDatabase(database) : database;
        const parts = openCoreStore(this.db);
        this.slices = parts.slices;
        this.counters = parts.counters;
        this.memoryItems = parts.memoryItems;
        this.profiles = parts.profiles;
        this.timeZoneNotes = parts.timeZoneNotes;
        this.episodes = parts.episodes;
        this.spaceMemories = parts.spaceMemories;
        this.scheduled = parts.scheduled;
    }
    /** The connection, for the Scheduling context's units of work. */
    get connection() {
        return this.db;
    }
    /**
     * A schedule never runs sooner than this after its previous run started
     * (the minimum interval, kept even where DST shortens a cron's gap).
     */
    get scheduleMinGapMs() {
        return this.scheduled.scheduleMinGapMs;
    }
    set scheduleMinGapMs(gap: () => number) {
        this.scheduled.scheduleMinGapMs = gap;
    }
    /** How long a claimed task is held before another claim may take it over. */
    get leaseMs() {
        return this.scheduled.leaseMs;
    }
    set leaseMs(ms: number) {
        this.scheduled.leaseMs = ms;
    }
    /** Gives tasks and memories from before user accounts to a user. */
    async assignUnowned(userId: string): Promise<number> {
        const tasks = await this.scheduled.assignUnowned(userId);
        return tasks + (await this.memoryItems.assignUnowned(userId));
    }
    /** Closes the connection if this store opened it. */
    close() {
        if (this.owned && this.db.isOpen) {
            this.slices.settings.keepFinal();
            this.db.close();
        }
    }
    // ── WorkspaceSettings (`slices.settings`) ──
    /**
     * Live settings, or the final snapshot captured before closing our connection.
     * Teardown consumers may outlive a separately owned settings database; ordinary
     * settings() keeps its live-database contract and still fails after close.
     */
    settingsSnapshot(): Settings {
        return this.slices.settings.settingsSnapshot();
    }
    settings(): Settings {
        return this.slices.settings.settings();
    }
    /**
     * Saves the settings; turning work off (a pause, research or memory)
     * interrupts the tasks running, in the same unit of work (CB-110).
     * `secrets` sets (sealed) or clears secret settings with them, from the
     * settings as saved; it may throw to save nothing. A new transcription
     * URL clears its key first (CB-204), so a key can't be sent somewhere
     * new by editing the URL alone.
     */
    updateSettings(patch: Partial<Settings>, secrets?: SecretSettingChanges): Promise<Settings> {
        return this.slices.settings.updateSettings(patch, secrets);
    }
    // ── SecretSettings (`slices.secrets`) ──
    /** A secret setting's sealed value and URL (CB-204); never in `settings()`. */
    secretSetting(name: string): SecretSetting | undefined {
        return this.slices.secrets.secretSetting(name);
    }
    /** A secret setting sealed again, unless it changed meanwhile (CB-62). */
    replaceSecretSetting(name: string, previous: string, next: string) {
        return this.slices.secrets.replaceSecretSetting(name, previous, next);
    }
    // The task API, by its old names (`TaskService`).
    /** The user's tasks, newest first. */
    tasks(userId: string) {
        return this.scheduled.list(userId);
    }
    /** Every live task, for the worker and its lifecycle checks. */
    allTasks() {
        return this.scheduled.all();
    }
    /** Request boundary check: the task exists and is the user's. */
    ownedTask(id: string, userId: string) {
        return this.scheduled.owned(id, userId);
    }
    /** A live task; a deleted one is missing. */
    task(id: string) {
        return this.scheduled.get(id);
    }
    /** A task, deleted or not, with its stamp (admin, tests). */
    withDeletedTask(id: string) {
        return this.scheduled.withDeleted(id);
    }
    createTask(prompt: string, intervalSeconds: number | null, userId: string) {
        return this.scheduled.create(prompt, intervalSeconds, userId);
    }
    detail(id: string) {
        return this.scheduled.detail(id);
    }
    event(taskId: string, runId: string | null, text: string) {
        return this.scheduled.event(taskId, runId, text);
    }
    action(id: string, action: Action) {
        return this.scheduled.action(id, action);
    }
    pauseTasks(ids: readonly string[], reason: string) {
        return this.scheduled.pauseTasks(ids, reason);
    }
    dotScheduleIds(dotId: string) {
        return this.scheduled.dotScheduleIds(dotId);
    }
    goalScheduleCandidates() {
        return this.scheduled.goalScheduleCandidates();
    }
    endAfterRun(id: string) {
        return this.scheduled.endAfterRun(id);
    }
    pauseOwnedBy(userId: string, reason: string) {
        return this.scheduled.pauseOwnedBy(userId, reason);
    }
    createSchedule(input: ScheduleInput) {
        return this.scheduled.createSchedule(input);
    }
    schedules(userId: string) {
        return this.scheduled.schedules(userId);
    }
    activeScheduleCount(userId: string) {
        return this.scheduled.activeScheduleCount(userId);
    }
    scheduleCounts() {
        return this.scheduled.scheduleCounts();
    }
    recentRuns(taskId: string, limit = 5) {
        return this.scheduled.recentRuns(taskId, limit);
    }
    taskRuns(taskId: string, limit: number, before?: string) {
        return this.scheduled.taskRuns(taskId, limit, before);
    }
    deleteTask(id: string, userId: string, withParent: string | null = null, now = Date.now()) {
        return this.scheduled.deleteTask(id, userId, withParent, now);
    }
    jobSchedules(jobId: string) {
        return this.scheduled.jobSchedules(jobId);
    }
    schedule(id: string, intervalSeconds: number | null) {
        return this.scheduled.schedule(id, intervalSeconds);
    }
    claim(now = Date.now(), admitted?: () => boolean) {
        return this.scheduled.claim(now, admitted);
    }
    owns(claim: Claim) {
        return this.scheduled.owns(claim);
    }
    finish(claim: Claim, result: Result, now = Date.now()) {
        return this.scheduled.finish(claim, result, now);
    }
    interrupt(claim: Claim, reason: string) {
        return this.scheduled.interrupt(claim, reason);
    }
    fail(claim: Claim, error: string) {
        return this.scheduled.fail(claim, error);
    }
}
