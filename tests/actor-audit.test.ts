import { afterEach, expect, it } from 'vitest';

import { transaction } from '@socio/data/open';

import { delegated, fixture, grantInput } from './support/actor-fixture.js';

// CB-232: actor_audit is append-only, written in the same transaction as
// the change it records, correlated, sampled for allows, and free of tokens,
// cookies, bodies and params.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});
const setup = () => {
    const f = fixture();
    cleanup.push(() => f.close());
    return f;
};

it('refuses UPDATE and DELETE', async () => {
    const f = setup();
    await f.a.access.grants.create(grantInput());
    const { db } = f.a;
    expect(db.prepare('SELECT COUNT(*) AS n FROM actor_audit').get()).toEqual({
        n: 1,
    });
    expect(() => db.prepare("UPDATE actor_audit SET reason='edited'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM actor_audit').run()).toThrow(/append-only/);
    // Codes only: free text can't go in `reason`.
    expect(() =>
        db
            .prepare(
                "INSERT INTO actor_audit(at, correlationId, phase, reason) VALUES (1, 'c', 'decision', 'Bearer cbsa_x')",
            )
            .run(),
    ).toThrow(/CHECK/);
    expect(() =>
        db.prepare("INSERT INTO actor_audit(at, correlationId, phase) VALUES (1, 'c', 'anything')").run(),
    ).toThrow(/CHECK/);
});

it('records state changes in the same transaction as the change', async () => {
    const f = setup();
    const { access, db } = f.a;
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    // A grant whose replacement check fails: neither grant nor audit row.
    const bobs = await access.grants.create(grantInput({ personId: 'bob' }));
    const before = { grants: count('socio_grants'), audit: count('actor_audit') };
    await expect(access.grants.create(grantInput({ replaces: bobs.id }))).rejects.toThrow();
    expect(count('socio_grants')).toBe(before.grants);
    expect(count('actor_audit')).toBe(before.audit);
    // A revocation rolled back with its caller's transaction leaves no row.
    const { revokeWithin } = await import('../src/server/actors/revocations.js');
    await expect(
        transaction(db, 'test', () => {
            revokeWithin(db, access.audit, {
                ids: [bobs.id],
                at: f.w.now,
                by: 'admin',
                reason: 'admin_revoked',
                correlationId: 'c',
            });
            throw new Error('boom');
        }),
    ).rejects.toThrow('boom');
    expect(access.grants.get(bobs.id)?.revokedAt).toBeNull();
    expect(count('actor_audit')).toBe(before.audit);
    // A committed one: grant, credentials, contexts and its row together.
    const { grant, context } = await delegated(access);
    await access.revoke({ grantId: grant.id }, 'admin', 'admin_revoked', 'corr-revoke');
    expect(access.grants.get(grant.id)).toMatchObject({
        revokedBy: 'admin',
        revokeReason: 'admin_revoked',
    });
    expect(access.contexts.get(context.id)).toMatchObject({
        closeReason: 'grant_revoked',
    });
    expect(access.audit.list({ correlationId: 'corr-revoke' })).toMatchObject([
        {
            phase: 'revoke',
            reason: 'admin_revoked',
            grantId: grant.id,
            personId: 'alice',
            socioId: 'rulo',
            actorBy: 'admin',
            audience: 'app:crm',
        },
    ]);
});

it('correlates a scenario’s rows and keeps no secrets', async () => {
    const f = setup();
    const { access, db } = f.a;
    const { token, grant } = await delegated(access);
    const obo = access.credentials.mintObo({
        appId: 'crm',
        grantId: grant.id,
        requestId: 'req-1',
        ttlMs: 1_000,
    });
    const request = {
        kind: 'cbsa' as const,
        audience: 'app:crm' as const,
        action: 'dashboard.view',
        correlationId: 'req-1',
        resource: { kind: 'dataset', id: 'sales' },
    };
    // Three allowed uses within a minute: one sampled row.
    for (let i = 0; i < 3; i++) {
        expect(await access.check(token, request)).toMatchObject({ ok: true });
    }
    // A denied one, with the token's text in the action name: redacted.
    expect(await access.check(token, { ...request, action: `deal.update ${token}` })).toMatchObject({ ok: false });
    expect(await access.check(`cbsa_${'x'.repeat(43)}`, request)).toMatchObject({
        ok: false,
        status: 401,
    });
    f.advance(60_000);
    expect(await access.check(token, request)).toMatchObject({ ok: true });
    await transaction(db, 'test setting', () =>
        access.audit.recordIn({
            correlationId: 'setting-1',
            phase: 'setting',
            actorBy: 'olga',
            detail: `registries: npm → npm, pypi (pasted ${obo})`,
        }),
    );
    await access.revoke({ grantId: grant.id }, 'alice', 'person_revoked', 'req-2');
    // writeSoon rows land at once on a free connection.
    const rows = access.audit.list({});
    const decisions = rows.filter((row) => row.correlationId === 'req-1');
    expect(decisions.map((row) => `${row.decision}:${row.reason ?? ''}`).sort()).toEqual([
        'allow:',
        'allow:',
        'deny:action_undeclared',
        'deny:credential_invalid',
    ]);
    for (const row of decisions.filter((row) => row.grantId)) {
        expect(row).toMatchObject({
            grantId: grant.id,
            personId: 'alice',
            socioId: 'rulo',
            audience: 'app:crm',
            resourceKind: 'dataset',
            resourceId: 'sales',
        });
    }
    expect(rows.map((row) => row.phase).sort()).toEqual(
        ['context', 'credential', 'decision', 'decision', 'decision', 'decision', 'grant', 'revoke', 'setting'].sort(),
    );
    // Nothing secret, nothing the person or socio wrote, anywhere.
    const all = JSON.stringify(db.prepare('SELECT * FROM actor_audit').all());
    for (const secret of [token, token.slice(5), obo, 'cbsa_', 'cbob_', 'cbgw_', 'cbdt_', 'pipeline chart']) {
        expect(all).not.toContain(secret);
    }
    expect(all).toContain('[redacted]');
});

it('refuses a state-change row outside a transaction', async () => {
    const f = setup();
    const { access, db } = f.a;
    const row = {
        correlationId: 'setting-1',
        phase: 'setting' as const,
        actorBy: 'olga',
    };
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM actor_audit').get() as { n: number }).n;
    // Outside a transaction: it would land apart from its change.
    expect(() => access.audit.recordIn(row)).toThrow(/inside a transaction/);
    expect(count()).toBe(0);
    // Inside the caller's: recorded.
    await transaction(db, 'test setting', () => access.audit.recordIn(row));
    expect(count()).toBe(1);
});

it('samples denies no credential stands behind, not a grant’s', async () => {
    const f = setup();
    const { access } = f.a;
    const { randomBytes } = await import('node:crypto');
    const request = {
        kind: 'cbsa' as const,
        audience: 'app:crm' as const,
        action: 'dashboard.view',
    };
    const decisions = () => access.audit.list({}).filter((row) => row.phase === 'decision');
    // Anyone on the internet: 50 random bearers, each its own request.
    for (let i = 0; i < 50; i++) {
        expect(
            await access.check(`cbsa_${randomBytes(32).toString('base64url')}`, {
                ...request,
                correlationId: `anon-${i}`,
            }),
        ).toMatchObject({ ok: false, status: 401, reason: 'credential_invalid' });
    }
    // Malformed ones too, and none at all: the same reason, the same minute.
    for (const token of ['cbsa_x', undefined, 'Bearer']) {
        await access.check(token, { ...request, correlationId: 'anon-x' });
    }
    expect(decisions()).toHaveLength(1);
    expect(decisions()[0]).toMatchObject({
        decision: 'deny',
        reason: 'credential_invalid',
    });
    expect(decisions()[0]!.grantId).toBeUndefined();
    // An expired credential is another reason: its own row.
    const old = await delegated(access, { minutes: 10 });
    f.advance(10 * 60_000);
    for (let i = 0; i < 3; i++) {
        expect(await access.check(old.token, { ...request, correlationId: 'old' })).toMatchObject({
            reason: 'credential_expired',
        });
    }
    expect(decisions()).toHaveLength(2);
    // A minute on, one more row per reason.
    f.advance(60_000);
    await access.check('cbsa_x', { ...request, correlationId: 'anon-later' });
    expect(decisions()).toHaveLength(3);
    // A real grant's denies are each recorded.
    const { token, grant } = await delegated(access, {
        conversationId: 'chat-2',
    });
    for (let i = 0; i < 5; i++) {
        expect(
            await access.check(token, {
                ...request,
                action: 'not.declared',
                correlationId: `real-${i}`,
            }),
        ).toMatchObject({ ok: false, status: 403 });
    }
    expect(access.audit.list({ grantId: grant.id }).filter((row) => row.phase === 'decision')).toHaveLength(5);
});
