import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { isAbsolute, resolve, sep } from 'node:path';

import { RUNTIME_TASK_ID } from '@socio/shared/apps/apps-runtime-types';
import type { SwarmServiceBody } from '@socio/shared/plugins/plugin-service';

import { REVISION_FIELD, containerRevision } from './revision.js';
import { RuntimeError } from './supervisor.js';

/**
 * The Docker engine the apps runtime uses for plugin services. Off unless
 * the runtime was started with `APPS_RUNTIME_DOCKER=on`. The default stack
 * does not mount the socket. The plugin overlay points this client at the
 * socket proxy (`tcp://docker-socket-proxy:2375`); only that proxy opens
 * `/var/run/docker.sock`. Mini-app processes never see either.
 */

/** A unix socket path, or `tcp://host:port` / `http://host:port` for the proxy. */
export function engineEndpoint(dockerHost: string) {
    const value = dockerHost.trim();
    if (value.startsWith('tcp://') || value.startsWith('http://')) {
        let url: URL;
        try {
            url = new URL(value.replace(/^tcp:\/\//, 'http://'));
        } catch {
            throw new Error('APPS_RUNTIME_DOCKER_HOST must be a unix socket path or tcp://host:port.');
        }
        const port = Number(url.port || 80);
        if (url.protocol !== 'http:' || !url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error('APPS_RUNTIME_DOCKER_HOST must be a unix socket path or tcp://host:port.');
        }
        return { hostname: url.hostname, port };
    }
    if (value.includes('://')) {
        throw new Error('APPS_RUNTIME_DOCKER_HOST must be a unix socket path or tcp://host:port.');
    }
    return { socketPath: value };
}

const API = '/v1.44';

export interface DockerTaskAddress {
    ip: string;
    state: string;
    /** The task's id (CB-458), for `x-cb-runtime-task`; one task may have several addresses. */
    task?: string;
    /** What the task runs, as a digest (`revision.ts`), to compare with its service's current one. */
    revision?: string;
}

export interface DockerServiceRecord {
    id: string;
    version: number;
    name: string;
    labels: Record<string, string>;
    replicas: number;
    image: string;
    env: string[];
    /** Its current task template's revision (`revision.ts`): what a task of this revision runs. */
    revision?: string;
    /** Volumes this service created. No driver means local disk. */
    volumes: { source: string; target: string; driver?: string }[];
}

export interface DockerNetworkInfo {
    id: string;
    name: string;
    internal: boolean;
    driver: string;
}

export interface DockerNetworkCreate {
    Name: string;
    Driver: 'overlay';
    Internal: true;
    Attachable: false;
    Ingress: false;
    Labels: Record<string, string>;
    CheckDuplicate?: boolean;
}

/** A plugin identity secret: a name, the plugin's labels and the base64 token. Nothing else. */
export interface DockerSecretCreate {
    Name: string;
    Labels: Record<string, string>;
    Data: string;
}

export interface DockerEngine {
    networkId(name: string): Promise<string>;
    inspectNetwork(name: string): Promise<DockerNetworkInfo | undefined>;
    createNetwork(spec: DockerNetworkCreate): Promise<string>;
    removeNetwork(id: string): Promise<void>;
    /** Add one network to a service. The socket proxy allows this only for plugin networks. */
    attachServiceNetwork(serviceName: string, networkId: string): Promise<void>;
    detachServiceNetwork(serviceName: string, networkId: string): Promise<void>;
    listManaged(): Promise<DockerServiceRecord[]>;
    findService(name: string): Promise<DockerServiceRecord | undefined>;
    /** One allowlisted secret name → Swarm id. Undefined when Swarm has no such secret. */
    secretId(name: string): Promise<string | undefined>;
    /**
     * Creates a plugin identity secret; returns its id. The socket proxy
     * takes only `<PLUGIN_NAME_PREFIX>-wl-<id>-v<n>` with exactly the
     * plugin's labels.
     */
    createSecret(spec: DockerSecretCreate): Promise<string>;
    /** Removes an identity secret by id; a missing one is fine. Refused while a service uses it. */
    removeSecret(id: string): Promise<void>;
    /**
     * `registryAuth` is the encoded `X-Registry-Auth` header: Swarm keeps it
     * with the service and uses it on every task's image pull, on any node.
     * Without it, an update keeps the credential the service already has.
     */
    createService(spec: SwarmServiceBody, registryAuth?: string): Promise<void>;
    updateService(id: string, version: number, spec: SwarmServiceBody, registryAuth?: string): Promise<void>;
    /**
     * Change only `Mode.Replicated.Replicas` on the spec the engine already
     * has, at `version` (`Version.Index`). Secrets, healthchecks, limits, and
     * networks stay.
     */
    scaleService(id: string, version: number, replicas: number): Promise<void>;
    removeService(id: string): Promise<void>;
    tasks(name: string): Promise<DockerTaskAddress[]>;
    removeVolume(name: string): Promise<void>;
    /** `registryAuth`: the encoded `X-Registry-Auth` for the image's registry, when there is a login. */
    pullImage?(image: string, registryAuth?: string): Promise<void>;
    buildImage?(options: { context: string; dockerfile: string; target?: string; tag: string }): Promise<void>;
}

interface EngineCall {
    status: number;
    body: unknown;
}

/**
 * `X-Registry-Auth` of an empty login (`{}`): an update that sends it
 * replaces the credential Swarm kept with the service, so a removed login
 * stops being used. An update without the header would keep it.
 */
export const NO_REGISTRY_AUTH = registryBase64('{}');

/**
 * URL-safe base64 **with** padding: Docker decodes `X-Registry-Auth` with
 * Go's padded `base64.URLEncoding`, which refuses Node's unpadded
 * `base64url` whenever the JSON's length isn't a multiple of three.
 */
function registryBase64(text: string) {
    return Buffer.from(text).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

/** The engine's `X-Registry-Auth` header, when there is a credential. */
function registryHeader(registryAuth: string | undefined): Record<string, string> {
    return registryAuth ? { 'x-registry-auth': registryAuth } : {};
}

/**
 * A registry login as Docker's `X-Registry-Auth` wants it: padded URL-safe base64 JSON
 * of `{ username, password, serveraddress }`.
 */
export function encodeRegistryAuth(credential: { registry: string; username: string; password: string }) {
    return registryBase64(
        JSON.stringify({
            username: credential.username,
            password: credential.password,
            serveraddress: credential.registry,
        }),
    );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/** `10.0.0.5/24` → `10.0.0.5`. Hostnames are not accepted. */
export function taskIp(address: string) {
    const bare = address.split('/')[0]?.trim() ?? '';
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) {
        return bare;
    }
    if (bare.includes(':') && /^[0-9a-f:]+$/i.test(bare)) {
        return bare;
    }
    return undefined;
}

function serviceRecord(value: unknown): DockerServiceRecord | undefined {
    const row = asRecord(value);
    const spec = asRecord(row?.Spec);
    const version = asRecord(row?.Version);
    if (!row || typeof row.ID !== 'string' || !spec || typeof spec.Name !== 'string') {
        return undefined;
    }
    const labels = asRecord(spec.Labels) ?? {};
    const mode = asRecord(asRecord(spec.Mode)?.Replicated);
    const container = asRecord(asRecord(asRecord(spec.TaskTemplate)?.ContainerSpec));
    const mounts = Array.isArray(container?.Mounts) ? container.Mounts : [];
    return {
        id: row.ID,
        version: Number(version?.Index ?? 0),
        name: spec.Name,
        labels: Object.fromEntries(Object.entries(labels).map(([key, item]) => [key, String(item)])),
        replicas: Number(mode?.Replicas ?? 0),
        image: typeof container?.Image === 'string' ? container.Image : '',
        env: Array.isArray(container?.Env) ? container.Env.map(String) : [],
        revision: containerRevision(container),
        volumes: mounts.flatMap((mount) => {
            const row = asRecord(mount);
            const source = row?.Source;
            const target = row?.Target;
            if (typeof source !== 'string' || typeof target !== 'string') {
                return [];
            }
            if (row?.Type !== 'volume') {
                return [];
            }
            const driver = asRecord(asRecord(row?.VolumeOptions)?.DriverConfig)?.Name;
            return [
                {
                    source,
                    target,
                    ...(typeof driver === 'string' ? { driver } : {}),
                },
            ];
        }),
    };
}

/** Engine HTTP over the unix socket, or TCP when the host is the socket proxy. */
export class HttpDockerEngine implements DockerEngine {
    constructor(
        private socketPath: string,
        private pull: boolean,
    ) {}

    private call(
        method: string,
        path: string,
        body?: unknown,
        timeoutMs = 15_000,
        extra: Record<string, string> = {},
    ): Promise<EngineCall> {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        return new Promise((resolvePromise, reject) => {
            const req = httpRequest(
                {
                    ...engineEndpoint(this.socketPath),
                    method,
                    path,
                    headers: {
                        host: 'localhost',
                        ...extra,
                        ...(payload
                            ? {
                                  'content-type': 'application/json',
                                  'content-length': String(payload.length),
                              }
                            : {}),
                    },
                    timeout: timeoutMs,
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer) => chunks.push(chunk));
                    res.on('end', () => {
                        const text = Buffer.concat(chunks).toString('utf8');
                        let parsed: unknown = null;
                        if (text) {
                            try {
                                parsed = JSON.parse(text) as unknown;
                            } catch {
                                parsed = { message: text.slice(0, 300) };
                            }
                        }
                        resolvePromise({ status: res.statusCode ?? 0, body: parsed });
                    });
                },
            );
            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('timeout')));
            if (payload) {
                req.end(payload);
            } else {
                req.end();
            }
        });
    }

    private async ok(result: EngineCall, what: string) {
        if (result.status >= 200 && result.status < 300) {
            return result.body;
        }
        const message = asRecord(result.body)?.message;
        // A 403 is the socket proxy refusing the change (its reason is a fixed
        // sentence): a refusal, not an outage, so it keeps its status.
        throw new RuntimeError(
            typeof message === 'string' ? message.slice(0, 300) : `Docker could not ${what} (HTTP ${result.status}).`,
            result.status === 403 ? 403 : result.status === 404 ? 404 : result.status === 409 ? 409 : 503,
        );
    }

    async networkId(name: string) {
        const listed = await this.ok(
            await this.call(
                'GET',
                `${API}/networks?filters=${encodeURIComponent(JSON.stringify({ name: { [name]: true } }))}`,
            ),
            `find network ${name}`,
        );
        const found = (Array.isArray(listed) ? listed : [])
            .map(asRecord)
            .find((row) => row?.Name === name && typeof row.Id === 'string');
        if (!found) {
            throw new RuntimeError(`Docker network ${name} was not found.`, 503);
        }
        return String(found.Id);
    }

    async inspectNetwork(name: string) {
        const listed = await this.ok(
            await this.call(
                'GET',
                `${API}/networks?filters=${encodeURIComponent(JSON.stringify({ name: { [name]: true } }))}`,
            ),
            `find network ${name}`,
        );
        const found = (Array.isArray(listed) ? listed : [])
            .map(asRecord)
            .find((row) => row?.Name === name && typeof row.Id === 'string');
        if (!found) {
            return undefined;
        }
        return {
            id: String(found.Id),
            name,
            internal: found.Internal === true,
            driver: typeof found.Driver === 'string' ? found.Driver : '',
        };
    }

    async createNetwork(spec: DockerNetworkCreate) {
        const created = asRecord(
            await this.ok(
                await this.call('POST', `${API}/networks/create`, {
                    ...spec,
                    CheckDuplicate: true,
                }),
                `create network ${spec.Name}`,
            ),
        );
        if (!created || typeof created.Id !== 'string') {
            throw new RuntimeError(`Docker did not return an id for network ${spec.Name}.`, 503);
        }
        return created.Id;
    }

    async removeNetwork(id: string) {
        const result = await this.call('DELETE', `${API}/networks/${encodeURIComponent(id)}`);
        if (result.status === 404) {
            return;
        }
        await this.ok(result, 'remove the plugin network');
    }

    private async rawService(name: string) {
        const listed = await this.ok(
            await this.call(
                'GET',
                `${API}/services?filters=${encodeURIComponent(JSON.stringify({ name: { [name]: true } }))}`,
            ),
            `find service ${name}`,
        );
        const found = (Array.isArray(listed) ? listed : [])
            .map(asRecord)
            .find((row) => asRecord(row?.Spec)?.Name === name);
        const spec = asRecord(found?.Spec);
        const version = Number(asRecord(found?.Version)?.Index ?? 0);
        if (!found || typeof found.ID !== 'string' || !spec) {
            return undefined;
        }
        return { id: found.ID, version, spec };
    }

    private async setServiceNetworks(serviceName: string, networkId: string, present: boolean) {
        const current = await this.rawService(serviceName);
        if (!current) {
            if (!present) {
                return;
            }
            throw new RuntimeError(
                `Docker service ${serviceName} was not found, so the plugin network cannot be attached.`,
                503,
            );
        }
        const read = asRecord(current.spec.TaskTemplate) ?? {};
        // The socket proxy's revision digest is its own field, never part of
        // the spec sent back (CB-370).
        const container = asRecord(read.ContainerSpec);
        const task = container
            ? {
                  ...read,
                  ContainerSpec: Object.fromEntries(
                      Object.entries(container).filter(([key]) => key !== REVISION_FIELD),
                  ),
              }
            : read;
        const networks = Array.isArray(task.Networks) ? [...task.Networks] : [];
        const has = networks.some((item) => asRecord(item)?.Target === networkId);
        if (has === present) {
            return;
        }
        // A stack gives a service its short name (`app`) only as an alias on
        // the stack's own networks. On the plugin network, which the runtime
        // creates, the plugin resolves the same names only if the attachment
        // carries them (SOCIO_API_URL, the egress proxy's host).
        const aliases = [
            ...new Set(
                networks.flatMap((item) => {
                    const list = asRecord(item)?.Aliases;
                    return Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string') : [];
                }),
            ),
        ];
        const nextNetworks = present
            ? [...networks, aliases.length ? { Target: networkId, Aliases: aliases } : { Target: networkId }]
            : networks.filter((item) => asRecord(item)?.Target !== networkId);
        await this.ok(
            await this.call(
                'POST',
                `${API}/services/${encodeURIComponent(current.id)}/update?version=${current.version}`,
                {
                    ...current.spec,
                    TaskTemplate: { ...task, Networks: nextNetworks },
                },
            ),
            `${present ? 'attach' : 'detach'} ${serviceName}`,
        );
    }

    attachServiceNetwork(serviceName: string, networkId: string) {
        return this.setServiceNetworks(serviceName, networkId, true);
    }

    detachServiceNetwork(serviceName: string, networkId: string) {
        return this.setServiceNetworks(serviceName, networkId, false);
    }

    private async services(filters: Record<string, Record<string, boolean>>) {
        const listed = await this.ok(
            await this.call('GET', `${API}/services?filters=${encodeURIComponent(JSON.stringify(filters))}`),
            'list services',
        );
        return (Array.isArray(listed) ? listed : [])
            .map(serviceRecord)
            .filter((row): row is DockerServiceRecord => !!row);
    }

    listManaged() {
        return this.services({ label: { 'socio.managed=plugin': true } });
    }

    async findService(name: string) {
        const found = await this.services({ name: { [name]: true } });
        return found.find((row) => row.name === name);
    }

    async createService(spec: SwarmServiceBody, registryAuth?: string) {
        await this.ok(
            await this.call('POST', `${API}/services/create`, spec, undefined, registryHeader(registryAuth)),
            'create the plugin service',
        );
    }

    async updateService(id: string, version: number, spec: SwarmServiceBody, registryAuth?: string) {
        await this.ok(
            await this.call(
                'POST',
                `${API}/services/${encodeURIComponent(id)}/update?version=${version}`,
                spec,
                undefined,
                registryHeader(registryAuth),
            ),
            'update the plugin service',
        );
    }

    async secretId(name: string) {
        const filters = encodeURIComponent(JSON.stringify({ names: { [name]: true } }));
        const result = await this.call('GET', `${API}/secrets?filters=${filters}`);
        if (result.status === 404) {
            return undefined;
        }
        const listed = await this.ok(result, 'look up the swarm secret');
        const matches = (Array.isArray(listed) ? listed : []).flatMap((item) => {
            const row = asRecord(item);
            const spec = asRecord(row?.Spec);
            const id = row?.ID ?? row?.Id;
            if (spec?.Name === name && typeof id === 'string' && id) {
                return [id];
            }
            return [];
        });
        return matches.length === 1 ? matches[0] : undefined;
    }

    async createSecret(spec: DockerSecretCreate) {
        const created = asRecord(
            await this.ok(await this.call('POST', `${API}/secrets/create`, spec), 'create the secret'),
        );
        const id = created?.ID ?? created?.Id;
        if (typeof id !== 'string' || !id) {
            throw new RuntimeError('Docker returned no secret id.', 503);
        }
        return id;
    }

    async removeSecret(id: string) {
        const result = await this.call('DELETE', `${API}/secrets/${encodeURIComponent(id)}`);
        if (result.status === 404) {
            return;
        }
        await this.ok(result, 'remove the secret');
    }

    async scaleService(id: string, version: number, replicas: number) {
        const proxied = this.socketPath.startsWith('tcp://') || this.socketPath.startsWith('http://');
        if (proxied) {
            await this.ok(
                await this.call('POST', `${API}/services/${encodeURIComponent(id)}/update?version=${version}`, {
                    Mode: { Replicated: { Replicas: replicas } },
                }),
                'scale the plugin service',
            );
            return;
        }
        const current = asRecord(
            await this.ok(
                await this.call('GET', `${API}/services/${encodeURIComponent(id)}`),
                'inspect the plugin service',
            ),
        );
        const spec = asRecord(current?.Spec);
        const index = Number(asRecord(current?.Version)?.Index);
        if (!spec || !Number.isInteger(index)) {
            throw new RuntimeError('Docker returned no service spec.', 503);
        }
        if (index !== version) {
            throw new RuntimeError('The service changed. Try again.', 409);
        }
        const mode = asRecord(spec.Mode) ?? {};
        const replicated = asRecord(mode.Replicated) ?? {};
        await this.ok(
            await this.call('POST', `${API}/services/${encodeURIComponent(id)}/update?version=${index}`, {
                ...spec,
                Mode: { ...mode, Replicated: { ...replicated, Replicas: replicas } },
            }),
            'scale the plugin service',
        );
    }

    async removeService(id: string) {
        const result = await this.call('DELETE', `${API}/services/${encodeURIComponent(id)}`);
        if (result.status === 404) {
            return;
        }
        await this.ok(result, 'remove the plugin service');
    }

    async tasks(name: string) {
        const listed = await this.ok(
            await this.call(
                'GET',
                `${API}/tasks?filters=${encodeURIComponent(JSON.stringify({ service: { [name]: true }, 'desired-state': { running: true } }))}`,
            ),
            'list plugin tasks',
        );
        const addresses: DockerTaskAddress[] = [];
        for (const row of Array.isArray(listed) ? listed : []) {
            const record = asRecord(row);
            const state = String(asRecord(record?.Status)?.State ?? '');
            const revision = containerRevision(asRecord(asRecord(record?.Spec)?.ContainerSpec));
            const id = String(record?.ID ?? '').toLowerCase();
            const task = RUNTIME_TASK_ID.test(id) ? id : undefined;
            const attachments = Array.isArray(record?.NetworksAttachments) ? record.NetworksAttachments : [];
            for (const attachment of attachments) {
                const list = asRecord(attachment)?.Addresses;
                if (!Array.isArray(list)) {
                    continue;
                }
                for (const item of list) {
                    const ip = taskIp(String(item));
                    if (ip) {
                        addresses.push({ ip, state, ...(revision ? { revision } : {}), ...(task ? { task } : {}) });
                    }
                }
            }
        }
        return addresses;
    }

    async removeVolume(name: string) {
        const result = await this.call('DELETE', `${API}/volumes/${encodeURIComponent(name)}`);
        if (result.status === 404) {
            return;
        }
        await this.ok(result, 'remove the plugin volume');
    }

    async pullImage(image: string, registryAuth?: string) {
        if (!this.pull) {
            return;
        }
        const [name, tag] = image.includes('@')
            ? [image, '']
            : (() => {
                  const slash = image.lastIndexOf('/');
                  const colon = image.lastIndexOf(':');
                  return colon > slash ? [image.slice(0, colon), image.slice(colon + 1)] : [image, 'latest'];
              })();
        await this.ok(
            await this.call(
                'POST',
                `${API}/images/create?fromImage=${encodeURIComponent(name)}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}`,
                undefined,
                120_000,
                registryHeader(registryAuth),
            ),
            'pull the plugin image',
        );
    }

    buildImage(options: { context: string; dockerfile: string; target?: string; tag: string }) {
        const query = new URLSearchParams({
            t: options.tag,
            dockerfile: options.dockerfile,
        });
        if (options.target) {
            query.set('target', options.target);
        }
        return new Promise<void>((resolvePromise, reject) => {
            const tar = spawn('tar', ['-c', '-C', options.context, '.'], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const req = httpRequest(
                {
                    ...engineEndpoint(this.socketPath),
                    method: 'POST',
                    path: `${API}/build?${query}`,
                    headers: { host: 'localhost', 'content-type': 'application/x-tar' },
                    timeout: 10 * 60_000,
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer) => chunks.push(chunk));
                    res.on('end', () => {
                        if ((res.statusCode ?? 500) >= 300) {
                            reject(
                                new RuntimeError(
                                    `Docker could not build the plugin image (HTTP ${res.statusCode}).`,
                                    503,
                                ),
                            );
                        } else {
                            resolvePromise();
                        }
                    });
                },
            );
            req.on('error', reject);
            tar.on('error', reject);
            tar.stdout.pipe(req);
            tar.stderr.on('data', () => {});
        });
    }
}

