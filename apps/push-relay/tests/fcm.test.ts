// The FCM client against fake FCM and Google token hosts: the assertion, each message's shape, the
// access token cached until it expires, and every failure mapped.

import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FCM_SCOPE, GOOGLE_TOKEN_URL } from '../src/fcm-assertion-signer';
import { FcmAccessTokens, fcmClient, fcmOutcome, parseServiceAccount, type FcmServiceAccount } from '../src/fcm-client';
import { messageFor, type Delivery, type Target } from '../src/providers';

import { FakeHost, fcmTestKey, jwtParts, type Recorded } from './fakes/native';
import { androidToken } from './helpers';

const START = Date.UTC(2026, 10, 9, 12, 0, 0);
const MINUTE = 60_000;
const FCM_ERROR = 'type.googleapis.com/google.firebase.fcm.v1.FcmError';

let key: Awaited<ReturnType<typeof fcmTestKey>>;
let account: FcmServiceAccount;
let issued = 0;
const fcm = new FakeHost({ status: 200, body: { name: 'projects/socio-test/messages/0:1' } });
const google = new FakeHost(() => ({ status: 200, body: { access_token: `access-${++issued}`, expires_in: 3599 } }));

beforeAll(async () => {
    key = await fcmTestKey();
    // Made up: no real project or service account.
    account = { projectId: 'socio-test', clientEmail: 'relay@socio-test.iam.example.test', privateKey: key.pem };
    await Promise.all([fcm.start(), google.start()]);
});
afterAll(() => Promise.all([fcm.stop(), google.stop()]));
beforeEach(() => {
    for (const host of [fcm, google]) {
        host.requests.length = 0;
        host.script = [];
    }
});

