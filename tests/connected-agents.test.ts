import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { migrateDatabase } from '@socio/data/migrate';
import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';
import type { AgentConsentView, AgentGrantAdminView, AgentGrantView } from '@socio/shared/agent-grants';

import type { AgentDocsCatalog, CimdOptions } from '../src/server/agents/contract.js';
import type { BetterAuthProvider } from '../src/server/auth/better-auth.js';
import { authFromEnv } from '../src/server/composition/auth.js';
import { loadDocs } from '../src/server/composition/lifecycle/docs.js';
import type { DocsCatalogShape } from '../src/server/docs/contract.js';
import { schemas } from '../src/server/modules/index.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const SECRET = 'test-session-secret-0123456789';
const ORIGIN = 'http://localhost:4310';
const MCP = `${ORIGIN}/mcp`;
const PASSWORD = 'correct-horse-battery';
const CLIENT = 'https://client.example/oauth/metadata.json';
const REDIRECT = 'http://127.0.0.1:33418/callback';
/** Public addresses the stub DNS gives the fake hosts. */
const PUBLIC = '93.184.216.34';

/** Cookies across requests, as a browser keeps them. */
class Jar {
    private cookies = new Map<string, string>();
    store(response: Response) {
        for (const header of response.headers.getSetCookie()) {
            const [pair] = header.split(';');
            const index = pair.indexOf('=');
            const name = pair.slice(0, index).trim();
            const value = pair.slice(index + 1);
            if (!value || /max-age=0/i.test(header)) {
                this.cookies.delete(name);
            } else {
                this.cookies.set(name, value);
            }
        }
        return response;
    }
    get header() {
        return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
}

// Each test signs people in and runs whole OAuth flows: slow on a busy machine.
vi.setConfig({ testTimeout: 60_000 });

const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
    vi.restoreAllMocks();
});

const fastHasher = {
    hash: async (password: string) => `test:${password}`,
    verify: async ({ hash, password }: { hash: string; password: string }) => hash === `test:${password}`,
};

type Served = {
    status?: number;
    headers?: Record<string, string>;
    body: string;
};

/**
 * Client metadata documents, served by a local http server: the stub DNS
 * names its hosts and the request goes to it, never out.
 */
