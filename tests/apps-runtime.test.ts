import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { connect, createServer, type AddressInfo, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { encodeBundle } from '@socio/foundation/apps/bundle';
import { redactAppLog, secretSettings } from '@socio/foundation/apps/log-redact';
import type { AppManifest } from '@socio/shared/apps/app-manifest';
import type { RuntimeAttempt } from '@socio/shared/apps/apps-runtime-types';

import { runtimeApp } from '../src/apps-runtime/api.js';
import { runtimeConfigFromEnv } from '../src/apps-runtime/config.js';
import { ingressServer } from '../src/apps-runtime/ingress.js';
import { egressTenant, egressUser, ingressKey } from '../src/apps-runtime/keys.js';
import {
    ATTEMPT_BYTES,
    ATTEMPT_LINES,
    ATTEMPTS_KEPT,
    ATTEMPTS_RESPONSE_BYTES,
    AppsSupervisor,
} from '../src/apps-runtime/supervisor.js';
import { egressProxy } from '../src/egress/proxy.js';

const TOKEN = 'runtime-token-0123456789abcdef';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** The tiny test app: a Node server on CB_SOCKET (as a Bun app would be). */
const APP = `
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
if (process.env.FAIL_START) process.exit(3);
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname === '/env') return json({
    socket: process.env.CB_SOCKET, app: process.env.CB_APP_ID, url: process.env.CB_APP_URL,
    data: process.env.CB_DATA_URL, token: process.env.CB_DATA_TOKEN, tokenFile: process.env.CB_DATA_TOKEN_FILE,
    proxy: process.env.HTTPS_PROXY ?? null, noProxy: process.env.NO_PROXY ?? null,
    currency: process.env.CURRENCY ?? null, other: process.env.NOT_DECLARED ?? null,
    runtimeToken: process.env.APPS_RUNTIME_TOKEN ?? null, keys: Object.keys(process.env).sort(),
  });
  if (url.pathname === '/headers') return json(req.headers);
  if (url.pathname === '/token') return json({ token: readFileSync(process.env.CB_DATA_TOKEN_FILE, 'utf8').trim() });
  if (url.pathname === '/log') { console.log('token is ' + process.env.CB_DATA_TOKEN); return json({ ok: true }); }
  if (url.pathname === '/crash') { res.end('bye'); setTimeout(() => process.exit(1), 10); return; }
  if (url.pathname === '/connect') {
    const proxy = new URL(process.env.HTTPS_PROXY);
    const auth = Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64');
    const target = url.searchParams.get('target');
    const socket = connect(Number(proxy.port), proxy.hostname);
    let got = '';
    socket.on('data', (d) => { got += d; if (got.startsWith('HTTP/1.1 200') && !got.includes('echo:')) socket.write('ping'); if (got.includes('echo:') || !got.startsWith('HTTP/1.1 200')) socket.end(); });
    socket.on('close', () => json({ got }));
    socket.on('error', () => json({ got: 'error' }));
    socket.write('CONNECT ' + target + ' HTTP/1.1\\r\\nHost: ' + target + '\\r\\nProxy-Authorization: Basic ' + auth + '\\r\\n\\r\\n');
    return;
  }
  json({ path: req.url, method: req.method, version: process.env.VERSION_MARK ?? 'v' });
});
server.on('upgrade', (req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n');
  socket.on('data', (d) => socket.write('echo:' + d));
  socket.on('end', () => socket.end());
});
server.listen(process.env.CB_SOCKET);
process.on('SIGTERM', () => process.exit(0));
`;

const manifest = (extra: Partial<AppManifest> = {}): AppManifest => ({
    name: 'Tracker',
    description: '',
    entry: 'server.mjs',
    runtime: 'bun',
    datasets: [],
    egress: [],
    ...extra,
});
const bundle = (extra: Partial<AppManifest> = {}, source = APP, more: Array<{ path: string; data: Buffer }> = []) =>
    encodeBundle({
        manifest: manifest(extra),
        files: [{ path: 'server.mjs', data: Buffer.from(source) }, ...more],
    });

const listen = async (server: Server | NetServer) => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanup.push(
        () =>
            new Promise<void>((resolve) => {
                (server as Server).closeAllConnections?.();
                server.close(() => resolve());
            }),
    );
    return (server.address() as AddressInfo).port;
};

/** An egress proxy's address that takes connections (installs wait for one). */
const standIn = async () => `http://127.0.0.1:${await listen(createServer((socket) => socket.destroy()))}`;

async function runtime(env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-rt-'));
    const config = runtimeConfigFromEnv({
        APPS_RUNTIME_TOKEN: TOKEN,
        APPS_RUNTIME_DIR: dir,
        APPS_RUNTIME_COMMAND: process.execPath,
        APPS_RUNTIME_START_SECONDS: '5',
        PATH: process.env.PATH,
        ...env,
    });
    const logs: string[] = [];
    const supervisor = new AppsSupervisor(config, (line) => logs.push(line));
    supervisor.init();
    cleanup.push(async () => {
        await supervisor.stopAll();
        rmSync(dir, { recursive: true, force: true });
    });
    const api = runtimeApp(supervisor, TOKEN, 16 * 1048576);
    const ingress = ingressServer(supervisor, TOKEN);
    const ingressPort = await listen(ingress);
    const call = (path: string, method = 'GET', body?: unknown, auth = TOKEN) =>
        api.request(`http://runtime${path}`, {
            method,
            headers: {
                authorization: `Bearer ${auth}`,
                ...(body instanceof Buffer ? {} : body !== undefined ? { 'content-type': 'application/json' } : {}),
            },
            ...(body === undefined
                ? {}
                : {
                      body: body instanceof Buffer ? new Uint8Array(body) : JSON.stringify(body),
                  }),
        });
    const deploy = async (id: string, version: number, packed: ReturnType<typeof bundle>) =>
        api.request(`http://runtime/v1/apps/${id}/versions/${version}`, {
            method: 'PUT',
            headers: {
                authorization: `Bearer ${TOKEN}`,
                'x-bundle-sha256': packed.sha256,
                'content-type': 'application/octet-stream',
            },
            body: new Uint8Array(packed.bytes),
        });
    const start = (id: string, version: number, extra: object = {}) =>
        call(`/v1/apps/${id}/start`, 'POST', {
            version,
            token: 'cbdt_app-token-1',
            dataUrl: 'http://app:4310/api/data',
            appUrl: `http://${id}.apps.localhost:4310`,
            env: {},
            ...extra,
        });
    /** A request through the ingress, as the app's apps proxy sends it. */
    const viaIngress = (id: string, path: string, headers: Record<string, string> = {}) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
            const req = httpRequest(
                {
                    host: '127.0.0.1',
                    port: ingressPort,
                    path,
                    headers: {
                        'x-cb-runtime-app': id,
                        'x-cb-runtime-key': ingressKey(TOKEN),
                        ...headers,
                    },
                },
                (res) => {
                    let body = '';
                    res.on('data', (chunk) => (body += chunk));
                    res.on('end', () => resolve({ status: res.statusCode!, body }));
                },
            );
            req.on('error', reject);
            req.end();
        });
    return {
        dir,
        supervisor,
        api,
        call,
        deploy,
        start,
        viaIngress,
        ingressPort,
        logs,
    };
}

describe('runtime config', () => {
    it('needs a long token and checks the proxy and registry', () => {
        expect(() => runtimeConfigFromEnv({})).toThrow(/APPS_RUNTIME_TOKEN/);
        expect(() => runtimeConfigFromEnv({ APPS_RUNTIME_TOKEN: 'short' })).toThrow(/24/);
        const config = runtimeConfigFromEnv({ APPS_RUNTIME_TOKEN: TOKEN });
        expect(config).toMatchObject({
            dir: '/srv/apps',
            command: ['bun'],
            registry: 'registry.npmjs.org:443',
            prlimit: false,
            memoryBytes: 256 * 1048576,
            proxyWaitMs: 60_000,
        });
        expect(config.isolate).toBeUndefined();
        // `bun run` can't read the apps' parent directories (0711): an old
        // setting is read as `bun`; other commands stay as they are.
        for (const [value, command] of [
            ['bun run', ['bun']],
            [' /usr/local/bin/bun  run ', ['/usr/local/bin/bun']],
            ['bun run --smol', ['bun', '--smol']],
            ['node --no-warnings', ['node', '--no-warnings']],
        ] as const) {
            expect(
                runtimeConfigFromEnv({
                    APPS_RUNTIME_TOKEN: TOKEN,
                    APPS_RUNTIME_COMMAND: value,
                }).command,
            ).toEqual(command);
        }
        expect(
            runtimeConfigFromEnv({
                APPS_RUNTIME_TOKEN: TOKEN,
                APPS_RUNTIME_UID_BASE: '20000',
                APPS_RUNTIME_GID: '1000',
                APPS_RUNTIME_REGISTRY: 'off',
                APPS_RUNTIME_INSTALL: 'off',
            }),
        ).toMatchObject({
            isolate: { uidBase: 20000, uidCount: 1000, gid: 1000 },
            registry: undefined,
            install: null,
        });
        expect(() =>
            runtimeConfigFromEnv({
                APPS_RUNTIME_TOKEN: TOKEN,
                APPS_RUNTIME_EGRESS_PROXY: 'http://u:p@proxy:3128',
            }),
        ).toThrow(/credentials/);
    });
});

