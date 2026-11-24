import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { DATA_TOKEN_PREFIX } from '@socio/foundation/actors/redact';
import type { AgentActor } from '@socio/foundation/agents/actor';
import { MCP_PATH, mcpResource, protectedResourceMetadataUrl } from '@socio/foundation/agents/oauth';
import { allowedHost } from '@socio/foundation/http/allowed-host';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { RateLimits } from '@socio/foundation/http/rate-limits';
import { isGrantableScope } from '@socio/shared/agents/scopes';

import type { BoardShape } from '../issues/contract.js';
import type { PluginsShape } from '../plugins/contract.js';
import { SERVICE_KEY_PREFIX, type ServiceAccountsShape } from '../service-accounts/contract.js';

import { agentByline } from './actor.js';
import type { AgentsWorkspace } from './board.js';
import type { AgentDocsCatalog, AgentTokenResolver } from './contract.js';
import { AGENT_TOOL_SCOPES, agentMcpServer } from './mcp-tools.js';

// One definition of the endpoint and its resource URL, shared with the
// authorization side that binds tokens to it (oauth.ts).

/** Per grant, like a service account's key. */
const GRANT_REQUESTS_PER_MINUTE = 300;
/** Room for one attachment at the 5 MB limit, as base64, in a call. */
const BODY_LIMIT = 8_000_000;

/**
 * The origin the resource is named on: the app's origin with this
 * request's hostname (behind the proxy the request itself is plain http),
 * else the request's own.
 */
function resourceOrigin(url: string, origins?: string[]) {
    const { hostname, origin } = new URL(url);
    return (
        origins?.find((one) => {
            try {
                return new URL(one).hostname === hostname;
            } catch {
                return false;
            }
        }) ?? origin
    );
}

/**
 * The scopes the JSON-RPC message (or batch) lacks: tools/call names one.
 * A plugin tool is allowed by any one of its scopes (its plugin's own, or
 * the legacy `plugins:read|write` for the planner); when none is granted the plugin's own is the
 * one asked for.
 */
function scopesMissing(
    body: unknown,
    pluginTools: ReadonlyMap<string, readonly string[]>,
    granted: readonly string[],
): string[] {
    const needed = new Set<string>();
    for (const message of Array.isArray(body) ? body : [body]) {
        if (!message || typeof message !== 'object' || (message as { method?: unknown }).method !== 'tools/call') {
            continue;
        }
        const name = (message as { params?: { name?: unknown } }).params?.name;
        if (typeof name !== 'string') {
            continue;
        }
        if (Object.hasOwn(AGENT_TOOL_SCOPES, name)) {
            const scope = AGENT_TOOL_SCOPES[name as keyof typeof AGENT_TOOL_SCOPES];
            if (!granted.includes(scope)) {
                needed.add(scope);
            }
        } else {
            const plugin = pluginTools.get(name);
            if (plugin?.length && !plugin.some((scope) => granted.includes(scope))) {
                needed.add(plugin[0]!);
            }
        }
    }
    return [...needed];
}

/**
 * What the MCP endpoint reads, each typed by its owner's contract. The
 * workspace is read once, when the routes are made; every other member at
 * each request (`agentTokens` and `docs` are set after the routes are
 * mounted). `composition/http/agents.ts` builds it from the graph's tags and ports.
 */
export interface AgentMcpSources {
    readonly workspace: AgentsWorkspace;
    readonly board: BoardShape;
    readonly plugins: Pick<PluginsShape, 'toolScopes' | 'contributeMcp'>;
    readonly serviceAccounts: Pick<ServiceAccountsShape, 'isService'>;
    /** The authorization side's resolver; the endpoint answers 503 without it. */
    readonly agentTokens?: AgentTokenResolver;
    readonly docs?: AgentDocsCatalog;
}

/**
 * `/mcp` (CB-90): the MCP resource server, Streamable HTTP in stateless
 * mode (a server per request, JSON answers). A bearer token from the
 * authorization side (`platform.agentTokens`) names the agent and its
 * person; tools act as that person, within the grant's scopes. Not under
 * /api, so neither service keys (`cbk_`) nor data tokens reach it, nor
 * does a session cookie: the host check applies, and a browser's Origin
 * must be the app's. Rate limited per grant.
 */
