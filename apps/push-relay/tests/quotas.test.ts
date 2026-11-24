import { describe, expect, it } from 'vitest';

import { QUOTAS, clientPrefix, rateLimitQuotas, type Quotas } from '../src/quotas';

import { FakeRateLimit } from './fakes/rate-limit';
import { ORIGIN, message, newRegistration, newServer, pushRequest, registered, setup } from './helpers';

/** The start of the current minute, so a test's pushes stay in one window until it moves the clock. */
const minuteStart = () => Math.floor(Date.now() / 60_000) * 60_000;

/** A push's three quotas in the relay's order (global, key, registration). */
const take = async (quotas: Quotas, push: { registrationId: string; vapidKey: string }) =>
    (await quotas.takeGlobalPush()) &&
    (await quotas.takeVapidKey(push.vapidKey)) &&
    (await quotas.takeRegistrationPush(push.registrationId));

/** The registration-write bindings, for tests about pushes. */
const registerBindings = (clock: () => number) => ({
    RL_REGISTER_CLIENT: new FakeRateLimit(QUOTAS.registerClient.limit, 60, clock),
    RL_REGISTRY_GLOBAL: new FakeRateLimit(QUOTAS.registryGlobal.limit, 60, clock),
});

describe('quotas', () => {
    it('limits one registration per minute with 429 and Retry-After, and the next minute resets it', async () => {
        const h = setup({ start: minuteStart() });
        const server = newServer();
        const { endpoint } = await registered(h, server);
        const other = await registered(h, server);
        for (let i = 0; i < QUOTAS.registration.limit; i++) {
            expect((await h.relay.fetch(pushRequest(server, endpoint, message()))).status).toBe(201);
        }
        const limited = await h.relay.fetch(pushRequest(server, endpoint, message()));
        expect(limited.status).toBe(429);
        expect(limited.headers.get('retry-after')).toBe('60');
        // The same workspace's other phone isn't held back.
        expect((await h.relay.fetch(pushRequest(server, other.endpoint, message()))).status).toBe(201);
        h.advance(60_000);
        expect((await h.relay.fetch(pushRequest(server, endpoint, message()))).status).toBe(201);
        // A limited push is never forwarded, and keeps the row.
        expect(h.providers.deliveries).toHaveLength(QUOTAS.registration.limit + 2);
        expect(h.db.rows()).toHaveLength(2);
    });

    it('limits one VAPID key across its registrations, and not another workspace', async () => {
        const start = minuteStart();
        let now = start;
        const clock = () => now;
        const bindings = {
            RL_REGISTRATION: new FakeRateLimit(QUOTAS.registration.limit, 60, clock),
            RL_VAPID_KEY: new FakeRateLimit(QUOTAS.vapidKey.limit, 60, clock),
            RL_GLOBAL: new FakeRateLimit(QUOTAS.global.limit, 60, clock),
            ...registerBindings(clock),
        };
        const quotas = rateLimitQuotas(bindings, () => {});
        let sent = 0;
        for (let i = 0; i < QUOTAS.vapidKey.limit + 5; i++) {
            if (await take(quotas, { registrationId: `r${i % 40}`, vapidKey: 'K1' })) {
                sent++;
            }
        }
        expect(sent).toBe(QUOTAS.vapidKey.limit);
        expect(await take(quotas, { registrationId: 'other', vapidKey: 'K2' })).toBe(true);
        now = start + 60_000;
        expect(await take(quotas, { registrationId: 'r1', vapidKey: 'K1' })).toBe(true);
    });

    it('holds a global ceiling', async () => {
        const clock = () => 0;
        const quotas = rateLimitQuotas(
            {
                RL_REGISTRATION: new FakeRateLimit(1000, 60, clock),
                RL_VAPID_KEY: new FakeRateLimit(1000, 60, clock),
                RL_GLOBAL: new FakeRateLimit(3, 60, clock),
                ...registerBindings(clock),
            },
            () => {},
        );
        const results = [];
        for (let i = 0; i < 4; i++) {
            results.push(await take(quotas, { registrationId: `r${i}`, vapidKey: `k${i}` }));
        }
        expect(results).toEqual([true, true, true, false]);
    });

    it('checks the broad quotas first, so a refused push never reaches D1; a limited phone still counts against them', async () => {
        const clock = () => 0;
        const bindings = {
            RL_REGISTRATION: new FakeRateLimit(1, 60, clock),
            RL_VAPID_KEY: new FakeRateLimit(1000, 60, clock),
            RL_GLOBAL: new FakeRateLimit(1000, 60, clock),
            ...registerBindings(clock),
        };
        const quotas = rateLimitQuotas(bindings, () => {});
        await take(quotas, { registrationId: 'r', vapidKey: 'k' });
        await take(quotas, { registrationId: 'r', vapidKey: 'k' });
        expect(bindings.RL_GLOBAL.keys).toEqual(['global', 'global']);
        expect(bindings.RL_VAPID_KEY.keys).toEqual(['k:k', 'k:k']);
        expect(bindings.RL_REGISTRATION.keys).toEqual(['r:r', 'r:r']);
    });

    it('lets a push or a registration through when the binding fails, and logs it without the key', async () => {
        const logs: string[] = [];
        const failing = new FakeRateLimit(0, 60, () => 0);
        failing.failing = true;
        const quotas = rateLimitQuotas(
            {
                RL_REGISTRATION: failing,
                RL_VAPID_KEY: failing,
                RL_GLOBAL: failing,
                RL_REGISTER_CLIENT: failing,
                RL_REGISTRY_GLOBAL: failing,
            },
            (event) => logs.push(event),
        );
        expect(await take(quotas, { registrationId: 'secret-id', vapidKey: 'secret-key' })).toBe(true);
        expect(logs).toEqual(['rate limiter failed', 'rate limiter failed', 'rate limiter failed']);
        logs.length = 0;
        expect(await quotas.takeRegistry({ client: '203.0.113.7', kind: 'write' })).toBe(true);
        expect(logs).toEqual(['rate limiter failed', 'rate limiter failed']);
    });

    it('keeps every window a minute long, as the binding allows 10 or 60 seconds only', () => {
        for (const quota of Object.values(QUOTAS)) {
            expect(quota.period).toBe(60);
        }
    });
});

