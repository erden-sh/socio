import { afterEach, expect, it } from 'vitest';

import { appLogRetention, appLogRetentionFromEnv } from '@socio/foundation/apps/log-retention';
import { DEFAULT_APP_LOG_RETENTION, type AppLogRetention } from '@socio/shared/apps/app-log-retention';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// Settings → General → Mini app logs (CB-175): how long attempts and their
// logs are kept, an admin's over APPS_LOG_DAYS and APPS_LOG_ATTEMPTS.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture(appLogs?: Partial<AppLogRetention>) {
    const config = { mode: 'live' as const, baseUrl: '' };
    const { app, store, platform, dispose } = await makeTestRuntime({
        config: {
            baseUrl: '',
            apiKey: '',
            model: '',
            voiceName: 'marin',
            runtimeUrl: '',
            appLogs,
        },
        app: {
            config,
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'app-logs-secret-0123456789abcdef'),
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
    return { store, platform, alice: await as('alice'), bob: await as('bob') };
}

const appLogs = async (request: (path: string) => Response | Promise<Response>) =>
    (
        (await (await request('/api/state')).json()) as {
            settings: { appLogs: unknown };
        }
    ).settings.appLogs;

it('lets an admin set how long mini app logs are kept, over the environment’s', async () => {
    const f = await fixture();
    expect(DEFAULT_APP_LOG_RETENTION).toEqual({ days: 14, attempts: 50 });
    expect(await appLogs(f.bob)).toEqual(DEFAULT_APP_LOG_RETENTION);
    const change = { appLogs: { days: 30 } };
    expect((await f.bob('/api/settings', 'PATCH', change)).status).toBe(403);
    for (const bad of [
        { days: 0 },
        { days: 1.5 },
        { days: 400 },
        { attempts: 0 },
        { attempts: 9 },
        { attempts: 501 },
        { days: 7, other: true },
    ]) {
        expect((await f.alice('/api/settings', 'PATCH', { appLogs: bad })).status).toBe(400);
    }
    // One at a time: the other stays as it is.
    expect((await f.alice('/api/settings', 'PATCH', change)).status).toBe(200);
    expect(f.store.settings().appLogs).toEqual({ days: 30, attempts: 50 });
    expect((await f.alice('/api/settings', 'PATCH', { appLogs: { attempts: 20 } })).status).toBe(200);
    expect(await appLogs(f.bob)).toEqual({ days: 30, attempts: 20 });

    // The environment's starting values, until an admin saves others.
    const env = await fixture({ days: 3, attempts: 10 });
    expect(await appLogs(env.alice)).toEqual({ days: 3, attempts: 10 });
    await env.alice('/api/settings', 'PATCH', { appLogs: { days: 5 } });
    expect(await appLogs(env.alice)).toEqual({ days: 5, attempts: 10 });
});

it('reads APPS_LOG_DAYS and APPS_LOG_ATTEMPTS, refusing anything else', () => {
    expect(appLogRetentionFromEnv({})).toEqual({});
    expect(appLogRetentionFromEnv({ APPS_LOG_DAYS: ' 7 ', APPS_LOG_ATTEMPTS: '100' })).toEqual({
        days: 7,
        attempts: 100,
    });
    expect(() => appLogRetentionFromEnv({ APPS_LOG_DAYS: '0' })).toThrow(
        'APPS_LOG_DAYS must be a whole number from 1 to 365.',
    );
    expect(() => appLogRetentionFromEnv({ APPS_LOG_ATTEMPTS: 'many' })).toThrow(
        'APPS_LOG_ATTEMPTS must be a whole number from 10 to 500.',
    );
    expect(
        appLogRetention(
            {
                appLogs: { days: 2, attempts: 4 },
            },
            { days: 9 },
        ),
    ).toEqual({ days: 2, attempts: 4 });
});

it('prunes with the retention in force, read from settings each time', async () => {
    const f = await fixture({ days: 1, attempts: 12 });
    const attempts = f.platform.apps.promotions.attempts;
    const old = Date.now() - 10 * 86_400_000;
    await attempts.sync(
        'app',
        'boot',
        Array.from({ length: 14 }, (_, i) => i + 1).map((n) => ({
            id: `rt-${n}`,
            version: 1,
            kind: 'start' as const,
            state: 'failed' as const,
            startedAt: old + n,
            upAt: null,
            endedAt: old + n,
            exit: { reason: 'exit' as const, code: 1, signal: null, message: 'x' },
            lines: [],
            dropped: 0,
        })),
    );
    await f.platform.apps.promotions.pruneAttempts();
    expect((await attempts.list('app')).map((item) => item.attempt)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    // An admin lowers the count: it applies at the next prune.
    await f.alice('/api/settings', 'PATCH', { appLogs: { attempts: 10 } });
    await f.platform.apps.promotions.pruneAttempts();
    expect((await attempts.list('app')).map((item) => item.attempt)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
});
