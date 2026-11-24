import { afterEach, expect, it } from 'vitest';

import { roomsSettingsFromEnv } from '@socio/foundation/rooms/settings';
import type { RoomsReadiness, RoomsSettings } from '@socio/shared/rooms/rooms';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// Settings → General → Rooms (CB-207): an admin's switch over ROOMS_ENABLED,
// off by default, and the reconcile admins read first.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture(rooms?: Partial<RoomsSettings>) {
    const { store, workspace, app, dispose } = await makeTestRuntime({
        config: { apiKey: '', model: '', rooms },
        app: {
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'rooms-secret-0123456789abcdef0'),
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
    return { store, workspace, alice: await as('alice'), bob: await as('bob') };
}

const inForce = async (request: (path: string) => Response | Promise<Response>) =>
    (
        (await (await request('/api/state')).json()) as {
            settings: { rooms: unknown };
        }
    ).settings.rooms;

it('keeps Rooms off until an admin turns them on, over the environment’s', async () => {
    const f = await fixture();
    // Off by default, for everyone to read.
    expect(await inForce(f.bob)).toEqual({
        enabled: false,
        budgetVisible: false,
    });
    const on = { rooms: { enabled: true } };
    expect((await f.bob('/api/settings', 'PATCH', on)).status).toBe(403);
    expect(f.store.settings().rooms).toBeUndefined();
    for (const bad of [{ rooms: { enabled: 'yes' } }, { rooms: { enabled: true, perDay: 1 } }, { rooms: true }]) {
        expect((await f.alice('/api/settings', 'PATCH', bad)).status).toBe(400);
    }
    expect((await f.alice('/api/settings', 'PATCH', on)).status).toBe(200);
    expect(f.store.settings().rooms).toEqual({ enabled: true });
    expect(await inForce(f.bob)).toEqual({ enabled: true, budgetVisible: false });
    expect((await f.alice('/api/settings', 'PATCH', { rooms: { enabled: false } })).status).toBe(200);
    expect(await inForce(f.bob)).toEqual({
        enabled: false,
        budgetVisible: false,
    });

    // ROOMS_ENABLED is the starting value, until an admin saves one.
    const env = await fixture({ enabled: true });
    expect(await inForce(env.bob)).toEqual({
        enabled: true,
        budgetVisible: false,
    });
    await env.alice('/api/settings', 'PATCH', { rooms: { enabled: false } });
    expect(await inForce(env.bob)).toEqual({
        enabled: false,
        budgetVisible: false,
    });
});

it('lets admins choose whether members see rooms’ use, over ROOMS_BUDGET_VISIBLE (CB-218)', async () => {
    const f = await fixture();
    const show = { rooms: { budgetVisible: true } };
    expect((await f.bob('/api/settings', 'PATCH', show)).status).toBe(403);
    expect(
        (
            await f.alice('/api/settings', 'PATCH', {
                rooms: { budgetVisible: 'yes' },
            })
        ).status,
    ).toBe(400);
    expect((await f.alice('/api/settings', 'PATCH', show)).status).toBe(200);
    // Saved apart: turning Rooms on later keeps the choice, and the other way.
    await f.alice('/api/settings', 'PATCH', { rooms: { enabled: true } });
    expect(f.store.settings().rooms).toEqual({
        budgetVisible: true,
        enabled: true,
    });
    expect(await inForce(f.bob)).toEqual({ enabled: true, budgetVisible: true });

    // The environment's is the starting value, until an admin saves one.
    const env = await fixture({ budgetVisible: true });
    expect(await inForce(env.bob)).toEqual({
        enabled: false,
        budgetVisible: true,
    });
    await env.alice('/api/settings', 'PATCH', {
        rooms: { budgetVisible: false },
    });
    expect(await inForce(env.bob)).toEqual({
        enabled: false,
        budgetVisible: false,
    });
    expect(roomsSettingsFromEnv({ ROOMS_BUDGET_VISIBLE: 'yes' })).toEqual({
        enabled: false,
        budgetVisible: true,
    });
    expect(roomsSettingsFromEnv({})).toEqual({
        enabled: false,
        budgetVisible: false,
    });
});

it('shows admins, and only admins, that every chat is private before Rooms go on', async () => {
    const f = await fixture();
    const dot = f.workspace.companyDots()[0]!.id;
    f.workspace.bindThread('a1', dot, 'Mine', 'alice');
    f.workspace.bindThread('b1', dot, 'Bob’s', 'bob');
    expect((await f.bob('/api/rooms/readiness')).status).toBe(403);
    const response = await f.alice('/api/rooms/readiness');
    expect(response.status).toBe(200);
    expect((await response.json()) as RoomsReadiness).toEqual({
        enabled: false,
        conversations: { private: 2, room: 0 },
        allPrivate: true,
    });
    await f.alice('/api/settings', 'PATCH', { rooms: { enabled: true } });
    expect(((await (await f.alice('/api/rooms/readiness')).json()) as RoomsReadiness).enabled).toBe(true);
    // Nothing in this slice makes a room, and the chat lists are as before.
    const workspace = (await (await f.bob('/api/workspace')).json()) as {
        conversations: Array<{ id: string; kind?: string }>;
    };
    expect(workspace.conversations.map(({ id, kind }) => ({ id, kind }))).toEqual([{ id: 'b1', kind: 'private' }]);
});
