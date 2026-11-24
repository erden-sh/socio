/**
 * The coding sandbox's package registries (CB-239): each
 * allowlisted registry is a plain-HTTP virtual host on the coding egress
 * proxy, `<name>.registry.socio.internal`, served read-only and forwarded
 * over TLS to the real host. The default is npm and PyPI; admins add more
 * in Settings → Coding over the env default `CODING_EGRESS_ALLOW`.
 *
 * Socio puts the sandbox's list into its proxy credential (`allow`, one
 * `name=host` entry each, CB-232 keys.ts `signEgressCredential`), so an
 * admin's change reaches the next sandbox without redeploying the proxy.
 * Imports nothing: the proxy and the server both use it.
 */

/** The model and Git gateway's virtual host on the proxy. */
export const GATEWAY_HOST = 'gateway.socio.internal';
/** The parent of every registry virtual host. */
export const REGISTRY_DOMAIN = 'registry.socio.internal';

export interface CodingRegistry {
    /** One DNS label: the virtual host is `<name>.registry.socio.internal`. */
    name: string;
    /** The real registry host, reached over TLS on 443. */
    host: string;
}

/** npm and PyPI; PyPI's files host has its own name. */
export const DEFAULT_CODING_REGISTRIES = 'npm=registry.npmjs.org pypi=pypi.org pypi-files=files.pythonhosted.org';

/** At most this many registries per sandbox (a credential stays small). */
export const MAX_CODING_REGISTRIES = 20;

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** A public DNS name with a dot: no IP literals, no ports. */
const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
/** Names that are never a public registry, whatever they resolve to. */
const RESERVED = /(?:^|\.)(?:internal|local|localhost|localdomain|lan|home|arpa)$/;

export const registryVirtualHost = (name: string) => `${name}.${REGISTRY_DOMAIN}`;

/** One registry from `name=host`, or undefined when either part is unfit. */
export function readRegistryEntry(entry: string): CodingRegistry | undefined {
    const match = /^([^=]+)=([^=]+)$/.exec(entry.trim().toLowerCase());
    if (!match) {
        return undefined;
    }
    const [, name, host] = match;
    if (!NAME.test(name) || !HOST.test(host) || RESERVED.test(host)) {
        return undefined;
    }
    return { name, host };
}

/** The credential's `allow` entry for a registry. */
export const registryAllowEntry = (registry: CodingRegistry) => `${registry.name}=${registry.host}`;

/**
 * `CODING_EGRESS_ALLOW` (or the admin's list): `name=host` entries separated
 * by spaces or commas. Throws on anything else, so a typo fails loudly at
 * start rather than silently narrowing the list.
 */
export function parseCodingRegistries(raw: string | undefined = DEFAULT_CODING_REGISTRIES): CodingRegistry[] {
    const entries = raw
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    if (entries.length > MAX_CODING_REGISTRIES) {
        throw new Error(`CODING_EGRESS_ALLOW: at most ${MAX_CODING_REGISTRIES} registries.`);
    }
    const registries: CodingRegistry[] = [];
    for (const entry of entries) {
        const registry = readRegistryEntry(entry);
        if (!registry) {
            throw new Error(
                `CODING_EGRESS_ALLOW: "${entry.slice(0, 80)}" is not name=host (a lowercase label and a public DNS name).`,
            );
        }
        if (registries.some((other) => other.name === registry.name || other.host === registry.host)) {
            throw new Error(`CODING_EGRESS_ALLOW: "${registry.name}" or "${registry.host}" is listed twice.`);
        }
        registries.push(registry);
    }
    return registries;
}
