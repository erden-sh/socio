/**
 * Backups' construction: `BackupConfig`, built from what the process entry
 * supplies (the database file, BACKUP_* as `index.ts` read them, the data keys
 * and `PlatformConfig.sessionSecret`), never from `process.env`; and where each
 * feature keeps its sealed values, which the restore drill's recovery key check
 * samples (CB-322). Each feature keeps its own SQL in its infra; only the
 * composition root gathers them, so `backup/` imports none of them.
 *
 * The service itself is made in the boot step (`lifecycle/backup.ts`),
 * after the graph, as before: BACKUP_* and the database file aren't in the
 * graph's root, and `LeaderWork.useBackups` sets it late (`ports.ts`). The
 * same `makeBackupService` makes it there that `BackupsLive` makes it from
 * the tags (`backup/layer.ts`).
 */
import type { DataKeys } from '@socio/foundation/keys/data-keys';

import type { BackupConfigShape, BackupSettings, SealedValues } from '../backup/contract.js';
import { GITHUB_SEALED_SQL } from '../github/infra/sealed.js';
import { INFERENCE_SEALED_SQL } from '../inference/infra/sqlite/sealed.js';
import { MCP_SEALED_SQL } from '../mcp/infra/sqlite/sealed.js';
import { NOTIFICATIONS_SEALED_SQL } from '../notifications/infra/sqlite/sealed.js';
import { limitDefaults, type LimitSources } from '../settings/limits.js';
import { WORKSPACE_SECRETS_SEALED_SQL } from '../workspace-secrets/infra/sqlite/sealed.js';

import type { PlatformConfig } from './config.js';

/**
 * Where each purpose's sealed values live in the database (CB-322), as the
 * stores that seal them keep them: what a recovery key check samples from
 * the restored copy. A table missing from it (a module never used) is
 * skipped. Files are `data_files` rows, their objects in file storage;
 * backups are the off-site copy's files.
 */
export const backupSealedValues: SealedValues = [
    ...INFERENCE_SEALED_SQL.map((sql) => ['inference-credentials', sql] as const),
    ...NOTIFICATIONS_SEALED_SQL.map((sql) => ['push-keys', sql] as const),
    ...GITHUB_SEALED_SQL.map((sql) => ['dispatch-credentials', sql] as const),
    ['settings-secrets', 'SELECT value AS v FROM secret_settings'],
    ...MCP_SEALED_SQL.map((sql) => ['mcp-credentials', sql] as const),
    ...WORKSPACE_SECRETS_SEALED_SQL.map((sql) => ['workspace-secrets', sql] as const),
];

/**
 * `BackupConfig` from the supplied startup configuration: the off-site
 * copy seals under the data keys, with the legacy key from SESSION_SECRET
 * (or a placeholder: backups never seal under it).
 */
export function backupConfig({
    database,
    backupSettings,
    dataKeys,
    config,
}: {
    database: string;
    backupSettings: BackupSettings;
    dataKeys: DataKeys;
    config: Pick<PlatformConfig, 'sessionSecret'> & LimitSources;
}): BackupConfigShape {
    const limits = limitDefaults(config);
    return {
        databasePath: database,
        settings: backupSettings,
        keys: { ...dataKeys, legacy: config.sessionSecret ?? 'unused-for-backups' },
        sealed: backupSealedValues,
        // The continuous copy's alerts (CB-315): LITESTREAM_* or built in.
        copyAlerts: {
            copyLagWarnMinutes: limits.copyLagWarnMinutes,
            copyLagCriticalMinutes: limits.copyLagCriticalMinutes,
            walWarnMb: limits.walWarnMb,
            walCriticalMb: limits.walCriticalMb,
        },
        // The per-plugin snapshot cap (CB-458): PLUGIN_BACKUP_MAX_GB or built in.
        pluginBackupMaxGb: limits.pluginBackupMaxGb,
    };
}
