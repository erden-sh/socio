import { EventEmitter } from 'node:events';
import https from 'node:https';
import { PassThrough } from 'node:stream';

import { afterEach, expect, it, vi } from 'vitest';

import { guardedMcpFetch, mcpUrl, oauthUrl, resolvePublicMcpDestination } from '../src/server/mcp/network.js';

afterEach(() => vi.restoreAllMocks());
const publicAddress = { address: '93.184.216.34', family: 4 };
it('rejects unsafe URL shapes and any private/mixed DNS answer before sending', async () => {
    for (const url of [
        'http://example.test/mcp',
        'https://secret@example.test/mcp',
        'https://example.test:444/mcp',
        'https://localhost/mcp',
        'https://x.local/mcp',
        'https://example.test/mcp#token',
        'https://example.test/mcp?token=secret',
    ]) {
        expect(() => mcpUrl(url)).toThrow();
    }
    expect(oauthUrl('https://login.example.test/authorize?state=opaque').hostname).toBe('login.example.test');
    const request = vi.fn();
    for (const addresses of [
        [{ address: '127.0.0.1', family: 4 }],
        [publicAddress, { address: '::ffff:127.0.0.1', family: 6 }],
        [{ address: '169.254.169.254', family: 4 }],
        [],
    ]) {
        await expect(
            guardedMcpFetch({ lookup: async () => addresses, request })('https://example.test/mcp'),
        ).rejects.toThrow('blocked');
    }
    expect(request).not.toHaveBeenCalled();
});
it('applies the same bounded public destination policy to browser consent URLs without fetching them', async () => {
    const request = vi.fn(),
        lookup = vi.fn(async () => [publicAddress]);
    for (const host of [
        '127.0.0.1',
        '2130706433',
        '0x7f000001',
        '0177.0.0.1',
        '169.254.169.254',
        '[::1]',
        '[::ffff:127.0.0.1]',
        '[::ffff:7f00:1]',
        '10.0.0.1',
        '[fe80::1]',
        '[2001:db8::1]',
    ]) {
        await expect(
            resolvePublicMcpDestination(`https://${host}/authorize?state=opaque`, {
                lookup,
                request,
            }),
        ).rejects.toThrow('blocked');
    }
    expect(lookup).not.toHaveBeenCalled();
    for (const answers of [
        [publicAddress, { address: '127.0.0.1', family: 4 }],
        [{ address: '::ffff:7f00:1', family: 6 }],
        [],
    ]) {
        await expect(
            resolvePublicMcpDestination('https://auth.example.test/authorize', {
                lookup: async () => answers,
                request,
            }),
        ).rejects.toThrow('blocked');
    }
    await expect(
        resolvePublicMcpDestination('https://auth.example.test/authorize', {
            lookup: () => new Promise(() => {}),
            timeoutMs: 5,
        }),
    ).rejects.toThrow('DNS');
    expect(
        (await resolvePublicMcpDestination('https://auth.example.test/authorize?state=opaque', { lookup, request }))
            .address,
    ).toEqual(publicAddress);
    expect(request).not.toHaveBeenCalled();
});
it('uses fresh verified TLS and pinned DNS with explicit protocol headers, without ambient credentials or global proxy agents', async () => {
    const requests: unknown[] = [];
    let writes = 0;
    vi.spyOn(https, 'request').mockImplementation(((
        url: URL,
        options: {
            agent: https.Agent;
            rejectUnauthorized: boolean;
            headers: Record<string, string>;
            lookup: (host: string, settings: { all: boolean }, cb: (...args: unknown[]) => void) => void;
        },
        callback: (r: unknown) => void,
    ) => {
        requests.push(options.agent);
        expect(url.href).toBe('https://example.test/mcp');
        expect(options.agent).not.toBe(https.globalAgent);
        expect(options.agent.options.rejectUnauthorized).toBe(true);
        expect(options.rejectUnauthorized).toBe(true);
        expect(options.headers.authorization).toBe('Bearer fixture-token');
        expect(options.headers['accept-encoding']).toBe('identity');
        const found = vi.fn();
        options.lookup('example.test', { all: true }, found);
        expect(found).toHaveBeenCalledWith(null, [publicAddress]);
        const request = new EventEmitter() as EventEmitter & { end: () => void };
        request.end = () => {
            writes++;
            const response = new PassThrough() as PassThrough & {
                statusCode: number;
                headers: Record<string, string>;
            };
            response.statusCode = 200;
            response.headers = { 'content-type': 'application/json' };
            callback(response);
            response.end('{"ok":true}');
        };
        return request;
    }) as typeof https.request);
    const fetch = guardedMcpFetch({ lookup: async () => [publicAddress] });
    for (let i = 0; i < 2; i++) {
        expect(
            await (
                await fetch('https://example.test/mcp', {
                    method: 'POST',
                    headers: { Authorization: 'Bearer fixture-token' },
                    body: '{}',
                })
            ).json(),
        ).toEqual({ ok: true });
    }
    expect(writes).toBe(2);
    expect(requests[0]).not.toBe(requests[1]);
    for (const name of ['cookie', 'proxy-authorization', 'host', 'x-api-key']) {
        await expect(fetch('https://example.test/mcp', { headers: { [name]: 'secret' } })).rejects.toThrow('Ambient');
    }
    expect(writes).toBe(2);
});
it('never follows redirects or retries a failed business POST', async () => {
    const request = vi.fn(
        async () =>
            new Response(null, {
                status: 302,
                headers: { Location: 'https://127.0.0.1/secret' },
            }),
    );
    await expect(
        guardedMcpFetch({ lookup: async () => [publicAddress], request })('https://example.test/mcp', {
            method: 'POST',
            body: '{}',
            headers: { Authorization: 'Bearer secret' },
        }),
    ).rejects.toThrow('redirects');
    expect(request).toHaveBeenCalledTimes(1);
    for (const status of [401, 403, 500]) {
        const once = vi.fn(async () => new Response('error', { status }));
        const response = await guardedMcpFetch({
            lookup: async () => [publicAddress],
            request: once,
        })('https://example.test/mcp', { method: 'POST', body: '{}' });
        expect(response.status).toBe(status);
        await response.text();
        expect(once).toHaveBeenCalledTimes(1);
    }
});
it('enforces streamed byte limits, rejects compression and includes DNS in the deadline', async () => {
    const fetch = guardedMcpFetch({
        lookup: async () => [publicAddress],
        maxBytes: 10,
        request: async () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode('x'.repeat(11)));
                        controller.close();
                    },
                }),
            ),
    });
    await expect((await fetch('https://example.test/mcp')).text()).rejects.toThrow('size limit');
    await expect(
        guardedMcpFetch({
            lookup: async () => [publicAddress],
            request: async () => new Response('compressed', { headers: { 'content-encoding': 'gzip' } }),
        })('https://example.test/mcp'),
    ).rejects.toThrow('Compressed');
    await expect(
        guardedMcpFetch({ lookup: () => new Promise(() => {}), timeoutMs: 10 })('https://example.test/mcp'),
    ).rejects.toThrow('DNS lookup timed out');
});

