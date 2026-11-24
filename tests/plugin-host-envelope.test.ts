import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    ENVELOPE_TTL_MS,
    isHostTarget,
    isReservedTarget,
    newJti,
    openEnvelope,
    openHostEnvelope,
    requestTargetHash,
    signEnvelope,
    type EnvelopeClaims,
} from '@socio/foundation/apps/envelope';
import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';
import { RUNTIME_HEADER_TASK } from '@socio/shared/apps/apps-runtime-types';
import type { User } from '@socio/shared/types';

import { socioApp } from '../packages/app-sdk/src/index.js';
import { HttpDockerEngine, MemoryDocker } from '../src/apps-runtime/docker.js';
import { ingressServer } from '../src/apps-runtime/ingress.js';
import { pluginActorKey, pluginProof } from '../src/apps-runtime/keys.js';
import { PluginServices } from '../src/apps-runtime/services.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { signHostEnvelope } from '../src/server/plugins/host-envelope.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-458 step 2: the host envelope (`acc: "host"`, Socio itself calling a
// plugin on `/__cb/`) and task affinity (`x-cb-runtime-task`, so every request
// of one snapshot reaches one task). Negative cases first.

const SECRET = 'secret-0123456789abcdef-xyz';
const RUNTIME = 'runtime-secret-runtime-secret-32';
const NOW = 1_795_000_000_000;
const KEY = Buffer.from(pluginActorKey(RUNTIME, 'crm'), 'base64url');
const OTHER = Buffer.from(pluginActorKey(RUNTIME, 'leads'), 'base64url');
const IMAGE = `company-brain-plugin-crm@sha256:${'a'.repeat(64)}`;
const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
];

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const host = (target: string, method = 'POST', now = NOW) => signHostEnvelope(RUNTIME, 'crm', { method, target, now });
const person = (target: string, method = 'GET', over: Partial<EnvelopeClaims> = {}) =>
    signEnvelope(KEY, {
        aud: 'plugin:crm',
        sub: 'person-00000000000001',
        acc: 'owner',
        sid: 'session-000000000001',
        obo: 'cbob_placeholder',
        req: { m: method, p: requestTargetHash(target) },
        iat: NOW,
        exp: NOW + ENVELOPE_TTL_MS,
        jti: newJti(),
        ver: null,
        ...over,
    });
/** A host envelope's claims with something added or changed, signed with the key. */
const hostWith = (target: string, over: Record<string, unknown>) =>
    signEnvelope(KEY, {
        aud: 'plugin:crm',
        sub: 'host',
        acc: 'host',
        req: { m: 'POST', p: requestTargetHash(target) },
        iat: NOW,
        exp: NOW + ENVELOPE_TTL_MS,
        jti: newJti(),
        ...over,
    } as never);
const expectFor = (target: string, method = 'POST', now = NOW) => ({ aud: 'plugin:crm', method, target, now });

