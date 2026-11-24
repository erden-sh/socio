import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { signContextProof } from '@socio/foundation/actors/keys';
import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';
import type { DotTurn } from '@socio/foundation/turns/turn';
import type { AppAttemptsState, AppView, AppsState, PromotionPlan } from '@socio/shared/apps/app-types';
import type { WorkspaceState } from '@socio/shared/types';

import { socioApp } from '../packages/app-sdk/src/index.js';
import { runtimeApp } from '../src/apps-runtime/api.js';
import { runtimeConfigFromEnv } from '../src/apps-runtime/config.js';
import { ingressServer } from '../src/apps-runtime/ingress.js';
import { AppsSupervisor } from '../src/apps-runtime/supervisor.js';
import {
    AppsRuntimeClient,
    appsRuntimeFromEnv,
    RuntimeRefused,
    RuntimeUnavailable,
} from '../src/server/apps/runtime-client.js';
import { appTools } from '../src/server/apps/tools.js';
import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const SECRET = 'secret-0123456789abcdef-xyz';
const RUNTIME_TOKEN = 'runtime-token-0123456789abcdef';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** The app as the Dot writes it: a Node server (Bun in real life) on CB_SOCKET or PORT. */
const SERVER = (mark: string) => `
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const token = () => process.env.CB_DATA_TOKEN_FILE ? readFileSync(process.env.CB_DATA_TOKEN_FILE, 'utf8').trim() : process.env.CB_DATA_TOKEN;
const data = (path, body) => fetch(process.env.CB_DATA_URL + path, {
  method: body ? 'POST' : 'GET',
  headers: { authorization: 'Bearer ' + token(), ...(body ? { 'content-type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname === '/data') return json(await data('/datasets/' + (url.searchParams.get('ref') ?? 'scratch') + '/query', { sql: 'SELECT item, price FROM prices ORDER BY item' }));
  if (url.pathname === '/list') return json(await data('/datasets'));
  if (url.pathname === '/write') return json(await data('/datasets/scratch/tables/prices/rows', { rows: [{ item: 'new', price: 1 }] }));
  if (url.pathname === '/files') return json(await data('/files'));
  if (url.pathname === '/who') return json({ user: req.headers['x-cb-user'] ?? null, access: req.headers['x-cb-access'] ?? null, key: req.headers['x-cb-runtime-key'] ?? null, cookie: req.headers.cookie ?? null });
  json({ mark: '${mark}', path: url.pathname });
});
server.listen(process.env.CB_SOCKET ?? Number(process.env.PORT));
process.on('SIGTERM', () => process.exit(0));
`;

