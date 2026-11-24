/**
 * Rooms' layers: they implement `contract.ts`.
 * Only the composition root (`composition/rooms.ts`) and tests import this
 * file.
 *
 * What rooms needs of the features below it in the folder order
 * (scripts/feature-ranks.json) it yields by their contracts' tags:
 * `Cycles`, `Notifier`, `UserPresence`, `WorkspaceSettings`, `Limits`,
 * `Runner`. What it needs of the rest it declares here, and the
 * composition root provides:
 *
 * - `RoomsWorkspace`: what rooms reads of the workspace store
 *   (`RoomsWorkspaceShape`, services.ts), `WorkspaceStore` itself.
 * - `RoomsHost`: what rooms asks of the composition and its late-bound ports
 *   and of service accounts and the steering queue.
 *
 * Each service is made by one function here (`roomsSwitch`,
 * `roomStreams`, `roomMembership`, `roomTopics`, `roomOrchestrator`,
 * `roomNotices`), which the layers call, so each service registers its
 * listeners in the same order.
 *
 * The services' classes are also offered by class-typed tags
 * (`LegacyRooms`, ...), which the other steps and the routes read them
 * from.
 */
import { Context, Effect, Layer } from 'effect';

import { sqliteData } from '@socio/data/open';
import { roomsSettings } from '@socio/foundation/rooms/settings';

import { Cycles, type CyclesShape } from '../cycles/contract.js';
import { Notifier, UserPresence, type NotifierShape, type UserPresenceShape } from '../notifications/contract.js';
import { Limits, WorkspaceSettings, type LimitsShape, type WorkspaceSettingsShape } from '../settings/contract.js';
import { Runner, type PlatformTurnOptions, type RunnerShape } from '../turns/contract.js';

import {
    Access,
    Notices,
    Orchestrator,
    ReaderEvents,
    Reads,
    RoomEvents,
    Rooms,
    RoomsConfig,
    Streams,
    Topics,
    type RoomEventsShape,
    type RoomsConfigShape,
} from './contract.js';
import { sqliteRoomRepositories } from './infra/sqlite/repositories.js';
import type { RoomMembership } from './membership.js';
import type { RoomNotices } from './notices.js';
import { RoomOrchestrator } from './orchestrator.js';
import { RoomReads } from './read-state.js';
import { readerFilter } from './reader-events.js';
import { sqliteRoomMembership, sqliteRoomNotices, sqliteRoomTopics, type RoomsWorkspaceShape } from './services.js';
import { RoomStreams } from './streams.js';
import {
    LegacyOrchestrator,
    LegacyRoomNotices,
    LegacyRooms,
    LegacyRoomStreams,
    LegacyRoomTopics,
    RoomsWorkspace,
} from './tags.js';
import type { RoomTopics } from './telegram-topics.js';

// ── What the composition root provides ───────────────────────────────────

/** The workspace store, as rooms reads it: in `tags.ts` so the module can read it. */
export { RoomsWorkspace };

/**
 * What rooms asks of the composition, its late-bound ports and the features
 * above it, at the moment of use.
 */
export interface RoomsHostShape {
    /** `RoomWork.revoke`: ends work nobody may do any more. */
    revoke(roomId: string, userId?: string): Promise<void>;
    /** `AppTurns.turnOutcome`: a socio's step in a room. */
    turnOutcome(threadId: string, prompt: string, signal: AbortSignal, options: PlatformTurnOptions): Promise<unknown>;
    /** This runtime drains: nothing new starts. */
    draining(): boolean;
    /** The steering turns: the room's queue may go on. */
    settled(threadId: string): void;
    /** The room notices (built after membership): a person was invited. */
    invited(roomId: string, by: string, userId: string, at: number): void;
    /** A service account (they are never in a room). */
    isService(userId: string): boolean;
    /** The ids of the messages waiting in the conversation's steering queues. */
    queued(threadId: string): Promise<Set<string>>;
}

export class RoomsHost extends Context.Service<RoomsHost, RoomsHostShape>()('socio/rooms/RoomsHost') {}

// ── The services' classes, under their own tags ──────────────────────────

/** Whether Rooms are on, as the access rule and the rooms' services read it. */
export class RoomsSwitch extends Context.Service<RoomsSwitch, () => boolean>()('socio/rooms/RoomsSwitch') {}

/** The services' classes: in `tags.ts` so the module can read them. */
export { LegacyOrchestrator, LegacyRoomNotices, LegacyRooms, LegacyRoomStreams, LegacyRoomTopics };

// ── The services, made the same way on both paths ────────────────────────

/** The switch the access rule reads, set on the workspace; returned for the services that read it too. */
export function roomsSwitch(deps: {
    settings: Pick<WorkspaceSettingsShape, 'settings'>;
    config: RoomsConfigShape;
    workspace: Pick<RoomsWorkspaceShape, 'useRooms'>;
}): () => boolean {
    const { settings, config } = deps;
    const roomsOn = () => roomsSettings(settings.settings(), config.rooms).enabled;
    deps.workspace.useRooms(roomsOn);
    return roomsOn;
}

