import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { identitySecretName, parseIdentitySecretName, SWARM_IDENTITY_PATH } from '@socio/shared/identity-delivery';
import { setPluginNamePrefix, swarmServiceBody, type SwarmServiceBody } from '@socio/shared/plugins/plugin-service';

import { runtimeApp } from '../src/apps-runtime/api.js';
import { dockerServicesFromEnv } from '../src/apps-runtime/config.js';
import { HttpDockerEngine, MemoryDocker } from '../src/apps-runtime/docker.js';
import { LocalIdentityDelivery, SwarmIdentityDelivery } from '../src/apps-runtime/identity-delivery.js';
import { pluginProof } from '../src/apps-runtime/keys.js';
import { PluginServices } from '../src/apps-runtime/services.js';
import {
    identitySecretCreateErrors,
    identitySecretDeletable,
    pluginServiceErrors,
    startSocketProxy,
    type ProxyPolicy,
} from '../src/apps-runtime/socket-proxy.js';
import type { AppsSupervisor } from '../src/apps-runtime/supervisor.js';
import { socialStrategyManifest } from '../src/server/plugins/planner/manifest.js';

// Socio Secrets phase 2: the identity delivery port's adapters, and the
// socket proxy narrowed to exactly what the Swarm adapter needs: create
// and delete plugin identity secrets (the deployment's prefix and the
// plugin's labels), and mount a plugin's own identity, nothing else.

const SECRET = 'runtime-secret-runtime-secret-32';
const TOKEN = (n: number) => `cbpi_${String(n).padStart(43, 'A')}`;
const IMAGE = `company-brain-plugin-social-strategy@sha256:${'ab'.repeat(32)}`;
const PINS = new Map([['social-strategy', IMAGE]]);
const LEGACY = 'company_brain_plugin_service_token';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    setPluginNamePrefix(undefined);
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

function listen(server: Server) {
    return new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve(typeof address === 'object' && address ? address.port : 0);
        });
    });
}

async function bodyOf(req: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.from(chunk as Buffer));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/**
 * A Docker engine that keeps networks, services and secrets, and refuses
 * like Swarm: a secret a service references can't be deleted, and a
 * service can't reference a secret id that doesn't exist.
 */
