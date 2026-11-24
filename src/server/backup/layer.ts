/**
 * The backups' layer: it implements `contract.ts`'s `Backups` with one
 * `BackupService`, made from the tags it reads: the data space (`Data`,
 * its directory and object store), storage's `ObjectStores` (the off-site
 * target) and `StorageConfig` (the tenant), the workspace's settings (an
 * admin's schedule, CB-112), `BackupConfig`, and `BackupHost` (the admins'
 * notice and the log). Only the composition root and tests import this
 * file.
 *
 * Nothing is started here: the service starts and stops with the leader
 * (`LeaderWork.lead`, `release` and `stop`), as before.
 */
import { Context, Effect, Layer } from 'effect';

import type { CopyAlertThresholds } from '@socio/shared/continuous-copy';
import { DEFAULT_PLUGIN_BACKUP_MAX_GB, GIB, type PluginBackupStatus } from '@socio/shared/plugins/plugin-backup';
import type { BackupSchedule, RestoreDrillResult, Settings } from '@socio/shared/types';

import { Data, type DataSpaceShape } from '../dataspace/contract.js';
import { WorkspaceSettings } from '../settings/contract.js';
import { ObjectStores, StorageConfig, type ObjectStoresShape, type StorageConfigShape } from '../storage/contract.js';

import { BackupService } from './backup-service.js';
import { BackupConfig, Backups, type BackupConfigShape } from './contract.js';
import type { PluginSnapshotHost } from './plugin-snapshots.js';

/** A notice to every active admin, from the app itself (`AdminNotices.notifyAdmins`). */
export interface AdminNotice {
    trigger: string;
    title: string;
    message: string;
    path: string;
}

/**
 * What backups use of the platform that no contract offers yet: the
 * admins' notice (`AdminNotices.notifyAdmins`) and the log for operational
 * lines. Private to the composition root.
 */
export interface BackupHostShape {
    notifyAdmins(notice: AdminNotice): Promise<void>;
    log(line: string): void;
    /**
     * Installed plugins that keep state on their own volumes (CB-458), from
     * the plugins the composition root holds; none when left out.
     */
    pluginBackups?(): PluginBackupStatus[];
    /**
     * `notifyAdmins`, with how many admins it reached and how many it
     * couldn't (`AdminNotices.deliverToAdmins`). A plugin notice that reached
     * none of the admins it tried is sent again with the next check.
     */
    deliverToAdmins?(notice: AdminNotice): Promise<{ sent: number; failed: number }>;
    /**
     * The plugins that declare backups, their tasks and host calls on
     * `/__cb/` (CB-458 step 5), from the plugins the composition root
     * holds; without it no plugin snapshot is taken.
     */
    pluginSnapshots?: PluginSnapshotHost;
}

export class BackupHost extends Context.Service<BackupHost, BackupHostShape>()('socio/backup/BackupHost') {}

/** What the service is made from: each value as its tag offers it. */
export interface BackupParts {
    config: BackupConfigShape;
    /** The data space: its directory, and its object store when that is S3. */
    data: Pick<DataSpaceShape, 'dir' | 'objects'>;
    stores: Pick<ObjectStoresShape, 's3'>;
    storage: StorageConfigShape;
    /** An admin's schedule and limits from Settings, read on every check. */
    schedule: () => { backupSchedule?: BackupSchedule; limits?: Settings['limits'] };
    host: BackupHostShape;
}

/**
 * Scheduled backups (CB-63): the database, the data spaces, the object
 * mirror and the off-site copy, every BACKUP_INTERVAL_HOURS; and the
 * continuous copy's files off-site, every BACKUP_LTX_INTERVAL_SECONDS.
 * The same options the boot step has always passed.
 */
