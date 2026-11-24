import { afterEach, expect, it, vi } from 'vitest';

import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';
import type { User } from '@socio/shared/types';

import { createApp } from '../src/server/app.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { staticAuth } from './fixtures/static-auth.js';
import { Runner } from './helpers/runners.js';
import { Store } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';
import { formatAs } from './support/format.js';

// The HTTP edge's order: Hono runs middleware and routes in the order they are
// added, so which check sees a request first (the computers guard, the apps
// proxy, data tokens, service keys, plugin identities, the host and origin
// checks, the session, draining) is the order of `app.routes`. Moving the
// mounting out of app.ts must not change it; this pins it, with and without a
// platform, and with mini apps on.

const USERS: User[] = [{ id: 'alice', name: 'Alice', role: 'admin' }];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) {
        await step();
    }
    vi.restoreAllMocks();
});

/**
 * `METHOD path`, one line per middleware or route, in the order Hono runs
 * them; a handler's name when it has one, so the checks that share a path
 * (four on /api/*) are told apart.
 */
const order = (app: ReturnType<typeof createApp>) =>
    app.routes.map(({ method, path, handler }) => `${method} ${path}${handler.name ? ` ${handler.name}` : ''}`);

async function withPlatform(apps: boolean) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, dispose } = await makeTestRuntime({
        config: {
            baseUrl: 'https://model.invalid/v1',
            ...(apps && { apps: appsSettingsFromEnv({ APPS_HOST: 'apps.example' }, 'https://socio.example') }),
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            origin: 'https://socio.example',
            auth: { provider: new MockAuthProvider(USERS, 'secret-0123456789abcdef-xyz'), secureCookies: false },
        },
    });
    cleanup.push(dispose);
    return app;
}

it('keeps the order of every middleware and route', async () => {
    const store = new Store(testDatabase());
    cleanup.push(() => store.close());
    const bare = createApp({
        auth: staticAuth(),
        store,
        runner: new Runner(store, { mode: 'sample', baseUrl: '' }),
        config: { mode: 'sample', baseUrl: '' },
    });
    const text = JSON.stringify({
        withoutPlatform: order(bare),
        withPlatform: order(await withPlatform(false)),
        withMiniApps: order(await withPlatform(true)),
    });
    await expect(await formatAs('http-order.json', text)).toMatchFileSnapshot('./__snapshots__/http-order.json');
});
