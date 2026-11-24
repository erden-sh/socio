import { randomUUID } from 'node:crypto';
import {
    request as httpRequest,
    type IncomingHttpHeaders,
    type IncomingMessage,
    type OutgoingHttpHeaders,
} from 'node:http';
import { connect, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import type { Duplex } from 'node:stream';

import type { Context, MiddlewareHandler } from 'hono';

import { sha256Hex, verifyContextProof } from '@socio/foundation/actors/keys';
import { ACTOR_ENVELOPE_HEADER, isReservedTarget } from '@socio/foundation/apps/envelope';
import {
    appLabelOfHost,
    appOrigin,
    appSessionCookieName,
    isAppsHost,
    type AppsSettings,
} from '@socio/foundation/apps/settings';
import { RateLimits } from '@socio/foundation/http/rate-limits';
import { RUNTIME_HEADER_CURRENT } from '@socio/shared/apps/apps-runtime-types';
import {
    PLUGIN_WEBHOOK_BODY_DEFAULT,
    PLUGIN_WEBHOOK_BODY_MAX,
    PLUGIN_WEBHOOK_PER_MINUTE_DEFAULT,
    PLUGIN_WEBHOOK_PER_MINUTE_MAX,
    pluginEntryPathname,
    pluginWebhookPath,
    type PluginManifest,
    type PluginWebhook,
} from '@socio/shared/plugins/plugins';

import type { AppTarget } from '../computers/contract.js';
import { PLUGIN_TIME_ZONE_HEADER } from '../plugins/contract.js';

import type { AppRecord } from './contract.js';
import { AppError, AppsService, type ProxyTarget } from './service.js';
import type { AppsPlugins } from './slices.js';

/** Hop-by-hop headers (RFC 9110 7.6.1) and those a proxy must not pass on. */
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'http2-settings',
]);

/** The CSP of the proxy's own pages: no script, nothing loaded, no framing. */
export const APP_PAGE_CSP =
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/**
 * Request headers forwarded to an app: everything but hop-by-hop headers,
 * every cookie (the app-origin session cookie is the proxy's own and other
 * cookies on this origin could come from a sibling app), forwarding headers
 * from outside, and anything `x-cb-*`. Then the proxy's own: the original
 * Host, `X-Forwarded-Host`/`-Proto`, and an opaque per-person id. Never
 * the user's id, name or address (no `X-Forwarded-For`).
 *
 * A socio session (CB-232) sends no `person` or `access`: the legacy
 * headers never go to an app for a socio, only the envelope in
 * `identity`; and its `authorization` (the platform's `cbsa_`) is dropped.
 */
export function forwardHeaders(
    incoming: Iterable<[string, string]>,
    extra: {
        host: string;
        protocol: string;
        person?: string;
        access?: 'owner' | 'space';
        upgrade?: boolean;
        /** The workspace origin, so an embedded plugin can postMessage to it. */
        parent?: string;
        /** The proxy's own `x-cb-*` identity headers (the envelope, CB-232). */
        identity?: Record<string, string>;
        /** Drops `authorization` (a socio session's platform credential). */
        dropAuthorization?: boolean;
    },
) {
    const list = [...incoming].map(([name, value]) => [name.toLowerCase(), value] as const);
    const named = new Set(
        list
            .filter(([name]) => name === 'connection')
            .flatMap(([, value]) => value.split(','))
            .map((token) => token.trim().toLowerCase()),
    );
    const out: Record<string, string> = {};
    for (const [name, value] of list) {
        if (HOP_BY_HOP.has(name) || named.has(name)) {
            continue;
        }
        if (
            name === 'cookie' ||
            (extra.dropAuthorization && name === 'authorization') ||
            name === 'host' ||
            name === 'forwarded' ||
            name === 'x-real-ip' ||
            name.startsWith('x-forwarded-') ||
            name.startsWith('x-cb-') ||
            // The app's install id (CB-352) is for the workspace alone.
            name === 'x-socio-install'
        ) {
            continue;
        }
        out[name] = out[name] ? `${out[name]}, ${value}` : value;
    }
    out.host = extra.host;
    out['x-forwarded-host'] = extra.host;
    out['x-forwarded-proto'] = extra.protocol.replace(/:$/, '');
    if (extra.person !== undefined) {
        out['x-cb-user'] = extra.person;
    }
    if (extra.access !== undefined) {
        out['x-cb-access'] = extra.access;
    }
    if (extra.parent) {
        out['x-cb-parent-origin'] = extra.parent;
    }
    for (const [name, value] of Object.entries(extra.identity ?? {})) {
        if (name.startsWith('x-cb-')) {
            out[name] = value;
        }
    }
    if (extra.upgrade) {
        out.connection = 'Upgrade';
        out.upgrade = 'websocket';
    }
    return out;
}

/**
 * Response headers passed back: no hop-by-hop headers and no cookies (the
 * app's origin carries the proxy's session only), a Location that points
 * at the computer rewritten to the app's origin, `nosniff` always, and on
 * HTML `frame-ancestors 'none'` added as a policy of its own, so the app's
 * own CSP still applies as it wrote it.
 */
export function responseHeaders(
    incoming: IncomingHttpHeaders,
    target: { host: string; port: number },
    origin: string,
    frameAncestors = "'none'",
    plugin = false,
) {
    const named = new Set(
        String(incoming.connection ?? '')
            .split(',')
            .map((token) => token.trim().toLowerCase()),
    );
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming)) {
        if (value === undefined) {
            continue;
        }
        if (HOP_BY_HOP.has(name) || named.has(name)) {
            continue;
        }
        if (name === 'set-cookie' || name === 'set-cookie2') {
            continue;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                headers.append(name, item);
            }
        } else {
            headers.set(name, value);
        }
    }
    const location = headers.get('location');
    if (location) {
        try {
            const url = new URL(location, origin);
            if (url.hostname === target.host.toLowerCase() && (url.port || '80') === String(target.port)) {
                headers.set('location', `${origin}${url.pathname}${url.search}${url.hash}`);
            }
        } catch {
            headers.delete('location');
        }
    }
    headers.set('x-content-type-options', 'nosniff');
    if (!headers.has('referrer-policy')) {
        headers.set('referrer-policy', 'same-origin');
    }
    const html = /^\s*(text\/html|application\/xhtml\+xml)/i.test(headers.get('content-type') ?? '');
    if (html) {
        if (plugin && ![...headers.keys()].some((name) => name.toLowerCase() === 'content-security-policy')) {
            headers.set(
                'content-security-policy',
                "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
            );
        }
        headers.append('content-security-policy', `frame-ancestors ${frameAncestors}`);
        if (plugin) {
            // Framed by the workspace origin, so CORP is cross-origin
            // (same-origin would refuse that load). COOP same-origin keeps the
            // plugin out of the workspace's browsing-context group.
            headers.set('cross-origin-opener-policy', 'same-origin');
            headers.set('cross-origin-resource-policy', 'cross-origin');
            headers.set('referrer-policy', 'same-origin');
            headers.delete('x-frame-options');
        }
    }
    return headers;
}

const escape = (text: string) =>
    text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** One of the proxy's own pages (stopped, signed out, not found). */
export function appPage(status: number, title: string, lines: string[], actions: string[] = []) {
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#1c1c1c;background:#fafaf8}h1{font-size:1.4rem}p{color:#444}button,a.button{font:inherit;padding:.5rem 1rem;border-radius:.5rem;border:1px solid #1c1c1c;background:#1c1c1c;color:#fff;cursor:pointer;text-decoration:none;display:inline-block}small{color:#777}@media(prefers-color-scheme:dark){body{background:#151515;color:#eee}p{color:#bbb}button,a.button{background:#eee;color:#151515;border-color:#eee}}</style></head><body><h1>${escape(title)}</h1>${lines.map((line) => `<p>${escape(line)}</p>`).join('')}${actions.join('')}<p><small>A Socio mini app.</small></p></body></html>`;
    return new Response(body, {
        status,
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-security-policy': APP_PAGE_CSP,
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
        },
    });
}

const startForm = `<form method="post" action="/__cb/start"><button type="submit">Start</button></form>`;

