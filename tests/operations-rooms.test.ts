import type { DatabaseSync } from 'node:sqlite';

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { afterEach, describe, expect, it } from 'vitest';

import { sqliteData } from '@socio/data/open';
import { runFacts } from '@socio/foundation/operations/run-facts';
import type { OpsFilters } from '@socio/shared/operations/operations';
import { analyticsDefaults } from '@socio/shared/operations/operations-analytics';
import type { RoomLimits } from '@socio/shared/rooms/rooms';
import type { TraceCycle } from '@socio/shared/runs/run-trace';
import type { AgentRunStatus } from '@socio/shared/types';

import { ETL_STEPS, ETL_VERSION } from '../src/server/operations/analytics/steps.js';
import type { OpsScope } from '../src/server/operations/domain/reader.js';
import { costStep } from '../src/server/operations/etl/cost-step.js';
import { cyclesStep } from '../src/server/operations/etl/cycles-step.js';
import { dimensionsStep } from '../src/server/operations/etl/dimensions-step.js';
import { retentionStep } from '../src/server/operations/etl/retention-step.js';
import { runsStep } from '../src/server/operations/etl/runs-step.js';
import { taxonomyStep } from '../src/server/operations/etl/taxonomy-step.js';
import type { EtlStep } from '../src/server/operations/infra/duckdb/etl.js';
import { rows } from '../src/server/operations/infra/duckdb/open.js';
import { duckOpsQueries } from '../src/server/operations/infra/duckdb/ops-queries.js';
import { createSchema } from '../src/server/operations/infra/duckdb/schema.js';
import { MemoryOpsReader, type CycleFact, type TurnFact } from '../src/server/operations/infra/memory/reader.js';
import { SqlitePricing } from '../src/server/operations/infra/sqlite/pricing.js';
import { providerOf } from '../src/server/operations/pricing/model-key.js';

import { testDatabase } from './helpers/test-database.js';

// CB-218: rooms in Operations. A room turn is credited to the person who
// started it, the person whose access it used, who paid and the room, with the
// socio that ran it; work cycles are copied apart so a cycle's handoffs and
// retries never count its spend twice; older turns stay unrecorded rather than
// guessed; and the DuckDB store and the in-memory reader answer the same.

const HOUR = 3_600_000;
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 20, 0);
const ROOM = 'room-1';
const SECRET = 'SECRET-PLAN-7731';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const LIMITS: RoomLimits = {
    cycleTimeMs: 600_000,
    cycleTokens: 2_000_000,
    messagesPerMinute: 20,
    maxQueued: 10,
    handoffsPerCycle: 4,
    cycleSpendUsd: 5,
};

/**
 * A workspace with two people in a room (Ada made it from her private
 * chat, then invited Mo) and a private chat of Carol's, two company
 * socios, a priced model, and turns from before and after work cycles.
 */
