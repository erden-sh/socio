import type { Message } from '@ag-ui/core';

import type { HistoryRun } from '@socio/shared/chat/chat-history';
import { STEERING_MAX_CHARS } from '@socio/shared/chat/steering';
import type { AttachmentRef } from '@socio/shared/media-types';
import type { LiveTurn } from '@socio/shared/rooms/live-turn';
import { AG_UI_EVENT } from '@socio/shared/runs/event-types';

import type { AuthedFetch } from '../net/authed-fetch';
import { NetworkError } from '../net/errors';
import { CYCLE_RATE_WAIT_MS, type RunFailure, unhandledRunFailure } from '../net/run-answer';
import { createRunClient, type RunOutcome } from '../net/run-client';

import { type Attachments, reuploadHook } from './attachments';
import type { FollowStore } from './follow';
import type { ChatHistory, HistoryStore } from './history';
import { CONVERSATION_IDS, serverChatId } from './local-ids';
import {
    type CheckOutcome,
    HeldForSignIn,
    type NewOutboxWrite,
    type Outbox,
    type OutboxContext,
    type OutboxKind,
    type OutboxWrite,
    type SendOutcome,
} from './outbox';
import { type Answer, classify, readAnswer, reasonOf } from './outbox-answers';
import type { Overlay, OverlayKind } from './outbox-overlay';
import { serverSince } from './server-clock';
import type { ChatSteering, SteeringStore } from './steering';
import { recoverRun, type TurnRecovery } from './turn-recovery';

// Sending in a private chat: the outbox kind of a
// message the person wrote to their socio. One lane per chat
// (`chat:<threadId>`), one message in flight.
//
// - **Run or steering.** Before each send the lane pulls the chat's
//   `/steering` and then its `/history?after` (the pre-pull); then the page
//   reviews' `prepare` hook holds it while a page review is open. While a
//   turn runs the message goes as steering (`POST …/steering`); otherwise as
//   a run (the run client), whose body is the stored history's tail plus
//   exactly this row's message.
// - **Steering's limits**: a message over `STEERING_MAX_CHARS`
//   waits for the turn to end and goes as a run ("Sends when <socio>
//   finishes"); the lane never runs more than the view's `maxQueued` ahead;
//   a 429 (`cycle_rate`, `queue_full`) holds the lane for its window; a 409
//   (a Telegram chat) goes to `unsent`; a 400 re-uploads once with
//   attachments (the `reupload` hook, attachments.ts's), else goes to
//   `unsent`. Any 2xx reads the body's `delivered`: either way the server has
//   it, under its own id, which the `ids` map records.
// - **The busy-thread rule**: a run answered with any 5xx
//   that isn't the server being away pulls `/steering` and `/history`. Its
//   message already stored is sent; absent while a turn runs (started
//   elsewhere), the row is rewritten in place to go as steering (same lane,
//   same position); absent with no turn, it goes again after the back-off.
//   Nothing reads the server's text.
// - **Long-queued messages:** a message that has waited over 3 hours, or
//   across an app restart, or past turns that finished since it was written,
//   is held for the person ("Send now", `sendNow`) instead of going by itself.
// - **The check** of a send that may have reached the server: pull
//   `/steering`, then `/history`. Its own id stored means sent. A steering
//   send is matched by its exact text and files against what wasn't there
//   when it was written (the watermark) and isn't another write's (`ids`):
//   one candidate is sent, two the person decides. None while a turn still
//   runs waits (`later`), since the turn may hold it; none with no turn means
//   nothing reached the server, and it goes again. So no message is ever sent
//   twice by the app.
// - **Exactly once**: a run's recovery is shared's `recoverTurn`
//   (turn-recovery.ts): its id in a replayed run's input, or stored, is sent,
//   even while the turn streams; the busy-thread rule asks it too before it
//   moves a row to steering, since the running turn may be the row's own. The
//   watermark keeps the server's Date (`serverAt`, server-clock.ts): a
//   candidate is what the server stored at or after it less a slack
//   (`serverSince`, as a proxy's Date may run ahead), on its own clock. A
//   row a restart forgot is matched like a steering one: one candidate is it,
//   two the person decides ("Couldn't confirm this was sent", View and Send
//   again; the hold keeps the candidates for View).
// - After its own write, the lane's chat is pulled again (`afterWrite`, the
//   web's `notesForWrite`).
// - **A new chat's messages** carry its local id (local-ids.ts) and
//   wait for its create (`dependsOn`); each send and check resolves it
//   through the `ids` map, so the requests name the server's id. A message
//   whose chat was never created (its create discarded) goes to `unsent`
//   (`no-chat`).
//
// No React Native: tests/sync runs it under Node against a fake server.

export const CHAT_MESSAGE_KIND = 'chat-message';
export const CHAT_MESSAGE_VERSION = 1;
/** The `ids` map's kind for a message's server id (a steering message's; a run's is its own). */
export const MESSAGE_IDS = 'message';

