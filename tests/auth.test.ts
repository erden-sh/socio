import { Hono } from 'hono';
import { expect, it } from 'vitest';

import type { AppEnv } from '@socio/foundation/http/app-env';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider, sessionRoutes } from '../src/server/auth/mock.js';
import { createSessionValue, readSessionValue, SESSION_MAX_AGE_SECONDS } from '../src/server/auth/session.js';
import { authFromEnv } from '../src/server/composition/auth.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const SECRET = 'test-session-secret-0123456789';

function app(provider = new MockAuthProvider(DEFAULT_MOCK_USERS, SECRET)) {
    const hono = new Hono<AppEnv>();
    provider.routes(hono);
    sessionRoutes(hono, provider, false);
    return { hono, provider };
}
const json = (body: unknown) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});
const cookieFrom = (response: Response) => response.headers.get('set-cookie')?.split(';')[0] ?? '';

it('signs in a mock user with an HttpOnly, SameSite=Strict session cookie', async () => {
    const { hono, provider } = app();
    const login = await hono.request('/api/auth/mock/login', json({ userId: 'bob' }));
    expect(login.status).toBe(200);
    const header = login.headers.get('set-cookie')!;
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).not.toContain('Secure');
    const request = new Request('http://localhost/', {
        headers: { cookie: cookieFrom(login) },
    });
    expect(await provider.resolve(request)).toEqual({
        id: 'bob',
        name: 'Bob',
        role: 'member',
    });
    const session = await hono.request('/api/auth/session', {
        headers: { cookie: cookieFrom(login) },
    });
    expect(await session.json()).toMatchObject({
        provider: 'mock',
        user: { id: 'bob' },
    });
});

it('rejects unknown users, tampered, foreign and expired sessions', async () => {
    const { hono, provider } = app();
    expect((await hono.request('/api/auth/mock/login', json({ userId: 'eve' }))).status).toBe(400);
    const value = createSessionValue(SECRET, 'alice');
    const [payload, signature] = value.split('.');
    const forged = Buffer.from(JSON.stringify({ uid: 'alice', iat: Math.floor(Date.now() / 1000) + 1 })).toString(
        'base64url',
    );
    for (const cookie of [
        `${forged}.${signature}`,
        `${payload}.${signature}x`,
        createSessionValue('another-secret-0123456789abc', 'alice'),
        createSessionValue(SECRET, 'eve'),
        'garbage',
    ]) {
        expect(
            await provider.resolve(
                new Request('http://localhost/', {
                    headers: { cookie: `cb_session=${cookie}` },
                }),
            ),
        ).toBeNull();
    }
    const old = Date.now() - (SESSION_MAX_AGE_SECONDS + 60) * 1000;
    expect(readSessionValue(SECRET, createSessionValue(SECRET, 'alice', old))).toBeNull();
    expect(readSessionValue(SECRET, value)).toBe('alice');
});

it('clears the session on logout', async () => {
    const { hono } = app();
    const logout = await hono.request('/api/auth/logout', json({}));
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    const session = await hono.request('/api/auth/session');
    expect(await session.json()).toEqual({ provider: 'mock', user: null });
});

it('refuses mock auth beyond loopback, with no override left', () => {
    const secret = { SESSION_SECRET: SECRET };
    expect(() => authFromEnv(secret, '0.0.0.0')).toThrow('loopback HOST');
    // The old opt-in (AUTH_MOCK_ALLOW_REMOTE with an owner token) is gone.
    expect(() =>
        authFromEnv(
            {
                ...secret,
                AUTH_MOCK_ALLOW_REMOTE: 'true',
                OWNER_TOKEN: 'x'.repeat(24),
                APP_ORIGIN: 'https://brain.example.com',
            },
            '0.0.0.0',
        ),
    ).toThrow('loopback HOST');
    // Behind a proxy on this machine: a non-loopback origin is refused too.
    expect(() => authFromEnv({ ...secret, APP_ORIGIN: 'https://brain.example.com' }, '127.0.0.1')).toThrow(
        'APP_ORIGIN',
    );
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:4310', 'http://[::1]:4310']) {
        expect(authFromEnv({ ...secret, APP_ORIGIN: origin }, '127.0.0.1').provider.kind).toBe('mock');
    }
    // Leftover settings are named, not honored.
    const leftover = authFromEnv(
        {
            ...secret,
            AUTH_MOCK_ALLOW_REMOTE: 'true',
            OWNER_TOKEN: 'x'.repeat(24),
        },
        '127.0.0.1',
    );
    expect(leftover.warnings.join(' ')).toMatch(/OWNER_TOKEN is no longer used/);
    expect(leftover.warnings.join(' ')).toMatch(/AUTH_MOCK_ALLOW_REMOTE was removed/);
    expect(leftover).not.toHaveProperty('ownerToken');
});

