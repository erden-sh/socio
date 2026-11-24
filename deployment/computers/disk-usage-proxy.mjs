import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createHash, timingSafeEqual } from 'node:crypto';
// The computers' disk usage from the Docker Engine (CB-197), behind a
// read-only proxy. It is its own service, separate from the supervisor and
// from the plugin runtime's socket proxy: the only Docker requests it can
// make are the two fixed GETs below, and it answers only with the sizes of
// the computers this deployment's supervisor created. No caller's path,
// query, header or body reaches the engine.
//
// Runs on Bun (the supervisor image) and on Node (the tests).
//
// CB-321 adds one more answer, the deployment's resource use: the proxy
// lists the deployment's containers by label (its stacks, its plugin
// services and its socios' computers), asks the engine for each running
// one's stats, and answers with numbers only. It never inspects a
// container, and never reads env, mounts, logs or exec.
import { createServer, request } from 'node:http';
import { totalmem } from 'node:os';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { pathToFileURL, URLSearchParams } from 'node:url';

const API = '/v1.44';
// OpenBot's labels (supervisor/src/names.ts at the pinned revision).
const OWNER_LABEL = 'openbot.supervisor';
const BOT_LABEL = 'openbot.bot-id';
const NAMESPACE_LABEL = 'openbot.namespace';
const DEFAULT_NAMESPACE = 'openbot';
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const VOLUME_KINDS = ['workspace', 'profile', 'private'];
// The coding sandboxes' workspace volumes (CB-239, coding-sandbox.mjs's
// labels and names), for the Computer panel's sandbox list: their
// size, labels and name only, like the computers' own.
const CODING_OWNER_LABEL = 'socio.coding.supervisor';
const CODING_NAMESPACE_LABEL = 'socio.coding.namespace';
const CODING_VOLUME_LABEL = 'socio.coding.volume';
const VOLUME_KEY = /^[a-f0-9]{64}$/;
// The deployment's own containers (CB-321).
const STACK_LABEL = 'com.docker.stack.namespace';
const SERVICE_LABEL = 'com.docker.swarm.service.name';
const PLUGIN_MANAGED_LABEL = 'socio.managed';
const PLUGIN_ID_LABEL = 'socio.plugin';
const DEFAULT_PLUGIN_NAME_PREFIX = 'socio-plugin';
// The same rules as packages/shared/src/plugins/plugin-service.ts (PLUGIN_NAME_PREFIX, PLUGIN_ID).
const PLUGIN_NAME_PREFIX = /^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const PLUGIN_ID = /^(?!.*--)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const STACK_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The proxy's own route for the deployment's resource use (CB-321). */
export const DEPLOYMENT_STATS_PATH = '/deployment/stats';
/** At most this many containers are measured in one answer. */
export const DEPLOYMENT_STATS_MAX_CONTAINERS = 200;
const STATS_CONCURRENCY = 4;
/** Every field a measured container has in the answer: names, a kind and numbers, nothing else. */
export const DEPLOYMENT_CONTAINER_FIELDS = [
    'kind',
    'stack',
    'service',
    'node',
    'cpuPercent',
    'memoryBytes',
    'memoryLimitBytes',
    'restarts',
];

/** What a caller may ask for. Anything else is refused before Docker is reached. */
export const DISK_USAGE_ROUTES = [
    {
        method: 'GET',
        path: `${API}/system/df`,
        query: { type: 'volume' },
        upstream: `${API}/system/df?type=volume`,
        note: 'Volume sizes (UsageData.Size), only for the computers’ workspace, profile and private volumes and the coding sandboxes’ workspace volumes.',
    },
    {
        method: 'GET',
        path: `${API}/containers/json`,
        query: { all: 'true', size: 'true' },
        note: 'Writable-layer sizes (SizeRw), only for the computers’ containers. The proxy sets the label filters itself.',
    },
    {
        method: 'GET',
        path: DEPLOYMENT_STATS_PATH,
        query: {},
        note: 'The deployment’s resource use (CB-321): its stacks’, plugin services’ and computers’ containers, listed by label, then GET /containers/{id}/stats?stream=false for each running one. Numbers only: CPU percent, memory used and limit, restarts, the service and the node.',
    },
];

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : undefined);

