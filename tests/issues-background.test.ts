// The issues module's leader work on Effect: one ordered cleanup registered
// before any start step, a `closing` flag and a one-permit lock, and cleanup
// that covers an interrupted or partial start. The background runs against a
// real Board on a migrated database; auto-triage and app deliveries are
// recorded fakes, except in the last tests, which drive a real Platform and
// a real pending delivery.
import { setTimeout as sleep } from 'node:timers/promises';

import { Exit, Fiber, Layer, ManagedRuntime, Scope } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import {
    AutoTriageControl,
    Board,
    Deliveries,
    IssuesBackground,
    type AutoTriageControlShape,
    type DeliveriesShape,
} from '../src/server/issues/contract.js';
import { IssuesBackgroundLive } from '../src/server/issues/layer.js';
import { issuesLeadership } from '../src/server/issues/leadership.js';
import { issuesModule } from '../src/server/issues/module.js';
import { sqliteBoard, type SqliteBoard } from '../src/server/issues/services.js';
import { peopleSync } from '../src/server/workspace/layer.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

const source = { sourceKind: 'person' as const, sourceId: 'alice', threadId: null, causeId: null };

/** A promise and the function that settles it. */
function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

/** Records when each listener is added and removed, in one shared log. */
function recordListeners(board: SqliteBoard, events: string[]) {
    const onNotice = board.requests.onNotice.bind(board.requests);
    vi.spyOn(board.requests, 'onNotice').mockImplementation((listener) => {
        events.push('notice listener on');
        const off = onNotice(listener);
        return () => {
            events.push('notice listener off');
            off();
        };
    });
    const onStatusChange = board.issues.onStatusChange.bind(board.issues);
    const status = vi.spyOn(board.issues, 'onStatusChange').mockImplementation((listener) => {
        events.push('status listener on');
        const off = onStatusChange(listener);
        return () => {
            events.push('status listener off');
            off();
        };
    });
    const replay = board.watches.replay.bind(board.watches);
    const runs = vi.spyOn(board.watches, 'replay').mockImplementation((now) => {
        events.push('run');
        return replay(now);
    });
    return { status, runs };
}

/** The real background layer over a real Board, with recorded fakes for the rest. */
function harness(
    options: {
        triageStart?: () => Promise<void>;
        deliveriesStop?: () => Promise<unknown>;
    } = {},
) {
    const workspace = new WorkspaceStore(testDatabase());
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'member' });
    const board = sqliteBoard(workspace.db, peopleSync(workspace));
    const events: string[] = [];
    const logs: string[] = [];
    const spies = recordListeners(board, events);
    const triage: AutoTriageControlShape = {
        start: vi.fn(async () => {
            events.push('autoTriage.start');
            await options.triageStart?.();
            events.push('autoTriage started');
        }),
        stop: vi.fn(() => void events.push('autoTriage.stop')),
        recover: vi.fn(async () => {}),
    };
    const deliveries: DeliveriesShape = {
        resume: vi.fn(() => void events.push('deliveries.resume')),
        stop: vi.fn(async () => {
            events.push('deliveries.stop');
            await options.deliveriesStop?.();
        }),
        queueFromApp: vi.fn(async () => {}),
    };
    const runtime = ManagedRuntime.make(
        IssuesBackgroundLive((line) => logs.push(line)).pipe(
            Layer.provide(
                Layer.mergeAll(
                    Layer.succeed(Board, board),
                    Layer.succeed(AutoTriageControl, triage),
                    Layer.succeed(Deliveries, deliveries),
                ),
            ),
        ),
    );
    const leadership = issuesLeadership(() => runtime);
    cleanup.push(async () => {
        await runtime.dispose();
        workspace.close();
    });
    return { workspace, board, events, logs, triage, deliveries, leadership, runtime, ...spies };
}

/** Lets `nextTurn()` and the promise jobs behind it run. */
const settle = () => sleep(5);

it('starts in today’s order, then stops in today’s order', async () => {
    const h = harness();
    await h.leadership.start();
    await vi.waitFor(() => expect(h.events).toContain('run'));
    expect(h.events).toEqual([
        'autoTriage.start',
        'autoTriage started',
        'notice listener on',
        'deliveries.resume',
        'status listener on',
        // The replay: one run at start.
        'run',
    ]);
    expect(h.triage.start).toHaveBeenCalledWith({ recover: false });
    h.events.length = 0;
    expect(await h.leadership.stop()).toEqual({ autoTriageStopped: true, deliveriesStopped: true });
    expect(h.events).toEqual(['autoTriage.stop', 'notice listener off', 'status listener off', 'deliveries.stop']);
});

