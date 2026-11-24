import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { INSTALL_HEADER } from '@socio/shared/device-sign-in';

import { isPushRevocationKey, NO_PUSH, type Registry, type Store, wipe, workspaceKeyName } from '../../src/data';
import { LEASE_LOCK_MS } from '../../src/data/lease';
import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { memoryJarStore, openCookieJar } from '../../src/net/cookie-jar';
import type { FetchFunction } from '../../src/net/fetch-function';
import { createRelayFetch } from '../../src/net/relay-fetch';
import {
    badgeCount,
    type BadgeScopes,
    CHANNELS_PATH,
    createPushManager,
    createRelayClient,
    followBadge,
    type PushManager,
    type PushNative,
    type PushPermission,
    type PushScope,
    retryPushRevocations,
    SUBSCRIPTIONS_PATH,
} from '../../src/push';
import { openWorkspaceScope } from '../../src/sync/scope';
import { endFakeTime, fakeTime } from '../helpers/fake-time';
import { type AddedWorkspace, addWorkspace, launch, nodeRandomBytes, phone, type Phone } from '../helpers/store';
import { httpDate, sessionSetCookie } from '../net/helpers';
import { fakeAppState, fakeNetwork } from '../sync/fakes';

// Registering and keeping push subscriptions, against a fake relay
// (apps/push-relay's API) and a fake Socio server per workspace, over a real
// store: every keepalive branch, a kill after each persisted step, three
// workspaces, permission taken back, and no personal data to the relay.

const RELAY = 'https://relay.example.test';
const USER_AGENT = 'Socio/0.1.0 (Android; Android 16)';
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 9, 9, 0, 0);
const TOKEN = 'fcm-token-aaaaaaaaaaaaaaaaaaaaaaaa';
const APP = { platform: 'android', bundleId: 'com.ingenioventures.socio.dev', apnsEnv: null } as const;

class Killed extends Error {}

/** apps/push-relay's app API, kept in memory, with a log of every request as sent. */
function fakeRelay({ timeoutMs, origin = RELAY }: { timeoutMs?: number; origin?: string } = {}) {
    const registrations = new Map<string, { secret: string; token: string; vapidKey: string }>();
    const requests: { method: string; url: string; headers: Record<string, string>; body: string }[] = [];
    const state = {
        offline: false,
        loseAnswer: false,
        /** While set, a registration waits for it before the relay answers. */
        hold: null as Promise<void> | null,
        /** Called as a registration starts to wait for `hold`. */
        onHold: null as (() => void) | null,
    };
    const fetch = async (url: string, init: { method?: string; headers?: unknown; body?: unknown }) => {
        const body = String(init.body);
        requests.push({ method: init.method ?? 'GET', url, headers: init.headers as Record<string, string>, body });
        if (state.offline) {
            throw new TypeError('Network request failed');
        }
        if (state.hold !== null && init.method === 'POST') {
            state.onHold?.();
            await state.hold;
        }
        const input = JSON.parse(body) as Record<string, string>;
        const path = new URL(url).pathname;
        let status = 400;
        let answer: unknown = null;
        if (init.method === 'POST' && path === '/v1/registrations') {
            const kept = registrations.get(input.id!);
            if (!kept) {
                registrations.set(input.id!, {
                    secret: input.secret!,
                    token: input.nativeToken!,
                    vapidKey: input.vapidKey!,
                });
                status = 201;
            } else if (kept.secret !== input.secret) {
                status = 403;
            } else if (kept.vapidKey !== input.vapidKey) {
                status = 409;
            } else {
                kept.token = input.nativeToken!;
                status = 200;
            }
            answer = status < 300 ? { endpoint: `${origin}/v1/push/${input.id}` } : { error: 'x' };
        } else {
            const id = decodeURIComponent(path.slice('/v1/registrations/'.length));
            const kept = registrations.get(id);
            status = !kept ? 410 : kept.secret !== input.secret ? 403 : 204;
            // The relay's own 403 is a JSON problem (apps/push-relay/src/relay.ts).
            answer = status === 403 ? { error: 'secret' } : null;
            if (status === 204 && init.method === 'PUT' && input.nativeToken) {
                kept!.token = input.nativeToken;
            }
            if (status === 204 && init.method === 'DELETE') {
                registrations.delete(id);
            }
        }
        if (state.loseAnswer) {
            state.loseAnswer = false;
            throw new TypeError('Network request failed');
        }
        return new Response(answer === null ? null : JSON.stringify(answer), { status });
    };
    const client = createRelayClient(
        createRelayFetch({ fetch: fetch as never, userAgent: USER_AGENT, origin, timeoutMs }),
        origin,
    );
    return { client, registrations, requests, state };
}

/** A Socio server's notification routes for one person, in memory. */
function fakeServer(pushKey = 'BServerKey') {
    const subscriptions = new Map<string, { id: string; p256dh: string }>();
    const requests: { path: string; init: AuthedRequestInit }[] = [];
    const state = { pushKey, refuseHosts: false, offline: false, loseAnswer: false, drop: false };
    let next = 1;
    const fetch: AuthedFetch = async (path, init = {}) => {
        requests.push({ path, init });
        if (state.offline) {
            throw new TypeError('offline');
        }
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
        if (path === CHANNELS_PATH) {
            const targets = [...subscriptions.values()].map(({ id }) => ({ id, label: 'Socio app on Android' }));
            return json(200, {
                channels: [{ id: 'push', label: 'Push', enabled: true, content: 'message', targets }],
                pushKey: state.pushKey,
            });
        }
        if (path === SUBSCRIPTIONS_PATH && init.method === 'POST') {
            if (state.refuseHosts) {
                return json(400, { error: 'This browser’s push service is not one Socio sends to.' });
            }
            const body = init.json as { endpoint: string; keys: { p256dh: string } };
            const id = subscriptions.get(body.endpoint)?.id ?? `sub-${next++}`;
            subscriptions.set(body.endpoint, { id, p256dh: body.keys.p256dh });
            if (state.loseAnswer) {
                state.loseAnswer = false;
                throw new TypeError('offline');
            }
            return json(201, { id, label: 'Socio app on Android' });
        }
        if (path.startsWith(`${SUBSCRIPTIONS_PATH}/`) && init.method === 'DELETE') {
            const id = decodeURIComponent(path.slice(SUBSCRIPTIONS_PATH.length + 1));
            let found = false;
            for (const [endpoint, row] of subscriptions) {
                if (row.id === id) {
                    subscriptions.delete(endpoint);
                    found = true;
                }
            }
            if (state.loseAnswer) {
                state.loseAnswer = false;
                throw new TypeError('offline');
            }
            return found ? json(200, { ok: true }) : json(404, { error: 'Not found' });
        }
        return json(404, {});
    };
    return { fetch, subscriptions, requests, state };
}

/** socio-push in memory. */
function fakeNative(canRegister = true) {
    const keys = new Map<string, { p256dh: string; auth: string }>();
    const index = new Map<string, string>();
    const flags = new Map<string, { locked?: boolean; leaseLockAt?: number | null }>();
    const calls: string[] = [];
    let made = 0;
    const native: PushNative = {
        canRegister: async () => canRegister,
        getKeys: async (id) => keys.get(id) ?? null,
        deleteKeys: async (id) => {
            keys.delete(id);
            flags.delete(id);
            for (const [registration, workspace] of index) {
                if (workspace === id) {
                    index.delete(registration);
                }
            }
            calls.push(`deleteKeys ${id.slice(0, 6)}`);
        },
        createKeys: async (id) => {
            const pair = { p256dh: `p256dh-${++made}`, auth: `auth-${made}` };
            keys.set(id, pair);
            calls.push(`createKeys ${id.slice(0, 6)}`);
            return pair;
        },
        setRegistration: async (registration, workspace) => {
            index.set(registration, workspace);
        },
        deleteRegistration: async (registration) => {
            index.delete(registration);
        },
        setLocked: async (id, locked) => {
            flags.set(id, { ...flags.get(id), locked });
            calls.push(`setLocked ${id.slice(0, 6)} ${locked}`);
        },
        setLeaseLockAt: async (id, at) => {
            flags.set(id, { ...flags.get(id), leaseLockAt: at });
            calls.push(`setLeaseLockAt ${id.slice(0, 6)}`);
        },
        setShowText: async (show) => {
            calls.push(`setShowText ${show}`);
        },
    };
    return { native, keys, index, flags, calls };
}