async function metadataServer() {
    const documents = new Map<string, Served>();
    const requests: string[] = [];
    const server = http.createServer((request, response) => {
        const url = `https://${request.headers.host}${request.url}`;
        requests.push(url);
        const served = documents.get(url);
        if (!served) {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(served.status ?? 200, {
            'content-type': 'application/json',
            ...served.headers,
        });
        response.end(served.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as AddressInfo).port;
    const dns: Record<string, string[]> = {
        'client.example': [PUBLIC],
        'other.example': [PUBLIC],
        'private.example': ['10.0.0.5'],
        'loopback.example': ['127.0.0.1'],
        'cgnat.example': ['100.64.1.1'],
        'metadata.example': ['169.254.169.254'],
        'v6.example': ['fd00::1'],
        'rebind.example': [PUBLIC, '192.168.1.1'],
    };
    const cimd: CimdOptions = {
        lookup: async (hostname) => {
            const addresses = dns[hostname];
            if (!addresses) {
                throw new Error('ENOTFOUND');
            }
            return addresses.map((address) => ({
                address,
                family: address.includes(':') ? 6 : 4,
            }));
        },
        request: (url, _address, signal) =>
            new Promise<IncomingMessage>((resolve, reject) => {
                const request = http.request(
                    {
                        host: '127.0.0.1',
                        port,
                        path: `${url.pathname}${url.search}`,
                        headers: { host: url.host },
                        signal,
                    },
                    resolve,
                );
                request.on('error', reject);
                request.end();
            }),
    };
    const serve = (clientId: string, document: Record<string, unknown> | string, extra: Omit<Served, 'body'> = {}) =>
        documents.set(clientId, {
            ...extra,
            body: typeof document === 'string' ? document : JSON.stringify({ client_id: clientId, ...document }),
        });
    return { serve, requests, cimd };
}

/** An app on Better Auth, with a fake metadata host. */
async function brain({ plugins = false, calendar = false }: { plugins?: boolean; calendar?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-agents-'));
    const path = join(dir, 'brain.sqlite');
    migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
    const metadata = await metadataServer();
    metadata.serve(CLIENT, {
        client_name: 'Claude Code',
        redirect_uris: [REDIRECT, 'http://localhost/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
    });
    const auth = authFromEnv(
        {
            AUTH_PROVIDER: 'betterauth',
            APP_ORIGIN: ORIGIN,
            SESSION_SECRET: SECRET,
            AUTH_TRUST_PROXY: 'true',
        },
        '127.0.0.1',
        { database: path, hasher: fastHasher, cimd: metadata.cimd },
    );
    const clientIp = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const config = { mode: 'live' as const, baseUrl: 'https://model.invalid' };
    const provider = auth.provider as BetterAuthProvider;
    // Better Auth opens the app's file by its path; the runtime shares it.
    const { app, edge, platform, workspace, dispose } = await makeTestRuntime({
        database: path,
        config: {
            baseUrl: config.baseUrl,
            ...(plugins
                ? {
                      apps: appsSettingsFromEnv({ APPS_HOST: 'apps.example' }, ORIGIN),
                      plugins: {
                          catalogs: [
                              ...(calendar ? [{ kind: 'bundled' as const, id: 'calendar' }] : []),
                              { kind: 'bundled' as const, id: 'social-strategy' },
                          ],
                          serviceToken: 'plugin-service-token-plugin-service-token',
                          runtime: {
                              provisionService: async () => ({
                                  id: 'social-strategy',
                                  service: 'socio-plugin-social-strategy',
                                  image: 'planner',
                                  replicas: 1,
                                  running: 1,
                                  state: 'running' as const,
                              }),
                              scaleService: async () => {
                                  throw new Error('unused');
                              },
                              removeService: async () => {},
                              serviceStatus: async () => undefined,
                          },
                      },
                  }
                : {}),
        },
        app: { config, origin: [ORIGIN], auth },
    });
    cleanups.push(async () => {
        provider.close();
        await dispose();
        rmSync(dir, { recursive: true, force: true });
    });
    /** A browser-like request: same-origin, JSON, with the jar's cookies. */
    const call = async (
        jar: Jar,
        path: string,
        { body, ...init }: Omit<RequestInit, 'body'> & { body?: unknown } = {},
    ) =>
        jar.store(
            await app.request(path, {
                ...init,
                ...(body === undefined ? {} : { method: init.method ?? 'POST' }),
                headers: {
                    origin: ORIGIN,
                    'x-forwarded-for': clientIp,
                    ...(body === undefined && !init.method ? {} : { 'content-type': 'application/json' }),
                    ...(jar.header ? { cookie: jar.header } : {}),
                    ...(init.headers as Record<string, string> | undefined),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            }),
        );
    /** What an agent sends: a form post, no cookies, no origin. */
    const agent = (path: string, form: Record<string, string>) =>
        app.request(path, {
            method: 'POST',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                'x-forwarded-for': clientIp,
            },
            body: new URLSearchParams(form).toString(),
        });
    const person = async (email: string, name: string, role: 'member' | 'admin' = 'member') => {
        await provider.createAccount({ email, name, role, password: PASSWORD });
        const jar = new Jar();
        const response = await call(jar, '/api/auth/sign-in/email', {
            body: { email, password: PASSWORD },
        });
        expect(response.status).toBe(200);
        const session = (await (await call(jar, '/api/auth/session')).json()) as {
            user: { id: string; name: string };
        };
        const accountId = provider.accounts().find((account) => account.email === email)!.id;
        return { jar, userId: session.user.id, accountId };
    };
    return {
        app,
        provider,
        edge,
        platform,
        workspace,
        path,
        call,
        agent,
        person,
        metadata,
    };
}
type Brain = Awaited<ReturnType<typeof brain>>;

const pkce = () => {
    const verifier = randomBytes(32).toString('base64url');
    return {
        verifier,
        challenge: createHash('sha256').update(verifier).digest('base64url'),
    };
};

/** The authorization request a client makes, as a query string. */
const authorizeQuery = (overrides: Record<string, string | undefined> = {}, challenge = pkce().challenge) => {
    const params: Record<string, string | undefined> = {
        response_type: 'code',
        client_id: CLIENT,
        redirect_uri: REDIRECT,
        scope: 'issues:read issues:write pages:read offline_access',
        state: 'state-123',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: MCP,
        ...overrides,
    };
    return new URLSearchParams(
        Object.entries(params).filter(([, value]) => value !== undefined) as [string, string][],
    ).toString();
};

/** Authorize as the person: the consent screen's query, or where it went. */
async function authorize(b: Brain, jar: Jar, query: string) {
    const response = await b.call(jar, `/api/auth/oauth2/authorize?${query}`);
    const location = response.headers.get('location') ?? '';
    return { response, location: new URL(location, ORIGIN) };
}

/** The whole flow: authorize, approve, exchange the code. */
async function connect(
    b: Brain,
    jar: Jar,
    { label = 'Claude Code on laptop', scope }: { label?: string; scope?: string } = {},
) {
    const { verifier, challenge } = pkce();
    const { location } = await authorize(b, jar, authorizeQuery(scope ? { scope } : {}, challenge));
    expect(location.pathname).toBe('/connect');
    const query = location.search.slice(1);
    const approved = await b.call(jar, '/api/agent-consent', {
        body: { query, accept: true, label },
    });
    expect(approved.status).toBe(200);
    const { url } = (await approved.json()) as { url: string };
    const back = new URL(url);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('state-123');
    const token = await b.agent('/api/auth/oauth2/token', {
        grant_type: 'authorization_code',
        code: back.searchParams.get('code')!,
        redirect_uri: REDIRECT,
        client_id: CLIENT,
        code_verifier: verifier,
        resource: MCP,
    });
    expect(token.status).toBe(200);
    return (await token.json()) as {
        access_token: string;
        refresh_token: string;
        token_type: string;
        expires_in: number;
        scope: string;
    };
}

it('is discoverable: protected resource metadata, then the authorization server, no DCR', async () => {
    const b = await brain();
    const resource = await b.app.request('/.well-known/oauth-protected-resource/mcp');
    expect(resource.status).toBe(200);
    expect(resource.headers.get('access-control-allow-origin')).toBe('*');
    const prm = (await resource.json()) as {
        resource: string;
        authorization_servers: string[];
        scopes_supported: string[];
    };
    expect(prm).toEqual({
        resource: MCP,
        authorization_servers: [`${ORIGIN}/api/auth`],
        scopes_supported: [
            'issues:read',
            'issues:write',
            'pages:read',
            'pages:write',
            'docs:read',
            'plugins:read',
            'plugins:write',
            // The calendar was offered on every instance before CB-371, so an
            // installed copy may run without an offer: its scopes stay listed.
            'plugins:calendar:read',
            'plugins:calendar:write',
            'offline_access',
        ],
        bearer_methods_supported: ['header'],
        resource_name: 'Socio',
    });
    // The root form, for clients that ask there.
    expect(await (await b.app.request('/.well-known/oauth-protected-resource')).json()).toEqual(prm);
    // RFC 8414: the issuer's path after the well-known prefix, and the root.
    const issuer = new URL(prm.authorization_servers[0]);
    for (const path of [
        `/.well-known/oauth-authorization-server${issuer.pathname}`,
        '/.well-known/oauth-authorization-server',
    ]) {
        const response = await b.app.request(path);
        expect(response.status, path).toBe(200);
        const metadata = (await response.json()) as Record<string, unknown>;
        expect(metadata).toMatchObject({
            issuer: `${ORIGIN}/api/auth`,
            authorization_endpoint: `${ORIGIN}/api/auth/oauth2/authorize`,
            token_endpoint: `${ORIGIN}/api/auth/oauth2/token`,
            revocation_endpoint: `${ORIGIN}/api/auth/oauth2/revoke`,
            client_id_metadata_document_supported: true,
            code_challenge_methods_supported: ['S256'],
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            scopes_supported: prm.scopes_supported,
        });
        expect(metadata.token_endpoint_auth_methods_supported).toContain('none');
        // Dynamic Client Registration is off.
        expect(metadata.registration_endpoint).toBeUndefined();
    }
    const register = await b.app.request('/api/auth/oauth2/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Rogue' }),
    });
    expect(register.status).toBe(404);
});

it('connects an agent: authorize with PKCE, consent, token, and the resolver names agent and person', async () => {
    const b = await brain();
    const { jar, userId } = await b.person('ada@example.com', 'Ada');
    // Signed out, authorize sends the browser to sign in first.
    const signedOut = await authorize(b, new Jar(), authorizeQuery());
    expect(signedOut.response.status).toBe(302);
    expect(signedOut.location.pathname).toBe('/connect/continue');
    // Signed in: the consent screen, every time (nothing is approved silently).
    const { location } = await authorize(b, jar, authorizeQuery());
    expect(location.pathname).toBe('/connect');
    const consent = (await (
        await b.call(jar, `/api/agent-consent?query=${encodeURIComponent(location.search.slice(1))}`)
    ).json()) as AgentConsentView;
    expect(consent).toEqual({
        clientId: CLIENT,
        clientName: 'Claude Code',
        logoUri: null,
        clientUri: null,
        metadataHost: 'client.example',
        // A loopback redirect: anyone can claim to be this app.
        clientDomain: null,
        localApp: true,
        redirectUri: REDIRECT,
        scopes: ['issues:read', 'issues:write', 'pages:read', 'offline_access'],
        personName: 'Ada',
        refusal: null,
    });

    const tokens = await connect(b, jar);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.access_token).toMatch(/^cbat_/);
    expect(tokens.refresh_token).toMatch(/^cbrt_/);
    expect(tokens.expires_in).toBe(3600);
    const actor = await b.platform.agentGrants.resolve(tokens.access_token, MCP);
    expect(actor).toEqual({
        grantId: expect.any(String),
        clientId: CLIENT,
        clientName: 'Claude Code',
        clientDomain: null,
        label: 'Claude Code on laptop',
        userId,
        scopes: ['issues:read', 'issues:write', 'pages:read'],
    });
    // Tokens are stored hashed, never as given.
    const db = new DatabaseSync(b.path, { readOnly: true });
    const stored = db
        .prepare('SELECT token FROM auth_oauth_access_token')
        .all()
        .map((row) => String(row.token));
    db.close();
    expect(stored).toHaveLength(1);
    expect(tokens.access_token).not.toContain(stored[0]);
    expect(b.platform.agentGrants.list(actor!.userId)).toEqual([
        expect.objectContaining({
            grantId: actor!.grantId,
            label: 'Claude Code on laptop',
            lastUsedAt: expect.any(Number),
        }),
    ]);
    // The person sees it under Account → Connected agents.
    const mine = (await (await b.call(jar, '/api/agent-grants')).json()) as {
        grants: AgentGrantView[];
    };
    expect(mine.grants.map((grant) => grant.label)).toEqual(['Claude Code on laptop']);
    // Each authorization is a grant of its own, with its own label.
    await connect(b, jar, { label: 'Claude Code on laptop' });
    expect(b.platform.agentGrants.list(actor!.userId).map((grant) => grant.label)).toEqual([
        'Claude Code on laptop',
        'Claude Code on laptop',
    ]);
});

it('end to end: a connected agent files on the board through /mcp as the person, until revoked', async () => {
    const b = await brain();
    const { jar, userId } = await b.person('ada@example.com', 'Ada');
    const tokens = await connect(b, jar);
    const client = new Client({ name: 'claude-code', version: '0.1.0' });
    await client.connect(
        new StreamableHTTPClientTransport(new URL(MCP), {
            requestInit: {
                headers: { Authorization: `Bearer ${tokens.access_token}` },
            },
            fetch: async (url, init) => b.app.request(String(url), init),
        }),
    );
    cleanups.push(() => client.close());
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['search_issues', 'file_issue', 'read_page']));
    const filed = await client.callTool({
        name: 'file_issue',
        arguments: {
            title: 'Export the board as CSV',
            kind: 'feature',
            description: 'Teams want the board in a spreadsheet.',
        },
    });
    expect(filed.isError).toBeFalsy();
    const issue = (await b.platform.board.issues.get(1))!;
    // The person is the reporter; the agent is recorded alongside.
    expect(issue.reporterId).toBe(userId);
    const db = new DatabaseSync(b.path, { readOnly: true });
    const actions = db
        .prepare('SELECT action, userId, label FROM issue_agent_actions')
        .all()
        .map((row) => ({ ...row }));
    db.close();
    expect(actions).toEqual([{ action: 'create', userId, label: 'Claude Code on laptop' }]);
    // Revoked from Account → Connected agents: the next call is refused.
    const [grant] = b.platform.agentGrants.list(userId);
    await b.call(jar, `/api/agent-grants/${grant!.grantId}`, {
        method: 'DELETE',
    });
    const after = await b.app.request(MCP, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    });
    expect(after.status).toBe(401);
    expect(after.headers.get('www-authenticate')).toContain(
        `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
});

it('grants pages:write only when the client asks for it', async () => {
    const b = await brain();
    const { jar, userId } = await b.person('ada@example.com', 'Ada');
    const scope = 'pages:read pages:write offline_access';
    const { verifier, challenge } = pkce();
    const { location } = await authorize(b, jar, authorizeQuery({ scope }, challenge));
    const consent = (await (
        await b.call(jar, `/api/agent-consent?query=${encodeURIComponent(location.search.slice(1))}`)
    ).json()) as AgentConsentView;
    expect(consent.scopes).toEqual(['pages:read', 'pages:write', 'offline_access']);
    expect(consent.scopes).not.toContain('issues:write');
    const approved = await b.call(jar, '/api/agent-consent', {
        body: { query: location.search.slice(1), accept: true, label: 'Writer' },
    });
    expect(approved.status).toBe(200);
    const { url } = (await approved.json()) as { url: string };
    const token = await b.agent('/api/auth/oauth2/token', {
        grant_type: 'authorization_code',
        code: new URL(url).searchParams.get('code')!,
        redirect_uri: REDIRECT,
        client_id: CLIENT,
        code_verifier: verifier,
        resource: MCP,
    });
    expect(token.status).toBe(200);
    const tokens = (await token.json()) as { access_token: string; refresh_token: string; scope: string };
    expect(tokens.scope.split(' ')).toEqual(expect.arrayContaining(['pages:read', 'pages:write']));
    expect(tokens.scope.split(' ')).not.toContain('issues:write');
    const actor = await b.platform.agentGrants.resolve(tokens.access_token, MCP);
    expect(actor).toMatchObject({ userId, scopes: ['pages:read', 'pages:write'] });
    const refreshed = await b.agent('/api/auth/oauth2/token', {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: CLIENT,
        resource: MCP,
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; scope: string };
    expect(next.scope.split(' ')).not.toContain('issues:read');
    expect(await b.platform.agentGrants.resolve(next.access_token, MCP)).toMatchObject({
        scopes: ['pages:read', 'pages:write'],
    });
});

it('rotates refresh tokens: the new pair works, the old refresh token does not', async () => {
    const b = await brain();
    const { jar } = await b.person('ada@example.com', 'Ada');
    const first = await connect(b, jar);
    const refreshed = await b.agent('/api/auth/oauth2/token', {
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: CLIENT,
        resource: MCP,
    });
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as typeof first;
    expect(second.refresh_token).toMatch(/^cbrt_/);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    const actor = await b.platform.agentGrants.resolve(second.access_token, MCP);
    expect(actor?.label).toBe('Claude Code on laptop');
    // Refresh keeps the scopes that were approved. pages:write was not one of them.
    expect(actor?.scopes).not.toContain('pages:write');
    expect(second.scope.split(' ')).not.toContain('pages:write');
    // Reusing the rotated token fails.
    const reused = await b.agent('/api/auth/oauth2/token', {
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: CLIENT,
    });
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ error: 'invalid_grant' });
});

it('revoking a grant ends its tokens at once, for the person or an admin', async () => {
    const b = await brain();
    const ada = await b.person('ada@example.com', 'Ada');
    const admin = await b.person('root@example.com', 'Root', 'admin');
    const first = await connect(b, ada.jar);
    const second = await connect(b, ada.jar, { label: 'Second' });
    const one = (await b.platform.agentGrants.resolve(first.access_token, MCP))!;
    const two = (await b.platform.agentGrants.resolve(second.access_token, MCP))!;

    // Another member can't revoke it: it is "not found".
    const bob = await b.person('bob@example.com', 'Bob');
    expect(
        (
            await b.call(bob.jar, `/api/agent-grants/${one.grantId}`, {
                method: 'DELETE',
            })
        ).status,
    ).toBe(404);
    const revoked = await b.call(ada.jar, `/api/agent-grants/${one.grantId}`, {
        method: 'DELETE',
    });
    expect(revoked.status).toBe(200);
    expect(await b.platform.agentGrants.resolve(first.access_token, MCP)).toBeNull();
    const refresh = await b.agent('/api/auth/oauth2/token', {
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: CLIENT,
    });
    expect(refresh.status).toBe(400);
    // The other grant of the same app and person goes on.
    expect(await b.platform.agentGrants.resolve(second.access_token, MCP)).toEqual(two);
    const stillRefreshes = await b.agent('/api/auth/oauth2/token', {
        grant_type: 'refresh_token',
        refresh_token: second.refresh_token,
        client_id: CLIENT,
    });
    expect(stillRefreshes.status).toBe(200);

    // Admins list everyone's and revoke any; members can't.
    expect((await b.call(bob.jar, '/api/admin/agent-grants')).status).toBe(403);
    const all = (await (await b.call(admin.jar, '/api/admin/agent-grants')).json()) as {
        grants: AgentGrantAdminView[];
        settings: { allowedDomains: string[] | null };
    };
    expect(all.settings).toEqual({ allowedDomains: null });
    expect(all.grants.map((grant) => [grant.personName, grant.label])).toEqual([['Ada', 'Second']]);
    const byAdmin = await b.call(admin.jar, `/api/admin/agent-grants/${two.grantId}`, { method: 'DELETE' });
    expect(byAdmin.status).toBe(200);
    expect(await b.platform.agentGrants.resolve(second.access_token, MCP)).toBeNull();
    expect(b.workspace.auditOf('agent_grant', two.grantId)).toEqual([expect.objectContaining({ action: 'revoke' })]);
});

it('refuses a token for another resource, and a request for another resource', async () => {
    const b = await brain();
    const { jar } = await b.person('ada@example.com', 'Ada');
    const { access_token } = await connect(b, jar);
    expect(await b.platform.agentGrants.resolve(access_token, `${ORIGIN}/api`)).toBeNull();
    expect(await b.platform.agentGrants.resolve(access_token, 'https://other.example/mcp')).toBeNull();
    expect(await b.platform.agentGrants.resolve('cbat_nope', MCP)).toBeNull();
    expect(await b.platform.agentGrants.resolve('', MCP)).toBeNull();
    // An authorization for another resource never gets a code.
    const other = await authorize(b, jar, authorizeQuery({ resource: 'https://other.example/mcp' }));
    expect(other.location.searchParams.get('error')).toBe('invalid_target');
    expect(other.location.searchParams.get('code')).toBeNull();
    // Nor one without a resource: its token could not be bound to /mcp.
    const none = await authorize(b, jar, authorizeQuery({ resource: undefined }));
    expect(none.location.pathname).toBe('/connect');
    const answer = await b.call(jar, '/api/agent-consent', {
        body: { query: none.location.search.slice(1), accept: true },
    });
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({
        error: `The agent must ask for this workspace's MCP endpoint, ${MCP}. Connect it to that address.`,
    });
    expect(b.platform.agentGrants.listAll()).toHaveLength(1);
});

