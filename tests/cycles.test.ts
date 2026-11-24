import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getTableName } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { estimateRequestTokens, reportedCost } from '@socio/foundation/cycles/estimates';
import { ROOM_LIMIT_DEFAULTS, type RoomLimits, type RoomMember } from '@socio/shared/rooms/rooms';
import type { RunTrace } from '@socio/shared/runs/run-trace';

import { cycleLimitsFromEnv } from '../src/server/composition/config.js';
import { CycleLimitError, type CycleConversation, type CycleRequest } from '../src/server/cycles/contract.js';
import { cycleTables } from '../src/server/cycles/infra/sqlite/schema.js';
import type { WorkCycles } from '../src/server/cycles/service.js';
import { sqliteCycles } from '../src/server/cycles/services.js';
import { cycleLimits } from '../src/server/settings/limits.js';

import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase, testDatabaseFile } from './helpers/test-database.js';

// Work cycles (CB-211): each message's work
// is bounded by its time, tokens, rate, handoffs and (known) spend, from
// limits a room admin may only lower, and survives a restart.

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0).reverse()) {
        fn();
    }
});

const LIMITS: RoomLimits = {
    cycleTimeMs: 300_000,
    cycleTokens: 400_000,
    messagesPerMinute: 20,
    maxQueued: 5,
    handoffsPerCycle: 4,
    cycleSpendUsd: null,
};

/** A finished run's trace, as the runner closes it. */
const trace = (reason: NonNullable<RunTrace['end']>['reason']): RunTrace => ({
    rounds: [],
    tools: [],
    waits: [],
    end: { reason, rounds: 1, cap: 30 },
});

function fixture(
    options: {
        path?: string;
        limits?: Partial<RoomLimits>;
        conversations?: Record<string, CycleConversation>;
    } = {},
) {
    const workspace = new WorkspaceStore(options.path ?? testDatabase());
    cleanup.push(() => workspace.close());
    let now = 1_000_000;
    const conversations: Record<string, CycleConversation> = {
        chat: { id: 'chat', dotId: 'dot', ownerId: 'alice' },
        topic: { id: 'topic', dotId: 'dot', ownerId: 'telegram-team:-100' },
        ...options.conversations,
    };
    const limits = { ...LIMITS, ...options.limits };
    const cycles = sqliteCycles(workspace.db, {
        conversation: (id) => conversations[id],
        socio: (id) => (id === 'mine' ? { id, ownerId: 'alice' } : { id }),
        limits: () => limits,
        now: () => now,
    });
    const begin = async (request: Partial<CycleRequest> = {}) => {
        const admission = await cycles.begin({
            conversationId: 'chat',
            runId: `run-${now}`,
            dotId: 'dot',
            trigger: { kind: 'person', id: 'alice' },
            ...request,
        });
        return admission;
    };
    const step = async (request: Partial<CycleRequest> = {}) => {
        const admission = await begin(request);
        if (!admission.ok || !admission.step) {
            throw new Error(`refused: ${JSON.stringify(admission)}`);
        }
        return admission.step;
    };
    return {
        workspace,
        cycles,
        conversations,
        limits,
        begin,
        step,
        advance: (ms: number) => (now += ms),
        now: () => now,
    };
}

/** persist() writes behind the work ahead: a write queued after it waits. */
const settleAll = (cycles: WorkCycles) => cycles.tick();

it('mirrors its migrated tables exactly', () => {
    const db = new WorkspaceStore(testDatabase());
    cleanup.push(() => db.close());
    expect(schemaDrift(db.db, cycleTables)).toEqual([]);
    expect(cycleTables.map((table) => getTableName(table)).sort()).toEqual(['work_cycle_submissions', 'work_cycles']);
});

