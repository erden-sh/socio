import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { OpsBucket, OpsFilters, OpsWindow } from '@socio/shared/operations/operations';
import type { OpsOutcome } from '@socio/shared/operations/operations-activity';
import { analyticsDefaults, type AnalyticsSettings } from '@socio/shared/operations/operations-analytics';

import { AnalyticsEngine } from '../src/server/operations/analytics/engine.js';
import '../src/server/operations/etl/sources.js';
import { ETL_STEPS, ETL_VERSION } from '../src/server/operations/analytics/steps.js';
import type { OpsQueryName } from '../src/server/operations/domain/ops-queries.js';
import type { OpsPageRequest, OpsScope } from '../src/server/operations/domain/reader.js';
import type { ActivityFacts } from '../src/server/operations/infra/memory/activity.js';
import { MemoryOpsReader, type MessageFact, type TurnFact } from '../src/server/operations/infra/memory/reader.js';

import { seedOpsActivity } from './fixtures/seed-ops-activity.js';
import { seedOpsDatabase, TEAM } from './fixtures/seed-ops-runs.js';

// Activity and Value (CB-190): the design's definitions (CB-164) in
// DuckDB, checked against the same definitions over facts in memory, and
// the definitions themselves on small hand-made chats.

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
    previous = true,
}: {
    from: number | null;
    to: number;
    bucket: OpsBucket;
    timeZone?: string;
    previous?: boolean;
}): OpsWindow {
    return {
        from,
        to,
        bucket,
        buckets: [bucket],
        previous: previous && from !== null ? { from: from - (to - from), to: from } : null,
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

async function ask<T = unknown>(e: AnalyticsEngine, query: OpsQueryName, params: object): Promise<T> {
    const answer = await e.handle({ op: 'query', query, params });
    if (!answer.ok) {
        throw new Error(`${query}: ${answer.error}`);
    }
    return answer.value as T;
}

/** A seeded database with Activity's sources, its store caught up, and the facts. */
async function seededStore(settings: Partial<AnalyticsSettings> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'ops-activity-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const seeded = seedOpsDatabase(join(dir, 'company-brain.sqlite'), {
        turns: 500,
        start: Date.now() - 40 * DAY,
        spanMs: 39 * DAY,
    });
    cleanup.push(() => seeded.db.close());
    const facts = seedOpsActivity(seeded);
    const e = new AnalyticsEngine({
        dir: join(dir, 'analytics'),
        sqlitePath: join(dir, 'company-brain.sqlite'),
        defaults: { ...analyticsDefaults({}), ...settings },
        defaultTimeZone: 'UTC',
        steps: ETL_STEPS,
        etlVersion: ETL_VERSION,
        lockRetryMs: 100,
        log: () => {},
    });
    cleanup.push(() => e.stop());
    const since = Date.now();
    await e.start();
    await until(async () => {
        if (e.status().state !== 'ready') {
            return false;
        }
        const fresh = await ask<{ sources: { source: string; at: number }[] }>(e, 'freshness', {}).catch(() => ({
            sources: [],
        }));
        return fresh.sources.length === ETL_STEPS.length && fresh.sources.every((source) => source.at >= since);
    });
    const memory = new MemoryOpsReader({
        turns: seeded.turns,
        messages: seeded.messages,
        ...facts,
    });
    return { e, memory, seeded, facts };
}

const CAPABILITIES = [
    { tool: 'search_pages', capability: 'pages' },
    { tool: 'read_page', capability: 'pages' },
    { tool: 'web_fetch', capability: 'web.read' },
];

/** Every page of a list, both ways, equal. */
async function sameList(
    e: AnalyticsEngine,
    memory: MemoryOpsReader,
    name: 'activityPeople' | 'activitySocios' | 'activityChats' | 'activitySessions',
    scope: OpsScope,
    options: { sessionGapMinutes: number; outcome?: OpsOutcome },
    limit = 7,
) {
    let cursor: OpsPageRequest['cursor'];
    let rows = 0;
    for (let pages = 0; pages < 200; pages++) {
        const page = { limit, ...(cursor ? { cursor } : {}) };
        const mine = await ask<{
            items: unknown[];
            next: OpsPageRequest['cursor'] | null;
        }>(e, name, {
            ...scope,
            ...page,
            sessionGapMinutes: options.sessionGapMinutes,
            ...(options.outcome ? { outcome: options.outcome } : {}),
        });
        expect(mine, `${name} ${JSON.stringify({ scope, options })}`).toEqual(await memory[name](scope, options, page));
        rows += mine.items.length;
        if (!mine.next) {
            return rows;
        }
        cursor = mine.next;
    }
    throw new Error('Too many pages');
}

