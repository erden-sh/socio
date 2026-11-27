import type { ReactionKind } from '@socio/shared/chat/reactions';
import type { ModelChoice } from '@socio/shared/inference';
import type { Conversation } from '@socio/shared/types';

import type { OverlayItem } from '../sync/outbox-overlay';

import type { ReactionButton } from './reactions';

// The long-press menus, each also the row's
// accessibility actions, so VoiceOver and TalkBack reach every item without
// the gesture:
// - a message: Reply where it can be quoted (CB-571, quote-reply.ts), Copy
//   and Share (React Native's), and on a socio's stored
//   reply its four reactions, each a toggle; the row under every message
//   (`messageRowActions`) shows Copy and the reactions as buttons, as the web;
// - a private chat's row: Rename, Archive (an undo toast, no confirm, as
//   ChatGPT and T3 Code do; the web's "Chat archived") and Delete (after a
//   native confirm, the web's "Delete chat?"). A room has none here: its
//   menu is the room's own.
// The chat list lays the outbox's renames, archives and deletes over its
// rows (`withChatWrites`), so each shows at once, offline too.
// No React Native here: tests/chat runs it under Node.

export interface MenuAction {
    /** Its accessibility action's name: `reply`, `copy`, `share`, `react:up`, `rename`, `archive`, `delete`. */
    readonly name: string;
    readonly label: string;
    readonly destructive?: boolean;
    /** Shown but not choosable (dimmed in the native menu). */
    readonly disabled?: boolean;
    /** The choice that holds now (a filter's value): checked in the native menu. */
    readonly checked?: boolean;
    /** Its SF Symbol on iOS, over `MENU_SYMBOLS`' (src/shell/native-menu.ts). */
    readonly icon?: string;
}

/** Quote-reply (CB-571, quote-reply.ts): the message quoted above the composer. */
export const REPLY: MenuAction = { name: 'reply', label: 'Reply' };
export const COPY: MenuAction = { name: 'copy', label: 'Copy' };
export const SHARE: MenuAction = { name: 'share', label: 'Share' };
export const RENAME: MenuAction = { name: 'rename', label: 'Rename' };
export const ARCHIVE: MenuAction = { name: 'archive', label: 'Archive' };
export const DELETE: MenuAction = { name: 'delete', label: 'Delete', destructive: true };

/** A reply's button that opens its menu (its links stay reachable one by one). */
export const MORE = 'More';
/** The action row's Copy once it copied, for 2 s (the web's MessageActions). */
export const COPIED = 'Copied';
export const COPIED_MS = 2000;
export const CANCEL = 'Cancel';
export const SAVE = 'Save';
export const CHAT_ARCHIVED = 'Chat archived';
export const UNDO = 'Undo';
export const RENAME_TITLE = 'Rename chat';
export const RENAME_LABEL = 'Chat title';
export const DELETE_TITLE = 'Delete chat?';
/** How long the undo toast stays. */
export const TOAST_MS = 5000;

/** The web's sentence: "This will delete “Plans”." */
export const deleteSentence = (title: string) => `This will delete “${title}”.`;

const REACT = 'react:';

/** A message's menu: Reply where it can be quoted (CB-571), Copy and Share, and a stored reply's reactions. */
export function messageMenu(reactions: readonly ReactionButton[] | null, reply = false): MenuAction[] {
    return [
        ...(reply ? [REPLY] : []),
        COPY,
        SHARE,
        ...(reactions ?? []).map((button) => ({
            name: `${REACT}${button.kind}`,
            label: button.on ? `Remove “${button.label}”` : button.label,
        })),
    ];
}

/** What the action row under a message holds: its reactions, or null for Copy and the time only. */
export interface MessageRowActions {
    readonly reactions: readonly ReactionButton[] | null;
}

/**
 * The action row under a message (the web's MessageView and MessageActions;
 * owner, 2026-11-18: under every message, not only the newest reply): Copy,
 * then a socio's stored reply's four reactions, then the time. None while a
 * reply is still being written, or under a message with no words (files
 * only). The person's own messages have Copy and the time.
 */
export function messageRowActions(
    row: {
        readonly kind: 'user' | 'reply';
        readonly text: string;
        readonly streaming?: boolean;
        readonly stored?: boolean;
    },
    reactions: (() => readonly ReactionButton[]) | null,
): MessageRowActions | null {
    if (row.streaming === true || row.text.trim() === '') {
        return null;
    }
    return { reactions: row.kind === 'reply' && row.stored === true && reactions !== null ? reactions() : null };
}

/** The reaction a menu action toggles, or null. */
export function reactionOf(name: string): ReactionKind | null {
    return name.startsWith(REACT) ? (name.slice(REACT.length) as ReactionKind) : null;
}

