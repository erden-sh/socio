/**
 * A plugin's service on the workspace app runtime. The runtime already
 * runs promoted mini apps; a plugin is the same runtime's other kind of
 * workload: one Docker service, replicated when its manifest asks, reached
 * only through the runtime's ingress. Nothing here talks to Docker. The
 * runtime checks the image against its own allow list before it creates
 * the service.
 */

import type { DeliveredIdentity } from '../identity-delivery.js';

import { configType, type PluginConfigField } from './plugin-config.js';

export class PluginSpecError extends Error {}

/**
 * Socio Secrets phase 2 (identity-delivery.ts): the env var that names a
 * workload's identity file on every platform, and where Swarm mounts it.
 * Both are the runtime's: a manifest may not set either.
 */
export const IDENTITY_FILE_ENV = 'SOCIO_IDENTITY_FILE';
export const SWARM_IDENTITY_FILE = 'socio_identity';
export const SWARM_IDENTITY_PATH = `/run/secrets/${SWARM_IDENTITY_FILE}`;

/**
 * Same shape the runtime's ingress accepts as an app id, without `--`.
 * A mini app's id is always `<app>--<socio>` (packages/foundation/src/apps/settings.ts), and the
 * ingress serves a plugin before a mini app of the same id, so a plugin
 * id with `--` could take a mini app's address, and its traffic.
 */
export const PLUGIN_ID = /^(?!.*--)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The prefix of every Swarm object the apps runtime creates for plugins:
 * services, networks and volumes. Swarm names are global per swarm, so
 * two deployments on one swarm need different prefixes (CB-327). Set once
 * at process start from `PLUGIN_NAME_PREFIX`, the same value for the apps
 * runtime and the socket proxy; `socio-plugin` when unset.
 */
export const DEFAULT_PLUGIN_NAME_PREFIX = 'socio-plugin';
const PLUGIN_NAME_PREFIX = /^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
let namePrefix = DEFAULT_PLUGIN_NAME_PREFIX;

/** Validates and sets the prefix; unset or blank keeps the default. */
export function setPluginNamePrefix(value: string | undefined) {
    const prefix = value?.trim() || DEFAULT_PLUGIN_NAME_PREFIX;
    if (!PLUGIN_NAME_PREFIX.test(prefix) || prefix.includes('--')) {
        throw new Error(
            'PLUGIN_NAME_PREFIX must be 1 to 40 lowercase letters, digits and single dashes, starting with a letter (e.g. example-plugin).',
        );
    }
    namePrefix = prefix;
    return prefix;
}

export const pluginNamePrefix = () => namePrefix;

/** Swarm service name for a plugin. Only services with this prefix and the runtime's labels are removed. */
export const pluginServiceName = (id: string) => `${namePrefix}-${id}`;

/** One internal overlay per plugin. The apps proxy and the app join it; other plugins do not. */
export const pluginNetworkName = (id: string) => `${namePrefix}-net-${id}`;

/**
 * A manifest's short volume name. Dashes are allowed, so a volume name alone
 * does not say which plugin owns it: plugin `foo`'s volume `bar-data` and
 * plugin `foo-bar`'s volume `data` are the same Swarm name. The socket
 * proxy refuses a name another plugin's namespace or service claims.
 */
export const PLUGIN_VOLUME_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** Every named volume of a plugin starts with this. A prefix is not ownership: see PLUGIN_VOLUME_NAME. */
export const pluginVolumePrefix = (id: string) => `${namePrefix}-${id}-`;

/** The Swarm volume a plugin's manifest volume mounts. */
export const pluginVolumeName = (id: string, volume: string) => `${pluginVolumePrefix(id)}${volume}`;

const PLUGIN_ID_PART = '([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)';
/** A plugin service name; group 1 is the plugin id. */
export const pluginServiceNamePattern = () => new RegExp(`^${namePrefix}-${PLUGIN_ID_PART}$`);
/** A plugin network name; group 1 is the plugin id. */
export const pluginNetworkNamePattern = () => new RegExp(`^${namePrefix}-net-${PLUGIN_ID_PART}$`);

