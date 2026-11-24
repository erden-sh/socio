import { Layer } from 'effect';
import { Hono } from 'hono';
import { afterEach, expect, it } from 'vitest';

import type { AppEnv } from '@socio/foundation/http/app-env';
import type {
    CursorPage,
    OperationsSettings,
    OperationsSettingsView,
    OpsOverview,
    OpsSeries,
    OpsTurnRow,
} from '@socio/shared/operations/operations';
import { ANALYTICS_DEFAULTS, analyticsInForce } from '@socio/shared/operations/operations-analytics';
import type { HealthScheduleRow, OpsHealth, OpsHealthSeries } from '@socio/shared/operations/operations-health';
import type { User } from '@socio/shared/types';

import { serverModules } from '../src/server/modules/index.js';
import { AnalyticsError, type AnalyticsClient } from '../src/server/operations/analytics/client.js';
import { AnalyticsStore } from '../src/server/operations/analytics/connect.js';
import { OPS_QUERIES } from '../src/server/operations/domain/ops-queries.js';
import { AnalyticsOpsReader } from '../src/server/operations/infra/analytics/reader.js';
import type { TurnFact } from '../src/server/operations/infra/memory/facts.js';
import { MemoryOpsReader } from '../src/server/operations/infra/memory/reader.js';
import { operationsRoutes } from '../src/server/operations/routes.js';
import { operationsSettingsFromEnv } from '../src/server/operations/settings.js';

import { staticAuth } from './fixtures/static-auth.js';
import { makeTestRuntime, type TestRuntime, type TestRuntimeOptions } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const alice: User = { id: 'alice', name: 'Alice', role: 'admin' };
const bob: User = { id: 'bob', name: 'Bob', role: 'member' };
const olga: User = { id: 'olga', name: 'Olga', role: 'admin' };

