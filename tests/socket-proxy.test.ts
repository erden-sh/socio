import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
    PLUGIN_PIDS,
    PLUGIN_PIDS_CAP,
    pluginServiceName,
    swarmServiceBody,
    type SwarmServiceBody,
    pluginNetworkName,
    setPluginNamePrefix,
} from '@socio/shared/plugins/plugin-service';

import { goDecodeServiceSpec, HttpDockerEngine, MemoryDocker } from '../src/apps-runtime/docker.js';
import { pluginProof } from '../src/apps-runtime/keys.js';
import { containerRevision } from '../src/apps-runtime/revision.js';
import {
    SOCKET_PROXY_ALLOWLIST,
    SOCKET_PROXY_DENIED,
    imagePullError,
    infraUpdateErrors,
    matchProxyRoute,
    networkCreateErrors,
    normalizeDockerPath,
    parseSecretNames,
    pluginServiceErrors,
    secretLookupName,
    startSocketProxy,
    type PluginNetworkInfo,
    type ProxyPolicy,
    volumeClaimsOf,
} from '../src/apps-runtime/socket-proxy.js';
import { socialStrategyManifest } from '../src/server/plugins/planner/manifest.js';

const DIGEST = 'ab'.repeat(32);
const IMAGE = `company-brain-plugin-social-strategy@sha256:${DIGEST}`;
const PINS = new Map([['social-strategy', IMAGE]]);

it('scales an inspected Docker spec without allowing other field changes', async () => {
    const generated = service();
    let spec = {
        ...generated,
        TaskTemplate: { ...generated.TaskTemplate, ForceUpdate: 0, Placement: {} },
        UpdateConfig: { Parallelism: 1, FailureAction: 'pause' },
        RollbackConfig: { Parallelism: 1, FailureAction: 'pause' },
    };
    const original = structuredClone(spec);
    let version = 1;
    let updates = 0;
    const engine = createServer(async (req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url?.startsWith('/v1.44/networks/')) {
            res.end(
                JSON.stringify({
                    Id: 'net-social',
                    Name: 'socio-plugin-net-social-strategy',
                    Driver: 'overlay',
                    Internal: true,
                }),
            );
        } else if (req.method === 'GET') {
            res.end(JSON.stringify({ ID: 'svc1', Version: { Index: version }, Spec: spec }));
        } else {
            const chunks = [];
            for await (const chunk of req) {
                chunks.push(Buffer.from(chunk));
            }
            spec = JSON.parse(Buffer.concat(chunks).toString());
            version++;
            updates++;
            res.end('{}');
        }
    });
    const enginePort = await listen(engine);
    const proxy = startSocketProxy({
        listenHost: '127.0.0.1',
        listenPort: 0,
        upstream: `http://127.0.0.1:${enginePort}`,
        pins: PINS,
        infra: new Set(),
        secretNames: new Set([PLANNER_SECRET]),
        log: () => {},
    });
    const server = await proxy.listen();
    const address = server.address();
    const endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    try {
        const client = new HttpDockerEngine(endpoint, false);
        for (const replicas of [0, 2]) {
            await client.scaleService('svc1', version, replicas);
            expect(spec).toEqual({
                ...original,
                Mode: { Replicated: { Replicas: replicas } },
            });
        }
        for (const patch of [
            { ...spec, TaskTemplate: { ...spec.TaskTemplate, ForceUpdate: 1 } },
            {
                ...spec,
                TaskTemplate: {
                    ...spec.TaskTemplate,
                    ContainerSpec: {
                        ...spec.TaskTemplate.ContainerSpec,
                        ReadOnly: false,
                    },
                },
            },
            { ...spec, Mode: { Replicated: { Replicas: 21 } } },
        ]) {
            const response = await fetch(`${endpoint}/v1.44/services/svc1/update?version=${version}`, {
                method: 'POST',
                body: JSON.stringify(patch),
            });
            expect(response.status).toBe(403);
        }
        expect(updates).toBe(2);
    } finally {
        server.close();
        engine.close();
    }
});

function network(target: string): PluginNetworkInfo | undefined {
    if (target === 'net-social') {
        return {
            name: 'socio-plugin-net-social-strategy',
            driver: 'overlay',
            internal: true,
        };
    }
    if (target === 'host') {
        return { name: 'host', driver: 'host', internal: false };
    }
    if (target === 'apps-net') {
        return { name: 'apps', driver: 'overlay', internal: true };
    }
    return undefined;
}

const PLANNER_SECRET = 'company_brain_plugin_service_token';
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

function policy(): ProxyPolicy {
    return {
        pins: PINS,
        infra: new Set(['company-brain_apps', 'company-brain_app']),
        network,
        secretNames: new Set([PLANNER_SECRET]),
    };
}

function service(): SwarmServiceBody {
    return swarmServiceBody({
        id: 'social-strategy',
        image: IMAGE,
        spec: LEGACY_PLANNER_SERVICE,
        replicas: 1,
        networkId: 'net-social',
        proof: pluginProof('runtime-secret-runtime-secret-32', 'social-strategy'),
        secretIds: new Map([[PLANNER_SECRET, 'secret-planner-1']]),
    });
}

it('allows the plugin manager’s routes and names what stays denied', () => {
    expect(SOCKET_PROXY_ALLOWLIST.map((row) => `${row.method} ${row.path}`)).toEqual([
        'GET /_ping',
        'GET /v1.44/version',
        'GET /v1.44/services',
        'GET /v1.44/services/{id}',
        'POST /v1.44/services/create',
        'POST /v1.44/services/{id}/update',
        'DELETE /v1.44/services/{id}',
        'GET /v1.44/tasks',
        'GET /v1.44/secrets',
        'POST /v1.44/secrets/create',
        'DELETE /v1.44/secrets/{id}',
        'GET /v1.44/networks',
        'GET /v1.44/networks/{id}',
        'POST /v1.44/networks/create',
        'DELETE /v1.44/networks/{id}',
        'POST /v1.44/images/create',
        'DELETE /v1.44/volumes/{name}',
    ]);
    expect(SOCKET_PROXY_DENIED.join('\n')).toMatch(/containers/);
    expect(SOCKET_PROXY_DENIED.join('\n')).toMatch(/exec/);
    expect(SOCKET_PROXY_DENIED.join('\n')).toMatch(/build/);
    expect(SOCKET_PROXY_DENIED.join('\n')).toMatch(/swarm/);
    expect(SOCKET_PROXY_DENIED.join('\n')).toMatch(/secrets/);
    expect(matchProxyRoute('POST', '/v1.44/services/create')?.route).toBe('service-create');
    expect(matchProxyRoute('POST', '/v1.44/containers/create')).toBeUndefined();
    expect(matchProxyRoute('POST', '/v1.41/services/create')).toBeUndefined();
    expect(matchProxyRoute('POST', '/v1.44/build')).toBeUndefined();
    expect(matchProxyRoute('POST', '/v1.44/swarm/init')).toBeUndefined();
    expect(matchProxyRoute('POST', '/v1.44/containers/abc/exec')).toBeUndefined();
    expect(matchProxyRoute('GET', '/v1.44/secrets')?.route).toBe('secrets-lookup');
    expect(matchProxyRoute('GET', '/v1.44/secrets/abc')).toBeUndefined();
    // Socio Secrets phase 2: create and delete exist, for identity secrets only (their tests below).
    expect(matchProxyRoute('POST', '/v1.44/secrets/create')?.route).toBe('secret-create');
    expect(matchProxyRoute('DELETE', '/v1.44/secrets/abc')).toEqual({ route: 'secret-delete', id: 'abc' });
    expect(matchProxyRoute('POST', '/v1.44/secrets/abc/update')).toBeUndefined();
    expect(matchProxyRoute('GET', '/v1.44/secrets/abc')).toBeUndefined();
    expect(matchProxyRoute('GET', '/v1.44/configs')).toBeUndefined();
    const allow = new Set([PLANNER_SECRET]);
    const filters = (name: string, key = 'names') =>
        new URLSearchParams({
            filters: JSON.stringify({ [key]: { [name]: true } }),
        });
    expect(secretLookupName(filters(PLANNER_SECRET), allow)).toBe(PLANNER_SECRET);
    expect(secretLookupName(filters(PLANNER_SECRET, 'name'), allow)).toBeUndefined();
    expect(secretLookupName(new URLSearchParams(), allow)).toBeUndefined();
    expect(secretLookupName(filters('other_secret'), allow)).toBeUndefined();
    expect(
        secretLookupName(
            new URLSearchParams({
                filters: JSON.stringify({
                    name: { [PLANNER_SECRET]: true },
                    id: { abc: true },
                }),
            }),
            allow,
        ),
    ).toBeUndefined();
    expect([...parseSecretNames(`${PLANNER_SECRET}, other-secret`)]).toEqual([PLANNER_SECRET, 'other-secret']);
    expect(() => parseSecretNames('has space')).toThrow(/SECRET_NAMES/);
    expect(normalizeDockerPath('/v1.44/services/create/../../containers/create')).toBeUndefined();
    expect(normalizeDockerPath('/v1.44/%2e%2e/containers/create')).toBeUndefined();
});

