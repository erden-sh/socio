// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
    clearRecording,
    exportRecording,
    MAX_ENTRIES,
    MAX_RECORDING_MS,
    RECORDING_KEY,
    recordingState,
    recordRoute,
    resumeRecording,
    routeShape,
    startRecording,
    stopRecording,
} from '../src/modules/settings/performance/recorder';
import { forgetSessionMemory } from '../src/shell/auth-channel';

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
beforeEach(() => {
    vi.useFakeTimers();
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
        frames.set(++nextFrame, fn);
        return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('PerformanceObserver', undefined);
    vi.stubGlobal(
        'fetch',
        vi.fn(
            async () =>
                new Response('private body', {
                    headers: {
                        'Server-Timing': 'app;dur=12.3',
                        'Set-Cookie': 'secret-cookie',
                    },
                }),
        ),
    );
    sessionStorage.clear();
});
afterEach(() => {
    clearRecording();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});
it('removes dynamic path identifiers, queries, credentials, hashes and external URLs', () => {
    const origin = 'https://brain.example';
    expect(routeShape('/api/conversations/private-name/history?token=secret#body', origin)).toBe(
        '/api/conversations/history',
    );
    expect(routeShape('/api/spaces/My%20Client/pages/My%20Document', origin)).toBe('/api/spaces/pages');
    expect(routeShape('/reset-password/secret-token', origin)).toBe('/:other');
    expect(routeShape('https://elsewhere.example/api/state', origin)).toBeUndefined();
    expect(routeShape('/assets/ChatRuntime-AbC123.js', origin)).toBe('/assets/ChatRuntime-AbC123.js');
    // A dynamic id matching a known route word must still be removed.
    expect(routeShape('/chats/settings', origin)).toBe('/chats');
});
it('leaves fetch alone until opted in and preserves responses without collecting their contents', async () => {
    const original = window.fetch;
    expect(recordingState().recording).toBe(false);
    startRecording();
    const response = await window.fetch('/api/workspace?secret=query', {
        headers: { Authorization: 'Bearer secret-token' },
    });
    expect(await response.text()).toBe('private body');
    const report = exportRecording();
    expect(report.entries).toContainEqual(
        expect.objectContaining({
            kind: 'request',
            route: '/api/workspace',
            status: 200,
            serverMs: 12.3,
        }),
    );
    expect(JSON.stringify(report)).not.toMatch(/secret|private body/);
    stopRecording();
    expect(window.fetch).toBe(original);
    expect(frames.size).toBe(0);
});
it('bounds samples and clears them when the session ends', () => {
    startRecording();
    for (let i = 0; i < MAX_ENTRIES + 20; i++) {
        recordRoute(`/chats/${i}`);
    }
    expect(exportRecording().entries).toHaveLength(MAX_ENTRIES);
    expect(recordingState().entries).toBe(MAX_ENTRIES);
    forgetSessionMemory();
    expect(exportRecording().entries).toEqual([]);
    expect(recordingState().recording).toBe(false);
    expect(sessionStorage.getItem(RECORDING_KEY)).toBeNull();
});
it('does not record an old in-flight response in a new sample', async () => {
    let finish!: (response: Response) => void;
    window.fetch = vi.fn(
        () =>
            new Promise<Response>((resolve) => {
                finish = resolve;
            }),
    );
    startRecording();
    const pending = window.fetch('/api/state');
    stopRecording();
    startRecording();
    finish(new Response('{}'));
    await pending;
    expect(exportRecording().entries).toEqual([]);
});
it('preserves fetch rejection and records only a sanitized failure', async () => {
    window.fetch = vi.fn(async () => {
        throw new Error('private-network-error');
    });
    startRecording();
    await expect(window.fetch('/api/spaces/private-title')).rejects.toThrow('private-network-error');
    expect(exportRecording().entries[0]).toMatchObject({
        route: '/api/spaces',
        status: 0,
    });
    expect(JSON.stringify(exportRecording())).not.toMatch(/private/);
});
it('resumes for the remaining consent window, then stops without extending it', () => {
    sessionStorage.setItem(RECORDING_KEY, String(Date.now() + 1000));
    resumeRecording();
    expect(recordingState().recording).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(recordingState().recording).toBe(false);
    sessionStorage.setItem(RECORDING_KEY, String(Date.now() - 1));
    resumeRecording();
    expect(recordingState().recording).toBe(false);
    startRecording();
    vi.advanceTimersByTime(MAX_RECORDING_MS);
    expect(recordingState().recording).toBe(false);
});
it('records visible frame gaps on browsers without Long Tasks and excludes resume gaps', () => {
    startRecording();
    const frame = (at: number) => {
        const [id, fn] = frames.entries().next().value!;
        frames.delete(id);
        fn(at);
    };
    frame(100);
    frame(240);
    expect(exportRecording().entries).toContainEqual({
        kind: 'frame-stall',
        at: 100,
        ms: 140,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    frame(20000);
    expect(exportRecording().entries).toHaveLength(1);
});

it('includes buffered startup asset sizes when an opted-in reload resumes', () => {
    const observe = vi.fn();
    let receive!: (list: { getEntries: () => PerformanceEntry[] }) => void;
    vi.stubGlobal(
        'PerformanceObserver',
        class {
            static supportedEntryTypes = ['resource'];
            constructor(callback: typeof receive) {
                receive = callback;
            }
            observe = observe;
            disconnect() {}
        },
    );
    sessionStorage.setItem(RECORDING_KEY, String(Date.now() + 1000));
    resumeRecording();
    expect(observe).toHaveBeenCalledWith({ type: 'resource', buffered: true });
    receive({
        getEntries: () => [
            {
                name: `${location.origin}/assets/entry-AbC123.js`,
                startTime: 0,
                duration: 20,
                transferSize: 1000,
                decodedBodySize: 4000,
                responseStart: 10,
                requestStart: 1,
            } as PerformanceResourceTiming,
        ],
    });
    expect(exportRecording().entries).toContainEqual(
        expect.objectContaining({
            kind: 'resource',
            transferred: 1000,
            decoded: 4000,
        }),
    );
});
