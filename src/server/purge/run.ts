// The purge's apply, shared by the CLI (purge-cli.ts, `pnpm run purge
// --apply`) and operators' "Remove permanently" (person.ts, CB-360): the
// same backup, checks, deletes and audit line, on a connection of its own.
//
// It backs up the database and every file and object it will delete into
// BACKUP_DIR/purge-<time>/, checks that the copy plans the same purge, then
// in one write transaction checks that every row, file and object that
// goes is as backed up, deletes the rows and records one workspace audit
// line. The files and objects go after the commit; their list is saved
// first as cleanup.json, and `purge --resume BACKUP_DIR` finishes a cleanup
// that failed part way.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { backupDatabaseOnline } from '@socio/data/backup';
import type { ObjectStore } from '@socio/data/object-store';

import { stamp } from './list.js';
import {
    applyPurgeRows,
    cleanupOf,
    contentDigest,
    fileDigest,
    finishCleanup,
    planDigest,
    planPurge,
    PURGE_KINDS,
    type PurgeCleanup,
    type PurgeList,
    type PurgeOptions,
    type PurgePlan,
} from './purge.js';
import type { PurgeSupervisor } from './supervisor.js';

/** The objects a purge backs up, checks and deletes (S3). */
export type PurgeStore = Pick<ObjectStore, 'get' | 'head' | 'delete'>;

/**
 * A backup folder of this purge's own, `purge-<time>` or, when another
 * purge started in the same second, `purge-<time>-2`, ...: made exclusively,
 * so two purges never share a database copy or a cleanup manifest.
 */
export function reserveBackupDir(backupDir: string, now: Date) {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    for (let n = 1; ; n++) {
        const path = join(backupDir, `purge-${stamp(now)}${n === 1 ? '' : `-${n}`}`);
        try {
            mkdirSync(path, { mode: 0o700 });
            return path;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
        }
    }
}

/** The dry run: a read transaction, rolled back. */
export function planOnce(db: DatabaseSync, list: PurgeList, options: PurgeOptions): PurgePlan {
    db.exec('BEGIN');
    try {
        return planPurge(db, list, options);
    } finally {
        db.exec('ROLLBACK');
    }
}

export interface ApplyPurge {
    db: DatabaseSync;
    /** The database file, for the online backup. */
    database: string;
    list: PurgeList;
    options: PurgeOptions;
    /** The dry run's plan, without refusals. */
    plan: PurgePlan;
    /** Whether the supervisor removes the purged socios' computers (`planComputers`). */
    computers: boolean;
    store?: PurgeStore;
    /** BACKUP_DIR: the backup goes in a `purge-<time>` folder under it. */
    backupDir: string;
    /** Who the audit line names: `cli`, or the operator's user id. */
    actor: string;
    /**
     * Checked inside the write transaction, before anything is deleted:
     * throws when the purge may no longer go ahead (an operator's removal
     * checks the person is still deactivated, under the name confirmed).
     */
    check?: (db: DatabaseSync) => void;
    now?: Date;
    log?: (line: string) => void;
}

/**
 * Backs up, checks and deletes the rows of a planned purge, with its audit
 * line; returns the rows deleted and the cleanup manifest, which
 * `cleanUp` finishes. Throws, with nothing deleted, when anything changed
 * since the plan or the backup.
 */
export async function applyPlannedPurge(input: ApplyPurge) {
    const { db, database, list, options, plan, store } = input;
    const now = input.now ?? new Date();
    const log = input.log ?? (() => {});
    if (plan.refusals.length) {
        throw new Error(`Refused: ${plan.refusals.join(' ')}`);
    }
    // Backups first: the database, then each file and object that goes.
    const backupRoot = reserveBackupDir(input.backupDir, now);
    const databaseCopy = await backupDatabaseOnline(database, backupRoot, 1, now, { prune: false });
    // The copy must plan the same purge; its rows are what the backup holds.
    const copy = new DatabaseSync(databaseCopy.path);
    let content: string;
    try {
        copy.exec('BEGIN');
        const copied = planPurge(copy, list, options);
        if (planDigest(copied) !== planDigest(plan)) {
            throw new Error('The data changed while it was backed up: run it again.');
        }
        content = contentDigest(copy);
        copy.exec('ROLLBACK');
    } finally {
        copy.close();
    }
    const files = plan.files.map((file) => {
        const to = join(backupRoot, 'files', relative(options.userDataDir, file.path));
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        copyFileSync(file.path, to);
        return { path: file.path, sha256: fileDigest(to) };
    });
    if (plan.objects.length && !store) {
        throw new Error('The plan deletes stored objects: set S3_ENDPOINT and the other S3_* settings.');
    }
    const objects: { key: string; size: number | undefined }[] = [];
    for (const object of plan.objects) {
        const body = await store!.get(object.key);
        if (body) {
            const path = join(backupRoot, 'objects', ...object.key.split('/'));
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            writeFileSync(path, body, { mode: 0o600 });
        }
        objects.push({ key: object.key, size: body?.length });
    }
    log(
        `Backed up the database to ${databaseCopy.path}, ${files.length} file(s) and ${objects.length} object(s) under ${backupRoot}.`,
    );
    // Written before the commit: if the files or objects can't all go, --resume finishes.
    const cleanup = cleanupOf(plan, options.userDataDir, { computers: input.computers });
    const manifest = join(backupRoot, 'cleanup.json');
    writeFileSync(manifest, `${JSON.stringify({ ...cleanup, done: false }, null, 2)}\n`, { mode: 0o600 });

    // The rows, in one write transaction: no writer commits until it ends,
    // and it deletes only what matches the backup, row for row.
    db.exec('BEGIN IMMEDIATE');
    let deleted: { table: string; rows: number }[];
    try {
        input.check?.(db);
        for (const file of files) {
            if (fileDigest(file.path) !== file.sha256) {
                throw new Error(`${file.path} changed since the backup: run it again.`);
            }
        }
        for (const object of objects) {
            if ((await store!.head(object.key))?.size !== object.size) {
                throw new Error(`Object ${object.key} changed since the backup: run it again.`);
            }
        }
        deleted = applyPurgeRows(db, list, plan, { ...options, content });
        const total = deleted.reduce((sum, entry) => sum + entry.rows, 0);
        db.prepare(
            'INSERT INTO workspace_audit (actor, action, targetKind, targetId, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(
            input.actor,
            'remove',
            'purge',
            stamp(now),
            `${PURGE_KINDS.map((kind) => `${kind} ${plan.targets[kind].length}`).join(', ')}; ${total} rows; backup ${backupRoot}`,
            Date.now(),
        );
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        rmSync(manifest, { force: true });
        throw error;
    }
    return { deleted, backupRoot, manifest };
}

/** Removes a committed purge's files, objects and computers; repeatable (`--resume BACKUP`). */
export async function cleanUp(
    manifest: string,
    store: PurgeStore | undefined,
    supervisor: PurgeSupervisor | undefined,
) {
    const cleanup = JSON.parse(readFileSync(manifest, 'utf8')) as PurgeCleanup & { done: boolean };
    try {
        const done = await finishCleanup(cleanup, store, supervisor);
        writeFileSync(manifest, `${JSON.stringify({ ...cleanup, done: true }, null, 2)}\n`, { mode: 0o600 });
        return done;
    } catch (error) {
        throw new Error(
            `The rows are gone, but not every file or object: ${error instanceof Error ? error.message : String(error)} Finish with: purge --resume ${dirname(manifest)}`,
        );
    }
}
