import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';

import { migrateDatabase } from '@socio/data/migrate';
import type { AppEnv } from '@socio/foundation/http/app-env';
import type { User } from '@socio/shared/types';

import { createApp } from '../src/server/app.js';
import type { AppEdge, AppRuntime } from '../src/server/main.js';
import type { ServerModule } from '../src/server/modules/contract.js';
import { schemas, serverModules } from '../src/server/modules/index.js';
import type { TelegramChannel } from '../src/server/telegram/telegram-channel.js';

import { staticAuth } from './fixtures/static-auth.js';
import { LocalAgentRunner, Runner } from './helpers/runners.js';
import type { TestPlatform } from './helpers/test-platform.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const config = {
    baseUrl: '',
    apiKey: '',
    model: '',
    voiceName: 'marin',
    runtimeUrl: '',
};
const alice: User = { id: 'alice', name: 'Alice', role: 'admin' };
const bob: User = { id: 'bob', name: 'Bob', role: 'member' };

/**
 * The app's runtime over a test database with the given modules, or over
 * `path`, a database a migration made (the runner on it too).
 */
async function runtimeWith(modules: readonly ServerModule[], path?: string) {
    const { platform, runtime, edge, dispose } = await makeTestRuntime({
        config,
        modules,
        ...(path === undefined ? {} : { database: path, runner: new LocalAgentRunner(path) }),
    });
    cleanup.push(dispose);
    return { platform, runtime, edge };
}
/** The app over a runtime, signed in as `user`. */
function appFor(built: { platform: TestPlatform; runtime: AppRuntime; edge: AppEdge }, user: User = alice) {
    const { platform, runtime, edge } = built;
    return createApp({
        store: platform.store,
        runner: new Runner(platform.store, { mode: 'live', baseUrl: '' }),
        config: { mode: 'live', baseUrl: '' },
        edge,
        runtime,
        auth: staticAuth(user),
    });
}
const json = (body: unknown) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

/** A module with its own table and its own prefix. */
const notesModule: ServerModule = {
    id: 'notes',
    migrations: [
        {
            version: 1,
            name: 'notes',
            up: 'CREATE TABLE notes(id INTEGER PRIMARY KEY, text TEXT NOT NULL, userId TEXT NOT NULL)',
        },
    ],
    routes: ({ db }) => {
        const app = new Hono<AppEnv>();
        app.get('/notes', (c) => c.json(db.prepare('SELECT text, userId FROM notes ORDER BY id').all()));
        app.post('/notes', async (c) => {
            const { text } = (await c.req.json()) as { text: string };
            db.prepare('INSERT INTO notes (text, userId) VALUES (?, ?)').run(text, c.get('user').id);
            return c.json({ ok: true }, 201);
        });
        return app;
    },
};

it('mounts a new module under its prefix, on a table its migration created', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-modules-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'db.sqlite');
    const sets = [...schemas, notesModule];
    const backupDirectory = join(dir, 'backups');
    expect(migrateDatabase(path, sets, { backupDirectory }).steps.at(-1)).toEqual({
        module: 'notes',
        version: 1,
        name: 'notes',
        action: 'apply',
    });
    expect(migrateDatabase(path, sets, { backupDirectory }).steps).toEqual([]);

    const app = appFor(await runtimeWith([...serverModules, notesModule], path));
    expect((await app.request('/api/notes', json({ text: 'Hello' }))).status).toBe(201);
    expect(await (await app.request('/api/notes')).json()).toEqual([{ text: 'Hello', userId: 'alice' }]);
    // The existing modules still answer on their paths.
    expect((await app.request('/api/issues')).status).toBe(200);
    expect((await app.request('/api/runs')).status).toBe(200);
    expect((await app.request('/api/learning/skills')).status).toBe(200);
    expect((await app.request('/api/telegram/link')).status).toBe(200);

    // Code without the module runs on the database it migrated, which it only
    // expanded (CB-108), and refuses it once a contract migration of it ran.
    expect(migrateDatabase(path, schemas, { backupDirectory }).steps).toEqual([]);
    const contracted = new DatabaseSync(path);
    contracted.exec(
        "CREATE TABLE schema_readers(module TEXT PRIMARY KEY, minVersion INTEGER NOT NULL); INSERT INTO schema_readers VALUES ('notes', 1)",
    );
    contracted.close();
    expect(() => migrateDatabase(path, schemas, { backupDirectory })).toThrow(/module "notes"/);
});

it('keeps every route, middleware included, under the module’s own paths', async () => {
    const route = (register: (app: Hono<AppEnv>) => void): ServerModule => ({
        id: 'rogue',
        routes: () => {
            const app = new Hono<AppEnv>();
            register(app);
            return app;
        },
    });
    for (const rogue of [
        route((app) => app.get('/issues/steal', (c) => c.json({}))),
        route((app) => app.use('*', async (_c, next) => next())),
        route((app) => app.get('/rogues', (c) => c.json({}))),
    ]) {
        const built = await runtimeWith([...serverModules, rogue]);
        expect(() => appFor(built)).toThrow(/Module "rogue" registers .* outside \/api\/rogue/);
    }
    const fine = route((app) => {
        app.get('/rogue', (c) => c.json({}));
        app.get('/rogue/:id', (c) => c.json({}));
    });
    const fineBuilt = await runtimeWith([fine]);
    expect(() => appFor(fineBuilt)).not.toThrow();
});

