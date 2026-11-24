/**
 * What other features may know of Rooms (CB-207 and after): its tags, the
 * slices of its services they call, its errors, and plain types and
 * constants. It imports only `effect`, `@socio/*` and `import type` from
 * the allowlist, and
 * holds no logic.
 *
 * The types, errors and constants here moved from the files that defined them,
 * and those old paths were later dropped. The pure helpers other features call
 * moved to `@socio/foundation/rooms/*` (`authority`, `answer-labels`,
 * `denial-status`, `settings`, `topic-keys`, `turn-problems`); the feature
 * logic they call is behind the tags below.
 *
 * Not here, on purpose:
 * - `RoomMembership.cycleHooks()` and `RoomNotices.runFinished`: wiring the
 *   composition root does once (`cycles.rooms`, `runner.onRunFinished`),
 *   typed by `cycles/` and `turns/`, whose contracts don't exist yet.
 * - `sqliteRoomRepositories` and `sqliteRoomAccessReader`: construction
 *   over a connection. Other features reach what they build through
 *   `Access` and `RoomEvents`.
 * - What only `rooms/` itself calls (its routes, `module.ts`'s tools, notes
 *   and ticks).
 */
import type { BaseEvent } from '@ag-ui/client';
import { Context } from 'effect';
import type { Hono, MiddlewareHandler } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import type { AuditOptions } from '@socio/foundation/operations/audit-options';
import type { PersonMention } from '@socio/shared/rooms/room-people-mentions';
import {
    ROOM_DENIAL_MESSAGES,
    type ConversationKind,
    type RoomAction,
    type RoomDecision,
    type RoomDenial,
    type RoomEvent,
    type RoomMember,
    type RoomRefusal,
    type RoomRole,
    type RoomSocio,
    type RoomStreamCloseReason,
    type RoomViewer,
    type RoomsSettings,
} from '@socio/shared/rooms/rooms';
import type { Conversation, TelegramStatus } from '@socio/shared/types';

// ── Rows ─────────────────────────────────────────────────────────────────

/** A stored membership, with when its row last changed. */
export type StoredRoomMember = RoomMember & { updatedAt: number };
/** A stored room socio, with when its row last changed. */
export type StoredRoomSocio = RoomSocio & { updatedAt: number };
/** A stored audit line, with its order. */
export type StoredRoomEvent = RoomEvent & { id: number };

/** What the room rules and the rooms module read of a room's row. */
export interface RoomConversation {
    id: string;
    kind: ConversationKind;
    ownerId: string;
    dotId: string;
    title: string;
    createdAt: number;
    createdBy: string | null;
    convertedAt: number | null;
    archivedAt: number | null;
}

/** Whether a Telegram topic's binding to a room (CB-214) is in force. */
export type RoomSourceBindingStatus = 'active' | 'disabled';

/** A person a room message mentions (`room_mentions`, CB-216). */
export interface StoredRoomMention {
    roomId: string;
    messageId: string;
    userId: string;
    authorId: string;
    label: string;
    status: 'pending' | 'confirmed';
    createdAt: number;
}

// ── Errors ───────────────────────────────────────────────────────────────

/**
 * Why a request about a conversation is refused (CB-208): the rule's
 * reason, which a route answers with `roomDenialStatus`
 * (`@socio/foundation/rooms/denial-status`). `not_found` is a 404, as for
 * another person's chat, so ids can't be probed.
 *
 * A plain `Error` subclass, as before: callers test it with `instanceof`
 * and read `reason`, and its name, `String()` and JSON stay what they
 * were. A `Data.TaggedError` comes with the rooms layer.
 */
export class RoomAccessError extends Error {
    constructor(readonly reason: RoomDenial) {
        super(ROOM_DENIAL_MESSAGES[reason]);
        this.name = 'RoomAccessError';
    }
}