it('refuses a deactivated person, and revokes their grants', async () => {
    const b = await brain();
    const ada = await b.person('ada@example.com', 'Ada');
    const admin = await b.person('root@example.com', 'Root', 'admin');
    const { access_token, refresh_token } = await connect(b, ada.jar);
    const actor = (await b.platform.agentGrants.resolve(access_token, MCP))!;
    // Banned directly (as a deactivation does first), the token stops at once.
    const db = new DatabaseSync(b.path);
    db.prepare('UPDATE auth_user SET banned=1 WHERE id=?').run(ada.accountId);
    expect(await b.platform.agentGrants.resolve(access_token, MCP)).toBeNull();
    db.prepare('UPDATE auth_user SET banned=0 WHERE id=?').run(ada.accountId);
    db.close();
    expect(await b.platform.agentGrants.resolve(access_token, MCP)).toEqual(actor);
    // A deactivation revokes the grant too, so reactivating doesn't revive it.
    const deactivated = await b.call(admin.jar, `/api/accounts/${ada.accountId}/deactivate`, { body: {} });
    expect(deactivated.status).toBe(200);
    await b.call(admin.jar, `/api/accounts/${ada.accountId}/reactivate`, {
        body: {},
    });
    expect(await b.platform.agentGrants.resolve(access_token, MCP)).toBeNull();
    expect(b.platform.agentGrants.list(actor.userId)).toEqual([]);
    const refresh = await b.agent('/api/auth/oauth2/token', {
        grant_type: 'refresh_token',
        refresh_token,
        client_id: CLIENT,
    });
    expect(refresh.status).toBe(400);
});