export function cookieOf(header: string | null | undefined, name: string) {
    for (const part of (header ?? '').split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) {
            return rest.join('=');
        }
    }
    return undefined;
}

export function sessionCookie(settings: AppsSettings, value: string, maxAgeSeconds: number) {
    return [
        `${appSessionCookieName(settings)}=${value}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.floor(maxAgeSeconds)}`,
        ...(settings.protocol === 'https:' ? ['Secure'] : []),
    ].join('; ');
}

/**
 * The plugin's session, on the plugin origin only. No `Domain` attribute
 * (and `__Host-` on https), so it is not sent to Socio or to another plugin.
 * `SameSite=Strict` keeps it off a cross-site request. Socio's own session
 * cookie is a different name on the workspace host and is never forwarded.
 */
export function pluginSessionCookie(settings: AppsSettings, value: string, maxAgeSeconds: number) {
    return [
        `${appSessionCookieName(settings)}=${value}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${Math.floor(maxAgeSeconds)}`,
        ...(settings.protocol === 'https:' ? ['Secure'] : []),
    ].join('; ');
}

/** The page for an app whose computer or server isn't there. */
function unavailablePage(app: AppRecord, state: AppTarget['state'] | 'not_answering', owner: boolean) {
    // Promoted apps run in the workspace app runtime, not a computer.
    if (app.status === 'unpublished') {
        return appPage(410, `${app.name} is unpublished`, [
            owner
                ? 'You unpublished this app. Publish it again from Apps in Socio; its data is still there.'
                : 'Its owner unpublished it.',
        ]);
    }
    if (AppsService.inRuntime(app)) {
        return appPage(
            503,
            `${app.name} isn’t running`,
            [
                state === 'not_configured'
                    ? 'The workspace app runtime is not set up on this server.'
                    : state === 'unavailable'
                      ? 'The workspace app runtime is unavailable or the app is starting; try again in a moment.'
                      : owner
                        ? 'It stopped in the workspace app runtime. Start runs its live version again; its logs are on the Apps page.'
                        : 'Ask the app’s owner to start it again.',
            ],
            owner && state !== 'not_configured' ? [startForm] : [],
        );
    }
    if (state === 'not_answering') {
        return appPage(
            502,
            `${app.name} isn’t answering`,
            [
                `Its computer is running, but nothing answers on port ${app.port}.`,
                owner
                    ? app.startCommand
                        ? 'Start runs its start command again.'
                        : 'Ask the socio to start the app again.'
                    : 'Ask the app’s owner to start it again.',
            ],
            owner && app.startCommand ? [startForm] : [],
        );
    }
    if (state === 'stopped') {
        return appPage(
            503,
            'This app’s computer is stopped',
            [
                owner
                    ? `Start the socio’s computer to open ${app.name}.${app.startCommand ? ' The app starts with it.' : ' Then ask the socio to start the app.'}`
                    : `Ask the app’s owner to start the socio’s computer.`,
            ],
            owner ? [startForm] : [],
        );
    }
    return appPage(503, `${app.name} is unavailable`, [AppsService.stateLine(state)]);
}

/** Forwards one request; resolves with the app's response (headers in). */
export function forward(
    target: { host: string; port: number },
    method: string,
    path: string,
    headers: OutgoingHttpHeaders,
    body: ReadableStream<Uint8Array> | null,
    settings: AppsSettings,
    signal: AbortSignal,
) {
    return new Promise<IncomingMessage>((resolve, reject) => {
        const upstream = httpRequest({
            host: target.host,
            port: target.port,
            method,
            path,
            headers,
        });
        const timer = setTimeout(() => upstream.destroy(new Error('timeout')), settings.timeoutMs);
        upstream.setTimeout(settings.idleMs, () => upstream.destroy(new Error('idle')));
        const abort = () => upstream.destroy(new Error('aborted'));
        signal.addEventListener('abort', abort, { once: true });
        upstream.once('response', (response) => {
            clearTimeout(timer);
            resolve(response);
        });
        upstream.once('error', (error) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            reject(error);
        });
        upstream.once('close', () => signal.removeEventListener('abort', abort));
        if (!body) {
            upstream.end();
            return;
        }
        let size = 0;
        const reader = body.getReader();
        const pump = async () => {
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }
                    size += value.byteLength;
                    if (size > settings.maxRequestBytes) {
                        upstream.destroy(new AppError('too_large'));
                        return;
                    }
                    if (!upstream.write(value)) {
                        await new Promise((ok) => upstream.once('drain', ok));
                    }
                }
                upstream.end();
            } catch {
                upstream.destroy(new Error('aborted'));
            }
        };
        void pump();
    });
}

/** Caps a response body; an oversized one ends with an error. */
function capped(response: IncomingMessage, max: number) {
    let size = 0;
    return (Readable.toWeb(response) as ReadableStream<Uint8Array>).pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                size += chunk.byteLength;
                if (size > max) {
                    response.destroy();
                    controller.error(new Error('The app’s response is too large.'));
                } else {
                    controller.enqueue(chunk);
                }
            },
        }),
    );
}

const requestHost = (c: Context) => c.req.header('host') ?? new URL(c.req.url).host;

// ---------------------------------------------------------------------------
// Socio sessions (CB-232): a socio acting for a person, from
// the app browser's context, with `Authorization: Bearer cbsa_…` and the
// context proof `x-cb-context`. No cookie, no launch page: a refusal is a
// short plain answer that says no more than "sign in through Socio" (401)
// or "this access was revoked" (403); the reason is in the audit.

let productionSwitchWarned = false;
/**
 * Whether the public apps host also takes socio sessions: only with
 * `APPS_SOCIO_ON_PUBLIC_HOST=1`, a development switch, and never under
 * `NODE_ENV=production`. Otherwise a `cbsa_` on the public host gets the
 * plain 401 before any check (no audit row): socio sessions come through
 * the internal apps listener, on the `app_browser` network, so an
 * internet client can't reach them.
 */
export function socioOnPublicHostFromEnv(env: Record<string, string | undefined>) {
    if (!/^(1|true|on)$/i.test(env.APPS_SOCIO_ON_PUBLIC_HOST?.trim() ?? '')) {
        return false;
    }
    if (env.NODE_ENV !== 'production') {
        return true;
    }
    if (!productionSwitchWarned) {
        productionSwitchWarned = true;
        console.log(
            'Apps: APPS_SOCIO_ON_PUBLIC_HOST is ignored in production; socio sessions use the internal apps listener only.',
        );
    }
    return false;
}

/** A socio session's platform credential, from `authorization`. */
export function socioBearer(header: string | null | undefined) {
    return /^Bearer\s+(cbsa_[A-Za-z0-9_-]+)\s*$/.exec(header ?? '')?.[1];
}

/** The context proof header the app browser's worker signs. */
export const CONTEXT_PROOF_HEADER = 'x-cb-context';
/**
 * An approval id a socio's repeated request names: passed to the app for
 * socio sessions only, by shape. It is a reference, not a
 * credential: consuming it still needs the digest and this grant.
 */
export const APPROVAL_HEADER = 'x-cb-approval';
const APPROVAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Context proofs accepted in the last 60 s, in this process only: defense
 * in depth, since only the worker holding the key can replay one, and the
 * other runtime of a deploy keeps its own.
 */
export class ProofReplays {
    private seen = new Map<string, number>();
    /** True the first time `key` is seen within its 60 s. */
    fresh(key: string, now = Date.now()) {
        if (this.seen.size > 50_000) {
            for (const [entry, until] of this.seen) {
                if (until <= now) {
                    this.seen.delete(entry);
                }
            }
        }
        const until = this.seen.get(key);
        if (until !== undefined && until > now) {
            return false;
        }
        this.seen.set(key, now + 60_000);
        return true;
    }
}
const proofReplays = new ProofReplays();

function plainRefusal(status: 401 | 403) {
    return new Response(status === 401 ? 'Sign in through Socio to use this app.' : 'This access was revoked.', {
        status,
        headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
        },
    });
}

/**
 * The request-target exactly as it came on the request line, which the
 * context proof covers; the parsed URL's when the server adapter doesn't
 * expose it (in-process requests).
 */
