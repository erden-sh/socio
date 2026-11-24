/**
 * The boot's warm-up, before the server listens: the one-time work that
 * would otherwise run on the first real requests, on the main thread,
 * while `/healthz` waits behind it.
 *
 * A start-first update routes to the new task once its `/healthz` answers,
 * so whatever a task loads lazily is loaded under its first users' requests
 * (a deployment's v0.38.0 upgrade: `/healthz` timed out for 3.6 s a second after the
 * new task first answered it). Measured over a copy of that deployment's database, the
 * first request with a session cookie built Better Auth (imports and all)
 * and held the main thread about 0.6 s; the second took 14 ms. Done here,
 * before `listen`, it delays only this task's first healthy answer, and the
 * previous task serves meanwhile.
 *
 * What is warmed:
 * - sign-in: the provider's `warm()` (Better Auth's instance, its plugins'
 *   modules and its context);
 * - the pages: one signed-out page rendered in process (`GET /`, no
 *   cookie), through the app's middleware, React Router and React's server
 *   renderer, which the first pages otherwise run cold.
 *
 * Neither writes anything. A failure is logged and boot goes on: the first
 * request then does the work, as before. The pages' server build itself is
 * imported earlier, when the pages are mounted (`web/prod.ts`).
 */
import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';

import type { AuthSetup } from '../../auth/contract.js';

/** What `warmUp` took, in ms, for the log and tests. */
export interface WarmUpTimes {
    signIn: number;
    page: number;
}

/**
 * Runs the warm-up and logs one line with its times. `origin` is the URL
 * the in-process page request is made for (the app's own origin, or
 * loopback): it never leaves the process.
 */
export async function warmUp(
    app: Pick<Hono<AppEnv>, 'request'>,
    auth: Pick<AuthSetup, 'provider'>,
    {
        origin = 'http://127.0.0.1',
        log = (line: string) => console.log(line),
        now = () => performance.now(),
    }: { origin?: string; log?: (line: string) => void; now?: () => number } = {},
): Promise<WarmUpTimes> {
    const started = now();
    try {
        await auth.provider.warm?.();
    } catch (error) {
        log(`Warm-up: sign-in didn't load (${message(error)}); the first request loads it.`);
    }
    const signedIn = now();
    try {
        const response = await app.request(new URL('/', origin).href, { headers: { accept: 'text/html' } });
        // The body is where React streams the page: read it to the end.
        await response.arrayBuffer();
        if (response.status >= 500) {
            log(`Warm-up: the page answered ${response.status}.`);
        }
    } catch (error) {
        log(`Warm-up: the page didn't render (${message(error)}).`);
    }
    const done = now();
    const times = { signIn: Math.round(signedIn - started), page: Math.round(done - signedIn) };
    log(`Warm-up: sign-in loaded in ${times.signIn} ms, a page rendered in ${times.page} ms.`);
    return times;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The warm-up's step, as lifecycle/index.ts runs it. */
export const warmLifecycle = { warmUp };