/** The runtime, with the Operations settings' env defaults when given (`OPS_*`, read at boot). */
async function platform(operations?: OperationsSettings, layers?: TestRuntimeOptions['layers']) {
    const test = await makeTestRuntime({
        config: { baseUrl: '', voiceName: 'marin', runtimeUrl: '', ...(operations ? { operations } : {}) },
        modules: serverModules,
        ...(layers ? { layers } : {}),
    });
    cleanup.push(test.dispose);
    return test;
}
const appFor = ({ makeApp }: TestRuntime, user: User) => makeApp({ auth: staticAuth(user) });
const put = (body: unknown) => ({
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

it('answers admins and operators only, on every path', async () => {
    const rt = await platform();
    const built = rt.platform;
    const paths = [
        '/api/operations/status',
        '/api/operations/settings',
        '/api/operations/overview',
        '/api/operations/overview?range=30d&socio=d1',
        '/api/operations/series/turns',
        '/api/operations/turns',
        '/api/operations/health',
        '/api/operations/health/series/first_output',
        '/api/operations/health/schedules',
        '/api/operations/health/runs',
        '/api/operations/health/long-runs',
    ];
    for (const path of paths) {
        expect((await appFor(rt, bob).request(path)).status, path).toBe(403);
        expect((await appFor(rt, alice).request(path)).status, path).toBe(200);
        expect((await appFor(rt, olga).request(path)).status, path).toBe(200);
    }
    // Unknown paths under the prefix are refused before they are looked up.
    expect((await appFor(rt, bob).request('/api/operations/nothing')).status).toBe(403);
    expect((await appFor(rt, bob).request('/api/operations/settings', put({ timeZone: 'Europe/Madrid' }))).status).toBe(
        403,
    );
    expect(built.store.settings().operations).toBeUndefined();
});

it('says analytics isn’t running, with no values, until the store is', async () => {
    const app = appFor(await platform(), alice);
    const overview = (await (await app.request('/api/operations/overview')).json()) as OpsOverview;
    expect(overview.status).toEqual({
        state: 'unavailable',
        asOf: null,
        earliest: null,
    });
    expect(overview.tiles.map((tile) => [tile.id, tile.value])).toEqual([
        ['turns', null],
        ['failed', null],
        ['people', null],
        ['messages', null],
        ['chats', null],
        ['tokens', null],
    ]);
    expect(overview.window).toMatchObject({ bucket: 'hour', timeZone: 'UTC' });
    const turns = (await (await app.request('/api/operations/turns')).json()) as CursorPage<OpsTurnRow>;
    expect(turns).toEqual({ items: [], next: null });
});

it('keeps the reporting time zone as an admin’s setting over OPS_TIME_ZONE', async () => {
    const rt = await platform(
        operationsSettingsFromEnv({
            OPS_TIME_ZONE: 'america/new_york',
        }),
    );
    const built = rt.platform;
    const app = appFor(rt, alice);
    const read = async () => (await (await app.request('/api/operations/settings')).json()) as OperationsSettingsView;
    expect(await read()).toEqual({
        timeZone: 'America/New_York',
        sessionGapMinutes: 30,
        defaults: { timeZone: 'America/New_York', sessionGapMinutes: 30 },
    });
    const saved = await app.request('/api/operations/settings', put({ timeZone: 'europe/madrid' }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
        timeZone: 'Europe/Madrid',
        sessionGapMinutes: 30,
        defaults: { timeZone: 'America/New_York', sessionGapMinutes: 30 },
    });
    expect(built.store.settings().operations).toEqual({
        timeZone: 'Europe/Madrid',
    });
    // Answers are cut in it.
    const overview = (await (await app.request('/api/operations/overview')).json()) as OpsOverview;
    expect(overview.window.timeZone).toBe('Europe/Madrid');
    for (const body of [{ timeZone: '+02:00' }, { timeZone: 'Mars/Base' }, {}]) {
        const refused = await app.request('/api/operations/settings', put(body));
        if ('timeZone' in body) {
            expect(refused.status).toBe(400);
        } else {
            expect(refused.status).toBe(200);
        }
    }
    expect((await app.request('/api/operations/settings', put({ zone: 'UTC' }))).status).toBe(400);
    // null goes back to the server's.
    await app.request('/api/operations/settings', put({ timeZone: null }));
    expect((await read()).timeZone).toBe('America/New_York');
    expect(built.store.settings().operations).toEqual({});
    expect(() => operationsSettingsFromEnv({ OPS_TIME_ZONE: 'nowhere' })).toThrow(/OPS_TIME_ZONE/);
    expect(operationsSettingsFromEnv({ OPS_TIME_ZONE: ' ' })).toEqual({});
});

it('keeps the analytics store’s saved limits when the time zone changes', async () => {
    const rt = await platform();
    const built = rt.platform;
    await built.store.updateSettings({
        operations: { analytics: { memoryMb: 1024 } },
    });
    const app = appFor(rt, alice);
    await app.request('/api/operations/settings', put({ timeZone: 'UTC' }));
    await app.request('/api/operations/settings', put({ timeZone: null }));
    await app.request('/api/operations/settings', put({ timeZone: 'Asia/Tokyo' }));
    const saved = built.store.settings().operations;
    expect(saved).toEqual({
        timeZone: 'Asia/Tokyo',
        analytics: { memoryMb: 1024 },
    });
    expect(analyticsInForce(saved, ANALYTICS_DEFAULTS).memoryMb).toBe(1024);
});

/** The routes alone, on an in-memory store with these turns. */
function routesWith(turns: TurnFact[], now: number) {
    const settings = {
        value: {
            name: 'Socio',
            paused: false,
            researchAllowed: false,
            memoryAllowed: true,
        },
        settings() {
            return this.value;
        },
        async updateSettings(patch: object) {
            this.value = { ...this.value, ...patch };
            return this.value;
        },
    };
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
        c.set('user', alice);
        await next();
    });
    app.route(
        '/api',
        operationsRoutes({
            reader: new MemoryOpsReader({ turns }),
            settings,
            now: () => now,
        }),
    );
    return app;
}

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 22, 12);
const turn = (index: number, patch: Partial<TurnFact> = {}): TurnFact => ({
    runId: `r${String(index).padStart(3, '0')}`,
    threadId: `t${index % 3}`,
    socioId: index % 2 ? 'd1' : 'd2',
    socioName: index % 2 ? 'Manny' : 'Mingo',
    source: 'web',
    status: 'finished',
    // A minute before each hour: the window ends at now, exclusive.
    startedAt: NOW - index * HOUR - 60_000,
    finishedAt: NOW - index * HOUR - 59_000,
    inputTokens: 100,
    outputTokens: 20,
    ...patch,
});

