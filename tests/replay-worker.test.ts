import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compactEvents, EventType, type BaseEvent, type Message, type RunAgentInput } from '@ag-ui/client';
import { lastValueFrom, toArray } from 'rxjs';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { replayableEvents } from '@socio/foundation/replay/replayable-events';

import { ReplayError, type StoredRunRow } from '../src/server/replay/contract.js';
import { InlineReplayer, ReplayPool } from '../src/server/replay/pool.js';
import { ReplayCache, replayRows, replaySnapshot } from '../src/server/replay/replay.js';

import { longChatRuns } from './fixtures/long-chat.js';
import { ScriptAgent } from './fixtures/script-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { testDatabaseFile } from './helpers/test-database.js';

// CB-318: a thread's messages are rebuilt off the main thread, by the same
// AG-UI replay, and each thread's last replay is kept so the next replays
// only the runs stored since. These check that every way gives the same
// messages as the old whole replay on the main thread, that the kept
// replay is dropped when its runs change, that the main thread keeps
// ticking through a large replay, and that a worker that dies or hangs
// fails only its own call.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const pools: ReplayPool[] = [];
afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.close()));
});
function pool(options: ConstructorParameters<typeof ReplayPool>[0] = {}) {
    const instance = new ReplayPool({ log: () => {}, ...options });
    pools.push(instance);
    return instance;
}

const rowsOf = (runs: Array<{ runId: string; events: BaseEvent[] }>, from = 1): StoredRunRow[] =>
    runs.map((run, at) => ({ seq: from + at, runId: run.runId, events: JSON.stringify(run.events) }));

const run = (runId: string, threadId: string, events: Array<Record<string, unknown>>, input: Message[] = []) => ({
    runId,
    events: [
        { type: EventType.RUN_STARTED, threadId, runId, input: { threadId, runId, messages: input } },
        ...events,
        { type: EventType.RUN_FINISHED, threadId, runId },
    ] as unknown as BaseEvent[],
});