it('rejects duplicate module ids and paths', async () => {
    await expect(runtimeWith([notesModule, notesModule])).rejects.toThrow(/registered twice/);
    await expect(runtimeWith([...serverModules, { id: 'files', paths: ['issues'] }])).rejects.toThrow(
        /"issues" and "files" both claim \/api\/issues/,
    );
    await expect(runtimeWith([{ id: 'Notes' }])).rejects.toThrow(/Invalid module id/);
});

it('guards every path of an admin module', async () => {
    const secret: ServerModule = {
        id: 'secret',
        access: 'admin',
        routes: () =>
            new Hono<AppEnv>()
                .get('/secret', (c) => c.json({ ok: true }))
                .get('/secret/:id', (c) => c.json({ ok: true })),
    };
    const built = await runtimeWith([secret]);
    for (const path of ['/api/secret', '/api/secret/1']) {
        expect((await appFor(built, alice).request(path)).status).toBe(200);
        expect((await appFor(built, bob).request(path)).status).toBe(403);
    }
    // The GitHub App's settings are an admin module; Runs lists a member's
    // own turns (CB-128).
    const all = await runtimeWith(serverModules);
    expect((await appFor(all, bob).request('/api/github')).status).toBe(403);
    expect((await appFor(all, bob).request('/api/runs')).status).toBe(200);
});

it('schedules ticks, starts in order and stops in reverse, each stop even after a failure', async () => {
    const events: string[] = [];
    const hooks = (id: string, extra: Partial<ServerModule> = {}) =>
        ({
            id,
            start: async () => {
                events.push(`start ${id}`);
            },
            stop: () => {
                events.push(`stop ${id}`);
            },
            ...extra,
        }) satisfies ServerModule;
    let stoppedB = false;
    const { platform } = await runtimeWith([
        hooks('a', {
            tick: { everyMs: 1000, run: () => events.push('tick a') },
        }),
        hooks('b', {
            stop: () => {
                events.push('stop b');
                // Only the test's stop fails: the runtime's dispose stops the platform again.
                if (!stoppedB) {
                    stoppedB = true;
                    throw new Error('b failed to stop');
                }
            },
        }),
        hooks('c', {
            start: () => {
                events.push('start c');
                throw new Error('c failed to start');
            },
        }),
    ]);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await expect(platform.start()).rejects.toThrow('c failed to start');
    expect(events).toEqual(['start a', 'start b', 'start c']);
    // A failing start hook doesn't cancel another module's schedule.
    vi.advanceTimersByTime(2500);
    expect(events.slice(3)).toEqual(['tick a', 'tick a']);
    events.length = 0;
    await expect(platform.stop()).rejects.toThrow('b failed to stop');
    expect(events).toEqual(['stop c', 'stop b', 'stop a']);
    vi.advanceTimersByTime(5000);
    expect(events).toHaveLength(3);
    // The runner was closed even so.
    expect(() => platform.runner.recentRuns()).toThrow();
});

it('awaits async turn hooks in registry order, and skips an async tick while it runs', async () => {
    // Each answers after a different delay: the order is the registry's.
    const later = <T>(value: T, ms: number) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
    let release!: () => void;
    let ticks = 0;
    const { platform } = await runtimeWith([
        {
            id: 'slow',
            dotNews: () => later(' slow news.', 20),
            dotTurnNote: () => 'sync note. ',
            dotPageContext: () => later(undefined, 10),
            tick: {
                everyMs: 1000,
                run: () => {
                    ticks++;
                    return new Promise<void>((resolve) => (release = resolve));
                },
            },
        },
        {
            id: 'fast',
            dotNews: async () => ' fast news.',
            dotTurnNote: () => later('async note.', 5),
            dotPageContext: async () => ({ page: 'fast' }),
        },
        { id: 'never', dotPageContext: () => ({ page: 'never' }) },
    ]);
    const turn = {} as Parameters<NonNullable<TestPlatform['dotExtensions']['news']>>[0];
    const { news, turnNote, pageContext } = platform.dotExtensions;
    expect(await news!(turn)).toBe(' slow news. fast news.');
    expect(await turnNote!(turn)).toBe('sync note. async note.');
    // The first module that answers wins; one that resolves undefined doesn't.
    expect(await pageContext!(turn)).toEqual({ page: 'fast' });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await platform.start();
    vi.advanceTimersByTime(3500);
    expect(ticks).toBe(1);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    vi.advanceTimersByTime(1000);
    expect(ticks).toBe(2);
    await platform.stop();
});

it('runs Learning’s daily tick and Telegram’s start and stop through module hooks', async () => {
    const { platform } = await runtimeWith(serverModules);
    const events: string[] = [];
    const tick = vi.spyOn(platform.learning, 'tick').mockImplementation(async () => {
        events.push('learning tick');
    });
    vi.spyOn(platform.learning, 'stop').mockImplementation(() => events.push('learning stop'));
    platform.useTelegram({
        status: 'online',
        username: 'brain_bot',
        start: async () => {
            events.push('telegram start');
        },
        stop: async () => {
            events.push('telegram stop');
        },
    } as unknown as TelegramChannel);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await platform.start();
    expect(events).toEqual(['telegram start']);
    expect(await platform.setup()).toMatchObject({
        telegram: 'online',
        telegramBot: 'brain_bot',
    });
    vi.advanceTimersByTime(59_999);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    await platform.stop();
    expect(events).toEqual(['telegram start', 'learning tick', 'learning stop', 'telegram stop']);
    vi.advanceTimersByTime(120_000);
    expect(tick).toHaveBeenCalledTimes(1);
});