describe('registration quotas', () => {
    const at = (ip?: string): Record<string, string> => (ip ? { 'cf-connecting-ip': ip } : {});

    it('limits registrations per client address with 429 and Retry-After, before D1 is touched', async () => {
        const h = setup({ start: minuteStart() });
        const server = newServer();
        for (let i = 0; i < QUOTAS.registerClient.limit; i++) {
            expect((await h.call('POST', '/v1/registrations', newRegistration(server), at('203.0.113.7'))).status).toBe(
                201,
            );
        }
        const limited = await h.call('POST', '/v1/registrations', newRegistration(server), at('203.0.113.7'));
        expect(limited.status).toBe(429);
        expect(limited.headers.get('retry-after')).toBe('60');
        expect(h.db.rows()).toHaveLength(QUOTAS.registerClient.limit);
        // Another address isn't held back, and the next minute resets the first.
        expect((await h.call('POST', '/v1/registrations', newRegistration(server), at('198.51.100.1'))).status).toBe(
            201,
        );
        h.advance(60_000);
        expect((await h.call('POST', '/v1/registrations', newRegistration(server), at('203.0.113.7'))).status).toBe(
            201,
        );
    });

    it('counts the daily refresh (PUT) but never DELETE, so a revocation always lands', async () => {
        const h = setup({ start: minuteStart() });
        const server = newServer();
        const { registration } = await registered(h, server);
        const ip = at('203.0.113.9');
        for (let i = 0; i < QUOTAS.registerClient.limit; i++) {
            await h.call('PUT', `/v1/registrations/${registration.id}`, { secret: registration.secret }, ip);
        }
        expect(
            (await h.call('PUT', `/v1/registrations/${registration.id}`, { secret: registration.secret }, ip)).status,
        ).toBe(429);
        expect(
            (await h.call('DELETE', `/v1/registrations/${registration.id}`, { secret: registration.secret }, ip))
                .status,
        ).toBe(204);
    });

    it('keys the client limiter by a hash of the address or /64, never the address, and logs none', async () => {
        const h = setup({ start: minuteStart() });
        const server = newServer();
        await h.call('POST', '/v1/registrations', newRegistration(server), at('2001:db8:aa:bb:1:2:3:4'));
        await h.call('POST', '/v1/registrations', newRegistration(server), at('2001:db8:aa:bb::99'));
        await h.call('POST', '/v1/registrations', newRegistration(server), at('203.0.113.7'));
        const keys = h.limits.RL_REGISTER_CLIENT.keys;
        expect(keys).toHaveLength(3);
        expect(keys[0]).toBe(keys[1]);
        expect(keys[2]).not.toBe(keys[0]);
        for (const key of keys) {
            expect(key).toMatch(/^c:[0-9a-f]{32}$/);
        }
        const kept = JSON.stringify([keys, h.logs, h.db.rows()]);
        for (const fragment of ['2001:db8', '203.0.113', '113.7']) {
            expect(kept).not.toContain(fragment);
        }
    });

    it('takes the /64 of an IPv6 address and the IPv4 of a mapped one; ignores anything else', () => {
        expect(clientPrefix('2001:DB8:0:1:2:3:4:5')).toBe('2001:db8:0:1::/64');
        expect(clientPrefix('2001:db8::1')).toBe('2001:db8:0:0::/64');
        expect(clientPrefix('::1')).toBe('0:0:0:0::/64');
        expect(clientPrefix('::ffff:192.0.2.1')).toBe('192.0.2.1');
        expect(clientPrefix(' 192.0.2.1 ')).toBe('192.0.2.1');
        for (const bad of [null, '', 'unknown', '300.1.1.1', '1::2::3', '1:2:3:4:5:6:7:8:9', '12345::']) {
            expect(clientPrefix(bad)).toBeNull();
        }
    });
});

