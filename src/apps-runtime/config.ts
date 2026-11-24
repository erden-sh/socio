import { bundleLimitsFromEnv, type BundleLimits } from '@socio/foundation/apps/bundle';

import { parseImagePins, parsePluginConstraints, parseSecretNames } from './socket-proxy.js';

/** The workspace app runtime's settings (`runtimeConfigFromEnv`). */
export interface RuntimeConfig {
    /** `APPS_RUNTIME_TOKEN` (or `_FILE`): the app's bearer token here. */
    token: string;
    /** `APPS_RUNTIME_DIR`: one working directory per app; emptied at start. */
    dir: string;
    /** `APPS_RUNTIME_COMMAND`: how an entry is started (`bun`). */
    command: string[];
    /**
     * `APPS_RUNTIME_INSTALL`: installs a bundle's locked dependencies, run
     * in its directory as the app's user, lifecycle scripts off; `off` means
     * bundles with dependencies are refused.
     */
    install: string[] | null;
    /**
     * `APPS_RUNTIME_UID_BASE`: each app runs as its own uid from here (with
     * `setpriv`, no capabilities, no new privileges). Unset: as this process.
     */
    isolate?: { uidBase: number; uidCount: number; gid: number };
    /** `APPS_RUNTIME_PRLIMIT=on`: file, process and core limits per app. */
    prlimit: boolean;
    /** `APPS_RUNTIME_MEMORY_MB`: an app above it is restarted. */
    memoryBytes: number;
    maxApps: number;
    /** How long an app has to open its socket. */
    startTimeoutMs: number;
    installTimeoutMs: number;
    /**
     * `APPS_RUNTIME_PROXY_WAIT_SECONDS`: how long an install waits for the
     * egress proxy to take connections (a new one only does once healthy).
     */
    proxyWaitMs: number;
    /** `APPS_RUNTIME_EGRESS_PROXY`: the apps' egress proxy; unset: none. */
    egressProxy?: string;
    /** `APPS_RUNTIME_REGISTRY`: the package registry installs may reach. */
    registry?: string;
    /** Lines of output kept per app. */
    logLines: number;
    path: string;
    bundleLimits: BundleLimits;
}

/**
 * Plugin services (Docker), off unless `APPS_RUNTIME_DOCKER=on`. The default
 * stack does not set it and does not mount the socket.
 */
export interface DockerServicesConfig {
    /** A unix socket path, or `tcp://host:port` when the socket proxy is in front. */
    socketPath: string;
    allow: string[];
    maxReplicas: number;
    pull: boolean;
    buildRoot?: string;
    imageTag?: string;
    pins: ReadonlyMap<string, string>;
    /** True when the engine is the socket proxy: images must be digest-pinned. */
    requireDigest: boolean;
    /**
     * `APPS_RUNTIME_PLUGIN_CONSTRAINTS`: Swarm placement constraints for every
     * plugin service, in canonical form. Empty: Swarm may pick any node.
     */
    constraints: readonly string[];
    infraServices: string[];
    egressService?: string;
    /** Swarm secret names the runtime may resolve to ids (deprecated with `service.secrets`). */
    secretNames: ReadonlySet<string>;
    /**
     * `APPS_RUNTIME_IDENTITY_DELIVERY`: how plugins get their identity
     * token. `swarm` (the default): a Docker secret per version, through
     * the socket proxy. `local`: files under `APPS_RUNTIME_IDENTITY_DIR`,
     * for development only; refused with `APPS_RUNTIME_DOCKER_PROXY=on`,
     * since a Swarm service can't read them.
     */
    identity: { kind: 'swarm' } | { kind: 'local'; dir: string };
}