/** Histories with the shapes replays meet: tools, reasoning, state, errors, odd stored rows. */
function histories(): Record<string, StoredRunRow[]> {
    const t = 'thread';
    const user = (id: string, content: string): Message => ({ id, role: 'user', content });
    const text = (id: string, ...deltas: string[]) => [
        { type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' },
        ...deltas.map((delta) => ({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta })),
        { type: EventType.TEXT_MESSAGE_END, messageId: id },
    ];
    const tool = (id: string, parent: string, name: string, args: string, result: string) => [
        { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name, parentMessageId: parent },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: args },
        { type: EventType.TOOL_CALL_END, toolCallId: id },
        { type: EventType.TOOL_CALL_RESULT, toolCallId: id, messageId: `${id}-r`, role: 'tool', content: result },
    ];
    const basic = [
        run('r1', t, text('a1', 'Hel', 'lo'), [user('u1', 'hi')]),
        run('r2', t, [...tool('c1', 'a2', 'search', '{"q":1}', '[1]'), ...text('a2', 'found')], [user('u2', 'find')]),
        run('r3', t, text('a3', 'three'), [user('u3', 'again')]),
    ];
    const stateful = [
        run(
            's1',
            t,
            [{ type: EventType.STATE_SNAPSHOT, snapshot: { step: 1, list: [] } }, ...text('a1', 'one')],
            [user('u1', 'one')],
        ),
        run(
            's2',
            t,
            [{ type: EventType.STATE_DELTA, delta: [{ op: 'add', path: '/extra', value: 'x' }] }, ...text('a2', 'two')],
            [user('u2', 'two')],
        ),
        run(
            's3',
            t,
            [{ type: EventType.STATE_DELTA, delta: [{ op: 'add', path: '/step', value: 3 }] }, ...text('a3', 'three')],
            [user('u3', 'three')],
        ),
    ];
    // A failed run (it ends at its RUN_ERROR), one stored before CB-108 (a
    // RUN_FINISHED without ids), an empty row, and a last run still open
    // (an answer without its end, and no terminal event).
    const odd: Array<{ runId: string; events: BaseEvent[] }> = [
        run('o1', t, text('a1', 'fine'), [user('u1', 'one')]),
        {
            runId: 'o2',
            events: [
                { type: EventType.RUN_STARTED, threadId: t, runId: 'o2', input: { messages: [user('u2', 'two')] } },
                ...text('a2', 'partial'),
                { type: EventType.RUN_ERROR, message: 'boom' },
                { type: EventType.TEXT_MESSAGE_START, messageId: 'late', role: 'assistant' },
            ] as unknown as BaseEvent[],
        },
        {
            runId: 'o3',
            events: [
                { type: EventType.RUN_STARTED, threadId: t, runId: 'o3', input: { messages: [user('u3', 'three')] } },
                ...text('a3', 'stopped'),
                { type: EventType.RUN_FINISHED },
            ] as unknown as BaseEvent[],
        },
        { runId: 'o5', events: [] },
        run('o6', t, text('a6', 'after'), [user('u6', 'six')]),
        run('o7', t, [...tool('c7', 'a7', 'read', '{}', 'ok'), ...text('a7', 'done')], [user('u7', 'seven')]),
        {
            runId: 'o8',
            events: [
                { type: EventType.RUN_STARTED, threadId: t, runId: 'o8', input: { messages: [user('u8', 'eight')] } },
                { type: EventType.TEXT_MESSAGE_START, messageId: 'a8', role: 'assistant' },
                { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a8', delta: 'never ended' },
            ] as unknown as BaseEvent[],
        },
    ];
    return {
        basic: rowsOf(basic),
        stateful: rowsOf(stateful),
        odd: rowsOf(odd),
        long: rowsOf(longChatRuns({ threadId: t, turns: 24, largest: 40_000 })),
    };
}

/**
 * The whole replay of every prefix of a history, made once for the tests
 * that compare against it: for the long history, seconds of CPU.
 */
const wholes = new Map<string, Promise<Message[][]>>();
function wholeReplays(name: string, rows: StoredRunRow[]) {
    let found = wholes.get(name);
    if (!found) {
        found = (async () => {
            const all: Message[][] = [];
            for (let end = 0; end <= rows.length; end++) {
                all.push(await replayRows('thread', rows.slice(0, end)));
            }
            return all;
        })();
        wholes.set(name, found);
    }
    return found;
}

/** Every prefix of `rows`, replayed in order through `replay`, against the whole replay of each. */
async function expectSameAsWhole(
    name: string,
    rows: StoredRunRow[],
    replay: (prefix: StoredRunRow[]) => Promise<Message[]>,
) {
    const whole = await wholeReplays(name, rows);
    for (let end = 0; end <= rows.length; end++) {
        expect(await replay(rows.slice(0, end)), `after ${end} rows`).toEqual(whole[end]);
    }
}

describe('equivalence with the whole replay', () => {
    for (const [name, rows] of Object.entries(histories())) {
        // Only CPU, and no clock in what they check: the long history's whole
        // replays take seconds alone, many times that on a loaded machine.
        // The limit is there to stop a hang, not to measure speed.
        const options = name === 'long' ? { timeout: 120_000 } : {};
        it(`${name}: the cached incremental replay, run by run and all at once`, options, async () => {
            const cache = new ReplayCache();
            await expectSameAsWhole(
                name,
                rows,
                async (prefix) => (await cache.messages('k', 'thread', prefix)).messages,
            );
            const fresh = new ReplayCache();
            await fresh.messages('k', 'thread', rows.slice(0, 1));
            expect((await fresh.messages('k', 'thread', rows)).messages).toEqual(
                (await wholeReplays(name, rows)).at(-1),
            );
        });

        it(`${name}: the worker, run by run`, options, async () => {
            const replayer = pool();
            await expectSameAsWhole(
                name,
                rows,
                async (prefix) => (await replayer.messages('k', 'thread', prefix)).messages,
            );
        });
    }

    it('replays only the runs stored since its last replay', async () => {
        const { long } = histories();
        const cache = new ReplayCache();
        expect((await cache.messages('k', 'thread', long.slice(0, 20))).stats).toEqual({
            cachedRows: 0,
            replayedRows: 20,
        });
        expect((await cache.messages('k', 'thread', long)).stats).toEqual({ cachedRows: 20, replayedRows: 4 });
        expect((await cache.messages('k', 'thread', long)).stats).toEqual({ cachedRows: 24, replayedRows: 0 });
    });

    it('carries the state over', async () => {
        const { stateful } = histories();
        const cache = new ReplayCache();
        await cache.messages('k', 'thread', stateful.slice(0, 2));
        expect((await cache.messages('k', 'thread', stateful)).stats.cachedRows).toBe(2);
        const rows = stateful.flatMap((row) => replayableEvents('thread', row));
        const whole = await replaySnapshot('thread', compactEvents(rows));
        const head = await replaySnapshot('thread', compactEvents(rows.slice(0, rows.length - 6)));
        expect(head.state).toEqual({ extra: 'x' });
        expect(whole.state).toEqual({ step: 3 });
        expect(await replaySnapshot('thread', compactEvents(rows.slice(-6)), head)).toEqual(whole);
    });

    it('stops before a run left open, and replays it again each time', async () => {
        const { odd } = histories();
        const cache = new ReplayCache();
        await cache.messages('k', 'thread', odd);
        const again = await cache.messages('k', 'thread', odd);
        expect(again.stats).toEqual({ cachedRows: odd.length - 1, replayedRows: 1 });
        expect(again.messages.at(-1)).toMatchObject({ id: 'a8', content: 'never ended' });
    });

    it('fails as the whole replay does when an answer was left open before later runs', async () => {
        const { odd, basic } = histories();
        const broken = [...odd, ...basic.map((row) => ({ ...row, seq: row.seq + 100 }))];
        const whole = await replayRows('thread', broken).catch((error: Error) => error.message);
        expect(whole).toMatch(/still active/);
        const cache = new ReplayCache();
        await cache.messages('k', 'thread', odd.slice(0, -1));
        await expect(cache.messages('k', 'thread', broken)).rejects.toThrow(whole as string);
        // What it keeps now stops before the open run, and still holds.
        expect((await cache.messages('k', 'thread', odd)).messages).toEqual(await replayRows('thread', odd));
    });
});

describe('the kept replay', () => {
    it('is replaced when a covered run changes, goes away or a run finishes out of order', async () => {
        const { basic } = histories();
        const cache = new ReplayCache();
        await cache.messages('k', 'thread', basic);
        const edited = basic.map((row, at) =>
            at === 1 ? { ...row, events: row.events.replace('found', 'FOUND') } : row,
        );
        const changed = await cache.messages('k', 'thread', edited);
        expect(changed.stats).toEqual({ cachedRows: 0, replayedRows: 3 });
        expect(changed.messages).toEqual(await replayRows('thread', edited));
        expect(changed.messages.find((message) => message.id === 'a2')?.content).toBe('FOUND');

        const removed = [basic[0], basic[2]];
        expect((await cache.messages('k', 'thread', removed)).stats.cachedRows).toBe(0);
        expect((await cache.messages('k', 'thread', removed)).stats.cachedRows).toBe(2);
        // A run with an earlier seq finished after the later one was kept.
        expect((await cache.messages('k', 'thread', basic)).stats.cachedRows).toBe(0);
    });

    it('is forgotten on request, by key or by runner, and bounded by size', async () => {
        const { basic, long } = histories();
        const cache = new ReplayCache();
        await cache.messages('a:1', 'thread', basic);
        await cache.messages('a:2', 'thread', basic);
        await cache.messages('b:1', 'thread', basic);
        cache.forget('a:1');
        expect([cache.has('a:1'), cache.has('a:2'), cache.has('b:1')]).toEqual([false, true, true]);
        cache.forgetPrefix('a:');
        expect([cache.has('a:2'), cache.has('b:1')]).toEqual([false, true]);

        const size = long.reduce((sum, row) => sum + row.events.length, 0);
        const small = new ReplayCache(Math.floor(size * 1.5));
        await small.messages('one', 'thread', long);
        await small.messages('two', 'thread', long);
        expect([small.has('one'), small.has('two')]).toEqual([false, true]);
        expect(small.bytes).toBe(size);
        const tiny = new ReplayCache(10);
        expect((await tiny.messages('one', 'thread', long)).messages).toEqual(await replayRows('thread', long));
        expect(tiny.size).toBe(0);
    });

    it('gives each caller its own copy inline', async () => {
        const { basic } = histories();
        const inline = new InlineReplayer();
        const first = await inline.messages('k', 'thread', basic);
        first.messages[0].content = 'changed';
        expect((await inline.messages('k', 'thread', basic)).messages).toEqual(await replayRows('thread', basic));
    });
});

describe('LocalAgentRunner.messages', () => {
    function database() {
        const dir = mkdtempSync(join(tmpdir(), 'socio-replay-'));
        cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
        return testDatabaseFile(join(dir, 'runs.sqlite'));
    }
    async function turn(target: LocalAgentRunner, runId: string, history: Message[], reply: string) {
        const agent = new ScriptAgent(reply);
        const messages = [...history, { id: `${runId}-u`, role: 'user', content: `ask ${runId}` } as Message];
        agent.threadId = 'thread';
        agent.setMessages(messages);
        const input: RunAgentInput = {
            threadId: 'thread',
            runId,
            messages,
            state: {},
            tools: [],
            context: [],
            forwardedProps: {},
        };
        await lastValueFrom(target.run({ threadId: 'thread', agent, input }).pipe(toArray()));
    }

    it('replays in the worker, keeps what it rebuilt, and matches the whole replay', async () => {
        const replayer = pool();
        const target = new LocalAgentRunner(database(), { flushIntervalMs: 5, replayer });
        cleanup.push(() => target.close());
        let history: Message[] = [];
        for (const runId of ['r1', 'r2', 'r3']) {
            await turn(target, runId, history, `answer ${runId}`);
            history = await target.messages('thread');
            expect(history).toEqual(await replayRows('thread', storedRows(target)));
        }
        expect(history.map((message) => message.content)).toEqual([
            'ask r1',
            'answer r1',
            'ask r2',
            'answer r2',
            'ask r3',
            'answer r3',
        ]);
        expect(history).toEqual(
            await new InlineReplayer().messages('x', 'thread', storedRows(target)).then((r) => r.messages),
        );
    });

    it('forgets its threads when it closes', async () => {
        const replayer = new InlineReplayer();
        const target = new LocalAgentRunner(database(), { flushIntervalMs: 5, replayer });
        await turn(target, 'r1', [], 'one');
        await target.messages('thread');
        expect(replayer.cache.size).toBe(1);
        target.forgetReplay('thread');
        expect(replayer.cache.size).toBe(0);
        await target.messages('thread');
        target.close();
        expect(replayer.cache.size).toBe(0);
    });
});

/** The rows `messages` reads, straight from the runner's database. */
function storedRows(target: LocalAgentRunner): StoredRunRow[] {
    const db = (target as unknown as { db: import('node:sqlite').DatabaseSync }).db;
    return db
        .prepare("SELECT seq, runId, events FROM agent_runs WHERE threadId='thread' AND status!='running' ORDER BY seq")
        .all() as unknown as StoredRunRow[];
}

/**
 * About 3,000 events over a few MB: 340 runs, each a question, a tool call
 * with a result of about 12 KB and an answer.
 */
function largeHistory(): StoredRunRow[] {
    const t = 'thread';
    const runs = Array.from({ length: 340 }, (_, turnAt) => {
        const runId = `big-${turnAt}`;
        const answer = `a-${turnAt}`;
        return run(
            runId,
            t,
            [
                {
                    type: EventType.TOOL_CALL_START,
                    toolCallId: `c-${turnAt}`,
                    toolCallName: 'q',
                    parentMessageId: answer,
                },
                { type: EventType.TOOL_CALL_ARGS, toolCallId: `c-${turnAt}`, delta: '{"n":1}' },
                { type: EventType.TOOL_CALL_END, toolCallId: `c-${turnAt}` },
                {
                    type: EventType.TOOL_CALL_RESULT,
                    toolCallId: `c-${turnAt}`,
                    messageId: `c-${turnAt}-r`,
                    role: 'tool',
                    content: `${turnAt}:${'result row; '.repeat(1000)}`,
                },
                { type: EventType.TEXT_MESSAGE_START, messageId: answer, role: 'assistant' },
                { type: EventType.TEXT_MESSAGE_CONTENT, messageId: answer, delta: 'Here is what I found. '.repeat(20) },
                { type: EventType.TEXT_MESSAGE_END, messageId: answer },
            ],
            [{ id: `u-${turnAt}`, role: 'user', content: `Question ${turnAt}` }],
        );
    });
    return rowsOf(runs);
}

const threadCpuMs = () => {
    const { user, system } = process.threadCpuUsage();
    return (user + system) / 1000;
};

/**
 * The longest the main thread went without running a 10 ms interval while
 * `work` ran, counted in this thread's own CPU time: how long it was kept
 * busy, which a loaded machine doesn't stretch. On the wall clock (`gap`,
 * only for the benchmark) the same wait also counts the time the thread
 * sat runnable while other processes had the CPU.
 */
async function longestBlock(work: () => Promise<unknown>) {
    const started = performance.now();
    let last = started;
    let lastCpu = threadCpuMs();
    let gap = 0;
    let cpu = 0;
    const tick = () => {
        const now = performance.now();
        const nowCpu = threadCpuMs();
        gap = Math.max(gap, now - last);
        cpu = Math.max(cpu, nowCpu - lastCpu);
        last = now;
        lastCpu = nowCpu;
    };
    const timer = setInterval(tick, 10);
    try {
        await work();
    } finally {
        clearInterval(timer);
        tick();
    }
    return { cpu, gap, ms: performance.now() - started };
}

describe('the main thread', () => {
    it('keeps ticking while the worker replays a large history', { timeout: 300_000 }, async () => {
        const rows = largeHistory();
        const events = rows.reduce((sum, row) => sum + JSON.parse(row.events).length, 0);
        const bytes = rows.reduce((sum, row) => sum + row.events.length, 0);
        expect(events).toBeGreaterThanOrEqual(3000);
        expect(bytes).toBeGreaterThan(3_000_000);
        const replayer = pool();
        // The worker starts before the measurement, as it is kept running.
        await replayer.messages('warm', 'thread', rows.slice(0, 1));
        let messages: Message[] = [];
        const worker = await longestBlock(async () => {
            messages = (await replayer.messages('big', 'thread', rows)).messages;
        });
        expect(messages).toHaveLength(1020);
        // In this thread's CPU time: on the wall clock, a loaded machine
        // stretched the gaps past any bound while the thread only waited.
        // Inline, the same replay keeps it busy for seconds at once.
        expect(worker.cpu).toBeLessThan(250);
        // The next turn's call replays only its run.
        const next = await longestBlock(() => replayer.messages('big', 'thread', rows));
        expect(next.cpu).toBeLessThan(250);
        if (process.env.REPLAY_BENCH) {
            const inline = await longestBlock(() => replayRows('thread', rows));
            process.stderr.write(
                `CB-318 replay of ${events} events, ${(bytes / 1e6).toFixed(1)} MB: inline blocks ${inline.gap.toFixed(0)} ms (${inline.cpu.toFixed(0)} ms CPU) of ${inline.ms.toFixed(0)} ms; worker blocks ${worker.gap.toFixed(0)} ms (${worker.cpu.toFixed(0)} ms CPU) of ${worker.ms.toFixed(0)} ms; cached call blocks ${next.gap.toFixed(0)} ms (${next.cpu.toFixed(0)} ms CPU) of ${next.ms.toFixed(0)} ms\n`,
            );
        }
    });
});

describe('a worker that fails', () => {
    const crashing = fileURLToPath(new URL('./fixtures/replay-worker-crash.ts', import.meta.url));

    it('fails the call it had when it stops, and the next call works', async () => {
        const { basic } = histories();
        const replayer = pool({ entry: crashing });
        await expect(replayer.messages('k', 'crash', basic)).rejects.toMatchObject({
            name: 'ReplayError',
            reason: 'crash',
            message: expect.stringMatching(/replay worker stopped \(exit code 3\)/),
        });
        expect((await replayer.messages('k', 'thread', basic)).messages).toEqual(await replayRows('thread', basic));
    });

    it('fails a call that takes too long, replaces the worker, and the next call works', async () => {
        const { basic } = histories();
        const replayer = pool({ entry: crashing });
        await replayer.messages('k', 'thread', basic);
        const first = replayer.threadId;
        const hung = replayer.messages('k', 'hang', basic, { timeoutMs: 300 });
        const queued = replayer.messages('k', 'thread', basic);
        await expect(hung).rejects.toBeInstanceOf(ReplayError);
        await expect(hung).rejects.toMatchObject({ reason: 'timeout' });
        expect((await queued).messages).toEqual(await replayRows('thread', basic));
        expect(replayer.threadId).not.toBe(first);
    });

    it('fails the call when the replay itself throws, and keeps the worker', async () => {
        const replayer = pool();
        const broken: StoredRunRow[] = [{ seq: 1, runId: 'x', events: '{not json' }];
        await expect(replayer.messages('k', 'thread', broken)).rejects.toMatchObject({ reason: 'replay' });
        const first = replayer.threadId;
        const { basic } = histories();
        expect((await replayer.messages('k', 'thread', basic)).messages).toEqual(await replayRows('thread', basic));
        expect(replayer.threadId).toBe(first);
    });
});
