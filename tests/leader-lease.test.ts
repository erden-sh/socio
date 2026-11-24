import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { openDatabase, sqliteData } from '@socio/data/open';
import { RuntimeSession } from '@socio/data/runtime-ownership';

import { LeaderLease, type LeaderAuthority, type LeaderHooks } from '../src/server/runtime/background.js';
import { createShutdown } from '../src/server/runtime/shutdown.js';

import { Runner } from './helpers/runners.js';
import { Store } from './helpers/stores.js';
import { testDatabaseFile } from './helpers/test-database.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) {
        await close();
    }
});
/** Two runtimes on two connections to one file, on one fake clock. */
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'leader-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = testDatabaseFile(join(dir, 'app.sqlite'));
    let now = 1000;
    const a = openDatabase(path),
        b = openDatabase(path);
    cleanup.push(() => {
        a.close();
        b.close();
    });
    const clock = { heartbeat: false, leaseMs: 100, now: () => now };
    const ar = new RuntimeSession(clock),
        br = new RuntimeSession(clock);
    const ao = ar.attach(a),
        bo = br.attach(b);
    cleanup.push(() => {
        if (a.isOpen) {
            ar.detachSync(a);
        }
        if (b.isOpen) {
            br.detachSync(b);
        }
    });
    return {
        a,
        b,
        ar,
        br,
        ao,
        bo,
        /** Past every lease and runtime heartbeat. */
        expire: () => {
            now += 101;
        },
        epoch: () => b.prepare("SELECT epoch FROM runtime_leases WHERE resource='singleton:leader'").get()?.epoch,
    };
}
const hooks = (extra: Partial<LeaderHooks> = {}) => ({
    start: vi.fn<LeaderHooks['start']>(extra.start),
    stop: vi.fn<LeaderHooks['stop']>(extra.stop),
    succeed: vi.fn<NonNullable<LeaderHooks['succeed']>>(),
    superseded: vi.fn<NonNullable<LeaderHooks['superseded']>>(),
});

it('elects one leader and hands over gracefully, leaving per-run leases alone', async () => {
    const f = fixture();
    const run = f.ao.claim('turn', 'live-turn', 'thread:live', (x) => x);
    const ha = hooks(),
        hb = hooks();
    const a = new LeaderLease(f.ao, 'leader', ha),
        b = new LeaderLease(f.bo, 'leader', hb);
    cleanup.push(
        () => b.stop(),
        () => a.stop(),
    );
    await a.start();
    await b.start();
    expect(a.state).toBe('leader');
    expect(a.current()).toBe(true);
    expect(b.state).toBe('follower');
    expect(b.current()).toBe(false);
    expect(ha.start).toHaveBeenCalledOnce();
    expect(hb.start).not.toHaveBeenCalled();
    await a.stop();
    expect(ha.stop).toHaveBeenCalledOnce();
    expect(a.state).toBe('stopped');
    // The drained leader's turn keeps its own lease.
    expect(f.ao.owns(run)).toBe(true);
    await b.check();
    expect(b.state).toBe('leader');
    expect(hb.start).toHaveBeenCalledOnce();
    expect(f.epoch()).toBe(2);
    // Stopping twice is one stop.
    await a.stop();
    expect(ha.stop).toHaveBeenCalledOnce();
});

it('runs the successor recovery only once no other runtime is alive', async () => {
    const f = fixture();
    const ha = hooks(),
        hb = hooks();
    const a = new LeaderLease(f.ao, 'leader', ha),
        b = new LeaderLease(f.bo, 'leader', hb);
    cleanup.push(
        () => b.stop(),
        () => a.stop(),
    );
    await a.start();
    // b's runtime is alive: a leads, but recovers nothing of b's.
    expect(ha.succeed).not.toHaveBeenCalled();
    await b.start();
    // The deploy: a drains and hands over; b leads while a still finishes.
    await a.stop();
    await b.check();
    expect(b.state).toBe('leader');
    expect(hb.succeed).not.toHaveBeenCalled();
    await b.check();
    expect(hb.succeed).not.toHaveBeenCalled();
    // a's task exits (its runtime is released): now b recovers, once.
    f.ar.detachSync(f.a);
    await b.check();
    await b.check();
    expect(hb.succeed).toHaveBeenCalledOnce();
});

