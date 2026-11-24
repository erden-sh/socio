import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountTurns } from '../src/server/auth/account-turns.js';
import { authSchema } from '../src/server/auth/schema.js';

// CB-379: one person's device turns, across processes (two connections on one database).

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        cleanup();
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
});

function database() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-turns-'));
    const path = join(dir, 'auth.sqlite');
    const setup = new DatabaseSync(path);
    setup.exec('PRAGMA journal_mode=WAL');
    setup.exec(authSchema.migrations!.find((migration) => migration.version === 15)!.up as string);
    setup.close();
    const open = () => {
        const db = new DatabaseSync(path);
        db.exec('PRAGMA busy_timeout=5000');
        cleanups.push(() => db.close());
        return db;
    };
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return open;
}

const timing = { leaseMs: 300, waitMs: 5000, pollMs: 5 };

describe('account turns', () => {
    it('runs one process’s turn only after the other’s, and lets go of the lease', async () => {
        const open = database();
        const one = open();
        const a = new AccountTurns(() => one, timing);
        const b = new AccountTurns(() => open(), timing);
        const order: string[] = [];
        let release: () => void = () => undefined;
        const first = a.run('acc', async () => {
            order.push('a start');
            await new Promise<void>((resolve) => (release = resolve));
            order.push('a end');
        });
        await vi.waitFor(() => expect(order).toEqual(['a start']));
        const second = b.run('acc', async () => void order.push('b'));
        // Past the lease's own length: the holder renews it while it works.
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(order).toEqual(['a start']);
        release();
        await Promise.all([first, second]);
        expect(order).toEqual(['a start', 'a end', 'b']);
        expect(one.prepare('SELECT count(*) AS n FROM auth_device_turn').get()).toEqual({ n: 0 });
        // Another person's turn never waits on this one.
        await b.run('other', async () => undefined);
    });

    it('takes over a lease its holder stopped renewing (a process that died)', async () => {
        // A fake clock: the takeover waits for the dead holder's lease to run out, and no longer than its
        // next try, however loaded the machine is (real waits made this flaky under the full suite).
        vi.useFakeTimers({
            now: 1_000_000,
            toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
        });
        const open = database();
        const db = open();
        const started = Date.now();
        db.prepare('INSERT INTO auth_device_turn(accountId, holder, expiresAt) VALUES (?, ?, ?)').run(
            'acc',
            'p_dead.1',
            started + 150,
        );
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        let ranAt: number | undefined;
        let held: unknown;
        const turn = new AccountTurns(() => db, timing).run('acc', async () => {
            ranAt = Date.now();
            held = db.prepare('SELECT holder, expiresAt FROM auth_device_turn').get();
        });
        // Still the dead holder's lease: the turn waits.
        await vi.advanceTimersByTimeAsync(149);
        expect(ranAt).toBeUndefined();
        // Past it: the next try takes it over (tries back off to at most 200 ms apart).
        await vi.advanceTimersByTimeAsync(250);
        await turn;
        expect(ranAt).toBeGreaterThanOrEqual(started + 150);
        expect(held).toEqual({
            holder: expect.stringMatching(/^p_[0-9a-f]{16}\.1$/),
            expiresAt: ranAt! + timing.leaseMs,
        });
        // Taken over, not gone ahead without it, and let go of afterwards.
        expect(errors).not.toHaveBeenCalled();
        expect(db.prepare('SELECT count(*) AS n FROM auth_device_turn').get()).toEqual({ n: 0 });
    });

    it('goes ahead without the lease, reported, once the wait runs out', async () => {
        const open = database();
        const db = open();
        db.prepare('INSERT INTO auth_device_turn(accountId, holder, expiresAt) VALUES (?, ?, ?)').run(
            'acc',
            'p_stuck.1',
            Date.now() + 60_000,
        );
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        let ran = false;
        await new AccountTurns(() => db, { ...timing, waitMs: 50 }).run('acc', async () => {
            ran = true;
        });
        expect(ran).toBe(true);
        expect(errors.mock.calls.flat().join('\n')).toContain('Device turn lease wait ran out');
        // The other holder's lease is left as it is.
        expect(db.prepare('SELECT holder FROM auth_device_turn').get()).toEqual({
            holder: 'p_stuck.1',
        });
    });

    it('doesn’t wait inside a transaction, where the other process could not write', async () => {
        const open = database();
        const db = open();
        open()
            .prepare('INSERT INTO auth_device_turn(accountId, holder, expiresAt) VALUES (?, ?, ?)')
            .run('acc', 'p_other.1', Date.now() + 60_000);
        db.exec('BEGIN');
        let ran = false;
        await new AccountTurns(() => db, timing).run('acc', async () => {
            ran = true;
        });
        db.exec('COMMIT');
        expect(ran).toBe(true);
    });
});
