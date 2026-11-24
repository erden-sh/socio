/**
 * Main-thread stalls (CB-318): a heartbeat timer that notices when it ran
 * late, because something kept the event loop busy. A stall past the
 * threshold is logged once it ends, with its length and the work that was
 * running (the caller's `activity`: turns, runs, and the requests open
 * during the stall, from `requestLog`), so a freeze that fails the healthcheck leaves a line in the
 * log instead of nothing. The worst recent stall and the event loop's
 * delay percentiles feed the shutdown log and Health.
 *
 * The heartbeat can only measure a stall after it ends; a stall that never
 * ends is caught by the healthcheck, which asks Node for a diagnostic
 * report (the blocked thread's stack) before it gives up (Dockerfile,
 * `--report-on-signal`).
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

export interface Stall {
    /** When the stall ended. */
    at: number;
    /** How long the loop was blocked, in ms. */
    ms: number;
    /** What was running then, as `activity` described it. */
    activity?: string;
}

export interface StallMonitorOptions {
    /** A stall at least this long is logged. */
    thresholdMs?: number;
    /** How often the heartbeat runs. */
    intervalMs?: number;
    /** How many stalls `recent` keeps. */
    keep?: number;
    /**
     * What was running (turns, job runs, requests), for the log line. Called
     * once the stall ends, with when it started and ended.
     */
    activity?: (stall: { from: number; to: number }) => string | undefined;
    log?: (line: string) => void;
    now?: () => number;
    /** Tests drive the heartbeat themselves. */
    timers?: {
        setInterval: (fn: () => void, ms: number) => unknown;
        clearInterval: (handle: unknown) => void;
    };
    /** Off in tests: the percentiles come from Node's histogram. */
    histogram?: boolean;
}

