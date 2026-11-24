import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { openDatabase } from '@socio/data/open';
import { RuntimeSession } from '@socio/data/runtime-ownership';
import { CODING_LIMITS, CODING_LIMIT_KEYS, type CodingLimits } from '@socio/shared/coding/coding-gateway';

import {
    codingLimitDefaults,
    codingLimitsInForce,
    SessionRate,
    STALE_RESERVATION_MS,
    WINDOW_MS,
} from '../src/server/gateway/limits.js';
import { gatewayModule } from '../src/server/gateway/module.js';
import { gatewaySchema } from '../src/server/gateway/schema.js';
import { GatewayLedger } from '../src/server/gateway/usage.js';

import { testDatabaseFile } from './helpers/test-database.js';

// CB-239: budgets and in-flight caps as reservation rows, across two
// runtimes on one database.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const defaults = (): CodingLimits =>
    Object.fromEntries(CODING_LIMIT_KEYS.map((key) => [key, CODING_LIMITS[key].default])) as CodingLimits;

function twoRuntimes() {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-ledger-'));
    const path = testDatabaseFile(join(dir, 'app.sqlite'));
    const clock = { now: 10_000_000_000 };
    const runtime = () => {
        const db = openDatabase(path);
        const session = new RuntimeSession({
            heartbeat: false,
            leaseMs: 30_000,
            now: () => clock.now,
        });
        const ledger = new GatewayLedger(db, {
            ownership: session.attach(db),
            now: () => clock.now,
        });
        return { db, session, ledger };
    };
    const a = runtime();
    const b = runtime();
    cleanup.push(async () => {
        for (const r of [a, b]) {
            if (r.db.isOpen) {
                await r.session.detach(r.db).catch(() => undefined);
                r.db.close();
            }
        }
        rmSync(dir, { recursive: true, force: true });
    });
    return { a, b, clock };
}

const request = (overrides: Partial<Parameters<GatewayLedger['reserve']>[0]> = {}) => ({
    sessionId: 's1',
    personId: 'alice',
    socioId: 'rulo',
    grantId: 'g1',
    modelId: 'orion',
    backendId: 'b1',
    promptTokens: 100,
    maxOutputTokens: 1_000,
    limits: { ...defaults(), inFlightPerSession: 16, inFlightPerPerson: 64 },
    ...overrides,
});

it('has no instance-wide token budget, only session, person and socio ones', () => {
    expect(CODING_LIMIT_KEYS.filter((key) => key.endsWith('Tokens'))).toEqual([
        'sessionTokens',
        'personDailyTokens',
        'socioDailyTokens',
    ]);
    expect(CODING_LIMIT_KEYS.some((key) => /instance.*tokens/i.test(key))).toBe(false);
    expect(defaults()).toMatchObject({
        sessionTokens: 2_000_000,
        personDailyTokens: 5_000_000,
        socioDailyTokens: 10_000_000,
        sessionsPerPerson: 2,
        sessionsPerSocio: 4,
        sessionsPerInstance: 8,
        requestsPerMinute: 60,
        inFlightPerSession: 2,
        inFlightPerPerson: 4,
    });
});

it('reads env defaults strictly and keeps only valid saved values', () => {
    expect(codingLimitDefaults({ CODING_SESSION_TOKENS: '3000000' }).sessionTokens).toBe(3_000_000);
    expect(() => codingLimitDefaults({ CODING_SESSION_TOKENS: 'lots' })).toThrow(/CODING_SESSION_TOKENS/);
    expect(() => codingLimitDefaults({ CODING_GATEWAY_IN_FLIGHT_PER_SESSION: '0' })).toThrow();
    expect(codingLimitsInForce({ sessionTokens: 5_000, requestsPerMinute: 0, nope: 1 }, defaults())).toMatchObject({
        sessionTokens: 5_000,
        requestsPerMinute: 60,
    });
});

it('admits exactly one of many concurrent reservations across two runtimes when the budget fits one', async () => {
    const { a, b } = twoRuntimes();
    const limits = { ...request().limits, sessionTokens: 1_150 };
    const results = await Promise.all(
        Array.from({ length: 10 }, (_, n) => (n % 2 ? a : b).ledger.reserve(request({ limits }))),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok).map((result) => !result.ok && result.refusal)).toEqual(
        Array(9).fill('session_budget'),
    );
});

