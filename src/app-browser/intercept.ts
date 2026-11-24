import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';

import type { BrowserContext, Route, WebSocketRoute } from 'playwright';
import WebSocket from 'ws';

import { signContextProof } from '@socio/foundation/actors/keys';

/**
 * The origin lock (CB-232). Every request of the context
 * is routed here. Requests to the context's one app origin are fetched by
 * the worker itself, from a fixed internal upstream (never the app's
 * public name, so DNS rebinding has nothing to act on), with the
 * credential and the context proof added at this layer. Everything else
 * is aborted. The page never sees the credential: it is not in a URL, a
 * header the page can read, or the cookie jar.
 */

/** What the worker holds for its context (worker.ts). */
export interface ContextCredential {
    token: string;
    key: Buffer;
    expiresAt: number;
}

export interface OriginLockOptions {
    /** The app's public origin, `https://<label><id>.<APPS_HOST>`. */
    origin: URL;
    /** Socio's internal apps listener, `http://host:port`. */
    upstream: URL;
    credential: () => ContextCredential | undefined;
    now?: () => number;
    /** Largest request body forwarded, bytes. */
    maxRequestBytes?: number;
    /** Largest response body accepted, bytes. */
    maxResponseBytes?: number;
    timeoutMs?: number;
}

/** What the lock refused, as counts (the context audit). */
export interface LockStats {
    forwarded: number;
    blocked: number;
    offOriginRedirects: number;
    /** The last navigation the lock ended, in words, for the next snapshot. */
    ended?: string;
}

/**
 * Request headers never forwarded from the page: the platform sets
 * identity and credentials, hop-by-hop headers are the transport's, and
 * forwarding headers would let a page claim an address.
 */
const DROP_REQUEST = new Set([
    'host',
    'cookie',
    'cookie2',
    'authorization',
    'proxy-authorization',
    'proxy-connection',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'te',
    'trailer',
    'upgrade',
    'content-length',
    'accept-encoding',
    'forwarded',
    'x-real-ip',
    'via',
]);
const DROP_REQUEST_PREFIX = ['x-cb-', 'x-forwarded-', 'sec-websocket-'];

/** Response headers the page never gets. */
const DROP_RESPONSE = new Set([
    'set-cookie',
    'set-cookie2',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'content-length',
    'content-encoding',
    'alt-svc',
    'report-to',
    'reporting-endpoints',
    'nel',
    'location',
]);

/** The page's request headers, as forwarded upstream (lowercase names). */
export function forwardHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [raw, value] of Object.entries(headers)) {
        const name = raw.toLowerCase();
        if (name.startsWith(':')) {
            continue;
        }
        if (DROP_REQUEST.has(name)) {
            continue;
        }
        if (DROP_REQUEST_PREFIX.some((prefix) => name.startsWith(prefix))) {
            continue;
        }
        out[name] = value;
    }
    return out;
}

/** The app's response headers, as the page gets them. */
export function pageHeaders(headers: IncomingHttpHeaders): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) {
            continue;
        }
        if (DROP_RESPONSE.has(name) || name.startsWith('x-cb-')) {
            continue;
        }
        out[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    return out;
}

/** Whether `url` is on the context's app origin, exactly. */
export function onOrigin(url: string, origin: URL) {
    try {
        const parsed = new URL(url);
        return parsed.origin === origin.origin && !parsed.username && !parsed.password;
    } catch {
        return false;
    }
}

/**
 * The exact request-target Chromium asked for (path and query, no
 * fragment), as the proxy sees it and the proof covers.
 */
export function requestTarget(url: string, origin: URL) {
    const rest = url.slice(origin.origin.length).split('#')[0]!;
    if (!rest || rest[0] === '?') {
        return `/${rest}`;
    }
    return rest;
}

/**
 * A redirect's next hop: the same origin (followed) or anywhere else
 * (the navigation ends, nothing is sent there).
 */
export function redirectTarget(
    location: string | undefined,
    from: string,
    origin: URL,
): { kind: 'same'; location: string } | { kind: 'off' } | { kind: 'none' } {
    if (!location) {
        return { kind: 'none' };
    }
    let next: URL;
    try {
        next = new URL(location, from);
    } catch {
        return { kind: 'off' };
    }
    if (!onOrigin(next.href, origin)) {
        return { kind: 'off' };
    }
    return { kind: 'same', location: requestTarget(next.href, origin) };
}

/** Close codes a WebSocket may send (RFC 6455 §7.4). */
const SENDABLE_CLOSE = (code: number) =>
    code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);

