import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RUNTIME_HEADER_PLUGIN_PROOF } from '@socio/shared/apps/apps-runtime-types';
import { PLUGIN_PARENT_HEADER } from '@socio/shared/plugins/plugins';

import { renderPlanner, type PlannerPage } from './render.js';

export interface PlannerServerOptions {
    port: number;
    proof: string;
    apiUrl: string;
    tokenFile: string;
    /** Tests pass a fetch. */
    fetch?: typeof fetch;
}

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ui');
const UI_TYPES: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.map': 'application/json',
};
const PAGE_CSP =
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'";

class CallError extends Error {
    constructor(
        readonly status: number,
        readonly body: string,
    ) {
        super(body.slice(0, 300));
    }
}

const same = (supplied: string, expected: string) => {
    const a = Buffer.from(supplied);
    const b = Buffer.from(expected);
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};

async function readBody(request: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * The planner's own service. It holds no session: Socio's proxy already
 * authenticated the person and any replica can render. `/healthz` is open
 * for the swarm healthcheck; every other path needs the ingress proof.
 */
export function startPlanner(options: PlannerServerOptions) {
    const call = options.fetch ?? fetch;
    const token = () => readFileSync(options.tokenFile, 'utf8').trim();
    const socio = async (method: string, path: string, body?: object) => {
        const response = await call(`${options.apiUrl.replace(/\/$/, '')}/api/plugins/social-strategy/data${path}`, {
            method,
            headers: {
                authorization: `Bearer ${token()}`,
                'x-cb-plugin-id': 'social-strategy',
                [RUNTIME_HEADER_PLUGIN_PROOF]: options.proof,
                ...(body ? { 'content-type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await response.text();
        if (!response.ok) {
            throw new CallError(response.status, text || response.statusText);
        }
        return text ? (JSON.parse(text) as unknown) : null;
    };
    const state = async () => {
        const data = (await socio('GET', '/state')) as {
            posts: PlannerPage['posts'];
            replies: PlannerPage['replies'];
            voice: { notes: string };
        };
        return data;
    };
    const server = createServer((request, response) => {
        void handle(request, response).catch((error) => {
            if (error instanceof CallError) {
                const payload = error.body.trim().startsWith('{')
                    ? error.body
                    : JSON.stringify({ error: error.message });
                response.writeHead(error.status, {
                    'content-type': 'application/json; charset=utf-8',
                    'cache-control': 'no-store',
                });
                response.end(payload);
                return;
            }
            const message = error instanceof Error ? error.message : 'Something went wrong.';
            response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
            response.end(message);
        });
    });
    const sendJson = (response: ServerResponse, body: unknown, status = 200) => {
        response.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
        });
        response.end(JSON.stringify(body));
    };
    const handle = async (request: IncomingMessage, response: ServerResponse) => {
        const url = new URL(request.url ?? '/', 'http://plugin');
        if (url.pathname === '/healthz') {
            sendJson(response, { ok: true });
            return;
        }
        const proof = String(request.headers[RUNTIME_HEADER_PLUGIN_PROOF] ?? '');
        if (!same(proof, options.proof)) {
            response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('Unauthorized');
            return;
        }
        if (request.method === 'GET' && url.pathname.startsWith('/ui/')) {
            const name = url.pathname.slice('/ui/'.length);
            if (!/^[\w.-]+$/.test(name)) {
                response.writeHead(404);
                response.end('Not found');
                return;
            }
            const type = UI_TYPES[extname(name)];
            if (!type) {
                response.writeHead(404);
                response.end('Not found');
                return;
            }
            try {
                const file = await readFile(join(UI_DIR, name));
                response.writeHead(200, {
                    'content-type': type,
                    'cache-control': 'no-cache',
                });
                response.end(file);
            } catch {
                response.writeHead(404, {
                    'content-type': 'text/plain; charset=utf-8',
                });
                response.end('Not found');
            }
            return;
        }
        const parent = String(request.headers[PLUGIN_PARENT_HEADER] ?? '');
        const parentOrigin = /^https?:\/\/[^/\s]+$/.test(parent) ? parent : '';
        const view = (['week', 'month', 'grid', 'replies'] as const).includes(
            url.searchParams.get('view') as PlannerPage['view'],
        )
            ? (url.searchParams.get('view') as PlannerPage['view'])
            : 'week';
        if (request.method === 'GET' && url.pathname === '/') {
            const data = await state();
            response.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'content-security-policy': PAGE_CSP,
                'cross-origin-opener-policy': 'same-origin',
                'cross-origin-resource-policy': 'cross-origin',
                'referrer-policy': 'same-origin',
                'cache-control': 'no-store',
            });
            response.end(
                renderPlanner({
                    view,
                    now: Date.now(),
                    posts: data.posts,
                    replies: data.replies,
                    voice: data.voice.notes,
                    parentOrigin,
                }),
            );
            return;
        }
        if (request.method === 'GET' && url.pathname === '/api/state') {
            const data = await state();
            sendJson(response, { ...data, now: Date.now() });
            return;
        }
        const json = async () => {
            const text = await readBody(request);
            if (!text) {
                return {};
            }
            return JSON.parse(text) as object;
        };
        const postId = /^\/api\/posts\/([^/]+)$/.exec(url.pathname);
        const replyId = /^\/api\/replies\/([^/]+)$/.exec(url.pathname);
        if (request.method === 'POST' && url.pathname === '/api/posts') {
            await socio('POST', '/posts', await json());
            const data = await state();
            sendJson(response, { ...data, now: Date.now() });
            return;
        }
        if (request.method === 'PATCH' && postId) {
            await socio('PATCH', `/posts/${encodeURIComponent(postId[1]!)}`, await json());
            const data = await state();
            sendJson(response, { ...data, now: Date.now() });
            return;
        }
        if (request.method === 'POST' && url.pathname === '/api/replies') {
            await socio('POST', '/replies', await json());
            const data = await state();
            sendJson(response, { ...data, now: Date.now() });
            return;
        }
        if (request.method === 'PATCH' && replyId) {
            await socio('PATCH', `/replies/${encodeURIComponent(replyId[1]!)}`, await json());
            const data = await state();
            sendJson(response, { ...data, now: Date.now() });
            return;
        }
        if (request.method === 'PUT' && url.pathname === '/api/voice') {
            await socio('PUT', '/voice', await json());
            const data = await state();
            sendJson(response, { ...data, now: Date.now() });
            return;
        }
        response.writeHead(request.method === 'GET' ? 404 : 405, {
            'content-type': 'text/plain; charset=utf-8',
            allow: 'GET, POST, PATCH, PUT',
        });
        response.end(request.method === 'GET' ? 'Not found' : 'Method not allowed');
    };
    server.listen(options.port);
    return server;
}
