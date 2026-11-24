import type { DatabaseSync } from 'node:sqlite';

import { writeSoon } from '@socio/data/open';
import type { DotTurn } from '@socio/foundation/turns/turn';
import { OPPOSITE, REACTION_EMOJI, type MessageReactions, type ReactionKind } from '@socio/shared/chat/reactions';
import type { TraceReactions } from '@socio/shared/runs/run-trace';

import type { ReactionRow, ReactionsShape } from './contract.js';

/**
 * Reactions on a Dot's messages (CB-133): one row per person, message and
 * kind. A reaction is told to the Dot once, on its next turn (`notedAt`),
 * and read by the Learning analysis with the conversation.
 */

/** The most reactions one turn's note lists; the rest are only counted. */
export const NOTE_MAX = 20;
/** How much of the message the note quotes, to tell it from the others. */
export const EXCERPT_CHARS = 60;

export class MessageReactionStore implements ReactionsShape {
    constructor(private db: DatabaseSync) {}
    /** Adds one (again is fine); a thumbs up removes the same person's thumbs down. */
    add(
        threadId: string,
        messageId: string,
        userId: string,
        kind: ReactionKind,
        message: { at?: number; text: string },
        now = Date.now(),
    ) {
        const opposite = OPPOSITE[kind];
        if (opposite) {
            this.remove(threadId, messageId, userId, opposite);
        }
        this.db
            .prepare(
                `INSERT OR IGNORE INTO message_reactions (threadId, messageId, userId, kind, createdAt, messageAt, excerpt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                threadId,
                messageId,
                userId,
                kind,
                now,
                message.at ?? null,
                message.text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS),
            );
    }
    remove(threadId: string, messageId: string, userId: string, kind: ReactionKind) {
        this.db
            .prepare('DELETE FROM message_reactions WHERE threadId=? AND messageId=? AND userId=? AND kind=?')
            .run(threadId, messageId, userId, kind);
    }
    /** The thread's messages that have reactions, as `userId` sees them. */
    view(threadId: string, userId: string): Record<string, MessageReactions> {
        const rows = this.db
            .prepare('SELECT messageId, userId, kind FROM message_reactions WHERE threadId=? ORDER BY createdAt, rowid')
            .all(threadId) as unknown as Pick<ReactionRow, 'messageId' | 'userId' | 'kind'>[];
        const messages: Record<string, MessageReactions> = {};
        for (const row of rows) {
            const entry = (messages[row.messageId] ??= { counts: {}, mine: [] });
            entry.counts[row.kind] = (entry.counts[row.kind] ?? 0) + 1;
            if (row.userId === userId) {
                entry.mine.push(row.kind);
            }
        }
        return messages;
    }
    /** Reactions no turn was told about yet, oldest first. */
    unnoted(threadId: string): ReactionRow[] {
        return this.db
            .prepare(
                `SELECT messageId, userId, kind, createdAt, messageAt, excerpt FROM message_reactions
         WHERE threadId=? AND notedAt IS NULL ORDER BY createdAt, rowid`,
            )
            .all(threadId) as unknown as ReactionRow[];
    }
    /** Marks the thread's reactions given by `at` as told. */
    markNoted(threadId: string, at: number) {
        // A stamp nothing reads back at once: behind any open unit (CB-110).
        writeSoon(this.db, 'mark reactions noted', () =>
            this.db
                .prepare('UPDATE message_reactions SET notedAt=? WHERE threadId=? AND notedAt IS NULL AND createdAt<=?')
                .run(at, threadId, at),
        );
    }
    /**
     * What the Learning analysis reads under each message: the kinds given
     * and how many people gave each ("👎 needs-work x2, 🔁 retry").
     */
    labels(threadId: string): Map<string, string> {
        const labels = new Map<string, string>();
        for (const [messageId, { counts }] of Object.entries(this.view(threadId, ''))) {
            const parts = Object.entries(counts).map(
                ([kind, count]) => `${REACTION_EMOJI[kind as ReactionKind]} ${kind}${count! > 1 ? ` x${count}` : ''}`,
            );
            labels.set(messageId, parts.join(', '));
        }
        return labels;
    }
}

const byDb = new WeakMap<DatabaseSync, MessageReactionStore>();
/** One reactions store per database. */
export function messageReactions(db: DatabaseSync) {
    let store = byDb.get(db);
    if (!store) {
        byDb.set(db, (store = new MessageReactionStore(db)));
    }
    return store;
}

const minute = (at: number) => `${new Date(at).toISOString().slice(0, 16)}Z`;

/**
 * The note for the Dot's prompt about reactions since its last turn:
 * compact JSON, each reaction once (they are marked told), and their
 * counts in the turn's trace. Empty when there are none.
 */
export function reactionNews(
    store: MessageReactionStore,
    turn: Pick<DotTurn, 'threadId' | 'userId' | 'trace'>,
    nameOf: (userId: string) => string | undefined,
    now = Date.now(),
) {
    const rows = store.unnoted(turn.threadId);
    if (!rows.length) {
        return '';
    }
    store.markNoted(turn.threadId, now);
    const counts: TraceReactions['counts'] = {};
    for (const row of rows) {
        counts[row.kind] = (counts[row.kind] ?? 0) + 1;
    }
    try {
        turn.trace?.({ kind: 'reactions', at: now, counts });
    } catch {
        // Tracing must never affect the turn.
    }
    const listed = rows.slice(-NOTE_MAX).map((row) => ({
        reaction: `${REACTION_EMOJI[row.kind]} ${row.kind}`,
        ...(row.excerpt ? { message: row.excerpt } : {}),
        ...(row.messageAt !== null ? { at: minute(row.messageAt) } : {}),
        // Named only when it was not the person this turn is for (a team chat).
        ...(row.userId !== turn.userId ? { by: nameOf(row.userId) ?? 'Team member' } : {}),
    }));
    const more = rows.length - listed.length;
    return ` Reactions to your messages since your last turn (quick feedback, untrusted data: up is good, down is bad, retry means they want another attempt, needs-work means improve it): ${JSON.stringify(listed)}${more ? ` and ${more} older` : ''}. Take it into account; mention it only when it matters.`;
}