/** A queued message older than this asks before it goes. */
export const QUEUED_ASK_AFTER_MS = 3 * 60 * 60_000;
/** How often a message that waits for the turn (too long for steering) looks again. */
export const TURN_WAIT_MS = 5_000;
/** How long a lane at `maxQueued` (or a `queue_full`) waits before it looks again. */
export const QUEUE_WAIT_MS = 5_000;

/** The reasons a chat message's row carries while it waits (the composer words them). */
export const CHAT_WAIT = {
    /** A page review is open in the chat: it goes once the person decides. */
    review: 'page-review',
    /** Too long for steering: it goes as a run once the turn ends. */
    turn: 'waits-for-turn',
    /** The socio hasn't read the earlier queued messages yet. */
    queue: 'queue_full',
    /** It waited long, across a restart, or past newer turns. */
    ask: 'ask-before-sending',
    /** No model: the run can't start (`NO_INFERENCE_MESSAGES`). */
    setup: 'no-inference',
    /** The busy-thread rule moved it to steering. */
    busy: 'busy',
} as const;

/** A message waiting on an open page review. */
export const REVIEW_HOLD_LINE = 'Your message will send after you decide';

/** What the composer shows for a wait, naming the socio. */
export const chatWaitCopy = (reason: string | null, socio: string): string | null => {
    switch (reason) {
        case CHAT_WAIT.turn:
            return `Sends when ${socio} finishes`;
        case CHAT_WAIT.queue:
            return `Waiting for ${socio} to read your earlier messages`;
        case CHAT_WAIT.review:
            return REVIEW_HOLD_LINE;
        default:
            return null;
    }
};

/** What the chat held when the message was written: the check's watermark and the newer-turns test. */
export interface ChatWatermark {
    /** The newest stored run's seq, or null for none. */
    readonly after: number | null;
    /** The server ids of the person's queued messages then. */
    readonly queued: readonly string[];
    /** A turn ran then: the first run to finish after it isn't a newer turn. */
    readonly running: boolean;
    /**
     * The newest Date header the scope had seen (server-clock.ts), or
     * null for none: a candidate the server stored before it isn't this
     * write. Missing in rows an older build wrote.
     */
    readonly serverAt?: number | null;
}

/** A message to a socio in a private chat, as its outbox row keeps it. */
export interface ChatMessagePayload {
    readonly threadId: string;
    readonly dotId: string;
    readonly text: string;
    /** Files uploaded for it, by reference. */
    readonly attachments?: readonly AttachmentRef[];
    readonly watermark: ChatWatermark;
    /** It may have gone as steering (the busy-thread rule moved it): its check matches by text. */
    readonly steered?: true;
    /** Its files were uploaded again once after a 400 (the rule's "once"). */
    readonly reuploaded?: true;
}

/** A chat's lane: one message in flight per chat. */
export const chatLane = (threadId: string) => `chat:${threadId}`;
/** The chat a lane is, or null for another kind's lane. */
export const laneThread = (lane: string): string | null => (lane.startsWith('chat:') ? lane.slice(5) : null);

/**
 * Settles the outbox's sent chat messages against the stored histories
 * (`caughtUp`): a row that becomes `sent` while its chat's
 * history already holds it goes at once, and the rest go as runs enter the
 * chat (the history store's `onRuns`, which `onRuns` here is). Returns the unsubscribe.
 */
export function followStoredChats(
    outbox: Pick<Outbox, 'subscribe' | 'caughtUp' | 'resolve'>,
    histories: Pick<HistoryStore, 'held' | 'history'>,
    onError: (error: unknown) => void = () => {},
): () => void {
    return outbox.subscribe((change) => {
        if (change.type !== 'upsert' || change.row.state !== 'sent') {
            return;
        }
        const lanes = laneThread(change.row.lane);
        // A new chat's lane keeps its local id: its history is the server id's.
        const threadId = lanes === null ? null : serverChatId(outbox.resolve, lanes);
        if (threadId !== null && histories.held().includes(threadId)) {
            const history = histories.history(threadId);
            outbox.caughtUp(change.row.lane, (id) => history.has(id)).catch(onError);
        }
    });
}

/** The steering and history paths of a chat. */
export const steeringPath = (threadId: string) => `/api/conversations/${encodeURIComponent(threadId)}/steering`;
const conversationPath = (threadId: string) => `/api/conversations/${encodeURIComponent(threadId)}`;

/** The AG-UI message a row carries: its text, and its files as references (shared's `AttachmentPart`). */
export function chatMessage(id: string, payload: Pick<ChatMessagePayload, 'text' | 'attachments'>): Message {
    const files = payload.attachments ?? [];
    if (files.length === 0) {
        return { id, role: 'user', content: payload.text };
    }
    return {
        id,
        role: 'user',
        content: [
            ...(payload.text.trim() ? [{ type: 'text' as const, text: payload.text }] : []),
            ...files.map((file) => ({
                type: 'binary' as const,
                id: file.id,
                mimeType: file.mediaType,
                filename: file.name,
            })),
        ],
    } as Message;
}

