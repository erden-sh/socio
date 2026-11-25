import { afterEach, expect, it } from 'vitest';

import { brandingInForce } from '@socio/foundation/settings/branding';
import { DEFAULT_BRANDING } from '@socio/shared/branding';
import { brandingSchema } from '@socio/shared/settings/branding';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});
async function fixture() {
    const config = { mode: 'live' as const, baseUrl: '' };
    const { app, store, dispose } = await makeTestRuntime({
        config: {
            baseUrl: '',
            apiKey: '',
            model: '',
            voiceName: 'marin',
            runtimeUrl: '',
        },
        app: {
            config,
            auth: {
                provider: new MockAuthProvider(
                    [...DEFAULT_MOCK_USERS, { id: 'carol', name: 'Carol', role: 'admin' }],
                    'context-secret-0123456789abcdef',
                ),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return (path: string, method = 'GET', body?: unknown) =>
            app.request(path, {
                method,
                headers: {
                    cookie,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    };
    return {
        store,
        app,
        alice: await as('alice'),
        bob: await as('bob'),
        carol: await as('carol'),
    };
}

it('lets admins save branding (CB-390) and publishes that identity before sign-in', async () => {
    const f = await fixture();
    const branding = { name: 'Acme Company Brain', logo: '/client-logo.png' };
    for (const request of [f.bob]) {
        expect((await request('/api/settings', 'PATCH', { branding })).status).toBe(403);
    }
    expect((await f.carol('/api/settings', 'PATCH', { branding })).status).toBe(200);
    expect((await f.alice('/api/settings', 'PATCH', { branding })).status).toBe(200);
    expect(f.store.settings().branding).toEqual(branding);
    expect((await (await f.app.request('/api/auth/session')).json()).branding).toEqual(branding);
    expect((await (await f.bob('/api/state')).json()).settings.branding).toEqual(branding);
    expect((await f.alice('/api/settings', 'PATCH', { branding: null })).status).toBe(200);
    expect((await (await f.app.request('/api/auth/session')).json()).branding).toEqual(DEFAULT_BRANDING);
});
it('rejects unsafe logo schemes, remote hosts and oversized uploads without changing saved branding', async () => {
    const f = await fixture();
    for (const logo of [
        'javascript:alert(1)',
        '//other.test/x.png',
        'https://other.test/x.png',
        '/\\other.test/x',
        'data:image/svg+xml;base64,PHN2Zz4=',
        'data:image/png;base64,' + 'a'.repeat(360_000),
    ]) {
        expect(
            (
                await f.alice('/api/settings', 'PATCH', {
                    branding: { name: 'Acme', logo },
                })
            ).status,
        ).toBe(400);
    }
    expect(f.store.settings().branding).toBeUndefined();
});
it('uses deployment defaults until an admin overrides them', () => {
    const env = { BRAND_NAME: 'Acme Company Brain', BRAND_LOGO: '/acme.png' };
    expect(brandingInForce(undefined, env)).toEqual({
        name: env.BRAND_NAME,
        logo: env.BRAND_LOGO,
    });
    expect(brandingInForce(DEFAULT_BRANDING, env)).toEqual(DEFAULT_BRANDING);
    expect(brandingInForce(null, env).name).toBe(env.BRAND_NAME);
    expect(brandingSchema.safeParse({ name: '  ', logo: '/logo.png' }).success).toBe(false);
    expect(
        brandingSchema.safeParse({
            name: 'Acme',
            logo: 'data:image/png;base64,aGVsbG8=',
        }).success,
    ).toBe(true);
});

it('saves an appearance default for admins and an independent preference per person', async () => {
    const { alice, bob } = await fixture();
    expect((await bob('/api/settings', 'PATCH', { defaultThemeId: 'erden' })).status).toBe(403);
    expect((await alice('/api/settings', 'PATCH', { defaultThemeId: 'retired' })).status).toBe(400);
    expect((await alice('/api/settings', 'PATCH', { defaultThemeId: 'erden' })).status).toBe(200);
    expect((await (await bob('/api/state')).json()).settings.defaultThemeId).toBe('erden');

    expect((await bob('/api/preferences', 'PATCH', { themeId: 'retired' })).status).toBe(400);
    expect((await bob('/api/preferences', 'PATCH', { colorMode: 'sepia' })).status).toBe(400);
    expect((await bob('/api/preferences', 'PATCH', { themeId: 'plum', userId: 'alice' })).status).toBe(400);
    const writes = await Promise.all([
        bob('/api/preferences', 'PATCH', { themeId: 'plum' }),
        bob('/api/preferences', 'PATCH', { colorMode: 'dark', dictation: 'device' }),
    ]);
    expect(writes.map(({ status }) => status)).toEqual([200, 200]);
    expect((await (await bob('/api/workspace')).json()).preferences).toMatchObject({
        themeId: 'plum',
        colorMode: 'dark',
        dictation: 'device',
    });
    expect((await (await alice('/api/preferences')).json()).themeId).toBeUndefined();
    expect(await (await bob('/api/preferences', 'PATCH', { themeId: null })).json()).toMatchObject({
        themeId: null,
        colorMode: 'dark',
        dictation: 'device',
    });
    expect((await alice('/api/settings', 'PATCH', { defaultThemeId: null })).status).toBe(200);
    expect((await (await bob('/api/state')).json()).settings.defaultThemeId).toBeNull();
});
