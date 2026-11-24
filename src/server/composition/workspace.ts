/**
 * The workspace's construction: what the graph offers of it beyond the slices
 * `main.ts` provides (`WorkspaceLive`): `ChatHistory` and `WorkspaceViews`,
 * from `workspace/layer.ts`, and the port the views read beyond the workspace
 * (`WorkspaceViewSources`), over the graph's tags.
 *
 * The workspace reads no configuration of its own, so it has no
 * `WorkspaceConfig`.
 */
import { Effect, Layer } from 'effect';

import { Plugins } from '../plugins/contract.js';
import { EventReplayLive } from '../replay/layer.js';
import { Reads } from '../rooms/contract.js';
import { Dictation } from '../voice/contract.js';
import { WorkspaceViewSources, type WorkspaceViewSourcesShape } from '../workspace/contract.js';
import { ChatHistoryLive, WorkspaceViewsLive } from '../workspace/layer.js';

import { AppStatus } from './app/status.js';
import { LegacyApps } from './apps.js';
import { LegacyStore, LegacyWorkspace } from './base.js';
import { LegacyFlags } from './flags.js';
import { LegacyRoomNotices } from './rooms.js';

/**
 * What the workspace's views read beyond the store: each read when a view
 * runs, as `live/views/workspace.ts` read them. The graph's step builds it
 * from tags (`ViewSourcesLive`); the HTTP edge passes its own slice.
 */
export interface ViewSourcePlatform {
    readonly roomNotices: WorkspaceViewSourcesShape['roomNotices'];
    readonly apps: WorkspaceViewSourcesShape['apps'];
    readonly flags: WorkspaceViewSourcesShape['flags'];
    readonly store: { readonly slices: { readonly settings: { settings: WorkspaceViewSourcesShape['settings'] } } };
    readonly dictationStreams: WorkspaceViewSourcesShape['dictationStreams'];
    setup: WorkspaceViewSourcesShape['setup'];
    adminSetup: WorkspaceViewSourcesShape['adminSetup'];
    statusEpoch: WorkspaceViewSourcesShape['statusEpoch'];
    transcriptionSources: WorkspaceViewSourcesShape['transcriptionSources'];
}

/** The boot step's store's members the views read (`WorkspaceStore`). */
export interface ViewSourceWorkspace {
    readonly spaceAccess: WorkspaceViewSourcesShape['spaceAccess'];
    readonly telegram: WorkspaceViewSourcesShape['telegram'];
    readonly roomAccess: WorkspaceViewSourcesShape['roomAccess'];
    readonly counters: WorkspaceViewSourcesShape['counters'];
}

/**
 * The views' sources over the store and `platform`, read when a view runs, with the
 * rooms' read state `reads` and the installed plugins `plugins`.
 */
export function viewSourcesOf(
    workspace: ViewSourceWorkspace,
    platform: ViewSourcePlatform,
    reads: () => WorkspaceViewSourcesShape['reads'],
    plugins: () => WorkspaceViewSourcesShape['plugins'],
): WorkspaceViewSourcesShape {
    return WorkspaceViewSources.of({
        spaceAccess: {
            spacesFor: (userId) => workspace.spaceAccess.spacesFor(userId),
            readableIds: (reader) => workspace.spaceAccess.readableIds(reader),
        },
        telegram: { memberChats: (userId) => workspace.telegram.memberChats(userId) },
        roomAccess: { viewerRooms: (userId) => workspace.roomAccess.viewerRooms(userId) },
        counters: { read: (keys) => workspace.counters.read(keys) },
        reads: {
            withUnread: (userId, conversations) => reads().withUnread(userId, conversations),
            version: (userId) => reads().version(userId),
        },
        roomNotices: { withLevels: (userId, conversations) => platform.roomNotices.withLevels(userId, conversations) },
        apps: {
            get enabled() {
                return platform.apps.enabled;
            },
            promotions: { launcherFor: (userId) => platform.apps.promotions.launcherFor(userId) },
        },
        flags: { forUser: (userId) => platform.flags.forUser(userId) },
        plugins: { launcher: (person) => plugins().launcher(person) },
        settings: () => platform.store.slices.settings.settings(),
        setup: (userId) => platform.setup(userId),
        adminSetup: () => platform.adminSetup(),
        statusEpoch: () => platform.statusEpoch(),
        transcriptionSources: () => platform.transcriptionSources(),
        dictationStreams: { recordingsOnly: (provider) => platform.dictationStreams.recordingsOnly(provider) },
    });
}

/**
 * `WorkspaceViewSources` over the boot step's store and the graph's tags:
 * the room notices, apps, flags and store, live dictation (`Dictation`),
 * the app's status (`AppStatus`), rooms' `Reads` and `Plugins`.
 */
const ViewSourcesLive = Layer.effect(
    WorkspaceViewSources,
    Effect.gen(function* () {
        const status = yield* AppStatus;
        const sources: ViewSourcePlatform = {
            roomNotices: yield* LegacyRoomNotices,
            apps: yield* LegacyApps,
            flags: yield* LegacyFlags,
            store: yield* LegacyStore,
            dictationStreams: yield* Dictation,
            setup: (userId) => status.setup(userId),
            adminSetup: () => status.adminSetup(),
            statusEpoch: () => status.statusEpoch(),
            transcriptionSources: () => status.transcriptionSources(),
        };
        const reads = yield* Reads;
        const plugins = yield* Plugins;
        return viewSourcesOf(
            yield* LegacyWorkspace,
            sources,
            () => reads,
            () => plugins,
        );
    }),
);

/**
 * The workspace's step of the graph: `ChatHistory` and `WorkspaceViews`.
 * `ChatHistory` replays through replay's `EventReplay`, provided here
 * (it holds nothing: `replayMessages` on the calling thread), since
 * replay's own bridges come after this step.
 */
export const workspaceLayers = {
    bridges: Layer.mergeAll(
        ChatHistoryLive.pipe(Layer.provide(EventReplayLive)),
        WorkspaceViewsLive.pipe(Layer.provide(ViewSourcesLive)),
    ),
};