describe('push quotas before D1', () => {
    const ID = (i: number) => `unknown-registration-${String(i).padStart(4, '0')}`;
    const reads = (h: ReturnType<typeof setup>) => h.db.queries.filter((query) => query.startsWith('SELECT')).length;

    it('throttles pushes to unknown ids by VAPID key with no D1 read past the limit', async () => {
        const h = setup({ start: minuteStart(), limits: { vapidKey: 3 } });
        const server = newServer();
        const answers: number[] = [];
        for (let i = 0; i < 6; i++) {
            const response = await h.relay.fetch(pushRequest(server, `${ORIGIN}/v1/push/${ID(i)}`, message()));
            answers.push(response.status);
        }
        expect(answers).toEqual([410, 410, 410, 429, 429, 429]);
        expect(reads(h)).toBe(3);
        // Another workspace's key isn't held back by this one.
        const other = newServer();
        expect((await h.relay.fetch(pushRequest(other, `${ORIGIN}/v1/push/${ID(9)}`, message()))).status).toBe(410);
        expect(reads(h)).toBe(4);
    });

    it('holds the global push quota before the signature is checked or D1 is read', async () => {
        const h = setup({ start: minuteStart(), limits: { global: 2 } });
        const server = newServer();
        const forged = new Request(`${ORIGIN}/v1/push/${ID(1)}`, {
            method: 'POST',
            headers: { authorization: 'vapid t=x.y.z, k=nope', 'content-encoding': 'aes128gcm' },
            body: new Uint8Array(10),
        });
        expect((await h.relay.fetch(forged.clone())).status).toBe(401);
        expect((await h.relay.fetch(pushRequest(server, `${ORIGIN}/v1/push/${ID(2)}`, message()))).status).toBe(410);
        const limited = await h.relay.fetch(pushRequest(server, `${ORIGIN}/v1/push/${ID(3)}`, message()));
        expect(limited.status).toBe(429);
        expect(limited.headers.get('retry-after')).toBe('60');
        expect((await h.relay.fetch(forged.clone())).status).toBe(429);
        expect(reads(h)).toBe(1);
    });

    it('never lets a forged `k` spend another workspace’s key quota', async () => {
        const h = setup({ start: minuteStart(), limits: { vapidKey: 1 } });
        const victim = newServer();
        const forged = new Request(`${ORIGIN}/v1/push/${ID(1)}`, {
            method: 'POST',
            headers: { authorization: `vapid t=x.y.z, k=${victim.publicKey}`, 'content-encoding': 'aes128gcm' },
            body: new Uint8Array(10),
        });
        for (let i = 0; i < 3; i++) {
            expect((await h.relay.fetch(forged.clone())).status).toBe(401);
        }
        expect(h.limits.RL_VAPID_KEY.keys).toEqual([]);
        const { endpoint } = await registered(h, victim);
        expect((await h.relay.fetch(pushRequest(victim, endpoint, message()))).status).toBe(201);
    });
});

