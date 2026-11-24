import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { runtimeApp } from '../src/apps-runtime/api.js';
import { ingressServer } from '../src/apps-runtime/ingress.js';
import { identitySignature, ingressKey, verifyIdentitySignature } from '../src/apps-runtime/keys.js';
import type { AppsSupervisor } from '../src/apps-runtime/supervisor.js';

// CB-232: the runtime ingress passes an `x-cb-*` identity
// header on only when the apps proxy's signature covers it; legacy headers
// from an older proxy pass unsigned during a deploy's overlap. And the
// runtime API takes no `CB_` name in a start's env but the envelope keys.

const TOKEN = 'runtime-token-0123456789abcdef';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function listen(server: Server) {
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    cleanup.push(
        () =>
            new Promise<void>((ok) => {
                server.closeAllConnections();
                server.close(() => ok());
            }),
    );
    return (server.address() as AddressInfo).port;
}

async function setup() {
    const seen: IncomingHttpHeaders[] = [];
    const app = createServer((req, res) => {
        seen.push(req.headers);
        res.end('ok');
    });
    const appPort = await listen(app);
    // The app's socket, as the supervisor would open it.
    const supervisor = {
        running: (id: string) => id === 'tracker',
        connectApp: () => connect({ host: '127.0.0.1', port: appPort }),
    } as unknown as AppsSupervisor;
    const ingressPort = await listen(ingressServer(supervisor, TOKEN));
    const send = (headers: Record<string, string>, path = '/deals?x=1', method = 'GET') =>
        new Promise<number>((resolve, reject) => {
            const req = request(
                {
                    host: '127.0.0.1',
                    port: ingressPort,
                    path,
                    method,
                    headers: {
                        'x-cb-runtime-app': 'tracker',
                        'x-cb-runtime-key': ingressKey(TOKEN),
                        ...headers,
                    },
                },
                (res) => {
                    res.resume();
                    res.on('end', () => resolve(res.statusCode ?? 0));
                },
            );
            req.on('error', reject);
            req.end();
        });
    return { seen, send };
}

const IDENTITY = {
    'x-cb-user': 'person-1',
    'x-cb-access': 'owner',
    'x-cb-actor': 'v1.claims.mac',
};

describe('the ingress and identity headers', () => {
    it('drops an unsigned envelope and obo, keeping legacy headers from an older proxy', async () => {
        const f = await setup();
        expect(await f.send({ ...IDENTITY, 'x-cb-obo': 'cbob_x', 'x-cb-other': '1' })).toBe(200);
        const headers = f.seen.at(-1)!;
        expect(headers['x-cb-actor']).toBeUndefined();
        expect(headers['x-cb-obo']).toBeUndefined();
        expect(headers['x-cb-other']).toBeUndefined();
        expect(headers['x-cb-user']).toBe('person-1');
        expect(headers['x-cb-access']).toBe('owner');
        expect(headers['x-cb-runtime-key']).toBeUndefined();
    });

    it('drops every identity header under a wrong signature', async () => {
        const f = await setup();
        const sign = (appId: string, method: string, target: string, headers = IDENTITY) =>
            identitySignature(TOKEN, appId, method, target, headers);
        for (const signature of [
            sign('other-app', 'GET', '/deals?x=1'),
            sign('tracker', 'POST', '/deals?x=1'),
            sign('tracker', 'GET', '/deals?x=2'),
            // Signed for another value of one header.
            sign('tracker', 'GET', '/deals?x=1', {
                ...IDENTITY,
                'x-cb-user': 'person-2',
            }),
            identitySignature('another-runtime-token-0123456', 'tracker', 'GET', '/deals?x=1', IDENTITY),
            'v1.x-cb-user.not-a-mac',
        ]) {
            expect(await f.send({ ...IDENTITY, 'x-cb-runtime-sig': signature })).toBe(200);
            const headers = f.seen.at(-1)!;
            expect(
                Object.keys(headers).filter((name) => name.startsWith('x-cb-')),
                signature,
            ).toEqual([]);
        }
    });

    it('passes exactly the headers a valid signature covers', async () => {
        const f = await setup();
        const signature = identitySignature(TOKEN, 'tracker', 'GET', '/deals?x=1', IDENTITY);
        // An extra header the proxy didn't sign is dropped; the signed ones pass.
        expect(
            await f.send({
                ...IDENTITY,
                'x-cb-runtime-sig': signature,
                'x-cb-obo': 'cbob_x',
            }),
        ).toBe(200);
        const headers = f.seen.at(-1)!;
        expect(headers['x-cb-actor']).toBe('v1.claims.mac');
        expect(headers['x-cb-user']).toBe('person-1');
        expect(headers['x-cb-obo']).toBeUndefined();
        expect(headers['x-cb-runtime-sig']).toBeUndefined();
    });

    it('verifies only names that are present and identity headers', () => {
        const signature = identitySignature(TOKEN, 'tracker', 'GET', '/', IDENTITY);
        expect(verifyIdentitySignature(TOKEN, 'tracker', 'GET', '/', IDENTITY, signature)).toEqual(
            new Set(Object.keys(IDENTITY)),
        );
        const partial: Record<string, string> = { ...IDENTITY };
        delete partial['x-cb-actor'];
        expect(verifyIdentitySignature(TOKEN, 'tracker', 'GET', '/', partial, signature)).toBeUndefined();
        // Runtime headers are never identity headers.
        expect(
            identitySignature(TOKEN, 'tracker', 'GET', '/', {
                'x-cb-runtime-key': 'k',
            }),
        ).toMatch(/^v1\.\./);
    });
});

describe('the runtime API’s start env', () => {
    it('refuses a CB_ name that is not an envelope key', async () => {
        const started: unknown[] = [];
        const supervisor = {
            start: async (_id: string, request: unknown) => {
                started.push(request);
                return { id: 'tracker', state: 'running' };
            },
        } as unknown as AppsSupervisor;
        const api = runtimeApp(supervisor, TOKEN, 1 << 20);
        const start = (env: Record<string, string>) =>
            api.request('/v1/apps/tracker/start', {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${TOKEN}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    version: 1,
                    token: null,
                    dataUrl: null,
                    appUrl: 'http://tracker.apps.localhost',
                    env,
                }),
            });
        expect((await start({ CB_DATA_TOKEN: 'cbdt_forged' })).status).toBe(400);
        expect((await start({ CB_SOCKET: '/tmp/x' })).status).toBe(400);
        expect(started).toEqual([]);
        expect((await start({ CB_ACTOR_KEY: 'k'.repeat(43), OWN_SETTING: 'x' })).status).toBe(200);
        expect(started).toHaveLength(1);
    });
});
