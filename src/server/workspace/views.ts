/**
 * The shell's views of the workspace (`WorkspaceViews`, contract.ts):
 * `live/views/workspace.ts` and `workspaceVersion` from
 * `live/view-versions.ts`, moved here. The pages read them through the tag;
 * live's copies are gone.
 */
import { dictationSetup, transcriptionProvider } from '@socio/foundation/voice/transcription-provider';
import { isAdmin } from '@socio/shared/roles';
import { canCreateSpaces } from '@socio/shared/spaces/create-permission';
import type { Dot, User, WorkspacePermissions, WorkspaceState } from '@socio/shared/types';

import type {
    ConversationsShape,
    PeopleShape,
    SociosShape,
    WorkspaceViewSourcesShape,
    WorkspaceViewsShape,
} from './contract.js';

/** The workspace's own slices the views read. */
export type WorkspaceViewSlices = Pick<SociosShape, 'dotsFor'> &
    Pick<ConversationsShape, 'conversations' | 'archivedConversations' | 'callsFor'> &
    Pick<PeopleShape, 'preferences'>;

/** The views over the workspace's slices and what they read beyond them. */
export function workspaceViews(
    workspace: WorkspaceViewSlices,
    sources: WorkspaceViewSourcesShape,
): WorkspaceViewsShape {
    // A Dot's Spaces as `viewer` sees them: only those they may read.
    const dotIn = (readable: ReadonlySet<string>, dot: Dot) => ({
        ...dot,
        spaceIds: dot.spaceIds.filter((id) => readable.has(id)),
    });
    const dotForViewer = (viewer: string, dot: Dot) => dotIn(sources.spaceAccess.readableIds({ userId: viewer }), dot);
    const workspacePermissions = (user: User): WorkspacePermissions => ({
        createSpaces: canCreateSpaces(user, sources.settings()),
    });
    return {
        dotForViewer,
        workspacePermissions,
        workspaceView: async (user: User): Promise<WorkspaceState> => {
            // What the person may read, asked once for all their Dots (CB-374).
            const readable = sources.spaceAccess.readableIds({ userId: user.id });
            return {
                user,
                // The Spaces this person may read, private ones marked (CB-181): a
                // Space they may not read is never named to them.
                spaces: sources.spaceAccess.spacesFor(user.id),
                // The company's Dots and the person's own.
                // Archived ones last, flagged, so their chats still show their name.
                dots: workspace.dotsFor(user.id, { archived: true }).map((dot) => dotIn(readable, dot)),
                // Each room with how much is new to this reader (CB-215).
                // And what of it reaches them, when not the default (CB-216).
                conversations: await sources.roomNotices.withLevels(
                    user.id,
                    await sources.reads.withUnread(user.id, await workspace.conversations(user.id)),
                ),
                archived: await workspace.archivedConversations(user.id),
                // The data key and backups are for admins (CB-62, CB-63).
                setup: isAdmin(user)
                    ? { ...(await sources.setup(user.id)), ...(await sources.adminSetup()) }
                    : await sources.setup(user.id),
                calls: workspace.callsFor(user.id),
                preferences: workspace.preferences(user.id),
                // Promoted mini apps this user may open: launcher entries.
                workspaceApps: sources.apps.promotions.launcherFor(user.id),
                // Feature flags, evaluated for this person on the server (CB-169).
                flags: sources.flags.forUser(user.id),
                // Installed plugins this person may open: their audience (CB-254).
                plugins: sources.plugins.launcher(user),
                // What this person may do, from their role and the settings.
                permissions: workspacePermissions(user),
                // Whether a thumbs-down may carry an AI reply report (CB-382).
                replyReports: sources.replyReports?.() ?? null,
            };
        },
        /**
         * The user (name and role come from the session), Spaces, Dots, their
         * own conversations, Telegram team topics and rooms they are in (with
         * each room's unread count, CB-215), their calls, the launcher (apps,
         * and the Spaces, Dots and users it checks; nothing when mini apps are
         * off), setup (inference, their own connections, `statusEpoch`,
         * dictation's flags), what they may do (`permissions`, from their role
         * and an admin's settings), and for admins the data key's counts.
         */
        workspaceVersion: async (user: User) => {
            // Team topics are owned by `telegram-team:<chatId>` (change-counters.ts).
            const teams = (await sources.telegram.memberChats(user.id)).map(
                (chatId) => `threads:telegram-team:${chatId}`,
            );
            // Rooms are owned by `room:<id>`: each active member reads its key
            // (CB-208); their own membership changes bump `threads:<userId>`.
            const rooms = sources.roomAccess.viewerRooms(user.id).map(({ roomId }) => `threads:room:${roomId}`);
            const counters = sources.counters.read([
                'spaces',
                'dots',
                // The launcher checks that the user exists; empty without mini apps.
                ...(sources.apps.enabled ? ['apps', 'users'] : []),
                'inference',
                `threads:${user.id}`,
                `telegram-members:${user.id}`,
                ...teams,
                ...rooms,
                `calls:${user.id}`,
                `inference:${user.id}`,
                `preferences:${user.id}`,
                // Feature flags' rules and plans, and the person's own choices (CB-169).
                'flags',
                `flags:${user.id}`,
                // Installed plugins and their audiences: everyone's launcher (CB-254).
                'plugins',
                // Admins let in the socios rooms ask for (CB-212).
                ...(isAdmin(user) ? ['seals', 'room-socios'] : []),
            ]);
            // Server dictation and its live text (CB-222) follow an admin's
            // transcription settings, which no counter covers.
            const dictation = dictationSetup(
                transcriptionProvider(sources.transcriptionSources(), sources.settings()),
                sources.dictationStreams,
            );
            // Each room's unread count (CB-215): a turn that ended in a room is
            // stored by the runs, which bump no counter.
            const unread = await sources.reads.version(user.id);
            // What the person may do follows an admin's settings, which no counter covers.
            const permissions = workspacePermissions(user);
            // Reply reports' sharing and consent follow an admin's setting and the cloud connection, which no counter covers.
            const replyReports = sources.replyReports?.() ?? null;
            return `${JSON.stringify(user)}|${counters}|${unread}|${sources.statusEpoch()}|${JSON.stringify(dictation)}|${JSON.stringify(permissions)}|${JSON.stringify(replyReports)}`;
        },
    };
}