describe('the host envelope codec', () => {
    it('opens a host envelope only as the host’s, only on /__cb/', () => {
        const target = '/__cb/backup';
        const good = host(target);
        // A person's opener never takes it, on any path.
        expect(openEnvelope([KEY], good, expectFor(target))).toEqual({ ok: false, reason: 'wrong_kind' });
        const off = hostWith('/deals', {});
        expect(openEnvelope([KEY], off, expectFor('/deals'))).toEqual({ ok: false, reason: 'wrong_kind' });
        // The host's opener takes nothing but the host's, and nowhere but /__cb/.
        expect(openHostEnvelope([KEY], person(target, 'POST'), expectFor(target))).toEqual({
            ok: false,
            reason: 'wrong_kind',
        });
        expect(openHostEnvelope([KEY], off, expectFor('/deals'))).toEqual({ ok: false, reason: 'wrong_kind' });
        // Bound to its plugin, its minute and its exact request, like a person's.
        expect(openHostEnvelope([OTHER], good, expectFor(target))).toEqual({ ok: false, reason: 'bad_mac' });
        expect(openHostEnvelope([KEY], good, { ...expectFor(target), aud: 'plugin:leads' })).toEqual({
            ok: false,
            reason: 'wrong_audience',
        });
        expect(openHostEnvelope([KEY], good, expectFor(target, 'POST', NOW + ENVELOPE_TTL_MS + 6_000))).toEqual({
            ok: false,
            reason: 'expired',
        });
        expect(openHostEnvelope([KEY], good, expectFor('/__cb/backup/other'))).toEqual({
            ok: false,
            reason: 'wrong_request',
        });
        expect(openHostEnvelope([KEY], good, expectFor(target, 'GET'))).toEqual({
            ok: false,
            reason: 'wrong_request',
        });
        expect(openHostEnvelope([KEY], good, expectFor(target))).toMatchObject({
            ok: true,
            claims: { aud: 'plugin:crm', sub: 'host', acc: 'host' },
        });
    });

    it('takes no other claim in a host envelope: no person, session, socio or token', () => {
        const target = '/__cb/backup';
        for (const extra of [
            { sid: 'session-000000000001' },
            { obo: 'cbob_x' },
            { act: { typ: 'socio', id: 'socio-000000000001', grant: 'grant-00000000001' } },
            { scp: ['app:read'] },
            { ver: null },
            { sub: 'person-00000000000001' },
        ]) {
            expect(openHostEnvelope([KEY], hostWith(target, extra), expectFor(target))).toEqual({
                ok: false,
                reason: 'malformed',
            });
        }
        // A person's envelope that says `acc: "host"` is no envelope at all.
        expect(
            openEnvelope([KEY], person('/deals', 'GET', { acc: 'host' as never }), expectFor('/deals', 'GET')),
        ).toEqual({ ok: false, reason: 'malformed' });
    });

    it('reserves every spelling of /__cb/ from people, and gives the host only the plain one', () => {
        for (const target of [
            '/__cb',
            '/__cb/',
            '/__cb/backup?x=1',
            '/__CB/backup',
            '/%5F%5Fcb/backup',
            '/%255F%255Fcb/backup',
            '/a/../__cb/backup',
            '/./__cb/backup',
            '\\__cb\\backup',
            '//__cb/backup',
            // A router that doesn't resolve dot segments sees /__cb/ first.
            '/__cb/backup/../../deals',
            '/__CB/x/../../deals',
            '/./__cb/../deals',
        ]) {
            expect(isReservedTarget(target), target).toBe(true);
            expect(openEnvelope([KEY], person(target), expectFor(target, 'GET')), target).toEqual({
                ok: false,
                reason: 'wrong_kind',
            });
        }
        for (const target of ['/__cb/backup', '/__cb/restore/01J/items/3', '/__cb/backup/verify?x=1']) {
            expect(isHostTarget(target), target).toBe(true);
        }
        for (const target of ['/__CB/backup', '/%5F%5Fcb/backup', '/__cb/%2e%2e/deals', '/__cb/../deals', '/__cb\\x']) {
            expect(isHostTarget(target), target).toBe(false);
            expect(openHostEnvelope([KEY], hostWith(target, {}), expectFor(target)), target).toEqual({
                ok: false,
                reason: 'wrong_kind',
            });
        }
        for (const target of ['/deals', '/__cbx/backup', '/x/__cb/backup', '/cb/backup']) {
            expect(isReservedTarget(target), target).toBe(false);
        }
    });

    it('is signed by Socio for /__cb/ only, with the plugin’s envelope key', () => {
        expect(() => signHostEnvelope(RUNTIME, 'crm', { method: 'GET', target: '/deals' })).toThrow(/__cb/);
        expect(() => signHostEnvelope(RUNTIME, 'crm', { method: 'GET', target: '/__CB/backup' })).toThrow(/__cb/);
        expect(() => signHostEnvelope(RUNTIME, 'crm', { method: 'GET', target: '/__cb/../deals' })).toThrow(/__cb/);
        const opened = openHostEnvelope([KEY], host('/__cb/backup', 'post'), expectFor('/__cb/backup'));
        expect(opened).toMatchObject({ ok: true, claims: { req: { m: 'POST' } } });
        const claims = (opened as unknown as { claims: Record<string, unknown> }).claims;
        expect(Object.keys(claims).sort()).toEqual(['acc', 'aud', 'exp', 'iat', 'jti', 'req', 'sub']);
        expect((claims.exp as number) - (claims.iat as number)).toBe(ENVELOPE_TTL_MS);
    });
});

