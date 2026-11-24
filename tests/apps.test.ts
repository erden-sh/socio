import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    appLabel,
    appLabelOfHost,
    appOrigin,
    isAppsHost,
    appSlug,
    appsSettingsFromEnv,
    dotSlug,
} from '@socio/foundation/apps/settings';
import type { DotTurn } from '@socio/foundation/turns/turn';
import type { ApprovalView } from '@socio/shared/approvals';
import type { AppsState, AppView, DotAppsState } from '@socio/shared/apps/app-types';

import { appsUpgrade } from '../src/server/apps/proxy.js';
import { appEnvFile } from '../src/server/apps/service.js';
import { appTools } from '../src/server/apps/tools.js';
import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { ComputerService } from '../src/server/computers/computer-service.js';
import type { AppTarget } from '../src/server/computers/contract.js';

import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const SECRET = 'secret-0123456789abcdef-xyz';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** A stand-in for the app's server in the computer: records what it gets. */
async function fakeUpstream() {
    const seen: Array<{
        method: string;
        url: string;
        headers: IncomingHttpHeaders;
        body: string;
    }> = [];
    const upgrades: IncomingHttpHeaders[] = [];
    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            seen.push({
                method: req.method!,
                url: req.url!,
                headers: req.headers,
                body,
            });
            if (req.url === '/html') {
                res.writeHead(200, {
                    'content-type': 'text/html',
                    'content-security-policy': "default-src 'self'",
                    'set-cookie': ['evil=1; Domain=apps.localhost', 'own=2'],
                });
                res.end('<h1>Tracker</h1>');
                return;
            }
            if (req.url === '/redirect') {
                res.writeHead(302, {
                    location: `http://127.0.0.1:${(server.address() as AddressInfo).port}/next?x=1`,
                });
                res.end();
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ path: req.url, body }));
        });
    });
    const sockets = new Set<{ destroy: () => void }>();
    server.on('upgrade', (req, socket) => {
        sockets.add(socket);
        socket.on('end', () => socket.end());
        upgrades.push(req.headers);
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake\r\nSet-Cookie: evil=1\r\n\r\n',
        );
        socket.on('data', (data: Buffer) => socket.write(`echo:${data}`));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanup.push(
        () =>
            new Promise<void>((resolve) => {
                for (const socket of sockets) {
                    socket.destroy();
                }
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    );
    return {
        port: (server.address() as AddressInfo).port,
        seen,
        upgrades,
    };
}

async function fixture(
    options: {
        apiUrl?: string | null;
        personal?: boolean;
        upstream?: boolean;
        /** APPS_HOST, APPS_LABEL_PREFIX, … (the app is on localhost:4310). */
        appsEnv?: Record<string, string>;
    } = {},
) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-apps-'));
    const apps = appsSettingsFromEnv(options.appsEnv ?? {}, 'http://localhost:4310')!;
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            sessionSecret: SECRET,
            data: {
                userDataDir: dir,
                apiUrl: options.apiUrl === null ? undefined : (options.apiUrl ?? 'http://company-brain-app:4310'),
            },
            apps,
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            origin: 'http://localhost:4310',
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
    const seed = workspace.dots()[0];
    const dot = options.personal
        ? workspace.createDot(
              seed.spaceId,
              'Personal',
              '',
              true,
              true,
              seed.spaceIds,
              null,
              false,
              null,
              false,
              'alice',
          )
        : seed;
    await workspace.computers.patch(dot.id, {
        enabled: true,
        browser: true,
        files: true,
        shell: true,
    });
    const files: Array<{ dotId: string; path: string; contents: string }> = [];
    vi.spyOn(platform.computers, 'writeFile').mockImplementation(async (dotId, path, contents) => {
        files.push({ dotId, path, contents });
    });
    const execs: Array<{ command: string; actor: string; userId?: string }> = [];
    vi.spyOn(platform.computers, 'action').mockImplementation(async (_id, _action, input, actor, _signal, userId) => {
        execs.push({
            command: (input as { command: string }).command,
            actor: actor ?? 'owner',
            userId,
        });
        return { exitCode: 0 };
    });
    const starts: string[] = [];
    vi.spyOn(platform.computers, 'start').mockImplementation(async (id, userId) => {
        starts.push(`${id}:${userId}`);
        return { state: 'running' } as never;
    });
    const upstream = options.upstream === false ? undefined : await fakeUpstream();
    let target: AppTarget = upstream
        ? { state: 'running', host: '127.0.0.1', port: upstream.port }
        : { state: 'stopped' };
    platform.apps.useTargets(async () => target);
    const sessions = new Map<string, string>();
    const login = async (userId: string) => {
        if (sessions.has(userId)) {
            return sessions.get(userId)!;
        }
        const response = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = response.headers.get('set-cookie')!.split(';')[0];
        sessions.set(userId, cookie);
        return cookie;
    };
    const api = async (userId: string, path: string, method = 'GET', body?: unknown) =>
        app.request(`http://localhost:4310/api${path}`, {
            method,
            headers: {
                cookie: await login(userId),
                ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const turn = (userId: string): DotTurn => ({
        dot,
        userId,
        threadId: 'thread',
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
    });
    const tools = (userId: string) =>
        Object.fromEntries(
            (
                appTools(platform.apps, turn(userId)) as unknown as Array<{
                    name: string;
                    execute: (input: unknown) => Promise<Record<string, unknown>>;
                }>
            ).map((tool) => [tool.name, tool.execute]),
        );
    const bypass = (userId = 'alice') => platform.approvals.setPolicy(userId, dot.id, 'app.register', 'bypass');
    /** Registers "Tracker" on port 3000 for alice under bypass. */
    const register = async (input: Record<string, unknown> = {}) => {
        await bypass();
        const result = await tools('alice').app_register({
            name: 'Tracker',
            port: 3000,
            ...input,
        });
        expect(result).toMatchObject({ status: 'approved' });
        return platform.apps.all().at(-1)!;
    };
    /** A session on the app's origin, through the launch hand-off. */
    const signIn = async (userId: string, appId: string, next?: string) => {
        const launched = await api(userId, `/apps/${appId}/launch`, 'POST', next ? { next } : {});
        expect(launched.status).toBe(200);
        const { url } = (await launched.json()) as { url: string };
        const redeemed = await app.request(url);
        expect(redeemed.status).toBe(303);
        return {
            url,
            response: redeemed,
            cookie: redeemed.headers.get('set-cookie')!.split(';')[0],
        };
    };
    const origin = (id: string) => appOrigin(apps, id);
    return {
        platform,
        workspace,
        dot,
        app,
        api,
        login,
        tools,
        bypass,
        register,
        signIn,
        origin,
        files,
        execs,
        starts,
        upstream,
        setTarget: (next: AppTarget) => {
            target = next;
            platform.apps.useTargets(async () => target);
        },
    };
}

describe('settings and hosts', () => {
    it('derives the apps host from APP_ORIGIN, honours APPS_HOST and off', () => {
        expect(appsSettingsFromEnv({}, 'https://brain.example.test')).toMatchObject({
            host: 'apps.brain.example.test',
            protocol: 'https:',
            port: '',
            mainOrigin: 'https://brain.example.test',
            sessionTtlMs: 12 * 3_600_000,
        });
        expect(appsSettingsFromEnv({ APPS_HOST: 'Apps.Example.test' }, 'http://localhost:4310')).toMatchObject({
            host: 'apps.example.test',
            port: ':4310',
        });
        expect(appsSettingsFromEnv({ APPS_HOST: 'off' }, 'http://localhost:4310')).toBeUndefined();
        expect(appsSettingsFromEnv({}, undefined)).toBeUndefined();
        expect(() => appsSettingsFromEnv({ APPS_HOST: 'bad host' }, 'http://localhost:4310')).toThrow(/APPS_HOST/);
        expect(appsSettingsFromEnv({}, 'http://localhost:4310')?.labelPrefix).toBe('');
    });

    it('allows APPS_HOST to be the app’s own host, with a label prefix', () => {
        const settings = appsSettingsFromEnv(
            { APPS_HOST: 'brain.example.com', APPS_LABEL_PREFIX: 'App-' },
            'https://brain.example.com',
        )!;
        expect(settings).toMatchObject({
            host: 'brain.example.com',
            labelPrefix: 'app-',
            mainHost: 'brain.example.com',
            protocol: 'https:',
        });
        expect(appOrigin(settings, 'tracker--dot-ab12cd')).toBe('https://app-tracker--dot-ab12cd.brain.example.com');
        for (const bad of ['app--', '-app', 'a_b', 'x'.repeat(21), 'app.']) {
            expect(() => appsSettingsFromEnv({ APPS_LABEL_PREFIX: bad }, 'https://brain.example.com')).toThrow(
                /APPS_LABEL_PREFIX/,
            );
        }
        // Prefixed labels are apps; the main host never is; other names under
        // it are the proxy's (its 404), not the app's.
        const host = (name: string) => [isAppsHost(settings, name), appLabelOfHost(settings, name)];
        expect(host('app-tracker--dot-ab12cd.brain.example.com')).toEqual([true, 'tracker--dot-ab12cd']);
        expect(host('App-Tracker--Dot-AB12CD.brain.example.com:443')).toEqual([true, 'tracker--dot-ab12cd']);
        expect(host('tracker--dot-ab12cd.brain.example.com')).toEqual([true, undefined]);
        expect(host('app-.brain.example.com')).toEqual([true, undefined]);
        expect(host('www.brain.example.com')).toEqual([true, undefined]);
        expect(host('a.app-x--y.brain.example.com')).toEqual([true, undefined]);
        expect(host('brain.example.com')).toEqual([false, undefined]);
        expect(host('Brain.Example.com.:443')).toEqual([false, undefined]);
        expect(host('example.com')).toEqual([false, undefined]);
        // APPS_HOST above the app's host: the app's host is still not an app.
        const parent = appsSettingsFromEnv({ APPS_HOST: 'example.com' }, 'https://brain.example.com')!;
        expect(isAppsHost(parent, 'brain.example.com')).toBe(false);
        expect(isAppsHost(parent, 'x.example.com')).toBe(true);
    });

    it('parses exactly one label under the apps host', () => {
        const settings = { host: 'apps.localhost' };
        expect(appLabelOfHost(settings, 'tracker--dot-ab12cd.apps.localhost')).toBe('tracker--dot-ab12cd');
        expect(appLabelOfHost(settings, 'Tracker--Dot-AB12CD.apps.localhost:4310')).toBe('tracker--dot-ab12cd');
        expect(appLabelOfHost(settings, 'apps.localhost')).toBeUndefined();
        expect(appLabelOfHost(settings, 'a.b.apps.localhost')).toBeUndefined();
        expect(appLabelOfHost(settings, 'evil-apps.localhost')).toBeUndefined();
        expect(appLabelOfHost(settings, 'localhost:4310')).toBeUndefined();
        expect(appLabelOfHost(settings, undefined)).toBeUndefined();
    });

    it('builds slugs and labels within one DNS label', () => {
        expect(appSlug('  Price Tracker!! v2 ')).toBe('price-tracker-v2');
        expect(appSlug('---')).toBe('');
        expect(appSlug('x'.repeat(50))).toHaveLength(30);
        const dot = { id: 'ab12cd34-0000-4000-8000-000000000000', name: 'Dot' };
        expect(dotSlug(dot)).toBe('dot-ab12cd');
        expect(appLabel('tracker', dot)).toBe('tracker--dot-ab12cd');
        const long = { id: dot.id, name: 'A very long Dot name indeed, yes' };
        expect(appLabel('a'.repeat(30), long).length).toBeLessThanOrEqual(63);
        expect(() => appLabel('xn', dot)).toThrow();
        // A label prefix shortens the Dot's name, never the app's or the id part.
        const full = appLabel('a'.repeat(30), long);
        expect(full).toHaveLength(63);
        const prefixed = appLabel('a'.repeat(30), long, 'app-');
        expect(`app-${prefixed}`).toHaveLength(63);
        expect(prefixed).toMatch(/^a{30}--[a-z0-9-]+-ab12cd$/);
        expect(appLabel('tracker', dot, 'app-')).toBe('tracker--dot-ab12cd');
        expect(() => appLabel('n--x', dot, 'x')).toThrow();
    });
});

describe('registration', () => {
    it('waits for approval under manual, then writes a scoped token file and starts the app', async () => {
        const f = await fixture({ personal: true });
        const dataset = f.platform.data.createDataset('alice', { name: 'Prices' });
        f.platform.data.setGrant('alice', { dotId: f.dot.id, datasetId: dataset.id, access: 'write' }, 'alice');
        const pending = await f.tools('alice').app_register({
            name: 'Tracker',
            port: 3000,
            datasets: ['Prices'],
            start_command: 'cd tracker && bun run server.ts',
        });
        expect(pending).toMatchObject({ status: 'pending_approval' });
        expect(f.platform.apps.all()).toEqual([]);
        const decided = (await (
            await f.api('alice', `/approvals/${(pending as { id: string }).id}/decision`, 'POST', {
                decision: 'approve',
            })
        ).json()) as ApprovalView;
        expect(decided.status).toBe('approved');
        const [app] = f.platform.apps.all();
        expect(app).toMatchObject({
            name: 'Tracker',
            slug: 'tracker',
            dotId: f.dot.id,
            ownerUserId: 'alice',
            port: 3000,
            datasets: [dataset.id, 'scratch'],
            sharedSpaceId: null,
            status: 'ephemeral',
        });
        expect(app.id).toBe(`tracker--${dotSlug(f.dot)}`);
        // The token file, then the start command sourcing it.
        expect(f.files).toHaveLength(1);
        expect(f.files[0].path).toBe(appEnvFile('tracker'));
        expect(f.files[0].path).toBe('.socio/apps/tracker.env');
        const contents = f.files[0].contents;
        expect(contents).toContain("PORT='3000'");
        expect(contents).toContain(`CB_APP_URL='${f.origin(app.id)}'`);
        expect(contents).toContain("CB_DATA_URL='http://company-brain-app:4310/api/data'");
        const token = /CB_DATA_TOKEN='([^']+)'/.exec(contents)![1];
        expect(f.platform.data.tokens.resolve(token)).toMatchObject({
            userId: 'alice',
            dotId: f.dot.id,
            purpose: 'app',
            session: `app:${app.id}`,
            datasetIds: [dataset.id, 'scratch'],
        });
        // Redacted from the computer's responses.
        expect(f.platform.dotExtensions.computer!.secrets!(f.dot.id)).toEqual([token]);
        expect(f.execs).toHaveLength(1);
        expect(f.execs[0]).toMatchObject({ actor: 'agent', userId: 'alice' });
        expect(f.execs[0].command).toContain('. ./.socio/apps/tracker.env');
        expect(f.execs[0].command).toContain(
            'setsid nohup sh -c \'cd -- "$HOME/shared" && cd tracker && bun run server.ts\'',
        );
        expect(f.execs[0].command).not.toContain(token);
        // The token works on the data API and only within its datasets.
        const listed = await f.app.request('http://company-brain-app:4310/api/data/datasets', {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(listed.status).toBe(200);
        const other = f.platform.data.createDataset('alice', { name: 'Other' });
        f.platform.data.setGrant('alice', { dotId: f.dot.id, datasetId: other.id, access: 'read' }, 'alice');
        const names = ((await listed.json()) as Array<{ name: string }>).map((item) => item.name);
        expect(names).toContain('Prices');
        const again = (await (
            await f.app.request('http://company-brain-app:4310/api/data/datasets', {
                headers: { Authorization: `Bearer ${token}` },
            })
        ).json()) as Array<{ name: string }>;
        expect(again.map((item) => item.name)).toContain('Prices');
        expect(again.map((item) => item.name)).not.toContain('Other');
    });

    it('registers at once under bypass and refuses what it must', async () => {
        const f = await fixture();
        const app = await f.register();
        expect(app.id).toMatch(/^tracker--sebas-/);
        const tools = f.tools('alice');
        expect(await tools.app_register({ name: 'Other', port: 3000 })).toMatchObject({
            error: expect.stringMatching(/port 3000/),
        });
        expect(await tools.app_register({ name: 'Open', port: 3001, public: true })).toMatchObject({
            error: expect.stringMatching(/Public/),
        });
        expect(await tools.app_register({ name: 'X', port: 3002, datasets: ['nope'] })).toMatchObject({
            error: expect.stringMatching(/No dataset/),
        });
        expect(await tools.app_register({ name: '!!!', port: 3003 })).toMatchObject({
            error: expect.stringMatching(/letters or digits/),
        });
        // Bob can't take over alice's name on the same Dot.
        await f.bypass('bob');
        expect(await f.tools('bob').app_register({ name: 'Tracker', port: 3005 })).toMatchObject({
            error: expect.stringMatching(/Another person/),
        });
        // Re-registering updates in place with a new token.
        const first = /CB_DATA_TOKEN='([^']+)'/.exec(f.files[0].contents)![1];
        await tools.app_register({ name: 'Tracker', port: 3009 });
        expect(f.platform.apps.all()).toHaveLength(1);
        expect(f.platform.apps.get(app.id)!.port).toBe(3009);
        expect(f.platform.data.tokens.resolve(first)).toBeUndefined();
        // A Dot whose computer is off can't publish.
        await f.workspace.computers.patch(f.dot.id, { enabled: false });
        expect(await tools.app_register({ name: 'Later', port: 3010 })).toMatchObject({
            error: expect.stringMatching(/turned off/),
        });
    });

    it.each([
        'stop',
        'status',
        'appTarget',
        'telemetry-absent',
        'telemetry-stopped',
        'telemetry-stats',
        'telemetry-unknown-network',
        'telemetry-unknown-schema',
        'telemetry-unknown-stats',
        'telemetry-unknown-foreign',
    ] as const)(
        'preserves or revokes real app/job leases from authoritative evidence through %s (CB-226/197)',
        async (operation) => {
            const f = await fixture();
            const dev = await f.register();
            const first = /CB_DATA_TOKEN='([^']+)'/.exec(f.files.at(-1)!.contents)![1];
            const promoted = await f.register({ name: 'Promoted', port: 3001 });
            f.platform.apps.endComputerServing(promoted.id);
            await f.platform.apps.setStatus(promoted.id, 'promoted');
            const tokens = f.platform.data.tokens;
            const runtime = tokens.issue({
                userId: 'alice',
                dotId: f.dot.id,
                purpose: 'app',
                appId: promoted.id,
                session: 'runtime:promoted-fixture',
            });
            const command = tokens.issue({
                userId: 'alice',
                dotId: f.dot.id,
                purpose: 'computer',
                session: 'computer:fixture',
            });
            const job = tokens.issue({
                userId: 'alice',
                dotId: f.dot.id,
                purpose: 'job',
                session: 'job:fixture',
            });
            const otherDot = f.workspace.createDot(f.dot.spaceId, 'Other', '', false, false);
            const other = tokens.issue({
                userId: 'alice',
                dotId: otherDot.id,
                purpose: 'job',
                session: 'job:other',
            });
            expect(tokens.resolve(first)).toBeDefined();
            const computers = new ComputerService(
                f.workspace,
                {
                    ...f.platform.config,
                    computerSupervisorUrl: 'http://supervisor.invalid',
                    computerSupervisorToken: 'fixture',
                    computerToken: 'fixture',
                },
                () => false,
                async (url) => {
                    if (operation === 'telemetry-unknown-network') {
                        throw Error('offline');
                    }
                    if (operation === 'telemetry-unknown-schema') {
                        return Response.json({ computers: 'invalid' });
                    }
                    const state = {
                        botId: f.dot.id,
                        container: `company-brain-computer-${f.dot.id}`,
                        status: operation === 'telemetry-stopped' ? 'exited' : 'running',
                        url: `http://company-brain-computer-${f.dot.id}:4100`,
                    };
                    if (String(url).endsWith('/stats')) {
                        return Response.json({
                            container: state.container,
                            instance: 'fixture',
                            botId: operation === 'telemetry-unknown-foreign' ? 'foreign' : f.dot.id,
                            running: false,
                            values: {
                                cpuPercent: null,
                                memoryBytes: operation === 'telemetry-unknown-stats' ? -1 : null,
                                memoryLimitBytes: null,
                                volumeBytes: null,
                            },
                        });
                    }
                    return Response.json({
                        computers: [
                            {
                                botId: otherDot.id,
                                container: `company-brain-computer-${otherDot.id}`,
                                status: 'running',
                                url: `http://company-brain-computer-${otherDot.id}:4100`,
                            },
                            ...(operation === 'telemetry-stopped' ||
                            operation === 'telemetry-stats' ||
                            operation.startsWith('telemetry-unknown-')
                                ? [state]
                                : []),
                        ],
                        stopped: true,
                    });
                },
                1000,
                f.platform.dotExtensions.computer,
            );
            if (operation === 'stop') {
                await computers.stop(f.dot.id, 'alice');
            } else if (operation === 'status') {
                expect((await computers.status(f.dot.id)).state).toBe('stopped');
            } else if (operation.startsWith('telemetry-')) {
                expect(await computers.resourceReadings()).toEqual([]);
            } else {
                expect((await computers.appTarget(f.dot.id, 3000)).state).toBe('stopped');
            }
            if (operation.startsWith('telemetry-unknown-')) {
                for (const token of [first, command, job, runtime, other]) {
                    expect(tokens.resolve(token)).toBeDefined();
                }
                return;
            }
            expect(tokens.resolve(first)).toBeUndefined();
            expect(tokens.resolve(command)).toBeUndefined();
            expect(tokens.resolve(job)).toBeUndefined();
            expect(tokens.resolve(runtime)).toBeDefined();
            expect(tokens.resolve(other)).toBeDefined();
            // Restart/provision gets a fresh lease, rather than reusing the revoked file/cache.
            await f.platform.apps.provision(dev);
            const replacement = /CB_DATA_TOKEN='([^']+)'/.exec(f.files.at(-1)!.contents)![1];
            expect(replacement).not.toBe(first);
            expect(tokens.resolve(replacement)).toBeDefined();
            expect(tokens.resolve(first)).toBeUndefined();
        },
    );

    it.each(['promote', 'unregister'] as const)(
        'never reissues a development lease from a stale record after %s (CB-226)',
        async (operation) => {
            const f = await fixture();
            const stale = await f.register();
            if (operation === 'promote') {
                f.platform.apps.endComputerServing(stale.id);
                await f.platform.apps.setStatus(stale.id, 'promoted');
            } else {
                await f.platform.apps.unregister(stale.id, 'alice');
            }
            const writes = f.files.length;
            const leases = f.platform.data.tokens.count();
            expect(await f.platform.apps.provision(stale, true)).toBe(false);
            expect(f.files.length).toBe(writes);
            expect(f.platform.data.tokens.count()).toBe(leases);
        },
    );

    it('reads computer app logs only through the authorized app identity', async () => {
        const f = await fixture();
        const app = await f.register();
        const action = vi.mocked(f.platform.computers.action);
        action.mockResolvedValue({ text: 'first\nsecond\nthird' });
        expect(await f.platform.apps.computerLog(app.id, 'alice', 2)).toEqual(['second', 'third']);
        expect(action).toHaveBeenLastCalledWith(
            app.dotId,
            'files_read',
            { path: `.socio/apps/${app.slug}.log` },
            'owner',
            undefined,
            'alice',
            { principal: { kind: 'app', id: app.id } },
        );
        action.mockClear();
        await expect(f.platform.apps.computerLog(app.id, 'bob')).rejects.toThrow();
        expect(action).not.toHaveBeenCalled();
    });

    it('lists and unregisters through the tools', async () => {
        const f = await fixture();
        const app = await f.register();
        const listed = (await f.tools('alice').app_list({})) as {
            apps: Array<Record<string, unknown>>;
        };
        expect(listed.apps).toEqual([
            expect.objectContaining({
                id: app.id,
                url: f.origin(app.id),
                computer: 'running',
                answering: true,
                identity: 'private app principal',
                logs: 'app_logs',
            }),
        ]);
        expect(((await f.tools('bob').app_list({})) as { apps: unknown[] }).apps).toEqual([]);
        expect(await f.tools('bob').app_unregister({ app: 'Tracker' })).toMatchObject({
            error: expect.stringMatching(/No app/),
        });
        expect(await f.tools('alice').app_unregister({ app: 'tracker' })).toMatchObject({ ok: true });
        expect(f.platform.apps.all()).toEqual([]);
        expect(((await f.tools('alice').app_list({})) as { apps: unknown[] }).apps).toEqual([]);
        // CB-64: kept, re-keyed, and stamped with the Dot that did it.
        const [record] = f.platform.apps.withDeleted(app.id);
        expect(record).toMatchObject({
            id: expect.stringMatching(/^deleted-/),
            deletedLabel: app.id,
            deletedBy: `dot:${app.dotId}`,
            name: 'Tracker',
        });
        expect(f.workspace.auditOf('app', record.id)).toMatchObject([{ actor: `dot:${app.dotId}`, action: 'delete' }]);
        // The address and the port are free again: the same app registers anew.
        const again = await f.register();
        expect(again.id).toBe(app.id);
        expect(f.platform.apps.all().map((item) => item.id)).toEqual([app.id]);
        expect(f.platform.apps.withDeleted(app.id)).toHaveLength(2);
    });

    it('hides the ephemeral apps of a deleted Dot with it, and keeps them (CB-64)', async () => {
        const f = await fixture();
        const app = await f.register();
        f.workspace.db.prepare("UPDATE dots SET deletedAt=1, deletedBy='alice' WHERE id=?").run(app.dotId);
        expect(await f.platform.apps.forgetDeletedDots()).toBe(1);
        expect(f.platform.apps.get(app.id)).toBeUndefined();
        expect(f.platform.apps.withDeleted(app.id)).toMatchObject([
            {
                deletedLabel: app.id,
                deletedBy: 'system',
                deletedWith: `dot:${app.dotId}`,
            },
        ]);
    });

    it('offers no tools and no approval when mini apps are off', async () => {
        const { workspace, platform, dispose } = await makeTestRuntime();
        cleanup.push(dispose);
        expect(platform.apps.enabled).toBe(false);
        expect(platform.approvals.capabilities().map((item) => item.id)).not.toContain('app.register');
        const dot = workspace.dots()[0];
        expect(
            appTools(platform.apps, {
                dot,
                userId: 'alice',
                threadId: 't',
                channel: false,
                purpose: 'chat',
                check: () => {},
                signal: new AbortController().signal,
                toolNames: () => [],
            }),
        ).toEqual([]);
    });
});