/** The image the socket proxy will accept: a name and a sha256 digest, no tag. */
export const PINNED_IMAGE = /^[a-z0-9][a-z0-9._/-]{0,200}@sha256:[a-f0-9]{64}$/;

/**
 * The uid the plugin image's `node` user has. The root filesystem is
 * read-only, so a secret mounted for uid 0 would be unreadable.
 */
export const PLUGIN_RUNTIME_USER = '1000:1000';

/** Applied when a manifest leaves a limit unset, so every service has both. */
export const PLUGIN_DEFAULT_CPUS = 0.5;
export const PLUGIN_DEFAULT_MEMORY_MB = 256;

export const PLUGIN_REPLICA_CAP = 20;

/**
 * Processes (and threads) one plugin task may run. Without a limit a task
 * can fork until the host's process table is full; the socket proxy
 * refuses a service with none or with more than the cap.
 */
export const PLUGIN_PIDS = 256;
export const PLUGIN_PIDS_CAP = 4096;

export interface PluginVolume {
    /** A short name. The runtime prefixes it so the volume is this plugin's. */
    name: string;
    /** Absolute path inside the container. */
    mount: string;
    /**
     * Required, with a driver other than `local`, when `replicas` is above 1.
     * A local volume is one task's disk; another replica would not see it.
     */
    shared?: boolean;
    /** Volume driver (`nfs`, a cloud driver). `local` is a single task's disk. */
    driver?: string;
    /**
     * A cache (CB-458): never backed up, and started empty after a restore.
     * Every other volume is the plugin's state and needs `service.backup`.
     */
    ephemeral?: boolean;
}

/** The snapshot protocol versions this build speaks. */
export const PLUGIN_BACKUP_PROTOCOLS: readonly number[] = [1];
/** The highest data schema version a manifest may declare. */
export const PLUGIN_BACKUP_SCHEMA_MAX = 1_000_000;

/**
 * How the workspace backs up a plugin's volumes (CB-458): required when any
 * volume isn't `ephemeral`. The workspace calls the image on `/__cb/backup/…`.
 */
export interface PluginBackupSpec {
    /** The snapshot protocol version the image speaks; 1 for now. */
    protocol: number;
    /**
     * The highest data schema version this image opens, a non-negative
     * integer the plugin raises when its on-disk format changes. A restore
     * from a newer schema is refused before anything stops.
     */
    schema: number;
}

/** The volumes that hold a plugin's state: every one not marked `ephemeral` (CB-458). */
export function statefulVolumes(spec: Pick<PluginServiceSpec, 'volumes'> | undefined): PluginVolume[] {
    return (spec?.volumes ?? []).filter((volume) => volume.ephemeral !== true);
}

/**
 * Deprecated since Socio Secrets phase 2: a Swarm secret is a platform
 * detail, and a hand-made one is manual secrets management. Declare
 * `secrets` on the manifest instead and read them with `socio.secrets`.
 * Still mounted for one release, with a warning at catalog load.
 */
export interface PluginSecretRef {
    /** Swarm secret name. The value never appears in the manifest. */
    name: string;
    /** Absolute file path, `/run/secrets/<file>`. */
    target: string;
}

export interface PluginHealthcheck {
    /** Path on the container's own port. It must answer without the ingress proof. */
    path?: string;
    intervalSeconds?: number;
    timeoutSeconds?: number;
    /**
     * Refused. The healthcheck is the runtime's fixed `node` fetch of `path`.
     * A shell or extra arguments are not accepted.
     */
    command?: string[];
}

export interface PluginResources {
    /** Swarm NanoCPUs, from this many CPUs. */
    cpus?: number;
    memoryMb?: number;
}

export interface PluginBuild {
    /** Directory of the build context, relative to `APPS_RUNTIME_BUILD_ROOT`. */
    context: string;
    dockerfile?: string;
    target?: string;
}