describe('the SDK on /__cb/', () => {
    const sdk = (over: Parameters<typeof socioApp>[0] = {}) =>
        socioApp({
            appId: 'plugin:crm',
            key: pluginActorKey(RUNTIME, 'crm'),
            actions: { 'deals.view': 'read', 'settings.update': 'admin' },
            now: () => NOW,
            env: {},
            ...over,
        });

    it('refuses a person’s or a socio’s envelope on /__cb/, and the host’s anywhere else', () => {
        const app = sdk();
        expect(app.verify({ method: 'POST', target: '/__cb/backup', header: person('/__cb/backup', 'POST') })).toEqual({
            ok: false,
            status: 401,
            reason: 'wrong_kind',
        });
        const socio = person('/__cb/backup', 'POST', {
            act: { typ: 'socio', id: 'socio-000000000001', grant: 'grant-00000000001' },
            scp: ['app:act'],
        });
        expect(app.verify({ method: 'POST', target: '/__cb/backup', header: socio })).toMatchObject({ ok: false });
        expect(app.verify({ method: 'GET', target: '/__CB/backup', header: person('/__CB/backup') })).toMatchObject({
            ok: false,
            status: 401,
        });
        expect(app.verify({ method: 'POST', target: '/deals', header: hostWith('/deals', {}) })).toEqual({
            ok: false,
            status: 401,
            reason: 'wrong_kind',
        });
        // Not even a listed public path opens /__cb/ without the host's envelope.
        const open = sdk({ publicPaths: ['/__cb/', '/__cb/backup', '/healthz'] });
        expect(open.isPublic('/__cb/backup')).toBe(false);
        expect(open.isPublic('/healthz')).toBe(true);
        expect(open.verify({ method: 'POST', target: '/__cb/backup', header: undefined })).toMatchObject({
            ok: false,
            status: 401,
        });
    });

    it('verifies the host once, as the host, who runs no declared action', () => {
        const app = sdk();
        const header = host('/__cb/backup');
        const verdict = app.verify({ method: 'POST', target: '/__cb/backup', header });
        expect(verdict).toEqual({
            ok: true,
            principal: { person: 'host', access: 'host', sessionId: 'host', version: null },
        });
        // Its jti, once.
        expect(app.verify({ method: 'POST', target: '/__cb/backup', header })).toEqual({
            ok: false,
            status: 401,
            reason: 'replayed',
        });
        const principal = (verdict as { principal: Parameters<typeof app.authorize>[0] }).principal;
        expect(app.authorize(principal, 'deals.view')).toEqual({ ok: false, status: 403, reason: 'host_envelope' });
        expect(app.authorize(principal, 'settings.update')).toEqual({
            ok: false,
            status: 403,
            reason: 'host_envelope',
        });
        // A person's envelope still opens the plugin's own routes.
        expect(app.verify({ method: 'GET', target: '/deals', header: person('/deals') })).toMatchObject({
            ok: true,
            principal: { access: 'owner' },
        });
    });

    it('passes the host to a fetch handler on /__cb/ and refuses a person there with 401', async () => {
        const app = sdk();
        const seen: Array<string | undefined> = [];
        const handler = app.fetchHandler((_request, principal) => {
            seen.push(principal?.access);
            return new Response('ok');
        });
        const call = (target: string, header: string) =>
            handler(new Request(`http://crm.invalid${target}`, { method: 'POST', headers: { 'x-cb-actor': header } }));
        expect((await call('/__cb/backup', host('/__cb/backup'))).status).toBe(200);
        expect((await call('/__cb/backup', person('/__cb/backup', 'POST'))).status).toBe(401);
        expect((await call('/deals', hostWith('/deals', {}))).status).toBe(401);
        expect(seen).toEqual(['host']);
    });
});

/** One plugin task: records what reaches it. */
async function task(name: string, log: Array<{ task: string; url: string; headers: IncomingHttpHeaders }>) {
    const server: Server = createServer((req, res) => {
        log.push({ task: name, url: req.url!, headers: req.headers });
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(`{"task":"${name}"}`);
        });
    });
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