async function roomDb() {
    const db = testDatabase();
    cleanup.push(() => db.close());
    db.prepare("INSERT INTO spaces (id, name, description, createdAt) VALUES ('space-1', 'Space', '', ?)").run(
        T0 - HOUR,
    );
    for (const [id, name] of [
        ['socio-a', 'Manny'],
        ['socio-b', 'Mingo'],
    ]) {
        db.prepare(
            "INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt) VALUES (?, 'space-1', ?, '', 0, 0, ?)",
        ).run(id, name, T0 - HOUR);
    }
    for (const [id, name] of [
        ['ada', 'Ada'],
        ['mo', 'Mo'],
        ['carol', 'Carol'],
    ]) {
        db.prepare("INSERT INTO users (id, name, role, createdAt, lastSeenAt) VALUES (?, ?, 'member', ?, ?)").run(
            id,
            name,
            T0 - HOUR,
            T0,
        );
    }
    // Ada's chat became the room at T0 + 1h.
    db.prepare(
        "INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt, kind, createdBy, convertedAt) VALUES (?, 'socio-a', ?, 'Launch', ?, 'room', 'ada', ?)",
    ).run(ROOM, `room:${ROOM}`, T0 - HOUR, T0 + HOUR);
    db.prepare(
        "INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt) VALUES ('carol-chat', 'socio-a', 'carol', ?, ?)",
    ).run(`Carol’s ${SECRET}`, T0 - HOUR);

    const pricing = new SqlitePricing(sqliteData(db));
    await pricing.recordBackends(
        [
            {
                id: 'cloud',
                label: 'cloud',
                kind: 'shared',
                model: 'm-1',
                provider: providerOf('https://openrouter.ai/api/v1'),
                enabled: true,
            },
        ],
        T0 - HOUR,
    );
    await pricing.recordSynced(
        'sync:openrouter',
        [
            {
                provider: 'openrouter',
                model: 'm-1',
                modelKey: 'm1',
                prices: {
                    inputPerM: 1,
                    cachedInputPerM: null,
                    outputPerM: 2,
                    reasoningPerM: null,
                },
                effectiveFrom: T0 - HOUR,
            },
        ],
        T0 - HOUR,
    );

    let n = 0;
    const run = (options: {
        thread: string;
        at: number;
        input: number;
        output: number;
        trigger?: string;
        cycle?: TraceCycle;
        status?: AgentRunStatus;
    }) => {
        const runId = `run-${++n}`;
        db.prepare(
            "INSERT INTO agent_runs (threadId, runId, status, events, startedAt, finishedAt, source, trace) VALUES (?, ?, ?, ?, ?, ?, 'web', ?)",
        ).run(
            options.thread,
            runId,
            options.status ?? 'finished',
            // The person's words: never copied.
            JSON.stringify([
                {
                    type: 'RUN_STARTED',
                    timestamp: options.at,
                    input: {
                        messages: [{ id: `u-${runId}`, role: 'user', content: `Do the ${SECRET}` }],
                    },
                },
            ]),
            options.at,
            options.at + 20_000,
            JSON.stringify({
                turn: {
                    label: 'x',
                    model: 'm-1',
                    source: 'shared',
                    backendId: 'cloud',
                    cap: 12,
                },
                rounds: [],
                tools: [],
                waits: [],
                end: { reason: 'completed', rounds: 1, cap: 12 },
                totals: {
                    rounds: 1,
                    inputTokens: options.input,
                    outputTokens: options.output,
                },
                ...(options.trigger ? { trigger: { kind: 'person', id: options.trigger } } : {}),
                ...(options.cycle ? { cycle: options.cycle } : {}),
            }),
        );
        return runId;
    };
    const cycle = (fields: {
        id: string;
        thread: string;
        kind: 'private' | 'room';
        by: string;
        dotId: string;
        billing: 'person' | 'workspace';
        at: number;
        endedAt: number | null;
        elapsedMs: number;
        steps: number;
        handoffs: number;
        tokens: number;
        costUsd: number | null;
        endReason: string | null;
    }) =>
        db
            .prepare(
                `INSERT INTO work_cycles (id, conversationId, kind, dispatchKey, initiatorKind, initiatorId, actingUserId, dotId, billingKind, billingUserId, status, runId, hop, steps, limits, startedAt, elapsedMs, tokensUsed, costUsd, costKnown, handoffs, unstopped, endedAt, endReason, updatedAt)
        VALUES (?, ?, ?, ?, 'person', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                fields.id,
                fields.thread,
                fields.kind,
                `message-${SECRET}-${fields.id}`,
                fields.by,
                fields.by,
                fields.dotId,
                fields.billing,
                fields.billing === 'person' ? fields.by : null,
                fields.endedAt === null ? 'running' : 'ended',
                fields.handoffs,
                fields.steps,
                JSON.stringify(LIMITS),
                fields.at,
                fields.elapsedMs,
                fields.tokens,
                fields.costUsd,
                fields.costUsd === null ? 0 : 1,
                fields.handoffs,
                JSON.stringify([`tool_${SECRET}`]),
                fields.endedAt,
                fields.endReason,
                fields.endedAt ?? fields.at,
            );
    return { db, run, cycle };
}

/** The scenario: two humans, two socios, a handoff, an exhausted cycle. */
async function scenario() {
    const fixture = await roomDb();
    const { run, cycle } = fixture;
    // Before the room: Ada's private chat, a turn that recorded nothing.
    run({ thread: ROOM, at: T0 + 10 * MINUTE, input: 100, output: 10 });
    // Ada's message: Manny, then a handoff to Mingo in the same cycle. The
    // trace's cycle tokens are the cycle's so far: never added up.
    const step = (dotId: string, hop: number, tokens: number): TraceCycle => ({
        id: 'c-ada',
        kind: 'room',
        hop,
        actingUserId: 'ada',
        dotId,
        billing: 'workspace',
        tokens,
    });
    run({
        thread: ROOM,
        at: T0 + 2 * HOUR,
        input: 1000,
        output: 100,
        trigger: 'ada',
        cycle: step('socio-a', 0, 1100),
    });
    run({
        thread: ROOM,
        at: T0 + 2 * HOUR + MINUTE,
        input: 2000,
        output: 200,
        trigger: 'ada',
        cycle: step('socio-b', 1, 3300),
    });
    cycle({
        id: 'c-ada',
        thread: ROOM,
        kind: 'room',
        by: 'ada',
        dotId: 'socio-b',
        billing: 'workspace',
        at: T0 + 2 * HOUR,
        endedAt: T0 + 2 * HOUR + 10 * MINUTE,
        elapsedMs: 90_000,
        steps: 2,
        handoffs: 1,
        tokens: 3300,
        costUsd: 0.0035,
        endReason: 'completed',
    });
    // Mo's message, on Mo's own subscription, stopped at the token limit;
    // its provider didn't report spend.
    run({
        thread: ROOM,
        at: T0 + 3 * HOUR,
        input: 500,
        output: 50,
        trigger: 'mo',
        cycle: {
            id: 'c-mo',
            kind: 'room',
            hop: 0,
            actingUserId: 'mo',
            dotId: 'socio-a',
            billing: 'person',
            tokens: 550,
            stop: 'tokens',
        },
    });
    cycle({
        id: 'c-mo',
        thread: ROOM,
        kind: 'room',
        by: 'mo',
        dotId: 'socio-a',
        billing: 'person',
        at: T0 + 3 * HOUR,
        endedAt: T0 + 3 * HOUR + 2 * MINUTE,
        elapsedMs: 60_000,
        steps: 1,
        handoffs: 0,
        tokens: 550,
        costUsd: null,
        endReason: 'tokens',
    });
    // A turn in the room that recorded nothing (a damaged trace): a person's,
    // none known, never the room's sentinel.
    run({ thread: ROOM, at: T0 + 5 * HOUR, input: 10, output: 1 });
    // Carol's private chat, on her subscription.
    run({
        thread: 'carol-chat',
        at: T0 + 4 * HOUR,
        input: 300,
        output: 30,
        trigger: 'carol',
        cycle: {
            id: 'c-carol',
            kind: 'private',
            hop: 0,
            actingUserId: 'carol',
            dotId: 'socio-a',
            billing: 'person',
            tokens: 330,
        },
    });
    cycle({
        id: 'c-carol',
        thread: 'carol-chat',
        kind: 'private',
        by: 'carol',
        dotId: 'socio-a',
        billing: 'person',
        at: T0 + 4 * HOUR,
        endedAt: T0 + 4 * HOUR + MINUTE,
        elapsedMs: 30_000,
        steps: 1,
        handoffs: 0,
        tokens: 330,
        costUsd: 0.0004,
        endReason: 'completed',
    });
    return fixture;
}

async function duck() {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    cleanup.push(() => {
        connection.closeSync();
        instance.closeSync();
    });
    await createSchema(connection, ETL_STEPS, 'test');
    return connection;
}

const STEPS = [runsStep, taxonomyStep, costStep, cyclesStep, dimensionsStep];

/** Runs these steps, each to its end, as the engine does. */
async function etl(
    db: DatabaseSync,
    connection: DuckDBConnection,
    now: number,
    steps: readonly EtlStep[] = STEPS,
    factDays = 0,
) {
    const context = {
        settings: { ...analyticsDefaults({}), factDays },
        timeZone: 'UTC',
        now,
    };
    for (const step of steps) {
        for (;;) {
            const [state] = await rows<{ watermark: string | null }>(
                connection,
                'SELECT watermark FROM etl_state WHERE source = $1',
                [step.source],
            );
            const batch = await step.batch({
                sqlite: db,
                duck: connection,
                watermark: state?.watermark ?? null,
                rebuilding: false,
                context,
            });
            await connection.run(
                `INSERT INTO etl_state VALUES ($1, $2, $3) ON CONFLICT (source) DO UPDATE SET watermark = excluded.watermark, "at" = excluded."at"`,
                [step.source, batch.watermark ?? state?.watermark ?? null, BigInt(now)],
            );
            if (batch.caughtUp) {
                break;
            }
        }
    }
}

const scope = (filters: OpsFilters = {}): OpsScope => ({
    window: {
        from: T0,
        to: T0 + 24 * HOUR,
        bucket: 'hour',
        buckets: ['hour'],
        previous: null,
        timeZone: 'UTC',
    },
    filters,
});

const plain = (value: unknown) =>
    JSON.parse(JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? Number(v) : v))) as unknown;

/**
 * The memory reader over the facts the store holds: the same rows, so its
 * answers must be the store's.
 */
async function memoryOf(connection: DuckDBConnection) {
    const turns = await rows<Record<string, unknown>>(
        connection,
        'SELECT t.*, s.space_id FROM f_turn t LEFT JOIN d_socio s ON s.id = t.socio_id',
    );
    const cycles = await rows<Record<string, unknown>>(connection, 'SELECT * FROM f_cycle');
    const people = await rows<{ id: string; name: string }>(connection, 'SELECT id, name FROM d_person');
    const socios = await rows<{ id: string; name: string; space_id: string }>(
        connection,
        'SELECT id, name, space_id FROM d_socio',
    );
    const chats = await rows<{
        id: string;
        socio_id: string;
        owner_kind: 'person' | 'team' | 'room';
        title: string | null;
    }>(connection, 'SELECT id, socio_id, owner_kind, title FROM d_chat');
    const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
    return new MemoryOpsReader({
        turns: turns.map((row): TurnFact => ({
            runId: row.run_id as string,
            threadId: row.thread_id as string,
            socioId: row.socio_id as string,
            socioName: socios.find((socio) => socio.id === row.socio_id)?.name ?? null,
            spaceId: (row.space_id as string | null) ?? null,
            personId: row.trigger_kind === 'person' ? ((row.trigger_id as string | null) ?? null) : null,
            triggerKind: row.trigger_kind as string,
            triggerId: row.trigger_id as string | null,
            source: row.source as string,
            status: row.status as AgentRunStatus,
            startedAt: Number(row.started_at),
            finishedAt: num(row.finished_at),
            inputTokens: num(row.input_tokens) ?? undefined,
            outputTokens: num(row.output_tokens) ?? undefined,
            model: row.model as string | null,
            backendKey: row.backend_key as string | null,
            costBackend: row.cost_backend as string | null,
            costUsd: num(row.cost_usd),
            costBasis: row.cost_basis as TurnFact['costBasis'],
            refCostUsd: num(row.ref_cost_usd),
            containerKind: row.container_kind as TurnFact['containerKind'],
            cycleId: row.cycle_id as string | null,
            hop: num(row.hop),
            actingId: row.acting_id as string | null,
            payerKind: row.payer_kind as TurnFact['payerKind'],
            payerId: row.payer_id as string | null,
        })),
        cycles: cycles.map((row): CycleFact => ({
            id: row.id as string,
            threadId: row.thread_id as string,
            kind: row.kind as CycleFact['kind'],
            startedAt: Number(row.started_at),
            endedAt: num(row.ended_at),
            elapsedMs: Number(row.elapsed_ms),
            costKnown: row.cost_known as boolean,
            endReason: row.end_reason as string | null,
        })),
        people,
        socios: socios.map((socio) => ({
            id: socio.id,
            name: socio.name,
            spaceId: socio.space_id,
        })),
        chats: chats.map((chat) => ({
            id: chat.id,
            socioId: chat.socio_id,
            ownerKind: chat.owner_kind,
            title: chat.title,
        })),
    });
}

it('bumps ETL_VERSION for the new facts, so the store is rebuilt', () => {
    expect(ETL_VERSION).toBe(9);
    expect(ETL_STEPS).toContain(cyclesStep);
});

describe('room turns in the facts', () => {
    it('credits the initiator, the acting person, the payer, the room and the socio that ran it', async () => {
        const { db } = await scenario();
        const connection = await duck();
        await etl(db, connection, T0 + 6 * HOUR);
        const turns = (await rows<Record<string, unknown>>(
            connection,
            `SELECT seq, thread_id, socio_id, trigger_kind, trigger_id, attribution,
        container_kind, cycle_id, hop, acting_id, payer_kind, payer_id, cost_basis
      FROM f_turn ORDER BY seq`,
        )) as Record<string, unknown>[];
        expect(plain(turns)).toEqual([
            // Before the conversion: Ada's private chat, credited to its one
            // owner by the fallback, which says so (`owner`); acting and payer
            // unknown, never filled in.
            {
                seq: 1,
                thread_id: ROOM,
                socio_id: 'socio-a',
                trigger_kind: 'person',
                trigger_id: 'ada',
                attribution: 'owner',
                container_kind: 'person',
                cycle_id: null,
                hop: null,
                acting_id: null,
                payer_kind: null,
                payer_id: null,
                cost_basis: 'price',
            },
            {
                seq: 2,
                thread_id: ROOM,
                socio_id: 'socio-a',
                trigger_kind: 'person',
                trigger_id: 'ada',
                attribution: 'exact',
                container_kind: 'room',
                cycle_id: 'c-ada',
                hop: 0,
                acting_id: 'ada',
                payer_kind: 'workspace',
                payer_id: null,
                cost_basis: 'price',
            },
            // The handoff: the socio that ran it, Mingo, not the room's lead.
            {
                seq: 3,
                thread_id: ROOM,
                socio_id: 'socio-b',
                trigger_kind: 'person',
                trigger_id: 'ada',
                attribution: 'exact',
                container_kind: 'room',
                cycle_id: 'c-ada',
                hop: 1,
                acting_id: 'ada',
                payer_kind: 'workspace',
                payer_id: null,
                cost_basis: 'price',
            },
            {
                seq: 4,
                thread_id: ROOM,
                socio_id: 'socio-a',
                trigger_kind: 'person',
                trigger_id: 'mo',
                attribution: 'exact',
                container_kind: 'room',
                cycle_id: 'c-mo',
                hop: 0,
                acting_id: 'mo',
                payer_kind: 'person',
                payer_id: 'mo',
                cost_basis: 'price',
            },
            // A room turn that recorded nothing: a person's, none known.
            {
                seq: 5,
                thread_id: ROOM,
                socio_id: 'socio-a',
                trigger_kind: 'person',
                trigger_id: null,
                attribution: 'owner',
                container_kind: 'room',
                cycle_id: null,
                hop: null,
                acting_id: null,
                payer_kind: null,
                payer_id: null,
                cost_basis: 'price',
            },
            {
                seq: 6,
                thread_id: 'carol-chat',
                socio_id: 'socio-a',
                trigger_kind: 'person',
                trigger_id: 'carol',
                attribution: 'exact',
                container_kind: 'person',
                cycle_id: 'c-carol',
                hop: 0,
                acting_id: 'carol',
                payer_kind: 'person',
                payer_id: 'carol',
                cost_basis: 'price',
            },
        ]);

        // Two people and two socios keep a row each; no turn counts twice.
        expect(
            plain(
                await rows(
                    connection,
                    `SELECT kind, id, messages, turns, acting, paid FROM f_participant
          WHERE thread_id = $1 ORDER BY kind, id`,
                    [ROOM],
                ),
            ),
        ).toEqual([
            { kind: 'person', id: 'ada', messages: 3, turns: 3, acting: 2, paid: 0 },
            { kind: 'person', id: 'mo', messages: 1, turns: 1, acting: 1, paid: 1 },
            {
                kind: 'socio',
                id: 'socio-a',
                messages: 0,
                turns: 4,
                acting: 0,
                paid: 0,
            },
            {
                kind: 'socio',
                id: 'socio-b',
                messages: 0,
                turns: 1,
                acting: 0,
                paid: 0,
            },
        ]);

        // The room is its own owner, named; a private chat's title isn't copied.
        expect(plain(await rows(connection, 'SELECT id, owner_id, owner_kind, title FROM d_chat ORDER BY id'))).toEqual(
            [
                {
                    id: 'carol-chat',
                    owner_id: 'carol',
                    owner_kind: 'person',
                    title: null,
                },
                {
                    id: ROOM,
                    owner_id: `room:${ROOM}`,
                    owner_kind: 'room',
                    title: 'Launch',
                },
            ],
        );
        // `room:<id>` is never a person anywhere.
        expect(
            await rows(
                connection,
                `SELECT 'turn' FROM f_turn WHERE trigger_id LIKE 'room:%' OR acting_id LIKE 'room:%' OR payer_id LIKE 'room:%'
        UNION ALL SELECT 'participant' FROM f_participant WHERE id LIKE 'room:%'`,
            ),
        ).toEqual([]);

        // The cycles, as their ledger counted them: unknown spend stays null.
        expect(
            plain(
                await rows(
                    connection,
                    `SELECT id, kind, initiator_id, acting_id, socio_id, payer_kind, payer_id,
            elapsed_ms, steps, handoffs, tokens_used, cost_usd, cost_known,
            token_limit, spend_limit, end_reason
          FROM f_cycle ORDER BY id`,
                ),
            ),
        ).toEqual([
            {
                id: 'c-ada',
                kind: 'room',
                initiator_id: 'ada',
                acting_id: 'ada',
                socio_id: 'socio-b',
                payer_kind: 'workspace',
                payer_id: null,
                elapsed_ms: 90_000,
                steps: 2,
                handoffs: 1,
                tokens_used: 3300,
                cost_usd: 0.0035,
                cost_known: true,
                token_limit: 2_000_000,
                spend_limit: 5,
                end_reason: 'completed',
            },
            {
                id: 'c-carol',
                kind: 'private',
                initiator_id: 'carol',
                acting_id: 'carol',
                socio_id: 'socio-a',
                payer_kind: 'person',
                payer_id: 'carol',
                elapsed_ms: 30_000,
                steps: 1,
                handoffs: 0,
                tokens_used: 330,
                cost_usd: 0.0004,
                cost_known: true,
                token_limit: 2_000_000,
                spend_limit: 5,
                end_reason: 'completed',
            },
            {
                id: 'c-mo',
                kind: 'room',
                initiator_id: 'mo',
                acting_id: 'mo',
                socio_id: 'socio-a',
                payer_kind: 'person',
                payer_id: 'mo',
                elapsed_ms: 60_000,
                steps: 1,
                handoffs: 0,
                tokens_used: 550,
                cost_usd: null,
                cost_known: false,
                token_limit: 2_000_000,
                spend_limit: 5,
                end_reason: 'tokens',
            },
        ]);
    });

    it('keeps no message, title of a private chat, dispatch key or tool name', async () => {
        const { db } = await scenario();
        const connection = await duck();
        await etl(db, connection, T0 + 6 * HOUR);
        const tables = await rows<{ table_name: string }>(
            connection,
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'",
        );
        for (const { table_name } of tables) {
            const all = JSON.stringify(plain(await rows(connection, `SELECT * FROM ${table_name}`)));
            expect(all, table_name).not.toContain(SECRET);
        }
    });

    it('reads a cycle again until it ends, prunes it with the facts, and repeats nothing', async () => {
        const { db, run, cycle } = await roomDb();
        run({
            thread: ROOM,
            at: T0 + 2 * HOUR,
            input: 10,
            output: 1,
            trigger: 'ada',
            cycle: {
                id: 'c-1',
                kind: 'room',
                hop: 0,
                actingUserId: 'ada',
                dotId: 'socio-a',
            },
        });
        cycle({
            id: 'c-1',
            thread: ROOM,
            kind: 'room',
            by: 'ada',
            dotId: 'socio-a',
            billing: 'workspace',
            at: T0 + 2 * HOUR,
            endedAt: null,
            elapsedMs: 1000,
            steps: 1,
            handoffs: 0,
            tokens: 11,
            costUsd: 0,
            endReason: null,
        });
        const connection = await duck();
        await etl(db, connection, T0 + 3 * HOUR, [cyclesStep]);
        expect(plain(await rows(connection, 'SELECT status, end_reason FROM f_cycle'))).toEqual([
            { status: 'running', end_reason: null },
        ]);
        db.prepare(
            "UPDATE work_cycles SET status = 'ended', endedAt = ?, endReason = 'deadline', elapsedMs = 600000 WHERE id = 'c-1'",
        ).run(T0 + 3 * HOUR);
        await etl(db, connection, T0 + 4 * HOUR, [cyclesStep]);
        await etl(db, connection, T0 + 4 * HOUR, [cyclesStep]);
        expect(plain(await rows(connection, 'SELECT status, end_reason, elapsed_ms FROM f_cycle'))).toEqual([
            { status: 'ended', end_reason: 'deadline', elapsed_ms: 600000 },
        ]);
        // Retention takes cycles with the turns they began with.
        await etl(db, connection, T0 + 40 * 86_400_000, [retentionStep], 30);
        expect(await rows(connection, 'SELECT id FROM f_cycle')).toEqual([]);
    });
});

describe('cost and use by room', () => {
    it('counts each room’s cycles once, its handoffs and limits hit, and who paid', async () => {
        const { db } = await scenario();
        const connection = await duck();
        await etl(db, connection, T0 + 6 * HOUR);
        const cost = (await duckOpsQueries(connection).cost(scope()))!;
        const price = (input: number, output: number) => (input * 1 + output * 2) / 1e6;
        // The room's own turns only: not the private chat's before it became one.
        expect(cost.byRoom).toHaveLength(1);
        const [room] = cost.byRoom;
        expect(room).toMatchObject({
            key: ROOM,
            name: 'Launch',
            turns: 4,
            // Each turn's own tokens, never the cycle's running total.
            tokens: 1100 + 2200 + 550 + 11,
            unpriced: 0,
            cycles: 2,
            handoffs: 1,
            exhausted: 1,
            people: 2,
            socios: 2,
        });
        expect(room!.costUsd).toBeCloseTo(price(1000, 100) + price(2000, 200) + price(500, 50) + price(10, 1), 12);
        expect(cost.byPayer.map(({ key, name, turns }) => ({ key, name, turns }))).toEqual([
            { key: 'workspace', name: null, turns: 2 },
            { key: 'mo', name: 'Mo', turns: 1 },
            { key: 'carol', name: 'Carol', turns: 1 },
            // Before work cycles: not recorded, not guessed.
            { key: '', name: null, turns: 2 },
        ]);
        expect(cost.cycles).toEqual({
            cycles: 3,
            inRooms: 2,
            steps: 4,
            handoffs: 1,
            exhausted: { deadline: 0, tokens: 1, handoffs: 0, spend: 0 },
            stopped: 0,
            spendUnknown: 1,
            runningMs: 90_000 + 60_000 + 30_000,
            wallMs: 10 * MINUTE + 2 * MINUTE + MINUTE,
        });
        // Per socio: each step to the socio that ran it.
        expect(cost.bySocio.map(({ key, turns }) => ({ key, turns }))).toEqual([
            { key: 'socio-b', turns: 1 },
            { key: 'socio-a', turns: 5 },
        ]);
    });

    it('answers the same from memory, for every filter', async () => {
        const { db } = await scenario();
        const connection = await duck();
        await etl(db, connection, T0 + 6 * HOUR);
        const store = duckOpsQueries(connection);
        const memory = await memoryOf(connection);
        for (const filters of [
            {},
            { person: 'mo' },
            { person: 'ada' },
            { socio: 'socio-b' },
            { space: 'space-1' },
            { source: 'web' },
        ] satisfies OpsFilters[]) {
            const fromStore = (await store.cost(scope(filters)))!;
            const fromMemory = (await memory.cost(scope(filters)))!;
            for (const key of ['byRoom', 'byPayer', 'cycles', 'totals'] as const) {
                expect(plain(fromMemory[key]), `${key} ${JSON.stringify(filters)}`).toEqual(plain(fromStore[key]));
            }
        }
    });
});

describe('run facts without the store', () => {
    it('reads a cycle’s context from the trace and refuses a malformed one', () => {
        const base = {
            seq: 1,
            runId: 'r',
            threadId: ROOM,
            status: 'finished',
            source: 'web',
            startedAt: T0,
            finishedAt: T0 + 1,
            events: '[]',
            socioId: 'socio-a',
            ownerId: `room:${ROOM}`,
            chatKind: 'room',
        };
        const facts = runFacts({
            ...base,
            trace: JSON.stringify({
                trigger: { kind: 'person', id: 'mo' },
                cycle: {
                    id: 'c',
                    kind: 'room',
                    hop: 2,
                    actingUserId: 'mo',
                    dotId: 'socio-b',
                    billing: 'person',
                },
            }),
        });
        expect(facts.turn).toMatchObject({
            socioId: 'socio-b',
            containerKind: 'room',
            cycleId: 'c',
            hop: 2,
            actingId: 'mo',
            payerKind: 'person',
            payerId: 'mo',
        });
        // A cycle without an acting person isn't one: nothing is guessed.
        expect(
            runFacts({
                ...base,
                trace: JSON.stringify({ cycle: { id: 'c', kind: 'room', dotId: 'x' } }),
            }).turn,
        ).toMatchObject({
            socioId: 'socio-a',
            containerKind: 'room',
            cycleId: null,
            actingId: null,
            payerKind: null,
            triggerId: null,
        });
        // A Telegram topic a room became: its earlier turns were the team's.
        expect(
            runFacts({
                ...base,
                trace: null,
                convertedAt: T0 + 10,
                createdBy: 'ada',
                fromTopic: 1,
            }).turn,
        ).toMatchObject({ containerKind: 'team', triggerId: null });
    });
});
