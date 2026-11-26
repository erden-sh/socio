import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeSocio, harnessData } from '../packages/app-sdk/src/check.js';
import { startDataHarness, type DataHarness } from '../src/data-harness/harness.js';

import { cleanup, manifest, world } from './helpers/plugin-world.js';

// CB-476: the data API test harness serves a plugin's `/api/data` routes
// from Socio's own app over a temporary data space, so a plugin's tests
// meet the production rules. The parity test runs one script against the
// server the plugin tests use (tests/helpers/plugin-world.ts) and the
// harness, and wants the same answers.

afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const DATASYNC = manifest('datasync', [
    { name: 'stripe', description: 'Charges, normalized' },
    { name: 'marts', description: 'Rebuilt on a timer' },
]) as Record<string, unknown> & { id: string };

async function harness(limits: Record<string, number> = {}) {
    const started = await startDataHarness({ manifest: DATASYNC, limits, analyticsMode: 'off' });
    cleanup.push(() => started.close());
    return started;
}

type Call = (
    path: string,
    method?: string,
    body?: unknown,
) => Promise<{ status: number; body: Record<string, unknown> }>;

/** The data API through the harness's in-process fetch, with its token. */
const via =
    (h: DataHarness, token = () => h.token): Call =>
    async (path, method = 'GET', body) => {
        const response = await h.fetch(`${h.apiUrl}${path}`, {
            method,
            headers: {
                authorization: `Bearer ${token()}`,
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
    };

/** What changes from one data space to the next: ids, times and durations. */
function stable(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stable);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => !['ms', 'id', 'datasetId', 'createdAt', 'updatedAt', 'expiresAt'].includes(key))
                .map(([key, item]) => [key, stable(item)]),
        );
    }
    return value;
}

/** A plugin store's day: schema, writes with assertions and RETURNING, reads, and refusals. */
async function script(api: Call) {
    const out: unknown[] = [];
    const step = async (path: string, method?: string, body?: unknown) => {
        const answer = await api(path, method, body);
        out.push({ path, method, status: answer.status, body: stable(answer.body) });
        return answer;
    };
    await step('/data/datasets/marts/tables', 'POST', {
        table: 'events',
        columns: [
            { name: 'id', type: 'INTEGER', primaryKey: true },
            { name: 'title', type: 'TEXT' },
            { name: 'seats', type: 'INTEGER' },
        ],
    });
    await step('/data/datasets/marts/batch', 'POST', {
        statements: [
            {
                sql: "INSERT INTO events (title, seats) VALUES ('Open studio', 20), ('Demo day', 40) RETURNING id, title",
                expectChanges: 2,
            },
            { sql: 'UPDATE events SET seats = seats - 1 WHERE id = ? RETURNING seats', params: [2], expectChanges: 1 },
            { op: 'insert', table: 'events', rows: [{ title: 'a' }, { title: 'b' }], expectChanges: 2 },
        ],
    });
    await step('/data/datasets/marts/batch', 'POST', {
        statements: [
            { sql: "INSERT INTO events (title) VALUES ('kept?')" },
            { sql: "UPDATE events SET seats = 0 WHERE title = 'Nope'", expectChanges: 1 },
        ],
    });
    await step('/data/datasets/marts/read-batch', 'POST', {
        statements: [{ sql: 'SELECT count(*) AS n FROM events' }, { sql: 'SELECT title FROM events ORDER BY id' }],
        maxRows: 2,
    });
    await step('/data/datasets/marts/query', 'POST', { sql: "INSERT INTO events (title) VALUES ('x')" });
    await step('/data/datasets/marts/query', 'POST', { sql: 'SELECT * FROM _writes' });
    await step('/data/datasets/marts/read-batch', 'POST', {
        statements: Array.from({ length: 33 }, () => ({ sql: 'SELECT 1' })),
    });
    await step('/data/datasets/stripe/batch', 'POST', { statements: [{ sql: 'DROP TABLE events' }] });
    await step('/data/datasets/marts');
    return out;
}

