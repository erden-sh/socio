import type { Message } from '@ag-ui/core';

import { STEERING_MAX_CHARS } from '@socio/shared/chat/steering';
import type { AttachmentRef } from '@socio/shared/media-types';
import type { PersonMention } from '@socio/shared/rooms/room-people-mentions';
import type { RoomReadState } from '@socio/shared/rooms/rooms';
import { SENDER_METADATA, type Conversation } from '@socio/shared/types';

import { NetworkError } from '../net/errors';
import { CYCLE_RATE_WAIT_MS } from '../net/run-answer';

import { type Attachments, reuploadHook } from './attachments';
import {
    CHAT_WAIT,
    chatLane,
    chatMessage,
    type ChatMessageOverlay,
    type ChatWatermark,
    MESSAGE_IDS,
    QUEUE_WAIT_MS,
    QUEUED_ASK_AFTER_MS,
    steeringPath,
} from './chat-send';
import type { ChatHistory, HistoryStore } from './history';
import type {
    CheckOutcome,
    NewOutboxWrite,
    Outbox,
    OutboxContext,
    OutboxKind,
    OutboxWrite,
    SendOutcome,
} from './outbox';
import { type Answer, type ClassifierAction, classify, outcomeOf, readAnswer, reasonOf } from './outbox-answers';
import type { Overlay, OverlayKind } from './outbox-overlay';
import { serverSince } from './server-clock';
import { CONVERSATIONS } from './shell';
import type { SnapshotCache } from './snapshot-cache';
import type { ChatSteering, SteeringStore } from './steering';

// Writing in a room: two outbox kinds beside the
// private chat's.
//
// - **`room-message`**, lane `chat:<roomId>` (the chat's, so the history's
//   `onGone` and `caughtUp` treat it as they treat a chat's): always steering,
//   `POST …/steering {text, attachments, mentions}`, which starts a turn when
//   none runs (the web's room composer). A chat's steering rules: never more than
//   `maxQueued` ahead; a 429 holds the lane; a 400 re-uploads once with files,
//   else `unsent`; a text over STEERING_MAX_CHARS is `unsent` (a room has no
//   run to wait for; the room's composer says so first); 404/410 is the room gone.
//   A 409 is `unsent`, worded by kind: a room's refusal carries a `code`
//   (`archived`, `rooms_off`, `read_only`, `roomDenialStatus`'s), a Telegram
//   topic's none (`telegram`). Any 2xx is the server having it, under its own
//   id (`MESSAGE_IDS`), kept `sent` until the history stores it. The ask
//   rule holds as in a chat: after 3 hours, across a restart, or past turns
//   someone else's message started.
// - **Its check** pulls `/steering` and `/history` and matches by
//   exact text and files, newer than the watermark and no other write's, as a
//   chat's steering check does, but counts only messages whose `socioSender`
//   is the reader: another member may send "ok" too. One
//   candidate is sent, two the person decides; none while a turn runs waits.
// - **`room-read`**, lane `room-read:<roomId>`: `POST /api/rooms/:id/read
//   {seq}`, collapsed to the newest, never backwards, safe to repeat; a refusal
//   is dropped (a mark is never the person's to retry). Its overlay sets the
//   room's `unread` to 0 at once (`useShownChats`), and its answer's count is
//   handed to cache.db's row before the outbox row goes.
//
// The overlay of a room message is the chat message's shape
// (`ChatMessageOverlay`), so the screen's `pendingBubbles`/`queuedBubbles` lay
// it over the transcript as they do a chat's. Never the server's text: statuses
// and `code`s only. No React Native: tests/sync runs it under Node.

export const ROOM_MESSAGE_KIND = 'room-message';
export const ROOM_MESSAGE_VERSION = 1;
export const ROOM_READ_KIND = 'room-read';
const ROOM_READ_VERSION = 1;

/** A message to a room, as its outbox row keeps it. */
export interface RoomMessagePayload {
    readonly threadId: string;
    readonly text: string;
    /** Files uploaded for it, by reference. */
    readonly attachments?: readonly AttachmentRef[];
    /** The people the composer's picker chose (shared's `keptMentions`), by id. */
    readonly mentions?: readonly PersonMention[];
    readonly watermark: ChatWatermark;
    /** Its files were uploaded again once after a 400 (the rule's "once"). */
    readonly reuploaded?: true;
}