describe('runtime API', () => {
    it('refuses requests without the token; health is open', async () => {
        const r = await runtime();
        expect((await r.api.request('http://runtime/healthz')).status).toBe(200);
        expect((await r.api.request('http://runtime/v1/apps')).status).toBe(401);
        expect((await r.call('/v1/apps', 'GET', undefined, 'wrong')).status).toBe(401);
        expect((await r.call('/v1/apps', 'GET', undefined, `${TOKEN}x`)).status).toBe(401);
        expect(await (await r.call('/v1/apps')).json()).toEqual({ apps: [] });
    });

    it('deploys, starts, serves through the ingress, and stops an app', async () => {
        const r = await runtime();
        const packed = bundle({ env: { CURRENCY: 'Which currency' } });
        const deployed = await r.deploy('tracker--dot-ab12cd', 1, packed);
        expect(deployed.status).toBe(200);
        expect(await deployed.json()).toMatchObject({
            state: 'stopped',
            versions: [1],
        });
        // A wrong checksum is refused.
        const bad = await r.api.request('http://runtime/v1/apps/tracker--dot-ab12cd/versions/2', {
            method: 'PUT',
            headers: {
                authorization: `Bearer ${TOKEN}`,
                'x-bundle-sha256': '0'.repeat(64),
            },
            body: new Uint8Array(packed.bytes),
        });
        expect(bad.status).toBe(400);
        const started = await r.start('tracker--dot-ab12cd', 1, {
            env: { CURRENCY: 'EUR', NOT_DECLARED: 'x', PATH: '/evil' },
        });
        expect(started.status).toBe(200);
        expect(await started.json()).toMatchObject({
            state: 'running',
            version: 1,
        });
        const env = JSON.parse((await r.viaIngress('tracker--dot-ab12cd', '/env')).body);
        expect(env).toMatchObject({
            app: 'tracker--dot-ab12cd',
            url: 'http://tracker--dot-ab12cd.apps.localhost:4310',
            data: 'http://app:4310/api/data',
            token: 'cbdt_app-token-1',
            currency: 'EUR',
            other: null,
            runtimeToken: null,
            proxy: null,
            // The data API and the app's own loopback go direct.
            noProxy: 'app,localhost,127.0.0.1,::1',
        });
        expect(env.socket).toBe(r.supervisor.socketPath('tracker--dot-ab12cd'));
        // Only the runtime's variables: nothing of this process's environment.
        expect(env.keys).not.toContain('APPS_RUNTIME_TOKEN');
        expect(env.keys.filter((key: string) => !key.startsWith('CB_'))).toEqual([
            'CURRENCY',
            'DO_NOT_TRACK',
            'HOME',
            'LANG',
            'NODE_ENV',
            'NO_PROXY',
            'PATH',
            'TMPDIR',
            'no_proxy',
        ]);
        // The ingress strips its own headers.
        const headers = JSON.parse(
            (
                await r.viaIngress('tracker--dot-ab12cd', '/headers', {
                    'x-cb-user': 'person-1',
                })
            ).body,
        );
        expect(headers['x-cb-user']).toBe('person-1');
        expect(headers['x-cb-runtime-key']).toBeUndefined();
        expect(headers['x-cb-runtime-app']).toBeUndefined();
        const stopped = await r.call('/v1/apps/tracker--dot-ab12cd/stop', 'POST');
        expect(await stopped.json()).toMatchObject({ state: 'stopped' });
        expect((await r.viaIngress('tracker--dot-ab12cd', '/')).status).toBe(503);
        const removed = await r.call('/v1/apps/tracker--dot-ab12cd', 'DELETE');
        expect(removed.status).toBe(200);
        expect((await r.call('/v1/apps/tracker--dot-ab12cd')).status).toBe(404);
    });

    it('lets only the app reach an app: the ingress key and the socket', async () => {
        const r = await runtime();
        await r.deploy('one--dot-ab12cd', 1, bundle());
        await r.start('one--dot-ab12cd', 1);
        // Without the key, with a wrong one, or for an app that isn't running.
        expect((await r.viaIngress('one--dot-ab12cd', '/', { 'x-cb-runtime-key': 'x' })).status).toBe(401);
        expect((await r.viaIngress('two--dot-ab12cd', '/')).status).toBe(503);
        expect((await r.viaIngress('../etc', '/')).status).toBe(503);
        // The app listens on its socket only: no TCP port of its own.
        const socket = r.supervisor.socketPath('one--dot-ab12cd');
        expect(socket.startsWith(join(r.dir, 'one--dot-ab12cd', 'run'))).toBe(true);
        // WebSockets go through too.
        const upgraded = await new Promise<string>((resolve) => {
            const client = connect(r.ingressPort, '127.0.0.1');
            let got = '';
            client.on('data', (data) => {
                got += data;
                if (got.includes('101') && !got.includes('echo:')) {
                    client.write('hi');
                }
                if (got.includes('echo:hi')) {
                    client.end();
                }
            });
            client.on('close', () => resolve(got));
            client.write(
                `GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nx-cb-runtime-app: one--dot-ab12cd\r\nx-cb-runtime-key: ${ingressKey(TOKEN)}\r\n\r\n`,
            );
        });
        expect(upgraded).toMatch(/^HTTP\/1\.1 101/);
        expect(upgraded).toContain('echo:hi');
    });

    it('never follows an app’s socket name to another app', async () => {
        const r = await runtime();
        const [a, b] = ['one--dot-ab12cd', 'two--dot-ab12cd'];
        await r.deploy(a, 1, bundle({}, APP.replace("?? 'v'", "?? 'A'")));
        await r.deploy(b, 1, bundle({}, APP.replace("?? 'v'", "?? 'B'")));
        expect((await r.start(a, 1)).status).toBe(200);
        expect((await r.start(b, 1)).status).toBe(200);
        // (No request for A through the ingress first: a kept-alive connection
        // would hide what a new one does.)
        // The app's user can write run/: A names B's socket as its own.
        rmSync(r.supervisor.socketPath(a));
        symlinkSync(r.supervisor.socketPath(b), r.supervisor.socketPath(a));
        const swapped = await r.viaIngress(a, '/');
        expect(swapped.status).toBe(502);
        expect(swapped.body).not.toContain('"B"');
        const upgraded = await new Promise<string>((resolve) => {
            const client = connect(r.ingressPort, '127.0.0.1');
            let got = '';
            client.on('data', (data) => (got += data));
            client.on('close', () => resolve(got));
            client.on('error', () => resolve(got));
            client.write(
                `GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nx-cb-runtime-app: ${a}\r\nx-cb-runtime-key: ${ingressKey(TOKEN)}\r\n\r\n`,
            );
        });
        expect(upgraded).not.toMatch(/101/);
        expect(JSON.parse((await r.viaIngress(b, '/')).body)).toMatchObject({
            version: 'B',
        });
    });

    it('refreshes the data token in its file and keeps it out of the logs', async () => {
        const r = await runtime();
        await r.deploy('tracker--dot-ab12cd', 1, bundle());
        await r.start('tracker--dot-ab12cd', 1);
        expect(JSON.parse((await r.viaIngress('tracker--dot-ab12cd', '/token')).body)).toEqual({
            token: 'cbdt_app-token-1',
        });
        await r.call('/v1/apps/tracker--dot-ab12cd/token', 'PUT', {
            token: 'cbdt_app-token-2',
        });
        expect(JSON.parse((await r.viaIngress('tracker--dot-ab12cd', '/token')).body)).toEqual({
            token: 'cbdt_app-token-2',
        });
        await r.viaIngress('tracker--dot-ab12cd', '/log');
        await new Promise((resolve) => setTimeout(resolve, 100));
        const { lines } = (await (await r.call('/v1/apps/tracker--dot-ab12cd/logs?tail=50')).json()) as {
            lines: string[];
        };
        expect(lines.join('\n')).toContain('token is [redacted]');
        expect(lines.join('\n')).not.toContain('cbdt_app-token');
        const file = join(r.dir, 'tracker--dot-ab12cd', 'run', 'data-token');
        expect(readFileSync(file, 'utf8').trim()).toBe('cbdt_app-token-2');
    });

    it('restarts a crashed app, and reports one that never opens its socket', async () => {
        const r = await runtime({ APPS_RUNTIME_START_SECONDS: '1' });
        await r.deploy('tracker--dot-ab12cd', 1, bundle());
        await r.start('tracker--dot-ab12cd', 1);
        await r.viaIngress('tracker--dot-ab12cd', '/crash');
        await expect
            .poll(() => r.supervisor.status('tracker--dot-ab12cd'), {
                timeout: 5000,
                interval: 100,
            })
            .toMatchObject({ state: 'running', restarts: 1 });
        expect(JSON.parse((await r.viaIngress('tracker--dot-ab12cd', '/')).body)).toMatchObject({ path: '/' });
        // A version that exits at once fails its start, with the reason.
        await r.deploy('broken--dot-ab12cd', 1, bundle({}, 'process.exit(3)'));
        const failed = await r.start('broken--dot-ab12cd', 1);
        expect(failed.status).toBe(409);
        expect(r.supervisor.status('broken--dot-ab12cd')).toMatchObject({
            state: 'failed',
        });
        // One that runs but never listens times out.
        await r.deploy('silent--dot-ab12cd', 1, bundle({}, 'setInterval(() => {}, 1000)'));
        const silent = await r.start('silent--dot-ab12cd', 1);
        expect(silent.status).toBe(409);
        expect(((await silent.json()) as { error: string }).error).toMatch(/CB_SOCKET/);
    });

    it('switches versions and keeps the previous one for a rollback', async () => {
        const r = await runtime();
        await r.deploy('tracker--dot-ab12cd', 1, bundle());
        await r.start('tracker--dot-ab12cd', 1);
        await r.deploy('tracker--dot-ab12cd', 2, bundle({}, APP.replace("?? 'v'", "?? 'v2'")));
        await r.start('tracker--dot-ab12cd', 2);
        expect(JSON.parse((await r.viaIngress('tracker--dot-ab12cd', '/')).body)).toMatchObject({ version: 'v2' });
        await r.start('tracker--dot-ab12cd', 1);
        expect(JSON.parse((await r.viaIngress('tracker--dot-ab12cd', '/')).body)).toMatchObject({ version: 'v' });
        expect(r.supervisor.status('tracker--dot-ab12cd')).toMatchObject({
            versions: [1, 2],
            version: 1,
        });
        // An unknown version can't start.
        expect((await r.start('tracker--dot-ab12cd', 7)).status).toBe(404);
    });

    it('keeps the version it deploys, wants or runs when it prunes', async () => {
        const r = await runtime();
        const id = 'tracker--dot-ab12cd';
        for (const version of [5, 6, 7]) {
            await r.deploy(id, version, bundle({}, APP.replace("?? 'v'", `?? 'v${version}'`)));
        }
        expect(r.supervisor.status(id).versions).toEqual([6, 7]);
        // A rollback deploys an older version while nothing runs.
        expect((await r.deploy(id, 1, bundle())).status).toBe(200);
        expect(r.supervisor.status(id).versions).toEqual([1, 6, 7]);
        expect((await r.start(id, 1)).status).toBe(200);
        expect(JSON.parse((await r.viaIngress(id, '/')).body)).toMatchObject({
            version: 'v',
        });
        // Newer versions come and go; the running one stays.
        await r.deploy(id, 8, bundle({}, APP.replace("?? 'v'", "?? 'v8'")));
        expect(r.supervisor.status(id).versions).toEqual([1, 7, 8]);
    });

    it('keeps the version asked for while it starts, or if its start failed', async () => {
        const r = await runtime();
        const id = 'tracker--dot-ab12cd';
        for (const version of [6, 7, 1]) {
            await r.deploy(id, version, bundle());
        }
        // Its token can't be written (as with CB-148's chmod): it never ran.
        const token = join(r.dir, id, 'run', 'data-token');
        mkdirSync(token);
        writeFileSync(join(token, 'x'), '');
        expect((await r.start(id, 1)).status).toBe(500);
        expect(r.supervisor.status(id)).toMatchObject({ version: null });
        await r.deploy(id, 8, bundle({}, APP.replace("?? 'v'", "?? 'v8'")));
        expect(r.supervisor.status(id).versions).toEqual([1, 7, 8]);
        rmSync(token, { recursive: true });
        expect((await r.start(id, 1)).status).toBe(200);
        // Deploys while it stops the running version for another keep that one.
        const starting = r.supervisor.start(id, {
            version: 7,
            token: null,
            dataUrl: null,
            appUrl: `http://${id}.apps.localhost:4310`,
            env: {},
        });
        for (const version of [9, 10]) {
            const packed = bundle({}, APP.replace("?? 'v'", `?? 'v${version}'`));
            await r.supervisor.deploy(id, version, packed.bytes, packed.sha256);
        }
        expect(await starting).toMatchObject({ state: 'running', version: 7 });
        expect(r.supervisor.status(id).versions).toEqual([1, 7, 9, 10]);
    });

    it('refuses dependencies it can’t install and unsafe bundles', async () => {
        const r = await runtime({ APPS_RUNTIME_INSTALL: 'off' });
        const deps = bundle({}, APP, [
            {
                path: 'package.json',
                data: Buffer.from('{"dependencies":{"left-pad":"1.3.0"}}'),
            },
        ]);
        const refused = await r.deploy('deps--dot-ab12cd', 1, deps);
        expect(refused.status).toBe(400);
        expect(((await refused.json()) as { error: string }).error).toMatch(/bun.lock/);
        const locked = bundle({}, APP, [
            {
                path: 'package.json',
                data: Buffer.from('{"dependencies":{"left-pad":"1.3.0"}}'),
            },
            { path: 'bun.lock', data: Buffer.from('{}') },
        ]);
        const off = await r.deploy('deps--dot-ab12cd', 1, locked);
        expect(((await off.json()) as { error: string }).error).toMatch(/installs none/);
        // No dependencies: nothing to install.
        const plain = bundle({}, APP, [{ path: 'package.json', data: Buffer.from('{"name":"x"}') }]);
        expect((await r.deploy('plain--dot-ab12cd', 1, plain)).status).toBe(200);
        expect((await r.deploy('Bad_Id', 1, plain)).status).toBe(400);
    });
});

