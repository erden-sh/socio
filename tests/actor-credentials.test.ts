import { afterEach, expect, it } from 'vitest';

import { sha256Hex } from '@socio/foundation/actors/keys';

import { ActorAccessError } from '../src/server/actors/contract.js';
import { ActorCredentials, CREDENTIAL_TTL_MS, OBO_GRACE_MS } from '../src/server/actors/credentials.js';
import { ACTOR_ACCESS_CONTRACT } from '../src/server/actors/principal.js';

import { delegated, fixture, grantInput } from './support/actor-fixture.js';

// CB-232: token format and validation, audience binding, expiry, the
// cbob_ codec, continuations and the issuance gate.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});
const setup = (runtimes = 1) => {
    const f = fixture(runtimes);
    cleanup.push(() => f.close());
    return f;
};

it('issues prefixed 32-byte reference tokens, stored by hash only', async () => {
    const f = setup();
    const { token, hash, grant, context, expiresAt } = await delegated(f.a.access);
    expect(token).toMatch(/^cbsa_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token.slice(5), 'base64url')).toHaveLength(32);
    expect(hash).toBe(sha256Hex(token));
    expect(expiresAt).toBe(f.w.now + CREDENTIAL_TTL_MS.cbsa);
    const rows = f.a.db.prepare('SELECT * FROM actor_credentials').all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token.slice(5));
    expect(rows[0]).toMatchObject({
        hash,
        kind: 'cbsa',
        grantId: grant.id,
        contextId: context.id,
        holderKind: 'context',
        holderId: context.id,
        issuedBy: f.a.session.id,
    });
    const gw = await f.a.access.grants.create(
        grantInput({
            audiences: ['gateway:model', 'gateway:git'],
            scopes: ['model:invoke', 'git:read'],
            policyVersion: '',
        }),
    );
    const cbgw = await f.a.access.credentials.issue({
        grant: gw,
        kind: 'cbgw',
        audiences: ['gateway:model', 'gateway:git'],
        contextId: 'sbx_1',
        holder: { kind: 'prompt-run', id: 'run-1' },
        ttlMs: 25 * 60_000,
        correlationId: 'c',
    });
    expect(cbgw.token).toMatch(/^cbgw_[A-Za-z0-9_-]{43}$/);
    expect(cbgw.expiresAt).toBe(f.w.now + 25 * 60_000);
});

it('validates in order: shape, hash, expiry, audience, holder, grant', async () => {
    const f = setup();
    const { access } = f.a;
    const { token, context, grant } = await delegated(access);
    const resolve = (value: string | undefined, audience = 'app:crm' as const) =>
        access.credentials.resolve(value, { kind: 'cbsa', audience });
    expect(resolve(token)).toMatchObject({ ok: true });
    for (const bad of [
        undefined,
        '',
        token.slice(0, -1),
        `${token}A`,
        token.replace('cbsa_', 'cbgw_'),
        token.replace('cbsa_', 'cbdt_'),
        `cbsa_${'!'.repeat(43)}`,
        `cbsa_${'A'.repeat(43)}`,
    ]) {
        expect(resolve(bad)).toEqual({ ok: false, reason: 'credential_invalid' });
    }
    // A cbsa_ presented as a cbgw_ is refused even with the right shape.
    expect(access.credentials.resolve(token, { kind: 'cbgw', audience: 'app:crm' })).toEqual({
        ok: false,
        reason: 'credential_invalid',
    });
    // Audience binding: issued for app:crm, presented at app:other.
    expect(resolve(token, 'app:other' as 'app:crm')).toEqual({
        ok: false,
        reason: 'audience_mismatch',
    });
    // The context that holds it closes: it is dead at once.
    await access.contexts.close([context.id], 'closed_by_test', 'c');
    expect(resolve(token)).toEqual({ ok: false, reason: 'credential_invalid' });
    // A fresh one on a new context, then the grant revoked.
    const second = await delegated(access, { conversationId: 'chat-2' });
    expect(resolve(second.token)).toMatchObject({ ok: true });
    await access.revoke({ grantId: second.grant.id }, 'alice', 'person_revoked');
    expect(resolve(second.token)).toEqual({
        ok: false,
        reason: 'credential_invalid',
    });
    expect(grant.revokedAt).toBeNull();
});