it('accepts the runtime’s service body and rejects a body that would be root on the host', () => {
    expect(pluginServiceErrors(service(), policy())).toEqual([]);
    const cases: Array<[string, (body: SwarmServiceBody) => void]> = [
        [
            'sha256',
            (body) => {
                body.TaskTemplate.ContainerSpec.Image = 'company-brain-plugin-social-strategy:latest';
            },
        ],
        [
            'pinned',
            (body) => {
                body.TaskTemplate.ContainerSpec.Image = `evil@sha256:${'ff'.repeat(32)}`;
            },
        ],
        [
            'Bind',
            (body) => {
                body.TaskTemplate.ContainerSpec.Mounts.push({
                    Type: 'bind' as 'volume',
                    Source: '/var/run/docker.sock',
                    Target: '/var/run/docker.sock',
                });
            },
        ],
        [
            'host path',
            (body) => {
                body.TaskTemplate.ContainerSpec.Mounts.push({
                    Type: 'volume',
                    Source: 'socio-plugin-social-strategy-data',
                    Target: '/data',
                    VolumeOptions: {
                        DriverConfig: {
                            Name: 'local',
                            Options: { type: 'none', device: '/', o: 'bind' },
                        },
                    },
                } as SwarmServiceBody['TaskTemplate']['ContainerSpec']['Mounts'][number]);
            },
        ],
        [
            'Privileged',
            (body) => {
                (body.TaskTemplate.ContainerSpec as { Privileged?: boolean }).Privileged = true;
            },
        ],
        [
            'CapAdd',
            (body) => {
                (body.TaskTemplate.ContainerSpec as { CapabilityAdd?: string[] }).CapabilityAdd = ['SYS_ADMIN'];
            },
        ],
        [
            'host network',
            (body) => {
                body.TaskTemplate.Networks = [{ Target: 'host' }];
            },
        ],
        [
            'Devices',
            (body) => {
                (body.TaskTemplate.ContainerSpec as { Devices?: string[] }).Devices = ['/dev/sda'];
            },
        ],
        [
            'PidMode',
            (body) => {
                (body.TaskTemplate.ContainerSpec as { PidMode?: string }).PidMode = 'host';
            },
        ],
        [
            'user',
            (body) => {
                (body.TaskTemplate.ContainerSpec as { User: string }).User = '0:0';
            },
        ],
        [
            'malformed secret reference',
            (body) => {
                body.TaskTemplate.ContainerSpec.Secrets![0]!.SecretID = '';
            },
        ],
        [
            'allowlisted',
            (body) => {
                body.TaskTemplate.ContainerSpec.Secrets![0]!.SecretName = 'other_secret';
            },
        ],
        // CB-321: a container label can't pass a plugin off as a stack's task.
        [
            'ContainerSpec.Labels',
            (body) => {
                (body.TaskTemplate.ContainerSpec as { Labels: Record<string, string> }).Labels = {
                    ...body.TaskTemplate.ContainerSpec.Labels,
                    'com.docker.stack.namespace': 'company-brain',
                };
            },
        ],
        [
            'ContainerSpec.Labels',
            (body) => {
                body.TaskTemplate.ContainerSpec.Labels['socio.plugin'] = 'another-plugin';
            },
        ],
    ];
    for (const [needle, change] of cases) {
        const body = service();
        change(body);
        const errors = pluginServiceErrors(body, policy());
        expect(errors.length, needle).toBeGreaterThan(0);
        expect(errors.join(' ').toLowerCase()).toContain(needle.toLowerCase());
    }
});

it('refuses an infra update that changes anything but a plugin network', () => {
    const current = {
        Spec: {
            Name: 'company-brain_apps',
            TaskTemplate: {
                ContainerSpec: { Image: 'company-brain-apps:latest' },
                Networks: [{ Target: 'apps-net' }],
            },
        },
    };
    const added = structuredClone(current);
    added.Spec.TaskTemplate.Networks.push({ Target: 'net-social' });
    expect(infraUpdateErrors(current, added.Spec, policy())).toEqual([]);
    const privileged = structuredClone(added);
    (privileged.Spec.TaskTemplate.ContainerSpec as { Privileged?: boolean }).Privileged = true;
    expect(infraUpdateErrors(current, privileged.Spec, policy()).join(' ')).toMatch(/only change plugin-network/);
    const host = structuredClone(current);
    host.Spec.TaskTemplate.Networks.push({ Target: 'host' });
    expect(infraUpdateErrors(current, host.Spec, policy()).join(' ')).toMatch(/internal socio-plugin-net/);
    const dropped = structuredClone(current);
    dropped.Spec.TaskTemplate.Networks = [];
    expect(infraUpdateErrors(current, dropped.Spec, policy()).join(' ')).toMatch(/must stay attached/);
    // A service attached only through the service-level list: a first task-level
    // network would replace it (Swarm prefers TaskTemplate.Networks), so it is refused.
    const serviceLevel = {
        Spec: {
            Name: 'company-brain_apps',
            Networks: [{ Target: 'apps-net' }],
            TaskTemplate: { ContainerSpec: { Image: 'company-brain-apps:latest' } },
        },
    };
    const taskLevel = structuredClone(serviceLevel.Spec) as Record<string, unknown> & {
        TaskTemplate: Record<string, unknown>;
    };
    taskLevel.TaskTemplate.Networks = [{ Target: 'net-social' }];
    expect(infraUpdateErrors(serviceLevel, taskLevel, policy()).join(' ')).toMatch(/must stay attached/);
    expect(
        infraUpdateErrors(
            serviceLevel,
            { ...serviceLevel.Spec, Networks: [{ Target: 'apps-net' }, { Target: 'net-social' }] },
            policy(),
        ).join(' '),
    ).toMatch(/only change TaskTemplate.Networks/);
    expect(
        networkCreateErrors({
            Name: 'socio-plugin-net-social-strategy',
            Driver: 'overlay',
            Internal: true,
            Attachable: false,
            Ingress: false,
            Labels: { 'socio.managed': 'plugin', 'socio.plugin': 'social-strategy' },
        }),
    ).toEqual([]);
    expect(
        networkCreateErrors({
            Name: 'host',
            Driver: 'host',
            Internal: false,
        }).join(' '),
    ).toMatch(/internal overlay/);
    expect(imagePullError(new URLSearchParams({ fromImage: IMAGE }), PINS, 0)).toBeUndefined();
    expect(
        imagePullError(
            new URLSearchParams({
                fromImage: 'company-brain-plugin-social-strategy',
                tag: 'latest',
            }),
            PINS,
            0,
        ),
    ).toMatch(/digest/);
});

