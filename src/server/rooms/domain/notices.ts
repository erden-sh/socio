import type { RoomNotifyLevel } from '@socio/shared/rooms/room-notices';

import type { StoredRoomMention } from '../contract.js';

/**
 * Rooms' notifications (CB-216): each member's level per room, the people
 * each message mentions, and the notices sent (one per person and cause).
 */
export interface RoomNoticeRepository {
    /** The person's level in the room, if they chose one. */
    level(roomId: string, userId: string): Promise<RoomNotifyLevel | undefined>;
    /** Their levels in every room they chose one for. */
    levels(userId: string): Promise<Map<string, RoomNotifyLevel>>;
    setLevel(roomId: string, userId: string, level: RoomNotifyLevel, now: number): Promise<void>;
    /** The message's mentions become these, all `pending`. */
    replaceMentions(roomId: string, messageId: string, mentions: readonly StoredRoomMention[]): Promise<void>;
    /** The message's mentions go (the queued message was canceled). */
    forgetMentions(roomId: string, messageId: string): Promise<void>;
    /** The room's mentions still waiting for their message, oldest first. */
    pending(roomId: string): Promise<StoredRoomMention[]>;
    /** The rooms with mentions waiting, and their oldest. */
    pendingRooms(): Promise<{ roomId: string; oldest: number }[]>;
    /**
     * The message's mentions checked against it: `keep` are confirmed,
     * the rest of its pending ones go.
     */
    settle(roomId: string, messageId: string, keep: readonly string[]): Promise<void>;
    /** The room's confirmed mentions, by message. */
    confirmed(roomId: string): Promise<Map<string, StoredRoomMention[]>>;
    /**
     * Claims the notice of `cause` for the person: true the first time,
     * false after (sent already, here or by another runtime).
     */
    claim(userId: string, cause: string, roomId: string, now: number): Promise<boolean>;
    /** Forgets notices claimed before `before` (their causes don't repeat). */
    pruneClaims(before: number): Promise<void>;
}
