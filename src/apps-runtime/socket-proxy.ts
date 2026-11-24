import {
    createServer,
    request as httpRequest,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from 'node:http';

import { identitySecretLabels, parseIdentitySecretName, SWARM_IDENTITY_FILE } from '@socio/shared/identity-delivery';
import {
    PLUGIN_ID,
    PLUGIN_PIDS_CAP,
    PLUGIN_REPLICA_CAP,
    PINNED_IMAGE,
    PLUGIN_REVISION,
    pluginHealthTest,
    pluginNamePrefix,
    pluginNetworkName,
    pluginNetworkNamePattern,
    pluginServiceName,
    pluginServiceNamePattern,
    PLUGIN_VOLUME_NAME,
    pluginVolumePrefix,
} from '@socio/shared/plugins/plugin-service';

import { REVISION_FIELD, containerRevision } from './revision.js';

/**
 * The only process that opens the Docker socket. The apps runtime talks to
 * it over an internal network. A path allow list is not enough: one
 * `POST /services/create` with a bind mount, `Privileged`, or the host
 * network is root on the host. This proxy allows the plugin manager's
 * routes and checks the body of every service create and update.
 *
 * Image pins are the operator's (`SOCKET_PROXY_IMAGE_PINS`), not the
 * caller's. A digest that is not on that list is refused even when the
 * reference is shaped like `name@sha256:…`.
 *
 * Placement is the operator's too (`SOCKET_PROXY_PLUGIN_CONSTRAINTS`). When
 * set, every plugin service must carry exactly those constraints and
 * nothing else under `Placement`; when unset, a plugin service may carry no
 * `Placement` at all. A caller cannot steer a plugin onto another node.
 *
 * Secrets: the runtime may create and delete only plugin identity secrets,
 * `<PLUGIN_NAME_PREFIX>-wl-<id>-v<n>` labelled `socio.managed=plugin` and
 * `socio.plugin=<id>`, and a plugin service may mount only its own. A
 * delete is checked against the engine's copy of the secret, by its full
 * id. No list, no inspect, no other secret.
 */

const API = '/v1.44';

/** Routes the plugin manager uses. Anything else is refused, including other API versions. */
export const SOCKET_PROXY_ALLOWLIST = [
    { method: 'GET', path: '/_ping', note: 'Engine health.' },
    { method: 'GET', path: `${API}/version`, note: 'Engine version.' },
    { method: 'GET', path: `${API}/services`, note: 'List services.' },
    { method: 'GET', path: `${API}/services/{id}`, note: 'Inspect a service.' },
    {
        method: 'POST',
        path: `${API}/services/create`,
        note: 'Create a plugin service. The body is checked.',
    },
    {
        method: 'POST',
        path: `${API}/services/{id}/update`,
        note: 'Update a plugin service, or only add or remove a plugin network on an infra service. The body is checked.',
    },
    {
        method: 'DELETE',
        path: `${API}/services/{id}`,
        note: 'Remove a service whose name is <PLUGIN_NAME_PREFIX>-<id> (socio-plugin by default) and whose label says Socio manages it.',
    },
    {
        method: 'GET',
        path: `${API}/tasks`,
        note: 'List tasks for replica addresses.',
    },
    {
        method: 'GET',
        path: `${API}/secrets`,
        note: 'List one secret by exact name: an allowlisted name, or a plugin identity secret <PLUGIN_NAME_PREFIX>-wl-<id>-v<n>. No inspect by id or unfiltered list.',
    },
    {
        method: 'POST',
        path: `${API}/secrets/create`,
        note: 'Create a plugin identity secret <PLUGIN_NAME_PREFIX>-wl-<id>-v<n> with exactly the labels socio.managed=plugin and socio.plugin=<id>. The body is checked.',
    },
    {
        method: 'DELETE',
        path: `${API}/secrets/{id}`,
        note: 'Remove a secret, by its full id, whose engine copy is a plugin identity secret with those labels.',
    },
    { method: 'GET', path: `${API}/networks`, note: 'List networks.' },
    { method: 'GET', path: `${API}/networks/{id}`, note: 'Inspect a network.' },
    {
        method: 'POST',
        path: `${API}/networks/create`,
        note: 'Create an internal overlay named <PLUGIN_NAME_PREFIX>-net-<id>.',
    },
    {
        method: 'DELETE',
        path: `${API}/networks/{id}`,
        note: 'Remove a network whose name is <PLUGIN_NAME_PREFIX>-net-<id>.',
    },
    {
        method: 'POST',
        path: `${API}/images/create`,
        note: 'Pull one pinned name@sha256 digest. No tar load and no tag.',
    },
    {
        method: 'DELETE',
        path: `${API}/volumes/{name}`,
        note: 'Remove a volume named exactly <PLUGIN_NAME_PREFIX>-<id>-<volume> that no service mounts.',
    },
] as const;

/** Not on the allow list. Named here so the threat model and the tests share one list. */
export const SOCKET_PROXY_DENIED = [
    '/containers (create, start, and every other container route)',
    '/exec and /containers/{id}/exec',
    '/build',
    '/swarm',
    '/secrets: unfiltered list, inspect by id, and create or delete of anything but a plugin identity secret; /configs',
    '/nodes, /plugins, /system, /events, /commit',
    '/volumes/create',
    '/images/{id}/push and any image load from a body',
    'any API version other than v1.44',
] as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const BANNED_ENV = new Set(['LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DOCKER_HOST', 'NODE_OPTIONS', 'HOME']);

export type ProxyRoute =
    | 'ping'
    | 'version'
    | 'services-list'
    | 'service-inspect'
    | 'service-create'
    | 'service-update'
    | 'service-delete'
    | 'tasks'
    | 'secrets-lookup'
    | 'secret-create'
    | 'secret-delete'
    | 'networks-list'
    | 'network-inspect'
    | 'network-create'
    | 'network-delete'
    | 'image-pull'
    | 'volume-delete';

export interface ProxyMatch {
    route: ProxyRoute;
    id?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Decode the path, and refuse traversal, a second scheme, or a double encoding. */
export function normalizeDockerPath(url: string): { path: string; query: URLSearchParams } | undefined {
    const cut = url.indexOf('?');
    const raw = cut === -1 ? url : url.slice(0, cut);
    if (!raw.startsWith('/') || raw.includes('\\') || raw.includes('\0')) {
        return undefined;
    }
    let path: string;
    try {
        path = decodeURIComponent(raw);
    } catch {
        return undefined;
    }
    if (
        !path.startsWith('/') ||
        path.includes('\\') ||
        path.includes('//') ||
        path.includes('\0') ||
        path.includes('%')
    ) {
        return undefined;
    }
    if (path.split('/').some((part) => part === '..' || part === '.')) {
        return undefined;
    }
    return {
        path,
        query: new URLSearchParams(cut === -1 ? '' : url.slice(cut + 1)),
    };
}

export function matchProxyRoute(method: string, path: string): ProxyMatch | undefined {
    if (method === 'GET' && path === '/_ping') {
        return { route: 'ping' };
    }
    if (method === 'GET' && path === `${API}/version`) {
        return { route: 'version' };
    }
    if (method === 'GET' && path === `${API}/services`) {
        return { route: 'services-list' };
    }
    if (method === 'GET' && path === `${API}/tasks`) {
        return { route: 'tasks' };
    }
    if (method === 'GET' && path === `${API}/secrets`) {
        return { route: 'secrets-lookup' };
    }
    if (method === 'GET' && path === `${API}/networks`) {
        return { route: 'networks-list' };
    }
    if (method === 'POST' && path === `${API}/services/create`) {
        return { route: 'service-create' };
    }
    if (method === 'POST' && path === `${API}/networks/create`) {
        return { route: 'network-create' };
    }
    if (method === 'POST' && path === `${API}/images/create`) {
        return { route: 'image-pull' };
    }
    if (method === 'POST' && path === `${API}/secrets/create`) {
        return { route: 'secret-create' };
    }
    const secret = new RegExp(`^${API}/secrets/([^/]+)$`).exec(path);
    if (method === 'DELETE' && secret && SECRET_ID.test(secret[1]!)) {
        return { route: 'secret-delete', id: secret[1] };
    }
    const service = new RegExp(`^${API}/services/([^/]+)$`).exec(path);
    if (service && ID.test(service[1]!)) {
        if (method === 'GET') {
            return { route: 'service-inspect', id: service[1] };
        }
        if (method === 'DELETE') {
            return { route: 'service-delete', id: service[1] };
        }
    }
    const update = new RegExp(`^${API}/services/([^/]+)/update$`).exec(path);
    if (method === 'POST' && update && ID.test(update[1]!)) {
        return { route: 'service-update', id: update[1] };
    }
    const network = new RegExp(`^${API}/networks/([^/]+)$`).exec(path);
    if (network && ID.test(network[1]!)) {
        if (method === 'GET') {
            return { route: 'network-inspect', id: network[1] };
        }
        if (method === 'DELETE') {
            return { route: 'network-delete', id: network[1] };
        }
    }
    const volume = new RegExp(`^${API}/volumes/([^/]+)$`).exec(path);
    if (method === 'DELETE' && volume && pluginVolumeNameShaped(volume[1]!)) {
        return { route: 'volume-delete', id: volume[1] };
    }
    return undefined;
}

/**
 * The ServiceSpec inside a GET Service (`{ Spec, Version }`). A create or
 * update body is the spec itself: `Spec` is not a ServiceSpec field, and
 * unwrapping it is how a second object gets applied by the engine.
 */
export function serviceSpecOf(body: unknown): Record<string, unknown> | undefined {
    const row = asRecord(body);
    if (!row) {
        return undefined;
    }
    if (typeof row.Name === 'string') {
        return row;
    }
    const spec = asRecord(row.Spec);
    if (spec && typeof spec.Name === 'string') {
        return spec;
    }
    return undefined;
}

/** Identity of a ServiceSpec. Does not unwrap `.Spec`. */
export function pluginIdentity(spec: unknown): { id: string; name: string } | undefined {
    const row = asRecord(spec);
    const name = typeof row?.Name === 'string' ? row.Name : '';
    const match = pluginServiceNamePattern().exec(name);
    const labels = asRecord(row?.Labels);
    if (
        !match ||
        !PLUGIN_ID.test(match[1]!) ||
        labels?.['socio.managed'] !== 'plugin' ||
        labels?.['socio.plugin'] !== match[1]
    ) {
        return undefined;
    }
    return { id: match[1]!, name };
}

export interface PluginNetworkInfo {
    name: string;
    driver: string;
    internal: boolean;
}

export interface ProxyPolicy {
    pins: ReadonlyMap<string, string>;
    /** `SOCKET_PROXY_PLUGIN_CONSTRAINTS`, canonical. Empty or unset: no `Placement` allowed. */
    constraints?: readonly string[];
    /** Swarm service names whose update may only add or remove plugin networks. */
    infra: ReadonlySet<string>;
    network: (target: string) => PluginNetworkInfo | undefined;
    /** Secret names a service body may reference. The lookup route uses the same set. */
    secretNames: ReadonlySet<string>;
    /**
     * Allowlisted secret name → the id the engine returned for that exact
     * name. When set, a `SecretID` that is not this id is refused.
     */
    secretIds?: ReadonlyMap<string, string>;
    /**
     * Every Swarm service's named volumes when the request came in. The
     * proxy always sets it; unset only in unit checks of a single body.
     */
    volumeClaims?: readonly VolumeClaim[];
}

export interface VolumeClaim {
    /** Swarm service name. */
    service: string;
    /** The plugin id this deployment's naming reads from the service name, if any. */
    plugin?: string;
    /** Sources of its `volume` mounts. */
    volumes: readonly string[];
}

/** ASCII A–Z only, matching the case-fold the review requires. */
function asciiFold(key: string) {
    return key.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

/**
 * Engine struct fields. A key whose fold equals one of these but whose
 * spelling differs is a collision: Go's encoding/json would apply it.
 */
const ENGINE_FIELDS = [
    'Name',
    'Labels',
    'TaskTemplate',
    'Mode',
    'EndpointSpec',
    'Spec',
    'ContainerSpec',
    'Resources',
    'RestartPolicy',
    'Networks',
    'Runtime',
    'Image',
    'Env',
    'User',
    'ReadOnly',
    'Mounts',
    'Healthcheck',
    'Secrets',
    'CapabilityDrop',
    'Privileges',
    'StopGracePeriod',
    'Init',
    'Command',
    'Args',
    'Dir',
    'Hostname',
    'Hosts',
    'DNSConfig',
    'Privileged',
    'CapAdd',
    'CapabilityAdd',
    'Devices',
    'PidMode',
    'IpcMode',
    'Sysctls',
    'Isolation',
    'Configs',
    'Ulimits',
    'OpenStdin',
    'TTY',
    'NoNewPrivileges',
    'CredentialSpec',
    'SELinuxContext',
    'Seccomp',
    'AppArmor',
    'Limits',
    'Reservations',
    'NanoCPUs',
    'MemoryBytes',
    'Pids',
    'Condition',
    'Delay',
    'MaxAttempts',
    'Window',
    'Target',
    'Aliases',
    'Replicated',
    'Global',
    'Replicas',
    'Ports',
    'UpdateConfig',
    'RollbackConfig',
    'ForceUpdate',
    'Placement',
    'Constraints',
    'Preferences',
    'MaxReplicas',
    'Platforms',
    'LogDriver',
    'Type',
    'Source',
    'BindOptions',
    'VolumeOptions',
    'TmpfsOptions',
    'Consistency',
    'SizeBytes',
    'Options',
    'DriverConfig',
    'NoCopy',
    'Propagation',
    'SecretID',
    'SecretName',
    'File',
    'UID',
    'GID',
    'Test',
    'Interval',
    'Timeout',
    'Retries',
    'StartPeriod',
    'Version',
    'PreviousSpec',
    'Data',
    'Driver',
    'Templating',
] as const;

const ENGINE_BY_FOLD = new Map<string, string>();
for (const name of ENGINE_FIELDS) {
    const fold = asciiFold(name);
    if (!ENGINE_BY_FOLD.has(fold)) {
        ENGINE_BY_FOLD.set(fold, name);
    }
}

/** Maps, not structs. Keys are case-sensitive in Go. */
const MAP_FIELDS = new Set(['Labels', 'Options', 'Env']);

/**
 * Reject a key that folds onto a sibling or onto a known engine field
 * spelled differently. When `allowed` is set, any other key is refused.
 */
function keyErrors(row: Record<string, unknown>, allowed: readonly string[] | undefined, where: string) {
    const errors: string[] = [];
    const seen = new Map<string, string>();
    for (const key of Object.keys(row)) {
        const fold = asciiFold(key);
        const prior = seen.get(fold);
        if (prior) {
            errors.push(`Key ${key} collides with ${prior}.`);
            continue;
        }
        seen.set(fold, key);
        const known = ENGINE_BY_FOLD.get(fold);
        if (known && known !== key) {
            errors.push(`Key ${key} collides with ${known}.`);
            continue;
        }
        if (allowed && !allowed.includes(key)) {
            errors.push(`${where} field ${key} is not allowed.`);
        }
    }
    return errors;
}

function siblingFoldErrors(row: Record<string, unknown>) {
    const errors: string[] = [];
    const seen = new Map<string, string>();
    for (const key of Object.keys(row)) {
        const fold = asciiFold(key);
        const prior = seen.get(fold);
        if (prior) {
            errors.push(`Key ${key} collides with ${prior}.`);
        } else {
            seen.set(fold, key);
        }
    }
    return errors;
}

/** Case-fold collisions through a request object. Map fields stay maps. */
function caseFoldTree(value: unknown, inMap = false): string[] {
    if (Array.isArray(value)) {
        return value.flatMap((item) => caseFoldTree(item, inMap));
    }
    const row = asRecord(value);
    if (!row) {
        return [];
    }
    const errors = inMap ? siblingFoldErrors(row) : keyErrors(row, undefined, 'field');
    for (const [key, child] of Object.entries(row)) {
        errors.push(...caseFoldTree(child, inMap || MAP_FIELDS.has(key)));
    }
    return errors;
}

/**
 * Why a service create or a plugin service update must not be forwarded.
 * Empty means the body is a locked-down plugin service.
 */
export function pluginServiceErrors(body: unknown, policy: ProxyPolicy) {
    const errors: string[] = [];
    const spec = asRecord(body);
    if (!spec) {
        return ['The service body must be an object.'];
    }
    const extra = keyErrors(spec, ['Name', 'Labels', 'TaskTemplate', 'Mode', 'EndpointSpec'], 'Service');
    if (extra.length) {
        return extra;
    }
    const who = pluginIdentity(spec);
    if (!who) {
        return [
            `The service name must be ${pluginNamePrefix()}-<id> and the labels must say Socio manages that plugin.`,
        ];
    }
    const labels = asRecord(spec.Labels) ?? {};
    const port = labels['socio.plugin.port'];
    if (typeof port !== 'string' || !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) {
        errors.push('socio.plugin.port must be the container port.');
    }
    const identity = labels['socio.identity'];
    if (identity !== undefined && (typeof identity !== 'string' || !/^[1-9]\d{0,8}$/.test(identity))) {
        errors.push('socio.identity must be the identity version.');
    }
    const revision = labels['socio.plugin.revision'];
    if (revision !== undefined && (typeof revision !== 'string' || !PLUGIN_REVISION.test(revision))) {
        errors.push('socio.plugin.revision must be the install revision, 64 lowercase hex digits.');
    }
    const registry = labels['socio.registry'];
    if (registry !== undefined && (typeof registry !== 'string' || !/^[a-f0-9]{32}$/.test(registry))) {
        errors.push('socio.registry must be the registry login fingerprint, 32 lowercase hex digits.');
    }
    const template = asRecord(spec.TaskTemplate);
    if (!template) {
        return [...errors, 'TaskTemplate is required.'];
    }
    const templateExtra = keyErrors(
        template,
        ['ContainerSpec', 'Resources', 'RestartPolicy', 'Networks', 'Runtime', 'Placement'],
        'TaskTemplate',
    );
    if (templateExtra.length) {
        errors.push(`TaskTemplate field ${templateExtra[0]} is not allowed.`);
    }
    if (template.Runtime !== undefined && template.Runtime !== 'container') {
        errors.push('A custom container runtime is not allowed.');
    }
    errors.push(...containerErrors(template.ContainerSpec, who.id, policy, Number(port)));
    errors.push(...resourceErrors(template.Resources));
    errors.push(...restartErrors(template.RestartPolicy));
    errors.push(...networkErrors(template.Networks, who.id, policy));
    errors.push(...placementErrors(template, policy.constraints ?? []));
    const mode = asRecord(spec.Mode);
    const replicated = asRecord(mode?.Replicated);
    const replicas = replicated?.Replicas;
    if (
        !mode ||
        keyErrors(mode, ['Replicated'], 'Mode').length ||
        !replicated ||
        keyErrors(replicated, ['Replicas'], 'Mode').length ||
        typeof replicas !== 'number' ||
        !Number.isInteger(replicas) ||
        replicas < 0 ||
        replicas > PLUGIN_REPLICA_CAP
    ) {
        errors.push(`Replicas must be an integer from 0 to ${PLUGIN_REPLICA_CAP}. Global mode is not allowed.`);
    }
    const endpoint = asRecord(spec.EndpointSpec);
    const ports = endpoint?.Ports;
    if (
        !endpoint ||
        keyErrors(endpoint, ['Mode'], 'EndpointSpec').length ||
        endpoint.Mode !== 'dnsrr' ||
        (Array.isArray(ports) && ports.length > 0)
    ) {
        errors.push('The endpoint mode must be dnsrr, with no published ports.');
    }
    return errors;
}

/**
 * `Placement` is exactly `{ Constraints: <the operator's list> }` (any order,
 * no repeats) when `SOCKET_PROXY_PLUGIN_CONSTRAINTS` is set, and absent when
 * it is not. Preferences, MaxReplicas, and Platforms are never allowed.
 */
function placementErrors(template: Record<string, unknown>, constraints: readonly string[]) {
    if (!('Placement' in template)) {
        return constraints.length
            ? [`Placement must be the constraints in SOCKET_PROXY_PLUGIN_CONSTRAINTS: ${constraints.join(', ')}.`]
            : [];
    }
    if (!constraints.length) {
        return ['Placement is not allowed: SOCKET_PROXY_PLUGIN_CONSTRAINTS is not set.'];
    }
    const wrong = [`Placement must be exactly { Constraints: [${constraints.join(', ')}] }.`];
    const placement = asRecord(template.Placement);
    if (!placement || keyErrors(placement, ['Constraints'], 'Placement').length) {
        return wrong;
    }
    const given = placement.Constraints;
    if (
        !Array.isArray(given) ||
        given.length !== constraints.length ||
        new Set(given).size !== given.length ||
        !given.every((item) => typeof item === 'string' && constraints.includes(item))
    ) {
        return wrong;
    }
    return [];
}

function containerErrors(value: unknown, pluginId: string, policy: ProxyPolicy, port: number) {
    const errors: string[] = [];
    const spec = asRecord(value);
    if (!spec) {
        return ['ContainerSpec is required.'];
    }
    const extra = keyErrors(
        spec,
        [
            'Image',
            'Env',
            'User',
            'ReadOnly',
            'Mounts',
            'Healthcheck',
            'Secrets',
            'CapabilityDrop',
            'Privileges',
            'Labels',
            'StopGracePeriod',
            'Init',
        ],
        'ContainerSpec',
    );
    if (extra.length) {
        errors.push(`${extra[0]} Privileged, CapAdd, devices, host PID or IPC, and bind mounts are refused.`);
    }
    const image = spec.Image;
    const expected = policy.pins.get(pluginId);
    if (typeof image !== 'string' || !PINNED_IMAGE.test(image)) {
        errors.push('The image must be name@sha256:<64 hex digits>.');
    } else if (!expected || image !== expected) {
        errors.push('The image is not the digest pinned for this plugin.');
    }
    if (spec.User !== '1000:1000') {
        errors.push('The container user must be 1000:1000.');
    }
    // The container's labels, when set, only say which plugin it is (CB-321):
    // the deployment's stats proxy selects containers by label.
    if (spec.Labels !== undefined) {
        const labels = asRecord(spec.Labels);
        if (
            !labels ||
            Object.keys(labels).length !== 2 ||
            labels['socio.managed'] !== 'plugin' ||
            labels['socio.plugin'] !== pluginId
        ) {
            errors.push(`ContainerSpec.Labels must be exactly socio.managed=plugin and socio.plugin=${pluginId}.`);
        }
    }
    if (spec.ReadOnly !== true) {
        errors.push('The root filesystem must be read-only.');
    }
    const drop = spec.CapabilityDrop;
    if (!Array.isArray(drop) || drop.length !== 1 || drop[0] !== 'ALL') {
        errors.push('CapabilityDrop must be exactly ["ALL"].');
    }
    const privileges = asRecord(spec.Privileges);
    if (
        !privileges ||
        keyErrors(privileges, ['NoNewPrivileges'], 'Privileges').length ||
        privileges.NoNewPrivileges !== true
    ) {
        errors.push('Privileges must be { NoNewPrivileges: true } and nothing else.');
    }
    if (spec.Env !== undefined) {
        errors.push(...envErrors(spec.Env));
    }
    if (!Array.isArray(spec.Mounts)) {
        errors.push('Mounts must be a list.');
    } else {
        for (const mount of spec.Mounts) {
            errors.push(...mountErrors(mount, pluginId, policy.volumeClaims));
        }
        const tmpfs = spec.Mounts.some((mount) => {
            const row = asRecord(mount);
            return row?.Type === 'tmpfs' && row.Target === '/tmp';
        });
        if (!tmpfs) {
            errors.push('Mounts must include a tmpfs at /tmp.');
        }
    }
    if (spec.Secrets !== undefined) {
        errors.push(...secretErrors(spec.Secrets, pluginId, policy.secretNames, policy.secretIds));
    }
    if (spec.Healthcheck !== undefined) {
        errors.push(...healthErrors(spec.Healthcheck, port));
    }
    return errors;
}

function envErrors(value: unknown) {
    if (!Array.isArray(value)) {
        return ['Env must be a list of KEY=value.'];
    }
    const errors: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string' || item.length > 4100) {
            errors.push('An env entry is not a short string.');
            continue;
        }
        const eq = item.indexOf('=');
        const key = eq < 0 ? item : item.slice(0, eq);
        if (key === 'HOME') {
            if (item !== 'HOME=/tmp') {
                errors.push('Env HOME is not allowed.');
            }
            continue;
        }
        if (BANNED_ENV.has(key) || key.includes('\n') || item.includes('\0')) {
            errors.push(`Env ${key} is not allowed.`);
        }
    }
    return errors;
}

function mountErrors(value: unknown, pluginId: string, claims: readonly VolumeClaim[] | undefined) {
    const mount = asRecord(value);
    if (!mount) {
        return ['A mount must be an object.'];
    }
    const type = mount.Type;
    if (type === 'tmpfs') {
        const keys = keyErrors(mount, ['Type', 'Target', 'TmpfsOptions'], 'Mount');
        if (keys.length) {
            return keys;
        }
        if (mount.Target !== '/tmp' && mount.Target !== '/var/tmp') {
            return ['tmpfs is only allowed at /tmp or /var/tmp.'];
        }
        if (mount.TmpfsOptions !== undefined) {
            const options = asRecord(mount.TmpfsOptions);
            const size = options?.SizeBytes;
            const extra = options
                ? keyErrors(options, ['SizeBytes', 'Mode'], 'TmpfsOptions')
                : ['tmpfs options must be a size up to 256 MB and a mode.'];
            if (extra.length || typeof size !== 'number' || size < 1 || size > 256 * 1048576) {
                return extra.length ? extra : ['tmpfs options must be a size up to 256 MB and a mode.'];
            }
        }
        return [];
    }
    if (type === 'bind' || type === 'npipe') {
        return ['Bind mounts are not allowed.'];
    }
    if (type !== 'volume') {
        return [`Mount type ${String(type)} is not allowed.`];
    }
    const keys = keyErrors(mount, ['Type', 'Source', 'Target', 'VolumeOptions'], 'Mount');
    if (keys.length) {
        return keys;
    }
    const source = typeof mount.Source === 'string' ? mount.Source : '';
    const prefix = pluginVolumePrefix(pluginId);
    if (!source.startsWith(prefix) || !PLUGIN_VOLUME_NAME.test(source.slice(prefix.length))) {
        return [`A volume must be a named volume for this plugin, ${prefix}<volume>, not a host path.`];
    }
    const owner = volumeOwner(source, pluginId, claims);
    if (owner) {
        return [`Volume ${source} belongs to ${owner}, not to plugin ${pluginId}.`];
    }
    if (mount.VolumeOptions !== undefined) {
        const volume = asRecord(mount.VolumeOptions);
        if (!volume) {
            return ['Volume driver options are not allowed. They can bind a host path.'];
        }
        const volumeKeys = keyErrors(volume, ['DriverConfig'], 'VolumeOptions');
        if (volumeKeys.length) {
            return volumeKeys;
        }
        const driver = asRecord(volume.DriverConfig);
        if (driver) {
            if (Object.keys(driver).some((key) => asciiFold(key) === 'options')) {
                return ['Volume driver options are not allowed. They can bind a host path.'];
            }
            const driverKeys = keyErrors(driver, ['Name'], 'DriverConfig');
            if (driverKeys.length) {
                return driverKeys;
            }
        }
    }
    const target = typeof mount.Target === 'string' ? mount.Target : '';
    if (!target.startsWith('/') || target.includes('..')) {
        return ['A volume target must be an absolute path inside the container.'];
    }
    return [];
}

/**
 * Who else owns a volume name in this plugin's namespace. Volume names may
 * contain dashes, so `<prefix>-foo-bar-data` is both plugin `foo`'s volume
 * `bar-data` and plugin `foo-bar`'s volume `data`: a prefix match would let
 * `foo` mount `foo-bar`'s data. The name belongs to another service when
 * that service mounts it, or when an installed plugin whose id extends this
 * one's with `-` (`foo-bar` for `foo`) has it in its own namespace. A
 * shorter id reserves nothing: `foo` installed does not stop `foo-bar`
 * mounting its own `data`, only a volume `foo` already mounts. Undefined:
 * the plugin may mount it.
 */
function volumeOwner(source: string, pluginId: string, claims: readonly VolumeClaim[] | undefined) {
    const own = pluginServiceName(pluginId);
    for (const claim of claims ?? []) {
        if (claim.service === own) {
            continue;
        }
        if (claim.volumes.includes(source)) {
            return `service ${claim.service}`;
        }
        if (
            claim.plugin?.startsWith(`${pluginId}-`) &&
            source.startsWith(pluginVolumePrefix(claim.plugin)) &&
            PLUGIN_VOLUME_NAME.test(source.slice(pluginVolumePrefix(claim.plugin).length))
        ) {
            return `plugin ${claim.plugin}`;
        }
    }
    return undefined;
}

/** A Swarm volume name some plugin's naming scheme can produce: `<prefix>-<id>-<volume>`. */
export function pluginVolumeNameShaped(name: string) {
    const head = `${pluginNamePrefix()}-`;
    if (!name.startsWith(head)) {
        return false;
    }
    const rest = name.slice(head.length);
    for (let cut = rest.indexOf('-'); cut > 0; cut = rest.indexOf('-', cut + 1)) {
        if (PLUGIN_ID.test(rest.slice(0, cut)) && PLUGIN_VOLUME_NAME.test(rest.slice(cut + 1))) {
            return true;
        }
    }
    return false;
}

/** Named volume sources among a ContainerSpec's mounts. */
function volumeSourcesOf(container: unknown) {
    const mounts = asRecord(container)?.Mounts;
    return (Array.isArray(mounts) ? mounts : []).flatMap((mount) => {
        const row = asRecord(mount);
        return row?.Type === 'volume' && typeof row.Source === 'string' ? [row.Source] : [];
    });
}

/** Task states after which a task no longer holds its mounts. */
const TERMINAL_TASK_STATES = new Set(['complete', 'failed', 'shutdown', 'rejected', 'orphaned', 'remove']);

/**
 * Every Swarm service's named volumes, read from the engine for the
 * request being checked. `plugin` is the id this deployment's naming reads
 * from the service name, whatever its labels say, so another deployment's
 * service under an overlapping prefix still claims its namespace.
 *
 * A service claims the volumes of its current spec, of `PreviousSpec` (a
 * rolling update or rollback may still run it), and of every task of it
 * that has not reached a terminal state: an update that drops a mount is
 * accepted before the old tasks holding it shut down. A live task whose
 * service is not listed claims its volumes under its own id.
 */
export function volumeClaimsOf(list: unknown, tasks?: unknown): VolumeClaim[] | undefined {
    if (!Array.isArray(list)) {
        return undefined;
    }
    const pattern = pluginServiceNamePattern();
    const byId = new Map<string, Set<string>>();
    const claims = list.flatMap((item) => {
        const spec = serviceSpecOf(item);
        const service = typeof spec?.Name === 'string' ? spec.Name : '';
        if (!service) {
            return [];
        }
        const row = asRecord(item);
        const previous = asRecord(row?.PreviousSpec);
        const volumes = new Set([
            ...volumeSourcesOf(asRecord(spec?.TaskTemplate)?.ContainerSpec),
            ...volumeSourcesOf(asRecord(previous?.TaskTemplate)?.ContainerSpec),
        ]);
        const id = row?.ID ?? row?.Id;
        if (typeof id === 'string' && id) {
            byId.set(id, volumes);
        }
        const match = pattern.exec(service);
        return [{ service, ...(match && PLUGIN_ID.test(match[1]!) ? { plugin: match[1]! } : {}), volumes }];
    });
    const orphans: VolumeClaim[] = [];
    for (const item of Array.isArray(tasks) ? tasks : []) {
        const task = asRecord(item);
        const state = asRecord(task?.Status)?.State;
        if (typeof state === 'string' && TERMINAL_TASK_STATES.has(state)) {
            continue;
        }
        const sources = volumeSourcesOf(asRecord(asRecord(task?.Spec)?.ContainerSpec));
        if (!sources.length) {
            continue;
        }
        const owner = typeof task?.ServiceID === 'string' ? byId.get(task.ServiceID) : undefined;
        if (owner) {
            sources.forEach((source) => owner.add(source));
        } else {
            orphans.push({ service: `task ${typeof task?.ID === 'string' ? task.ID : '?'}`, volumes: sources });
        }
    }
    return [...claims.map((claim) => ({ ...claim, volumes: [...claim.volumes] })), ...orphans];
}

const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SECRET_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** A name the lookup and a service body may use: an allowlisted one, or any plugin identity secret of this deployment. */
function lookupAllowed(name: string, allow: ReadonlySet<string>) {
    return SECRET_NAME.test(name) && (allow.has(name) || parseIdentitySecretName(name) !== undefined);
}

function secretErrors(
    value: unknown,
    pluginId: string,
    allow: ReadonlySet<string>,
    ids: ReadonlyMap<string, string> | undefined,
) {
    if (!Array.isArray(value)) {
        return ['Secrets must be a list.'];
    }
    const errors: string[] = [];
    let identities = 0;
    for (const item of value) {
        const secret = asRecord(item);
        if (!secret) {
            errors.push('malformed secret reference');
            continue;
        }
        const keys = keyErrors(secret, ['SecretID', 'SecretName', 'File'], 'Secret');
        if (keys.length) {
            errors.push(keys[0]!);
            continue;
        }
        const file = asRecord(secret.File);
        const id = secret.SecretID;
        const name = secret.SecretName;
        if (typeof id !== 'string' || !SECRET_ID.test(id) || typeof name !== 'string' || !SECRET_NAME.test(name)) {
            errors.push('malformed secret reference');
            continue;
        }
        const identity = parseIdentitySecretName(name);
        if (identity) {
            // Only its own identity, at the fixed file, once, by the engine's id.
            identities++;
            if (identity.pluginId !== pluginId) {
                errors.push(`Secret ${name} is another plugin's identity.`);
            } else if (file?.Name !== SWARM_IDENTITY_FILE) {
                errors.push(`A plugin identity is mounted as ${SWARM_IDENTITY_FILE}.`);
            } else if (identities > 1) {
                errors.push('A plugin service mounts one identity.');
            } else if (!ids || ids.get(name) !== id) {
                errors.push(`SecretID does not match the id of ${name}.`);
            }
        } else if (!allow.has(name)) {
            errors.push(`Secret ${name} is not an allowlisted secret name.`);
        } else if (ids && ids.get(name) !== id) {
            errors.push(`SecretID does not match the id of ${name}.`);
        }
        const fileKeys = file
            ? keyErrors(file, ['Name', 'UID', 'GID', 'Mode'], 'Secret file')
            : ['A secret file must be mode 0400 and uid 1000.'];
        if (fileKeys.length || !file || file.UID !== '1000' || file.GID !== '1000' || file.Mode !== 0o400) {
            errors.push(fileKeys[0] ?? 'A secret file must be mode 0400 and uid 1000.');
        }
    }
    return errors;
}

/**
 * The only secrets call the proxy forwards: `GET /v1.44/secrets?filters=`
 * with exactly `{ names: { <one allowlisted name>: true } }`. `names` is
 * an exact match. `name` is a prefix and is refused.
 */
export function secretLookupName(query: URLSearchParams, allow: ReadonlySet<string>) {
    if ([...query.keys()].some((key) => key !== 'filters')) {
        return undefined;
    }
    const raw = query.get('filters');
    if (!raw || query.getAll('filters').length !== 1) {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch {
        return undefined;
    }
    const filters = asRecord(parsed);
    if (!filters || Object.keys(filters).length !== 1) {
        return undefined;
    }
    const names = asRecord(filters.names);
    if (!names || Object.keys(names).length !== 1) {
        return undefined;
    }
    const [name, flag] = Object.entries(names)[0]!;
    if (flag !== true || !lookupAllowed(name, allow)) {
        return undefined;
    }
    return name;
}

/** At most this much base64 for an identity token (it is 48 characters today). */
const IDENTITY_DATA_MAX = 1024;

/**
 * Why a secret create must not be forwarded. Empty means it is a plugin
 * identity secret of this deployment: `{ Name, Labels, Data }` and nothing
 * else (no driver, no templating), the name `<prefix>-wl-<id>-v<n>`, the
 * labels exactly `socio.managed=plugin` and `socio.plugin=<id>`.
 */
export function identitySecretCreateErrors(body: unknown) {
    const spec = asRecord(body);
    if (!spec) {
        return ['A secret create needs an object body.'];
    }
    const folded = caseFoldTree(spec);
    if (folded.length) {
        return folded;
    }
    const extra = keyErrors(spec, ['Name', 'Labels', 'Data'], 'Secret');
    if (extra.length) {
        return [`${extra[0]} Only a name, the plugin's labels and the data are allowed.`];
    }
    const name = typeof spec.Name === 'string' ? spec.Name : '';
    const identity = parseIdentitySecretName(name);
    if (!identity || !SECRET_NAME.test(name)) {
        return [`Only a plugin identity secret, ${pluginNamePrefix()}-wl-<id>-v<n>, can be created.`];
    }
    const labels = asRecord(spec.Labels);
    const expected: Record<string, string> = identitySecretLabels(identity.pluginId);
    if (
        !labels ||
        Object.keys(labels).length !== Object.keys(expected).length ||
        Object.entries(expected).some(([key, label]) => labels[key] !== label)
    ) {
        return [`The secret's labels must be exactly socio.managed=plugin and socio.plugin=${identity.pluginId}.`];
    }
    const data = spec.Data;
    if (
        typeof data !== 'string' ||
        !data ||
        data.length > IDENTITY_DATA_MAX ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(data) ||
        Buffer.from(data, 'base64').toString('base64') !== data
    ) {
        return ['The secret data must be base64.'];
    }
    return [];
}

/** Whether an engine's secret (from `GET /secrets/{id}`) is a plugin identity secret the proxy may delete. */
export function identitySecretDeletable(value: unknown, id: string) {
    const row = asRecord(value);
    const spec = asRecord(row?.Spec);
    const name = typeof spec?.Name === 'string' ? spec.Name : '';
    const identity = parseIdentitySecretName(name);
    const labels = asRecord(spec?.Labels);
    if (!row || row.ID !== id || !identity || !labels) {
        return false;
    }
    const expected: Record<string, string> = identitySecretLabels(identity.pluginId);
    return Object.entries(expected).every(([key, label]) => labels[key] === label);
}

/** `SOCKET_PROXY_SECRET_NAMES`: comma-separated Swarm secret names. */
export function parseSecretNames(raw: string | undefined) {
    const names = new Set<string>();
    const text = raw?.trim();
    if (!text) {
        return names;
    }
    for (const item of text.split(',')) {
        const name = item.trim();
        if (!SECRET_NAME.test(name)) {
            throw new Error('SOCKET_PROXY_SECRET_NAMES entries are Swarm secret names (letters, digits, . _ -).');
        }
        names.add(name);
    }
    return names;
}

const HEALTH_REFUSAL = 'A healthcheck must be the runtime fetch check, with no shell and no extra arguments.';

function healthErrors(value: unknown, port: number) {
    const health = asRecord(value);
    if (!health) {
        return ['Healthcheck must be an object.'];
    }
    const keys = keyErrors(health, ['Test', 'Interval', 'Timeout', 'Retries', 'StartPeriod'], 'Healthcheck');
    if (keys.length) {
        return keys;
    }
    const test = health.Test;
    if (!Array.isArray(test) || test.some((part) => typeof part !== 'string')) {
        return [HEALTH_REFUSAL];
    }
    const prefix = `fetch('http://127.0.0.1:'+(process.env.PORT||${port})+'`;
    const suffix = "').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))";
    const script = test[3];
    if (
        test.length !== 4 ||
        test[0] !== 'CMD' ||
        test[1] !== 'node' ||
        test[2] !== '-e' ||
        typeof script !== 'string' ||
        !script.startsWith(prefix) ||
        !script.endsWith(suffix)
    ) {
        return [HEALTH_REFUSAL];
    }
    const path = script.slice(prefix.length, script.length - suffix.length);
    if (
        !path.startsWith('/') ||
        path.includes('..') ||
        !/^\/[A-Za-z0-9._/-]+$/.test(path) ||
        pluginHealthTest(port, path)[3] !== script
    ) {
        return [HEALTH_REFUSAL];
    }
    return [];
}

function resourceErrors(value: unknown) {
    const resources = asRecord(value);
    const limits = asRecord(resources?.Limits);
    const cpus = limits?.NanoCPUs;
    const memory = limits?.MemoryBytes;
    if (
        !resources ||
        keyErrors(resources, ['Limits'], 'Resources').length ||
        !limits ||
        keyErrors(limits, ['NanoCPUs', 'MemoryBytes', 'Pids'], 'Limits').length ||
        typeof cpus !== 'number' ||
        cpus < 1e8 ||
        cpus > 8e9 ||
        typeof memory !== 'number' ||
        memory < 16 * 1048576 ||
        memory > 8192 * 1048576
    ) {
        return ['CPU and memory limits are required (0.1–8 CPUs, 16–8192 MB).'];
    }
    const pids = limits.Pids;
    if (typeof pids !== 'number' || !Number.isInteger(pids) || pids < 1 || pids > PLUGIN_PIDS_CAP) {
        return [
            `A process limit is required (Limits.Pids, 1–${PLUGIN_PIDS_CAP}), so a task cannot exhaust the host's process table.`,
        ];
    }
    return [];
}

function restartErrors(value: unknown) {
    const policy = asRecord(value);
    if (!policy) {
        return ['RestartPolicy.Condition must be any, on-failure, or none.'];
    }
    const keys = keyErrors(policy, ['Condition'], 'RestartPolicy');
    if (keys.length) {
        return keys;
    }
    if (!['any', 'on-failure', 'none'].includes(String(policy.Condition))) {
        return ['RestartPolicy.Condition must be any, on-failure, or none.'];
    }
    return [];
}

function networkErrors(value: unknown, pluginId: string, policy: ProxyPolicy) {
    if (!Array.isArray(value) || value.length !== 1) {
        return ['The service must join exactly its own plugin network.'];
    }
    const attachment = asRecord(value[0]);
    if (!attachment) {
        return ['The service must join exactly its own plugin network.'];
    }
    const attachmentKeys = keyErrors(attachment, ['Target'], 'Network');
    if (attachmentKeys.length) {
        return attachmentKeys;
    }
    const target = attachment.Target;
    if (typeof target !== 'string' || target === '' || target === 'host') {
        return ['The host network is not allowed.'];
    }
    const info = policy.network(target);
    if (!info || info.name !== pluginNetworkName(pluginId) || info.driver !== 'overlay' || info.internal !== true) {
        return [`The service network must be the internal overlay ${pluginNamePrefix()}-net-<id>.`];
    }
    return [];
}

/**
 * Whether an engine's network (from `GET /networks/{id}`) is a plugin network
 * the proxy may remove. The name alone is not enough: under an overlapping
 * prefix (`socio-plugin` and `socio-plugin-net`), another deployment's
 * `socio-plugin-net-net-foo` has this deployment's network shape. Its labels
 * say whose it is. A network from before labels were required has none.
 */
export function pluginNetworkDeletable(value: unknown) {
    const row = asRecord(value);
    const name = typeof row?.Name === 'string' ? row.Name : '';
    const match = pluginNetworkNamePattern().exec(name);
    if (!match || !PLUGIN_ID.test(match[1]!)) {
        return false;
    }
    const labels = asRecord(row?.Labels) ?? {};
    const managed = labels['socio.managed'];
    const plugin = labels['socio.plugin'];
    return (managed === undefined || managed === 'plugin') && (plugin === undefined || plugin === match[1]);
}

/** An internal overlay for one plugin. Anything else is refused. */
export function networkCreateErrors(body: unknown) {
    const spec = asRecord(body);
    if (!spec) {
        return ['A network create needs an object body.'];
    }
    const extra = keyErrors(
        spec,
        ['Name', 'Driver', 'Internal', 'Attachable', 'Ingress', 'Labels', 'CheckDuplicate'],
        'Network',
    );
    if (extra.length) {
        return [extra[0]!];
    }
    const name = typeof spec.Name === 'string' ? spec.Name : '';
    const match = pluginNetworkNamePattern().exec(name);
    const labels = asRecord(spec.Labels);
    if (
        !match ||
        spec.Driver !== 'overlay' ||
        spec.Internal !== true ||
        spec.Attachable === true ||
        spec.Ingress === true ||
        labels?.['socio.managed'] !== 'plugin' ||
        labels?.['socio.plugin'] !== match[1]
    ) {
        return [
            `A plugin network must be an internal overlay named ${pluginNamePrefix()}-net-<id>, not the host network.`,
        ];
    }
    return [];
}

function stable(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stable).join(',')}]`;
    }
    const row = asRecord(value);
    if (!row) {
        return JSON.stringify(value) ?? 'null';
    }
    return `{${Object.keys(row)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stable(row[key])}`)
        .join(',')}}`;
}

