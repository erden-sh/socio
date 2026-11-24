// Plugin backups, step 5 (CB-458): the routes. A plugin's page reads its
// backups' status and history and starts **Back up now** (admins only,
// audited); a plugin's own `socio.backup.request` reaches `POST
// /api/plugins/<id>/backup/request` with its own identity token and proof
// only, and is rate-limited.
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppEnv } from '@socio/foundation/http/app-env';
import type { PluginBackupStatus } from '@socio/shared/plugins/plugin-backup';

import { socioApp } from '../packages/app-sdk/src/index.js';
import type { PluginBackupsHost } from '../src/server/plugins/contract.js';
import { pluginRoutes } from '../src/server/plugins/routes.js';
import type { PluginService } from '../src/server/plugins/service.js';

import { SHARED, cleanup, world } from './helpers/plugin-world.js';

afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const pinned = `example/plugin@sha256:${'ab'.repeat(32)}`;

/** A fake backups host that records what it was asked. */
function fakeBackups(patch: Partial<PluginBackupsHost> = {}) {
    const asked: string[] = [];
    const status: PluginBackupStatus = {
        id: 'acme-notes',
        name: 'Acme Notes',
        state: 'ok',
        declared: true,
        volumes: ['data'],
        lastSuccessAt: 1_800_000_000_000,
        sizeBytes: 4096,
    };
    const host: PluginBackupsHost = {
        status: (id) => (id === 'acme-notes' ? status : undefined),
        history: () => [
            {
                snapshotId: '01JSNAPSHOT0000000000000000',
                takenAt: 1_800_000_000_000,
                reason: 'scheduled',
                run: '20270115-080000',
                version: '1.4.0',
                bytes: 4096,
            },
        ],
        backUpNow: (id) => {
            asked.push(`now ${id}`);
            return { ok: true, coalesced: asked.length > 1 };
        },
        request: (id, reason) => {
            asked.push(`request ${id} ${reason}`);
            return { ok: true, coalesced: false };
        },
        ...patch,
    };
    return { host, asked };
}

function routes(role: 'admin' | 'member', backups?: PluginBackupsHost) {
    const row = {
        id: 'acme-notes',
        version: '1.4.0',
        enabled: true,
        display: 'tab',
        config: {},
        permissions: [],
        manifest: {
            id: 'acme-notes',
            name: 'Acme Notes',
            version: '1.4.0',
            service: {
                image: pinned,
                port: 8080,
                volumes: [{ name: 'data', mount: '/data' }],
                backup: { protocol: 1, schema: 3 },
            },
        },
        replicas: 1,
        audience: 'admins',
        mode: 'service',
        revision: 'a'.repeat(64),
    };
    const plain = {
        ...row,
        id: 'acme-plain',
        manifest: { ...row.manifest, id: 'acme-plain', service: { image: pinned, port: 8080 } },
    };
    const audits: { action: string; targetId: string }[] = [];
    const plugins = {
        list: () => [row, plain],
        get: (id: string) => [row, plain].find((r) => r.id === id),
        catalogEntries: () => [],
        status: async () => ({ running: 1, state: 'running' }),
        origin: () => '',
        egress: () => ({ hosts: [], settings: [] }),
        catalogUpdate: () => undefined,
        updateReview: () => undefined,
        backups,
    } as unknown as PluginService;
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
        c.set('user', { id: `u-${role}`, name: role, role });
        await next();
    });
    app.route('/api', pluginRoutes(plugins, {} as never, { audit: (entry) => audits.push(entry) }));
    return { app, audits };
}

describe('a plugin’s page (admins)', () => {
    it('lists the live status on the Plugins page and the history on its own route', async () => {
        const { host } = fakeBackups();
        const { app } = routes('admin', host);
        const list = (await (await app.request('/api/plugins')).json()) as {
            installed: { id: string; backup?: unknown }[];
        };
        expect(list.installed[0]).toMatchObject({
            id: 'acme-notes',
            backup: {
                state: 'ok',
                declared: true,
                volumes: ['data'],
                lastSuccessAt: 1_800_000_000_000,
                sizeBytes: 4096,
            },
        });
        const answer = await app.request('/api/plugins/acme-notes/backups');
        expect(answer.status).toBe(200);
        expect(await answer.json()).toMatchObject({
            backup: { state: 'ok' },
            history: [{ reason: 'scheduled', version: '1.4.0', bytes: 4096 }],
        });
        // A plugin without state of its own has none.
        expect((await app.request('/api/plugins/acme-plain/backups')).status).toBe(404);
        expect((await app.request('/api/plugins/acme-elsewhere/backups')).status).toBe(404);
    });

    it('answers from the manifest before the backups are wired', async () => {
        const { app } = routes('admin');
        expect(await (await app.request('/api/plugins/acme-notes/backups')).json()).toEqual({
            backup: { state: 'not_backed_up', declared: true, volumes: ['data'] },
            history: [],
        });
        expect((await app.request('/api/plugins/acme-notes/backup', { method: 'POST' })).status).toBe(409);
    });

    it('starts Back up now for an admin, audits it once, and joins a second ask', async () => {
        const { host, asked } = fakeBackups();
        const { app, audits } = routes('admin', host);
        const first = await app.request('/api/plugins/acme-notes/backup', { method: 'POST' });
        expect(first.status).toBe(202);
        expect(await first.json()).toMatchObject({ coalesced: false, backup: { state: 'ok' } });
        const second = await app.request('/api/plugins/acme-notes/backup', { method: 'POST' });
        expect(await second.json()).toMatchObject({ coalesced: true });
        expect(asked).toEqual(['now acme-notes', 'now acme-notes']);
        expect(audits).toEqual([
            expect.objectContaining({ action: 'backup', targetKind: 'plugin', targetId: 'acme-notes' }),
        ]);
    });

    it('passes on the host’s refusal', async () => {
        const { host } = fakeBackups({
            backUpNow: () => ({ ok: false, status: 409, error: 'The plugin is disabled: enable it to back it up.' }),
        });
        const { app } = routes('admin', host);
        const answer = await app.request('/api/plugins/acme-notes/backup', { method: 'POST' });
        expect(answer.status).toBe(409);
        expect(await answer.json()).toEqual({ error: 'The plugin is disabled: enable it to back it up.' });
    });

    it('refuses members', async () => {
        const { host, asked } = fakeBackups();
        const { app } = routes('member', host);
        expect((await app.request('/api/plugins/acme-notes/backups')).status).toBe(403);
        expect((await app.request('/api/plugins/acme-notes/backup', { method: 'POST' })).status).toBe(403);
        expect(asked).toEqual([]);
    });
});

