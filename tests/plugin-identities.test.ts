import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';
import { renamedSetting, retiredSetting } from '@socio/foundation/settings/renamed-setting';
import { identitySecretName, PLUGIN_IDENTITY_TOKEN } from '@socio/shared/identity-delivery';
import { pluginServiceName } from '@socio/shared/plugins/plugin-service';
import type { WorkspaceSecretsState } from '@socio/shared/workspace-secrets';

import { socioApp } from '../packages/app-sdk/src/index.js';
import { MemoryDocker } from '../src/apps-runtime/docker.js';
import { SwarmIdentityDelivery } from '../src/apps-runtime/identity-delivery.js';
import { pluginProof } from '../src/apps-runtime/keys.js';
import { PluginServices } from '../src/apps-runtime/services.js';
import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import type { PluginRuntime } from '../src/server/plugins/contract.js';
import {
    PLUGIN_IDENTITY_OVERLAP_MS,
    PluginIdentities,
    pluginServiceTokenFromEnv,
} from '../src/server/plugins/identity.js';

import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// Socio Secrets phase 2:
// each plugin service has its own identity token, delivered by the
// runtime's adapter; a call or a secret read is attributed to and
// authorized for exactly that plugin; the shared PLUGIN_SERVICE_TOKEN is
// accepted for one more release with a warning.

const SECRET = 'plugin-identities-runtime-secret-0123456789';
const SESSION = 'plugin-identities-session-secret-0123456789';
const SHARED = 'shared-plugin-service-token-0123456789abc';
const VALUE = 'sk_live_PluginValue0123456789abcdef';
const IMAGE = (name: string) => `company-brain-plugin-${name}@sha256:${'a'.repeat(64)}`;

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const pluginManifest = (id: string, secrets?: unknown[]) => ({
    id,
    name: id === 'sync' ? 'Bookings sync' : 'Reports',
    version: '1.0.0',
    author: 'Socio tests',
    description: 'A test plugin',
    display: 'tab',
    permissions: [],
    service: { image: IMAGE(id), port: 8080, env: { SOCIO_API_URL: 'http://app:4310' } },
    ...(secrets ? { secrets } : {}),
});

