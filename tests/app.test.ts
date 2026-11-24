import { afterEach, describe, expect, it } from 'vitest';

import { resolveAppOrigins } from '@socio/foundation/http/app-origin';

import { createApp } from '../src/server/app.js';
import type { Config } from '../src/server/web/research.js';

import { staticAuth } from './fixtures/static-auth.js';
import { Runner } from './helpers/runners.js';
import { Store } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const stores: Store[] = [];
const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
function fixture(origin?: string | string[]) {
    const store = new Store(testDatabase());
    stores.push(store);
    const runner = new Runner(store, config);
    return {
        store,
        runner,
        app: createApp({
            auth: staticAuth(),
            store,
            runner,
            config,
            origin,
        }),
    };
}
const json = (body: unknown) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});
afterEach(() => stores.splice(0).forEach((store) => store.close()));
describe('API boundaries', () => {
    it('reports numeric server processing time on polling and ping responses', async () => {
        const { app } = fixture();
        for (const path of ['/ping', '/api/state']) {
            const response = await app.request(path);
            expect(response.headers.get('Server-Timing')).toMatch(/^app;dur=\d+\.\d$/);
        }
    });
    it('has no owner-token gate: a bearer token is neither needed nor used', async () => {
        const { app } = fixture();
        expect((await app.request('/api/state')).status).toBe(200);
        const response = await app.request('/api/state', {
            headers: { Authorization: 'Bearer some-old-owner-token' },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).not.toHaveProperty('code');
    });
    it('blocks browser cross-origin requests and form posts', async () => {
        const { app } = fixture();
        expect(
            (
                await app.request('/api/tasks', {
                    ...json({ prompt: 'test' }),
                    headers: {
                        'Content-Type': 'application/json',
                        Origin: 'https://evil.example',
                    },
                })
            ).status,
        ).toBe(403);
        expect(
            (
                await app.request('/api/tasks', {
                    method: 'POST',
                    body: 'prompt=hello',
                })
            ).status,
        ).toBe(415);
    });
    it.each(['http://localhost:4310', 'http://127.0.0.1:4310'])(
        'allows a same-origin mutation from the development origin %s',
        async (origin) => {
            const { app } = fixture(resolveAppOrigins(undefined, 'development'));
            const response = await app.request(`${origin}/api/tasks`, {
                ...json({ prompt: 'test' }),
                headers: {
                    'Content-Type': 'application/json',
                    Origin: origin,
                    'Sec-Fetch-Site': 'same-origin',
                },
            });
            expect(response.status).toBe(201);
        },
    );
    it.each(['https://evil.example', 'http://localhost:5173', 'https://localhost:4310'])(
        'rejects an unlisted origin %s with multiple origins configured',
        async (origin) => {
            const { app } = fixture(resolveAppOrigins(undefined, 'development'));
            const response = await app.request('http://localhost:4310/api/tasks', {
                ...json({ prompt: 'test' }),
                headers: {
                    'Content-Type': 'application/json',
                    Origin: origin,
                    'Sec-Fetch-Site': 'same-origin',
                },
            });
            expect(response.status).toBe(403);
            expect(await response.json()).toEqual({
                error: 'Cross-origin requests are not allowed.',
            });
        },
    );
    it('rejects cross-site requests even from a configured origin', async () => {
        const { app } = fixture(resolveAppOrigins(undefined, 'development'));
        const response = await app.request('http://127.0.0.1:4310/api/tasks', {
            ...json({ prompt: 'test' }),
            headers: {
                'Content-Type': 'application/json',
                Origin: 'http://localhost:4310',
                'Sec-Fetch-Site': 'cross-site',
            },
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
            error: 'Cross-site requests are not allowed.',
        });
    });
    it('rejects same-site requests: a sibling subdomain is another site here', async () => {
        const { app } = fixture('https://brain.example.com');
        for (const init of [
            // A no-cors GET (an image) from x.brain.example.com sends no Origin.
            { headers: { 'Sec-Fetch-Site': 'same-site' } },
            {
                ...json({ prompt: 'test' }),
                headers: {
                    'Content-Type': 'application/json',
                    'Sec-Fetch-Site': 'same-site',
                },
            },
        ] as RequestInit[]) {
            const response = await app.request('https://brain.example.com/api/tasks', init);
            expect(response.status).toBe(403);
            expect(await response.json()).toEqual({
                error: 'Cross-site requests are not allowed.',
            });
        }
    });
    it('preserves exact matching for a single configured origin', async () => {
        const { app } = fixture('http://localhost:5173');
        for (const [origin, status] of [
            ['http://localhost:5173', 201],
            ['http://127.0.0.1:5173', 403],
        ] as const) {
            const response = await app.request('http://localhost:5173/api/tasks', {
                ...json({ prompt: 'test' }),
                headers: {
                    'Content-Type': 'application/json',
                    Origin: origin,
                    'Sec-Fetch-Site': 'same-origin',
                },
            });
            expect(response.status).toBe(status);
        }
    });
    it('rejects unrecognized hosts even when the origin is explicitly allowed', async () => {
        const { app } = fixture(resolveAppOrigins(undefined, 'development'));
        const response = await app.request('http://attacker.example/api/tasks', {
            ...json({ prompt: 'test' }),
            headers: {
                'Content-Type': 'application/json',
                Origin: 'http://localhost:5173',
                'Sec-Fetch-Site': 'same-origin',
            },
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'Unrecognized host.' });
    });
    it('does not widen access when an explicit origin list contains only blank entries', async () => {
        const { app } = fixture(resolveAppOrigins(' , ', 'development'));
        const response = await app.request('http://localhost:5173/api/tasks', {
            ...json({ prompt: 'test' }),
            headers: {
                'Content-Type': 'application/json',
                Origin: 'http://localhost:5173',
                'Sec-Fetch-Site': 'same-origin',
            },
        });
        expect(response.status).toBe(403);
    });
    it('requires the request URL origin by default in production', async () => {
        const { app } = fixture(resolveAppOrigins(undefined, 'production'));
        for (const [origin, status] of [
            ['http://localhost:4310', 201],
            ['http://localhost:5173', 403],
        ] as const) {
            const response = await app.request('http://localhost:4310/api/tasks', {
                ...json({ prompt: 'test' }),
                headers: {
                    'Content-Type': 'application/json',
                    Origin: origin,
                    'Sec-Fetch-Site': 'same-origin',
                },
            });
            expect(response.status).toBe(status);
        }
    });
    it('validates inputs and enforces research permissions on the server', async () => {
        const { app, store } = fixture();
        expect((await app.request('/api/tasks', json({ prompt: 'x' }))).status).toBe(400);
        expect((await app.request('/api/tasks', json({ prompt: 'Research', intervalSeconds: 1 }))).status).toBe(400);
        await store.updateSettings({ researchAllowed: false });
        expect((await app.request('/api/tasks', json({ prompt: 'Research' }))).status).toBe(403);
        expect(await store.claim()).toBeNull();
    });
    it('runs a sample job from the durable queue and retains its result', async () => {
        const { app, store, runner } = fixture();
        const response = await app.request('/api/tasks', json({ prompt: 'Plan a quiet weekend' }));
        expect(response.status).toBe(201);
        await runner.tick();
        const task = (await store.tasks('owner'))[0];
        expect(task.status).toBe('completed');
        expect((await store.detail(task.id))?.runs[0].result?.sample).toBe(true);
    });
    it('persists memory edits and deletes', async () => {
        const { app, store } = fixture();
        await app.request('/api/memories', json({ text: 'Prefer short briefs' }));
        const memory = (await store.memoryItems.active('owner'))[0]!;
        const updated = await app.request(`/api/memories/${memory.id}`, {
            ...json({ text: 'Prefer deep briefs' }),
            method: 'PUT',
        });
        expect(updated.status).toBe(200);
        expect((await store.memoryItems.active('owner'))[0]!.text).toBe('Prefer deep briefs');
        await app.request(`/api/memories/${memory.id}`, {
            ...json({}),
            method: 'DELETE',
        });
        expect(await store.memoryItems.active('owner')).toHaveLength(0);
    });
});
it('rejects DNS-rebinding Host even with a matching hostile Origin', async () => {
    const { app } = fixture();
    const response = await app.request('http://attacker.example/api/tasks', {
        ...json({ prompt: 'Sneaky task' }),
        headers: {
            'Content-Type': 'application/json',
            Origin: 'http://attacker.example',
            'Sec-Fetch-Site': 'same-origin',
        },
    });
    expect(response.status).toBe(403);
});
