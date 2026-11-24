import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
    approvalsPath,
    assertContract,
    checkContract,
    fakeSocio,
    mintTestEnvelope,
    type ContractRoute,
    type FakeSocio,
} from '../packages/app-sdk/src/check.js';
import {
    ACTOR_ENVELOPE_HEADER,
    intentDigest,
    openEnvelope,
    socioApp,
    type ActionTier,
    type Principal,
} from '../packages/app-sdk/src/index.js';

// CB-232: the SDK's contract test kit (`@socio/app-sdk/check`). A correct sample app passes every check; each deliberately
// broken app fails the check aimed at its flaw. Broken apps first.

const KEY = randomBytes(32).toString('base64url');
const APP = 'tracker';
const PLUGIN = 'plugin:crm';
const PLUGIN_PROOF = 'proof-of-crm';
const actions: Record<string, ActionTier> = {
    'deals.list': 'read',
    'deal.update': 'write',
    'sms.send': 'consequential',
    'settings.update': 'admin',
};
const delegation = { actions, public: ['/healthz', '/assets/'] };

type Flaw = 'skips-verify' | 'authorizes-by-method' | 'socio-admin' | 'ignores-digest' | 'no-replay-cache';

/**
 * A small app built with the SDK's fetch adapter, as an author would; each
 * flaw is a mistake an author could make.
 */
function sampleApp(socio: FakeSocio, flaw?: Flaw, appId = APP, proof = PLUGIN_PROOF) {
    const sdk = socioApp({
        appId,
        key: KEY,
        actions,
        publicPaths: delegation.public,
        apiUrl: socio.apiUrl,
        fetch: socio.fetch,
        dataToken: () => 'cbdt_check',
        // A plugin's calls carry its service token and proof instead.
        serviceToken: () => 'plugin-service-token',
        pluginProof: proof,
        env: {},
        ...(flaw === 'no-replay-cache' ? { replay: { seen: () => false } } : {}),
    });
    const sent: unknown[] = [];
    const asked = new Map<string, unknown>();
    const table: Record<string, string> = {
        'GET /deals': 'deals.list',
        'POST /deals/42': 'deal.update',
        'POST /sms': 'sms.send',
        'PUT /settings': 'settings.update',
    };

    const authorize = (principal: Principal, action: string, method: string) => {
        if (flaw === 'authorizes-by-method') {
            return sdk.authorize(principal, method === 'GET' ? 'deals.list' : action).ok;
        }
        if (flaw === 'socio-admin' && actions[action] === 'admin' && principal.socio?.scopes.includes('app:act')) {
            return true;
        }
        return sdk.authorize(principal, action).ok;
    };

    const serve = async (request: Request, principal: Principal | undefined) => {
        const url = new URL(request.url);
        if (url.pathname === '/healthz') {
            return new Response('ok');
        }
        if (url.pathname.startsWith('/assets/')) {
            return new Response('no such asset', { status: 404 });
        }
        if (!principal) {
            return new Response('sign in', { status: 401 });
        }
        // The method-authorizing app routes by path alone.
        const action =
            flaw === 'authorizes-by-method'
                ? Object.entries(table).find(([route]) => route.endsWith(` ${url.pathname}`))?.[1]
                : table[`${request.method} ${url.pathname}`];
        if (!action) {
            return new Response('not found', { status: 404 });
        }
        if (!authorize(principal, action, request.method)) {
            return new Response('forbidden', { status: 403 });
        }
        if (action === 'sms.send') {
            const params = await request.json().catch(() => ({}));
            // The digest-ignoring app consumes for the parameters it was first
            // asked about, then sends the ones it got now.
            const approvedFor =
                flaw === 'ignores-digest' && principal.approval ? (asked.get(principal.approval) ?? params) : params;
            const approval = await sdk.requireApproval(principal, action, approvedFor, 'Text a customer');
            if (!approval.ok) {
                if (approval.status !== 202) {
                    return new Response('refused', { status: approval.status });
                }
                asked.set(approval.approval, params);
                return Response.json({ approval: approval.approval }, { status: 202 });
            }
            sent.push(params);
        }
        return Response.json({ ok: true, action });
    };

    // The verify-skipping app reads the claims without checking anything.
    const handler =
        flaw === 'skips-verify'
            ? async (request: Request) => {
                  const url = new URL(request.url);
                  if (url.pathname === '/healthz' || url.pathname.startsWith('/assets/')) {
                      return serve(request, undefined);
                  }
                  const header = request.headers.get(ACTOR_ENVELOPE_HEADER);
                  if (!header) {
                      return new Response('sign in', { status: 401 });
                  }
                  try {
                      const claims = JSON.parse(Buffer.from(header.split('.')[1], 'base64url').toString('utf8'));
                      return serve(request, {
                          person: claims.sub,
                          access: claims.acc,
                          ...(claims.act
                              ? {
                                    socio: {
                                        id: claims.act.id,
                                        grant: claims.act.grant,
                                        scopes: claims.scp,
                                    },
                                }
                              : {}),
                          obo: claims.obo,
                          sessionId: claims.sid,
                          version: claims.ver,
                          ...(claims.act && request.headers.get('x-cb-approval')
                              ? { approval: request.headers.get('x-cb-approval')! }
                              : {}),
                      });
                  } catch {
                      return new Response('sign in', { status: 401 });
                  }
              }
            : sdk.fetchHandler(serve);
    return { handler, sent };
}

