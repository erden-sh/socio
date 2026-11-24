import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { intentDigest } from '@socio/foundation/actors/principal';
import type { ActorScope, Audience } from '@socio/shared/actor-scopes';
import { parseAppManifest } from '@socio/shared/apps/app-manifest';
import { SOCIO_ACCESS_APPROVAL_TTL_MS, type AppActionCard } from '@socio/shared/socio-access';

import { consumeAppAction, requestAppAction } from '../src/server/actors/approvals.js';
import { ActorCredentials } from '../src/server/actors/credentials.js';
import { ACTOR_ACCESS_CONTRACT } from '../src/server/actors/principal.js';
import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import type { DataContractTerms } from '../src/server/dataspace/contract.js';
import { dataTokenAppId } from '../src/server/dataspace/tokens.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-232: the data API
// narrows an app's data token to the actor its request's `x-cb-obo`
// names, and refuses a contract app's writes without one. Negative cases
// first. The apps module's side (manifest terms, app sessions, the `app`
// audience) is faked here: the apps module registers the real ones.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const SECRET = 'secret-0123456789abcdef-xyz';

async function fixture(flags: Record<string, boolean> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-data-obo-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            sessionSecret: SECRET,
            data: { userDataDir: dir },
            // Its flags are in development: only an internal deployment has them (CB-503).
            deploymentKind: 'internal',
            featureFlags: { 'socio-actor-access': true, ...flags },
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, SECRET),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    const login = await app.request('/api/auth/mock/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'alice' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const alice = (path: string, method = 'GET', body?: unknown, obo?: string) =>
        app.request(`/api${path}`, {
            method,
            headers: {
                cookie,
                ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                ...(obo === undefined ? {} : { 'x-cb-obo': obo }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const socio = workspace.dots()[0]!;
    const chat = workspace.bindThread('chat-1', socio.id, 'Pipeline', 'alice');
    const deals = (await (await alice('/data/datasets', 'POST', { name: 'Deals' })).json()) as { id: string };
    const cache = (await (await alice('/data/datasets', 'POST', { name: 'Cache' })).json()) as { id: string };
    // The datasets each promoted app was granted at promotion.
    platform.data.useAppGrants((appId) =>
        appId === 'crm'
            ? [
                  { datasetId: deals.id, access: 'write', ref: 'deals' },
                  { datasetId: cache.id, access: 'write', ref: 'cache' },
              ]
            : appId === 'other'
              ? [{ datasetId: deals.id, access: 'write', ref: 'deals' }]
              : [],
    );
    // What the apps module will say: manifest terms, people, sessions.
    const terms = new Map<string, DataContractTerms>();
    const access = new Map<string, 'owner' | 'space'>([
        ['crm|alice', 'owner'],
        ['other|alice', 'owner'],
        ['dev1|alice', 'owner'],
    ]);
    const sessions = new Map<string, { appId: string; userId: string }>();
    const delegation = {
        terms: (appId: string) => terms.get(appId),
        personAccess: (appId: string, userId: string) => access.get(`${appId}|${userId}`),
        session: (appId: string, hash: string) => {
            const found = sessions.get(hash);
            return found?.appId === appId ? { userId: found.userId } : undefined;
        },
    };
    // The app audience (the apps module's policy): delegable at version v1.
    const versions = new Map([
        ['app:crm', 'v1'],
        ['app:other', 'v1'],
        ['app:dev1', 'v1'],
    ]);
    const unregister = platform.actors.audiences.register('app', {
        policyVersion: (audience) => versions.get(audience),
        personMay: () => true,
    });
    const tokens = {
        crm: platform.data.tokens.issue({
            userId: 'alice',
            dotId: socio.id,
            purpose: 'app',
            session: 'app:crm',
            appId: 'crm',
        }),
        other: platform.data.tokens.issue({
            userId: 'alice',
            dotId: socio.id,
            purpose: 'app',
            session: 'app:other',
            appId: 'other',
        }),
        // A development app's token: no `appId`, its session names it.
        dev1: platform.data.tokens.issue({
            userId: 'alice',
            dotId: socio.id,
            purpose: 'app',
            session: 'app:dev1',
            datasetIds: [deals.id],
        }),
        computer: platform.data.tokens.forCommand('alice', socio.id, 60_000, 'person').token,
    };
    // An app calling back to the data API, as the SDK's data client does.
    const call = (
        token: string,
        path: string,
        method = 'GET',
        body?: unknown,
        obo?: string,
        headers: Record<string, string> = {},
    ) =>
        app.request(`http://company-brain-app:4310/api${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...(obo === undefined ? {} : { 'x-cb-obo': obo }),
                ...headers,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const grant = (scopes: ActorScope[], audience: Audience = 'app:crm') =>
        platform.actors.grants.create({
            personId: 'alice',
            socioId: socio.id,
            audiences: [audience],
            scopes,
            conversationId: chat.id,
            conversationKind: 'private',
            task: 'Check the pipeline',
            policyVersion: 'v1',
            approvedBy: 'alice',
            correlationId: 'corr-grant',
        });
    let requests = 0;
    const obo = (grantId: string, appId = 'crm') =>
        platform.actors.credentials.mintObo({
            appId,
            grantId,
            requestId: `req-${++requests}`,
            ttlMs: 30_000,
        });
    const personObo = (sessionHash: string, appId = 'crm') =>
        platform.actors.credentials.mintObo({
            appId,
            sessionHash,
            requestId: `req-${++requests}`,
            ttlMs: 30_000,
        });
    // The app made its table before adopting the contract (no terms yet).
    for (const ref of ['deals', 'cache']) {
        expect(
            (
                await call(tokens.crm, `/data/datasets/${ref}/tables`, 'POST', {
                    table: 'deals',
                    columns: [
                        { name: 'name', type: 'TEXT', primaryKey: true },
                        { name: 'stage', type: 'TEXT' },
                    ],
                })
            ).status,
        ).toBe(200);
    }
    const register = () => platform.data.useAppDelegation(delegation);
    register();
    return {
        platform,
        workspace,
        socio,
        chat,
        deals,
        cache,
        terms,
        access,
        sessions,
        versions,
        unregister,
        tokens,
        call,
        alice,
        grant,
        obo,
        personObo,
    };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
let names = 0;
const insert = (f: Fixture, token: string, obo?: string, ref = 'deals') =>
    f.call(
        token,
        `/data/datasets/${ref}/tables/deals/rows`,
        'POST',
        { rows: [{ name: `Acme ${++names}`, stage: 'won' }] },
        obo,
    );
const query = (f: Fixture, token: string, obo?: string, ref = 'deals') =>
    f.call(token, `/data/datasets/${ref}/query`, 'POST', { sql: 'SELECT count(*) AS n FROM deals' }, obo);
const count = async (f: Fixture, ref = 'deals') =>
    (
        (await (await query(f, f.tokens.crm, undefined, ref)).json()) as {
            rows: number[][];
        }
    ).rows[0]![0];
/** The data API's rows in `actor_audit`, oldest first. */
const audit = (f: Fixture) =>
    f.platform.actors.audit
        .list({})
        .filter((row) => row.audience)
        .sort((a, b) => a.id - b.id);

it('refuses x-cb-obo on anything but an app’s data token', async () => {
    const f = await fixture();
    const { id } = await f.grant(['app:write']);
    // A computer command's token, and a person's own session.
    expect((await query(f, f.tokens.computer, f.obo(id))).status).toBe(400);
    expect((await f.alice(`/data/datasets/${f.deals.id}/query`, 'POST', { sql: 'SELECT 1' }, f.obo(id))).status).toBe(
        400,
    );
});

it('refuses a forged, foreign, expired or revoked cbob_ and never falls back to the app’s rights', async () => {
    const f = await fixture();
    const { id } = await f.grant(['app:write']);
    for (const bad of [
        '',
        'cbob_v1.' + 'A'.repeat(60),
        'cbsa_' + 'A'.repeat(43),
        'Bearer whatever',
        // Another app's cbob_ with this app's token (cross-app replay).
        f.obo(id, 'other'),
    ]) {
        const response = await insert(f, f.tokens.crm, bad);
        expect(response.status, bad).toBe(403);
        expect(await response.text()).not.toContain('cbob_');
    }
    // A cbob_ of this app with another app's token.
    expect((await insert(f, f.tokens.other, f.obo(id))).status).toBe(403);
    expect(await count(f)).toBe(0);
    // Expired (the proxy's request limit plus 60 s), or sealed by another
    // instance's secret.
    const minter = (secret: string, now: () => number) =>
        new ActorCredentials(f.workspace.db, {
            secret,
            audit: f.platform.actors.audit,
            runtimeId: 'elsewhere',
            issuable: () => true,
            now,
        });
    const mint = (credentials: ActorCredentials) =>
        credentials.mintObo({
            appId: 'crm',
            grantId: id,
            requestId: 'req-x',
            ttlMs: 30_000,
        });
    expect((await query(f, f.tokens.crm, mint(minter(SECRET, () => Date.now() - 91_000)))).status).toBe(403);
    expect((await query(f, f.tokens.crm, mint(minter('another-instance-secret-0123456789', Date.now)))).status).toBe(
        403,
    );
    // The same, minted here and now: accepted.
    expect((await query(f, f.tokens.crm, mint(minter(SECRET, Date.now)))).status).toBe(200);
    // Revoked: the next call fails, on this runtime at once.
    const live = f.obo(id);
    expect((await insert(f, f.tokens.crm, live)).status).toBe(200);
    await f.platform.actors.revoke({ grantId: id }, 'alice', 'person_revoked');
    const after = await insert(f, f.tokens.crm, live);
    expect(after.status).toBe(403);
    expect(((await after.json()) as { error: string }).error).toMatch(/revoked/);
    expect(await count(f)).toBe(1);
});

it('keeps a read-only socio from writing through the app, whatever the app’s route', async () => {
    const f = await fixture();
    const { id } = await f.grant(['app:read']);
    // The app's GET route that writes: refused at the data API
    // ("read-only is semantic").
    for (const [path, body] of [
        ['/data/datasets/deals/tables/deals/rows', { rows: [{ name: 'X' }] }],
        ['/data/datasets/deals/tables/deals/rows', { rows: [{ name: 'X' }], key: ['name'] }],
        ['/data/datasets/deals/tables', { table: 'more', columns: [{ name: 'a', type: 'TEXT' }] }],
        ['/data/datasets/deals/tables/deals/columns', { column: { name: 'owner', type: 'TEXT' } }],
    ] as const) {
        const response = await f.call(f.tokens.crm, path, 'POST', body, f.obo(id));
        expect(response.status, path).toBe(403);
    }
    expect(await count(f)).toBe(0);
    // The app's POST route that only queries: allowed.
    expect((await query(f, f.tokens.crm, f.obo(id))).status).toBe(200);
    expect((await f.call(f.tokens.crm, '/data/datasets', 'GET', undefined, f.obo(id))).status).toBe(200);
    expect((await f.call(f.tokens.crm, '/data/datasets/deals', 'GET', undefined, f.obo(id))).status).toBe(200);
    const denies = audit(f).filter((row) => row.decision === 'deny');
    expect(denies.map((row) => `${row.action}:${row.reason}`).sort()).toEqual([
        'addColumn:scope_insufficient',
        'createTable:scope_insufficient',
        'insert:scope_insufficient',
        'upsert:scope_insufficient',
    ]);
    expect(denies.every((row) => row.grantId === id)).toBe(true);
    expect(denies.every((row) => /^req-\d+$/.test(row.correlationId))).toBe(true);
});

it('lets a write grant write, records each outcome under the request, and stores no secrets', async () => {
    const f = await fixture();
    const { id } = await f.grant(['app:write']);
    const token = f.obo(id);
    expect((await insert(f, f.tokens.crm, token)).status).toBe(200);
    expect(
        (
            await f.call(
                f.tokens.crm,
                '/data/datasets/deals/tables/deals/rows',
                'POST',
                { rows: [{ name: 'Acme', stage: 'lost' }], key: ['name'] },
                token,
            )
        ).status,
    ).toBe(200);
    expect(await count(f)).toBe(2);
    const rows = audit(f);
    const outcomes = rows.filter((row) => row.phase === 'outcome');
    expect(outcomes.map((row) => `${row.action}:${row.status}`)).toEqual(['insert:200', 'upsert:200']);
    expect(outcomes[0]).toMatchObject({
        grantId: id,
        personId: 'alice',
        socioId: f.socio.id,
        audience: 'app:crm',
        tier: 'write',
        resourceKind: 'dataset',
        resourceId: f.deals.id,
        correlationId: 'req-1',
    });
    expect(JSON.stringify(rows)).not.toMatch(/cbob_|cbdt_|cbsa_|Acme/);
    // The grant's use is its last use (idle expiry).
    await vi.waitFor(() => expect(f.platform.actors.grants.get(id)!.lastUsedAt).toBeGreaterThan(0));
});

it('bounds a socio by its person’s own rights in the app', async () => {
    const f = await fixture();
    const { id } = await f.grant(['app:write']);
    // Alice only reaches the app through its Space now.
    f.access.set('crm|alice', 'space');
    expect((await insert(f, f.tokens.crm, f.obo(id))).status).toBe(403);
    expect((await query(f, f.tokens.crm, f.obo(id))).status).toBe(200);
    // The app lets Space members write that dataset (`spaceAccess`).
    f.terms.set('crm', {
        background: [],
        backgroundRead: true,
        spaceAccess: { deals: 'write' },
    });
    expect((await insert(f, f.tokens.crm, f.obo(id))).status).toBe(200);
    expect((await insert(f, f.tokens.crm, f.obo(id), 'cache')).status).toBe(403);
    // And can't open it at all.
    f.access.delete('crm|alice');
    expect((await query(f, f.tokens.crm, f.obo(id))).status).toBe(403);
    expect(
        audit(f)
            .filter((row) => row.decision === 'deny')
            .map((row) => row.reason),
    ).toEqual(['person_no_access', 'person_no_access', 'person_no_access']);
});

it('fails closed without the apps module’s side: no terms, people or audience', async () => {
    const f = await fixture();
    const { id } = await f.grant(['app:write']);
    // No delegation registered: nobody's rights can be known.
    f.platform.data.useAppDelegation({
        terms: () => undefined,
        personAccess: () => undefined,
        session: () => undefined,
    });
    expect((await query(f, f.tokens.crm, f.obo(id))).status).toBe(403);
    // No `app` audience policy: unavailable.
    f.unregister();
    f.platform.actors.authorizer.invalidate();
    expect((await query(f, f.tokens.crm, f.obo(id))).status).toBe(403);
    expect(
        audit(f)
            .filter((row) => row.decision === 'deny')
            .map((row) => row.reason),
    ).toEqual(['person_no_access', 'audience_unavailable']);
});

it('refuses socios when the feature is off for their person, or the version changed', async () => {
    const f = await fixture({ 'socio-actor-access': false });
    const { id } = await f.grant(['app:write']);
    expect((await query(f, f.tokens.crm, f.obo(id))).status).toBe(403);
    const g = await fixture();
    const write = await g.grant(['app:write']);
    g.versions.set('app:crm', 'v2');
    expect((await insert(g, g.tokens.crm, g.obo(write.id))).status).toBe(403);
    expect([...audit(f), ...audit(g)].filter((row) => row.decision === 'deny').map((row) => row.reason)).toEqual([
        'feature_off',
        'policy_stale',
    ]);
});

it('refuses consequential data operations through a socio without an approval', async () => {
    const f = await fixture();
    // Even `act`, the widest scope, can only ask.
    const { id } = await f.grant(['app:act'], 'app:dev1');
    const response = await f.call(f.tokens.dev1, '/data/files?path=report.txt', 'DELETE', undefined, f.obo(id, 'dev1'));
    expect(response.status).toBe(403);
    expect(audit(f).at(-1)).toMatchObject({
        decision: 'deny',
        reason: 'approval_required',
        action: 'files.delete',
        tier: 'consequential',
        grantId: id,
    });
    // A development app's token is bound to its own app id.
    expect(dataTokenAppId({ purpose: 'app', session: 'app:dev1', appId: undefined })).toBe('dev1');
    expect(dataTokenAppId({ purpose: 'computer', session: 'app:dev1' })).toBeUndefined();
    // A file write is `write`: allowed.
    expect(
        (await f.call(f.tokens.dev1, '/data/files', 'PUT', { path: 'report.txt', content: 'hi' }, f.obo(id, 'dev1')))
            .status,
    ).toBe(200);
});

it('refuses a contract app’s writes without x-cb-obo, except to its background datasets', async () => {
    const f = await fixture();
    // Before adopting the contract, the app's own token writes as before.
    expect((await insert(f, f.tokens.crm)).status).toBe(200);
    f.terms.set('crm', { background: ['cache'], backgroundRead: true });
    // Its own token alone can no longer write what a person's request should.
    expect((await insert(f, f.tokens.crm)).status).toBe(403);
    for (const [path, method, body] of [
        ['/data/datasets/deals/tables', 'POST', { table: 'x', columns: [{ name: 'a', type: 'TEXT' }] }],
        ['/data/datasets/deals/tables/deals/columns', 'POST', { column: { name: 'owner', type: 'TEXT' } }],
        // Files have no background list.
        ['/data/files', 'PUT', { path: 'a.txt', content: 'a' }],
    ] as const) {
        expect((await f.call(f.tokens.crm, path, method, body)).status, path).toBe(403);
    }
    // Background: its own jobs refresh the cache, by ref or id.
    expect((await insert(f, f.tokens.crm, undefined, 'cache')).status).toBe(200);
    expect((await insert(f, f.tokens.crm, undefined, f.cache.id)).status).toBe(200);
    expect(await count(f, 'cache')).toBe(2);
    // Reads without obo stay (dashboards that cache)...
    expect((await query(f, f.tokens.crm)).status).toBe(200);
    // ...unless the manifest turns them off.
    f.terms.set('crm', { background: ['cache'], backgroundRead: false });
    expect((await query(f, f.tokens.crm)).status).toBe(403);
    expect((await f.call(f.tokens.crm, '/data/datasets', 'GET')).status).toBe(403);
    // With a person's request, as before.
    const { id } = await f.grant(['app:write']);
    expect((await insert(f, f.tokens.crm, f.obo(id))).status).toBe(200);
    expect((await query(f, f.tokens.crm, f.obo(id))).status).toBe(200);
    f.terms.set('crm', { background: ['cache'], backgroundRead: true });
    expect(await count(f)).toBe(2);
    const denies = audit(f).filter((row) => row.reason === 'obo_required');
    expect(denies.length).toBeGreaterThanOrEqual(5);
    expect(denies.every((row) => row.audience === 'app:crm')).toBe(true);
    // Other apps are untouched.
    expect((await insert(f, f.tokens.other)).status).toBe(200);
});

it('narrows a person’s own session: owner writes, Space member reads', async () => {
    const f = await fixture();
    f.sessions.set('hash-alice', { appId: 'crm', userId: 'alice' });
    expect((await insert(f, f.tokens.crm, f.personObo('hash-alice'))).status).toBe(200);
    f.access.set('crm|alice', 'space');
    expect((await insert(f, f.tokens.crm, f.personObo('hash-alice'))).status).toBe(403);
    expect((await query(f, f.tokens.crm, f.personObo('hash-alice'))).status).toBe(200);
    // A session that ended, or another app's.
    expect((await query(f, f.tokens.crm, f.personObo('hash-gone'))).status).toBe(403);
    f.sessions.set('hash-other', { appId: 'other', userId: 'alice' });
    expect((await query(f, f.tokens.crm, f.personObo('hash-other'))).status).toBe(403);
});

it('lets an app’s token ANALYZE only the datasets it was granted write on (CB-355)', async () => {
    const f = await fixture();
    const analyze = (token: string, ref: string, table?: string, obo?: string) =>
        f.call(
            token,
            table ? `/data/datasets/${ref}/tables/${table}/analyze` : `/data/datasets/${ref}/analyze`,
            'POST',
            {},
            obo,
        );
    // Its own token, before any contract: one table, or every one, by ref or id.
    const one = await analyze(f.tokens.crm, 'deals', 'deals');
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ status: 'done', result: { analyzed: ['deals'] } });
    const all = await analyze(f.tokens.crm, f.cache.id);
    expect(all.status).toBe(200);
    expect(await all.json()).toMatchObject({ status: 'done', result: { analyzed: ['deals'] } });
    expect((await analyze(f.tokens.crm, 'deals', 'nope')).status).toBe(404);
    // Another app reaches only its own grant; nobody reaches the person's other data.
    expect((await analyze(f.tokens.other, 'deals')).status).toBe(200);
    expect((await analyze(f.tokens.other, f.cache.id)).status).toBe(404);
    const own = (await (await f.alice('/data/datasets', 'POST', { name: 'Private' })).json()) as { id: string };
    expect((await analyze(f.tokens.crm, own.id)).status).toBe(404);
    expect((await analyze(f.tokens.crm, 'Private')).status).toBe(404);
    // A read grant doesn't let it ANALYZE: it is a write.
    f.platform.data.useAppGrants((appId) =>
        appId === 'crm' ? [{ datasetId: f.deals.id, access: 'read', ref: 'deals' }] : [],
    );
    const readOnly = await analyze(f.tokens.crm, 'deals');
    expect(readOnly.status).toBe(403);
    expect(await readOnly.text()).toMatch(/may only read/);
    f.platform.data.useAppGrants((appId) =>
        appId === 'crm'
            ? [
                  { datasetId: f.deals.id, access: 'write', ref: 'deals' },
                  { datasetId: f.cache.id, access: 'write', ref: 'cache' },
              ]
            : [],
    );
    // A contract app: on its own only on its background datasets...
    f.terms.set('crm', { background: ['cache'], backgroundRead: true });
    expect((await analyze(f.tokens.crm, 'cache')).status).toBe(200);
    expect((await analyze(f.tokens.crm, 'deals', 'deals')).status).toBe(403);
    // ...and for a socio, only under a write grant.
    const read = await f.grant(['app:read']);
    expect((await analyze(f.tokens.crm, 'deals', undefined, f.obo(read.id))).status).toBe(403);
    const write = await f.grant(['app:write']);
    expect((await analyze(f.tokens.crm, 'deals', undefined, f.obo(write.id))).status).toBe(200);
    expect(
        audit(f)
            .filter((row) => row.decision === 'deny' && row.action === 'analyze')
            .map((row) => row.reason)
            .sort(),
    ).toEqual(['obo_required', 'scope_insufficient']);
    // Audited in the person's data log as the token's.
    const log = (await (await f.alice('/data/audit')).json()) as Array<{
        actorKind: string;
        action: string;
        detail: string | null;
    }>;
    expect(log.filter((entry) => entry.action === 'analyze').map((e) => [e.actorKind, e.detail])).toEqual(
        expect.arrayContaining([
            ['token', 'analyze deals'],
            ['token', 'analyze every table'],
        ]),
    );
});

it('accepts a continuation for its app while its grant lives, never wider than issued', async () => {
    const f = await fixture();
    const grant = await f.grant(['app:write']);
    const issue = (scopes?: ActorScope[], audience: Audience = 'app:crm') =>
        f.platform.actors.credentials.issue({
            grant,
            kind: 'continuation',
            audiences: [audience],
            ...(scopes ? { scopes } : {}),
            contextId: 'req-job',
            holder: { kind: 'grant', id: grant.id },
            correlationId: 'req-job',
        });
    const job = await issue();
    expect((await insert(f, f.tokens.crm, job.token)).status).toBe(200);
    expect(audit(f).find((row) => row.phase === 'outcome')).toMatchObject({
        correlationId: 'req-job',
        grantId: grant.id,
    });
    // Another app's token can't use it.
    expect((await insert(f, f.tokens.other, job.token)).status).toBe(403);
    // A read-only continuation of a write grant reads only.
    const reader = await issue(['app:read']);
    expect((await insert(f, f.tokens.crm, reader.token)).status).toBe(403);
    expect((await query(f, f.tokens.crm, reader.token)).status).toBe(200);
    // The grant ends: so does the job.
    await f.platform.actors.revoke({ grantId: grant.id }, 'alice', 'person_revoked');
    expect((await insert(f, f.tokens.crm, job.token)).status).toBe(403);
    expect(await count(f)).toBe(1);
});

it('records contract 2 for this runtime, so no grant is issued beside an older one', async () => {
    const f = await fixture();
    expect(ACTOR_ACCESS_CONTRACT).toBe(2);
    expect(f.workspace.db.prepare("SELECT version FROM runtime_contracts WHERE contract='actor-access'").all()).toEqual(
        [{ version: 2 }],
    );
    expect(f.platform.actors.issuable()).toBe(true);
    // A release with contract 1 still alive beside this one: nothing issued.
    const now = Date.now();
    f.workspace.db
        .prepare('INSERT INTO runtime_instances VALUES(?,?,?,?,NULL)')
        .run('a0-release', now, now, now + 60_000);
    f.workspace.db.prepare('INSERT INTO runtime_contracts VALUES(?,?,?)').run('a0-release', 'actor-access', 1);
    expect(f.platform.actors.issuable()).toBe(false);
    await expect(f.grant(['app:read'])).rejects.toMatchObject({
        reason: 'contract_outdated',
    });
});

// CB-232: a socio's consequential data operation through
// an app consumes an approval of the reserved action `data:<op>` bound to
// that exact call. The app asks with `requestAppAction` (what
// `POST /api/apps/actor/approvals` calls; apps-actor-proxy.test.ts runs
// the route); the data API consumes it. Refusals first.
//
// The data layer itself still refuses an app token's file delete
// (`deleteFileAs` serves company socios' computer commands only, CB-229),
// so these tests record the route's work with a spy: "performed" is the
// work being reached after the gate. The last test runs the real one.
describe('a socio’s consequential data operation with an approval', () => {
    /** The card facts the approval reads of the app (AppsService, faked). */
    const withApps = (f: Fixture) => {
        vi.spyOn(f.platform.apps, 'enabled', 'get').mockReturnValue(true);
        vi.spyOn(f.platform.apps, 'get').mockImplementation(
            (id) =>
                ({
                    id,
                    name: id.toUpperCase(),
                    ownerUserId: 'alice',
                    status: 'ephemeral',
                }) as never,
        );
        vi.spyOn(f.platform.apps, 'access').mockReturnValue('owner');
        vi.spyOn(f.platform.apps, 'url').mockImplementation((app) => `http://${app.id}.apps.localhost:4310`);
    };
    let asks = 0;
    const ask = (f: Fixture, grantId: string, params: unknown, action = 'data:files.delete', appId = 'dev1') =>
        requestAppAction(f.platform, {
            grantId,
            appId,
            action,
            params,
            display: { Summary: 'Clean up the old report' },
            correlationId: `ask-${++asks}`,
        });
    const asked = async (...args: Parameters<typeof ask>) => {
        const result = await ask(...args);
        if (!result.ok) {
            throw new Error(`Refused: ${result.reason}`);
        }
        return result.approval.id;
    };
    const put = (f: Fixture, path: string, obo: string) =>
        f.call(f.tokens.dev1, '/data/files', 'PUT', { path, content: 'quarterly numbers' }, obo);
    const del = (f: Fixture, path: string, obo: string | undefined, approval?: string, token = f.tokens.dev1) =>
        f.call(
            token,
            `/data/files?path=${encodeURIComponent(path)}`,
            'DELETE',
            undefined,
            obo,
            approval === undefined ? {} : { 'x-cb-approval': approval },
        );
    const setup = async ({ stub = true } = {}) => {
        const f = await fixture();
        withApps(f);
        const act = await f.grant(['app:act'], 'app:dev1');
        const dev = (grantId = act.id) => f.obo(grantId, 'dev1');
        expect((await put(f, 'report.txt', dev())).status).toBe(200);
        expect((await put(f, 'keep.txt', dev())).status).toBe(200);
        // The paths the route's work was asked to delete.
        const performed: string[] = [];
        if (stub) {
            vi.spyOn(f.platform.data, 'deleteFileAs').mockImplementation(
                async (_actor, path) => void performed.push(path),
            );
        }
        return { f, act, dev, performed };
    };

    it('refuses a malformed, unknown, pending, denied or expired approval, and deletes nothing', async () => {
        const { f, act, dev, performed } = await setup();
        // No approval at all.
        expect((await del(f, 'report.txt', dev())).status).toBe(403);
        // Not shaped like an approval id: refused before any lookup.
        for (const bad of ['bad id', 'x'.repeat(65), '../x', '']) {
            expect((await del(f, 'report.txt', dev(), bad)).status, bad).toBe(400);
        }
        // Only with an app's token and x-cb-obo.
        expect((await del(f, 'report.txt', undefined, 'appr-1')).status).toBe(400);
        expect((await del(f, 'report.txt', dev(), 'appr-1', f.tokens.computer)).status).toBe(400);
        // Unknown.
        expect((await del(f, 'report.txt', dev(), 'no-such-approval')).status).toBe(403);
        // Waiting for the person.
        const pending = await asked(f, act.id, { path: 'report.txt' });
        expect((await del(f, 'report.txt', dev(), pending)).status).toBe(403);
        // Denied.
        await f.platform.approvals.decide(pending, 'alice', false);
        expect((await del(f, 'report.txt', dev(), pending)).status).toBe(403);
        // Expired.
        const late = await asked(f, act.id, { path: 'report.txt' });
        await f.platform.approvals.expire(Date.now() + SOCIO_ACCESS_APPROVAL_TTL_MS + 1);
        expect((await del(f, 'report.txt', dev(), late)).status).toBe(403);
        expect(performed).toEqual([]);
        const reasons = audit(f)
            .filter((row) => row.phase === 'decision' && row.decision === 'deny')
            .map((row) => row.reason);
        expect(reasons).toEqual([
            'approval_required',
            'approval_unusable',
            'approval_unusable',
            'approval_unusable',
            'approval_unusable',
        ]);
    });

    it('runs an approved delete exactly once, for that path only', async () => {
        const { f, act, dev, performed } = await setup();
        const id = await asked(f, act.id, { path: 'report.txt' });
        await f.platform.approvals.decide(id, 'alice', true);
        // Another path with this approval: refused, and it stays usable.
        expect((await del(f, 'keep.txt', dev(), id)).status).toBe(403);
        expect((await del(f, 'Report.txt', dev(), id)).status).toBe(403);
        expect(performed).toEqual([]);
        // The app can't spend it itself through the consume route.
        expect(
            await consumeAppAction(f.platform, {
                approvalId: id,
                grantId: act.id,
                appId: 'dev1',
                digest: intentDigest('dev1', 'data:files.delete', {
                    path: 'report.txt',
                }),
                correlationId: 'app-consume',
            }),
        ).toBe(false);
        // The call it was approved for: once.
        expect((await del(f, 'report.txt', dev(), id)).status).toBe(200);
        expect(performed).toEqual(['report.txt']);
        const again = await del(f, 'report.txt', dev(), id);
        expect(again.status).toBe(403);
        expect(performed).toEqual(['report.txt']);
        expect((await f.platform.approvals.get(id, 'alice')).consumedAt).toEqual(expect.any(Number));
    });

    it('lets exactly one of concurrent uses succeed', async () => {
        const { f, act, dev, performed } = await setup();
        const id = await asked(f, act.id, { path: 'report.txt' });
        await f.platform.approvals.decide(id, 'alice', true);
        const statuses = await Promise.all(
            Array.from({ length: 6 }, async () => (await del(f, 'report.txt', dev(), id)).status),
        );
        expect(statuses.filter((status) => status === 200)).toHaveLength(1);
        expect(statuses.filter((status) => status === 403)).toHaveLength(5);
        expect(performed).toEqual(['report.txt']);
    });

    it('is bound to its grant’s cbob_, its app’s token and a live grant; a job can’t spend it', async () => {
        const { f, act, dev, performed } = await setup();
        const id = await asked(f, act.id, { path: 'report.txt' });
        await f.platform.approvals.decide(id, 'alice', true);
        // Another grant of the same person, socio and app.
        const other = await f.grant(['app:act'], 'app:dev1');
        expect((await del(f, 'report.txt', dev(other.id), id)).status).toBe(403);
        // Another app's token, with its own socio request.
        const crm = await f.grant(['app:act']);
        expect((await del(f, 'report.txt', f.obo(crm.id), id, f.tokens.crm)).status).toBe(403);
        // Another app's token with this app's cbob_.
        expect((await del(f, 'report.txt', dev(), id, f.tokens.crm)).status).toBe(403);
        // A continuation of the very grant: a job doesn't spend approvals.
        const job = await f.platform.actors.credentials.issue({
            grant: act,
            kind: 'continuation',
            audiences: ['app:dev1'],
            contextId: 'req-job',
            holder: { kind: 'grant', id: act.id },
            correlationId: 'req-job',
        });
        expect((await del(f, 'report.txt', job.token, id)).status).toBe(403);
        expect(performed).toEqual([]);
        // None of that used it. The grant ends: neither the approval nor its
        // grant's requests can delete any more.
        await f.platform.actors.revoke({ grantId: act.id }, 'alice', 'person_revoked');
        expect((await del(f, 'report.txt', dev(), id)).status).toBe(403);
        expect(performed).toEqual([]);
        expect((await f.platform.approvals.get(id, 'alice')).consumedAt ?? null).toBeNull();
    });

    it('asks only for consequential operations, with their own parameters, for a socio with app:act', async () => {
        const { f, act } = await setup();
        for (const op of ['files.read', 'files.write', 'insert', 'query']) {
            expect(await ask(f, act.id, { path: 'a' }, `data:${op}`)).toMatchObject({
                ok: false,
                status: 400,
                reason: 'not_consequential',
            });
        }
        expect(await ask(f, act.id, {}, 'data:nope')).toMatchObject({
            status: 403,
            reason: 'action_undeclared',
        });
        for (const params of [{}, { path: '' }, { path: 'a', also: 'b' }, { path: 1 }, ['a']]) {
            expect(await ask(f, act.id, params)).toMatchObject({
                status: 400,
                reason: 'request_malformed',
            });
        }
        // A write grant can't even ask.
        const write = await f.grant(['app:write'], 'app:dev1');
        expect(await ask(f, write.id, { path: 'report.txt' })).toMatchObject({
            status: 403,
            reason: 'scope_insufficient',
        });
        expect(await f.platform.approvals.list('alice')).toEqual([]);
        // The card names Socio's operation, then the app's own words.
        const id = await asked(f, act.id, { path: 'report.txt' });
        const card = (await f.platform.approvals.get(id, 'alice')).card as AppActionCard;
        expect(card).toMatchObject({
            kind: 'app_action',
            action: 'data:files.delete',
            tier: 'consequential',
            operation: {
                op: 'files.delete',
                words: 'delete a file from the app’s files',
            },
            params: { preview: '{"path":"report.txt"}', complete: true },
            display: [{ label: 'Summary', value: 'Clean up the old report' }],
        });
        // Asking again for the same call finds the same card.
        expect(await asked(f, act.id, { path: 'report.txt' })).toBe(id);
    });

    it('lets a person delete through their own session without one', async () => {
        const { f, performed } = await setup();
        f.sessions.set('hash-alice', { appId: 'dev1', userId: 'alice' });
        expect((await del(f, 'report.txt', f.personObo('hash-alice', 'dev1'))).status).toBe(200);
        expect(performed).toEqual(['report.txt']);
    });

    it('records the use by approval id and digest, never the path or a token', async () => {
        const { f, act, dev, performed } = await setup();
        const secret = 'payroll-TOP-SECRET.txt';
        expect((await put(f, secret, dev())).status).toBe(200);
        const id = await asked(f, act.id, { path: secret });
        await f.platform.approvals.decide(id, 'alice', true);
        const obo = dev();
        expect((await del(f, secret, obo, id)).status).toBe(200);
        expect((await del(f, secret, obo, id)).status).toBe(403);
        expect(performed).toEqual([secret]);
        const digest = intentDigest('dev1', 'data:files.delete', { path: secret });
        await vi.waitFor(() =>
            expect(audit(f).find((row) => row.phase === 'outcome' && row.action === 'files.delete')).toMatchObject({
                grantId: act.id,
                tier: 'consequential',
                resourceKind: 'approval',
                resourceId: id,
                digest,
                status: '200',
            }),
        );
        const rows = f.platform.actors.audit.list({});
        const outcome = rows.find((row) => row.phase === 'outcome' && row.action === 'files.delete')!;
        // The consume and the outcome share the request's correlation id.
        expect(rows.find((row) => row.phase === 'approval' && row.status === 'consumed')).toMatchObject({
            correlationId: outcome.correlationId,
            digest,
        });
        expect(outcome.correlationId).toMatch(/^req-\d+$/);
        expect(JSON.stringify(rows)).not.toMatch(/payroll|TOP-SECRET|cbob_|cbdt_|cbsa_/);
    });

    it('keeps the approval used when the operation then fails (today’s data layer refuses app tokens)', async () => {
        const { f, act, dev } = await setup({ stub: false });
        const id = await asked(f, act.id, { path: 'report.txt' });
        await f.platform.approvals.decide(id, 'alice', true);
        // Past the gate, the data layer refuses an app token's delete.
        const done = await del(f, 'report.txt', dev(), id);
        expect(done.status).toBe(403);
        expect(await done.text()).toMatch(/data token can’t do this/);
        // Single use: the app retries with a new approval.
        expect((await f.platform.approvals.get(id, 'alice')).consumedAt).toEqual(expect.any(Number));
        await vi.waitFor(() =>
            expect(audit(f).find((row) => row.phase === 'outcome' && row.action === 'files.delete')).toMatchObject({
                resourceId: id,
                status: '403',
            }),
        );
        const listed = (await (await f.call(f.tokens.dev1, '/data/files')).json()) as Array<{ path: string }>;
        expect(listed.some((file) => file.path.endsWith('/report.txt'))).toBe(true);
    });

    it('keeps data: action names out of app manifests', () => {
        const base = { name: 'Tracker', entry: 'server.mjs' };
        for (const name of ['data:files.delete', 'data:deleteRows', 'data:x']) {
            expect(
                parseAppManifest({
                    ...base,
                    delegation: { contract: 1, actions: { [name]: 'read' } },
                }),
            ).toMatchObject({ ok: false, error: expect.stringMatching(/data:/) });
        }
        expect(
            parseAppManifest({
                ...base,
                delegation: { contract: 1, actions: { 'sync:data': 'write' } },
            }),
        ).toMatchObject({ ok: true });
    });
});