it('starts from the owner-settled defaults, under what an admin saved', () => {
    const store = new Store(testDatabase());
    cleanup.push(() => store.close());
    const config = {
        baseUrl: '',
        apiKey: '',
        model: '',
        voiceName: '',
        runtimeUrl: '',
    };
    expect(cycleLimits(store.settings(), config)).toEqual({
        cycleTimeMs: 300_000,
        cycleTokens: ROOM_LIMIT_DEFAULTS.cycleTokens,
        messagesPerMinute: 20,
        maxQueued: 5,
        handoffsPerCycle: 4,
        // No spend cap by default.
        cycleSpendUsd: null,
    });
    expect(
        cycleLimits(
            {
                ...store.settings(),
                limits: {
                    roomCycleTokens: 50_000,
                    roomMessagesPerMinute: 3,
                    roomCycleSpendUsd: 1.25,
                    turnTimeLimitSeconds: 60,
                    steeringMaxQueued: 2,
                },
            },
            { ...config, roomHandoffsPerCycle: 1 },
        ),
    ).toEqual({
        cycleTimeMs: 60_000,
        cycleTokens: 50_000,
        messagesPerMinute: 3,
        maxQueued: 2,
        handoffsPerCycle: 1,
        cycleSpendUsd: 1.25,
    });
});

it('reads the limits’ starting values from the environment, in range', () => {
    expect(cycleLimitsFromEnv({})).toEqual({});
    expect(
        cycleLimitsFromEnv({
            ROOM_CYCLE_TOKENS: ' 250000 ',
            ROOM_MESSAGES_PER_MINUTE: '6',
            ROOM_HANDOFFS_PER_CYCLE: '0',
            ROOM_CYCLE_SPEND_USD: '2.50',
        }),
    ).toEqual({
        roomCycleTokens: 250_000,
        roomMessagesPerMinute: 6,
        roomHandoffsPerCycle: 0,
        roomCycleSpendUsd: 2.5,
    });
    expect(() => cycleLimitsFromEnv({ ROOM_CYCLE_TOKENS: '10' })).toThrow(
        'ROOM_CYCLE_TOKENS must be a whole number from 10000 to 20000000.',
    );
    expect(() => cycleLimitsFromEnv({ ROOM_CYCLE_SPEND_USD: '0.001' })).toThrow(
        'ROOM_CYCLE_SPEND_USD must be an amount in dollars and cents',
    );
});

it('lets a room admin only lower the workspace’s limits', async () => {
    const room: CycleConversation = {
        id: 'room',
        dotId: 'dot',
        ownerId: 'room:room',
        kind: 'room',
    };
    const f = fixture({
        conversations: { room },
        limits: { cycleSpendUsd: 2 },
    });
    // A change that raises any limit is refused, field by field.
    expect(f.cycles.checkRoomLimits({ cycleTokens: 500_000, messagesPerMinute: 5 })).toEqual({
        ok: false,
        raised: ['cycleTokens'],
    });
    expect(f.cycles.checkRoomLimits({ cycleSpendUsd: 3 })).toEqual({
        ok: false,
        raised: ['cycleSpendUsd'],
    });
    expect(f.cycles.checkRoomLimits({ cycleSpendUsd: null })).toEqual({
        ok: false,
        raised: ['cycleSpendUsd'],
    });
    expect(f.cycles.checkRoomLimits({ cycleTokens: 100_000, cycleSpendUsd: 1 })).toEqual({ ok: true });
    // What a room saved earlier, above what the workspace allows now (an
    // admin lowered it since), never raises the room's cycles.
    let saved: Partial<RoomLimits> = {
        cycleTokens: 900_000,
        messagesPerMinute: 5,
        maxQueued: 2,
        cycleSpendUsd: 5,
    };
    f.cycles.rooms = { limits: async () => saved };
    expect(await f.cycles.limitsFor('room')).toEqual({
        ...f.limits,
        messagesPerMinute: 5,
        maxQueued: 2,
        cycleSpendUsd: 2,
    });
    saved = { cycleTimeMs: 1, handoffsPerCycle: 0 };
    expect(await f.cycles.limitsFor('room')).toEqual({
        ...f.limits,
        cycleTimeMs: 1,
    });
    // A private chat never reads a room's.
    expect(await f.cycles.limitsFor('chat')).toEqual(f.limits);
});

