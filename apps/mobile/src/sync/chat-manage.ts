import { isReactionKind, type ReactionKind } from '@socio/shared/chat/reactions';
import { STEERING_MAX_CHARS } from '@socio/shared/chat/steering';
import type { ModelChoice } from '@socio/shared/inference';
import { keptMentions } from '@socio/shared/rooms/room-view';
import { MAX_CHAT_TITLE } from '@socio/shared/types';

import { NetworkError } from '../net/errors';

import {
    CHAT_MESSAGE_KIND,
    CHAT_MESSAGE_VERSION,
    type ChatMessagePayload,
    MESSAGE_IDS,
    steeringPath,
} from './chat-send';
import type { HistoryStore } from './history';
import { CONVERSATION_IDS, isLocalChat, serverChatId, shownChatId } from './local-ids';
import type { NewOutboxWrite, Outbox, OutboxContext, OutboxKind, OutboxRow, OutboxWrite, SendOutcome } from './outbox';
import { type Answer, type ClassifierAction, classify, readAnswer, reasonOf, type WriteMethod } from './outbox-answers';
import type { Overlay, OverlayKind } from './outbox-overlay';
import { ROOM_MESSAGE_KIND, ROOM_MESSAGE_VERSION, type RoomMessagePayload } from './room-send';
import { CONVERSATIONS } from './shell';
import type { SnapshotCache } from './snapshot-cache';
import type { SteeringStore } from './steering';

// Chat management writes: renaming, archiving and deleting a chat, reactions
// on a socio's reply, and editing or cancelling a message queued while a turn
// runs. Each is an outbox kind, safe to repeat (`repeatable`), whose answers
// read by the outbox's already-applied rule after an attempt that may have
// reached the server (`OutboxWrite.ambiguous`).
//
// - **Lanes.** A chat's rename, archive and delete go in order in
//   `conversation:<id>`; a message's reactions in `reaction:<chat>/<message>`;
//   a chat's queued-message edits and cancels in `steering:<chat>`. None waits
//   behind the chat's messages (`chat:<id>`), so a message held for the
//   person never holds a rename. A write to a new chat not created yet waits
//   for its create (`dependsOn`) in the local id's lane, and a later one
//   joins that lane while it holds a write, as messages do (local-ids.ts).
// - **Folded while queued** ("Edits before sending"): a rename or archive
//   on a chat whose last such write hasn't gone changes that row in place, as
//   does the same reaction toggled back; an edit or a cancel of a message
//   still in the outbox (queued or held) changes or removes its row there, and
//   one in `unsent` is edited or discarded there. Only a message that may have
//   reached the server is edited or cancelled over the network, after its
//   send settles (`dependsOn`), under the server's id (`ids`, `message`).
// - **A refused one is replaced** by the next rename, archive or delete of the
//   chat (any reaction of the message): it is discarded from `unsent` first,
//   so the newer intent never waits behind it. Until then the screens show it
//   ("Couldn’t rename …", with Retry and Discard).
// - **Rename** (`PATCH /api/conversations/:id {title}`): 1 to 80 characters,
//   trimmed, as the server checks (`MAX_CHAT_TITLE`). **Archive** and undo
//   (`{archived}`). The answer is the chat, handed to cache.db's
//   `conversations` before the row goes (`confirm`), so the list never
//   flickers back to the old title.
// - **The chat's model** (`{inference}`, the web's ModelPicker; null is the
//   socio's default): the same row, folded the same way, so the picker shows
//   the pick at once, offline too. A 400 (a model the server doesn't take)
//   goes to `unsent` as `model`.
// - **Delete** (`DELETE /api/conversations/:id`; soft on the server). The
//   server refuses it with a 409 and no code while a turn, a scheduled task
//   or a call runs: the kind reads `GET …/deletion` and waits while
//   `blocked` is `running` or `call` (it waits for the turn to end), and
//   a chat that can't be deleted from here (`telegram`, `page`) goes to
//   `unsent`. A room's 409 carries a code (rooms are archived): `unsent`. A
//   404 is done: the chat is gone, which is what the person asked for.
// - **Reactions** (`PUT`/`DELETE …/messages/:id/reactions/:kind`), only on a
//   socio's finished reply: up, down, retry or needs-work. The answer's view
//   goes to `onReactions` (reactions.ts's store).
// - **Steering edit and cancel** (`PATCH`/`DELETE …/steering/:id`). A 409
//   `delivered` means a turn took the message: an edit that gets it after an
//   ambiguous attempt is kept as sent, and otherwise goes to `unsent`
//   ("It had gone to <socio> already") so the edited text isn't lost; a
//   cancel that gets it re-reads `/steering` and the transcript: absent from
//   both is cancelled, stored is sent (the cancel came too late: nothing is
//   left to do), while a turn runs it can't tell yet and looks again. Each
//   answer's view goes into the chat's steering snapshot (`writing()`).
//
// Never the server's text: statuses and `code`s only. No React
// Native: tests/sync runs it under Node against a fake server.

