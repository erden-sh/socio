import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';
import { pluginNetworkName, pluginServiceName } from '@socio/shared/plugins/plugin-service';
import { imageRegistry, parseRegistryCredential } from '@socio/shared/plugins/registry-auth';

import { encodeRegistryAuth, HttpDockerEngine, MemoryDocker, NO_REGISTRY_AUTH } from '../src/apps-runtime/docker.js';
import { SwarmIdentityDelivery } from '../src/apps-runtime/identity-delivery.js';
import { PluginServices } from '../src/apps-runtime/services.js';
import { pluginServiceErrors } from '../src/apps-runtime/socket-proxy.js';
import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { loadCatalog } from '../src/server/plugins/catalog.js';
import type { PluginRuntime } from '../src/server/plugins/contract.js';
import { pluginRegistryAuthFromEnv } from '../src/server/plugins/identity.js';
import { PluginService } from '../src/server/plugins/service.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// A stack update (an upgrade) rewrites the apps ingress', the app's and the
// egress proxy's networks from the stack file, which doesn't know the
// plugins: Socio's reconcile joins them to each plugin network again. And a
// private plugin image pulls with the registry login Socio sends with every
// provision (Swarm keeps it for every task start), refreshed when it changes.

const SECRET = 'plugin-registry-runtime-secret-0123456789';
const SESSION = 'plugin-registry-session-secret-0123456789';
const DIGEST = `@sha256:${'a'.repeat(64)}`;
const INFRA = ['lab_apps', 'lab_app'];
const EGRESS = 'lab_apps-egress';
const LOGIN = { registry: 'ghcr.io', username: 'socio-bot', password: 'ghp_ReadPackagesToken0123456789' };

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const manifest = (id: string, service: Record<string, unknown>) => ({
    id,
    name: id,
    version: '1.0.0',
    author: 'Socio tests',
    description: 'A test plugin',
    display: 'tab',
    permissions: [],
    service: { port: 8080, env: { SOCIO_API_URL: 'http://app:4310' }, ...service },
});

