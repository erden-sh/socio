import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateUrl } from '../src/net/public-address.js';
import { webStoreOn } from '../src/server/composition/integration-stores.js';
import type { WebSettings } from '../src/server/web/contract.js';
import {
    BROWSER_IDENTITY_MESSAGE,
    WebReads,
    agentUserAgent,
    auditPath,
    webSettingsFromEnv,
    type Resolver,
} from '../src/server/web/web-reads.js';
import { selectJson, webCapabilityFor, webTools } from '../src/server/web/web-tools.js';

import { testDatabase } from './helpers/test-database.js';
import { takeEgressAttempts } from './setup/egress-guard.js';

// A local fake web: names under `.example` are pinned to the loopback
// fixture (any port); every other name goes through the real public-address
// check, so private targets and redirects to them are refused for real.
const resolve: Resolver = async (url) =>
    url.hostname.endsWith('.example') ? { address: '127.0.0.1', family: 4 } : validateUrl(url.href);

interface Seen {
    url: string;
    headers: IncomingHttpHeaders;
    method: string;
}
let server: Server;
let port: number;
let seen: Seen[];
const hits = (path: string) => seen.filter((s) => s.url === path).length;
const at = (path: string, host = 'public.example') => `http://${host}:${port}${path}`;

beforeEach(async () => {
    seen = [];
    server = createServer((request, response) => {
        const url = request.url ?? '/';
        seen.push({ url, headers: request.headers, method: request.method ?? '' });
        const route = url.split('?')[0];
        if (route === '/echo') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(request.headers));
        } else if (route === '/text') {
            response.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store',
            });
            response.end('x'.repeat(5000));
        } else if (route === '/fresh') {
            response.writeHead(200, {
                'Content-Type': 'text/plain',
                'Cache-Control': 'max-age=60',
            });
            response.end(`fresh ${hits('/fresh')}`);
        } else if (route === '/nostore') {
            response.writeHead(200, {
                'Content-Type': 'text/plain',
                'Cache-Control': 'no-store',
            });
            response.end('nostore');
        } else if (route === '/etag') {
            if (request.headers['if-none-match'] === '"v1"') {
                response.writeHead(304, { ETag: '"v1"', 'Cache-Control': 'no-cache' });
                response.end();
            } else {
                response.writeHead(200, {
                    'Content-Type': 'text/plain',
                    ETag: '"v1"',
                    'Cache-Control': 'no-cache',
                });
                response.end('etag body');
            }
        } else if (route === '/big') {
            response.writeHead(200, { 'Content-Type': 'text/plain' });
            response.end('b'.repeat(5000));
        } else if (route === '/gzip') {
            response.writeHead(200, {
                'Content-Type': 'text/plain',
                'Content-Encoding': 'gzip',
            });
            response.end(gzipSync('z'.repeat(1_000_000)));
        } else if (route === '/slow') {
            request.on('close', () => response.destroy());
        } else if (route === '/429') {
            response.writeHead(429, { 'Retry-After': '120' });
            response.end('slow down');
        } else if (route === '/403') {
            response.writeHead(403);
            response.end('no agents');
        } else if (route === '/to-private') {
            response.writeHead(302, { Location: 'http://10.0.0.7/admin' });
            response.end();
        } else if (route === '/to-metadata') {
            response.writeHead(302, {
                Location: 'http://169.254.169.254/latest/meta-data',
            });
            response.end();
        } else if (route === '/to-loopback') {
            response.writeHead(301, { Location: `http://localhost:${port}/echo` });
            response.end();
        } else if (route === '/to-file') {
            response.writeHead(302, { Location: 'file:///etc/passwd' });
            response.end();
        } else if (route === '/to-other') {
            response.writeHead(302, { Location: at('/echo', 'other.example') });
            response.end();
        } else if (route.startsWith('/chain/')) {
            const left = Number(route.slice(7));
            if (left === 0) {
                response.writeHead(200, { 'Content-Type': 'text/plain' });
                response.end('end of chain');
            } else {
                response.writeHead(302, { Location: `/chain/${left - 1}` });
                response.end();
            }
        } else if (route === '/data') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(
                JSON.stringify({
                    data: {
                        items: [
                            { id: 1, name: 'one' },
                            { id: 2, name: 'two' },
                        ],
                    },
                }),
            );
        } else if (route === '/image') {
            response.writeHead(200, { 'Content-Type': 'image/png' });
            response.end(Buffer.from([137, 80, 78, 71]));
        } else {
            response.writeHead(404);
            response.end();
        }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    expect(takeEgressAttempts()).toEqual([]);
});