export interface ChatMessageInput {
    /** The message's id (expo-crypto), which the run carries and the server deduplicates. */
    readonly id: string;
    /** A fresh UUID. */
    readonly idempotencyKey: string;
    readonly threadId: string;
    readonly dotId: string;
    readonly text: string;
    readonly attachments?: readonly AttachmentRef[];
    /** The chat's history and steering snapshot as the composer shows them: the watermark. */
    readonly history: Pick<ChatHistory, 'list'>;
    readonly steering: Pick<ChatSteering, 'list'> & { readonly state: Pick<ChatSteering['state'], 'running'> };
    /** The scope's `serverClock.lastDate()` as the person sent: the watermark's server time. */
    readonly serverAt?: number | null;
    /** Its lane and parent when not the chat's own (local-ids.ts's `chatWriteRoute`: a new chat's). */
    readonly route?: { readonly lane: string; readonly dependsOn: string | null };
}

/** The outbox write of a message (the composer's `enqueueFromDraft` build). */
export function chatMessageWrite(input: ChatMessageInput): NewOutboxWrite {
    const payload: ChatMessagePayload = {
        threadId: input.threadId,
        dotId: input.dotId,
        text: input.text,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        watermark: {
            after: input.history.list().at(-1)?.seq ?? null,
            queued: input.steering.list().map((message) => message.id),
            running: input.steering.state.running,
            serverAt: input.serverAt ?? null,
        },
    };
    return {
        id: input.id,
        lane: input.route?.lane ?? chatLane(input.threadId),
        kind: CHAT_MESSAGE_KIND,
        payload: JSON.stringify(payload),
        payloadVersion: CHAT_MESSAGE_VERSION,
        idempotencyKey: input.idempotencyKey,
        ...(input.route?.dependsOn ? { dependsOn: input.route.dependsOn } : {}),
    };
}

function decodePayload(text: string): ChatMessagePayload {
    const value = JSON.parse(text) as Partial<ChatMessagePayload> | null;
    const mark = value?.watermark as Partial<ChatWatermark> | undefined;
    if (
        !value ||
        typeof value.threadId !== 'string' ||
        typeof value.dotId !== 'string' ||
        typeof value.text !== 'string' ||
        (value.attachments !== undefined && !Array.isArray(value.attachments)) ||
        !mark ||
        (mark.after !== null && typeof mark.after !== 'number') ||
        !Array.isArray(mark.queued) ||
        typeof mark.running !== 'boolean' ||
        (mark.serverAt !== undefined && mark.serverAt !== null && typeof mark.serverAt !== 'number')
    ) {
        throw new TypeError('Not a chat message.');
    }
    return value as ChatMessagePayload;
}

/** The overlay's value: the bubble the chat draws until the stored history holds the message. */
export interface ChatMessageOverlay {
    readonly threadId: string;
    readonly message: Message;
    /** Its server id once it went as steering (steering.ts's `queuedBubbles` hides it when the snapshot lists it). */
    readonly serverId: string | null;
}

export interface ChatSendOptions {
    readonly histories: Pick<HistoryStore, 'history'>;
    readonly steering: Pick<SteeringStore, 'steering'>;
    /** The follow streams: a run this device POSTs is its own (`ownRun`), so the stream drops its events. */
    readonly follows?: Pick<FollowStore, 'follow'>;
    /** A fresh id (expo-crypto): run ids and rewrites' idempotency keys. */
    readonly newId: () => string;
    /** The device clock, for the 3 hours before a queued message asks (rows' `createdAt` are on it). */
    readonly now?: () => number;
    /** When this process started, on the device clock: a row written before it waited across a restart. */
    readonly launchedAt?: number;
    /** The signed-in person's app user id, for the run's turn. */
    readonly me?: string;
    /**
     * The lane's pre-send hook, after the pre-pull (the page reviews': a
     * message waits while a page review is open). An outcome returned is the send's.
     */
    readonly prepare?: (
        write: OutboxWrite<ChatMessagePayload>,
        context: OutboxContext,
        history: ChatHistory,
    ) => SendOutcome | null;
    /** Uploads a message's files again after a 400: the rewritten row, or `unsent`. `attachments`' by default. */
    readonly reupload?: (write: OutboxWrite<ChatMessagePayload>) => Promise<SendOutcome>;
    /**
     * The scope's attachments: a row's payload names its files by local
     * id; before it goes, they must be uploaded (`prepare`, which holds the
     * row meanwhile) and the request carries the server's ids (`resolve`).
     */
    readonly attachments?: Pick<Attachments, 'prepare' | 'resolve' | 'reupload'>;
    /** After a write the server took: what it changed is pulled (`notesForWrite`, the scope's). */
    readonly afterWrite?: (path: string) => void;
    /** Each event of a run this device started, with the turn after it (the chat draws the live turn; the follow stream's one source per run). */
    readonly onTurn?: (threadId: string, turn: LiveTurn) => void;
    /** A RUN_ERROR on this device's own run, with its run id: its `code` is kept (run-failures.ts). */
    readonly onRunError?: (threadId: string, runId: string, code: unknown) => void;
}

