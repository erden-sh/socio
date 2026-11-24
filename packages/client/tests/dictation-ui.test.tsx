// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Conversation, Dot } from '@socio/shared/types';
import type { DictationAllowed, DictationMethod } from '@socio/shared/voice/dictation';

import type { Shell } from '../src/shell/shell-context';

// CB-101: the composer's mic. Speech recognition, the recorder and the
// server are fakes; nothing listens and nothing leaves the test.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const agent = vi.hoisted(() => ({
    messages: [] as unknown[],
    addMessage: vi.fn(),
    subscribe: () => ({ unsubscribe: () => {} }),
}));
const copilotkit = vi.hoisted(() => ({
    subscribe: () => ({ unsubscribe: () => {} }),
    connectAgent: vi.fn(async () => undefined),
    runAgent: vi.fn(async () => ({ newMessages: [{ role: 'assistant' }] })),
    stopAgent: vi.fn(),
}));
vi.mock('@copilotkit/react-core/v2', () => ({
    useAgent: () => ({ agent, isReady: true }),
    useCopilotKit: () => ({ copilotkit }),
    useRenderTool: () => {},
    useHumanInTheLoop: () => {},
    CopilotChatToolCallsView: () => null,
}));

const { Chat } = await import('../src/modules/chat/Chat');
const { DEVICE_START_TIMEOUT_MS, DEVICE_STOP_GRACE_MS } = await import('../src/modules/voice/use-dictation');
const { ShellContext } = await import('../src/shell/shell-context');

const dot: Dot = {
    id: 'd1',
    spaceId: 's1',
    spaceIds: ['s1'],
    name: 'Dot',
    instructions: 'Dot helps.',
    researchAllowed: false,
    memoryAllowed: false,
    createdAt: 1,
};
const thread: Conversation = {
    id: 'c1',
    dotId: 'd1',
    ownerId: 'alice',
    title: 'Chat',
    createdAt: 1,
};

/** The browser's speech recognition, driven by the test. */
class FakeRecognition {
    static last: FakeRecognition | undefined;
    continuous = false;
    interimResults = false;
    lang = '';
    onresult: ((event: unknown) => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    started = false;
    constructor() {
        FakeRecognition.last = this;
    }
    start() {
        this.started = true;
    }
    stop() {
        this.onend?.();
    }
    abort() {
        this.onerror?.({ error: 'aborted' });
        this.onend?.();
    }
    hear(text: string, isFinal = true) {
        const result = Object.assign([{ transcript: text }], { isFinal });
        this.onresult?.({ results: [result] });
    }
}

/** MediaRecorder, as far as dictation uses it. */
class FakeRecorder {
    static last: FakeRecorder | undefined;
    static isTypeSupported = (type: string) => type === 'audio/webm';
    state: 'inactive' | 'recording' = 'inactive';
    mimeType = 'audio/webm';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor() {
        FakeRecorder.last = this;
    }
    start() {
        this.state = 'recording';
    }
    stop() {
        this.state = 'inactive';
        this.ondataavailable?.({
            data: new Blob([new Uint8Array(32)], { type: 'audio/webm' }),
        });
        this.onstop?.();
    }
}

/** The socket to this server for live text (CB-222), driven by the test. */
class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static last: FakeSocket | undefined;
    readyState = 0;
    binaryType = '';
    sent: unknown[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
        FakeSocket.last = this;
    }
    send(data: unknown) {
        this.sent.push(data);
    }
    close() {
        if (this.readyState === 3) {
            return;
        }
        this.readyState = 3;
        this.onclose?.();
    }
    open() {
        this.readyState = 1;
        this.onopen?.();
    }
    say(event: object) {
        this.onmessage?.({ data: JSON.stringify(event) });
    }
    /** The text messages it sent, parsed. */
    messages() {
        return this.sent
            .filter((data): data is string => typeof data === 'string')
            .map((data) => JSON.parse(data) as { type: string });
    }
    /** The audio bytes it sent. */
    audio() {
        return this.sent
            .filter((data) => typeof data !== 'string')
            .reduce((sum: number, data) => sum + (data as Int16Array).byteLength, 0);
    }
}

