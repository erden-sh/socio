import {
    PLUGIN_DEFAULT_CPUS,
    PLUGIN_DEFAULT_MEMORY_MB,
    resolvePluginEgress,
    type PluginVolume,
} from './plugin-service.js';
import {
    PLUGIN_WEBHOOK_BODY_DEFAULT,
    PLUGIN_WEBHOOK_PER_MINUTE_DEFAULT,
    pluginNeedAccess,
    type PluginManifest,
    type PluginWebhook,
} from './plugins.js';

/**
 * What a plugin update from the catalog adds to what the installed version
 * may do or reach (CB-531): the admin reviews it, and the server adopts the
 * new manifest only with an acknowledgment that names exactly these. Each
 * addition has a stable `key`; removals, and a new image or version alone,
 * add nothing.
 */
export type PluginUpdateAddition =
    /** A host its service may now reach (a `fromConfig` one resolved from the stored settings). */
    | { key: string; kind: 'egress'; host: string }
    /** A new `{ fromConfig }` egress entry: the host its setting names, now or later. */
    | { key: string; kind: 'egress-setting'; field: string; host?: string }
    /** A permission (scope) the installed version doesn't request. */
    | { key: string; kind: 'permission'; permission: string }
    /** A URL the embed may now ask the host to open. */
    | { key: string; kind: 'bridge-open'; url: string }
    /** The sensitive scope `bridge.openAnyHttps`. */
    | { key: string; kind: 'bridge-open-any-https' }
    /** It now renders inside the workspace (`display: embed`), where its `bridge` applies. */
    | { key: string; kind: 'embed' }
    /** A socio-access action it didn't declare, or one at another tier (`delegation.actions`). */
    | { key: string; kind: 'action'; action: string; tier: string; from?: string }
    /** `delegation.alwaysAsk` dropped: a socio's access request may be approved without the person's card. */
    | { key: string; kind: 'always-ask-dropped' }
    /** Deep links (`bridge.routes`). */
    | { key: string; kind: 'bridge-routes' }
    /** A Socio Secret it reads (`secrets`), required or optional. */
    | { key: string; kind: 'secret'; name: string; required: boolean }
    /** A runtime secret mounted into its service (`service.secrets`). */
    | { key: string; kind: 'service-secret'; name: string }
    /** A dataset need it didn't have. */
    | { key: string; kind: 'dataset'; name: string; access: 'read' | 'write' }
    /** A read need that now writes. */
    | { key: string; kind: 'dataset-write'; name: string }
    /** A public inbound path (`webhooks`). */
    | { key: string; kind: 'webhook'; method: 'GET' | 'POST'; path: string }
    /** A public path's body or rate limit, raised. */
    | { key: string; kind: 'webhook-limit'; method: 'GET' | 'POST'; path: string }
    /** A path it serves without an actor envelope (`delegation.public`). */
    | { key: string; kind: 'public-path'; path: string }
    /** More CPUs than the installed version requests. */
    | { key: string; kind: 'cpus'; from: number; to: number }
    /** More memory, in MB. */
    | { key: string; kind: 'memory'; from: number; to: number }
    /** A volume it didn't have, or one declared differently. */
    | { key: string; kind: 'volume'; name: string };

/**
 * An update's review, as `/api/plugins` lists it on an installed plugin and
 * a refused update (409) answers it: what the new version adds, the
 * settings whose stored values it deletes, and the two revisions an
 * acknowledgment is bound to.
 */
export interface PluginUpdateReview {
    /** The catalog's version, which **Update** adopts. */
    version: string;
    /** The installed manifest's revision (a SHA-256 of it). */
    from: string;
    /** The catalog manifest's revision: the update an acknowledgment is for. */
    to: string;
    additions: PluginUpdateAddition[];
    /** Settings with a stored value the new version doesn't declare: their values are deleted. */
    removedSettings: string[];
    /** The new manifest has `bridge.openAnyHttps`. */
    openAnyHttps: boolean;
    /** It adds `bridge.openAnyHttps` (one of `additions`). */
    addsOpenAnyHttps: boolean;
}