it('refuses scopes outside the agent scopes, and requires PKCE (S256)', async () => {
    const b = await brain();
    const { jar } = await b.person('ada@example.com', 'Ada');
    for (const scope of ['issues:read admin', 'openid', 'issues:read profile']) {
        const { location } = await authorize(b, jar, authorizeQuery({ scope }));
        expect(location.origin + location.pathname, scope).toBe(REDIRECT);
        expect(location.searchParams.get('error'), scope).toBe('invalid_scope');
    }
    const plain = await authorize(b, jar, authorizeQuery({ code_challenge_method: 'plain' }));
    expect(plain.location.searchParams.get('error')).toBe('invalid_request');
    const none = await authorize(
        b,
        jar,
        authorizeQuery({
            code_challenge: undefined,
            code_challenge_method: undefined,
        }),
    );
    expect(none.location.searchParams.get('error')).toBe('invalid_request');
    // A narrower request is fine: the grant has only what was asked for.
    const { access_token } = await connect(b, jar, {
        scope: 'issues:read offline_access',
    });
    expect((await b.platform.agentGrants.resolve(access_token, MCP))?.scopes).toEqual(['issues:read']);
});

it('refuses a code without its PKCE verifier, and a denied consent gets no code', async () => {
    const b = await brain();
    const { jar } = await b.person('ada@example.com', 'Ada');
    const { location } = await authorize(b, jar, authorizeQuery());
    const approved = await b.call(jar, '/api/agent-consent', {
        body: { query: location.search.slice(1), accept: true },
    });
    const code = new URL(((await approved.json()) as { url: string }).url).searchParams.get('code')!;
    const wrong = await b.agent('/api/auth/oauth2/token', {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: CLIENT,
        code_verifier: pkce().verifier,
        resource: MCP,
    });
    expect(wrong.status).toBe(400);
    // The label defaults to the client's name.
    expect(b.platform.agentGrants.listAll().map((grant) => grant.label)).toEqual(['Claude Code']);

    const again = await authorize(b, jar, authorizeQuery());
    const denied = await b.call(jar, '/api/agent-consent', {
        body: { query: again.location.search.slice(1), accept: false },
    });
    const back = new URL(((await denied.json()) as { url: string }).url);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('code')).toBeNull();
    expect(b.platform.agentGrants.listAll()).toHaveLength(1);
    // A tampered query is refused.
    const tampered = again.location.search.slice(1).replace('state-123', 'state-999');
    const answer = await b.call(jar, '/api/agent-consent', {
        body: { query: tampered, accept: true },
    });
    expect(answer.status).toBe(400);
});

