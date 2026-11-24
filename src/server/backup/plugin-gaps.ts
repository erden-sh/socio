/**
 * Plugins the workspace can't back up (CB-458): an installed plugin that
 * keeps state on its own volumes while its catalog entry declares no
 * `service.backup` keeps running, flagged "Not backed up". Admins hear once
 * when it is flagged and weekly after that, until its entry declares
 * `backup` (or it no longer keeps state, or is uninstalled).
 *
 * When each plugin was flagged and last noticed is kept in
 * `BACKUP_DIR/plugin-backups.json`, beside `backup-status.json`, so a
 * restart doesn't notify again, and a restored database doesn't forget it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writePrivate } from '@socio/data/backup';
import type { PluginBackupStatus } from '@socio/shared/plugins/plugin-backup';

/** A reminder while a plugin stays flagged: weekly. */
export const PLUGIN_GAP_REMINDER_MS = 7 * 24 * 3_600_000;

/**
 * One flagged plugin: since when, and when admins last heard of it. A
 * notice is recorded only once it was delivered, so one that failed (or was
 * cut off by a restart) is sent again with the next check.
 */
export interface PluginGapRecord {
    flaggedAt: number;
    notifiedAt?: number;
}

export type PluginGapFile = Record<string, PluginGapRecord>;

/** A notice to send: the first one, or a reminder. */
export interface PluginGapNotice {
    id: string;
    reminder: boolean;
    title: string;
    message: string;
    /** The plugin's own page. */
    path: string;
}

const gapPath = (directory: string) => join(directory, 'plugin-backups.json');

export function readPluginGaps(directory: string): PluginGapFile {
    try {
        const parsed = JSON.parse(readFileSync(gapPath(directory), 'utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        const out: PluginGapFile = {};
        for (const [id, record] of Object.entries(parsed as Record<string, Partial<PluginGapRecord>>)) {
            if (typeof record?.flaggedAt === 'number') {
                out[id] =
                    typeof record.notifiedAt === 'number'
                        ? { flaggedAt: record.flaggedAt, notifiedAt: record.notifiedAt }
                        : { flaggedAt: record.flaggedAt };
            }
        }
        return out;
    } catch {
        return {};
    }
}

export function writePluginGaps(directory: string, file: PluginGapFile) {
    writePrivate(gapPath(directory), JSON.stringify(file));
}

/** Whether admins get notices about this plugin: flagged, with no `backup` declared. */
export const noticed = (status: PluginBackupStatus) => status.state === 'not_backed_up' && !status.declared;

/**
 * The record after one check, and the notices it owes: one for a plugin
 * flagged for the first time (or whose first notice never went out), a
 * reminder for one whose last notice is a week old. A plugin no longer
 * flagged is dropped, so flagging it again later notifies again. The record
 * keeps each owed notice's previous `notifiedAt`: the caller records the
 * new one with `delivered` once the notice went out.
 */
export function observePluginGaps(
    statuses: readonly PluginBackupStatus[],
    previous: PluginGapFile,
    now: number,
): { file: PluginGapFile; notices: PluginGapNotice[] } {
    const file: PluginGapFile = {};
    const notices: PluginGapNotice[] = [];
    for (const status of statuses) {
        if (!noticed(status)) {
            continue;
        }
        const before = previous[status.id];
        file[status.id] = before ?? { flaggedAt: now };
        if (before?.notifiedAt !== undefined && now - before.notifiedAt < PLUGIN_GAP_REMINDER_MS) {
            continue;
        }
        notices.push(gapNotice(status, before?.notifiedAt !== undefined));
    }
    return { file, notices };
}

/** The record once `notice` was delivered at `now`. */
export function delivered(file: PluginGapFile, notice: Pick<PluginGapNotice, 'id'>, now: number): PluginGapFile {
    const record = file[notice.id];
    return record ? { ...file, [notice.id]: { flaggedAt: record.flaggedAt, notifiedAt: now } } : file;
}

function gapNotice(status: PluginBackupStatus, reminder: boolean): PluginGapNotice {
    const volumes = status.volumes.join(', ');
    return {
        id: status.id,
        reminder,
        title: reminder ? `Still not backed up: ${status.name}` : `Not backed up: ${status.name}`,
        message: `${status.name} keeps data on its own storage (${volumes}), and the installed version doesn’t declare backups, so the workspace’s backups don’t include it. It keeps running. Ask whoever maintains the plugin catalog to add service.backup, then apply the plugin’s Update; a later release refuses to install or update it without one.`,
        path: `/settings/plugins/${encodeURIComponent(status.id)}`,
    };
}