it('pages a list by cursor, newest first, with no row twice or left out', async () => {
    const app = routesWith(
        Array.from({ length: 120 }, (_, index) => turn(index)),
        NOW,
    );
    const seen: string[] = [];
    let cursor: string | null = '';
    let pages = 0;
    while (cursor !== null) {
        const response = await app.request(
            `/api/operations/turns?range=7d&limit=50${cursor ? `&cursor=${cursor}` : ''}`,
        );
        expect(response.status).toBe(200);
        const page = (await response.json()) as CursorPage<OpsTurnRow>;
        seen.push(...page.items.map((item) => item.runId));
        cursor = page.next;
        pages++;
    }
    // 7 days of hourly turns: 168 hours, but only 120 turns.
    expect(pages).toBe(3);
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
    expect(seen[0]).toBe('r000');
    expect(seen.at(-1)).toBe('r119');
    // Filters narrow the list; the range cuts it.
    const manny = (await (
        await app.request('/api/operations/turns?range=24h&socio=d1&limit=200')
    ).json()) as CursorPage<OpsTurnRow>;
    expect(manny.items.map((item) => item.runId)).toEqual(
        Array.from({ length: 12 }, (_, i) => `r${String(i * 2 + 1).padStart(3, '0')}`),
    );
    expect(manny.items[0]).toEqual({
        runId: 'r001',
        threadId: 't1',
        socioId: 'd1',
        socioName: 'Manny',
        source: 'web',
        status: 'finished',
        startedAt: NOW - HOUR - 60_000,
        finishedAt: NOW - HOUR - 59_000,
        tokens: 120,
        toolCalls: 0,
        toolErrors: 0,
    });
    for (const query of [
        'cursor=not-a-cursor',
        `cursor=${Buffer.from('{"a":1}').toString('base64url')}`,
        'limit=0',
        'limit=201',
        'limit=ten',
    ]) {
        expect((await app.request(`/api/operations/turns?${query}`)).status, query).toBe(400);
    }
});

it('refuses a bad range or filter, and answers series by bucket', async () => {
    const app = routesWith([turn(1), turn(2, { status: 'failed' }), turn(30)], NOW);
    for (const query of [
        'range=2w',
        'bucket=minute',
        'from=yesterday',
        'from=2026-10-01&to=soon',
        'to=2026-10-01',
        'socio=a%20b',
    ]) {
        expect((await app.request(`/api/operations/overview?${query}`)).status, query).toBe(400);
    }
    expect((await app.request('/api/operations/series/vibes')).status).toBe(404);
    const series = (await (await app.request('/api/operations/series/turns?range=7d&bucket=day')).json()) as OpsSeries;
    expect(series.window).toMatchObject({
        bucket: 'day',
        buckets: ['hour', 'day', 'week', 'month'],
        to: NOW,
        from: NOW - 7 * 24 * HOUR,
    });
    // Eight days touched (the window starts mid-day), today's has two turns.
    expect(series.points).toHaveLength(8);
    expect(series.points.at(-1)).toEqual({ at: Date.UTC(2026, 9, 22), value: 2 });
    expect(series.points.reduce((sum, point) => sum + point.value, 0)).toBe(3);
    const overview = (await (await app.request('/api/operations/overview?range=24h')).json()) as OpsOverview;
    expect(overview.status.state).toBe('ready');
    expect(Object.fromEntries(overview.tiles.map((tile) => [tile.id, [tile.value, tile.previous]]))).toMatchObject({
        turns: [2, 1],
        failed: [1, 0],
        tokens: [240, 120],
    });
});

