import type { DatabaseSync } from 'node:sqlite';

import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { sqliteData } from '@socio/data/open';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { teamOwner } from '@socio/foundation/telegram/team-owner';
import type { CursorPage } from '@socio/shared/operations/operations';
import {
    ACCESS_LOG_DEDUPE_MS,
    ACCESS_SURFACE_LABELS,
    type OpsAccessRow,
    type OpsChatHistoryPage,
    type OpsChatView,
} from '@socio/shared/operations/operations-access';
import type { User } from '@socio/shared/types';
import { SENDER_METADATA, SENDER_NAME_METADATA } from '@socio/shared/types';

import { serverModules } from '../src/server/modules/index.js';
import { auditor } from '../src/server/operations/access-log.js';
import type { AccessEntry, AccessLogRepository } from '../src/server/operations/domain/access-log.js';
import { SqliteAccessLog } from '../src/server/operations/infra/sqlite/access-log.js';
import { operationsTables } from '../src/server/operations/infra/sqlite/schema.js';
import { runRoutes } from '../src/server/runs/run-routes.js';
import { runsViews } from '../src/server/runs/views.js';

import { longChatRuns } from './fixtures/long-chat.js';
import { staticAuth } from './fixtures/static-auth.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-188: the access log and the admin transcript view. Admins read any
// chat, read-only; every person-level list and every content view is
// written to an append-only log that every admin can read.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

// The log reads newest first, and entries written in the same millisecond tie
// on time and fall back to their random ids. Tests that read that order give
// each request a later millisecond, so the order they expect is the real one.
function steadyClock() {
    let at = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => ++at);
}

const carol: User = { id: 'carol', name: 'Carol', role: 'admin' };
const olga: User = { id: 'olga', name: 'Olga', role: 'admin' };
const bob: User = { id: 'bob', name: 'Bob', role: 'member' };

async function fixture() {
    const runner = new LocalAgentRunner(testDatabase());
    const { workspace, platform, makeApp, dispose } = await makeTestRuntime({
        config: { baseUrl: '', voiceName: 'marin', runtimeUrl: '' },
        runner,
        modules: serverModules,
    });
    cleanup.push(dispose);
    const apps = new Map<string, ReturnType<typeof makeApp>>();
    const as = (user: User) => {
        let app = apps.get(user.id);
        if (!app) {
            app = makeApp({ auth: staticAuth(user) });
            apps.set(user.id, app);
        }
        return (path: string, init?: RequestInit) => app.request(`/api${path}`, init);
    };
    // Every person is known by name, as after sign-in.
    for (const user of [carol, olga, bob]) {
        workspace.db
            .prepare('INSERT OR IGNORE INTO users (id, name, role, createdAt, lastSeenAt) VALUES (?, ?, ?, 1, 1)')
            .run(user.id, user.name, user.role);
    }
    const dot = workspace.dots()[0];
    workspace.bindThread('t-bob', dot.id, 'Quarterly numbers', 'bob');
    const db = (runner as unknown as { db: DatabaseSync }).db;
    for (const run of longChatRuns({
        threadId: 't-bob',
        turns: 25,
        largest: 2000,
    })) {
        db.prepare(
            "INSERT INTO agent_runs(threadId, runId, status, events, startedAt, finishedAt) VALUES (?, ?, 'finished', ?, ?, ?)",
        ).run('t-bob', run.runId, JSON.stringify(run.events), run.startedAt, run.finishedAt);
    }
    const entries = () =>
        workspace.db
            .prepare('SELECT * FROM access_log ORDER BY at, rowid')
            .all()
            .map((row) => ({ ...row }));
    // A turn's trace (CB-128), with a screenshot from the chat.
    const traced = (runId: string) =>
        db.prepare('UPDATE agent_runs SET trace=? WHERE runId=?').run(
            JSON.stringify({
                rounds: [],
                tools: [
                    {
                        kind: 'tool',
                        round: 1,
                        name: 'computer_screenshot',
                        startedAt: 1,
                        endedAt: 2,
                        outcome: 'ok',
                        image: 'shot-1',
                    },
                ],
            }),
            runId,
        );
    return { as, platform, workspace, dot, db, entries, traced };
}

const json = async <T>(response: Response) => {
    expect(response.status).toBe(200);
    return (await response.json()) as T;
};

