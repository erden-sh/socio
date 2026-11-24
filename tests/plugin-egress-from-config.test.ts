import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';
import {
    PluginSpecError,
    checkServiceSpec,
    egressHostFromUrl,
    pluginNetworkName,
    pluginServiceName,
    resolvePluginEgress,
    swarmServiceBody,
} from '@socio/shared/plugins/plugin-service';

import { MemoryDocker } from '../src/apps-runtime/docker.js';
import { SwarmIdentityDelivery } from '../src/apps-runtime/identity-delivery.js';
import { egressTenant } from '../src/apps-runtime/keys.js';
import { PluginServices } from '../src/apps-runtime/services.js';
import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { loadCatalog, parseManifest } from '../src/server/plugins/catalog.js';
import type { PluginRuntime } from '../src/server/plugins/contract.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-441: a plugin's egress may name a `url` setting (`{ fromConfig }`), so an
// admin types the host (a Cloudflare Worker's domain, say) and the signed
// allow list follows the setting at every provision.

const SECRET = 'plugin-egress-runtime-secret-0123456789';
const SESSION = 'plugin-egress-session-secret-0123456789';
const IMAGE = `company-brain-plugin-forms@sha256:${'a'.repeat(64)}`;
const EGRESS = 'lab_apps-egress';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const formsManifest = (patch: { egress?: unknown[]; config?: Record<string, unknown>; version?: string } = {}) => ({
    id: 'forms',
    name: 'Forms',
    version: patch.version ?? '1.0.0',
    author: 'Socio tests',
    description: 'Forms on a Worker',
    display: 'tab',
    permissions: [],
    config: patch.config ?? {
        WORKER_URL: { description: 'The Worker that serves the forms.', type: 'url' },
    },
    service: {
        image: IMAGE,
        port: 8080,
        egress: patch.egress ?? ['api.example.com', { fromConfig: 'WORKER_URL' }],
    },
});

const fields = { WORKER_URL: { description: 'The Worker.', type: 'url' as const } };

it('accepts fromConfig only for a declared url setting, with a clear error otherwise', () => {
    const spec = (egress: unknown[]) =>
        ({ image: 'company-brain-plugin-forms', port: 8080, egress }) as Parameters<typeof checkServiceSpec>[0];
    expect(() => checkServiceSpec(spec([{ fromConfig: 'WORKER_URL' }]), { config: fields })).not.toThrow();
    expect(() => checkServiceSpec(spec([{ fromConfig: 'NOPE' }]), { config: fields })).toThrow(
        /fromConfig NOPE names no setting/,
    );
    expect(() => checkServiceSpec(spec([{ fromConfig: 'NAME' }]), { config: { NAME: { description: 'x' } } })).toThrow(
        /must name a url setting; NAME is string/,
    );
    expect(() => checkServiceSpec(spec([{ fromConfig: 'WORKER_URL', extra: 1 }]), { config: fields })).toThrow(
        /\{ "fromConfig": "<url setting>" \} and nothing else/,
    );
    expect(() => checkServiceSpec(spec([{ fromConfig: 7 }]), { config: fields })).toThrow(/nothing else/);
    expect(() => checkServiceSpec(spec([['api.example.com']]), { config: fields })).toThrow(/hostnames/);
    // The runtime takes only hostnames: an unresolved entry never reaches a service.
    expect(() => checkServiceSpec(spec([{ fromConfig: 'WORKER_URL' }]))).toThrow(/unresolved/);
    expect(() =>
        swarmServiceBody({
            id: 'forms',
            image: IMAGE,
            spec: spec([{ fromConfig: 'WORKER_URL' }]),
            replicas: 1,
            networkId: 'net',
            proof: 'proof',
            egressProxy: 'http://u:p@proxy:3128',
        }),
    ).toThrow(PluginSpecError);

    // The catalog refuses such a manifest, naming the plugin.
    expect(parseManifest(formsManifest(), 'catalog').service?.egress).toEqual([
        'api.example.com',
        { fromConfig: 'WORKER_URL' },
    ]);
    expect(() => parseManifest(formsManifest({ egress: [{ fromConfig: 'MISSING' }] }), 'catalog')).toThrow(
        /fromConfig MISSING names no setting/,
    );
    expect(() =>
        parseManifest(formsManifest({ config: { WORKER_URL: { description: 'x', type: 'string' } } }), 'catalog'),
    ).toThrow(/must name a url setting/);
    expect(() => parseManifest({ ...formsManifest(), config: undefined }, 'catalog')).toThrow(/names no setting/);
});