it('stops during a pending auto-triage start: the step finishes, then only it is stopped', async () => {
    const pending = deferred();
    const h = harness({ triageStart: () => pending.promise });
    const starting = h.leadership.start();
    await vi.waitFor(() => expect(h.events).toEqual(['autoTriage.start']));
    let stopped = false;
    const stopping = h.leadership.stop().then((report) => {
        stopped = true;
        return report;
    });
    await sleep(20);
    // The step in progress isn't cut short: stop waits for it.
    expect(stopped).toBe(false);
    pending.resolve();
    // An interrupted start is not a failure.
    await expect(starting).resolves.toBeUndefined();
    expect(await stopping).toEqual({ autoTriageStopped: true, deliveriesStopped: false });
    expect(h.events).toEqual(['autoTriage.start', 'autoTriage started', 'autoTriage.stop']);
    expect(h.deliveries.resume).not.toHaveBeenCalled();
    expect(h.deliveries.stop).not.toHaveBeenCalled();
    // Nothing listens and nothing runs.
    const issue = await h.board.issues.create({ title: 'After the stop' }, 'alice');
    await h.board.issues.update(issue.number, { status: 'done' }, 'alice');
    await h.leadership.tick();
    await settle();
    expect(h.runs).not.toHaveBeenCalled();
});

it('releases exactly what started when a later start step fails, and rethrows the original error', async () => {
    const h = harness();
    const boom = new Error('status listener failed');
    h.status.mockImplementation(() => {
        h.events.push('status listener throws');
        throw boom;
    });
    await expect(h.leadership.start()).rejects.toBe(boom);
    expect(h.events).toEqual([
        'autoTriage.start',
        'autoTriage started',
        'notice listener on',
        'deliveries.resume',
        'status listener throws',
        // The cleanup, at once, in today's stop order, for what started.
        'autoTriage.stop',
        'notice listener off',
        'deliveries.stop',
    ]);
    // The gate closed too: a tick starts no run, and nothing replayed.
    await h.leadership.tick();
    await settle();
    expect(h.runs).not.toHaveBeenCalled();
    // The module's stop that follows doesn't stop them a second time.
    expect(await h.leadership.stop()).toEqual({ autoTriageStopped: true, deliveriesStopped: true });
    expect(h.deliveries.stop).toHaveBeenCalledTimes(1);
});

it('logs a failing run and runs again on the next trigger', async () => {
    const h = harness();
    await h.leadership.start();
    await vi.waitFor(() => expect(h.runs).toHaveBeenCalledTimes(1));
    await settle();
    h.runs.mockRejectedValueOnce(new Error('replay failed'));
    const issue = await h.board.issues.create({ title: 'Watched' }, 'alice');
    await h.board.issues.update(issue.number, { status: 'done' }, 'alice');
    await vi.waitFor(() => expect(h.logs).toEqual(['Issue subscription notification work failed.']));
    expect(h.runs).toHaveBeenCalledTimes(2);
    // The loop goes on: the 30-s tick runs again, and succeeds.
    await h.leadership.tick();
    expect(h.runs).toHaveBeenCalledTimes(3);
    expect(h.logs).toHaveLength(1);
    await h.leadership.stop();
});

it('makes one run of a tick and a status change at the same moment', async () => {
    const h = harness();
    await h.leadership.start();
    await vi.waitFor(() => expect(h.runs).toHaveBeenCalledTimes(1));
    await settle();
    const issue = await h.board.issues.create({ title: 'Watched' }, 'alice');
    const update = h.board.issues.update(issue.number, { status: 'done' }, 'alice');
    const tick = h.leadership.tick();
    await update;
    await tick;
    await settle();
    expect(h.runs).toHaveBeenCalledTimes(2);
    await h.leadership.stop();
});

it('replays once at start, and not before it', async () => {
    const h = harness();
    await h.leadership.tick();
    await settle();
    expect(h.runs).not.toHaveBeenCalled();
    await h.leadership.start();
    await settle();
    expect(h.runs).toHaveBeenCalledTimes(1);
    await h.leadership.stop();
});

