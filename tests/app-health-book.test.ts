import { DatabaseSync } from 'node:sqlite';

import { expect, it, vi } from 'vitest';

import { sqliteData } from '@socio/data/open';

import {
    AppHealthBook,
    RECOVERY_ATTEMPTS,
    RECOVERY_STABLE_MS,
    REPAIR_LEASE_MS,
    type RepairClaim,
} from '../src/server/apps/health.js';
import { appsSchema } from '../src/server/apps/migrations.js';

// CB-291: the book's bounds, apart from any process. Two books on one
// database stand for two runtimes sharing it.

const book = (db = new DatabaseSync(':memory:'), notices: unknown[] = []) => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='app_health'").get()) {
        db.exec(appsSchema.migrations!.find((migration) => migration.name === 'app health')!.up as string);
    }
    return {
        db,
        notices,
        health: new AppHealthBook(db, {
            name: () => 'Tracker',
            notifyAdmins: () => async (notice) => void notices.push(notice),
        }),
    };
};
const H = 60 * 60_000;

/** Each book's newest claim per app, as the repair that began it would hold it. */
const held = new Map<AppHealthBook, Map<string, RepairClaim>>();
const begin = async (health: AppHealthBook, appId: string, episode: string, reason: string, now?: number) => {
    const claim = await health.begin(appId, episode, reason, now);
    if (claim) {
        held.set(health, (held.get(health) ?? new Map()).set(appId, claim));
    }
    return claim?.attempt ?? 0;
};
const claimOf = (health: AppHealthBook, appId: string) => held.get(health)!.get(appId)!;
const failed = (health: AppHealthBook, appId: string, error: string, now?: number) =>
    health.failed(claimOf(health, appId), error, now);
const succeeded = (health: AppHealthBook, appId: string, what: string, now?: number) =>
    health.succeeded(claimOf(health, appId), what, now);
const claimed = (health: AppHealthBook, appId: string) => health.stillClaimed(claimOf(health, appId));

it('two runtimes on one database share it: one claims each repair, one budget, one notice', async () => {
    const a = book();
    const b = book(a.db, a.notices);
    let now = 1_000_000;
    await a.health.rememberToken('x', 'cbd_one');
    // A token one runtime issued names the app on the other.
    expect(b.health.appOfToken('cbd_one')).toBe('x');
    expect(await begin(a.health, 'x', 'v1', 'not answering', now)).toBe(1);
    expect(b.health.get('x')).toMatchObject({ state: 'recovering', attempts: 1 });
    expect(await begin(b.health, 'x', 'v1', 'not answering', now)).toBe(0);
    await failed(a.health, 'x', 'still not answering', now);
    // Alternating runtimes still count one budget.
    for (let i = 2; i <= RECOVERY_ATTEMPTS; i++) {
        now += H;
        const runtime = i % 2 ? a : b;
        expect(await begin(runtime.health, 'x', 'v1', 'not answering', now)).toBe(i);
        await failed(runtime.health, 'x', 'still not answering', now);
    }
    expect(a.health.get('x')).toMatchObject({ state: 'failed', attempts: RECOVERY_ATTEMPTS });
    expect(await begin(a.health, 'x', 'v1', 'again', now + H)).toBe(0);
    expect(await begin(b.health, 'x', 'v1', 'again', now + H)).toBe(0);
    expect(a.notices).toHaveLength(1);
});

it('changes queued behind an open unit of work land in order, on the row as it is then', async () => {
    const a = book();
    const b = book(a.db, a.notices);
    const busy = vi.spyOn(sqliteData(a.db).uow, 'writable', 'get').mockReturnValue(false);
    const first = a.health.tokenRepairStarted('x', 'its data token was refused');
    const second = a.health.rememberToken('x', 'cbd_second');
    // Another runtime writes the row meanwhile (its own connection).
    a.db
        .prepare(
            "INSERT INTO app_health(appId, state, reason, tokenHashes, updatedAt) VALUES ('x', 'degraded', 'runtime away', '[]', 1)",
        )
        .run();
    busy.mockRestore();
    await Promise.all([first, second]);
    expect(b.health.appOfToken('cbd_second')).toBe('x');
    expect(b.health.tokenRepairPending('x')).toBe(true);
    expect(b.health.get('x')).toMatchObject({ state: 'degraded', reason: 'runtime away' });
});

