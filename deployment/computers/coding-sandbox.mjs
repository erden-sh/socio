// Coding sandboxes (CB-239): one container per coding session, created
// by the computer supervisor (which already holds the Docker socket) on an
// internal network of its own whose only other member is the coding egress
// proxy.
//
// The API takes no container spec. A create names a session, an opaque
// workspace volume key and resource numbers, each clamped to this
// supervisor's own ceilings; the image (a pinned digest), user,
// capabilities, mounts, read-only root, network shape and DNS are fixed
// here. Every created container is inspected and removed unless it matches
// the fixed spec. Execs take argv from a fixed set, never a shell string, and
// a prompt arrives on stdin; they run detached, keyed by the prompt run's
// id, so another Socio runtime can collect them after a deploy. A start-up
// self-test runs a canary sandbox and refuses to create sandboxes if any
// outside name resolves or any outside address answers.
//
// Plain JavaScript with no imports, so the supervisor (Bun, harden-
// supervisor.mjs mounts it) and the tests (Node, with a fake Docker) load
// the same file. Nothing here starts a container in the tests.

/** The sandbox's only user (the image's `node`, uid 1000). */
export const SANDBOX_USER = '1000:1000';
export const WORK_DIR = '/work';
export const REPO_DIR = '/work/repo';
export const TOKEN_DIR = '/run/socio';
export const TOKEN_FILE = '/run/socio/token';
export const PROXY_PORT = 3128;
/** No resolver answers here: outside names can't resolve. */
export const SANDBOX_DNS = ['127.0.0.1'];
export const SANDBOX_TOOLS = '/usr/local/lib/socio';

/** Labels on everything this creates; not OpenBot's, so no computer listing shows it. */
export const LABELS = {
    owner: 'socio.coding.supervisor',
    namespace: 'socio.coding.namespace',
    session: 'socio.coding.session',
    volume: 'socio.coding.volume',
    cpus: 'socio.coding.cpus',
    memory: 'socio.coding.memory',
    pids: 'socio.coding.pids',
};
/** The coding egress proxy's container carries `socio.coding-egress=<namespace>`. */
export const EGRESS_LABEL = 'socio.coding-egress';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const VOLUME_KEY = /^[a-f0-9]{64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/**
 * A pinned image only: `name@sha256:<64 hex>` (a repository digest, with an
 * optional tag), or `sha256:<64 hex>`, the local image ID that
 * `scripts/build-images.mjs` prints for an image built on this node and
 * never pushed (no repository digest exists for it). Docker resolves the ID
 * locally; a tag alone never passes.
 */
const IMAGE_PIN = /^(?:[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_.-]{1,128})?@)?sha256:[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const SELF_TEST = 'selftest';
/** The lock key every create and workspace delete shares; never a session id. */
const CREATES = ' creates';
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

const integer = (raw, fallback) => {
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : NaN;
};

function parseCidr(cidr) {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(cidr ?? ''));
    if (!match) return undefined;
    const parts = match.slice(1, 5).map(Number);
    const bits = Number(match[5]);
    if (parts.some((part) => part > 255) || bits > 32) return undefined;
    const base = parts.reduce((total, part) => total * 256 + part, 0);
    const size = 2 ** (32 - bits);
    return { base: Math.floor(base / size) * size, bits };
}

const ipOf = (number) => [24, 16, 8, 0].map((shift) => Math.floor(number / 2 ** shift) % 256).join('.');

/** Private ranges only: a sandbox subnet must never shadow a public address. */
const isPrivatePool = ({ base, bits }) => {
    const first = base;
    const last = base + 2 ** (32 - bits) - 1;
    const within = (start, prefix) => {
        const range = parseCidr(`${start}/${prefix}`);
        const end = range.base + 2 ** (32 - prefix) - 1;
        return first >= range.base && last <= end;
    };
    return within('10.0.0.0', 8) || within('172.16.0.0', 12) || within('192.168.0.0', 16);
};

/**
 * The supervisor's coding settings, from its own environment. Anything
 * missing or malformed turns sandboxes off with a reason (the computers keep
 * working); nothing here is taken from a request.
 */
export function sandboxConfig(env, namespace) {
    const reasons = [];
    const image = env.CODING_SANDBOX_IMAGE?.trim() ?? '';
    if (!image) reasons.push('CODING_SANDBOX_IMAGE is not set');
    else if (!IMAGE_PIN.test(image))
        reasons.push('CODING_SANDBOX_IMAGE must be pinned by digest (name@sha256:…) or local image ID (sha256:…)');
    const cpus = integer(env.CODING_SANDBOX_MAX_CPUS, 2);
    const memoryBytes = integer(env.CODING_SANDBOX_MAX_MEMORY_BYTES, 4 * GiB);
    const pids = integer(env.CODING_SANDBOX_MAX_PIDS, 512);
    const sandboxes = integer(env.CODING_SANDBOX_MAX, 8);
    const promptSeconds = integer(env.CODING_PROMPT_MAX_SECONDS, 1200);
    if (!(cpus >= 0.25 && cpus <= 16)) reasons.push('CODING_SANDBOX_MAX_CPUS must be 0.25–16');
    if (!(memoryBytes >= 256 * MiB && memoryBytes <= 64 * GiB))
        reasons.push('CODING_SANDBOX_MAX_MEMORY_BYTES must be 256 MiB–64 GiB');
    if (!(Number.isInteger(pids) && pids >= 64 && pids <= 8192))
        reasons.push('CODING_SANDBOX_MAX_PIDS must be 64–8192');
    if (!(Number.isInteger(sandboxes) && sandboxes >= 1 && sandboxes <= 256))
        reasons.push('CODING_SANDBOX_MAX must be 1–256');
    if (!(Number.isInteger(promptSeconds) && promptSeconds >= 60 && promptSeconds <= 8 * 3600))
        reasons.push('CODING_PROMPT_MAX_SECONDS must be 60–28800');
    const pool = parseCidr(env.CODING_SANDBOX_SUBNETS?.trim() || '10.213.0.0/16');
    if (!pool || pool.bits < 8 || pool.bits > 28 || !isPrivatePool(pool))
        reasons.push('CODING_SANDBOX_SUBNETS must be a private IPv4 range, /8 to /28');
    // By the owner's decision, only the read-only virtual hosts are built.
    const mode = env.CODING_EGRESS_MODE?.trim() || 'virtual-hosts';
    if (mode !== 'virtual-hosts')
        reasons.push(`CODING_EGRESS_MODE=${mode.slice(0, 40)} is not built (only virtual-hosts)`);
    const runtime = env.COMPUTER_RUNTIME?.trim() || undefined;
    if (runtime !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(runtime))
        reasons.push('COMPUTER_RUNTIME is not a runtime name');
    return {
        enabled: reasons.length === 0,
        reason: reasons.join('; ') || undefined,
        namespace,
        image,
        runtime,
        mode,
        pool,
        ceilings: { cpus, memoryBytes, pids, sandboxes, promptSeconds },
    };
}

/** Everything one session's sandbox is named; derived, never accepted. */
export function sandboxNames(namespace, sessionId, volumeKey) {
    return {
        sessionId,
        volumeKey,
        container: `${namespace}-code-${sessionId}`,
        network: `${namespace}-code-${sessionId}`,
        volume: `${namespace}-code-work-${volumeKey}`,
    };
}

/** The first free /28 in the pool, or undefined when it is full. */
export function allocateSubnet(pool, used) {
    const bits = 28;
    const count = 2 ** (bits - pool.bits);
    for (let index = 0; index < count; index++) {
        const cidr = `${ipOf(pool.base + index * 16)}/${bits}`;
        if (!used.has(cidr)) return cidr;
    }
    return undefined;
}

const fail = (reason) => ({ ok: false, reason });

/** Refuses any field it doesn't know: an image, mount, capability or command never passes. */
function onlyFields(body, allowed) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'Send a JSON object.';
    for (const key of Object.keys(body))
        if (!allowed.includes(key)) return `Field "${key.slice(0, 40)}" is not accepted.`;
    return undefined;
}

const clamp = (value, min, max, fallback) => {
    if (value === undefined) return Math.min(fallback, max);
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return Math.min(Math.max(value, min), max);
};

/** `POST /sandboxes`: a session, a volume key, resource numbers. Nothing else. */
export function parseCreateRequest(body, config) {
    const unknown = onlyFields(body, ['sessionId', 'volumeKey', 'cpus', 'memoryBytes', 'pids']);
    if (unknown) return fail(unknown);
    if (typeof body.sessionId !== 'string' || !SESSION_ID.test(body.sessionId) || body.sessionId === SELF_TEST)
        return fail('sessionId must be 1–64 letters, digits, "-" or "_".');
    if (typeof body.volumeKey !== 'string' || !VOLUME_KEY.test(body.volumeKey))
        return fail('volumeKey must be 64 lowercase hex characters.');
    const { ceilings } = config;
    const cpus = clamp(body.cpus, 0.25, ceilings.cpus, 2);
    const memoryBytes = clamp(body.memoryBytes, 256 * MiB, ceilings.memoryBytes, 4 * GiB);
    const pids = clamp(body.pids, 64, ceilings.pids, 512);
    if (cpus === undefined || memoryBytes === undefined || pids === undefined)
        return fail('cpus, memoryBytes and pids must be numbers.');
    return {
        ok: true,
        value: {
            sessionId: body.sessionId,
            volumeKey: body.volumeKey,
            cpus: Math.round(cpus * 100) / 100,
            memoryBytes: Math.floor(memoryBytes),
            pids: Math.floor(pids),
        },
    };
}

