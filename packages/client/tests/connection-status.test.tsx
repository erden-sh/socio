// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '../src/lib/api';
import {
    connectionHeartbeat,
    connectionState,
    connectionStatus,
    FIRST_SAMPLE_MS,
    LATENCY_SAMPLES,
    latencyQuality,
    PING_PATH,
    pollHeartbeat,
    resetConnectionStatus,
    SAMPLE_EVERY_MS,
    sampleLatency,
} from '../src/shell/connection-status';
import { ConnectionBadge, ConnectionDot } from '../src/shell/ConnectionBadge';

// CB-263: the header's connection badge. Online, reconnecting or offline
// from the shell poll's heartbeats and the browser; the round trip from a
// sparse ping that stops while the tab is hidden.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root;
let host: HTMLElement;
let pings: { url: string; init?: RequestInit }[];
let answer: 'ok' | 'away' | 'down';
let visibility: DocumentVisibilityState;
let onLine: boolean;

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    resetConnectionStatus();
    pings = [];
    answer = 'ok';
    visibility = 'visible';
    onLine = true;
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => onLine);
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        pings.push({ url, init });
        if (answer === 'down') {
            throw new TypeError('Failed to fetch');
        }
        return new Response(null, { status: answer === 'away' ? 502 : 204 });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

const settle = () => act(async () => void (await Promise.resolve()));
const badge = () => host.querySelector<HTMLButtonElement>('[data-slot="connection-badge"]');
// The account row's dot (CB-308).
const dot = () => host.querySelector<HTMLButtonElement>('[data-slot="connection-dot"]')!;
const announcement = () => host.querySelector('[data-slot="connection-announcement"]')!;

it('times an uncached ping and keeps the last few round trips', async () => {
    let now = 0;
    const clock = () => now;
    const request = (async () => {
        now += 42;
        return new Response(null, { status: 204 });
    }) as typeof fetch;
    expect(await sampleLatency({ request, clock, now: () => 1000 })).toBe(42);
    expect(connectionStatus()).toMatchObject({
        reachable: true,
        latencies: [42],
        lastCheck: 1000,
        lastSample: 1000,
    });
    for (let i = 0; i < LATENCY_SAMPLES + 2; i++) {
        await sampleLatency({ request, clock });
    }
    expect(connectionStatus().latencies).toHaveLength(LATENCY_SAMPLES);
    await sampleLatency();
    expect(pings[0].url).toBe(PING_PATH);
    expect(pings[0].init?.cache).toBe('no-store');
});

it('counts a proxy’s answer or none as a missed heartbeat, and remembers when it went', async () => {
    answer = 'away';
    expect(await sampleLatency({ now: () => 5 })).toBeUndefined();
    expect(connectionStatus()).toMatchObject({
        reachable: false,
        lastDisconnect: 5,
        latencies: [],
    });
    answer = 'down';
    await sampleLatency({ now: () => 9 });
    // Still the first moment it stopped answering.
    expect(connectionStatus().lastDisconnect).toBe(5);
    answer = 'ok';
    await sampleLatency({ now: () => 12 });
    expect(connectionStatus()).toMatchObject({
        reachable: true,
        lastDisconnect: 5,
        lastCheck: 12,
    });
});

it('asks nothing while the browser is offline, and sends one ping at a time', async () => {
    onLine = false;
    expect(await sampleLatency()).toBeUndefined();
    expect(pings).toHaveLength(0);
    onLine = true;
    const [a, b] = [sampleLatency(), sampleLatency()];
    expect(a).toBe(b);
    await a;
    expect(pings).toHaveLength(1);
});

it('reads the shell poll as a heartbeat: an explained error is still an answer', () => {
    pollHeartbeat(new ApiError('Sign in.', 401));
    expect(connectionStatus().reachable).toBe(true);
    pollHeartbeat(new TypeError('Failed to fetch'));
    expect(connectionStatus().reachable).toBe(false);
    pollHeartbeat(Object.assign(new Error('Bad gateway'), { status: 502 }));
    expect(connectionStatus().reachable).toBe(false);
    pollHeartbeat();
    expect(connectionStatus().reachable).toBe(true);
});

it('puts the browser’s offline first, and grades round trips', () => {
    expect(connectionState(true, { reachable: true })).toBe('offline');
    expect(connectionState(false, { reachable: false })).toBe('reconnecting');
    expect(connectionState(false, { reachable: true })).toBe('online');
    expect(latencyQuality(80)).toBe('good');
    expect(latencyQuality(450)).toBe('fair');
    expect(latencyQuality(1500)).toBe('slow');
});

