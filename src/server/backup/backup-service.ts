import { mkdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
    backupDatabaseOnline,
    backupUserData,
    mirrorObjects,
    PARTS_MIRROR,
    pruneBackups,
    removeLeftovers,
    sizeOf,
    snapshotObjects,
    writePrivate,
} from '@socio/data/backup';
import { checkPrefix, type ObjectStore } from '@socio/data/object-store';
import { tenantPrefix } from '@socio/data/storage/keys';
import { s3SettingsFromEnv } from '@socio/data/storage/settings';
import { SecretBox, type DataKeyring, type SealState } from '@socio/foundation/keys/secret-box';
import type { CopyAlertThresholds } from '@socio/shared/continuous-copy';
import type {
    PluginBackupHistoryEntry,
    PluginBackupStatus,
    PluginSnapshotReason,
} from '@socio/shared/plugins/plugin-backup';
import type { BackupSchedule, BackupStatus, ContinuousCopyStatus } from '@socio/shared/types';
import type { RestoreDrillResult } from '@socio/shared/types';

import type { ObjectStoresShape } from '../storage/contract.js';

import {
    fetchContinuousCopy,
    listContinuousCopies,
    ltxWaitMs,
    readLtxState,
    sampleContinuousCopy,
    shipContinuousCopy,
    type LtxState,
} from './backup-ltx.js';
import { copyOffsite } from './backup-offsite.js';
import {
    DEFAULT_DRILL_INTERVAL_DAYS,
    DEFAULT_LTX_INTERVAL_SECONDS,
    DEFAULT_PURGE_BACKUP_DAYS,
    DRILL_INTERVAL_MAX_DAYS,
    LTX_INTERVAL_MAX_SECONDS,
    LTX_INTERVAL_MIN_SECONDS,
    PURGE_BACKUP_MAX_DAYS,
    type BackupResult,
    type BackupSettings,
    type BackupsShape,
    type SealedValues,
} from './contract.js';
import {
    COPY_ALERT_PATH,
    COPY_CHECKPOINT_EVERY_MS,
    CopyAlerts,
    passiveCheckpoint,
    valveDue,
    type CheckpointResult,
    type CopyAlertNotice,
} from './copy-alerts.js';
import { COPY_BEHIND_MS, continuousCopyStatus, newestCopyAt } from './litestream-status.js';
import {
    delivered,
    noticed,
    observePluginGaps,
    readPluginGaps,
    writePluginGaps,
    type PluginGapNotice,
} from './plugin-gaps.js';
import { pluginChunkNameKey } from './plugin-offsite.js';
import {
    observeSnapshotNotices,
    PluginSnapshots,
    readPluginSnapshots,
    recordAttempt,
    requestAllowed,
    snapshotNoticed,
    withSnapshots,
    writePluginSnapshots,
    type PluginAttempt,
    type PluginBackupTarget,
    type PluginSnapshotHost,
} from './plugin-snapshots.js';
import { keptRunStamps, PluginSnapshotStore } from './plugin-store.js';
import { prunePurgeBackups } from './purge-backups.js';
import { RestoreDrill } from './restore-drill.js';

const HOUR = 3_600_000;
/** A running backup touches its lock this often. */
const LOCK_BEAT_MS = 60_000;
/** A lock untouched for this long is from a run that died: taken over. */
export const STALE_LOCK_MS = 15 * 60_000;

/** 0, or whole days up to a year. */
export const validDrillInterval = (days: number) =>
    Number.isInteger(days) && days >= 0 && days <= DRILL_INTERVAL_MAX_DAYS;

/** Whole days from 1 to a year. */
export const validPurgeBackupDays = (days: number) =>
    Number.isInteger(days) && days >= 1 && days <= PURGE_BACKUP_MAX_DAYS;

/** 0, or whole seconds from 10 to a day. */
export const validLtxInterval = (seconds: number) =>
    Number.isInteger(seconds) &&
    (seconds === 0 || (seconds >= LTX_INTERVAL_MIN_SECONDS && seconds <= LTX_INTERVAL_MAX_SECONDS));

/**
 * BACKUP_DIR, where the backups (and the bundle import's copies, CB-380)
 * go. Reading it never needs the data key or the off-site settings.
 */
export function backupDirFromEnv(env: Record<string, string | undefined>): string {
    return env.BACKUP_DIR?.trim() || 'data/backups';
}

/**
 * Reads the backup settings. The off-site copy seals the database and
 * datasets under the data key, so it needs DATA_ENCRYPTION_KEY. Malformed
 * settings stop startup without echoing secrets.
 */
export function backupSettingsFromEnv(
    env: Record<string, string | undefined>,
    options: { dataKey: boolean },
): BackupSettings {
    const keep = Number(env.BACKUP_KEEP?.trim() || 14);
    if (!Number.isInteger(keep) || keep < 1) {
        throw new Error('BACKUP_KEEP must be a positive integer.');
    }
    const interval = Number(env.BACKUP_INTERVAL_HOURS?.trim() || 24);
    if (!Number.isFinite(interval) || interval < 0) {
        throw new Error('BACKUP_INTERVAL_HOURS must be a number of hours (0 turns scheduled backups off).');
    }
    const ltx = Number(env.BACKUP_LTX_INTERVAL_SECONDS?.trim() || DEFAULT_LTX_INTERVAL_SECONDS);
    if (!validLtxInterval(ltx)) {
        throw new Error(
            `BACKUP_LTX_INTERVAL_SECONDS must be 0 (off) or whole seconds from ${LTX_INTERVAL_MIN_SECONDS} to ${LTX_INTERVAL_MAX_SECONDS}.`,
        );
    }
    const drill = Number(env.RESTORE_DRILL_INTERVAL_DAYS?.trim() || DEFAULT_DRILL_INTERVAL_DAYS);
    if (!validDrillInterval(drill)) {
        throw new Error(
            `RESTORE_DRILL_INTERVAL_DAYS must be 0 (only by hand) or whole days up to ${DRILL_INTERVAL_MAX_DAYS}.`,
        );
    }
    const purge = Number(env.PURGE_BACKUP_DAYS?.trim() || DEFAULT_PURGE_BACKUP_DAYS);
    if (!validPurgeBackupDays(purge)) {
        throw new Error(`PURGE_BACKUP_DAYS must be whole days from 1 to ${PURGE_BACKUP_MAX_DAYS}.`);
    }
    const continuous = env.LITESTREAM_REPLICA_DIR?.trim();
    const litestream = env.LITESTREAM_BIN?.trim();
    const settings: BackupSettings = {
        directory: backupDirFromEnv(env),
        keep,
        intervalHours: interval,
        ltxIntervalSeconds: ltx,
        drillIntervalDays: drill,
        purgeBackupDays: purge,
        ...(continuous ? { continuous } : {}),
        ...(litestream ? { litestream } : {}),
    };
    if (!env.BACKUP_S3_ENDPOINT?.trim()) {
        return settings;
    }
    if (!options.dataKey) {
        throw new Error('BACKUP_S3_ENDPOINT needs DATA_ENCRYPTION_KEY: the off-site copy is sealed with it.');
    }
    const prefix = env.BACKUP_S3_PREFIX?.trim() ?? '';
    try {
        checkPrefix(prefix);
    } catch {
        throw new Error('BACKUP_S3_PREFIX must be a key prefix of letters, digits, . _ - and /, e.g. company-brain/.');
    }
    return {
        ...settings,
        offsite: {
            ...s3SettingsFromEnv(env, 'BACKUP_', {
                example: 'https://s3.eu-west-1.amazonaws.com',
            }),
            prefix: prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix,
        },
    };
}