it('runs today’s stop steps on a stop without a start', async () => {
    const h = harness();
    expect(await h.leadership.stop()).toEqual({ autoTriageStopped: false, deliveriesStopped: false });
    expect(h.events).toEqual([]);
});

/** Whatever started was stopped, and no trigger starts a run. */
async function nothingLeftRunning(h: ReturnType<typeof harness>) {
    const count = (event: string) => h.events.filter((one) => one === event).length;
    expect(count('notice listener on')).toBe(count('notice listener off'));
    expect(count('status listener on')).toBe(count('status listener off'));
    expect(count('autoTriage.start')).toBe(count('autoTriage.stop'));
    expect(count('deliveries.resume')).toBe(count('deliveries.stop'));
    const runs = h.runs.mock.calls.length;
    const issue = await h.board.issues.create({ title: 'After the stop' }, 'alice');
    await h.board.issues.update(issue.number, { status: 'done' }, 'alice');
    await h.leadership.tick();
    await settle();
    expect(h.runs).toHaveBeenCalledTimes(runs);
}

it('stops a start called just before it, with no await between, before the runtime is built', async () => {
    const h = harness();
    const starting = h.leadership.start();
    const stopping = h.leadership.stop();
    await expect(starting).resolves.toBeUndefined();
    const report = await stopping;
    await settle();
    await nothingLeftRunning(h);
    // What the stop reports matches what this term's cleanup did.
    expect(report).toEqual({
        autoTriageStopped: h.events.includes('autoTriage.stop'),
        deliveriesStopped: h.events.includes('deliveries.stop'),
    });
});

it('stops a second start called just before it, while the first term is still being cleaned up', async () => {
    const h = harness();
    await h.leadership.start();
    await settle();
    const restarting = h.leadership.start();
    const stopping = h.leadership.stop();
    await expect(restarting).resolves.toBeUndefined();
    // The second term never acquired its scope: nothing of it to stop.
    expect(await stopping).toEqual({ autoTriageStopped: false, deliveriesStopped: false });
    await settle();
    await nothingLeftRunning(h);
});

it('cleans up IssuesBackground.lead when its scope closes right after it is forked', async () => {
    const h = harness();
    await h.runtime.context();
    const scope = Scope.makeUnsafe();
    const stopped = { autoTriage: false, deliveries: false, cleaned: false };
    const fiber = h.runtime.runFork(
        IssuesBackground.use((background) => Scope.provide(background.lead(stopped), scope)),
    );
    await h.runtime.runPromise(Scope.close(scope, Exit.void));
    await h.runtime.runPromise(Fiber.await(fiber));
    await settle();
    expect(stopped.cleaned).toBe(true);
    await nothingLeftRunning(h);
});

it('closes a leadership term still open when the runtime is disposed', async () => {
    const h = harness();
    await h.leadership.start();
    await settle();
    h.events.length = 0;
    await h.runtime.dispose();
    expect(h.events).toEqual(['autoTriage.stop', 'notice listener off', 'status listener off', 'deliveries.stop']);
    // A stop afterwards finds the term's cleanup done, and runs nothing twice.
    expect(await h.leadership.stop()).toEqual({ autoTriageStopped: true, deliveriesStopped: true });
    expect(h.deliveries.stop).toHaveBeenCalledTimes(1);
});

it('stops auto-triage started just before, with no await between: no listener is left', async () => {
    const f = await platformWithPendingSends();
    const { issues } = f.platform.board;
    const onCreated = issues.onCreated.bind(issues);
    let listening = 0;
    vi.spyOn(issues, 'onCreated').mockImplementation((listener) => {
        listening++;
        const off = onCreated(listener);
        return () => {
            listening--;
            off();
        };
    });
    // With recovery (the default), start awaits before it subscribes.
    const starting = f.platform.autoTriage.start();
    f.platform.autoTriage.stop();
    await starting;
    expect(listening).toBe(0);
    // Without recovery (the issues module's), start subscribes at once.
    const quick = f.platform.autoTriage.start({ recover: false });
    f.platform.autoTriage.stop();
    await quick;
    expect(listening).toBe(0);
});

