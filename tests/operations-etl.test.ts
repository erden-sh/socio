import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runFacts } from '@socio/foundation/operations/run-facts';
import { bucketStart } from '@socio/shared/operations/operations';
import { registerRunSource, runSource, runSources } from '@socio/shared/runs/run-sources';

import { calendarRows } from '../src/server/operations/etl/calendar.js';
import { ETL_SOURCE_MAP } from '../src/server/operations/etl/source-map.js';
import { ETL_BATCH, ETL_BATCH_BYTES } from '../src/server/operations/etl/source-reader.js';
import { openDuck, rows } from '../src/server/operations/infra/duckdb/open.js';
import { sqliteSourceReader } from '../src/server/operations/infra/sqlite/source-reader.js';
import '../src/server/operations/etl/sources.js';

import { TEAM } from './fixtures/seed-ops-runs.js';
import { testDatabase } from './helpers/test-database.js';
import {
    DAY,
    cleanup,
    scratch,
    seed,
    engine,
    ask,
    caughtUp,
    scopeOf,
    sameAnswers,
    sameTurns,
    memoryOf,
    runCleanup,
} from './support/operations-etl.js';

// The Operations ETL (CB-187): turns, messages and tool calls copied from
// SQLite into DuckDB by the analytics process, with watermarks, rollups and
// the Overview's queries, checked against CB-184's in-memory reader.

afterEach(runCleanup);

describe('the source map', () => {
    it('names columns the modules’ migrations make, and fails when one changes', () => {
        const db = testDatabase();
        cleanup.push(() => db.close());
        const drift = () => {
            const problems: string[] = [];
            for (const [table, columns] of Object.entries(ETL_SOURCE_MAP)) {
                const info = new Map(
                    (
                        db.prepare(`PRAGMA table_info(${table})`).all() as {
                            name: string;
                            type: string;
                        }[]
                    ).map((column) => [column.name, column.type]),
                );
                for (const [column, type] of Object.entries(columns)) {
                    if (info.get(column) !== type) {
                        problems.push(`${table}.${column}: ${info.get(column) ?? 'gone'}`);
                    }
                }
            }
            return problems;
        };
        expect(drift()).toEqual([]);
        // Every registered source's chats are in the map too.
        for (const source of runSources()) {
            if (source.threads) {
                expect(ETL_SOURCE_MAP[source.threads.table as keyof typeof ETL_SOURCE_MAP]).toHaveProperty(
                    source.threads.column,
                );
            }
        }
        db.exec('ALTER TABLE agent_runs RENAME COLUMN trace TO runTrace');
        expect(drift()).toEqual(['agent_runs.trace: gone']);
    });
});

describe('the source registry', () => {
    it('is open: modules add sources, and an unknown key shows as itself', () => {
        expect(runSource('telegram')).toMatchObject({
            label: 'Telegram',
            kind: 'human',
            threads: { table: 'telegram_threads', column: 'threadId' },
        });
        expect(runSource('scheduled')).toMatchObject({
            kind: 'automation',
            actor: 'schedule',
        });
        expect(runSource('zapier')).toEqual({
            key: 'zapier',
            label: 'zapier',
            kind: 'unknown',
            channel: 'zapier',
        });
        expect(() =>
            registerRunSource({
                key: 'Bad Key',
                label: 'x',
                kind: 'human',
                channel: 'x',
            }),
        ).toThrow();
        expect(() =>
            registerRunSource({
                key: 'evil',
                label: 'x',
                kind: 'human',
                channel: 'x',
                threads: { table: 'x; DROP TABLE users', column: 'id' },
            }),
        ).toThrow();
    });
});