function withoutNetworks(spec: Record<string, unknown>) {
    const copy = structuredClone(spec);
    delete copy.Networks;
    const task = asRecord(copy.TaskTemplate);
    if (task) {
        delete task.Networks;
    }
    return copy;
}

function attachmentsOf(spec: Record<string, unknown>) {
    const top = Array.isArray(spec.Networks) ? spec.Networks : [];
    const nested = asRecord(spec.TaskTemplate)?.Networks;
    return [...top, ...(Array.isArray(nested) ? nested : [])];
}

/**
 * The attachments Swarm gives a service's tasks: `TaskTemplate.Networks`
 * when it has any, else the service-level `Networks`.
 */
function effectiveAttachments(spec: Record<string, unknown>): unknown[] {
    const nested = asRecord(spec.TaskTemplate)?.Networks;
    if (Array.isArray(nested) && nested.length) {
        return nested;
    }
    return Array.isArray(spec.Networks) ? spec.Networks : [];
}

function targetsOf(spec: Record<string, unknown>) {
    const ids = attachmentsOf(spec).map((item) => asRecord(item)?.Target);
    return [...new Set(ids.filter((item): item is string => typeof item === 'string'))];
}

/**
 * Each attachment of an infra update, by target. An attachment the service
 * already had must come back exactly as the engine returned it: `Aliases`
 * on an existing network is a DNS name other services resolve, so adding
 * one there would let the caller take traffic meant for another service.
 * A new attachment is `{ Target }`, with at most the aliases the service
 * already has on its other networks (a stack's short name such as `app`),
 * so it cannot introduce a name.
 */