export interface PluginServiceSpec {
    /** Prebuilt image. Exactly one of `image` and `build`. */
    image?: string;
    build?: PluginBuild;
    port: number;
    /**
     * Plain environment. `CB_*` and `PORT` are the runtime's: it injects
     * `CB_PLUGIN_ID`, `CB_PLUGIN_PROOF`, `CB_ACTOR_KEY`, `CB_APP_ID` and
     * `PORT`. `SOCIO_*` is the plugin's.
     */
    env?: Record<string, string>;
    secrets?: PluginSecretRef[];
    healthcheck?: PluginHealthcheck;
    resources?: PluginResources;
    /** Running tasks while the plugin is enabled. Default 1. Disable scales to 0. */
    replicas?: number;
    volumes?: PluginVolume[];
    /** Required when any volume isn't `ephemeral` (CB-458). */
    backup?: PluginBackupSpec;
    /**
     * Hostnames the plugin may reach, `host` or `host:port` (port 443 if
     * omitted), or `{ fromConfig: FIELD }`: the host of the `url` setting
     * FIELD (CB-441), which Socio resolves at every provision, so the runtime
     * only ever receives hostnames. Absent or empty means no outbound
     * network. The runtime refuses the install when this is set and no
     * egress proxy is configured.
     */
    egress?: PluginEgressEntry[];
    /**
     * Set by Socio, never by a catalog (CB-370): the install revision this
     * service runs, a SHA-256 of the installed manifest and settings, kept on
     * the service as the label `socio.plugin.revision`. A public webhook
     * request names the revision Socio has installed, and the runtime sends
     * it only to a task of a service that runs exactly that one.
     */
    revision?: string;
}

/**
 * One `egress` entry: a hostname, or the host of a `url` setting (CB-441).
 * The settings form checks the setting's value; the host it yields still
 * has to pass the hostname rules, or nothing is added.
 */
export type PluginEgressEntry = string | { fromConfig: string };

/** An install revision (`PluginServiceSpec.revision`): 64 lowercase hex digits. */
export const PLUGIN_REVISION = /^[0-9a-f]{64}$/;

const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const EGRESS_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,63}(?::[1-9]\d{0,4})?$/;
const BANNED_SERVICE_KEY = new Set([
    'privileged',
    'capadd',
    'capabilityadd',
    'capabilities',
    'devices',
    'devicerequests',
    'hostnetwork',
    'networkmode',
    'pidmode',
    'ipcmode',
    'binds',
    'sysctls',
    'securityopt',
    'cgroupns',
    'cgroupnsmode',
]);
const BANNED_ENV = new Set(['HOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DOCKER_HOST', 'NODE_OPTIONS']);

/** A tag-less image (`repo/name`, or `name`) gets `:${tag}`. A digest is left as it is. */
export function resolveImage(image: string, tag = 'latest') {
    if (image.includes('@')) {
        return image;
    }
    const slash = image.lastIndexOf('/');
    const colon = image.lastIndexOf(':');
    if (colon <= slash) {
        return `${image}:${tag}`;
    }
    return image;
}

export function imageAllowed(image: string, allow: readonly string[]) {
    return allow.some((prefix) => prefix.length > 0 && image.startsWith(prefix));
}

export interface CheckedService {
    spec: PluginServiceSpec;
    replicas: number;
    /** Set when the spec names an image. A build receives its tag afterwards. */
    image?: string;
    port: number;
    healthPath: string;
}

function rejectBannedKeys(value: unknown, where: string, fail: (message: string) => void) {
    if (!value || typeof value !== 'object') {
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            rejectBannedKeys(item, where, fail);
        }
        return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (BANNED_SERVICE_KEY.has(key.toLowerCase())) {
            fail(
                `${where} must not set ${key}. Privileged, capabilities, devices, host network and bind mounts are refused.`,
            );
        }
        rejectBannedKeys(child, where, fail);
    }
}

