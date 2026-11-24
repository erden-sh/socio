// The server's boot and shutdown, as its log shows them. The only check of
// the process entry's (src/server/index.ts) phase order: the changes that
// delete `Platform` keep this log as it is.
//
// The server runs as a child process over a fresh database in a temporary
// directory, with an environment built from nothing: no credential and no
// outside service is set (no model, no Telegram, no S3, no search key),
// analytics are off, and the one URL it could fetch by default (the price
// sync) points at a closed local port. The pages are a stub build: only
// the server's own steps are under test.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** A child process and its exit, whenever it comes. */
interface Tracked {
    readonly child: ChildProcess;
    readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** The children still to end, and the directories to delete once they have. */
const children = new Set<Tracked>();
const dirs: string[] = [];

/** How long a child gets after SIGKILL before the test stops waiting for it. */
const KILL_WAIT_MS = 5_000;

const alive = ({ child }: Tracked) => child.exitCode === null && child.signalCode === null;

function track(child: ChildProcess): Tracked {
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
        // It never started: there is nothing to wait for.
        child.once('error', () => resolve({ code: null, signal: null }));
    });
    const tracked = { child, exited };
    children.add(tracked);
    return tracked;
}

/** `promise`'s value, or undefined once `ms` pass first. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms))),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** Ends a child still running: SIGKILL to its own PID, then a bounded wait for its exit. */
async function kill(tracked: Tracked) {
    if (alive(tracked)) {
        tracked.child.kill('SIGKILL');
        await within(tracked.exited, KILL_WAIT_MS);
    }
    children.delete(tracked);
}

/**
 * SIGTERM, then up to `graceMs` for the child to exit. One still running
 * then is killed, and the stop fails.
 */
async function stop(tracked: Tracked, graceMs: number) {
    tracked.child.kill('SIGTERM');
    const exit = await within(tracked.exited, graceMs);
    if (!exit) {
        await kill(tracked);
        throw new Error(`Still running ${graceMs / 1000} s after SIGTERM: killed.`);
    }
    children.delete(tracked);
    return exit;
}

