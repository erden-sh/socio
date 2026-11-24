import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AbstractAgent, EventType, type BaseEvent, type Message, type RunAgentInput } from '@ag-ui/client';
import { lastValueFrom, Observable, toArray } from 'rxjs';
import { afterEach, expect, it } from 'vitest';

import { RUNTIME_HISTORY_MS, RuntimeSession } from '@socio/data/runtime-ownership';

import { JobService } from '../src/server/schedules/jobs.js';
import { sqliteSchedules } from '../src/server/schedules/services.js';
import { ThreadRunningError } from '../src/server/turns/contract.js';
import { settledEvents } from '../src/server/turns/local-runner.js';

import { LocalAgentRunner } from './helpers/runners.js';
import { testDatabase, testDatabaseFile } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);

/**
 * Says `first` whole, starts `second`, and holds there until `finish()`
 * (or a stop) so another runtime can look at the turn in progress.
 */
class StepAgent extends AbstractAgent {
    aborted = false;
    private next?: () => void;
    private end?: () => void;
    constructor() {
        super({});
    }
    run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable<BaseEvent>((subscriber) => {
            const event = (value: Record<string, unknown>) => subscriber.next(value as unknown as BaseEvent);
            event({
                type: EventType.RUN_STARTED,
                threadId: input.threadId,
                runId: input.runId,
            });
            event({
                type: EventType.TEXT_MESSAGE_START,
                messageId: 'first',
                role: 'assistant',
            });
            event({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: 'first',
                delta: 'One ',
            });
            event({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: 'first',
                delta: 'whole.',
            });
            event({ type: EventType.TEXT_MESSAGE_END, messageId: 'first' });
            event({
                type: EventType.TEXT_MESSAGE_START,
                messageId: 'second',
                role: 'assistant',
            });
            event({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: 'second',
                delta: 'Half',
            });
            this.next = () => {
                event({
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: 'second',
                    delta: ' and done.',
                });
                event({ type: EventType.TEXT_MESSAGE_END, messageId: 'second' });
                event({
                    type: EventType.RUN_FINISHED,
                    threadId: input.threadId,
                    runId: input.runId,
                });
                subscriber.complete();
            };
            this.end = () => subscriber.complete();
            if (this.aborted) {
                this.end();
            }
        });
    }
    finish() {
        this.next?.();
    }
    abortRun() {
        this.aborted = true;
        this.end?.();
    }
}

/** Two runtimes (the old and new task of a deploy) on one database file. */
function pair(leaseMs = 1500) {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-routing-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = testDatabaseFile(join(dir, 'runs.sqlite'));
    const make = () => {
        const runtime = new RuntimeSession({ leaseMs, heartbeatMs: 50 });
        const runner = new LocalAgentRunner(path, { runtime, flushIntervalMs: 5 });
        cleanup.push(() => runner.close());
        return runner;
    };
    return { a: make(), b: make() };
}
const user = (id: string, content: string): Message => ({
    id,
    role: 'user',
    content,
});
function start(target: LocalAgentRunner, agent: AbstractAgent, runId: string) {
    const messages = [user(`u-${runId}`, 'hello')];
    agent.threadId = 'thread';
    agent.setMessages(messages);
    return target.run({
        threadId: 'thread',
        agent,
        input: {
            threadId: 'thread',
            runId,
            messages,
            state: {},
            tools: [],
            context: [],
            forwardedProps: {},
        },
    });
}
const text = (events: BaseEvent[], id: string) =>
    events
        .filter(
            (event) =>
                event.type === EventType.TEXT_MESSAGE_CONTENT &&
                (event as unknown as { messageId?: string }).messageId === id,
        )
        .map((event) => (event as unknown as { delta: string }).delta)
        .join('');
const flushed = (runner: LocalAgentRunner, needle: string) =>
    expect
        .poll(() =>
            JSON.stringify(
                (
                    runner as unknown as {
                        db: { prepare(sql: string): { get(): unknown } };
                    }
                ).db
                    .prepare("SELECT events FROM agent_runs WHERE status='running'")
                    .get() ?? '',
            ).includes(needle),
        )
        .toBe(true);

