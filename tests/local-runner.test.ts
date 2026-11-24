import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { EventSchemas, EventType, type Message, type RunAgentInput, type RunStartedEvent } from '@ag-ui/client';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it } from 'vitest';

import { migrateDatabase } from '@socio/data/migrate';
import { RuntimeSession } from '@socio/data/runtime-ownership';
import { TURN_FAILURE_MESSAGES, turnError } from '@socio/foundation/observability/failures';
import { threadRunning } from '@socio/shared/chat/thread-running';
import { TraceTimes } from '@socio/shared/runs/trace-times';

import { schemas } from '../src/server/modules/index.js';
import { ThreadRunningError } from '../src/server/turns/contract.js';
import { INTERRUPTED_RUN_MESSAGE } from '../src/server/turns/local-runner.js';

import { ScriptAgent } from './fixtures/script-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { testDatabaseFile } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);

function emptyDatabase() {
    const dir = mkdtempSync(join(tmpdir(), 'company-brain-runner-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, 'runs.sqlite');
}
function database() {
    return testDatabaseFile(emptyDatabase());
}
/** What the next boot does to an older database. */
const boot = (path: string) => migrateDatabase(path, schemas, { backupDirectory: `${path}-backups` });
function runner(path: string) {
    const instance = new LocalAgentRunner(path, { flushIntervalMs: 5 });
    cleanup.push(() => instance.close());
    return instance;
}

function start(target: LocalAgentRunner, agent: ScriptAgent, runId: string, messages: Message[], threadId = 'thread') {
    agent.threadId = threadId;
    agent.setMessages(messages);
    const input: RunAgentInput = {
        threadId,
        runId,
        messages,
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
    };
    return target.run({ threadId, agent, input });
}
const user = (id: string, content: string): Message => ({
    id,
    role: 'user',
    content,
});
const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(check()).toBe(true);
};

it('persists runs across a restart and rebuilds messages from events', async () => {
    const path = database();
    const first = runner(path);
    await lastValueFrom(start(first, new ScriptAgent('Hi there'), 'r1', [user('u1', 'hello')]));
    first.close();

    const second = runner(path);
    expect(await second.isRunning({ threadId: 'thread' })).toBe(false);
    expect((await second.messages('thread')).map((m) => [m.role, m.content])).toEqual([
        ['user', 'hello'],
        ['assistant', 'Hi there'],
    ]);
    const replay = await lastValueFrom(second.connect({ threadId: 'thread' }).pipe(toArray()));
    expect(replay.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

it('records only the messages a run introduced in RUN_STARTED', async () => {
    const target = runner(database());
    await lastValueFrom(start(target, new ScriptAgent('one'), 'r1', [user('u1', 'first')]));
    const history = await target.messages('thread');
    await lastValueFrom(start(target, new ScriptAgent('two'), 'r2', [...history, user('u2', 'second')]));
    const started = target
        .events('thread')
        .filter((event): event is RunStartedEvent => event.type === EventType.RUN_STARTED);
    expect(started.map((event) => event.input?.messages.map((m) => m.id))).toEqual([['u1'], ['u2']]);
    expect((await target.messages('thread')).map((m) => m.content)).toEqual(['first', 'one', 'second', 'two']);
});

it('closes a run left open by a crash and keeps the user message', async () => {
    const path = database();
    const crashed = runner(path);
    const agent = new ScriptAgent('partial answer', true);
    start(crashed, agent, 'r1', [user('u1', 'survive this')]).subscribe();
    // Wait until the streamed answer reaches disk, then "restart" without
    // letting the first process finish the run.
    const disk = new DatabaseSync(path, { readOnly: true });
    await expect
        .poll(() =>
            (disk.prepare("SELECT events FROM agent_runs WHERE status='running'").all() as { events: string }[]).some(
                (row) => row.events.includes('partial answer'),
            ),
        )
        .toBe(true);
    disk.close();
    // A second live runtime is no longer evidence of a crash. End the old
    // owner's connection without waiting for its in-flight agent to settle.
    crashed.close();

    const restarted = runner(path);
    expect(await restarted.isRunning({ threadId: 'thread' })).toBe(false);
    const messages = await restarted.messages('thread');
    expect(messages.map((m) => [m.role, m.content])).toEqual([
        ['user', 'survive this'],
        ['assistant', 'partial answer'],
    ]);
    expect(restarted.events('thread').at(-1)).toMatchObject({
        type: EventType.RUN_ERROR,
        message: INTERRUPTED_RUN_MESSAGE,
        code: 'INCOMPLETE_STREAM',
    });
    agent.abortRun();
});

it('rejects a second concurrent run on the same thread', async () => {
    const target = runner(database());
    const agent = new ScriptAgent('slow', true);
    start(target, agent, 'r1', [user('u1', 'first')]).subscribe();
    expect(() => start(target, new ScriptAgent('fast'), 'r2', [user('u2', 'second')])).toThrow(
        'Thread already running',
    );
    // With its stable code (CB-357), which callers match instead of the text.
    let refused: unknown;
    try {
        start(target, new ScriptAgent('fast'), 'r3', [user('u3', 'third')]);
    } catch (error) {
        refused = error;
    }
    expect(refused).toBeInstanceOf(ThreadRunningError);
    expect(refused).toMatchObject({ code: 'thread_running', message: 'Thread already running' });
    expect(threadRunning(refused)).toBe(true);
    expect(target.activeRunId('thread')).toBe('r1');
    agent.abortRun();
});

it('stops only the requested run and records it as stopped', async () => {
    const target = runner(database());
    const agent = new ScriptAgent('working', true);
    const events = lastValueFrom(start(target, agent, 'r1', [user('u1', 'go')]).pipe(toArray()));
    expect(await target.stop({ threadId: 'thread', runId: 'other' })).toBe(false);
    expect(agent.aborted).toBe(false);
    expect(await target.stop({ threadId: 'thread', runId: 'r1' })).toBe(true);
    expect(agent.aborted).toBe(true);
    expect((await events).at(-1)?.type).toBe(EventType.RUN_FINISHED);
    await until(() => !target.activeRunId('thread'));
    expect(await target.stop({ threadId: 'thread' })).toBe(false);
    // The stored run closes exactly once, so it replays cleanly.
    expect(
        target
            .events('thread')
            .filter((event) => event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR),
    ).toHaveLength(1);
});

it('replays past a stopped run: its RUN_FINISHED has the ids the browser checks for', async () => {
    const path = database();
    const target = runner(path);
    const agent = new ScriptAgent('working', true);
    const stopped = lastValueFrom(start(target, agent, 'r1', [user('u1', 'stop this')]).pipe(toArray()));
    await until(() => target.activeRunId('thread') === 'r1');
    await target.stop({ threadId: 'thread', runId: 'r1' });
    expect((await stopped).at(-1)).toMatchObject({
        type: EventType.RUN_FINISHED,
        threadId: 'thread',
        runId: 'r1',
    });
    await until(() => !target.activeRunId('thread'));
    await lastValueFrom(
        start(target, new ScriptAgent('after the stop'), 'r2', [user('u1', 'stop this'), user('u2', 'and then')]),
    );
    // A stop stored before CB-108, without ids, as finalizeRunEvents left it.
    const disk = new DatabaseSync(path);
    const row = disk.prepare("SELECT events FROM agent_runs WHERE runId='r1'").get() as { events: string };
    const bare = (JSON.parse(row.events) as Array<Record<string, unknown>>).map((event) =>
        event.type === EventType.RUN_FINISHED ? { type: event.type, timestamp: event.timestamp } : event,
    );
    disk.prepare("UPDATE agent_runs SET events=? WHERE runId='r1'").run(JSON.stringify(bare));
    disk.close();
    const replay = await lastValueFrom(target.connect({ threadId: 'thread' }).pipe(toArray()));
    // The browser's runtime client checks every event, and silently ends
    // the replay at one that fails, hiding every later turn.
    for (const event of replay) {
        expect(EventSchemas.safeParse(event).success, event.type).toBe(true);
    }
    expect(replay.filter((event) => event.type === EventType.RUN_FINISHED)).toMatchObject([
        { threadId: 'thread', runId: 'r1' },
        { threadId: 'thread', runId: 'r2' },
    ]);
    expect((await target.messages('thread')).map((m) => m.content)).toEqual([
        'stop this',
        'working',
        'and then',
        'after the stop',
    ]);
});

it('bridges a connection made during a run to its live events', async () => {
    const target = runner(database());
    await lastValueFrom(start(target, new ScriptAgent('earlier'), 'r1', [user('u1', 'first')]));
    const agent = new ScriptAgent('live', true);
    start(target, agent, 'r2', [user('u2', 'second')]).subscribe();
    const connected = lastValueFrom(target.connect({ threadId: 'thread' }).pipe(toArray()));
    agent.abortRun();
    const types = (await connected).map((event) => event.type);
    expect(types.filter((type) => type === EventType.RUN_STARTED)).toHaveLength(2);
    expect(types.at(-1)).toBe(EventType.RUN_ERROR);
});

it('keeps a failed run’s error detail in its row, never in client events', async () => {
    const path = database();
    const target = runner(path);
    const failure = turnError('model_rejected', new Error('400 image input requires a supported vision checkpoint'));
    const live = await lastValueFrom(
        start(target, new ScriptAgent('partial', false, failure), 'r1', [user('u1', 'look at this')]).pipe(toArray()),
    );
    const replayed = await lastValueFrom(target.connect({ threadId: 'thread' }).pipe(toArray()));
    for (const events of [live, replayed, target.events('thread')]) {
        expect(events.filter((event) => event.type === EventType.RUN_ERROR)).toEqual([
            {
                type: EventType.RUN_ERROR,
                message: TURN_FAILURE_MESSAGES.model_rejected,
                code: 'model_rejected',
                timestamp: expect.any(Number),
            },
        ]);
        expect(JSON.stringify(events)).not.toContain('vision checkpoint');
    }
    await until(() => !target.activeRunId('thread'));
    const disk = new DatabaseSync(path, { readOnly: true });
    expect(disk.prepare('SELECT status, events, errorDetail FROM agent_runs').get()).toEqual({
        status: 'failed',
        events: expect.not.stringContaining('vision checkpoint'),
        errorDetail: '400 image input requires a supported vision checkpoint',
    });
    disk.close();
});

it('closes a run that ended without a terminal event with the generic failure', async () => {
    const target = runner(database());
    const agent = new ScriptAgent('cut off', true);
    const events = lastValueFrom(start(target, agent, 'r1', [user('u1', 'go')]).pipe(toArray()));
    agent.abortRun();
    expect((await events).at(-1)).toEqual({
        type: EventType.RUN_ERROR,
        message: TURN_FAILURE_MESSAGES.failed,
        code: 'INCOMPLETE_STREAM',
        timestamp: expect.any(Number),
    });
});

it('adds the errorDetail column to an existing database', async () => {
    const path = emptyDatabase();
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE agent_runs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      threadId TEXT NOT NULL,
      runId TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      events TEXT NOT NULL,
      startedAt INTEGER NOT NULL,
      finishedAt INTEGER
    );`);
    old.close();
    boot(path);
    const target = runner(path);
    await lastValueFrom(start(target, new ScriptAgent('still works'), 'r1', [user('u1', 'hi')]));
    expect((await target.messages('thread')).at(-1)?.content).toBe('still works');
    const disk = new DatabaseSync(path, { readOnly: true });
    expect(disk.prepare('SELECT errorDetail FROM agent_runs').get()).toEqual({
        errorDetail: null,
    });
    disk.close();
});

it('stamps every event with its time, stores and replays it, and gives older runs their row’s times (CB-72)', async () => {
    const path = emptyDatabase();
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE agent_runs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      threadId TEXT NOT NULL,
      runId TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      events TEXT NOT NULL,
      startedAt INTEGER NOT NULL,
      finishedAt INTEGER
    );`);
    const untimed = [
        {
            type: EventType.RUN_STARTED,
            threadId: 'thread',
            runId: 'r0',
            input: { messages: [user('u0', 'before')] },
        },
        { type: EventType.TEXT_MESSAGE_START, messageId: 'a0', role: 'assistant' },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a0', delta: 'old' },
        { type: EventType.TEXT_MESSAGE_END, messageId: 'a0' },
        { type: EventType.RUN_FINISHED, threadId: 'thread', runId: 'r0' },
    ];
    old.prepare(
        "INSERT INTO agent_runs (threadId, runId, status, events, startedAt, finishedAt) VALUES ('thread', 'r0', 'finished', ?, 1000, 5000)",
    ).run(JSON.stringify(untimed));
    old.close();
    boot(path);

    const target = runner(path);
    const before = Date.now();
    const live = await lastValueFrom(start(target, new ScriptAgent('new'), 'r1', [user('u1', 'now')]).pipe(toArray()));
    const after = Date.now();
    const fresh = (event: { timestamp?: number }) => event.timestamp! >= before && event.timestamp! <= after;
    expect(live.length).toBeGreaterThan(3);
    expect(live.every(fresh)).toBe(true);
    const replayed = await lastValueFrom(target.connect({ threadId: 'thread' }).pipe(toArray()));
    // The old run: its start and end have the row's times (runs migration
    // 3), the rest none. The new run's events have theirs, but for the text
    // the replay joins into one event.
    expect(replayed.slice(0, 5).map((event) => event.timestamp)).toEqual([1000, undefined, undefined, undefined, 5000]);
    expect(
        replayed
            .slice(5)
            .filter((event) => event.type !== EventType.TEXT_MESSAGE_CONTENT)
            .every(fresh),
    ).toBe(true);
    const times = new TraceTimes(replayed);
    expect(times.messages.get('u0')).toBe(1000);
    // A reply without a time of its own has its run's end.
    expect(times.messages.get('a0')).toBe(5000);
    expect(fresh({ timestamp: times.messages.get('u1') })).toBe(true);
    expect(fresh({ timestamp: times.messages.get('answer-r1') })).toBe(true);
    // A second start migrates nothing again: the times stay.
    target.close();
    const again = runner(path);
    expect(again.events('thread').map((event) => event.timestamp)).toEqual(replayed.map((event) => event.timestamp));
});

it('keeps the history of a deleted conversation and leaves its runs out of the list (CB-64)', async () => {
    const target = runner(database());
    const agent = new ScriptAgent('busy', true);
    start(target, agent, 'r1', [user('u1', 'hello')]).subscribe();
    agent.abortRun();
    await until(() => !target.activeRunId('thread'));
    // Nothing deletes run history: a deleted conversation's runs stay stored.
    expect('deleteThread' in target).toBe(false);
    expect(target.hasHistory('thread')).toBe(true);
    expect(target.recentRuns().map((run) => run.threadId)).toEqual(['thread']);
    expect(target.recentRuns({ exclude: ['thread'] })).toEqual([]);
});

it('adds the source column to an existing database and lists its runs', () => {
    const path = emptyDatabase();
    const old = new DatabaseSync(path);
    old.exec(
        `CREATE TABLE agent_runs (seq INTEGER PRIMARY KEY AUTOINCREMENT, threadId TEXT NOT NULL, runId TEXT NOT NULL UNIQUE, status TEXT NOT NULL, events TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER)`,
    );
    old.prepare(
        "INSERT INTO agent_runs (threadId, runId, status, events, startedAt, finishedAt) VALUES ('thread', 'r1', 'failed', ?, 1000, 1500)",
    ).run(
        JSON.stringify([
            { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'r1' },
            { type: EventType.RUN_ERROR, message: 'Model unavailable' },
        ]),
    );
    old.close();
    boot(path);
    const target = runner(path);
    start(target, new ScriptAgent('Hi'), 'r2', [user('u1', 'hello')]);
    expect(target.recentRuns()).toEqual([
        expect.objectContaining({ runId: 'r2', source: null, error: null }),
        {
            runId: 'r1',
            threadId: 'thread',
            status: 'failed',
            source: null,
            startedAt: 1000,
            finishedAt: 1500,
            error: 'Model unavailable',
            errorDetail: null,
            // Stored before traces (CB-128).
            trace: null,
        },
    ]);
    expect(target.recentRuns({ status: 'failed', limit: 5 })).toHaveLength(1);
});

it('replays a stored run that continued past its RUN_ERROR', async () => {
    const path = database();
    const target = runner(path);
    await lastValueFrom(start(target, new ScriptAgent('Hi'), 'r1', [user('u1', 'hello')]).pipe(toArray()));
    const db = new DatabaseSync(path);
    db.prepare(
        "INSERT INTO agent_runs (threadId, runId, status, events, startedAt, finishedAt) VALUES ('thread', 'r2', 'failed', ?, 2000, 2500)",
    ).run(
        JSON.stringify([
            { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'r2' },
            { type: EventType.RUN_ERROR, message: 'Time limit' },
            {
                type: EventType.TOOL_CALL_START,
                toolCallId: 'late',
                toolCallName: 'search_web',
            },
        ]),
    );
    db.close();
    expect(await target.messages('thread')).toHaveLength(2);
});

it('recovers its own expired turn without a second runtime or a stale completion callback', async () => {
    const path = database();
    let now = 1000;
    const runtime = new RuntimeSession({
        heartbeat: false,
        leaseMs: 100,
        now: () => now,
    });
    const target = new LocalAgentRunner(path, { runtime, flushIntervalMs: 5 });
    cleanup.push(() => target.close());
    const ended: string[] = [];
    target.onRunFinished((_thread, status) => ended.push(status));
    const disk = new DatabaseSync(path, { readOnly: true });
    cleanup.push(() => disk.close());
    start(target, new ScriptAgent('partial answer', true), 'solo-expiry', [
        user('solo-user', 'survive this'),
    ]).subscribe();
    await expect
        .poll(() =>
            String(disk.prepare("SELECT events FROM agent_runs WHERE runId='solo-expiry'").get()?.events).includes(
                'partial answer',
            ),
        )
        .toBe(true);
    now += 101;
    await expect
        .poll(() => disk.prepare("SELECT status FROM agent_runs WHERE runId='solo-expiry'").get()?.status)
        .toBe('interrupted');
    expect(target.events('thread').some((event) => JSON.stringify(event).includes('survive this'))).toBe(true);
    expect(ended).toEqual([]);
});
