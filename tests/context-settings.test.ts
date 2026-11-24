import { afterEach, expect, it } from 'vitest';

import { contextSettings, contextSettingsFromEnv } from '@socio/foundation/context/settings';
import {
    DEFAULT_CONTEXT_SETTINGS,
    DEFAULT_TURN_RECALL_TOKENS,
    PROSE_CHARS,
    TURN_MEMORY_CHARS,
    recallScale,
    type ContextSettings,
} from '@socio/shared/context-settings';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// Settings → General → Long chats (CB-137, CB-134): who writes a long
// chat's notes and which pinned facts a prompt carries, an admin's over
// CONTEXT_SUMMARY_MODEL and CONTEXT_SELECTION.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture(context?: Partial<ContextSettings>) {
    const config = { mode: 'live' as const, baseUrl: '' };
    const { app, store, dispose } = await makeTestRuntime({
        config: {
            baseUrl: '',
            apiKey: '',
            model: '',
            voiceName: 'marin',
            runtimeUrl: '',
            context,
        },
        app: {
            config,
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'context-secret-0123456789abcdef'),
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

const context = async (request: (path: string) => Response | Promise<Response>) =>
    (
        (await (await request('/api/state')).json()) as {
            settings: { context: unknown };
        }
    ).settings.context;

it('lets an admin choose who writes the notes and which facts go with a prompt, over the environment’s', async () => {
    const f = await fixture();
    expect(await context(f.bob)).toEqual(DEFAULT_CONTEXT_SETTINGS);
    expect(DEFAULT_CONTEXT_SETTINGS).toEqual({
        summaryModel: 'shared',
        selection: 'relevance',
    });
    const change = { context: { selection: 'pointer' } };
    expect((await f.bob('/api/settings', 'PATCH', change)).status).toBe(403);
    for (const bad of [{ selection: 'newest' }, { summaryModel: 'gpt' }, { summaryModel: 'chat', other: true }]) {
        expect((await f.alice('/api/settings', 'PATCH', { context: bad })).status).toBe(400);
    }
    // One at a time: the other stays as it is.
    expect((await f.alice('/api/settings', 'PATCH', change)).status).toBe(200);
    expect(f.store.settings().context).toEqual({
        summaryModel: 'shared',
        selection: 'pointer',
    });
    expect(
        (
            await f.alice('/api/settings', 'PATCH', {
                context: { summaryModel: 'chat' },
            })
        ).status,
    ).toBe(200);
    expect(await context(f.bob)).toEqual({
        summaryModel: 'chat',
        selection: 'pointer',
    });

    // The environment's starting values, until an admin saves others.
    const env = await fixture({ summaryModel: 'chat', selection: 'relevance' });
    expect(await context(env.alice)).toEqual({
        summaryModel: 'chat',
        selection: 'relevance',
    });
    expect(
        (
            await env.alice('/api/settings', 'PATCH', {
                context: { selection: 'age' },
            })
        ).status,
    ).toBe(200);
    expect(await context(env.alice)).toEqual({
        summaryModel: 'chat',
        selection: 'age',
    });
});

it('reads CONTEXT_SUMMARY_MODEL and CONTEXT_SELECTION, refusing anything else', () => {
    expect(contextSettingsFromEnv({})).toEqual({});
    expect(
        contextSettingsFromEnv({
            CONTEXT_SUMMARY_MODEL: ' Chat ',
            CONTEXT_SELECTION: 'POINTER',
        }),
    ).toEqual({ summaryModel: 'chat', selection: 'pointer' });
    expect(() => contextSettingsFromEnv({ CONTEXT_SELECTION: 'smart' })).toThrow(
        'CONTEXT_SELECTION must be one of: age, relevance, pointer.',
    );
    expect(() => contextSettingsFromEnv({ CONTEXT_SUMMARY_MODEL: 'big' })).toThrow(
        'CONTEXT_SUMMARY_MODEL must be one of: shared, chat.',
    );
    expect(
        contextSettings(
            {
                name: '',
                paused: false,
                researchAllowed: true,
                memoryAllowed: true,
                context: { summaryModel: 'chat', selection: 'age' },
            },
            { selection: 'pointer' },
        ),
    ).toEqual({ summaryModel: 'chat', selection: 'age' });
});

it('scales recall by the budget an admin set, 1 when unset (CB-173)', () => {
    expect(DEFAULT_TURN_RECALL_TOKENS).toBe(TURN_MEMORY_CHARS / PROSE_CHARS);
    expect(recallScale()).toBe(1);
    expect(recallScale(undefined)).toBe(1);
    expect(recallScale(DEFAULT_TURN_RECALL_TOKENS * 2)).toBe(2);
    expect(recallScale(250)).toBe(0.25);
});
