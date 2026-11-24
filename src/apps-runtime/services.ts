import type { DeliveredIdentity, IdentityDelivery, IdentityGrant, WorkloadRef } from '@socio/shared/identity-delivery';
import {
    PINNED_IMAGE,
    checkServiceSpec,
    egressEntries,
    egressHostnames,
    imageAllowed,
    pluginNetworkName,
    pluginServiceName,
    resolveImage,
    swarmServiceBody,
    type PluginServiceSpec,
} from '@socio/shared/plugins/plugin-service';
import { imageRegistry, type RegistryCredential } from '@socio/shared/plugins/registry-auth';

import {
    buildContext,
    encodeRegistryAuth,
    NO_REGISTRY_AUTH,
    type DockerEngine,
    type DockerServiceRecord,
} from './docker.js';
import { egressProxyUrl, pluginActorKey, pluginProof } from './keys.js';
import { RuntimeError } from './supervisor.js';

/**
 * Plugin services on the workspace app runtime. Installing a plugin creates
 * a swarm service; uninstalling deletes that service and the volumes it
 * created. Replicas share nothing on local disk: the ingress round-robins
 * task addresses and does not pin a person to a task. Sessions stay in
 * Socio's database, so any replica can serve the next request.
 */

export interface PluginServiceConfig {
    /** Image ref prefixes. Required, and the only images that can be created. */
    allow: readonly string[];
    maxReplicas: number;
    secret: string;
    pull: boolean;
    /** Set only when this runtime may build a plugin image. The socket proxy refuses builds. */
    buildRoot?: string;
    imageTag?: string;
    /**
     * `<plugin id>=name@sha256:…`, the same list the socket proxy enforces.
     * When the Docker host is the proxy, an image that is not pinned is refused.
     */
    pins?: ReadonlyMap<string, string>;
    requireDigest?: boolean;
    /**
     * `APPS_RUNTIME_PLUGIN_CONSTRAINTS`: the Swarm placement constraints set
     * on every plugin service, the same list the socket proxy requires
     * (`SOCKET_PROXY_PLUGIN_CONSTRAINTS`). Empty: no placement.
     */
    constraints?: readonly string[];
    /** Swarm names of the apps service and the app service. They join each plugin network. */
    infraServices?: readonly string[];
    /** Swarm name of the egress proxy. Joined only when the manifest declares egress. */
    egressService?: string;
    /** `APPS_RUNTIME_EGRESS_PROXY`, without credentials. Credentials are signed per plugin. */
    egressProxy?: string;
    /**
     * Swarm secret names this runtime may resolve. Empty means a manifest
     * secret cannot install. Deprecated with `service.secrets`; plugins get
     * their identity through `identity`.
     */
    secretNames?: ReadonlySet<string>;
    /**
     * Where a plugin's identity token goes: Swarm secrets through the socket
     * proxy in a deployment, files in development. Unset: a provision that
     * carries an identity is refused.
     */
    identity?: IdentityDelivery;
    log?: (line: string) => void;
}

/**
 * The registry login Socio sends with a provision, and its fingerprint,
 * kept as the service's `socio.registry` label so Socio's reconcile can
 * tell a service that has the current login from one that doesn't.
 */
export interface RegistryGrant extends RegistryCredential {
    fingerprint: string;
}

/** The label that carries a provision's registry login fingerprint. */
export const REGISTRY_LABEL = 'socio.registry';

export interface PluginServiceStatus {
    id: string;
    service: string;
    image: string;
    replicas: number;
    running: number;
    state: 'running' | 'starting' | 'stopped';
    /** The install revision the service was last provisioned with (`socio.plugin.revision`, CB-370). */
    revision?: string;
    /** The identity version it runs (`socio.identity`). */
    identity?: number;
    /** The fingerprint of the registry login it was last given (`socio.registry`). */
    registry?: string;
    /** Its running tasks' ids (CB-458), for `x-cb-runtime-task`. */
    tasks?: string[];
}

const LIST_TTL_MS = 2_000;

export class PluginServices {
    private listedAt = 0;
    private known = new Map<string, { port: number; name: string }>();
    private cursor = new Map<string, number>();
    private tasksAt = new Map<string, { at: number; ips: string[] }>();

    constructor(
        private engine: DockerEngine,
        private config: PluginServiceConfig,
    ) {}

