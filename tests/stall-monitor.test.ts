import { EventEmitter } from 'node:events';

import { expect, it } from 'vitest';

import {
    fatalErrorLine,
    requestLog,
    shutdownCause,
    startStallMonitor,
    trackedFetch,
} from '@socio/foundation/observability/stall-monitor';

import { capturePlan, inspectPort, shouldCapture } from '../src/server/healthcheck.js';

// CB-318: a blocked main thread leaves a log line with its length and what
// was running; the shutdown names its signal and the last stall; a fatal
// error is one structured line; the healthcheck captures the blocked stack
// at most every ten minutes, keeps five, and only through a known port.

function harness(activity?: (stall: { from: number; to: number }) => string | undefined) {
    let clock = 1_000_000;
    const lines: string[] = [];
    const monitor = startStallMonitor({
        thresholdMs: 1000,
        intervalMs: 250,
        histogram: false,
        activity,
        log: (line) => lines.push(line),
        now: () => clock,
        timers: { setInterval: () => 0, clearInterval: () => {} },
    });
    const tick = (ms: number) => {
        clock += ms;
        monitor.beat();
    };
    return { monitor, lines, tick, at: () => clock };
}

it('logs a stall past the threshold with what was running, and not the small delays', () => {
    const { monitor, lines, tick } = harness(() => '1 turn(s), 0 other run(s)');
    tick(250);
    tick(900); // 650 ms late: under the threshold
    expect(lines).toEqual([]);
    tick(105_250); // 105 s late
    expect(lines).toEqual(['Stall: the main thread was blocked for 105.0 s (running: 1 turn(s), 0 other run(s)).']);
    expect(monitor.recent()).toHaveLength(1);
    expect(monitor.recent()[0]).toMatchObject({
        ms: 105_000,
        activity: '1 turn(s), 0 other run(s)',
    });
});

it('keeps the worst recent stall, and survives an activity that throws', () => {
    const { monitor, lines, tick, at } = harness(() => {
        throw new Error('no');
    });
    tick(3250);
    tick(20_250);
    tick(5250);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Stall: the main thread was blocked for 3.0 s.');
    expect(monitor.worst()?.ms).toBe(20_000);
    expect(monitor.worst(at())?.ms).toBe(5000);
    expect(monitor.worst(at() + 1)).toBeUndefined();
});

it('asks what was running with the stall start and end', () => {
    const windows: { from: number; to: number }[] = [];
    const { lines, tick, at } = harness((stall) => {
        windows.push(stall);
        return 'requests GET /';
    });
    tick(250);
    const due = at() + 250;
    tick(3250); // due 250 ms after the last beat, ran 3 s late
    expect(windows).toEqual([{ from: due, to: at() }]);
    expect(lines).toEqual(['Stall: the main thread was blocked for 3.0 s (running: requests GET /).']);
});

it('names the requests open during a stall, and forgets old ones', () => {
    let clock = 0;
    const log = requestLog({ keepMs: 60_000, now: () => clock });
    const endBefore = log.begin('GET /healthz');
    clock = 100;
    endBefore();
    clock = 1000;
    const endPage = log.begin('GET /issues');
    const endState = log.begin('GET /api/state');
    clock = 1200;
    endState();
    // The page's loader blocks the loop until 4200; then the request ends.
    clock = 4200;
    endPage();
    const open = log.begin('GET /api/live');
    // The stall: 1100 to 4200. The health check ended before it.
    expect(log.during(1100, 4200)).toEqual(['GET /issues', 'GET /api/state', 'GET /api/live']);
    expect(log.during(5000, 6000)).toEqual(['GET /api/live']);
    clock = 70_000;
    open();
    expect(log.during(0, 70_000)).toEqual(['GET /api/live']);
});

it('holds a streamed response until its body is written, not until its headers', async () => {
    let clock = 0;
    const log = requestLog({ now: () => clock });
    const outgoing = new EventEmitter();
    const fetch = trackedFetch(log, async () => new Response('event: hello\n\n'));
    clock = 100;
    await fetch(new Request('http://127.0.0.1/api/events?token=secret'), { outgoing });
    // Headers resolved at 100; the stream then stalls the loop from 2000 to 5000.
    clock = 5000;
    expect(log.during(2000, 5000)).toEqual(['GET /api/events']);
    outgoing.emit('close');
    clock = 6000;
    expect(log.during(5500, 6000)).toEqual([]);
});

it('ends a request whose response was never written: a throw, a rejection, an error', async () => {
    let clock = 0;
    const log = requestLog({ now: () => clock });
    const thrown = trackedFetch(log, () => {
        throw new Error('boom');
    });
    expect(() => thrown(new Request('http://127.0.0.1/a'), { outgoing: new EventEmitter() })).toThrow('boom');
    const rejected = trackedFetch(log, () => Promise.reject(new Error('no')));
    await expect(rejected(new Request('http://127.0.0.1/b'), { outgoing: new EventEmitter() })).rejects.toThrow('no');
    const outgoing = new EventEmitter();
    const failed = trackedFetch(log, () => new Response('x'));
    await failed(new Request('http://127.0.0.1/c'), { outgoing });
    outgoing.emit('error');
    // In process, without a Node response: it ends with the promise.
    const inProcess = trackedFetch(log, async () => new Response('x'));
    await inProcess(new Request('http://127.0.0.1/d'), undefined);
    clock = 1000;
    expect(log.during(500, 1000)).toEqual([]);
});