const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));

function reader(overrides: Partial<WebSettings> = {}, options: { now?: () => number; resolver?: Resolver } = {}) {
    const db = testDatabase();
    dbs.push(db);
    return new WebReads(
        webStoreOn(db),
        {
            ...webSettingsFromEnv({ APP_ORIGIN: 'https://brain.example.com' }),
            ...overrides,
        },
        { resolve: options.resolver ?? resolve, now: options.now },
    );
}
const read = (reads: WebReads, url: string, extra = {}) =>
    reads.read({ dotId: 'dot-1', userId: 'alice', url, ...extra });

describe('identity', () => {
    it('declares the exact agent User-Agent and nothing about the user', async () => {
        const settings = webSettingsFromEnv({
            APP_ORIGIN: 'https://brain.example.com/, https://second.example.com',
        });
        expect(settings.userAgent).toBe('SocioAgent/1.0 (user-directed agent; +https://brain.example.com/agents)');
        expect(agentUserAgent(undefined)).toBe('SocioAgent/1.0 (user-directed agent)');
        const reads = reader();
        const result = await reads.read({
            dotId: 'dot-1',
            userId: 'alice.smith@corp.example',
            url: at('/echo'),
        });
        expect(result.ok && result.status).toBe(200);
        const request = seen[0];
        expect(request.headers['user-agent']).toBe(
            'SocioAgent/1.0 (user-directed agent; +https://brain.example.com/agents)',
        );
        // Only these go out: no From, Referer, Cookie, Authorization or tracking.
        expect(Object.keys(request.headers).sort()).toEqual([
            'accept',
            'accept-encoding',
            'connection',
            'host',
            'user-agent',
        ]);
        const sent = JSON.stringify(request);
        expect(sent).not.toMatch(/alice|smith|corp\.example|dot-1/i);
    });

    it('never puts AGENTS_CONTACT in requests', async () => {
        const reads = reader({ contact: 'mailto:ops@corp.example' });
        await read(reads, at('/echo'));
        expect(JSON.stringify(seen[0].headers)).not.toContain('ops@');
    });

    it('switches per Dot: browser identity refers to the computer browser and sends nothing', async () => {
        const reads = reader();
        await reads.store.setIdentity('dot-1', 'browser', 'admin-1');
        const result = await read(reads, at('/echo'));
        expect(result).toEqual({
            ok: false,
            reason: 'browser_identity',
            message: BROWSER_IDENTITY_MESSAGE,
        });
        expect(seen).toHaveLength(0);
        // Another Dot keeps the default, agent.
        expect((await reads.read({ dotId: 'dot-2', url: at('/echo') })).ok).toBe(true);
        await reads.store.setIdentity('dot-1', null, 'admin-1');
        expect((await read(reads, at('/echo'))).ok).toBe(true);
        expect(
            (await reads.status('dot-1', true))
                .audit!.filter((entry) => entry.method === 'SET')
                .map((entry) => [entry.outcome, entry.userId]),
        ).toEqual([
            ['identity:default', 'admin-1'],
            ['identity:browser', 'admin-1'],
        ]);
    });

    it('takes the default identity from WEB_IDENTITY_DEFAULT', async () => {
        expect(webSettingsFromEnv({}).identityDefault).toBe('agent');
        const reads = reader(webSettingsFromEnv({ WEB_IDENTITY_DEFAULT: 'browser' }));
        expect(await reads.identity('dot-1')).toBe('browser');
        expect((await read(reads, at('/echo'))).ok).toBe(false);
        await reads.store.setIdentity('dot-1', 'agent', 'admin-1');
        expect((await read(reads, at('/echo'))).ok).toBe(true);
        expect(() => webSettingsFromEnv({ WEB_IDENTITY_DEFAULT: 'crawler' })).toThrow('WEB_IDENTITY_DEFAULT');
        expect(() => webSettingsFromEnv({ AGENTS_CONTACT: 'ops' })).toThrow('AGENTS_CONTACT');
        expect(() => webSettingsFromEnv({ WEB_MAX_BYTES: '10' })).toThrow('WEB_MAX_BYTES');
    });
});

