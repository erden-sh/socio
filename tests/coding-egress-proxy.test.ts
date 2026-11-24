import {
    createServer as createHttpServer,
    request as httpRequest,
    type IncomingHttpHeaders,
    type Server as HttpServer,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type AddressInfo, type Server } from 'node:net';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import {
    egressCredentialKey,
    gatewayStampKey,
    signEgressCredential,
    verifyGatewayStamp,
} from '@socio/foundation/actors/keys';

import {
    codingEgressDiagnostics,
    codingEgressProxy,
    DenialLog,
    diagnosticsToken,
    REGISTRY_USER_AGENT,
    rewriteRegistryLinks,
} from '../src/coding-egress/proxy.js';
import {
    DEFAULT_CODING_REGISTRIES,
    parseCodingRegistries,
    readRegistryEntry,
} from '../src/coding-egress/registries.js';
import { inSubnet } from '../src/egress/proxy.js';

import { LOOPBACK_TLS } from './fixtures/loopback-tls.js';

// CB-239: the coding egress proxy, against loopback fakes of Socio's
// gateway listener and of a TLS registry.

const SECRET = 'coding-egress-secret-for-tests-only-0123456789';
const CANARY = 'header-or-body-canary-5d1e';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const listen = async (server: Server | HttpServer) => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(
        () =>
            new Promise((resolve) => {
                (server as HttpServer).closeAllConnections?.();
                server.close(resolve);
            }),
    );
    return (server.address() as AddressInfo).port;
};

interface Seen {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body: string;
}

/** Socio's gateway listener: records what reached it. */
async function fakeGateway() {
    const seen: Seen[] = [];
    const closed: string[] = [];
    let hold: ((write: (chunk: string) => void, end: () => void) => void) | undefined;
    const server = createHttpServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => (body += chunk));
        request.on('end', () => {
            seen.push({
                method: request.method ?? '',
                url: request.url ?? '',
                headers: request.headers,
                body,
            });
            if (hold) {
                response.writeHead(200, { 'content-type': 'text/event-stream' });
                response.on('close', () => closed.push(request.url ?? ''));
                hold(
                    (chunk) => response.write(chunk),
                    () => response.end(),
                );
                return;
            }
            response
                .writeHead(200, {
                    'content-type': 'application/json',
                    'set-cookie': `session=${CANARY}`,
                })
                .end('{"ok":true}');
        });
    });
    return {
        port: await listen(server),
        seen,
        closed,
        stream(fn: typeof hold) {
            hold = fn;
        },
    };
}

const npmPackument = JSON.stringify({
    name: 'left-pad',
    versions: {
        '1.0.0': {
            dist: {
                tarball: 'https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz',
            },
        },
    },
    homepage: 'https://registry.npmjs.org.evil.example/x',
});
const simpleHtml =
    '<a href="https://files.pythonhosted.org/packages/ab/cd/foo-1.0.tar.gz#sha256=00">foo-1.0.tar.gz</a>';
const tarball = Buffer.from([0x1f, 0x8b, 8, 0, 1, 2, 3, 4, 5, 255]);

