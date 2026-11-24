import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serve } from '@hono/node-server';
import { afterEach, expect, it, vi } from 'vitest';

import { sqliteData } from '@socio/data/open';
import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';
import { RUNTIME_HEADER_PLUGIN_PROOF } from '@socio/shared/apps/apps-runtime-types';
import type { PluginServiceSpec } from '@socio/shared/plugins/plugin-service';
import { pluginUpdateAck } from '@socio/shared/plugins/plugin-update';
import type { User } from '@socio/shared/types';

import { ingressServer } from '../src/apps-runtime/ingress.js';
import { pluginProof } from '../src/apps-runtime/keys.js';
import { WebhookLimits, appsUpgrade, webhookRoute } from '../src/server/apps/proxy.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { parseManifest, parseManifestWebhooks } from '../src/server/plugins/catalog.js';
import type { PluginRuntime } from '../src/server/plugins/contract.js';
import { pluginsModule } from '../src/server/plugins/module.js';

import { updateAcked } from './helpers/plugin-update.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-370: public inbound webhooks for service plugins. The apps proxy
// serves the paths a manifest declares with no session, for their one
// method, rate- and size-limited, the body byte for byte, the client's
// x-cb-* headers stripped, no identity header added, and the ingress's
// plugin proof attached. Negative cases first.

const SECRET = 'secret-0123456789abcdef-xyz';
const RUNTIME = 'runtime-secret-runtime-secret-32';
const SERVICE = 'plugin-service-token-plugin-service-token';
const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
];
const IMAGE = `company-brain-plugin-crm@sha256:${'a'.repeat(64)}`;
const IMAGE_2 = `company-brain-plugin-crm@sha256:${'b'.repeat(64)}`;

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
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

interface Seen {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body: Buffer;
}

/** The plugin's task: records each request, answers 202 with a cookie it must lose. */
async function task() {
    const seen: Seen[] = [];
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
            res.writeHead(202, { 'content-type': 'text/plain', 'set-cookie': 'plugin=1' });
            res.end('accepted');
        });
    });
    // Its WebSockets: answered with 101 and kept open, until either side closes.
    const sockets = new Set<Socket>();
    server.on('upgrade', (_req, socket: Socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    cleanup.push(() => {
        for (const socket of sockets) {
            socket.destroy();
        }
        return closeServer(server)();
    });
    return { port: (server.address() as AddressInfo).port, seen, sockets };
}

const WEBHOOKS = [
    { path: '/webhooks/crm', maxBodyBytes: 64 },
    { path: '/webhooks/limited', perMinute: 2 },
    { path: '/oauth/crm/callback', method: 'GET' },
];

const BASE_ENTRY = {
    id: 'crm',
    name: 'CRM',
    version: '1.0.0',
    author: 'Test',
    description: 'Deals.',
    display: 'tab',
    permissions: ['crm:read'],
    service: { image: IMAGE, port: 8080 },
};

/** A catalog file, a plugin task and the runtime ingress, which outlive a Socio restart. */
async function environment() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-plugin-hooks-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const catalog = join(dir, 'catalog.json');
    const writeCatalog = (entry: Record<string, unknown>) =>
        writeFileSync(catalog, JSON.stringify({ plugins: [entry] }));
    const up = await task();
    /** Whether the plugin's one task runs the service's current revision; `hold` keeps an old one through a provision (a rollout not done). */
    const tasks = { current: true, hold: false, label: '', replicas: 1, identity: undefined as number | undefined };
    /** Set: the next provision waits for it, as a slow runtime call. */
    const slow: { next?: Promise<void>; early?: boolean } = {};
    /** How many of the next status reads fail, as a runtime that doesn't answer. */
    const statusFails = { count: 0 };
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
            // As the runtime's: with an install revision, only while the service
            // runs it, and only a task of the service's current container.
            targets: async (_id: string, revision?: string) =>
                revision === undefined || (revision === tasks.label && tasks.current)
                    ? [{ host: '127.0.0.1', port: up.port }]
                    : [],
            proof: (id: string) => pluginProof(RUNTIME, id),
        } as never,
    );
    await new Promise<void>((ok) => ingress.listen(0, '127.0.0.1', () => ok()));
    cleanup.push(closeServer(ingress));
    // Upgraded sockets first: an open one keeps the ingress from closing.
    cleanup.push(() => {
        for (const socket of up.sockets) {
            socket.destroy();
        }
    });
    /** Every image the runtime was asked to run, in order. */
    const provisioned: string[] = [];
    /** Set: the runtime refuses the next provisions, as for an unpinned digest. */
    const refuse = { next: false };
    return {
        dir,
        catalog,
        writeCatalog,
        up,
        ingressPort: (ingress.address() as AddressInfo).port,
        provisioned,
        refuse,
        tasks,
        slow,
        statusFails,
    };
}