    /** One list of managed services, reused for a moment so the ingress does not hammer the engine. */
    async refresh() {
        if (Date.now() - this.listedAt < LIST_TTL_MS) {
            return;
        }
        const listed = await this.engine.listManaged();
        const next = new Map<string, { port: number; name: string }>();
        for (const row of listed) {
            this.remember(row, next);
        }
        this.known = next;
        this.listedAt = Date.now();
    }

    private remember(row: DockerServiceRecord, into = this.known) {
        const id = row.labels['socio.plugin'];
        const port = Number(row.labels['socio.plugin.port']);
        if (!id || !Number.isInteger(port)) {
            return;
        }
        into.set(id, { port, name: row.name });
    }

    owns(id: string) {
        return this.known.has(id);
    }

    proof(id: string) {
        return pluginProof(this.config.secret, id);
    }

    /**
     * Task addresses, this request's first, then the rest. One failure tries
     * the next. `revision` (CB-370): only while the service runs exactly that
     * install revision (`socio.plugin.revision`), and only its tasks of the
     * service's current container revision (`revision.ts`), both read fresh
     * from the engine, so a request never reaches a task an update is
     * replacing, nor a service provisioned from another manifest; none is
     * there until one is.
     */
    async targets(id: string, revision?: string) {
        const meta = this.known.get(id);
        if (!meta) {
            return [];
        }
        let ips: string[];
        if (revision !== undefined) {
            const [service, tasks] = await Promise.all([
                this.engine.findService(meta.name),
                this.engine.tasks(meta.name),
            ]);
            const container = service?.revision;
            ips =
                container && revision && service.labels['socio.plugin.revision'] === revision
                    ? tasks
                          .filter((task) => task.state === 'running' && task.revision === container)
                          .map((task) => task.ip)
                    : [];
        } else {
            let cached = this.tasksAt.get(id);
            if (!cached || Date.now() - cached.at >= LIST_TTL_MS) {
                const tasks = await this.engine.tasks(meta.name);
                cached = {
                    at: Date.now(),
                    ips: tasks.filter((task) => task.state === 'running').map((task) => task.ip),
                };
                this.tasksAt.set(id, cached);
            }
            ips = cached.ips;
        }
        if (!ips.length) {
            return [];
        }
        const start = (this.cursor.get(id) ?? 0) % ips.length;
        this.cursor.set(id, (start + 1) % ips.length);
        const ordered = [...ips.slice(start), ...ips.slice(0, start)];
        return ordered.map((host) => ({ host, port: meta.port }));
    }

    /**
     * The addresses of one running task (CB-458), read fresh from the
     * engine: a host request pinned with `x-cb-runtime-task` goes there or
     * nowhere, never to another task. Empty when it isn't running.
     */
    async taskTargets(id: string, task: string) {
        const meta = this.known.get(id);
        if (!meta) {
            return [];
        }
        const tasks = await this.engine.tasks(meta.name);
        return tasks
            .filter((row) => row.state === 'running' && row.task === task)
            .map((row) => ({ host: row.ip, port: meta.port }));
    }

    /** The encoded login for this image's registry, when the grant is for it. */
    private registryAuthFor(image: string, registry: RegistryGrant | undefined) {
        return registry && imageRegistry(image) === registry.registry ? encodeRegistryAuth(registry) : undefined;
    }