async function world(options: { registryAuth?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'socio-plugin-registry-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const catalog = join(dir, 'catalog.json');
    writeFileSync(
        catalog,
        JSON.stringify({
            plugins: [
                // A private image that reaches the internet through the egress proxy.
                manifest('events', { image: `ghcr.io/acme/events${DIGEST}`, egress: ['edge.example.com'] }),
                // Another registry's image, and no egress.
                manifest('dashboards', { image: `company-brain-plugin-dashboards${DIGEST}` }),
            ],
        }),
    );
    const engine = new MemoryDocker();
    const services = new PluginServices(engine, {
        allow: ['company-brain-plugin-', 'ghcr.io/acme/'],
        maxReplicas: 5,
        secret: SECRET,
        pull: false,
        identity: new SwarmIdentityDelivery(engine),
        infraServices: INFRA,
        egressService: EGRESS,
        egressProxy: 'http://acme-apps-egress:3128',
    });
    const provisions: string[] = [];
    const repairs: string[] = [];
    const outage = { on: false };
    const runtime: PluginRuntime = {
        provisionService: async (id, spec, identity, registry) => {
            if (outage.on) {
                throw new Error('The workspace app runtime is unavailable right now.');
            }
            provisions.push(id);
            return services.ensure(id, spec, identity, registry);
        },
        repairServiceNetworks: async (id, egress) => {
            repairs.push(`${id}:${egress}`);
            await services.repairNetworks(id, egress);
        },
        scaleService: (id, replicas) => services.scale(id, replicas),
        removeService: (id) => services.remove(id),
        serviceStatus: (id) => services.status(id),
    };
    const logs: string[] = [];
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
            plugins: {
                catalogs: [{ kind: 'file', path: catalog }],
                runtime,
                ...(options.registryAuth ? { registryAuth: options.registryAuth } : {}),
            },
        },
        app: {
            config: { mode: 'live' as const, baseUrl: '' },
            auth: { provider: new MockAuthProvider(DEFAULT_MOCK_USERS, SESSION), secureCookies: false },
        },
    });
    cleanup.push(dispose);
    platform.context.log = () => {};
    (platform.plugins as unknown as { options: { log: (line: string) => void } }).options.log = (line) =>
        logs.push(line);
    platform.plugins.useActiveUsers(() => DEFAULT_MOCK_USERS);
    const admin = async (method: string, path: string, body?: unknown) => {
        const login = await http.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 'alice' }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        const response = await http.request(`/api${path}`, {
            method,
            headers: { cookie, 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, text: await response.text() };
    };
    const network = (id: string) => `net-${pluginNetworkName(id)}`;
    /** What the engine keeps as the service's pull login, decoded. */
    const pullLogin = (id: string) => {
        const header = engine.registryAuth.get(pluginServiceName(id));
        return header
            ? (JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, string>)
            : undefined;
    };
    const label = (id: string) => engine.specNamed(pluginServiceName(id))?.Labels['socio.registry'];
    const audit = () =>
        workspace.db
            .prepare("SELECT actor, detail FROM workspace_audit WHERE targetKind='workspace_secret' AND action='read'")
            .all()
            .map((row) => ({ ...row })) as Array<{ actor: string; detail: string }>;
    /**
     * The operator moves a plugin's image in the catalog and the runtime's
     * allowlist and pins with it (a registry move), and Socio restarts with
     * the new catalog.
     */
    const moveImage = (id: string, image: string, allow: string[]) => {
        const listed = JSON.parse(readFileSync(catalog, 'utf8')) as {
            plugins: Array<{ id: string; service: { image: string } }>;
        };
        listed.plugins.find((plugin) => plugin.id === id)!.service.image = image;
        writeFileSync(catalog, JSON.stringify(listed));
        (w.platform.plugins as unknown as { catalog: unknown }).catalog = loadCatalog([
            { kind: 'file', path: catalog },
        ]);
        const config = (services as unknown as { config: { allow: string[]; pins?: Map<string, string> } }).config;
        config.allow = allow;
        config.pins = new Map([[id, image]]);
    };
    const image = (id: string) => engine.specNamed(pluginServiceName(id))?.TaskTemplate.ContainerSpec.Image;
    const installedImage = (id: string) => w.platform.plugins.get(id)?.manifest.service?.image;
    /** A service as a runtime before install revisions (CB-370) left it: no revision or registry label. */
    const unlabel = async (id: string) => {
        const record = await engine.findService(pluginServiceName(id));
        delete record!.labels['socio.plugin.revision'];
        delete record!.labels['socio.registry'];
    };
    const w = { platform, workspace, engine, admin, network, pullLogin, label, audit, logs, provisions, repairs };
    return { ...w, moveImage, image, installedImage, unlabel, outage };
}

it('joins the infra services to every enabled plugin network again after a stack update drops them', async () => {
    const w = await world();
    await w.platform.plugins.install('events');
    await w.platform.plugins.install('dashboards');
    // Installing attaches: the ingress and the app to both, the egress proxy to the one with egress.
    expect(w.engine.attached.get('lab_apps')).toEqual([w.network('events'), w.network('dashboards')]);
    expect(w.engine.attached.get('lab_app')).toEqual([w.network('events'), w.network('dashboards')]);
    expect(w.engine.attached.get(EGRESS)).toEqual([w.network('events')]);

    // A stack update rewrites the infra services' networks from the stack file.
    for (const name of [...INFRA, EGRESS]) {
        w.engine.attached.set(name, []);
    }
    const provisioned = w.provisions.length;
    await w.platform.plugins.reconcileAll();
    expect(w.engine.attached.get('lab_apps')).toEqual([w.network('events'), w.network('dashboards')]);
    expect(w.engine.attached.get('lab_app')).toEqual([w.network('events'), w.network('dashboards')]);
    expect(w.engine.attached.get(EGRESS)).toEqual([w.network('events')]);
    // Nothing else changed: the services run their installed revision, so none is provisioned again.
    expect(w.provisions.length).toBe(provisioned);
    expect(w.repairs).toEqual(['events:true', 'dashboards:false']);

    // Between full checks the minute tick re-attaches alone; a disabled plugin is left as it is.
    expect(w.platform.plugins.reconcileDue()).toBe(false);
    await w.platform.plugins.setEnabled('dashboards', false);
    w.engine.attached.set('lab_apps', []);
    w.repairs.length = 0;
    await w.platform.plugins.repairNetworks();
    expect(w.engine.attached.get('lab_apps')).toEqual([w.network('events')]);
    expect(w.repairs).toEqual(['events:true']);
    // Repeating it changes nothing.
    await w.platform.plugins.repairNetworks();
    expect(w.engine.attached.get('lab_apps')).toEqual([w.network('events')]);
    expect(w.provisions.length).toBe(provisioned);
});