function sqliteLog() {
    const db = testDatabase();
    cleanup.push(() => db.close());
    return { db, log: new SqliteAccessLog(sqliteData(db)) };
}
const entry = (fields: Partial<AccessEntry> = {}): AccessEntry => ({
    id: 'e1',
    at: 1_000,
    viewerId: 'carol',
    surface: 'turns',
    subject: { kind: 'workspace', id: null },
    content: false,
    filters: {},
    requestId: 'r1',
    ...fields,
});

it('mirrors the migrated table, and the table refuses every edit', async () => {
    const { db, log } = sqliteLog();
    expect(schemaDrift(db, operationsTables)).toEqual([]);
    await log.record(entry());
    expect(() => db.prepare("UPDATE access_log SET viewerId='mallory'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM access_log').run()).toThrow(/append-only/);
    // A subject id goes with every kind but the whole workspace.
    expect(() =>
        db
            .prepare(
                "INSERT INTO access_log (id, at, viewerId, surface, subjectKind, subjectId, content, filters, requestId) VALUES ('e2', 1, 'carol', 'chat', 'chat', NULL, 1, '{}', 'r')",
            )
            .run(),
    ).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM access_log').get()).toEqual({
        n: 1,
    });
});

it('writes once per viewer, surface, subject and filters in the window, and pages newest first', async () => {
    const { log } = sqliteLog();
    expect(await log.record(entry({ filters: { range: '30d', socio: 'd1' } }))).toBe(true);
    const again = (fields: Partial<AccessEntry>) =>
        log.record(entry({ id: `e${Math.random()}`, at: 2_000, ...fields }), {
            unlessSince: 500,
        });
    // The same view, its filters in another order: nothing new.
    expect(await again({ filters: { socio: 'd1', range: '30d' } })).toBe(false);
    // Another filter set, another viewer, another subject: each its own.
    expect(await again({ id: 'e2', filters: { range: '7d' } })).toBe(true);
    expect(await again({ id: 'e3', viewerId: 'olga', filters: {} })).toBe(true);
    expect(await again({ id: 'e4', subject: { kind: 'person', id: 'bob' } })).toBe(true);
    // Outside the window it is written again.
    expect(await log.record(entry({ id: 'e5', at: 3_000 }), { unlessSince: 1_500 })).toBe(true);
    const first = await log.page({ limit: 3 });
    expect(first.items.map((item) => item.id)).toEqual(['e5', 'e4', 'e3']);
    expect(first.items[1].subject).toEqual({ kind: 'person', id: 'bob' });
    const rest = await log.page({ cursor: first.next!, limit: 3 });
    expect(rest.items.map((item) => item.id)).toEqual(['e2', 'e1']);
    expect(rest.next).toBeNull();
    expect(rest.items[1].filters).toEqual({ range: '30d', socio: 'd1' });
});

it('refuses members and service keys every content and log path, and logs nothing', async () => {
    const f = await fixture();
    for (const path of [
        '/operations/chats/t-bob',
        '/operations/chats/t-bob/history',
        '/operations/access-log',
        '/operations/turns',
    ]) {
        expect((await f.as(bob)(path)).status, path).toBe(403);
    }
    // A service account with the admin role: its key reaches none of it…
    const accounts = f.platform.serviceAccounts;
    const bot = accounts.create({ name: 'Bot', role: 'admin' }, 'carol');
    const { token } = accounts.createKey(bot.id, { name: 'k', scopes: ['issues:read'], days: 30 }, 'carol');
    for (const path of ['/operations/chats/t-bob', '/operations/access-log', '/runs/run-24/trace']) {
        expect(
            (
                await f.as(carol)(path, {
                    headers: { Authorization: `Bearer ${token}` },
                })
            ).status,
            path,
        ).toBe(403);
    }
    // …and were a scope to let one through, the log's own check refuses it.
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
        c.set('user', { id: 'svc', name: 'Bot', role: 'admin' });
        c.set('serviceKey', {} as never);
        await next();
    });
    const written: AccessEntry[] = [];
    const audit = auditor({
        log: {
            record: async (item) => (written.push(item), true),
            page: async () => ({ items: [], next: null }),
        },
    });
    app.get(
        '/chat',
        audit({
            surface: 'chat',
            subject: () => ({ kind: 'chat', id: 't-bob' }),
            content: true,
            once: 'always',
        }),
        (c) => c.json({ messages: ['secret'] }),
    );
    const refused = await app.request('/chat');
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain('secret');
    expect(written).toEqual([]);
    expect(f.entries()).toEqual([]);
});