    private async imageFor(id: string, spec: PluginServiceSpec, registry?: RegistryGrant) {
        const checked = checkServiceSpec(spec, {
            maxReplicas: this.config.maxReplicas,
            imageTag: this.config.imageTag,
        });
        let image = checked.image;
        const pin = this.config.pins?.get(id);
        if (pin) {
            if (image?.includes('@') && image !== pin) {
                throw new RuntimeError('The plugin image digest does not match APPS_RUNTIME_IMAGE_PINS.', 400);
            }
            if (!imageAllowed(pin, this.config.allow)) {
                throw new RuntimeError('The pinned image is outside APPS_RUNTIME_IMAGE_ALLOW.', 400);
            }
            image = pin;
        }
        if (spec.build && !pin) {
            if (this.config.requireDigest) {
                throw new RuntimeError(
                    'The socket proxy does not allow Docker builds. Pin a prebuilt image digest.',
                    400,
                );
            }
            if (!this.config.buildRoot || !this.engine.buildImage) {
                throw new RuntimeError(
                    'This runtime does not build plugin images. Set the service image to a prebuilt ref, or set APPS_RUNTIME_BUILD_ROOT.',
                    400,
                );
            }
            const tag = resolveImage(
                spec.image?.trim() || `${pluginServiceName(id)}:built`,
                this.config.imageTag ?? 'latest',
            );
            if (!imageAllowed(tag, this.config.allow)) {
                throw new RuntimeError('The built image is outside APPS_RUNTIME_IMAGE_ALLOW.', 400);
            }
            const context = buildContext(this.config.buildRoot, spec.build.context);
            await this.engine.buildImage({
                context,
                dockerfile: spec.build.dockerfile ?? 'Dockerfile',
                target: spec.build.target,
                tag,
            });
            image = tag;
        }
        if (!image || !imageAllowed(image, this.config.allow)) {
            throw new RuntimeError('The plugin image is outside APPS_RUNTIME_IMAGE_ALLOW.', 400);
        }
        if (this.config.requireDigest && !PINNED_IMAGE.test(image)) {
            throw new RuntimeError('The plugin image must be name@sha256:<digest> (APPS_RUNTIME_IMAGE_PINS).', 400);
        }
        if (this.config.pull && this.engine.pullImage) {
            await this.engine.pullImage(image, this.registryAuthFor(image, registry));
        }
        return { checked, image };
    }

    private async pluginNetwork(id: string) {
        const name = pluginNetworkName(id);
        const existing = await this.engine.inspectNetwork(name);
        if (existing) {
            if (existing.driver !== 'overlay' || !existing.internal) {
                throw new RuntimeError(`Docker network ${name} is not an internal overlay.`, 409);
            }
            return existing.id;
        }
        return this.engine.createNetwork({
            Name: name,
            Driver: 'overlay',
            Internal: true,
            Attachable: false,
            Ingress: false,
            CheckDuplicate: true,
            Labels: { 'socio.managed': 'plugin', 'socio.plugin': id },
        });
    }

    /**
     * Joins the infra services (the apps ingress and the app) to a plugin's
     * network, and the egress proxy when the plugin declares egress. Each
     * attach is a no-op when the service is already on the network, so it
     * is safe to repeat: a stack update replaces those services' networks
     * with the stack file's, which doesn't know the plugins. A plugin with
     * no egress (now) loses the egress proxy (CB-441: its url setting was
     * cleared, or an update dropped its hosts), so credentials it kept from
     * an earlier provision reach nothing; a no-op when it isn't attached.
     */
    private async attachInfra(networkId: string, egress: boolean) {
        for (const serviceName of this.config.infraServices ?? []) {
            await this.engine.attachServiceNetwork(serviceName, networkId);
        }
        if (this.config.egressService) {
            await (egress
                ? this.engine.attachServiceNetwork(this.config.egressService, networkId)
                : this.engine.detachServiceNetwork(this.config.egressService, networkId));
        }
    }

    /**
     * Re-attaches the infra services to an installed plugin's network
     * (Socio's reconcile, at boot and on its tick): no change to the plugin
     * service, and none to an infra service already attached.
     */
    async repairNetworks(id: string, egress: boolean) {
        const existing = await this.engine.findService(pluginServiceName(id));
        if (!existing || existing.labels['socio.managed'] !== 'plugin' || existing.labels['socio.plugin'] !== id) {
            throw new RuntimeError('That plugin service is not running here.', 404);
        }
        const name = pluginNetworkName(id);
        const network = await this.engine.inspectNetwork(name);
        if (!network) {
            throw new RuntimeError(`Docker network ${name} was not found. Provision the plugin again.`, 404);
        }
        if (network.driver !== 'overlay' || !network.internal) {
            throw new RuntimeError(`Docker network ${name} is not an internal overlay.`, 409);
        }
        if (egress && !this.config.egressService) {
            throw new RuntimeError('This plugin declares egress and APPS_RUNTIME_EGRESS_SERVICE is not set.', 400);
        }
        await this.attachInfra(network.id, egress);
        return { ok: true as const };
    }

