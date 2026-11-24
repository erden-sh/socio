import { characterFor, characterOf, type LocalId } from '@socio/shared/mascot';
import type { Conversation, Dot } from '@socio/shared/types';

import { isRoom, UNTITLED_CHAT } from '../shell/chat-list';

// What the chat route (`/chats/:id`) shows for an id, from the scope's
// conversations and socios. No React Native here: tests/chat runs it under Node.
// - A private chat: its transcript (transcript.ts) under its title and socio.
// - A room (`kind: 'room'`, or a `room:` owner): its transcript with who wrote
//   each message (room-transcript.ts), under the room's header. A room id
//   never reaches the chat's send path: `sendableChatId` is the only way the
//   chat composer gets an id to send to, and a room's messages go through the
//   room's `room-message` write (the room's composer).
// - A chat the workspace doesn't list yet but this phone writes to:
//   a new chat's local id, or its server id before the next pull lists it,
//   with the outbox's rows naming its socio (`PendingChat`). It is private,
//   "New chat" until the list has its title. Only a new chat's writes count:
//   a message queued to a chat the list has since dropped leaves it missing.
// - An id the workspace doesn't list once it has answered: gone (deleted, or
//   no longer the person's). Before the first answer (a link on a fresh
//   sign-in), it waits rather than guess the kind.

export type ChatKind = 'private' | 'room' | 'missing' | 'waiting';

export interface ChatView {
    readonly kind: ChatKind;
    readonly id: string;
    readonly title: string;
    /** The socio's name, or null when the scope doesn't hold it. */
    readonly socio: string | null;
    readonly character: LocalId;
}

export const OPEN_IN_BROWSER = 'Open in your browser';
/** An approval card's link in a chat (the web's ApprovalCard `linkToPage`): the request's own page in the app. */
export const OPEN_IN_APPROVALS = 'Open in Approvals';
export const MISSING_CHAT_TITLE = 'This chat isn’t here';
/** The headline over a chat that isn't there: the web's `NotFound what="Conversation"` (ChatViews.tsx). */
export const CONVERSATION_NOT_FOUND = 'Conversation not found';
export const MISSING_CHAT_CAPTION = 'It was deleted, or you no longer have access to it.';
/** The headline over ROOM_GONE_CAPTION, in the shared empty state. */
export const ROOM_GONE_TITLE = 'Room not available';
/** A room the server says the reader is no longer in (its view's 404), as the web says it. */
export const ROOM_GONE_CAPTION = 'You are no longer in this room, so you can’t read it here.';
export const EMPTY_CHAT = 'No messages yet.';
/** An empty room, as the web's RoomChat says it: at the top of the transcript, not centered. */
export const EMPTY_ROOM = 'No messages yet. Everyone in the room reads what is written here.';

/** What an empty transcript says: a room's line names who reads it. */
export const emptyTranscriptLine = (room: boolean) => (room ? EMPTY_ROOM : EMPTY_CHAT);
export const NEW_CHAT_TITLE = 'New chat';

/** A chat the workspace doesn't list yet, known from the outbox's rows for it (a new chat's). */
export interface PendingChat {
    readonly dotId: string;
}

/** Whether a conversation is a room (CB-207): its kind, or an owner that is a room. */
export { isRoom };

/**
 * What the chat route shows for `id`. `answered`: the workspace's snapshot has
 * come at least once (its row is in the scope), so a chat it doesn't list is gone.
 */
export function chatView(
    conversations: readonly Conversation[],
    dots: readonly Dot[],
    id: string,
    answered: boolean,
    pending: PendingChat | null = null,
): ChatView {
    const chat = conversations.find((known) => known.id === id);
    if (chat === undefined && pending !== null) {
        const dot = dots.find((known) => known.id === pending.dotId);
        return {
            kind: 'private',
            id,
            title: NEW_CHAT_TITLE,
            socio: dot?.name ?? null,
            character: dot === undefined ? characterFor(pending.dotId) : characterOf(dot),
        };
    }
    if (chat === undefined) {
        return {
            kind: answered ? 'missing' : 'waiting',
            id,
            title: answered ? MISSING_CHAT_TITLE : '',
            socio: null,
            character: characterFor(id),
        };
    }
    const dot = dots.find((known) => known.id === chat.dotId);
    return {
        kind: isRoom(chat) ? 'room' : 'private',
        id,
        title: typeof chat.title === 'string' && chat.title.trim() !== '' ? chat.title : UNTITLED_CHAT,
        socio: dot?.name ?? null,
        character: dot === undefined ? characterFor(chat.dotId) : characterOf(dot),
    };
}

/**
 * The id a composer may send to, with its socio: a private chat the scope
 * lists, or one the outbox is creating (`pending`), else null. A room, an id
 * nobody lists and one still waiting never get one.
 */
export function sendableChatId(
    conversations: readonly Conversation[],
    id: string,
    pending: PendingChat | null = null,
): string | null {
    const chat = conversations.find((known) => known.id === id);
    if (chat === undefined) {
        return pending === null ? null : id;
    }
    return !isRoom(chat) ? chat.id : null;
}

/** The socio a sendable chat's messages go to. */
export function chatSocioId(
    conversations: readonly Conversation[],
    id: string,
    pending: PendingChat | null = null,
): string | null {
    return conversations.find((known) => known.id === id)?.dotId ?? pending?.dotId ?? null;
}

/** The chat's page on the workspace's web app, for a card's "Open in your browser". */
export const chatWebUrl = (origin: string, id: string) => `${origin}/chats/${encodeURIComponent(id)}`;