let device: Phone;
const stores: Store[] = [];

beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-push-')));
});
afterEach(async () => {
    for (const store of stores.splice(0)) {
        await store.registry.close().catch(() => {});
    }
    rmSync(device.root, { recursive: true, force: true });
});

interface Bench {
    store: Store;
    relay: ReturnType<typeof fakeRelay>;
    native: ReturnType<typeof fakeNative>;
    phone: { permission: PushPermission; token: string };
    clock: { now: number };
    manager(options?: {
        registry?: Registry;
        relay?: boolean;
        canRegister?: boolean;
        forgetWaitMs?: number;
    }): PushManager;
}

async function bench({ relayTimeoutMs }: { relayTimeoutMs?: number } = {}): Promise<Bench> {
    const { store } = await launch(device);
    stores.push(store);
    const relay = fakeRelay({ timeoutMs: relayTimeoutMs });
    const native = fakeNative();
    const phoneState = { permission: 'granted' as PushPermission, token: TOKEN };
    const clock = { now: T0 };
    return {
        store,
        relay,
        native,
        phone: phoneState,
        clock,
        manager: ({
            registry = store.registry,
            relay: withRelay = true,
            canRegister = true,
            forgetWaitMs,
        }: Parameters<Bench['manager']>[0] = {}) =>
            createPushManager({
                store: { ...store, registry },
                native: canRegister ? native.native : { ...native.native, canRegister: async () => false },
                notifications: {
                    permission: async () => phoneState.permission,
                    nativeToken: async () => phoneState.token,
                },
                relay: withRelay ? relay.client : null,
                relayOrigin: withRelay ? RELAY : null,
                app: APP,
                randomBytes: nodeRandomBytes,
                now: () => clock.now,
                forgetWaitMs,
            }),
    };
}

const scopeOf = (workspace: AddedWorkspace, server: ReturnType<typeof fakeServer>): PushScope => ({
    workspaceId: workspace.id,
    name: 'Acme',
    fetch: server.fetch,
});

describe('registering', () => {
    it('registers at the relay, then subscribes with installed: true, keeping each answer in order', async () => {
        const b = await bench();
        const ada = await addWorkspace(b.store, 'https://brain.example.test', 'u-ada');
        const server = fakeServer();
        const status = await b.manager().ensure(scopeOf(ada, server));

        expect(status).toEqual({ kind: 'subscribed', subscriptionId: 'sub-1' });
        expect(b.relay.registrations.size).toBe(1);
        const [id, registration] = [...b.relay.registrations][0]!;
        expect(registration).toMatchObject({ token: TOKEN, vapidKey: 'BServerKey' });
        expect(id).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
        expect(registration.secret).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
        expect(JSON.parse(b.relay.requests[0]!.body)).toEqual({
            id,
            secret: registration.secret,
            platform: 'android',
            bundleId: 'com.ingenioventures.socio.dev',
            apnsEnv: null,
            nativeToken: TOKEN,
            vapidKey: 'BServerKey',
        });
        expect(server.requests.map(({ path, init }) => [init.method ?? 'GET', path])).toEqual([
            ['GET', CHANNELS_PATH],
            ['POST', SUBSCRIPTIONS_PATH],
        ]);
        expect(server.requests[1]!.init.json).toEqual({
            endpoint: `${RELAY}/v1/push/${id}`,
            keys: b.native.keys.get(ada.id),
            installed: true,
        });
        expect(await b.store.registry.push(ada.id)).toEqual({
            registrationId: id,
            pushKey: 'BServerKey',
            nativeToken: TOKEN,
            subscriptionId: 'sub-1',
        });
        expect(b.native.index.get(id)).toBe(ada.id);
        // The extension can tell a lock from the lease from the first push on.
        expect(b.native.flags.get(ada.id)).toEqual({ locked: false, leaseLockAt: expect.any(Number) });
    });

    it('sends nothing personal to the relay: no cookie, Origin, workspace origin, email, name or user id', async () => {
        const b = await bench();
        const ada = await addWorkspace(b.store, 'https://brain.example.test', 'u-ada');
        const manager = b.manager();
        await manager.ensure(scopeOf(ada, fakeServer()));
        b.phone.token = 'fcm-token-bbbbbbbbbbbbbbbbbbbbbbbb';
        await manager.keepalive();
        b.phone.permission = 'denied';
        await manager.keepalive();
        expect(b.relay.requests.map(({ method }) => method)).toEqual(['POST', 'PUT', 'DELETE']);
        for (const request of b.relay.requests) {
            expect(Object.keys(request.headers).sort()).toEqual(['cache-control', 'content-type', 'user-agent']);
            expect(request.headers['user-agent']).toBe(USER_AGENT);
            expect(request.url.startsWith(`${RELAY}/v1/registrations`)).toBe(true);
            const text = `${request.url} ${request.body}`;
            for (const personal of ['brain.example.test', 'u-ada', 'ada@example.test', 'Acme', ada.id]) {
                expect(text).not.toContain(personal);
            }
        }
    });

    it('gives three workspaces a registration and a subscription each', async () => {
        const b = await bench();
        const manager = b.manager();
        const ids = new Set<string>();
        for (const [origin, user] of [
            ['https://a.example.test', 'u-a'],
            ['https://b.example.test', 'u-b'],
            ['https://c.example.test', 'u-c'],
        ] as const) {
            const workspace = await addWorkspace(b.store, origin, user);
            const server = fakeServer(`BKey-${user}`);
            expect(await manager.ensure(scopeOf(workspace, server))).toMatchObject({ kind: 'subscribed' });
            expect(server.subscriptions.size).toBe(1);
            const push = await b.store.registry.push(workspace.id);
            expect(push?.pushKey).toBe(`BKey-${user}`);
            ids.add(push!.registrationId!);
        }
        expect(ids.size).toBe(3);
        expect(b.relay.registrations.size).toBe(3);
        expect(new Set(b.native.index.values()).size).toBe(3);
    });

    it('checks an open workspace again only once a day unless asked', async () => {
        const b = await bench();
        const ada = await addWorkspace(b.store, 'https://brain.example.test', 'u-ada');
        const server = fakeServer();
        const manager = b.manager();
        await manager.ensure(scopeOf(ada, server));
        await manager.ensure(scopeOf(ada, server));
        expect(server.requests).toHaveLength(2);
        b.clock.now += DAY;
        await manager.ensure(scopeOf(ada, server));
        // Again, idempotent by endpoint: the same subscription, the same registration.
        expect(server.requests.map(({ path }) => path)).toEqual([
            CHANNELS_PATH,
            SUBSCRIPTIONS_PATH,
            CHANNELS_PATH,
            SUBSCRIPTIONS_PATH,
        ]);
        expect(server.subscriptions.size).toBe(1);
        expect(b.relay.requests).toHaveLength(1);
        await manager.ensure(scopeOf(ada, server), { force: true });
        expect(server.requests).toHaveLength(6);
    });

    it('makes a fresh registration when the server’s key changes, deleting the old one at the relay', async () => {
        const b = await bench();
        const ada = await addWorkspace(b.store, 'https://brain.example.test', 'u-ada');
        const server = fakeServer();
        const manager = b.manager();
        await manager.ensure(scopeOf(ada, server));
        const first = (await b.store.registry.push(ada.id))!.registrationId!;
        const firstKeys = b.native.keys.get(ada.id);
        server.state.pushKey = 'BNewKey';
        expect(await manager.ensure(scopeOf(ada, server), { force: true })).toMatchObject({ kind: 'subscribed' });
        const push = (await b.store.registry.push(ada.id))!;
        expect(push.registrationId).not.toBe(first);
        expect(push.pushKey).toBe('BNewKey');
        expect([...b.relay.registrations.keys()]).toEqual([push.registrationId]);
        expect(b.native.index.has(first)).toBe(false);
        expect(b.native.keys.get(ada.id)).not.toEqual(firstKeys);
    });

    it('makes a fresh registration when the push channel no longer lists this subscription', async () => {
        const b = await bench();
        const ada = await addWorkspace(b.store, 'https://brain.example.test', 'u-ada');
        const server = fakeServer();
        const manager = b.manager();
        await manager.ensure(scopeOf(ada, server));
        const first = (await b.store.registry.push(ada.id))!.registrationId!;
        // The server dropped it (a 410 from the relay while the token was gone, or a person's delete on the web).
        server.subscriptions.clear();
        expect(await manager.ensure(scopeOf(ada, server), { force: true })).toEqual({
            kind: 'subscribed',
            subscriptionId: 'sub-2',
        });
        expect((await b.store.registry.push(ada.id))!.registrationId).not.toBe(first);
        expect(b.relay.registrations.size).toBe(1);
        expect(server.subscriptions.size).toBe(1);
    });

    it('says when the server’s push hosts don’t take the relay (400)', async () => {
        const b = await bench();
        const ada = await addWorkspace(b.store, 'https://brain.example.test', 'u-ada');
        const server = fakeServer();
        server.state.refuseHosts = true;
        const manager = b.manager();
        expect(await manager.ensure(scopeOf(ada, server))).toEqual({ kind: 'host-not-allowed' });
        expect(manager.status(ada.id)).toEqual({ kind: 'host-not-allowed' });
        expect((await b.store.registry.push(ada.id))?.subscriptionId).toBeNull();
    });

    it('takes a new id when the relay says the one kept is someone else’s', async () => {
        const b = await bench();
        const ada = await addWorkspace(b.store, 'https://brain.example.test', 'u-ada');
        const kept = JSON.parse((await b.store.keys.read(workspaceKeyName(ada.id, 'relay')))!) as { id: string };
        b.relay.registrations.set(kept.id, { secret: 'x'.repeat(43), token: 'other', vapidKey: 'BServerKey' });
        expect(await b.manager().ensure(scopeOf(ada, fakeServer()))).toMatchObject({ kind: 'subscribed' });
        expect((await b.store.registry.push(ada.id))!.registrationId).not.toBe(kept.id);
        expect(b.relay.registrations.get(kept.id)?.token).toBe('other');
    });

    it('never registers in a Personal Team build, or one with no relay, and says why', async () => {
        const b = await bench();
        const ada = await addWorkspace(b.store, 'https://brain.example.test', 'u-ada');
        const server = fakeServer();
        const personal = b.manager({ canRegister: false });
        expect(await personal.ensure(scopeOf(ada, server))).toEqual({ kind: 'build' });
        await personal.keepalive(scopeOf(ada, server));
        await personal.syncFlags();
        await personal.syncShowText();
        const unrelayed = b.manager({ relay: false });
        expect(await unrelayed.ensure(scopeOf(ada, server))).toEqual({ kind: 'no-relay' });
        expect(server.requests).toEqual([]);
        expect(b.relay.requests).toEqual([]);
        expect(b.native.calls).toEqual([]);
        expect(await b.store.registry.push(ada.id)).toEqual(NO_PUSH);
    });

    it('asks nothing while notifications aren’t allowed, or the phone gives no token', async () => {
        const b = await bench();
        const ada = await addWorkspace(b.store, 'https://brain.example.test', 'u-ada');
        const server = fakeServer();
        b.phone.permission = 'undetermined';
        expect(await b.manager().ensure(scopeOf(ada, server))).toEqual({ kind: 'no-permission' });
        b.phone.permission = 'granted';
        const manager = createPushManager({
            store: b.store,
            native: b.native.native,
            notifications: {
                permission: async () => 'granted',
                nativeToken: () => Promise.reject(new Error('no Firebase in this build')),
            },
            relay: b.relay.client,
            relayOrigin: RELAY,
            app: APP,
            randomBytes: nodeRandomBytes,
            now: () => T0,
        });
        expect(await manager.ensure(scopeOf(ada, server))).toEqual({ kind: 'no-token' });
        expect(server.requests).toEqual([]);
        expect(b.relay.requests).toEqual([]);
    });
});