async function fixture(options: { runtime?: boolean; bundle?: Record<string, string>; company?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-promote-'));
    const workdir = join(dir, 'computer');
    mkdirSync(workdir, { recursive: true });
    const settings = appsSettingsFromEnv(options.bundle ?? {}, 'http://localhost:4310')!;
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            sessionSecret: SECRET,
            data: { userDataDir: join(dir, 'userdata'), apiUrl: 'http://app:4310' },
            apps: settings,
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
    // Alice's own socio by default: promotion moves her scratch (a company
    // socio's is its shared dataset, CB-337). `company`: the company socio.
    const home = workspace.dots()[0].spaceId;
    const dot = options.company
        ? workspace.dots()[0]
        : workspace.createDot(home, 'Helper', 'Helps.', false, false, [home], null, false, null, false, 'alice');
    await workspace.computers.patch(dot.id, {
        enabled: true,
        browser: true,
        files: true,
        shell: true,
    });
    // The Dot's computer: a local directory, commands run with sh in it (the
    // real computer caps output at 64 KB and says when it cut it).
    const execs: string[] = [];
    vi.spyOn(platform.computers, 'action').mockImplementation(async (_id, action, input) => {
        if (action !== 'exec') {
            throw new Error(`unexpected ${action}`);
        }
        const { command } = input as { command: string };
        execs.push(command);
        const result = spawnSync('sh', ['-c', command], {
            cwd: workdir,
            maxBuffer: 1 << 26,
        });
        const stdout = result.stdout.toString();
        return {
            exitCode: result.status ?? 1,
            stdout: stdout.slice(0, 65536),
            stderr: result.stderr.toString(),
            truncated: stdout.length > 65536,
        };
    });
    const written: string[] = [];
    vi.spyOn(platform.computers, 'writeFile').mockImplementation(async (_id, path, contents) => {
        written.push(path);
        mkdirSync(dirname(join(workdir, path)), { recursive: true });
        writeFileSync(join(workdir, path), contents);
    });
    vi.spyOn(platform.computers, 'start').mockResolvedValue({
        state: 'running',
    } as never);
    // An ephemeral app's computer target: nothing listens (it's promoted soon).
    platform.apps.useTargets(async () => ({ state: 'stopped' }));
    // The app on a port: the runtime's apps call its data API.
    const main = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((ok) => (main.listening ? ok() : main.once('listening', () => ok())));
    const mainPort = (main.address() as AddressInfo).port;
    let supervisor: AppsSupervisor | undefined;
    let runtimeServer: ReturnType<typeof serve> | undefined;
    let ingress: ReturnType<typeof ingressServer> | undefined;
    if (options.runtime !== false) {
        const config = runtimeConfigFromEnv({
            APPS_RUNTIME_TOKEN: RUNTIME_TOKEN,
            APPS_RUNTIME_DIR: join(dir, 'runtime'),
            APPS_RUNTIME_COMMAND: process.execPath,
            APPS_RUNTIME_START_SECONDS: '5',
            PATH: process.env.PATH,
            ...options.bundle,
        });
        supervisor = new AppsSupervisor(config, () => {});
        supervisor.init();
        runtimeServer = serve({
            fetch: runtimeApp(supervisor, RUNTIME_TOKEN, 32 * 1048576).fetch,
            hostname: '127.0.0.1',
            port: 0,
        });
        ingress = ingressServer(supervisor, RUNTIME_TOKEN);
        await new Promise<void>((ok) => ingress!.listen(0, '127.0.0.1', ok));
        await new Promise<void>((ok) =>
            runtimeServer!.listening ? ok() : runtimeServer!.once('listening', () => ok()),
        );
        platform.apps.useRuntime(
            new AppsRuntimeClient(
                appsRuntimeFromEnv(
                    {
                        APPS_RUNTIME_URL: `http://127.0.0.1:${(runtimeServer.address() as AddressInfo).port}`,
                        APPS_RUNTIME_TOKEN: RUNTIME_TOKEN,
                        APPS_RUNTIME_INGRESS_PORT: String((ingress.address() as AddressInfo).port),
                    },
                    `http://127.0.0.1:${mainPort}`,
                )!,
            ),
        );
    }
    cleanup.push(async () => {
        await supervisor?.stopAll();
        for (const server of [main, runtimeServer, ingress]) {
            if (server) {
                await new Promise<void>((ok) => {
                    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
                    server.close(() => ok());
                });
            }
        }
    });
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
    const tools = (userId = 'alice') =>
        Object.fromEntries(
            (
                appTools(platform.apps, turn(userId)) as unknown as Array<{
                    name: string;
                    execute: (input: unknown) => Promise<Record<string, unknown>>;
                }>
            ).map((tool) => [tool.name, tool.execute]),
        );
    const bypass = (capability: string, userId = 'alice') =>
        platform.approvals.setPolicy(userId, dot.id, capability, 'bypass');
    /** The Dot's scratch data: a prices table with two rows. */
    const seed = async (userId = 'alice') => {
        const actor = { kind: 'dot' as const, userId, dotId: dot.id };
        await platform.data.write(actor, undefined, {
            op: 'create_table',
            input: {
                table: 'prices',
                columns: [
                    { name: 'item', type: 'TEXT' },
                    { name: 'price', type: 'REAL' },
                ],
            },
        });
        await platform.data.write(actor, undefined, {
            op: 'create_table',
            input: { table: 'notes', columns: [{ name: 'text', type: 'TEXT' }] },
        });
        await platform.data.write(actor, undefined, {
            op: 'insert',
            table: 'prices',
            rows: [
                { item: 'apple', price: 2 },
                { item: 'pear', price: 3 },
            ],
        });
    };
    /** The app's files in the computer, and a registered ephemeral app. */
    const write = (path: string, contents: string) => {
        mkdirSync(dirname(join(workdir, path)), { recursive: true });
        writeFileSync(join(workdir, path), contents);
    };
    const register = async (name = 'Tracker', port = 3000) => {
        await bypass('app.register');
        write('tracker/server.mjs', SERVER('v1'));
        write('tracker/package.json', '{"name":"tracker","type":"module"}');
        write('tracker/.env', 'SECRET=never-packaged');
        write('tracker/node_modules/left-pad/index.js', 'module.exports = 1');
        write('tracker/README.md', '# Tracker');
        const result = await tools().app_register({ name, port });
        expect(result).toMatchObject({ status: 'approved' });
        return platform.apps.all().find((item) => item.name === name)!;
    };
    const pack = async (manifest: Record<string, unknown> = {}) =>
        tools().app_package({
            app: 'Tracker',
            dir: 'tracker',
            manifest: {
                entry: 'server.mjs',
                datasets: [{ id: 'scratch', access: 'write', tables: ['prices'] }],
                ...manifest,
            },
        });
    /** A session on the app's origin through the launch hand-off. */
    const signIn = async (userId: string, appId: string) => {
        const launched = await api(userId, `/apps/${appId}/launch`, 'POST', {});
        expect(launched.status).toBe(200);
        const { url } = (await launched.json()) as { url: string };
        const redeemed = await app.request(url);
        expect(redeemed.status).toBe(303);
        return redeemed.headers.get('set-cookie')!.split(';')[0];
    };
    const origin = (id: string) => `http://${id}.apps.localhost:4310`;
    const open = async (userId: string, appId: string, path = '/') =>
        app.request(`${origin(appId)}${path}`, {
            headers: {
                cookie: await signIn(userId, appId),
                accept: 'application/json',
            },
        });
    const view = async (userId: string, id: string) =>
        ((await (await api(userId, '/apps')).json()) as AppsState).apps.find((item) => item.id === id) as
            | AppView
            | undefined;
    return {
        platform,
        workspace,
        dot,
        app,
        api,
        tools,
        bypass,
        seed,
        write,
        register,
        pack,
        open,
        view,
        workdir,
        execs,
        written,
        supervisor,
        mainPort,
    };
}

const plan = async (f: Awaited<ReturnType<typeof fixture>>, id: string): Promise<PromotionPlan> =>
    (await (await f.api('alice', `/apps/${id}/promotion`)).json()) as PromotionPlan;

describe('packaging', () => {
    it('packages the source and lockfile from the computer, never node_modules or secrets', async () => {
        const f = await fixture();
        const tracker = await f.register();
        f.write('tracker/bun.lock', '{"lockfileVersion":1}');
        // Big enough to need several reads of the computer's 64 KB output.
        f.write('tracker/data.txt', randomBytes(90_000).toString('base64'));
        const packed = await f.pack();
        expect(packed).toMatchObject({ app: tracker.id, version: 1 });
        expect(f.execs.filter((command) => command.includes('base64 -w0')).length).toBeGreaterThan(1);
        const bundle = f.platform.apps.promotions.plan(tracker.id, 'alice');
        expect(bundle.files.map((file) => file.path).sort()).toEqual([
            'README.md',
            'bun.lock',
            'data.txt',
            'package.json',
            'server.mjs',
        ]);
        expect(f.platform.apps.get(tracker.id)!.status).toBe('packaged');
        // Sealed in the owner's data space, temporary files gone.
        const files = f.platform.data.listFiles({ kind: 'user', userId: 'alice' });
        expect(files.map((file) => file.path)).toEqual([`apps/${tracker.id}/bundles/v1.cbapp`]);
        expect(existsSync(join(f.workdir, '.socio/apps/tracker.pkg.tgz'))).toBe(false);
        // Globs narrow it; the entry and package files always go.
        const narrow = await f.tools().app_package({
            app: 'Tracker',
            dir: 'tracker',
            files: ['*.md'],
            manifest: { entry: 'server.mjs' },
        });
        expect(narrow).toMatchObject({ version: 2, files: 4 });
        expect((narrow.changes as string[]).join('\n')).toMatch(/Removed: data.txt/);
    });

    it('checks the manifest, the datasets and the caps', async () => {
        const f = await fixture({
            bundle: { APPS_BUNDLE_MAX_FILES: '3', APPS_BUNDLE_MAX_FILE_MB: '0.01' },
        });
        await f.register();
        expect(await f.pack({ entry: 'missing.mjs' })).toMatchObject({
            error: expect.stringMatching(/missing.mjs isn't in tracker/),
        });
        expect(await f.pack({ egress: ['10.0.0.1:443'] })).toMatchObject({
            error: expect.stringMatching(/Manifest: .*address/),
        });
        expect(await f.pack({ datasets: [{ id: 'not-mine', access: 'read' }] })).toMatchObject({
            error: expect.stringMatching(/No dataset "not-mine"/),
        });
        expect(
            await f.tools().app_package({
                app: 'Tracker',
                dir: '../etc',
                manifest: { entry: 'server.mjs' },
            }),
        ).toMatchObject({ error: expect.stringMatching(/relative directory/) });
        f.write('tracker/a.md', 'a');
        expect(await f.pack()).toMatchObject({
            error: expect.stringMatching(/at most 3 in a bundle/),
        });
        rmSync(join(f.workdir, 'tracker/a.md'));
        f.write('tracker/big.md', 'x'.repeat(20_000));
        expect(
            await f.tools().app_package({
                app: 'Tracker',
                dir: 'tracker',
                files: ['big.md'],
                manifest: { entry: 'server.mjs' },
            }),
        ).toMatchObject({ error: expect.stringMatching(/files are at most/) });
        expect(f.platform.apps.promotions.versions(f.platform.apps.all()[0].id)).toEqual([]);
    });
});

describe('promotion', () => {
    it('moves the scratch data into a new dataset, rewrites grants and serves the app from the runtime', async () => {
        const f = await f0();
        const tracker = await f.register();
        await f.seed();
        await f.pack();
        const wizard = await plan(f, tracker.id);
        expect(wizard).toMatchObject({
            runtime: true,
            promoted: false,
            version: { version: 1 },
            datasets: [
                {
                    ref: 'scratch',
                    access: 'write',
                    kind: 'scratch',
                    choices: ['move', 'share', 'keep'],
                    tableNames: ['notes', 'prices'],
                    tables: ['prices'],
                },
            ],
        });
        // Nothing moves without a choice.
        const none = await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [],
        });
        expect(none.status).toBe(400);
        expect(((await none.json()) as { error: string }).error).toMatch(/Choose what happens/);
        // Only the owner.
        expect(
            (
                await f.api('bob', `/apps/${tracker.id}/promote`, 'POST', {
                    version: 1,
                    datasets: [{ ref: 'scratch', choice: 'keep' }],
                })
            ).status,
        ).toBe(404);
        const promoted = await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [{ ref: 'scratch', choice: 'move', name: 'Prices' }],
        });
        expect(promoted.status).toBe(200);
        expect(((await promoted.json()) as { outcome: string }).outcome).toMatch(/runs in the workspace app runtime/);
        const app = f.platform.apps.get(tracker.id)!;
        expect(app).toMatchObject({ status: 'promoted', liveVersion: 1 });
        // The data moved: a new dataset with the prices, scratch without them.
        const datasets = f.platform.data.datasetsFor('alice');
        const moved = datasets.find((dataset) => dataset.name === 'Prices')!;
        expect(moved.createdByDotId).toBe(f.dot.id);
        expect(
            (
                await f.platform.data.query(
                    { kind: 'user', userId: 'alice' },
                    moved.id,
                    'SELECT count(*) AS n FROM prices',
                )
            ).rows,
        ).toEqual([[2]]);
        const scratch = datasets.find((dataset) => dataset.kind === 'scratch')!;
        expect(f.platform.data.detailFor('alice', scratch.id).tables.map((t) => t.name)).toEqual(['notes']);
        // The Dot keeps read access to what moved.
        expect(f.platform.data.grants('alice').find((grant) => grant.datasetId === moved.id)).toMatchObject({
            access: 'read',
            dotId: f.dot.id,
        });
        // Served from the runtime at the same address, through the proxy.
        const home = await f.open('alice', tracker.id);
        expect(home.status).toBe(200);
        expect(await home.json()).toMatchObject({ mark: 'v1' });
        // The app names its data "scratch" as before; it is the moved dataset now.
        const data = await (await f.open('alice', tracker.id, '/data')).json();
        expect(data).toMatchObject({
            status: 200,
            body: {
                columns: ['item', 'price'],
                rows: [
                    ['apple', 2],
                    ['pear', 3],
                ],
            },
        });
        // Its token sees its grants only: not the Dot's scratch, no files.
        const list = await (await f.open('alice', tracker.id, '/list')).json();
        expect(list.body.map((d: { name: string }) => d.name)).toEqual(['Prices']);
        expect((await (await f.open('alice', tracker.id, '/files')).json()).body).toEqual([]);
        // Headers: the person's opaque id, no cookie, no runtime key.
        const who = await (await f.open('alice', tracker.id, '/who')).json();
        expect(who).toMatchObject({ access: 'owner', key: null, cookie: null });
        expect(who.user).toMatch(/^[A-Za-z0-9_-]{22}$/);
        // The app's state: owners see versions, grants and the runtime.
        expect(await f.view('alice', tracker.id)).toMatchObject({
            status: 'promoted',
            runtime: 'running',
            liveVersion: 1,
            datasetNames: ['Prices (write)'],
        });
    });

    it('shares or keeps datasets as chosen, and writes go through without per-write approvals', async () => {
        const f = await f0();
        const tracker = await f.register();
        await f.seed();
        await f.pack();
        const space = f.workspace.spaces()[0];
        const promoted = await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [
                {
                    ref: 'scratch',
                    choice: 'share',
                    spaceId: space.id,
                    dotReads: false,
                },
            ],
        });
        expect(promoted.status).toBe(200);
        const shared = f.platform.data.datasetsFor('alice').find((dataset) => dataset.name === 'Tracker data')!;
        expect(shared.sharedSpaceId).toBe(space.id);
        expect(f.platform.data.grants('alice').some((grant) => grant.datasetId === shared.id)).toBe(false);
        // A promoted app writes its shared dataset: the promotion approved it.
        const wrote = await (await f.open('alice', tracker.id, '/write')).json();
        expect(wrote.status).toBe(200);
        expect(wrote.body.status).toBe('done');

        // Keep: the app uses the Dot's scratch dataset where it is.
        const g = await f0();
        const other = await g.register();
        await g.seed();
        await g.pack();
        expect(
            (
                await g.api('alice', `/apps/${other.id}/promote`, 'POST', {
                    version: 1,
                    datasets: [{ ref: 'scratch', choice: 'keep' }],
                })
            ).status,
        ).toBe(200);
        const scratch = g.platform.data.datasetsFor('alice').find((dataset) => dataset.kind === 'scratch')!;
        expect(g.platform.data.detailFor('alice', scratch.id).tables.map((t) => t.name)).toEqual(['notes', 'prices']);
        expect((await (await g.open('alice', other.id, '/data')).json()).body.rows).toHaveLength(2);
    });

    it('refuses sharing into a Space its owner only reads before any table moves (CB-451, review r2)', async () => {
        const f = await f0();
        const tracker = await f.register();
        await f.seed();
        await f.pack();
        const space = f.workspace.spaces()[0];
        // Alice reads the open Space but, here, doesn't edit it.
        vi.spyOn(f.workspace.spaceAccess, 'canEdit').mockImplementation((spaceId) => spaceId !== space.id);
        const refused = await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [{ ref: 'scratch', choice: 'share', spaceId: space.id, dotReads: false }],
        });
        expect(refused.status).toBe(403);
        expect(((await refused.json()) as { error: string }).error).toMatch(/editors/);
        // Nothing moved: the scratch dataset keeps both tables and its rows.
        const scratch = f.platform.data.datasetsFor('alice').find((dataset) => dataset.kind === 'scratch')!;
        expect(f.platform.data.detailFor('alice', scratch.id).tables.map((t) => t.name)).toEqual(['notes', 'prices']);
        expect(f.platform.data.rowsFor('alice', scratch.id, 'prices', 0, 10).rows).toHaveLength(2);
        expect(f.platform.data.datasetsFor('alice').some((dataset) => dataset.name === 'Tracker data')).toBe(false);
    });

    it('goes through an approval when the Dot proposes it, or bypass', async () => {
        const f = await f0();
        const tracker = await f.register();
        await f.seed();
        await f.pack();
        // A choice for every dataset, or nothing is asked.
        expect(await f.tools().app_promote({ app: 'Tracker', datasets: [] })).toMatchObject({
            error: expect.stringMatching(/Choose what happens/),
        });
        const pending = await f.tools().app_promote({
            app: 'Tracker',
            datasets: [{ id: 'scratch', choice: 'move', name: 'Prices' }],
        });
        expect(pending).toMatchObject({ status: 'pending_approval' });
        const card = await f.platform.approvals.get((pending as { id: string }).id, 'alice');
        expect(card.capability).toBe('app.promote');
        expect(card.details.join('\n')).toMatch(/move into a new dataset “Prices”/);
        expect(card.details.join('\n')).toMatch(/apps\?promote=/);
        // Nothing happened yet.
        expect(f.platform.apps.get(tracker.id)!.status).toBe('packaged');
        const decided = await f.platform.approvals.decide(card.id, 'alice', true);
        expect(decided.status).toBe('approved');
        expect(decided.outcome).toMatch(/Promoted “Tracker”/);
        expect(f.platform.apps.get(tracker.id)!.status).toBe('promoted');
        // A promoted app is no longer registered or unregistered like an ephemeral one.
        expect(await f.tools().app_register({ name: 'Tracker', port: 3001 })).toMatchObject({
            error: expect.stringMatching(/promoted/),
        });
        expect(await f.tools().app_unregister({ app: 'Tracker' })).toMatchObject({
            error: expect.stringMatching(/unpublish or delete/),
        });
        // Its port is free in the computer again.
        expect(await f.tools().app_register({ name: 'Other', port: 3000 })).toMatchObject({ status: 'approved' });
    });

    it('needs the runtime to promote', async () => {
        const f = await fixture({ runtime: false });
        const tracker = await f.register();
        await f.pack();
        expect((await plan(f, tracker.id)).runtime).toBe(false);
        const refused = await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [{ ref: 'scratch', choice: 'keep' }],
        });
        expect(refused.status).toBe(503);
    });
});