it('does not forward a dangerous service create, and does forward a checked one', async () => {
    const seen: string[] = [];
    const engine = createServer((req, res) => {
        const url = req.url ?? '';
        seen.push(`${req.method} ${url}`);
        if (url.startsWith('/v1.44/networks/')) {
            res.end(
                JSON.stringify({
                    Id: 'net-social',
                    Name: 'socio-plugin-net-social-strategy',
                    Driver: 'overlay',
                    Internal: true,
                }),
            );
            return;
        }
        if (req.method === 'GET' && url.startsWith('/v1.44/secrets')) {
            res.end(JSON.stringify([{ ID: 'secret-planner-1', Spec: { Name: PLANNER_SECRET } }]));
            return;
        }
        if (req.method === 'GET' && (url === '/v1.44/services' || url === '/v1.44/tasks')) {
            res.end('[]');
            return;
        }
        if (req.method === 'POST' && url.startsWith('/v1.44/services/create')) {
            res.writeHead(201);
            res.end(JSON.stringify({ ID: 'svc1' }));
            return;
        }
        res.writeHead(500);
        res.end('unexpected');
    });
    const enginePort = await listen(engine);
    const proxy = startSocketProxy({
        listenHost: '127.0.0.1',
        listenPort: 0,
        upstream: `http://127.0.0.1:${enginePort}`,
        pins: PINS,
        infra: new Set(['company-brain_apps']),
        secretNames: new Set([PLANNER_SECRET]),
        log: () => {},
    });
    const server = await proxy.listen();
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const post = (path: string, body: unknown) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    try {
        const containers = await post('/v1.44/containers/create', {
            Image: 'alpine',
        });
        expect(containers.status).toBe(403);
        const dangerous = service();
        (dangerous.TaskTemplate.ContainerSpec as { Privileged?: boolean }).Privileged = true;
        const rejected = await post('/v1.44/services/create', dangerous);
        expect(rejected.status).toBe(403);
        expect(await rejected.json()).toMatchObject({
            message: expect.stringMatching(/Privileged|not allowed/i),
        });
        const accepted = await post('/v1.44/services/create', service());
        expect(accepted.status).toBe(201);
        const unfiltered = await fetch(`http://127.0.0.1:${port}/v1.44/secrets`);
        expect(unfiltered.status).toBe(403);
        const byId = await fetch(`http://127.0.0.1:${port}/v1.44/secrets/abc`);
        expect(byId.status).toBe(403);
        const otherName = await fetch(
            `http://127.0.0.1:${port}/v1.44/secrets?filters=${encodeURIComponent(JSON.stringify({ names: { other_secret: true } }))}`,
        );
        expect(otherName.status).toBe(403);
        const prefix = await fetch(
            `http://127.0.0.1:${port}/v1.44/secrets?filters=${encodeURIComponent(JSON.stringify({ name: { [PLANNER_SECRET]: true } }))}`,
        );
        expect(prefix.status).toBe(403);
        const listed = await fetch(
            `http://127.0.0.1:${port}/v1.44/secrets?filters=${encodeURIComponent(JSON.stringify({ names: { [PLANNER_SECRET]: true } }))}`,
        );
        expect(listed.status).toBe(200);
        expect(await listed.json()).toEqual([{ ID: 'secret-planner-1', Spec: { Name: PLANNER_SECRET } }]);
        expect(seen.filter((line) => line.startsWith('POST'))).toEqual(['POST /v1.44/services/create']);
        const secretGets = seen.filter((line) => line.startsWith('GET /v1.44/secrets'));
        expect(secretGets.length).toBeGreaterThan(0);
        expect(secretGets.every((line) => line.includes('%22names%22'))).toBe(true);
        expect(secretGets.some((line) => line.includes('%22name%22'))).toBe(false);
    } finally {
        server.close();
        engine.close();
    }
});

const WRAPPER = {
    name: 'pwned',
    TaskTemplate: {
        ContainerSpec: {
            Image: 'alpine:latest',
            User: '0:0',
            Mounts: [
                {
                    Type: 'bind',
                    Source: '/var/run/docker.sock',
                    Target: '/var/run/docker.sock',
                },
            ],
        },
        Networks: [{ Target: 'host' }],
    },
    Mode: { Global: {} },
    Spec: null as unknown,
};

const VOLUMEOPTIONS = {
    Type: 'volume',
    Source: 'socio-plugin-social-strategy-data',
    Target: '/host',
    volumeoptions: {
        DriverConfig: {
            Name: 'local',
            Options: { type: 'none', o: 'bind', device: '/var/run/docker.sock' },
        },
    },
};

it('rejects a wrapped spec and a case-folded volume option before the engine sees them', async () => {
    const honest = service();
    WRAPPER.Spec = honest;
    const wrapped = pluginServiceErrors(WRAPPER, policy());
    expect(wrapped.join(' ')).toMatch(/collides with Name|not allowed/);
    const folded = service();
    folded.TaskTemplate.ContainerSpec.Mounts.push(
        VOLUMEOPTIONS as (typeof folded.TaskTemplate.ContainerSpec.Mounts)[number],
    );
    const mountErrors = pluginServiceErrors(folded, policy());
    expect(mountErrors.join(' ')).toMatch(/volumeoptions|VolumeOptions/);
    const shell = service();
    shell.TaskTemplate.ContainerSpec.Healthcheck.Test = ['CMD', 'sh', '-c', 'cat /run/secrets/plugin_service_token'];
    expect(pluginServiceErrors(shell, policy()).join(' ')).toMatch(/healthcheck|shell/i);
    const nodeEval = service();
    nodeEval.TaskTemplate.ContainerSpec.Healthcheck.Test = ['CMD', 'node', '-e', 'process.exit(0)'];
    expect(pluginServiceErrors(nodeEval, policy()).length).toBeGreaterThan(0);
    const unbound = service();
    unbound.TaskTemplate.ContainerSpec.Secrets![0]!.SecretID = 'session-secret-id';
    expect(
        pluginServiceErrors(unbound, {
            ...policy(),
            secretIds: new Map([[PLANNER_SECRET, 'secret-planner-1']]),
        }).join(' '),
    ).toMatch(/SecretID does not match/);
    const nodeOptions = service();
    nodeOptions.TaskTemplate.ContainerSpec.Env.push('NODE_OPTIONS=--require /tmp/pwn.js');
    expect(pluginServiceErrors(nodeOptions, policy()).join(' ')).toMatch(/NODE_OPTIONS/);
    const home = service();
    const homeEnv = home.TaskTemplate.ContainerSpec.Env;
    homeEnv[homeEnv.indexOf('HOME=/tmp')] = 'HOME=/root';
    expect(pluginServiceErrors(home, policy()).join(' ')).toMatch(/HOME/);
    expect(
        imagePullError(
            new URLSearchParams({
                fromImage: IMAGE,
                changes: 'USER root',
            }),
            PINS,
            0,
        ),
    ).toMatch(/digest/);

    const decoded = goDecodeServiceSpec(WRAPPER);
    expect(decoded.Name).toBe('pwned');
    expect(decoded.TaskTemplate.ContainerSpec.User).toBe('0:0');
    expect(decoded.TaskTemplate.ContainerSpec.Mounts[0]).toMatchObject({
        Type: 'bind',
        Source: '/var/run/docker.sock',
        Target: '/var/run/docker.sock',
    });
    expect(decoded.Mode).toEqual({ Global: {} });
    expect('Spec' in decoded).toBe(false);
    const engine = new MemoryDocker();
    await engine.createService(WRAPPER as unknown as SwarmServiceBody);
    expect(engine.specNamed('pwned')?.TaskTemplate.ContainerSpec.User).toBe('0:0');
    const withMount = service();
    withMount.TaskTemplate.ContainerSpec.Mounts.push(
        VOLUMEOPTIONS as (typeof withMount.TaskTemplate.ContainerSpec.Mounts)[number],
    );
    await engine.createService(withMount);
    const stored = engine.specNamed(pluginServiceName('social-strategy'));
    const volume = stored?.TaskTemplate.ContainerSpec.Mounts.find((mount) => mount.Type === 'volume');
    expect(volume && 'VolumeOptions' in volume && volume.VolumeOptions).toMatchObject({
        DriverConfig: {
            Options: { device: '/var/run/docker.sock' },
        },
    });
    expect(JSON.stringify(stored)).not.toContain('volumeoptions');

    let forwarded = '';
    const updates: string[] = [];
    const fake = createServer(async (req, res) => {
        const url = req.url ?? '';
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(Buffer.from(chunk));
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        res.setHeader('content-type', 'application/json');
        if (url.startsWith('/v1.44/networks/')) {
            res.end(
                JSON.stringify({
                    Id: 'net-social',
                    Name: 'socio-plugin-net-social-strategy',
                    Driver: 'overlay',
                    Internal: true,
                }),
            );
            return;
        }
        if (url.startsWith('/v1.44/secrets')) {
            res.end(
                JSON.stringify([
                    { ID: 'secret-planner-1', Spec: { Name: PLANNER_SECRET } },
                    { ID: 'secret-other', Spec: { Name: `${PLANNER_SECRET}_backup` } },
                ]),
            );
            return;
        }
        if (req.method === 'GET' && url.startsWith('/v1.44/services/')) {
            res.end(
                JSON.stringify({
                    ID: 'svc1',
                    Version: { Index: 4 },
                    Spec: {
                        ...honest,
                        TaskTemplate: {
                            ...honest.TaskTemplate,
                            ContainerSpec: {
                                ...honest.TaskTemplate.ContainerSpec,
                                Env: ['SESSION_SECRET=nope'],
                                Secrets: [{ SecretID: 'other', SecretName: 'other' }],
                            },
                        },
                    },
                }),
            );
            return;
        }
        if (req.method === 'GET' && url === '/v1.44/tasks') {
            res.end('[]');
            return;
        }
        if (req.method === 'GET' && url.startsWith('/v1.44/services')) {
            res.end(
                JSON.stringify([
                    {
                        ID: 'svc1',
                        Version: { Index: 4 },
                        Spec: honest,
                    },
                    {
                        ID: 'other',
                        Spec: {
                            Name: 'company-brain_app',
                            TaskTemplate: {
                                ContainerSpec: {
                                    Env: ['SESSION_SECRET=nope'],
                                    Secrets: [{ SecretID: 'session-secret-id' }],
                                },
                            },
                        },
                    },
                ]),
            );
            return;
        }
        if (req.method === 'POST' && url.startsWith('/v1.44/services/create')) {
            forwarded = raw;
            res.writeHead(201);
            res.end('{}');
            return;
        }
        if (req.method === 'POST' && url.includes('/update')) {
            updates.push(url);
            res.end('{}');
            return;
        }
        res.writeHead(500);
        res.end('unexpected');
    });
    const enginePort = await listen(fake);
    const proxy = startSocketProxy({
        listenHost: '127.0.0.1',
        listenPort: 0,
        upstream: `http://127.0.0.1:${enginePort}`,
        pins: PINS,
        infra: new Set(),
        secretNames: new Set([PLANNER_SECRET]),
        log: () => {},
    });
    const server = await proxy.listen();
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const post = (path: string, body: unknown) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    try {
        expect((await post('/v1.44/services/create', WRAPPER)).status).toBe(403);
        expect((await post('/v1.44/services/create', folded)).status).toBe(403);
        expect((await post('/v1.44/services/create', unbound)).status).toBe(403);
        expect((await post('/v1.44/services/create', shell)).status).toBe(403);
        const created = await post('/v1.44/services/create', service());
        expect(created.status).toBe(201);
        expect(forwarded).not.toContain('volumeoptions');
        expect(forwarded).not.toContain('"Spec"');
        expect(JSON.parse(forwarded)).toEqual(JSON.parse(JSON.stringify(service())));
        expect(await goJson('check', forwarded)).toEqual(JSON.parse(forwarded));
        expect((await goJson('fold', JSON.stringify(WRAPPER))).Name).toBe('pwned');
        const rollback = await post(`/v1.44/services/svc1/update?version=4&rollback=previous`, {
            Mode: { Replicated: { Replicas: 1 } },
        });
        expect(rollback.status).toBe(403);
        expect(updates).toEqual([]);
        const registry = await post('/v1.44/services/create?registryAuthFrom=company-brain_app', service());
        expect(registry.status).toBe(403);
        const listed = await fetch(`http://127.0.0.1:${port}/v1.44/services`);
        const services = (await listed.json()) as Array<{
            Spec?: {
                TaskTemplate?: { ContainerSpec?: { Env?: unknown; Secrets?: unknown } };
            };
        }>;
        expect(JSON.stringify(services)).not.toContain('SESSION_SECRET');
        expect(services[1]?.Spec?.TaskTemplate?.ContainerSpec?.Env).toBeUndefined();
        expect(services[1]?.Spec?.TaskTemplate?.ContainerSpec?.Secrets).toBeUndefined();
        const inspected = await fetch(`http://127.0.0.1:${port}/v1.44/services/svc1`);
        const one = (await inspected.json()) as {
            Spec?: {
                TaskTemplate?: { ContainerSpec?: { Env?: unknown; Secrets?: unknown } };
            };
        };
        expect(one.Spec?.TaskTemplate?.ContainerSpec?.Env).toBeUndefined();
        expect(one.Spec?.TaskTemplate?.ContainerSpec?.Secrets).toBeUndefined();
    } finally {
        server.close();
        fake.close();
    }
}, 60_000);

