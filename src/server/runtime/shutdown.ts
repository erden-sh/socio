import { turnTimeLimitMsFromEnv } from '@socio/foundation/observability/failures';
import type { Settings } from '@socio/shared/types';

import type { LimitsShape } from '../settings/contract.js';

import { DRAINING_MESSAGE, DRAINING_RETRY_AFTER_S } from './contract.js';

/**
 * The web's answer to a new turn while draining: 503 with Retry-After.
 * `Connection: close` (CB-108): the proxy's next request opens a new
 * connection, which the service's load balancing gives to a task that
 * isn't draining, so the client's retry lands on the new release.
 */
export const drainingResponse = () =>
    Response.json(
        { error: DRAINING_MESSAGE, code: 'draining' },
        {
            status: 503,
            headers: {
                'Retry-After': String(DRAINING_RETRY_AFTER_S),
                Connection: 'close',
            },
        },
    );

/**
 * What a draining server refuses (CB-108): requests that start work that
 * would still be running when the process exits. A new turn (the
 * runtime's `run`), a voice call and a learning analysis.
 * Everything else keeps working while running turns finish: pages, reads,
 * polls, writes, reconnecting to a conversation and stopping a run.
 * Left alone on purpose: a turn inside a voice call already going
 * (`/voice/calls/:id/compute`), so a call in progress can finish.
 */
const REFUSED_WHILE_DRAINING = [
    /^\/api\/copilotkit\/agent\/[^/]+\/run$/,
    /^\/api\/voice\/calls$/,
    /^\/api\/learning\/containers\/[^/]+\/analyze$/,
];

/** Whether a draining server refuses `method` `path` (`drainingResponse`). */
export const refusedWhileDraining = (method: string, path: string) =>
    method === 'POST' && REFUSED_WHILE_DRAINING.some((pattern) => pattern.test(path));

/**
 * `SHUTDOWN_DRAIN_MS`: how long turns in progress get to finish after
 * SIGTERM. By default the turn limit plus 20 s (320 s with the default
 * 300 s limit), under the stack's 330 s `stop_grace_period` with room for
 * the final cleanup. `turnLimitMs` is the limit in force (Settings over
 * `TURN_TIME_LIMIT_SECONDS`, CB-123); Settings keeps it to 300 s at most.
 */
export function drainMsFromEnv(env: Record<string, string | undefined>, turnLimitMs = turnTimeLimitMsFromEnv(env)) {
    const raw = env.SHUTDOWN_DRAIN_MS?.trim();
    const ms = raw ? Number(raw) : turnLimitMs + 20_000;
    if (!Number.isInteger(ms) || ms < 0) {
        throw new Error('SHUTDOWN_DRAIN_MS must be a whole number of milliseconds.');
    }
    return ms;
}

/**
 * The drain now: `drainMsFromEnv` with the turn limit saved in Settings
 * (CB-123), as `limits` (settings' `Limits`) puts it in force.
 */
export const drainMsInForce = (
    env: Record<string, string | undefined>,
    settings: Settings,
    limits: Pick<LimitsShape, 'turnTimeLimitMs'>,
) => drainMsFromEnv(env, limits.turnTimeLimitMs(settings));

/**
 * SIGTERM/SIGINT: drain, then stop. Draining refuses new turns and runs
 * while the ones in progress finish, until none are left or `drainMs`
 * passes; the rest are then interrupted as before (stopRunner, stopPlatform).
 * With `force` (`SHUTDOWN_FORCE`, development only) nothing is waited for:
 * it stops the work in progress at once, which then gets `forceGraceMs` to
 * finish storing.
 * The HTTP server keeps answering while draining (refusals, health), and
 * closes with the platform stop, letting in-flight responses complete.
 * Databases close last.
 */
export function createShutdown(options: {
    /** Refuses new turns and runs; what is running continues. */
    drain?: () => void;
    /** How many turns and runs are still in progress. */
    inProgress?: () => number;
    /** A function is read when the drain starts (the limit in Settings can change). */
    drainMs?: number | (() => number);
    /** Stops the work in progress at once instead of waiting for it. */
    force?: () => unknown;
    forceGraceMs?: number;
    stopRunner: () => void;
    stopPlatform: () => Promise<void>;
    closeServer: () => Promise<void>;
    closeDatabase?: () => void;
    exit: (code: number) => void;
    report: (operation: string, error: unknown) => void;
    log?: (line: string) => void;
    timeoutMs?: number;
    pollMs?: number;
}) {
    let pending: Promise<void> | undefined;
    return () =>
        (pending ??= (async () => {
            let failed = false;
            const report = (operation: string, error: unknown) => {
                failed = true;
                options.report(operation, error);
            };
            const log = options.log ?? (() => {});
            try {
                options.drain?.();
            } catch (error) {
                report('Starting the drain failed', error);
            }
            const busy = () => {
                try {
                    return options.inProgress?.() ?? 0;
                } catch (error) {
                    report('Checking for work in progress failed', error);
                    return 0;
                }
            };
            const drainMs = options.force
                ? (options.forceGraceMs ?? 5000)
                : typeof options.drainMs === 'function'
                  ? options.drainMs()
                  : (options.drainMs ?? 0);
            const started = Date.now();
            let left = busy();
            if (left && options.force) {
                log(`Shutdown: SHUTDOWN_FORCE, stopping ${left} in progress now.`);
                try {
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    await Promise.race([
                        options.force(),
                        new Promise((resolve) => (timer = setTimeout(resolve, drainMs))),
                    ]).finally(() => clearTimeout(timer));
                } catch (error) {
                    report('Stopping work in progress failed', error);
                }
                left = busy();
            }
            if (left) {
                log(
                    `Shutdown: ${options.force ? 'waiting for stopped work' : 'draining'}, ${left} in progress (up to ${Math.round(drainMs / 1000)} s).`,
                );
                while (left && Date.now() - started < drainMs) {
                    await new Promise((resolve) =>
                        setTimeout(resolve, Math.min(options.pollMs ?? 250, drainMs - (Date.now() - started))),
                    );
                    left = busy();
                }
                log(
                    left
                        ? `Shutdown: drain deadline passed; interrupting ${left} still in progress.`
                        : `Shutdown: drained in ${Math.round((Date.now() - started) / 1000)} s.`,
                );
            }
            try {
                options.stopRunner();
            } catch (error) {
                report('Stopping scheduler failed', error);
            }
            let timer: ReturnType<typeof setTimeout> | undefined;
            const deadline = new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                    report('Shutdown deadline exceeded', new Error('Timeout'));
                    resolve();
                }, options.timeoutMs ?? 8000);
            });
            const settle = async (operation: string, action: () => Promise<void>) => {
                try {
                    await action();
                } catch (error) {
                    report(operation, error);
                }
            };
            await Promise.race([
                Promise.all([
                    settle('Stopping Channels failed', options.stopPlatform),
                    settle('Closing HTTP server failed', options.closeServer),
                ]),
                deadline,
            ]);
            clearTimeout(timer);
            try {
                options.closeDatabase?.();
            } catch (error) {
                report('Closing the database failed', error);
            }
            options.exit(failed ? 1 : 0);
        })());
}