it('expires credentials at 15 minutes, never past their grant', async () => {
    const f = setup();
    const { access } = f.a;
    const { token } = await delegated(access, { minutes: 10 });
    const resolve = () => access.credentials.resolve(token, { kind: 'cbsa', audience: 'app:crm' });
    f.advance(10 * 60_000 - 1);
    expect(resolve()).toMatchObject({ ok: true });
    f.advance(1);
    expect(resolve()).toEqual({ ok: false, reason: 'credential_expired' });
    const long = await delegated(access, {
        minutes: 120,
        conversationId: 'chat-2',
    });
    f.advance(CREDENTIAL_TTL_MS.cbsa);
    expect(
        access.credentials.resolve(long.token, {
            kind: 'cbsa',
            audience: 'app:crm',
        }),
    ).toEqual({ ok: false, reason: 'credential_expired' });
    // The leader's sweep drops expired rows.
    await access.credentials.pruneExpired();
    expect(f.a.db.prepare('SELECT COUNT(*) AS n FROM actor_credentials').get()).toEqual({ n: 0 });
});

it('binds credentials to the grant’s audiences and scopes', async () => {
    const f = setup();
    const { access } = f.a;
    const grant = await access.grants.create(grantInput({ scopes: ['app:read'] }));
    const context = await access.contexts.open({
        grant,
        kind: 'browser',
        audience: 'app:crm',
        correlationId: 'c',
    });
    const issue = (over: Partial<Parameters<typeof access.credentials.issue>[0]>) =>
        access.credentials.issue({
            grant,
            kind: 'cbsa',
            audiences: ['app:crm'],
            contextId: context.id,
            holder: { kind: 'context', id: context.id },
            correlationId: 'c',
            ...over,
        });
    await expect(issue({ audiences: ['app:other'] })).rejects.toMatchObject({
        reason: 'audience_mismatch',
    });
    await expect(issue({ kind: 'cbgw' })).rejects.toMatchObject({
        reason: 'audience_mismatch',
    });
    await expect(issue({ scopes: ['app:write'] })).rejects.toMatchObject({
        reason: 'scope_insufficient',
    });
    await expect(issue({ holder: { kind: 'context', id: 'not-a-context' } })).rejects.toMatchObject({
        reason: 'context_closed',
    });
    // A gateway credential may not name an app.
    const gw = await access.grants.create(
        grantInput({
            audiences: ['gateway:model', 'gateway:git'],
            scopes: ['model:invoke', 'git:read'],
            policyVersion: '',
        }),
    );
    await expect(
        access.credentials.issue({
            grant: gw,
            kind: 'cbgw',
            audiences: ['gateway:model', 'app:crm'],
            contextId: 'sbx',
            holder: { kind: 'prompt-run', id: 'run' },
            correlationId: 'c',
        }),
    ).rejects.toMatchObject({ reason: 'audience_mismatch' });
    // Its scopes say which gateway it may use: model only here.
    access.credentials.holders.register('prompt-run', () => true);
    const modelOnly = await access.credentials.issue({
        grant: gw,
        kind: 'cbgw',
        audiences: ['gateway:model', 'gateway:git'],
        scopes: ['model:invoke'],
        contextId: 'sbx',
        holder: { kind: 'prompt-run', id: 'run' },
        correlationId: 'c',
    });
    const check = (scope: 'model:invoke' | 'git:read') =>
        access.check(modelOnly.token, {
            kind: 'cbgw',
            audience: scope === 'git:read' ? 'gateway:git' : 'gateway:model',
            scope,
            correlationId: 'c',
        });
    expect(await check('model:invoke')).toMatchObject({ ok: true });
    expect(await check('git:read')).toMatchObject({
        ok: false,
        status: 403,
        reason: 'scope_insufficient',
    });
    // The prompt returns: its credential ends with it.
    await access.credentials.revokeHolder('prompt-run', 'run');
    expect(await check('model:invoke')).toMatchObject({
        ok: false,
        status: 401,
        reason: 'credential_invalid',
    });
});