export interface StallMonitor {
    /** The latest stalls, oldest first. */
    recent(): Stall[];
    /** The longest stall since `since`, if any. */
    worst(since?: number): Stall | undefined;
    /** The event loop's delay percentiles (ms) since the last reset. */
    delay(): { p50: number; p99: number; max: number } | undefined;
    /** One heartbeat; the timer calls it. Exposed for tests. */
    beat(): void;
    stop(): void;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function startStallMonitor(options: StallMonitorOptions = {}): StallMonitor {
    const thresholdMs = options.thresholdMs ?? 1000;
    const intervalMs = options.intervalMs ?? 250;
    const keep = options.keep ?? 50;
    const now = options.now ?? Date.now;
    const log = options.log ?? ((line: string) => console.warn(line));
    const timers = options.timers ?? {
        setInterval: (fn: () => void, ms: number) => {
            const handle = setInterval(fn, ms);
            // Never keeps the process alive on its own.
            handle.unref();
            return handle;
        },
        clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
    };
    let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
    if (options.histogram !== false) {
        histogram = monitorEventLoopDelay({ resolution: 20 });
        histogram.enable();
    }
    const stalls: Stall[] = [];
    let last = now();
    const beat = () => {
        const at = now();
        // The heartbeat was due `intervalMs` after the last one: the rest is
        // time the loop spent on something else.
        const late = at - last - intervalMs;
        last = at;
        if (late < thresholdMs) {
            return;
        }
        let activity: string | undefined;
        try {
            activity = options.activity?.({ from: at - late, to: at });
        } catch {
            activity = undefined;
        }
        stalls.push({ at, ms: late, ...(activity ? { activity } : {}) });
        if (stalls.length > keep) {
            stalls.shift();
        }
        log(
            `Stall: the main thread was blocked for ${seconds(late)}` +
                (activity ? ` (running: ${activity})` : '') +
                '.',
        );
    };
    const handle = timers.setInterval(beat, intervalMs);
    return {
        recent: () => [...stalls],
        worst: (since = 0) =>
            stalls
                .filter((stall) => stall.at >= since)
                .reduce<Stall | undefined>((top, stall) => (!top || stall.ms > top.ms ? stall : top), undefined),
        delay: () =>
            histogram && histogram.count
                ? {
                      p50: histogram.percentile(50) / 1e6,
                      p99: histogram.percentile(99) / 1e6,
                      max: histogram.max / 1e6,
                  }
                : undefined,
        beat,
        stop: () => {
            timers.clearInterval(handle);
            histogram?.disable();
        },
    };
}

/** A request in `requestLog`: what it was, and when it started and ended. */
interface LoggedRequest {
    label: string;
    start: number;
    end?: number;
}

export interface RequestLog {
    /** A request starts; call the returned function when it ends. */
    begin(label: string): () => void;
    /**
     * The requests open at some point in [from, to], oldest first, at most
     * `limit` labels (`+N more` after them). A stall's blocking work ran in
     * one of them, or in a timer, a turn or a run.
     */
    during(from: number, to: number, limit?: number): string[];
}

/**
 * The requests the server answered lately, for the stall line: the work
 * that blocked the loop is usually one of them. Cheap: an array push per
 * request and a sweep of the ones that ended over `keepMs` ago.
 */
export function requestLog(options: { keepMs?: number; max?: number; now?: () => number } = {}): RequestLog {
    const keepMs = options.keepMs ?? 60_000;
    const max = options.max ?? 500;
    const now = options.now ?? Date.now;
    let entries: LoggedRequest[] = [];
    const sweep = (at: number) => {
        entries = entries.filter((entry) => entry.end === undefined || at - entry.end <= keepMs);
        // Open requests that never end (a stream left open) can't grow it for good.
        if (entries.length > max) {
            entries = entries.slice(-max);
        }
    };
    return {
        begin(label) {
            const entry: LoggedRequest = { label, start: now() };
            if (entries.length >= max) {
                sweep(entry.start);
            }
            entries.push(entry);
            return () => {
                entry.end ??= now();
            };
        },
        during(from, to, limit = 5) {
            sweep(now());
            const open = entries
                .filter((entry) => entry.start <= to && (entry.end === undefined || entry.end >= from))
                .map((entry) => entry.label);
            return open.length > limit ? [...open.slice(0, limit), `+${open.length - limit} more`] : open;
        },
    };
}

/** What `trackedFetch` reads of the Node response: its end. */
interface Outgoing {
    once(event: 'close' | 'error', listener: () => void): unknown;
}

/**
 * Wraps the server's `fetch` so `log` holds each request until its
 * response is done: the Node response's `close`, which comes after
 * `finish` and also when the client goes away. A Response's promise
 * settles once headers are ready, while a streamed body (SSE, a page's
 * stream) is still being written, and a stall then must still name it.
 * Without the Node response (in-process calls) the request ends when the
 * promise settles; a `fetch` that throws ends it at once.
 */
export function trackedFetch<Env>(
    log: Pick<RequestLog, 'begin'>,
    fetch: (request: Request, env: Env) => Response | Promise<Response>,
) {
    return (request: Request, env: Env): Response | Promise<Response> => {
        const path = new URL(request.url).pathname;
        const end = log.begin(`${request.method} ${path.length > 80 ? `${path.slice(0, 80)}…` : path}`);
        const outgoing = (env as { outgoing?: Outgoing } | undefined)?.outgoing;
        if (outgoing) {
            outgoing.once('close', end);
            outgoing.once('error', end);
        }
        let answer: Response | Promise<Response>;
        try {
            answer = fetch(request, env);
        } catch (error) {
            end();
            throw error;
        }
        // Rejected: no body will be written, whatever the socket does next.
        void Promise.resolve(answer).then(outgoing ? undefined : end, end);
        return answer;
    };
}

/**
 * The shutdown's first log line: which signal, after how long, and the
 * worst stall in the last ten minutes. A healthcheck kill follows a stall,
 * and this line ties the two together.
 */
export function shutdownCause(
    signal: string,
    uptimeSeconds: number,
    monitor: Pick<StallMonitor, 'worst'> | undefined,
    now = Date.now(),
): string {
    const minutes = Math.round(uptimeSeconds / 60);
    const stall = monitor?.worst(now - 10 * 60_000);
    return (
        `Shutdown: ${signal} after ${minutes} min up` +
        (stall
            ? `; the main thread stalled ${seconds(stall.ms)} ${Math.round((now - stall.at) / 1000)} s ago` +
              (stall.activity ? ` (running: ${stall.activity})` : '')
            : '; no stall in the last 10 min') +
        '.'
    );
}

/**
 * An error that reached the top: one structured line, so a crash is
 * searchable in the log. Observes only: `uncaughtExceptionMonitor` keeps
 * Node's own behavior (the process still exits).
 */
export function fatalErrorLine(error: unknown, origin: string): string {
    const detail =
        error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : { message: String(error) };
    return `Fatal: ${JSON.stringify({ origin, ...detail })}`;
}

/**
 * Undici (the client behind Node's `fetch`) uses informational errors
 * (`UND_ERR_INFO`) for a pooled connection it closes on its own, such as
 * "socket idle timeout" when an idle HTTP/2 session times out. No request
 * is lost, but Node 26's bundled undici can emit one on an HTTP/2 stream
 * with no 'error' listener, which would end the process.
 */
export function isConnectionNotice(error: unknown): boolean {
    return error instanceof Error && (error as { code?: unknown }).code === 'UND_ERR_INFO';
}

type ErrorLog = Pick<Console, 'error' | 'warn'>;
type GuardedProcess = Pick<NodeJS.Process, 'on' | 'exit'>;

/**
 * Logs every error that reaches the top. A connection notice is logged and
 * the process keeps serving; anything else is logged and the process exits
 * with code 1, as Node does by default.
 */
export function guardProcessErrors(proc: GuardedProcess = process, log: ErrorLog = console): void {
    proc.on('uncaughtExceptionMonitor', (error, origin) => {
        if (!isConnectionNotice(error)) {
            log.error(fatalErrorLine(error, origin));
        }
    });
    proc.on('uncaughtException', (error, origin) => {
        if (isConnectionNotice(error)) {
            log.warn(fatalErrorLine(error, origin).replace(/^Fatal:/, 'Recovered:'));
            return;
        }
        log.error(error);
        proc.exit(1);
    });
}