/** Socio over the environment's database and catalog, as the server boots; installs `crm` when asked. */
async function boot(env: Awaited<ReturnType<typeof environment>>, { install = true } = {}) {
    const running = {
        id: 'crm',
        service: 'socio-plugin-crm',
        image: IMAGE,
        replicas: 1,
        running: 1,
        state: 'running' as const,
    };
    const { app, workspace, platform, db, dispose } = await makeTestRuntime({
        database: join(env.dir, 'socio.db'),
        config: {
            sessionSecret: SECRET,
            appOrigin: 'http://localhost:4310',
            data: { userDataDir: env.dir, apiUrl: 'http://company-brain-app:4310' },
            apps: appsSettingsFromEnv({}, 'http://localhost:4310')!,
            appsRuntime: {
                url: 'http://127.0.0.1:9',
                token: RUNTIME,
                ingress: { host: '127.0.0.1', port: env.ingressPort },
            },
            plugins: {
                catalogs: [{ kind: 'file', path: env.catalog }],
                serviceToken: SERVICE,
                runtime: {
                    provisionService: async (_id: string, spec: PluginServiceSpec, identity?: { version: number }) => {
                        if (env.refuse.next) {
                            throw Object.assign(new Error('The image digest is not pinned.'), { status: 400 });
                        }
                        const { next: wait, early } = env.slow;
                        env.slow.next = undefined;
                        env.slow.early = false;
                        // The service takes the spec: its image, revision label and tasks.
                        const land = () => {
                            env.provisioned.push(spec.image ?? '');
                            env.tasks.label = spec.revision ?? '';
                            env.tasks.replicas = spec.replicas ?? 1;
                            env.tasks.identity = identity?.version;
                            env.tasks.current = !env.tasks.hold;
                        };
                        if (early) {
                            land();
                            await wait;
                        } else {
                            await wait;
                            land();
                        }
                        return running;
                    },
                    scaleService: async (_id: string, replicas: number) => {
                        env.tasks.replicas = replicas;
                        return { ...running, replicas };
                    },
                    removeService: async () => {},
                    serviceStatus: async () => {
                        if (env.statusFails.count > 0) {
                            env.statusFails.count--;
                            throw new Error('The runtime did not answer.');
                        }
                        return {
                            ...running,
                            replicas: env.tasks.replicas,
                            revision: env.tasks.label,
                            ...(env.tasks.identity === undefined ? {} : { identity: env.tasks.identity }),
                        };
                    },
                },
            },
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            origin: 'http://localhost:4310',
            auth: { provider: new MockAuthProvider(USERS, SECRET), secureCookies: false },
        },
    });
    cleanup.push(dispose);
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    if (install) {
        await platform.plugins.install('crm');
    }
    const origin = platform.plugins.origin('crm')!;
    // The apps origin as the server entry serves it, so raw requests and
    // chunked bodies take the real path.
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((ok) => (server.listening ? ok() : server.once('listening', () => ok())));
    const close = closeServer(server as Server);
    cleanup.push(close);
    const port = (server.address() as AddressInfo).port;
    /** One raw request on the plugin's host: status, headers and body. */
    const send = (method: string, target: string, headers: Record<string, string> = {}, body?: Buffer | Buffer[]) =>
        new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>((resolve, reject) => {
            const req = httpRequest(
                { host: '127.0.0.1', port, method, path: target, headers: { host: new URL(origin).host, ...headers } },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer) => chunks.push(chunk));
                    res.on('end', () =>
                        resolve({
                            status: res.statusCode!,
                            headers: res.headers,
                            text: Buffer.concat(chunks).toString(),
                        }),
                    );
                },
            );
            req.on('error', reject);
            for (const part of Array.isArray(body) ? body : body ? [body] : []) {
                req.write(part);
            }
            req.end();
        });
    /** Stops this Socio, as a restart does; the database and catalog stay. */
    const stop = async () => {
        await close();
        await dispose();
    };
    /** A raw connection to this Socio's apps origin, for requests a test writes byte by byte. */
    const raw = () => {
        const socket = connect({ host: '127.0.0.1', port });
        cleanup.push(() => socket.destroy());
        return socket;
    };
    return { app, workspace, platform, db, origin, send, raw, seen: env.up.seen, stop };
}

async function fixture() {
    const env = await environment();
    env.writeCatalog({ ...BASE_ENTRY, webhooks: WEBHOOKS });
    return boot(env);
}

it('refuses what a webhook path does not take, and sends the plugin nothing', async () => {
    const { send, seen, platform } = await fixture();
    // Another method on a declared path.
    const get = await send('GET', '/webhooks/crm');
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
    expect((await send('POST', '/oauth/crm/callback')).headers.allow).toBe('GET');
    // A path the manifest does not declare still needs a session.
    expect(
        (await send('POST', '/webhooks/other', { 'content-type': 'application/json' }, Buffer.from('{}'))).status,
    ).toBe(401);
    expect((await send('POST', '/webhooks/crm/')).status).toBe(401);
    expect((await send('POST', '/webhooks%2Fghl')).status).toBe(401);
    // Over the path's limit: by its length, and by a chunked body.
    expect((await send('POST', '/webhooks/crm', { 'content-length': '65' }, Buffer.alloc(65, 1))).status).toBe(413);
    expect(
        (await send('POST', '/webhooks/crm', { 'transfer-encoding': 'chunked' }, [Buffer.alloc(40), Buffer.alloc(40)]))
            .status,
    ).toBe(413);
    // A GET callback takes no body.
    expect(
        (await send('GET', '/oauth/crm/callback', { 'transfer-encoding': 'chunked' }, [Buffer.from('x')])).status,
    ).toBe(413);
    // A disabled plugin answers nothing of its own.
    await platform.plugins.setEnabled('crm', false);
    expect((await send('POST', '/webhooks/crm', {}, Buffer.from('{}'))).status).toBe(503);
    expect(seen).toEqual([]);
});

it('rate-limits each path on its own', async () => {
    const { send, seen } = await fixture();
    expect((await send('POST', '/webhooks/limited', {}, Buffer.from('1'))).status).toBe(202);
    expect((await send('POST', '/webhooks/limited', {}, Buffer.from('2'))).status).toBe(202);
    const over = await send('POST', '/webhooks/limited', {}, Buffer.from('3'));
    expect(over.status).toBe(429);
    expect(over.headers['retry-after']).toBe('60');
    // Another path keeps its own budget.
    expect((await send('POST', '/webhooks/crm', {}, Buffer.from('4'))).status).toBe(202);
    expect(seen.map((row) => row.body.toString())).toEqual(['1', '2', '4']);
});

it('passes the body byte for byte, strips client x-cb-* headers and adds no identity', async () => {
    const { send, seen } = await fixture();
    const body = Buffer.from([0x7b, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x22, 0xe2, 0x82, 0x7d]);
    const response = await send(
        'POST',
        '/webhooks/crm?location=abc',
        {
            'content-type': 'application/json',
            'x-crm-signature': 'sig-value',
            authorization: 'Basic dXNlcjpwYXNz',
            cookie: 'socio_app=stolen; other=1',
            'x-cb-user': 'forged',
            'x-cb-person': 'forged',
            'x-cb-actor': 'forged',
            'x-cb-plugin-proof': 'forged',
            'x-forwarded-for': '203.0.113.9',
        },
        body,
    );
    expect(response.status).toBe(202);
    expect(response.text).toBe('accepted');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(seen).toHaveLength(1);
    const [hit] = seen;
    expect(hit!.method).toBe('POST');
    expect(hit!.url).toBe('/webhooks/crm?location=abc');
    expect(hit!.body.equals(body)).toBe(true);
    expect(hit!.headers['x-crm-signature']).toBe('sig-value');
    expect(hit!.headers.authorization).toBe('Basic dXNlcjpwYXNz');
    expect(hit!.headers.cookie).toBeUndefined();
    expect(hit!.headers['x-forwarded-for']).toBeUndefined();
    // The ingress's own proof, not the client's; no other x-cb-* header.
    expect(hit!.headers[RUNTIME_HEADER_PLUGIN_PROOF]).toBe(pluginProof(RUNTIME, 'crm'));
    expect(Object.keys(hit!.headers).filter((name) => name.startsWith('x-cb-'))).toEqual([RUNTIME_HEADER_PLUGIN_PROOF]);
});

it('serves the GET callback with its query, and never passes a socio credential', async () => {
    const { send, seen } = await fixture();
    const response = await send('GET', '/oauth/crm/callback?code=abc&state=xyz', {
        authorization: 'Bearer cbsa_abcdefghijklmnop',
    });
    expect(response.status).toBe(202);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.url).toBe('/oauth/crm/callback?code=abc&state=xyz');
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.body.length).toBe(0);
    // Any spelling of the scheme, or none.
    for (const authorization of ['bearer cbsa_abcdefghijklmnop', 'BEARER  cbsa_abc', 'cbsa_abcdefghijklmnop']) {
        expect((await send('POST', '/webhooks/crm', { authorization }, Buffer.from('{}'))).status).toBe(202);
    }
    expect(seen.slice(1).map((row) => row.headers.authorization)).toEqual([undefined, undefined, undefined]);
});