it('counts in-flight caps from rows, so they hold across runtimes', async () => {
    const { a, b } = twoRuntimes();
    const limits = { ...defaults() };
    expect((await a.ledger.reserve(request({ limits }))).ok).toBe(true);
    expect((await b.ledger.reserve(request({ limits }))).ok).toBe(true);
    expect(await a.ledger.reserve(request({ limits }))).toEqual({
        ok: false,
        refusal: 'session_busy',
    });
    // The person's cap counts their other sessions too.
    expect((await b.ledger.reserve(request({ limits, sessionId: 's2' }))).ok).toBe(true);
    expect((await a.ledger.reserve(request({ limits, sessionId: 's2' }))).ok).toBe(true);
    expect(await a.ledger.reserve(request({ limits, sessionId: 's3' }))).toEqual({
        ok: false,
        refusal: 'person_busy',
    });
    const instance = { ...limits, inFlightPerInstance: 4 };
    expect(await b.ledger.reserve(request({ limits: instance, personId: 'bob', sessionId: 's9' }))).toEqual({
        ok: false,
        refusal: 'instance_busy',
    });
});

it('clamps the completion to the model, the request and every budget left', async () => {
    const { a } = twoRuntimes();
    const limits = { ...request().limits, personDailyTokens: 600 };
    const first = await a.ledger.reserve(request({ limits, requestedCompletion: 5_000 }));
    expect(first.ok && first.maxCompletionTokens).toBe(500);
    const second = await a.ledger.reserve(request({ limits, promptTokens: 1 }));
    expect(second).toEqual({ ok: false, refusal: 'person_budget' });
    const small = await a.ledger.reserve(
        request({
            limits: request().limits,
            requestedCompletion: 10,
            personId: 'bob',
        }),
    );
    expect(small.ok && small.maxCompletionTokens).toBe(10);
});

it('settles to real usage, once; budgets are rolling 24-hour windows', async () => {
    const { a, clock } = twoRuntimes();
    const limits = { ...request().limits, socioDailyTokens: 2_000 };
    const first = await a.ledger.reserve(request({ limits }));
    if (!first.ok) {
        throw new Error('refused');
    }
    expect(
        await a.ledger.settle(first.reservation, {
            promptTokens: 90,
            completionTokens: 900,
            estimated: false,
            latencyMs: 5,
            status: 'ok',
        }),
    ).toBe(true);
    // Settling again changes nothing.
    expect(
        await a.ledger.settle(first.reservation, {
            promptTokens: 1,
            completionTokens: 1,
            estimated: false,
            latencyMs: 5,
            status: 'ok',
        }),
    ).toBe(false);
    // 990 used by the socio in the last day: 1 010 left, 100 of it the prompt.
    const second = await a.ledger.reserve(request({ limits, sessionId: 's2' }));
    expect(second.ok && second.maxCompletionTokens).toBe(910);
    if (second.ok) {
        await a.ledger.settle(second.reservation, {
            promptTokens: 100,
            completionTokens: 910,
            estimated: false,
            latencyMs: 5,
            status: 'ok',
        });
    }
    expect(await a.ledger.reserve(request({ limits, sessionId: 's3' }))).toEqual({
        ok: false,
        refusal: 'socio_budget',
    });
    // A day after the first request, it no longer counts.
    clock.now += WINDOW_MS - 1;
    expect((await a.ledger.reserve(request({ limits, sessionId: 's3' }))).ok).toBe(false);
    clock.now += 2;
    // The session budget is not a window: session s1 still counts its 990.
    expect((await a.ledger.reserve(request({ limits, sessionId: 's3' }))).ok).toBe(true);
    expect(a.ledger.session('s1', limits).used).toBe(990);
});