it('waits for a crashed runtime to expire before recovering after it', async () => {
    const f = fixture();
    const hb = hooks();
    const b = new LeaderLease(f.bo, 'leader', hb);
    cleanup.push(() => b.stop());
    // a's runtime registered (fixture) and never heartbeats again: a crash.
    await b.start();
    expect(b.state).toBe('leader');
    expect(hb.succeed).not.toHaveBeenCalled();
    f.expire();
    await b.check();
    expect(b.state).toBe('leader');
    expect(hb.succeed).toHaveBeenCalledOnce();
});

it('keeps leading after a lapse when no one led in between', async () => {
    const f = fixture();
    const ha = hooks();
    const a = new LeaderLease(f.ao, 'leader', ha);
    cleanup.push(() => a.stop());
    await a.start();
    expect(a.epoch).toBe(1);
    // A stall past the lease (no heartbeat), with nobody else campaigning.
    f.expire();
    expect(a.current()).toBe(false);
    await a.check();
    expect(a.state).toBe('leader');
    expect(a.epoch).toBe(2);
    expect(a.current()).toBe(true);
    // Its work was never stopped or restarted.
    expect(ha.stop).not.toHaveBeenCalled();
    expect(ha.start).toHaveBeenCalledOnce();
    const authority = ha.start.mock.calls[0]![0] as LeaderAuthority;
    expect(authority.signal.aborted).toBe(false);
    expect(authority.current()).toBe(true);
});

it('stops for good, and asks for a restart, when another runtime led during its stall', async () => {
    const f = fixture();
    const ha = hooks(),
        hb = hooks();
    const a = new LeaderLease(f.ao, 'leader', ha),
        b = new LeaderLease(f.bo, 'leader', hb);
    cleanup.push(
        () => b.stop(),
        () => a.stop(),
    );
    await a.start();
    const authority = ha.start.mock.calls[0]![0] as LeaderAuthority;
    await b.start();
    f.expire();
    // b takes over while a is frozen.
    await b.check();
    expect(b.state).toBe('leader');
    expect(b.epoch).toBe(2);
    // a wakes up: its writes are fenced, its work stops, it won't lead again.
    expect(authority.current()).toBe(false);
    await a.check();
    expect(a.state).toBe('superseded');
    expect(authority.signal.aborted).toBe(true);
    expect(ha.stop).toHaveBeenCalledOnce();
    expect(ha.superseded).toHaveBeenCalledOnce();
    await a.check();
    await a.stop();
    expect(ha.stop).toHaveBeenCalledOnce();
    // b was never disturbed.
    expect(b.current()).toBe(true);
    expect(f.epoch()).toBe(2);
});

it('supersedes a lapsed leader even when its successor already handed back', async () => {
    const f = fixture();
    const ha = hooks(),
        hb = hooks();
    const a = new LeaderLease(f.ao, 'leader', ha),
        b = new LeaderLease(f.bo, 'leader', hb);
    cleanup.push(
        () => b.stop(),
        () => a.stop(),
    );
    await a.start();
    await b.start();
    f.expire();
    await b.check();
    await b.stop();
    // Epoch 3 would be a's, but epoch 2 was b's: two leaders' effects may
    // have overlapped, so a must not carry on as if nothing happened.
    await a.check();
    expect(a.state).toBe('superseded');
    expect(ha.superseded).toHaveBeenCalledOnce();
    expect(
        f.a
            .prepare("SELECT releasedAt IS NOT NULL AS released FROM runtime_leases WHERE resource='singleton:leader'")
            .get()?.released,
    ).toBe(1);
});

it('does not release the lease until the old leader acknowledges stop', async () => {
    const f = fixture();
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const a = new LeaderLease(f.ao, 'leader', hooks({ stop: () => blocked })),
        b = new LeaderLease(f.bo, 'leader', hooks());
    cleanup.push(
        () => b.stop(),
        () => a.stop(),
    );
    await a.start();
    await b.start();
    const stopped = a.stop();
    expect(a.current()).toBe(false);
    await b.check();
    expect(b.state).toBe('follower');
    release();
    await stopped;
    await b.check();
    expect(b.state).toBe('leader');
});

it('a stop while the lease is being claimed starts nothing and releases it', async () => {
    const f = fixture();
    const ha = hooks();
    const a = new LeaderLease(f.ao, 'leader', ha);
    const starting = a.start();
    const stopped = a.stop();
    await starting;
    await stopped;
    expect(ha.start).not.toHaveBeenCalled();
    expect(ha.stop).not.toHaveBeenCalled();
    expect(a.state).toBe('stopped');
    expect(f.ao.claimSingleton('leader')?.epoch).toBe(2);
});

