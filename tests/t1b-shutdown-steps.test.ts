// The shutdown's composition (`shutdownSteps`, composition/lifecycle),
// pinned for the PRs that move `Platform`'s drain and stop: the order of its
// steps over the platform, and its log lines and failure labels.
// createShutdown's own timing is shutdown.test.ts's.
import type { Server } from 'node:http';

import { Context } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { LeaderWork } from '../src/server/composition/app/work.js';
import { shutdownSteps } from '../src/server/composition/lifecycle/index.js';
import type { AppRuntime } from '../src/server/main.js';
import type { LeaderLease } from '../src/server/runtime/background.js';
import type { TelegramChannel } from '../src/server/telegram/telegram-channel.js';
import type { Runner } from '../src/server/turns/runner.js';

import { makeTestRuntime, type TestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    // The real methods first: a stop made to fail fails only the shutdown.
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

interface Fakes {
    /** The task runner's turns in progress, read at each poll. */
    running?: () => number;
    /** What the platform's stop throws, after the real one ran. */
    stopFails?: Error;
    /** What the HTTP server's close reports. */
    closeFails?: Error;
}

/**
 * The shutdown over a test runtime's platform, stores and connection, with
 * fakes for what the process entry makes (the task runner, the leader
 * lease, the HTTP server, the listeners `startFeatures` started and the
 * app runtime's dispose), each recording into `events`, as do spies on the
 * platform's drain and stop.
 */
async function shutdownOver(built: TestRuntime, events: string[], fakes: Fakes = {}) {
    const { platform, store, workspace, db, config } = built;
    const record =
        (name: string, result?: unknown) =>
        (..._: unknown[]) => {
            events.push(name);
            return result;
        };
    const spy = <T extends object>(name: string, target: T, method: keyof T & string, after?: () => void) => {
        const original = (target[method] as (...args: unknown[]) => unknown).bind(target);
        vi.spyOn(target as Record<string, (...args: unknown[]) => unknown>, method).mockImplementation(
            (...args: unknown[]) => {
                events.push(name);
                const result = original(...args);
                if (after) {
                    return Promise.resolve(result).then(after);
                }
                return result;
            },
        );
    };
    platform.useTelegram({
        status: 'online',
        handling: 0,
        drain: record('telegram drain', Promise.resolve()),
        stop: record('telegram stop', Promise.resolve()),
    } as unknown as TelegramChannel);
    // The leader work's drain and stop, which the shutdown calls
    // (`Platform`'s drain and stop delegate to the same service).
    const work = Context.get(await built.runtime.context(), LeaderWork);
    spy('platform drain', work, 'drain');
    spy('jobs drain', platform.jobs, 'drain');
    spy('actors drain', platform.actors, 'drain');
    spy('dictation closeAll', platform.dictationStreams, 'closeAll');
    spy('platform stop', work, 'stop', () => {
        events.push('platform stopped');
        if (fakes.stopFails) {
            throw fakes.stopFails;
        }
    });
    spy('store close', store, 'close');
    spy('workspace close', workspace, 'close');
    spy('connection close', db, 'close');
    const intervals = vi.spyOn(globalThis, 'clearInterval');
    const pruning = setInterval(() => undefined, 60_000);
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
        events.push(`exit ${code}`);
    }) as typeof process.exit);
    const runner = {
        get running() {
            return fakes.running?.() ?? 0;
        },
        drain: record('runner drain'),
        stop: record('runner stop'),
    } as unknown as Runner;
    const leader = { stop: record('leader stop', Promise.resolve()) } as unknown as LeaderLease;
    const server = {
        close: (done: (error?: Error) => void) => {
            events.push('server close');
            done(fakes.closeFails);
        },
        closeIdleConnections: () => undefined,
    } as unknown as Server;
    const appRuntime = { dispose: record('appRuntime dispose', Promise.resolve()) } as unknown as AppRuntime;
    const started = {
        gateway: { close: record('gateway close', Promise.resolve()) },
        appsInternal: { close: record('appsInternal close', Promise.resolve()) },
    } as unknown as Parameters<typeof shutdownSteps>[0]['started'];
    // The platform both as today's `platform` and as the edge a later change
    // hands the steps (`{ platform, services, runtime }`): the call takes either
    // shape, so this test pins the behavior, not the parameter names.
    const edge = { platform, services: await built.runtime.context(), runtime: built.runtime };
    const steps = {
        env: { SHUTDOWN_DRAIN_MS: '5000' },
        shutdownForce: false,
        config,
        store,
        workspace,
        connection: db,
        platform,
        edge,
        appRuntime,
        runner,
        leader,
        pruning,
        started,
        server,
    };
    const shutdown = shutdownSteps(steps as unknown as Parameters<typeof shutdownSteps>[0]);
    return {
        shutdown,
        /** Whether the pruning interval was cleared. */
        pruningCleared: () => intervals.mock.calls.some(([timer]) => timer === pruning),
    };
}

