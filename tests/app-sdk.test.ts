import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { intentDigest } from '@socio/foundation/actors/principal';
import { redactSocioTokens } from '@socio/foundation/actors/redact';
import {
    ENVELOPE_TTL_MS,
    newJti,
    openEnvelope,
    requestTargetHash,
    signEnvelope,
    type EnvelopeClaims,
} from '@socio/foundation/apps/envelope';
import { dataApprovalParams } from '@socio/shared/dataspace/operations';

import {
    canonicalJson as sdkCanonicalJson,
    dataApprovalParams as sdkDataApprovalParams,
    intentDigest as sdkIntentDigest,
    MemoryReplayCache,
    socioApp,
    type DataApprovalInputs,
    type Principal,
} from '../packages/app-sdk/src/index.js';

// CB-232: the actor envelope codec (one codec, the server's and
// the SDK's) and the app SDK. Negative cases first.

const root = join(import.meta.dirname, '..');
const KEY = randomBytes(32);
const OTHER = randomBytes(32);
const NOW = 1_800_000_000_000;
const b64 = (key: Buffer) => key.toString('base64url');

const claims = (over: Partial<EnvelopeClaims> = {}): EnvelopeClaims => ({
    aud: 'tracker',
    sub: 'person-opaque-id-00001',
    acc: 'owner',
    sid: 'session-opaque-0000001',
    obo: 'cbob_v1.sealed',
    req: { m: 'GET', p: requestTargetHash('/deals?stage=won') },
    iat: NOW,
    exp: NOW + ENVELOPE_TTL_MS,
    jti: newJti(),
    ver: 3,
    ...over,
});
const socio = (over: Partial<EnvelopeClaims> = {}) =>
    claims({
        act: {
            typ: 'socio',
            id: 'socio-opaque-000000001',
            grant: 'grant-opaque-000000001',
        },
        scp: ['app:read'],
        ...over,
    });
const expectFor = (
    over: Partial<{
        aud: string;
        method: string;
        target: string;
        now: number;
    }> = {},
) => ({
    aud: 'tracker',
    method: 'GET',
    target: '/deals?stage=won',
    now: NOW,
    ...over,
});

describe('one codec', () => {
    it('ships the SDK with byte-identical copies of the server codec and JCS', () => {
        const read = (path: string) => readFileSync(join(root, path), 'utf8');
        expect(read('packages/app-sdk/src/envelope.ts')).toBe(read('packages/foundation/src/apps/envelope.ts'));
        expect(read('packages/app-sdk/src/jcs.ts')).toBe(read('packages/shared/src/jcs.ts'));
    });

    it('agrees with Socio on intent digests for reordered keys and Unicode', () => {
        const a = { to: ['dana@example.test'], body: 'Olá ✓  ', n: 1e21, z: -0 };
        const b = { z: 0, n: 1e21, body: 'Olá ✓  ', to: ['dana@example.test'] };
        expect(sdkIntentDigest('tracker', 'sms.send', a)).toBe(intentDigest('tracker', 'sms.send', b));
        expect(sdkCanonicalJson(a)).toBe(sdkCanonicalJson(b));
        expect(sdkIntentDigest('tracker', 'sms.send', { n: 2 })).not.toBe(
            intentDigest('tracker', 'sms.send', { n: 1 }),
        );
    });
});