export const CHAT_UPDATE_KIND = 'chat-update';
export const CHAT_DELETE_KIND = 'chat-delete';
export const REACTION_KIND = 'reaction';
export const STEERING_EDIT_KIND = 'steering-edit';
export const STEERING_CANCEL_KIND = 'steering-cancel';
const VERSION = 1;

/** How long a delete refused while the chat is busy (a turn, a task, a call) waits before it asks again. */
export const DELETE_BUSY_WAIT_MS = 10_000;
/** How long a cancel that can't tell yet (a turn runs that may hold the message) waits. */
export const CANCEL_TURN_WAIT_MS = 5_000;

/** The reasons these rows carry while they wait or after a refusal (the screens word them). */
export const MANAGE_REASON = {
    /** The chat runs a turn, a task or a call: the delete waits. */
    busy: 'chat-busy',
    /** A turn took the queued message before the edit came. */
    delivered: 'delivered',
    /** A new chat that was never created. */
    noChat: 'no-chat',
    gone: 'gone',
} as const;

/** The chat's rename, archive or model, as its row keeps it: at least one field. */
export interface ChatUpdatePayload {
    readonly threadId: string;
    readonly title?: string;
    readonly archived?: boolean;
    /** The chat's model; null is its socio's default. */
    readonly inference?: ModelChoice | null;
}

export interface ChatDeletePayload {
    readonly threadId: string;
}

export interface ReactionPayload {
    readonly threadId: string;
    /** The socio's reply. */
    readonly messageId: string;
    readonly reaction: ReactionKind;
    /** Added (PUT) or taken off (DELETE). */
    readonly on: boolean;
}

export interface SteeringEditPayload {
    readonly threadId: string;
    /** The queued message: the outbox row's id (resolved through `ids`) or the server's. */
    readonly messageId: string;
    readonly text: string;
    /** The files it keeps, by id, of those it has; omitted keeps them all. */
    readonly attachments?: readonly string[];
}

export interface SteeringCancelPayload {
    readonly threadId: string;
    readonly messageId: string;
}

/** A write the person can't make: a title out of range, an empty or too long edit, an unknown reaction. */
export class ChatManageError extends RangeError {
    override readonly name = 'ChatManageError';
}

/** A rename's title as the server stores it, or null when it isn't 1 to 80 characters. */
export function chatTitle(text: string): string | null {
    const title = text.trim();
    return title.length >= 1 && title.length <= MAX_CHAT_TITLE ? title : null;
}

const CONVERSATION_LANE = 'conversation:';
const REACTION_LANE = 'reaction:';
const STEERING_LANE = 'steering:';

export const conversationLane = (threadId: string) => `${CONVERSATION_LANE}${threadId}`;
export const reactionLane = (threadId: string, messageId: string) => `${REACTION_LANE}${threadId}/${messageId}`;
export const steeringLane = (threadId: string) => `${STEERING_LANE}${threadId}`;

type Lanes = Pick<Outbox, 'rows' | 'unsent' | 'resolve'>;

/**
 * Where a write to chat `threadId` goes: `lane(id)` of a local id that
 * resolved to it while that lane still holds a write, else its own; for a
 * chat not created yet, after its create.
 */
function route(outbox: Lanes, threadId: string, lane: (id: string) => string) {
    if (isLocalChat(threadId)) {
        return {
            lane: lane(threadId),
            dependsOn: outbox.resolve(CONVERSATION_IDS, threadId) === null ? threadId : null,
        };
    }
    for (const write of [...outbox.rows(), ...outbox.unsent()]) {
        const local = /^[^:]+:(local-[^/]+)/.exec(write.lane)?.[1];
        if (local !== undefined && write.lane === lane(local) && outbox.resolve(CONVERSATION_IDS, local) === threadId) {
            return { lane: write.lane, dependsOn: null };
        }
    }
    return { lane: lane(threadId), dependsOn: null };
}

export interface ManageInput {
    /** A fresh UUID (expo-crypto): the row's id and key. */
    readonly newId: () => string;
}