/** What a refusal says, beside the rule's own (`ROOM_DENIAL_MESSAGES`). */
const REFUSALS: Record<Exclude<RoomRefusal, keyof typeof ROOM_DENIAL_MESSAGES>, string> = {
    last_admin: 'A room needs an admin: make someone else an admin first, or archive the room.',
    expired: 'This invite has expired. Ask a room admin to invite you again.',
    not_eligible: 'Only people who use Socio can be invited.',
    conflict: 'That has changed meanwhile. Reload and try again.',
    disclosure: 'Read and accept what joining shares before you join.',
    raised: 'A room’s limits can only be lower than the workspace’s.',
    invalid: 'That request doesn’t fit.',
    usage_hidden: 'Only this room’s admins see its use and limits.',
};

/** The HTTP status each refusal is answered with. */
export const ROOM_REFUSAL_STATUS: Record<RoomRefusal, number> = {
    not_found: 404,
    not_admin: 403,
    not_initiator: 403,
    archived: 409,
    rooms_off: 409,
    read_only: 409,
    last_admin: 409,
    conflict: 409,
    expired: 410,
    not_eligible: 400,
    disclosure: 400,
    raised: 400,
    invalid: 400,
    usage_hidden: 403,
};

/**
 * A refusal of a room change (CB-208), with its reason and HTTP status. A
 * plain `Error` subclass, as `RoomAccessError` is.
 */
export class RoomError extends Error {
    /** The rule's refusal, for its audit line (`RoomAccess.denied`). */
    denial?: { roomId: string; userId: string; action: RoomAction };
    constructor(
        readonly reason: RoomRefusal,
        message?: string,
        /** The limits a room admin tried to raise (`raised`). */
        readonly fields?: readonly string[],
    ) {
        super(
            message ??
                (reason in ROOM_DENIAL_MESSAGES
                    ? ROOM_DENIAL_MESSAGES[reason as keyof typeof ROOM_DENIAL_MESSAGES]
                    : REFUSALS[reason as keyof typeof REFUSALS]),
        );
        this.name = 'RoomError';
    }
    get status() {
        return ROOM_REFUSAL_STATUS[this.reason];
    }
}

// ── Access ───────────────────────────────────────────────────────────────

export interface RoomAccessCheck {
    /** For `stop`: who started the work cycle running now. */
    cycleInitiatorId?: string;
    /**
     * Audit a refusal (the default): off for a check that is no request
     * about this room (a list flagging which runs its viewer may open).
     */
    audit?: boolean;
}

/** What the rule reads of a conversation; no kind reads as private. */
export interface AccessThread {
    id: string;
    ownerId: string;
    kind?: ConversationKind;
    archivedAt?: number | null;
}

/**
 * The one access rule at work (CB-208), as the workspace
 * and other features ask it (`RoomAccess`, rooms/access.ts).
 */
export interface AccessShape {
    /** Settings → General → Rooms in force. */
    enabled(): boolean;
    /** The rooms a person is an active member of, with their role. */
    viewerRooms(userId: string): Array<{ roomId: string; role: RoomRole }>;
    /** The room's active members and invites that still work (CB-181). */
    people(roomId: string): string[];
    /** The room's active socios, in the order they were added (CB-206). */
    socios(roomId: string): string[];
    /** What the rule knows of the person, for this conversation. */
    viewer(thread: AccessThread, userId: string): RoomViewer;
    /** Whether `userId` may do `action` in the conversation, and why not. */
    decide(thread: AccessThread, userId: string, action: RoomAction, check?: RoomAccessCheck): RoomDecision;
}

export class Access extends Context.Service<Access, AccessShape>()('socio/rooms/Access') {}

/** A room's audit (`room_events`), as other features write to it. */
export interface RoomEventsShape {
    /** Joins the open unit of work on the connection, or opens its own. */
    append(event: RoomEvent): Promise<void>;
}

export class RoomEvents extends Context.Service<RoomEvents, RoomEventsShape>()('socio/rooms/RoomEvents') {}

