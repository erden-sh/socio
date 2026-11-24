import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';

import { afterEach, expect, it, vi } from 'vitest';

import {
    DEPLOYMENT_CONTAINER_FIELDS,
    DISK_USAGE_ROUTES,
    deploymentScope,
    diskUsageHandler,
    engineGet,
    filterContainers,
    filterVolumes,
    matchDiskUsageRoute,
    startDiskUsageProxy,
    statsNumbers,
} from '../deployment/computers/disk-usage-proxy.mjs';

// CB-197: the computers' disk usage through a read-only Docker proxy.
const TOKEN = 'fixture-token-with-24-characters';
const auth = { authorization: `Bearer ${TOKEN}` };
const owned = (bot, namespace = 'company-brain') => ({
    'openbot.supervisor': 'true',
    'openbot.namespace': namespace,
    'openbot.bot-id': bot,
    'com.example.other': 'secret-ish',
});
const volume = (Name, Labels, Size = 100) => ({
    Name,
    Labels,
    Driver: 'local',
    Mountpoint: `/var/lib/docker/volumes/${Name}/_data`,
    Options: { device: '/srv/private' },
    UsageData: { Size, RefCount: 1 },
});
const DF = {
    LayersSize: 123,
    Images: [{ Id: 'sha256:image' }],
    Containers: [{ Id: 'other' }],
    BuildCache: [],
    Volumes: [
        volume('company-brain-workspace-dot-a', owned('dot-a'), 1000),
        volume('company-brain-profile-dot-a', owned('dot-a'), 200),
        volume('company-brain-private-dot-a', owned('dot-a'), 30),
        // Another deployment, a foreign volume, a mislabelled one and an unknown size.
        volume('other-workspace-dot-a', owned('dot-a', 'other'), 5),
        volume('postgres-data', {}, 9_000_000),
        volume('company-brain-workspace-dot-b', owned('dot-c'), 7),
        volume('company-brain-workspace-dot-d', owned('dot-d'), -1),
        volume('company-brain-cache-dot-a', owned('dot-a'), 1),
    ],
};
const CONTAINERS = [
    {
        Id: 'computer-a',
        Names: ['/company-brain-computer-dot-a'],
        Image: 'company-brain-computer',
        Command: 'bun src/index.ts --token=abc',
        Labels: owned('dot-a'),
        State: 'running',
        Status: 'Up 2 hours',
        SizeRw: 4096,
        SizeRootFs: 900000,
        Mounts: [
            {
                Type: 'volume',
                Name: 'company-brain-workspace-dot-a',
                Source: '/var/lib/docker/volumes/company-brain-workspace-dot-a/_data',
                Destination: '/workspace',
            },
            { Type: 'bind', Source: '/etc/secret', Destination: '/secret' },
        ],
    },
    // SizeRw is omitted by Docker when it is zero.
    {
        Id: 'computer-b',
        Names: ['/company-brain-computer-dot-b'],
        Labels: owned('dot-b'),
        State: 'exited',
    },
    {
        Id: 'impostor',
        Names: ['/company-brain-computer-dot-x'],
        Labels: owned('dot-y'),
    },
    { Id: 'app', Names: ['/company-brain_app.1'], Labels: {} },
];

const cleanup = [];
afterEach(async () => {
    vi.useRealTimers();
    for (const close of cleanup.splice(0).reverse()) {
        await close();
    }
});

/** A fake Docker Engine on a unix socket that records every request it gets. */
async function fakeEngine(answer = defaultAnswer) {
    const dir = mkdtempSync(join(tmpdir(), 'cb197-engine-'));
    const socketPath = join(dir, 'docker.sock');
    const requests = [];
    const server = createServer((req, res) => {
        requests.push({ method: req.method, url: req.url, headers: req.headers });
        answer(req, res);
    });
    await new Promise((resolve) => server.listen(socketPath, resolve));
    cleanup.push(async () => {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
        rmSync(dir, { recursive: true, force: true });
    });
    return { socketPath, requests, server };
}
function defaultAnswer(req, res) {
    const body = req.url.startsWith('/v1.44/system/df')
        ? DF
        : req.url.startsWith('/v1.44/containers/json')
          ? CONTAINERS
          : { message: 'unexpected' };
    res.writeHead(body.message ? 500 : 200, {
        'Content-Type': 'application/json',
    });
    res.end(JSON.stringify(body));
}
async function proxyOn(socketPath, options = {}) {
    const server = await startDiskUsageProxy({
        socketPath,
        host: '127.0.0.1',
        port: 0,
        namespace: 'company-brain',
        token: TOKEN,
        ...options,
    });
    cleanup.push(
        () =>
            new Promise((resolve) => {
                server.closeAllConnections?.();
                server.close(resolve);
            }),
    );
    return `http://127.0.0.1:${server.address().port}`;
}

