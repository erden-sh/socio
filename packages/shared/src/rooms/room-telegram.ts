import type { RoomPerson } from './rooms.js';

/**
 * A room's Telegram forum topic (CB-214): the
 * contract between the server's bindings and the room screens. A bound
 * topic is a group topic where socios answer (CB-145): a message there
 * from a room member, who addressed the bot, is a room turn as that
 * person; anyone else is told once why not, and nothing of theirs reaches
 * the room. Legacy team topics stay as they were until someone who reads
 * one makes it a room.
 */

/** How long a code to bind a topic works. */
export const ROOM_TOPIC_CODE_TTL_MS = 10 * 60_000;

/** The command posted in the topic with the code: `/bind@<bot> <code>`. */
export const ROOM_TOPIC_COMMAND = 'bind';

/** What `/bind` means in Telegram's command menu (group admins only). */
export const ROOM_TOPIC_COMMAND_DESCRIPTION = 'Link this topic to a Socio room, with the code from the room.';

/**
 * What the person binding a topic confirms first (`ROOM_TOPIC_AUDIENCE`):
 * everyone in the Telegram group reads what the socio says there.
 */
export const ROOM_TOPIC_AUDIENCE =
    'Everyone in the Telegram group can read the topic, including people who don’t use Socio. Room members who mention the bot there talk to the room’s socio as themselves, and its replies are posted in the topic. Messages written in the app stay in the app.';

/**
 * What a legacy topic's reader is told before making it a room: a new,
 * empty room; the old transcript stays where it is, with its readers.
 */
export const ROOM_TOPIC_CONVERT_TEXT =
    'This makes a new, empty room linked to the topic, with you as its admin. The topic’s earlier messages are not copied into it: they stay in this read-only transcript, for the people who can read it now, and nobody else gets to read them. Nobody joins the room until they accept your invitation.';

/** `POST /rooms/:id/telegram/code`, `POST /rooms/telegram/topics/:id/code`. */
export interface RoomTopicCode {
    code: string;
    expiresAt: number;
    /** What to post in the topic, the bot's name included. */
    command: string;
    /** The bot's @username, to find it in Telegram. */
    bot: string;
}

/** Why the socio did not answer someone in a bound topic. */
export type RoomTopicSenderReason = 'unlinked' | 'not_member';

/**
 * Someone who addressed the socio in the room's topic and was not
 * answered, as the room's admins see them: a linked person by name (they
 * can be invited), an unlinked account only by its public @username,
 * never attributed to anyone in Socio.
 */
export interface RoomTopicSender {
    reason: RoomTopicSenderReason;
    /** A linked person not in the room. */
    person?: RoomPerson;
    /** An unlinked account's @username, when it has one. */
    username?: string;
    lastSeenAt: number;
    seen: number;
}

/** The topic a room is (or was) bound to. */
export interface RoomTopic {
    /** `disabled`: unlinked (or the room archived); it answers no one. */
    status: 'active' | 'disabled';
    /** The forum topic's id in its group; `general` for General. */
    topicId: string;
    boundAt: number;
    boundByName: string | null;
    endedAt: number | null;
}

/** `GET /rooms/:id/telegram`: for a room's active members. */
export interface RoomTopicView {
    /** The bot runs on this server, so a topic can be bound. */
    available: boolean;
    bot: string | null;
    /** The reader's own Telegram account is linked. */
    linked: boolean;
    topic: RoomTopic | null;
    /** Admins only: who was not answered there. */
    unanswered?: RoomTopicSender[];
    /**
     * Admins only: linked people seen in the topic's group who are not in
     * the room or invited: suggestions to invite, never added by Socio.
     */
    suggested?: RoomPerson[];
}
