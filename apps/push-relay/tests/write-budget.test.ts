// The D1 write budget (src/write-budget.ts): every writing path charges its billed cost to one
// counter per minute, shared by every location, checked before the write.

import { describe, expect, it } from 'vitest';

import worker, { type Env } from '../src/index';
import { QUOTAS } from '../src/quotas';
import {
    APNS_TOKEN_WRITES_PER_DAY,
    COUNTER_CLEANUP_PER_DAY,
    DEFAULT_REGISTRATION_WRITE_BUDGET,
    PAID_INCLUDED_WRITES_PER_MONTH,
    WRITE_COST,
    dailyWritesAt,
    monthlyWorstCaseAt,
    writeBudgetFrom,
} from '../src/write-budget';

import { FakeD1 } from './fakes/d1';
import { FakeRateLimit } from './fakes/rate-limit';
import { ORIGIN, message, newRegistration, newServer, pushRequest, registered, setup } from './helpers';

const minuteStart = () => Math.floor(Date.now() / 60_000) * 60_000;

const spent = (db: FakeD1) =>
    db.sqlite.prepare('SELECT minute, spent FROM write_budget ORDER BY minute').all() as {
        minute: number;
        spent: number;
    }[];

describe('the write costs', () => {
    it('match the schema: registrations has only its primary key’s index, and the counter none', () => {
        const db = new FakeD1();
        const indexes = (table: string) =>
            (db.sqlite.prepare(`PRAGMA index_list(${table})`).all() as { name: string; origin: string }[]).map(
                (index) => index.origin,
            );
        // One index entry per row: the TEXT primary key's (origin 'pk'). No refreshed_on index.
        expect(indexes('registrations')).toEqual(['pk']);
        // INTEGER PRIMARY KEY is the rowid: no index at all.
        expect(indexes('write_budget')).toEqual([]);
        // The shared APNs token's row: its TEXT primary key's index, reserved in the arithmetic.
        expect(indexes('apns_provider_tokens')).toEqual(['pk']);
        expect(WRITE_COST).toEqual({ create: 5, refresh: 2, tokenClear: 2, delete: 0 });
    });

    it('bound a month at the default budget, prepaid deletes included, to under a tenth of Paid’s 50 million', () => {
        expect(DEFAULT_REGISTRATION_WRITE_BUDGET).toBe(50);
        expect(dailyWritesAt(DEFAULT_REGISTRATION_WRITE_BUDGET)).toBe(
            50 * 1440 + COUNTER_CLEANUP_PER_DAY + APNS_TOKEN_WRITES_PER_DAY,
        );
        expect(monthlyWorstCaseAt(DEFAULT_REGISTRATION_WRITE_BUDGET)).toBe(30 * 73_540 + 90 * 14_400 * 2);
        expect(monthlyWorstCaseAt(DEFAULT_REGISTRATION_WRITE_BUDGET)).toBe(4_798_200);
        expect(monthlyWorstCaseAt(DEFAULT_REGISTRATION_WRITE_BUDGET)).toBeLessThan(PAID_INCLUDED_WRITES_PER_MONTH / 10);
    });
});