describe('Activity and Value in DuckDB', { timeout: 240_000 }, () => {
    it('answer as the definitions over the facts do, for each filter, gap and time zone', async () => {
        const { e, memory, facts } = await seededStore();
        expect(facts.reactions!.length).toBeGreaterThan(20);
        expect(facts.approvals!.length).toBeGreaterThan(20);
        const now = Date.now();
        const windows = [
            { from: now - 7 * DAY, to: now, bucket: 'day' as const },
            { from: now - 30 * DAY, to: now, bucket: 'week' as const },
            {
                from: now - 20 * DAY,
                to: now - 6 * DAY,
                bucket: 'day' as const,
                timeZone: 'America/New_York',
            },
            { from: null, to: now, bucket: 'month' as const, previous: false },
        ];
        const filters: OpsFilters[] = [
            {},
            { socio: 'socio-b' },
            { space: 'space-1' },
            { source: 'telegram' },
            { source: 'scheduled' },
            { person: 'alice' },
            { person: TEAM },
            { source: 'nothing-here' },
        ];
        for (const window of windows) {
            for (const filter of filters) {
                for (const sessionGapMinutes of [30, 12 * 60]) {
                    const scope = scopeOf(window, filter);
                    const label = JSON.stringify({ window, filter, sessionGapMinutes });
                    expect(
                        await ask(e, 'activity', {
                            ...scope,
                            sessionGapMinutes,
                            capabilities: CAPABILITIES,
                        }),
                        label,
                    ).toEqual(
                        await memory.activity(scope, {
                            sessionGapMinutes,
                            capabilities: CAPABILITIES,
                        }),
                    );
                    expect(await ask(e, 'value', { ...scope, sessionGapMinutes }), label).toEqual(
                        await memory.value(scope, { sessionGapMinutes }),
                    );
                }
            }
        }
        // The drill-downs, page by page.
        const month = scopeOf({ from: now - 30 * DAY, to: now, bucket: 'day' });
        for (const name of ['activityPeople', 'activitySocios', 'activityChats', 'activitySessions'] as const) {
            expect(await sameList(e, memory, name, month, { sessionGapMinutes: 30 }), name).toBeGreaterThan(0);
        }
        for (const filter of [{ person: 'carol' }, { source: 'telegram' }]) {
            await sameList(
                e,
                memory,
                'activityChats',
                scopeOf({ from: now - 30 * DAY, to: now, bucket: 'day' }, filter),
                { sessionGapMinutes: 90 },
            );
        }
        for (const outcome of ['completed', 'answered', 'abandoned'] as const) {
            expect(
                await sameList(e, memory, 'activitySessions', month, {
                    sessionGapMinutes: 30,
                    outcome,
                }),
                outcome,
            ).toBeGreaterThan(0);
        }
    });

    it('re-derives sessions when the gap changes, and counts a shared session once', async () => {
        const { e } = await seededStore();
        const now = Date.now();
        const scope = scopeOf({ from: now - 35 * DAY, to: now, bucket: 'week' });
        const tile = async (gap: number, id: string, filters: OpsFilters = {}) =>
            (
                await ask<{ tiles: { id: string; value: number }[] }>(e, 'activity', {
                    ...scope,
                    filters,
                    sessionGapMinutes: gap,
                    capabilities: [],
                })
            ).tiles.find((t) => t.id === id)!.value;
        const short = await tile(1, 'sessions');
        const long = await tile(24 * 60, 'sessions');
        expect(short).toBeGreaterThan(long);
        // The shared topic's sessions are each person's, but the workspace's once.
        const topic = { source: 'telegram' };
        const all = await tile(24 * 60, 'sessions', topic);
        let each = 0;
        for (const person of ['alice', 'carol', 'erin', TEAM, 'bob']) {
            each += await tile(24 * 60, 'sessions', { ...topic, person });
        }
        expect(each).toBeGreaterThan(all);
    });

    it('credits a page to the socio whose create_space_page made it, when its turn arrives later', async () => {
        const { e, seeded } = await seededStore();
        const caughtUp = async () => {
            const since = Date.now();
            await e.handle({ op: 'nudge' });
            await until(async () => {
                const fresh = await ask<{ sources: { at: number }[] }>(e, 'freshness', {});
                return fresh.sources.every((source) => source.at >= since);
            });
        };
        const now = Date.now();
        const scope = scopeOf({ from: now - DAY, to: now + MINUTE, bucket: 'day' });
        const pages = seeded.db.prepare(
            `INSERT INTO pages (id, spaceId, title, content, revision, createdAt, updatedAt, sourceThreadId, createdBy)
      VALUES (?, 'space-2', 'A page', '', 1, ?, ?, ?, 'carol')`,
        );
        const chat = 'web-carol-socio-c';
        const called = now - 10 * MINUTE;
        // Mid-turn, the tool makes the page for the chat's owner, with no chat;
        // and Carol saves the chat as a page herself, which is hers.
        pages.run('page-by-tool', called + 40, called + 40, null);
        pages.run('page-saved', called + 50, called + 50, chat);
        await caughtUp();
        const space = async () =>
            (
                await ask<{
                    spaces: {
                        spaceId: string;
                        writesByPeople: number;
                        writesBySocios: number;
                    }[];
                }>(e, 'activity', { ...scope, sessionGapMinutes: 30, capabilities: [] })
            ).spaces.find((s) => s.spaceId === 'space-2')!;
        expect(await space()).toMatchObject({
            writesByPeople: 2,
            writesBySocios: 0,
        });
        // The turn ends, its call in the trace: the page is the socio's, in that
        // chat, and completes the session.
        seeded.db
            .prepare(
                'INSERT INTO agent_runs (threadId, runId, status, events, startedAt, finishedAt, source, trace) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
            )
            .run(
                chat,
                'run-page-tool',
                'finished',
                JSON.stringify([
                    {
                        type: 'RUN_STARTED',
                        threadId: chat,
                        runId: 'run-page-tool',
                        timestamp: called - 500,
                        input: {
                            threadId: chat,
                            runId: 'run-page-tool',
                            messages: [{ id: 'u-page-tool', role: 'user', content: 'Write it up.' }],
                            tools: [],
                            context: [],
                        },
                    },
                    {
                        type: 'TEXT_MESSAGE_START',
                        messageId: 'a-page-tool',
                        role: 'assistant',
                        timestamp: called + 900,
                    },
                    {
                        type: 'TEXT_MESSAGE_CONTENT',
                        messageId: 'a-page-tool',
                        delta: 'Done.',
                        timestamp: called + 950,
                    },
                    {
                        type: 'TEXT_MESSAGE_END',
                        messageId: 'a-page-tool',
                        timestamp: called + 1000,
                    },
                    {
                        type: 'RUN_FINISHED',
                        threadId: chat,
                        runId: 'run-page-tool',
                        timestamp: called + 2000,
                    },
                ]),
                called - 500,
                called + 2000,
                JSON.stringify({
                    rounds: [],
                    tools: [
                        {
                            kind: 'tool',
                            round: 1,
                            name: 'create_space_page',
                            startedAt: called,
                            endedAt: called + 80,
                            outcome: 'ok',
                        },
                    ],
                    waits: [],
                    end: { reason: 'completed', rounds: 1, cap: 12 },
                }),
            );
        await caughtUp();
        expect(await space()).toMatchObject({
            writesByPeople: 1,
            writesBySocios: 1,
        });
        const sessions = await ask<{
            items: { threadId: string; startedAt: number; outcome: string }[];
        }>(e, 'activitySessions', {
            ...scope,
            filters: { person: 'carol' },
            limit: 50,
            sessionGapMinutes: 30,
        });
        expect(sessions.items.find((s) => s.threadId === chat && s.startedAt >= called - 500)?.outcome).toBe(
            'completed',
        );
    });
});

