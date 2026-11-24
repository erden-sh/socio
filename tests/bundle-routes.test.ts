import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';

import type { AppEnv } from '@socio/foundation/http/app-env';

import { exportBundle } from '../src/server/bundle/export.js';
import { bundleRoutes } from '../src/server/bundle/routes.js';

import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

async function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-bundle-routes-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const source = testDatabase();
    source
        .prepare(
            "INSERT INTO issues(id, number, title, body, status, priority, kind, reporterId, source, createdAt, updatedAt) VALUES ('i1', 7, 'Seven', 'Body', 'open', 'low', 'bug', 'import', 'web', 1, 1)",
        )
        .run();
    mkdirSync(join(dir, 'backups', 'bundles'), { recursive: true });
    await exportBundle({
        db: source,
        out: join(dir, 'backups', 'bundles', 'first'),
        selection: { issues: [7], spaces: [], pages: [] },
        deny: new Set(['denied']),
        source: { origin: 'https://source.example.test', label: 'SRC', issuePrefix: 'CB' },
        appVersion: '0.40.0',
        readFile: async () => undefined,
    });
    // Outside bundles/: never readable by name.
    cpSync(join(dir, 'backups', 'bundles', 'first'), join(dir, 'outside'), { recursive: true });
    const db = testDatabase();
    const snapshot = vi.fn(async () => join(dir, 'copy.sqlite'));
    const routes = bundleRoutes({
        db,
        backupDir: join(dir, 'backups'),
        files: { put: vi.fn() },
        safety: { lastBackupAt: () => Date.now(), snapshot },
        log: () => undefined,
    });
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
        const role = c.req.header('x-role') ?? 'member';
        c.set('user', { id: `u-${role}`, name: role, role } as never);
        await next();
    });
    app.route('/api', routes);
    const call = (method: string, path: string, role: string, body?: unknown) =>
        app.request(path, {
            method,
            headers: { 'x-role': role, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    return { db, routes, call, snapshot };
}

it('lets only admins list and import bundles (CB-390: the former operator route)', async () => {
    const { call } = await setup();
    for (const role of ['member']) {
        expect((await call('GET', '/api/operator/bundles', role)).status).toBe(403);
        expect((await call('POST', '/api/operator/bundles/import', role, { bundle: 'first' })).status).toBe(403);
        expect((await call('GET', '/api/operator/bundles/import', role)).status).toBe(403);
    }
    const listed = await call('GET', '/api/operator/bundles', 'admin');
    expect(await listed.json()).toEqual({
        bundles: [expect.objectContaining({ name: 'first', source: expect.objectContaining({ label: 'SRC' }) })],
    });
});

it('names bundles, never paths', async () => {
    const { call } = await setup();
    for (const bundle of ['../outside', '/etc', '..', 'a/b', '.hidden']) {
        expect((await call('POST', '/api/operator/bundles/import', 'admin', { bundle })).status).toBe(400);
    }
});

it('runs a dry run, then an apply, in the background, one at a time', async () => {
    const { call, routes, db, snapshot } = await setup();
    const started = await call('POST', '/api/operator/bundles/import', 'admin', { bundle: 'first' });
    expect(started.status).toBe(202);
    expect((await call('POST', '/api/operator/bundles/import', 'admin', { bundle: 'first' })).status).toBe(409);
    await routes.idle();
    const dry = (await (await call('GET', '/api/operator/bundles/import', 'admin')).json()) as {
        run: { state: string; report: { counts: Record<string, unknown> } };
    };
    expect(dry.run.state).toBe('done');
    expect(dry.run.report.counts.issue).toEqual({ create: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM issues').get()).toEqual({ n: 0 });

    expect((await call('POST', '/api/operator/bundles/import', 'admin', { bundle: 'first', apply: true })).status).toBe(
        202,
    );
    await routes.idle();
    const applied = (await (await call('GET', '/api/operator/bundles/import', 'admin')).json()) as {
        run: { state: string; by: string };
    };
    expect(applied.run).toMatchObject({ state: 'done', by: 'u-admin' });
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT number, source FROM issues').get()).toEqual({ number: 7, source: 'import' });
    expect(db.prepare('SELECT startedBy FROM import_runs').get()).toEqual({ startedBy: 'u-admin' });
});

it('reports a missing bundle as a failed run', async () => {
    const { call, routes } = await setup();
    await call('POST', '/api/operator/bundles/import', 'admin', { bundle: 'nope' });
    await routes.idle();
    const body = (await (await call('GET', '/api/operator/bundles/import', 'admin')).json()) as {
        run: { state: string; error: string };
    };
    expect(body.run).toMatchObject({ state: 'failed', error: 'There is no bundle there.' });
});
