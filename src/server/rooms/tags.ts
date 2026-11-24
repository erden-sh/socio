/**
 * Rooms' services, whole, by tag: what its module and routes use (other
 * features use the contract's slices: `Rooms`, `Topics`, `Orchestrator`,
 * `Notices`, `Streams`). Moved from `layer.ts` so the module can read them
 * from the app's services: only entry files import a `layer.ts`, and
 * `contract.ts` can't name the classes. `layer.ts` builds them.
 */
import { Context } from 'effect';

import type { RoomMembership } from './membership.js';
import type { RoomNotices } from './notices.js';
import type { RoomOrchestrator } from './orchestrator.js';
import type { RoomsWorkspaceShape } from './services.js';
import type { RoomStreams } from './streams.js';
import type { RoomTopics } from './telegram-topics.js';

/** The workspace store, as rooms reads it. */
export class RoomsWorkspace extends Context.Service<RoomsWorkspace, RoomsWorkspaceShape>()(
    'socio/rooms/RoomsWorkspace',
) {}

/** Open live streams, under the graph's `LegacyRoomStreams` tag (the class). */
export class LegacyRoomStreams extends Context.Service<LegacyRoomStreams, RoomStreams>()('socio/rooms/RoomStreams') {}

/** Rooms' membership, under the graph's `LegacyRooms` tag. */
export class LegacyRooms extends Context.Service<LegacyRooms, RoomMembership>()('socio/rooms/RoomMembership') {}

/** Rooms' Telegram topics, under the graph's `LegacyRoomTopics` tag. */
export class LegacyRoomTopics extends Context.Service<LegacyRoomTopics, RoomTopics>()('socio/rooms/RoomTopics') {}

/** Turn-taking in rooms, under the graph's `LegacyOrchestrator` tag. */
export class LegacyOrchestrator extends Context.Service<LegacyOrchestrator, RoomOrchestrator>()(
    'socio/rooms/RoomOrchestrator',
) {}

/** Rooms' notices, under the graph's `LegacyRoomNotices` tag. */
export class LegacyRoomNotices extends Context.Service<LegacyRoomNotices, RoomNotices>()('socio/rooms/RoomNotices') {}
