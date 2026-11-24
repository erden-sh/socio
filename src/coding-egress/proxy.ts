import { lookup as dnsLookup } from 'node:dns/promises';
import {
    createServer,
    request as httpRequest,
    type IncomingHttpHeaders,
    type IncomingMessage,
    type OutgoingHttpHeaders,
    type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

import {
    deriveKey,
    egressCredentialKey,
    gatewayStampKey,
    sameMac,
    signGatewayStamp,
    verifyEgressCredential,
} from '@socio/foundation/actors/keys';

import { egressProxy, hostOf, inSubnet, shown, type EgressTenant } from '../egress/proxy.js';
import { isPublicAddress } from '../net/public-address.js';

import {
    GATEWAY_HOST,
    readRegistryEntry,
    REGISTRY_DOMAIN,
    registryVirtualHost,
    type CodingRegistry,
} from './registries.js';

/**
 * The coding egress proxy (CB-239): a coding sandbox's only way out. A
 * sandbox's network is internal and has no DNS; its `HTTP(S)_PROXY` names
 * this proxy by address, with a credential Socio signed naming the sandbox,
 * its registries, its network's subnet and an expiry.
 *
 * - `gateway.socio.internal` (plain HTTP): forwarded to Socio's internal
 *   gateway listener with every client `x-cb-*` header removed and a signed
 *   `x-cb-sandbox` stamp naming the sandbox.
 * - `<name>.registry.socio.internal`: the sandbox's registries, `GET` and
 *   `HEAD` only, forwarded over TLS to the real host (public addresses
 *   only), with only a short list of request headers passed on, so a pasted
 *   token authenticates nothing and nothing can be published; links to the
 *   registries in JSON and HTML answers are rewritten to the virtual hosts.
 * - CONNECT: refused for every host. Everything else: 403, logged as the
 *   sandbox id and `host:port` only, and counted per sandbox and target.
 *
 * Stateless apart from the denial counts and the log sampling, which are
 * diagnostics: a restart loses them and grants nothing.
 */

/** A sandbox, as its credential names it. */
export interface CodingTenant extends EgressTenant {
    sandboxId: string;
    subnet: string;
    /** Virtual host → registry. */
    registries: ReadonlyMap<string, CodingRegistry>;
}

/** Reads and checks a sandbox's proxy credential (`Proxy-Authorization`). */
export function codingTenant(
    secret: string,
    now: () => number = Date.now,
): (request: IncomingMessage) => CodingTenant | undefined {
    const key = egressCredentialKey(secret);
    return (request) => {
        const match = /^Basic\s+([A-Za-z0-9+/=]{1,8192})$/.exec(
            String(request.headers['proxy-authorization'] ?? '').trim(),
        );
        if (!match) {
            return undefined;
        }
        const decoded = Buffer.from(match[1], 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        if (colon < 1) {
            return undefined;
        }
        const claims = verifyEgressCredential(key, decoded.slice(0, colon), decoded.slice(colon + 1), now());
        if (!claims) {
            return undefined;
        }
        const registries = new Map<string, CodingRegistry>();
        for (const entry of claims.allow) {
            const registry = readRegistryEntry(entry);
            if (registry) {
                registries.set(registryVirtualHost(registry.name), registry);
            }
        }
        return {
            sandboxId: claims.sandboxId,
            label: claims.sandboxId,
            subnet: claims.subnet,
            allow: new Set(),
            registries,
        };
    };
}

interface DenialEntry {
    target: string;
    count: number;
    firstAt: number;
    lastAt: number;
}

/**
 * Denials per sandbox and target, for the session's diagnostics.
 *
 * Bounded without letting one sandbox erase evidence: each sandbox lists at
 * most `perSandbox` targets, its earliest ones, and counts denials to
 * further targets in `overflow`, so a sandbox spraying unique hosts can't
 * push out its own first denial (an exfiltration attempt, say) or anyone
 * else's. Past `limit` listed targets
 * in all, whole sandboxes go, least recently denied first.
 */
export class DenialLog {
    private readonly sandboxes = new Map<
        string,
        { targets: Map<string, DenialEntry>; overflow: number; lastAt: number }
    >();
    private size = 0;
    constructor(
        private readonly limit = 10_000,
        private readonly now: () => number = Date.now,
        private readonly perSandbox = 256,
    ) {}

    /** True when this is the sandbox's first listed denial for the target. */
    record(sandboxId: string, target: string) {
        const at = this.now();
        let sandbox = this.sandboxes.get(sandboxId);
        if (!sandbox) {
            sandbox = { targets: new Map(), overflow: 0, lastAt: at };
            this.sandboxes.set(sandboxId, sandbox);
        }
        sandbox.lastAt = at;
        const entry = sandbox.targets.get(target);
        if (entry) {
            entry.count += 1;
            entry.lastAt = at;
            return false;
        }
        if (sandbox.targets.size >= this.perSandbox) {
            sandbox.overflow += 1;
            return false;
        }
        while (this.size >= this.limit && this.evictOther(sandboxId)) {}
        if (this.size >= this.limit) {
            sandbox.overflow += 1;
            return false;
        }
        sandbox.targets.set(target, { target, count: 1, firstAt: at, lastAt: at });
        this.size += 1;
        return true;
    }

    /** Drops the least recently denied sandbox other than `keep`. */
    private evictOther(keep: string) {
        let oldest: string | undefined;
        let oldestAt = Infinity;
        for (const [id, sandbox] of this.sandboxes) {
            if (id !== keep && sandbox.lastAt < oldestAt) {
                oldest = id;
                oldestAt = sandbox.lastAt;
            }
        }
        if (oldest === undefined) {
            return false;
        }
        this.size -= this.sandboxes.get(oldest)?.targets.size ?? 0;
        this.sandboxes.delete(oldest);
        return true;
    }

    forSandbox(sandboxId: string) {
        return [...(this.sandboxes.get(sandboxId)?.targets.values() ?? [])].map(
            ({ target, count, firstAt, lastAt }) => ({
                target,
                count,
                firstAt,
                lastAt,
            }),
        );
    }

    /** Denials to targets past the sandbox's listed ones. */
    overflow(sandboxId: string) {
        return this.sandboxes.get(sandboxId)?.overflow ?? 0;
    }
}

/** The bearer token Socio sends to the proxy's diagnostics listener. */
export const diagnosticsToken = (secret: string) =>
    deriveKey(secret, 'coding-egress-diagnostics').toString('base64url');

const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authorization',
    'proxy-authenticate',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'host',
]);

