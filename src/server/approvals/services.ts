import type { DatabaseSync } from 'node:sqlite';

import { sqliteData } from '@socio/data/open';
import { requesterStanding, roomApprovalLine } from '@socio/foundation/rooms/authority';
import { dotSoul, soulPrompt } from '@socio/shared/soul';

import { inferenceDecider } from './auto.js';
import { sqliteApprovalRepositories } from './infra/sqlite/index.js';
import { ApprovalService, type ApprovalOptions } from './service.js';
import type { ApprovalSources } from './sources.js';

/**
 * Approvals (CB-110) on a migrated connection: the service over the
 * SQLite repositories and the connection's unit of work.
 */
export function sqliteApprovals(db: DatabaseSync, options: ApprovalOptions = {}) {
    const data = sqliteData(db);
    return new ApprovalService(data.uow, sqliteApprovalRepositories(data), options);
}

/**
 * Approval policies and requests on the workspace's connection, and what
 * the work cycles ask of them: a cycle whose requests all settled ends.
 * The layer (`ApprovalsLive`) builds it here, so it registers the same
 * listener wherever the service is made.
 */
export function workspaceApprovals(db: DatabaseSync, sources: ApprovalSources): ApprovalService {
    const { socios, conversations, people, runner, cycles } = sources;
    const approvals = sqliteApprovals(db, {
        dotName: (id) => socios.dot(id)?.name,
        // A request belongs to the turn in progress in its conversation,
        // and to its work cycle, which carries on after it (CB-209).
        activeRun: (threadId) => runner.activeRunId(threadId),
        activeCycle: async (threadId) => (await cycles.running(threadId))?.id,
        // Never for a deactivated person (CB-528); in a room, decided and
        // run only while its person may still send there; it says where it
        // was asked (CB-209).
        standing: (request) =>
            requesterStanding(
                {
                    thread: (id) => conversations.thread(id),
                    allows: (userId, id, action) => conversations.allows(userId, id, action),
                    isDeactivated: (userId) => people.isDeactivated(userId),
                },
                request,
            ),
        room: (threadId) => {
            const thread = conversations.thread(threadId);
            return thread?.kind === 'room' ? { title: thread.title } : undefined;
        },
        roomLine: roomApprovalLine,
        // `auto` reviews on the acting user's inference (their own
        // connection first, else the default backend).
        auto: {
            decider: inferenceDecider(sources.inference),
            // The Soul in use (CB-179), as the socio reads it.
            dotRole: (id) => {
                const dot = socios.dot(id);
                return dot && soulPrompt(dotSoul(dot));
            },
        },
    });
    // A cycle that waited only for requests that all expired (or were
    // ended) has nothing to carry on: it ends now, not at the tidy-up.
    approvals.onSettled(async (threadId) => {
        await cycles.settleWaiting(threadId);
    });
    return approvals;
}