function attachmentErrors(before: Record<string, unknown>, after: Record<string, unknown>) {
    const kept = new Map<string, string>();
    const known = new Set<string>();
    for (const item of attachmentsOf(before)) {
        const row = asRecord(item);
        const target = row?.Target;
        if (typeof target === 'string') {
            kept.set(target, stable(item));
        }
        if (Array.isArray(row?.Aliases)) {
            for (const alias of row.Aliases) {
                if (typeof alias === 'string') {
                    known.add(alias);
                }
            }
        }
    }
    const seen = new Set<string>();
    for (const item of attachmentsOf(after)) {
        const row = asRecord(item);
        const target = row?.Target;
        if (!row || typeof target !== 'string' || target === '') {
            return ['A network attachment must name its target.'];
        }
        if (seen.has(target)) {
            return ['A network is attached twice.'];
        }
        seen.add(target);
        const prior = kept.get(target);
        if (prior !== undefined) {
            if (prior !== stable(row)) {
                return ['An infra service update may not change an existing network attachment.'];
            }
        } else {
            if (keyErrors(row, ['Target', 'Aliases'], 'Network').length) {
                return ['A new plugin-network attachment is { Target, Aliases } only.'];
            }
            const aliases = row.Aliases;
            if (
                aliases !== undefined &&
                (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== 'string' || !known.has(alias)))
            ) {
                return ['A new plugin-network attachment may only repeat aliases the service already has.'];
            }
        }
    }
    return [];
}

