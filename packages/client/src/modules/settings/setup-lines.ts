import type { PluginBackupStatus } from '@socio/shared/plugins/plugin-backup';
import type {
    BackupStatus,
    ContinuousCopyStatus,
    ContinuousOffsiteStatus,
    DataKeyStatus,
    RecoveryKeyCheck,
    RestoreDrillStatus,
    SealPurposeName,
} from '@socio/shared/types';

import { formatBytes } from '../dataspace/format';

const localWhen = (ms: number) => new Date(ms).toLocaleString();
/** Errors end in a full stop; the line adds its own. */
const reason = (text: string) => text.replace(/\.$/, '');

/** The Settings dialog's "Data key: …" line for admins (CB-62). */
export function dataKeyLine(key: DataKeyStatus) {
    if (!key.configured) {
        return key.unknown
            ? `not set, but ${key.unknown} item(s) are sealed under a data key; set it again as DATA_ENCRYPTION_KEY`
            : 'not set; files and stored credentials use a key from SESSION_SECRET. Set DATA_ENCRYPTION_KEY';
    }
    if (key.unknown) {
        return `${key.unknown} item(s) are sealed under a key this server doesn’t have; set it as DATA_ENCRYPTION_KEY_PREVIOUS`;
    }
    const left = key.legacy + key.previous;
    return left ? `set; re-sealing ${left} item(s) sealed under an older key` : 'set';
}

/** The Settings dialog's "Backups: …" line for admins (CB-63). */
export function backupLine(backup: BackupStatus, when = localWhen) {
    const parts = [
        backup.intervalHours ? `every ${backup.intervalHours} hour(s)` : 'scheduled backups off',
        backup.running
            ? 'one is running now'
            : backup.lastSuccessAt
              ? `last at ${when(backup.lastSuccessAt)}${backup.lastSizeBytes !== undefined ? ` (${formatBytes(backup.lastSizeBytes)})` : ''}`
              : 'none yet',
        backup.lastError &&
            `the last one failed${backup.lastErrorAt ? ` at ${when(backup.lastErrorAt)}` : ''}: ${reason(backup.lastError)}`,
        backup.offsite &&
            (backup.offsiteError
                ? `the off-site copy failed: ${reason(backup.offsiteError)}`
                : backup.offsiteSuccessAt
                  ? `copied off-site at ${when(backup.offsiteSuccessAt)}`
                  : 'not copied off-site yet'),
    ].filter(Boolean);
    return parts.join('; ');
}

/**
 * The "Plugin data: …" line (CB-458): each plugin with its own storage
 * whose backups need an admin's eye (not backed up, failing, out of date,
 * disabled), or that all are backed up.
 */
export function pluginBackupsLine(plugins: readonly PluginBackupStatus[], when = localWhen) {
    const last = (plugin: PluginBackupStatus) =>
        plugin.lastSuccessAt !== undefined ? `last backed up ${when(plugin.lastSuccessAt)}` : 'no good backup yet';
    const parts = plugins
        .map((plugin) => {
            switch (plugin.state) {
                case 'not_backed_up':
                    return plugin.declared
                        ? `${plugin.name} is not backed up yet: its first backup comes with the next scheduled backup`
                        : `${plugin.name} is not backed up: the installed version declares no backup${plugin.since ? ` (flagged ${when(plugin.since)})` : ''}`;
                case 'failing':
                    return `${plugin.name}’s backup is failing${plugin.since ? ` since ${when(plugin.since)}` : ''}: ${plugin.lastError ?? 'no reason given'} (${last(plugin)})`;
                case 'stale':
                    return `${plugin.name}’s backup is out of date (${last(plugin)})`;
                case 'disabled':
                    return `${plugin.name} is disabled${plugin.since ? ` since ${when(plugin.since)}` : ''}, so it isn’t backed up (${last(plugin)})`;
                default:
                    return undefined;
            }
        })
        .filter((part): part is string => part !== undefined);
    return parts.length ? parts.join('; ') : 'every plugin with its own storage is backed up';
}

/** Whether Service setup shows the plugin line in red: a plugin without a declared backup, or one failing or out of date (CB-458). */
export const pluginBackupsAlarm = (plugins: readonly PluginBackupStatus[]) =>
    plugins.some(
        (plugin) =>
            (plugin.state === 'not_backed_up' && !plugin.declared) ||
            plugin.state === 'failing' ||
            plugin.state === 'stale',
    );

/** The "Continuous copy: …" line (CB-109): Litestream's copy of the database, and its alert level (CB-315). */
export function continuousLine(copy: ContinuousCopyStatus, when = localWhen) {
    const line = copy.behind
        ? copy.lastCopiedAt
            ? `behind: the database changed at ${when(copy.lastWriteAt ?? copy.lastCopiedAt)}, the newest copy is from ${when(copy.lastCopiedAt)}; check the litestream service`
            : 'no copy yet; check the litestream service'
        : copy.lastCopiedAt
          ? `up to date; newest copy at ${when(copy.lastCopiedAt)}`
          : 'waiting for the first copy';
    return `${line}${copyAlertSuffix(copy)}`;
}

/** "; write-ahead log 12 MB (warning)": the log's size and a level other than ok (CB-315). */
export function copyAlertSuffix(copy: ContinuousCopyStatus) {
    const parts = [
        copy.walBytes !== undefined && `write-ahead log ${megabytes(copy.walBytes)}`,
        copy.level && copy.level !== 'ok' && copy.level,
    ].filter(Boolean);
    return parts.length ? `; ${parts.join(', ')}` : '';
}

