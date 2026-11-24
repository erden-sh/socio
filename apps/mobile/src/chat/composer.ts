import type { OthersQueuedMessage, QueuedMessage } from '@socio/shared/chat/steering';
import type { LiveTurn } from '@socio/shared/rooms/live-turn';
import type { Conversation } from '@socio/shared/types';

import { UPDATE_TO_SEND } from '../data/migrate';
import { type Attachments, enqueueWithAttachments } from '../sync/attachments';
import { chatDraft, type Drafts, joinDraft } from '../sync/chat-drafts';
import {
    CHAT_MESSAGE_KIND,
    CHAT_WAIT,
    type ChatMessageInput,
    type ChatMessageOverlay,
    chatMessageWrite,
    chatWaitCopy,
} from '../sync/chat-send';
import type { ChatHistory } from '../sync/history';
import { chatWriteRoute, CONVERSATION_IDS, isLocalChat } from '../sync/local-ids';
import { NEW_CHAT_KIND } from '../sync/new-chat';
import type { HoldGroup, Outbox, OutboxRow, UnsentWrite } from '../sync/outbox';
import type { OverlayItem } from '../sync/outbox-overlay';
import { type ChatSteering, queuedBubbles } from '../sync/steering';
import { sameItems } from '../sync/unsent-store';

import type { MessageFile } from './attachment-tray';
import type { PendingChat } from './chat-view';
import { LIVE_TRACE_ID, messageText } from './transcript';
import { liveSummary } from './turn-trace';

// The chat's composer and what it adds to the transcript, under Node:
// - **What the composer is:** a box with Send, or a line instead of it for a
//   chat the app can't send to (a Telegram chat or team topic, answered in
//   Telegram). While a turn runs and the box is empty, Send is Stop (T3 Code's
//   composer); with text typed, Send queues it (steering).
// - **Lines under the box:** held for sign-in ("Sign in again to send…"), a
//   draft or user.db this build can't change ("Update Socio to send these").
// - **Queued bubbles** (`pendingBubbles`): the outbox's rows for the chat and
//   the steering snapshot's queued messages, each once across the hand-off
//   (steering.ts's `queuedBubbles`), and none the live turn already holds
//   (`deliveredInTurn`) or the history stores. Each says where it stands in
//   plain words: Sending…, "Sends when <socio> finishes", "Not sent" with
//   Retry and Edit, "Couldn’t confirm this was sent" with View (each message
//   its check found that may be it, when the transcript shows one) and
//   Send again, a message that asks first with its age, Send now, Edit and
//   Delete. A chat
//   the list has dropped keeps its refused ones under the missing view with
//   Delete only (`missingChatBubbles`); only a new chat's writes make an
//   unlisted id a chat (`pendingChatOf`).
// - **The status pill** above the box: the running turn's phase (a shimmer,
//   still under Reduce Motion) and "Jump to latest" while not following.
// - **Reduce Motion** turns every animated scroll (a send, Jump to latest)
//   into a jump, and the shimmer off. The follow scroll never animates.
// - **No submission anchor:** a short chat starts at the top, as on the web and
//   in ChatGPT (owner, 2026-11-18), so a chat's first message is already there;
//   every send scrolls to the end.

/** In a Telegram chat: the composer's place. */
export const TELEGRAM_LINE = 'This chat is in Telegram. Reply there to continue it.';
/** In a team topic (the web's TeamTranscript). */
export const TEAM_LINE = 'Reply in the Telegram topic to continue this conversation.';
/** While every lane waits for sign-in (the outbox's `heldForSignIn`). */
export const HELD_LINE = 'Sign in again to send. Your messages wait on this phone.';
export const COMPOSER_PLACEHOLDER = 'Message';

/** The box's height with no text: one line (its `min-h-10`). */
export const EMPTY_INPUT_HEIGHT = 40;

/**
 * The box's fixed height, or undefined to let it grow with its text. iOS keeps
 * a multiline box at the height of its last text once the value is cleared (a
 * long send left it two lines tall), so on iOS an empty box is one line again.
 */
