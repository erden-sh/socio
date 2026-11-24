import { CALL_STREAM, type CallStreamEvent } from '@socio/shared/voice/voice-call';

import { DICTATION_WORKLET_URL, liveAudioContext } from './dictation-stream';

/**
 * A self-hosted voice call in the browser (CB-265). The microphone goes
 * to this server as 16 kHz PCM from the dictation worklet
 * (public/dictation-worklet.js) over the call's socket (`CALL_STREAM`);
 * the server relays it to the workspace's voice server and runs the
 * socio's turns. The reply's speech comes back as 24 kHz PCM and plays
 * through Web Audio, or, with no speech server, this device speaks it
 * (speechSynthesis). While the device speaks, the microphone isn't sent:
 * the device's own voice isn't echo-canceled everywhere, and the socio
 * would hear itself.
 */

export interface SelfHostedCallEvents {
    /** The voice server is listening; `speech`: it speaks the replies. */
    onReady: (speech: boolean) => void;
    onPhase: (phase: 'listening' | 'speaking' | 'thinking') => void;
    /** What the person is saying so far, then what they said. */
    onPartial: (text: string) => void;
    onHeard: (text: string) => void;
    /** The socio's reply, as text. */
    onReply: (text: string) => void;
    onNotice: (text: string) => void;
    /** The call is over: the server's reason, or none when the socket just closed. */
    onEnded: (reason?: string) => void;
}

/** This browser can run a self-hosted call: PCM capture, Web Audio and a socket. */
export const selfHostedCallSupported = () =>
    typeof AudioWorkletNode !== 'undefined' &&
    typeof WebSocket !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia;

/** The device's own voice, when this browser has one. */
const deviceVoice = () =>
    typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : undefined;

/**
 * An AudioContext and a primed device voice, made in the tap (before the
 * microphone is asked for): iOS lets only those made in a gesture run.
 */
export function callAudio() {
    const context = liveAudioContext();
    const voice = deviceVoice();
    try {
        voice?.speak(new SpeechSynthesisUtterance(''));
    } catch {
        // Not in this browser.
    }
    return context;
}

export class SelfHostedCall {
    private socket: WebSocket;
    private queue: ArrayBuffer[] = [];
    private playing = new Set<AudioBufferSourceNode>();
    private playAt = 0;
    private gain: GainNode;
    /** The server sent all of the reply's speech. */
    private spoken = true;
    private deviceSpeaking = false;
    private ended = false;

    private constructor(
        id: string,
        private context: AudioContext,
        private stream: MediaStream,
        private node: AudioWorkletNode,
        private source: MediaStreamAudioSourceNode,
        private events: SelfHostedCallEvents,
    ) {
        this.gain = context.createGain();
        this.gain.connect(context.destination);
        const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.socket = new WebSocket(`${scheme}//${location.host}${CALL_STREAM.path}?id=${encodeURIComponent(id)}`);
        this.socket.binaryType = 'arraybuffer';
        this.socket.onopen = () => {
            for (const chunk of this.queue.splice(0)) {
                this.socket.send(chunk);
            }
        };
        this.socket.onmessage = (message) => {
            if (message.data instanceof ArrayBuffer) {
                this.play(message.data);
                return;
            }
            let event: CallStreamEvent;
            try {
                event = JSON.parse(String(message.data)) as CallStreamEvent;
            } catch {
                return;
            }
            this.handle(event);
        };
        this.socket.onclose = () => this.finish();
        this.socket.onerror = () => this.finish();
        this.node.port.onmessage = (message) => {
            if (message.data === 'flushed') {
                return;
            }
            this.send(message.data as ArrayBuffer);
        };
    }

    /** Starts capturing from `stream` into `context`, and opens the call's socket. */
    static async start(id: string, context: AudioContext, stream: MediaStream, events: SelfHostedCallEvents) {
        await context.audioWorklet.addModule(DICTATION_WORKLET_URL);
        const node = new AudioWorkletNode(context, 'socio-pcm16', {
            processorOptions: { rate: CALL_STREAM.inputRate },
        });
        const source = context.createMediaStreamSource(stream);
        source.connect(node);
        // Into the output (silent) so every browser runs it.
        node.connect(context.destination);
        await context.resume?.();
        return new SelfHostedCall(id, context, stream, node, source, events);
    }

    private send(chunk: ArrayBuffer) {
        if (this.ended || this.deviceSpeaking) {
            return;
        }
        if (this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(chunk);
        } else if (this.socket.readyState === WebSocket.CONNECTING)
        // About 2 s, until the socket opens.
        {
            this.queue = [...this.queue, chunk].slice(-20);
        }
    }