function fromConfigProblem(
    entry: object,
    config: Readonly<Record<string, PluginConfigField>> | undefined,
): string | undefined {
    const keys = Object.keys(entry);
    const field = (entry as { fromConfig?: unknown }).fromConfig;
    if (keys.length !== 1 || keys[0] !== 'fromConfig' || typeof field !== 'string' || field === '') {
        return 'A plugin egress object is { "fromConfig": "<url setting>" } and nothing else.';
    }
    if (!config) {
        return `Plugin egress { fromConfig: ${field} } reaches the runtime unresolved: Socio sends only hostnames.`;
    }
    const declared = Object.hasOwn(config, field) ? config[field] : undefined;
    if (!declared) {
        return `Plugin egress fromConfig ${field} names no setting: declare ${field} in config, with type url.`;
    }
    if (configType(declared) !== 'url') {
        return `Plugin egress fromConfig ${field} must name a url setting; ${field} is ${configType(declared)}.`;
    }
    return undefined;
}

/**
 * The egress host a `url` setting's value gives (CB-441): its hostname,
 * with the port when one is written, under the same rules as a hostname in
 * the manifest. Only https; no IP literals, single labels, `localhost` or
 * local-network names. `problem` says why there is none.
 */
export function egressHostFromUrl(value: string): { host: string } | { problem: string } {
    const text = value.trim();
    if (text === '') {
        return { problem: 'it is empty' };
    }
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        return { problem: 'it is not a URL' };
    }
    if (url.protocol !== 'https:') {
        return { problem: 'only https addresses are allowed' };
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (hostname === 'localhost' || /\.(localhost|local|internal|lan|home|arpa)$/.test(hostname)) {
        return { problem: `${hostname} is not a public host` };
    }
    const host = url.port ? `${hostname}:${url.port}` : hostname;
    if (!EGRESS_HOST.test(host)) {
        return { problem: `${hostname} is not a host name (IP addresses are not allowed)` };
    }
    return { host };
}

/** One `fromConfig` egress entry as a provision resolved it (CB-441). */
export interface ResolvedEgressSetting {
    field: string;
    /** The host added to the allow list; absent when none was. */
    host?: string;
    /** Why nothing was added (an empty or unusable value). */
    problem?: string;
}

/**
 * A manifest's egress as the runtime gets it (CB-441): its hostnames, and
 * each `fromConfig` entry's host from the installed setting, or the field's
 * default when that is empty. An empty or unusable value adds nothing; the
 * plugin's page says why. Duplicates are dropped, first one kept.
 */
export function resolvePluginEgress(
    egress: readonly PluginEgressEntry[] | undefined,
    fields: Readonly<Record<string, PluginConfigField>> | undefined,
    config: Readonly<Record<string, string>>,
): { hosts: string[]; settings: ResolvedEgressSetting[] } {
    const hosts: string[] = [];
    const settings: ResolvedEgressSetting[] = [];
    const add = (host: string) => {
        if (!hosts.some((known) => known.toLowerCase() === host.toLowerCase())) {
            hosts.push(host);
        }
    };
    for (const entry of egress ?? []) {
        if (typeof entry === 'string') {
            add(entry);
            continue;
        }
        const field = entry.fromConfig;
        const saved = Object.hasOwn(config, field) ? (config[field] ?? '') : '';
        const value =
            saved.trim() !== ''
                ? saved
                : ((fields && Object.hasOwn(fields, field) ? fields[field]?.default : '') ?? '');
        const result = egressHostFromUrl(value);
        if ('host' in result) {
            add(result.host);
            settings.push({ field, host: result.host });
        } else {
            settings.push({ field, problem: result.problem });
        }
    }
    return { hosts, settings };
}

/**
 * A spec's egress as hostnames, for the runtime: an unresolved `fromConfig`
 * entry is refused (Socio resolves them before it provisions).
 */
export function egressHostnames(egress: readonly PluginEgressEntry[] | undefined): string[] {
    return (egress ?? []).map((entry) => {
        if (typeof entry !== 'string') {
            throw new PluginSpecError('Plugin egress reaches the runtime unresolved: Socio sends only hostnames.');
        }
        return entry;
    });
}