export function composerInputHeight(platform: string, text: string): number | undefined {
    return platform === 'ios' && text === '' ? EMPTY_INPUT_HEIGHT : undefined;
}
export const NOT_SENT = 'Not sent';
export const UNCONFIRMED = 'Couldn’t confirm this was sent';
export const NO_ACCESS = 'You no longer have access';
export const STOP_FAILED = 'Couldn’t stop. Check your connection and try again.';
export const SEND_FAILED = 'Your message wasn’t saved. Try again.';
export const JUMP_TO_LATEST = 'Jump to latest';
/** A message waiting for its files to upload (the `uploading` retry reason, the attachments' `prepare`). */
export const UPLOADING_FILES = 'Uploading files…';
/** Refused because a file failed for good, or because the server dropped an upload. */
export const FILE_FAILED = 'Not sent · A file didn’t upload';
export const FILE_EXPIRED = 'Not sent · A file expired. Attach it again.';

/** The line shown in place of the composer, or null when the chat takes messages here. */
export function readOnlyLine(chat: Pick<Conversation, 'team' | 'source'> | undefined): string | null {
    if (chat?.team) {
        return TEAM_LINE;
    }
    return chat?.source === 'telegram' ? TELEGRAM_LINE : null;
}

export interface ComposerInput {
    /** What the box holds. */
    readonly text: string;
    /** A turn runs in the chat (the live turn, or the steering snapshot's `running`). */
    readonly running: boolean;
    /** The draft is a newer build's, or user.db is read-only. */
    readonly locked: boolean;
    /** Every lane waits for sign-in. */
    readonly heldForSignIn: boolean;
    /** A send or a stop is on its way from this screen. */
    readonly busy: boolean;
    /** Files in the tray that go with the next send: a box with files and no text sends too. */
    readonly files?: number;
}

export interface ComposerView {
    /** The button beside the box: Send, or Stop while a turn runs and the box is empty. */
    readonly action: 'send' | 'stop';
    readonly enabled: boolean;
    readonly editable: boolean;
    /** Under the box, or null. */
    readonly line: string | null;
}

export function composerView(input: ComposerInput): ComposerView {
    const typed = input.text.trim() !== '' || (input.files ?? 0) > 0;
    const action = input.running && !typed ? 'stop' : 'send';
    return {
        action,
        // A send while held for sign-in still queues: the message waits on the phone.
        enabled: !input.busy && !input.locked && (action === 'stop' || typed),
        editable: !input.locked,
        line: input.locked ? UPDATE_TO_SEND : input.heldForSignIn ? HELD_LINE : null,
    };
}

export type BubbleAction = 'retry' | 'edit' | 'view' | 'send-now' | 'delete';

/** A message of the person's not yet in the stored history or the live turn: the outbox's, or queued on the server. */
export interface PendingBubble {
    readonly kind: 'pending';
    /** `pending:<id>`: the list's key. */
    readonly id: string;
    /** The outbox row's id (or the unsent write's); for a message queued on the server, its server id. */
    readonly writeId: string;
    readonly source: 'outbox' | 'queued';
    readonly text: string;
    /** Drawn dashed: it waits (queued on the server, or on the phone for something). */
    readonly waiting: boolean;
    /** Refused or unconfirmed: drawn in the destructive tone. */
    readonly problem: boolean;
    readonly caption: string | null;
    readonly actions: readonly BubbleAction[];
    /** The files it carries, from their copies on the phone. */
    readonly files: readonly MessageFile[];
    /**
     * Unconfirmed: the transcript's rows that may be this message (the
     * outbox check's candidates the list shows, as its keys, oldest first),
     * which View scrolls to in turn. Absent otherwise.
     */
    readonly candidates?: readonly string[];
}

/**
 * A pending bubble's button through the outbox: Retry, Edit, Send now (or
 * Send again) and Delete. `box` is the chat's draft scope, null when the chat
 * takes no messages. Edit puts the text and then the files back in the box
 * before the row goes, so a failure leaves them in both places, never in
 * neither; Retry uploads again the files that failed first.
 */
export async function bubbleAction(
    stores: { readonly outbox: Outbox; readonly drafts: Drafts; readonly attachments: Attachments },
    bubble: Pick<PendingBubble, 'writeId' | 'text'>,
    action: BubbleAction,
    box: string | null,
    newKey: () => string,
): Promise<void> {
    const { outbox, drafts, attachments } = stores;
    const unsent = outbox.unsent().some((write) => write.id === bubble.writeId);
    const discard = () => (unsent ? outbox.discardUnsent(bubble.writeId) : outbox.remove(bubble.writeId));
    switch (action) {
        case 'view':
            // The screen's: it scrolls the transcript (`nextCandidate`); the outbox has nothing to do.
            return;
        case 'retry':
            attachments.rearm(bubble.writeId);
            await outbox.retryUnsent(bubble.writeId, newKey());
            return;
        case 'send-now':
            await outbox.sendNow(bubble.writeId);
            return;
        case 'edit':
            if (box !== null) {
                drafts.write(box, joinDraft(drafts.read(box).text, bubble.text));
                await attachments.restore(bubble.writeId, box);
            }
            await discard();
            return;
        case 'delete':
            await discard();
    }
}