describe('a socio’s home page (CB-260)', () => {
    const home = async (f: Awaited<ReturnType<typeof fixture>>, userId: string, dotId = f.dot.id) => {
        const response = await f.api(userId, `/apps/dots/${dotId}`);
        return {
            status: response.status,
            body: (await response.json()) as DotAppsState & { error?: string },
        };
    };

    it('lists the apps this person may open, and nobody else’s', async () => {
        const f = await fixture();
        const tracker = await f.register();
        // Bob's own app on the same company socio, never shared.
        await f.bypass('bob');
        await f.tools('bob').app_register({ name: 'Notes', port: 3001 });
        const notes = f.platform.apps.all().find((app) => app.name === 'Notes')!;
        // Each owner sees their own; nobody sees the other's, admins included
        // (Alice is an operator), exactly as on the Apps page.
        expect((await home(f, 'alice')).body).toEqual({
            enabled: true,
            apps: [
                {
                    id: tracker.id,
                    name: 'Tracker',
                    description: '',
                    status: 'ephemeral',
                    owner: true,
                    sharedSpaceName: null,
                    liveVersion: null,
                    updatedAt: expect.any(Number),
                },
            ],
        });
        expect((await home(f, 'bob')).body.apps.map((app) => app.id)).toEqual([notes.id]);
        // Shared with a Space Bob is in: he sees it, as someone else's.
        const space = f.workspace.spaces()[0];
        await f.api('alice', `/apps/${tracker.id}`, 'PATCH', {
            sharedSpaceId: space.id,
        });
        const bob = (await home(f, 'bob')).body.apps;
        expect(bob.map((app) => app.id).sort()).toEqual([tracker.id, notes.id].sort());
        expect(bob.find((app) => app.id === tracker.id)).toEqual(
            expect.objectContaining({
                owner: false,
                ownerName: 'Alice',
                sharedSpaceName: space.name,
            }),
        );
        // What the home page lists is what /apps lists for this socio.
        const listed = (await (await f.api('bob', '/apps')).json()) as AppsState;
        expect(
            listed.apps
                .filter((app) => app.dotId === f.dot.id)
                .map((app) => app.id)
                .sort(),
        ).toEqual(bob.map((app) => app.id).sort());
        // Unshared again: gone from Bob's home page at once.
        await f.api('alice', `/apps/${tracker.id}`, 'PATCH', {
            sharedSpaceId: null,
        });
        expect((await home(f, 'bob')).body.apps.map((app) => app.id)).toEqual([notes.id]);
        // Another socio's page doesn't list this socio's apps.
        const other = f.workspace.createDot(f.dot.spaceId, 'Other', '', false, false);
        expect(await home(f, 'alice', other.id)).toEqual({
            status: 200,
            body: { enabled: true, apps: [] },
        });
        // An unknown socio is missing.
        expect((await home(f, 'alice', 'no-such-socio')).status).toBe(404);
    });

    it('lists for admins the apps they can’t open, by name and owner only, and opens nothing (CB-442)', async () => {
        const f = await fixture();
        const tracker = await f.register();
        // Another admin, who neither owns it nor reads a Space it is shared with.
        f.workspace.recordUser({ id: 'dana', name: 'Dana', role: 'admin' });
        expect(f.platform.apps.othersFor('dana')).toEqual([{ id: tracker.id, name: 'Tracker', ownerName: 'Alice' }]);
        expect(f.platform.apps.access('dana', f.platform.apps.get(tracker.id)!)).toBeUndefined();
        // Once shared with a Space Dana reads, she opens it: no longer an "other".
        await f.api('alice', `/apps/${tracker.id}`, 'PATCH', { sharedSpaceId: f.workspace.spaces()[0].id });
        expect(f.platform.apps.othersFor('dana')).toEqual([]);
        // The owner, an admin, has none; a member gets no such list at all.
        const alice = (await (await f.api('alice', '/apps')).json()) as AppsState;
        expect(alice.others).toEqual([]);
        await f.api('alice', `/apps/${tracker.id}`, 'PATCH', { sharedSpaceId: null });
        const bob = (await (await f.api('bob', '/apps')).json()) as AppsState;
        expect(bob.apps).toEqual([]);
        expect(bob.others).toBeUndefined();
        expect(f.platform.apps.othersFor('bob')).toBeUndefined();
    });

    it('keeps a personal socio’s apps to its owner, even when shared', async () => {
        const f = await fixture({ personal: true });
        const tracker = await f.register();
        await f.api('alice', `/apps/${tracker.id}`, 'PATCH', {
            sharedSpaceId: f.workspace.spaces()[0].id,
        });
        // Bob may open the shared app from the Apps page …
        const listed = (await (await f.api('bob', '/apps')).json()) as AppsState;
        expect(listed.apps.map((app) => app.id)).toEqual([tracker.id]);
        // … but Alice's personal socio has no home page for him, and the
        // answer says nothing about its apps.
        expect(await home(f, 'bob')).toEqual({
            status: 404,
            body: { error: 'Socio not found.' },
        });
        expect((await home(f, 'alice')).body.apps.map((app) => app.id)).toEqual([tracker.id]);
    });

    it('reads the registry only: no probe, no runtime call, no start', async () => {
        const f = await fixture({ upstream: false });
        const tracker = await f.register({ start_command: 'bun run server.ts' });
        await f.bypass('alice');
        await f.tools('alice').app_register({ name: 'Board', port: 3001 });
        const board = f.platform.apps.all().find((app) => app.name === 'Board')!;
        await f.platform.apps.setStatus(board.id, 'promoted');
        f.setTarget({ state: 'stopped' });
        const starts = f.starts.length;
        const execs = f.execs.length;
        const target = vi.spyOn(f.platform.apps, 'target');
        const probe = vi.spyOn(f.platform.apps, 'probe');
        const runtime = vi.spyOn(f.platform.apps.promotions, 'state');
        const attempts = vi.spyOn(f.platform.apps.promotions, 'lastAttempt');
        const { body } = await home(f, 'alice');
        expect(Object.fromEntries(body.apps.map((app) => [app.name, app.status]))).toEqual({
            Tracker: 'ephemeral',
            Board: 'promoted',
        });
        expect(body.apps[0]).not.toHaveProperty('computer');
        expect(body.apps[0]).not.toHaveProperty('runtime');
        expect(target).not.toHaveBeenCalled();
        expect(probe).not.toHaveBeenCalled();
        expect(runtime).not.toHaveBeenCalled();
        expect(attempts).not.toHaveBeenCalled();
        expect(f.starts.length).toBe(starts);
        expect(f.execs.length).toBe(execs);
        expect(f.platform.apps.get(tracker.id)!.status).toBe('ephemeral');
    });

    it('says mini apps are off, and still hides a socio it can’t see', async () => {
        const f = await fixture({ personal: true, appsEnv: { APPS_HOST: 'off' } });
        expect(f.platform.apps.enabled).toBe(false);
        expect(await home(f, 'alice')).toEqual({
            status: 200,
            body: { enabled: false, apps: [] },
        });
        expect((await home(f, 'bob')).status).toBe(404);
    });
});