it('measures stability from the current process’s start, not the repair', async () => {
    const { health } = book();
    const t0 = 1_000_000;
    await begin(health, 'a', 'v1', 'kept crashing', t0);
    await succeeded(health, 'a', 'started again', t0);
    // It crashed at minute nine and the runtime started it again.
    const restartedAt = t0 + 9 * 60_000;
    expect(await health.settle('a', restartedAt, t0 + RECOVERY_STABLE_MS)).toBe(false);
    expect(health.get('a')).toMatchObject({ state: 'recovering', attempts: 1 });
    expect(await health.settle('a', restartedAt, restartedAt + RECOVERY_STABLE_MS)).toBe(true);
    expect(health.get('a')).toMatchObject({ state: 'healthy', attempts: 0 });
    expect(await health.settle('a', null, t0 + 10 * RECOVERY_STABLE_MS)).toBe(false);
});

it('an app whose repair timed out but came up anyway is healthy after ten minutes up', async () => {
    const { health } = book();
    const t0 = 1_000_000;
    await begin(health, 'a', 'v1', 'not answering', t0);
    await failed(health, 'a', 'didn’t answer within 30 s', t0);
    expect(health.get('a')).toMatchObject({ state: 'degraded', attempts: 1 });
    const up = t0 + 40_000;
    expect(await health.settle('a', up, up + RECOVERY_STABLE_MS - 1)).toBe(false);
    expect(await health.settle('a', up, up + RECOVERY_STABLE_MS)).toBe(true);
    expect(health.get('a')).toMatchObject({ state: 'healthy', attempts: 0, lastError: null });
});

it('a renewal that held never clears repairs in progress or a terminal failure', async () => {
    const { health, notices } = book();
    let now = 1_000_000;
    for (let i = 0; i < RECOVERY_ATTEMPTS; i++) {
        expect(await begin(health, 'a', 'v1', 'not answering', now)).toBe(i + 1);
        await failed(health, 'a', 'still not answering', now);
        now += H;
    }
    expect(health.get('a')).toMatchObject({ state: 'failed', attempts: RECOVERY_ATTEMPTS });
    expect(notices).toHaveLength(1);
    await health.recovering('a', 'token refused');
    expect(await health.renewalHeld('a', 'renewed')).toBe(false);
    expect(health.get('a')).toMatchObject({ state: 'failed', attempts: RECOVERY_ATTEMPTS });
    await begin(health, 'b', 'v1', 'not answering', now);
    expect(await health.renewalHeld('b', 'renewed')).toBe(false);
    expect(health.get('b')).toMatchObject({ state: 'recovering', attempts: 1 });
    await health.recovering('c', 'token refused');
    expect(await health.renewalHeld('c', 'renewed')).toBe(true);
    expect(health.get('c')).toMatchObject({ state: 'healthy', lastRecoveryReason: 'renewed' });
});

it('holds a running repair’s claim past its backoff; only that claim ends it', async () => {
    vi.useFakeTimers();
    try {
        const a = book();
        const b = book(a.db, a.notices);
        const t0 = Date.now();
        expect(await begin(a.health, 'x', 'v1', 'deploying', t0)).toBe(1);
        // A deploy that runs for 25 minutes keeps its lease (renewed each minute).
        await vi.advanceTimersByTimeAsync(25 * 60_000);
        expect(await begin(b.health, 'x', 'v1', 'again', Date.now())).toBe(0);
        // A new version doesn't jump it either.
        expect(await begin(b.health, 'x', 'v2', 'new version', Date.now())).toBe(0);
        await succeeded(a.health, 'x', 'started again');
        expect(b.health.get('x')).toMatchObject({ state: 'recovering', attempts: 1 });
        // A runtime that dies mid-repair stops renewing; b takes over after
        // the lease lapses, and the old claim's late outcome writes nothing.
        const later = Date.now() + 2 * H;
        expect(await begin(a.health, 'x', 'v1', 'deploying', later)).toBe(2);
        (a.health as unknown as { renewals: Map<string, ReturnType<typeof setInterval>> }).renewals.forEach((timer) =>
            clearInterval(timer),
        );
        expect(await begin(b.health, 'x', 'v1', 'took over', later + REPAIR_LEASE_MS - 1)).toBe(0);
        expect(await begin(b.health, 'x', 'v1', 'took over', later + REPAIR_LEASE_MS)).toBe(3);
        await failed(a.health, 'x', 'late failure');
        expect(b.health.get('x')).toMatchObject({ state: 'recovering', attempts: 3, lastError: null });
        await succeeded(b.health, 'x', 'took over and started it');
        expect(b.health.get('x')).toMatchObject({ lastRecoveryReason: 'took over and started it' });
    } finally {
        vi.useRealTimers();
    }
});

