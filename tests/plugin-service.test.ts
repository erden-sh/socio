import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';

import { expect, it } from 'vitest';

import {
    RUNTIME_HEADER_APP,
    RUNTIME_HEADER_KEY,
    RUNTIME_HEADER_PLUGIN_PROOF,
} from '@socio/shared/apps/apps-runtime-types';
import {
    PluginSpecError,
    checkServiceSpec,
    pluginServiceName,
    resolveImage,
    swarmServiceBody,
    type PluginServiceSpec,
} from '@socio/shared/plugins/plugin-service';

import { dockerServicesFromEnv } from '../src/apps-runtime/config.js';
import { MemoryDocker } from '../src/apps-runtime/docker.js';
import { ingressServer } from '../src/apps-runtime/ingress.js';
import { ingressKey, pluginProof } from '../src/apps-runtime/keys.js';
import { PluginServices } from '../src/apps-runtime/services.js';
import { matchProxyRoute } from '../src/apps-runtime/socket-proxy.js';
import type { AppsSupervisor } from '../src/apps-runtime/supervisor.js';
import { socialStrategyManifest } from '../src/server/plugins/planner/manifest.js';

const SECRET = 'runtime-secret-runtime-secret-32';
const PLANNER_SECRET = 'company_brain_plugin_service_token';
const PLANNER_SECRET_ID = 'secret-planner-1';
/**
 * The planner's service as it was before Socio Secrets phase 2, mounting the
 * shared token's Swarm secret: `service.secrets` is still mounted for one
 * release (deprecated), so the legacy path stays tested.
 */
const LEGACY_PLANNER_SERVICE = {
    ...socialStrategyManifest.service!,
    env: { ...socialStrategyManifest.service!.env, SOCIO_API_TOKEN_FILE: '/run/secrets/plugin_service_token' },
    secrets: [{ name: PLANNER_SECRET, target: '/run/secrets/plugin_service_token' }],
};

const spec = (patch: Partial<PluginServiceSpec> = {}): PluginServiceSpec => ({
    image: 'company-brain-plugin-social-strategy',
    port: 8080,
    ...patch,
});

function services(engine = new MemoryDocker()) {
    const plugins = new PluginServices(engine, {
        allow: ['company-brain-plugin-'],
        maxReplicas: 5,
        secret: SECRET,
        pull: false,
    });
    return { engine, plugins };
}

const listen = (server: Server) =>
    new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve(typeof address === 'object' && address ? address.port : 0);
        });
    });

it('requires an image or a build, and tags a bare image', () => {
    expect(resolveImage('company-brain-plugin-social-strategy')).toBe('company-brain-plugin-social-strategy:latest');
    expect(resolveImage('company-brain-plugin-social-strategy:1')).toBe('company-brain-plugin-social-strategy:1');
    expect(resolveImage('company-brain-plugin-social-strategy@sha256:abc')).toBe(
        'company-brain-plugin-social-strategy@sha256:abc',
    );
    expect(() => checkServiceSpec({ port: 8080 })).toThrow(PluginSpecError);
    expect(() =>
        checkServiceSpec({
            image: 'company-brain-plugin-social-strategy',
            build: { context: 'plugins/planner' },
            port: 8080,
        }),
    ).toThrow(/only one/);
    expect(() => checkServiceSpec(spec({ env: { PORT: '1' } }))).toThrow(/PORT/);
    expect(() => checkServiceSpec(spec({ env: { CB_PLUGIN_ID: 'nope' } }))).toThrow(/CB_/);
});

it('refuses a local volume once a plugin runs more than one replica', () => {
    expect(() =>
        checkServiceSpec(
            spec({
                replicas: 2,
                volumes: [{ name: 'data', mount: '/data' }],
            }),
        ),
    ).toThrow(/shared storage/);
    expect(() =>
        checkServiceSpec(
            spec({
                replicas: 2,
                volumes: [{ name: 'data', mount: '/data', shared: true, driver: 'local' }],
            }),
        ),
    ).toThrow(/shared storage/);
    const shared = checkServiceSpec(
        spec({
            replicas: 2,
            volumes: [{ name: 'data', mount: '/data', shared: true, driver: 'nfs' }],
        }),
    );
    expect(shared.replicas).toBe(2);
    expect(checkServiceSpec(spec()).replicas).toBe(1);
});