/**
 * A build context must stay inside the runtime's build root. Anything else
 * is refused before Docker sees it.
 */
export function buildContext(root: string, context: string) {
    const base = realpathSync(root);
    const dir = realpathSync(resolve(base, context));
    if (dir !== base && !dir.startsWith(base.endsWith(sep) ? base : base + sep)) {
        throw new RuntimeError('The plugin build context is outside APPS_RUNTIME_BUILD_ROOT.', 400);
    }
    if (!isAbsolute(dir)) {
        throw new RuntimeError('The plugin build context is not absolute.', 400);
    }
    return dir;
}

function asciiFold(key: string) {
    return key.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

type GoShape = 'keep' | 'map' | { list: GoShape } | { fields: Record<string, GoShape> };

function plainObject(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    return value as Record<string, unknown>;
}

function decodeGo(value: unknown, shape: GoShape): unknown {
    if (shape === 'keep') {
        return value;
    }
    if (shape === 'map') {
        const row = plainObject(value);
        return row ? { ...row } : {};
    }
    if ('list' in shape) {
        return Array.isArray(value) ? value.map((item) => decodeGo(item, shape.list)) : [];
    }
    const row = plainObject(value);
    if (!row) {
        return {};
    }
    const byFold = new Map(Object.keys(shape.fields).map((name) => [asciiFold(name), name]));
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(row)) {
        const canon = byFold.get(asciiFold(key));
        if (!canon) {
            continue;
        }
        out[canon] = decodeGo(child, shape.fields[canon]!);
    }
    return out;
}