const sha256Hex = (body: Buffer | undefined) =>
    body && body.length ? createHash('sha256').update(body).digest('hex') : '';

const page = (title: string, text: string) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title><p>${text}</p>`;

/** The page shown when the app tries to send the browser elsewhere. */
export const OFF_ORIGIN_PAGE = page(
    'Stopped',
    'The app tried to send you to another site, so the app browser stopped there. Nothing was sent to that site.',
);
const escapeAttribute = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
/** A same-origin navigation redirect, as a new navigation (`handle`). */
const refreshPage = (url: string) =>
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escapeAttribute(url)}"><title>Redirecting</title>`;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** Same-origin redirects followed at most (browsers stop at 20). */
const MAX_REDIRECTS = 10;

const ENDED_PAGE = page('Access ended', 'This app browser’s access has ended. Ask for access again.');

export class OriginLock {
    readonly stats: LockStats = {
        forwarded: 0,
        blocked: 0,
        offOriginRedirects: 0,
    };
    private now: () => number;
    private redirecting?: string;
    constructor(private options: OriginLockOptions) {
        this.now = options.now ?? Date.now;
    }

    /** Routes every request and WebSocket of `context` through the lock. */
    async attach(context: BrowserContext) {
        await context.route('**/*', (route) => this.handle(route));
        await context.routeWebSocket(/.*/, (ws) => this.socket(ws));
    }

    private block(route: Route, navigation: boolean, why: string) {
        this.stats.blocked++;
        if (navigation) {
            this.stats.ended = why;
        }
        return route.abort('blockedbyclient');
    }

    /** The headers the platform adds: the credential and the context proof. */
    signed(method: string, target: string, body: Buffer | undefined) {
        const credential = this.options.credential();
        if (!credential || credential.expiresAt <= this.now()) {
            return undefined;
        }
        return {
            authorization: `Bearer ${credential.token}`,
            'x-cb-context': signContextProof(
                credential.key,
                {
                    method,
                    host: this.options.origin.host,
                    requestTarget: target,
                    bodyDigest: sha256Hex(body),
                },
                this.now(),
            ),
        };
    }

    /**
     * A same-origin navigation redirect this lock answered with a refresh
     * page (worker.ts waits for it to land); taken once.
     */
    takeRedirect() {
        const next = this.redirecting;
        this.redirecting = undefined;
        return next;
    }

    async handle(route: Route) {
        const request = route.request();
        const url = request.url();
        const navigation = request.isNavigationRequest();
        const { origin } = this.options;
        if (!onOrigin(url, origin)) {
            return this.block(route, navigation, 'a request to another site');
        }
        let method = request.method().toUpperCase();
        let target = requestTarget(url, origin);
        let body = request.postDataBuffer() ?? undefined;
        if (body && body.length > (this.options.maxRequestBytes ?? 8 << 20)) {
            return this.block(route, navigation, 'a request too large to send');
        }
        const headers = forwardHeaders(await request.allHeaders());
        let current = url;
        for (let hop = 0; ; hop++) {
            const auth = this.signed(method, target, body);
            if (!auth) {
                if (navigation) {
                    return route.fulfill({
                        status: 401,
                        contentType: 'text/html; charset=utf-8',
                        body: ENDED_PAGE,
                    });
                }
                return route.abort('accessdenied');
            }
            let response: Awaited<ReturnType<OriginLock['fetch']>>;
            try {
                response = await this.fetch(method, target, { ...headers, ...auth }, body);
            } catch {
                return route.abort('failed');
            }
            this.stats.forwarded++;
            if (!REDIRECTS.has(response.status)) {
                return route.fulfill({
                    status: response.status,
                    headers: pageHeaders(response.headers),
                    body: response.body,
                });
            }
            const next = redirectTarget(
                typeof response.headers.location === 'string' ? response.headers.location : undefined,
                current,
                origin,
            );
            if (next.kind === 'none') {
                return route.fulfill({
                    status: response.status,
                    headers: pageHeaders(response.headers),
                    body: response.body,
                });
            }
            if (next.kind === 'off') {
                // Nothing goes there: not the request, not a header.
                this.stats.offOriginRedirects++;
                this.stats.blocked++;
                if (!navigation) {
                    return route.abort('blockedbyclient');
                }
                this.stats.ended = 'the app tried to send you to another site';
                return route.fulfill({
                    status: 200,
                    contentType: 'text/html; charset=utf-8',
                    body: OFF_ORIGIN_PAGE,
                });
            }
            if (hop >= MAX_REDIRECTS) {
                return this.block(route, navigation, 'a redirect loop');
            }
            // 301, 302 and 303 go on as GET without a body, as browsers do;
            // 307 and 308 keep the method and body.
            const keep = response.status === 307 || response.status === 308;
            const nextMethod = keep ? method : method === 'HEAD' ? 'HEAD' : 'GET';
            if (navigation && nextMethod === 'GET') {
                // Playwright never routes a redirect's next hop (it would go to
                // the network, which is dead here). A navigation goes on as a new
                // one, which is routed again and leaves the page at the app's
                // real address.
                this.redirecting = origin.origin + next.location;
                return route.fulfill({
                    status: 200,
                    contentType: 'text/html; charset=utf-8',
                    body: refreshPage(this.redirecting),
                });
            }
            // Anything else is followed here, on the app origin only.
            if (!keep) {
                body = undefined;
                delete headers['content-type'];
            }
            method = nextMethod;
            target = next.location;
            current = origin.origin + target;
        }
    }