describe('promotion on a company socio (CB-354)', () => {
    /** Alice's app on the company socio, built on its shared dataset. */
    const companyFixture = async () => {
        const f = await fixture({ company: true });
        const tracker = await f.register();
        await f.seed();
        const actor = { kind: 'dot' as const, userId: 'alice', dotId: f.dot.id };
        await f.platform.data.write(actor, undefined, {
            op: 'create_index',
            table: 'prices',
            index: { name: 'prices_by_item', columns: ['item'] },
        });
        await f.pack();
        const shared = f.platform.data.sharedDatasetFor('alice', f.dot.id)!;
        return { f, tracker, shared };
    };
    const tablesOf = (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
        f.platform.data
            .detailFor('alice', id)
            .tables.map((t) => t.name)
            .sort();

    it('shows and moves the socio’s shared dataset, not the person’s own scratch', async () => {
        const { f, tracker, shared } = await companyFixture();
        // Chat writes on a company socio land in its shared dataset (CB-337).
        expect(shared.ownerUserId).toBe(`socio:${f.dot.id}`);
        expect(f.platform.data.scratch('alice', f.dot.id, false)).toBeUndefined();
        const wizard = await plan(f, tracker.id);
        expect(wizard.datasets).toMatchObject([
            {
                ref: 'scratch',
                kind: 'scratch',
                sharedArea: true,
                datasetId: shared.id,
                name: shared.name,
                choices: ['move', 'share', 'keep'],
                tableNames: ['notes', 'prices'],
                tables: ['prices'],
            },
        ]);
        const promoted = await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [{ ref: 'scratch', choice: 'move', name: 'Prices' }],
        });
        expect(promoted.status).toBe(200);
        // A workspace dataset, no person's, with the prices and their index
        // (CB-355); the shared dataset keeps only what didn't move.
        const moved = f.platform.data.datasetsFor('alice').find((dataset) => dataset.name === 'Prices')!;
        expect(moved).toMatchObject({
            ownerUserId: `socio:${f.dot.id}`,
            createdByDotId: f.dot.id,
            kind: 'dataset',
            scratchForDotId: null,
            access: 'read',
        });
        expect(f.platform.data.datasetsFor('alice').filter((dataset) => dataset.ownerUserId === 'alice')).toEqual([]);
        const detail = f.platform.data.detailFor('alice', moved.id);
        expect(detail.tables.map((t) => t.name)).toEqual(['prices']);
        expect(detail.tables[0].indexes).toEqual([{ name: 'prices_by_item', columns: ['item'], unique: false }]);
        expect(tablesOf(f, shared.id)).toEqual(['notes']);
        // The shared area records what left it, and for whom.
        const area = f.platform.data.sharedAreas('alice').find((item) => item.dotId === f.dot.id)!;
        expect(area.dataset!.tables.map((t) => t.name)).toEqual(['notes']);
        const audit = f.workspace.db
            .prepare(
                "SELECT ownerUserId, datasetId, detail FROM data_audit WHERE area=? AND action='move_tables' ORDER BY datasetId=?",
            )
            .all(`socio:${f.dot.id}`, moved.id) as Array<{ ownerUserId: string; datasetId: string; detail: string }>;
        expect(audit).toEqual([
            {
                ownerUserId: 'alice',
                datasetId: shared.id,
                detail: expect.stringMatching(/1 table\(s\) moved into the workspace dataset “Prices”: prices/),
            },
            { ownerUserId: 'alice', datasetId: moved.id, detail: expect.stringMatching(/1 table\(s\).*prices/) },
        ]);
        // The app reads its data where it went.
        const data = await (await f.open('alice', tracker.id, '/data')).json();
        expect(data).toMatchObject({
            status: 200,
            body: {
                rows: [
                    ['apple', 2],
                    ['pear', 3],
                ],
            },
        });
        expect(await f.view('alice', tracker.id)).toMatchObject({ datasetNames: ['Prices (write)'] });
    });

    it('keeps the app on the shared dataset when asked, and through a transfer (CB-360)', async () => {
        const { f, tracker, shared } = await companyFixture();
        const promoted = await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [{ ref: 'scratch', choice: 'keep' }],
        });
        expect(promoted.status).toBe(200);
        expect(tablesOf(f, shared.id)).toEqual(['notes', 'prices']);
        expect(f.platform.apps.promotions.grantsFor(tracker.id)).toEqual([
            { datasetId: shared.id, access: 'write', ref: 'scratch' },
        ]);
        expect(await f.view('alice', tracker.id)).toMatchObject({ datasetNames: [`${shared.name} (write)`] });
        // It reads and writes the shared dataset, and sees nothing else.
        expect((await (await f.open('alice', tracker.id, '/data')).json()).body.rows).toHaveLength(2);
        const wrote = await (await f.open('alice', tracker.id, '/write')).json();
        expect(wrote).toMatchObject({ status: 200, body: { status: 'done' } });
        const list = await (await f.open('alice', tracker.id, '/list')).json();
        expect(list.body.map((d: { id: string }) => d.id)).toEqual([shared.id]);
        // Moved to Bob with Alice's assets: still the socio's shared dataset.
        f.workspace.db.prepare("UPDATE apps SET ownerUserId='bob' WHERE id=?").run(tracker.id);
        await f.platform.apps.handedOver([tracker.id]);
        const rows = await (await f.open('bob', tracker.id, '/data')).json();
        expect(rows).toMatchObject({ status: 200 });
        expect(rows.body.rows).toHaveLength(3);
    });

    it('never gives a promoted app shared data its owner may not see (CB-229)', async () => {
        const { f, tracker, shared } = await companyFixture();
        // Say the app went to someone who never used the socio (CB-360).
        const hidden = vi.spyOn(f.platform.data, 'canSeeShared').mockReturnValue(false);
        const wizard = await plan(f, tracker.id);
        expect(wizard.datasets).toMatchObject([
            { sharedArea: true, datasetId: null, name: 'Shared scratch (not visible to you)', tableNames: [] },
        ]);
        for (const choice of ['keep', 'move'] as const) {
            const refused = await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
                version: 1,
                datasets: [{ ref: 'scratch', choice }],
            });
            expect(refused.status).toBe(403);
            expect(((await refused.json()) as { error: string }).error).toMatch(/can’t see .*shared data/);
        }
        // Nor through the socio's proposal.
        expect(
            await f.tools().app_promote({ app: 'Tracker', datasets: [{ id: 'scratch', choice: 'keep' }] }),
        ).toMatchObject({ error: expect.stringMatching(/can’t see/) });
        expect(f.platform.apps.get(tracker.id)!.status).toBe('packaged');
        expect(f.platform.apps.promotions.grantsFor(tracker.id)).toEqual([]);
        hidden.mockRestore();
        expect(tablesOf(f, shared.id)).toEqual(['notes', 'prices']);
    });

    it('starts the app on an empty dataset of the person’s when nothing is shared yet', async () => {
        const f = await fixture({ company: true });
        const tracker = await f.register();
        await f.pack({ datasets: [{ id: 'scratch', access: 'write' }] });
        const wizard = await plan(f, tracker.id);
        expect(wizard.datasets).toMatchObject([
            { kind: 'scratch', sharedArea: true, datasetId: null, tableNames: [], choices: ['move', 'share', 'keep'] },
        ]);
        expect(
            (
                await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
                    version: 1,
                    datasets: [{ ref: 'scratch', choice: 'move', name: 'Tracker data' }],
                })
            ).status,
        ).toBe(200);
        const moved = f.platform.data.datasetsFor('alice').find((dataset) => dataset.name === 'Tracker data')!;
        expect(moved.ownerUserId).toBe(`socio:${f.dot.id}`);
        expect(tablesOf(f, moved.id)).toEqual([]);
        expect(f.platform.data.scratch('alice', f.dot.id, false)).toBeUndefined();
    });

    /** Alice's pending `grant.change` cards. */
    const pendingGrants = async (f: Awaited<ReturnType<typeof fixture>>) =>
        (await f.platform.approvals.list('alice', { status: 'pending' })).filter(
            (card) => card.capability === 'grant.change',
        );

    it('lets the socio keep writing to the workspace dataset once a person approves, through a transfer', async () => {
        const { f, tracker } = await companyFixture();
        // Even with approvals bypassed, this one is always a person's card.
        await f.bypass('grant.change');
        const promoted = await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [{ ref: 'scratch', choice: 'move', name: 'Prices' }],
        });
        expect(promoted.status).toBe(200);
        expect(((await promoted.json()) as { outcome: string }).outcome).toMatch(
            /moved into the workspace dataset “Prices”.*can write to “Prices” once you approve its request/,
        );
        const moved = f.platform.data.datasetsFor('alice').find((dataset) => dataset.name === 'Prices')!;
        // The socio, in Alice's chat and on its computer: not yet.
        const chat = { kind: 'dot' as const, userId: 'alice', dotId: f.dot.id, threadId: 'thread' };
        const computer = { ...chat, threadId: undefined, reach: 'socio' as const };
        const sees = (actor: typeof chat | typeof computer) =>
            f.platform.data.list(actor).find((item) => item.id === moved.id);
        expect(sees(chat)).toBeUndefined();
        expect(sees(computer)).toBeUndefined();
        await expect(
            f.platform.data.write(chat, 'Prices', { op: 'insert', table: 'prices', rows: [{ item: 'fig', price: 4 }] }),
        ).rejects.toThrow(/No dataset "Prices"/);
        const [card] = await pendingGrants(f);
        expect(card).toMatchObject({
            dotId: f.dot.id,
            summary: expect.stringMatching(/write access to the workspace dataset “Prices”/),
        });
        await f.platform.approvals.decide(card.id, 'alice', true);
        // The grant is the socio's area's, not Alice's.
        expect(f.platform.data.grants('alice')).toEqual([]);
        expect(f.platform.data.grants(`socio:${f.dot.id}`)).toMatchObject([
            { dotId: f.dot.id, datasetId: moved.id, access: 'write', createdBy: 'approval' },
        ]);
        expect(sees(chat)).toMatchObject({ access: 'write' });
        expect(sees(computer)).toMatchObject({ access: 'write' });
        expect(
            await f.platform.data.write(chat, 'Prices', {
                op: 'insert',
                table: 'prices',
                rows: [{ item: 'fig', price: 4 }],
            }),
        ).toMatchObject({ status: 'done' });
        // Alice's data space moves to Bob (CB-360): the workspace dataset and
        // the socio's grant stay where they are.
        const handle = await f.platform.data.prepareTransfer({
            from: 'alice',
            to: 'bob',
            fromName: 'Alice',
            toName: 'Bob',
        });
        f.workspace.db.exec('BEGIN');
        handle.commit();
        f.workspace.db.exec('COMMIT');
        await handle.finish();
        f.workspace.db.prepare("UPDATE apps SET ownerUserId='bob' WHERE id=?").run(tracker.id);
        await f.platform.apps.handedOver([tracker.id]);
        expect(f.platform.data.detailFor('alice', moved.id).dataset.ownerUserId).toBe(`socio:${f.dot.id}`);
        expect(f.platform.data.grants(`socio:${f.dot.id}`)).toHaveLength(1);
        const rows = await (await f.open('bob', tracker.id, '/data')).json();
        expect(rows).toMatchObject({ status: 200 });
        expect(rows.body.rows).toHaveLength(3);
    });

    it('promotes another app of the socio on the workspace dataset, kept where it is', async () => {
        const { f, tracker } = await companyFixture();
        await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [{ ref: 'scratch', choice: 'move', name: 'Prices' }],
        });
        const moved = f.platform.data.datasetsFor('alice').find((dataset) => dataset.name === 'Prices')!;
        const [card] = await pendingGrants(f);
        await f.platform.approvals.decide(card.id, 'alice', true);
        // The socio builds a second app on the data it may now write.
        const ledger = await f.register('Ledger', 3001);
        expect(
            await f.tools().app_package({
                app: 'Ledger',
                dir: 'tracker',
                manifest: { entry: 'server.mjs', datasets: [{ id: moved.id, access: 'write' }] },
            }),
        ).not.toHaveProperty('error');
        const wizard = await plan(f, ledger.id);
        expect(wizard.datasets).toMatchObject([
            { ref: moved.id, datasetId: moved.id, kind: 'workspace', choices: ['keep'], tableNames: ['prices'] },
        ]);
        const promoted = await f.api('alice', `/apps/${ledger.id}/promote`, 'POST', {
            version: 1,
            datasets: [{ ref: moved.id, choice: 'keep' }],
        });
        expect(promoted.status).toBe(200);
        expect(f.platform.apps.promotions.grantsFor(ledger.id)).toEqual([
            { datasetId: moved.id, access: 'write', ref: moved.id },
        ]);
        const rows = await (await f.open('alice', ledger.id, `/data?ref=${moved.id}`)).json();
        expect(rows).toMatchObject({ status: 200 });
        expect(rows.body.rows).toHaveLength(2);
    });

    it('asks for nothing when the socio shouldn’t keep access, and shares with a Space at once', async () => {
        const { f, tracker } = await companyFixture();
        const space = f.workspace.spaces()[0];
        const promoted = await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [{ ref: 'scratch', choice: 'share', spaceId: space.id, name: 'Prices', dotReads: false }],
        });
        expect(promoted.status).toBe(200);
        const moved = f.platform.data.datasetsFor('alice').find((dataset) => dataset.name === 'Prices')!;
        expect(moved).toMatchObject({ ownerUserId: `socio:${f.dot.id}`, sharedSpaceId: space.id });
        expect(await pendingGrants(f)).toEqual([]);
        expect(f.platform.data.grants(`socio:${f.dot.id}`)).toEqual([]);
        // The app writes there with its own grant, approved with the promotion.
        expect((await (await f.open('alice', tracker.id, '/write')).json()).body).toMatchObject({ status: 'done' });
    });

    it('deletes the workspace dataset it brought when the app is deleted with its data', async () => {
        const { f, tracker, shared } = await companyFixture();
        await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [{ ref: 'scratch', choice: 'move', name: 'Prices' }],
        });
        const moved = f.platform.data.datasetsFor('alice').find((dataset) => dataset.name === 'Prices')!;
        const [card] = await pendingGrants(f);
        await f.platform.approvals.decide(card.id, 'alice', true);
        expect(f.platform.data.grants(`socio:${f.dot.id}`)).toHaveLength(1);
        const gone = await f.api('alice', `/apps/${tracker.id}/delete`, 'POST', { data: 'delete' });
        expect(await gone.json()).toMatchObject({ ok: true, deletedDatasets: ['Prices'] });
        // Hidden and kept (CB-64), with the app; the socio's grant ends with it.
        expect(f.platform.data.datasetsFor('alice').some((dataset) => dataset.id === moved.id)).toBe(false);
        const [retired] = f.platform.apps.withDeleted(tracker.id);
        expect(
            f.workspace.db
                .prepare('SELECT ownerUserId, deletedBy, deletedWith FROM data_datasets WHERE id=?')
                .get(moved.id),
        ).toMatchObject({ ownerUserId: `socio:${f.dot.id}`, deletedBy: 'alice', deletedWith: `app:${retired.id}` });
        expect(f.platform.data.grants(`socio:${f.dot.id}`)).toEqual([]);
        // The shared dataset stays: the app only used it.
        expect(tablesOf(f, shared.id)).toEqual(['notes']);
    });

    it('never deletes a workspace dataset with the shared area’s retention', async () => {
        const { f, tracker, shared } = await companyFixture();
        await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [{ ref: 'scratch', choice: 'move', name: 'Prices' }],
        });
        const moved = f.platform.data.datasetsFor('alice').find((dataset) => dataset.name === 'Prices')!;
        f.workspace.db.prepare('UPDATE data_datasets SET updatedAt=0 WHERE id IN (?, ?)').run(moved.id, shared.id);
        const limits = f.platform.data.limits;
        vi.spyOn(f.platform.data, 'limits', 'get').mockReturnValue({ ...limits, sharedRetentionDays: 1 });
        // The shared dataset goes; the workspace dataset stays.
        expect(await f.platform.data.applySharedRetention()).toBe(1);
        expect(f.platform.data.sharedDatasetFor('alice', f.dot.id)).toBeUndefined();
        expect(f.platform.data.datasetsFor('alice').map((dataset) => dataset.id)).toContain(moved.id);
    });
});