describe('a kill after each persisted step', () => {
    /** A registry whose `setPush` dies on its `nth` call (before writing), as a kill there would. */
    const dyingRegistry = (registry: Registry, nth: number): Registry => {
        let calls = 0;
        return {
            ...registry,
            setPush: async (id, change) => {
                if (++calls === nth) {
                    throw new Killed('killed');
                }
                return registry.setPush(id, change);
            },
        };
    };

    const cases: [string, (b: Bench, server: ReturnType<typeof fakeServer>) => Registry | undefined][] = [
        ['the credentials, before the relay answered', (b) => void (b.relay.state.offline = true)],
        ['the relay kept it but its answer was lost', (b) => void (b.relay.state.loseAnswer = true)],
        ['the relay answered, before it was kept', (b) => dyingRegistry(b.store.registry, 1)],
        ['the registration was kept, before the subscribe', (_, server) => void (server.state.offline = true)],
        ['the server subscribed but its answer was lost', (_, server) => void (server.state.loseAnswer = true)],
        ['the server answered, before its id was kept', (b) => dyingRegistry(b.store.registry, 2)],
    ];

    it.each(cases)('after %s, the next run ends with one registration and one subscription', async (_, kill) => {
        const b = await bench();
        const ada = await addWorkspace(b.store, 'https://brain.example.test', 'u-ada');
        const server = fakeServer();
        const registry = kill(b, server);
        await b
            .manager({ registry })
            .ensure(scopeOf(ada, server))
            .catch((error: unknown) => {
                expect(error).toBeInstanceOf(Killed);
            });
        b.relay.state.offline = false;
        server.state.offline = false;

        // The next launch: a new manager over what the store kept.
        expect(await b.manager().ensure(scopeOf(ada, server))).toMatchObject({ kind: 'subscribed' });
        expect(b.relay.registrations.size).toBe(1);
        expect(server.subscriptions.size).toBe(1);
        const push = (await b.store.registry.push(ada.id))!;
        expect([...b.relay.registrations.keys()]).toEqual([push.registrationId]);
        expect(push.subscriptionId).toBe([...server.subscriptions.values()][0]!.id);
    });
});