it('shows Health live while the store is down, and the store’s numbers once up', async () => {
    // No analytics store: no numbers, but the store's state is live (no
    // backups are set up here).
    const down = (await (await appFor(await platform(), alice).request('/api/operations/health')).json()) as OpsHealth;
    expect(down.status.state).toBe('unavailable');
    expect(down.facts).toBeNull();
    expect(down.live).toMatchObject({
        analytics: null,
        backup: null,
    });
    expect(down.live.staleAfterMs).toBeGreaterThanOrEqual(5 * 60_000);

    const schedule = (id: string, state: HealthScheduleRow['state'], at: number) => ({
        id,
        title: `Schedule ${id}`,
        socioId: 'd1',
        personId: 'alice',
        state,
        status: state === 'paused' ? 'paused' : 'scheduled',
        cadence: 'daily',
        nextRunAt: null,
        lastRunAt: null,
        updatedAt: at,
        error: null,
    });
    const app = new Hono<AppEnv>();
    app.route(
        '/api',
        operationsRoutes({
            reader: new MemoryOpsReader({
                turns: [turn(1, { model: 'gpt-5', reasoningKind: 'summary' }), turn(2)],
                health: {
                    schedules: Array.from({ length: 5 }, (_, i) =>
                        schedule(`s${i}`, i === 4 ? 'ok' : i % 2 ? 'paused' : 'overdue', NOW - i * HOUR),
                    ),
                    socios: [{ id: 'd1', name: 'Manny', spaceId: 'sp' }],
                },
            }),
            settings: {
                settings: () => ({}) as never,
                updateSettings: async () => ({}) as never,
            },
            health: async () => ({
                analytics: { mode: 'child', state: 'ready', asOf: NOW },
                staleAfterMs: 300_000,
                backup: {
                    intervalHours: 24,
                    offsite: false,
                    running: false,
                    lastSuccessAt: NOW - HOUR,
                },
            }),
            now: () => NOW,
        }),
    );
    const up = (await (await app.request('/api/operations/health?range=24h')).json()) as OpsHealth;
    expect(up.live.backup?.lastSuccessAt).toBe(NOW - HOUR);
    expect(up.facts?.tokens.byReasoning.map((row) => [row.kind, row.turns])).toEqual([
        ['summary', 1],
        ['unknown', 1],
    ]);
    expect(up.facts?.schedules).toMatchObject({ overdue: 2, paused: 2, ok: 1 });
    // The list: those that need a look, last changed first, by cursor.
    const first = (await (
        await app.request('/api/operations/health/schedules?limit=3')
    ).json()) as CursorPage<HealthScheduleRow>;
    expect(first.items.map((row) => [row.id, row.socioName])).toEqual([
        ['s0', 'Manny'],
        ['s1', 'Manny'],
        ['s2', 'Manny'],
    ]);
    const rest = (await (
        await app.request(`/api/operations/health/schedules?limit=3&cursor=${first.next}`)
    ).json()) as CursorPage<HealthScheduleRow>;
    expect(rest).toMatchObject({ items: [{ id: 's3' }], next: null });
    const series = (await (
        await app.request('/api/operations/health/series/turn_queue?range=24h&bucket=hour')
    ).json()) as OpsHealthSeries;
    expect(series.points).toHaveLength(24);
    expect(series.points.every((point) => point.n === 0 && point.p95 === null)).toBe(true);
    expect((await app.request('/api/operations/health/series/vibes')).status).toBe(404);
    expect((await app.request('/api/operations/health/runs?limit=0')).status).toBe(400);
    expect((await app.request('/api/operations/health?range=2w')).status).toBe(400);
});

it('shows Health live, not an error, while a new store version rebuilds', async () => {
    // The old file answers during the rebuild but has no Health tables yet,
    // so DuckDB fails those queries (not "not ready").
    let state: 'rebuilding' | 'ready' = 'rebuilding';
    const asked: string[] = [];
    const analytics = {
        health: () => ({ mode: 'child' as const, state, progress: 40 }),
        query: async (name: string) => {
            asked.push(name);
            if (name === 'status') {
                return { state, asOf: NOW, earliest: NOW - 24 * HOUR, progress: 40 };
            }
            throw new AnalyticsError('Catalog Error: Table with name f_job_run does not exist!', 'failed');
        },
    } as unknown as Pick<AnalyticsClient, 'query' | 'health'>;
    const app = new Hono<AppEnv>();
    app.route(
        '/api',
        operationsRoutes({
            reader: new AnalyticsOpsReader(analytics),
            settings: {
                settings: () => ({}) as never,
                updateSettings: async () => ({}) as never,
            },
            health: async () => ({
                analytics: { mode: 'child', state: 'rebuilding', progress: 40 },
                staleAfterMs: 300_000,
                backup: null,
            }),
            now: () => NOW,
        }),
    );
    const res = await app.request('/api/operations/health?range=24h');
    expect(res.status).toBe(200);
    const body = (await res.json()) as OpsHealth;
    expect(body.status).toMatchObject({ state: 'rebuilding', progress: 40 });
    expect(body.facts).toBeNull();
    expect(body.live.analytics).toMatchObject({ state: 'rebuilding' });
    const series = await app.request('/api/operations/health/series/first_output?range=24h');
    expect(series.status).toBe(200);
    expect(((await series.json()) as OpsHealthSeries).points).toEqual([]);
    for (const list of ['schedules', 'runs', 'long-runs']) {
        const page = await app.request(`/api/operations/health/${list}`);
        expect(page.status, list).toBe(200);
        expect(await page.json(), list).toEqual({ items: [], next: null });
    }
    expect(asked).toEqual(
        expect.arrayContaining(['health', 'healthSeries', 'healthSchedules', 'healthRuns', 'healthLongRuns']),
    );
    // Once the store is ready, a failed answer is a real fault again.
    state = 'ready';
    expect((await app.request('/api/operations/health?range=24h')).status).toBe(500);
});