/**
 * Decodes `body` with Go's encoding/json, as the Docker engine would. Async on
 * purpose: this test's proxy and fake engine share the process, and a
 * synchronous `go run` (a cold compile can take several seconds) would freeze
 * them past Node's keep-alive timeout, so the next request could reuse a
 * connection the server is closing (ECONNRESET).
 */
function goJson(mode: 'check' | 'fold', body: string) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
        const child = execFile(
            'go',
            ['run', 'tests/docker-json/decode.go', mode],
            {
                encoding: 'utf8',
                cwd: new URL('..', import.meta.url),
                env: {
                    ...process.env,
                    GO111MODULE: 'off',
                    GOPROXY: 'off',
                    GOSUMDB: 'off',
                    GOTOOLCHAIN: 'local',
                    CGO_ENABLED: '0',
                    GOCACHE: '/tmp/go-cache',
                    HOME: process.env.HOME || '/tmp',
                },
            },
            (error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout) as Record<string, unknown>)),
        );
        child.stdin?.end(body);
    });
}

function listen(server: Server) {
    return new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve(typeof address === 'object' && address ? address.port : 0);
        });
    });
}

it('refuses an infra update that changes an existing attachment or adds one with aliases (PR #1 review)', () => {
    const current = {
        Spec: {
            Name: 'company-brain_apps',
            TaskTemplate: {
                ContainerSpec: { Image: 'company-brain-apps:latest' },
                Networks: [{ Target: 'apps-net', Aliases: ['apps'] }],
            },
        },
    };
    const added = structuredClone(current);
    (added.Spec.TaskTemplate.Networks as unknown[]).push({
        Target: 'net-social',
    });
    expect(infraUpdateErrors(current, added.Spec, policy())).toEqual([]);
    // An alias on the stack network would take another service's DNS name.
    const hijack = structuredClone(added);
    hijack.Spec.TaskTemplate.Networks[0]!.Aliases.push('app');
    expect(infraUpdateErrors(current, hijack.Spec, policy()).join(' ')).toMatch(/existing network attachment/);
    const opts = structuredClone(added);
    (opts.Spec.TaskTemplate.Networks[0] as Record<string, unknown>).DriverOpts = {
        'com.docker.network.driver.mtu': '1',
    };
    expect(infraUpdateErrors(current, opts.Spec, policy()).join(' ')).toMatch(/existing network attachment/);
    // The stack's short name may follow the service onto the plugin network,
    // so the plugin resolves it; a new name may not.
    const ownAlias = structuredClone(current);
    (ownAlias.Spec.TaskTemplate.Networks as unknown[]).push({
        Target: 'net-social',
        Aliases: ['apps'],
    });
    expect(infraUpdateErrors(current, ownAlias.Spec, policy())).toEqual([]);
    const aliased = structuredClone(current);
    (aliased.Spec.TaskTemplate.Networks as unknown[]).push({
        Target: 'net-social',
        Aliases: ['docker-socket-proxy'],
    });
    expect(infraUpdateErrors(current, aliased.Spec, policy()).join(' ')).toMatch(/only repeat aliases/);
    const driverOpts = structuredClone(current);
    (driverOpts.Spec.TaskTemplate.Networks as unknown[]).push({
        Target: 'net-social',
        DriverOpts: { x: 'y' },
    });
    expect(infraUpdateErrors(current, driverOpts.Spec, policy()).join(' ')).toMatch(/\{ Target, Aliases \} only/);
    const twice = structuredClone(added);
    (twice.Spec.TaskTemplate.Networks as unknown[]).push({
        Target: 'net-social',
    });
    expect(infraUpdateErrors(current, twice.Spec, policy()).join(' ')).toMatch(/attached twice/);
});

it('requires a process limit on a plugin service (PR #1 review)', () => {
    expect(pluginServiceErrors(service(), policy())).toEqual([]);
    expect(service().TaskTemplate.Resources.Limits.Pids).toBe(PLUGIN_PIDS);
    const none = service() as unknown as {
        TaskTemplate: { Resources: { Limits: Record<string, unknown> } };
    };
    delete none.TaskTemplate.Resources.Limits.Pids;
    expect(pluginServiceErrors(none, policy()).join(' ')).toMatch(/Pids/);
    for (const pids of [0, -1, PLUGIN_PIDS_CAP + 1, 1.5, '256']) {
        const body = service() as unknown as {
            TaskTemplate: { Resources: { Limits: Record<string, unknown> } };
        };
        body.TaskTemplate.Resources.Limits.Pids = pids;
        expect(pluginServiceErrors(body, policy()).join(' ')).toMatch(/Pids/);
    }
});

