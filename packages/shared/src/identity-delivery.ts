/**
 * Workload identity delivery (Socio Secrets phase 2): Socio mints one
 * identity token per plugin and a platform adapter puts it where the
 * plugin's service reads it. The workload only ever sees a file, named by
 * `SOCIO_IDENTITY_FILE`; nothing platform-specific reaches it.
 *
 * The port's types live here (the shared service-body builder consumes a
 * delivery); the adapters are the apps runtime's
 * (`src/apps-runtime/identity-delivery.ts`). A Kubernetes
 * adapter adds one `IdentityMount` kind and its own adapter; callers
 * (`PluginServices`) don't change.
 */

import {
    IDENTITY_FILE_ENV,
    PLUGIN_ID,
    SWARM_IDENTITY_FILE,
    SWARM_IDENTITY_PATH,
    pluginNamePrefix,
} from './plugins/plugin-service.js';

export { IDENTITY_FILE_ENV, SWARM_IDENTITY_FILE, SWARM_IDENTITY_PATH };

/** Every plugin identity token starts with this, so Socio can route it before a lookup. */
export const PLUGIN_IDENTITY_PREFIX = 'cbpi_';
/** `cbpi_` and 43 base64url characters (32 random bytes). */
export const PLUGIN_IDENTITY_TOKEN = /^cbpi_[A-Za-z0-9_-]{43}$/;

/** Swarm limits secret names to 64 characters. */
export const SWARM_SECRET_NAME_MAX = 64;

/** Who an identity is for. Only plugins have delivered identities (apps keep their data token). */
export interface WorkloadRef {
    kind: 'plugin';
    id: string;
}

/** What Socio sends the runtime with a provision: a fresh token and its version. */
export interface IdentityGrant {
    token: string;
    version: number;
}

/** How a platform attaches the delivered file to the workload; opaque to callers. */
export type IdentityMount = { kind: 'swarm-secret'; secretId: string; secretName: string; file: string };

export interface DeliveredIdentity {
    /** Always `SOCIO_IDENTITY_FILE`. */
    fileEnv: typeof IDENTITY_FILE_ENV;
    /** Where the workload reads the token. */
    path: string;
    version: number;
    /** Absent when the file is already where the workload runs (local). */
    mount?: IdentityMount;
}

/** The port. One adapter per platform. */
export interface IdentityDelivery {
    readonly platform: 'local' | 'swarm';
    /** Put the token where the workload reads it. */
    deliver(workload: WorkloadRef, token: string, version: number): Promise<DeliveredIdentity>;
    /** Remove every delivered version older than `keep`. Best effort: a version still in use stays. */
    retire(workload: WorkloadRef, keep: number): Promise<void>;
    /** Remove one version that never reached the workload (its provision failed). */
    discard(workload: WorkloadRef, version: number): Promise<void>;
}

/**
 * The Swarm secret of one identity version: `<PLUGIN_NAME_PREFIX>-wl-<id>-v<n>`.
 * The deployment's prefix keeps two deployments on one swarm apart (CB-327);
 * the socket proxy creates and deletes only names of this shape.
 */
export function identitySecretName(pluginId: string, version: number) {
    if (!PLUGIN_ID.test(pluginId) || !Number.isInteger(version) || version < 1) {
        throw new Error('An identity secret needs a plugin id and a positive version.');
    }
    const name = `${pluginNamePrefix()}-wl-${pluginId}-v${version}`;
    if (name.length > SWARM_SECRET_NAME_MAX) {
        throw new Error(
            `The identity secret name ${name.slice(0, 80)} is longer than Swarm's ${SWARM_SECRET_NAME_MAX} characters: use a shorter plugin id or PLUGIN_NAME_PREFIX.`,
        );
    }
    return name;
}

/** An identity secret name of this deployment; group 1 is the plugin id, group 2 the version. */
export const identitySecretNamePattern = () =>
    new RegExp(`^${pluginNamePrefix()}-wl-([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)-v([1-9]\\d{0,8})$`);

/** The plugin id and version of an identity secret name of this deployment, or undefined. */
export function parseIdentitySecretName(name: string) {
    if (typeof name !== 'string' || name.length > SWARM_SECRET_NAME_MAX) {
        return undefined;
    }
    const match = identitySecretNamePattern().exec(name);
    if (!match || !PLUGIN_ID.test(match[1]!)) {
        return undefined;
    }
    return { pluginId: match[1]!, version: Number(match[2]) };
}

/** The labels every identity secret carries, and the proxy requires on create and delete. */
export const identitySecretLabels = (pluginId: string) => ({
    'socio.managed': 'plugin',
    'socio.plugin': pluginId,
});
