import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RuntimeSession } from '@socio/data/runtime-ownership';

import { testDatabase, testDatabaseFile } from './helpers/test-database.js';

vi.setConfig({ testTimeout: 40_000 });
const cleanup: Array<() => unknown> = [];
/** Owner processes loaded ahead for the next test (see `spawnOwner`). */
let spares: Array<ReturnType<typeof spawnOwner>> = [];
afterEach(async () => {
    spares = [];
    for (const close of cleanup.splice(0).reverse()) {
        await close();
    }
});
interface Snapshot {
    turn: string;
    job: string;
    partialPreserved: boolean;
    userPreserved: boolean;
    recoveries: number;
    probe: number;
    expiresAt: number;
    releasedAt: number | null;
}
/**
 * A fixture process with its modules loaded, not yet owning anything.
 * Loading takes seconds of CPU (many times that on a loaded machine), so
 * the tests start two ahead, in `beforeEach`, and their own time covers
 * only the leases they check.
 */
function spawnOwner() {
    const child = fork(fileURLToPath(new URL('./fixtures/runtime-owner-process.ts', import.meta.url)), [], {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
            PATH: process.env.PATH,
            NODE_ENV: 'test',
            DO_NOT_TRACK: '1',
            COPILOTKIT_TELEMETRY_DISABLED: 'true',
        },
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
    const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
    let readyNow: () => void = () => {};
    const ready = new Promise<void>((resolve) => (readyNow = resolve));
    const loaded = new Promise<void>((resolve, reject) => {
        child.on(
            'message',
            (message: { loaded?: boolean; ready?: boolean; id?: number; result?: unknown; error?: string }) => {
                if (message.loaded) {
                    resolve();
                }
                if (message.ready) {
                    readyNow();
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
            },
        );
        child.once('error', reject);
        child.once('exit', () => {
            reject(Error('Ownership fixture exited'));
            for (const request of pending.values()) {
                request.reject(Error('Ownership fixture exited'));
            }
            pending.clear();
        });
    });
    // A spare no test opened dies in cleanup: not a failure.
    loaded.catch(() => {});
    const call = <T = Record<string, unknown>>(action: string, fields: Record<string, unknown> = {}) =>
        new Promise<T>((resolve, reject) => {
            const id = ++next;
            pending.set(id, {
                resolve: resolve as (result: unknown) => void,
                reject,
            });
            child.send({ id, action, ...fields });
        });
    return { child, loaded, ready, call };
}
/** An owner process on the database at `path`, booted (and recovering) now. */
async function worker(path: string, heartbeat = true) {
    const owner = spares.shift() ?? spawnOwner();
    await owner.loaded;
    owner.child.send({ path, heartbeat });
    const exited = once(owner.child, 'exit').then(() => 'exited' as const);
    if ((await Promise.race([owner.ready, exited])) === 'exited') {
        throw Error('Ownership fixture exited');
    }
    const { child, call } = owner;
    return { child, call, snapshot: () => call<Snapshot>('snapshot') };
}
function database() {
    const dir = mkdtempSync(join(tmpdir(), 'cb108-owners-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return testDatabaseFile(join(dir, 'app.sqlite'));
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function expiry(state: Snapshot) {
    await sleep(Math.max(0, state.expiresAt - Date.now()) + 150);
}
async function killed(child: ChildProcess) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
}

describe('owners in separate processes', () => {
    // Two owner processes per test, loaded ahead. Loading checks no lease,
    // so its time is the hook's: 2 minutes covers a busy host.
    beforeEach(async () => {
        spares = [spawnOwner(), spawnOwner()];
        await Promise.all(spares.map((spare) => spare.loaded));
    }, 120_000);

    it('keeps a live incumbent turn/job intact in another process and atomically refuses a duplicate thread', async () => {
        const path = database();
        const a = await worker(path);
        expect(await a.call('turn')).toMatchObject({ accepted: true });
        await a.call('job');
        await expect.poll(async () => (await a.snapshot()).partialPreserved).toBe(true);
        // Construct the candidate only after the incumbent has durable live work.
        const b = await worker(path);
        expect(await b.snapshot()).toMatchObject({
            turn: 'running',
            job: 'queued',
            recoveries: 0,
            longRunCurrent: 'job-run-a',
            claimedItems: 1,
        });
        expect(await b.call('recover')).toMatchObject({
            turn: 'running',
            job: 'queued',
            recoveries: 0,
        });
        expect(await b.call('turn', { runId: 'duplicate' })).toMatchObject({
            accepted: false,
        });
        expect(await b.call('write')).toMatchObject({ owned: false });
        expect(await b.call('turn', { runId: 'independent', threadId: 'thread-b' })).toMatchObject({ accepted: true });
        await a.call('drain');
        await sleep(1800);
        expect(await b.call('recover')).toMatchObject({
            turn: 'running',
            job: 'queued',
            recoveries: 0,
            probe: 0,
            longRunCurrent: 'job-run-a',
            claimedItems: 1,
        });
        await a.call('release');
        expect(await b.call('recover')).toMatchObject({
            turn: 'interrupted',
            job: 'interrupted',
            recoveries: 2,
            partialPreserved: true,
            userPreserved: true,
        });
    });

    it('arbitrates simultaneous claims for one thread in two actual processes', async () => {
        const path = database();
        const a = await worker(path),
            b = await worker(path);
        const results = await Promise.all([
            a.call('turn', { runId: 'race-a', threadId: 'race-thread' }),
            b.call('turn', { runId: 'race-b', threadId: 'race-thread' }),
        ]);
        expect(results.filter((result) => result.accepted)).toHaveLength(1);
        const db = new DatabaseSync(path, { readOnly: true });
        try {
            expect(db.prepare("SELECT COUNT(*) n FROM agent_runs WHERE threadId='race-thread'").get()?.n).toBe(1);
            expect(
                db.prepare("SELECT epoch FROM runtime_leases WHERE resource='thread:race-thread'").get()?.epoch,
            ).toBe(1);
        } finally {
            db.close();
        }
    });

    it('recovers SIGKILL orphans only after expiry, exactly once, keeping partial messages and advancing epochs', async () => {
        const path = database();
        const a = await worker(path),
            b = await worker(path);
        await a.call('turn');
        await a.call('job');
        await expect.poll(async () => (await a.snapshot()).partialPreserved).toBe(true);
        const before = await b.snapshot();
        expect(before.releasedAt).toBeNull();
        await killed(a.child);
        expect(await b.call('recover')).toMatchObject({
            turn: 'running',
            job: 'queued',
            recoveries: 0,
        });
        await expiry(before);
        // The recovery attempt while the owner was alive armed a bounded retry:
        // lease expiry must recover without needing another restart or manual call.
        await expect.poll(async () => (await b.snapshot()).recoveries).toBe(2);
        expect(await b.snapshot()).toMatchObject({
            turn: 'interrupted',
            job: 'interrupted',
            recoveries: 2,
            partialPreserved: true,
            userPreserved: true,
        });
        expect(await b.call('recover')).toMatchObject({ recoveries: 2 });
        expect(await b.call('turn', { runId: 'replacement' })).toMatchObject({
            accepted: true,
        });
        const db = new DatabaseSync(path, { readOnly: true });
        try {
            expect(db.prepare("SELECT epoch FROM runtime_leases WHERE resource='thread:thread-a'").get()?.epoch).toBe(
                2,
            );
        } finally {
            db.close();
        }
    });

    it('fences a paused stale process after takeover so it cannot overwrite recovery or finalize a replacement', async () => {
        const path = database();
        const a = await worker(path),
            b = await worker(path);
        await a.call('turn');
        await a.call('job');
        await expect.poll(async () => (await a.snapshot()).partialPreserved).toBe(true);
        a.child.kill('SIGSTOP');
        const before = await b.snapshot();
        await expiry(before);
        expect(await b.call('recover')).toMatchObject({
            turn: 'interrupted',
            job: 'interrupted',
            recoveries: 2,
        });
        expect(await b.call('turn', { runId: 'replacement' })).toMatchObject({
            accepted: true,
        });
        a.child.kill('SIGCONT');
        expect(await a.call('write')).toMatchObject({ owned: false });
        await sleep(350);
        expect(await b.snapshot()).toMatchObject({
            turn: 'interrupted',
            probe: 0,
            recoveries: 2,
        });
        expect(await b.call<Snapshot>('snapshot', { runId: 'replacement' })).toMatchObject({ turn: 'running' });
    });
});

it('rolls a failed claim back atomically and never reuses a committed epoch', () => {
    const db = testDatabase();
    const session = new RuntimeSession({ heartbeat: false });
    const owner = session.attach(db);
    cleanup.push(() => {
        session.detachSync(db);
        db.close();
    });
    expect(() =>
        owner.claim('turn', 'failed', 'thread:x', () => {
            throw Error('insert failed');
        }),
    ).toThrow('insert failed');
    expect(db.prepare('SELECT COUNT(*) n FROM runtime_work').get()?.n).toBe(0);
    const first = owner.claim('turn', 'first', 'thread:x', (lease) => lease);
    expect(first.epoch).toBe(1);
    owner.guarded(first, () => owner.release(first));
    const second = owner.claim('turn', 'second', 'thread:x', (lease) => lease);
    expect(second.epoch).toBe(2);
    expect(
        owner.guarded(first, () => {
            throw Error('stale callback ran');
        }),
    ).toEqual({ owned: false });
});