const mountShape: GoShape = {
    fields: {
        Type: 'keep',
        Source: 'keep',
        Target: 'keep',
        ReadOnly: 'keep',
        Consistency: 'keep',
        BindOptions: {
            fields: {
                Propagation: 'keep',
            },
        },
        VolumeOptions: {
            fields: {
                NoCopy: 'keep',
                Labels: 'map',
                DriverConfig: {
                    fields: { Name: 'keep', Options: 'map' },
                },
            },
        },
        TmpfsOptions: {
            fields: { SizeBytes: 'keep', Mode: 'keep' },
        },
    },
};

const serviceShape: GoShape = {
    fields: {
        Name: 'keep',
        Labels: 'map',
        TaskTemplate: {
            fields: {
                ContainerSpec: {
                    fields: {
                        Image: 'keep',
                        Labels: 'map',
                        Env: { list: 'keep' },
                        User: 'keep',
                        ReadOnly: 'keep',
                        CapabilityDrop: { list: 'keep' },
                        Privileges: { fields: { NoNewPrivileges: 'keep' } },
                        Secrets: {
                            list: {
                                fields: {
                                    SecretID: 'keep',
                                    SecretName: 'keep',
                                    File: {
                                        fields: {
                                            Name: 'keep',
                                            UID: 'keep',
                                            GID: 'keep',
                                            Mode: 'keep',
                                        },
                                    },
                                },
                            },
                        },
                        Mounts: { list: mountShape },
                        Healthcheck: {
                            fields: {
                                Test: { list: 'keep' },
                                Interval: 'keep',
                                Timeout: 'keep',
                                Retries: 'keep',
                                StartPeriod: 'keep',
                            },
                        },
                        Command: { list: 'keep' },
                        Args: { list: 'keep' },
                        Dir: 'keep',
                        Hostname: 'keep',
                        Hosts: { list: 'keep' },
                        Privileged: 'keep',
                        CapAdd: { list: 'keep' },
                        CapabilityAdd: { list: 'keep' },
                        Devices: { list: 'keep' },
                        PidMode: 'keep',
                        IpcMode: 'keep',
                        Sysctls: 'map',
                    },
                },
                Resources: {
                    fields: {
                        Limits: {
                            fields: { NanoCPUs: 'keep', MemoryBytes: 'keep', Pids: 'keep' },
                        },
                    },
                },
                RestartPolicy: { fields: { Condition: 'keep' } },
                Networks: {
                    list: { fields: { Target: 'keep', Aliases: { list: 'keep' } } },
                },
                Runtime: 'keep',
                ForceUpdate: 'keep',
                Placement: 'keep',
            },
        },
        Mode: {
            fields: {
                Replicated: { fields: { Replicas: 'keep' } },
                Global: { fields: {} },
            },
        },
        EndpointSpec: { fields: { Mode: 'keep', Ports: { list: 'keep' } } },
        UpdateConfig: 'keep',
        RollbackConfig: 'keep',
    },
};

