import { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';

import type { ModuleServicesAccess, ServerModule } from '../modules/contract.js';
import { Runner } from '../turns/contract.js';

import { RoomPinRoutes, RoomsAccessAudit, RoomsTelegram } from './contract.js';
import { roomsSchema } from './migrations.js';
import { roomNoticeRoutes } from './notice-routes.js';
import { roomReadRoutes } from './read-state.js';
import { roomRoutes } from './routes.js';
import type { RoomsPlatform } from './services.js';
import { LegacyOrchestrator, LegacyRoomNotices, LegacyRooms, LegacyRoomTopics, RoomsWorkspace } from './tags.js';
import { roomTopicRoutes } from './telegram-routes.js';

/** How often invites that ran out are marked so (they never work after). */
const EXPIRE_EVERY_MS = 10 * 60_000;

/**
 * What the rooms' routes read (`RoomsPlatform`), from the app's services
 * at the moment of use: rooms' own services (`tags.ts`), the runner,
 * the workspace as rooms reads it, and the Telegram channel, read at each
 * use (`RoomsTelegram`: it is set after the graph is built).
 */
const roomsOf = (services: ModuleServicesAccess): RoomsPlatform => {
    const telegram = services.get(RoomsTelegram);
    return {
        orchestrator: services.get(LegacyOrchestrator),
        roomNotices: services.get(LegacyRoomNotices),
        roomTopics: services.get(LegacyRoomTopics),
        rooms: services.get(LegacyRooms),
        runner: services.get(Runner),
        get telegram() {
            return telegram.channel;
        },
        workspace: services.get(RoomsWorkspace),
    };
};

/**
 * Rooms (CB-205): several people and company
 * socios in one conversation, behind the admin's switch (Settings →
 * General → Rooms, off by default). CB-207 is the schema and storage;
 * CB-208 the membership, invitations, roles and lifecycle
 * (`platform.rooms`) and the one access rule every conversation route
 * answers by (`WorkspaceStore.roomAccess`); CB-215 each member's read
 * cursor (`read-state.ts`); CB-216 their notifications, mentions and the
 * room's presence (`notices.ts`); CB-206 the turn-taking between a
 * room's socios (`platform.orchestrator`).
 */
export const roomsModule: ServerModule = {
    ...roomsSchema,
    // The access log is Operations' `AccessAudit` (as `RoomsAccessAudit`),
    // and the pin routes the context's (`RoomPinRoutes`), read from the
    // app's services when the routes are mounted.
    routes: ({ services }) => {
        const rooms = roomsOf(services);
        const { workspace } = rooms;
        const app = new Hono<AppEnv>();
        // Telegram topics first (CB-214): `/rooms/telegram/…` names no room.
        app.route('/', roomTopicRoutes(rooms));
        app.route(
            '/',
            roomRoutes(rooms.rooms, {
                audit: services.get(RoomsAccessAudit).audit,
                roomAdmin: (roomId, userId) => {
                    const thread = workspace.thread(roomId);
                    if (thread?.kind !== 'room') {
                        return false;
                    }
                    const member = workspace.roomAccess.viewer(thread, userId).member;
                    return member?.status === 'active' && member.role === 'admin';
                },
            }),
        );
        // Each member's read cursor (CB-215).
        app.route('/', roomReadRoutes(rooms));
        // The room's pinned facts and notes (CB-217, context/pins.ts).
        app.route('/', services.get(RoomPinRoutes).routes());
        // Each member's notifications and the room's presence (CB-216).
        app.route('/', roomNoticeRoutes(rooms));
        return app;
    },
    // A room's other socios (CB-206): `hand_off`, and who is in the chat.
    dotTools: ({ services }, turn) => services.get(LegacyOrchestrator).tools(turn),
    dotTurnNote: ({ services }, turn) => services.get(LegacyOrchestrator).note(turn),
    // An invite that ran out is refused as it is used; this marks it, with
    // its audit line, for the room's admins to see. It also keeps an admin
    // in every room whose admins were all deactivated (also from the auth
    // CLI, where no platform runs).
    tick: {
        everyMs: EXPIRE_EVERY_MS,
        run: async ({ services }) => {
            const rooms = services.get(LegacyRooms);
            await rooms.expireInvites();
            await rooms.handOver();
            // Mentions a restart left waiting, and old notices' claims (CB-216).
            await services.get(LegacyRoomNotices).sweep();
        },
    },
};
