import type { Server } from 'node:http';
import { join } from 'node:path';

import type { ServerBuild } from 'react-router';

import type { WebBuild } from './mount.js';

/** React Router's server build inside Vite's dev server. */
const SERVER_BUILD = 'virtual:react-router/server-build';

/**
 * What Vite's dev server never serves (`server.fs.deny`). Vite serves files
 * under the project: never the database, local state, or the apps' files
 * (future relay secrets live under `apps/`). Vite's defaults first; a
 * pattern with a slash is matched against the absolute path.
 */
export function devFsDeny(cwd = process.cwd()) {
    return [
        '.env',
        '.env.*',
        '*.{crt,pem,key,p12,pfx,cer,der}',
        '.npmrc',
        '.yarnrc.yml',
        '**/.git/**',
        '*.sqlite*',
        join(cwd, 'data/**'),
        join(cwd, '.local/**'),
        join(cwd, 'apps/**'),
    ];
}

/**
 * Development (`pnpm run dev`): Vite in middleware mode, inside this server.
 * It serves the modules and public files, and the page renderer loads the
 * current server build through Vite on each request, so edits show up
 * without a restart. Hot reload shares the app's port when `httpServer` is
 * given (index.ts lets its WebSocket upgrades through). Vite is a dev
 * dependency, loaded only here.
 */
export async function developmentWeb(
    httpServer?: Server,
    /** Vite's cache (tests keep theirs apart from pnpm run dev's). */
    cacheDir?: string,
    /**
     * `watch: false` turns off Vite's file watcher (`server.watch: null`).
     * Tests render once and never edit a file, and a watcher over the whole
     * tree can exhaust the host's inotify watches (ENOSPC).
     */
    options: { watch?: boolean } = {},
): Promise<WebBuild & { close(): Promise<void> }> {
    const { createServer, isRunnableDevEnvironment } = await import('vite');
    const vite = await createServer({
        appType: 'custom',
        cacheDir,
        server: {
            middlewareMode: true,
            ws: httpServer ? { server: httpServer } : false,
            fs: { deny: devFsDeny() },
            ...(options.watch === false ? { watch: null } : {}),
        },
    });
    const ssr = vite.environments.ssr;
    if (!isRunnableDevEnvironment(ssr)) {
        throw new Error('Vite has no runnable server environment.');
    }
    return {
        mode: 'development',
        build: () => ssr.runner.import(SERVER_BUILD) as Promise<ServerBuild>,
        middlewares: vite.middlewares,
        close: () => vite.close(),
    };
}