function rawTarget(c: Context, url: URL) {
    const incoming = (c.env as { incoming?: { url?: unknown } } | undefined)?.incoming;
    return typeof incoming?.url === 'string' && incoming.url.startsWith('/')
        ? incoming.url
        : `${url.pathname}${url.search}`;
}

/** A request body up to `max` bytes; undefined past it. */
async function readBody(body: ReadableStream<Uint8Array> | null, max: number): Promise<Buffer | undefined> {
    if (!body) {
        return Buffer.alloc(0);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        size += value.byteLength;
        if (size > max) {
            await reader.cancel().catch(() => undefined);
            return undefined;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

/** The identity headers of a forwarded set: what the ingress signature covers. */
const identityOf = (headers: Record<string, string>) =>
    Object.fromEntries(
        Object.entries(headers).filter(([name]) => name.startsWith('x-cb-') && !name.startsWith('x-cb-runtime-')),
    );

/** Adds the ingress signature when the target is the runtime's ingress. */
function signFor(target: Pick<ProxyTarget, 'sign'>, method: string, path: string, headers: Record<string, string>) {
    if (target.sign) {
        Object.assign(headers, target.sign(method, path, identityOf(headers)));
    }
}

/**
 * A person session's envelope, while `socio-actor-access` is on for them
 * and the app receives envelopes (promoted, or eligible). The legacy
 * headers keep flowing beside it.
 */
function personIdentity(
    apps: AppsService,
    app: AppRecord,
    session: { userId: string; access: 'owner' | 'space'; sessionHash: string },
    method: string,
    path: string,
): Record<string, string> {
    const actors = apps.actors;
    const settings = apps.settings;
    if (!actors || !settings || !actors.featureOn(session.userId) || !apps.actor.receivesEnvelopes(app)) {
        return {};
    }
    const obo = actors.mintObo({
        appId: app.id,
        sessionHash: session.sessionHash,
        requestId: randomUUID(),
        ttlMs: settings.timeoutMs,
    });
    return {
        [ACTOR_ENVELOPE_HEADER]: apps.actor.envelope(app, {
            personId: session.userId,
            access: session.access,
            sessionRef: session.sessionHash,
            obo,
            method,
            target: path,
        }),
    };
}

/**
 * A socio session's check: the credential for this app's audience,
 * then (as `check`'s `bind`) the context proof for the credential's own
 * context, within 30 s and not seen before, then `authorizeActor` for a
 * read of the app. The SDK enforces each action's tier with `scp`.
 */
async function socioCheck(
    apps: AppsService,
    app: AppRecord,
    token: string,
    request: {
        method: string;
        host: string;
        target: string;
        bodyDigest: string;
        proof: string | undefined;
    },
    correlationId: string,
) {
    const actors = apps.actors!;
    // Not while a live runtime enforces an older contract: its data API
    // would ignore the request's `cbob_` (a rollback).
    if (!actors.issuable()) {
        return { ok: false as const, status: 403 as const };
    }
    const checked = await actors.check(
        token,
        { kind: 'cbsa', audience: `app:${app.id}`, tier: 'read', correlationId },
        (credential) =>
            verifyContextProof(actors.contextKey(credential.contextId), request.proof, {
                method: request.method,
                host: request.host,
                requestTarget: request.target,
                bodyDigest: request.bodyDigest,
            }) && proofReplays.fresh(`${credential.contextId}|${request.proof}`),
    );
    if (!checked.ok) {
        return checked;
    }
    // `authorizeActor` asked the policy; the access level is the envelope's.
    // A Space the app is shared with must be one the socio reads in the
    // grant's conversation, asked afresh on every request (CB-181).
    const access = apps.socioAccess(app, checked.actor.personId, checked.grant.conversationId, checked.actor.socioId);
    if (!access) {
        return { ok: false as const, status: 403 as const };
    }
    return { ...checked, access };
}

/** A socio session's identity headers: the envelope, never legacy ones. */
function socioIdentity(
    apps: AppsService,
    app: AppRecord,
    checked: Extract<Awaited<ReturnType<typeof socioCheck>>, { ok: true }>,
    method: string,
    path: string,
    correlationId: string,
    approval: string | undefined,
) {
    const obo = apps.actors!.mintObo({
        appId: app.id,
        grantId: checked.grant.id,
        requestId: correlationId,
        ttlMs: apps.settings!.timeoutMs,
    });
    return {
        [ACTOR_ENVELOPE_HEADER]: apps.actor.envelope(app, {
            personId: checked.actor.personId,
            access: checked.access,
            sessionRef: `socio:${checked.actor.sessionId}`,
            obo,
            method,
            target: path,
            socio: {
                socioId: checked.actor.socioId,
                grantId: checked.grant.id,
                scopes: checked.actor.scopes,
            },
        }),
        ...(approval && APPROVAL_ID.test(approval) ? { [APPROVAL_HEADER]: approval } : {}),
    };
}

/**
 * A socio session's response body: it ends when the grant is revoked
 * (here, by another runtime's signal, or the 5-s re-check), and its
 * tracking ends with it.
 */
function untilRevoked(
    body: ReadableStream<Uint8Array>,
    response: IncomingMessage,
    signal: AbortSignal,
    done: () => void,
) {
    let over = false;
    const finish = () => {
        if (over) {
            return;
        }
        over = true;
        signal.removeEventListener('abort', revoked);
        done();
    };
    const revoked = () => response.destroy(new Error('revoked'));
    signal.addEventListener('abort', revoked, { once: true });
    const reader = body.getReader();
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { done: end, value } = await reader.read();
                if (end) {
                    finish();
                    controller.close();
                } else {
                    controller.enqueue(value);
                }
            } catch (error) {
                finish();
                controller.error(error);
            }
        },
        cancel(reason) {
            finish();
            response.destroy();
            return reader.cancel(reason).catch(() => undefined);
        },
    });
}

/** One socio session request on an app's origin. */
async function serveSocio(
    apps: AppsService,
    c: Context,
    app: AppRecord,
    origin: string,
    token: string,
): Promise<Response> {
    const settings = apps.settings!;
    if (!apps.actors) {
        return plainRefusal(401);
    }
    const method = c.req.method;
    if (Number(c.req.header('content-length') ?? 0) > settings.maxRequestBytes) {
        return new Response('Request is too large.', { status: 413 });
    }
    // The proof covers the body's digest, so it is read (bounded) first.
    const body = ['GET', 'HEAD'].includes(method) ? null : await readBody(c.req.raw.body, settings.maxRequestBytes);
    if (body === undefined) {
        return new Response('Request is too large.', { status: 413 });
    }
    const url = new URL(c.req.url);
    const correlationId = randomUUID();
    const checked = await socioCheck(
        apps,
        app,
        token,
        {
            method,
            host: requestHost(c),
            target: rawTarget(c, url),
            bodyDigest: body?.length ? sha256Hex(body) : '',
            proof: c.req.header(CONTEXT_PROOF_HEADER),
        },
        correlationId,
    );
    if (!checked.ok) {
        return plainRefusal(checked.status);
    }
    const target = await apps.target(app);
    if (target.state !== 'running') {
        return unavailablePage(app, target.state, false);
    }
    const path = `${url.pathname}${url.search}`;
    const headers = forwardHeaders(c.req.raw.headers.entries(), {
        host: new URL(origin).host,
        protocol: settings.protocol,
        identity: socioIdentity(apps, app, checked, method, path, correlationId, c.req.header(APPROVAL_HEADER)),
        dropAuthorization: true,
    });
    if (target.headers) {
        Object.assign(headers, target.headers);
    }
    signFor(target, method, path, headers);
    // Revocation ends the request and its response, wherever it is.
    const abort = new AbortController();
    const stop = () => abort.abort();
    c.req.raw.signal.addEventListener('abort', stop, { once: true });
    const untrack = apps.actors.track(checked.grant.id, { close: stop });
    const done = () => {
        untrack();
        c.req.raw.signal.removeEventListener('abort', stop);
    };
    let response: IncomingMessage;
    try {
        response = await forward(
            target,
            method,
            path,
            headers,
            body ? (new Blob([new Uint8Array(body)]).stream() as ReadableStream<Uint8Array>) : null,
            settings,
            abort.signal,
        );
    } catch (error) {
        done();
        if (abort.signal.aborted && !c.req.raw.signal.aborted) {
            return plainRefusal(403);
        }
        if ((error as Error).message === 'timeout') {
            return appPage(504, `${app.name} took too long`, [
                `It didn’t answer within ${settings.timeoutMs / 1000} seconds.`,
            ]);
        }
        apps.forget(app);
        return unavailablePage(app, 'not_answering', false);
    }
    apps.touch(app);
    const status = response.statusCode ?? 502;
    const out = responseHeaders(response.headers, target, origin);
    const empty = method === 'HEAD' || status === 204 || status === 304 || status < 200;
    if (empty) {
        response.resume();
        done();
    }
    return new Response(
        empty ? null : untilRevoked(capped(response, settings.maxResponseBytes), response, abort.signal, done),
        { status: status < 200 ? 502 : status, headers: out },
    );
}

