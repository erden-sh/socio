// The APNs client against a fake APNs host: the provider token, each request's shape, token reuse
// with an injected clock, and every failure mapped.

import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { apnsClient, apnsOutcome } from '../src/apns-client';
import { makeApnsJwt, type ApnsCredentials } from '../src/apns-jwt';
import { APNS_JWT_REUSE_S, ApnsProviderTokens, d1SharedTokens } from '../src/apns-provider-tokens';
import { GENERIC_ALERT, messageFor, type Delivery, type Target } from '../src/providers';

import { FakeD1 } from './fakes/d1';
import { FakeHost, apnsHostsOf, apnsTestKey, jwtParts } from './fakes/native';

const START = Date.UTC(2026, 10, 9, 12, 0, 0);
const MINUTE = 60_000;

let key: Awaited<ReturnType<typeof apnsTestKey>>;
let credentials: ApnsCredentials;
const apns = new FakeHost({ status: 200 });

beforeAll(async () => {
    key = await apnsTestKey();
    // Made up: a key id and team id are 10 characters.
    credentials = { teamId: 'TEAM000001', keyId: 'KEY0000001', privateKey: key.pem };
    await apns.start();
});
afterAll(() => apns.stop());
beforeEach(() => {
    apns.requests.length = 0;
    apns.script = [];
});

const target = (overrides: Partial<Target> = {}): Target => ({
    id: randomBytes(16).toString('base64url'),
    platform: 'ios',
    nativeToken: randomBytes(32).toString('hex'),
    bundleId: 'com.ingenioventures.socio.dev',
    apnsEnv: 'sandbox',
    ...overrides,
});

const delivery = (t: Target, overrides: Partial<Delivery> = {}): Delivery => ({
    target: t,
    message: messageFor(t, randomBytes(200).toString('base64url')),
    generic: false,
    ttl: 86_400,
    topic: 'room-r1',
    nowMs: START,
    ...overrides,
});

function client(
    options: {
        tokens?: ApnsProviderTokens;
        logs?: string[];
        creds?: ApnsCredentials | null;
        shared?: ReturnType<typeof d1SharedTokens>;
    } = {},
) {
    const logs = options.logs ?? [];
    return apnsClient({
        credentials: options.creds === null ? undefined : (options.creds ?? credentials),
        tokens: options.tokens ?? new ApnsProviderTokens(),
        ...(options.shared ? { shared: options.shared } : {}),
        hosts: apnsHostsOf(apns),
        log: (event) => logs.push(event),
    });
}

const bearerOf = (index: number) => (apns.requests[index].headers.authorization ?? '').replace(/^bearer /, '');

describe('the APNs provider token', () => {
    it('is an ES256 JWT with the key id, the team id and iat, verified with the key’s public half', async () => {
        const jwt = await makeApnsJwt(credentials, 1_800_000_000);
        const { head, claims, signingInput, signature } = jwtParts(jwt);
        expect(head).toEqual({ alg: 'ES256', kid: 'KEY0000001' });
        expect(claims).toEqual({ iss: 'TEAM000001', iat: 1_800_000_000 });
        expect(signature).toHaveLength(64);
        const valid = await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            key.publicKey,
            signature,
            new TextEncoder().encode(signingInput),
        );
        expect(valid).toBe(true);
    });

    it('reads a .p8 whose newlines a secrets store kept as \\n', async () => {
        const flat = { ...credentials, privateKey: key.pem.replace(/\n/g, '\\n') };
        const { signingInput, signature } = jwtParts(await makeApnsJwt(flat, 1));
        expect(
            await crypto.subtle.verify(
                { name: 'ECDSA', hash: 'SHA-256' },
                key.publicKey,
                signature,
                new TextEncoder().encode(signingInput),
            ),
        ).toBe(true);
    });

    it('is reused for 50 minutes, then signed again', async () => {
        const tokens = new ApnsProviderTokens();
        const first = await tokens.get(credentials, START);
        expect(await tokens.get(credentials, START + 49 * MINUTE + 59_000)).toBe(first);
        const second = await tokens.get(credentials, START + APNS_JWT_REUSE_S * 1000);
        expect(second).not.toBe(first);
        expect(jwtParts(second).claims.iat).toBe(START / 1000 + APNS_JWT_REUSE_S);
        // A burst signs once.
        const burst = await Promise.all([1, 2, 3].map(() => tokens.get(credentials, START + 51 * MINUTE)));
        expect(new Set(burst)).toEqual(new Set([second]));
    });

    it('is signed again when the key rotates', async () => {
        const tokens = new ApnsProviderTokens();
        const first = await tokens.get(credentials, START);
        const rotated = { ...credentials, privateKey: (await apnsTestKey()).pem };
        expect(await tokens.get(rotated, START)).not.toBe(first);
    });
});