it('bounds aggregate requests/bytes and SSE frames across chunks', async () => {
    const fetch = guardedMcpFetch({
        lookup: async () => [publicAddress],
        maxRequests: 2,
        request: async () => new Response('{}'),
    });
    await (await fetch('https://example.test/mcp')).text();
    await (await fetch('https://example.test/mcp')).text();
    await expect(fetch('https://example.test/mcp')).rejects.toThrow('request budget');
    const total = guardedMcpFetch({
        lookup: async () => [publicAddress],
        maxTotalBytes: 3,
        request: async () => new Response('xx'),
    });
    await (await total('https://example.test/mcp')).text();
    await expect((await total('https://example.test/mcp')).text()).rejects.toThrow('response budget');
    for (const text of ['data: ' + 'x'.repeat(65537), 'data: {}\r\n\r\n'.repeat(101)]) {
        const stream = guardedMcpFetch({
            lookup: async () => [publicAddress],
            request: async () =>
                new Response(
                    new ReadableStream({
                        start(c) {
                            const bytes = new TextEncoder().encode(text);
                            c.enqueue(bytes.slice(0, 13));
                            c.enqueue(bytes.slice(13));
                            c.close();
                        },
                    }),
                    { headers: { 'content-type': 'text/event-stream' } },
                ),
        });
        await expect((await stream('https://example.test/mcp')).text()).rejects.toThrow('frame limit');
    }
});