it('sends only whole messages and tool calls of a turn in progress', () => {
    const events = [
        { type: EventType.RUN_STARTED, threadId: 't', runId: 'r' },
        { type: EventType.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'Hel' },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'lo' },
        { type: EventType.TEXT_MESSAGE_END, messageId: 'm1' },
        {
            type: EventType.TOOL_CALL_START,
            toolCallId: 'c1',
            toolCallName: 'x',
            parentMessageId: 'm1',
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: 'c1', delta: '{"a"' },
    ] as unknown as BaseEvent[];
    const settled = settledEvents(events, false);
    expect(settled.map((event) => event.type)).toEqual([
        EventType.RUN_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
    ]);
    expect(text(settled, 'm1')).toBe('Hello');
    // Once the run is final, everything goes.
    expect(settledEvents(events, true)).toHaveLength(6);
});

it('another runtime sees the turn as running and refuses a second one on its thread', async () => {
    const { a, b } = pair();
    const agent = new StepAgent();
    start(a, agent, 'run-a').subscribe();
    await flushed(a, 'Half');
    expect(await b.isRunning({ threadId: 'thread' })).toBe(true);
    expect(() => start(b, new StepAgent(), 'run-b')).toThrow('Thread already running');
    // The same refusal, with its code (CB-357), whichever runtime holds the turn.
    expect(() => start(b, new StepAgent(), 'run-b')).toThrow(ThreadRunningError);
    agent.finish();
    await expect.poll(() => b.isRunning({ threadId: 'thread' })).toBe(false);
    // Free again: the next turn may run on either.
    const next = new StepAgent();
    const events = lastValueFrom(start(b, next, 'run-b2').pipe(toArray()));
    await flushed(b, 'Half');
    next.finish();
    expect((await events).at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

it('streams a turn another runtime runs to a tab that reconnects here', async () => {
    const { a, b } = pair();
    const agent = new StepAgent();
    const owner = lastValueFrom(start(a, agent, 'run-a').pipe(toArray()));
    await flushed(a, 'Half');
    const received: BaseEvent[] = [];
    let completed = false;
    b.connect({ threadId: 'thread' }).subscribe({
        next: (event) => received.push(event),
        complete: () => (completed = true),
    });
    // The whole first message comes; the half-written second waits.
    await expect.poll(() => text(received, 'first')).toBe('One whole.');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received.some((event) => JSON.stringify(event).includes('Half'))).toBe(false);
    expect(completed).toBe(false);
    agent.finish();
    await expect.poll(() => completed).toBe(true);
    expect(text(received, 'second')).toBe('Half and done.');
    expect(received[0]?.type).toBe(EventType.RUN_STARTED);
    expect(received.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    // Each message once, as the owner's own stream had it.
    const ids = received
        .filter((event) => event.type === EventType.TEXT_MESSAGE_START)
        .map((event) => (event as unknown as { messageId: string }).messageId);
    expect(ids).toEqual(['first', 'second']);
    const own = await owner;
    expect(text(own, 'second')).toBe(text(received, 'second'));
});

it('a stop that reaches the other runtime stops the turn where it runs', async () => {
    const { a, b } = pair();
    const agent = new StepAgent();
    const owner = lastValueFrom(start(a, agent, 'run-a').pipe(toArray()));
    await flushed(a, 'Half');
    // Not that run, or nothing running: nothing to stop.
    expect(await b.stop({ threadId: 'thread', runId: 'another' })).toBe(false);
    expect(await b.stop({ threadId: 'elsewhere' })).toBe(false);
    expect(await b.stop({ threadId: 'thread', runId: 'run-a' })).toBe(true);
    const events = await owner;
    expect(agent.aborted).toBe(true);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(a.recentRuns().find((run) => run.runId === 'run-a')?.status).toBe('stopped');
    // Consumed: the signal doesn't linger for a later run.
    expect(
        (
            a as unknown as {
                db: { prepare(sql: string): { get(): { n: number } } };
            }
        ).db
            .prepare('SELECT COUNT(*) n FROM runtime_signals')
            .get().n,
    ).toBe(0);
});

it('a follower stream ends when the owner dies and its turn is recovered', async () => {
    const { a, b } = pair(300);
    const agent = new StepAgent();
    start(a, agent, 'run-a').subscribe({ error: () => undefined });
    await flushed(a, 'Half');
    const received: BaseEvent[] = [];
    let completed = false;
    b.connect({ threadId: 'thread' }).subscribe({
        next: (event) => received.push(event),
        complete: () => (completed = true),
    });
    await expect.poll(() => text(received, 'first')).toBe('One whole.');
    // The owner's process goes (its leases end with it).
    a.close();
    b.recoverOrphans();
    await expect.poll(() => completed, { timeout: 5000 }).toBe(true);
    expect(b.recentRuns().find((run) => run.runId === 'run-a')?.status).toBe('interrupted');
    expect(received.at(-1)?.type).toBe(EventType.RUN_ERROR);
    // What it had written of the second message is kept.
    expect(text(received, 'second')).toBe('Half');
});

it('routes a job run’s stop to the runtime that owns it, once', async () => {
    const db = testDatabase();
    let now = 1000;
    const clock = { heartbeat: false, leaseMs: 100, now: () => now };
    const owner = new RuntimeSession(clock),
        other = new RuntimeSession(clock);
    const a = sqliteSchedules(db, owner),
        b = sqliteSchedules(db, other);
    cleanup.push(() => {
        owner.detachSync(db);
        other.detachSync(db);
        db.close();
    });
    a.ownership.claim('job', 'run-1', 'job:x', (lease) => lease);
    // The other task of a deploy gets the pause of its long run.
    const service = Object.assign(Object.create(JobService.prototype) as object, {
        schedules: b,
        active: new Map(),
        log: () => undefined,
    }) as unknown as Pick<JobService, 'stopRun'>;
    service.stopRun('run-1', 'Paused by its owner.');
    await expect.poll(() => a.ownership.hasSignal('job', 'run-1', 'stop')).toBe(true);
    // Only the owner acts on it, and only once.
    expect(await a.ownership.takeSignal('job', 'run-1', 'stop')).toBe('Paused by its owner.');
    expect(await a.ownership.takeSignal('job', 'run-1', 'stop')).toBeUndefined();
    // Work this runtime owns, or nobody live owns, isn't signaled.
    expect(await a.ownership.signal('job', 'run-1', 'stop')).toBe(false);
    expect(await b.ownership.signal('job', 'missing', 'stop')).toBe(false);
    now += 101;
    expect(await b.ownership.signal('job', 'run-1', 'stop')).toBe(false);
});

it('prunes what dead runtimes left a day later, never a live one’s or a lease', async () => {
    const db = testDatabase();
    let now = 1000;
    const clock = { heartbeat: false, leaseMs: 100, now: () => now };
    const dead = new RuntimeSession(clock),
        live = new RuntimeSession({ ...clock, leaseMs: 10 * RUNTIME_HISTORY_MS });
    const d = dead.attach(db),
        l = live.attach(db);
    cleanup.push(() => {
        live.detachSync(db);
        db.close();
    });
    d.claim('turn', 'old-turn', 'thread:x', (lease) => lease);
    l.claim('turn', 'live-turn', 'thread:y', (lease) => lease);
    dead.detachSync(db);
    const count = (table: string) => Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n);
    // Not yet a day: kept for diagnosis.
    await l.prune();
    expect(count('runtime_instances')).toBe(2);
    expect(count('runtime_work')).toBe(2);
    now += RUNTIME_HISTORY_MS + 1;
    await l.prune();
    expect(count('runtime_work')).toBe(1);
    expect(l.workAlive('turn', 'live-turn')).toBe(true);
    // Its lease row stays (epochs only grow), so its identity does too.
    expect(count('runtime_leases')).toBe(2);
    expect(count('runtime_instances')).toBe(2);
    // Once another epoch took its lease, the identity goes as well.
    l.claim('turn', 'next-turn', 'thread:x', (lease) => lease);
    await l.prune();
    expect(count('runtime_instances')).toBe(1);
    expect(db.prepare("SELECT epoch FROM runtime_leases WHERE resource='thread:x'").get()?.epoch).toBe(2);
});
