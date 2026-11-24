/**
 * The copies of the database a bundle's export and import make (CB-380):
 * the export reads a snapshot, never the live file; an applied import
 * copies the database first, as the purge does.
 */
import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { backupDatabaseOnline } from '@socio/data/backup';

const stamp = (now: Date) => now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');

/**
 * A consistent copy of the live database by `VACUUM INTO` (a read on its
 * own read-only connection), private from its first byte, for an export to
 * read. The caller removes it (`dispose`).
 */
export function snapshotForExport(databasePath: string, directory: string, now = new Date()) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `bundle-snapshot-${stamp(now)}.sqlite`);
    rmSync(path, { force: true });
    closeSync(openSync(path, 'wx', 0o600));
    try {
        const live = new DatabaseSync(databasePath, { readOnly: true });
        try {
            live.exec('PRAGMA busy_timeout=5000');
            live.prepare('VACUUM INTO ?').run(path);
        } finally {
            live.close();
        }
    } catch (error) {
        rmSync(path, { force: true });
        throw error;
    }
    return { path, dispose: () => rmSync(path, { force: true }) };
}

/**
 * The import's own copy of the database, right before its first write:
 * `BACKUP_DIR/import-<time>/`, with SQLite's online backup (off the main
 * thread, so a running server keeps answering), integrity checked.
 */
export async function copyBeforeImport(databasePath: string, backupDir: string, now = new Date()) {
    const directory = join(backupDir, `import-${stamp(now)}`);
    const { path } = await backupDatabaseOnline(databasePath, directory, 1, now);
    return path;
}

/** Whether a server holds the database (a live runtime row): offline work refuses then. */
export function serverRunning(db: DatabaseSync, now = Date.now()) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_instances'").get()) {
        return false;
    }
    const row = db
        .prepare('SELECT count(*) AS n FROM runtime_instances WHERE releasedAt IS NULL AND expiresAt > ?')
        .get(now) as { n: number };
    return Number(row.n) > 0;
}
