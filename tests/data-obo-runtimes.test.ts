import { afterEach, expect, it } from 'vitest';

import { intentDigest } from '@socio/foundation/actors/principal';
import type { DataTokenScope } from '@socio/foundation/http/app-env';
import { operationTier, dataAction, dataApprovalParams } from '@socio/shared/dataspace/operations';

import { AUTHORIZE_CACHE_MS } from '../src/server/actors/authorize.js';
import type { ActorAccess } from '../src/server/actors/service.js';
import { sqliteApprovals } from '../src/server/approvals/services.js';
import { type AppDataDelegation } from '../src/server/dataspace/contract.js';
import { DataAuthority, type ConsumeDataApproval, type DataRequest } from '../src/server/dataspace/obo.js';
import type { DataSpace } from '../src/server/dataspace/space.js';

import { fixture, grantInput } from './support/actor-fixture.js';

// CB-232 with two runtimes of a deploy on one database (CB-108):
// a cbob_ minted by one runtime's proxy and a
// continuation issued by one are accepted by the other's data API, and a
// revocation on one stops the other within 5 s. No state is kept between
// requests.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const delegation: AppDataDelegation = {
    terms: () => undefined,
    personAccess: (appId, userId) => (appId === 'crm' && userId === 'alice' ? 'owner' : undefined),
    session: () => undefined,
};
// Only what the authority reads of the data space.
const space = {
    delegation,
    datasetFor: () => ({ id: 'ds-deals', ref: 'deals' }),
} as unknown as DataSpace;
const token: DataTokenScope = {
    userId: 'alice',
    dotId: 'rulo',
    purpose: 'app',
    session: 'app:crm',
    appId: 'crm',
    expiresAt: Number.MAX_SAFE_INTEGER,
};
const request = (obo: string, op: DataRequest['op'] = 'insert') => ({
    token,
    actor: {
        kind: 'token' as const,
        purpose: 'app' as const,
        userId: 'alice',
        dotId: 'rulo',
        appId: 'crm',
    },
    obo,
    op,
    dataset: 'deals',
});

const setup = () => {
    const f = fixture(2);
    cleanup.push(() => f.close());
    const b = f.b!;
    return {
        ...f,
        b,
        onA: new DataAuthority(space, f.a.access),
        onB: new DataAuthority(space, b.access),
    };
};

it('gives each data operation its fixed tier, whatever an app declares', () => {
    expect(
        (
            [
                'query',
                'read',
                'files.read',
                'insert',
                'upsert',
                'createTable',
                'addColumn',
                'createIndex',
                'dropIndex',
                'analyze',
                'batch',
                'files.write',
                'deleteRows',
                'dropTable',
                'deleteDataset',
                'files.delete',
            ] as const
        ).map(operationTier),
    ).toEqual([
        'read',
        'read',
        'read',
        'write',
        'write',
        'write',
        'write',
        'write',
        'write',
        'write',
        'write',
        'write',
        'consequential',
        'consequential',
        'consequential',
        'consequential',
    ]);
});

it('accepts on one runtime’s data API what the other runtime issued', async () => {
    const f = setup();
    const grant = await f.a.access.grants.create(grantInput({ scopes: ['app:write'] }));
    const obo = f.a.access.credentials.mintObo({
        appId: 'crm',
        grantId: grant.id,
        requestId: 'req-1',
        ttlMs: 30_000,
    });
    expect(await f.onB.gate(request(obo))).toMatchObject({ ok: true });
    const continuation = await f.a.access.credentials.issue({
        grant,
        kind: 'continuation',
        audiences: ['app:crm'],
        contextId: 'req-1',
        holder: { kind: 'grant', id: grant.id },
        correlationId: 'req-1',
    });
    expect(await f.onB.gate(request(continuation.token))).toMatchObject({
        ok: true,
    });
    // A's runtime exits: nothing it minted dies with it.
    await f.a.session.detach(f.a.db);
    expect(await f.onB.gate(request(obo, 'query'))).toMatchObject({ ok: true });
});

