import type { ModelChoice } from '@socio/shared/inference';
import type { AttachmentRef } from '@socio/shared/media-types';
import type { Conversation } from '@socio/shared/types';

import { NetworkError } from '../net/errors';
import { chatScreen, keptChat, LAST_SCREEN_KEY } from '../shell/last-screen';

import type { Attachments } from './attachments';
import { chatDraft, type Drafts, newChatDraft } from './chat-drafts';
import { CHAT_WAIT, chatLane, chatMessageWrite } from './chat-send';
import { CONVERSATION_IDS, isLocalChat, newLocalChatId, shownChatId } from './local-ids';
import type { CheckOutcome, NewOutboxWrite, Outbox, OutboxKind, OutboxRow, SendOutcome } from './outbox';
import { type Answer, type ClassifierAction, classify, readAnswer } from './outbox-answers';
import { serverSince } from './server-clock';
import { WORKSPACE_SNAPSHOT } from './shell';
import type { ViewState } from './view-state';

// A new chat.
// The server picks a chat's id, so a chat started offline gets a local one
// (local-ids.ts), and its create and first message are queued together:
//
// - **One transaction.** `enqueueNewChat` takes the box of the socio's new
//   chat (`new:<dotId>`) and inserts the create (`POST /api/conversations`,
//   the row's id the local id, lane `chat:<local id>`) and the first message
//   (same lane, `dependsOn` the create) with the draft's clearing, so a kill
//   leaves all three or none. The screen goes on as chat `<local id>`, and
//   what was typed during the send moves to that chat's draft.
// - **Its title** is the web's (AppShell's `newConversation`): the message's
//   first 80 characters, else the first file's name, else the server's
//   default. No other field but the model: the server's `.strict()`
//   refuses any.
// - **Its model** (the web's ChatViews `newConversation(dot, text,
//   model)`): the one chosen on New chat goes in the create as `inference`,
//   so the chat holds it before its first message runs and the first reply
//   uses it. Left out for the socio's default, as the web leaves it out; a
//   row an older build queued has none and still decodes. Never a
//   `setChatModel` after the create: that is another lane, and the first
//   reply could run on the default.
// - **No network reads before the create resolves.** The histories, steering
//   snapshots and follow streams skip a local id (`isLocalChat`), so a new
//   chat's screen shows only its overlays and can't 404 itself away.
// - **Answers**: a 201's `id` is the server's, written to `ids`
//   (`conversation`) as the row settles; 400 (the title, a model refused) and
//   404 (the socio gone, or another person's) go to `unsent`, holding the
//   message; a readable 503 (setup missing) goes again after the back-off; a
//   proxy's 502, 504 or unreadable 503, a plain 5xx and no answer at all may
//   have made the chat, so they are `unknown`.
// - **The check**: `GET /api/workspace` after a fresh pull. A candidate
//   is a private chat with this socio and exactly this title, newer than the
//   newest chat the phone knew when the person wrote (both the server's
//   `createdAt`, so the device clock plays no part), and no other write's
//   (`ids`). One is the create's; none means it never landed and it goes
//   again; two the person decides ("Couldn't confirm this was sent", with
//   the candidates for View). The server's Date joins the watermark
//   (`serverAt`, server-clock.ts): a candidate was made at or after it, less
//   a slack (`serverSince`), so a chat of the same title made earlier (the default title, say) that the
//   phone never held doesn't count.
// - **Re-keying** (`createLocalChats`): once the create resolves, the
//   chat's draft (`chat:<local>` → `chat:<server>`) and the last screen
//   (`Chat/<local>`) move to the server id, and `subscribe` tells the screen,
//   which swaps its route param. The `ids` entry is written in the settle's
//   transaction, so a kill before the move finds it: the scope repeats the
//   moves as it opens. A link naming a local id resolves through `ids`
//   (`resolve`). The histories need no move: a local id's holds nothing, and
//   its messages' rows settle against the server id's (local-ids.ts's
//   `chatLanes`, the scope's `onRuns`).
//
// No React Native: tests/sync runs it under Node against a fake server.

export const NEW_CHAT_KIND = 'new-chat';
export const NEW_CHAT_VERSION = 1;

/** The create of a chat, as its outbox row keeps it. Its row's id is the chat's local id. */
export interface NewChatPayload {
    readonly dotId: string;
    readonly title: string;
    /** The check's watermark: the newest `createdAt` (the server's) of the chats the phone held, or null for none. */
    readonly after: number | null;
    /** The scope's newest Date header as the person wrote, or null; missing in rows an older build wrote. */
    readonly serverAt?: number | null;
    /** The model chosen on New chat; missing for the socio's default, and in rows an older build wrote. */
    readonly inference?: ModelChoice;
}

