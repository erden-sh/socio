import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for Nginx Proxy Manager 2.14's admin API on loopback: tokens
 * (`POST`/`GET /api/tokens`, expiring), `GET /api/users/me`, proxy hosts
 * and certificates with per-user visibility (each user lists only its own
 * items, as NPM's "visibility: user" does), and NPM's request schemas
 * (unknown fields are refused, as `additionalProperties: false` does).
 * Certificates are "issued" at once, valid for 90 days.
 */

export interface FakeNpmUser {
    id: number;
    email: string;
    password: string;
}
export interface FakeRequest {
    method: string;
    path: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}

const PROXY_FIELDS = new Set([
    'domain_names',
    'forward_scheme',
    'forward_host',
    'forward_port',
    'certificate_id',
    'ssl_forced',
    'hsts_enabled',
    'hsts_subdomains',
    'trust_forwarded_proto',
    'http2_support',
    'block_exploits',
    'caching_enabled',
    'allow_websocket_upgrade',
    'access_list_id',
    'advanced_config',
    'enabled',
    'meta',
    'locations',
]);
const CERT_FIELDS = new Set(['provider', 'nice_name', 'domain_names', 'meta']);
const CERT_META = new Set([
    'certificate',
    'certificate_key',
    'dns_challenge',
    'dns_provider_credentials',
    'dns_provider',
    'letsencrypt_certificate',
    'propagation_seconds',
    'key_type',
]);

const DAY = 86_400_000;

export async function startFakeNpm(options: { users?: FakeNpmUser[]; tokenTtlMs?: number } = {}) {
    const users: FakeNpmUser[] = options.users ?? [
        { id: 1, email: 'acme@example.test', password: 'npm-password-0123' },
    ];
    const state = {
        tokenTtlMs: options.tokenTtlMs ?? DAY,
        tokens: new Map<string, { userId: number; expires: number }>(),
        proxyHosts: [] as Record<string, unknown>[],
        certificates: [] as Record<string, unknown>[],
        requests: [] as FakeRequest[],
        nextId: 1,
        /** Answer every non-token request with this (status, message) once set. */
        failWith: undefined as { status: number; message: string } | undefined,
        /** Hold answers this long (timeouts). */
        delayMs: 0,
        /** Credentials sent for DNS challenges, to check what NPM got. */
        dnsCredentials: [] as string[],
    };
    const issue = (userId: number) => {
        const token = `eyJhbGciOiJSUzUxMiJ9.${randomBytes(12).toString('base64url')}.${randomBytes(16).toString('base64url')}`;
        const expires = Date.now() + state.tokenTtlMs;
        state.tokens.set(token, { userId, expires });
        return { token, expires: new Date(expires).toISOString() };
    };
    const send = (res: ServerResponse, status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    const error = (res: ServerResponse, status: number, message: string) =>
        send(res, status, { error: { code: status, message } });
    const unknownField = (body: Record<string, unknown>, allowed: Set<string>) =>
        Object.keys(body).find((key) => !allowed.has(key));

    const handle = async (req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(chunk as Buffer);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        const url = new URL(req.url ?? '/', 'http://npm.test');
        state.requests.push({
            method: req.method ?? 'GET',
            path: url.pathname + url.search,
            headers: req.headers,
            body: raw,
        });
        if (state.delayMs) {
            await new Promise((resolve) => setTimeout(resolve, state.delayMs));
        }
        const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
        const path = url.pathname.replace(/^\/api/, '');
        if (path === '/tokens' && req.method === 'POST') {
            const user = users.find((entry) => entry.email === body.identity && entry.password === body.secret);
            if (!user) {
                return error(res, 401, 'Invalid email or password');
            }
            return send(res, 200, issue(user.id));
        }
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        const session = bearer ? state.tokens.get(bearer) : undefined;
        if (!session || session.expires <= Date.now()) {
            return error(res, 401, 'Token has expired');
        }
        const me = users.find((user) => user.id === session.userId)!;
        if (path === '/tokens' && req.method === 'GET') {
            return send(res, 200, issue(me.id));
        }
        if (state.failWith) {
            return error(res, state.failWith.status, state.failWith.message);
        }
        if (path === '/users/me') {
            return send(res, 200, { id: me.id, email: me.email });
        }
        const mine = (list: Record<string, unknown>[]) => list.filter((item) => item.owner_user_id === me.id);
        const match = /^\/nginx\/(proxy-hosts|certificates)(?:\/(\d+))?(\/renew)?$/.exec(path);
        if (!match) {
            return error(res, 404, 'Not found');
        }
        const list = match[1] === 'proxy-hosts' ? state.proxyHosts : state.certificates;
        const id = match[2] ? Number(match[2]) : undefined;
        const item = id !== undefined ? mine(list).find((x) => x.id === id) : undefined;
        if (id !== undefined && !item) {
            return error(res, 404, 'Not found');
        }
        if (match[1] === 'proxy-hosts') {
            if (req.method === 'GET' && id === undefined) {
                return send(res, 200, mine(list));
            }
            if (req.method === 'POST' || req.method === 'PUT') {
                const bad = unknownField(body, PROXY_FIELDS);
                if (bad) {
                    return error(res, 400, `data must NOT have additional properties (${bad})`);
                }
                const names = (body.domain_names as string[] | undefined) ?? [];
                const taken = state.proxyHosts.find(
                    (host) => host !== item && (host.domain_names as string[]).some((name) => names.includes(name)),
                );
                if (taken) {
                    return error(res, 400, `${names.join(', ')} is already in use`);
                }
                if (req.method === 'POST') {
                    const created = {
                        id: state.nextId++,
                        owner_user_id: me.id,
                        access_list_id: 0,
                        advanced_config: '',
                        locations: [],
                        hsts_subdomains: false,
                        caching_enabled: false,
                        enabled: true,
                        meta: {},
                        ...body,
                    };
                    state.proxyHosts.push(created);
                    return send(res, 201, created);
                }
                Object.assign(item!, body);
                return send(res, 200, item);
            }
            if (req.method === 'DELETE') {
                state.proxyHosts.splice(state.proxyHosts.indexOf(item!), 1);
                return send(res, 200, true);
            }
        } else {
            if (req.method === 'GET' && id === undefined) {
                return send(res, 200, mine(list));
            }
            if (req.method === 'POST' && match[3]) {
                item!.expires_on = new Date(Date.now() + 90 * DAY).toISOString();
                return send(res, 200, item);
            }
            if (req.method === 'POST') {
                const bad = unknownField(body, CERT_FIELDS);
                if (bad) {
                    return error(res, 400, `data must NOT have additional properties (${bad})`);
                }
                const meta = (body.meta ?? {}) as Record<string, unknown>;
                const badMeta = Object.keys(meta).find((key) => !CERT_META.has(key));
                if (badMeta) {
                    return error(res, 400, `data/meta must NOT have additional properties (${badMeta})`);
                }
                if (typeof meta.dns_provider_credentials === 'string') {
                    state.dnsCredentials.push(meta.dns_provider_credentials);
                }
                const { dns_provider_credentials: _hidden, ...shown } = meta;
                void _hidden;
                const created = {
                    id: state.nextId++,
                    owner_user_id: me.id,
                    provider: body.provider,
                    nice_name: body.nice_name ?? '',
                    domain_names: body.domain_names,
                    expires_on: new Date(Date.now() + 90 * DAY).toISOString(),
                    meta: shown,
                    // What certbot would register: the owner's address.
                    letsencrypt_email: me.email,
                };
                state.certificates.push(created);
                return send(res, 201, created);
            }
            if (req.method === 'DELETE') {
                state.certificates.splice(state.certificates.indexOf(item!), 1);
                return send(res, 200, true);
            }
        }
        return error(res, 405, 'Method not allowed');
    };

    const server = createServer((req, res) => {
        handle(req, res).catch((cause: unknown) => error(res, 500, cause instanceof Error ? cause.message : 'failed'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}/api`,
        users,
        state,
        /** Items another NPM user owns: this module's user never sees them. */
        seed(kind: 'proxyHosts' | 'certificates', item: Record<string, unknown>) {
            const created = { id: state.nextId++, ...item };
            state[kind].push(created);
            return created;
        },
        revokeTokens() {
            state.tokens.clear();
        },
        writes() {
            return state.requests.filter((request) => request.method !== 'GET' && request.path !== '/api/tokens');
        },
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
export type FakeNpm = Awaited<ReturnType<typeof startFakeNpm>>;
