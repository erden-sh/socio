import type { HandoffKind, HandoffStatus } from '@socio/shared/rooms/room-handoffs';
import type {
    ConversationKind,
    RoomLimits,
    RoomMember,
    RoomMemberStatus,
    RoomRole,
    RoomSocio,
} from '@socio/shared/rooms/rooms';

import type {
    RoomConversation,
    RoomEventsShape,
    RoomSourceBindingStatus,
    StoredRoomEvent,
    StoredRoomMember,
    StoredRoomSocio,
} from '../contract.js';

/**
 * Rooms' repositories (CB-110 layout, CB-207): one per aggregate, async,
 * plain domain types in and out. Only `rooms/infra` implements them, and
 * nothing else writes the room tables. `conversations` is the one place
 * that writes a room's `thread_bindings` row (the workspace's table), so a
 * room is made or converted in the same unit of work as its first member,
 * its lead socio and its event. Every write joins the open unit of work,
 * or opens its own.
 */

/** A room's `thread_bindings` row as a new room has it. */
export interface NewRoomConversation {
    id: string;
    /** The lead socio. */
    dotId: string;
    title: string;
    createdBy: string;
    createdAt: number;
}

export interface RoomConversationRepository {
    /** A live conversation's room fields, private ones included. */
    get(id: string): Promise<RoomConversation | undefined>;
    /** Inserts a room's row, owned by its sentinel `room:<id>`. */
    insertRoom(room: NewRoomConversation): Promise<void>;
    /**
     * Turns a live, unarchived private chat of `ownerId` into a room: its
     * sentinel owner, who converted it and when, and no Learning container.
     * False when the row is not (or no longer) that person's private chat.
     */
    convert(id: string, ownerId: string, convertedBy: string, now: number): Promise<boolean>;
    /** Live conversations per kind (the reconcile before enabling Rooms). */
    kindCounts(): Promise<Record<ConversationKind, number>>;
    /**
     * A room admin's title for a live room (CB-208): marked renamed, so a
     * generated title never replaces it. False when it is no live room.
     */
    rename(id: string, title: string): Promise<boolean>;
    /**
     * Archives (`at`, by `by`) or unarchives (null) a live room. False when
     * it is no live room, or already so.
     */
    setArchived(id: string, at: number | null, by: string): Promise<boolean>;
    /** Makes `dotId` a live room's lead socio. */
    setLead(id: string, dotId: string): Promise<boolean>;
}

export interface RoomMemberRepository {
    get(roomId: string, userId: string): Promise<StoredRoomMember | undefined>;
    /** A room's people, ended rows too, in the order they were added. */
    list(roomId: string): Promise<StoredRoomMember[]>;
    /** A person's memberships, only those in `statuses` when given. */
    forUser(userId: string, statuses?: readonly RoomMemberStatus[]): Promise<StoredRoomMember[]>;
    /** A new row; fails if the person has one in the room already. */
    insert(member: StoredRoomMember): Promise<void>;
    /** Writes the row whole: a new one, or a re-invite over an ended one. */
    save(member: StoredRoomMember): Promise<void>;
    /** The rooms with at least one active member. */
    roomsWithActive(): Promise<string[]>;
    /** Invites still `invited` whose expiry is at or before `now`. */
    lapsed(now: number, limit: number): Promise<StoredRoomMember[]>;
}

/**
 * What the access rule reads of a person's memberships (CB-208): one
 * statement each, synchronous, so the request checks that are synchronous
 * today (`requireOwnedThread`'s callers, a socio's shared area) can use
 * the one rule. Never a write.
 */
export interface RoomAccessReader {
    member(roomId: string, userId: string): Pick<RoomMember, 'role' | 'status'> | undefined;
    /** The rooms the person is an active member of, with their role. */
    activeRooms(userId: string): Array<{ roomId: string; role: RoomRole }>;
    /**
     * Who is in the room or about to be (CB-181): its active members and
     * those invited whose invite still works at `now`. Shared memory goes
     * to a room only when every one of them may read it.
     */
    people(roomId: string, now: number): string[];
    /**
     * The room's socios in `status` (CB-206: who may answer there, and the
     * names a mention matches), in the order they were added.
     */
    socios(roomId: string, status: RoomSocio['status']): string[];
}

export interface RoomSocioRepository {
    get(roomId: string, dotId: string): Promise<StoredRoomSocio | undefined>;
    list(roomId: string): Promise<StoredRoomSocio[]>;
    /** Every room's socios in one status (a workspace admin's queue). */
    withStatus(status: RoomSocio['status']): Promise<StoredRoomSocio[]>;
    /** A new row; fails if the socio has one in the room already. */
    insert(socio: StoredRoomSocio): Promise<void>;
    save(socio: StoredRoomSocio): Promise<void>;
}

