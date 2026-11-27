// CB-570: the app's Google and Apple sign-in, verified by Socio's cloud
// services: the server sends the ID token to the issuer's verification
// service with its deployment token, and accepts only a statement the issuer
// signed (`typ: social+jwt`) for this deployment, this provider and this nonce.
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SecretBox } from '@socio/foundation/keys/secret-box';

import { verifyIssuerJws } from '../src/server/cloud/issuer-jws.js';
import { cloudService, socialVerification } from '../src/server/cloud/layer.js';
import type { CloudService } from '../src/server/cloud/service.js';
import { cloudFromEnv } from '../src/server/cloud/settings.js';
import { SOCIAL_CONFIG_FRESH_MS, SOCIAL_CONFIG_KEEP_MS } from '../src/server/cloud/social.js';

import { fakeIssuer, ISSUER, statementClaims, type FakeIssuer } from './fixtures/fake-cloud-issuer.js';
import { Store } from './helpers/stores.js';
import { testDatabaseFile } from './helpers/test-database.js';

const KEY = new Uint8Array(32).fill(7);
const SECRET = 'cloud-test-session-secret-0123456789';
const NONCE = 'n'.repeat(43);
const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.ada';

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0).reverse()) {
        fn();
    }
});

async function connected(options: { issuer?: FakeIssuer; scopes?: string; enroll?: boolean; now?: () => number } = {}) {
    const issuer = options.issuer ?? fakeIssuer();
    issuer.scopes = options.scopes ?? 'reports:write social:verify';
    const dir = mkdtempSync(join(tmpdir(), 'cloud-social-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new Store(testDatabaseFile(join(dir, 'workspace.db')));
    cleanup.push(() => store.close());
    const { token, deploymentId } = issuer.provision();
    const config = {
        cloud: cloudFromEnv({
            SOCIO_CLOUD_ISSUER: ISSUER,
            ...(options.enroll === false ? {} : { SOCIO_CLOUD_ENROLLMENT_TOKEN: token }),
        }),
    };
    const logs: string[] = [];
    const log = console.log;
    console.log = (line: string) => void logs.push(line);
    cleanup.push(() => (console.log = log));
    const cloud: CloudService = cloudService({
        config,
        settings: store,
        secrets: store,
        releases: { data: () => ({ version: '0.55.0', commit: 'abc', releases: [] }) },
        host: {
            box: new SecretBox({ current: KEY, legacy: SECRET }, 'settings-secrets'),
            origin: 'https://brain.example.test',
            notifyAdmins: async () => {},
        },
        transport: issuer.fetch,
        now: options.now,
    });
    await cloud.work();
    const social = socialVerification({ config, cloud, transport: issuer.fetch, now: options.now });
    const verify = (input: Partial<{ provider: 'google' | 'apple'; idToken: string; nonce: string }> = {}) =>
        social.verify({ provider: 'google', idToken: ID_TOKEN, nonce: NONCE, ...input });
    const calls = (path: string) => issuer.requests.filter((request) => request.path === path).length;
    return { issuer, cloud, social, verify, deploymentId, logs, calls };
}

/** Answers the verify request with a statement of these claims (over the real ones) and header. */
const answering =
    (issuer: FakeIssuer, extra: Record<string, unknown>, header: Record<string, unknown> = {}) =>
    (body: { provider: string; idToken: string; nonce: string }, deploymentId: string) =>
        new Response(issuer.signStatement(statementClaims(body, deploymentId, extra), header), { status: 200 });

const status = (code: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json', ...headers } });

describe('a verification', () => {
    it('names the subject from a statement the issuer signed for this deployment, provider and nonce', async () => {
        const { verify, issuer, logs } = await connected();
        issuer.socialVerify = answering(issuer, { email: 'ada@example.com', emailVerified: true });
        expect(await verify()).toEqual({
            ok: true,
            provider: 'google',
            sub: 'sub-ada',
            nonce: NONCE,
            email: 'ada@example.com',
            emailVerified: true,
        });
        const sent = issuer.requests.find((request) => request.path === '/v1/social/verify')!;
        // The raw nonce and the token, with the deployment's token for the issuer.
        expect(JSON.parse(sent.body)).toEqual({ provider: 'google', idToken: ID_TOKEN, nonce: NONCE });
        expect(sent.headers.authorization).toMatch(/^Bearer at_/);
        expect(issuer.issued.at(-1)?.audience).toBe(ISSUER);
        // Never the token, the email or the statement in a log.
        expect(logs.join('\n')).not.toMatch(/ada@example|eyJ|sub-ada/);
    });

    it('takes Apple’s the same way', async () => {
        const { verify } = await connected();
        expect(await verify({ provider: 'apple' })).toMatchObject({ ok: true, provider: 'apple', sub: 'sub-ada' });
    });

    it.each([
        ['a bad signature', {}, {}, true],
        ['an access token’s type', {}, { typ: 'at+jwt' }, false],
        ['no type', {}, { typ: undefined }, false],
        ['another algorithm', {}, { alg: 'HS256' }, false],
        ['another issuer', { iss: 'https://cloud.evil.test' }, {}, false],
        ['another deployment', { aud: 'dep_SOMEONEELSE' }, {}, false],
        [
            'an expired statement',
            { iat: Math.floor(Date.now() / 1000) - 600, exp: Math.floor(Date.now() / 1000) - 300 },
            {},
            false,
        ],
        [
            'one issued in the future',
            { iat: Math.floor(Date.now() / 1000) + 600, exp: Math.floor(Date.now() / 1000) + 660 },
            {},
            false,
        ],
        ['one that lives too long', { exp: Math.floor(Date.now() / 1000) + 3600 }, {}, false],
        ['another provider', { provider: 'apple' }, {}, false],
        ['another nonce', { nonce: 'm'.repeat(43) }, {}, false],
        ['no subject', { sub: '' }, {}, false],
    ])('refuses %s as invalid_token', async (_name, claims, header, otherKey) => {
        const { verify, issuer, logs } = await connected();
        const stranger = generateKeyPairSync('ed25519').privateKey;
        issuer.socialVerify = (body, deploymentId) =>
            new Response(
                issuer.signStatement(
                    statementClaims(body, deploymentId, claims),
                    header,
                    otherKey ? stranger : undefined,
                ),
                { status: 200 },
            );
        expect(await verify()).toEqual({ ok: false, code: 'invalid_token' });
        expect(logs.some((line) => /Social sign-in: the cloud's statement failed its \w+ check/.test(line))).toBe(true);
        expect(logs.join('\n')).not.toMatch(/eyJ|sub-ada/);
    });

    it('reads the issuer’s keys again, once, for a key it doesn’t know yet', async () => {
        const { verify, issuer, calls } = await connected();
        expect((await verify()).ok).toBe(true);
        expect(calls('/.well-known/jwks.json')).toBe(1);
        // The issuer rotates: a new key, published, signing.
        const next = generateKeyPairSync('ed25519').privateKey;
        issuer.signing = { kid: 'issuer-key-2', privateKey: next };
        // Within the minute: not read again, so the new key is unknown.
        expect(await verify()).toEqual({ ok: false, code: 'invalid_token' });
        expect(calls('/.well-known/jwks.json')).toBe(1);
    });

    it.each([
        [400, {}, 'invalid_token'],
        [422, { code: 'invalid_token' }, 'invalid_token'],
        [422, { code: 'wrong_audience' }, 'invalid_token'],
        [422, { error: 'expired' }, 'invalid_token'],
        [422, { code: 'nonce_mismatch' }, 'nonce_invalid'],
        [422, { code: 'provider_unavailable' }, 'provider_unavailable'],
        [422, { code: 'something_new' }, 'provider_unavailable'],
        [429, {}, 'too_many'],
        [500, {}, 'provider_unavailable'],
        [502, {}, 'provider_unavailable'],
    ])('maps the service’s %i %j to %s', async (code, body, expected) => {
        const { verify, issuer } = await connected();
        issuer.socialVerify = () => status(code, body);
        expect(await verify()).toEqual({ ok: false, code: expected });
    });

    it('waits out a 503’s Retry-After before asking again', async () => {
        let now = Date.now();
        const { verify, issuer, calls } = await connected({ now: () => now });
        issuer.socialVerify = () => status(503, { code: 'provider_unavailable' }, { 'retry-after': '20' });
        expect(await verify()).toEqual({ ok: false, code: 'provider_unavailable' });
        expect(calls('/v1/social/verify')).toBe(1);
        expect(await verify()).toEqual({ ok: false, code: 'provider_unavailable' });
        expect(calls('/v1/social/verify')).toBe(1);
        now += 21_000;
        issuer.socialVerify = answering(issuer, { iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 60 });
        expect((await verify()).ok).toBe(true);
        expect(calls('/v1/social/verify')).toBe(2);
    });

    it('answers provider_unavailable when the cloud is down', async () => {
        const { verify, issuer } = await connected();
        issuer.down = 'network';
        expect(await verify()).toEqual({ ok: false, code: 'provider_unavailable' });
    });

    it('renews its token once on a 401 and asks again, once', async () => {
        const { verify, issuer, calls } = await connected();
        const real = issuer.socialVerify;
        let refusals = 1;
        issuer.socialVerify = (body, id) => (refusals-- > 0 ? status(401, { error: 'invalid_token' }) : real(body, id));
        const before = issuer.issued.length;
        expect((await verify()).ok).toBe(true);
        expect(calls('/v1/social/verify')).toBe(2);
        expect(issuer.issued.length).toBe(before + 1);
        // Refused again after the renewal: unavailable, no third try.
        refusals = 2;
        expect(await verify()).toEqual({ ok: false, code: 'provider_unavailable' });
        expect(calls('/v1/social/verify')).toBe(4);
    });

    it('says once in the log that the scope is missing on a 403', async () => {
        const { verify, issuer, logs } = await connected();
        issuer.socialVerify = () => status(403, { error: 'insufficient_scope' });
        expect(await verify()).toEqual({ ok: false, code: 'provider_unavailable' });
        expect(await verify()).toEqual({ ok: false, code: 'provider_unavailable' });
        expect(logs.filter((line) => line.includes('social:verify scope'))).toHaveLength(1);
    });
});

describe('without the connection', () => {
    it('offers nothing and sends nothing when the server isn’t connected', async () => {
        const { social, verify, issuer } = await connected({ enroll: false });
        expect(await social.config()).toBeNull();
        expect(await verify()).toEqual({ ok: false, code: 'provider_unavailable' });
        expect(issuer.requests).toEqual([]);
    });

    it('offers nothing without the social:verify scope', async () => {
        const { social, verify, calls } = await connected({ scopes: 'reports:write' });
        expect(await social.config()).toBeNull();
        expect(await verify()).toEqual({ ok: false, code: 'provider_unavailable' });
        expect(calls('/v1/social/verify') + calls('/v1/social/config')).toBe(0);
    });

    it('offers nothing while the issuer holds tokens back', async () => {
        const { social, issuer, cloud } = await connected();
        issuer.syncStatus = 'paused';
        await (cloud as unknown as { sync(): Promise<void> }).sync();
        expect(cloud.status().connection).toBe('paused');
        expect(await social.config()).toBeNull();
    });
});

describe('the config', () => {
    it('is kept 10 minutes, and its last good answer up to an hour while reads fail', async () => {
        let now = Date.now();
        const { social, issuer, calls } = await connected({ now: () => now });
        const expected = { google: { serverClientId: 'test-web-client.apps.example.test' }, apple: {} };
        expect(await social.config()).toEqual(expected);
        expect(await social.config()).toEqual(expected);
        expect(calls('/v1/social/config')).toBe(1);
        now += SOCIAL_CONFIG_FRESH_MS + 1;
        issuer.socialConfig = { apple: {} };
        expect(await social.config()).toEqual({ apple: {} });
        expect(calls('/v1/social/config')).toBe(2);
        // The service fails: the last good answer stands, within the hour.
        now += SOCIAL_CONFIG_FRESH_MS + 1;
        issuer.socialConfig = 503;
        expect(await social.config()).toEqual({ apple: {} });
        expect(calls('/v1/social/config')).toBe(3);
        // And not past it.
        now += SOCIAL_CONFIG_KEEP_MS;
        expect(await social.config()).toBeNull();
    });

    it('refuses an answer that isn’t one', async () => {
        const { social, issuer } = await connected();
        issuer.socialConfig = { google: { serverClientId: 42 } };
        expect(await social.config()).toBeNull();
    });
});

describe('the issuer’s signatures', () => {
    it('never take one type for another: a statement is no access token, and an access token no statement', async () => {
        const issuer = fakeIssuer();
        const key = async () => (await import('node:crypto')).createPublicKey(issuer.signing.privateKey);
        const statement = issuer.signStatement({ sub: 'x' });
        const access = issuer.signStatement({ sub: 'x' }, { typ: 'at+jwt' });
        expect(await verifyIssuerJws(statement, { typ: 'social+jwt', key })).toMatchObject({ ok: true });
        expect(await verifyIssuerJws(statement, { typ: 'at+jwt', key })).toEqual({ ok: false, check: 'typ' });
        expect(await verifyIssuerJws(access, { typ: 'at+jwt', key })).toMatchObject({ ok: true });
        expect(await verifyIssuerJws(access, { typ: 'social+jwt', key })).toEqual({ ok: false, check: 'typ' });
        // `alg: none`, unsigned.
        const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'social+jwt', kid: 'issuer-key-1' })).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`;
        expect(await verifyIssuerJws(none, { typ: 'social+jwt', key })).toMatchObject({ ok: false });
    });
});