export function mcpRoutes(platform: AgentMcpSources, origins?: string[]) {
    const app = new Hono<AppEnv>();
    const limits = new RateLimits(GRANT_REQUESTS_PER_MINUTE, 60_000);
    const { workspace } = platform;

    /** The live person behind a grant: signed in before, not deactivated, never a service account. */
    const personOf = (actor: AgentActor) => {
        const person = workspace.users().find((user) => user.id === actor.userId);
        if (!person || workspace.isDeactivated(person.id) || platform.serviceAccounts.isService(person.id)) {
            return undefined;
        }
        return person;
    };

    app.all(
        MCP_PATH,
        bodyLimit({
            maxSize: BODY_LIMIT,
            onError: (c) =>
                c.json(
                    {
                        error: 'Request is too large: at most 8 MB, about 6 MB of attachments. Send large files in separate comments.',
                    },
                    413,
                ),
        }),
        async (c: Context<AppEnv>) => {
            c.header('Cache-Control', 'no-store');
            c.header('X-Content-Type-Options', 'nosniff');
            if (!allowedHost(c.req.url, origins)) {
                return c.json({ error: 'Unrecognized host.' }, 403);
            }
            const requestOrigin = c.req.header('origin');
            if (requestOrigin && !(origins ?? [new URL(c.req.url).origin]).includes(requestOrigin)) {
                return c.json({ error: 'Cross-origin requests are not allowed.' }, 403);
            }
            // The seam the authorization side fills (OAuth 2.1 + CIMD grants).
            const resolve = platform.agentTokens;
            if (!resolve) {
                return c.json({ error: 'Connected agents are not set up.' }, 503);
            }
            const origin = resourceOrigin(c.req.url, origins);
            const challenge = (params: string[] = []) =>
                c.header(
                    'WWW-Authenticate',
                    `Bearer ${[...params, `resource_metadata="${protectedResourceMetadataUrl(origin)}"`].join(', ')}`,
                );
            const token = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header('authorization') ?? '')?.[1];
            if (!token) {
                challenge();
                return c.json({ error: 'Connect this agent to continue.', code: 'sign_in' }, 401);
            }
            // Service keys and data tokens are for /api only, never resolved here.
            const actor =
                token.startsWith(SERVICE_KEY_PREFIX) || token.startsWith(DATA_TOKEN_PREFIX)
                    ? null
                    : await resolve(token, mcpResource(origin));
            const person = actor ? personOf(actor) : undefined;
            if (!actor || !person) {
                challenge(['error="invalid_token"', 'error_description="The token is invalid, expired or revoked."']);
                return c.json(
                    {
                        error: 'The token is invalid, expired or revoked.',
                        code: 'bad_token',
                    },
                    401,
                );
            }
            if (!limits.take(actor.grantId)) {
                c.header('Retry-After', '60');
                return c.json(
                    {
                        error: 'Too many requests for this connection. Try again in a minute.',
                    },
                    429,
                );
            }
            // Stateless: no session stream to open or end.
            if (c.req.method !== 'POST') {
                c.header('Allow', 'POST');
                return c.json({ error: 'Use POST.' }, 405);
            }
            if (!c.req.header('content-type')?.includes('application/json')) {
                return c.json({ error: 'Use application/json.' }, 415);
            }
            const body: unknown = await c.req.json().catch(() => undefined);
            if (body === undefined) {
                return c.json(
                    {
                        jsonrpc: '2.0',
                        error: { code: -32700, message: 'Parse error' },
                        id: null,
                    },
                    400,
                );
            }
            const scopes = actor.scopes.filter((scope) => isGrantableScope(scope));
            const missing = scopesMissing(body, platform.plugins.toolScopes(), scopes);
            if (missing.length) {
                challenge([
                    'error="insufficient_scope"',
                    `scope="${missing.join(' ')}"`,
                    `error_description="This connection was not granted ${missing.join(', ')}."`,
                ]);
                return c.json(
                    {
                        error: `This connection was not granted ${missing.join(', ')}.`,
                        code: 'insufficient_scope',
                    },
                    403,
                );
            }
            const server = agentMcpServer({
                workspace,
                board: platform.board,
                actor: { ...actor, scopes },
                person,
                origin,
                docs: platform.docs,
                contribute: (mcp) =>
                    platform.plugins.contributeMcp(
                        mcp,
                        {
                            person,
                            origin,
                            scopes,
                            via: agentByline(actor, person.name),
                        },
                        new Set(Object.keys(AGENT_TOOL_SCOPES)),
                    ),
            });
            const transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                enableJsonResponse: true,
            });
            await server.connect(transport);
            try {
                return await transport.handleRequest(c.req.raw, {
                    parsedBody: body,
                    authInfo: {
                        token,
                        clientId: actor.clientId,
                        scopes: [...scopes],
                        resource: new URL(mcpResource(origin)),
                    },
                });
            } finally {
                await server.close();
            }
        },
    );
    return app;
}
