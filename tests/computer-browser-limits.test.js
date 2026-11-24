import { spawn } from 'node:child_process';
import console from 'node:console';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { pathToFileURL, URL } from 'node:url';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
    answers,
    browserAnswers,
    browserPidFor,
    browserStateOf,
    closeOrKill,
    killBrowser,
    pageAnswers,
    startTimeOf,
    STUCK_CLOSE_MS,
    STUCK_LAUNCH_MS,
} from '../deployment/computers/browser-guard.js';
import {
    hardenComputerIndex,
    hardenComputerProfiles,
    jpegScreenshots,
} from '../deployment/computers/harden-computer.mjs';
import { hardenSupervisorDocker } from '../deployment/computers/harden-supervisor.mjs';

// The pinned OpenBot source (b6932d3, MIT) the build-time patches apply to.
const upstream = (name) => readFileSync(new URL(`./fixtures/openbot-b6932d3/${name}.txt`, import.meta.url), 'utf8');
const temps = [];
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const dir of temps.splice(0)) {
        rmSync(dir, { recursive: true });
    }
});

it('patches the pinned computer and supervisor, and refuses a changed upstream', () => {
    const profiles = hardenComputerProfiles(upstream('profiles.ts'));
    expect(profiles).toContain('closeOrKill(context.close(), kill)');
    expect(profiles).toContain('await answers(existing.page, existing.context.browser())');
    expect(profiles).toContain('killBrowser(pid, dir, startedAt)');
    expect(hardenComputerIndex(upstream('index-health.ts'))).toContain('browserState: profiles.browserState(botId)');
    const docker = hardenSupervisorDocker(upstream('docker.ts'));
    expect(docker).toContain('Init: true');
    expect(docker).toContain("j.browserState !== 'stuck'");
    expect(docker).toContain('health: healthOf(container.Status)');
    for (const harden of [hardenComputerProfiles, hardenComputerIndex, hardenSupervisorDocker]) {
        expect(() => harden('changed upstream')).toThrow(/contract changed/);
    }
    const twice = upstream('profiles.ts').replace(
        'const closing = new Map<string, Promise<void>>();',
        (line) => `${line}\n${line}`,
    );
    expect(() => hardenComputerProfiles(twice)).toThrow(/contract changed/);
});

it('lets a screenshot be asked for as JPEG, a PNG otherwise, and refuses a changed upstream (CB-157)', () => {
    const patched = jpegScreenshots(upstream('index-screenshot.ts'));
    expect(patched).toContain('url.searchParams.get("type") === "jpeg"');
    expect(patched).not.toContain('const buffer = await target.screenshot({ type: "png" });');
    expect(() => jpegScreenshots('changed upstream')).toThrow(/contract changed/);
    expect(patched).toContain('target.screenshot(jpeg ? { type: "jpeg", quality } : { type: "png" })');
    expect(patched).toContain('Math.min(95, Math.max(30,');
});

/** The patched (or, with `patched` false, the pinned) profiles.ts, on a fake Playwright. */
async function loadProfiles(patched = true) {
    const dir = mkdtempSync(join(tmpdir(), 'cb125-profiles-'));
    temps.push(dir);
    for (const name of [
        'bot-id',
        'browser-runtime',
        'browser-mode',
        'browser-eviction',
        'egress',
        'env',
        'live-page',
        'profile-listing',
    ]) {
        writeFileSync(join(dir, `${name}.ts`), upstream(`${name}.ts`));
    }
    copyFileSync(new URL('../deployment/computers/browser-guard.ts', import.meta.url), join(dir, 'browser-guard.ts'));
    const source = upstream('profiles.ts');
    writeFileSync(
        join(dir, 'profiles.ts'),
        (patched ? hardenComputerProfiles(source) : source)
            .replace('from "playwright"', 'from "./fake-playwright"')
            .replace('from "node:fs/promises"', 'from "./fake-fs"'),
    );
    // The profile deletion, slowed down by a test that sets cb125Rm.
    writeFileSync(
        join(dir, 'fake-fs.ts'),
        `import * as fs from "node:fs/promises";
export const readdir = fs.readdir;
export const rm = (...args: Parameters<typeof fs.rm>) => ((globalThis as any).cb125Rm ?? fs.rm)(...args);`,
    );
    writeFileSync(
        join(dir, 'fake-playwright.ts'),
        'export const chromium = { launchPersistentContext: (...args: unknown[]) => (globalThis as any).cb125Launch(...args) };',
    );
    return import(pathToFileURL(join(dir, 'profiles.ts')).href);
}

/**
 * A browser that can die without telling anyone, as the CRM Analyst's did, or
 * whose page can be busy (a script holding its main thread) while the browser
 * itself answers.
 */