// ── Rooms (membership) ───────────────────────────────────────────────────

/** A room as Operations shows it to a workspace admin (CB-213). */
export interface RoomOversight {
    room: RoomConversation;
    members: StoredRoomMember[];
    socios: StoredRoomSocio[];
    events: StoredRoomEvent[];
    now: number;
}

/**
 * Rooms' membership and lifecycle (CB-208): what the composition
 * (`LegacyRooms`) and other features call of `RoomMembership`
 * (rooms/membership.ts).
 */
export interface RoomsShape {
    /** A room's membership rows, ended ones too. */
    members(roomId: string): Promise<StoredRoomMember[]>;
    /** Undefined for anything that is no room; asks no rule (Operations logs each view). */
    oversight(roomId: string, options?: { events?: number }): Promise<RoomOversight | undefined>;
    /** Keeps an admin in every room (or one person's rooms); how many rooms changed. */
    handOver(userId?: string): Promise<number>;
    /**
     * What `handOver(userId)` would do once this person is deactivated,
     * changing nothing (CB-360's deactivation preview): rooms that get
     * another admin, and rooms archived with no active member left.
     */
    handOverPreview(userId: string): Promise<{ handedOver: number; archived: number }>;
    /**
     * The room events a person caused or was the target of, with each
     * room's title, newest first, older than `before` (by time, then id):
     * CB-360's trail. Names and outcomes, never content.
     */
    personEvents(
        userId: string,
        before: { at: number; id: number } | undefined,
        limit: number,
    ): Promise<(StoredRoomEvent & { roomTitle: string | null })[]>;
    /** A room admin cancels someone else's queued message; whose it was. */
    cancelQueued(roomId: string, by: string, cancel: () => Promise<string | undefined>): Promise<string | undefined>;
    rename(roomId: string, by: string, title: string): Promise<void>;
    archive(roomId: string, by: string): Promise<void>;
    unarchive(roomId: string, by: string): Promise<void>;
}

export class Rooms extends Context.Service<Rooms, RoomsShape>()('socio/rooms/Rooms') {}

// ── Notices ──────────────────────────────────────────────────────────────

/**
 * Rooms' notices (CB-216): what the composition (`LegacyRoomNotices`) and
 * other features call of `RoomNotices` (rooms/notices.ts).
 */
export interface NoticesShape {
    /** The chat list with the person's level in each room, where it isn't the default. */
    withLevels(userId: string, conversations: Conversation[]): Promise<Conversation[]>;
    /** A message's mentions, checked against the room; what is kept. */
    record(
        roomId: string,
        authorId: string,
        messageId: string,
        text: string,
        picked: readonly PersonMention[],
    ): Promise<PersonMention[]>;
    /** A queued message canceled: its mentions go with it. */
    forget(roomId: string, messageId: string): Promise<void>;
    /** The room's mentions, by message, for its transcript. */
    mentions(roomId: string): Promise<Map<string, StoredRoomMention[]>>;
    /** A person was invited: they hear of it. */
    invited(roomId: string, by: string, userId: string, at: number): Promise<void>;
}

export class Notices extends Context.Service<Notices, NoticesShape>()('socio/rooms/Notices') {}

// ── Orchestrator ─────────────────────────────────────────────────────────

/**
 * Several socios in a room (CB-206): what the composition
 * (`LegacyOrchestrator`) and other features call of `RoomOrchestrator`
 * (rooms/orchestrator.ts).
 */
export interface OrchestratorShape {
    /** Who answers queued messages: the socios they name, in order, else the lead. */
    route(threadId: string, texts: readonly string[]): string[];
    /** Whether the socio running now may read this queued message in its step. */
    readsMidTurn(threadId: string, dotId: string, text: string): boolean;
    /** The further socios a person's message named, to answer after `runId`. */
    queueNamed(roomId: string, runId: string, personId: string, targets: readonly string[]): Promise<void>;
    /** Drops what was to follow a step that never ran. */
    dropAfter(runId: string, detail: string): Promise<void>;
    /** Whether a step waits to start in the room. */
    waiting(threadId: string): Promise<boolean>;
    /** Whether the step `runId` leaves a next step in its cycle. */
    awaits(conversationId: string, runId: string): Promise<boolean>;
    /** At start: steps a restart left waiting go on. */
    resume(): Promise<void>;
    stop(): void;
}