/** The owner, namespace and Bot id labels of something this deployment's supervisor made. */
function ownedLabels(labels, namespace) {
    const value = record(labels);
    if (value?.[OWNER_LABEL] !== 'true') return undefined;
    if ((value[NAMESPACE_LABEL] ?? DEFAULT_NAMESPACE) !== namespace) return undefined;
    const bot = value[BOT_LABEL];
    if (typeof bot !== 'string' || !NAME.test(bot)) return undefined;
    return {
        [OWNER_LABEL]: 'true',
        [NAMESPACE_LABEL]: namespace,
        [BOT_LABEL]: bot,
    };
}

/** A coding sandbox's workspace volume this deployment's supervisor made (CB-239). */
function codingVolume(volume, namespace) {
    const value = record(volume?.Labels);
    const key = value?.[CODING_VOLUME_LABEL];
    if (
        value?.[CODING_OWNER_LABEL] !== 'true' ||
        value[CODING_NAMESPACE_LABEL] !== namespace ||
        typeof key !== 'string' ||
        !VOLUME_KEY.test(key) ||
        volume.Name !== `${namespace}-code-work-${key}`
    )
        return undefined;
    return {
        Name: volume.Name,
        Labels: {
            [CODING_OWNER_LABEL]: 'true',
            [CODING_NAMESPACE_LABEL]: namespace,
            [CODING_VOLUME_LABEL]: key,
        },
        UsageData: {
            Size: finite(volume.UsageData?.Size) ?? -1,
            RefCount: finite(volume.UsageData?.RefCount) ?? -1,
        },
    };
}

/**
 * Docker's df answer, cut down to the owned computer volumes and the
 * coding sandboxes' workspace volumes: no paths, options or other volumes.
 */
export function filterVolumes(report, namespace) {
    const volumes = Array.isArray(record(report)?.Volumes) ? report.Volumes : [];
    const out = [];
    for (const volume of volumes) {
        const coding = codingVolume(volume, namespace);
        if (coding) {
            out.push(coding);
            continue;
        }
        const labels = ownedLabels(volume?.Labels, namespace);
        if (!labels || typeof volume.Name !== 'string') continue;
        const kind = VOLUME_KINDS.find((kind) => volume.Name === `${namespace}-${kind}-${labels[BOT_LABEL]}`);
        if (!kind) continue;
        const size = finite(volume.UsageData?.Size);
        out.push({
            Name: volume.Name,
            Labels: labels,
            // -1 is Docker's own "not measured".
            UsageData: {
                Size: size ?? -1,
                RefCount: finite(volume.UsageData?.RefCount) ?? -1,
            },
        });
    }
    return { Volumes: out };
}

/** Docker's container list, cut down to the owned computers: name, state, mounted volume names and sizes. */
export function filterContainers(list, namespace) {
    const out = [];
    for (const container of Array.isArray(list) ? list : []) {
        const labels = ownedLabels(container?.Labels, namespace);
        if (!labels || typeof container.Id !== 'string') continue;
        const name = `/${namespace}-computer-${labels[BOT_LABEL]}`;
        if (!Array.isArray(container.Names) || !container.Names.includes(name)) continue;
        out.push({
            Id: container.Id,
            Names: [name],
            Labels: labels,
            State: typeof container.State === 'string' ? container.State : '',
            // Docker omits a zero SizeRw when sizes were asked for.
            SizeRw: finite(container.SizeRw) ?? 0,
            SizeRootFs: finite(container.SizeRootFs) ?? -1,
            Mounts: (Array.isArray(container.Mounts) ? container.Mounts : [])
                .filter((mount) => mount?.Type === 'volume' && typeof mount.Name === 'string')
                .map((mount) => ({ Type: 'volume', Name: mount.Name })),
        });
    }
    return out;
}

/**
 * The stacks, plugin prefix and node the deployment stats cover (CB-321):
 * `SOCIO_STACKS` (comma-separated stack names), `PLUGIN_NAME_PREFIX`
 * (default `socio-plugin`) and the node's name. A bad value is refused at
 * start rather than widening what the proxy reads.
 */
export function deploymentScope({ stacks, pluginPrefix, node } = {}) {
    const names = (Array.isArray(stacks) ? stacks : String(stacks ?? '').split(','))
        .map((name) => String(name).trim())
        .filter(Boolean);
    for (const name of names) {
        if (!STACK_NAME.test(name)) throw Error(`SOCIO_STACKS has an invalid stack name: ${JSON.stringify(name)}.`);
    }
    const prefix = String(pluginPrefix ?? '').trim() || DEFAULT_PLUGIN_NAME_PREFIX;
    if (!PLUGIN_NAME_PREFIX.test(prefix) || prefix.includes('--'))
        throw Error('PLUGIN_NAME_PREFIX must be 1 to 40 lowercase letters, digits and single dashes.');
    const nodeName = String(node ?? '').trim();
    return {
        stacks: [...new Set(names)],
        pluginPrefix: prefix,
        node: NODE_NAME.test(nodeName) ? nodeName : null,
    };
}

