import { primaryKey, sqliteTable } from 'drizzle-orm/sqlite-core';

import { bytes, enumText, id, int, json, ms, str } from '@socio/data/columns.sqlite';
import { COMPONENT_KINDS } from '@socio/shared/issues/issue-components';
import { ISSUE_WATCH_STATES } from '@socio/shared/issues/issue-subscriptions';
import {
    ISSUE_KINDS,
    ISSUE_PRIORITIES,
    ISSUE_STATUSES,
    type IssueArea,
    type IssueAttachmentType,
    type IssueEventKind,
    type IssueLabel,
    type IssueSource,
} from '@socio/shared/issues/issue-types';

import { ISSUE_RUN_VIAS } from '../../domain/repositories.js';

/**
 * The Board's tables (CB-110), as `issues/migrations.ts` makes them: the
 * typed mirror the repositories query. The migrations stay the source of
 * truth; tests/board-drift.test.ts holds these to them.
 */

export const issues = sqliteTable('issues', {
    id: id().primaryKey(),
    number: int().notNull(),
    title: str().notNull(),
    body: str().notNull(),
    status: enumText(ISSUE_STATUSES).notNull(),
    priority: enumText(ISSUE_PRIORITIES).notNull(),
    kind: enumText(ISSUE_KINDS).notNull(),
    area: str().$type<IssueArea>(),
    reporterId: str().notNull(),
    assigneeId: str(),
    resolution: str(),
    source: str().$type<IssueSource>().notNull(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
    closedAt: ms(),
    deletedAt: ms(),
    deletedBy: str(),
});

export const issueLabels = sqliteTable(
    'issue_labels',
    {
        issueId: id().notNull(),
        label: str().$type<IssueLabel>().notNull(),
    },
    (table) => [primaryKey({ columns: [table.issueId, table.label] })],
);

/**
 * The plugins and apps an issue is about (CB-442): one row per ref, with
 * the name it had when tagged (`label`), an app's `createdAt` when tagged
 * (`generation`: a later app at the same address is another app) and a
 * plugin's audience then (who still sees the tag once it is uninstalled).
 */
export const issueComponents = sqliteTable(
    'issue_components',
    {
        issueId: id().notNull(),
        ref: str().notNull(),
        kind: enumText(COMPONENT_KINDS).notNull(),
        targetId: str(),
        generation: int(),
        label: str().notNull(),
        audience: enumText(['admins', 'members']),
        addedBy: str().notNull(),
        addedAt: ms().notNull(),
    },
    (table) => [primaryKey({ columns: [table.issueId, table.ref] })],
);

/**
 * The name and audience each ref an issue was ever tagged with had when
 * last tagged (CB-442), kept after the tag goes, so its history reads the
 * same once the plugin is uninstalled or the tag removed.
 */
export const issueComponentNames = sqliteTable(
    'issue_component_names',
    {
        issueId: id().notNull(),
        ref: str().notNull(),
        label: str().notNull(),
        audience: enumText(['admins', 'members']),
    },
    (table) => [primaryKey({ columns: [table.issueId, table.ref] })],
);

/** One row (`id` 1): the last number handed out (CB-39). */
export const issueCounter = sqliteTable('issue_counter', {
    id: int().primaryKey(),
    last: int().notNull(),
});

export const issueLinks = sqliteTable('issue_links', {
    id: id().primaryKey(),
    fromId: id().notNull(),
    toId: id().notNull(),
    kind: enumText(['blocked_by']).notNull(),
    createdBy: str().notNull(),
    createdAt: ms().notNull(),
    removedAt: ms(),
    removedBy: str(),
});

/** Related links (CB-274): no direction, the pair in id order. */
export const issueRelations = sqliteTable('issue_relations', {
    id: id().primaryKey(),
    fromId: id().notNull(),
    toId: id().notNull(),
    kind: enumText(['related']).notNull(),
    createdBy: str().notNull(),
    createdAt: ms().notNull(),
    removedAt: ms(),
    removedBy: str(),
});

export const issueComments = sqliteTable('issue_comments', {
    id: id().primaryKey(),
    issueId: id().notNull(),
    authorKind: enumText(['user', 'agent', 'system']).notNull(),
    authorId: str(),
    body: str().notNull(),
    createdAt: ms().notNull(),
    editedAt: ms(),
    deletedAt: ms(),
    deletedBy: str(),
    deletedWith: str(),
});

export const issueAttachments = sqliteTable('issue_attachments', {
    id: id().primaryKey(),
    issueId: id().notNull(),
    commentId: id(),
    name: str().notNull(),
    mediaType: str().$type<IssueAttachmentType>().notNull(),
    size: int().notNull(),
    sha256: str().notNull(),
    data: bytes().notNull(),
    uploaderId: str().notNull(),
    createdAt: ms().notNull(),
    deletedAt: ms(),
    deletedBy: str(),
    deletedWith: str(),
});

/** Append-only history; `seq` orders it and is the cursor. */
export const issueEvents = sqliteTable('issue_events', {
    id: id().primaryKey(),
    issueId: id().notNull(),
    actorId: str(),
    kind: str().$type<IssueEventKind>().notNull(),
    fromValue: str(),
    toValue: str(),
    createdAt: ms().notNull(),
    seq: int(),
});

export const issueVotes = sqliteTable('issue_votes', {
    id: id().primaryKey(),
    issueId: id().notNull(),
    userId: str().notNull(),
    dotId: str(),
    createdAt: ms().notNull(),
    withdrawnAt: ms(),
});

export const issueTriage = sqliteTable('issue_triage', {
    issueId: id().primaryKey(),
    state: enumText(['pending', 'proposed', 'applied', 'ignored', 'failed']).notNull(),
    kind: enumText(ISSUE_KINDS),
    area: str().$type<IssueArea>(),
    priority: enumText(ISSUE_PRIORITIES),
    labels: json<IssueLabel[]>(),
    reason: str(),
    /** Suggested component refs (CB-442), apps with their generation. */
    components: json<string[]>(),
    /** 'admins' when the reason was written with names some can't see (CB-442). */
    reasonAudience: enumText(['admins']),
    commentId: id(),
    error: str(),
    createdAt: ms().notNull(),
    decidedAt: ms(),
    decidedBy: str(),
});

export const dotRequests = sqliteTable('dot_requests', {
    issueId: id().primaryKey(),
    key: str().notNull(),
    capability: str().notNull(),
    createdAt: ms().notNull(),
});

export const dotRequestRequesters = sqliteTable('dot_request_requesters', {
    id: id().primaryKey(),
    issueId: id().notNull(),
    dotId: str().notNull(),
    userId: str().notNull(),
    why: str().notNull(),
    example: str().notNull(),
    createdAt: ms().notNull(),
    announcedAt: ms(),
});

export const dotRequestNotices = sqliteTable('dot_request_notices', {
    id: id().primaryKey(),
    issueId: id().notNull(),
    userId: str().notNull(),
    status: enumText(['done', 'wont_fix']).notNull(),
    resolution: str(),
    createdAt: ms().notNull(),
    seenAt: ms(),
});

export const issueDotActions = sqliteTable('issue_dot_actions', {
    id: id().primaryKey(),
    issueId: id().notNull(),
    action: enumText(['create', 'comment', 'vote', 'unvote', 'update']).notNull(),
    targetId: id(),
    dotId: str().notNull(),
    dotOwnerId: str(),
    userId: str().notNull(),
    trigger: enumText(['chat', 'telegram', 'scheduled', 'goal']).notNull(),
    causeId: str(),
    threadId: str(),
    createdAt: ms().notNull(),
});

export const issueAgentActions = sqliteTable('issue_agent_actions', {
    id: id().primaryKey(),
    issueId: id().notNull(),
    action: enumText(['create', 'comment', 'vote', 'unvote', 'update']).notNull(),
    targetId: id(),
    grantId: str().notNull(),
    clientId: str().notNull(),
    clientName: str().notNull(),
    label: str().notNull(),
    userId: str().notNull(),
    createdAt: ms().notNull(),
});

export const issueWatches = sqliteTable('issue_watches', {
    id: id().primaryKey(),
    userId: str().notNull(),
    targetStatus: enumText(ISSUE_STATUSES).notNull(),
    state: enumText(ISSUE_WATCH_STATES).notNull(),
    fingerprint: str().notNull(),
    cursor: int().notNull(),
    createdAt: ms().notNull(),
    triggeredAt: ms(),
    cancelledAt: ms(),
    cancelReason: enumText(['unsubscribed', 'issue_unavailable', 'person_unavailable']),
    cancelSourceKind: enumText(['person', 'socio', 'agent']),
    cancelSourceId: str(),
    cancelThreadId: str(),
    cancelCauseId: str(),
    sourceKind: enumText(['person', 'socio', 'agent']).notNull(),
    sourceId: str().notNull(),
    threadId: str(),
    causeId: str(),
});
export const issueWatchMembers = sqliteTable(
    'issue_watch_members',
    {
        watchId: id().notNull(),
        issueId: id().notNull(),
        number: int().notNull(),
        status: enumText(ISSUE_STATUSES).notNull(),
    },
    (table) => [primaryKey({ columns: [table.watchId, table.issueId] })],
);
export const issueWatchOutbox = sqliteTable('issue_watch_outbox', {
    id: id().primaryKey(),
    watchId: id().notNull(),
    userId: str().notNull(),
    title: str().notNull(),
    message: str().notNull(),
    path: str().notNull(),
    createdAt: ms().notNull(),
    claimedAt: ms(),
});

/** Every table the Board owns, for the drift test and the SQL check. */
/** The turn an item was filed from (CB-194), by a person or a socio. */
export const issueRuns = sqliteTable(
    'issue_runs',
    {
        issueId: id().notNull(),
        runId: str().notNull(),
        threadId: str().notNull(),
        via: enumText(ISSUE_RUN_VIAS).notNull(),
        linkedBy: str().notNull(),
        createdAt: ms().notNull(),
    },
    (table) => [primaryKey({ columns: [table.issueId, table.runId] })],
);

export const boardTables = [
    issues,
    issueLabels,
    issueComponents,
    issueComponentNames,
    issueCounter,
    issueLinks,
    issueRelations,
    issueComments,
    issueAttachments,
    issueEvents,
    issueVotes,
    issueTriage,
    dotRequests,
    dotRequestRequesters,
    dotRequestNotices,
    issueDotActions,
    issueAgentActions,
    issueWatches,
    issueWatchMembers,
    issueWatchOutbox,
    issueRuns,
] as const;