it('redacts environment and secrets from tasks and from PreviousSpec (PR #1 review)', async () => {
    const container = () => ({
        Image: 'company-brain:latest',
        Env: ['OPENAI_API_KEY=sk-live-secret', 'SESSION_SECRET=s3cret'],
        Secrets: [{ SecretID: 'x', SecretName: 'company_brain_session' }],
        Configs: [{ ConfigID: 'c', ConfigName: 'cfg' }],
    });
    const fake = createServer((req, res) => {
        const url = req.url ?? '';
        res.setHeader('content-type', 'application/json');
        if (url.startsWith('/v1.44/tasks')) {
            res.end(
                JSON.stringify([
                    {
                        ID: 't1',
                        ServiceID: 'svc-app',
                        Spec: { ContainerSpec: container() },
                        Status: { State: 'running' },
                        NetworksAttachments: [{ Addresses: ['10.0.1.5/24'] }],
                    },
                ]),
            );
            return;
        }
        if (url.startsWith('/v1.44/services')) {
            const row = {
                ID: 'svc-app',
                Version: { Index: 3 },
                Spec: {
                    Name: 'company-brain_app',
                    TaskTemplate: { ContainerSpec: container() },
                },
                PreviousSpec: {
                    Name: 'company-brain_app',
                    TaskTemplate: { ContainerSpec: container() },
                },
            };
            res.end(JSON.stringify(url === '/v1.44/services' ? [row] : row));
            return;
        }
        res.writeHead(500);
        res.end('{}');
    });
    const enginePort = await listen(fake);
    const proxy = startSocketProxy({
        listenHost: '127.0.0.1',
        listenPort: 0,
        upstream: `http://127.0.0.1:${enginePort}`,
        pins: PINS,
        infra: new Set(),
        secretNames: new Set([PLANNER_SECRET]),
        log: () => {},
    });
    const server = await proxy.listen();
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
        for (const path of [
            '/v1.44/tasks',
            `/v1.44/tasks?filters=${encodeURIComponent(JSON.stringify({ service: { 'company-brain_app': true } }))}`,
            '/v1.44/services',
            '/v1.44/services/svc-app',
        ]) {
            const response = await fetch(`http://127.0.0.1:${port}${path}`);
            expect(response.status).toBe(200);
            const text = await response.text();
            expect(text).not.toContain('sk-live-secret');
            expect(text).not.toContain('SESSION_SECRET');
            expect(text).not.toContain('company_brain_session');
            expect(text).not.toContain('ConfigID');
        }
        // What the runtime reads from a task is still there.
        const tasks = (await (await fetch(`http://127.0.0.1:${port}/v1.44/tasks`)).json()) as Array<{
            Status: { State: string };
            NetworksAttachments: Array<{ Addresses: string[] }>;
        }>;
        expect(tasks[0]?.Status.State).toBe('running');
        expect(tasks[0]?.NetworksAttachments[0]?.Addresses).toEqual(['10.0.1.5/24']);
        // In place of the values, a digest of what runs (CB-370): a task's
        // matches its service's current spec when they run the same thing.
        const service = (await (await fetch(`http://127.0.0.1:${port}/v1.44/services/svc-app`)).json()) as {
            Spec: { TaskTemplate: { ContainerSpec: Record<string, unknown> } };
        };
        const taskRevision = (tasks[0] as unknown as { Spec: { ContainerSpec: Record<string, unknown> } }).Spec
            .ContainerSpec.SocioRevision;
        expect(taskRevision).toMatch(/^[0-9a-f]{64}$/);
        expect(service.Spec.TaskTemplate.ContainerSpec.SocioRevision).toBe(taskRevision);
        expect(taskRevision).toBe(containerRevision(container()));
        expect(
            containerRevision({ ...container(), Env: ['OPENAI_API_KEY=sk-live-secret', 'SESSION_SECRET=other'] }),
        ).not.toBe(taskRevision);
    } finally {
        server.close();
        fake.close();
    }
});

it('attaches an infra service to a plugin network with the names it has on the stack (PR #1 review)', async () => {
    let spec: Record<string, unknown> = {
        Name: 'company-brain_app',
        TaskTemplate: {
            ContainerSpec: { Image: 'company-brain:latest' },
            Networks: [{ Target: 'apps-net', Aliases: ['app'] }],
        },
    };
    let version = 7;
    const engine = createServer(async (req, res) => {
        res.setHeader('content-type', 'application/json');
        const url = req.url ?? '';
        if (url.startsWith('/v1.44/networks/')) {
            const plugin = url.includes('net-social');
            res.end(
                JSON.stringify(
                    plugin
                        ? {
                              Id: 'net-social',
                              Name: 'socio-plugin-net-social-strategy',
                              Driver: 'overlay',
                              Internal: true,
                          }
                        : { Id: 'apps-net', Name: 'apps', Driver: 'overlay' },
                ),
            );
            return;
        }
        const row = { ID: 'svc-app', Version: { Index: version }, Spec: spec };
        if (req.method === 'GET') {
            res.end(JSON.stringify(url.startsWith('/v1.44/services?') ? [row] : row));
            return;
        }
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(Buffer.from(chunk));
        }
        spec = JSON.parse(Buffer.concat(chunks).toString()) as typeof spec;
        version++;
        res.end('{}');
    });
    const enginePort = await listen(engine);
    const proxy = startSocketProxy({
        listenHost: '127.0.0.1',
        listenPort: 0,
        upstream: `http://127.0.0.1:${enginePort}`,
        pins: PINS,
        infra: new Set(['company-brain_app']),
        secretNames: new Set([PLANNER_SECRET]),
        log: () => {},
    });
    const server = await proxy.listen();
    const address = server.address();
    const endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    try {
        const client = new HttpDockerEngine(endpoint, false);
        await client.attachServiceNetwork('company-brain_app', 'net-social');
        expect((spec.TaskTemplate as { Networks: unknown[] }).Networks).toEqual([
            { Target: 'apps-net', Aliases: ['app'] },
            { Target: 'net-social', Aliases: ['app'] },
        ]);
        await client.detachServiceNetwork('company-brain_app', 'net-social');
        expect((spec.TaskTemplate as { Networks: unknown[] }).Networks).toEqual([
            { Target: 'apps-net', Aliases: ['app'] },
        ]);
    } finally {
        server.close();
        engine.close();
    }
});