const REDACTED_FIELDS = ['Env', 'Secrets', 'Configs'] as const;

/**
 * A body read back from this proxy may carry the revision digest it added
 * (CB-370); it is this proxy's own field, so the comparison leaves it out
 * (the forwarded spec is the engine's anyway, with only the networks taken).
 */
function withoutRevision(body: Record<string, unknown> | undefined) {
    const container = asRecord(asRecord(body?.TaskTemplate)?.ContainerSpec);
    if (!body || !container || !(REVISION_FIELD in container)) {
        return body;
    }
    const copy = structuredClone(body);
    delete asRecord(asRecord(copy.TaskTemplate)?.ContainerSpec)![REVISION_FIELD];
    return copy;
}

/**
 * The spec the runtime reads through this proxy: the engine's spec without
 * the container's environment, secrets and configs.
 */
function redactedSpec(spec: Record<string, unknown>) {
    const copy = structuredClone(spec);
    redactContainer(asRecord(asRecord(copy.TaskTemplate)?.ContainerSpec));
    return copy;
}

/**
 * An update of the apps service or the app service may only add or remove
 * `socio-plugin-net-*` networks. The runtime reads the service through this
 * proxy, so it never sees the container's environment, secrets or configs:
 * the body is compared with the redacted spec, and a body that carries any
 * of those fields is refused. Every other field must match. A bind mount or
 * privileged bit on that update is a field change and is refused.
 */