    private async write(
        id: string,
        spec: PluginServiceSpec,
        replicas: number,
        grant?: IdentityGrant,
        registry?: RegistryGrant,
    ) {
        const { image } = await this.imageFor(
            id,
            {
                ...spec,
                replicas: Math.max(replicas, 1),
            },
            registry,
        );
        const egress = egressHostnames(spec.egress);
        if (egress.length && !this.config.egressProxy) {
            throw new RuntimeError('This plugin declares egress and APPS_RUNTIME_EGRESS_PROXY is not set.', 400);
        }
        if (egress.length && !this.config.egressService) {
            throw new RuntimeError('This plugin declares egress and APPS_RUNTIME_EGRESS_SERVICE is not set.', 400);
        }
        const networkId = await this.pluginNetwork(id);
        await this.attachInfra(networkId, egress.length > 0);
        const egressProxy =
            egress.length && this.config.egressProxy
                ? egressProxyUrl(this.config.egressProxy, this.config.secret, id, egressEntries(egress))
                : undefined;
        const secretIds = await this.secretIdsFor(spec);
        const ref: WorkloadRef = { kind: 'plugin', id };
        let identity: DeliveredIdentity | undefined;
        if (grant) {
            if (!this.config.identity) {
                throw new RuntimeError(
                    'This runtime has no identity delivery, so it cannot give a plugin its identity.',
                    503,
                );
            }
            identity = await this.config.identity.deliver(ref, grant.token, grant.version);
        }
        const name = pluginServiceName(id);
        try {
            const body = swarmServiceBody({
                id,
                image,
                spec,
                replicas,
                networkId,
                proof: this.proof(id),
                actorKey: pluginActorKey(this.config.secret, id),
                ...(egressProxy ? { egressProxy } : {}),
                secretIds,
                ...(identity ? { identity } : {}),
                ...(this.config.constraints?.length ? { constraints: this.config.constraints } : {}),
            });
            if (registry) {
                body.Labels[REGISTRY_LABEL] = registry.fingerprint;
            }
            // Only for the image's own registry: a login never goes to another host.
            const registryAuth = this.registryAuthFor(image, registry);
            const existing = await this.engine.findService(name);
            if (existing) {
                if (existing.labels['socio.managed'] !== 'plugin' || existing.labels['socio.plugin'] !== id) {
                    throw new RuntimeError(`A service named ${name} exists and is not a Socio plugin.`, 409);
                }
                // A service that was given a login and gets none now (removed,
                // or for another registry): an empty one replaces it, since
                // Swarm keeps the old one through an update without the header.
                const previous = existing.labels[REGISTRY_LABEL];
                await this.engine.updateService(
                    existing.id,
                    existing.version,
                    body,
                    registryAuth ?? (previous ? NO_REGISTRY_AUTH : undefined),
                );
            } else {
                await this.engine.createService(body, registryAuth);
            }
        } catch (error) {
            // The new version never reached a service: take it back, keep the old.
            if (identity && grant) {
                await this.config.identity?.discard(ref, grant.version).catch(() => undefined);
            }
            throw error;
        }
        if (identity && grant) {
            // The service references only the new secret now; old tasks keep
            // their mounted copy until they stop. A refusal is retried at the
            // next rotation, which looks back RETIRE_SPAN versions.
            await this.config.identity?.retire(ref, grant.version).catch((error: unknown) => {
                this.config.log?.(
                    `Apps runtime: plugin ${id}: ${error instanceof Error ? error.message : 'retiring old identity versions failed.'}`,
                );
            });
        }
        this.known.set(id, { port: spec.port, name });
        this.listedAt = Date.now();
        this.tasksAt.delete(id);
        return image;
    }

    /** Creates or updates a plugin's service; with `identity`, delivers that version first. */
    async ensure(
        id: string,
        spec: PluginServiceSpec,
        identity?: IdentityGrant,
        registry?: RegistryGrant,
    ): Promise<PluginServiceStatus> {
        const image = await this.write(id, spec, spec.replicas ?? 1, identity, registry);
        return {
            ...(await this.statusOf(id, image, spec.replicas ?? 1)),
            ...(registry ? { registry: registry.fingerprint } : {}),
        };
    }