function fakeBrowser() {
    const listeners = { context: {}, browser: {} };
    const on = (map) => (event, fn) => (map[event] ??= []).push(fn);
    const state = { dead: false, busy: false, connected: true, closes: 0 };
    const never = () => new Promise(() => {});
    const page = {
        evaluate: () => (state.dead || state.busy ? never() : Promise.resolve(1)),
        isClosed: () => false,
        on: () => {},
        url: () => 'about:blank',
    };
    const browser = {
        isConnected: () => state.connected,
        on: on(listeners.browser),
        newBrowserCDPSession: async () => {
            if (state.dead) {
                return never();
            }
            return {
                send: async () => ({ product: 'Chrome/fake' }),
                detach: async () => {},
            };
        },
    };
    const context = {
        pages: () => [page],
        newPage: async () => page,
        on: on(listeners.context),
        browser: () => browser,
        close: () => {
            state.closes += 1;
            return state.dead ? never() : Promise.resolve();
        },
    };
    return {
        context,
        page,
        state,
        disconnect() {
            state.connected = false;
            for (const fn of listeners.browser.disconnected ?? []) {
                fn();
            }
        },
    };
}

function launcher() {
    const browsers = [];
    globalThis.cb125Launch = async () => {
        const browser = fakeBrowser();
        browsers.push(browser);
        return browser.context;
    };
    return browsers;
}

beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
});

/** A page() call, and what it has answered so far. */
function pending(promise) {
    const call = { promise, settled: false };
    promise.then(
        () => (call.settled = true),
        () => (call.settled = true),
    );
    return call;
}

it('cuts off a close a dead browser never answers, and the next page() starts a new one', async () => {
    vi.useFakeTimers();
    const { createProfiles } = await loadProfiles();
    const browsers = launcher();
    const root = mkdtempSync(join(tmpdir(), 'cb125-root-'));
    temps.push(root);
    const profiles = createProfiles(root, () => {});
    expect(await profiles.page('dot')).toBe(browsers[0].page);
    browsers[0].state.dead = true;
    // The idle sweep's close, which never finished in production.
    const stopped = pending(profiles.stop('dot'));
    await vi.advanceTimersByTimeAsync(0);
    expect(profiles.browserState('dot')).toBe('closing');
    const next = pending(profiles.page('dot'));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(stopped.settled || next.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await stopped.promise).toBe(true);
    expect(await next.promise).toBe(browsers[1].page);
    expect(profiles.browserState('dot')).toBe('running');
});

it('reproduces the hang on the pinned upstream source', async () => {
    vi.useFakeTimers();
    const { createProfiles } = await loadProfiles(false);
    const browsers = launcher();
    const root = mkdtempSync(join(tmpdir(), 'cb125-root-'));
    temps.push(root);
    const profiles = createProfiles(root, () => {});
    await profiles.page('dot');
    browsers[0].state.dead = true;
    const stopped = pending(profiles.stop('dot'));
    await vi.advanceTimersByTimeAsync(0);
    const next = pending(profiles.page('dot'));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stopped.settled || next.settled).toBe(false);
    expect(browsers).toHaveLength(1);
});

it('replaces a browser that does not answer, or that disconnected, instead of reusing it', async () => {
    vi.useFakeTimers();
    const { createProfiles } = await loadProfiles();
    const browsers = launcher();
    const root = mkdtempSync(join(tmpdir(), 'cb125-root-'));
    temps.push(root);
    const profiles = createProfiles(root, () => {});
    await profiles.page('dot');
    // Connected, but neither its page nor the browser answers: Playwright has not noticed.
    browsers[0].state.dead = true;
    const next = pending(profiles.page('dot'));
    await vi.advanceTimersByTimeAsync(5_500);
    expect(next.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await next.promise).toBe(browsers[1].page);
    // Disconnected: dropped at once, with no probe to wait for.
    browsers[1].disconnect();
    expect(profiles.browserState('dot')).toBe('stopped');
    expect(await profiles.page('dot')).toBe(browsers[2].page);
});

it('hands out a busy page as it is when its browser answers', async () => {
    vi.useFakeTimers();
    const { createProfiles } = await loadProfiles();
    const browsers = launcher();
    const root = mkdtempSync(join(tmpdir(), 'cb125-root-'));
    temps.push(root);
    const profiles = createProfiles(root, () => {});
    await profiles.page('dot');
    // A page whose own script holds its main thread: its evaluate waits, the browser does not.
    browsers[0].state.busy = true;
    const next = pending(profiles.page('dot'));
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await next.promise).toBe(browsers[0].page);
    expect(browsers).toHaveLength(1);
    expect(browsers[0].state.closes).toBe(0);
    expect(profiles.browserState('dot')).toBe('running');
    expect(console.info.mock.calls.some(([line]) => String(line).includes('computer-browser-replaced'))).toBe(false);
});

it('never starts a browser on a profile a reset is still deleting', async () => {
    vi.useFakeTimers();
    const { createProfiles } = await loadProfiles();
    const browsers = launcher();
    const root = mkdtempSync(join(tmpdir(), 'cb125-root-'));
    temps.push(root);
    const profiles = createProfiles(root, () => {});
    await profiles.page('dot');
    const { promise: removed, resolve: finishRemoval } = Promise.withResolvers();
    // Only the profile's deletion is slow; the launch's lock sweep is not.
    globalThis.cb125Rm = (path, options) => (options?.recursive ? removed : rm(path, options));
    try {
        const reset = pending(profiles.reset('dot'));
        await vi.advanceTimersByTimeAsync(0);
        const next = pending(profiles.page('dot'));
        // Past the 30 s a close is waited on: a deletion is waited on until it is done.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(reset.settled || next.settled).toBe(false);
        expect(browsers).toHaveLength(1);
        finishRemoval();
        await vi.advanceTimersByTimeAsync(0);
        await reset.promise;
        expect(await next.promise).toBe(browsers[1].page);
    } finally {
        delete globalThis.cb125Rm;
    }
});