it('gives a plugin installed before webhooks its paths on an admin’s update, with no reinstall, never before', async () => {
    const env = await environment();
    env.writeCatalog(BASE_ENTRY);
    let socio = await boot(env);
    const hook = () =>
        socio.send('POST', '/webhooks/crm', { 'content-type': 'application/json' }, Buffer.from('{"a":1}'));
    // Installed with no webhooks: the path needs a session, as any other.
    expect((await hook()).status).toBe(401);

    // The operator's catalog moves to a version with webhooks; Socio restarts.
    await socio.stop();
    env.writeCatalog({
        ...BASE_ENTRY,
        version: '1.1.0',
        service: { image: IMAGE_2, port: 8080 },
        webhooks: [{ path: '/webhooks/crm' }],
    });
    socio = await boot(env, { install: false });
    // A restart never widens what is served past the installed manifest.
    expect(socio.platform.plugins.get('crm')!.version).toBe('1.0.0');
    expect((await hook()).status).toBe(401);
    const login = async (userId: string) =>
        (
            await socio.app.request('/api/auth/mock/login', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ userId }),
            })
        ).headers
            .get('set-cookie')!
            .split(';')[0]!;
    const admin = await login('alice');
    const listed = (await (
        await socio.app.request('http://localhost:4310/api/plugins', { headers: { cookie: admin } })
    ).json()) as { installed: Array<{ id: string; version: string; update?: { version: string } }> };
    expect(listed.installed.find((row) => row.id === 'crm')).toMatchObject({
        version: '1.0.0',
        update: { version: '1.1.0' },
    });
    const update = (cookie: string) =>
        socio.app.request('http://localhost:4310/api/plugins/crm/update', {
            method: 'POST',
            headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ acknowledged: pluginUpdateAck(review) }),
        });
    const review = socio.platform.plugins.updateReview('crm')!;
    // Only an admin updates.
    expect((await update(await login('bob'))).status).toBe(403);
    expect(socio.platform.plugins.get('crm')!.version).toBe('1.0.0');

    const before = env.provisioned.length;
    const updated = await update(admin);
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ changed: true, from: '1.0.0', version: '1.1.0' });
    // In place: the service runs the new image; still installed, same install.
    expect(env.provisioned.slice(before)).toEqual([IMAGE_2]);
    expect(socio.platform.plugins.get('crm')).toMatchObject({ version: '1.1.0', enabled: true });
    expect((await hook()).status).toBe(202);
    expect(socio.seen.map((row) => row.body.toString())).toEqual(['{"a":1}']);
    expect(socio.workspace.auditOf('plugin', 'crm')).toEqual([
        expect.objectContaining({
            actor: 'alice',
            action: 'update',
            detail: expect.stringMatching(
                /^from 1\.0\.0 to 1\.1\.0; webhooks none -> POST \/webhooks\/crm; acknowledged webhook:POST \/webhooks\/crm \(/,
            ),
        }),
    ]);
    // Nothing more to adopt: no change, no audit line.
    expect(await (await update(admin)).json()).toEqual({ changed: false, from: '1.1.0', version: '1.1.0' });
    expect(socio.workspace.auditOf('plugin', 'crm')).toHaveLength(1);

    // A later version drops the path: served until the update, then refused.
    await socio.stop();
    env.writeCatalog({ ...BASE_ENTRY, version: '1.2.0', service: { image: IMAGE_2, port: 8080 } });
    socio = await boot(env, { install: false });
    expect((await hook()).status).toBe(202);
    await updateAcked(socio.platform.plugins, 'crm', 'alice');
    expect((await hook()).status).toBe(401);
});

it('narrows and widens webhook paths on every runtime of a deploy as soon as one updates', async () => {
    const env = await environment();
    env.writeCatalog({ ...BASE_ENTRY, webhooks: [{ path: '/webhooks/crm' }] });
    const a = await boot(env);
    // The deploy's other runtime, over the same database and catalog.
    const b = await boot(env, { install: false });
    const hook = (on: typeof a) => on.send('POST', '/webhooks/crm', {}, Buffer.from('{}'));
    expect((await hook(b)).status).toBe(202);

    // A new version without the path, adopted on runtime a: b refuses it at once.
    env.writeCatalog({ ...BASE_ENTRY, version: '1.1.0', service: { image: IMAGE_2, port: 8080 } });
    const a2 = await boot(env, { install: false });
    await updateAcked(a2.platform.plugins, 'crm', 'alice');
    expect((await hook(b)).status).toBe(401);
    expect((await hook(a)).status).toBe(401);
    // Disabled on one runtime: refused on the others too.
    env.writeCatalog({
        ...BASE_ENTRY,
        version: '1.2.0',
        service: { image: IMAGE, port: 8080 },
        webhooks: [{ path: '/webhooks/crm' }],
    });
    const a3 = await boot(env, { install: false });
    await updateAcked(a3.platform.plugins, 'crm', 'alice');
    expect((await hook(b)).status).toBe(202);
    await a3.platform.plugins.setEnabled('crm', false, 'alice');
    expect((await hook(b)).status).toBe(503);
});

it('starts every change from the install as the database has it, so no runtime undoes another’s update', async () => {
    const env = await environment();
    env.writeCatalog({ ...BASE_ENTRY, config: { REGION: { description: 'Region' } } });
    const b = await boot(env);
    // Runtime a boots on the new catalog and updates; b still holds 1.0.0.
    env.writeCatalog({
        ...BASE_ENTRY,
        version: '1.1.0',
        config: { REGION: { description: 'Region' } },
        service: { image: IMAGE_2, port: 8080 },
        webhooks: [{ path: '/webhooks/crm' }],
    });
    const a = await boot(env, { install: false });
    await updateAcked(a.platform.plugins, 'crm', 'alice');
    // A config change on b provisions the updated image, never the old one.
    const before = env.provisioned.length;
    await b.platform.plugins.configure('crm', { REGION: 'us' });
    expect(env.provisioned.slice(before)).toEqual([IMAGE_2]);
    expect(b.platform.plugins.current('crm')).toMatchObject({ version: '1.1.0', config: { REGION: 'us' } });
    // Disabled on b after a2 booted: a2's update, from a copy that says enabled, provisions nothing.
    env.writeCatalog({ ...BASE_ENTRY, version: '1.2.0', config: { REGION: { description: 'Region' } } });
    const a2 = await boot(env, { install: false });
    expect(a2.platform.plugins.get('crm')!.enabled).toBe(true);
    await b.platform.plugins.setEnabled('crm', false, 'alice');
    const quiet = env.provisioned.length;
    await updateAcked(a2.platform.plugins, 'crm', 'alice');
    expect(env.provisioned.length).toBe(quiet);
    expect(a2.platform.plugins.current('crm')).toMatchObject({
        version: '1.2.0',
        enabled: false,
        config: { REGION: 'us' },
    });
});