const target = (): Target => ({
    id: randomBytes(16).toString('base64url'),
    platform: 'android',
    nativeToken: androidToken(),
    bundleId: 'com.ingenioventures.socio.preview',
    apnsEnv: null,
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

function client(options: { tokens?: FcmAccessTokens; logs?: string[]; account?: FcmServiceAccount | null } = {}) {
    const logs = options.logs ?? [];
    return fcmClient({
        account: options.account === null ? undefined : (options.account ?? account),
        tokens: options.tokens ?? new FcmAccessTokens({ tokenUrl: `${google.origin}/token` }),
        origin: fcm.origin,
        log: (event) => logs.push(event),
    });
}

const sent = (request: Recorded) => JSON.parse(request.body) as { message: Record<string, unknown> };

describe('the FCM client', () => {
    it('buys an access token with an RS256 assertion verified with the service account’s public half', async () => {
        expect(await client().send(delivery(target()))).toBe('sent');
        expect(google.requests).toHaveLength(1);
        const [request] = google.requests;
        expect(request.path).toBe('/token');
        expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');
        const form = new URLSearchParams(request.body);
        expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
        const { head, claims, signingInput, signature } = jwtParts(form.get('assertion') ?? '');
        expect(head).toEqual({ alg: 'RS256', typ: 'JWT' });
        expect(claims).toEqual({
            iss: account.clientEmail,
            scope: FCM_SCOPE,
            aud: GOOGLE_TOKEN_URL,
            iat: START / 1000,
            exp: START / 1000 + 3600,
        });
        expect(
            await crypto.subtle.verify(
                'RSASSA-PKCS1-v1_5',
                key.publicKey,
                signature,
                new TextEncoder().encode(signingInput),
            ),
        ).toBe(true);
    });

    it('sends a high-priority data message with TTL, collapse key and package, never a notification', async () => {
        const t = target();
        const d = delivery(t);
        await client().send(d);
        const [request] = fcm.requests;
        expect(request.method).toBe('POST');
        expect(request.path).toBe('/v1/projects/socio-test/messages:send');
        expect(request.headers.authorization).toBe(`Bearer access-${issued}`);
        expect(sent(request)).toEqual({
            message: {
                token: t.nativeToken,
                data: d.message,
                android: {
                    priority: 'HIGH',
                    ttl: '86400s',
                    collapse_key: 'room-r1',
                    restricted_package_name: 'com.ingenioventures.socio.preview',
                },
            },
        });
    });

    it('sends no collapse key without a Topic, and the generic message as data too', async () => {
        const t = target();
        await client().send(delivery(t, { topic: undefined, ttl: 0, message: messageFor(t), generic: true }));
        expect(sent(fcm.requests[0]).message).toEqual({
            token: t.nativeToken,
            data: { s: t.id, g: '1' },
            android: { priority: 'HIGH', ttl: '0s', restricted_package_name: 'com.ingenioventures.socio.preview' },
        });
    });

    it('caches the access token until it expires, and buys another after a 401', async () => {
        const tokens = new FcmAccessTokens({ tokenUrl: `${google.origin}/token` });
        const c = client({ tokens });
        const t = target();
        await Promise.all([c.send(delivery(t)), c.send(delivery(t))]);
        await c.send(delivery(t, { nowMs: START + 58 * MINUTE }));
        expect(google.requests).toHaveLength(1);
        // expires_in 3599: renewed a minute before it expires.
        await c.send(delivery(t, { nowMs: START + 59 * MINUTE }));
        expect(google.requests).toHaveLength(2);
        fcm.script = [{ status: 401, body: { error: { code: 401, status: 'UNAUTHENTICATED' } } }];
        expect(await c.send(delivery(t, { nowMs: START + 60 * MINUTE }))).toBe('failed');
        await c.send(delivery(t, { nowMs: START + 60 * MINUTE }));
        expect(google.requests).toHaveLength(3);
        const bearers = fcm.requests.map((request) => request.headers.authorization);
        expect(new Set(bearers.slice(0, 3)).size).toBe(1);
        expect(bearers[3]).toBe(bearers[4]);
        expect(bearers[5]).not.toBe(bearers[4]);
    });

    it('maps each answer: UNREGISTERED is gone, “too big” is too-large, anything else failed', async () => {
        const error = (code: number, status: string, message: string, errorCode?: string) => ({
            error: {
                code,
                message,
                status,
                ...(errorCode ? { details: [{ '@type': FCM_ERROR, errorCode }] } : {}),
            },
        });
        const cases: [number, unknown, string][] = [
            [404, error(404, 'NOT_FOUND', 'Requested entity was not found.', 'UNREGISTERED'), 'gone'],
            [400, error(400, 'INVALID_ARGUMENT', 'Message is too big', 'INVALID_ARGUMENT'), 'too-large'],
            [400, error(400, 'INVALID_ARGUMENT', 'MessageTooBig'), 'too-large'],
            // INVALID_ARGUMENT also covers other bad requests: only the message tells size apart.
            [
                400,
                error(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.', 'INVALID_ARGUMENT'),
                'failed',
            ],
            // A wrong project id is a 404 too: never gone, or every phone's subscription would go.
            [404, error(404, 'NOT_FOUND', 'Requested entity was not found.'), 'failed'],
            [403, error(403, 'PERMISSION_DENIED', 'SenderId mismatch', 'SENDER_ID_MISMATCH'), 'failed'],
            [429, error(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded', 'QUOTA_EXCEEDED'), 'failed'],
            [500, error(500, 'INTERNAL', 'Internal error', 'INTERNAL'), 'failed'],
            [503, error(503, 'UNAVAILABLE', 'Unavailable', 'UNAVAILABLE'), 'failed'],
            [502, 'not json', 'failed'],
        ];
        const logs: string[] = [];
        const c = client({ logs });
        for (const [status, body, outcome] of cases) {
            fcm.script = [{ status, body }];
            expect(await c.send(delivery(target())), JSON.stringify(body)).toBe(outcome);
            expect(fcmOutcome(status, typeof body === 'object' ? (body as never) : undefined)).toBe(outcome);
        }
        expect(logs).toContain('fcm 404 UNREGISTERED');
        expect(logs).toContain('fcm 502 -');
    });

    it('fails, never gone, when Google or FCM is unreachable or the service account is missing', async () => {
        const logs: string[] = [];
        google.script = [{ status: 400, body: { error: 'invalid_grant' } }];
        expect(await client({ logs }).send(delivery(target()))).toBe('failed');
        const unreachable = fcmClient({
            account,
            tokens: new FcmAccessTokens({ tokenUrl: `${google.origin}/token` }),
            origin: 'http://127.0.0.1:1',
            log: (event) => logs.push(event),
        });
        expect(await unreachable.send(delivery(target()))).toBe('failed');
        expect(await client({ account: null, logs }).send(delivery(target()))).toBe('failed');
        expect(logs).toEqual(['fcm authorize failed Error', 'fcm unreachable TypeError', 'fcm not configured']);
    });

    it('logs no registration token, access token or service account', async () => {
        const logs: string[] = [];
        const t = target();
        fcm.script = [
            {
                status: 404,
                body: {
                    error: { message: t.nativeToken, details: [{ '@type': FCM_ERROR, errorCode: 'UNREGISTERED' }] },
                },
            },
            { status: 400, body: { error: { message: 'x', status: t.nativeToken } } },
        ];
        await client({ logs }).send(delivery(t));
        await client({ logs }).send(delivery(t));
        const text = logs.join('\n');
        for (const secret of [t.nativeToken, 'access-', account.clientEmail, 'socio-test']) {
            expect(text).not.toContain(secret);
        }
    });
});

describe('the service account', () => {
    it('is read from its JSON key, and is undefined when absent or incomplete', () => {
        const json = JSON.stringify({
            type: 'service_account',
            project_id: 'socio-test',
            client_email: 'relay@socio-test.iam.example.test',
            private_key: 'PEM',
        });
        expect(parseServiceAccount(json)).toEqual({
            projectId: 'socio-test',
            clientEmail: 'relay@socio-test.iam.example.test',
            privateKey: 'PEM',
        });
        for (const bad of [
            undefined,
            '',
            '{',
            '{"project_id":"p"}',
            JSON.stringify({ ...JSON.parse(json), private_key: '' }),
        ]) {
            expect(parseServiceAccount(bad)).toBeUndefined();
        }
    });
});
