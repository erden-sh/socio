import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serve } from '@hono/node-server';
import { afterEach, expect, it, vi } from 'vitest';

import { signContextProof } from '@socio/foundation/actors/keys';
import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';
import type { ActorScope } from '@socio/shared/actor-scopes';
import { PLUGIN_ROUTE_MAX } from '@socio/shared/plugins/plugins';
import type { User } from '@socio/shared/types';

import { socioApp } from '../packages/app-sdk/src/index.js';
import { ingressServer } from '../src/apps-runtime/ingress.js';
import { pluginActorKey, pluginProof } from '../src/apps-runtime/keys.js';
import { appsUpgrade } from '../src/server/apps/proxy.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { pluginPolicyVersion } from '../src/server/plugins/actor.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-239, CB-232: WebSockets for service
// plugins through the apps proxy and the runtime's ingress, with the same
// checks as an app's socket and as the plugin's own HTTP requests: its
// own Origin, a person's plugin session or a socio's credential with the
// context proof, the signed envelope and never a legacy identity header
// for a socio, and close on revocation, disable, a narrowed audience and
// a session that ended on any runtime. Negative cases first.

const SECRET = 'secret-0123456789abcdef-xyz';
const RUNTIME = 'runtime-secret-runtime-secret-32';
const SERVICE = 'plugin-service-token-plugin-service-token';
const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
];
const IMAGE = `company-brain-plugin-crm@sha256:${'a'.repeat(64)}`;
const ACTIONS = { 'deals.view': 'read', 'deals.update': 'write' } as const;

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const closeServer = (server: Server) => () =>
    new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
    });