/** Headers minus hop-by-hop ones (and those `Connection` names). */
function withoutHopByHop(headers: IncomingHttpHeaders) {
    const named = new Set(
        String(headers.connection ?? '')
            .toLowerCase()
            .split(',')
            .map((token) => token.trim())
            .filter(Boolean),
    );
    const out: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
        const lower = name.toLowerCase();
        if (value === undefined || HOP_BY_HOP.has(lower) || named.has(lower)) {
            continue;
        }
        out[lower] = value;
    }
    return out;
}

/** What reaches the gateway: no client identity or forwarding headers. */
function gatewayRequestHeaders(headers: IncomingHttpHeaders) {
    const out = withoutHopByHop(headers);
    for (const name of Object.keys(out)) {
        if (
            name.startsWith('x-cb-') ||
            name.startsWith('x-forwarded-') ||
            name === 'forwarded' ||
            name === 'x-real-ip' ||
            name === 'via' ||
            name === 'cookie'
        ) {
            delete out[name];
        }
    }
    return out;
}

/**
 * The only request headers a registry gets (rather than stripping
 * `Authorization`, `Cookie` and `x-*`, this passes a short list, so package
 * managers' session and command headers carry nothing out either).
 */
const REGISTRY_REQUEST_HEADERS = [
    'accept',
    'accept-encoding',
    'if-none-match',
    'if-modified-since',
    'if-range',
    'range',
    'cache-control',
    'pragma',
];

export const REGISTRY_USER_AGENT = 'socio-coding-egress/1';

function registryRequestHeaders(headers: IncomingHttpHeaders, host: string) {
    const out: OutgoingHttpHeaders = { host, 'user-agent': REGISTRY_USER_AGENT };
    for (const name of REGISTRY_REQUEST_HEADERS) {
        if (headers[name] !== undefined) {
            out[name] = headers[name];
        }
    }
    return out;
}

