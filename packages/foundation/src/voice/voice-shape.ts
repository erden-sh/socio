import type { IncomingMessage } from 'node:http';

import type { CallReceipt } from '@socio/shared/types';
import type { DictationLanguage } from '@socio/shared/voice/dictation-languages';
import type { VoiceBackend } from '@socio/shared/voice/voice-call';

import type { TranscriptionProvider } from './transcription-provider.js';

/*
 * What the workspace's routes (`/api/voice/*`) call of voice, and the key an
 * HTTP upgrade is claimed with. Moved from
 * `src/server/voice/contract.ts`, which re-exports every name here and
 * keeps the `Dictation` and `Voice` tags over these shapes: the
 * workspace sits below voice in the folder order, so it reads them here.
 */

/** The key the route claims an upgrade with, in the request's env. */
export const UPGRADE_ENV = 'socioUpgrade';

/**
 * A request's env when it came through the HTTP server's `upgrade` event
 * (`dictationUpgrade`): the Node request, and the claim its route calls
 * with what to do with the accepted socket. `Socket` is `ws`'s `WebSocket`
 * at runtime; `ws` isn't on the contract's import allowlist, so it is a
 * parameter here, `BrowserSocket` by default.
 */
export interface UpgradeEnv<Socket = BrowserSocket> {
    incoming?: IncomingMessage;
    [UPGRADE_ENV]?: (accept: (socket: Socket) => void) => void;
}

/**
 * The browser's socket an upgrade accepted (`ws`'s `WebSocket`), as the
 * tags over these shapes take it: callers only pass it on from `UpgradeEnv`.
 */
export interface BrowserSocket {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number): void;
}

/**
 * Why live text can't start now, for the route to answer with
 * (`DictationShape.admit`).
 */
export interface DictationRefusal {
    status: 409 | 429;
    error: string;
}

/**
 * Live text's relays (CB-222, `DictationStreams`): `Platform` holds one
 * (`dictationStreams`); its setup, the polled views' versions, Settings'
 * save, the workspace's routes (through `Voice.streams`) and shutdown use
 * it.
 */
export interface DictationShape {
    /**
     * `auto`, and this server's socket turned out missing a while ago: the
     * composer records, then sends, until it is forgotten.
     */
    recordingsOnly(provider: TranscriptionProvider): boolean;
    /** Forgets the servers without a socket: an admin changed the URL, key or setting. */
    forget(): void;
    /** Undefined when the person may start a session now (it counts toward their rate); else why not. */
    admit(provider: TranscriptionProvider, userId: string): DictationRefusal | undefined;
    /** Relays one browser socket to `provider.realtimeUrl` until Done, the limits, or either side closes. */
    start(browser: BrowserSocket, userId: string, provider: TranscriptionProvider, language?: DictationLanguage): void;
    /** Ends every session (a pause, a drain); each composer sends its recording. */
    closeAll(): void;
}

/**
 * Calls and dictation (`VoiceService`): what the workspace's routes
 * (`/api/voice/*`) and Settings' save call, with the signatures they have
 * today. `spokenTurn` is the call session's own, so it isn't here.
 */
export interface VoiceShape {
    /** Live text's relays: the platform's, or the service's own without one. */
    readonly streams: DictationShape;
    /** The backend in force for calls (CB-265): an admin's over `VOICE_BACKEND`. */
    backend(): VoiceBackend;
    /** Starts a cloud call: the provider's answer to the browser's SDP. */
    begin(threadId: string, sdp: string, signal: AbortSignal): Promise<{ id: string; sdp: string }>;
    /** Starts a self-hosted call (CB-265); its socket comes with `attach`. */
    beginSelfHosted(threadId: string): Promise<{ id: string; backend: 'self-hosted' }>;
    /** A self-hosted call's browser socket, already checked as the call's owner's. */
    attach(id: string, browser: BrowserSocket): void;
    activate(id: string): CallReceipt;
    /** One of a cloud call's tool calls: the socio's answer. */
    compute(id: string, toolCallId: string, request: string): Promise<string>;
    end(id: string, transcript: string): Promise<CallReceipt>;
    /** Dictation (CB-101): one recording's text. */
    transcribe(audio: Uint8Array, type: string, signal: AbortSignal, userId?: string): Promise<string>;
    /** The transcription server in force, when it can be used now; else throws why not. */
    dictationProvider(): TranscriptionProvider;
    /** One person's dictation language (CB-221); undefined for Auto. */
    dictationLanguage(userId: string): DictationLanguage | undefined;
    /** A pause: ends live text and every call. */
    abortAll(): void;
    /** A resume: syncs the receipts a pause left pending. */
    resumePending(): Promise<void>;
}
