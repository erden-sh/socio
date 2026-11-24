import { constants, createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };

type Alg = 'RS256' | 'ES384' | 'PS256' | 'EdDSA';
interface SigningKey {
    kid: string;
    alg: Alg;
    privateKey: KeyObject;
    jwk: Jwk;
    /** Listed in the JWKS document. */
    published: boolean;
}

export function generateSigningKey(alg: Alg, kid: string): SigningKey {
    const { privateKey, publicKey } =
        alg === 'ES384'
            ? generateKeyPairSync('ec', { namedCurve: 'P-384' })
            : alg === 'EdDSA'
              ? generateKeyPairSync('ed25519')
              : generateKeyPairSync('rsa', { modulusLength: 2048 });
    return {
        kid,
        alg,
        privateKey,
        jwk: {
            ...(publicKey.export({ format: 'jwk' }) as Jwk),
            kid,
            alg,
            use: 'sig',
        },
        published: true,
    };
}

export function signJwt(
    key: Pick<SigningKey, 'alg' | 'kid' | 'privateKey'>,
    payload: Record<string, unknown>,
    header: Record<string, unknown> = {},
) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: key.alg, kid: key.kid, typ: 'JWT', ...header })}.${encode(payload)}`;
    const data = Buffer.from(input);
    const signature =
        key.alg === 'ES384'
            ? sign('sha384', data, { key: key.privateKey, dsaEncoding: 'ieee-p1363' })
            : key.alg === 'EdDSA'
              ? sign(null, data, key.privateKey)
              : key.alg === 'PS256'
                ? sign('sha256', data, {
                      key: key.privateKey,
                      padding: constants.RSA_PKCS1_PSS_PADDING,
                      saltLength: 32,
                  })
                : sign('sha256', data, key.privateKey);
    return `${input}.${signature.toString('base64url')}`;
}

const body = (request: IncomingMessage) =>
    new Promise<string>((resolve) => {
        let text = '';
        request.on('data', (chunk: Buffer) => (text += chunk.toString()));
        request.on('end', () => resolve(text));
    });

/**
 * An in-process OpenID provider on loopback: discovery, JWKS, an authorize
 * endpoint that signs the user straight in, a token endpoint that checks the
 * client secret, redirect URI and PKCE, userinfo and end-session. Tests steer
 * the next ID token through `claims`, `signingKey` and `tamper`. (Carried
 * over from the superseded hand-rolled OIDC client, for Better Auth's
 * generic OAuth path.)
 */
export class FakeOidc {
    readonly clientId = 'brain-client';
    readonly clientSecret = 'brain-client-secret-0123456789';
    issuer = '';
    keys: SigningKey[] = [generateSigningKey('RS256', 'key-1')];
    signingKey = this.keys[0];
    /** Merged over the default ID token claims (undefined deletes one). */
    claims: Record<string, unknown> = {};
    /** Served at the userinfo endpoint (sub is added). */
    userinfo: Record<string, unknown> = {};
    /** Rewrites the signed ID token (e.g. to break the signature). */
    tamper?: (token: string) => string;
    /** Overrides the discovery document. */
    discovery: Record<string, unknown> = {};
    sub = 'sub-ada';
    /** Every endpoint answers 503 (an issuer that is down). */
    down = false;
    readonly requests: { path: string; params: URLSearchParams }[] = [];
    private codes = new Map<string, URLSearchParams>();
    private server?: Server;

    /** `hostname` names the issuer (the server listens on 127.0.0.1). */
    async start(hostname = '127.0.0.1') {
        this.server = createServer((request, response) => {
            void this.handle(request).then(({ status, headers, json }) => {
                response.writeHead(status, {
                    ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
                    ...headers,
                });
                response.end(json === undefined ? undefined : JSON.stringify(json));
            });
        });
        await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
        this.issuer = `http://${hostname}:${(this.server.address() as AddressInfo).port}/oidc`;
        return this;
    }
    stop() {
        return new Promise<void>((resolve) => this.server?.close(() => resolve()));
    }
    count(path: string) {
        return this.requests.filter((request) => request.path === path).length;
    }
    rotate(alg: Alg = 'RS256') {
        const key = generateSigningKey(alg, `key-${this.keys.length + 1}`);
        this.keys.push(key);
        this.signingKey = key;
        return key;
    }

    private async handle(request: IncomingMessage): Promise<{
        status: number;
        headers?: Record<string, string>;
        json?: unknown;
    }> {
        const url = new URL(request.url!, this.issuer);
        const path = url.pathname.replace(/^\/oidc/, '');
        const params = request.method === 'POST' ? new URLSearchParams(await body(request)) : url.searchParams;
        this.requests.push({ path, params });
        if (this.down) {
            return { status: 503, json: { error: 'unavailable' } };
        }
        const now = Math.floor(Date.now() / 1000);
        switch (path) {
            case '/.well-known/openid-configuration':
                return {
                    status: 200,
                    json: {
                        issuer: this.issuer,
                        authorization_endpoint: `${this.issuer}/auth`,
                        token_endpoint: `${this.issuer}/token`,
                        jwks_uri: `${this.issuer}/jwks`,
                        userinfo_endpoint: `${this.issuer}/me`,
                        end_session_endpoint: `${this.issuer}/session/end`,
                        id_token_signing_alg_values_supported: ['RS256', 'ES384', 'PS256', 'EdDSA'],
                        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
                        ...this.discovery,
                    },
                };
            case '/jwks':
                return {
                    status: 200,
                    json: {
                        keys: this.keys.filter((key) => key.published).map((key) => key.jwk),
                    },
                };
            case '/auth': {
                const code = randomBytes(16).toString('hex');
                this.codes.set(code, params);
                const back = new URL(params.get('redirect_uri')!);
                back.searchParams.set('code', code);
                back.searchParams.set('state', params.get('state')!);
                return { status: 302, headers: { Location: back.toString() } };
            }
            case '/token': {
                const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
                const authorize = this.codes.get(params.get('code') ?? '');
                this.codes.delete(params.get('code') ?? '');
                const challenge = createHash('sha256')
                    .update(params.get('code_verifier') ?? '')
                    .digest('base64url');
                if (
                    request.headers.authorization !== `Basic ${basic}` ||
                    params.get('grant_type') !== 'authorization_code' ||
                    !authorize ||
                    authorize.get('redirect_uri') !== params.get('redirect_uri') ||
                    authorize.get('code_challenge') !== challenge
                ) {
                    return { status: 400, json: { error: 'invalid_grant' } };
                }
                const claims: Record<string, unknown> = {
                    iss: this.issuer,
                    aud: this.clientId,
                    sub: this.sub,
                    iat: now,
                    exp: now + 300,
                    nonce: authorize.get('nonce'),
                    ...this.claims,
                };
                for (const [key, value] of Object.entries(claims)) {
                    if (value === undefined) {
                        delete claims[key];
                    }
                }
                const token = signJwt(this.signingKey, claims);
                return {
                    status: 200,
                    json: {
                        id_token: this.tamper ? this.tamper(token) : token,
                        access_token: `access-${this.sub}`,
                        token_type: 'Bearer',
                        expires_in: 300,
                    },
                };
            }
            case '/me':
                return request.headers.authorization === `Bearer access-${this.sub}`
                    ? { status: 200, json: { sub: this.sub, ...this.userinfo } }
                    : { status: 401, json: { error: 'invalid_token' } };
            case '/session/end':
                return {
                    status: 302,
                    headers: { Location: params.get('post_logout_redirect_uri') ?? '/' },
                };
            default:
                return { status: 404, json: { error: 'not_found' } };
        }
    }
}