/** `api.example.com` → `api.example.com:443`. A port that is already there stays. */
export function egressEntries(hosts: readonly string[]) {
    return hosts.map((host) => {
        const value = host.toLowerCase();
        return value.includes(':') ? value : `${value}:443`;
    });
}

/**
 * Structural checks shared by the catalog and the runtime. The image allow
 * list is the runtime's own decision (`imageAllowed`), so a catalog file
 * cannot widen it.
 */
export function checkServiceSpec(
    spec: PluginServiceSpec,
    options: {
        maxReplicas?: number;
        imageTag?: string;
        /**
         * The manifest's `config` fields, given where a manifest is checked
         * (the catalog, Socio). Without them a `fromConfig` egress entry is
         * refused: the runtime only takes hostnames Socio resolved.
         */
        config?: Readonly<Record<string, PluginConfigField>>;
    } = {},
): CheckedService {
    const fail = (message: string) => {
        throw new PluginSpecError(message);
    };
    if (!spec || typeof spec !== 'object') {
        fail('A plugin needs a service.');
    }
    const hasImage = typeof spec.image === 'string' && spec.image.trim() !== '';
    const hasBuild = spec.build !== undefined;
    if (hasImage === hasBuild) {
        fail('A plugin service needs an image or a build, and only one of them.');
    }
    if (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535) {
        fail('A plugin service port must be from 1 to 65535.');
    }
    const max = options.maxReplicas ?? PLUGIN_REPLICA_CAP;
    const replicas = spec.replicas ?? 1;
    if (!Number.isInteger(replicas) || replicas < 1 || replicas > max) {
        fail(`Plugin replicas must be from 1 to ${max}.`);
    }
    rejectBannedKeys(spec, 'service', fail);
    if (spec.revision !== undefined && (typeof spec.revision !== 'string' || !PLUGIN_REVISION.test(spec.revision))) {
        fail('A plugin service revision is 64 lowercase hex digits.');
    }
    for (const [key, value] of Object.entries(spec.env ?? {})) {
        if (
            !ENV_KEY.test(key) ||
            key.startsWith('CB_') ||
            key === 'PORT' ||
            key === IDENTITY_FILE_ENV ||
            BANNED_ENV.has(key)
        ) {
            fail(
                `Plugin env ${key} is not allowed. CB_*, PORT, ${IDENTITY_FILE_ENV}, HOME and loader paths belong to the runtime.`,
            );
        }
        if (typeof value !== 'string' || value.length > 2000) {
            fail(`Plugin env ${key} must be a string of at most 2000 characters.`);
        }
    }
    for (const secret of spec.secrets ?? []) {
        const file = secret.target?.split('/').pop() ?? '';
        if (
            !SECRET_NAME.test(secret.name ?? '') ||
            !/^\/run\/secrets\/[A-Za-z0-9._-]+$/.test(secret.target ?? '') ||
            file !== secret.target.slice('/run/secrets/'.length)
        ) {
            fail('A plugin secret is a swarm secret name and a /run/secrets/<file> target.');
        }
        if (secret.target === SWARM_IDENTITY_PATH) {
            fail(`${SWARM_IDENTITY_PATH} is where the runtime mounts the plugin's identity.`);
        }
    }
    for (const volume of spec.volumes ?? []) {
        if (
            !PLUGIN_VOLUME_NAME.test(volume.name ?? '') ||
            !volume.mount?.startsWith('/') ||
            volume.mount.includes('..')
        ) {
            fail('A plugin volume needs a short name and an absolute mount path.');
        }
        if (volume.ephemeral !== undefined && typeof volume.ephemeral !== 'boolean') {
            fail("A plugin volume's ephemeral must be true or false.");
        }
        if (replicas > 1 && (volume.shared !== true || !volume.driver || volume.driver === 'local')) {
            fail(
                'A plugin with more than one replica must be stateless, or every volume must use shared storage (shared: true and a driver other than local).',
            );
        }
    }
    if (spec.backup !== undefined) {
        const backup = spec.backup as Partial<PluginBackupSpec> | null;
        if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
            fail('A plugin service backup is { protocol, schema }.');
        }
        if (!PLUGIN_BACKUP_PROTOCOLS.includes(backup!.protocol as number)) {
            fail(`A plugin backup protocol must be ${PLUGIN_BACKUP_PROTOCOLS.join(' or ')}.`);
        }
        const schema = backup!.schema;
        if (!Number.isInteger(schema) || (schema as number) < 0 || (schema as number) > PLUGIN_BACKUP_SCHEMA_MAX) {
            fail(`A plugin backup schema must be a whole number from 0 to ${PLUGIN_BACKUP_SCHEMA_MAX}.`);
        }
    }
    const health = spec.healthcheck ?? {};
    const healthPath = health.path ?? '/healthz';
    if (
        !healthPath.startsWith('/') ||
        /\s/.test(healthPath) ||
        healthPath.includes('..') ||
        !/^\/[A-Za-z0-9._/-]+$/.test(healthPath)
    ) {
        fail('A plugin healthcheck path must start with /.');
    }
    if (health.command?.length) {
        fail('A plugin healthcheck command is fixed by the runtime. Shell and extra arguments are refused.');
    }
    const resources = spec.resources ?? {};
    if (resources.cpus !== undefined && !(resources.cpus >= 0.1 && resources.cpus <= 8)) {
        fail('Plugin CPUs must be from 0.1 to 8.');
    }
    if (
        resources.memoryMb !== undefined &&
        (!Number.isInteger(resources.memoryMb) || resources.memoryMb < 16 || resources.memoryMb > 8192)
    ) {
        fail('Plugin memory must be from 16 to 8192 MB.');
    }
    if (spec.egress !== undefined && !Array.isArray(spec.egress)) {
        fail('Plugin egress is a list.');
    }
    for (const entry of spec.egress ?? []) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            const problem = fromConfigProblem(entry, options.config);
            if (problem) {
                fail(problem);
            }
            continue;
        }
        if (typeof entry !== 'string' || !EGRESS_HOST.test(entry.toLowerCase())) {
            fail(
                'Plugin egress entries are hostnames (host or host:port), or { "fromConfig": "<url setting>" }. Wildcards, IPs and the host network are not allowed.',
            );
        }
    }
    if (hasBuild) {
        const context = spec.build?.context ?? '';
        if (context.startsWith('/') || context.split('/').some((part) => part === '..' || part === '')) {
            fail('A plugin build context is a relative path inside APPS_RUNTIME_BUILD_ROOT.');
        }
    }
    return {
        spec,
        replicas,
        port: spec.port,
        healthPath,
        ...(hasImage
            ? {
                  image: resolveImage(spec.image!.trim(), options.imageTag ?? 'latest'),
              }
            : {}),
    };
}