describe('the APNs provider token shared between isolates (D1)', () => {
    const tokenRows = (db: FakeD1) =>
        db.sqlite.prepare('SELECT * FROM apns_provider_tokens').all() as {
            key: string;
            jwt: string;
            issued_at: number;
        }[];

    it('lets two isolates reuse one token within 50 minutes, and refreshes it once after', async () => {
        const db = new FakeD1();
        const shared = d1SharedTokens(db);
        const isolateA = new ApnsProviderTokens();
        const isolateB = new ApnsProviderTokens();
        const first = await isolateA.get(credentials, START, shared);
        expect(await isolateB.get(credentials, START + 10 * MINUTE, shared)).toBe(first);
        expect(await isolateB.get(credentials, START + 49 * MINUTE, shared)).toBe(first);
        // A third isolate starting late in the window still takes it.
        expect(await new ApnsProviderTokens().get(credentials, START + 49 * MINUTE, shared)).toBe(first);
        expect(tokenRows(db)).toEqual([{ key: expect.any(String), jwt: first, issued_at: START / 1000 }]);
        // What D1 holds: the row's key is a hash, and the private key is never there. The stored
        // JWT is readable, though: decoded, it names the key id and the team id.
        const [row] = tokenRows(db);
        expect(row.key).not.toMatch(/TEAM000001|KEY0000001/);
        expect(row.key).not.toBe('');
        const { head, claims } = jwtParts(row.jwt);
        expect(head).toEqual({ alg: 'ES256', kid: 'KEY0000001' });
        expect(claims).toEqual({ iss: 'TEAM000001', iat: START / 1000 });
        const keyBody = key.pem.replace(/-----[^-]+-----|\s/g, '');
        expect(JSON.stringify(tokenRows(db))).not.toContain(keyBody.slice(0, 40));
        expect(JSON.stringify(tokenRows(db))).not.toContain('PRIVATE');

        // Past 50 minutes the first isolate to ask signs; the other takes that one.
        const later = START + 51 * MINUTE;
        const second = await isolateB.get(credentials, later, shared);
        expect(second).not.toBe(first);
        expect(await isolateA.get(credentials, later + MINUTE, shared)).toBe(second);
        expect(tokenRows(db)).toHaveLength(1);
        expect(tokenRows(db)[0].jwt).toBe(second);
    });

    it('settles a race: isolates that both sign end up sending the one token stored first', async () => {
        const shared = d1SharedTokens(new FakeD1());
        const isolates = [1, 2, 3, 4].map(() => new ApnsProviderTokens());
        const tokens = await Promise.all(isolates.map((isolate) => isolate.get(credentials, START, shared)));
        expect(new Set(tokens).size).toBe(1);
        // And they keep sending it from memory.
        for (const isolate of isolates) {
            expect(await isolate.get(credentials, START + 20 * MINUTE, shared)).toBe(tokens[0]);
        }
    });

    it('signs its own token when D1 fails, and logs only that', async () => {
        const db = new FakeD1();
        db.broken = true;
        const logs: string[] = [];
        const jwt = await new ApnsProviderTokens((event) => logs.push(event)).get(
            credentials,
            START,
            d1SharedTokens(db),
        );
        expect(jwtParts(jwt).claims.iat).toBe(START / 1000);
        expect(logs).toEqual(['apns token store failed']);
    });

    it('keeps the shared token on TooManyProviderTokenUpdates and InvalidProviderToken, and drops it on ExpiredProviderToken', async () => {
        const db = new FakeD1();
        const shared = d1SharedTokens(db);
        const isolateA = client({ shared, tokens: new ApnsProviderTokens() });
        const isolateB = client({ shared, tokens: new ApnsProviderTokens() });
        const t = target();
        for (const reason of ['TooManyProviderTokenUpdates', 'InvalidProviderToken']) {
            apns.script = [{ status: reason === 'TooManyProviderTokenUpdates' ? 429 : 403, body: { reason } }];
            // Retryable (the relay answers 503), never gone.
            expect(await isolateA.send(delivery(t)), reason).toBe('failed');
        }
        expect(await isolateB.send(delivery(t, { nowMs: START + MINUTE }))).toBe('sent');
        expect(new Set([bearerOf(0), bearerOf(1), bearerOf(2)]).size).toBe(1);
        expect(tokenRows(db)).toHaveLength(1);

        apns.script = [{ status: 403, body: { reason: 'ExpiredProviderToken' } }];
        expect(await isolateA.send(delivery(t, { nowMs: START + 2 * MINUTE }))).toBe('failed');
        expect(tokenRows(db)).toEqual([]);
        // The other isolate still holds the old one in memory until APNs refuses it there too;
        // a new isolate signs a new one, and shares it.
        await client({ shared, tokens: new ApnsProviderTokens() }).send(delivery(t, { nowMs: START + 3 * MINUTE }));
        expect(bearerOf(4)).not.toBe(bearerOf(0));
        expect(tokenRows(db)[0].jwt).toBe(bearerOf(4));
    });
});