describe('versions, retirement and the launcher', () => {
    const promotedFixture = async () => {
        const f = await f0();
        const tracker = await f.register();
        await f.seed();
        await f.pack();
        await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [{ ref: 'scratch', choice: 'move', name: 'Prices' }],
        });
        return { f, id: tracker.id };
    };

    it('rolls out an approved update, keeps the previous version and rolls back', async () => {
        const { f, id } = await promotedFixture();
        f.write('tracker/server.mjs', SERVER('v2'));
        const packed = await f.pack({ egress: ['api.example.com:443'] });
        expect(packed).toMatchObject({ version: 2 });
        expect((packed.changes as string[]).join('\n')).toMatch(
            /New egress: api.example.com:443[\s\S]*Changed: server.mjs/,
        );
        const pending = await f.tools().app_update({ app: 'Tracker' });
        expect(pending).toMatchObject({ status: 'pending_approval' });
        const card = await f.platform.approvals.get((pending as { id: string }).id, 'alice');
        expect(card.details.join('\n')).toMatch(/New egress: api.example.com:443/);
        expect(card.details.join('\n')).toMatch(/kept for a rollback/);
        // Still v1 until approved.
        expect(await (await f.open('alice', id)).json()).toMatchObject({
            mark: 'v1',
        });
        await f.platform.approvals.decide(card.id, 'alice', true);
        expect(f.platform.apps.get(id)).toMatchObject({
            liveVersion: 2,
            previousVersion: 1,
        });
        expect(await (await f.open('alice', id)).json()).toMatchObject({
            mark: 'v2',
        });
        // Data stays where it was.
        expect((await (await f.open('alice', id, '/data')).json()).body.rows).toHaveLength(2);
        const rolled = await f.api('alice', `/apps/${id}/rollback`, 'POST', {});
        expect(rolled.status).toBe(200);
        expect(f.platform.apps.get(id)).toMatchObject({
            liveVersion: 1,
            previousVersion: 2,
        });
        expect(await (await f.open('alice', id)).json()).toMatchObject({
            mark: 'v1',
        });
        // Only owners roll back.
        expect((await f.api('bob', `/apps/${id}/rollback`, 'POST', {})).status).toBe(404);
    });

    it('keeps the live version when an update doesn’t start', async () => {
        const { f, id } = await promotedFixture();
        f.write('tracker/server.mjs', 'process.exit(2)');
        await f.pack();
        await f.bypass('app.update');
        const result = await f.tools().app_update({ app: 'Tracker' });
        expect(result).toMatchObject({ status: 'approved' });
        expect((result as { outcome: string }).outcome).toMatch(/didn’t start.*version 1 is still live/);
        expect(f.platform.apps.get(id)).toMatchObject({ liveVersion: 1 });
        expect(await (await f.open('alice', id)).json()).toMatchObject({
            mark: 'v1',
        });
    });

    it('says so when the live version doesn’t start again either', async () => {
        const { f, id } = await promotedFixture();
        f.write('tracker/server.mjs', SERVER('v2'));
        await f.pack();
        await f.bypass('app.update');
        vi.spyOn(f.platform.apps.promotions.runtime!, 'start').mockRejectedValue(
            new RuntimeRefused('It exited while starting.', 409),
        );
        const result = await f.tools().app_update({ app: 'Tracker' });
        const outcome = (result as { outcome: string }).outcome;
        expect(outcome).toMatch(
            /Version 2 didn’t start \(It exited while starting\.\), and version 1 didn’t start again either \(It exited while starting\.\): the app isn’t running/,
        );
        expect(outcome).not.toMatch(/still live/);
        expect(f.platform.apps.get(id)).toMatchObject({ liveVersion: 1 });
    });

    it('unpublishes (it stops, data stays) and publishes again', async () => {
        const { f, id } = await promotedFixture();
        const before = f.platform.data.datasetsFor('alice').length;
        const done = await f.api('alice', `/apps/${id}/unpublish`, 'POST', {});
        expect(done.status).toBe(200);
        expect(f.supervisor!.status(id).state).toBe('stopped');
        expect(f.platform.data.datasetsFor('alice')).toHaveLength(before);
        // Its address answers that it is unpublished; nobody can launch it.
        const page = await f.app.request(`http://${id}.apps.localhost:4310/`, {
            headers: { accept: 'application/json' },
        });
        expect(page.status).toBe(401);
        expect((await f.api('alice', `/apps/${id}/launch`, 'POST', {})).status).toBe(409);
        expect(((await (await f.api('alice', '/workspace')).json()) as WorkspaceState).workspaceApps).toEqual([]);
        const again = await f.api('alice', `/apps/${id}/publish`, 'POST', {});
        expect(again.status).toBe(200);
        expect(await (await f.open('alice', id)).json()).toMatchObject({
            mark: 'v1',
        });
    });

    it('deletes with or without its data, explicitly', async () => {
        const { f, id } = await promotedFixture();
        // Promoted apps aren't deleted without saying what happens to the data.
        expect((await f.api('alice', `/apps/${id}`, 'DELETE')).status).toBe(409);
        expect((await f.api('alice', `/apps/${id}/delete`, 'POST', {})).status).toBe(400);
        const kept = await f.api('alice', `/apps/${id}/delete`, 'POST', {
            data: 'keep',
        });
        expect(kept.status).toBe(200);
        expect(f.platform.apps.get(id)).toBeUndefined();
        expect(f.platform.data.datasetsFor('alice').some((d) => d.name === 'Prices')).toBe(true);
        // CB-64: hidden and kept, re-keyed so the address is free; its bundles
        // moved with it and were deleted with it (kept), its versions and
        // grants moved too.
        const [record] = f.platform.apps.withDeleted(id);
        expect(record).toMatchObject({
            id: expect.stringMatching(/^deleted-[0-9a-f-]{36}$/),
            deletedLabel: id,
            deletedBy: 'alice',
            status: 'promoted',
        });
        expect(f.platform.data.listFiles({ kind: 'user', userId: 'alice' }).map((file) => file.path)).toEqual([]);
        expect(
            f.workspace.db
                .prepare("SELECT path, deletedBy, deletedWith FROM data_files WHERE path LIKE 'apps/%'")
                .all()
                .map((row) => ({ ...row })),
        ).toEqual([
            {
                path: `apps/${record.id}/bundles/v1.cbapp`,
                deletedBy: 'alice',
                deletedWith: `app:${record.id}`,
            },
        ]);
        const rows = (table: string) =>
            f.workspace.db
                .prepare(`SELECT appId FROM ${table} WHERE appId IN (?, ?)`)
                .all(id, record.id)
                .map((row) => row.appId);
        expect(rows('app_versions')).toEqual([record.id]);
        expect(rows('app_grants').length).toBeGreaterThan(0);
        expect(new Set(rows('app_grants'))).toEqual(new Set([record.id]));
        expect(() => f.supervisor!.status(id)).toThrow(/not found/);

        const { f: g, id: other } = await promotedFixture();
        const gone = await g.api('alice', `/apps/${other}/delete`, 'POST', {
            data: 'delete',
        });
        expect(await gone.json()).toMatchObject({
            ok: true,
            deletedDatasets: ['Prices'],
        });
        expect(g.platform.data.datasetsFor('alice').some((d) => d.name === 'Prices')).toBe(false);
        // CB-64: hidden and kept, with the app it went with.
        const [retired] = g.platform.apps.withDeleted(other);
        expect(
            g.workspace.db
                .prepare("SELECT deletedBy, deletedWith FROM data_datasets WHERE name='Prices'")
                .all()
                .map((row) => ({ ...row })),
        ).toEqual([{ deletedBy: 'alice', deletedWith: `app:${retired.id}` }]);
        // The Dot's scratch dataset is never the app's to delete.
        expect(g.platform.data.datasetsFor('alice').some((d) => d.kind === 'scratch')).toBe(true);
    });

    it('lists promoted apps in the launcher for the owner and the Space’s members', async () => {
        const { f, id } = await promotedFixture();
        const entries = async (userId: string) =>
            ((await (await f.api(userId, '/workspace')).json()) as WorkspaceState).workspaceApps ?? [];
        expect(await entries('alice')).toEqual([
            expect.objectContaining({
                id,
                name: 'Tracker',
                owner: true,
                url: `http://${id}.apps.localhost:4310`,
            }),
        ]);
        expect(await entries('bob')).toEqual([]);
        const space = f.workspace.spaces()[0];
        await f.api('alice', `/apps/${id}`, 'PATCH', { sharedSpaceId: space.id });
        expect(await entries('bob')).toEqual([
            expect.objectContaining({
                id,
                owner: false,
                sharedSpaceName: space.name,
            }),
        ]);
        // Bob opens it; the app sees the space access, not the owner's.
        const who = await (await f.open('bob', id, '/who')).json();
        expect(who.access).toBe('space');
        // Bob can't manage it.
        expect((await f.api('bob', `/apps/${id}/unpublish`, 'POST', {})).status).toBe(404);
        expect((await f.api('bob', `/apps/${id}/logs`)).status).toBe(403);
        const logs = (await (await f.api('alice', `/apps/${id}/logs`)).json()) as {
            lines: string[];
        };
        expect(logs.lines.join('\n')).toMatch(/version 1 is up/);
        // An ephemeral app is not in the launcher.
        await f.tools().app_register({ name: 'Scratchpad', port: 3005 });
        expect((await entries('alice')).map((entry) => entry.name)).toEqual(['Tracker']);
    });

    it('starts promoted apps again after either side restarts', async () => {
        const { f, id } = await promotedFixture();
        // The runtime restarted: it knows nothing.
        await f.supervisor!.remove(id);
        f.platform.apps.promotions.forgetState(id);
        expect((await f.open('alice', id)).status).toBe(503);
        expect(await f.platform.apps.promotions.reconcile()).toBe(1);
        expect(await (await f.open('alice', id)).json()).toMatchObject({
            mark: 'v1',
        });
        // The app restarted: every token is gone; the runtime gets a new one.
        f.platform.data.tokens.revokeSession(`app:${id}`);
        const denied = await (await f.open('alice', id, '/data')).json();
        expect(denied.status).toBe(401);
        // The refused token names its app, which gets a new one at once
        // (CB-291); this app reads its token file again, so no restart.
        await vi.waitFor(async () => {
            expect((await (await f.open('alice', id, '/data')).json()).status).toBe(200);
        });
        expect(f.platform.apps.health.get(id)).toMatchObject({ state: 'recovering' });
        // Nothing to do when all is well.
        expect(await f.platform.apps.promotions.reconcile()).toBe(0);
    });

    it('restarts a running promoted app with its new owner’s data token after a transfer (CB-360)', async () => {
        const { f, id } = await promotedFixture();
        const tokens = (f.platform.apps.promotions as unknown as { tokens: Map<string, { token: string }> }).tokens;
        const old = tokens.get(id)!.token;
        expect(f.platform.data.tokens.resolve(old)).toMatchObject({ userId: 'alice' });
        const starts = vi.spyOn(AppsRuntimeClient.prototype, 'start');
        // What the transfer's commit did to the app (auth/accounts.ts).
        f.workspace.db.prepare("UPDATE apps SET ownerUserId='bob' WHERE id=?").run(id);
        expect(await f.platform.apps.handedOver([id, 'gone'])).toEqual([
            'App “Tracker” restarted: it acts for its new owner now.',
        ]);
        expect(starts).toHaveBeenCalledTimes(1);
        const fresh = tokens.get(id)!.token;
        expect(f.platform.data.tokens.resolve(old)).toBeUndefined();
        expect(f.platform.data.tokens.resolve(fresh)).toMatchObject({ userId: 'bob' });
        expect(await (await f.open('bob', id)).json()).toMatchObject({ mark: 'v1' });
        // Unpublished, it isn't started; its token still ends.
        expect((await f.api('bob', `/apps/${id}/unpublish`, 'POST', {})).status).toBe(200);
        f.workspace.db.prepare("UPDATE apps SET ownerUserId='alice' WHERE id=?").run(id);
        starts.mockClear();
        expect(await f.platform.apps.handedOver([id])).toEqual([]);
        expect(starts).not.toHaveBeenCalled();
        expect(tokens.has(id)).toBe(false);
    });

    it('notes a skipped restart when the runtime can’t be reached during a transfer (CB-360)', async () => {
        const { f, id } = await promotedFixture();
        const tokens = (f.platform.apps.promotions as unknown as { tokens: Map<string, { token: string }> }).tokens;
        const old = tokens.get(id)!.token;
        f.workspace.db.prepare("UPDATE apps SET ownerUserId='bob' WHERE id=?").run(id);
        vi.spyOn(f.platform.apps.promotions.runtime!, 'status').mockRejectedValue(new Error('connect ECONNREFUSED'));
        const starts = vi.spyOn(AppsRuntimeClient.prototype, 'start');
        expect(await f.platform.apps.handedOver([id])).toEqual([
            'App “Tracker”: restart skipped, the apps runtime couldn’t be reached; the app picks up the new owner’s token on its next start.',
        ]);
        expect(starts).not.toHaveBeenCalled();
        // Its old token ends all the same.
        expect(f.platform.data.tokens.resolve(old)).toBeUndefined();
        expect(tokens.has(id)).toBe(false);
    });

    it('doesn’t restart a moved app its new owner unpublished while the runtime answered (CB-360)', async () => {
        const { f, id } = await promotedFixture();
        const promotions = f.platform.apps.promotions;
        f.workspace.db.prepare("UPDATE apps SET ownerUserId='bob' WHERE id=?").run(id);
        const state = promotions.state.bind(promotions);
        vi.spyOn(promotions, 'state').mockImplementationOnce(async (app, fresh) => {
            const answer = await state(app, fresh);
            // Bob unpublishes it meanwhile.
            expect((await f.api('bob', `/apps/${id}/unpublish`, 'POST', {})).status).toBe(200);
            return answer;
        });
        const starts = vi.spyOn(AppsRuntimeClient.prototype, 'start');
        expect(await f.platform.apps.handedOver([id])).toEqual([]);
        expect(starts).not.toHaveBeenCalled();
        expect(f.platform.apps.get(id)).toMatchObject({ status: 'unpublished' });
    });

    it('starts a moved app again with its new owner’s token when the check began before the transfer (CB-360)', async () => {
        const { f, id } = await promotedFixture();
        const tokens = (f.platform.apps.promotions as unknown as { tokens: Map<string, { token: string }> }).tokens;
        const old = tokens.get(id)!.token;
        // The runtime restarted: the check starts it again, and reads its
        // status while the transfer commits.
        await f.supervisor!.remove(id);
        const status = AppsRuntimeClient.prototype.status;
        vi.spyOn(AppsRuntimeClient.prototype, 'status').mockImplementationOnce(async function (
            this: AppsRuntimeClient,
            appId: string,
        ) {
            const answer = await status.call(this, appId);
            f.workspace.db.prepare("UPDATE apps SET ownerUserId='bob' WHERE id=?").run(id);
            return answer;
        });
        await f.platform.apps.promotions.reconcile();
        const fresh = tokens.get(id)!.token;
        expect(fresh).not.toBe(old);
        expect(f.platform.data.tokens.resolve(fresh)).toMatchObject({ userId: 'bob' });
        // The token renewal reuses only a token of the current owner's.
        await f.platform.apps.promotions.reconcile();
        expect(tokens.get(id)!.token).toBe(fresh);
    });

    it('backs off from an app that doesn’t start, then leaves it to its owner', async () => {
        const { f, id } = await promotedFixture();
        const promotions = f.platform.apps.promotions;
        await f.supervisor!.remove(id);
        // The runtime answers, but every start fails (as with a 500).
        const start = vi
            .spyOn(promotions.runtime!, 'start')
            .mockRejectedValue(new RuntimeUnavailable('The runtime failed.'));
        vi.useFakeTimers({ toFake: ['Date'] });
        cleanup.push(() => vi.useRealTimers());
        const minute = 60_000;
        const tick = async (wait: number) => {
            vi.setSystemTime(Date.now() + wait);
            await promotions.reconcile();
            return start.mock.calls.length;
        };
        expect(await tick(0)).toBe(1);
        // 1 min, then 2, 4, 8 and 16 before the next tries.
        expect(await tick(minute / 2)).toBe(1);
        expect(await tick(minute / 2)).toBe(2);
        expect(await tick(minute)).toBe(2);
        expect(await tick(minute)).toBe(3);
        expect(await tick(3 * minute)).toBe(3);
        expect(await tick(minute)).toBe(4);
        expect(await tick(8 * minute)).toBe(5);
        expect(await tick(16 * minute)).toBe(6);
        // After 6 failures: no more tries, however long it waits.
        expect(await tick(60 * minute)).toBe(6);
        expect(await tick(24 * 60 * minute)).toBe(6);
        expect(f.platform.apps.health.get(id)).toMatchObject({
            state: 'failed',
            lastError: expect.stringMatching(/runtime failed/),
        });
        // The owner presses Start: the tick tries again from the start.
        await expect(promotions.ensureRunning(f.platform.apps.get(id)!)).rejects.toThrow(/runtime failed/);
        expect(await tick(0)).toBe(8);
        expect(await tick(0)).toBe(8);
        // Once it starts, all is well again.
        start.mockRestore();
        vi.setSystemTime(Date.now() + minute);
        expect(await promotions.reconcile()).toBe(1);
        expect(await (await f.open('alice', id)).json()).toMatchObject({
            mark: 'v1',
        });
    });

    it('repairs a promoted app that keeps crashing, boundedly, then tells admins once (CB-291)', async () => {
        const { f, id } = await promotedFixture();
        const promotions = f.platform.apps.promotions;
        const runtime = promotions.runtime!;
        const notices: unknown[] = [];
        f.platform.apps.useAdminNotices(async (notice) => void notices.push(notice));
        const up = (await runtime.status(id))!;
        // The runtime gave up on its crash restarts; each repair starts it, and it crashes again.
        vi.spyOn(runtime, 'status').mockResolvedValue({
            ...up,
            state: 'failed',
            error: 'Version 1 kept crashing; stopped after 5 restarts.',
        });
        const start = vi.spyOn(runtime, 'start').mockResolvedValue(up);
        vi.useFakeTimers({ toFake: ['Date'] });
        cleanup.push(() => vi.useRealTimers());
        const minute = 60_000;
        const tick = async (wait: number) => {
            vi.setSystemTime(Date.now() + wait);
            await promotions.reconcile();
            return start.mock.calls.length;
        };
        expect(await tick(0)).toBe(1);
        expect(f.platform.apps.health.get(id)).toMatchObject({
            state: 'recovering',
            attempts: 1,
            lastRecoveryReason: expect.stringMatching(/kept crashing/),
        });
        // Never a tight loop, even though each start succeeds.
        expect(await tick(0)).toBe(1);
        expect(await tick(minute)).toBe(2);
        expect(await tick(2 * minute)).toBe(3);
        expect(await tick(4 * minute)).toBe(4);
        expect(await tick(8 * minute)).toBe(5);
        expect(await tick(16 * minute)).toBe(6);
        for (let i = 0; i < 20; i++) {
            expect(await tick(30 * minute)).toBe(6);
        }
        expect(f.platform.apps.health.get(id)).toMatchObject({ state: 'failed', attempts: 6 });
        expect(notices).toHaveLength(1);
        const view = await f.view('alice', id);
        expect(view?.health).toMatchObject({ state: 'failed', escalatedAt: expect.any(Number) });
        // The check itself worked throughout.
        expect(f.platform.apps.healthSummary().check).toMatchObject({ failingSince: null, lastError: null });
        // A new live version that starts: the old repairs no longer apply.
        vi.mocked(runtime.status).mockRestore();
        start.mockRestore();
        vi.useRealTimers();
        f.write('tracker/server.mjs', SERVER('v2'));
        await f.pack();
        await f.bypass('app.update');
        expect(await f.tools().app_update({ app: 'Tracker' })).toMatchObject({ status: 'approved' });
        expect(f.platform.apps.get(id)).toMatchObject({ liveVersion: 2 });
        expect(f.platform.apps.health.get(id)).toMatchObject({ state: 'healthy', attempts: 0, lastError: null });
    });

    it('never starts a stale version when the owner acts while a repair waits on the runtime (CB-291)', async () => {
        const { f, id } = await promotedFixture();
        const promotions = f.platform.apps.promotions;
        const runtime = promotions.runtime!;
        const up = (await runtime.status(id))!;
        const failed = { ...up, state: 'failed' as const, error: 'Version 1 kept crashing.' };
        // The tick sees it failed; inside the repair, the runtime's status call hangs.
        let open!: () => void;
        const gate = new Promise<void>((resolve) => (open = resolve));
        let calls = 0;
        vi.spyOn(runtime, 'status').mockImplementation(async () => {
            calls++;
            if (calls === 2) {
                await gate;
            }
            return failed;
        });
        const start = vi.spyOn(runtime, 'start');
        const deploy = vi.spyOn(runtime, 'deploy');
        const tick = promotions.reconcile();
        await vi.waitFor(() => expect(calls).toBe(2));
        // The owner unpublishes it meanwhile.
        await promotions.unpublish(id, 'alice');
        open();
        await tick;
        expect(start).not.toHaveBeenCalled();
        expect(deploy).not.toHaveBeenCalled();
        expect(f.platform.apps.health.get(id)).toMatchObject({ attempts: 1 });
        // The repair let its lease go: nothing holds the app (a new claim can be made at once).
        expect(await f.platform.apps.health.begin(id, 'v1', 'check', Date.now() + 61_000)).toMatchObject({
            attempt: 2,
        });
    });

    it('shows when the check of promoted apps fails (CB-291)', async () => {
        const { f, id } = await promotedFixture();
        const promotions = f.platform.apps.promotions;
        vi.spyOn(promotions.runtime!, 'status').mockRejectedValue(new RuntimeUnavailable('connect ECONNREFUSED'));
        await promotions.reconcile();
        expect(f.platform.apps.healthSummary()).toMatchObject({
            check: { failingSince: expect.any(Number), lastError: expect.stringMatching(/ECONNREFUSED/) },
            unhealthy: [{ appId: id, state: 'degraded' }],
        });
        vi.mocked(promotions.runtime!.status).mockRestore();
        await promotions.reconcile();
        expect(f.platform.apps.healthSummary()).toMatchObject({
            check: { failingSince: null, lastError: null, lastOkAt: expect.any(Number) },
            unhealthy: [],
        });
    });

    it('combines apps into a new starting point in the Dot’s computer', async () => {
        const { f } = await promotedFixture();
        f.write('second/server.mjs', SERVER('second'));
        f.write('second/logo.png', '');
        writeFileSync(join(f.workdir, 'second/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]));
        await f.tools().app_register({ name: 'Second', port: 3001 });
        await f.tools().app_package({
            app: 'Second',
            dir: 'second',
            manifest: { entry: 'server.mjs', egress: ['api.example.com:443'] },
        });
        const result = await f.tools().app_combine({
            apps: ['Tracker', 'Second'],
            name: 'Dashboard',
        });
        expect(result).toMatchObject({
            dir: 'combined/dashboard',
            from: [
                { app: 'Tracker', version: 1 },
                { app: 'Second', version: 1 },
            ],
        });
        expect(readFileSync(join(f.workdir, 'combined/dashboard/tracker/server.mjs'), 'utf8')).toContain("mark: 'v1'");
        expect([...readFileSync(join(f.workdir, 'combined/dashboard/second/logo.png'))]).toEqual([
            0x89, 0x50, 0x4e, 0x47, 0, 0xff,
        ]);
        const summary = readFileSync(join(f.workdir, 'combined/dashboard/COMBINE.md'), 'utf8');
        expect(summary).toMatch(/## Second[\s\S]*Egress: api.example.com:443/);
        expect(await f.tools().app_combine({ apps: ['Tracker'], name: 'X' })).toMatchObject({
            error: expect.stringMatching(/2 to 6/),
        });
        // Only the user's own apps.
        expect(await f.tools('bob').app_combine({ apps: ['Tracker', 'Second'], name: 'X' })).toMatchObject({
            error: expect.stringMatching(/No app/),
        });
    });
});

describe('build and start logs (CB-146)', () => {
    /** A server that fails at once, with its own error on stderr. */
    const broken = (mark: string, code = 1) =>
        `console.log('songworld ${mark} loading'); console.error('Error: ${mark} cannot find module ./songs.ts'); process.exit(${code});`;
    type Logs = {
        attempt: {
            attempt: number;
            version: number;
            kind: string;
            state: string;
            exit: { reason: string; code: number | null; message: string } | null;
            startedAt: string;
            endedAt: string | null;
            log: string[];
        } | null;
        note?: string;
        attempts: Array<{ attempt: number; version: number; kind: string }>;
        error?: string;
    };
    const logs = async (
        f: Awaited<ReturnType<typeof fixture>>,
        input: Record<string, unknown> = {},
        userId = 'alice',
    ) => (await f.tools(userId).app_logs({ app: 'Tracker', ...input })) as Logs;

    it('gives each failed version its own error and exit reason, not an older version’s', async () => {
        const f = await f0();
        const tracker = await f.register();
        await f.seed();
        // Version 1 never starts (as Songworld's didn't).
        f.write('tracker/server.mjs', broken('v1'));
        await f.pack();
        const promoted = await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [{ ref: 'scratch', choice: 'keep' }],
        });
        expect(((await promoted.json()) as { outcome: string }).outcome).toMatch(/didn’t start yet.*app_logs/);
        // Version 2 fails differently; the update starts version 1 again.
        f.write('tracker/server.mjs', broken('v2', 2));
        await f.pack();
        await f.bypass('app.update');
        const update = (await f.tools().app_update({ app: 'Tracker' })) as {
            outcome: string;
        };
        expect(update.outcome).toMatch(
            /Version 2 didn’t start.*and version 1 didn’t start again either.*the app isn’t running\. See why with app_logs for version 2/,
        );
        const v2 = await logs(f, { version: 2 });
        expect(v2.attempt).toMatchObject({
            version: 2,
            kind: 'start',
            state: 'failed',
            exit: {
                reason: 'exit',
                code: 2,
                message: 'Version 2 exited while starting (code 2).',
            },
        });
        expect(v2.attempt!.log.join('\n')).toMatch(/err Error: v2 cannot find module/);
        expect(v2.attempt!.log.join('\n')).not.toMatch(/v1/);
        expect(Date.parse(v2.attempt!.endedAt!)).toBeGreaterThanOrEqual(Date.parse(v2.attempt!.startedAt));
        // The newest attempt is version 1's start again, with its own error;
        // the list says what happened in order.
        const latest = await logs(f);
        expect(latest.attempt).toMatchObject({ version: 1, kind: 'start' });
        expect(latest.attempt!.log.join('\n')).toMatch(/v1 cannot find/);
        expect(latest.attempt!.log.join('\n')).not.toMatch(/v2/);
        expect(latest.attempts.map((item) => `${item.attempt} ${item.kind} v${item.version}`)).toEqual([
            '5 start v1',
            '4 start v2',
            '3 build v2',
            '2 start v1',
            '1 build v1',
        ]);
        // One attempt by its number, and a tail.
        const first = await logs(f, { attempt: 2, lines: 1 });
        expect(first.attempt).toMatchObject({ attempt: 2, version: 1 });
        expect(first.attempt!.log).toHaveLength(1);
        // A version with no attempt yet, and one that doesn't exist.
        f.write('tracker/server.mjs', broken('v3'));
        await f.pack();
        expect(await logs(f, { version: 3 })).toMatchObject({
            attempt: null,
            note: expect.stringMatching(/Version 3 has no build or start log yet/),
        });
        expect(await logs(f, { version: 9 })).toMatchObject({
            attempt: null,
            note: "Version 9 doesn't exist.",
        });
        // The runtime restarted (it keeps nothing): the logs are still here.
        await f.supervisor!.remove(tracker.id);
        const kept = await logs(f, { version: 2 });
        expect(kept.attempt!.log.join('\n')).toMatch(/v2 cannot find module/);
        // The owner sees the same on the Apps page.
        const page = (await (
            await f.api('alice', `/apps/${tracker.id}/attempts?version=2`)
        ).json()) as AppAttemptsState;
        expect(page.attempt).toMatchObject({
            version: 2,
            reason: 'exit',
            exitCode: 2,
        });
        expect(page.attempts).toHaveLength(5);
        expect((await f.view('alice', tracker.id))!.lastAttempt).toMatchObject({
            attempt: 5,
            version: 1,
            state: 'failed',
        });
        // A promoted app's log is not a file in the computer.
        const listed = (await f.tools().app_list({})) as {
            apps: Array<Record<string, unknown>>;
        };
        expect(listed.apps[0]).toMatchObject({ logs: 'app_logs' });
        expect(listed.apps[0]).not.toHaveProperty('logFile');
    });

    it('captures a failed build like a failed start', async () => {
        const f = await f0();
        const tracker = await f.register();
        await f.seed();
        // This runtime installs nothing: dependencies fail the build.
        f.write('tracker/package.json', '{"name":"tracker","type":"module","dependencies":{"left-pad":"1.3.0"}}');
        f.write('tracker/bun.lock', '{"lockfileVersion":1}');
        await f.pack();
        const promoted = await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [{ ref: 'scratch', choice: 'keep' }],
        });
        expect(promoted.status).toBe(409);
        expect(f.platform.apps.get(tracker.id)!.status).toBe('packaged');
        const build = await logs(f);
        expect(build.attempt).toMatchObject({
            version: 1,
            kind: 'build',
            state: 'failed',
            exit: {
                reason: 'build',
                message: expect.stringMatching(/installs none/),
            },
        });
        expect(build.attempt!.log.join('\n')).toMatch(/building version 1/);
        expect((await f.view('alice', tracker.id))!.lastAttempt).toMatchObject({
            kind: 'build',
            state: 'failed',
        });
    });

    it('lets only who manages the app read its logs', async () => {
        const f = await f0();
        const tracker = await f.register();
        await f.seed();
        await f.pack();
        await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [{ ref: 'scratch', choice: 'keep' }],
        });
        // Shared with a Space: Bob opens it, but doesn't manage it.
        const space = f.workspace.spaces()[0];
        await f.api('alice', `/apps/${tracker.id}`, 'PATCH', {
            sharedSpaceId: space.id,
        });
        expect((await f.open('bob', tracker.id)).status).toBe(200);
        // A member who isn't the owner is refused, not told it doesn't exist
        // (CB-175); a missing app is still a 404.
        expect((await f.api('bob', `/apps/${tracker.id}/attempts`)).status).toBe(403);
        expect((await f.api('bob', `/apps/${tracker.id}/logs`)).status).toBe(403);
        expect((await f.api('bob', `/apps/nothing--dot-x/attempts`)).status).toBe(404);
        expect((await f.tools('bob').app_logs({ app: tracker.id })) as { error: string }).toMatchObject({
            error: expect.stringMatching(/owner and workspace admins/),
        });
        // By name, it isn't Bob's to find.
        expect((await logs(f, {}, 'bob')).error).toMatch(/No app "Tracker"/);
        expect((await f.view('bob', tracker.id))!.canReadLogs).toBe(false);
        // A workspace admin who isn't the owner reads them, by the app's id.
        f.workspace.recordUser({ id: 'carol', name: 'Carol', role: 'admin' });
        expect((await f.tools('carol').app_logs({ app: tracker.id })) as Logs).toMatchObject({
            attempt: expect.objectContaining({ state: 'running' }),
        });
        expect(f.platform.apps.logsOf(tracker.id, 'carol').id).toBe(tracker.id);
        expect(() => f.platform.apps.logsOf(tracker.id, 'bob')).toThrow(/owner and workspace admins/);
        expect((await f.view('bob', tracker.id))!.lastAttempt).toBeUndefined();
        // Another of Alice's Dots doesn't manage it either.
        const other = f.workspace.createDot(space.id, 'Other', 'Helps.', false, false);
        const tools = Object.fromEntries(
            (
                appTools(f.platform.apps, {
                    dot: other,
                    userId: 'alice',
                    threadId: 'thread',
                    channel: false,
                    purpose: 'chat',
                    check: () => {},
                    signal: new AbortController().signal,
                    toolNames: () => [],
                }) as unknown as Array<{
                    name: string;
                    execute: (input: unknown) => Promise<Record<string, unknown>>;
                }>
            ).map((tool) => [tool.name, tool.execute]),
        );
        expect(await tools.app_logs({ app: 'Tracker' })).toMatchObject({
            error: expect.stringMatching(/No app/),
        });
        // Its owner, and the Dot that built it for her, do.
        expect((await f.api('alice', `/apps/${tracker.id}/attempts`)).status).toBe(200);
        expect((await logs(f)).attempt).toMatchObject({ state: 'running' });
    });

    it('redacts the owner’s settings, the data token and credentials before anyone reads them', async () => {
        const f = await f0();
        const tracker = await f.register();
        await f.seed();
        f.write(
            'tracker/server.mjs',
            `console.log('key ' + process.env.SONG_API_KEY + ' token ' + process.env.CB_DATA_TOKEN + ' mode ' + process.env.MODE); console.log('Authorization: Bearer abc.def.ghi'); process.exit(1);`,
        );
        await f.pack({
            env: { SONG_API_KEY: 'The songs API key', MODE: 'Which mode' },
        });
        await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [{ ref: 'scratch', choice: 'keep' }],
            env: { SONG_API_KEY: 'songs-live-0123456789', MODE: 'production-eu' },
        });
        const text = (await logs(f)).attempt!.log.join('\n');
        // Secret settings go; ordinary ones stay readable.
        expect(text).toContain('key [redacted] token [redacted] mode production-eu');
        expect(text).toContain('Bearer [redacted]');
        expect(text).not.toContain('songs-live-0123456789');
        expect(text).not.toMatch(/cbdt_/);
        // What came in unredacted (an older runtime) is redacted on the way out.
        await f.platform.apps.promotions.attempts.sync(tracker.id, 'old-boot', [
            {
                id: 'old-runtime',
                version: 1,
                kind: 'start',
                state: 'failed',
                startedAt: Date.now() + 1000,
                upAt: null,
                endedAt: Date.now() + 1000,
                exit: {
                    reason: 'exit',
                    code: 1,
                    signal: null,
                    message: 'Failed with songs-live-0123456789.',
                },
                lines: ['err key songs-live-0123456789 password=hunter22 mode production-eu'],
                dropped: 0,
            },
        ]);
        const page = (await (
            await f.api('alice', `/apps/${tracker.id}/attempts?version=1`)
        ).json()) as AppAttemptsState;
        expect(page.attempt!.lines).toEqual(['err key [redacted] password=[redacted] mode production-eu']);
        expect(page.attempt!.message).toBe('Failed with [redacted].');
    });
    it('stores each start’s log as it happens, so a runtime restart before anyone reads it loses nothing', async () => {
        const f = await f0();
        const tracker = await f.register();
        await f.seed();
        f.write('tracker/server.mjs', broken('v1'));
        await f.pack();
        await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [{ ref: 'scratch', choice: 'keep' }],
        });
        // The runtime restarts at once: it keeps nothing.
        await f.supervisor!.remove(tracker.id);
        const kept = await logs(f, { version: 1 });
        expect(kept.attempt).toMatchObject({
            kind: 'start',
            state: 'failed',
            exit: { reason: 'exit', code: 1 },
        });
        expect(kept.attempt!.log.join('\n')).toMatch(/v1 cannot find module/);
    });

    it('copies crashes between starts on the minute tick, and marks what a restarted runtime lost', async () => {
        const f = await fixture({ bundle: { APPS_RUNTIME_MEMORY_MB: '16' } });
        const tracker = await f.register();
        await f.seed();
        await f.pack();
        await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [{ ref: 'scratch', choice: 'keep' }],
        });
        // Above its memory: killed and started again, between two starts.
        f.supervisor!.checkMemory();
        await expect
            .poll(
                () =>
                    f
                        .supervisor!.attempts(tracker.id)
                        .attempts.map((item) => item.state)
                        .join(' '),
                { timeout: 10_000, interval: 100 },
            )
            .toBe('succeeded failed running');
        await f.platform.apps.promotions.reconcile();
        // The runtime restarts before anyone reads the logs: a new run.
        await f.supervisor!.remove(tracker.id);
        Object.assign(f.supervisor!, { boot: 'next-boot' });
        expect(await logs(f, { attempt: 2 })).toMatchObject({
            attempt: { state: 'failed', exit: { reason: 'oom' } },
        });
        // It doesn't have the app (404): the running attempt stays as it was.
        expect((await logs(f, { attempt: 3 })).attempt).toMatchObject({
            state: 'running',
        });
        // Once it lists the app again without it, that attempt is lost.
        expect(await f.platform.apps.promotions.reconcile()).toBe(1);
        const lost = await logs(f, { attempt: 3 });
        expect(lost.attempt).toMatchObject({
            state: 'stopped',
            exit: {
                reason: 'lost',
                message: expect.stringMatching(/runtime restarted/),
            },
        });
    });

    it('shows an older runtime’s one log, and keeps what is stored', async () => {
        const f = await f0();
        const tracker = await f.register();
        await f.seed();
        await f.pack();
        await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [{ ref: 'scratch', choice: 'keep' }],
        });
        const runtime = f.platform.apps.promotions.runtime!;
        // As a runtime from before attempts answers: no such route.
        vi.spyOn(runtime, 'attempts').mockResolvedValue('unsupported');
        expect((await logs(f, { version: 1 })).attempt).toMatchObject({
            state: 'running',
        });
        const old = await logs(f, { version: 9 });
        expect(old).toMatchObject({
            attempt: null,
            note: expect.stringMatching(/older/),
        });
        expect((old as { runtimeLog?: string[] }).runtimeLog!.join('\n')).toMatch(/version 1 is up/);
    });

    it('moves a deleted app’s logs with it, so a new app at its address starts clean', async () => {
        const f = await f0();
        const tracker = await f.register();
        await f.seed();
        await f.pack();
        await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [{ ref: 'scratch', choice: 'keep' }],
        });
        const attempts = f.platform.apps.promotions.attempts;
        expect(await attempts.list(tracker.id)).toHaveLength(2);
        const deleted = await f.api('alice', `/apps/${tracker.id}/delete`, 'POST', {
            data: 'keep',
        });
        expect(deleted.status).toBe(200);
        expect(await attempts.list(tracker.id)).toEqual([]);
        const { id: retired } = (f.platform.apps as unknown as { db: DatabaseSync }).db
            .prepare('SELECT id FROM apps WHERE deletedLabel=?')
            .get(tracker.id) as { id: string };
        expect(await attempts.list(retired)).toHaveLength(2);
        // Nothing of it is remembered for the next app at its address.
        expect(
            (
                f.platform.apps.promotions as unknown as {
                    synced: Map<string, string>;
                }
            ).synced.has(tracker.id),
        ).toBe(false);
    });
});

