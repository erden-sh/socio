import { afterEach, describe, expect, it } from 'vitest';

import {
    appFromUserAgent,
    appVerdict,
    CLIENT_COMPAT,
    CLIENT_UPDATE_WORDS,
    compareAppVersions,
    readClientUpdateRequired,
    readPlatformCompat,
    type ClientCompat,
} from '@socio/shared/client-compat';

import { createApp } from '../src/server/app.js';
import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { clientCompatFromEnv, exemptFromClientCompat } from '../src/server/updates/client-compat.js';

import { Runner } from './helpers/runners.js';
import { Store } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

// CB-553: the app versions a server works with. `GET /api/client/compat`
// publishes them to anyone; an app below its platform's minimum gets one
// answer, 426 `client_update_required`, everywhere but sign-in, sign-out and
// the numbers; the web, agents and plugins (no `Socio/` User-Agent) are
// never refused for a version.

const SECRET = 'client-compat-secret-0123456789abcdef';
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

const COMPAT: ClientCompat = {
    platforms: {
        ios: { minimum: '0.3.0', recommended: '0.3.2' },
        android: { minimum: '0.3.1', recommended: '0.3.1' },
    },
};

const iphone = (version: string) => `Socio/${version} (iPhone; iOS 26)`;
const ipad = (version: string) => `Socio/${version} (iPad; iOS 26)`;
const android = (version: string) => `Socio/${version} (Android; Android 16)`;
const BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';

async function fixture(compat?: ClientCompat) {
    const store = new Store(testDatabase());
    cleanup.push(() => store.close());
    const config = { mode: 'live' as const, baseUrl: 'https://model.invalid/v1' };
    const app = createApp({
        store,
        runner: new Runner(store, config),
        config,
        auth: { provider: new MockAuthProvider(DEFAULT_MOCK_USERS, SECRET), secureCookies: false },
        ...(compat && { clientCompat: compat }),
    });
    const signIn = async (userAgent?: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(userAgent && { 'User-Agent': userAgent }) },
            body: JSON.stringify({ userId: 'bob' }),
        });
        expect(login.status).toBe(200);
        return login.headers.get('set-cookie')!.split(';')[0]!;
    };
    const request = (path: string, { userAgent, cookie, method = 'GET' }: RequestOptions = {}) =>
        app.request(path, {
            method,
            headers: {
                ...(userAgent && { 'User-Agent': userAgent }),
                ...(cookie && { cookie }),
                ...(method !== 'GET' && { 'Content-Type': 'application/json' }),
            },
            ...(method !== 'GET' && { body: '{}' }),
        });
    return { request, signIn };
}

interface RequestOptions {
    userAgent?: string;
    cookie?: string;
    method?: string;
}

describe('the versions', () => {
    it('compares app versions part by part, a missing part 0', () => {
        expect(compareAppVersions('0.2.7', '0.2.7')).toBe(0);
        expect(compareAppVersions('0.2.6', '0.2.7')).toBe(-1);
        expect(compareAppVersions('0.10.0', '0.9.9')).toBe(1);
        expect(compareAppVersions('0.3', '0.3.0')).toBe(0);
        expect(compareAppVersions('1', '0.99.99')).toBe(1);
        expect(compareAppVersions('0.2.7.1', '0.2.7')).toBe(1);
    });

    it('reads the app from its own User-Agent only', () => {
        expect(appFromUserAgent(iphone('0.2.7'))).toEqual({ version: '0.2.7', platform: 'ios' });
        expect(appFromUserAgent(ipad('0.3'))).toEqual({ version: '0.3', platform: 'ios' });
        expect(appFromUserAgent(android('1.0.0'))).toEqual({ version: '1.0.0', platform: 'android' });
        for (const other of [BROWSER, 'Socio/0.1 (OAuth client metadata)', 'node', '', null, undefined]) {
            expect(appFromUserAgent(other), String(other)).toBeNull();
        }
    });

    it('says where a version stands', () => {
        const ios = COMPAT.platforms.ios;
        expect(appVerdict('0.2.9', ios)).toBe('required');
        expect(appVerdict('0.3.0', ios)).toBe('recommended');
        expect(appVerdict('0.3.1', ios)).toBe('recommended');
        expect(appVerdict('0.3.2', ios)).toBe('current');
        expect(appVerdict('0.4.0', ios)).toBe('current');
    });

    it('today needs 0.2.7 on both platforms', () => {
        expect(CLIENT_COMPAT.platforms.ios).toEqual({ minimum: '0.2.7', recommended: '0.2.7' });
        expect(CLIENT_COMPAT.platforms.android).toEqual({ minimum: '0.2.7', recommended: '0.2.7' });
    });

    it('reads a body or a stored copy, a recommendation below the minimum as the minimum', () => {
        expect(readPlatformCompat(COMPAT, 'android')).toEqual({ minimum: '0.3.1', recommended: '0.3.1' });
        expect(readPlatformCompat({ platforms: { ios: { minimum: '0.4.0', recommended: '0.3.0' } } }, 'ios')).toEqual({
            minimum: '0.4.0',
            recommended: '0.4.0',
        });
        for (const body of [null, 'text', {}, { platforms: {} }, { platforms: { ios: { minimum: 'v1' } } }]) {
            expect(readPlatformCompat(body, 'ios'), JSON.stringify(body)).toBeNull();
        }
        expect(readClientUpdateRequired({ code: 'client_update_required', minimum: '0.3.0', platform: 'ios' })).toEqual(
            { minimum: '0.3.0', platform: 'ios' },
        );
        expect(readClientUpdateRequired({ code: 'sign_in' })).toBeNull();
    });

    it('takes an operator’s APP_MINIMUM_VERSION and APP_RECOMMENDED_VERSION for every platform', () => {
        expect(clientCompatFromEnv({})).toBe(CLIENT_COMPAT);
        expect(clientCompatFromEnv({ APP_MINIMUM_VERSION: ' ', APP_RECOMMENDED_VERSION: '' })).toBe(CLIENT_COMPAT);
        expect(clientCompatFromEnv({ APP_MINIMUM_VERSION: '0.9.0' }, COMPAT)).toEqual({
            platforms: {
                ios: { minimum: '0.9.0', recommended: '0.9.0' },
                android: { minimum: '0.9.0', recommended: '0.9.0' },
            },
        });
        expect(clientCompatFromEnv({ APP_RECOMMENDED_VERSION: '0.3.5' }, COMPAT)).toEqual({
            platforms: {
                ios: { minimum: '0.3.0', recommended: '0.3.5' },
                android: { minimum: '0.3.1', recommended: '0.3.5' },
            },
        });
        expect(() => clientCompatFromEnv({ APP_MINIMUM_VERSION: 'v0.3' })).toThrow(/APP_MINIMUM_VERSION/);
        expect(() => clientCompatFromEnv({ APP_RECOMMENDED_VERSION: 'latest' })).toThrow(/APP_RECOMMENDED_VERSION/);
    });
});