/** A chat row's menu: none for a room. */
export function chatRowMenu(row: { readonly room: boolean }): MenuAction[] {
    return row.room ? [] : [RENAME, ARCHIVE, DELETE];
}

/** React Native's accessibility actions for a menu. */
export const accessibilityActionsOf = (actions: readonly MenuAction[]) =>
    actions.map(({ name, label }) => ({ name, label }));

/**
 * The overlays of `collection` that take effect, oldest first: a refused one
 * (`unsent`) lays nothing, and neither does any later one with its key, which
 * waits behind it in its lane until the person retries or discards it.
 */
export function effectiveOverlays(overlays: readonly OverlayItem[], collection: string): OverlayItem[] {
    const blocked = new Set<string>();
    return overlays.filter((item) => {
        if (item.collection !== collection || item.mode !== 'patch') {
            return false;
        }
        if (item.state === 'unsent') {
            blocked.add(item.key);
        }
        return !blocked.has(item.key);
    });
}

/**
 * The chats with this device's renames, archives and deletes laid over, as
 * the outbox holds them (chat-manage.ts's overlays, oldest first): a refused
 * one, and what waits behind it, lays nothing (`effectiveOverlays`), so the
 * row shows what the server has, and `notSaved` says so.
 */
export function withChatWrites(chats: readonly Conversation[], overlays: readonly OverlayItem[]): Conversation[] {
    const changes = new Map<
        string,
        { title?: string; archived?: boolean; deleted?: boolean; unread?: number; inference?: ModelChoice | null }
    >();
    for (const item of effectiveOverlays(overlays, 'conversations')) {
        changes.set(item.key, { ...changes.get(item.key), ...(item.value as object) });
    }
    if (changes.size === 0) {
        return chats as Conversation[];
    }
    return chats.flatMap((chat) => {
        const change = changes.get(chat.id);
        if (change === undefined) {
            return [chat];
        }
        if (change.deleted === true) {
            return [];
        }
        const next: Conversation = { ...chat, ...(change.title === undefined ? {} : { title: change.title }) };
        if (change.inference !== undefined) {
            // The chat's model (the header's picker): shown at once.
            next.inference = change.inference;
        }
        if (change.unread !== undefined) {
            // A room's read mark: its count clears at once.
            next.unread = change.unread;
        }
        if (change.archived === true) {
            // Its own time isn't known yet: any number marks it archived.
            next.archivedAt = chat.archivedAt ?? chat.createdAt;
        } else if (change.archived === false) {
            delete next.archivedAt;
        }
        return [next];
    });
}

export const RETRY = 'Retry';
export const DISCARD = 'Discard';
export const REACTION_NOT_SAVED = 'Couldn’t save your reaction.';

/** A refused write the screen shows, with Retry and Discard (the outbox's `retryUnsent` and `discardUnsent`). */
export interface NotSaved {
    /** The unsent write's id. */
    readonly id: string;
    readonly text: string;
}

/** What a refused rename, archive or delete of a chat says. */
function chatNotSaved(
    change: { title?: string; archived?: boolean; deleted?: boolean; inference?: unknown },
    title: string,
): string {
    if (change.deleted === true) {
        return `Couldn’t delete “${title}”.`;
    }
    if (change.inference !== undefined && change.title === undefined && change.archived === undefined) {
        return `Couldn’t change the model of “${title}”.`;
    }
    if (change.title !== undefined && change.archived !== undefined) {
        return `Couldn’t change “${title}”.`;
    }
    if (change.title !== undefined) {
        return `Couldn’t rename “${title}”.`;
    }
    return change.archived === false ? `Couldn’t bring back “${title}”.` : `Couldn’t archive “${title}”.`;
}

/**
 * The refused writes among `overlays` (chat-manage.ts's), oldest first: a
 * chat's renames, archives and deletes (`chats` name them, as the server has
 * them), or a chat's reactions when `threadId` is given.
 */
export function notSaved(
    overlays: readonly OverlayItem[],
    target: { readonly chats: readonly Conversation[] } | { readonly threadId: string },
): NotSaved[] {
    return overlays.flatMap((item) => {
        if (item.state !== 'unsent' || item.mode !== 'patch') {
            return [];
        }
        if ('threadId' in target) {
            return item.collection === 'reactions' && item.key.startsWith(`${target.threadId}/`)
                ? [{ id: item.id, text: REACTION_NOT_SAVED }]
                : [];
        }
        if (item.collection !== 'conversations') {
            return [];
        }
        const chat = target.chats.find((candidate) => candidate.id === item.key);
        const title = typeof chat?.title === 'string' && chat.title !== '' ? chat.title : 'this chat';
        return [{ id: item.id, text: chatNotSaved(item.value as object, title) }];
    });
}
