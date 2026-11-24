import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, expect, it } from 'vitest';

import { isLocalRedirect } from '@socio/foundation/agents/clients';

import { CimdFetcher, clientIdProblem, parseClientMetadata, redirectUriMatches } from '../src/server/agents/cimd.js';
import type { CimdOptions } from '../src/server/agents/contract.js';

const CLIENT = 'https://client.example/oauth/metadata.json';
const doc = (extra: Record<string, unknown> = {}) => ({
    client_id: CLIENT,
    client_name: 'Claude Code',
    redirect_uris: ['http://127.0.0.1/callback'],
    ...extra,
});

const servers: http.Server[] = [];
afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});

/** A fetcher whose requests go to a local server, with public stub DNS. */
async function fetcher(handler: http.RequestListener, options: Partial<CimdOptions> = {}) {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    let requests = 0;
    const cimd = new CimdFetcher({
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        request: (url, _address, signal) =>
            new Promise<IncomingMessage>((resolve, reject) => {
                requests++;
                const request = http.request({ host: '127.0.0.1', port, path: url.pathname, signal }, resolve);
                request.on('error', reject);
                request.end();
            }),
        ...options,
    });
    return { cimd, requests: () => requests };
}

it('takes only https client ids on a named public host, with a path', () => {
    expect(clientIdProblem(CLIENT)).toBeUndefined();
    for (const id of [
        'http://client.example/metadata.json',
        'https://client.example/',
        'https://client.example',
        'https://user:pass@client.example/m.json',
        'https://client.example/m.json#x',
        'https://client.example:8443/m.json',
        'https://client.example/a/../m.json',
        'https://93.184.216.34/m.json',
        'https://[2606:2800:220:1::]/m.json',
        'https://localhost/m.json',
        'https://printer.local/m.json',
        'https://intranet/m.json',
        'not a url',
    ]) {
        expect(clientIdProblem(id), id).toBeTruthy();
    }
});

it('checks the document: its own client id, public client, usable redirects', () => {
    expect(parseClientMetadata(CLIENT, doc())).toEqual({
        clientId: CLIENT,
        host: 'client.example',
        name: 'Claude Code',
        redirectUris: ['http://127.0.0.1/callback'],
        logoUri: undefined,
        clientUri: undefined,
        applicationType: 'native',
    });
    expect(
        parseClientMetadata(
            CLIENT,
            doc({
                redirect_uris: ['https://app.example/cb'],
                logo_uri: 'http://insecure.example/logo.png',
                client_uri: 'https://app.example',
            }),
        ),
    ).toMatchObject({
        applicationType: 'web',
        logoUri: undefined,
        clientUri: 'https://app.example',
    });
    for (const bad of [
        null,
        [],
        doc({ client_id: 'https://other.example/m.json' }),
        doc({ client_secret: 'x' }),
        doc({ token_endpoint_auth_method: 'client_secret_basic' }),
        doc({ grant_types: ['client_credentials'] }),
        doc({ response_types: ['token'] }),
        doc({ redirect_uris: [] }),
        doc({ redirect_uris: ['http://evil.example/cb'] }),
        doc({ redirect_uris: ['javascript:alert(1)'] }),
        doc({ redirect_uris: ['https://app.example/cb#frag'] }),
    ]) {
        expect(() => parseClientMetadata(CLIENT, bad)).toThrow();
    }
});

it('matches redirect URIs exactly; a portless loopback one on any port', () => {
    const registered = ['http://127.0.0.1/callback', 'http://localhost:8080/cb', 'https://app.example/cb'];
    expect(redirectUriMatches('https://app.example/cb', registered)).toBe(true);
    expect(redirectUriMatches('http://127.0.0.1:51234/callback', registered)).toBe(true);
    expect(redirectUriMatches('http://localhost:8080/cb', registered)).toBe(true);
    for (const uri of [
        'https://app.example/cb/',
        'https://app.example/cb?x=1',
        'http://localhost:9090/cb',
        'http://127.0.0.1:51234/other',
        'http://127.0.0.2:51234/callback',
        'https://127.0.0.1/callback',
    ]) {
        expect(redirectUriMatches(uri, registered), uri).toBe(false);
    }
    expect(isLocalRedirect('http://127.0.0.1:5/cb')).toBe(true);
    expect(isLocalRedirect('com.example.app:/cb')).toBe(true);
    expect(isLocalRedirect('https://app.example/cb')).toBe(false);
});

it('refuses private, loopback, link-local, CGNAT and IPv6 private answers', async () => {
    for (const address of [
        '127.0.0.1',
        '10.1.2.3',
        '172.16.0.1',
        '192.168.0.10',
        '169.254.169.254',
        '100.64.0.1',
        '0.0.0.0',
        '::1',
        'fd00::1',
        'fe80::1',
        '::ffff:127.0.0.1',
    ]) {
        const { cimd, requests } = await fetcher((_request, response) => response.end(JSON.stringify(doc())), {
            lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
        });
        await expect(cimd.get(CLIENT), address).rejects.toThrow(/private or special network/);
        expect(requests()).toBe(0);
    }
});

it('refuses redirects, large bodies, other types, and slow servers; caches within its ceiling', async () => {
    const { cimd: redirecting } = await fetcher((_request, response) =>
        response.writeHead(301, { location: 'https://elsewhere.example/' }).end(),
    );
    await expect(redirecting.get(CLIENT)).rejects.toThrow(/redirects/);
    const { cimd: large } = await fetcher((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(doc({ padding: 'x'.repeat(9000) })));
    });
    await expect(large.get(CLIENT)).rejects.toThrow(/too large/);
    const { cimd: html } = await fetcher((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<html></html>');
    });
    await expect(html.get(CLIENT)).rejects.toThrow(/not JSON/);
    const { cimd: slow } = await fetcher(() => undefined, { timeoutMs: 100 });
    await expect(slow.get(CLIENT)).rejects.toThrow(/too long/);

    let now = 0;
    const { cimd, requests } = await fetcher(
        (request, response) => {
            response.writeHead(200, {
                'content-type': 'application/json',
                'cache-control': 'max-age=600',
            });
            response.end(
                JSON.stringify({
                    ...doc(),
                    client_id: `https://client.example${request.url}`,
                }),
            );
        },
        { now: () => now },
    );
    await cimd.get(CLIENT);
    await cimd.get(CLIENT);
    expect(requests()).toBe(1);
    now += 601_000;
    await cimd.get(CLIENT);
    expect(requests()).toBe(2);
    // A ceiling: the oldest documents go first.
    for (let i = 0; i < 205; i++) {
        await cimd.get(`https://client.example/c/${i}.json`);
    }
    expect(cimd.cached(CLIENT)).toBeUndefined();
    expect(cimd.cached('https://client.example/c/204.json')).toBeDefined();
});
