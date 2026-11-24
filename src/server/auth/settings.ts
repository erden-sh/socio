import { createHmac } from 'node:crypto';

import { z } from 'zod';

import { networkTrustFromEnv, type NetworkTrust } from '@socio/foundation/http/network-trust';
import { nonPersonOwnerId } from '@socio/shared/data-types';
import { appInviteLinksFromEnv, isLinkHost, LINK_HOST, LINK_STAGING_HOST } from '@socio/shared/device-sign-in';

import type { AccessRules, GroupRules } from './rules.js';

/** A generic OAuth/OIDC provider (`AUTH_OAUTH_<ID>_*`). */
export interface OAuthProviderSettings extends GroupRules {
    /** Lowercase; the callback is `/api/auth/callback/<id>`. */
    id: string;
    /** On the button: "Sign in with <name>". */
    name: string;
    discoveryUrl: string;
    clientId: string;
    clientSecret?: string;
    scopes: string[];
}

/** Outgoing mail for password resets and email verification (optional). */
export interface SmtpSettings {
    /** `smtp://user@host:587` (STARTTLS) or `smtps://user@host:465`. */
    url: string;
    password?: string;
    from: string;
}

export interface BetterAuthSettings {
    /** The one browser origin: base URL, passkey relying party, CSRF origin. */
    origin: string;
    /** Better Auth's signing and encryption key, derived from SESSION_SECRET. */
    secret: string;
    secure: boolean;
    passkey: boolean;
    password: boolean;
    rules: AccessRules;
    providers: OAuthProviderSettings[];
    /** Client IP from the last X-Forwarded-For hop (behind a reverse proxy). */
    trustProxy: boolean;
    /** Which peers may set X-Forwarded-For, and the computers network (CB-309). */
    network: NetworkTrust;
    smtp?: SmtpSettings;
    /**
     * The first admin (`AUTH_FIRST_ADMIN_EMAIL`, `AUTH_FIRST_ADMIN_LINK`;
     * CB-390): made at boot while the workspace has no active admin, and
     * its owner. `envName` is the prefix it was read under: the former
     * `AUTH_OPERATOR_*` names are read as aliases for two releases.
     */
    firstAdmin?: { email: string; link?: string; envName: 'AUTH_FIRST_ADMIN' | 'AUTH_OPERATOR' };
    /**
     * One plugin's own connected-agent scopes (`plugins:calendar:write`,
     * CB-254), from this instance's plugin catalog, with their plain words.
     */
    pluginScopes?: { scopes: readonly string[]; labels: Record<string, string> };
    /**
     * The link domain the production and preview builds' links use (CB-352,
     * `AUTH_APP_LINK_HOST`): `link.socio.sh` unless a test bench points it at
     * its own tunnel.
     */
    linkHost: string;
    /**
     * The development build's link domain (`AUTH_APP_LINK_HOST_DEV`):
     * `link-staging.socio.sh`. Never the production one, which doesn't serve
     * development links.
     */
    devLinkHost: string;
    /**
     * `AUTH_APP_PREVIEW_LINKS`: the app's links are for the preview build
     * (team testers), not the production one. A test setting of whoever runs the deployment.
     */
    previewLinks: boolean;
    /**
     * `AUTH_APP_DEV_LINKS`: Add a device links for the development build too,
     * on the development link host. A local test setting: the server refuses
     * to start with it under NODE_ENV=production.
     */
    devLinks: boolean;
    /** `AUTH_APP_INVITE_LINKS`: invites open the Socio app, until an admin's choice in Settings. */
    appInviteLinks: boolean;
}

/** A link host setting: a host (and port) links can carry; anything else refuses to boot. */
function linkHostFromEnv(name: string, value: string | undefined, fallback: string): string {
    const host = value?.trim().toLowerCase();
    if (!host) {
        return fallback;
    }
    if (!isLinkHost(host)) {
        throw new Error(`${name} must be a host name, such as ${fallback}, with an optional port.`);
    }
    // Links are https: :443 is the default port, the same origin without it.
    return host.replace(/:443$/, '');
}

/** `AUTH_APP_DEV_LINKS`, which can never be on in production: it refuses to start there. */
function devLinksFromEnv(env: Record<string, string | undefined>): boolean {
    const on = flag(env.AUTH_APP_DEV_LINKS, false);
    if (on && env.NODE_ENV === 'production') {
        throw new Error('AUTH_APP_DEV_LINKS is for local testing only and is refused with NODE_ENV=production.');
    }
    return on;
}

/** The two link hosts; a development link never goes out on the production builds' host. */
function linkHostsFromEnv(env: Record<string, string | undefined>) {
    const linkHost = linkHostFromEnv('AUTH_APP_LINK_HOST', env.AUTH_APP_LINK_HOST, LINK_HOST);
    const devLinkHost = linkHostFromEnv('AUTH_APP_LINK_HOST_DEV', env.AUTH_APP_LINK_HOST_DEV, LINK_STAGING_HOST);
    if (devLinkHost === linkHost || devLinkHost === LINK_HOST) {
        throw new Error(
            `AUTH_APP_LINK_HOST_DEV must not be the production link host (${linkHost}): it doesn't serve development links.`,
        );
    }
    return { linkHost, devLinkHost };
}