describe('the envelope codec', () => {
    it('refuses missing, malformed, forged and tampered envelopes', () => {
        const good = signEnvelope(KEY, claims());
        expect(openEnvelope([KEY], undefined, expectFor())).toEqual({
            ok: false,
            reason: 'missing',
        });
        expect(openEnvelope([KEY], 'v2.abc.def', expectFor())).toEqual({
            ok: false,
            reason: 'malformed',
        });
        // Another key (another app, or one the caller made up).
        expect(openEnvelope([OTHER], good, expectFor())).toMatchObject({
            reason: 'bad_mac',
        });
        // Claims changed after signing: the person, the scopes.
        const [, , mac] = good.split('.');
        const forged = Buffer.from(JSON.stringify(socio({ scp: ['app:act'] }))).toString('base64url');
        expect(openEnvelope([KEY], `v1.${forged}.${mac}`, expectFor())).toMatchObject({
            reason: 'bad_mac',
        });
        // Signed, but not a shape a verifier can trust.
        for (const bad of [
            { ...claims(), acc: 'admin' },
            { ...claims(), scp: ['app:read'] }, // scopes without a socio
            { ...socio(), scp: undefined }, // a socio without scopes
            { ...socio(), scp: ['git:push'] },
            { ...claims(), sub: 'not opaque!' },
        ]) {
            expect(openEnvelope([KEY], signEnvelope(KEY, bad as EnvelopeClaims), expectFor())).toMatchObject({
                reason: 'malformed',
            });
        }
    });

    it('binds the envelope to its app, its minute and its exact request', () => {
        const good = signEnvelope(KEY, claims());
        expect(openEnvelope([KEY], good, expectFor({ aud: 'other' }))).toMatchObject({
            reason: 'wrong_audience',
        });
        expect(openEnvelope([KEY], good, expectFor({ now: NOW + ENVELOPE_TTL_MS + 5_001 }))).toMatchObject({
            reason: 'expired',
        });
        expect(
            openEnvelope([KEY], signEnvelope(KEY, claims({ iat: NOW + 10_000, exp: NOW + 20_000 })), expectFor()),
        ).toMatchObject({ reason: 'expired' });
        // Longer than 60 s is not an envelope the proxy makes.
        expect(openEnvelope([KEY], signEnvelope(KEY, claims({ exp: NOW + 10 * 60_000 })), expectFor())).toMatchObject({
            reason: 'expired',
        });
        expect(openEnvelope([KEY], good, expectFor({ method: 'POST' }))).toMatchObject({
            reason: 'wrong_request',
        });
        expect(openEnvelope([KEY], good, expectFor({ target: '/deals?stage=lost' }))).toMatchObject({
            reason: 'wrong_request',
        });
        // Hashed over the raw request-target, not a normalized form.
        const raw = signEnvelope(KEY, claims({ req: { m: 'GET', p: requestTargetHash('/a/../deals') } }));
        expect(openEnvelope([KEY], raw, expectFor({ target: '/deals' }))).toMatchObject({
            reason: 'wrong_request',
        });
        expect(openEnvelope([KEY], good, expectFor())).toMatchObject({
            ok: true,
            claims: { aud: 'tracker', acc: 'owner', ver: 3 },
        });
    });

    it('is shaped so the redactor removes it from anything a model reads', () => {
        const envelope = signEnvelope(KEY, socio());
        expect(redactSocioTokens(`header: ${envelope}`, { envelopes: true })).toBe('header: [redacted]');
    });
});