const routesFor = (performed: () => number): ContractRoute[] => [
    { method: 'GET', path: '/deals?stage=won', action: 'deals.list' },
    {
        method: 'POST',
        path: '/deals/42',
        action: 'deal.update',
        body: { stage: 'won' },
    },
    {
        method: 'POST',
        path: '/sms',
        action: 'sms.send',
        body: { to: '+15550100', text: 'Your order shipped.' },
        performed,
    },
    {
        method: 'PUT',
        path: '/settings',
        action: 'settings.update',
        body: { theme: 'dark' },
    },
];

async function run(flaw?: Flaw) {
    let sent: unknown[] = [];
    return checkContract({
        appId: APP,
        key: KEY,
        delegation,
        routes: routesFor(() => sent.length),
        start: (socio) => {
            const app = sampleApp(socio, flaw);
            sent = app.sent;
            return app.handler;
        },
    });
}
const failedNames = (report: Awaited<ReturnType<typeof run>>) => [
    ...new Set(report.failed.map((result) => result.name)),
];

describe('the contract kit catches broken apps', () => {
    it('an app that skips verify: forged, foreign, stale and replayed envelopes', async () => {
        const report = await run('skips-verify');
        expect(report.ok).toBe(false);
        expect(failedNames(report)).toEqual(
            expect.arrayContaining([
                'envelope.forged',
                'envelope.wrong-key',
                'envelope.wrong-audience',
                'envelope.expired',
                'envelope.future',
                'envelope.other-method',
                'envelope.other-target',
                'envelope.replayed',
            ]),
        );
        // It still refuses a request with no envelope at all.
        expect(failedNames(report)).not.toContain('envelope.missing');
    });

    it('an app that authorizes by HTTP method: a read-only socio writes with GET', async () => {
        const report = await run('authorizes-by-method');
        expect(failedNames(report)).toEqual(['tier.read-only-socio-get']);
        // GET /sms is still refused: requireApproval checks the tier again.
        expect(report.failed.map((result) => result.route)).toEqual(['POST /deals/42']);
    });

    it('an app that lets a socio reach an admin action', async () => {
        const report = await run('socio-admin');
        expect(failedNames(report)).toEqual(['tier.admin-socio']);
    });

    it('an app that ignores the approval digest: changed parameters run', async () => {
        const report = await run('ignores-digest');
        expect(failedNames(report)).toContain('approval.digest-change');
        expect(report.failed.find((result) => result.name === 'approval.digest-change')?.detail).toMatch(
            /ran the action/,
        );
    });

    it('an app without a replay cache', async () => {
        const report = await run('no-replay-cache');
        expect(failedNames(report)).toEqual(['envelope.replayed']);
    });

    it('an app whose approvals don’t reach the fake Socio says how to fix it', async () => {
        const report = await checkContract({
            appId: APP,
            key: KEY,
            delegation,
            routes: routesFor(() => 0),
            // Made with its own fake: the kit's never hears of its approvals.
            app: sampleApp(fakeSocio({ appId: APP, actions })).handler,
        });
        const requested = report.failed.find((result) => result.name === 'approval.requested');
        expect(requested?.detail).toMatch(/point socioApp’s apiUrl and fetch/);
    });

    it('a route map that names an undeclared action fails, and assertContract throws', async () => {
        const options = {
            appId: APP,
            key: KEY,
            delegation,
            routes: [{ method: 'GET', path: '/deals', action: 'deals.export' }],
            start: (socio: FakeSocio) => sampleApp(socio).handler,
        };
        await expect(assertContract(options)).rejects.toThrow(
            /FAIL routes\.declared \(GET \/deals\): "deals\.export" isn’t in delegation\.actions/,
        );
    });

    it('a consequential route without a body to change needs changedBody', async () => {
        const report = await checkContract({
            appId: APP,
            key: KEY,
            delegation,
            routes: [{ method: 'POST', path: '/sms', action: 'sms.send', body: {} }],
            start: (socio) => sampleApp(socio).handler,
        });
        expect(report.failed.find((result) => result.name === 'approval.digest-change')?.detail).toMatch(/changedBody/);
    });
});