it('a reset when a registration or version is saved ends a running repair without effect', async () => {
    const { health } = book();
    expect(await begin(health, 'x', 'dev:3000', 'not answering', 1_000)).toBe(1);
    await health.reset('x');
    expect(health.get('x')).toMatchObject({ state: 'healthy', attempts: 0 });
    await failed(health, 'x', 'late failure');
    expect(health.get('x')).toMatchObject({ state: 'healthy', attempts: 0, lastError: null });
});

it('a repair whose lease was lost while it paused writes nothing when it finishes', async () => {
    vi.useFakeTimers();
    try {
        const a = book();
        const b = book(a.db, a.notices);
        const t0 = Date.now();
        expect(await begin(a.health, 'x', 'v1', 'deploying', t0)).toBe(1);
        // a pauses past its lease; b takes over; then a's renewal runs.
        expect(await begin(b.health, 'x', 'v1', 'took over', t0 + REPAIR_LEASE_MS + 1)).toBe(2);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(claimed(a.health, 'x')).toBe(false);
        expect(claimed(b.health, 'x')).toBe(true);
        await succeeded(a.health, 'x', 'late success');
        await failed(a.health, 'x', 'late failure');
        expect(b.health.get('x')).toMatchObject({ state: 'recovering', attempts: 2, lastError: null });
        expect(claimed(b.health, 'x')).toBe(true);
    } finally {
        vi.useRealTimers();
    }
});

it('the last failure and giving up are one transaction: a reset in between is never undone', async () => {
    const a = book();
    const b = book(a.db, a.notices);
    let now = 1_000_000;
    for (let i = 1; i < RECOVERY_ATTEMPTS; i++) {
        expect(await begin(a.health, 'x', 'v1', 'not answering', now)).toBe(i);
        await failed(a.health, 'x', 'still not answering', now);
        now += H;
    }
    // a runs the last repair; meanwhile the owner's Start resets the app on b,
    // and b starts a fresh repair.
    expect(await begin(a.health, 'x', 'v1', 'not answering', now)).toBe(RECOVERY_ATTEMPTS);
    await b.health.reset('x');
    expect(await begin(b.health, 'x', 'v1', 'after Start', now)).toBe(1);
    // a's last repair fails: it gives up nothing, cancels nothing.
    await failed(a.health, 'x', 'late failure', now);
    expect(b.health.get('x')).toMatchObject({ state: 'recovering', attempts: 1, escalatedAt: null });
    expect(claimed(b.health, 'x')).toBe(true);
    expect(a.notices).toEqual([]);
    // Ran out after a repair that held: the next begin gives up in its own transaction, once.
    const c = book();
    for (let i = 1; i <= RECOVERY_ATTEMPTS; i++) {
        expect(await begin(c.health, 'y', 'v1', 'kept crashing', now)).toBe(i);
        await succeeded(c.health, 'y', 'started again', now);
        now += H;
    }
    expect(await begin(c.health, 'y', 'v1', 'kept crashing', now)).toBe(0);
    expect(c.health.get('y')).toMatchObject({ state: 'failed', attempts: RECOVERY_ATTEMPTS });
    expect(await begin(c.health, 'y', 'v1', 'kept crashing', now + H)).toBe(0);
    expect(c.notices).toHaveLength(1);
});

it('one runtime: begin, reset, begin again: the first repair’s late outcome touches nothing', async () => {
    const { health } = book();
    const first = (await health.begin('x', 'v1', 'not answering', 1_000))!;
    await health.reset('x');
    const second = (await health.begin('x', 'v1', 'after Start', 2_000))!;
    expect(second.attempt).toBe(1);
    // The first repair checks before acting: it no longer may.
    expect(health.stillClaimed(first)).toBe(false);
    expect(health.stillClaimed(second)).toBe(true);
    await health.failed(first, 'late failure');
    await health.succeeded(first, 'late success');
    await health.abandon(first);
    expect(health.get('x')).toMatchObject({ state: 'recovering', attempts: 1, lastError: null, lastRecoveryAt: null });
    expect(health.stillClaimed(second)).toBe(true);
    // The second ends as itself.
    await health.failed(second, 'still not answering');
    expect(health.get('x')).toMatchObject({ state: 'degraded', attempts: 1, lastError: 'still not answering' });
});
