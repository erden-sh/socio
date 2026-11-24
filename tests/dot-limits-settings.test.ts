import { Context } from 'effect';
import { afterEach, expect, it } from 'vitest';

import { DEFAULT_DOT_REQUEST_LIMITS, dotRequestLimits } from '@socio/foundation/issues/settings';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { builtServices } from '../src/server/composition/capabilities.js';
import { issuesModule } from '../src/server/issues/module.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// Settings → General → Dot filing limits: an admin's over the server's.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture() {
    const config = { mode: 'live' as const, baseUrl: 'https://model.invalid/v1' };
    const { app, store, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            baseUrl: config.baseUrl,
            apiKey: 'unused',
            model: 'qwen-test',
            runtimeUrl: '',
            dotRequestLimits: { ...DEFAULT_DOT_REQUEST_LIMITS, perDot: 7, perUser: 9 },
        },
        app: {
            config,
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'limits-secret-0123456789abcdef'),
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
        workspace,
        platform,
        alice: await as('alice'),
        bob: await as('bob'),
    };
}

const limitsIn = async (response: Response) =>
    ((await response.json()) as { settings: { dotDailyLimits: unknown } }).settings.dotDailyLimits;

it("shows the server's limits until an admin saves their own", async () => {
    const { alice, bob, store, platform } = await fixture();
    expect(await limitsIn(await bob('/api/state'))).toEqual({
        perDot: 7,
        perUser: 9,
    });

    const member = await bob('/api/settings', 'PATCH', {
        dotDailyLimits: { perDot: 100, perUser: 100 },
    });
    expect(member.status).toBe(403);

    for (const bad of [
        { perDot: -1, perUser: 5 },
        { perDot: 2.5, perUser: 5 },
        { perDot: 5 },
        { perDot: 10_001, perUser: 5 },
    ]) {
        expect((await alice('/api/settings', 'PATCH', { dotDailyLimits: bad })).status).toBe(400);
    }

    const saved = await alice('/api/settings', 'PATCH', {
        dotDailyLimits: { perDot: 120, perUser: 0 },
    });
    expect(saved.status).toBe(200);
    expect(await limitsIn(await bob('/api/state'))).toEqual({
        perDot: 120,
        perUser: 0,
    });
    // What the Dot's tools are given; the window stays the server's.
    expect(dotRequestLimits(store.settings(), platform.config.dotRequestLimits)).toEqual({
        perDot: 120,
        perUser: 0,
        windowMs: 24 * 60 * 60 * 1000,
    });
    // Other settings keep them.
    await alice('/api/settings', 'PATCH', { researchAllowed: false });
    expect(store.settings().dotDailyLimits).toEqual({ perDot: 120, perUser: 0 });
});

it('tells the Dot the limits in force', async () => {
    const { alice, workspace, platform } = await fixture();
    await alice('/api/settings', 'PATCH', {
        dotDailyLimits: { perDot: 33, perUser: 44 },
    });
    const dot = { ...workspace.dots()[0], issuesAllowed: true };
    const [board] = issuesModule.capabilities!(platform.context, builtServices(Context.empty()));
    const status = (await board.status!({ dot, userId: 'alice' } as never)) as {
        limits: unknown;
    };
    expect(status.limits).toEqual({ perDotDaily: 33, perPersonDaily: 44 });
});