/** The newest queued row of `kind` in `lane` that `matches`: one a new write may fold into. */
function foldable<P>(outbox: Pick<Outbox, 'rows'>, lane: string, kind: string, matches: (payload: P) => boolean) {
    const last = outbox
        .rows()
        .filter((row) => row.lane === lane && row.kind === kind)
        .at(-1);
    if (last === undefined || last.state !== 'queued') {
        return null;
    }
    try {
        const payload = JSON.parse(last.payload) as P;
        return matches(payload) ? { row: last, payload } : null;
    } catch {
        return null;
    }
}

/**
 * Folds `payload` into the lane's queued row when `fold` gives one, else
 * enqueues a new row. First the lane's refused writes of `replaces` are
 * discarded: the newer intent takes their place, and in `unsent` they would
 * hold it (and the rest of the lane) until the person retried or discarded them.
 */
async function enqueueOrFold<P>(
    outbox: Pick<Outbox, 'rows' | 'unsent' | 'resolve' | 'enqueue' | 'update' | 'revisionOf' | 'discardUnsent'>,
    write: { lane: string; dependsOn: string | null; kind: string; payload: P },
    fold: ((queued: P) => P | null) | null,
    newId: () => string,
    replaces: readonly string[] = [],
): Promise<OutboxRow | 'folded'> {
    for (const refused of outbox.unsent()) {
        if (refused.lane === write.lane && replaces.includes(refused.kind)) {
            await outbox.discardUnsent(refused.id);
        }
    }
    if (fold !== null) {
        let next: P | null = null;
        const found = foldable<P>(outbox, write.lane, write.kind, (queued) => (next = fold(queued)) !== null);
        if (found !== null && next !== null) {
            const updated = await outbox.update(
                found.row.id,
                { payload: JSON.stringify(next), payloadVersion: VERSION },
                outbox.revisionOf(found.row.id),
            );
            if (updated) {
                return 'folded';
            }
        }
    }
    const row: NewOutboxWrite = {
        id: newId(),
        lane: write.lane,
        kind: write.kind,
        payload: JSON.stringify(write.payload),
        payloadVersion: VERSION,
        idempotencyKey: newId(),
        ...(write.dependsOn === null ? {} : { dependsOn: write.dependsOn }),
    };
    return outbox.enqueue(row);
}

/** A chat's renames, archives and deletes: a newer one replaces a refused one in its lane. */
const CHAT_LANE_KINDS = [CHAT_UPDATE_KIND, CHAT_DELETE_KIND];

type ManageOutbox = Pick<
    Outbox,
    'rows' | 'unsent' | 'resolve' | 'enqueue' | 'update' | 'remove' | 'revisionOf' | 'editUnsent' | 'discardUnsent'
>;

/** Renames chat `threadId`. Throws ChatManageError for a title that isn't 1 to 80 characters. */
export function renameChat(outbox: ManageOutbox, input: ManageInput & { threadId: string; title: string }) {
    const title = chatTitle(input.title);
    if (title === null) {
        throw new ChatManageError(`A title has 1 to ${MAX_CHAT_TITLE} characters.`);
    }
    return updateChat(outbox, input.threadId, { title }, input.newId);
}

/** Archives chat `threadId`, or brings it back (`archived: false`, the undo toast's). */
export function archiveChat(outbox: ManageOutbox, input: ManageInput & { threadId: string; archived: boolean }) {
    return updateChat(outbox, input.threadId, { archived: input.archived }, input.newId);
}

/** Sets the model chat `threadId` runs on (the web's ModelPicker); null goes back to its socio's default. */
export function setChatModel(
    outbox: ManageOutbox,
    input: ManageInput & { threadId: string; inference: ModelChoice | null },
) {
    return updateChat(outbox, input.threadId, { inference: input.inference }, input.newId);
}

/** A model choice as the server takes it (`modelChoiceInput`), or null as itself. */
const isModelChoice = (value: unknown) => {
    if (value === null) {
        return true;
    }
    if (typeof value !== 'object') {
        return false;
    }
    const choice = value as Record<string, unknown>;
    return choice.source === 'shared'
        ? typeof choice.backendId === 'string'
        : choice.source === 'byo' &&
              typeof choice.kind === 'string' &&
              (choice.model === undefined || typeof choice.model === 'string');
};

