import { characterFor, characterOf, type LocalId } from '@socio/shared/mascot';
import { ROOM_UNREAD_CAP, unreadLabel } from '@socio/shared/rooms/rooms';
import type { Conversation, Dot, State } from '@socio/shared/types';

// The chat list (the web's sidebar and palette,
// packages/client/src/modules/chat and rooms/api.ts): the scope's
// conversations as rows, newest first. No React Native, so tests/shell runs
// it under Node on seeded collections.
// - No archived chat: /api/workspace sends them in `archived`, and the scope
//   keeps them in the same collection, marked with `archivedAt` (shell.ts).
// - Rooms only while the workspace has them on (`settings.rooms.enabled`), as
//   the web's `shownChats`; with no state row yet, none.
// - The server's order, `createdAt` DESC; the id breaks a tie, so the order
//   never changes between renders.
// - A room's unread count, at most ROOM_UNREAD_CAP, shown as the web's `99+`.

export interface ChatRow {
    readonly id: string;
    readonly title: string;
    /** The socio's name, or null when the scope doesn't hold it. */
    readonly socio: string | null;
    /** The socio's character (its Local), for its avatar. */
    readonly character: LocalId;
    readonly room: boolean;
    /** The reader's role in a room when the web names it ("Admin", as its Rooms list); else null. */
    readonly roomRole: string | null;
    /** A room's unread turns, at most ROOM_UNREAD_CAP; null when none, or not a room. */
    readonly unread: number | null;
    /** `3`, or `99+`; null with no unread. */
    readonly unreadLabel: string | null;
    /** What a screen reader says for the row. */
    readonly accessibilityLabel: string;
}

/** The reader's role beside a room they administer (the web's RoomsNav row). */
export const ROOM_ADMIN = 'Admin';

/** A chat with no title yet. */
export const UNTITLED_CHAT = 'New chat';

/**
 * Whether a chat is a room: its `kind`, or an owner id an older server sends
 * without a kind (`room:<id>`). The list, Search, Home and the chat screen all
 * ask this, so a room's history is never read from a row press either.
 */
export const isRoom = (chat: Pick<Conversation, 'kind' | 'ownerId'>) =>
    chat.kind === 'room' || (typeof chat.ownerId === 'string' && chat.ownerId.startsWith('room:'));

/** Whether the workspace has rooms on (the web's `roomsOn`). */
export const roomsOn = (state: Pick<State, 'settings'> | null | undefined) => state?.settings.rooms?.enabled === true;

/** Newest first, as the server sends them (`createdAt` DESC), then by id. */
export function byNewest(a: { id: string; createdAt: number }, b: { id: string; createdAt: number }): number {
    if (a.createdAt !== b.createdAt) {
        return b.createdAt - a.createdAt;
    }
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function chatList(
    conversations: readonly Conversation[],
    dots: readonly Dot[],
    state: Pick<State, 'settings'> | null | undefined,
): ChatRow[] {
    const socios = new Map(dots.map((dot) => [dot.id, dot]));
    const rooms = roomsOn(state);
    return conversations
        .filter((chat) => chat.archivedAt === undefined || chat.archivedAt === null)
        .filter((chat) => !isRoom(chat) || rooms)
        .sort(byNewest)
        .map((chat) => {
            const dot = socios.get(chat.dotId);
            const room = isRoom(chat);
            const count = room && typeof chat.unread === 'number' && chat.unread > 0 ? chat.unread : 0;
            const unread = count > 0 ? Math.min(count, ROOM_UNREAD_CAP) : null;
            const label = unread === null ? null : unreadLabel(unread);
            const title = typeof chat.title === 'string' && chat.title.trim() !== '' ? chat.title : UNTITLED_CHAT;
            const socio = dot?.name ?? null;
            const roomRole = room && chat.roomRole === 'admin' ? ROOM_ADMIN : null;
            return {
                id: chat.id,
                title,
                socio,
                character: dot === undefined ? characterFor(chat.dotId) : characterOf(dot),
                room,
                roomRole,
                unread,
                unreadLabel: label,
                accessibilityLabel: [
                    title,
                    room ? 'room' : null,
                    roomRole,
                    socio === null ? null : `with ${socio}`,
                    label === null ? null : `${label} unread`,
                ]
                    .filter((part) => part !== null)
                    .join(', '),
            };
        });
}
