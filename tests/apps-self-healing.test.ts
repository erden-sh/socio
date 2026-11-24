import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';
import type { DotTurn } from '@socio/foundation/turns/turn';

import { AppHealthBook } from '../src/server/apps/health.js';
import { appTools } from '../src/server/apps/tools.js';
import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-291: mini apps recover by themselves from a refused data token and a
// crashed or stale process. The app's computer is a local directory here,
// its commands run with sh as this user, and its server is a real process
// on a real port (the platform's script stops it as it would in a computer).

const SECRET = 'secret-0123456789abcdef-xyz';
const cleanup: Array<() => unknown> = [];
/** Only processes these tests started are ever signaled. */
const started = new Set<number>();
afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const pid of started) {
        // Still the app's server (never a recycled pid of something else).
        let cmdline = '';
        try {
            cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        } catch {
            continue;
        }
        if (cmdline.includes('server.mjs')) {
            try {
                process.kill(pid, 'SIGKILL');
            } catch {
                // Gone already.
            }
        }
    }
    started.clear();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/**
 * The app as a socio writes it: it reads its data token from the env once
 * (as in CB-291's stale process), or, with REREAD=1, reads it again from
 * $CB_APP_ENV_FILE on a 401 and retries.
 */
const SERVER = `
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
let token = process.env.CB_DATA_TOKEN;
const fromFile = () => /CB_DATA_TOKEN='([^']+)'/.exec(readFileSync(process.env.CB_APP_ENV_FILE, 'utf8'))?.[1];
const call = () => fetch(process.env.DATA_URL + '/datasets', { headers: { authorization: 'Bearer ' + token } });
const server = createServer(async (req, res) => {
  let status = null;
  if (req.url === '/data') {
    let r = await call();
    if (r.status === 401 && process.env.REREAD === '1') { token = fromFile(); r = await call(); }
    status = r.status;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status, pid: process.pid }));
});
server.listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`;

/**
 * Holds `port` for this process until `release`: an abstract socket named
 * after it (Linux), which only one process can bind and which goes when the
 * process does. Two runs of these tests at once (a busy host runs several
 * suites) then never pick the same port between its probe and the app's
 * listen. Elsewhere there is no lease.
 */
async function leasePort(port: number): Promise<(() => Promise<void>) | undefined> {
    if (process.platform !== 'linux') {
        return async () => {};
    }
    const lease = createServer();
    const ok = await new Promise<boolean>((resolve) => {
        lease.once('error', () => resolve(false));
        lease.listen(`\0socio-test-app-port-${port}`, () => resolve(true));
    });
    return ok ? () => new Promise<void>((resolve) => lease.close(() => resolve())) : undefined;
}

/** A free port in the apps' range (3000 to 3999), leased to this process until the test's cleanup. */
async function freePort() {
    for (let i = 0; i < 50; i++) {
        const port = 3000 + Math.floor(Math.random() * 1000);
        const release = await leasePort(port);
        if (!release) {
            continue;
        }
        const ok = await new Promise<boolean>((resolve) => {
            const probe = createServer();
            probe.once('error', () => resolve(false));
            probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
        });
        if (ok) {
            cleanup.push(release);
            return port;
        }
        await release();
    }
    throw new Error('no free port');
}

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