/** "written 2 h ago", from the device clock. */
export function writtenAgo(createdAt: number, now: number): string {
    const minutes = Math.max(0, Math.floor((now - createdAt) / 60_000));
    if (minutes < 1) {
        return 'written just now';
    }
    if (minutes < 60) {
        return `written ${minutes} min ago`;
    }
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `written ${hours} h ago` : `written ${Math.floor(hours / 24)} d ago`;
}

const GONE_REASONS = new Set(['gone', 'no-chat', 'socio-gone']);

const FILE_REASONS: Readonly<Record<string, string>> = {
    'attachment-failed': FILE_FAILED,
    'attachment-expired': FILE_EXPIRED,
};

function outboxBubble(
    item: OverlayItem,
    socio: string,
    now: number,
    stalled: boolean,
    files: readonly MessageFile[],
    candidates: readonly string[],
): PendingBubble {
    const value = item.value as ChatMessageOverlay;
    const base = {
        kind: 'pending' as const,
        id: `pending:${item.id}`,
        writeId: item.id,
        source: 'outbox' as const,
        text: messageText(value.message),
        files,
    };
    switch (item.state) {
        case 'unsent':
            return {
                ...base,
                waiting: false,
                problem: true,
                caption:
                    item.reason !== null && GONE_REASONS.has(item.reason)
                        ? NO_ACCESS
                        : ((item.reason !== null ? FILE_REASONS[item.reason] : undefined) ?? NOT_SENT),
                actions: ['retry', 'edit'],
            };
        case 'unconfirmed':
            return candidates.length === 0
                ? { ...base, waiting: false, problem: true, caption: UNCONFIRMED, actions: ['send-now'] }
                : {
                      ...base,
                      waiting: false,
                      problem: true,
                      caption: UNCONFIRMED,
                      actions: ['view', 'send-now'],
                      candidates,
                  };
        case 'held':
            return item.reason === CHAT_WAIT.ask
                ? {
                      ...base,
                      waiting: true,
                      problem: false,
                      caption: writtenAgo(item.createdAt, now),
                      actions: ['send-now', 'edit', 'delete'],
                  }
                : { ...base, waiting: true, problem: false, caption: 'Waiting to send', actions: ['send-now'] };
        case 'sent':
            // The server has it; the history or the snapshot takes it over.
            return { ...base, waiting: false, problem: false, caption: null, actions: [] };
        default: {
            const wait = chatWaitCopy(item.reason, socio);
            if (wait !== null) {
                return { ...base, waiting: true, problem: false, caption: wait, actions: [] };
            }
            if (item.reason === 'uploading') {
                return { ...base, waiting: true, problem: false, caption: UPLOADING_FILES, actions: [] };
            }
            // On its way only while nothing holds it: offline, held for sign-in or after a failed attempt it waits.
            const sending = item.state === 'sending' && !stalled && item.reason === null;
            return {
                ...base,
                waiting: !sending,
                problem: false,
                caption: sending ? 'Sending…' : 'Waiting to send',
                actions: [],
            };
        }
    }
}

export interface PendingInput {
    /** The chat shown (a server id, or a new chat's local id until it resolves). */
    readonly threadId: string;
    /** The outbox's overlays (`overlaysOf` with the chat message's view). */
    readonly overlays: readonly OverlayItem[];
    /** The steering snapshot's queued messages, oldest first. */
    readonly queued: readonly QueuedMessage[];
    /** Whether the stored history holds a message id. */
    readonly stored: (messageId: string) => boolean;
    /** The person's messages the live turn holds (`deliveredInTurn`). */
    readonly inTurn: ReadonlySet<string>;
    readonly socio: string;
    readonly heldForSignIn: boolean;
    /** The workspace is away ("Reconnecting…"): nothing is on its way. */
    readonly offline: boolean;
    /** The device clock, for a message's age. */
    readonly now: number;
    /** An outbox row's files (`attachments.carried`, as `carriedFiles`); none by default. */
    readonly files?: (writeId: string) => readonly MessageFile[];
    /** The unconfirmed rows' candidates, server message ids by row id (`OutboxState.candidates`); none by default. */
    readonly candidates?: ReadonlyMap<string, readonly string[]>;
}