/** The worklet that turns the mic into PCM (public/dictation-worklet.js). */
class FakeWorkletNode {
    static last: FakeWorkletNode | undefined;
    port = {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        postMessage: (message: unknown) => {
            if (message === 'flush') {
                this.flush();
            }
        },
    };
    flush() {
        setTimeout(() => this.port.onmessage?.({ data: 'flushed' }));
    }
    constructor(
        readonly context: unknown,
        readonly name: string,
        readonly options: { processorOptions: { rate: number } },
    ) {
        FakeWorkletNode.last = this;
    }
    connect() {}
    disconnect() {}
    /** `samples` of PCM from the mic. */
    hear(samples: number) {
        this.port.onmessage?.({ data: new Int16Array(samples).fill(9).buffer });
    }
}

const addModule = vi.fn(async (_url: string) => {});
class FakeAudioContext {
    static last: FakeAudioContext | undefined;
    audioWorklet = { addModule };
    destination = {};
    closed = false;
    constructor() {
        FakeAudioContext.last = this;
    }
    createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
    }
    async resume() {}
    async close() {
        this.closed = true;
    }
}

const getUserMedia = vi.fn();
const track = { stop: vi.fn() };
let requests: Array<{ url: string; init?: RequestInit }> = [];
let transcript: () => Response | Promise<Response> = () => Response.json({ text: 'from server' });

let root: Root | undefined;
let host: HTMLElement | undefined;
beforeEach(() => {
    Element.prototype.scrollIntoView = () => {};
    agent.addMessage.mockClear();
    copilotkit.runAgent.mockClear();
    FakeRecognition.last = undefined;
    FakeRecorder.last = undefined;
    FakeSocket.last = undefined;
    FakeWorkletNode.last = undefined;
    FakeAudioContext.last = undefined;
    addModule.mockReset();
    addModule.mockResolvedValue(undefined);
    requests = [];
    transcript = () => Response.json({ text: 'from server' });
    getUserMedia.mockReset();
    getUserMedia.mockResolvedValue({ getTracks: () => [track] });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        requests.push({ url: String(url), init });
        if (String(url).includes('/voice/transcriptions')) {
            return transcript();
        }
        if (String(url).includes('/preferences')) {
            return Response.json({ dictation: 'server' });
        }
        return Response.json(String(url).includes('/me/inference/options') ? { options: [], automatic: null } : null);
    });
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
});

/** What the browser can do: device recognition, recording, live text. */
function browserCan({ device = false, record = false, live = false }) {
    if (live) {
        record = true;
        vi.stubGlobal('AudioContext', FakeAudioContext);
        vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
        vi.stubGlobal('WebSocket', FakeSocket);
    }
    if (device) {
        (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
    }
    if (record) {
        vi.stubGlobal('MediaRecorder', FakeRecorder);
        Object.defineProperty(navigator, 'mediaDevices', {
            value: { getUserMedia },
            configurable: true,
        });
    }
}

function shellWith({
    transcription = true,
    streaming = false,
    preference = null,
    allowed = 'both',
}: {
    transcription?: boolean;
    streaming?: boolean;
    preference?: DictationMethod | null;
    allowed?: DictationAllowed;
} = {}) {
    return {
        state: { settings: { dictationMethods: allowed } },
        workspace: {
            setup: { transcription, transcriptionStreaming: streaming },
            preferences: { dictation: preference },
        },
        refresh: vi.fn(async () => {}),
    } as unknown as Shell;
}

async function render({ shell, voiceReady = false }: { shell?: Shell; voiceReady?: boolean } = {}) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const chat = (
        <Chat
            thread={thread}
            dot={dot}
            onConsumed={() => {}}
            voiceReady={voiceReady}
            calls={[]}
            paused={false}
            onSaved={() => {}}
            onSchedule={() => {}}
        />
    );
    await act(async () =>
        root!.render(shell ? <ShellContext.Provider value={shell}>{chat}</ShellContext.Provider> : chat),
    );
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    return host;
}
const $ = <T extends Element = HTMLElement>(selector: string) => host!.querySelector<T>(selector);
const mic = () => $<HTMLButtonElement>('[aria-label="Dictate"]');
const draft = () => $<HTMLTextAreaElement>('textarea')!;
const click = (element: Element | null) =>
    act(async () => {
        (element as HTMLElement).click();
        await new Promise((r) => setTimeout(r, 0));
    });
