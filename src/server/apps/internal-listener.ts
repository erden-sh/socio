import { createServer, type Server } from 'node:http';
import { isIP } from 'node:net';

import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';

import { appsProxy, appsUpgrade } from './proxy.js';
import type { AppsService } from './service.js';

/**
 * The internal apps listener (CB-232):
 * the app browser's workers reach apps here, on `app_browser`, never
 * through the public proxy. A separate HTTP server with one job: socio
 * sessions on an app's or a service plugin's host (`Authorization: Bearer
 * cbsa_…` and the context proof, checked by the apps proxy's own path;
 * plugins since CB-232, which have no WebSocket path), routed by Host,
 * WebSocket upgrades included. Anything else (a person's cookie, Socio's
 * API, another host) is refused. Connections from outside its network's
 * subnet are refused before a byte is read: defense in depth behind the
 * credential and proof checks, since the app sits on many networks.
 */

export interface AppsInternalConfig {
    /** `APPS_INTERNAL_PORT` (default 4312). */
    port: number;
    host: string;
    /**
     * `APPS_INTERNAL_SUBNET`: the `app_browser` network's IPv4 subnets
     * (CIDR, comma-separated). Unset, every connection is refused: the app
     * sits on many Docker networks (computers, plugins), all private.
     * Development on one host sets `127.0.0.0/8` explicitly.
     */
    subnets: string[];
}

const CIDR = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/;

/** On when the app browser is (`APP_BROWSER_URL`); undefined otherwise. */
export function appsInternalConfigFromEnv(env: Record<string, string | undefined>): AppsInternalConfig | undefined {
    if (!env.APP_BROWSER_URL?.trim()) {
        return undefined;
    }
    const port = Number(env.APPS_INTERNAL_PORT?.trim() || 4312);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('APPS_INTERNAL_PORT must be a port number.');
    }
    const subnets = (env.APPS_INTERNAL_SUBNET ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    for (const subnet of subnets) {
        if (!CIDR.test(subnet) || Number(CIDR.exec(subnet)![2]) > 32) {
            throw new Error('APPS_INTERNAL_SUBNET is IPv4 CIDR, e.g. 172.31.250.0/28.');
        }
    }
    return { port, host: '0.0.0.0', subnets };
}

const ipv4 = (address: string) => address.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);

const inSubnet = (address: string, subnet: string) => {
    const [, base, bits] = CIDR.exec(subnet)!;
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (ipv4(address) & mask) === (ipv4(base) & mask);
};

/**
 * Whether a connection's source may use the listener: inside one of the
 * subnets (IPv4, or IPv4-mapped IPv6). No subnet, no source (it used to
 * take every private and loopback address, so every container on any of
 * the app's networks), as the coding gateway's listener does without
 * `GATEWAY_SUBNET`.
 */
export function sourceAllowed(address: string | undefined, subnets: readonly string[]) {
    if (!address || !subnets.length) {
        return false;
    }
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
    const v4 = mapped ? mapped[1] : isIP(address) === 4 ? address : undefined;
    return !!v4 && subnets.some((subnet) => inSubnet(v4, subnet));
}

export interface AppsInternalServer {
    server: Server;
    listen(): Promise<void>;
    close(): Promise<void>;
}

export function createAppsInternalServer(
    apps: AppsService,
    config: AppsInternalConfig | undefined,
    log: (line: string) => void = (line) => console.log(line),
): AppsInternalServer | undefined {
    if (!config || !apps.enabled) {
        return undefined;
    }
    const app = new Hono();
    app.use('*', appsProxy(apps, undefined, { socioOnly: true }));
    // Nothing but an app's host reaches here; the proxy answers those.
    app.all('*', (c) => c.text('Not found.', 404));
    const listener = getRequestListener(app.fetch);
    const upgrade = appsUpgrade(apps, { socioOnly: true });
    const server = createServer((request, response) => {
        void listener(request, response);
    });
    // The source check comes before a byte of the request is read: the
    // socket is destroyed, no answer at all.
    server.on('connection', (socket) => {
        if (!sourceAllowed(socket.remoteAddress, config.subnets)) {
            socket.destroy();
        }
    });
    server.on('upgrade', (request, socket, head) => {
        if (!upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    return {
        server,
        listen: () => {
            if (!config.subnets.length) {
                log('Internal apps listener: APPS_INTERNAL_SUBNET is not set, so it refuses every connection.');
            }
            return new Promise<void>((resolve) => server.listen(config.port, config.host, () => resolve()));
        },
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