it('opens any chat read-only for an admin, newest turns first, and logs the view', async () => {
    const f = await fixture();
    const carolApi = f.as(carol);
    // Bob's own history endpoint isn't Carol's to read…
    expect((await carolApi('/conversations/t-bob/history')).status).toBe(404);
    // …but Operations shows her his chat, from the Overview's turn list.
    const opened = await carolApi('/operations/chats/t-bob?via=overview');
    const requestId = opened.headers.get('x-request-id');
    const chat = await json<OpsChatView>(opened);
    expect(chat).toMatchObject({
        id: 't-bob',
        title: 'Quarterly numbers',
        socioId: f.dot.id,
        socioName: f.dot.name,
        ownerId: 'bob',
        ownerName: 'Bob',
        archivedAt: null,
        team: false,
    });
    const first = await json<OpsChatHistoryPage>(await carolApi('/operations/chats/t-bob/history?via=overview'));
    // Newest first: the last turn leads, and the page holds at most 20.
    expect(first.items[0].runId).toBe('run-24');
    expect(first.items.length).toBe(20);
    for (const [index, run] of first.items.entries()) {
        if (index) {
            expect(run.seq).toBeLessThan(first.items[index - 1].seq);
        }
    }
    expect(first.next).not.toBeNull();
    const second = await json<OpsChatHistoryPage>(
        await carolApi(`/operations/chats/t-bob/history?via=overview&cursor=${first.next}`),
    );
    expect(second.items.map((run) => run.runId)).toEqual(['run-4', 'run-3', 'run-2', 'run-1', 'run-0']);
    expect(second.next).toBeNull();
    // One entry for the open: the pages after it add nothing.
    const logged = f.entries();
    expect(logged).toEqual([
        {
            id: expect.any(String),
            at: expect.any(Number),
            viewerId: 'carol',
            surface: 'chat',
            subjectKind: 'chat',
            subjectId: 't-bob',
            content: 1,
            filters: '{"via":"overview"}',
            requestId,
        },
    ]);
    // Opening it again is another entry; so is another admin's open.
    await json(await carolApi('/operations/chats/t-bob'));
    await json(await f.as(olga)('/operations/chats/t-bob'));
    expect(f.entries().map((row) => row.viewerId)).toEqual(['carol', 'carol', 'olga']);
    // A chat that isn't there, or a bad cursor, is refused and not logged.
    expect((await carolApi('/operations/chats/nope')).status).toBe(404);
    expect((await carolApi('/operations/chats/nope/history')).status).toBe(404);
    expect((await carolApi('/operations/chats/t-bob/history?cursor=%%')).status).toBe(400);
    expect(f.entries()).toHaveLength(3);
    // Nothing in it can be changed from here.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(
            (
                await carolApi('/operations/chats/t-bob/history', {
                    method,
                    headers: { 'Content-Type': 'application/json' },
                    body: '{}',
                })
            ).status,
            method,
        ).toBe(404);
    }
});

it('logs a turns list once per viewer and filters, whatever pages follow', async () => {
    const f = await fixture();
    const carolApi = f.as(carol);
    await json(await carolApi('/operations/turns?range=30d'));
    await json(await carolApi('/operations/turns?range=30d&limit=10'));
    await json(await carolApi('/operations/turns?range=30d'));
    expect(f.entries()).toHaveLength(1);
    // Narrowed to a socio, or a person: a view of its own, about them.
    await json(await carolApi(`/operations/turns?range=30d&socio=${f.dot.id}`));
    await json(await carolApi('/operations/turns?person=bob'));
    // A bad range is refused, and not logged.
    expect((await carolApi('/operations/turns?range=1y')).status).toBe(400);
    expect(f.entries().map((row) => [row.subjectKind, row.subjectId, row.filters, row.content])).toEqual([
        ['workspace', null, '{"range":"30d"}', 0],
        ['socio', f.dot.id, `{"range":"30d","socio":"${f.dot.id}"}`, 0],
        ['person', 'bob', '{"person":"bob"}', 0],
    ]);
});

