import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SocialProvider } from '@socio/shared/device-sign-in';

import { linkWithSocial, type ObtainToken, signInWithSocial } from '../../src/data/social-sign-in';
import { createAuthedFetch } from '../../src/net/authed-fetch';
import { memoryJarStore, openCookieJar } from '../../src/net/cookie-jar';
import type { FetchFunction } from '../../src/net/fetch-function';
import { readManifest } from '../../src/net/probe';
import { createPublicFetch } from '../../src/net/public-fetch';
import type { SessionEnd } from '../../src/net/session';
import { SIGN_IN_PATH } from '../../src/net/sign-in';
import { readSocialLinks, unlinkSocial } from '../../src/net/social-sign-in';
import { testIdToken } from '../../src/net/social-test-token';
import { launch, phone, type Phone, sha256 } from '../helpers/store';

// Google and Apple sign-in's contract test (CB-570): the app's start, redeem, link, links and
// unlink against a real local server enrolled with the fake cloud services (`servers.mjs --social`,
// e2e/fake-cloud.mjs), with development test accounts. Runs only when SOCIO_CONTRACT_CREDENTIALS
// names that run's credentials file and SOCIO_CONTRACT_SOCIAL is set; CI skips it.

const CREDENTIALS = process.env.SOCIO_CONTRACT_CREDENTIALS;
const SOCIAL = process.env.SOCIO_CONTRACT_SOCIAL;
const USER_AGENT = 'Socio/0.1.0 (contract test)';

interface Credentials {
    password: string;
    accounts: { email: string }[];
    servers: { origin: string }[];
    social?: { cy: string };
}

const nodeFetch: FetchFunction = (url, init) => fetch(url, init as RequestInit);
const bytes = (length: number) => new Uint8Array(randomBytes(length));
const credentials = () => JSON.parse(readFileSync(CREDENTIALS!, 'utf8')) as Credentials;
const account =
    (name: string): ObtainToken =>
    async ({ provider, nonce }) => ({
        kind: 'token',
        idToken: testIdToken({ variant: 'development', provider, account: name, nonce }),
    });

let device: Phone;
beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-social-contract-')));
});
afterEach(() => rmSync(device.root, { recursive: true, force: true }));

async function signIn(origin: string, provider: SocialProvider, name: string) {
    const { store } = await launch(device);
    return signInWithSocial(
        {
            origin,
            provider,
            logo: null,
            platform: 'android',
            label: 'Socio app on Android',
            variant: 'development',
            obtain: account(name),
        },
        { store, hash: sha256, sha256Hex: sha256, fetch: nodeFetch, userAgent: USER_AGENT, randomBytes: bytes },
    );
}

describe.skipIf(!CREDENTIALS || !SOCIAL)('Google and Apple against a local server', () => {
    it('the manifest offers both', async () => {
        const [{ origin }] = credentials().servers;
        const read = await readManifest(origin!, {
            publicFetch: createPublicFetch({ fetch: nodeFetch, userAgent: USER_AGENT }),
        });
        expect(read).toMatchObject({ kind: 'manifest', manifest: { methods: { social: ['google', 'apple'] } } });
    });

    it.each(['google', 'apple'] as const)(
        '%s: not linked, then linked by Ada, signs in; unlinked, it ends',
        async (provider) => {
            const { servers, password, accounts } = credentials();
            const origin = servers[0]!.origin;
            const name = `ada-${provider}-${randomBytes(3).toString('hex')}`;
            expect(await signIn(origin, provider, name)).toMatchObject({
                kind: 'signed',
                outcome: { kind: 'problem', problem: { kind: 'not-linked', status: 404 } },
            });
            const jar = await openCookieJar({ origin, store: memoryJarStore() });
            const ends: SessionEnd[] = [];
            const request = createAuthedFetch({
                origin,
                jar,
                fetch: nodeFetch,
                userAgent: USER_AGENT,
                signal: new AbortController().signal,
                onUnauthorized: (end) => void ends.push(end),
            });
            expect(
                (await request(SIGN_IN_PATH, { method: 'POST', json: { email: accounts[0]!.email, password } })).status,
            ).toBe(200);
            const linked = await linkWithSocial({ fetch: request, provider, obtain: account(name), sha256Hex: sha256 });
            expect(linked).toMatchObject({ kind: 'linked', link: { provider, email: `${name}@example.test` } });
            expect(await readSocialLinks(request)).toMatchObject({
                kind: 'links',
                links: [expect.objectContaining({ provider })],
            });
            expect(await signIn(origin, provider, name)).toMatchObject({
                kind: 'signed',
                outcome: { kind: 'committed' },
            });
            expect(await unlinkSocial(request, provider)).toEqual({ ok: true });
            expect(await readSocialLinks(request)).toMatchObject({ kind: 'links', links: [] });
        },
    );

    it('Cy, linked but deactivated, is refused as deactivated', async () => {
        const { servers, social } = credentials();
        expect(await signIn(servers[0]!.origin, 'google', social!.cy)).toMatchObject({
            kind: 'signed',
            outcome: { kind: 'problem', problem: { kind: 'deactivated', status: 403 } },
        });
    });

    it.each([
        ['refuse-invalid', 'invalid-token', 401],
        ['refuse-nonce', 'nonce-invalid', 401],
        ['refuse-many', 'rate-limited', 429],
        ['refuse-unavailable', 'provider-unavailable', 503],
    ] as const)('the service’s %s reaches the app as %s', async (name, kind, status) => {
        const { servers } = credentials();
        expect(await signIn(servers[0]!.origin, 'apple', name)).toMatchObject({
            kind: 'signed',
            outcome: { kind: 'problem', problem: { kind, status } },
        });
        // The 503's Retry-After (1 s) holds the server's verifications that long.
        await new Promise((done) => setTimeout(done, 1_200));
    });
});
