import { randomUUID } from 'node:crypto';

import type { AgentActor } from '@socio/foundation/agents/actor';
import {
    issueKey,
    type AgentAttribution,
    type AgentBoardActivity,
    type IssueEvent,
} from '@socio/shared/issues/issue-types';

import type { AgentBoardAction, BoardAgentActions } from './contract.js';
import type { BoardAuditRepository, BoardQueries } from './domain/repositories.js';

const VERBS: Record<AgentBoardAction, string> = {
    create: 'filed',
    comment: 'commented on',
    vote: 'voted for',
    unvote: 'withdrew the vote on',
    update: 'changed',
};

/**
 * What connected agents did on the board (CB-90), beside the records they
 * made, which stay the person's: one `issue_agent_actions` row per action,
 * with the client, the grant, the person's label for it and the person.
 * A file it attaches is an `update` row on its `attachment_added` event.
 * The issue detail reads it to show "‹label› for ‹person›"; the admin
 * audit reads a grant's lines.
 */
export class AgentActions implements BoardAgentActions {
    constructor(
        private audit: BoardAuditRepository,
        private queries: BoardQueries,
    ) {}

    /** Writes the row; callers do it in the unit of work of what it records. */
    record(actor: AgentActor, action: AgentBoardAction, issueId: string, targetId: string | null, now = Date.now()) {
        return this.audit.recordAgent({
            id: randomUUID(),
            issueId,
            action,
            targetId,
            grantId: actor.grantId,
            clientId: actor.clientId,
            clientName: actor.clientName,
            // The person may leave the label empty: the client's name then.
            label: actor.label.trim() || actor.clientName,
            userId: actor.userId,
            createdAt: now,
        });
    }

    /** The agent that filed the issue, if one did. */
    async filing(issueId: string): Promise<AgentAttribution | undefined> {
        return (await this.audit.agentActions(issueId)).find((row) => row.action === 'create')?.attribution;
    }

    /** The agent behind each of the issue's comments that one made. */
    async commentAttributions(issueId: string): Promise<Map<string, AgentAttribution>> {
        return new Map(
            (await this.audit.agentActions(issueId))
                .filter((row) => row.action === 'comment')
                .map((row) => [String(row.targetId), row.attribution]),
        );
    }

    /**
     * The agent behind each of these history rows that one made: the
     * filing's `created`, a comment's `comment_added`, an update's rows.
     */
    async eventAttributions(issueId: string, events: readonly IssueEvent[]): Promise<Map<string, AgentAttribution>> {
        const rows = await this.audit.agentActions(issueId);
        const filed = rows.find((row) => row.action === 'create');
        const targets = new Map(
            rows
                .filter((row) => row.action === 'comment' || row.action === 'update')
                .map((row) => [String(row.targetId), row.attribution]),
        );
        const found = new Map<string, AgentAttribution>();
        for (const event of events) {
            const agent =
                event.kind === 'created'
                    ? filed?.attribution
                    : event.kind === 'comment_added'
                      ? targets.get(event.toValue ?? '')
                      : targets.get(event.id);
            if (agent) {
                found.set(event.id, agent);
            }
        }
        return found;
    }

    /**
     * A grant's board actions, newest first, at or before `before` (ms):
     * for the admin audit of connected agents.
     */
    async activity(
        grantId: string,
        { before = Number.MAX_SAFE_INTEGER, limit = 100 } = {},
    ): Promise<AgentBoardActivity[]> {
        return (await this.queries.agentActivity(grantId, before, limit)).map((row) => {
            const action = row.action;
            const issue = row.number === null ? null : issueKey(row.number);
            return {
                at: row.createdAt,
                action,
                issue,
                targetId: row.targetId,
                userId: row.userId,
                // A file it attached is recorded as an update, on its history row.
                summary: `${row.field === 'attachment_added' ? 'attached a file to' : `${VERBS[action]}${row.field ? ` the ${row.field} of` : ''}`} ${issue ?? 'an item'}${row.title ? ` “${row.title}”` : ''}`,
            };
        });
    }
}
