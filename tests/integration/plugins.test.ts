import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTableName } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { sqliteData } from '@socio/data/open';
import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';
import { withFrameSrc, CONTENT_SECURITY_POLICY } from '@socio/foundation/http/security-headers';
import { RUNTIME_HEADER_PLUGIN_PROOF } from '@socio/shared/apps/apps-runtime-types';
import { httpsUrlSchema } from '@socio/shared/https-url';
import { identitySecretName } from '@socio/shared/identity-delivery';
import { PLUGIN_ID, pluginServiceName } from '@socio/shared/plugins/plugin-service';
import {
    PLUGIN_SANDBOX,
    bridgeOrigin,
    parseHostToPlugin,
    parsePluginToHost,
    PLUGIN_ROUTE_MAX,
    pluginAddress,
    pluginAddressFor,
    pluginRoute,
    pluginRouteFromAddress,
    pluginRouteFromString,
    samePluginRoute,
} from '@socio/shared/plugins/plugins';
import { isAdmin } from '@socio/shared/roles';
import type { User } from '@socio/shared/types';

import { MemoryDocker } from '../../src/apps-runtime/docker.js';
import { SwarmIdentityDelivery } from '../../src/apps-runtime/identity-delivery.js';
import { pluginProof } from '../../src/apps-runtime/keys.js';
import { PluginServices } from '../../src/apps-runtime/services.js';
import { pluginSessionCookie } from '../../src/server/apps/proxy.js';
import { AppsRuntimeClient, RuntimeRefused, RuntimeUnavailable } from '../../src/server/apps/runtime-client.js';
import { accountLifecycle } from '../../src/server/auth/accounts.js';
import { catalogsFromEnv, loadCatalog, parseManifest } from '../../src/server/plugins/catalog.js';
import { pluginHash } from '../../src/server/plugins/infra/repository.js';
import { SqlitePlanner } from '../../src/server/plugins/planner/infra/repository.js';
import { plannedPosts, plannerVoice, replyQueue } from '../../src/server/plugins/planner/infra/schema.js';
import { socialStrategyManifest } from '../../src/server/plugins/planner/manifest.js';
import { renderPlanner } from '../../src/server/plugins/planner/render.js';
import { startPlanner } from '../../src/server/plugins/planner/server.js';
import { PluginService, safeNext } from '../../src/server/plugins/service.js';
import { staticAuth } from '../fixtures/static-auth.js';
import { testDatabase } from '../helpers/test-database.js';
import { makeTestRuntime } from '../helpers/test-runtime.js';

const SECRET = 'runtime-secret-runtime-secret-32';
const SERVICE = 'plugin-service-token-plugin-service-token';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const olga: User = { id: 'olga', name: 'Olga', role: 'admin' };
const bob: User = { id: 'bob', name: 'Bob', role: 'member' };
const PLANNER_SECRET = 'company_brain_plugin_service_token';
/** The planner's `bridge.open`: the only links its embed may open. */
const X_INTENTS = socialStrategyManifest.bridge!.open;

function host(
    users: () => User[] = () => [olga, bob],
    catalogs: ConstructorParameters<typeof PluginService>[1]['catalogs'] = [{ kind: 'bundled', id: 'social-strategy' }],
) {
    const db = testDatabase();
    cleanup.push(() => db.close());
    const engine = new MemoryDocker();
    engine.secrets.set(PLANNER_SECRET, 'secret-planner-1');
    const runtime = new PluginServices(engine, {
        allow: ['company-brain-plugin-'],
        maxReplicas: 5,
        secret: SECRET,
        pull: false,
        secretNames: new Set([PLANNER_SECRET]),
        identity: new SwarmIdentityDelivery(engine),
    });
    const settings = appsSettingsFromEnv({ APPS_HOST: 'apps.example' }, 'https://brain.example')!;
    const plugins = new PluginService(db, {
        catalogs,
        settings,
        runtimeToken: SECRET,
        ingress: { host: '127.0.0.1', port: 4331 },
        serviceToken: SERVICE,
        runtime: {
            provisionService: (id, spec, identity) => runtime.ensure(id, spec, identity),
            scaleService: (id, replicas) => runtime.scale(id, replicas),
            removeService: (id) => runtime.remove(id),
            serviceStatus: (id) => runtime.status(id),
        },
        parentOrigin: 'https://brain.example',
        users,
    });
    return { db, engine, plugins };
}

function toolNames() {
    const names: string[] = [];
    const server = {
        registerTool: (name: string) => names.push(name),
    } as unknown as McpServer;
    return { names, server };
}

it('offers only what PLUGIN_CATALOGS lists, bundled plugins included', () => {
    // No plugin is offered because this build ships it (CB-371): the
    // calendar too needs `bundled:calendar`. Offering is not installing.
    const CALENDAR = { kind: 'bundled', id: 'calendar' };
    expect(catalogsFromEnv({})).toEqual([]);
    expect(catalogsFromEnv({ PLUGIN_CATALOGS: '  ' })).toEqual([]);
    expect(catalogsFromEnv({ PLUGIN_CATALOGS: 'off' })).toEqual([]);
    expect(catalogsFromEnv({ PLUGIN_CATALOGS: 'bundled:social-strategy' })).toEqual([
        { kind: 'bundled', id: 'social-strategy' },
    ]);
    expect(catalogsFromEnv({ PLUGIN_CATALOGS: 'bundled:calendar,bundled:social-strategy' })).toEqual([
        CALENDAR,
        { kind: 'bundled', id: 'social-strategy' },
    ]);
    expect(catalogsFromEnv({ PLUGIN_CATALOGS: 'bundled:calendar' })).toEqual([CALENDAR]);
    // The deployment's lists decide where a catalog may run; Socio names no host.
    expect(
        catalogsFromEnv({
            PLUGIN_CATALOGS: 'bundled:social-strategy',
            APP_ORIGIN: 'https://tenant.example',
        }),
    ).toEqual([{ kind: 'bundled', id: 'social-strategy' }]);
    expect(() =>
        catalogsFromEnv({
            PLUGIN_CATALOGS: 'bundled:social-strategy',
            APP_ORIGIN: 'https://Tenant.Example/path',
            PLUGIN_CATALOG_HOSTS: 'planner.example',
        }),
    ).toThrow(/refused on tenant\.example: it is not in PLUGIN_CATALOG_HOSTS/);
    expect(
        catalogsFromEnv({
            PLUGIN_CATALOGS: 'bundled:social-strategy',
            APP_ORIGIN: 'https://planner.example',
            PLUGIN_CATALOG_HOSTS: ' Planner.Example , other.example',
        }),
    ).toEqual([{ kind: 'bundled', id: 'social-strategy' }]);
    expect(() =>
        catalogsFromEnv({
            PLUGIN_CATALOGS: 'file:/tmp/none.json',
            HOST: 'planner.example',
            PLUGIN_CATALOG_DENY_HOSTS: 'planner.example',
        }),
    ).toThrow(/refused on planner\.example: it is in PLUGIN_CATALOG_DENY_HOSTS/);
    expect(() =>
        catalogsFromEnv({
            PLUGIN_CATALOGS: 'bundled:social-strategy',
            APP_ORIGIN: 'https://planner.example',
            PLUGIN_CATALOG_HOSTS: 'planner.example',
            PLUGIN_CATALOG_DENY_HOSTS: 'planner.example',
        }),
    ).toThrow(/PLUGIN_CATALOG_DENY_HOSTS/);
    // Without PLUGIN_CATALOGS the lists change nothing: nothing is offered.
    expect(catalogsFromEnv({ PLUGIN_CATALOG_HOSTS: 'planner.example' })).toEqual([]);
    // `bundled:calendar` is a catalog the deployment set, so the lists apply.
    expect(() =>
        catalogsFromEnv({
            PLUGIN_CATALOGS: 'bundled:calendar',
            HOST: 'planner.example',
            PLUGIN_CATALOG_DENY_HOSTS: 'planner.example',
        }),
    ).toThrow(/PLUGIN_CATALOG_DENY_HOSTS/);
    expect(() => catalogsFromEnv({ PLUGIN_CATALOGS: 'bundled:missing' })).toThrow(/Unknown bundled plugin/);
    // `-bundled:<id>` is still accepted (it stopped the calendar's default
    // offer before CB-371); with no default offers it takes nothing away.
    expect(catalogsFromEnv({ PLUGIN_CATALOGS: '-bundled:calendar' })).toEqual([]);
    expect(catalogsFromEnv({ PLUGIN_CATALOGS: ' -bundled:calendar , file:/run/catalog.json ' })).toEqual([
        { kind: 'file', path: '/run/catalog.json' },
    ]);
    expect(catalogsFromEnv({ PLUGIN_CATALOGS: 'bundled:social-strategy,-bundled:calendar' })).toEqual([
        { kind: 'bundled', id: 'social-strategy' },
    ]);
    expect(catalogsFromEnv({ PLUGIN_CATALOGS: '-bundled:social-strategy' })).toEqual([]);
    expect(() => catalogsFromEnv({ PLUGIN_CATALOGS: '-bundled:missing' })).toThrow(/Unknown bundled plugin "missing"/);
    expect(() => catalogsFromEnv({ PLUGIN_CATALOGS: '-bundled:' })).toThrow(/Unknown bundled plugin/);
    expect(() => catalogsFromEnv({ PLUGIN_CATALOGS: 'bundled:calendar,-bundled:calendar' })).toThrow(
        /both lists and excludes "calendar"/,
    );
    expect(() => catalogsFromEnv({ PLUGIN_CATALOGS: '-file:/run/catalog.json' })).toThrow(/must be bundled:<id>/);
    // Only taking offers away: the host lists do not apply. Adding still checks them.
    expect(
        catalogsFromEnv({
            PLUGIN_CATALOGS: '-bundled:calendar',
            HOST: 'planner.example',
            PLUGIN_CATALOG_DENY_HOSTS: 'planner.example',
        }),
    ).toEqual([]);
    expect(() =>
        catalogsFromEnv({
            PLUGIN_CATALOGS: '-bundled:calendar,file:/run/catalog.json',
            HOST: 'planner.example',
            PLUGIN_CATALOG_DENY_HOSTS: 'planner.example',
        }),
    ).toThrow(/PLUGIN_CATALOG_DENY_HOSTS/);
    const dir = mkdtempSync(join(tmpdir(), 'cb-plugins-'));
    const file = join(dir, 'catalog.json');
    writeFileSync(
        file,
        JSON.stringify({
            plugins: [
                {
                    ...socialStrategyManifest,
                    name: 'Replaced',
                    service: {
                        ...socialStrategyManifest.service!,
                        image: `company-brain-plugin-social-strategy@sha256:${'ab'.repeat(32)}`,
                    },
                },
            ],
        }),
    );
    expect(() => loadCatalog([{ kind: 'file', path: file }])).toThrow(/already ships/);
});

