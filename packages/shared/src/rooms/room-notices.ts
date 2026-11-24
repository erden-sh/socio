/**
 * Rooms' notifications and presence (CB-216): what each member is told
 * about a room, through the channels they chose (Account →
 * Notifications), and who is looking at it now.
 */

/**
 * How much of a room reaches one member, their own choice per room:
 * `all` (also each turn someone else started, once per work cycle),
 * `mentions` (mentions of them, their own turns and their job reports
 * finishing while they're away; the default) or `mute` (nothing).
 */
export const ROOM_NOTIFY_LEVELS = ['all', 'mentions', 'mute'] as const;
export type RoomNotifyLevel = (typeof ROOM_NOTIFY_LEVELS)[number];
export const DEFAULT_ROOM_NOTIFY_LEVEL: RoomNotifyLevel = 'mentions';

/** The level's words, for the room's menu. */
export const ROOM_NOTIFY_CHOICES: readonly {
    level: RoomNotifyLevel;
    label: string;
    note: string;
}[] = [
    {
        level: 'all',
        label: 'Everything',
        note: 'Every reply in the room, mentions and your own turns.',
    },
    {
        level: 'mentions',
        label: 'Mentions and my turns',
        note: 'When someone mentions you, and when your own turns finish.',
    },
    { level: 'mute', label: 'Muted', note: 'Nothing from this room.' },
];

/**
 * What a notice is about: a mention of the person, a turn they started
 * finishing, a long run's report (theirs, or anyone's at `all`), other
 * people's turns, an invitation (no level: they aren't in the room yet).
 */
export type RoomNoticeKind = 'mention' | 'own_turn' | 'own_report' | 'report' | 'activity';

/** Whether a member at `level` gets a notice of `kind`. */
export function roomNoticeWanted(level: RoomNotifyLevel, kind: RoomNoticeKind) {
    if (level === 'mute') {
        return false;
    }
    if (level === 'all') {
        return true;
    }
    return kind === 'mention' || kind === 'own_turn' || kind === 'own_report';
}

/** `GET`/`PUT /api/rooms/:id/notifications`: the reader's level there. */
export interface RoomNotifySetting {
    level: RoomNotifyLevel;
}

/**
 * `GET /api/rooms/:id/presence`: the room's other active members looking
 * at it now, by name; never anyone who hides their presence, never anyone
 * outside the room.
 */
export interface RoomPresenceView {
    people: { userId: string; name: string }[];
}

/** How often an open room asks who else is looking. */
export const ROOM_PRESENCE_POLL_MS = 5_000;

/**
 * A person's choice (`UserPreferences.roomPresence`): whether a room's
 * members see when they are looking at it. Shown unless hidden.
 */
export type RoomPresencePreference = 'shown' | 'hidden';

/** A mention in a room message, as the transcript gives it to a reader. */
export interface TranscriptMention {
    name: string;
    /** The reader is the one mentioned. */
    you: boolean;
}

/** The longest preview a room notice carries. */
export const ROOM_NOTICE_PREVIEW = 280;

/** `text` cut to one preview: whitespace folded, at most `max` characters. */
export function noticePreview(text: string, max = ROOM_NOTICE_PREVIEW) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}