it('reserves tokens before each request and stops the cycle at its limit', async () => {
    const f = fixture({ limits: { cycleTokens: 20_000 } });
    const step = await f.step({ dispatchKey: 'm1' });
    expect(step.context).toMatchObject({
        conversationId: 'chat',
        kind: 'private',
        initiator: { kind: 'person', id: 'alice' },
        actingUserId: 'alice',
        hop: 0,
    });
    const first = step.reserve(8_000);
    // While it is in flight, a second can't take what it reserved.
    expect(() => step.reserve(13_000)).toThrow(CycleLimitError);
    expect(step.stop).toBe('tokens');
    first.settle({ tokens: 6_000, output: true });
    // Reconciled once: a second settle (a retry's bookkeeping) adds nothing.
    first.settle({ tokens: 6_000, output: true });
    expect(step.tokensUsed).toBe(6_000);
    expect(step.tokensReserved).toBe(0);
    const end = await f.cycles.end(step, {
        status: 'failed',
        trace: trace('cycle_limit'),
    });
    expect(end).toMatchObject({ stop: 'tokens', tokens: 6_000 });
    const stored = await f.cycles.cycle(step.id);
    expect(stored).toMatchObject({
        status: 'ended',
        endReason: 'tokens',
        tokensUsed: 6_000,
        tokensReserved: 0,
    });
    // The same message never runs again from nothing.
    expect(await f.begin({ dispatchKey: 'm1' })).toEqual({
        ok: false,
        failure: 'cycle_ended',
    });
});

it('counts a cancelled request only for the output it produced', async () => {
    const f = fixture();
    const step = await f.step();
    // Refused before any output (a busy model, a stop): nothing used.
    step.reserve(5_000).settle({ output: false });
    expect(step.tokensUsed).toBe(0);
    // Cut off after output, with no usage reported: its estimate counts.
    step.reserve(5_000).settle({ output: true });
    expect(step.tokensUsed).toBe(5_000);
    // Reported usage replaces the estimate.
    step.reserve(5_000).settle({ tokens: 1_200, output: true });
    expect(step.tokensUsed).toBe(6_200);
});

it('applies a spend cap only while every request reported its cost', async () => {
    const f = fixture({ limits: { cycleSpendUsd: 0.05 } });
    const known = await f.step();
    known.reserve(1_000).settle({ tokens: 900, costUsd: 0.03, output: true });
    known.reserve(1_000).settle({ tokens: 900, costUsd: 0.03, output: true });
    expect(known.costUsd).toBeCloseTo(0.06);
    expect(() => known.reserve(1_000)).toThrow(CycleLimitError);
    expect(known.stop).toBe('spend');
    expect(
        await f.cycles.end(known, {
            status: 'failed',
            trace: trace('cycle_limit'),
        }),
    ).toMatchObject({ stop: 'spend', costUsd: expect.closeTo(0.06) });

    // One request without a cost: spend is unknown, never claimed, and the
    // cap can't stop it; tokens and time still bound the cycle.
    f.advance(1);
    const unknown = await f.step();
    unknown.reserve(1_000).settle({ tokens: 900, costUsd: 0.04, output: true });
    unknown.reserve(1_000).settle({ tokens: 900, output: true });
    expect(unknown.costKnown).toBe(false);
    expect(unknown.costUsd).toBeNull();
    unknown.reserve(1_000).settle({ tokens: 900, costUsd: 0.04, output: true });
    expect(unknown.costUsd).toBeNull();
    expect(() => unknown.reserve(1_000)).not.toThrow();
    const end = await f.cycles.end(unknown, {
        status: 'finished',
        trace: trace('completed'),
    });
    expect(end.costUsd).toBeUndefined();
    expect(await f.cycles.cycle(unknown.id)).toMatchObject({
        costUsd: null,
        costKnown: false,
        endReason: 'completed',
    });
    const tokensOnly = fixture({ limits: { cycleTokens: 10_000 } });
    const bounded = await tokensOnly.step();
    bounded.reserve(5_000).settle({ tokens: 9_000, output: true });
    expect(() => bounded.reserve(2_000)).toThrow(CycleLimitError);
    expect(bounded.stop).toBe('tokens');
});