/** The runtime's real ingress before two tasks of `crm`, `taska` and `taskb`. */
async function twoTasks() {
    const log: Array<{ task: string; url: string; headers: IncomingHttpHeaders }> = [];
    const ports = { taska: await task('taska', log), taskb: await task('taskb', log) };
    const running = new Set(['taska', 'taskb']);
    let cursor = 0;
    const services = {
        refresh: async () => {},
        owns: (id: string) => id === 'crm',
        targets: async () => {
            const list = [...running].map((name) => ({ host: '127.0.0.1', port: ports[name as keyof typeof ports] }));
            const start = cursor++ % Math.max(list.length, 1);
            return [...list.slice(start), ...list.slice(0, start)];
        },
        taskTargets: async (_id: string, name: string) =>
            running.has(name) ? [{ host: '127.0.0.1', port: ports[name as keyof typeof ports] }] : [],
        proof: (id: string) => pluginProof(RUNTIME, id),
    };
    const supervisor = {
        running: () => false,
        connectApp: () => {
            throw new Error('no apps here');
        },
    };
    const server = ingressServer(supervisor as never, RUNTIME, services as never);
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    cleanup.push(
        () =>
            new Promise<void>((ok) => {
                server.closeAllConnections();
                server.close(() => ok());
            }),
    );
    return { port: (server.address() as AddressInfo).port, log, running };
}

/** One request to the ingress; its status and body. */
const send = (port: number, method: string, path: string, headers: Record<string, string>) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (body += chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
    });

async function fixture() {
    const ingress = await twoTasks();
    const dir = mkdtempSync(join(tmpdir(), 'cb-plugin-host-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
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
                    permissions: ['crm:read'],
                    audience: 'members',
                    service: { image: IMAGE, port: 8080 },
                    delegation: { contract: 1, actions: { 'deals.view': 'read' } },
                },
            ],
        }),
    );
    const status = () => ({
        id: 'crm',
        service: 'socio-plugin-crm',
        image: IMAGE,
        replicas: 2,
        running: ingress.running.size,
        state: 'running' as const,
        tasks: [...ingress.running],
    });
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            sessionSecret: SECRET,
            appOrigin: 'http://localhost:4310',
            data: { userDataDir: dir, apiUrl: 'http://company-brain-app:4310' },
            apps: appsSettingsFromEnv({}, 'http://localhost:4310')!,
            appsRuntime: {
                url: 'http://127.0.0.1:9',
                token: RUNTIME,
                ingress: { host: '127.0.0.1', port: ingress.port },
            },
            plugins: {
                catalogs: [{ kind: 'file', path: catalog }],
                serviceToken: 'plugin-service-token-plugin-service-token',
                runtime: {
                    provisionService: async () => status(),
                    scaleService: async () => status(),
                    removeService: async () => {},
                    serviceStatus: async () => status(),
                },
            },
            // Its flags are in development: only an internal deployment has them (CB-503).
            deploymentKind: 'internal',
            featureFlags: { 'socio-actor-access': true },
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
    const { plugins } = platform;
    await plugins.install('crm');
    const origin = plugins.origin('crm')!;
    const signIn = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        const launched = await app.request('http://localhost:4310/api/plugins/crm/launch', {
            method: 'POST',
            headers: { cookie, 'content-type': 'application/json' },
            body: '{}',
        });
        const { url } = (await launched.json()) as { url: string };
        return (await app.request(url)).headers.get('set-cookie')!.split(';')[0];
    };
    /** One host call, as the backup step will make it: hostTarget, then the ingress. */
    const hostCall = async (method: string, target: string, pin?: string) => {
        const where = await plugins.hostTarget('crm', { method, target, ...(pin === undefined ? {} : { task: pin }) });
        if (where.state !== 'running') {
            throw new Error(where.state);
        }
        return send(where.port, method, target, where.headers);
    };
    const sdk = () => socioApp({ appId: 'plugin:crm', key: pluginActorKey(RUNTIME, 'crm'), env: {} });
    return { ingress, app, plugins, origin, signIn, hostCall, sdk };
}