export function infraUpdateErrors(current: unknown, next: unknown, policy: ProxyPolicy) {
    const checked = infraUpdateSpec(current, next, policy);
    return 'errors' in checked ? checked.errors : [];
}

/**
 * The spec to forward for an infra update: the engine's full current spec
 * with only its network attachments replaced by the body's checked ones. The
 * body itself is never forwarded, so the environment, secrets and configs
 * the runtime cannot see stay as the engine has them.
 */
export function infraUpdateSpec(
    current: unknown,
    next: unknown,
    policy: ProxyPolicy,
): { errors: string[] } | { spec: Record<string, unknown> } {
    const errors = infraUpdateCheck(current, next, policy);
    if (errors.length) {
        return { errors };
    }
    const before = serviceSpecOf(current)!;
    const after = asRecord(next)!;
    // The service-level `Networks` was checked to be unchanged: the engine's
    // own value stays. Only `TaskTemplate.Networks` comes from the body.
    const spec = structuredClone(before);
    const task = asRecord(spec.TaskTemplate) ?? {};
    delete task.Networks;
    const wanted = asRecord(after.TaskTemplate)?.Networks;
    if (Array.isArray(wanted)) {
        task.Networks = structuredClone(wanted);
    }
    spec.TaskTemplate = task;
    return { spec };
}