const TITLE_MAX = 80;
/** The server's own default title, sent when there is neither text nor a file. */
export const DEFAULT_CHAT_TITLE = 'A new thought';

/**
 * The first 80 characters as the server stores them: cut by code points (never
 * half an emoji), trimmed after the cut, since the server trims titles and the
 * create's check matches what it stored.
 */
const clipTitle = (text: string) => Array.from(text.trim()).slice(0, TITLE_MAX).join('').trim();

/** The web's title for a new chat: the first message's first 80 characters, else the first file's name. */
export const newChatTitle = (text: string, attachments: readonly AttachmentRef[] = []) =>
    clipTitle(text) || clipTitle(attachments[0]?.name ?? '') || DEFAULT_CHAT_TITLE;

/** The newest `createdAt` of the chats a scope holds (its `conversations` collection), the create's watermark. */
export function newestChat(chats: Iterable<{ readonly createdAt?: unknown }>): number | null {
    let newest: number | null = null;
    for (const chat of chats) {
        if (typeof chat.createdAt === 'number' && (newest === null || chat.createdAt > newest)) {
            newest = chat.createdAt;
        }
    }
    return newest;
}

export interface NewChatInput {
    /** The chat's local id (`newLocalChatId`). */
    readonly localId: string;
    readonly dotId: string;
    /** The first message's id and text, and its files. */
    readonly messageId: string;
    readonly text: string;
    readonly attachments?: readonly AttachmentRef[];
    /** Fresh UUIDs for each row. */
    readonly createKey: string;
    readonly messageKey: string;
    /** `newestChat` of the scope's chats as the person wrote. */
    readonly after: number | null;
    /** The scope's `serverClock.lastDate()` as the person wrote. */
    readonly serverAt?: number | null;
    /** The model chosen on New chat; null or missing: the socio's default. */
    readonly inference?: ModelChoice | null;
}

const NO_HISTORY = { list: () => [] };
const NO_STEERING = { list: () => [], state: { running: false } };

/** The create and the first message of a new chat, in order. */
export function newChatWrites(input: NewChatInput): [NewOutboxWrite, NewOutboxWrite] {
    const payload: NewChatPayload = {
        dotId: input.dotId,
        title: newChatTitle(input.text, input.attachments),
        after: input.after,
        serverAt: input.serverAt ?? null,
        ...(input.inference ? { inference: input.inference } : {}),
    };
    const create: NewOutboxWrite = {
        id: input.localId,
        lane: chatLane(input.localId),
        kind: NEW_CHAT_KIND,
        payload: JSON.stringify(payload),
        payloadVersion: NEW_CHAT_VERSION,
        idempotencyKey: input.createKey,
    };
    const message = chatMessageWrite({
        id: input.messageId,
        idempotencyKey: input.messageKey,
        threadId: input.localId,
        dotId: input.dotId,
        text: input.text,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        history: NO_HISTORY,
        steering: NO_STEERING,
        serverAt: input.serverAt ?? null,
        route: { lane: chatLane(input.localId), dependsOn: input.localId },
    });
    return [create, message];
}

export interface EnqueueNewChatOptions {
    readonly drafts: Pick<Drafts, 'enqueueFromDraft' | 'rekey'>;
    readonly dotId: string;
    /** A fresh UUID (expo-crypto): the local id, the message's id and both keys. */
    readonly newId: () => string;
    /** `newestChat` of the scope's chats. */
    readonly after: number | null;
    /** The scope's `serverClock.lastDate()`. */
    readonly serverAt?: number | null;
    readonly attachments?: readonly AttachmentRef[];
    /**
     * The scope's attachments: the new chat's tray goes with the message,
     * by local id, in the insert's transaction (then `attachments` is unused).
     */
    readonly files?: Pick<Attachments, 'forSend' | 'rekey'>;
    /** The model chosen on New chat, sent in the create; null or missing: the socio's default. */
    readonly inference?: ModelChoice | null;
}

/**
 * Sends the box of the socio's new chat as a new chat: the chat's local id,
 * which the screen now shows, and the message's row; null when the box holds
 * only blank text. Rejects (OutboxError, DraftError) with the box as it was.
 */