/** Open live streams (CB-212), checked again on each access change. */
export function roomStreams(workspace: RoomsWorkspaceShape, roomsOn: () => boolean): RoomStreams {
    const streams = new RoomStreams(workspace.db, {
        mayRead: (roomId, userId) =>
            !workspace.isDeactivated(userId) &&
            // A re-check is no request of theirs: nothing to audit.
            workspace.allows(userId, roomId, 'read', { audit: false }),
        roomsOn,
        log: (line) => console.log(line),
    });
    // A person deactivated, a chat archived: open streams are checked now.
    workspace.onAccessChange(() => {
        if (streams.count()) {
            streams.recheck();
        }
    });
    return streams;
}

/** Rooms' membership and lifecycle (CB-208). */
export function roomMembership(deps: {
    workspace: RoomsWorkspaceShape;
    settings: Pick<WorkspaceSettingsShape, 'settings'>;
    limits: Pick<LimitsShape, 'cycleLimits'>;
    config: RoomsConfigShape;
    cycles: Pick<CyclesShape, 'checkRoomLimits' | 'usage'>;
    streams: Pick<RoomStreams, 'end'>;
    roomsOn: () => boolean;
    host: Pick<RoomsHostShape, 'revoke' | 'invited' | 'isService'>;
}): RoomMembership {
    const { workspace, settings, config, cycles, host } = deps;
    return sqliteRoomMembership(workspace.db, {
        workspace,
        enabled: deps.roomsOn,
        people: {
            invitable: (userId) =>
                workspace.hasUser(userId) && !workspace.isDeactivated(userId) && !host.isService(userId),
            name: (userId) => workspace.users().find((user) => user.id === userId)?.name,
            active: (userId) => !workspace.isDeactivated(userId),
            list: () => workspace.users().map((user) => ({ id: user.id, name: user.name })),
        },
        limits: {
            workspace: () => deps.limits.cycleLimits(settings.settings()),
            check: (change) => cycles.checkRoomLimits(change),
        },
        // A room's use for its people (CB-218), from the cycles' ledger.
        usage: {
            visible: () => roomsSettings(settings.settings(), config.rooms).budgetVisible,
            cycles: (roomId, since) => cycles.usage(roomId, since),
        },
        revoke: (roomId, userId) => host.revoke(roomId, userId),
        // Their live streams end at once, everywhere (CB-212).
        ended: (roomId, userId, reason) => deps.streams.end(roomId, userId, reason),
        // The person invited hears of it (CB-216).
        invited: (roomId, by, userId, at) => host.invited(roomId, by, userId, at),
    });
}

/** Rooms' Telegram forum topics (CB-214). */
export function roomTopics(deps: {
    workspace: RoomsWorkspaceShape;
    rooms: RoomMembership;
    roomsOn: () => boolean;
    host: Pick<RoomsHostShape, 'isService'>;
}): RoomTopics {
    const { workspace, host } = deps;
    return sqliteRoomTopics(workspace.db, {
        membership: deps.rooms,
        workspace,
        people: {
            name: (userId) => workspace.users().find((user) => user.id === userId)?.name,
            invitable: (userId) =>
                workspace.hasUser(userId) && !workspace.isDeactivated(userId) && !host.isService(userId),
        },
        enabled: deps.roomsOn,
    });
}

/** Turn-taking between a room's socios (CB-206). */
export function roomOrchestrator(deps: {
    workspace: RoomsWorkspaceShape;
    settings: Pick<WorkspaceSettingsShape, 'settings'>;
    runner: Pick<RunnerShape, 'activeRunId' | 'onRunFinished' | 'runTrace'>;
    cycles: CyclesShape;
    host: Pick<RoomsHostShape, 'turnOutcome' | 'draining' | 'settled'>;
}): RoomOrchestrator {
    const { workspace, settings, host } = deps;
    return new RoomOrchestrator({
        handoffs: sqliteRoomRepositories(sqliteData(workspace.db)).handoffs,
        cycles: deps.cycles,
        workspace,
        runner: deps.runner,
        start: (threadId, note, signal, options) =>
            host.turnOutcome(threadId, note, signal, {
                ...options,
                trigger: options.context.initiator,
            }),
        idle: () => host.draining() || settings.settings().paused,
        // Nothing more in its cycle: the room's queue goes on.
        settled: (threadId) => host.settled(threadId),
        log: (line) => console.log(line),
    });
}

/** Rooms' notices (CB-216): checked as each turn in a room ends. */
export function roomNotices(deps: {
    workspace: RoomsWorkspaceShape;
    runner: Pick<RunnerShape, 'messages' | 'onRunFinished'>;
    notifier: Pick<NotifierShape, 'notifyPerson'>;
    presence: UserPresenceShape;
    host: Pick<RoomsHostShape, 'queued'>;
}): RoomNotices {
    const { workspace, runner, notifier, host } = deps;
    const notices = sqliteRoomNotices(workspace.db, {
        workspace,
        runner,
        notifications: { notifyPerson: (notice) => notifier.notifyPerson(notice), presence: deps.presence },
        queued: (threadId) => host.queued(threadId),
        log: (line) => console.log(line),
    });
    runner.onRunFinished((threadId, status, run) => void notices.runFinished(threadId, status, run));
    return notices;
}