it('attaches an infra service whose engine spec has env, secrets and configs, and keeps them (deployment B v0.38.0)', async () => {
    const container = {
        Image: 'company-brain-apps:latest',
        Env: ['OPENAI_API_KEY=sk-live', 'SOCIO_API_URL=http://app:3000'],
        Secrets: [{ SecretID: 'sec1', SecretName: 'socio_db', File: { Name: 'db', UID: '0', GID: '0', Mode: 292 } }],
        Configs: [{ ConfigID: 'cfg1', ConfigName: 'socio_cfg', File: { Name: 'cfg', UID: '0', GID: '0', Mode: 292 } }],
    };
    let spec: Record<string, unknown> = {
        Name: 'company-brain_apps',
        Labels: { 'com.docker.stack.namespace': 'company-brain' },
        TaskTemplate: {
            ContainerSpec: structuredClone(container),
            Networks: [{ Target: 'apps-net', Aliases: ['apps'] }],
        },
    };
    let version = 11;
    const posted: { path: string; body: Record<string, unknown>; registryAuth?: string }[] = [];
    const engine = createServer(async (req, res) => {
        res.setHeader('content-type', 'application/json');
        const url = req.url ?? '';
        if (url.startsWith('/v1.44/networks/')) {
            const plugin = url.includes('net-social');
            res.end(
                JSON.stringify(
                    plugin
                        ? {
                              Id: 'net-social',
                              Name: 'socio-plugin-net-social-strategy',
                              Driver: 'overlay',
                              Internal: true,
                          }
                        : { Id: 'apps-net', Name: 'apps', Driver: 'overlay' },
                ),
            );
            return;
        }
        const row = { ID: 'svc-apps', Version: { Index: version }, Spec: spec, PreviousSpec: spec };
        if (req.method === 'GET') {
            res.end(JSON.stringify(url.startsWith('/v1.44/services?') ? [row] : row));
            return;
        }
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        const auth = req.headers['x-registry-auth'];
        posted.push({ path: url, body, ...(typeof auth === 'string' ? { registryAuth: auth } : {}) });
        spec = body;
        version++;
        res.end('{}');
    });
    const enginePort = await listen(engine);
    const denials: string[] = [];
    const proxy = startSocketProxy({
        listenHost: '127.0.0.1',
        listenPort: 0,
        upstream: `http://127.0.0.1:${enginePort}`,
        pins: PINS,
        infra: new Set(['company-brain_apps']),
        secretNames: new Set([PLANNER_SECRET]),
        log: (line) => denials.push(line),
    });
    const server = await proxy.listen();
    const address = server.address();
    const endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const containerOf = (value: Record<string, unknown>) =>
        (value.TaskTemplate as { ContainerSpec: Record<string, unknown> }).ContainerSpec;
    const networksOf = (value: Record<string, unknown>) => (value.TaskTemplate as { Networks: unknown[] }).Networks;
    try {
        const client = new HttpDockerEngine(endpoint, false);
        await client.attachServiceNetwork('company-brain_apps', 'net-social');
        expect(denials).toEqual([]);
        expect(posted).toHaveLength(1);
        expect(posted[0]!.path).toBe('/v1.44/services/svc-apps/update?version=11');
        expect(containerOf(spec)).toEqual(container);
        expect(networksOf(spec)).toEqual([
            { Target: 'apps-net', Aliases: ['apps'] },
            { Target: 'net-social', Aliases: ['apps'] },
        ]);
        await client.detachServiceNetwork('company-brain_apps', 'net-social');
        expect(containerOf(spec)).toEqual(container);
        expect(networksOf(spec)).toEqual([{ Target: 'apps-net', Aliases: ['apps'] }]);
        // A refusal reaches the runtime as a refusal (403), not as an outage.
        await expect(client.attachServiceNetwork('company-brain_apps', 'other-net')).rejects.toMatchObject({
            status: 403,
            message: expect.stringMatching(/internal socio-plugin-net/),
        });

        // What the runtime reads through the proxy carries no env, secrets or configs.
        const listed = (await (
            await fetch(
                `${endpoint}/v1.44/services?filters=${encodeURIComponent('{"name":{"company-brain_apps":true}}')}`,
            )
        ).json()) as { Spec: Record<string, unknown> }[];
        const redacted = listed[0]!.Spec;
        expect(containerOf(redacted).Env).toBeUndefined();
        const attach = (
            extra: (body: Record<string, unknown>) => void,
            at: number | string = version,
            headers: Record<string, string> = {},
        ) => {
            const body = structuredClone(redacted);
            networksOf(body).push({ Target: 'net-social' });
            extra(body);
            return fetch(`${endpoint}/v1.44/services/svc-apps/update?version=${at}`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });
        };
        const before = posted.length;
        // A body that carries env, secrets or configs (even the real ones) is refused.
        for (const field of ['Env', 'Secrets', 'Configs'] as const) {
            const response = await attach((body) => {
                containerOf(body)[field] = container[field];
            });
            expect(response.status).toBe(403);
            expect(((await response.json()) as { message: string }).message).toMatch(/environment, secrets or configs/);
        }
        // Any other field change is refused.
        expect(
            (
                await attach((body) => {
                    containerOf(body).Image = 'evil:latest';
                })
            ).status,
        ).toBe(403);
        // A PreviousSpec in the body is refused.
        expect(
            (
                await attach((body) => {
                    body.PreviousSpec = { Name: 'company-brain_apps' };
                })
            ).status,
        ).toBe(403);
        // A version that is not the current one is refused before the engine sees it,
        // as is one that is missing, empty or not written as the engine writes it.
        expect((await attach(() => {}, version - 1)).status).toBe(409);
        expect((await attach(() => {}, '')).status).toBe(409);
        expect((await attach(() => {}, `0${version}`)).status).toBe(409);
        expect((await attach(() => {}, `${version}&version=${version}`)).status).toBe(403);
        expect(
            (
                await fetch(`${endpoint}/v1.44/services/svc-apps/update`, {
                    method: 'POST',
                    body: JSON.stringify(redacted),
                })
            ).status,
        ).toBe(409);
        // Moving an existing attachment to the service-level list, where Swarm ignores
        // it once TaskTemplate.Networks is not empty, is refused (it would detach it).
        const moved = await attach((body) => {
            body.Networks = [{ Target: 'apps-net', Aliases: ['apps'] }];
            (body.TaskTemplate as { Networks: unknown[] }).Networks = [{ Target: 'net-social' }];
        });
        expect(moved.status).toBe(403);
        expect(((await moved.json()) as { message: string }).message).toMatch(/only change TaskTemplate.Networks/);
        // So is any other change to the service-level list.
        expect(
            (
                await attach((body) => {
                    body.Networks = [{ Target: 'net-social' }];
                })
            ).status,
        ).toBe(403);
        expect(posted.length).toBe(before);
        expect(containerOf(spec)).toEqual(container);

        // Registry credentials are not forwarded with an infra update: the engine
        // would store them as the service's pull credentials.
        const withAuth = await attach(() => {}, version, { 'x-registry-auth': 'eyJ1c2VybmFtZSI6ImV2aWwifQ' });
        expect(withAuth.status).toBe(200);
        expect(posted).toHaveLength(before + 1);
        expect(posted.at(-1)!.registryAuth).toBeUndefined();
        expect(containerOf(spec)).toEqual(container);
    } finally {
        server.close();
        engine.close();
    }
});

// CB-327: Swarm names are global per swarm, so a second deployment on the same
// swarm gives its plugin objects its own prefix, and the proxy enforces it.
describe('PLUGIN_NAME_PREFIX', () => {
    const network = (name: string, plugin = 'social-strategy') => ({
        Name: name,
        Driver: 'overlay',
        Internal: true,
        Attachable: false,
        Ingress: false,
        Labels: { 'socio.managed': 'plugin', 'socio.plugin': plugin },
    });
    afterEach(() => setPluginNamePrefix(undefined));

    it('defaults to socio-plugin, and refuses a malformed prefix', () => {
        expect(setPluginNamePrefix(undefined)).toBe('socio-plugin');
        expect(setPluginNamePrefix('  ')).toBe('socio-plugin');
        for (const bad of ['Hello', '1abc', 'a--b', 'ends-', 'has space', 'x'.repeat(41)]) {
            expect(() => setPluginNamePrefix(bad)).toThrow(/PLUGIN_NAME_PREFIX/);
        }
    });

    it('names and checks every plugin object with the configured prefix only', () => {
        setPluginNamePrefix('example-plugin');
        expect(pluginServiceName('planner')).toBe('example-plugin-planner');
        expect(pluginNetworkName('planner')).toBe('example-plugin-net-planner');
        expect(networkCreateErrors(network('example-plugin-net-social-strategy'))).toEqual([]);
        // Another deployment's (the default) names are refused.
        expect(networkCreateErrors(network('socio-plugin-net-social-strategy')).join(' ')).toMatch(
            /example-plugin-net-<id>/,
        );
    });
});