export async function enqueueNewChat(
    options: EnqueueNewChatOptions,
): Promise<{ readonly localId: string; readonly row: OutboxRow } | null> {
    const { drafts, dotId, newId, after, serverAt = null, files, inference = null } = options;
    const localId = newLocalChatId(newId);
    const box = newChatDraft(dotId);
    const tray = files?.forSend(box);
    const attachments = tray ? tray.refs : options.attachments;
    const messageId = newId();
    let row: OutboxRow | null;
    try {
        row = await drafts.enqueueFromDraft(
            box,
            (text) =>
                newChatWrites({
                    localId,
                    dotId,
                    messageId,
                    text,
                    ...(attachments?.length ? { attachments } : {}),
                    createKey: newId(),
                    messageKey: newId(),
                    after,
                    serverAt,
                    inference,
                }),
            tray
                ? {
                      also: tray.statements(
                          () => messageId,
                          () => chatLane(localId),
                      ),
                      allowBlank: tray.refs.length > 0,
                  }
                : {},
        );
        if (row !== null) {
            tray?.committed(row.id, row.lane);
        }
    } finally {
        tray?.released();
    }
    if (row === null) {
        return null;
    }
    // What was typed during the send belongs to the chat it now is; so do the files left in the tray.
    drafts.rekey(box, chatDraft(localId));
    files?.rekey(box, chatDraft(localId));
    return { localId, row };
}

/** A model choice as the server takes it (`modelChoiceInput`): shared by backend, or the person's own. */
const isModelChoice = (value: unknown): value is ModelChoice => {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const choice = value as Record<string, unknown>;
    return choice.source === 'shared'
        ? typeof choice.backendId === 'string'
        : choice.source === 'byo' &&
              typeof choice.kind === 'string' &&
              (choice.model === undefined || typeof choice.model === 'string');
};

function decodePayload(text: string): NewChatPayload {
    const value = JSON.parse(text) as Partial<NewChatPayload> | null;
    if (
        !value ||
        typeof value.dotId !== 'string' ||
        typeof value.title !== 'string' ||
        (value.after !== null && typeof value.after !== 'number') ||
        (value.serverAt !== undefined && value.serverAt !== null && typeof value.serverAt !== 'number') ||
        (value.inference !== undefined && !isModelChoice(value.inference))
    ) {
        throw new TypeError('Not a new chat.');
    }
    return value as NewChatPayload;
}

/** The create's answers before the outbox's defaults. */
function createAnswer(answer: Answer): ClassifierAction | undefined {
    const { status, code, unreadable } = answer;
    if (status === 400) {
        return { action: 'unsent', reason: code ?? 'content' };
    }
    if (status === 404) {
        return { action: 'unsent', reason: 'socio-gone' };
    }
    if (status === 503 && !unreadable && code !== 'draining') {
        // The server's setup check comes before the create: nothing was made.
        return { action: 'retry', reason: CHAT_WAIT.setup };
    }
    if ((status === 502 || status === 504 || status === 503) && code !== 'draining') {
        // A proxy's page may come after the server made the chat: only the check can tell.
        return { action: 'unknown', reason: 'away' };
    }
    return undefined;
}

/** The chat list the check reads: the shell's `/api/workspace`. */
const WORKSPACE_PATH = WORKSPACE_SNAPSHOT.path;
export const CONVERSATIONS_PATH = '/api/conversations';

export interface NewChatOptions {
    /** After a create the server took: the chat list is pulled (`notesForWrite`). */
    readonly afterWrite?: (path: string) => void;
}

