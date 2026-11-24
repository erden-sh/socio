/** CB-299: opt-in, tab-local diagnostics. Never collect bodies or raw URLs. */
import { forgetOnSignOut } from '../../../shell/auth-channel';

export const RECORDING_KEY = 'socio:performance-recording';
export const MAX_ENTRIES = 500;
export const MAX_RECORDING_MS = 10 * 60_000;
type Kind = 'request' | 'resource' | 'navigation' | 'interaction' | 'long-task' | 'frame-stall' | 'route' | 'render';
export interface DiagnosticEntry {
    kind: Kind;
    at: number;
    ms: number;
    route?: string;
    method?: string;
    status?: number;
    transferred?: number;
    decoded?: number;
    serverMs?: number;
    ttfbMs?: number;
    component?: 'shell' | 'chat' | 'transcript';
}
export interface RecordingState {
    recording: boolean;
    entries: number;
}
let entries: DiagnosticEntry[] = [];
let state: RecordingState = { recording: false, entries: 0 };
const listeners = new Set<() => void>();
let cleanup: (() => void) | undefined;
let started = 0;
let capabilities: string[] = [];
const round = (n: number) => Math.round(Math.max(0, n) * 10) / 10;

// Route shapes only: even a URL path may contain a name or a secret. Each
// dynamic segment is removed, including one that happens to be a route word.
const SHAPES = [
    /^\/(?:api\/)?(state|workspace|ping|healthz)$/,
    /^\/api\/(conversations)(?:\/[^/]+)?(?:\/(history|messages|reactions|queue|connect))?$/,
    /^\/api\/(spaces)\/[^/]+(?:\/(pages|page-tree)(?:\/[^/]+)?)?$/,
    /^\/api\/(pages)\/(titles)$/,
    /^\/api\/(issues)(?:\/[^/]+)?$/,
    /^\/api\/(auth)\/(session)$/,
    /^\/api\/(copilotkit)(?:\/.*)?$/,
    /^\/(chats|spaces|issues)(?:\/[^/]+)?$/,
    /^\/(settings)\/(workspace|account|performance|notifications|inference)$/,
];
export function routeShape(input: string, origin: string): string | undefined {
    let url: URL;
    try {
        url = new URL(input, origin);
    } catch {
        return undefined;
    }
    if (url.origin !== origin) {
        return undefined;
    }
    if (url.pathname === '/') {
        return '/';
    }
    // Public, hashed build assets only; no user-uploaded file names.
    if (/^\/assets\/[\w.-]+-[\w-]+\.(js|css)$/.test(url.pathname)) {
        return url.pathname;
    }
    for (const pattern of SHAPES) {
        const match = pattern.exec(url.pathname);
        if (!match) {
            continue;
        }
        const literals = match.slice(1).filter(Boolean);
        // Use the captures to label a request, not the original path.
        return (url.pathname.startsWith('/api/') ? '/api/' : '/') + literals.join('/');
    }
    return url.pathname.startsWith('/api/') ? '/api/:other' : '/:other';
}

function emit() {
    for (const listener of listeners) {
        listener();
    }
}
function push(entry: DiagnosticEntry) {
    if (!state.recording) {
        return;
    }
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) {
        entries.shift();
    }
    state = { recording: true, entries: entries.length };
    // UI reads on its own one-second tick; recording a frame must never
    // trigger a React render, which would distort what we're measuring.
}
export const recordingState = () => state;
export const subscribeRecording = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};
function remember(active: boolean, remainingMs = MAX_RECORDING_MS) {
    try {
        if (active) {
            sessionStorage.setItem(RECORDING_KEY, String(Date.now() + remainingMs));
        } else {
            sessionStorage.removeItem(RECORDING_KEY);
        }
    } catch {
        /* Recording still works when storage is blocked. */
    }
}

export function stopRecording() {
    state = { ...state, recording: false };
    cleanup?.();
    cleanup = undefined;
    remember(false);
    emit();
}
export function clearRecording() {
    stopRecording();
    entries = [];
    state = { recording: false, entries: 0 };
    emit();
}
forgetOnSignOut(clearRecording);