/**
 * What Go's encoding/json would store for a ServiceSpec: ASCII case-fold
 * onto the canonical field, unknown keys dropped (`Spec` included), and
 * the last duplicate key wins.
 */
export function goDecodeServiceSpec(value: unknown): SwarmServiceBody {
    return decodeGo(value, serviceShape) as SwarmServiceBody;
}

/** Swarm rejects a secret reference that has a name and no id. */
function rejectMalformedSecrets(spec: SwarmServiceBody) {
    const secrets = spec.TaskTemplate.ContainerSpec.Secrets;
    if (!secrets) {
        return;
    }
    for (const secret of secrets) {
        if (
            !secret ||
            typeof secret.SecretID !== 'string' ||
            secret.SecretID === '' ||
            typeof secret.SecretName !== 'string' ||
            secret.SecretName === ''
        ) {
            throw new RuntimeError('malformed secret reference', 400);
        }
    }
}

function recordFrom(id: string, version: number, spec: SwarmServiceBody): DockerServiceRecord {
    return {
        id,
        version,
        name: spec.Name,
        labels: spec.Labels,
        replicas: Number(spec.Mode?.Replicated?.Replicas ?? 0),
        image: spec.TaskTemplate?.ContainerSpec?.Image ?? '',
        env: spec.TaskTemplate?.ContainerSpec?.Env ?? [],
        revision: containerRevision(spec.TaskTemplate?.ContainerSpec as unknown as Record<string, unknown>),
        volumes: (spec.TaskTemplate.ContainerSpec.Mounts ?? []).flatMap((mount) => {
            if (mount.Type !== 'volume') {
                return [];
            }
            return [
                {
                    source: mount.Source,
                    target: mount.Target,
                    ...(mount.VolumeOptions?.DriverConfig.Name
                        ? { driver: mount.VolumeOptions.DriverConfig.Name }
                        : {}),
                },
            ];
        }),
    };
}