it('uses a per-process secret on loopback and validates MOCK_USERS', () => {
    const local = authFromEnv({}, '127.0.0.1');
    expect(local.provider.users()).toEqual(DEFAULT_MOCK_USERS);
    expect(local.secureCookies).toBe(false);
    expect(local.warnings[0]).toContain('per-process secret');
    expect(() => authFromEnv({ SESSION_SECRET: 'short' }, '127.0.0.1')).toThrow('at least 24 characters');
    expect(
        authFromEnv({ MOCK_USERS: '[{"id":"carol","name":"Carol","role":"admin"}]' }, '127.0.0.1').provider.users(),
    ).toEqual([{ id: 'carol', name: 'Carol', role: 'admin' }]);
    for (const users of [
        '[]',
        'nope',
        '[{"id":"dave","name":"Dave","role":"member"}]',
        '[{"id":"a","name":"A","role":"admin"},{"id":"a","name":"B","role":"admin"}]',
        '[{"id":"Upper","name":"U","role":"admin"}]',
        '[{"id":"eve","name":"Eve","role":"owner"}]',
    ]) {
        expect(() => authFromEnv({ MOCK_USERS: users }, '127.0.0.1')).toThrow('MOCK_USERS must be');
    }
    expect(() => authFromEnv({ AUTH_PROVIDER: 'clerk' }, '127.0.0.1')).toThrow('not supported');
});

async function server(env: Record<string, string> = {}) {
    const { app, workspace, dispose } = await makeTestRuntime({
        config: { baseUrl: 'https://model.invalid' },
        app: { auth: authFromEnv({ SESSION_SECRET: SECRET, ...env }, '127.0.0.1') },
    });
    return { app, workspace, close: dispose };
}

it('requires a signed-in user for every API route except sign-in', async () => {
    const { app, workspace, close } = await server();
    try {
        for (const path of ['/api/workspace', '/api/state', '/api/copilotkit/info', '/api/spaces/any/pages']) {
            expect((await app.request(path)).status).toBe(401);
        }
        expect((await app.request('/api/auth/mock/users')).status).toBe(200);
        const login = await app.request('/api/auth/mock/login', json({ userId: 'alice' }));
        expect(login.status).toBe(200);
        const cookie = cookieFrom(login);
        expect((await app.request('/api/workspace', { headers: { cookie } })).status).toBe(200);
        expect((await app.request('/api/copilotkit/info', { headers: { cookie } })).status).toBe(200);
        // Users are recorded the first time they are seen.
        expect(workspace.users()).toEqual([{ id: 'alice', name: 'Alice', role: 'admin' }]);
    } finally {
        await close();
    }
});

it('honours no owner token: OWNER_TOKEN neither gates nor unlocks', async () => {
    const token = 't'.repeat(24);
    const { app, close } = await server({ OWNER_TOKEN: token });
    try {
        // No gate in front of sign-in.
        expect((await app.request('/api/auth/mock/users')).status).toBe(200);
        // The token is no credential: the API still asks for sign-in.
        const state = await app.request('/api/state', {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(state.status).toBe(401);
        expect(await state.json()).toMatchObject({ code: 'sign_in' });
    } finally {
        await close();
    }
});

it('answers mock sign-in only on this machine: no proxy, no other peer', async () => {
    const { app, close } = await server();
    const peer = (remoteAddress: string) => ({
        incoming: { socket: { remoteAddress } },
    });
    try {
        for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
            expect((await app.request('/api/auth/mock/users', {}, peer(address))).status).toBe(200);
        }
        for (const address of ['10.0.0.5', '::ffff:192.168.1.9', '172.17.0.1']) {
            expect((await app.request('/api/auth/mock/users', {}, peer(address))).status).toBe(403);
        }
        // A proxy on this machine forwarding someone else's request.
        for (const header of ['x-forwarded-for', 'forwarded', 'x-real-ip']) {
            const login = await app.request(
                '/api/auth/mock/login',
                {
                    ...json({ userId: 'alice' }),
                    headers: {
                        'Content-Type': 'application/json',
                        [header]: '203.0.113.7',
                    },
                },
                peer('127.0.0.1'),
            );
            expect(login.status).toBe(403);
            expect(login.headers.get('set-cookie')).toBeNull();
        }
    } finally {
        await close();
    }
});

it('deploys with Better Auth and nothing of the owner token', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    for (const path of ['.docker/compose.yml', '.env.example']) {
        const text = read(path);
        expect(text, path).not.toMatch(/OWNER_TOKEN|owner_token|AUTH_MOCK_ALLOW_REMOTE/);
        expect(text, path).not.toMatch(/MOCK_USERS:/);
    }
    expect(read('.docker/compose.yml')).toContain('AUTH_PROVIDER: betterauth');
});