async function type(text: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(draft(), text);
        draft().dispatchEvent(new Event('input', { bubbles: true }));
    });
}

it('shows no mic when neither way works', async () => {
    await render();
    expect(mic()).toBeNull();
    // Recording without a voice provider is no way either.
    browserCan({ record: true });
    act(() => root!.unmount());
    host!.remove();
    await render({ shell: shellWith({ transcription: false }) });
    expect(mic()).toBeNull();
});

it('dictates on the device into the draft, without sending', async () => {
    browserCan({ device: true });
    await render();
    const button = mic()!;
    // The same chrome as the attach and link buttons beside it.
    expect(button.className).toBe($('[aria-label="Attach files"]')!.className);
    // In the composer's toolbar with them, not beside the text (CB-97).
    expect(button.parentElement!.dataset.slot).toBe('composer-tools');
    await type('Note:');
    await click(button);
    expect(FakeRecognition.last?.started).toBe(true);
    expect($('[data-slot="dictation-listening"]')?.textContent).toContain('Listening');
    expect($('[aria-label="Stop dictation"]')).not.toBeNull();
    await act(async () => FakeRecognition.last!.hear('buy milk'));
    expect($('[data-slot="dictation-listening"]')?.textContent).toContain('buy milk');
    await click($('[aria-label="Done dictating"]'));
    expect(draft().value).toBe('Note: buy milk');
    expect($('[data-slot="dictation-listening"]')).toBeNull();
    // In the draft to edit, never sent on its own.
    expect(agent.addMessage).not.toHaveBeenCalled();
    expect(copilotkit.runAgent).not.toHaveBeenCalled();
    expect($<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(false);
    // No chooser, and nothing went to the server.
    expect($('[data-slot="dictation-chooser"]')).toBeNull();
    expect(requests.some((r) => r.url.includes('/voice/'))).toBe(false);
});

it('cancels without touching the draft', async () => {
    browserCan({ device: true });
    await render();
    await click(mic());
    await act(async () => FakeRecognition.last!.hear('never mind'));
    await click($('[aria-label="Cancel dictation"]'));
    expect(draft().value).toBe('');
    expect($('[data-slot="dictation-listening"]')).toBeNull();
    expect($('[role="alert"]')).toBeNull();
});

it('never waits on a recognizer that goes quiet (an installed iPhone app)', async () => {
    browserCan({ device: true });
    await render();
    vi.useFakeTimers();
    try {
        const press = async (element: Element | null) => {
            await act(async () => (element as HTMLElement).click());
            await act(async () => vi.advanceTimersByTimeAsync(0));
        };
        // It hears nothing and ignores stop and abort.
        await press(mic());
        const quiet = FakeRecognition.last!;
        quiet.stop = quiet.abort = () => {};
        // Cancel frees the composer at once.
        await press($('[aria-label="Cancel dictation"]'));
        expect($('[data-slot="dictation-listening"]')).toBeNull();
        expect(mic()).not.toBeNull();
        // Done: what was heard lands after a short grace, without onend.
        await press(mic());
        const slow = FakeRecognition.last!;
        slow.stop = slow.abort = () => {};
        await act(async () => slow.hear('call mom'));
        await press($('[aria-label="Done dictating"]'));
        await act(async () => vi.advanceTimersByTimeAsync(DEVICE_STOP_GRACE_MS));
        expect(draft().value).toBe('call mom');
        expect($('[data-slot="dictation-listening"]')).toBeNull();
        // Silent from the start: given up on, with a way forward.
        await press(mic());
        FakeRecognition.last!.stop = FakeRecognition.last!.abort = () => {};
        await act(async () => vi.advanceTimersByTimeAsync(DEVICE_START_TIMEOUT_MS));
        expect($('[data-slot="dictation-listening"]')).toBeNull();
        expect($('[data-slot="dictation-error"]')?.textContent).toMatch(/didn’t respond/);
    } finally {
        vi.useRealTimers();
    }
});

it('listens one utterance at a time on an iPhone', async () => {
    browserCan({ device: true });
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
    );
    await render();
    await click(mic());
    expect(FakeRecognition.last!.continuous).toBe(false);
});

