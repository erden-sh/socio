import { Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { fingerprint } from '../src/server/mcp/json.js';
import { McpOAuth } from '../src/server/mcp/oauth.js';
import { McpConnectionsService, McpOAuthService } from '../src/server/mcp/tags.js';

import { mcpProvider } from './helpers/mcp-provider.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) {
        await close();
    }
});
async function fixture() {
    // Its OAuth routes take `McpOAuthService` when they mount, so the fake
    // network goes in before the app is built.
    const provider = mcpProvider();
    let oauth!: McpOAuth;
    const { platform, store, workspace, app, dispose } = await makeTestRuntime({
        config: {
            baseUrl: 'http://model.test/v1',
            apiKey: 'k',
            model: 'fixture',
            appOrigin: 'https://socio.example.test',
        },
        // As the app's services offer it to the routes (`McpOAuthService`).
        layers: Layer.effect(
            McpOAuthService,
            Effect.gen(function* () {
                oauth = new McpOAuth(yield* McpConnectionsService, 'https://socio.example.test', provider.network);
                return oauth;
            }),
        ),
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    const login = async (userId: string) => {
        const response = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = response.headers.get('set-cookie')!.split(';')[0];
        await app.request('/api/workspace', { headers: { cookie } });
        return {
            cookie,
            request: (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
                app.request('/api' + path, {
                    method,
                    headers: {
                        cookie,
                        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                        ...headers,
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                }),
        };
    };
    return {
        store,
        workspace,
        platform,
        oauth,
        provider,
        app,
        alice: await login('alice'),
        bob: await login('bob'),
    };
}
it('exposes only owned connections, rejects CSRF and keeps catalog grants explicit', async () => {
    const f = await fixture();
    const metadata = await f.app.request('/.well-known/socio-mcp-client.json');
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
        client_id: 'https://socio.example.test/.well-known/socio-mcp-client.json',
        client_name: 'Socio',
        redirect_uris: ['https://socio.example.test/api/mcp-connections/oauth/callback'],
    });
    const row = await (
        await f.alice.request('/mcp-connections', 'POST', {
            name: 'Public fixture',
            url: 'https://mcp.example.test/mcp',
            authentication: 'none',
        })
    ).json();
    expect(row.id).toBeTypeOf('string');
    expect((await f.bob.request('/mcp-connections/' + row.id + '/catalog', 'POST', {})).status).toBe(404);
    expect(await (await f.bob.request('/mcp-connections')).json()).toMatchObject({
        connections: [],
    });
    expect(
        (await f.alice.request('/mcp-connections', 'POST', {}, { origin: 'https://evil.example.test' })).status,
    ).toBe(403);
    // Anonymous fixture catalog accepts only its explicit token, so seed its reviewed
    // catalog locally; ownership and socio access still run through real HTTP routes.
    const revision = fingerprint('review');
    await f.platform.mcpConnections.repository.saveCatalog(
        'alice',
        row.id,
        row.generation,
        [
            {
                name: 'read_records',
                description: 'Untrusted <script> text',
                inputSchema: { type: 'object' },
                supported: true,
                fingerprint: fingerprint('tool'),
            },
        ],
        revision,
        Date.now(),
    );
    const dot = f.workspace.dotsFor('alice')[0];
    expect(
        (
            await f.alice.request('/mcp-connections/' + row.id + '/grants', 'PUT', {
                generation: row.generation,
                catalogRevision: '0'.repeat(64),
                dotId: dot.id,
                tools: ['read_records'],
            })
        ).status,
    ).toBe(409);
    expect(
        (
            await f.alice.request('/mcp-connections/' + row.id + '/grants', 'PUT', {
                generation: row.generation,
                catalogRevision: revision,
                dotId: dot.id,
                tools: ['nonexistent'],
            })
        ).status,
    ).toBe(400);
    const grant = {
        generation: row.generation,
        catalogRevision: revision,
        dotId: dot.id,
        tools: ['read_records'],
    };
    const first = await (await f.alice.request('/mcp-connections/' + row.id + '/grants', 'PUT', grant)).json();
    expect(first).toMatchObject([{ dotId: dot.id, tools: ['read_records'] }]);
    const next = await (await f.alice.request('/mcp-connections/' + row.id + '/grants', 'PUT', grant)).json();
    expect(next[0].revision).not.toBe(first[0].revision);
    expect((await f.bob.request('/mcp-connections/' + row.id, 'DELETE')).status).toBe(404);
    expect((await f.alice.request('/mcp-connections/' + row.id, 'DELETE')).status).toBe(200);
    expect(f.platform.mcpConnections.list('alice')).toEqual([]);
});
it('serves an inert cross-site landing and completes only with a signed-in owner and nonce cookie', async () => {
    const f = await fixture();
    const row = await f.platform.mcpConnections.create('alice', {
        name: 'OAuth fixture',
        url: 'https://mcp.example.test/mcp',
    });
    const discovery = await f.oauth.discover('alice', row.id);
    const consent = await f.alice.request('/mcp-connections/' + row.id + '/authorize', 'POST', {
        generation: discovery.connection.generation,
        scopes: ['crm.read'],
    });
    const view = await consent.json();
    expect(view.cookie).toBeUndefined();
    expect(view.stateHash).toBeUndefined();
    const nonce = new URL(view.authorizationUrl).searchParams.get('state')!;
    const binding = consent.headers.get('set-cookie')!;
    expect(binding).toMatch(/HttpOnly/);
    expect(binding).toMatch(/SameSite=Lax/);
    expect(binding).toMatch(/Secure/);
    const landing = await f.app.request('/api/mcp-connections/oauth/callback?code=fixture-code&state=' + nonce, {
        headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(landing.status).toBe(200);
    expect(landing.headers.get('cache-control')).toBe('no-store');
    expect(landing.headers.get('referrer-policy')).toBe('no-referrer');
    expect(landing.headers.get('content-security-policy')).toMatch(/script-src 'sha256-/);
    const html = await landing.text();
    expect(html).not.toContain(nonce);
    expect(html).not.toContain('fixture-code');
    expect(html.indexOf('history.replaceState')).toBeLessThan(html.indexOf('fetch('));
    expect(f.provider.requests.filter((r) => r.url.endsWith('/token'))).toHaveLength(0);
    const body = { state: nonce, code: 'fixture-code' };
    expect(
        (
            await f.bob.request('/mcp-connections/oauth/complete', 'POST', body, {
                cookie: f.bob.cookie + '; ' + binding.split(';')[0],
            })
        ).status,
    ).toBe(409);
    expect((await f.alice.request('/mcp-connections/oauth/complete', 'POST', body)).status).toBe(400);
    const complete = await f.alice.request('/mcp-connections/oauth/complete', 'POST', body, {
        cookie: f.alice.cookie + '; ' + binding.split(';')[0],
    });
    expect(complete.status).toBe(200);
    expect(await complete.json()).toEqual({ id: row.id });
    expect(f.platform.mcpConnections.get('alice', row.id)).toMatchObject({
        state: 'review',
        tools: [{ name: 'read_records' }],
    });
    expect(f.platform.mcpConnections.grants('alice', row.id)).toEqual([]);
    expect(
        (
            await f.alice.request('/mcp-connections/oauth/complete', 'POST', body, {
                cookie: f.alice.cookie + '; ' + binding.split(';')[0],
            })
        ).status,
    ).toBe(409);
    expect(f.provider.requests.filter((r) => r.url.endsWith('/token'))).toHaveLength(1);
});
