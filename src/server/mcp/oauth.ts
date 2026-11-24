import { randomBytes } from 'node:crypto';

import {
    auth,
    discoverOAuthServerInfo,
    refreshAuthorization,
    type OAuthClientProvider,
    type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
    OAuthClientInformationMixed,
    OAuthTokens,
    OAuthClientMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';

import { MCP_LIMITS } from '@socio/shared/mcp-connections';

import { withMcpClient, listMcpCatalog, type McpChallenge } from './client.js';
import { McpConnections } from './connections.js';
import { McpConnectionError } from './contract.js';
import { mcpAssert, mcpError } from './errors.js';
import { fingerprint, boundedJson } from './json.js';
import { guardedMcpFetch, mcpUrl, oauthUrl, resolvePublicMcpDestination, type McpNetworkOptions } from './network.js';

export interface McpOAuthCredentials {
    discovery: OAuthDiscoveryState;
    clientInformation?: OAuthClientInformationMixed;
    tokens?: OAuthTokens;
    expiresAt?: number;
    scopes?: string[];
}
interface AttemptData extends McpOAuthCredentials {
    codeVerifier?: string;
    scopes: string[];
}
export const mcpOAuthSelection = z
    .object({
        generation: z.number().int().positive(),
        scopes: z.array(z.string().regex(/^[A-Za-z0-9:._/-]{1,160}$/)).max(100),
        client: z
            .object({
                id: z.string().min(1).max(500),
                secret: z.string().min(1).max(4096).optional(),
                issuer: z.string().url().max(2048),
            })
            .strict()
            .optional(),
    })
    .strict();
export function mcpClientMetadata(origin: string): OAuthClientMetadata {
    const url = new URL(origin);
    mcpAssert(
        url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
        'Configure a canonical HTTPS APP_ORIGIN for external OAuth.',
    );
    return {
        client_name: 'Socio',
        client_uri: url.origin,
        redirect_uris: [url.origin + '/api/mcp-connections/oauth/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
    };
}
/** Verify what SDK1.31 deliberately does not: discovery metadata issuer must echo the chosen issuer. */
export function validateMcpDiscovery(discovery: OAuthDiscoveryState, serverUrl: string) {
    boundedJson(discovery, MCP_LIMITS.metadataBytes);
    const issuer = oauthUrl(discovery.authorizationServerUrl);
    mcpAssert(!issuer.search, 'Authorization issuer must not include a query.');
    const metadata = discovery.authorizationServerMetadata;
    mcpAssert(metadata, 'The external server does not publish OAuth metadata.');
    mcpAssert(
        oauthUrl(metadata.issuer).href === issuer.href,
        'Authorization metadata issuer does not match its discovery issuer.',
    );
    for (const url of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint]) {
        if (url) {
            oauthUrl(url);
        }
    }
    if (metadata.code_challenge_methods_supported) {
        mcpAssert(
            metadata.code_challenge_methods_supported.includes('S256'),
            'The authorization server does not support PKCE S256.',
        );
    }
    const resource = discovery.resourceMetadata?.resource;
    mcpAssert(resource, 'The external server must publish protected resource metadata.');
    const parsed = oauthUrl(resource),
        server = mcpUrl(serverUrl);
    mcpAssert(
        !parsed.search &&
            parsed.origin === server.origin &&
            (parsed.pathname === server.pathname ||
                server.pathname.startsWith(parsed.pathname.endsWith('/') ? parsed.pathname : parsed.pathname + '/')),
        'Protected resource metadata does not cover this MCP endpoint.',
    );
    return { issuer: issuer.href, resource };
}
export class McpOAuth {
    private refreshes = new Map<string, Promise<McpOAuthCredentials>>();
    constructor(
        private connections: McpConnections,
        readonly origin: string,
        private network: McpNetworkOptions = {},
    ) {
        try {
            this.origin = new URL(origin).origin;
        } catch {
            this.origin = '';
        }
        // Missing secure public origin disables interactive OAuth, not app startup.
    }
    private fetch(signal: AbortSignal) {
        return guardedMcpFetch({
            ...this.network,
            signal,
            maxBytes: MCP_LIMITS.metadataBytes,
            timeoutMs: 10_000,
        });
    }
    async discover(userId: string, id: string, outer?: AbortSignal) {
        mcpClientMetadata(this.origin);
        const old = this.connections.owned(userId, id);
        mcpAssert(old.authentication === 'oauth', 'This connection does not use OAuth.');
        let row = old;
        await this.connections.repository.atomic(async () => {
            this.connections.owned(userId, id, old.generation);
            row = (await this.connections.repository.reset(userId, id, 'authorizing', Date.now()))!;
        });
        this.connections.abort(userId, id);
        const scoped = this.connections.scoped(userId, id, row.generation, outer);
        try {
            let challenge: McpChallenge = {};
            try {
                await withMcpClient(
                    {
                        url: row.url,
                        signal: scoped.signal,
                        fetch: this.fetch(scoped.signal),
                        challenge: (value) => {
                            challenge = value;
                        },
                    },
                    async () => undefined,
                );
            } catch (error) {
                if (!challenge.resourceMetadataUrl && !challenge.scope) {
                    /* A 401 without challenge metadata uses well-known discovery. */ void error;
                }
            }
            this.connections.owned(userId, id, row.generation);
            const discovery = await discoverOAuthServerInfo(row.url, {
                fetchFn: this.fetch(scoped.signal),
                resourceMetadataUrl: challenge.resourceMetadataUrl,
            });
            const state: OAuthDiscoveryState = JSON.parse(
                JSON.stringify({
                    ...discovery,
                    ...(challenge.resourceMetadataUrl
                        ? { resourceMetadataUrl: challenge.resourceMetadataUrl.href }
                        : {}),
                }),
            );
            const bound = validateMcpDiscovery(state, row.url);
            await resolvePublicMcpDestination(state.authorizationServerMetadata!.authorization_endpoint, {
                ...this.network,
                signal: scoped.signal,
            });
            await this.connections.saveCredentials(userId, id, row.generation, {
                discovery: state,
            });
            const scopes = [
                ...new Set(
                    state.resourceMetadata?.scopes_supported ??
                        state.authorizationServerMetadata?.scopes_supported ??
                        [],
                ),
            ];
            boundedJson(scopes, 8192);
            mcpAssert(
                scopes.length <= 100 && scopes.every((s) => typeof s === 'string' && s.length <= 160),
                'The server publishes too many OAuth scopes.',
            );
            return {
                connection: this.connections.get(userId, id),
                ...bound,
                scopes,
                requiredScopes: challenge.scope?.split(' ').filter(Boolean) ?? [],
                registration: {
                    clientMetadata: state.authorizationServerMetadata?.client_id_metadata_document_supported === true,
                    dynamic: !!state.authorizationServerMetadata?.registration_endpoint,
                },
            };
        } catch {
            if (this.connections.running) {
                await this.connections.repository.transition(userId, id, row.generation, 'error', Date.now());
            }
            throw mcpError(
                'Could not discover a compatible public OAuth MCP server. Check its endpoint and authorization metadata.',
                502,
            );
        } finally {
            scoped.release();
        }
    }
    async authorize(userId: string, id: string, input: z.input<typeof mcpOAuthSelection>, outer?: AbortSignal) {
        const selection = mcpOAuthSelection.parse(input);
        let row = this.connections.owned(userId, id, selection.generation);
        mcpAssert(row.state === 'authorizing', 'Discover and review this connection before authorizing it.', 409);
        const saved = this.connections.credentials<McpOAuthCredentials>(userId, id, row.generation);
        mcpAssert(saved?.discovery, 'Discover authorization metadata first.', 409);
        const bound = validateMcpDiscovery(saved.discovery, row.url);
        const known =
            saved.discovery.resourceMetadata?.scopes_supported ??
            saved.discovery.authorizationServerMetadata?.scopes_supported;
        mcpAssert(
            !known || selection.scopes.every((s) => known.includes(s)),
            'Choose only scopes offered by this server.',
        );
        const scopes = [...new Set(selection.scopes)];
        if (selection.client) {
            mcpAssert(
                oauthUrl(selection.client.issuer).href === bound.issuer,
                'Pre-registered client issuer must match the reviewed authorization server.',
            );
        }
        await this.connections.repository.atomic(async () => {
            this.connections.owned(userId, id, selection.generation);
            row = (await this.connections.repository.reset(userId, id, 'authorizing', Date.now()))!;
            await this.connections.saveCredentials(userId, id, row.generation, JSON.parse(JSON.stringify(saved)));
        });
        this.connections.abort(userId, id);
        const nonce = randomBytes(32).toString('base64url'),
            cookie = randomBytes(32).toString('base64url'),
            stateHash = fingerprint(nonce),
            now = Date.now();
        const data: AttemptData = {
            discovery: saved.discovery,
            scopes,
            ...(selection.client
                ? {
                      clientInformation: {
                          client_id: selection.client.id,
                          ...(selection.client.secret ? { client_secret: selection.client.secret } : {}),
                          issuer: saved.discovery.authorizationServerUrl,
                      },
                  }
                : {}),
        };
        await this.connections.repository.createOAuth({
            stateHash,
            connectionId: id,
            userId,
            generation: row.generation,
            cookieHash: fingerprint(cookie),
            secret: this.connections.encrypt(userId, id, row.generation, data),
            state: 'pending',
            createdAt: now,
            expiresAt: now + MCP_LIMITS.oauthMs,
        });
        let authorizationUrl: URL | undefined;
        const scoped = this.connections.scoped(userId, id, row.generation, outer);
        const persist = async () => {
            mcpAssert(
                await this.connections.repository.saveOAuth(
                    userId,
                    stateHash,
                    row.generation,
                    this.connections.encrypt(userId, id, row.generation, data),
                ),
                'Authorization attempt changed.',
                409,
            );
        };
        try {
            const provider = this.provider(userId, id, row.generation, data, nonce, persist, (url) => {
                authorizationUrl = url;
            });
            const result = await auth(provider, {
                serverUrl: row.url,
                scope: scopes.join(' '),
                fetchFn: this.authFetch(data, scoped.signal),
            });
            mcpAssert(
                result === 'REDIRECT' && authorizationUrl,
                'The authorization server did not return a consent URL.',
            );
            await resolvePublicMcpDestination(authorizationUrl, {
                ...this.network,
                signal: scoped.signal,
            });
            return {
                authorizationUrl: authorizationUrl.href,
                issuer: bound.issuer,
                scopes,
                expiresAt: now + MCP_LIMITS.oauthMs,
                stateHash,
                cookie,
            };
        } catch {
            if (this.connections.running) {
                await this.connections.repository.endOAuth(userId, stateHash);
            }
            throw mcpError(
                'Authorization could not start. This server may require a pre-registered OAuth client.',
                502,
            );
        } finally {
            scoped.release();
        }
    }
    private provider(
        userId: string,
        id: string,
        generation: number,
        data: AttemptData,
        nonce: string,
        persist: () => Promise<void>,
        redirect: (url: URL) => void,
    ): OAuthClientProvider {
        const row = this.connections.owned(userId, id, generation);
        const metadata = mcpClientMetadata(this.origin);
        return {
            redirectUrl: metadata.redirect_uris[0],
            clientMetadataUrl: this.origin + '/.well-known/socio-mcp-client.json',
            clientMetadata: {
                ...metadata,
                ...(data.scopes.length ? { scope: data.scopes.join(' ') } : {}),
            },
            state: () => nonce,
            clientInformation: () => data.clientInformation,
            saveClientInformation: async (info) => {
                mcpAssert(info.issuer === data.discovery.authorizationServerUrl, 'OAuth registration issuer changed.');
                data.clientInformation = info;
                await persist();
            },
            tokens: () => data.tokens,
            saveTokens: async (tokens) => {
                this.acceptTokens(data, tokens);
                await persist();
            },
            codeVerifier: () => {
                mcpAssert(data.codeVerifier, 'Authorization verifier is missing.');
                return data.codeVerifier;
            },
            saveCodeVerifier: async (code) => {
                mcpAssert(code.length <= 512, 'Authorization verifier is too large.');
                data.codeVerifier = code;
                await persist();
            },
            redirectToAuthorization: (url) => {
                oauthUrl(url.href);
                const endpoint = data.discovery.authorizationServerMetadata!.authorization_endpoint;
                mcpAssert(
                    url.origin === new URL(endpoint).origin && url.pathname === new URL(endpoint).pathname,
                    'Authorization URL changed its reviewed destination.',
                );
                redirect(url);
            },
            // The SDK otherwise falls back to ALL advertised scopes when explicit scope is empty.
            discoveryState: () => ({
                ...data.discovery,
                resourceMetadata: {
                    ...data.discovery.resourceMetadata!,
                    scopes_supported: data.scopes,
                },
            }),
            saveDiscoveryState: async (next) => {
                validateMcpDiscovery(next, row.url);
                mcpAssert(
                    next.authorizationServerUrl === data.discovery.authorizationServerUrl,
                    'Authorization issuer changed.',
                );
                data.discovery = next;
                await persist();
            },
            invalidateCredentials: () => {
                throw mcpError('Authorization failed. Start a new explicit connection attempt.');
            },
        };
    }
    private acceptTokens(data: McpOAuthCredentials, tokens: OAuthTokens) {
        mcpAssert(tokens.issuer === data.discovery.authorizationServerUrl, 'OAuth token issuer changed.');
        mcpAssert(
            /^Bearer$/i.test(tokens.token_type) &&
                tokens.access_token.length <= 8192 &&
                !/[\r\n]/.test(tokens.access_token),
            'Unsupported OAuth access token.',
        );
        mcpAssert(
            !tokens.refresh_token || (tokens.refresh_token.length <= 8192 && !/[\r\n]/.test(tokens.refresh_token)),
            'Unsupported OAuth refresh token.',
        );
        if (tokens.scope) {
            mcpAssert(
                tokens.scope
                    .split(' ')
                    .filter(Boolean)
                    .every((s) => data.scopes?.includes(s)),
                'The server granted scopes outside the reviewed selection.',
            );
        }
        data.tokens = tokens;
        if (tokens.expires_in !== undefined) {
            mcpAssert(
                Number.isFinite(tokens.expires_in) && tokens.expires_in > 0 && tokens.expires_in <= 365 * 86400,
                'Unsupported OAuth token lifetime.',
            );
            data.expiresAt = Date.now() + tokens.expires_in * 1000;
        } else {
            delete data.expiresAt;
        }
    }
    private authFetch(data: McpOAuthCredentials, signal: AbortSignal): typeof fetch {
        const fetch = this.fetch(signal);
        return (input, init = {}) => {
            const url = oauthUrl(String(input));
            const metadata = data.discovery.authorizationServerMetadata!;
            const tokenUrl = oauthUrl(metadata.token_endpoint).href,
                register = metadata.registration_endpoint ? oauthUrl(metadata.registration_endpoint).href : undefined;
            const headers = new Headers(init.headers);
            if (headers.has('authorization') || init.method?.toUpperCase() === 'POST') {
                mcpAssert(
                    url.href === tokenUrl || url.href === register,
                    'OAuth credentials may only reach reviewed token or registration endpoints.',
                );
            }
            return fetch(input, init);
        };
    }
    async callback(userId: string, nonce: string, cookie: string, code: string, outer?: AbortSignal) {
        mcpAssert(
            /^[A-Za-z0-9_-]{43}$/.test(nonce) &&
                /^[A-Za-z0-9_-]{43}$/.test(cookie) &&
                code.length > 0 &&
                code.length <= 4096,
            'Invalid authorization callback.',
        );
        this.connections.person(userId);
        const hash = fingerprint(nonce),
            attempt = await this.connections.repository.claimOAuth(userId, hash, fingerprint(cookie), Date.now());
        mcpAssert(attempt, 'Authorization expired, changed or was already used.', 409);
        const row = this.connections.owned(userId, attempt.connectionId, attempt.generation),
            data = this.connections.decrypt<AttemptData>(userId, row.id, row.generation, attempt.secret);
        validateMcpDiscovery(data.discovery, row.url);
        const scoped = this.connections.scoped(userId, row.id, row.generation, outer);
        try {
            const provider = this.provider(
                userId,
                row.id,
                row.generation,
                data,
                nonce,
                async () => {
                    this.connections.owned(userId, row.id, row.generation);
                },
                () => {
                    throw mcpError('Authorization callback may not redirect again.');
                },
            );
            const result = await auth(provider, {
                serverUrl: row.url,
                authorizationCode: code,
                scope: data.scopes.join(' '),
                fetchFn: this.authFetch(data, scoped.signal),
            });
            mcpAssert(result === 'AUTHORIZED' && data.tokens, 'Authorization did not issue credentials.');
            const credentials: McpOAuthCredentials = {
                discovery: data.discovery,
                clientInformation: data.clientInformation,
                tokens: data.tokens,
                ...(data.expiresAt ? { expiresAt: data.expiresAt } : {}),
                scopes: data.scopes,
            };
            // Optional SDK fields are JSON, not undefined properties in persisted secrets.
            await this.connections.saveCredentials(
                userId,
                row.id,
                row.generation,
                JSON.parse(JSON.stringify(credentials)),
            );
            if (this.connections.running) {
                await this.connections.repository.transition(userId, row.id, row.generation, 'review', Date.now());
            }
            return this.connections.get(userId, row.id);
        } catch {
            if (this.connections.running) {
                await this.connections.repository.transition(userId, row.id, row.generation, 'error', Date.now());
            }
            throw mcpError(
                'Authorization did not complete. Start a new connection attempt; this callback will not be replayed.',
                502,
            );
        } finally {
            scoped.release();
            if (this.connections.running) {
                await this.connections.repository.endOAuth(userId, hash);
            }
        }
    }
    async credentials(
        userId: string,
        id: string,
        generation: number,
        signal?: AbortSignal,
    ): Promise<McpOAuthCredentials | undefined> {
        const row = this.connections.owned(userId, id, generation);
        if (row.authentication === 'none') {
            return undefined;
        }
        const data = this.connections.credentials<McpOAuthCredentials>(userId, id, generation);
        mcpAssert(
            data?.tokens && ['review', 'connected'].includes(row.state),
            'Reconnect this external connection.',
            409,
        );
        if (data.expiresAt === undefined || data.expiresAt > Date.now() + 30_000) {
            return data;
        }
        const key = userId + ':' + id + ':' + generation,
            existing = this.refreshes.get(key);
        if (existing) {
            return existing;
        }
        const refresh = (async () => {
            mcpAssert(
                data.tokens?.refresh_token && data.clientInformation,
                'The external connection expired; reconnect it.',
                409,
            );
            validateMcpDiscovery(data.discovery, row.url);
            const scoped = signal ? { signal, release: () => {} } : this.connections.scoped(userId, id, generation);
            try {
                const tokens = await refreshAuthorization(data.discovery.authorizationServerUrl, {
                    metadata: data.discovery.authorizationServerMetadata,
                    clientInformation: data.clientInformation,
                    refreshToken: data.tokens.refresh_token,
                    resource: data.discovery.resourceMetadata!.resource,
                    fetchFn: this.authFetch(data, scoped.signal),
                });
                this.acceptTokens(data, {
                    ...tokens,
                    issuer: data.discovery.authorizationServerUrl,
                });
                await this.connections.saveCredentials(userId, id, generation, data);
                return data;
            } catch {
                if (this.connections.running) {
                    await this.connections.repository.transition(userId, id, generation, 'error', Date.now());
                }
                throw mcpError(
                    'The external connection expired or could not refresh. Reconnect it; no tool call was retried.',
                    409,
                );
            } finally {
                scoped.release();
            }
        })();
        this.refreshes.set(key, refresh);
        try {
            return await refresh;
        } finally {
            if (this.refreshes.get(key) === refresh) {
                this.refreshes.delete(key);
            }
        }
    }
    async catalog(userId: string, id: string, outer?: AbortSignal) {
        const row = this.connections.owned(userId, id);
        mcpAssert(
            row.authentication === 'none' || ['review', 'connected'].includes(row.state),
            'Connect this server before reviewing its tools.',
            409,
        );
        const scoped = this.connections.scoped(userId, id, row.generation, outer);
        try {
            const credentials = await this.credentials(userId, id, row.generation, scoped.signal);
            const catalog = await withMcpClient(
                {
                    url: row.url,
                    signal: scoped.signal,
                    token: credentials?.tokens?.access_token,
                    fetch: guardedMcpFetch({ ...this.network, signal: scoped.signal }),
                },
                (client) => listMcpCatalog(client, scoped.signal),
            );
            this.connections.owned(userId, id, row.generation);
            mcpAssert(
                await this.connections.repository.saveCatalog(
                    userId,
                    id,
                    row.generation,
                    catalog.tools,
                    catalog.revision,
                    Date.now(),
                ),
                'Connection changed during catalog review.',
                409,
            );
            this.connections.abort(userId, id);
            return this.connections.get(userId, id);
        } catch (error) {
            if (error instanceof McpConnectionError) {
                throw error;
            }
            throw mcpError('Could not read the external tool catalog. Reconnect or check the server.', 502);
        } finally {
            scoped.release();
        }
    }
}
