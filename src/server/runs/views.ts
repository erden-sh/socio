import type { AgentRunSource, AgentRunStatus, AgentRunSummary } from '@socio/shared/types';

import type { AccessShape } from '../rooms/contract.js';
import type { RunnerShape } from '../turns/contract.js';
import type { ConversationsShape, PeopleShape, SociosShape } from '../workspace/contract.js';

import type { RunsList, RunsViewsShape, RunTraceFound } from './contract.js';

/**
 * The run views: moved from `live/views/runs.ts`, whose copy went
 * once the issue routes read them through the `RunsViews` tag. Each takes what
 * it reads, by contract, not the platform: the runner's turns, a run's
 * source (`RunSource`) and the workspace's slices. The module builds it
 * from the services its hooks read.
 */
export interface RunViewSources {
    readonly runner: Pick<RunnerShape, 'recentRuns' | 'runTrace'>;
    /**
     * A run's source as recorded by its server-side caller; browser and
     * Telegram runs take the conversation's channel (`RunSource`).
     */
    runSource(threadId: string, recorded?: AgentRunSource | null): Promise<AgentRunSource>;
    readonly workspace: Pick<
        ConversationsShape,
        'allows' | 'archivedConversations' | 'conversations' | 'deletedThreadIds' | 'readableThread' | 'thread'
    > &
        Pick<PeopleShape, 'users'> &
        Pick<SociosShape, 'dots'> & {
            readonly roomAccess: Pick<AccessShape, 'viewerRooms'>;
        };
}

/**
 * `GET /api/runs`: the latest `limit` agent turns, newest first, leaving
 * out deleted conversations: across all users for admins, and only the
 * viewer's own conversations' with `own` (members, who don't get the
 * operator's error detail either). In a room (CB-213) `own` is by role:
 * a room admin lists every turn of the room (they may stop anyone's), a
 * member the turns their own messages started; either opens only the
 * traces of their own (`canTrace`), as `runTraceView` allows. A room's
 * turn is the person's who started it, never the room's sentinel owner.
 * Metadata, the error text and the trace summary only; never event
 * payloads or message content.
 */
export async function runsView(
    platform: RunViewSources,
    viewerId: string,
    { status, limit, own = false }: { status?: AgentRunStatus; limit: number; own?: boolean },
): Promise<RunsList> {
    const { workspace } = platform;
    const users = new Map(workspace.users().map((user) => [user.id, user]));
    const dots = new Map(workspace.dots().map((dot) => [dot.id, dot]));
    const rooms = own ? workspace.roomAccess.viewerRooms(viewerId) : [];
    const runs = platform.runner.recentRuns({
        status,
        limit,
        exclude: workspace.deletedThreadIds(),
        ...(own
            ? {
                  only: [
                      ...(await ownThreadIds(platform, viewerId)),
                      ...rooms.filter((room) => room.role === 'admin').map((room) => room.roomId),
                  ],
                  initiatedIn: {
                      threadIds: rooms.filter((room) => room.role !== 'admin').map((room) => room.roomId),
                      personId: viewerId,
                  },
              }
            : {}),
    });
    return {
        limit,
        runs: await Promise.all(
            runs.map(async (run): Promise<AgentRunSummary> => {
                const thread = workspace.thread(run.threadId);
                const room = thread?.kind === 'room';
                // A room's turn is its initiator's.
                const initiator = run.trigger?.kind === 'person' ? (run.trigger.id ?? null) : null;
                const ownerId = room ? initiator : (thread?.ownerId ?? null);
                // A member's view of a room opens only their own turns' traces;
                // an admin's view opens all (logged when not theirs, CB-188).
                const canTrace = !own || !room || initiator === viewerId;
                return {
                    runId: run.runId,
                    threadId: run.threadId,
                    status: run.status,
                    source: await platform.runSource(run.threadId, run.source),
                    startedAt: run.startedAt,
                    finishedAt: run.finishedAt,
                    error: typeof run.error === 'string' ? run.error.slice(0, 500) : null,
                    errorDetail: own ? null : run.errorDetail,
                    title: thread?.title ?? null,
                    dotName: (thread && dots.get(thread.dotId)?.name) ?? null,
                    ownerId,
                    ownerName:
                        (ownerId && users.get(ownerId)?.name) ??
                        (ownerId?.startsWith('telegram-team:') ? 'Telegram team' : null),
                    ...(room ? { room: true } : {}),
                    ...(canTrace ? {} : { canTrace: false }),
                    // A flag on a list, no request about the room: not audited.
                    readable: !!(await workspace.readableThread(viewerId, run.threadId, {
                        audit: false,
                    })),
                    trace: canTrace ? run.trace : null,
                };
            }),
        ),
    };
}

/**
 * The private conversations a person owns, archived ones too: whose turns
 * they may trace. A room's are listed by role (`runsView`).
 */
export const ownThreadIds = async (
    platform: { readonly workspace: Pick<RunViewSources['workspace'], 'archivedConversations' | 'conversations'> },
    userId: string,
) =>
    [...(await platform.workspace.conversations(userId)), ...(await platform.workspace.archivedConversations(userId))]
        .filter((thread) => thread.ownerId === userId)
        .map((thread) => thread.id);

/**
 * `GET /api/runs/:runId/trace` (CB-128): one turn's trace, for admins and
 * for the owner of its conversation (in a room, the member whose message
 * started its cycle); null (a 404) for anyone else.
 * `ownerId`, whose conversation it is, and `room`, a room turn's context
 * (the room, the person whose message started its cycle and the socio
 * that ran it: the cycle's, else the room's lead), are for the access log
 * (CB-188, CB-213) and aren't sent.
 */
export function runTraceView(
    platform: Pick<RunViewSources, 'runner' | 'workspace'>,
    viewer: { id: string; admin: boolean },
    runId: string,
): RunTraceFound | null {
    const found = platform.runner.runTrace(runId);
    // Deleted conversations' turns are gone from Runs (CB-64), traces too.
    if (!found || platform.workspace.deletedThreadIds().includes(found.threadId)) {
        return null;
    }
    const thread = platform.workspace.thread(found.threadId);
    // In a room (CB-208) a turn's trace is its cycle's initiator's, while
    // they are a member; anyone else sees it only as an admin, logged.
    const initiator = found.trace?.trigger;
    const ownerId =
        thread?.kind === 'room'
            ? initiator?.kind === 'person' &&
              initiator.id &&
              platform.workspace.allows(initiator.id, thread.id, 'read', {
                  audit: false,
              })
                ? initiator.id
                : undefined
            : thread?.ownerId;
    if (!viewer.admin && ownerId !== viewer.id) {
        return null;
    }
    const socio = found.trace?.cycle?.dotId ?? thread?.dotId;
    return {
        view: {
            runId: found.runId,
            status: found.status,
            startedAt: found.startedAt,
            finishedAt: found.finishedAt,
            trace: found.trace,
        },
        ownerId,
        ...(thread?.kind === 'room'
            ? {
                  room: {
                      room: thread.id,
                      ...(initiator?.kind === 'person' && initiator.id ? { initiator: initiator.id } : {}),
                      ...(socio ? { socio } : {}),
                  },
              }
            : {}),
    };
}

/** The run views over their sources, as the `RunsViews` tag offers them. */
export function runsViews(source: RunViewSources): RunsViewsShape {
    return {
        runsView: (viewerId, options) => runsView(source, viewerId, options),
        runTraceView: (viewer, runId) => runTraceView(source, viewer, runId),
    };
}