/** The engine tests use: no daemon, task addresses the ingress can round-robin. */
export class MemoryDocker implements DockerEngine {
    services = new Map<string, DockerServiceRecord>();
    /** The spec create/update stored. Scale changes only the replica count. */
    private specs = new Map<string, SwarmServiceBody>();
    /** Allowlisted secret name → Swarm secret id. */
    secrets = new Map<string, string>();
    /** Secrets this engine created (identity secrets): id → name, labels and data. */
    created = new Map<string, DockerSecretCreate>();
    removedSecrets: string[] = [];
    networks = new Map<string, DockerNetworkInfo>();
    /** Infra service name → network ids attached by the plugin manager. */
    attached = new Map<string, string[]>();
    removedVolumes: string[] = [];
    /** Tests: each task's revision, by index (a rollout in progress); the service's current one otherwise. */
    taskRevisions?: string[];
    removedNetworks: string[] = [];
    /** Service name → the `X-Registry-Auth` it was last given (Swarm keeps it for pulls). */
    registryAuth = new Map<string, string>();
    built: string[] = [];
    private seq = 1;

    /** The stored service spec, cloned so a test cannot mutate the engine's copy. */
    specNamed(name: string) {
        const row = [...this.services.values()].find((item) => item.name === name);
        const spec = row && this.specs.get(row.id);
        return spec ? structuredClone(spec) : undefined;
    }