it('applies an update’s narrower permissions on every runtime at once', async () => {
    const env = await environment();
    env.writeCatalog({ ...BASE_ENTRY, permissions: ['crm:read', 'person:read'] });
    const b = await boot(env);
    expect(Object.keys(await b.platform.plugins.personHeaders('crm', 'alice'))).toContain('x-cb-person');
    env.writeCatalog({ ...BASE_ENTRY, version: '1.1.0', service: { image: IMAGE_2, port: 8080 } });
    const a = await boot(env, { install: false });
    await updateAcked(a.platform.plugins, 'crm', 'alice');
    // b, booted before the update, no longer tells the plugin who the person is.
    expect(b.platform.plugins.get('crm')).toMatchObject({ version: '1.1.0', permissions: ['crm:read'] });
    expect(Object.keys(await b.platform.plugins.personHeaders('crm', 'alice'))).not.toContain('x-cb-person');
});

it('asks again once the body is in: an upload that outlives its path is refused', async () => {
    const env = await environment();
    env.writeCatalog({ ...BASE_ENTRY, webhooks: [{ path: '/webhooks/crm' }] });
    const b = await boot(env);
    env.writeCatalog({ ...BASE_ENTRY, version: '1.1.0', service: { image: IMAGE_2, port: 8080 } });
    const a = await boot(env, { install: false });
    const socket = b.raw();
    let answer = '';
    socket.on('data', (chunk) => (answer += chunk.toString()));
    const ended = new Promise<void>((ok) => socket.on('close', () => ok()));
    await new Promise<void>((ok) => socket.once('connect', () => ok()));
    socket.write(
        `POST /webhooks/crm HTTP/1.1\r\nhost: ${new URL(b.origin).host}\r\ncontent-length: 4\r\nconnection: close\r\n\r\n{}`,
    );
    // While it uploads, the path goes away on the other runtime.
    await new Promise((ok) => setTimeout(ok, 200));
    await updateAcked(a.platform.plugins, 'crm', 'alice');
    socket.write('{}');
    await ended;
    expect(answer).toMatch(/^HTTP\/1\.1 404/);
    expect(b.seen).toEqual([]);
});

it('closes a plugin socket on every runtime within 5 s of an update', async () => {
    const env = await environment();
    env.writeCatalog(BASE_ENTRY);
    const b = await boot(env);
    // The server entry's upgrades on b's origin, as the websocket suite wires them.
    const login = (
        await b.app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ userId: 'alice' }),
        })
    ).headers
        .get('set-cookie')!
        .split(';')[0]!;
    const launched = await b.app.request('http://localhost:4310/api/plugins/crm/launch', {
        method: 'POST',
        headers: { cookie: login, 'content-type': 'application/json' },
        body: '{}',
    });
    const { url } = (await launched.json()) as { url: string };
    const session = (await b.app.request(url)).headers.get('set-cookie')!.split(';')[0]!;
    const upgrade = appsUpgrade(b.platform.apps);
    const server = createServer();
    server.on('upgrade', (request, socket, head) => {
        if (!upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    cleanup.push(closeServer(server));
    const socket = connect({ host: '127.0.0.1', port: (server.address() as AddressInfo).port });
    cleanup.push(() => socket.destroy());
    let head = '';
    const opened = new Promise<void>((ok) =>
        socket.on('data', (chunk) => {
            head += chunk.toString();
            if (head.includes('\r\n\r\n')) {
                ok();
            }
        }),
    );
    const ended = new Promise<number>((ok) => socket.on('close', () => ok(Date.now())));
    socket.write(
        `GET /ws HTTP/1.1\r\nhost: ${new URL(b.origin).host}\r\norigin: ${b.origin}\r\ncookie: ${session}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n\r\n`,
    );
    await opened;
    expect(head).toMatch(/^HTTP\/1\.1 101/);
    // Updated on the other runtime, which holds none of b's sockets.
    env.writeCatalog({ ...BASE_ENTRY, version: '1.1.0', service: { image: IMAGE_2, port: 8080 } });
    const a = await boot(env, { install: false });
    const at = Date.now();
    await updateAcked(a.platform.plugins, 'crm', 'alice');
    expect((await ended) - at).toBeLessThan(5_000 + 2_000);
}, 60_000);

it('sees another runtime’s writes however close together, even in the same millisecond', async () => {
    const env = await environment();
    env.writeCatalog({
        ...BASE_ENTRY,
        permissions: ['crm:read', 'person:read'],
        config: { REGION: { description: 'Region' } },
    });
    const b = await boot(env);
    env.writeCatalog({ ...BASE_ENTRY, version: '1.1.0', config: { REGION: { description: 'Region' } } });
    const a = await boot(env, { install: false });
    const frozen = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(frozen);
    await a.platform.plugins.configure('crm', { REGION: 'us' });
    // b reads the first write...
    expect(b.platform.plugins.get('crm')!.config).toEqual({ REGION: 'us' });
    // ...and the second, stamped the same millisecond, drops person:read.
    await updateAcked(a.platform.plugins, 'crm', 'alice');
    expect(b.platform.plugins.get('crm')!.permissions).toEqual(['crm:read']);
    vi.restoreAllMocks();
    expect(Object.keys(await b.platform.plugins.personHeaders('crm', 'alice'))).not.toContain('x-cb-person');
});

it('audits every public path an update removes and adds, however long', async () => {
    const env = await environment();
    const long = (prefix: string) =>
        Array.from({ length: 10 }, (_, i) => ({
            path: `/${prefix}${i}/${'a'.repeat(60)}/${'b'.repeat(60)}/${'c'.repeat(60)}`,
        }));
    env.writeCatalog({ ...BASE_ENTRY, webhooks: long('old') });
    await boot(env).then((socio) => socio.stop());
    env.writeCatalog({ ...BASE_ENTRY, version: '1.1.0', webhooks: long('new') });
    const socio = await boot(env, { install: false });
    const admin = (
        await socio.app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ userId: 'alice' }),
        })
    ).headers
        .get('set-cookie')!
        .split(';')[0]!;
    const updated = await socio.app.request('http://localhost:4310/api/plugins/crm/update', {
        method: 'POST',
        headers: { cookie: admin, 'content-type': 'application/json' },
        body: JSON.stringify({ acknowledged: pluginUpdateAck(socio.platform.plugins.updateReview('crm')!) }),
    });
    expect(updated.status).toBe(200);
    const [line] = socio.workspace.auditOf('plugin', 'crm');
    for (const hook of [...long('old'), ...long('new')]) {
        expect(line!.detail).toContain(`POST ${hook.path}`);
    }
});