export function makeBackupService({ config, data, stores, storage, schedule, host }: BackupParts): BackupService {
    const { settings: objects } = storage;
    return new BackupService({
        databasePath: config.databasePath,
        userDataDir: data.dir,
        settings: config.settings,
        objects:
            objects?.s3 && data.objects.driver === 's3'
                ? { store: data.objects, tenantId: objects.tenantId }
                : undefined,
        stores,
        keys: config.keys,
        sealed: config.sealed,
        // Settings → General → Backup schedule, over the intervals (CB-112).
        schedule: () => schedule().backupSchedule,
        // The restore drill (CB-111): admins hear of a failure wherever they are.
        onDrillFailure: (result: RestoreDrillResult) =>
            host.notifyAdmins({
                trigger: 'restore_drill',
                title: 'Restore drill failed',
                message: `${result.error ?? 'A restore from the continuous copy failed.'} See Service setup.`,
                path: '/settings/workspace',
            }),
        // The continuous copy's alerts (CB-315): an admin's thresholds from
        // Settings over the environment's; admins hear of each change.
        ...(config.copyAlerts
            ? {
                  copyAlerts: () => copyAlertsInForce(config.copyAlerts!, schedule().limits),
                  onCopyAlert: ({ title, message, path }: { title: string; message: string; path: string }) =>
                      host.notifyAdmins({ trigger: 'continuous_copy', title, message, path }),
              }
            : {}),
        // Plugins that keep state on their own volumes (CB-458): admins hear
        // of one without a backup when it is flagged, then weekly.
        ...(host.pluginBackups
            ? {
                  plugins: () => host.pluginBackups!(),
                  // Snapshots of the plugins that declare backups, each capped
                  // at an admin's size over PLUGIN_BACKUP_MAX_GB.
                  ...(host.pluginSnapshots
                      ? {
                            pluginSnapshots: {
                                host: host.pluginSnapshots,
                                maxBytes: () => pluginBackupMaxBytes(config, schedule().limits),
                            },
                        }
                      : {}),
                  onPluginGap: async ({ title, message, path }: { title: string; message: string; path: string }) => {
                      const notice = { trigger: 'plugin_backup', title, message, path };
                      if (!host.deliverToAdmins) {
                          return host.notifyAdmins(notice);
                      }
                      const { sent, failed } = await host.deliverToAdmins(notice);
                      if (failed > 0 && sent === 0) {
                          throw new Error('The notice reached no admin.');
                      }
                  },
              }
            : {}),
        log: (line) => host.log(line),
    });
}

/** The per-plugin snapshot cap in force, in bytes: an admin's over PLUGIN_BACKUP_MAX_GB, 20 GiB by default. */
export function pluginBackupMaxBytes(config: Pick<BackupConfigShape, 'pluginBackupMaxGb'>, saved: Settings['limits']) {
    return (saved?.pluginBackupMaxGb ?? config.pluginBackupMaxGb ?? DEFAULT_PLUGIN_BACKUP_MAX_GB) * GIB;
}

/** The thresholds in force: an admin's saved ones over the server's. */
export function copyAlertsInForce(defaults: CopyAlertThresholds, saved: Settings['limits']): CopyAlertThresholds {
    return {
        copyLagWarnMinutes: saved?.copyLagWarnMinutes ?? defaults.copyLagWarnMinutes,
        copyLagCriticalMinutes: saved?.copyLagCriticalMinutes ?? defaults.copyLagCriticalMinutes,
        walWarnMb: saved?.walWarnMb ?? defaults.walWarnMb,
        walCriticalMb: saved?.walCriticalMb ?? defaults.walCriticalMb,
    };
}

/** The service, from the tags it reads. */
export const backupService = Effect.gen(function* () {
    const config = yield* BackupConfig;
    const data = yield* Data;
    const stores = yield* ObjectStores;
    const storage = yield* StorageConfig;
    const settings = yield* WorkspaceSettings;
    const host = yield* BackupHost;
    return makeBackupService({
        config,
        data,
        stores,
        storage,
        schedule: () => settings.settings(),
        host,
    });
});

/** `Backups`, over a service made once. */
export const BackupsLive = Layer.effect(Backups, backupService);
