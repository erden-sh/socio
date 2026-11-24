import { afterEach, expect, it } from 'vitest';

import { CONTEXT_WORK } from '../src/server/actors/contexts.js';
import type { GrantRecord } from '../src/server/actors/contract.js';
import { RECHECK_MS } from '../src/server/actors/revocations.js';

import { delegated, fixture, grantInput } from './support/actor-fixture.js';

// CB-232: two runtimes of a deploy
// on one database (CB-108). Whatever one issues the other accepts; a
// revocation on one closes what the other holds within 5 s; caps hold
// across both; contexts move on a drain.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});
const setup = () => {
    const f = fixture(2);
    cleanup.push(() => f.close());
    return { ...f, b: f.b! };
};

it('accepts on either runtime what the other issued', async () => {
    const f = setup();
    const { token, grant } = await delegated(f.a.access);
    const check = (runtime: typeof f.a) =>
        runtime.access.check(token, {
            kind: 'cbsa',
            audience: 'app:crm',
            action: 'dashboard.view',
            correlationId: 'req-1',
        });
    expect(await check(f.a)).toMatchObject({ ok: true });
    const onB = await check(f.b);
    expect(onB).toMatchObject({
        ok: true,
        actor: {
            actorType: 'socio',
            socioId: 'rulo',
            personId: 'alice',
            grantId: grant.id,
            scopes: ['app:read'],
            policyVersion: 'v1',
        },
    });
    // The request-bound cbob_ too: minted by A's proxy, opened by B.
    const obo = f.a.access.credentials.mintObo({
        appId: 'crm',
        grantId: grant.id,
        requestId: 'req-1',
        ttlMs: 30_000,
    });
    expect(f.b.access.credentials.openObo(obo, 'crm')).toMatchObject({
        grantId: grant.id,
    });
    // A's runtime exits: nothing it issued dies with it.
    await f.a.session.detach(f.a.db);
    expect(await check(f.b)).toMatchObject({ ok: true });
});

it('revokes on one runtime and closes what the other holds within 5 s', async () => {
    const f = setup();
    const { token, grant } = await delegated(f.a.access);
    const request = {
        kind: 'cbsa' as const,
        audience: 'app:crm' as const,
        action: 'dashboard.view',
        correlationId: 'r',
    };
    // B serves a request (its decision is now cached) and holds a stream.
    expect(await f.b.access.check(token, request)).toMatchObject({ ok: true });
    const closed: string[] = [];
    f.b.access.revocations.track(grant.id, {
        close: (reason) => closed.push(`sse:${reason}`),
    });
    f.b.access.revocations.track(grant.id, {
        close: (reason) => closed.push(`ws:${reason}`),
    });
    await f.a.access.revoke({ grantId: grant.id }, 'alice', 'person_revoked');
    // The credential row is gone at once, so a new request fails everywhere.
    expect(await f.b.access.check(token, request)).toMatchObject({
        ok: false,
        status: 401,
    });
    // The fast path: B's poll picks up the signal.
    expect(f.b.access.revocations.pollSignals()).toEqual([grant.id]);
    expect(closed.sort()).toEqual(['sse:person_revoked', 'ws:person_revoked']);
    expect(f.b.access.revocations.trackedCount()).toBe(0);
    // Seen once only.
    expect(f.b.access.revocations.pollSignals()).toEqual([]);
});

it('closes what it holds within 5 s even when the signal is missed', async () => {
    const f = setup();
    const { grant } = await delegated(f.a.access);
    // B checked the grant a moment ago: its decision is cached.
    expect((await f.b.access.authorizer.authorizeGrant(grant.id)).allowed).toBe(true);
    const closed: string[] = [];
    f.b.access.revocations.track(grant.id, {
        close: (reason) => closed.push(reason),
    });
    await f.a.access.revoke({ grantId: grant.id }, 'admin', 'admin_revoked');
    // The signal row is lost (as if B were busy past its life).
    f.b.db.prepare("DELETE FROM runtime_signals WHERE kind='actor-grant'").run();
    expect(f.b.access.revocations.pollSignals()).toEqual([]);
    // A use within 5 s may still see the cached allow…
    expect((await f.b.access.authorizer.authorizeGrant(grant.id)).allowed).toBe(true);
    // …but the 5-s re-check reads afresh and closes.
    f.advance(RECHECK_MS);
    expect(await f.b.access.revocations.recheck()).toEqual([grant.id]);
    expect(closed).toEqual(['access_changed']);
    expect(await f.b.access.authorizer.authorizeGrant(grant.id)).toEqual({
        allowed: false,
        reason: 'grant_revoked',
    });
});

it('ends access on every runtime when the feature is switched off', async () => {
    const f = setup();
    const { token, grant } = await delegated(f.a.access);
    f.w.flagsOff.add('socio-actor-access');
    f.advance(5_000);
    expect(
        await f.b.access.check(token, {
            kind: 'cbsa',
            audience: 'app:crm',
            action: 'dashboard.view',
            correlationId: 'r',
        }),
    ).toMatchObject({ ok: false, status: 403, reason: 'feature_off' });
    // The leader's sweep makes it a revocation, with its audit row.
    expect(await f.a.access.sweep()).toEqual([grant.id]);
    expect(f.b.access.grants.get(grant.id)).toMatchObject({
        revokeReason: 'feature_off',
        revokedBy: 'system',
    });
});

