import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import { McpConnections } from '../src/server/mcp/connections.js';
import { McpConnectionRepository } from '../src/server/mcp/infra/sqlite/repository.js';
import { McpOAuth, type McpOAuthCredentials } from '../src/server/mcp/oauth.js';

import { mcpProvider } from './helpers/mcp-provider.js';
import { testDatabase } from './helpers/test-database.js';

const databases: DatabaseSync[] = [];
afterEach(() => {
    vi.useRealTimers();
    databases.splice(0).forEach((db) => db.close());
});
function fixture(options: Parameters<typeof mcpProvider>[0] = {}) {
    const provider = mcpProvider(options),
        db = testDatabase();
    databases.push(db);
    const repo = new McpConnectionRepository(db),
        connections = new McpConnections(
            repo,
            { legacy: 'test-session', current: randomBytes(32) },
            { active: (id) => ['alice', 'bob'].includes(id), socio: () => true },
        );
    const oauth = new McpOAuth(connections, 'https://socio.example.test/', provider.network);
    return { ...provider, connections, oauth, repo };
}
async function begin(f: ReturnType<typeof fixture>) {
    const connection = await f.connections.create('alice', {
            name: 'My server',
            url: 'https://mcp.example.test/mcp',
        }),
        discovered = await f.oauth.discover('alice', connection.id),
        authorization = await f.oauth.authorize('alice', connection.id, {
            generation: discovered.connection.generation,
            scopes: ['crm.read'],
        });
    const url = new URL(authorization.authorizationUrl);
    return {
        connection: discovered.connection,
        authorization,
        nonce: url.searchParams.get('state')!,
        url,
    };
}
it.each([false, true])(
    'connects generic OAuth with DCR or client metadata (%s), selected scopes, exact PKCE and reviewed catalog',
    async (cimd) => {
        const f = fixture({ cimd }),
            b = await begin(f);
        expect(b.url.origin).toBe('https://auth.example.test');
        expect(b.url.searchParams.get('scope')).toBe('crm.read');
        expect(b.url.searchParams.get('resource')).toBe('https://mcp.example.test/mcp');
        expect(b.url.searchParams.get('redirect_uri')).toBe(
            'https://socio.example.test/api/mcp-connections/oauth/callback',
        );
        const registrations = f.requests.filter((r) => r.url.endsWith('/register'));
        expect(registrations).toHaveLength(cimd ? 0 : 1);
        if (!cimd) {
            expect(JSON.parse(registrations[0]!.body).scope).toBe('crm.read');
        } else {
            expect(b.url.searchParams.get('client_id')).toBe(
                'https://socio.example.test/.well-known/socio-mcp-client.json',
            );
        }
        const ready = await f.oauth.callback('alice', b.nonce, b.authorization.cookie, 'local-code');
        expect(ready.state).toBe('review');
        const token = f.requests.find((r) => r.url.endsWith('/token'))!,
            params = new URLSearchParams(token.body);
        expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(
            b.url.searchParams.get('code_challenge'),
        );
        expect(params.get('resource')).toBe('https://mcp.example.test/mcp');
        const catalog = await f.oauth.catalog('alice', b.connection.id);
        expect(catalog.tools).toMatchObject([{ name: 'read_records', supported: true }]);
        expect(
            f.requests
                .filter((r) => r.headers.has('authorization'))
                .every((r) => r.url === 'https://mcp.example.test/mcp'),
        ).toBe(true);
        expect(JSON.stringify(f.connections.list('alice'))).not.toMatch(
            /fixture-access|fixture-refresh|local-code|code_verifier/,
        );
    },
);
it('requires same owner/cookie and single-use fresh callback before any token exchange', async () => {
    const f = fixture(),
        b = await begin(f);
    await expect(f.oauth.callback('bob', b.nonce, b.authorization.cookie, 'code')).rejects.toThrow('already used');
    await expect(f.oauth.callback('alice', b.nonce, 'x'.repeat(43), 'code')).rejects.toThrow('already used');
    expect(f.requests.filter((r) => r.url.endsWith('/token'))).toHaveLength(0);
    await f.oauth.callback('alice', b.nonce, b.authorization.cookie, 'code');
    await expect(f.oauth.callback('alice', b.nonce, b.authorization.cookie, 'code')).rejects.toThrow('already used');
    expect(f.requests.filter((r) => r.url.endsWith('/token'))).toHaveLength(1);
});
it('never silently requests all advertised scopes when none were selected', async () => {
    const f = fixture();
    const connection = await f.connections.create('alice', {
            name: 'My server',
            url: 'https://mcp.example.test/mcp',
        }),
        d = await f.oauth.discover('alice', connection.id);
    const a = await f.oauth.authorize('alice', connection.id, {
        generation: d.connection.generation,
        scopes: [],
    });
    expect(new URL(a.authorizationUrl).searchParams.has('scope')).toBe(false);
    expect(JSON.parse(f.requests.find((r) => r.url.endsWith('/register'))!.body).scope).toBeUndefined();
});
it('rejects stale discovery selections and mismatched issuer/resource before sending credentials', async () => {
    for (const options of [{ issuer: 'https://evil.example.test' }, { resource: 'https://other.example.test/mcp' }]) {
        const f = fixture(options),
            row = await f.connections.create('alice', {
                name: 'My server',
                url: 'https://mcp.example.test/mcp',
            });
        await expect(f.oauth.discover('alice', row.id)).rejects.toThrow('discover');
        expect(f.requests.some((r) => r.url.endsWith('/register') || r.url.endsWith('/token'))).toBe(false);
    }
    const f = fixture(),
        b = await begin(f);
    await expect(
        f.oauth.authorize('alice', b.connection.id, {
            generation: b.connection.generation,
            scopes: ['crm.read'],
        }),
    ).rejects.toThrow('changed');
});
it('supports pre-registered clients only for the reviewed issuer and confines secret headers to its token endpoint', async () => {
    const f = fixture(),
        row = await f.connections.create('alice', {
            name: 'Custom',
            url: 'https://mcp.example.test/mcp',
        }),
        d = await f.oauth.discover('alice', row.id);
    await expect(
        f.oauth.authorize('alice', row.id, {
            generation: d.connection.generation,
            scopes: ['crm.read'],
            client: {
                id: 'private-client',
                secret: 'private-secret',
                issuer: 'https://evil.example.test',
            },
        }),
    ).rejects.toThrow('issuer');
    const b = await f.oauth.authorize('alice', row.id, {
        generation: d.connection.generation,
        scopes: ['crm.read'],
        client: {
            id: 'private-client',
            secret: 'private-secret',
            issuer: d.issuer,
        },
    });
    await f.oauth.callback('alice', new URL(b.authorizationUrl).searchParams.get('state')!, b.cookie, 'code');
    const withHeader = f.requests.filter((r) => r.headers.has('authorization'));
    expect(withHeader).toHaveLength(1);
    expect(withHeader[0]!.url).toBe('https://auth.example.test/token');
    expect(withHeader[0]!.headers.get('authorization')).toBe(
        'Basic ' + Buffer.from('private-client:private-secret').toString('base64'),
    );
});
it('does not replay failed token exchange or resurrect credentials after disconnect during exchange', async () => {
    const failed = fixture(),
        a = await begin(failed);
    failed.status(400);
    await expect(failed.oauth.callback('alice', a.nonce, a.authorization.cookie, 'bad-code')).rejects.toThrow(
        'not complete',
    );
    expect(failed.requests.filter((r) => r.url.endsWith('/token'))).toHaveLength(1);
    const f = fixture(),
        b = await begin(f);
    let release!: () => void, entered!: () => void;
    const seen = new Promise<void>((r) => {
        entered = r;
    });
    f.hold(() => {
        entered();
        return new Promise<void>((r) => {
            release = r;
        });
    });
    const callback = f.oauth.callback('alice', b.nonce, b.authorization.cookie, 'code');
    await seen;
    await f.connections.disconnect('alice', b.connection.id);
    release();
    await expect(callback).rejects.toThrow();
    expect(f.connections.get('alice', b.connection.id).state).toBe('disconnected');
    expect(f.repo.owned('alice', b.connection.id)?.secret).toBeNull();
});
it('serializes refresh per actor/connection/generation before business calls and cannot upscope', async () => {
    const f = fixture(),
        b = await begin(f),
        ready = await f.oauth.callback('alice', b.nonce, b.authorization.cookie, 'code');
    const credentials = f.connections.credentials<McpOAuthCredentials>('alice', ready.id, ready.generation)!;
    credentials.expiresAt = 1;
    await f.connections.saveCredentials('alice', ready.id, ready.generation, credentials);
    f.requests.splice(0);
    const refreshed = await Promise.all([
        f.oauth.credentials('alice', ready.id, ready.generation),
        f.oauth.credentials('alice', ready.id, ready.generation),
    ]);
    expect(refreshed.every((x) => x?.tokens?.issuer === 'https://auth.example.test')).toBe(true);
    expect(f.requests.filter((r) => r.url.endsWith('/token'))).toHaveLength(1);
    expect(new URLSearchParams(f.requests[0]!.body).get('grant_type')).toBe('refresh_token');
});

