/**
 * Scheduled backups' boot step, where the process entry ran it. It stays a boot
 * step, not `BackupsLive` in the graph, so its log lines keep their place in
 * phase 3; it fills `ports.backups` through `LeaderWork.useBackups`.
 */
import { Context } from 'effect';

import type { DataKeys } from '@socio/foundation/keys/data-keys';
import { pluginBackupStatuses } from '@socio/shared/plugins/plugin-backup';
import { statefulVolumes } from '@socio/shared/plugins/plugin-service';

import type { BackupSettings } from '../../backup/contract.js';
import { makeBackupService } from '../../backup/layer.js';
import type { PluginBackupTarget, PluginSnapshotHost } from '../../backup/plugin-snapshots.js';
import type { AppEdge } from '../../main.js';
import type { PluginService } from '../../plugins/service.js';
import { objectStores } from '../../storage/services.js';
import { AdminNotices } from '../app/notices.js';
import { LeaderWork } from '../app/work.js';
import { backupConfig } from '../backup.js';
import type { PlatformConfig } from '../config.js';
import type { CoreStore } from '../core-store.js';
import { LegacyData } from '../dataspace.js';
import { startBundleChannel } from '../http/bundle.js';
import { LegacyPlugins } from '../plugins.js';

/**
 * Scheduled backups (CB-63): the database, the data spaces, the object
 * mirror and the off-site copy, every BACKUP_INTERVAL_HOURS; and the
 * continuous copy's files off-site, every BACKUP_LTX_INTERVAL_SECONDS.
 */
export function startBackups({
    database,
    backupSettings,
    dataKeys,
    config,
    store,
    edge,
}: {
    database: string;
    backupSettings: BackupSettings;
    dataKeys: DataKeys;
    config: PlatformConfig;
    store: CoreStore;
    edge: AppEdge;
}) {
    const { services } = edge;
    const notices = Context.get(services, AdminNotices);
    const plugins = Context.get(services, LegacyPlugins);
    // The service `BackupsLive` makes from the tags, from the same values:
    // the supplied config (`BackupConfig`), the data space, storage's
    // stores and settings, the settings store, and the admins' notice.
    const backups = makeBackupService({
        config: backupConfig({ database, backupSettings, dataKeys, config }),
        data: Context.get(services, LegacyData),
        stores: objectStores,
        storage: { settings: config.storage },
        schedule: () => store.slices.settings.settings(),
        host: {
            notifyAdmins: (notice) => notices.notifyAdmins(notice),
            // A plugin backup notice that reached no admin goes again (CB-458).
            ...(notices.deliverToAdmins ? { deliverToAdmins: (notice) => notices.deliverToAdmins!(notice) } : {}),
            log: (line) => console.log(line),
            // Installed plugins that keep state on their own volumes (CB-458).
            pluginBackups: () => pluginBackupStatuses(plugins.list()),
            // Their snapshots over the ingress, as the host (CB-458 step 5).
            pluginSnapshots: pluginSnapshotHost(plugins),
        },
    });
    Context.get(services, LeaderWork).useBackups(backups);
    // A plugin's page: its backups' status, its snapshots, Back up now and its own requests.
    plugins.useBackups({
        status: (id) => backups.pluginBackupStatus(id),
        history: (id) => backups.pluginHistory(id),
        backUpNow: (id) => {
            const started = backups.backUpPlugin(id, 'manual');
            return started.ok ? { ok: true, coalesced: started.coalesced } : started;
        },
        request: (id, reason) => backups.requestPluginBackup(id, reason),
    });
    // The workspace bundle import's live CLI channel (CB-380): it needs a recent backup, as the web's does.
    startBundleChannel(edge);
    const schedule = backups.schedule();
    const continuousOffsite =
        backupSettings.offsite && backupSettings.continuous && schedule.ltxIntervalSeconds
            ? `; the continuous copy goes off-site every ${schedule.ltxIntervalSeconds} s`
            : '';
    if (backups.drill) {
        console.log(
            schedule.drillIntervalDays
                ? `Restore drill: every ${schedule.drillIntervalDays} day(s).`
                : 'Restore drill: only when an admin runs it (RESTORE_DRILL_INTERVAL_DAYS=0).',
        );
    }
    console.log(
        schedule.intervalHours
            ? `Backups: every ${schedule.intervalHours} hour(s), keeping ${backupSettings.keep}${backupSettings.offsite ? ', with an off-site copy' : ''}${continuousOffsite}.`
            : `Backups: scheduled backups are off; run pnpm run backup${continuousOffsite}.`,
    );
}

/**
 * What plugin snapshots need of the plugins (CB-458 step 5): the installed
 * service plugins that declare `service.backup` and keep state, their
 * running tasks, and one host call on `/__cb/` through the runtime's
 * ingress, with the host envelope and the task pin (`hostTarget`).
 */
export function pluginSnapshotHost(
    plugins: Pick<PluginService, 'list' | 'hostTarget' | 'hostTasks'>,
    fetchImpl: typeof fetch = fetch,
): PluginSnapshotHost {
    return {
        targets: () =>
            plugins.list().flatMap((row): PluginBackupTarget[] => {
                const service = row.manifest.service;
                const volumes = statefulVolumes(service).map((volume) => volume.name);
                if (row.mode !== 'service' || !service?.backup || !volumes.length) {
                    return [];
                }
                return [
                    {
                        id: row.id,
                        name: row.manifest.name,
                        running: row.enabled && row.replicas > 0,
                        version: row.version,
                        revision: row.revision,
                        schema: service.backup.schema,
                        volumes,
                        settings: { ...row.config },
                    },
                ];
            }),
        tasks: (id) => plugins.hostTasks(id),
        call: async (id, request) => {
            const where = await plugins.hostTarget(id, {
                method: request.method,
                target: request.target,
                task: request.task,
            });
            if (where.state !== 'running') {
                return new Response(null, { status: 503 });
            }
            return fetchImpl(`http://${where.host}:${where.port}${request.target}`, {
                method: request.method,
                headers: {
                    ...where.headers,
                    ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
                },
                ...(request.body !== undefined ? { body: request.body } : {}),
                ...(request.signal ? { signal: request.signal } : {}),
                redirect: 'manual',
            });
        },
    };
}

/** Backups' step, as lifecycle/index.ts runs it. */
export const backupLifecycle = { start: startBackups };