it('publishes no host port and pins nothing to a task', () => {
    const body = swarmServiceBody({
        id: 'social-strategy',
        image: 'company-brain-plugin-social-strategy:latest',
        spec: LEGACY_PLANNER_SERVICE,
        replicas: 2,
        networkId: 'net-apps',
        proof: pluginProof(SECRET, 'social-strategy'),
        secretIds: new Map([[PLANNER_SECRET, PLANNER_SECRET_ID]]),
    });
    expect(body.Name).toBe(pluginServiceName('social-strategy'));
    expect(body.EndpointSpec).toEqual({ Mode: 'dnsrr' });
    expect(body.Mode.Replicated.Replicas).toBe(2);
    expect(JSON.stringify(body)).not.toContain('Ports');
    expect(body.TaskTemplate.ContainerSpec.Env).toEqual(
        expect.arrayContaining([
            'CB_PLUGIN_ID=social-strategy',
            `CB_PLUGIN_PROOF=${pluginProof(SECRET, 'social-strategy')}`,
            'PORT=8080',
            'SOCIO_API_URL=http://app:4310',
        ]),
    );
    expect(body.TaskTemplate.ContainerSpec.Secrets?.[0]).toMatchObject({
        SecretID: PLANNER_SECRET_ID,
        SecretName: 'company_brain_plugin_service_token',
        File: {
            Name: 'plugin_service_token',
            UID: '1000',
            GID: '1000',
            Mode: 0o400,
        },
    });
    expect(body.TaskTemplate.ContainerSpec).toMatchObject({
        User: '1000:1000',
        ReadOnly: true,
        CapabilityDrop: ['ALL'],
        Privileges: { NoNewPrivileges: true },
        // CB-321: the task's container carries the labels the stats proxy selects by.
        Labels: { 'socio.managed': 'plugin', 'socio.plugin': 'social-strategy' },
    });
    expect(body.TaskTemplate.ContainerSpec.Mounts[0]).toMatchObject({
        Type: 'tmpfs',
        Target: '/tmp',
    });
    expect(body.TaskTemplate.Resources.Limits.NanoCPUs).toBe(0.5e9);
    expect(body.TaskTemplate.Resources.Limits.MemoryBytes).toBe(256 * 1048576);
    expect(JSON.stringify(body)).not.toContain('"Privileged"');
    expect(JSON.stringify(body)).not.toContain('CapAdd');
    expect(body.TaskTemplate.Networks).toEqual([{ Target: 'net-apps' }]);
});

it('rejects a secret reference that has no SecretID', async () => {
    const engine = new MemoryDocker();
    expect(() =>
        swarmServiceBody({
            id: 'social-strategy',
            image: 'company-brain-plugin-social-strategy:latest',
            spec: LEGACY_PLANNER_SERVICE,
            replicas: 1,
            networkId: 'net-apps',
            proof: pluginProof(SECRET, 'social-strategy'),
        }),
    ).toThrow(/SecretID/);
    const body = swarmServiceBody({
        id: 'social-strategy',
        image: 'company-brain-plugin-social-strategy:latest',
        spec: LEGACY_PLANNER_SERVICE,
        replicas: 1,
        networkId: 'net-apps',
        proof: pluginProof(SECRET, 'social-strategy'),
        secretIds: new Map([[PLANNER_SECRET, PLANNER_SECRET_ID]]),
    });
    const missing = structuredClone(body);
    missing.TaskTemplate.ContainerSpec.Secrets![0]!.SecretID = '';
    await expect(engine.createService(missing)).rejects.toThrow(/malformed secret reference/);
    await engine.createService(body);
    const dropped = structuredClone(body);
    dropped.TaskTemplate.ContainerSpec.Secrets![0]!.SecretID = '';
    await expect(engine.updateService('svc-1', 1, dropped)).rejects.toThrow(/malformed secret reference/);
    expect(
        engine.specNamed(pluginServiceName('social-strategy'))?.TaskTemplate.ContainerSpec.Secrets?.[0]?.SecretID,
    ).toBe(PLANNER_SECRET_ID);
});