it('installs the planner as a service, signs in without affinity, and keeps rows on uninstall', async () => {
    const { db, engine, plugins } = host();
    const tables = () =>
        db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .all()
            .map((row) => String((row as { name: string }).name));
    expect(tables()).not.toContain('planned_posts');
    expect(plugins.launcher(olga)).toEqual([]);
    expect(plugins.embedOrigin('/plugins/social-strategy')).toBeUndefined();

    await plugins.install('social-strategy');
    expect(engine.services.size).toBe(1);
    expect(tables()).toContain('planned_posts');
    expect(plugins.embedOrigin('/plugins/social-strategy')).toBe('https://social-strategy.apps.example');
    // The whole address is the plugin's (CB-446): every page under it frames
    // the plugin, matched as the router matches `plugins/:pluginId/*`. The
    // platform's own pages live elsewhere, so none of them gets it.
    for (const path of [
        '/plugins/social-strategy/',
        '/plugins/social-strategy/posts/p1',
        '/plugins/social-strategy/open',
        '/plugins/social-strategy/open/',
        '/plugins/social-strategy/open//',
        '/plugins/social-strategy/manage',
        '/plugins/social-strategy/manage//',
        '/plugins/social-strategy/%6fpen',
        '/plugins/social-strategy//x',
        '/PLUGINS/social-strategy/x',
        '/plugins/social%2Dstrategy',
    ]) {
        expect(plugins.embedOrigin(path), path).toBe('https://social-strategy.apps.example');
    }
    for (const path of [
        '/plugins',
        '/plugins/',
        '/plugins//social-strategy',
        '/plugins/other/posts',
        '/plugins/SOCIAL-STRATEGY',
        '/plugins/social-strategyx',
        '/plugins/%E0%A4%A',
        '/settings/plugins/social-strategy',
        '/x/plugins/social-strategy',
    ]) {
        expect(plugins.embedOrigin(path), path).toBeUndefined();
    }
    // The planner has no deep links (no `bridge.routes`).
    expect(plugins.launcher(olga)).toMatchObject([{ id: 'social-strategy', display: 'embed', routes: false }]);

    const url = new URL(await plugins.launch('social-strategy', olga.id, '/'));
    const code = url.searchParams.get('code')!;
    const other = new PluginService(db, {
        catalogs: [],
        settings: plugins.appsSettings,
        runtimeToken: SECRET,
        serviceToken: SERVICE,
        parentOrigin: 'https://brain.example',
        users: () => [olga],
    });
    const session = await other.redeem('social-strategy', code);
    expect(session?.next).toBe('/');
    expect(await plugins.redeem('social-strategy', code)).toBeUndefined();
    // A deep link longer than 500 characters (a long filter query) launches
    // and redeems to exactly that route (CB-446), up to the bridge's limit.
    const filter = `/events?filter=${'status%3Aopen%2C'.repeat(40)}#list`;
    expect(filter.length).toBeGreaterThan(500);
    expect(pluginRouteFromString(filter)).toBeDefined();
    const deep = new URL(await plugins.launch('social-strategy', olga.id, filter));
    expect((await other.redeem('social-strategy', deep.searchParams.get('code')!))?.next).toBe(filter);
    const tooLong = new URL(await plugins.launch('social-strategy', olga.id, `/e?${'q'.repeat(PLUGIN_ROUTE_MAX)}`));
    expect((await other.redeem('social-strategy', tooLong.searchParams.get('code')!))?.next).toBe('/');
    expect((await other.session('social-strategy', session!.value))?.userId).toBe(olga.id);

    const { names, server } = toolNames();
    plugins.contributeMcp(server, {
        person: bob,
        origin: 'https://brain.example',
        scopes: ['plugins:read', 'plugins:write'],
    });
    expect(names).toEqual([]);
    plugins.contributeMcp(server, {
        person: olga,
        origin: 'https://brain.example',
        scopes: ['plugins:read', 'plugins:write'],
    });
    expect(names).toEqual([
        'list_planned_posts',
        'create_planned_post',
        'update_planned_post',
        'list_reply_queue',
        'create_reply_item',
        'update_reply_item',
    ]);

    const before = engine.specNamed(pluginServiceName('social-strategy'));
    await plugins.scale('social-strategy', 2);
    const after = engine.specNamed(pluginServiceName('social-strategy'));
    expect(after?.Mode.Replicated.Replicas).toBe(2);
    expect(after?.TaskTemplate.ContainerSpec.Secrets).toEqual(before?.TaskTemplate.ContainerSpec.Secrets);
    expect(after?.TaskTemplate.ContainerSpec.Healthcheck).toEqual(before?.TaskTemplate.ContainerSpec.Healthcheck);
    expect(after?.TaskTemplate.Resources).toEqual(before?.TaskTemplate.Resources);
    expect(after?.TaskTemplate.Networks).toEqual(before?.TaskTemplate.Networks);
    // Socio Secrets phase 2: no shared token's secret, its own identity.
    const identityName = identitySecretName('social-strategy', 1);
    expect(before?.TaskTemplate.ContainerSpec.Secrets).toEqual([
        {
            SecretID: engine.secrets.get(identityName),
            SecretName: identityName,
            File: { Name: 'socio_identity', UID: '1000', GID: '1000', Mode: 0o400 },
        },
    ]);
    expect(before?.TaskTemplate.ContainerSpec.Env).toContain('SOCIO_IDENTITY_FILE=/run/secrets/socio_identity');
    expect(await plugins.status('social-strategy')).toMatchObject({
        replicas: 2,
        running: 2,
    });
    await plugins.uninstall('social-strategy');
    expect(engine.services.size).toBe(0);
    expect(plugins.launcher(olga)).toEqual([]);
    expect(tables()).toContain('planned_posts');
    expect(plugins.embedOrigin('/plugins/social-strategy')).toBeUndefined();
});