const which = (name: string) => {
    try {
        return execFileSync('sh', ['-c', `command -v ${name}`])
            .toString()
            .trim();
    } catch {
        return '';
    }
};

describe('limits and runtimes', () => {
    it.skipIf(!which('prlimit'))('runs apps under prlimit', async () => {
        const r = await runtime({ APPS_RUNTIME_PRLIMIT: 'on' });
        await r.deploy('tracker--dot-ab12cd', 1, bundle());
        expect((await r.start('tracker--dot-ab12cd', 1)).status).toBe(200);
        const pid = (
            r.supervisor as unknown as {
                apps: Map<string, { child?: { pid?: number } }>;
            }
        ).apps.get('tracker--dot-ab12cd')!.child!.pid!;
        // prlimit execs the command: the app's own process has the limits.
        const limits = readFileSync(`/proc/${pid}/limits`, 'utf8');
        expect(limits).toMatch(/Max open files\s+1024\s+1024/);
        expect(limits).toMatch(/Max core file size\s+0\s+0/);
    });

    it('restarts an app above its memory limit', async () => {
        const r = await runtime({ APPS_RUNTIME_MEMORY_MB: '16' });
        await r.deploy('tracker--dot-ab12cd', 1, bundle());
        await r.start('tracker--dot-ab12cd', 1);
        // Node itself is above 16 MB resident.
        r.supervisor.checkMemory();
        await expect
            .poll(() => r.supervisor.status('tracker--dot-ab12cd').restarts, {
                timeout: 5000,
            })
            .toBe(1);
        expect(r.supervisor.logs('tracker--dot-ab12cd').join('\n')).toMatch(/above the limit of 16 MB/);
    });

    const bun = which('bun');
    it.skipIf(!bun)('serves a Bun app on its socket (Bun.serve unix)', async () => {
        const r = await runtime({ APPS_RUNTIME_COMMAND: bun });
        const source = `Bun.serve({ unix: process.env.CB_SOCKET, fetch: (req) => Response.json({ bun: Bun.version, path: new URL(req.url).pathname }) });`;
        await r.deploy(
            'bun--dot-ab12cd',
            1,
            encodeBundle({
                manifest: manifest({ entry: 'server.ts' }),
                files: [{ path: 'server.ts', data: Buffer.from(source) }],
            }),
        );
        expect((await r.start('bun--dot-ab12cd', 1)).status).toBe(200);
        const answer = await r.viaIngress('bun--dot-ab12cd', '/hello');
        expect(JSON.parse(answer.body)).toMatchObject({ path: '/hello' });
    });
});