it('keeps secrets, healthcheck, resources, and networks when the planner scales', async () => {
    const engine = new MemoryDocker();
    engine.secrets.set(PLANNER_SECRET, PLANNER_SECRET_ID);
    const plugins = new PluginServices(engine, {
        allow: ['company-brain-plugin-'],
        maxReplicas: 5,
        secret: SECRET,
        pull: false,
        secretNames: new Set([PLANNER_SECRET]),
    });
    await plugins.ensure('social-strategy', LEGACY_PLANNER_SERVICE);
    const before = engine.specNamed(pluginServiceName('social-strategy'));
    expect(before?.TaskTemplate.ContainerSpec.Secrets).toEqual([
        expect.objectContaining({
            SecretID: PLANNER_SECRET_ID,
            SecretName: PLANNER_SECRET,
            File: expect.objectContaining({
                Name: 'plugin_service_token',
                UID: '1000',
                GID: '1000',
                Mode: 0o400,
            }),
        }),
    ]);
    expect(before?.TaskTemplate.ContainerSpec.Healthcheck.Test.length).toBeGreaterThan(0);
    expect(before?.TaskTemplate.Resources.Limits).toEqual({
        NanoCPUs: 0.5e9,
        MemoryBytes: 256 * 1048576,
        Pids: 256,
    });
    expect(before?.TaskTemplate.Networks).toEqual([{ Target: 'net-socio-plugin-net-social-strategy' }]);
    expect(before?.TaskTemplate.ContainerSpec.Env).toEqual(
        expect.arrayContaining(['SOCIO_API_TOKEN_FILE=/run/secrets/plugin_service_token']),
    );
    await plugins.scale('social-strategy', 2);
    const after = engine.specNamed(pluginServiceName('social-strategy'));
    expect(after?.Mode.Replicated.Replicas).toBe(2);
    expect(after?.TaskTemplate.ContainerSpec.Secrets).toEqual(before?.TaskTemplate.ContainerSpec.Secrets);
    expect(after?.TaskTemplate.ContainerSpec.Healthcheck).toEqual(before?.TaskTemplate.ContainerSpec.Healthcheck);
    expect(after?.TaskTemplate.Resources).toEqual(before?.TaskTemplate.Resources);
    expect(after?.TaskTemplate.Networks).toEqual(before?.TaskTemplate.Networks);
    expect(after?.TaskTemplate.ContainerSpec.Env).toEqual(before?.TaskTemplate.ContainerSpec.Env);
    expect(await plugins.status('social-strategy')).toMatchObject({
        replicas: 2,
        running: 2,
    });
});

it('round-robins replicas and will not scale a local volume', async () => {
    const { engine, plugins } = services();
    await plugins.ensure('social-strategy', spec({ replicas: 2 }));
    const first = await plugins.targets('social-strategy');
    const second = await plugins.targets('social-strategy');
    expect(first.map((task) => task.host)).toEqual(['10.8.0.1', '10.8.0.2']);
    expect(second.map((task) => task.host)).toEqual(['10.8.0.2', '10.8.0.1']);
    expect(first[0]?.port).toBe(8080);
    expect([...engine.networks.values()][0]).toMatchObject({
        name: 'socio-plugin-net-social-strategy',
        driver: 'overlay',
        internal: true,
    });
    await plugins.scale('social-strategy', 0);
    expect(await plugins.status('social-strategy')).toMatchObject({
        replicas: 0,
        state: 'stopped',
    });
    expect(await plugins.targets('social-strategy')).toEqual([]);
    await expect(
        plugins.ensure(
            'disk',
            spec({
                image: 'company-brain-plugin-disk',
                replicas: 2,
                volumes: [{ name: 'data', mount: '/data' }],
            }),
        ),
    ).rejects.toThrow(/shared storage/);
    await plugins.remove('social-strategy');
    expect(await plugins.status('social-strategy')).toBeUndefined();
    expect(engine.services.size).toBe(0);
    expect(engine.networks.size).toBe(0);
});

it('refuses an image outside the allow list and a foreign service of the same name', async () => {
    const { engine, plugins } = services();
    await expect(plugins.ensure('other', spec({ image: 'library/nginx' }))).rejects.toThrow(/APPS_RUNTIME_IMAGE_ALLOW/);
    engine.services.set('foreign', {
        id: 'foreign',
        version: 1,
        name: pluginServiceName('social-strategy'),
        labels: {},
        replicas: 1,
        image: 'library/nginx:latest',
        env: [],
        volumes: [],
    });
    await expect(plugins.ensure('social-strategy', spec())).rejects.toThrow(/not a Socio plugin/);
    await expect(plugins.remove('social-strategy')).rejects.toThrow(/not a Socio plugin/);
    expect(engine.services.has('foreign')).toBe(true);
});