it('registers only the planner tools the connection’s scopes allow (PR #1 review)', async () => {
    const { plugins } = host();
    await plugins.install('social-strategy');
    const tools = (scopes: string[]) => {
        const { names, server } = toolNames();
        plugins.contributeMcp(server, {
            person: olga,
            origin: 'https://brain.example',
            scopes,
        });
        return names;
    };
    expect(tools([])).toEqual([]);
    expect(tools(['issues:read', 'issues:write', 'pages:read'])).toEqual([]);
    expect(tools(['plugins:read'])).toEqual(['list_planned_posts', 'list_reply_queue']);
    expect(tools(['plugins:write'])).toEqual([
        'create_planned_post',
        'update_planned_post',
        'create_reply_item',
        'update_reply_item',
    ]);
    expect(Object.fromEntries(plugins.toolScopes())).toMatchObject({
        list_planned_posts: ['plugins:social-strategy:read', 'plugins:read'],
        create_planned_post: ['plugins:social-strategy:write', 'plugins:write'],
    });
    // The plugin's own scope is enough without the legacy one (CB-254).
    expect(tools(['plugins:social-strategy:read'])).toEqual(['list_planned_posts', 'list_reply_queue']);
    expect(tools(['plugins:calendar:write'])).toEqual([]);
});

it('does not contribute planner tools when the plugin is not installed', () => {
    const { plugins } = host();
    const { names, server } = toolNames();
    plugins.contributeMcp(server, {
        person: olga,
        origin: 'https://brain.example',
        scopes: ['plugins:read', 'plugins:write'],
    });
    expect(names).toEqual([]);
});

it('mirrors planner tables and keeps posts addressable by status and time', async () => {
    const { db, plugins } = host();
    await plugins.install('social-strategy');
    const tables = [plannedPosts, replyQueue, plannerVoice];
    expect(schemaDrift(db, tables)).toEqual([]);
    expect(tables.map((table) => getTableName(table)).sort()).toEqual([
        'planned_posts',
        'planner_voice',
        'reply_queue',
    ]);
    const repo = new SqlitePlanner(sqliteData(db));
    const now = Date.parse('2026-10-27T13:30:00.000Z');
    await repo.insertPost({
        id: 'p1',
        status: 'draft',
        account: 'acme',
        plannedAt: now,
        topic: 'Socio',
        notes: '',
        parts: [{ text: 'Hello from Socio' }],
        createdAt: now,
        updatedAt: now,
    });
    await repo.insertReply({
        id: 'r1',
        sourceUrl: 'https://x.com/someone/status/99',
        sourceId: '99',
        author: 'someone',
        why: 'Worth a reply',
        draft: 'Thanks',
        status: 'todo',
        createdAt: now,
        updatedAt: now,
    });
    await repo.setVoice('Short, specific, no hashtags.');
    const posts = await repo.posts({ status: 'draft' });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ account: 'acme', topic: 'Socio' });
    expect(await repo.posts({ status: 'posted' })).toEqual([]);
    await repo.updatePost('p1', { status: 'ready', updatedAt: now + 1 });
    expect((await repo.post('p1'))?.status).toBe('ready');
    expect(await repo.replies('todo')).toHaveLength(1);
    expect((await repo.voice()).notes).toBe('Short, specific, no hashtags.');
});

it('renders the planner without calling X, and rejects a replica that lacks the proof', async () => {
    const page = renderPlanner({
        view: 'week',
        now: Date.parse('2026-10-27T13:30:00.000Z'),
        posts: [
            {
                id: 'p1',
                status: 'draft',
                account: 'acme',
                plannedAt: Date.parse('2026-10-27T13:30:00.000Z'),
                topic: 'Socio',
                notes: 'notes',
                parts: [{ text: 'Hello https://example.com/long' }],
            },
        ],
        replies: [],
        voice: 'Calm',
        parentOrigin: 'https://brain.example',
        editing: {
            id: 'p1',
            status: 'draft',
            account: 'acme',
            plannedAt: Date.parse('2026-10-27T13:30:00.000Z'),
            topic: 'Socio',
            notes: '',
            parts: [{ text: 'Hello https://example.com/long' }],
        },
    });
    expect(page).toContain('/ui/planner.js');
    expect(page).toContain('id="planner-state"');
    expect(page).toContain('meta name="socio-parent" content="https://brain.example"');
    expect(page).not.toContain('api.x.com');
    expect(page).not.toContain('statuses/update');
    const root = join(import.meta.dirname, '../../src');
    const ui = [
        '../packages/client/src/plugins/planner/Editor.tsx',
        '../packages/client/src/plugins/planner/CountRing.tsx',
        '../packages/client/src/plugins/planner/Replies.tsx',
    ]
        .map((file) => readFileSync(join(root, file), 'utf8'))
        .join('\n');
    expect(ui).toContain('threadIntents');
    expect(ui).toContain('weightedLength');
    expect(ui).toContain('intentUrl');
    expect(ui).toContain('data-count');
    expect(ui).not.toContain('api.x.com');

    const files: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(path);
            } else if (/\.(ts|tsx|js)$/.test(entry.name)) {
                files.push(path);
            }
        }
    };
    walk(join(root, 'server/plugins'));
    walk(join(root, '../packages/client/src/plugins'));
    walk(join(root, '../packages/shared/src'));
    walk(join(root, '../packages/foundation/src'));
    walk(join(root, '../packages/data/src'));
    walk(join(root, '../packages/foundation/src'));
    walk(join(root, '../packages/data/src'));
    walk(join(root, '../packages/plugin-ui/src'));
    const banned = files.filter((file) => /api\.x\.com|statuses\/update/.test(readFileSync(file, 'utf8')));
    expect(banned).toEqual([]);

    const token = join(mkdtempSync(join(tmpdir(), 'cb-planner-')), 'token');
    writeFileSync(token, SERVICE);
    const proof = pluginProof(SECRET, 'social-strategy');
    const server = startPlanner({
        port: 0,
        proof,
        apiUrl: 'http://127.0.0.1:9',
        tokenFile: token,
        fetch: async () =>
            new Response(
                JSON.stringify({
                    posts: [],
                    replies: [],
                    voice: { notes: 'Calm' },
                }),
                { status: 200 },
            ),
    });
    cleanup.push(() => server.close());
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    const denied = await fetch(`http://127.0.0.1:${port}/`);
    expect(denied.status).toBe(401);
    const pageResponse = await fetch(`http://127.0.0.1:${port}/`, {
        headers: {
            [RUNTIME_HEADER_PLUGIN_PROOF]: proof,
            'x-cb-parent-origin': 'https://brain.example',
        },
    });
    expect(pageResponse.status).toBe(200);
    expect(pageResponse.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(pageResponse.headers.get('referrer-policy')).toBe('same-origin');
    const html = await pageResponse.text();
    expect(html).toContain('Social strategy');
    expect(html).toContain('content="https://brain.example"');
});