/**
 * The apps origin: every request whose Host is under APPS_HOST is
 * served here and never reaches the app's own routes, client or cookies.
 * `/__cb/auth` redeems a launch code, `/__cb/start` (owner, same origin)
 * starts the computer and the app, `/__cb/signout` ends the session;
 * everything else needs a session for this exact app and is proxied to the
 * app's server in its Dot's computer.
 */
/**
 * A plugin on the apps host. The same sign-in handoff as a mini app, but
 * the code and the session are rows, and the upstream is the runtime
 * ingress (any replica). Embed frames the workspace origin; a tab does not.
 * A navigation with no session does not bounce into Socio's shell.
 */
async function servePlugin(
    plugins: AppsPlugins,
    c: Context,
    id: string,
    socioAllowed: boolean,
): Promise<Response | undefined> {
    const plugin = plugins.get(id);
    const settings = plugins.appsSettings;
    // A bundled plugin runs inside Socio and has nothing on the apps host.
    if (!plugin || !settings || plugin.mode !== 'service') {
        return undefined;
    }
    const origin = plugins.origin(id);
    if (!origin) {
        return appPage(503, `${plugin.manifest.name} has no origin`, []);
    }
    const url = new URL(c.req.url);
    // A socio acting for a person (CB-232): its credential and context
    // proof, never a cookie or the `/__cb/` pages.
    // On the public host only with the development switch, as for apps:
    // otherwise the plain 401, checked by nothing.
    const bearer = socioBearer(c.req.header('authorization'));
    if (bearer) {
        if (!socioAllowed) {
            return plainRefusal(401);
        }
        if (isReservedTarget(url.pathname)) {
            return appPage(404, 'Not found', ['There is nothing here.']);
        }
        return servePluginSocio(plugins, c, plugin, origin, bearer);
    }
    const cookie = cookieOf(c.req.header('cookie'), appSessionCookieName(settings));
    if (url.pathname === '/__cb/auth' && c.req.method === 'GET') {
        const session = await plugins.redeem(id, url.searchParams.get('code') ?? undefined);
        if (!session) {
            return appPage(403, 'This link has expired', [
                'Sign-in links for plugins work once, for a minute. Open the plugin again from Socio.',
            ]);
        }
        return new Response(null, {
            status: 303,
            headers: {
                location: session.next,
                'set-cookie': pluginSessionCookie(settings, session.value, session.maxAgeSeconds),
                'cache-control': 'no-store',
                'referrer-policy': 'no-referrer',
            },
        });
    }
    // The rest of `/__cb/`, in any spelling a router could decode or fold
    // to it, is the host's (CB-458): never forwarded for a person.
    if (isReservedTarget(url.pathname)) {
        return appPage(404, 'Not found', ['There is nothing here.']);
    }
    const session = await plugins.session(id, cookie);
    if (!session) {
        if (c.req.header('sec-fetch-dest') === 'iframe') {
            return embedRefused(plugins.parentOrigin);
        }
        return appPage(401, `Open ${plugin.manifest.name} from Socio`, [
            'This plugin signs you in from the workspace. Open it there.',
        ]);
    }
    if (!plugin.enabled) {
        return appPage(503, `${plugin.manifest.name} is disabled`, ['An admin can enable it from Plugins.']);
    }
    const target = await plugins.target(id);
    if (target.state !== 'running') {
        return appPage(503, `${plugin.manifest.name} isn’t running`, [
            target.state === 'not_configured'
                ? 'The workspace app runtime is not set up on this server.'
                : target.state === 'stopped'
                  ? 'It is scaled to no replicas. Enable it from Plugins.'
                  : 'It is starting. Try again in a moment.',
        ]);
    }
    const path = `${url.pathname}${url.search}`;
    const headers = forwardHeaders(c.req.raw.headers.entries(), {
        host: new URL(origin).host,
        protocol: settings.protocol,
        person: plugins.personId(id, session.userId),
        access: 'owner',
        parent: plugins.parentOrigin,
    });
    // After the client's x-cb-* headers were dropped: the person's zone, and
    // who they are (signed) when the install granted person:read (CB-254);
    // the envelope while socio access is on for them (CB-232).
    Object.assign(
        headers,
        await plugins.personHeaders(id, session.userId, {
            method: c.req.method,
            target: path,
            sessionHash: session.sessionHash,
        }),
    );
    Object.assign(headers, target.headers);
    // Every identity header is signed for the ingress, which passes a
    // plugin none it doesn't cover.
    signFor(target, c.req.method, path, headers);
    let response: IncomingMessage;
    try {
        response = await forward(
            target,
            c.req.method,
            path,
            headers,
            ['GET', 'HEAD'].includes(c.req.method) ? null : c.req.raw.body,
            settings,
            c.req.raw.signal,
        );
    } catch {
        return appPage(502, `${plugin.manifest.name} isn’t answering`, [
            'The plugin service did not answer. Another replica is tried on the next request.',
        ]);
    }
    const status = response.statusCode ?? 502;
    const ancestors = plugin.display === 'embed' ? plugins.parentOrigin : "'none'";
    const out = responseHeaders(response.headers, target, origin, ancestors, true);
    const empty = c.req.method === 'HEAD' || status === 204 || status === 304 || status < 200;
    if (empty) {
        response.resume();
    }
    return new Response(empty ? null : capped(response, settings.maxResponseBytes), {
        status: status < 200 ? 502 : status,
        headers: out,
    });
}

/**
 * A socio's session on a service plugin (CB-232): the same
 * checks as an app's (the credential for `plugin:<id>`, the context proof
 * over the exact request, `authorizeActor` with the install's audience as
 * the person's term), the envelope with `act` and `scp` and a grant-bound
 * `cbob_`, and no legacy identity header. Its response ends when the grant
 * is revoked, on this runtime or by the 5-s re-check.
 */