describe('launch and sessions', () => {
    it('hands off with a one-time code and sets a host-only cookie', async () => {
        const f = await fixture();
        const app = await f.register();
        const { url, response, cookie } = await f.signIn('alice', app.id, '/reports?week=1');
        expect(url.startsWith(`${f.origin(app.id)}/__cb/auth?code=`)).toBe(true);
        expect(response.headers.get('location')).toBe('/reports?week=1');
        const set = response.headers.get('set-cookie')!;
        expect(set).toMatch(/^cb_app=/);
        expect(set).toContain('HttpOnly');
        expect(set).toContain('SameSite=Lax');
        expect(set).toContain('Path=/');
        expect(set).toMatch(/Max-Age=43200/);
        expect(set).not.toMatch(/Domain/i);
        expect(set).not.toContain('Secure');
        // Single use.
        const reused = await f.app.request(url);
        expect(reused.status).toBe(403);
        expect(reused.headers.get('set-cookie')).toBeNull();
        // The session works on this app's origin.
        const page = await f.app.request(`${f.origin(app.id)}/x`, {
            headers: { cookie },
        });
        expect(page.status).toBe(200);
    });

    it('refuses expired codes and codes for another app', async () => {
        const f = await fixture();
        const a = await f.register();
        const b = await f.register({ name: 'Board', port: 3001 });
        const launch = async () =>
            ((await (await f.api('alice', `/apps/${a.id}/launch`, 'POST', {})).json()) as { url: string }).url;
        // A code for app A redeemed on app B's host.
        const forA = new URL(await launch());
        const elsewhere = await f.app.request(`${f.origin(b.id)}/__cb/auth${forA.search}`);
        expect(elsewhere.status).toBe(403);
        // ...and it is spent, even on A.
        expect((await f.app.request(forA.toString())).status).toBe(403);
        // Past 60 seconds.
        const late = await launch();
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
        expect((await f.app.request(late)).status).toBe(403);
    });

    it('keeps an app cookie to its own app', async () => {
        const f = await fixture();
        const a = await f.register();
        const b = await f.register({ name: 'Board', port: 3001 });
        const { cookie } = await f.signIn('alice', a.id);
        const onB = await f.app.request(`${f.origin(b.id)}/`, {
            headers: { cookie, accept: 'text/html' },
        });
        expect(onB.status).toBe(302);
        expect(onB.headers.get('location')).toBe(`http://localhost:4310/apps/${b.id}/open?next=%2F`);
        const api = await f.app.request(`${f.origin(b.id)}/data`, {
            headers: { cookie },
        });
        expect(api.status).toBe(401);
    });

    it('lets the owner in, Space members once shared, and nobody else', async () => {
        const f = await fixture();
        const app = await f.register();
        // Bob doesn't see it or get a code.
        const listed = (await (await f.api('bob', '/apps')).json()) as AppsState;
        expect(listed.apps).toEqual([]);
        expect((await f.api('bob', `/apps/${app.id}/launch`, 'POST', {})).status).toBe(404);
        // Only the owner shares.
        const space = f.workspace.spaces()[0];
        expect(
            (
                await f.api('bob', `/apps/${app.id}`, 'PATCH', {
                    sharedSpaceId: space.id,
                })
            ).status,
        ).toBe(404);
        const shared = (await (
            await f.api('alice', `/apps/${app.id}`, 'PATCH', {
                sharedSpaceId: space.id,
            })
        ).json()) as AppView;
        expect(shared.sharedSpaceName).toBe(space.name);
        const bobView = (await (await f.api('bob', '/apps')).json()) as AppsState;
        expect(bobView.apps).toEqual([
            expect.objectContaining({
                id: app.id,
                owner: false,
                ownerName: 'Alice',
                startCommand: null,
                datasetNames: [],
            }),
        ]);
        const bob = await f.signIn('bob', app.id);
        const page = await f.app.request(`${f.origin(app.id)}/whoami`, {
            headers: { cookie: bob.cookie },
        });
        expect(page.status).toBe(200);
        const seen = f.upstream!.seen.at(-1)!;
        expect(seen.headers['x-cb-access']).toBe('space');
        expect(seen.headers['x-cb-user']).toBe(f.platform.apps.personId(app.id, 'bob'));
        expect(String(seen.headers['x-cb-user'])).not.toContain('bob');
        expect(f.platform.apps.personId(app.id, 'bob')).not.toBe(f.platform.apps.personId(app.id, 'alice'));
        // Someone the workspace doesn't know isn't a member.
        expect(f.platform.apps.access('mallory', f.platform.apps.get(app.id)!)).toBe(undefined);
        // Unsharing ends bob's session at once; alice keeps hers.
        const alice = await f.signIn('alice', app.id);
        await f.api('alice', `/apps/${app.id}`, 'PATCH', { sharedSpaceId: null });
        expect(
            (
                await f.app.request(`${f.origin(app.id)}/whoami`, {
                    headers: { cookie: bob.cookie },
                })
            ).status,
        ).toBe(401);
        expect(
            (
                await f.app.request(`${f.origin(app.id)}/whoami`, {
                    headers: { cookie: alice.cookie },
                })
            ).status,
        ).toBe(200);
    });

    it('rewrites the token file once a token is gone (a restart)', async () => {
        const f = await fixture();
        const app = await f.register();
        const { cookie } = await f.signIn('alice', app.id);
        const first = /CB_DATA_TOKEN='([^']+)'/.exec(f.files[0].contents)![1];
        f.platform.data.tokens.revokeSession(`app:${app.id}`);
        await Promise.all([
            f.app.request(`${f.origin(app.id)}/a`, { headers: { cookie } }),
            f.app.request(`${f.origin(app.id)}/b`, { headers: { cookie } }),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(f.files).toHaveLength(2);
        const second = /CB_DATA_TOKEN='([^']+)'/.exec(f.files[1].contents)![1];
        expect(second).not.toBe(first);
        expect(f.platform.data.tokens.resolve(second)).toMatchObject({
            purpose: 'app',
        });
        // Current tokens aren't written again.
        await f.app.request(`${f.origin(app.id)}/c`, { headers: { cookie } });
        expect(f.files).toHaveLength(2);
    });

    it('unregistering ends sessions, the token and the address', async () => {
        const f = await fixture();
        const app = await f.register();
        const { cookie } = await f.signIn('alice', app.id);
        const token = /CB_DATA_TOKEN='([^']+)'/.exec(f.files[0].contents)![1];
        expect(await f.platform.apps.sessionCount(app.id)).toBe(1);
        expect((await f.api('bob', `/apps/${app.id}`, 'DELETE')).status).toBe(404);
        expect((await f.api('alice', `/apps/${app.id}`, 'DELETE')).status).toBe(200);
        expect(await f.platform.apps.sessionCount(app.id)).toBe(0);
        expect(f.platform.data.tokens.resolve(token)).toBeUndefined();
        // The file in the computer is cleared too.
        expect(f.files.at(-1)!.contents).not.toContain(token);
        const gone = await f.app.request(`${f.origin(app.id)}/`, {
            headers: { cookie },
        });
        expect(gone.status).toBe(404);
        expect(await gone.text()).toContain('No app here');
    });
});