/**
 * How a chat message's row reads and looks (its decode and overlay), without
 * what sends it: the chat screen lays its queued bubbles from it
 * (outbox-overlay.ts's `overlaysOf`).
 */
export const CHAT_MESSAGE_VIEW: OverlayKind<ChatMessagePayload> = {
    kind: CHAT_MESSAGE_KIND,
    payloadVersion: CHAT_MESSAGE_VERSION,
    decode: (payload) => decodePayload(payload),
    overlay({ id, payload }, scope): Overlay {
        const value: ChatMessageOverlay = {
            // The chat a screen shows it in: a new chat's server id once its create resolved.
            threadId: scope.resolve(CONVERSATION_IDS, payload.threadId) ?? payload.threadId,
            message: chatMessage(id, payload),
            serverId: scope.resolve(MESSAGE_IDS, id),
        };
        return { collection: 'history', key: id, mode: 'insert', value };
    },
};

/** When this module loaded: the process's start, near enough, on the device clock. */
const LOADED_AT = Date.now();

const textOf = (content: Message['content']): string => {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return (content as { type?: unknown; text?: unknown }[])
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('\n');
};

const fileIds = (content: Message['content']): string[] =>
    Array.isArray(content)
        ? (content as { type?: unknown; id?: unknown }[])
              .filter((part) => part?.type === 'binary' && typeof part.id === 'string')
              .map((part) => part.id as string)
        : [];

const sameFiles = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((id, index) => id === b[index]);

/** What starting a run came to: the server has it, or why not. */
export type RunStart =
    /** RUN_STARTED came (or the run ended, or broke off after it): the server has the message. */
    | { readonly kind: 'started' }
    | {
          readonly kind: 'failed';
          readonly failure: RunFailure;
          /** The server answered the POST with its stream, but no RUN_STARTED came before the stop. */
          readonly accepted: boolean;
          /** Some answer came at all (a status); false for no answer (offline, a dropped connection). */
          readonly answered: boolean;
      };

/** One outbox row's run: its chat, its socio and exactly its message (the person's, or a tool result). */
export interface RunStartInput {
    readonly threadId: string;
    readonly dotId: string;
    readonly message: Message;
    readonly attachments?: boolean;
    readonly reuploaded?: boolean;
}

/**
 * Sends a row's run (the run client) and waits for RUN_STARTED: the run's body
 * is the stored history's tail plus exactly `message`. The
 * turn streams on outside the outbox (`onTurn`; the follow stream's `ownRun`
 * holds while the POST lives), and its chat is pulled once it ends
 * (`afterWrite`). A 401 throws HeldForSignIn. The chat message kind and the
 * page review's both send through it.
 */