async function servePluginSocio(
    plugins: AppsPlugins,
    c: Context,
    plugin: NonNullable<ReturnType<AppsPlugins['get']>>,
    origin: string,
    token: string,
): Promise<Response> {
    const settings = plugins.appsSettings!;
    const actors = plugins.actors;
    if (!actors) {
        return plainRefusal(401);
    }
    const method = c.req.method;
    if (Number(c.req.header('content-length') ?? 0) > settings.maxRequestBytes) {
        return new Response('Request is too large.', { status: 413 });
    }
    const body = ['GET', 'HEAD'].includes(method) ? null : await readBody(c.req.raw.body, settings.maxRequestBytes);
    if (body === undefined) {
        return new Response('Request is too large.', { status: 413 });
    }
    const url = new URL(c.req.url);
    const correlationId = randomUUID();
    const proof = c.req.header(CONTEXT_PROOF_HEADER);
    const checked = await actors.check(
        plugin.id,
        token,
        correlationId,
        (credential) =>
            verifyContextProof(actors.contextKey(credential.contextId), proof, {
                method,
                host: requestHost(c),
                requestTarget: rawTarget(c, url),
                bodyDigest: body?.length ? sha256Hex(body) : '',
            }) && proofReplays.fresh(`${credential.contextId}|${proof}`),
    );
    if (!checked.ok) {
        return plainRefusal(checked.status);
    }
    if (!plugin.enabled) {
        return plainRefusal(403);
    }
    const target = await plugins.target(plugin.id);
    if (target.state !== 'running') {
        return appPage(503, `${plugin.manifest.name} isn’t running`, ['Try again in a moment.']);
    }
    const path = `${url.pathname}${url.search}`;
    const { actor, grant } = checked;
    const approval = c.req.header(APPROVAL_HEADER);
    const envelope = actors.envelope(plugin, {
        personId: actor.personId,
        sessionRef: `socio:${actor.sessionId}`,
        obo: actors.mintObo(plugin.id, { grantId: grant.id }, correlationId, settings.timeoutMs),
        method,
        target: path,
        socio: { socioId: actor.socioId, grantId: grant.id, scopes: actor.scopes },
    });
    if (!envelope) {
        return plainRefusal(401);
    }
    const headers = forwardHeaders(c.req.raw.headers.entries(), {
        host: new URL(origin).host,
        protocol: settings.protocol,
        identity: {
            [ACTOR_ENVELOPE_HEADER]: envelope,
            [PLUGIN_TIME_ZONE_HEADER]: await plugins.timeZoneOf(actor.personId),
            // The approval a socio's repeated request names, as for an app:
            // a plugin's consequential actions take approvals.
            ...(approval && APPROVAL_ID.test(approval) ? { [APPROVAL_HEADER]: approval } : {}),
        },
        dropAuthorization: true,
    });
    Object.assign(headers, target.headers);
    signFor(target, method, path, headers);
    const abort = new AbortController();
    const stop = () => abort.abort();
    c.req.raw.signal.addEventListener('abort', stop, { once: true });
    const untrack = actors.track(grant.id, { close: stop });
    const done = () => {
        untrack();
        c.req.raw.signal.removeEventListener('abort', stop);
    };
    let response: IncomingMessage;
    try {
        response = await forward(
            target,
            method,
            path,
            headers,
            body ? (new Blob([new Uint8Array(body)]).stream() as ReadableStream<Uint8Array>) : null,
            settings,
            abort.signal,
        );
    } catch {
        done();
        if (abort.signal.aborted && !c.req.raw.signal.aborted) {
            return plainRefusal(403);
        }
        return appPage(502, `${plugin.manifest.name} isn’t answering`, ['The plugin service did not answer.']);
    }
    const status = response.statusCode ?? 502;
    const out = responseHeaders(response.headers, target, origin, "'none'", true);
    const empty = method === 'HEAD' || status === 204 || status === 304 || status < 200;
    if (empty) {
        response.resume();
        done();
    }
    return new Response(
        empty ? null : untilRevoked(capped(response, settings.maxResponseBytes), response, abort.signal, done),
        { status: status < 200 ? 502 : status, headers: out },
    );
}

// ---------------------------------------------------------------------------
// Public inbound webhooks (CB-370): the paths a service plugin's manifest
// declares, served with no session so a SaaS can call them. The plugin
// verifies the sender itself; the proxy only bounds what reaches it.

/** A webhook path's declaration in a stored manifest, checked again here. */
export function webhookRoute(manifest: Pick<PluginManifest, 'webhooks' | 'entry'>, pathname: string) {
    const list: unknown = manifest.webhooks;
    // The entry page always needs a session, whatever a stored manifest says.
    if (!Array.isArray(list) || pathname === pluginEntryPathname(manifest.entry?.path)) {
        return undefined;
    }
    return (list as PluginWebhook[]).find(
        (hook) =>
            !!hook &&
            typeof hook === 'object' &&
            pluginWebhookPath(hook.path) &&
            hook.path === pathname &&
            (hook.method === undefined || hook.method === 'POST' || hook.method === 'GET'),
    );
}

/** Whole numbers in `[1, max]`, or the default. */
const bounded = (value: unknown, fallback: number, max: number) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 ? Math.min(value, max) : fallback;

/**
 * Per-path counters for webhooks, in this process: one fixed one-minute
 * window per plugin, path and rate. Not per client: behind the edge every
 * sender can look alike, and a SaaS retries a 429.
 */
export class WebhookLimits {
    private limits = new Map<string, RateLimits>();
    take(pluginId: string, hook: PluginWebhook, now = Date.now()) {
        const perMinute = bounded(hook.perMinute, PLUGIN_WEBHOOK_PER_MINUTE_DEFAULT, PLUGIN_WEBHOOK_PER_MINUTE_MAX);
        const key = `${pluginId}\n${hook.path}\n${perMinute}`;
        let limit = this.limits.get(key);
        if (!limit) {
            if (this.limits.size > 1_000) {
                this.limits.clear();
            }
            limit = new RateLimits(perMinute, 60_000);
            this.limits.set(key, limit);
        }
        return limit.take('all', now);
    }
}
const webhookLimits = new WebhookLimits();

/** A webhook's short plain answer: no page, nothing about the plugin. */
function webhookAnswer(status: number, text: string, headers: Record<string, string> = {}) {
    return new Response(text, {
        status,
        headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            ...headers,
        },
    });
}

/**
 * One request to a path a service plugin declares in `webhooks`: no
 * session or credential is asked for, and none is passed. Only the
 * declared method; a body up to its limit (and the apps host's), read
 * whole and passed on byte for byte; the client's cookies, `x-cb-*` and
 * forwarding headers stripped (and a socio's `cbsa_`, never meant for
 * here); no identity header added, only the runtime ingress's key and
 * signature, so the ingress attaches the plugin's proof. Undefined when
 * the path is no webhook of a service plugin's.
 */
async function serveWebhook(
    plugins: AppsPlugins,
    c: Context,
    id: string,
    limits: WebhookLimits = webhookLimits,
): Promise<Response | undefined> {
    // This process's list says whether `id` is a plugin at all (cheap, for
    // every request on the apps host); what decides is the install as the
    // database has it now, so an update or a disable on another runtime of
    // the deploy narrows public paths here at once.
    if (plugins.get(id)?.mode !== 'service') {
        return undefined;
    }
    const plugin = plugins.current(id);
    const settings = plugins.appsSettings;
    if (!plugin || !settings || plugin.mode !== 'service') {
        return undefined;
    }
    const url = new URL(c.req.url);
    const hook = webhookRoute(plugin.manifest, url.pathname);
    if (!hook) {
        return undefined;
    }
    const method = hook.method ?? 'POST';
    if (c.req.method !== method) {
        return webhookAnswer(405, 'Method not allowed.', { allow: method });
    }
    const origin = plugins.origin(id);
    if (!origin || !plugin.enabled) {
        return webhookAnswer(503, 'Not available.');
    }
    if (!limits.take(id, hook)) {
        return webhookAnswer(429, 'Too many requests.', { 'retry-after': '60' });
    }
    const max = Math.min(
        method === 'GET' ? 0 : bounded(hook.maxBodyBytes, PLUGIN_WEBHOOK_BODY_DEFAULT, PLUGIN_WEBHOOK_BODY_MAX),
        settings.maxRequestBytes,
    );
    const declared = c.req.header('content-length');
    if (declared !== undefined && !/^\d+$/.test(declared.trim())) {
        return webhookAnswer(400, 'Bad content length.');
    }
    if (Number(declared ?? 0) > max) {
        return webhookAnswer(413, 'Request is too large.');
    }
    if (method === 'GET' && c.req.header('transfer-encoding')) {
        return webhookAnswer(413, 'Request is too large.');
    }
    const body = method === 'GET' ? null : await readBody(c.req.raw.body, max);
    if (body === undefined) {
        return webhookAnswer(413, 'Request is too large.');
    }
    const target = await plugins.target(id);
    if (target.state !== 'running') {
        return webhookAnswer(503, 'Not available.');
    }
    // Asked again now the body is in: an update or a disable on any runtime
    // while it was uploading closes the path to it, as to a new request.
    const now = plugins.current(id);
    const still = now?.mode === 'service' && now.enabled ? webhookRoute(now.manifest, url.pathname) : undefined;
    if (!still) {
        return webhookAnswer(now?.mode === 'service' && !now.enabled ? 503 : 404, 'Not available.');
    }
    if ((still.method ?? 'POST') !== method) {
        return webhookAnswer(405, 'Method not allowed.', { allow: still.method ?? 'POST' });
    }
    if (
        body &&
        body.length >
            Math.min(
                bounded(still.maxBodyBytes, PLUGIN_WEBHOOK_BODY_DEFAULT, PLUGIN_WEBHOOK_BODY_MAX),
                settings.maxRequestBytes,
            )
    ) {
        return webhookAnswer(413, 'Request is too large.');
    }
    const path = `${url.pathname}${url.search}`;
    const headers = forwardHeaders(c.req.raw.headers.entries(), {
        host: new URL(origin).host,
        protocol: settings.protocol,
        // A socio's credential, under any spelling of its scheme, is never a webhook's.
        dropAuthorization: /cbsa_/i.test(c.req.header('authorization') ?? ''),
    });
    Object.assign(headers, target.headers);
    // Only a task of the service's current container revision answers, and
    // only while the service runs this install's revision (CB-370): during
    // an update's rollout, or after a stale change provisioned another
    // manifest, no code but the one that declared this path gets it.
    const revision = now?.revision;
    if (!revision) {
        return webhookAnswer(503, 'Not available.');
    }
    headers[RUNTIME_HEADER_CURRENT] = revision;
    if (body) {
        headers['content-length'] = String(body.length);
    }
    signFor(target, method, path, headers);
    let response: IncomingMessage;
    try {
        response = await forward(
            target,
            method,
            path,
            headers,
            body ? (new Blob([new Uint8Array(body)]).stream() as ReadableStream<Uint8Array>) : null,
            settings,
            c.req.raw.signal,
        );
    } catch (error) {
        return (error as Error).message === 'timeout'
            ? webhookAnswer(504, 'The plugin took too long.')
            : webhookAnswer(502, 'The plugin did not answer.');
    }
    const status = response.statusCode ?? 502;
    const out = responseHeaders(response.headers, target, origin, "'none'", true);
    const empty = status === 204 || status === 304 || status < 200;
    if (empty) {
        response.resume();
    }
    return new Response(empty ? null : capped(response, settings.maxResponseBytes), {
        status: status < 200 ? 502 : status,
        headers: out,
    });
}

