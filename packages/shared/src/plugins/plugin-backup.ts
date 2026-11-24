/**
 * Plugin backups (CB-458): what a
 * manifest's volumes say about its state, the catalog's warnings about it,
 * and each installed plugin's backup status. `pluginBackupStatuses` reads
 * the manifests only, so every plugin with state is `not_backed_up` there;
 * the backups' service (step 5) adds what its snapshots say.
 *
 * Pure: the catalog, the Plugins page, the backups' status and Service setup
 * all read these.
 */
import { compareText } from '../locale.js';

import { statefulVolumes, type PluginServiceSpec } from './plugin-service.js';

/**
 * What the catalog warns about a plugin's storage:
 * - `not_backed_up`: a volume that isn't `ephemeral`, and no `service.backup`.
 *   The next minor release refuses the entry.
 * - `private_storage`: any volume that isn't `ephemeral`, with or without
 *   `service.backup`, for as long as the entry declares one.
 */
export type PluginStorageWarningKind = 'not_backed_up' | 'private_storage';

export interface PluginStorageWarning {
    kind: PluginStorageWarningKind;
    message: string;
}

export const PLUGIN_NOT_BACKED_UP_WARNING = 'Not backed up: this release is the last that installs it';
export const PLUGIN_PRIVATE_STORAGE_WARNING =
    'Keeps data in private storage; plugins should use workspace datasets and files';

/** Whether this service keeps state the workspace can't back up: a volume that isn't ephemeral, and no `backup`. */
export function pluginBackupMissing(spec: Pick<PluginServiceSpec, 'volumes' | 'backup'> | undefined) {
    return statefulVolumes(spec).length > 0 && spec?.backup === undefined;
}

/** The catalog's warnings about a plugin's storage, in the order the catalog shows them. */
export function pluginStorageWarnings(
    spec: Pick<PluginServiceSpec, 'volumes' | 'backup'> | undefined,
): PluginStorageWarning[] {
    if (statefulVolumes(spec).length === 0) {
        return [];
    }
    return [
        ...(spec?.backup === undefined
            ? [{ kind: 'not_backed_up' as const, message: PLUGIN_NOT_BACKED_UP_WARNING }]
            : []),
        { kind: 'private_storage' as const, message: PLUGIN_PRIVATE_STORAGE_WARNING },
    ];
}

/**
 * A plugin's backup state:
 * - `not_backed_up`: its manifest declares no `service.backup`, or it
 *   declares one and the workspace hasn't tried a snapshot yet;
 * - `ok`: its last snapshot succeeded, within twice the backup interval;
 * - `stale`: its last good snapshot is older than that;
 * - `failing`: its last snapshot failed;
 * - `disabled`: it is disabled, so it isn't started for a backup. Its
 *   snapshots stay.
 */
export type PluginBackupState = 'ok' | 'failing' | 'stale' | 'not_backed_up' | 'disabled';

/**
 * PLUGIN_BACKUP_MAX_GB by default: the most one plugin's
 * snapshot may hold, in GiB (`PLUGIN_SNAPSHOT_MAX_BYTES`). An admin raises
 * it in Settings → General → Plugin backups.
 */
export const DEFAULT_PLUGIN_BACKUP_MAX_GB = 20;
export const GIB = 1024 ** 3;

/** Why a snapshot was taken. Only `scheduled` ones are in a run. */
export type PluginSnapshotReason = 'scheduled' | 'manual' | 'request' | 'pre-update' | 'uninstall';

/** One installed plugin with state, as Service setup and the plugin's page show it. */
export interface PluginBackupStatus {
    id: string;
    name: string;
    state: PluginBackupState;
    /** Whether its manifest declares `service.backup`. Without it, admins get notices until the catalog entry does. */
    declared: boolean;
    /** Its volumes that hold state (every one not `ephemeral`), by manifest name. */
    volumes: string[];
    /**
     * Since when: flagged `not_backed_up` without `backup` (once the backups'
     * check has seen it), failing (the first failure in a row) or disabled.
     */
    since?: number;
    /** Its last good snapshot (CB-458 step 5): when, and its size in bytes. */
    lastSuccessAt?: number;
    sizeBytes?: number;
    /** Its last snapshot that failed, and why, in words that name no path; cleared by a success. */
    lastErrorAt?: number;
    lastError?: string;
    /** Its last snapshot's check (the level 1 drill: every chunk re-read and each database's integrity). */
    lastCheck?: { at: number; ok: boolean; error?: string };
    /** A snapshot of it is being taken now. */
    running?: boolean;
}

/** One stored snapshot of a plugin, as its page lists it (newest first). */
export interface PluginBackupHistoryEntry {
    snapshotId: string;
    takenAt: number;
    reason: PluginSnapshotReason;
    /** The plugin's own reason, for a snapshot it asked for (`socio.backup.request`). */
    note?: string;
    /** The run's stamp, for a scheduled one. */
    run?: string;
    /** The plugin version it was taken under, as the workspace recorded it. */
    version: string;
    bytes: number;
}

/** What `pluginBackupStatuses` reads of an install. */
export interface PluginBackupInstall {
    id: string;
    mode: 'service' | 'bundled';
    manifest: { name: string; service?: Pick<PluginServiceSpec, 'volumes' | 'backup'> };
}

/**
 * Every installed service plugin that keeps state on a volume (one not
 * `ephemeral`), with its backup state. A bundled plugin keeps its data in
 * Socio's database, and a plugin without such a volume needs no backup of
 * its own, so neither is listed. Disabled plugins are listed: their
 * volumes stay.
 */
export function pluginBackupStatuses(installs: readonly PluginBackupInstall[]): PluginBackupStatus[] {
    const out: PluginBackupStatus[] = [];
    for (const row of installs) {
        if (row.mode !== 'service') {
            continue;
        }
        const volumes = statefulVolumes(row.manifest.service).map((volume) => volume.name);
        if (volumes.length === 0) {
            continue;
        }
        out.push({
            id: row.id,
            name: row.manifest.name,
            state: 'not_backed_up',
            declared: row.manifest.service?.backup !== undefined,
            volumes,
        });
    }
    return out.sort((a, b) => compareText(a.id, b.id));
}