export async function startRun(
    options: Pick<ChatSendOptions, 'newId' | 'me' | 'follows' | 'onTurn' | 'afterWrite' | 'onRunError'>,
    context: OutboxContext,
    history: ChatHistory,
    input: RunStartInput,
): Promise<RunStart> {
    const { newId, me, follows, onTurn, afterWrite, onRunError } = options;
    let runId: string | undefined;
    const { threadId, dotId, message } = input;
    let signIn: unknown = null;
    let answered = false;
    const fetch: AuthedFetch = async (path, init) => {
        try {
            const response = await context.fetch(path, init);
            answered = true;
            return response;
        } catch (error) {
            if (error instanceof HeldForSignIn) {
                signIn = error;
            }
            throw error;
        }
    };
    const client = createRunClient({ fetch, newId });
    const body = client.body({
        threadId,
        stored: history.list().flatMap((run: HistoryRun) => run.messages),
        message,
    });
    const streamed = history.streaming();
    const own = follows?.follow(threadId).ownRun();
    let broken = false;
    let last: LiveTurn | null = null;
    const end = () => {
        streamed();
        if (broken && last !== null) {
            // Its end never came on this POST: the follow stream replays the turn, so this one
            // mustn't stay "running" over it (or the pill would say Writing after the run was stored).
            // It keeps what streamed, so the partial reply stays on screen until the replay
            // or the stored run takes over; only the pill goes.
            onTurn?.(threadId, { ...last, running: false });
        }
        own?.(broken ? { broken: true } : undefined);
    };
    let markStarted = () => {};
    const started = new Promise<null>((resolve) => {
        markStarted = () => resolve(null);
    });
    const running = client
        .run(dotId, body, {
            signal: context.signal,
            attachments: input.attachments === true,
            reuploaded: input.reuploaded === true,
            ...(me === undefined ? {} : { me }),
            onEvent: (event, turn) => {
                if (event.type === AG_UI_EVENT.RUN_ERROR && runId !== undefined) {
                    onRunError?.(threadId, runId, (event as { code?: unknown }).code);
                }
                if (event.type === AG_UI_EVENT.RUN_FINISHED || event.type === AG_UI_EVENT.RUN_ERROR) {
                    broken = false;
                } else if (event.type === AG_UI_EVENT.RUN_STARTED) {
                    const started = (event as { runId?: unknown }).runId;
                    runId = typeof started === 'string' ? started : undefined;
                    // Until its end comes, a POST that breaks leaves the turn to the follow stream.
                    broken = true;
                }
                last = turn;
                onTurn?.(threadId, turn);
                if (event.type === AG_UI_EVENT.RUN_STARTED) {
                    markStarted();
                }
            },
        })
        .finally(end);
    // RUN_STARTED: the server has the message, so the lane goes on (a next
    // message goes as steering) while the turn streams on outside the outbox.
    const first = await Promise.race([running, started]);
    if (first === null) {
        running.then(() => afterWrite?.(conversationPath(threadId))).catch(() => {});
        return { kind: 'started' };
    }
    const outcome: RunOutcome = first;
    if (signIn !== null) {
        throw signIn;
    }
    if (outcome.kind === 'ended' || outcome.kind === 'dropped') {
        // The server has the message: its run is stored, or runs on and the follow stream replays it.
        afterWrite?.(conversationPath(threadId));
        return { kind: 'started' };
    }
    if (outcome.startedRunId !== undefined) {
        return { kind: 'started' };
    }
    return { kind: 'failed', failure: outcome.failure, accepted: outcome.accepted === true, answered };
}