/** A registry over TLS (loopback certificate): records what reached it. */
async function fakeRegistry() {
    const seen: Seen[] = [];
    let connections = 0;
    const server = createHttpsServer({ key: LOOPBACK_TLS.key, cert: LOOPBACK_TLS.cert }, (request, response) => {
        seen.push({
            method: request.method ?? '',
            url: request.url ?? '',
            headers: request.headers,
            body: '',
        });
        const url = request.url ?? '';
        if (url === '/left-pad') {
            return response
                .writeHead(200, {
                    'content-type': 'application/vnd.npm.install-v1+json',
                    'set-cookie': `cf=${CANARY}`,
                    etag: '"v1"',
                })
                .end(npmPackument);
        }
        if (url === '/gz') {
            return response
                .writeHead(200, {
                    'content-type': 'application/json',
                    'content-encoding': 'gzip',
                })
                .end(gzipSync(npmPackument));
        }
        // A compression bomb: small on the wire, 8 MiB of JSON once inflated.
        const bomb = Buffer.from(`{"a":"${'x'.repeat(8 * 1024 * 1024)}"}`);
        const bombs: Record<string, [string, Buffer]> = {
            '/bomb-gzip': ['gzip', gzipSync(bomb)],
            '/bomb-deflate': ['deflate', deflateSync(bomb)],
            '/bomb-br': ['br', brotliCompressSync(bomb)],
        };
        if (bombs[url]) {
            return response
                .writeHead(200, {
                    'content-type': 'application/json',
                    'content-encoding': bombs[url][0],
                })
                .end(bombs[url][1]);
        }
        if (url === '/simple/foo/') {
            return response.writeHead(200, { 'content-type': 'text/html' }).end(simpleHtml);
        }
        if (url === '/escaped') {
            return response
                .writeHead(200, { 'content-type': 'application/json' })
                .end('{"u":"https:\\/\\/files.pythonhosted.org\\/packages\\/x.whl"}');
        }
        if (url === '/left-pad/-/left-pad-1.0.0.tgz') {
            return response
                .writeHead(200, {
                    'content-type': 'application/octet-stream',
                    'content-length': String(tarball.length),
                })
                .end(tarball);
        }
        if (url === '/moved') {
            return response
                .writeHead(302, {
                    location: 'https://files.pythonhosted.org/packages/y.whl',
                })
                .end();
        }
        response.writeHead(404).end();
    });
    server.on('secureConnection', () => connections++);
    return {
        port: await listen(server),
        seen,
        connections: () => connections,
    };
}

function credential(
    change: Partial<{
        sandboxId: string;
        allow: string[];
        subnet: string;
        expiresAt: number;
    }> = {},
    secret = SECRET,
) {
    const { user, password } = signEgressCredential(egressCredentialKey(secret), {
        sandboxId: 'sbx-a1',
        allow: ['npm=registry.npmjs.org', 'pypi=pypi.org', 'pypi-files=files.pythonhosted.org'],
        subnet: '127.0.0.0/8',
        expiresAt: Date.now() + 3_600_000,
        ...change,
    });
    return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

async function setup(
    options: {
        isPublic?: boolean;
        now?: () => number;
        maxRewriteBytes?: number;
    } = {},
) {
    const gateway = await fakeGateway();
    const registry = await fakeRegistry();
    const logs: string[] = [];
    const denials = new DenialLog();
    const server = codingEgressProxy({
        secret: SECRET,
        gatewayUpstream: `http://127.0.0.1:${gateway.port}`,
        log: (line) => logs.push(line),
        lookup: async () => [{ address: '127.0.0.1' }],
        isPublic: () => options.isPublic ?? true,
        registryPort: registry.port,
        registryTls: {
            ca: LOOPBACK_TLS.cert,
            checkServerIdentity: () => undefined,
        },
        denials,
        ...(options.now ? { now: options.now } : {}),
        ...(options.maxRewriteBytes ? { maxRewriteBytes: options.maxRewriteBytes } : {}),
    });
    const port = await listen(server);
    return { gateway, registry, logs, denials, port };
}

interface Answer {
    status: number;
    headers: IncomingHttpHeaders;
    body: Buffer;
}

/** One proxied request, absolute-form, as a package manager sends it. */
function send(port: number, method: string, url: string, headers: Record<string, string> = {}, body?: string) {
    return new Promise<Answer>((resolve, reject) => {
        const request = httpRequest({ host: '127.0.0.1', port, method, path: url, headers }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () =>
                resolve({
                    status: response.statusCode ?? 0,
                    headers: response.headers,
                    body: Buffer.concat(chunks),
                }),
            );
        });
        request.on('error', reject);
        request.end(body);
    });
}

/** Raw bytes to the proxy; resolves with what came back. */
function raw(port: number, text: string) {
    return new Promise<string>((resolve) => {
        const socket = connect(port, '127.0.0.1');
        let received = '';
        socket.on('data', (data) => (received += data.toString()));
        socket.on('close', () => resolve(received));
        socket.on('error', () => resolve(received));
        socket.write(text);
    });
}