async function fakeEngine() {
    const secrets = new Map<string, { name: string; labels: Record<string, string>; data: string }>();
    const services = new Map<string, { version: number; spec: SwarmServiceBody }>();
    const networks = new Map<string, { Id: string; Name: string; Driver: string; Internal: boolean }>();
    const seen: string[] = [];
    let seq = 1;
    const send = (res: import('node:http').ServerResponse, status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
    };
    const filterOf = (url: URL) =>
        JSON.parse(url.searchParams.get('filters') ?? '{}') as Record<string, Record<string, boolean>>;
    const inUse = (id: string) =>
        [...services.values()].some(({ spec }) =>
            (spec.TaskTemplate.ContainerSpec.Secrets ?? []).some((secret) => secret.SecretID === id),
        );
    const server = createServer((req, res) => {
        void (async () => {
            const url = new URL(req.url ?? '/', 'http://engine');
            const path = url.pathname;
            seen.push(`${req.method} ${path}`);
            const body = req.method === 'POST' ? await bodyOf(req) : {};
            if (req.method === 'GET' && path === '/v1.44/secrets') {
                const names = Object.keys(filterOf(url).names ?? {});
                return send(
                    res,
                    200,
                    [...secrets.entries()]
                        .filter(([, row]) => names.includes(row.name))
                        .map(([id, row]) => ({ ID: id, Spec: { Name: row.name, Labels: row.labels } })),
                );
            }
            if (req.method === 'POST' && path === '/v1.44/secrets/create') {
                if ([...secrets.values()].some((row) => row.name === body.Name)) {
                    return send(res, 409, { message: 'secret exists' });
                }
                const id = `sid${seq++}`;
                secrets.set(id, {
                    name: String(body.Name),
                    labels: body.Labels as Record<string, string>,
                    data: String(body.Data),
                });
                return send(res, 201, { ID: id });
            }
            const secret = /^\/v1\.44\/secrets\/([^/]+)$/.exec(path);
            if (secret) {
                // Like the engine, an inspect also resolves a name.
                const byName = [...secrets.entries()].find(([, item]) => item.name === secret[1]);
                const row = secrets.get(secret[1]!) ?? (req.method === 'GET' ? byName?.[1] : undefined);
                if (!row) {
                    return send(res, 404, { message: 'no such secret' });
                }
                if (req.method === 'GET') {
                    return send(res, 200, {
                        ID: secrets.has(secret[1]!) ? secret[1] : byName![0],
                        Spec: { Name: row.name, Labels: row.labels },
                    });
                }
                if (req.method === 'DELETE') {
                    if (inUse(secret[1]!)) {
                        return send(res, 400, { message: 'secret is in use by a service' });
                    }
                    secrets.delete(secret[1]!);
                    res.writeHead(204);
                    return res.end();
                }
            }
            if (req.method === 'GET' && path === '/v1.44/networks') {
                const names = Object.keys(filterOf(url).name ?? {});
                return send(
                    res,
                    200,
                    [...networks.values()].filter((row) => names.includes(row.Name)),
                );
            }
            const network = /^\/v1\.44\/networks\/([^/]+)$/.exec(path);
            if (network && path !== '/v1.44/networks/create') {
                const row = [...networks.values()].find((item) => item.Id === network[1] || item.Name === network[1]);
                if (!row) {
                    return send(res, 404, { message: 'no such network' });
                }
                if (req.method === 'DELETE') {
                    networks.delete(row.Id);
                    res.writeHead(204);
                    return res.end();
                }
                return send(res, 200, row);
            }
            if (req.method === 'POST' && path === '/v1.44/networks/create') {
                const id = `net${seq++}`;
                networks.set(id, {
                    Id: id,
                    Name: String(body.Name),
                    Driver: String(body.Driver),
                    Internal: body.Internal === true,
                });
                return send(res, 201, { Id: id });
            }
            const record = (id: string) => ({
                ID: id,
                Version: { Index: services.get(id)!.version },
                Spec: services.get(id)!.spec,
            });
            if (req.method === 'GET' && path === '/v1.44/services') {
                const names = Object.keys(filterOf(url).name ?? {});
                return send(
                    res,
                    200,
                    [...services.keys()]
                        .filter((id) => !names.length || names.includes(services.get(id)!.spec.Name))
                        .map(record),
                );
            }
            const missing = (spec: SwarmServiceBody) =>
                (spec.TaskTemplate.ContainerSpec.Secrets ?? []).some((ref) => !secrets.has(ref.SecretID));
            if (req.method === 'POST' && path === '/v1.44/services/create') {
                const spec = body as unknown as SwarmServiceBody;
                if (missing(spec)) {
                    return send(res, 400, { message: 'secret not found' });
                }
                const id = `svc${seq++}`;
                services.set(id, { version: 1, spec });
                return send(res, 201, { ID: id });
            }
            const update = /^\/v1\.44\/services\/([^/]+)\/update$/.exec(path);
            if (req.method === 'POST' && update) {
                const spec = body as unknown as SwarmServiceBody;
                const current = services.get(update[1]!)!;
                if (missing(spec)) {
                    return send(res, 400, { message: 'secret not found' });
                }
                services.set(update[1]!, { version: current.version + 1, spec });
                return send(res, 200, {});
            }
            const one = /^\/v1\.44\/services\/([^/]+)$/.exec(path);
            if (one && services.has(one[1]!)) {
                if (req.method === 'DELETE') {
                    services.delete(one[1]!);
                    res.writeHead(200);
                    return res.end();
                }
                return send(res, 200, record(one[1]!));
            }
            if (req.method === 'GET' && path === '/v1.44/tasks') {
                return send(res, 200, []);
            }
            send(res, 500, { message: `unexpected ${req.method} ${path}` });
        })();
    });
    const port = await listen(server);
    cleanup.push(() => new Promise((resolve) => server.close(resolve)));
    return { port, secrets, services, seen };
}