/** A promoted app that shows what reached it (CB-232). */
const WHO_SERVER = `
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
const hash = (value) => value ? createHash('sha256').update(value).digest('hex') : null;
createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    actor: req.headers['x-cb-actor'] ?? null,
    user: req.headers['x-cb-user'] ?? null,
    authorization: req.headers.authorization ?? null,
    key: hash(process.env.CB_ACTOR_KEY),
    previous: hash(process.env.CB_ACTOR_KEY_PREVIOUS),
  }));
}).listen(process.env.CB_SOCKET ?? Number(process.env.PORT));
process.on('SIGTERM', () => process.exit(0));
`;

describe('socio access (CB-232)', () => {
    it('gives a promoted app its key and signed envelopes through the ingress, and ends grants on unpublish', async () => {
        // Socio sessions on the public host: the development switch;
        // deployments send them to the internal listener.
        vi.stubEnv('APPS_SOCIO_ON_PUBLIC_HOST', '1');
        cleanup.push(() => vi.unstubAllEnvs());
        const f = await f0();
        // socio-actor-access on for everyone (a CB-169 flag, dark by default).
        vi.spyOn(f.platform.flags, 'enabled').mockReturnValue(true);
        const tracker = await f.register();
        f.write('tracker/server.mjs', WHO_SERVER);
        const delegation = {
            contract: 1,
            actions: { 'dashboard.view': 'read' },
            public: [],
            alwaysAsk: false,
        };
        expect(await f.pack({ datasets: [], delegation })).toMatchObject({
            version: 1,
        });
        // The manifest refuses row ownership until it ships.
        expect(
            await f.pack({
                datasets: [],
                delegation: { ...delegation, ownerColumn: 'owner' },
            }),
        ).toMatchObject({ error: expect.stringMatching(/ownerColumn/) });
        const promoted = await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
            version: 1,
            datasets: [],
        });
        expect(promoted.status).toBe(200);
        const app = f.platform.apps.get(tracker.id)!;
        const key = f.platform.apps.actor.key(app).toString('base64url');
        const sha = (value: string) => createHash('sha256').update(value).digest('hex');
        const sdk = (k = key) =>
            socioApp({
                appId: tracker.id,
                key: k,
                actions: delegation.actions as never,
                env: {},
            });
        // A person: the envelope came through the ingress (signed, so it
        // passed), beside the legacy header; the app was started with its key.
        const seen = (await (await f.open('alice', tracker.id, '/who?x=1')).json()) as {
            actor: string;
            user: string;
            key: string;
            previous: string | null;
        };
        expect(seen.key).toBe(sha(key));
        expect(seen.user).toBe(f.platform.apps.personId(tracker.id, 'alice'));
        expect(sdk().verify({ method: 'GET', target: '/who?x=1', header: seen.actor })).toMatchObject({
            ok: true,
            principal: { person: seen.user, version: 1 },
        });
        // Its key isn't in what the runtime logged.
        const logs = await f.platform.apps.promotions.logs(app);
        expect(logs.join('\n')).not.toContain(key);

        // A socio acting for alice, from an app browser context.
        const chat = f.workspace.bindThread('chat-1', f.dot.id, 'Pipeline', 'alice');
        const audience = `app:${tracker.id}` as const;
        const policyVersion = await f.platform.actors.audiences.for(audience)!.policyVersion(audience);
        expect(policyVersion).toMatch(/^[0-9a-f]{64}$/);
        const grant = await f.platform.actors.grants.create({
            personId: 'alice',
            socioId: f.dot.id,
            audiences: [audience],
            scopes: ['app:read'],
            conversationId: chat.id,
            conversationKind: 'private',
            task: 'Check the chart',
            policyVersion: policyVersion!,
            approvedBy: 'alice',
            correlationId: 'test',
        });
        const context = await f.platform.actors.contexts.open({
            grant,
            kind: 'browser',
            audience,
            correlationId: 'test',
        });
        const { token } = await f.platform.actors.credentials.issue({
            grant,
            kind: 'cbsa',
            audiences: [audience],
            contextId: context.id,
            holder: { kind: 'context', id: context.id },
            correlationId: 'test',
        });
        const host = `${tracker.id}.apps.localhost:4310`;
        const socio = (await (
            await f.app.request(`http://${host}/who`, {
                headers: {
                    authorization: `Bearer ${token}`,
                    'x-cb-context': signContextProof(f.platform.actors.contextKey(context.id), {
                        method: 'GET',
                        host,
                        requestTarget: '/who',
                        bodyDigest: '',
                    }),
                },
            })
        ).json()) as {
            actor: string;
            user: string | null;
            authorization: string | null;
        };
        expect(socio.user).toBeNull();
        expect(socio.authorization).toBeNull();
        expect(sdk().verify({ method: 'GET', target: '/who', header: socio.actor })).toMatchObject({
            ok: true,
            principal: { socio: { scopes: ['app:read'] } },
        });

        // Unpublished: its grants end. Published again: a new key, and the
        // app has the previous one for its grace.
        expect((await f.api('alice', `/apps/${tracker.id}/unpublish`, 'POST', {})).status).toBe(200);
        expect(f.platform.actors.grants.get(grant.id)).toMatchObject({
            revokeReason: 'audience_unavailable',
        });
        expect((await f.api('alice', `/apps/${tracker.id}/publish`, 'POST', {})).status).toBe(200);
        const rotated = f.platform.apps.actor.key(f.platform.apps.get(tracker.id)!).toString('base64url');
        expect(rotated).not.toBe(key);
        const after = (await (await f.open('alice', tracker.id, '/who')).json()) as {
            actor: string;
            key: string;
            previous: string;
        };
        expect(after).toMatchObject({ key: sha(rotated), previous: sha(key) });
        expect(sdk().verify({ method: 'GET', target: '/who', header: after.actor })).toMatchObject({
            ok: false,
            reason: 'bad_mac',
        });
        expect(
            sdk(rotated).verify({
                method: 'GET',
                target: '/who',
                header: after.actor,
            }),
        ).toMatchObject({ ok: true });
    });
});

