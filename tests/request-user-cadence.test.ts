import { afterEach, expect, it, vi } from 'vitest';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) {
        await close();
    }
});

// The API's session check keeps its own resolver, with its own record of
// whom it wrote: a person is written once per name and role, not at each
// request, and each new app (its own resolver) writes again.
it('records a signed-in person once per API resolver, not at each request', async () => {
    const auth = {
        provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'secret-0123456789abcdef-xyz'),
        secureCookies: false,
    };
    const t = await makeTestRuntime({ app: { config: { mode: 'live', baseUrl: '' }, auth } });
    cleanup.push(t.dispose);
    const login = await t.app.request('/api/auth/mock/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'alice' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const recorded = vi.spyOn(t.workspace, 'recordUser');
    const sessionWrites = () => recorded.mock.calls.filter(([user]) => user.id === 'alice').length;

    for (let i = 0; i < 3; i++) {
        expect((await t.app.request('/api/workspace', { headers: { cookie } })).status).toBe(200);
    }
    const first = sessionWrites();
    expect(first).toBe(1);
    await t.app.request('/api/workspace', { headers: { cookie } });
    expect(sessionWrites()).toBe(first);

    // Another app over the same runtime has a resolver of its own: it writes once more.
    const other = t.makeApp({ config: { mode: 'live', baseUrl: '' }, auth });
    expect((await other.request('/api/workspace', { headers: { cookie } })).status).toBe(200);
    expect(sessionWrites()).toBe(first + 1);
});