describe('the data API test harness (CB-476)', () => {
    it('answers a plugin’s script exactly as the server does', async () => {
        const server = await world({ pluginQueryMaxRows: 4 });
        const { api } = await server.datasync();
        const expected = await script(api);
        const h = await harness({ pluginQueryMaxRows: 4 });
        const actual = await script(via(h));
        expect(actual).toEqual(expected);
        // The script reached the rules it was written for.
        expect(actual.map((step) => (step as { status: number }).status)).toEqual([
            200, 200, 409, 200, 400, 403, 413, 400, 200,
        ]);
        expect(h.datasets.map((item) => item.name).sort()).toEqual(['marts', 'stripe']);
    });

    it('enforces caps, batch assertions and RETURNING', async () => {
        const h = await harness({ pluginQueryMaxRows: 3 });
        const api = via(h);
        await api('/data/datasets/marts/tables', 'POST', {
            table: 'events',
            columns: [
                { name: 'id', type: 'INTEGER', primaryKey: true },
                { name: 'title', type: 'TEXT' },
            ],
        });
        const done = await api('/data/datasets/marts/batch', 'POST', {
            statements: [{ sql: "INSERT INTO events (title) VALUES ('a'), ('b') RETURNING id", expectChanges: 2 }],
        });
        expect(done.body).toMatchObject({
            result: { changes: [2], results: [{ changes: 2, lastInsertRowid: 2, columns: ['id'], rows: [[1], [2]] }] },
        });
        const failed = await api('/data/datasets/marts/batch', 'POST', {
            statements: [
                { sql: "INSERT INTO events (title) VALUES ('c')" },
                { sql: "UPDATE events SET title = 'z' WHERE id = 99", expectChanges: 1 },
            ],
        });
        expect(failed.status).toBe(409);
        expect(failed.body).toMatchObject({ code: 'expect_changes', index: 1, expected: 1, actual: 0 });
        // RETURNING past the plugin's row cap rolls everything back.
        const tooMany = await api('/data/datasets/marts/batch', 'POST', {
            statements: [{ sql: "INSERT INTO events (title) VALUES ('1'), ('2'), ('3'), ('4') RETURNING id" }],
        });
        expect(tooMany.status).toBe(413);
        const read = await api('/data/datasets/marts/query', 'POST', { sql: 'SELECT id FROM events' });
        expect(read.body).toMatchObject({ rows: [[1], [2]], truncated: false });
        await api('/data/datasets/marts/tables/events/rows', 'POST', { rows: [{ title: 'c' }, { title: 'd' }] });
        expect((await api('/data/datasets/marts/query', 'POST', { sql: 'SELECT id FROM events' })).body).toMatchObject({
            rows: [[1], [2], [3]],
            truncated: true,
        });
    });

    it('spends the plugin’s own budget, read batches as one operation, and an admin’s raise applies at once', async () => {
        const h = await harness({ pluginStatementsPerMinute: 3 });
        const api = via(h);
        const batch = { statements: Array.from({ length: 10 }, () => ({ sql: 'SELECT 1' })) };
        expect((await api('/data/datasets/marts/read-batch', 'POST', batch)).status).toBe(200);
        expect((await api('/data/datasets/marts/read-batch', 'POST', batch)).status).toBe(200);
        expect((await api('/data/datasets/marts')).status).toBe(200);
        const over = await api('/data/datasets/marts');
        expect(over.status).toBe(429);
        expect(String(over.body.error)).toMatch(/this plugin may make 3 a minute/);
        expect(h.setBudget(10)).toMatchObject({ statementsPerMinute: 10, override: 10, workspaceDefault: 3 });
        expect((await api('/data/datasets/marts')).status).toBe(200);
    });

    it('wants the plugin’s data token and serves nothing but the data API', async () => {
        const h = await harness();
        expect((await via(h, () => 'cbdt_nope')('/data/datasets/marts')).status).toBe(401);
        expect((await h.fetch(`${h.apiUrl}/data/datasets/marts`)).status).toBe(403);
        expect((await via(h)('/settings')).status).toBe(404);
        // The identity exchange is the server's: a narrowed token reaches one need.
        const narrowed = await h.renew(['stripe']);
        expect(narrowed.datasets.map((item) => item.name)).toEqual(['stripe']);
        expect((await via(h)('/data/datasets/marts')).status).toBe(404);
        expect((await via(h)('/data/datasets/stripe')).status).toBe(200);
    });

    it('resets to an empty data space with a new token, and serves over HTTP', async () => {
        const h = await harness();
        await via(h)('/data/datasets/marts/tables', 'POST', {
            table: 'daily',
            columns: [{ name: 'day', type: 'TEXT', primaryKey: true }],
        });
        const before = h.token;
        await h.reset();
        expect(h.token).not.toBe(before);
        expect((await via(h, () => before)('/data/datasets/marts')).status).toBe(401);
        const listened = await h.listen();
        const response = await fetch(`${listened.apiUrl}/data/datasets/marts`, {
            headers: { authorization: `Bearer ${h.token}` },
        });
        expect(response.status).toBe(200);
        expect(((await response.json()) as { tables: unknown[] }).tables).toEqual([]);
        await listened.close();
    });

    it('answers fakeSocio’s data calls, in process or by URL', async () => {
        const h = await harness();
        const local = fakeSocio({ appId: 'plugin:datasync', data: h.handle });
        const listened = await h.listen();
        const remote = fakeSocio({ appId: 'plugin:datasync', data: harnessData(listened.origin) });
        for (const socio of [local, remote]) {
            const response = await socio.fetch(`${socio.apiUrl}/data/datasets/marts/query`, {
                method: 'POST',
                headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ sql: 'SELECT 41 + 1 AS n' }),
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ columns: ['n'], rows: [[42]] });
        }
        await listened.close();
    });
    it('gives each read need a writer, and the plugin reads it but can’t write it', async () => {
        const h = await startDataHarness({
            manifest: {
                id: 'acme-dash',
                display: 'embed',
                bridge: { openAnyHttps: true },
                datasets: [
                    {
                        name: 'bookings',
                        access: 'read',
                        tables: [
                            {
                                table: 'events',
                                columns: [
                                    { name: 'id', type: 'TEXT' },
                                    { name: 'seats', type: 'INTEGER' },
                                ],
                            },
                        ],
                    },
                    { name: 'notes', access: 'write' },
                ],
            },
            analyticsMode: 'off',
        });
        cleanup.push(() => h.close());
        expect(h.datasets.map((item) => [item.name, item.access]).sort()).toEqual([
            ['bookings', 'read'],
            ['notes', 'write'],
        ]);
        const source = via(h, () => h.sources.bookings!.token);
        const seeded = await source('/data/datasets/bookings/tables/events/rows', 'POST', {
            rows: [{ id: 'e1', seats: 20 }],
        });
        expect(seeded.status).toBe(200);
        const api = via(h);
        expect(
            (await api('/data/datasets/bookings/query', 'POST', { sql: 'SELECT id, seats FROM events' })).body,
        ).toMatchObject({ rows: [['e1', 20]] });
        const write = await api('/data/datasets/bookings/batch', 'POST', {
            statements: [{ sql: "INSERT INTO events (id) VALUES ('e2')" }],
        });
        expect(write.status).toBe(403);
        // A renewal renews the writers' tokens too.
        const before = h.sources.bookings!.token;
        await h.renew();
        expect(h.sources.bookings!.token).not.toBe(before);
    });

    it('leaves nothing behind when it can’t start', async () => {
        // A temp root of its own (the harness makes its directories in os.tmpdir(),
        // which reads TMPDIR): the shared one has other processes' directories
        // coming and going while this runs.
        const root = mkdtempSync(join(tmpdir(), 'cb-harness-root-'));
        cleanup.push(() => rmSync(root, { recursive: true, force: true }));
        vi.stubEnv('TMPDIR', root);
        cleanup.push(() => vi.unstubAllEnvs());
        expect(tmpdir()).toBe(root);
        await expect(startDataHarness({ manifest: { id: 'acme-empty' }, analyticsMode: 'off' })).rejects.toThrow(
            /answered 404: This plugin has no datasets/,
        );
        expect(readdirSync(root)).toEqual([]);
    });
    it('runs as a process: one JSON line on stdout, /healthz for the image’s check, a clean SIGTERM', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cb476-process-'));
        cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
        const file = join(dir, 'manifest.json');
        writeFileSync(file, JSON.stringify({ id: 'acme-events', datasets: [{ name: 'events' }] }));
        const child = spawn(process.execPath, ['--import', 'tsx', 'src/data-harness/main.ts'], {
            cwd: join(import.meta.dirname, '..'),
            env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                SOCIO_HARNESS_MANIFEST: file,
                PORT: '0',
                DATA_ANALYTICS_MODE: 'off',
                DATA_PLUGIN_STATEMENTS_PER_MINUTE: '50',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
        cleanup.push(() => child.exitCode === null && child.kill('SIGKILL'));
        let out = '';
        const line = await new Promise<string>((resolve, reject) => {
            child.stdout.on('data', (chunk: Buffer) => {
                out += chunk.toString();
                if (out.includes('\n')) {
                    resolve(out.split('\n')[0]!);
                }
            });
            void exited.then((code) => reject(new Error(`exited ${code} before listening`)));
        });
        const info = JSON.parse(line) as { origin: string; token: string; datasets: Array<{ name: string }> };
        expect(info.datasets.map((item) => item.name)).toEqual(['events']);
        expect((await fetch(`${info.origin}/healthz`)).status).toBe(200);
        const budget = await fetch(`${info.origin}/__harness/budget`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ statementsPerMinute: 7 }),
        });
        expect(await budget.json()).toMatchObject({ statementsPerMinute: 7, workspaceDefault: 50 });
        const query = await fetch(`${info.origin}/api/data/datasets/events/query`, {
            method: 'POST',
            headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ sql: 'SELECT 1 AS n' }),
        });
        expect(await query.json()).toMatchObject({ rows: [[1]] });
        child.kill('SIGTERM');
        expect(await exited).toBe(0);
    }, 60_000);
});
