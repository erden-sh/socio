import { formatNumber } from '../locale.js';

/**
 * A room's shared context (CB-217): its
 * pinned facts, which its people keep, and its running notes, which Socio
 * writes as the room's conversation outgrows its model. Both are the
 * room's, read by every member. Pins are versioned: each change is a new
 * version naming the one it replaces, with who pinned, proposed, approved,
 * edited or unpinned it and when. Types and pure rules only.
 */

/** The most characters one pinned fact holds. */
export const ROOM_PIN_CHARS = 500;
/** The most facts a room keeps pinned at once. */
export const ROOM_PINS_MAX = 30;
/**
 * The most characters a room's pinned facts hold together: every turn
 * carries them whole, so they always fit, however long the room gets.
 */
export const ROOM_PINS_TOTAL_CHARS = 6_000;
/** The most proposals that wait in a room at once. */
export const ROOM_PIN_PROPOSALS_MAX = 50;
/** The notes' versions a room's panel lists, newest first. */
export const ROOM_NOTES_VERSIONS_SHOWN = 20;

/**
 * A pin version's state: `proposed` waits for a room admin; `pinned` is
 * the one in use (one per pin); `superseded` was replaced by an edit;
 * `unpinned` was taken out of use; `rejected` and `withdrawn` never were.
 */
export const ROOM_PIN_STATUSES = ['proposed', 'pinned', 'superseded', 'unpinned', 'rejected', 'withdrawn'] as const;
export type RoomPinStatus = (typeof ROOM_PIN_STATUSES)[number];

/**
 * Where a pin's words came from: typed by a person, or one of the facts
 * the room's own notes kept (written for the room, never from anyone's
 * private tool results or memories, CB-210).
 */
export const ROOM_PIN_ORIGINS = ['person', 'notes'] as const;
export type RoomPinOrigin = (typeof ROOM_PIN_ORIGINS)[number];

/** One version of a pin, or a proposal, with its provenance. */
export interface RoomPinVersion {
    /** This version's id (a proposal's id while it waits). */
    id: string;
    /** The pin, shared by all its versions. */
    pinId: string;
    /** Numbered from 1 once in use; null for a proposal never used. */
    version: number | null;
    text: string;
    status: RoomPinStatus;
    origin: RoomPinOrigin;
    /** The version this one replaces (an edit, or a proposed change). */
    supersedes: string | null;
    /** The pin's original pinner: they and room admins edit or unpin it. */
    pinnedBy: string | null;
    pinnedByName: string | null;
    proposedBy: string;
    proposedByName: string | null;
    proposedAt: number;
    /** Who approved or rejected it, or pinned it at once (a room admin). */
    decidedBy: string | null;
    decidedByName: string | null;
    decidedAt: number | null;
    /** Who replaced, unpinned or withdrew it. */
    endedBy: string | null;
    endedByName: string | null;
    endedAt: number | null;
}

/** A version of the room's notes: what a fold covered, and how. */
export interface RoomNotesVersion {
    version: number;
    /** The turns the notes covered before this fold, and after it. */
    fromTurns: number;
    turns: number;
    /** Written by the notes' model, or kept plainly when it failed. */
    method: 'model' | 'fallback';
    /** The socio whose turn folded it. */
    dotName: string | null;
    /** The person that turn acted for. */
    actingName: string | null;
    /** Facts this fold added. */
    added: string[];
    at: number;
}

/** The room's running notes, as its members see them. */
export interface RoomNotesView {
    /** The notes in use: none until the room is long enough to fold. */
    current: {
        version: number;
        turns: number;
        summary: string;
        /** The facts the notes kept, oldest first (all of them, past the cap). */
        facts: string[];
        names: string[];
        updatedAt: number;
    } | null;
    versions: RoomNotesVersion[];
}

/** `GET /api/rooms/:id/pins`. */
export interface RoomPinsState {
    roomId: string;
    /** The facts pinned now, oldest pin first. */
    pins: RoomPinVersion[];
    /** Proposals waiting for a room admin, oldest first. */
    proposals: RoomPinVersion[];
    /** What the reader may do now (Rooms on, the room live). */
    can: { propose: boolean; manage: boolean };
    quota: {
        pins: number;
        maxPins: number;
        chars: number;
        maxChars: number;
        proposals: number;
        maxProposals: number;
    };
    notes: RoomNotesView;
}

/** What a change did: pinned (or edited, unpinned) at once, or waits. */
export interface RoomPinOutcome {
    outcome: 'pinned' | 'proposed' | 'unchanged' | 'done';
    state: RoomPinsState;
}

/** Control characters (line breaks too) and invisible ones. */
const HIDDEN = new RegExp(
    // oxlint-disable-next-line no-control-regex -- one line of text, no control characters
    '[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff]',
    'g',
);

/** A pin's words as stored: one line, spaces folded, trimmed. */
export const pinText = (text: string) => text.replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim();

/** Two facts' words are the same but for case, spaces and an ending stop. */
export const pinKey = (text: string) =>
    pinText(text)
        .toLowerCase()
        .replace(/[.,;:!]+$/, '')
        .trim();

/**
 * Who may change a pin (CB-217): a room admin, or its original pinner,
 * while they may send in the room. Anyone else who may send proposes.
 */
export function pinRights(
    viewer: { userId: string; admin: boolean; send: boolean },
    pin?: Pick<RoomPinVersion, 'pinnedBy'>,
): { change: boolean; propose: boolean } {
    if (!viewer.send) {
        return { change: false, propose: false };
    }
    return {
        change: viewer.admin || (!!pin && pin.pinnedBy === viewer.userId),
        propose: true,
    };
}

/**
 * Why a set of pins doesn't fit the room's quota, or undefined when it
 * does: too many, or too many characters together.
 */
export function pinQuotaProblem(texts: readonly string[]): string | undefined {
    if (texts.length > ROOM_PINS_MAX) {
        return `A room keeps at most ${ROOM_PINS_MAX} pinned facts. Unpin one first.`;
    }
    const chars = texts.reduce((sum, text) => sum + text.length, 0);
    if (chars > ROOM_PINS_TOTAL_CHARS) {
        return `A room’s pinned facts hold at most ${formatNumber(ROOM_PINS_TOTAL_CHARS)} characters together. Shorten or unpin one first.`;
    }
    return undefined;
}