// Activity and Value (CB-190).
it('serves Activity and Value to admins only, with the session gap in force', async () => {
    const rt = await platform(
        operationsSettingsFromEnv({
            OPS_SESSION_GAP_MINUTES: '45',
        }),
    );
    for (const path of [
        '/api/operations/activity',
        '/api/operations/value?range=30d',
        '/api/operations/activity/people',
        '/api/operations/activity/socios',
        '/api/operations/activity/chats',
        '/api/operations/value/sessions?outcome=completed',
    ]) {
        expect((await appFor(rt, bob).request(path)).status, path).toBe(403);
        expect((await appFor(rt, alice).request(path)).status, path).toBe(200);
    }
    const app = appFor(rt, alice);
    const activity = async () =>
        (await (await app.request('/api/operations/activity')).json()) as {
            sessionGapMinutes: number;
            tiles: { value: number | null }[];
        };
    expect(await activity()).toMatchObject({ sessionGapMinutes: 45 });
    // No store yet: no values.
    expect((await activity()).tiles.every((t) => t.value === null)).toBe(true);
    const saved = await app.request('/api/operations/settings', put({ sessionGapMinutes: 10 }));
    expect(await saved.json()).toMatchObject({
        sessionGapMinutes: 10,
        defaults: { sessionGapMinutes: 45 },
    });
    expect((await activity()).sessionGapMinutes).toBe(10);
    for (const sessionGapMinutes of [0, 1.5, 24 * 60 + 1, '30']) {
        expect((await app.request('/api/operations/settings', put({ sessionGapMinutes }))).status).toBe(400);
    }
    await app.request('/api/operations/settings', put({ sessionGapMinutes: null }));
    expect((await activity()).sessionGapMinutes).toBe(45);
    expect(() => operationsSettingsFromEnv({ OPS_SESSION_GAP_MINUTES: 'soon' })).toThrow(/OPS_SESSION_GAP_MINUTES/);
    expect((await app.request('/api/operations/value/sessions?outcome=done')).status).toBe(400);
});

it('groups feature use by capability and puts person-level lists behind the access log', async () => {
    const subjects: string[] = [];
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
        c.set('user', alice);
        await next();
    });
    const at = NOW - 2 * HOUR;
    app.route(
        '/api',
        operationsRoutes({
            reader: new MemoryOpsReader({
                turns: [turn(2, { personId: 'u1' })],
                messages: [
                    {
                        messageId: 'm1',
                        runId: 'r002',
                        threadId: 't2',
                        socioId: 'd2',
                        source: 'web',
                        at,
                        authorKind: 'person',
                        authorId: 'u1',
                    },
                ],
                tools: [
                    {
                        runId: 'r002',
                        threadId: 't2',
                        socioId: 'd2',
                        source: 'web',
                        personId: 'u1',
                        tool: 'read_page',
                        outcome: 'ok',
                        startedAt: at,
                    },
                    {
                        runId: 'r002',
                        threadId: 't2',
                        socioId: 'd2',
                        source: 'web',
                        personId: 'u1',
                        tool: 'search_pages',
                        outcome: 'error',
                        startedAt: at,
                    },
                    {
                        runId: 'r002',
                        threadId: 't2',
                        socioId: 'd2',
                        source: 'web',
                        personId: 'u1',
                        tool: 'mystery',
                        outcome: 'ok',
                        startedAt: at,
                    },
                ],
            }),
            settings: {
                settings: () => ({}) as never,
                updateSettings: async () => ({}) as never,
            },
            now: () => NOW,
            capabilities: {
                list: () => [
                    {
                        id: 'pages',
                        label: 'Space pages',
                        tools: ['read_page', 'search_pages'],
                    },
                ],
            },
            audit:
                ({ surface, subject }) =>
                async (c, next) => {
                    await next();
                    subjects.push(`${surface} ${subject(c)?.kind} ${new URL(c.req.url).pathname}`);
                },
        }),
    );
    const answer = (await (await app.request('/api/operations/activity')).json()) as {
        features: { id: string; label: string; calls: number; errors: number }[];
    };
    expect(answer.features).toEqual([
        expect.objectContaining({
            id: 'pages',
            label: 'Space pages',
            calls: 2,
            errors: 1,
        }),
        expect.objectContaining({ id: 'tool:mystery', label: 'mystery', calls: 1 }),
    ]);
    // Workspace aggregates aren't logged; a person's view and lists are.
    expect(subjects).toEqual([]);
    await app.request('/api/operations/activity?person=u1');
    const people = (await (await app.request('/api/operations/activity/people?limit=1')).json()) as {
        items: { personId: string }[];
    };
    expect(people.items.map((p) => p.personId)).toEqual(['u1']);
    await app.request('/api/operations/value/sessions');
    expect(subjects).toEqual([
        'activity person /api/operations/activity',
        'activity-people workspace /api/operations/activity/people',
        'value-sessions workspace /api/operations/value/sessions',
    ]);
});

