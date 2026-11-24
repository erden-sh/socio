// A Socio server deletes its subscription on a 404 or 410 (src/server/notifications/push.ts), so
// nothing but a gone registration may answer either.

import { describe, expect, it } from 'vitest';

import { message, newRegistration, newServer, pushRequest, registered, setup } from './helpers';

const ID = 'A'.repeat(22);
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const PATHS = [
    '/',
    '/favicon.ico',
    '/v1',
    '/v1/',
    '/v1/nothing',
    '/v1/registrations',
    '/v1/registrations/',
    `/v1/registrations/${ID}`,
    `/v1/registrations/${ID}/extra`,
    '/v1/registrations/bad*id',
    '/v1/push',
    '/v1/push/',
    `/v1/push/${ID}`,
    `/v1/push/${ID}/extra`,
    '/v2/push/x',
    '/push/x',
];

describe('routes', () => {
    it('never answers 404, and 410 only on the registration and push routes', async () => {
        const h = setup();
        for (const method of METHODS) {
            for (const path of PATHS) {
                const body = method === 'GET' || method === 'HEAD' ? undefined : '{}';
                const response = await h.call(method, path, body);
                const where = `${method} ${path}`;
                expect(response.status, where).not.toBe(404);
                if (response.status === 410) {
                    expect(where).toMatch(/^(POST \/v1\/push\/[^/]*|(PUT|DELETE) \/v1\/registrations\/A+)$/);
                }
            }
        }
    });

    it('answers 400 to unknown routes and 405 to a wrong method on a known one', async () => {
        const h = setup();
        expect((await h.call('GET', '/')).status).toBe(400);
        expect((await h.call('POST', '/v1/nothing', '{}')).status).toBe(400);
        expect((await h.call('GET', '/favicon.ico')).status).toBe(400);
        expect((await h.call('GET', '/v1/registrations')).status).toBe(405);
        const patch = await h.call('PATCH', `/v1/registrations/${ID}`, '{}');
        expect(patch.status).toBe(405);
        expect(patch.headers.get('allow')).toBe('PUT, DELETE');
        expect((await h.call('GET', `/v1/push/${ID}`)).status).toBe(405);
        expect((await h.call('PUT', '/v1/registrations/bad*id', '{}')).status).toBe(400);
    });

    it('answers 503 with Retry-After on every route when D1 fails, and logs no identifier', async () => {
        const h = setup();
        const server = newServer();
        const { registration, endpoint } = await registered(h, server);
        h.db.broken = true;
        const fresh = newRegistration(server);
        const answers = [
            await h.call('POST', '/v1/registrations', fresh),
            await h.call('PUT', `/v1/registrations/${registration.id}`, { secret: registration.secret }),
            await h.call('DELETE', `/v1/registrations/${registration.id}`, { secret: registration.secret }),
            await h.relay.fetch(pushRequest(server, endpoint, message())),
        ];
        for (const answer of answers) {
            expect(answer.status).toBe(503);
            expect(answer.headers.get('retry-after')).toBe('30');
        }
        await expect(h.relay.expire()).rejects.toThrow();
        const logs = h.logs.join('\n');
        for (const value of [registration.id, registration.secret, registration.nativeToken, server.publicKey]) {
            expect(logs).not.toContain(value);
        }
    });

    it('answers 503 to everything while RELAY_ORIGIN isn’t an origin', async () => {
        for (const origin of ['', 'relay.example.test', 'https://relay.example.test/', 'ftp://relay.example.test']) {
            const h = setup({ origin });
            expect((await h.call('POST', '/v1/registrations', newRegistration(newServer()))).status).toBe(503);
        }
    });
});
