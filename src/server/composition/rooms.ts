/**
 * The rooms feature's construction. The services are made in `rooms/layer.ts`;
 * this file provides what rooms declares there (`RoomsWorkspace`: the workspace
 * store; `RoomsHost`: a room's work, the ports, service accounts and the
 * steering queue) and, until the steps that offer them run, the settings' tags
 * rooms reads (`WorkspaceSettings`, `Limits`), each over the very object
 * today's code reads. It builds `RoomsConfig` over the startup configuration.
 *
 * A room's notices are built after its membership and orchestrator, which reach
 * them, and the steering turns too, through their ports.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import { sqliteData } from '@socio/data/open';

import { pinRoutes } from '../context/pin-routes.js';
import { roomPins } from '../context/pins.js';
import { steeringQueue } from '../context/steering.js';
import { AccessAudit } from '../operations/contract.js';
import {
    RoomPinRoutes,
    RoomsAccessAudit,
    RoomsConfig,
    RoomsTelegram,
    type RoomPinRoutesShape,
    type RoomsTelegramChannel,
    type RoomsTelegramShape,
} from '../rooms/contract.js';
import { sqliteRoomRepositories } from '../rooms/infra/sqlite/repositories.js';
import {
    LegacyOrchestrator,
    LegacyRoomNotices,
    LegacyRooms,
    LegacyRoomStreams,
    LegacyRoomTopics,
    RoomMembershipLive,
    RoomNoticesLive,
    RoomOrchestratorLive,
    RoomsBaseLive,
    RoomsHost,
    RoomStreamsLive,
    RoomTopicsLive,
    RoomsWorkspace,
    type RoomsHostShape,
} from '../rooms/layer.js';
import { Accounts, type ServiceAccountsShape } from '../service-accounts/contract.js';

import { RoomWork, type RoomWorkShape } from './app/room-work.js';
import { LegacyConfig, LegacyWorkspace } from './base.js';
import { LegacyCycles } from './cycles.js';
import { type PlatformPorts, Ports } from './ports.js';
import type { AppWorkspace } from './workspace-parts.js';

export { LegacyOrchestrator, LegacyRoomNotices, LegacyRooms, LegacyRoomStreams, LegacyRoomTopics };

/**
 * What a room's work (`RoomWork`), the ports and the features above rooms
 * answer it, read at the moment of use: a socio's turn through its port
 * (`AppTurns`, built after rooms).
 */
function roomsHost(
    work: Pick<RoomWorkShape, 'revoke'>,
    ports: Pick<PlatformPorts, 'turns' | 'draining' | 'steering' | 'roomNotices'>,
    accounts: Pick<ServiceAccountsShape, 'isService'>,
    db: DatabaseSync,
): RoomsHostShape {
    return RoomsHost.of({
        revoke: (roomId, userId) => work.revoke(roomId, userId),
        turnOutcome: (threadId, prompt, signal, options) =>
            ports.turns.get().turnOutcome(threadId, prompt, signal, options),
        draining: () => ports.draining.get(),
        settled: (threadId) => void ports.steering.get().consider(threadId),
        invited: (roomId, by, userId, at) => void ports.roomNotices.get().invited(roomId, by, userId, at),
        isService: (userId) => accounts.isService(userId),
        queued: (threadId) => steeringQueue(db).ids(threadId),
    });
}

// ── Routes' and module's parts ───────────────────────────────────────────

/**
 * A room's pin routes (`RoomPinRoutes`, CB-217): the context's, over its
 * `RoomPins` with the rooms' audit, made when the module mounts them, as
 * the module made them over the platform's workspace.
 */
export const roomPinRoutes = (workspace: AppWorkspace): RoomPinRoutesShape => ({
    routes: () => pinRoutes(roomPins(workspace, sqliteRoomRepositories(sqliteData(workspace.db)).events)),
});

// ── The graph (the server) ───────────────────────────────────────────────

