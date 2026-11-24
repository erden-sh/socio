import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { BUNDLE_IDS } from '../src/relay';

import { ORIGIN, androidToken, newRegistration, newServer, setup } from './helpers';

const DAY = 24 * 60 * 60 * 1000;

describe('registrations', () => {
    it('registers a phone and keeps only what 9.1 lists, with the secret hashed and a date', async () => {
        const h = setup({ start: Date.UTC(2026, 10, 9, 15, 30) });
        const reg = newRegistration(newServer());
        const response = await h.call('POST', '/v1/registrations', reg);
        expect(response.status).toBe(201);
        expect(await response.json()).toEqual({ endpoint: `${ORIGIN}/v1/push/${reg.id}` });
        expect(h.db.rows()).toEqual([
            {
                id: reg.id,
                platform: 'ios',
                native_token: reg.nativeToken,
                bundle_id: 'com.ingenioventures.socio.dev',
                apns_env: 'sandbox',
                vapid_key: reg.vapidKey,
                secret_hash: createHash('sha256').update(reg.secret).digest('base64url'),
                created_at: Date.UTC(2026, 10, 9, 15, 30) / 1000,
                refreshed_on: '2026-11-09',
            },
        ]);
        expect(JSON.stringify(h.db.rows())).not.toContain(reg.secret);
    });

    it('answers a retry with the same id and secret with 200 and the same endpoint, storing a changed token', async () => {
        const h = setup();
        const reg = newRegistration(newServer());
        expect((await h.call('POST', '/v1/registrations', reg)).status).toBe(201);
        const again = await h.call('POST', '/v1/registrations', reg);
        expect(again.status).toBe(200);
        expect(await again.json()).toEqual({ endpoint: `${ORIGIN}/v1/push/${reg.id}` });
        const changed = { ...reg, nativeToken: 'ab'.repeat(32) };
        expect((await h.call('POST', '/v1/registrations', changed)).status).toBe(200);
        expect(h.db.rows()).toHaveLength(1);
        expect(h.db.rows()[0].native_token).toBe('ab'.repeat(32));
    });

    it('refuses the same id with another secret (403) and never rebinds it (409)', async () => {
        const h = setup();
        const server = newServer();
        const reg = newRegistration(server);
        await h.call('POST', '/v1/registrations', reg);
        const otherSecret = newRegistration(server, { id: reg.id });
        expect((await h.call('POST', '/v1/registrations', otherSecret)).status).toBe(403);
        for (const change of [
            { vapidKey: newServer().publicKey },
            { bundleId: 'com.ingenioventures.socio' },
            { apnsEnv: 'production' },
            { platform: 'android', nativeToken: androidToken(), apnsEnv: undefined },
        ]) {
            expect((await h.call('POST', '/v1/registrations', { ...reg, ...change })).status).toBe(409);
        }
        expect(h.db.rows()[0].vapid_key).toBe(reg.vapidKey);
    });

    it('takes the three variants on both platforms, and nothing else', async () => {
        const h = setup();
        const server = newServer();
        for (const bundleId of BUNDLE_IDS) {
            expect((await h.call('POST', '/v1/registrations', newRegistration(server, { bundleId }))).status).toBe(201);
            const android = newRegistration(server, {
                bundleId,
                platform: 'android',
                nativeToken: androidToken(),
                apnsEnv: undefined,
            });
            expect((await h.call('POST', '/v1/registrations', android)).status).toBe(201);
        }
        const bad: Record<string, unknown>[] = [
            { bundleId: 'com.example.other' },
            { bundleId: 'com.ingenioventures.socio.dev.personal' },
            { platform: 'web' },
            { apnsEnv: undefined },
            { apnsEnv: 'development' },
            { platform: 'android', nativeToken: androidToken() },
            { nativeToken: 'not hex' },
            { nativeToken: '' },
            { vapidKey: 'short' },
            { vapidKey: Buffer.alloc(65, 3).toString('base64url') },
            { id: 'short' },
            { id: 'has spaces in it, which ids never have' },
            { secret: 'too-short' },
            { secret: 42 },
        ];
        for (const change of bad) {
            const response = await h.call('POST', '/v1/registrations', newRegistration(server, change));
            expect(response.status, JSON.stringify(change)).toBe(400);
        }
        expect((await h.call('POST', '/v1/registrations', 'not json')).status).toBe(400);
        expect((await h.call('POST', '/v1/registrations', '[1]')).status).toBe(400);
        expect((await h.call('POST', '/v1/registrations', { pad: 'x'.repeat(9000) })).status).toBe(413);
    });

    it('accepts the VAPID key with padding and stores its canonical form', async () => {
        const h = setup();
        const server = newServer();
        await h.call('POST', '/v1/registrations', newRegistration(server, { vapidKey: `${server.publicKey}=` }));
        expect(h.db.rows()[0].vapid_key).toBe(server.publicKey);
    });

    it('refreshes with the secret: a new token and today’s date (PUT)', async () => {
        const h = setup({ start: Date.UTC(2026, 10, 9) });
        const reg = newRegistration(newServer());
        await h.call('POST', '/v1/registrations', reg);
        h.advance(3 * DAY);
        expect((await h.call('PUT', `/v1/registrations/${reg.id}`, { secret: reg.secret })).status).toBe(204);
        expect(h.db.rows()[0]).toMatchObject({ native_token: reg.nativeToken, refreshed_on: '2026-11-12' });
        const token = 'cd'.repeat(32);
        expect(
            (await h.call('PUT', `/v1/registrations/${reg.id}`, { secret: reg.secret, nativeToken: token })).status,
        ).toBe(204);
        expect(h.db.rows()[0].native_token).toBe(token);
        expect(
            (await h.call('PUT', `/v1/registrations/${reg.id}`, { secret: reg.secret, nativeToken: 'x' })).status,
        ).toBe(400);
        const wrong = newRegistration(newServer()).secret;
        expect((await h.call('PUT', `/v1/registrations/${reg.id}`, { secret: wrong })).status).toBe(403);
        expect((await h.call('PUT', `/v1/registrations/${reg.id}`, {})).status).toBe(400);
        const unknown = newRegistration(newServer());
        expect((await h.call('PUT', `/v1/registrations/${unknown.id}`, { secret: unknown.secret })).status).toBe(410);
    });

    it('never lets a daily refresh undo a token rotation that raced it', async () => {
        const h = setup();
        const reg = newRegistration(newServer());
        await h.call('POST', '/v1/registrations', reg);
        const rotated = 'ef'.repeat(32);
        // The daily refresh (no token) reads the row, then pauses before its write while the
        // rotation reads and writes; then the refresh finishes last.
        let release!: () => void;
        const paused = new Promise<void>((resolve) => {
            release = resolve;
        });
        let refreshRead = false;
        let firstWrite = true;
        h.db.before = async (query) => {
            if (query.startsWith('SELECT * FROM registrations') && !refreshRead) {
                refreshRead = true;
                return;
            }
            if (query.startsWith('UPDATE registrations') && firstWrite && refreshRead) {
                firstWrite = false;
                await paused;
            }
        };
        const refresh = h.call('PUT', `/v1/registrations/${reg.id}`, { secret: reg.secret });
        await vi.waitFor(() => expect(firstWrite).toBe(false));
        const rotation = await h.call('PUT', `/v1/registrations/${reg.id}`, {
            secret: reg.secret,
            nativeToken: rotated,
        });
        expect(rotation.status).toBe(204);
        expect(h.db.rows()[0].native_token).toBe(rotated);
        release();
        expect((await refresh).status).toBe(204);
        expect(h.db.rows()[0].native_token).toBe(rotated);
        // The refresh wrote the date only.
        expect(h.db.queries).toContain('UPDATE registrations SET refreshed_on = ? WHERE id = ?');
    });

    it('deletes with the secret (DELETE); an unknown id is gone', async () => {
        const h = setup();
        const reg = newRegistration(newServer());
        await h.call('POST', '/v1/registrations', reg);
        const wrong = newRegistration(newServer()).secret;
        expect((await h.call('DELETE', `/v1/registrations/${reg.id}`, { secret: wrong })).status).toBe(403);
        expect(h.db.rows()).toHaveLength(1);
        expect((await h.call('DELETE', `/v1/registrations/${reg.id}`, { secret: reg.secret })).status).toBe(204);
        expect(h.db.rows()).toHaveLength(0);
        expect((await h.call('DELETE', `/v1/registrations/${reg.id}`, { secret: reg.secret })).status).toBe(410);
    });

    it('needs no cookie and sets none', async () => {
        const h = setup();
        const reg = newRegistration(newServer());
        const response = await h.call('POST', '/v1/registrations', reg);
        expect(response.headers.get('set-cookie')).toBeNull();
    });
});