it('rejects a deactivated or demoted admin’s plugin session and unused code', async () => {
    const people: User[] = [{ ...olga }];
    const { plugins } = host(() => people);
    await plugins.install('social-strategy');
    const open = async () => {
        const launched = new URL(await plugins.launch('social-strategy', olga.id));
        const redeemed = await plugins.redeem('social-strategy', launched.searchParams.get('code')!);
        const pending = new URL(await plugins.launch('social-strategy', olga.id));
        return {
            cookie: redeemed!.value,
            code: pending.searchParams.get('code')!,
        };
    };

    const demoted = await open();
    people[0] = { ...olga, role: 'member' };
    expect(await plugins.session('social-strategy', demoted.cookie)).toBeUndefined();
    expect(await plugins.redeem('social-strategy', demoted.code)).toBeUndefined();

    people[0] = { ...olga };
    const deactivated = await open();
    people.splice(0, people.length);
    expect(await plugins.session('social-strategy', deactivated.cookie)).toBeUndefined();
    expect(await plugins.redeem('social-strategy', deactivated.code)).toBeUndefined();

    people.push({ ...olga });
    const ended = await open();
    await accountLifecycle({
        workspace: { audit: () => undefined },
        serviceAccounts: { revokeKeysMadeBy: () => [] },
        agentGrants: { revokeAllOf: () => 0 },
        actors: { revokePerson: async () => 0 },
        apps: { endSessionsOf: async () => 0 },
        plugins,
        store: { pauseOwnedBy: async () => 0 },
        jobs: { stopOwnedBy: () => 0 },
        inference: { forgetUser: async () => undefined },
    })({
        action: 'deactivate',
        userId: olga.id,
        name: 'Olga',
        by: 'cli',
    });
    expect(people.some((user) => isAdmin(user))).toBe(true);
    expect(await plugins.session('social-strategy', ended.cookie)).toBeUndefined();
    expect(await plugins.redeem('social-strategy', ended.code)).toBeUndefined();
});

it('uses current auth accounts when history still lists an admin and a launch races revocation', async () => {
    let people = [olga];
    const auth = staticAuth(olga);
    auth.provider.users = () => people;
    const { workspace, platform, dispose } = await makeTestRuntime({
        config: {
            apps: appsSettingsFromEnv({ APPS_HOST: 'apps.example' }, 'https://brain.example'),
            plugins: {
                catalogs: [{ kind: 'bundled', id: 'social-strategy' }],
                serviceToken: SERVICE,
                runtime: {
                    provisionService: async () => ({
                        id: 'social-strategy',
                        service: 'socio-plugin-social-strategy',
                        image: 'planner',
                        replicas: 1,
                        running: 1,
                        state: 'running',
                    }),
                    scaleService: async () => {
                        throw new Error('unused');
                    },
                    removeService: async () => {},
                    serviceStatus: async () => undefined,
                },
            },
        },
        app: { config: { mode: 'live', baseUrl: '' }, auth },
    });
    cleanup.push(dispose);
    workspace.recordUser(olga);
    const plugins = platform.plugins;
    await plugins.install('social-strategy');
    const open = async () => {
        const url = new URL(await plugins.launch('social-strategy', olga.id));
        return plugins.redeem('social-strategy', url.searchParams.get('code')!);
    };
    const session = (await open())!;
    people = [{ ...olga, role: 'member' }];
    expect(workspace.users()).toContainEqual(olga);
    expect(await plugins.session('social-strategy', session.value)).toBeUndefined();
    expect(plugins.serviceUser.bind(plugins)).toThrow(/No admin/);
    people = [];
    expect(await plugins.session('social-strategy', session.value)).toBeUndefined();
    people = [olga];
    const pending = plugins.launch('social-strategy', olga.id);
    people = [];
    await plugins.endAccessOf(olga.id);
    const code = new URL(await pending).searchParams.get('code')!;
    // Reactivation must not restore a launch queued before revocation.
    people = [olga];
    expect(await plugins.redeem('social-strategy', code)).toBeUndefined();
    expect(await plugins.session('social-strategy', session.value)).toBeUndefined();
});

it('keeps a plugin session dead after revocation when the admin returns', async () => {
    const people: User[] = [{ ...olga }];
    const { db, plugins } = host(() => people);
    await plugins.install('social-strategy');
    const launched = new URL(await plugins.launch('social-strategy', olga.id));
    const redeemed = await plugins.redeem('social-strategy', launched.searchParams.get('code')!);
    const cookie = redeemed!.value;
    // The deactivation preview (CB-360) counts what `endAccessOf` ends.
    expect(plugins.accessCountOf(olga.id)).toBe(1);
    expect(await plugins.endAccessOf(olga.id)).toBe(1);
    expect(plugins.accessCountOf(olga.id)).toBe(0);
    db.prepare(
        'INSERT INTO plugin_sessions(hash, pluginId, userId, createdAt, expiresAt, generation) VALUES (?, ?, ?, ?, ?, 0)',
    ).run(pluginHash(cookie), 'social-strategy', olga.id, Date.now(), Date.now() + 60_000);
    expect(await plugins.session('social-strategy', cookie)).toBeUndefined();
    await accountLifecycle({
        workspace: { audit: () => undefined },
        serviceAccounts: { revokeKeysMadeBy: () => [] },
        agentGrants: { revokeAllOf: () => 0 },
        actors: { revokePerson: async () => 0 },
        apps: { endSessionsOf: async () => 0 },
        plugins,
        store: { pauseOwnedBy: async () => 0 },
        jobs: { stopOwnedBy: () => 0 },
        inference: { forgetUser: async () => undefined },
    })({
        action: 'reactivate',
        userId: olga.id,
        name: 'Olga',
        by: 'cli',
    });
    db.prepare(
        'INSERT INTO plugin_sessions(hash, pluginId, userId, createdAt, expiresAt, generation) VALUES (?, ?, ?, ?, ?, 0)',
    ).run(pluginHash(cookie), 'social-strategy', olga.id, Date.now(), Date.now() + 60_000);
    expect(await plugins.session('social-strategy', cookie)).toBeUndefined();
    // Bob is a member and the planner is for admins.
    await expect(plugins.launch('social-strategy', bob.id)).rejects.toThrow(/can’t open this plugin/);
});

it('stores only an https source url', () => {
    expect(httpsUrlSchema.parse('https://x.com/someone/status/99')).toBe('https://x.com/someone/status/99');
    expect(() => httpsUrlSchema.parse('javascript:alert(1)')).toThrow();
    expect(() => httpsUrlSchema.parse('http://x.com/someone/status/99')).toThrow();
});

it('opens an embed with a document navigation so that route’s CSP applies', () => {
    const source = readFileSync(
        join(import.meta.dirname, '../../packages/client/src/modules/plugins/plugin-rows.tsx'),
        'utf8',
    );
    expect(source).toMatch(
        /<Link\s+to=\{pluginPath\(plugin\.id\)\}\s+reloadDocument=\{!bundled && plugin\.display === 'embed'\}\s*>/,
    );
    const guard = readFileSync(join(import.meta.dirname, '../../packages/foundation/src/web/guard.ts'), 'utf8');
    expect(guard).toMatch(/frameSrc\?\.\(c\.req\.path\)/);
});

it('adds frame-src only for an embed origin and leaves the default policy alone', () => {
    expect(CONTENT_SECURITY_POLICY).not.toContain('frame-src');
    expect(withFrameSrc(CONTENT_SECURITY_POLICY, 'https://social-strategy.apps.example')).toBe(
        `${CONTENT_SECURITY_POLICY}; frame-src https://social-strategy.apps.example`,
    );
    expect(withFrameSrc(CONTENT_SECURITY_POLICY, 'not a origin')).toBe(CONTENT_SECURITY_POLICY);
});

const pinned = `company-brain-plugin-other@sha256:${'cd'.repeat(32)}`;

function thirdParty(patch: Record<string, unknown> = {}) {
    return {
        id: 'other-plugin',
        name: 'Other',
        version: '1.0.0',
        author: 'Elsewhere',
        description: 'A third-party plugin.',
        display: 'tab',
        permissions: [],
        service: {
            image: pinned,
            port: 8080,
        },
        ...patch,
    };
}