/**
 * What `POST /api/plugins/:id/update` takes as `acknowledged` when the
 * update adds anything: both revisions of the review the admin confirmed,
 * and the keys of every addition it listed.
 */
export interface PluginUpdateAck {
    from: string;
    to: string;
    additions: string[];
}

/** The most addition keys an acknowledgment may name. */
export const PLUGIN_UPDATE_ACK_MAX = 512;

/** `host` and `host:443` are one host. */
const egressKey = (host: string) => host.toLowerCase().replace(/:443$/, '');

const webhookMethod = (method: string | undefined): 'GET' | 'POST' => (method === 'GET' ? 'GET' : 'POST');

const volumeShape = (volume: PluginVolume) =>
    JSON.stringify([volume.mount, volume.shared === true, volume.driver ?? '', volume.ephemeral === true]);

/**
 * What `next` adds over `installed`, with `config` the install's stored
 * settings (for the hosts `fromConfig` egress resolves to), and the stored
 * settings the update deletes. Pure, so the server, the web and mobile
 * clients agree on it.
 */
export function pluginUpdateDiff(
    installed: PluginManifest,
    next: PluginManifest,
    config: Readonly<Record<string, string>>,
): { additions: PluginUpdateAddition[]; removedSettings: string[] } {
    const additions: PluginUpdateAddition[] = [];
    const seen = new Set<string>();
    const add = (addition: PluginUpdateAddition) => {
        if (!seen.has(addition.key)) {
            seen.add(addition.key);
            additions.push(addition);
        }
    };
    const nextFields = next.config ?? {};
    const kept = Object.fromEntries(Object.entries(config).filter(([key]) => Object.hasOwn(nextFields, key)));

    // Egress: the hosts the runtime would get, before and after.
    const before = resolvePluginEgress(installed.service?.egress, installed.config, config);
    const after = resolvePluginEgress(next.service?.egress, next.config, kept);
    const reached = new Set(before.hosts.map(egressKey));
    for (const host of after.hosts) {
        if (!reached.has(egressKey(host))) {
            add({ key: `egress:${egressKey(host)}`, kind: 'egress', host: egressKey(host) });
        }
    }
    const settingsBefore = new Set(
        (installed.service?.egress ?? []).flatMap((entry) => (typeof entry === 'string' ? [] : [entry.fromConfig])),
    );
    for (const entry of next.service?.egress ?? []) {
        if (typeof entry !== 'string' && !settingsBefore.has(entry.fromConfig)) {
            const host = after.settings.find((setting) => setting.field === entry.fromConfig)?.host;
            add({
                key: `egress-setting:${entry.fromConfig}`,
                kind: 'egress-setting',
                field: entry.fromConfig,
                ...(host ? { host: egressKey(host) } : {}),
            });
        }
    }

    // Permissions.
    const permissions = new Set(installed.permissions ?? []);
    for (const permission of next.permissions ?? []) {
        if (!permissions.has(permission)) {
            add({ key: `permission:${permission}`, kind: 'permission', permission });
        }
    }

    // Display: an embed's bridge applies inside the workspace.
    if (next.display === 'embed' && installed.display !== 'embed') {
        add({ key: 'display:embed', kind: 'embed' });
    }

    // Bridge.
    const opens = new Set(installed.bridge?.open ?? []);
    for (const url of next.bridge?.open ?? []) {
        if (!opens.has(url)) {
            add({ key: `bridge-open:${url}`, kind: 'bridge-open', url });
        }
    }
    if (next.bridge?.openAnyHttps === true && installed.bridge?.openAnyHttps !== true) {
        add({ key: 'bridge.openAnyHttps', kind: 'bridge-open-any-https' });
    }
    if (next.bridge?.routes === true && installed.bridge?.routes !== true) {
        add({ key: 'bridge.routes', kind: 'bridge-routes' });
    }

    // Secrets: Socio Secrets it reads (`secrets`), required or optional, and
    // runtime secrets mounted into its service (`service.secrets`), apart:
    // they are separate grants even under one name.
    const socioSecrets = new Set((installed.secrets ?? []).map((secret) => secret.name));
    for (const secret of next.secrets ?? []) {
        if (!socioSecrets.has(secret.name)) {
            add({
                key: `secret:${secret.name}`,
                kind: 'secret',
                name: secret.name,
                required: secret.required === true,
            });
        }
    }
    const mounted = new Set((installed.service?.secrets ?? []).map((ref) => ref.name));
    for (const ref of next.service?.secrets ?? []) {
        if (!mounted.has(ref.name)) {
            add({ key: `service-secret:${ref.name}`, kind: 'service-secret', name: ref.name });
        }
    }

    // Datasets: a new need, or a read need that now writes.
    const needs = new Map((installed.datasets ?? []).map((need) => [need.name, pluginNeedAccess(need)]));
    for (const need of next.datasets ?? []) {
        const access = pluginNeedAccess(need);
        const had = needs.get(need.name);
        if (!had) {
            add({ key: `dataset:${need.name}`, kind: 'dataset', name: need.name, access });
        } else if (had === 'read' && access === 'write') {
            add({ key: `dataset-write:${need.name}`, kind: 'dataset-write', name: need.name });
        }
    }

    // Public paths: webhooks (with their limits) and delegation's own.
    const hooks = new Map<string, PluginWebhook>(
        (installed.webhooks ?? []).map((hook) => [`${webhookMethod(hook.method)} ${hook.path}`, hook]),
    );
    for (const hook of next.webhooks ?? []) {
        const method = webhookMethod(hook.method);
        const id = `${method} ${hook.path}`;
        const had = hooks.get(id);
        if (!had) {
            add({ key: `webhook:${id}`, kind: 'webhook', method, path: hook.path });
            continue;
        }
        const body = (value: number | undefined) => (method === 'GET' ? 0 : (value ?? PLUGIN_WEBHOOK_BODY_DEFAULT));
        const rate = (value: number | undefined) => value ?? PLUGIN_WEBHOOK_PER_MINUTE_DEFAULT;
        if (body(hook.maxBodyBytes) > body(had.maxBodyBytes) || rate(hook.perMinute) > rate(had.perMinute)) {
            add({ key: `webhook-limit:${id}`, kind: 'webhook-limit', method, path: hook.path });
        }
    }
    // Delegation: a new action, or one at another tier (higher does more; lower
    // asks less: `admin` is never delegated, `consequential` needs an approval),
    // and every access request no longer showing the person's card.
    const actions = installed.delegation?.actions ?? {};
    for (const [action, tier] of Object.entries(next.delegation?.actions ?? {})) {
        const had = Object.hasOwn(actions, action) ? actions[action] : undefined;
        if (had !== tier) {
            add({
                key: `action:${action}:${tier}`,
                kind: 'action',
                action,
                tier,
                ...(had ? { from: had } : {}),
            });
        }
    }
    if (installed.delegation?.alwaysAsk === true && next.delegation?.alwaysAsk !== true) {
        add({ key: 'delegation.alwaysAsk', kind: 'always-ask-dropped' });
    }
    const publicPaths = new Set(installed.delegation?.public ?? []);
    for (const path of next.delegation?.public ?? []) {
        if (!publicPaths.has(path)) {
            add({ key: `public-path:${path}`, kind: 'public-path', path });
        }
    }

    // Resources.
    const cpus = (manifest: PluginManifest) => manifest.service?.resources?.cpus ?? PLUGIN_DEFAULT_CPUS;
    const memory = (manifest: PluginManifest) => manifest.service?.resources?.memoryMb ?? PLUGIN_DEFAULT_MEMORY_MB;
    if (cpus(next) > cpus(installed)) {
        add({ key: `cpus:${cpus(next)}`, kind: 'cpus', from: cpus(installed), to: cpus(next) });
    }
    if (memory(next) > memory(installed)) {
        add({ key: `memory:${memory(next)}`, kind: 'memory', from: memory(installed), to: memory(next) });
    }
    const volumes = new Map((installed.service?.volumes ?? []).map((volume) => [volume.name, volumeShape(volume)]));
    for (const volume of next.service?.volumes ?? []) {
        if (volumes.get(volume.name) !== volumeShape(volume)) {
            add({ key: `volume:${volume.name}`, kind: 'volume', name: volume.name });
        }
    }

    const removedSettings = Object.keys(config)
        .filter((key) => !Object.hasOwn(nextFields, key))
        .sort();
    return { additions, removedSettings };
}