it('answers every section “rebuilding”, never an error, while a new store version rebuilds', async () => {
    // ETL_VERSION 4 rebuilds every store on deploy. Until the new file is
    // swapped in the engine answers not_ready (CB-187); a query that still
    // reaches an old file fails, which counts as not answering while it
    // rebuilds.
    for (const code of ['not_ready', 'failed'] as const) {
        const asked = new Set<string>();
        const analytics = {
            health: () => ({
                mode: 'child' as const,
                state: 'rebuilding' as const,
                progress: 40,
            }),
            query: async (name: string) => {
                asked.add(name);
                throw new AnalyticsError('Rebuilding 40%.', code);
            },
            nudge: () => {},
            // The runtime's dispose stops the platform, and the platform its analytics.
            stop: async () => {},
        } as unknown as AnalyticsClient;
        // The module's routes read the app's `AnalyticsStore`; the platform's
        // member is the same client.
        const rt = await platform(undefined, Layer.succeed(AnalyticsStore, analytics));
        const built = rt.platform;
        Object.defineProperty(built, 'analytics', { value: analytics });
        const app = appFor(rt, alice);
        const paths = [
            '/operations/status',
            '/operations/overview',
            '/operations/series/turns',
            '/operations/turns',
            '/operations/reliability',
            '/operations/reliability/series',
            '/operations/reliability/breakdown/tool',
            '/operations/reliability/failures',
            '/operations/reliability/friction',
            '/operations/reliability/issues',
            '/operations/health',
            '/operations/health/series/first_output',
            '/operations/health/schedules',
            '/operations/health/runs',
            '/operations/health/long-runs',
            '/operations/activity',
            '/operations/value',
            '/operations/activity/people',
            '/operations/activity/socios',
            '/operations/activity/chats',
            '/operations/value/sessions',
            '/operations/knowledge',
            '/operations/knowledge/pages',
            '/operations/knowledge/datasets',
            '/operations/knowledge/grounding',
            '/operations/storage',
            '/operations/capabilities',
            '/operations/capabilities/requests',
            '/operations/cost',
            '/operations/themes',
        ];
        for (const path of paths) {
            const res = await app.request(`/api${path}?range=30d`);
            expect(res.status, `${code} ${path}`).toBe(200);
            const body = (await res.json()) as {
                state?: string;
                status?: { state: string; progress?: number };
                items?: unknown[];
            };
            // A section's answer says it is rebuilding; a list is empty.
            if (body.items) {
                expect(body.items, path).toEqual([]);
            } else {
                expect(body.status ?? body, path).toMatchObject({
                    state: 'rebuilding',
                    progress: 40,
                });
            }
        }
        // A chat's grounding (CB-194) is the transcript's: null while rebuilding.
        built.workspace.bindThread('t-ground', built.workspace.dots()[0]!.id, 'Grounded', alice.id);
        const grounded = await app.request('/api/operations/chats/t-ground/grounding');
        expect(grounded.status, `${code} chat grounding`).toBe(200);
        expect(await grounded.json()).toBeNull();
        // Every query a route asks is among them (a new section's too); the
        // price sync asks `costModels` (CB-195), no route.
        expect(
            Object.keys(OPS_QUERIES).filter(
                (name) => name !== 'freshness' && name !== 'costModels' && !asked.has(name),
            ),
        ).toEqual([]);
    }
});