it('keeps the redirect URI to the document exactly, and the domain allowlist', async () => {
    const b = await brain();
    const { jar } = await b.person('ada@example.com', 'Ada');
    const admin = await b.person('root@example.com', 'Root', 'admin');
    for (const redirect of [
        'http://127.0.0.1:33418/other',
        'http://127.0.0.1:9999/callback',
        'https://evil.example/callback',
        'http://127.0.0.1:33418/callback?x=1',
    ]) {
        const { location } = await authorize(b, jar, authorizeQuery({ redirect_uri: redirect }));
        // The error stays here: never sent to the unknown redirect, no consent.
        expect(location.origin, redirect).toBe(ORIGIN);
        expect(location.pathname, redirect).toBe('/');
        expect(location.searchParams.get('error'), redirect).toBe('invalid_redirect');
    }
    // A portless loopback redirect in the document matches any port.
    const anyPort = await authorize(b, jar, authorizeQuery({ redirect_uri: 'http://localhost:51234/callback' }));
    expect(anyPort.location.pathname).toBe('/connect');

    // With an allowlist, other domains are refused at consent and at use.
    const { access_token } = await connect(b, jar);
    const set = await b.call(admin.jar, '/api/admin/agent-grants/settings', {
        method: 'PUT',
        body: { allowedDomains: ['claude.ai'] },
    });
    expect(await set.json()).toEqual({ allowedDomains: ['claude.ai'] });
    expect(await b.platform.agentGrants.resolve(access_token, MCP)).toBeNull();
    const { location } = await authorize(b, jar, authorizeQuery());
    const view = (await (
        await b.call(jar, `/api/agent-consent?query=${encodeURIComponent(location.search.slice(1))}`)
    ).json()) as AgentConsentView;
    expect(view.refusal).toContain('claude.ai');
    const refused = await b.call(jar, '/api/agent-consent', {
        body: { query: location.search.slice(1), accept: true },
    });
    expect(refused.status).toBe(403);
    await b.call(admin.jar, '/api/admin/agent-grants/settings', {
        method: 'PUT',
        body: { allowedDomains: ['client.example'] },
    });
    expect(await b.platform.agentGrants.resolve(access_token, MCP)).not.toBeNull();
});