describe('request headers', () => {
    it('forwards the allowlisted headers', async () => {
        const reads = reader();
        await read(reads, at('/echo'), {
            headers: { 'Accept-Language': 'fr', Accept: 'text/csv' },
        });
        expect(seen[0].headers['accept-language']).toBe('fr');
        expect(seen[0].headers.accept).toBe('text/csv');
    });

    it('refuses cookies, Authorization and any other header, by name', async () => {
        const reads = reader();
        for (const name of ['Cookie', 'Authorization', 'From', 'X-Forwarded-For']) {
            const result = await read(reads, at('/echo'), {
                headers: { [name]: 'value' },
            });
            expect(result.ok, name).toBe(false);
            expect(!result.ok && result.reason).toBe('invalid');
            expect(!result.ok && result.message).toContain(`"${name}" is not allowed`);
        }
        expect(seen).toHaveLength(0);
    });
});

describe('network guards', () => {
    it('refuses private, local and special addresses with the real check', async () => {
        const reads = reader({}, { resolver: async (url) => validateUrl(url.href) });
        for (const url of [
            'http://127.0.0.1/',
            'http://10.1.2.3/',
            'http://192.168.1.1/',
            'http://169.254.169.254/latest/meta-data',
            'http://[::1]/',
            'http://localhost/',
            'http://printer.local/',
            `http://8.8.8.8:${port}/`,
        ]) {
            const result = await read(reads, url);
            expect(!result.ok && result.reason, url).toBe('blocked');
        }
        for (const url of ['file:///etc/passwd', 'ftp://public.example/', 'http://user:pw@public.example/']) {
            const result = await read(reads, url);
            expect(!result.ok && result.reason, url).toBe('invalid');
        }
        expect(seen).toHaveLength(0);
    });

    it('follows redirects only to public addresses', async () => {
        const reads = reader();
        for (const path of ['/to-private', '/to-metadata', '/to-loopback', '/to-file']) {
            const result = await read(reads, at(path));
            expect(!result.ok && result.reason, path).toBe('blocked');
        }
        // Only the redirecting requests reached the fixture.
        expect(seen.map((s) => s.url)).toEqual(['/to-private', '/to-metadata', '/to-loopback', '/to-file']);
        const other = await read(reads, at('/to-other'));
        expect(other.ok && [other.status, other.redirects, other.url]).toEqual([200, 1, at('/echo', 'other.example')]);
    });

    it('follows at most five redirects', async () => {
        const reads = reader();
        const five = await read(reads, at('/chain/5'));
        expect(five.ok && five.body.toString()).toBe('end of chain');
        const six = await read(reads, at('/chain/6'));
        expect(!six.ok && six.message).toContain('Too many redirects');
    });

    it('caps the size of a body, compressed or not', async () => {
        const reads = reader({ maxBytes: 1024 });
        const big = await read(reads, at('/big'));
        expect(big.ok && [big.bytes, big.complete]).toEqual([1024, false]);
        const gzip = await read(reads, at('/gzip'));
        expect(gzip.ok && [gzip.bytes, gzip.complete]).toEqual([1024, false]);
        expect(gzip.ok && gzip.body.toString()).toBe('z'.repeat(1024));
    });

    it('gives up after the timeout', async () => {
        const reads = reader({ timeoutMs: 150 });
        const started = Date.now();
        const result = await read(reads, at('/slow'));
        expect(!result.ok && result.reason).toBe('timeout');
        expect(Date.now() - started).toBeLessThan(5000);
    });
});

describe('rate limits', () => {
    it('limits each Dot per host, refilling over time', async () => {
        let now = 1_000_000;
        const reads = reader({ perHostPerMinute: 3, globalPerMinute: 100 }, { now: () => now });
        for (let i = 0; i < 3; i++) {
            expect((await read(reads, at('/nostore'))).ok).toBe(true);
        }
        const limited = await read(reads, at('/nostore'));
        expect(!limited.ok && limited.reason).toBe('rate_limited');
        expect(!limited.ok && limited.retryAfterSeconds).toBe(20);
        expect(hits('/nostore')).toBe(3);
        // Another host, and another Dot on the same host, have their own buckets.
        expect((await read(reads, at('/nostore', 'other.example'))).ok).toBe(true);
        expect((await reads.read({ dotId: 'dot-2', url: at('/nostore') })).ok).toBe(true);
        now += 20_000;
        expect((await read(reads, at('/nostore'))).ok).toBe(true);
        expect((await read(reads, at('/nostore'))).ok).toBe(false);
    });

    it('limits all Dots together', async () => {
        const reads = reader({ perHostPerMinute: 100, globalPerMinute: 2 });
        expect((await read(reads, at('/nostore'))).ok).toBe(true);
        expect((await reads.read({ dotId: 'dot-2', url: at('/nostore', 'b.example') })).ok).toBe(true);
        const limited = await reads.read({
            dotId: 'dot-3',
            url: at('/nostore', 'c.example'),
        });
        expect(!limited.ok && limited.message).toContain('in all');
    });
});

