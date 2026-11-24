import { DICTATION_LIMITS, DICTATION_STREAM, type DictationStreamEvent } from '@socio/shared/voice/dictation';

/**
 * Live text while dictating (CB-222): the microphone as 16 kHz PCM, from
 * an AudioWorklet (public/dictation-worklet.js), streamed over a socket to
 * this server, which relays it to the transcription server and sends back
 * the text so far. MediaRecorder isn't used: iOS records only mp4 with it,
 * in pieces a realtime server can't read; PCM is what the server takes,
 * and an AudioWorklet works in Safari (14.5 on) and Chrome. Every chunk is
 * kept here too: the streamed text is a preview, and on Done the whole
 * recording (as WAV) is transcribed for the final text (use-dictation.ts),
 * so a socket that fails or drops loses nothing either.
 */

export const DICTATION_WORKLET_URL = '/dictation-worklet.js';
/** How long Done waits for the streamed final text. */
export const LIVE_FINAL_WAIT_MS = 20_000;
/**
 * How long Done waits for the recording's text (the final one) before a
 * streamed final text, if one comes, takes its place. Without one, it
 * waits for the recording's text as long as that takes.
 */
export const LIVE_BATCH_WAIT_MS = 15_000;
/** How long Done waits for the worklet's last samples. */
const FLUSH_WAIT_MS = 300;

type AudioContextConstructor = new () => AudioContext;
function audioContextConstructor(): AudioContextConstructor | undefined {
    if (typeof window === 'undefined') {
        return undefined;
    }
    const scope = window as unknown as {
        AudioContext?: AudioContextConstructor;
        webkitAudioContext?: AudioContextConstructor;
    };
    return scope.AudioContext ?? scope.webkitAudioContext;
}

/** This browser can capture PCM and open the socket. */
export const liveDictationSupported = () =>
    !!audioContextConstructor() &&
    typeof AudioWorkletNode !== 'undefined' &&
    typeof WebSocket !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia;

/**
 * An AudioContext, made in the tap (before the microphone is asked for):
 * iOS lets only one made in a gesture run.
 */
export function liveAudioContext() {
    const Constructor = audioContextConstructor();
    return Constructor ? new Constructor() : undefined;
}

