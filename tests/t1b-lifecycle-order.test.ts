// The leader's lifecycle, pinned for the PRs that move it off `Platform`:
// what `lead()`, `succeed()`, `stopBackground()` and `stop()` call, in
// order, and how a module that fails to release or stop is handled.
import { afterEach, expect, it, vi } from 'vitest';

import type { BackupService } from '../src/server/backup/backup-service.js';
import type { ServerModule } from '../src/server/modules/contract.js';

import { makeTestRuntime, type TestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.useRealTimers();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

/** A module that records its hooks; `fail` names the hooks that throw. */
function recording(events: string[], id: string, fail: Array<'release' | 'stop'> = [], tick = false): ServerModule {
    const hook = (name: string) => () => {
        events.push(`module ${id} ${name}`);
        if ((fail as string[]).includes(name)) {
            throw new Error(`${id} failed to ${name}`);
        }
    };
    return {
        id,
        start: hook('start'),
        succeed: hook('succeed'),
        release: hook('release'),
        stop: hook('stop'),
        ...(tick ? { tick: { everyMs: 25 * 60_000, run: hook('tick') } } : {}),
    };
}

/**
 * The runtime over `modules`, with a data key (for the hourly re-seal), a
 * fake backups service, and a spy recording each service call the
 * lifecycle makes. Each spy calls the real method.
 */
async function leader(modules: readonly ServerModule[], events: string[]) {
    const built = await makeTestRuntime({
        modules,
        config: { dataKeys: { current: Buffer.alloc(32, 7) } },
    });
    // `stop()` throws when a module fails to stop; the test checks that.
    cleanup.push(() => built.dispose().catch(() => undefined));
    const { platform } = built;
    const backups = {
        start: () => events.push('backups start'),
        stop: () => events.push('backups stop'),
        status: () => undefined,
        sealStates: () => ({ current: 0, previous: 0, legacy: 0, unknown: 0 }),
    } as unknown as BackupService;
    platform.useBackups(backups);
    const spy = <T extends object>(name: string, target: T, method: keyof T & string) => {
        const original = (target[method] as (...args: unknown[]) => unknown).bind(target);
        vi.spyOn(target as Record<string, (...args: unknown[]) => unknown>, method).mockImplementation(
            (...args: unknown[]) => {
                events.push(name);
                return original(...args);
            },
        );
    };
    spy('goals reconcile', platform.goals, 'reconcile');
    // The re-seal's first store: one per re-seal run.
    spy('reseal', platform.inference.store, 'reseal');
    spy('continuations resume', platform.continuations, 'resume');
    spy('orchestrator resume', platform.orchestrator, 'resume');
    spy('steering resume', platform.steering, 'resume');
    spy('dictation closeAll', platform.dictationStreams, 'closeAll');
    spy('roomStreams stop', platform.roomStreams, 'stop');
    spy('continuations stop', platform.continuations, 'stop');
    spy('steering stop', platform.steering, 'stop');
    spy('orchestrator stop', platform.orchestrator, 'stop');
    spy('actors stop', platform.actors, 'stop');
    spy('titles stop', platform.titles, 'stop');
    spy('chatNames stop', platform.chatNames, 'stop');
    spy('runner close', platform.runner, 'close');
    return built;
}

/** Lets the background work `lead()` starts without awaiting (the first re-seal) run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Waits until no re-seal runs (one asked for while another runs is that one). */
async function resealed(platform: TestRuntime['platform']) {
    for (let turn = 0; turn < 1000; turn++) {
        if (!(await platform.dataKeyStatus()).reseal?.running) {
            return;
        }
        await settle();
    }
    throw new Error('The re-seal is still running.');
}

/** Ticks and the hourly re-seal: intervals only, so the runtime's own timeouts stay real. */
const fakeIntervals = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

it('leads, succeeds, hands over and stops in this order', async () => {
    const events: string[] = [];
    const { platform } = await leader(
        [recording(events, 'a', [], true), recording(events, 'b'), recording(events, 'c')],
        events,
    );
    fakeIntervals();
    await platform.lead();
    await resealed(platform);
    // The module tick and the hourly re-seal.
    expect(vi.getTimerCount()).toBe(2);
    await platform.succeed();
    await settle();
    expect(events.splice(0)).toMatchInlineSnapshot(`
      [
        "goals reconcile",
        "module a start",
        "module b start",
        "module c start",
        "reseal",
        "backups start",
        "module a succeed",
        "module b succeed",
        "module c succeed",
        "continuations resume",
        "orchestrator resume",
        "steering resume",
      ]
    `);
    // An hour: the module's tick twice (every 25 minutes), then the re-seal.
    vi.advanceTimersByTime(60 * 60_000);
    await resealed(platform);
    expect(events.splice(0)).toMatchInlineSnapshot(`
      [
        "module a tick",
        "module a tick",
        "reseal",
      ]
    `);
    await platform.stopBackground();
    expect(vi.getTimerCount()).toBe(0);
    expect(events.splice(0)).toMatchInlineSnapshot(`
      [
        "backups stop",
        "module c release",
        "module b release",
        "module a release",
      ]
    `);
    await platform.stop();
    expect(events.splice(0)).toMatchInlineSnapshot(`
      [
        "dictation closeAll",
        "roomStreams stop",
        "continuations stop",
        "steering stop",
        "orchestrator stop",
        "actors stop",
        "backups stop",
        "titles stop",
        "chatNames stop",
        "module c stop",
        "module b stop",
        "module a stop",
        "runner close",
      ]
    `);
});

it('stops every module when some fail to release and stop, reports the release, and rethrows the first stop failure', async () => {
    const events: string[] = [];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { platform } = await leader(
        [recording(events, 'a', ['stop']), recording(events, 'b', ['release']), recording(events, 'c', ['stop'])],
        events,
    );
    fakeIntervals();
    await platform.start();
    await settle();
    events.length = 0;
    await expect(platform.stop()).rejects.toThrow('c failed to stop');
    expect(events).toMatchInlineSnapshot(`
      [
        "backups stop",
        "module c release",
        "module b release",
        "module a release",
        "dictation closeAll",
        "roomStreams stop",
        "continuations stop",
        "steering stop",
        "orchestrator stop",
        "actors stop",
        "backups stop",
        "titles stop",
        "chatNames stop",
        "module c stop",
        "module b stop",
        "module a stop",
        "runner close",
      ]
    `);
    expect(errors.mock.calls).toMatchInlineSnapshot(`
      [
        [
          "Stopping the leader work failed: Error",
        ],
      ]
    `);
});

it('hands over once however often it is asked, and again after it leads again', async () => {
    const events: string[] = [];
    const { platform } = await leader([recording(events, 'a', [], true)], events);
    fakeIntervals();
    await platform.start();
    await settle();
    events.length = 0;
    const first = platform.stopBackground();
    expect(platform.stopBackground()).toBe(first);
    await first;
    await platform.stopBackground();
    expect(events.splice(0)).toEqual(['backups stop', 'module a release']);
    // Leading again resets the hand-over: the next one runs again.
    await platform.lead();
    await settle();
    expect(vi.getTimerCount()).toBe(2);
    events.length = 0;
    await platform.stopBackground();
    expect(events.splice(0)).toEqual(['backups stop', 'module a release']);
    expect(vi.getTimerCount()).toBe(0);
});
