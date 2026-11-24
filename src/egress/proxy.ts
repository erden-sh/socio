import { lookup } from 'node:dns/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';

import { isPublicAddress } from '../net/public-address.js';

/** `host:port`, a DNS name or a bracketed IPv6 address. */
const TARGET = /^(?:([a-z0-9](?:[a-z0-9-]{0,62}\.)*[a-z0-9-]{1,63})|\[([0-9a-f:.]+)\]):(\d{1,5})$/;

/** `api.anthropic.com:443,api.openai.com:443` → normalized entries. */
export function parseAllowlist(raw: string | undefined) {
    const entries = (raw ?? '')
        .split(/[\s,]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
    for (const entry of entries) {
        if (!TARGET.test(entry)) {
            throw new Error(`EGRESS_ALLOW: "${entry}" is not host:port.`);
        }
    }
    return entries;
}

/** A target for the log: only host and port, never longer than a name. */
export const shown = (target: string) => target.replace(/[^a-z0-9.:[\]-]/gi, '?').slice(0, 270) || '(none)';

export function hostOf(url: string | undefined) {
    try {
        const parsed = new URL(url ?? '');
        return `${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? 443 : 80)}`;
    } catch {
        return '(not a URL)';
    }
}

/** Who is asking and what they may reach (the apps' egress). */
export interface EgressTenant {
    allow: ReadonlySet<string>;
    /** Named in the log (an app id or a sandbox id; never a person). */
    label: string;
    /**
     * The IPv4 network the credential is bound to, in CIDR form: a request
     * from any other source address is refused, so a credential copied out
     * of a coding sandbox is useless elsewhere (CB-239).
     */
    subnet?: string;
}

const ipv4Number = (address: string) => {
    const parts = address.split('.');
    if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) {
        return undefined;
    }
    const numbers = parts.map(Number);
    if (numbers.some((part) => part > 255)) {
        return undefined;
    }
    return numbers.reduce((total, part) => total * 256 + part, 0);
};

/** Whether an IPv4 address (or its IPv4-mapped IPv6 form) is in a CIDR. */
export function inSubnet(address: string, cidr: string) {
    const match = /^([\d.]+)\/(\d{1,2})$/.exec(cidr);
    const plain = address.replace(/^::ffff:/i, '');
    const host = ipv4Number(plain);
    const base = match ? ipv4Number(match[1]) : undefined;
    const bits = match ? Number(match[2]) : NaN;
    if (host === undefined || base === undefined || !(bits >= 0 && bits <= 32)) {
        return false;
    }
    const size = 2 ** (32 - bits);
    return Math.floor(host / size) === Math.floor(base / size);
}

/**
 * A way out for workloads that may reach only some hosts: a forward proxy
 * that opens CONNECT
 * tunnels to the allowlisted `host:port` entries and refuses everything
 * else, plain HTTP proxying included. It logs the target of every request
 * (allowed or denied) and nothing else: no headers, no bodies, no client
 * addresses. TLS stays end to end; the proxy never sees the traffic.
 *
 * Promoted mini apps share one proxy: `tenant` reads each CONNECT's
 * credentials and gives that app's own allowlist (no credentials, or bad
 * ones: 407). `publicOnly` resolves the name first and refuses private and
 * special addresses, then connects to the address it checked.
 *
 * The coding egress proxy (CB-239) builds on the same server with
 * `connect: false` (no tunnels at all), tenants bound to their sandbox's
 * subnet, and `forward`, which serves absolute-form plain HTTP requests
 * (the gateway route and the read-only registry virtual hosts,
 * src/coding-egress/proxy.ts) once the tenant is known.
 */