it('rejects a third-party manifest that asks for host access or an unpinned image', () => {
    expect(parseManifest(thirdParty(), 'catalog.json').service!.image).toBe(pinned);
    expect(() =>
        parseManifest(
            thirdParty({
                service: { image: 'company-brain-plugin-other:latest', port: 8080 },
            }),
            'catalog.json',
        ),
    ).toThrow(/sha256/);
    for (const extra of [
        { privileged: true },
        { networkMode: 'host' },
        { devices: ['/dev/sda'] },
        { capAdd: ['SYS_ADMIN'] },
        { mounts: [{ type: 'bind', source: '/', target: '/host' }] },
    ]) {
        expect(() => parseManifest(thirdParty(extra), 'catalog.json')).toThrow(/not allowed|must not set|refused/i);
    }
    expect(() =>
        parseManifest(
            thirdParty({
                service: {
                    image: pinned,
                    port: 8080,
                    volumes: [{ name: 'data', mount: '/data', type: 'bind' }],
                },
            }),
            'catalog.json',
        ),
    ).toThrow(/Bind mounts|not allowed|refused/i);
    expect(() =>
        parseManifest(
            thirdParty({
                service: { image: pinned, port: 8080, build: { context: '.' } },
            }),
            'catalog.json',
        ),
    ).toThrow(/build|not allowed/i);
});

it('accepts only a versioned bridge message from an exact origin', () => {
    expect(PLUGIN_SANDBOX).toBe('allow-scripts allow-forms allow-same-origin allow-downloads');
    expect(PLUGIN_SANDBOX).not.toContain('allow-popups');
    expect(PLUGIN_SANDBOX).not.toContain('allow-top-navigation');
    expect(parsePluginToHost({ v: 1, source: 'socio-plugin', type: 'ready' })?.type).toBe('ready');
    expect(
        parsePluginToHost(
            {
                v: 1,
                source: 'socio-plugin',
                type: 'open',
                url: 'https://x.com/intent/post?text=hi',
            },
            X_INTENTS,
        )?.type,
    ).toBe('open');
    expect(
        parsePluginToHost(
            {
                v: 1,
                source: 'socio-plugin',
                type: 'open',
                url: 'https://twitter.com/intent/post?text=hi',
            },
            X_INTENTS,
        )?.type,
    ).toBe('open');
    expect(
        parsePluginToHost(
            {
                v: 1,
                source: 'socio-plugin',
                type: 'open',
                url: 'https://evil.example/phish',
            },
            X_INTENTS,
        ),
    ).toBeUndefined();
    expect(
        parsePluginToHost(
            {
                v: 1,
                source: 'socio-plugin',
                type: 'open',
                url: 'javascript:alert(1)',
            },
            X_INTENTS,
        ),
    ).toBeUndefined();
    expect(
        parsePluginToHost({
            v: 1,
            source: 'socio-plugin',
            type: 'ready',
            extra: true,
        }),
    ).toBeUndefined();
    expect(parsePluginToHost({ v: 2, source: 'socio-plugin', type: 'ready' })).toBeUndefined();
    expect(parsePluginToHost({ v: 1, source: 'socio-host', type: 'ready' })).toBeUndefined();
    expect(
        parseHostToPlugin({
            v: 1,
            source: 'socio-host',
            type: 'theme',
            theme: 'dark',
            pluginId: 'social-strategy',
        }),
    ).toMatchObject({ theme: 'dark' });
    expect(
        parseHostToPlugin({
            v: 1,
            source: 'socio-host',
            type: 'theme',
            theme: 'dark',
            pluginId: '../x',
        }),
    ).toBeUndefined();
    expect(bridgeOrigin('*')).toBeUndefined();
    expect(bridgeOrigin('https://social-strategy.apps.example')).toBe('https://social-strategy.apps.example');
    const settings = appsSettingsFromEnv({ APPS_HOST: 'apps.example' }, 'https://brain.example')!;
    const cookie = pluginSessionCookie(settings, 'value', 60);
    expect(cookie).toContain('__Host-cb_app=value');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
    expect(cookie).not.toContain('Domain=');
});

it('keeps launch redirects on the plugin origin and plugin ids out of the mini-app namespace (PR #1 review)', () => {
    // Browsers drop tabs and line breaks before parsing a URL, so these
    // would become //evil.example after the redeem's 303.
    for (const next of [
        '/\t/evil.example',
        '/\n/evil.example',
        '/\r\n/evil.example',
        '//evil.example',
        '/\\evil.example',
        '/ /evil.example',
        'https://evil.example/',
        `/${'a'.repeat(PLUGIN_ROUTE_MAX)}`,
    ]) {
        expect(safeNext(next)).toBe('/');
    }
    // The bridge's own limit (CB-446): a long route opens again as it is.
    const long = `/events?${'f'.repeat(PLUGIN_ROUTE_MAX - 8)}`;
    expect(long).toHaveLength(PLUGIN_ROUTE_MAX);
    expect(pluginRouteFromString(long)).toBeDefined();
    expect(safeNext(long)).toBe(long);
    expect(safeNext('/')).toBe('/');
    expect(safeNext('/?view=month')).toBe('/?view=month');
    expect(safeNext('/posts/p1#top')).toBe('/posts/p1#top');
    // A mini app's id is <app>--<socio>; the ingress serves a plugin first.
    expect(PLUGIN_ID.test('social-strategy')).toBe(true);
    expect(PLUGIN_ID.test('notes--manny')).toBe(false);
    expect(PLUGIN_ID.test('xn--abc')).toBe(false);
});

it('refuses a bridge open on another port of x.com (PR #1 review)', () => {
    const open = (url: string) => parsePluginToHost({ v: 1, source: 'socio-plugin', type: 'open', url }, X_INTENTS);
    expect(open('https://x.com/intent/post?text=hi')).toBeDefined();
    expect(open('https://x.com:8443/intent/post?text=hi')).toBeUndefined();
    expect(open('https://x.com:443/intent/post?text=hi')).toBeDefined();
    expect(open('https://x.com.evil.example/intent/post')).toBeUndefined();
    expect(open('https://evil.example@x.com/intent/post')).toBeUndefined();
    expect(open('http://x.com/intent/post')).toBeUndefined();
});

it('takes `bridge.routes` as the opt-in for deep links (CB-446)', () => {
    expect(parseManifest(thirdParty({ display: 'embed', bridge: { routes: true } }), 'catalog.json').bridge).toEqual({
        routes: true,
    });
    expect(
        parseManifest(thirdParty({ bridge: { open: ['https://x.com/intent/post'], routes: false } }), 'catalog.json')
            .bridge,
    ).toEqual({ open: ['https://x.com/intent/post'], routes: false });
    expect(parseManifest(thirdParty(), 'catalog.json').bridge).toBeUndefined();
    for (const bridge of [{ routes: 'yes' }, { routes: 1 }, { routes: true, extra: 1 }, { open: 'x' }]) {
        expect(() => parseManifest(thirdParty({ bridge }), 'catalog.json'), JSON.stringify(bridge)).toThrow(/bridge/);
    }
});

/** Route paths the bridge takes, and ones it refuses (CB-446). */
const GOOD_PATHS = ['/', '/events', '/events/42', '/events/42/', '/caf%C3%A9', '/open', '/manage', '/a.b/c', '/..a'];
const BAD_PATHS: unknown[] = [
    '',
    'events',
    '//evil.example/x',
    '/a//b',
    'https://evil.example/x',
    'javascript:alert(1)',
    '/\\evil.example',
    '/\t/evil.example',
    '/a b',
    '/a\nb',
    '/a\u007fb',
    '/a/../b',
    '/a/./b',
    '/..',
    '/.',
    '/%2e%2e/settings',
    '/a/%2E%2E/b',
    '/a/%2e/b',
    '/café',
    '/__cb/auth',
    '/__CB/start',
    '/__cb',
    '/a?b',
    '/a#b',
    `/${'a'.repeat(PLUGIN_ROUTE_MAX)}`,
    42,
    null,
    undefined,
];