export interface SwarmVolumeMount {
    Type: 'volume';
    Source: string;
    Target: string;
    VolumeOptions?: { DriverConfig: { Name: string } };
}

export interface SwarmTmpfsMount {
    Type: 'tmpfs';
    Target: '/tmp';
    TmpfsOptions: { SizeBytes: number; Mode: number };
}

/** What Docker's service create API takes. No host ports: the ingress is the only way in. */
export interface SwarmServiceBody {
    Name: string;
    /** `socio.plugin`, `socio.managed`, `socio.plugin.port`, and `socio.identity` (the delivered version) when set. */
    Labels: Record<string, string>;
    TaskTemplate: {
        ContainerSpec: {
            Image: string;
            Labels: { 'socio.managed': 'plugin'; 'socio.plugin': string };
            Env: string[];
            User: typeof PLUGIN_RUNTIME_USER;
            ReadOnly: true;
            CapabilityDrop: ['ALL'];
            Privileges: { NoNewPrivileges: true };
            Secrets?: {
                SecretID: string;
                SecretName: string;
                File: { Name: string; UID: string; GID: string; Mode: number };
            }[];
            Mounts: (SwarmTmpfsMount | SwarmVolumeMount)[];
            Healthcheck: {
                Test: string[];
                Interval: number;
                Timeout: number;
                Retries: number;
                StartPeriod: number;
            };
        };
        Resources: {
            Limits: { NanoCPUs: number; MemoryBytes: number; Pids: number };
        };
        Networks: { Target: string }[];
        RestartPolicy: { Condition: 'any' };
        /**
         * Only the operator's `APPS_RUNTIME_PLUGIN_CONSTRAINTS`, and only when
         * set. The socket proxy refuses any other placement.
         */
        Placement?: { Constraints: string[] };
    };
    Mode: { Replicated: { Replicas: number } };
    EndpointSpec: { Mode: 'dnsrr' };
}