/** The workspace store, as rooms reads it. */
const workspaceParts = Layer.effect(
    RoomsWorkspace,
    LegacyWorkspace.useSync((workspace) => workspace),
);

/** A room's work, the ports, service accounts and the steering queue, as rooms calls them. */
const host = Layer.effect(
    RoomsHost,
    Effect.gen(function* () {
        return roomsHost(yield* RoomWork, yield* Ports, yield* Accounts, (yield* LegacyWorkspace).db);
    }),
);

/**
 * Rooms' config: the startup configuration the root holds (`LegacyConfig`),
 * read at the moment of use (moving the env parsing here is a later change).
 */
const config = Layer.effect(
    RoomsConfig,
    LegacyConfig.useSync((config) => RoomsConfig.of(config)),
);

/** The Telegram channel when configured, read from its late-bound port at each use (`RoomsTelegram`). */
export const roomsTelegram = (channel: { peek(): RoomsTelegramChannel | undefined }): RoomsTelegramShape => ({
    get channel() {
        return channel.peek();
    },
});

/**
 * The ports the rooms module declares for what it mounts from above rooms:
 * the context's pin routes (`RoomPinRoutes`) and Operations' access log
 * (`RoomsAccessAudit`, `AccessAudit` itself); and what its hooks read in
 * place of the platform's (`RoomsWorkspace`, `RoomsTelegram`). Build
 * nothing, start nothing.
 */
const modulePorts = Layer.mergeAll(
    Layer.effect(RoomPinRoutes, LegacyWorkspace.useSync(roomPinRoutes)),
    // The workspace as rooms reads it, and the Telegram channel, read at
    // each use from its late-bound port: what the module's routes read.
    workspaceParts,
    Layer.effect(
        RoomsTelegram,
        Effect.gen(function* () {
            return roomsTelegram((yield* Ports).telegram);
        }),
    ),
    Layer.effect(
        RoomsAccessAudit,
        Effect.gen(function* () {
            return yield* AccessAudit;
        }),
    ),
);

/**
 * Rooms' steps of the graph, in the graph's order. The switch comes
 * first, offering the workspace's access rule (`Access`), the reader
 * filter (`ReaderEvents`), the room audit (`RoomEvents`), the read state
 * (`Reads`, made on first use) and `RoomsConfig`; then the streams,
 * membership, topics and orchestrator, each offered by its contract tag
 * and its class's; the notices come after notifications (and Operations'
 * `AccessAudit`), with the module's ports (`modulePorts`). Membership sets
 * the work cycles' room hooks; the orchestrator and the notices fill
 * their ports as they are built.
 */
export const roomsLayers = {
    switch: RoomsBaseLive.pipe(Layer.provide(workspaceParts), Layer.provideMerge(config)),
    streams: RoomStreamsLive.pipe(Layer.provide(workspaceParts)),
    membership: RoomMembershipLive.pipe(
        Layer.provide([workspaceParts, host]),
        Layer.tap((built) =>
            Effect.gen(function* () {
                const cycles = yield* LegacyCycles;
                cycles.rooms = Context.get(built, LegacyRooms).cycleHooks();
            }),
        ),
    ),
    topics: RoomTopicsLive.pipe(Layer.provide([workspaceParts, host])),
    orchestrator: RoomOrchestratorLive.pipe(
        Layer.provide([workspaceParts, host]),
        Layer.tap((built) =>
            Effect.gen(function* () {
                (yield* Ports).orchestrator.fill(Context.get(built, LegacyOrchestrator));
            }),
        ),
    ),
    notices: RoomNoticesLive.pipe(
        Layer.provide([workspaceParts, host]),
        Layer.tap((built) =>
            Effect.gen(function* () {
                (yield* Ports).roomNotices.fill(Context.get(built, LegacyRoomNotices));
            }),
        ),
        Layer.provideMerge(modulePorts),
    ),
};
