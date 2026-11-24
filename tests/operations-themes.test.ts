import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { THEMES_MIN_PEOPLE, topicKey, type ThemeOutcome } from '@socio/shared/classify';
import type { OpsBucket, OpsFilters, OpsWindow } from '@socio/shared/operations/operations';
import { analyticsDefaults } from '@socio/shared/operations/operations-analytics';
import type { OpsLabelledSession, OpsThemes, OpsThemesFacts } from '@socio/shared/operations/operations-themes';

import '../src/server/operations/etl/sources.js';
import type { Settings, User } from '@socio/shared/types';

import { AnalyticsEngine } from '../src/server/operations/analytics/engine.js';
import { ETL_STEPS, ETL_VERSION } from '../src/server/operations/analytics/steps.js';
import type { OpsScope } from '../src/server/operations/domain/reader.js';
import type { IntentFact, ThemeFact } from '../src/server/operations/infra/memory/activity.js';
import { MemoryOpsReader } from '../src/server/operations/infra/memory/reader.js';
import { operationsRoutes } from '../src/server/operations/routes.js';
import { aggregateThemes } from '../src/server/operations/themes/aggregate.js';

import { seedOpsActivity } from './fixtures/seed-ops-activity.js';
import { seedOpsDatabase } from './fixtures/seed-ops-runs.js';

// Themes (CB-199): sessions' intent and themes from the classify seam's
// labels, copied by the ETL, given to each session by its earliest
// labeled turn, clustered by topic and week, and named only above the
// privacy floor; the same answers in DuckDB as over facts in memory.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

function windowOf({
    from,
    to,
    bucket,
    timeZone = 'UTC',
}: {
    from: number | null;
    to: number;
    bucket: OpsBucket;
    timeZone?: string;
}): OpsWindow {
    return {
        from,
        to,
        bucket,
        buckets: [bucket],
        previous: from !== null ? { from: from - (to - from), to: from } : null,
        timeZone,
    };
}
const scopeOf = (window: Parameters<typeof windowOf>[0], filters: OpsFilters = {}): OpsScope => ({
    window: windowOf(window),
    filters,
});