/**
 * An unconfirmed message's candidates as the transcript's keys: a stored or
 * live message is its id, one still queued on the server is its bubble's.
 * One the list doesn't show (not loaded, or gone) is left out.
 */
function candidateKeys(ids: readonly string[], input: PendingInput, delivered: (id: string) => boolean): string[] {
    const keys: string[] = [];
    for (const id of ids) {
        if (delivered(id)) {
            keys.push(id);
        } else if (input.queued.some((message) => message.id === id)) {
            keys.push(`pending:${id}`);
        }
    }
    return keys;
}

/**
 * View's next row: the candidate after the one it showed last (`current`, a
 * key or null), back to the first after the last; null when none shows.
 */
export function nextCandidate(candidates: readonly string[], current: string | null): string | null {
    if (candidates.length === 0) {
        return null;
    }
    const at = current === null ? -1 : candidates.indexOf(current);
    return candidates[(at + 1) % candidates.length]!;
}

/** What View tells a screen reader: "Possible copy 1 of 2". */
export function candidateSaid(candidates: readonly string[], key: string): string {
    return candidates.length === 1
        ? 'Possible copy of your message'
        : `Possible copy ${candidates.indexOf(key) + 1} of ${candidates.length}`;
}

/** The person's messages not yet in the transcript, oldest first: the outbox's, then the server's queue. */
export function pendingBubbles(input: PendingInput): PendingBubble[] {
    const delivered = (id: string) => input.stored(id) || input.inTurn.has(id);
    const items = input.overlays
        .filter(
            (item) =>
                item.collection === 'history' &&
                (item.value as ChatMessageOverlay).threadId === input.threadId &&
                // A run's message keeps its own id; a steering one's server id is checked below.
                !delivered(item.id),
        )
        .map((item) => ({ item, serverId: (item.value as ChatMessageOverlay).serverId }));
    const shown = queuedBubbles(items, input.queued, delivered);
    return [
        ...shown.outbox.map(({ item }) =>
            outboxBubble(
                item,
                input.socio,
                input.now,
                input.heldForSignIn || input.offline,
                input.files?.(item.id) ?? NO_FILES,
                candidateKeys(input.candidates?.get(item.id) ?? NO_IDS, input, delivered),
            ),
        ),
        ...shown.queued.map((message): PendingBubble => ({
            kind: 'pending',
            id: `pending:${message.id}`,
            writeId: message.id,
            source: 'queued',
            text: message.text,
            waiting: true,
            problem: false,
            caption: `Queued · ${writtenAgo(message.createdAt, input.now)}`,
            actions: [],
            files: NO_FILES,
        })),
    ];
}

const NO_FILES: readonly MessageFile[] = [];
const NO_IDS: readonly string[] = [];

/**
 * The bubbles a chat the workspace no longer lists keeps under "This chat
 * isn’t here": the outbox's, without a composer. A refused one offers Delete
 * only (Edit has no box to go back to, and Retry would be refused again); its
 * text stays selectable. The rest fail the same way on their next attempt.
 */
export function missingChatBubbles(bubbles: readonly PendingBubble[]): PendingBubble[] {
    return bubbles
        .filter((bubble) => bubble.source === 'outbox')
        .map(({ candidates: _, ...bubble }) => ({
            ...bubble,
            actions: bubble.actions.includes('retry') ? ['delete'] : [],
        }));
}

/**
 * The turn the chat draws: this device's own run's (the run client's, which
 * its follow stream drops) while it runs or still holds what the history
 * hasn't stored, else the follow stream's.
 */
export function chatLiveTurn(own: LiveTurn, follow: LiveTurn): LiveTurn {
    if (own.running) {
        return own;
    }
    if (follow.running || own.messages.length === 0) {
        return follow;
    }
    return own;
}

export interface StatusPill {
    /** The running turn's phase ("Thinking", "Working", "Writing"), or null. */
    readonly status: string | null;
    /** The phase shimmers: not under Reduce Motion. */
    readonly shimmer: boolean;
    /** "Jump to latest": shown while the list doesn't follow its end. */
    readonly jump: boolean;
}

