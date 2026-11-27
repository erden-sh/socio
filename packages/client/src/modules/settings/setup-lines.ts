import { useTranslation } from '@socio/i18n/react';
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

/**
 * Service setup's lines for admins (CB-62, CB-63, CB-109, CB-111, CB-112,
 * CB-322, CB-458). Each `use…` hook returns the functions that build them,
 * in the page's language. `when` formats a time: the reader's local time
 * by default, UTC until hydration (and anything fixed in tests).
 */
type When = (ms: number) => string;

const localWhen: When = (ms) => new Date(ms).toLocaleString();
/** Errors end in a full stop; the line adds its own. */
const reason = (text: string) => text.replace(/\.$/, '');

/** Bytes as whole MB, or KB under one MB. */
export function megabytes(bytes: number) {
    return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * The "Continuous copy: …" line (CB-109): Litestream's copy of the
 * database, the write-ahead log's size and its alert level other than ok
 * (CB-315). Its words are `settings.backups`, which every page has: the
 * Platform page shows the line too.
 */
export function useContinuousLine() {
    const { t } = useTranslation(['settings.backups']);
    return (copy: ContinuousCopyStatus, when: When = localWhen) => {
        const line = copy.behind
            ? copy.lastCopiedAt
                ? t('settings.backups:continuous.behind', {
                      changed: when(copy.lastWriteAt ?? copy.lastCopiedAt),
                      copied: when(copy.lastCopiedAt),
                  })
                : t('settings.backups:continuous.noCopy')
            : copy.lastCopiedAt
              ? t('settings.backups:continuous.upToDate', { at: when(copy.lastCopiedAt) })
              : t('settings.backups:continuous.waiting');
        const alerts = [
            copy.walBytes !== undefined && t('settings.backups:continuous.wal', { size: megabytes(copy.walBytes) }),
            copy.level &&
                copy.level !== 'ok' &&
                t('settings.backups:continuous.level', { context: copy.level === 'critical' ? 'critical' : undefined }),
        ].filter(Boolean);
        return alerts.length ? `${line}; ${alerts.join(', ')}` : line;
    };
}

/** Whether Service setup shows the plugin line in red: a plugin without a declared backup, or one failing or out of date (CB-458). */
export const pluginBackupsAlarm = (plugins: readonly PluginBackupStatus[]) =>
    plugins.some(
        (plugin) =>
            (plugin.state === 'not_backed_up' && !plugin.declared) ||
            plugin.state === 'failing' ||
            plugin.state === 'stale',
    );

/** Service setup's other lines, in `settings.workspace-setup`. */
export function useSetupLines() {
    const { t } = useTranslation(['settings.workspace-setup']);
    const continuousLine = useContinuousLine();

    /** A wait in seconds, minutes or hours. */
    const waited = (ms: number) => {
        const seconds = Math.round(ms / 1000);
        if (seconds < 90) {
            return t('settings.workspace-setup:wait.seconds', { n: seconds });
        }
        const minutes = Math.round(seconds / 60);
        return minutes < 90
            ? t('settings.workspace-setup:wait.minutes', { n: minutes })
            : t('settings.workspace-setup:wait.hours', { n: Math.round(minutes / 60) });
    };

    /** A seal purpose as Service setup names it (CB-322). */
    const purpose = (name: SealPurposeName) => t(`settings.workspace-setup:purposes.${name}`);

    /** The "Data key: …" line (CB-62). */
    const dataKeyLine = (key: DataKeyStatus) => {
        if (!key.configured) {
            return key.unknown
                ? t('settings.workspace-setup:dataKey.unsetSealed', { count: key.unknown })
                : t('settings.workspace-setup:dataKey.unset');
        }
        if (key.unknown) {
            return t('settings.workspace-setup:dataKey.unknown', { count: key.unknown });
        }
        const left = key.legacy + key.previous;
        return left
            ? t('settings.workspace-setup:dataKey.resealing', { count: left })
            : t('settings.workspace-setup:dataKey.set');
    };

    /** The "Backups: …" line (CB-63). */
    const backupLine = (backup: BackupStatus, when: When = localWhen) => {
        const parts = [
            backup.intervalHours
                ? t('settings.workspace-setup:backup.every', { count: backup.intervalHours })
                : t('settings.workspace-setup:backup.off'),
            backup.running
                ? t('settings.workspace-setup:runningOne')
                : backup.lastSuccessAt
                  ? backup.lastSizeBytes !== undefined
                      ? t('settings.workspace-setup:backup.lastSize', {
                            at: when(backup.lastSuccessAt),
                            size: formatBytes(backup.lastSizeBytes),
                        })
                      : t('settings.workspace-setup:backup.last', { at: when(backup.lastSuccessAt) })
                  : t('settings.workspace-setup:noneYet'),
            backup.lastError &&
                (backup.lastErrorAt
                    ? t('settings.workspace-setup:failedAt', {
                          at: when(backup.lastErrorAt),
                          reason: reason(backup.lastError),
                      })
                    : t('settings.workspace-setup:failed', { reason: reason(backup.lastError) })),
            backup.offsite &&
                (backup.offsiteError
                    ? t('settings.workspace-setup:backup.offsiteFailed', { reason: reason(backup.offsiteError) })
                    : backup.offsiteSuccessAt
                      ? t('settings.workspace-setup:backup.offsiteAt', { at: when(backup.offsiteSuccessAt) })
                      : t('settings.workspace-setup:backup.offsiteNone')),
        ].filter(Boolean);
        return parts.join('; ');
    };

    /**
     * The "Plugin data: …" line (CB-458): each plugin with its own storage
     * whose backups need an admin's eye (not backed up, failing, out of
     * date, disabled), or that all are backed up.
     */
    const pluginBackupsLine = (plugins: readonly PluginBackupStatus[], when: When = localWhen) => {
        const last = (plugin: PluginBackupStatus) =>
            plugin.lastSuccessAt !== undefined
                ? t('settings.workspace-setup:plugins.lastAt', { at: when(plugin.lastSuccessAt) })
                : t('settings.workspace-setup:plugins.lastNone');
        const parts = plugins
            .map((plugin) => {
                const name = plugin.name;
                const since = plugin.since !== undefined ? when(plugin.since) : '';
                switch (plugin.state) {
                    case 'not_backed_up':
                        return plugin.declared
                            ? t('settings.workspace-setup:plugins.notYet', { name })
                            : plugin.since
                              ? t('settings.workspace-setup:plugins.undeclaredSince', { name, since })
                              : t('settings.workspace-setup:plugins.undeclared', { name });
                    case 'failing': {
                        const why = plugin.lastError ?? t('settings.workspace-setup:plugins.noReason');
                        return plugin.since
                            ? t('settings.workspace-setup:plugins.failingSince', {
                                  name,
                                  since,
                                  reason: why,
                                  last: last(plugin),
                              })
                            : t('settings.workspace-setup:plugins.failing', { name, reason: why, last: last(plugin) });
                    }
                    case 'stale':
                        return t('settings.workspace-setup:plugins.stale', { name, last: last(plugin) });
                    case 'disabled':
                        return plugin.since
                            ? t('settings.workspace-setup:plugins.disabledSince', { name, since, last: last(plugin) })
                            : t('settings.workspace-setup:plugins.disabled', { name, last: last(plugin) });
                    default:
                        return undefined;
                }
            })
            .filter((part) => part !== undefined);
        return parts.length ? parts.join('; ') : t('settings.workspace-setup:plugins.allBackedUp');
    };

    /** The "Continuous copy off-site: …" line (CB-112): its files sent off-site. */
    const continuousOffsiteLine = (copy: ContinuousOffsiteStatus, when: When = localWhen) => {
        if (!copy.intervalSeconds) {
            return t('settings.workspace-setup:offsite.off');
        }
        const failed = () => {
            const row = copy.failures > 1 ? t('settings.workspace-setup:offsite.inRow', { count: copy.failures }) : '';
            const at = copy.lastErrorAt ? when(copy.lastErrorAt) : '';
            if (copy.lastError) {
                const why = reason(copy.lastError);
                return at
                    ? t('settings.workspace-setup:offsite.failedAtReason', { at, row, reason: why })
                    : t('settings.workspace-setup:offsite.failedReason', { row, reason: why });
            }
            return at
                ? t('settings.workspace-setup:offsite.failedAt', { at, row })
                : t('settings.workspace-setup:offsite.failed', { row });
        };
        const parts = [
            t('settings.workspace-setup:offsite.every', { count: copy.intervalSeconds }),
            copy.failures && failed(),
            copy.behind && copy.lagMs && t('settings.workspace-setup:offsite.behind', { waited: waited(copy.lagMs) }),
            copy.lastSentAt
                ? t('settings.workspace-setup:offsite.sentUpTo', { at: when(copy.lastSentAt) })
                : t('settings.workspace-setup:offsite.nothingSent'),
            copy.waiting > 0 && t('settings.workspace-setup:offsite.waiting', { count: copy.waiting }),
        ].filter(Boolean);
        return parts.join('; ');
    };

    /** The "Restore drill: …" line (CB-111): the continuous copy, restored on a schedule. */
    const restoreDrillLine = (drill: RestoreDrillStatus, when: When = localWhen) => {
        const { last } = drill;
        const restores = last?.restores
            .map((restore) =>
                restore.source === 'offsite'
                    ? t('settings.workspace-setup:drill.restoreOffsite', { took: waited(restore.durationMs) })
                    : restore.pointAt
                      ? t('settings.workspace-setup:drill.restorePoint', {
                            at: when(restore.pointAt),
                            took: waited(restore.durationMs),
                        })
                      : t('settings.workspace-setup:drill.restoreLatest', { took: waited(restore.durationMs) }),
            )
            .join(', ');
        const passed = () => {
            const values = { at: when(last!.startedAt), took: waited(last!.durationMs), restores: restores ?? '' };
            return last!.differences?.length
                ? t('settings.workspace-setup:drill.passedDiffer', { ...values, count: last!.differences.length })
                : t('settings.workspace-setup:drill.passed', values);
        };
        const parts = [
            drill.intervalDays
                ? t('settings.workspace-setup:drill.every', { count: drill.intervalDays })
                : t('settings.workspace-setup:drill.manual'),
            drill.running && t('settings.workspace-setup:runningOne'),
            !last
                ? !drill.running && t('settings.workspace-setup:noneYet')
                : last.ok
                  ? passed()
                  : t('settings.workspace-setup:failedAt', {
                        at: when(last.startedAt),
                        reason: reason(last.error ?? t('settings.workspace-setup:drill.unknownError')),
                    }),
        ].filter(Boolean);
        return parts.join('; ');
    };

    /** The "Key ids: …" line (CB-322): the data keys' fingerprints, to check escrow against. */
    const keyIdsLine = (key: DataKeyStatus) => {
        if (!key.keyId) {
            return t('settings.workspace-setup:keyIds.none');
        }
        return key.previousKeyId
            ? t('settings.workspace-setup:keyIds.currentPrevious', { current: key.keyId, previous: key.previousKeyId })
            : t('settings.workspace-setup:keyIds.current', { current: key.keyId });
    };

    /** The "Legacy-sealed: …" line (CB-322): what still needs SESSION_SECRET to be read. */
    const legacySealedLine = (key: DataKeyStatus) => {
        if (!key.legacy) {
            return t('settings.workspace-setup:legacy.none');
        }
        const by = Object.entries(key.legacyByPurpose ?? {})
            .map(([name, n]) =>
                t('settings.workspace-setup:legacy.byPurpose', { purpose: purpose(name as SealPurposeName), n }),
            )
            .join(', ');
        return by
            ? t('settings.workspace-setup:legacy.itemsBy', { count: key.legacy, by })
            : t('settings.workspace-setup:legacy.items', { count: key.legacy });
    };

    /** The re-seal's state (CB-322), when an admin ran one since start. */
    const resealLine = (key: DataKeyStatus, when: When = localWhen) => {
        const reseal = key.reseal;
        if (reseal?.running) {
            return t('settings.workspace-setup:runningNow');
        }
        const last = reseal?.last;
        if (!last) {
            return undefined;
        }
        if (last.error) {
            return t('settings.workspace-setup:failedAt', { at: when(last.finishedAt), reason: reason(last.error) });
        }
        const parts = [
            t('settings.workspace-setup:reseal.finished', { at: when(last.finishedAt), count: last.resealed }),
            last.unreadable && t('settings.workspace-setup:reseal.unreadable', { count: last.unreadable }),
            last.left && t('settings.workspace-setup:reseal.left', { count: last.left }),
        ].filter(Boolean);
        return parts.join(', ');
    };

    /** The "Recovery key check: …" line (CB-322). */
    const keyCheckLine = (check: { running: boolean; last?: RecoveryKeyCheck }, when: When = localWhen) => {
        if (check.running) {
            return t('settings.workspace-setup:runningNow');
        }
        const last = check.last;
        if (!last) {
            return t('settings.workspace-setup:noneYet');
        }
        const which = t('settings.workspace-setup:keyCheck.which', {
            context: last.matches === 'current' ? undefined : last.matches,
        });
        const values = { keyId: last.keyId, which, at: when(last.startedAt) };
        if (last.error) {
            return t('settings.workspace-setup:keyCheck.error', { ...values, reason: reason(last.error) });
        }
        const purposes = last.purposes
            .map((p) =>
                p.ok === null
                    ? t('settings.workspace-setup:keyCheck.nothingToTry', { purpose: purpose(p.purpose) })
                    : t('settings.workspace-setup:keyCheck.opened', {
                          purpose: purpose(p.purpose),
                          opened: p.opened,
                          sampled: p.sampled,
                      }),
            )
            .join(', ');
        return t('settings.workspace-setup:keyCheck.result', {
            ...values,
            purposes,
            context: last.ok ? undefined : 'failed',
        });
    };

    return {
        dataKeyLine,
        backupLine,
        pluginBackupsLine,
        continuousLine,
        continuousOffsiteLine,
        restoreDrillLine,
        keyIdsLine,
        legacySealedLine,
        resealLine,
        keyCheckLine,
    };
}
