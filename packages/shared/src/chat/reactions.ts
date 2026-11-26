/**
 * Reactions on a Dot's messages (CB-133): a small fixed set, as quick
 * feedback without writing a reply. Each person may add or remove each
 * one; a thumbs up and a thumbs down exclude each other. They reach the
 * Dot on its next turn as one short structured note, and the Learning
 * analysis reads them as evidence.
 */
import type { ReportMark } from './reply-reports.js';

export const REACTIONS = ['up', 'down', 'retry', 'needs-work'] as const;
export type ReactionKind = (typeof REACTIONS)[number];

export const isReactionKind = (value: unknown): value is ReactionKind =>
    (REACTIONS as readonly unknown[]).includes(value);

/** What people read, and what a screen reader says. */
export const REACTION_LABELS: Record<ReactionKind, string> = {
    up: 'Good reply',
    down: 'Bad reply',
    retry: 'Try again',
    'needs-work': 'Needs work',
};
/** How the Dot's note and the Learning evidence write each one. */
export const REACTION_EMOJI: Record<ReactionKind, string> = {
    up: '👍',
    down: '👎',
    retry: '🔁',
    'needs-work': '🛠',
};

/** Up and down contradict each other: adding one removes the other. */
export const OPPOSITE: Partial<Record<ReactionKind, ReactionKind>> = {
    up: 'down',
    down: 'up',
};

/** One message's reactions, as the reader sees them. */
export interface MessageReactions {
    /** How many people gave each. */
    counts: Partial<Record<ReactionKind, number>>;
    /** The reader's own. */
    mine: ReactionKind[];
    /** The reader's own report on this reply, if they made one (CB-382). */
    report?: ReportMark;
}

/** `GET /api/conversations/:id/reactions`: the messages that have any. */
export interface ReactionsView {
    /** More than one person can see this chat (a team or Telegram topic). */
    shared: boolean;
    messages: Record<string, MessageReactions>;
}

/** A message id, as in the app's paths. */
export const REACTION_MESSAGE_ID = /^[\w.:-]{1,128}$/;