it('reads volume sizes and writable layers through two fixed engine GETs, filtered to the computers', async () => {
    const engine = await fakeEngine();
    const base = await proxyOn(engine.socketPath);
    const df = await globalThis.fetch(base + '/v1.44/system/df?type=volume', {
        headers: auth,
    });
    expect(df.status).toBe(200);
    expect(await df.json()).toEqual({
        Volumes: [
            {
                Name: 'company-brain-workspace-dot-a',
                Labels: {
                    'openbot.supervisor': 'true',
                    'openbot.namespace': 'company-brain',
                    'openbot.bot-id': 'dot-a',
                },
                UsageData: { Size: 1000, RefCount: 1 },
            },
            expect.objectContaining({
                Name: 'company-brain-profile-dot-a',
                UsageData: { Size: 200, RefCount: 1 },
            }),
            expect.objectContaining({
                Name: 'company-brain-private-dot-a',
                UsageData: { Size: 30, RefCount: 1 },
            }),
            expect.objectContaining({
                Name: 'company-brain-workspace-dot-d',
                UsageData: { Size: -1, RefCount: 1 },
            }),
        ],
    });
    const containers = await globalThis.fetch(base + '/v1.44/containers/json?size=true&all=true', { headers: auth });
    expect(containers.status).toBe(200);
    const list = await containers.json();
    expect(list).toEqual([
        {
            Id: 'computer-a',
            Names: ['/company-brain-computer-dot-a'],
            Labels: {
                'openbot.supervisor': 'true',
                'openbot.namespace': 'company-brain',
                'openbot.bot-id': 'dot-a',
            },
            State: 'running',
            SizeRw: 4096,
            SizeRootFs: 900000,
            Mounts: [{ Type: 'volume', Name: 'company-brain-workspace-dot-a' }],
        },
        expect.objectContaining({ Id: 'computer-b', SizeRw: 0 }),
    ]);
    const text = JSON.stringify(list);
    expect(text).not.toMatch(/Mountpoint|\/var\/lib|\/etc\/secret|token=|com\.example/);
    // The engine saw exactly the proxy's own requests, never the caller's query.
    expect(engine.requests.map((request) => [request.method, request.url])).toEqual([
        ['GET', '/v1.44/system/df?type=volume'],
        [
            'GET',
            '/v1.44/containers/json?all=true&size=true&filters=' +
                encodeURIComponent(
                    JSON.stringify({
                        label: ['openbot.supervisor=true', 'openbot.namespace=company-brain'],
                    }),
                ),
        ],
    ]);
    expect(engine.requests[0].headers.authorization).toBeUndefined();
});

it.each([
    ['POST', '/v1.44/system/df?type=volume'],
    ['DELETE', '/v1.44/volumes/company-brain-workspace-dot-a'],
    ['GET', '/v1.44/system/df'],
    ['GET', '/v1.44/system/df?type=volume&type=container'],
    ['GET', '/v1.44/system/df?type=container'],
    ['GET', '/v1.44/system/df?type=volume&verbose=1'],
    ['GET', '/v1.44/containers/json?all=true&size=true&filters=%7B%7D'],
    ['GET', '/v1.44/containers/json'],
    ['GET', '/v1.44/containers/computer-a/json'],
    ['GET', '/v1.44/containers/computer-a/archive?path=/'],
    ['GET', '/v1.44/containers/computer-a/logs?stdout=1'],
    ['GET', '/v1.44/volumes'],
    ['GET', '/v1.44/info'],
    ['GET', '/v1.43/system/df?type=volume'],
    ['GET', '/system/df?type=volume'],
    ['GET', '/v1.44/system/df/../../containers/json?all=true&size=true'],
    ['GET', '/v1.44//system/df?type=volume'],
    ['GET', '/v1.44/system%2Fdf?type=volume'],
    ['POST', '/v1.44/containers/create'],
    ['POST', '/deployment/stats'],
    ['GET', '/deployment/stats?all=true'],
    ['GET', '/deployment/stats/../containers/json'],
    ['GET', '/v1.44/containers/app-1/stats?stream=false'],
    ['GET', '/v1.44/containers/app-1/stats'],
    ['GET', '/v1.44/services'],
])('refuses %s %s without reaching the engine', async (method, path) => {
    const engine = await fakeEngine();
    const base = await proxyOn(engine.socketPath);
    // A raw request: fetch would normalize the dot segments first.
    const status = await new Promise((resolve, reject) => {
        const url = new URL(base);
        request({ host: url.hostname, port: url.port, method, path, headers: auth }, (res) => {
            res.resume();
            resolve(res.statusCode);
        })
            .on('error', reject)
            .end();
    });
    expect([403, 405]).toContain(status);
    expect(engine.requests).toEqual([]);
});