it('shows every admin every entry, their own included, newest first, with names', async () => {
    const f = await fixture();
    steadyClock();
    await json(await f.as(carol)('/operations/chats/t-bob?via=overview'));
    await json(await f.as(olga)('/operations/turns?person=bob'));
    await json(await f.as(olga)(`/operations/turns?socio=${f.dot.id}`));
    const first = await json<CursorPage<OpsAccessRow>>(await f.as(carol)('/operations/access-log?limit=2'));
    expect(first.items.map((row) => [row.viewerName, row.subjectKind, row.subjectName])).toEqual([
        ['Olga', 'socio', f.dot.name],
        ['Olga', 'person', 'Bob'],
    ]);
    const rest = await json<CursorPage<OpsAccessRow>>(
        await f.as(carol)(`/operations/access-log?limit=2&cursor=${first.next}`),
    );
    expect(rest.items).toEqual([
        {
            id: expect.any(String),
            at: expect.any(Number),
            viewerId: 'carol',
            viewerName: 'Carol',
            surface: 'chat',
            subjectKind: 'chat',
            subjectId: 't-bob',
            subjectName: 'Quarterly numbers',
            content: true,
            filters: { via: 'overview' },
            filterNames: {},
            requestId: expect.any(String),
        },
    ]);
    expect(rest.next).toBeNull();
    // Reading the log isn't an entry; the log has no way to change it.
    expect(f.entries()).toHaveLength(3);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(
            (
                await f.as(carol)('/operations/access-log', {
                    method,
                    headers: { 'Content-Type': 'application/json' },
                    body: '{}',
                })
            ).status,
            method,
        ).toBe(404);
    }
    expect((await f.as(carol)('/operations/access-log?cursor=bad!')).status).toBe(400);
});

it('names the socio, person and Space an entry was narrowed to, and none that are gone', async () => {
    const f = await fixture();
    steadyClock();
    const space = f.workspace.spaces()[0];
    const gone = '0b5e4a51-2d7c-4c1e-9d3a-7f6e5d4c3b2a';
    await json(await f.as(olga)(`/operations/turns?socio=${f.dot.id}&person=bob&space=${space.id}`));
    await json(await f.as(olga)(`/operations/turns?socio=${gone}&person=ghost`));
    const { items } = await json<CursorPage<OpsAccessRow>>(await f.as(carol)('/operations/access-log'));
    expect(items.map((row) => [row.filters, row.filterNames])).toEqual([
        [expect.objectContaining({ socio: gone, person: 'ghost' }), { socio: null, person: null }],
        [
            expect.objectContaining({
                socio: f.dot.id,
                person: 'bob',
                space: space.id,
            }),
            { socio: f.dot.name, person: 'Bob', space: space.name },
        ],
    ]);
});

it('shows nothing it couldn’t write to the log, and dedupes lists over the window', async () => {
    let now = 1_000_000;
    const written: AccessEntry[] = [];
    let failing = false;
    const log: AccessLogRepository = {
        record: async (item, options) => {
            if (failing) {
                throw new Error('disk full');
            }
            if (
                options?.unlessSince !== undefined &&
                written.some((seen) => seen.viewerId === item.viewerId && seen.at >= options.unlessSince!)
            ) {
                return false;
            }
            written.push(item);
            return true;
        },
        page: async () => ({ items: [], next: null }),
    };
    const audit = auditor({ log, now: () => now });
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
        c.set('user', carol);
        await next();
    });
    app.get(
        '/list',
        audit({
            surface: 'turns',
            subject: () => ({ kind: 'workspace', id: null }),
            content: false,
            once: 'list',
        }),
        (c) => c.json({ items: ['row'] }),
    );
    expect((await app.request('/list')).status).toBe(200);
    now += ACCESS_LOG_DEDUPE_MS - 1;
    expect((await app.request('/list')).status).toBe(200);
    expect(written).toHaveLength(1);
    now += 2;
    expect((await app.request('/list')).status).toBe(200);
    expect(written).toHaveLength(2);
    failing = true;
    const refused = await app.request('/list');
    expect(refused.status).toBe(503);
    expect(await refused.text()).not.toContain('row');
});

