import { isIPv4 } from 'node:net';

import type { DomainsSetup } from './contract.js';

/** What `domainsSettingsFromEnv` read (the contract's `DomainsSetup`). */
export type DomainsConfig = DomainsSetup;

export const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4';

const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(\\.${LABEL})+$`);

/** Lowercase, without a trailing dot; undefined unless a DNS name of 2+ labels. */
export function normalHostname(raw: string | undefined | null) {
    const host = (raw ?? '').trim().toLowerCase().replace(/\.$/, '');
    return HOSTNAME.test(host) ? host : undefined;
}

const unset = (value: string | undefined) => {
    const trimmed = value?.trim();
    return !trimmed || trimmed.toLowerCase() === 'none' ? undefined : trimmed;
};

const seconds = (env: Record<string, string | undefined>, name: string, fallback: number, max: number) => {
    const raw = env[name]?.trim();
    if (!raw) {
        return fallback * 1000;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > max) {
        throw new Error(`${name} must be a whole number of seconds from 1 to ${max}.`);
    }
    return value * 1000;
};

/**
 * Reads the settings. Missing ones turn the module off (and are named);
 * malformed ones stop startup, without echoing secret values.
 */
export function domainsSettingsFromEnv(env: Record<string, string | undefined>): DomainsSetup {
    const names = [
        'DOMAINS_ZONE',
        'DOMAINS_BASE',
        'DOMAINS_TARGET_IP',
        'DOMAINS_UPSTREAM',
        'NPM_API_URL',
        'NPM_CREDENTIALS',
        'CLOUDFLARE_DNS_TOKEN',
    ] as const;
    const values = Object.fromEntries(names.map((name) => [name, unset(env[name])])) as Record<
        (typeof names)[number],
        string | undefined
    >;
    const missing = names
        .filter((name) => !values[name])
        .map((name) => (name === 'NPM_CREDENTIALS' || name === 'CLOUDFLARE_DNS_TOKEN' ? `${name}_FILE` : name));
    if (missing.length) {
        return { missing };
    }
    const zone = normalHostname(values.DOMAINS_ZONE);
    if (!zone) {
        throw new Error('DOMAINS_ZONE must be a DNS zone such as example.com.');
    }
    const base = normalHostname(values.DOMAINS_BASE);
    if (!base || !base.endsWith(`.${zone}`)) {
        throw new Error('DOMAINS_BASE must be a host name under DOMAINS_ZONE, e.g. brain.example.com.');
    }
    const targetIp = values.DOMAINS_TARGET_IP!;
    if (!isIPv4(targetIp)) {
        throw new Error('DOMAINS_TARGET_IP must be an IPv4 address.');
    }
    let upstreamUrl: URL;
    try {
        upstreamUrl = new URL(values.DOMAINS_UPSTREAM!);
    } catch {
        throw new Error('DOMAINS_UPSTREAM must be a URL such as http://app:4310.');
    }
    if (
        !['http:', 'https:'].includes(upstreamUrl.protocol) ||
        upstreamUrl.pathname !== '/' ||
        upstreamUrl.search ||
        upstreamUrl.username ||
        upstreamUrl.password
    ) {
        throw new Error('DOMAINS_UPSTREAM must be an http(s) origin such as http://app:4310.');
    }
    const scheme = upstreamUrl.protocol === 'https:' ? 'https' : 'http';
    const upstream = {
        scheme,
        host: upstreamUrl.hostname,
        port: Number(upstreamUrl.port || (scheme === 'https' ? 443 : 80)),
    } as const;
    const npmUrl = values.NPM_API_URL!.replace(/\/+$/, '');
    if (!/^https?:\/\/[^/?#@]+(\/[^?#@]*)?$/.test(npmUrl)) {
        throw new Error('NPM_API_URL must be an http(s) URL such as http://npm:81/api.');
    }
    let credentials: { email?: unknown; password?: unknown };
    try {
        credentials = JSON.parse(values.NPM_CREDENTIALS!) as typeof credentials;
    } catch {
        throw new Error('NPM_CREDENTIALS_FILE must hold JSON: {"email": "…", "password": "…"}.');
    }
    if (
        !credentials ||
        typeof credentials.email !== 'string' ||
        !credentials.email.includes('@') ||
        typeof credentials.password !== 'string' ||
        !credentials.password
    ) {
        throw new Error('NPM_CREDENTIALS_FILE must hold JSON: {"email": "…", "password": "…"}.');
    }
    const cloudflareUrl = (env.CLOUDFLARE_API_URL?.trim() || CLOUDFLARE_API_URL).replace(/\/+$/, '');
    if (!/^https?:\/\/[^/?#@]+(\/[^?#@]*)?$/.test(cloudflareUrl)) {
        throw new Error('CLOUDFLARE_API_URL must be an http(s) URL.');
    }
    const zoneId = env.CLOUDFLARE_ZONE_ID?.trim() || undefined;
    if (zoneId && !/^[a-f0-9]{32}$/i.test(zoneId)) {
        throw new Error('CLOUDFLARE_ZONE_ID must be a zone id (32 hex characters).');
    }
    const acmeEmail = unset(env.DOMAINS_ACME_EMAIL);
    if (acmeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(acmeEmail)) {
        throw new Error('DOMAINS_ACME_EMAIL must be an email address.');
    }
    return {
        missing: [],
        settings: {
            zone,
            base,
            targetIp,
            upstream,
            ...(acmeEmail ? { acmeEmail } : {}),
            npm: {
                url: npmUrl,
                email: credentials.email.trim(),
                password: credentials.password,
                timeoutMs: seconds(env, 'NPM_TIMEOUT_SECONDS', 15, 120),
                certificateTimeoutMs: seconds(env, 'NPM_CERTIFICATE_TIMEOUT_SECONDS', 300, 900),
            },
            cloudflare: {
                url: cloudflareUrl,
                token: values.CLOUDFLARE_DNS_TOKEN!,
                ...(zoneId ? { zoneId: zoneId.toLowerCase() } : {}),
                timeoutMs: seconds(env, 'CLOUDFLARE_TIMEOUT_SECONDS', 15, 120),
            },
        },
    };
}

/** The wildcard covering one label under the base. */
export const wildcardOf = (base: string) => `*.${base}`;