// Hand-made chats: the definitions, one at a time.
const T0 = Date.UTC(2026, 9, 5, 9);
const SCOPE = scopeOf({ from: T0 - DAY, to: T0 + 10 * DAY, bucket: 'day' });
const GAP = { sessionGapMinutes: 30 };

function chat(
    threadId: string,
    socioId: string,
    source: string,
    lines: [at: number, author: string, status?: TurnFact['status']][],
) {
    const turns: TurnFact[] = [];
    const messages: MessageFact[] = [];
    for (const [index, [at, author, status]] of lines.entries()) {
        const runId = `${threadId}-r${index}`;
        const person = author !== socioId;
        if (person) {
            turns.push({
                runId,
                threadId,
                socioId,
                personId: author,
                source,
                status: status ?? 'finished',
                startedAt: at,
                finishedAt: at + 1000,
                endReason: (status ?? 'finished') === 'finished' ? 'completed' : 'error',
            });
        }
        messages.push({
            messageId: `${threadId}-m${index}`,
            runId: person ? runId : `${threadId}-r${index - 1}`,
            threadId,
            socioId,
            source,
            at,
            authorKind: person ? 'person' : 'socio',
            authorId: author,
        });
    }
    return { turns, messages };
}

function reader(chats: ReturnType<typeof chat>[], facts: ActivityFacts = {}): MemoryOpsReader {
    return new MemoryOpsReader({
        turns: chats.flatMap((c) => c.turns),
        messages: chats.flatMap((c) => c.messages),
        ...facts,
    });
}