it('logs every section’s person-level views, each by a surface the log names, and no aggregate', async () => {
    const f = await fixture();
    const carolApi = f.as(carol);
    // Workspace aggregates, and lists without anyone's rows: not logged.
    for (const path of [
        '/operations/overview',
        '/operations/series/turns',
        '/operations/reliability',
        '/operations/reliability/series',
        '/operations/reliability/breakdown/socio',
        '/operations/reliability/friction',
        '/operations/reliability/issues',
        '/operations/health/series/first_output',
        '/operations/health/runs',
        '/operations/activity',
        '/operations/value',
        '/operations/knowledge',
        '/operations/knowledge/pages',
        '/operations/storage',
        '/operations/capabilities',
        '/operations/capabilities/requests',
    ]) {
        await json(await carolApi(`${path}?range=30d`));
    }
    expect(f.entries()).toEqual([]);
    // Each list of people's rows (CB-189 to CB-192), and a person's view.
    const audited = {
        '/operations/reliability/failures?category=runtime_error': 'failures',
        '/operations/health': 'health',
        '/operations/health/schedules': 'health-schedules',
        '/operations/health/long-runs': 'health-long-runs',
        '/operations/activity?person=bob': 'activity',
        '/operations/value?person=bob': 'value',
        '/operations/activity/people': 'activity-people',
        '/operations/activity/socios': 'activity-socios',
        '/operations/activity/chats': 'activity-chats',
        '/operations/value/sessions?outcome=abandoned': 'value-sessions',
        '/operations/knowledge/datasets': 'knowledge-datasets',
        // A failure's trace, opened from Reliability (Runs' route).
        '/runs/run-24/trace?via=reliability': 'trace',
    };
    f.traced('run-24');
    for (const path of Object.keys(audited)) {
        await json(await carolApi(path));
    }
    const rows = f.entries() as {
        surface: string;
        subjectKind: string;
        filters: string;
    }[];
    expect(rows.map((row) => row.surface)).toEqual(Object.values(audited));
    for (const { surface } of rows) {
        expect(ACCESS_SURFACE_LABELS[surface], surface).toBeTruthy();
    }
    const of = (surface: string) => rows.find((row) => row.surface === surface)!;
    // A list's own narrowing is kept with its filters; a person's view is about them.
    expect(JSON.parse(of('failures').filters)).toEqual({
        category: 'runtime_error',
    });
    expect(JSON.parse(of('value-sessions').filters)).toEqual({
        outcome: 'abandoned',
    });
    expect(of('activity')).toMatchObject({ subjectKind: 'person' });
    expect(of('health')).toMatchObject({ subjectKind: 'workspace' });
    expect(of('trace')).toMatchObject({ subjectKind: 'run', content: 1 });
    // Members are refused them all but their own turns' traces, which they
    // read as before, and nothing more is written.
    for (const path of Object.keys(audited)) {
        expect((await f.as(bob)(path)).status, path).toBe(path.startsWith('/runs/') ? 200 : 403);
    }
    expect(f.entries()).toHaveLength(rows.length);
});

it('logs each admin open of another person’s turn trace, from Runs or Reliability', async () => {
    const f = await fixture();
    const carolApi = f.as(carol);
    f.traced('run-24');
    // Carol opens a failure's trace in Reliability, then again in Runs.
    const opened = await carolApi('/runs/run-24/trace?via=reliability');
    const requestId = opened.headers.get('x-request-id');
    expect((await json<{ trace: { tools: { image?: string }[] } }>(opened)).trace.tools[0].image).toBe('shot-1');
    await json(await carolApi('/runs/run-24/trace'));
    expect(f.entries()).toEqual([
        {
            id: expect.any(String),
            at: expect.any(Number),
            viewerId: 'carol',
            surface: 'trace',
            subjectKind: 'run',
            subjectId: 'run-24',
            content: 1,
            filters: '{"via":"reliability"}',
            requestId,
        },
        expect.objectContaining({ subjectId: 'run-24', filters: '{}' }),
    ]);
    // Not logged: Bob reading his own turn's trace, Carol hers, a turn
    // from before traces (no content), and a turn that isn't there.
    await json(await f.as(bob)('/runs/run-24/trace'));
    f.workspace.bindThread('t-carol', f.dot.id, 'Mine', 'carol');
    f.db
        .prepare(
            "INSERT INTO agent_runs(threadId, runId, status, events, startedAt, finishedAt) VALUES ('t-carol', 'carol-run', 'finished', '[]', 1, 2)",
        )
        .run();
    f.traced('carol-run');
    await json(await carolApi('/runs/carol-run/trace'));
    expect((await json<{ trace: unknown }>(await carolApi('/runs/run-3/trace'))).trace).toBeNull();
    expect((await carolApi('/runs/missing/trace')).status).toBe(404);
    expect(f.entries()).toHaveLength(2);
    // Every admin sees it named in the log.
    const log = await json<CursorPage<OpsAccessRow>>(await f.as(olga)('/operations/access-log'));
    expect(log.items[0]).toMatchObject({
        viewerName: 'Carol',
        surface: 'trace',
        subjectKind: 'run',
        subjectId: 'run-24',
        content: true,
    });
});