it('fetches client metadata only from public https hosts, without redirects, small and quickly', async () => {
    const b = await brain();
    const { jar } = await b.person('ada@example.com', 'Ada');
    const doc = {
        client_name: 'Agent',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
    };
    const refusedFor = async (clientId: string) => {
        const { location } = await authorize(b, jar, authorizeQuery({ client_id: clientId }));
        // An unknown client: no consent screen, and nothing sent anywhere.
        expect(location.origin + location.pathname, clientId).toBe(`${ORIGIN}/`);
        expect(location.searchParams.get('error'), clientId).toBe('invalid_client');
    };
    for (const host of [
        'private.example',
        'loopback.example',
        'cgnat.example',
        'metadata.example',
        'v6.example',
        'rebind.example',
    ]) {
        const clientId = `https://${host}/client.json`;
        b.metadata.serve(clientId, doc);
        await refusedFor(clientId);
    }
    // Not https, or no path, or an address: never fetched.
    for (const clientId of [
        'http://client.example/plain.json',
        'https://client.example/',
        `https://${PUBLIC}/client.json`,
    ]) {
        await refusedFor(clientId);
    }
    // A redirect is refused, not followed.
    const moved = 'https://other.example/moved.json';
    b.metadata.serve(moved, '', {
        status: 302,
        headers: { location: 'https://other.example/real.json' },
    });
    b.metadata.serve('https://other.example/real.json', doc);
    await refusedFor(moved);
    // Too large.
    const big = 'https://other.example/big.json';
    b.metadata.serve(big, { ...doc, padding: 'x'.repeat(20_000) });
    await refusedFor(big);
    // Another client id inside than its URL, or a secret.
    const liar = 'https://other.example/liar.json';
    b.metadata.serve(liar, JSON.stringify({ ...doc, client_id: CLIENT }));
    await refusedFor(liar);
    const secret = 'https://other.example/secret.json';
    b.metadata.serve(secret, { ...doc, client_secret: 'shh' });
    await refusedFor(secret);
    // Only hosts that resolve to public addresses were asked for anything.
    expect(
        b.metadata.requests.every((url) => ['client.example', 'other.example'].includes(new URL(url).hostname)),
    ).toBe(true);
    expect(b.metadata.requests).not.toContain('https://other.example/real.json');
    // The good document is fetched once, then cached.
    const fetched = b.metadata.requests.filter((url) => url === CLIENT).length;
    await authorize(b, jar, authorizeQuery());
    await authorize(b, jar, authorizeQuery());
    expect(b.metadata.requests.filter((url) => url === CLIENT).length).toBe(Math.max(fetched, 1));
});

