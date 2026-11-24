// The Worker's entry with its bindings: D1, the three rate limiters, RELAY_ORIGIN and the provider secrets.

import { describe, expect, it, vi } from 'vitest';

import worker, { type Env } from '../src/index';
import { QUOTAS } from '../src/quotas';

import { FakeD1 } from './fakes/d1';
import { apnsTestKey } from './fakes/native';
import { FakeRateLimit } from './fakes/rate-limit';
import { ORIGIN, message, newRegistration, newServer, pushRequest } from './helpers';

const DAY = 24 * 60 * 60 * 1000;

/** A request as the Worker receives one (Cloudflare adds `cf`, which the relay never reads). */
const incoming = (request: Request) => request as Request<unknown, IncomingRequestCfProperties>;

function env(db = new FakeD1()) {
    const clock = () => Date.now();
    return {
        DB: db as unknown as D1Database,
        RL_REGISTRATION: new FakeRateLimit(QUOTAS.registration.limit, 60, clock),
        RL_VAPID_KEY: new FakeRateLimit(QUOTAS.vapidKey.limit, 60, clock),
        RL_GLOBAL: new FakeRateLimit(QUOTAS.global.limit, 60, clock),
        RL_REGISTER_CLIENT: new FakeRateLimit(QUOTAS.registerClient.limit, 60, clock),
        RL_REGISTRY_GLOBAL: new FakeRateLimit(QUOTAS.registryGlobal.limit, 60, clock),
        RELAY_ORIGIN: ORIGIN,
    } satisfies Env;
}

describe('the Worker', () => {
    it('registers, and answers 503 to pushes while the provider has no credentials', async () => {
        const e = env();
        const server = newServer();
        const reg = newRegistration(server);
        const created = await worker.fetch(
            incoming(new Request(`${ORIGIN}/v1/registrations`, { method: 'POST', body: JSON.stringify(reg) })),
            e,
        );
        expect(created.status).toBe(201);
        const { endpoint } = (await created.json()) as { endpoint: string };
        const pushed = await worker.fetch(incoming(pushRequest(server, endpoint, message())), e);
        expect(pushed.status).toBe(503);
    });

    it('forwards to APNs with the credentials from its secrets', async () => {
        const requests: Request[] = [];
        vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
            requests.push(new Request(input, init));
            return new Response(null, { status: 200 });
        });
        try {
            const e = {
                ...env(),
                APNS_KEY_P8: (await apnsTestKey()).pem.replace(/\n/g, '\\n'),
                APNS_KEY_ID: 'KEY0000001',
                APNS_TEAM_ID: 'TEAM000001',
            } satisfies Env;
            const server = newServer();
            const reg = newRegistration(server, { apnsEnv: 'production' });
            const created = await worker.fetch(
                incoming(new Request(`${ORIGIN}/v1/registrations`, { method: 'POST', body: JSON.stringify(reg) })),
                e,
            );
            const { endpoint } = (await created.json()) as { endpoint: string };
            const pushed = await worker.fetch(incoming(pushRequest(server, endpoint, message())), e);
            expect(pushed.status).toBe(201);
            expect(requests.map((request) => request.url)).toEqual([
                `https://api.push.apple.com/3/device/${reg.nativeToken}`,
            ]);
            expect(requests[0].headers.get('authorization')).toMatch(/^bearer /);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('drops registrations not refreshed in 60 days on its schedule', async () => {
        const db = new FakeD1();
        const today = new Date().toISOString().slice(0, 10);
        const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
        const insert = db.sqlite.prepare(
            "INSERT INTO registrations VALUES (?, 'ios', 'aa', 'com.ingenioventures.socio', 'production', 'k', 'h', 0, ?)",
        );
        for (const [id, on] of [
            ['today', today],
            ['days59', daysAgo(59)],
            ['days60', daysAgo(60)],
            ['days61', daysAgo(61)],
            ['days400', daysAgo(400)],
        ]) {
            insert.run(id, on);
        }
        await worker.scheduled({} as ScheduledController, env(db));
        expect(db.rows().map((row) => row.id)).toEqual(['days59', 'days60', 'today']);
    });
});
