import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeEnv {
    name: string;
    value: string;
}

/**
 * A stand-in for the few Portainer endpoints the updater calls (CB-259),
 * on loopback, with an API key: `GET /api/stacks`, `GET /api/stacks/:id`,
 * `GET /api/stacks/:id/file`, `PUT /api/stacks/:id?endpointId=` and
 * `GET /api/endpoints/:id/docker/images/:ref/json`. A stack update calls
 * `onUpdate`, which tests use to make the fake app answer as the new (or
 * old) version.
 */
export async function startFakePortainer(options: {
    apiKey: string;
    stack: {
        id: number;
        name: string;
        endpointId: number;
        env: FakeEnv[];
        file: string;
    };
    images?: string[];
}) {
    const state = {
        stack: structuredClone(options.stack),
        images: new Set(options.images ?? []),
        updates: [] as {
            stackFileContent: string;
            env: FakeEnv[];
            prune: boolean;
            pullImage: boolean;
            endpointId: string | null;
        }[],
        requests: [] as { method: string; path: string; body: string }[],
        /** Refuse stack updates with this status (tests of a failed PUT). */
        refuseUpdate: undefined as number | undefined,
        onUpdate: (_env: FakeEnv[]) => {},
    };
    const send = (res: ServerResponse, status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    const handle = async (req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(chunk as Buffer);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        const url = new URL(req.url ?? '/', 'http://portainer.test');
        state.requests.push({
            method: req.method ?? 'GET',
            path: url.pathname + url.search,
            body: raw,
        });
        if (req.headers['x-api-key'] !== options.apiKey) {
            return send(res, 401, {
                message: 'Unauthorized',
                details: 'A valid authorisation token is missing',
            });
        }
        const { stack } = state;
        if (req.method === 'GET' && url.pathname === '/api/stacks') {
            return send(res, 200, [
                {
                    Id: stack.id,
                    Name: stack.name,
                    EndpointId: stack.endpointId,
                    Env: stack.env,
                },
                {
                    Id: 99,
                    Name: 'company-brain-computers',
                    EndpointId: stack.endpointId,
                    Env: [],
                },
            ]);
        }
        if (req.method === 'GET' && url.pathname === `/api/stacks/${stack.id}`) {
            return send(res, 200, {
                Id: stack.id,
                Name: stack.name,
                EndpointId: stack.endpointId,
                Env: stack.env,
            });
        }
        if (req.method === 'GET' && url.pathname === `/api/stacks/${stack.id}/file`) {
            return send(res, 200, { StackFileContent: stack.file });
        }
        if (req.method === 'PUT' && url.pathname === `/api/stacks/${stack.id}`) {
            if (state.refuseUpdate) {
                return send(res, state.refuseUpdate, {
                    message: 'Update failed',
                    details: 'boom',
                });
            }
            const body = JSON.parse(raw) as (typeof state.updates)[number];
            state.updates.push({
                ...body,
                endpointId: url.searchParams.get('endpointId'),
            });
            stack.env = body.env;
            stack.file = body.stackFileContent;
            state.onUpdate(body.env);
            return send(res, 200, { Id: stack.id });
        }
        const image = url.pathname.match(/^\/api\/endpoints\/(\d+)\/docker\/images\/(.+)\/json$/);
        if (req.method === 'GET' && image) {
            return state.images.has(decodeURIComponent(image[2]!))
                ? send(res, 200, { Id: 'sha256:abc' })
                : send(res, 404, { message: 'No such image' });
        }
        send(res, 404, { message: 'Not found' });
    };
    const server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        state,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

/** The app's /healthz on loopback; tests set what it answers. */
export async function startFakeHealth() {
    const state = {
        answer: {
            status: 200,
            body: { ok: true, version: '0.21.0' } as Record<string, unknown>,
        },
        hits: 0,
        /** Called with the hit count before each answer: lets a test change it by request, not by clock. */
        onHit: undefined as ((hits: number) => void) | undefined,
    };
    const server = createServer((_req, res) => {
        state.hits++;
        state.onHit?.(state.hits);
        res.writeHead(state.answer.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state.answer.body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        state,
        url: `http://127.0.0.1:${port}/healthz`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