it('sends a newly public path only to a task of the updated revision, never to one the rollout has not replaced', async () => {
    const env = await environment();
    env.writeCatalog(BASE_ENTRY);
    await boot(env).then((socio) => socio.stop());
    env.writeCatalog({
        ...BASE_ENTRY,
        version: '1.1.0',
        service: { image: IMAGE_2, port: 8080 },
        webhooks: [{ path: '/webhooks/crm' }],
    });
    const socio = await boot(env, { install: false });
    // The runtime accepts the update, but the old task still runs.
    env.tasks.hold = true;
    await updateAcked(socio.platform.plugins, 'crm', 'alice');
    expect(env.tasks.current).toBe(false);
    expect((await socio.send('POST', '/webhooks/crm', {}, Buffer.from('{}'))).status).toBe(502);
    expect(socio.seen).toEqual([]);
    // Rolled out: the new task answers.
    env.tasks.current = true;
    expect((await socio.send('POST', '/webhooks/crm', {}, Buffer.from('{}'))).status).toBe(202);
    expect(socio.seen).toHaveLength(1);
});

it('fails closed while an update is in flight: a path the new version drops is never public to its code', async () => {
    const env = await environment();
    env.writeCatalog({ ...BASE_ENTRY, webhooks: [{ path: '/webhooks/crm' }] });
    const socio = await boot(env);
    expect((await socio.send('POST', '/webhooks/crm', {}, Buffer.from('{}'))).status).toBe(202);
    await socio.stop();
    env.writeCatalog({ ...BASE_ENTRY, version: '1.1.0', service: { image: IMAGE_2, port: 8080 } });
    const next = await boot(env, { install: false });
    // The runtime runs the new service; the update hasn't committed the new manifest yet.
    let release!: () => void;
    env.slow.next = new Promise<void>((ok) => (release = ok));
    env.slow.early = true;
    const updating = updateAcked(next.platform.plugins, 'crm', 'alice');
    await new Promise((ok) => setTimeout(ok, 20));
    expect(env.provisioned.at(-1)).toBe(IMAGE_2);
    expect(next.platform.plugins.current('crm')!.version).toBe('1.0.0');
    expect((await next.send('POST', '/webhooks/crm', {}, Buffer.from('{}'))).status).toBe(502);
    release();
    await updating;
    expect((await next.send('POST', '/webhooks/crm', {}, Buffer.from('{}'))).status).toBe(401);
    // Only the request before the update ever reached the plugin.
    expect(next.seen).toHaveLength(1);
});

it('converges after a stale change races an update, failing closed until it does', async () => {
    const env = await environment();
    env.writeCatalog({ ...BASE_ENTRY, config: { REGION: { description: 'Region' } } });
    const b = await boot(env);
    env.writeCatalog({
        ...BASE_ENTRY,
        version: '1.1.0',
        config: { REGION: { description: 'Region' } },
        service: { image: IMAGE_2, port: 8080 },
        webhooks: [{ path: '/webhooks/crm' }],
    });
    const a = await boot(env, { install: false });
    // b's settings change reads 1.0.0, then its provision stalls...
    let release!: () => void;
    env.slow.next = new Promise<void>((ok) => (release = ok));
    const configuring = b.platform.plugins.configure('crm', { REGION: 'us' });
    await new Promise((ok) => setTimeout(ok, 20));
    // ...while a updates to 1.1.0, which makes the path public.
    await updateAcked(a.platform.plugins, 'crm', 'alice');
    expect((await a.send('POST', '/webhooks/crm', {}, Buffer.from('{}'))).status).toBe(202);
    // b's stale provision lands: 1.0.0's code runs, so the path fails closed...
    const landed = env.provisioned.length;
    let again!: () => void;
    env.slow.next = new Promise<void>((ok) => (again = ok));
    release();
    await new Promise((ok) => setTimeout(ok, 20));
    expect(env.provisioned[landed]).toBe(IMAGE);
    expect((await a.send('POST', '/webhooks/crm', {}, Buffer.from('{}'))).status).toBe(502);
    again();
    await configuring;
    // ...until b sees the install moved and provisions it: the new code again.
    expect(env.provisioned.at(-1)).toBe(IMAGE_2);
    expect(a.platform.plugins.current('crm')).toMatchObject({ version: '1.1.0', config: { REGION: 'us' } });
    expect((await a.send('POST', '/webhooks/crm', {}, Buffer.from('{}'))).status).toBe(202);
    expect(a.seen.map((row) => row.url)).toEqual(['/webhooks/crm', '/webhooks/crm']);
});

it('converges when a change on another runtime lands while an update waits for the runtime', async () => {
    const env = await environment();
    env.writeCatalog({ ...BASE_ENTRY, config: { REGION: { description: 'Region' } } });
    const b = await boot(env);
    env.writeCatalog({
        ...BASE_ENTRY,
        version: '1.1.0',
        config: { REGION: { description: 'Region' } },
        service: { image: IMAGE_2, port: 8080 },
        webhooks: [{ path: '/webhooks/crm' }],
    });
    const a = await boot(env, { install: false });
    // a's update reaches the runtime, but its answer is slow...
    let release!: () => void;
    env.slow.next = new Promise<void>((ok) => (release = ok));
    env.slow.early = true;
    const updating = updateAcked(a.platform.plugins, 'crm', 'alice');
    await new Promise((ok) => setTimeout(ok, 20));
    // ...while b, still on 1.0.0 in the database, changes settings and provisions 1.0.0.
    await b.platform.plugins.configure('crm', { REGION: 'us' });
    expect(env.provisioned.at(-1)).toBe(IMAGE);
    release();
    await updating;
    // a records 1.1.0, sees the runtime on another revision, and provisions the installed one.
    expect(env.provisioned.at(-1)).toBe(IMAGE_2);
    expect(a.platform.plugins.current('crm')).toMatchObject({ version: '1.1.0', config: { REGION: 'us' } });
    expect((await a.send('POST', '/webhooks/crm', {}, Buffer.from('{}'))).status).toBe(202);
});

it('puts a service a race left behind back on its installed revision on the tick', async () => {
    const env = await environment();
    env.writeCatalog({ ...BASE_ENTRY, webhooks: [{ path: '/webhooks/crm' }] });
    const socio = await boot(env);
    // Something provisioned another revision and nothing settled it.
    env.tasks.label = 'f'.repeat(64);
    expect((await socio.send('POST', '/webhooks/crm', {}, Buffer.from('{}'))).status).toBe(502);
    await socio.platform.plugins.reconcileAll();
    expect(env.tasks.label).toBe(socio.platform.plugins.current('crm')!.revision);
    expect((await socio.send('POST', '/webhooks/crm', {}, Buffer.from('{}'))).status).toBe(202);
});

