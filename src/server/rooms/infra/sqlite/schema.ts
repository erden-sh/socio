import { primaryKey, sqliteTable } from 'drizzle-orm/sqlite-core';

import { enumText, flag, id, int, json, ms, str } from '@socio/data/columns.sqlite';
import { HANDOFF_KINDS, HANDOFF_STATUSES } from '@socio/shared/rooms/room-handoffs';
import {
    CONVERSATION_KINDS,
    ROOM_MEMBER_STATUSES,
    ROOM_ROLES,
    ROOM_SOCIO_STATUSES,
    type RoomEvent,
    type RoomEventAction,
    type RoomLimits,
} from '@socio/shared/rooms/rooms';

/**
 * The room tables (CB-207), as `rooms/migrations.ts` makes them: the typed
 * mirror the repositories query. The migrations stay the source of truth;
 * tests/rooms-migration.test.ts holds these to them.
 */

export const roomMembers = sqliteTable(
    'room_members',
    {
        roomId: id().notNull(),
        userId: str().notNull(),
        role: enumText(ROOM_ROLES).notNull(),
        status: enumText(ROOM_MEMBER_STATUSES).notNull(),
        invitedBy: str(),
        invitedAt: ms().notNull(),
        inviteExpiresAt: ms(),
        acceptedAt: ms(),
        disclosureVersion: int(),
        endedAt: ms(),
        endedBy: str(),
        updatedAt: ms().notNull(),
    },
    (table) => [primaryKey({ columns: [table.roomId, table.userId] })],
);

export const roomSocios = sqliteTable(
    'room_socios',
    {
        roomId: id().notNull(),
        dotId: id().notNull(),
        status: enumText(ROOM_SOCIO_STATUSES).notNull(),
        requestedBy: str().notNull(),
        authorizedBy: str(),
        authorizedAt: ms(),
        endedAt: ms(),
        updatedAt: ms().notNull(),
    },
    (table) => [primaryKey({ columns: [table.roomId, table.dotId] })],
);

export const roomSettings = sqliteTable('room_settings', {
    roomId: id().primaryKey(),
    limits: json<Partial<RoomLimits>>().notNull(),
    updatedBy: str().notNull(),
    updatedAt: ms().notNull(),
    /** A room's optional description / purpose (CB-278). */
    description: str(),
});

export const roomSourceBindings = sqliteTable('room_source_bindings', {
    id: id().primaryKey(),
    roomId: id().notNull(),
    source: enumText(['telegram']).notNull(),
    sourceKey: str().notNull(),
    status: enumText(['active', 'disabled']).notNull(),
    bridge: flag().notNull(),
    boundBy: str().notNull(),
    boundAt: ms().notNull(),
    endedAt: ms(),
});

export const roomEvents = sqliteTable('room_events', {
    id: int().primaryKey({ autoIncrement: true }),
    roomId: id().notNull(),
    actor: str().notNull(),
    action: str().$type<RoomEventAction>().notNull(),
    targetKind: enumText(['room', 'person', 'socio', 'source']).$type<RoomEvent['targetKind']>().notNull(),
    targetId: str(),
    outcome: enumText(['ok', 'denied']).notNull(),
    detail: str().notNull(),
    createdAt: ms().notNull(),
});

/** How far each member has read a room (CB-215): a finished turn's `seq`. */
export const roomReadState = sqliteTable(
    'room_read_state',
    {
        roomId: id().notNull(),
        userId: str().notNull(),
        lastSeq: int().notNull(),
        updatedAt: ms().notNull(),
    },
    (table) => [primaryKey({ columns: [table.roomId, table.userId] })],
);

/** Each cycle's handoffs between a room's socios (CB-206). */
export const roomHandoffs = sqliteTable('room_handoffs', {
    id: id().primaryKey(),
    roomId: id().notNull(),
    cycleId: id(),
    afterRunId: id().notNull(),
    kind: enumText(HANDOFF_KINDS).notNull(),
    fromDotId: id().notNull(),
    toDotId: id().notNull(),
    reason: str().notNull(),
    requestedBy: str().notNull(),
    status: enumText(HANDOFF_STATUSES).notNull(),
    detail: str(),
    hop: int(),
    runId: id(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
});

/** Every table Rooms owns, for the drift test. */
export const roomTables = [
    roomMembers,
    roomSocios,
    roomSettings,
    roomSourceBindings,
    roomEvents,
    roomReadState,
    roomHandoffs,
] as const;

/**
 * The workspace's `thread_bindings` (workspace.ts), only the columns a
 * room's row is written and read with: not Rooms' table, so it is not in
 * `roomTables`; the test checks each column against the migrated one.
 */
export const roomConversations = sqliteTable('thread_bindings', {
    id: id().primaryKey(),
    dotId: id().notNull(),
    ownerId: str().notNull(),
    title: str().notNull(),
    createdAt: ms().notNull(),
    learningContainerId: id(),
    kind: enumText(CONVERSATION_KINDS).notNull(),
    createdBy: str(),
    convertedAt: ms(),
    archivedAt: ms(),
    archivedBy: str(),
    /** A person chose its title (CB-66): a generated one never replaces it. */
    renamed: flag().notNull().default(false),
    titled: flag().notNull().default(false),
    deletedAt: ms(),
});