describe('the write budget', () => {
    it('charges each path its cost: create, retry, refresh, rotation; delete and the cron nothing', async () => {
        const start = minuteStart();
        const h = setup({ start, writeBudget: 1000 });
        const reg = newRegistration(newServer());
        const minute = start / 60_000;
        const charged = () => spent(h.db).find((row) => row.minute === minute)?.spent ?? 0;

        expect((await h.call('POST', '/v1/registrations', reg)).status).toBe(201);
        expect(charged()).toBe(WRITE_COST.create);
        expect((await h.call('POST', '/v1/registrations', reg)).status).toBe(200);
        expect(charged()).toBe(2 * WRITE_COST.create);
        expect((await h.call('PUT', `/v1/registrations/${reg.id}`, { secret: reg.secret })).status).toBe(204);
        expect(charged()).toBe(2 * WRITE_COST.create + WRITE_COST.refresh);
        const token = 'cd'.repeat(32);
        await h.call('PUT', `/v1/registrations/${reg.id}`, { secret: reg.secret, nativeToken: token });
        expect(charged()).toBe(2 * WRITE_COST.create + 2 * WRITE_COST.refresh);
        expect((await h.call('DELETE', `/v1/registrations/${reg.id}`, { secret: reg.secret })).status).toBe(204);
        expect(charged()).toBe(2 * WRITE_COST.create + 2 * WRITE_COST.refresh);
        // A request refused before the charge (invalid) costs nothing.
        expect((await h.call('POST', '/v1/registrations', { id: 'x' })).status).toBe(400);
        await h.relay.expire();
        expect(charged()).toBe(2 * WRITE_COST.create + 2 * WRITE_COST.refresh);
    });

    it('refuses with 429 and Retry-After past the budget and writes nothing; DELETE still lands', async () => {
        const start = minuteStart();
        const h = setup({ start, writeBudget: WRITE_COST.create + WRITE_COST.refresh });
        const server = newServer();
        const { registration } = await registered(h, server);
        const refused = await h.call('POST', '/v1/registrations', newRegistration(server));
        expect(refused.status).toBe(429);
        expect(refused.headers.get('retry-after')).toBe('60');
        expect(h.db.rows()).toHaveLength(1);
        expect(spent(h.db)).toEqual([{ minute: start / 60_000, spent: WRITE_COST.create }]);

        const put = (body: Record<string, unknown>) => h.call('PUT', `/v1/registrations/${registration.id}`, body);
        expect((await put({ secret: registration.secret })).status).toBe(204);
        h.db.queries.length = 0;
        const refusedPut = await put({ secret: registration.secret, nativeToken: 'ab'.repeat(32) });
        expect(refusedPut.status).toBe(429);
        // Checked before any registration is read, and the token unchanged.
        expect(h.db.queries.some((query) => query.includes('FROM registrations'))).toBe(false);
        expect(h.db.rows()[0].native_token).toBe(registration.nativeToken);
        expect(spent(h.db)).toEqual([{ minute: start / 60_000, spent: WRITE_COST.create + WRITE_COST.refresh }]);

        // A revocation is never refused for budget: its delete was paid for at create.
        expect(
            (await h.call('DELETE', `/v1/registrations/${registration.id}`, { secret: registration.secret })).status,
        ).toBe(204);
        expect(h.db.rows()).toHaveLength(0);

        // The next minute starts a new budget.
        h.advance(60_000);
        expect((await h.call('POST', '/v1/registrations', newRegistration(server))).status).toBe(201);
    });

    it('holds across locations: two relays on one D1 with their own rate limiters share it', async () => {
        const start = minuteStart();
        const budget = 4 * WRITE_COST.create;
        const here = setup({ start, writeBudget: budget });
        const there = setup({ start, db: here.db, writeBudget: budget });
        const server = newServer();
        const answers: number[] = [];
        for (let i = 0; i < 9; i++) {
            const h = i % 2 === 0 ? here : there;
            const ip: Record<string, string> = i % 3 === 0 ? {} : { 'cf-connecting-ip': `192.0.2.${i}` };
            answers.push((await h.call('POST', '/v1/registrations', newRegistration(server), ip)).status);
        }
        expect(answers).toEqual([201, 201, 201, 201, 429, 429, 429, 429, 429]);
        expect(here.db.rows()).toHaveLength(4);
        expect(spent(here.db)).toEqual([{ minute: start / 60_000, spent: budget }]);
        expect(JSON.stringify(spent(here.db))).not.toContain('192.0.2');
    });

    it('allows more when raised: 10 creates a minute by default, 100 at 500', async () => {
        const server = newServer();
        const creates = async (writeBudget: number) => {
            const h = setup({ start: minuteStart(), writeBudget });
            let created = 0;
            for (let i = 0; i < 110; i++) {
                if ((await h.call('POST', '/v1/registrations', newRegistration(server))).status === 201) {
                    created++;
                }
            }
            return created;
        };
        expect(await creates(DEFAULT_REGISTRATION_WRITE_BUDGET)).toBe(10);
        expect(await creates(500)).toBe(100);
    });

    it('charges a cleared token (a provider’s “gone”) its cost, and answers 503 keeping the token when spent', async () => {
        const start = minuteStart();
        const minute = start / 60_000;
        const h = setup({ start, writeBudget: WRITE_COST.create + WRITE_COST.tokenClear });
        const server = newServer();
        const { registration, endpoint } = await registered(h, server);
        h.providers.script = ['gone'];
        expect((await h.relay.fetch(pushRequest(server, endpoint, message()))).status).toBe(410);
        expect(spent(h.db)).toEqual([{ minute, spent: WRITE_COST.create + WRITE_COST.tokenClear }]);
        expect(h.db.rows()[0].native_token).toBe('');

        // Spent: the next "gone" isn't recorded; 503 keeps the subscription and the token.
        h.advance(60_000);
        const revived = await h.call('PUT', `/v1/registrations/${registration.id}`, {
            secret: registration.secret,
            nativeToken: registration.nativeToken,
        });
        expect(revived.status).toBe(204);
        h.db.sqlite.exec(`UPDATE write_budget SET spent = ${WRITE_COST.create + 1} WHERE minute = ${minute + 1}`);
        h.providers.script = ['gone'];
        const spentOut = await h.relay.fetch(pushRequest(server, endpoint, message()));
        expect(spentOut.status).toBe(503);
        expect(h.db.rows()[0].native_token).toBe(registration.nativeToken);
        expect(h.logs).toContain('provider gone, write budget spent');
    });

    it('lets the cron drop counts older than an hour', async () => {
        const start = minuteStart();
        const h = setup({ start });
        h.db.sqlite.exec(`INSERT INTO write_budget VALUES (${start / 60_000 - 61}, 3), (${start / 60_000 - 59}, 2)`);
        await h.relay.expire();
        expect(spent(h.db)).toEqual([{ minute: start / 60_000 - 59, spent: 2 }]);
    });
});