/** The pill above the composer, or null when it has nothing to say. */
export function statusPill(turn: LiveTurn, following: boolean, reduceMotion: boolean): StatusPill | null {
    const status = turn.running ? (liveSummary(turn.phase)?.label ?? 'Writing') : null;
    if (status === null && following) {
        return null;
    }
    return { status, shimmer: status !== null && !reduceMotion, jump: !following };
}

/**
 * The pills as they show: one running-turn indicator at a time (CB-493 and its follow-up). While the
 * running turn's own line ("Working · 3 steps", or the phase's word: `LIVE_TRACE_ID`) is in view in
 * the transcript, the pills leave the phase out, in the flow and floating alike, and with no "Jump to
 * latest" either there is no row at all. The phase stays where nothing in view says it: a room (its
 * transcript has no such line), a reply being written, or the line scrolled out of view.
 */
export function shownPill(pill: StatusPill | null, lineInView: boolean): StatusPill | null {
    if (pill === null || !lineInView || pill.status === null) {
        return pill;
    }
    return pill.jump ? { ...pill, status: null, shimmer: false } : null;
}

/** Whether the running turn's own line is among the rows the transcript shows (`onViewableItemsChanged`). */
export const liveLineInView = (viewable: readonly { readonly key: string; readonly isViewable: boolean }[]) =>
    viewable.some((token) => token.isViewable && token.key === LIVE_TRACE_ID);

/** Whether a scroll the app makes (a send, Jump to latest) animates: never under Reduce Motion. */
export const scrollAnimated = (reduceMotion: boolean) => !reduceMotion;

/** An outbox row or refused write, as `pendingChatOf` reads it. */
interface WriteLike {
    readonly id: string;
    readonly kind: string;
    readonly payload: string;
}

/**
 * The chat `id` as the outbox's writes for a new chat name it, when the
 * workspace doesn't list it yet: the create (its local id, or the server id it
 * resolved to) or a message to its local id (matched the same way). A message
 * to a server id names a chat that already existed: when the list drops it,
 * it is gone, never new, so it doesn't count. Null when no such write names it.
 */
export function pendingChatOf(
    writes: readonly WriteLike[],
    resolve: (kind: string, localId: string) => string | null,
    id: string,
): PendingChat | null {
    for (const write of writes) {
        let payload: { threadId?: unknown; dotId?: unknown };
        try {
            payload = JSON.parse(write.payload) as typeof payload;
        } catch {
            continue;
        }
        if (typeof payload?.dotId !== 'string') {
            continue;
        }
        if (write.kind === NEW_CHAT_KIND && (write.id === id || resolve(CONVERSATION_IDS, write.id) === id)) {
            return { dotId: payload.dotId };
        }
        if (
            write.kind === CHAT_MESSAGE_KIND &&
            typeof payload.threadId === 'string' &&
            isLocalChat(payload.threadId) &&
            (payload.threadId === id || resolve(CONVERSATION_IDS, payload.threadId) === id)
        ) {
            return { dotId: payload.dotId };
        }
    }
    return null;
}

export interface SendInput {
    readonly drafts: Pick<Drafts, 'enqueueFromDraft'>;
    readonly outbox: Pick<Outbox, 'rows' | 'unsent' | 'resolve'>;
    readonly history: Pick<ChatHistory, 'list'>;
    readonly steering: Pick<ChatSteering, 'list'> & { readonly state: Pick<ChatSteering['state'], 'running'> };
    /** The chat's id from `sendableChatId`: never a room's. */
    readonly threadId: string;
    readonly dotId: string;
    /** A fresh UUID (expo-crypto): the message's id and its key. */
    readonly newId: () => string;
    /** The scope's `serverClock.lastDate()`. */
    readonly serverAt: number | null;
    /** The scope's attachments: the chat's tray goes with the message, in the draft's transaction. */
    readonly attachments?: Pick<Attachments, 'forSend'>;
}

/**
 * Sends the chat's box through the outbox: the draft cleared in the row's
 * insert transaction, on the lane its earlier messages wait in (a new chat's).
 * The row once durable, or null for a blank box; rejects with the box as it
 * was.
 */
