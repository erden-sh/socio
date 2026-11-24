import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * Rooms (CB-207): who is in a room and how
 * (`room_members`, one row per room and person, kept when it ends), which
 * socios may answer there (`room_socios`), a room admin's lower limits
 * (`room_settings`), the Telegram topic bound to a room (one room per
 * topic, CB-214), the room's own audit (`room_events`: names, never
 * content), how far each member has read (`room_read_state`, CB-215),
 * and each member's notifications and mentions (CB-216).
 * The room itself is its `thread_bindings` row (workspace migration 16).
 * Nothing is back-filled: a private chat has no rows here. Version 4
 * (CB-206) adds the handoffs between a room's socios.
 */
export const roomsSchema: SchemaSet = {
    id: MODULE_IDS.rooms,
    migrations: [
        {
            version: 1,
            name: 'rooms',
            up: `CREATE TABLE room_members(roomId TEXT NOT NULL CHECK(length(roomId) > 0), userId TEXT NOT NULL CHECK(length(userId) > 0), role TEXT NOT NULL CHECK(role IN ('admin','member')), status TEXT NOT NULL CHECK(status IN ('invited','active','declined','expired','left','removed')), invitedBy TEXT, invitedAt INTEGER NOT NULL, inviteExpiresAt INTEGER, acceptedAt INTEGER, disclosureVersion INTEGER, endedAt INTEGER, endedBy TEXT, updatedAt INTEGER NOT NULL, PRIMARY KEY(roomId, userId));
      CREATE INDEX room_members_user ON room_members(userId, status);
      CREATE TABLE room_socios(roomId TEXT NOT NULL CHECK(length(roomId) > 0), dotId TEXT NOT NULL CHECK(length(dotId) > 0), status TEXT NOT NULL CHECK(status IN ('requested','active','withdrawn','removed')), requestedBy TEXT NOT NULL, authorizedBy TEXT, authorizedAt INTEGER, endedAt INTEGER, updatedAt INTEGER NOT NULL, PRIMARY KEY(roomId, dotId));
      CREATE TABLE room_settings(roomId TEXT PRIMARY KEY, limits TEXT NOT NULL DEFAULT '{}', updatedBy TEXT NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE room_source_bindings(id TEXT PRIMARY KEY, roomId TEXT NOT NULL CHECK(length(roomId) > 0), source TEXT NOT NULL CHECK(source IN ('telegram')), sourceKey TEXT NOT NULL CHECK(length(sourceKey) > 0), status TEXT NOT NULL CHECK(status IN ('active','disabled')), bridge INTEGER NOT NULL DEFAULT 0 CHECK(bridge IN (0,1)), boundBy TEXT NOT NULL, boundAt INTEGER NOT NULL, endedAt INTEGER, UNIQUE(source, sourceKey));
      CREATE INDEX room_source_bindings_room ON room_source_bindings(roomId);
      CREATE TABLE room_events(id INTEGER PRIMARY KEY AUTOINCREMENT, roomId TEXT NOT NULL CHECK(length(roomId) > 0), actor TEXT NOT NULL CHECK(length(actor) > 0), action TEXT NOT NULL, targetKind TEXT NOT NULL CHECK(targetKind IN ('room','person','socio','source')), targetId TEXT, outcome TEXT NOT NULL CHECK(outcome IN ('ok','denied')), detail TEXT NOT NULL DEFAULT '', createdAt INTEGER NOT NULL);
      CREATE INDEX room_events_room ON room_events(roomId, id);`,
        },
        {
            // Each member's read cursor (CB-215): the room's last finished turn
            // (`agent_runs.seq`) they have seen, only ever moved forward. No row
            // reads as "nothing since joining".
            version: 2,
            name: 'read state',
            phase: 'expand',
            up: `CREATE TABLE room_read_state(roomId TEXT NOT NULL CHECK(length(roomId) > 0), userId TEXT NOT NULL CHECK(length(userId) > 0), lastSeq INTEGER NOT NULL CHECK(lastSeq >= 0), updatedAt INTEGER NOT NULL, PRIMARY KEY(roomId, userId));`,
        },
        {
            // Notifications (CB-216): each member's level per room (no row is the
            // default, `mentions`); the people each message mentions, as its
            // author's picker chose them, `pending` until the message is in the
            // room's history and `confirmed` once checked there; and each
            // notice sent, one per person and cause, so a replay or a second
            // runtime never sends it twice.
            version: 3,
            name: 'notices',
            phase: 'expand',
            up: `CREATE TABLE room_notify_settings(roomId TEXT NOT NULL CHECK(length(roomId) > 0), userId TEXT NOT NULL CHECK(length(userId) > 0), level TEXT NOT NULL CHECK(level IN ('all','mentions','mute')), updatedAt INTEGER NOT NULL, PRIMARY KEY(roomId, userId));
      CREATE TABLE room_mentions(roomId TEXT NOT NULL CHECK(length(roomId) > 0), messageId TEXT NOT NULL CHECK(length(messageId) > 0), userId TEXT NOT NULL CHECK(length(userId) > 0), authorId TEXT NOT NULL CHECK(length(authorId) > 0), label TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','confirmed')), createdAt INTEGER NOT NULL, PRIMARY KEY(roomId, messageId, userId));
      CREATE INDEX room_mentions_pending ON room_mentions(roomId, createdAt) WHERE status = 'pending';
      CREATE TABLE room_notices(userId TEXT NOT NULL CHECK(length(userId) > 0), cause TEXT NOT NULL CHECK(length(cause) > 0), roomId TEXT NOT NULL CHECK(length(roomId) > 0), createdAt INTEGER NOT NULL, PRIMARY KEY(userId, cause));
      CREATE INDEX room_notices_time ON room_notices(createdAt);`,
        },
        {
            // CB-206: the handoffs of each work cycle in a room, a socio's own
            // and the further socios a person's message named: pending until
            // their step starts, so a restart between two steps carries on, and
            // kept after, for the loop rule and the room's record.
            version: 4,
            name: 'room handoffs',
            phase: 'expand',
            up: `CREATE TABLE room_handoffs(id TEXT PRIMARY KEY CHECK(length(id) > 0), roomId TEXT NOT NULL CHECK(length(roomId) > 0), cycleId TEXT, afterRunId TEXT NOT NULL CHECK(length(afterRunId) > 0), kind TEXT NOT NULL CHECK(kind IN ('handoff','mention')), fromDotId TEXT NOT NULL CHECK(length(fromDotId) > 0), toDotId TEXT NOT NULL CHECK(length(toDotId) > 0), reason TEXT NOT NULL DEFAULT '', requestedBy TEXT NOT NULL CHECK(length(requestedBy) > 0), status TEXT NOT NULL CHECK(status IN ('pending','started','dropped')), detail TEXT, hop INTEGER, runId TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE INDEX room_handoffs_room ON room_handoffs(roomId, status);
      CREATE INDEX room_handoffs_cycle ON room_handoffs(cycleId);
      CREATE INDEX room_handoffs_after ON room_handoffs(afterRunId);`,
        },
        {
            // CB-278: a room's optional description / purpose, kept beside its
            // limits in `room_settings`. NULL means none was given.
            version: 5,
            name: 'room description',
            phase: 'expand',
            up: `ALTER TABLE room_settings ADD COLUMN description TEXT;`,
        },
    ],
};
