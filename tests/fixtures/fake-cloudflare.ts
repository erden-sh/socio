import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { FakeRequest } from './fake-npm.js';

/**
 * A stand-in for Cloudflare's v4 DNS API on loopback (`/client/v4`): one
 * zone, a bearer token, `GET /zones?name=`, and DNS records (list by exact
 * name, create, patch, delete) in Cloudflare's envelope.
 */
export interface FakeRecord {
    id: string;
    type: string;
    name: string;
    content: string;
    proxied: boolean;
    ttl: number;
    comment?: string | null;
}

export async function startFakeCloudflare(options: { zone?: string; token?: string } = {}) {
    const zone = {
        id: randomBytes(16).toString('hex'),
        name: options.zone ?? 'example.test',
    };
    const token = options.token ?? 'cf-dns-token-0123456789abcdef';
    const state = {
        records: [] as FakeRecord[],
        requests: [] as FakeRequest[],
    };
    const send = (res: ServerResponse, status: number, result: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(
            JSON.stringify(
                status < 300
                    ? { success: true, errors: [], messages: [], result }
                    : { success: false, errors: [result], messages: [], result: null },
            ),
        );
    };
    const handle = async (req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(chunk as Buffer);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        const url = new URL(req.url ?? '/', 'http://cf.test');
        state.requests.push({
            method: req.method ?? 'GET',
            path: url.pathname + url.search,
            headers: req.headers,
            body: raw,
        });
        if (req.headers.authorization !== `Bearer ${token}`) {
            return send(res, 403, { code: 10000, message: 'Authentication error' });
        }
        const path = url.pathname.replace(/^\/client\/v4/, '');
        const body = (raw ? JSON.parse(raw) : {}) as Partial<FakeRecord>;
        if (path === '/zones' && req.method === 'GET') {
            return send(res, 200, url.searchParams.get('name') === zone.name ? [zone] : []);
        }
        const match = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(path);
        if (!match || match[1] !== zone.id) {
            return send(res, 404, { code: 7003, message: 'Could not route' });
        }
        const record = match[2] ? state.records.find((entry) => entry.id === match[2]) : undefined;
        if (match[2] && !record) {
            return send(res, 404, { code: 81044, message: 'Record not found' });
        }
        if (req.method === 'GET' && !match[2]) {
            const name = url.searchParams.get('name');
            return send(
                res,
                200,
                state.records.filter((entry) => !name || entry.name === name),
            );
        }
        if (req.method === 'POST' && !match[2]) {
            const created: FakeRecord = {
                id: randomBytes(16).toString('hex'),
                type: body.type ?? 'A',
                name: body.name ?? '',
                content: body.content ?? '',
                proxied: body.proxied ?? true,
                ttl: body.ttl ?? 1,
                comment: body.comment ?? null,
            };
            state.records.push(created);
            return send(res, 200, created);
        }
        if (req.method === 'PATCH' && record) {
            Object.assign(record, body);
            return send(res, 200, record);
        }
        if (req.method === 'DELETE' && record) {
            state.records.splice(state.records.indexOf(record), 1);
            return send(res, 200, { id: record.id });
        }
        return send(res, 405, { code: 10405, message: 'Method not allowed' });
    };
    const server = createServer((req, res) => {
        handle(req, res).catch(() => send(res, 500, { code: 10500, message: 'failed' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}/client/v4`,
        zone,
        token,
        state,
        seed(record: Omit<FakeRecord, 'id'>) {
            const created = { id: randomBytes(16).toString('hex'), ...record };
            state.records.push(created);
            return created;
        },
        writes() {
            return state.requests.filter((request) => request.method !== 'GET');
        },
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
export type FakeCloudflare = Awaited<ReturnType<typeof startFakeCloudflare>>;