it('runs the full check every ten minutes and only re-attaches in between', async () => {
    const w = await world();
    const now = Date.now();
    // The boot's reconcile (or a full tick) claims the slot.
    expect(w.platform.plugins.reconcileDue(now)).toBe(true);
    expect(w.platform.plugins.reconcileDue(now + 60_000)).toBe(false);
    expect(w.platform.plugins.reconcileDue(now + 9 * 60_000)).toBe(false);
    expect(w.platform.plugins.reconcileDue(now + 10 * 60_000)).toBe(true);
});

it('refuses to repair a network for a service that is not a Socio plugin, or one without its network', async () => {
    const engine = new MemoryDocker();
    const services = new PluginServices(engine, {
        allow: ['company-brain-plugin-'],
        maxReplicas: 5,
        secret: SECRET,
        pull: false,
        infraServices: INFRA,
    });
    await expect(services.repairNetworks('ghost', false)).rejects.toMatchObject({ status: 404 });
    await services.ensure('dashboards', { image: `company-brain-plugin-dashboards${DIGEST}`, port: 8080 });
    // Egress needs the egress service, which this runtime doesn't have.
    await expect(services.repairNetworks('dashboards', true)).rejects.toMatchObject({ status: 400 });
    engine.networks.clear();
    await expect(services.repairNetworks('dashboards', false)).rejects.toMatchObject({ status: 404 });
});

it("sends the environment's registry login with every provision, only to the image's own registry", async () => {
    const w = await world({ registryAuth: JSON.stringify(LOGIN) });
    await w.platform.plugins.install('events');
    await w.platform.plugins.install('dashboards');
    expect(w.pullLogin('events')).toEqual({
        username: LOGIN.username,
        password: LOGIN.password,
        serveraddress: 'ghcr.io',
    });
    // The other registry's image never gets the login, but carries the fingerprint, so it stays settled.
    expect(w.pullLogin('dashboards')).toBeUndefined();
    expect(w.label('events')).toMatch(/^[a-f0-9]{32}$/);
    expect(w.label('dashboards')).toBe(w.label('events'));
    // The label is not the password, nor a plain hash anyone could compute.
    expect(JSON.stringify(w.engine.specNamed(pluginServiceName('events')))).not.toContain(LOGIN.password);
    const provisioned = w.provisions.length;
    await w.platform.plugins.reconcileAll();
    expect(w.provisions.length).toBe(provisioned);
});

it("puts an admin's PLUGIN_REGISTRY_AUTH workspace secret over the environment's, and rotates it onto every service", async () => {
    const w = await world({ registryAuth: JSON.stringify(LOGIN) });
    await w.platform.plugins.install('events');
    const before = w.label('events');
    const provisioned = w.provisions.length;

    // An admin saves the login on Settings → Secrets (a workspace secret, granted to nothing).
    const rotated = { ...LOGIN, password: 'ghp_RotatedReadPackagesToken9876543' };
    const created = await w.admin('POST', '/workspace-secrets', {
        name: 'PLUGIN_REGISTRY_AUTH',
        value: JSON.stringify(rotated),
    });
    expect(created.status).toBe(201);
    // The reconcile sees the service's fingerprint is not the login in force and provisions it again.
    await w.platform.plugins.reconcileAll();
    expect(w.provisions.length).toBe(provisioned + 1);
    expect(w.pullLogin('events')?.password).toBe(rotated.password);
    expect(w.label('events')).not.toBe(before);
    expect(w.logs.some((line) => line.includes("doesn't have the current registry login"))).toBe(true);
    // Settled: the next check changes nothing.
    await w.platform.plugins.reconcileAll();
    expect(w.provisions.length).toBe(provisioned + 1);
    // Read by Socio itself, audited once for that version.
    expect(w.audit()).toEqual([
        { actor: 'system:plugins', detail: 'PLUGIN_REGISTRY_AUTH: version 1 read by system:plugins' },
    ]);
});