/** Starts a fresh sample; a reload can resume the opt-in within ten minutes. */
export function startRecording(remainingMs = MAX_RECORDING_MS, includeStartup = false) {
    if (typeof window === 'undefined' || state.recording) {
        return;
    }
    entries = [];
    capabilities = [];
    started = Date.now();
    state = { recording: true, entries: 0 };
    remember(true, remainingMs);
    // On an opted-in reload, include the assets loaded before this entry
    // module ran. Otherwise a startup report would miss most initial JS.
    const began = includeStartup ? 0 : performance.now();
    const observers: PerformanceObserver[] = [];
    const origin = location.origin;
    const shape = (url: string) => routeShape(url, origin);
    const observe = (type: string, visit: (entry: PerformanceEntry) => void) => {
        if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes(type)) {
            return;
        }
        try {
            const observer = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    visit(entry);
                }
            });
            observer.observe({
                type,
                buffered: type === 'navigation' || includeStartup,
            });
            observers.push(observer);
            capabilities.push(type);
        } catch {
            /* Safari may not support an observer option or entry type. */
        }
    };
    observe('resource', (entry) => {
        const e = entry as PerformanceResourceTiming;
        const route = shape(e.name);
        if (route === undefined || e.startTime < began) {
            return;
        }
        push({
            kind: 'resource',
            at: round(e.startTime),
            ms: round(e.duration),
            route,
            transferred: e.transferSize,
            decoded: e.decodedBodySize,
            ttfbMs: e.responseStart ? round(e.responseStart - e.requestStart) : undefined,
        });
    });
    observe('navigation', (entry) => {
        const e = entry as PerformanceNavigationTiming;
        push({
            kind: 'navigation',
            at: round(e.startTime),
            ms: round(e.duration),
            route: shape(e.name),
            transferred: e.transferSize,
            decoded: e.decodedBodySize,
            ttfbMs: round(e.responseStart - e.requestStart),
        });
    });
    observe('longtask', (e) => push({ kind: 'long-task', at: round(e.startTime), ms: round(e.duration) }));
    observe('event', (e) => {
        if (e.duration >= 40) {
            push({
                kind: 'interaction',
                at: round(e.startTime),
                ms: round(e.duration),
            });
        }
    });
    // Safari has no Long Tasks API. Frame gaps supply a compatible signal;
    // hidden-tab/resume gaps are excluded and are not reported as UI stalls.
    let last = 0;
    let frame = 0;
    const tick = (now: number) => {
        if (document.visibilityState === 'visible') {
            if (last && now - last >= 80) {
                push({ kind: 'frame-stall', at: round(last), ms: round(now - last) });
            }
            last = now;
        } else {
            last = 0;
        }
        frame = requestAnimationFrame(tick);
    };
    const visibility = () => {
        last = 0;
    };
    document.addEventListener('visibilitychange', visibility);
    frame = requestAnimationFrame(tick);
    capabilities.push('frame-gaps', 'fetch');
    const originalFetch = window.fetch;
    const wrappedFetch: typeof fetch = async (...args) => {
        const input = args[0];
        const url = input instanceof Request ? input.url : String(input);
        const route = shape(url);
        const at = performance.now();
        const method = (args[1]?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        // An in-flight response must not leak into the next recording.
        const session = entries;
        try {
            const response = await originalFetch.apply(window, args);
            if (session === entries && route !== undefined) {
                const timing = /(?:^|,)\s*app;dur=([\d.]+)/.exec(response.headers.get('Server-Timing') ?? '');
                push({
                    kind: 'request',
                    route,
                    method: /^[A-Z]{1,12}$/.test(method) ? method : 'OTHER',
                    at: round(at),
                    ms: round(performance.now() - at),
                    status: response.status,
                    serverMs: timing ? Number(timing[1]) : undefined,
                });
            }
            return response;
        } catch (error) {
            if (session === entries && route !== undefined) {
                push({
                    kind: 'request',
                    route,
                    at: round(at),
                    ms: round(performance.now() - at),
                    status: 0,
                });
            }
            throw error;
        }
    };
    window.fetch = wrappedFetch;
    const timer = setTimeout(stopRecording, Math.min(remainingMs, MAX_RECORDING_MS));
    cleanup = () => {
        clearTimeout(timer);
        cancelAnimationFrame(frame);
        document.removeEventListener('visibilitychange', visibility);
        for (const observer of observers) {
            observer.disconnect();
        }
        if (window.fetch === wrappedFetch) {
            window.fetch = originalFetch;
        }
    };
    emit();
}

export function resumeRecording() {
    try {
        const until = Number(sessionStorage.getItem(RECORDING_KEY));
        const remaining = until - Date.now();
        if (remaining > 0 && remaining <= MAX_RECORDING_MS) {
            startRecording(remaining, true);
        } else {
            remember(false);
        }
    } catch {
        /* Storage may be unavailable. */
    }
}
export function recordRoute(path: string) {
    if (!state.recording) {
        return;
    }
    push({
        kind: 'route',
        at: round(performance.now()),
        ms: 0,
        route: routeShape(path, location.origin),
    });
}
export function recordNavigation(path: string, ms: number) {
    if (!state.recording) {
        return;
    }
    push({
        kind: 'navigation',
        at: round(performance.now()),
        ms: round(ms),
        route: routeShape(path, location.origin),
    });
}
/** Commit counts expose UI churn without React's profiling production build. */
export function recordRender(component: DiagnosticEntry['component']) {
    if (!state.recording) {
        return;
    }
    push({ kind: 'render', at: round(performance.now()), ms: 0, component });
}
export function exportRecording() {
    return {
        schema: 1,
        startedAt: started ? new Date(started).toISOString() : null,
        browser: typeof navigator === 'undefined' ? '' : navigator.userAgent,
        capabilities: [...capabilities],
        note: 'Tab-local bounded sample. Frame gaps include rendering/CPU delays; request duration ends at response headers. Cached sizes may be zero. No bodies, credentials, query strings, or dynamic route identifiers are collected.',
        entries: [...entries],
    };
}
