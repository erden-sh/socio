import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { deriveKey, sameMac } from '@socio/foundation/actors/keys';

import { readFrame } from './frame.js';
import { CodingGit, CodingGitError, type ExtractRequest, type InspectMeta } from './service.js';

/**
 * `coding-git`'s HTTP API (CB-239, CB-267), for the app only:
 * every request carries the key derived from `CODING_GIT_SECRET`, which
 * only the app and this service hold. No route reaches the outside.
 *
 * - `GET  /healthz`
 * - `GET  /mirror/refs?repository=o/n[&has=<sha>]`: the mirror's tips
 * - `POST /mirror/refresh?repository=o/n`: framed `{ refs }` + a pack
 * - `POST /inspect`: framed `InspectMeta` + the push's pack
 * - `GET  /spool/:id`, `DELETE /spool/:id`: an accepted push's pack
 * - `POST /extract?repository=o/n`: JSON `ExtractRequest`
 */

/** The bearer key the app presents (and this service checks). */
export const codingGitKey = (secret: string) => deriveKey(secret, 'coding-git-api').toString('base64url');

const MAX_JSON = 64 * 1024;

const send = (response: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(text),
    });
    response.end(text);
};

async function readJson<T>(request: IncomingMessage): Promise<T> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > MAX_JSON) {
            throw new CodingGitError('The request is too large.', 413);
        }
        chunks.push(chunk as Buffer);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
    } catch {
        throw new CodingGitError('The request is not JSON.');
    }
}

export function createCodingGitServer(service: CodingGit, secret: string): Server {
    const key = codingGitKey(secret);
    return createServer((request, response) => {
        void handle(request, response).catch((error: unknown) => {
            if (response.headersSent) {
                return response.destroy();
            }
            if (error instanceof CodingGitError) {
                return send(response, error.status, { error: error.message });
            }
            send(response, 500, { error: 'coding-git failed.' });
        });
    });

    async function handle(request: IncomingMessage, response: ServerResponse) {
        const url = new URL(request.url ?? '/', 'http://coding-git');
        if (url.pathname === '/healthz' && request.method === 'GET') {
            return send(response, 200, { ok: true });
        }
        const auth = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
        if (!auth || !sameMac(auth, key)) {
            request.resume();
            return send(response, 401, { error: 'Unauthorized.' });
        }
        const repository = url.searchParams.get('repository') ?? '';
        if (url.pathname === '/mirror/refs' && request.method === 'GET') {
            return send(response, 200, await service.refs(repository, url.searchParams.get('has') ?? undefined));
        }
        if (url.pathname === '/mirror/refresh' && request.method === 'POST') {
            const { meta, rest } = await readFrame<{
                refs?: Record<string, string>;
                pack?: boolean;
            }>(request);
            if (!meta.pack) {
                rest.resume();
            }
            return send(
                response,
                200,
                await service.refresh(
                    repository,
                    meta.refs && typeof meta.refs === 'object' ? meta.refs : {},
                    meta.pack ? rest : null,
                ),
            );
        }
        if (url.pathname === '/inspect' && request.method === 'POST') {
            const { meta, rest } = await readFrame<InspectMeta>(request);
            if (
                typeof meta.repository !== 'string' ||
                !Array.isArray(meta.commands) ||
                typeof meta.identity?.name !== 'string' ||
                typeof meta.identity?.email !== 'string'
            ) {
                throw new CodingGitError('The inspection request is malformed.');
            }
            service.mirrorPath(meta.repository);
            return send(response, 200, await service.inspect(meta, rest));
        }
        const spool = /^\/spool\/([0-9a-f-]{36})$/.exec(url.pathname);
        if (spool && request.method === 'GET') {
            const file = await service.spoolFile(spool[1]);
            if (!file) {
                return send(response, 404, { error: 'No such spool.' });
            }
            response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
            createReadStream(file)
                .on('error', () => response.destroy())
                .pipe(response);
            return;
        }
        if (spool && request.method === 'DELETE') {
            await service.dropSpool(spool[1]);
            return send(response, 200, { ok: true });
        }
        if (url.pathname === '/extract' && request.method === 'POST') {
            const input = await readJson<ExtractRequest>(request);
            if (
                typeof input.commit !== 'string' ||
                !Array.isArray(input.paths) ||
                !input.paths.every((path) => typeof path === 'string') ||
                !Number.isInteger(input.maxBytes) ||
                !Number.isInteger(input.maxFiles)
            ) {
                throw new CodingGitError('The extraction request is malformed.');
            }
            return send(response, 200, await service.extract(repository, input));
        }
        request.resume();
        send(response, 404, { error: 'Not found.' });
    }
}
