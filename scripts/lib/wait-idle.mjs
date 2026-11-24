// The loop behind scripts/wait-idle.mjs, apart from sign-in so tests can
// drive it with a fake API caller.

/**
 * Waits until no agent turn is in progress, polling with
 * `call` (a JSON caller for /api, as signIn returns). With `force`, first
 * asks the server to stop all running work (`POST /api/operator/force-stop`,
 * development servers only, an admin account), which also holds new
 * work until the restart. Resolves true when idle, false at the timeout.
 */
export async function waitIdle(call, options = {}) {
    const log = options.log ?? ((line) => console.log(line));
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? 600_000;
    const pollMs = options.pollMs ?? (options.force ? 1000 : 5000);
    if (options.force) {
        const { user } = await call('/auth/session');
        if (user?.role !== 'admin' && user?.role !== 'operator') {
            throw new Error(`--force needs an admin account; this one is ${user?.role ?? 'nobody'}.`);
        }
        let result;
        try {
            result = await call('/operator/force-stop', 'POST', {});
        } catch (error) {
            if (/: 404 /.test(error instanceof Error ? error.message : '')) {
                throw new Error('This server has no force stop: it runs only with APP_ENV=development.');
            }
            throw error;
        }
        log(
            `[wait-idle] force stop: ${result.turns} turns, ${result.scheduledTasks} scheduled tasks stopped; ${result.computerActions} computer actions aborted; new work held until the restart`,
        );
    }
    const started = now();
    for (;;) {
        const turns = (await call('/runs?status=running')).runs.length;
        if (!turns) {
            log(`[wait-idle] idle${options.force ? ` after ${Math.round((now() - started) / 1000)}s` : ''}`);
            return true;
        }
        if (now() - started > timeoutMs) {
            log(`[wait-idle] still busy after ${timeoutMs / 1000}s (${turns} turns)`);
            return false;
        }
        log(`[wait-idle] waiting: ${turns} turns in progress`);
        await sleep(pollMs);
    }
}
