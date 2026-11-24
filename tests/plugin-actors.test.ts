import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { signContextProof } from '@socio/foundation/actors/keys';
import { intentDigest } from '@socio/foundation/actors/principal';
import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';
import type { DotTurn } from '@socio/foundation/turns/turn';
import { closeScopes, type ActorScope } from '@socio/shared/actor-scopes';
import { RUNTIME_HEADER_APP, RUNTIME_HEADER_KEY, RUNTIME_HEADER_SIG } from '@socio/shared/apps/apps-runtime-types';
import { swarmServiceBody } from '@socio/shared/plugins/plugin-service';
import { LEGACY_SCOPE_PLUGINS, pluginScope, pluginToolScopes } from '@socio/shared/plugins/plugins';
import { SOCIO_ACCESS_CAPABILITIES } from '@socio/shared/socio-access';
import type { User } from '@socio/shared/types';

import { socioApp } from '../packages/app-sdk/src/index.js';
import { ingressServer } from '../src/apps-runtime/ingress.js';
import { identitySignature, ingressKey, pluginActorKey, pluginProof } from '../src/apps-runtime/keys.js';
import { consumeAppAction } from '../src/server/actors/approvals.js';
import { actorTools } from '../src/server/actors/tools.js';
import { createAppsInternalServer } from '../src/server/apps/internal-listener.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { pluginActionSet, pluginPolicyVersion } from '../src/server/plugins/actor.js';
import { calendarTools } from '../src/server/plugins/calendar/tools.js';
import { parseManifest } from '../src/server/plugins/catalog.js';
import { PLUGIN_PERSON_HEADER } from '../src/server/plugins/contract.js';
import { verifyPluginPerson } from '../src/server/plugins/person.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-232: socio-actor access for plugins. One audience model (the
// install's audience is the `plugin:<id>` policy's `personMay`; a
// plugin's actions take their tiers from the same mapping as a connected
// agent's per-plugin scopes), bundled tools checked like any other use of
// a grant, signed envelopes for service plugins, revocation, and the
// legacy scopes kept to the planner. Negative cases first.

const SECRET = 'secret-0123456789abcdef-xyz';
const RUNTIME = 'runtime-secret-runtime-secret-32';
const SERVICE = 'plugin-service-token-plugin-service-token';
const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
    { id: 'carol', name: 'Carol', role: 'member' },
];
const IMAGE = `company-brain-plugin-crm@sha256:${'a'.repeat(64)}`;
const CRM_ACTIONS = {
    'deals.view': 'read',
    'deals.update': 'write',
    'sms.send': 'consequential',
    'settings.update': 'admin',
} as const;

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** A service plugin's manifest; `delegation` null leaves the contract out. */
const crmManifest = (
    delegation: Record<string, unknown> | null = {
        contract: 1,
        actions: CRM_ACTIONS,
    },
    id = 'crm',
) => ({
    id,
    name: id === 'crm' ? 'CRM' : 'Leads',
    version: '1.0.0',
    author: 'Test',
    description: 'Deals.',
    display: 'tab',
    permissions: ['crm:read', 'crm:write', 'person:read'],
    audience: 'members',
    service: { image: IMAGE, port: 8080 },
    ...(delegation ? { delegation } : {}),
});

/** The plugin's task: records what it gets; streams on /sse. */
async function upstream() {
    const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
    const timers = new Set<ReturnType<typeof setInterval>>();
    const server: Server = createServer((req, res) => {
        seen.push({ url: req.url!, headers: req.headers });
        if (req.url === '/sse') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('data: 1\n\n');
            const timer = setInterval(() => res.write('data: tick\n\n'), 50);
            timers.add(timer);
            res.on('close', () => clearInterval(timer));
            return;
        }
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true}');
        });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    cleanup.push(
        () =>
            new Promise<void>((ok) => {
                for (const timer of timers) {
                    clearInterval(timer);
                }
                server.closeAllConnections();
                server.close(() => ok());
            }),
    );
    return { port: (server.address() as AddressInfo).port, seen };
}