describe('socio sessions and private Spaces (CB-181 with CB-232)', () => {
    it('refuses the next proxied request once the socio may no longer read the app’s Space', async () => {
        // Socio sessions on the public host: the development switch;
        // deployments send them to the internal listener.
        vi.stubEnv('APPS_SOCIO_ON_PUBLIC_HOST', '1');
        cleanup.push(() => vi.unstubAllEnvs());
        const f = await fixture({ company: true });
        vi.spyOn(f.platform.flags, 'enabled').mockReturnValue(true);
        const tracker = await f.register();
        f.write('tracker/server.mjs', WHO_SERVER);
        expect(
            await f.pack({
                datasets: [],
                delegation: {
                    contract: 1,
                    actions: { 'dashboard.view': 'read' },
                    public: [],
                    alwaysAsk: false,
                },
            }),
        ).toMatchObject({ version: 1 });
        expect(
            (
                await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
                    version: 1,
                    datasets: [],
                })
            ).status,
        ).toBe(200);
        // Alice's app, shared with a private Space Bob is in; the company
        // socio has the Space, and acts for Bob in his own chat.
        const deals = (await (
            await f.api('alice', '/spaces', 'POST', {
                name: 'Deals',
                private: true,
                people: [{ userId: 'bob', role: 'member' }],
            })
        ).json()) as { id: string };
        expect(
            (
                await f.api('alice', `/apps/${tracker.id}`, 'PATCH', {
                    sharedSpaceId: deals.id,
                })
            ).status,
        ).toBe(200);
        const dot = f.workspace.dot(f.dot.id)!;
        const grantSpaces = (spaceIds: string[]) =>
            f.workspace.updateDot(
                dot.id,
                {
                    name: dot.name,
                    researchAllowed: dot.researchAllowed,
                    memoryAllowed: dot.memoryAllowed,
                    spaceIds,
                },
                'alice',
            );
        grantSpaces([dot.spaceId, deals.id]);
        const chat = f.workspace.bindThread('bob-chat', dot.id, 'Deals', 'bob');
        const audience = `app:${tracker.id}` as const;
        const grant = await f.platform.actors.grants.create({
            personId: 'bob',
            socioId: dot.id,
            audiences: [audience],
            scopes: ['app:read'],
            conversationId: chat.id,
            conversationKind: 'private',
            task: 'Check the chart',
            policyVersion: (await f.platform.actors.audiences.for(audience)!.policyVersion(audience))!,
            approvedBy: 'bob',
            correlationId: 'test',
        });
        const context = await f.platform.actors.contexts.open({
            grant,
            kind: 'browser',
            audience,
            correlationId: 'test',
        });
        const { token } = await f.platform.actors.credentials.issue({
            grant,
            kind: 'cbsa',
            audiences: [audience],
            contextId: context.id,
            holder: { kind: 'context', id: context.id },
            correlationId: 'test',
        });
        const host = `${tracker.id}.apps.localhost:4310`;
        const send = async () =>
            (
                await f.app.request(`http://${host}/who`, {
                    headers: {
                        authorization: `Bearer ${token}`,
                        'x-cb-context': signContextProof(f.platform.actors.contextKey(context.id), {
                            method: 'GET',
                            host,
                            requestTarget: '/who',
                            bodyDigest: '',
                        }),
                    },
                })
            ).status;
        expect(await send()).toBe(200);
        // The socio's grant of the Space ends: the next request is refused.
        grantSpaces([dot.spaceId]);
        expect(await send()).toBe(403);
        grantSpaces([dot.spaceId, deals.id]);
        expect(await send()).toBe(200);
        // Bob is taken out of the private Space: refused too.
        expect((await f.api('alice', `/spaces/${deals.id}/people/bob`, 'DELETE')).status).toBe(200);
        f.platform.actors.authorizer.invalidate();
        expect(await send()).toBe(403);
    });
});