describe('the contract kit passes a correct app', () => {
    it('runs every check against the fetch handler', async () => {
        const report = await run();
        expect(report.summary()).toMatch(/^All \d+ contract checks passed\.$/);
        expect(report.ok).toBe(true);
        const names = new Set(report.results.map((result) => result.name));
        for (const name of [
            'control.owner',
            'control.socio-read',
            'control.socio-write',
            'envelope.missing',
            'envelope.forged',
            'envelope.wrong-key',
            'envelope.wrong-audience',
            'envelope.expired',
            'envelope.future',
            'envelope.other-method',
            'envelope.other-target',
            'envelope.replayed',
            'public.served',
            'public.normalised',
            'tier.read-only-socio',
            'tier.read-only-socio-get',
            'tier.write-socio-consequential',
            'tier.admin-socio',
            'tier.admin-space',
            'approval.requested',
            'approval.pending',
            'approval.digest-change',
            'approval.other-grant',
            'approval.consumed',
            'approval.single-use',
        ]) {
            expect(names).toContain(name);
        }
    });

    describe('over loopback, with raw request-targets', () => {
        const servers: Array<{ close(): unknown }> = [];
        afterEach(async () => {
            for (const server of servers.splice(0)) {
                await server.close();
            }
        });

        it('drives a plain node:http app and a fake Socio on loopback', async () => {
            const socio = fakeSocio({ appId: APP, actions });
            const fake = await socio.listen();
            servers.push(fake);
            const sdk = socioApp({
                appId: APP,
                key: KEY,
                actions,
                publicPaths: delegation.public,
                apiUrl: fake.apiUrl,
                dataToken: () => 'cbdt_check',
                env: {},
            });
            const sent: unknown[] = [];
            const server: Server = createServer(
                sdk.node(async (request, response, principal) => {
                    const reply = (status: number, body: unknown) => {
                        response.writeHead(status, { 'content-type': 'application/json' });
                        response.end(JSON.stringify(body));
                    };
                    const path = (request.url ?? '/').split('?')[0];
                    if (path === '/healthz') {
                        return reply(200, 'ok');
                    }
                    if (path.startsWith('/assets/')) {
                        return reply(404, 'no such asset');
                    }
                    const action = (
                        {
                            'GET /deals': 'deals.list',
                            'POST /deals/42': 'deal.update',
                            'POST /sms': 'sms.send',
                            'PUT /settings': 'settings.update',
                        } as Record<string, string>
                    )[`${request.method} ${path}`];
                    if (!action || !principal) {
                        return reply(404, 'not found');
                    }
                    if (!sdk.authorize(principal, action).ok) {
                        return reply(403, 'forbidden');
                    }
                    if (action === 'sms.send') {
                        const chunks: Buffer[] = [];
                        for await (const chunk of request) {
                            chunks.push(chunk as Buffer);
                        }
                        const params = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        const approval = await sdk.requireApproval(principal, action, params);
                        if (!approval.ok) {
                            return approval.status === 202
                                ? reply(202, { approval: approval.approval })
                                : reply(approval.status, 'refused');
                        }
                        sent.push(params);
                    }
                    reply(200, { ok: true });
                }),
            );
            const seenTargets: string[] = [];
            server.prependListener('request', (request) => seenTargets.push(request.url ?? ''));
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
            servers.push({
                close: () => new Promise((resolve) => server.close(resolve)),
            });
            const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

            const report = await checkContract({
                appId: APP,
                key: KEY,
                delegation,
                routes: routesFor(() => sent.length),
                app: base,
                socio,
            });
            expect(report.summary()).toMatch(/^All \d+ contract checks passed\.$/);
            // The dot-segment variants reached the app as written, and were refused.
            expect(seenTargets).toContain('/assets/../deals');
            expect(seenTargets).toContain('/assets/%2e%2e/deals');
            expect(sent).toHaveLength(2); // the owner's control, the approved one
        });
    });
});