function updateChat(
    outbox: ManageOutbox,
    threadId: string,
    change: Omit<ChatUpdatePayload, 'threadId'>,
    newId: () => string,
) {
    const where = route(outbox, threadId, conversationLane);
    return enqueueOrFold<ChatUpdatePayload>(
        outbox,
        { ...where, kind: CHAT_UPDATE_KIND, payload: { threadId, ...change } },
        (queued) => (queued.threadId === threadId ? { ...queued, ...change } : null),
        newId,
        CHAT_LANE_KINDS,
    );
}

/** Deletes chat `threadId` (after the screen's native confirm). */
export function deleteChat(outbox: ManageOutbox, input: ManageInput & { threadId: string }) {
    const where = route(outbox, input.threadId, conversationLane);
    return enqueueOrFold<ChatDeletePayload>(
        outbox,
        { ...where, kind: CHAT_DELETE_KIND, payload: { threadId: input.threadId } },
        null,
        input.newId,
        CHAT_LANE_KINDS,
    );
}

/** Adds (`on`) or takes off a reaction on a socio's reply. */
export function react(
    outbox: ManageOutbox,
    input: ManageInput & { threadId: string; messageId: string; reaction: ReactionKind; on: boolean },
) {
    if (!isReactionKind(input.reaction)) {
        throw new ChatManageError('React with up, down, retry or needs-work.');
    }
    const { threadId, messageId, reaction, on } = input;
    const where = route(outbox, threadId, (id) => reactionLane(id, messageId));
    return enqueueOrFold<ReactionPayload>(
        outbox,
        { ...where, kind: REACTION_KIND, payload: { threadId, messageId, reaction, on } },
        (queued) => (queued.messageId === messageId && queued.reaction === reaction ? { ...queued, on } : null),
        input.newId,
        [REACTION_KIND],
    );
}

/** What an edit or a cancel of a queued message did: changed on the phone, or queued for the server. */
export type QueuedMessageChange = 'in-place' | 'queued';

/** A message the person wrote: in a private chat, or in a room, whose queued ones are edited alike. */
const isMessageKind = (kind: string) => kind === CHAT_MESSAGE_KIND || kind === ROOM_MESSAGE_KIND;
const messageVersion = (kind: string) => (kind === ROOM_MESSAGE_KIND ? ROOM_MESSAGE_VERSION : CHAT_MESSAGE_VERSION);

/** The message row `messageId` while it is still in the outbox and not sent, else null. */
const messageRow = (outbox: Pick<Outbox, 'rows'>, messageId: string) =>
    outbox.rows().find((row) => row.id === messageId && isMessageKind(row.kind) && row.state !== 'sent') ?? null;

/**
 * Edits a queued message: its row in place while it hasn't gone (queued,
 * held or `unsent`), else `PATCH …/steering/:id` once its send settles.
 * Throws ChatManageError for an empty text with no file, or one over
 * `STEERING_MAX_CHARS` that must go to the server.
 */
export async function editQueuedMessage(
    outbox: ManageOutbox,
    input: ManageInput & {
        threadId: string;
        messageId: string;
        text: string;
        /** The files it keeps, by id; omitted keeps them all. */
        attachments?: readonly string[];
    },
): Promise<QueuedMessageChange> {
    const { threadId, messageId, text, attachments } = input;
    const edit = (payload: ChatMessagePayload): ChatMessagePayload => {
        const files =
            attachments === undefined
                ? payload.attachments
                : (payload.attachments ?? []).filter((file) => attachments.includes(file.id));
        const {
            attachments: _files,
            mentions,
            ...rest
        } = payload as ChatMessagePayload & Partial<Pick<RoomMessagePayload, 'mentions'>>;
        // A room message keeps only the mentions whose `@Name` is still in the text.
        const kept = mentions === undefined ? [] : keptMentions(text, mentions);
        const next: ChatMessagePayload = {
            ...rest,
            text,
            ...(files?.length ? { attachments: files } : {}),
            ...(kept.length ? { mentions: kept } : {}),
        };
        if (!next.text.trim() && !next.attachments?.length) {
            throw new ChatManageError('An edited message keeps some text or a file.');
        }
        return next;
    };
    const row = messageRow(outbox, messageId);
    if (row !== null && (row.state === 'queued' || row.state === 'held')) {
        const next = edit(JSON.parse(row.payload) as ChatMessagePayload);
        const changed = await outbox.update(
            row.id,
            { payload: JSON.stringify(next), payloadVersion: messageVersion(row.kind) },
            outbox.revisionOf(row.id),
        );
        if (changed) {
            return 'in-place';
        }
    }
    const refused = outbox.unsent().find((write) => write.id === messageId && isMessageKind(write.kind));
    if (refused !== undefined) {
        const next = edit(JSON.parse(refused.payload) as ChatMessagePayload);
        if (
            await outbox.editUnsent(refused.id, {
                payload: JSON.stringify(next),
                payloadVersion: messageVersion(refused.kind),
            })
        ) {
            return 'in-place';
        }
    }
    if (text.length > STEERING_MAX_CHARS) {
        throw new ChatManageError(`A queued message has at most ${STEERING_MAX_CHARS} characters.`);
    }
    if (!text.trim() && attachments !== undefined && attachments.length === 0) {
        throw new ChatManageError('An edited message keeps some text or a file.');
    }
    const where = route(outbox, threadId, steeringLane);
    const pending = messageRow(outbox, messageId);
    await enqueueOrFold<SteeringEditPayload>(
        outbox,
        {
            lane: where.lane,
            dependsOn: pending?.id ?? where.dependsOn,
            kind: STEERING_EDIT_KIND,
            payload: { threadId, messageId, text, ...(attachments === undefined ? {} : { attachments }) },
        },
        null,
        input.newId,
    );
    return 'queued';
}