describe('plugin volumes are matched exactly, not by prefix (foo vs foo-bar)', () => {
    const FOO_IMAGE = `company-brain-plugin-foo@sha256:${DIGEST}`;
    const FOO_BAR_IMAGE = `company-brain-plugin-foo-bar@sha256:${'cd'.repeat(32)}`;

    function fooPolicy(claims?: ProxyPolicy['volumeClaims']): ProxyPolicy {
        return {
            pins: new Map([
                ['foo', FOO_IMAGE],
                ['foo-bar', FOO_BAR_IMAGE],
            ]),
            infra: new Set(),
            network: (target) =>
                target.startsWith('net-')
                    ? { name: pluginNetworkName(target.slice(4)), driver: 'overlay', internal: true }
                    : undefined,
            secretNames: new Set(),
            ...(claims ? { volumeClaims: claims } : {}),
        };
    }

    function pluginBody(id: string, volumes: string[]) {
        return swarmServiceBody({
            id,
            image: id === 'foo' ? FOO_IMAGE : FOO_BAR_IMAGE,
            spec: {
                image: id === 'foo' ? FOO_IMAGE : FOO_BAR_IMAGE,
                port: 8080,
                volumes: volumes.map((name, index) => ({ name, mount: `/data/${index}` })),
            },
            replicas: 1,
            networkId: `net-${id}`,
            proof: pluginProof('runtime-secret-runtime-secret-32', id),
        });
    }

    function withSource(body: SwarmServiceBody, source: string) {
        const mount = body.TaskTemplate.ContainerSpec.Mounts.find((row) => row.Type === 'volume');
        (mount as { Source: string }).Source = source;
        return body;
    }

    const fooBarClaim = {
        service: 'socio-plugin-foo-bar',
        plugin: 'foo-bar',
        volumes: ['socio-plugin-foo-bar-data'],
    };

    it('lets a plugin mount its own declared volumes, also while another plugin is installed', () => {
        expect(pluginServiceErrors(pluginBody('foo', ['data', 'cache']), fooPolicy())).toEqual([]);
        expect(pluginServiceErrors(pluginBody('foo', ['data']), fooPolicy([fooBarClaim]))).toEqual([]);
        expect(pluginServiceErrors(pluginBody('foo-bar', ['data']), fooPolicy([fooBarClaim]))).toEqual([]);
        // Its own service's mounts are not a claim against it.
        const own = { service: 'socio-plugin-foo', plugin: 'foo', volumes: ['socio-plugin-foo-data'] };
        expect(pluginServiceErrors(pluginBody('foo', ['data']), fooPolicy([own, fooBarClaim]))).toEqual([]);
    });

    it('does not let a shorter installed id reserve a longer plugin’s namespace (two plugins, distinct volumes)', () => {
        const fooInstalled = { service: 'socio-plugin-foo', plugin: 'foo', volumes: ['socio-plugin-foo-data'] };
        // foo-bar creating, or updating, its own data while foo is installed.
        expect(pluginServiceErrors(pluginBody('foo-bar', ['data']), fooPolicy([fooInstalled]))).toEqual([]);
        expect(
            pluginServiceErrors(pluginBody('foo-bar', ['data', 'logs']), fooPolicy([fooInstalled, fooBarClaim])),
        ).toEqual([]);
        // And foo keeps its own data while foo-bar is installed.
        expect(pluginServiceErrors(pluginBody('foo', ['data']), fooPolicy([fooInstalled, fooBarClaim]))).toEqual([]);
        // An unrelated id that only shares letters claims nothing either.
        const foobar = { service: 'socio-plugin-foobar', plugin: 'foobar', volumes: ['socio-plugin-foobar-data'] };
        expect(pluginServiceErrors(pluginBody('foo', ['data']), fooPolicy([foobar]))).toEqual([]);
    });

    it('serializes concurrent creates so foo and foo-bar cannot both mount the same volume', async () => {
        const services: { ID: string; Spec: unknown }[] = [];
        const engine = createServer(async (req, res) => {
            const url = req.url ?? '';
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
                chunks.push(Buffer.from(chunk));
            }
            res.setHeader('content-type', 'application/json');
            if (url.startsWith('/v1.44/networks/')) {
                const id = decodeURIComponent(url.slice('/v1.44/networks/'.length)).replace(/^net-/, '');
                res.end(
                    JSON.stringify({ Id: `net-${id}`, Name: pluginNetworkName(id), Driver: 'overlay', Internal: true }),
                );
                return;
            }
            if (req.method === 'GET' && url === '/v1.44/tasks') {
                res.end('[]');
                return;
            }
            if (req.method === 'GET' && url.startsWith('/v1.44/services')) {
                // Slow list: without the lock both creates read it before either lands.
                await new Promise((resolve) => setTimeout(resolve, 50));
                res.end(JSON.stringify(services));
                return;
            }
            if (url === '/v1.44/services/create') {
                const spec = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                await new Promise((resolve) => setTimeout(resolve, 100));
                services.push({ ID: `svc-${services.length}`, Spec: spec });
                res.end('{"ID":"svc"}');
                return;
            }
            res.statusCode = 404;
            res.end('{}');
        });
        const enginePort = await listen(engine);
        const proxy = startSocketProxy({
            listenHost: '127.0.0.1',
            listenPort: 0,
            upstream: `http://127.0.0.1:${enginePort}`,
            pins: fooPolicy().pins,
            infra: new Set(),
            secretNames: new Set(),
            log: () => {},
        });
        const server = await proxy.listen();
        const address = server.address();
        const endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
        try {
            const create = (body: unknown) =>
                fetch(`${endpoint}/v1.44/services/create`, { method: 'POST', body: JSON.stringify(body) });
            const statuses = await Promise.all([
                create(pluginBody('foo', ['bar-data'])).then((r) => r.status),
                create(pluginBody('foo-bar', ['data'])).then((r) => r.status),
            ]);
            expect([...statuses].sort()).toEqual([200, 403]);
            const mounted = services.flatMap((row) =>
                (row.Spec as SwarmServiceBody).TaskTemplate.ContainerSpec.Mounts.flatMap((mount) =>
                    mount.Type === 'volume' ? [mount.Source] : [],
                ),
            );
            expect(mounted.filter((source) => source === 'socio-plugin-foo-bar-data')).toHaveLength(1);
        } finally {
            server.close();
            engine.close();
        }
    });

    it('holds the volume lock until the engine answers, even after the client disconnects', async () => {
        const services: { ID: string; Spec: unknown }[] = [];
        let createReceived!: () => void;
        const received = new Promise<void>((resolve) => (createReceived = resolve));
        let releaseCreate!: () => void;
        const released = new Promise<void>((resolve) => (releaseCreate = resolve));
        const engine = createServer(async (req, res) => {
            const url = req.url ?? '';
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
                chunks.push(Buffer.from(chunk));
            }
            res.setHeader('content-type', 'application/json');
            if (url.startsWith('/v1.44/networks/')) {
                const id = decodeURIComponent(url.slice('/v1.44/networks/'.length)).replace(/^net-/, '');
                res.end(
                    JSON.stringify({ Id: `net-${id}`, Name: pluginNetworkName(id), Driver: 'overlay', Internal: true }),
                );
                return;
            }
            if (req.method === 'GET' && url === '/v1.44/tasks') {
                res.end('[]');
                return;
            }
            if (req.method === 'GET' && url.startsWith('/v1.44/services')) {
                res.end(JSON.stringify(services));
                return;
            }
            if (url === '/v1.44/services/create') {
                const spec = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { Name: string };
                if (spec.Name === 'socio-plugin-foo') {
                    // The engine is still applying foo's create when its client goes away.
                    createReceived();
                    await released;
                }
                services.push({ ID: `svc-${services.length}`, Spec: spec });
                res.end('{"ID":"svc"}');
                return;
            }
            res.statusCode = 404;
            res.end('{}');
        });
        const enginePort = await listen(engine);
        const proxy = startSocketProxy({
            listenHost: '127.0.0.1',
            listenPort: 0,
            upstream: `http://127.0.0.1:${enginePort}`,
            pins: fooPolicy().pins,
            infra: new Set(),
            secretNames: new Set(),
            log: () => {},
        });
        const server = await proxy.listen();
        const address = server.address();
        const endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
        try {
            const abort = new AbortController();
            const first = fetch(`${endpoint}/v1.44/services/create`, {
                method: 'POST',
                body: JSON.stringify(pluginBody('foo', ['bar-data'])),
                signal: abort.signal,
            }).catch(() => undefined);
            await received;
            abort.abort();
            await first;
            const second = fetch(`${endpoint}/v1.44/services/create`, {
                method: 'POST',
                body: JSON.stringify(pluginBody('foo-bar', ['data'])),
            }).then((r) => r.status);
            // Without the lock held, foo-bar reads the empty list and lands now.
            await new Promise((resolve) => setTimeout(resolve, 150));
            releaseCreate();
            expect(await second).toBe(403);
            expect(services.map((row) => (row.Spec as { Name: string }).Name)).toEqual(['socio-plugin-foo']);
        } finally {
            releaseCreate();
            server.close();
            engine.close();
        }
    });

    it('keeps a volume claimed while a rolling update still runs old tasks that mount it', () => {
        // foo updated to drop bar-data: the current spec no longer mounts it.
        const updated = pluginBody('foo', ['logs']);
        const previous = withSource(pluginBody('foo', ['bar-data']), 'socio-plugin-foo-bar-data');
        const claimsFrom = (services: unknown[], tasks: unknown[]) => volumeClaimsOf(services, tasks);
        const expectRefused = (claims: ProxyPolicy['volumeClaims'], holder = /socio-plugin-foo\b/) =>
            expect(pluginServiceErrors(pluginBody('foo-bar', ['data']), fooPolicy(claims)).join(' ')).toMatch(holder);

        // PreviousSpec still names it (update or rollback in progress).
        expectRefused(claimsFrom([{ ID: 'svc-foo', Spec: updated, PreviousSpec: previous }], []));

        // A non-terminal old task still mounts it, even after PreviousSpec moved on.
        const oldTask = (state: string) => ({
            ID: `task-${state}`,
            ServiceID: 'svc-foo',
            Status: { State: state },
            Spec: { ContainerSpec: previous.TaskTemplate.ContainerSpec },
        });
        for (const state of ['running', 'starting', 'preparing']) {
            expectRefused(claimsFrom([{ ID: 'svc-foo', Spec: updated }], [oldTask(state)]));
        }
        // A task of a service no longer listed still holds it.
        expectRefused(claimsFrom([], [oldTask('running')]), /task task-running/);

        // Once the old tasks have shut down, the volume is free.
        const done = claimsFrom([{ ID: 'svc-foo', Spec: updated }], [oldTask('shutdown'), oldTask('complete')]);
        expect(pluginServiceErrors(pluginBody('foo-bar', ['data']), fooPolicy(done))).toEqual([]);
    });

    it('refuses plugin foo a volume of plugin foo-bar', () => {
        // foo declaring a volume "bar-data" names foo-bar's "data" volume.
        const errors = pluginServiceErrors(pluginBody('foo', ['bar-data']), fooPolicy([fooBarClaim]));
        expect(errors.join(' ')).toMatch(/foo-bar/);
        // Any name in foo-bar's namespace, mounted yet or not.
        const other = pluginServiceErrors(pluginBody('foo', ['bar-logs']), fooPolicy([fooBarClaim]));
        expect(other.join(' ')).toMatch(/foo-bar/);
        // And the other way round: a volume plugin foo already mounts.
        const fooClaim = { service: 'socio-plugin-foo', plugin: 'foo', volumes: ['socio-plugin-foo-bar-data'] };
        const reverse = pluginServiceErrors(pluginBody('foo-bar', ['data']), fooPolicy([fooClaim]));
        expect(reverse.join(' ')).toMatch(/socio-plugin-foo\b/);
        // A service of another deployment (its labels do not match this prefix's parse) still claims its volumes.
        const foreign = { service: 'socio-plugin-foo-bar', volumes: ['socio-plugin-foo-bar-data'] };
        expect(pluginServiceErrors(pluginBody('foo', ['bar-data']), fooPolicy([foreign])).length).toBeGreaterThan(0);
    });

    it('refuses a volume source that is not exactly <prefix>-<id>-<volume>', () => {
        for (const source of [
            'socio-plugin-foo-',
            'socio-plugin-foo-Data',
            'socio-plugin-foo--x',
            `socio-plugin-foo-${'a'.repeat(32)}`,
            'socio-plugin-foo-data/..',
            'socio-plugin-foobar-data',
        ]) {
            const errors = pluginServiceErrors(withSource(pluginBody('foo', ['data']), source), fooPolicy());
            expect(errors.length, source).toBeGreaterThan(0);
        }
    });

    it('forwards foo’s own volume and refuses foo-bar’s through the running proxy', async () => {
        const created: string[] = [];
        const deleted: string[] = [];
        const services = [
            {
                ID: 'svc-foo-bar',
                Spec: {
                    ...pluginBody('foo-bar', ['data']),
                },
            },
        ];
        const engine = createServer(async (req, res) => {
            const url = req.url ?? '';
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
                chunks.push(Buffer.from(chunk));
            }
            res.setHeader('content-type', 'application/json');
            if (url.startsWith('/v1.44/networks/')) {
                const id = decodeURIComponent(url.slice('/v1.44/networks/'.length)).replace(/^net-/, '');
                res.end(
                    JSON.stringify({ Id: `net-${id}`, Name: pluginNetworkName(id), Driver: 'overlay', Internal: true }),
                );
                return;
            }
            if (req.method === 'GET' && url === '/v1.44/tasks') {
                res.end('[]');
                return;
            }
            if (req.method === 'GET' && url.startsWith('/v1.44/services')) {
                res.end(JSON.stringify(services));
                return;
            }
            if (url === '/v1.44/services/create') {
                created.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).Name);
                res.end('{"ID":"svc-new"}');
                return;
            }
            if (req.method === 'DELETE' && url.startsWith('/v1.44/volumes/')) {
                deleted.push(decodeURIComponent(url.slice('/v1.44/volumes/'.length)));
                res.statusCode = 204;
                res.end();
                return;
            }
            res.statusCode = 404;
            res.end('{}');
        });
        const enginePort = await listen(engine);
        const proxy = startSocketProxy({
            listenHost: '127.0.0.1',
            listenPort: 0,
            upstream: `http://127.0.0.1:${enginePort}`,
            pins: fooPolicy().pins,
            infra: new Set(),
            secretNames: new Set(),
            log: () => {},
        });
        const server = await proxy.listen();
        const address = server.address();
        const endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
        try {
            const create = (body: unknown) =>
                fetch(`${endpoint}/v1.44/services/create`, { method: 'POST', body: JSON.stringify(body) });
            expect((await create(pluginBody('foo', ['bar-data']))).status).toBe(403);
            expect((await create(pluginBody('foo', ['data']))).status).toBe(200);
            expect(created).toEqual(['socio-plugin-foo']);

            const remove = (name: string) => fetch(`${endpoint}/v1.44/volumes/${name}`, { method: 'DELETE' });
            // foo-bar's service still mounts it.
            expect((await remove('socio-plugin-foo-bar-data')).status).toBe(403);
            expect((await remove('socio-plugin-foo-data')).status).toBe(204);
            expect((await remove('socio-plugin-foo-Data')).status).toBe(403);
            expect(deleted).toEqual(['socio-plugin-foo-data']);
        } finally {
            server.close();
            engine.close();
        }
    });
});