/** A promoted app that writes through the data API on behalf of its request. */
const OBO_SERVER = `
import { createServer } from 'node:http';
const obo = (header) => {
  try { return JSON.parse(Buffer.from(String(header).split('.')[1], 'base64url').toString()).obo; } catch { return undefined; }
};
createServer(async (req, res) => {
  const on = obo(req.headers['x-cb-actor']);
  const answer = await fetch(process.env.CB_DATA_URL + '/datasets/scratch/tables/prices/rows', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + process.env.CB_DATA_TOKEN,
      'content-type': 'application/json',
      ...(on ? { 'x-cb-obo': on } : {}),
    },
    body: JSON.stringify({ rows: [{ item: 'by-socio', price: 9 }] }),
  });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: answer.status, obo: !!on }));
}).listen(process.env.CB_SOCKET ?? Number(process.env.PORT));
process.on('SIGTERM', () => process.exit(0));
`;

describe('socio access end to end, with the data API (CB-232)', () => {
    it('lets a write grant write through the app and refuses a read-only one at the data API', async () => {
        // Socio sessions on the public host: the development switch;
        // deployments send them to the internal listener.
        vi.stubEnv('APPS_SOCIO_ON_PUBLIC_HOST', '1');
        cleanup.push(() => vi.unstubAllEnvs());
        const f = await f0();
        vi.spyOn(f.platform.flags, 'enabled').mockReturnValue(true);
        const tracker = await f.register();
        await f.seed();
        f.write('tracker/server.mjs', OBO_SERVER);
        expect(
            await f.pack({
                delegation: {
                    contract: 1,
                    actions: { 'deal.update': 'write' },
                    public: [],
                    alwaysAsk: false,
                },
            }),
        ).toMatchObject({ version: 1 });
        expect(
            (
                await f.api('alice', `/apps/${tracker.id}/promote`, 'POST', {
                    version: 1,
                    datasets: [{ ref: 'scratch', choice: 'move', name: 'Prices' }],
                })
            ).status,
        ).toBe(200);
        const chat = f.workspace.bindThread('chat-1', f.dot.id, 'Pipeline', 'alice');
        const audience = `app:${tracker.id}` as const;
        const host = `${tracker.id}.apps.localhost:4310`;
        const asSocio = async (scopes: Array<'app:read' | 'app:write'>) => {
            const policyVersion = await f.platform.actors.audiences.for(audience)!.policyVersion(audience);
            const grant = await f.platform.actors.grants.create({
                personId: 'alice',
                socioId: f.dot.id,
                audiences: [audience],
                scopes,
                conversationId: chat.id,
                conversationKind: 'private',
                task: 'Update the prices',
                policyVersion: policyVersion!,
                approvedBy: 'alice',
                correlationId: 'test',
            });
            const context = await f.platform.actors.contexts.open({
                grant,
                kind: 'browser',
                audience,
                correlationId: 'test',
            });
            const { token } = await f.platform.actors.credentials.issue({
                grant,
                kind: 'cbsa',
                audiences: [audience],
                contextId: context.id,
                holder: { kind: 'context', id: context.id },
                correlationId: 'test',
            });
            return async () => {
                const answer = await f.app.request(`http://${host}/write`, {
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${token}`,
                        'x-cb-context': signContextProof(f.platform.actors.contextKey(context.id), {
                            method: 'POST',
                            host,
                            requestTarget: '/write',
                            bodyDigest: '',
                        }),
                    },
                });
                expect(answer.status).toBe(200);
                return (await answer.json()) as { status: number; obo: boolean };
            };
        };
        // Read-only: the app's token could write, but not on this request's behalf.
        const reader = await asSocio(['app:read']);
        expect(await reader()).toEqual({ status: 403, obo: true });
        const writer = await asSocio(['app:write']);
        expect(await writer()).toMatchObject({ obo: true });
        expect((await writer()).status).toBeLessThan(300);
        const moved = f.platform.data.datasetsFor('alice').find((dataset) => dataset.name === 'Prices')!;
        expect(
            (
                await f.platform.data.query(
                    { kind: 'user', userId: 'alice' },
                    moved.id,
                    "SELECT count(*) AS n FROM prices WHERE item='by-socio'",
                )
            ).rows,
        ).toEqual([[2]]);
        // The owner's own request carries their obo (an app session), which
        // keeps every operation the app has.
        const own = (await (await f.open('alice', tracker.id, '/write')).json()) as {
            status: number;
            obo: boolean;
        };
        expect(own.obo).toBe(true);
        expect(own.status).toBeLessThan(300);
    });
});

/** A fixture with the runtime (the default). */
const f0 = () => fixture();