describe('registration-route quotas before D1', () => {
    const ID = (i: number) => `unknown-registration-${String(i).padStart(4, '0')}`;
    const SECRET = 'S'.repeat(43);
    const reads = (h: ReturnType<typeof setup>) => h.db.queries.length;

    it('throttles DELETEs to unknown ids per client address with no D1 read past the limit', async () => {
        const h = setup({ start: minuteStart(), limits: { registerClient: 3 } });
        const ip = { 'cf-connecting-ip': '203.0.113.50' };
        const answers: number[] = [];
        for (let i = 0; i < 6; i++) {
            answers.push((await h.call('DELETE', `/v1/registrations/${ID(i)}`, { secret: SECRET }, ip)).status);
        }
        expect(answers).toEqual([410, 410, 410, 429, 429, 429]);
        expect(reads(h)).toBe(3);
        // Another address isn't held back.
        const other = await h.call(
            'DELETE',
            `/v1/registrations/${ID(9)}`,
            { secret: SECRET },
            { 'cf-connecting-ip': '198.51.100.9' },
        );
        expect(other.status).toBe(410);
    });

    it('throttles DELETEs and wrong secrets for everyone, with no address, before D1', async () => {
        const h = setup({ start: minuteStart(), limits: { registryGlobal: 2 } });
        const server = newServer();
        const { registration } = await registered(h, server);
        h.db.queries.length = 0;
        const wrong = { secret: 'W'.repeat(43) };
        expect((await h.call('DELETE', `/v1/registrations/${registration.id}`, wrong)).status).toBe(403);
        expect((await h.call('DELETE', `/v1/registrations/${ID(1)}`, wrong)).status).toBe(410);
        const limited = await h.call('DELETE', `/v1/registrations/${ID(2)}`, wrong);
        expect(limited.status).toBe(429);
        expect(limited.headers.get('retry-after')).toBe('60');
        expect((await h.call('DELETE', `/v1/registrations/${registration.id}`, wrong)).status).toBe(429);
        expect(reads(h)).toBe(2);
    });

    it('throttles POST and PUT the same way, before even the write budget is touched', async () => {
        const h = setup({ start: minuteStart(), limits: { registryGlobal: 1 } });
        const server = newServer();
        const { registration } = await registered(h, server);
        h.db.queries.length = 0;
        expect((await h.call('POST', '/v1/registrations', newRegistration(server))).status).toBe(429);
        expect(
            (await h.call('PUT', `/v1/registrations/${registration.id}`, { secret: registration.secret })).status,
        ).toBe(429);
        expect((await h.call('PUT', `/v1/registrations/${ID(3)}`, { secret: SECRET })).status).toBe(429);
        expect(reads(h)).toBe(0);
    });

    it('counts writes and deletes apart, so a flood of writes never blocks a revocation', async () => {
        const h = setup({ start: minuteStart(), limits: { registryGlobal: 2, registerClient: 2 } });
        const server = newServer();
        const ip = { 'cf-connecting-ip': '203.0.113.77' };
        const { registration } = await registered(h, server);
        await h.call('POST', '/v1/registrations', newRegistration(server), ip);
        expect((await h.call('POST', '/v1/registrations', newRegistration(server), ip)).status).toBe(429);
        expect(
            (await h.call('DELETE', `/v1/registrations/${registration.id}`, { secret: registration.secret }, ip))
                .status,
        ).toBe(204);
        expect(h.limits.RL_REGISTRY_GLOBAL.keys).toEqual(['write', 'write', 'write', 'delete']);
        expect(h.limits.RL_REGISTER_CLIENT.keys[0]).toMatch(/^c:/);
        expect(h.limits.RL_REGISTER_CLIENT.keys.at(-1)).toMatch(/^d:/);
    });
});