describe('attempts (CB-146)', () => {
    /** Writes to stderr, then exits with `code`. */
    const failing = (mark: string, code: number) =>
        `console.log('loading ${mark}'); console.error('Error: ${mark} cannot find ./missing.ts'); process.exit(${code});`;

    it('keeps each version’s start attempt with its own output and exit reason', async () => {
        const r = await runtime();
        const id = 'songworld--dot-ab12cd';
        expect((await r.deploy(id, 1, bundle({}, failing('v1', 3)))).status).toBe(200);
        expect((await r.start(id, 1)).status).toBe(409);
        expect((await r.deploy(id, 3, bundle({}, failing('v3', 4)))).status).toBe(200);
        expect((await r.start(id, 3)).status).toBe(409);
        // As a failed update does: the previous version is started again.
        expect((await r.start(id, 1)).status).toBe(409);
        const { attempts } = (await (await r.call(`/v1/apps/${id}/attempts`)).json()) as { attempts: RuntimeAttempt[] };
        expect(attempts.map((item) => `${item.kind} v${item.version} ${item.state}`)).toEqual([
            'build v1 succeeded',
            'start v1 failed',
            'build v3 succeeded',
            'start v3 failed',
            'start v1 failed',
        ]);
        const v3 = attempts[3];
        expect(v3.exit).toEqual({
            reason: 'exit',
            code: 4,
            signal: null,
            message: 'Version 3 exited while starting (code 4).',
        });
        expect(v3.lines.join('\n')).toContain('err Error: v3 cannot find');
        expect(v3.lines.join('\n')).not.toContain('v1');
        expect(v3.endedAt).toBeGreaterThanOrEqual(v3.startedAt);
        expect(attempts[4].lines.join('\n')).not.toContain('v3');
        // The status names the newest attempt, so the app knows to copy them.
        expect(r.supervisor.status(id).attempt).toEqual({
            id: attempts[4].id,
            state: 'failed',
        });
        // Ask for a tail: the last lines only.
        const tail = (await (await r.call(`/v1/apps/${id}/attempts?tail=1`)).json()) as { attempts: RuntimeAttempt[] };
        expect(tail.attempts[3].lines).toHaveLength(1);
        expect(tail.attempts[3].dropped).toBeGreaterThan(0);
    });

    it('says how each attempt ended: signal, health check, out of memory, stopped, crash', async () => {
        const r = await runtime({ APPS_RUNTIME_START_SECONDS: '1' });
        await r.deploy('killed--dot-ab12cd', 1, bundle({}, "process.kill(process.pid, 'SIGKILL');"));
        await r.start('killed--dot-ab12cd', 1);
        expect(r.supervisor.attempts('killed--dot-ab12cd').attempts.at(-1)!.exit).toEqual({
            reason: 'signal',
            code: null,
            signal: 'SIGKILL',
            message: 'Version 1 exited while starting (signal SIGKILL).',
        });
        await r.deploy('silent--dot-ab12cd', 1, bundle({}, 'setInterval(() => {}, 1000)'));
        await r.start('silent--dot-ab12cd', 1);
        expect(r.supervisor.attempts('silent--dot-ab12cd').attempts.at(-1)).toMatchObject({
            state: 'failed',
            exit: {
                reason: 'health_check',
                message: expect.stringMatching(/CB_SOCKET/),
            },
        });
        // Running, then a crash: that attempt failed, the restart is a new one.
        await r.deploy('tracker--dot-ab12cd', 1, bundle());
        await r.start('tracker--dot-ab12cd', 1);
        await r.viaIngress('tracker--dot-ab12cd', '/crash');
        await expect
            .poll(
                () => r.supervisor.attempts('tracker--dot-ab12cd').attempts.map((item) => `${item.kind} ${item.state}`),
                { timeout: 5000, interval: 100 },
            )
            .toEqual(['build succeeded', 'start failed', 'start running']);
        const [, crashed] = r.supervisor.attempts('tracker--dot-ab12cd').attempts;
        expect(crashed.upAt).not.toBeNull();
        expect(crashed.exit).toMatchObject({
            reason: 'exit',
            code: 1,
            message: 'Version 1 exited (code 1).',
        });
        await expect
            .poll(() => r.supervisor.status('tracker--dot-ab12cd').state, {
                timeout: 5000,
                interval: 100,
            })
            .toBe('running');
        expect(r.supervisor.attempts('tracker--dot-ab12cd').attempts[2].upAt).not.toBeNull();
        // Stopped on purpose.
        await r.call('/v1/apps/tracker--dot-ab12cd/stop', 'POST', {});
        expect(r.supervisor.attempts('tracker--dot-ab12cd').attempts.at(-1)!.exit).toMatchObject({ reason: 'stopped' });
    });

    it('says when an app ran out of memory', async () => {
        const r = await runtime({ APPS_RUNTIME_MEMORY_MB: '16' });
        await r.deploy('tracker--dot-ab12cd', 1, bundle());
        await r.start('tracker--dot-ab12cd', 1);
        r.supervisor.checkMemory();
        await expect
            .poll(() => r.supervisor.attempts('tracker--dot-ab12cd').attempts[1].exit?.reason, { timeout: 5000 })
            .toBe('oom');
        expect(r.supervisor.attempts('tracker--dot-ab12cd').attempts[1]).toMatchObject({
            state: 'failed',
            exit: {
                signal: 'SIGKILL',
                message: 'Version 1 used more than 16 MB of memory; the runtime stopped it.',
            },
        });
    });

    it('captures a failed build as an attempt, with the installer’s output', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cb-rt-install-'));
        cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
        const installer = join(dir, 'install.sh');
        writeFileSync(
            installer,
            '#!/bin/sh\necho "resolving with $HTTPS_PROXY"\necho "error: left-pad@9.9.9 not in the lockfile" >&2\nexit 1\n',
            { mode: 0o755 },
        );
        const proxy = await standIn();
        const r = await runtime({
            APPS_RUNTIME_INSTALL: installer,
            APPS_RUNTIME_EGRESS_PROXY: proxy,
        });
        const deps = bundle({}, APP, [
            {
                path: 'package.json',
                data: Buffer.from('{"dependencies":{"left-pad":"9.9.9"}}'),
            },
            { path: 'bun.lock', data: Buffer.from('{}') },
        ]);
        const refused = await r.deploy('deps--dot-ab12cd', 2, deps);
        expect(refused.status).toBe(400);
        expect(((await refused.json()) as { error: string }).error).toMatch(
            /Installing the dependencies failed \(exit 1\)/,
        );
        const [build] = r.supervisor.attempts('deps--dot-ab12cd').attempts;
        expect(build).toMatchObject({
            kind: 'build',
            version: 2,
            state: 'failed',
            exit: { reason: 'build', code: 1 },
        });
        const text = build.lines.join('\n');
        expect(text).toContain('err error: left-pad@9.9.9 not in the lockfile');
        // Said once.
        expect(build.lines.filter((line) => /Installing the dependencies failed/.test(line))).toHaveLength(1);
        // The egress credentials it was given are not in its output.
        expect(text).toContain(`resolving with ${proxy.replace('//', '//[redacted]@')}`);
        // A bundle it refuses is a failed build too.
        const off = await runtime({ APPS_RUNTIME_INSTALL: 'off' });
        await off.deploy('deps--dot-ab12cd', 1, deps);
        expect(off.supervisor.attempts('deps--dot-ab12cd').attempts[0]).toMatchObject({
            kind: 'build',
            state: 'failed',
            exit: {
                reason: 'build',
                message: expect.stringMatching(/installs none/),
            },
        });
    });

    it('bounds each attempt’s output and the attempts it keeps', async () => {
        const r = await runtime();
        const chatty = `for (let i = 0; i < 2000; i++) console.log('line ' + i + ' ' + 'x'.repeat(100)); process.exitCode = 1;`;
        await r.deploy('chatty--dot-ab12cd', 1, bundle({}, chatty));
        await r.start('chatty--dot-ab12cd', 1);
        const start = r.supervisor.attempts('chatty--dot-ab12cd').attempts[1];
        expect(start.lines.length).toBeLessThanOrEqual(ATTEMPT_LINES);
        expect(start.lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)).toBeLessThanOrEqual(
            ATTEMPT_BYTES,
        );
        expect(start.dropped).toBeGreaterThan(1500);
        // The newest lines stay: the end is what explains a failure.
        expect(start.lines.join('\n')).toMatch(/exited \(code 1\)$/);
        for (let n = 0; n < ATTEMPTS_KEPT + 2; n++) {
            await r.start('chatty--dot-ab12cd', 1);
        }
        const kept = r.supervisor.attempts('chatty--dot-ab12cd').attempts;
        expect(kept).toHaveLength(ATTEMPTS_KEPT);
        expect(kept.every((item) => item.kind === 'start')).toBe(true);
    });

    it('redacts secret settings, the data token and credentials, also split across writes or encoded', async () => {
        const r = await runtime();
        const leaky = `const key = process.env.SONG_API_KEY;
console.log('mode ' + process.env.MODE + ' zone ' + process.env.ZONE);
console.log('key ' + key + ' token ' + process.env.CB_DATA_TOKEN);
console.log('b64 ' + Buffer.from(key).toString('base64') + ' hex ' + Buffer.from(key).toString('hex'));
console.log('Authorization: Bearer abc.def.ghi');
console.log('key sk-proj-0123456789abcdefghij and password=hunter22');
process.stdout.write('split ' + key.slice(0, 7));
setTimeout(() => { process.stdout.write(key.slice(7) + ' done\\n'); process.exitCode = 2; }, 100);`;
        await r.deploy(
            'leaky--dot-ab12cd',
            1,
            bundle(
                {
                    env: {
                        SONG_API_KEY: 'The songs API key',
                        MODE: 'Which mode',
                        ZONE: 'The time zone',
                    },
                },
                leaky,
            ),
        );
        await r.start('leaky--dot-ab12cd', 1, {
            env: {
                SONG_API_KEY: 'songs-live-0123456789',
                MODE: 'production',
                ZONE: 'Europe/Madrid',
            },
        });
        await expect
            .poll(() => r.supervisor.attempts('leaky--dot-ab12cd').attempts[1].lines.join('\n'))
            .toMatch(/split \[redacted\] done/);
        const text = r.supervisor.attempts('leaky--dot-ab12cd').attempts[1].lines.join('\n');
        // Ordinary settings stay readable.
        expect(text).toContain('mode production zone Europe/Madrid');
        expect(text).toContain('key [redacted] token [redacted]');
        expect(text).toContain('b64 [redacted] hex [redacted]');
        expect(text).toContain('Bearer [redacted]');
        expect(text).toContain('key [redacted] and password=[redacted]');
        for (const secret of [
            'songs-live',
            '0123456789',
            Buffer.from('songs-live-0123456789').toString('base64'),
            'cbdt_app-token-1',
            'abc.def.ghi',
            'sk-proj',
            'hunter22',
        ]) {
            expect(text).not.toContain(secret);
        }
    });

    it('keeps an app’s output cheap: long lines are cut, control characters cleaned, the answer bounded', async () => {
        const r = await runtime();
        const nasty = `const huge = 'a.'.repeat(30000) + 'eyJaaaa-'.repeat(4000) + 'sk-'.repeat(10000);
for (let i = 0; i < 3; i++) console.log(huge);
console.log('\\u001b[31mred\\u001b[0m bell\\u0007 nul\\u0000 end');
process.exitCode = 1;`;
        // Characters JSON escapes: control characters (cleaned) and quotes.
        const escaped = `for (let i = 0; i < 40; i++) console.log('\\u0001'.repeat(900));
for (let i = 0; i < 40; i++) console.log('"'.repeat(900));
process.exitCode = 1;`;
        await r.deploy('nasty--dot-ab12cd', 1, bundle({}, nasty));
        const started = Date.now();
        await r.start('nasty--dot-ab12cd', 1);
        expect(Date.now() - started).toBeLessThan(5000);
        const [, attempt] = r.supervisor.attempts('nasty--dot-ab12cd').attempts;
        const long = attempt.lines.find((line) => line.includes('a.a.a.'))!;
        expect(long.length).toBeLessThan(1100);
        expect(long).toMatch(/ \[…\]$/);
        expect(attempt.lines.join('\n')).toContain('red bell? nul? end');
        // Lots of characters JSON escapes: still within what the app reads.
        await r.deploy('escaped--dot-ab12cd', 1, bundle({}, escaped));
        for (let n = 0; n < ATTEMPTS_KEPT; n++) {
            await r.start('escaped--dot-ab12cd', 1);
        }
        const answer = await (await r.call('/v1/apps/escaped--dot-ab12cd/attempts')).text();
        expect(Buffer.byteLength(answer)).toBeLessThanOrEqual(ATTEMPTS_RESPONSE_BYTES + 4096);
        const { attempts } = JSON.parse(answer) as {
            attempts: RuntimeAttempt[];
        };
        // The newest attempt keeps its lines; older ones give way.
        expect(attempts.at(-1)!.lines.length).toBeGreaterThan(0);
    });
});