it('says when the mic is denied or nothing was heard', async () => {
    browserCan({ device: true });
    await render();
    await click(mic());
    await act(async () => {
        FakeRecognition.last!.onerror?.({ error: 'not-allowed' });
        FakeRecognition.last!.onend?.();
    });
    expect($('[data-slot="dictation-error"]')?.textContent).toMatch(/Microphone access was denied/);
    await click($('[data-slot="dictation-error"] [aria-label="Dismiss"]'));
    expect($('[data-slot="dictation-error"]')).toBeNull();
    await click(mic());
    await click($('[aria-label="Done dictating"]'));
    expect($('[data-slot="dictation-error"]')?.textContent).toMatch(/Nothing was heard/);
    expect(draft().value).toBe('');
});

it('asks which way when both work, saves the pick, and transcribes on the server', async () => {
    browserCan({ device: true, record: true });
    const shell = shellWith();
    await render({ shell });
    await type('Hi');
    await click(mic());
    const chooser = $('[data-slot="dictation-chooser"]')!;
    expect(chooser.textContent).toContain('On this device');
    expect(chooser.textContent).toContain('Safari may send the audio to Apple');
    expect(chooser.textContent).toContain('On our server');
    await click(chooser.querySelector('[data-method="server"]'));
    // Saved on the server, so it follows the person.
    const saved = requests.find((r) => r.url === '/api/preferences');
    expect(saved?.init?.method).toBe('PATCH');
    expect(JSON.parse(String(saved?.init?.body))).toEqual({
        dictation: 'server',
    });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(FakeRecorder.last?.state).toBe('recording');
    expect($('[data-slot="dictation-listening"]')?.textContent).toContain('Recording');
    await click($('[aria-label="Done dictating"]'));
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    const upload = requests.find((r) => r.url === '/api/voice/transcriptions');
    expect(upload?.init?.method).toBe('POST');
    expect((upload!.init!.headers as Record<string, string>)['X-File-Type']).toBe('audio/webm');
    expect(track.stop).toHaveBeenCalled();
    expect(draft().value).toBe('Hi from server');
    expect(agent.addMessage).not.toHaveBeenCalled();
    // Picked once: the next tap starts at once.
    await click(mic());
    expect($('[data-slot="dictation-chooser"]')).toBeNull();
    expect(FakeRecorder.last?.state).toBe('recording');
});

it('uses the saved preference, or the only way the admin allows, without asking', async () => {
    browserCan({ device: true, record: true });
    await render({ shell: shellWith({ preference: 'device' }) });
    await click(mic());
    expect($('[data-slot="dictation-chooser"]')).toBeNull();
    expect(FakeRecognition.last?.started).toBe(true);
    expect(getUserMedia).not.toHaveBeenCalled();
    act(() => root!.unmount());
    host!.remove();

    FakeRecognition.last = undefined;
    await render({
        shell: shellWith({ preference: 'device', allowed: 'server' }),
    });
    await click(mic());
    expect($('[data-slot="dictation-chooser"]')).toBeNull();
    expect(FakeRecognition.last).toBeUndefined();
    expect(getUserMedia).toHaveBeenCalled();
});

it('shows a provider failure and a denied mic on the server path', async () => {
    browserCan({ record: true });
    transcript = () =>
        Response.json(
            {
                error: 'Voice provider returned HTTP 429. Check voice configuration and quota.',
            },
            { status: 503 },
        );
    await render({ shell: shellWith() });
    await click(mic());
    await click($('[aria-label="Done dictating"]'));
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect($('[data-slot="dictation-error"]')?.textContent).toMatch(/Voice provider returned HTTP 429/);
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await click(mic());
    expect($('[data-slot="dictation-error"]')?.textContent).toMatch(/Microphone access was denied/);
});

it('keeps the voice note out of the composer box', async () => {
    await render({ voiceReady: true });
    const note = $('[data-slot="chat-note"]')!;
    expect(note.textContent).toBe('Text and voice, one conversation.');
    expect(note.closest('[data-slot="chat-composer"]')).toBeNull();
    act(() => root!.unmount());
    host!.remove();
    // Without voice the disabled call button's tooltip says what it needs.
    await render({ voiceReady: false });
    expect($('[data-slot="chat-note"]')).toBeNull();
    expect(host!.textContent).not.toContain('Voice needs');
});

// CB-222: live text. The socket, the worklet and the audio context are
// fakes: the test plays the server's part.
const settle = () =>
    act(async () => {
        for (let i = 0; i < 5; i++) {
            await new Promise((r) => setTimeout(r, 0));
        }
    });

