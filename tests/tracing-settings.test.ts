import { afterEach, expect, it } from 'vitest';

import { traceContentFromEnv } from '@socio/foundation/observability/otel-export';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// Settings → General → Tracing (CB-128): "Include content in traces", an
// admin's over OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture(traceContent?: boolean) {
    const { store, app, dispose } = await makeTestRuntime({
        config: { apiKey: '', model: '', traceContent },
        app: {
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'tracing-secret-0123456789abcdef'),
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
    return { store, alice: await as('alice'), bob: await as('bob') };
}

const tracing = async (request: (path: string) => Response | Promise<Response>) =>
    (
        (await (await request('/api/state')).json()) as {
            settings: { tracing: unknown };
        }
    ).settings.tracing;

it('keeps content out of traces until an admin turns it on, over the environment’s', async () => {
    const f = await fixture();
    expect(await tracing(f.bob)).toEqual({
        includeContent: false,
        exporting: false,
    });
    const on = { tracing: { includeContent: true } };
    expect((await f.bob('/api/settings', 'PATCH', on)).status).toBe(403);
    expect(
        (
            await f.alice('/api/settings', 'PATCH', {
                tracing: { includeContent: 'yes' },
            })
        ).status,
    ).toBe(400);
    expect((await f.alice('/api/settings', 'PATCH', on)).status).toBe(200);
    expect(f.store.settings().tracing).toEqual({ includeContent: true });
    expect(await tracing(f.bob)).toEqual({
        includeContent: true,
        exporting: false,
    });

    // The environment's starting value, until an admin saves one.
    const env = await fixture(true);
    expect(await tracing(env.alice)).toMatchObject({ includeContent: true });
    expect(traceContentFromEnv({})).toBe(false);
    expect(
        traceContentFromEnv({
            OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'TRUE',
        }),
    ).toBe(true);
});

it('lets a busy own model fall back to the shared one until an admin turns it off (CB-140)', async () => {
    const f = await fixture();
    const fallback = async (request: (path: string) => Response | Promise<Response>) =>
        (
            (await (await request('/api/state')).json()) as {
                settings: { modelFallback: unknown };
            }
        ).settings.modelFallback;
    // On by default, for everyone to read.
    expect(await fallback(f.bob)).toBe(true);
    const off = { modelFallback: false };
    expect((await f.bob('/api/settings', 'PATCH', off)).status).toBe(403);
    expect((await f.alice('/api/settings', 'PATCH', { modelFallback: 'no' })).status).toBe(400);
    expect((await f.alice('/api/settings', 'PATCH', off)).status).toBe(200);
    expect(f.store.settings().modelFallback).toBe(false);
    expect(await fallback(f.bob)).toBe(false);
});
