import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { EgressTenant } from '../egress/proxy.js';

/**
 * Keys derived from the runtime's one shared secret (`APPS_RUNTIME_TOKEN`):
 * what the app sends the ingress, and each app's egress credentials. The
 * apps never see the secret, so they can't make either.
 */
const mac = (secret: string, purpose: string, value = '') =>
    createHmac('sha256', secret).update(`company-brain-apps\u0000${purpose}\u0000${value}`).digest('base64url');

/** What the app's proxy sends the ingress with every request. */
export const ingressKey = (secret: string) => mac(secret, 'ingress');

/**
 * What the ingress sends a plugin task. The task rejects every path but its
 * healthcheck without this, so a neighbor on the apps network cannot call
 * the task directly. Any replica can check it: it is a MAC, not a session.
 */
export const pluginProof = (secret: string, id: string) => mac(secret, 'plugin', id);

/**
 * A plugin service's actor-envelope key (CB-232), base64url:
 * what the apps proxy signs `x-cb-actor` with for `plugin:<id>`, and what
 * the runtime puts in that plugin's tasks as `CB_ACTOR_KEY`. From the
 * runtime's secret, like the proof, since the runtime (not Socio) creates
 * the service; it rotates with `APPS_RUNTIME_TOKEN`.
 */
export const pluginActorKey = (secret: string, id: string) => mac(secret, 'plugin-envelope', id);

/**
 * Identity headers an older apps proxy sends unsigned (CB-232). The
 * ingress keeps passing these on without a signature to mini apps, so
 * human sessions through a release before CB-232 keep working during a
 * deploy's overlap; every other `x-cb-*` header (the envelope, `x-cb-obo`)
 * needs one. A later release can require it for these too. Plugins never
 * get them unsigned: the proxy signs every header it sends one.
 */
export const LEGACY_IDENTITY_HEADERS: ReadonlySet<string> = new Set([
    'x-cb-user',
    'x-cb-access',
    'x-cb-person',
    'x-cb-time-zone',
    'x-cb-parent-origin',
]);

const IDENTITY = /^x-cb-(?!runtime-)[a-z0-9-]{1,40}$/;
const SIGNATURE = /^v1\.([a-z0-9,-]{0,800})\.([A-Za-z0-9_-]{43})$/;

/** The `x-cb-*` names of a header set that are identity (not runtime) headers. */
export const identityNames = (headers: Record<string, unknown>) =>
    Object.keys(headers)
        .map((name) => name.toLowerCase())
        .filter((name) => IDENTITY.test(name))
        .sort();

const identityText = (
    appId: string,
    method: string,
    target: string,
    names: readonly string[],
    value: (name: string) => string,
) => [appId, method.toUpperCase(), target, ...names.map((name) => `${name}:${value(name)}`)].join('\n');

/**
 * `x-cb-runtime-sig` (CB-232): the apps proxy's MAC, under a key
 * from the runtime's secret, over the app, the request line and every
 * identity header it adds, by name and value: `v1.<names>.<mac>`.
 */
export function identitySignature(
    secret: string,
    appId: string,
    method: string,
    target: string,
    headers: Record<string, string>,
) {
    const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    const names = identityNames(lower);
    return `v1.${names.join(',')}.${mac(
        secret,
        'identity',
        identityText(appId, method, target, names, (name) => lower[name]),
    )}`;
}

/**
 * The identity headers a signature covers, when it is valid for this app
 * and request line and every header it names is present with the signed
 * value; undefined otherwise.
 */
export function verifyIdentitySignature(
    secret: string,
    appId: string,
    method: string,
    target: string,
    headers: Record<string, string | undefined>,
    signature: string | undefined,
): Set<string> | undefined {
    const match = SIGNATURE.exec(signature ?? '');
    if (!match) {
        return undefined;
    }
    const names = match[1] ? match[1].split(',') : [];
    if (
        names.some((name) => !IDENTITY.test(name) || typeof headers[name] !== 'string') ||
        new Set(names).size !== names.length
    ) {
        return undefined;
    }
    const expected = mac(
        secret,
        'identity',
        identityText(appId, method, target, names, (name) => headers[name]!),
    );
    return sameSecret(match[2], expected) ? new Set(names) : undefined;
}

export function sameSecret(supplied: string | undefined, expected: string) {
    const a = Buffer.from(supplied ?? '');
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * One app's egress credentials: the user name carries its app id and its
 * allowlist, the password is a MAC over both, so the shared egress proxy
 * needs no state and an app can't widen its own list.
 */
export function egressUser(secret: string, appId: string, allow: string[]) {
    const user = `${appId}.${Buffer.from(allow.join(',')).toString('base64url')}`;
    return { user, password: mac(secret, 'egress', user) };
}

/** `http://<user>:<password>@proxy:3128` for one app. */
export function egressProxyUrl(proxy: string, secret: string, appId: string, allow: string[]) {
    const url = new URL(proxy);
    const { user, password } = egressUser(secret, appId, allow);
    url.username = user;
    url.password = password;
    return url.toString().replace(/\/$/, '');
}

/** The egress proxy's side: the tenant a CONNECT's credentials name. */
export function egressTenant(secret: string): (request: IncomingMessage) => EgressTenant | undefined {
    return (request) => {
        const header = request.headers['proxy-authorization'];
        const match = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(String(header ?? '').trim());
        if (!match) {
            return undefined;
        }
        const decoded = Buffer.from(match[1], 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        if (colon < 1) {
            return undefined;
        }
        const user = decoded.slice(0, colon);
        const password = decoded.slice(colon + 1);
        if (!sameSecret(password, mac(secret, 'egress', user))) {
            return undefined;
        }
        const dot = user.indexOf('.');
        if (dot < 1) {
            return undefined;
        }
        const list = Buffer.from(user.slice(dot + 1), 'base64url').toString('utf8');
        return {
            label: user.slice(0, dot),
            allow: new Set(list ? list.split(',') : []),
        };
    };
}