afterEach(async () => {
    // The children first: a directory goes only once nothing runs in it.
    for (const tracked of [...children]) {
        await kill(tracked);
    }
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A page build with nothing in it but an empty root page, as `productionWeb` loads one. */
function stubPages(dir: string) {
    mkdirSync(join(dir, 'server'), { recursive: true });
    mkdirSync(join(dir, 'client'), { recursive: true });
    writeFileSync(
        join(dir, 'server', 'index.js'),
        [
            "export const entry = { module: { webContext: {}, default: () => new Response('') } };",
            // One route, so the boot's warm-up renders a page (an empty one).
            "export const routes = { root: { id: 'root', path: '', module: { default: () => null } } };",
            "export const assets = { url: '/', version: 'stub', entry: { module: '', imports: [] }, routes: {} };",
            "export const publicPath = '/';",
            "export const assetsBuildDirectory = '';",
            'export const future = {};',
            'export const ssr = true;',
            'export const isSpaMode = false;',
            'export const prerender = [];',
            "export const routeDiscovery = { mode: 'initial' };",
            "export const basename = '/';",
        ].join('\n'),
    );
}

/** The log's variable parts: the temporary directory, the port, the uptime, the warm-up's times; the migrations, as one line. */
function masked(log: string, dir: string) {
    const lines = log
        .replaceAll(dir, '<dir>')
        .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
        .split('\n');
    const out: string[] = [];
    for (const line of lines) {
        const shown = line
            .replace(/after \d+ min up/, 'after <n> min up')
            .replace(/^(Warm-up: .*)$/, (warm) => warm.replace(/\d+ ms/g, '<n> ms'));
        // Every migration applied, in order: a new one isn't a change in
        // the boot's order.
        if (/^Migration .+: applied\.$/.test(shown)) {
            if (out.at(-1) !== '<migrations applied>') {
                out.push('<migrations applied>');
            }
            continue;
        }
        out.push(shown);
    }
    return out.join('\n').trimEnd();
}

const LEADING = 'Leader: this runtime leads';
const TIMEOUT_MS = 90_000;
/** How long the server gets to shut down after SIGTERM (its own deadline is 8 s, with nothing to drain). */
const SHUTDOWN_MS = 30_000;

/**
 * Starts the server, waits until it listens and leads, stops it with
 * SIGTERM and returns its log (stdout and stderr in one stream, in the
 * order written) up to then and after, and its exit code.
 */
async function bootAndStop() {
    const dir = mkdtempSync(join(tmpdir(), 'socio-boot-log-'));
    dirs.push(dir);
    stubPages(join(dir, 'web'));
    const logFile = join(dir, 'server.log');
    const fd = openSync(logFile, 'w');
    const server = track(
        spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
            cwd: root,
            // Built from nothing: nothing of this process's environment (its
            // keys and tokens) reaches the server.
            env: {
                PATH: process.env.PATH,
                HOME: dir,
                TMPDIR: dir,
                NODE_ENV: 'production',
                HOST: '127.0.0.1',
                PORT: '0',
                DATABASE_PATH: join(dir, 'data', 'socio.sqlite'),
                BACKUP_DIR: join(dir, 'data', 'backups'),
                WEB_BUILD_DIR: join(dir, 'web'),
                OPS_ANALYTICS_MODE: 'off',
                OPS_PRICE_SYNC_URL: 'http://127.0.0.1:9',
                DO_NOT_TRACK: '1',
            },
            stdio: ['ignore', fd, fd],
        }),
    );
    closeSync(fd);
    const read = () => readFileSync(logFile, 'utf8');
    try {
        const started = Date.now();
        while (!read().includes(LEADING)) {
            if (!alive(server)) {
                const { code, signal } = await server.exited;
                throw new Error(`The server exited (${code ?? signal}) before it led:\n${read()}`);
            }
            if (Date.now() - started > TIMEOUT_MS) {
                throw new Error(`The server didn't lead within ${TIMEOUT_MS / 1000} s:\n${read()}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        // The rest of the line.
        await new Promise((resolve) => setTimeout(resolve, 100));
        const boot = read();
        const { code } = await stop(server, SHUTDOWN_MS);
        return { boot: masked(boot, dir), shutdown: masked(read().slice(boot.length), dir), code };
    } finally {
        // Bounded: a server that outlived the test ends here, before
        // afterEach deletes its directory.
        await kill(server);
    }
}

it(
    'boots in this order, then shuts down on SIGTERM',
    async () => {
        const { boot, shutdown, code } = await bootAndStop();
        expect(boot).toMatchInlineSnapshot(`
          "Auth: SESSION_SECRET is not set; using a per-process secret, so sign-ins reset on restart.
          <migrations applied>
          Access policy: the environment applies (nothing narrowed in the app).
          Analytics: off (OPS_ANALYTICS_MODE=off).
          Domains: off (DOMAINS_ZONE, DOMAINS_BASE, DOMAINS_TARGET_IP, DOMAINS_UPSTREAM, NPM_API_URL, NPM_CREDENTIALS_FILE, CLOUDFLARE_DNS_TOKEN_FILE not set).
          Updates: no release feed in the environment (UPDATES_FEED); operators can set one on the Platform page; notify only (no UPDATER_URL).
          Data space: files on the local disk (S3_ENDPOINT not set).
          Data key: DATA_ENCRYPTION_KEY is not set, so files and stored credentials are sealed with a key from SESSION_SECRET. Rotating SESSION_SECRET would make them unreadable, and backups need it. Set DATA_ENCRYPTION_KEY (openssl rand -hex 32); see docs/SETUP.md "Data encryption key".
          Inference: SESSION_SECRET is not set, so backend keys and connections stored now can’t be read after a restart.
          Backups: every 24 hour(s), keeping 14.
          Warm-up: sign-in loaded in <n> ms, a page rendered in <n> ms.
          Socio listening on http://127.0.0.1:<port>
          Leader: this runtime leads (epoch 1)."
        `);
        expect(shutdown).toMatchInlineSnapshot(`"Shutdown: SIGTERM after <n> min up; no stall in the last 10 min."`);
        expect(code).toBe(0);
    },
    TIMEOUT_MS + SHUTDOWN_MS + 2 * KILL_WAIT_MS,
);

it('kills a child that ignores SIGTERM, and fails its stop', async () => {
    const stubborn = track(
        spawn(
            process.execPath,
            ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready');"],
            { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'ignore'] },
        ),
    );
    // Its SIGTERM handler is in place once it says so.
    await new Promise<void>((resolve) => stubborn.child.stdout!.once('data', () => resolve()));
    await expect(stop(stubborn, 500)).rejects.toThrow('Still running 0.5 s after SIGTERM: killed.');
    expect(await stubborn.exited).toEqual({ code: null, signal: 'SIGKILL' });
    expect(children.has(stubborn)).toBe(false);
});