it('holds the context caps across both runtimes', async () => {
    const f = setup();
    const grants: GrantRecord[] = [];
    for (let i = 0; i < 6; i++) {
        f.w.conversations.set(`c-${i}`, 'private');
        grants.push(await f.a.access.grants.create(grantInput({ conversationId: `c-${i}` })));
    }
    const open = (runtime: typeof f.a, i: number) =>
        runtime.access.contexts.open({
            grant: grants[i]!,
            kind: 'browser',
            audience: 'app:crm',
            limits: { perPerson: 3, perSocio: 10, perInstance: 10 },
            correlationId: `ctx-${i}`,
        });
    // Six concurrent opens for one person against a cap of 3, both runtimes.
    const results = await Promise.allSettled([0, 1, 2, 3, 4, 5].map((i) => open(i % 2 ? f.b : f.a, i)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const refused = results.filter((r) => r.status === 'rejected');
    expect(refused).toHaveLength(3);
    for (const r of refused) {
        expect((r as PromiseRejectedResult).reason).toMatchObject({
            reason: 'limit_reached',
        });
    }
    expect(f.a.db.prepare('SELECT COUNT(*) AS n FROM actor_contexts WHERE closedAt IS NULL').get()).toEqual({ n: 3 });
});

it('hands a context over on a drain and renews its credential on the other runtime', async () => {
    const f = setup();
    const { context, token, grant } = await delegated(f.a.access);
    const delivered: string[] = [];
    f.b.access.deliverWith('browser', (ctx, fresh) => {
        delivered.push(`${ctx.id}:${fresh.slice(0, 5)}`);
    });
    expect(f.a.access.contexts.owned().map((c) => c.id)).toEqual([context.id]);
    expect(f.b.access.contexts.owned()).toEqual([]);
    // B can't take it while A holds the lease.
    expect(f.b.access.contexts.adoptOrphans()).toEqual([]);
    // A drains: it releases the lease; B adopts the context.
    expect(f.a.access.drain()).toBe(1);
    // Not yet due: nothing renewed, but the lease moved.
    expect(await f.b.access.renewContexts()).toEqual([]);
    expect(f.b.access.contexts.owned().map((c) => c.id)).toEqual([context.id]);
    const lease = f.b.session.attach(f.b.db).workLease(CONTEXT_WORK, context.id);
    expect(lease?.ownerId).toBe(f.b.session.id);
    // At 10 minutes B renews and hands the broker the new credential.
    f.advance(10 * 60_000);
    expect(await f.b.access.renewContexts()).toEqual([context.id]);
    expect(delivered).toEqual([`${context.id}:cbsa_`]);
    // The old one keeps working until it expires; the broker swaps.
    const request = {
        kind: 'cbsa' as const,
        audience: 'app:crm' as const,
        action: 'dashboard.view',
        correlationId: 'r',
    };
    expect(await f.a.access.check(token, request)).toMatchObject({ ok: true });
    f.advance(5 * 60_000);
    expect(await f.a.access.check(token, request)).toMatchObject({
        ok: false,
        reason: 'credential_expired',
    });
    // Its audit rows say who issued what for which grant, with no token.
    const rows = f.a.access.audit.list({ grantId: grant.id });
    expect(rows.filter((row) => row.phase === 'credential')).toHaveLength(2);
});

it('issues nothing while the other runtime enforces an older contract', async () => {
    const f = setup();
    expect(f.a.access.issuable()).toBe(true);
    // B is a release from before the contract: it records no version.
    f.b.db.prepare('DELETE FROM runtime_contracts WHERE runtimeId=?').run(f.b.session.id);
    expect(f.a.access.issuable()).toBe(false);
    await expect(f.a.access.grants.create(grantInput())).rejects.toMatchObject({
        reason: 'contract_outdated',
    });
    await f.b.session.detach(f.b.db);
    expect(f.a.access.issuable()).toBe(true);
});

it('re-checks every grant when one check throws, closing that one too', async () => {
    const f = setup();
    const bobs = await delegated(f.a.access, { personId: 'bob' });
    const alices = await delegated(f.a.access, { conversationId: 'chat-2' });
    const closed: string[] = [];
    // Bob's grant is tracked first, so its check runs first.
    for (const [who, grant] of [
        ['bob', bobs.grant],
        ['alice', alices.grant],
    ] as const) {
        f.b.access.revocations.track(grant.id, {
            close: (reason) => closed.push(`${who}:${reason}`),
        });
    }
    // The person lookup fails for Bob (a directory outage, a bug).
    f.w.inactive = new (class extends Set<string> {
        override has(id: string) {
            if (id === 'bob') {
                throw new Error('directory unavailable');
            }
            return super.has(id);
        }
    })();
    // Alice's grant is revoked on A and B misses the signal.
    await f.a.access.revoke({ grantId: alices.grant.id }, 'admin', 'admin_revoked');
    f.b.db.prepare("DELETE FROM runtime_signals WHERE kind='actor-grant'").run();
    f.advance(RECHECK_MS);
    // Both close in the same cycle: Alice's revoked, Bob's failed closed.
    expect((await f.b.access.revocations.recheck()).sort()).toEqual([bobs.grant.id, alices.grant.id].sort());
    expect(closed.sort()).toEqual(['alice:access_changed', 'bob:access_changed']);
    expect(f.b.access.revocations.trackedCount()).toBe(0);
});