describe('a new relay origin', () => {
    const A = 'https://relay-a.example.test';
    const B = 'https://relay-b.example.test';

    /** One phone and two relays: a build is its relay origin, A, B or none. */
    async function twoRelays() {
        const { store } = await launch(device);
        stores.push(store);
        const relays: Record<string, ReturnType<typeof fakeRelay>> = {
            [A]: fakeRelay({ origin: A }),
            [B]: fakeRelay({ origin: B }),
        };
        const native = fakeNative();
        const relayAt = (origin: string) => relays[origin]?.client ?? null;
        const build = (origin: string | null, registry: Registry = store.registry) =>
            createPushManager({
                store: { ...store, registry },
                native: native.native,
                notifications: { permission: async () => 'granted', nativeToken: async () => TOKEN },
                relay: origin === null ? null : relayAt(origin),
                relayOrigin: origin,
                relayAt,
                app: APP,
                randomBytes: nodeRandomBytes,
                now: () => T0,
            });
        const records = async () => (await store.keys.indexed()).filter(isPushRevocationKey);
        /** The platform's retry: each record at its own relay. */
        const retry = () => retryPushRevocations(store.keys, (origin) => (origin === null ? null : relayAt(origin)));
        const kept = async (id: string) => JSON.parse((await store.keys.read(workspaceKeyName(id, 'relay')))!);
        return { store, a: relays[A]!, b: relays[B]!, native, build, records, retry, kept };
    }

    /** A registry whose `setPush` dies on its `nth` call (before writing), as a kill there would. */
    const dyingRegistry = (registry: Registry, nth: number): Registry => {
        let calls = 0;
        return {
            ...registry,
            setPush: async (id, change) => {
                if (++calls === nth) {
                    throw new Killed('killed');
                }
                return registry.setPush(id, change);
            },
        };
    };

    type Phone2 = Awaited<ReturnType<typeof twoRelays>>;

    /** Ends with exactly one registration, at `origin`'s relay, and one subscription to it; none at the other. */
    async function onlyAt(p: Phone2, workspace: AddedWorkspace, server: ReturnType<typeof fakeServer>, origin: string) {
        const push = (await p.store.registry.push(workspace.id))!;
        const [here, there] = origin === A ? [p.a, p.b] : [p.b, p.a];
        expect([...here.registrations.keys()]).toEqual([push.registrationId]);
        expect(there.registrations.size).toBe(0);
        expect([...server.subscriptions.keys()]).toEqual([`${origin}/v1/push/${push.registrationId}`]);
        expect(push.subscriptionId).toBe([...server.subscriptions.values()][0]!.id);
        expect(await p.kept(workspace.id)).toMatchObject({ id: push.registrationId, origin });
        expect([...p.native.index]).toEqual([[push.registrationId, workspace.id]]);
        expect(await p.records()).toEqual([]);
    }

    it('records the relay origin each registration was made at', async () => {
        const p = await twoRelays();
        const ada = await addWorkspace(p.store, 'https://brain.example.test', 'u-ada');
        const server = fakeServer();
        expect(await p.build(A).ensure(scopeOf(ada, server))).toMatchObject({ kind: 'subscribed' });
        await onlyAt(p, ada, server, A);
    });

    it('moves to the new relay: revokes at the old one, deletes the old subscription, registers and subscribes anew', async () => {
        const p = await twoRelays();
        const ada = await addWorkspace(p.store, 'https://brain.example.test', 'u-ada');
        const server = fakeServer();
        await p.build(A).ensure(scopeOf(ada, server));
        const old = (await p.store.registry.push(ada.id))!;

        const next = p.build(B);
        // The keepalive refreshes a registration made at another relay there, until its
        // workspace's ensure retires it: its secret never goes to the new relay.
        await next.keepalive(null);
        expect(p.b.requests).toEqual([]);
        expect(p.a.requests.map(({ method, url }) => [method, url])).toEqual([
            ['POST', `${A}/v1/registrations`],
            ['PUT', `${A}/v1/registrations/${old.registrationId}`],
        ]);
        expect(await p.store.registry.push(ada.id)).toEqual(old);

        expect(await next.ensure(scopeOf(ada, server))).toMatchObject({ kind: 'subscribed' });
        expect(server.requests.map(({ path, init }) => [init.method ?? 'GET', path])).toEqual([
            ['GET', CHANNELS_PATH],
            ['POST', SUBSCRIPTIONS_PATH],
            ['DELETE', `${SUBSCRIPTIONS_PATH}/${old.subscriptionId}`],
            ['GET', CHANNELS_PATH],
            ['POST', SUBSCRIPTIONS_PATH],
        ]);
        expect(p.a.requests.map(({ method, url }) => [method, url])).toEqual([
            ['POST', `${A}/v1/registrations`],
            ['PUT', `${A}/v1/registrations/${old.registrationId}`],
            ['DELETE', `${A}/v1/registrations/${old.registrationId}`],
        ]);
        // Fresh Web Push keys for the new subscription.
        expect(p.native.calls.filter((call) => call.startsWith('createKeys'))).toHaveLength(2);
        await onlyAt(p, ada, server, B);
        // A token change goes to the new relay alone from then on.
        await next.keepalive(null, { token: 'fcm-token-cccccccccccccccccccccccc' });
        expect(p.b.requests.map(({ method }) => method)).toEqual(['POST', 'PUT']);
        expect(p.a.requests).toHaveLength(3);
    });

    it('keeps a workspace nobody opens alive at its old relay: a token change goes to A, nothing to B', async () => {
        const p = await twoRelays();
        const ada = await addWorkspace(p.store, 'https://brain.example.test', 'u-ada');
        const bob = await addWorkspace(p.store, 'https://other.example.test', 'u-bob');
        const adaServer = fakeServer();
        const bobServer = fakeServer();
        const first = p.build(A);
        await first.ensure(scopeOf(ada, adaServer));
        await first.ensure(scopeOf(bob, bobServer));
        await first.keepalive(null);
        const bobs = (await p.store.registry.push(bob.id))!;
        const bobCreds = await p.kept(bob.id);

        // A build with B: only Ada's workspace is opened.
        const next = p.build(B);
        expect(await next.ensure(scopeOf(ada, adaServer))).toMatchObject({ kind: 'subscribed' });
        const before = p.a.requests.length;
        const token = 'fcm-token-dddddddddddddddddddddddd';
        await next.keepalive(null, { token });

        const sent = p.a.requests.slice(before);
        expect(sent.map(({ method, url }) => [method, url])).toEqual([
            ['PUT', `${A}/v1/registrations/${bobs.registrationId}`],
        ]);
        expect(JSON.parse(sent[0]!.body)).toEqual({ secret: bobCreds.secret, nativeToken: token });
        expect(p.a.registrations.get(bobs.registrationId!)!.token).toBe(token);
        expect(
            p.b.requests.some(({ url, body }) => url.includes(bobs.registrationId!) || body.includes(bobCreds.secret)),
        ).toBe(false);
        expect(await p.store.registry.push(bob.id)).toEqual({ ...bobs, nativeToken: token });
        expect(await p.kept(bob.id)).toMatchObject({ origin: A });
        expect(bobServer.requests.filter(({ init }) => init.method === 'DELETE')).toEqual([]);
    });

    it('a keepalive at the old relay that answers 410 forgets it there; its workspace registers at the new one when opened', async () => {
        const p = await twoRelays();
        const bob = await addWorkspace(p.store, 'https://other.example.test', 'u-bob');
        const server = fakeServer();
        await p.build(A).ensure(scopeOf(bob, server));
        const bobs = (await p.store.registry.push(bob.id))!;
        p.a.registrations.delete(bobs.registrationId!);

        const next = p.build(B);
        await next.keepalive(null, { token: 'fcm-token-eeeeeeeeeeeeeeeeeeeeeeee' });
        expect(p.b.requests).toEqual([]);
        expect((await p.store.registry.push(bob.id))!.registrationId).toBeNull();
        expect(await next.ensure(scopeOf(bob, server))).toMatchObject({ kind: 'subscribed' });
        expect(p.b.registrations.size).toBe(1);
    });

    const kills: [string, (p: Phone2, server: ReturnType<typeof fakeServer>) => Registry | undefined][] = [
        ['the server didn’t answer the old subscription’s DELETE', (_, server) => void (server.state.offline = true)],
        ['the server deleted it but its answer was lost', (_, server) => void (server.state.loseAnswer = true)],
        [
            'the old subscription was deleted, before the registration was forgotten',
            (p) => dyingRegistry(p.store.registry, 1),
        ],
        ['the old relay didn’t answer the revocation', (p) => void (p.a.state.offline = true)],
        ['the new relay didn’t answer', (p) => void (p.b.state.offline = true)],
        ['the new relay kept it but its answer was lost', (p) => void (p.b.state.loseAnswer = true)],
        ['the new relay answered, before it was kept', (p) => dyingRegistry(p.store.registry, 2)],
        ['the server subscribed, before its id was kept', (p) => dyingRegistry(p.store.registry, 3)],
    ];

    it.each(kills)('after %s, the next run ends at the new relay alone', async (_, kill) => {
        const p = await twoRelays();
        const ada = await addWorkspace(p.store, 'https://brain.example.test', 'u-ada');
        const server = fakeServer();
        await p.build(A).ensure(scopeOf(ada, server));
        const registry = kill(p, server);
        await p
            .build(B, registry)
            .ensure(scopeOf(ada, server))
            .catch((error: unknown) => {
                expect(error).toBeInstanceOf(Killed);
            });
        server.state.offline = false;
        p.a.state.offline = false;
        p.b.state.offline = false;

        // The next launch: a new manager over what the store kept, and the platform's retry.
        expect(await p.build(B).ensure(scopeOf(ada, server))).toMatchObject({ kind: 'subscribed' });
        await expect(p.retry()).resolves.toBe(0);
        await onlyAt(p, ada, server, B);
    });

    it('stops at the old subscription’s DELETE while the server can’t answer, and says so', async () => {
        const p = await twoRelays();
        const ada = await addWorkspace(p.store, 'https://brain.example.test', 'u-ada');
        const server = fakeServer();
        await p.build(A).ensure(scopeOf(ada, server));
        server.state.offline = true;
        expect(await p.build(B).ensure(scopeOf(ada, server))).toEqual({
            kind: 'failed',
            step: 'unsubscribe',
            status: 'offline',
        });
        expect(p.b.requests).toEqual([]);
        // Kept for revocation already, so a wipe now still tells the old relay.
        expect(await p.records()).toHaveLength(1);
    });

    it('turns push off in a build with no relay after one with one: revokes and deletes the subscription', async () => {
        const p = await twoRelays();
        const ada = await addWorkspace(p.store, 'https://brain.example.test', 'u-ada');
        const server = fakeServer();
        await p.build(A).ensure(scopeOf(ada, server));
        await p.build(B).ensure(scopeOf(ada, server));
        const old = (await p.store.registry.push(ada.id))!;

        const none = p.build(null);
        await none.keepalive(scopeOf(ada, server));
        expect(await none.ensure(scopeOf(ada, server))).toEqual({ kind: 'no-relay' });
        expect(server.subscriptions.size).toBe(0);
        expect(server.requests.at(-1)).toMatchObject({
            path: `${SUBSCRIPTIONS_PATH}/${old.subscriptionId}`,
            init: { method: 'DELETE' },
        });
        expect(p.b.requests.at(-1)).toMatchObject({
            method: 'DELETE',
            url: `${B}/v1/registrations/${old.registrationId}`,
        });
        expect(p.a.registrations.size + p.b.registrations.size).toBe(0);
        expect(await p.store.registry.push(ada.id)).toEqual(NO_PUSH);
        expect(await p.store.keys.read(workspaceKeyName(ada.id, 'relay'))).toBeNull();
        expect(p.native.index.size).toBe(0);
        expect(await p.records()).toEqual([]);

        // Nothing more after that.
        const sent = server.requests.length;
        expect(await p.build(null).ensure(scopeOf(ada, server))).toEqual({ kind: 'no-relay' });
        expect(server.requests).toHaveLength(sent);
    });

    it.each([
        [
            'the server didn’t answer the DELETE',
            (_: Phone2, server: ReturnType<typeof fakeServer>) => void (server.state.offline = true),
        ],
        [
            'the subscription was deleted, before the registration was forgotten',
            (p: Phone2) => dyingRegistry(p.store.registry, 1),
        ],
        ['the relay didn’t answer the revocation', (p: Phone2) => void (p.b.state.offline = true)],
    ] as const)('turning push off, after %s, the next run ends with none', async (_, kill) => {
        const p = await twoRelays();
        const ada = await addWorkspace(p.store, 'https://brain.example.test', 'u-ada');
        const server = fakeServer();
        await p.build(B).ensure(scopeOf(ada, server));
        const registry = kill(p, server);
        await p
            .build(null, registry ?? undefined)
            .ensure(scopeOf(ada, server))
            .catch((error: unknown) => {
                expect(error).toBeInstanceOf(Killed);
            });
        server.state.offline = false;
        p.b.state.offline = false;

        expect(await p.build(null).ensure(scopeOf(ada, server))).toEqual({ kind: 'no-relay' });
        await expect(p.retry()).resolves.toBe(0);
        expect(server.subscriptions.size).toBe(0);
        expect(p.b.registrations.size).toBe(0);
        expect(await p.store.registry.push(ada.id)).toEqual(NO_PUSH);
        expect(await p.store.keys.read(workspaceKeyName(ada.id, 'relay'))).toBeNull();
    });

    it('goes from A to B to none, each step killed once along the way, ending with nothing anywhere', async () => {
        const p = await twoRelays();
        const ada = await addWorkspace(p.store, 'https://brain.example.test', 'u-ada');
        const server = fakeServer();
        await p.build(A).ensure(scopeOf(ada, server));
        // B: killed after the old subscription went, then the old relay away for the rerun.
        await p
            .build(B, dyingRegistry(p.store.registry, 1))
            .ensure(scopeOf(ada, server))
            .catch(() => {});
        p.a.state.offline = true;
        expect(await p.build(B).ensure(scopeOf(ada, server))).toMatchObject({ kind: 'subscribed' });
        expect(await p.records()).toHaveLength(1);
        // None: killed after the server's DELETE, then again with the new relay away.
        await p
            .build(null, dyingRegistry(p.store.registry, 1))
            .ensure(scopeOf(ada, server))
            .catch(() => {});
        p.b.state.offline = true;
        expect(await p.build(null).ensure(scopeOf(ada, server))).toEqual({ kind: 'no-relay' });
        expect(await p.records()).toHaveLength(2);
        p.a.state.offline = false;
        p.b.state.offline = false;
        await expect(p.retry()).resolves.toBe(0);
        expect(p.a.registrations.size + p.b.registrations.size).toBe(0);
        expect(server.subscriptions.size).toBe(0);
        expect(await p.store.registry.push(ada.id)).toEqual(NO_PUSH);
    });

    it('revokes a workspace wiped before it moved at the relay it was made at', async () => {
        const p = await twoRelays();
        const ada = await addWorkspace(p.store, 'https://brain.example.test', 'u-ada');
        await p.build(A).ensure(scopeOf(ada, fakeServer()));
        const manager = p.build(B);
        await wipe({ ...p.store, push: { deleteKeys: (id) => manager.forgetWorkspace(id) } }, ada.id, 'sign-out');
        const [record] = await p.records();
        expect(JSON.parse((await p.store.keys.read(record!))!)).toMatchObject({ origin: A });
        await expect(p.retry()).resolves.toBe(0);
        expect(p.a.registrations.size).toBe(0);
        expect(p.b.requests).toEqual([]);
    });

    it('takes a registration kept before relay origins were recorded, with no origin, as made at the build’s relay', async () => {
        const p = await twoRelays();
        const ada = await addWorkspace(p.store, 'https://brain.example.test', 'u-ada');
        const server = fakeServer();
        await p.build(A).ensure(scopeOf(ada, server));
        const { id, secret } = await p.kept(ada.id);
        await p.store.keys.write(workspaceKeyName(ada.id, 'relay'), JSON.stringify({ v: 1, id, secret }));

        // The same build carries on with it, and writes the origin in.
        expect(await p.build(A).ensure(scopeOf(ada, server))).toMatchObject({ kind: 'subscribed' });
        expect(await p.kept(ada.id)).toEqual({ v: 1, id, secret, origin: A });
        expect(p.a.registrations.size).toBe(1);
        // So the next relay's build revokes it at A.
        await p.build(B).ensure(scopeOf(ada, server));
        await onlyAt(p, ada, server, B);
    });
});