/**
 * Cancels a queued message: its row goes while it hasn't gone (queued, held
 * or `unsent`), else `DELETE …/steering/:id` once its send settles.
 */
export async function cancelQueuedMessage(
    outbox: ManageOutbox,
    input: ManageInput & { threadId: string; messageId: string },
): Promise<QueuedMessageChange> {
    const { threadId, messageId } = input;
    const row = messageRow(outbox, messageId);
    if (row !== null && (row.state === 'queued' || row.state === 'held')) {
        if ((await outbox.remove(row.id, outbox.revisionOf(row.id))) !== null) {
            return 'in-place';
        }
    }
    if (outbox.unsent().some((write) => write.id === messageId && isMessageKind(write.kind))) {
        if ((await outbox.discardUnsent(messageId)) !== null) {
            return 'in-place';
        }
    }
    const where = route(outbox, threadId, steeringLane);
    const pending = messageRow(outbox, messageId);
    await enqueueOrFold<SteeringCancelPayload>(
        outbox,
        {
            lane: where.lane,
            dependsOn: pending?.id ?? where.dependsOn,
            kind: STEERING_CANCEL_KIND,
            payload: { threadId, messageId },
        },
        null,
        input.newId,
    );
    return 'queued';
}

// ---- The kinds -----------------------------------------------------------------

export interface ChatManageOptions {
    readonly histories: Pick<HistoryStore, 'history'>;
    readonly steering: Pick<SteeringStore, 'steering'>;
    /** cache.db's rows (the scope's snapshot cache): a confirmed rename, archive or delete is handed off there. */
    readonly cache?: Pick<SnapshotCache, 'confirm'>;
    /** After a write the server took: what it changed is pulled (`notesForWrite`, the scope's). */
    readonly afterWrite?: (path: string) => void;
    /** A reaction's answer: the chat's reactions view (reactions.ts's store). */
    readonly onReactions?: (threadId: string, view: unknown) => void;
    /** `DELETE_BUSY_WAIT_MS` and `CANCEL_TURN_WAIT_MS`, for tests. */
    readonly waits?: { readonly deleteBusyMs?: number; readonly cancelTurnMs?: number };
}

const conversationPath = (threadId: string) => `/api/conversations/${encodeURIComponent(threadId)}`;
const deletionPath = (threadId: string) => `${conversationPath(threadId)}/deletion`;
const reactionPath = (threadId: string, messageId: string, reaction: string) =>
    `${conversationPath(threadId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reaction)}`;
const queuedPath = (threadId: string, messageId: string) =>
    `${steeringPath(threadId)}/${encodeURIComponent(messageId)}`;

/** A classifier action as a send's outcome; `delivered` is the kind's own. */
function outcome(action: Exclude<ClassifierAction, { action: 'delivered' }>, answer: Answer): SendOutcome {
    switch (action.action) {
        case 'retry':
        case 'unknown':
        case 'unsent':
            return action;
        case 'back-off':
            return action.delayMs === null
                ? { action: 'retry', reason: action.reason }
                : { action: 'retry', delayMs: action.delayMs, reason: action.reason };
        default:
            return { action: 'unsent', reason: reasonOf(answer) };
    }
}

/** Sends one request of a write and classifies its answer. */
async function request(
    context: OutboxContext,
    write: OutboxWrite<unknown>,
    path: string,
    method: WriteMethod,
    special: (answer: Answer) => ClassifierAction | undefined,
    json?: unknown,
): Promise<{ answer: Answer; action: ClassifierAction }> {
    const response = await context.fetch(path, { method, ...(json === undefined ? {} : { json }) });
    const answer = await readAnswer(response, context.signal);
    return { answer, action: classify(answer, { method, ambiguous: write.ambiguous === true, special }) };
}

