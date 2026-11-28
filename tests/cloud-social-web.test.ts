// Google and Apple on the website, through Socio's sign-in page: the
// server asks the issuer for a one-time page for its nonce, and redeems the
// sealed result the browser brings back for a statement checked exactly as
// the app's is (`typ: social+jwt`, this issuer, this deployment, short-lived).
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SecretBox } from '@socio/foundation/keys/secret-box';

import { cloudService, socialVerification } from '../src/server/cloud/layer.js';
import type { CloudService } from '../src/server/cloud/service.js';
import { cloudFromEnv } from '../src/server/cloud/settings.js';

import { AUTH_PAGE, fakeIssuer, ISSUER, type FakeIssuer } from './fixtures/fake-cloud-issuer.js';
import { Store } from './helpers/stores.js';
import { testDatabaseFile } from './helpers/test-database.js';

const KEY = new Uint8Array(32).fill(7);
const SECRET = 'cloud-test-session-secret-0123456789';
const NONCE = 'n'.repeat(43);

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0).reverse()) {
        fn();
    }
});

async function connected(options: { scopes?: string; enroll?: boolean } = {}) {
    const issuer: FakeIssuer = fakeIssuer();
    issuer.scopes = options.scopes ?? 'reports:write social:verify';
    issuer.socialConfig = {
        google: { serverClientId: 'test-web-client.apps.example.test', web: true },
        apple: { web: true },
    };
    const dir = mkdtempSync(join(tmpdir(), 'cloud-social-web-'));
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
    });
    await cloud.work();
    const social = socialVerification({ config, cloud, transport: issuer.fetch });
    const calls = (path: string) => issuer.requests.filter((request) => request.path === path).length;
    /** A started flow's result, as the browser brings it back once the person signed in as `sub`. */
    const result = async (
        provider: 'google' | 'apple' = 'google',
        sub = 'sub-ada',
        extra?: Record<string, unknown>,
    ) => {
        const started = await social.webStart({ provider, purpose: 'signin', nonce: NONCE });
        if (!started.ok) {
            throw new Error('not started');
        }
        return issuer.completeWeb(started.url, sub, extra);
    };
    return { issuer, social, deploymentId, logs, calls, result };
}

