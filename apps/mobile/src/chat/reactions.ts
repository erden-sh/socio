import {
    type MessageReactions,
    OPPOSITE,
    REACTION_LABELS,
    REACTIONS,
    type ReactionKind,
    type ReactionsView,
} from '@socio/shared/chat/reactions';

import type { OverlayItem } from '../sync/outbox-overlay';

import { effectiveOverlays } from './long-press';

// Reactions on a socio's replies as the chat shows them (CB-133, the
// web's use-reactions and MessageReactions): the scope's view of the chat
// (src/sync/reactions.ts) with the outbox's reaction rows not yet answered
// laid over in order, so a tap shows at once, offline too, and a refused one
// goes back. Up and down exclude each other. A count shows beside a reaction
// when others see the chat or more than one person gave it. No React Native
// here: tests/chat runs it under Node.

const NONE: MessageReactions = { counts: {}, mine: [] };

/** `view` with the reader's `kind` on the message added or taken back (the web's `withReaction`). */
export function withReaction(view: ReactionsView, messageId: string, kind: ReactionKind, add: boolean): ReactionsView {
    const current = view.messages[messageId] ?? NONE;
    const counts = { ...current.counts };
    let mine = current.mine;
    const drop = (gone: ReactionKind) => {
        if (!mine.includes(gone)) {
            return;
        }
        mine = mine.filter((item) => item !== gone);
        counts[gone] = (counts[gone] ?? 1) - 1;
        if (!counts[gone]) {
            delete counts[gone];
        }
    };
    if (add) {
        const opposite = OPPOSITE[kind];
        if (opposite) {
            drop(opposite);
        }
        if (!mine.includes(kind)) {
            mine = [...mine, kind];
            counts[kind] = (counts[kind] ?? 0) + 1;
        }
    } else {
        drop(kind);
    }
    const messages = { ...view.messages };
    if (mine.length || Object.keys(counts).length) {
        // The reader's report stays while their thumbs-down does (CB-382, the web's).
        const report = mine.includes('down') ? current.report : undefined;
        messages[messageId] = report === undefined ? { counts, mine } : { counts, mine, report };
    } else {
        delete messages[messageId];
    }
    return { ...view, messages };
}

/**
 * The view with this chat's reaction writes still on the phone laid over,
 * oldest first; a refused one isn't, nor what waits behind it on that message.
 */
export function reactionsShown(view: ReactionsView, overlays: readonly OverlayItem[], threadId: string): ReactionsView {
    const prefix = `${threadId}/`;
    let shown = view;
    for (const item of effectiveOverlays(overlays, 'reactions')) {
        if (!item.key.startsWith(prefix)) {
            continue;
        }
        const { reaction, on } = item.value as { reaction: ReactionKind; on: boolean };
        shown = withReaction(shown, item.key.slice(prefix.length), reaction, on);
    }
    return shown;
}

export interface ReactionButton {
    readonly kind: ReactionKind;
    readonly label: string;
    /** The reader gave it. */
    readonly on: boolean;
    /** The count beside it, or null when it isn't shown. */
    readonly count: number | null;
    /** What a screen reader says: "Good reply, 2". */
    readonly accessibilityLabel: string;
}

/** A reply's four reaction buttons, in the web's order. */
export function reactionButtons(view: ReactionsView, messageId: string): ReactionButton[] {
    const current = view.messages[messageId] ?? NONE;
    return REACTIONS.map((kind) => {
        const count = current.counts[kind] ?? 0;
        const shown = count > 0 && (view.shared || count > 1);
        const label = REACTION_LABELS[kind];
        return {
            kind,
            label,
            on: current.mine.includes(kind),
            count: shown ? count : null,
            accessibilityLabel: shown ? `${label}, ${count}` : label,
        };
    });
}

/** Whether a reply has any reaction: its row of buttons then stays under it (the web's `pinned`). */
export const hasReactions = (view: ReactionsView, messageId: string) => view.messages[messageId] !== undefined;

/** What a screen reader hears after a toggle. */
export const reactionSaid = (kind: ReactionKind, on: boolean) => `${REACTION_LABELS[kind]} ${on ? 'removed' : 'added'}`;