/** What closes the server (`closeServer`), next to the platform's stop. */
const CLOSE_SERVER = new Set(['gateway close', 'appsInternal close', 'server close']);

/**
 * The shutdown's events in its phases: the drain (until the runner stops);
 * the platform's stop and the server's close, which run side by side, each
 * in its own order (live dictation closes in both: counted); then the
 * database.
 */
function phases(events: string[]) {
    const stopped = events.indexOf('runner stop');
    const closing = events.indexOf('store close');
    const both = events.slice(stopped + 1, closing);
    return {
        drain: events.slice(0, stopped + 1),
        stopPlatform: both.filter((event) => !CLOSE_SERVER.has(event) && event !== 'dictation closeAll'),
        closeServer: both.filter((event) => CLOSE_SERVER.has(event)),
        dictationCloses: both.filter((event) => event === 'dictation closeAll').length,
        close: events.slice(closing),
    };
}

it('drains, then stops the platform and closes the server, then the database', async () => {
    const built = await makeTestRuntime();
    cleanup.push(built.dispose);
    const events: string[] = [];
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let polls = 0;
    // A turn in progress for the first two polls: the drain waits for it.
    const { shutdown, pruningCleared } = await shutdownOver(built, events, { running: () => (polls++ < 2 ? 1 : 0) });
    await shutdown();
    expect(pruningCleared()).toBe(true);
    expect(phases(events)).toMatchInlineSnapshot(`
      {
        "close": [
          "store close",
          "workspace close",
          "connection close",
          "exit 0",
        ],
        "closeServer": [
          "gateway close",
          "appsInternal close",
          "server close",
        ],
        "dictationCloses": 2,
        "drain": [
          "leader stop",
          "runner drain",
          "platform drain",
          "jobs drain",
          "telegram drain",
          "actors drain",
          "dictation closeAll",
          "runner stop",
        ],
        "stopPlatform": [
          "leader stop",
          "platform stop",
          "telegram drain",
          "telegram stop",
          "platform stopped",
          "appRuntime dispose",
        ],
      }
    `);
    expect(logs.mock.calls.map(([line]) => String(line).replace(/drained in \d+ s/, 'drained in <n> s')))
        .toMatchInlineSnapshot(`
      [
        "Shutdown: draining, 1 in progress (up to 5 s).",
        "Shutdown: drained in <n> s.",
      ]
    `);
    expect(errors).not.toHaveBeenCalled();
});

it('still closes the server and the database when the platform fails to stop, under its labels', async () => {
    const built = await makeTestRuntime();
    cleanup.push(built.dispose);
    const events: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { shutdown } = await shutdownOver(built, events, {
        stopFails: new Error('platform'),
        closeFails: new Error('server'),
    });
    await shutdown();
    expect(phases(events)).toMatchInlineSnapshot(`
      {
        "close": [
          "store close",
          "workspace close",
          "connection close",
          "exit 1",
        ],
        "closeServer": [
          "gateway close",
          "appsInternal close",
          "server close",
        ],
        "dictationCloses": 2,
        "drain": [
          "leader stop",
          "runner drain",
          "platform drain",
          "jobs drain",
          "telegram drain",
          "actors drain",
          "dictation closeAll",
          "runner stop",
        ],
        "stopPlatform": [
          "leader stop",
          "platform stop",
          "telegram drain",
          "telegram stop",
          "platform stopped",
          "appRuntime dispose",
        ],
      }
    `);
    // Side by side: in either order.
    expect(errors.mock.calls.map(([line]) => String(line)).sort()).toMatchInlineSnapshot(`
      [
        "Closing HTTP server failed: Error",
        "Stopping Channels failed: Error",
      ]
    `);
});
