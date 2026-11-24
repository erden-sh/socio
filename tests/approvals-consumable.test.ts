import type { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import { ApprovalError } from '../src/server/approvals/contract.js';
import { sqliteApprovals } from '../src/server/approvals/services.js';

import { testDatabase } from './helpers/test-database.js';

// CB-232 in the approvals module: a
// per-capability expiry, consumable requests bound to a digest and a
// binding and used once, `alwaysAsk`, caps counted in the inserting unit,
// details that must be opened before approving, and `onDecision`
// committing with the decision.

const dbs: DatabaseSync[] = [];
afterEach(() => {
    vi.useRealTimers();
    for (const db of dbs.splice(0)) {
        db.close();
    }
});

function service() {
    const db = testDatabase();
    dbs.push(db);
    const approvals = sqliteApprovals(db);
    return { db, approvals };
}

const base = { label: 'Test', description: 'A test capability.' };
const binding = { digest: 'd1', bindingId: 'grant-1' };

it('refuses a consumable capability with execute, and any other without', () => {
    const { approvals } = service();
    expect(() =>
        approvals.register({
            ...base,
            capability: 'x.both',
            consumable: true,
            execute: () => 'ran',
        }),
    ).toThrow(/needs execute, or is consumable/);
    expect(() => approvals.register({ ...base, capability: 'x.neither' })).toThrow(/needs execute, or is consumable/);
});

it('requires a binding for consumable requests and refuses one for others', async () => {
    const { approvals } = service();
    approvals.register({ ...base, capability: 'x.use', consumable: true });
    approvals.register({ ...base, capability: 'x.run', execute: () => 'ran' });
    const input = { userId: 'alice', dotId: 'dot', summary: 'S', payload: {} };
    await expect(approvals.request({ ...input, capability: 'x.use' })).rejects.toThrow(/needs binding/);
    await expect(approvals.request({ ...input, capability: 'x.run', binding })).rejects.toThrow(/takes no binding/);
});

it('expires each capability’s requests after its own ttl, others after 7 days', async () => {
    const { approvals } = service();
    approvals.register({
        ...base,
        capability: 'x.short',
        ttlMs: 15 * 60_000,
        execute: () => 'ran',
    });
    approvals.register({ ...base, capability: 'x.long', execute: () => 'ran' });
    const input = { userId: 'alice', dotId: 'dot', summary: 'S', payload: {} };
    const short = await approvals.request({ ...input, capability: 'x.short' });
    const long = await approvals.request({ ...input, capability: 'x.long' });
    const view = async (id: string) => approvals.get(id, 'alice');
    expect((await view(short.id)).expiresAt - (await view(short.id)).createdAt).toBe(15 * 60_000);
    expect((await view(long.id)).expiresAt - (await view(long.id)).createdAt).toBe(7 * 86_400_000);
    expect(await approvals.expire(Date.now() + 15 * 60_000 + 1)).toBe(1);
    expect((await view(short.id)).status).toBe('expired');
    expect((await view(long.id)).status).toBe('pending');
});

it('alwaysAsk shows the card whatever the person’s bypass or auto says', async () => {
    const { approvals } = service();
    const execute = vi.fn(() => 'ran');
    approvals.register({ ...base, capability: 'x.read', execute });
    await approvals.setPolicy('alice', 'dot', 'x.read', 'bypass');
    const input = {
        userId: 'alice',
        dotId: 'dot',
        capability: 'x.read',
        summary: 'S',
        payload: {},
    };
    expect((await approvals.request({ ...input, alwaysAsk: true })).status).toBe('pending_approval');
    expect(execute).not.toHaveBeenCalled();
    expect((await approvals.request(input)).status).toBe('approved');
    expect(execute).toHaveBeenCalledTimes(1);
});

it('caps waiting requests by socio or by binding, ignoring overdue ones', async () => {
    const { approvals, db } = service();
    approvals.register({ ...base, capability: 'x.use', consumable: true });
    const limit = (by: 'dot' | 'binding') => ({
        max: 2,
        capabilities: ['x.use'],
        by,
        message: 'Wait.',
    });
    const ask = (bindingId: string, dotId = 'dot', by: 'dot' | 'binding' = 'binding') =>
        approvals.request({
            userId: 'alice',
            dotId,
            capability: 'x.use',
            summary: 'S',
            payload: {},
            binding: { digest: `d-${Math.random()}`, bindingId },
            limit: limit(by),
        });
    await ask('g1');
    await ask('g1');
    await expect(ask('g1')).rejects.toThrow(ApprovalError);
    // Another binding has its own two.
    await ask('g2');
    // By socio: the four waiting from `dot` count, not another socio's.
    await expect(ask('g3', 'dot', 'dot')).rejects.toThrow('Wait.');
    await ask('g3', 'other', 'dot');
    // Overdue requests no longer count.
    db.prepare("UPDATE approval_requests SET expiresAt=1 WHERE bindingId='g1'").run();
    await ask('g1');
});

it('uses a consumable approval once, for its digest and binding, only when approved', async () => {
    const { approvals } = service();
    const events: string[] = [];
    approvals.register({
        ...base,
        capability: 'x.use',
        consumable: true,
        onDecision: (_request, event) => events.push(`${event.status}:${event.by}`),
    });
    const request = await approvals.request({
        userId: 'alice',
        dotId: 'dot',
        capability: 'x.use',
        summary: 'S',
        payload: {},
        binding,
    });
    const use = (overrides: Partial<typeof binding> = {}, capability = 'x.use') =>
        approvals.consume(request.id, { capability, ...binding, ...overrides });
    expect(await use()).toBe(false);
    const decided = await approvals.decide(request.id, 'alice', true);
    expect(decided.outcome).toBe('Approved: it can be used once.');
    expect(decided.consumedAt).toBeNull();
    expect(await use({ digest: 'd2' })).toBe(false);
    expect(await use({ bindingId: 'grant-2' })).toBe(false);
    expect(await use({}, 'x.other')).toBe(false);
    const within = vi.fn();
    expect(await approvals.consume(request.id, { capability: 'x.use', ...binding }, within)).toBe(true);
    expect(within).toHaveBeenCalledTimes(1);
    expect(await use()).toBe(false);
    expect(events).toEqual(['approved:alice', 'consumed:platform']);
    expect((await approvals.auditFor('alice')).map((entry) => entry.event)).toContain('consumed');
});

it('rolls a decision back when onDecision fails: the record commits with it', async () => {
    const { approvals } = service();
    approvals.register({
        ...base,
        capability: 'x.use',
        consumable: true,
        onDecision: () => {
            throw new Error('audit write failed');
        },
    });
    const request = await approvals.request({
        userId: 'alice',
        dotId: 'dot',
        capability: 'x.use',
        summary: 'S',
        payload: {},
        binding,
    });
    await expect(approvals.decide(request.id, 'alice', true)).rejects.toThrow('audit write failed');
    expect((await approvals.get(request.id, 'alice')).status).toBe('pending');
});

it('a `within` that throws leaves the approval unused', async () => {
    const { approvals } = service();
    approvals.register({ ...base, capability: 'x.use', consumable: true });
    const request = await approvals.request({
        userId: 'alice',
        dotId: 'dot',
        capability: 'x.use',
        summary: 'S',
        payload: {},
        binding,
    });
    await approvals.decide(request.id, 'alice', true);
    await expect(
        approvals.consume(request.id, { capability: 'x.use', ...binding }, () => {
            throw new Error('not this app');
        }),
    ).rejects.toThrow('not this app');
    expect((await approvals.get(request.id, 'alice')).consumedAt).toBeNull();
    expect(await approvals.consume(request.id, { capability: 'x.use', ...binding })).toBe(true);
});

it('expires the waiting requests of a binding that ended', async () => {
    const { approvals } = service();
    approvals.register({ ...base, capability: 'x.use', consumable: true });
    const ask = (bindingId: string) =>
        approvals.request({
            userId: 'alice',
            dotId: 'dot',
            capability: 'x.use',
            summary: 'S',
            payload: {},
            binding: { digest: 'd', bindingId },
        });
    const ended = await ask('g1');
    const kept = await ask('g2');
    expect(await approvals.expireBound(['g1'], 'The access ended.')).toBe(1);
    expect(await approvals.get(ended.id, 'alice')).toMatchObject({
        status: 'expired',
        outcome: 'The access ended.',
    });
    expect((await approvals.get(kept.id, 'alice')).status).toBe('pending');
});

it('refuses approval until long details are opened by their person', async () => {
    const { approvals } = service();
    approvals.register<{ text: string }>({
        ...base,
        capability: 'x.long',
        execute: () => 'ran',
        review: {
            mustOpen: (payload) => payload.text.length > 10,
            full: (payload) => payload.text,
        },
    });
    const ask = (text: string) =>
        approvals.request({
            userId: 'alice',
            dotId: 'dot',
            capability: 'x.long',
            summary: 'S',
            payload: { text },
        });
    const short = await ask('short');
    expect((await approvals.decide(short.id, 'alice', true)).status).toBe('approved');
    const long = await ask('a long text of many words');
    await expect(approvals.decide(long.id, 'alice', true)).rejects.toThrow(/Open the full details/);
    await expect(approvals.open(long.id, 'bob')).rejects.toThrow(/not found/);
    expect(await approvals.open(long.id, 'alice')).toEqual({
        full: 'a long text of many words',
    });
    await approvals.open(long.id, 'alice');
    expect((await approvals.auditFor('alice')).filter((entry) => entry.event === 'opened')).toHaveLength(1);
    expect((await approvals.decide(long.id, 'alice', true)).status).toBe('approved');
});