/** `POST /sandboxes/:id/start`: the proxy credential Socio signed (CB-239). */
export function parseStartRequest(body) {
    const unknown = onlyFields(body, ['proxyUser', 'proxyPassword']);
    if (unknown) return fail(unknown);
    if (typeof body.proxyUser !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(body.proxyUser))
        return fail('proxyUser must be base64url.');
    if (typeof body.proxyPassword !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.proxyPassword))
        return fail('proxyPassword must be a 43-character MAC.');
    return {
        ok: true,
        value: { user: body.proxyUser, password: body.proxyPassword },
    };
}

/** The fixed environment of every sandbox: the proxy, managed config paths. */
export function sandboxEnvironment(proxyUrl) {
    return [
        // libcurl (git) reads only the lowercase http_proxy for http URLs.
        `HTTP_PROXY=${proxyUrl}`,
        `HTTPS_PROXY=${proxyUrl}`,
        `http_proxy=${proxyUrl}`,
        `https_proxy=${proxyUrl}`,
        'NO_PROXY=',
        'no_proxy=',
        'HOME=/tmp/home',
        'TMPDIR=/tmp',
        'OPENCODE_CONFIG=/etc/socio/opencode.json',
        // Convenience only: the network is the enforcement.
        'OPENCODE_DISABLE_AUTOUPDATE=1',
        'OPENCODE_DISABLE_MODELS_FETCH=1',
        'OPENCODE_DISABLE_CLAUDE_CODE=1',
        'OPENCODE_DISABLE_PROJECT_CONFIG=1',
        `SOCIO_GATEWAY_TOKEN_FILE=${TOKEN_FILE}`,
        'npm_config_registry=http://npm.registry.socio.internal/',
        'npm_config_update_notifier=false',
        'npm_config_audit=false',
        'npm_config_fund=false',
        'PIP_CONFIG_FILE=/etc/pip.conf',
        'PIP_DISABLE_PIP_VERSION_CHECK=1',
        'GIT_TERMINAL_PROMPT=0',
        'COREPACK_ENABLE_NETWORK=0',
        'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
        'DO_NOT_TRACK=1',
    ];
}

const ownLabels = (config) => ({
    [LABELS.owner]: 'true',
    [LABELS.namespace]: config.namespace,
});

/** The sandbox's network: internal (no route out), IPv4 only, one /28. */
export function networkSpec(config, names, subnet, resources) {
    return {
        Name: names.network,
        Driver: 'bridge',
        Internal: true,
        EnableIPv6: false,
        Attachable: false,
        CheckDuplicate: true,
        IPAM: { Driver: 'default', Config: [{ Subnet: subnet }] },
        Options: {
            'com.docker.network.bridge.enable_icc': 'true',
            'com.docker.network.bridge.enable_ip_masquerade': 'false',
            // No address for the host on this bridge: the sandbox can't reach
            // services listening on the host through the gateway address.
            'com.docker.network.bridge.inhibit_ipv4': 'true',
        },
        Labels: {
            ...ownLabels(config),
            [LABELS.session]: names.sessionId,
            [LABELS.volume]: names.volumeKey,
            [LABELS.cpus]: String(resources.cpus),
            [LABELS.memory]: String(resources.memoryBytes),
            [LABELS.pids]: String(resources.pids),
        },
    };
}

/**
 * The one container spec. `command` is only for the self-test's canary,
 * which runs the egress probe instead of idling.
 */
export function containerSpec(config, names, resources, proxy, command) {
    const proxyUrl = `http://${proxy.user}:${proxy.password}@${proxy.address}:${PROXY_PORT}`;
    return {
        name: names.container,
        Image: config.image,
        User: SANDBOX_USER,
        WorkingDir: WORK_DIR,
        Hostname: 'sandbox',
        Entrypoint: command ? command.slice(0, 1) : ['sleep'],
        Cmd: command ? command.slice(1) : ['infinity'],
        Env: sandboxEnvironment(proxyUrl),
        Labels: {
            ...ownLabels(config),
            [LABELS.session]: names.sessionId,
            [LABELS.volume]: names.volumeKey,
        },
        ExposedPorts: {},
        StopTimeout: 5,
        HostConfig: {
            Binds: [],
            Mounts: [
                {
                    Type: 'volume',
                    Source: names.volume,
                    Target: WORK_DIR,
                    ReadOnly: false,
                },
            ],
            Tmpfs: {
                '/tmp': 'rw,nosuid,nodev,size=1073741824,mode=1777',
                [TOKEN_DIR]: 'rw,nosuid,nodev,noexec,size=65536,uid=1000,gid=1000,mode=0700',
            },
            ReadonlyRootfs: true,
            Privileged: false,
            CapDrop: ['ALL'],
            CapAdd: [],
            SecurityOpt: ['no-new-privileges:true'],
            NetworkMode: names.network,
            Dns: [...SANDBOX_DNS],
            DnsSearch: [],
            DnsOptions: [],
            ExtraHosts: [],
            PortBindings: {},
            PublishAllPorts: false,
            Devices: [],
            IpcMode: 'private',
            CgroupnsMode: 'private',
            NanoCpus: Math.round(resources.cpus * 1e9),
            Memory: resources.memoryBytes,
            MemorySwap: resources.memoryBytes,
            PidsLimit: resources.pids,
            Ulimits: [
                { Name: 'nofile', Soft: 4096, Hard: 8192 },
                { Name: 'core', Soft: 0, Hard: 0 },
            ],
            ShmSize: 64 * MiB,
            Init: true,
            RestartPolicy: { Name: 'no' },
            ...(config.runtime ? { Runtime: config.runtime } : {}),
        },
    };
}

const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
const empty = (value) =>
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && Object.keys(value).length === 0);
/**
 * The /proc and /sys paths Docker masks, or makes read-only, in every
 * unprivileged container (moby oci/defaults.go, stable since Docker 19.03;
 * later versions add more). An inspected sandbox must keep at least these:
 * fewer means it was created with `systempaths=unconfined` or its lists
 * cleared.
 */
