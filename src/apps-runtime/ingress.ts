import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import {
    RUNTIME_APP_ID,
    RUNTIME_HEADER_APP,
    RUNTIME_HEADER_KEY,
    RUNTIME_HEADER_CURRENT,
    RUNTIME_HEADER_PLUGIN_PROOF,
    RUNTIME_HEADER_SIG,
    RUNTIME_HEADER_TASK,
    RUNTIME_TASK_ID,
} from '@socio/shared/apps/apps-runtime-types';

import { identityNames, ingressKey, LEGACY_IDENTITY_HEADERS, sameSecret, verifyIdentitySignature } from './keys.js';
import type { PluginServices } from './services.js';
import type { AppsSupervisor } from './supervisor.js';

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
]);

/**
 * The runtime's way in: the app's apps proxy sends every request for
 * a promoted app here with the app's id and the ingress key, and it goes
 * on to that app's unix socket. Nothing else reaches an app: not another
 * app in this container (no key), not the network (apps open no ports).
 *
 * Identity headers (CB-232): an `x-cb-*` header reaches the app only
 * if the proxy's `x-cb-runtime-sig` covers it. Without a signature, only
 * the legacy headers an older proxy sends unsigned pass to a mini app (a
 * deploy's overlap); the envelope and `x-cb-obo` never do, and nothing
 * unsigned reaches a plugin. With a wrong one, none pass. Today only the
 * proxy holds the ingress key, so this is defense in depth against a future
 * second caller.
 */