describe('a turn as facts', () => {
    const base = {
        seq: 1,
        runId: 'r1',
        threadId: 't1',
        status: 'finished',
        startedAt: 1000,
        finishedAt: 5000,
        source: 'telegram',
        socioId: 'socio-a',
        ownerId: TEAM,
    };
    const events = JSON.stringify([
        {
            type: 'RUN_STARTED',
            timestamp: 1000,
            input: {
                messages: [
                    {
                        id: 'u1',
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Hello there' },
                            { type: 'binary', id: 'cbatt_x' },
                        ],
                    },
                ],
            },
        },
        {
            type: 'TEXT_MESSAGE_START',
            messageId: 'a1',
            role: 'assistant',
            timestamp: 2000,
        },
        {
            type: 'TEXT_MESSAGE_CONTENT',
            messageId: 'a1',
            delta: 'Hi!',
            timestamp: 2100,
        },
        {
            type: 'TEXT_MESSAGE_CONTENT',
            messageId: 'a1',
            delta: ' Yes.',
            timestamp: 2200,
        },
    ]);

    it('credits a turn from before CB-185 to the chat’s owner, a team here', () => {
        const facts = runFacts({
            ...base,
            events,
            trace: JSON.stringify({
                rounds: [
                    {
                        kind: 'round',
                        round: 1,
                        inputTokens: 10,
                        outputTokens: 4,
                        reasoningTokens: 2,
                    },
                    {
                        kind: 'round',
                        round: 2,
                        inputTokens: 5,
                        outputTokens: 1,
                        retry: 1,
                    },
                ],
                tools: [
                    {
                        name: 'web_fetch',
                        startedAt: 1100,
                        endedAt: 1600,
                        outcome: 'timeout',
                    },
                    {
                        name: 'read_page',
                        startedAt: 1700,
                        endedAt: 1750,
                        outcome: 'refused',
                        error: 'denied',
                    },
                ],
                waits: [{ for: 'approval' }, { for: 'person' }, { for: 'approval' }],
                retries: [{}],
                fallback: { reason: 'rate_limited' },
            }),
        });
        expect(facts.turn).toMatchObject({
            triggerKind: 'person',
            triggerId: TEAM,
            attribution: 'owner',
            rounds: 1,
            inputTokens: 15,
            outputTokens: 5,
            reasoningTokens: 2,
            reasoningTokensReported: true,
            reasoningKind: 'unknown',
            toolCalls: 2,
            toolErrors: 1,
            toolRefusals: 1,
            approvalWaits: 2,
            personWaits: 1,
            retries: 1,
            fallbackReason: 'rate_limited',
        });
        expect(facts.messages).toEqual([
            {
                messageId: 'u1',
                sentAt: 1000,
                authorKind: 'person',
                authorId: TEAM,
                attribution: 'owner',
                chars: 11,
                attachments: 1,
            },
            {
                messageId: 'a1',
                sentAt: 2000,
                authorKind: 'socio',
                authorId: 'socio-a',
                attribution: 'exact',
                chars: 8,
                attachments: 0,
            },
        ]);
        expect(facts.tools).toEqual([
            expect.objectContaining({
                tool: 'web_fetch',
                outcome: 'timeout',
                durationMs: 500,
                code: null,
            }),
            expect.objectContaining({
                tool: 'read_page',
                outcome: 'refused',
                code: 'denied',
            }),
        ]);
    });

    it('reads who started it and wrote what from CB-185’s trace', () => {
        const facts = runFacts({
            ...base,
            events,
            trace: JSON.stringify({
                receivedAt: 900,
                trigger: { kind: 'person', id: 'carol' },
                messages: [
                    { id: 'u1', author: { kind: 'person', id: 'carol' }, at: 900 },
                    { id: 'a1', author: { kind: 'socio', id: 'socio-a' }, at: 2000 },
                    { id: 'g1', author: { kind: 'socio', id: 'socio-b' }, at: 2500 },
                ],
                rounds: [
                    { round: 1, reasoningKind: 'summary' },
                    { round: 2, reasoningKind: 'none' },
                ],
                totals: { rounds: 2, inputTokens: 7, outputTokens: 3 },
            }),
        });
        expect(facts.turn).toMatchObject({
            triggerKind: 'person',
            triggerId: 'carol',
            attribution: 'exact',
            receivedAt: 900,
            reasoningKind: 'summary',
            reasoningTokensReported: false,
        });
        expect(
            facts.messages.map((m) => [m.messageId, m.authorKind, m.authorId, m.attribution, m.sentAt, m.chars]),
        ).toEqual([
            ['u1', 'person', 'carol', 'exact', 900, 11],
            ['a1', 'socio', 'socio-a', 'exact', 2000, 8],
            // Another socio in the same chat (several per chat).
            ['g1', 'socio', 'socio-b', 'exact', 2500, null],
        ]);
    });

    it('counts a message sent mid-turn as the person’s, and no busy notice as the socio’s', () => {
        const facts = runFacts({
            ...base,
            events: JSON.stringify([
                {
                    type: 'RUN_STARTED',
                    timestamp: 1000,
                    input: { messages: [{ id: 'u1', role: 'user', content: 'Go' }] },
                },
                // CB-151's steering: the person's message, delivered mid-turn.
                {
                    type: 'TEXT_MESSAGE_START',
                    messageId: 'u2',
                    role: 'user',
                    timestamp: 3000,
                },
                {
                    type: 'TEXT_MESSAGE_CONTENT',
                    messageId: 'u2',
                    delta: 'And this',
                    timestamp: 3000,
                },
                // CB-140's notice that the model is busy: not a message.
                {
                    type: 'TEXT_MESSAGE_START',
                    messageId: 'status-1',
                    role: 'assistant',
                    timestamp: 4000,
                },
                {
                    type: 'TEXT_MESSAGE_CONTENT',
                    messageId: 'status-1',
                    delta: 'Busy',
                    timestamp: 4000,
                },
            ]),
            trace: JSON.stringify({
                trigger: { kind: 'person', id: 'carol' },
                messages: [
                    { id: 'u1', author: { kind: 'person', id: 'carol' }, at: 1000 },
                    {
                        id: 'status-1',
                        author: { kind: 'socio', id: 'socio-a' },
                        at: 4000,
                    },
                ],
            }),
        });
        expect(
            facts.messages.map((m) => [m.messageId, m.authorKind, m.authorId, m.attribution, m.sentAt, m.chars]),
        ).toEqual([
            ['u1', 'person', 'carol', 'exact', 1000, 2],
            ['u2', 'person', 'carol', 'exact', 3000, 8],
        ]);
    });

    it('credits an automation’s turns to its kind, and survives junk', () => {
        const facts = runFacts({
            ...base,
            source: 'scheduled',
            events: JSON.stringify([
                {
                    type: 'RUN_STARTED',
                    input: { messages: [{ id: 'u1', role: 'user', content: 'Report' }] },
                },
                { type: 'RUN_ERROR', code: 'chatgpt_usage_limit' },
            ]),
            status: 'failed',
            trace: '{not json',
        });
        expect(facts.turn).toMatchObject({
            triggerKind: 'schedule',
            triggerId: null,
            attribution: 'source',
            failureCode: 'chatgpt_usage_limit',
            reasoningKind: 'unknown',
            inputTokens: null,
        });
        expect(facts.messages[0]).toMatchObject({
            authorKind: 'schedule',
            authorId: null,
            sentAt: 1000,
        });
        expect(runFacts({ ...base, events: 'nope', trace: null }).messages).toEqual([]);
        // Mixed reasoning across rounds (after a fallback).
        expect(
            runFacts({
                ...base,
                events: '[]',
                trace: JSON.stringify({
                    rounds: [{ reasoningKind: 'raw' }, { reasoningKind: 'summary' }],
                }),
            }).turn.reasoningKind,
        ).toBe('mixed');
    });
});