describe('socio.backup.request: the plugin’s own identity and proof only', () => {
    async function requestWorld(patch: Partial<PluginBackupsHost> = {}) {
        const w = await world();
        await w.platform.plugins.install('plain');
        const { host, asked } = fakeBackups(patch);
        w.platform.plugins.useBackups(host);
        const identity = w.delivered('plain')!;
        const send = (
            headers: Record<string, string>,
            body: unknown = { reason: 'Imported 1,200 notes' },
            id = 'plain',
        ) =>
            w.http.request(`http://company-brain-app:4310/api/plugins/${id}/backup/request`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...headers },
                body: JSON.stringify(body),
            });
        return { ...w, identity, asked, send };
    }

    it('accepts the plugin’s own request through the SDK, with its reason', async () => {
        const w = await requestWorld();
        const socio = socioApp({
            appId: 'plugin:plain',
            key: Buffer.alloc(32).toString('base64url'),
            env: {},
            apiUrl: 'http://company-brain-app:4310/api',
            serviceToken: () => w.identity,
            pluginProof: w.proof('plain'),
            fetch: ((url: string, init: RequestInit) => w.http.request(url, init)) as never,
        });
        expect(await socio.backup.request({ reason: 'Imported 1,200 notes' })).toEqual({ ok: true, status: 202 });
        expect(w.asked).toEqual(['request plain Imported 1,200 notes']);
    });

    it('refuses the shared token, a missing or wrong proof, another plugin’s identity and a person', async () => {
        const w = await requestWorld();
        expect(
            (await w.send({ authorization: `Bearer ${SHARED}`, 'x-cb-plugin-proof': w.proof('plain') })).status,
        ).toBe(401);
        expect((await w.send({ authorization: `Bearer ${w.identity}` })).status).toBe(401);
        expect(
            (await w.send({ authorization: `Bearer ${w.identity}`, 'x-cb-plugin-proof': w.proof('reports') })).status,
        ).toBe(401);
        expect(
            (
                await w.send(
                    { authorization: `Bearer ${w.identity}`, 'x-cb-plugin-proof': w.proof('plain') },
                    undefined,
                    'reports',
                )
            ).status,
        ).toBe(401);
        const admin = await w.as('alice');
        expect((await admin('/plugins/plain/backup/request', 'POST', { reason: 'Hi' })).status).toBe(401);
        expect(w.asked).toEqual([]);
    });

    it('wants a reason of 1 to 200 characters, as JSON', async () => {
        const w = await requestWorld();
        const auth = { authorization: `Bearer ${w.identity}`, 'x-cb-plugin-proof': w.proof('plain') };
        expect((await w.send(auth, { reason: '' })).status).toBe(400);
        expect((await w.send(auth, { reason: 'x'.repeat(201) })).status).toBe(400);
        expect((await w.send(auth, {})).status).toBe(400);
        const text = await w.http.request('http://company-brain-app:4310/api/plugins/plain/backup/request', {
            method: 'POST',
            headers: { ...auth, 'content-type': 'text/plain' },
            body: 'please',
        });
        expect(text.status).toBe(415);
        expect(w.asked).toEqual([]);
    });

    it('answers 429 with Retry-After past the limit', async () => {
        const w = await requestWorld({
            request: () => ({
                ok: false,
                status: 429,
                error: 'Too many backup requests: at most one an hour and four a day.',
                retryAfterSeconds: 1800,
            }),
        });
        const answer = await w.send({ authorization: `Bearer ${w.identity}`, 'x-cb-plugin-proof': w.proof('plain') });
        expect(answer.status).toBe(429);
        expect(answer.headers.get('retry-after')).toBe('1800');
    });
});