it('accepts a route report only for a plain path, query and fragment from the app (CB-446)', () => {
    const report = (path: unknown, query: unknown = '', hash: unknown = '') =>
        parsePluginToHost({ v: 1, source: 'socio-plugin', type: 'route', path, query, hash });
    for (const path of GOOD_PATHS) {
        expect(report(path), path).toEqual({ v: 1, source: 'socio-plugin', type: 'route', path, query: '', hash: '' });
    }
    expect(report('/events', '?view=week&day=2026-11-19', '#/events/42')).toMatchObject({
        query: '?view=week&day=2026-11-19',
        hash: '#/events/42',
    });
    // A hash-router app: everything after `#` is its route.
    expect(report('/', '', '#/events/42?tab=a')).toMatchObject({ path: '/', hash: '#/events/42?tab=a' });
    for (const path of BAD_PATHS) {
        expect(report(path), String(path)).toBeUndefined();
    }
    for (const [query, hash] of [
        ['view=week', ''],
        ['?a#b', ''],
        ['', 'top'],
        ['?a b', ''],
        ['', '#a\nb'],
        [null, ''],
        ['', null],
        [`?${'q'.repeat(PLUGIN_ROUTE_MAX)}`, ''],
    ]) {
        expect(report('/events', query, hash), `${String(query)} ${String(hash)}`).toBeUndefined();
    }
    // Exact fields.
    expect(parsePluginToHost({ v: 1, source: 'socio-plugin', type: 'route', path: '/e', query: '' })).toBeUndefined();
    expect(
        parsePluginToHost({ v: 1, source: 'socio-plugin', type: 'route', path: '/e', query: '', hash: '', x: 1 }),
    ).toBeUndefined();
    expect(parsePluginToHost({ v: 1, source: 'socio-host', type: 'route', path: '/e', query: '', hash: '' })).toBe(
        undefined,
    );
});

it('accepts a navigate as one route string, and a go-to from the host only with exact fields (CB-446)', () => {
    const navigate = (path: unknown, replace: unknown = false) =>
        parsePluginToHost({ v: 1, source: 'socio-plugin', type: 'navigate', path, replace });
    expect(navigate('/events/42?tab=a#b')).toEqual({
        v: 1,
        source: 'socio-plugin',
        type: 'navigate',
        path: '/events/42?tab=a#b',
        replace: false,
    });
    expect(navigate('/events', true)).toMatchObject({ replace: true });
    for (const path of BAD_PATHS.filter((path) => path !== '/a?b' && path !== '/a#b')) {
        expect(navigate(path), String(path)).toBeUndefined();
    }
    expect(navigate('/events', 'true')).toBeUndefined();
    expect(parsePluginToHost({ v: 1, source: 'socio-plugin', type: 'navigate', path: '/events' })).toBeUndefined();
    const goTo = { v: 1, source: 'socio-host', type: 'go-to', path: '/events', query: '?x=1', hash: '#y' };
    expect(parseHostToPlugin(goTo)).toEqual(goTo);
    expect(parseHostToPlugin({ ...goTo, path: '//evil.example' })).toBeUndefined();
    expect(parseHostToPlugin({ ...goTo, path: '/a/../b' })).toBeUndefined();
    expect(parseHostToPlugin({ ...goTo, replace: true })).toBeUndefined();
    expect(parseHostToPlugin({ ...goTo, source: 'socio-plugin' })).toBeUndefined();
    // The old host `navigate` is gone.
    expect(parseHostToPlugin({ v: 1, source: 'socio-host', type: 'navigate', path: '/e' })).toBeUndefined();
});

it('maps an app route to the workspace address and back, exactly (CB-446)', () => {
    const route = (path: string, query = '', hash = '') => pluginRoute(path, query, hash)!;
    expect(pluginAddressFor('events', route('/'))).toBe('/plugins/events');
    expect(pluginAddressFor('events', route('/', '?view=week'))).toBe('/plugins/events?view=week');
    expect(pluginAddressFor('events', route('/', '', '#/events/42'))).toBe('/plugins/events#/events/42');
    expect(pluginAddressFor('events', route('/events/42', '?tab=a', '#b'))).toBe('/plugins/events/events/42?tab=a#b');
    const at = (pathname: string, search = '', hash = '') => pluginRouteFromAddress({ pathname, search, hash });
    expect(at('/plugins/events')).toEqual(route('/'));
    expect(at('/plugins/events/')).toEqual(route('/'));
    expect(at('/plugins/events', '', '#/events/42')).toEqual(route('/', '', '#/events/42'));
    expect(at('/plugins/events/events/42', '?tab=a', '#b')).toEqual(route('/events/42', '?tab=a', '#b'));
    expect(at('/plugins/events/open')).toEqual(route('/open'));
    // Refused: the frame then opens at the entry.
    for (const pathname of ['/plugins/events//evil', '/plugins/events/__cb/auth', '/plugins/events/a/%2e%2e']) {
        expect(at(pathname), pathname).toBeUndefined();
    }
    expect(at('/settings/plugins/events')).toBeUndefined();
    expect(pluginAddress('/plugins/data%2Devents/x')).toEqual({ pluginId: 'data-events', rest: '/x' });
    expect(pluginAddress('/Plugins/events')).toEqual({ pluginId: 'events', rest: '' });
    expect(pluginAddress('/plugins/')).toBeUndefined();
    expect(pluginAddress('/plugins/%E0%A4%A')).toBeUndefined();
    expect(pluginRouteFromString('/a?b=1#c')).toEqual(route('/a', '?b=1', '#c'));
    expect(pluginRouteFromString('/a#b?c')).toEqual(route('/a', '', '#b?c'));
    // The frame opens exactly at the route: what the launch's `next` keeps.
    expect(safeNext('/events/42?tab=a#b')).toBe('/events/42?tab=a#b');
    // A browser may encode a query differently; the host and frame compare as URLs.
    expect(samePluginRoute(route('/e', "?q=it's"), route('/e', '?q=it%27s'))).toBe(true);
    expect(samePluginRoute(route('/e', '?q=1'), route('/e', '?q=2'))).toBe(false);
    expect(samePluginRoute(route('/e', '', '#a'), route('/e'))).toBe(false);
});

it('keeps install, launch and planner data admin-only over HTTP (PR #1 review)', async () => {
    const auth = staticAuth(bob);
    auth.provider.users = () => [olga, bob];
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            apps: appsSettingsFromEnv({ APPS_HOST: 'apps.example' }, 'https://brain.example'),
            plugins: {
                catalogs: [{ kind: 'bundled', id: 'social-strategy' }],
                serviceToken: SERVICE,
                runtime: {
                    provisionService: async () => ({
                        id: 'social-strategy',
                        service: 'socio-plugin-social-strategy',
                        image: 'planner',
                        replicas: 1,
                        running: 1,
                        state: 'running',
                    }),
                    scaleService: async () => {
                        throw new Error('unused');
                    },
                    removeService: async () => {},
                    serviceStatus: async () => undefined,
                },
            },
        },
        app: { config: { mode: 'live', baseUrl: '' }, auth },
    });
    cleanup.push(dispose);
    workspace.recordUser(olga);
    workspace.recordUser(bob);
    await platform.plugins.install('social-strategy');
    const call = (method: string, path: string, headers = {}) =>
        app.request(`http://localhost${path}`, {
            method,
            headers: {
                'content-type': 'application/json',
                origin: 'http://localhost',
                ...headers,
            },
            ...(method === 'GET' ? {} : { body: '{}' }),
        });
    for (const [method, path] of [
        ['GET', '/api/plugins'],
        ['POST', '/api/plugins/social-strategy/install'],
        ['PUT', '/api/plugins/social-strategy/config'],
        ['POST', '/api/plugins/social-strategy/launch'],
        ['DELETE', '/api/plugins/social-strategy'],
        ['GET', '/api/plugins/social-strategy/data/state'],
    ] as const) {
        const response = await call(method, path);
        expect(`${method} ${path} ${response.status}`).toBe(`${method} ${path} 403`);
    }
    // The shared service token without this plugin's proof is refused.
    const forged = await call('GET', '/api/plugins/social-strategy/data/state', {
        authorization: `Bearer ${SERVICE}`,
        [RUNTIME_HEADER_PLUGIN_PROOF]: pluginProof(SECRET, 'another-plugin'),
    });
    expect(forged.status).toBe(401);
    expect(platform.plugins.get('social-strategy')?.enabled).toBe(true);
});

