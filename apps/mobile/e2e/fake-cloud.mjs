// A fake of Socio's cloud services for the app's end-to-end flows (CB-570): the issuer endpoints a
// local server enrolls and syncs with (as tests/fixtures/fake-cloud-issuer.ts answers the server's
// own tests, here over loopback HTTP), and the social verifier, so a development build's Google and
// Apple sign-in runs against servers.mjs's workspaces with made-up accounts and no request to
// Google, Apple or the real cloud.
//
// The verifier takes only the app's development test tokens (src/net/social-test-token.ts): an
// unsigned JWT whose payload names a made-up `sub` and the nonce the phone's sign-in was given. It
// checks that nonce as the real service does (Google's the server's nonce as it is, Apple's its
// SHA-256 in hex) and answers a statement signed with this issuer's key. A few test accounts stand
// for the service's refusals:
//
//   refuse-invalid       422 invalid_token     (the server's invalid_token)
//   refuse-nonce         422 nonce_mismatch    (nonce_invalid)
//   refuse-many          429                   (too_many)
//   refuse-unavailable   503, Retry-After 1    (provider_unavailable)
//
// Every other account verifies, with `<account>@example.test` as its email.
//
// With `reports` (servers.mjs --reports, CB-382) the issuer grants `reports:write` too and the same
// origin is the reports collector (`POST /v1/reports`): it keeps each report it took in memory
// (`reports`), answers 201, or holds them unsent with 503 while `holdReports()` is on, so a report
// stays queued on the server. Nothing leaves the machine.
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { createServer } from 'node:http';

/** The `serverClientId` the config names for Google: made up, never a real client id. */
export const E2E_SERVER_CLIENT_ID = '000000000000-e2e.apps.googleusercontent.test';
/** What a deployment this fake registers may use. */
export const E2E_SCOPES = 'social:verify';
/** With --reports, AI reply reports too (CB-382). */
export const E2E_REPORT_SCOPES = `${E2E_SCOPES} reports:write`;

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const json = (response, status, body, headers = {}) =>
    response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));

/** The test token's payload, or null for anything else. @param {unknown} idToken */
export function testTokenPayload(idToken) {
    if (typeof idToken !== 'string') {
        return null;
    }
    const [header, payload] = idToken.split('.');
    try {
        const head = JSON.parse(Buffer.from(header ?? '', 'base64url').toString());
        const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString());
        return head.alg === 'none' && claims.iss === 'socio-e2e' && typeof claims.sub === 'string' ? claims : null;
    } catch {
        return null;
    }
}

/**
 * The verify answer for one request: a refusal for a refuse-* account or a wrong nonce, else the
 * claims to sign. @param {{ provider: string, idToken: string, nonce: string }} body
 */
export function verdict(body) {
    const claims = testTokenPayload(body.idToken);
    if (!claims || claims.aud !== body.provider) {
        return { status: 422, body: { code: 'invalid_token' } };
    }
    switch (claims.sub) {
        case 'refuse-invalid':
            return { status: 422, body: { code: 'invalid_token' } };
        case 'refuse-nonce':
            return { status: 422, body: { code: 'nonce_mismatch' } };
        case 'refuse-many':
            return { status: 429, body: { code: 'too_many' } };
        case 'refuse-unavailable':
            return { status: 503, body: { code: 'provider_unavailable' }, headers: { 'retry-after': '1' } };
    }
    const expected = body.provider === 'apple' ? createHash('sha256').update(body.nonce).digest('hex') : body.nonce;
    if (claims.nonce !== expected) {
        return { status: 422, body: { code: 'nonce_mismatch' } };
    }
    return { status: 200, sub: claims.sub, email: typeof claims.email === 'string' ? claims.email : undefined };
}

/**
 * Starts the fake on 127.0.0.1:`port`. `provision()` gives an enrollment token for one server.
 * @param {number} port
 * @param {{ reports?: boolean }} [options]
 */