it('seals cbob_ tokens per app, request and expiry, opaque to the app', async () => {
    const f = setup();
    const creds = f.a.access.credentials;
    const token = creds.mintObo({
        appId: 'crm',
        grantId: 'grant-123',
        requestId: 'req-1',
        ttlMs: 30_000,
    });
    expect(token).toMatch(/^cbob_v1\.[A-Za-z0-9_-]+$/);
    expect(token).not.toContain('grant-123');
    expect(Buffer.from(token.slice(8), 'base64url').toString()).not.toContain('grant');
    expect(creds.openObo(token, 'crm')).toEqual({
        appId: 'crm',
        grantId: 'grant-123',
        requestId: 'req-1',
        issuedAt: f.w.now,
        expiresAt: f.w.now + 30_000 + OBO_GRACE_MS,
    });
    // Another app's data token can't use it.
    expect(creds.openObo(token, 'other')).toBeUndefined();
    // Tampered, truncated, or from another instance: refused.
    const raw = Buffer.from(token.slice(8), 'base64url');
    raw[raw.length - 20] ^= 1;
    expect(creds.openObo(`cbob_v1.${raw.toString('base64url')}`, 'crm')).toBeUndefined();
    expect(creds.openObo(token.slice(0, -4), 'crm')).toBeUndefined();
    const elsewhere = new ActorCredentials(f.a.db, {
        secret: 'another-instance-secret',
        audit: f.a.access.audit,
        runtimeId: 'x',
        issuable: () => true,
        now: () => f.w.now,
    });
    expect(elsewhere.openObo(token, 'crm')).toBeUndefined();
    // A person's session instead of a grant; never both, never neither.
    const person = creds.mintObo({
        appId: 'crm',
        sessionHash: 'ab'.repeat(32),
        requestId: 'req-2',
        ttlMs: 0,
    });
    expect(creds.openObo(person, 'crm')).toMatchObject({
        sessionHash: 'ab'.repeat(32),
    });
    expect(() => creds.mintObo({ appId: 'crm', requestId: 'r', ttlMs: 1 })).toThrow();
    expect(() =>
        creds.mintObo({
            appId: 'crm',
            grantId: 'g',
            sessionHash: 's',
            requestId: 'r',
            ttlMs: 1,
        }),
    ).toThrow();
    // Expiry: the request's limit plus 60 s.
    f.advance(30_000 + OBO_GRACE_MS - 1);
    expect(creds.openObo(token, 'crm')).toBeDefined();
    f.advance(1);
    expect(creds.openObo(token, 'crm')).toBeUndefined();
});

it('issues continuations as cbob_ reference tokens bound to the grant', async () => {
    const f = setup();
    const { access } = f.a;
    const grant = await access.grants.create(grantInput({ minutes: 30 }));
    const continuation = await access.credentials.issue({
        grant,
        kind: 'continuation',
        audiences: ['app:crm'],
        contextId: 'req-9',
        holder: { kind: 'grant', id: grant.id },
        ttlMs: 2 * 60 * 60_000,
        correlationId: 'c',
    });
    expect(continuation.token).toMatch(/^cbob_[A-Za-z0-9_-]{43}$/);
    expect(ActorCredentials.isContinuation(continuation.token)).toBe(true);
    expect(
        ActorCredentials.isContinuation(
            access.credentials.mintObo({
                appId: 'crm',
                grantId: grant.id,
                requestId: 'r',
                ttlMs: 1,
            }),
        ),
    ).toBe(false);
    // Never past the grant's expiry.
    expect(continuation.expiresAt).toBe(grant.expiresAt);
    expect(
        access.credentials.resolve(continuation.token, {
            kind: 'continuation',
            audience: 'app:crm',
        }),
    ).toMatchObject({ ok: true });
    await access.revoke({ grantId: grant.id }, 'alice', 'person_revoked');
    expect(access.credentials.resolve(continuation.token, { kind: 'continuation' })).toEqual({
        ok: false,
        reason: 'credential_invalid',
    });
});