/**
 * Which part of the deployment a listed container belongs to, or undefined
 * when it is not the deployment's: a stack's task (by the stack label and
 * a service named `<stack>_…`), a plugin service's task (by the
 * `socio.managed=plugin` label and a service named `<prefix>-<id>` with
 * the same id), or a socio's computer (the supervisor's labels and name).
 */
export function deploymentMember(container, scope, namespace) {
    const labels = record(container?.Labels);
    if (!labels || typeof container.Id !== 'string') return undefined;
    const service = labels[SERVICE_LABEL];
    const stack = labels[STACK_LABEL];
    if (typeof stack === 'string' && scope.stacks.includes(stack)) {
        if (typeof service === 'string' && service.startsWith(`${stack}_`) && service.length <= 128)
            return { kind: 'stack', stack, service };
        return undefined;
    }
    if (labels[PLUGIN_MANAGED_LABEL] === 'plugin') {
        const id = labels[PLUGIN_ID_LABEL];
        if (
            typeof id === 'string' &&
            PLUGIN_ID.test(id) &&
            typeof service === 'string' &&
            service === `${scope.pluginPrefix}-${id}`
        )
            return { kind: 'plugin', stack: null, service };
        return undefined;
    }
    const owned = ownedLabels(labels, namespace);
    if (owned) {
        const name = `${namespace}-computer-${owned[BOT_LABEL]}`;
        if (Array.isArray(container.Names) && container.Names.includes(`/${name}`))
            return { kind: 'computer', stack: null, service: name };
    }
    return undefined;
}

/** The label filters of the container lists: Docker ANDs a filter's values, so one list per group. */
export function deploymentListPaths(scope, namespace) {
    const list = (label) => `${API}/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label }))}`;
    return [
        ...scope.stacks.map((stack) => list([`${STACK_LABEL}=${stack}`])),
        list([`${PLUGIN_MANAGED_LABEL}=plugin`]),
        list([`${OWNER_LABEL}=true`, `${NAMESPACE_LABEL}=${namespace}`]),
    ];
}

const delta = (now, before) => {
    const a = finite(now);
    const b = finite(before);
    return a === null || b === null || a < b ? null : a - b;
};

/**
 * One container's stats, cut down to numbers: CPU as a percent of one CPU
 * (Docker's convention: 150 is one and a half CPUs), memory in use without
 * the inactive page cache, and the memory limit, or null when the
 * container has none (the engine then reports the host's memory).
 */
export function statsNumbers(stats, hostMemoryBytes) {
    const value = record(stats);
    const cpu = record(value?.cpu_stats);
    const pre = record(value?.precpu_stats);
    const usage = record(cpu?.cpu_usage);
    const used = delta(usage?.total_usage, record(pre?.cpu_usage)?.total_usage);
    const system = delta(cpu?.system_cpu_usage, pre?.system_cpu_usage);
    const cpus =
        finite(cpu?.online_cpus) || (Array.isArray(usage?.percpu_usage) ? usage.percpu_usage.length : 0) || null;
    const memory = record(value?.memory_stats);
    const inUse = finite(memory?.usage);
    const detail = record(memory?.stats);
    // cgroup v2 names it inactive_file, v1 total_inactive_file.
    const cache = finite(detail?.inactive_file) ?? finite(detail?.total_inactive_file) ?? 0;
    const limit = finite(memory?.limit);
    return {
        cpuPercent: used !== null && system && cpus ? (used / system) * cpus * 100 : null,
        memoryBytes: inUse === null ? null : inUse - (cache <= inUse ? cache : 0),
        memoryLimitBytes: limit && !(hostMemoryBytes && limit >= hostMemoryBytes) && limit < 2 ** 62 ? limit : null,
        cpus,
    };
}

/**
 * The deployment's resource use now. `get(path, timeoutMs)` reads the
 * engine. Only list and stats GETs are made, and only for containers the
 * filters admit; stats are read for running containers, a few at a time.
 */
