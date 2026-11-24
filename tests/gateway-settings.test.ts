import { afterEach, expect, it } from 'vitest';

import type { CodingSettingsState } from '@socio/shared/coding/coding-gateway';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { outsideByDefault } from '../src/server/gateway/coding-settings.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-239: Settings → Coding's models and limits, admin-edited over env
// defaults, dark behind `coding-sessions`, every change audited.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture(flags: Record<string, boolean> = { 'coding-sessions': true }) {
    const { platform, app, dispose } = await makeTestRuntime({
        config: {
            apiKey: '',
            model: '',
            sessionSecret: 'gateway-settings-secret-0123456789',
            // Its flags are in development: only an internal deployment has them (CB-503).
            deploymentKind: 'internal',
            featureFlags: flags,
        },
        app: {
            config: { mode: 'live', baseUrl: '', apiKey: '', model: '' },
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'gateway-settings-0123456789abcdef'),
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
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        return (path: string, method = 'GET', body?: unknown) =>
            app.request(`/api/gateway${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    };
    const local = await platform.inference.createBackend({
        label: 'Homelab',
        baseUrl: 'http://10.0.0.5:8000/v1',
        model: 'qwen38',
    });
    const remote = await platform.inference.createBackend({
        label: 'xAI',
        baseUrl: 'https://api.x.ai/v1',
        model: 'grok-5',
        apiKey: 'xai-secret-key-0123',
    });
    return {
        platform,
        local,
        remote,
        alice: await as('alice'),
        bob: await as('bob'),
    };
}

const model = (backendId: string, extra: Record<string, unknown> = {}) => ({
    label: 'Homelab (qwen38)',
    backendId,
    upstreamModel: 'qwen38',
    maxOutputTokens: 8_000,
    ...extra,
});

it('is hidden while coding sessions are off, and admin-only when on', async () => {
    const off = await fixture({});
    expect((await off.alice('/coding')).status).toBe(404);
    expect((await off.alice('/coding/models/x', 'PUT', model(off.local.id))).status).toBe(404);
    const on = await fixture();
    for (const [path, method, body] of [
        ['/coding', 'GET', undefined],
        ['/coding/models/orion', 'PUT', model(on.local.id)],
        ['/coding/models/orion', 'DELETE', undefined],
        ['/coding/models/orion/repositories', 'PUT', { repositories: [] }],
        ['/coding/limits', 'PUT', { sessionTokens: 5_000 }],
    ] as const) {
        expect((await on.bob(path, method, body)).status, `${method} ${path}`).toBe(403);
    }
    expect((await on.alice('/coding')).status).toBe(200);
});

it('lists models on shared backends, marks outside providers by address, and never shows a key', async () => {
    const f = await fixture();
    const saved = await f.alice('/coding/models/orion', 'PUT', model(f.local.id));
    expect(saved.status).toBe(200);
    await f.alice('/coding/models/grok', 'PUT', model(f.remote.id, { label: 'Grok 5', upstreamModel: 'grok-5' }));
    const text = await (await f.alice('/coding')).text();
    expect(text).not.toContain('xai-secret-key');
    const state = JSON.parse(text) as CodingSettingsState;
    expect(state.models.map((m) => [m.id, m.outsideProvider, m.backendHost])).toEqual([
        ['grok', true, 'api.x.ai'],
        ['orion', false, '10.0.0.5'],
    ]);
    expect(state.backends.map((b) => [b.label, b.outsideByDefault])).toEqual(
        expect.arrayContaining([
            ['Homelab', false],
            ['xAI', true],
        ]),
    );
    // An admin may mark a model either way; null follows the address again.
    await f.alice('/coding/models/grok', 'PUT', model(f.remote.id, { outsideProvider: false }));
    await f.alice('/coding/models/orion', 'PUT', model(f.local.id, { outsideProvider: true }));
    const marked = (await (await f.alice('/coding')).json()) as CodingSettingsState;
    expect(marked.models.map((m) => m.outsideProvider)).toEqual([false, true]);
});

it('refuses bad names, fields, backends, repositories and limits', async () => {
    const f = await fixture();
    for (const [path, body] of [
        ['/coding/models/Bad%20Name', model(f.local.id)],
        ['/coding/models/ok', { ...model(f.local.id), maxOutputTokens: 0 }],
        ['/coding/models/ok', { ...model(f.local.id), apiKey: 'sneaky' }],
        ['/coding/models/ok', model('no-such-backend')],
        ['/coding/limits', { sessionTokens: 1 }],
        ['/coding/limits', { instanceDailyTokens: 50_000_000 }],
    ] as const) {
        const response = await f.alice(path, 'PUT', body);
        expect([400, 404], path).toContain(response.status);
    }
    await f.alice('/coding/models/ok', 'PUT', model(f.local.id));
    for (const repositories of [['../etc'], ['owner/repo/extra'], 'owner/repo', [1]]) {
        expect((await f.alice('/coding/models/ok/repositories', 'PUT', { repositories })).status).toBe(400);
    }
    expect(
        (
            await f.alice('/coding/models/missing/repositories', 'PUT', {
                repositories: ['a/b'],
            })
        ).status,
    ).toBe(404);
});

it('records every change with the admin and old and new values, and no secrets', async () => {
    const f = await fixture();
    await f.alice('/coding/models/orion', 'PUT', model(f.local.id));
    await f.alice('/coding/models/orion', 'PUT', model(f.local.id, { maxOutputTokens: 9_000 }));
    await f.alice('/coding/models/orion/repositories', 'PUT', {
        repositories: ['Erden-Sh/Socio'],
    });
    await f.alice('/coding/limits', 'PUT', {
        sessionTokens: 3_000_000,
        requestsPerMinute: null,
    });
    await f.alice('/coding/limits', 'PUT', { sessionTokens: null });
    await f.alice('/coding/models/orion', 'DELETE');
    const rows = f.platform.actors.audit
        .list({}, 50)
        .filter((row) => row.phase === 'setting')
        .reverse();
    expect(rows.map((row) => [row.action, row.actorBy])).toEqual([
        ['coding.model.save', 'alice'],
        ['coding.model.save', 'alice'],
        ['coding.model.repositories', 'alice'],
        ['coding.limits', 'alice'],
        ['coding.limits', 'alice'],
        ['coding.model.remove', 'alice'],
    ]);
    expect(JSON.parse(rows[1]!.detail!)).toMatchObject({
        old: { maxOutputTokens: 8_000 },
        new: { maxOutputTokens: 9_000 },
    });
    expect(JSON.parse(rows[2]!.detail!)).toEqual({
        added: ['erden-sh/socio'],
        removed: [],
        count: 1,
    });
    expect(JSON.parse(rows[3]!.detail!)).toEqual({
        old: { sessionTokens: 2_000_000 },
        new: { sessionTokens: 3_000_000 },
    });
    expect(JSON.stringify(rows)).not.toContain('xai-secret-key');
    const state = (await (await f.alice('/coding')).json()) as CodingSettingsState;
    expect(state.models).toEqual([]);
    expect(state.limits.sessionTokens).toBe(state.limitDefaults.sessionTokens);
});

it('records a long repository change in full, as added and removed names over several rows', async () => {
    const f = await fixture();
    await f.alice('/coding/models/grok', 'PUT', model(f.remote.id));
    const many = Array.from({ length: 300 }, (_, i) => `an-owner-with-a-long-name/repository-number-${i}`);
    expect(
        (
            await f.alice('/coding/models/grok/repositories', 'PUT', {
                repositories: many,
            })
        ).status,
    ).toBe(200);
    const kept = many.slice(0, 299);
    await f.alice('/coding/models/grok/repositories', 'PUT', {
        repositories: [...kept, 'acme/new'],
    });
    const rows = f.platform.actors.audit
        .list({}, 100)
        .filter((row) => row.action === 'coding.model.repositories')
        .reverse();
    const parts = rows.map(
        (row) =>
            JSON.parse(row.detail!) as {
                added: string[];
                removed: string[];
                count: number;
                part?: number;
                of?: number;
            },
    );
    expect(rows.every((row) => row.detail!.length <= 2000)).toBe(true);
    // The first change: every name, over several rows of one correlation.
    const first = rows.filter((row) => row.correlationId === rows[0]!.correlationId);
    expect(first.length).toBeGreaterThan(1);
    expect(
        parts
            .slice(0, first.length)
            .flatMap((part) => part.added)
            .sort(),
    ).toEqual([...many].sort());
    expect(parts[0]).toMatchObject({ part: 1, of: first.length, count: 300 });
    // The second: one row, the difference only.
    expect(parts.slice(first.length)).toEqual([
        {
            added: ['acme/new'],
            removed: ['an-owner-with-a-long-name/repository-number-299'],
            count: 300,
        },
    ]);
});

it('follows the new backend’s address when a model moves without restating outsideProvider', async () => {
    const f = await fixture();
    const outside = async (id: string) =>
        ((await (await f.alice('/coding')).json()) as CodingSettingsState).models.find((m) => m.id === id)!;
    // Marked "not outside" on the operator's own backend.
    await f.alice('/coding/models/orion', 'PUT', model(f.local.id, { outsideProvider: false }));
    expect(await outside('orion')).toMatchObject({
        outsideProvider: false,
        outsideProviderSetting: false,
    });
    // Moved to a public provider without saying: the mark doesn't follow.
    await f.alice('/coding/models/orion', 'PUT', model(f.remote.id));
    expect(await outside('orion')).toMatchObject({
        outsideProvider: true,
        outsideProviderSetting: null,
    });
    // An explicit mark with the move stays, and an edit on the same
    // backend keeps it.
    await f.alice('/coding/models/orion', 'PUT', model(f.local.id, { outsideProvider: true }));
    await f.alice('/coding/models/orion', 'PUT', model(f.local.id, { maxOutputTokens: 9_000 }));
    expect(await outside('orion')).toMatchObject({
        outsideProvider: true,
        outsideProviderSetting: true,
    });
    // Audited as any save: the old mark and the new.
    const moved = f.platform.actors.audit
        .list({}, 50)
        .filter((row) => row.action === 'coding.model.save')
        .reverse()[1]!;
    expect(JSON.parse(moved.detail!)).toMatchObject({
        old: { backendId: f.local.id, outsideProvider: false },
        new: { backendId: f.remote.id, outsideProvider: null },
    });
});

it('decides an outside provider from the backend’s address alone', () => {
    for (const url of [
        'http://localhost:8000/v1',
        'http://127.0.0.1/v1',
        'http://10.1.2.3/v1',
        'http://192.168.1.10:11434/v1',
        'http://[::1]:8000/v1',
        'http://vllm:8000/v1',
        'http://gpu.internal/v1',
        'http://box.local/v1',
        'http://gpu.lan/v1',
    ]) {
        expect(outsideByDefault(url), url).toBe(false);
    }
    for (const url of [
        'https://api.openai.com/v1',
        'https://api.x.ai/v1',
        'http://8.8.8.8/v1',
        'https://openrouter.ai/api/v1',
        'not a url',
    ]) {
        expect(outsideByDefault(url), url).toBe(true);
    }
});