it('strips a client proof and tries the next replica when the first does not answer', async () => {
    const task = createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end(String(request.headers[RUNTIME_HEADER_PLUGIN_PROOF] ?? ''));
    });
    const port = await listen(task);
    const engine = new MemoryDocker();
    const real = engine.tasks.bind(engine);
    engine.tasks = async (name) => {
        const rows = await real(name);
        return rows.map((row, index) => ({
            ...row,
            ip: index === 0 ? '127.0.0.254' : '127.0.0.1',
        }));
    };
    const { plugins } = services(engine);
    await plugins.ensure('social-strategy', spec({ port, replicas: 2 }));
    const supervisor = {
        running: () => false,
        connectApp: () => {
            throw new Error('mini apps are not this request');
        },
    } as unknown as AppsSupervisor;
    const ingress = ingressServer(supervisor, SECRET, plugins);
    const ingressPort = await listen(ingress);
    try {
        const response = await fetch(`http://127.0.0.1:${ingressPort}/healthz`, {
            headers: {
                [RUNTIME_HEADER_APP]: 'social-strategy',
                [RUNTIME_HEADER_KEY]: ingressKey(SECRET),
                [RUNTIME_HEADER_PLUGIN_PROOF]: 'forged',
            },
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(pluginProof(SECRET, 'social-strategy'));
    } finally {
        ingress.close();
        task.close();
    }
});

it('requires digests on a direct Docker socket, refuses one behind the proxy, and builds the plugin image', () => {
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    expect(
        dockerServicesFromEnv({
            APPS_RUNTIME_DOCKER: 'on',
            APPS_RUNTIME_IMAGE_ALLOW: 'company-brain-plugin-',
            APPS_RUNTIME_DOCKER_HOST: '/var/run/docker.sock',
        })?.requireDigest,
    ).toBe(true);
    expect(() =>
        dockerServicesFromEnv({
            APPS_RUNTIME_DOCKER: 'on',
            APPS_RUNTIME_IMAGE_ALLOW: 'company-brain-plugin-',
            APPS_RUNTIME_DOCKER_HOST: '/var/run/docker.sock',
            APPS_RUNTIME_DOCKER_PROXY: 'on',
        }),
    ).toThrow(/direct Docker socket/);
    expect(matchProxyRoute('GET', '/_ping')).toEqual({ route: 'ping' });
    expect(dockerfile).toContain('FROM prod-deps-slim AS plugin-social-strategy');
    expect(dockerfile).toContain('CMD ["node", "dist/server/server/plugins/planner/main.js"]');
    expect(dockerfile).not.toMatch(/FROM node:.*AS plugin-social-strategy/);
});

it('sends a request for an install revision only to current tasks of a service running it (CB-370)', async () => {
    const { engine, plugins } = services();
    const image = `company-brain-plugin-social-strategy@sha256:${'a'.repeat(64)}`;
    const one = '1'.repeat(64);
    const two = '2'.repeat(64);
    await plugins.ensure('social-strategy', spec({ image, replicas: 2, env: { VERIFY: 'off' }, revision: one }));
    const record = () => [...engine.services.values()].find((row) => row.labels['socio.plugin'] === 'social-strategy')!;
    expect(record().labels['socio.plugin.revision']).toBe(one);
    const before = record().revision!;
    // The same image with new settings: a new container revision and install revision.
    await plugins.ensure('social-strategy', spec({ image, replicas: 2, env: { VERIFY: 'on' }, revision: two }));
    const after = record().revision!;
    expect(after).not.toBe(before);
    // A rollout half done: the first task still runs the old container.
    engine.taskRevisions = [before, after];
    expect((await plugins.targets('social-strategy', two)).map((task) => task.host)).toEqual(['10.8.0.2']);
    // A request for another install revision than the service runs: no task at all.
    expect(await plugins.targets('social-strategy', one)).toEqual([]);
    expect(await plugins.targets('social-strategy', '')).toEqual([]);
    // Without one: any running task, as before.
    expect(await plugins.targets('social-strategy')).toHaveLength(2);
    // None of the current container yet: none.
    engine.taskRevisions = [before, before];
    expect(await plugins.targets('social-strategy', two)).toEqual([]);
    // A catalog can't set the revision; Socio's must be 64 hex digits.
    expect(() => checkServiceSpec({ image, port: 8080, revision: 'nope' })).toThrow(/revision/);
});
