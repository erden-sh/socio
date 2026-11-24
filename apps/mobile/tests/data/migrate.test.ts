import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    latestVersion,
    type Migration,
    openEncrypted,
    openUserDb,
    SQLITE_BUSY,
    type SqlStatements,
    StoreOpenError,
    UPDATE_TO_SEND,
    USER_DB,
    USER_MIGRATIONS,
} from '../../src/data';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';

// user.db's migrations (src/data/migrate.ts):
// additive and versioned; a failure leaves the file as it was and blocks
// writes; a file from a newer build opens read-only.

const KEY = '5e'.repeat(32);

let directory: string;
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'socio-migrate-'));
});
afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
});

const path = () => join(directory, USER_DB);

const ADD_HELD_BY: Migration = {
    version: USER_MIGRATIONS.length + 1,
    statements: ['ALTER TABLE outbox ADD COLUMN heldBy TEXT'],
};

/** The version a test migration after the shipped ones brings the file to. */
const LATER = USER_MIGRATIONS.length + 1;

const insertOutbox = (db: SqlStatements, id = 'm1') =>
    db.run('INSERT INTO outbox VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        id,
        'chat:c1',
        'sendMessage',
        '{"text":"hello"}',
        1,
        null,
        `key-${id}`,
        'queued',
        0,
        0,
        1_762_500_000_000,
        null,
    ]);

/** A user.db at the shipped migrations with one outbox row, closed. */
async function existing(): Promise<void> {
    const { db, state } = await openUserDb(createNodeSqliteDriver(), directory, KEY);
    expect(state).toEqual({ writable: true, version: latestVersion(USER_MIGRATIONS) });
    await insertOutbox(db);
    await db.close();
}

/**
 * Holds user.db's write lock for `ms`, as a second connection on the phone can.
 * It runs on another thread, since node:sqlite blocks the thread that waits for
 * a lock. Resolves once the lock is held, with a promise of its release.
 */
async function holdWriteLock(ms: number): Promise<{ readonly released: Promise<void> }> {
    const worker = new Worker(
        `const { DatabaseSync } = require('node:sqlite');
        const { parentPort, workerData } = require('node:worker_threads');
        const db = new DatabaseSync(workerData.path);
        db.exec('BEGIN IMMEDIATE');
        parentPort.postMessage('held');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.ms);
        db.exec('ROLLBACK');
        db.close();`,
        { eval: true, workerData: { path: path(), ms } },
    );
    const released = new Promise<void>((resolve, reject) => {
        worker.once('exit', () => resolve());
        worker.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
        worker.once('message', () => resolve());
        worker.once('error', reject);
    });
    return { released };
}

const outboxColumns = async (db: SqlStatements) =>
    (await db.all<{ name: string }>('SELECT name FROM pragma_table_info(?)', ['outbox'])).map((column) => column.name);