export function sendChatMessage(input: SendInput): Promise<OutboxRow | null> {
    const route = chatWriteRoute(input.outbox, input.threadId);
    const write = (text: string, attachments?: ChatMessageInput['attachments']) =>
        chatMessageWrite({
            id: input.newId(),
            idempotencyKey: input.newId(),
            threadId: input.threadId,
            dotId: input.dotId,
            text,
            ...(attachments?.length ? { attachments } : {}),
            history: input.history,
            steering: input.steering,
            serverAt: input.serverAt,
            route,
        });
    const box = chatDraft(input.threadId);
    // With the scope's attachments, the tray's files (by local id) go in the row's insert.
    return input.attachments
        ? enqueueWithAttachments(input.drafts, input.attachments, box, write)
        : input.drafts.enqueueFromDraft(box, (text) => write(text));
}

/** The outbox as the chat screen reads it: its rows, refused writes, sign-in hold and unconfirmed candidates. */
export interface OutboxState {
    readonly rows: readonly OutboxRow[];
    readonly unsent: readonly UnsentWrite[];
    readonly heldForSignIn: boolean;
    /** Each unconfirmed row's candidates (server ids, for View), by row id; only rows that have some. */
    readonly candidates: ReadonlyMap<string, readonly string[]>;
}

/** The unconfirmed rows' candidates from the outbox's hold groups. */
export function unconfirmedCandidates(groups: readonly HoldGroup[]): ReadonlyMap<string, readonly string[]> {
    const found = new Map<string, readonly string[]>();
    for (const { root } of groups) {
        if (root.cause === 'unconfirmed' && root.candidates !== undefined && root.candidates.length > 0) {
            found.set(root.id, root.candidates);
        }
    }
    return found;
}

/** An external store over the outbox for React: a new snapshot after each change, the same one between. */
export function outboxStateStore(
    outbox: Pick<Outbox, 'rows' | 'unsent' | 'status' | 'holds' | 'subscribe' | 'onUnsent' | 'onStatus'>,
) {
    let snapshot: OutboxState | null = null;
    const read = (): OutboxState => ({
        rows: outbox.rows(),
        unsent: outbox.unsent(),
        heldForSignIn: outbox.status().heldForSignIn,
        candidates: unconfirmedCandidates(outbox.holds()),
    });
    return {
        get(): OutboxState {
            snapshot ??= read();
            return snapshot;
        },
        subscribe(listener: () => void): () => void {
            const changed = () => {
                snapshot = null;
                listener();
            };
            const stops = [outbox.subscribe(changed), outbox.onUnsent(changed), outbox.onStatus(changed)];
            // A change between the render's snapshot and this subscription told nobody: look once.
            if (snapshot !== null && !sameOutboxState(snapshot, read())) {
                changed();
            }
            return () => {
                for (const stop of stops) {
                    stop();
                }
            };
        },
    };
}

/** Rows and refused writes are never mutated, so the same items mean the same state. */
function sameOutboxState(a: OutboxState, b: OutboxState): boolean {
    return (
        a.heldForSignIn === b.heldForSignIn &&
        sameItems(a.rows, b.rows) &&
        sameItems(a.unsent, b.unsent) &&
        sameCandidates(a.candidates, b.candidates)
    );
}

function sameCandidates(a: ReadonlyMap<string, readonly string[]>, b: ReadonlyMap<string, readonly string[]>): boolean {
    if (a.size !== b.size) {
        return false;
    }
    for (const [id, ids] of a) {
        const other = b.get(id);
        if (other === undefined || !sameItems(ids, other)) {
            return false;
        }
    }
    return true;
}

/** A chat's steering snapshot as the screen reads it. */
export interface SteeringSnapshot {
    readonly queued: readonly QueuedMessage[];
    readonly running: boolean;
    /** In a room, for its admins: everyone else's waiting messages. */
    readonly others: readonly OthersQueuedMessage[];
}

const NO_OTHERS: readonly OthersQueuedMessage[] = [];

/** An external store over one chat's steering snapshot, rebuilt only when it changed. */
export function steeringStore(chat: Pick<ChatSteering, 'state' | 'list' | 'subscribe'>) {
    let snapshot: (SteeringSnapshot & { readonly state: unknown }) | null = null;
    return {
        subscribe: (listener: () => void) => chat.subscribe(listener),
        get(): SteeringSnapshot {
            const queued = chat.list();
            if (
                snapshot === null ||
                snapshot.state !== chat.state ||
                snapshot.queued.length !== queued.length ||
                snapshot.queued.some((message, index) => message !== queued[index])
            ) {
                snapshot = {
                    queued,
                    running: chat.state.running,
                    others: chat.state.others ?? NO_OTHERS,
                    state: chat.state,
                };
            }
            return snapshot;
        },
    };
}