    /** One request to the internal upstream, the app's host as `Host`. */
    fetch(method: string, target: string, headers: Record<string, string>, body: Buffer | undefined) {
        const { upstream, origin } = this.options;
        const limit = this.options.maxResponseBytes ?? 20 << 20;
        const send = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
        return new Promise<{
            status: number;
            headers: IncomingHttpHeaders;
            body: Buffer;
        }>((resolve, reject) => {
            const outgoing = send(
                {
                    protocol: upstream.protocol,
                    hostname: upstream.hostname,
                    port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
                    method,
                    path: target,
                    headers: {
                        ...headers,
                        host: origin.host,
                        'accept-encoding': 'identity',
                        ...(body ? { 'content-length': String(body.length) } : {}),
                    },
                    timeout: this.options.timeoutMs ?? 30_000,
                    // Never a proxy, never an agent shared with anything else.
                    agent: false,
                },
                (incoming) => {
                    const chunks: Buffer[] = [];
                    let size = 0;
                    incoming.on('data', (chunk: Buffer) => {
                        size += chunk.length;
                        if (size > limit) {
                            incoming.destroy();
                            reject(new Error('The app’s response is too large.'));
                            return;
                        }
                        chunks.push(chunk);
                    });
                    incoming.on('end', () =>
                        resolve({
                            status: incoming.statusCode ?? 502,
                            headers: incoming.headers,
                            body: Buffer.concat(chunks),
                        }),
                    );
                    incoming.on('error', reject);
                },
            );
            outgoing.on('timeout', () => outgoing.destroy(new Error('The app did not answer in time.')));
            outgoing.on('error', reject);
            outgoing.end(body);
        });
    }

    /**
     * WebSockets: Playwright can't add headers to its own server connection,
     * so the worker connects itself, to the upstream, with the credential and
     * proof, and relays messages. Never a cookie, never a URL parameter. Any
     * other WebSocket closes before anything is sent.
     */
    socket(ws: WebSocketRoute) {
        const url = ws.url();
        const { origin, upstream } = this.options;
        const httpUrl = url.replace(/^ws/, 'http');
        if (!/^wss?:/.test(url) || !onOrigin(httpUrl, origin)) {
            this.stats.blocked++;
            void ws.close({ code: 1008, reason: 'Blocked' });
            return;
        }
        const target = requestTarget(httpUrl, origin);
        const auth = this.signed('GET', target, undefined);
        if (!auth) {
            void ws.close({ code: 1008, reason: 'Access ended' });
            return;
        }
        const server = new WebSocket(`${upstream.protocol === 'https:' ? 'wss' : 'ws'}://${upstream.host}${target}`, {
            headers: { host: origin.host, ...auth },
            followRedirects: false,
            maxPayload: 4 << 20,
            perMessageDeflate: false,
        });
        const pending: Array<string | Buffer> = [];
        this.stats.forwarded++;
        server.on('open', () => {
            for (const message of pending.splice(0)) {
                server.send(message);
            }
        });
        server.on('message', (data, binary) => {
            ws.send(binary ? (data as Buffer) : data.toString());
        });
        server.on('close', (code) => ws.close({ code: SENDABLE_CLOSE(code) ? code : 1011 }));
        server.on('error', () => ws.close({ code: 1011 }));
        // Refused or redirected: no redirect is followed, nothing else is tried.
        server.on('unexpected-response', (request) => {
            request.destroy();
            void ws.close({ code: 1008, reason: 'Refused' });
        });
        ws.onMessage((message) => {
            if (server.readyState === WebSocket.OPEN) {
                server.send(message);
            } else if (server.readyState === WebSocket.CONNECTING) {
                pending.push(message);
            }
        });
        ws.onClose(() => server.close());
    }
}