it('reports a launch that never finishes as stuck', async () => {
    vi.useFakeTimers();
    const { createProfiles } = await loadProfiles();
    globalThis.cb125Launch = () => new Promise(() => {});
    const root = mkdtempSync(join(tmpdir(), 'cb125-root-'));
    temps.push(root);
    const profiles = createProfiles(root, () => {});
    void profiles.page('dot');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(profiles.browserState('dot')).toBe('starting');
    await vi.advanceTimersByTimeAsync(STUCK_LAUNCH_MS);
    expect(profiles.browserState('dot')).toBe('stuck');
});

it('kills a browser process group that will not close, and only a browser', async () => {
    const dir = '/profiles/cb125-test';
    // A stand-in browser: a group leader with the profile argument, and a child.
    const browser = spawn('sh', ['-c', 'sleep 30 & wait', 'sh', `--user-data-dir=${dir}`], {
        detached: true,
        stdio: 'ignore',
    });
    const other = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
        await vi.waitFor(() => expect(browserPidFor(dir)).toBe(browser.pid));
        // A pid that is not this profile's browser is refused, and so is one that
        // started at another time than the browser did: the pid was reused.
        expect(killBrowser(other.pid, dir)).toBe(false);
        expect(other.exitCode).toBeNull();
        const startedAt = startTimeOf(browser.pid);
        expect(startedAt).toMatch(/^\d+$/);
        expect(killBrowser(browser.pid, dir, `${startedAt}1`)).toBe(false);
        expect(browser.exitCode).toBeNull();
        const exited = new Promise((resolve) => browser.once('exit', resolve));
        expect(await closeOrKill(new Promise(() => {}), () => killBrowser(browser.pid, dir, startedAt), 50)).toBe(
            'killed',
        );
        await exited;
        // The whole group went, the child too.
        await vi.waitFor(() => expect(() => process.kill(-browser.pid, 0)).toThrow());
        expect(await closeOrKill(Promise.resolve(), () => 'unused', 50)).toBe('closed');
    } finally {
        other.kill('SIGKILL');
        if (browser.exitCode === null && browser.signalCode === null) {
            process.kill(-browser.pid, 'SIGKILL');
        }
    }
});

it('tells a page that answers from one that does not, and asks the browser when it is busy', async () => {
    const page = (evaluate, closed = false) => ({
        evaluate,
        isClosed: () => closed,
    });
    const hangs = () => new Promise(() => {});
    expect(
        await pageAnswers(
            page(async () => 1),
            20,
        ),
    ).toBe('answered');
    expect(await pageAnswers(page(hangs), 20)).toBe('busy');
    // A navigation replacing the document still got an answer.
    expect(
        await pageAnswers(
            page(async () => {
                throw new Error('Execution context was destroyed');
            }),
            20,
        ),
    ).toBe('answered');
    expect(
        await pageAnswers(
            page(async () => {
                throw new Error('Target crashed');
            }),
            20,
        ),
    ).toBe('gone');
    expect(
        await pageAnswers(
            page(async () => {
                throw new Error('gone');
            }, true),
            20,
        ),
    ).toBe('gone');
    const detached = [];
    const browser = (send) => ({
        newBrowserCDPSession: async () => ({
            send,
            detach: async () => detached.push(true),
        }),
    });
    const answering = browser(async () => ({ product: 'Chrome' }));
    expect(await browserAnswers(answering, 20)).toBe(true);
    expect(detached).toHaveLength(1);
    expect(await browserAnswers(browser(hangs), 20)).toBe(false);
    expect(
        await browserAnswers(
            browser(async () => {
                throw new Error('Target closed');
            }),
            20,
        ),
    ).toBe(false);
    expect(await browserAnswers({ newBrowserCDPSession: hangs }, 20)).toBe(false);
    expect(await browserAnswers(null, 20)).toBe(false);
    // A busy page is alive while its browser answers, and dead when it does not.
    expect(await answers(page(hangs), answering, 20, 20)).toBe(true);
    expect(await answers(page(hangs), browser(hangs), 20, 20)).toBe(false);
    // A crashed page is not saved by its browser answering.
    expect(
        await answers(
            page(async () => {
                throw new Error('Target crashed');
            }),
            answering,
            20,
            20,
        ),
    ).toBe(false);
    const now = 1_000_000;
    expect(browserStateOf({ running: true }, now)).toBe('running');
    expect(browserStateOf({ running: false }, now)).toBe('stopped');
    expect(browserStateOf({ running: false, closingSince: now - 1 }, now)).toBe('closing');
    expect(browserStateOf({ running: false, closingSince: now - STUCK_CLOSE_MS - 1 }, now)).toBe('stuck');
});