    async scale(id: string, replicas: number): Promise<PluginServiceStatus> {
        if (!Number.isInteger(replicas) || replicas < 0 || replicas > this.config.maxReplicas) {
            throw new RuntimeError(`Plugin replicas must be from 0 to ${this.config.maxReplicas}.`, 400);
        }
        const name = pluginServiceName(id);
        const existing = await this.engine.findService(name);
        if (!existing || existing.labels['socio.managed'] !== 'plugin' || existing.labels['socio.plugin'] !== id) {
            throw new RuntimeError('That plugin service is not running here.', 404);
        }
        await this.engine.scaleService(existing.id, existing.version, replicas);
        const port = Number(existing.labels['socio.plugin.port']);
        if (Number.isInteger(port)) {
            this.known.set(id, { port, name });
        }
        this.listedAt = Date.now();
        this.tasksAt.delete(id);
        return this.statusOf(id, existing.image, replicas);
    }

    /** Allowlisted secret names only. A name Swarm cannot resolve fails the install. */
    private async secretIdsFor(spec: PluginServiceSpec) {
        const ids = new Map<string, string>();
        const allow = this.config.secretNames ?? new Set<string>();
        for (const secret of spec.secrets ?? []) {
            if (!allow.has(secret.name)) {
                throw new RuntimeError(`Secret ${secret.name} is not in APPS_RUNTIME_SECRET_NAMES.`, 400);
            }
            const id = await this.engine.secretId(secret.name);
            if (!id) {
                throw new RuntimeError(`Swarm secret ${secret.name} was not found.`, 400);
            }
            ids.set(secret.name, id);
        }
        return ids;
    }

    async remove(id: string) {
        const name = pluginServiceName(id);
        const existing = await this.engine.findService(name);
        if (existing) {
            if (existing.labels['socio.managed'] !== 'plugin' || existing.labels['socio.plugin'] !== id) {
                throw new RuntimeError(`Refusing to delete ${name}: it is not a Socio plugin service.`, 409);
            }
            await this.engine.removeService(existing.id);
            for (const volume of existing.volumes) {
                await this.engine.removeVolume(volume.source);
            }
            // Every identity version the service may have had goes with it.
            const delivered = Number(existing.labels['socio.identity']);
            if (Number.isInteger(delivered) && delivered > 0) {
                await this.config.identity?.retire({ kind: 'plugin', id }, delivered + 1).catch(() => {
                    this.config.log?.(`Apps runtime: plugin ${id}: an identity secret outlived its service.`);
                });
            }
        }
        const network = await this.engine.inspectNetwork(pluginNetworkName(id));
        if (network) {
            const holders = [
                ...(this.config.infraServices ?? []),
                ...(this.config.egressService ? [this.config.egressService] : []),
            ];
            for (const serviceName of holders) {
                await this.engine.detachServiceNetwork(serviceName, network.id).catch(() => undefined);
            }
            await this.engine.removeNetwork(network.id);
        }
        this.known.delete(id);
        this.tasksAt.delete(id);
        this.cursor.delete(id);
    }

    async status(id: string): Promise<PluginServiceStatus | undefined> {
        const existing = await this.engine.findService(pluginServiceName(id));
        if (!existing || existing.labels['socio.plugin'] !== id) {
            return undefined;
        }
        const tasks = await this.engine.tasks(existing.name);
        const running = tasks.filter((task) => task.state === 'running').length;
        const ids = [...new Set(tasks.flatMap((task) => (task.state === 'running' && task.task ? [task.task] : [])))];
        return {
            id,
            service: existing.name,
            image: existing.image,
            replicas: existing.replicas,
            running,
            state: existing.replicas === 0 ? 'stopped' : running > 0 ? 'running' : 'starting',
            ...(existing.labels['socio.plugin.revision'] ? { revision: existing.labels['socio.plugin.revision'] } : {}),
            ...(existing.labels['socio.identity'] ? { identity: Number(existing.labels['socio.identity']) } : {}),
            ...(existing.labels[REGISTRY_LABEL] ? { registry: existing.labels[REGISTRY_LABEL] } : {}),
            tasks: ids,
        };
    }

    private async statusOf(id: string, image: string, replicas: number): Promise<PluginServiceStatus> {
        const tasks = await this.engine.tasks(pluginServiceName(id));
        const running = tasks.filter((task) => task.state === 'running').length;
        return {
            id,
            service: pluginServiceName(id),
            image,
            replicas,
            running,
            state: replicas === 0 ? 'stopped' : running > 0 ? 'running' : 'starting',
        };
    }
}