async function proxied() {
    const engine = await fakeEngine();
    // A Layer-1 style secret that is not the runtime's: never deletable.
    engine.secrets.set('legacy-id', { name: LEGACY, labels: {}, data: 'eA==' });
    const proxy = startSocketProxy({
        listenHost: '127.0.0.1',
        listenPort: 0,
        upstream: `http://127.0.0.1:${engine.port}`,
        pins: PINS,
        infra: new Set(),
        secretNames: new Set([LEGACY]),
        log: () => {},
    });
    const server = await proxy.listen();
    cleanup.push(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();
    const endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const call = (method: string, path: string, body?: unknown) =>
        fetch(`${endpoint}${path}`, {
            method,
            ...(body === undefined
                ? {}
                : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        });
    return { engine, endpoint, call };
}

it('names identity secrets with the deployment prefix, within Swarm’s 64 characters', () => {
    expect(identitySecretName('social-strategy', 3)).toBe('socio-plugin-wl-social-strategy-v3');
    expect(parseIdentitySecretName('socio-plugin-wl-social-strategy-v3')).toEqual({
        pluginId: 'social-strategy',
        version: 3,
    });
    // A plugin id that looks like a version still parses to the last -v<n>.
    expect(parseIdentitySecretName('socio-plugin-wl-foo-v2-v3')).toEqual({ pluginId: 'foo-v2', version: 3 });
    for (const name of [
        'company_brain_plugin_service_token',
        'socio_acme_infisical_identity',
        'other-plugin-wl-social-strategy-v1',
        'socio-plugin-social-strategy',
        'socio-plugin-wl-social-strategy-v0',
        'socio-plugin-wl-Social-v1',
    ]) {
        expect(parseIdentitySecretName(name)).toBeUndefined();
    }
    expect(() => identitySecretName('a'.repeat(50), 1)).toThrow(/64 characters/);
    expect(() => identitySecretName('bad--id', 1)).toThrow();
    setPluginNamePrefix('example-plugin');
    expect(identitySecretName('planner', 1)).toBe('example-plugin-wl-planner-v1');
    expect(parseIdentitySecretName('socio-plugin-wl-planner-v1')).toBeUndefined();
});

it('delivers, rotates and removes a plugin identity through the socket proxy (Swarm adapter)', async () => {
    const { engine, endpoint } = await proxied();
    const docker = new HttpDockerEngine(endpoint, false);
    const logs: string[] = [];
    const services = new PluginServices(docker, {
        allow: ['company-brain-plugin-'],
        maxReplicas: 5,
        secret: SECRET,
        pull: false,
        pins: PINS,
        requireDigest: true,
        identity: new SwarmIdentityDelivery(docker),
        log: (line) => logs.push(line),
    });
    await services.ensure('social-strategy', socialStrategyManifest.service!, { token: TOKEN(1), version: 1 });
    const v1 = identitySecretName('social-strategy', 1);
    const created = [...engine.secrets.entries()].find(([, row]) => row.name === v1)!;
    expect(created[1]).toEqual({
        name: v1,
        labels: { 'socio.managed': 'plugin', 'socio.plugin': 'social-strategy' },
        data: Buffer.from(TOKEN(1)).toString('base64'),
    });
    const [service] = [...engine.services.values()];
    expect(service!.spec.TaskTemplate.ContainerSpec.Secrets).toEqual([
        {
            SecretID: created[0],
            SecretName: v1,
            File: { Name: 'socio_identity', UID: '1000', GID: '1000', Mode: 0o400 },
        },
    ]);
    expect(service!.spec.TaskTemplate.ContainerSpec.Env).toContain(`SOCIO_IDENTITY_FILE=${SWARM_IDENTITY_PATH}`);
    expect(service!.spec.Labels['socio.identity']).toBe('1');

    // A rotation: version 2 is created, the service moves to it, version 1 goes.
    await services.ensure('social-strategy', socialStrategyManifest.service!, { token: TOKEN(2), version: 2 });
    const names = () => [...engine.secrets.values()].map((row) => row.name).sort();
    expect(names()).toEqual([LEGACY, identitySecretName('social-strategy', 2)]);
    expect([...engine.services.values()][0]!.spec.Labels['socio.identity']).toBe('2');
    expect(logs).toEqual([]);

    // Uninstall: the service, its network and every identity version go; the other secret stays.
    await services.remove('social-strategy');
    expect(engine.services.size).toBe(0);
    expect(names()).toEqual([LEGACY]);
    // The engine never saw a token outside a secret create.
    expect(engine.seen.filter((line) => line.startsWith('POST /v1.44/secrets/create'))).toHaveLength(2);
});

it('takes back a version whose service write failed, and keeps the running one', async () => {
    const engine = new MemoryDocker();
    const services = new PluginServices(engine, {
        allow: ['company-brain-plugin-'],
        maxReplicas: 5,
        secret: SECRET,
        pull: false,
        identity: new SwarmIdentityDelivery(engine),
    });
    await services.ensure('social-strategy', socialStrategyManifest.service!, { token: TOKEN(1), version: 1 });
    const update = engine.updateService.bind(engine);
    engine.updateService = async () => {
        throw new Error('engine refused');
    };
    await expect(
        services.ensure('social-strategy', socialStrategyManifest.service!, { token: TOKEN(2), version: 2 }),
    ).rejects.toThrow(/engine refused/);
    engine.updateService = update;
    expect([...engine.secrets.keys()]).toEqual([identitySecretName('social-strategy', 1)]);
    // Without a delivery adapter, an identity can't be given.
    const bare = new PluginServices(new MemoryDocker(), {
        allow: ['company-brain-plugin-'],
        maxReplicas: 5,
        secret: SECRET,
        pull: false,
    });
    await expect(
        bare.ensure('social-strategy', socialStrategyManifest.service!, { token: TOKEN(1), version: 1 }),
    ).rejects.toThrow(/no identity delivery/);
    // A malformed token never reaches the engine.
    await expect(
        services.ensure('social-strategy', socialStrategyManifest.service!, { token: 'not-a-token', version: 3 }),
    ).rejects.toThrow(/identity token/);
});

it('lets the runtime create and delete only plugin identity secrets (fail closed)', async () => {
    const { engine, call } = await proxied();
    const name = identitySecretName('social-strategy', 1);
    const labels = { 'socio.managed': 'plugin', 'socio.plugin': 'social-strategy' };
    const data = Buffer.from(TOKEN(1)).toString('base64');
    const refused = async (method: string, path: string, body?: unknown) => {
        const response = await call(method, path, body);
        expect(response.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(403);
    };
    const before = engine.seen.length;
    // Names without this deployment's prefix and shape, wrong labels, extra fields, bad data.
    await refused('POST', '/v1.44/secrets/create', { Name: LEGACY, Labels: labels, Data: data });
    await refused('POST', '/v1.44/secrets/create', {
        Name: 'other-plugin-wl-social-strategy-v1',
        Labels: labels,
        Data: data,
    });
    await refused('POST', '/v1.44/secrets/create', {
        Name: 'socio-plugin-social-strategy',
        Labels: labels,
        Data: data,
    });
    await refused('POST', '/v1.44/secrets/create', { Name: name, Labels: { 'socio.managed': 'plugin' }, Data: data });
    await refused('POST', '/v1.44/secrets/create', {
        Name: name,
        Labels: { 'socio.managed': 'plugin', 'socio.plugin': 'reports' },
        Data: data,
    });
    await refused('POST', '/v1.44/secrets/create', { Name: name, Labels: { ...labels, extra: 'x' }, Data: data });
    await refused('POST', '/v1.44/secrets/create', {
        Name: name,
        Labels: labels,
        Data: data,
        Driver: { Name: 'vault' },
    });
    await refused('POST', '/v1.44/secrets/create', {
        Name: name,
        Labels: labels,
        Data: data,
        Templating: { Name: 'golang' },
    });
    await refused('POST', '/v1.44/secrets/create', { Name: name, Labels: labels, Data: data, data: 'eA==' });
    await refused('POST', '/v1.44/secrets/create', { Name: name, Labels: labels, Data: 'not base64!' });
    // Other verbs and routes on secrets stay closed.
    await refused('POST', '/v1.44/secrets/legacy-id/update', { Name: LEGACY });
    await refused('GET', '/v1.44/secrets/legacy-id');
    await refused('GET', '/v1.44/secrets');
    await refused(
        'GET',
        `/v1.44/secrets?filters=${encodeURIComponent(JSON.stringify({ names: { 'other-plugin-wl-x-v1': true } }))}`,
    );
    await refused(
        'GET',
        `/v1.44/secrets?filters=${encodeURIComponent(JSON.stringify({ label: { 'socio.managed=plugin': true } }))}`,
    );
    await refused('GET', '/v1.44/configs');
    // Nothing refused so far reached the engine.
    expect(engine.seen.slice(before)).toEqual([]);

    // The one allowed create, then its lookup by exact name.
    const ok = await call('POST', '/v1.44/secrets/create', { Name: name, Labels: labels, Data: data });
    expect(ok.status).toBe(201);
    const { ID } = (await ok.json()) as { ID: string };
    const looked = await call(
        'GET',
        `/v1.44/secrets?filters=${encodeURIComponent(JSON.stringify({ names: { [name]: true } }))}`,
    );
    expect(await looked.json()).toEqual([{ ID, Spec: { Name: name } }]);
    // Delete: never a secret that isn't an identity, never by name, only by its full id.
    await refused('DELETE', '/v1.44/secrets/legacy-id');
    await refused('DELETE', `/v1.44/secrets/${name}`);
    // An identity-named secret someone else made without the labels is refused too.
    engine.secrets.set('forged', { name: identitySecretName('reports', 1), labels: {}, data: 'eA==' });
    await refused('DELETE', '/v1.44/secrets/forged');
    expect((await call('DELETE', '/v1.44/secrets/nope')).status).toBe(404);
    expect((await call('DELETE', `/v1.44/secrets/${ID}`)).status).toBe(204);
    expect(engine.secrets.has('legacy-id')).toBe(true);
});

it('lets a plugin service mount only its own identity, by the engine’s id, at the fixed file', () => {
    const network = (target: string) =>
        target === 'net-social'
            ? { name: 'socio-plugin-net-social-strategy', driver: 'overlay', internal: true }
            : undefined;
    const name = identitySecretName('social-strategy', 4);
    const body = (identity: { secretId: string; secretName: string; file: string }) =>
        swarmServiceBody({
            id: 'social-strategy',
            image: IMAGE,
            spec: socialStrategyManifest.service!,
            replicas: 1,
            networkId: 'net-social',
            proof: pluginProof(SECRET, 'social-strategy'),
            identity: {
                fileEnv: 'SOCIO_IDENTITY_FILE',
                path: SWARM_IDENTITY_PATH,
                version: 4,
                mount: { kind: 'swarm-secret', ...identity },
            },
        });
    const policy = (ids: Record<string, string>): ProxyPolicy => ({
        pins: PINS,
        infra: new Set(),
        network,
        secretNames: new Set(),
        secretIds: new Map(Object.entries(ids)),
    });
    expect(
        pluginServiceErrors(
            body({ secretId: 's4', secretName: name, file: 'socio_identity' }),
            policy({ [name]: 's4' }),
        ),
    ).toEqual([]);
    // Another plugin's identity.
    const theirs = identitySecretName('reports', 1);
    expect(
        pluginServiceErrors(
            body({ secretId: 's9', secretName: theirs, file: 'socio_identity' }),
            policy({ [theirs]: 's9' }),
        ).join(),
    ).toMatch(/another plugin's identity/);
    // Another file name, an id that isn't the engine's, or no lookup at all.
    expect(
        pluginServiceErrors(body({ secretId: 's4', secretName: name, file: 'token' }), policy({ [name]: 's4' })).join(),
    ).toMatch(/mounted as socio_identity/);
    expect(
        pluginServiceErrors(
            body({ secretId: 'other', secretName: name, file: 'socio_identity' }),
            policy({ [name]: 's4' }),
        ).join(),
    ).toMatch(/SecretID does not match/);
    expect(
        pluginServiceErrors(body({ secretId: 's4', secretName: name, file: 'socio_identity' }), policy({})).join(),
    ).toMatch(/SecretID does not match/);
    // The label is the version's digits only.
    const labelled = body({ secretId: 's4', secretName: name, file: 'socio_identity' });
    labelled.Labels['socio.identity'] = 'four';
    expect(pluginServiceErrors(labelled, policy({ [name]: 's4' })).join()).toMatch(/socio.identity/);
    // A manifest may not take the identity's path or env.
    expect(() =>
        swarmServiceBody({
            id: 'social-strategy',
            image: IMAGE,
            spec: { ...socialStrategyManifest.service!, env: { SOCIO_IDENTITY_FILE: '/tmp/x' } },
            replicas: 1,
            networkId: 'net-social',
            proof: 'p',
        }),
    ).toThrow(/SOCIO_IDENTITY_FILE/);
    expect(() =>
        swarmServiceBody({
            id: 'social-strategy',
            image: IMAGE,
            spec: { ...socialStrategyManifest.service!, secrets: [{ name: LEGACY, target: SWARM_IDENTITY_PATH }] },
            replicas: 1,
            networkId: 'net-social',
            proof: 'p',
            secretIds: new Map([[LEGACY, 'x']]),
        }),
    ).toThrow(/identity/);
});

it('checks a secret create and an engine copy before a delete', () => {
    const name = identitySecretName('social-strategy', 1);
    const labels = { 'socio.managed': 'plugin', 'socio.plugin': 'social-strategy' };
    expect(identitySecretCreateErrors({ Name: name, Labels: labels, Data: 'Y2JwaQ==' })).toEqual([]);
    expect(identitySecretCreateErrors(null)).not.toEqual([]);
    expect(identitySecretCreateErrors({ name, Labels: labels, Data: 'Y2JwaQ==' })).not.toEqual([]);
    expect(identitySecretCreateErrors({ Name: name, Labels: labels, Data: 'x'.repeat(2000) })).not.toEqual([]);
    expect(identitySecretDeletable({ ID: 'a', Spec: { Name: name, Labels: labels } }, 'a')).toBe(true);
    expect(identitySecretDeletable({ ID: 'a', Spec: { Name: name, Labels: labels } }, 'b')).toBe(false);
    expect(identitySecretDeletable({ ID: 'a', Spec: { Name: name, Labels: { 'socio.managed': 'app' } } }, 'a')).toBe(
        false,
    );
    expect(identitySecretDeletable({ ID: 'a', Spec: { Name: LEGACY, Labels: labels } }, 'a')).toBe(false);
});

it('delivers to 0400 files in development (local adapter) and retires older versions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'socio-identity-local-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const local = new LocalIdentityDelivery(join(dir, 'identities'));
    const ref = { kind: 'plugin' as const, id: 'social-strategy' };
    const first = await local.deliver(ref, TOKEN(1), 1);
    expect(first).toEqual({
        fileEnv: 'SOCIO_IDENTITY_FILE',
        path: join(dir, 'identities', 'plugin-social-strategy', 'identity-v1'),
        version: 1,
    });
    expect(readFileSync(first.path, 'utf8')).toBe(TOKEN(1));
    expect(statSync(first.path).mode & 0o777).toBe(0o400);
    expect(statSync(join(dir, 'identities', 'plugin-social-strategy')).mode & 0o777).toBe(0o700);
    const second = await local.deliver(ref, TOKEN(2), 2);
    await local.retire(ref, 2);
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(true);
    await local.discard(ref, 2);
    expect(existsSync(second.path)).toBe(false);
    await expect(local.deliver({ kind: 'plugin', id: '../x' }, TOKEN(1), 1)).rejects.toThrow();
    await expect(local.deliver(ref, 'shared-token', 3)).rejects.toThrow(/identity token/);
});

it('picks the delivery from the environment, and refuses local files behind the socket proxy', () => {
    const base = { APPS_RUNTIME_DOCKER: 'on', APPS_RUNTIME_IMAGE_ALLOW: 'company-brain-plugin-' };
    expect(dockerServicesFromEnv(base)?.identity).toEqual({ kind: 'swarm' });
    expect(
        dockerServicesFromEnv({
            ...base,
            APPS_RUNTIME_IDENTITY_DELIVERY: 'local',
            APPS_RUNTIME_IDENTITY_DIR: '/tmp/ids',
        })?.identity,
    ).toEqual({ kind: 'local', dir: '/tmp/ids' });
    expect(() =>
        dockerServicesFromEnv({
            ...base,
            APPS_RUNTIME_IDENTITY_DELIVERY: 'local',
            APPS_RUNTIME_IDENTITY_DIR: '/tmp/ids',
            APPS_RUNTIME_DOCKER_HOST: 'tcp://docker-socket-proxy:2375',
            APPS_RUNTIME_DOCKER_PROXY: 'on',
        }),
    ).toThrow(/development/);
    expect(() => dockerServicesFromEnv({ ...base, APPS_RUNTIME_IDENTITY_DELIVERY: 'local' })).toThrow(/IDENTITY_DIR/);
    expect(() => dockerServicesFromEnv({ ...base, APPS_RUNTIME_IDENTITY_DELIVERY: 'k8s' })).toThrow(/swarm or local/);
});

it('takes an identity with a provision over the runtime API, and refuses a malformed one', async () => {
    const engine = new MemoryDocker();
    const services = new PluginServices(engine, {
        allow: ['company-brain-plugin-'],
        maxReplicas: 5,
        secret: SECRET,
        pull: false,
        identity: new SwarmIdentityDelivery(engine),
    });
    const api = runtimeApp({} as AppsSupervisor, SECRET, 1024 * 1024, services);
    const put = (body: unknown) =>
        api.request('/v1/services/social-strategy', {
            method: 'PUT',
            headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    const spec = socialStrategyManifest.service!;
    expect((await put({ spec, identity: { token: 'shared', version: 1 } })).status).toBe(400);
    expect((await put({ spec, identity: { token: TOKEN(1), version: 0 } })).status).toBe(400);
    expect((await put({ spec, identity: { token: TOKEN(1), version: 1, extra: true } })).status).toBe(400);
    const ok = await put({ spec, identity: { token: TOKEN(1), version: 1 } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).not.toContain(TOKEN(1));
    expect(engine.secrets.has(identitySecretName('social-strategy', 1))).toBe(true);
    // An older Socio sends no identity: the service is written without one.
    expect((await put({ spec })).status).toBe(200);
});