it('shows live text while it listens, then the recording’s text replaces it', async () => {
    browserCan({ live: true });
    await render({ shell: shellWith({ streaming: true, preference: 'server' }) });
    await type('Note:');
    await click(mic());
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    // The worklet from the app's own files, PCM at the server's rate.
    expect(addModule).toHaveBeenCalledWith('/dictation-worklet.js');
    expect(FakeWorkletNode.last?.options.processorOptions.rate).toBe(16000);
    const socket = FakeSocket.last!;
    expect(socket.url).toBe(`ws://${location.host}/api/voice/realtime`);
    // Heard before the socket opened: sent once it does.
    await act(async () => FakeWorkletNode.last!.hear(1600));
    await act(async () => socket.open());
    await act(async () => FakeWorkletNode.last!.hear(1600));
    expect(socket.audio()).toBe(2 * 3200);
    expect($('[data-slot="dictation-listening"]')?.textContent).toContain('Recording');
    await act(async () => socket.say({ type: 'ready' }));
    await act(async () => socket.say({ type: 'partial', text: 'buy' }));
    await act(async () => socket.say({ type: 'partial', text: 'buy milk' }));
    // Live, unconfirmed: above the box, not in the draft yet.
    expect($('[data-slot="dictation-heard"]')?.textContent).toBe('buy milk');
    expect(draft().value).toBe('Note:');
    // The recording's text is the final one; it is held back here.
    let answer = (_text: string) => {};
    transcript = () => new Promise<Response>((resolve) => (answer = (text) => resolve(Response.json({ text }))));
    await click($('[aria-label="Done dictating"]'));
    await settle();
    expect(socket.messages().at(-1)).toEqual({ type: 'done' });
    expect(FakeAudioContext.last?.closed).toBe(true);
    expect(track.stop).toHaveBeenCalled();
    // The whole recording went, once, as WAV.
    const uploads = () => requests.filter((r) => r.url === '/api/voice/transcriptions');
    expect(uploads()).toHaveLength(1);
    expect((uploads()[0].init!.headers as Record<string, string>)['X-File-Type']).toBe('audio/wav');
    // Meanwhile the preview stays, marked as finishing, even once the
    // stream's own final text is in.
    const finishing = () => $('[data-slot="dictation-transcribing"]');
    expect(finishing()?.textContent).toContain('buy milk');
    expect(finishing()?.textContent).toContain('Finishing');
    await act(async () => socket.say({ type: 'final', text: 'Buy milk.' }));
    // The server closes its end after its final text.
    await act(async () => socket.close());
    await settle();
    expect(finishing()?.textContent).toContain('buy milk');
    expect(draft().value).toBe('Note:');
    await act(async () => answer('Buy milk, please.'));
    await settle();
    expect(draft().value).toBe('Note: Buy milk, please.');
    expect(finishing()).toBeNull();
    expect($('[data-slot="dictation-heard"]')).toBeNull();
    expect(uploads()).toHaveLength(1);
    // Nothing went to the chat.
    expect(agent.addMessage).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
});

it('takes the streamed final text when the recording’s text fails, else shows the error', async () => {
    browserCan({ live: true });
    transcript = () =>
        Response.json(
            {
                error: 'Voice provider returned HTTP 502. Check voice configuration and quota.',
            },
            { status: 503 },
        );
    await render({ shell: shellWith({ streaming: true, preference: 'server' }) });
    await type('Note:');
    await click(mic());
    let socket = FakeSocket.last!;
    await act(async () => socket.open());
    await act(async () => FakeWorkletNode.last!.hear(1600));
    await act(async () => socket.say({ type: 'partial', text: 'buy milk' }));
    await click($('[aria-label="Done dictating"]'));
    await settle();
    expect($('[data-slot="dictation-transcribing"]')?.textContent).toContain('buy milk');
    await act(async () => socket.say({ type: 'final', text: 'Buy milk.' }));
    await settle();
    expect(draft().value).toBe('Note: Buy milk.');
    expect($('[data-slot="dictation-error"]')).toBeNull();
    expect(requests.filter((r) => r.url === '/api/voice/transcriptions')).toHaveLength(1);

    // Neither: the recording's error, as today.
    await click(mic());
    socket = FakeSocket.last!;
    await act(async () => socket.open());
    await act(async () => FakeWorkletNode.last!.hear(1600));
    await click($('[aria-label="Done dictating"]'));
    await settle();
    await act(async () => socket.close());
    await settle();
    expect($('[data-slot="dictation-error"]')?.textContent).toMatch(/Voice provider returned HTTP 502/);
    expect(draft().value).toBe('Note: Buy milk.');
    expect(requests.filter((r) => r.url === '/api/voice/transcriptions')).toHaveLength(2);
});