it('expires unused OAuth state and prevents every token request after the ten minute window', async () => {
    const f = fixture(),
        b = await begin(f);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await expect(f.oauth.callback('alice', b.nonce, b.authorization.cookie, 'code')).rejects.toThrow('expired');
    expect(f.requests.filter((r) => r.url.endsWith('/token'))).toHaveLength(0);
});

it('does not require OAuth configuration or perform network work at construction', async () => {
    const f = fixture();
    const offline = new McpOAuth(f.connections, '', f.network);
    const row = await f.connections.create('alice', {
        name: 'Custom',
        url: 'https://mcp.example.test/mcp',
    });
    await expect(offline.discover('alice', row.id)).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
    expect(f.connections.get('alice', row.id).state).toBe('draft');
});
it('refuses private consent endpoints through actual SDK discovery and rechecks DNS before returning a consent URL', async () => {
    for (const endpoint of [
        'https://127.0.0.1/authorize',
        'https://[::ffff:7f00:1]/authorize',
        'https://consent.example.test/authorize',
    ]) {
        const f = fixture(),
            original = f.network.request!;
        let privateConsent = true;
        f.network.lookup = async (host) =>
            host === 'consent.example.test' && privateConsent
                ? [{ address: '127.0.0.1', family: 4 }]
                : [{ address: '93.184.216.34', family: 4 }];
        f.network.request = async (...args) => {
            const response = await original(...args);
            if (args[0].href === 'https://auth.example.test/.well-known/oauth-authorization-server') {
                const metadata = await response.json();
                metadata.authorization_endpoint = endpoint;
                return new Response(JSON.stringify(metadata), {
                    headers: { 'content-type': 'application/json' },
                });
            }
            return response;
        };
        const row = await f.connections.create('alice', {
            name: 'Fixture',
            url: 'https://mcp.example.test/mcp',
        });
        await expect(f.oauth.discover('alice', row.id)).rejects.toThrow('discover');
        expect(f.requests.some((r) => r.url.startsWith(endpoint))).toBe(false);
        if (endpoint.includes('consent.example.test')) {
            privateConsent = false;
            const found = await f.oauth.discover('alice', row.id);
            // It changes between discovery review and the final browser handoff.
            privateConsent = true;
            await expect(
                f.oauth.authorize('alice', row.id, {
                    generation: found.connection.generation,
                    scopes: ['crm.read'],
                }),
            ).rejects.toThrow('could not start');
            expect(f.requests.some((r) => r.url.startsWith(endpoint))).toBe(false);
        }
    }
});