it('reports a malformed registry login once and provisions without one', async () => {
    const w = await world();
    const created = await w.admin('POST', '/workspace-secrets', { name: 'PLUGIN_REGISTRY_AUTH', value: 'not json' });
    expect(created.status).toBe(201);
    await w.platform.plugins.install('events');
    await w.platform.plugins.reconcileAll();
    expect(w.pullLogin('events')).toBeUndefined();
    expect(w.label('events')).toBeUndefined();
    const warnings = w.logs.filter((line) => line.includes("the registry login can't be used"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain('not json');
});

it('parses registry logins and image registries as Docker reads them', () => {
    expect(parseRegistryCredential(JSON.stringify({ ...LOGIN, registry: 'https://GHCR.io/' }))).toEqual(LOGIN);
    for (const bad of [
        '',
        '{}',
        '[]',
        JSON.stringify({ ...LOGIN, password: ' ' }),
        JSON.stringify({ ...LOGIN, registry: 'a b' }),
    ]) {
        expect(() => parseRegistryCredential(bad)).toThrow(/PLUGIN_REGISTRY_AUTH must hold JSON/);
    }
    expect(imageRegistry(`ghcr.io/acme/events${DIGEST}`)).toBe('ghcr.io');
    expect(imageRegistry('localhost:5000/events:1')).toBe('localhost:5000');
    expect(imageRegistry('acme/events:1')).toBe('docker.io');
    expect(imageRegistry('events')).toBe('docker.io');
    const warnings: string[] = [];
    expect(pluginRegistryAuthFromEnv({ PLUGIN_REGISTRY_AUTH: 'oops-secret' }, (line) => warnings.push(line))).toEqual({
        registryAuth: 'oops-secret',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain('oops-secret');
    expect(pluginRegistryAuthFromEnv({ PLUGIN_REGISTRY_AUTH: 'none' }, () => {})).toEqual({});
});

it('lets the socket proxy take only a fingerprint as the registry label', async () => {
    const engine = new MemoryDocker();
    const services = new PluginServices(engine, {
        allow: ['company-brain-plugin-'],
        maxReplicas: 5,
        secret: SECRET,
        pull: false,
    });
    await services.ensure('dashboards', { image: `company-brain-plugin-dashboards${DIGEST}`, port: 8080 }, undefined, {
        ...LOGIN,
        fingerprint: 'b'.repeat(32),
    });
    const body = engine.specNamed(pluginServiceName('dashboards'))!;
    const policy = {
        pins: new Map(),
        infra: new Set<string>(),
        network: () => undefined,
        secretNames: new Set<string>(),
    };
    const errors = (labels: Record<string, string>) =>
        pluginServiceErrors({ ...body, Labels: { ...body.Labels, ...labels } }, policy).filter((line) =>
            line.includes('socio.registry'),
        );
    expect(errors({})).toEqual([]);
    expect(errors({ 'socio.registry': LOGIN.password })).toHaveLength(1);
});

it('replaces the login a service kept with an empty one when the login is removed', async () => {
    const w = await world();
    const created = await w.admin('POST', '/workspace-secrets', {
        name: 'PLUGIN_REGISTRY_AUTH',
        value: JSON.stringify(LOGIN),
    });
    expect(created.status).toBe(201);
    await w.platform.plugins.install('events');
    expect(w.pullLogin('events')?.password).toBe(LOGIN.password);
    // The admin removes it, and the environment has none.
    const { id } = JSON.parse(created.text) as { id: string };
    expect((await w.admin('DELETE', `/workspace-secrets/${id}`)).status).toBeLessThan(300);
    await w.platform.plugins.reconcileAll();
    // Swarm would keep the old login through an update without the header: an empty one replaces it.
    expect(w.pullLogin('events')).toEqual({});
    expect(w.label('events')).toBeUndefined();
    const provisioned = w.provisions.length;
    await w.platform.plugins.reconcileAll();
    expect(w.provisions.length).toBe(provisioned);
});

it("pre-pulls a private image with its registry's login", async () => {
    // The runtime's own pull (APPS_RUNTIME_PULL=on) goes before the service is written.
    const pulls: Array<{ image: string; auth?: string }> = [];
    class PullingDocker extends MemoryDocker {
        async pullImage(image: string, registryAuth?: string) {
            pulls.push({ image, ...(registryAuth ? { auth: registryAuth } : {}) });
        }
    }
    const services = new PluginServices(new PullingDocker(), {
        allow: ['company-brain-plugin-', 'ghcr.io/acme/'],
        maxReplicas: 5,
        secret: SECRET,
        pull: true,
    });
    const grant = { ...LOGIN, fingerprint: 'c'.repeat(32) };
    await services.ensure('events', { image: `ghcr.io/acme/events${DIGEST}`, port: 8080 }, undefined, grant);
    await services.ensure(
        'dashboards',
        { image: `company-brain-plugin-dashboards${DIGEST}`, port: 8080 },
        undefined,
        grant,
    );
    expect(JSON.parse(Buffer.from(pulls[0]!.auth!, 'base64url').toString('utf8'))).toEqual({
        username: LOGIN.username,
        password: LOGIN.password,
        serveraddress: 'ghcr.io',
    });
    expect(pulls[1]).toEqual({ image: `company-brain-plugin-dashboards${DIGEST}` });

    // And the engine sends it as the pull request's X-Registry-Auth.
    const seen: Array<string | undefined> = [];
    const server = createServer((req, res) => {
        seen.push(req.headers['x-registry-auth'] as string | undefined);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    const port = await new Promise<number>((ok) =>
        server.listen(0, '127.0.0.1', () => ok((server.address() as { port: number }).port)),
    );
    cleanup.push(() => new Promise((ok) => server.close(ok)));
    const engine = new HttpDockerEngine(`tcp://127.0.0.1:${port}`, true);
    await engine.pullImage(`ghcr.io/acme/events${DIGEST}`, pulls[0]!.auth);
    await engine.pullImage(`company-brain-plugin-dashboards${DIGEST}`);
    expect(seen).toEqual([pulls[0]!.auth, undefined]);
});

it("encodes X-Registry-Auth as Docker's padded URL-safe base64, whatever the login's length", () => {
    // Go's base64.URLEncoding: the URL alphabet, and padding to a multiple of 4.
    const goDecode = (value: string) => {
        expect(value).toMatch(/^[A-Za-z0-9_-]*={0,2}$/);
        expect(value.length % 4).toBe(0);
        return JSON.parse(
            Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
        ) as unknown;
    };
    const remainders = new Set<number>();
    for (const password of ['ghp_a', 'ghp_ab', 'ghp_abc', 'ghp_??>>~~']) {
        const login = { ...LOGIN, password };
        const json = JSON.stringify({ username: login.username, password, serveraddress: login.registry });
        remainders.add(Buffer.byteLength(json) % 3);
        expect(goDecode(encodeRegistryAuth(login))).toEqual({
            username: login.username,
            password,
            serveraddress: 'ghcr.io',
        });
    }
    expect(remainders).toEqual(new Set([0, 1, 2]));
    expect(goDecode(NO_REGISTRY_AUTH)).toEqual({});
});

const MOVED = `dcr.example/events${DIGEST}`;
const DCR_LOGIN = { registry: 'dcr.example', username: 'socio-pull', password: 'dcr-ReadOnlyPullToken0123456789' };

it('follows the catalog when it moves an installed image to another registry at the same digest', async () => {
    const w = await world({ registryAuth: JSON.stringify(DCR_LOGIN) });
    await w.platform.plugins.install('events');
    expect(w.image('events')).toBe(`ghcr.io/acme/events${DIGEST}`);
    // The old registry is no longer allowed or pinned; the catalog points at the new one.
    w.moveImage('events', MOVED, ['company-brain-plugin-', 'dcr.example/']);
    expect(w.platform.plugins.catalogUpdate('events')).toBeDefined();
    const provisioned = w.provisions.length;

    await w.platform.plugins.reconcileAll();
    expect(w.installedImage('events')).toBe(MOVED);
    expect(w.image('events')).toBe(MOVED);
    // The new registry's login goes with it.
    expect(w.pullLogin('events')?.password).toBe(DCR_LOGIN.password);
    expect(w.provisions.length).toBe(provisioned + 1);
    expect(w.logs.some((line) => line.includes(`image moved to ${MOVED}`))).toBe(true);
    // Nothing left for an admin's Update, and the next check changes nothing.
    expect(w.platform.plugins.catalogUpdate('events')).toBeUndefined();
    await w.platform.plugins.reconcileAll();
    expect(w.provisions.length).toBe(provisioned + 1);
});

it('moves the image of a service without a revision label too, and of a disabled plugin at its enable', async () => {
    const w = await world();
    await w.platform.plugins.install('events');
    await w.platform.plugins.install('dashboards');
    await w.unlabel('events');
    await w.platform.plugins.setEnabled('dashboards', false);
    w.moveImage('events', MOVED, ['company-brain-plugin-', 'dcr.example/']);
    // The runtime doesn't answer the first time: the install has moved, its service not yet.
    w.outage.on = true;
    await w.platform.plugins.reconcileAll();
    expect(w.installedImage('events')).toBe(MOVED);
    expect(w.image('events')).toBe(`ghcr.io/acme/events${DIGEST}`);
    expect(w.logs.some((line) => line.includes('unavailable right now'))).toBe(true);
    // A restart forgets what this process did; the next check still finds the
    // unlabeled service on the old location of the installed digest.
    const restarted = new PluginService(w.workspace.db, {
        ...(w.platform.plugins as unknown as { options: ConstructorParameters<typeof PluginService>[1] }).options,
    });
    w.outage.on = false;
    await restarted.reconcileAll();
    expect(w.image('events')).toBe(MOVED);
    const provisioned = w.provisions.length;
    await restarted.reconcileAll();
    expect(w.provisions.length).toBe(provisioned);
    expect(w.engine.specNamed(pluginServiceName('events'))?.Labels['socio.plugin.revision']).toMatch(/^[a-f0-9]{64}$/);

    const dashboards = `dcr.example/dashboards${DIGEST}`;
    w.moveImage('dashboards', dashboards, ['dcr.example/']);
    await w.platform.plugins.setEnabled('dashboards', true);
    expect(w.image('dashboards')).toBe(dashboards);
});

it("leaves another digest to an admin's Update, and logs the runtime's refusal", async () => {
    const w = await world();
    await w.platform.plugins.install('events');
    const other = `dcr.example/events@sha256:${'b'.repeat(64)}`;
    w.moveImage('events', other, ['company-brain-plugin-', 'dcr.example/']);
    // The owner saves the new registry's login: the reconcile provisions every service with it.
    const saved = await w.admin('POST', '/workspace-secrets', {
        name: 'PLUGIN_REGISTRY_AUTH',
        value: JSON.stringify(DCR_LOGIN),
    });
    expect(saved.status).toBe(201);
    await w.platform.plugins.reconcileAll();
    await expect(w.platform.plugins.rotateIdentity('events')).rejects.toThrow(/APPS_RUNTIME_IMAGE_PINS/);
    // Not the same bits: the install stays, and the reason is in the log.
    expect(w.installedImage('events')).toBe(`ghcr.io/acme/events${DIGEST}`);
    expect(w.image('events')).toBe(`ghcr.io/acme/events${DIGEST}`);
    expect(
        w.logs.some(
            (line) =>
                line.includes("checking events's service against its install failed") &&
                line.includes('does not match APPS_RUNTIME_IMAGE_PINS'),
        ),
    ).toBe(true);
    expect(w.platform.plugins.catalogUpdate('events')).toBeDefined();
    const updated = await w.admin('POST', '/plugins/events/update');
    expect(updated.status).toBe(200);
    expect(w.image('events')).toBe(other);
});

it('gives a service without a revision label the current registry login, once per login', async () => {
    const w = await world({ registryAuth: JSON.stringify(LOGIN) });
    await w.platform.plugins.install('events');
    await w.unlabel('events');
    const provisioned = w.provisions.length;
    await w.platform.plugins.reconcileAll();
    expect(w.provisions.length).toBe(provisioned + 1);
    expect(w.pullLogin('events')?.password).toBe(LOGIN.password);
    expect(w.label('events')).toMatch(/^[a-f0-9]{32}$/);

    // A runtime that keeps no labels is not provisioned again on every tick.
    await w.unlabel('events');
    await w.platform.plugins.reconcileAll();
    expect(w.provisions.length).toBe(provisioned + 1);
});