it('takes an https URL’s host under the egress host rules', () => {
    expect(egressHostFromUrl('https://forms.acme.workers.dev/submit?x=1')).toEqual({
        host: 'forms.acme.workers.dev',
    });
    expect(egressHostFromUrl(' https://Forms.Example.com:8443/ ')).toEqual({ host: 'forms.example.com:8443' });
    expect(egressHostFromUrl('https://forms.example.com:443/')).toEqual({ host: 'forms.example.com' });
    for (const [value, problem] of [
        ['', /empty/],
        ['forms.example.com', /not a URL/],
        ['http://forms.example.com', /only https/],
        ['https://localhost:8787', /not a public host/],
        ['https://worker.internal', /not a public host/],
        ['https://10.0.0.5', /IP addresses/],
        ['https://[::1]/', /IP addresses/],
        ['https://intranet/', /IP addresses|not a host name/],
    ] as const) {
        const result = egressHostFromUrl(value);
        expect('problem' in result && result.problem, value).toMatch(problem);
    }
});

it('resolves the installed setting over its default, and adds nothing for an empty or unusable value', () => {
    const egress = ['api.example.com', { fromConfig: 'WORKER_URL' }];
    const withDefault = { WORKER_URL: { ...fields.WORKER_URL, default: 'https://default.example.dev' } };
    expect(resolvePluginEgress(egress, withDefault, {})).toEqual({
        hosts: ['api.example.com', 'default.example.dev'],
        settings: [{ field: 'WORKER_URL', host: 'default.example.dev' }],
    });
    expect(resolvePluginEgress(egress, withDefault, { WORKER_URL: 'https://forms.acme.workers.dev' })).toEqual({
        hosts: ['api.example.com', 'forms.acme.workers.dev'],
        settings: [{ field: 'WORKER_URL', host: 'forms.acme.workers.dev' }],
    });
    expect(resolvePluginEgress(egress, fields, {})).toEqual({
        hosts: ['api.example.com'],
        settings: [{ field: 'WORKER_URL', problem: 'it is empty' }],
    });
    expect(resolvePluginEgress(egress, fields, { WORKER_URL: 'http://forms.example.com' }).settings).toEqual([
        { field: 'WORKER_URL', problem: 'only https addresses are allowed' },
    ]);
    // A host the manifest already lists is not added twice.
    expect(resolvePluginEgress(egress, fields, { WORKER_URL: 'https://API.example.com/x' }).hosts).toEqual([
        'api.example.com',
    ]);
});