/** 404 and 410 on a write that adds or changes: the chat (or the reply) is gone, or never the person's. */
const goneAnswer = (answer: Answer): ClassifierAction | undefined =>
    answer.status === 404 || answer.status === 410 ? { action: 'unsent', reason: MANAGE_REASON.gone } : undefined;

/** A DELETE's 404 or 410: gone already, which is what it asked for. */
const goneIsDone = (answer: Answer): ClassifierAction | undefined =>
    answer.status === 404 || answer.status === 410 ? { action: 'delivered' } : undefined;

/** A refusal that carries a code (a room's rule): `unsent` with it. */
const coded = (answer: Answer): ClassifierAction | undefined =>
    answer.status === 409 && answer.code !== null ? { action: 'unsent', reason: answer.code } : undefined;

const either =
    (...rules: ((answer: Answer) => ClassifierAction | undefined)[]) =>
    (answer: Answer) => {
        for (const rule of rules) {
            const action = rule(answer);
            if (action !== undefined) {
                return action;
            }
        }
        return undefined;
    };

function decoder<P>(check: (value: Record<string, unknown>) => boolean, what: string) {
    return (text: string): P => {
        const value = JSON.parse(text) as Record<string, unknown> | null;
        if (!value || typeof value !== 'object' || typeof value.threadId !== 'string' || !check(value)) {
            throw new TypeError(`Not a ${what}.`);
        }
        return value as P;
    };
}

