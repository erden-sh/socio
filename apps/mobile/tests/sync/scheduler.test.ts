import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UNREADABLE_RESPONSE } from '@socio/shared/reconnect';

import { NetworkError } from '../../src/net/errors';
import { HttpError } from '../../src/sync/errors';
import {
    awayDelay,
    COALESCE_MS,
    CONNECTED,
    createScheduler,
    FRESH_MS,
    FULL_POLL_MS,
    RECONNECT_SLOW_AFTER_MS,
    SHELL_POLL_MS,
    VISIBLE_POLL_MAX_MS,
} from '../../src/sync/scheduler';

import { CELLULAR, fakeAppState, fakeNetwork, fakeSource, OFFLINE, WIFI } from './fakes';

// The scheduler, on
// fake timers, with fake AppState and NetInfo events and fake sources: the
// triggers, the coalescing, one pull at a time, the 15 s shell poll, the
// 5-minute full poll, and the back-off while the server is away.

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const TAG = 'W/"v1.b1"';

beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
    vi.useRealTimers();
});

const elapsed = () => Date.now() - T0;
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** Advances to `ms` after T0. */
const advanceTo = (ms: number) => advance(ms - elapsed());

function setup({ app = 'active', network = WIFI, random = () => 0.5 } = {}) {
    const state = fakeSource('state');
    const workspace = fakeSource('workspace');
    const issues = fakeSource('issues');
    const appState = fakeAppState(app);
    const net = fakeNetwork(network);
    const errors: unknown[] = [];
    const scheduler = createScheduler({
        jobs: [
            { source: state, collections: ['shell', 'notices'], poll: true },
            { source: workspace, collections: ['shell', 'conversations', 'spaces', 'dots'], poll: true },
            // A module's kind: after the shell, polled only while its screen is in view.
            { source: issues, collections: ['issues', 'issue-users'], visiblePoll: 15_000, deferred: true },
        ],
        appState,
        network: net,
        onError: (error) => errors.push(error),
        random,
    });
    const times = (source: typeof state) => source.pulls.map((pull) => pull.at - T0);
    const cursors = (source: typeof state) => source.pulls.map((pull) => pull.cursor);
    return { state, workspace, issues, appState, net, scheduler, errors, times, cursors };
}

const away = () => new NetworkError('https://brain.example.test/api/state');
const proxyError = () => new HttpError('https://brain.example.test/api/state', 502, UNREADABLE_RESPONSE, undefined, '');
const serverError = () =>
    new HttpError('https://brain.example.test/api/state', 500, 'Boom', undefined, { error: 'Boom' });

