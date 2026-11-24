import type { UnitOfWork } from '@socio/data/uow';
import type { IssueArea, IssueKind, IssueLabel, IssuePriority, TriageState } from '@socio/shared/issues/issue-types';

import type { BoardTriage, StoredTriageProposal } from './contract.js';
import type { TriageRepository } from './domain/repositories.js';

/** What the model proposed, once validated (auto-triage.ts). */
export interface TriageFields {
    kind: IssueKind;
    area: IssueArea | null;
    priority: IssuePriority;
    labels: IssueLabel[];
    /** Suggested component refs, as stored (an app's with its generation). */
    components: string[];
    reason: string;
    /**
     * 'admins' when the model was shown names some members can't see, so
     * its reason may name them: only admins read it (CB-442).
     */
    reasonAudience?: 'admins' | null;
}

/**
 * Automatic triage of new issues (CB-30): one row per issue. It starts
 * `pending` (the model is being asked), becomes `proposed` with the fields
 * and the comment that carries them, then `applied` or `ignored` by an
 * admin, or ends `failed` with why. A row is never asked again, so a model
 * that errors can't cause a retry storm; the day's rows are the daily cap.
 */
export class TriageProposals implements BoardTriage {
    constructor(
        private uow: UnitOfWork,
        private triage: TriageRepository,
    ) {}

    /** Whether the issue was asked about, whatever came of it. */
    async has(issueId: string) {
        return !!(await this.triage.get(issueId));
    }

    /** The proposal as the issue shows it; none while pending or failed. */
    async get(issueId: string): Promise<StoredTriageProposal | undefined> {
        const row = await this.triage.get(issueId);
        if (!row || row.state === 'pending' || row.state === 'failed') {
            return undefined;
        }
        return {
            state: row.state,
            kind: row.kind!,
            area: row.area,
            priority: row.priority!,
            labels: row.labels!,
            // As stored: the views keep only what the reader may see (CB-442).
            components: row.components ?? [],
            reason: row.reason!,
            reasonAudience: row.reasonAudience ?? null,
            commentId: row.commentId,
            createdAt: row.createdAt,
            decidedAt: row.decidedAt,
            decidedBy: row.decidedBy,
        };
    }

    /** Why the model's answer for the issue failed, if it did. */
    async failure(issueId: string) {
        const row = await this.triage.get(issueId);
        return row?.state === 'failed' ? String(row.error) : undefined;
    }

    /** Rows started at or after `since`: what the daily cap counts. */
    startedSince(since: number) {
        return this.triage.startedSince(since);
    }

    /** Starts a row; false when the issue was asked about already. */
    begin(issueId: string, now = Date.now()) {
        return this.uow.run(
            async () => {
                if (await this.triage.get(issueId)) {
                    return false;
                }
                await this.triage.insertPending(issueId, now);
                return true;
            },
            { label: 'start triage' },
        );
    }

    propose(issueId: string, fields: TriageFields, commentId: string) {
        return this.triage.propose(issueId, fields, commentId);
    }

    fail(issueId: string, error: string) {
        return this.triage.fail(issueId, error);
    }

    /** Rows left pending by a stopped server end as failed; how many. */
    failPending(error: string) {
        return this.triage.failPending(error);
    }

    /** An admin's decision on a proposal; false when it was not `proposed`. */
    decide(issueId: string, state: Extract<TriageState, 'applied' | 'ignored'>, userId: string, now = Date.now()) {
        return this.triage.decide(issueId, state, userId, now);
    }
}