/** One addition in plain words, for the update review. */
export function pluginUpdateAdditionLabel(addition: PluginUpdateAddition): string {
    switch (addition.kind) {
        case 'egress':
            return `Can now reach ${addition.host}`;
        case 'egress-setting':
            return addition.host
                ? `Can now reach the host in its setting ${addition.field} (now ${addition.host})`
                : `Can reach the host you enter in its setting ${addition.field}`;
        case 'permission':
            return `Asks for the permission ${addition.permission}`;
        case 'bridge-open':
            return `Can ask to open ${addition.url} in a new tab`;
        case 'bridge-open-any-https':
            return 'Can ask to open any https link, after the person confirms it (a sensitive scope)';
        case 'embed':
            return 'Now opens inside the workspace instead of in a new tab';
        case 'action':
            return addition.from
                ? `Changes its socio action ${addition.action} from ${addition.from} to ${addition.tier}`
                : `Lets socios ask for its action ${addition.action} (${addition.tier})`;
        case 'always-ask-dropped':
            return 'No longer shows the person’s card on every socio access request';
        case 'bridge-routes':
            return 'Gets deep links: its own pages get workspace addresses';
        case 'secret':
            return `Asks for a new ${addition.required ? 'required' : 'optional'} secret ${addition.name}`;
        case 'service-secret':
            return `Gets the runtime secret ${addition.name} mounted into its service`;
        case 'dataset':
            return `Needs a new dataset ${addition.name}, to ${addition.access === 'read' ? 'read' : 'read and write'}`;
        case 'dataset-write':
            return `Can now write to the dataset ${addition.name}, which it only read`;
        case 'webhook':
            return `Takes public ${addition.method} requests at ${addition.path}, with no sign-in`;
        case 'webhook-limit':
            return `Takes larger or more frequent public requests at ${addition.method} ${addition.path}`;
        case 'public-path':
            return `Serves ${addition.path} without a socio’s envelope`;
        case 'cpus':
            return `Requests ${addition.to} CPUs, up from ${addition.from}`;
        case 'memory':
            return `Requests ${addition.to} MB of memory, up from ${addition.from} MB`;
        case 'volume':
            return `Keeps data on a new or changed volume ${addition.name}`;
    }
}

/**
 * Whether `ack` acknowledges exactly `review`: both revisions, and every
 * addition named, nothing more or less.
 */
export function pluginUpdateAcknowledged(
    review: Pick<PluginUpdateReview, 'from' | 'to' | 'additions'>,
    ack: PluginUpdateAck | undefined,
) {
    if (!ack || ack.from !== review.from || ack.to !== review.to) {
        return false;
    }
    const named = new Set(ack.additions);
    return named.size === review.additions.length && review.additions.every((addition) => named.has(addition.key));
}

/** The acknowledgment of `review`, as the client sends it after the admin confirms. */
export const pluginUpdateAck = (review: Pick<PluginUpdateReview, 'from' | 'to' | 'additions'>): PluginUpdateAck => ({
    from: review.from,
    to: review.to,
    additions: review.additions.map((addition) => addition.key),
});