export class Orchestrator extends Context.Service<Orchestrator, OrchestratorShape>()('socio/rooms/Orchestrator') {}

// ── Topics ───────────────────────────────────────────────────────────────

/** Where a topic's messages go: the room it is bound to, live or not. */
export interface TopicRoute {
    bindingId: string;
    roomId: string;
    status: RoomSourceBindingStatus;
}

/** Whether a linked person's message in a bound topic is a room turn. */
export type TopicSenderCheck = { ok: true } | { ok: false; reason: 'not_member' | 'closed' };

/** Why a code posted in a topic did not bind it. */
export type TopicRedeemRefusal =
    | 'invalid'
    | 'expired'
    | 'used'
    | 'not_group_admin'
    | 'not_topic'
    | 'wrong_topic'
    | 'conflict'
    | 'room_bound'
    | 'rooms_off'
    | 'archived'
    | 'not_allowed';

export type TopicRedeemResult =
    | { ok: true; roomId: string; title: string; converted: boolean }
    | { ok: false; reason: TopicRedeemRefusal };

/**
 * Rooms' Telegram topics (CB-214): what the Telegram channel calls of
 * `RoomTopics` (rooms/telegram-topics.ts).
 */
export interface TopicsShape {
    /** Where a topic's messages go, if it was ever bound. */
    route(key: string): Promise<TopicRoute | undefined>;
    /** Whether a linked person may talk to the room's socio from its topic. */
    sender(roomId: string, userId: string): TopicSenderCheck;
    /** A bind code posted in a topic by a group admin's linked account. */
    redeem(input: {
        code: string;
        userId: string;
        chatId: string;
        topicId: string | null;
        groupAdmin: boolean;
    }): Promise<TopicRedeemResult>;
    /** Counts a message the socio did not answer; true when its sender should be told why. */
    unanswered(input: {
        key: string;
        roomId: string;
        telegramUserId: string;
        reason: 'unlinked' | 'not_member' | 'closed';
        username: string | null;
    }): Promise<boolean>;
}

export class Topics extends Context.Service<Topics, TopicsShape>()('socio/rooms/Topics') {}

// ── Streams ──────────────────────────────────────────────────────────────

/**
 * One open stream: closed once, with why; without a reason when the
 * server stops (the reader connects again).
 */
export interface RoomStreamHandle {
    close(reason?: RoomStreamCloseReason): void;
}

/**
 * Room members' live streams (CB-212): what the composition
 * (`LegacyRoomStreams`) and other features call of `RoomStreams`
 * (rooms/streams.ts).
 */
export interface StreamsShape {
    /** Holds a stream open for `userId` in `roomId`; returns its release. */
    open(roomId: string, userId: string, handle: RoomStreamHandle, room?: boolean): () => void;
    /** How many streams are open here (for a room, a person in it). */
    count(roomId?: string, userId?: string): number;
    /** A person's streams of a room end, or everyone's. */
    end(roomId: string, userId: string | undefined, reason: RoomStreamCloseReason): Promise<void>;
    /** Rooms were turned off: every room's streams end, everywhere. */
    endAll(reason?: RoomStreamCloseReason): Promise<void>;
    /** Checks every open stream's access now. */
    recheck(): void;
    /** Closes every stream here (the server stopping) and stops watching. */
    stop(): void;
}

export class Streams extends Context.Service<Streams, StreamsShape>()('socio/rooms/Streams') {}

/**
 * Where a room's events come from, for one reader's stream (CB-212):
 * whose turn each run was, and whose each stored result.
 */
