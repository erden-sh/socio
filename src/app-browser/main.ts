import { readFileSync } from 'node:fs';

import { serve } from '@hono/node-server';

import { AppBrowserRouter, sameUserLaunch, setprivLaunch } from './router.js';

/**
 * The `app-browser` service's entry (CB-232; image stage `app-browser`).
 * Dark: nothing calls it until Socio has `APP_BROWSER_URL` and the
 * `socio-actor-access` flag is on for a person.
 *
 * Settings: `APP_BROWSER_SECRET_FILE` (or `APP_BROWSER_SECRET`, 24+
 * characters, its own value),
 * `APP_BROWSER_UPSTREAM` (Socio's internal apps listener),
 * `APP_BROWSER_MAX` (contexts, default 8), `APP_BROWSER_UID_BASE` (each
 * context's worker runs as UID base + slot; unset only in development),
 * `APP_BROWSER_HOST`, `APP_BROWSER_PORT` (4360).
 */

export interface AppBrowserConfig {
    secret: string;
    upstream: string;
    max: number;
    uidBase?: number;
    host: string;
    port: number;
}

export function appBrowserConfigFromEnv(env: Record<string, string | undefined>): AppBrowserConfig {
    const secret = (
        env.APP_BROWSER_SECRET_FILE ? readFileSync(env.APP_BROWSER_SECRET_FILE, 'utf8') : (env.APP_BROWSER_SECRET ?? '')
    ).trim();
    if (secret.length < 24) {
        throw new Error('APP_BROWSER_SECRET must be at least 24 characters.');
    }
    const upstream = env.APP_BROWSER_UPSTREAM?.trim();
    if (!upstream) {
        throw new Error('APP_BROWSER_UPSTREAM is required.');
    }
    const max = Number(env.APP_BROWSER_MAX ?? 8);
    if (!Number.isInteger(max) || max < 1 || max > 64) {
        throw new Error('APP_BROWSER_MAX must be 1 to 64.');
    }
    const uidBase = env.APP_BROWSER_UID_BASE?.trim() ? Number(env.APP_BROWSER_UID_BASE) : undefined;
    if (uidBase !== undefined && (!Number.isInteger(uidBase) || uidBase < 1000)) {
        throw new Error('APP_BROWSER_UID_BASE must be a UID of 1000 or more.');
    }
    if (uidBase === undefined && env.NODE_ENV === 'production') {
        throw new Error('APP_BROWSER_UID_BASE is required in production: each context runs as its own user.');
    }
    return {
        secret,
        upstream,
        max,
        uidBase,
        host: env.APP_BROWSER_HOST ?? '127.0.0.1',
        port: Number(env.APP_BROWSER_PORT ?? 4360),
    };
}

async function main() {
    const config = appBrowserConfigFromEnv(process.env);
    // The secret is the router's alone: no child process inherits it.
    delete process.env.APP_BROWSER_SECRET;
    const router = new AppBrowserRouter({
        secret: config.secret,
        upstream: config.upstream,
        max: config.max,
        launch: config.uidBase === undefined ? sameUserLaunch : setprivLaunch(config.uidBase),
        log: (line) => console.log(line),
    });
    // No sandboxed renderer, no service.
    const report = await router.selfTest();
    if (!report.sandboxed) {
        console.error(
            'App browser: Chromium’s sandbox is not available here (check the seccomp profile); refusing to start.',
        );
        process.exit(1);
    }
    router.watch();
    serve({
        fetch: router.app().fetch,
        hostname: config.host,
        port: config.port,
    });
    const stop = () => void router.stop().finally(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}

if (process.argv[1] && /app-browser[\\/]main\.(?:ts|js)$/.test(process.argv[1])) {
    void main();
}