describe('redaction (CB-146)', () => {
    const nasty: Record<string, string> = {
        'URL credentials': 'a.'.repeat(32768),
        JWT: 'eyJaaaa-'.repeat(8192),
        keys: 'sk-'.repeat(21845),
        'data tokens': 'cbdt_'.repeat(13107),
        'socio tokens': 'cbsa_'.repeat(13107),
        'short socio tokens': 'cbob_v1.012345 '.repeat(4369),
        envelopes: 'v1.'.repeat(21845),
        'long envelopes': `v1.${'a'.repeat(65530)}`,
        assignments: 'password:'.repeat(7281),
        bearer: 'Bearer '.repeat(9362),
        schemes: 'a+b.c-d'.repeat(9362) + '://',
    };
    for (const [name, text] of Object.entries(nasty)) {
        it(`takes time in proportion to the line: 64 KB built against ${name}`, () => {
            const started = performance.now();
            redactAppLog(text, ['songs-live-0123456789', 'another-secret']);
            expect(performance.now() - started).toBeLessThan(50);
        });
    }

    it('takes out Socio’s tokens and x-cb-actor envelopes an app logs', () => {
        const envelope = `v1.${'a'.repeat(40)}.${'b'.repeat(43)}`;
        const obo = `cbob_v1.${'x'.repeat(60)}`;
        const cbsa = `cbsa_${'y'.repeat(43)}`;
        const cbgw = `cbgw_${'z'.repeat(43)}`;
        const out = redactAppLog(
            `headers {"x-cb-actor":"${envelope}","x-cb-obo":"${obo}","x-forwarded-token":"${cbsa}"} ${cbgw}`,
        );
        for (const value of [envelope, obo, cbsa, cbgw]) {
            expect(out).not.toContain(value);
        }
        expect(out).not.toMatch(/cbob_v1\.x|cbsa_y|cbgw_z|v1\.a{10}/);
        expect(out.match(/\[redacted\]/g)).toHaveLength(4);
        // Prose about them stays readable.
        expect(redactAppLog('no cbsa_ tokens here, v1.2 shipped')).toBe('no cbsa_ tokens here, v1.2 shipped');
    });

    it('catches a secret as it is, URL-encoded, JSON-escaped, base64 and hex', () => {
        const secret = 'p@ss w"rd/xyz';
        const forms = [
            secret,
            encodeURIComponent(secret),
            JSON.stringify(secret).slice(1, -1),
            Buffer.from(secret).toString('base64'),
            Buffer.from(secret).toString('base64url'),
            Buffer.from(secret).toString('hex'),
        ];
        for (const form of forms) {
            expect(redactAppLog(`got <${form}>`, [secret])).toBe('got <[redacted]>');
        }
        // Short values would blank ordinary words: they stay.
        expect(redactAppLog('debug mode on', ['debug'])).toBe('debug mode on');
    });

    it('treats only secret-like settings as secrets, by how their names end', () => {
        expect(
            secretSettings(
                {
                    SONG_API_KEY: 'k-0123456789',
                    DB_PASSWORD: 'pw-0123456789',
                    SENTRY_DSN: 'https://abc@sentry.example/1',
                    UPSTREAM: 'https://user:pw-x@api.example.com',
                    CALLBACK: 'https://hooks.example/x?id=2&token=abc123456',
                    WEBHOOK: 'whsec-0123456789',
                    PASSWORD_SALT: 'salt-0123456789',
                    SIGNING_KEY: 'sign-0123456789',
                    PRIVATE_KEY: 'priv-0123456789',
                    HOOK_VALUE: 'hook-0123456789',
                    MODE: 'production',
                    HOST: 'api.example.com',
                    ZONE: 'Europe/Madrid',
                    AUTHOR_NAME: 'Ada Lovelace',
                    KEYBOARD: 'qwerty-uk',
                    PUBLIC_URL: 'https://songs.example/app',
                    AUTH_PROVIDER: 'github-oauth',
                    AUTH_MODE: 'password-less',
                    PRIMARY_KEY: 'userId-column',
                    WEBHOOK_URL: 'https://hooks.example/abcdef',
                    AUTH_TOKEN: 'auth-0123456789',
                },
                { HOOK_VALUE: 'The webhook signing secret' },
            ).sort(),
        ).toEqual(
            [
                'k-0123456789',
                'pw-0123456789',
                'https://abc@sentry.example/1',
                'https://user:pw-x@api.example.com',
                'https://hooks.example/x?id=2&token=abc123456',
                'whsec-0123456789',
                'salt-0123456789',
                'sign-0123456789',
                'priv-0123456789',
                'hook-0123456789',
                'https://hooks.example/abcdef',
                'auth-0123456789',
            ].sort(),
        );
    });

    it('catches upper-case hex, and base64 of a value inside a longer blob', () => {
        const secret = 'songs-live-0123456789';
        expect(redactAppLog(Buffer.from(secret).toString('hex').toUpperCase(), [secret])).toBe('[redacted]');
        for (const prefix of ['', 'u', 'us', 'user:']) {
            for (const suffix of ['', 'x', 'xy']) {
                const blob = Buffer.from(`${prefix}${secret}${suffix}`).toString('base64');
                const out = redactAppLog(`auth ${blob}`, [secret]);
                expect(out, `${prefix}|${suffix}`).toContain('[redacted]');
                // What is left can't give the value back.
                expect(
                    Buffer.from(out.replace(/\[redacted\]|auth /g, ''), 'base64')
                        .toString()
                        .includes('0123456789'),
                ).toBe(false);
            }
        }
    });
});

