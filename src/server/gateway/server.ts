import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { gatewayStampKey, PROOF_WINDOW_MS, verifyGatewayStamp } from '@socio/foundation/actors/keys';
import { inSubnet, parseSubnet } from '@socio/foundation/http/subnet';

import type { GatewayListenerConfig } from './contract.js';
import { gitRoutes } from './git.js';
import { modelGatewayOf, modelRoutes, openAiError } from './model.js';
import type { GatewaySources } from './sources.js';

/**
 * The coding gateway's internal listener (CB-239): a separate
 * HTTP server with only the model and Git routes, never routed by the
 * public reverse proxy. Because the app service sits on several networks
 * (computers, plugin networks, the proxy network), it doesn't rely on its
 * bind address: a connection from outside the gateway network's subnet
 * (`GATEWAY_SUBNET`) is closed before anything is read, and without a
 * subnet every connection is (CB-232).
 *
 * Each request must carry the coding egress proxy's stamp, `x-cb-sandbox:
 * <sandboxId>.<ts>.<mac>` (`verifyGatewayStamp`, packages/foundation/src/actors/keys.ts): a valid
 * MAC under the key from CODING_EGRESS_SECRET, `ts` within 30 s, over the
 * method and the exact request-target as received (origin-form path and
 * query), and not seen before on this runtime: the proxy never stamps two
 * requests of a sandbox with the same time (it keeps `ts` strictly
 * increasing per sandbox), so concurrent requests stay distinct. The
 * routes then check the
 * `cbgw_` (`actors.check`, kind `cbgw`, its `contextId` the
 * stamp's sandbox). Client `x-cb-*` headers never reach a route.
 *
 * The Git proxy adds routes only through `gitRoutes` (git.ts).
 */

/** A route on the gateway listener; the model and Git gateways return theirs. */
export interface GatewayRoute {
    method: 'GET' | 'POST';
    /** Whether this route serves the request path. */
    match(path: string): boolean;
    handle(request: Request, context: GatewayRequestContext): Promise<Response>;
}

/** What the listener has established before a route runs. */
export interface GatewayRequestContext {
    /** The sandbox the egress proxy's stamp named. */
    sandboxId: string;
    correlationId: string;
    /** Aborted when the client goes away or the listener closes. */
    signal: AbortSignal;
}

/** The listener's settings (the contract's `GatewayListenerConfig`, re-exported under its old name). */
export type GatewayConfig = GatewayListenerConfig;

export function gatewayConfigFromEnv(env: Record<string, string | undefined>): GatewayConfig | undefined {
    const secret = env.CODING_EGRESS_SECRET?.trim();
    if (!secret) {
        return undefined;
    }
    const port = Number(env.GATEWAY_PORT?.trim() || 4340);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('GATEWAY_PORT must be a port number.');
    }
    const subnet = env.GATEWAY_SUBNET?.trim() || undefined;
    if (subnet && !parseSubnet(subnet)) {
        throw new Error('GATEWAY_SUBNET must be an IPv4 subnet, e.g. 172.30.0.0/24.');
    }
    return {
        port,
        egressSecret: secret,
        subnet,
        host: env.GATEWAY_HOST?.trim() || undefined,
    };
}

/**
 * Stamps seen within their window, on this runtime: a replayed stamp is
 * refused. Defense in depth: only the egress proxy holds the key, and a
 * cbgw_ is checked on every request anyway.
 */
class StampReplay {
    private seen = new Map<string, number>();
    /** True the first time a stamp is seen. */
    fresh(stamp: string, now: number) {
        if (this.seen.size > 50_000) {
            for (const [value, until] of this.seen) {
                if (until <= now) {
                    this.seen.delete(value);
                }
            }
        }
        const until = this.seen.get(stamp);
        if (until !== undefined && until > now) {
            return false;
        }
        this.seen.set(stamp, now + 2 * PROOF_WINDOW_MS);
        return true;
    }
}

export interface GatewayServer {
    listen(): Promise<void>;
    close(): Promise<void>;
    /** The port it listens on, once listening (tests use port 0). */
    readonly port: number | undefined;
}