/** A real Platform with only the issues module, and a channel whose sends wait. */
async function platformWithPendingSends() {
    const { workspace, platform, dispose } = await makeTestRuntime({
        config: {
            baseUrl: '',
            apiKey: '',
            model: '',
            runtimeUrl: '',
            appOrigin: 'https://app.example.invalid',
        },
        modules: [issuesModule],
    });
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'member' });
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const send = vi.fn(async () => {
        order.push('send started');
        await new Promise<void>((resolve) => releases.push(resolve));
        order.push('send finished');
        return { outcome: 'sent' as const };
    });
    platform.notifications.register({
        id: 'fixture',
        label: 'Fixture',
        targets: (userId) => [{ id: 'target-' + userId, label: 'Fixture' }],
        send,
    });
    workspace.setPreferences('alice', { notifications: { fixture: { enabled: true, content: 'message' } } });
    let stopped = false;
    const stop = async () => {
        if (!stopped) {
            stopped = true;
            await platform.stop();
        }
    };
    cleanup.push(async () => {
        releases.forEach((release) => release());
        await stop();
        await dispose();
    });
    return { platform, workspace, send, order, releases, stop };
}

it('stops during a run in flight: waits for it, and a trigger after cleanup begins starts nothing', async () => {
    const f = await platformWithPendingSends();
    const { board } = f.platform;
    await f.platform.start();
    const watched = await board.issues.create({ title: 'Watched' }, 'alice');
    const other = await board.issues.create({ title: 'Other' }, 'alice');
    await board.watches.create('alice', { issues: [String(watched.number)] }, source);
    await sleep(10);
    // Hold the next run in flight, outside any unit of work.
    const held = deferred();
    const replay = board.watches.replay.bind(board.watches);
    const runs = vi.spyOn(board.watches, 'replay').mockImplementation(async (now) => {
        f.order.push('run');
        await held.promise;
        return replay(now);
    });
    const flush = board.watches.flush.bind(board.watches);
    vi.spyOn(board.watches, 'flush').mockImplementation(async (notifications, now) => {
        await flush(notifications, now);
        f.order.push('run finished');
    });
    await board.issues.update(watched.number, { status: 'done' }, 'alice');
    await vi.waitFor(() => expect(runs).toHaveBeenCalledTimes(1));

    let stopped = false;
    const stopping = f.stop().then(() => {
        stopped = true;
        f.order.push('stop returned');
    });
    await sleep(50);
    expect(stopped).toBe(false);
    // The listener is gone and the gate closed: no new run.
    await board.issues.update(other.number, { status: 'done' }, 'alice');
    await f.platform.issuesLeadership.tick();
    await sleep(10);
    expect(runs).toHaveBeenCalledTimes(1);
    held.resolve();
    await stopping;
    expect(f.order).toEqual(['run', 'run finished', 'stop returned']);
    expect(runs).toHaveBeenCalledTimes(1);
    // The run committed its claim and in-app notice before the stop returned.
    expect((await board.watches.list('alice')).items).toMatchObject([{ state: 'triggered' }]);
});

it('stops during a real pending delivery: waits for the send, and a trigger then starts nothing', async () => {
    const f = await platformWithPendingSends();
    const { board } = f.platform;
    await f.platform.start();
    const watched = await board.issues.create({ title: 'Watched' }, 'alice');
    const other = await board.issues.create({ title: 'Other' }, 'alice');
    await board.watches.create('alice', { issues: [String(watched.number)] }, source);
    await sleep(10);
    const runs = vi.spyOn(board.watches, 'replay');
    await board.issues.update(watched.number, { status: 'done' }, 'alice');
    // The external send is in flight in the app delivery queue, and waits.
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    const before = runs.mock.calls.length;

    let stopped = false;
    const stopping = f.stop().then(() => {
        stopped = true;
        f.order.push('stop returned');
    });
    await sleep(50);
    // Under the app deliveries' drain limit (250 ms): stop waits for the send.
    expect(stopped).toBe(false);
    await board.issues.update(other.number, { status: 'done' }, 'alice');
    await f.platform.issuesLeadership.tick();
    await sleep(10);
    expect(runs).toHaveBeenCalledTimes(before);
    f.releases.forEach((release) => release());
    await stopping;
    expect(f.order).toEqual(['send started', 'send finished', 'stop returned']);
    expect(f.send).toHaveBeenCalledTimes(1);
});

it('stops app deliveries and auto-triage on a platform stop without a start, as before', async () => {
    const f = await platformWithPendingSends();
    const triage = vi.spyOn(f.platform.autoTriage, 'stop');
    const deliveries = vi.spyOn(f.platform.notifications, 'stopAppDeliveries');
    await f.stop();
    expect(triage).toHaveBeenCalled();
    expect(deliveries).toHaveBeenCalledTimes(1);
});