function embedRefused(parent: string) {
    const target = /^https?:\/\/[^/\s]+$/.test(parent) ? parent : 'null';
    const body = `<!doctype html><html><body><p>Open this plugin from Socio.</p><script>parent.postMessage({v:1,source:'socio-plugin',type:'embed-refused'},${JSON.stringify(target)})</script></body></html>`;
    return new Response(body, {
        status: 401,
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': `default-src 'none'; script-src 'unsafe-inline'; frame-ancestors ${target}`,
            'cross-origin-opener-policy': 'same-origin',
            'cross-origin-resource-policy': 'cross-origin',
            'referrer-policy': 'same-origin',
            'cache-control': 'no-store',
        },
    });
}

/**
 * `socioOnly`: the internal apps listener (`internal-listener.ts`), which
 * serves socio sessions alone: no person's cookie, no `/__cb/` pages, and
 * nothing for a host that isn't an app's or a service plugin's (CB-232).
 * `socioOnPublicHost`: whether the public host takes socio sessions too;
 * by default `APPS_SOCIO_ON_PUBLIC_HOST`, read on each request.
 */
export function appsProxy(
    apps: AppsService,
    plugins?: AppsPlugins,
    { socioOnly = false, socioOnPublicHost }: { socioOnly?: boolean; socioOnPublicHost?: boolean } = {},
): MiddlewareHandler {
    return async (c, next) => {
        const settings = apps.settings;
        if (!settings || !isAppsHost(settings, requestHost(c))) {
            return next();
        }
        const label = appLabelOfHost(settings, requestHost(c));
        const app = label ? apps.get(label) : undefined;
        if (socioOnly) {
            const bearer = socioBearer(c.req.header('authorization'));
            if (!bearer) {
                return plainRefusal(401);
            }
            // The proxy's own paths are never an app's, here as on the public host.
            if (isReservedTarget(new URL(c.req.url).pathname)) {
                return appPage(404, 'Not found', ['There is nothing here.']);
            }
            if (app) {
                return serveSocio(apps, c, app, appOrigin(settings, app.id), bearer);
            }
            // A service plugin's socio session (CB-232); nothing else.
            const installed = plugins ?? apps.plugins;
            if (installed && label) {
                const handled = await servePlugin(installed, c, label, true);
                if (handled) {
                    return handled;
                }
            }
            return plainRefusal(401);
        }
        if (!app) {
            if (plugins && label) {
                // A service plugin's public webhook paths (CB-370), before any
                // session or credential check: they take neither.
                const hook = await serveWebhook(plugins, c, label);
                if (hook) {
                    return hook;
                }
                const handled = await servePlugin(
                    plugins,
                    c,
                    label,
                    socioOnPublicHost ?? socioOnPublicHostFromEnv(process.env),
                );
                if (handled) {
                    return handled;
                }
            }
            return appPage(404, 'No app here', [
                'This address doesn’t belong to a mini app, or the app was unregistered.',
            ]);
        }
        const origin = appOrigin(settings, app.id);
        const url = new URL(c.req.url);
        const cookieName = appSessionCookieName(settings);
        const cookie = cookieOf(c.req.header('cookie'), cookieName);
        const launchUrl = (next: string) =>
            `${settings.mainOrigin}/apps/${encodeURIComponent(app.id)}/open?next=${encodeURIComponent(next)}`;
        if (url.pathname === '/__cb/auth' && c.req.method === 'GET') {
            const session = await apps.redeem(app.id, url.searchParams.get('code') ?? undefined);
            if (!session) {
                return appPage(
                    403,
                    'This link has expired',
                    ['Sign-in links for mini apps work once, for a minute. Open the app again from Socio.'],
                    [`<a class="button" href="${escape(launchUrl('/'))}">Open again</a>`],
                );
            }
            return new Response(null, {
                status: 303,
                headers: {
                    location: session.next,
                    'set-cookie': sessionCookie(settings, session.value, session.maxAgeSeconds),
                    'cache-control': 'no-store',
                    'referrer-policy': 'no-referrer',
                },
            });
        }
        if (url.pathname.startsWith('/__cb/')) {
            const sameOrigin =
                c.req.header('origin') === origin ||
                (!c.req.header('origin') && c.req.header('sec-fetch-site') === 'same-origin');
            if (c.req.method !== 'POST' || !sameOrigin) {
                return appPage(404, 'Not found', ['There is nothing here.']);
            }
            if (url.pathname === '/__cb/signout') {
                await apps.endSession(cookie);
                const response = appPage(200, 'Signed out', [`You signed out of ${app.name}.`]);
                response.headers.set('set-cookie', sessionCookie(settings, '', 0));
                return response;
            }
            if (url.pathname === '/__cb/start') {
                const session = await apps.session(app.id, cookie);
                if (!session || session.access !== 'owner') {
                    return appPage(403, 'Only the owner can start this app', ['Ask the app’s owner to start it.']);
                }
                try {
                    await apps.start(app.id, session.userId);
                } catch (error) {
                    return appPage(502, 'Could not start it', [
                        error instanceof Error ? error.message : 'The computer could not be started.',
                    ]);
                }
                return new Response(null, {
                    status: 303,
                    headers: { location: '/', 'cache-control': 'no-store' },
                });
            }
            return appPage(404, 'Not found', ['There is nothing here.']);
        }
        // A socio acting for a person (CB-232): its own path, no cookie. On
        // the public host only with the development switch; otherwise the
        // plain 401, checked by nothing, audited nowhere.
        const bearer = socioBearer(c.req.header('authorization'));
        if (bearer) {
            return (socioOnPublicHost ?? socioOnPublicHostFromEnv(process.env))
                ? serveSocio(apps, c, app, origin, bearer)
                : plainRefusal(401);
        }
        const session = await apps.session(app.id, cookie);
        if (!session) {
            const navigation =
                ['GET', 'HEAD'].includes(c.req.method) &&
                (c.req.header('sec-fetch-mode') === 'navigate' || (c.req.header('accept') ?? '').includes('text/html'));
            if (navigation) {
                return new Response(null, {
                    status: 302,
                    headers: {
                        location: launchUrl(`${url.pathname}${url.search}`),
                        'cache-control': 'no-store',
                        'referrer-policy': 'no-referrer',
                    },
                });
            }
            return new Response('Sign in through Socio to use this app.', {
                status: 401,
                headers: {
                    'content-type': 'text/plain; charset=utf-8',
                    'cache-control': 'no-store',
                    'x-content-type-options': 'nosniff',
                },
            });
        }
        const owner = session.access === 'owner';
        const target = await apps.target(app);
        if (target.state !== 'running') {
            return unavailablePage(app, target.state, owner);
        }
        const length = Number(c.req.header('content-length') ?? 0);
        if (length > settings.maxRequestBytes) {
            return new Response('Request is too large.', { status: 413 });
        }
        const method = c.req.method;
        const path = `${url.pathname}${url.search}`;
        const headers = forwardHeaders(c.req.raw.headers.entries(), {
            host: new URL(origin).host,
            protocol: settings.protocol,
            person: apps.personId(app.id, session.userId),
            access: session.access,
            identity: personIdentity(apps, app, session, method, path),
        });
        // The runtime's ingress names the app and proves it's the app asking.
        if (target.headers) {
            Object.assign(headers, target.headers);
        }
        signFor(target, method, path, headers);
        let response: IncomingMessage;
        try {
            response = await forward(
                target,
                method,
                path,
                headers,
                ['GET', 'HEAD'].includes(method) ? null : c.req.raw.body,
                settings,
                c.req.raw.signal,
            );
        } catch (error) {
            if (error instanceof AppError) {
                return new Response('Request is too large.', { status: 413 });
            }
            if ((error as Error).message === 'timeout') {
                return appPage(504, `${app.name} took too long`, [
                    `It didn’t answer within ${settings.timeoutMs / 1000} seconds.`,
                ]);
            }
            apps.forget(app);
            return unavailablePage(app, 'not_answering', owner);
        }
        apps.touch(app);
        const status = response.statusCode ?? 502;
        const out = responseHeaders(response.headers, target, origin);
        const empty = method === 'HEAD' || status === 204 || status === 304 || status < 200;
        if (empty) {
            response.resume();
        }
        return new Response(empty ? null : capped(response, settings.maxResponseBytes), {
            status: status < 200 ? 502 : status,
            headers: out,
        });
    };
}