const outcomes = async (r: MemoryOpsReader, filters: OpsFilters = {}) =>
    (await r.activitySessions({ ...SCOPE, filters }, GAP, { limit: 50 })).items.map((s) => [
        s.threadId,
        s.outcome,
        s.messages,
    ]);

describe('the definitions', () => {
    it('cuts sessions at the gap, from anyone’s messages in the chat', async () => {
        const r = reader([
            chat('c1', 's1', 'web', [
                [T0, 'ann'],
                [T0 + MINUTE, 's1'],
                [T0 + 29 * MINUTE, 'ann'],
                [T0 + 50 * MINUTE, 's1'],
                // 30 minutes after: a new session.
                [T0 + 80 * MINUTE, 'ann'],
            ]),
        ]);
        expect(await outcomes(r)).toEqual([
            ['c1', 'answered', 1],
            ['c1', 'answered', 4],
        ]);
        // A longer gap makes them one.
        const one = await r.activitySessions(
            SCOPE,
            { sessionGapMinutes: 31 },
            {
                limit: 10,
            },
        );
        expect(one.items.map((s) => s.messages)).toEqual([5]);
    });

    it('completes a session with a signal within 24 hours, and abandons a failed one left alone', async () => {
        const r = reader(
            [
                chat('up', 's1', 'web', [
                    [T0, 'ann'],
                    [T0 + MINUTE, 's1'],
                ]),
                chat('fail', 's1', 'web', [[T0, 'ann', 'failed']]),
                chat('fail-back', 's1', 'web', [
                    [T0, 'ann', 'failed'],
                    // Back the next morning: not abandoned.
                    [T0 + 20 * HOUR, 'ann'],
                ]),
                chat('late', 's1', 'web', [
                    [T0, 'ann'],
                    [T0 + MINUTE, 's1'],
                ]),
                chat('expired', 's1', 'web', [
                    [T0, 'ann'],
                    [T0 + MINUTE, 's1'],
                ]),
                chat('page', 's2', 'web', [
                    [T0, 'ann'],
                    [T0 + MINUTE, 's2'],
                ]),
                chat('down', 's1', 'web', [
                    [T0, 'ann'],
                    [T0 + MINUTE, 's1'],
                ]),
                chat('saved', 's1', 'web', [
                    [T0, 'ann'],
                    [T0 + MINUTE, 's1'],
                ]),
            ],
            {
                reactions: [
                    {
                        threadId: 'up',
                        messageId: 'up-m1',
                        personId: 'ann',
                        kind: 'up',
                        at: T0 + 2 * HOUR,
                    },
                    // Too late to count.
                    {
                        threadId: 'late',
                        messageId: 'late-m1',
                        personId: 'ann',
                        kind: 'up',
                        at: T0 + 25 * HOUR,
                    },
                    {
                        threadId: 'down',
                        messageId: 'down-m1',
                        personId: 'ann',
                        kind: 'up',
                        at: T0 + 2 * MINUTE,
                    },
                    {
                        threadId: 'down',
                        messageId: 'down-m1',
                        personId: 'bo',
                        kind: 'down',
                        at: T0 + 3 * MINUTE,
                    },
                ],
                approvals: [
                    {
                        id: 'a1',
                        at: T0 + HOUR,
                        threadId: 'expired',
                        socioId: 's1',
                        personId: 'ann',
                        capability: 'web.post',
                        event: 'expired',
                    },
                ],
                // The socio's page tool, in no chat, while its session ran.
                spaceWrites: [
                    {
                        at: T0 + 30_000,
                        spaceId: 'sp',
                        pageId: 'p1',
                        authorKind: 'socio',
                        authorId: 's2',
                        threadId: null,
                    },
                    // A person's "Save as page" from the chat: not the socio's work.
                    {
                        at: T0 + 2 * MINUTE,
                        spaceId: 'sp',
                        pageId: 'p2',
                        authorKind: 'person',
                        authorId: 'ann',
                        threadId: 'saved',
                    },
                ],
            },
        );
        const got = Object.fromEntries((await outcomes(r)).map(([thread, outcome]) => [thread, outcome]));
        expect(got).toEqual({
            up: 'completed',
            fail: 'abandoned',
            'fail-back': 'answered',
            late: 'answered',
            expired: 'abandoned',
            page: 'completed',
            down: 'abandoned',
            saved: 'answered',
        });
    });

    it('credits a shared session to every person in it, and the workspace once', async () => {
        const r = reader([
            chat('topic', 's1', 'telegram', [
                [T0, 'ann'],
                [T0 + MINUTE, 'bo'],
                [T0 + 2 * MINUTE, 's1'],
            ]),
        ]);
        const tiles = async (filters: OpsFilters) =>
            Object.fromEntries(
                (await r.activity({ ...SCOPE, filters }, { ...GAP, capabilities: [] })).tiles.map((t) => [
                    t.id,
                    t.value,
                ]),
            );
        expect(await tiles({})).toMatchObject({
            sessions: 1,
            people: 2,
            length: 3,
        });
        expect(await tiles({ person: 'ann' })).toMatchObject({ sessions: 1 });
        expect(await tiles({ person: 'bo' })).toMatchObject({ sessions: 1 });
        const people = await r.activityPeople(SCOPE, GAP, { limit: 10 });
        expect(people.items.map((p) => [p.personId, p.sessions])).toEqual([
            ['bo', 1],
            ['ann', 1],
        ]);
        expect((await r.activity(SCOPE, { ...GAP, capabilities: [] })).participation).toMatchObject({
            chats: 1,
            withSeveralPeople: 1,
        });
    });

    it('takes human and automation from the source registry', async () => {
        const r = reader([
            chat('web', 's1', 'web', [[T0, 'ann']]),
            // A schedule's chat, and a source nobody registered: not people's use.
            chat('sched', 's1', 'scheduled', [[T0, 'ann']]),
            chat('zap', 's1', 'zapier', [[T0, 'ann']]),
        ]);
        const answer = await r.activity(SCOPE, { ...GAP, capabilities: [] });
        expect(answer.tiles.find((t) => t.id === 'sessions')!.value).toBe(1);
        expect(answer.sources.map((s) => [s.key, s.kind, s.turns])).toEqual([
            ['scheduled', 'automation', 1],
            ['web', 'human', 1],
            ['zapier', 'unknown', 1],
        ]);
    });

    it('measures repeat use: returning people, stickiness and chats resumed', async () => {
        const day = (n: number, hour = 0) => T0 + n * DAY + hour * HOUR;
        const r = reader([
            chat('c1', 's1', 'web', [
                [day(-5), 'ann'],
                [day(1), 'ann'],
                [day(3), 'ann'],
            ]),
            chat('c2', 's1', 'web', [[day(2), 'bo']]),
        ]);
        const week = scopeOf({ from: day(0), to: day(7), bucket: 'day' });
        const tiles = Object.fromEntries(
            (await r.activity(week, { ...GAP, capabilities: [] })).tiles.map((t) => [t.id, [t.value, t.previous]]),
        );
        // Ann was here the week before too; Bo wasn't.
        expect(tiles.returning).toEqual([1, 0]);
        expect(tiles.people).toEqual([2, 1]);
        // Daily people summed (3) over each day's people of the last 7 days,
        // for the 8 days the window touches.
        expect(tiles.stickiness![0]).toBeCloseTo(3 / (1 + 1 + 2 + 2 + 2 + 2 + 2 + 2));
        const value = Object.fromEntries((await r.value(week, GAP)).tiles.map((t) => [t.id, t.value]));
        expect(value.resumption).toBe(0.5);
    });
});
