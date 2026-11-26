/**
 * The workspace's routes at the HTTP edge. Under `/api`, in today's order: the
 * pages', a chat's history (CB-136), reactions (CB-133), steering (CB-151), the
 * socios' admin view (dot-admin.ts), the Souls (CB-179), the workspace's own
 * routes, then the name-suggestion card (CB-292). They share one error handler
 * (`workspaceRouteError`), as they did when the workspace's routes mounted the
 * others.
 *
 * The routes read one slice of the app's services (`workspaceSlice`),
 * made once at mount from the edge's tags: the workspace's
 * slices, the conversation steps (`ConversationAdmin`), the turns edge
 * (`AppTurns`) and the status (`AppStatus`). The shell's views go through
 * `workspaceViews` over the same sources the `WorkspaceViews` tag reads
 * (`composition/workspace.ts`). They don't run through `handle(...)`: the
 * slices are synchronous.
 */
import { Context } from 'effect';
import { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import type { ModelChoice } from '@socio/shared/inference';

import { SuggestionsRepo, type ChatNameRoutesDeps } from '../../chat-name-suggestions/contract.js';
import { chatNameRoutes } from '../../chat-name-suggestions/routes.js';
import { ReplyReports } from '../../cloud/contract.js';
import { reactionRoutes } from '../../context/reaction-routes.js';
import { steeringRoutes } from '../../context/steering-routes.js';
import { dotAdminRoutes } from '../../dots/dot-admin.js';
import { Flags } from '../../flags/contract.js';
import { SqliteBoardService } from '../../issues/layer.js';
import type { AppEdge, AppServices } from '../../main.js';
import { PageMoves } from '../../pages/contract.js';
import { pageRoutes } from '../../pages/page-routes.js';
import { replayMessages } from '../../replay/replay.js';
import { roomReads } from '../../rooms/read-state.js';
import { roomReaderEvents } from '../../rooms/reader-events.js';
import { soulRoutes } from '../../souls/soul-routes.js';
import { Releases } from '../../updates/contract.js';
import { Dictation } from '../../voice/contract.js';
import type { VoiceService } from '../../voice/voice.js';
import { historyRoutes } from '../../workspace/chat-history.js';
import { workspaceViews } from '../../workspace/views.js';
import { workspaceRoutes as workspaceApiRoutes, workspaceRouteError } from '../../workspace/workspace-routes.js';
import { ConversationAdmin, runSourceOf } from '../app/conversations.js';
import { AppStatus } from '../app/status.js';
import { AppTurns } from '../app/turns.js';
import { LegacyApprovals } from '../approvals.js';
import { LegacyApps } from '../apps.js';
import { LegacyConfig, LegacyRunner, LegacyStore, LegacyWorkspace } from '../base.js';
import { LegacySteering } from '../context.js';
import { LegacyCycles } from '../cycles.js';
import { LegacyData } from '../dataspace.js';
import { dotAdminWeb } from '../dots.js';
import { LegacyInference } from '../inference.js';
import { LegacyMedia } from '../media.js';
import { LegacyPages } from '../pages.js';
import { LegacyPlugins } from '../plugins.js';
import { Ports } from '../ports.js';
import { LegacyRoomNotices, LegacyRooms, LegacyRoomStreams } from '../rooms.js';
import { LegacyGoals, LegacyJobs } from '../schedules.js';
import { LegacySpaceCreation } from '../spaces.js';
import { viewSourcesOf } from '../workspace.js';

/**
 * What the workspace's routes read, made once per edge (`workspaceSlice`):
 * each feature's structural `...Sources` type is met by it. It is also the
 * key of `roomReads`'s cache, so it must stay one object per runtime.
 */
export type WorkspaceSlice = ReturnType<typeof makeWorkspaceSlice>;

function makeWorkspaceSlice(services: AppEdge['services']) {
    const get = <I extends AppServices, S>(tag: Context.Key<I, S>) => Context.get(services, tag);
    const workspace = get(LegacyWorkspace);
    const ports = get(Ports);
    const conversations = get(ConversationAdmin);
    const turns = get(AppTurns);
    const status = get(AppStatus);
    const replyReports = get(ReplyReports);
    const releases = get(Releases);
    // The delegations return the service's own promise, not an `async`
    // wrapper's, so each settles on the same microtask as the service's.
    return {
        workspace,
        store: get(LegacyStore),
        config: get(LegacyConfig),
        runner: get(LegacyRunner),
        roomStreams: get(LegacyRoomStreams),
        rooms: get(LegacyRooms),
        roomNotices: get(LegacyRoomNotices),
        media: get(LegacyMedia),
        pages: get(LegacyPages),
        pageMoves: get(PageMoves),
        // The datasets placed in each Space, for its items list (CB-451).
        data: get(LegacyData),
        board: get(SqliteBoardService),
        cycles: get(LegacyCycles),
        steering: get(LegacySteering),
        approvals: get(LegacyApprovals),
        goals: get(LegacyGoals),
        jobs: get(LegacyJobs),
        spaceCreation: get(LegacySpaceCreation),
        inference: get(LegacyInference),
        apps: get(LegacyApps),
        // `Flags`, the contract tag, as the flag routes read it (one instance with `LegacyFlags`).
        flags: get(Flags),
        plugins: get(LegacyPlugins),
        chatNamesRepo: get(SuggestionsRepo),
        dictationStreams: get(Dictation),
        // AI reply reports (CB-382): the reactions file them, the workspace view says whether they are on.
        reports: replyReports,
        replyReports,
        version: () => releases.data().version,
        /** Whether the server is draining (CB-37): its late port, read when a request runs. */
        get draining() {
            return ports.draining.get();
        },
        runSource: runSourceOf(workspace),
        archiveDot: (id: string, actor: string) => conversations.archiveDot(id, actor),
        createConversation: (dotId: string, title: string, userId: string, inference?: ModelChoice | null) =>
            conversations.create(dotId, title, userId, inference),
        deletion: (id: string, userId: string) => conversations.deletion(id, userId),
        deleteConversation: (id: string, userId: string, now?: number) => conversations.delete(id, userId, now),
        handle: (request: Request, userId: string) => turns.handle(request, userId),
        setup: (userId?: string) => status.setup(userId),
        adminSetup: () => status.adminSetup(),
        statusEpoch: () => status.statusEpoch(),
        transcriptionSources: () => status.transcriptionSources(),
    };
}

/** One slice per edge's services, so `roomReads` keeps one read state per runtime. */
const slices = new WeakMap<AppEdge['services'], WorkspaceSlice>();
/** The workspace routes' slice of the edge's services: the same object for the same services. */
export function workspaceSlice(edge: AppEdge): WorkspaceSlice {
    let slice = slices.get(edge.services);
    if (!slice) {
        slice = makeWorkspaceSlice(edge.services);
        slices.set(edge.services, slice);
    }
    return slice;
}

export function mountWorkspaceRoutes(app: Hono<AppEnv>, edge: AppEdge, voice: VoiceService) {
    const slice = workspaceSlice(edge);
    const { workspace, runner } = slice;
    const api = new Hono<AppEnv>();
    api.route('/', pageRoutes(slice));
    // A chat's history for the browser's store (CB-136), its rooms' reader
    // filter and the replay of its stored events beside what the slice holds.
    api.route(
        '/',
        historyRoutes({
            workspace,
            runner,
            roomNotices: slice.roomNotices,
            roomStreams: slice.roomStreams,
            readerEvents: roomReaderEvents,
            replay: { messages: replayMessages },
        }),
    );
    // Reactions on a Dot's messages (CB-133).
    api.route('/', reactionRoutes(slice, { messages: replayMessages }));
    // Messages sent while a Dot's turn runs (CB-151).
    api.route('/', steeringRoutes(slice));
    // Every Dot, with its audit, for admins (dot-admin.ts).
    api.route('/', dotAdminRoutes(slice, dotAdminWeb(slice)));
    // Each socio's Soul and its versions (CB-179, soul-routes.ts).
    api.route('/', soulRoutes(slice));
    const views = workspaceViews(
        workspace,
        viewSourcesOf(
            workspace,
            slice,
            () => roomReads(slice),
            () => slice.plugins,
        ),
    );
    api.route('/', workspaceApiRoutes(slice, voice, views));
    // CB-292: the inline name-suggestion card (read / accept / reject /
    // customize). Authorization: room admins for shared rooms, the owner for
    // single-user chats. No name is applied without explicit approval.
    api.route(
        '/',
        chatNameRoutes({
            repo: slice.chatNamesRepo,
            applyName: (threadId, name) => workspace.renameThread(threadId, name)?.title,
            mayReview: (threadId, userId) => {
                const thread = workspace.thread(threadId);
                if (!thread) {
                    return false;
                }
                if (thread.kind === 'room') {
                    const member = workspace.roomAccess.viewer(thread, userId).member;
                    return member?.status === 'active' && member.role === 'admin';
                }
                return thread.ownerId === userId;
            },
            messageCount: (threadId) => runner.messages(threadId).then((m) => m.length),
        } satisfies ChatNameRoutesDeps),
    );
    api.onError(workspaceRouteError);
    app.route('/api', api);
}

/** The workspace's step, as index.ts mounts it: its routes. */
export const workspaceRoutes = { routes: mountWorkspaceRoutes };
