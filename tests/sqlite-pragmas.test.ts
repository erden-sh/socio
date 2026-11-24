import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyConnectionPragmas } from '@socio/data/sqlite-pragmas';

import { telegramLinksOn } from '../src/server/composition/integration-stores.js';

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pragmas-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function pragma(db: DatabaseSync, name: string) {
    const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number>;
    return Object.values(row)[0];
}

describe('connection pragmas (CB-110)', () => {
    it('sets WAL, busy_timeout and synchronous=NORMAL, and keeps the default autocheckpoint without Litestream', () => {
        const db = new DatabaseSync(join(dir, 'a.db'));
        applyConnectionPragmas(db, {});
        expect(pragma(db, 'journal_mode')).toBe('wal');
        expect(pragma(db, 'busy_timeout')).toBe(5000);
        expect(pragma(db, 'synchronous')).toBe(1);
        expect(pragma(db, 'wal_autocheckpoint')).toBe(1000);
        db.close();
    });

    it('turns automatic checkpoints off when LITESTREAM_REPLICA_DIR is set', () => {
        const db = new DatabaseSync(join(dir, 'b.db'));
        applyConnectionPragmas(db, { LITESTREAM_REPLICA_DIR: '/replica' });
        expect(pragma(db, 'synchronous')).toBe(1);
        expect(pragma(db, 'wal_autocheckpoint')).toBe(0);
        db.close();
    });

    it('treats a blank LITESTREAM_REPLICA_DIR as not configured', () => {
        const db = new DatabaseSync(join(dir, 'c.db'));
        applyConnectionPragmas(db, { LITESTREAM_REPLICA_DIR: '  ' });
        expect(pragma(db, 'wal_autocheckpoint')).toBe(1000);
        db.close();
    });
});

describe('write transactions (CB-110)', () => {
    it('BEGIN IMMEDIATE waits for busy_timeout instead of failing at once', () => {
        const path = join(dir, 'd.db');
        const holder = new DatabaseSync(path);
        applyConnectionPragmas(holder, {});
        holder.exec('CREATE TABLE t (x INTEGER)');
        holder.exec('BEGIN IMMEDIATE');
        const other = new DatabaseSync(path);
        applyConnectionPragmas(other, {});
        other.exec('PRAGMA busy_timeout=250');
        const started = Date.now();
        expect(() => other.exec('BEGIN IMMEDIATE')).toThrow(/locked|busy/i);
        expect(Date.now() - started).toBeGreaterThanOrEqual(200);
        holder.exec('COMMIT');
        other.exec('BEGIN IMMEDIATE');
        other.exec('INSERT INTO t VALUES (1)');
        other.exec('COMMIT');
        holder.close();
        other.close();
    });

    it('a store transaction waits for another process to commit, then succeeds', async () => {
        const path = join(dir, 'e.db');
        const setup = new DatabaseSync(path);
        applyConnectionPragmas(setup, {});
        setup.exec(
            'CREATE TABLE telegram_link_codes (hash TEXT PRIMARY KEY, userId TEXT, expiresAt INTEGER, usedAt INTEGER)',
        );
        setup.close();
        const child = spawn(
            process.execPath,
            [
                '-e',
                `const { DatabaseSync } = require('node:sqlite');
         const db = new DatabaseSync(process.argv[1]);
         db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
         db.exec('BEGIN IMMEDIATE');
         console.log('locked');
         setTimeout(() => { db.exec('COMMIT'); db.close(); }, 600);`,
                path,
            ],
            { stdio: ['ignore', 'pipe', 'inherit'] },
        );
        try {
            await new Promise<void>((resolve, reject) => {
                child.stdout.once('data', () => resolve());
                child.once('error', reject);
            });
            const db = new DatabaseSync(path);
            applyConnectionPragmas(db, {});
            const links = telegramLinksOn(db);
            const started = Date.now();
            await expect(links.createCode('u1', Date.now())).resolves.toMatchObject({
                code: expect.any(String),
            });
            expect(Date.now() - started).toBeGreaterThanOrEqual(300);
            db.close();
        } finally {
            child.kill();
        }
    });
});