it('limits a conversation’s messages a minute, concurrent ones included', async () => {
    const f = fixture({ limits: { messagesPerMinute: 20 } });
    const results = await Promise.all(Array.from({ length: 25 }, () => f.cycles.submit('chat', 'alice')));
    expect(results.filter(Boolean)).toHaveLength(20);
    expect(await f.cycles.withinRate('chat')).toBe(false);
    expect(await f.begin({ personMessage: true, dispatchKey: 'm21' })).toEqual({
        ok: false,
        failure: 'cycle_rate',
    });
    // Another conversation has its own minute.
    expect(await f.cycles.withinRate('topic')).toBe(true);
    // Server requests (a schedule, an approval's note) and claimed queued
    // messages are not new messages.
    const server = await f.step({ trigger: { kind: 'schedule', id: 't1' } });
    await f.cycles.end(server, { status: 'finished', trace: trace('completed') });
    const queued = await f.step({ personMessage: true, queued: true });
    await f.cycles.end(queued, { status: 'finished', trace: trace('completed') });
    // A minute later there is room again.
    f.advance(60_001);
    expect(await f.cycles.withinRate('chat')).toBe(true);
    expect((await f.begin({ personMessage: true })).ok).toBe(true);
});

it('holds one running cycle per conversation, and the next step waits for its end', async () => {
    const f = fixture();
    const first = await f.step({ dispatchKey: 'a' });
    first.reserve(2_000);
    await settleAll(f.cycles);
    // A run the runner gave up on (its end never stored) leaves a stale
    // lease: the next step reconciles it, counted, as a restart would.
    f.advance(500);
    const second = await f.step({ dispatchKey: 'b' });
    expect((await f.cycles.running('chat'))?.id).toBe(second.id);
    expect(await f.cycles.cycle(first.id)).toMatchObject({
        status: 'waiting',
        tokensUsed: 2_000,
        tokensReserved: 0,
    });
    expect(() =>
        f.workspace.db.prepare("UPDATE work_cycles SET status = 'running' WHERE id = ?").run(first.id),
    ).toThrow(/UNIQUE/);
});

it('carries a waiting cycle on with what it used: waiting never resets its time', async () => {
    const f = fixture({ limits: { cycleTimeMs: 60_000 } });
    const step = await f.step({ dispatchKey: 'm1' });
    expect(step.remainingMs()).toBe(60_000);
    f.advance(20_000);
    step.reserve(1_000).settle({ tokens: 3_000, output: true });
    // The step waits for an approval: the cycle waits, its time kept.
    await f.cycles.end(step, { status: 'finished', trace: trace('interrupted') });
    expect(await f.cycles.cycle(step.id)).toMatchObject({
        status: 'waiting',
        elapsedMs: 20_000,
        endReason: null,
    });
    // An hour's wait for the decision counts for nothing.
    f.advance(3_600_000);
    const next = await f.step({ cycleId: step.id });
    expect(next.id).toBe(step.id);
    expect(next.remainingMs()).toBe(40_000);
    expect(next.tokensUsed).toBe(3_000);
    f.advance(40_000);
    // Out of time: the step's next request is refused, as a deadline.
    expect(() => next.reserve(10)).toThrow(CycleLimitError);
    expect(next.stop).toBe('deadline');
    await f.cycles.end(next, { status: 'failed', trace: trace('time_limit') });
    expect(await f.cycles.cycle(step.id)).toMatchObject({
        status: 'ended',
        endReason: 'deadline',
        steps: 2,
    });
    // An ended cycle takes no more work, from any path.
    expect(await f.begin({ cycleId: step.id })).toEqual({
        ok: false,
        failure: 'cycle_ended',
    });
    expect(await f.begin({ cycleId: 'nope' })).toEqual({
        ok: false,
        failure: 'cycle_ended',
    });
});