const reject = (socket: Duplex, status: string) => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
};

/**
 * WebSocket upgrades on the apps origin (the HTTP server's `upgrade`
 * event): the same session check, plus an Origin that must be the app's
 * own (no cross-site sockets). The handshake reaches the app without
 * cookies; its answer comes back without Set-Cookie; then bytes flow both
 * ways until either side closes, `idleMs` passes in silence, or access
 * ends (unregistered, unshared). A service plugin's host gets the same
 * (CB-239, `pluginUpgrade`). Returns false for other hosts.
 */
export function appsUpgrade(
    apps: AppsService,
    { socioOnly = false, socioOnPublicHost }: { socioOnly?: boolean; socioOnPublicHost?: boolean } = {},
) {
    return (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const settings = apps.settings;
        const host = request.headers.host;
        if (!settings || !isAppsHost(settings, host)) {
            return false;
        }
        socket.on('error', () => socket.destroy());
        void (async () => {
            const label = appLabelOfHost(settings, host);
            const app = label ? apps.get(label) : undefined;
            if (!app) {
                // A service plugin's socket (CB-239), with the same checks.
                const plugins = apps.plugins;
                if (plugins && label && plugins.get(label)?.mode === 'service') {
                    return pluginUpgrade(plugins, settings, request, socket, head, {
                        id: label,
                        socioOnly,
                        socioOnPublicHost: socioOnPublicHost ?? socioOnPublicHostFromEnv(process.env),
                    });
                }
                return reject(socket, '404 Not Found');
            }
            const origin = appOrigin(settings, app.id);
            if (request.headers.origin !== origin) {
                return reject(socket, '403 Forbidden');
            }
            if (String(request.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
                return reject(socket, '400 Bad Request');
            }
            const raw = request.url ?? '/';
            const path = raw.startsWith('/') ? raw : '/';
            // A socio session (CB-232): its credential and context proof, no
            // cookie, the envelope instead of the legacy headers.
            const bearer = socioBearer(
                typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
            );
            let forwarded: Parameters<typeof forwardHeaders>[1];
            let grantId: string | undefined;
            // The internal listener takes socio sessions only; the public host
            // none, without the development switch.
            if (socioOnly && !bearer) {
                return reject(socket, '401 Unauthorized');
            }
            if (bearer && !socioOnly && !(socioOnPublicHost ?? socioOnPublicHostFromEnv(process.env))) {
                return reject(socket, '401 Unauthorized');
            }
            if (bearer) {
                if (!apps.actors) {
                    return reject(socket, '401 Unauthorized');
                }
                const correlationId = randomUUID();
                const proof = request.headers[CONTEXT_PROOF_HEADER];
                const checked = await socioCheck(
                    apps,
                    app,
                    bearer,
                    {
                        method: 'GET',
                        host: host!,
                        target: raw,
                        bodyDigest: '',
                        proof: typeof proof === 'string' ? proof : undefined,
                    },
                    correlationId,
                );
                if (!checked.ok) {
                    return reject(socket, checked.status === 401 ? '401 Unauthorized' : '403 Forbidden');
                }
                grantId = checked.grant.id;
                forwarded = {
                    host: new URL(origin).host,
                    protocol: settings.protocol,
                    upgrade: true,
                    dropAuthorization: true,
                    identity: socioIdentity(apps, app, checked, 'GET', path, correlationId, undefined),
                };
            } else {
                const session = await apps.session(
                    app.id,
                    cookieOf(request.headers.cookie, appSessionCookieName(settings)),
                );
                if (!session) {
                    return reject(socket, '401 Unauthorized');
                }
                forwarded = {
                    host: new URL(origin).host,
                    protocol: settings.protocol,
                    person: apps.personId(app.id, session.userId),
                    access: session.access,
                    upgrade: true,
                    identity: personIdentity(apps, app, session, 'GET', path),
                };
            }
            const target = await apps.target(app);
            if (target.state !== 'running') {
                return reject(socket, '503 Service Unavailable');
            }
            const headers = forwardHeaders(rawHeaderEntries(request), forwarded);
            if (target.headers) {
                Object.assign(headers, target.headers);
            }
            signFor(target, 'GET', path, headers);
            relayUpgrade(socket, head, settings, target, path, headers, (close) => {
                const untrack = apps.track(app.id, { destroy: close });
                // A socio's socket also closes with its grant.
                const untrackGrant = grantId ? apps.actors!.track(grantId, { close }) : () => undefined;
                return () => {
                    untrack();
                    untrackGrant();
                };
            });
        })().catch(() => socket.destroy());
        return true;
    };
}

const rawHeaderEntries = (request: IncomingMessage) => {
    const entries: Array<[string, string]> = [];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
        entries.push([request.rawHeaders[i], request.rawHeaders[i + 1]]);
    }
    return entries;
};

/** How often a person's plugin socket asks again whether its session lives. */
export const PLUGIN_SOCKET_RECHECK_MS = 5_000;

/**
 * A service plugin's WebSocket (CB-239, CB-232): the
 * same rules as its HTTP requests and as an app's socket. Origin must be
 * the plugin's own; a socio's credential and context proof (over `GET`,
 * the Host and the raw request-target) for `plugin:<id>`, with the
 * envelope (`act`, `scp`, a grant-bound `cbob_`) and never a legacy
 * identity header, or a person's plugin session with the CB-254 headers
 * and their envelope. Every identity header is signed for the ingress.
 * The socket closes when the grant is revoked (here, by another runtime's
 * signal, or the 5-s re-check), when the plugin is disabled, uninstalled
 * or its audience narrowed on this runtime, and, for a person's, within
 * 5 s of their session ending on any runtime (it is read from the
 * database).
 */
