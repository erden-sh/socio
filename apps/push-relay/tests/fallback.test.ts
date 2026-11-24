// The generic fallback against a table of payload sizes: worst-case
// PushPayloads as channel.ts and service.ts fill them for notify_user, through the root's web-push.

import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { PROVIDER_LIMIT, fits, messageFor } from '../src/providers';

import { androidToken, newServer, pushRequest, registered, setup } from './helpers';

const ORIGIN = `https://${'w'.repeat(40)}.example.test`;
const THREAD = '0f8fad5b-d9cb-469f-a165-70867728950e';

function payloadOf(from: string, title: string, body: string, link: string, image = true) {
    return JSON.stringify({
        kind: 'message',
        title: `${from}: ${title}`,
        body,
        link,
        icon: `${ORIGIN}/locals/socio-octopus.png`,
        ...(image ? { image: `${ORIGIN}/notification-images/${randomBytes(32).toString('base64url')}` } : {}),
        tag: THREAD,
    });
}

// The table's rows, and whether each arrives whole (true) or as the generic alert.
const CASES: [string, string, boolean][] = [
    [
        'typical',
        payloadOf('Ada', 'Report ready', 'The weekly report is ready for review.', `/chats/${THREAD}`, false),
        true,
    ],
    ['ascii max', payloadOf('D'.repeat(40), 'T'.repeat(80), 'B'.repeat(500), `/${'l'.repeat(499)}`), true],
    ['cjk max', payloadOf('名'.repeat(40), '題'.repeat(80), '本'.repeat(500), `/chats/${THREAD}`), true],
    [
        'cjk + cjk link',
        payloadOf('名'.repeat(40), '題'.repeat(80), '本'.repeat(500), `/${encodeURI('页'.repeat(499))}`),
        false,
    ],
    ['control chars', payloadOf('D'.repeat(40), 'T'.repeat(80), '\u0001'.repeat(500), `/chats/${THREAD}`), false],
];

describe('the generic fallback', () => {
    for (const platform of ['ios', 'android'] as const) {
        it(`sends the size table's rows whole or generic on ${platform}, never an error`, async () => {
            const h = setup();
            const server = newServer();
            const { registration, endpoint } = await registered(
                h,
                server,
                platform === 'ios' ? {} : { platform, nativeToken: androidToken(), apnsEnv: undefined },
            );
            for (const [name, payload, whole] of CASES) {
                h.providers.deliveries.length = 0;
                const response = await h.relay.fetch(pushRequest(server, endpoint, payload, THREAD));
                expect(response.status, name).toBe(201);
                const [delivery] = h.providers.deliveries;
                expect(delivery.generic, name).toBe(!whole);
                expect(fits(delivery.message), name).toBe(true);
                if (!whole) {
                    // Only the registration: no ciphertext, origin or thread.
                    expect(delivery.message).toEqual(messageFor({ id: registration.id, platform }));
                    expect(Object.keys(delivery.message)).not.toContain('p');
                }
            }
        });
    }

    it('falls back exactly when the envelope passes 4096 bytes', () => {
        const id = randomBytes(16).toString('base64url');
        for (const platform of ['ios', 'android'] as const) {
            const size = (bytes: number) =>
                new TextEncoder().encode(
                    JSON.stringify(messageFor({ id, platform }, 'x'.repeat(Math.ceil((bytes * 4) / 3)))),
                ).length;
            let largest = 0;
            while (size(largest + 1) <= PROVIDER_LIMIT) {
                largest++;
            }
            const p = (bytes: number) => 'x'.repeat(Math.ceil((bytes * 4) / 3));
            expect(fits(messageFor({ id, platform }, p(largest)))).toBe(true);
            expect(fits(messageFor({ id, platform }, p(largest + 1)))).toBe(false);
            // About 2.9 KB of ciphertext, so about 2.8 KB of payload (plan 9.1's "about 2.5 KB of text").
            expect(largest).toBeGreaterThan(2900);
            expect(largest).toBeLessThan(3050);
        }
    });
});