    async networkId(name: string) {
        return (await this.inspectNetwork(name))?.id ?? `net-${name}`;
    }

    async inspectNetwork(name: string) {
        return [...this.networks.values()].find((row) => row.name === name);
    }

    async createNetwork(spec: DockerNetworkCreate) {
        const existing = await this.inspectNetwork(spec.Name);
        if (existing) {
            return existing.id;
        }
        const id = `net-${spec.Name}`;
        this.networks.set(id, {
            id,
            name: spec.Name,
            internal: spec.Internal,
            driver: spec.Driver,
        });
        return id;
    }

    async removeNetwork(id: string) {
        this.networks.delete(id);
        this.removedNetworks.push(id);
    }

    async attachServiceNetwork(serviceName: string, networkId: string) {
        const list = this.attached.get(serviceName) ?? [];
        if (!list.includes(networkId)) {
            this.attached.set(serviceName, [...list, networkId]);
        }
    }

    async detachServiceNetwork(serviceName: string, networkId: string) {
        const list = this.attached.get(serviceName) ?? [];
        this.attached.set(
            serviceName,
            list.filter((item) => item !== networkId),
        );
    }

    async listManaged() {
        return [...this.services.values()].filter((row) => row.labels['socio.managed'] === 'plugin');
    }

    async findService(name: string) {
        return [...this.services.values()].find((row) => row.name === name);
    }