export const REQUIRED_MASKED_PATHS = [
    '/proc/asound',
    '/proc/acpi',
    '/proc/kcore',
    '/proc/keys',
    '/proc/latency_stats',
    '/proc/timer_list',
    '/proc/timer_stats',
    '/proc/sched_debug',
    '/proc/scsi',
    '/sys/firmware',
];
export const REQUIRED_READONLY_PATHS = ['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger'];
const includesAll = (list, required) => Array.isArray(list) && required.every((entry) => list.includes(entry));
/** `NAME=value` entries as Docker merges them: the spec's win over the image's. */
const mergedEnv = (imageEnv, specEnv) => {
    const byName = new Map();
    for (const entry of [...imageEnv, ...specEnv]) byName.set(String(entry).split('=')[0], String(entry));
    return [...byName.values()].sort();
};
const sortedEntries = (object) =>
    Object.entries(object ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
const notHost = (mode) => !String(mode ?? '').startsWith('host') && !String(mode ?? '').startsWith('container:');

/**
 * What differs between an inspected container and the fixed spec, by field
 * name. Empty means it matches. `imageEnv` is the pinned image's
 * `Config.Env`, which Docker merges into the container's.
 */
export function specMismatches(info, expected, imageId, imageEnv = []) {
    const host = info?.HostConfig ?? {};
    const config = info?.Config ?? {};
    const want = expected.HostConfig;
    const out = [];
    const check = (ok, field) => {
        if (!ok) out.push(field);
    };
    check(config.Image === expected.Image, 'Config.Image');
    check(Boolean(imageId) && info?.Image === imageId, 'Image');
    check(config.User === SANDBOX_USER, 'Config.User');
    check(same(config.Entrypoint, expected.Entrypoint), 'Config.Entrypoint');
    check(same(config.Cmd, expected.Cmd), 'Config.Cmd');
    check(empty(config.ExposedPorts), 'Config.ExposedPorts');
    // The proxy, its credential and the managed config paths, and nothing
    // added (an LD_PRELOAD, a NO_PROXY), beyond the image's own.
    check(
        Array.isArray(config.Env) && same([...config.Env].map(String).sort(), mergedEnv(imageEnv, expected.Env)),
        'Config.Env',
    );
    check(
        config.Labels?.[LABELS.owner] === 'true' && config.Labels?.[LABELS.session] === expected.Labels[LABELS.session],
        'Config.Labels',
    );
    check(host.Privileged === false, 'HostConfig.Privileged');
    check(empty(host.CapAdd), 'HostConfig.CapAdd');
    check(
        Array.isArray(host.CapDrop) && host.CapDrop.map((cap) => String(cap).toUpperCase()).includes('ALL'),
        'HostConfig.CapDrop',
    );
    check(host.ReadonlyRootfs === true, 'HostConfig.ReadonlyRootfs');
    check(
        Array.isArray(host.SecurityOpt) &&
            host.SecurityOpt.some((option) => /^no-new-privileges(?::true|=true)?$/.test(option)) &&
            !host.SecurityOpt.some((option) => /unconfined/.test(option)),
        'HostConfig.SecurityOpt',
    );
    check(empty(host.Binds), 'HostConfig.Binds');
    check(same(host.Mounts, want.Mounts), 'HostConfig.Mounts');
    // Options too, not only the mount points: noexec, size, owner, mode.
    check(same(sortedEntries(host.Tmpfs), sortedEntries(want.Tmpfs)), 'HostConfig.Tmpfs');
    check(empty(host.Sysctls), 'HostConfig.Sysctls');
    check(includesAll(host.MaskedPaths, REQUIRED_MASKED_PATHS), 'HostConfig.MaskedPaths');
    check(includesAll(host.ReadonlyPaths, REQUIRED_READONLY_PATHS), 'HostConfig.ReadonlyPaths');
    check(host.OomKillDisable !== true, 'HostConfig.OomKillDisable');
    check(!host.CgroupParent, 'HostConfig.CgroupParent');
    const mounts = info?.Mounts ?? [];
    check(
        mounts.every((mount) => mount.Type === 'volume' || mount.Type === 'tmpfs') &&
            mounts.filter((mount) => mount.Type === 'volume').length === 1 &&
            mounts.some(
                (mount) =>
                    mount.Type === 'volume' && mount.Name === want.Mounts[0].Source && mount.Destination === WORK_DIR,
            ),
        'Mounts',
    );
    check(host.NetworkMode === want.NetworkMode, 'HostConfig.NetworkMode');
    const networks = Object.keys(info?.NetworkSettings?.Networks ?? {});
    check(networks.length === 0 || same(networks, [want.NetworkMode]), 'NetworkSettings.Networks');
    check(same(host.Dns, want.Dns), 'HostConfig.Dns');
    check(empty(host.DnsSearch), 'HostConfig.DnsSearch');
    check(empty(host.DnsOptions), 'HostConfig.DnsOptions');
    check(empty(host.ExtraHosts), 'HostConfig.ExtraHosts');
    check(empty(host.PortBindings), 'HostConfig.PortBindings');
    check(host.PublishAllPorts !== true, 'HostConfig.PublishAllPorts');
    check(empty(host.Devices), 'HostConfig.Devices');
    check(empty(host.DeviceRequests), 'HostConfig.DeviceRequests');
    check(empty(host.VolumesFrom), 'HostConfig.VolumesFrom');
    check(empty(host.Links), 'HostConfig.Links');
    for (const field of ['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'CgroupnsMode'])
        check(notHost(host[field]), `HostConfig.${field}`);
    check(host.NanoCpus === want.NanoCpus, 'HostConfig.NanoCpus');
    check(host.Memory === want.Memory, 'HostConfig.Memory');
    check(host.MemorySwap === want.MemorySwap, 'HostConfig.MemorySwap');
    check(host.PidsLimit === want.PidsLimit, 'HostConfig.PidsLimit');
    check(host.Init === true, 'HostConfig.Init');
    check(
        want.Runtime ? host.Runtime === want.Runtime : [undefined, '', 'runc'].includes(host.Runtime),
        'HostConfig.Runtime',
    );
    return out;
}

/** What differs between an inspected sandbox network and its spec. */
export function networkMismatches(info, expected, allowedMembers) {
    const out = [];
    const check = (ok, field) => {
        if (!ok) out.push(field);
    };
    check(info?.Name === expected.Name, 'Name');
    check(info?.Driver === 'bridge', 'Driver');
    check(info?.Internal === true, 'Internal');
    check(info?.EnableIPv6 !== true, 'EnableIPv6');
    check(info?.Attachable !== true, 'Attachable');
    const subnets = (info?.IPAM?.Config ?? []).map((entry) => entry.Subnet);
    check(same(subnets, [expected.IPAM.Config[0].Subnet]), 'IPAM.Config');
    check(info?.Labels?.[LABELS.owner] === 'true', 'Labels');
    for (const [key, value] of Object.entries(expected.Options))
        check(info?.Options?.[key] === value, `Options.${key}`);
    check(
        Object.keys(info?.Containers ?? {}).every((id) => allowedMembers.includes(id)),
        'Containers',
    );
    return out;
}

// ---------------------------------------------------------------------------
// Execs: a fixed set of argv, no shell.

const GIT_SAFE = [
    // Hooks, fsmonitor, pagers and external diff drivers planted in the
    // persistent workspace never run in Socio's own Git commands.
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.pager=cat',
    '-c',
    'diff.external=',
    // A planted global attributes file (`* -diff`) would hide content from
    // the person reading the diff.
    '-c',
    'core.attributesFile=/dev/null',
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.http.allow=always',
];

/**
 * The environment of Socio's own Git commands (setup, status, diff): never
 * the global config, which the agent can write under HOME=/tmp/home (a URL
 * rewrite, a credential helper, an include). The root-owned /etc/gitconfig
 * stays: its URL rewrite and credential helper are how Git reaches the
 * gateway. OpenCode's prompt keeps its own environment.
 */
const GIT_ENV = ['GIT_CONFIG_GLOBAL=/dev/null'];

const REPOSITORY = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
/** A branch name Git accepts and no option or revision syntax can hide in. */
const isRefName = (value) =>
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) &&
    !/\.\.|\/\/|@\{|\/$|\.$|\.lock$|\/\.|^\.|\.lock\//.test(value);
const OPENCODE_SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const TOKEN = /^cbgw_[A-Za-z0-9_-]{43}$/;
/** `<name> (Socio)`: never the person's name. */
const IDENTITY_NAME = /^[^\u0000-\u001f\u007f<>"\\]{1,80} \(Socio\)$/;
const IDENTITY_EMAIL = /^socio-[a-z0-9]{6,64}@users\.noreply\.[a-z0-9.-]{1,200}$/;

function identityEnv(identity) {
    if (typeof identity !== 'object' || identity === null) return undefined;
    if (onlyFields(identity, ['name', 'email'])) return undefined;
    if (!IDENTITY_NAME.test(identity.name ?? '') || !IDENTITY_EMAIL.test(identity.email ?? '')) return undefined;
    return [
        `GIT_AUTHOR_NAME=${identity.name}`,
        `GIT_AUTHOR_EMAIL=${identity.email}`,
        `GIT_COMMITTER_NAME=${identity.name}`,
        `GIT_COMMITTER_EMAIL=${identity.email}`,
    ];
}

/** A path inside the repository for `coding_diff`; no options, no pathspec magic. */
const isRepoPath = (value) =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 400 &&
    !/^[-:/]/.test(value) &&
    !/[\u0000-\u001f\u007f\\]/.test(value) &&
    !value.split('/').some((part) => part === '..' || part === '.git');

/** The coding agents a prompt may run (CB-326); `opencode` by default. */
export const HARNESSES = ['opencode', 'codex', 'claude-code', 'gemini-cli', 'grok'];
/** Codex's thread ids and Claude Code's, Gemini CLI's and Grok Build's session ids. */
const HARNESS_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The gateway as every harness sees it, through the coding egress proxy. */
export const GATEWAY_URL = 'http://gateway.socio.internal';
/**
 * Runs a harness with the prompt's token (write-token's file) in the one
 * variable that harness reads its key from; the app never sees argv, and
 * the token never goes in the exec's environment or argv.
 */
const WITH_TOKEN = `${SANDBOX_TOOLS}/with-token`;
/** Writes Grok Build's per-run config.toml, then runs `grok` (CB-326). */
const GROK_SOCIO = `${SANDBOX_TOOLS}/grok-socio`;
/** Where Grok Build keeps its config and sessions: under the sandbox's tmpfs HOME. */
export const GROK_HOME = '/tmp/home/.grok';
/**
 * A name no MCP server is given: Gemini CLI then connects to none, whatever
 * a repository's .gemini/settings.json lists (its allowlist only filters
 * when it names something).
 */
export const GEMINI_NO_MCP = 'socio-none';

/**
 * Codex's settings for the gateway route, as `-c` overrides (they win over
 * any config.toml the agent could write under HOME): the gateway is its
 * only model provider, on the Responses API, with the session's token as
 * the provider's key (never an OpenAI login); approvals and Codex's own
 * sandbox off, as the container is the boundary; update checks, web
 * search (a provider-side tool the gateway refuses), analytics and history
 * off. Convenience only: the network is the enforcement.
 */
export const CODEX_OVERRIDES = [
    'model_provider="socio"',
    'model_providers.socio.name="Socio"',
    `model_providers.socio.base_url="${GATEWAY_URL}/v1"`,
    'model_providers.socio.env_key="SOCIO_GATEWAY_TOKEN"',
    'model_providers.socio.wire_api="responses"',
    'model_providers.socio.requires_openai_auth=false',
    'approval_policy="never"',
    'sandbox_mode="danger-full-access"',
    'check_for_update_on_startup=false',
    'web_search="disabled"',
    'analytics.enabled=false',
    'history.persistence="none"',
];

/**
 * Claude Code's environment for the gateway route: the gateway's Messages
 * endpoint (`<base>/v1/messages`), the session's model for every model
 * role (the gateway serves only the session's), and no telemetry, error
 * reports, auto-updates, experimental betas or other non-essential
 * traffic. Its token comes from with-token as ANTHROPIC_AUTH_TOKEN (a
 * bearer, which is what the gateway takes); never an Anthropic login.
 */
function claudeCodeEnv(model) {
    return [
        `ANTHROPIC_BASE_URL=${GATEWAY_URL}`,
        `ANTHROPIC_MODEL=${model}`,
        `ANTHROPIC_DEFAULT_OPUS_MODEL=${model}`,
        `ANTHROPIC_DEFAULT_SONNET_MODEL=${model}`,
        `ANTHROPIC_DEFAULT_HAIKU_MODEL=${model}`,
        `ANTHROPIC_SMALL_FAST_MODEL=${model}`,
        `CLAUDE_CODE_SUBAGENT_MODEL=${model}`,
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
        'DISABLE_AUTOUPDATER=1',
        'DISABLE_TELEMETRY=1',
        'DISABLE_ERROR_REPORTING=1',
        'DISABLE_BUG_COMMAND=1',
        'DISABLE_NON_ESSENTIAL_MODEL_CALLS=1',
        'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1',
    ];
}

/**
 * Gemini CLI's environment for the gateway route (CB-326): with
 * `GOOGLE_GEMINI_BASE_URL` set it uses its `gateway` auth, sending the
 * Gemini API (`/v1beta/models/<model>:streamGenerateContent`) to that base
 * with `GEMINI_API_KEY` (from with-token) as its `x-goog-api-key`; never a
 * Google login. The root-owned system settings file
 * (/etc/gemini-cli/settings.json, deployment/coding/gemini-settings.json)
 * wins over any the agent or the repository writes: telemetry, usage
 * statistics, updates, MCP, extensions and the web tools off, every helper
 * model alias (compression, loop detection, edit fixing…) on
 * `SOCIO_GEMINI_MODEL`, the session's model, as the gateway serves no other.
 * No self-relaunch (a child process with a larger heap).
 */
function geminiCliEnv(model) {
    return [
        `GOOGLE_GEMINI_BASE_URL=${GATEWAY_URL}`,
        `GEMINI_MODEL=${model}`,
        `SOCIO_GEMINI_MODEL=${model}`,
        'GEMINI_CLI_SYSTEM_SETTINGS_PATH=/etc/gemini-cli/settings.json',
        'GEMINI_CLI_TRUST_WORKSPACE=true',
        'GEMINI_CLI_NO_RELAUNCH=true',
        'GEMINI_TELEMETRY_ENABLED=false',
    ];
}

/**
 * Grok Build's environment (CB-326): its home under the tmpfs HOME
 * (grok-socio writes its config.toml there each run: the gateway's
 * Responses API, the one Grok Build uses for xAI's own models, the token
 * from with-token as SOCIO_GATEWAY_TOKEN), and no
 * update checks, cross-session memory or feedback.
 */
function grokEnv() {
    return [`GROK_HOME=${GROK_HOME}`, 'GROK_DISABLE_AUTOUPDATER=1', 'GROK_MEMORY=0', 'GROK_FEEDBACK_ENABLED=false'];
}

/** One harness's argv and environment for a checked prompt (`p`). */
function harnessRun(harness, p) {
    if (harness === 'codex') {
        // `codex exec`, headless, JSON events; `resume <thread>` continues
        // the session's thread; `-` reads the prompt from stdin.
        return {
            argv: [
                WITH_TOKEN,
                'SOCIO_GATEWAY_TOKEN',
                'codex',
                'exec',
                '--json',
                '--color',
                'never',
                '--skip-git-repo-check',
                '--dangerously-bypass-approvals-and-sandbox',
                '--model',
                p.model,
                ...CODEX_OVERRIDES.flatMap((value) => ['-c', value]),
                ...(p.session ? ['resume', p.session] : []),
                '-',
            ],
            env: [],
        };
    }
    if (harness === 'claude-code') {
        // `claude -p`, headless, stream JSON; permission prompts off
        // (bypassPermissions: the container is the boundary; it runs as uid
        // 1000, never root), no MCP servers, no web tools (the
        // gateway refuses provider-side tools; the network refuses the
        // rest); `--resume <id>` continues; the prompt on stdin.
        return {
            argv: [
                WITH_TOKEN,
                'ANTHROPIC_AUTH_TOKEN',
                'claude',
                '-p',
                '--output-format',
                'stream-json',
                '--verbose',
                '--model',
                p.model,
                '--permission-mode',
                'bypassPermissions',
                '--strict-mcp-config',
                '--disallowedTools',
                'WebFetch',
                'WebSearch',
                ...(p.session ? ['--resume', p.session] : []),
            ],
            env: claudeCodeEnv(p.model),
        };
    }
    if (harness === 'gemini-cli') {
        // `gemini` headless (stdin isn't a terminal, so it reads the prompt
        // there), stream JSON events, every tool approved (the container is
        // the boundary; it runs as uid 1000), no MCP server; `--resume <id>`
        // continues the session its first prompt's `init` event named.
        return {
            argv: [
                WITH_TOKEN,
                'GEMINI_API_KEY',
                'gemini',
                '--output-format',
                'stream-json',
                '--model',
                p.model,
                '--approval-mode',
                'yolo',
                '--allowed-mcp-server-names',
                GEMINI_NO_MCP,
                ...(p.session ? ['--resume', p.session] : []),
            ],
            env: geminiCliEnv(p.model),
        };
    }
    if (harness === 'grok') {
        // `grok` headless through grok-socio (its per-run config.toml), the
        // xAI stream JSON, the prompt read from stdin as its prompt file
        // (headless Grok Build doesn't read piped stdin otherwise), every
        // tool approved, no web search or fetch (xAI-hosted, and the
        // network refuses them), no update check; `--resume <id>` continues.
        return {
            argv: [
                WITH_TOKEN,
                'SOCIO_GATEWAY_TOKEN',
                GROK_SOCIO,
                p.model,
                '--output-format',
                'streaming-json',
                '--prompt-file',
                '/dev/stdin',
                '--model',
                'socio',
                '--yolo',
                '--disable-web-search',
                '--no-auto-update',
                ...(p.session ? ['--resume', p.session] : []),
            ],
            env: grokEnv(),
        };
    }
    const provider = p.api === 'responses' ? 'socio-responses' : 'socio';
    return {
        // Headless `opencode run`, never `opencode serve`; its own
        // in-process server (--standalone), JSON events, the prompt on
        // stdin (never argv or the environment).
        argv: [
            'opencode',
            'run',
            '--standalone',
            '--format',
            'json',
            '--session',
            p.session,
            '--model',
            `${provider}/${p.model}`,
            '--auto',
        ],
        env: [
            `OPENCODE_CONFIG_CONTENT=${JSON.stringify({
                model: `${provider}/${p.model}`,
                providers: {
                    [provider]: { models: { [p.model]: { name: p.model } } },
                },
            })}`,
        ],
    };
}

const KINDS = ['token', 'setup', 'prompt', 'status', 'diff', 'changes'];

/**
 * The argv, environment, stdin, time limit and output cap of one exec, or
 * the reason it is refused. `params` holds only the kind's own fields.
 */
export function execPlan(kind, params, config) {
    const wrap = (seconds, argv) => ['timeout', '-k', '10s', `${seconds}s`, ...argv];
    const fields = {
        token: ['token'],
        setup: ['repository', 'base', 'branch', 'identity'],
        prompt: ['harness', 'session', 'model', 'prompt', 'seconds', 'identity', 'api'],
        status: [],
        diff: ['base', 'path'],
        changes: ['base'],
    }[kind];
    if (!fields) return fail(`kind must be one of ${KINDS.join(', ')}.`);
    const unknown = onlyFields(params ?? {}, fields);
    if (unknown) return fail(unknown);
    const p = params ?? {};
    switch (kind) {
        case 'token':
            if (!TOKEN.test(p.token ?? '')) return fail('token must be a cbgw_ credential.');
            return {
                ok: true,
                value: {
                    argv: wrap(10, [`${SANDBOX_TOOLS}/write-token`]),
                    env: [],
                    stdin: p.token,
                    seconds: 10,
                    cap: 4096,
                },
            };
        case 'setup': {
            const env = identityEnv(p.identity);
            if (!REPOSITORY.test(p.repository ?? '') || String(p.repository).includes('..'))
                return fail('repository must be owner/name.');
            if (!isRefName(p.base) || !isRefName(p.branch)) return fail('base and branch must be branch names.');
            if (!env) return fail('identity must be the socio’s: "<name> (Socio)" and its noreply address.');
            return {
                ok: true,
                value: {
                    argv: wrap(600, [`${SANDBOX_TOOLS}/setup`, p.repository, p.base, p.branch]),
                    env: [...env, ...GIT_ENV],
                    seconds: 600,
                    cap: 64 * 1024,
                },
            };
        }
        case 'prompt': {
            const env = identityEnv(p.identity);
            const harness = p.harness ?? 'opencode';
            if (!HARNESSES.includes(harness)) return fail(`harness must be one of ${HARNESSES.join(', ')}.`);
            if (harness === 'opencode') {
                if (!OPENCODE_SESSION.test(p.session ?? '')) return fail('session must be an OpenCode session id.');
            } else if (p.session !== undefined && !HARNESS_SESSION.test(p.session)) {
                // Absent: the session's first prompt, which starts one.
                return fail('session must be the harness’s session id (a UUID).');
            }
            if (!MODEL.test(p.model ?? '')) return fail('model must be a gateway model name.');
            if (typeof p.prompt !== 'string' || !p.prompt.trim() || Buffer.byteLength(p.prompt) > 256 * 1024)
                return fail('prompt must be text up to 256 KB.');
            if (!env) return fail('identity must be the socio’s: "<name> (Socio)" and its noreply address.');
            const seconds = clamp(p.seconds, 60, config.ceilings.promptSeconds, 1200);
            if (seconds === undefined) return fail('seconds must be a number.');
            // Which of the gateway's APIs OpenCode speaks (CB-239): Chat
            // Completions by default; Responses for a session on the person's
            // own plan. Each is one of the managed config's two providers, both
            // pointed at the gateway with the session's token. Codex speaks
            // Responses, Claude Code Messages, Gemini CLI the Gemini API and
            // Grok Build Responses (its own wire API for xAI's models), always.
            if (p.api !== undefined && p.api !== 'chat' && p.api !== 'responses')
                return fail('api must be chat or responses.');
            if (p.api !== undefined && harness !== 'opencode') return fail('api is for OpenCode only.');
            const run = harnessRun(harness, p);
            return {
                ok: true,
                value: {
                    argv: wrap(Math.floor(seconds), run.argv),
                    env: [...env, ...run.env],
                    stdin: p.prompt,
                    workdir: REPO_DIR,
                    seconds: Math.floor(seconds),
                    cap: 4 * 1024 * 1024,
                },
            };
        }
        case 'status':
            return {
                ok: true,
                value: {
                    argv: wrap(60, ['git', ...GIT_SAFE, '-C', REPO_DIR, 'status', '--porcelain=v2', '--branch']),
                    env: [...GIT_ENV],
                    seconds: 60,
                    cap: 256 * 1024,
                },
            };
        case 'diff':
        case 'changes': {
            if (!isRefName(p.base)) return fail('base must be a branch name.');
            if (p.path !== undefined && !isRepoPath(p.path))
                return fail('path must be a plain path in the repository.');
            const range = `refs/remotes/origin/${p.base}...HEAD`;
            const what =
                kind === 'diff'
                    ? [
                          'diff',
                          '--no-ext-diff',
                          '--no-textconv',
                          // Content, even where `.gitattributes` or `.git/info/attributes`
                          // says `-diff`: never "Binary files differ".
                          '--text',
                          '--no-color',
                          '--find-renames',
                          range,
                          '--',
                          ...(p.path ? [p.path] : []),
                      ]
                    : [
                          'diff',
                          '--name-status',
                          '--no-ext-diff',
                          '--no-textconv',
                          '--no-color',
                          '--find-renames',
                          range,
                      ];
            return {
                ok: true,
                value: {
                    argv: wrap(120, ['git', ...GIT_SAFE, '-C', REPO_DIR, ...what]),
                    env: ['GIT_LITERAL_PATHSPECS=1', ...GIT_ENV],
                    seconds: 120,
                    cap: 256 * 1024,
                },
            };
        }
    }
    return fail('Unknown kind.');
}

/** Keeps the last `cap` bytes of a stream. */
class Tail {
    constructor(cap) {
        this.cap = cap;
        this.chunks = [];
        this.size = 0;
        this.truncated = false;
    }
    write(chunk) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.chunks.push(buffer);
        this.size += buffer.length;
        while (this.size > this.cap && this.chunks.length) {
            const over = this.size - this.cap;
            const first = this.chunks[0];
            if (first.length <= over) {
                this.chunks.shift();
                this.size -= first.length;
            } else {
                this.chunks[0] = first.subarray(over);
                this.size -= over;
            }
            this.truncated = true;
        }
        return true;
    }
    text() {
        return Buffer.concat(this.chunks).toString('utf8');
    }
}

/** Docker's multiplexed log frames (8-byte headers) → stdout text. */
export function demuxLogs(buffer) {
    const out = [];
    let offset = 0;
    while (offset + 8 <= buffer.length) {
        const type = buffer[offset];
        const size = buffer.readUInt32BE(offset + 4);
        if (type === 1) out.push(buffer.subarray(offset + 8, offset + 8 + size));
        offset += 8 + size;
    }
    return Buffer.concat(out).toString('utf8');
}

/** The egress probe's report (deployment/coding/egress-probe.mjs) → a verdict. */
export function probeVerdict(exitCode, output) {
    const line = String(output ?? '')
        .trim()
        .split('\n')
        .reverse()
        .find((entry) => entry.startsWith('{"probe":"socio-egress-probe"'));
    if (exitCode !== 0 || !line) return { ok: false, failures: ['the egress probe did not report'] };
    let report;
    try {
        report = JSON.parse(line);
    } catch {
        return { ok: false, failures: ['the egress probe report is not JSON'] };
    }
    if (!Array.isArray(report.resolved) || !Array.isArray(report.reached) || typeof report.tunnel !== 'boolean')
        return { ok: false, failures: ['the egress probe report is incomplete'] };
    const failures = [
        ...report.resolved.map((name) => `resolved ${String(name).slice(0, 100)}`),
        ...report.reached.map((target) => `reached ${String(target).slice(0, 100)}`),
        ...(report.tunnel ? ['the proxy opened a tunnel'] : []),
    ];
    return { ok: failures.length === 0, failures };
}

const statusOf = (error) => error?.statusCode;

class ApiError extends Error {
    constructor(status, message, extra) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

/**
 * The sandbox API over a Docker client (dockerode in the supervisor, a fake
 * in the tests). `handle(method, path, body, query)` answers
 * `{ status, body }`.
 */
export function createSandboxApi({ docker, config, log = console.log, now = Date.now }) {
    const runs = new Map();
    const hosts = new Map();
    const locks = new Map();
    let selfTest = {
        ok: false,
        mode: config.mode,
        checkedAt: undefined,
        failures: ['not run yet'],
    };
    let selfTestRunning;

    const owned = (labels) => labels?.[LABELS.owner] === 'true' && labels?.[LABELS.namespace] === config.namespace;

    /** Serializes work on one session (create, start, delete). */
    const locked = async (key, fn) => {
        const previous = locks.get(key) ?? Promise.resolve();
        let release;
        const current = new Promise((resolve) => (release = resolve));
        locks.set(
            key,
            previous.then(() => current),
        );
        await previous;
        try {
            return await fn();
        } finally {
            release();
            if (locks.get(key) === current) locks.delete(key);
        }
    };

    async function inspectOwned(getter) {
        try {
            const info = await getter.inspect();
            const labels = info?.Config?.Labels ?? info?.Labels;
            if (!owned(labels))
                throw new ApiError(409, 'A resource with this name exists and is not a coding sandbox’s.');
            return info;
        } catch (error) {
            if (statusOf(error) === 404) return undefined;
            throw error;
        }
    }

    async function egressProxy() {
        const found = await docker.listContainers({
            filters: {
                label: [`${EGRESS_LABEL}=${config.namespace}`],
                status: ['running'],
            },
        });
        if (found.length !== 1)
            throw new ApiError(
                503,
                'The coding egress proxy is not running (exactly one container labelled for this namespace).',
            );
        return found[0].Id;
    }

    async function ownedNetworks() {
        const list = await docker.listNetworks({
            filters: { label: [`${LABELS.owner}=true`] },
        });
        return list.filter((network) => owned(network.Labels));
    }

    async function ensureVolume(names) {
        try {
            await docker.createVolume({
                Name: names.volume,
                Labels: { ...ownLabels(config), [LABELS.volume]: names.volumeKey },
            });
        } catch (error) {
            if (statusOf(error) !== 409) throw error;
        }
        const info = await docker.getVolume(names.volume).inspect();
        if (!owned(info?.Labels)) throw new ApiError(409, 'The workspace volume name is held by something else.');
    }

    async function removeQuietly(fn) {
        try {
            await fn();
        } catch (error) {
            if (![404, 304].includes(statusOf(error)))
                log(`coding-sandbox: cleanup failed (${String(error?.message ?? error).slice(0, 200)})`);
        }
    }

    async function removeSandbox(names, proxyId) {
        await removeQuietly(() => docker.getContainer(names.container).remove({ force: true, v: false }));
        if (proxyId)
            await removeQuietly(() => docker.getNetwork(names.network).disconnect({ Container: proxyId, Force: true }));
        await removeQuietly(() => docker.getNetwork(names.network).remove());
    }

    /** Network, proxy membership and the proxy's address on it. */
    async function createNetwork(names, resources, proxyId) {
        const used = new Set(
            (await ownedNetworks()).flatMap((network) => (network.IPAM?.Config ?? []).map((entry) => entry.Subnet)),
        );
        let spec;
        for (let attempt = 0; attempt < 5; attempt++) {
            const subnet = allocateSubnet(config.pool, used);
            if (!subnet) throw new ApiError(503, 'No free sandbox subnet is left in CODING_SANDBOX_SUBNETS.');
            spec = networkSpec(config, names, subnet, resources);
            try {
                await docker.createNetwork(spec);
                break;
            } catch (error) {
                // Another network took that range (a race, or one outside this pool).
                if (/overlap/i.test(String(error?.message ?? '')) && attempt < 4) {
                    used.add(subnet);
                    spec = undefined;
                    continue;
                }
                if (statusOf(error) === 409) throw new ApiError(409, 'The sandbox network already exists.');
                throw error;
            }
        }
        await docker.getNetwork(names.network).connect({ Container: proxyId });
        const info = await docker.getNetwork(names.network).inspect();
        const mismatches = networkMismatches(info, spec, [proxyId]);
        const proxyAddress = String(info?.Containers?.[proxyId]?.IPv4Address ?? '').split('/')[0];
        if (mismatches.length || !proxyAddress) {
            await removeSandbox(names, proxyId);
            throw new ApiError(500, 'The sandbox network did not match its fixed spec; it was removed.', {
                fields: mismatches.length ? mismatches : ['proxy address'],
            });
        }
        return { subnet: spec.IPAM.Config[0].Subnet, proxyAddress, info };
    }

    /** Create, inspect against the fixed spec (removing it on any difference), start. */
    async function createContainer(spec, names, proxyId) {
        let imageId;
        let imageEnv;
        try {
            const image = await docker.getImage(config.image).inspect();
            imageId = image?.Id;
            // Pinned by local ID: the image found must be that one exactly.
            if (IMAGE_ID.test(config.image) && imageId !== config.image)
                throw new ApiError(503, 'The pinned coding sandbox image is not on this host.');
            imageEnv = Array.isArray(image?.Config?.Env) ? image.Config.Env : [];
        } catch (error) {
            if (statusOf(error) === 404)
                throw new ApiError(503, 'The pinned coding sandbox image is not on this host.');
            throw error;
        }
        try {
            await docker.createContainer(spec);
        } catch (error) {
            if (statusOf(error) === 409) throw new ApiError(409, 'The sandbox container already exists.');
            throw error;
        }
        const container = docker.getContainer(names.container);
        const mismatches = specMismatches(await container.inspect(), spec, imageId, imageEnv);
        if (mismatches.length) {
            log(`coding-sandbox: removed ${names.container}: spec mismatch in ${mismatches.join(', ')}`);
            await removeQuietly(() => container.remove({ force: true, v: false }));
            throw new ApiError(500, 'The sandbox did not match its fixed spec; it was removed.', {
                fields: mismatches,
            });
        }
        await container.start();
        const running = await container.inspect();
        const after = specMismatches(running, spec, imageId, imageEnv);
        if (after.length || running?.State?.Running !== true) {
            await removeQuietly(() => container.remove({ force: true, v: false }));
            throw new ApiError(500, 'The sandbox did not start as specified; it was removed.', {
                fields: after.length ? after : ['State.Running'],
            });
        }
        return container;
    }

    async function runSelfTest() {
        if (!config.enabled) {
            selfTest = {
                ok: false,
                mode: config.mode,
                checkedAt: now(),
                failures: [config.reason],
            };
            return selfTest;
        }
        if (selfTestRunning) return selfTestRunning;
        selfTestRunning = (async () => {
            const names = sandboxNames(config.namespace, SELF_TEST, 'f'.repeat(64));
            let proxyId;
            try {
                proxyId = await egressProxy();
                await removeSandbox(names, proxyId);
                await ensureVolume(names);
                const resources = { cpus: 0.5, memoryBytes: 256 * MiB, pids: 128 };
                const { info, proxyAddress } = await createNetwork(names, resources, proxyId);
                const subnet = parseCidr(info.IPAM.Config[0].Subnet);
                const gateway = info.IPAM.Config[0].Gateway || ipOf(subnet.base + 1);
                const spec = containerSpec(
                    config,
                    names,
                    resources,
                    { address: proxyAddress, user: 'selftest', password: 'selftest' },
                    ['node', `${SANDBOX_TOOLS}/egress-probe.mjs`, gateway, proxyAddress],
                );
                const container = await createContainer(spec, names, proxyId);
                const waited = await Promise.race([
                    container.wait(),
                    new Promise((resolve) => setTimeout(() => resolve({ StatusCode: -1 }), 90_000).unref?.()),
                ]);
                const logs = await container.logs({
                    stdout: true,
                    stderr: false,
                    follow: false,
                });
                const output = Buffer.isBuffer(logs) ? demuxLogs(logs) : String(logs ?? '');
                const verdict = probeVerdict(waited?.StatusCode, output);
                selfTest = {
                    ok: verdict.ok,
                    mode: config.mode,
                    checkedAt: now(),
                    failures: verdict.failures,
                };
            } catch (error) {
                selfTest = {
                    ok: false,
                    mode: config.mode,
                    checkedAt: now(),
                    failures: [`the self-test could not run: ${String(error?.message ?? error).slice(0, 200)}`],
                };
            } finally {
                await removeSandbox(names, proxyId);
                await removeQuietly(() => docker.getVolume(names.volume).remove());
                selfTestRunning = undefined;
            }
            log(
                selfTest.ok
                    ? 'coding-sandbox: egress self-test passed'
                    : `coding-sandbox: egress self-test FAILED, no sandboxes will be created: ${selfTest.failures.join('; ')}`,
            );
            return selfTest;
        })();
        return selfTestRunning;
    }

    async function requireSelfTest() {
        if (!selfTest.ok && (!selfTest.checkedAt || now() - selfTest.checkedAt > 60_000)) await runSelfTest();
        if (!selfTest.ok)
            throw new ApiError(503, 'The coding egress self-test has not passed; no sandboxes are created.', {
                failures: selfTest.failures,
            });
    }

    async function create(body) {
        const parsed = parseCreateRequest(body, config);
        if (!parsed.ok) throw new ApiError(400, parsed.reason);
        const request = parsed.value;
        await requireSelfTest();
        const names = sandboxNames(config.namespace, request.sessionId, request.volumeKey);
        return locked(request.sessionId, async () => {
            const proxyId = await egressProxy();
            const existing = await inspectOwned(docker.getNetwork(names.network));
            if (existing) {
                if (existing.Labels?.[LABELS.volume] !== request.volumeKey)
                    throw new ApiError(409, 'This session already has a sandbox with another workspace.');
                if (await inspectOwned(docker.getContainer(names.container)))
                    throw new ApiError(409, 'This session’s sandbox is already started.');
                const proxyAddress = String(existing.Containers?.[proxyId]?.IPv4Address ?? '').split('/')[0];
                return {
                    status: 200,
                    body: {
                        sessionId: names.sessionId,
                        state: 'network-ready',
                        subnet: existing.IPAM?.Config?.[0]?.Subnet,
                        proxyAddress: `${proxyAddress}:${PROXY_PORT}`,
                    },
                };
            }
            // Counted and created under one lock across sessions: two creates
            // can't both see room for one more (CODING_SANDBOX_MAX).
            return locked(CREATES, async () => {
                if (
                    (await ownedNetworks()).filter((network) => network.Labels?.[LABELS.session] !== SELF_TEST)
                        .length >= config.ceilings.sandboxes
                )
                    throw new ApiError(429, 'The supervisor’s sandbox ceiling (CODING_SANDBOX_MAX) is reached.');
                await ensureVolume(names);
                const { subnet, proxyAddress } = await createNetwork(names, request, proxyId);
                log(`coding-sandbox: network ready for ${names.sessionId}`);
                return {
                    status: 201,
                    body: {
                        sessionId: names.sessionId,
                        state: 'network-ready',
                        subnet,
                        proxyAddress: `${proxyAddress}:${PROXY_PORT}`,
                    },
                };
            });
        });
    }

    async function start(sessionId, body) {
        const parsed = parseStartRequest(body);
        if (!parsed.ok) throw new ApiError(400, parsed.reason);
        await requireSelfTest();
        return locked(sessionId, async () => {
            const network = await inspectOwned(docker.getNetwork(`${config.namespace}-code-${sessionId}`));
            if (!network) throw new ApiError(404, 'No sandbox network for this session; create it first.');
            const volumeKey = network.Labels?.[LABELS.volume];
            if (!VOLUME_KEY.test(volumeKey ?? '')) throw new ApiError(409, 'The sandbox network has no workspace key.');
            const names = sandboxNames(config.namespace, sessionId, volumeKey);
            if (await inspectOwned(docker.getContainer(names.container)))
                throw new ApiError(409, 'This session’s sandbox is already started.');
            // The resources were clamped at create; clamp again in case the ceilings fell since.
            const again = parseCreateRequest(
                {
                    sessionId,
                    volumeKey,
                    cpus: Number(network.Labels?.[LABELS.cpus]),
                    memoryBytes: Number(network.Labels?.[LABELS.memory]),
                    pids: Number(network.Labels?.[LABELS.pids]),
                },
                config,
            );
            if (!again.ok) throw new ApiError(409, 'The sandbox network’s labels are not usable.');
            const proxyId = await egressProxy();
            const proxyAddress = String(network.Containers?.[proxyId]?.IPv4Address ?? '').split('/')[0];
            if (!proxyAddress) throw new ApiError(409, 'The coding egress proxy is not on this sandbox’s network.');
            const spec = containerSpec(config, names, again.value, {
                address: proxyAddress,
                ...parsed.value,
            });
            // The volume is (re)made with its labels before the container names
            // it: Docker would otherwise create it unlabeled, and the workspace
            // would answer 409 forever.
            await ensureVolume(names);
            await createContainer(spec, names, proxyId);
            log(`coding-sandbox: started ${names.sessionId}`);
            return { status: 200, body: { sessionId, state: 'running' } };
        });
    }

    async function remove(sessionId) {
        return locked(sessionId, async () => {
            const network = await inspectOwned(docker.getNetwork(`${config.namespace}-code-${sessionId}`));
            const container = await inspectOwned(docker.getContainer(`${config.namespace}-code-${sessionId}`));
            if (!network && !container) return { status: 200, body: { removed: false } };
            let proxyId;
            try {
                proxyId = await egressProxy();
            } catch {
                proxyId = Object.keys(network?.Containers ?? {}).find((id) => !container || id !== container.Id);
            }
            await removeSandbox(sandboxNames(config.namespace, sessionId, 'x'), proxyId);
            for (const [runId, run] of runs) if (run.sessionId === sessionId) runs.delete(runId);
            forgetHost(sessionId);
            log(`coding-sandbox: removed ${sessionId}`);
            return { status: 200, body: { removed: true } };
        });
    }

    async function list() {
        const networks = await ownedNetworks();
        const containers = (
            await docker.listContainers({
                all: true,
                filters: { label: [`${LABELS.owner}=true`] },
            })
        ).filter((container) => owned(container.Labels));
        const sandboxes = networks
            .filter((network) => network.Labels?.[LABELS.session] !== SELF_TEST)
            .map((network) => {
                const sessionId = network.Labels?.[LABELS.session];
                const container = containers.find((entry) => entry.Labels?.[LABELS.session] === sessionId);
                return {
                    sessionId,
                    state: container ? container.State : 'network-ready',
                    ...(container?.Created ? { startedAt: new Date(container.Created * 1000).toISOString() } : {}),
                };
            });
        // A container whose network is gone is listed too, so the leader's
        // reaper sees it (and its workspace volume is freed).
        const sessions = new Set(networks.map((network) => network.Labels?.[LABELS.session]));
        for (const container of containers) {
            const sessionId = container.Labels?.[LABELS.session];
            if (typeof sessionId !== 'string' || sessionId === SELF_TEST || sessions.has(sessionId)) continue;
            sessions.add(sessionId);
            sandboxes.push({
                sessionId,
                state: container.State,
                networkMissing: true,
                ...(container.Created ? { startedAt: new Date(container.Created * 1000).toISOString() } : {}),
            });
        }
        return { status: 200, body: { sandboxes } };
    }

    async function removeWorkspace(volumeKey) {
        if (!VOLUME_KEY.test(volumeKey))
            throw new ApiError(400, 'The workspace key must be 64 lowercase hex characters.');
        const names = sandboxNames(config.namespace, 'x', volumeKey);
        // Under the creates' lock, so no network for it appears meanwhile.
        return locked(CREATES, async () => {
            const containers = (
                await docker.listContainers({
                    all: true,
                    filters: { label: [`${LABELS.volume}=${volumeKey}`] },
                })
            ).filter((container) => owned(container.Labels));
            // A network-ready sandbox mounts it at start: refused too.
            const networks = (await ownedNetworks()).filter((network) => network.Labels?.[LABELS.volume] === volumeKey);
            if (containers.length || networks.length)
                throw new ApiError(409, 'A sandbox still uses this workspace; stop it first.');
            const volume = await inspectOwned(docker.getVolume(names.volume));
            if (!volume) return { status: 200, body: { removed: false } };
            await docker.getVolume(names.volume).remove();
            return { status: 200, body: { removed: true } };
        });
    }

    const view = (run) => ({
        runId: run.runId,
        kind: run.kind,
        state: run.state,
        ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
        stdout: run.stdout.text(),
        stderr: run.stderr.text(),
        truncated: { stdout: run.stdout.truncated, stderr: run.stderr.truncated },
        startedAt: new Date(run.startedAt).toISOString(),
        ...(run.endedAt ? { endedAt: new Date(run.endedAt).toISOString() } : {}),
    });

    const waitFor = async (run, seconds) => {
        if (!seconds || run.state !== 'running') return;
        await Promise.race([run.done, new Promise((resolve) => setTimeout(resolve, seconds * 1000).unref?.())]);
    };

    const waitSeconds = (raw) => {
        if (raw === undefined || raw === null || raw === '') return 0;
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) throw new ApiError(400, 'wait must be a number of seconds.');
        return Math.min(value, 60);
    };

    function prune() {
        const cutoff = now() - 3600_000;
        for (const [runId, run] of runs) if (run.endedAt && run.endedAt < cutoff) runs.delete(runId);
        if (runs.size < 512) return true;
        for (const [runId, run] of runs)
            if (run.endedAt) {
                runs.delete(runId);
                return true;
            }
        return false;
    }

    async function exec(sessionId, body) {
        const unknown = onlyFields(body, ['runId', 'kind', 'params', 'wait']);
        if (unknown) throw new ApiError(400, unknown);
        if (typeof body.runId !== 'string' || !RUN_ID.test(body.runId))
            throw new ApiError(400, 'runId must be 1–64 letters, digits, "-" or "_".');
        const wait = waitSeconds(body.wait);
        const existing = runs.get(body.runId);
        if (existing) {
            // A retried request re-attaches instead of running twice.
            if (existing.sessionId !== sessionId || existing.kind !== body.kind)
                throw new ApiError(409, 'This run id is taken.');
            await waitFor(existing, wait);
            return { status: 200, body: view(existing) };
        }
        const plan = execPlan(body.kind, body.params, config);
        if (!plan.ok) throw new ApiError(400, plan.reason);
        const container = docker.getContainer(`${config.namespace}-code-${sessionId}`);
        const info = await inspectOwned(container);
        if (!info) throw new ApiError(404, 'No sandbox for this session.');
        if (info.State?.Running !== true) throw new ApiError(409, 'The sandbox is not running.');
        const active = [...runs.values()].filter((run) => run.sessionId === sessionId && run.state === 'running');
        if (active.length >= 4) throw new ApiError(429, 'Too many execs are running in this sandbox.');
        if (['setup', 'prompt'].includes(body.kind) && active.some((run) => ['setup', 'prompt'].includes(run.kind)))
            throw new ApiError(409, 'A setup or prompt is already running in this sandbox.');
        if (!prune()) throw new ApiError(503, 'Too many execs are being kept; collect finished ones first.');
        const { argv, env, stdin, cap, workdir } = plan.value;
        const run = {
            runId: body.runId,
            sessionId,
            kind: body.kind,
            state: 'running',
            stdout: new Tail(cap),
            stderr: new Tail(64 * 1024),
            startedAt: now(),
        };
        let finish;
        run.done = new Promise((resolve) => (finish = resolve));
        runs.set(run.runId, run);
        let handle;
        let stream;
        try {
            handle = await container.exec({
                Cmd: argv,
                Env: env,
                User: SANDBOX_USER,
                WorkingDir: workdir ?? WORK_DIR,
                AttachStdin: stdin !== undefined,
                AttachStdout: true,
                AttachStderr: true,
                Tty: false,
                Privileged: false,
            });
            stream = await handle.start({
                hijack: true,
                stdin: stdin !== undefined,
            });
        } catch (error) {
            // Never left "running": the run ends as failed, and the caller learns why.
            run.state = 'failed';
            run.endedAt = now();
            finish();
            throw error;
        }
        docker.modem.demuxStream(stream, run.stdout, run.stderr);
        let settled = false;
        const settle = async () => {
            if (settled) return;
            settled = true;
            try {
                const result = await handle.inspect();
                run.exitCode = result?.ExitCode ?? undefined;
            } catch {
                run.exitCode = undefined;
            }
            run.state = run.exitCode === 124 ? 'timed-out' : run.exitCode === undefined ? 'failed' : 'exited';
            run.endedAt = now();
            finish();
        };
        stream.on('end', settle);
        stream.on('close', settle);
        stream.on('error', settle);
        if (stdin !== undefined) {
            stream.write(stdin);
            stream.end();
        }
        await waitFor(run, wait);
        return { status: run.state === 'running' ? 202 : 200, body: view(run) };
    }

    // -----------------------------------------------------------------------
    // Session hosts (CB-326 step 3): a long-lived process in the sandbox that
    // reads JSON-RPC commands from stdin and writes ndjson events to stdout.
    // One host per session, one stream per host.

    const HOST_KINDS = ['codex', 'claude-code', 'gemini-cli', 'grok', 'opencode'];
    const HOST_COMMAND_OPS = [
        'turn_start',
        'turn_steer',
        'turn_interrupt',
        'thread_resume',
        'thread_snapshot',
        'thread_rollback',
        'thread_fork',
        'respond_runtime',
        'close',
    ];

    // CB-326 step 7: the real session-host entry, baked into the socio-coding
    // image at /usr/local/lib/socio/session-host.js. Runs under tsx because
    // the vendored @t3tools/* and effect-codex-app-server packages ship
    // TypeScript source (their exports point at .ts files). The loader is
    // referenced by its absolute path — `--import tsx` (bare) resolves from
    // the process cwd (/work), which has no node_modules, so it fails with
    // ERR_MODULE_NOT_FOUND; the absolute path resolves regardless of cwd.
    // The entry parses process.argv.slice(2) as [sessionId, kind, model];
    // startHost appends sessionId, kind, and (optionally) model below.
    const HOST_ENTRY = [
        'node',
        '--import',
        '/usr/local/lib/socio/node_modules/tsx/dist/loader.mjs',
        '/usr/local/lib/socio/session-host.js',
    ];

    /**
     * Starts a session host process in the sandbox. Idempotent if already
     * running. Returns { sessionId, state: "running" }.
     */
    async function startHost(sessionId, body) {
        const unknown = onlyFields(body, ['kind', 'model']);
        if (unknown) throw new ApiError(400, unknown);
        const kind = body.kind ?? 'codex';
        if (!HOST_KINDS.includes(kind)) throw new ApiError(400, `kind must be one of ${HOST_KINDS.join(', ')}.`);
        if (body.model !== undefined && !MODEL.test(body.model))
            throw new ApiError(400, 'model must be a gateway model name.');
        return locked(sessionId, async () => {
            const existing = hosts.get(sessionId);
            if (existing && existing.state === 'running') {
                if (existing.kind !== kind)
                    throw new ApiError(409, 'A host of another kind is already running for this session.');
                return {
                    status: 200,
                    body: { sessionId, hostPid: existing.hostPid, state: 'running' },
                };
            }
            const container = docker.getContainer(`${config.namespace}-code-${sessionId}`);
            const info = await inspectOwned(container);
            if (!info) throw new ApiError(404, 'No sandbox for this session.');
            if (info.State?.Running !== true) throw new ApiError(409, 'The sandbox is not running.');
            // The entry's contract: node --import <tsx-loader> session-host.js <sessionId> <kind> [model].
            // sessionId is required (the entry fails closed without it); kind and
            // model come from the request body (model optional).
            const argv = [...HOST_ENTRY, sessionId, kind, ...(body.model ? [body.model] : [])];
            let handle;
            let stream;
            try {
                handle = await container.exec({
                    Cmd: argv,
                    Env: [],
                    User: SANDBOX_USER,
                    WorkingDir: WORK_DIR,
                    AttachStdin: true,
                    AttachStdout: true,
                    AttachStderr: true,
                    Tty: false,
                    Privileged: false,
                });
                stream = await handle.start({
                    hijack: true,
                    stdin: true,
                });
            } catch (error) {
                throw new ApiError(
                    503,
                    `Could not start the session host: ${String(error?.message ?? error).slice(0, 200)}`,
                );
            }
            // Demux stdout/stderr separately: stdout carries ndjson events,
            // stderr carries diagnostic logs we keep but don't stream.
            const stdout = new Tail(8 * 1024 * 1024);
            const stderr = new Tail(64 * 1024);
            docker.modem.demuxStream(stream, stdout, stderr);
            let hostPid;
            try {
                const result = await handle.inspect();
                hostPid = result?.Pid;
            } catch {
                hostPid = undefined;
            }
            const host = {
                sessionId,
                kind,
                model: body.model,
                state: 'running',
                handle,
                stream,
                stdin: stream,
                stdout,
                stderr,
                hostPid,
                startedAt: now(),
                endedAt: undefined,
                streamOpen: false,
                streamController: undefined,
                heartbeat: undefined,
                pendingAcks: [],
            };
            let settled = false;
            const settle = async () => {
                if (settled) return;
                settled = true;
                host.state = 'ended';
                host.endedAt = now();
                if (host.heartbeat) {
                    clearInterval(host.heartbeat);
                    host.heartbeat = undefined;
                }
                if (host.streamController) {
                    try {
                        host.streamController.close();
                    } catch {
                        /* already closed */
                    }
                }
            };
            host.settle = settle;
            stream.on('end', settle);
            stream.on('close', settle);
            stream.on('error', settle);
            hosts.set(sessionId, host);
            log(`coding-sandbox: host started for ${sessionId} (${kind})`);
            return { status: 200, body: { sessionId, hostPid, state: 'running' } };
        });
    }

    /**
     * Returns a ReadableStream of ndjson events from the host's stdout. The
     * caller (mountCodingSandboxes) builds a Hono Response from this. Only
     * one stream per session (second GET returns 409).
     */
    async function hostStream(sessionId) {
        const host = hosts.get(sessionId);
        if (!host) throw new ApiError(404, 'No host for this session; start one first.');
        if (host.streamOpen) throw new ApiError(409, 'A stream is already open for this session.');
        host.streamOpen = true;
        // The host may have already ended; the stream closes immediately.
        if (host.state !== 'running') {
            host.streamOpen = false;
            throw new ApiError(409, 'The host is not running.');
        }
        const controller = new ReadableStream({
            start(controller) {
                host.streamController = controller;
                // Replay whatever stdout already captured (line-buffered).
                const text = host.stdout.text();
                if (text) controller.enqueue(Buffer.from(text));
                // Hook the Tail so new bytes flow straight into the stream.
                host.stdout.write = (chunk) => {
                    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    host.stdout.chunks.push(buffer);
                    host.stdout.size += buffer.length;
                    try {
                        controller.enqueue(buffer);
                    } catch {
                        /* controller closed */
                    }
                    return true;
                };
                // Heartbeat: every 30 seconds write one ndjson line so the
                // client knows the connection is alive (the host's own
                // heartbeat is separate; this covers the transport).
                host.heartbeat = setInterval(() => {
                    try {
                        controller.enqueue(Buffer.from(`${JSON.stringify({ type: 'heartbeat', ts: now() })}\n`));
                    } catch {
                        /* controller closed */
                    }
                }, 30_000);
                if (host.heartbeat.unref) host.heartbeat.unref();
            },
            cancel() {
                host.streamOpen = false;
                if (host.heartbeat) {
                    clearInterval(host.heartbeat);
                    host.heartbeat = undefined;
                }
            },
        });
        // When the controller closes, drop the write hook so the Tail
        // keeps working for a later stream (none yet, but harmless).
        // Track cleanup via the stream's own settle.
        return controller;
    }

    /**
     * Writes a JSON-RPC command to the host's stdin and reads one ack line
     * from stdout. Returns the ack object.
     */
    async function hostCommand(sessionId, body) {
        const unknown = onlyFields(body, ['op', 'payload']);
        if (unknown) throw new ApiError(400, unknown);
        const op = body.op;
        if (!HOST_COMMAND_OPS.includes(op))
            throw new ApiError(400, `op must be one of ${HOST_COMMAND_OPS.join(', ')}.`);
        if (body.payload !== undefined && (typeof body.payload !== 'object' || body.payload === null))
            throw new ApiError(400, 'payload must be an object.');
        return locked(sessionId, async () => {
            const host = hosts.get(sessionId);
            if (!host) throw new ApiError(404, 'No host for this session; start one first.');
            if (host.state !== 'running') throw new ApiError(409, 'The host is not running.');
            const command = JSON.stringify({ op, ...(body.payload ?? {}) }) + '\n';
            // Collect the ack: a line written to stdout after the command.
            const before = host.stdout.size;
            try {
                host.stdin.write(command);
            } catch (error) {
                throw new ApiError(
                    503,
                    `Could not write to the host: ${String(error?.message ?? error).slice(0, 200)}`,
                );
            }
            // Wait briefly for an ack line to appear after `before`.
            const ack = await new Promise((resolve, reject) => {
                const deadline = setTimeout(() => {
                    clearInterval(poller);
                    reject(new ApiError(504, 'The host did not acknowledge the command in time.'));
                }, 10_000);
                const poller = setInterval(() => {
                    const text = host.stdout.text();
                    if (host.stdout.size > before) {
                        const newPart = text.slice(Math.max(0, text.length - (host.stdout.size - before)));
                        const lines = newPart.split('\n').filter(Boolean);
                        if (lines.length) {
                            clearTimeout(deadline);
                            clearInterval(poller);
                            try {
                                resolve(JSON.parse(lines[lines.length - 1]));
                            } catch {
                                resolve({ ack: lines[lines.length - 1] });
                            }
                        }
                    }
                    if (host.state !== 'running') {
                        clearTimeout(deadline);
                        clearInterval(poller);
                        reject(new ApiError(409, 'The host ended before acknowledging.'));
                    }
                }, 50);
                if (poller.unref) poller.unref();
            });
            if (op === 'close') {
                // The host exits on close; let settle mark it ended.
                try {
                    host.stdin.end();
                } catch {
                    /* already closed */
                }
            }
            return { status: 200, body: { ack } };
        });
    }

    /** Stops and forgets a session's host (called from remove). */
    function forgetHost(sessionId) {
        const host = hosts.get(sessionId);
        if (!host) return;
        if (host.heartbeat) clearInterval(host.heartbeat);
        if (host.streamController) {
            try {
                host.streamController.close();
            } catch {
                /* already closed */
            }
        }
        try {
            host.stream.destroy();
        } catch {
            /* already gone */
        }
        host.state = 'ended';
        host.endedAt = now();
        hosts.delete(sessionId);
    }

    async function handle(method, path, body, query = new URLSearchParams()) {
        try {
            const parts = path.split('/').filter(Boolean);
            if (parts[0] === 'sandboxes' && parts[1] === 'self-test' && parts.length === 2) {
                if (method === 'GET') return { status: 200, body: selfTest };
                if (method === 'POST') return { status: 200, body: await runSelfTest() };
                throw new ApiError(405, 'Method not allowed.');
            }
            if (!config.enabled) throw new ApiError(503, `Coding sandboxes are off: ${config.reason}.`);
            if (parts[0] === 'workspaces' && parts.length === 2) {
                if (method !== 'DELETE') throw new ApiError(405, 'Method not allowed.');
                return await removeWorkspace(parts[1]);
            }
            if (parts[0] !== 'sandboxes') throw new ApiError(404, 'Not found.');
            if (parts.length === 1) {
                if (method === 'GET') return await list();
                if (method === 'POST') return await create(body);
                throw new ApiError(405, 'Method not allowed.');
            }
            const sessionId = parts[1];
            if (!SESSION_ID.test(sessionId) || sessionId === SELF_TEST) throw new ApiError(400, 'Not a session id.');
            if (parts.length === 2) {
                if (method === 'DELETE') return await remove(sessionId);
                throw new ApiError(405, 'Method not allowed.');
            }
            if (parts.length === 3 && parts[2] === 'start') {
                if (method !== 'POST') throw new ApiError(405, 'Method not allowed.');
                return await start(sessionId, body);
            }
            if (parts.length === 3 && parts[2] === 'exec') {
                if (method !== 'POST') throw new ApiError(405, 'Method not allowed.');
                return await exec(sessionId, body);
            }
            if (parts.length === 4 && parts[2] === 'exec') {
                const run = runs.get(parts[3]);
                if (!run || run.sessionId !== sessionId) throw new ApiError(404, 'No such run in this sandbox.');
                if (method === 'GET') {
                    await waitFor(run, waitSeconds(query.get('wait') ?? undefined));
                    return { status: 200, body: view(run) };
                }
                if (method === 'DELETE') {
                    if (run.state === 'running') throw new ApiError(409, 'The run is still running.');
                    runs.delete(run.runId);
                    return { status: 200, body: { forgotten: true } };
                }
                throw new ApiError(405, 'Method not allowed.');
            }
            if (parts.length === 3 && parts[2] === 'host') {
                if (method !== 'POST') throw new ApiError(405, 'Method not allowed.');
                return await startHost(sessionId, body);
            }
            if (parts.length === 4 && parts[2] === 'host' && parts[3] === 'stream') {
                if (method !== 'GET') throw new ApiError(405, 'Method not allowed.');
                // The stream is returned out-of-band: mountCodingSandboxes
                // detects the sentinel and builds a Hono streaming Response.
                const stream = await hostStream(sessionId);
                return { status: 200, stream };
            }
            if (parts.length === 4 && parts[2] === 'host' && parts[3] === 'command') {
                if (method !== 'POST') throw new ApiError(405, 'Method not allowed.');
                return await hostCommand(sessionId, body);
            }
            throw new ApiError(404, 'Not found.');
        } catch (error) {
            if (error instanceof ApiError)
                return {
                    status: error.status,
                    body: { error: error.message, ...(error.extra ?? {}) },
                };
            log(`coding-sandbox: Docker error (${String(error?.message ?? error).slice(0, 200)})`);
            return {
                status: 503,
                body: { error: 'The supervisor could not reach Docker.' },
            };
        }
    }

    return { handle, runSelfTest, selfTestState: () => selfTest };
}

/** Largest request body: a prompt (256 KB) and its envelope. */
const MAX_BODY = 512 * 1024;

/**
 * Mounts the API on the supervisor's Hono app, behind its existing
 * `SUPERVISOR_TOKEN` check (harden-supervisor.mjs), and starts the
 * self-test.
 */
export function mountCodingSandboxes(app, { docker, env, namespace, log = console.log }) {
    const config = sandboxConfig(env, namespace);
    const api = createSandboxApi({ docker, config, log });
    const handler = async (context) => {
        let body;
        if (context.req.method === 'POST') {
            const text = await context.req.text();
            if (Buffer.byteLength(text) > MAX_BODY) return context.json({ error: 'Request body too large.' }, 413);
            try {
                body = text ? JSON.parse(text) : {};
            } catch {
                return context.json({ error: 'Send JSON.' }, 400);
            }
        }
        const result = await api.handle(
            context.req.method,
            context.req.path,
            body,
            new URL(context.req.url).searchParams,
        );
        // The host stream route returns a sentinel { stream } instead of a
        // body: build a Hono streaming Response with ndjson content type.
        if (result.stream) {
            return new Response(result.stream, {
                status: result.status,
                headers: {
                    'content-type': 'application/x-ndjson; charset=utf-8',
                    'cache-control': 'no-cache',
                    'x-accel-buffering': 'no',
                },
            });
        }
        return context.json(result.body, result.status);
    };
    app.all('/sandboxes', handler);
    app.all('/sandboxes/*', handler);
    app.all('/workspaces/*', handler);
    if (config.enabled) void api.runSelfTest();
    else log(`coding-sandbox: off (${config.reason})`);
    return api;
}