it('shows no trace it couldn’t write to the log, and keeps members’ own traces', async () => {
    const f = await fixture();
    f.traced('run-24');
    const app = (user: User, key = false) => {
        const app = new Hono<AppEnv>();
        app.use('*', async (c, next) => {
            c.set('user', user);
            if (key) {
                c.set('serviceKey', {} as never);
            }
            await next();
        });
        app.route(
            '/',
            runRoutes(runsViews(f.platform), {
                audit: auditor({
                    log: {
                        record: async () => {
                            throw new Error('disk full');
                        },
                        page: async () => ({ items: [], next: null }),
                    },
                }),
            }),
        );
        return app;
    };
    const refused = await app(carol).request('/runs/run-24/trace');
    expect(refused.status).toBe(503);
    expect(await refused.text()).not.toContain('shot-1');
    // Nothing to log, nothing refused: Bob's own trace, a turn without one.
    expect((await app(bob).request('/runs/run-24/trace')).status).toBe(200);
    expect((await app(carol).request('/runs/run-3/trace')).status).toBe(200);
    // An admin's key, were a scope to let one through, is refused.
    const bot: User = { id: 'svc', name: 'Bot', role: 'admin' };
    const keyed = await app(bot, true).request('/runs/run-24/trace');
    expect(keyed.status).toBe(403);
    expect(await keyed.text()).not.toContain('shot-1');
});

it('names each person’s message in a chat by who wrote it, several people in a team topic', async () => {
    const f = await fixture();
    const carolApi = f.as(carol);
    // Bob's web chat: his messages carry no sender, so they are the owner's.
    const web = await json<OpsChatHistoryPage>(await carolApi('/operations/chats/t-bob/history'));
    const asked = web.items.flatMap((run) => run.messages.filter((message) => message.role === 'user'));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((message) => message.author?.name === 'Bob')).toBe(true);
    // A Telegram team topic: bob and olga write in it; someone since gone
    // keeps the name they had; a message from before CB-66 has no sender.
    f.workspace.bindThread('t-team', f.dot.id, 'Team agenda', teamOwner('-100'));
    const said = (id: string, content: string, sender?: [string, string?]) => ({
        id,
        role: 'user',
        content,
        ...(sender
            ? {
                  metadata: {
                      [SENDER_METADATA]: sender[0],
                      ...(sender[1] ? { [SENDER_NAME_METADATA]: sender[1] } : {}),
                      socioSource: 'telegram',
                  },
              }
            : {}),
    });
    const events = [
        {
            type: 'RUN_STARTED',
            threadId: 't-team',
            runId: 'team-1',
            input: {
                threadId: 't-team',
                runId: 'team-1',
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
                messages: [
                    said('m1', 'What is on the agenda?', ['bob', 'Bobby']),
                    said('m2', 'And the budget?', ['olga']),
                    said('m3', 'I was here once.', ['gone', 'Gina']),
                    said('m4', 'From before senders were kept.'),
                ],
            },
        },
        { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'The offsite.' },
        { type: 'TEXT_MESSAGE_END', messageId: 'a1' },
        { type: 'RUN_FINISHED', threadId: 't-team', runId: 'team-1' },
    ];
    (f.platform.runner as unknown as { db: DatabaseSync }).db
        .prepare(
            "INSERT INTO agent_runs(threadId, runId, status, events, startedAt, finishedAt) VALUES ('t-team', 'team-1', 'finished', ?, 1, 2)",
        )
        .run(JSON.stringify(events));
    const chat = await json<OpsChatView>(await carolApi('/operations/chats/t-team'));
    expect(chat).toMatchObject({ team: true, ownerName: 'Telegram team' });
    const team = await json<OpsChatHistoryPage>(await carolApi('/operations/chats/t-team/history'));
    const messages = team.items[0]!.messages;
    expect(messages.map((message) => [message.role, message.author?.name])).toEqual([
        ['user', 'Bob'],
        ['user', 'Olga'],
        ['user', 'Gina'],
        ['user', 'Team member'],
        ['assistant', undefined],
    ]);
    expect(messages.every((message) => !message.author?.you)).toBe(true);
    // Never anyone's account id; the rest of the metadata stays.
    expect(JSON.stringify(team)).not.toContain(SENDER_METADATA);
    // The author is there too (and at the top level, for the app builds that
    // predate reading metadata).
    expect(messages[0]!.metadata).toEqual({ socioSource: 'telegram', author: messages[0]!.author });
});