describe('task affinity at the ingress', () => {
    it('sends every request a snapshot pins to that task, and none to another, with the host’s envelope', async () => {
        const f = await fixture();
        expect(await f.plugins.hostTasks('crm')).toEqual(['taska', 'taskb']);
        const app = f.sdk();
        for (const [method, target] of [
            ['POST', '/__cb/backup'],
            ['GET', '/__cb/backup/01JSNAPSHOT'],
            ['GET', '/__cb/backup/01JSNAPSHOT/items/0?chunk=1'],
            ['DELETE', '/__cb/backup/01JSNAPSHOT'],
        ]) {
            const answer = await f.hostCall(method, target, 'taskb');
            expect(answer).toEqual({ status: 200, body: '{"task":"taskb"}' });
            const seen = f.ingress.log.at(-1)!;
            expect(seen.task).toBe('taskb');
            // The pin is the runtime's: the task never sees it.
            expect(seen.headers[RUNTIME_HEADER_TASK]).toBeUndefined();
            // Signed for the ingress, so it reaches the task, and opens there as the host.
            expect(
                app.verify({ method, target: seen.url, header: seen.headers['x-cb-actor'] as string }),
            ).toMatchObject({ ok: true, principal: { access: 'host' } });
        }
        expect(new Set(f.ingress.log.map((row) => row.task))).toEqual(new Set(['taskb']));
    });

    it('answers 502 for a pinned task that stopped or never was, and never reaches another', async () => {
        const f = await fixture();
        f.ingress.running.delete('taskb');
        expect((await f.hostCall('GET', '/__cb/backup/01JSNAPSHOT', 'taskb')).status).toBe(502);
        expect((await f.hostCall('GET', '/__cb/backup/01JSNAPSHOT', 'nosuchtask')).status).toBe(502);
        // A malformed or repeated pin names no task at all.
        expect((await f.hostCall('GET', '/__cb/backup/01JSNAPSHOT', 'TASK/../a')).status).toBe(502);
        expect((await f.hostCall('GET', '/__cb/backup/01JSNAPSHOT', 'taska, taskb')).status).toBe(502);
        expect(f.ingress.log).toEqual([]);
        // Unpinned, a host call goes to any running task.
        expect((await f.hostCall('GET', '/__cb/backup/01JSNAPSHOT')).status).toBe(200);
        expect(f.ingress.log.map((row) => row.task)).toEqual(['taska']);
    });

    it('honors the pin on /__cb/ only, and refuses to sign a host call anywhere else', async () => {
        const f = await fixture();
        await expect(f.plugins.hostTarget('crm', { method: 'GET', target: '/deals' })).rejects.toThrow(/__cb/);
        const where = await f.plugins.target('crm');
        if (where.state !== 'running') {
            throw new Error(where.state);
        }
        // Off /__cb/, the header is stripped and ignored: round-robin, as for anyone.
        for (let i = 0; i < 4; i += 1) {
            expect(
                (await send(where.port, 'GET', '/deals', { ...where.headers, [RUNTIME_HEADER_TASK]: 'taskb' })).status,
            ).toBe(200);
        }
        expect(new Set(f.ingress.log.map((row) => row.task))).toEqual(new Set(['taska', 'taskb']));
        expect(f.ingress.log.every((row) => row.headers[RUNTIME_HEADER_TASK] === undefined)).toBe(true);
        // Without the ingress key, no pin and no request.
        f.ingress.log.length = 0;
        expect(
            (
                await send(where.port, 'GET', '/__cb/backup', {
                    'x-cb-runtime-app': 'crm',
                    [RUNTIME_HEADER_TASK]: 'taskb',
                })
            ).status,
        ).toBe(401);
        expect(f.ingress.log).toEqual([]);
    });
});