async function until<T>(read: () => Promise<T> | T, ok: (value: T) => boolean, ms = 15_000): Promise<NonNullable<T>> {
    const deadline = Date.now() + ms;
    let value = await read();
    while (!ok(value)) {
        if (Date.now() > deadline) {
            throw new Error(`timed out; last ${JSON.stringify(value)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        value = await read();
    }
    return value as NonNullable<T>;
}

async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-heal-'));
    const home = join(dir, 'home');
    mkdirSync(join(home, 'shared', 'tracker'), { recursive: true });
    writeFileSync(join(home, 'shared', 'tracker', 'server.mjs'), SERVER);
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            sessionSecret: SECRET,
            data: { userDataDir: join(dir, 'userdata'), apiUrl: 'http://app:4310' },
            apps: appsSettingsFromEnv({}, 'http://localhost:4310')!,
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            origin: 'http://localhost:4310',
            auth: { provider: new MockAuthProvider(DEFAULT_MOCK_USERS, SECRET), secureCookies: false },
        },
    });
    cleanup.push(dispose);
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    const home0 = workspace.dots()[0].spaceId;
    const dot = workspace.createDot(
        home0,
        'Helper',
        'Helps.',
        false,
        false,
        [home0],
        null,
        false,
        null,
        false,
        'alice',
    );
    await workspace.computers.patch(dot.id, { enabled: true, browser: true, files: true, shell: true });
    // The data API the app calls, on a real port.
    const main = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((ok) => (main.listening ? ok() : main.once('listening', () => ok())));
    cleanup.push(
        () =>
            new Promise<void>((ok) => {
                (main as { closeAllConnections?: () => void }).closeAllConnections?.();
                main.close(() => ok());
            }),
    );
    const dataUrl = `http://127.0.0.1:${(main.address() as AddressInfo).port}/api/data`;
    const port = await freePort();
    const runs: Array<{ exitCode: number; stderr: string }> = [];
    vi.spyOn(platform.computers, 'action').mockImplementation(async (_id, action, input) => {
        if (action !== 'exec') {
            throw new Error(`unexpected ${action}`);
        }
        const result = spawnSync('sh', ['-c', (input as { command: string }).command], {
            cwd: home,
            env: { PATH: process.env.PATH, HOME: home },
        });
        const pid = Number(readFileSync(join(home, '.socio/apps/tracker.pid'), 'utf8').trim());
        if (pid) {
            started.add(pid);
        }
        const out = {
            exitCode: result.status ?? 1,
            stderr: result.stderr.toString(),
            stdout: result.stdout.toString(),
        };
        runs.push(out);
        return out;
    });
    vi.spyOn(platform.computers, 'writeFile').mockImplementation(async (_id, path, contents) => {
        mkdirSync(dirname(join(home, path)), { recursive: true });
        writeFileSync(join(home, path), contents);
    });
    vi.spyOn(platform.computers, 'start').mockResolvedValue({ state: 'running' } as never);
    platform.apps.useTargets(async () => ({ state: 'running', host: '127.0.0.1', port }));
    const notices: unknown[] = [];
    platform.apps.useAdminNotices(async (notice) => void notices.push(notice));
    await platform.approvals.setPolicy('alice', dot.id, 'app.register', 'bypass');
    const turn: DotTurn = {
        dot,
        userId: 'alice',
        threadId: 'thread',
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
    };
    const tools = Object.fromEntries(
        (
            appTools(platform.apps, turn) as unknown as Array<{
                name: string;
                execute: (input: unknown) => Promise<Record<string, unknown>>;
            }>
        ).map((tool) => [tool.name, tool.execute]),
    );
    const register = async (env = '', command?: string) => {
        const result = await tools.app_register({
            name: 'Tracker',
            port,
            start_command: command ?? `cd tracker && ${env} DATA_URL=${dataUrl} exec ${process.execPath} server.mjs`,
        });
        expect(result).toMatchObject({ status: 'approved' });
        return platform.apps.all().find((item) => item.name === 'Tracker')!;
    };
    const get = async (path = '/') => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        return (await response.json()) as { status: number | null; pid: number };
    };
    const log = () => readFileSync(join(home, '.socio/apps/tracker.log'), 'utf8');
    // A server that never answers says why in its log (EADDRINUSE, say).
    const up = () =>
        until(
            () => get().catch(() => null),
            (value) => !!value,
        ).catch((error: Error) => {
            const output = existsSync(join(home, '.socio/apps/tracker.log')) ? log() : '(no log)';
            throw new Error(`${error.message}; the app's log: ${output}`);
        });
    return { platform, register, get, up, port, home, runs, notices, log, spaceId: home0 };
}

describe('mini apps heal themselves (CB-291)', { timeout: 45_000 }, () => {
    it('acceptance: a stale process holding the port with a dead token is replaced, and its data access resumes', async () => {
        const f = await fixture();
        const app = await f.register();
        const first = await f.up();
        expect((await f.get('/data')).status).toBe(200);
        // Its token dies (expired, or revoked by an approved update), while the
        // process keeps the port: the data API refuses it.
        f.platform.data.tokens.revokeSession(`app:${app.id}`);
        expect((await f.get('/data')).status).toBe(401);
        // Renewed in place first: a new token in its env file, no restart.
        await until(
            () => f.platform.apps.health.get(app.id).state,
            (state) => state === 'recovering',
        );
        expect(f.platform.apps.view(f.platform.apps.get(app.id)!, 'alice').health).toMatchObject({
            state: 'recovering',
            reason: expect.stringMatching(/data token was refused/),
        });
        expect((await f.get()).pid).toBe(first.pid);
        // It doesn't read the file again: the same dead token comes back after
        // the grace, so the platform replaces the process.
        f.platform.apps.timing.renewGraceMs = 100;
        await new Promise((resolve) => setTimeout(resolve, 150));
        // (Its process may be stopped before it answers: the computer runs in
        // this test's process here.)
        const again = await f.get('/data').catch(() => null);
        expect(again?.status ?? 401).toBe(401);
        const health = await until(
            () => f.platform.apps.health.get(app.id),
            (value) => /replaced its process/.test(value.lastRecoveryReason ?? ''),
        );
        expect(health).toMatchObject({ state: 'recovering', attempts: 1, lastError: null });
        expect(health.lastRecoveryAt).toBeGreaterThan(0);
        // The old process is gone (stopped by its process group), the new one
        // holds the port with a live token, and data access resumed.
        const now = await f.get('/data');
        expect(now.status).toBe(200);
        expect(now.pid).not.toBe(first.pid);
        await until(
            () => alive(first.pid),
            (value) => !value,
        );
        expect(f.log()).not.toMatch(/EADDRINUSE/);
        expect(f.runs.every((run) => run.exitCode === 0)).toBe(true);
        expect(f.notices).toEqual([]);
    });

    it('replaces the process on re-registration, tracked or not, without EADDRINUSE', async () => {
        const f = await fixture();
        // Its process group has a worker that doesn't listen on the port.
        await f.register(
            '',
            `cd tracker && { ${process.execPath} -e 'setInterval(() => {}, 1000)' server.mjs-worker & echo $! > worker.pid; } && exec ${process.execPath} server.mjs`,
        );
        const first = await f.up();
        const worker = Number(readFileSync(join(f.home, 'shared/tracker/worker.pid'), 'utf8').trim());
        started.add(worker);
        expect(alive(worker)).toBe(true);
        // An approved update registers it again: the tracked group goes first, worker too.
        await f.register();
        await until(
            () => alive(worker),
            (value) => !value,
        );
        const second = await until(
            () => f.get().catch(() => null),
            (value) => !!value && value.pid !== first.pid,
        );
        expect(alive(first.pid)).toBe(false);
        // A process from before tracking (no pid file) holding the port.
        rmSync(join(f.home, '.socio/apps/tracker.pid'));
        process.kill(-second.pid, 'SIGKILL');
        await until(
            () => alive(second.pid),
            (value) => !value,
        );
        const stray = spawn(process.execPath, ['server.mjs'], {
            cwd: join(f.home, 'shared/tracker'),
            env: { PORT: String(f.port), PATH: process.env.PATH },
            detached: true,
            stdio: 'ignore',
        });
        started.add(stray.pid!);
        await until(
            () => f.get().catch(() => null),
            (value) => value?.pid === stray.pid,
        );
        await f.register();
        const third = await until(
            () => f.get().catch(() => null),
            (value) => !!value && value.pid !== stray.pid,
        );
        expect(third.pid).not.toBe(stray.pid);
        expect(f.log()).not.toMatch(/EADDRINUSE/);
        expect(f.runs.every((run) => run.exitCode === 0)).toBe(true);
    });

    it('renews a refused token without a restart when the app reads it again', async () => {
        const f = await fixture();
        f.platform.apps.timing.renewGraceMs = 5_000;
        const app = await f.register('REREAD=1');
        const first = await f.up();
        f.platform.data.tokens.revokeSession(`app:${app.id}`);
        // Its next request (or the one after, once the file is renewed) works.
        const answer = await until(
            () => f.get('/data'),
            (value) => value.status === 200,
        );
        expect(answer.pid).toBe(first.pid);
        f.platform.apps.timing.renewGraceMs = 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        await f.platform.apps.checkHealth();
        expect(f.platform.apps.health.get(app.id)).toMatchObject({
            state: 'healthy',
            attempts: 0,
            lastRecoveryReason: 'renewed its data token without a restart',
        });
        expect((await f.get()).pid).toBe(first.pid);
        // One start: its registration's.
        expect(f.runs).toHaveLength(1);
    });

    it('counts a token it can’t deliver as a repair, with backoff (no retry on every 401)', async () => {
        const f = await fixture();
        const app = await f.register();
        await f.up();
        f.platform.data.tokens.revokeSession(`app:${app.id}`);
        // Its token file can't be written now (the computer service fails).
        const write = vi.mocked(f.platform.computers.writeFile);
        // (The renewal's write, then the repair's.)
        write.mockRejectedValueOnce(new Error('computer service unavailable'));
        write.mockRejectedValueOnce(new Error('computer service unavailable'));
        const writes = () => write.mock.calls.length;
        const before = writes();
        expect((await f.get('/data')).status).toBe(401);
        await until(
            () => f.platform.apps.health.get(app.id),
            (value) => value.state === 'degraded',
        );
        expect(f.platform.apps.health.get(app.id)).toMatchObject({
            attempts: 1,
            lastError: 'computer service unavailable',
            nextAttemptAt: expect.any(Number),
        });
        const tried = writes();
        expect(tried).toBeGreaterThan(before);
        // More refusals before the backoff's wait: nothing more is tried.
        for (let i = 0; i < 5; i++) {
            expect((await f.get('/data')).status).toBe(401);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        // Under repair: neither a renewal nor a repair until the wait is over.
        expect(f.platform.apps.health.get(app.id)).toMatchObject({ state: 'degraded', attempts: 1 });
        expect(writes()).toBe(tried);
        expect(f.runs).toHaveLength(1);
        // Delivery works again. With no further request, and its port still
        // answering, the tick retries the repair once the wait is over.
        const first = await f.get();
        vi.useFakeTimers({ toFake: ['Date'] });
        await f.platform.apps.checkHealth();
        expect(f.runs).toHaveLength(1);
        vi.setSystemTime(Date.now() + 61_000);
        await f.platform.apps.checkHealth();
        expect(f.runs).toHaveLength(2);
        expect(f.platform.apps.health.get(app.id)).toMatchObject({
            state: 'recovering',
            lastRecoveryReason: expect.stringMatching(/replaced its process/),
        });
        vi.useRealTimers();
        const now = await f.get('/data');
        expect(now).toMatchObject({ status: 200 });
        expect(now.pid).not.toBe(first.pid);
        // Nothing left to retry.
        await f.platform.apps.checkHealth();
        expect(f.runs).toHaveLength(2);
    });

    it('never calls an answering port healthy while its token can’t be delivered', async () => {
        const f = await fixture();
        const app = await f.register();
        await f.up();
        f.platform.data.tokens.revokeSession(`app:${app.id}`);
        vi.mocked(f.platform.computers.writeFile).mockRejectedValue(new Error('computer service unavailable'));
        expect((await f.get('/data')).status).toBe(401);
        await until(
            () => f.platform.apps.health.get(app.id),
            (value) => value.state === 'degraded',
        );
        vi.useFakeTimers({ toFake: ['Date'] });
        // The old process keeps answering on its port; every repair fails.
        for (let i = 0; i < 40; i++) {
            vi.setSystemTime(Date.now() + 5 * 60_000);
            await f.platform.apps.checkHealth();
        }
        expect(f.platform.apps.health.get(app.id)).toMatchObject({ state: 'failed', attempts: 6 });
        expect(f.notices).toHaveLength(1);
        expect(f.runs).toHaveLength(1);
    });

    it('shares an unresolved token repair: another runtime resumes it and never settles it early', async () => {
        const f = await fixture();
        const app = await f.register();
        await f.up();
        f.platform.data.tokens.revokeSession(`app:${app.id}`);
        vi.mocked(f.platform.computers.writeFile).mockRejectedValue(new Error('computer service unavailable'));
        expect((await f.get('/data')).status).toBe(401);
        await until(
            () => f.platform.apps.health.get(app.id),
            (value) => value.state === 'degraded',
        );
        // Another runtime on the same database (or this one after a restart):
        // a fresh book sees the pending repair.
        const other = new AppHealthBook((f.platform.apps as unknown as { db: DatabaseSync }).db, {
            name: () => 'Tracker',
        });
        expect(other.tokenRepairs()).toEqual([{ appId: app.id, reason: expect.stringMatching(/couldn’t be renewed/) }]);
        // Its port answers for far longer than the stability window: still not healthy.
        expect(await other.settle(app.id, Date.now(), Date.now() + 60 * 60_000)).toBe(false);
        expect(other.get(app.id)).toMatchObject({ state: 'degraded', attempts: 1 });
        // Delivery works again: the next due tick finishes it and clears the marker.
        vi.mocked(f.platform.computers.writeFile).mockRestore();
        vi.spyOn(f.platform.computers, 'writeFile').mockImplementation(async (_id, path, contents) => {
            mkdirSync(dirname(join(f.home, path)), { recursive: true });
            writeFileSync(join(f.home, path), contents);
        });
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 61_000);
        await f.platform.apps.checkHealth();
        expect(other.tokenRepairs()).toEqual([]);
        expect(other.get(app.id)).toMatchObject({
            state: 'recovering',
            lastRecoveryReason: expect.stringMatching(/replaced/),
        });
    });

    it('settles an app that came up after its repair’s deadline', async () => {
        const f = await fixture();
        f.platform.apps.timing.startGraceMs = 0;
        f.platform.apps.timing.upWaitMs = 200;
        const app = await f.register('', `sleep 2 && cd tracker && DATA_URL=x exec ${process.execPath} server.mjs`);
        await f.platform.apps.checkHealth();
        expect(f.platform.apps.health.get(app.id)).toMatchObject({ state: 'degraded', attempts: 1 });
        await f.up();
        vi.useFakeTimers({ toFake: ['Date'] });
        await f.platform.apps.checkHealth();
        vi.setSystemTime(Date.now() + 11 * 60_000);
        await f.platform.apps.checkHealth();
        expect(f.platform.apps.health.get(app.id)).toMatchObject({ state: 'healthy', attempts: 0, lastError: null });
        expect(f.runs).toHaveLength(2);
    });

    it('a new registration resets a failed app even when it can’t start yet', async () => {
        const f = await fixture();
        const app = await f.register('', 'exit 1');
        // Automatic repair gave up.
        const book = f.platform.apps.health;
        for (let i = 1; i <= 6; i++) {
            const claim = (await book.begin(app.id, `dev:${f.port}`, 'not answering', Date.now() + i * 60 * 60_000))!;
            await book.failed(claim, 'still not answering', Date.now() + i * 60 * 60_000);
        }
        expect(book.get(app.id)).toMatchObject({ state: 'failed' });
        // The corrected registration is saved, but the computer service fails just now.
        vi.mocked(f.platform.computers.writeFile).mockRejectedValueOnce(new Error('computer service unavailable'));
        await f.register();
        expect(book.get(app.id)).toMatchObject({ state: 'healthy', attempts: 0 });
        // Once it works again, the minute check starts it.
        f.platform.apps.timing.startGraceMs = 0;
        await f.platform.apps.checkHealth();
        expect((await f.up()).pid).toBeGreaterThan(0);
        expect(f.runs).toHaveLength(2);
    });

    it('a repair under way stops when the app is registered again meanwhile', async () => {
        const f = await fixture();
        f.platform.apps.timing.startGraceMs = 0;
        const app = await f.register('', 'exit 1');
        // The repair's token write waits until the corrected registration is in.
        const write = vi.mocked(f.platform.computers.writeFile);
        const original = write.getMockImplementation()!;
        let open!: () => void;
        const gate = new Promise<void>((resolve) => (open = resolve));
        write.mockImplementationOnce(async (...args) => {
            await gate;
            return original(...args);
        });
        const repair = f.platform.apps.checkHealth();
        await vi.waitFor(() => expect(f.platform.apps.health.get(app.id)).toMatchObject({ attempts: 1 }));
        await f.register();
        const corrected = await f.up();
        open();
        await repair;
        // The old repair didn't start the old command over the corrected one.
        expect(f.runs).toHaveLength(2);
        expect((await f.get()).pid).toBe(corrected.pid);
        expect(f.platform.apps.health.get(app.id)).toMatchObject({ state: 'healthy', attempts: 0 });
    });

    it('sharing an app while its repair runs neither stops the repair nor holds up the next', async () => {
        const f = await fixture();
        f.platform.apps.timing.startGraceMs = 0;
        f.platform.apps.timing.upWaitMs = 0;
        const app = await f.register('', 'exit 1');
        const write = vi.mocked(f.platform.computers.writeFile);
        const original = write.getMockImplementation()!;
        let open!: () => void;
        const gate = new Promise<void>((resolve) => (open = resolve));
        write.mockImplementationOnce(async (...args) => {
            await gate;
            return original(...args);
        });
        const repair = f.platform.apps.checkHealth();
        await vi.waitFor(() => expect(f.platform.apps.health.get(app.id)).toMatchObject({ attempts: 1 }));
        // The owner shares it meanwhile (its updatedAt changes).
        await f.platform.apps.share(app.id, 'alice', f.spaceId);
        open();
        await repair;
        // The repair went on: it ran its start, and failed (exit 1) as a repair.
        expect(f.runs).toHaveLength(2);
        expect(f.platform.apps.health.get(app.id)).toMatchObject({ state: 'degraded', attempts: 1 });
        // Its lease is gone: the next repair runs once its wait is over.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 61_000);
        await f.platform.apps.checkHealth();
        expect(f.runs).toHaveLength(3);
        expect(f.platform.apps.health.get(app.id)).toMatchObject({ attempts: 2 });
    });

    it('backs off from a crash loop, then gives up and tells admins once', async () => {
        const f = await fixture();
        f.platform.apps.timing.startGraceMs = 0;
        f.platform.apps.timing.upWaitMs = 0;
        const app = await f.register('', 'exit 1');
        expect(f.runs).toHaveLength(1);
        vi.useFakeTimers({ toFake: ['Date'] });
        const minute = 60_000;
        const repairs = () => f.runs.length - 1;
        const tick = async (wait: number) => {
            vi.setSystemTime(Date.now() + wait);
            await f.platform.apps.checkHealth();
            return repairs();
        };
        expect(await tick(0)).toBe(1);
        expect(f.platform.apps.health.get(app.id)).toMatchObject({ state: 'degraded', attempts: 1 });
        // Never a tight loop: 1 min, then 2, 4, 8 and 16 between repairs.
        expect(await tick(0)).toBe(1);
        expect(await tick(minute / 2)).toBe(1);
        expect(await tick(minute / 2)).toBe(2);
        expect(await tick(2 * minute)).toBe(3);
        expect(await tick(4 * minute)).toBe(4);
        expect(await tick(8 * minute)).toBe(5);
        expect(await tick(16 * minute)).toBe(6);
        // After six: no more, however long; admins were told once.
        for (let i = 0; i < 30; i++) {
            expect(await tick(10 * minute)).toBe(6);
        }
        expect(f.platform.apps.health.get(app.id)).toMatchObject({
            state: 'failed',
            attempts: 6,
            lastError: expect.stringMatching(/didn’t answer on port/),
        });
        expect(f.notices).toHaveLength(1);
        expect(f.notices[0]).toMatchObject({ trigger: 'app_recovery_failed', path: '/apps' });
        expect(f.platform.apps.healthSummary()).toMatchObject({
            watched: 1,
            unhealthy: [{ appId: app.id, state: 'failed', name: 'Tracker' }],
        });
        // A fixed registration that starts: the old repairs no longer apply.
        vi.useRealTimers();
        await f.register();
        await f.up();
        expect(f.platform.apps.health.get(app.id)).toMatchObject({ state: 'healthy', attempts: 0, lastError: null });
        vi.useFakeTimers({ toFake: ['Date'] });
        await f.register('', 'exit 1');
        // Its owner's Start tries again from the start.
        await f.platform.apps.start(app.id, 'alice');
        expect(f.platform.apps.health.get(app.id)).toMatchObject({ state: 'healthy', attempts: 0 });
        expect(await tick(0)).toBe(10);
        expect(existsSync(join(f.home, '.socio/apps/tracker.pid'))).toBe(true);
    });
});