/** Bytes as whole MB, or KB under one MB. */
export function megabytes(bytes: number) {
    return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** A wait in seconds, minutes or hours. */
function waited(ms: number) {
    const seconds = Math.round(ms / 1000);
    if (seconds < 90) {
        return `${seconds} s`;
    }
    const minutes = Math.round(seconds / 60);
    return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/** The "Continuous copy off-site: …" line (CB-112): its files sent off-site. */
export function continuousOffsiteLine(copy: ContinuousOffsiteStatus, when = localWhen) {
    if (!copy.intervalSeconds) {
        return 'off; set how often in Backup schedule';
    }
    const parts = [
        `every ${copy.intervalSeconds} seconds`,
        copy.failures &&
            `the last send failed${copy.lastErrorAt ? ` at ${when(copy.lastErrorAt)}` : ''}${copy.failures > 1 ? ` (${copy.failures} in a row)` : ''}${copy.lastError ? `: ${reason(copy.lastError)}` : ''}; it tries again later`,
        copy.behind && copy.lagMs && `behind: the newest copy has waited ${waited(copy.lagMs)}`,
        copy.lastSentAt ? `everything up to ${when(copy.lastSentAt)} is off-site` : 'nothing sent yet',
        copy.waiting > 0 && `${copy.waiting} file(s) waiting; nothing off-site is removed until they go`,
    ].filter(Boolean);
    return parts.join('; ');
}

/** The "Restore drill: …" line (CB-111): the continuous copy, restored on a schedule. */
export function restoreDrillLine(drill: RestoreDrillStatus, when = localWhen) {
    const { last } = drill;
    const restores = last?.restores
        .map(
            (restore) =>
                `${restore.source === 'offsite' ? 'off-site' : restore.pointAt ? `as of ${when(restore.pointAt)}` : 'latest'} ${waited(restore.durationMs)}`,
        )
        .join(', ');
    const parts = [
        drill.intervalDays ? `every ${drill.intervalDays} day(s)` : 'only when an admin runs it',
        drill.running && 'one is running now',
        !last
            ? !drill.running && 'none yet'
            : last.ok
              ? `the last one passed at ${when(last.startedAt)} in ${waited(last.durationMs)} (${restores}); ${last.differences?.length ? `${last.differences.length} table(s) differ from live by writes since the copy` : 'rows match live'}`
              : `the last one failed at ${when(last.startedAt)}: ${reason(last.error ?? 'unknown error')}`,
    ].filter(Boolean);
    return parts.join('; ');
}

/** A seal purpose as Service setup names it (CB-322). */
export const PURPOSE_LABELS: Record<SealPurposeName, string> = {
    'inference-credentials': 'inference credentials',
    'data-files': 'files',
    backups: 'backups',
    'push-keys': 'push keys',
    'dispatch-credentials': 'GitHub App key',
    'settings-secrets': 'settings secrets',
    'mcp-credentials': 'MCP credentials',
    'workspace-secrets': 'workspace secrets',
    'gateway-log': 'gateway exchange log',
};

/** The "Key ids: …" line (CB-322): the data keys' fingerprints, to check escrow against. */
export function keyIdsLine(key: DataKeyStatus) {
    if (!key.keyId) {
        return 'none; no data key is set';
    }
    return `current ${key.keyId}${key.previousKeyId ? `, previous ${key.previousKeyId}` : ''}`;
}

/** The "Legacy-sealed: …" line (CB-322): what still needs SESSION_SECRET to be read. */
export function legacySealedLine(key: DataKeyStatus) {
    if (!key.legacy) {
        return 'none; SESSION_SECRET is no longer needed to read stored data';
    }
    const by = Object.entries(key.legacyByPurpose ?? {})
        .map(([purpose, n]) => `${PURPOSE_LABELS[purpose as SealPurposeName]} ${n}`)
        .join(', ');
    return `${key.legacy} item(s)${by ? ` (${by})` : ''} still need SESSION_SECRET; keep it in the recovery kit until this is zero`;
}

/** The re-seal's state (CB-322), when an admin ran one since start. */
export function resealLine(key: DataKeyStatus, when = localWhen) {
    const reseal = key.reseal;
    if (reseal?.running) {
        return 'running now';
    }
    const last = reseal?.last;
    if (!last) {
        return undefined;
    }
    if (last.error) {
        return `the last one failed at ${when(last.finishedAt)}: ${reason(last.error)}`;
    }
    const parts = [
        `the last one finished at ${when(last.finishedAt)}: ${last.resealed} re-sealed`,
        last.unreadable && `${last.unreadable} under a key this server doesn’t have`,
        last.left && `${last.left} left for the next run`,
    ].filter(Boolean);
    return parts.join(', ');
}

/** The "Recovery key check: …" line (CB-322). */
export function keyCheckLine(check: { running: boolean; last?: RecoveryKeyCheck }, when = localWhen) {
    if (check.running) {
        return 'running now';
    }
    const last = check.last;
    if (!last) {
        return 'none yet';
    }
    const which = last.matches === 'neither' ? 'not a key this server uses' : `the server’s ${last.matches} key`;
    if (last.error) {
        return `key ${last.keyId} (${which}) couldn’t be checked at ${when(last.startedAt)}: ${reason(last.error)}`;
    }
    const purposes = last.purposes
        .map(
            (p) =>
                `${PURPOSE_LABELS[p.purpose]} ${p.ok === null ? 'nothing to try' : `${p.opened} of ${p.sampled} opened`}`,
        )
        .join(', ');
    return `key ${last.keyId} (${which}) ${last.ok ? 'passed' : 'failed'} at ${when(last.startedAt)}: ${purposes}`;
}