it("has no admin route that changes a plugin's replicas (CB-396)", async () => {
    const admin: User = { id: 'ada', name: 'Ada', role: 'admin' };
    const auth = staticAuth(admin);
    auth.provider.users = () => [admin];
    const scaled: number[] = [];
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            apps: appsSettingsFromEnv({ APPS_HOST: 'apps.example' }, 'https://brain.example'),
            plugins: {
                catalogs: [{ kind: 'bundled', id: 'social-strategy' }],
                serviceToken: SERVICE,
                runtime: {
                    provisionService: async () => ({
                        id: 'social-strategy',
                        service: 'socio-plugin-social-strategy',
                        image: 'planner',
                        replicas: 1,
                        running: 1,
                        state: 'running',
                    }),
                    scaleService: async (_id, replicas) => {
                        scaled.push(replicas);
                        throw new Error('unused');
                    },
                    removeService: async () => {},
                    serviceStatus: async () => undefined,
                },
            },
        },
        app: { config: { mode: 'live', baseUrl: '' }, auth },
    });
    cleanup.push(dispose);
    workspace.recordUser(admin);
    await platform.plugins.install('social-strategy');
    const response = await app.request('http://localhost/api/plugins/social-strategy/scale', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify({ replicas: 3 }),
    });
    expect(response.status).toBe(404);
    expect(scaled).toEqual([]);
    expect(platform.plugins.get('social-strategy')?.replicas).toBe(1);
    // The listing an admin reads still says how many run, read-only.
    const listed = await app.request('http://localhost/api/plugins', { headers: { origin: 'http://localhost' } });
    expect(listed.status).toBe(200);
});

it('takes typed settings in a manifest and refuses malformed ones (CB-395)', () => {
    const parsed = parseManifest(
        thirdParty({
            config: {
                SYNC: { description: 'Sync on.', type: 'boolean', default: 'false' },
                LIMIT: { description: 'Rows.', type: 'integer', min: 1, max: 100, required: true },
                MODE: { description: 'How.', type: 'enum', options: ['pit', 'oauth'], default: 'pit' },
                WHEN: { description: 'Cron.', type: 'cron' },
                EDGE: { description: 'Edge.', type: 'url' },
                NOTE: { description: 'Free text.' },
            },
        }),
        'catalog.json',
    );
    expect(parsed.config?.LIMIT).toEqual({ description: 'Rows.', type: 'integer', min: 1, max: 100, required: true });
    expect(parsed.config?.NOTE).toEqual({ description: 'Free text.' });
    for (const [entry, message] of [
        [{ description: 'x', type: 'date' }, /config X: type must be one of/],
        [{ description: 'x', type: 'enum' }, /config X: an enum lists its options/],
        [{ description: 'x', type: 'boolean', default: 'yes' }, /config X: default does not fit/],
        [{ description: 'x', secret: true }, /secret/],
    ] as const) {
        expect(() => parseManifest(thirdParty({ config: { X: entry } }), 'catalog.json')).toThrow(message);
    }
});

it('refuses a settings save that does not fit the types, server-side (CB-395)', async () => {
    // A third-party plugin's catalog, with typed settings.
    const dir = mkdtempSync(join(tmpdir(), 'cb-plugins-typed-'));
    const file = join(dir, 'catalog.json');
    writeFileSync(
        file,
        JSON.stringify({
            plugins: [
                thirdParty({
                    config: {
                        SYNC: { description: 'Sync on.', type: 'boolean', default: 'false' },
                        LIMIT: { description: 'Rows.', type: 'integer', min: 1, max: 100, required: true },
                        MODE: { description: 'How.', type: 'enum', options: ['pit', 'oauth'] },
                        WHEN: { description: 'Cron.', type: 'cron' },
                        EDGE: { description: 'Edge.', type: 'url' },
                    },
                }),
            ],
        }),
    );
    const { plugins } = host(undefined, [{ kind: 'file', path: file }]);
    // A required setting is filled in after install, on the plugin's page.
    await plugins.install('other-plugin');
    const refused = async (config: Record<string, string>, message: RegExp) => {
        const error = await plugins.configure('other-plugin', config).then(
            () => undefined,
            (failure: unknown) => failure as { message: string; status: number },
        );
        expect(error?.status, JSON.stringify(config)).toBe(400);
        expect(error?.message).toMatch(message);
    };
    await refused({ LIMIT: '0' }, /^LIMIT: Use a number from 1 to 100\.$/);
    await refused({ LIMIT: '5', SYNC: 'yes' }, /^SYNC: Use true or false\.$/);
    await refused({ LIMIT: '5', MODE: 'basic' }, /^MODE: Choose one of: pit, oauth\.$/);
    await refused({ LIMIT: '5', WHEN: 'nightly' }, /^WHEN: Enter a cron expression/);
    await refused({ LIMIT: '5', EDGE: 'edge.example' }, /^EDGE: Enter a full http or https address/);
    expect(plugins.get('other-plugin')?.config).toEqual({});
    await plugins.configure('other-plugin', {
        LIMIT: ' 5 ',
        SYNC: 'true',
        MODE: 'oauth',
        WHEN: '0 9 * * 1-5',
        EDGE: 'https://edge.example',
    });
    // Still stored as strings.
    expect(plugins.get('other-plugin')?.config).toEqual({
        LIMIT: '5',
        SYNC: 'true',
        MODE: 'oauth',
        WHEN: '0 9 * * 1-5',
        EDGE: 'https://edge.example',
    });
    // An empty optional value is left out, so the plugin uses its default.
    await plugins.configure('other-plugin', { LIMIT: '7', EDGE: '' });
    expect(plugins.get('other-plugin')?.config).toEqual({ LIMIT: '7' });
    // A set required setting can't be cleared, blank or not (stored as the
    // form sends it: trimmed, and an empty value left out).
    await refused({}, /^LIMIT: This setting is required\.$/);
    await refused({ LIMIT: '' }, /^LIMIT: This setting is required\.$/);
    await refused({ LIMIT: '   ' }, /^LIMIT: This setting is required\.$/);
    expect(plugins.get('other-plugin')?.config).toEqual({ LIMIT: '7' });
});

it('saves settings one at a time around an unset required one and a kept value that no longer fits (CB-398)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-plugins-autosave-'));
    const file = join(dir, 'catalog.json');
    const write = (mode: Record<string, unknown>) =>
        writeFileSync(
            file,
            JSON.stringify({
                plugins: [
                    thirdParty({
                        config: {
                            SYNC: { description: 'Sync on.', type: 'boolean' },
                            LIMIT: { description: 'Rows.', type: 'integer', required: true },
                            MODE: { description: 'How.', ...mode },
                        },
                    }),
                ],
            }),
        );
    write({});
    const { db, plugins } = host(undefined, [{ kind: 'file', path: file }]);
    await plugins.install('other-plugin');
    // LIMIT isn't set yet: a switch still saves on its own.
    await plugins.configure('other-plugin', { SYNC: 'true' });
    expect(plugins.get('other-plugin')?.config).toEqual({ SYNC: 'true' });
    await plugins.configure('other-plugin', { SYNC: 'true', MODE: 'basic' });
    // A newer version makes MODE a choice without "basic": the kept value
    // saves along with the others until an admin changes it, but not anew.
    const manifest = {
        ...(plugins.get('other-plugin')!.manifest as unknown as Record<string, unknown>),
    };
    manifest.config = {
        ...(manifest.config as Record<string, unknown>),
        MODE: { description: 'How.', type: 'enum', options: ['pit', 'oauth'] },
    };
    db.prepare('UPDATE plugin_installs SET manifest = ? WHERE id = ?').run(JSON.stringify(manifest), 'other-plugin');
    await plugins.configure('other-plugin', { SYNC: 'false', MODE: 'basic' });
    expect(plugins.get('other-plugin')?.config).toEqual({ SYNC: 'false', MODE: 'basic' });
    await expect(plugins.configure('other-plugin', { SYNC: 'false', MODE: 'other' })).rejects.toThrow(
        /^MODE: Choose one of: pit, oauth\.$/,
    );
    await expect(plugins.configure('other-plugin', { SYNC: 'maybe', MODE: 'basic' })).rejects.toThrow(/^SYNC:/);
});

