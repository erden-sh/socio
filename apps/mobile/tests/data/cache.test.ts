import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    CACHE_DB,
    CACHE_SCHEMA,
    type CacheSchema,
    openCacheDb,
    openEncrypted,
    openUserDb,
    type SqlStatements,
    StoreOpenError,
    USER_DB,
    USER_MIGRATIONS,
} from '../../src/data';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';

// cache.db is disposable: another schema
// version deletes and rebuilds it, and nothing else in the workspace's
// directory, user.db above all, is touched.

const CACHE_KEY = '0f'.repeat(32);
const USER_KEY = 'e1'.repeat(32);

let directory: string;
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'socio-cache-'));
});
afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
});

const at = (version: number): CacheSchema => ({ version, statements: CACHE_SCHEMA.statements });

const insertRow = (db: SqlStatements, key: string) =>
    db.run('INSERT INTO rows VALUES (?, ?, ?, ?, ?, ?)', ['conversations', '', key, '{"title":"Kickoff"}', null, 1]);

/** A cache.db at `version` with one row, closed. */
async function existing(version = CACHE_SCHEMA.version): Promise<void> {
    const { db } = await openCacheDb(createNodeSqliteDriver(), directory, CACHE_KEY, at(version));
    await insertRow(db, 'c1');
    await db.close();
}

const keysIn = async (db: SqlStatements) =>
    (await db.all<{ key: string }>('SELECT key FROM rows ORDER BY key')).map((row) => row.key);

describe('cache.db', () => {
    it('opens a file at the schema version with its rows', async () => {
        await existing();
        const { db, created, rebuilt } = await openCacheDb(createNodeSqliteDriver(), directory, CACHE_KEY);
        expect({ created, rebuilt }).toEqual({ created: false, rebuilt: false });
        expect(await keysIn(db)).toEqual(['c1']);
        await db.close();
    });

    it.each([
        ['an older', 1, 2],
        ['a newer', 3, 2],
    ])('deletes %s file and builds it again at the schema version', async (_, onPhone, inBuild) => {
        await existing(onPhone);
        const driver = createNodeSqliteDriver();
        const { db, created, rebuilt } = await openCacheDb(driver, directory, CACHE_KEY, at(inBuild));
        expect({ created, rebuilt }).toEqual({ created: true, rebuilt: true });
        expect(driver.log).toContain('cache.db: (deleted)');
        expect(await keysIn(db)).toEqual([]);
        expect(await db.get('PRAGMA user_version')).toEqual({ user_version: inBuild });
        // A rebuilt file is a new one: it got the auto-vacuum mode again.
        expect(await db.get('PRAGMA auto_vacuum')).toEqual({ auto_vacuum: 2 });
        await insertRow(db, 'c2');
        await db.close();
        expect(driver.openPaths()).toEqual([]);
    });

    it('rebuilds without touching user.db or anything else in the directory', async () => {
        const user = await openUserDb(createNodeSqliteDriver(), directory, USER_KEY);
        await user.db.run('INSERT INTO drafts VALUES (?, ?, ?, ?, ?)', ['chat:c1', 'half a thought', 1, 1, null]);
        await user.db.close();
        mkdirSync(join(directory, 'attachments'));
        writeFileSync(join(directory, 'attachments', 'a1.jpg'), 'picked');
        await existing(1);
        const userBefore = readFileSync(join(directory, USER_DB));

        const { db, rebuilt } = await openCacheDb(createNodeSqliteDriver(), directory, CACHE_KEY, at(2));
        expect(rebuilt).toBe(true);
        await db.close();

        expect(readdirSync(directory).sort()).toEqual(['attachments', CACHE_DB, USER_DB]);
        expect(readFileSync(join(directory, 'attachments', 'a1.jpg'), 'utf8')).toBe('picked');
        expect(readFileSync(join(directory, USER_DB)).equals(userBefore)).toBe(true);
        const reopened = await openUserDb(createNodeSqliteDriver(), directory, USER_KEY);
        expect(reopened.state).toEqual({ writable: true, version: USER_MIGRATIONS.length });
        expect(await reopened.db.all('SELECT scope, text FROM drafts')).toEqual([
            { scope: 'chat:c1', text: 'half a thought' },
        ]);
        await reopened.db.close();
    });

    it('rebuilds while user.db is open, which keeps working', async () => {
        const driver = createNodeSqliteDriver();
        await existing(1);
        const user = await openUserDb(driver, directory, USER_KEY);
        const cache = await openCacheDb(driver, directory, CACHE_KEY, at(2));
        expect(cache.rebuilt).toBe(true);
        await user.db.run('INSERT INTO ids VALUES (?, ?, ?)', ['conversation', 'local-1', 'c-9']);
        expect(await user.db.all('SELECT serverId FROM ids')).toEqual([{ serverId: 'c-9' }]);
        await Promise.all([cache.db.close(), user.db.close()]);
        expect(driver.openPaths()).toEqual([]);
    });

    it('refuses to rebuild while another connection holds the file, and leaves it', async () => {
        await existing(1);
        const driver = createNodeSqliteDriver();
        const other = await openEncrypted(driver, { directory, name: CACHE_DB }, CACHE_KEY);
        await expect(openCacheDb(driver, directory, CACHE_KEY, at(2))).rejects.toThrow(/currently open/);
        expect(driver.openPaths()).toEqual([join(directory, CACHE_DB)]);
        expect(await keysIn(other.db)).toEqual(['c1']);
        await other.db.close();
    });

    it('doesn’t rebuild a file its key can’t read: that is the caller’s case of files without their key', async () => {
        const keys = new Map<string, string>();
        const { db } = await openCacheDb(createNodeSqliteDriver({ keys }), directory, CACHE_KEY);
        await insertRow(db, 'c1');
        await db.close();
        const before = readFileSync(join(directory, CACHE_DB));

        const driver = createNodeSqliteDriver({ keys });
        const error = await openCacheDb(driver, directory, USER_KEY).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(StoreOpenError);
        expect(error).toMatchObject({ failure: 'wrong-key' });
        expect(driver.log).not.toContain('cache.db: (deleted)');
        expect(readFileSync(join(directory, CACHE_DB)).equals(before)).toBe(true);
    });
});
