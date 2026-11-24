/**
 * What other features may know of backups (CB-63, CB-109, CB-111, CB-322):
 * their tag, the slice of the service they call, and the plain types and
 * constants around it. It imports only `effect` and `@socio/*`, and holds
 * no logic.
 *
 * The types and constants here moved from `backup-service.ts`,
 * `backup-offsite.ts` and `restore-drill.ts`, which re-export them.
 * `BackupService` implements `BackupsShape` and its `drill` (`RestoreDrill`)
 * implements `RestoreDrillShape`.
 *
 * This contract also includes `BackupSettings` (moved from
 * `backup-service.ts`, which re-exports it), `SealedValues` and the
 * `BackupConfig` tag, which the composition root builds from the supplied
 * startup configuration (`composition/backup.ts`).
 *
 * Not here, on purpose: `validDrillInterval` and `validLtxInterval` (the
 * Settings route's checks) stay in `backup-service.ts`; only composition
 * imports them.
 */
import { Context } from 'effect';

import type { mirrorObjects } from '@socio/data/backup';
import type { S3Settings } from '@socio/data/storage/settings';
import type { DataKeyring, SealPurpose, SealState } from '@socio/foundation/keys/secret-box';
import type { CopyAlertThresholds } from '@socio/shared/continuous-copy';
import type {
    BackupSchedule,
    BackupStatus,
    RecoveryKeyCheck,
    RestoreDrillResult,
    RestoreDrillStatus,
} from '@socio/shared/types';

// ── Constants ────────────────────────────────────────────────────────────

/** The longest backup interval an admin may set in Settings: 30 days. */
export const BACKUP_INTERVAL_MAX_HOURS = 720;
/** BACKUP_LTX_INTERVAL_SECONDS by default. */
export const DEFAULT_LTX_INTERVAL_SECONDS = 60;
/** The continuous copy goes off-site at most this often, when it does. */
export const LTX_INTERVAL_MIN_SECONDS = 10;
export const LTX_INTERVAL_MAX_SECONDS = 86_400;
/** RESTORE_DRILL_INTERVAL_DAYS by default: about monthly. */
export const DEFAULT_DRILL_INTERVAL_DAYS = 30;
/** The longest restore drill interval an admin may set in Settings. */
export const DRILL_INTERVAL_MAX_DAYS = 365;
/** PURGE_BACKUP_DAYS by default (CB-391): a permanent removal's backup lives 30 days. */
export const DEFAULT_PURGE_BACKUP_DAYS = 30;
/** The longest an admin may keep permanent removals' backups. */
export const PURGE_BACKUP_MAX_DAYS = 365;

// ── Plain types ──────────────────────────────────────────────────────────

/** One off-site copy's result (`copyOffsite`), in counts and sizes only. */
export interface OffsiteResult {
    snapshot: string;
    sent: number;
    bytes: number;
    objects: number;
    objectsSent: number;
    objectsRemoved: number;
    /** Gone from the source, kept for the older snapshots. */
    objectsKept: number;
    prunedSnapshots: number;
    /** Analytical parts (CB-369): in the mirror, sent this run, removed. */
    parts?: number;
    partsSent?: number;
    partsRemoved?: number;
    /** Plugin snapshots (CB-458): this run's, those outside a kept run, and their chunks. */
    plugins?: {
        inRun: number;
        outOfRun: number;
        outOfRunRemoved: number;
        chunks: number;
        chunksSent: number;
        chunksRemoved: number;
        /** Plugin snapshots not sent this time; the workspace's copy went on. */
        error?: string;
    };
}

/** One backup's result, in counts and sizes only. */
export interface BackupResult {
    database: string;
    userdata: string;
    /** Permanent removals' backups past their days, removed by this run (CB-391). */
    prunedPurgeBackups?: number;
    datasets: number;
    files: number;
    /** Analytical parts linked into the run (CB-369), and those listed but missing. */
    parts?: number;
    missingParts?: number;
    objects?: Awaited<ReturnType<typeof mirrorObjects>>;
    offsite?: OffsiteResult;
    offsiteError?: string;
    sizeBytes: number;
    /**
     * Plugin snapshots (CB-458): taken in this run and failed (a failure
     * never fails the run), and those pruned after it. None without plugins
     * that declare backups.
     */
    plugins?: { taken: number; failed: number; skipped: number; pruned: number };
}

/** A file row from the restored copy: where its object is. */
export interface FileSample {
    id: string;
    ownerUserId: string;
    storage: string;
}

/** Where a recovery key check reads what isn't in the database. */
export interface KeyCheckSources {
    /** A file's sealed object, as stored; undefined when it isn't there. */
    files?: (row: FileSample) => Promise<Uint8Array | undefined>;
    /** A few of the off-site copy's sealed files; none without one. */
    backups?: (count: number) => Promise<Uint8Array[]>;
}