const HOP_BY_HOP = new Set([
    'host',
    'connection',
    'keep-alive',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);

/** The listener, or undefined while it isn't configured. */
export function createGatewayServer(
    sources: GatewaySources,
    config: GatewayConfig | undefined,
    options: { now?: () => number; log?: (line: string) => void } = {},
): GatewayServer | undefined {
    if (!config?.egressSecret) {
        return undefined;
    }
    const now = options.now ?? Date.now;
    const log = options.log ?? ((line: string) => console.log(line));
    const routes = [...modelRoutes(sources), ...gitRoutes(sources)];
    const stampKey = gatewayStampKey(config.egressSecret);
    const subnet = config.subnet ? parseSubnet(config.subnet) : undefined;
    const replay = new StampReplay();
    const open = new Set<AbortController>();

    const refuse = (res: ServerResponse, response: Response) => void send(res, response);

    async function handle(req: IncomingMessage, res: ServerResponse) {
        const method = req.method ?? '';
        const target = req.url ?? '';
        if (!target.startsWith('/')) {
            return refuse(res, openAiError(400, 'invalid_request_error', 'bad_request', 'Bad request.'));
        }
        const path = target.split('?')[0]!;
        const forPath = routes.filter((route) => route.match(path));
        const route = forPath.find((entry) => entry.method === method);
        if (!route) {
            req.resume();
            return refuse(
                res,
                forPath.length
                    ? openAiError(405, 'invalid_request_error', 'method_not_allowed', 'Method not allowed.')
                    : openAiError(404, 'not_found_error', 'not_found', 'Not found.'),
            );
        }
        const stamp = req.headers['x-cb-sandbox'];
        const at = now();
        const sandboxId =
            typeof stamp === 'string' ? verifyGatewayStamp(stampKey, stamp, method, target, at) : undefined;
        if (!sandboxId || !replay.fresh(stamp as string, at)) {
            req.resume();
            return refuse(
                res,
                openAiError(
                    401,
                    'authentication_error',
                    'invalid_stamp',
                    'Requests reach the gateway only through the coding egress proxy.',
                ),
            );
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
            const key = name.toLowerCase();
            if (value === undefined || HOP_BY_HOP.has(key) || key.startsWith('x-cb-')) {
                continue;
            }
            for (const item of Array.isArray(value) ? value : [value]) {
                headers.append(key, item);
            }
        }
        const controller = new AbortController();
        open.add(controller);
        res.on('close', () => {
            open.delete(controller);
            if (!res.writableFinished) {
                controller.abort();
            }
        });
        const request = new Request(`http://gateway.socio.internal${target}`, {
            method,
            headers,
            ...(method === 'GET' || method === 'HEAD'
                ? {}
                : {
                      body: Readable.toWeb(req) as unknown as ReadableStream,
                      duplex: 'half',
                  }),
            signal: controller.signal,
        } as RequestInit);
        if (method === 'GET' || method === 'HEAD') {
            req.resume();
        }
        let response: Response;
        try {
            response = await route.handle(request, {
                sandboxId,
                correlationId: randomUUID(),
                signal: controller.signal,
            });
        } catch {
            log('Coding gateway: a request failed.');
            response = openAiError(500, 'api_error', 'internal_error', 'The gateway failed.');
        }
        await send(res, response, controller.signal);
    }

    const server: Server = createServer((req, res) => {
        void handle(req, res).catch(() => res.destroy());
    });
    // The source check comes before anything is read.
    server.on('connection', (socket) => {
        if (!inSubnet(subnet, socket.remoteAddress)) {
            socket.destroy();
        }
    });
    server.requestTimeout = 0;
    server.headersTimeout = 30_000;
    const gateway = modelGatewayOf(sources);
    let port: number | undefined;
    return {
        get port() {
            return port;
        },
        listen: () =>
            new Promise<void>((resolve, reject) => {
                if (!subnet) {
                    log('Coding gateway: GATEWAY_SUBNET is not set, so the gateway refuses every connection.');
                }
                server.once('error', reject);
                server.listen(config.port, config.host, () => {
                    const address = server.address();
                    port = typeof address === 'object' && address ? address.port : config.port;
                    gateway.startSweep();
                    resolve();
                });
            }),
        close: () =>
            new Promise<void>((resolve) => {
                gateway.stop();
                for (const controller of open) {
                    controller.abort();
                }
                server.close(() => resolve());
                server.closeAllConnections();
            }),
    };
}

/** Writes a fetch Response to the node response, streaming its body. */
async function send(res: ServerResponse, response: Response, signal?: AbortSignal) {
    if (res.headersSent || res.destroyed) {
        return;
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
        headers[key] = value;
    });
    res.writeHead(response.status, headers);
    if (!response.body) {
        res.end();
        return;
    }
    const reader = response.body.getReader();
    try {
        for (;;) {
            if (signal?.aborted) {
                break;
            }
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (!res.write(value)) {
                await new Promise<void>((resolve) => {
                    const go = () => {
                        res.off('drain', go);
                        res.off('close', go);
                        resolve();
                    };
                    res.on('drain', go);
                    res.on('close', go);
                });
            }
            if (res.destroyed) {
                break;
            }
        }
    } catch {
        // The route's stream broke; the response ends here.
    } finally {
        if (res.destroyed || signal?.aborted) {
            await reader.cancel().catch(() => undefined);
        }
        if (!res.destroyed) {
            res.end();
        }
    }
}