it('needs the bearer token for every engine read, not for its own ping', async () => {
    const engine = await fakeEngine();
    const base = await proxyOn(engine.socketPath);
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: TOKEN }]) {
        expect(
            (
                await globalThis.fetch(base + '/v1.44/system/df?type=volume', {
                    headers,
                })
            ).status,
        ).toBe(401);
    }
    expect((await globalThis.fetch(base + '/_ping')).status).toBe(200);
    expect(engine.requests).toEqual([]);
    expect(() => diskUsageHandler({ namespace: 'company-brain', token: 'short', get() {} })).toThrow(/24 characters/);
    expect(() => diskUsageHandler({ namespace: 'a/b', token: TOKEN, get() {} })).toThrow(/namespace/);
});

it('shares one slow df among callers and reuses a fresh answer instead of walking the volumes again', async () => {
    let release;
    const engine = await fakeEngine((req, res) => {
        release = () => defaultAnswer(req, res);
    });
    let now = 1_000_000;
    const base = await proxyOn(engine.socketPath, {
        minIntervalMs: 60_000,
        now: () => now,
    });
    const reads = [1, 2, 3].map(() => globalThis.fetch(base + '/v1.44/system/df?type=volume', { headers: auth }));
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    release();
    for (const response of await Promise.all(reads)) {
        expect((await response.json()).Volumes).toHaveLength(4);
    }
    await globalThis.fetch(base + '/v1.44/system/df?type=volume', {
        headers: auth,
    });
    expect(engine.requests).toHaveLength(1);
    now += 60_000;
    const again = globalThis.fetch(base + '/v1.44/system/df?type=volume', {
        headers: auth,
    });
    await vi.waitFor(() => expect(engine.requests).toHaveLength(2));
    release();
    expect((await again).status).toBe(200);
});

it('answers unavailable when the engine fails, times out or sends too much, and does not cache the failure', async () => {
    let mode = 'error';
    const engine = await fakeEngine((req, res) => {
        if (mode === 'error') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end('{"message":"a disk usage operation is already running"}');
        } else if (mode === 'malformed') {
            res.writeHead(200);
            res.end('not json');
        } else if (mode === 'hang') {
            /* never answers */
        } else {
            defaultAnswer(req, res);
        }
    });
    const base = await proxyOn(engine.socketPath, { timeoutMs: 200 });
    const read = () => globalThis.fetch(base + '/v1.44/system/df?type=volume', { headers: auth });
    const first = await read();
    expect(first.status).toBe(502);
    expect(JSON.stringify(await first.json())).not.toMatch(/already running/);
    mode = 'malformed';
    expect((await read()).status).toBe(502);
    mode = 'hang';
    expect((await read()).status).toBe(504);
    mode = 'ok';
    expect((await read()).status).toBe(200);
    expect(engine.requests).toHaveLength(4);
    await expect(engineGet(engine.socketPath, '/v1.44/system/df?type=volume', 1000, 10)).rejects.toThrow(/size limit/);
});