it('issues nothing while a live runtime enforces an older contract, or none', async () => {
    const f = setup();
    const { access, db } = f.a;
    expect(access.issuable()).toBe(true);
    // A runtime of a release from before the actor platform base: registered,
    // no contract row.
    db.prepare('INSERT INTO runtime_instances VALUES(?,?,?,?,NULL)').run(
        'old-release',
        f.w.now,
        f.w.now,
        f.w.now + 30_000,
    );
    expect(access.issuable()).toBe(false);
    await expect(access.grants.create(grantInput())).rejects.toBeInstanceOf(ActorAccessError);
    await expect(access.grants.create(grantInput())).rejects.toMatchObject({
        reason: 'contract_outdated',
    });
    // It records an older version: still nothing. The actor platform base's
    // release enforces contract 1, which ignores `x-cb-obo` at the data API.
    expect(ACTOR_ACCESS_CONTRACT).toBe(2);
    db.prepare('INSERT INTO runtime_contracts VALUES(?,?,?)').run('old-release', 'actor-access', 1);
    expect(access.issuable()).toBe(false);
    await expect(access.grants.create(grantInput())).rejects.toMatchObject({
        reason: 'contract_outdated',
    });
    // It records this build's contract (a runtime of the same release).
    db.prepare('UPDATE runtime_contracts SET version=? WHERE runtimeId=?').run(ACTOR_ACCESS_CONTRACT, 'old-release');
    expect(access.issuable()).toBe(true);
    db.prepare('UPDATE runtime_contracts SET version=? WHERE runtimeId=?').run(1, 'old-release');
    // Raise this build's contract above the old runtime's.
    const ownership = f.a.session.attach(db);
    ownership.recordContract('actor-access', 2);
    expect(ownership.contractBehind('actor-access', 2)).toBe(true);
    // Once the old runtime exits, issuance resumes.
    db.prepare('UPDATE runtime_instances SET releasedAt=? WHERE id=?').run(f.w.now, 'old-release');
    expect(ownership.contractBehind('actor-access', 2)).toBe(false);
    expect(access.issuable()).toBe(true);
    expect(await access.grants.create(grantInput())).toMatchObject({
        personId: 'alice',
    });
});

// A `cbgw_` lives only while the prompt run that holds it does, and no
// longer than the prompt limit.
const gatewayGrant = (access: ReturnType<typeof setup>['a']['access']) =>
    access.grants.create(
        grantInput({
            audiences: ['gateway:model'],
            scopes: ['model:invoke'],
            policyVersion: '',
        }),
    );
const runCredential = (
    access: ReturnType<typeof setup>['a']['access'],
    grant: Awaited<ReturnType<typeof gatewayGrant>>,
    run: string,
) =>
    access.credentials.issue({
        grant,
        kind: 'cbgw',
        audiences: ['gateway:model'],
        contextId: 'sbx',
        holder: { kind: 'prompt-run', id: run },
        correlationId: 'c',
    });
const gatewayCheck = (access: ReturnType<typeof setup>['a']['access'], token: string) =>
    access.check(token, {
        kind: 'cbgw',
        audience: 'gateway:model',
        scope: 'model:invoke',
        correlationId: 'c',
    });

it('refuses a prompt run’s cbgw_ while no liveness check is registered', async () => {
    const f = setup();
    const { access } = f.a;
    const grant = await gatewayGrant(access);
    const { token } = await runCredential(access, grant, 'run-1');
    // Fail closed until CB-239's coding sessions register their runs' check.
    expect(
        access.credentials.resolve(token, {
            kind: 'cbgw',
            audience: 'gateway:model',
        }),
    ).toEqual({ ok: false, reason: 'context_closed' });
    expect(await gatewayCheck(access, token)).toMatchObject({
        ok: false,
        status: 401,
        reason: 'context_closed',
    });
    const off = access.credentials.holders.register('prompt-run', () => true);
    expect(() => access.credentials.holders.register('prompt-run', () => true)).toThrow(/already registered/);
    off();
});

it('refuses a prompt run’s cbgw_ once its run is no longer live', async () => {
    const f = setup();
    const { access } = f.a;
    const live = new Set(['run-1', 'run-2']);
    const off = access.credentials.holders.register('prompt-run', (id) => live.has(id));
    const grant = await gatewayGrant(access);
    const first = await runCredential(access, grant, 'run-1');
    const second = await runCredential(access, grant, 'run-2');
    expect(await gatewayCheck(access, first.token)).toMatchObject({ ok: true });
    // The run ended (its row says so) but its credential row is still there.
    live.delete('run-1');
    expect(await gatewayCheck(access, first.token)).toMatchObject({
        ok: false,
        status: 401,
        reason: 'context_closed',
    });
    expect(await gatewayCheck(access, second.token)).toMatchObject({ ok: true });
    // A check that throws counts as not live.
    off();
    access.credentials.holders.register('prompt-run', () => {
        throw new Error('runs table unavailable');
    });
    expect(await gatewayCheck(access, second.token)).toMatchObject({
        ok: false,
        reason: 'context_closed',
    });
});