it('finishes and audits an update the runtime then fails to confirm, and keeps settings changed meanwhile', async () => {
    const env = await environment();
    env.writeCatalog({
        ...BASE_ENTRY,
        config: { REGION: { description: 'Region' }, OLD: { description: 'Gone in 1.1.0' } },
    });
    const b = await boot(env);
    await b.platform.plugins.configure('crm', { REGION: 'us', OLD: 'x' });
    env.writeCatalog({
        ...BASE_ENTRY,
        version: '1.1.0',
        config: { REGION: { description: 'Region' } },
        service: { image: IMAGE_2, port: 8080 },
        webhooks: [{ path: '/webhooks/crm' }],
    });
    const a = await boot(env, { install: false });
    // a's update provisions slowly; meanwhile b changes REGION.
    let release!: () => void;
    env.slow.next = new Promise<void>((ok) => (release = ok));
    const updating = a.app.request('http://localhost:4310/api/plugins/crm/update', {
        method: 'POST',
        headers: {
            cookie: (
                await a.app.request('/api/auth/mock/login', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ userId: 'alice' }),
                })
            ).headers
                .get('set-cookie')!
                .split(';')[0]!,
            'content-type': 'application/json',
        },
        body: JSON.stringify({ acknowledged: pluginUpdateAck(a.platform.plugins.updateReview('crm')!) }),
    });
    await new Promise((ok) => setTimeout(ok, 20));
    await b.platform.plugins.configure('crm', { REGION: 'eu', OLD: 'x' });
    // ...and the runtime then fails to answer a's check.
    env.statusFails.count = 1;
    release();
    const updated = await updating;
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ changed: true, from: '1.0.0', version: '1.1.0' });
    expect(a.workspace.auditOf('plugin', 'crm')).toHaveLength(1);
    // b's REGION stayed; the dropped setting went.
    expect(a.platform.plugins.current('crm')).toMatchObject({ version: '1.1.0', config: { REGION: 'eu' } });
    // The tick settles the service on the installed revision.
    await a.platform.plugins.reconcileAll();
    expect(env.tasks.label).toBe(a.platform.plugins.current('crm')!.revision);
    expect((await a.send('POST', '/webhooks/crm', {}, Buffer.from('{}'))).status).toBe(202);
});

it('restores a replica count a scale set while an update was provisioning', async () => {
    const env = await environment();
    env.writeCatalog(BASE_ENTRY);
    const b = await boot(env);
    env.writeCatalog({ ...BASE_ENTRY, version: '1.1.0', service: { image: IMAGE_2, port: 8080 } });
    const a = await boot(env, { install: false });
    // a's update reads 1 replica and provisions slowly; b scales to 3 meanwhile.
    let release!: () => void;
    env.slow.next = new Promise<void>((ok) => (release = ok));
    const updating = updateAcked(a.platform.plugins, 'crm', 'alice');
    await new Promise((ok) => setTimeout(ok, 20));
    await b.platform.plugins.scale('crm', 3);
    expect(env.tasks.replicas).toBe(3);
    release();
    await updating;
    // The provision landed with 1; the database says 3, and so does the runtime again.
    expect(a.platform.plugins.current('crm')!.replicas).toBe(3);
    expect(env.tasks.replicas).toBe(3);
    // And the tick does the same for a drift nothing settled.
    env.tasks.replicas = 1;
    await a.platform.plugins.reconcileAll();
    expect(env.tasks.replicas).toBe(3);
});

it('answers an update only once its manifest is committed, however long the write queue', async () => {
    const env = await environment();
    env.writeCatalog({ ...BASE_ENTRY, permissions: ['crm:read', 'person:read'] });
    await boot(env).then((socio) => socio.stop());
    env.writeCatalog({ ...BASE_ENTRY, version: '1.1.0', service: { image: IMAGE_2, port: 8080 } });
    const socio = await boot(env, { install: false });
    // Every unit of work waits its turn behind others for a while.
    const uow = sqliteData(socio.db).uow;
    const transact = uow.transact.bind(uow);
    vi.spyOn(uow, 'transact').mockImplementation(((work: never, options: never) =>
        new Promise((ok) => setTimeout(ok, 50)).then(() => transact(work, options))) as typeof uow.transact);
    const before = env.provisioned.length;
    const updated = await updateAcked(socio.platform.plugins, 'crm', 'alice');
    expect(updated).toMatchObject({ changed: true, to: '1.1.0' });
    // One provision, of the new image: nothing read the old row back as current.
    expect(env.provisioned.slice(before)).toEqual([IMAGE_2]);
    expect(socio.db.prepare('SELECT version, permissions FROM plugin_installs WHERE id=?').get('crm')).toEqual({
        version: '1.1.0',
        permissions: '["crm:read"]',
    });
    expect(socio.platform.plugins.get('crm')).toMatchObject({ version: '1.1.0', permissions: ['crm:read'] });
});

it('keeps the service on the newest identity when two identical updates land in reverse order', async () => {
    const env = await environment();
    env.writeCatalog(BASE_ENTRY);
    await boot(env).then((socio) => socio.stop());
    env.writeCatalog({ ...BASE_ENTRY, version: '1.1.0', service: { image: IMAGE_2, port: 8080 } });
    const a = await boot(env, { install: false });
    const b = await boot(env, { install: false });
    // a's provision (an older identity) is slow; b's (a newer one) lands first.
    let release!: () => void;
    env.slow.next = new Promise<void>((ok) => (release = ok));
    const first = updateAcked(a.platform.plugins, 'crm', 'alice');
    await new Promise((ok) => setTimeout(ok, 20));
    await updateAcked(b.platform.plugins, 'crm', 'alice');
    const newest = b.platform.plugins.identityIssue('crm')!.version;
    release();
    await first;
    // a's older identity landed last; a saw it and provisioned the current one.
    expect(env.tasks.identity).toBe(a.platform.plugins.identityIssue('crm')!.version);
    expect(env.tasks.identity!).toBeGreaterThanOrEqual(newest);
    expect(env.tasks.label).toBe(a.platform.plugins.current('crm')!.revision);
});

it('drops a setting an update removed, even from a save that started before it', async () => {
    const env = await environment();
    env.writeCatalog({
        ...BASE_ENTRY,
        config: { REGION: { description: 'Region' }, OLD: { description: 'Gone in 1.1.0' } },
    });
    const b = await boot(env);
    env.writeCatalog({ ...BASE_ENTRY, version: '1.1.0', config: { REGION: { description: 'Region' } } });
    const a = await boot(env, { install: false });
    // b's save provisions slowly; a's update, which drops OLD, commits meanwhile.
    let release!: () => void;
    env.slow.next = new Promise<void>((ok) => (release = ok));
    const saving = b.platform.plugins.configure('crm', { REGION: 'eu', OLD: 'late' });
    await new Promise((ok) => setTimeout(ok, 20));
    await updateAcked(a.platform.plugins, 'crm', 'alice');
    release();
    await saving;
    expect(a.platform.plugins.current('crm')).toMatchObject({ version: '1.1.0', config: { REGION: 'eu' } });
    // And the service runs exactly that.
    expect(env.tasks.label).toBe(a.platform.plugins.current('crm')!.revision);
});

