import { afterEach, expect, it } from 'vitest';

import { PING_PATH } from '../../packages/client/src/shell/connection-status.js';
import { createApp } from '../../src/server/app.js';
import { DEFAULT_MOCK_USERS } from '../../src/server/auth/config.js';
import { MockAuthProvider } from '../../src/server/auth/mock.js';
import { Runner } from '../helpers/runners.js';
import { Store } from '../helpers/stores.js';
import { testDatabase } from '../helpers/test-database.js';

// CB-263: the connection badge's round trip. An empty answer without a
// session, never cached, that says nothing about the workspace.

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function fixture() {
    const store = new Store(testDatabase());
    cleanup.push(() => store.close());
    const config = { mode: 'live' as const, baseUrl: 'https://model.invalid/v1' };
    return createApp({
        store,
        runner: new Runner(store, config),
        config,
        auth: {
            provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'ping-secret-0123456789abcdef'),
            secureCookies: false,
        },
    });
}

it('answers the ping with an empty, uncached 204 and no session', async () => {
    const app = fixture();
    const response = await app.request(PING_PATH);
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).toBe('');
    // A stale cookie changes nothing: it never looks the session up.
    const other = await app.request(PING_PATH, {
        headers: { cookie: 'session=stale' },
    });
    expect(other.status).toBe(204);
    expect(await other.text()).toBe('');
});
