import { CLOUD_ISSUER_DEFAULT, type CloudEnvironment } from './contract.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * An issuer identifier (RFC 8414 §2): an https origin with no path, query,
 * fragment or credentials. Plain http only on loopback, for a local issuer.
 */
export function issuerOrigin(raw: string, name = 'SOCIO_CLOUD_ISSUER'): string {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`${name} must be an https origin, like ${CLOUD_ISSUER_DEFAULT}.`);
    }
    const local = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
    if (url.protocol !== 'https:' && !local) {
        throw new Error(`${name} must be an https origin (http only on loopback).`);
    }
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
        throw new Error(`${name} must be an origin only: no path, query or credentials.`);
    }
    return url.origin;
}

/**
 * Reads the cloud connection's settings. `SOCIO_CLOUD` is `on` (the default)
 * or `off`. `SOCIO_CLOUD_ISSUER` is the issuer's origin. `SOCIO_CLOUD_ENROLLMENT_TOKEN`
 * (`_FILE`) is provisioning's initial access token; `none` (a placeholder
 * secret) is the same as unset. Without a token and without a stored
 * identity nothing is ever sent, so a deployment that sets none of these
 * runs as it did before. Malformed values stop startup, without echoing the token.
 */
export function cloudFromEnv(env: Record<string, string | undefined>): CloudEnvironment {
    const mode = env.SOCIO_CLOUD?.trim().toLowerCase() || 'on';
    if (mode !== 'on' && mode !== 'off') {
        throw new Error('SOCIO_CLOUD must be on or off.');
    }
    const config: CloudEnvironment = {
        off: mode === 'off',
        issuer: issuerOrigin(env.SOCIO_CLOUD_ISSUER?.trim() || CLOUD_ISSUER_DEFAULT),
    };
    const replaceLost = env.SOCIO_CLOUD_REPLACE_LOST?.trim().toLowerCase();
    if (replaceLost && replaceLost !== 'true' && replaceLost !== 'false') {
        throw new Error('SOCIO_CLOUD_REPLACE_LOST must be true or false.');
    }
    if (replaceLost === 'true') {
        config.replaceLost = true;
    }
    const token = env.SOCIO_CLOUD_ENROLLMENT_TOKEN?.trim();
    if (token && token.toLowerCase() !== 'none') {
        // A header value: one line of visible ASCII. Never echoed.
        if (!/^[\x21-\x7e]{16,4096}$/.test(token)) {
            throw new Error('SOCIO_CLOUD_ENROLLMENT_TOKEN (or _FILE) is not a token: one line, 16 characters or more.');
        }
        config.enrollmentToken = token;
    }
    return config;
}