it('sends the recording when the socket drops mid-way', async () => {
    browserCan({ live: true });
    await render({ shell: shellWith({ streaming: true, preference: 'server' }) });
    await click(mic());
    const socket = FakeSocket.last!;
    await act(async () => socket.open());
    await act(async () => FakeWorkletNode.last!.hear(1600));
    await act(async () => socket.say({ type: 'partial', text: 'call' }));
    expect($('[data-slot="dictation-heard"]')?.textContent).toBe('call');
    await act(async () => socket.close());
    // Still listening: the rest is kept here. The unconfirmed text is gone.
    await act(async () => FakeWorkletNode.last!.hear(800));
    expect(socket.audio()).toBe(3200);
    expect($('[data-slot="dictation-listening"]')?.textContent).toContain('Recording');
    expect($('[data-slot="dictation-heard"]')).toBeNull();
    await click($('[aria-label="Done dictating"]'));
    await settle();
    const upload = requests.find((r) => r.url === '/api/voice/transcriptions');
    expect((upload!.init!.headers as Record<string, string>)['X-File-Type']).toBe('audio/wav');
    // All of it, as WAV: the header and 2,400 samples, and only once.
    expect((upload!.init!.body as Blob).size).toBe(44 + 2400 * 2);
    expect(requests.filter((r) => r.url === '/api/voice/transcriptions')).toHaveLength(1);
    expect(draft().value).toBe('from server');
});

it('sends the recording when the server has no live text, or nothing came', async () => {
    browserCan({ live: true });
    await render({ shell: shellWith({ streaming: true, preference: 'server' }) });
    await click(mic());
    let socket = FakeSocket.last!;
    await act(async () => socket.open());
    await act(async () => socket.say({ type: 'unavailable' }));
    await act(async () => FakeWorkletNode.last!.hear(1600));
    await click($('[aria-label="Done dictating"]'));
    await settle();
    expect(requests.filter((r) => r.url.includes('/transcriptions'))).toHaveLength(1);
    expect(draft().value).toBe('from server');
    // Whatever the stream's final text, the recording's is the final one.
    await click(mic());
    socket = FakeSocket.last!;
    await act(async () => socket.open());
    await act(async () => FakeWorkletNode.last!.hear(1600));
    await click($('[aria-label="Done dictating"]'));
    await settle();
    await act(async () => socket.say({ type: 'final', text: '' }));
    await settle();
    expect(requests.filter((r) => r.url.includes('/transcriptions'))).toHaveLength(2);
});

it('cancels live text without sending anything', async () => {
    browserCan({ live: true });
    await render({ shell: shellWith({ streaming: true, preference: 'server' }) });
    await type('Keep');
    await click(mic());
    const socket = FakeSocket.last!;
    await act(async () => socket.open());
    await act(async () => FakeWorkletNode.last!.hear(1600));
    await act(async () => socket.say({ type: 'partial', text: 'oops' }));
    await click($('[aria-label="Cancel dictation"]'));
    await settle();
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
    expect(socket.messages()).toEqual([]);
    expect(FakeAudioContext.last?.closed).toBe(true);
    expect(draft().value).toBe('Keep');
    expect($('[data-slot="dictation-listening"]')).toBeNull();
    expect(requests.some((r) => r.url.includes('/voice/'))).toBe(false);
});

