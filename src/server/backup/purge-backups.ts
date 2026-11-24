// Permanent removals' backups roll off (CB-391). Each purge (CB-360) copies
// what it deletes into BACKUP_DIR/purge-<time>/ (purge/run.ts); once that
// copy is older than PURGE_BACKUP_DAYS (or an admin's choice in Settings),
// the scheduled backup removes it, so deleted data leaves the backups too.
// They never go off-site: the off-site copy sends only the scheduled
// backups, which BACKUP_KEEP already rolls off.
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const DAY = 86_400_000;

/** `purge-YYYYMMDD-HHMMSS`, or `-2`, ... for a second purge in the same second. */
const PURGE = /^purge-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?$/;

/** When a purge backup was made, from its name (UTC); undefined for any other name. */
export function purgeBackupTime(name: string): number | undefined {
    const match = name.match(PURGE);
    if (!match) {
        return undefined;
    }
    const [, y, mo, d, h, mi, s] = match.map(Number);
    const time = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
    return Number.isNaN(time) ? undefined : time;
}

/**
 * Whether a purge backup must stay whatever its age: its cleanup still
 * waits for `purge --resume` (cleanup.json with `done: false`), whose
 * manifest it holds, or that manifest can't be read to tell. Only a
 * missing manifest (a purge that stopped before its commit) or one marked
 * done lets it go.
 */
function mustStay(path: string): 'pending' | 'unreadable' | undefined {
    let text: string;
    try {
        text = readFileSync(join(path, 'cleanup.json'), 'utf8');
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'unreadable';
    }
    try {
        const done = (JSON.parse(text) as { done?: unknown } | null)?.done;
        return done === true ? undefined : done === false ? 'pending' : 'unreadable';
    } catch {
        return 'unreadable';
    }
}

/**
 * Removes the `purge-<time>` folders in `directory` older than `days`;
 * younger ones, and any whose cleanup is pending or unknown, stay. Returns the names
 * removed. Other backups are never touched.
 */
export function prunePurgeBackups(
    directory: string,
    days: number,
    now: number,
    log: (line: string) => void = () => {},
): string[] {
    if (!Number.isInteger(days) || days < 1) {
        throw new Error('Purge backups must be kept at least a day.');
    }
    let names: string[];
    try {
        names = readdirSync(directory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }
    const removed: string[] = [];
    for (const name of names) {
        const time = purgeBackupTime(name);
        if (time === undefined || now - time <= days * DAY) {
            continue;
        }
        const path = join(directory, name);
        const stay = mustStay(path);
        if (stay === 'unreadable') {
            log(`Kept the permanent removal backup ${name} past its days: its cleanup.json can't be read.`);
        }
        if (stay) {
            continue;
        }
        rmSync(path, { recursive: true, force: true });
        removed.push(name);
    }
    return removed;
}