async function world() {
    const dir = mkdtempSync(join(tmpdir(), 'socio-plugin-egress-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const catalog = join(dir, 'catalog.json');
    writeFileSync(catalog, JSON.stringify({ plugins: [formsManifest()] }));
    const engine = new MemoryDocker();
    const services = new PluginServices(engine, {
        allow: ['company-brain-plugin-'],
        maxReplicas: 5,
        secret: SECRET,
        pull: false,
        identity: new SwarmIdentityDelivery(engine),
        infraServices: ['lab_apps', 'lab_app'],
        egressService: EGRESS,
        egressProxy: 'http://acme-apps-egress:3128',
    });
    const repairs: string[] = [];
    let provisions = 0;
    const runtime: PluginRuntime = {
        provisionService: async (id, spec, identity, registry) => {
            provisions += 1;
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
    const {
        app: http,
        platform,
        dispose,
    } = await makeTestRuntime({
        config: {
            sessionSecret: SESSION,
            data: { userDataDir: dir },
            apps: appsSettingsFromEnv({ APPS_HOST: 'apps.example' }, 'https://brain.example'),
            appsRuntime: { url: 'http://127.0.0.1:9', token: SECRET, ingress: { host: '127.0.0.1', port: 9 } },
            plugins: { catalogs: [{ kind: 'file', path: catalog }], runtime },
        },
        app: {
            config: { mode: 'live' as const, baseUrl: '' },
            auth: { provider: new MockAuthProvider(DEFAULT_MOCK_USERS, SESSION), secureCookies: false },
        },
    });
    cleanup.push(dispose);
    platform.context.log = () => {};
    (platform.plugins as unknown as { options: { log: (line: string) => void } }).options.log = () => {};
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
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    /**
     * The hosts the running service's HTTPS_PROXY lets it reach, as the egress
     * proxy reads them: the credentials must verify against the runtime's secret.
     */
    const allowed = () => {
        const env = engine.specNamed(pluginServiceName('forms'))?.TaskTemplate.ContainerSpec.Env ?? [];
        const proxy = env.find((line) => line.startsWith('HTTPS_PROXY='));
        if (!proxy) {
            return undefined;
        }
        const url = new URL(proxy.slice('HTTPS_PROXY='.length));
        const basic = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString(
            'base64',
        );
        const tenant = egressTenant(SECRET)({
            headers: { 'proxy-authorization': `Basic ${basic}` },
        } as unknown as IncomingMessage);
        expect(tenant?.label).toBe('forms');
        return [...(tenant?.allow ?? [])];
    };
    const setCatalog = (manifest: ReturnType<typeof formsManifest>) => {
        writeFileSync(catalog, JSON.stringify({ plugins: [manifest] }));
        (platform.plugins as unknown as { catalog: unknown }).catalog = loadCatalog([{ kind: 'file', path: catalog }]);
    };
    return { platform, engine, admin, allowed, repairs, setCatalog, provisions: () => provisions };
}

it('adds the url setting’s host to the signed allow list, and follows the setting when it changes', async () => {
    const w = await world();
    await w.platform.plugins.install('forms', { WORKER_URL: 'https://forms.acme.workers.dev/api' });
    expect(w.allowed()).toEqual(['api.example.com:443', 'forms.acme.workers.dev:443']);
    expect(w.engine.attached.get(EGRESS)).toEqual([`net-${pluginNetworkName('forms')}`]);

    // A settings change provisions again (a new revision), and the host follows it.
    const before = w.provisions();
    await w.platform.plugins.configure('forms', { WORKER_URL: 'https://forms.other.example:8443/' }, { apply: 'now' });
    expect(w.provisions()).toBe(before + 1);
    expect(w.allowed()).toEqual(['api.example.com:443', 'forms.other.example:8443']);
    expect(w.allowed()).not.toContain('forms.acme.workers.dev:443');

    // Cleared: nothing is added for it, the manifest's own host stays.
    await w.platform.plugins.configure('forms', {}, { apply: 'now' });
    expect(w.allowed()).toEqual(['api.example.com:443']);

    // The page says what it allowed, and why the setting added none.
    const list = await w.admin('GET', '/plugins');
    const row = (list.body.installed as Array<Record<string, unknown>>).find((item) => item.id === 'forms');
    expect(row?.egress).toEqual({
        hosts: ['api.example.com'],
        settings: [{ field: 'WORKER_URL', problem: 'it is empty' }],
    });
    // A save answers with the hosts its settings give, for the page.
    const saved = await w.admin('PUT', '/plugins/forms/config', { config: { WORKER_URL: 'https://x.example.dev' } });
    expect(saved.status).toBe(200);
    expect(saved.body.egress).toEqual({
        hosts: ['api.example.com', 'x.example.dev'],
        settings: [{ field: 'WORKER_URL', host: 'x.example.dev' }],
    });
});

it('gives a plugin whose only egress is an empty url setting no egress at all', async () => {
    const w = await world();
    w.setCatalog(formsManifest({ egress: [{ fromConfig: 'WORKER_URL' }] }));
    await w.platform.plugins.install('forms');
    expect(w.allowed()).toBeUndefined();
    expect(w.engine.attached.get(EGRESS) ?? []).toEqual([]);
    await w.platform.plugins.repairNetworks();
    expect(w.repairs).toEqual(['forms:false']);

    await w.platform.plugins.configure('forms', { WORKER_URL: 'https://forms.acme.workers.dev' }, { apply: 'now' });
    expect(w.allowed()).toEqual(['forms.acme.workers.dev:443']);
    expect(w.engine.attached.get(EGRESS)).toEqual([`net-${pluginNetworkName('forms')}`]);
    w.repairs.length = 0;
    await w.platform.plugins.repairNetworks();
    expect(w.repairs).toEqual(['forms:true']);

    // Cleared again: the service has no egress, and the egress proxy leaves its
    // network, so credentials kept from before reach nothing.
    await w.platform.plugins.configure('forms', {}, { apply: 'now' });
    expect(w.allowed()).toBeUndefined();
    expect(w.engine.attached.get(EGRESS)).toEqual([]);
    // A repair keeps it off (and attaches nothing else).
    await w.platform.plugins.repairNetworks();
    expect(w.engine.attached.get(EGRESS)).toEqual([]);
});

it('leaves the egress proxy to the running service until saved settings apply (CB-441 review)', async () => {
    const w = await world();
    w.setCatalog(formsManifest({ egress: [{ fromConfig: 'WORKER_URL' }] }));
    await w.platform.plugins.install('forms', { WORKER_URL: 'https://forms.acme.workers.dev' });
    expect(w.allowed()).toEqual(['forms.acme.workers.dev:443']);
    const before = w.provisions();
    // Cleared as the settings page saves it: stored now, applied after the wait.
    await w.platform.plugins.configure('forms', {}, { apply: 'later' });
    w.repairs.length = 0;
    await w.platform.plugins.repairNetworks();
    // The running service still has its egress, and the repair didn't take the proxy away.
    expect(w.repairs).toEqual([]);
    expect(w.provisions()).toBe(before);
    expect(w.allowed()).toEqual(['forms.acme.workers.dev:443']);
    expect(w.engine.attached.get(EGRESS)).toEqual([`net-${pluginNetworkName('forms')}`]);
    // Once they apply, the service has no egress and the proxy leaves.
    await w.platform.plugins.applySettings('forms');
    expect(w.allowed()).toBeUndefined();
    expect(w.engine.attached.get(EGRESS)).toEqual([]);
    await w.platform.plugins.repairNetworks();
    expect(w.repairs).toEqual(['forms:false']);
});

it('keeps catalog update detection working with fromConfig entries (CB-370)', async () => {
    const w = await world();
    await w.platform.plugins.install('forms', { WORKER_URL: 'https://forms.acme.workers.dev' });
    // The same manifest, read again: nothing to update.
    w.setCatalog(formsManifest());
    expect(w.platform.plugins.catalogUpdate('forms')).toBeUndefined();
    // Only the egress entries change (same version): that alone is an update, and
    // adopting it keeps the setting's host.
    w.setCatalog(formsManifest({ egress: [{ fromConfig: 'WORKER_URL' }] }));
    expect(w.platform.plugins.catalogUpdate('forms')?.version).toBe('1.0.0');
    const updated = await w.admin('POST', '/plugins/forms/update');
    expect(updated.status).toBe(200);
    expect(w.platform.plugins.catalogUpdate('forms')).toBeUndefined();
    expect(w.allowed()).toEqual(['forms.acme.workers.dev:443']);
});