export function ingressServer(supervisor: AppsSupervisor, secret: string, services?: PluginServices) {
    const key = ingressKey(secret);
    const check = async (request: IncomingMessage) => {
        const supplied = request.headers[RUNTIME_HEADER_KEY];
        const id = String(request.headers[RUNTIME_HEADER_APP] ?? '');
        if (!sameSecret(typeof supplied === 'string' ? supplied : '', key)) {
            return { status: 401 as const };
        }
        if (!RUNTIME_APP_ID.test(id)) {
            return { status: 503 as const };
        }
        if (services) {
            try {
                await services.refresh();
            } catch {
                // The engine is down. Mini apps still use their sockets.
            }
            if (services.owns(id)) {
                return { status: 200 as const, id, plugin: true as const };
            }
        }
        if (!supervisor.running(id)) {
            return { status: 503 as const };
        }
        return { status: 200 as const, id, plugin: false as const };
    };
    const strip = (request: IncomingMessage, upgrade: boolean, appId: string, plugin: boolean) => {
        const named = new Set(
            String(request.headers.connection ?? '')
                .split(',')
                .map((token) => token.trim().toLowerCase()),
        );
        const headers: OutgoingHttpHeaders = {};
        for (let i = 0; i < request.rawHeaders.length; i += 2) {
            const name = request.rawHeaders[i].toLowerCase();
            const value = request.rawHeaders[i + 1];
            if (name.startsWith('x-cb-runtime-') || name === RUNTIME_HEADER_PLUGIN_PROOF) {
                continue;
            }
            if (!upgrade && (HOP_BY_HOP.has(name) || named.has(name))) {
                continue;
            }
            const current = headers[name];
            headers[name] = current === undefined ? value : `${String(current)}, ${value}`;
        }
        const supplied = request.headers[RUNTIME_HEADER_SIG];
        const signature = typeof supplied === 'string' ? supplied : undefined;
        const signed = signature
            ? verifyIdentitySignature(
                  secret,
                  appId,
                  request.method ?? 'GET',
                  request.url ?? '/',
                  headers as Record<string, string | undefined>,
                  signature,
              )
            : undefined;
        // A plugin gets no unsigned identity header at all (CB-232): the
        // proxy signs every one it sends a plugin, `x-cb-person` included.
        for (const name of identityNames(headers)) {
            if (!(signed?.has(name) || (!signature && !plugin && LEGACY_IDENTITY_HEADERS.has(name)))) {
                delete headers[name];
            }
        }
        return headers;
    };
    const opened = (host: string, port: number) =>
        new Promise<Socket>((resolve, reject) => {
            const socket = connect({ host, port });
            const fail = (error: Error) => {
                socket.destroy();
                reject(error);
            };
            socket.once('connect', () => {
                socket.off('error', fail);
                resolve(socket);
            });
            socket.once('error', fail);
        });
    /**
     * The task a host request names (CB-458): `x-cb-runtime-task`,
     * honored on `/__cb/` only (a person's request never gets there: the
     * apps proxy serves `/__cb/` itself and strips the header). Null when
     * the request names none; a malformed id names no task at all.
     */
    const pinnedTask = (request: IncomingMessage, plugin: boolean) => {
        const value = request.headers[RUNTIME_HEADER_TASK];
        if (!plugin || value === undefined || !(request.url ?? '').startsWith('/__cb/')) {
            return null;
        }
        return typeof value === 'string' && RUNTIME_TASK_ID.test(value) ? value : '';
    };
    /**
     * Round-robin task addresses. A task that does not accept the connection
     * is skipped; the request body is not read until one does, so a retry
     * still has it. No task is preferred for a person. A pinned `task`
     * (CB-458) is that task's addresses only, read fresh: never another
     * task, and none when it isn't running.
     */
    const pluginConnection = async (id: string, revision?: string, task: string | null = null) => {
        const targets = !services
            ? []
            : task === null
              ? await services.targets(id, revision)
              : task
                ? await services.taskTargets(id, task)
                : [];
        let last: unknown;
        for (const target of targets) {
            try {
                return await opened(target.host, target.port);
            } catch (error) {
                last = error;
            }
        }
        throw last ?? new Error('no tasks');
    };
    const server = createServer((request, response) => {
        void (async () => {
            const checked = await check(request);
            if (checked.status !== 200) {
                response.writeHead(checked.status, { 'content-type': 'text/plain' });
                response.end(checked.status === 401 ? 'Unauthorized' : 'Not running');
                return;
            }
            // A plugin task's address, or the app's own socket (never a symlink).
            let connection: Socket;
            try {
                // Set by the proxy (CB-370): only a task of the service's current
                // revision, while the service runs that install revision.
                const revision = request.headers[RUNTIME_HEADER_CURRENT];
                connection = checked.plugin
                    ? await pluginConnection(
                          checked.id,
                          typeof revision === 'string' ? revision : undefined,
                          pinnedTask(request, checked.plugin),
                      )
                    : supervisor.connectApp(checked.id);
            } catch {
                response.writeHead(502, { 'content-type': 'text/plain' });
                response.end('The app is not answering');
                return;
            }
            const headers = strip(request, false, checked.id, checked.plugin);
            if (checked.plugin && services) {
                headers[RUNTIME_HEADER_PLUGIN_PROOF] = services.proof(checked.id);
            }
            const upstream = httpRequest({
                createConnection: () => connection,
                method: request.method,
                path: request.url,
                headers,
            });
            upstream.on('response', (answer) => {
                const forwarded: OutgoingHttpHeaders = {};
                for (const [name, value] of Object.entries(answer.headers)) {
                    if (value !== undefined && !HOP_BY_HOP.has(name)) {
                        forwarded[name] = value;
                    }
                }
                response.writeHead(answer.statusCode ?? 502, forwarded);
                answer.pipe(response);
            });
            upstream.on('error', () => {
                if (!response.headersSent) {
                    response.writeHead(502, { 'content-type': 'text/plain' });
                    response.end('The app is not answering');
                } else {
                    response.destroy();
                }
            });
            request.on('aborted', () => upstream.destroy());
            response.on('close', () => upstream.destroy());
            request.pipe(upstream);
        })().catch(() => {
            if (!response.headersSent) {
                response.writeHead(502, { 'content-type': 'text/plain' });
                response.end('The app is not answering');
            }
        });
    });
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        socket.on('error', () => socket.destroy());
        void (async () => {
            const checked = await check(request);
            if (checked.status !== 200) {
                socket.end(
                    `HTTP/1.1 ${checked.status === 401 ? '401 Unauthorized' : '503 Service Unavailable'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
                );
                return;
            }
            let upstream: Socket;
            try {
                upstream = checked.plugin
                    ? await pluginConnection(checked.id, undefined, pinnedTask(request, checked.plugin))
                    : supervisor.connectApp(checked.id);
            } catch {
                socket.destroy();
                return;
            }
            upstream.on('error', () => socket.destroy());
            socket.on('close', () => upstream.destroy());
            upstream.on('close', () => socket.destroy());
            const send = () => {
                const headers = strip(request, true, checked.id, checked.plugin);
                if (checked.plugin && services) {
                    headers[RUNTIME_HEADER_PLUGIN_PROOF] = services.proof(checked.id);
                }
                upstream.write(
                    `${request.method} ${request.url} HTTP/1.1\r\n${Object.entries(headers)
                        .map(([name, value]) => `${name}: ${String(value).replace(/[\r\n]/g, '')}`)
                        .join('\r\n')}\r\n\r\n`,
                );
                if (head.length) {
                    upstream.write(head);
                }
                upstream.pipe(socket);
                socket.pipe(upstream);
            };
            // A plugin task is already connected. A mini app's socket connects next.
            if (checked.plugin) {
                send();
            } else {
                upstream.once('connect', send);
            }
        })().catch(() => socket.destroy());
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    return server;
}