it('a stop during the leader start still stops what it started', async () => {
    const f = fixture();
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const ha = hooks({ start: () => blocked });
    const a = new LeaderLease(f.ao, 'leader', ha);
    const starting = a.start();
    await vi.waitFor(() => expect(ha.start).toHaveBeenCalledOnce());
    const stopped = a.stop();
    release();
    await starting;
    await stopped;
    expect(ha.stop).toHaveBeenCalledOnce();
    expect(a.state).toBe('stopped');
    expect(f.ao.claimSingleton('leader')?.epoch).toBe(2);
});

it('rechecks scheduler admission after waiting for the writer, without expiring tasks or claiming new ones', async () => {
    const f = fixture(),
        store = new Store(f.a);
    const task = await store.createTask('No stale claim', null, 'owner');
    let admitted = true,
        release!: () => void,
        entered!: () => void;
    const began = new Promise<void>((r) => (entered = r)),
        blocked = new Promise<void>((r) => (release = r));
    const held = sqliteData(f.a).uow.run(
        async () => {
            entered();
            await blocked;
        },
        { label: 'held admission writer' },
    );
    await began;
    const claimed = store.claim(Date.now(), () => admitted);
    admitted = false;
    release();
    await held;
    expect(await claimed).toBe(null);
    expect((await store.task(task.id))?.status).toBe('queued');
});

it('scheduler handover stops new claims while an already-claimed task finishes normally', async () => {
    const f = fixture(),
        one = new Store(f.a),
        two = new Store(f.b);
    await one.createTask('One', null, 'owner');
    await one.createTask('Two', null, 'owner');
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r)),
        seen: string[] = [];
    const leaders: { a?: LeaderLease; b?: LeaderLease } = {};
    const result = (text: string) => ({ text, sources: [], sample: false });
    const ra = new Runner(
        one,
        { mode: 'sample', baseUrl: '' },
        async (claim) => {
            seen.push(claim.id);
            await blocked;
            return result('finished');
        },
        90000,
        () => !!leaders.a?.current(),
    );
    const rb = new Runner(
        two,
        { mode: 'sample', baseUrl: '' },
        async (claim) => {
            seen.push(claim.id);
            return result('second');
        },
        90000,
        () => !!leaders.b?.current(),
    );
    const a = (leaders.a = new LeaderLease(f.ao, 'leader', {
        start: () => ra.start(),
        stop: () => ra.drain(),
    }));
    const b = (leaders.b = new LeaderLease(f.bo, 'leader', {
        start: () => rb.start(),
        stop: () => rb.drain(),
    }));
    cleanup.push(
        () => {
            ra.stop();
            rb.stop();
        },
        () => b.stop(),
        () => a.stop(),
    );
    await a.start();
    await b.start();
    await vi.waitFor(() => expect(ra.running).toBe(1));
    expect(seen).toHaveLength(1);
    await a.stop();
    await b.check();
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    release();
    await vi.waitFor(() => expect(ra.running).toBe(0));
    expect(new Set(seen).size).toBe(2);
    const tasks = await one.tasks('owner');
    expect(tasks.map((task) => task.status)).toEqual(['completed', 'completed']);
});

it('a draining task hands the leader work over at once and still finishes its own turn', async () => {
    const f = fixture();
    const turn = f.ao.claim('turn', 'draining-turn', 'thread:t', (x) => x);
    const ha = hooks(),
        hb = hooks();
    const a = new LeaderLease(f.ao, 'leader', ha),
        b = new LeaderLease(f.bo, 'leader', hb);
    cleanup.push(
        () => b.stop(),
        () => a.stop(),
    );
    await a.start();
    await b.start();
    let busy = 1;
    const exited = vi.fn();
    const shutdown = createShutdown({
        drain: () => void a.stop(),
        inProgress: () => busy,
        drainMs: 5000,
        pollMs: 5,
        stopRunner: () => undefined,
        stopPlatform: () => a.stop(),
        closeServer: async () => undefined,
        exit: exited,
        report: () => undefined,
    });
    const done = shutdown();
    // The next task leads within its next check, while the turn still runs.
    await vi.waitFor(async () => {
        await b.check();
        expect(b.state).toBe('leader');
    });
    expect(ha.stop).toHaveBeenCalledOnce();
    expect(hb.start).toHaveBeenCalledOnce();
    expect(exited).not.toHaveBeenCalled();
    expect(f.ao.owns(turn)).toBe(true);
    // The turn ends; the old task exits cleanly.
    f.ao.release(turn);
    busy = 0;
    await done;
    expect(exited).toHaveBeenCalledWith(0);
});