describe('the SDK', () => {
    const app = (over: Parameters<typeof socioApp>[0] = {}) =>
        socioApp({
            appId: 'tracker',
            key: b64(KEY),
            actions: {
                'dashboard.view': 'read',
                'deal.update': 'write',
                'sms.send': 'consequential',
                'settings.update': 'admin',
            },
            publicPaths: ['/healthz', '/assets/'],
            now: () => NOW,
            env: {},
            ...over,
        });
    const request = (header: string, target = '/deals?stage=won', method = 'GET') => ({
        method,
        target,
        header,
    });

    it('refuses without a key, without an envelope, and a replayed jti', () => {
        expect(socioApp({ appId: 'tracker', env: {} }).verify(request(signEnvelope(KEY, claims())))).toMatchObject({
            ok: false,
            status: 401,
            reason: 'not_configured',
        });
        const sdk = app();
        expect(sdk.verify({ method: 'GET', target: '/', header: null })).toMatchObject({
            status: 401,
            reason: 'missing',
        });
        const once = signEnvelope(KEY, claims());
        expect(sdk.verify(request(once))).toMatchObject({ ok: true });
        expect(sdk.verify(request(once))).toEqual({
            ok: false,
            status: 401,
            reason: 'replayed',
        });
    });

    it('accepts the previous key only within its grace', () => {
        const rotated = (until: number) => app({ key: b64(OTHER), previousKey: b64(KEY), previousUntil: until });
        expect(rotated(NOW + 1).verify(request(signEnvelope(KEY, claims())))).toMatchObject({ ok: true });
        expect(rotated(NOW).verify(request(signEnvelope(KEY, claims())))).toMatchObject({
            reason: 'bad_mac',
        });
    });

    it('exempts only the public paths the app lists, never a path that normalises elsewhere', () => {
        const sdk = app();
        expect(sdk.isPublic('/healthz')).toBe(true);
        expect(sdk.isPublic('/healthz/x')).toBe(false);
        expect(sdk.isPublic('/assets/app.js?v=1')).toBe(true);
        expect(sdk.isPublic('/assets/../admin')).toBe(false);
        expect(sdk.isPublic('/assets/%2e%2e/admin')).toBe(false);
        expect(sdk.isPublic('/assets/..%2fadmin')).toBe(false);
        expect(sdk.isPublic('/admin')).toBe(false);
    });

    it('authorizes by declared tier, never by method', () => {
        const sdk = app();
        const person = (access: 'owner' | 'space'): Principal => ({
            person: 'p',
            access,
            sessionId: 's',
            version: 1,
        });
        const withScopes = (...scopes: string[]): Principal => ({
            ...person('owner'),
            socio: { id: 'r', grant: 'g', scopes },
        });
        expect(sdk.authorize(person('owner'), 'unknown')).toMatchObject({
            reason: 'action_undeclared',
        });
        expect(sdk.authorize(person('owner'), 'toString')).toMatchObject({
            reason: 'action_undeclared',
        });
        // admin: the owner only; never a socio, even one acting for the owner.
        expect(sdk.authorize(person('owner'), 'settings.update')).toMatchObject({
            ok: true,
        });
        expect(sdk.authorize(person('space'), 'settings.update')).toMatchObject({
            reason: 'admin_tier',
        });
        expect(sdk.authorize(withScopes('app:act'), 'settings.update')).toMatchObject({
            reason: 'admin_tier',
        });
        // A read-only socio can't write; act implies write implies read.
        expect(sdk.authorize(withScopes('app:read'), 'deal.update')).toMatchObject({
            reason: 'scope_insufficient',
        });
        expect(sdk.authorize(withScopes('app:read'), 'dashboard.view')).toMatchObject({ ok: true });
        expect(sdk.authorize(withScopes('app:write'), 'sms.send')).toMatchObject({
            reason: 'scope_insufficient',
        });
        expect(sdk.authorize(withScopes('app:act'), 'deal.update')).toMatchObject({
            ok: true,
        });
        expect(sdk.authorize(withScopes('app:act'), 'sms.send')).toMatchObject({
            ok: true,
        });
    });

    it('asks for and consumes an approval through Socio with the request’s obo', async () => {
        const calls: Array<{
            url: string;
            headers: Record<string, string>;
            body: unknown;
        }> = [];
        const fake: typeof fetch = async (input, init) => {
            const headers = Object.fromEntries(new Headers(init?.headers).entries());
            calls.push({
                url: String(input),
                headers,
                body: JSON.parse(String(init?.body)),
            });
            if (String(input).endsWith('/consume')) {
                return new Response('{}', {
                    status: String(input).includes('/used/') ? 409 : 200,
                });
            }
            return new Response(JSON.stringify({ approval: 'appr-1' }), {
                status: 202,
            });
        };
        const sdk = app({
            apiUrl: 'http://socio.test/api',
            dataToken: () => 'cbdt_app',
            fetch: fake,
        });
        const actor: Principal = {
            person: 'p',
            access: 'owner',
            sessionId: 's',
            version: 1,
            obo: 'cbob_v1.request',
            socio: {
                id: 'r',
                grant: 'g',
                scopes: ['app:act', 'app:write', 'app:read'],
            },
        };
        // A person acting for themselves needs no approval.
        expect(
            await sdk.requireApproval({ ...actor, socio: undefined }, 'sms.send', {
                to: 1,
            }),
        ).toEqual({ ok: true });
        expect(calls).toHaveLength(0);
        // Not covered by the scopes: refused before Socio is asked.
        expect(
            await sdk.requireApproval(
                { ...actor, socio: { id: 'r', grant: 'g', scopes: ['app:write'] } },
                'sms.send',
                {},
            ),
        ).toMatchObject({ ok: false, status: 403 });
        expect(await sdk.requireApproval(actor, 'sms.send', { to: ['a'] }, 'Text Dana')).toEqual({
            ok: false,
            status: 202,
            approval: 'appr-1',
        });
        expect(calls[0]).toMatchObject({
            url: 'http://socio.test/api/apps/actor/approvals',
            headers: {
                authorization: 'Bearer cbdt_app',
                'x-cb-obo': 'cbob_v1.request',
            },
            body: {
                action: 'sms.send',
                params: { to: ['a'] },
                display: 'Text Dana',
                digest: intentDigest('tracker', 'sms.send', { to: ['a'] }),
            },
        });
        expect(
            await sdk.requireApproval({ ...actor, approval: 'appr-1' }, 'sms.send', {
                to: ['a'],
            }),
        ).toEqual({ ok: true, approval: 'appr-1' });
        expect(calls[1]).toMatchObject({
            url: 'http://socio.test/api/apps/actor/approvals/appr-1/consume',
            body: { digest: intentDigest('tracker', 'sms.send', { to: ['a'] }) },
        });
        expect(
            await sdk.requireApproval({ ...actor, approval: 'used' }, 'sms.send', {
                to: ['a'],
            }),
        ).toMatchObject({ ok: false, status: 409 });
    });

    it('adapts to fetch handlers, Hono, Express and plain Node', async () => {
        const sdk = app({ replay: new MemoryReplayCache() });
        const handler = sdk.fetchHandler((_request, principal) => Response.json({ person: principal?.person ?? null }));
        expect((await handler(new Request('http://x/deals'))).status).toBe(401);
        expect(await (await handler(new Request('http://x/healthz'))).json()).toEqual({
            person: null,
        });
        const ok = await handler(
            new Request('http://x/deals?stage=won', {
                headers: { 'x-cb-actor': signEnvelope(KEY, claims()) },
            }),
        );
        expect(await ok.json()).toEqual({ person: 'person-opaque-id-00001' });

        // Hono-shaped context.
        const store = new Map<string, Principal>();
        const context = (headers: Record<string, string>) => ({
            req: { raw: new Request('http://x/deals?stage=won', { headers }) },
            set: (key: 'actor', value: Principal) => void store.set(key, value),
            get: (key: 'actor') => store.get(key),
            text: (body: string, status: number) => new Response(body, { status }),
        });
        const { requirePrincipal, authorize } = sdk.hono();
        let reached = false;
        const refused = await requirePrincipal()(context({}), async () => {
            reached = true;
        });
        expect(refused?.status).toBe(401);
        expect(reached).toBe(false);
        const c = context({ 'x-cb-actor': signEnvelope(KEY, socio()) });
        await requirePrincipal()(c, async () => {
            reached = true;
        });
        expect(reached).toBe(true);
        expect(c.get('actor')?.socio?.scopes).toEqual(['app:read']);
        expect((await authorize('deal.update')(c, async () => {}))?.status).toBe(403);

        // Express-shaped: the raw target is `originalUrl`.
        const written: number[] = [];
        const res = {
            writeHead: (status: number) => written.push(status),
            end: () => undefined,
        };
        const express = sdk.express();
        let next = 0;
        express.requirePrincipal(
            {
                method: 'GET',
                url: '/stage=won',
                originalUrl: '/deals?stage=won',
                headers: { 'x-cb-actor': signEnvelope(KEY, claims()) },
            },
            res,
            () => next++,
        );
        express.requirePrincipal({ method: 'GET', url: '/deals', headers: {} }, res, () => next++);
        expect(next).toBe(1);
        expect(written).toEqual([401]);

        // Plain Node.
        const seen: Array<Principal | undefined> = [];
        const node = sdk.node((_req, _res, principal) => seen.push(principal));
        node(
            {
                method: 'GET',
                url: '/deals?stage=won',
                headers: { 'x-cb-actor': signEnvelope(KEY, claims()) },
            },
            res,
        );
        node({ method: 'GET', url: '/healthz', headers: {} }, res);
        expect(seen.map((p) => p?.person ?? null)).toEqual(['person-opaque-id-00001', null]);
    });
});