it('stops the other runtime within 5 s of a revocation, and a cbob_ at its expiry', async () => {
    const f = setup();
    const grant = await f.a.access.grants.create(grantInput({ scopes: ['app:write'] }));
    const obo = () =>
        f.a.access.credentials.mintObo({
            appId: 'crm',
            grantId: grant.id,
            requestId: 'req-2',
            ttlMs: 30_000,
        });
    const held = obo();
    expect(await f.onB.gate(request(held))).toMatchObject({ ok: true });
    await f.a.access.revoke({ grantId: grant.id }, 'alice', 'person_revoked');
    // On A at once; on B once its cache (at most 5 s) has lapsed.
    expect(await f.onA.gate(request(held))).toMatchObject({
        ok: false,
        status: 403,
        reason: 'grant_revoked',
    });
    f.advance(AUTHORIZE_CACHE_MS);
    expect(await f.onB.gate(request(held))).toMatchObject({
        ok: false,
        reason: 'grant_revoked',
    });
    // A live grant's cbob_ past the request limit plus 60 s.
    const other = await f.a.access.grants.create(grantInput({ scopes: ['app:write'] }));
    const late = f.a.access.credentials.mintObo({
        appId: 'crm',
        grantId: other.id,
        requestId: 'req-3',
        ttlMs: 30_000,
    });
    f.advance(90_000);
    expect(await f.onB.gate(request(late))).toMatchObject({
        ok: false,
        reason: 'credential_invalid',
    });
});

it('denies, never ignores, a socio when its person can’t write the dataset', async () => {
    const f = setup();
    const grant = await f.a.access.grants.create(grantInput({ personId: 'bob', scopes: ['app:write'] }));
    const obo = f.a.access.credentials.mintObo({
        appId: 'crm',
        grantId: grant.id,
        requestId: 'req-4',
        ttlMs: 30_000,
    });
    // Bob can't open the app (the delegation says nothing of him).
    expect(await f.onB.gate(request(obo, 'query'))).toMatchObject({
        ok: false,
        reason: 'person_no_access',
    });
});

// CB-232: consequential operations through a socio consume
// an approval of `data:<op>` for the digest of this very call. The data
// API's gate, with the consume step faked or on each runtime's approvals.

/** A consequential call with its approval header and its own input. */
const destructive = (obo: string, op: DataRequest['op'], approval?: string, params?: unknown): DataRequest => ({
    ...request(obo, op),
    ...(approval === undefined ? {} : { approval }),
    ...(params === undefined ? {} : { params: () => params }),
});

