import type { UpdaterConfig } from './config.js';
import type { HealthResult } from './platform.js';

/** How the health gate waits (tests: a loopback fake, a fast clock). */
export interface HealthGateOptions {
    transport?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

/**
 * The app's own health gate, for any platform that has no better signal:
 * `/healthz` answers healthy at `version`, `stableChecks` times in a row,
 * before the timeout.
 *
 * Health is judged by the version /healthz reports, not by task state, so
 * it holds for a stop-first rollout (the old task stops, then the new one
 * starts) and for a start-first one (both answer for a while; only the new
 * version counts), whichever the stack uses (CB-108).
 */
export async function waitForHealth(
    health: UpdaterConfig['health'],
    version: string,
    options: HealthGateOptions = {},
): Promise<HealthResult> {
    const transport = options.transport ?? fetch;
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = now() + health.timeoutMs;
    let streak = 0;
    let last = 'no answer';
    while (now() < deadline) {
        try {
            const response = await transport(health.url, {
                headers: { Accept: 'application/json' },
                redirect: 'error',
                signal: AbortSignal.timeout(Math.min(5000, health.intervalMs * 2)),
            });
            const body = (await response.json().catch(() => null)) as {
                ok?: unknown;
                version?: unknown;
                draining?: unknown;
            } | null;
            if (response.ok && body?.ok === true && body.version === version && body.draining !== true) {
                streak++;
            } else {
                streak = 0;
                last = !response.ok
                    ? `HTTP ${response.status}`
                    : body?.version !== version
                      ? `version ${typeof body?.version === 'string' ? body.version : 'unknown'} answering`
                      : body?.draining === true
                        ? 'draining'
                        : 'not ok';
            }
        } catch {
            streak = 0;
            last = 'unreachable';
        }
        if (streak >= health.stableChecks) {
            return { ok: true };
        }
        await sleep(health.intervalMs);
    }
    return {
        ok: false,
        reason: `${version} was not healthy within ${Math.round(health.timeoutMs / 1000)} s (last: ${last}).`,
    };
}