export function egressProxy<T extends EgressTenant = EgressTenant>(options: {
    allow: string[];
    log?: (line: string) => void;
    tenant?: (request: IncomingMessage) => T | undefined;
    publicOnly?: boolean;
    /** Name resolution and the address check of `publicOnly` (tests replace them). */
    lookup?: (host: string) => Promise<Array<{ address: string }>>;
    isPublic?: (address: string) => boolean;
    /** Whether CONNECT tunnels are opened at all (default true). */
    connect?: boolean;
    /**
     * Serves plain (absolute-form) HTTP requests after the tenant check;
     * without it every plain request is refused, as before.
     */
    forward?: (request: IncomingMessage, response: ServerResponse, tenant: T | undefined) => void;
    /** Each denial's target (`host:port`) and tenant, for diagnostics. */
    onDenied?: (target: string, tenant: T | undefined) => void;
    /** The log lines' prefix (default `egress-proxy`). */
    name?: string;
}) {
    const allow = new Set(options.allow);
    const log = options.log ?? ((line: string) => console.log(line));
    const name = options.name ?? 'egress-proxy';
    /** The tenant, or the refusal: 407 without credentials, 403 off-network. */
    const identify = (request: IncomingMessage): { tenant?: T; refusal?: 403 | 407 } => {
        if (!options.tenant) {
            return {};
        }
        const tenant = options.tenant(request);
        if (!tenant) {
            return { refusal: 407 };
        }
        if (tenant.subnet !== undefined && !inSubnet(request.socket.remoteAddress ?? '', tenant.subnet)) {
            return { tenant, refusal: 403 };
        }
        return { tenant };
    };
    const denied = (target: string, tenant: T | undefined, why = '') => {
        log(`${name}: denied ${target}${tenant ? ` for ${shown(tenant.label)}` : ''}${why}`);
    };
    const server = createServer((request, response) => {
        if (request.url === '/healthz') {
            response.end('ok');
            return;
        }
        const method = shown(request.method ?? '?');
        const target = shown(hostOf(request.url));
        if (options.forward) {
            const { tenant, refusal } = identify(request);
            if (refusal === 407) {
                denied(`${method} ${target}`, undefined, ' (no credentials)');
                response
                    .writeHead(407, {
                        'Proxy-Authenticate': 'Basic realm="coding"',
                        Connection: 'close',
                    })
                    .end();
                return;
            }
            if (refusal === 403) {
                denied(`${method} ${target}`, tenant, ' (wrong network)');
                options.onDenied?.(target, tenant);
                response.writeHead(403, { Connection: 'close' }).end();
                return;
            }
            options.forward(request, response, tenant);
            return;
        }
        log(`${name}: denied ${method} ${target}`);
        response.writeHead(403, { Connection: 'close' }).end();
    });
    server.on('connect', (request, client: Socket, head: Buffer) => {
        // A client that resets while it is refused must not take the proxy down.
        client.on('error', () => client.destroy());
        const target = (request.url ?? '').toLowerCase();
        const match = TARGET.exec(target);
        let allowed: ReadonlySet<string> = allow;
        let who = '';
        let tenant: T | undefined;
        if (options.tenant) {
            const identified = identify(request);
            tenant = identified.tenant;
            if (identified.refusal === 407) {
                log(`${name}: denied CONNECT ${shown(target)} (no credentials)`);
                client.end(
                    'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="apps"\r\nConnection: close\r\n\r\n',
                );
                return;
            }
            who = ` for ${shown(identified.tenant!.label)}`;
            if (identified.refusal === 403) {
                log(`${name}: denied CONNECT ${shown(target)}${who} (wrong network)`);
                options.onDenied?.(shown(target), tenant);
                client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
                return;
            }
            allowed = identified.tenant!.allow;
        }
        // No tunnels at all (the coding egress proxy): a tunnel to an
        // allowed registry would carry a publish as well.
        if (options.connect === false || !match || !allowed.has(target)) {
            log(`${name}: denied CONNECT ${shown(target)}${who}`);
            options.onDenied?.(shown(target), tenant);
            client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            return;
        }
        const host = match[1] ?? match[2];
        const port = Number(match[3]);
        if (!options.publicOnly) {
            log(`${name}: allowed CONNECT ${target}${who}`);
            tunnel(client, head, host, port);
            return;
        }
        void (async () => {
            const resolve = options.lookup ?? ((name: string) => lookup(name, { all: true }));
            const isPublic = options.isPublic ?? isPublicAddress;
            const addresses = isIP(host) ? [{ address: host }] : await resolve(host).catch(() => []);
            if (!addresses.length || addresses.some((entry) => !isPublic(entry.address))) {
                log(`${name}: denied CONNECT ${target}${who} (not public)`);
                client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
                return;
            }
            log(`${name}: allowed CONNECT ${target}${who}`);
            tunnel(client, head, addresses[0].address, port);
        })();
    });
    const tunnel = (client: Socket, head: Buffer, host: string, port: number) => {
        // The client can go while `publicOnly` resolves the name: its `close`
        // has passed, so no listener below would ever close the upstream.
        if (client.destroyed) {
            return;
        }
        let open = false;
        const upstream = connect({ host, port });
        upstream.once('connect', () => {
            open = true;
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) {
                upstream.write(head);
            }
            upstream.pipe(client);
            client.pipe(upstream);
        });
        upstream.on('error', () => {
            if (!open) {
                client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
            } else {
                client.destroy();
            }
        });
        client.on('error', () => upstream.destroy());
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
    };
    server.on('clientError', (_error, socket) => socket.destroy());
    return server;
}