describe('mintTestEnvelope and the fake Socio', () => {
    it('mints envelopes the SDK accepts, for the request they name only', () => {
        const header = mintTestEnvelope({
            appId: APP,
            key: KEY,
            actor: 'app:write',
            method: 'post',
            target: '/deals/42',
            obo: 'cbob_test',
        });
        const key = Buffer.from(KEY, 'base64url');
        expect(
            openEnvelope([key], header, {
                aud: APP,
                method: 'POST',
                target: '/deals/43',
            }),
        ).toMatchObject({ ok: false, reason: 'wrong_request' });
        const opened = openEnvelope([key], header, {
            aud: APP,
            method: 'POST',
            target: '/deals/42',
        });
        expect(opened).toMatchObject({
            ok: true,
            claims: {
                acc: 'owner',
                act: { typ: 'socio' },
                scp: ['app:write', 'app:read'],
                obo: 'cbob_test',
            },
        });
        expect(() =>
            mintTestEnvelope({
                appId: APP,
                key: 'short',
                actor: 'owner',
                method: 'GET',
                target: '/',
            }),
        ).toThrow(/32 bytes/);
    });

    it('answers like Socio’s approval routes: refusals first, then 202, consume once', async () => {
        const socio = fakeSocio({ appId: APP, actions });
        socio.actor('cbob_person', {});
        socio.actor('cbob_reader', { grant: 'g1', scopes: ['app:read'] });
        socio.actor('cbob_actor', { grant: 'g1', scopes: ['app:act'] });
        socio.actor('cbob_other', { grant: 'g2', scopes: ['app:act'] });
        const post = (path: string, obo: string | undefined, body: unknown) =>
            socio.fetch(`${socio.apiUrl}${path}`, {
                method: 'POST',
                headers: {
                    authorization: 'Bearer cbdt_check',
                    ...(obo ? { 'x-cb-obo': obo } : {}),
                },
                body: JSON.stringify(body),
            });
        const params = { to: '+15550100' };
        const digest = intentDigest(APP, 'sms.send', params);
        const ask = (obo: string, body: unknown) => post('/apps/actor/approvals', obo, body);

        expect((await post('/apps/actor/approvals', undefined, {})).status).toBe(403);
        expect((await ask('cbob_person', { action: 'sms.send', params })).status).toBe(400);
        expect((await ask('cbob_actor', { action: 'deal.update', params })).status).toBe(400);
        expect((await ask('cbob_actor', { action: 'sms.send', params, digest: 'x' })).status).toBe(400);
        expect((await ask('cbob_reader', { action: 'sms.send', params })).status).toBe(403);
        const made = await ask('cbob_actor', {
            action: 'sms.send',
            params,
            digest,
        });
        expect(made.status).toBe(202);
        const { approval } = (await made.json()) as { approval: string };
        // Asked again, the same pending approval.
        expect(await (await ask('cbob_actor', { action: 'sms.send', params })).json()).toMatchObject({ approval });
        const consume = (obo: string, body: unknown) => post(`/apps/actor/approvals/${approval}/consume`, obo, body);
        expect((await consume('cbob_actor', { digest })).status).toBe(409); // pending
        socio.approve(approval);
        expect(
            (
                await consume('cbob_actor', {
                    digest: intentDigest(APP, 'sms.send', { to: '+15550199' }),
                })
            ).status,
        ).toBe(409);
        expect((await consume('cbob_other', { digest })).status).toBe(409);
        expect((await consume('cbob_actor', { digest })).status).toBe(200);
        expect((await consume('cbob_actor', { digest })).status).toBe(409);
        expect(socio.calls.every((call) => !JSON.stringify(call).includes(KEY))).toBe(true);
    });
});