export interface ReaderEventSource {
    /**
     * The person a run acted for (its trace's trigger, CB-185), or '' when
     * none it knows: as `LocalAgentRunner.toolActors` names a result's.
     */
    runActor(runId: string): string;
    /** `LocalAgentRunner.toolActors`: whose turn each stored result was. */
    toolActors(): ReadonlyMap<string, string>;
}

/** A room's events as one reader may see them (`readerFilter`, rooms/reader-events.ts). */
export interface ReaderEventsShape {
    /** A filter for one stream: the event as `reader` sees it, or nothing. */
    filter(reader: string, source: ReaderEventSource): (event: BaseEvent) => BaseEvent | undefined;
}

export class ReaderEvents extends Context.Service<ReaderEvents, ReaderEventsShape>()('socio/rooms/ReaderEvents') {}

// ── Reads ────────────────────────────────────────────────────────────────

/**
 * Each member's unread state in their rooms (CB-215): what the shell's
 * views call of `RoomReads` (rooms/read-state.ts; today through
 * `roomReads(sources)`).
 */
export interface ReadsShape {
    /** The chat list with each room's unread count, where it has some. */
    withUnread(userId: string, conversations: Conversation[]): Promise<Conversation[]>;
    /** Every unread count, for the shell's version. */
    version(userId: string): Promise<string>;
}

export class Reads extends Context.Service<Reads, ReadsShape>()('socio/rooms/Reads') {}

// ── What the module's routes mount from above rooms ──────────────────────

/**
 * The access log's route wrapper (Operations' `AccessAudit`, CB-188), for
 * a workspace admin's read of a room's audit: by the slice the routes call
 * (operations is above rooms in the folder order, so the port is declared
 * here and the composition provides it from `AccessAudit`).
 */
export interface RoomsAccessAuditShape {
    readonly audit: (options: AuditOptions) => MiddlewareHandler<AppEnv>;
}

export class RoomsAccessAudit extends Context.Service<RoomsAccessAudit, RoomsAccessAuditShape>()(
    'socio/rooms/RoomsAccessAudit',
) {}

/**
 * A room's pinned facts and notes (CB-217): the context's pin routes, over
 * its `RoomPins` with the rooms' audit (`context/pins.ts`), made when the
 * module's routes are mounted. Context is above rooms in the folder order,
 * so the port is declared here and the composition provides it.
 */
export interface RoomPinRoutesShape {
    readonly routes: () => Hono<AppEnv>;
}

export class RoomPinRoutes extends Context.Service<RoomPinRoutes, RoomPinRoutesShape>()('socio/rooms/RoomPinRoutes') {}

/**
 * What the rooms' routes show of the Telegram channel (`ChannelShape` in
 * telegram's contract, which sits above rooms in the folder order): whether
 * the bot is online, and its @username.
 */
export interface RoomsTelegramChannel {
    /** `online` once polling. */
    readonly status: TelegramStatus;
    /** The bot's @username, known once connected. */
    readonly username?: string;
}

/**
 * The Telegram channel, when configured, for the topic routes: read at
 * each use, since the boot step sets it after the graph is built. The
 * composition provides it over its late-bound port.
 */
export interface RoomsTelegramShape {
    readonly channel: RoomsTelegramChannel | undefined;
}

export class RoomsTelegram extends Context.Service<RoomsTelegram, RoomsTelegramShape>()('socio/rooms/RoomsTelegram') {}

// ── RoomsConfig ──────────────────────────────────────────────────────────

/**
 * The `PlatformConfig` fields `rooms/` reads: the env defaults of
 * Settings → General → Rooms (`ROOMS_ENABLED`, `ROOMS_BUDGET_VISIBLE`).
 */
export interface RoomsConfigShape {
    readonly rooms?: Partial<RoomsSettings>;
}

export class RoomsConfig extends Context.Service<RoomsConfig, RoomsConfigShape>()('socio/rooms/RoomsConfig') {}