describe('REGISTRATION_WRITE_BUDGET', () => {
    it('takes a whole number of rows a minute, at least one create; the default otherwise', () => {
        expect(writeBudgetFrom(undefined)).toBe(50);
        expect(writeBudgetFrom('')).toBe(50);
        expect(writeBudgetFrom('400')).toBe(400);
        expect(writeBudgetFrom(' 5 ')).toBe(5);
        expect(writeBudgetFrom(400)).toBe(400);
        for (const bad of ['4', '0', '-10', '1.5', '1e6', 'lots']) {
            expect(writeBudgetFrom(bad), bad).toBe(50);
        }
    });

    it('sets the Worker’s budget from its environment', async () => {
        const clock = () => Date.now();
        const env = (budget?: string): Env => ({
            DB: new FakeD1() as unknown as D1Database,
            RL_REGISTRATION: new FakeRateLimit(QUOTAS.registration.limit, 60, clock),
            RL_VAPID_KEY: new FakeRateLimit(QUOTAS.vapidKey.limit, 60, clock),
            RL_GLOBAL: new FakeRateLimit(QUOTAS.global.limit, 60, clock),
            RL_REGISTER_CLIENT: new FakeRateLimit(QUOTAS.registerClient.limit, 60, clock),
            RL_REGISTRY_GLOBAL: new FakeRateLimit(QUOTAS.registryGlobal.limit, 60, clock),
            RELAY_ORIGIN: ORIGIN,
            ...(budget === undefined ? {} : { REGISTRATION_WRITE_BUDGET: budget }),
        });
        const server = newServer();
        const register = (e: Env) =>
            worker.fetch(
                new Request(`${ORIGIN}/v1/registrations`, {
                    method: 'POST',
                    body: JSON.stringify(newRegistration(server)),
                }) as Request<unknown, IncomingRequestCfProperties>,
                e,
            );
        // A minute boundary between the two calls would reset the budget; start a fresh minute.
        while (Date.now() % 60_000 > 55_000) {
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const tight = env(String(WRITE_COST.create));
        expect((await register(tight)).status).toBe(201);
        expect((await register(tight)).status).toBe(429);
        const roomy = env();
        expect((await register(roomy)).status).toBe(201);
        expect((await register(roomy)).status).toBe(201);
    });
});