async function world(options: { failProvision?: () => boolean; legacyRuntime?: () => boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'socio-plugin-identities-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const catalog = join(dir, 'catalog.json');
    writeFileSync(
        catalog,
        JSON.stringify({
            plugins: [
                pluginManifest('sync', [
                    { name: 'STRIPE_API_KEY', required: true, description: 'Charges cards' },
                    { name: 'SLACK_WEBHOOK', required: false },
                ]),
                pluginManifest('reports', [{ name: 'STRIPE_API_KEY' }]),
            ],
        }),
    );
    const engine = new MemoryDocker();
    const services = new PluginServices(engine, {
        allow: ['company-brain-plugin-'],
        maxReplicas: 5,
        secret: SECRET,
        pull: false,
        identity: new SwarmIdentityDelivery(engine),
    });
    const provisions: Array<{ id: string; version?: number }> = [];
    const runtime: PluginRuntime = {
        provisionService: async (id, spec, identity) => {
            provisions.push({ id, ...(identity ? { version: identity.version } : {}) });
            if (options.failProvision?.()) {
                throw new Error('The runtime refused.');
            }
            // An older runtime ignores the identity (before phase 2).
            return services.ensure(id, spec, options.legacyRuntime?.() ? undefined : identity);
        },
        scaleService: (id, replicas) => services.scale(id, replicas),
        removeService: (id) => services.remove(id),
        serviceStatus: (id) => services.status(id),
    };
    const logs: string[] = [];
    const runnerConfig = { mode: 'live' as const, baseUrl: '' };
    const {
        app: http,
        workspace,
        platform,
        dispose,
    } = await makeTestRuntime({
        config: {
            sessionSecret: SESSION,
            data: { userDataDir: dir },
            apps: appsSettingsFromEnv({ APPS_HOST: 'apps.example' }, 'https://brain.example'),
            appsRuntime: { url: 'http://127.0.0.1:9', token: SECRET, ingress: { host: '127.0.0.1', port: 9 } },
            plugins: { catalogs: [{ kind: 'file', path: catalog }], runtime, serviceToken: SHARED },
        },
        app: {
            config: runnerConfig,
            auth: { provider: new MockAuthProvider(DEFAULT_MOCK_USERS, SESSION), secureCookies: false },
        },
    });
    cleanup.push(dispose);
    platform.context.log = () => {};
    // The plugin service logs through its own option; capture it.
    (platform.plugins as unknown as { options: { log: (line: string) => void } }).options.log = (line) =>
        logs.push(line);
    platform.plugins.useActiveUsers(() => DEFAULT_MOCK_USERS);
    const as = async (userId: string) => {
        const login = await http.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        return async (method: string, path: string, body?: unknown) => {
            const response = await http.request(`/api${path}`, {
                method,
                headers: { cookie, 'Content-Type': 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return { status: response.status, text: await response.text() };
        };
    };
    /** The token the runtime delivered for a plugin: the Swarm secret's data, as the task would read it. */
    const delivered = (id: string) => {
        const spec = engine.specNamed(pluginServiceName(id));
        const ref = spec?.TaskTemplate.ContainerSpec.Secrets?.find((secret) => secret.File.Name === 'socio_identity');
        const created = ref && engine.created.get(ref.SecretID);
        return created ? Buffer.from(created.Data, 'base64').toString('utf8') : undefined;
    };
    const read = async (token: string | undefined, proof: string | undefined, path: string) => {
        const response = await http.request(`/api/workload/secrets${path}`, {
            headers: {
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...(proof ? { 'x-cb-plugin-proof': proof } : {}),
            },
        });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const audit = () =>
        workspace.db
            .prepare(
                "SELECT actor, action, detail FROM workspace_audit WHERE targetKind='workspace_secret' ORDER BY id",
            )
            .all()
            .map((row) => ({ ...row })) as Array<{ actor: string; action: string; detail: string }>;
    return { platform, workspace, http, engine, as, delivered, read, audit, logs, provisions };
}

it('issues, rotates with an overlap, abandons and revokes identity tokens, stored hashed', async () => {
    const db = testDatabase();
    cleanup.push(() => db.close());
    let now = 1_800_000_000_000;
    const identities = new PluginIdentities(db, () => now);

    const first = (await identities.issue('sync'))!;
    expect(first.version).toBe(1);
    expect(first.token).toMatch(PLUGIN_IDENTITY_TOKEN);
    expect(identities.verify(first.token)).toEqual({ pluginId: 'sync', version: 1 });
    // Only the hash is stored.
    const stored = JSON.stringify(db.prepare('SELECT * FROM plugin_identities').all());
    expect(stored).not.toContain(first.token);
    expect(identities.verify('cbpi_' + 'x'.repeat(43))).toBeUndefined();
    expect(identities.verify(undefined)).toBeUndefined();
    // Another plugin's tokens are its own.
    const other = (await identities.issue('reports'))!;
    expect(identities.verify(other.token)?.pluginId).toBe('reports');
    // The migration of running plugins issues only where none is current.
    expect(await identities.issue('sync', { onlyIfMissing: true })).toBeUndefined();

    // A rotation: the old one is accepted until the window ends.
    const second = (await identities.issue('sync'))!;
    expect(second.version).toBe(2);
    expect(identities.current('sync')).toBe(2);
    expect(identities.verify(first.token)?.version).toBe(1);
    now += PLUGIN_IDENTITY_OVERLAP_MS + 1;
    expect(identities.verify(first.token)).toBeUndefined();
    expect(identities.verify(second.token)?.version).toBe(2);

    // A provision that failed: its version retires, the running one is current again.
    const third = (await identities.issue('sync'))!;
    await identities.abandon('sync', third.version);
    expect(identities.verify(third.token)).toBeUndefined();
    expect(identities.current('sync')).toBe(2);
    expect(identities.verify(second.token)?.version).toBe(2);

    // Uninstall: every version stops at once; the rows stay as the record.
    await identities.revoke('sync');
    expect(identities.verify(second.token)).toBeUndefined();
    expect(identities.current('sync')).toBeUndefined();
    expect(identities.verify(other.token)?.pluginId).toBe('reports');
    expect(Number(db.prepare("SELECT count(*) n FROM plugin_identities WHERE pluginId='sync'").get()!.n)).toBe(3);
});

it('delivers each plugin its own identity and attributes a call to exactly that plugin', async () => {
    const { platform, engine, delivered, logs } = await world();
    await platform.plugins.install('sync');
    await platform.plugins.install('reports');
    const sync = delivered('sync')!;
    const reports = delivered('reports')!;
    expect(sync).toMatch(PLUGIN_IDENTITY_TOKEN);
    expect(reports).toMatch(PLUGIN_IDENTITY_TOKEN);
    expect(sync).not.toBe(reports);
    // The service knows where to read it, and the secret carries the plugin's labels.
    const spec = engine.specNamed(pluginServiceName('sync'))!;
    expect(spec.TaskTemplate.ContainerSpec.Env).toContain('SOCIO_IDENTITY_FILE=/run/secrets/socio_identity');
    expect(spec.Labels['socio.identity']).toBe('1');
    expect(engine.created.get(engine.secrets.get(identitySecretName('sync', 1))!)?.Labels).toEqual({
        'socio.managed': 'plugin',
        'socio.plugin': 'sync',
    });
    // The env and the stored spec never hold the token itself.
    expect(JSON.stringify(spec)).not.toContain(sync);

    const proof = (id: string) => pluginProof(SECRET, id);
    expect(platform.plugins.acceptsServiceCall('sync', sync, proof('sync'))).toBe(true);
    // Its token with another plugin's id and proof is refused: one token, one plugin.
    expect(platform.plugins.acceptsServiceCall('reports', sync, proof('reports'))).toBe(false);
    // And without its proof.
    expect(platform.plugins.acceptsServiceCall('sync', sync, proof('reports'))).toBe(false);
    expect(platform.plugins.acceptsServiceCall('sync', sync, undefined)).toBe(false);
    expect(platform.plugins.workloadPlugin(sync, proof('sync'))).toBe('sync');
    expect(platform.plugins.workloadPlugin(sync, proof('reports'))).toBeUndefined();

    // The deprecated shared token still works with the proof, once warned per plugin.
    expect(platform.plugins.acceptsServiceCall('sync', SHARED, proof('sync'))).toBe(true);
    expect(platform.plugins.acceptsServiceCall('sync', SHARED, proof('sync'))).toBe(true);
    expect(logs.filter((line) => line.includes('PLUGIN_SERVICE_TOKEN'))).toHaveLength(1);
    expect(logs.join('\n')).not.toContain(SHARED);
    // ...but never for a secrets read.
    expect(platform.plugins.workloadPlugin(SHARED, proof('sync'))).toBeUndefined();

    // A disabled plugin's identity opens nothing.
    await platform.plugins.setEnabled('sync', false);
    expect(platform.plugins.acceptsServiceCall('sync', sync, proof('sync'))).toBe(false);
    expect(platform.plugins.workloadPlugin(sync, proof('sync'))).toBeUndefined();
});

it('rotates by replacing the secret, keeps the old token for the drain, and cleans up on uninstall', async () => {
    const { platform, engine, delivered } = await world();
    await platform.plugins.install('sync');
    const first = delivered('sync')!;
    expect(await platform.plugins.rotateIdentity('sync')).toEqual({ version: 2 });
    const second = delivered('sync')!;
    expect(second).not.toBe(first);
    // The service now mounts version 2 only; version 1's secret is gone.
    expect(engine.secrets.has(identitySecretName('sync', 2))).toBe(true);
    expect(engine.secrets.has(identitySecretName('sync', 1))).toBe(false);
    expect(engine.removedSecrets).toEqual([identitySecretName('sync', 1)]);
    // Old tasks still hold version 1 while they drain.
    const proof = pluginProof(SECRET, 'sync');
    expect(platform.plugins.acceptsServiceCall('sync', first, proof)).toBe(true);
    expect(platform.plugins.acceptsServiceCall('sync', second, proof)).toBe(true);
    // A save that leaves the service as it runs restarts nothing (CB-398
    // follow-up); applying it waits for nothing either.
    await platform.plugins.configure('sync', {});
    await platform.plugins.applySettings('sync');
    expect(platform.plugins.identities.current('sync')).toBe(2);
    // Enable rotates too: every provision delivers a new version.
    await platform.plugins.setEnabled('sync', false);
    await platform.plugins.setEnabled('sync', true);
    expect(platform.plugins.identities.current('sync')).toBe(3);
    expect(platform.plugins.acceptsServiceCall('sync', first, proof)).toBe(false);

    await platform.plugins.uninstall('sync');
    expect([...engine.secrets.keys()].filter((name) => name.includes('-wl-sync-'))).toEqual([]);
    expect(platform.plugins.identities.verify(second)).toBeUndefined();
    await expect(platform.plugins.rotateIdentity('sync')).rejects.toThrow(/not installed/);
});

it('keeps the running identity when a provision fails', async () => {
    let fail = false;
    const { platform, delivered, engine } = await world({ failProvision: () => fail });
    await platform.plugins.install('sync');
    const first = delivered('sync')!;
    fail = true;
    await expect(platform.plugins.rotateIdentity('sync')).rejects.toThrow(/refused/);
    expect(platform.plugins.identities.current('sync')).toBe(1);
    expect(platform.plugins.acceptsServiceCall('sync', first, pluginProof(SECRET, 'sync'))).toBe(true);
    expect(engine.secrets.has(identitySecretName('sync', 1))).toBe(true);
    // An install that fails leaves no live identity.
    await expect(platform.plugins.install('reports')).rejects.toThrow(/refused/);
    expect(platform.plugins.identities.current('reports')).toBeUndefined();
});

it('gives plugins installed before phase 2 their own identity, once, with no operator step', async () => {
    let legacy = true;
    const { platform, workspace, delivered, provisions, engine, logs } = await world({ legacyRuntime: () => legacy });
    // Installed by an older build: the service has no identity, Socio no rows.
    await platform.plugins.install('sync');
    workspace.db.prepare('DELETE FROM plugin_identities').run();
    expect(delivered('sync')).toBeUndefined();
    legacy = false;
    provisions.length = 0;
    expect(await platform.plugins.migrateIdentities()).toBe(1);
    expect(provisions).toEqual([{ id: 'sync', version: 1 }]);
    expect(platform.plugins.identities.verify(delivered('sync'))?.pluginId).toBe('sync');
    // Nothing more to do on the next tick.
    expect(await platform.plugins.migrateIdentities()).toBe(0);
    expect(provisions).toHaveLength(1);

    // A database restored from before that: Socio counts from 1 again while
    // the service mounts version 1. That attempt is refused (Swarm won't
    // drop a secret in use) and abandoned; the next one, version 2, lands.
    workspace.db.prepare('DELETE FROM plugin_identities').run();
    expect(await platform.plugins.migrateIdentities()).toBe(0);
    expect(logs.some((line) => line.includes('giving sync its identity failed'))).toBe(true);
    expect(await platform.plugins.migrateIdentities()).toBe(1);
    expect(platform.plugins.identities.current('sync')).toBe(2);
    expect(platform.plugins.identities.verify(delivered('sync'))?.version).toBe(2);
    expect(engine.secrets.has(identitySecretName('sync', 1))).toBe(false);
});

it('serves a plugin the secrets granted to it, by its identity, and audits it as the plugin', async () => {
    const { platform, http, as, delivered, read, audit } = await world();
    await platform.plugins.install('sync');
    await platform.plugins.install('reports');
    const admin = await as('alice');
    const sync = delivered('sync')!;
    const reports = delivered('reports')!;
    const proof = (id: string) => pluginProof(SECRET, id);

    // Settings → Secrets lists plugins with their needs.
    let state = JSON.parse((await admin('GET', '/workspace-secrets')).text) as WorkspaceSecretsState;
    expect(state.apps.find((entry) => entry.appId === 'plugin:sync')).toMatchObject({
        kind: 'plugin',
        name: 'Bookings sync',
        status: 'enabled',
        needsSetup: ['STRIPE_API_KEY'],
    });

    const created = JSON.parse(
        (await admin('POST', '/workspace-secrets', { name: 'STRIPE_API_KEY', value: VALUE })).text,
    ) as { id: string };
    // Not granted yet.
    expect((await read(sync, proof('sync'), '/STRIPE_API_KEY')).status).toBe(403);
    // Granted by its workload key (URL-encoded, as the UI sends it).
    const granted = await admin('PUT', `/workspace-secrets/${created.id}/grants/${encodeURIComponent('plugin:sync')}`);
    expect(granted.status).toBe(200);
    expect(JSON.parse(granted.text).grants).toMatchObject([
        { appId: 'plugin:sync', kind: 'plugin', appName: 'Bookings sync' },
    ]);
    const ok = await read(sync, proof('sync'), '/STRIPE_API_KEY');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ value: VALUE, version: 1 });
    // The other plugin isn't granted; the shared token and a wrong proof are refused.
    expect((await read(reports, proof('reports'), '/STRIPE_API_KEY')).status).toBe(403);
    expect((await read(sync, proof('reports'), '/STRIPE_API_KEY')).status).toBe(401);
    expect((await read(SHARED, proof('sync'), '/STRIPE_API_KEY')).status).toBe(401);
    expect((await read(sync, undefined, '/STRIPE_API_KEY')).status).toBe(401);
    // Undeclared names are refused even with a grant-able secret around.
    expect((await read(sync, proof('sync'), '/UNDECLARED_KEY')).status).toBe(403);

    // Its own (workload) secret, set by an admin, goes with it.
    const own = await admin('POST', '/workspace-secrets', {
        name: 'SLACK_WEBHOOK',
        value: 'https://hooks.invalid/plugin-own',
        scope: 'workload',
        appId: 'plugin:sync',
    });
    expect(own.status).toBe(201);
    expect(JSON.parse(own.text)).toMatchObject({ scope: 'workload', appId: 'plugin:sync', appName: 'Bookings sync' });
    const both = await read(sync, proof('sync'), '?names=STRIPE_API_KEY,SLACK_WEBHOOK');
    expect(both.status).toBe(200);
    state = JSON.parse((await admin('GET', '/workspace-secrets')).text) as WorkspaceSecretsState;
    expect(state.apps.find((entry) => entry.appId === 'plugin:sync')?.needsSetup).toEqual([]);
    expect(state.secrets.find((secret) => secret.name === 'STRIPE_API_KEY')?.lastReadByName).toBe('Bookings sync');

    // The SDK, as the plugin's task runs it: the identity file, the proof.
    const dir = mkdtempSync(join(tmpdir(), 'socio-plugin-sdk-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'socio_identity'), sync);
    const sdk = socioApp({
        appId: 'plugin:sync',
        fetch: (async (input: string | URL | Request, init?: RequestInit) =>
            http.request(String(input), init)) as typeof fetch,
        env: {
            SOCIO_API_URL: 'http://app:4310',
            SOCIO_IDENTITY_FILE: join(dir, 'socio_identity'),
            CB_PLUGIN_PROOF: proof('sync'),
        },
    });
    await sdk.secrets.require(['STRIPE_API_KEY', 'SLACK_WEBHOOK']);
    expect(await sdk.secrets.get('STRIPE_API_KEY')).toBe(VALUE);
    expect(await sdk.secrets.get('SLACK_WEBHOOK')).toBe('https://hooks.invalid/plugin-own');

    // Audited as the plugin, never the value.
    const lines = audit();
    expect(lines.some((line) => line.actor === 'plugin:sync' && line.action === 'read')).toBe(true);
    expect(lines.some((line) => line.actor === 'plugin:reports' && line.action === 'deny')).toBe(true);
    expect(lines.some((line) => line.detail.includes('granted to plugin=sync'))).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(VALUE);

    // Uninstalled: its own secret goes with it, and its grant ends.
    await platform.plugins.uninstall('sync');
    await platform.workspaceSecrets.sweep();
    state = JSON.parse((await admin('GET', '/workspace-secrets')).text) as WorkspaceSecretsState;
    expect(state.secrets.map((secret) => secret.name)).toEqual(['STRIPE_API_KEY']);
    expect(state.secrets[0]!.grants).toEqual([]);
    expect(audit().some((line) => line.detail.includes('deleted with its plugin'))).toBe(true);
    expect((await read(sync, proof('sync'), '/STRIPE_API_KEY')).status).toBe(401);
});

it('notes reads with a stale identity, audits a retired one’s refused use, and flags the plugin (phase 4)', async () => {
    const { platform, workspace, as, delivered, read, audit } = await world();
    await platform.plugins.install('sync');
    const admin = await as('alice');
    const proof = pluginProof(SECRET, 'sync');
    const created = JSON.parse(
        (await admin('POST', '/workspace-secrets', { name: 'STRIPE_API_KEY', value: VALUE })).text,
    ) as { id: string };
    await admin('PUT', `/workspace-secrets/${created.id}/grants/${encodeURIComponent('plugin:sync')}`);
    const first = delivered('sync')!;
    expect((await read(first, proof, '/STRIPE_API_KEY')).status).toBe(200);
    expect(audit().at(-1)!.detail).toBe('STRIPE_API_KEY: version 1 read plugin=sync identity v1');

    // The admins' rotate route (the Settings button calls it); members are refused.
    const member = DEFAULT_MOCK_USERS.find((user) => user.role === 'member')!;
    expect((await (await as(member.id))('POST', '/plugins/sync/identity')).status).toBe(403);
    const rotated = await admin('POST', '/plugins/sync/identity');
    expect(rotated.status).toBe(200);
    expect(JSON.parse(rotated.text)).toEqual({ version: 2 });
    const second = delivered('sync')!;
    // During the drain, the old identity reads without being called stale.
    expect((await read(first, proof, '/STRIPE_API_KEY')).status).toBe(200);
    expect(audit().at(-1)!.detail).toBe('STRIPE_API_KEY: version 1 read plugin=sync identity v1');
    // Past the drain's grace (the new version issued long enough ago): stale.
    workspace.db
        .prepare("UPDATE plugin_identities SET createdAt=createdAt-? WHERE pluginId='sync' AND version=2")
        .run(11 * 60_000);
    expect((await read(first, proof, '/STRIPE_API_KEY')).status).toBe(200);
    expect(audit().at(-1)!.detail).toBe('STRIPE_API_KEY: version 1 read plugin=sync identity v1 stale (current v2)');
    expect((await read(second, proof, '/STRIPE_API_KEY')).status).toBe(200);
    expect(audit().at(-1)!.detail).toBe('STRIPE_API_KEY: version 1 read plugin=sync identity v2');

    // Another rotation retires version 1: its use is refused and audited as stale.
    await platform.plugins.rotateIdentity('sync');
    expect((await read(first, proof, '/STRIPE_API_KEY')).status).toBe(401);
    expect(audit().at(-1)).toEqual({
        actor: 'plugin:sync',
        action: 'deny',
        detail: 'STRIPE_API_KEY: read refused (identity no longer accepted) plugin=sync identity v1 stale (current v3)',
    });
    // Without the plugin's proof, nothing is attributed to it.
    const before = audit().length;
    expect((await read(first, pluginProof(SECRET, 'reports'), '/STRIPE_API_KEY')).status).toBe(401);
    expect(audit()).toHaveLength(before);

    await platform.workspaceSecrets.evaluateFlags();
    const state = JSON.parse((await admin('GET', '/workspace-secrets')).text) as WorkspaceSecretsState;
    expect(state.flags).toMatchObject([
        { rule: 'stale-identity', workload: 'plugin:sync', workloadName: 'Bookings sync' },
    ]);
    expect(JSON.stringify(state)).not.toContain(VALUE);
    expect(JSON.stringify(audit())).not.toContain(VALUE);
});

it('reads PLUGIN_SERVICE_TOKEN for one more release with a warning that never holds the value', () => {
    const lines: string[] = [];
    expect(pluginServiceTokenFromEnv({}, (line) => lines.push(line))).toEqual({});
    expect(lines).toEqual([]);
    expect(
        pluginServiceTokenFromEnv(
            { PLUGIN_SERVICE_TOKEN: ` ${SHARED} `, PLUGIN_SERVICE_TOKEN_SECRET: 'company_brain_plugin_service_token' },
            (line) => lines.push(line),
        ),
    ).toEqual({ serviceToken: SHARED });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^PLUGIN_SERVICE_TOKEN is deprecated: each plugin service has its own identity token/);
    expect(lines[1]).toMatch(/^PLUGIN_SERVICE_TOKEN_SECRET is deprecated/);
    expect(lines.join('\n')).not.toContain(SHARED);
    expect(lines.join('\n')).not.toContain('company_brain_plugin_service_token');
    // Same shape as a renamed setting's warning.
    const renamed: string[] = [];
    renamedSetting({ OLD: 'v' }, 'NEW', 'OLD', (line) => renamed.push(line));
    retiredSetting({ GONE: 'v' }, 'GONE', 'Nothing replaces it.', (line) => renamed.push(line));
    expect(renamed).toEqual([
        'OLD is deprecated: rename it NEW. The old name is read for one more release.',
        'GONE is deprecated: Nothing replaces it. It is read for one more release; then remove it.',
    ]);
});
