import { useEffect, useSyncExternalStore } from 'react';

import { useOffline } from '../hooks/use-offline';
import { browserOffline } from '../lib/api';

import { serverAway } from './reconnect';

/**
 * How the app's connection to the server is doing (CB-263), for the
 * header's badge: online, reconnecting or offline, and the round trip.
 *
 * Whether the server answers comes from the shell's own poll, which runs
 * anyway (`connectionHeartbeat`, App.tsx). The round trip is a separate,
 * sparse sample: an empty `GET /ping` every 30 s while the tab is visible,
 * none while it is hidden or the browser is offline. The poll's own time
 * would include the server's work on `/state` and `/workspace`.
 */

/** The server's empty answer (app.ts): 204, no body, no session needed. */
export const PING_PATH = '/ping';
/** How often a visible tab samples the round trip. */
export const SAMPLE_EVERY_MS = 30_000;
/**
 * The first sample waits this long after the page loads: while it
 * hydrates, the main thread is busy and the round trip reads slow.
 */
export const FIRST_SAMPLE_MS = 2000;
/** A ping slower than this counts as no answer. */
export const PING_TIMEOUT_MS = 10_000;
/** How many recent round trips the details show. */
export const LATENCY_SAMPLES = 5;
/** Round trips under these are good, then fair; slower ones are slow. */
export const FAIR_MS = 300;
export const SLOW_MS = 1000;

export type ConnectionState = 'online' | 'reconnecting' | 'offline';
export type LatencyQuality = 'good' | 'fair' | 'slow';

export interface ConnectionStatus {
    /** The server answered the last heartbeat or ping. */
    reachable: boolean;
    /** Recent round trips in ms, oldest first, at most `LATENCY_SAMPLES`. */
    latencies: readonly number[];
    /** When the server last answered, or failed to. */
    lastCheck?: number;
    /** When it last stopped answering. */
    lastDisconnect?: number;
    /** When the last ping went out, answered or not. */
    lastSample?: number;
}

const initial: ConnectionStatus = { reachable: true, latencies: [] };
let status = initial;
const listeners = new Set<() => void>();
let sampling: Promise<number | undefined> | undefined;

function update(next: ConnectionStatus) {
    status = next;
    for (const listener of listeners) {
        listener();
    }
}

/** For tests: a fresh tab. */
export function resetConnectionStatus() {
    status = initial;
    sampling = undefined;
}

export const connectionStatus = () => status;

export function subscribeConnection(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

/**
 * The server answered (`answered`) or didn't: a heartbeat from the shell's
 * poll or a ping. An error it explained (a 401, a 500) is still an answer;
 * only no answer, a proxy's, or a draining refusal (`serverAway`) is not.
 */
export function connectionHeartbeat(answered: boolean, now = Date.now()) {
    update({
        ...status,
        reachable: answered,
        lastCheck: now,
        lastDisconnect: status.reachable && !answered ? now : status.lastDisconnect,
    });
}

/** The shell poll's result as a heartbeat: none for success, else its error. */
export const pollHeartbeat = (error?: unknown) => connectionHeartbeat(error === undefined || !serverAway(error));

/**
 * Times one `GET /ping`, never from a cache, and keeps the round trip.
 * The proxy answering for the server (502, 503, 504), no answer, or none
 * in `PING_TIMEOUT_MS` is a missed heartbeat. Skipped while the browser
 * is offline; one at a time.
 */
export function sampleLatency({
    request = fetch,
    clock = () => performance.now(),
    now = Date.now,
}: {
    request?: typeof fetch;
    clock?: () => number;
    now?: () => number;
} = {}): Promise<number | undefined> {
    if (browserOffline()) {
        return Promise.resolve(undefined);
    }
    sampling ??= (async () => {
        update({ ...status, lastSample: now() });
        const started = clock();
        try {
            const response = await request(PING_PATH, {
                cache: 'no-store',
                // Older Safari has no AbortSignal.timeout: it waits as long as fetch.
                signal: AbortSignal.timeout?.(PING_TIMEOUT_MS),
            });
            const ms = Math.max(0, Math.round(clock() - started));
            if ([502, 503, 504].includes(response.status)) {
                connectionHeartbeat(false, now());
                return undefined;
            }
            connectionHeartbeat(true, now());
            update({
                ...status,
                latencies: [...status.latencies, ms].slice(-LATENCY_SAMPLES),
            });
            return ms;
        } catch {
            connectionHeartbeat(false, now());
            return undefined;
        } finally {
            sampling = undefined;
        }
    })();
    return sampling;
}

export function latencyQuality(ms: number): LatencyQuality {
    return ms < FAIR_MS ? 'good' : ms < SLOW_MS ? 'fair' : 'slow';
}

/** Online, reconnecting or offline: the browser's word first, then the server's. */
export const connectionState = (
    offline: boolean,
    { reachable }: Pick<ConnectionStatus, 'reachable'>,
): ConnectionState => (offline ? 'offline' : reachable ? 'online' : 'reconnecting');

/**
 * Samples the round trip while mounted: shortly after it mounts
 * (`FIRST_SAMPLE_MS`), then every `SAMPLE_EVERY_MS` while the tab is
 * visible. Hidden, it stops; shown again, it samples if the last one is
 * due, and starts again. Back online, or reachable again after a gap, it
 * samples at once.
 */
export function useLatencySampling() {
    useEffect(() => {
        let timer: ReturnType<typeof setInterval> | undefined;
        const sample = () => void sampleLatency();
        const due = () => status.lastSample === undefined || Date.now() - status.lastSample >= SAMPLE_EVERY_MS;
        const start = () => {
            if (timer) {
                return;
            }
            if (due()) {
                sample();
            }
            timer = setInterval(sample, SAMPLE_EVERY_MS);
        };
        const stop = () => {
            clearInterval(timer);
            timer = undefined;
        };
        const visibility = () => (document.visibilityState === 'hidden' ? stop() : start());
        let reachable = status.reachable;
        const unsubscribe = subscribeConnection(() => {
            const back = !reachable && status.reachable;
            reachable = status.reachable;
            if (back && timer && !sampling) {
                sample();
            }
        });
        const first = setTimeout(visibility, FIRST_SAMPLE_MS);
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('online', sample);
        return () => {
            clearTimeout(first);
            stop();
            unsubscribe();
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('online', sample);
        };
    }, []);
}

/** The connection as the badge shows it, and its details. */
export function useConnectionStatus() {
    const offline = useOffline();
    const current = useSyncExternalStore(subscribeConnection, connectionStatus, () => initial);
    return { ...current, state: connectionState(offline, current) };
}
