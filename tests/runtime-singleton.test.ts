import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, it } from 'vitest';

import { RuntimeSession, type WorkLease } from '@socio/data/runtime-ownership';

import { testDatabase, testDatabaseFile } from './helpers/test-database.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) {
        await close();
    }
});
function memory() {
    const db = testDatabase();
    let now = 1000;
    const session = new RuntimeSession({
        heartbeat: false,
        leaseMs: 100,
        now: () => now,
    });
    const owner = session.attach(db);
    cleanup.push(() => {
        session.detachSync(db);
        db.close();
    });
    return {
        db,
        session,
        owner,
        advance: () => {
            now += 101;
        },
    };
}

it('admits each singleton idempotently, releases it, and fences every prior epoch', () => {
    const { owner, db } = memory();
    const first = owner.claimSingleton('scheduler')!;
    expect(first.epoch).toBe(1);
    expect(owner.claimSingleton('scheduler')).toEqual(first);
    expect(owner.claimSingleton('telegram')?.resource).toBe('singleton:telegram');
    expect(owner.release(first)).toBe(true);
    const next = owner.claimSingleton('scheduler')!;
    expect(next.epoch).toBe(2);
    expect(
        owner.guarded(first, () => {
            throw Error('stale effect');
        }),
    ).toEqual({ owned: false });
    expect(owner.release(first)).toBe(false);
    expect(owner.guarded(next, () => 'current effect')).toEqual({
        owned: true,
        value: 'current effect',
    });
    expect(db.prepare('SELECT COUNT(*) n FROM runtime_work').get()?.n).toBe(0);
    expect(() => owner.claimSingleton(' ')).toThrow('needs a name');
});

it('keeps work claims atomic and independent of singleton admission', () => {
    const { owner, db } = memory();
    const singleton = owner.claimSingleton('scheduler')!;
    expect(() =>
        owner.claim('job', 'failed', 'job:x', () => {
            throw Error('insert failed');
        }),
    ).toThrow('insert failed');
    expect(db.prepare('SELECT COUNT(*) n FROM runtime_work').get()?.n).toBe(0);
    const work = owner.claim('job', 'first', 'job:x', (lease) => lease);
    expect(work.epoch).toBe(1);
    expect(() => owner.claim('job', 'duplicate', 'job:x', (lease) => lease)).toThrow('already owned');
    expect(owner.owns(singleton)).toBe(true);
    owner.release(work);
    expect(owner.claim('job', 'second', 'job:x', (lease) => lease).epoch).toBe(2);
});

it('requires a fresh epoch after expiry and cannot readmit a detached runtime', async () => {
    const { owner, session, db, advance } = memory();
    const expired = owner.claimSingleton('backups')!;
    advance();
    await owner.heartbeat();
    expect(owner.owns(expired)).toBe(false);
    const replacement = owner.claimSingleton('backups')!;
    expect(replacement.epoch).toBe(2);
    session.detachSync(db);
    expect(owner.claimSingleton('backups')).toBeNull();
});

async function worker(path: string) {
    const child = fork(fileURLToPath(new URL('./fixtures/runtime-singleton-process.ts', import.meta.url)), [path], {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { PATH: process.env.PATH, NODE_ENV: 'test', DO_NOT_TRACK: '1' },
    });
    cleanup.push(async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
            return;
        }
        const exited = once(child, 'exit');
        child.kill('SIGCONT');
        child.kill('SIGKILL');
        await exited;
    });
    let next = 0;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    await new Promise<void>((resolve, reject) => {
        child.on('message', (message: { ready?: boolean; id?: number; result?: unknown; error?: string }) => {
            if (message.ready) {
                resolve();
            }
            if (message.id !== undefined) {
                const request = pending.get(message.id);
                pending.delete(message.id);
                if (message.error) {
                    request?.reject(Error(message.error));
                } else {
                    request?.resolve(message.result);
                }
            }
        });
        child.once('error', reject);
        child.once('exit', () => {
            reject(Error('Singleton fixture exited'));
            for (const request of pending.values()) {
                request.reject(Error('Singleton fixture exited'));
            }
            pending.clear();
        });
    });
    const call = <T = unknown>(action: string, name = 'scheduler') =>
        new Promise<T>((resolve, reject) => {
            const id = ++next;
            pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
            child.send({ id, action, name });
        });
    return { child, call };
}
function database() {
    const dir = mkdtempSync(join(tmpdir(), 'cb108-singletons-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return testDatabaseFile(join(dir, 'app.sqlite'));
}
interface Snapshot {
    lease: WorkLease & { expiresAt: number };
    effects: unknown[];
    work: number;
}

it('arbitrates two actual processes, keeps the live incumbent, and transfers after release', async () => {
    const path = database();
    const a = await worker(path),
        b = await worker(path);
    const results = await Promise.all([a.call<WorkLease | null>('claim'), b.call<WorkLease | null>('claim')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const [incumbent, candidate] = results[0] ? [a, b] : [b, a];
    const lease = results.find(Boolean)!;
    // Admission continues to fail while the incumbent renews beyond one full lease.
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(await candidate.call('claim')).toBeNull();
    expect(await incumbent.call('claim')).toEqual(lease);
    expect(await candidate.call('claim', 'telegram')).toMatchObject({ epoch: 1 });
    expect(await incumbent.call('release')).toBe(true);
    expect(await candidate.call('claim')).toMatchObject({ epoch: 2 });
    expect(await incumbent.call('write')).toEqual({ owned: false });
    expect(await candidate.call('write')).toEqual({ owned: true, value: true });
    expect(await candidate.call('snapshot')).toMatchObject({
        work: 0,
        effects: [{ epoch: 2 }],
    });
});

it('takes over a stopped process only after expiry and rejects its late heartbeat and side effects', async () => {
    const path = database();
    const a = await worker(path),
        b = await worker(path);
    await a.call('claim');
    a.child.kill('SIGSTOP');
    const before = await b.call<Snapshot>('snapshot');
    expect(await b.call('claim')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, before.lease.expiresAt - Date.now()) + 150));
    expect(await b.call('claim')).toMatchObject({ epoch: 2 });
    a.child.kill('SIGCONT');
    await a.call('heartbeat');
    expect(await a.call('write')).toEqual({ owned: false });
    expect(await a.call('release')).toBe(false);
    expect(await a.call('claim')).toBeNull();
    expect(await b.call('write')).toEqual({ owned: true, value: true });
    expect((await b.call<Snapshot>('snapshot')).effects).toHaveLength(1);
});