function infraUpdateCheck(current: unknown, next: unknown, policy: ProxyPolicy) {
    const engineSpec = serviceSpecOf(current);
    const after = withoutRevision(asRecord(next));
    if (!engineSpec || !after) {
        return ['The service spec is missing.'];
    }
    const folded = caseFoldTree(after);
    if (folded.length) {
        return folded;
    }
    const name = typeof engineSpec.Name === 'string' ? engineSpec.Name : '';
    if (!policy.infra.has(name) || after.Name !== name) {
        return [`${name || 'That service'} is not a plugin and is not an infra service this proxy may update.`];
    }
    const container = asRecord(asRecord(after.TaskTemplate)?.ContainerSpec);
    if (container && REDACTED_FIELDS.some((field) => field in container)) {
        return ['An infra service update may not carry environment, secrets or configs.'];
    }
    const before = redactedSpec(engineSpec);
    if (stable(withoutNetworks(before)) !== stable(withoutNetworks(after))) {
        return ['An infra service update may only change plugin-network attachments.'];
    }
    // Swarm uses `TaskTemplate.Networks` when it is not empty and ignores the
    // service-level `Networks` then. Moving an attachment from one list to the
    // other would pass a check of both lists together and still detach it, so
    // the service-level list may not change, and the checks below compare the
    // lists Swarm actually uses.
    if (stable(before.Networks ?? []) !== stable(after.Networks ?? [])) {
        return ['An infra service update may only change TaskTemplate.Networks.'];
    }
    const effectiveBefore = { Networks: effectiveAttachments(before) };
    const effectiveAfter = { Networks: effectiveAttachments(after) };
    const attachments = attachmentErrors(effectiveBefore, effectiveAfter);
    if (attachments.length) {
        return attachments;
    }
    const kept = new Set(targetsOf(effectiveBefore));
    const wanted = new Set(targetsOf(effectiveAfter));
    const changed = [...[...wanted].filter((id) => !kept.has(id)), ...[...kept].filter((id) => !wanted.has(id))];
    const errors: string[] = [];
    for (const target of changed) {
        const info = policy.network(target);
        if (
            !info ||
            !pluginNetworkNamePattern().test(info.name) ||
            info.driver !== 'overlay' ||
            info.internal !== true
        ) {
            errors.push(`Only an internal ${pluginNamePrefix()}-net-<id> overlay can be attached or detached.`);
        }
    }
    for (const target of kept) {
        if (wanted.has(target)) {
            continue;
        }
        const info = policy.network(target);
        if (!info?.name.startsWith(`${pluginNamePrefix()}-net-`)) {
            errors.push('The service’s other networks must stay attached.');
        }
    }
    return errors;
}

export function imagePullError(query: URLSearchParams, pins: ReadonlyMap<string, string>, bodyLength: number) {
    if (bodyLength > 0) {
        return 'Loading an image from a request body is not allowed.';
    }
    const keys = [...query.keys()];
    if (keys.some((key) => key !== 'fromImage') || query.getAll('fromImage').length > 1) {
        return 'Only a digest pull (fromImage=name@sha256:…) is allowed.';
    }
    const from = query.get('fromImage') ?? '';
    if (!PINNED_IMAGE.test(from) || ![...pins.values()].includes(from)) {
        return 'fromImage must be a digest in SOCKET_PROXY_IMAGE_PINS.';
    }
    return undefined;
}

const CONSTRAINT_KEY =
    /^(?:node\.(?:id|hostname|role|platform\.os|platform\.arch)|(?:node|engine)\.labels\.[A-Za-z0-9_.-]+)$/;
const CONSTRAINT_VALUE = /^[A-Za-z0-9_.:/-]+$/;

/**
 * Swarm placement constraints, comma-separated: `<key> == <value>` or
 * `<key> != <value>`, such as `node.hostname == node-1` or
 * `node.labels.socio.plugins == true`. Returned in canonical form (one
 * space around the operator) so the runtime and the proxy compare equal.
 */
export function parsePluginConstraints(raw: string | undefined) {
    const out: string[] = [];
    for (const item of (raw ?? '').split(',')) {
        const entry = item.trim();
        if (!entry) {
            continue;
        }
        const match = /^(\S+?)\s*(==|!=)\s*(\S+)$/.exec(entry);
        if (!match || !CONSTRAINT_KEY.test(match[1]!) || !CONSTRAINT_VALUE.test(match[3]!)) {
            throw new Error(
                `SOCKET_PROXY_PLUGIN_CONSTRAINTS entry "${entry}" is not <key> ==|!= <value>, with key node.id, node.hostname, node.role, node.platform.os, node.platform.arch, node.labels.<name>, or engine.labels.<name>.`,
            );
        }
        const canonical = `${match[1]} ${match[2]} ${match[3]}`;
        if (!out.includes(canonical)) {
            out.push(canonical);
        }
    }
    return out;
}

export function parseImagePins(raw: string | undefined) {
    const pins = new Map<string, string>();
    const text = raw?.trim();
    if (!text) {
        return pins;
    }
    for (const item of text.split(',')) {
        const eq = item.indexOf('=');
        const id = item.slice(0, eq).trim();
        const image = item.slice(eq + 1).trim();
        if (eq < 1 || !PLUGIN_ID.test(id) || !PINNED_IMAGE.test(image)) {
            throw new Error('SOCKET_PROXY_IMAGE_PINS entries are <plugin id>=<name>@sha256:<64 hex>.');
        }
        pins.set(id, image);
    }
    return pins;
}

const QUERY_KEYS: Record<ProxyRoute, readonly string[]> = {
    ping: [],
    version: [],
    'services-list': ['filters'],
    'service-inspect': [],
    'service-create': [],
    'service-update': ['version'],
    'service-delete': [],
    tasks: ['filters'],
    'secrets-lookup': ['filters'],
    'networks-list': ['filters'],
    'network-inspect': [],
    'network-create': [],
    'network-delete': [],
    'image-pull': ['fromImage'],
    'volume-delete': [],
    'secret-create': [],
    'secret-delete': [],
};

function queryError(route: ProxyRoute, query: URLSearchParams) {
    const allowed = new Set(QUERY_KEYS[route]);
    for (const key of new Set(query.keys())) {
        if (!allowed.has(key)) {
            return `Query parameter ${key} is not allowed.`;
        }
        if (query.getAll(key).length > 1) {
            return `Query parameter ${key} is repeated.`;
        }
    }
    return undefined;
}

function proxyQueryPath(path: string, query: URLSearchParams, route: ProxyRoute) {
    const next = new URLSearchParams();
    for (const key of QUERY_KEYS[route]) {
        const value = query.get(key);
        if (value !== null) {
            next.set(key, value);
        }
    }
    const text = next.toString();
    return text ? `${path}?${text}` : path;
}

/** A scale body is only `{ Mode: { Replicated: { Replicas } } }`. */
function scaleReplicaCount(body: unknown): number | undefined {
    const row = asRecord(body);
    if (!row || Object.keys(row).length !== 1 || !Object.hasOwn(row, 'Mode')) {
        return undefined;
    }
    if (keyErrors(row, ['Mode'], 'Service').length) {
        return undefined;
    }
    const mode = asRecord(row.Mode);
    if (!mode || Object.keys(mode).length !== 1) {
        return undefined;
    }
    if (keyErrors(mode, ['Replicated'], 'Mode').length) {
        return undefined;
    }
    const replicated = asRecord(mode.Replicated);
    if (!replicated || Object.keys(replicated).length !== 1) {
        return undefined;
    }
    if (keyErrors(replicated, ['Replicas'], 'Mode').length) {
        return undefined;
    }
    const replicas = replicated.Replicas;
    if (typeof replicas !== 'number' || !Number.isInteger(replicas)) {
        return undefined;
    }
    return replicas;
}

function secretNamesIn(body: unknown) {
    const spec = asRecord(body);
    const container = asRecord(asRecord(spec?.TaskTemplate)?.ContainerSpec);
    const secrets = container?.Secrets;
    if (!Array.isArray(secrets)) {
        return [];
    }
    return secrets.flatMap((item) => {
        const name = asRecord(item)?.SecretName;
        return typeof name === 'string' ? [name] : [];
    });
}

function redactContainer(container: Record<string, unknown> | undefined, revision = false) {
    if (!container) {
        return;
    }
    // In a response, what it runs as a digest, before the values go
    // (CB-370): the runtime tells a task of the current revision from one an
    // update is replacing. Never in the spec an update is compared with.
    if (revision) {
        container[REVISION_FIELD] = containerRevision(container);
    }
    delete container.Env;
    delete container.Secrets;
    delete container.Configs;
}

/**
 * A service as the runtime may see it: no environment, secrets or configs
 * in the current spec or in `PreviousSpec` (the spec before the last
 * update, which carries the same values).
 */
function redactService(value: unknown) {
    const row = asRecord(value);
    for (const key of ['Spec', 'PreviousSpec']) {
        const spec = asRecord(row?.[key]);
        redactContainer(asRecord(asRecord(spec?.TaskTemplate)?.ContainerSpec), true);
    }
    return value;
}

/**
 * A task carries its service's ContainerSpec, environment included, for
 * every service on the swarm (Socio's own provider keys among them). The
 * runtime reads only status and addresses.
 */
function redactTask(value: unknown) {
    const row = asRecord(value);
    redactContainer(asRecord(asRecord(row?.Spec)?.ContainerSpec), true);
    return value;
}