it('keeps a cbgw_ for the prompt limit plus 5 minutes', async () => {
    const f = setup();
    const { access } = f.a;
    expect(CREDENTIAL_TTL_MS.cbgw).toBe(25 * 60_000);
    access.credentials.holders.register('prompt-run', () => true);
    const grant = await gatewayGrant(access);
    const { token, expiresAt } = await runCredential(access, grant, 'run-1');
    expect(expiresAt).toBe(f.w.now + 25 * 60_000);
    // Asking for longer gets the default.
    const longer = await access.credentials.issue({
        grant,
        kind: 'cbgw',
        audiences: ['gateway:model'],
        contextId: 'sbx',
        holder: { kind: 'prompt-run', id: 'run-2' },
        ttlMs: 8 * 60 * 60_000,
        correlationId: 'c',
    });
    expect(longer.expiresAt).toBe(f.w.now + 25 * 60_000);
    f.advance(25 * 60_000);
    expect(await gatewayCheck(access, token)).toMatchObject({
        ok: false,
        reason: 'credential_expired',
    });
});

it('refuses use at every listener while an older runtime is alive', async () => {
    const f = setup();
    const { access, db } = f.a;
    access.credentials.holders.register('prompt-run', () => true);
    const grant = await gatewayGrant(access);
    const { token } = await runCredential(access, grant, 'run-1');
    const app = await delegated(access, { conversationId: 'chat-2' });
    expect(await gatewayCheck(access, token)).toMatchObject({ ok: true });
    // A release from before the contract starts (a rollback).
    db.prepare('INSERT INTO runtime_instances VALUES(?,?,?,?,NULL)').run(
        'old-release',
        f.w.now,
        f.w.now,
        f.w.now + 30_000,
    );
    expect(await gatewayCheck(access, token)).toMatchObject({
        ok: false,
        status: 403,
        reason: 'contract_outdated',
    });
    expect(
        await access.check(app.token, {
            kind: 'cbsa',
            audience: 'app:crm',
            action: 'dashboard.view',
            correlationId: 'c',
        }),
    ).toMatchObject({ ok: false, status: 403, reason: 'contract_outdated' });
    expect(access.audit.list({ grantId: grant.id }).filter((row) => row.reason === 'contract_outdated')).toHaveLength(
        1,
    );
    // It exits: use resumes.
    db.prepare('UPDATE runtime_instances SET releasedAt=? WHERE id=?').run(f.w.now, 'old-release');
    expect(await gatewayCheck(access, token)).toMatchObject({ ok: true });
});

it('writes a grant’s lastUsedAt at most once a minute', async () => {
    const f = setup();
    const { access, db } = f.a;
    const { token, grant } = await delegated(access);
    const lastUsed = () =>
        (db.prepare('SELECT lastUsedAt FROM socio_grants WHERE id=?').get(grant.id) as { lastUsedAt: number })
            .lastUsedAt;
    const check = () =>
        access.check(token, {
            kind: 'cbsa',
            audience: 'app:crm',
            action: 'dashboard.view',
            correlationId: 'c',
        });
    const created = lastUsed();
    f.advance(1_000);
    expect(await check()).toMatchObject({ ok: true });
    const first = lastUsed();
    expect(first).toBe(created + 1_000);
    // More uses within the minute: no write (a write would move it).
    f.advance(30_000);
    expect(await check()).toMatchObject({ ok: true });
    f.advance(29_999);
    expect(await check()).toMatchObject({ ok: true });
    expect(lastUsed()).toBe(first);
    // A minute after the last write: moved.
    f.advance(1);
    expect(await check()).toMatchObject({ ok: true });
    expect(lastUsed()).toBe(first + 60_000);
});