it('documents exactly the routes it matches', () => {
    expect(DISK_USAGE_ROUTES.map((route) => `${route.method} ${route.path}`)).toEqual([
        'GET /v1.44/system/df',
        'GET /v1.44/containers/json',
        'GET /deployment/stats',
    ]);
    expect(matchDiskUsageRoute('GET', '/deployment/stats')).toBe(DISK_USAGE_ROUTES[2]);
    expect(matchDiskUsageRoute('GET', '/v1.44/system/df?type=volume')).toBe(DISK_USAGE_ROUTES[0]);
    expect(matchDiskUsageRoute('GET', '/v1.44/containers/json?all=true&size=true')).toBe(DISK_USAGE_ROUTES[1]);
    expect(matchDiskUsageRoute('HEAD', '/v1.44/system/df?type=volume')).toBe(undefined);
    // Malformed engine answers filter to nothing rather than throwing.
    expect(filterVolumes(null, 'company-brain')).toEqual({ Volumes: [] });
    expect(filterVolumes({ Volumes: [null, 1] }, 'company-brain')).toEqual({
        Volumes: [],
    });
    expect(filterContainers({}, 'company-brain')).toEqual([]);
    // Volumes from before the namespace label carry OpenBot's default namespace.
    const legacy = { 'openbot.supervisor': 'true', 'openbot.bot-id': 'dot-a' };
    expect(filterVolumes({ Volumes: [volume('openbot-workspace-dot-a', legacy)] }, 'openbot').Volumes).toHaveLength(1);
    expect(
        filterVolumes({ Volumes: [volume('company-brain-workspace-dot-a', legacy)] }, 'company-brain').Volumes,
    ).toHaveLength(0);
});

it('ships the proxy in the supervisor image that no longer calls df', () => {
    const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    const TAG = 'company-brain-supervisor:b6932d3-dot-auth-isolated-v2';
    for (const path of ['scripts/build-images.mjs', '.docker/compose.computers.yml']) {
        expect(read(path)).toContain(TAG);
        expect(read(path)).not.toContain('dot-auth-isolated-v1');
    }
    expect(read('deployment/computers/supervisor.Dockerfile')).toContain(
        'COPY deployment/computers/disk-usage-proxy.mjs ./disk-usage-proxy.mjs',
    );
});

// CB-321: the deployment's resource use, numbers only.
const GiB = 1024 ** 3;
const HOST_MEMORY = 64 * GiB;
const task = (Id, stack, service, State = 'running', extra = {}) => ({
    Id,
    Names: [`/${service}.1.${Id}`],
    Image: 'company-brain:secret-tag',
    Command: 'node server.js --token=abc',
    State,
    Labels: {
        'com.docker.stack.namespace': stack,
        'com.docker.swarm.service.name': service,
        'com.docker.swarm.node.id': 'node-id',
        ...extra,
    },
    Mounts: [{ Type: 'bind', Source: '/etc/secret', Destination: '/secret' }],
    HostConfig: { NetworkMode: 'default' },
});
const plugin = (Id, service, id, extra = {}) => ({
    Id,
    Names: [`/${service}.1.${Id}`],
    State: 'running',
    Labels: {
        'com.docker.swarm.service.name': service,
        'socio.managed': 'plugin',
        'socio.plugin': id,
        ...extra,
    },
});
const DEPLOYMENT = [
    task('app1', 'company-brain', 'company-brain_app'),
    task('app0', 'company-brain', 'company-brain_app', 'exited'),
    task('app9', 'company-brain', 'company-brain_app', 'exited'),
    task('seaweed1', 'company-brain', 'company-brain_seaweedfs'),
    task('disk1', 'company-brain-computers', 'company-brain-computers_disk-usage'),
    plugin('plug1', 'socio-plugin-weather', 'weather'),
    { ...CONTAINERS[0], Id: 'computera' },
    // Outside the filters: a neighbor's stack, a stack label with a foreign
    // service, a plugin of another prefix, a plugin whose id doesn't match
    // its service, another deployment's computer, an unlabelled container.
    task('neighbor1', 'example-co', 'example-co_app'),
    task('spoof1', 'company-brain', 'example-co_app'),
    plugin('plug2', 'hello-plugin-weather', 'weather'),
    plugin('plug3', 'socio-plugin-weather', 'other'),
    { ...CONTAINERS[0], Id: 'othercomputer', Labels: owned('dot-a', 'other') },
    { Id: 'postgres1', Names: ['/postgres'], State: 'running', Labels: {} },
];
const stats = ({ cpu = 2e9, system = 100e9, cpus = 8, usage = GiB, cache = 256 * 1048576, limit = 3 * GiB } = {}) => ({
    read: '2026-11-01T00:00:00Z',
    name: '/company-brain_app.1.abc',
    id: 'app1',
    cpu_stats: { cpu_usage: { total_usage: 10e9 + cpu }, system_cpu_usage: 1000e9 + system, online_cpus: cpus },
    precpu_stats: { cpu_usage: { total_usage: 10e9 }, system_cpu_usage: 1000e9, online_cpus: cpus },
    memory_stats: { usage, limit, stats: { inactive_file: cache } },
    networks: { eth0: { rx_bytes: 1 } },
    blkio_stats: {},
    pids_stats: { current: 3 },
});
function deploymentAnswer(req, res) {
    const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, 'http://docker');
    // The fake engine ignores the filters: the proxy must filter again.
    if (url.pathname === '/v1.44/containers/json') {
        return send(200, DEPLOYMENT);
    }
    const match = /^\/v1\.44\/containers\/([^/]+)\/stats$/.exec(url.pathname);
    if (match && url.searchParams.get('stream') === 'false') {
        if (match[1] === 'seaweed1') {
            return send(200, stats({ cpu: 1e9, limit: HOST_MEMORY }));
        }
        if (match[1] === 'disk1') {
            return send(404, { message: 'No such container' });
        }
        return send(200, stats());
    }
    send(500, { message: 'unexpected' });
}
const deploymentOptions = {
    stacks: 'company-brain,company-brain-computers,company-brain-updater',
    node: 'node-1',
    hostMemoryBytes: HOST_MEMORY,
};