/** The new chat kind. */
export function newChatKind(options: NewChatOptions = {}): OutboxKind<NewChatPayload> {
    const { afterWrite } = options;
    return {
        kind: NEW_CHAT_KIND,
        payloadVersion: NEW_CHAT_VERSION,
        repeatable: false,
        creates: CONVERSATION_IDS,
        decode: (payload) => decodePayload(payload),

        async send({ payload }, context): Promise<SendOutcome> {
            const response = await context.fetch(CONVERSATIONS_PATH, {
                method: 'POST',
                json: {
                    dotId: payload.dotId,
                    title: payload.title,
                    ...(payload.inference ? { inference: payload.inference } : {}),
                },
            });
            const answer = await readAnswer(response, context.signal);
            const action = classify(answer, { method: 'POST', special: createAnswer });
            switch (action.action) {
                case 'delivered': {
                    const id = (answer.body as { id?: unknown } | null)?.id;
                    if (typeof id !== 'string' || id === '') {
                        // A 2xx without the chat: the check finds it.
                        return { action: 'unknown', reason: `http-${answer.status}` };
                    }
                    afterWrite?.(CONVERSATIONS_PATH);
                    return { action: 'done', serverId: id };
                }
                case 'back-off':
                    return action.delayMs === null
                        ? { action: 'retry', reason: action.reason }
                        : { action: 'retry', delayMs: action.delayMs, reason: action.reason };
                case 'retry':
                case 'unknown':
                case 'unsent':
                    return action;
                default:
                    return { action: 'unsent', reason: `http-${answer.status}` };
            }
        },

        async check({ payload }, context): Promise<CheckOutcome> {
            const response = await context.fetch(WORKSPACE_PATH);
            const answer = await readAnswer(response, context.signal);
            if (answer.status < 200 || answer.status >= 300 || answer.body === null) {
                // Can't tell now: the outbox asks again after the back-off.
                throw new NetworkError(WORKSPACE_PATH);
            }
            const body = answer.body as { conversations?: unknown; archived?: unknown };
            const chats = [
                ...(Array.isArray(body.conversations) ? body.conversations : []),
                ...(Array.isArray(body.archived) ? body.archived : []),
            ] as Partial<Conversation>[];
            const since = serverSince(payload.serverAt);
            const found = chats.filter(
                (chat) =>
                    typeof chat?.id === 'string' &&
                    (chat.kind ?? 'private') === 'private' &&
                    chat.dotId === payload.dotId &&
                    typeof chat.title === 'string' &&
                    chat.title.trim() === payload.title.trim() &&
                    typeof chat.createdAt === 'number' &&
                    (payload.after === null || chat.createdAt > payload.after) &&
                    (since === null || chat.createdAt >= since) &&
                    !context.claimed(CONVERSATION_IDS, chat.id),
            );
            if (found.length === 1) {
                afterWrite?.(CONVERSATIONS_PATH);
                return { action: 'sent', serverId: found[0]!.id as string };
            }
            return found.length === 0
                ? { action: 'not-sent' }
                : { action: 'unconfirmed', candidates: found.map((chat) => chat.id as string) };
        },
    };
}

// ---- Re-keying ---------------------------------------------------------------

/** A new chat's local id resolved: the server id a screen showing `localId` moves to. */
export type ChatResolved = (localId: string, serverId: string) => void;

export interface LocalChats {
    /** Chat `id` as a screen or a link opens it: a resolved local id's server id, else `id`. */
    resolve(id: string): string;
    /** Each new chat whose create resolved (the screen swaps its route param). Returns the unsubscribe. */
    subscribe(listener: ChatResolved): () => void;
    dispose(): void;
}

export interface LocalChatsOptions {
    readonly outbox: Pick<Outbox, 'resolve' | 'subscribe'>;
    readonly drafts: Pick<Drafts, 'scopes' | 'rekey'>;
    readonly viewState: Pick<ViewState, 'get' | 'set'>;
    readonly onError?: (error: unknown) => void;
}

/**
 * Re-keys what a new chat's local id named once its create resolves: its
 * draft and the last screen, then tells the screens. As it starts it repeats
 * the moves for every local id that resolved before a kill.
 */
export function createLocalChats(options: LocalChatsOptions): LocalChats {
    const { outbox, drafts, viewState, onError = () => {} } = options;
    const listeners = new Set<ChatResolved>();
    const serverOf = (localId: string) => outbox.resolve(CONVERSATION_IDS, localId);

    const move = (localId: string, serverId: string) => {
        drafts.rekey(chatDraft(localId), chatDraft(serverId));
        if (keptChat(viewState.get(LAST_SCREEN_KEY)) === localId) {
            viewState.set(LAST_SCREEN_KEY, chatScreen(serverId));
        }
    };

    // A kill after the create settled and before the moves: do them now.
    const prefix = chatDraft('');
    const named = new Set<string>();
    for (const scope of drafts.scopes()) {
        if (scope.startsWith(prefix)) {
            named.add(scope.slice(prefix.length));
        }
    }
    const kept = keptChat(viewState.get(LAST_SCREEN_KEY));
    if (kept !== null) {
        named.add(kept);
    }
    for (const id of named) {
        const serverId = isLocalChat(id) ? serverOf(id) : null;
        if (serverId !== null) {
            move(id, serverId);
        }
    }

    const unsubscribe = outbox.subscribe((change) => {
        if (change.type !== 'remove' || !isLocalChat(change.id)) {
            return;
        }
        const serverId = serverOf(change.id);
        if (serverId === null) {
            return;
        }
        move(change.id, serverId);
        for (const listener of [...listeners]) {
            try {
                listener(change.id, serverId);
            } catch (error) {
                onError(error);
            }
        }
    });

    return {
        resolve: (id) => shownChatId(outbox.resolve, id),
        subscribe(listener) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
        dispose() {
            unsubscribe();
            listeners.clear();
        },
    };
}
