import type { ClientDiscovery, OAuthOptions, Scope } from '@better-auth/oauth-provider';

import {
    AGENT_CLIENTS_TABLE,
    CONSENT_PATH,
    CONTINUE_PATH,
    consentGrantId,
    mcpResource,
    oauthScopes,
} from '@socio/foundation/agents/oauth';

import { redirectUriMatches } from './cimd.js';
import type { CimdShape, ClientMetadata } from './contract.js';
import { AGENT_ACCESS_TOKEN_PREFIX, AGENT_REFRESH_TOKEN_PREFIX, hashAgentToken } from './grants.js';

/**
 * Connected agents' authorization server (CB-90): Better Auth's OAuth
 * provider plugin, set up for MCP clients. OAuth 2.1 authorization code
 * with PKCE (S256), refresh tokens that rotate, clients that register by
 * their Client ID Metadata Document (no Dynamic Client Registration), and
 * tokens bound to the MCP endpoint (RFC 8707). Access tokens are opaque and
 * stored hashed; each carries its grant's id (the plugin's `referenceId`).
 *
 * The paths, the metadata and the consent's grant live in
 * `@socio/foundation/agents/oauth`.
 */

/** Agents' access tokens live an hour; refresh tokens 30 days, rotating. */
const ACCESS_TOKEN_SECONDS = 60 * 60;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
/** A stored client is used for a day when its document can't be fetched. */
const STALE_CLIENT_MS = 24 * 60 * 60_000;

/** The plugin's tables, under `auth_oauth_` names (auth/schema.ts). */
const SCHEMA = {
    oauthClient: { modelName: AGENT_CLIENTS_TABLE },
    oauthResource: { modelName: 'auth_oauth_resource' },
    oauthClientResource: { modelName: 'auth_oauth_client_resource' },
    oauthRefreshToken: { modelName: 'auth_oauth_refresh_token' },
    oauthAccessToken: { modelName: 'auth_oauth_access_token' },
    oauthConsent: { modelName: 'auth_oauth_consent' },
    oauthClientAssertion: { modelName: 'auth_oauth_client_assertion' },
};

/**
 * Clients by their metadata document: the `client_id` is its https URL,
 * fetched safely (cimd.ts) and stored as the plugin's client record, which
 * is refreshed when the cached document has expired.
 */
function cimdDiscovery(fetcher: CimdShape, now: () => number): ClientDiscovery {
    return {
        id: 'cimd',
        matches: (clientId) => clientId.startsWith('https://'),
        discoveryMetadata: { client_id_metadata_document_supported: true },
        resolve: async (ctx, clientId, existing) => {
            if (existing && fetcher.cached(clientId)) {
                return existing;
            }
            let metadata: ClientMetadata;
            try {
                metadata = await fetcher.get(clientId);
            } catch (error) {
                const updated = existing?.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
                if (existing && now() - updated < STALE_CLIENT_MS) {
                    return existing;
                }
                ctx.context.logger.warn(
                    `Connected agents: no client metadata from ${new URL(clientId).host}: ${error instanceof Error ? error.message : 'failed'}`,
                );
                return null;
            }
            const { registerClientMetadataDocument } = await import('@better-auth/oauth-provider/internal');
            const opts = ctx.context.getPlugin('oauth-provider')?.options as OAuthOptions<Scope[]> | undefined;
            if (!opts) {
                return null;
            }
            const { client } = await registerClientMetadataDocument(ctx, opts, {
                clientId,
                clientDiscoveryId: 'cimd',
                existingClient: existing ?? undefined,
                metadata: {
                    client_id: clientId,
                    client_name: metadata.name,
                    ...(metadata.logoUri ? { logo_uri: metadata.logoUri } : {}),
                    ...(metadata.clientUri ? { client_uri: metadata.clientUri } : {}),
                    redirect_uris: metadata.redirectUris,
                    token_endpoint_auth_method: 'none',
                    grant_types: ['authorization_code', 'refresh_token'],
                    response_types: ['code'],
                    application_type: metadata.applicationType,
                },
            });
            return client;
        },
    };
}

/** The plugin's options for this origin. */
export function agentOAuthOptions({
    origin,
    fetcher,
    now = Date.now,
    pluginScopes = [],
}: {
    origin: string;
    fetcher: CimdShape;
    now?: () => number;
    /** Per-plugin scopes this instance offers (CB-254). */
    pluginScopes?: readonly string[];
}): OAuthOptions<Scope[]> {
    return {
        scopes: oauthScopes(pluginScopes),
        grantTypes: ['authorization_code', 'refresh_token'],
        loginPage: CONTINUE_PATH,
        consentPage: CONSENT_PATH,
        // Opaque tokens, looked up (and so revoked) in the database; no JWKS.
        disableJwtPlugin: true,
        storeClientSecret: 'encrypted',
        storeTokens: { hash: hashAgentToken },
        prefix: {
            opaqueAccessToken: AGENT_ACCESS_TOKEN_PREFIX,
            refreshToken: AGENT_REFRESH_TOKEN_PREFIX,
        },
        accessTokenExpiresIn: ACCESS_TOKEN_SECONDS,
        refreshTokenExpiresIn: REFRESH_TOKEN_SECONDS,
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        resources: [mcpResource(origin)],
        enforcePerClientResources: false,
        // Exactly a redirect URI of the document (a portless loopback one on
        // any port).
        validateRedirectUri: (uri, registered) => redirectUriMatches(uri, registered),
        postLogin: {
            page: CONSENT_PATH,
            shouldRedirect: () => false,
            consentReferenceId: () => consentGrantId(),
        },
        schema: SCHEMA,
        extensions: [{ clientDiscovery: cimdDiscovery(fetcher, now) }],
    };
}