describe('the apps proxy never signs the host envelope or forwards the pin', () => {
    it('strips a person’s x-cb-runtime-task and forged host envelope, and signs only theirs', async () => {
        const f = await fixture();
        const cookie = await f.signIn('bob');
        const app = f.sdk();
        for (let i = 0; i < 4; i += 1) {
            const response = await f.app.request(`${f.origin}/deals`, {
                headers: {
                    cookie,
                    [RUNTIME_HEADER_TASK]: 'taskb',
                    'x-cb-runtime-current': 'f'.repeat(64),
                    'x-cb-actor': host('/__cb/backup'),
                },
            });
            expect(response.status).toBe(200);
            const seen = f.ingress.log.at(-1)!;
            expect(seen.headers[RUNTIME_HEADER_TASK]).toBeUndefined();
            const verdict = app.verify({
                method: 'GET',
                target: seen.url,
                header: seen.headers['x-cb-actor'] as string,
            });
            expect(verdict).toMatchObject({ ok: true, principal: { access: 'space' } });
            const body = JSON.parse(
                Buffer.from(String(seen.headers['x-cb-actor']).split('.')[1]!, 'base64url').toString('utf8'),
            ) as { acc: string; sub: string };
            expect(body.acc).toBe('space');
            expect(body.sub).not.toBe('host');
        }
        // The pin was never honored: requests went round the tasks.
        expect(new Set(f.ingress.log.map((row) => row.task))).toEqual(new Set(['taska', 'taskb']));
    });

    it('never forwards /__cb/ to a plugin, however a person asks', async () => {
        const f = await fixture();
        const cookie = await f.signIn('alice');
        for (const path of [
            '/__cb/backup',
            '/__cb/restore/01J/commit',
            '/__cb/backup/verify',
            '/__CB/backup',
            '/%5F%5Fcb/backup',
            '/%5f_cb/backup/verify',
        ]) {
            for (const method of ['GET', 'POST', 'DELETE']) {
                const response = await f.app.request(`${f.origin}${path}`, {
                    method,
                    headers: { cookie, [RUNTIME_HEADER_TASK]: 'taska', 'x-cb-actor': host('/__cb/backup', method) },
                });
                // The proxy's own pages answer; the plugin is never asked.
                await response.body?.cancel();
            }
        }
        expect(f.ingress.log).toEqual([]);
    });

    it('has no way to sign one: the proxy reaches plugins through a slice without host calls', () => {
        const proxy = readFileSync(join(import.meta.dirname, '../src/server/apps/proxy.ts'), 'utf8');
        expect(proxy).not.toMatch(/signHostEnvelope|hostTarget|host-envelope|RUNTIME_HEADER_TASK|x-cb-runtime-task/);
        const slices = readFileSync(join(import.meta.dirname, '../src/server/apps/slices.ts'), 'utf8');
        expect(slices).not.toMatch(/PluginHostShape/);
    });
});

describe('the runtime lists and pins tasks by id', () => {
    it('names each running task once in the service status, and pins to its addresses only', async () => {
        const engine = new MemoryDocker();
        const services = new PluginServices(engine, {
            allow: ['company-brain-plugin-'],
            maxReplicas: 5,
            secret: RUNTIME,
            pull: false,
        } as never);
        await services.ensure('crm', { image: IMAGE, port: 8080, replicas: 2 } as never);
        await services.refresh();
        expect((await services.status('crm'))?.tasks).toEqual(['task1', 'task2']);
        expect(await services.taskTargets('crm', 'task2')).toEqual([{ host: '10.8.0.2', port: 8080 }]);
        expect(await services.taskTargets('crm', 'task9')).toEqual([]);
        expect(await services.taskTargets('leads', 'task1')).toEqual([]);
    });

    it('reads task ids from the engine, and drops one it can’t take', async () => {
        const server = createServer((req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' }).end(
                JSON.stringify([
                    {
                        ID: 'abc123def456',
                        Status: { State: 'running' },
                        NetworksAttachments: [{ Addresses: ['10.0.1.5/24', '10.0.2.5/24'] }],
                    },
                    {
                        ID: 'bad id!',
                        Status: { State: 'running' },
                        NetworksAttachments: [{ Addresses: ['10.0.1.6/24'] }],
                    },
                ]),
            );
        });
        const port = await new Promise<number>((ok) =>
            server.listen(0, '127.0.0.1', () => ok((server.address() as AddressInfo).port)),
        );
        cleanup.push(() => new Promise((ok) => server.close(ok)));
        const engine = new HttpDockerEngine(`tcp://127.0.0.1:${port}`, true);
        expect(await engine.tasks('socio-plugin-crm')).toEqual([
            { ip: '10.0.1.5', state: 'running', task: 'abc123def456' },
            { ip: '10.0.2.5', state: 'running', task: 'abc123def456' },
            { ip: '10.0.1.6', state: 'running' },
        ]);
    });
});