it('measures only the deployment’s stacks, plugin services and computers, with list and stats GETs only', async () => {
    const engine = await fakeEngine(deploymentAnswer);
    const base = await proxyOn(engine.socketPath, deploymentOptions);
    const response = await globalThis.fetch(base + '/deployment/stats', { headers: auth });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.node).toEqual({ name: 'node-1', cpus: 8, memoryBytes: HOST_MEMORY });
    expect(body.truncated).toBe(false);
    expect(body.containers.map((row) => [row.kind, row.service])).toEqual([
        ['stack', 'company-brain_app'],
        ['stack', 'company-brain_seaweedfs'],
        ['stack', 'company-brain-computers_disk-usage'],
        ['plugin', 'socio-plugin-weather'],
        ['computer', 'company-brain-computer-dot-a'],
    ]);
    // 2 of 100 CPU-seconds on 8 CPUs: 16% of one CPU. Memory without the inactive cache.
    expect(body.containers[0]).toEqual({
        kind: 'stack',
        stack: 'company-brain',
        service: 'company-brain_app',
        node: 'node-1',
        cpuPercent: 16,
        memoryBytes: GiB - 256 * 1048576,
        memoryLimitBytes: 3 * GiB,
        restarts: 2,
    });
    // No limit: the engine reports the host's memory, which the proxy flags as none.
    expect(body.containers[1]).toMatchObject({ memoryLimitBytes: null, restarts: 0, cpuPercent: 8 });
    // A container gone between the list and its stats is a gap, not a failure.
    expect(body.containers[2]).toMatchObject({ cpuPercent: null, memoryBytes: null, memoryLimitBytes: null });
    expect(body.containers[4]).toMatchObject({ restarts: null });
    const text = JSON.stringify(body);
    for (const outside of ['neighbor1', 'example-co', 'spoof1', 'hello-plugin', 'plug3', 'othercomputer', 'postgres']) {
        expect(text).not.toContain(outside);
    }
    // Only the engine reads it was built for: label-filtered lists and one stats GET per running member.
    const urls = engine.requests.map((request) => `${request.method} ${request.url}`);
    const list = (label) =>
        `GET /v1.44/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label }))}`;
    expect(urls.slice(0, 5)).toEqual([
        list(['com.docker.stack.namespace=company-brain']),
        list(['com.docker.stack.namespace=company-brain-computers']),
        list(['com.docker.stack.namespace=company-brain-updater']),
        list(['socio.managed=plugin']),
        list(['openbot.supervisor=true', 'openbot.namespace=company-brain']),
    ]);
    expect(urls.slice(5).toSorted()).toEqual(
        ['app1', 'computera', 'disk1', 'plug1', 'seaweed1'].map(
            (id) => `GET /v1.44/containers/${id}/stats?stream=false`,
        ),
    );
    expect(urls.join('\n')).not.toMatch(
        /\/json\?(?!all=true&filters=)|\/logs|\/exec|\/archive|\/services|\/info|size=true/,
    );
});