it('changes nothing it serves when the runtime refuses an update', async () => {
    const env = await environment();
    env.writeCatalog(BASE_ENTRY);
    await boot(env).then((socio) => socio.stop());
    env.writeCatalog({
        ...BASE_ENTRY,
        version: '1.1.0',
        service: { image: IMAGE_2, port: 8080 },
        webhooks: [{ path: '/webhooks/crm' }],
    });
    const socio = await boot(env, { install: false });
    env.refuse.next = true;
    await expect(updateAcked(socio.platform.plugins, 'crm', 'alice')).rejects.toThrow(/not pinned/);
    expect(socio.platform.plugins.current('crm')).toMatchObject({ version: '1.0.0' });
    expect(socio.platform.plugins.current('crm')!.manifest.webhooks).toBeUndefined();
    expect((await socio.send('POST', '/webhooks/crm', {}, Buffer.from('{}'))).status).toBe(401);
    expect(socio.workspace.auditOf('plugin', 'crm')).toEqual([]);
});

it('checks a manifest’s webhooks', () => {
    const base = {
        id: 'crm',
        name: 'CRM',
        version: '1.0.0',
        author: 'Test',
        description: 'Deals.',
        display: 'tab',
        permissions: [],
        service: { image: IMAGE, port: 8080 },
    };
    expect(parseManifest({ ...base, webhooks: WEBHOOKS }, 'c').webhooks).toEqual([
        { path: '/webhooks/crm', method: 'POST', maxBodyBytes: 64 },
        { path: '/webhooks/limited', method: 'POST', perMinute: 2 },
        { path: '/oauth/crm/callback', method: 'GET' },
    ]);
    for (const path of ['/', '/a/', '//a', '/a/../b', '/./a', '/__cb/x', '/__CB', '/a b', '/a?x=1', 'a', '/%2e%2e']) {
        expect(() => parseManifestWebhooks([{ path }], 'c'), path).toThrow(/a path is/);
    }
    expect(() => parseManifestWebhooks([{ path: '/a' }, { path: '/a' }], 'c')).toThrow(/twice/);
    expect(() =>
        parseManifestWebhooks(
            [
                { path: '/a', method: 'GET' },
                { path: '/b', method: 'GET' },
            ],
            'c',
        ),
    ).toThrow(/only one GET/);
    expect(() => parseManifestWebhooks([{ path: '/a', method: 'PUT' }], 'c')).toThrow(/POST or GET/);
    expect(() => parseManifestWebhooks([{ path: '/a', method: 'GET', maxBodyBytes: 10 }], 'c')).toThrow(/no body/);
    expect(() => parseManifestWebhooks([{ path: '/a', maxBodyBytes: 2 * 1024 * 1024 }], 'c')).toThrow(/maxBodyBytes/);
    expect(() => parseManifestWebhooks([{ path: '/a', perMinute: 0 }], 'c')).toThrow(/perMinute/);
    expect(() => parseManifestWebhooks([{ path: '/a', extra: 1 }], 'c')).toThrow(/extra is not allowed/);
    expect(() => parseManifestWebhooks([{ path: '/app' }], 'c', '/app')).toThrow(/entry/);
    expect(() => parseManifestWebhooks([{ path: '/app', method: 'GET' }], 'c', '/app?view=home')).toThrow(/entry/);
    expect(() => parseManifest({ ...base, entry: { path: '/app#top' }, webhooks: [{ path: '/app' }] }, 'c')).toThrow(
        /entry/,
    );
    expect(() =>
        parseManifestWebhooks(
            Array.from({ length: 11 }, (_, i) => ({ path: `/h${i}` })),
            'c',
        ),
    ).toThrow(/at most 10/);
    expect(() => parseManifest({ ...base, webhooks: [{ path: '/__cb/auth' }] }, 'c')).toThrow(/a path is/);
    // The install revision is Socio's to set, never a catalog's.
    expect(() => parseManifest({ ...base, service: { ...base.service, revision: '0'.repeat(64) } }, 'c')).toThrow(
        /revision is not allowed/,
    );
});

it('reads a stored manifest’s webhooks defensively, and limits per path and rate', () => {
    expect(webhookRoute({ webhooks: [{ path: '/__cb/auth' }] }, '/__cb/auth')).toBeUndefined();
    expect(webhookRoute({ webhooks: [{ path: '/a', method: 'PUT' as never }] }, '/a')).toBeUndefined();
    expect(webhookRoute({ webhooks: 'nope' as never }, '/a')).toBeUndefined();
    expect(webhookRoute({}, '/a')).toBeUndefined();
    // A stored manifest whose webhook is its entry page: still a session's.
    expect(webhookRoute({ entry: { path: '/a?x=1' }, webhooks: [{ path: '/a' }] }, '/a')).toBeUndefined();
    expect(webhookRoute({ webhooks: [{ path: '/a' }] }, '/a')).toEqual({ path: '/a' });
    const limits = new WebhookLimits();
    const now = 1_000_000;
    expect(limits.take('crm', { path: '/a', perMinute: 1 }, now)).toBe(true);
    expect(limits.take('crm', { path: '/a', perMinute: 1 }, now)).toBe(false);
    expect(limits.take('crm', { path: '/b', perMinute: 1 }, now)).toBe(true);
    expect(limits.take('other', { path: '/a', perMinute: 1 }, now)).toBe(true);
    expect(limits.take('crm', { path: '/a', perMinute: 1 }, now + 60_001)).toBe(true);
});

/** An admin's session cookie on a booted Socio. */
async function adminCookie(socio: Awaited<ReturnType<typeof boot>>) {
    return (
        await socio.app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ userId: 'alice' }),
        })
    ).headers
        .get('set-cookie')!
        .split(';')[0]!;
}

/** Settings saves and applies as the plugin's page sends them (CB-398 follow-up). */
async function settingsPage(socio: Awaited<ReturnType<typeof boot>>, applyDelayMs: number) {
    (socio.platform.plugins as unknown as { options: { applyDelayMs?: number } }).options.applyDelayMs = applyDelayMs;
    const cookie = await adminCookie(socio);
    const call = async (path: string, method: string, body?: unknown) => {
        const response = await socio.app.request(`http://localhost:4310/api/plugins/crm${path}`, {
            method,
            headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify(body ?? {}),
        });
        expect(response.status).toBe(200);
        return (await response.json()) as Record<string, unknown>;
    };
    return {
        save: (config: Record<string, string>) => call('/config', 'PUT', { config }),
        apply: () => call('/apply', 'POST'),
    };
}