const BODY_LIMIT = 1024 * 1024;
const HOP = new Set([
    'connection',
    'keep-alive',
    'transfer-encoding',
    'upgrade',
    'proxy-connection',
    'te',
    'trailer',
    'content-length',
]);

export interface SocketProxyOptions {
    listenHost: string;
    listenPort: number;
    /** A unix socket path, or `http://host:port` in tests. */
    upstream: string;
    pins: ReadonlyMap<string, string>;
    /** `SOCKET_PROXY_PLUGIN_CONSTRAINTS`, canonical. Empty or unset: plugin services carry no placement. */
    constraints?: readonly string[];
    infra: ReadonlySet<string>;
    /** Names `GET /v1.44/secrets` may filter on, and that a service body may reference. */
    secretNames: ReadonlySet<string>;
    log?: (line: string) => void;
}

function upstreamOf(value: string) {
    if (value.startsWith('http://') || value.startsWith('tcp://')) {
        const url = new URL(value.replace(/^tcp:\/\//, 'http://'));
        const port = Number(url.port || 80);
        if (!url.hostname || !Number.isInteger(port)) {
            throw new Error('SOCKET_PROXY_SOCKET must be a path or http://host:port.');
        }
        return { hostname: url.hostname, port };
    }
    return { socketPath: value };
}

function readLimited(req: IncomingMessage, limit: number) {
    return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
                req.destroy();
                reject(new Error('The request body is too large.'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function deny(res: ServerResponse, status: number, message: string) {
    sendJson(res, status, { message });
}

function sendJson(res: ServerResponse, status: number, value: unknown) {
    if (res.headersSent || res.writableEnded) {
        return;
    }
    const payload = Buffer.from(JSON.stringify(value));
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        'x-content-type-options': 'nosniff',
    });
    res.end(payload);
}

interface UpstreamResult {
    status: number;
    body: unknown;
    raw: Buffer;
}

function callUpstream(
    upstream: ReturnType<typeof upstreamOf>,
    method: string,
    path: string,
    body?: Buffer,
    headers?: Record<string, string>,
): Promise<UpstreamResult> {
    return new Promise((resolve, reject) => {
        const req = httpRequest(
            {
                ...upstream,
                method,
                path,
                headers: {
                    host: 'localhost',
                    ...(body
                        ? {
                              'content-type': 'application/json',
                              'content-length': String(body.length),
                          }
                        : {}),
                    ...headers,
                },
                timeout: 120_000,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks);
                    let parsed: unknown = null;
                    if (raw.length) {
                        try {
                            parsed = JSON.parse(raw.toString('utf8')) as unknown;
                        } catch {
                            parsed = null;
                        }
                    }
                    resolve({ status: res.statusCode ?? 0, body: parsed, raw });
                });
            },
        );
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
        if (body) {
            req.end(body);
        } else {
            req.end();
        }
    });
}

function forwardHeaders(incoming: IncomingMessage, registryAuth = true) {
    const out: Record<string, string> = { host: 'localhost' };
    for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined || HOP.has(name)) {
            continue;
        }
        if ((name === 'x-registry-auth' && registryAuth) || name === 'content-type') {
            out[name] = Array.isArray(value) ? value.join(', ') : value;
        }
    }
    return out;
}

/**
 * Listen for the apps runtime and forward only what the policy allows.
 * The returned server is not listening until `listen` resolves.
 */
