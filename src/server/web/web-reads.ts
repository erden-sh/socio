import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import type { WebReadRequest, WebReadResult, WebResponse } from '@socio/foundation/web/reads';
import { WEB_IDENTITIES, type WebIdentity, type WebStatus } from '@socio/shared/web/web-types';

import { validateUrl } from '../../net/public-address.js';
import type { WebActivity } from '../integrations/contract.js';

import type { WebReaderShape, WebSettings } from './contract.js';
import type { WebStore } from './web-store.js';

/*
 * Web reads (release 4): the declared-agent side of a Dot's web
 * identity. Every request carries the same honest User-Agent and nothing
 * else about who asked: no cookies, no Authorization, no From, no
 * Referer, no tracking headers, and never the user's name, email or
 * account. A Dot can add only the headers in `ALLOWED_HEADERS`.
 *
 * Reads keep the browser service's network rules (public addresses only,
 * pinned DNS, standard ports) on every redirect hop, and add per-host and
 * global rate limits, a response cache, size and time caps, and a per-host
 * stop when a site refuses. `WebSettings` is in `contract.ts`, the read
 * types in `@socio/foundation/web/reads`.
 */

/** The headers a Dot may set. Everything else is refused, by name. */
export const ALLOWED_HEADERS = ['accept', 'accept-language', 'if-none-match', 'if-modified-since'] as const;
export const MAX_REDIRECTS = 5;
const DEFAULT_ACCEPT = 'text/html, application/json, text/csv, text/plain;q=0.9, */*;q=0.5';
/** A response's own max-age never keeps it longer than this. */
const MAX_TTL_MS = 3_600_000;
const CACHE_ENTRIES = 200;
const CACHE_BYTES = 32_000_000;