const status = (code: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json', ...headers } });

describe('the config', () => {
    it('reads web: true per provider, and only true', async () => {
        const { social } = await connected();
        expect(await social.config()).toEqual({
            google: { serverClientId: 'test-web-client.apps.example.test', web: true },
            apple: { web: true },
        });
    });

    it('takes web as true only: anything else is no website flow', async () => {
        const { social, issuer } = await connected();
        issuer.socialConfig = { google: { serverClientId: 'x.apps.example.test', web: 'yes' }, apple: { web: 1 } };
        expect(await social.config()).toEqual({ google: { serverClientId: 'x.apps.example.test' }, apple: {} });
    });
});

describe('a website start', () => {
    it('asks for a page for the nonce with the deployment’s token, and answers it', async () => {
        const { social, issuer } = await connected();
        const started = await social.webStart({ provider: 'apple', purpose: 'link', nonce: NONCE });
        expect(started).toEqual({ ok: true, url: expect.stringMatching(new RegExp(`^${AUTH_PAGE}/s\\?t=`)) });
        const sent = issuer.requests.find((request) => request.path === '/v1/social/web/start')!;
        // Never a return address: the cloud takes it from its registry.
        expect(JSON.parse(sent.body)).toEqual({ provider: 'apple', purpose: 'link', nonce: NONCE });
        expect(sent.headers.authorization).toMatch(/^Bearer at_/);
    });

    it.each([
        ['409 origin_unavailable', status(409, { error: 'origin_unavailable' })],
        ['422 provider_unavailable', status(422, { error: 'provider_unavailable' })],
        ['a 500', status(500)],
        ['a page that isn’t https', status(200, { url: 'http://auth.socio.test/s?t=1' })],
        ['no page', status(200, {})],
    ])('answers provider_unavailable for %s', async (_, answer) => {
        const { social, issuer } = await connected();
        issuer.socialWebStart = () => answer.clone();
        expect(await social.webStart({ provider: 'google', purpose: 'signin', nonce: NONCE })).toEqual({
            ok: false,
            code: 'provider_unavailable',
        });
    });

    it('passes a 429’s Retry-After on', async () => {
        const { social, issuer } = await connected();
        issuer.socialWebStart = () => status(429, { error: 'rate_limited' }, { 'retry-after': '7' });
        expect(await social.webStart({ provider: 'google', purpose: 'signin', nonce: NONCE })).toEqual({
            ok: false,
            code: 'too_many',
            retryAfterS: 7,
        });
    });

    it('sends nothing when the server isn’t connected, or lacks social:verify', async () => {
        for (const options of [{ enroll: false }, { scopes: 'reports:write' }]) {
            const { social, calls } = await connected(options);
            expect(await social.webStart({ provider: 'google', purpose: 'signin', nonce: NONCE })).toMatchObject({
                ok: false,
                code: 'provider_unavailable',
            });
            expect(calls('/v1/social/web/start')).toBe(0);
        }
    });
});

describe('a website redeem', () => {
    it('names the person from the statement, with its nonce, and never logs them', async () => {
        const { social, result, logs, issuer } = await connected();
        const r = await result('google', 'sub-ada', { email: 'ada@example.com', emailVerified: true });
        expect(await social.redeemWeb({ provider: 'google', result: r })).toEqual({
            ok: true,
            provider: 'google',
            sub: 'sub-ada',
            nonce: NONCE,
            email: 'ada@example.com',
            emailVerified: true,
        });
        const sent = issuer.requests.find((request) => request.path === '/v1/social/web/redeem')!;
        expect(JSON.parse(sent.body)).toEqual({ result: r });
        expect(logs.join('\n')).not.toMatch(/ada@example|eyJ|sub-ada/);
    });

    it('answers nonce_invalid for a result redeemed already (the issuer’s 422 result_invalid)', async () => {
        const { social, result } = await connected();
        const r = await result();
        expect(await social.redeemWeb({ provider: 'google', result: r })).toMatchObject({ ok: true });
        expect(await social.redeemWeb({ provider: 'google', result: r })).toEqual({
            ok: false,
            code: 'nonce_invalid',
        });
    });

    it('asks nothing for what was never a result', async () => {
        const { social, calls } = await connected();
        for (const r of ['', 'short', 'a'.repeat(5000), 'has spaces in it, so no']) {
            expect(await social.redeemWeb({ provider: 'google', result: r })).toEqual({
                ok: false,
                code: 'nonce_invalid',
            });
        }
        expect(calls('/v1/social/web/redeem')).toBe(0);
    });

    it.each([
        ['another deployment', { aud: 'dep_SOMEONEELSE' }, {}],
        ['another issuer', { iss: 'https://cloud.evil.test' }, {}],
        ['another provider', { provider: 'apple' }, {}],
        ['a long life', { exp: Math.floor(Date.now() / 1000) + 600 }, {}],
        ['no nonce', { nonce: undefined }, {}],
        ['an access token’s type', {}, { typ: 'at+jwt' }],
    ])('refuses a statement for %s', async (_, claims, header) => {
        const { social, issuer, deploymentId } = await connected();
        issuer.socialWebRedeem = () => {
            const iat = Math.floor(Date.now() / 1000);
            return status(200, {
                statement: issuer.signStatement(
                    {
                        iss: ISSUER,
                        aud: deploymentId,
                        provider: 'google',
                        sub: 'sub-ada',
                        nonce: NONCE,
                        iat,
                        exp: iat + 60,
                        ...claims,
                    },
                    header,
                ),
            });
        };
        expect(await social.redeemWeb({ provider: 'google', result: 'r'.repeat(43) })).toEqual({
            ok: false,
            code: 'invalid_token',
        });
    });

    it('refuses a statement signed by another key', async () => {
        const { social, issuer, deploymentId } = await connected();
        const { privateKey } = generateKeyPairSync('ed25519');
        issuer.socialWebRedeem = () => {
            const iat = Math.floor(Date.now() / 1000);
            const claims = { iss: ISSUER, aud: deploymentId, provider: 'google', sub: 's', nonce: NONCE, iat };
            return status(200, { statement: issuer.signStatement({ ...claims, exp: iat + 60 }, {}, privateKey) });
        };
        expect(await social.redeemWeb({ provider: 'google', result: 'r'.repeat(43) })).toEqual({
            ok: false,
            code: 'invalid_token',
        });
    });

    it('answers too_many for a 429 and provider_unavailable when the cloud is down', async () => {
        const { social, issuer } = await connected();
        issuer.socialWebRedeem = () => status(429, { error: 'rate_limited' });
        expect(await social.redeemWeb({ provider: 'google', result: 'r'.repeat(43) })).toEqual({
            ok: false,
            code: 'too_many',
        });
        issuer.down = 'network';
        expect(await social.redeemWeb({ provider: 'google', result: 'r'.repeat(43) })).toEqual({
            ok: false,
            code: 'provider_unavailable',
        });
    });
});