/** What `BACKUP_DIR/backup-status.json` holds. */
interface StatusFile {
    lastAttemptAt?: number;
    lastSuccessAt?: number;
    lastSizeBytes?: number;
    lastErrorAt?: number;
    lastError?: string;
    offsiteSuccessAt?: number;
    offsiteError?: string;
}

/** A short reason that names no path, key or secret. */
export function backupFailure(error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) {
        return `File system error (${code}).`;
    }
    const message = error instanceof Error ? error.message : 'unknown error';
    // Our own messages name no paths; anything else is cut short anyway.
    return message.replace(/(\/[^\s'"]+)+/g, '…').slice(0, 200);
}

export interface BackupRun {
    databasePath: string;
    userDataDir: string;
    settings: BackupSettings;
    /** The data space's object store, when it is S3. */
    objects?: { store: ObjectStore; tenantId: string };
    /** The off-site target, made from `settings.offsite` with `stores` unless given. */
    offsiteStore?: ObjectStore;
    /** Storage's object stores (`ObjectStores`): the off-site target is `s3(settings.offsite)`. */
    stores?: Pick<ObjectStoresShape, 's3'>;
    /** The data keys: the off-site copy seals with the current one. */
    keys?: DataKeyring;
    /**
     * Permanent removals' backups older than this many days go after the
     * backup (CB-391): the days in force, an admin's over PURGE_BACKUP_DAYS.
     * Left out (`pnpm run backup`, which can't read Settings), they stay
     * for the next scheduled backup.
     */
    purgeBackupDays?: number;
    /**
     * The run's plugin snapshots (CB-458), under its lock and
     * stamp, after the data spaces: one plugin at a time, a failed one never
     * failing the run. Left out (`pnpm run backup`, which can't reach
     * plugins), the run takes none, and still prunes and sends off-site what
     * the store keeps.
     */
    pluginStep?: (stamp: string) => Promise<{ taken: number; failed: number; skipped: number }>;
    /**
     * The installed plugins, for pruning: only theirs keep a newest good
     * snapshot past the rules (`retainedPastRules`). Left out, every
     * plugin's does, until the app's next run prunes with them.
     */
    pluginsInstalled?: () => string[];
    now?: Date;
    log?: (line: string) => void;
}

/** BACKUP_DIR's plugin snapshot store, sealed under the data key; none without one. */
export function pluginStoreOf(
    settings: Pick<BackupSettings, 'directory'>,
    keys: DataKeyring | undefined,
    freeBytes?: (directory: string) => Promise<number>,
) {
    return keys?.current
        ? new PluginSnapshotStore({
              directory: settings.directory,
              box: new SecretBox(keys, 'backups'),
              ...(freeBytes ? { freeBytes } : {}),
          })
        : undefined;
}

/** The off-site target: the one given, else storage's S3 store for `settings.offsite`. */
function offsiteStoreOf(run: Pick<BackupRun, 'offsiteStore' | 'stores' | 'settings'>): ObjectStore {
    if (run.offsiteStore) {
        return run.offsiteStore;
    }
    if (!run.stores) {
        throw new Error('The off-site copy has no object store.');
    }
    return run.stores.s3(run.settings.offsite!);
}

const statusPath = (directory: string) => join(directory, 'backup-status.json');
export function readBackupStatus(directory: string): StatusFile {
    try {
        return JSON.parse(readFileSync(statusPath(directory), 'utf8'));
    } catch {
        return {};
    }
}
function writeStatus(directory: string, status: StatusFile) {
    writePrivate(statusPath(directory), JSON.stringify(status));
}

/**
 * `BACKUP_DIR/.backup-running`: one run at a time, across processes too.
 * The run touches it every minute, so one cut off by a crash or a redeploy
 * holds it for STALE_LOCK_MS at most.
 */
export function lock(directory: string) {
    const path = join(directory, '.backup-running');
    mkdirSync(directory, { recursive: true });
    try {
        mkdirSync(path);
    } catch {
        let age = 0;
        try {
            age = Date.now() - statSync(path).mtimeMs;
        } catch {
            // Gone meanwhile.
        }
        if (age < STALE_LOCK_MS) {
            throw new Error('A backup is already running.');
        }
        rmSync(path, { recursive: true, force: true });
        mkdirSync(path);
    }
    const beat = setInterval(() => {
        try {
            const now = new Date();
            utimesSync(path, now, now);
        } catch {
            // Taken over or removed: the run finishes anyway.
        }
    }, LOCK_BEAT_MS);
    beat.unref();
    return () => {
        clearInterval(beat);
        rmSync(path, { recursive: true, force: true });
    };
}

/**
 * One backup (CB-63), scheduled or by hand (`pnpm run backup`): the database
 * and the data spaces online, with S3 the object mirror (incremental) and
 * its snapshot as hard links, then the off-site copy when configured. The
 * result goes to `BACKUP_DIR/backup-status.json`, which the setup checklist
 * shows. A failed off-site copy keeps the local backup and says so.
 */
export async function runBackup(run: BackupRun): Promise<BackupResult> {
    const { settings } = run;
    const now = run.now ?? new Date();
    const release = lock(settings.directory);
    const status = readBackupStatus(settings.directory);
    status.lastAttemptAt = now.getTime();
    // This run's copies: removed again when it fails, so an incomplete run
    // never counts against BACKUP_KEEP or pushes a good backup out.
    const made: string[] = [];
    try {
        removeLeftovers(settings.directory);
        const db = await backupDatabaseOnline(run.databasePath, settings.directory, settings.keep, now, {
            prune: false,
        });
        made.push(db.path);
        let objects: BackupResult['objects'];
        const mirror = {
            dir: join(settings.directory, 'objects'),
            manifest: join(settings.directory, 'objects.json'),
        };
        if (run.objects) {
            objects = await mirrorObjects(
                run.objects.store,
                tenantPrefix(run.objects.tenantId),
                mirror.dir,
                mirror.manifest,
            );
        }
        // The mirror as of this run goes in before the copy gets its name.
        const data = await backupUserData(run.userDataDir, settings.directory, settings.keep, now, {
            prune: false,
            extra: run.objects ? (partial) => snapshotObjects(mirror.dir, partial) : undefined,
        });
        made.length = 0;
        // Plugin snapshots (CB-458): a failure here never fails the run.
        const stamp = basename(db.path).replace(/^company-brain-(.+)\.sqlite$/, '$1');
        let plugins: BackupResult['plugins'];
        if (run.pluginStep) {
            try {
                plugins = { ...(await run.pluginStep(stamp)), pruned: 0 };
            } catch (error) {
                run.log?.(`Plugin backups: the run's plugin step failed: ${backupFailure(error)}`);
            }
        }
        pruneBackups(settings.directory, settings.keep);
        const pluginStore = pluginStoreOf(settings, run.keys);
        if (pluginStore) {
            try {
                const pruned = await pluginStore.prune({
                    runs: keptRunStamps(settings.directory),
                    purgeDays: run.purgeBackupDays ?? settings.purgeBackupDays ?? DEFAULT_PURGE_BACKUP_DAYS,
                    ...(run.pluginsInstalled ? { installed: new Set(run.pluginsInstalled()) } : {}),
                });
                if (plugins) {
                    plugins.pruned = pruned.removed.length;
                }
                if (pruned.unreadable.length) {
                    run.log?.(
                        `Plugin backups: ${pruned.unreadable.length} snapshot record(s) couldn't be opened; they are kept, and their plugins' chunks aren't swept.`,
                    );
                }
            } catch (error) {
                run.log?.(`Plugin backups: pruning failed: ${backupFailure(error)}`);
            }
        }
        // A failure here never fails the backup: the old ones wait for the next run.
        let prunedPurges = 0;
        if (run.purgeBackupDays !== undefined) {
            try {
                prunedPurges = prunePurgeBackups(
                    settings.directory,
                    run.purgeBackupDays,
                    now.getTime(),
                    run.log,
                ).length;
            } catch (error) {
                run.log?.(`Removing old permanent removal backups failed: ${backupFailure(error)}`);
            }
        }
        const sizeBytes =
            sizeOf(db.path) + sizeOf(data.path) - sizeOf(join(data.path, 'objects')) + (objects?.bytes ?? 0);
        const result: BackupResult = {
            database: db.path,
            userdata: data.path,
            datasets: data.datasets,
            files: data.files,
            ...(data.parts ? { parts: data.parts } : {}),
            ...(data.missingParts ? { missingParts: data.missingParts } : {}),
            ...(prunedPurges ? { prunedPurgeBackups: prunedPurges } : {}),
            objects,
            sizeBytes,
            ...(plugins && plugins.taken + plugins.failed + plugins.skipped + plugins.pruned ? { plugins } : {}),
        };
        Object.assign(status, {
            lastSuccessAt: now.getTime(),
            lastSizeBytes: sizeBytes,
            lastErrorAt: undefined,
            lastError: undefined,
        });
        if (settings.offsite) {
            try {
                if (!run.keys?.current) {
                    throw new Error('The off-site copy needs DATA_ENCRYPTION_KEY.');
                }
                result.offsite = await copyOffsite({
                    target: offsiteStoreOf(run),
                    prefix: settings.offsite.prefix,
                    box: new SecretBox(run.keys, 'backups'),
                    database: db.path,
                    userdata: data.path,
                    mirror: run.objects ? mirror : undefined,
                    parts: join(settings.directory, PARTS_MIRROR),
                    state: join(settings.directory, 'offsite.json'),
                    keep: settings.keep,
                    ...(pluginStore
                        ? {
                              plugins: {
                                  store: pluginStore,
                                  nameKey: pluginChunkNameKey(run.keys!.current!),
                                  keptRuns: keptRunStamps(settings.directory),
                                  state: join(settings.directory, 'offsite-plugins.json'),
                              },
                          }
                        : {}),
                });
                status.offsiteSuccessAt = now.getTime();
                status.offsiteError = undefined;
            } catch (error) {
                result.offsiteError = backupFailure(error);
                status.offsiteError = result.offsiteError;
            }
        }
        return result;
    } catch (error) {
        for (const path of made) {
            rmSync(path, { recursive: true, force: true });
        }
        status.lastErrorAt = now.getTime();
        status.lastError = backupFailure(error);
        throw error;
    } finally {
        writeStatus(settings.directory, status);
        release();
    }
}

/** The log line of a backup: counts and sizes, never names. */
export function backupLine(result: BackupResult) {
    const parts = [
        `the database and ${result.datasets} dataset(s), ${result.files} local file(s)`,
        result.parts && `${result.parts} analytical part(s)`,
        result.missingParts && `${result.missingParts} analytical part(s) missing`,
        result.objects &&
            `${result.objects.objects} object(s) (${result.objects.fetched} fetched, ${result.objects.removed} removed)`,
        `${result.sizeBytes} bytes`,
        result.prunedPurgeBackups && `${result.prunedPurgeBackups} permanent removal backup(s) past their days removed`,
        result.plugins &&
            `plugins: ${result.plugins.taken} snapshot(s) taken, ${result.plugins.failed} failed, ${result.plugins.skipped} disabled, ${result.plugins.pruned} old one(s) removed`,
        result.offsite &&
            `off-site: ${result.offsite.sent} file(s) sent, ${result.offsite.prunedSnapshots} old snapshot(s) removed${result.offsite.plugins ? `, ${result.offsite.plugins.chunksSent} plugin chunk(s) sent` : ''}`,
        result.offsiteError && `off-site copy failed: ${result.offsiteError}`,
    ].filter(Boolean);
    return `Backup: ${parts.join('; ')}.`;
}

export interface BackupServiceOptions extends Omit<BackupRun, 'now'> {
    log: (line: string) => void;
    /** First check after start; 60 s. */
    firstCheckMs?: number;
    /** How often it checks whether a backup is due; 5 minutes. */
    checkMs?: number;
    /** How often it checks whether the continuous copy's files are due off-site; 10 s. */
    ltxCheckMs?: number;
    /** An admin's schedule from Settings, over the environment's; read each check. */
    schedule?: () => Partial<BackupSchedule> | undefined;
    /** After a restore drill that failed (CB-111): admins are told. */
    onDrillFailure?: (result: RestoreDrillResult) => unknown;
    /**
     * The continuous copy's alert thresholds in force (CB-315), read each
     * check: an admin's from Settings over the environment's. Without
     * them, the copy is reported without a level and nobody is alerted.
     */
    copyAlerts?: () => CopyAlertThresholds;
    /** A change in the continuous copy's level, or an hourly reminder while critical (CB-315). */
    onCopyAlert?: (notice: CopyAlertNotice & { path: string }) => unknown;
    /** How often the continuous copy is checked for alerts; 60 s. */
    copyCheckMs?: number;
    /** The safety valve's checkpoint (`passiveCheckpoint` by default). */
    checkpoint?: (databasePath: string) => Promise<CheckpointResult>;
    /** What the drill's recovery key check samples (`BackupConfig.sealed`); none when left out. */
    sealed?: SealedValues;
    /**
     * Installed plugins that keep state on their own volumes (CB-458), read
     * on every status and check; none when left out (`pnpm run backup`).
     */
    plugins?: () => PluginBackupStatus[];
    /**
     * A notice about a plugin's backups (CB-458): flagged "Not backed up" or
     * its weekly reminder, and its snapshots failing, out of date or
     * working again. Rejects when it reached no admin.
     */
    onPluginGap?: (notice: Pick<PluginGapNotice, 'id' | 'title' | 'message' | 'path'>) => unknown;
    /**
     * Snapshots of the plugins that declare backups (CB-458, step 5): the
     * installs, their tasks and host calls, and the per-plugin size cap in
     * force. Left out, no plugin snapshot is taken.
     */
    pluginSnapshots?: {
        host: PluginSnapshotHost;
        maxBytes: () => number;
        /** PLUGIN_SNAPSHOT_TIME_MS and PLUGIN_POLL_MS by default. */
        timeMs?: number;
        pollMs?: number;
        /** PLUGIN_END_TIME_MS by default: how long a plugin's `DELETE` may take. */
        endMs?: number;
        /** Free bytes on BACKUP_DIR; `statfs` by default. Tests replace it. */
        freeBytes?: (directory: string) => Promise<number>;
    };
    now?: () => number;
}

/**
 * Scheduled backups in the app (CB-63): every BACKUP_INTERVAL_HOURS since
 * the last attempt (as `backup-status.json` records it, so restarts don't
 * reset the clock), a failed one retried within the hour. Off with
 * BACKUP_INTERVAL_HOURS=0; `pnpm run backup` still works by hand.
 *
 * With the off-site copy and LITESTREAM_REPLICA_DIR, it also sends the
 * continuous copy's new files off-site every BACKUP_LTX_INTERVAL_SECONDS
 * (CB-112), a failed send retried later each time (up to 30 minutes). An
 * admin's schedule from Settings takes the place of both intervals, from
 * the next check on.
 */
export class BackupService implements BackupsShape {
    private timer?: ReturnType<typeof setTimeout>;
    private ltxTimer?: ReturnType<typeof setTimeout>;
    private copyTimer?: ReturnType<typeof setTimeout>;
    private readonly copyAlerts = new CopyAlerts();
    private checkpointedAt = 0;
    /** What admins last heard of the valve in this critical stretch. */
    private valveNoticed?: 'complete' | 'incomplete';
    private running?: Promise<BackupResult | undefined>;
    /** Plugin snapshots outside a run, one at a time (CB-458): a run waits for them, and they for it. */
    private pluginWork: Promise<unknown> = Promise.resolve();
    /** Plugins with a snapshot taken or waiting now: a request for one joins it. */
    private readonly pluginsInFlight = new Map<string, Promise<PluginAttempt>>();
    private pluginStoreCache?: PluginSnapshotStore | null;
    private shipping?: Promise<boolean>;
    private ltxState?: LtxState;
    private target?: ObjectStore;
    private stopped = false;
    /** When it started: nothing waits off-site from before then. */
    private readonly since: number;
    /** The continuous copy's restore drill (CB-111), with LITESTREAM_REPLICA_DIR. */
    readonly drill?: RestoreDrill;
    constructor(private options: BackupServiceOptions) {
        this.since = this.now();
        const { settings, keys } = options;
        const replica = settings.continuous;
        if (!replica) {
            return;
        }
        // The newest lineage off-site, as `fetch-ltx` opens it.
        const offsite =
            settings.offsite && keys?.current
                ? async (directory: string) => {
                      const target = this.offsiteTarget();
                      const [newest] = await listContinuousCopies(target, settings.offsite!.prefix);
                      if (!newest) {
                          return { files: 0 };
                      }
                      return fetchContinuousCopy({
                          target,
                          prefix: settings.offsite!.prefix,
                          box: new SecretBox(keys, 'backups'),
                          directory,
                          lineage: newest.lineage,
                      });
                  }
                : undefined;
        this.drill = new RestoreDrill({
            directory: settings.directory,
            replica,
            databasePath: options.databasePath,
            litestream: settings.litestream ?? 'litestream',
            ...(offsite ? { offsite } : {}),
            intervalDays: () => this.schedule().drillIntervalDays,
            ready: () => newestCopyAt(replica) !== undefined,
            reason: backupFailure,
            log: options.log,
            onFailure: options.onDrillFailure,
            sealed: options.sealed ?? [],
            now: () => this.now(),
        });
    }
    private offsiteTarget() {
        return (this.target ??= offsiteStoreOf(this.options));
    }
    private now() {
        return this.options.now?.() ?? Date.now();
    }
    /** The intervals in force: an admin's over the environment's. */
    schedule(): BackupSchedule {
        const own = this.options.schedule?.();
        const { settings } = this.options;
        return {
            intervalHours: own?.intervalHours ?? settings.intervalHours,
            ltxIntervalSeconds: own?.ltxIntervalSeconds ?? settings.ltxIntervalSeconds ?? DEFAULT_LTX_INTERVAL_SECONDS,
            drillIntervalDays: own?.drillIntervalDays ?? settings.drillIntervalDays ?? DEFAULT_DRILL_INTERVAL_DAYS,
            purgeBackupDays: own?.purgeBackupDays ?? settings.purgeBackupDays ?? DEFAULT_PURGE_BACKUP_DAYS,
        };
    }
    /** Whether the continuous copy goes off-site: both are set up, with a data key. */
    private ltxConfigured() {
        const { settings, keys } = this.options;
        return !!(settings.offsite && settings.continuous && keys?.current);
    }
    private ltxPath() {
        return join(this.options.settings.directory, 'offsite-ltx.json');
    }
    private ltx() {
        return (this.ltxState ??= readLtxState(this.ltxPath()));
    }
    /** The continuous copy, and its files off-site when they go. */
    private continuousStatus(replica: string): ContinuousCopyStatus {
        const now = this.now();
        const copy = continuousCopyStatus(
            replica,
            this.options.databasePath,
            now,
            this.options.copyAlerts?.(),
            this.since,
        );
        if (!this.ltxConfigured()) {
            return copy;
        }
        const state = this.ltx();
        const intervalSeconds = this.schedule().ltxIntervalSeconds;
        // The newest copy came after the last full send: it waits since then
        // (before the first, since it came or the server started).
        const lagMs =
            copy.lastCopiedAt !== undefined && copy.lastCopiedAt >= (state.lastSentAt ?? 0)
                ? Math.max(0, now - (state.lastSentAt ?? Math.max(copy.lastCopiedAt, this.since)))
                : 0;
        const failures = state.failures ?? 0;
        const waiting = state.waiting ?? 0;
        // A file that keeps waiting (never a whole LTX file) holds back every
        // removal off-site: behind once it has waited as long as a copy may.
        const stuck = waiting > 0 && now - (state.lastSentAt ?? this.since) > intervalSeconds * 1000 + COPY_BEHIND_MS;
        return {
            ...copy,
            offsite: {
                intervalSeconds,
                ...(state.lastSentAt ? { lastSentAt: state.lastSentAt } : {}),
                lagMs,
                waiting,
                failures,
                ...(failures && state.lastError ? { lastErrorAt: state.lastErrorAt, lastError: state.lastError } : {}),
                behind: !!intervalSeconds && (failures > 0 || stuck || lagMs > intervalSeconds * 1000 + COPY_BEHIND_MS),
            },
        };
    }
    /** For admins' setup: the last run, never paths or keys. */
    status(): BackupStatus {
        const file = readBackupStatus(this.options.settings.directory);
        return {
            intervalHours: this.schedule().intervalHours,
            offsite: !!this.options.settings.offsite,
            running: !!this.running,
            ...(file.lastSuccessAt ? { lastSuccessAt: file.lastSuccessAt } : {}),
            ...(file.lastSizeBytes !== undefined ? { lastSizeBytes: file.lastSizeBytes } : {}),
            ...(file.lastError ? { lastErrorAt: file.lastErrorAt, lastError: file.lastError } : {}),
            ...(this.options.settings.offsite && file.offsiteSuccessAt
                ? { offsiteSuccessAt: file.offsiteSuccessAt }
                : {}),
            ...(this.options.settings.offsite && file.offsiteError ? { offsiteError: file.offsiteError } : {}),
            ...(this.options.settings.continuous
                ? {
                      continuous: this.continuousStatus(this.options.settings.continuous),
                  }
                : {}),
            ...(this.drill ? { restoreDrill: this.drill.status() } : {}),
            ...this.pluginStatus(),
        };
    }
    /** The installed plugins with state (CB-458), with since when each is flagged; nothing without any. */
    private pluginStatus(): Pick<BackupStatus, 'plugins'> {
        let statuses: PluginBackupStatus[];
        try {
            statuses = this.pluginStatuses();
        } catch {
            return {};
        }
        return statuses.length ? { plugins: statuses } : {};
    }
    /**
     * Every installed plugin with state: the manifest's status, since when
     * one without `backup` is flagged, and what its snapshots say.
     */
    private pluginStatuses(): PluginBackupStatus[] {
        const statuses = this.options.plugins?.() ?? [];
        if (!statuses.length) {
            return [];
        }
        const { directory } = this.options.settings;
        const gaps = readPluginGaps(directory);
        const targets = this.pluginTargets();
        return withSnapshots(
            statuses.map((status) => {
                const since = noticed(status) ? gaps[status.id]?.flaggedAt : undefined;
                return since === undefined ? status : { ...status, since };
            }),
            readPluginSnapshots(directory),
            {
                now: this.now(),
                intervalHours: this.schedule().intervalHours,
                disabled: new Set(targets.filter((target) => !target.running).map((target) => target.id)),
                running: new Set(this.pluginsInFlight.keys()),
            },
        );
    }
    /** One plugin's backup status (CB-458), for its page; undefined for one without state. */
    pluginBackupStatus(id: string): PluginBackupStatus | undefined {
        try {
            return this.pluginStatuses().find((status) => status.id === id);
        } catch {
            return undefined;
        }
    }
    /** The installs that declare backups, as the snapshots' host lists them; none without it. */
    private pluginTargets(): PluginBackupTarget[] {
        try {
            return this.options.pluginSnapshots?.host.targets() ?? [];
        } catch {
            return [];
        }
    }
    /** The plugin snapshot store, sealed under the data key; none without one. */
    private pluginStore() {
        if (this.pluginStoreCache === undefined) {
            this.pluginStoreCache =
                pluginStoreOf(this.options.settings, this.options.keys, this.options.pluginSnapshots?.freeBytes) ??
                null;
        }
        return this.pluginStoreCache ?? undefined;
    }
    /**
     * One plugin's snapshot, recorded: the protocol, then the level 1 drill
     * on what was stored. A snapshot that fails its check is dropped, so it
     * never counts as good. Admins hear of a failure, a stale backup and a
     * recovery. Never throws.
     */
    private async attemptPlugin(
        target: PluginBackupTarget,
        reason: PluginSnapshotReason,
        options: { run?: string; note?: string } = {},
    ): Promise<PluginAttempt> {
        const { directory } = this.options.settings;
        const store = this.pluginStore();
        const config = this.options.pluginSnapshots;
        let attempt: PluginAttempt;
        let check: { ok: boolean; error?: string } | undefined;
        if (!store || !config) {
            attempt = {
                id: target.id,
                ok: false,
                error: 'Plugin backups need DATA_ENCRYPTION_KEY: snapshots are sealed with it.',
            };
        } else {
            const snapshots = new PluginSnapshots({
                store,
                host: config.host,
                maxBytes: config.maxBytes,
                now: () => this.now(),
                ...(config.timeMs !== undefined ? { timeMs: config.timeMs } : {}),
                ...(config.pollMs !== undefined ? { pollMs: config.pollMs } : {}),
                ...(config.endMs !== undefined ? { endMs: config.endMs } : {}),
            });
            attempt = await snapshots.take(target, reason, options);
            if (attempt.ok) {
                const verified = await store.verify(target.id, attempt.snapshotId).catch(() => ({
                    ok: false,
                    error: "The snapshot's record couldn't be opened.",
                }));
                check = verified.ok ? { ok: true } : { ok: false, error: verified.error ?? 'unknown' };
                if (!verified.ok) {
                    await store.discard(target.id, attempt.snapshotId).catch(() => false);
                }
            }
        }
        const file = readPluginSnapshots(directory);
        file[target.id] = recordAttempt(file[target.id], attempt, this.now(), check);
        // A status file that can't be written (a full disk) never stops the snapshot or the next plugin.
        this.savePluginSnapshots(file, `recording ${target.id}`);
        this.options.log(
            attempt.ok && check?.ok !== false
                ? `Plugin backups: ${target.id} (${reason}): ${attempt.bytes} bytes, ${attempt.fetched.chunks} new chunk(s), ${attempt.reused} reused.`
                : `Plugin backups: ${target.id} (${reason}) failed: ${file[target.id]!.lastError}`,
        );
        await this.notifySnapshots().catch((error) =>
            this.options.log(`Plugin backups: notices failed: ${backupFailure(error)}`),
        );
        return attempt.ok && check?.ok === false
            ? { id: target.id, ok: false, error: file[target.id]!.lastError! }
            : attempt;
    }
    /** Admins hear of a plugin whose snapshots fail, are out of date, or work again; each recorded once delivered. */
    private async notifySnapshots() {
        if (!this.options.pluginSnapshots) {
            return;
        }
        const { directory } = this.options.settings;
        const now = this.now();
        const notices = observeSnapshotNotices(this.pluginStatuses(), readPluginSnapshots(directory), now);
        for (const notice of notices) {
            const sent = await Promise.resolve(this.options.onPluginGap?.(notice)).then(
                () => true,
                () => false,
            );
            if (sent) {
                this.savePluginSnapshots(
                    snapshotNoticed(readPluginSnapshots(directory), notice, now),
                    `recording the notice about ${notice.id}`,
                );
            }
        }
    }
    /**
     * The run's plugin step: every plugin that declares backups, one at a
     * time, each within its time cap. A disabled plugin isn't started: its
     * snapshots stay, and its status says since when.
     */
    private async pluginRun(stamp: string) {
        const counts = { taken: 0, failed: 0, skipped: 0 };
        const { directory } = this.options.settings;
        for (const target of [...this.pluginTargets()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
            if (!target.running) {
                const file = readPluginSnapshots(directory);
                if (file[target.id]?.disabledSince === undefined) {
                    file[target.id] = { ...file[target.id], disabledSince: this.now() };
                    this.savePluginSnapshots(file, `recording ${target.id}`);
                }
                counts.skipped++;
                continue;
            }
            const attempt = this.track(target.id, this.attemptPlugin(target, 'scheduled', { run: stamp }));
            if ((await attempt).ok) {
                counts.taken++;
            } else {
                counts.failed++;
            }
        }
        return counts;
    }
    /** `plugin-snapshots.json`, written; a failure is logged, never thrown. */
    private savePluginSnapshots(file: Parameters<typeof writePluginSnapshots>[1], what: string) {
        try {
            writePluginSnapshots(this.options.settings.directory, file);
        } catch (error) {
            this.options.log(`Plugin backups: ${what} failed: ${backupFailure(error)}`);
        }
    }
    private track(id: string, attempt: Promise<PluginAttempt>) {
        this.pluginsInFlight.set(id, attempt);
        // Both outcomes handled: a rejection here is never left unhandled.
        const settle = () => {
            if (this.pluginsInFlight.get(id) === attempt) {
                this.pluginsInFlight.delete(id);
            }
        };
        attempt.then(settle, settle);
        return attempt;
    }
    /**
     * One plugin's snapshot outside a run: **Back up now**
     * (`manual`) or the plugin's own request (`request`, rate-limited by
     * `requestPluginBackup`). It joins one already taken or waiting for the
     * plugin. Otherwise it waits for a run in progress and takes the run's
     * lock, so it never overlaps a run here or `pnpm run backup`. Resolves
     * at once; the snapshot goes on in the background.
     */
    backUpPlugin(
        id: string,
        reason: 'manual' | 'request',
        note?: string,
    ):
        | { ok: true; coalesced: boolean; done: Promise<PluginAttempt> }
        | { ok: false; status: 404 | 409; error: string } {
        const target = this.pluginTargets().find((candidate) => candidate.id === id);
        if (!target) {
            return { ok: false, status: 404, error: 'That plugin doesn’t declare backups, or isn’t installed.' };
        }
        if (!this.options.pluginSnapshots) {
            return { ok: false, status: 409, error: 'Plugin backups aren’t set up on this server.' };
        }
        if (!target.running) {
            return { ok: false, status: 409, error: 'The plugin is disabled: enable it to back it up.' };
        }
        const joined = this.pluginsInFlight.get(id);
        if (joined) {
            return { ok: true, coalesced: true, done: joined };
        }
        const before = this.pluginWork;
        const running = this.running;
        const done = this.track(
            id,
            (async () => {
                await before.catch(() => undefined);
                await running?.catch(() => undefined);
                let release: () => void;
                try {
                    release = lock(this.options.settings.directory);
                } catch {
                    const attempt: PluginAttempt = {
                        id,
                        ok: false,
                        error: 'A backup is already running; it was not taken. Try again after it.',
                    };
                    this.options.log(`Plugin backups: ${id} (${reason}) failed: ${attempt.error}`);
                    return attempt;
                }
                try {
                    // The install as it is now, not as it was asked for.
                    const now = this.pluginTargets().find((candidate) => candidate.id === id) ?? target;
                    return await this.attemptPlugin(now, reason, note !== undefined ? { note } : {});
                } finally {
                    release();
                }
            })(),
        );
        this.pluginWork = done.catch(() => undefined);
        return { ok: true, coalesced: false, done };
    }
    /**
     * A plugin's own request (`socio.backup.request`): joined to a snapshot
     * already taken or waiting for it, else at most one an hour and four a
     * day.
     */
    requestPluginBackup(
        id: string,
        note: string,
    ):
        | { ok: true; coalesced: boolean }
        | { ok: false; status: 404 | 409; error: string }
        | { ok: false; status: 429; error: string; retryAfterSeconds: number } {
        const target = this.pluginTargets().find((candidate) => candidate.id === id);
        if (target && this.pluginsInFlight.has(id)) {
            return { ok: true, coalesced: true };
        }
        const { directory } = this.options.settings;
        const file = readPluginSnapshots(directory);
        const allowed = requestAllowed(file[id], this.now());
        if (target && !allowed.ok) {
            return {
                ok: false,
                status: 429,
                error: 'Too many backup requests: at most one an hour and four a day.',
                retryAfterSeconds: allowed.retryAfterSeconds,
            };
        }
        const started = this.backUpPlugin(id, 'request', note);
        if (!started.ok) {
            return started;
        }
        if (!started.coalesced && allowed.ok) {
            const latest = readPluginSnapshots(directory);
            latest[id] = { ...latest[id], requests: allowed.requests };
            this.savePluginSnapshots(latest, `recording ${id}'s request`);
        }
        return { ok: true, coalesced: started.coalesced };
    }
    /** A plugin's stored snapshots, newest first (its page's history); none without the store. */
    pluginHistory(id: string): PluginBackupHistoryEntry[] {
        const store = this.pluginStore();
        if (!store) {
            return [];
        }
        let records;
        try {
            ({ records } = store.records(id));
        } catch {
            return [];
        }
        return records
            .map(({ record }) => ({
                snapshotId: record.snapshotId,
                takenAt: record.takenAt,
                reason: record.reason,
                ...(record.note !== undefined ? { note: record.note } : {}),
                ...(record.run !== undefined ? { run: record.run } : {}),
                version: record.install.version,
                bytes: record.bytes,
            }))
            .sort((a, b) => b.takenAt - a.takenAt);
    }
    /**
     * One check of the plugins without a backup (CB-458): admins
     * hear once when one is flagged, and weekly while it stays flagged.
     */
    async checkPlugins() {
        if (!this.options.plugins) {
            return;
        }
        const { directory } = this.options.settings;
        const previous = readPluginGaps(directory);
        const now = this.now();
        let { file, notices } = observePluginGaps(this.options.plugins(), previous, now);
        if (JSON.stringify(file) !== JSON.stringify(previous)) {
            writePluginGaps(directory, file);
        }
        for (const notice of notices) {
            this.options.log(
                `Plugin backups: ${notice.id} keeps data on its own volumes without service.backup${notice.reminder ? ' (reminder)' : ''}.`,
            );
            // Recorded only once delivered: a failed notice goes again with the next check.
            const sent = await Promise.resolve(this.options.onPluginGap?.(notice)).then(
                () => true,
                () => false,
            );
            if (sent) {
                file = delivered(file, notice, now);
                writePluginGaps(directory, file);
            } else {
                this.options.log(
                    `Plugin backups: the notice about ${notice.id} failed; it is sent again with the next check.`,
                );
            }
        }
        // Snapshots out of date, which no attempt reports (CB-458 step 5).
        await this.notifySnapshots();
    }
    /**
     * The continuous copy's files off-site, by the key that sealed them, as
     * the last sends recorded (CB-322). They are sealed only under a data
     * key, so never legacy; a file under an older key goes again under the
     * current one with the next send.
     */
    sealStates(): Record<SealState, number> {
        const counts = { current: 0, previous: 0, legacy: 0, unknown: 0 };
        if (!this.ltxConfigured()) {
            return counts;
        }
        const box = new SecretBox(this.options.keys!, 'backups');
        try {
            for (const entry of Object.values(this.ltx().sent)) {
                counts[box.state(entry.key)]++;
            }
        } finally {
            box.dispose();
        }
        return counts;
    }
    /**
     * A few of the newest lineage's sealed files off-site, as stored, for a
     * recovery key check (CB-322); none without the off-site copy.
     */
    async sampleOffsite(count: number): Promise<Buffer[]> {
        if (!this.options.settings.offsite) {
            return [];
        }
        return sampleContinuousCopy(this.offsiteTarget(), this.options.settings.offsite.prefix, count);
    }
    /** Whether a scheduled backup is due now. */
    due() {
        const hours = this.schedule().intervalHours;
        if (!hours) {
            return false;
        }
        const file = readBackupStatus(this.options.settings.directory);
        if (!file.lastAttemptAt) {
            return true;
        }
        const failed = !!file.lastError && file.lastErrorAt === file.lastAttemptAt;
        const wait = failed ? Math.min(hours * HOUR, HOUR) : hours * HOUR;
        return this.now() - file.lastAttemptAt >= wait;
    }
    /** One backup now; resolves undefined when it failed (logged). */
    run(): Promise<BackupResult | undefined> {
        if (this.running) {
            return this.running;
        }
        const { log } = this.options;
        // A plugin snapshot outside a run holds the lock: the run waits for it.
        this.running = this.pluginWork
            .then(() =>
                runBackup({
                    ...this.options,
                    purgeBackupDays: this.schedule().purgeBackupDays,
                    ...(this.options.pluginSnapshots
                        ? {
                              pluginStep: (stamp: string) => this.pluginRun(stamp),
                              pluginsInstalled: () => (this.options.plugins?.() ?? []).map((status) => status.id),
                          }
                        : {}),
                    now: new Date(this.now()),
                }),
            )
            .then((result) => {
                log(backupLine(result));
                return result;
            })
            .catch((error) => {
                log(`Backup failed: ${backupFailure(error)}`);
                return undefined;
            })
            .finally(() => {
                this.running = undefined;
            });
        return this.running;
    }
    /** Whether the continuous copy's files are due to go off-site now. */
    ltxDue() {
        if (!this.ltxConfigured()) {
            return false;
        }
        const seconds = this.schedule().ltxIntervalSeconds;
        if (!seconds) {
            return false;
        }
        const state = this.ltx();
        if (!state.lastAttemptAt) {
            return true;
        }
        return this.now() - state.lastAttemptAt >= ltxWaitMs(seconds, state.failures);
    }
    /**
     * Sends the continuous copy's new files off-site now; resolves whether
     * it worked. Failures are logged once, and so is the send after them.
     */
    shipContinuous(): Promise<boolean> {
        if (this.shipping) {
            return this.shipping;
        }
        const { settings, log } = this.options;
        if (!this.ltxConfigured()) {
            return Promise.resolve(false);
        }
        const failed = this.ltx().failures ?? 0;
        const startedAt = this.now();
        this.shipping = shipContinuousCopy({
            target: this.offsiteTarget(),
            prefix: settings.offsite!.prefix,
            box: new SecretBox(this.options.keys!, 'backups'),
            replica: settings.continuous!,
            state: this.ltxPath(),
            reason: backupFailure,
            now: () => this.now(),
        })
            .then(({ started }) => {
                if (started?.others) {
                    log(
                        `Continuous copy off-site: sending a new lineage, ${started.lineage}; the ${started.others} older one(s) stay off-site until removed by hand.`,
                    );
                }
                if (failed) {
                    log('Continuous copy off-site: sending again after a failure.');
                }
                return true;
            })
            .catch((error) => {
                if (!failed) {
                    log(`Continuous copy off-site failed: ${backupFailure(error)}`);
                }
                return false;
            })
            .finally(() => {
                const state = readLtxState(this.ltxPath());
                // One that couldn't even record itself (a full disk) waits all the same.
                this.ltxState =
                    (state.lastAttemptAt ?? 0) >= startedAt
                        ? state
                        : { ...state, lastAttemptAt: startedAt, failures: failed + 1 };
                this.shipping = undefined;
            });
        return this.shipping;
    }
    /**
     * One check of the continuous copy (CB-315): admins hear of a change of
     * level, are reminded hourly while it is critical, and, once the log is
     * past its critical size while the copy is critically behind, the safety
     * valve checkpoints it (`passiveCheckpoint` says why that is safe).
     */
    async checkCopy() {
        const replica = this.options.settings.continuous;
        const thresholds = this.options.copyAlerts?.();
        if (!replica || !thresholds) {
            return;
        }
        const now = this.now();
        const status = continuousCopyStatus(replica, this.options.databasePath, now, thresholds, this.since);
        const notice = this.copyAlerts.observe(status, now);
        if (notice) {
            this.options.log(`Continuous copy: ${notice.title.toLowerCase()} (${status.level}).`);
            await Promise.resolve(this.options.onCopyAlert?.({ ...notice, path: COPY_ALERT_PATH })).catch(
                () => undefined,
            );
        }
        if (status.level !== 'critical') {
            this.valveNoticed = undefined;
        }
        if (!valveDue(status, thresholds) || now - this.checkpointedAt < COPY_CHECKPOINT_EVERY_MS) {
            return;
        }
        this.checkpointedAt = now;
        try {
            const result = await (this.options.checkpoint ?? passiveCheckpoint)(this.options.databasePath);
            // A reader (Litestream itself, if it is only stuck) can hold it short
            // of the log's end: then the log can't start over and still grows.
            const outcome = !result.busy && result.checkpointed >= result.log ? 'complete' : 'incomplete';
            this.options.log(
                `Continuous copy: the write-ahead log passed its critical size while the copy was critically behind; checkpointed ${result.checkpointed} of ${result.log} page(s) (PASSIVE${outcome === 'incomplete' ? ', incomplete: a reader holds the rest' : ''}).`,
            );
            if (this.valveNoticed !== outcome) {
                this.valveNoticed = outcome;
                await Promise.resolve(
                    this.options.onCopyAlert?.({
                        level: 'critical',
                        previous: 'critical',
                        reminder: false,
                        ...(outcome === 'complete'
                            ? {
                                  title: 'Write-ahead log checkpointed',
                                  message:
                                      'Litestream has been behind for a long time and the write-ahead log passed its critical size, so the app checkpointed it: new writes reuse the log instead of growing it. No data is lost; when Litestream is back it starts from a fresh snapshot, so points in time during the outage can’t be restored.',
                              }
                            : {
                                  title: 'Write-ahead log checkpoint incomplete',
                                  message: `Litestream has been behind for a long time and the write-ahead log passed its critical size. The app’s checkpoint copied ${result.checkpointed} of ${result.log} pages: a reader still holds the rest, so the log can keep growing. It tries again every 10 minutes; restart the litestream service or free disk space.`,
                              }),
                        path: COPY_ALERT_PATH,
                    }),
                ).catch(() => undefined);
            }
        } catch (error) {
            this.options.log(`Continuous copy: the safety checkpoint failed: ${backupFailure(error)}`);
        }
    }
    start() {
        this.stopped = false;
        this.drill?.start();
        if (this.options.settings.continuous && this.options.copyAlerts) {
            const tick = () => {
                if (this.stopped) {
                    return;
                }
                void this.checkCopy()
                    .catch(() => undefined)
                    .finally(() => {
                        if (this.stopped) {
                            return;
                        }
                        this.copyTimer = setTimeout(tick, this.options.copyCheckMs ?? 60_000);
                        this.copyTimer.unref();
                    });
            };
            this.copyTimer = setTimeout(tick, this.options.copyCheckMs ?? 60_000);
            this.copyTimer.unref();
        }
        if (this.ltxConfigured()) {
            const tick = () => {
                if (this.stopped) {
                    return;
                }
                const next = () => {
                    if (this.stopped) {
                        return;
                    }
                    this.ltxTimer = setTimeout(tick, this.options.ltxCheckMs ?? 10_000);
                    this.ltxTimer.unref();
                };
                if (this.ltxDue()) {
                    void this.shipContinuous().finally(next);
                } else {
                    next();
                }
            };
            this.ltxTimer = setTimeout(tick, this.options.ltxCheckMs ?? 10_000);
            this.ltxTimer.unref();
        }
        const check = () => {
            if (this.stopped) {
                return;
            }
            const next = () => {
                if (this.stopped) {
                    return;
                }
                this.timer = setTimeout(check, this.options.checkMs ?? 5 * 60_000);
                this.timer.unref();
            };
            // Plugins without a backup (CB-458) are checked with every backup check.
            void this.checkPlugins().catch((error) =>
                this.options.log(`Plugin backups: the check failed: ${backupFailure(error)}`),
            );
            if (this.due()) {
                void this.run().finally(next);
            } else {
                next();
            }
        };
        this.timer = setTimeout(check, this.options.firstCheckMs ?? 60_000);
        this.timer.unref();
    }
    /** Stops scheduling; a backup in progress finishes (its files are atomic). */
    stop() {
        this.stopped = true;
        this.drill?.stop();
        if (this.timer) {
            clearTimeout(this.timer);
        }
        if (this.ltxTimer) {
            clearTimeout(this.ltxTimer);
        }
        if (this.copyTimer) {
            clearTimeout(this.copyTimer);
        }
    }
}