export async function readDeploymentStats({ get, scope, namespace, hostMemoryBytes, statsTimeoutMs = 15_000 }) {
    const lists = await Promise.all(deploymentListPaths(scope, namespace).map((path) => get(path)));
    const seen = new Set();
    const running = [];
    const replaced = new Map();
    for (const container of lists.flatMap((list) => (Array.isArray(list) ? list : []))) {
        if (seen.has(container?.Id)) continue;
        const member = deploymentMember(container, scope, namespace);
        if (!member) continue;
        seen.add(container.Id);
        if (container.State === 'running') running.push({ id: container.Id, member });
        else if (member.kind !== 'computer')
            // Swarm keeps a service's replaced tasks for a while: its restarts (and updates).
            replaced.set(member.service, (replaced.get(member.service) ?? 0) + 1);
    }
    const measured = running.slice(0, DEPLOYMENT_STATS_MAX_CONTAINERS);
    const out = Array.from({ length: measured.length });
    let cpus = null;
    for (let index = 0; index < measured.length; index += STATS_CONCURRENCY) {
        await Promise.all(
            measured.slice(index, index + STATS_CONCURRENCY).map(async ({ id, member }, offset) => {
                let numbers = { cpuPercent: null, memoryBytes: null, memoryLimitBytes: null, cpus: null };
                if (/^[A-Za-z0-9]{1,128}$/.test(id)) {
                    try {
                        numbers = statsNumbers(
                            await get(`${API}/containers/${id}/stats?stream=false`, statsTimeoutMs),
                            hostMemoryBytes,
                        );
                    } catch {
                        // Gone between the list and the stats, or slow: a gap, not a failure.
                    }
                }
                cpus ??= numbers.cpus;
                out[index + offset] = {
                    kind: member.kind,
                    stack: member.stack,
                    service: member.service,
                    node: scope.node,
                    cpuPercent: numbers.cpuPercent,
                    memoryBytes: numbers.memoryBytes,
                    memoryLimitBytes: numbers.memoryLimitBytes,
                    restarts: member.kind === 'computer' ? null : (replaced.get(member.service) ?? 0),
                };
            }),
        );
    }
    return {
        node: { name: scope.node, cpus, memoryBytes: finite(hostMemoryBytes) },
        containers: out,
        truncated: running.length > measured.length,
    };
}

/** The route for a request, when its method, path and query are exactly an allowed one. */
export function matchDiskUsageRoute(method, url) {
    if (typeof url !== 'string' || !url.startsWith('/')) return undefined;
    const cut = url.indexOf('?');
    const path = cut === -1 ? url : url.slice(0, cut);
    const params = new URLSearchParams(cut === -1 ? '' : url.slice(cut + 1));
    const keys = [...params.keys()];
    for (const route of DISK_USAGE_ROUTES) {
        if (method !== route.method || path !== route.path) continue;
        const expected = Object.entries(route.query);
        if (
            keys.length === expected.length &&
            new Set(keys).size === keys.length &&
            expected.every(([key, value]) => params.get(key) === value)
        )
            return route;
    }
    return undefined;
}

/** One GET to the engine over its socket, bounded in time and size. */
export function engineGet(socketPath, path, timeoutMs, maxBytes = 64 << 20) {
    return new Promise((resolve, reject) => {
        let timer;
        // Settle once, then drop the connection: an error after the response
        // began reaches the response, not the request.
        const fail = (error) => {
            clearTimeout(timer);
            reject(error);
            req.destroy();
        };
        const req = request(
            {
                socketPath,
                path,
                method: 'GET',
                headers: { Host: 'docker', Accept: 'application/json' },
            },
            (res) => {
                const chunks = [];
                let size = 0;
                res.on('data', (chunk) => {
                    size += chunk.length;
                    if (size > maxBytes) fail(Error('Docker response exceeded its size limit.'));
                    else chunks.push(chunk);
                });
                res.on('end', () => {
                    clearTimeout(timer);
                    if (size > maxBytes) return;
                    if (res.statusCode !== 200) return reject(Error(`Docker returned HTTP ${res.statusCode}.`));
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    } catch {
                        reject(Error('Docker returned malformed JSON.'));
                    }
                });
                res.on('error', fail);
            },
        );
        timer = setTimeout(() => {
            const error = Error('Docker did not answer in time.');
            error.timeout = true;
            fail(error);
        }, timeoutMs);
        timer.unref?.();
        req.on('error', fail);
        req.end();
    });
}

const digest = (value) => createHash('sha256').update(value).digest();

/**
 * The proxy's request handler. `get(path)` reads the engine (tests pass a
 * fake). Answers are shared: one engine read at a time per route, and a
 * fresh answer is reused for `minIntervalMs`, so callers cannot make the
 * engine walk the volumes more often than that.
 */
