import { describe, expect, it } from 'vitest';

import { GENERIC_ALERT } from '../src/providers';
import { MAX_PUSH_BODY } from '../src/relay';

import {
    ORIGIN,
    androidToken,
    message,
    newServer,
    pushRequest,
    registered,
    setup,
    topicOf,
    webpushVersion,
} from './helpers';

/** The text with its 10th character changed. */
const flip = (text: string) => `${text.slice(0, 10)}${text[10] === 'A' ? 'B' : 'A'}${text.slice(11)}`;

const bodyOf = async (request: Request) => Buffer.from(await request.clone().arrayBuffer()).toString('base64url');

describe('the Web Push receiver', () => {
    it('is driven by the root’s web-push 3.6.7', () => {
        expect(webpushVersion).toBe('3.6.7');
    });

    it('forwards a push from the bound key to APNs, ciphertext untouched, with no collapse id', async () => {
        const h = setup();
        const server = newServer();
        const { registration, endpoint } = await registered(h, server);
        const request = pushRequest(server, endpoint, message(), 'room:r1');
        const p = await bodyOf(request);
        const response = await h.relay.fetch(request);
        expect(response.status).toBe(201);
        expect(h.providers.deliveries).toHaveLength(1);
        const [delivery] = h.providers.deliveries;
        expect(delivery).toMatchObject({
            target: {
                id: registration.id,
                platform: 'ios',
                nativeToken: registration.nativeToken,
                bundleId: 'com.ingenioventures.socio.dev',
                apnsEnv: 'sandbox',
            },
            generic: false,
            ttl: 86_400,
            topic: topicOf('room:r1'),
        });
        expect(delivery.message).toEqual({
            aps: { alert: GENERIC_ALERT, 'mutable-content': 1, sound: 'default' },
            s: registration.id,
            p,
        });
    });

    it('builds FCM data {s, p} for Android', async () => {
        const h = setup();
        const server = newServer();
        const { registration, endpoint } = await registered(h, server, {
            platform: 'android',
            nativeToken: androidToken(),
            apnsEnv: undefined,
        });
        const request = pushRequest(server, endpoint, message());
        const p = await bodyOf(request);
        expect((await h.relay.fetch(request)).status).toBe(201);
        expect(h.providers.deliveries[0].message).toEqual({ s: registration.id, p });
        expect(h.providers.deliveries[0].topic).toBeUndefined();
        expect(h.providers.deliveries[0].target.apnsEnv).toBeNull();
    });

    it('answers 401 to a missing or invalid VAPID header, never 403, 404 or 410', async () => {
        const h = setup();
        const server = newServer();
        const { endpoint } = await registered(h, server);
        const good = pushRequest(server, endpoint, message());
        const auth = good.headers.get('authorization') as string;
        const [, t, k] = auth.match(/^vapid t=([^,]+), k=(.+)$/) as RegExpMatchArray;
        const [head, claims, signature] = t.split('.');
        const variants: Record<string, string | null> = {
            missing: null,
            bearer: 'Bearer abc',
            'no k': `vapid t=${t}`,
            'no t': `vapid k=${k}`,
            'bad k': `vapid t=${t}, k=AAAA`,
            'flipped signature': `vapid t=${head}.${claims}.${flip(signature)}, k=${k}`,
            'signed by another key': `vapid t=${t}, k=${newServer().publicKey}`,
            'not a jwt': `vapid t=abc, k=${k}`,
        };
        for (const [name, header] of Object.entries(variants)) {
            const headers = new Headers(good.headers);
            if (header === null) {
                headers.delete('authorization');
            } else {
                headers.set('authorization', header);
            }
            const request = new Request(good.url, { method: 'POST', headers, body: await good.clone().arrayBuffer() });
            expect((await h.relay.fetch(request)).status, name).toBe(401);
        }
        expect(h.providers.deliveries).toHaveLength(0);
    });

    it('checks the audience against RELAY_ORIGIN, and the expiry', async () => {
        const server = newServer();
        // The relay thinks it lives elsewhere (a quick tunnel with a stale RELAY_ORIGIN): every push is a 401.
        const elsewhere = setup({ origin: 'https://tunnel.example.test' });
        const reg = await registered(elsewhere, server);
        const response = await elsewhere.relay.fetch(
            pushRequest(server, reg.endpoint.replace('https://tunnel.example.test', ORIGIN), message()),
        );
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'vapid: aud' });

        // web-push signs for 12 hours: a relay clock 13 hours on sees it expired, 25 hours back sees it too far ahead.
        for (const offset of [13 * 3600_000, -25 * 3600_000]) {
            const h = setup({ start: Date.now() + offset });
            const { endpoint } = await registered(h, server);
            const answer = await h.relay.fetch(pushRequest(server, endpoint, message()));
            expect(answer.status).toBe(401);
            expect(await answer.json()).toEqual({ error: 'vapid: exp' });
        }
    });

    it('answers 403 to another workspace’s key and forwards nothing', async () => {
        const h = setup();
        const { endpoint } = await registered(h, newServer());
        const other = newServer();
        expect((await h.relay.fetch(pushRequest(other, endpoint, message()))).status).toBe(403);
        expect(h.providers.deliveries).toHaveLength(0);
    });

    it('answers 410 for an unknown, deleted or malformed registration', async () => {
        const h = setup();
        const server = newServer();
        const { registration, endpoint } = await registered(h, server);
        await h.call('DELETE', `/v1/registrations/${registration.id}`, { secret: registration.secret });
        expect((await h.relay.fetch(pushRequest(server, endpoint, message()))).status).toBe(410);
        expect((await h.relay.fetch(pushRequest(server, `${ORIGIN}/v1/push/not*an*id`, message()))).status).toBe(410);
    });

    it('takes aes128gcm only (415), and sends the generic alert for a body past 8 KiB, never an error', async () => {
        const h = setup();
        const server = newServer();
        const { registration, endpoint } = await registered(h, server);
        const good = pushRequest(server, endpoint, message(), 'room:r1');
        const body = await good.clone().arrayBuffer();
        const withHeaders = (change: (headers: Headers) => void, payload: ArrayBuffer | Uint8Array = body) => {
            const headers = new Headers(good.headers);
            change(headers);
            return new Request(good.url, { method: 'POST', headers, body: payload });
        };
        expect((await h.relay.fetch(withHeaders((x) => x.set('content-encoding', 'aesgcm')))).status).toBe(415);
        expect((await h.relay.fetch(withHeaders((x) => x.delete('content-encoding')))).status).toBe(415);
        expect(h.providers.deliveries).toHaveLength(0);

        // Streamed past the limit with no Content-Length, then declared past it: both are read no
        // further and go out as the generic alert, with the push's TTL and Topic.
        const big = new Uint8Array(MAX_PUSH_BODY + 1);
        for (const request of [
            withHeaders((x) => x.delete('content-length'), big),
            withHeaders((x) => x.set('content-length', String(MAX_PUSH_BODY + 1)), big),
            withHeaders((x) => x.delete('content-length'), new Uint8Array(1024 * 1024)),
        ]) {
            const response = await h.relay.fetch(request);
            expect(response.status).toBe(201);
        }
        expect(h.providers.deliveries).toHaveLength(3);
        for (const delivery of h.providers.deliveries) {
            expect(delivery).toMatchObject({
                generic: true,
                message: { aps: { alert: GENERIC_ALERT, sound: 'default' }, s: registration.id },
                ttl: 24 * 60 * 60,
                topic: topicOf('room:r1'),
            });
            expect(delivery.message).not.toHaveProperty('p');
        }
        expect(h.logs).toContain('body over the read limit: generic alert');

        // At the limit it is read; it can't fit a provider, so it too is the generic alert.
        h.providers.deliveries.length = 0;
        expect(
            (await h.relay.fetch(withHeaders((x) => x.delete('content-length'), new Uint8Array(MAX_PUSH_BODY)))).status,
        ).toBe(201);
        expect(h.providers.deliveries[0].generic).toBe(true);
        expect((await h.relay.fetch(withHeaders((x) => x.delete('content-length'), new Uint8Array()))).status).toBe(
            400,
        );
        expect(h.providers.deliveries).toHaveLength(1);
    });

    it('counts an over-size push against the quotas, and a gone token still answers 410', async () => {
        const h = setup();
        const server = newServer();
        const { endpoint } = await registered(h, server);
        const good = pushRequest(server, endpoint, message());
        const headers = new Headers(good.headers);
        headers.delete('content-length');
        const big = () => new Request(good.url, { method: 'POST', headers, body: new Uint8Array(MAX_PUSH_BODY * 2) });
        h.providers.script = ['failed'];
        expect((await h.relay.fetch(big())).status).toBe(503);
        h.providers.script = ['gone'];
        expect((await h.relay.fetch(big())).status).toBe(410);
        expect(h.limits.RL_REGISTRATION.keys).toHaveLength(2);
    });

    it('drops a Topic that isn’t Web Push’s and clamps TTL to 28 days', async () => {
        const h = setup();
        const server = newServer();
        const { endpoint } = await registered(h, server);
        const good = pushRequest(server, endpoint, message());
        const headers = new Headers(good.headers);
        headers.set('topic', 'has spaces');
        headers.set('ttl', String(365 * 86_400));
        await h.relay.fetch(new Request(good.url, { method: 'POST', headers, body: await good.arrayBuffer() }));
        expect(h.providers.deliveries[0].topic).toBeUndefined();
        expect(h.providers.deliveries[0].ttl).toBe(28 * 86_400);
    });

    it('answers 503, not 410, to a provider’s “gone” for a token the phone replaced while the push was out', async () => {
        const h = setup();
        const server = newServer();
        const { registration, endpoint } = await registered(h, server);
        const rotated = 'ab'.repeat(32);
        let answer!: (outcome: 'gone') => void;
        let started!: () => void;
        const out = new Promise<void>((resolve) => {
            started = resolve;
        });
        h.providers.script = [
            () =>
                new Promise((resolve) => {
                    answer = resolve;
                    started();
                }),
        ];
        const pushed = h.relay.fetch(pushRequest(server, endpoint, message()));
        await out;
        // The phone rotates to token B while APNs is still answering about token A.
        expect(
            (
                await h.call('PUT', `/v1/registrations/${registration.id}`, {
                    secret: registration.secret,
                    nativeToken: rotated,
                })
            ).status,
        ).toBe(204);
        answer('gone');
        const response = await pushed;
        expect(response.status).toBe(503);
        expect(response.headers.get('retry-after')).toBe('30');
        // Token B survives, and the next push goes to it.
        expect(h.db.rows()[0].native_token).toBe(rotated);
        expect(h.logs).toContain('provider gone for a replaced token');
        expect((await h.relay.fetch(pushRequest(server, endpoint, message()))).status).toBe(201);
        expect(h.providers.deliveries.at(-1)?.target.nativeToken).toBe(rotated);
    });

    it('maps the providers’ outcomes: gone 410 (row kept), failed 503, a throw 503, too large resent generic', async () => {
        const h = setup();
        const server = newServer();
        const { registration, endpoint } = await registered(h, server);
        const send = () => h.relay.fetch(pushRequest(server, endpoint, message()));

        h.providers.script = ['gone'];
        expect((await send()).status).toBe(410);
        expect(h.db.rows()).toHaveLength(1);
        // The gone token is cleared: the next push answers 410 without reaching a provider, until
        // the phone sends a new token.
        expect(h.db.rows()[0].native_token).toBe('');
        const delivered = h.providers.deliveries.length;
        expect((await send()).status).toBe(410);
        expect(h.providers.deliveries).toHaveLength(delivered);
        await h.call('PUT', `/v1/registrations/${registration.id}`, {
            secret: registration.secret,
            nativeToken: registration.nativeToken,
        });

        h.providers.script = ['failed'];
        const failed = await send();
        expect(failed.status).toBe(503);
        expect(failed.headers.get('retry-after')).toBe('30');

        h.providers.script = [new Error(`fetch https://apns.test/3/device/${registration.nativeToken} failed`)];
        expect((await send()).status).toBe(503);

        h.providers.deliveries.length = 0;
        h.providers.script = ['too-large', 'sent'];
        expect((await send()).status).toBe(201);
        expect(h.providers.deliveries.map((d) => d.generic)).toEqual([false, true]);
        expect(h.providers.deliveries[1].message).toEqual({
            aps: { alert: GENERIC_ALERT, sound: 'default' },
            s: registration.id,
        });

        // Too large twice is a failure, never a 404 or 410.
        h.providers.script = ['too-large', 'too-large'];
        expect((await send()).status).toBe(503);
        expect(h.logs.join('\n')).not.toContain(registration.nativeToken);
    });
});