async function until<T>(check: () => T | Promise<T>, timeoutMs = 60_000) {
    const started = Date.now();
    for (;;) {
        const value = await check();
        if (value) {
            return value;
        }
        if (Date.now() - started > timeoutMs) {
            throw new Error('Timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

async function ask<T = unknown>(e: AnalyticsEngine, query: string, params: object): Promise<T> {
    const answer = await e.handle({ op: 'query', query, params } as never);
    if (!answer.ok) {
        throw new Error(`${query}: ${answer.error}`);
    }
    return answer.value as T;
}

let seq = 0;
function label(db: DatabaseSync, use: 'intent' | 'themes', runId: string, value: string, applied = true) {
    db.prepare(
        `INSERT INTO classify_labels(use, labelsVersion, runId, idx, label, source, provider, version, confidence, applied, input, actorId, at)
    VALUES (?, 1, ?, -1, ?, 'model', 'workspace', 'workspace:m/p1', 0.95, ?, '{}', NULL, ?)`,
    ).run(use, runId, value, applied ? 1 : 0, ++seq);
}

const INTENTS = ['ask', 'write', 'analyse', 'research'];
// Wordings of a few themes: some shared by many people, one by a single
// chat's people only.
const TOPICS = [
    ['March invoices', 'invoice for march', 'Invoices: March'],
    ['Onboarding checklist', 'onboarding checklists'],
    ['Quarterly forecast'],
];
const HINTS: ThemeOutcome[] = ['resolved', 'unresolved', 'unclear'];

/** A seeded store with intent and theme labels on many person turns. */
async function seededStore() {
    const dir = mkdtempSync(join(tmpdir(), 'ops-themes-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const seeded = seedOpsDatabase(join(dir, 'company-brain.sqlite'), {
        turns: 400,
        start: Date.now() - 40 * DAY,
        spanMs: 39 * DAY,
    });
    cleanup.push(() => seeded.db.close());
    const facts = seedOpsActivity(seeded);
    const intents = new Map<string, string>();
    const themes = new Map<string, ThemeFact[]>();
    for (const [index, turn] of seeded.turns.entries()) {
        if (!turn.personId) {
            continue;
        }
        if (index % 2 === 0) {
            // An earlier answer the newest replaces, and one that isn't applied.
            label(seeded.db, 'intent', turn.runId, 'other');
            const intent = INTENTS[index % INTENTS.length]!;
            label(seeded.db, 'intent', turn.runId, intent);
            label(seeded.db, 'intent', turn.runId, 'admin', false);
            intents.set(turn.runId, intent);
        }
        if (index % 3 === 0) {
            const group = TOPICS[Math.floor(index / 3) % TOPICS.length]!;
            const topics = [group[index % group.length]!];
            // A theme of one chat: under the floor, unless a team writes in it.
            if (index % 7 === 0) {
                topics.push(`Project ${turn.threadId}`);
            }
            const outcome = HINTS[index % HINTS.length]!;
            label(seeded.db, 'themes', turn.runId, JSON.stringify({ topics, outcome }));
            themes.set(
                turn.runId,
                topics.map((topic) => ({ runId: turn.runId, topic, outcome })),
            );
        }
    }
    const e = new AnalyticsEngine({
        dir: join(dir, 'analytics'),
        sqlitePath: join(dir, 'company-brain.sqlite'),
        defaults: analyticsDefaults({}),
        defaultTimeZone: 'UTC',
        steps: ETL_STEPS,
        etlVersion: ETL_VERSION,
        lockRetryMs: 100,
        log: () => {},
    });
    cleanup.push(() => e.stop());
    const since = Date.now();
    await e.start();
    const caughtUp = async (after: number) => {
        await until(async () => {
            if (e.status().state !== 'ready') {
                return false;
            }
            const fresh = await ask<{ sources: { source: string; at: number }[] }>(e, 'freshness', {}).catch(() => ({
                sources: [],
            }));
            return fresh.sources.length === ETL_STEPS.length && fresh.sources.every((source) => source.at >= after);
        });
    };
    await caughtUp(since);
    const memory = (extra: { intents?: IntentFact[]; themes?: ThemeFact[] } = {}) =>
        new MemoryOpsReader({
            turns: seeded.turns,
            messages: seeded.messages,
            ...facts,
            intents: [...[...intents].map(([runId, intent]) => ({ runId, intent })), ...(extra.intents ?? [])],
            themes: [...[...themes.values()].flat(), ...(extra.themes ?? [])],
        });
    return { e, memory, seeded, caughtUp };
}

describe('Themes in DuckDB', { timeout: 240_000 }, () => {
    it('answer as the same definitions over the facts do, for each filter, gap and time zone', async () => {
        const { e, memory } = await seededStore();
        const reader = memory();
        const now = Date.now();
        const windows = [
            { from: now - 30 * DAY, to: now, bucket: 'week' as const },
            {
                from: now - 20 * DAY,
                to: now - 6 * DAY,
                bucket: 'day' as const,
                timeZone: 'America/New_York',
            },
            { from: null, to: now, bucket: 'month' as const },
        ];
        const filters: OpsFilters[] = [{}, { socio: 'socio-b' }, { person: 'alice' }, { source: 'telegram' }];
        let named = 0;
        for (const window of windows) {
            for (const filter of filters) {
                for (const sessionGapMinutes of [30, 12 * 60]) {
                    const scope = scopeOf(window, filter);
                    const label = JSON.stringify({ window, filter, sessionGapMinutes });
                    const themes = await ask<OpsThemesFacts>(e, 'themes', {
                        ...scope,
                        sessionGapMinutes,
                    });
                    expect(themes, label).toEqual(await reader.themes(scope, { sessionGapMinutes }));
                    named += themes.themes.length;
                    // One person alone never sees a theme named.
                    if (filter.person) {
                        expect(themes.themes, label).toEqual([]);
                    }
                    for (const row of themes.themes) {
                        expect(row.people, label).toBeGreaterThanOrEqual(THEMES_MIN_PEOPLE);
                    }
                    const value = await ask<{ intents: unknown }>(e, 'value', {
                        ...scope,
                        sessionGapMinutes,
                    });
                    expect(value.intents, label).toEqual((await reader.value(scope, { sessionGapMinutes })).intents);
                }
            }
        }
        expect(named).toBeGreaterThan(0);
        const month = await ask<OpsThemesFacts>(e, 'themes', {
            ...scopeOf({ from: now - 30 * DAY, to: now, bucket: 'week' }),
            sessionGapMinutes: 30,
        });
        // The wordings of a theme are one theme; a one-person chat's project isn't named.
        expect(month.themes.map((row) => row.key)).toEqual(
            expect.arrayContaining([
                topicKey('march invoices'),
                topicKey('onboarding checklist'),
                topicKey('quarterly forecast'),
            ]),
        );
        expect(month.hidden.themes).toBeGreaterThan(0);
        expect(month.intents.map((row) => row.intent)).toContain(null);
        // The newest applied intent wins; a later suggestion doesn't count.
        expect(month.intents.map((row) => row.intent)).not.toContain('other');
        expect(month.intents.map((row) => row.intent)).not.toContain('admin');
        expect(month.withIntent).toBeGreaterThan(0);
        expect(month.weeks.length).toBe(month.weekSessions.length);
        for (const row of month.themes) {
            expect(row.weeks.reduce((a, b) => a + b, 0)).toBe(row.sessions);
        }
    });

    it('copies new labels at the next cycle, the newest per turn replacing the last', async () => {
        const { e, memory, seeded, caughtUp } = await seededStore();
        const turn = seeded.turns.find((t, index) => t.personId && index % 2 === 1 && index % 3 !== 0)!;
        label(seeded.db, 'intent', turn.runId, 'automate');
        label(seeded.db, 'themes', turn.runId, JSON.stringify({ topics: ['Payroll run'], outcome: 'unresolved' }));
        const since = Date.now();
        await e.handle({ op: 'nudge' } as never);
        await caughtUp(since);
        const scope = scopeOf({ from: null, to: Date.now(), bucket: 'month' });
        const reader = memory({
            intents: [{ runId: turn.runId, intent: 'automate' }],
            themes: [{ runId: turn.runId, topic: 'Payroll run', outcome: 'unresolved' }],
        });
        const themes = await ask<OpsThemesFacts>(e, 'themes', {
            ...scope,
            sessionGapMinutes: 30,
        });
        expect(themes).toEqual(await reader.themes(scope, { sessionGapMinutes: 30 }));
        expect(themes.intents.map((row) => row.intent)).toContain('automate');
    });
});

describe('the aggregation', () => {
    const session = (id: string, patch: Partial<OpsLabelledSession> = {}): OpsLabelledSession => ({
        id,
        startedAt: Date.UTC(2026, 9, 6, 12),
        outcome: 'answered',
        people: [id],
        intent: null,
        topics: [],
        hint: null,
        ...patch,
    });
    const topic = (text: string) => ({ topic: text, key: topicKey(text) });
    const range = {
        from: Date.UTC(2026, 9, 5),
        to: Date.UTC(2026, 9, 19),
        timeZone: 'UTC',
    };

    it('names a theme only when enough different people share it', () => {
        const facts = aggregateThemes(
            [
                session('a', {
                    topics: [topic('March invoices')],
                    outcome: 'abandoned',
                    hint: 'unresolved',
                    intent: 'write',
                }),
                session('b', { topics: [topic('invoice for March')], intent: 'write' }),
                // The same person twice is still two sessions but one person.
                session('c', {
                    people: ['a'],
                    topics: [topic('Invoices march'), topic('Secret merger')],
                    startedAt: Date.UTC(2026, 9, 13),
                    outcome: 'completed',
                }),
                session('d', { topics: [topic('Secret merger')] }),
                session('e', { intent: 'ask' }),
            ],
            range,
        );
        expect(facts.themes).toEqual([]);
        expect(facts.hidden).toEqual({ themes: 2, sessions: 4 });
        const more = aggregateThemes(
            [
                session('a', { topics: [topic('March invoices')], intent: 'write' }),
                session('b', { topics: [topic('invoice for March')], intent: 'write' }),
                session('c', {
                    topics: [topic('Invoices march'), topic('Secret merger')],
                    startedAt: Date.UTC(2026, 9, 13),
                    outcome: 'completed',
                    hint: 'resolved',
                }),
                session('d', { topics: [topic('Secret merger')] }),
            ],
            range,
        );
        expect(more.themes).toHaveLength(1);
        expect(more.themes[0]).toMatchObject({
            key: topicKey('March invoices'),
            sessions: 3,
            people: 3,
            completed: 1,
            answered: 2,
            hints: { resolved: 1, unresolved: 0, unclear: 0 },
            intents: [
                { intent: 'write', sessions: 2 },
                { intent: null, sessions: 1 },
            ],
        });
        // Weeks from Monday: the 5th and the 12th of October 2026.
        expect(more.weeks).toEqual([Date.UTC(2026, 9, 5), Date.UTC(2026, 9, 12)]);
        expect(more.themes[0]!.weeks).toEqual([2, 1]);
        expect(more.weekSessions).toEqual([3, 1]);
        // "Secret merger" (two people) stays unnamed, its session apart counted.
        expect(more.hidden).toEqual({ themes: 1, sessions: 1 });
        expect(JSON.stringify(more)).not.toMatch(/merger/i);
    });

    it('counts intents with outcomes, sessions without one last', () => {
        const facts = aggregateThemes(
            [
                session('a', { intent: 'ask', outcome: 'completed' }),
                session('b', { intent: 'ask', outcome: 'abandoned', people: ['a'] }),
                session('c', { outcome: 'abandoned' }),
                session('d', { intent: 'write' }),
                session('e', { intent: 'write' }),
                session('f', { intent: 'write', people: [] }),
            ],
            range,
        );
        expect(facts.intents).toEqual([
            {
                intent: 'write',
                sessions: 3,
                people: 2,
                completed: 0,
                answered: 3,
                abandoned: 0,
            },
            {
                intent: 'ask',
                sessions: 2,
                people: 1,
                completed: 1,
                answered: 0,
                abandoned: 1,
            },
            {
                intent: null,
                sessions: 1,
                people: 1,
                completed: 0,
                answered: 0,
                abandoned: 1,
            },
        ]);
        expect(facts.withIntent).toBe(5);
    });
});

describe('the route', () => {
    const alice: User = { id: 'alice', name: 'Alice', role: 'admin' };
    it('answers Themes, and logs it narrowed to one person', async () => {
        const audited: string[] = [];
        const settings = {} as Settings;
        const reader = new MemoryOpsReader();
        const app = new Hono<AppEnv>();
        app.use(async (c, next) => {
            c.set('user', alice);
            await next();
        });
        app.route(
            '/api',
            operationsRoutes({
                reader,
                settings: {
                    settings: () => settings,
                    updateSettings: async (patch) => Object.assign(settings, patch),
                },
                audit: (options) => async (c, next) => {
                    audited.push(options.surface);
                    await next();
                },
            }),
        );
        const answer = (await (await app.request('/api/operations/themes?range=30d')).json()) as OpsThemes;
        expect(answer).toMatchObject({
            status: { state: 'unavailable' },
            sessionGapMinutes: 30,
            facts: null,
        });
        expect(audited).toEqual([]);
        await app.request('/api/operations/themes?range=30d&person=bob');
        expect(audited).toEqual(['themes']);
        expect((await app.request('/api/operations/themes?range=nope')).status).toBe(400);
    });
});