export async function fakeCloud(port, options = {}) {
    const scopes = options.reports ? E2E_REPORT_SCOPES : E2E_SCOPES;
    /** @type {unknown[]} */
    const reports = [];
    let holding = false;
    // Set once it listens: port 0 takes a free one (the harness's test).
    let origin = `http://127.0.0.1:${port}`;
    const { privateKey } = generateKeyPairSync('ed25519');
    const kid = 'e2e-issuer-key';
    /** @type {Map<string, string>} */
    const pending = new Map();
    /** @type {Map<string, { id: string, x: string, kid: string }>} */
    const clients = new Map();
    /** @type {Map<string, string>} */
    const tokens = new Map();
    /** @type {Array<{ provider: string, sub: string | null, status: number }>} */
    const verified = [];
    const signStatement = (claims) => {
        const input = `${encode({ alg: 'EdDSA', typ: 'social+jwt', kid })}.${encode(claims)}`;
        return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
    };
    const clientOf = (request) => {
        const token = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
        const id = tokens.get(token);
        return id ? clients.get(id) : undefined;
    };
    const server = createServer((request, response) => {
        let raw = '';
        request.on('data', (chunk) => (raw += chunk));
        request.on('end', () => {
            const path = new URL(request.url ?? '/', origin).pathname;
            const route = `${request.method} ${path}`;
            if (route === 'GET /.well-known/oauth-authorization-server') {
                return json(response, 200, {
                    issuer: origin,
                    registration_endpoint: `${origin}/oauth2/register`,
                    token_endpoint: `${origin}/oauth2/token`,
                    jwks_uri: `${origin}/.well-known/jwks.json`,
                });
            }
            if (route === 'GET /.well-known/jwks.json') {
                const { x } = createPublicKey(privateKey).export({ format: 'jwk' });
                return json(response, 200, {
                    keys: [{ kty: 'OKP', crv: 'Ed25519', x, kid, alg: 'EdDSA', use: 'sig' }],
                });
            }
            if (route === 'POST /oauth2/register') {
                const token = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
                const id = pending.get(token);
                if (!id) {
                    return json(response, 401, { error: 'invalid_token' });
                }
                pending.delete(token);
                const jwk = JSON.parse(raw).jwks?.keys?.[0];
                clients.set(id, { id, x: jwk.x, kid: jwk.kid });
                return json(response, 201, {
                    client_id: id,
                    token_endpoint_auth_method: 'private_key_jwt',
                    deployment_mode: 'hosted',
                    scope: scopes,
                    terms_version: '2026-11-01',
                });
            }
            if (route === 'POST /oauth2/token') {
                const form = new URLSearchParams(raw);
                const [h, p, s] = (form.get('client_assertion') ?? '').split('.');
                try {
                    const claims = JSON.parse(Buffer.from(p ?? '', 'base64url').toString());
                    const client = clients.get(claims.sub);
                    const key =
                        client && createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: client.x }, format: 'jwk' });
                    if (
                        !client ||
                        !key ||
                        !verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s ?? '', 'base64url'))
                    ) {
                        return json(response, 401, { error: 'invalid_client' });
                    }
                    const token = `at_${randomUUID()}`;
                    tokens.set(token, client.id);
                    return json(response, 200, { access_token: token, token_type: 'Bearer', expires_in: 3600 });
                } catch {
                    return json(response, 400, { error: 'invalid_request' });
                }
            }
            const client = clientOf(request);
            if (path.startsWith('/v1/') && !client) {
                return json(response, 401, { error: 'invalid_token' });
            }
            if (route === 'POST /v1/sync') {
                return json(response, 200, {
                    deployment_mode: 'hosted',
                    scope: scopes,
                    status: 'active',
                    accepts: [],
                    notices: [],
                });
            }
            if (route === 'POST /v1/reports' && options.reports) {
                if (holding) {
                    return json(response, 503, {}, { 'retry-after': '60' });
                }
                reports.push(JSON.parse(raw));
                return json(response, 201, {});
            }
            if (route === 'GET /v1/social/config') {
                return json(response, 200, { google: { serverClientId: E2E_SERVER_CLIENT_ID }, apple: {} });
            }
            if (route === 'POST /v1/social/verify') {
                const body = JSON.parse(raw);
                const answer = verdict(body);
                verified.push({ provider: body.provider, sub: answer.sub ?? null, status: answer.status });
                if (answer.status !== 200) {
                    return json(response, answer.status, answer.body, answer.headers);
                }
                const iat = Math.floor(Date.now() / 1000);
                return json(response, 200, {
                    statement: signStatement({
                        iss: origin,
                        aud: client.id,
                        provider: body.provider,
                        sub: answer.sub,
                        nonce: body.nonce,
                        iat,
                        exp: iat + 60,
                        ...(answer.email ? { email: answer.email, emailVerified: true } : {}),
                    }),
                });
            }
            return json(response, 404, {});
        });
    });
    await new Promise((done) => server.listen(port, '127.0.0.1', () => done(undefined)));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`;
    return {
        origin,
        verified,
        /** The reports the collector took (--reports), as the servers sent them. */
        reports,
        /** Holds reports unsent (503) while `on`, so they stay queued; off takes them again. */
        holdReports(/** @type {boolean} */ on) {
            holding = on;
        },
        /** A single-use enrollment token for one deployment. */
        provision() {
            const token = `iat_${randomUUID()}${randomUUID()}`;
            pending.set(token, `dep_${randomUUID().replaceAll('-', '').slice(0, 26).toUpperCase()}`);
            return token;
        },
        close: () => new Promise((done) => server.close(() => done(undefined))),
    };
}