/** The server's own data key ids, to say which one a recovery key is. */
export interface ServerKeyIds {
    current?: string;
    previous?: string;
}

/** BACKUP_* (CB-63). */
export interface BackupSettings {
    /** BACKUP_DIR: its own volume in the stack, outside /data. */
    directory: string;
    /** BACKUP_KEEP: snapshots kept, here and off-site. */
    keep: number;
    /** BACKUP_INTERVAL_HOURS: 24 by default; 0 turns scheduled backups off. */
    intervalHours: number;
    /** BACKUP_S3_*: the off-site copy; off unless BACKUP_S3_ENDPOINT is set. */
    offsite?: S3Settings & { prefix: string };
    /** LITESTREAM_REPLICA_DIR: Litestream's file replica of the database (CB-109). */
    continuous?: string;
    /**
     * BACKUP_LTX_INTERVAL_SECONDS: the continuous copy's new files go to the
     * off-site copy this often (CB-112), with both set up; 60 by default, 0
     * off.
     */
    ltxIntervalSeconds?: number;
    /**
     * RESTORE_DRILL_INTERVAL_DAYS: the continuous copy's restore drill
     * (CB-111), with LITESTREAM_REPLICA_DIR set; 30 by default, 0 only by hand.
     */
    drillIntervalDays?: number;
    /**
     * PURGE_BACKUP_DAYS: a permanent removal's backup (`purge-<time>`,
     * CB-360) is removed by the first scheduled backup after this many days
     * (CB-391); 30 by default.
     */
    purgeBackupDays?: number;
    /** LITESTREAM_BIN: the drill's `litestream`; on PATH by default. */
    litestream?: string;
}

/**
 * Where each purpose's sealed values live in the database (CB-322), as the
 * stores that seal them keep them: one `SELECT ... AS v` per entry, which a
 * recovery key check samples from the restored copy. Each feature keeps its
 * own SQL; the composition root gathers them (`composition/backup.ts`).
 */
export type SealedValues = ReadonlyArray<readonly [SealPurpose, string]>;

// ── Tags ─────────────────────────────────────────────────────────────────

/**
 * The restore drill (CB-111) as Service setup and `DataKeyAdmin` use it: run one
 * now, read how it went, and check a recovery key from escrow (CB-322).
 * `RestoreDrill` implements it; it starts and stops with the backups.
 */
export interface RestoreDrillShape {
    status(): RestoreDrillStatus;
    /** One at a time: asked again while one runs, it's that one. */
    run(): Promise<RestoreDrillResult>;
    /** Throws while a check runs; the key is wiped when the check ends. */
    verifyKey(key: Uint8Array, serverKeys: ServerKeyIds, sources?: KeyCheckSources): Promise<RecoveryKeyCheck>;
}

/**
 * Scheduled backups (CB-63), the slice `LeaderWork`, Health, Updates, Service
 * setup and the operator's view call. `BackupService` implements it. Present
 * only when the server set backups up (`LeaderWork.useBackups`).
 */
export interface BackupsShape {
    /** The restore drill, with LITESTREAM_REPLICA_DIR set. */
    readonly drill?: RestoreDrillShape;
    /** The intervals in force: an admin's from Settings over BACKUP_*. */
    schedule(): BackupSchedule;
    status(): BackupStatus;
    /** How the off-site copy's files are sealed, for the data key's status. */
    sealStates(): Record<SealState, number>;
    /** A few of the off-site copy's sealed files, for a recovery key check. */
    sampleOffsite(count: number): Promise<Buffer[]>;
    /** One backup now (the pre-update backup); one at a time. */
    run(): Promise<BackupResult | undefined>;
    start(): void;
    stop(): void;
}

export class Backups extends Context.Service<Backups, BackupsShape>()('socio/backup/Backups') {}

/**
 * What backups are given of the startup configuration: the database file,
 * BACKUP_* (`BackupSettings`), the data keys with the legacy secret, and
 * where the sealed values live. The composition root builds it from what
 * the process entry supplies (`composition/backup.ts`); moving env parsing
 * there is a later change.
 */
export interface BackupConfigShape {
    /** The database file (`DATABASE_PATH`). */
    readonly databasePath: string;
    readonly settings: BackupSettings;
    /** The off-site copy seals with the current key. */
    readonly keys: DataKeyring;
    /** What a recovery key check samples from a restored copy. */
    readonly sealed: SealedValues;
    /**
     * The continuous copy's alert thresholds from the environment or built
     * in (CB-315); an admin's from Settings (`limits`) go over them. None:
     * no alerts.
     */
    readonly copyAlerts?: CopyAlertThresholds;
    /** PLUGIN_BACKUP_MAX_GB (CB-458); an admin's from Settings goes over it. */
    readonly pluginBackupMaxGb?: number;
}

export class BackupConfig extends Context.Service<BackupConfig, BackupConfigShape>()('socio/backup/BackupConfig') {}