const NANOS = 1_000_000_000;

/**
 * The only healthcheck the socket proxy accepts. The port is the label
 * `socio.plugin.port`. The path is the manifest's health path. No shell
 * and no extra arguments.
 */
export function pluginHealthTest(port: number, healthPath: string) {
    return [
        'CMD',
        'node',
        '-e',
        `fetch('http://127.0.0.1:'+(process.env.PORT||${port})+'${healthPath}').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`,
    ];
}

/**
 * The swarm service for one plugin. `dnsrr` publishes nothing on the host;
 * the runtime's ingress round-robins the task addresses and retries another
 * replica when one does not answer. The proof is how a task knows the
 * request came through that ingress.
 */
export function swarmServiceBody(input: {
    id: string;
    image: string;
    spec: PluginServiceSpec;
    replicas: number;
    networkId: string;
    proof: string;
    /**
     * The plugin's actor-envelope key (CB-232, `pluginActorKey`), as
     * `CB_ACTOR_KEY`, with `CB_APP_ID=plugin:<id>`, so the app SDK verifies
     * `x-cb-actor` with no settings of its own.
     */
    actorKey?: string;
    /** Set when the manifest declares egress. The network stays internal. */
    egressProxy?: string;
    /**
     * Swarm secret name → id. Swarm rejects a reference that has a name and
     * no id (`malformed secret reference`). Every declared secret needs one.
     */
    secretIds?: ReadonlyMap<string, string>;
    /**
     * The plugin's identity (Socio Secrets phase 2), as its delivery adapter
     * left it: `SOCIO_IDENTITY_FILE` names the file, and a Swarm delivery's
     * secret is mounted there, 0400 for the `node` user.
     */
    identity?: DeliveredIdentity;
    /**
     * Swarm placement constraints (`APPS_RUNTIME_PLUGIN_CONSTRAINTS`), already
     * checked. Empty or unset: no `Placement`, so Swarm may pick any node.
     */
    constraints?: readonly string[];
}): SwarmServiceBody {
    const checked = checkServiceSpec(
        { ...input.spec, replicas: Math.max(input.replicas, 1) },
        { maxReplicas: Math.max(input.replicas, 1, PLUGIN_REPLICA_CAP) },
    );
    const egress = egressHostnames(input.spec.egress);
    if (egress.length && !input.egressProxy) {
        throw new PluginSpecError('This plugin declares egress and no egress proxy was given.');
    }
    const env = [
        `CB_PLUGIN_ID=${input.id}`,
        `CB_PLUGIN_PROOF=${input.proof}`,
        ...(input.actorKey ? [`CB_ACTOR_KEY=${input.actorKey}`, `CB_APP_ID=plugin:${input.id}`] : []),
        `PORT=${checked.port}`,
        'HOME=/tmp',
        ...(input.identity ? [`${IDENTITY_FILE_ENV}=${input.identity.path}`] : []),
        ...Object.entries(input.spec.env ?? {}).map(([key, value]) => `${key}=${value}`),
        ...(input.egressProxy
            ? [
                  `HTTP_PROXY=${input.egressProxy}`,
                  `HTTPS_PROXY=${input.egressProxy}`,
                  'NO_PROXY=app,localhost,127.0.0.1',
              ]
            : []),
    ];
    const health = input.spec.healthcheck ?? {};
    const test = pluginHealthTest(checked.port, checked.healthPath);
    const cpus = input.spec.resources?.cpus ?? PLUGIN_DEFAULT_CPUS;
    const memoryMb = input.spec.resources?.memoryMb ?? PLUGIN_DEFAULT_MEMORY_MB;
    const limits = {
        NanoCPUs: Math.round(cpus * 1e9),
        MemoryBytes: memoryMb * 1048576,
        Pids: PLUGIN_PIDS,
    };
    const seconds = (value: number | undefined, fallback: number) => Math.round((value ?? fallback) * NANOS);
    const identityMount = input.identity?.mount?.kind === 'swarm-secret' ? input.identity.mount : undefined;
    return {
        Name: pluginServiceName(input.id),
        Labels: {
            'socio.plugin': input.id,
            'socio.managed': 'plugin',
            'socio.plugin.port': String(checked.port),
            ...(input.identity ? { 'socio.identity': String(input.identity.version) } : {}),
            ...(input.spec.revision ? { 'socio.plugin.revision': input.spec.revision } : {}),
        },
        TaskTemplate: {
            ContainerSpec: {
                Image: input.image,
                // On the task's container too (service labels stay on the
                // service), so the deployment's read-only stats proxy can
                // find plugin containers by label (CB-321).
                Labels: { 'socio.managed': 'plugin', 'socio.plugin': input.id },
                Env: env,
                User: PLUGIN_RUNTIME_USER,
                ReadOnly: true,
                CapabilityDrop: ['ALL'],
                Privileges: { NoNewPrivileges: true },
                ...(input.spec.secrets?.length || identityMount
                    ? {
                          Secrets: [
                              ...(input.spec.secrets ?? []).map((secret) => {
                                  const id = input.secretIds?.get(secret.name);
                                  if (!id) {
                                      throw new PluginSpecError(
                                          `Secret ${secret.name} has no SecretID. Swarm rejects a malformed secret reference.`,
                                      );
                                  }
                                  return {
                                      SecretID: id,
                                      SecretName: secret.name,
                                      File: {
                                          Name: secret.target.slice('/run/secrets/'.length),
                                          UID: '1000',
                                          GID: '1000',
                                          Mode: 0o400,
                                      },
                                  };
                              }),
                              ...(identityMount
                                  ? [
                                        {
                                            SecretID: identityMount.secretId,
                                            SecretName: identityMount.secretName,
                                            File: { Name: identityMount.file, UID: '1000', GID: '1000', Mode: 0o400 },
                                        },
                                    ]
                                  : []),
                          ],
                      }
                    : {}),
                Mounts: [
                    {
                        Type: 'tmpfs' as const,
                        Target: '/tmp' as const,
                        TmpfsOptions: { SizeBytes: 64 * 1048576, Mode: 0o1777 },
                    },
                    ...(input.spec.volumes ?? []).map((volume) => ({
                        Type: 'volume' as const,
                        Source: pluginVolumeName(input.id, volume.name),
                        Target: volume.mount,
                        ...(volume.driver ? { VolumeOptions: { DriverConfig: { Name: volume.driver } } } : {}),
                    })),
                ],
                Healthcheck: {
                    Test: test,
                    Interval: seconds(health.intervalSeconds, 10),
                    Timeout: seconds(health.timeoutSeconds, 3),
                    Retries: 3,
                    StartPeriod: 10 * NANOS,
                },
            },
            Resources: { Limits: limits },
            Networks: [{ Target: input.networkId }],
            RestartPolicy: { Condition: 'any' },
            ...(input.constraints?.length ? { Placement: { Constraints: [...input.constraints] } } : {}),
        },
        Mode: { Replicated: { Replicas: input.replicas } },
        EndpointSpec: { Mode: 'dnsrr' },
    };
}