it('lists at most five requests, then how many more', () => {
    const log = requestLog({ now: () => 0 });
    for (let i = 0; i < 8; i++) {
        log.begin(`GET /p${i}`);
    }
    expect(log.during(0, 0)).toEqual(['GET /p0', 'GET /p1', 'GET /p2', 'GET /p3', 'GET /p4', '+3 more']);
});

it('keeps a bounded list when requests never end', () => {
    let clock = 0;
    const log = requestLog({ max: 10, now: () => clock });
    for (let i = 0; i < 100; i++) {
        clock = i;
        log.begin(`GET /stream${i}`);
    }
    const all = log.during(0, 100, 1000);
    expect(all.length).toBeLessThanOrEqual(11);
    expect(all.at(-1)).toBe('GET /stream99');
});

it('names the signal, the uptime and the last stall when the shutdown starts', () => {
    const { monitor, tick, at } = harness(() => '1 turn(s), 0 other run(s)');
    tick(60_250);
    expect(shutdownCause('SIGTERM', 1680, monitor, at() + 15_000)).toBe(
        'Shutdown: SIGTERM after 28 min up; the main thread stalled 60.0 s 15 s ago (running: 1 turn(s), 0 other run(s)).',
    );
    expect(shutdownCause('SIGTERM', 90, monitor, at() + 11 * 60_000)).toBe(
        'Shutdown: SIGTERM after 2 min up; no stall in the last 10 min.',
    );
});

it('writes a fatal error as one JSON line', () => {
    const line = fatalErrorLine(new TypeError('boom'), 'uncaughtException');
    expect(line.startsWith('Fatal: {')).toBe(true);
    expect(JSON.parse(line.slice('Fatal: '.length))).toMatchObject({
        origin: 'uncaughtException',
        name: 'TypeError',
        message: 'boom',
    });
    expect(fatalErrorLine('plain', 'unhandledRejection')).toBe(
        'Fatal: {"origin":"unhandledRejection","message":"plain"}',
    );
});

it('captures at most every ten minutes and keeps the newest five', () => {
    const now = 10_000_000;
    const file = (minutesAgo: number) => ({
        path: `/r/stall-${minutesAgo}.json`,
        mtime: now - minutesAgo * 60_000,
    });
    // A fresh capture: no new one, five kept.
    const fresh = [1, 20, 40, 60, 80, 100].map(file);
    expect(capturePlan(fresh, now)).toEqual({
        capture: false,
        remove: [file(100)],
    });
    // None in ten minutes: a new one, and room made for it.
    const old = [20, 40, 60, 80, 100].map(file);
    expect(capturePlan(old, now)).toEqual({ capture: true, remove: [file(100)] });
    expect(capturePlan([], now)).toEqual({ capture: true, remove: [] });
});

it('reads the inspector port PID 1 was started with, and nothing else', () => {
    const proc =
        (cmdline: string, environ = '') =>
        (path: string) =>
            path.endsWith('cmdline') ? cmdline : environ;
    expect(inspectPort(proc('node\0dist/server/server/index.js', 'NODE_OPTIONS=--inspect-port=127.0.0.1:9339\0'))).toBe(
        9339,
    );
    expect(inspectPort(proc('node\0--inspect-port=9400\0index.js'))).toBe(9400);
    // No port: SIGUSR1 would open the default one; no capture.
    expect(inspectPort(proc('node\0dist/server/server/index.js'))).toBe(undefined);
    expect(
        inspectPort(() => {
            throw new Error('no /proc');
        }),
    ).toBe(undefined);
});

it('captures only when /healthz times out, not when nothing is listening', () => {
    const fetchFailed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
    // Listening but not answering: AbortSignal.timeout, or undici's own timeouts.
    expect(shouldCapture(new DOMException('The operation timed out.', 'TimeoutError'))).toBe(true);
    expect(shouldCapture(new DOMException('This operation was aborted', 'AbortError'))).toBe(true);
    expect(shouldCapture(fetchFailed('UND_ERR_HEADERS_TIMEOUT'))).toBe(true);
    expect(shouldCapture(fetchFailed('UND_ERR_BODY_TIMEOUT'))).toBe(true);
    // Booting or exiting: no capture (the debugger would stall a booting app).
    expect(shouldCapture(fetchFailed('ECONNREFUSED'))).toBe(false);
    expect(shouldCapture(fetchFailed('ECONNRESET'))).toBe(false);
    expect(shouldCapture(fetchFailed('UND_ERR_SOCKET'))).toBe(false);
    expect(shouldCapture(new TypeError('fetch failed'))).toBe(false);
    expect(shouldCapture(undefined)).toBe(false);
    expect(shouldCapture(null)).toBe(false);
});
