import { afterEach, expect, it } from 'vitest';

import { sqliteData } from '@socio/data/open';

import { sqliteApprovals } from '../src/server/approvals/services.js';

import { testDatabase } from './helpers/test-database.js';

/*
 * Approvals on the data layer (CB-110): every write from a route, a tool or
 * a continuation is a unit of work, so one started while another chain's
 * unit is open (a Board write in the same model step) queues behind it
 * instead of landing in it, and stays when that unit rolls back. Under
 * tests a write from outside an open unit fails, so one that didn't queue
 * shows up as a failure here.
 */

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);

const hops = async (n: number) => {
    for (let i = 0; i < n; i++) {
        await Promise.resolve();
    }
};

function fixture() {
    const db = testDatabase();
    cleanup.push(() => db.close());
    const approvals = sqliteApprovals(db, { ttlMs: 1000 });
    const executed: string[] = [];
    approvals.register<{ name: string }>({
        capability: 'test.note',
        label: 'Write notes',
        description: 'Writes a note.',
        execute: ({ payload }) => {
            executed.push(payload.name);
            return `Wrote ${payload.name}.`;
        },
    });
    const ask = async (name: string, extra: { dotId?: string; threadId?: string } = {}) =>
        (await approvals.request({
            userId: 'alice',
            dotId: extra.dotId ?? 'dot-1',
            capability: 'test.note',
            summary: `Write “${name}”`,
            payload: { name },
            ...(extra.threadId ? { threadId: extra.threadId, runId: name } : {}),
        })) as { id: string; status: string };
    const { uow } = sqliteData(db);
    /** Another chain's unit, open across many hops, that then throws. */
    const held = async () => {
        const unit = uow.run(
            async () => {
                await hops(300);
                throw new Error('The other unit fails.');
            },
            { label: 'held unit' },
        );
        while (!uow.foreignUnit) {
            await Promise.resolve();
        }
        return { unit };
    };
    return { db, approvals, executed, ask, held };
}

it('queues the decisions, policies, notes and continuations behind an open unit, and keeps them when it rolls back', async () => {
    const f = fixture();
    const decided = await f.ask('Decided', { threadId: 't1' });
    const denied = await f.ask('Denied');
    await f.ask('Forgotten', { dotId: 'dot-2' });
    const marked = await f.ask('Marked', { threadId: 't2' });
    const { unit } = await f.held();
    const writes = Promise.all([
        f.approvals.setPolicy('alice', 'dot-1', 'test.note', 'bypass'),
        f.approvals.setGuidance('alice', 'Small notes only.'),
        f.approvals.decide(decided.id, 'alice', true),
        f.approvals.decide(denied.id, 'alice', false),
        f.approvals.forgetDot('dot-2'),
        f.approvals.recordNote('n1', 't1', 'alice', 'Carry on.'),
        f.approvals.markContinuation([marked.id], 'skipped', { detail: 'Paused.' }),
        // A bypassed request, approved and run behind the unit too.
        hops(5).then(() => f.ask('Bypassed')),
    ]);
    await expect(unit).rejects.toThrow('The other unit fails.');
    const [, , first, second, , , , bypassed] = await writes;
    expect(first).toMatchObject({
        status: 'approved',
        outcome: 'Wrote Decided.',
        continuation: { status: 'waiting' },
    });
    expect(second.status).toBe('denied');
    expect(bypassed).toMatchObject({ status: 'approved', via: 'bypass' });
    expect(f.executed).toEqual(['Decided', 'Bypassed']);
    expect(await f.approvals.policy('alice', 'dot-1', 'test.note')).toBe('bypass');
    expect(await f.approvals.guidance('alice')).toBe('Small notes only.');
    expect(await f.approvals.isNote('n1', 't1', 'Carry on.')).toBe(true);
    expect((await f.approvals.get(marked.id, 'alice')).continuation).toMatchObject({
        status: 'skipped',
        detail: 'Paused.',
    });
    const forgotten = await f.approvals.list('alice', { dotId: 'dot-2' });
    expect(forgotten).toMatchObject([{ status: 'expired', outcome: 'The socio was deleted.' }]);
    expect((await f.approvals.auditFor('alice')).map((entry) => entry.event).sort()).toEqual(
        [
            'requested',
            'requested',
            'requested',
            'requested',
            'requested',
            'policy_changed',
            'guidance_changed',
            'approved',
            'denied',
            'executed',
            'executed',
            'bypassed',
            'expired',
        ].sort(),
    );
});

it('expires behind an open unit, and lets the turn carry on once the expiry has landed', async () => {
    const f = fixture();
    const kept = await f.ask('Kept', { threadId: 't1' });
    const lapsed = await f.ask('Lapsed', { threadId: 't1' });
    await f.approvals.decide(kept.id, 'alice', true);
    const seen: Array<[string, string]> = [];
    f.approvals.onSettled(async (threadId) => {
        // Called after the expiry committed: it reads as expired.
        seen.push([threadId, (await f.approvals.get(lapsed.id, 'alice')).status]);
    });
    const { unit } = await f.held();
    const expiring = f.approvals.expire(Date.now() + 5000);
    await expect(unit).rejects.toThrow('The other unit fails.');
    expect(await expiring).toBe(1);
    expect((await f.approvals.get(lapsed.id, 'alice')).status).toBe('expired');
    await new Promise((resolve) => setImmediate(resolve));
    await hops(20);
    expect(seen).toEqual([['t1', 'expired']]);
    // Expiring again finds nothing: no second audit entry.
    expect(await f.approvals.expire(Date.now() + 5000)).toBe(0);
    expect((await f.approvals.auditFor('alice')).filter((entry) => entry.event === 'expired')).toHaveLength(1);
});