it('answers with names and numbers only: no env, mounts, labels, ids, images or commands', async () => {
    const engine = await fakeEngine(deploymentAnswer);
    const base = await proxyOn(engine.socketPath, deploymentOptions);
    const body = await (await globalThis.fetch(base + '/deployment/stats', { headers: auth })).json();
    expect(Object.keys(body).toSorted()).toEqual(['containers', 'node', 'truncated']);
    expect(Object.keys(body.node).toSorted()).toEqual(['cpus', 'memoryBytes', 'name']);
    for (const row of body.containers) {
        expect(Object.keys(row).toSorted()).toEqual([...DEPLOYMENT_CONTAINER_FIELDS].toSorted());
        for (const [key, value] of Object.entries(row)) {
            if (['kind', 'stack', 'service', 'node'].includes(key)) {
                expect(value === null || typeof value === 'string').toBe(true);
            } else {
                expect(value === null || typeof value === 'number').toBe(true);
            }
        }
    }
    expect(JSON.stringify(body)).not.toMatch(
        /Env|env|Mount|mount|Label|Image|Command|token|secret|networks|rx_bytes|pids|node-id|"Id"|app1|\/etc/,
    );
});

it('needs the supervisor token for deployment stats, reuses a fresh answer and does not cache a failure', async () => {
    let fail = true;
    const engine = await fakeEngine((req, res) => {
        if (fail) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end('{"message":"engine broke /secret/path"}');
        } else {
            deploymentAnswer(req, res);
        }
    });
    let now = 5_000_000;
    const base = await proxyOn(engine.socketPath, { ...deploymentOptions, statsIntervalMs: 15_000, now: () => now });
    for (const headers of [{}, { authorization: 'Bearer wrong' }]) {
        expect((await globalThis.fetch(base + '/deployment/stats', { headers })).status).toBe(401);
    }
    expect(engine.requests).toEqual([]);
    const failed = await globalThis.fetch(base + '/deployment/stats', { headers: auth });
    expect(failed.status).toBe(502);
    expect(JSON.stringify(await failed.json())).not.toMatch(/secret/);
    fail = false;
    expect((await globalThis.fetch(base + '/deployment/stats', { headers: auth })).status).toBe(200);
    const reads = engine.requests.length;
    expect((await globalThis.fetch(base + '/deployment/stats', { headers: auth })).status).toBe(200);
    expect(engine.requests).toHaveLength(reads);
    now += 15_000;
    expect((await globalThis.fetch(base + '/deployment/stats', { headers: auth })).status).toBe(200);
    expect(engine.requests.length).toBeGreaterThan(reads);
});

it('refuses bad stack names and plugin prefixes at start, and reads stats defensively', () => {
    expect(deploymentScope({ stacks: ' company-brain , company-brain ,,company-brain-updater ' })).toEqual({
        stacks: ['company-brain', 'company-brain-updater'],
        pluginPrefix: 'socio-plugin',
        node: null,
    });
    expect(deploymentScope({ pluginPrefix: 'example-plugin', node: 'node-1' })).toMatchObject({
        stacks: [],
        pluginPrefix: 'example-plugin',
        node: 'node-1',
    });
    expect(() => deploymentScope({ stacks: 'company-brain,../x' })).toThrow(/SOCIO_STACKS/);
    expect(() => deploymentScope({ pluginPrefix: 'Bad--prefix' })).toThrow(/PLUGIN_NAME_PREFIX/);
    expect(() => diskUsageHandler({ namespace: 'company-brain', token: TOKEN, get() {}, stacks: 'a b' })).toThrow(
        /SOCIO_STACKS/,
    );
    expect(statsNumbers(null)).toEqual({ cpuPercent: null, memoryBytes: null, memoryLimitBytes: null, cpus: null });
    // The first sample after a start has no previous CPU reading.
    expect(statsNumbers({ ...stats(), precpu_stats: {} }, HOST_MEMORY).cpuPercent).toBe(null);
    // cgroup v1 names the cache total_inactive_file.
    expect(
        statsNumbers({ memory_stats: { usage: 1000, limit: 4000, stats: { total_inactive_file: 300 } } }, 8000),
    ).toMatchObject({ memoryBytes: 700, memoryLimitBytes: 4000 });
});