// CB-232: a service plugin uses the same SDK with `CB_APP_ID=plugin:<id>`
// (its task env). Its calls go to the plugin's routes with its service
// token and proof; the app path is unchanged.
describe('the SDK for a service plugin', () => {
    const PROOF = 'proof-of-crm';
    const recorder = () => {
        const calls: Array<{ url: string; headers: Record<string, string> }> = [];
        const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({
                url: String(input),
                headers: Object.fromEntries(new Headers(init?.headers).entries()),
            });
            if (String(input).endsWith('/consume')) {
                return new Response('{}', { status: 200 });
            }
            if (String(input).endsWith('/continuations')) {
                return Response.json({ continuation: 'cbob_cont' });
            }
            if (String(input).includes('/data/')) {
                return Response.json({});
            }
            return Response.json({ approval: 'appr-1' }, { status: 202 });
        }) as typeof fetch;
        return { calls, fake };
    };
    const actor: Principal = {
        person: 'p',
        access: 'space',
        sessionId: 's',
        version: null,
        obo: 'cbob_v1.request',
        socio: {
            id: 'r',
            grant: 'g',
            scopes: ['app:act', 'app:write', 'app:read'],
        },
    };

    it('needs the token and proof, and never sends an app data token', async () => {
        const { calls, fake } = recorder();
        const sdk = socioApp({
            key: b64(KEY),
            actions: { 'sms.send': 'consequential' },
            fetch: fake,
            env: {
                CB_APP_ID: 'plugin:crm',
                SOCIO_API_URL: 'http://app:4310',
                // An app's data token in the env is never a plugin's credential.
                CB_DATA_TOKEN: 'cbdt_wrong',
                SOCIO_API_TOKEN: 'svc',
            },
        });
        expect(sdk.pluginId).toBe('crm');
        await expect(sdk.requireApproval(actor, 'sms.send', {})).rejects.toThrow(/not configured/);
        expect(() => sdk.dataClient(actor).fetch('/state')).toThrow(/not configured/);
        expect(calls).toHaveLength(0);
    });

    it('calls the plugin’s routes with its service token and proof, from the task env', async () => {
        const { calls, fake } = recorder();
        const dir = mkdtempSync(join(tmpdir(), 'cb-sdk-plugin-'));
        const tokenFile = join(dir, 'token');
        writeFileSync(tokenFile, 'svc-from-file\n');
        try {
            const sdk = socioApp({
                key: b64(KEY),
                actions: { 'sms.send': 'consequential' },
                fetch: fake,
                env: {
                    CB_APP_ID: 'plugin:crm',
                    CB_PLUGIN_PROOF: PROOF,
                    SOCIO_API_URL: 'http://app:4310/',
                    SOCIO_API_TOKEN_FILE: tokenFile,
                    SOCIO_API_TOKEN: 'svc-from-env',
                    CB_DATA_URL: 'http://app:4310/api/data',
                    CB_DATA_TOKEN: 'cbdt_wrong',
                },
            });
            const auth = {
                authorization: 'Bearer svc-from-file',
                'x-cb-plugin-proof': PROOF,
                'x-cb-obo': 'cbob_v1.request',
            };
            expect(await sdk.requireApproval(actor, 'sms.send', { to: 1 })).toEqual({
                ok: false,
                status: 202,
                approval: 'appr-1',
            });
            expect(
                await sdk.requireApproval({ ...actor, approval: 'appr-1' }, 'sms.send', {
                    to: 1,
                }),
            ).toEqual({ ok: true, approval: 'appr-1' });
            expect(await sdk.continuation(actor, 10)).toBe('cbob_cont');
            await sdk.dataClient(actor).fetch('/state?x=1');
            expect(calls.map((call) => call.url)).toEqual([
                'http://app:4310/api/plugins/crm/actor/approvals',
                'http://app:4310/api/plugins/crm/actor/approvals/appr-1/consume',
                'http://app:4310/api/plugins/crm/actor/continuations',
                'http://app:4310/api/plugins/crm/data/state?x=1',
            ]);
            for (const call of calls) {
                expect(call.headers).toMatchObject(auth);
            }
            // The digest names the plugin's audience, as Socio computes it.
            expect(sdk.intentDigest('sms.send', { to: 1 })).toBe(intentDigest('plugin:crm', 'sms.send', { to: 1 }));
            // A plugin's data routes take no approvals.
            expect(() => sdk.dataClient(actor).fetch('/state', { approval: 'appr-1' })).toThrow(/no approvals/);
            await expect(sdk.requestDataApproval(actor, 'files.delete', { path: 'x' })).rejects.toThrow(
                /for mini apps/,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('keeps the app path as it was', async () => {
        const { calls, fake } = recorder();
        const sdk = socioApp({
            key: b64(KEY),
            actions: { 'sms.send': 'consequential' },
            fetch: fake,
            env: {
                CB_APP_ID: 'tracker',
                CB_DATA_URL: 'http://app:4310/api/data',
                CB_DATA_TOKEN: 'cbdt_app',
                CB_PLUGIN_PROOF: PROOF,
                SOCIO_API_TOKEN: 'svc',
            },
        });
        expect(sdk.pluginId).toBeUndefined();
        await sdk.requireApproval(actor, 'sms.send', {});
        expect(calls).toEqual([
            {
                url: 'http://app:4310/api/apps/actor/approvals',
                headers: {
                    authorization: 'Bearer cbdt_app',
                    'content-type': 'application/json',
                    'x-cb-obo': 'cbob_v1.request',
                },
            },
        ]);
    });
});

// CB-232: a socio's delete through the data API needs the
// person's approval of `data:<op>` for that exact call. The SDK asks for
// it, never consumes it, and passes the socio's approval id on the call.
describe('data operation approvals in the SDK', () => {
    const calls: Array<{
        url: string;
        headers: Record<string, string>;
        body: unknown;
    }> = [];
    let status = 202;
    const fake: typeof fetch = async (input, init) => {
        calls.push({
            url: String(input),
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return status === 202
            ? new Response(JSON.stringify({ approval: 'appr-9' }), { status })
            : new Response(JSON.stringify({ reason: 'not_consequential' }), {
                  status,
              });
    };
    const sdk = () =>
        socioApp({
            appId: 'tracker',
            key: b64(KEY),
            actions: { 'sms.send': 'consequential' },
            apiUrl: 'http://socio.test/api',
            dataToken: () => 'cbdt_app',
            now: () => NOW,
            env: {},
            fetch: fake,
        });
    const actor: Principal = {
        person: 'p',
        access: 'owner',
        sessionId: 's',
        version: 1,
        obo: 'cbob_v1.request',
        socio: { id: 'r', grant: 'g', scopes: ['app:act'] },
    };

    it('builds exactly the parameters Socio recomputes, for every operation', () => {
        const inputs: { [K in keyof DataApprovalInputs]: DataApprovalInputs[K] } = {
            'files.delete': { path: 'reports/q3.csv' },
            deleteRows: { dataset: 'deals', table: 'deals', rowids: [3, 1] },
            dropTable: { dataset: 'deals', table: 'deals' },
            deleteDataset: { dataset: 'deals' },
        };
        for (const [op, input] of Object.entries(inputs) as Array<
            [keyof DataApprovalInputs, DataApprovalInputs[keyof DataApprovalInputs]]
        >) {
            const built = sdkDataApprovalParams(op, {
                ...input,
                extra: 'dropped',
            } as never);
            expect(built).toEqual(input);
            expect(dataApprovalParams(op, built)).toEqual(built);
            expect(sdkIntentDigest('tracker', `data:${op}`, built)).toBe(
                intentDigest('tracker', `data:${op}`, dataApprovalParams(op, built)),
            );
        }
        expect(() => sdkDataApprovalParams('files.read' as never, { path: 'a' } as never)).toThrow(/needs no approval/);
    });

    it('asks nobody for a person, refuses a socio without app:act, never consumes', async () => {
        calls.length = 0;
        const app = sdk();
        expect(
            await app.requestDataApproval({ ...actor, socio: undefined }, 'files.delete', {
                path: 'a.txt',
            }),
        ).toEqual({ ok: true });
        expect(
            await app.requestDataApproval(
                { ...actor, socio: { id: 'r', grant: 'g', scopes: ['app:write'] } },
                'files.delete',
                { path: 'a.txt' },
            ),
        ).toEqual({ ok: false, status: 403, reason: 'scope_insufficient' });
        // The socio's repeated request names it: passed on, not consumed.
        expect(
            await app.requestDataApproval({ ...actor, approval: 'appr-9' }, 'files.delete', { path: 'a.txt' }),
        ).toEqual({ ok: true, approval: 'appr-9' });
        expect(calls).toEqual([]);
    });

    it('makes the pending approval with the platform action, then sends its id on the data call', async () => {
        calls.length = 0;
        status = 202;
        const app = sdk();
        expect(
            await app.requestDataApproval(actor, 'files.delete', { path: 'a b.txt' }, { Summary: 'Old report' }),
        ).toEqual({ ok: false, status: 202, approval: 'appr-9' });
        expect(calls[0]).toEqual({
            url: 'http://socio.test/api/apps/actor/approvals',
            headers: expect.objectContaining({
                authorization: 'Bearer cbdt_app',
                'x-cb-obo': 'cbob_v1.request',
            }),
            body: {
                action: 'data:files.delete',
                params: { path: 'a b.txt' },
                display: { Summary: 'Old report' },
                digest: intentDigest('tracker', 'data:files.delete', {
                    path: 'a b.txt',
                }),
            },
        });
        await app.dataClient({ ...actor, approval: 'appr-9' }).fetch(`/files?path=${encodeURIComponent('a b.txt')}`, {
            method: 'DELETE',
            approval: 'appr-9',
        });
        expect(calls[1]).toMatchObject({
            url: 'http://socio.test/api/data/files?path=a%20b.txt',
            headers: {
                authorization: 'Bearer cbdt_app',
                'x-cb-obo': 'cbob_v1.request',
                'x-cb-approval': 'appr-9',
            },
        });
        // Without the option, no header; a malformed id never leaves the app.
        await app.dataClient(actor).fetch('/files');
        expect(calls[2]!.headers['x-cb-approval']).toBeUndefined();
        expect(() => app.dataClient(actor).fetch('/files', { approval: 'bad id\r\nx: y' })).toThrow(/approval id/);
        // Socio's refusal comes back with its reason.
        status = 400;
        expect(await app.requestDataApproval(actor, 'files.delete', { path: 'a' })).toEqual({
            ok: false,
            status: 400,
            reason: 'not_consequential',
        });
    });
});