const number = (env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number) => {
    const raw = env[name]?.trim();
    const value = raw ? Number(raw) : fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${name} must be a number from ${min} to ${max}.`);
    }
    return value;
};
const words = (value: string) => value.trim().split(/\s+/).filter(Boolean);
/**
 * `bun run <entry>` reads the directories above the app's, which its user
 * may pass but not list (0711), and fails; `bun <entry>` doesn't. An old
 * `bun run …` setting is read as `bun …`, its flags kept.
 */
const runtimeCommand = (value: string) => {
    const command = words(value);
    return /(^|\/)bun$/.test(command[0] ?? '') && command[1] === 'run' ? [command[0], ...command.slice(2)] : command;
};

export function runtimeConfigFromEnv(env: Record<string, string | undefined>): RuntimeConfig {
    const token = env.APPS_RUNTIME_TOKEN?.trim();
    if (!token || token.length < 24) {
        throw new Error('APPS_RUNTIME_TOKEN must be at least 24 characters.');
    }
    const uidBase = env.APPS_RUNTIME_UID_BASE?.trim();
    const install = env.APPS_RUNTIME_INSTALL?.trim();
    const registry = env.APPS_RUNTIME_REGISTRY?.trim().toLowerCase();
    const proxy = env.APPS_RUNTIME_EGRESS_PROXY?.trim();
    if (proxy && !/^http:\/\/[^/@]+\/?$/.test(proxy)) {
        throw new Error('APPS_RUNTIME_EGRESS_PROXY must be http://host:port (no credentials).');
    }
    if (registry && registry !== 'off' && !/^[a-z0-9.-]+:\d{1,5}$/.test(registry)) {
        throw new Error('APPS_RUNTIME_REGISTRY must be host:port, or off.');
    }
    return {
        token,
        dir: env.APPS_RUNTIME_DIR?.trim() || '/srv/apps',
        command: runtimeCommand(env.APPS_RUNTIME_COMMAND || 'bun'),
        install:
            install === 'off' ? null : words(install || 'bun install --frozen-lockfile --production --ignore-scripts'),
        isolate: uidBase
            ? {
                  uidBase: number(env, 'APPS_RUNTIME_UID_BASE', 20000, 1000, 2 ** 31),
                  uidCount: number(env, 'APPS_RUNTIME_UID_COUNT', 1000, 1, 60000),
                  gid: number(env, 'APPS_RUNTIME_GID', process.getgid?.() ?? 1000, 0, 2 ** 31),
              }
            : undefined,
        prlimit: env.APPS_RUNTIME_PRLIMIT?.trim() === 'on',
        memoryBytes: number(env, 'APPS_RUNTIME_MEMORY_MB', 256, 16, 16384) * 1048576,
        maxApps: number(env, 'APPS_RUNTIME_MAX_APPS', 20, 1, 500),
        startTimeoutMs: number(env, 'APPS_RUNTIME_START_SECONDS', 30, 1, 600) * 1000,
        installTimeoutMs: number(env, 'APPS_RUNTIME_INSTALL_SECONDS', 180, 5, 1800) * 1000,
        proxyWaitMs: number(env, 'APPS_RUNTIME_PROXY_WAIT_SECONDS', 60, 1, 600) * 1000,
        egressProxy: proxy ? proxy.replace(/\/$/, '') : undefined,
        registry: registry === 'off' ? undefined : registry || 'registry.npmjs.org:443',
        logLines: number(env, 'APPS_RUNTIME_LOG_LINES', 500, 10, 10000),
        path: env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        bundleLimits: bundleLimitsFromEnv(env),
    };
}

/** `APPS_RUNTIME_DOCKER=on` plus an image allow list. Otherwise plugin services stay off. */
export function dockerServicesFromEnv(env: Record<string, string | undefined>): DockerServicesConfig | undefined {
    if (env.APPS_RUNTIME_DOCKER?.trim() !== 'on') {
        return undefined;
    }
    const allow = (env.APPS_RUNTIME_IMAGE_ALLOW ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    if (!allow.length) {
        throw new Error('APPS_RUNTIME_IMAGE_ALLOW must list image prefixes when APPS_RUNTIME_DOCKER=on.');
    }
    const maxReplicas = number(env, 'APPS_RUNTIME_SERVICE_MAX_REPLICAS', 5, 1, 20);
    const root = env.APPS_RUNTIME_BUILD_ROOT?.trim();
    const socketPath = env.APPS_RUNTIME_DOCKER_HOST?.trim() || '/var/run/docker.sock';
    const proxied = socketPath.startsWith('tcp://') || socketPath.startsWith('http://');
    if (env.APPS_RUNTIME_DOCKER_PROXY?.trim() === 'on' && !proxied) {
        throw new Error(
            'APPS_RUNTIME_DOCKER_PROXY=on refuses a direct Docker socket. Point APPS_RUNTIME_DOCKER_HOST at the socket proxy (tcp:// or http://).',
        );
    }
    let pins: ReadonlyMap<string, string>;
    try {
        pins = parseImagePins(env.APPS_RUNTIME_IMAGE_PINS);
    } catch (error) {
        const message = error instanceof Error ? error.message : '';
        throw new Error(message.replaceAll('SOCKET_PROXY_IMAGE_PINS', 'APPS_RUNTIME_IMAGE_PINS'), { cause: error });
    }
    let constraints: readonly string[];
    try {
        constraints = parsePluginConstraints(env.APPS_RUNTIME_PLUGIN_CONSTRAINTS);
    } catch (error) {
        const message = error instanceof Error ? error.message : '';
        throw new Error(message.replaceAll('SOCKET_PROXY_PLUGIN_CONSTRAINTS', 'APPS_RUNTIME_PLUGIN_CONSTRAINTS'), {
            cause: error,
        });
    }
    let secretNames: ReadonlySet<string>;
    try {
        secretNames = parseSecretNames(env.APPS_RUNTIME_SECRET_NAMES);
    } catch (error) {
        const message = error instanceof Error ? error.message : '';
        throw new Error(message.replaceAll('SOCKET_PROXY_SECRET_NAMES', 'APPS_RUNTIME_SECRET_NAMES'), { cause: error });
    }
    const infraServices = (env.APPS_RUNTIME_INFRA_SERVICES ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    const egressService = env.APPS_RUNTIME_EGRESS_SERVICE?.trim();
    const delivery = env.APPS_RUNTIME_IDENTITY_DELIVERY?.trim() || 'swarm';
    if (delivery !== 'swarm' && delivery !== 'local') {
        throw new Error('APPS_RUNTIME_IDENTITY_DELIVERY must be swarm or local.');
    }
    const identityDir = env.APPS_RUNTIME_IDENTITY_DIR?.trim();
    if (delivery === 'local' && (env.APPS_RUNTIME_DOCKER_PROXY?.trim() === 'on' || proxied)) {
        throw new Error(
            'APPS_RUNTIME_IDENTITY_DELIVERY=local is for development: a plugin service behind the socket proxy cannot read the runtime’s files. Leave it unset (swarm).',
        );
    }
    if (delivery === 'local' && !identityDir?.startsWith('/')) {
        throw new Error('APPS_RUNTIME_IDENTITY_DELIVERY=local needs APPS_RUNTIME_IDENTITY_DIR, an absolute path.');
    }
    return {
        identity: delivery === 'local' ? { kind: 'local', dir: identityDir! } : { kind: 'swarm' },
        socketPath,
        allow,
        maxReplicas,
        pull: env.APPS_RUNTIME_PULL?.trim() === 'on',
        pins,
        requireDigest: true,
        constraints,
        infraServices,
        secretNames,
        ...(root ? { buildRoot: root } : {}),
        ...(env.APPS_RUNTIME_IMAGE_TAG?.trim() ? { imageTag: env.APPS_RUNTIME_IMAGE_TAG.trim() } : {}),
        ...(egressService ? { egressService } : {}),
    };
}
