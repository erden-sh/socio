import type { Message } from '@ag-ui/core';

import type { HistoryRun } from '../chat/chat-history.js';
import type { RoomEvent, RoomMemberStatus, RoomRole } from '../rooms/rooms.js';
import type { MessageAuthor } from '../types.js';

/**
 * Operations' access log and transcript view (CB-188): admins see
 * everything the workspace does, chats' content included, and each time
 * one opens a person's activity or a chat's content it is written down
 * for every admin to see. What the client and the server share about it.
 */

/** What an entry is about: a person, a chat, a socio, a turn, a Space, or the whole workspace's rows. */
export const ACCESS_SUBJECT_KINDS = ['person', 'chat', 'socio', 'run', 'space', 'workspace'] as const;
export type AccessSubjectKind = (typeof ACCESS_SUBJECT_KINDS)[number];

/**
 * Where a view was opened: one per audited endpoint. Sections add theirs;
 * the log shows an unknown one as it is stored.
 */
export const ACCESS_SURFACE_LABELS: Record<string, string> = {
    turns: 'Turns list',
    chat: 'Chat transcript',
    // An admin's open of another person's turn trace, in Runs or Reliability.
    trace: 'Turn trace',
    // Activity and Value (CB-190): a person's view, and their lists.
    activity: 'Activity, for one person',
    value: 'Value, for one person',
    'activity-people': 'Activity: people',
    'activity-socios': 'Activity: socios',
    'activity-chats': 'Activity: chats',
    'value-sessions': 'Value: sessions',
    // Reliability (CB-189), Health (CB-192) and Knowledge (CB-191).
    failures: 'Reliability: recent failures',
    // A failure's labels and the text its classifier reads (CB-198).
    'failure-label': 'Reliability: a failure’s label',
    health: 'Health, tokens by person',
    'health-schedules': 'Health: schedules',
    'health-long-runs': 'Health: long runs',
    'knowledge-datasets': 'Knowledge: datasets',
    // What a chat's turns read (CB-194).
    'chat-grounding': 'Chat grounding',
    // Cost (CB-195): spend by person.
    cost: 'Cost, by person',
    // Themes (CB-199): one person's themes, and the review of sessions'
    // labels with the scrubbed words the model reads.
    themes: 'Themes, for one person',
    'session-labels': 'Themes: sessions to review',
    'session-label': 'Themes: a session’s labels',
    // A room's own audit (CB-213): who joined, left, was refused, never content.
    'room-events': 'Room audit',
};

/** A list view logs once per viewer, endpoint and filters in this long. */
export const ACCESS_LOG_DEDUPE_MS = 15 * 60_000;

/**
 * `?via=` on a link into an audited view: the page it was opened from
 * (an Operations section's id), kept with the entry.
 */
export const ACCESS_VIA = /^[a-z][a-z0-9-]{0,39}$/;

/** An entry of Operations → Access log, with the names it is shown by. */
export interface OpsAccessRow {
    id: string;
    at: number;
    viewerId: string;
    viewerName: string | null;
    surface: string;
    subjectKind: AccessSubjectKind;
    /** None for a view of the whole workspace's rows. */
    subjectId: string | null;
    /** The subject's name, or a chat's title; null when it's gone. */
    subjectName: string | null;
    /** The view showed content (a chat's messages), not only who and when. */
    content: boolean;
    /** The range and filters it was opened with, and `via`. */
    filters: Record<string, string>;
    /**
     * The names of the socio, person and Space in `filters`, as the subject's
     * are resolved; null when one is gone.
     */
    filterNames: Partial<Record<AccessNamedFilter, string | null>>;
    requestId: string;
}

/**
 * The filters that hold an id, named in the log by what they point at.
 * `room` and `initiator` are no list's filters but what an entry about a
 * room's content says of it (`ACCESS_ROOM_CONTEXT`).
 */
export const ACCESS_NAMED_FILTERS = ['socio', 'person', 'space', 'room', 'initiator'] as const;
export type AccessNamedFilter = (typeof ACCESS_NAMED_FILTERS)[number];

/**
 * What an entry about a room's content keeps beside its subject (CB-213),
 * in its `filters`: `room`, the room's id, on every view of
 * a room (its transcript, grounding and audit, a turn's trace); and on a
 * turn's trace, `initiator`, the person whose message started its work
 * cycle, and `socio`, the socio that ran it. Ids only: the log names them
 * as it shows them, and a workspace admin never reads a room any other way.
 */
export const ACCESS_ROOM_CONTEXT = ['room', 'initiator', 'socio'] as const;
export type AccessRoomContext = Partial<Record<(typeof ACCESS_ROOM_CONTEXT)[number], string>>;

/** How the log says what isn't one of Operations' own filters. */
export const ACCESS_CONTEXT_LABELS: Record<string, string> = {
    room: 'Room',
    initiator: 'Started by',
};

/** A chat as its admin transcript view heads it. */
export interface OpsChatView {
    id: string;
    title: string;
    socioId: string;
    socioName: string | null;
    ownerId: string;
    /** The owner's name; for a team topic, the team's. */
    ownerName: string | null;
    createdAt: number;
    archivedAt: number | null;
    /** A shared Telegram forum topic: several people write in it. */
    team: boolean;
    /**
     * A room (CB-213): its people now, by name and role, and who made or
     * converted it; null for any other chat. A room's `ownerId` is its
     * sentinel (`room:<id>`), no person, so `ownerName` is null.
     */
    room: OpsRoomHeading | null;
}

/** A room as the admin transcript heads it (CB-213). */
export interface OpsRoomHeading {
    /** Its active members, admins first, then the invites still open. */
    members: Array<{
        name: string;
        role: RoomRole;
        status: Extract<RoomMemberStatus, 'active' | 'invited'>;
    }>;
    /** The socios in it now, the lead first. */
    socios: Array<{ name: string; lead: boolean }>;
    /** Who made it, or converted their chat into it; null when unknown. */
    createdByName: string | null;
    /** When a private chat became this room; null for one made as a room. */
    convertedAt: number | null;
}

/**
 * A line of a room's audit (`room_events`) as Operations shows it
 * (CB-213): who did what to whom, by name, and whether it was refused.
 * Names and reasons only, never content; never the people's ids.
 */
export interface OpsRoomEvent {
    id: number;
    at: number;
    /** A person's or socio's name; `Socio` for the server itself. */
    actorName: string;
    action: RoomEvent['action'];
    targetKind: RoomEvent['targetKind'];
    /** The person, socio or room it was about, by name; null when gone. */
    targetName: string | null;
    outcome: RoomEvent['outcome'];
    /** Names of what changed, or a refusal's `action: reason`. */
    detail: string;
}

/** `GET /operations/chats/:threadId/room-events`: newest first. */
export interface OpsRoomAudit {
    events: OpsRoomEvent[];
}

/**
 * A finished turn of the admin transcript view. Each person's message
 * says who wrote it, as the server resolved it, in `metadata.author`
 * (`messageAuthor`): several people write in a team topic. Never their
 * account ids.
 */
export interface OpsTranscriptRun extends Omit<HistoryRun, 'messages'> {
    messages: (Message & { metadata?: { author?: MessageAuthor } & Record<string, unknown> })[];
}

/** A page of a chat's finished turns, newest first (`CursorPage`). */
export interface OpsChatHistoryPage {
    items: OpsTranscriptRun[];
    next: string | null;
}
