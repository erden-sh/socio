/**
 * The registry login plugin services pull their images with: an admin's
 * workspace secret `PLUGIN_REGISTRY_AUTH` (Settings → Secrets), over the
 * deployment's `PLUGIN_REGISTRY_AUTH` (`_FILE`). Both hold the same JSON:
 * `{"registry": "ghcr.io", "username": "…", "password": "…"}`. Socio sends
 * it with every plugin service create and update, so Swarm keeps it with
 * the service and every task start can pull a private image, on any node.
 */

/** The workspace secret's name, and the environment setting's. */
export const PLUGIN_REGISTRY_SECRET = 'PLUGIN_REGISTRY_AUTH';

export interface RegistryCredential {
    /** The registry host, e.g. `ghcr.io`; `docker.io` for Docker Hub. */
    registry: string;
    username: string;
    /** A read-only token (for GHCR, a classic token with `read:packages`). */
    password: string;
}

const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/;
const FORMAT = `${PLUGIN_REGISTRY_SECRET} must hold JSON: {"registry": "ghcr.io", "username": "…", "password": "…"}.`;

/** `https://GHCR.io/` → `ghcr.io`; Docker Hub's names → `docker.io`. */
export function normalizeRegistry(value: string) {
    const host = value
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '');
    return host === 'index.docker.io' || host === 'registry-1.docker.io' ? 'docker.io' : host;
}

/**
 * The registry an image reference pulls from, as Docker reads it: the first
 * path part when it looks like a host (`.`, `:` or `localhost`), else
 * Docker Hub.
 */
export function imageRegistry(image: string) {
    const slash = image.indexOf('/');
    if (slash < 0) {
        return 'docker.io';
    }
    const first = image.slice(0, slash);
    return first.includes('.') || first.includes(':') || first === 'localhost' ? normalizeRegistry(first) : 'docker.io';
}

/** Parses and checks a stored credential. The error never quotes the value. */
export function parseRegistryCredential(text: string): RegistryCredential {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(FORMAT);
    }
    const row =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    const { registry, username, password } = row;
    if (typeof registry !== 'string' || typeof username !== 'string' || typeof password !== 'string') {
        throw new Error(FORMAT);
    }
    const host = normalizeRegistry(registry);
    if (!HOST.test(host) || !username.trim() || !password.trim() || username.length > 256 || password.length > 4096) {
        throw new Error(FORMAT);
    }
    return { registry: host, username: username.trim(), password: password.trim() };
}