/** A room admin's lower limits (`room_settings`), as saved. */
export interface StoredRoomSettings {
    roomId: string;
    limits: Partial<RoomLimits>;
    updatedBy: string;
    updatedAt: number;
    /** A room's optional description / purpose (CB-278). */
    description: string | null;
}

export interface RoomSettingsRepository {
    get(roomId: string): Promise<StoredRoomSettings | undefined>;
    save(settings: StoredRoomSettings): Promise<void>;
}

/** A Telegram topic bound to a room (CB-214): one room per topic. */
export interface RoomSourceBinding {
    id: string;
    roomId: string;
    source: 'telegram';
    /** `telegram_threads.key` of the topic. */
    sourceKey: string;
    status: RoomSourceBindingStatus;
    /** Web messages go out to the topic too. */
    bridge: boolean;
    boundBy: string;
    boundAt: number;
    endedAt: number | null;
}

export interface RoomSourceRepository {
    bySource(source: RoomSourceBinding['source'], sourceKey: string): Promise<RoomSourceBinding | undefined>;
    forRoom(roomId: string): Promise<RoomSourceBinding[]>;
    /** A new binding; fails if the topic is bound to a room already. */
    insert(binding: RoomSourceBinding): Promise<void>;
    /** Stops a binding; the row stays, so the topic stays bound to it. */
    disable(id: string, now: number): Promise<void>;
    /**
     * A stopped binding's topic, bound again (CB-214): to `roomId`, by
     * `boundBy`, without the bridge. The one row per topic is kept, so a
     * topic maps to one room at a time. False unless it was stopped.
     */
    rebind(id: string, binding: Pick<RoomSourceBinding, 'roomId' | 'boundBy' | 'boundAt'>): Promise<boolean>;
}

export interface RoomEventRepository extends RoomEventsShape {
    /** A room's events, newest first. */
    forRoom(roomId: string, limit: number): Promise<StoredRoomEvent[]>;
    /** Events a person caused or was the target of, newest first, older than `before` (time, then id). */
    forPerson(
        userId: string,
        before: { at: number; id: number } | undefined,
        limit: number,
    ): Promise<StoredRoomEvent[]>;
}

/**
 * A member's place in a room they are active in (CB-215): how far they
 * have read (0 before their first read) and since when they are in it.
 */
export interface RoomReadPlace {
    roomId: string;
    lastSeq: number;
    /** When they joined (accepted, or made the room): nothing before is new to them. */
    joinedAt: number;
}

export interface RoomReadStateRepository {
    /** The person's place in each room they are an active member of. */
    places(userId: string): Promise<RoomReadPlace[]>;
    /** Their place in one room, while an active member there. */
    place(roomId: string, userId: string): Promise<RoomReadPlace | undefined>;
    /**
     * Moves the person's cursor to `seq` unless it is already there or
     * further (two devices never move it back); the cursor after.
     */
    advance(roomId: string, userId: string, seq: number, now: number): Promise<number>;
}

/**
 * A handoff in a room's work cycle (CB-206): a socio handing the work on,
 * or a further socio the person's message named. Pending until its step
 * starts; `afterRunId` is the step it follows, until the cycle is known
 * (`cycleId`, set once that step has one).
 */
export interface RoomHandoff {
    id: string;
    roomId: string;
    cycleId: string | null;
    afterRunId: string;
    kind: HandoffKind;
    fromDotId: string;
    toDotId: string;
    /** The socio's reason; empty for a named socio. */
    reason: string;
    /** `dot:<id>` for a socio's handoff, the person's id for a named socio. */
    requestedBy: string;
    status: HandoffStatus;
    /** Why it was dropped, for the room's record. */
    detail: string | null;
    /** The hop its step ran at, once started. */
    hop: number | null;
    /** The run of its step, once started. */
    runId: string | null;
    createdAt: number;
    updatedAt: number;
}

export interface RoomHandoffRepository {
    insert(handoff: RoomHandoff): Promise<void>;
    /** Writes `patch`; false when the row is not there. */
    update(
        id: string,
        patch: Partial<Pick<RoomHandoff, 'cycleId' | 'status' | 'detail' | 'hop' | 'runId'>>,
    ): Promise<boolean>;
    /** A cycle's handoffs, and those after `afterRunId` not tied to it yet, in order. */
    forCycle(cycleId: string, afterRunId?: string): Promise<RoomHandoff[]>;
    /** Ties the handoffs after a step to its cycle, once known. */
    bindCycle(afterRunId: string, cycleId: string): Promise<void>;
    /** The handoffs waiting for their step: in a room, or in every room. */
    pending(roomId?: string): Promise<RoomHandoff[]>;
}

export interface RoomRepositories {
    conversations: RoomConversationRepository;
    members: RoomMemberRepository;
    socios: RoomSocioRepository;
    settings: RoomSettingsRepository;
    sources: RoomSourceRepository;
    events: RoomEventRepository;
    reads: RoomReadStateRepository;
    handoffs: RoomHandoffRepository;
}