/** The chat message kind, over the scope's histories and steering snapshots. */
export function chatMessageKind(options: ChatSendOptions): OutboxKind<ChatMessagePayload> {
    const { histories, steering, newId, now = Date.now, launchedAt = LOADED_AT } = options;
    const { prepare, afterWrite, attachments } = options;
    const reupload =
        options.reupload ??
        (attachments ? reuploadHook<ChatMessagePayload>(attachments, newId, CHAT_MESSAGE_VERSION) : undefined);

    /** The row with its files' server ids, or null while one isn't uploaded. */
    function withServerFiles(write: OutboxWrite<ChatMessagePayload>): OutboxWrite<ChatMessagePayload> | null {
        const files = write.payload.attachments;
        if (!attachments || !files?.length) {
            return write;
        }
        const resolved = attachments.resolve(files);
        return resolved === null ? null : { ...write, payload: { ...write.payload, attachments: resolved } };
    }
    /** Rows that went as steering in this process (a check matches them by text). */
    const steeredHere = new Set<string>();
    /** Rows sent in this process at all: for one not here, a restart forgot its route. */
    const sentHere = new Set<string>();

    /** The chat's steering, then its history, pulled fresh: whether each reached the server. */
    async function pullChat(threadId: string): Promise<{ history: ChatHistory; chat: ChatSteering; ok: boolean }> {
        const chat = steering.steering(threadId);
        const history = histories.history(threadId);
        await chat.refresh();
        const pulled = await history.pull();
        const ok = !chat.state.failed && chat.state.ready && pulled;
        return { history, chat, ok };
    }

    /**
     * Whether a message should ask before it goes by itself. A newer
     * turn is a finished run after the watermark that isn't this message's
     * and has a message of someone else's: one whose user messages are all
     * this device's own sends (the `ids` map) doesn't count.
     */
    function asks(write: OutboxWrite<ChatMessagePayload>, history: ChatHistory, context: OutboxContext): boolean {
        const { row, payload } = write;
        if (write.approved) {
            return false;
        }
        if (now() - row.createdAt > QUEUED_ASK_AFTER_MS || row.createdAt < launchedAt) {
            return true;
        }
        const after = payload.watermark.after;
        const newer = history
            .list()
            .filter(
                (run) =>
                    (after === null || run.seq > after) &&
                    run.status !== 'running' &&
                    !run.messages.some((message) => message.id === row.id) &&
                    !run.messages.every(
                        (message) => message.role !== 'user' || context.claimed(MESSAGE_IDS, message.id),
                    ),
            ).length;
        return newer > (payload.watermark.running ? 1 : 0);
    }

    const done = (serverId: string): SendOutcome => ({ action: 'done', serverId, awaitStored: true });

    async function viaSteering(
        write: OutboxWrite<ChatMessagePayload>,
        context: OutboxContext,
        chat: ChatSteering,
    ): Promise<SendOutcome> {
        const { row, payload } = write;
        const max = chat.state.maxQueued;
        if (max !== null && chat.list().length >= max) {
            return { action: 'retry', delayMs: QUEUE_WAIT_MS, reason: CHAT_WAIT.queue };
        }
        const path = steeringPath(payload.threadId);
        steeredHere.add(row.id);
        sentHere.add(row.id);
        const take = chat.writing();
        const response = await context.fetch(path, {
            method: 'POST',
            json: {
                text: payload.text,
                ...(payload.attachments?.length ? { attachments: payload.attachments.map(({ id }) => ({ id })) } : {}),
            },
        });
        const answer = await readAnswer(response, context.signal);
        const action = classify(answer, { method: 'POST', special: steeringAnswer(payload) });
        switch (action.action) {
            case 'delivered': {
                const body = answer.body as { message?: { id?: unknown } } | null;
                try {
                    take(body);
                } catch {
                    // Not a view: the next frame or open asks again.
                    void chat.refresh();
                }
                const serverId = body?.message?.id;
                if (typeof serverId !== 'string') {
                    // A 2xx without the message: the check finds it by its text.
                    return { action: 'unknown', reason: `http-${answer.status}` };
                }
                afterWrite?.(path);
                return done(serverId);
            }
            case 'back-off':
                return {
                    action: 'retry',
                    delayMs: action.delayMs ?? (answer.code === 'queue_full' ? QUEUE_WAIT_MS : CYCLE_RATE_WAIT_MS),
                    reason: action.reason,
                };
            case 're-upload':
                return reuploadOnce(write, 'content');
            case 'retry':
            case 'unknown':
            case 'unsent':
                return action;
            default:
                return { action: 'unsent', reason: reasonOf(answer) };
        }
    }

    async function reuploadOnce(write: OutboxWrite<ChatMessagePayload>, reason: string): Promise<SendOutcome> {
        if (!write.payload.attachments?.length || write.payload.reuploaded || reupload === undefined) {
            return { action: 'unsent', reason: write.payload.attachments?.length ? 'attachment-expired' : reason };
        }
        return reupload(write);
    }

    async function viaRun(
        write: OutboxWrite<ChatMessagePayload>,
        context: OutboxContext,
        history: ChatHistory,
    ): Promise<SendOutcome> {
        const { row, payload } = write;
        sentHere.add(row.id);
        const start = await startRun(options, context, history, {
            threadId: payload.threadId,
            dotId: payload.dotId,
            message: chatMessage(row.id, payload),
            attachments: !!payload.attachments?.length,
            reuploaded: !!payload.reuploaded,
        });
        if (start.kind === 'started') {
            return done(row.id);
        }
        if (start.failure.action === 'retry' && !start.answered) {
            // No answer at all: offline, or a connection that dropped after the
            // server took the turn. Only a check can tell.
            return { action: 'unknown', reason: 'no-answer' };
        }
        if (start.failure.action === 'retry' && start.failure.draining !== true) {
            // A proxy's 502 or 504 (or an unreadable 503) may come after the
            // server took the run and started its turn: a plain retry would
            // find that turn running and send the message again as steering.
            return { action: 'unknown', reason: 'away' };
        }
        return runFailure(write, context, start.failure, start.accepted);
    }

    async function runFailure(
        write: OutboxWrite<ChatMessagePayload>,
        context: OutboxContext,
        failure: RunFailure,
        accepted: boolean,
    ): Promise<SendOutcome> {
        switch (failure.action) {
            case 'retry':
                return failure.retryAfterMs === undefined
                    ? { action: 'retry', reason: 'away' }
                    : { action: 'retry', delayMs: failure.retryAfterMs, reason: 'away' };
            case 'wait':
                return { action: 'retry', delayMs: failure.retryAfterMs, reason: failure.code ?? 'cycle_rate' };
            case 'unsent':
                return { action: 'unsent', reason: failure.reason };
            case 'reupload':
                return reuploadOnce(write, 'content');
            case 'setup':
                return { action: 'hold', reason: CHAT_WAIT.setup };
            case 'sign-in':
                throw new HeldForSignIn('401 to a run');
            case 'stopped':
                return { action: 'unknown', reason: accepted ? 'accepted' : 'stopped' };
            case 'busy':
                return threadBusy(write, context);
            case 'ambiguous':
                return failure.status >= 500 ? busyThread(write, context) : { action: 'unknown', reason: 'ambiguous' };
            default:
                return unhandledRunFailure(failure);
        }
    }

    /** Whether a run holds the row's message (shared's recoverTurn, turn-recovery.ts), after a fresh pull. */
    function recover(
        write: OutboxWrite<ChatMessagePayload>,
        context: OutboxContext,
        history: ChatHistory,
    ): Promise<TurnRecovery> {
        const { row, payload } = write;
        return recoverRun({
            id: row.id,
            dotId: payload.dotId,
            threadId: payload.threadId,
            after: history.list().at(-1)?.seq ?? null,
            fetch: context.fetch,
            signal: context.signal,
            newId,
            stored: async (id) => (await history.pull()) && history.has(id),
            probe: async () => (await pullChat(payload.threadId)).ok,
        });
    }

    /** Correction 1: a run's 5xx (an older server's busy thread had no code; CB-357's has `threadBusy`). */
    async function busyThread(write: OutboxWrite<ChatMessagePayload>, context: OutboxContext): Promise<SendOutcome> {
        const { row, payload } = write;
        const { history, chat, ok } = await pullChat(payload.threadId);
        if (history.state.gone || chat.state.gone) {
            return { action: 'unsent', reason: 'gone' };
        }
        if (!ok) {
            return { action: 'unknown', reason: CHAT_WAIT.busy };
        }
        if (history.has(row.id)) {
            return done(row.id);
        }
        if (chat.state.running && !context.signal.aborted) {
            // The running turn may be this message's own (an earlier POST of it
            // that landed late): its replay says so before it goes as steering.
            let recovery: TurnRecovery;
            try {
                recovery = await recover(write, context, history);
            } catch (error) {
                if (error instanceof HeldForSignIn) {
                    throw error;
                }
                return { action: 'unknown', reason: CHAT_WAIT.busy };
            }
            if (recovery === 'stored') {
                return done(row.id);
            }
            if (recovery === 'gave-up') {
                return { action: 'unknown', reason: CHAT_WAIT.busy };
            }
            // A turn started elsewhere: the message goes as steering, in place.
            return asSteering(write);
        }
        return { action: 'retry', reason: CHAT_WAIT.busy };
    }

    /** The row rewritten in place (same lane, same position) to go as steering. */
    function asSteering({ payload }: OutboxWrite<ChatMessagePayload>): SendOutcome {
        const next: ChatMessagePayload = { ...payload, steered: true };
        return {
            action: 'rewrite',
            payload: JSON.stringify(next),
            payloadVersion: CHAT_MESSAGE_VERSION,
            idempotencyKey: newId(),
            reason: CHAT_WAIT.busy,
        };
    }

    /**
     * CB-357: a run's 409 `thread_running`, a definite answer: the server took
     * nothing from this POST. So it is never `unknown`: what can't be told now
     * (the pull failed, the replay failed or gave up) goes again after the
     * back-off, and the next send pulls first.
     */
    async function threadBusy(write: OutboxWrite<ChatMessagePayload>, context: OutboxContext): Promise<SendOutcome> {
        const { row, payload } = write;
        const again: SendOutcome = { action: 'retry', reason: CHAT_WAIT.busy };
        const { history, chat, ok } = await pullChat(payload.threadId);
        if (history.state.gone || chat.state.gone) {
            return { action: 'unsent', reason: 'gone' };
        }
        if (!ok) {
            return again;
        }
        if (history.has(row.id)) {
            return done(row.id);
        }
        if (!chat.state.running || context.signal.aborted) {
            return again;
        }
        // The running turn may still be this row's own (an earlier POST of it
        // that landed late): its replay says so before it goes as steering.
        let recovery: TurnRecovery;
        try {
            recovery = await recover(write, context, history);
        } catch (error) {
            if (error instanceof HeldForSignIn) {
                throw error;
            }
            return again;
        }
        if (recovery === 'stored') {
            return done(row.id);
        }
        return recovery === 'gave-up' ? again : asSteering(write);
    }

    /** The check's candidates for a steering send: matching messages the server took after the watermark, no other write's. */
    function candidates(
        write: OutboxWrite<ChatMessagePayload>,
        context: OutboxContext,
        history: ChatHistory,
        chat: ChatSteering,
    ): string[] {
        const { payload } = write;
        const files = (payload.attachments ?? []).map((file) => file.id);
        const fresh = (id: string) => !payload.watermark.queued.includes(id) && !context.claimed(MESSAGE_IDS, id);
        // The server's clock as the person wrote, less a slack for a proxy's Date
        // running ahead. What it stored before then isn't this write.
        const since = serverSince(payload.watermark.serverAt);
        const found = new Set<string>();
        for (const message of chat.list()) {
            const theirs = (message.attachments ?? []).map((file) => file.id);
            if (
                fresh(message.id) &&
                (since === null || message.createdAt >= since) &&
                message.text === payload.text &&
                sameFiles(theirs, files)
            ) {
                found.add(message.id);
            }
        }
        const after = payload.watermark.after;
        for (const run of history.list()) {
            if (after !== null && run.seq <= after) {
                continue;
            }
            if (since !== null && run.finishedAt !== null && run.finishedAt < since) {
                // It ended before the write: a queued message it took was older.
                continue;
            }
            for (const message of run.messages) {
                if (
                    message.role === 'user' &&
                    fresh(message.id) &&
                    textOf(message.content) === payload.text &&
                    sameFiles(fileIds(message.content), files)
                ) {
                    found.add(message.id);
                }
            }
        }
        return [...found];
    }

    /** The write with its chat's server id (a new chat's local id resolved), or null while it has none. */
    function resolved(
        write: OutboxWrite<ChatMessagePayload>,
        context: OutboxContext,
    ): OutboxWrite<ChatMessagePayload> | null {
        const threadId = serverChatId(context.resolve, write.payload.threadId);
        if (threadId === null) {
            return null;
        }
        return threadId === write.payload.threadId ? write : { ...write, payload: { ...write.payload, threadId } };
    }

    return {
        kind: CHAT_MESSAGE_KIND,
        payloadVersion: CHAT_MESSAGE_VERSION,
        repeatable: false,
        creates: MESSAGE_IDS,
        decode: (payload) => decodePayload(payload),

        async send(original, context) {
            const chatWrite = resolved(original, context);
            if (chatWrite === null) {
                // Its chat was never created (the create discarded, or refused for good).
                return { action: 'unsent', reason: 'no-chat' };
            }
            if (attachments && original.payload.attachments?.length) {
                // Its files go up first; the row waits in its lane meanwhile.
                const waiting = await attachments.prepare(original.row.id, original.payload.attachments);
                if (waiting !== null) {
                    return waiting;
                }
            }
            const write = withServerFiles(chatWrite);
            if (write === null) {
                return { action: 'retry', reason: 'uploading' };
            }
            const { row, payload } = write;
            const { history, chat } = await pullChat(payload.threadId);
            if (history.state.gone || chat.state.gone) {
                return { action: 'unsent', reason: 'gone' };
            }
            if (history.has(row.id)) {
                return done(row.id);
            }
            const early = prepare?.(write, context, history) ?? null;
            if (early !== null) {
                return early;
            }
            if (asks(write, history, context)) {
                return { action: 'hold', reason: CHAT_WAIT.ask };
            }
            if (chat.state.running) {
                if (payload.text.length > STEERING_MAX_CHARS) {
                    // Too long to queue: it goes as a run once the turn ends.
                    return { action: 'retry', delayMs: TURN_WAIT_MS, reason: CHAT_WAIT.turn };
                }
                return viaSteering(write, context, chat);
            }
            return viaRun(write, context, history);
        },

        async check(original, context): Promise<CheckOutcome> {
            const chatWrite = resolved(original, context);
            if (chatWrite === null) {
                // No chat on the server, so nothing of it reached one: its send finds it so.
                return { action: 'not-sent' };
            }
            const write = withServerFiles(chatWrite) ?? chatWrite;
            const { row, payload } = write;
            const { history, chat, ok } = await pullChat(payload.threadId);
            if (history.state.gone || chat.state.gone) {
                // Before `ok`, which a gone chat never is: its send finds the
                // chat gone and moves it to `unsent`.
                return { action: 'not-sent' };
            }
            if (!ok) {
                // Offline, or the server failed: the outbox tries again after the back-off.
                throw new NetworkError(steeringPath(payload.threadId));
            }
            if (history.has(row.id)) {
                return { action: 'sent', serverId: row.id, awaitStored: true };
            }
            // A run may hold it while it still streams (recoverTurn's connect, then stored(id)).
            const recovery = await recover(write, context, history);
            if (recovery === 'stored') {
                return { action: 'sent', serverId: row.id, awaitStored: true };
            }
            if (recovery === 'gave-up') {
                return { action: 'later' };
            }
            const steered = payload.steered === true || steeredHere.has(row.id);
            // A row this process never sent was in flight before a restart: it may have gone as steering.
            const forgotten = !sentHere.has(row.id);
            if (steered || forgotten) {
                // Exactly one candidate after the fresh pull is this write; more, the person decides.
                const found = candidates(write, context, history, chat);
                if (found.length === 1) {
                    return { action: 'sent', serverId: found[0]!, awaitStored: true };
                }
                if (found.length > 1) {
                    return { action: 'unconfirmed', candidates: found };
                }
            }
            if (chat.state.running) {
                // The running turn may hold it: once it is stored, the check can tell.
                return { action: 'later' };
            }
            return { action: 'not-sent' };
        },

        overlay: CHAT_MESSAGE_VIEW.overlay,
    };
}

/** The steering answers this kind reads before the outbox's defaults. */
function steeringAnswer(payload: ChatMessagePayload) {
    return (answer: Answer) => {
        const { status, code } = answer;
        if (status === 409) {
            // A Telegram chat takes its messages in Telegram.
            return { action: 'unsent' as const, reason: code ?? 'telegram' };
        }
        if (status === 400) {
            return payload.attachments?.length
                ? { action: 're-upload' as const }
                : { action: 'unsent' as const, reason: 'content' };
        }
        if (status === 404 || status === 410) {
            return { action: 'unsent' as const, reason: 'gone' };
        }
        return undefined;
    };
}