it('stops at the recording limit, and records as before where it can’t stream', async () => {
    browserCan({ live: true });
    await render({ shell: shellWith({ streaming: true, preference: 'server' }) });
    await click(mic());
    const socket = FakeSocket.last!;
    await act(async () => socket.open());
    await act(async () => FakeWorkletNode.last!.hear(16000 * 119));
    // Past two minutes: Done, as if pressed.
    await act(async () => FakeWorkletNode.last!.hear(16000 * 2));
    await settle();
    expect(socket.messages().at(-1)).toEqual({ type: 'done' });
    expect(socket.audio()).toBe(16000 * 119 * 2);
    await settle();
    expect(draft().value).toBe('from server');
    act(() => root!.unmount());
    host!.remove();

    // The worklet can't load: the recorder, as before.
    addModule.mockRejectedValueOnce(new Error('blocked'));
    await render({ shell: shellWith({ streaming: true, preference: 'server' }) });
    await click(mic());
    await settle();
    expect(FakeRecorder.last?.state).toBe('recording');
    // And no live text where the server doesn't stream.
    act(() => root!.unmount());
    host!.remove();
    FakeSocket.last = undefined;
    await render({
        shell: shellWith({ streaming: false, preference: 'server' }),
    });
    await click(mic());
    expect(FakeSocket.last).toBeUndefined();
    expect(addModule).toHaveBeenCalledTimes(2);
});

it('sends the recording when Done comes before the socket opens', async () => {
    browserCan({ live: true });
    await render({ shell: shellWith({ streaming: true, preference: 'server' }) });
    await click(mic());
    const socket = FakeSocket.last!;
    await act(async () => FakeWorkletNode.last!.hear(1600));
    await click($('[aria-label="Done dictating"]'));
    await settle();
    // No socket left to open later, and the audio went once, as a recording.
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
    expect(socket.sent).toEqual([]);
    const upload = requests.find((r) => r.url === '/api/voice/transcriptions');
    expect((upload!.init!.body as Blob).size).toBe(44 + 1600 * 2);
    expect(draft().value).toBe('from server');
});

/** The recording's text, held back until the test answers. */
function holdTranscript() {
    const held = { answer: (_text: string) => {} };
    transcript = () => new Promise<Response>((resolve) => (held.answer = (text) => resolve(Response.json({ text }))));
    return held;
}
const uploads = () => requests.filter((r) => r.url === '/api/voice/transcriptions');
const uploadSignal = () => uploads()[0].init?.signal as AbortSignal;

it('waits for the recording past 15 s when there is no streamed text to fall back on', async () => {
    browserCan({ live: true });
    const held = holdTranscript();
    await render({ shell: shellWith({ streaming: true, preference: 'server' }) });
    await click(mic());
    const socket = FakeSocket.last!;
    await act(async () => socket.open());
    await act(async () => FakeWorkletNode.last!.hear(1600));
    // The stream dropped: nothing to fall back on.
    await act(async () => socket.close());
    vi.useFakeTimers();
    // Any time limit on the upload runs on the test's clock too.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
        return controller.signal;
    });
    try {
        await act(async () => $('[aria-label="Done dictating"]')!.click());
        // A slow uplink: a minute and still going, never cut off here.
        await act(async () => vi.advanceTimersByTimeAsync(60_000));
        expect($('[data-slot="dictation-transcribing"]')).not.toBeNull();
        expect(uploads()).toHaveLength(1);
        expect(uploadSignal().aborted).toBe(false);
        await act(async () => held.answer('a long note'));
        await act(async () => vi.advanceTimersByTimeAsync(0));
        expect(draft().value).toBe('a long note');
        expect($('[data-slot="dictation-error"]')).toBeNull();
    } finally {
        vi.useRealTimers();
    }
});

it('takes the streamed final text when the recording is still going after 15 s', async () => {
    browserCan({ live: true });
    const held = holdTranscript();
    await render({ shell: shellWith({ streaming: true, preference: 'server' }) });
    await click(mic());
    const socket = FakeSocket.last!;
    await act(async () => socket.open());
    await act(async () => FakeWorkletNode.last!.hear(1600));
    await act(async () => socket.say({ type: 'partial', text: 'buy milk' }));
    vi.useFakeTimers();
    try {
        await act(async () => $('[aria-label="Done dictating"]')!.click());
        await act(async () => vi.advanceTimersByTimeAsync(500));
        expect(socket.messages().at(-1)).toEqual({ type: 'done' });
        await act(async () => socket.say({ type: 'final', text: 'Buy milk.' }));
        await act(async () => vi.advanceTimersByTimeAsync(14_000));
        // Under 15 s: still waiting for the recording's text.
        expect($('[data-slot="dictation-transcribing"]')?.textContent).toContain('Finishing');
        expect(draft().value).toBe('');
        await act(async () => vi.advanceTimersByTimeAsync(1_000));
        expect(draft().value).toBe('Buy milk.');
        // The upload is given up on; its late answer changes nothing.
        expect(uploadSignal().aborted).toBe(true);
        await act(async () => held.answer('too late'));
        await act(async () => vi.advanceTimersByTimeAsync(0));
        expect(draft().value).toBe('Buy milk.');
    } finally {
        vi.useRealTimers();
    }
});