    async secretId(name: string) {
        const id = this.secrets.get(name);
        return id || undefined;
    }

    async createSecret(spec: DockerSecretCreate) {
        if (this.secrets.has(spec.Name)) {
            throw new RuntimeError(`Secret ${spec.Name} already exists.`, 409);
        }
        const id = `secret-${this.seq++}`;
        this.secrets.set(spec.Name, id);
        this.created.set(id, structuredClone(spec));
        return id;
    }

    async removeSecret(id: string) {
        const entry = [...this.secrets.entries()].find(([, value]) => value === id);
        if (!entry) {
            return;
        }
        // As Swarm: a secret a service references can't be removed.
        const used = [...this.specs.values()].some((spec) =>
            (spec.TaskTemplate.ContainerSpec.Secrets ?? []).some((secret) => secret.SecretID === id),
        );
        if (used) {
            throw new RuntimeError(`Secret ${entry[0]} is in use by a service.`, 409);
        }
        this.secrets.delete(entry[0]);
        this.created.delete(id);
        this.removedSecrets.push(entry[0]);
    }

    async createService(spec: SwarmServiceBody, registryAuth?: string) {
        const stored = goDecodeServiceSpec(spec);
        rejectMalformedSecrets(stored);
        if ([...this.services.values()].some((row) => row.name === stored.Name)) {
            throw new RuntimeError(`Service ${stored.Name} already exists.`, 409);
        }
        const id = `svc-${this.seq++}`;
        this.specs.set(id, stored);
        this.services.set(id, recordFrom(id, 1, stored));
        if (registryAuth) {
            this.registryAuth.set(stored.Name, registryAuth);
        }
    }