it('stores each settings save at once and restarts the service once, after the saves settle (CB-398 follow-up)', async () => {
    const env = await environment();
    env.writeCatalog({ ...BASE_ENTRY, config: { REGION: { description: 'Region' } }, webhooks: WEBHOOKS });
    const socio = await boot(env);
    const page = await settingsPage(socio, 150);
    const before = env.provisioned.length;
    for (const region of ['u', 'us', 'us-', 'us-e', 'us-east']) {
        expect(await page.save({ REGION: region })).toEqual({ ok: true, applyInMs: 150 });
        // Stored now, whatever happens next; the service isn't touched yet.
        expect(socio.platform.plugins.current('crm')!.config).toEqual({ REGION: region });
    }
    expect(env.provisioned.length).toBe(before);
    await vi.waitFor(() => expect(env.provisioned.length).toBe(before + 1), { timeout: 2000 });
    expect(env.tasks.label).toBe(socio.platform.plugins.current('crm')!.revision);
    // Nothing more comes: an apply for saves already applied restarts nothing.
    await new Promise((ok) => setTimeout(ok, 300));
    expect(await page.apply()).toEqual({ ok: true, applied: true });
    expect(env.provisioned.length).toBe(before + 1);
});

it('applies saves made during a restart with exactly one more, never two at once (CB-398 follow-up)', async () => {
    const env = await environment();
    env.writeCatalog({ ...BASE_ENTRY, config: { REGION: { description: 'Region' } } });
    const socio = await boot(env);
    const page = await settingsPage(socio, 60_000);
    const before = env.provisioned.length;
    await page.save({ REGION: 'us' });
    // The restart is slow; saves and applies come in meanwhile.
    let release!: () => void;
    env.slow.next = new Promise<void>((ok) => (release = ok));
    let inFlight = 0;
    let most = 0;
    const runtime = (socio.platform.plugins as unknown as { options: { runtime: PluginRuntime } }).options.runtime;
    const real = runtime.provisionService.bind(runtime);
    runtime.provisionService = async (...args) => {
        most = Math.max(most, ++inFlight);
        try {
            return await real(...args);
        } finally {
            inFlight--;
        }
    };
    const first = page.apply();
    await vi.waitFor(() => expect(inFlight).toBe(1));
    await page.save({ REGION: 'eu' });
    await page.save({ REGION: 'eu-west' });
    const second = page.apply();
    const third = page.apply();
    release();
    await Promise.all([first, second, third]);
    expect(most).toBe(1);
    expect(env.provisioned.length).toBe(before + 2);
    expect(socio.platform.plugins.current('crm')!.config).toEqual({ REGION: 'eu-west' });
    expect(env.tasks.label).toBe(socio.platform.plugins.current('crm')!.revision);
    // The wait the saves started was spent by the applies.
    await page.apply();
    expect(env.provisioned.length).toBe(before + 2);
});

it('applies saved settings as soon as the page leaves, and a restarted Socio applies what was stored (CB-398 follow-up)', async () => {
    const env = await environment();
    env.writeCatalog({ ...BASE_ENTRY, config: { REGION: { description: 'Region' } }, webhooks: WEBHOOKS });
    const socio = await boot(env);
    const page = await settingsPage(socio, 60_000);
    const before = env.provisioned.length;
    await page.save({ REGION: 'us' });
    expect(env.provisioned.length).toBe(before);
    // Leaving the page: applied now, not a minute from now.
    expect(await page.apply()).toEqual({ ok: true, applied: true });
    expect(env.provisioned.length).toBe(before + 1);
    expect(env.tasks.label).toBe(socio.platform.plugins.current('crm')!.revision);

    // A save, then the process stops before its wait ends: the settings are stored...
    await page.save({ REGION: 'eu' });
    await socio.stop();
    const next = await boot(env, { install: false });
    expect(next.platform.plugins.current('crm')!.config).toEqual({ REGION: 'eu' });
    expect(env.tasks.label).not.toBe(next.platform.plugins.current('crm')!.revision);
    // ...and the leader's start gives the service them.
    void pluginsModule.start!({ services: { get: () => next.platform.plugins } } as never);
    await vi.waitFor(() => expect(env.provisioned.length).toBe(before + 2), { timeout: 2000 });
    expect(env.tasks.label).toBe(next.platform.plugins.current('crm')!.revision);
});

it('never provisions beside a settings apply in flight, nor before a wait ends, on the tick (CB-398 follow-up review)', async () => {
    const env = await environment();
    env.writeCatalog({ ...BASE_ENTRY, config: { REGION: { description: 'Region' } } });
    const socio = await boot(env);
    const page = await settingsPage(socio, 60_000);
    const before = env.provisioned.length;
    await page.save({ REGION: 'us' });
    // In its wait: the tick leaves it to the wait.
    await socio.platform.plugins.reconcileAll();
    expect(env.provisioned.length).toBe(before);
    let release!: () => void;
    env.slow.next = new Promise<void>((ok) => (release = ok));
    let inFlight = 0;
    let most = 0;
    const runtime = (socio.platform.plugins as unknown as { options: { runtime: PluginRuntime } }).options.runtime;
    const real = runtime.provisionService.bind(runtime);
    runtime.provisionService = async (...args) => {
        most = Math.max(most, ++inFlight);
        try {
            return await real(...args);
        } finally {
            inFlight--;
        }
    };
    const applying = page.apply();
    await vi.waitFor(() => expect(inFlight).toBe(1));
    const ticking = socio.platform.plugins.reconcileAll();
    release();
    await Promise.all([applying, ticking]);
    expect(most).toBe(1);
    expect(env.provisioned.length).toBe(before + 1);
    expect(env.tasks.label).toBe(socio.platform.plugins.current('crm')!.revision);
});

it('leaves saves made during a slow restart to their own wait (CB-398 follow-up review)', async () => {
    const env = await environment();
    env.writeCatalog({ ...BASE_ENTRY, config: { REGION: { description: 'Region' } } });
    const socio = await boot(env);
    const page = await settingsPage(socio, 60_000);
    const before = env.provisioned.length;
    await page.save({ REGION: 'us' });
    let release!: () => void;
    env.slow.next = new Promise<void>((ok) => (release = ok));
    const applying = page.apply();
    await new Promise((ok) => setTimeout(ok, 20));
    // Edits while it restarts: they wait for their own apply.
    await page.save({ REGION: 'eu' });
    await page.save({ REGION: 'eu-west' });
    release();
    await applying;
    expect(env.provisioned.length).toBe(before + 1);
    expect(env.tasks.label).not.toBe(socio.platform.plugins.current('crm')!.revision);
    // Their wait ends: one more restart, with the last of them.
    await page.apply();
    expect(env.provisioned.length).toBe(before + 2);
    expect(env.tasks.label).toBe(socio.platform.plugins.current('crm')!.revision);
});
