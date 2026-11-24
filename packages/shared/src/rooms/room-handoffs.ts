/**
 * Handoffs between socios in a room (CB-206): one person's message, and
 * the work it starts, may pass from one of the room's socios to another,
 * in the same work cycle, as the same person, under the same limits. Two
 * ways: a socio hands the work on (`hand_off`, with a reason everyone in
 * the room reads), or the person's message names several socios, who
 * answer one after another in the order it names them. Both count against
 * the cycle's handoffs (Settings → General → Work per message, 4 by
 * default; a room admin may only lower it) and neither may go round in a
 * loop. Types and pure rules only.
 */

/** A socio's own handoff, or the next socio a person's message named. */
export const HANDOFF_KINDS = ['handoff', 'mention'] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];

/**
 * `pending` until its step starts (`started`); `dropped` when the cycle
 * could not carry on to it (stopped, failed, a limit, the person or the
 * socio no longer in the room).
 */
export const HANDOFF_STATUSES = ['pending', 'started', 'dropped'] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

/** The longest reason a socio gives, in characters. */
export const HANDOFF_REASON_MAX = 300;

/** One step from a socio to the next in a cycle: its edge for the loop rule. */
export interface HandoffEdge {
    /** The socio handing on, or the one a named socio answers after. */
    from: string;
    to: string;
    /** Not started yet: `to` answers later in the cycle. */
    pending?: boolean;
}

/** Why a handoff is refused, before or as it would start. */
export type HandoffRefusal = 'self' | 'not_in_room' | 'limit' | 'loop' | 'queued' | 'one_per_step' | 'no_cycle';

/** What the socio is told when its handoff is refused (its tool result). */
export const HANDOFF_REFUSAL_MESSAGES: Record<HandoffRefusal, string> = {
    self: 'You can’t hand off to yourself.',
    not_in_room: 'That socio isn’t in this room now. Only the room’s socios can take a handoff.',
    limit: 'This message has used all the handoffs it may: answer it yourself, and say what is left to do.',
    loop: 'You already handed this message’s work to that socio once: no handing back and forth. Answer it yourself.',
    queued: 'That socio already answers this message after you.',
    one_per_step: 'You already handed this message on: one handoff per reply.',
    no_cycle: 'Handoffs work only while you answer a person’s message in a room.',
};

/**
 * Whether the next handoff may happen, given the cycle's earlier and
 * pending ones (`path`, in order) and its limit: never to the socio
 * handing on, never to one that answers later in the cycle anyway, never
 * the same socio to the same socio twice in one cycle (so two socios
 * can't bounce work between them: A to B, B to A, then A to B again is
 * refused, and no longer ring goes round twice either), and never past
 * the limit, which each handoff and each further named socio counts
 * against.
 */
export function handoffRefusal(
    path: readonly HandoffEdge[],
    next: Pick<HandoffEdge, 'from' | 'to'>,
    limit: number,
): HandoffRefusal | undefined {
    if (next.from === next.to) {
        return 'self';
    }
    if (path.some((edge) => edge.pending && edge.to === next.to)) {
        return 'queued';
    }
    if (path.some((edge) => edge.from === next.from && edge.to === next.to)) {
        return 'loop';
    }
    if (path.length + 1 > limit) {
        return 'limit';
    }
    return undefined;
}

// ---- The note a handed-on step starts with -----------------------------------

/**
 * The note the next socio's step starts with: a person-role message the
 * server writes (as an approval's note, CB-58), marked by its id prefix and
 * metadata. The markers only control rendering: the transcript shows it as
 * a line between replies, never as anyone's message.
 */
export const handoffNoteSource = 'room_handoff';
export const handoffNoteMessagePrefix = 'socio:room_handoff:';
/** The metadata key of the handoff a note starts (`HandoffNoteMeta`). */
export const HANDOFF_METADATA = 'socioHandoff';

/** What a handoff note records: ids and the reason, as the room reads it. */
export interface HandoffNoteMeta {
    kind: HandoffKind;
    /** The socio that handed on, or answered before a named one. */
    from: string;
    to: string;
    /** The socio's reason (a handoff); empty for a named socio. */
    reason: string;
    /** Whose message named the socio (a mention), by id. */
    by?: string;
}

/** The handoff a note starts, when the message is one. */
export function handoffOf(message: { id?: unknown; role?: unknown; metadata?: unknown }): HandoffNoteMeta | undefined {
    if (message.role !== undefined && message.role !== 'user') {
        return undefined;
    }
    const metadata = message.metadata as Record<string, unknown> | undefined;
    if (!metadata || typeof metadata !== 'object' || metadata.socioSource !== handoffNoteSource) {
        return undefined;
    }
    const meta = metadata[HANDOFF_METADATA] as Partial<HandoffNoteMeta> | null;
    if (
        !meta ||
        typeof meta !== 'object' ||
        !HANDOFF_KINDS.includes(meta.kind as HandoffKind) ||
        typeof meta.from !== 'string' ||
        typeof meta.to !== 'string'
    ) {
        return undefined;
    }
    return {
        kind: meta.kind as HandoffKind,
        from: meta.from,
        to: meta.to,
        reason: typeof meta.reason === 'string' ? meta.reason : '',
        ...(typeof meta.by === 'string' ? { by: meta.by } : {}),
    };
}

/** Whether a message is a handoff note (by its marker or its metadata). */
export const isHandoffNote = (message: { id?: unknown; role?: unknown; metadata?: unknown }) =>
    (typeof message.id === 'string' && message.id.startsWith(handoffNoteMessagePrefix)) || !!handoffOf(message);

/**
 * A handoff as the room's transcript gives it (`/transcript`): who handed
 * on to whom, by name, and why. Shown as a line between the replies.
 */
export interface TranscriptHandoff {
    kind: HandoffKind;
    from: { id: string; name: string };
    to: { id: string; name: string };
    reason: string;
    /** The person whose message named the socio (a mention). */
    byName?: string;
}

/** The line the room reads for a handoff. */
export function handoffLine(handoff: TranscriptHandoff): string {
    if (handoff.kind === 'mention') {
        return `${handoff.to.name} answers next${handoff.byName ? `, as ${handoff.byName} asked` : ''}.`;
    }
    return `${handoff.from.name} handed this to ${handoff.to.name}${handoff.reason ? `: ${handoff.reason}` : '.'}`;
}