describe('floods and cut lines (CB-146)', () => {
    /** A supervisor's output path, fed directly: no child, no clock games. */
    const harness = async (secrets = 30) => {
        const r = await runtime();
        const s = r.supervisor as unknown as {
            entry(id: string): { secrets: Set<string>; current?: unknown };
            begin(
                app: unknown,
                kind: 'start',
                version: number,
            ): RuntimeAttempt & {
                secrets: string[];
            };
            lines(app: unknown, source: 'out' | 'err', attempt: unknown, stream: unknown): void;
            append(app: unknown, source: 'out', text: string, attempt: unknown): void;
            exited(app: unknown, child: unknown, attempt: unknown, code: number, signal: null): void;
        };
        const app = s.entry('flood--dot-ab12cd');
        const values = Array.from({ length: secrets }, (_, n) => `secret-value-${n}-${'x'.repeat(20)}`);
        const attempt = s.begin(app, 'start', 1);
        attempt.secrets = values;
        const stream = (source: 'out' | 'err' = 'out') => {
            const fake = Object.assign(new EventEmitter(), { setEncoding() {} });
            s.lines(app, source, attempt, fake);
            return fake;
        };
        return { s, app, attempt, values, stream };
    };
    const numbered = (prefix: string, from: number, to: number) =>
        Array.from({ length: to - from }, (_, n) => `${prefix} ${from + n}\n`).join('');

    it('reads only the last lines of a huge write, and says so in its place', async () => {
        const { attempt, stream } = await harness(0);
        const out = stream();
        out.emit('data', numbered('n', 0, 1000));
        const text = attempt.lines.map((line) => line.replace(/^\S+ /, ''));
        const notice = text.indexOf('runtime 601 lines dropped (more than 400 in one write)');
        expect(notice).toBe(0);
        expect(text[notice + 1]).toBe('out n 601');
        expect(text.at(-1)).toBe('out n 999');
        expect(text).toHaveLength(ATTEMPT_LINES);
        expect(attempt.dropped).toBe(601);
    });

    it('keeps stderr first when both streams flood, and gives back what it held in order', async () => {
        const { s, app, attempt, stream } = await harness(0);
        const out = stream('out');
        const err = stream('err');
        out.emit('data', numbered('o', 0, 400));
        out.emit('data', numbered('o', 400, 500));
        // The second's room is gone: these are held.
        out.emit('data', numbered('o', 500, 600));
        err.emit('data', numbered('e', 0, 80));
        out.emit('data', numbered('o', 600, 700));
        // Held: stderr's newest 50, none of stdout's left.
        (s as unknown as { release(app: unknown, attempt: unknown): void }).release(app, attempt);
        const text = attempt.lines.map((line) => line.replace(/^\S+ /, ''));
        expect(text.filter((line) => line.startsWith('err e'))).toHaveLength(50);
        expect(text.at(-1)).toBe('err e 79');
        expect(text.some((line) => /^runtime \d+ lines dropped \(more than 500 a second\)$/.test(line))).toBe(true);
    });

    it('gives back what it held before saying the process exited', async () => {
        const { s, app, attempt, stream } = await harness(0);
        const out = stream();
        out.emit('data', numbered('n', 0, 400));
        out.emit('data', numbered('n', 400, 500));
        out.emit('data', numbered('late', 0, 30));
        s.exited(app, {}, attempt, 1, null);
        out.emit('end');
        await expect.poll(() => attempt.lines.at(-1), { timeout: 3000 }).toMatch(/runtime exited \(code 1\)$/);
        const text = attempt.lines.join('\n');
        expect(text.indexOf('late 29')).toBeGreaterThan(0);
        expect(text.indexOf('late 29')).toBeLessThan(text.indexOf('exited (code 1)'));
    });

    it('redacts after colour codes are taken out, with one redactor for many lines', async () => {
        const { attempt, values, stream } = await harness(3);
        const out = stream();
        const secret = values[0];
        const coloured = `${secret.slice(0, 7)}\u001b[31m${secret.slice(7)}\u001b[0m`;
        out.emit('data', `first ${coloured}\n`);
        const redactor = (attempt as unknown as { redactor: unknown }).redactor;
        expect(redactor).toBeDefined();
        out.emit('data', numbered('n', 0, 300));
        out.emit('data', `again ${coloured}\n`);
        // The same redactor: built once, not per line.
        expect((attempt as unknown as { redactor: unknown }).redactor).toBe(redactor);
        const text = attempt.lines.join('\n');
        expect(text).toContain('out first [redacted]');
        expect(text).toContain('out again [redacted]');
        expect(text).not.toContain(secret.slice(7));
    });

    it('cuts a known-shape key at the cut off, with no values given', async () => {
        const { attempt, stream } = await harness(0);
        const out = stream();
        const key = `ghp_${'abcdefghij'.repeat(4)}`;
        // Color codes bring the cut near the visible end; only 14 of the
        // key's characters fit before it: too few to match its shape.
        const colours = '\u001b[0m'.repeat(750);
        out.emit('data', `${colours}${'x'.repeat(4000 - colours.length - 14)}${key} more\n`);
        const line = attempt.lines.at(-1)!;
        expect(line).toMatch(/ \[…\]$/);
        expect(line).not.toContain('ghp_');
    });

    it('never holds the runtime long for a flood of short lines, and keeps its end', async () => {
        const { attempt, stream } = await harness(30);
        const out = stream();
        const chunk = 'a\n'.repeat(32768);
        let slowest = 0;
        for (let n = 0; n < 100; n++) {
            const started = performance.now();
            out.emit('data', chunk);
            slowest = Math.max(slowest, performance.now() - started);
        }
        out.emit('data', 'Error: the end of the flood\n');
        out.emit('end');
        expect(slowest).toBeLessThan(100);
        const text = attempt.lines.join('\n');
        expect(text).toMatch(/\d+ lines dropped \(more than 500 a second\)/);
        // The newest lines stay: what explains a crash comes last.
        expect(attempt.lines.at(-1)).toMatch(/out Error: the end of the flood$/);
        expect(attempt.lines.length).toBeLessThanOrEqual(ATTEMPT_LINES);
    });

    it('cuts a line before redacting it: a huge line costs little', async () => {
        const { s, app, attempt, values } = await harness(30);
        // Every value, over and over: 8 MB that would each be searched for.
        const huge = `${values[0]} ${`${values.join(' z ')} `.repeat(8_000_000 / 1000)}`;
        const started = performance.now();
        s.append(app, 'out', huge, attempt);
        expect(performance.now() - started).toBeLessThan(100);
        expect(attempt.lines.at(-1)).toMatch(/out \[redacted\] \[redacted\] z \[redacted\]/);
        expect(attempt.lines.at(-1)).toMatch(/ \[…\]$/);
    });

    it('hides a value the cut split, even behind colour codes', async () => {
        const { attempt, values, stream } = await harness(1);
        const secret = values[0];
        const out = stream();
        // Color codes push the value's start right up to the cut.
        const colours = '\u001b[1;31m\u001b[0m'.repeat(300);
        const before = 'x'.repeat(4000 - colours.length - 20);
        out.emit('data', `${before}${colours}${secret} and more\n`);
        out.emit('end');
        const line = attempt.lines.at(-1)!;
        expect(line).toMatch(/ \[…\]$/);
        // No run of it is left, not even most of it.
        for (let n = 6; n <= secret.length; n++) {
            expect(line).not.toContain(secret.slice(0, n));
        }
    });

    it('redacts a stopped process’s last output with its own values', async () => {
        const { s, app, attempt, values, stream } = await harness(1);
        const out = stream();
        // A new start, with values of its own, before the old output arrives.
        const next = s.begin(app, 'start', 2);
        next.secrets = ['another-value-0123456789'];
        app.current = next;
        out.emit('data', `bye ${values[0]}\n`);
        out.emit('end');
        expect(attempt.lines.at(-1)).toMatch(/out bye \[redacted\]$/);
    });

    it('keeps every running attempt, however many', async () => {
        const { s, app } = await harness(0);
        for (let n = 0; n < ATTEMPTS_KEPT + 3; n++) {
            s.begin(app, 'start', n + 2);
        }
        expect((app as unknown as { attempts: unknown[] }).attempts.length).toBeGreaterThan(ATTEMPTS_KEPT);
    });

    it('keeps the running attempt while newer builds come and go', async () => {
        const r = await runtime();
        await r.deploy('tracker--dot-ab12cd', 1, bundle());
        await r.start('tracker--dot-ab12cd', 1);
        for (let version = 2; version <= ATTEMPTS_KEPT + 3; version++) {
            await r.deploy('tracker--dot-ab12cd', version, bundle({}, APP.replace("?? 'v'", `?? 'v${version}'`)));
        }
        const { attempts } = r.supervisor.attempts('tracker--dot-ab12cd');
        expect(attempts).toHaveLength(ATTEMPTS_KEPT);
        expect(attempts[0]).toMatchObject({
            kind: 'start',
            version: 1,
            state: 'running',
        });
    });

    it('keeps a crash’s stack trace when both streams flood', async () => {
        const r = await runtime({ APPS_RUNTIME_START_SECONDS: '60' });
        // An uncaught exception can exit before Node flushes queued console output.
        // Deliver the flood first so this test actually exercises the supervisor's
        // dropped-line accounting rather than the child's pipe scheduling.
        const flood = `for (let i = 0; i < 10000; i++) { console.log('out line ' + i); console.error('err line ' + i); }
await Promise.all([
  new Promise(resolve => process.stdout.write('', resolve)),
  new Promise(resolve => process.stderr.write('', resolve)),
]);
function deepInTheApp() { throw new Error('the trace survives'); }
deepInTheApp();`;
        const ids = ['flood-a--dot-ab12cd', 'flood-b--dot-ab12cd', 'flood-c--dot-ab12cd'];
        await Promise.all(
            ids.map(async (id) => {
                await r.deploy(id, 1, bundle({}, flood));
                expect((await r.start(id, 1)).status).toBe(409);
            }),
        );
        for (const id of ids) {
            const start = r.supervisor.attempts(id).attempts[1];
            const text = start.lines.join('\n');
            expect(text, id).toContain('Error: the trace survives');
            expect(text, id).toMatch(/at deepInTheApp/);
            expect(start.dropped, id).toBeGreaterThan(0);
            expect(start.lines.at(-1), id).toMatch(/runtime exited \(code 1\)$/);
        }
    }, 60_000);

    it('stops an app that floods its output', async () => {
        const r = await runtime();
        const id = 'blocked--dot-ab12cd';
        // Answers on its socket, then writes without end (no SIGTERM handler).
        const blocked = `import { createServer } from 'node:http';
createServer((req, res) => res.end('ok')).listen(process.env.CB_SOCKET, () => {
  setTimeout(() => { for (;;) process.stdout.write('x'.repeat(200) + '\\n'); }, 50);
});`;
        await r.deploy(id, 1, bundle({}, blocked));
        expect((await r.start(id, 1)).status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const started = Date.now();
        expect((await r.call(`/v1/apps/${id}/stop`, 'POST', {})).status).toBe(200);
        expect(Date.now() - started).toBeLessThan(4000);
        expect(r.supervisor.status(id).state).toBe('stopped');
        expect(r.supervisor.attempts(id).attempts.at(-1)).toMatchObject({
            state: 'stopped',
            exit: { reason: 'stopped' },
        });
    }, 20_000);

    it('keeps a start’s egress credentials out of its output while an install runs', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cb-rt-install-'));
        cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
        const installer = join(dir, 'install.sh');
        writeFileSync(installer, '#!/bin/sh\nsleep 1\nexit 0\n', { mode: 0o755 });
        const r = await runtime({
            APPS_RUNTIME_INSTALL: installer,
            APPS_RUNTIME_EGRESS_PROXY: await standIn(),
        });
        const id = 'proxy--dot-ab12cd';
        const egress = ['api.example.com:443'];
        // Says its proxy password now, and again after the install is done.
        const talker = `${APP}
const say = () => console.log('pw ' + new URL(process.env.HTTPS_PROXY).password);
say(); setTimeout(say, 1800);`;
        await r.deploy(id, 1, bundle({ egress }, talker));
        const installing = r.deploy(
            id,
            2,
            bundle({}, APP, [
                {
                    path: 'package.json',
                    data: Buffer.from('{"dependencies":{"left-pad":"1.3.0"}}'),
                },
                { path: 'bun.lock', data: Buffer.from('{}') },
            ]),
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect((await r.start(id, 1)).status).toBe(200);
        expect((await installing).status).toBe(200);
        const password = egressUser(TOKEN, id, egress).password;
        await expect
            .poll(
                () =>
                    r.supervisor
                        .attempts(id)
                        .attempts.flatMap((item) => item.lines)
                        .filter((line) => line.includes(' pw ')).length,
                { timeout: 5000, interval: 100 },
            )
            .toBe(2);
        const text = r.supervisor
            .attempts(id)
            .attempts.flatMap((item) => item.lines)
            .join('\n');
        expect(text).not.toContain(password);
        expect(text.match(/ pw \[redacted\]/g)).toHaveLength(2);
    });
});

describe('apps egress', () => {
    /** A local stand-in for a site an app may reach. */
    async function echo() {
        const connections: number[] = [];
        const server = createServer((socket) => {
            connections.push(Date.now());
            socket.on('data', (data) => socket.write(`echo:${data}`));
        });
        return { port: await listen(server), connections };
    }
    async function proxy() {
        const logs: string[] = [];
        const server = egressProxy({
            allow: [],
            tenant: egressTenant(TOKEN),
            publicOnly: true,
            // Names resolve locally in tests; never through DNS.
            lookup: async (host) => [
                {
                    address: host === 'allowed.example.com' || host === 'other.example.com' ? '127.0.0.1' : '10.0.0.10',
                },
            ],
            isPublic: (address) => address === '127.0.0.1',
            log: (line) => logs.push(line),
        });
        return { port: await listen(server), logs };
    }

    it('lets each app reach only its manifest’s hosts, with signed credentials', async () => {
        const site = await echo();
        const p = await proxy();
        const r = await runtime({
            APPS_RUNTIME_EGRESS_PROXY: `http://127.0.0.1:${p.port}`,
        });
        const allowed = `allowed.example.com:${site.port}`;
        await r.deploy('tracker--dot-ab12cd', 1, bundle({ egress: [allowed, `rebind.example.com:${site.port}`] }));
        await r.start('tracker--dot-ab12cd', 1);
        const through = async (target: string) =>
            JSON.parse(
                (await r.viaIngress('tracker--dot-ab12cd', `/connect?target=${encodeURIComponent(target)}`)).body,
            ).got as string;
        expect(await through(allowed)).toMatch(/^HTTP\/1\.1 200[\s\S]*echo:ping/);
        // Not in its manifest (another app's host, or anything else).
        expect(await through(`other.example.com:${site.port}`)).toMatch(/^HTTP\/1\.1 403/);
        // In its manifest, but the name resolves to a private address.
        expect(await through(`rebind.example.com:${site.port}`)).toMatch(/^HTTP\/1\.1 403/);
        expect(site.connections).toHaveLength(1);
        expect(p.logs).toEqual([
            `egress-proxy: allowed CONNECT ${allowed} for tracker--dot-ab12cd`,
            `egress-proxy: denied CONNECT other.example.com:${site.port} for tracker--dot-ab12cd`,
            `egress-proxy: denied CONNECT rebind.example.com:${site.port} for tracker--dot-ab12cd (not public)`,
        ]);
        // The env names the proxy with that app's credentials only.
        const env = JSON.parse((await r.viaIngress('tracker--dot-ab12cd', '/env')).body);
        expect(env.proxy).toContain('tracker--dot-ab12cd.');
    });

    it('refuses missing, forged and widened credentials', async () => {
        const site = await echo();
        const p = await proxy();
        const target = `allowed.example.com:${site.port}`;
        const send = (auth?: string) =>
            new Promise<string>((resolve) => {
                const socket = connect(p.port, '127.0.0.1');
                let got = '';
                socket.on('data', (data) => {
                    got += data;
                    socket.end();
                });
                socket.on('close', () => resolve(got));
                socket.write(
                    `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: Basic ${Buffer.from(auth).toString('base64')}\r\n` : ''}\r\n`,
                );
            });
        expect(await send()).toMatch(/^HTTP\/1\.1 407/);
        const mine = egressUser(TOKEN, 'tracker--dot-ab12cd', ['x.example.com:443']);
        // A different allowlist with the old password (an app widening its own).
        const widened = `tracker--dot-ab12cd.${Buffer.from(target).toString('base64url')}`;
        expect(await send(`${widened}:${mine.password}`)).toMatch(/^HTTP\/1\.1 407/);
        const forged = egressUser('another-secret-0123456789abcdef', 'tracker--dot-ab12cd', [target]);
        expect(await send(`${forged.user}:${forged.password}`)).toMatch(/^HTTP\/1\.1 407/);
        const good = egressUser(TOKEN, 'tracker--dot-ab12cd', [target]);
        expect(await send(`${good.user}:${good.password}`)).toMatch(/^HTTP\/1\.1 200/);
    });

    describe('dependency installs (CB-149)', () => {
        const deps = (extra: Partial<AppManifest> = {}) =>
            bundle(extra, APP, [
                {
                    path: 'package.json',
                    data: Buffer.from('{"dependencies":{"three":"0.180.0"}}'),
                },
                { path: 'bun.lock', data: Buffer.from('{}') },
            ]);
        /** An installer (node) that runs `source(its dir)` with the install's env. */
        const installer = (source: (dir: string) => string) => {
            const dir = mkdtempSync(join(tmpdir(), 'cb-rt-install-'));
            cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
            const script = join(dir, 'install.mjs');
            writeFileSync(script, source(dir));
            return { dir, command: `${process.execPath} ${script}` };
        };
        /** A port nothing listens on yet. */
        const freePort = async () => {
            const server = createServer();
            const port = await new Promise<number>((resolve) =>
                server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
            );
            await new Promise((resolve) => server.close(resolve));
            return port;
        };
        /** Whether a NO_PROXY list sends `host` around the proxy. */
        const bypasses = (list: string | null | undefined, host: string) =>
            (list ?? '')
                .split(',')
                .map((entry) => entry.trim().replace(/^\*?\./, ''))
                .some((entry) => entry === '*' || host === entry || host.endsWith(`.${entry}`));

        it('gives the install the registry through the proxy, whatever the app’s egress', async () => {
            const proxy = await standIn();
            const { dir, command } = installer(
                (dir) => `
import { writeFileSync } from 'node:fs';
const names = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];
writeFileSync(${JSON.stringify(dir)} + '/' + process.env.HOME.split('/').at(-2) + '.json',
  JSON.stringify(Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]))));
`,
            );
            const r = await runtime({
                APPS_RUNTIME_INSTALL: command,
                APPS_RUNTIME_EGRESS_PROXY: proxy,
            });
            for (const [id, egress] of [
                ['none--dot-ab12cd', []],
                ['some--dot-ab12cd', ['api.example.com:443']],
            ] as const) {
                const deployed = await r.deploy(id, 1, deps({ egress: [...egress] }));
                expect(deployed.status).toBe(200);
                const env = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as Record<string, string | null>;
                const url = env.HTTPS_PROXY!;
                for (const name of ['https_proxy', 'HTTP_PROXY', 'http_proxy']) {
                    expect(env[name]).toBe(url);
                }
                const parsed = new URL(url);
                expect(`${parsed.protocol}//${parsed.host}`).toBe(proxy);
                // The registry's credentials, not the app's own list.
                const { user, password } = egressUser(TOKEN, id, ['registry.npmjs.org:443']);
                expect(decodeURIComponent(parsed.username)).toBe(user);
                expect(decodeURIComponent(parsed.password)).toBe(password);
                const tenant = egressTenant(TOKEN)({
                    headers: {
                        'proxy-authorization': `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
                    },
                } as never);
                expect(tenant?.label).toBe(id);
                expect([...(tenant?.allow ?? [])]).toEqual(['registry.npmjs.org:443']);
                for (const name of ['NO_PROXY', 'no_proxy']) {
                    expect(bypasses(env[name], 'registry.npmjs.org')).toBe(false);
                }
            }
            // The app's own NO_PROXY: its loopback and the data API, not the registry.
            await r.start('some--dot-ab12cd', 1);
            const started = JSON.parse((await r.viaIngress('some--dot-ab12cd', '/env')).body);
            expect(started.noProxy).toBe('app,localhost,127.0.0.1,::1');
            expect(bypasses(started.noProxy, 'registry.npmjs.org')).toBe(false);
        });

        it('waits for a proxy that isn’t up yet, then installs through it with egress []', async () => {
            const site = await echo();
            const registry = `registry.npmjs.org:${site.port}`;
            const port = await freePort();
            // Downloads a "tarball" as bun would: a CONNECT with the credentials.
            const { command } = installer(
                () => `
import { connect } from 'node:net';
const proxy = new URL(process.env.HTTPS_PROXY);
const auth = Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64');
const socket = connect(Number(proxy.port), proxy.hostname);
let got = '';
socket.on('error', (error) => { console.error('error: ' + error.code + ' downloading tarball three@0.180.0'); process.exit(1); });
socket.on('data', (data) => {
  got += data;
  if (got.startsWith('HTTP/1.1 200') && !got.includes('echo:')) socket.write('tgz');
  else if (got.includes('echo:tgz')) { console.log('+ three@0.180.0'); process.exit(0); }
  else if (!got.startsWith('HTTP/1.1 200')) { console.error('error: ' + got.split('\\r\\n')[0]); process.exit(1); }
});
socket.write('CONNECT ${registry} HTTP/1.1\\r\\nHost: ${registry}\\r\\nProxy-Authorization: Basic ' + auth + '\\r\\n\\r\\n');
`,
            );
            const r = await runtime({
                APPS_RUNTIME_INSTALL: command,
                APPS_RUNTIME_EGRESS_PROXY: `http://127.0.0.1:${port}`,
                APPS_RUNTIME_REGISTRY: registry,
            });
            const id = 'songs--dot-ab12cd';
            const deploying = r.deploy(id, 1, deps({ egress: [] }));
            await new Promise((resolve) => setTimeout(resolve, 1500));
            // The apps' egress proxy as the stack runs it, up late.
            const logs: string[] = [];
            const server = egressProxy({
                allow: [],
                tenant: egressTenant(TOKEN),
                publicOnly: true,
                lookup: async () => [{ address: '127.0.0.1' }],
                isPublic: (address) => address === '127.0.0.1',
                log: (line) => logs.push(line),
            });
            await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
            cleanup.push(
                () =>
                    new Promise<void>((resolve) => {
                        server.closeAllConnections();
                        server.close(() => resolve());
                    }),
            );
            expect((await deploying).status).toBe(200);
            expect(logs).toEqual([`egress-proxy: allowed CONNECT ${registry} for ${id}`]);
            expect(site.connections).toHaveLength(1);
            const [build] = r.supervisor.attempts(id).attempts;
            expect(build).toMatchObject({ kind: 'build', state: 'succeeded' });
            const text = build.lines.join('\n');
            expect(text).toMatch(
                /waiting for the egress proxy[\s\S]*installing dependencies[\s\S]*out \+ three@0\.180\.0/,
            );
        });

        it('says so when the proxy never answers, and installs nothing', async () => {
            const { dir, command } = installer(
                (dir) => `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(dir)} + '/ran', '');
`,
            );
            const r = await runtime({
                APPS_RUNTIME_INSTALL: command,
                APPS_RUNTIME_EGRESS_PROXY: `http://127.0.0.1:${await freePort()}`,
                APPS_RUNTIME_PROXY_WAIT_SECONDS: '1',
            });
            const refused = await r.deploy('late--dot-ab12cd', 1, deps());
            expect(refused.status).toBe(503);
            expect(((await refused.json()) as { error: string }).error).toBe(
                'The egress proxy didn’t answer within 1 s, so the dependencies weren’t installed.',
            );
            expect(() => readFileSync(join(dir, 'ran'))).toThrow();
            const [build] = r.supervisor.attempts('late--dot-ab12cd').attempts;
            expect(build).toMatchObject({
                kind: 'build',
                state: 'failed',
                exit: { reason: 'build' },
            });
            expect(build.lines.join('\n')).toContain('waiting for the egress proxy');
            expect(r.supervisor.status('late--dot-ab12cd').versions).toEqual([]);
        });

        it('starts a version only once its install has finished (CB-150)', async () => {
            // Installs until the test writes "go" (or "fail") in its directory.
            const { dir, command } = installer(
                (dir) => `
import { existsSync, writeFileSync } from 'node:fs';
const at = (name) => ${JSON.stringify(dir)} + '/' + name;
writeFileSync(at('installing'), '');
while (!existsSync(at('go')) && !existsSync(at('fail')))
  await new Promise((resolve) => setTimeout(resolve, 20));
if (existsSync(at('fail'))) { console.error('error: no three'); process.exit(1); }
console.log('+ three@0.180.0');
`,
            );
            const r = await runtime({
                APPS_RUNTIME_INSTALL: command,
                APPS_RUNTIME_EGRESS_PROXY: await standIn(),
            });
            const id = 'songs--dot-ab12cd';
            const packed = deps();
            const installing = async () => {
                await expect.poll(() => existsSync(join(dir, 'installing')), { timeout: 5000 }).toBe(true);
                rmSync(join(dir, 'installing'));
            };
            const deploying = r.deploy(id, 1, packed);
            await installing();
            expect(r.supervisor.status(id)).toMatchObject({
                state: 'not_deployed',
                versions: [],
            });
            // The owner's Start meanwhile: refused, or it waits for the install.
            expect((await r.start(id, 1)).status).toBe(404);
            let joined = false;
            const again = r.deploy(id, 1, packed).then((res) => {
                joined = true;
                return res;
            });
            const other = bundle({}, APP.replace("?? 'v'", "?? 'v2'"));
            expect((await r.deploy(id, 1, other)).status).toBe(409);
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(joined).toBe(false);
            writeFileSync(join(dir, 'go'), '');
            expect((await deploying).status).toBe(200);
            expect((await again).status).toBe(200);
            // One install, for both.
            expect(r.supervisor.attempts(id).attempts.filter((a) => a.kind === 'build')).toHaveLength(1);
            expect(r.supervisor.status(id)).toMatchObject({
                state: 'stopped',
                versions: [1],
            });
            expect((await r.start(id, 1)).status).toBe(200);
            // A failed install leaves nothing to start.
            rmSync(join(dir, 'go'));
            const failing = r.deploy(id, 2, deps({ name: 'Tracker 2' }));
            await installing();
            expect((await r.start(id, 2)).status).toBe(404);
            writeFileSync(join(dir, 'fail'), '');
            expect((await failing).status).not.toBe(200);
            expect(r.supervisor.status(id).versions).toEqual([1]);
            expect((await r.start(id, 2)).status).toBe(404);
            expect(r.supervisor.status(id)).toMatchObject({
                state: 'running',
                version: 1,
            });
        });
    });
});

describe('deployment', () => {
    it('builds the runtime image with its uid base, limits and few capabilities', () => {
        const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
        const target = dockerfile.slice(dockerfile.indexOf('AS apps-runtime'));
        expect(target).toContain('APPS_RUNTIME_UID_BASE=20000');
        expect(target).toContain('APPS_RUNTIME_PRLIMIT=on');
        expect(target).toContain('DO_NOT_TRACK=1');
        expect(target).toContain('--ambient-caps=-all,+setuid,+setgid,+chown,+kill');
        expect(target).toContain('dist/server/apps-runtime/index.js');
    });
});