describe('refusals (negative cases first)', () => {
    it('opens no CONNECT tunnel to any host, with or without a credential', async () => {
        const { port, registry, gateway, logs, denials } = await setup();
        for (const target of [
            'registry.npmjs.org:443',
            'npm.registry.socio.internal:80',
            'gateway.socio.internal:80',
            `127.0.0.1:${registry.port}`,
            'api.openai.com:443',
        ]) {
            const answer = await raw(
                port,
                `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${credential()}\r\n\r\n`,
            );
            expect(answer, target).toMatch(/^HTTP\/1\.1 403 Forbidden/);
        }
        expect(await raw(port, 'CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1\.1 407/);
        expect(registry.connections()).toBe(0);
        expect(gateway.seen).toHaveLength(0);
        expect(logs[0]).toBe('coding-egress: denied CONNECT registry.npmjs.org:443 for sbx-a1');
        expect(denials.forSandbox('sbx-a1').map((entry) => entry.target)).toContain('api.openai.com:443');
    });

    it('refuses missing, forged, expired and tampered credentials with 407', async () => {
        const { port, registry, gateway } = await setup();
        const forged = credential({}, 'another-secret-entirely-0123456789');
        const expired = credential({ expiresAt: Date.now() - 1000 });
        // The allowlist widened after signing: the MAC no longer matches.
        const good = Buffer.from(credential().slice(6), 'base64').toString();
        const [user, password] = good.split(':');
        const claims = JSON.parse(Buffer.from(user, 'base64url').toString());
        claims.a.push('evil=evil.example.com');
        const widened = `Basic ${Buffer.from(
            `${Buffer.from(JSON.stringify(claims)).toString('base64url')}:${password}`,
        ).toString('base64')}`;
        for (const header of [
            undefined,
            forged,
            expired,
            widened,
            'Bearer cbgw_x',
            `Basic ${Buffer.from(':nouser').toString('base64')}`,
        ]) {
            const answer = await send(
                port,
                'GET',
                'http://npm.registry.socio.internal/left-pad',
                header ? { 'proxy-authorization': header } : {},
            );
            expect(answer.status, String(header)).toBe(407);
            expect(answer.headers['proxy-authenticate']).toMatch(/^Basic/);
        }
        expect(registry.seen).toHaveLength(0);
        expect(gateway.seen).toHaveLength(0);
    });

    it('refuses a credential used from outside its subnet', async () => {
        const { port, registry, gateway, logs, denials } = await setup();
        const elsewhere = credential({ subnet: '10.213.0.16/28' });
        for (const url of ['http://npm.registry.socio.internal/left-pad', 'http://gateway.socio.internal/v1/models']) {
            const answer = await send(port, 'GET', url, {
                'proxy-authorization': elsewhere,
            });
            expect(answer.status).toBe(403);
        }
        expect(
            await raw(port, `CONNECT registry.npmjs.org:443 HTTP/1.1\r\nProxy-Authorization: ${elsewhere}\r\n\r\n`),
        ).toMatch(/^HTTP\/1\.1 403/);
        expect(registry.seen).toHaveLength(0);
        expect(gateway.seen).toHaveLength(0);
        expect(logs[0]).toBe('coding-egress: denied GET npm.registry.socio.internal:80 for sbx-a1 (wrong network)');
        expect(denials.forSandbox('sbx-a1').map((entry) => [entry.target, entry.count])).toEqual([
            ['npm.registry.socio.internal:80', 1],
            ['gateway.socio.internal:80', 1],
            ['registry.npmjs.org:443', 1],
        ]);
    });

    it('refuses a publish or upload before any registry connection', async () => {
        const { port, registry, logs } = await setup();
        const auth = { 'proxy-authorization': credential() };
        for (const method of ['PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS']) {
            const answer = await send(
                port,
                method,
                'http://npm.registry.socio.internal/left-pad',
                {
                    ...auth,
                    'content-type': 'application/json',
                    authorization: `Bearer ${CANARY}`,
                },
                method === 'OPTIONS' ? undefined : `{"_attachments":"${CANARY}"}`,
            );
            expect(answer.status, method).toBe(403);
        }
        // A GET that carries a body is no download either.
        const withBody = await send(
            port,
            'GET',
            'http://npm.registry.socio.internal/left-pad',
            { ...auth, 'content-length': String(CANARY.length) },
            CANARY,
        );
        expect(withBody.status).toBe(403);
        expect(registry.connections()).toBe(0);
        expect(logs).toContain('coding-egress: denied PUT npm.registry.socio.internal:80 for sbx-a1 (read-only)');
        expect(logs.join('\n')).not.toContain(CANARY);
    });

    it('refuses other hosts, ports, origin-form requests and registries not in the credential', async () => {
        const { port, registry, gateway, denials } = await setup();
        const narrow = credential({ allow: ['npm=registry.npmjs.org'] });
        const cases: Array<[string, string]> = [
            ['http://api.openai.com/v1/chat/completions', credential()],
            ['http://registry.npmjs.org/left-pad', credential()],
            ['http://pypi.registry.socio.internal/simple/foo/', narrow],
            ['http://unknown.registry.socio.internal/x', credential()],
            ['http://npm.registry.socio.internal:443/left-pad', credential()],
            ['http://gateway.socio.internal:4340/v1/models', credential()],
            [`http://127.0.0.1:${registry.port}/left-pad`, credential()],
            ['http://user:pw@npm.registry.socio.internal/left-pad', credential()],
            ['/v1/models', credential()],
        ];
        for (const [url, auth] of cases) {
            const answer = await send(port, 'GET', url, {
                'proxy-authorization': auth,
            });
            expect(answer.status, url).toBe(403);
        }
        expect(registry.seen).toHaveLength(0);
        expect(gateway.seen).toHaveLength(0);
        expect(denials.forSandbox('sbx-a1').map((entry) => entry.target)).toEqual(
            expect.arrayContaining(['api.openai.com:80', 'registry.npmjs.org:80', 'pypi.registry.socio.internal:80']),
        );
    });

    it('refuses a registry that resolves to a private address', async () => {
        const { port, registry } = await setup({ isPublic: false });
        const answer = await send(port, 'GET', 'http://npm.registry.socio.internal/left-pad', {
            'proxy-authorization': credential(),
        });
        expect(answer.status).toBe(403);
        expect(registry.connections()).toBe(0);
    });

    it('answers 502 to a compressed answer that inflates past the rewrite limit', async () => {
        const { port, registry } = await setup({ maxRewriteBytes: 64 * 1024 });
        const auth = { 'proxy-authorization': credential() };
        for (const path of ['/bomb-gzip', '/bomb-deflate', '/bomb-br']) {
            const answer = await send(port, 'GET', `http://npm.registry.socio.internal${path}`, auth);
            expect(answer.status, path).toBe(502);
            expect(answer.body.length, path).toBeLessThan(1024);
        }
        expect(registry.seen.map((entry) => entry.url)).toEqual(['/bomb-gzip', '/bomb-deflate', '/bomb-br']);
        // Within the limit, a compressed answer is still rewritten.
        const gz = await send(port, 'GET', 'http://npm.registry.socio.internal/gz', auth);
        expect(gz.status).toBe(200);
        expect(gz.body.toString()).toContain('npm.registry.socio.internal');
    });

    it('refuses gateway methods other than GET, HEAD and POST, and upgrades', async () => {
        const { port, gateway } = await setup();
        for (const method of ['PUT', 'DELETE', 'PATCH']) {
            const answer = await send(port, method, 'http://gateway.socio.internal/v1/models', {
                'proxy-authorization': credential(),
            });
            expect(answer.status, method).toBe(403);
        }
        const upgrade = await send(port, 'GET', 'http://gateway.socio.internal/v1/models', {
            'proxy-authorization': credential(),
            connection: 'upgrade',
            upgrade: 'websocket',
        });
        expect(upgrade.status).toBe(403);
        expect(gateway.seen).toHaveLength(0);
    });
});

describe('the gateway route', () => {
    it('stamps the sandbox, strips client x-cb-* headers and forwards the body', async () => {
        const { port, gateway, logs } = await setup();
        const answer = await send(
            port,
            'POST',
            'http://gateway.socio.internal/v1/chat/completions',
            {
                'proxy-authorization': credential(),
                authorization: 'Bearer cbgw_session-token-stays',
                'content-type': 'application/json',
                'x-cb-sandbox': 'sbx-b2.1.forged',
                'x-cb-user': CANARY,
                'x-forwarded-for': '10.0.0.1',
                cookie: `a=${CANARY}`,
            },
            '{"model":"m","messages":[]}',
        );
        expect(answer.status).toBe(200);
        expect(answer.headers['set-cookie']).toBeUndefined();
        expect(gateway.seen).toHaveLength(1);
        const [seen] = gateway.seen;
        expect(seen).toMatchObject({
            method: 'POST',
            url: '/v1/chat/completions',
            body: '{"model":"m","messages":[]}',
        });
        expect(seen.headers.authorization).toBe('Bearer cbgw_session-token-stays');
        expect(seen.headers['proxy-authorization']).toBeUndefined();
        expect(seen.headers['x-cb-user']).toBeUndefined();
        expect(seen.headers['x-forwarded-for']).toBeUndefined();
        expect(seen.headers.cookie).toBeUndefined();
        expect(seen.headers.host).toBe('gateway.socio.internal');
        expect(
            verifyGatewayStamp(
                gatewayStampKey(SECRET),
                String(seen.headers['x-cb-sandbox']),
                'POST',
                '/v1/chat/completions',
            ),
        ).toBe('sbx-a1');
        // The same stamp for another method or path does not verify.
        expect(
            verifyGatewayStamp(
                gatewayStampKey(SECRET),
                String(seen.headers['x-cb-sandbox']),
                'POST',
                '/git/o/r.git/git-receive-pack',
            ),
        ).toBeUndefined();
        expect(logs).toEqual(['coding-egress: allowed POST gateway.socio.internal:80 for sbx-a1']);
        expect(logs.join('\n')).not.toContain(CANARY);
    });

    it('signs the exact request-target, query included (Git info/refs)', async () => {
        const { port, gateway } = await setup();
        const path = '/git/acme/widgets.git/info/refs?service=git-upload-pack';
        await send(port, 'GET', `http://gateway.socio.internal${path}`, {
            'proxy-authorization': credential(),
        });
        expect(gateway.seen[0].url).toBe(path);
        expect(
            verifyGatewayStamp(gatewayStampKey(SECRET), String(gateway.seen[0].headers['x-cb-sandbox']), 'GET', path),
        ).toBe('sbx-a1');
    });

    it('never stamps two requests of a sandbox alike, so the gateway’s replay check passes them', async () => {
        const at = Date.now();
        const { port, gateway } = await setup({ now: () => at });
        await Promise.all(
            [1, 2, 3].map(() =>
                send(port, 'GET', 'http://gateway.socio.internal/v1/models', {
                    'proxy-authorization': credential(),
                }),
            ),
        );
        const stamps = gateway.seen.map((seen) => String(seen.headers['x-cb-sandbox']));
        expect(new Set(stamps).size).toBe(3);
        for (const stamp of stamps) {
            expect(verifyGatewayStamp(gatewayStampKey(SECRET), stamp, 'GET', '/v1/models', at)).toBe('sbx-a1');
        }
    });

    it('streams answers as they come and aborts upstream when the client goes', async () => {
        const { port, gateway } = await setup();
        let end = () => {};
        let write: (chunk: string) => void = () => {};
        const started = new Promise<void>((resolve) =>
            gateway.stream((w, e) => {
                write = w;
                end = e;
                resolve();
            }),
        );
        const first = new Promise<string>((resolve) => {
            const request = httpRequest(
                {
                    host: '127.0.0.1',
                    port,
                    method: 'POST',
                    path: 'http://gateway.socio.internal/v1/chat/completions',
                    headers: { 'proxy-authorization': credential() },
                },
                (response) => {
                    response.once('data', (chunk) => {
                        resolve(String(chunk));
                        // Gone mid-stream: the upstream must close too.
                        request.destroy();
                    });
                },
            );
            request.on('error', () => {});
            request.end('{}');
        });
        await started;
        write('data: {"delta":1}\n\n');
        expect(await first).toBe('data: {"delta":1}\n\n');
        await expect.poll(() => gateway.closed, { timeout: 5000 }).toEqual(['/v1/chat/completions']);
        end();
    });
});

describe('the registry virtual hosts', () => {
    it('forwards GET over TLS with only the listed headers and rewrites tarball links', async () => {
        const { port, registry, logs } = await setup();
        const answer = await send(port, 'GET', 'http://npm.registry.socio.internal/left-pad', {
            'proxy-authorization': credential(),
            accept: 'application/vnd.npm.install-v1+json',
            authorization: `Bearer npm_${CANARY}`,
            cookie: `c=${CANARY}`,
            'npm-session': CANARY,
            'npm-command': 'publish',
            referer: `install ${CANARY}`,
            'x-npm-otp': CANARY,
            'user-agent': `npm/10 ${CANARY}`,
            'if-none-match': '"v0"',
        });
        expect(answer.status).toBe(200);
        const body = JSON.parse(answer.body.toString());
        expect(body.versions['1.0.0'].dist.tarball).toBe(
            'http://npm.registry.socio.internal/left-pad/-/left-pad-1.0.0.tgz',
        );
        // A look-alike host is not a registry.
        expect(body.homepage).toBe('https://registry.npmjs.org.evil.example/x');
        expect(answer.headers['content-length']).toBe(String(answer.body.length));
        expect(answer.headers['set-cookie']).toBeUndefined();
        expect(answer.headers.etag).toBe('"v1"');
        const [seen] = registry.seen;
        expect(seen.method).toBe('GET');
        expect(seen.url).toBe('/left-pad');
        expect(seen.headers.host).toBe('registry.npmjs.org');
        expect(seen.headers['user-agent']).toBe(REGISTRY_USER_AGENT);
        expect(seen.headers.accept).toBe('application/vnd.npm.install-v1+json');
        expect(seen.headers['if-none-match']).toBe('"v0"');
        expect(JSON.stringify(seen.headers)).not.toContain(CANARY);
        for (const name of ['authorization', 'cookie', 'npm-session', 'referer', 'x-npm-otp']) {
            expect(seen.headers[name], name).toBeUndefined();
        }
        expect(logs).toEqual(['coding-egress: allowed GET npm.registry.socio.internal:80 for sbx-a1']);
    });

    it('rewrites PyPI file links in HTML, escaped JSON and gzipped answers', async () => {
        const { port } = await setup();
        const auth = { 'proxy-authorization': credential() };
        const html = await send(port, 'GET', 'http://pypi.registry.socio.internal/simple/foo/', auth);
        expect(html.body.toString()).toBe(
            '<a href="http://pypi-files.registry.socio.internal/packages/ab/cd/foo-1.0.tar.gz#sha256=00">foo-1.0.tar.gz</a>',
        );
        const escaped = await send(port, 'GET', 'http://pypi.registry.socio.internal/escaped', auth);
        expect(escaped.body.toString()).toBe(
            '{"u":"http:\\/\\/pypi-files.registry.socio.internal\\/packages\\/x.whl"}',
        );
        const gz = await send(port, 'GET', 'http://npm.registry.socio.internal/gz', auth);
        expect(gz.headers['content-encoding']).toBeUndefined();
        expect(JSON.parse(gz.body.toString()).versions['1.0.0'].dist.tarball).toBe(
            'http://npm.registry.socio.internal/left-pad/-/left-pad-1.0.0.tgz',
        );
    });

    it('passes tarballs through unchanged, answers HEAD and rewrites redirects', async () => {
        const { port, registry } = await setup();
        const auth = { 'proxy-authorization': credential() };
        const file = await send(port, 'GET', 'http://npm.registry.socio.internal/left-pad/-/left-pad-1.0.0.tgz', auth);
        expect(file.status).toBe(200);
        expect(file.body.equals(tarball)).toBe(true);
        const head = await send(port, 'HEAD', 'http://npm.registry.socio.internal/left-pad', auth);
        expect(head.status).toBe(200);
        expect(head.body.length).toBe(0);
        expect(registry.seen.at(-1)?.method).toBe('HEAD');
        const moved = await send(port, 'GET', 'http://pypi.registry.socio.internal/moved', auth);
        expect(moved.status).toBe(302);
        expect(moved.headers.location).toBe('http://pypi-files.registry.socio.internal/packages/y.whl');
    });
});

describe('diagnostics', () => {
    it('reports a sandbox’s denials only with the derived bearer token', async () => {
        const denials = new DenialLog(3);
        expect(denials.record('sbx-a1', 'api.openai.com:443')).toBe(true);
        expect(denials.record('sbx-a1', 'api.openai.com:443')).toBe(false);
        denials.record('sbx-b2', 'example.com:80');
        const server = codingEgressDiagnostics(SECRET, denials, {
            subnet: '127.0.0.0/8',
        });
        const port = await listen(server);
        const get = (path: string, token?: string) =>
            new Promise<Answer>((resolve) => {
                httpRequest(
                    {
                        host: '127.0.0.1',
                        port,
                        path,
                        headers: token ? { authorization: `Bearer ${token}` } : {},
                    },
                    (response) => {
                        const chunks: Buffer[] = [];
                        response.on('data', (chunk) => chunks.push(chunk));
                        response.on('end', () =>
                            resolve({
                                status: response.statusCode ?? 0,
                                headers: response.headers,
                                body: Buffer.concat(chunks),
                            }),
                        );
                    },
                ).end();
            });
        expect((await get('/denials/sbx-a1')).status).toBe(401);
        expect((await get('/denials/sbx-a1', diagnosticsToken('another-secret-0123456789'))).status).toBe(401);
        const answer = await get('/denials/sbx-a1', diagnosticsToken(SECRET));
        expect(answer.status).toBe(200);
        const body = JSON.parse(answer.body.toString());
        expect(body.denials).toEqual([expect.objectContaining({ target: 'api.openai.com:443', count: 2 })]);
        expect((await get('/denials/../x', diagnosticsToken(SECRET))).status).toBe(404);
        expect(body.overflow).toBe(0);
    });

    it('closes connections from outside the gateway subnet, and all without one', async () => {
        const denials = new DenialLog();
        denials.record('sbx-a1', 'api.openai.com:443');
        const attempt = async (subnet: string | undefined, path: string) => {
            const logs: string[] = [];
            const server = codingEgressDiagnostics(SECRET, denials, {
                subnet,
                log: (line) => logs.push(line),
            });
            const port = await listen(server);
            const status = await new Promise<number | string>((resolve) => {
                const request = httpRequest(
                    {
                        host: '127.0.0.1',
                        port,
                        path,
                        headers: { authorization: `Bearer ${diagnosticsToken(SECRET)}` },
                    },
                    (response) => {
                        response.resume();
                        resolve(response.statusCode ?? 0);
                    },
                );
                request.on('error', () => resolve('closed'));
                request.end();
            });
            return { status, logs };
        };
        // A sandbox network's address, even with the right token: closed.
        for (const path of ['/denials/sbx-a1', '/healthz']) {
            expect((await attempt('10.213.0.0/24', path)).status, path).toBe('closed');
            const unset = await attempt(undefined, path);
            expect(unset.status, path).toBe('closed');
            expect(unset.logs.join('\n')).toMatch(/CODING_EGRESS_DIAGNOSTICS_SUBNET is not set/);
        }
        expect(() => codingEgressDiagnostics(SECRET, denials, { subnet: '10.0.0.0' })).toThrow(
            /CODING_EGRESS_DIAGNOSTICS_SUBNET/,
        );
        expect((await attempt('127.0.0.0/8', '/denials/sbx-a1')).status).toBe(200);
    });

    it('keeps a sandbox’s first denials however much another sprays', () => {
        const denials = new DenialLog();
        expect(denials.record('sbx-a1', 'exfil.example.com:80')).toBe(true);
        for (let index = 0; index < 20_000; index++) {
            denials.record('sbx-b2', `h${index}.example.com:80`);
        }
        expect(denials.forSandbox('sbx-a1')).toEqual([
            expect.objectContaining({ target: 'exfil.example.com:80', count: 1 }),
        ]);
        // B keeps its earliest targets and counts the rest instead.
        const listed = denials.forSandbox('sbx-b2');
        expect(listed).toHaveLength(256);
        expect(listed[0].target).toBe('h0.example.com:80');
        expect(denials.overflow('sbx-b2')).toBe(20_000 - 256);
        expect(denials.overflow('sbx-a1')).toBe(0);
        // A listed target still counts past the cap.
        denials.record('sbx-b2', 'h0.example.com:80');
        expect(denials.forSandbox('sbx-b2')[0].count).toBe(2);
        expect(denials.overflow('sbx-b2')).toBe(20_000 - 256);
    });

    it('evicts whole sandboxes, least recently denied first, past the global cap', () => {
        let at = 0;
        const denials = new DenialLog(4, () => ++at, 2);
        denials.record('sbx-a1', 'a.example:80');
        denials.record('sbx-b2', 'b.example:80');
        denials.record('sbx-b2', 'c.example:80');
        denials.record('sbx-a1', 'd.example:80');
        // Full (4): C's first denial evicts B, whose last denial is older than A's.
        denials.record('sbx-c3', 'e.example:80');
        expect(denials.forSandbox('sbx-b2')).toEqual([]);
        expect(denials.forSandbox('sbx-a1').map((entry) => entry.target)).toEqual(['a.example:80', 'd.example:80']);
        expect(denials.forSandbox('sbx-c3').map((entry) => entry.target)).toEqual(['e.example:80']);
    });
});

describe('helpers', () => {
    it('parses the registry allowlist strictly', () => {
        expect(parseCodingRegistries(DEFAULT_CODING_REGISTRIES)).toEqual([
            { name: 'npm', host: 'registry.npmjs.org' },
            { name: 'pypi', host: 'pypi.org' },
            { name: 'pypi-files', host: 'files.pythonhosted.org' },
        ]);
        expect(parseCodingRegistries('crates=index.crates.io, Go=proxy.golang.org')).toEqual([
            { name: 'crates', host: 'index.crates.io' },
            { name: 'go', host: 'proxy.golang.org' },
        ]);
        for (const bad of [
            'registry.npmjs.org',
            'npm=127.0.0.1',
            'npm=registry.npmjs.org:443',
            'npm=socio-app.internal',
            'npm=localhost',
            'npm=printer.local',
            'a.b=registry.npmjs.org',
            'npm=*.npmjs.org',
            'npm=registry.npmjs.org npm=other.example.com',
            'npm=registry.npmjs.org other=registry.npmjs.org',
        ]) {
            expect(() => parseCodingRegistries(bad), bad).toThrow(/CODING_EGRESS_ALLOW/);
        }
        expect(readRegistryEntry('npm=registry.npmjs.org=x')).toBeUndefined();
        expect(() =>
            parseCodingRegistries(Array.from({ length: 21 }, (_, i) => `r${i}=r${i}.example.com`).join(' ')),
        ).toThrow(/at most/);
    });

    it('checks subnets for IPv4 and mapped addresses only', () => {
        expect(inSubnet('10.213.0.18', '10.213.0.16/28')).toBe(true);
        expect(inSubnet('::ffff:10.213.0.18', '10.213.0.16/28')).toBe(true);
        expect(inSubnet('10.213.0.32', '10.213.0.16/28')).toBe(false);
        expect(inSubnet('10.213.0.15', '10.213.0.16/28')).toBe(false);
        expect(inSubnet('fd00::1', '10.213.0.16/28')).toBe(false);
        expect(inSubnet('10.213.0.18', 'garbage')).toBe(false);
        expect(inSubnet('300.1.1.1', '0.0.0.0/0')).toBe(false);
    });

    it('rewrites only exact registry hosts', () => {
        const registries = parseCodingRegistries(DEFAULT_CODING_REGISTRIES);
        expect(
            rewriteRegistryLinks(
                'https://registry.npmjs.org/a https://registry.npmjs.org:443/b https://registry.npmjs.org.evil.io/c https://xregistry.npmjs.org/d http://registry.npmjs.org/e',
                registries,
            ),
        ).toBe(
            'http://npm.registry.socio.internal/a http://npm.registry.socio.internal/b https://registry.npmjs.org.evil.io/c https://xregistry.npmjs.org/d http://registry.npmjs.org/e',
        );
    });

    it('refuses a gateway upstream that is not plain internal HTTP', () => {
        for (const upstream of ['https://app:4340', 'http://app:4340/prefix', 'nonsense']) {
            expect(() => codingEgressProxy({ secret: SECRET, gatewayUpstream: upstream })).toThrow();
        }
    });
});