describe('proxy', () => {
    it('forwards without cookies or identity and passes the response back safely', async () => {
        const f = await fixture();
        const app = await f.register();
        const { cookie } = await f.signIn('alice', app.id);
        const main = await f.login('alice');
        const response = await f.app.request(`${f.origin(app.id)}/echo?q=1`, {
            method: 'POST',
            headers: {
                cookie: `${cookie}; ${main}; other=1`,
                'content-type': 'application/json',
                'x-forwarded-for': '203.0.113.9',
                'x-cb-user': 'forged',
                authorization: 'Bearer app-own',
            },
            body: JSON.stringify({ hello: 'world' }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            path: '/echo?q=1',
            body: '{"hello":"world"}',
        });
        const seen = f.upstream!.seen.at(-1)!;
        expect(seen.method).toBe('POST');
        expect(seen.headers.cookie).toBeUndefined();
        expect(seen.headers['x-forwarded-for']).toBeUndefined();
        expect(seen.headers['x-forwarded-host']).toBe(`${app.id}.apps.localhost:4310`);
        expect(seen.headers['x-forwarded-proto']).toBe('http');
        expect(seen.headers.host).toBe(`${app.id}.apps.localhost:4310`);
        expect(seen.headers['x-cb-user']).not.toBe('forged');
        expect(seen.headers['x-cb-access']).toBe('owner');
        expect(seen.headers.authorization).toBe('Bearer app-own');
        expect(JSON.stringify(seen.headers)).not.toContain('alice');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        // HTML: the app's own CSP stays, framing is refused, cookies are dropped.
        const html = await f.app.request(`${f.origin(app.id)}/html`, {
            headers: { cookie },
        });
        expect(await html.text()).toBe('<h1>Tracker</h1>');
        expect(html.headers.get('content-security-policy')).toBe("default-src 'self', frame-ancestors 'none'");
        expect(html.headers.get('set-cookie')).toBeNull();
        // A redirect to the computer's own address comes back on the app's.
        const moved = await f.app.request(`${f.origin(app.id)}/redirect`, {
            headers: { cookie },
        });
        expect(moved.status).toBe(302);
        expect(moved.headers.get('location')).toBe(`${f.origin(app.id)}/next?x=1`);
    });

    it('serves every path of the apps host itself, never the app’s routes', async () => {
        const f = await fixture();
        const app = await f.register();
        const { cookie } = await f.signIn('alice', app.id);
        const response = await f.app.request(`${f.origin(app.id)}/api/state`, {
            headers: { cookie },
        });
        expect(await response.json()).toEqual({ path: '/api/state', body: '' });
        // An unknown label or the bare apps host: the proxy's own 404.
        for (const host of [
            'http://nope--dot-000000.apps.localhost:4310/api/state',
            'http://apps.localhost:4310/api/state',
        ]) {
            const missing = await f.app.request(host, {
                headers: { cookie: await f.login('alice') },
            });
            expect(missing.status).toBe(404);
            expect(missing.headers.get('content-security-policy')).toContain("default-src 'none'");
        }
    });

    it('routes prefixed labels to apps when APPS_HOST is the app’s own host', async () => {
        const f = await fixture({
            appsEnv: { APPS_HOST: 'localhost', APPS_LABEL_PREFIX: 'app-' },
        });
        const app = await f.register();
        expect(app.id).toBe(`tracker--${dotSlug(f.dot)}`);
        expect(f.platform.apps.url(app)).toBe(`http://app-${app.id}.localhost:4310`);
        // Open: the launch hands off to the prefixed host, which proxies.
        const { cookie, url } = await f.signIn('alice', app.id);
        expect(new URL(url).host).toBe(`app-${app.id}.localhost:4310`);
        const proxied = await f.app.request(`http://app-${app.id}.localhost:4310/api/state`, { headers: { cookie } });
        expect(await proxied.json()).toEqual({ path: '/api/state', body: '' });
        expect(f.upstream!.seen.at(-1)!.headers.host).toBe(`app-${app.id}.localhost:4310`);
        const forwarded = f.upstream!.seen.length;
        // The same id without the prefix, or any other name: the proxy's 404.
        for (const host of [
            `http://${app.id}.localhost:4310/api/state`,
            'http://www.localhost:4310/api/state',
            'http://app-.localhost:4310/',
        ]) {
            const missing = await f.app.request(host, {
                headers: { cookie: await f.login('alice') },
            });
            expect(missing.status).toBe(404);
            expect(await missing.text()).toContain('No app here');
        }
        // The app's own host is the app, not the proxy.
        const main = await f.app.request('http://localhost:4310/api/state', {
            headers: { cookie: await f.login('alice') },
        });
        expect(main.status).toBe(200);
        expect(await main.json()).toHaveProperty('settings');
        expect(f.upstream!.seen).toHaveLength(forwarded);
    });

    it('refuses bodies over the limit', async () => {
        const f = await fixture();
        const app = await f.register();
        const { cookie } = await f.signIn('alice', app.id);
        const response = await f.app.request(`${f.origin(app.id)}/echo`, {
            method: 'POST',
            headers: {
                cookie,
                'content-length': String(11 * 1048576),
            },
            body: 'x',
        });
        expect(response.status).toBe(413);
    });

    it('sends people without a session to sign in on the app’s own origin', async () => {
        const f = await fixture();
        const app = await f.register();
        const response = await f.app.request(`${f.origin(app.id)}/a?b=c`, {
            headers: { 'sec-fetch-mode': 'navigate' },
        });
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe(`http://localhost:4310/apps/${app.id}/open?next=%2Fa%3Fb%3Dc`);
        expect(f.upstream!.seen).toEqual([]);
    });

    it('shows a stopped page with Start for the owner only, and starts', async () => {
        const f = await fixture();
        const app = await f.register({ start_command: 'bun run server.ts' });
        f.setTarget({ state: 'stopped' });
        const alice = await f.signIn('alice', app.id);
        const page = await f.app.request(`${f.origin(app.id)}/`, {
            headers: { cookie: alice.cookie },
        });
        expect(page.status).toBe(503);
        const text = await page.text();
        expect(text).toContain('This app’s computer is stopped');
        expect(text).toContain('action="/__cb/start"');
        expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
        await f.api('alice', `/apps/${app.id}`, 'PATCH', {
            sharedSpaceId: f.workspace.spaces()[0].id,
        });
        const bob = await f.signIn('bob', app.id);
        const bobPage = await (
            await f.app.request(`${f.origin(app.id)}/`, {
                headers: { cookie: bob.cookie },
            })
        ).text();
        expect(bobPage).toContain('Ask the app’s owner');
        expect(bobPage).not.toContain('/__cb/start');
        // Start: same origin only, owner only.
        const start = (cookie: string, origin?: string) =>
            f.app.request(`${f.origin(app.id)}/__cb/start`, {
                method: 'POST',
                headers: { cookie, ...(origin ? { origin } : {}) },
            });
        expect((await start(alice.cookie)).status).toBe(404);
        expect((await start(alice.cookie, 'http://evil.example')).status).toBe(404);
        expect((await start(bob.cookie, f.origin(app.id))).status).toBe(403);
        const execs = f.execs.length;
        const started = await start(alice.cookie, f.origin(app.id));
        expect(started.status).toBe(303);
        expect(f.starts).toEqual([`${f.dot.id}:alice`]);
        expect(f.execs.length).toBe(execs + 1);
        expect(f.execs.at(-1)).toMatchObject({ actor: 'owner', userId: 'alice' });
    });

    it('says so when the computer runs but the app doesn’t answer', async () => {
        const f = await fixture();
        const app = await f.register();
        const { cookie } = await f.signIn('alice', app.id);
        // A port nothing listens on.
        const idle = createServer();
        await new Promise<void>((ok) => idle.listen(0, '127.0.0.1', () => ok()));
        const port = (idle.address() as AddressInfo).port;
        await new Promise<void>((ok) => idle.close(() => ok()));
        f.setTarget({ state: 'running', host: '127.0.0.1', port });
        const page = await f.app.request(`${f.origin(app.id)}/`, {
            headers: { cookie },
        });
        expect(page.status).toBe(502);
        expect(await page.text()).toContain('isn’t answering');
    });

    it('proxies WebSocket upgrades from the app’s own origin only', async () => {
        const f = await fixture();
        const app = await f.register();
        const { cookie } = await f.signIn('alice', app.id);
        const main = await f.login('alice');
        const server = serve({
            fetch: f.app.fetch,
            hostname: '127.0.0.1',
            port: 0,
        });
        const upgrade = appsUpgrade(f.platform.apps);
        server.on('upgrade', (request, socket, head) => {
            if (!upgrade(request, socket, head)) {
                socket.destroy();
            }
        });
        await new Promise<void>((ok) => (server.listening ? ok() : server.once('listening', () => ok())));
        cleanup.push(
            () =>
                new Promise<void>((ok) => {
                    if ('closeAllConnections' in server) {
                        server.closeAllConnections();
                    }
                    server.close(() => ok());
                }),
        );
        const port = (server.address() as AddressInfo).port;
        const handshake = (headers: Record<string, string>) =>
            new Promise<{ head: string; socket: ReturnType<typeof connect> }>((resolve, reject) => {
                const socket = connect({ host: '127.0.0.1', port });
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
                socket.write(
                    `GET /ws HTTP/1.1\r\n${Object.entries({
                        host: `${app.id}.apps.localhost:4310`,
                        upgrade: 'websocket',
                        connection: 'Upgrade',
                        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
                        'sec-websocket-version': '13',
                        ...headers,
                    })
                        .map(([name, value]) => `${name}: ${value}`)
                        .join('\r\n')}\r\n\r\n`,
                );
            });
        const ok = await handshake({
            origin: f.origin(app.id),
            cookie: `${cookie}; ${main}`,
        });
        cleanup.push(() => ok.socket.destroy());
        expect(ok.head).toMatch(/^HTTP\/1\.1 101/);
        expect(ok.head.toLowerCase()).not.toContain('set-cookie');
        const upstream = f.upstream!.upgrades.at(-1)!;
        expect(upstream.cookie).toBeUndefined();
        expect(upstream['sec-websocket-key']).toBe('dGhlIHNhbXBsZSBub25jZQ==');
        expect(upstream['x-cb-access']).toBe('owner');
        const echoed = new Promise<string>((resolve) => ok.socket.once('data', (chunk) => resolve(chunk.toString())));
        ok.socket.write('ping');
        expect(await echoed).toBe('echo:ping');
        // Another origin, or no session: refused before the app sees anything.
        const count = f.upstream!.upgrades.length;
        const crossSite = await handshake({
            origin: 'http://evil.example',
            cookie,
        });
        expect(crossSite.head).toMatch(/^HTTP\/1\.1 403/);
        const anonymous = await handshake({ origin: f.origin(app.id) });
        expect(anonymous.head).toMatch(/^HTTP\/1\.1 401/);
        expect(f.upstream!.upgrades.length).toBe(count);
        // Unregistering closes the open socket.
        const closed = new Promise<void>((resolve) => ok.socket.once('close', () => resolve()));
        await f.api('alice', `/apps/${app.id}`, 'DELETE');
        await closed;
    });
});

describe('computer targets', () => {
    it('resolves an app port on the computer’s network host', async () => {
        const store = new Store(testDatabase());
        const workspace = new WorkspaceStore(testDatabase());
        cleanup.push(() => {
            store.close();
            workspace.close();
        });
        const id = workspace.dots()[0].id;
        let listing: Record<string, unknown> = {
            botId: id,
            container: `company-brain-computer-${id}`,
            status: 'running',
            url: `http://company-brain-computer-${id}:4100`,
        };
        const transport: typeof fetch = async () => Response.json({ computers: [listing] });
        const service = (supervisor = 'http://computer-supervisor:4300') =>
            new ComputerService(
                workspace,
                {
                    computerSupervisorUrl: supervisor,
                    computerSupervisorToken: 'supervisor-secret',
                    computerToken: 'master-secret',
                },
                () => false,
                transport,
            );
        expect(await service().appTarget(id, 3000)).toEqual({ state: 'disabled' });
        await workspace.computers.patch(id, { enabled: true });
        expect(await service().appTarget(id, 3000)).toEqual({
            state: 'running',
            host: `company-brain-computer-${id}`,
            port: 3000,
        });
        listing = { ...listing, status: 'stopped' };
        expect(await service().appTarget(id, 3000)).toEqual({ state: 'stopped' });
        listing = {
            botId: id,
            container: `company-brain-computer-${id}`,
            status: 'running',
            port: 41000,
        };
        expect(await service('http://127.0.0.1:4312').appTarget(id, 3000)).toEqual({
            state: 'unreachable',
        });
        listing = { ...listing, container: 'someone-else' };
        expect(await service().appTarget(id, 3000)).toEqual({
            state: 'unavailable',
        });
    });
});

it('a development app on a company computer cannot expose its owner’s private grants (CB-226)', async () => {
    const f = await fixture();
    const privateData = f.platform.data.createDataset('alice', {
        name: 'Private payroll',
    });
    f.platform.data.setGrant('alice', { dotId: f.dot.id, datasetId: privateData.id, access: 'write' }, 'alice');
    const app = await f.register({ datasets: ['Private payroll'] });
    const token = /CB_DATA_TOKEN='([^']+)'/.exec(f.files[0].contents)![1];
    expect(f.platform.data.tokens.resolve(token)?.reach).toBe('socio');
    const call = (path: string, tokenValue = token) =>
        f.app.request('http://company-brain-app:4310/api/data' + path, {
            headers: { Authorization: `Bearer ${tokenValue}` },
        });
    expect((await call(`/datasets/${privateData.id}`)).status).toBe(404);
    expect((await call('/files')).status).toBe(200);
    const rows = (await (await call('/datasets')).json()) as Array<{
        name: string;
    }>;
    expect(rows.map((row) => row.name)).not.toContain('Private payroll');
    // Even a previously-issued token with a person's reach is clamped at the API.
    const legacy = f.platform.data.tokens.issue({
        userId: 'alice',
        dotId: f.dot.id,
        purpose: 'app',
        session: 'legacy-app',
        datasetIds: [privateData.id, 'scratch'],
    });
    expect((await call(`/datasets/${privateData.id}`, legacy)).status).toBe(404);
    await f.api('alice', `/apps/${app.id}`, 'DELETE');
    expect((await call('/datasets')).status).toBe(401);
});