/** The five chat management kinds, over the scope's histories, steering snapshots and cache. */
export function chatManageKinds(options: ChatManageOptions): OutboxKind<unknown>[] {
    const { histories, steering, cache, afterWrite, onReactions, waits = {} } = options;
    const { deleteBusyMs = DELETE_BUSY_WAIT_MS, cancelTurnMs = CANCEL_TURN_WAIT_MS } = waits;

    /** The chat's server id, or null for a new chat that was never created. */
    const threadOf = (context: OutboxContext, threadId: string) => serverChatId(context.resolve, threadId);
    const shown = (scope: { resolve(kind: string, id: string): string | null }, threadId: string) =>
        shownChatId(scope.resolve, threadId);

    const update: OutboxKind<ChatUpdatePayload> = {
        kind: CHAT_UPDATE_KIND,
        payloadVersion: VERSION,
        repeatable: true,
        decode: decoder<ChatUpdatePayload>(
            (value) =>
                (value.title === undefined || typeof value.title === 'string') &&
                (value.archived === undefined || typeof value.archived === 'boolean') &&
                (value.inference === undefined || isModelChoice(value.inference)) &&
                (value.title !== undefined || value.archived !== undefined || value.inference !== undefined),
            'chat update',
        ),
        async send(write, context) {
            const threadId = threadOf(context, write.payload.threadId);
            if (threadId === null) {
                return { action: 'unsent', reason: MANAGE_REASON.noChat };
            }
            const { title, archived, inference } = write.payload;
            const path = conversationPath(threadId);
            const { answer, action } = await request(
                context,
                write,
                path,
                'PATCH',
                either(goneAnswer, coded, (a) =>
                    a.status === 400
                        ? {
                              action: 'unsent',
                              reason: title !== undefined ? 'title' : archived !== undefined ? 'archived' : 'model',
                          }
                        : undefined,
                ),
                {
                    ...(title === undefined ? {} : { title }),
                    ...(archived === undefined ? {} : { archived }),
                    ...(inference === undefined ? {} : { inference }),
                },
            );
            if (action.action !== 'delivered') {
                return outcome(action, answer);
            }
            afterWrite?.(path);
            const chat = answer.body as { id?: unknown } | null;
            return {
                action: 'done',
                ...(cache !== undefined && chat !== null && typeof chat === 'object' && chat.id === threadId
                    ? {
                          handOff: () =>
                              cache.confirm({ collection: CONVERSATIONS, scope: '', key: threadId, value: chat }),
                      }
                    : {}),
            };
        },
        overlay({ payload }, scope): Overlay {
            const { threadId: _thread, ...change } = payload;
            return { collection: CONVERSATIONS, key: shown(scope, payload.threadId), mode: 'patch', value: change };
        },
    };

    const remove: OutboxKind<ChatDeletePayload> = {
        kind: CHAT_DELETE_KIND,
        payloadVersion: VERSION,
        repeatable: true,
        decode: decoder<ChatDeletePayload>(() => true, 'chat delete'),
        async send(write, context) {
            const threadId = threadOf(context, write.payload.threadId);
            if (threadId === null) {
                // Never created: nothing on the server to delete.
                return { action: 'done' };
            }
            const path = conversationPath(threadId);
            const { answer, action } = await request(context, write, path, 'DELETE', either(goneIsDone, coded));
            const handOff =
                cache === undefined
                    ? {}
                    : {
                          handOff: () =>
                              cache.confirm({ collection: CONVERSATIONS, scope: '', key: threadId, deleted: true }),
                      };
            if (action.action === 'delivered') {
                afterWrite?.(path);
                return { action: 'done', ...handOff };
            }
            if (answer.status !== 409 || answer.code !== null) {
                return outcome(action, answer);
            }
            // Refused with no code: what stops it now (`GET …/deletion`), never the text.
            const asked = await context.fetch(deletionPath(threadId));
            const why = await readAnswer(asked, context.signal);
            if (why.status === 404 || why.status === 410) {
                return { action: 'done', ...handOff };
            }
            const blocked = (why.body as { blocked?: unknown } | null)?.blocked;
            if (why.status !== 200 || blocked === undefined) {
                throw new NetworkError(deletionPath(threadId));
            }
            if (blocked === 'running' || blocked === 'call') {
                return { action: 'retry', delayMs: deleteBusyMs, reason: MANAGE_REASON.busy };
            }
            if (typeof blocked === 'string') {
                return { action: 'unsent', reason: `blocked-${blocked}` };
            }
            // Nothing stops it now: it ended in between.
            return { action: 'retry', reason: MANAGE_REASON.busy };
        },
        overlay({ payload }, scope): Overlay {
            return {
                collection: CONVERSATIONS,
                key: shown(scope, payload.threadId),
                mode: 'patch',
                value: { deleted: true },
            };
        },
    };

    const reaction: OutboxKind<ReactionPayload> = {
        kind: REACTION_KIND,
        payloadVersion: VERSION,
        repeatable: true,
        decode: decoder<ReactionPayload>(
            (value) =>
                typeof value.messageId === 'string' && isReactionKind(value.reaction) && typeof value.on === 'boolean',
            'reaction',
        ),
        async send(write, context) {
            const { messageId, reaction: kind, on } = write.payload;
            const threadId = threadOf(context, write.payload.threadId);
            if (threadId === null) {
                return on ? { action: 'unsent', reason: MANAGE_REASON.noChat } : { action: 'done' };
            }
            const path = reactionPath(threadId, messageId, kind);
            const { answer, action } = await request(
                context,
                write,
                path,
                on ? 'PUT' : 'DELETE',
                on ? either(goneAnswer, coded) : either(goneIsDone, coded),
            );
            if (action.action !== 'delivered') {
                return outcome(action, answer);
            }
            const view = answer.body;
            return {
                action: 'done',
                ...(onReactions !== undefined && view !== null && answer.status !== 404 && answer.status !== 410
                    ? { handOff: async () => onReactions(threadId, view) }
                    : {}),
            };
        },
        overlay({ payload }, scope): Overlay {
            return {
                collection: 'reactions',
                key: `${shown(scope, payload.threadId)}/${payload.messageId}`,
                mode: 'patch',
                value: { reaction: payload.reaction, on: payload.on },
            };
        },
    };

    /** The message's server id: its row's (`ids`) or the id itself. */
    const serverMessage = (context: { resolve(kind: string, id: string): string | null }, messageId: string) =>
        context.resolve(MESSAGE_IDS, messageId) ?? messageId;

    /** Hands a steering write's answer (its view) to the chat's snapshot, else asks it again. */
    const takeView = (take: (view: unknown) => void, threadId: string, body: unknown) => {
        try {
            take(body);
        } catch {
            void steering.steering(threadId).refresh();
        }
    };

    const edit: OutboxKind<SteeringEditPayload> = {
        kind: STEERING_EDIT_KIND,
        payloadVersion: VERSION,
        repeatable: true,
        decode: decoder<SteeringEditPayload>(
            (value) =>
                typeof value.messageId === 'string' &&
                typeof value.text === 'string' &&
                (value.attachments === undefined ||
                    (Array.isArray(value.attachments) && value.attachments.every((id) => typeof id === 'string'))),
            'steering edit',
        ),
        async send(write, context) {
            const { text, attachments } = write.payload;
            const threadId = threadOf(context, write.payload.threadId);
            if (threadId === null) {
                return { action: 'unsent', reason: MANAGE_REASON.noChat };
            }
            const path = queuedPath(threadId, serverMessage(context, write.payload.messageId));
            const take = steering.steering(threadId).writing();
            const { answer, action } = await request(
                context,
                write,
                path,
                'PATCH',
                either(goneAnswer, (a) => {
                    if (a.status === 409 && a.code === 'delivered' && write.ambiguous !== true) {
                        // A turn took it before the edit: the edited text stays the person's.
                        return { action: 'unsent', reason: MANAGE_REASON.delivered };
                    }
                    if (a.status === 400) {
                        return { action: 'unsent', reason: 'content' };
                    }
                    return a.status === 409 && a.code !== 'delivered' ? coded(a) : undefined;
                }),
                { text, ...(attachments === undefined ? {} : { attachments: attachments.map((id) => ({ id })) }) },
            );
            if (action.action !== 'delivered') {
                return outcome(action, answer);
            }
            if (answer.status >= 200 && answer.status < 300) {
                takeView(take, threadId, answer.body);
            } else {
                void steering.steering(threadId).refresh();
            }
            return { action: 'done' };
        },
        overlay({ payload }, scope): Overlay {
            return {
                collection: 'steering',
                key: serverMessage(scope, payload.messageId),
                mode: 'patch',
                value: { threadId: shown(scope, payload.threadId), text: payload.text },
            };
        },
    };

    const cancel: OutboxKind<SteeringCancelPayload> = {
        kind: STEERING_CANCEL_KIND,
        payloadVersion: VERSION,
        repeatable: true,
        decode: decoder<SteeringCancelPayload>((value) => typeof value.messageId === 'string', 'steering cancel'),
        async send(write, context) {
            const threadId = threadOf(context, write.payload.threadId);
            if (threadId === null) {
                // Its chat was never created, so the message never reached a queue.
                return { action: 'done' };
            }
            const messageId = serverMessage(context, write.payload.messageId);
            const chat = steering.steering(threadId);
            const take = chat.writing();
            const { answer, action } = await request(
                context,
                write,
                queuedPath(threadId, messageId),
                'DELETE',
                either(goneIsDone, (a) =>
                    a.status === 409 && a.code === 'delivered' ? { action: 'merge' } : coded(a),
                ),
            );
            // Cancelled: the message will never be stored, so its own `sent`
            // row (chat-send.ts's `awaitStored`) goes with this one, or it would show
            // again once the overlay goes.
            const cancelled: SendOutcome = {
                action: 'done',
                forgetSent: [...new Set([write.payload.messageId, messageId])],
            };
            if (action.action === 'delivered') {
                if (answer.status >= 200 && answer.status < 300) {
                    takeView(take, threadId, answer.body);
                }
                return cancelled;
            }
            if (action.action !== 'merge') {
                return outcome(action, answer);
            }
            // 409 `delivered`: re-read the queue, then the transcript.
            await chat.refresh();
            const history = histories.history(threadId);
            const pulled = await history.pull();
            if (chat.state.gone || history.state.gone) {
                return cancelled;
            }
            if (chat.state.failed || !chat.state.ready || !pulled) {
                throw new NetworkError(steeringPath(threadId));
            }
            if (history.has(messageId)) {
                // Sent: the turn took it before the cancel came.
                return { action: 'done' };
            }
            if (chat.list().some((message) => message.id === messageId) || chat.state.running) {
                // Still queued, or a running turn may hold it: look again.
                return { action: 'retry', delayMs: cancelTurnMs, reason: MANAGE_REASON.delivered };
            }
            return cancelled;
        },
        overlay({ payload }, scope): Overlay {
            return {
                collection: 'steering',
                key: serverMessage(scope, payload.messageId),
                mode: 'patch',
                value: { threadId: shown(scope, payload.threadId), cancelled: true },
            };
        },
    };

    return [update, remove, reaction, edit, cancel] as OutboxKind<unknown>[];
}

const viewsOnly = () => {
    throw new Error('These kinds only lay overlays.');
};

/**
 * How these kinds' rows look on screen (`overlaysOf`), without anything that
 * sends: the chat list lays renames, archives and deletes over its rows, the
 * chat reactions over its replies.
 */
export const CHAT_MANAGE_VIEWS: readonly OverlayKind<unknown>[] = chatManageKinds({
    histories: { history: viewsOnly },
    steering: { steering: viewsOnly },
});