describe('the APNs client', () => {
    it('sends an alert push to the sandbox host with the request APNs wants and no collapse id', async () => {
        const t = target();
        const d = delivery(t);
        expect(await client().send(d)).toBe('sent');
        expect(apns.requests).toHaveLength(1);
        const [request] = apns.requests;
        expect(request.method).toBe('POST');
        expect(request.path).toBe(`/sandbox/3/device/${t.nativeToken}`);
        expect(request.headers).toMatchObject({
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'apns-topic': 'com.ingenioventures.socio.dev',
            'apns-expiration': String(START / 1000 + 86_400),
            'content-type': 'application/json',
        });
        expect(request.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
        // A Topic was given; APNs gets no collapse id, so Bo's mention never replaces Ana's.
        expect(Object.keys(request.headers).filter((name) => name.includes('collapse'))).toEqual([]);
        expect(JSON.parse(request.body)).toEqual(d.message);
        expect(JSON.parse(request.body).aps).toEqual({ alert: GENERIC_ALERT, 'mutable-content': 1, sound: 'default' });
    });

    it('uses the production host for a production registration, and expiration 0 for TTL 0', async () => {
        const t = target({ apnsEnv: 'production', bundleId: 'com.ingenioventures.socio' });
        expect(await client().send(delivery(t, { ttl: 0, topic: undefined }))).toBe('sent');
        expect(apns.requests[0].path).toBe(`/production/3/device/${t.nativeToken}`);
        expect(apns.requests[0].headers['apns-expiration']).toBe('0');
        expect(apns.requests[0].headers['apns-topic']).toBe('com.ingenioventures.socio');
    });

    it('reuses one provider token across pushes, and signs again after ExpiredProviderToken', async () => {
        const c = client();
        const t = target();
        await c.send(delivery(t));
        await c.send(delivery(t, { nowMs: START + 30 * MINUTE }));
        expect(bearerOf(1)).toBe(bearerOf(0));
        apns.script = [{ status: 403, body: { reason: 'ExpiredProviderToken' } }];
        expect(await c.send(delivery(t, { nowMs: START + 31 * MINUTE }))).toBe('failed');
        await c.send(delivery(t, { nowMs: START + 32 * MINUTE }));
        expect(bearerOf(3)).not.toBe(bearerOf(0));
        expect(jwtParts(bearerOf(3)).claims.iat).toBe(START / 1000 + 32 * 60);
    });

    it('maps each answer: a gone token, a refused size, anything else', async () => {
        const cases: [number, string | undefined, string][] = [
            [410, 'Unregistered', 'gone'],
            [410, undefined, 'gone'],
            [400, 'BadDeviceToken', 'gone'],
            [413, 'PayloadTooLarge', 'too-large'],
            [413, undefined, 'too-large'],
            [400, 'BadTopic', 'failed'],
            [400, 'DeviceTokenNotForTopic', 'failed'],
            [400, 'BadExpirationDate', 'failed'],
            [403, 'InvalidProviderToken', 'failed'],
            // Retryable even if APNs ever paired them with 410: never "gone".
            [410, 'TooManyProviderTokenUpdates', 'failed'],
            [410, 'ExpiredProviderToken', 'failed'],
            [403, 'ExpiredProviderToken', 'failed'],
            [404, 'BadPath', 'failed'],
            [429, 'TooManyProviderTokenUpdates', 'failed'],
            [429, 'TooManyRequests', 'failed'],
            [500, 'InternalServerError', 'failed'],
            [503, 'ServiceUnavailable', 'failed'],
        ];
        const logs: string[] = [];
        const c = client({ logs });
        for (const [status, reason, outcome] of cases) {
            apns.script = [{ status, ...(reason ? { body: { reason } } : {}) }];
            expect(await c.send(delivery(target())), `${status} ${reason}`).toBe(outcome);
            expect(apnsOutcome(status, reason)).toBe(outcome);
        }
        expect(logs).toContain('apns 400 BadDeviceToken');
    });

    it('fails, never gone, when APNs is unreachable, the key is missing or unusable', async () => {
        const logs: string[] = [];
        const unreachable = apnsClient({
            credentials,
            tokens: new ApnsProviderTokens(),
            hosts: { sandbox: 'http://127.0.0.1:1', production: 'http://127.0.0.1:1' },
            log: (event) => logs.push(event),
        });
        expect(await unreachable.send(delivery(target()))).toBe('failed');
        expect(await client({ creds: null, logs }).send(delivery(target()))).toBe('failed');
        const broken = { ...credentials, privateKey: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' };
        expect(await client({ creds: broken, logs }).send(delivery(target()))).toBe('failed');
        expect(apns.requests).toHaveLength(0);
        expect(logs).toEqual(['apns unreachable TypeError', 'apns not configured', 'apns key unusable']);
    });

    it('logs no device token, provider token or key', async () => {
        const logs: string[] = [];
        const c = client({ logs });
        const t = target();
        for (const answer of [
            { status: 400, body: { reason: 'BadDeviceToken' } },
            { status: 500, body: t.nativeToken },
        ]) {
            apns.script = [answer];
            await c.send(delivery(t));
        }
        const text = logs.join('\n');
        expect(text).not.toContain(t.nativeToken);
        expect(text).not.toContain(bearerOf(0));
        expect(text).not.toContain('KEY0000001');
        expect(logs).toEqual(['apns 400 BadDeviceToken', 'apns 500 -']);
    });
});