describe('the keepalive', () => {
    async function subscribed(b: Bench, count = 1) {
        const manager = b.manager();
        const workspaces: AddedWorkspace[] = [];
        for (let index = 0; index < count; index++) {
            const workspace = await addWorkspace(b.store, `https://w${index}.example.test`, `u-${index}`);
            await manager.ensure(scopeOf(workspace, fakeServer()));
            workspaces.push(workspace);
        }
        b.relay.requests.length = 0;
        return workspaces;
    }

    it('sends nothing the day it registered, with the same token', async () => {
        const b = await bench();
        await subscribed(b);
        await b.store.registry.setPushDevice({ refreshedAt: T0 });
        await b.manager().keepalive();
        expect(b.relay.requests).toEqual([]);
    });

    it('refreshes every registration once a day, with the secret alone', async () => {
        const b = await bench();
        const workspaces = await subscribed(b, 2);
        const manager = b.manager();
        await manager.keepalive();
        expect(b.relay.requests.map(({ method }) => method)).toEqual(['PUT', 'PUT']);
        for (const request of b.relay.requests) {
            expect(Object.keys(JSON.parse(request.body) as object)).toEqual(['secret']);
        }
        expect((await b.store.registry.pushDevice()).refreshedAt).toBe(T0);
        await manager.keepalive();
        expect(b.relay.requests).toHaveLength(2);
        b.clock.now = T0 + DAY;
        await manager.keepalive();
        expect(b.relay.requests).toHaveLength(4);
        expect(workspaces).toHaveLength(2);
    });

    it('sends a token that rotated while the app was dead to every registration, before anything else', async () => {
        const b = await bench();
        const workspaces = await subscribed(b, 3);
        await b.store.registry.setPushDevice({ refreshedAt: T0 });
        b.phone.token = 'fcm-token-rotated-cccccccccccccccc';
        // The next launch.
        await b.manager().keepalive();
        expect(b.relay.requests.map(({ method }) => method)).toEqual(['PUT', 'PUT', 'PUT']);
        for (const request of b.relay.requests) {
            expect(JSON.parse(request.body)).toMatchObject({ nativeToken: 'fcm-token-rotated-cccccccccccccccc' });
        }
        for (const registration of b.relay.registrations.values()) {
            expect(registration.token).toBe('fcm-token-rotated-cccccccccccccccc');
        }
        for (const workspace of workspaces) {
            expect((await b.store.registry.push(workspace.id))?.nativeToken).toBe('fcm-token-rotated-cccccccccccccccc');
        }
    });

    it('forgets a registration the relay no longer has, and the next check makes a new one', async () => {
        const b = await bench();
        const [ada] = await subscribed(b);
        const old = (await b.store.registry.push(ada!.id))!.registrationId!;
        b.relay.registrations.clear();
        const manager = b.manager();
        await manager.keepalive();
        expect(await b.store.registry.push(ada!.id)).toEqual(NO_PUSH);
        expect(await b.store.keys.read(workspaceKeyName(ada!.id, 'relay'))).toBeNull();
        expect(b.native.index.has(old)).toBe(false);
        const server = fakeServer();
        expect(await manager.ensure(scopeOf(ada!, server))).toMatchObject({ kind: 'subscribed' });
        expect((await b.store.registry.push(ada!.id))!.registrationId).not.toBe(old);
    });

    it('keeps everything and tries the next day’s refresh again when the relay doesn’t answer', async () => {
        const b = await bench();
        const [ada] = await subscribed(b);
        const before = await b.store.registry.push(ada!.id);
        b.relay.state.offline = true;
        await b.manager().keepalive();
        expect(await b.store.registry.push(ada!.id)).toEqual(before);
        expect((await b.store.registry.pushDevice()).refreshedAt).toBeNull();
    });

    it('keeps each workspace’s last keepalive and its answer for Technical details', async () => {
        const b = await bench();
        const [ada, ben] = await subscribed(b, 2);
        const manager = b.manager();
        expect(manager.lastRefresh(ada!.id)).toBeNull();
        b.relay.registrations.delete((await b.store.registry.push(ben!.id))!.registrationId!);
        await manager.keepalive();
        expect(manager.lastRefresh(ada!.id)).toEqual({ at: T0, answer: 'done' });
        expect(manager.lastRefresh(ben!.id)).toEqual({ at: T0, answer: 'gone' });
        b.clock.now = T0 + DAY;
        b.relay.state.offline = true;
        await manager.keepalive();
        expect(manager.lastRefresh(ada!.id)).toEqual({ at: T0 + DAY, answer: 'offline' });
        await manager.forgetWorkspace(ada!.id);
        expect(manager.lastRefresh(ada!.id)).toBeNull();
    });

    it('answers a token event once, without asking for the token again, so the echo of its own call ends', async () => {
        const b = await bench();
        const [ada] = await subscribed(b);
        // expo-notifications fires the token event on every getDevicePushTokenAsync, as the platform
        // listens: the event's token goes to the keepalive (src/platform/push.ts).
        let manager: PushManager;
        let asked = 0;
        const runs: Promise<void>[] = [];
        const event = (token: string) => {
            runs.push(manager.keepalive(null, { token }));
        };
        manager = createPushManager({
            store: b.store,
            native: b.native.native,
            notifications: {
                permission: async () => b.phone.permission,
                nativeToken: async () => {
                    // Capped, so a loop fails the counts below instead of hanging the run.
                    if (++asked < 10) {
                        queueMicrotask(() => event(b.phone.token));
                    }
                    return b.phone.token;
                },
            },
            relay: b.relay.client,
            relayOrigin: RELAY,
            app: APP,
            randomBytes: nodeRandomBytes,
            now: () => b.clock.now,
        });
        const settle = async () => {
            for (let round = 0; round < 20 && runs.length > 0; round++) {
                await Promise.all(runs.splice(0));
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            expect(runs).toEqual([]);
        };
        // The relay is down: no daily refresh lands, so each extra keepalive would send a PUT.
        b.relay.state.offline = true;
        await manager.keepalive();
        await settle();
        expect(asked).toBe(1);
        expect(b.relay.requests).toHaveLength(1);

        // A rotation while running: one keepalive with the event's token, and no new ask.
        b.relay.state.offline = false;
        b.phone.token = 'fcm-token-rotated-dddddddddddddddd';
        event(b.phone.token);
        event(b.phone.token);
        await settle();
        expect(asked).toBe(1);
        expect(b.relay.requests).toHaveLength(2);
        expect(JSON.parse(b.relay.requests[1]!.body)).toMatchObject({ nativeToken: b.phone.token });
        expect((await b.store.registry.push(ada!.id))?.nativeToken).toBe(b.phone.token);

        // ensure's own ask echoes too, and ends there (a new server: it registers afresh, no PUT).
        await manager.ensure(scopeOf(ada!, fakeServer()), { force: true });
        await settle();
        expect(asked).toBe(2);
        expect(b.relay.requests.filter(({ method }) => method === 'PUT')).toHaveLength(2);
    });

    it('deletes the subscription and every registration once permission is taken back', async () => {
        const b = await bench();
        const manager = b.manager();
        const ada = await addWorkspace(b.store, 'https://a.example.test', 'u-a');
        const bo = await addWorkspace(b.store, 'https://b.example.test', 'u-b');
        const adaServer = fakeServer();
        const boServer = fakeServer();
        await manager.ensure(scopeOf(ada, adaServer));
        await manager.ensure(scopeOf(bo, boServer));
        b.phone.permission = 'denied';
        // The next foreground, with Ada's workspace open.
        await manager.keepalive(scopeOf(ada, adaServer));
        expect(adaServer.subscriptions.size).toBe(0);
        // Bo's server drops it at the relay's 410: the app can't reach it now.
        expect(boServer.requests.filter(({ init }) => init.method === 'DELETE')).toEqual([]);
        expect(b.relay.registrations.size).toBe(0);
        for (const workspace of [ada, bo]) {
            expect(await b.store.registry.push(workspace.id)).toEqual(NO_PUSH);
            expect(await b.store.keys.read(workspaceKeyName(workspace.id, 'relay'))).toBeNull();
            expect(manager.status(workspace.id)).toEqual({ kind: 'no-permission' });
        }
        expect(b.native.index.size).toBe(0);
    });
});

describe('the flags', () => {
    it('writes each registered workspace’s lock and lease deadline once, and again when they change', async () => {
        const b = await bench();
        const manager = b.manager();
        const ada = await addWorkspace(b.store, 'https://a.example.test', 'u-a');
        const bo = await addWorkspace(b.store, 'https://b.example.test', 'u-b');
        await manager.ensure(scopeOf(ada, fakeServer()));
        b.native.calls.length = 0;
        await manager.syncFlags();
        // Bo has no registration: nothing of it goes to the extension.
        expect(b.native.calls).toEqual([]);

        await b.store.registry.setLastContact(ada.id, T0 + 1000);
        await manager.syncFlags();
        expect(b.native.flags.get(ada.id)).toEqual({ locked: false, leaseLockAt: T0 + 1000 + LEASE_LOCK_MS });
        await b.store.registry.setEnded(ada.id, T0 + 2000);
        await manager.syncFlags();
        expect(b.native.flags.get(ada.id)?.locked).toBe(true);
        expect(b.native.flags.has(bo.id)).toBe(false);
    });

    it('hands the device’s show-text setting over', async () => {
        const b = await bench();
        await b.store.registry.setPushDevice({ showText: false });
        await b.manager().syncShowText();
        expect(b.native.calls).toEqual(['setShowText false']);
    });
});

describe('the badge', () => {
    it('is the approvals waiting plus the rooms’ unread', () => {
        expect(
            badgeCount(
                [{ status: 'pending' }, { status: 'approved' }, { status: 'pending' }],
                [{ unread: 3 }, { unread: null }, { unread: 0 }],
            ),
        ).toBe(5);
        expect(badgeCount([], [])).toBe(0);
    });
});

describe('a wipe while push runs', () => {
    /** Turns of the event loop until `done` holds. */
    const until = async (done: () => boolean) => {
        for (let turn = 0; turn < 200 && !done(); turn += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        expect(done()).toBe(true);
    };
    const turns = async (count: number) => {
        for (let turn = 0; turn < count; turn += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    };
    /** The relay holds every registration until `release`. */
    const holdRelay = (b: Bench) => {
        let release = () => {};
        b.relay.state.hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        return () => {
            b.relay.state.hold = null;
            release();
        };
    };
    /** The platform's storePush once push runs: the manager's forgetWorkspace. */
    const withPush = (b: Bench, manager: PushManager): Store => ({
        ...b.store,
        push: { deleteKeys: (id) => manager.forgetWorkspace(id) },
    });

    it('waits for an ensure the relay holds, then leaves no native keys and its registration for revocation', async () => {
        const b = await bench();
        const ada = await addWorkspace(b.store, 'https://brain.example.test', 'u-ada');
        const server = fakeServer();
        const manager = b.manager();
        const release = holdRelay(b);
        const ensuring = manager.ensure(scopeOf(ada, server));
        await until(() => b.relay.requests.length === 1);

        let wiped = false;
        const wiping = wipe(withPush(b, manager), ada.id, 'sign-out').then(() => {
            wiped = true;
        });
        await turns(20);
        // The wipe waits for the ensure in the manager's queue.
        expect(wiped).toBe(false);
        release();
        await ensuring;
        await wiping;

        expect(b.native.keys.has(ada.id)).toBe(false);
        expect([...b.native.index.values()]).not.toContain(ada.id);
        expect(b.native.flags.has(ada.id)).toBe(false);
        expect(await b.store.keys.read(workspaceKeyName(ada.id, 'relay'))).toBeNull();
        expect(await b.store.registry.get(ada.id)).toBeNull();
        const records = (await b.store.keys.indexed()).filter(isPushRevocationKey);
        expect(records).toHaveLength(1);
        const [registered] = [...b.relay.registrations.keys()];
        expect(JSON.parse((await b.store.keys.read(records[0]!))!)).toMatchObject({ id: registered });

        // Nothing queued later writes for it again.
        const sent = b.relay.requests.length;
        await manager.ensure(scopeOf(ada, server), { force: true });
        expect(b.relay.requests.length).toBe(sent);
        expect(b.native.keys.has(ada.id)).toBe(false);

        // The record revokes the registration the held ensure made.
        await expect(retryPushRevocations(b.store.keys, b.relay.client)).resolves.toBe(0);
        expect(b.relay.registrations.size).toBe(0);
    });

    it('makes no new credentials for a wiped workspace when the relay says the kept id was taken', async () => {
        const b = await bench();
        const ada = await addWorkspace(b.store, 'https://brain.example.test', 'u-ada');
        const server = fakeServer();
        const manager = b.manager();
        // Someone else's registration holds the kept id: the relay answers 403, and a new id is made.
        const kept = JSON.parse((await b.store.keys.read(workspaceKeyName(ada.id, 'relay')))!) as { id: string };
        b.relay.registrations.set(kept.id, { secret: 'not-ours', token: 't', vapidKey: 'BServerKey' });
        const release = holdRelay(b);
        const ensuring = manager.ensure(scopeOf(ada, server));
        await until(() => b.relay.requests.length === 1);
        const wiping = wipe(withPush(b, manager), ada.id, 'lease');
        await turns(20);
        release();
        await ensuring;
        await wiping;

        expect(await b.store.keys.read(workspaceKeyName(ada.id, 'relay'))).toBeNull();
        expect(b.native.keys.has(ada.id)).toBe(false);
        // The wipe's mark stops the retry with a new id: only the kept id is recorded, and its 403 drops it.
        expect((await b.store.keys.indexed()).filter(isPushRevocationKey)).toHaveLength(1);
        expect(b.relay.requests.filter(({ method }) => method === 'POST')).toHaveLength(1);
        await expect(retryPushRevocations(b.store.keys, b.relay.client)).resolves.toBe(0);
        expect([...b.relay.registrations.keys()]).toEqual([kept.id]);
    });
});

describe('a wipe while the relay never answers', () => {
    afterEach(endFakeTime);
    const turns = async (count: number) => {
        for (let turn = 0; turn < count; turn += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    };
    const until = async (done: () => boolean) => {
        for (let turn = 0; turn < 500 && !done(); turn += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(done()).toBe(true);
    };
    const withPush = (b: Bench, manager: PushManager): Store => ({
        ...b.store,
        push: { deleteKeys: (id) => manager.forgetWorkspace(id) },
    });
    const nothingLeft = async (b: Bench, id: string) => {
        expect(b.native.keys.has(id)).toBe(false);
        expect([...b.native.index.values()]).not.toContain(id);
        expect(b.native.flags.has(id)).toBe(false);
        expect(await b.store.keys.read(workspaceKeyName(id, 'relay'))).toBeNull();
        expect(await b.store.registry.get(id)).toBeNull();
        expect(await b.store.registry.push(id)).toBeNull();
    };

    // Its two limits, relayFetch's and the wipe's wait, run on a fake clock
    // (setTimeout alone: the store's I/O and setImmediate stay real), and each
    // step waits for an event, not for time: with real timers a slow wipe under
    // load outlasted relayFetch's 300 ms, and the register had ended first.
    it('finishes without waiting for the stalled register, and nothing comes back when it gives up', async ({
        signal,
    }) => {
        const b = await bench({ relayTimeoutMs: 300 });
        const ada = await addWorkspace(b.store, 'https://brain.example.test', 'u-ada');
        const time = fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout'] });
        const manager = b.manager({ forgetWaitMs: 20 });
        // A stalled connection: the relay never answers the register.
        const holding = new Promise<void>((resolve) => {
            b.relay.state.onHold = resolve;
        });
        b.relay.state.hold = new Promise<void>(() => {});
        let settled = false;
        const ensuring = manager.ensure(scopeOf(ada, fakeServer())).finally(() => {
            settled = true;
        });
        await holding;
        expect(b.relay.requests).toHaveLength(1);

        // The wipe asks push to forget the workspace, which waits at most forgetWaitMs for the run.
        let forgot = () => {};
        const forgetCalled = new Promise<void>((resolve) => {
            forgot = resolve;
        });
        const wiping = wipe(
            {
                ...b.store,
                push: {
                    deleteKeys: (id) => {
                        const forgetting = manager.forgetWorkspace(id);
                        forgot();
                        return forgetting;
                    },
                },
            },
            ada.id,
            'sign-out',
        );
        await forgetCalled;
        await time.advance(20);
        await wiping;
        expect(settled).toBe(false);
        await nothingLeft(b, ada.id);
        expect((await b.store.keys.indexed()).filter(isPushRevocationKey)).toHaveLength(1);

        // relayFetch's own limit ends the register; the run writes nothing for the wiped workspace.
        await time.advance(300);
        await ensuring;
        await time.turns(10);
        await nothingLeft(b, ada.id);
        expect(manager.status(ada.id)).toEqual({ kind: 'unknown' });
    });

    it('writes nothing when the relay answers after the wipe gave up waiting, and the record revokes it', async () => {
        const b = await bench();
        const ada = await addWorkspace(b.store, 'https://brain.example.test', 'u-ada');
        const server = fakeServer();
        const manager = b.manager({ forgetWaitMs: 20 });
        let release = () => {};
        b.relay.state.hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        const ensuring = manager.ensure(scopeOf(ada, server));
        await until(() => b.relay.requests.length === 1);
        await wipe(withPush(b, manager), ada.id, 'lease');
        await nothingLeft(b, ada.id);

        // The relay registers it now: no keys, index entry, flags or subscription follow.
        b.relay.state.hold = null;
        release();
        await expect(ensuring).resolves.toEqual({ kind: 'unknown' });
        await turns(10);
        await nothingLeft(b, ada.id);
        expect(server.subscriptions.size).toBe(0);
        expect(b.relay.registrations.size).toBe(1);
        await expect(retryPushRevocations(b.store.keys, b.relay.client)).resolves.toBe(0);
        expect(b.relay.registrations.size).toBe(0);
    });
});

describe('the badge with no workspace open', () => {
    type Kind = ReturnType<BadgeScopes['get']>['kind'];
    const scopes = (kind: Kind) => {
        const listeners = new Set<() => void>();
        const state: { kind: Kind } = { kind };
        return {
            scopes: {
                get: () => state,
                subscribe: (listener: () => void) => {
                    listeners.add(listener);
                    return () => {
                        listeners.delete(listener);
                    };
                },
            } satisfies BadgeScopes,
            set(next: Kind) {
                state.kind = next;
                for (const listener of [...listeners]) {
                    listener();
                }
            },
        };
    };

    it('is 0 once the last workspace is removed or locks, and at a launch with none open', () => {
        const set: number[] = [];
        const active = scopes('open');
        const off = followBadge(active.scopes, (count) => set.push(count));
        expect(set).toEqual([]);
        // Locking (the lock screen has no scope) or removing the last workspace.
        active.set('none');
        expect(set).toEqual([0]);
        active.set('none');
        expect(set).toEqual([0]);
        // A switch passes through opening: the next workspace's summary sets its own.
        active.set('opening');
        active.set('open');
        expect(set).toEqual([0]);
        active.set('failed');
        expect(set).toEqual([0, 0]);
        off();
        active.set('open');
        active.set('none');
        expect(set).toEqual([0, 0]);

        const launched: number[] = [];
        followBadge(scopes('none').scopes, (count) => launched.push(count));
        expect(launched).toEqual([0]);
    });
});

// The server binds a subscription to this device when its POST comes from the
// app's own session with the install id, and the endpoint only ever changes
// with a new registration, which always POSTs: so no `PUT /api/auth/device/push`.
describe('the subscription and the device record', () => {
    const INSTALL = 'Aq3_x-9ZkLmNoPqRsTuVwXyZ0123456789abcdefghi';

    /** The workspace's real scope over the phone's network to `server`, recording each request's headers. */
    async function openScope(b: Bench, ada: AddedWorkspace, server: ReturnType<typeof fakeServer>) {
        const jar = await openCookieJar({ origin: ada.origin, store: memoryJarStore() });
        await jar.apply(
            new URL(`${ada.origin}/api/auth/sign-in/email`),
            [sessionSetCookie('t1.c2ln%3D')],
            httpDate(T0),
        );
        await b.store.keys.write(workspaceKeyName(ada.id, 'jar'), jar.serialize());
        const sent: { method: string; path: string; headers: Record<string, string> }[] = [];
        const fetch: FetchFunction = async (url, init) => {
            const method = init.method ?? 'GET';
            const path = new URL(url).pathname;
            sent.push({ method, path, headers: (init.headers ?? {}) as Record<string, string> });
            const json = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
            return server.fetch(path, { method, json });
        };
        const scope = await openWorkspaceScope({
            store: b.store,
            workspaceId: ada.id,
            fetch,
            userAgent: USER_AGENT,
            variant: 'production',
            appState: fakeAppState(),
            network: fakeNetwork(),
        });
        const push: PushScope = { workspaceId: ada.id, name: 'Acme', fetch: scope.fetch };
        return { scope, push, sent };
    }

    const installOn = (sent: { method: string; path: string; headers: Record<string, string> }[]) =>
        sent
            .filter((request) => request.method === 'POST' && request.path === SUBSCRIPTIONS_PATH)
            .map((request) => request.headers[INSTALL_HEADER.toLowerCase()] ?? null);

    it('subscribes through the scope’s authedFetch with the install id, on every new endpoint', async () => {
        const b = await bench();
        const ada = await addWorkspace(b.store, 'https://brain.example.test', 'u-ada');
        await b.store.keys.write(workspaceKeyName(ada.id, 'install'), INSTALL);
        await b.store.registry.setInstallSet(ada.id, T0);
        const server = fakeServer();
        const { scope, push, sent } = await openScope(b, ada, server);
        try {
            const manager = b.manager();
            expect(await manager.ensure(push)).toEqual({ kind: 'subscribed', subscriptionId: 'sub-1' });
            expect(installOn(sent)).toEqual([INSTALL]);

            // A token change only refreshes the relay: the same id, so the same endpoint, and nothing to the server.
            b.phone.token = 'fcm-token-bbbbbbbbbbbbbbbbbbbbbbbb';
            await manager.keepalive(push, { token: b.phone.token });
            expect(sent.filter((request) => request.path !== CHANNELS_PATH).map((r) => r.path)).toEqual([
                SUBSCRIPTIONS_PATH,
            ]);

            // The relay forgot it (a 410 at the keepalive): the next ensure registers anew, a new endpoint, POSTed with the id.
            b.relay.registrations.clear();
            b.clock.now += DAY;
            await manager.keepalive(push);
            expect(await manager.ensure(push, { force: true })).toEqual({
                kind: 'subscribed',
                subscriptionId: 'sub-2',
            });
            expect(installOn(sent)).toEqual([INSTALL, INSTALL]);
            expect(server.subscriptions.size).toBe(2);
            expect(sent.some((request) => request.path.startsWith('/api/auth/device'))).toBe(false);
        } finally {
            await scope.dispose();
        }
    });

    it('sends no install id from a copy signed in before install ids, even with a key left behind', async () => {
        const b = await bench();
        const ada = await addWorkspace(b.store, 'https://brain.example.test', 'u-ada');
        await b.store.keys.write(workspaceKeyName(ada.id, 'install'), INSTALL);
        await b.store.registry.setInstallSet(ada.id, null);
        const server = fakeServer();
        const { scope, push, sent } = await openScope(b, ada, server);
        try {
            expect(await b.manager().ensure(push)).toEqual({ kind: 'subscribed', subscriptionId: 'sub-1' });
            expect(installOn(sent)).toEqual([null]);
        } finally {
            await scope.dispose();
        }
    });
});