function responseHeaders(headers: IncomingHttpHeaders) {
    const out = withoutHopByHop(headers);
    delete out['set-cookie'];
    delete out['alt-svc'];
    return out;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Points every `https://<registry host>` link in a text at its virtual host
 * (`http://<name>.registry.socio.internal`), in plain and JSON-escaped
 * (`https:\/\/`) form: PyPI's file links and npm's tarball URLs then come
 * back through this proxy.
 */
export function rewriteRegistryLinks(text: string, registries: Iterable<CodingRegistry>) {
    let out = text;
    for (const registry of registries) {
        const pattern = new RegExp(
            `https:(\\\\?/\\\\?/)${escapeRegExp(registry.host)}(?::443)?(?=[/\\\\"'?#<>\\s]|$)`,
            'gi',
        );
        out = out.replace(pattern, (_whole, slashes: string) => `http:${slashes}${registryVirtualHost(registry.name)}`);
    }
    return out;
}

const REWRITABLE = /json|html/i;

/**
 * The decoded body, or undefined for an encoding this proxy can't read.
 * Throws when the decoded body would pass `max` bytes: a small compressed
 * answer must not inflate past the rewrite limit, blocking the event loop
 * and the proxy's memory.
 */
function decode(body: Buffer, encoding: string | undefined, max: number) {
    const bounded = { maxOutputLength: max };
    switch ((encoding ?? 'identity').trim().toLowerCase()) {
        case 'identity':
        case '':
            return body;
        case 'gzip':
        case 'x-gzip':
            return gunzipSync(body, bounded);
        case 'deflate':
            return inflateSync(body, bounded);
        case 'br':
            return brotliDecompressSync(body, bounded);
        default:
            return undefined;
    }
}

export interface CodingEgressOptions {
    /** `CODING_EGRESS_SECRET`: the credential and stamp keys' source. */
    secret: string;
    /** Socio's internal gateway listener, `http://host:port`. */
    gatewayUpstream: string;
    log?: (line: string) => void;
    /** The registries' name resolution and address check (tests replace them). */
    lookup?: (host: string) => Promise<Array<{ address: string }>>;
    isPublic?: (address: string) => boolean;
    /** The registries' TLS port (443; tests use a loopback one). */
    registryPort?: number;
    /** Extra TLS options for registry connections (tests: a loopback CA). */
    registryTls?: { ca?: string; checkServerIdentity?: () => undefined };
    /** Largest JSON or HTML answer rewritten in memory (default 128 MB). */
    maxRewriteBytes?: number;
    denials?: DenialLog;
    now?: () => number;
}

/** The proxy's HTTP server; listen on it (3128 in the stack). */
export function codingEgressProxy(options: CodingEgressOptions) {
    const log = options.log ?? ((line: string) => console.log(line));
    const now = options.now ?? Date.now;
    const denials = options.denials ?? new DenialLog(undefined, now);
    const stampKey = gatewayStampKey(options.secret);
    const upstream = new URL(options.gatewayUpstream);
    if (upstream.protocol !== 'http:' || upstream.pathname !== '/') {
        throw new Error('CODING_GATEWAY_UPSTREAM must be http://host:port (the internal gateway listener).');
    }
    const resolve = options.lookup ?? ((name: string) => dnsLookup(name, { all: true }));
    const isPublic = options.isPublic ?? isPublicAddress;
    const maxRewrite = options.maxRewriteBytes ?? 128 * 1024 * 1024;
    const sampled = new Map<string, number>();
    // The gateway refuses a stamp it has seen (CB-239), so two requests
    // of one sandbox in the same millisecond get distinct times.
    const lastStamp = new Map<string, number>();
    const stampTime = (sandboxId: string) => {
        const at = Math.max(now(), (lastStamp.get(sandboxId) ?? 0) + 1);
        if (lastStamp.size > 10_000) {
            lastStamp.clear();
        }
        lastStamp.set(sandboxId, at);
        return at;
    };

    const allowed = (method: string, target: string, tenant: CodingTenant) => {
        // One line per sandbox, target and minute: an install makes thousands.
        const key = `${tenant.sandboxId}\n${target}`;
        const minute = Math.floor(now() / 60_000);
        if (sampled.get(key) === minute) {
            return;
        }
        if (sampled.size > 10_000) {
            sampled.clear();
        }
        sampled.set(key, minute);
        log(`coding-egress: allowed ${shown(method)} ${target} for ${tenant.sandboxId}`);
    };

    const deny = (
        response: ServerResponse,
        method: string,
        target: string,
        tenant: CodingTenant | undefined,
        why = '',
    ) => {
        log(`coding-egress: denied ${shown(method)} ${target}${tenant ? ` for ${tenant.sandboxId}` : ''}${why}`);
        if (tenant) {
            denials.record(tenant.sandboxId, target);
        }
        response
            .writeHead(403, { 'content-type': 'text/plain', connection: 'close' })
            .end("Socio's coding sandbox reaches only its gateway and read-only package registries.\n");
    };

    const failed = (response: ServerResponse, status: number) => {
        if (response.headersSent) {
            response.destroy();
        } else {
            response
                .writeHead(status, {
                    'content-type': 'text/plain',
                    connection: 'close',
                })
                .end(status === 504 ? 'Upstream timed out.\n' : 'Upstream unavailable.\n');
        }
    };

    const toGateway = (request: IncomingMessage, response: ServerResponse, tenant: CodingTenant, url: URL) => {
        const method = request.method ?? 'GET';
        const target = `${GATEWAY_HOST}:80`;
        if (!['GET', 'HEAD', 'POST'].includes(method)) {
            return deny(response, method, target, tenant);
        }
        // The stamp covers the exact request-target sent upstream.
        const path = `${url.pathname}${url.search}`;
        const headers = gatewayRequestHeaders(request.headers);
        headers.host = GATEWAY_HOST;
        headers['x-cb-sandbox'] = signGatewayStamp(
            stampKey,
            tenant.sandboxId,
            method,
            path,
            stampTime(tenant.sandboxId),
        );
        allowed(method, target, tenant);
        const outgoing = httpRequest({
            hostname: upstream.hostname,
            port: upstream.port || 80,
            method,
            path,
            headers,
        });
        outgoing.setTimeout(5 * 60_000, () => outgoing.destroy(new Error('idle')));
        outgoing.on('response', (answer) => {
            response.writeHead(answer.statusCode ?? 502, responseHeaders(answer.headers));
            answer.pipe(response);
            answer.on('error', () => response.destroy());
        });
        outgoing.on('error', () => failed(response, 502));
        // A client that goes away aborts the model or Git request upstream.
        response.on('close', () => {
            if (!response.writableFinished) {
                outgoing.destroy();
            }
        });
        request.pipe(outgoing);
    };

    const toRegistry = async (
        request: IncomingMessage,
        response: ServerResponse,
        tenant: CodingTenant,
        url: URL,
        registry: CodingRegistry,
    ) => {
        const method = request.method ?? 'GET';
        const target = `${url.hostname}:80`;
        // Download only: a publish is a PUT, an upload a POST.
        if (method !== 'GET' && method !== 'HEAD') {
            return deny(response, method, target, tenant, ' (read-only)');
        }
        if (Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding'] !== undefined) {
            return deny(response, method, target, tenant, ' (body)');
        }
        const addresses = isIP(registry.host)
            ? [{ address: registry.host }]
            : await resolve(registry.host).catch(() => []);
        if (!addresses.length || addresses.some((entry) => !isPublic(entry.address))) {
            return deny(response, method, target, tenant, ' (not public)');
        }
        if (response.destroyed) {
            return;
        }
        allowed(method, target, tenant);
        const outgoing = httpsRequest({
            host: addresses[0].address,
            servername: registry.host,
            port: options.registryPort ?? 443,
            method,
            path: `${url.pathname}${url.search}`,
            headers: registryRequestHeaders(request.headers, registry.host),
            ...options.registryTls,
        });
        outgoing.setTimeout(60_000, () => outgoing.destroy(new Error('idle')));
        outgoing.on('error', () => failed(response, 502));
        response.on('close', () => {
            if (!response.writableFinished) {
                outgoing.destroy();
            }
        });
        outgoing.on('response', (answer) => {
            const headers = responseHeaders(answer.headers);
            if (typeof headers.location === 'string') {
                headers.location = rewriteRegistryLinks(headers.location, tenant.registries.values());
            }
            const type = String(answer.headers['content-type'] ?? '');
            const length = Number(answer.headers['content-length'] ?? 0);
            if (method !== 'GET' || answer.statusCode !== 200 || !REWRITABLE.test(type) || length > maxRewrite) {
                response.writeHead(answer.statusCode ?? 502, headers);
                answer.pipe(response);
                answer.on('error', () => response.destroy());
                return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            answer.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > maxRewrite) {
                    answer.destroy();
                    failed(response, 502);
                    return;
                }
                chunks.push(chunk);
            });
            answer.on('error', () => failed(response, 502));
            answer.on('end', () => {
                if (response.headersSent || response.destroyed) {
                    return;
                }
                let body: Buffer | undefined;
                try {
                    body = decode(Buffer.concat(chunks), answer.headers['content-encoding'], maxRewrite);
                } catch {
                    return failed(response, 502);
                }
                if (!body) {
                    // An encoding this proxy can't read: passed on as it came.
                    response.writeHead(200, headers).end(Buffer.concat(chunks));
                    return;
                }
                const rewritten = Buffer.from(rewriteRegistryLinks(body.toString('utf8'), tenant.registries.values()));
                delete headers['content-encoding'];
                headers['content-length'] = String(rewritten.length);
                response.writeHead(200, headers).end(rewritten);
            });
        });
        outgoing.end();
    };

    return egressProxy<CodingTenant>({
        allow: [],
        name: 'coding-egress',
        connect: false,
        log,
        tenant: codingTenant(options.secret, now),
        onDenied: (target, tenant) => {
            if (tenant) {
                denials.record(tenant.sandboxId, target);
            }
        },
        forward: (request, response, tenant) => {
            const method = request.method ?? '?';
            const target = shown(hostOf(request.url));
            if (!tenant) {
                return deny(response, method, target, undefined);
            }
            let url: URL;
            try {
                url = new URL(request.url ?? '');
            } catch {
                return deny(response, method, target, tenant, ' (not absolute)');
            }
            if (
                url.protocol !== 'http:' ||
                url.username ||
                url.password ||
                (url.port !== '' && url.port !== '80') ||
                request.headers.upgrade !== undefined
            ) {
                return deny(response, method, target, tenant);
            }
            const host = url.hostname.toLowerCase();
            if (host === GATEWAY_HOST) {
                return toGateway(request, response, tenant, url);
            }
            const registry = host.endsWith(`.${REGISTRY_DOMAIN}`) ? tenant.registries.get(host) : undefined;
            if (!registry) {
                return deny(response, method, target, tenant);
            }
            void toRegistry(request, response, tenant, url, registry).catch(() => failed(response, 502));
        },
    });
}