/** The plugin's task: answers upgrades with 101 (and a cookie it must lose). */
async function task() {
    const upgrades: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
    const sockets = new Set<Socket>();
    const server = createServer((_req, res) => res.end('ok'));
    server.on('upgrade', (req, socket: Socket) => {
        upgrades.push({ url: req.url!, headers: req.headers });
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSet-Cookie: plugin=1\r\n\r\n',
        );
        socket.on('data', (chunk) => socket.write(chunk));
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    cleanup.push(() => {
        for (const socket of sockets) {
            socket.destroy();
        }
        return closeServer(server)();
    });
    return { port: (server.address() as AddressInfo).port, upgrades, sockets };
}

async function fixture(options: { socioOnPublicHost?: boolean; socioOnly?: boolean } = {}) {
    vi.stubEnv('APPS_SOCIO_ON_PUBLIC_HOST', options.socioOnPublicHost === false ? '' : '1');
    cleanup.push(() => vi.unstubAllEnvs());
    const dir = mkdtempSync(join(tmpdir(), 'cb-plugin-ws-'));
    const catalog = join(dir, 'catalog.json');
    writeFileSync(
        catalog,
        JSON.stringify({
            plugins: [
                {
                    id: 'crm',
                    name: 'CRM',
                    version: '1.0.0',
                    author: 'Test',
                    description: 'Deals.',
                    display: 'tab',
                    permissions: ['crm:read', 'crm:write'],
                    audience: 'members',
                    service: { image: IMAGE, port: 8080 },
                    delegation: { contract: 1, actions: ACTIONS },
                },
            ],
        }),
    );
    const up = await task();
    const ingress = ingressServer(
        {
            running: () => false,
            connectApp: () => {
                throw new Error('no apps here');
            },
        } as never,
        RUNTIME,
        {
            refresh: async () => {},
            owns: (id: string) => id === 'crm',
            targets: async () => [{ host: '127.0.0.1', port: up.port }],
            proof: (id: string) => pluginProof(RUNTIME, id),
        } as never,
    );
    await new Promise<void>((ok) => ingress.listen(0, '127.0.0.1', () => ok()));
    cleanup.push(closeServer(ingress));
    const running = {
        id: 'crm',
        service: 'socio-plugin-crm',
        image: IMAGE,
        replicas: 1,
        running: 1,
        state: 'running' as const,
    };
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            sessionSecret: SECRET,
            appOrigin: 'http://localhost:4310',
            data: { userDataDir: dir, apiUrl: 'http://company-brain-app:4310' },
            apps: appsSettingsFromEnv({}, 'http://localhost:4310')!,
            appsRuntime: {
                url: 'http://127.0.0.1:9',
                token: RUNTIME,
                ingress: {
                    host: '127.0.0.1',
                    port: (ingress.address() as AddressInfo).port,
                },
            },
            plugins: {
                catalogs: [{ kind: 'file', path: catalog }],
                serviceToken: SERVICE,
                runtime: {
                    provisionService: async () => running,
                    scaleService: async () => running,
                    removeService: async () => {},
                    serviceStatus: async () => running,
                },
            },
            // Its flags are in development: only an internal deployment has them (CB-503).
            deploymentKind: 'internal',
            featureFlags: { 'socio-actor-access': true },
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            origin: 'http://localhost:4310',
            auth: {
                provider: new MockAuthProvider(USERS, SECRET),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    const { plugins } = platform;
    await plugins.install('crm');
    const dot = workspace.dots()[0]!;
    const chat = workspace.bindThread('chat-bob', dot.id, 'Plans', 'bob');
    const origin = plugins.origin('crm')!;
    const host = new URL(origin).host;

    // The apps origin as the server entry serves it: HTTP and upgrades.
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    // `socioOnly`: the internal apps listener's upgrades.
    const upgrade = appsUpgrade(platform.apps, {
        socioOnly: options.socioOnly === true,
    });
    server.on('upgrade', (request, socket, head) => {
        if (!upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((ok) => (server.listening ? ok() : server.once('listening', () => ok())));
    cleanup.push(closeServer(server as Server));
    const port = (server.address() as AddressInfo).port;

    /** A WebSocket handshake on the plugin's host; the head and the socket. */
    const handshake = (headers: Record<string, string | undefined>, target = '/ws') =>
        new Promise<{ head: string; socket: Socket }>((resolve, reject) => {
            const socket = connect({ host: '127.0.0.1', port });
            cleanup.push(() => socket.destroy());
            let data = '';
            socket.on('data', (chunk) => {
                data += chunk.toString();
                if (data.includes('\r\n\r\n')) {
                    socket.removeAllListeners('data');
                    resolve({ head: data, socket });
                }
            });
            socket.on('error', reject);
            socket.on('close', () => resolve({ head: data, socket }));
            const all = {
                host,
                origin,
                upgrade: 'websocket',
                connection: 'Upgrade',
                'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
                'sec-websocket-version': '13',
                ...headers,
            };
            socket.write(
                `GET ${target} HTTP/1.1\r\n${Object.entries(all)
                    .filter(([, value]) => value !== undefined)
                    .map(([name, value]) => `${name}: ${value}`)
                    .join('\r\n')}\r\n\r\n`,
            );
        });
    const closed = (socket: Socket) =>
        new Promise<void>((ok) => (socket.destroyed ? ok() : socket.once('close', () => ok())));

    const login = async (userId: string) => {
        const response = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        return response.headers.get('set-cookie')!.split(';')[0]!;
    };
    /** A person's session on the plugin's origin (the launch hand-off). */
    /** The redemption's answer for a launch, as the browser gets it from `/__cb/auth`. */
    const redeemLaunch = async (userId = 'bob', body: { next?: string } = {}) => {
        const launched = await app.request('http://localhost:4310/api/plugins/crm/launch', {
            method: 'POST',
            headers: {
                cookie: await login(userId),
                'content-type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        const { url } = (await launched.json()) as { url: string };
        return app.request(url);
    };
    const signIn = async (userId = 'bob') => (await redeemLaunch(userId)).headers.get('set-cookie')!.split(';')[0]!;
    /** A socio's app-browser context on the plugin: credential and proofs. */
    const socio = async (scopes: ActorScope[] = ['app:read']) => {
        const grant = await platform.actors.grants.create({
            personId: 'bob',
            socioId: dot.id,
            audiences: ['plugin:crm'],
            scopes,
            conversationId: chat.id,
            conversationKind: 'private',
            task: 'Watch the deals',
            policyVersion: pluginPolicyVersion(plugins.get('crm'))!,
            approvedBy: 'bob',
            correlationId: 'test',
        });
        const context = await platform.actors.contexts.open({
            grant,
            kind: 'browser',
            audience: 'plugin:crm',
            correlationId: 'test',
        });
        const { token } = await platform.actors.credentials.issue({
            grant,
            kind: 'cbsa',
            audiences: ['plugin:crm'],
            contextId: context.id,
            holder: { kind: 'context', id: context.id },
            correlationId: 'test',
        });
        const key = platform.actors.contextKey(context.id);
        const proof = (target = '/ws', method = 'GET', on = host) =>
            signContextProof(key, {
                method,
                host: on,
                requestTarget: target,
                bodyDigest: '',
            });
        return { grant, token, proof };
    };
    const sdk = () =>
        socioApp({
            appId: 'plugin:crm',
            key: pluginActorKey(RUNTIME, 'crm'),
            actions: ACTIONS,
            env: {},
        });
    // Sockets first: an upgraded connection keeps its server open.
    cleanup.push(() => {
        for (const socket of up.sockets) {
            socket.destroy();
        }
    });
    return {
        platform,
        workspace,
        plugins,
        up,
        origin,
        host,
        handshake,
        closed,
        signIn,
        redeemLaunch,
        socio,
        sdk,
    };
}

it('opens a deep link longer than 500 characters exactly where it points, over launch and redemption (CB-446)', async () => {
    const f = await fixture();
    // A long filter query the bridge mirrors: a reload, a shared link or a new tab opens it again.
    const next = `/events?filter=${'status%3Aopen%2C'.repeat(40)}&sort=date#list`;
    expect(next.length).toBeGreaterThan(500);
    expect(next.length).toBeLessThanOrEqual(PLUGIN_ROUTE_MAX);
    const answer = await f.redeemLaunch('bob', { next });
    expect(answer.status).toBe(303);
    expect(answer.headers.get('location')).toBe(next);
    // Over the bridge's limit: the plugin's root, as for any refused next.
    const over = await f.redeemLaunch('bob', { next: `/e?${'q'.repeat(PLUGIN_ROUTE_MAX)}` });
    expect(over.headers.get('location')).toBe('/');
});

it('refuses a socket from another origin, without a session, on the proxy’s own paths, and for a missing plugin', async () => {
    const f = await fixture();
    const cookie = await f.signIn();
    expect((await f.handshake({ cookie, origin: 'https://evil.example' })).head).toMatch(/^HTTP\/1.1 403/);
    expect((await f.handshake({ cookie, origin: undefined })).head).toMatch(/^HTTP\/1.1 403/);
    expect((await f.handshake({})).head).toMatch(/^HTTP\/1.1 401/);
    expect((await f.handshake({ cookie: 'cb_app_session=forged' })).head).toMatch(/^HTTP\/1.1 401/);
    expect((await f.handshake({ cookie }, '/__cb/auth')).head).toMatch(/^HTTP\/1.1 404/);
    // The host's paths (CB-458), in any spelling a router could fold to them.
    for (const path of [
        '/__cb/backup',
        '/__CB/backup',
        '/%5F%5Fcb/backup',
        '/x/%2e%2e/__cb/backup',
        '/__cb/backup/../../deals',
    ]) {
        expect((await f.handshake({ cookie }, path)).head, path).toMatch(/^HTTP\/1.1 404/);
    }
    // Not a WebSocket upgrade.
    expect((await f.handshake({ cookie, upgrade: 'h2c' })).head).toMatch(/^HTTP\/1.1 400/);
    expect(f.up.upgrades).toEqual([]);
});

it('opens a person’s socket with the CB-254 headers and their envelope, signed for the ingress, no cookie', async () => {
    const f = await fixture();
    const cookie = await f.signIn();
    const opened = await f.handshake({ cookie });
    expect(opened.head).toMatch(/^HTTP\/1.1 101/);
    // The plugin's Set-Cookie never reaches the browser.
    expect(opened.head).not.toMatch(/set-cookie/i);
    const seen = f.up.upgrades.at(-1)!;
    expect(seen.url).toBe('/ws');
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers['x-cb-user']).toBe(f.plugins.personId('crm', 'bob'));
    expect(seen.headers['x-cb-time-zone']).toBeTruthy();
    // The ingress passed these only because the proxy signed them.
    expect(
        f.sdk().verify({
            method: 'GET',
            target: '/ws',
            header: seen.headers['x-cb-actor'] as string,
        }),
    ).toMatchObject({ ok: true, principal: { access: 'space' } });
    // Bytes flow both ways.
    const echoed = new Promise<string>((ok) => opened.socket.once('data', (chunk) => ok(chunk.toString())));
    opened.socket.write('ping');
    expect(await echoed).toBe('ping');
    expect(f.plugins.socketCount('crm')).toBe(1);
});

it('refuses a socio’s socket without its context proof, with a proof for another target, and on the public host without the switch', async () => {
    const f = await fixture();
    const s = await f.socio();
    const bearer = `Bearer ${s.token}`;
    expect((await f.handshake({ authorization: bearer })).head).toMatch(/^HTTP\/1.1 401/);
    expect(
        (
            await f.handshake({
                authorization: bearer,
                'x-cb-context': s.proof('/other'),
            })
        ).head,
    ).toMatch(/^HTTP\/1.1 401/);
    expect(f.up.upgrades).toEqual([]);
    const strict = await fixture({ socioOnPublicHost: false });
    const t = await strict.socio();
    expect(
        (
            await strict.handshake({
                authorization: `Bearer ${t.token}`,
                'x-cb-context': t.proof(),
            })
        ).head,
    ).toMatch(/^HTTP\/1.1 401/);
    expect(strict.up.upgrades).toEqual([]);
});

it('opens a socio’s socket with the envelope only, and closes it when the grant is revoked', async () => {
    const f = await fixture();
    const s = await f.socio();
    const proof = s.proof();
    const opened = await f.handshake({
        authorization: `Bearer ${s.token}`,
        'x-cb-context': proof,
    });
    expect(opened.head).toMatch(/^HTTP\/1.1 101/);
    const seen = f.up.upgrades.at(-1)!.headers;
    // Never a legacy identity header or the platform's credential.
    expect(seen['x-cb-user']).toBeUndefined();
    expect(seen['x-cb-access']).toBeUndefined();
    expect(seen['x-cb-person']).toBeUndefined();
    expect(seen.authorization).toBeUndefined();
    expect(
        f.sdk().verify({
            method: 'GET',
            target: '/ws',
            header: seen['x-cb-actor'] as string,
        }),
    ).toMatchObject({ ok: true, principal: { socio: { scopes: ['app:read'] } } });
    expect(f.platform.actors.revocations.trackedCount(s.grant.id)).toBe(1);
    // A replayed proof opens nothing.
    expect(
        (
            await f.handshake({
                authorization: `Bearer ${s.token}`,
                'x-cb-context': proof,
            })
        ).head,
    ).toMatch(/^HTTP\/1.1 401/);
    expect(f.up.upgrades).toHaveLength(1);
    const shut = f.closed(opened.socket);
    await f.platform.actors.revoke({ grantId: s.grant.id }, 'bob', 'person_revoked');
    await shut;
    await vi.waitFor(() => expect(f.platform.actors.revocations.trackedCount(s.grant.id)).toBe(0));
    // And a new one is refused.
    const again = await f.socio();
    await f.platform.actors.revoke({ grantId: again.grant.id }, 'bob', 'person_revoked');
    expect(
        (
            await f.handshake({
                authorization: `Bearer ${again.token}`,
                'x-cb-context': again.proof(),
            })
        ).head,
    ).toMatch(/^HTTP\/1.1 (401|403)/);
});

it('closes sockets when the plugin is disabled, and members’ when its audience narrows to admins', async () => {
    const f = await fixture();
    const bob = await f.handshake({ cookie: await f.signIn('bob') });
    const alice = await f.handshake({ cookie: await f.signIn('alice') });
    expect(bob.head).toMatch(/^HTTP\/1.1 101/);
    expect(alice.head).toMatch(/^HTTP\/1.1 101/);
    const bobShut = f.closed(bob.socket);
    await f.plugins.setAudience('crm', 'admins', 'alice');
    await bobShut;
    expect(alice.socket.destroyed).toBe(false);
    expect(f.plugins.socketCount('crm')).toBe(1);
    const aliceShut = f.closed(alice.socket);
    await f.plugins.setEnabled('crm', false, 'alice');
    await aliceShut;
    expect(f.plugins.socketCount('crm')).toBe(0);
});

it('closes a person’s socket within 5 s of their session ending on any runtime', async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const cookie = await f.signIn('bob');
    const opened = await f.handshake({ cookie });
    expect(opened.head).toMatch(/^HTTP\/1.1 101/);
    // Still live: the re-check keeps it open.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(opened.socket.destroyed).toBe(false);
    // Another runtime signed bob out: only the row is gone here.
    f.workspace.db.prepare('DELETE FROM plugin_sessions').run();
    const shut = f.closed(opened.socket);
    await vi.advanceTimersByTimeAsync(5_000);
    await shut;
    expect(f.plugins.socketCount('crm')).toBe(0);
});

it('closes a deactivated person’s plugin sockets', async () => {
    const f = await fixture();
    const opened = await f.handshake({ cookie: await f.signIn('bob') });
    expect(opened.head).toMatch(/^HTTP\/1.1 101/);
    const shut = f.closed(opened.socket);
    f.plugins.endAccessOf('bob');
    await shut;
});

it('on the internal listener, takes a socio’s socket and refuses a person’s cookie', async () => {
    const f = await fixture({ socioOnly: true, socioOnPublicHost: false });
    const cookie = await f.signIn('bob');
    expect((await f.handshake({ cookie })).head).toMatch(/^HTTP\/1.1 401/);
    expect(f.up.upgrades).toEqual([]);
    const s = await f.socio();
    expect(
        (
            await f.handshake({
                authorization: `Bearer ${s.token}`,
                'x-cb-context': s.proof(),
            })
        ).head,
    ).toMatch(/^HTTP\/1.1 101/);
});

it('opens no socio socket while a live runtime enforces an older actor-access contract', async () => {
    const f = await fixture();
    const s = await f.socio();
    vi.spyOn(f.platform.actors, 'issuable').mockReturnValue(false);
    expect(
        (
            await f.handshake({
                authorization: `Bearer ${s.token}`,
                'x-cb-context': s.proof(),
            })
        ).head,
    ).toMatch(/^HTTP\/1.1 403/);
    expect(f.up.upgrades).toEqual([]);
});