it('finishes in a browser without AbortSignal.any, and never hangs on a failure', async () => {
    const any = AbortSignal.any;
    // Safari before 17.4.
    Object.defineProperty(AbortSignal, 'any', {
        value: undefined,
        configurable: true,
    });
    try {
        browserCan({ live: true });
        await render({
            shell: shellWith({ streaming: true, preference: 'server' }),
        });
        await click(mic());
        let socket = FakeSocket.last!;
        await act(async () => socket.open());
        await act(async () => FakeWorkletNode.last!.hear(1600));
        await click($('[aria-label="Done dictating"]'));
        await settle();
        expect(draft().value).toBe('from server');

        // Something else this browser lacks throws at Done: an error, not
        // "Finishing…" for ever, and the mic is off all the same.
        const flush = vi.spyOn(FakeWorkletNode.prototype, 'flush').mockImplementation(() => {
            throw new Error('Not supported');
        });
        track.stop.mockClear();
        await click(mic());
        socket = FakeSocket.last!;
        await act(async () => socket.open());
        await act(async () => FakeWorkletNode.last!.hear(1600));
        await click($('[aria-label="Done dictating"]'));
        await settle();
        expect($('[data-slot="dictation-transcribing"]')).toBeNull();
        expect($('[data-slot="dictation-error"]')?.textContent).toMatch(/Transcription failed/);
        expect(socket.readyState).toBe(FakeSocket.CLOSED);
        expect(track.stop).toHaveBeenCalled();
        flush.mockRestore();
    } finally {
        Object.defineProperty(AbortSignal, 'any', {
            value: any,
            configurable: true,
        });
    }
});

it('cancels while finishing: nothing goes in the draft, the upload stops', async () => {
    browserCan({ live: true });
    const held = holdTranscript();
    await render({ shell: shellWith({ streaming: true, preference: 'server' }) });
    await type('Keep');
    await click(mic());
    const socket = FakeSocket.last!;
    await act(async () => socket.open());
    await act(async () => FakeWorkletNode.last!.hear(1600));
    await act(async () => socket.say({ type: 'partial', text: 'oops' }));
    await click($('[aria-label="Done dictating"]'));
    await settle();
    expect($('[data-slot="dictation-transcribing"]')?.textContent).toContain('Finishing');
    await click($('[aria-label="Cancel dictation"]'));
    await settle();
    expect($('[data-slot="dictation-transcribing"]')).toBeNull();
    expect(uploadSignal().aborted).toBe(true);
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
    await act(async () => socket.say({ type: 'final', text: 'oops' }));
    await act(async () => held.answer('oops'));
    await settle();
    expect(draft().value).toBe('Keep');
    expect($('[data-slot="dictation-error"]')).toBeNull();
    expect(mic()).not.toBeNull();
});

it('turns the mic off even when the audio graph won’t disconnect', async () => {
    browserCan({ live: true });
    await render({ shell: shellWith({ streaming: true, preference: 'server' }) });
    vi.spyOn(FakeAudioContext.prototype, 'createMediaStreamSource').mockReturnValue({
        connect() {},
        disconnect() {
            throw new Error('Not supported');
        },
    });
    const disconnect = vi.spyOn(FakeWorkletNode.prototype, 'disconnect').mockImplementation(() => {
        throw new Error('Not supported');
    });
    track.stop.mockClear();
    await click(mic());
    const socket = FakeSocket.last!;
    await act(async () => socket.open());
    await act(async () => FakeWorkletNode.last!.hear(1600));
    await click($('[aria-label="Done dictating"]'));
    await settle();
    expect(track.stop).toHaveBeenCalled();
    expect(FakeAudioContext.last?.closed).toBe(true);
    // And Done goes on as usual.
    expect(draft().value).toBe('from server');
    disconnect.mockRestore();
});
