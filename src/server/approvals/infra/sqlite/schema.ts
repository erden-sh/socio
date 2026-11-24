import { primaryKey, sqliteTable } from 'drizzle-orm/sqlite-core';

import { enumText, id, int, json, ms, str } from '@socio/data/columns.sqlite';
import {
    APPROVAL_POLICIES,
    APPROVAL_STATUSES,
    type ApprovalAuditEntry,
    type ApprovalView,
    type AutoCause,
    type AutoRisk,
} from '@socio/shared/approvals';

import type { ContinuationState } from '../../domain/repositories.js';

/**
 * The approval tables (CB-110), as `approvals/migrations.ts` makes them:
 * the typed mirror the repositories query. The migrations stay the source
 * of truth; tests/approvals-repositories.test.ts holds these to them.
 */

export const approvalPolicies = sqliteTable(
    'approval_policies',
    {
        userId: str().notNull(),
        dotId: str().notNull(),
        capability: str().notNull(),
        policy: enumText(APPROVAL_POLICIES).notNull(),
        updatedAt: ms().notNull(),
    },
    (table) => [primaryKey({ columns: [table.userId, table.dotId, table.capability] })],
);

export const approvalRequests = sqliteTable('approval_requests', {
    id: id().primaryKey(),
    userId: str().notNull(),
    dotId: str().notNull(),
    capability: str().notNull(),
    summary: str().notNull(),
    details: json<string[]>().notNull(),
    /** JSON, `null` included: read and written by the repository. */
    payload: str().notNull(),
    threadId: str(),
    status: enumText(APPROVAL_STATUSES).notNull(),
    decidedVia: str().$type<NonNullable<ApprovalView['decidedVia']>>(),
    outcome: str(),
    createdAt: ms().notNull(),
    expiresAt: ms().notNull(),
    decidedAt: ms(),
    /** JSON, or NULL when the handler kept nothing. */
    undoData: str(),
    runId: str(),
    continuation: str().$type<ContinuationState>(),
    continuationId: str(),
    continuationDetail: str(),
    /** The work cycle it was asked in (CB-209). */
    cycleId: str(),
    /** CB-232 (migration 6): a consumable request's intent digest. */
    digest: str(),
    /** What a consumable request is bound to: a grant id. */
    bindingId: str(),
    consumedAt: ms(),
    /** When its person opened its full details. */
    openedAt: ms(),
});

export const approvalAudit = sqliteTable('approval_audit', {
    id: id().primaryKey(),
    userId: str().notNull(),
    dotId: str().notNull(),
    capability: str().notNull(),
    requestId: id(),
    event: str().$type<ApprovalAuditEntry['event']>().notNull(),
    actor: str().notNull(),
    detail: str(),
    createdAt: ms().notNull(),
});

export const approvalGuidance = sqliteTable('approval_guidance', {
    userId: str().primaryKey(),
    guidance: str().notNull(),
    updatedAt: ms().notNull(),
});

export const approvalAutoDecisions = sqliteTable('approval_auto_decisions', {
    id: id().primaryKey(),
    requestId: id().notNull(),
    userId: str().notNull(),
    dotId: str().notNull(),
    capability: str().notNull(),
    verdict: enumText(['approved', 'denied', 'escalated']).notNull(),
    cause: str().$type<AutoCause>().notNull(),
    modelDecision: str(),
    risk: str().$type<AutoRisk>(),
    reason: str().notNull(),
    model: str(),
    backend: str(),
    latencyMs: int(),
    inputHash: str(),
    undoneAt: ms(),
    undoOutcome: str(),
    createdAt: ms().notNull(),
});

export const approvalNotes = sqliteTable('approval_notes', {
    id: id().primaryKey(),
    threadId: str().notNull(),
    userId: str().notNull(),
    content: str().notNull(),
    createdAt: ms().notNull(),
});

/** Every table Approvals owns, for the drift test and the SQL check. */
export const approvalTables = [
    approvalPolicies,
    approvalRequests,
    approvalAudit,
    approvalGuidance,
    approvalAutoDecisions,
    approvalNotes,
] as const;