async function pluginUpgrade(
    plugins: AppsPlugins,
    settings: AppsSettings,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    options: { id: string; socioOnly: boolean; socioOnPublicHost: boolean },
) {
    const plugin = plugins.get(options.id);
    const origin = plugins.origin(options.id);
    if (!plugin || plugin.mode !== 'service' || !origin) {
        return reject(socket, '404 Not Found');
    }
    if (request.headers.origin !== origin) {
        return reject(socket, '403 Forbidden');
    }
    if (String(request.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
        return reject(socket, '400 Bad Request');
    }
    const raw = request.url ?? '/';
    const path = raw.startsWith('/') ? raw : '/';
    // The proxy's own pages and the host's paths are never a person's, for a socket either.
    if (isReservedTarget(path)) {
        return reject(socket, '404 Not Found');
    }
    const bearer = socioBearer(
        typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
    );
    if (options.socioOnly && !bearer) {
        return reject(socket, '401 Unauthorized');
    }
    if (bearer && !options.socioOnly && !options.socioOnPublicHost) {
        return reject(socket, '401 Unauthorized');
    }
    let forwarded: Parameters<typeof forwardHeaders>[1];
    let grantId: string | undefined;
    let personId: string;
    let sessionHash: string | undefined;
    if (bearer) {
        const actors = plugins.actors;
        if (!actors) {
            return reject(socket, '401 Unauthorized');
        }
        const correlationId = randomUUID();
        const proof = request.headers[CONTEXT_PROOF_HEADER];
        const proofText = typeof proof === 'string' ? proof : undefined;
        const checked = await actors.check(
            plugin.id,
            bearer,
            correlationId,
            (credential) =>
                verifyContextProof(actors.contextKey(credential.contextId), proofText, {
                    method: 'GET',
                    host: request.headers.host ?? '',
                    requestTarget: raw,
                    bodyDigest: '',
                }) && proofReplays.fresh(`${credential.contextId}|${proofText}`),
        );
        if (!checked.ok) {
            return reject(socket, checked.status === 401 ? '401 Unauthorized' : '403 Forbidden');
        }
        if (!plugins.get(plugin.id)?.enabled) {
            return reject(socket, '403 Forbidden');
        }
        const { actor, grant } = checked;
        const envelope = actors.envelope(plugin, {
            personId: actor.personId,
            sessionRef: `socio:${actor.sessionId}`,
            obo: actors.mintObo(plugin.id, { grantId: grant.id }, correlationId, settings.timeoutMs),
            method: 'GET',
            target: path,
            socio: {
                socioId: actor.socioId,
                grantId: grant.id,
                scopes: actor.scopes,
            },
        });
        if (!envelope) {
            return reject(socket, '401 Unauthorized');
        }
        grantId = grant.id;
        personId = actor.personId;
        forwarded = {
            host: new URL(origin).host,
            protocol: settings.protocol,
            upgrade: true,
            dropAuthorization: true,
            identity: {
                [ACTOR_ENVELOPE_HEADER]: envelope,
                [PLUGIN_TIME_ZONE_HEADER]: await plugins.timeZoneOf(actor.personId),
            },
        };
    } else {
        const session = await plugins.session(
            plugin.id,
            cookieOf(request.headers.cookie, appSessionCookieName(settings)),
        );
        if (!session) {
            return reject(socket, '401 Unauthorized');
        }
        personId = session.userId;
        sessionHash = session.sessionHash;
        forwarded = {
            host: new URL(origin).host,
            protocol: settings.protocol,
            person: plugins.personId(plugin.id, session.userId),
            access: 'owner',
            parent: plugins.parentOrigin,
            upgrade: true,
            // The person's zone, who they are when the install granted
            // person:read (CB-254), and their envelope while socio access is on
            // for them, as for the plugin's HTTP requests.
            identity: await plugins.personHeaders(plugin.id, session.userId, {
                method: 'GET',
                target: path,
                sessionHash: session.sessionHash,
            }),
        };
    }
    const target = await plugins.target(plugin.id);
    if (target.state !== 'running') {
        return reject(socket, '503 Service Unavailable');
    }
    const headers = forwardHeaders(rawHeaderEntries(request), forwarded);
    Object.assign(headers, target.headers);
    // Every identity header is signed: the ingress passes a plugin none it
    // doesn't cover.
    signFor(target, 'GET', path, headers);
    relayUpgrade(socket, head, settings, target, path, headers, (close) => {
        const untrack = plugins.track(plugin.id, personId, { destroy: close });
        const untrackGrant = grantId ? plugins.actors!.track(grantId, { close }) : () => undefined;
        // A person's session, read from the database every 5 s, so a sign-out,
        // a narrowed audience or a disabled plugin on the other runtime ends
        // the socket too.
        // The install it opened under, as the database has it: an update
        // (a new manifest, permissions included) or a disable on any runtime
        // closes it within 5 s too (CB-370), a person's or a socio's.
        const opened = JSON.stringify(plugin.manifest);
        const installChanged = () => {
            const now = plugins.current(plugin.id);
            return !now || !now.enabled || JSON.stringify(now.manifest) !== opened;
        };
        const hash = sessionHash;
        const timer: ReturnType<typeof setInterval> = setInterval(() => {
            try {
                if (installChanged()) {
                    close();
                    return;
                }
            } catch {
                close();
                return;
            }
            if (hash) {
                void plugins.sessionByHash(plugin.id, hash).then(
                    (live) => {
                        if (!live) {
                            close();
                        }
                    },
                    () => close(),
                );
            }
        }, PLUGIN_SOCKET_RECHECK_MS);
        timer.unref?.();
        return () => {
            clearInterval(timer);
            untrack();
            untrackGrant();
        };
    });
}

/**
 * The upstream half of an upgrade, once every check passed: the handshake
 * to the target, its answer back without cookies, then bytes both ways
 * until either side closes, `idleMs` passes in silence, or `track`'s
 * close is called (access ended). `track` registers the socket and
 * answers how to stop tracking it.
 */
function relayUpgrade(
    socket: Duplex,
    head: Buffer,
    settings: AppsSettings,
    target: { host: string; port: number },
    path: string,
    headers: Record<string, string>,
    track: (close: () => void) => () => void,
) {
    const upstream = connect({ host: target.host, port: target.port });
    const tracking: { untrack?: () => void; closed: boolean } = {
        closed: false,
    };
    const close = () => {
        if (!tracking.closed) {
            tracking.closed = true;
            tracking.untrack?.();
        }
        upstream.destroy();
        socket.destroy();
    };
    tracking.untrack = track(close);
    // Access that ended while it was being tracked: closed already.
    if (tracking.closed) {
        tracking.untrack();
    }
    let answered = false;
    upstream.setTimeout(settings.timeoutMs, close);
    upstream.once('error', () => {
        if (!answered && !socket.destroyed) {
            reject(socket, '502 Bad Gateway');
        }
        close();
    });
    socket.once('close', close);
    upstream.once('close', close);
    upstream.once('connect', () => {
        upstream.write(
            `GET ${path} HTTP/1.1\r\n${Object.entries(headers)
                .map(([name, value]) => `${name}: ${value.replace(/[\r\n]/g, '')}`)
                .join('\r\n')}\r\n\r\n`,
        );
        if (head.length) {
            upstream.write(head);
        }
        // The target's handshake answer, without cookies, then raw bytes.
        let buffered = Buffer.alloc(0);
        const onHead = (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk]);
            const end = buffered.indexOf('\r\n\r\n');
            if (end < 0) {
                if (buffered.length > 64 * 1024) {
                    close();
                }
                return;
            }
            upstream.off('data', onHead);
            answered = true;
            const lines = buffered
                .subarray(0, end)
                .toString('latin1')
                .split('\r\n')
                .filter((line, index) => index === 0 || !/^set-cookie2?\s*:/i.test(line));
            socket.write(`${lines.join('\r\n')}\r\n\r\n`);
            const rest = buffered.subarray(end + 4);
            if (rest.length) {
                socket.write(rest);
            }
            if (!/^HTTP\/1\.[01] 101/.test(lines[0] ?? '')) {
                close();
                return;
            }
            upstream.setTimeout(settings.idleMs, close);
            (socket as Socket).setTimeout?.(settings.idleMs, close);
            upstream.pipe(socket);
            socket.pipe(upstream);
        };
        upstream.on('data', onHead);
    });
}