describe('caching', () => {
    it('serves fresh responses from the cache without a request', async () => {
        const reads = reader();
        const first = await read(reads, at('/fresh'));
        const second = await read(reads, at('/fresh'));
        expect(first.ok && first.cached).toBe(false);
        expect(second.ok && [second.cached, second.body.toString()]).toEqual([true, 'fresh 1']);
        expect(hits('/fresh')).toBe(1);
    });

    it('respects no-store', async () => {
        const reads = reader();
        await read(reads, at('/nostore'));
        await read(reads, at('/nostore'));
        expect(hits('/nostore')).toBe(2);
    });

    it('revalidates with the ETag and serves the cached body on 304', async () => {
        const reads = reader();
        const first = await read(reads, at('/etag'));
        const second = await read(reads, at('/etag'));
        expect(seen.map((s) => s.headers['if-none-match'])).toEqual([undefined, '"v1"']);
        expect(first.ok && first.body.toString()).toBe('etag body');
        expect(
            second.ok && [second.status, second.cached, second.revalidated, second.body.toString(), second.contentType],
        ).toEqual([200, true, true, 'etag body', 'text/plain']);
    });

    it("passes a Dot's own conditional request through", async () => {
        const reads = reader();
        const result = await read(reads, at('/etag'), {
            headers: { 'If-None-Match': '"v1"' },
        });
        expect(result.ok && result.status).toBe(304);
    });

    it('expires the default TTL', async () => {
        let now = 5_000_000;
        const reads = reader({ cacheTtlMs: 1000 }, { now: () => now });
        await read(reads, at('/data'));
        await read(reads, at('/data'));
        expect(hits('/data')).toBe(1);
        now += 1500;
        await read(reads, at('/data'));
        expect(hits('/data')).toBe(2);
    });
});

describe('backoff after a refusal', () => {
    it('stops reading from a host after 429, for Retry-After', async () => {
        let now = 10_000_000;
        const reads = reader({}, { now: () => now });
        const refused = await read(reads, at('/429'));
        expect(refused.ok && refused.status).toBe(429);
        expect(refused.ok && refused.notice).toContain('paused for 2 minutes');
        // The whole host pauses, for every Dot.
        const stopped = await reads.read({ dotId: 'dot-2', url: at('/echo') });
        expect(!stopped.ok && [stopped.reason, stopped.retryAfterSeconds]).toEqual(['host_stopped', 120]);
        expect(!stopped.ok && stopped.message).toContain('HTTP 429');
        expect(hits('/echo')).toBe(0);
        expect((await read(reads, at('/echo', 'other.example'))).ok).toBe(true);
        expect((await reads.status('dot-1', false)).stoppedHosts).toEqual([
            { host: `public.example:${port}`, status: 429, until: 10_120_000 },
        ]);
        now += 121_000;
        expect((await read(reads, at('/echo'))).ok).toBe(true);
    });

    it('stops after 403 for the cooldown', async () => {
        let now = 20_000_000;
        const reads = reader({ cooldownMs: 600_000 }, { now: () => now });
        const refused = await read(reads, at('/403'));
        expect(refused.ok && refused.notice).toContain('10 minutes');
        expect((await read(reads, at('/echo'))).ok).toBe(false);
        now += 600_001;
        expect((await read(reads, at('/echo'))).ok).toBe(true);
    });
});