/** The first `APP_ORIGIN` entry as an origin, if it is an HTTP(S) URL. */
export function appOriginFrom(appOrigin: string | undefined) {
    const first = appOrigin?.split(',')[0]?.trim();
    if (!first) {
        return undefined;
    }
    try {
        const url = new URL(first);
        return ['http:', 'https:'].includes(url.protocol) ? url.origin : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The declared User-Agent. It names the software and links the public
 * /agents page; it never names a user, workspace member or contact.
 */
export function agentUserAgent(origin: string | undefined) {
    return origin ? `SocioAgent/1.0 (user-directed agent; +${origin}/agents)` : 'SocioAgent/1.0 (user-directed agent)';
}

function bounded(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number) {
    const raw = env[name]?.trim();
    if (!raw) {
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer from ${min} to ${max}.`);
    }
    return value;
}

export function webSettingsFromEnv(env: Record<string, string | undefined>): WebSettings {
    const identity = env.WEB_IDENTITY_DEFAULT?.trim().toLowerCase() || 'agent';
    if (!(WEB_IDENTITIES as readonly string[]).includes(identity)) {
        throw new Error('WEB_IDENTITY_DEFAULT must be agent or browser.');
    }
    const contact = env.AGENTS_CONTACT?.trim() || undefined;
    if (contact) {
        let protocol = '';
        try {
            protocol = new URL(contact).protocol;
        } catch {
            // Reported below.
        }
        if (!['http:', 'https:', 'mailto:'].includes(protocol)) {
            throw new Error('AGENTS_CONTACT must be an http(s) or mailto: URL.');
        }
    }
    const origin = appOriginFrom(env.APP_ORIGIN);
    return {
        identityDefault: identity as WebIdentity,
        userAgent: agentUserAgent(origin),
        agentsUrl: origin ? `${origin}/agents` : undefined,
        contact,
        maxBytes: bounded(env, 'WEB_MAX_BYTES', 2_000_000, 1024, 50_000_000),
        timeoutMs: bounded(env, 'WEB_TIMEOUT_MS', 15_000, 100, 120_000),
        perHostPerMinute: bounded(env, 'WEB_HOST_RATE_PER_MINUTE', 30, 1, 600),
        globalPerMinute: bounded(env, 'WEB_GLOBAL_RATE_PER_MINUTE', 300, 1, 10_000),
        cooldownMs: bounded(env, 'WEB_COOLDOWN_SECONDS', 900, 1, 86_400) * 1000,
        cacheTtlMs: bounded(env, 'WEB_CACHE_TTL_SECONDS', 60, 0, 86_400) * 1000,
    };
}

/**
 * The Dot's headers, lowercased. Throws on any header outside the
 * allowlist, so `Cookie` or `Authorization` are refused, not dropped.
 */
export function requestHeaders(input: Record<string, string> = {}) {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(input)) {
        const key = name.trim().toLowerCase();
        if (!(ALLOWED_HEADERS as readonly string[]).includes(key)) {
            throw new Error(
                `Header "${name}" is not allowed. Only Accept, Accept-Language, If-None-Match and If-Modified-Since may be set; web reads never carry cookies, Authorization or other credentials.`,
            );
        }
        if (/[\r\n]/.test(value) || value.length > 512) {
            throw new Error(`Header "${name}" has an invalid value.`);
        }
        headers[key] = value;
    }
    return headers;
}

/**
 * The audited path: the URL path (at most 200 characters) and the names of
 * its query parameters, never their values, which may hold user data.
 */
export function auditPath(url: URL) {
    const names = [...new Set(url.searchParams.keys())];
    return (url.pathname.slice(0, 200) + (names.length ? `?${names.map((name) => `${name}=`).join('&')}` : '')).slice(
        0,
        400,
    );
}

/** Pins a URL to one public address, or throws why it can't. */
export type Resolver = (url: URL) => Promise<{ address: string; family: number }>;
const publicOnly: Resolver = async (url) => {
    const { address, family } = await validateUrl(url.href);
    return { address, family };
};

export const BROWSER_IDENTITY_MESSAGE =
    "This socio's web identity is browser: it reads the web through its computer's browser (computer_navigate, computer_read), with that browser's usual identity, not through http_get or http_json. Use those computer tools if they are available; otherwise ask an admin to set this socio's web identity to agent.";

/** Response headers worth passing on to the Dot. */
const KEPT_HEADERS = [
    'content-type',
    'content-length',
    'content-language',
    'etag',
    'last-modified',
    'cache-control',
    'expires',
    'retry-after',
];

interface Fetched {
    status: number;
    headers: IncomingHttpHeaders;
    body: Buffer;
    complete: boolean;
}
interface CacheEntry {
    url: string;
    status: number;
    headers: Record<string, string>;
    body: Buffer;
    expiresAt: number;
    redirects: number;
}
interface Bucket {
    tokens: number;
    at: number;
}

const header = (headers: IncomingHttpHeaders, name: string) => {
    const value = headers[name];
    return Array.isArray(value) ? value.join(', ') : value;
};

/** Retry-After as milliseconds from now: delta-seconds or an HTTP date. */
export function retryAfterMs(value: string | undefined, now: number) {
    if (!value) {
        return undefined;
    }
    if (/^\d+$/.test(value.trim())) {
        return Number(value.trim()) * 1000;
    }
    const date = Date.parse(value);
    return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** How long a response stays fresh, or undefined if it must not be kept. */
function freshness(headers: Record<string, string>, fallbackMs: number) {
    const control = (headers['cache-control'] ?? '').toLowerCase();
    if (/\b(no-store|private)\b/.test(control)) {
        return undefined;
    }
    if (/\bno-cache\b/.test(control)) {
        return 0;
    }
    const age = /\bs-maxage=(\d+)/.exec(control) ?? /\bmax-age=(\d+)/.exec(control);
    return age ? Math.min(Number(age[1]) * 1000, MAX_TTL_MS) : fallbackMs;
}

const duration = (ms: number) => {
    const seconds = Math.ceil(ms / 1000);
    return seconds === 1 ? '1 second' : seconds < 120 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`;
};

export class WebReads implements WebReaderShape {
    readonly store: WebStore;
    private resolve: Resolver;
    private now: () => number;
    private buckets = new Map<string, Bucket>();
    private cache = new Map<string, CacheEntry>();
    private cacheBytes = 0;
    private stops = new Map<string, { until: number; status: number }>();
    /**
     * Over the connection's `WebStore`, which the composition builds
     * (`composition/integration-stores.ts`, `webStoreOn`); the composition
     * keeps one reader per connection (`composition/web.ts`, `webReadsFor`).
     */
    constructor(
        store: WebStore,
        readonly settings: WebSettings,
        options: { resolve?: Resolver; now?: () => number } = {},
    ) {
        this.store = store;
        this.resolve = options.resolve ?? publicOnly;
        this.now = options.now ?? Date.now;
    }
    async identity(dotId: string): Promise<WebIdentity> {
        return (await this.store.identity(dotId)) ?? this.settings.identityDefault;
    }
    activity(dotId: string, before: number, limit: number): Promise<WebActivity[]> {
        return this.store.activity(dotId, before, limit);
    }
    async status(dotId: string, withAudit: boolean): Promise<WebStatus> {
        const own = await this.store.identity(dotId);
        const now = this.now();
        return {
            identity: own ?? this.settings.identityDefault,
            source: own ? 'dot' : 'default',
            defaultIdentity: this.settings.identityDefault,
            userAgent: this.settings.userAgent,
            limits: {
                perHostPerMinute: this.settings.perHostPerMinute,
                globalPerMinute: this.settings.globalPerMinute,
                maxBytes: this.settings.maxBytes,
                timeoutMs: this.settings.timeoutMs,
                cacheTtlSeconds: this.settings.cacheTtlMs / 1000,
                cooldownSeconds: this.settings.cooldownMs / 1000,
            },
            stoppedHosts: [...this.stops]
                .filter(([, stop]) => stop.until > now)
                .map(([host, stop]) => ({ host, ...stop })),
            ...(withAudit ? { audit: await this.store.audit(dotId) } : {}),
        };
    }

    async read(request: WebReadRequest): Promise<WebReadResult> {
        if ((await this.identity(request.dotId)) === 'browser') {
            return {
                ok: false,
                reason: 'browser_identity',
                message: BROWSER_IDENTITY_MESSAGE,
            };
        }
        const method = request.method ?? 'GET';
        let url: URL;
        let headers: Record<string, string>;
        try {
            url = new URL(request.url);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
                throw new Error('Only public HTTP(S) URLs without credentials are allowed.');
            }
            headers = requestHeaders(request.headers);
        } catch (error) {
            return { ok: false, reason: 'invalid', message: messageOf(error) };
        }
        url.hash = '';
        const audit = (target: URL, outcome: string, status?: number, bytes = 0) =>
            this.store.record({
                dotId: request.dotId,
                userId: request.userId,
                method,
                host: target.host.toLowerCase(),
                path: auditPath(target),
                status: status ?? null,
                bytes,
                outcome,
            });
        // Conditional requests of the Dot's own go to the site as they are.
        const cacheable = method === 'GET' && !headers['if-none-match'] && !headers['if-modified-since'];
        const key = `${url.href}\n${headers.accept ?? ''}\n${headers['accept-language'] ?? ''}`;
        const cached = cacheable ? this.cache.get(key) : undefined;
        if (cached && cached.expiresAt > this.now()) {
            audit(url, 'cached', cached.status, cached.body.length);
            return this.fromCache(cached, false);
        }
        const validators =
            cached && (cached.headers.etag || cached.headers['last-modified'])
                ? {
                      ...(cached.headers.etag ? { 'if-none-match': cached.headers.etag } : {}),
                      ...(cached.headers['last-modified']
                          ? { 'if-modified-since': cached.headers['last-modified'] }
                          : {}),
                  }
                : undefined;
        const timeout = AbortSignal.timeout(this.settings.timeoutMs);
        const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
        let current = url;
        for (let redirects = 0; ; redirects++) {
            const host = current.host.toLowerCase();
            const stop = this.stops.get(host);
            if (stop && stop.until > this.now()) {
                audit(current, 'host_stopped');
                return {
                    ok: false,
                    reason: 'host_stopped',
                    message: `${host} refused an earlier read (HTTP ${stop.status}), so Socio agents are not reading from it for another ${duration(stop.until - this.now())}. Don't retry it or reach it another way; tell the user the site declined.`,
                    retryAfterSeconds: Math.ceil((stop.until - this.now()) / 1000),
                };
            }
            const limited = this.take(request.dotId, host);
            if (limited) {
                audit(current, 'rate_limited');
                return {
                    ok: false,
                    reason: 'rate_limited',
                    message: limited.message,
                    retryAfterSeconds: Math.ceil(limited.waitMs / 1000),
                };
            }
            let pinned: { address: string; family: number };
            try {
                pinned = await this.resolve(current);
            } catch (error) {
                audit(current, 'blocked');
                return { ok: false, reason: 'blocked', message: messageOf(error) };
            }
            let response: Fetched;
            try {
                response = await this.fetchOnce(
                    current,
                    pinned,
                    method,
                    { ...headers, ...(redirects === 0 ? validators : undefined) },
                    signal,
                );
            } catch (error) {
                const timedOut = timeout.aborted;
                audit(current, timedOut ? 'timeout' : 'failed');
                return timedOut
                    ? {
                          ok: false,
                          reason: 'timeout',
                          message: `The read timed out after ${duration(this.settings.timeoutMs)}.`,
                      }
                    : {
                          ok: false,
                          reason: 'failed',
                          message: `The read failed: ${messageOf(error)}`,
                      };
            }
            const location = header(response.headers, 'location');
            if ([301, 302, 303, 307, 308].includes(response.status) && location) {
                audit(current, 'redirect', response.status);
                if (redirects >= MAX_REDIRECTS) {
                    return {
                        ok: false,
                        reason: 'failed',
                        message: `Too many redirects (more than ${MAX_REDIRECTS}).`,
                    };
                }
                try {
                    current = new URL(location, current);
                } catch {
                    return {
                        ok: false,
                        reason: 'failed',
                        message: 'The site redirected to an invalid URL.',
                    };
                }
                current.hash = '';
                if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password) {
                    audit(current, 'blocked');
                    return {
                        ok: false,
                        reason: 'blocked',
                        message: 'The site redirected to a URL that is not public HTTP(S).',
                    };
                }
                continue;
            }
            if (response.status === 304 && redirects === 0 && cached) {
                // A 304 updates validators and freshness, not the body's own headers.
                const kept = keptHeaders(response.headers);
                delete kept['content-type'];
                delete kept['content-length'];
                cached.headers = { ...cached.headers, ...kept };
                cached.expiresAt = this.now() + (freshness(cached.headers, this.settings.cacheTtlMs) ?? 0);
                audit(current, 'revalidated', 304);
                return this.fromCache(cached, true);
            }
            const notice = this.refused(host, response);
            audit(current, notice ? 'refused' : 'fetched', response.status, response.body.length);
            const kept = keptHeaders(response.headers);
            if (cacheable && response.status === 200 && response.complete) {
                const ttl = freshness(kept, this.settings.cacheTtlMs);
                if (ttl !== undefined && (ttl > 0 || kept.etag || kept['last-modified'])) {
                    this.remember(key, {
                        url: current.href,
                        status: response.status,
                        headers: kept,
                        body: response.body,
                        expiresAt: this.now() + ttl,
                        redirects,
                    });
                }
            }
            const length = Number(kept['content-length']);
            return {
                ok: true,
                status: response.status,
                url: current.href,
                contentType: kept['content-type'] ?? '',
                ...(Number.isFinite(length) && kept['content-length'] ? { contentLength: length } : {}),
                headers: kept,
                body: response.body,
                bytes: response.body.length,
                complete: response.complete,
                cached: false,
                revalidated: false,
                redirects,
                ...(notice ? { notice } : {}),
            };
        }
    }

    private fromCache(entry: CacheEntry, revalidated: boolean): WebResponse {
        const length = Number(entry.headers['content-length']);
        return {
            ok: true,
            status: entry.status,
            url: entry.url,
            contentType: entry.headers['content-type'] ?? '',
            ...(Number.isFinite(length) && entry.headers['content-length'] ? { contentLength: length } : {}),
            headers: entry.headers,
            body: entry.body,
            bytes: entry.body.length,
            complete: true,
            cached: true,
            revalidated,
            redirects: entry.redirects,
        };
    }

    private remember(key: string, entry: CacheEntry) {
        const previous = this.cache.get(key);
        if (previous) {
            this.cacheBytes -= previous.body.length;
            this.cache.delete(key);
        }
        if (entry.body.length > CACHE_BYTES / 4) {
            return;
        }
        this.cache.set(key, entry);
        this.cacheBytes += entry.body.length;
        // Oldest first: Map keeps insertion order.
        for (const [oldest, value] of this.cache) {
            if (this.cache.size <= CACHE_ENTRIES && this.cacheBytes <= CACHE_BYTES) {
                break;
            }
            this.cache.delete(oldest);
            this.cacheBytes -= value.body.length;
        }
    }

    /**
     * A 429 or 403 (or a 503 with Retry-After) stops reads from the host,
     * for every Dot, for Retry-After or the cooldown.
     */
    private refused(host: string, response: Fetched) {
        const after = retryAfterMs(header(response.headers, 'retry-after'), this.now());
        if (response.status !== 429 && response.status !== 403 && !(response.status === 503 && after !== undefined)) {
            return undefined;
        }
        const ms = Math.min(Math.max(after ?? this.settings.cooldownMs, 1000), 86_400_000);
        this.stops.set(host, { until: this.now() + ms, status: response.status });
        return `${host} refused this read (HTTP ${response.status}). Socio agents back off when a site refuses: reads from ${host} are paused for ${duration(ms)}. Don't retry it or reach it another way; tell the user the site declined.`;
    }

    /** Takes a token from the Dot's bucket for the host and the global one. */
    private take(dotId: string, host: string) {
        const now = this.now();
        const local = this.refill(`${dotId}\n${host}`, this.settings.perHostPerMinute, now);
        const global = this.refill('*', this.settings.globalPerMinute, now);
        if (local.tokens < 1) {
            return {
                waitMs: ((1 - local.tokens) * 60_000) / this.settings.perHostPerMinute,
                message: `Rate limit: this socio reads at most ${this.settings.perHostPerMinute} times a minute from ${host}. Wait before reading from it again.`,
            };
        }
        if (global.tokens < 1) {
            return {
                waitMs: ((1 - global.tokens) * 60_000) / this.settings.globalPerMinute,
                message: `Rate limit: Socio's agents read at most ${this.settings.globalPerMinute} times a minute in all. Wait before reading again.`,
            };
        }
        local.tokens -= 1;
        global.tokens -= 1;
        return undefined;
    }
    private refill(key: string, perMinute: number, now: number) {
        let bucket = this.buckets.get(key);
        if (!bucket) {
            // Full buckets carry no state: forget them before the map grows.
            if (this.buckets.size > 10_000) {
                for (const [name, entry] of this.buckets) {
                    if (entry.tokens + ((now - entry.at) * perMinute) / 60_000 >= perMinute) {
                        this.buckets.delete(name);
                    }
                }
            }
            bucket = { tokens: perMinute, at: now };
            this.buckets.set(key, bucket);
        }
        bucket.tokens = Math.min(perMinute, bucket.tokens + ((now - bucket.at) * perMinute) / 60_000);
        bucket.at = now;
        return bucket;
    }

    /** One request, DNS-pinned to `pinned`, its body capped at `maxBytes`. */
    private fetchOnce(
        url: URL,
        pinned: { address: string; family: number },
        method: 'GET' | 'HEAD',
        headers: Record<string, string>,
        signal: AbortSignal,
    ): Promise<Fetched> {
        const max = this.settings.maxBytes;
        return new Promise((resolve, reject) => {
            let done = false;
            const finish = (result: Fetched | Error) => {
                if (done) {
                    return;
                }
                done = true;
                if (result instanceof Error) {
                    reject(result);
                } else {
                    resolve(result);
                }
            };
            const transport = url.protocol === 'https:' ? https : http;
            const request = transport.request(
                url,
                {
                    method,
                    signal,
                    agent: false,
                    // The whole of what a site learns about the requester.
                    headers: {
                        'user-agent': this.settings.userAgent,
                        accept: headers.accept ?? DEFAULT_ACCEPT,
                        'accept-encoding': 'gzip, deflate, br',
                        ...headers,
                    },
                    lookup: (_hostname, options, callback) => {
                        if (options.all) {
                            callback(null, [pinned]);
                        } else {
                            callback(null, pinned.address, pinned.family);
                        }
                    },
                },
                (response: IncomingMessage) => {
                    const status = response.statusCode ?? 502;
                    if (method === 'HEAD' || (status >= 300 && status < 400)) {
                        response.resume();
                        return finish({
                            status,
                            headers: response.headers,
                            body: Buffer.alloc(0),
                            complete: true,
                        });
                    }
                    const encoding = header(response.headers, 'content-encoding')?.trim().toLowerCase();
                    let stream: Readable = response;
                    if (encoding === 'gzip' || encoding === 'x-gzip') {
                        stream = response.pipe(createGunzip());
                    } else if (encoding === 'deflate') {
                        stream = response.pipe(createInflate());
                    } else if (encoding === 'br') {
                        stream = response.pipe(createBrotliDecompress());
                    }
                    const chunks: Buffer[] = [];
                    let size = 0;
                    const result = (complete: boolean) => ({
                        status,
                        headers: response.headers,
                        body: Buffer.concat(chunks),
                        complete,
                    });
                    stream.on('data', (chunk: Buffer) => {
                        if (done) {
                            return;
                        }
                        if (size + chunk.length > max) {
                            chunks.push(chunk.subarray(0, max - size));
                            size = max;
                            finish(result(false));
                            response.destroy();
                            if (stream !== response) {
                                stream.destroy();
                            }
                            return;
                        }
                        chunks.push(chunk);
                        size += chunk.length;
                    });
                    stream.on('end', () => finish(result(true)));
                    stream.on('error', (error) => finish(error));
                    response.on('error', (error) => finish(error));
                },
            );
            request.on('error', (error) => finish(error));
            request.end();
        });
    }
}

function keptHeaders(headers: IncomingHttpHeaders) {
    const kept: Record<string, string> = {};
    for (const name of KEPT_HEADERS) {
        const value = header(headers, name);
        if (value) {
            kept[name] = value;
        }
    }
    return kept;
}

function messageOf(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}