export interface RoomMessageInput {
    readonly id: string;
    readonly idempotencyKey: string;
    readonly roomId: string;
    readonly text: string;
    readonly attachments?: readonly AttachmentRef[];
    readonly mentions?: readonly PersonMention[];
    /** The room's history and steering snapshot as the composer shows them: the watermark. */
    readonly history: Pick<ChatHistory, 'list'>;
    readonly steering: Pick<ChatSteering, 'list'> & { readonly state: Pick<ChatSteering['state'], 'running'> };
    /** The scope's `serverClock.lastDate()` as the person sent. */
    readonly serverAt?: number | null;
}

/** The outbox write of a room message (the room's composer, through `enqueueFromDraft`). */
export function roomMessageWrite(input: RoomMessageInput): NewOutboxWrite {
    const payload: RoomMessagePayload = {
        threadId: input.roomId,
        text: input.text,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.mentions?.length ? { mentions: input.mentions } : {}),
        watermark: {
            after: input.history.list().at(-1)?.seq ?? null,
            queued: input.steering.list().map((message) => message.id),
            running: input.steering.state.running,
            serverAt: input.serverAt ?? null,
        },
    };
    return {
        id: input.id,
        lane: chatLane(input.roomId),
        kind: ROOM_MESSAGE_KIND,
        payload: JSON.stringify(payload),
        payloadVersion: ROOM_MESSAGE_VERSION,
        idempotencyKey: input.idempotencyKey,
    };
}

function decodeMessage(text: string): RoomMessagePayload {
    const value = JSON.parse(text) as Partial<RoomMessagePayload> | null;
    const mark = value?.watermark as Partial<ChatWatermark> | undefined;
    if (
        !value ||
        typeof value.threadId !== 'string' ||
        typeof value.text !== 'string' ||
        (value.attachments !== undefined && !Array.isArray(value.attachments)) ||
        (value.mentions !== undefined && !Array.isArray(value.mentions)) ||
        !mark ||
        (mark.after !== null && typeof mark.after !== 'number') ||
        !Array.isArray(mark.queued) ||
        typeof mark.running !== 'boolean' ||
        (mark.serverAt !== undefined && mark.serverAt !== null && typeof mark.serverAt !== 'number')
    ) {
        throw new TypeError('Not a room message.');
    }
    return value as RoomMessagePayload;
}

/** How a room message's row reads and looks: a pending bubble, as a chat message's (`pendingBubbles`). */
export const ROOM_MESSAGE_VIEW: OverlayKind<RoomMessagePayload> = {
    kind: ROOM_MESSAGE_KIND,
    payloadVersion: ROOM_MESSAGE_VERSION,
    decode: (payload) => decodeMessage(payload),
    overlay({ id, payload }, scope): Overlay {
        const value: ChatMessageOverlay = {
            threadId: payload.threadId,
            message: chatMessage(id, payload),
            serverId: scope.resolve(MESSAGE_IDS, id),
        };
        return { collection: 'history', key: id, mode: 'insert', value };
    },
};

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

/** Who sent a stored person's message (`socioSender`), or undefined. */
export function senderOf(message: Message): string | undefined {
    const metadata = (message as { metadata?: unknown }).metadata;
    const id =
        metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>)[SENDER_METADATA] : undefined;
    return typeof id === 'string' && id ? id : undefined;
}

/** When this module loaded: the process's start, near enough, on the device clock. */
const LOADED_AT = Date.now();

export interface RoomSendOptions {
    readonly histories: Pick<HistoryStore, 'history'>;
    readonly steering: Pick<SteeringStore, 'steering'>;
    /** The reader's app user id: only their own stored messages are candidates. */
    readonly me: string;
    /** A fresh id: rewrites' idempotency keys. */
    readonly newId: () => string;
    readonly now?: () => number;
    /** When this process started, on the device clock: a row written before it waited across a restart. */
    readonly launchedAt?: number;
    /** The scope's attachments: files go up before the message, which carries the server's ids. */
    readonly attachments?: Pick<Attachments, 'prepare' | 'resolve' | 'reupload'>;
    /** Uploads a message's files again after a 400; `attachments`' by default. */
    readonly reupload?: (write: OutboxWrite<RoomMessagePayload>) => Promise<SendOutcome>;
    /** After a write the server took: what it changed is pulled (`notesForWrite`). */
    readonly afterWrite?: (path: string) => void;
}

