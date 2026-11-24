// The relay with its real APNs and FCM clients, pointed at the fakes: a Socio server's push (the
// root's web-push) reaches each provider untouched, and each provider answer becomes the relay's.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { apnsClient } from '../src/apns-client';
import { ApnsProviderTokens } from '../src/apns-provider-tokens';
import { FcmAccessTokens, fcmClient } from '../src/fcm-client';
import { GENERIC_ALERT, nativeProviders } from '../src/providers';

import { FakeHost, apnsHostsOf, apnsTestKey, fcmTestKey } from './fakes/native';
import { androidToken, message, newServer, pushRequest, registered, setup, topicOf } from './helpers';

const apns = new FakeHost({ status: 200 });
const fcm = new FakeHost({ status: 200, body: { name: 'projects/socio-test/messages/0:1' } });
const google = new FakeHost({ status: 200, body: { access_token: 'access-1', expires_in: 3599 } });
let providers: ReturnType<typeof nativeProviders>;

beforeAll(async () => {
    await Promise.all([apns.start(), fcm.start(), google.start()]);
    const log = () => {};
    providers = nativeProviders({
        apns: apnsClient({
            credentials: { teamId: 'TEAM000001', keyId: 'KEY0000001', privateKey: (await apnsTestKey()).pem },
            tokens: new ApnsProviderTokens(),
            hosts: apnsHostsOf(apns),
            log,
        }),
        fcm: fcmClient({
            account: {
                projectId: 'socio-test',
                clientEmail: 'relay@socio-test.iam.example.test',
                privateKey: (await fcmTestKey()).pem,
            },
            tokens: new FcmAccessTokens({ tokenUrl: `${google.origin}/token` }),
            origin: fcm.origin,
            log,
        }),
    });
});
afterAll(() => Promise.all([apns.stop(), fcm.stop(), google.stop()]));
beforeEach(() => {
    for (const host of [apns, fcm, google]) {
        host.requests.length = 0;
        host.script = [];
    }
});

const ciphertextOf = async (request: Request) => Buffer.from(await request.clone().arrayBuffer()).toString('base64url');

describe('a push forwarded to the providers', () => {
    it('reaches APNs with the ciphertext untouched, and two pushes with one Topic both go out', async () => {
        const h = setup({ providers });
        const server = newServer();
        const { registration, endpoint } = await registered(h, server);
        const first = pushRequest(server, endpoint, message('Ana: the launch moved'), 'room:r1');
        const second = pushRequest(server, endpoint, message('Bo: @you can you check'), 'room:r1');
        const ciphertexts = [await ciphertextOf(first), await ciphertextOf(second)];
        expect((await h.relay.fetch(first)).status).toBe(201);
        expect((await h.relay.fetch(second)).status).toBe(201);
        expect(apns.requests).toHaveLength(2);
        for (const [index, request] of apns.requests.entries()) {
            expect(request.path).toBe(`/sandbox/3/device/${registration.nativeToken}`);
            expect(request.headers['apns-collapse-id']).toBeUndefined();
            expect(JSON.parse(request.body)).toEqual({
                aps: { alert: GENERIC_ALERT, 'mutable-content': 1, sound: 'default' },
                s: registration.id,
                p: ciphertexts[index],
            });
        }
    });

    it('reaches FCM as data with the Topic as collapse key', async () => {
        const h = setup({ providers });
        const server = newServer();
        const { registration, endpoint } = await registered(h, server, {
            platform: 'android',
            nativeToken: androidToken(),
            apnsEnv: undefined,
        });
        const request = pushRequest(server, endpoint, message(), 'room:r1');
        const p = await ciphertextOf(request);
        expect((await h.relay.fetch(request)).status).toBe(201);
        const { message: sent } = JSON.parse(fcm.requests[0].body) as { message: Record<string, unknown> };
        expect(sent.data).toEqual({ s: registration.id, p });
        expect(sent.android).toMatchObject({ priority: 'HIGH', ttl: '86400s', collapse_key: topicOf('room:r1') });
        expect(sent.notification).toBeUndefined();
    });

    it('answers 410 when APNs or FCM says the token is gone', async () => {
        const h = setup({ providers });
        const server = newServer();
        const ios = await registered(h, server);
        apns.script = [{ status: 400, body: { reason: 'BadDeviceToken' } }];
        expect((await h.relay.fetch(pushRequest(server, ios.endpoint, message()))).status).toBe(410);
        apns.script = [{ status: 410, body: { reason: 'Unregistered', timestamp: 1_800_000_000_000 } }];
        expect((await h.relay.fetch(pushRequest(server, ios.endpoint, message()))).status).toBe(410);

        const android = await registered(h, server, {
            platform: 'android',
            nativeToken: androidToken(),
            apnsEnv: undefined,
        });
        fcm.script = [
            {
                status: 404,
                body: {
                    error: {
                        code: 404,
                        status: 'NOT_FOUND',
                        details: [
                            {
                                '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                                errorCode: 'UNREGISTERED',
                            },
                        ],
                    },
                },
            },
        ];
        expect((await h.relay.fetch(pushRequest(server, android.endpoint, message()))).status).toBe(410);
    });

    it('resends a push the provider finds too large as the generic alert', async () => {
        const h = setup({ providers });
        const server = newServer();
        const ios = await registered(h, server);
        apns.script = [{ status: 413, body: { reason: 'PayloadTooLarge' } }];
        expect((await h.relay.fetch(pushRequest(server, ios.endpoint, message()))).status).toBe(201);
        expect(apns.requests).toHaveLength(2);
        expect(JSON.parse(apns.requests[1].body)).toEqual({
            aps: { alert: GENERIC_ALERT, sound: 'default' },
            s: ios.registration.id,
        });

        const android = await registered(h, server, {
            platform: 'android',
            nativeToken: androidToken(),
            apnsEnv: undefined,
        });
        fcm.script = [
            { status: 400, body: { error: { code: 400, message: 'Message is too big', status: 'INVALID_ARGUMENT' } } },
        ];
        expect((await h.relay.fetch(pushRequest(server, android.endpoint, message()))).status).toBe(201);
        expect(JSON.parse(fcm.requests[1].body).message.data).toEqual({ s: android.registration.id, g: '1' });
    });

    it('answers 503, never 404 or 410, to anything else', async () => {
        const h = setup({ providers });
        const server = newServer();
        const ios = await registered(h, server);
        for (const answer of [
            { status: 403, body: { reason: 'InvalidProviderToken' } },
            { status: 400, body: { reason: 'BadTopic' } },
            { status: 404, body: { reason: 'BadPath' } },
            { status: 429, body: { reason: 'TooManyProviderTokenUpdates' } },
            { status: 500 },
        ]) {
            apns.script = [answer];
            const response = await h.relay.fetch(pushRequest(server, ios.endpoint, message()));
            expect(response.status, answer.body?.reason).toBe(503);
            expect(response.headers.get('retry-after')).toBe('30');
        }
    });
});