const list = (value: string | undefined) =>
    (value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
const lower = (items: string[]) => items.map((item) => item.toLowerCase());
const flag = (value: string | undefined, fallback: boolean) => (value?.trim() ? value.trim() === 'true' : fallback);
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,30}$/;
const appUserId = z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/)
    // Never a non-person owner id: a socio's area, a plugin, the workspace (CB-224, CB-451).
    .refine((id) => !nonPersonOwnerId(id));
const email = z.string().trim().toLowerCase().pipe(z.email());

/** https, or plain http on loopback (local development and tests). */
export function acceptableUrl(value: string) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.includes(url.hostname));
    } catch {
        return false;
    }
}

/** Better Auth gets its own key, so it never shares one with mock sessions. */
export const betterAuthSecret = (sessionSecret: string) =>
    createHmac('sha256', sessionSecret).update('company-brain/better-auth').digest('base64url');

function providerFromEnv(
    env: Record<string, string | undefined>,
    id: string,
    read: (path: string) => string,
): OAuthProviderSettings {
    if (!PROVIDER_ID.test(id)) {
        throw new Error(
            `AUTH_OAUTH_PROVIDERS: "${id}" is not a valid provider id (lowercase letters, digits and dashes, e.g. logto).`,
        );
    }
    const prefix = `AUTH_OAUTH_${id.toUpperCase().replaceAll('-', '_')}_`;
    const get = (name: string) => env[`${prefix}${name}`]?.trim() || undefined;
    const issuer = get('ISSUER')?.replace(/\/+$/, '');
    const discoveryUrl = get('DISCOVERY_URL') ?? (issuer ? `${issuer}/.well-known/openid-configuration` : '');
    if (!acceptableUrl(discoveryUrl)) {
        throw new Error(
            `${prefix}ISSUER must be the issuer URL (https; http only on loopback), e.g. https://auth.example.com/oidc, or set ${prefix}DISCOVERY_URL.`,
        );
    }
    const clientId = get('CLIENT_ID');
    if (!clientId) {
        throw new Error(`${prefix}CLIENT_ID is required.`);
    }
    let clientSecret = get('CLIENT_SECRET');
    const secretFile = get('CLIENT_SECRET_FILE');
    if (!clientSecret && secretFile) {
        try {
            clientSecret = read(secretFile).trim();
        } catch {
            throw new Error(`${prefix}CLIENT_SECRET_FILE could not be read.`);
        }
        if (!clientSecret) {
            throw new Error(`${prefix}CLIENT_SECRET_FILE is empty.`);
        }
    }
    const scopes = (get('SCOPES') ?? 'openid profile email').split(/\s+/);
    if (!scopes.includes('openid')) {
        throw new Error(`${prefix}SCOPES must include openid.`);
    }
    return {
        id,
        name: get('NAME')?.slice(0, 40) ?? id,
        discoveryUrl,
        clientId,
        clientSecret,
        scopes,
        groupsClaim: get('GROUPS_CLAIM') ?? 'groups',
        adminGroups: list(get('ADMIN_GROUP')),
        allowedGroups: list(get('ALLOWED_GROUPS')),
    };
}

function linksFromEnv(value: string | undefined) {
    const links = new Map<string, string>();
    if (!value?.trim()) {
        return links;
    }
    let raw: unknown;
    try {
        raw = JSON.parse(value);
    } catch {
        raw = undefined;
    }
    const parsed = z.record(appUserId, email).safeParse(raw);
    if (!parsed.success || new Set(Object.values(parsed.data)).size !== Object.keys(parsed.data).length) {
        throw new Error(
            'AUTH_LINK_USERS must be a JSON object of existing user id to email, e.g. {"alice":"alice@example.com"}, with unique emails.',
        );
    }
    for (const [id, address] of Object.entries(parsed.data)) {
        links.set(address, id);
    }
    return links;
}

/**
 * The first admin from the environment (CB-390). `AUTH_FIRST_ADMIN_*` wins;
 * the former `AUTH_OPERATOR_*` names are read as aliases for two releases
 * (from v0.52.0), with a startup warning (`firstAdminWarnings`).
 */
function firstAdminFromEnv(env: Record<string, string | undefined>) {
    const prefix =
        env.AUTH_FIRST_ADMIN_EMAIL?.trim() || env.AUTH_FIRST_ADMIN_LINK?.trim() ? 'AUTH_FIRST_ADMIN' : 'AUTH_OPERATOR';
    const address = env[`${prefix}_EMAIL`]?.trim();
    const link = env[`${prefix}_LINK`]?.trim() || undefined;
    if (!address) {
        if (link) {
            throw new Error(`${prefix}_LINK needs ${prefix}_EMAIL.`);
        }
        return undefined;
    }
    const parsed = email.safeParse(address);
    if (!parsed.success) {
        throw new Error(`${prefix}_EMAIL is not an email address.`);
    }
    if (link && !appUserId.safeParse(link).success) {
        throw new Error(`${prefix}_LINK must be an app user id (lowercase letters, digits, - and _), e.g. alice.`);
    }
    return { email: parsed.data, ...(link ? { link } : {}), envName: prefix } as const;
}