export function startSocketProxy(options: SocketProxyOptions) {
    const upstream = upstreamOf(options.upstream);
    const log = options.log ?? ((line: string) => console.log(line));
    const networkCache = new Map<string, PluginNetworkInfo>();
    const lookup = async (target: string) => {
        const cached = networkCache.get(target);
        if (cached) {
            return cached;
        }
        const result = await callUpstream(upstream, 'GET', `${API}/networks/${encodeURIComponent(target)}`);
        const row = asRecord(result.body);
        if (!row || result.status >= 300 || typeof row.Name !== 'string') {
            return undefined;
        }
        const info = {
            name: row.Name,
            driver: typeof row.Driver === 'string' ? row.Driver : '',
            internal: row.Internal === true,
        };
        networkCache.set(target, info);
        if (typeof row.Id === 'string') {
            networkCache.set(row.Id, info);
        }
        return info;
    };
    const policyFor = (
        network: ProxyPolicy['network'],
        secretIds?: ReadonlyMap<string, string>,
        volumeClaims?: readonly VolumeClaim[],
    ): ProxyPolicy => ({
        pins: options.pins,
        constraints: options.constraints ?? [],
        infra: options.infra,
        network,
        secretNames: options.secretNames,
        ...(secretIds ? { secretIds } : {}),
        ...(volumeClaims ? { volumeClaims } : {}),
    });
    /**
     * Every service's volume mounts, its live tasks' included, fresh per
     * request. Undefined when the engine did not list services or tasks.
     */
    const currentVolumeClaims = async () => {
        const [services, tasks] = await Promise.all([
            callUpstream(upstream, 'GET', `${API}/services`),
            callUpstream(upstream, 'GET', `${API}/tasks`),
        ]);
        if (services.status >= 300 || tasks.status >= 300 || !Array.isArray(tasks.body)) {
            return undefined;
        }
        return volumeClaimsOf(services.body, tasks.body);
    };
    /**
     * The body alone first, so a bad one is refused without an engine call;
     * then again with every service's volumes. Undefined: no service list.
     */
    const checkedWithClaims = async (json: unknown, policy: ProxyPolicy) => {
        const errors = pluginServiceErrors(json, policy);
        if (errors.length) {
            return errors;
        }
        const claims = await currentVolumeClaims();
        return claims ? pluginServiceErrors(json, { ...policy, volumeClaims: claims }) : undefined;
    };
    const secretIdOf = async (name: string) => {
        const filters = encodeURIComponent(JSON.stringify({ names: { [name]: true } }));
        const result = await callUpstream(upstream, 'GET', `${API}/secrets?filters=${filters}`);
        if (result.status >= 300) {
            return undefined;
        }
        const matches = (Array.isArray(result.body) ? result.body : []).flatMap((item) => {
            const row = asRecord(item);
            const spec = asRecord(row?.Spec);
            const id = row?.ID ?? row?.Id;
            if (spec?.Name === name && typeof id === 'string' && id) {
                return [id];
            }
            return [];
        });
        return matches.length === 1 ? matches[0] : undefined;
    };
    const boundSecretIds = async (json: unknown) => {
        const ids = new Map<string, string>();
        for (const name of secretNamesIn(json)) {
            if (!lookupAllowed(name, options.secretNames)) {
                continue;
            }
            const id = await secretIdOf(name);
            if (!id) {
                return `Secret ${name} was not found.`;
            }
            ids.set(name, id);
        }
        return ids;
    };
    /**
     * Volume ownership is read from the engine's service list, so a check
     * and the create or update it allows must not interleave with another:
     * `foo` with `bar-data` and `foo-bar` with `data` would both see an
     * empty list and both mount the same volume. Requests that add, change
     * or remove volume mounts run one at a time, each until the engine has
     * answered.
     */
    let volumeLock: Promise<void> = Promise.resolve();
    const serialized = (run: () => Promise<void>) => {
        const next = volumeLock.then(run, run);
        volumeLock = next.then(
            () => undefined,
            () => undefined,
        );
        return next;
    };
    const server = createServer((req, res) => {
        const route = matchProxyRoute(req.method ?? 'GET', normalizeDockerPath(req.url ?? '/')?.path ?? '')?.route;
        const locked = route === 'service-create' || route === 'service-update' || route === 'volume-delete';
        const run = () => handle(req, res);
        void (locked ? serialized(run) : run()).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : 'proxy error';
            log(`socket-proxy: error ${message.slice(0, 200)}`);
            deny(res, 502, 'The socket proxy could not complete the request.');
        });
    });
    async function handle(req: IncomingMessage, res: ServerResponse) {
        const method = req.method ?? 'GET';
        const parsed = normalizeDockerPath(req.url ?? '/');
        const match = parsed && matchProxyRoute(method, parsed.path);
        if (!parsed || !match) {
            req.resume();
            log(`socket-proxy: denied ${method} ${(req.url ?? '/').slice(0, 180)}`);
            deny(res, 403, 'That Docker API route is not allowed.');
            return;
        }
        const body = await readLimited(req, BODY_LIMIT);
        const refuse = (message: string) => {
            log(`socket-proxy: denied ${method} ${parsed.path} (${message})`);
            deny(res, 403, message);
        };
        const queryProblem = queryError(match.route, parsed.query);
        if (queryProblem) {
            refuse(queryProblem);
            return;
        }
        const upstreamPath = proxyQueryPath(parsed.path, parsed.query, match.route);
        let forwardBody: Buffer | undefined = body.length ? body : undefined;
        // An infra update forwards no registry credentials: the engine would
        // store them as the service's pull credentials, a change outside its
        // network attachments.
        let infraUpdate = false;
        const network = (target: string) => networkCache.get(target);
        if (match.route === 'service-create' || match.route === 'service-update') {
            let json: unknown;
            try {
                json = JSON.parse(body.toString('utf8')) as unknown;
            } catch {
                refuse('The service body is not JSON.');
                return;
            }
            if (match.route === 'service-update') {
                const replicas = scaleReplicaCount(json);
                if (replicas !== undefined) {
                    if (replicas < 0 || replicas > PLUGIN_REPLICA_CAP) {
                        refuse(
                            `Replicas must be an integer from 0 to ${PLUGIN_REPLICA_CAP}. Global mode is not allowed.`,
                        );
                        return;
                    }
                    const current = await callUpstream(
                        upstream,
                        'GET',
                        `${API}/services/${encodeURIComponent(match.id!)}`,
                    );
                    if (current.status === 404) {
                        deny(res, 404, 'No such service.');
                        return;
                    }
                    if (current.status >= 300) {
                        deny(res, 502, 'The engine did not return the service.');
                        return;
                    }
                    const currentSpec = serviceSpecOf(current.body);
                    if (!currentSpec || !pluginIdentity(currentSpec)) {
                        refuse('The update does not match that plugin service.');
                        return;
                    }
                    const index = Number(asRecord(asRecord(current.body)?.Version)?.Index);
                    const asked = parsed.query.get('version');
                    if (!asked || !Number.isInteger(index) || asked !== String(index)) {
                        deny(res, 409, 'The service changed. Try again.');
                        return;
                    }
                    const replicated = asRecord(asRecord(currentSpec.Mode)?.Replicated);
                    if (!replicated) {
                        refuse(
                            `Replicas must be an integer from 0 to ${PLUGIN_REPLICA_CAP}. Global mode is not allowed.`,
                        );
                        return;
                    }
                    const next = structuredClone(currentSpec);
                    const nextReplicas = asRecord(asRecord(next.Mode)?.Replicated);
                    if (!nextReplicas) {
                        refuse('The update does not match that plugin service.');
                        return;
                    }
                    nextReplicas.Replicas = replicas;
                    forwardBody = Buffer.from(JSON.stringify(next));
                }
            }
            if (forwardBody === body || !body.length) {
                let outgoing: unknown = json;
                const bound = await boundSecretIds(json);
                if (typeof bound === 'string') {
                    refuse(bound);
                    return;
                }
                if (match.route === 'service-create') {
                    for (const target of networkTargetsOf(json)) {
                        await lookup(target);
                    }
                    const errors = await checkedWithClaims(json, policyFor(network, bound));
                    if (errors === undefined) {
                        deny(res, 502, 'The engine did not list services.');
                        return;
                    }
                    if (errors.length) {
                        refuse(errors[0]!);
                        return;
                    }
                } else if (scaleReplicaCount(json) === undefined) {
                    const current = await callUpstream(
                        upstream,
                        'GET',
                        `${API}/services/${encodeURIComponent(match.id!)}`,
                    );
                    if (current.status === 404) {
                        deny(res, 404, 'No such service.');
                        return;
                    }
                    if (current.status >= 300) {
                        deny(res, 502, 'The engine did not return the service.');
                        return;
                    }
                    const currentSpec = serviceSpecOf(current.body);
                    const name = typeof currentSpec?.Name === 'string' ? currentSpec.Name : '';
                    const targets = [...networkTargetsOf(json), ...(currentSpec ? targetsOf(currentSpec) : [])];
                    for (const target of targets) {
                        await lookup(target);
                    }
                    const policy = policyFor(network, bound);
                    if (pluginIdentity(currentSpec)) {
                        const errors = await checkedWithClaims(json, policy);
                        if (errors === undefined) {
                            deny(res, 502, 'The engine did not list services.');
                            return;
                        }
                        const next = pluginIdentity(json);
                        if (errors.length || !next || next.name !== name) {
                            refuse(errors[0] ?? 'The update does not match that plugin service.');
                            return;
                        }
                    } else if (options.infra.has(name)) {
                        // The proxy owns the infra spec: it forwards the engine's full
                        // spec at the version it checked, never the caller's body.
                        const index = Number(asRecord(asRecord(current.body)?.Version)?.Index);
                        const asked = parsed.query.get('version');
                        if (!asked || !Number.isInteger(index) || asked !== String(index)) {
                            deny(res, 409, 'The service changed. Try again.');
                            return;
                        }
                        const checked = infraUpdateSpec(current.body, json, policy);
                        if ('errors' in checked) {
                            refuse(checked.errors[0]!);
                            return;
                        }
                        outgoing = checked.spec;
                        infraUpdate = true;
                    } else {
                        refuse('That service is not a plugin and is not an infra service.');
                        return;
                    }
                }
                forwardBody = Buffer.from(JSON.stringify(outgoing));
            }
        }
        if (match.route === 'network-create') {
            let json: unknown;
            try {
                json = JSON.parse(body.toString('utf8')) as unknown;
            } catch {
                refuse('The network body is not JSON.');
                return;
            }
            const folded = asRecord(json) ? caseFoldTree(json) : ['The network body is not JSON.'];
            const errors = folded.length ? folded : networkCreateErrors(json);
            if (errors.length) {
                refuse(errors[0]!);
                return;
            }
            forwardBody = Buffer.from(JSON.stringify(json));
        }
        if (match.route === 'network-delete' || match.route === 'service-delete') {
            const kind = match.route === 'network-delete' ? 'networks' : 'services';
            const current = await callUpstream(upstream, 'GET', `${API}/${kind}/${encodeURIComponent(match.id!)}`);
            if (current.status === 404) {
                deny(res, 404, 'Not found.');
                return;
            }
            const row = asRecord(current.body);
            const spec = serviceSpecOf(current.body);
            if (match.route === 'network-delete') {
                if (!pluginNetworkDeletable(row)) {
                    refuse(`Only a ${pluginNamePrefix()}-net-<id> network of that plugin can be removed.`);
                    return;
                }
            } else if (!pluginIdentity(spec)) {
                refuse(`Only a ${pluginNamePrefix()}-<id> service can be removed.`);
                return;
            }
        }
        if (match.route === 'volume-delete') {
            if (body.length) {
                refuse('A volume delete has no body.');
                return;
            }
            const claims = await currentVolumeClaims();
            if (!claims) {
                deny(res, 502, 'The engine did not list services.');
                return;
            }
            const holder = claims.find((claim) => claim.volumes.includes(match.id!));
            if (holder) {
                refuse(`Volume ${match.id!} is mounted by service ${holder.service}.`);
                return;
            }
        }
        if (match.route === 'secret-create') {
            let json: unknown;
            try {
                json = JSON.parse(body.toString('utf8')) as unknown;
            } catch {
                refuse('The secret body is not JSON.');
                return;
            }
            const errors = identitySecretCreateErrors(json);
            if (errors.length) {
                refuse(errors[0]!);
                return;
            }
            const row = asRecord(json)!;
            // Only the checked fields reach the engine.
            forwardBody = Buffer.from(JSON.stringify({ Name: row.Name, Labels: row.Labels, Data: row.Data }));
        }
        if (match.route === 'secret-delete') {
            if (body.length) {
                refuse('A secret delete has no body.');
                return;
            }
            const current = await callUpstream(upstream, 'GET', `${API}/secrets/${encodeURIComponent(match.id!)}`);
            if (current.status === 404) {
                deny(res, 404, 'Not found.');
                return;
            }
            if (current.status >= 300 || !identitySecretDeletable(current.body, match.id!)) {
                refuse(
                    `Only a ${pluginNamePrefix()}-wl-<id>-v<n> plugin identity secret, by its full id, can be removed.`,
                );
                return;
            }
        }
        if (match.route === 'secrets-lookup') {
            if (body.length) {
                refuse('A secret lookup has no body.');
                return;
            }
            const name = secretLookupName(parsed.query, options.secretNames);
            if (!name) {
                refuse('Only an exact names filter of one allowlisted secret is allowed.');
                return;
            }
            const result = await callUpstream(upstream, 'GET', upstreamPath);
            if (result.status >= 300) {
                sendJson(res, result.status, result.body ?? { message: 'Secret lookup failed.' });
                return;
            }
            const slim = (Array.isArray(result.body) ? result.body : []).flatMap((item) => {
                const row = asRecord(item);
                const spec = asRecord(row?.Spec);
                const id = row?.ID ?? row?.Id;
                if (spec?.Name !== name || typeof id !== 'string') {
                    return [];
                }
                return [{ ID: id, Spec: { Name: name } }];
            });
            sendJson(res, 200, slim);
            return;
        }
        if (match.route === 'services-list' || match.route === 'service-inspect') {
            const result = await callUpstream(upstream, method, upstreamPath);
            const value = Array.isArray(result.body)
                ? result.body.map((item) => redactService(item))
                : redactService(result.body);
            sendJson(res, result.status || 502, value);
            return;
        }
        if (match.route === 'tasks') {
            const result = await callUpstream(upstream, method, upstreamPath);
            const value = Array.isArray(result.body) ? result.body.map((item) => redactTask(item)) : result.body;
            sendJson(res, result.status || 502, value);
            return;
        }
        if (match.route === 'image-pull') {
            const message = imagePullError(parsed.query, options.pins, body.length);
            if (message) {
                refuse(message);
                return;
            }
        }
        const headers = forwardHeaders(req, !infraUpdate);
        if (forwardBody?.length) {
            headers['content-length'] = String(forwardBody.length);
        } else {
            delete headers['content-length'];
        }
        let engineRes: IncomingMessage | undefined;
        const upstreamReq = httpRequest(
            {
                ...upstream,
                method,
                path: upstreamPath,
                headers,
                timeout: 120_000,
            },
            (upstreamRes) => {
                engineRes = upstreamRes;
                if (res.destroyed) {
                    upstreamRes.resume();
                    return;
                }
                const out: Record<string, string | string[] | undefined> = {
                    ...upstreamRes.headers,
                };
                delete out['transfer-encoding'];
                res.writeHead(upstreamRes.statusCode ?? 502, out);
                upstreamRes.pipe(res);
            },
        );
        // Resolves when the engine's side is done, so a serialized request
        // holds the volume lock until the engine has applied it, also when
        // the client disconnects first (the engine request goes on).
        const done = new Promise<void>((resolve) => upstreamReq.once('close', () => resolve()));
        // A gone client no longer reads the answer; drain it so the engine
        // request can finish and release the lock.
        res.once('close', () => engineRes?.resume());
        upstreamReq.on('error', () => deny(res, 502, 'The Docker engine did not answer.'));
        upstreamReq.on('timeout', () => upstreamReq.destroy());
        upstreamReq.end(forwardBody?.length ? forwardBody : undefined);
        await done;
    }
    return {
        server,
        listen() {
            return new Promise<Server>((resolve) => {
                server.listen(options.listenPort, options.listenHost, () => resolve(server));
            });
        },
    };
}

function networkTargetsOf(body: unknown) {
    const spec = asRecord(body);
    if (!spec) {
        return [];
    }
    return targetsOf(spec);
}

/** `0.0.0.0:2375` → host and port. */
export function parseListen(raw: string | undefined) {
    const value = raw?.trim() || '0.0.0.0:2375';
    const cut = value.lastIndexOf(':');
    const host = value.slice(0, cut);
    const port = Number(value.slice(cut + 1));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('SOCKET_PROXY_LISTEN must be host:port.');
    }
    return { host, port };
}