it('refuses a step of a cycle out of time before it runs', async () => {
    const f = fixture({ limits: { cycleTimeMs: 30_000 } });
    const step = await f.step();
    f.advance(30_000);
    await f.cycles.end(step, { status: 'finished', trace: trace('interrupted') });
    expect(await f.begin({ cycleId: step.id })).toEqual({
        ok: false,
        failure: 'time_limit',
    });
    expect(await f.cycles.cycle(step.id)).toMatchObject({
        status: 'ended',
        endReason: 'deadline',
    });
});

it('survives a restart: what ran is reconciled, and the same dispatch carries it on once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cycles-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = testDatabaseFile(join(dir, 'app.db'));
    const before = fixture({ path });
    const step = await before.step({ dispatchKey: 'm1' });
    step.reserve(1_000).settle({ tokens: 2_500, output: true });
    // In flight when the process dies: never reported back.
    step.reserve(4_000);
    before.advance(10_000);
    await settleAll(before.cycles);
    // The process dies: no end is stored.
    before.workspace.close();
    cleanup.splice(0);

    const after = fixture({ path });
    // A step a live runtime still runs (a start-first deploy's previous
    // task, CB-108) is left to that runtime.
    const { runId } = (await after.cycles.cycle(step.id))!;
    expect(runId).toBeTruthy();
    expect(await after.cycles.recover((id) => id === runId)).toBe(0);
    expect(await after.cycles.cycle(step.id)).toMatchObject({
        status: 'running',
        tokensReserved: 4_000,
    });
    expect(await after.cycles.recover()).toBe(1);
    const parked = await after.cycles.cycle(step.id);
    expect(parked).toMatchObject({
        status: 'waiting',
        runId: null,
        // The request in flight counts as used: never under-counted.
        tokensUsed: 6_500,
        tokensReserved: 0,
    });
    // A second start finds nothing left running.
    expect(await after.cycles.recover()).toBe(0);
    // The same message dispatched again carries the cycle on, never as new.
    const again = await after.step({ dispatchKey: 'm1' });
    expect(again.id).toBe(step.id);
    expect(again.tokensUsed).toBe(6_500);
    await after.cycles.end(again, {
        status: 'finished',
        trace: trace('completed'),
    });
    expect(await after.cycles.cycle(step.id)).toMatchObject({
        status: 'ended',
        endReason: 'completed',
        steps: 2,
    });
    // Once it ended, the same dispatch is refused: it can't run twice.
    expect(await after.begin({ dispatchKey: 'm1' })).toEqual({
        ok: false,
        failure: 'cycle_ended',
    });
});

it('carries a message whose step failed before it was stored on, in the same cycle', async () => {
    const f = fixture();
    const step = await f.step({ dispatchKey: 'q1', queued: true });
    step.reserve(1_000).settle({ output: false });
    // No model for the person: the turn failed, its message put back.
    await f.cycles.end(step, { status: 'failed', trace: trace('error') });
    f.advance(1_000);
    const again = await f.step({ dispatchKey: 'q1', queued: true });
    expect(again.id).toBe(step.id);
    await f.cycles.end(again, { status: 'finished', trace: trace('completed') });
    expect(await f.cycles.cycle(step.id)).toMatchObject({
        status: 'ended',
        endReason: 'completed',
        steps: 2,
    });
    // A stopped one never goes again.
    f.advance(1);
    const stopped = await f.step({ dispatchKey: 'q2' });
    await f.cycles.end(stopped, { status: 'stopped', trace: trace('stopped') });
    expect(await f.begin({ dispatchKey: 'q2' })).toEqual({
        ok: false,
        failure: 'cycle_ended',
    });
});