describe('the scheduler’s triggers', () => {
    it('pulls every source in full 100 ms after it starts in the foreground, and nothing before start', async () => {
        const s = setup();
        await advance(60_000);
        expect(s.state.pulls).toEqual([]);
        s.scheduler.start();
        await advance(COALESCE_MS - 1);
        expect(s.state.pulls).toEqual([]);
        await advance(1);
        expect(s.times(s.state)).toEqual([60_100]);
        expect(s.times(s.workspace)).toEqual([60_100]);
        // No If-None-Match: a start is a return to the foreground.
        expect(s.cursors(s.state)).toEqual([null]);
        expect(s.cursors(s.workspace)).toEqual([null]);
    });

    it('waits in the background, and pulls in full on coming back after 10 s or more', async () => {
        const s = setup({ app: 'background' });
        s.scheduler.start();
        await advance(60_000);
        expect(s.state.pulls).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
        s.appState.set('active');
        await advance(COALESCE_MS);
        expect(s.times(s.state)).toEqual([60_100]);
        expect(s.cursors(s.workspace)).toEqual([null]);
    });

    it('pulls every job, polled or not, in full when the app comes to the foreground soon after a start in the background', async () => {
        const shell = fakeSource('state');
        const screen = fakeSource('issues');
        const appState = fakeAppState('background');
        const scheduler = createScheduler({
            jobs: [
                { source: shell, collections: ['shell'], poll: true },
                // A screen's source, which only pokes and views pull.
                { source: screen, collections: ['issues'] },
            ],
            appState,
            network: fakeNetwork(),
            random: () => 0.5,
        });
        const pulls = (source: typeof shell) => source.pulls.map((pull) => [pull.at - T0, pull.cursor]);
        scheduler.start();
        await advance(5000);
        expect(vi.getTimerCount()).toBe(0);
        // Less than 10 s: a brief leave, which resumes what waited, and the start's pulls waited.
        appState.set('active');
        await advance(COALESCE_MS);
        expect(pulls(shell)).toEqual([[5100, null]]);
        expect(pulls(screen)).toEqual([[5100, null]]);
        await advance(SHELL_POLL_MS);
        expect(pulls(shell)).toEqual([
            [5100, null],
            [20_100, TAG],
        ]);
        expect(screen.pulls).toHaveLength(1);
        scheduler.stop();
    });

    it('counts inactive as the foreground: going inactive and back pulls nothing', async () => {
        const s = setup({ app: 'inactive' });
        s.scheduler.start();
        await advance(COALESCE_MS);
        expect(s.times(s.state)).toEqual([100]);
        s.appState.set('active');
        s.appState.set('inactive');
        s.appState.set('active');
        await advanceTo(15_000);
        expect(s.times(s.state)).toEqual([100]);
        // Back from the background to inactive after 10 s is a return.
        s.appState.set('background');
        await advance(10_000);
        s.appState.set('inactive');
        await advance(COALESCE_MS);
        expect(s.times(s.state)).toEqual([100, 25_100]);
        expect(s.cursors(s.state)).toEqual([null, null]);
    });

    it('takes a brief trip to the background (a picker) as no return: the polls resume where they were', async () => {
        const s = setup();
        s.scheduler.start();
        await advance(COALESCE_MS);
        await advanceTo(3000);
        s.appState.set('background');
        await advanceTo(8000);
        s.appState.set('active');
        await advanceTo(15_099);
        expect(s.times(s.state)).toEqual([100]);
        await advanceTo(15_100);
        expect(s.times(s.state)).toEqual([100, 15_100]);
        expect(s.cursors(s.state)).toEqual([null, TAG]);
        // A longer one is a return: a full pull at once.
        await advanceTo(20_000);
        s.appState.set('background');
        await advanceTo(30_000);
        s.appState.set('active');
        await advance(COALESCE_MS);
        expect(s.times(s.state)).toEqual([100, 15_100, 30_100]);
        expect(s.cursors(s.state)).toEqual([null, TAG, null]);
    });

    it('keeps a poke made just before a brief trip to the background (a picker) for the return', async () => {
        const s = setup();
        s.scheduler.start();
        await advanceTo(1000);
        s.scheduler.poke(['state']);
        await advance(50);
        s.appState.set('background');
        expect(vi.getTimerCount()).toBe(0);
        await advanceTo(4000);
        expect(s.times(s.state)).toEqual([100]);
        s.appState.set('active');
        await advance(COALESCE_MS);
        expect(s.times(s.state)).toEqual([100, 4100]);
        expect(s.cursors(s.state)).toEqual([null, TAG]);
        // Only what was poked: the workspace's poll resumes where it was.
        expect(s.times(s.workspace)).toEqual([100]);
        await advanceTo(15_100);
        expect(s.times(s.workspace)).toEqual([100, 15_100]);
    });

    it('polls the shell 15 s after each pull ends, in the foreground only, with no timer left in the background', async () => {
        const s = setup();
        s.scheduler.start();
        await advanceTo(45_100);
        expect(s.times(s.state)).toEqual([100, 15_100, 30_100, 45_100]);
        expect(s.times(s.workspace)).toEqual([100, 15_100, 30_100, 45_100]);
        expect(s.cursors(s.workspace)).toEqual([null, TAG, TAG, TAG]);
        expect(SHELL_POLL_MS).toBe(15_000);
        s.appState.set('background');
        expect(vi.getTimerCount()).toBe(0);
        await advance(120_000);
        expect(s.state.pulls).toHaveLength(4);
    });

    it('pulls what a screen shows when its last answer is older than 5 s, and not again for a pull in flight', async () => {
        const s = setup();
        s.scheduler.start();
        await advance(COALESCE_MS);
        await advanceTo(2100);
        s.scheduler.view(['conversations']);
        await advance(COALESCE_MS);
        expect(s.times(s.workspace)).toEqual([100]);
        expect(FRESH_MS).toBe(5000);
        await advanceTo(5101);
        s.workspace.hold(true);
        s.scheduler.view(['conversations']);
        await advance(COALESCE_MS);
        // Only the source that fills the screen's collection.
        expect(s.times(s.workspace)).toEqual([100, 5201]);
        expect(s.times(s.state)).toEqual([100]);
        s.scheduler.view(['conversations']);
        s.workspace.release();
        await advance(1000);
        expect(s.times(s.workspace)).toEqual([100, 5201]);
    });

    it('pulls when the network comes back or changes type, in the foreground only', async () => {
        const s = setup();
        s.scheduler.start();
        await advanceTo(1000);
        s.net.set(CELLULAR);
        await advance(COALESCE_MS);
        expect(s.times(s.state)).toEqual([100, 1100]);
        expect(s.cursors(s.state)).toEqual([null, TAG]);
        s.net.set(OFFLINE);
        s.net.set({ connected: null, type: 'unknown' });
        await advance(1000);
        expect(s.state.pulls).toHaveLength(2);
        s.net.set(WIFI);
        await advance(COALESCE_MS);
        expect(s.times(s.workspace)).toEqual([100, 1100, 2200]);
        s.appState.set('background');
        s.net.set(CELLULAR);
        await advance(1000);
        expect(s.workspace.pulls).toHaveLength(3);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('pulls only the stale sources when the server version moves, once more after a pull in flight', async () => {
        const s = setup();
        s.scheduler.start();
        await advanceTo(1000);
        s.workspace.setStale(true);
        s.scheduler.stale();
        await advance(COALESCE_MS);
        expect(s.times(s.workspace)).toEqual([100, 1100]);
        expect(s.cursors(s.workspace)).toEqual([null, TAG]);
        expect(s.times(s.state)).toEqual([100]);
        s.workspace.hold(true);
        s.scheduler.poke(['workspace']);
        await advance(COALESCE_MS);
        s.workspace.setStale(true);
        s.scheduler.stale();
        s.workspace.hold(false);
        s.workspace.release();
        await advance(COALESCE_MS);
        expect(s.times(s.workspace)).toEqual([100, 1100, 1200, 1300]);
    });

    it('runs a pull in flight once more when this device’s write is confirmed in what it fills', async () => {
        const s = setup();
        s.scheduler.start();
        await advanceTo(1000);
        s.workspace.hold(true);
        s.state.hold(true);
        s.scheduler.poke();
        await advance(COALESCE_MS);
        s.scheduler.confirmed('conversations');
        s.workspace.hold(false);
        s.state.hold(false);
        s.workspace.release();
        s.state.release();
        await advance(COALESCE_MS);
        expect(s.times(s.workspace)).toEqual([100, 1100, 1200]);
        expect(s.times(s.state)).toEqual([100, 1100]);
        // Nothing in flight: a confirmation alone pulls nothing.
        s.scheduler.confirmed('notices');
        await advance(COALESCE_MS);
        expect(s.times(s.state)).toEqual([100, 1100]);
    });
});

describe('an answer another overtook', () => {
    it('asks once more when a pull comes back superseded, which vouches for nothing', async () => {
        const s = setup();
        s.scheduler.start();
        await advanceTo(1000);
        s.workspace.hold(true);
        s.scheduler.poke(['workspace']);
        await advance(COALESCE_MS);
        expect(s.times(s.workspace)).toEqual([100, 1100]);
        s.workspace.hold(false);
        s.workspace.release({ outcome: 'superseded' });
        await advance(COALESCE_MS);
        expect(s.times(s.workspace)).toEqual([100, 1100, 1200]);
        // That one answered: the next waits for the poll, 15 s after it.
        await advanceTo(1200 + SHELL_POLL_MS - 1);
        expect(s.workspace.pulls).toHaveLength(3);
        await advance(1);
        expect(s.times(s.workspace)).toEqual([100, 1100, 1200, 1200 + SHELL_POLL_MS]);
        expect(s.times(s.state)).toEqual([100, 15_100]);
    });
});

describe('coalescing and one pull at a time', () => {
    it('makes pokes within 100 ms of the first one pull, and a poke in flight one more after', async () => {
        const s = setup();
        s.scheduler.start();
        await advanceTo(1000);
        s.state.hold(true);
        for (let poke = 0; poke < 5; poke += 1) {
            s.scheduler.poke(['state']);
            await advance(20);
        }
        await advance(COALESCE_MS);
        expect(s.times(s.state)).toEqual([100, 1100]);
        // In flight: pokes wait for it, then go as one.
        s.scheduler.poke(['state']);
        s.scheduler.poke(['state']);
        s.scheduler.poke();
        await advance(500);
        expect(s.state.pulls).toHaveLength(2);
        s.state.release();
        await advance(COALESCE_MS);
        expect(s.state.pulls).toHaveLength(3);
        s.state.release();
        await advance(COALESCE_MS);
        expect(s.state.pulls).toHaveLength(3);
        expect(s.state.maxInFlight).toBe(1);
        expect(s.workspace.maxInFlight).toBe(1);
    });

    it('pulls every 100 ms at most under pokes that never stop', async () => {
        const s = setup();
        s.scheduler.start();
        await advanceTo(1000);
        for (let poke = 0; poke < 30; poke += 1) {
            s.scheduler.poke(['state']);
            await advance(10);
        }
        await advance(COALESCE_MS);
        // Pokes from 1000 to 1290 ms.
        expect(s.times(s.state)).toEqual([100, 1100, 1200, 1300]);
    });
});

describe('the full poll', () => {
    it('sends no If-None-Match once the last 200 is 5 minutes old, and on a return to the foreground', async () => {
        const s = setup();
        s.scheduler.start();
        await advanceTo(100 + FULL_POLL_MS + 15_000);
        const cursors = s.cursors(s.state);
        // A 200 at 100 ms; polls every 15 s get 304s; the first poll 5 minutes after the 200 asks in full.
        expect(s.times(s.state)[20]).toBe(100 + FULL_POLL_MS);
        expect(cursors.slice(0, 22)).toEqual([null, ...Array<string>(19).fill(TAG), null, TAG]);
        s.appState.set('background');
        await advance(10_000);
        s.appState.set('active');
        await advance(COALESCE_MS);
        expect(s.cursors(s.state).at(-1)).toBeNull();
    });

    it('owes a full poll that failed until one gets through, though the last 200 is recent', async () => {
        const s = setup();
        s.scheduler.start();
        await advanceTo(1000);
        // A 200 at 100 ms; a return at 20 s asks in full, and finds the server away.
        s.appState.set('background');
        await advanceTo(20_000);
        s.state.failWith(away);
        s.workspace.failWith(away);
        s.appState.set('active');
        await advance(COALESCE_MS);
        expect(s.times(s.state)).toEqual([100, 20_100]);
        s.state.failWith(null);
        s.workspace.failWith(null);
        await advanceTo(21_100);
        // The retry, 21 s after the last 200, is still the full poll the return asked for.
        expect(s.times(s.state)).toEqual([100, 20_100, 21_100]);
        expect(s.cursors(s.state)).toEqual([null, null, null]);
        // The workspace's own pull waited for that attempt (the state's failure came first): full too.
        expect(s.times(s.workspace)).toEqual([100, 21_100]);
        expect(s.cursors(s.workspace)).toEqual([null, null]);
        await advance(SHELL_POLL_MS);
        expect(s.cursors(s.state).at(-1)).toBe(TAG);
    });
});

describe('while the server is away', () => {
    it('waits 1, 2, 4, 8 then 10 s, rising to 20, 40 and 60 s once away longer than a deploy, saying Reconnecting…', async () => {
        const s = setup();
        const statuses: unknown[] = [];
        s.scheduler.subscribe(() => statuses.push(s.scheduler.status()));
        s.state.failWith(away);
        s.workspace.failWith(proxyError);
        s.scheduler.start();
        await advance(COALESCE_MS);
        expect(s.scheduler.status()).toEqual({ reconnecting: true, attempts: 1, retryAt: T0 + 1100 });
        await advanceTo(600_000);
        const times = s.times(s.state);
        const gaps = times.slice(1).map((time, index) => time - (times[index] ?? 0));
        expect(gaps).toEqual([
            1000,
            2000,
            4000,
            8000,
            ...Array<number>(35).fill(10_000),
            20_000,
            40_000,
            60_000,
            60_000,
        ]);
        // The slow waits start with the first failure past RECONNECT_SLOW_AFTER_MS.
        expect(times[39]).toBeGreaterThanOrEqual(100 + RECONNECT_SLOW_AFTER_MS);
        expect(times[38]).toBeLessThan(100 + RECONNECT_SLOW_AFTER_MS);
        // Both sources go in each attempt, and two failures in one attempt count once. The first
        // failure came before the workspace's first pull went, which waited for the next attempt.
        expect(s.times(s.workspace)).toEqual(times.slice(1));
        expect(s.scheduler.status().attempts).toBe(times.length);
        // Every attempt is still the full poll the start asked for, and no error went to onError.
        expect(new Set(s.cursors(s.state))).toEqual(new Set([null]));
        expect(s.errors).toEqual([]);
        expect(statuses.every((status) => (status as { reconnecting: boolean }).reconnecting)).toBe(true);
    });

    it('holds other pokes until the next attempt, and goes back to polling when an answer comes', async () => {
        const s = setup();
        s.state.failWith(away);
        s.workspace.failWith(away);
        s.scheduler.start();
        await advance(COALESCE_MS);
        // Waiting 1 s: pokes, screens and polls wait for it.
        s.scheduler.poke();
        s.scheduler.view(['conversations']);
        await advance(500);
        expect(s.times(s.state)).toEqual([100]);
        s.state.failWith(null);
        s.workspace.failWith(null);
        await advanceTo(1100);
        expect(s.times(s.state)).toEqual([100, 1100]);
        // Its first pull was about to go when the state's found the server away: it waited.
        expect(s.times(s.workspace)).toEqual([1100]);
        expect(s.scheduler.status()).toBe(CONNECTED);
        await advanceTo(16_100);
        expect(s.times(s.state)).toEqual([100, 1100, 16_100]);
    });

    it('starts the waits over at 1 s when the network comes back or the app returns', async () => {
        const s = setup();
        s.state.failWith(away);
        s.workspace.failWith(away);
        s.scheduler.start();
        // Attempts at 100, 1100, 3100, 7100 and 15 100: the next would be 10 s on.
        await advanceTo(16_000);
        expect(s.scheduler.status()).toEqual({ reconnecting: true, attempts: 5, retryAt: T0 + 25_100 });
        s.net.set(CELLULAR);
        expect(s.scheduler.status()).toEqual({ reconnecting: true, attempts: 0, retryAt: null });
        await advance(COALESCE_MS);
        expect(s.times(s.state).slice(-2)).toEqual([15_100, 16_100]);
        await advanceTo(17_100);
        expect(s.times(s.state).slice(-1)).toEqual([17_100]);
        // A return does the same, with a full poll.
        await advanceTo(17_500);
        s.appState.set('background');
        expect(vi.getTimerCount()).toBe(0);
        await advanceTo(40_000);
        s.appState.set('active');
        await advance(COALESCE_MS);
        await advance(1000);
        expect(s.times(s.state).slice(-2)).toEqual([40_100, 41_100]);
    });

    it('resumes its wait after a brief trip to the background', async () => {
        const s = setup();
        s.state.failWith(away);
        s.workspace.failWith(away);
        s.scheduler.start();
        await advanceTo(4000);
        // Waiting until 7100.
        s.appState.set('background');
        await advanceTo(6000);
        s.appState.set('active');
        await advanceTo(7099);
        expect(s.times(s.state)).toEqual([100, 1100, 3100]);
        await advanceTo(7100);
        expect(s.times(s.state)).toEqual([100, 1100, 3100, 7100]);
    });

    it('takes any answer as the server back: a 500 ends Reconnecting…, goes to onError, and keeps the cadence', async () => {
        const s = setup();
        s.state.failWith(away);
        s.workspace.failWith(away);
        s.scheduler.start();
        await advance(COALESCE_MS);
        expect(s.scheduler.status().reconnecting).toBe(true);
        s.state.failWith(serverError);
        s.workspace.failWith(null);
        await advanceTo(1100);
        expect(s.scheduler.status()).toBe(CONNECTED);
        expect(s.errors).toHaveLength(1);
        expect(s.errors[0]).toMatchObject({ status: 500 });
        await advanceTo(16_100);
        expect(s.times(s.state)).toEqual([100, 1100, 16_100]);
        expect(s.scheduler.status()).toBe(CONNECTED);
    });

    it('jitters each wait by a quarter, never past 10 s while fast nor 60 s while slow', () => {
        expect(awayDelay(0, null, () => 0)).toBe(750);
        expect(awayDelay(0, null, () => 0.999_999)).toBe(1250);
        expect(awayDelay(3, null, () => 0.999_999)).toBe(10_000);
        expect(awayDelay(9, null, () => 0)).toBe(7500);
        expect(awayDelay(40, 0, () => 0)).toBe(15_000);
        expect(awayDelay(40, 0, () => 0.999_999)).toBe(25_000);
        expect(awayDelay(40, 2, () => 0)).toBe(45_000);
        expect(awayDelay(40, 9, () => 0.999_999)).toBe(60_000);
    });
});

describe('stopping', () => {
    it('clears every timer and listener, and an answer after it starts nothing', async () => {
        const s = setup();
        s.scheduler.start();
        await advanceTo(1000);
        expect(s.appState.listeners).toBe(1);
        expect(s.net.listeners).toBe(1);
        s.state.hold(true);
        s.scheduler.poke(['state']);
        s.scheduler.poke(['workspace']);
        await advance(COALESCE_MS);
        let told = 0;
        s.scheduler.subscribe(() => {
            told += 1;
        });
        s.scheduler.stop();
        expect(vi.getTimerCount()).toBe(0);
        expect(s.appState.listeners).toBe(0);
        expect(s.net.listeners).toBe(0);
        s.state.release(away());
        await s.scheduler.idle();
        expect(vi.getTimerCount()).toBe(0);
        expect(told).toBe(0);
        s.scheduler.poke();
        s.scheduler.start();
        s.appState.set('background');
        s.appState.set('active');
        await advance(60_000);
        expect(s.times(s.state)).toEqual([100, 1100]);
        expect(s.times(s.workspace)).toEqual([100, 1100]);
    });
});

describe('a module kind’s visible-screen poll', () => {
    it('is pulled after the shell’s pulls end, never beside them', async () => {
        const s = setup();
        s.state.hold(true);
        s.scheduler.start();
        await advance(COALESCE_MS);
        expect(s.times(s.workspace)).toEqual([100]);
        expect(s.issues.pulls).toEqual([]);
        await advance(2000);
        expect(s.issues.pulls).toEqual([]);
        s.state.hold(false);
        s.state.release();
        await advance(COALESCE_MS);
        expect(s.times(s.issues)).toEqual([2200]);
        expect(s.cursors(s.issues)).toEqual([null]);
        // Not polled with no screen in view.
        await advance(60_000);
        expect(s.issues.pulls).toHaveLength(1);
    });

    it('polls every 15 s from the view, stops on blur, and never in the background', async () => {
        const s = setup();
        s.scheduler.start();
        await advanceTo(1000);
        expect(s.times(s.issues)).toEqual([100]);
        // Its first pull went once the shell's answers came. Fresh: no pull at once, the next one 15 s after the last ended.
        const leave = s.scheduler.view(['issues']);
        await advanceTo(15_099);
        expect(s.times(s.issues)).toEqual([100]);
        await advanceTo(15_100);
        expect(s.times(s.issues)).toEqual([100, 15_100]);
        await advanceTo(30_100);
        expect(s.times(s.issues)).toEqual([100, 15_100, 30_100]);
        expect(s.cursors(s.issues).slice(1)).toEqual([TAG, TAG]);

        // The background clears it; a return after 10 s or more pulls it in full, and it polls on.
        await advanceTo(35_000);
        s.appState.set('background');
        expect(vi.getTimerCount()).toBe(0);
        await advance(60_000);
        expect(s.issues.pulls).toHaveLength(3);
        s.appState.set('active');
        await advance(COALESCE_MS);
        expect(s.issues.pulls).toHaveLength(4);
        expect(s.cursors(s.issues).at(-1)).toBeNull();
        await advance(15_000);
        expect(s.issues.pulls).toHaveLength(5);

        leave();
        leave();
        const at = s.issues.pulls.length;
        await advance(120_000);
        expect(s.issues.pulls).toHaveLength(at);
    });

    it('keeps polling while another screen showing it stays in view', async () => {
        const s = setup();
        s.scheduler.start();
        await advanceTo(1000);
        const first = s.scheduler.view(['issues']);
        const second = s.scheduler.view(['issue-users']);
        first();
        await advanceTo(15_100);
        expect(s.times(s.issues)).toEqual([100, 15_100]);
        second();
        await advance(60_000);
        expect(s.issues.pulls).toHaveLength(2);
    });

    it('pulls at once on a view when its last answer is older than 5 s, and polls from that pull', async () => {
        const s = setup();
        s.scheduler.start();
        await advanceTo(10_000);
        s.scheduler.view(['issues']);
        await advance(COALESCE_MS);
        expect(s.times(s.issues)).toEqual([100, 10_100]);
        await advanceTo(25_100);
        expect(s.times(s.issues)).toEqual([100, 10_100, 25_100]);
    });

    it('backs off on a refusal (a 403), up to 5 minutes, keeps calling onError, and goes back to 15 s on an answer', async () => {
        const s = setup();
        s.scheduler.start();
        await advanceTo(1000);
        s.scheduler.view(['issues']);
        const forbidden = new HttpError('https://brain.example.test/api/issues', 403, 'Not allowed', undefined, {});
        s.issues.failWith(() => forbidden);
        await advanceTo(15_100);
        await advanceTo(15_100 + 30_000);
        await advanceTo(15_100 + 30_000 + 60_000);
        expect(s.times(s.issues)).toEqual([100, 15_100, 45_100, 105_100]);
        expect(s.errors.filter((error) => error === forbidden)).toHaveLength(3);
        expect(s.scheduler.status()).toBe(CONNECTED);
        // The wait doubles to 5 minutes, never past.
        await advance(10 * VISIBLE_POLL_MAX_MS);
        const gaps = s
            .times(s.issues)
            .slice(1)
            .map((at, i, all) => (i === 0 ? 0 : at - all[i - 1]!));
        expect(Math.max(...gaps)).toBe(VISIBLE_POLL_MAX_MS);
        s.issues.failWith(null);
        const last = s.times(s.issues).at(-1)!;
        await advanceTo(last + VISIBLE_POLL_MAX_MS);
        await advanceTo(last + VISIBLE_POLL_MAX_MS + 15_000);
        expect(s.times(s.issues).slice(-2)).toEqual([last + VISIBLE_POLL_MAX_MS, last + VISIBLE_POLL_MAX_MS + 15_000]);
    });
});

describe('a kind pulled only in view', () => {
    function inViewSetup() {
        const state = fakeSource('state');
        const runs = fakeSource('runs');
        const skills = fakeSource('skills');
        const appState = fakeAppState('active');
        const net = fakeNetwork(WIFI);
        const scheduler = createScheduler({
            jobs: [
                { source: state, collections: ['shell'], poll: true },
                { source: runs, collections: ['runs'], visiblePoll: 10_000, deferred: true, inView: true },
                // Skills: the web reads it once, with no poll.
                { source: skills, collections: ['skills'], deferred: true, inView: true },
            ],
            appState,
            network: net,
            random: () => 0.5,
        });
        const times = (source: typeof state) => source.pulls.map((pull) => pull.at - T0);
        return { state, runs, skills, appState, net, scheduler, times };
    }

    it('isn’t pulled by a start, a return, the network back, a poke of all or `stale` with no screen in view', async () => {
        const s = inViewSetup();
        s.runs.setStale(true);
        s.scheduler.start();
        await advance(60_000);
        expect(s.state.pulls.length).toBeGreaterThan(0);
        s.net.set(CELLULAR);
        s.scheduler.poke();
        s.scheduler.stale();
        s.appState.set('background');
        await advance(60_000);
        s.appState.set('active');
        await advance(60_000);
        expect(s.runs.pulls).toEqual([]);
        expect(s.skills.pulls).toEqual([]);
        // A poke that names it still pulls it (a write's notes).
        s.scheduler.poke(['runs']);
        await advance(COALESCE_MS);
        expect(s.runs.pulls).toHaveLength(1);
        s.scheduler.stop();
    });

    it('is pulled on its screen’s first view, polled every 10 s while it stays, and by a return while in view', async () => {
        const s = inViewSetup();
        s.scheduler.start();
        await advanceTo(1000);
        const leave = s.scheduler.view(['runs']);
        await advance(COALESCE_MS);
        expect(s.times(s.runs)).toEqual([1100]);
        expect(s.runs.pulls[0]?.cursor).toBeNull();
        await advanceTo(21_100);
        expect(s.times(s.runs)).toEqual([1100, 11_100, 21_100]);

        // In view, a return after 10 s or more pulls it in full with the shell.
        s.appState.set('background');
        await advance(30_000);
        s.appState.set('active');
        await advance(COALESCE_MS);
        expect(s.runs.pulls).toHaveLength(4);
        expect(s.runs.pulls.at(-1)?.cursor).toBeNull();

        leave();
        const at = s.runs.pulls.length;
        await advance(120_000);
        s.net.set(CELLULAR);
        await advance(COALESCE_MS);
        expect(s.runs.pulls).toHaveLength(at);
        s.scheduler.stop();
    });

    it('with no visible poll, is pulled on a view older than 5 s and never polled', async () => {
        const s = inViewSetup();
        s.scheduler.start();
        await advanceTo(1000);
        const leave = s.scheduler.view(['skills']);
        await advance(60_000);
        expect(s.times(s.skills)).toEqual([1100]);
        leave();
        s.scheduler.view(['skills']);
        await advance(COALESCE_MS);
        expect(s.times(s.skills)).toEqual([1100, 61_100]);
        s.scheduler.stop();
    });
});

describe('jobs added while it runs (a Space’s pages)', () => {
    it('pulls an added in-view job only on its scope’s view, polls it while shown, and stops once removed', async () => {
        const s = setup();
        s.scheduler.start();
        await advance(COALESCE_MS);
        const everyday = fakeSource('pages');
        const ops = fakeSource('pages');
        const job = { collections: ['pages'], visiblePoll: 15_000, inView: true, deferred: true };
        const removeEveryday = s.scheduler.add({ ...job, source: everyday, scope: 'everyday' });
        s.scheduler.add({ ...job, source: ops, scope: 'ops' });
        // A poke of all and the network back skip a job no screen shows.
        s.scheduler.poke();
        s.net.set(CELLULAR);
        await advance(1000);
        expect(everyday.pulls).toEqual([]);

        // Only the Space in view pulls, and polls every 15 s while it shows.
        const leave = s.scheduler.view(['pages'], 'everyday');
        await advance(COALESCE_MS);
        expect(everyday.pulls).toHaveLength(1);
        expect(ops.pulls).toEqual([]);
        await advance(15_000);
        expect(everyday.pulls).toHaveLength(2);

        // Removed: no poll, no pull, even in view.
        removeEveryday();
        removeEveryday();
        await advance(60_000);
        s.scheduler.poke(['pages']);
        await advance(COALESCE_MS);
        expect(everyday.pulls).toHaveLength(2);
        leave();
        s.scheduler.stop();
    });

    it('pulls an added job that isn’t in-view at once, as a full poll', async () => {
        const s = setup();
        s.scheduler.start();
        await advance(COALESCE_MS);
        const extra = fakeSource('extra');
        s.scheduler.add({ source: extra, collections: ['extra'] });
        await advance(COALESCE_MS);
        expect(s.cursors(extra)).toEqual([null]);
        s.scheduler.stop();
    });
});

describe('pull to refresh', () => {
    it('pulls the jobs that fill the collections now, fresh or not, and resolves once their pulls end', async () => {
        const s = setup();
        s.scheduler.start();
        await advance(COALESCE_MS);
        // Fresh (just pulled), the shell's sources would skip a view; a refresh pulls them anyway.
        s.workspace.hold(true);
        let done = false;
        const refreshing = s.scheduler.refresh(['conversations', 'issues']).then(() => {
            done = true;
        });
        await advance(COALESCE_MS);
        expect(s.times(s.workspace)).toEqual([100, 200]);
        // `state` fills neither collection: left alone.
        expect(s.times(s.state)).toEqual([100]);
        expect(done).toBe(false);
        s.workspace.release();
        await advance(COALESCE_MS);
        await refreshing;
        expect(done).toBe(true);
        // The issues kind waited for the shell's pull (a deferred kind), then went too.
        expect(s.issues.pulls.length).toBe(2);
    });

    it('resolves at once in the background, sending nothing until the app is back', async () => {
        const s = setup({ app: 'background' });
        s.scheduler.start();
        await s.scheduler.refresh(['conversations']);
        expect(s.workspace.pulls).toEqual([]);
    });
});
