import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useVoice } from '../src/modules/voice/useVoice';

// CB-265: the browser side of a self-hosted call, with the microphone,
// Web Audio, the device's voice and the socket faked.
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/api', () => ({ api, authHeaders: () => ({}) }));

let voice: ReturnType<typeof useVoice>;
let root: ReactTestRenderer;
const track = { stop: vi.fn(), enabled: true };
const spoken: string[] = [];
let socket: FakeSocket;
let peers = 0;

class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    binaryType = 'blob';
    sent: unknown[] = [];
    onopen?: () => void;
    onmessage?: (message: { data: unknown }) => void;
    onclose?: () => void;
    onerror?: () => void;
    constructor(public url: string) {
        // The hook makes it, like a browser constructor.
        // oxlint-disable-next-line typescript/no-this-alias
        socket = this;
    }
    send(data: unknown) {
        this.sent.push(data);
    }
    close() {
        this.readyState = 3;
    }
    open() {
        this.readyState = 1;
        this.onopen?.();
    }
    event(event: object) {
        this.onmessage?.({ data: JSON.stringify(event) });
    }
}
const node = () => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    port: { onmessage: null, postMessage: vi.fn() },
});
class FakeContext {
    currentTime = 0;
    destination = {};
    audioWorklet = { addModule: vi.fn(async () => {}) };
    createMediaStreamSource = () => node();
    createGain = () => ({ ...node(), gain: { value: 1 } });
    createBuffer = (_c: number, n: number) => ({
        duration: n / 24000,
        getChannelData: () => new Float32Array(n),
    });
    createBufferSource = () => ({ ...node(), start: vi.fn(), stop: vi.fn() });
    resume = async () => {};
    close = vi.fn(async () => {});
}

function Hook() {
    voice = useVoice('thread', () => {}, undefined, {
        backend: 'self-hosted',
        cloud: true,
    });
    return null;
}

beforeEach(async () => {
    spoken.length = 0;
    peers = 0;
    track.stop.mockReset();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('AudioContext', FakeContext);
    vi.stubGlobal(
        'AudioWorkletNode',
        class {
            connect = vi.fn();
            disconnect = vi.fn();
            port = { onmessage: null, postMessage: vi.fn() };
        },
    );
    vi.stubGlobal(
        'SpeechSynthesisUtterance',
        class {
            onend?: () => void;
            volume = 1;
            lang = '';
            constructor(public text: string) {}
        },
    );
    vi.stubGlobal('speechSynthesis', {
        speak: (utterance: { text: string }) => {
            if (utterance.text) {
                spoken.push(utterance.text);
            }
        },
        cancel: vi.fn(),
    });
    vi.stubGlobal('location', { protocol: 'https:', host: 'socio.test' });
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('document', { documentElement: { lang: 'en' } });
    vi.stubGlobal('navigator', {
        language: 'en',
        mediaDevices: {
            getUserMedia: async () => ({
                getTracks: () => [track],
                getAudioTracks: () => [track],
            }),
        },
    });
    vi.stubGlobal(
        'RTCPeerConnection',
        class {
            constructor() {
                peers++;
            }
            createDataChannel() {
                return { close() {} };
            }
            addTrack() {}
            async createOffer() {
                return { sdp: 'offer' };
            }
            async setLocalDescription() {}
            async setRemoteDescription() {}
            close() {}
        },
    );
    vi.stubGlobal(
        'Audio',
        class {
            pause() {}
        },
    );
    api.mockReset().mockImplementation(async (path: string, _method?: string, body?: object) =>
        path === '/voice/calls'
            ? body && 'sdp' in body
                ? { id: 'cloud-call', sdp: 'answer' }
                : { id: 'call', backend: 'self-hosted' }
            : { endedAt: null },
    );
    await act(async () => {
        root = create(createElement(Hook));
    });
});
afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
});

it('streams the microphone to the call’s socket and speaks replies on the device', async () => {
    await act(async () => {
        await voice.start();
    });
    expect(api).toHaveBeenCalledWith('/voice/calls', 'POST', {
        threadId: 'thread',
        backend: 'self-hosted',
    });
    expect(socket.url).toBe('wss://socio.test/api/voice/call?id=call');
    expect(peers).toBe(0);
    await act(async () => {
        socket.open();
        socket.event({ type: 'ready', speech: false });
    });
    expect(voice.status).toBe('active');
    expect(voice.backend).toBe('self-hosted');
    await act(async () => {
        socket.event({ type: 'partial', text: 'hello fr' });
    });
    expect(voice.userCaption).toBe('hello fr');
    await act(async () => {
        socket.event({ type: 'heard', text: 'hello from me' });
        socket.event({ type: 'thinking' });
    });
    expect(voice.phase).toBe('thinking');
    await act(async () => {
        socket.event({ type: 'reply', text: 'Hi there.', audio: false });
        socket.event({
            type: 'notice',
            text: 'Approval needed: send the email.',
        });
    });
    expect(spoken).toEqual(['Hi there.']);
    expect(voice.caption).toBe('Hi there.');
    expect(voice.phase).toBe('speaking');
    expect(voice.notice).toMatch(/Approval needed/);
    await act(async () => {
        voice.interrupt();
    });
    expect(socket.sent).toContainEqual(JSON.stringify({ type: 'interrupt' }));
    await act(async () => {
        await voice.end();
    });
    expect(api).toHaveBeenCalledWith('/voice/calls/call/end', 'POST', {
        transcript: 'You: hello from me\nSocio: Hi there.',
        anchorMessageId: undefined,
    });
    expect(track.stop).toHaveBeenCalled();
    expect(voice.status).toBe('idle');
});

it('says why a self-hosted call couldn’t connect, and offers cloud voice', async () => {
    await act(async () => {
        await voice.start();
    });
    await act(async () => {
        socket.open();
        socket.event({
            type: 'ended',
            reason: 'The self-hosted voice server isn’t answering.',
        });
    });
    expect(voice.status).toBe('idle');
    expect(voice.error).toMatch(/isn’t answering/);
    expect(voice.canFallBack).toBe(true);
    expect(track.stop).toHaveBeenCalled();
    await act(async () => {
        voice.fallBack();
    });
    expect(peers).toBe(1);
    expect(api).toHaveBeenCalledWith('/voice/calls', 'POST', {
        threadId: 'thread',
        sdp: 'offer',
        backend: 'cloud',
    });
    expect(voice.backend).toBe('cloud');
});