/**
 * The proxy's diagnostics listener (its own port): Socio reads a sandbox's
 * denial counts for `coding_status` and records the first denial per
 * session and host in `actor_audit`.
 * `GET /denials/<sandboxId>` with `Authorization: Bearer
 * <diagnosticsToken(secret)>` answers `{ sandboxId, denials, overflow }`,
 * `overflow` counting denials to targets past the listed ones.
 *
 * The proxy joins every sandbox's network, so its bind address reaches
 * them all: a connection from outside `subnet` (the gateway network's,
 * `CODING_EGRESS_DIAGNOSTICS_SUBNET`) is closed before anything is read,
 * and without a subnet every connection is, behind the bearer token.
 */
export function codingEgressDiagnostics(
    secret: string,
    denials: DenialLog,
    options: { subnet?: string; log?: (line: string) => void } = {},
) {
    const { subnet } = options;
    // A well-formed CIDR contains its own base address.
    if (subnet !== undefined && !inSubnet(subnet.split('/')[0], subnet)) {
        throw new Error('CODING_EGRESS_DIAGNOSTICS_SUBNET must be an IPv4 subnet, e.g. 172.30.0.0/24.');
    }
    if (subnet === undefined) {
        (options.log ?? console.log)(
            'coding-egress: CODING_EGRESS_DIAGNOSTICS_SUBNET is not set, so the diagnostics listener refuses every connection.',
        );
    }
    const token = diagnosticsToken(secret);
    const server = createServer((request, response) => {
        if (request.url === '/healthz') {
            response.end('ok');
            return;
        }
        const given = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(String(request.headers.authorization ?? ''))?.[1];
        if (!given || !sameMac(given, token)) {
            response.writeHead(401).end();
            return;
        }
        const match = /^\/denials\/([A-Za-z0-9_-]{1,64})$/.exec(request.url ?? '');
        if (request.method !== 'GET' || !match) {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
                sandboxId: match[1],
                denials: denials.forSandbox(match[1]),
                overflow: denials.overflow(match[1]),
            }),
        );
    });
    server.on('connection', (socket) => {
        if (!subnet || !inSubnet(socket.remoteAddress ?? '', subnet)) {
            socket.destroy();
        }
    });
    return server;
}