it('requires separate docs consent and rechecks current role and grant revocation for help', async () => {
    const b = await brain();
    const { jar, userId } = await b.person('help@example.com', 'Help reader');
    const roleReads: string[] = [];
    // The catalog the boot step loads (phase 4), a fake one: what `/mcp` reads.
    const catalog: AgentDocsCatalog = {
        list: (role) => [
            { title: 'Chats', description: 'Chat help', url: '/docs/chats' },
            ...(role === 'admin'
                ? [
                      {
                          title: 'Backups',
                          description: 'Recovery',
                          url: '/docs/operate/backups',
                      },
                  ]
                : []),
        ],
        markdown: (path, role) => {
            roleReads.push(String(role));
            return path === '/docs/chats'
                ? '# Chats'
                : path === '/docs/operate/backups' && role === 'admin'
                  ? '# OPERATOR_DOCS_SENTINEL'
                  : null;
        },
        search: async (_query, role) =>
            role === 'admin'
                ? [
                      {
                          id: 'backups',
                          url: '/docs/operate/backups',
                          type: 'page',
                          content: 'OPERATOR_DOCS_SENTINEL',
                      },
                  ]
                : [],
    };
    await loadDocs(b.edge, async () => catalog as unknown as DocsCatalogShape);
    const old = await connect(b, jar, {
        label: 'Pages only',
        scope: 'pages:read',
    });
    const denied = await b.app.request(MCP, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${old.access_token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'read_docs', arguments: { path: '/docs/chats' } },
        }),
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('www-authenticate')).toContain('docs:read');
    expect(roleReads).toEqual([]);
    const tokens = await connect(b, jar, {
        label: 'Help only',
        scope: 'docs:read',
    });
    const actor = await b.platform.agentGrants.resolve(tokens.access_token, MCP);
    expect(actor?.scopes).toEqual(['docs:read']);
    const user = b.workspace.users().find((one) => one.id === actor!.userId)!;
    expect(user).toBeDefined();
    const client = new Client({ name: 'help-reader', version: '1' });
    await client.connect(
        new StreamableHTTPClientTransport(new URL(MCP), {
            requestInit: {
                headers: { Authorization: `Bearer ${tokens.access_token}` },
            },
            fetch: async (url, init) => b.app.request(String(url), init),
        }),
    );
    cleanups.push(() => client.close());
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        'list_docs',
        'read_docs',
        'search_docs',
    ]);
    b.workspace.recordUser({ ...user, role: 'admin' });
    const permitted = await client.callTool({
        name: 'read_docs',
        arguments: { path: '/docs/operate/backups' },
    });
    expect(JSON.stringify(permitted)).toContain('OPERATOR_DOCS_SENTINEL');
    b.workspace.recordUser({ ...user, role: 'member' });
    const downgraded = await client.callTool({
        name: 'read_docs',
        arguments: { path: '/docs/operate/backups' },
    });
    expect(downgraded.isError).toBe(true);
    expect(JSON.stringify(downgraded)).not.toContain('OPERATOR_DOCS_SENTINEL');
    expect(roleReads).toEqual(['admin', 'member']);
    const revoked = b.platform.agentGrants.revoke(actor!.grantId, userId, userId);
    expect(revoked.revokedAt).toEqual(expect.any(Number));
    await expect(client.callTool({ name: 'read_docs', arguments: { path: '/docs/chats' } })).rejects.toThrow();
});

it('gives plugin tools only within the connection’s plugin scopes, and refuses a call outside them (PR #1 review)', async () => {
    const b = await brain({ plugins: true });
    await b.platform.plugins.install('social-strategy');
    const { jar } = await b.person('ada@example.com', 'Ada', 'admin');
    const listTools = async (token: string) => {
        const client = new Client({ name: 'planner-reader', version: '1' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(MCP), {
                requestInit: { headers: { Authorization: `Bearer ${token}` } },
                fetch: async (url, init) => b.app.request(String(url), init),
            }),
        );
        try {
            return (await client.listTools()).tools.map((tool) => tool.name);
        } finally {
            await client.close();
        }
    };
    const call = (token: string, name: string, args: object) =>
        b.app.request(MCP, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name, arguments: args },
            }),
        });
    const planner = [
        'list_planned_posts',
        'create_planned_post',
        'update_planned_post',
        'list_reply_queue',
        'create_reply_item',
        'update_reply_item',
    ];
    const post = {
        account: 'socio',
        plannedLocal: '2026-11-02 09:00',
        parts: [{ text: 'hello' }],
    };

    // An admin's connection without plugin scopes sees no planner tool.
    const issues = await connect(b, jar, { scope: 'issues:read' });
    expect((await listTools(issues.access_token)).filter((name) => planner.includes(name))).toEqual([]);
    const refused = await call(issues.access_token, 'list_planned_posts', {});
    expect(refused.status).toBe(403);
    // The challenge asks for the planner's own scope (CB-254).
    expect(refused.headers.get('www-authenticate')).toContain('scope="plugins:social-strategy:read"');

    // Read-only: the list tools, and a write is refused before it runs.
    const reader = await connect(b, jar, {
        label: 'Planner reader',
        scope: 'plugins:read',
    });
    expect((await listTools(reader.access_token)).filter((name) => planner.includes(name))).toEqual([
        'list_planned_posts',
        'list_reply_queue',
    ]);
    const write = await call(reader.access_token, 'create_planned_post', post);
    expect(write.status).toBe(403);
    expect(write.headers.get('www-authenticate')).toContain('scope="plugins:social-strategy:write"');
    expect(
        b.platform.plugins.dataApp('social-strategy') &&
            (await (await b.platform.plugins.dataApp('social-strategy')!.request('http://plugin/state')).json()),
    ).toMatchObject({ posts: [] });
    const listed = await call(reader.access_token, 'list_planned_posts', {});
    expect(listed.status).toBe(200);

    // Read and write: every planner tool.
    const writer = await connect(b, jar, {
        label: 'Planner writer',
        scope: 'plugins:read plugins:write',
    });
    expect((await listTools(writer.access_token)).filter((name) => planner.includes(name))).toEqual(planner);
});