describe('the contract kit’s plugin case (CB_APP_ID=plugin:<id>)', () => {
    /** The kit against the sample app run as a service plugin. */
    const runPlugin = (flaw?: Flaw, proof = PLUGIN_PROOF) => {
        let sent: unknown[] = [];
        const socio = fakeSocio({
            appId: PLUGIN,
            actions,
            pluginProof: PLUGIN_PROOF,
        });
        return {
            socio,
            report: checkContract({
                appId: PLUGIN,
                key: KEY,
                delegation,
                routes: routesFor(() => sent.length),
                socio,
                start: (fake) => {
                    const app = sampleApp(fake, flaw, PLUGIN, proof);
                    sent = app.sent;
                    return app.handler;
                },
            }),
        };
    };

    it('a plugin that skips the digest fails the digest check', async () => {
        const { report } = runPlugin('ignores-digest');
        const failed = (await report).failed;
        expect(failed.map((result) => result.name)).toContain('approval.digest-change');
        expect(failed.find((result) => result.name === 'approval.digest-change')?.detail).toMatch(/ran the action/);
    });

    it('a plugin that calls back without its own proof gets no approval', async () => {
        const { report, socio } = runPlugin(undefined, 'proof-of-another');
        const failed = (await report).failed;
        expect(failed.map((result) => result.name)).toContain('approval.requested');
        expect(socio.calls.filter((call) => call.path === approvalsPath(PLUGIN))).not.toHaveLength(0);
        expect(socio.calls.every((call) => call.status === 401)).toBe(true);
    });

    it('a correct plugin passes every check, the approval sequence on the plugin’s routes included', async () => {
        const { report: pending, socio } = runPlugin();
        const report = await pending;
        expect(report.summary()).toMatch(/^All \d+ contract checks passed\.$/);
        const names = new Set(report.results.map((result) => result.name));
        for (const name of [
            'envelope.wrong-audience',
            'tier.admin-socio',
            'approval.requested',
            'approval.pending',
            'approval.digest-change',
            'approval.other-grant',
            'approval.consumed',
            'approval.single-use',
        ]) {
            expect(names).toContain(name);
        }
        // Every call went to the plugin's routes, with its token and proof.
        expect(socio.calls.length).toBeGreaterThan(0);
        for (const call of socio.calls) {
            expect(call.path.startsWith('/api/plugins/crm/actor/approvals')).toBe(true);
            expect(call.authorized).toBe(true);
        }
        expect([...socio.approvals.values()].every((item) => item.consumed)).toBe(true);
    });

    it('mints plugin envelopes the SDK verifies, and the fake answers like the plugin routes', async () => {
        const header = mintTestEnvelope({
            appId: PLUGIN,
            key: KEY,
            actor: 'app:act',
            method: 'POST',
            target: '/sms',
        });
        const opened = openEnvelope([Buffer.from(KEY, 'base64url')], header, {
            aud: PLUGIN,
            method: 'POST',
            target: '/sms',
        });
        // A plugin's envelope names no app version, as Socio's proxy sends it.
        expect(opened).toMatchObject({
            ok: true,
            claims: { aud: PLUGIN, ver: null },
        });
        // An app's audience isn't the plugin's.
        expect(
            openEnvelope([Buffer.from(KEY, 'base64url')], header, {
                aud: 'crm',
                method: 'POST',
                target: '/sms',
            }),
        ).toMatchObject({ ok: false });

        const socio = fakeSocio({ appId: PLUGIN, actions, pluginProof: 'p1' });
        socio.actor('cbob_actor', { grant: 'g1', scopes: ['app:act'] });
        const post = (
            path: string,
            body: unknown,
            headers: Record<string, string> = {
                authorization: 'Bearer svc',
                'x-cb-plugin-proof': 'p1',
            },
        ) =>
            socio.fetch(`${socio.apiUrl}${path}`, {
                method: 'POST',
                headers: { 'x-cb-obo': 'cbob_actor', ...headers },
                body: JSON.stringify(body),
            });
        const params = { to: '+15550100' };
        const ask = { action: 'sms.send', params };
        expect(approvalsPath(PLUGIN)).toBe('/api/plugins/crm/actor/approvals');
        expect(approvalsPath(APP)).toBe('/api/apps/actor/approvals');
        expect(
            (
                await post('/plugins/crm/actor/approvals', ask, {
                    authorization: 'Bearer svc',
                })
            ).status,
        ).toBe(401);
        expect(
            (
                await post('/plugins/crm/actor/approvals', ask, {
                    authorization: 'Bearer svc',
                    'x-cb-plugin-proof': 'p2',
                })
            ).status,
        ).toBe(401);
        // The app's routes aren't the plugin's.
        expect((await post('/apps/actor/approvals', ask)).status).toBe(404);
        expect(
            (
                await post('/plugins/crm/actor/approvals', {
                    action: 'data:files.delete',
                    params: { path: 'x' },
                })
            ).status,
        ).toBe(400);
        const made = await post('/plugins/crm/actor/approvals', {
            ...ask,
            digest: intentDigest(PLUGIN, 'sms.send', params),
        });
        expect(made.status).toBe(202);
        const { approval } = (await made.json()) as { approval: string };
        socio.approve(approval);
        const consume = (digest: string) => post(`/plugins/crm/actor/approvals/${approval}/consume`, { digest });
        // The app-of-the-same-id digest is another intent.
        expect((await consume(intentDigest('crm', 'sms.send', params))).status).toBe(409);
        expect((await consume(intentDigest(PLUGIN, 'sms.send', params))).status).toBe(200);
        expect((await consume(intentDigest(PLUGIN, 'sms.send', params))).status).toBe(409);
    });
});