    async updateService(id: string, version: number, spec: SwarmServiceBody, registryAuth?: string) {
        const stored = goDecodeServiceSpec(spec);
        rejectMalformedSecrets(stored);
        const current = this.services.get(id);
        if (!current) {
            throw new RuntimeError('No such service.', 404);
        }
        if (current.version !== version) {
            throw new RuntimeError('The service changed. Try again.', 409);
        }
        this.specs.set(id, stored);
        this.services.set(id, recordFrom(id, version + 1, stored));
        // As Swarm: an update without the header keeps the stored credential.
        if (registryAuth) {
            this.registryAuth.set(stored.Name, registryAuth);
        }
    }

    async scaleService(id: string, version: number, replicas: number) {
        const current = this.services.get(id);
        const spec = this.specs.get(id);
        if (!current || !spec) {
            throw new RuntimeError('No such service.', 404);
        }
        if (current.version !== version) {
            throw new RuntimeError('The service changed. Try again.', 409);
        }
        const next = structuredClone(spec);
        next.Mode = { Replicated: { Replicas: replicas } };
        this.specs.set(id, next);
        this.services.set(id, recordFrom(id, version + 1, next));
    }

    async removeService(id: string) {
        this.services.delete(id);
        this.specs.delete(id);
    }

    async tasks(name: string) {
        const service = [...this.services.values()].find((row) => row.name === name);
        if (!service) {
            return [];
        }
        return Array.from({ length: service.replicas }, (_, index) => ({
            ip: `10.8.0.${index + 1}`,
            state: 'running',
            task: `task${index + 1}`,
            revision: this.taskRevisions?.[index] ?? service.revision,
        }));
    }

    async removeVolume(name: string) {
        this.removedVolumes.push(name);
    }

    async buildImage(options: { tag: string }) {
        this.built.push(options.tag);
    }
}