it('takes platform-neutral secrets in a plugin manifest and warns about service.secrets (Socio Secrets phase 2)', () => {
    const warnings: string[] = [];
    const warn = (line: string) => warnings.push(line);
    const parsed = parseManifest(
        thirdParty({
            secrets: [
                { name: 'STRIPE_API_KEY', description: ' Charges cards ' },
                { name: 'SLACK_WEBHOOK', required: false },
            ],
        }),
        'catalog.json',
        warn,
    );
    expect(parsed.secrets).toEqual([
        { name: 'STRIPE_API_KEY', required: true, description: 'Charges cards' },
        { name: 'SLACK_WEBHOOK', required: false },
    ]);
    expect(warnings).toEqual([]);
    expect(parseManifest(thirdParty({ secrets: [] }), 'catalog.json', warn).secrets).toBeUndefined();
    for (const [secrets, why] of [
        ['STRIPE_API_KEY', /list/],
        [[{ name: 'lower_case' }], /UPPER_CASE/],
        [[{ name: 'A_KEY' }, { name: 'A_KEY' }], /twice/],
        [[{ name: 'A_KEY', required: 'yes' }], /true or false/],
        [[{ name: 'A_KEY', description: 'two\nlines' }], /one line/],
        [[{ name: 'A_KEY', target: '/run/secrets/a' }], /not allowed/],
        [Array.from({ length: 51 }, (_, index) => ({ name: `K${index}` })), /at most 50/],
    ] as const) {
        expect(() => parseManifest(thirdParty({ secrets }), 'catalog.json', warn)).toThrow(why);
    }
    // A secret can't also be a plain env setting.
    expect(() =>
        parseManifest(
            thirdParty({
                service: { image: pinned, port: 8080, env: { STRIPE_API_KEY: 'x' } },
                secrets: [{ name: 'STRIPE_API_KEY' }],
            }),
            'catalog.json',
            warn,
        ),
    ).toThrow(/also a service env setting/);
    // service.secrets still loads for one release, with a warning naming no value.
    const legacy = parseManifest(
        thirdParty({
            service: {
                image: pinned,
                port: 8080,
                secrets: [{ name: 'company_brain_plugin_service_token', target: '/run/secrets/token' }],
            },
        }),
        'catalog.json',
        warn,
    );
    expect(legacy.service?.secrets).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/other-plugin sets service\.secrets, which is deprecated/);
    // The bundled planner no longer mounts the shared token.
    expect(socialStrategyManifest.service?.secrets).toBeUndefined();
    expect(socialStrategyManifest.service?.env).not.toHaveProperty('SOCIO_API_TOKEN_FILE');
});

it('answers a refused or failed plugin install with JSON the toast can show (deployment B v0.38.0)', async () => {
    let failure: Error = new Error('unused');
    const { app, workspace, dispose } = await makeTestRuntime({
        config: {
            apps: appsSettingsFromEnv({ APPS_HOST: 'apps.example' }, 'https://brain.example'),
            plugins: {
                catalogs: [{ kind: 'bundled', id: 'social-strategy' }],
                serviceToken: SERVICE,
                runtime: {
                    provisionService: async () => {
                        throw failure;
                    },
                    scaleService: async () => {
                        throw new Error('unused');
                    },
                    removeService: async () => {},
                    serviceStatus: async () => undefined,
                },
            },
        },
        app: { config: { mode: 'live', baseUrl: '' }, auth: staticAuth(olga) },
    });
    cleanup.push(dispose);
    workspace.recordUser(olga);
    const install = async () => {
        const response = await app.request('http://localhost/api/plugins/social-strategy/install', {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'http://localhost' },
            body: '{}',
        });
        return { status: response.status, body: (await response.json()) as { error?: string } };
    };
    // The socket proxy's refusal, as the runtime client raises it.
    failure = new RuntimeRefused('An infra service update may only change plugin-network attachments.', 403);
    expect(await install()).toEqual({
        status: 409,
        body: { error: 'An infra service update may only change plugin-network attachments.' },
    });
    failure = new RuntimeUnavailable('The workspace app runtime is unavailable right now.');
    expect(await install()).toEqual({
        status: 503,
        body: { error: 'The workspace app runtime is unavailable right now.' },
    });
    // Anything else keeps its detail in the server log.
    failure = new Error('connect ECONNREFUSED 10.0.0.7:2375');
    const other = await install();
    expect(other.status).toBe(502);
    expect(other.body.error).toMatch(/server log/);
    expect(other.body.error).not.toMatch(/ECONNREFUSED/);
});

it('classifies the apps runtime’s real answers on a plugin install: refusal, outage, failure', async () => {
    let answer: () => Response = () => Response.json({ error: 'unused' }, { status: 500 });
    const runtime = new AppsRuntimeClient(
        {
            url: 'http://runtime.test',
            token: 'runtime-token-0123456789abcdef',
            ingress: { host: 'runtime.test', port: 4331 },
        },
        async () => answer(),
    );
    const { app, workspace, dispose } = await makeTestRuntime({
        config: {
            apps: appsSettingsFromEnv({ APPS_HOST: 'apps.example' }, 'https://brain.example'),
            plugins: {
                catalogs: [{ kind: 'bundled', id: 'social-strategy' }],
                serviceToken: SERVICE,
                runtime,
            },
        },
        app: { config: { mode: 'live', baseUrl: '' }, auth: staticAuth(olga) },
    });
    cleanup.push(dispose);
    workspace.recordUser(olga);
    const install = async () => {
        const response = await app.request('http://localhost/api/plugins/social-strategy/install', {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'http://localhost' },
            body: '{}',
        });
        return { status: response.status, body: (await response.json()) as { error?: string } };
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        // The socket proxy's refusal, passed on by the runtime as its 403.
        answer = () =>
            Response.json(
                { error: 'Only an internal socio-plugin-net-<id> overlay can be attached or detached.' },
                { status: 403 },
            );
        expect(await install()).toEqual({
            status: 409,
            body: { error: 'Only an internal socio-plugin-net-<id> overlay can be attached or detached.' },
        });
        // The runtime's own 503 sentence is an outage the admin may read.
        answer = () =>
            Response.json({ error: 'Docker could not attach company-brain_apps (HTTP 500).' }, { status: 503 });
        expect(await install()).toEqual({
            status: 503,
            body: { error: 'Docker could not attach company-brain_apps (HTTP 500).' },
        });
        // Any other runtime 5xx keeps its detail in the server log.
        answer = () => Response.json({ error: 'internal diagnostic detail' }, { status: 500 });
        const failed = await install();
        expect(failed.status).toBe(502);
        expect(failed.body.error).toMatch(/server log/);
        expect(failed.body.error).not.toMatch(/diagnostic/);
        expect(errors).toHaveBeenCalledWith('Plugin request failed:', 'internal diagnostic detail');
        // A refused runtime token, and an unreachable runtime, are outages.
        answer = () => Response.json({ error: 'Unauthorized.' }, { status: 401 });
        expect((await install()).status).toBe(503);
        answer = () => {
            throw new TypeError('fetch failed');
        };
        expect(await install()).toEqual({
            status: 503,
            body: { error: 'The workspace app runtime is unavailable right now.' },
        });
    } finally {
        errors.mockRestore();
    }
});