/**
 * Startup warnings for the renamed first-admin settings (CB-390): the
 * former `AUTH_OPERATOR_*` names still work for two releases.
 */
export function firstAdminWarnings(env: Record<string, string | undefined>): string[] {
    const old = ['AUTH_OPERATOR_EMAIL', 'AUTH_OPERATOR_LINK'].filter((name) => env[name]?.trim());
    if (!old.length) {
        return [];
    }
    const both = ['AUTH_FIRST_ADMIN_EMAIL', 'AUTH_FIRST_ADMIN_LINK'].some((name) => env[name]?.trim());
    return [
        both
            ? `${old.join(' and ')} ignored: AUTH_FIRST_ADMIN_* is set. Remove the old names; they stop being read in a later release.`
            : `${old.join(' and ')} renamed to ${old.map((name) => name.replace('AUTH_OPERATOR_', 'AUTH_FIRST_ADMIN_')).join(' and ')}; the old names stop being read in a later release.`,
    ];
}

/**
 * `AUTH_PROVIDER=betterauth` settings. Fails with a clear message on
 * anything it can't use; `read` loads `<NAME>_FILE` secrets of providers,
 * and `pluginScopes` the scopes of the plugin catalog `env` sets (plugins',
 * handed in by the composition).
 */
export function betterAuthSettingsFromEnv(
    env: Record<string, string | undefined>,
    origins: string[],
    sessionSecret: string,
    read: (path: string) => string,
    pluginScopes: (env: Record<string, string | undefined>) => NonNullable<BetterAuthSettings['pluginScopes']>,
): BetterAuthSettings {
    if (origins.length !== 1 || !/^https?:\/\/[^/]+$/.test(origins[0])) {
        throw new Error(
            'AUTH_PROVIDER=betterauth needs APP_ORIGIN set to the one browser origin (e.g. https://brain.example.com): passkeys, cookies and sign-in redirects are bound to it.',
        );
    }
    const origin = origins[0];
    const providers = list(env.AUTH_OAUTH_PROVIDERS)
        .map((id) => id.toLowerCase())
        .map((id) => providerFromEnv(env, id, read));
    if (new Set(providers.map((p) => p.id)).size !== providers.length) {
        throw new Error('AUTH_OAUTH_PROVIDERS lists a provider twice.');
    }
    const password = flag(env.AUTH_PASSWORD, true);
    const passkey = flag(env.AUTH_PASSKEY, true);
    if (!password && !passkey && !providers.length) {
        throw new Error(
            'Better Auth needs a sign-in method: keep AUTH_PASSWORD or AUTH_PASSKEY on, or configure AUTH_OAUTH_PROVIDERS.',
        );
    }
    const emails = (name: string) => {
        const items = lower(list(env[name]));
        for (const item of items) {
            if (!email.safeParse(item).success) {
                throw new Error(`${name}: "${item}" is not an email address.`);
            }
        }
        return new Set(items);
    };
    let smtp: SmtpSettings | undefined;
    if (env.SMTP_URL?.trim()) {
        const url = env.SMTP_URL.trim();
        if (!/^smtps?:\/\/[^/]+/.test(url)) {
            throw new Error(
                'SMTP_URL must look like smtp://user@mail.example.com:587 or smtps://user@mail.example.com:465 (the password goes in SMTP_PASSWORD).',
            );
        }
        const from = env.SMTP_FROM?.trim();
        if (!from) {
            throw new Error('SMTP_FROM is required with SMTP_URL.');
        }
        smtp = { url, password: env.SMTP_PASSWORD?.trim() || undefined, from };
    }
    // Per-plugin scopes of the plugins this instance offers (CB-254). The
    // catalog is checked again when the platform starts.
    const scopes = pluginScopes(env);
    return {
        origin,
        secret: betterAuthSecret(sessionSecret),
        pluginScopes: scopes,
        secure: origin.startsWith('https://'),
        passkey,
        password,
        rules: {
            adminEmails: emails('AUTH_ADMIN_EMAILS'),
            allowedEmails: emails('AUTH_ALLOWED_EMAILS'),
            allowedDomains: new Set(lower(list(env.AUTH_ALLOWED_DOMAINS)).map((d) => d.replace(/^@/, ''))),
            openSignUp: flag(env.AUTH_OPEN_SIGNUP, false),
            links: linksFromEnv(env.AUTH_LINK_USERS),
        },
        providers,
        trustProxy: flag(env.AUTH_TRUST_PROXY, false),
        ...linkHostsFromEnv(env),
        previewLinks: flag(env.AUTH_APP_PREVIEW_LINKS, false),
        devLinks: devLinksFromEnv(env),
        appInviteLinks: appInviteLinksFromEnv(env),
        network: networkTrustFromEnv(env),
        smtp,
        firstAdmin: firstAdminFromEnv(env),
    };
}
