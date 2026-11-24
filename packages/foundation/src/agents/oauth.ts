/**
 * Connected agents' authorization server (CB-90): its paths, the MCP
 * endpoint's metadata, and the grant a consent is stored for. Moved from
 * `src/server/agents/oauth.ts`, which re-exports them and keeps the Better
 * Auth plugin's options (`agentOAuthOptions`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { AGENT_SCOPES } from '@socio/shared/agents/scopes';

/** The MCP endpoint (Streamable HTTP), the one protected resource. */
export const MCP_PATH = '/mcp';
/** Better Auth's base path: the issuer is the origin plus this. */
export const AUTH_PATH = '/api/auth';
/**
 * What a client may ask for: the agent scopes, and `offline_access`, which
 * the plugin needs to issue a refresh token.
 */
export const OAUTH_SCOPES = [...AGENT_SCOPES, 'offline_access'];
/** The consent screen and the sign-in step before it (client routes). */
export const CONSENT_PATH = '/connect';
export const CONTINUE_PATH = '/connect/continue';

/** RFC 9728's well-known path, for the root and for `/mcp`. */
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
export const AUTHORIZATION_SERVER_PATH = '/.well-known/oauth-authorization-server';

/** Where the OAuth provider plugin keeps clients (the consent screen reads them). */
export const AGENT_CLIENTS_TABLE = 'auth_oauth_client';

/** The MCP endpoint's canonical URL: tokens' audience (RFC 8707). */
export const mcpResource = (origin: string) => `${origin}${MCP_PATH}`;
export const issuerOf = (origin: string) => `${origin}${AUTH_PATH}`;
export const protectedResourceMetadataUrl = (origin: string) => `${origin}${PROTECTED_RESOURCE_PATH}${MCP_PATH}`;

/** The scopes a client may ask for here: these and the per-plugin ones. */
export const oauthScopes = (pluginScopes: readonly string[] = []) => [
    ...AGENT_SCOPES,
    ...pluginScopes,
    'offline_access',
];

/** Protected Resource Metadata (RFC 9728) for `/mcp`. */
export function protectedResourceMetadata(origin: string, pluginScopes: readonly string[] = []) {
    return {
        resource: mcpResource(origin),
        authorization_servers: [issuerOf(origin)],
        scopes_supported: oauthScopes(pluginScopes),
        bearer_methods_supported: ['header'],
        resource_name: 'Socio',
    };
}

/**
 * The `WWW-Authenticate` value for a 401 from `/mcp`: where the metadata
 * is, and the scopes to ask for. `error` is RFC 6750's, for a token that
 * was sent but is not good.
 */
export function agentChallenge(origin: string, error?: 'invalid_token') {
    return [
        `Bearer resource_metadata="${protectedResourceMetadataUrl(origin)}"`,
        `scope="${OAUTH_SCOPES.join(' ')}"`,
        ...(error ? [`error="${error}"`, 'error_description="The access token is invalid, expired or revoked."'] : []),
    ].join(', ');
}

/**
 * The grant a consent is being stored for. The plugin keeps consents and
 * tokens per "reference"; ours is the grant id, set only while the consent
 * screen's approval runs. Elsewhere there is none, so no stored consent is
 * ever found and every authorization shows the consent screen.
 */
const consentGrant = new AsyncLocalStorage<string>();
export const withConsentGrant = <T>(grantId: string, run: () => Promise<T>) => consentGrant.run(grantId, run);
/** The grant id `withConsentGrant` set, if this runs inside it. */
export const consentGrantId = () => consentGrant.getStore();