/** The room message kind, over the scope's histories and steering snapshots. */
export function roomMessageKind(options: RoomSendOptions): OutboxKind<RoomMessagePayload> {
    const { histories, steering, me, newId, now = Date.now, launchedAt = LOADED_AT } = options;
    const { attachments, afterWrite } = options;
    const reupload =
        options.reupload ??
        (attachments ? reuploadHook<RoomMessagePayload>(attachments, newId, ROOM_MESSAGE_VERSION) : undefined);

    function withServerFiles(write: OutboxWrite<RoomMessagePayload>): OutboxWrite<RoomMessagePayload> | null {
        const files = write.payload.attachments;
        if (!attachments || !files?.length) {
            return write;
        }
        const resolved = attachments.resolve(files);
        return resolved === null ? null : { ...write, payload: { ...write.payload, attachments: resolved } };
    }

    async function pullRoom(threadId: string) {
        const chat = steering.steering(threadId);
        const history = histories.history(threadId);
        await chat.refresh();
        const pulled = await history.pull();
        const ok = !chat.state.failed && chat.state.ready && pulled;
        return { history, chat, ok };
    }

    /** A message that waited 3 hours, across a restart, or past someone else's turns asks first. */
    function asks(write: OutboxWrite<RoomMessagePayload>, history: ChatHistory, context: OutboxContext): boolean {
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
                    run.messages.some(
                        (message) =>
                            message.role === 'user' &&
                            senderOf(message) !== me &&
                            !context.claimed(MESSAGE_IDS, message.id),
                    ),
            ).length;
        return newer > (payload.watermark.running ? 1 : 0);
    }

    /** A room's answers before the outbox's defaults. */
    const special =
        (payload: RoomMessagePayload) =>
        (answer: Answer): ClassifierAction | undefined => {
            const { status, code } = answer;
            if (status === 404 || status === 410) {
                return { action: 'unsent', reason: 'gone' };
            }
            if (status === 409 || status === 403) {
                // A room's rule carries its code; a Telegram topic takes its messages in Telegram.
                return { action: 'unsent', reason: code ?? (status === 409 ? 'telegram' : 'refused') };
            }
            if (status === 400) {
                return payload.attachments?.length ? { action: 're-upload' } : { action: 'unsent', reason: 'content' };
            }
            return undefined;
        };

    function candidates(
        write: OutboxWrite<RoomMessagePayload>,
        context: OutboxContext,
        history: ChatHistory,
        chat: ChatSteering,
    ): string[] {
        const { payload } = write;
        const files = (payload.attachments ?? []).map((file) => file.id);
        const fresh = (id: string) => !payload.watermark.queued.includes(id) && !context.claimed(MESSAGE_IDS, id);
        const since = serverSince(payload.watermark.serverAt);
        const found = new Set<string>();
        // The snapshot's messages are the reader's own (others' are `others`, for admins).
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
                continue;
            }
            for (const message of run.messages) {
                if (
                    message.role === 'user' &&
                    senderOf(message) === me &&
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

    async function reuploadOnce(write: OutboxWrite<RoomMessagePayload>): Promise<SendOutcome> {
        if (!write.payload.attachments?.length || write.payload.reuploaded || reupload === undefined) {
            return { action: 'unsent', reason: write.payload.attachments?.length ? 'attachment-expired' : 'content' };
        }
        return reupload(write);
    }

    return {
        kind: ROOM_MESSAGE_KIND,
        payloadVersion: ROOM_MESSAGE_VERSION,
        repeatable: false,
        creates: MESSAGE_IDS,
        decode: (payload) => decodeMessage(payload),

        async send(original, context) {
            if (attachments && original.payload.attachments?.length) {
                const waiting = await attachments.prepare(original.row.id, original.payload.attachments);
                if (waiting !== null) {
                    return waiting;
                }
            }
            const write = withServerFiles(original);
            if (write === null) {
                return { action: 'retry', reason: 'uploading' };
            }
            const { payload } = write;
            const { history, chat } = await pullRoom(payload.threadId);
            if (history.state.gone || chat.state.gone) {
                return { action: 'unsent', reason: 'gone' };
            }
            if (asks(write, history, context)) {
                return { action: 'hold', reason: CHAT_WAIT.ask };
            }
            if (payload.text.length > STEERING_MAX_CHARS) {
                return { action: 'unsent', reason: 'too-large' };
            }
            const max = chat.state.maxQueued;
            if (max !== null && chat.list().length >= max) {
                return { action: 'retry', delayMs: QUEUE_WAIT_MS, reason: CHAT_WAIT.queue };
            }
            const path = steeringPath(payload.threadId);
            const take = chat.writing();
            const response = await context.fetch(path, {
                method: 'POST',
                json: {
                    text: payload.text,
                    ...(payload.attachments?.length
                        ? { attachments: payload.attachments.map(({ id }) => ({ id })) }
                        : {}),
                    ...(payload.mentions?.length
                        ? { mentions: payload.mentions.map(({ userId, label }) => ({ userId, label })) }
                        : {}),
                },
            });
            const answer = await readAnswer(response, context.signal);
            const action = classify(answer, { method: 'POST', special: special(payload) });
            switch (action.action) {
                case 'delivered': {
                    const body = answer.body as { message?: { id?: unknown } } | null;
                    try {
                        take(body);
                    } catch {
                        void chat.refresh();
                    }
                    const serverId = body?.message?.id;
                    if (typeof serverId !== 'string') {
                        return { action: 'unknown', reason: `http-${answer.status}` };
                    }
                    afterWrite?.(path);
                    return { action: 'done', serverId, awaitStored: true };
                }
                case 'back-off':
                    return {
                        action: 'retry',
                        delayMs: action.delayMs ?? (answer.code === 'queue_full' ? QUEUE_WAIT_MS : CYCLE_RATE_WAIT_MS),
                        reason: action.reason,
                    };
                case 're-upload':
                    return reuploadOnce(write);
                case 'retry':
                case 'unknown':
                case 'unsent':
                    return action;
                default:
                    return { action: 'unsent', reason: reasonOf(answer) };
            }
        },

        async check(original, context): Promise<CheckOutcome> {
            const write = withServerFiles(original) ?? original;
            const { payload } = write;
            const { history, chat, ok } = await pullRoom(payload.threadId);
            if (history.state.gone || chat.state.gone) {
                // Its send finds the room gone and moves it to `unsent`.
                return { action: 'not-sent' };
            }
            if (!ok) {
                throw new NetworkError(steeringPath(payload.threadId));
            }
            const found = candidates(write, context, history, chat);
            if (found.length === 1) {
                return { action: 'sent', serverId: found[0]!, awaitStored: true };
            }
            if (found.length > 1) {
                return { action: 'unconfirmed', candidates: found };
            }
            return chat.state.running ? { action: 'later' } : { action: 'not-sent' };
        },

        overlay: ROOM_MESSAGE_VIEW.overlay,
    };
}

// ---- Read marks ----------------------------------------------------------------

export interface RoomReadPayload {
    readonly roomId: string;
    /** The newest finished turn the reader saw (the history's newest `seq`). */
    readonly seq: number;
}

export const roomReadLane = (roomId: string) => `room-read:${roomId}`;
const readPath = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}/read`;

function decodeRead(text: string): RoomReadPayload {
    const value = JSON.parse(text) as Partial<RoomReadPayload> | null;
    if (!value || typeof value.roomId !== 'string' || typeof value.seq !== 'number' || value.seq < 0) {
        throw new TypeError('Not a room read mark.');
    }
    return { roomId: value.roomId, seq: value.seq };
}

/** How a read mark looks: the room's unread count at 0 at once, in the chat lists (`useShownChats`). */
export const ROOM_READ_VIEW: OverlayKind<RoomReadPayload> = {
    kind: ROOM_READ_KIND,
    payloadVersion: ROOM_READ_VERSION,
    decode: (payload) => decodeRead(payload),
    overlay: ({ payload }) => ({
        collection: 'conversations',
        key: payload.roomId,
        mode: 'patch',
        value: { unread: 0 },
    }),
};

export interface RoomReadOptions {
    /** cache.db's rows: the answer's unread count is handed to the room's row before the outbox row goes. */
    readonly cache?: Pick<SnapshotCache, 'rows' | 'confirm'>;
}

/** The room read mark kind. */
export function roomReadKind({ cache }: RoomReadOptions = {}): OutboxKind<RoomReadPayload> {
    return {
        kind: ROOM_READ_KIND,
        payloadVersion: ROOM_READ_VERSION,
        repeatable: true,
        decode: decodeRead,
        async send(write, context) {
            const { roomId, seq } = write.payload;
            const response = await context.fetch(readPath(roomId), { method: 'POST', json: { seq } });
            const answer = await readAnswer(response, context.signal);
            const action = classify(answer, { method: 'POST', ambiguous: write.ambiguous === true });
            if (action.action === 'unsent') {
                // A refusal (the room gone, a bad number) is dropped: a mark is never the person's to retry.
                return { action: 'done' };
            }
            if (action.action !== 'delivered') {
                return outcomeOf(action, write);
            }
            const state = answer.body as Partial<RoomReadState> | null;
            const unread = typeof state?.unread === 'number' ? state.unread : 0;
            const held = cache?.rows(CONVERSATIONS).get(roomId);
            if (cache === undefined || held === undefined) {
                return { action: 'done' };
            }
            return {
                action: 'done',
                handOff: async () => {
                    const room = JSON.parse(held.json) as Conversation;
                    if ((room.unread ?? 0) !== unread) {
                        await cache.confirm({
                            collection: CONVERSATIONS,
                            scope: '',
                            key: roomId,
                            value: { ...room, unread },
                        });
                    }
                },
            };
        },
        overlay: ROOM_READ_VIEW.overlay,
    };
}

/**
 * Marks room `roomId` read up to `seq`: into its lane's queued row, else a new
 * row; nothing when a mark at or past `seq` is already in the lane (never
 * backwards). Resolves with whether a mark was written.
 */
export async function markRoomRead(
    outbox: Pick<Outbox, 'rows' | 'enqueue' | 'update' | 'revisionOf'>,
    roomId: string,
    seq: number,
    newId: () => string,
): Promise<boolean> {
    const lane = roomReadLane(roomId);
    const rows = outbox.rows().filter((row) => row.lane === lane && row.kind === ROOM_READ_KIND);
    let newest = -1;
    for (const row of rows) {
        try {
            newest = Math.max(newest, decodeRead(row.payload).seq);
        } catch {
            // A row this build can't read: a new one goes beside it.
        }
    }
    if (seq <= newest) {
        return false;
    }
    const payload = JSON.stringify({ roomId, seq } satisfies RoomReadPayload);
    const queued = rows.at(-1);
    if (queued !== undefined && queued.state === 'queued') {
        const folded = await outbox.update(
            queued.id,
            { payload, payloadVersion: ROOM_READ_VERSION },
            outbox.revisionOf(queued.id),
        );
        if (folded) {
            return true;
        }
    }
    await outbox.enqueue({
        id: newId(),
        lane,
        kind: ROOM_READ_KIND,
        payload,
        payloadVersion: ROOM_READ_VERSION,
        idempotencyKey: newId(),
    });
    return true;
}

/**
 * Marks room `roomId` read from a list (a row's swipe or its Mark read), as the room screen does:
 * its history held and caught up (`pull`, from disk when offline), then a read mark up to its newest
 * run. Resolves with whether a mark was written (none when the history holds no run).
 */
export async function markRoomReadFromList(
    deps: {
        readonly histories: Pick<HistoryStore, 'preload'>;
        readonly outbox: Pick<Outbox, 'rows' | 'enqueue' | 'update' | 'revisionOf'>;
        readonly newId: () => string;
    },
    roomId: string,
): Promise<boolean> {
    const history = await deps.histories.preload(roomId);
    const release = history.use();
    try {
        // Offline the pull answers false and the mark goes up to what the phone holds.
        await history.pull();
        const seq = history.list().at(-1)?.seq;
        return seq === undefined ? false : await markRoomRead(deps.outbox, roomId, seq, deps.newId);
    } finally {
        release();
    }
}