it('refuses a network delete whose labels name another plugin (prefix overlap)', async () => {
    const networks: Record<string, unknown> = {
        // Another deployment whose prefix is socio-plugin-net: its plugin "foo"'s network.
        'socio-plugin-net-net-foo': {
            Id: 'n1',
            Name: 'socio-plugin-net-net-foo',
            Labels: { 'socio.managed': 'plugin', 'socio.plugin': 'foo' },
        },
        'socio-plugin-net-foo': {
            Id: 'n2',
            Name: 'socio-plugin-net-foo',
            Labels: { 'socio.managed': 'plugin', 'socio.plugin': 'foo' },
        },
        // Created before networks carried labels: still removable.
        'socio-plugin-net-old': { Id: 'n3', Name: 'socio-plugin-net-old' },
    };
    const deleted: string[] = [];
    const engine = createServer((req, res) => {
        const name = decodeURIComponent((req.url ?? '').slice('/v1.44/networks/'.length));
        res.setHeader('content-type', 'application/json');
        if (req.method === 'DELETE') {
            deleted.push(name);
            res.statusCode = 204;
            res.end();
            return;
        }
        const row = networks[name];
        res.statusCode = row ? 200 : 404;
        res.end(JSON.stringify(row ?? {}));
    });
    const enginePort = await listen(engine);
    const proxy = startSocketProxy({
        listenHost: '127.0.0.1',
        listenPort: 0,
        upstream: `http://127.0.0.1:${enginePort}`,
        pins: PINS,
        infra: new Set(),
        secretNames: new Set(),
        log: () => {},
    });
    const server = await proxy.listen();
    const address = server.address();
    const endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    try {
        const remove = (name: string) => fetch(`${endpoint}/v1.44/networks/${name}`, { method: 'DELETE' });
        expect((await remove('socio-plugin-net-net-foo')).status).toBe(403);
        expect((await remove('socio-plugin-net-foo')).status).toBe(204);
        expect((await remove('socio-plugin-net-old')).status).toBe(204);
        expect(deleted).toEqual(['socio-plugin-net-foo', 'socio-plugin-net-old']);
    } finally {
        server.close();
        engine.close();
    }
});