export function diskUsageHandler({
    namespace,
    token,
    get,
    minIntervalMs = 60_000,
    statsIntervalMs = 15_000,
    statsTimeoutMs = 15_000,
    stacks,
    pluginPrefix,
    node,
    hostMemoryBytes = totalmem(),
    now = Date.now,
}) {
    if (!NAME.test(namespace ?? '')) throw Error('DISK_USAGE_NAMESPACE must be a computer namespace.');
    if (typeof token !== 'string' || token.trim().length < 24)
        throw Error('DISK_USAGE_TOKEN must contain at least 24 characters.');
    const scope = deploymentScope({ stacks, pluginPrefix, node });
    const expected = digest(`Bearer ${token.trim()}`);
    const cache = new Map();
    const read = (route) => {
        const stats = route.path === DEPLOYMENT_STATS_PATH;
        const cached = cache.get(route.path);
        if (cached && (cached.pending || now() - cached.at < (stats ? statsIntervalMs : minIntervalMs)))
            return cached.pending ?? Promise.resolve(cached.body);
        if (stats)
            return remember(route, readDeploymentStats({ get, scope, namespace, hostMemoryBytes, statsTimeoutMs }));
        const upstream =
            route.upstream ??
            `${API}/containers/json?all=true&size=true&filters=${encodeURIComponent(
                JSON.stringify({
                    label: [`${OWNER_LABEL}=true`, `${NAMESPACE_LABEL}=${namespace}`],
                }),
            )}`;
        return remember(
            route,
            get(upstream).then((answer) =>
                route.path === `${API}/system/df`
                    ? filterVolumes(answer, namespace)
                    : filterContainers(answer, namespace),
            ),
        );
    };
    /** One shared read per route: its answer is reused, a failure is not. */
    const remember = (route, reading) => {
        const entry = {
            at: 0,
            body: undefined,
            pending: reading.then(
                (body) => {
                    entry.at = now();
                    entry.body = body;
                    entry.pending = undefined;
                    return body;
                },
                (error) => {
                    // A failure is not cached: the next request tries again.
                    cache.delete(route.path);
                    throw error;
                },
            ),
        };
        cache.set(route.path, entry);
        return entry.pending;
    };
    return async (req, res) => {
        const send = (status, body) => {
            res.writeHead(status, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify(body));
        };
        if (req.method === 'GET' && req.url === '/_ping') return send(200, { ok: true });
        const given = req.headers.authorization;
        if (typeof given !== 'string' || !timingSafeEqual(digest(given), expected))
            return send(401, { error: 'Unauthorized' });
        const route = matchDiskUsageRoute(req.method, req.url);
        if (!route)
            return send(req.method === 'GET' ? 403 : 405, {
                error: 'Not allowed by the disk usage proxy.',
            });
        try {
            send(200, await read(route));
        } catch (error) {
            send(error?.timeout ? 504 : 502, {
                error:
                    route.path === DEPLOYMENT_STATS_PATH
                        ? 'Docker deployment stats unavailable.'
                        : 'Docker disk usage unavailable.',
            });
        }
    };
}

export function startDiskUsageProxy({
    socketPath = '/var/run/docker.sock',
    host = '0.0.0.0',
    port = 4301,
    timeoutMs = 600_000,
    ...options
}) {
    const server = createServer(
        diskUsageHandler({
            ...options,
            get: (path, timeout) => engineGet(socketPath, path, timeout ?? timeoutMs),
        }),
    );
    // The engine may take minutes to size the volumes; the request is tiny.
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [host, port] = (process.env.DISK_USAGE_LISTEN ?? '0.0.0.0:4301').split(':');
    const server = await startDiskUsageProxy({
        socketPath: process.env.DOCKER_SOCKET?.trim() || '/var/run/docker.sock',
        host,
        port: Number(port),
        namespace: process.env.DISK_USAGE_NAMESPACE?.trim(),
        token: process.env.DISK_USAGE_TOKEN,
        timeoutMs: Number(process.env.DISK_USAGE_TIMEOUT_MS) || 600_000,
        stacks: process.env.SOCIO_STACKS,
        pluginPrefix: process.env.PLUGIN_NAME_PREFIX,
        node: process.env.DISK_USAGE_NODE,
    });
    const address = server.address();
    console.log(
        `Disk usage proxy listening on ${typeof address === 'string' ? address : `${address.address}:${address.port}`}.`,
    );
}