it('gives a member’s agent the calendar’s tools within its own consented scopes (CB-254)', async () => {
    const b = await brain({ plugins: true, calendar: true });
    await b.platform.plugins.install('calendar');
    const { jar } = await b.person('juli@example.com', 'Juli', 'member');
    const tools = async (token: string) => {
        const client = new Client({ name: 'calendar-sync', version: '1' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(MCP), {
                requestInit: { headers: { Authorization: `Bearer ${token}` } },
                fetch: async (url, init) => b.app.request(String(url), init),
            }),
        );
        return client;
    };
    // The consent screen names the calendar's own scopes.
    const { challenge } = pkce();
    const { location } = await authorize(
        b,
        jar,
        authorizeQuery({ scope: 'plugins:calendar:read plugins:calendar:write' }, challenge),
    );
    const consent = (await (
        await b.call(jar, `/api/agent-consent?query=${encodeURIComponent(location.search.slice(1))}`)
    ).json()) as AgentConsentView;
    expect(consent.scopes).toEqual(['plugins:calendar:read', 'plugins:calendar:write']);
    expect(consent.scopeLabels).toEqual({
        'plugins:calendar:read': 'Read data in the Calendar plugin, if you may use it',
        'plugins:calendar:write': 'Add and change data in the Calendar plugin, if you may use it',
    });

    const sync = await connect(b, jar, {
        label: 'Grok Bot',
        scope: 'plugins:calendar:read plugins:calendar:write',
    });
    const client = await tools(sync.access_token);
    try {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        expect(names).toEqual(expect.arrayContaining(['list_events', 'create_event', 'update_event', 'delete_event']));
        // Not the planner's: neither installed for members nor consented.
        expect(names).not.toContain('list_planned_posts');
        const created = await client.callTool({
            name: 'create_event',
            arguments: {
                title: 'Main Hall',
                start: '2026-11-05T18:00',
                timeZone: 'America/New_York',
                source: 'notion',
                sourceId: '1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6',
            },
        });
        expect(created.isError).toBeFalsy();
        expect(created.structuredContent).toMatchObject({
            outcome: 'created',
            event: {
                createdBy: { name: 'Juli' },
                createdVia: 'Grok Bot for Juli',
                start: '2026-11-05T23:00:00.000Z',
            },
        });
        const again = await client.callTool({
            name: 'create_event',
            arguments: {
                title: 'Main Hall',
                start: '2026-11-05T18:00',
                timeZone: 'America/New_York',
                source: 'notion',
                sourceId: '1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6',
            },
        });
        expect(again.structuredContent).toMatchObject({ outcome: 'unchanged' });
    } finally {
        await client.close();
    }
    // A legacy-scope grant (plugins:read plugins:write, v0.22.0) covers the
    // planner only: no calendar tool, and a call is refused before it runs.
    const legacy = await connect(b, jar, {
        label: 'Legacy',
        scope: 'plugins:read plugins:write',
    });
    const legacyClient = await tools(legacy.access_token);
    try {
        const listed = await legacyClient.listTools().then(
            (result) => result.tools.map((tool) => tool.name),
            () => [],
        );
        for (const name of ['list_events', 'create_event', 'update_event', 'delete_event']) {
            expect(listed).not.toContain(name);
        }
    } finally {
        await legacyClient.close();
    }
    for (const name of ['list_events', 'create_event']) {
        const legacyCall = await b.app.request(MCP, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${legacy.access_token}`,
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name,
                    arguments: { title: 'x', start: '2026-11-05T18:00' },
                },
            }),
        });
        expect(legacyCall.status).toBe(403);
        expect(await legacyCall.json()).toMatchObject({
            code: 'insufficient_scope',
        });
        expect(legacyCall.headers.get('www-authenticate')).toContain(
            `scope="plugins:calendar:${name === 'list_events' ? 'read' : 'write'}"`,
        );
    }
    // A read-only grant lists, and a write is refused before it runs.
    const reader = await connect(b, jar, {
        label: 'Reader',
        scope: 'plugins:calendar:read',
    });
    const refused = await b.app.request(MCP, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${reader.access_token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'delete_event', arguments: { source: 'notion' } },
        }),
    });
    expect(refused.status).toBe(403);
    expect(refused.headers.get('www-authenticate')).toContain('scope="plugins:calendar:write"');
    // An admins-only calendar has no tools for a member’s agent (with no
    // tool at all, the server has no tools/list either).
    await b.platform.plugins.setAudience('calendar', 'admins');
    const after = await tools(sync.access_token);
    try {
        const left = await after.listTools().then(
            (listed) => listed.tools.map((tool) => tool.name),
            () => [],
        );
        expect(left).not.toContain('create_event');
    } finally {
        await after.close();
    }
});