describe('audit', () => {
    it('records Dot, user, host, path without query values, status and bytes', async () => {
        const reads = reader({ perHostPerMinute: 2 });
        await read(reads, at('/echo?q=secret+plans&token=abc&q=more'));
        await read(reads, at('/to-private'));
        await read(reads, at('/echo'));
        const audit = (await reads.status('dot-1', true)).audit!.reverse();
        expect(
            audit.map(({ userId, method, host, path, status, outcome }) => ({
                userId,
                method,
                host,
                path,
                status,
                outcome,
            })),
        ).toEqual([
            {
                userId: 'alice',
                method: 'GET',
                host: `public.example:${port}`,
                path: '/echo?q=&token=',
                status: 200,
                outcome: 'fetched',
            },
            {
                userId: 'alice',
                method: 'GET',
                host: `public.example:${port}`,
                path: '/to-private',
                status: 302,
                outcome: 'redirect',
            },
            {
                userId: 'alice',
                method: 'GET',
                host: '10.0.0.7',
                path: '/admin',
                status: null,
                outcome: 'blocked',
            },
            {
                userId: 'alice',
                method: 'GET',
                host: `public.example:${port}`,
                path: '/echo',
                status: null,
                outcome: 'rate_limited',
            },
        ]);
        expect(audit[0].bytes).toBeGreaterThan(0);
        // The audit line's `id` is a random UUID whose hex may contain substrings
        // like "abc"; drop it before stringifying so UUID entropy cannot trip the
        // leak check (CB-296). Query values must not appear in any other field.
        expect(JSON.stringify(audit, (key, value) => (key === 'id' ? undefined : value))).not.toMatch(
            /secret|abc|more/,
        );
        expect((await reads.status('dot-1', false)).audit).toBeUndefined();
        expect(auditPath(new URL('https://a.example/p/x?k=v#frag'))).toBe('/p/x?k=');
    });
});

describe('tools', () => {
    const tools = (reads: WebReads) => {
        const [get, json] = webTools(
            reads,
            'dot-1',
            () => {},
            new AbortController().signal,
            'alice',
        ) as unknown as Array<{
            name: string;
            execute: (input: unknown) => Promise<Record<string, unknown>>;
        }>;
        return { get, json };
    };

    it('http_get returns status, type, size and a truncated body', async () => {
        const { get } = tools(reader());
        expect(get.name).toBe('http_get');
        const result = await get.execute({ url: at('/text'), max_chars: 1000 });
        expect(result).toMatchObject({
            status: 200,
            content_type: 'text/plain; charset=utf-8',
            bytes: 5000,
            complete: true,
            truncated: true,
            body_chars: 5000,
        });
        expect(result.body).toBe('x'.repeat(1000));
        const head = await get.execute({ url: at('/text'), method: 'HEAD' });
        expect(head).toMatchObject({ status: 200, bytes: 0 });
        expect(head).not.toHaveProperty('body');
        expect(seen.at(-1)!.method).toBe('HEAD');
        const image = await get.execute({ url: at('/image') });
        expect(image).toMatchObject({ body: null, bytes: 4 });
        const refused = await get.execute({
            url: at('/echo'),
            headers: { Authorization: 'Bearer x' },
        });
        expect(refused).toMatchObject({ reason: 'invalid' });
    });

    it('http_json parses and selects with a query', async () => {
        const { json } = tools(reader());
        expect(json.name).toBe('http_json');
        expect(await json.execute({ url: at('/data'), query: 'data.items[*].id' })).toMatchObject({
            status: 200,
            value: [1, 2],
        });
        expect(seen[0].headers.accept).toBe('application/json');
        expect(await json.execute({ url: at('/data'), query: 'data.items[1].name' })).toMatchObject({
            value: 'two',
            cached: true,
        });
        expect(await json.execute({ url: at('/data'), query: 'nope.x' })).toMatchObject({
            value: null,
            note: 'The query matched nothing.',
        });
        const small = await json.execute({
            url: at('/data'),
            max_chars: 200,
            query: 'data',
        });
        expect(small).toMatchObject({ value: { items: expect.any(Array) } });
        expect(await json.execute({ url: at('/text') })).toMatchObject({
            error: 'The response is not valid JSON.',
        });
    });

    it('selectJson walks keys, indexes and wildcards', () => {
        const value = { a: [{ b: 1 }, { b: 2 }], c: { d: { e: 'x' } } };
        expect(selectJson(value, 'a[*].b')).toEqual([1, 2]);
        expect(selectJson(value, 'a.1.b')).toBe(2);
        expect(selectJson(value, 'c.d.e')).toBe('x');
        expect(selectJson(value, 'c.*.e')).toEqual(['x']);
        expect(selectJson(value, 'z.y')).toBeUndefined();
    });

    it('offers the web-read capability description', async () => {
        const reads = reader();
        expect(await webCapabilityFor(reads, 'dot-1')).toMatchObject({
            id: 'web_reads',
            available: true,
            identity: 'agent',
            tools: ['http_get', 'http_json'],
        });
        await reads.store.setIdentity('dot-1', 'browser', 'admin');
        expect(await webCapabilityFor(reads, 'dot-1')).toMatchObject({
            available: false,
            identity: 'browser',
            tools: [],
        });
    });
});