/** The runtime's real ingress, with one plugin task behind it. */
async function ingress(taskPort: number) {
    const services = {
        refresh: async () => {},
        owns: (id: string) => id === 'crm',
        targets: async () => [{ host: '127.0.0.1', port: taskPort }],
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
    return (server.address() as AddressInfo).port;
}

async function fixture(
    options: {
        flag?: boolean;
        delegation?: Record<string, unknown> | null;
        /** `APPS_SOCIO_ON_PUBLIC_HOST`: these tests send socio sessions to the
         * plugin's public host, so on unless a test says otherwise. */
        socioOnPublicHost?: boolean;
        /** A second service plugin, `leads`, with the same contract. */
        second?: boolean;
    } = {},
) {
    vi.stubEnv('APPS_SOCIO_ON_PUBLIC_HOST', options.socioOnPublicHost === false ? '' : '1');
    cleanup.push(() => vi.unstubAllEnvs());
    const dir = mkdtempSync(join(tmpdir(), 'cb-plugin-actors-'));
    const catalog = join(dir, 'catalog.json');
    writeFileSync(
        catalog,
        JSON.stringify({
            plugins: [crmManifest(options.delegation), ...(options.second ? [crmManifest(undefined, 'leads')] : [])],
        }),
    );
    const task = await upstream();
    const ingressPort = await ingress(task.port);
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
                ingress: { host: '127.0.0.1', port: ingressPort },
            },
            plugins: {
                catalogs: [
                    { kind: 'bundled', id: 'calendar' },
                    { kind: 'file', path: catalog },
                ],
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
            featureFlags: { 'socio-actor-access': options.flag !== false },
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
    await plugins.install('calendar');
    await plugins.install('crm');
    if (options.second) {
        await plugins.install('leads');
    }
    const dot = workspace.dots()[0];
    const chats = {
        alice: workspace.bindThread('chat-alice', dot.id, 'Plans', 'alice'),
        bob: workspace.bindThread('chat-bob', dot.id, 'Plans', 'bob'),
        bobOther: workspace.bindThread('chat-bob-2', dot.id, 'Other', 'bob'),
    };
    const turn = (userId: string, threadId: string): DotTurn => ({
        dot,
        userId,
        threadId,
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
    });
    const grant = (
        id: 'calendar' | 'crm' | 'leads',
        scopes: ActorScope[],
        over: { personId?: string; conversationId?: string } = {},
    ) =>
        platform.actors.grants.create({
            personId: over.personId ?? 'bob',
            socioId: dot.id,
            audiences: [`plugin:${id}`],
            scopes,
            conversationId: over.conversationId ?? chats.bob.id,
            conversationKind: 'private',
            task: 'Plan the week',
            policyVersion: pluginPolicyVersion(plugins.get(id))!,
            approvedBy: over.personId ?? 'bob',
            correlationId: 'test',
        });
    /** The socio's calendar tools on a turn, by name. */
    const tools = (userId: string, threadId: string) =>
        Object.fromEntries(
            (
                plugins.dotTools(turn(userId, threadId)) as unknown as Array<{
                    name: string;
                    execute: (input: unknown) => Promise<Record<string, unknown>>;
                }>
            ).map((tool) => [tool.name, tool.execute]),
        );
    const crmOrigin = plugins.origin('crm')!;
    const crmHost = new URL(crmOrigin).host;
    /** An app browser context on the CRM: its credential and proof key. */
    const session = async (scopes: ActorScope[] = ['app:read']) => {
        const g = await grant('crm', scopes);
        const context = await platform.actors.contexts.open({
            grant: g,
            kind: 'browser',
            audience: 'plugin:crm',
            correlationId: 'test',
        });
        const { token } = await platform.actors.credentials.issue({
            grant: g,
            kind: 'cbsa',
            audiences: ['plugin:crm'],
            contextId: context.id,
            holder: { kind: 'context', id: context.id },
            correlationId: 'test',
        });
        const key = platform.actors.contextKey(context.id);
        const proof = (method: string, target: string, body = '') =>
            signContextProof(key, {
                method,
                host: crmHost,
                requestTarget: target,
                bodyDigest: body ? createHash('sha256').update(body).digest('hex') : '',
            });
        const send = (target: string, init: { method?: string; body?: string; proof?: string | null } = {}) => {
            const method = init.method ?? 'GET';
            return app.request(`${crmOrigin}${target}`, {
                method,
                headers: {
                    authorization: `Bearer ${token}`,
                    ...(init.proof === null
                        ? {}
                        : {
                              'x-cb-context': init.proof ?? proof(method, target, init.body),
                          }),
                    ...(init.body ? { 'content-type': 'application/json' } : {}),
                },
                ...(init.body ? { body: init.body } : {}),
            });
        };
        return { grant: g, token, proof, send };
    };
    const login = async (userId: string) => {
        const response = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        return response.headers.get('set-cookie')!.split(';')[0];
    };
    /** A person's session on the CRM's origin (the launch hand-off). */
    const signIn = async (userId = 'bob') => {
        const launched = await app.request('http://localhost:4310/api/plugins/crm/launch', {
            method: 'POST',
            headers: {
                cookie: await login(userId),
                'content-type': 'application/json',
            },
            body: '{}',
        });
        const { url } = (await launched.json()) as { url: string };
        return (await app.request(url)).headers.get('set-cookie')!.split(';')[0];
    };
    const sdk = () =>
        socioApp({
            appId: 'plugin:crm',
            key: pluginActorKey(RUNTIME, 'crm'),
            actions: CRM_ACTIONS,
            env: {},
        });
    /** A plugin service's call back into its data routes. */
    const callback = (method: string, obo?: string, path = '/api/plugins/crm/data/state') =>
        app.request(`http://localhost:4310${path}`, {
            method,
            headers: {
                authorization: `Bearer ${SERVICE}`,
                'x-cb-plugin-proof': pluginProof(RUNTIME, 'crm'),
                ...(obo ? { 'x-cb-obo': obo } : {}),
                ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
            },
            ...(method === 'GET' ? {} : { body: '{}' }),
        });
    /**
     * A plugin service's socio-access call: its service token and the
     * proof of `as` (the plugin itself by default), on `plugin`'s routes.
     */
    const actorCall = (
        path: string,
        body: unknown,
        over: {
            obo?: string;
            plugin?: string;
            as?: string | null;
            token?: string | null;
            headers?: Record<string, string>;
        } = {},
    ) => {
        const plugin = over.plugin ?? 'crm';
        const as = over.as === undefined ? plugin : over.as;
        return app.request(`http://localhost:4310/api/plugins/${plugin}/actor${path}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(over.token === null ? {} : { authorization: `Bearer ${over.token ?? SERVICE}` }),
                ...(as === null ? {} : { 'x-cb-plugin-proof': pluginProof(RUNTIME, as) }),
                ...(over.obo ? { 'x-cb-obo': over.obo } : {}),
                ...over.headers,
            },
            body: JSON.stringify(body),
        });
    };
    /** The `cbob_` the proxy would mint for a socio's request to `plugin`. */
    const oboFor = (grantId: string, plugin = 'crm', requestId = `req-${Math.random()}`) =>
        plugins.actors!.mintObo(plugin, { grantId }, requestId, 60_000);
    return {
        platform,
        workspace,
        plugins,
        app,
        actorCall,
        oboFor,
        dot,
        chats,
        turn,
        grant,
        tools,
        task,
        ingressPort,
        crmOrigin,
        crmHost,
        session,
        signIn,
        sdk,
        callback,
    };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const lastSeen = (f: Fixture) => f.task.seen.at(-1)!;
const denies = (f: Fixture, reason: string) =>
    f.platform.actors.audit
        .list({ personId: 'bob' }, 200)
        .filter((row) => row.decision === 'deny' && row.reason === reason);

describe('one audience model for plugins (the plugin:<id> policy, CB-254’s audience and scopes)', () => {
    it('registers the plugin policy: no version until installed and enabled, none for a service plugin without the contract', async () => {
        const f = await fixture({ delegation: null });
        const policy = f.platform.actors.audiences.for('plugin:calendar')!;
        expect(policy).toBeDefined();
        // A service plugin that doesn't verify the envelope can't be delegated.
        expect(await f.platform.actors.audiences.for('plugin:crm')!.policyVersion('plugin:crm')).toBeUndefined();
        expect(await policy.policyVersion('plugin:nope')).toBeUndefined();
        const version = await policy.policyVersion('plugin:calendar');
        expect(version).toMatch(/^[0-9a-f]{64}$/);
        await f.plugins.setEnabled('calendar', false, 'alice');
        expect(await policy.policyVersion('plugin:calendar')).toBeUndefined();
        await f.plugins.setEnabled('calendar', true, 'alice');
        expect(await policy.policyVersion('plugin:calendar')).toBe(version);
        // Read from the database, not this process's list: a change the
        // other runtime of a deploy made counts here at once.
        f.workspace.db.prepare("UPDATE plugin_installs SET enabled=0 WHERE id='calendar'").run();
        expect(f.plugins.get('calendar')?.enabled).toBe(true);
        expect(await policy.policyVersion('plugin:calendar')).toBeUndefined();
        f.workspace.db.prepare("UPDATE plugin_installs SET enabled=1, audience='admins' WHERE id='calendar'").run();
        const g = await f.grant('calendar', ['app:read']);
        expect(await f.platform.actors.authorizer.authorizeGrant(g.id, { fresh: true })).toEqual({
            allowed: false,
            reason: 'person_no_access',
        });
    });

    it('takes each action’s tier from the same mapping as the per-plugin scopes, and admin is never a socio’s', async () => {
        const f = await fixture();
        const policy = f.platform.actors.audiences.for('plugin:calendar')!;
        for (const tool of calendarTools) {
            const tier = await policy.actionTier!('plugin:calendar', tool.name);
            // The connected agent's scope for the tool names the same access.
            expect(pluginScope('calendar', tool.permission)).toBe(`plugins:calendar:${tier}`);
        }
        expect(await policy.actionTier!('plugin:calendar', 'drop_all')).toBe(undefined);
        expect(await policy.actionTier!('plugin:calendar', 'toString')).toBe(undefined);
        expect(pluginActionSet(f.plugins.get('crm'))).toEqual(CRM_ACTIONS);
        const g = await f.grant('crm', ['app:act']);
        expect(
            await f.platform.actors.authorizer.authorize(g.id, {
                audience: 'plugin:crm',
                action: 'settings.update',
            }),
        ).toEqual({ allowed: false, reason: 'admin_tier' });
        expect(
            await f.platform.actors.authorizer.authorize(g.id, {
                audience: 'plugin:crm',
                action: 'deals.update',
            }),
        ).toEqual({ allowed: true, tier: 'write' });
    });

    it('the install’s audience is the policy’s personMay', async () => {
        const f = await fixture();
        const policy = f.platform.actors.audiences.for('plugin:calendar')!;
        const g = await f.grant('calendar', ['app:read']);
        expect(await policy.personMay('bob', 'plugin:calendar', g)).toBe(true);
        expect(await policy.personMay('ghost', 'plugin:calendar', g)).toBe(false);
        await f.plugins.setAudience('calendar', 'admins', 'alice');
        expect(await policy.personMay('bob', 'plugin:calendar', g)).toBe(false);
        expect(await policy.personMay('alice', 'plugin:calendar', g)).toBe(true);
    });

    it('refuses a plugin manifest’s data: names, unknown keys and scopes of its own; takes consequential', () => {
        const base = crmManifest();
        expect(() =>
            parseManifest(
                crmManifest({
                    contract: 1,
                    actions: { 'data:files.delete': 'consequential' },
                }),
                'test',
            ),
        ).toThrow(/reserved for Socio’s data operations/);
        expect(() => parseManifest(crmManifest({ contract: 1, actions: { 'sms.send': 'root' } }), 'test')).toThrow(
            /must be read, write, consequential or admin/,
        );
        expect(
            parseManifest(crmManifest({ contract: 1, actions: { 'sms.send': 'consequential' } }), 'test').delegation
                ?.actions,
        ).toEqual({ 'sms.send': 'consequential' });
        expect(() => parseManifest(crmManifest({ contract: 1, actions: {}, scopes: ['app:act'] }), 'test')).toThrow(
            /field scopes is not allowed/,
        );
        expect(() => parseManifest(crmManifest({ contract: 2, actions: {} }), 'test')).toThrow(/contract must be 1/);
        expect(() => parseManifest(crmManifest({ contract: 1, actions: {}, ownerColumn: 'owner' }), 'test')).toThrow(
            /ownerColumn is not allowed/,
        );
        expect(parseManifest(base, 'test').delegation).toEqual({
            contract: 1,
            actions: CRM_ACTIONS,
        });
    });
});

describe('bundled plugin tools honor the same check', () => {
    it('a socio with no grant, or another conversation’s or person’s, can’t use the calendar', async () => {
        const f = await fixture();
        expect(await f.tools('bob', f.chats.bob.id).list_events!({})).toMatchObject({
            code: 'http_403',
            error: expect.stringMatching(
                /request access with request_app_access first; the person decides on its approval card/,
            ),
        });
        // A grant from another conversation, or for another person.
        await f.grant('calendar', ['app:write'], {
            conversationId: f.chats.bobOther.id,
        });
        await f.grant('calendar', ['app:write'], {
            personId: 'alice',
            conversationId: f.chats.alice.id,
        });
        expect(await f.tools('bob', f.chats.bob.id).list_events!({})).toMatchObject({ code: 'http_403' });
        expect(denies(f, 'grant_missing').length).toBeGreaterThanOrEqual(2);
    });

    it('a socio’s read grant can’t write calendar events', async () => {
        const f = await fixture();
        const read = await f.grant('calendar', ['app:read']);
        const tools = f.tools('bob', f.chats.bob.id);
        expect(await tools.list_events!({})).toMatchObject({ events: [] });
        for (const [name, input] of [
            ['create_event', { title: 'Sneaky', start: '2026-11-02T10:00' }],
            ['update_event', { id: 'x', title: 'Sneaky' }],
            ['delete_event', { id: 'x' }],
        ] as const) {
            expect(await tools[name]!(input)).toMatchObject({
                code: 'http_403',
                error: expect.stringMatching(/read-only/),
            });
        }
        expect(f.workspace.db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get()).toEqual({ n: 0 });
        expect(
            denies(f, 'scope_insufficient').some((row) => row.grantId === read.id && row.action === 'create_event'),
        ).toBe(true);
        // A write grant in the same conversation replaces it and can.
        await f.grant('calendar', ['app:write']);
        const made = (await f.tools('bob', f.chats.bob.id).create_event!({
            title: 'Venue hold',
            start: '2026-11-02T10:00',
        })) as { event: { createdVia: string; createdBy: { id: string } } };
        expect(made.event).toMatchObject({
            createdBy: { id: 'bob' },
            createdVia: f.dot.name,
        });
        // Connected agents keep their own scopes (CB-90 identities): untouched.
        expect(pluginToolScopes('calendar', 'calendar:write')).toEqual(['plugins:calendar:write']);
    });

    it('works as before (the person’s own permissions) while the flag is off for the person', async () => {
        const f = await fixture({ flag: false });
        const made = await f.tools('bob', f.chats.bob.id).create_event!({
            title: 'No grant needed',
            start: '2026-11-02T10:00',
        });
        expect(made).toMatchObject({ outcome: 'created' });
    });
});

describe('a person outside the plugin’s audience can’t be acted for', () => {
    it('narrowing the audience ends their grants at once and their socio’s tools with them', async () => {
        const f = await fixture();
        const bobs = await f.grant('calendar', ['app:write']);
        const alices = await f.grant('calendar', ['app:write'], {
            personId: 'alice',
            conversationId: f.chats.alice.id,
        });
        const held = f.tools('bob', f.chats.bob.id);
        await f.plugins.setAudience('calendar', 'admins', 'alice');
        expect(f.platform.actors.grants.get(bobs.id)).toMatchObject({
            revokeReason: 'access_changed',
            revokedBy: 'alice',
        });
        expect(f.platform.actors.grants.get(alices.id)?.revokedAt).toBeNull();
        // A turn that already had the tools: refused before anything runs.
        expect(await held.create_event!({ title: 'Late', start: '2026-11-02T10:00' })).toMatchObject({
            code: 'http_403',
        });
        expect(f.tools('bob', f.chats.bob.id)).toEqual({});
        expect(
            await f.tools('alice', f.chats.alice.id).create_event!({
                title: 'Still fine',
                start: '2026-11-02T10:00',
            }),
        ).toMatchObject({ outcome: 'created' });
        // A new grant for bob can't pass the intersection.
        const late = await f.grant('calendar', ['app:read']);
        expect(
            await f.platform.actors.authorizer.authorizeGrant(late.id, {
                fresh: true,
            }),
        ).toEqual({ allowed: false, reason: 'person_no_access' });
    });

    it('request_app_access names plugins the person may use, and no other', async () => {
        const f = await fixture();
        const ask = (userId: string, threadId: string, input: object) =>
            (
                actorTools(f.platform, f.turn(userId, threadId)).find(
                    (tool) => tool.name === 'request_app_access',
                ) as unknown as {
                    execute: (input: unknown) => Promise<Record<string, unknown>>;
                }
            ).execute(input);
        await f.plugins.setAudience('calendar', 'admins', 'alice');
        expect(await ask('bob', f.chats.bob.id, { app: 'Calendar', task: 'Plan' })).toMatchObject({
            status: 'refused',
            error: expect.stringMatching(/No app/),
        });
        await f.plugins.setAudience('calendar', 'members', 'alice');
        // Bob's read opt-in for this socio: granted at once, on the plugin.
        await f.platform.approvals.setPolicy('bob', f.dot.id, SOCIO_ACCESS_CAPABILITIES.read, 'bypass');
        const granted = await ask('bob', f.chats.bob.id, {
            app: 'plugin:calendar',
            task: 'Plan the week',
        });
        expect(granted).toMatchObject({ status: 'granted', access: 'read' });
        expect(f.platform.actors.grants.get(granted.grant as string)?.audiences).toEqual(['plugin:calendar']);
        expect(await f.tools('bob', f.chats.bob.id).list_events!({})).toMatchObject({ events: [] });
        // Write always waits for the person; the card names the plugin.
        const pending = await ask('bob', f.chats.bob.id, {
            app: 'Calendar',
            task: 'Add the venue holds',
            access: 'write',
        });
        expect(pending).toMatchObject({ status: 'pending_approval' });
        const card = (await f.platform.approvals.get(pending.id as string, 'bob')).card as {
            app: { label: string; origin: string; owner: string };
        };
        expect(card.app).toMatchObject({
            label: 'Calendar',
            origin: 'http://localhost:4310/plugins/calendar',
            owner: expect.stringMatching(/installed plugin/),
        });
        // A service plugin without the contract can't be asked for.
        const g = await fixture({ delegation: null });
        expect(
            await (
                actorTools(g.platform, g.turn('bob', g.chats.bob.id)).find(
                    (tool) => tool.name === 'request_app_access',
                ) as unknown as {
                    execute: (input: unknown) => Promise<Record<string, unknown>>;
                }
            ).execute({ app: 'crm', task: 'Look' }),
        ).toMatchObject({
            status: 'refused',
            error: expect.stringMatching(/plugin hasn’t adopted socio access/),
        });
    });
});

describe('revocation', () => {
    it('disabling or uninstalling a plugin ends its grants; a revoked grant’s tools stop', async () => {
        const f = await fixture();
        const g = await f.grant('calendar', ['app:write']);
        const tools = f.tools('bob', f.chats.bob.id);
        expect(await tools.list_events!({})).toMatchObject({ events: [] });
        await f.platform.actors.revoke({ grantId: g.id }, 'bob', 'person_revoked');
        expect(await tools.list_events!({})).toMatchObject({ code: 'http_403' });
        const again = await f.grant('calendar', ['app:read']);
        await f.plugins.setEnabled('calendar', false, 'alice');
        expect(f.platform.actors.grants.get(again.id)).toMatchObject({
            revokeReason: 'audience_unavailable',
            revokedBy: 'alice',
        });
        await f.plugins.setEnabled('calendar', true, 'alice');
        const third = await f.grant('crm', ['app:read']);
        await f.plugins.uninstall('crm', 'alice');
        expect(f.platform.actors.grants.get(third.id)?.revokeReason).toBe('audience_unavailable');
    });

    it('closes a socio’s streamed response from a service plugin when its grant is revoked', async () => {
        const f = await fixture();
        const s = await f.session();
        const response = await s.send('/sse');
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: 1');
        expect(f.platform.actors.revocations.trackedCount(s.grant.id)).toBe(1);
        await f.platform.actors.revoke({ grantId: s.grant.id }, 'bob', 'person_revoked');
        const ended = await (async () => {
            try {
                for (;;) {
                    if ((await reader.read()).done) {
                        return 'done';
                    }
                }
            } catch {
                return 'error';
            }
        })();
        expect(['done', 'error']).toContain(ended);
        expect(f.platform.actors.revocations.trackedCount(s.grant.id)).toBe(0);
        // And the next request is refused: its credential ended with the grant.
        expect([401, 403]).toContain((await s.send('/deals')).status);
    });
});

describe('service plugins: signed envelopes, no unsigned legacy headers', () => {
    it('refuses a socio credential on the plugin’s public host without the development switch, checked by nothing', async () => {
        const f = await fixture({ socioOnPublicHost: false });
        const s = await f.session();
        const before = f.task.seen.length;
        const audited = () =>
            (f.workspace.db.prepare('SELECT COUNT(*) AS n FROM actor_audit').get() as { n: number }).n;
        const rows = audited();
        expect((await s.send('/deals')).status).toBe(401);
        expect(f.task.seen.length).toBe(before);
        expect(audited()).toBe(rows);
    });

    it('refuses a socio session without the proof, with another audience’s credential, or for a plugin without the contract', async () => {
        const f = await fixture();
        const s = await f.session();
        const before = f.task.seen.length;
        expect((await s.send('/deals', { proof: null })).status).toBe(401);
        expect((await s.send('/deals', { proof: s.proof('GET', '/other') })).status).toBe(401);
        // The calendar's credential on the CRM's host.
        const cal = await f.grant('calendar', ['app:read']);
        const context = await f.platform.actors.contexts.open({
            grant: cal,
            kind: 'browser',
            audience: 'plugin:calendar',
            correlationId: 'test',
        });
        const { token } = await f.platform.actors.credentials.issue({
            grant: cal,
            kind: 'cbsa',
            audiences: ['plugin:calendar'],
            contextId: context.id,
            holder: { kind: 'context', id: context.id },
            correlationId: 'test',
        });
        expect(
            (
                await f.app.request(`${f.crmOrigin}/deals`, {
                    headers: {
                        authorization: `Bearer ${token}`,
                        'x-cb-context': signContextProof(f.platform.actors.contextKey(context.id), {
                            method: 'GET',
                            host: f.crmHost,
                            requestTarget: '/deals',
                            bodyDigest: '',
                        }),
                    },
                })
            ).status,
        ).toBe(401);
        expect(f.task.seen.length).toBe(before);
        // A plugin whose manifest lost the contract: the grant no longer passes.
        const g = await fixture({ delegation: null });
        const policyless = await g.platform.actors.grants.create({
            personId: 'bob',
            socioId: g.dot.id,
            audiences: ['plugin:crm'],
            scopes: ['app:read'],
            conversationId: g.chats.bob.id,
            conversationKind: 'private',
            task: 'Look',
            policyVersion: 'anything',
            approvedBy: 'bob',
            correlationId: 'test',
        });
        expect(await g.platform.actors.authorizer.authorizeGrant(policyless.id)).toEqual({
            allowed: false,
            reason: 'audience_unavailable',
        });
    });

    it('gives a socio session the envelope with act and scp, signed for the ingress, and never a legacy header', async () => {
        const f = await fixture();
        const s = await f.session(['app:read']);
        const response = await s.send('/deals?a=1');
        expect(response.status).toBe(200);
        const { url, headers } = lastSeen(f);
        expect(url).toBe('/deals?a=1');
        for (const name of [
            'authorization',
            'cookie',
            'x-cb-user',
            'x-cb-access',
            'x-cb-person',
            'x-cb-context',
            RUNTIME_HEADER_SIG,
            RUNTIME_HEADER_KEY,
        ]) {
            expect(headers[name]).toBeUndefined();
        }
        expect(headers['x-cb-time-zone']).toBeTruthy();
        const sdk = f.sdk();
        const verdict = sdk.verify({
            method: 'GET',
            target: url,
            header: headers['x-cb-actor'] as string,
        }) as {
            ok: true;
            principal: Parameters<ReturnType<typeof socioApp>['authorize']>[0];
        };
        expect(verdict).toMatchObject({
            ok: true,
            principal: { access: 'space', socio: { scopes: ['app:read'] } },
        });
        expect(sdk.authorize(verdict.principal, 'deals.view')).toMatchObject({
            ok: true,
        });
        expect(sdk.authorize(verdict.principal, 'deals.update')).toMatchObject({
            ok: false,
        });
        // The socio's cbob_ opens for this plugin only, and a read grant reads.
        const obo = (verdict.principal as { obo?: string }).obo!;
        expect((await f.callback('GET', obo)).status).toBe(404);
        expect(await f.plugins.serviceCaller('crm', obo, 'GET')).toMatchObject({
            ok: true,
            user: { id: 'bob' },
        });
        // ... and can't write through the plugin's own call back.
        const write = await f.callback('POST', obo);
        expect(write.status).toBe(403);
        expect(denies(f, 'scope_insufficient').length).toBeGreaterThan(0);
        expect(f.platform.actors.credentials.openObo(obo, 'crm')).toBeUndefined();
    });

    it('gives a person’s session a signed envelope and x-cb-person, both covered by the ingress signature', async () => {
        const f = await fixture();
        const cookie = await f.signIn('bob');
        const response = await f.app.request(`${f.crmOrigin}/deals`, {
            headers: { cookie, 'x-cb-user': 'forged', 'x-cb-person': 'forged' },
        });
        expect(response.status).toBe(200);
        const { url, headers } = lastSeen(f);
        expect(headers['x-cb-user']).toBe(f.plugins.personId('crm', 'bob'));
        expect(headers['x-cb-access']).toBe('owner');
        expect(headers['x-cb-parent-origin']).toBe('http://localhost:4310');
        expect(
            verifyPluginPerson(pluginProof(RUNTIME, 'crm'), 'crm', headers[PLUGIN_PERSON_HEADER] as string),
        ).toMatchObject({ id: 'bob', role: 'member' });
        const verdict = f.sdk().verify({
            method: 'GET',
            target: url,
            header: headers['x-cb-actor'] as string,
        }) as { ok: true; principal: { person: string; obo: string } };
        expect(verdict).toMatchObject({
            ok: true,
            principal: { person: headers['x-cb-user'], access: 'space' },
        });
        expect(verdict.principal).not.toHaveProperty('socio');
        // The person's cbob_: the plugin's call back acts as them, not an admin.
        expect(await f.plugins.serviceCaller('crm', verdict.principal.obo, 'POST')).toMatchObject({
            ok: true,
            user: { id: 'bob' },
        });
        // Signed out of the plugin: it is refused, never the service's reach.
        await f.plugins.endAccessOf('bob');
        expect(await f.plugins.serviceCaller('crm', verdict.principal.obo, 'GET')).toMatchObject({
            ok: false,
            status: 403,
        });
        // Garbage, and another plugin's audience.
        expect(await f.plugins.serviceCaller('crm', 'cbob_v1.nope', 'GET')).toMatchObject({ ok: false, status: 403 });
    });

    it('sends no envelope while the flag is off for the person', async () => {
        const f = await fixture({ flag: false });
        const cookie = await f.signIn('bob');
        await f.app.request(`${f.crmOrigin}/deals`, { headers: { cookie } });
        const { headers } = lastSeen(f);
        expect(headers['x-cb-actor']).toBeUndefined();
        expect(headers['x-cb-user']).toBe(f.plugins.personId('crm', 'bob'));
    });

    it('the ingress passes a plugin no unsigned identity header, and none under a wrong signature', async () => {
        const f = await fixture();
        const send = (headers: Record<string, string>) =>
            new Promise<number>((resolve, reject) => {
                const req = httpRequest(
                    {
                        host: '127.0.0.1',
                        port: f.ingressPort,
                        path: '/deals',
                        method: 'GET',
                        headers: {
                            [RUNTIME_HEADER_APP]: 'crm',
                            [RUNTIME_HEADER_KEY]: ingressKey(RUNTIME),
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
        const legacy = {
            'x-cb-user': 'u',
            'x-cb-access': 'owner',
            'x-cb-person': 'p',
            'x-cb-time-zone': 'UTC',
            'x-cb-parent-origin': 'https://evil.example',
        };
        expect(await send(legacy)).toBe(200);
        const unsigned = lastSeen(f).headers;
        for (const name of Object.keys(legacy)) {
            expect(unsigned[name]).toBeUndefined();
        }
        // A signature over other values: nothing passes.
        expect(
            await send({
                ...legacy,
                [RUNTIME_HEADER_SIG]: identitySignature(RUNTIME, 'crm', 'GET', '/deals', {
                    ...legacy,
                    'x-cb-user': 'other',
                }),
            }),
        ).toBe(200);
        expect(lastSeen(f).headers['x-cb-user']).toBeUndefined();
        // Signed: they pass.
        expect(
            await send({
                ...legacy,
                [RUNTIME_HEADER_SIG]: identitySignature(RUNTIME, 'crm', 'GET', '/deals', legacy),
            }),
        ).toBe(200);
        expect(lastSeen(f).headers['x-cb-user']).toBe('u');
    });

    it('puts the envelope key in the plugin’s tasks, and serves socio sessions on the internal listener', async () => {
        const body = swarmServiceBody({
            id: 'crm',
            image: IMAGE,
            spec: { image: IMAGE, port: 8080 },
            replicas: 1,
            networkId: 'net',
            proof: pluginProof(RUNTIME, 'crm'),
            actorKey: pluginActorKey(RUNTIME, 'crm'),
        });
        expect(body.TaskTemplate.ContainerSpec.Env).toEqual(
            expect.arrayContaining([`CB_ACTOR_KEY=${pluginActorKey(RUNTIME, 'crm')}`, 'CB_APP_ID=plugin:crm']),
        );
        expect(pluginActorKey(RUNTIME, 'crm')).not.toBe(pluginActorKey(RUNTIME, 'other'));
        const f = await fixture();
        const internal = createAppsInternalServer(f.platform.apps, {
            port: 0,
            host: '127.0.0.1',
            // Loopback, explicitly: the listener refuses all without a subnet.
            subnets: ['127.0.0.0/8'],
        })!;
        await internal.listen();
        cleanup.push(() => internal.close());
        const port = (internal.server.address() as AddressInfo).port;
        const send = (headers: Record<string, string>) =>
            new Promise<number>((resolve, reject) => {
                const req = httpRequest({ host: '127.0.0.1', port, path: '/deals', method: 'GET', headers }, (res) => {
                    res.resume();
                    res.on('end', () => resolve(res.statusCode ?? 0));
                });
                req.on('error', reject);
                req.end();
            });
        const s = await f.session();
        // A person's cookie: never on this listener.
        expect(await send({ host: f.crmHost, cookie: await f.signIn() })).toBe(401);
        expect(
            await send({
                host: f.crmHost,
                authorization: `Bearer ${s.token}`,
                'x-cb-context': s.proof('GET', '/deals'),
            }),
        ).toBe(200);
        expect(lastSeen(f).headers['x-cb-actor']).toBeTruthy();
    });
});

describe('a plugin service’s calls back into Socio', () => {
    it('a contract plugin can’t write without x-cb-obo; reads stay its own', async () => {
        const f = await fixture();
        expect(await f.plugins.serviceCaller('crm', undefined, 'POST')).toEqual({
            ok: false,
            status: 403,
            error: expect.stringMatching(/x-cb-obo/),
        });
        expect((await f.callback('POST')).status).toBe(403);
        expect(await f.plugins.serviceCaller('crm', undefined, 'GET')).toMatchObject({
            ok: true,
            user: { id: 'alice' },
        });
        // Without the contract, as before: the service's own background reach.
        const g = await fixture({ delegation: null });
        expect(await g.plugins.serviceCaller('crm', undefined, 'POST')).toMatchObject({
            ok: true,
            user: { id: 'alice' },
        });
    });
});

describe('the legacy plugin scopes stay limited', () => {
    it('cover the planner only, and are never a socio’s scope', async () => {
        expect(LEGACY_SCOPE_PLUGINS).toEqual(['social-strategy']);
        expect(pluginToolScopes('calendar', 'calendar:read')).toEqual(['plugins:calendar:read']);
        expect(pluginToolScopes('crm', 'crm:write')).toEqual(['plugins:crm:write']);
        expect(pluginToolScopes('social-strategy', 'social:write')).toEqual([
            'plugins:social-strategy:write',
            'plugins:write',
        ]);
        // Not in the closed actor scope list: a grant can't carry them.
        expect(closeScopes(['plugins:read', 'plugins:write', 'plugins:calendar:write'])).toEqual([]);
        const f = await fixture();
        const names = (scopes: string[]) => {
            const registered: string[] = [];
            f.plugins.contributeMcp({ registerTool: (name: string) => registered.push(name) } as never, {
                person: USERS[1]!,
                origin: '',
                scopes,
            });
            return registered;
        };
        expect(names(['plugins:read', 'plugins:write'])).toEqual([]);
        expect(names(['plugins:calendar:read'])).toEqual(['list_events']);
    });
});

describe('consequential plugin actions and continuations', () => {
    const PARAMS = { to: '+15550100', text: 'Your order shipped.' };
    const digestOf = (params: unknown = PARAMS, id = 'crm') => intentDigest(`plugin:${id}`, 'sms.send', params);
    const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

    it('refuses a call without the plugin’s token and proof, with another plugin’s proof, or as a person', async () => {
        const f = await fixture({ second: true });
        const g = await f.grant('crm', ['app:act']);
        const obo = f.oboFor(g.id);
        const body = { action: 'sms.send', params: PARAMS };
        for (const over of [
            { token: null, as: null },
            { as: null },
            { token: null },
            { token: 'plugin-service-token-wrong' },
            // The leads plugin's own proof can't call as the CRM.
            { as: 'leads' },
        ]) {
            expect((await f.actorCall('/approvals', body, { obo, ...over })).status).toBe(401);
        }
        // A person's session (an admin's, even) never reaches these routes.
        const login = await f.app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 'alice' }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        const asPerson = await f.app.request('http://localhost:4310/api/plugins/crm/actor/approvals', {
            method: 'POST',
            headers: {
                cookie,
                'content-type': 'application/json',
                'x-cb-obo': obo,
            },
            body: JSON.stringify(body),
        });
        expect(asPerson.status).toBe(401);
        // A bundled plugin has no service to call.
        expect(
            (
                await f.actorCall('/approvals', body, {
                    obo,
                    plugin: 'calendar',
                })
            ).status,
        ).toBe(401);
        expect(await f.platform.approvals.list('bob')).toEqual([]);
    });

    it('refuses another plugin’s or an app’s cbob_, a continuation, and a person’s cbob_', async () => {
        const f = await fixture({ second: true });
        const crm = await f.grant('crm', ['app:act']);
        const leads = await f.grant('leads', ['app:act']);
        const body = { action: 'sms.send', params: PARAMS };
        // The leads plugin's cbob_ opens only for plugin:leads.
        expect(
            (
                await f.actorCall('/approvals', body, {
                    obo: f.oboFor(leads.id, 'leads'),
                })
            ).status,
        ).toBe(403);
        // An app's cbob_ for an app of the same id, even for this grant.
        const appObo = f.platform.actors.credentials.mintObo({
            appId: 'crm',
            grantId: crm.id,
            requestId: 'r1',
            ttlMs: 60_000,
        });
        expect((await f.actorCall('/approvals', body, { obo: appObo })).status).toBe(403);
        expect((await f.actorCall('/approvals', body)).status).toBe(403);
        // A continuation asks for nothing: a job can't create approvals.
        const answer = await f.actorCall('/continuations', { minutes: 10 }, { obo: f.oboFor(crm.id) });
        expect(answer.status).toBe(200);
        const { continuation } = (await answer.json()) as { continuation: string };
        expect((await f.actorCall('/approvals', body, { obo: continuation })).status).toBe(403);
        expect((await f.actorCall('/continuations', { minutes: 5 }, { obo: continuation })).status).toBe(403);
        // A person acts for themselves.
        const person = f.plugins.actors!.mintObo('crm', { sessionHash: 'h'.repeat(43) }, 'r2', 60_000);
        const own = await f.actorCall('/approvals', body, { obo: person });
        expect(own.status).toBe(400);
        expect(await json(own)).toMatchObject({
            error: expect.stringMatching(/approvals are for socios/),
        });
        expect(await f.platform.approvals.list('bob')).toEqual([]);
    });

    it('checks the tier, app:act, the size and the cap, and tells the plugin no security reason', async () => {
        const f = await fixture();
        const reader = await f.grant('crm', ['app:read']);
        const writer = await f.grant('crm', ['app:write']);
        const actor = await f.grant('crm', ['app:act']);
        const ask = (grantId: string, body: Record<string, unknown>) =>
            f.actorCall('/approvals', body, { obo: f.oboFor(grantId) });
        for (const grantId of [reader.id, writer.id]) {
            const refused = await ask(grantId, {
                action: 'sms.send',
                params: PARAMS,
            });
            expect(refused.status).toBe(403);
            const body = await json(refused);
            expect(body).not.toHaveProperty('reason');
            expect(JSON.stringify(body)).not.toMatch(/scope_insufficient/);
        }
        const write = await ask(actor.id, {
            action: 'deals.update',
            params: PARAMS,
        });
        expect(write.status).toBe(400);
        expect(await json(write)).toMatchObject({ reason: 'not_consequential' });
        // admin is never a socio's; an undeclared action is nobody's.
        for (const action of ['settings.update', 'sms.blast', 'toString']) {
            const refused = await ask(actor.id, { action, params: PARAMS });
            expect(refused.status).toBe(403);
            expect(await json(refused)).not.toHaveProperty('reason');
        }
        // data:<op> names Socio's data API; a plugin has its own data routes.
        const data = await ask(actor.id, {
            action: 'data:files.delete',
            params: { path: 'x.csv' },
        });
        expect(data.status).toBe(400);
        expect(await json(data)).toMatchObject({
            reason: 'request_malformed',
            error: expect.stringMatching(/for mini apps/),
        });
        expect(
            (
                await ask(actor.id, {
                    action: 'sms.send',
                    params: PARAMS,
                    digest: '0'.repeat(64),
                })
            ).status,
        ).toBe(400);
        // The app's digest (an app of the same id) isn't the plugin's.
        expect(
            (
                await ask(actor.id, {
                    action: 'sms.send',
                    params: PARAMS,
                    digest: intentDigest('crm', 'sms.send', PARAMS),
                })
            ).status,
        ).toBe(400);
        const big = await ask(actor.id, {
            action: 'sms.send',
            params: { text: 'y'.repeat(70_000) },
        });
        expect(big.status).toBe(413);
        expect(await json(big)).toMatchObject({ reason: 'params_too_large' });
        for (const to of ['a', 'b', 'c']) {
            expect((await ask(actor.id, { action: 'sms.send', params: { to } })).status).toBe(202);
        }
        const capped = await ask(actor.id, {
            action: 'sms.send',
            params: { to: 'd' },
        });
        expect(capped.status).toBe(409);
        expect(await json(capped)).toMatchObject({ reason: 'limit_reached' });
        // The audit keeps why.
        await vi.waitFor(() =>
            expect(
                f.platform.actors.audit
                    .list({})
                    .filter((row) => row.phase === 'approval' && row.decision === 'deny')
                    .map((row) => [row.audience, row.reason]),
            ).toEqual(
                expect.arrayContaining([
                    ['plugin:crm', 'scope_insufficient'],
                    ['plugin:crm', 'admin_tier'],
                    ['plugin:crm', 'action_undeclared'],
                ]),
            ),
        );
    });

    it('is consumed once, for its grant, plugin and digest: never by another plugin or an app', async () => {
        const f = await fixture({ second: true });
        const actor = await f.grant('crm', ['app:act']);
        const other = await f.grant('crm', ['app:act'], {
            conversationId: f.chats.bobOther.id,
        });
        const leads = await f.grant('leads', ['app:act']);
        const digest = digestOf();
        const made = await f.actorCall(
            '/approvals',
            {
                action: 'sms.send',
                params: { text: PARAMS.text, to: PARAMS.to },
                digest,
                display: { Summary: 'Text Dana' },
            },
            { obo: f.oboFor(actor.id) },
        );
        expect(made.status).toBe(202);
        const pending = (await made.json()) as { approval: string; status: string };
        expect(pending).toMatchObject({ status: 'pending', digest });
        // The card names the plugin by its platform facts.
        const [card] = await f.platform.approvals.list('bob');
        expect(card).toMatchObject({
            id: pending.approval,
            capability: SOCIO_ACCESS_CAPABILITIES.action,
        });
        expect(JSON.stringify(card)).toContain('your workspace (an installed plugin)');
        const consume = (over: { obo?: string; digest?: string; plugin?: string } = {}) =>
            f.actorCall(
                `/approvals/${pending.approval}/consume`,
                { digest: over.digest ?? digest },
                {
                    obo: over.obo ?? f.oboFor(actor.id),
                    ...(over.plugin ? { plugin: over.plugin } : {}),
                },
            );
        // Not yet approved.
        expect((await consume()).status).toBe(409);
        await f.platform.approvals.decide(pending.approval, 'bob', true);
        // Another plugin, with its own grant, the same id and digest.
        expect(
            (
                await consume({
                    plugin: 'leads',
                    obo: f.oboFor(leads.id, 'leads'),
                })
            ).status,
        ).toBe(409);
        expect(
            (
                await consume({
                    plugin: 'leads',
                    obo: f.oboFor(leads.id, 'leads'),
                    digest: digestOf(PARAMS, 'leads'),
                })
            ).status,
        ).toBe(409);
        // An app of the same id, with this very grant and either digest.
        for (const appDigest of [digest, intentDigest('crm', 'sms.send', PARAMS)]) {
            expect(
                await consumeAppAction(f.platform, {
                    appId: 'crm',
                    approvalId: pending.approval,
                    grantId: actor.id,
                    digest: appDigest,
                    correlationId: 'as-app',
                }),
            ).toBe(false);
        }
        // Nor the data API's kind of consume, for a plugin.
        expect(
            await consumeAppAction(f.platform, {
                audience: 'plugin:crm',
                approvalId: pending.approval,
                grantId: actor.id,
                digest,
                correlationId: 'as-data',
                kind: 'data',
            }),
        ).toBe(false);
        // Another grant of this plugin; changed parameters.
        expect((await consume({ obo: f.oboFor(other.id) })).status).toBe(409);
        expect((await consume({ digest: digestOf({ ...PARAMS, to: '+15550199' }) })).status).toBe(409);
        // Concurrent consumes: exactly one wins.
        const results = await Promise.all([consume(), consume(), consume()]);
        expect(results.map((result) => result.status).sort()).toEqual([200, 409, 409]);
        expect((await consume()).status).toBe(409);
        await vi.waitFor(() =>
            expect(
                f.platform.actors.audit
                    .list({ personId: 'bob' })
                    .filter((row) => row.status === 'consumed')
                    .map((row) => [row.audience, row.digest]),
            ).toEqual([['plugin:crm', digest]]),
        );
    });

    it('a revoked grant can neither ask nor consume; the flag off asks nothing', async () => {
        const f = await fixture();
        const actor = await f.grant('crm', ['app:act']);
        const made = await f.actorCall(
            '/approvals',
            { action: 'sms.send', params: PARAMS },
            { obo: f.oboFor(actor.id) },
        );
        const { approval } = (await made.json()) as { approval: string };
        await f.platform.approvals.decide(approval, 'bob', true);
        await f.platform.actors.revoke({ grantId: actor.id }, 'bob', 'person_revoked');
        const asked = await f.actorCall(
            '/approvals',
            { action: 'sms.send', params: { to: 'x' } },
            { obo: f.oboFor(actor.id) },
        );
        expect(asked.status).toBe(403);
        expect(JSON.stringify(await json(asked))).not.toMatch(/revoked_|grant_/);
        expect(
            (await f.actorCall(`/approvals/${approval}/consume`, { digest: digestOf() }, { obo: f.oboFor(actor.id) }))
                .status,
        ).toBe(409);
        // Dark: with socio-actor-access off for the person, nothing is asked.
        const off = await fixture({ flag: false });
        const g = await off.grant('crm', ['app:act']);
        expect(
            (await off.actorCall('/approvals', { action: 'sms.send', params: PARAMS }, { obo: off.oboFor(g.id) }))
                .status,
        ).toBe(403);
        expect(await off.platform.approvals.list('bob')).toEqual([]);
    });

    it('runs the SDK’s approval sequence end to end through the proxy (CB_APP_ID=plugin:<id>)', async () => {
        const f = await fixture();
        const s = await f.session(['app:act']);
        const sdk = socioApp({
            appId: 'plugin:crm',
            key: pluginActorKey(RUNTIME, 'crm'),
            actions: CRM_ACTIONS,
            env: {
                SOCIO_API_URL: 'http://localhost:4310',
                SOCIO_API_TOKEN: SERVICE,
                CB_PLUGIN_PROOF: pluginProof(RUNTIME, 'crm'),
            },
            fetch: ((input: string, init?: RequestInit) => f.app.request(input, init)) as unknown as typeof fetch,
        });
        const body = JSON.stringify(PARAMS);
        const send = (approval?: string) =>
            f.app.request(`${f.crmOrigin}/sms`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${s.token}`,
                    'x-cb-context': s.proof('POST', '/sms', body),
                    'content-type': 'application/json',
                    ...(approval ? { 'x-cb-approval': approval } : {}),
                },
                body,
            });
        const principal = () => {
            const { url, headers } = lastSeen(f);
            const verdict = sdk.verify({
                method: 'POST',
                target: url,
                header: headers['x-cb-actor'] as string,
                approval: headers['x-cb-approval'] as string | undefined,
            });
            if (!verdict.ok) {
                throw new Error(verdict.reason);
            }
            return verdict.principal;
        };
        expect((await send()).status).toBe(200);
        const first = await sdk.requireApproval(principal(), 'sms.send', PARAMS, {
            Summary: 'Text a customer',
        });
        expect(first).toMatchObject({ ok: false, status: 202 });
        const approval = (first as { approval: string }).approval;
        await f.platform.approvals.decide(approval, 'bob', true);
        // The repeated request names it; the proxy passes it on, signed.
        expect((await send(approval)).status).toBe(200);
        const repeated = principal();
        expect(repeated.approval).toBe(approval);
        // Changed parameters can't use it.
        expect(await sdk.requireApproval(repeated, 'sms.send', { ...PARAMS, to: 'all' })).toMatchObject({
            ok: false,
            status: 409,
        });
        expect(await sdk.requireApproval(repeated, 'sms.send', PARAMS)).toEqual({
            ok: true,
            approval,
        });
        expect(await sdk.requireApproval(repeated, 'sms.send', PARAMS)).toMatchObject({ ok: false, status: 409 });
        // A plugin's data routes take no data approvals.
        await expect(sdk.requestDataApproval(repeated, 'files.delete', { path: 'x' })).rejects.toThrow(/for mini apps/);
    });

    it('gives a socio a continuation its grant holds, which the plugin’s data routes re-authorize on every use', async () => {
        const f = await fixture({ second: true });
        const reader = await f.grant('crm', ['app:read']);
        const answer = await f.actorCall('/continuations', { minutes: 30 }, { obo: f.oboFor(reader.id) });
        expect(answer.status).toBe(200);
        const { continuation, expiresAt } = (await answer.json()) as {
            continuation: string;
            expiresAt: number;
        };
        expect(continuation).toMatch(/^cbob_[A-Za-z0-9_-]{43}$/);
        expect(expiresAt).toBeLessThanOrEqual(reader.expiresAt);
        expect((await f.actorCall('/continuations', { minutes: 0 }, { obo: f.oboFor(reader.id) })).status).toBe(400);
        // Reads as the person; can't write past its grant's scope.
        expect(await f.plugins.serviceCaller('crm', continuation, 'GET')).toMatchObject({
            ok: true,
            user: { id: 'bob' },
            grantId: reader.id,
        });
        expect((await f.callback('GET', continuation)).status).toBe(404);
        expect(await f.plugins.serviceCaller('crm', continuation, 'POST')).toMatchObject({ ok: false, status: 403 });
        expect((await f.callback('POST', continuation)).status).toBe(403);
        // Another plugin's data routes don't take it.
        expect(await f.plugins.serviceCaller('leads', continuation, 'GET')).toMatchObject({ ok: false, status: 403 });
        // A forged reference token is nobody's.
        expect(await f.plugins.serviceCaller('crm', `cbob_${'A'.repeat(43)}`, 'GET')).toMatchObject({
            ok: false,
            status: 403,
        });
        // Revoking the grant stops the job at its next call.
        await f.platform.actors.revoke({ grantId: reader.id }, 'bob', 'person_revoked');
        expect(await f.plugins.serviceCaller('crm', continuation, 'GET')).toMatchObject({ ok: false, status: 403 });
        expect((await f.actorCall('/continuations', { minutes: 5 }, { obo: f.oboFor(reader.id) })).status).toBe(403);
        await vi.waitFor(() =>
            expect(
                f.platform.actors.audit.list({}, 500).filter(
                    (row) =>
                        row.audience === 'plugin:crm' &&
                        row.action === 'data.read' &&
                        // Revoking drops the grant's credentials with it.
                        ['grant_revoked', 'credential_invalid'].includes(row.reason ?? ''),
                ).length,
            ).toBeGreaterThan(0),
        );
    });

    it('gives a person’s request a continuation that ends with their plugin session', async () => {
        const f = await fixture();
        const cookie = await f.signIn('bob');
        await f.app.request(`${f.crmOrigin}/deals`, { headers: { cookie } });
        const verdict = f.sdk().verify({
            method: 'GET',
            target: '/deals',
            header: lastSeen(f).headers['x-cb-actor'] as string,
        });
        const obo = (verdict as { principal: { obo: string } }).principal.obo;
        expect((await f.actorCall('/continuations', { minutes: 600 }, { obo })).status).toBe(400);
        const answer = await f.actorCall('/continuations', { minutes: 60 }, { obo });
        expect(answer.status).toBe(200);
        const { continuation } = (await answer.json()) as { continuation: string };
        expect(f.platform.actors.credentials.openObo(continuation, 'plugin:crm')).toMatchObject({
            sessionHash: expect.any(String),
        });
        expect(await f.plugins.serviceCaller('crm', continuation, 'POST')).toMatchObject({
            ok: true,
            user: { id: 'bob' },
        });
        // Narrowing the audience to admins ends what the person's session reaches.
        await f.plugins.setAudience('crm', 'admins', 'alice');
        expect(await f.plugins.serviceCaller('crm', continuation, 'POST')).toMatchObject({ ok: false, status: 403 });
        expect((await f.actorCall('/continuations', { minutes: 5 }, { obo })).status).toBe(403);
    });
});