describe('user.db', () => {
    it('is created at the last migration, writable', async () => {
        const driver = createNodeSqliteDriver();
        const { db, created, state } = await openUserDb(driver, directory, KEY);
        expect(created).toBe(true);
        expect(state).toEqual({ writable: true, version: USER_MIGRATIONS.length });
        await insertOutbox(db);
        await db.close();
        expect(driver.openPaths()).toEqual([]);
    });

    it('runs no migration on a file already at the last one', async () => {
        await existing();
        const driver = createNodeSqliteDriver();
        const { db, created, state } = await openUserDb(driver, directory, KEY);
        expect({ created, state }).toEqual({
            created: false,
            state: { writable: true, version: USER_MIGRATIONS.length },
        });
        expect(driver.log.filter((line) => /CREATE|BEGIN|user_version =/.test(line))).toEqual([]);
        await db.close();
    });

    it('adds a later migration to the file and keeps its rows', async () => {
        await existing();
        const { db, state } = await openUserDb(createNodeSqliteDriver(), directory, KEY, [
            ...USER_MIGRATIONS,
            ADD_HELD_BY,
        ]);
        expect(state).toEqual({ writable: true, version: LATER });
        expect(await outboxColumns(db)).toContain('heldBy');
        expect(await db.all('SELECT id, heldBy FROM outbox')).toEqual([{ id: 'm1', heldBy: null }]);
        expect(await db.get('PRAGMA user_version')).toEqual({ user_version: LATER });
        await db.close();
    });

    it('leaves the main file byte-identical when a migration fails, and takes no write', async () => {
        await existing();
        const before = readFileSync(path());
        // Two pending migrations: the first works, the second fails halfway. Neither stays.
        const broken: Migration = {
            version: LATER + 1,
            statements: ['ALTER TABLE outbox ADD COLUMN sentAt INTEGER', 'CREATE TABLE half ('],
        };
        const driver = createNodeSqliteDriver();
        const { db, state } = await openUserDb(driver, directory, KEY, [...USER_MIGRATIONS, ADD_HELD_BY, broken]);
        expect(state).toMatchObject({ writable: false, reason: 'migration-failed', version: USER_MIGRATIONS.length });
        expect(state.writable === false && state.reason === 'migration-failed' && state.error).toBeInstanceOf(Error);

        // Readable: what the person wrote is still there to show and copy.
        expect(await db.all('SELECT id, payload FROM outbox')).toEqual([{ id: 'm1', payload: '{"text":"hello"}' }]);
        expect(await outboxColumns(db)).not.toContain('heldBy');
        expect(await outboxColumns(db)).not.toContain('sentAt');
        expect(await db.get('PRAGMA user_version')).toEqual({ user_version: USER_MIGRATIONS.length });
        // Not writable.
        await expect(insertOutbox(db, 'm2')).rejects.toThrow(/readonly/);
        await expect(db.exec(`PRAGMA user_version = ${LATER + 1}`)).rejects.toThrow(/readonly/);
        await db.close();

        expect(driver.openPaths()).toEqual([]);
        expect(readFileSync(path()).equals(before)).toBe(true);

        // The file still opens and migrates once the build's migrations work.
        const fixed = await openUserDb(createNodeSqliteDriver(), directory, KEY, [...USER_MIGRATIONS, ADD_HELD_BY]);
        expect(fixed.state).toEqual({ writable: true, version: LATER });
        await fixed.db.close();
    });

    it('opens a file from a newer build read-only, with “Update Socio to send these”, and leaves it as it was', async () => {
        await existing();
        const raw = await openEncrypted(createNodeSqliteDriver(), { directory, name: USER_DB }, KEY);
        await raw.db.exec('PRAGMA user_version = 7');
        await raw.db.close();
        const before = readFileSync(path());

        const driver = createNodeSqliteDriver();
        const { db, state } = await openUserDb(driver, directory, KEY);
        expect(state).toEqual({ writable: false, reason: 'newer', version: 7, message: UPDATE_TO_SEND });
        expect(UPDATE_TO_SEND).toBe('Update Socio to send these');
        expect(driver.log.filter((line) => /CREATE|BEGIN/.test(line))).toEqual([]);
        expect(await db.all('SELECT id FROM outbox')).toEqual([{ id: 'm1' }]);
        await expect(insertOutbox(db, 'm2')).rejects.toThrow(/readonly/);
        await expect(db.run('DELETE FROM outbox')).rejects.toThrow(/readonly/);
        await db.close();
        expect(readFileSync(path()).equals(before)).toBe(true);
    });

    // A lock is not a failed migration: blocking writes for it would keep the
    // outbox and drafts from recording anything until the next launch.
    it('fails the open with busy, not migration-failed, while another connection holds the write lock, and keeps writes on', async () => {
        await existing();
        const before = readFileSync(path());
        const holder = new DatabaseSync(path());
        try {
            holder.exec('BEGIN IMMEDIATE');
            // No busy_timeout, so the lock fails at once instead of after 5 s.
            const driver = createNodeSqliteDriver({
                intercept: (sql) => (/^PRAGMA busy_timeout/i.test(sql.trim()) ? [] : undefined),
            });
            const error = await openUserDb(driver, directory, KEY, [...USER_MIGRATIONS, ADD_HELD_BY]).catch(
                (caught: unknown) => caught,
            );
            expect(error).toBeInstanceOf(StoreOpenError);
            expect(error).toMatchObject({ failure: 'busy', file: { directory, name: USER_DB } });
            expect((error as StoreOpenError).cause).toMatchObject({ resultCode: SQLITE_BUSY });
            expect(driver.log.at(-1)).toBe('user.db: BEGIN IMMEDIATE');
            expect(driver.openPaths()).toEqual([]);
            holder.exec('ROLLBACK');
        } finally {
            holder.close();
        }
        expect(readFileSync(path()).equals(before)).toBe(true);

        const again = await openUserDb(createNodeSqliteDriver(), directory, KEY, [...USER_MIGRATIONS, ADD_HELD_BY]);
        expect(again.state).toEqual({ writable: true, version: LATER });
        expect(await again.db.run('UPDATE outbox SET heldBy = ? WHERE id = ?', ['device-1', 'm1'])).toMatchObject({
            changes: 1,
        });
        await again.db.close();
    });

    it('waits out a short lock through busy_timeout, then migrates', async () => {
        await existing();
        const { released } = await holdWriteLock(300);
        try {
            const { db, state } = await openUserDb(createNodeSqliteDriver(), directory, KEY, [
                ...USER_MIGRATIONS,
                ADD_HELD_BY,
            ]);
            expect(state).toEqual({ writable: true, version: LATER });
            await db.close();
        } finally {
            await released;
        }
    });

    it('closes the file when it can’t turn writes off', async () => {
        await existing();
        const raw = await openEncrypted(createNodeSqliteDriver(), { directory, name: USER_DB }, KEY);
        await raw.db.exec('PRAGMA user_version = 7');
        await raw.db.close();
        const driver = createNodeSqliteDriver({
            intercept: (sql) => (/^PRAGMA query_only$/i.test(sql.trim()) ? [{ query_only: 0 }] : undefined),
        });
        await expect(openUserDb(driver, directory, KEY)).rejects.toThrow('Could not turn writes off on user.db.');
        expect(driver.openPaths()).toEqual([]);
    });
});

describe('latestVersion', () => {
    it('is the last of migrations numbered 1, 2, 3…', () => {
        expect(latestVersion(USER_MIGRATIONS)).toBe(USER_MIGRATIONS.length);
        expect(latestVersion([...USER_MIGRATIONS, ADD_HELD_BY])).toBe(LATER);
    });

    it.each<[string, Migration[]]>([
        ['none', []],
        ['a gap', [...USER_MIGRATIONS, { version: USER_MIGRATIONS.length + 2, statements: ['SELECT 1'] }]],
        ['a repeat', [...USER_MIGRATIONS, { version: 1, statements: ['SELECT 1'] }]],
        ['a step with no statement', [...USER_MIGRATIONS, { version: USER_MIGRATIONS.length + 1, statements: [] }]],
        ['a version that is not a whole number', [{ version: 1.5, statements: ['SELECT 1'] }]],
        ['version 0', [{ version: 0, statements: ['SELECT 1'] }]],
    ])('refuses %s', (_, migrations) => {
        expect(() => latestVersion(migrations)).toThrow(RangeError);
    });
});