it('settles a dead runtime’s reservations at their estimate and frees their slots', async () => {
    const { a, b, clock } = twoRuntimes();
    const limits = { ...defaults() };
    const held = await a.ledger.reserve(request({ limits }));
    expect(held.ok).toBe(true);
    await a.ledger.reserve(request({ limits }));
    expect(await b.ledger.reserve(request({ limits }))).toEqual({
        ok: false,
        refusal: 'session_busy',
    });
    // A is alive: its sweep on B settles nothing.
    expect(await b.ledger.settleOrphans()).toBe(0);
    // A dies: its lease runs out.
    clock.now += 31_000;
    await b.session.attach(b.db).heartbeat();
    const after = await b.ledger.reserve(request({ limits }));
    expect(after.ok).toBe(true);
    const rows = b.db.prepare('SELECT status, estimated, promptTokens, completionTokens FROM gateway_usage').all();
    expect(rows).toEqual([
        {
            status: 'orphaned',
            estimated: 1,
            promptTokens: 100,
            completionTokens: 1_000,
        },
        {
            status: 'orphaned',
            estimated: 1,
            promptTokens: 100,
            completionTokens: 1_000,
        },
    ]);
    // A's late settle of a reservation already settled does nothing.
    if (held.ok) {
        expect(
            await a.ledger.settle(held.reservation, {
                promptTokens: 1,
                completionTokens: 1,
                estimated: false,
                latencyMs: 1,
                status: 'ok',
            }),
        ).toBe(false);
    }
});

it('settles a live runtime’s reservation past the upstream limit at its estimate, freeing its slot', async () => {
    const { a, b, clock } = twoRuntimes();
    const limits = { ...defaults(), inFlightPerSession: 1 };
    // A's request ended but its settle failed (a busy database): the
    // reservation stays, on a runtime that is still alive.
    const stuck = await a.ledger.reserve(request({ limits }));
    expect(stuck.ok).toBe(true);
    const live = async (ms: number) => {
        for (let at = 0; at < ms; at += 20_000) {
            clock.now += 20_000;
            await a.session.attach(a.db).heartbeat();
            await b.session.attach(b.db).heartbeat();
        }
    };
    // Within the upstream limit and its margin: still held.
    await live(STALE_RESERVATION_MS - 20_000);
    expect(await b.ledger.settleOrphans()).toBe(0);
    expect(await b.ledger.reserve(request({ limits }))).toEqual({
        ok: false,
        refusal: 'session_busy',
    });
    // Past it: settled at its estimate, though A is alive.
    await live(40_000);
    expect(await b.ledger.settleOrphans()).toBe(1);
    expect(b.db.prepare('SELECT status, estimated, promptTokens, completionTokens FROM gateway_usage').all()).toEqual([
        {
            status: 'stale',
            estimated: 1,
            promptTokens: 100,
            completionTokens: 1_000,
        },
    ]);
    expect((await b.ledger.reserve(request({ limits }))).ok).toBe(true);
    // A's settle, should it succeed late, changes nothing.
    if (stuck.ok) {
        expect(
            await a.ledger.settle(stuck.reservation, {
                promptTokens: 1,
                completionTokens: 1,
                estimated: false,
                latencyMs: 1,
                status: 'ok',
            }),
        ).toBe(false);
    }
});

it('notes dropped field names, bounded, never values', async () => {
    const { a } = twoRuntimes();
    a.ledger.noteDropped('s1', ['user', 'metadata']);
    a.ledger.noteDropped('s1', ['user']);
    a.ledger.noteDropped(
        's1',
        Array.from({ length: 80 }, (_, n) => `f${n}`),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const dropped = a.ledger.session('s1', defaults()).dropped;
    expect(dropped[0]).toEqual({ field: 'user', count: 2 });
    expect(Number(a.db.prepare('SELECT COUNT(*) AS n FROM gateway_dropped_fields').get()?.n)).toBe(50);
});

it('counts requests a minute per session on this runtime', () => {
    let now = 0;
    const rate = new SessionRate(() => now);
    for (let n = 0; n < 3; n++) {
        expect(rate.take('s1', 3)).toBe(true);
    }
    expect(rate.take('s1', 3)).toBe(false);
    expect(rate.take('s2', 3)).toBe(true);
    now += 60_000;
    expect(rate.take('s1', 3)).toBe(true);
});

it('is an expand-only migration with no hard rules on old data', () => {
    // The module carries it, so boot and the auth CLI know the tables.
    expect(gatewayModule.migrations).toEqual(gatewaySchema.migrations);
    for (const migration of gatewaySchema.migrations!) {
        expect(migration.phase ?? 'expand').toBe('expand');
        expect(migration.up).not.toMatch(/\b(DROP|RENAME|DELETE FROM|UNIQUE|RAISE)\b/i);
        expect(migration.up).not.toMatch(/prompt TEXT|completion TEXT|content|messages/i);
    }
});