describe('the endpoint', () => {
    it('publishes the numbers to anyone, with no session and no store', async () => {
        const { request } = await fixture(COMPAT);
        for (const userAgent of [undefined, BROWSER, iphone('0.1.0'), android('0.3.1')]) {
            const response = await request('/api/client/compat', { userAgent });
            expect(response.status, userAgent).toBe(200);
            expect(response.headers.get('cache-control')).toBe('no-store');
            expect(await response.json()).toEqual(COMPAT);
        }
    });

    it('publishes shared’s numbers by default', async () => {
        const { request } = await fixture();
        expect(await (await request('/api/client/compat')).json()).toEqual(CLIENT_COMPAT);
    });
});

describe('the guard', () => {
    it('refuses an app below its platform’s minimum with one answer', async () => {
        const { request, signIn } = await fixture(COMPAT);
        const cookie = await signIn(iphone('0.2.9'));
        for (const [userAgent, platform, minimum] of [
            [iphone('0.2.9'), 'ios', '0.3.0'],
            [ipad('0.2'), 'ios', '0.3.0'],
            [android('0.3.0'), 'android', '0.3.1'],
        ] as const) {
            for (const [path, method] of [
                ['/api/state', 'GET'],
                ['/api/workspace', 'GET'],
                ['/api/conversations', 'POST'],
                ['/api/no-such-route', 'GET'],
            ] as const) {
                const response = await request(path, { userAgent, cookie, method });
                expect(response.status, `${userAgent} ${method} ${path}`).toBe(426);
                expect(response.headers.get('cache-control')).toBe('no-store');
                expect(await response.json()).toEqual({
                    error: CLIENT_UPDATE_WORDS,
                    code: 'client_update_required',
                    minimum,
                    platform,
                });
            }
        }
        // Before the session check: an old app without one learns the same.
        expect((await request('/api/state', { userAgent: iphone('0.2.9') })).status).toBe(426);
    });

    it('lets an app at or above the minimum through, between minimum and recommended included', async () => {
        const { request, signIn } = await fixture(COMPAT);
        const cookie = await signIn(iphone('0.3.0'));
        for (const userAgent of [iphone('0.3.0'), iphone('0.3.1'), iphone('0.3.2'), ipad('1.0'), android('0.3.1')]) {
            expect((await request('/api/state', { userAgent, cookie })).status, userAgent).toBe(200);
        }
        // Signed out, the session check answers as it always has.
        expect((await request('/api/state', { userAgent: android('0.4.0') })).status).toBe(401);
    });

    it('never refuses the web, agents or plugins for a version', async () => {
        const { request, signIn } = await fixture({
            platforms: {
                ios: { minimum: '99.0.0', recommended: '99.0.0' },
                android: { minimum: '99.0.0', recommended: '99.0.0' },
            },
        });
        const cookie = await signIn(BROWSER);
        for (const userAgent of [undefined, BROWSER, 'Socio/0.1 (OAuth client metadata)', 'mcp-client/1.0']) {
            expect((await request('/api/state', { userAgent, cookie })).status, String(userAgent)).toBe(200);
        }
    });

    it('keeps sign-in, the session, sign-out, the numbers and everything outside /api reachable', async () => {
        const { request, signIn } = await fixture(COMPAT);
        const old = iphone('0.1.0');
        // Sign-in, the session and the methods.
        const cookie = await signIn(old);
        expect((await request('/api/auth/session', { userAgent: old, cookie })).status).toBe(200);
        expect((await request('/api/auth/mock/users', { userAgent: old })).status).toBe(200);
        expect((await request('/api/client/compat', { userAgent: old })).status).toBe(200);
        // Outside /api: the connection badge's ping and the pages never meet the guard.
        expect((await request('/ping', { userAgent: old })).status).toBe(204);
        // Sign-out last.
        expect((await request('/api/auth/logout', { userAgent: old, cookie, method: 'POST' })).status).toBe(200);
    });

    it('exempts exactly sign-in and sign-out’s prefix and the endpoint', () => {
        for (const path of ['/api/auth', '/api/auth/session', '/api/auth/logout', '/api/auth/device/redeem']) {
            expect(exemptFromClientCompat(path), path).toBe(true);
        }
        expect(exemptFromClientCompat('/api/client/compat')).toBe(true);
        for (const path of ['/api/authx', '/api/state', '/api/client/compat/x', '/api/client', '/api/account/leave']) {
            expect(exemptFromClientCompat(path), path).toBe(false);
        }
    });
});