// About 140,000 zoned-time conversions, CPU only and no clock in what it
// checks: seconds alone, many times that on a loaded host. The limit only
// stops a hang, as for the ETL below.
describe('the calendar', { timeout: 120_000 }, () => {
    it('cuts hours and days exactly as the Overview’s buckets, across clock changes', () => {
        for (const timeZone of ['America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe', 'Europe/London']) {
            const from = Date.UTC(2026, 2, 1);
            const to = Date.UTC(2026, 3, 15);
            const rows = calendarRows(from, to, timeZone);
            let row = 0;
            for (let at = from; at < to; at += 7 * 60_000 + 13_000) {
                while (row + 1 < rows.length && rows[row + 1]!.utcAt <= at) {
                    row++;
                }
                const r = rows[row]!;
                expect([r.hourAt, r.dayAt, r.weekAt, r.monthAt], `${timeZone} ${at}`).toEqual([
                    bucketStart(at, 'hour', timeZone),
                    bucketStart(at, 'day', timeZone),
                    bucketStart(at, 'week', timeZone),
                    bucketStart(at, 'month', timeZone),
                ]);
            }
        }
    });
});

// Each builds DuckDB files from a seeded database: slow on a loaded host.
describe('the ETL', { timeout: 120_000 }, () => {
    it('copies a seeded database and answers as CB-184’s reader does', async () => {
        const s = scratch();
        const seeded = seed(s);
        const { e } = engine(s);
        await e.start();
        await caughtUp(e, seeded.db);
        const memory = memoryOf(seeded);
        const now = Date.now();
        await sameAnswers(e, memory, [
            // The Overview's default: the last 7 days, hourly, not on an hour.
            { from: now - 7 * DAY, to: now, bucket: 'hour' },
            { from: now - 30 * DAY, to: now, bucket: 'day' },
            { from: now - 30 * DAY, to: now, bucket: 'week' },
            { from: null, to: now, bucket: 'month', previous: false },
            // Older than the hourly rollups keep: from the facts.
            { from: now - 40 * DAY, to: now - 33 * DAY + 17_000, bucket: 'hour' },
        ]);
        for (const filters of [{}, { person: 'alice' }, { source: 'telegram' }]) {
            expect(
                await sameTurns(e, memory, scopeOf({ from: now - 20 * DAY, to: now, bucket: 'day' }, filters)),
            ).toBeGreaterThan(filters.person || filters.source ? 0 : 3);
        }
        const status = await ask<{ state: string; earliest: number; asOf: number }>(e, 'status');
        expect(status).toMatchObject({
            state: 'ready',
            earliest: (await memory.status()).earliest,
        });
        expect(status.asOf).toBeGreaterThan(now - 60_000);
        // "Data as of", per source.
        const fresh = await ask<{ sources: { source: string }[] }>(e, 'freshness');
        expect(fresh.sources.map((source) => source.source)).toEqual([
            'agent_runs',
            'approval_audit',
            'cost',
            'data_audit',
            'data_dataset_days',
            'dimensions',
            'dot_requests',
            'issue_runs',
            'issues',
            'job_runs',
            'labels',
            'memories',
            'message_reactions',
            'page_revisions',
            'pages',
            'retention',
            'run_refs',
            'runs',
            'schedules',
            'session_labels',
            'space_writes',
            'storage',
            'taxonomy',
            'work_cycles',
        ]);
    });

    it('keeps several people and socios per chat, and the sources, unknown ones too', async () => {
        const s = scratch();
        const seeded = seed(s);
        const { e } = engine(s);
        await e.start();
        await caughtUp(e, seeded.db);
        await e.stop();
        const file = join(s.analytics, 'ops.duckdb');
        const instance = await openDuck(file, {
            memoryMb: 128,
            threads: 1,
            tempDir: join(s.analytics, 'tmp'),
        });
        const c = await instance.connect();
        cleanup.push(() => {
            c.closeSync();
            instance.closeSync();
        });
        const topic = await rows<{ kind: string; id: string }>(
            c,
            `SELECT kind, id FROM f_participant WHERE thread_id = 'tg-topic' ORDER BY kind, id`,
        );
        expect(topic.filter((p) => p.kind === 'person').map((p) => p.id)).toEqual(
            expect.arrayContaining(['alice', 'carol', 'erin', TEAM]),
        );
        expect(topic.filter((p) => p.kind === 'socio').length).toBeGreaterThanOrEqual(1);
        const [guests] = await rows<{ n: number }>(
            c,
            `SELECT count(*) AS n FROM f_participant p JOIN d_chat ch ON ch.id = p.thread_id
        WHERE p.kind = 'socio' AND p.id <> ch.socio_id`,
        );
        expect(guests!.n).toBeGreaterThan(0);
        expect(
            await rows(c, `SELECT key, kind FROM d_source WHERE key IN ('telegram', 'zapier', 'web') ORDER BY key`),
        ).toEqual([
            { key: 'telegram', kind: 'human' },
            { key: 'web', kind: 'human' },
            { key: 'zapier', kind: 'unknown' },
        ]);
        expect(await rows(c, `SELECT owner_kind FROM d_chat WHERE id = 'tg-topic'`)).toEqual([{ owner_kind: 'team' }]);
        // Facts match the rows: turns, messages, tools.
        const [counts] = await rows<{
            turns: number;
            messages: number;
            tools: number;
        }>(
            c,
            `SELECT (SELECT count(*) FROM f_turn) AS turns, (SELECT count(*) FROM f_message) AS messages,
        (SELECT sum(tool_calls) FROM f_turn) AS tools, (SELECT count(*) FROM f_tool) AS tool_rows`,
        );
        expect(counts).toMatchObject({
            turns: seeded.turns.length,
            messages: seeded.messages.length,
            tools: seeded.turns.reduce((sum, t) => sum + (t.toolCalls ?? 0), 0),
        });
    });

    it('reads big turns in batches of at most about 8 MB, a bigger one alone', async () => {
        const s = scratch();
        // 300,000 characters per answer: about 26 turns fit in a batch.
        const seeded = seed(s, { turns: 80, answerChars: 300_000 });
        const reader = sqliteSourceReader(seeded.db);
        const batch = reader.runsAfter(0, ETL_BATCH, ETL_BATCH_BYTES);
        const bytes = batch.reduce((sum, run) => sum + run.events.length + (run.trace?.length ?? 0), 0);
        expect(batch.length).toBeGreaterThan(10);
        expect(batch.length).toBeLessThan(40);
        expect(bytes).toBeLessThanOrEqual(ETL_BATCH_BYTES);
        expect(batch.map((run) => run.seq)).toEqual(batch.map((_, index) => index + 1));
        expect(reader.runsAfter(0, ETL_BATCH, 1)).toHaveLength(1);
        const { e } = engine(s);
        await e.start();
        await caughtUp(e, seeded.db);
    });
});