const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

it('samples once the page has settled, every 30 s while visible, and not while hidden', async () => {
    vi.useFakeTimers();
    act(() => root.render(<ConnectionBadge />));
    await settle();
    // Not while the page hydrates.
    expect(pings).toHaveLength(0);
    await wait(FIRST_SAMPLE_MS);
    expect(pings).toHaveLength(1);
    await wait(SAMPLE_EVERY_MS);
    expect(pings).toHaveLength(2);
    // Hidden: no more pings, however long.
    visibility = 'hidden';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await wait(5 * SAMPLE_EVERY_MS);
    expect(pings).toHaveLength(2);
    // Shown again after a while: one at once, then on the interval.
    visibility = 'visible';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await settle();
    expect(pings).toHaveLength(3);
    // A quick hide and show doesn't ask again before it is due.
    visibility = 'hidden';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    visibility = 'visible';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await settle();
    expect(pings).toHaveLength(3);
    // Unmounted: nothing more.
    act(() => root.unmount());
    root = createRoot(host);
    await wait(2 * SAMPLE_EVERY_MS);
    expect(pings).toHaveLength(3);
});

it('stays quiet while healthy, says reconnecting or offline, and announces only the return', async () => {
    act(() =>
        root.render(
            <>
                <ConnectionBadge />
                <ConnectionDot />
            </>,
        ),
    );
    await act(async () => void (await sampleLatency()));
    // Healthy: no header badge, only the account row's dot.
    expect(badge()).toBeNull();
    expect(dot().dataset.stateConnection).toBe('online');
    expect(dot().getAttribute('aria-label')).toMatch(/^Connection: Online, \d+ ms, good$/);
    expect(dot().textContent).toBe('');
    expect(announcement().getAttribute('aria-live')).toBe('polite');
    expect(announcement().textContent).toBe('');
    // The poll lost the server: the shell's toast announces that, and the
    // header says so, whether the sidebar is open or not.
    act(() => connectionHeartbeat(false));
    expect(badge()!.dataset.stateConnection).toBe('reconnecting');
    expect(badge()!.getAttribute('aria-label')).toBe('Connection: Reconnecting');
    expect(badge()!.textContent).toBe('Reconnecting');
    expect(dot().dataset.stateConnection).toBe('reconnecting');
    expect(announcement().textContent).toBe('');
    // The browser went offline too.
    onLine = false;
    act(() => void window.dispatchEvent(new Event('offline')));
    expect(badge()!.dataset.stateConnection).toBe('offline');
    expect(badge()!.textContent).toBe('Offline');
    expect(dot().getAttribute('aria-label')).toBe('Connection: Offline');
    // Back: the badge goes away and says so once.
    onLine = true;
    act(() => {
        window.dispatchEvent(new Event('online'));
        connectionHeartbeat(true);
    });
    await settle();
    expect(badge()).toBeNull();
    expect(dot().dataset.stateConnection).toBe('online');
    expect(announcement().textContent).toBe('Connection to Socio restored.');
});

it('shows the details on tap: state, round trips, last check and last disconnect', async () => {
    let now = 0;
    const request = (async () => {
        now += 120;
        return new Response(null, { status: 204 });
    }) as typeof fetch;
    await sampleLatency({ request, clock: () => now });
    await sampleLatency({ request, clock: () => now });
    connectionHeartbeat(false, Date.UTC(2026, 9, 27, 15, 4, 5));
    connectionHeartbeat(true, Date.UTC(2026, 9, 27, 15, 4, 9));
    act(() => root.render(<ConnectionDot />));
    await settle();
    act(() => dot().click());
    const details = document.querySelector('[data-slot="connection-details"]')!;
    expect(details).not.toBeNull();
    expect(details.getAttribute('aria-labelledby')).toBeTruthy();
    const text = details.textContent!;
    expect(text).toContain('Connection to Socio');
    expect(text).toContain('StatusOnline');
    expect(text).toMatch(/Round trip\d+ ms \(good\)/);
    expect(text).toMatch(/Recent120 ms, 120 ms/);
    expect(details.querySelectorAll('time')).toHaveLength(2);
    expect(details.querySelectorAll('time')[1].getAttribute('datetime')).toBe('2026-10-27T15:04:05.000Z');
    // Tapping again closes it.
    act(() => dot().click());
    expect(document.querySelector('[data-slot="connection-details"]')).toBeNull();
});
