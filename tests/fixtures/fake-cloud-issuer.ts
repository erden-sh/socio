/**
 * A cloud services issuer in memory, as `fetch`: the endpoints the cloud
 * connection calls (protocol §2), checking what the real one checks of a
 * deployment's requests. It verifies client assertions with the
 * registered public key, so a test sees the signature, the audience and
 * the lifetime the client really sent.
 */
import { createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from 'node:crypto';

export const ISSUER = 'https://cloud.socio.test';
export const PUSH = 'https://push.socio.test';

interface Client {
    id: string;
    jwk: { kty: string; crv: string; x: string; kid: string; alg?: string; use?: string };
    scopes: string;
    mode: 'hosted' | 'self-hosted';
    status: 'active' | 'revoked';
}

export interface IssuerRequest {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
}

export interface FakeIssuer {
    fetch: typeof fetch;
    /** Every request, in order. */
    requests: IssuerRequest[];
    /** Provisioning: a single-use initial access token for a deployment id (a new one, or one to enroll again). */
    provision(deploymentId?: string): { token: string; deploymentId: string };
    revoke(deploymentId: string): void;
    clients: Map<string, Client>;
    /** What sync last received. */
    synced: unknown[];
    /** Answers sync with this status (`paused` while staff review an origin). */
    syncStatus: string;
    scopes: string;
    /** Holds token issuing back (`unauthorized_client`), as for a changed origin. */
    paused: boolean;
    /** Makes every request fail as a network error, or answer 503. */
    down: false | 'network' | 503;
    /** Answers the metadata with these fields over the real ones. */
    metadataOverride?: Record<string, unknown>;
    /** Lifetime of the access tokens, in seconds. */
    tokenSeconds: number;
    /** Tokens issued, by audience. */
    issued: Array<{ clientId: string; audience: string; token: string }>;
    /** Called inside registration, after the token is spent and before the answer. */
    onRegister?: () => Promise<void> | void;
    /** Called before any request is answered: a test holds one in flight here. */
    before?: (path: string) => Promise<void> | void;
    /** Answers the metadata with this status instead (a proxy's 401, say). */
    metadataStatus?: number;
    /** CB-570: the issuer's signing key, published at its `jwks_uri`. */
    signing: { kid: string; privateKey: KeyObject };
    /** The keys the JWKS lists (the signing key's by default). */
    jwks?: Array<Record<string, unknown>>;
    /** `GET /v1/social/config`'s answer, or a status to fail with. */
    socialConfig: Record<string, unknown> | number;
    /**
     * `POST /v1/social/verify`: the answer, given the request's body and
     * the caller's deployment id. The default signs a statement for the
     * subject `sub-<idToken's last segment>`.
     */
    socialVerify: (body: { provider: string; idToken: string; nonce: string }, deploymentId: string) => Response;
    /** Signs a statement (or anything) with the issuer's key, or another. */
    signStatement(claims: Record<string, unknown>, header?: Record<string, unknown>, key?: KeyObject): string;
}

/** A statement's claims for a verify request, as the real service makes them. */
export function statementClaims(
    body: { provider: string; idToken: string; nonce: string },
    deploymentId: string,
    extra: Record<string, unknown> = {},
) {
    const iat = Math.floor(Date.now() / 1000);
    return {
        iss: ISSUER,
        aud: deploymentId,
        provider: body.provider,
        sub: `sub-${body.idToken.split('.').pop()}`,
        nonce: body.nonce,
        iat,
        exp: iat + 60,
        ...extra,
    };
}

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const oauthError = (status: number, error: string) => json(status, { error, error_description: error });

function verifyAssertion(assertion: string, clients: Map<string, Client>, audience: string): Client | string {
    const parts = assertion.split('.');
    if (parts.length !== 3) {
        return 'malformed';
    }
    const [h, p, s] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg?: string; kid?: string };
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
    const client = typeof payload.sub === 'string' ? clients.get(payload.sub) : undefined;
    if (!client || header.alg !== 'EdDSA' || header.kid !== client.jwk.kid) {
        return 'unknown client or key';
    }
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: client.jwk.x }, format: 'jwk' });
    if (!verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) {
        return 'bad signature';
    }
    const now = Math.floor(Date.now() / 1000);
    const iat = payload.iat as number;
    const exp = payload.exp as number;
    if (
        payload.iss !== client.id ||
        payload.aud !== audience ||
        typeof payload.jti !== 'string' ||
        exp - iat > 300 ||
        exp < now - 60
    ) {
        return 'bad claims';
    }
    return client;
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function fakeIssuer(): FakeIssuer {
    const pending = new Map<string, string>();
    const { privateKey } = generateKeyPairSync('ed25519');
    const tokens = new Map<string, { clientId: string; audience: string }>();
    const issuer: FakeIssuer = {
        requests: [],
        clients: new Map(),
        synced: [],
        syncStatus: 'active',
        scopes: 'reports:write push:send updates:read',
        paused: false,
        down: false,
        tokenSeconds: 3600,
        issued: [],
        signing: { kid: 'issuer-key-1', privateKey },
        socialConfig: { google: { serverClientId: 'test-web-client.apps.example.test' }, apple: {} },
        signStatement(claims, header = {}, key = issuer.signing.privateKey) {
            const input = `${encode({ alg: 'EdDSA', typ: 'social+jwt', kid: issuer.signing.kid, ...header })}.${encode(claims)}`;
            return `${input}.${sign(null, Buffer.from(input), key).toString('base64url')}`;
        },
        socialVerify: (body, deploymentId) =>
            new Response(issuer.signStatement(statementClaims(body, deploymentId)), {
                status: 200,
                headers: { 'content-type': 'application/jwt' },
            }),
        provision(deploymentId = `dep_${randomUUID().replaceAll('-', '').slice(0, 26).toUpperCase()}`) {
            const token = `iat_${randomUUID()}${randomUUID()}`;
            pending.set(token, deploymentId);
            return { token, deploymentId };
        },
        revoke(deploymentId) {
            const client = issuer.clients.get(deploymentId);
            if (client) {
                client.status = 'revoked';
            }
        },
        fetch: async (input, init) => {
            const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
            const headers: Record<string, string> = {};
            new Headers(init?.headers).forEach((value, name) => (headers[name] = value));
            const body = typeof init?.body === 'string' ? init.body : '';
            issuer.requests.push({ method: init?.method ?? 'GET', path: url.pathname, headers, body });
            await issuer.before?.(url.pathname);
            if (issuer.down === 'network') {
                throw new TypeError('fetch failed');
            }
            if (issuer.down === 503) {
                return json(503, { error: 'temporarily_unavailable' });
            }
            if (url.origin !== ISSUER) {
                return json(404, {});
            }
            if (url.pathname === '/.well-known/oauth-authorization-server') {
                if (issuer.metadataStatus) {
                    return oauthError(issuer.metadataStatus, 'invalid_token');
                }
                return json(200, {
                    issuer: ISSUER,
                    registration_endpoint: `${ISSUER}/oauth2/register`,
                    token_endpoint: `${ISSUER}/oauth2/token`,
                    jwks_uri: `${ISSUER}/.well-known/jwks.json`,
                    ...issuer.metadataOverride,
                });
            }
            if (url.pathname === '/oauth2/register' && init?.method === 'POST') {
                const token = headers.authorization?.replace(/^Bearer /, '') ?? '';
                const deploymentId = pending.get(token);
                if (!deploymentId) {
                    return oauthError(401, 'invalid_token');
                }
                pending.delete(token);
                const metadata = JSON.parse(body) as {
                    jwks: { keys: Client['jwk'][] };
                    token_endpoint_auth_method: string;
                };
                const jwk = metadata.jwks.keys[0];
                if (
                    metadata.token_endpoint_auth_method !== 'private_key_jwt' ||
                    metadata.jwks.keys.length !== 1 ||
                    !jwk
                ) {
                    return oauthError(400, 'invalid_client_metadata');
                }
                await issuer.onRegister?.();
                issuer.clients.set(deploymentId, {
                    id: deploymentId,
                    jwk,
                    scopes: issuer.scopes,
                    mode: 'hosted',
                    status: 'active',
                });
                return json(201, {
                    client_id: deploymentId,
                    token_endpoint_auth_method: 'private_key_jwt',
                    deployment_mode: 'hosted',
                    scope: issuer.scopes,
                    terms_version: '2026-11-01',
                });
            }
            if (url.pathname === '/oauth2/token' && init?.method === 'POST') {
                const form = new URLSearchParams(body);
                if (
                    form.get('grant_type') !== 'client_credentials' ||
                    form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' ||
                    form.getAll('resource').length !== 1
                ) {
                    return oauthError(400, 'invalid_request');
                }
                const client = verifyAssertion(form.get('client_assertion') ?? '', issuer.clients, ISSUER);
                if (typeof client === 'string' || client.status !== 'active') {
                    return oauthError(401, 'invalid_client');
                }
                if (issuer.paused) {
                    return oauthError(400, 'unauthorized_client');
                }
                const audience = form.get('resource')!;
                const token = `at_${randomUUID()}`;
                tokens.set(token, { clientId: client.id, audience });
                issuer.issued.push({ clientId: client.id, audience, token });
                return json(200, { access_token: token, token_type: 'Bearer', expires_in: issuer.tokenSeconds });
            }
            if (url.pathname === '/.well-known/jwks.json') {
                const x = createPublicKey(issuer.signing.privateKey).export({ format: 'jwk' }).x;
                return json(200, {
                    keys: issuer.jwks ?? [
                        { kty: 'OKP', crv: 'Ed25519', x, kid: issuer.signing.kid, alg: 'EdDSA', use: 'sig' },
                    ],
                });
            }
            if (url.pathname.startsWith('/v1/social/')) {
                const token = tokens.get(headers.authorization?.replace(/^Bearer /, '') ?? '');
                const client = token && issuer.clients.get(token.clientId);
                if (!token || token.audience !== ISSUER || !client || client.status !== 'active') {
                    return oauthError(401, 'invalid_token');
                }
                if (url.pathname === '/v1/social/config' && (init?.method ?? 'GET') === 'GET') {
                    return typeof issuer.socialConfig === 'number'
                        ? json(issuer.socialConfig, { error: 'unavailable' })
                        : json(200, issuer.socialConfig);
                }
                if (url.pathname === '/v1/social/verify' && init?.method === 'POST') {
                    return issuer.socialVerify(JSON.parse(body), client.id);
                }
            }
            if (url.pathname === '/v1/sync' && init?.method === 'POST') {
                const token = tokens.get(headers.authorization?.replace(/^Bearer /, '') ?? '');
                const client = token && issuer.clients.get(token.clientId);
                if (!token || token.audience !== ISSUER || !client || client.status !== 'active') {
                    return oauthError(401, 'invalid_token');
                }
                issuer.synced.push(JSON.parse(body));
                return json(200, {
                    deployment_mode: client.mode,
                    scope: client.scopes,
                    status: issuer.syncStatus,
                    accepts: [],
                    notices: [],
                });
            }
            return json(404, {});
        },
    };
    return issuer;
}