it('counts handoffs and keeps the envelope: same initiator, person and billing', async () => {
    const f = fixture({ limits: { handoffsPerCycle: 4 } });
    const step = await f.step();
    step.billing('byo:chatgpt');
    await f.cycles.end(step, { status: 'finished', trace: trace('interrupted') });
    const hops: number[] = [];
    for (let index = 0; index < 4; index++) {
        const next = await f.cycles.handOff(step.id, {
            dotId: `dot-${index}`,
            ownerId: null,
        });
        if (!next.ok) {
            throw new Error(next.reason);
        }
        expect(next.context).toMatchObject({
            cycleId: step.id,
            initiator: { kind: 'person', id: 'alice' },
            actingUserId: 'alice',
            billing: { kind: 'person', userId: 'alice' },
        });
        hops.push(next.context.hop);
    }
    expect(hops).toEqual([1, 2, 3, 4]);
    expect(await f.cycles.handOff(step.id, { dotId: 'dot-5', ownerId: null })).toEqual({
        ok: false,
        reason: 'handoff_limit',
    });
    expect(await f.cycles.cycle(step.id)).toMatchObject({ handoffs: 4, hop: 4 });
});

it('records who pays: the person’s own model, else the workspace', async () => {
    const f = fixture();
    const own = await f.step();
    own.billing('byo:chatgpt');
    expect(own.context.billing).toEqual({ kind: 'person', userId: 'alice' });
    // The rest of the turn on the shared model.
    own.fallback();
    expect(await f.cycles.end(own, { status: 'finished', trace: trace('completed') })).toMatchObject({
        billing: 'workspace',
        actingUserId: 'alice',
    });
    f.advance(1);
    const shared = await f.step();
    shared.billing('shared');
    expect(shared.context.billing).toEqual({ kind: 'workspace' });
});

it('says which tools were still running when a step was stopped', async () => {
    const f = fixture();
    const step = await f.step();
    const done = step.tool('computer_exec');
    step.tool('search_web')();
    expect(await f.cycles.end(step, { status: 'stopped', trace: trace('stopped') })).toMatchObject({
        unstopped: ['computer_exec'],
    });
    done();
    expect(await f.cycles.cycle(step.id)).toMatchObject({
        endReason: 'stopped',
        unstopped: ['computer_exec'],
    });
});

it('lets the person who started a cycle, or a room admin, stop it; nobody else', async () => {
    const room: CycleConversation = {
        id: 'room',
        dotId: 'dot',
        ownerId: 'room:room',
        kind: 'room',
    };
    const f = fixture({ conversations: { room } });
    // A private chat: its owner.
    await f.step();
    expect(await f.cycles.mayStop('chat', 'alice')).toBe(true);
    expect(await f.cycles.mayStop('chat', 'bob')).toBe(false);
    // A room: members, their roles, Rooms on.
    const members: Record<string, Pick<RoomMember, 'role' | 'status'>> = {
        bob: { role: 'member', status: 'active' },
        carol: { role: 'admin', status: 'active' },
        dan: { role: 'member', status: 'active' },
        erin: { role: 'member', status: 'removed' },
    };
    f.cycles.rooms = {
        member: async (_room, userId) => members[userId],
        socio: async () => 'active',
        enabled: () => true,
    };
    const bobs = await f.step({
        conversationId: 'room',
        trigger: { kind: 'person', id: 'bob' },
        actingUserId: 'bob',
    });
    expect(bobs.context).toMatchObject({ kind: 'room', actingUserId: 'bob' });
    expect(await f.cycles.mayStop('room', 'bob')).toBe(true);
    expect(await f.cycles.mayStop('room', 'carol')).toBe(true);
    expect(await f.cycles.mayStop('room', 'dan')).toBe(false);
    expect(await f.cycles.mayStop('room', 'erin')).toBe(false);
    expect(await f.cycles.mayStop('room', 'alice')).toBe(false);
});