    private handle(event: CallStreamEvent) {
        switch (event.type) {
            case 'ready':
                this.events.onReady(event.speech);
                this.events.onPhase('listening');
                return;
            case 'speech':
                this.stopSpeaking();
                this.events.onPhase('listening');
                return;
            case 'partial':
                this.events.onPartial(event.text);
                return;
            case 'heard':
                this.events.onHeard(event.text);
                return;
            case 'thinking':
                if (!this.busy) {
                    this.events.onPhase('thinking');
                }
                return;
            case 'reply':
                this.events.onReply(event.text);
                this.events.onPhase('speaking');
                if (event.audio) {
                    this.spoken = false;
                } else {
                    this.speakOnDevice(event.text);
                }
                return;
            case 'say':
                this.speakOnDevice(event.text);
                return;
            case 'spoken':
                this.spoken = true;
                this.idle();
                return;
            case 'notice':
                this.events.onNotice(event.text);
                return;
            case 'ended':
                this.finish(event.reason);
                return;
        }
    }

    /** Speech playing or still coming. */
    private get busy() {
        return this.playing.size > 0 || !this.spoken || this.deviceSpeaking;
    }

    private idle() {
        if (!this.busy && !this.ended) {
            this.events.onPhase('listening');
        }
    }

    /** One chunk of the reply's speech: 16-bit mono at `CALL_STREAM.outputRate`. */
    private play(data: ArrayBuffer) {
        if (this.ended || data.byteLength < 2) {
            return;
        }
        const samples = new Int16Array(data, 0, data.byteLength >> 1);
        const buffer = this.context.createBuffer(1, samples.length, CALL_STREAM.outputRate);
        const channel = buffer.getChannelData(0);
        for (let i = 0; i < samples.length; i++) {
            channel[i] = samples[i] / 0x8000;
        }
        const node = this.context.createBufferSource();
        node.buffer = buffer;
        node.connect(this.gain);
        this.playAt = Math.max(this.playAt, this.context.currentTime + 0.05);
        node.start(this.playAt);
        this.playAt += buffer.duration;
        this.playing.add(node);
        node.onended = () => {
            this.playing.delete(node);
            this.idle();
        };
    }

    private speakOnDevice(text: string) {
        const voice = deviceVoice();
        if (!voice || !text || this.ended) {
            this.idle();
            return;
        }
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.volume = this.gain.gain.value;
        utterance.lang = document.documentElement.lang || navigator.language;
        this.deviceSpeaking = true;
        const done = () => {
            this.deviceSpeaking = false;
            this.idle();
        };
        utterance.onend = done;
        utterance.onerror = done;
        voice.speak(utterance);
    }

    /** Stops the reply: what plays, what is queued, and the device's voice. */
    private stopSpeaking() {
        for (const node of this.playing) {
            try {
                node.stop();
            } catch {
                // Already stopped.
            }
        }
        this.playing.clear();
        this.playAt = 0;
        if (this.deviceSpeaking) {
            deviceVoice()?.cancel();
            this.deviceSpeaking = false;
        }
    }

    /** The Interrupt button: the socio stops speaking, and listens. */
    interrupt() {
        this.stopSpeaking();
        if (this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ type: 'interrupt' }));
        }
        this.spoken = true;
        this.idle();
    }

    /** The Speaker button. */
    setSpeakerMuted(muted: boolean) {
        this.gain.gain.value = muted ? 0 : 1;
        if (muted && this.deviceSpeaking) {
            deviceVoice()?.cancel();
            this.deviceSpeaking = false;
        }
    }

    private finish(reason?: string) {
        if (this.ended) {
            return;
        }
        this.close();
        this.events.onEnded(reason);
    }

    /** Ends everything here; the server ends the call when the socket closes. */
    close() {
        if (this.ended) {
            return;
        }
        this.ended = true;
        this.stopSpeaking();
        const step = (fn: () => unknown) => {
            try {
                fn();
            } catch {
                // Already gone, or not in this browser.
            }
        };
        // The microphone first, so it never stays on.
        this.stream.getTracks().forEach((track) => step(() => track.stop()));
        step(() => this.source.disconnect());
        step(() => this.node.disconnect());
        this.node.port.onmessage = null;
        if (this.socket.readyState <= WebSocket.OPEN) {
            step(() => this.socket.close());
        }
        step(() => void this.context.close().catch(() => undefined));
    }
}