/** 16-bit mono PCM chunks as a WAV file. */
export function wavFile(chunks: Int16Array<ArrayBuffer>[], rate: number) {
    const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const header = new DataView(new ArrayBuffer(44));
    const text = (offset: number, value: string) => {
        for (let i = 0; i < value.length; i++) {
            header.setUint8(offset + i, value.charCodeAt(i));
        }
    };
    text(0, 'RIFF');
    header.setUint32(4, 36 + samples * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    header.setUint32(16, 16, true);
    header.setUint16(20, 1, true); // PCM
    header.setUint16(22, 1, true); // mono
    header.setUint32(24, rate, true);
    header.setUint32(28, rate * 2, true);
    header.setUint16(32, 2, true);
    header.setUint16(34, 16, true);
    text(36, 'data');
    header.setUint32(40, samples * 2, true);
    return new Blob([header.buffer, ...chunks], {
        type: 'audio/wav',
    });
}

/**
 * What Done gives: the recording, to transcribe whole for the final text,
 * and the streamed final text, for when that fails (undefined when the
 * stream gave none).
 */
export interface LiveResult {
    clip: Blob | null;
    streamed: Promise<string | undefined>;
}

/** One live dictation: capture, socket, and the recording kept beside them. */
export class LiveDictation {
    private chunks: Int16Array<ArrayBuffer>[] = [];
    private samples = 0;
    private socket: WebSocket;
    /** The socket can still give the final text. */
    private live = true;
    private queue: ArrayBuffer[] = [];
    private settle?: (text: string | undefined) => void;
    private flushed?: () => void;
    private ended = false;
    /** Done was pressed. */
    private finishing = false;

    private constructor(
        private context: AudioContext,
        private stream: MediaStream,
        private node: AudioWorkletNode,
        private source: MediaStreamAudioSourceNode,
        private onPartial: (text: string) => void,
        private onFull: () => void,
    ) {
        const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.socket = new WebSocket(`${scheme}//${location.host}${DICTATION_STREAM.path}`);
        this.socket.binaryType = 'arraybuffer';
        this.socket.onopen = () => {
            for (const chunk of this.queue.splice(0)) {
                this.socket.send(chunk);
            }
        };
        this.socket.onmessage = (message) => {
            let event: DictationStreamEvent;
            try {
                event = JSON.parse(String(message.data)) as DictationStreamEvent;
            } catch {
                return;
            }
            if (event.type === 'partial' && this.live) {
                this.onPartial(event.text);
            } else if (event.type === 'final' && this.settle) {
                this.settle(event.text);
            }
            // Unasked for, a final text misses what follows: the recording goes.
            else if (event.type === 'final' || event.type === 'unavailable') {
                this.drop();
            }
        };
        this.socket.onclose = this.socket.onerror = () => this.drop();
        this.node.port.onmessage = (message) => {
            if (message.data === 'flushed') {
                this.flushed?.();
                return;
            }
            this.take(new Int16Array(message.data as ArrayBuffer));
        };
    }

    /**
     * Starts capturing from `stream` into `context`; throws when the
     * worklet can't run here (the caller records instead).
     */
    static async start(
        context: AudioContext,
        stream: MediaStream,
        onPartial: (text: string) => void,
        onFull: () => void,
    ) {
        await context.audioWorklet.addModule(DICTATION_WORKLET_URL);
        const node = new AudioWorkletNode(context, 'socio-pcm16', {
            processorOptions: { rate: DICTATION_STREAM.sampleRate },
        });
        const source = context.createMediaStreamSource(stream);
        source.connect(node);
        // Into the output (silent) so every browser runs it.
        node.connect(context.destination);
        await context.resume?.();
        return new LiveDictation(context, stream, node, source, onPartial, onFull);
    }

    private take(chunk: Int16Array<ArrayBuffer>) {
        if (this.ended) {
            return;
        }
        const room = DICTATION_LIMITS.maxSeconds * DICTATION_STREAM.sampleRate;
        if (this.samples + chunk.length > room) {
            this.onFull();
            return;
        }
        this.chunks.push(chunk);
        this.samples += chunk.length;
        if (!this.live) {
            return;
        }
        if (this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(chunk);
        } else if (this.socket.readyState === WebSocket.CONNECTING) {
            this.queue.push(chunk.slice().buffer);
        }
    }

    /** No live text from here on: Done sends the recording. */
    private drop() {
        if (!this.live) {
            return;
        }
        this.live = false;
        this.queue = [];
        // The text so far won't be confirmed: the recording's replaces it.
        // After Done it stays, as the preview, until the final text is in.
        if (!this.finishing) {
            this.onPartial('');
        }
        this.settle?.(undefined);
        if (this.socket.readyState <= WebSocket.OPEN) {
            this.socket.close();
        }
    }

    private release() {
        this.ended = true;
        // The microphone first, and each step on its own: one that throws
        // (an older browser) never leaves the mic on.
        const step = (fn: () => unknown) => {
            try {
                fn();
            } catch {
                // Already gone, or not in this browser.
            }
        };
        this.stream.getTracks().forEach((track) => step(() => track.stop()));
        step(() => this.source.disconnect());
        step(() => this.node.disconnect());
        this.node.port.onmessage = null;
        step(() => void this.context.close().catch(() => undefined));
    }

    /**
     * Done: capture stops, and the recording and the streamed final text
     * (asked for now, it comes on its own) are given back at once.
     */
    async finish(): Promise<LiveResult> {
        if (this.ended) {
            return { clip: null, streamed: Promise.resolve(undefined) };
        }
        this.finishing = true;
        // The last few samples the worklet holds.
        await new Promise<void>((resolve) => {
            this.flushed = resolve;
            this.node.port.postMessage('flush');
            setTimeout(resolve, FLUSH_WAIT_MS);
        });
        this.release();
        const clip = this.samples ? wavFile(this.chunks, DICTATION_STREAM.sampleRate) : null;
        if (!this.live || this.socket.readyState !== WebSocket.OPEN) {
            // Not open yet, or gone: no live text, and no socket left open.
            this.drop();
            return { clip, streamed: Promise.resolve(undefined) };
        }
        const streamed = new Promise<string | undefined>((resolve) => {
            const timer = setTimeout(() => resolve(undefined), LIVE_FINAL_WAIT_MS);
            this.settle = (value) => {
                clearTimeout(timer);
                this.settle = undefined;
                resolve(value);
            };
        });
        this.socket.send(JSON.stringify({ type: 'done' }));
        return { clip, streamed };
    }

    /** Ends everything (or what is left after Done); nothing more is sent. */
    cancel() {
        this.live = false;
        this.settle?.(undefined);
        if (this.socket.readyState <= WebSocket.OPEN) {
            this.socket.close();
        }
        if (!this.ended) {
            this.release();
        }
    }
}