it('starts a room’s step only as a member who may send, never as someone else', async () => {
    const room: CycleConversation = {
        id: 'room',
        dotId: 'dot',
        ownerId: 'room:room',
        kind: 'room',
    };
    const f = fixture({ conversations: { room } });
    const members: Record<string, Pick<RoomMember, 'role' | 'status'>> = {
        bob: { role: 'member', status: 'active' },
        erin: { role: 'member', status: 'left' },
    };
    let enabled = true;
    f.cycles.rooms = {
        member: async (_room, userId) => members[userId],
        socio: async (_room, dotId) => (dotId === 'dot' ? 'active' : undefined),
        enabled: () => enabled,
    };
    const as = (id: string, more: Partial<CycleRequest> = {}) =>
        f.begin({
            conversationId: 'room',
            trigger: { kind: 'person', id },
            actingUserId: id,
            ...more,
        });
    const refused = { ok: false, failure: 'room_access' };
    expect(await as('erin')).toEqual(refused);
    expect(await as('nobody')).toEqual(refused);
    // Acting for anyone but the sender.
    expect(await as('bob', { actingUserId: 'carol' })).toEqual(refused);
    // A socio not in the room, or a personal one.
    expect(await as('bob', { dotId: 'other' })).toEqual(refused);
    expect(await as('bob', { dotId: 'mine' })).toEqual(refused);
    // Not from a schedule or the server.
    expect(await f.begin({ conversationId: 'room', trigger: { kind: 'system' } })).toEqual(refused);
    enabled = false;
    expect(await as('bob')).toEqual(refused);
    enabled = true;
    expect((await as('bob')).ok).toBe(true);
    // Queued messages: claimed only for someone who may still send.
    expect(await f.cycles.mayDispatch('room', 'bob')).toBe(true);
    expect(await f.cycles.mayDispatch('room', 'erin')).toBe(false);
    expect(await f.cycles.mayDispatch('chat', 'alice')).toBe(true);
    expect(await f.cycles.mayDispatch('chat', 'bob')).toBe(false);
    expect(await f.cycles.mayDispatch('topic', 'alice')).toBe(false);
});

it('forgets old submissions and ends cycles that waited a week', async () => {
    const f = fixture();
    await f.cycles.submit('chat', 'alice');
    const step = await f.step();
    await f.cycles.end(step, { status: 'finished', trace: trace('interrupted') });
    f.advance(8 * 24 * 60 * 60_000);
    await f.cycles.tick();
    expect(await f.cycles.cycle(step.id)).toMatchObject({
        status: 'ended',
        endReason: 'expired',
    });
    expect(f.workspace.db.prepare('SELECT COUNT(*) AS n FROM work_cycle_submissions').get()).toEqual({ n: 0 });
});

it('estimates a request’s tokens to reserve, images at a fixed weight', () => {
    const text = 'x'.repeat(4_000);
    expect(estimateRequestTokens({ messages: [{ role: 'user', content: text }] })).toBeGreaterThan(1_000 + 4_000 - 1);
    const image = estimateRequestTokens({
        messages: [
            {
                role: 'user',
                content: [{ type: 'image', source: { value: 'A'.repeat(500_000) } }],
            },
        ],
    });
    expect(image).toBeLessThan(5_000);
    expect(estimateRequestTokens({ maxTokens: 100 })).toBeLessThan(200);
    expect(reportedCost({ promptTokens: 3, cost: 0.002 })).toBe(0.002);
    expect(reportedCost([{ costUsd: 0.5 }])).toBe(0.5);
    expect(reportedCost({ promptTokens: 3 })).toBeUndefined();
    expect(reportedCost({ cost: 'free' })).toBeUndefined();
});