it('gates every consequential operation on a consumed approval for its own parameters', async () => {
    const f = setup();
    const grant = await f.a.access.grants.create(grantInput({ scopes: ['app:act'] }));
    const obo = () =>
        f.a.access.credentials.mintObo({
            appId: 'crm',
            grantId: grant.id,
            requestId: 'req-6',
            ttlMs: 30_000,
        });
    const asked: Parameters<ConsumeDataApproval>[0][] = [];
    const approved = new Map<string, string>();
    const gate = new DataAuthority(space, f.a.access, async (input) => {
        asked.push(input);
        // Once: what the atomic UPDATE does.
        const ok = approved.get(input.approvalId) === input.digest;
        approved.delete(input.approvalId);
        return ok;
    });
    const cases = [
        ['files.delete', { path: 'reports/q3.csv' }],
        ['deleteRows', { dataset: 'deals', table: 'deals', rowids: [1, 2] }],
        ['dropTable', { dataset: 'deals', table: 'deals' }],
        ['deleteDataset', { dataset: 'deals' }],
    ] as const;
    for (const [i, [op, params]] of cases.entries()) {
        const id = `appr-${i}`;
        // Without one; and without a consume step at all.
        expect(await gate.gate(destructive(obo(), op))).toMatchObject({
            ok: false,
            status: 403,
            reason: 'approval_required',
        });
        expect(await f.onA.gate(destructive(obo(), op, 'appr-x', params))).toMatchObject({
            reason: 'approval_required',
        });
        const digest = intentDigest('crm', dataAction(op), params);
        expect(dataApprovalParams(op, params)).toEqual(params);
        approved.set(id, digest);
        // No input for its parameters, or other ones: not usable.
        expect(await gate.gate(destructive(obo(), op, id))).toMatchObject({
            reason: 'approval_unusable',
        });
        expect(await gate.gate(destructive(obo(), op, id, { ...params, extra: 1 }))).toMatchObject({
            reason: 'approval_unusable',
        });
        expect(asked).toHaveLength(0);
        const changed = op === 'files.delete' ? { path: 'reports/q4.csv' } : { ...params, dataset: 'other' };
        expect(await gate.gate(destructive(obo(), op, id, changed))).toMatchObject({
            reason: 'approval_unusable',
        });
        approved.set(id, digest);
        // The approved call: consumed with this grant, app and digest.
        expect(await gate.gate(destructive(obo(), op, id, params))).toMatchObject({
            ok: true,
        });
        expect(asked.at(-1)).toEqual({
            approvalId: id,
            grantId: grant.id,
            appId: 'crm',
            digest,
            correlationId: 'req-6',
        });
        expect(await gate.gate(destructive(obo(), op, id, params))).toMatchObject({
            reason: 'approval_unusable',
        });
        asked.length = 0;
    }
    // A continuation never spends one; a read ignores one; a stray or
    // malformed header is refused before any lookup.
    const job = await f.a.access.credentials.issue({
        grant,
        kind: 'continuation',
        audiences: ['app:crm'],
        contextId: 'req-job',
        holder: { kind: 'grant', id: grant.id },
        correlationId: 'req-job',
    });
    approved.set('appr-job', intentDigest('crm', 'data:deleteDataset', { dataset: 'deals' }));
    expect(await gate.gate(destructive(job.token, 'deleteDataset', 'appr-job', { dataset: 'deals' }))).toMatchObject({
        ok: false,
        reason: 'approval_unusable',
    });
    expect(await gate.gate(destructive(obo(), 'query', 'appr-job'))).toMatchObject({ ok: true });
    for (const bad of ['', 'a b', 'x'.repeat(65), 'appr/1']) {
        expect(await gate.gate(destructive(obo(), 'deleteDataset', bad, { dataset: 'deals' }))).toMatchObject({
            ok: false,
            status: 400,
        });
    }
    expect(
        await gate.gate({
            ...destructive(obo(), 'deleteDataset', 'appr-job', { dataset: 'deals' }),
            token: { ...token, purpose: 'computer', appId: undefined, session: 's' },
        }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(asked).toHaveLength(0);
});

it('lets an approval consumed through one runtime’s data API never be used through the other’s', async () => {
    const f = setup();
    const grant = await f.a.access.grants.create(grantInput({ scopes: ['app:act'] }));
    // Each runtime's approvals on the one database, as the app registers them.
    const approvalsOn = (runtime: { db: typeof f.a.db; access: ActorAccess }) => {
        const approvals = sqliteApprovals(runtime.db);
        approvals.register({
            capability: 'app_action',
            label: 'Action',
            description: 'A consequential action.',
            consumable: true,
        });
        // What consumeAppAction does: the grant, fresh; then the UPDATE.
        const consume: ConsumeDataApproval = async (input) =>
            (
                await runtime.access.authorizer.authorizeGrant(input.grantId, {
                    fresh: true,
                })
            ).allowed &&
            approvals.consume(input.approvalId, {
                capability: 'app_action',
                digest: input.digest,
                bindingId: input.grantId,
            });
        return {
            approvals,
            gate: new DataAuthority(space, runtime.access, consume),
        };
    };
    const onA = approvalsOn(f.a);
    const onB = approvalsOn(f.b);
    const params = { path: 'reports/q3.csv' };
    const digest = intentDigest('crm', 'data:files.delete', params);
    const approve = async () => {
        const made = await onA.approvals.request({
            userId: 'alice',
            dotId: 'rulo',
            capability: 'app_action',
            summary: 'Delete a file',
            payload: {},
            binding: { digest, bindingId: grant.id },
        });
        await onB.approvals.decide(made.id, 'alice', true);
        return made.id;
    };
    let n = 0;
    const call = (runtime: typeof f.a, approval: string) =>
        destructive(
            runtime.access.credentials.mintObo({
                appId: 'crm',
                grantId: grant.id,
                requestId: `req-${++n}`,
                ttlMs: 30_000,
            }),
            'files.delete',
            approval,
            params,
        );
    const first = await approve();
    expect(await onA.gate.gate(call(f.a, first))).toMatchObject({ ok: true });
    expect(await onB.gate.gate(call(f.b, first))).toMatchObject({
        ok: false,
        reason: 'approval_unusable',
    });
    expect(await onA.gate.gate(call(f.a, first))).toMatchObject({
        reason: 'approval_unusable',
    });
    // (Both at the same moment is one process's two connections here, which
    // would wait on each other's write lock; data-obo.test.ts races uses on
    // one runtime, and the UPDATE is the same statement on either.)
});