// ── Layers ───────────────────────────────────────────────────────────────

/** A second tag over the instance another tag holds: the contract's slice of a class. */
const alias = <I, S, J, T extends S>(to: Context.Key<I, S>, from: Context.Key<J, T>) =>
    Layer.effect(
        to,
        Effect.gen(function* () {
            return yield* from;
        }),
    );

/** The switch, set on the workspace's access rule as it is built. */
export const RoomsSwitchLive = Layer.effect(
    RoomsSwitch,
    Effect.gen(function* () {
        return roomsSwitch({
            settings: yield* WorkspaceSettings,
            config: yield* RoomsConfig,
            workspace: yield* RoomsWorkspace,
        });
    }),
);

/** The access rule the workspace holds. */
export const AccessLive = Layer.effect(
    Access,
    RoomsWorkspace.useSync((workspace) => workspace.roomAccess),
);

/** One reader's view of a room's events. */
export const ReaderEventsLive = Layer.succeed(ReaderEvents, ReaderEvents.of({ filter: readerFilter }));

/** The room audit, its repository made on first use. */
export const RoomEventsLive = Layer.effect(
    RoomEvents,
    Effect.gen(function* () {
        const { db } = yield* RoomsWorkspace;
        let events: RoomEventsShape | undefined;
        return RoomEvents.of({
            append: (event) => (events ??= sqliteRoomRepositories(sqliteData(db)).events).append(event),
        });
    }),
);

/** Each member's read state, made on first use. */
export const ReadsLive = Layer.effect(
    Reads,
    Effect.gen(function* () {
        const { db } = yield* RoomsWorkspace;
        const runner = yield* Runner;
        let reads: RoomReads | undefined;
        const made = () => (reads ??= new RoomReads(sqliteRoomRepositories(sqliteData(db)).reads, runner));
        return Reads.of({
            withUnread: (userId, conversations) => made().withUnread(userId, conversations),
            version: (userId) => made().version(userId),
        });
    }),
);

/**
 * The switch's step: the switch, then what reads only the workspace (the
 * access rule, the reader filter, the room audit, the read state).
 */
export const RoomsBaseLive = Layer.mergeAll(AccessLive, ReaderEventsLive, RoomEventsLive, ReadsLive).pipe(
    Layer.provideMerge(RoomsSwitchLive),
);

/** Open live streams (`Streams`, and the class). */
export const RoomStreamsLive = alias(Streams, LegacyRoomStreams).pipe(
    Layer.provideMerge(
        Layer.effect(
            LegacyRoomStreams,
            Effect.gen(function* () {
                return roomStreams(yield* RoomsWorkspace, yield* RoomsSwitch);
            }),
        ),
    ),
);

/** Rooms' membership (`Rooms`, and the class). */
export const RoomMembershipLive = alias(Rooms, LegacyRooms).pipe(
    Layer.provideMerge(
        Layer.effect(
            LegacyRooms,
            Effect.gen(function* () {
                return roomMembership({
                    workspace: yield* RoomsWorkspace,
                    settings: yield* WorkspaceSettings,
                    limits: yield* Limits,
                    config: yield* RoomsConfig,
                    cycles: yield* Cycles,
                    streams: yield* LegacyRoomStreams,
                    roomsOn: yield* RoomsSwitch,
                    host: yield* RoomsHost,
                });
            }),
        ),
    ),
);

/** Rooms' Telegram topics (`Topics`, and the class). */
export const RoomTopicsLive = alias(Topics, LegacyRoomTopics).pipe(
    Layer.provideMerge(
        Layer.effect(
            LegacyRoomTopics,
            Effect.gen(function* () {
                return roomTopics({
                    workspace: yield* RoomsWorkspace,
                    rooms: yield* LegacyRooms,
                    roomsOn: yield* RoomsSwitch,
                    host: yield* RoomsHost,
                });
            }),
        ),
    ),
);

/** Turn-taking in rooms (`Orchestrator`, and the class). */
export const RoomOrchestratorLive = alias(Orchestrator, LegacyOrchestrator).pipe(
    Layer.provideMerge(
        Layer.effect(
            LegacyOrchestrator,
            Effect.gen(function* () {
                return roomOrchestrator({
                    workspace: yield* RoomsWorkspace,
                    settings: yield* WorkspaceSettings,
                    runner: yield* Runner,
                    cycles: yield* Cycles,
                    host: yield* RoomsHost,
                });
            }),
        ),
    ),
);

/** Rooms' notices (`Notices`, and the class). */
export const RoomNoticesLive = alias(Notices, LegacyRoomNotices).pipe(
    Layer.provideMerge(
        Layer.effect(
            LegacyRoomNotices,
            Effect.gen(function* () {
                return roomNotices({
                    workspace: yield* RoomsWorkspace,
                    runner: yield* Runner,
                    notifier: yield* Notifier,
                    presence: yield* UserPresence,
                    host: yield* RoomsHost,
                });
            }),
        ),
    ),
);
