import { type IssueDetail, issueSummary } from '@socio/shared/issues/issue-types';

import type { SqlConnection } from '../data';
import type { AuthedFetch } from '../net/authed-fetch';

import { type BoundedKindDefinition, type BoundedStore, createBoundedStore } from './bounded-kind';
import { SnapshotShapeError } from './errors';
import { ISSUE_USERS, issueKey, ISSUES, type IssueUsersRow, USERS_KEY } from './issues';
import { isLocalIssue } from './local-ids';
import type { Outbox } from './outbox';
import type { SnapshotCache } from './snapshot-cache';

// Issue details: a
// bounded kind (bounded-kind.ts) of `GET /api/issues/:number`, keyed by the
// number as a string, the 200 most recently used on disk. A detail is read:
// - when its screen opens (`use()`);
// - after this device's own write that names it (`notesForWrite`, the scope's `afterWrite`);
// - when the issues list's poll (issues.ts) brings its row with a newer `updatedAt`,
//   or without it (an issue that left the list is gone, or moved out of
//   reach: the read says which). With no change, no detail is asked: the web
//   reads a detail on open and on its live topic only.
// A detail's answer refreshes its row in `issues` (the web's `replace`), and
// the assignee's name in `issue-users` when the list lacked it, through the
// cache's `confirm`, so the next list poll is full and agrees.
// A 404 or 410 drops it and moves the issue's lanes (`issue:<n>`,
// `issue-comments:<n>`, `vote:<n>`) to Unsent with "You no longer have access"
// (the Unsent list's `refuseLanes`, the scope's `onGone`). Those lanes also
// pin the detail on disk. A local key (`pending-issue-…`, an issue filed
// offline) never reads the network.

export const ISSUE_DETAILS_KIND = 'issue-detail';
/** Details kept on disk at most (the 200 most recent). */
export const ISSUE_DETAILS_KEPT = 200;
/** About how many characters of details are kept on disk at most. */
export const ISSUE_DETAILS_CHARS = 20_000_000;

/** The lanes of issue `key`'s writes: its create and fields, its comments and attachments, its vote. */
export const issueLanes = (key: string) => [`issue:${key}`, `issue-comments:${key}`, `vote:${key}`];

const LANE = /^(?:issue|issue-comments|vote):(.+)$/;

/** The issue a lane's writes are for, or null for another kind's lane. */
export function issueOfLane(lane: string): string | null {
    return LANE.exec(lane)?.[1] ?? null;
}

function checkDetail(path: string, body: unknown): IssueDetail {
    const detail = body as Partial<IssueDetail> | null;
    const issue = detail?.issue as Partial<IssueDetail['issue']> | undefined;
    if (!detail || typeof detail !== 'object' || !issue || typeof issue !== 'object') {
        throw new SnapshotShapeError(path, 'no issue.');
    }
    if (typeof issue.number !== 'number' || typeof issue.updatedAt !== 'number') {
        throw new SnapshotShapeError(path, 'an issue without its number or updatedAt.');
    }
    if (!Array.isArray(detail.comments) || !Array.isArray(detail.attachments) || !Array.isArray(detail.events)) {
        throw new SnapshotShapeError(path, 'no comments, attachments or events.');
    }
    if (!detail.users || typeof detail.users !== 'object') {
        throw new SnapshotShapeError(path, 'no users.');
    }
    return detail as IssueDetail;
}

export const ISSUE_DETAILS: BoundedKindDefinition<IssueDetail> = {
    name: ISSUE_DETAILS_KIND,
    format: 1,
    bounds: { items: ISSUE_DETAILS_KEPT, chars: ISSUE_DETAILS_CHARS },
    path: (key) => `/api/issues/${encodeURIComponent(key)}`,
    parse: checkDetail,
    version: (detail) => detail.issue.updatedAt,
};

export type IssueDetails = BoundedStore<IssueDetail>;

export interface IssueDetailsOptions {
    readonly db: SqlConnection;
    readonly fetch: AuthedFetch;
    readonly signal?: AbortSignal;
    /** The snapshot cache: a detail refreshes its list row there. */
    readonly cache: Pick<SnapshotCache, 'rows' | 'confirm'>;
    /** The outbox once it opens: its lanes pin details and a gone issue's writes go to Unsent. */
    readonly outbox: () => Pick<Outbox, 'rows' | 'unsent'> | null;
    /** Moves lanes to Unsent as gone (the scope's `refuseLanes` with UNSENT_GONE). */
    readonly onGone?: (lanes: readonly string[]) => void;
    readonly onError?: (error: unknown) => void;
    readonly now?: () => number;
}

/** Puts a detail's issue in the list's rows when it is newer than what the list holds (the web's `replace`). */
function refreshListRow(cache: IssueDetailsOptions['cache'], detail: IssueDetail, onError: (error: unknown) => void) {
    const { issue, users } = detail;
    const key = issueKey(issue.number);
    const held = cache.rows(ISSUES).get(key);
    if (held === undefined || typeof held.version !== 'number' || held.version < issue.updatedAt) {
        cache
            .confirm({ collection: ISSUES, scope: '', key, value: issueSummary(issue), version: issue.updatedAt })
            .catch(onError);
    }
    const assignee = issue.assigneeId;
    const name = assignee === null ? undefined : users[assignee];
    if (assignee === null || name === undefined) {
        return;
    }
    const row = cache.rows(ISSUE_USERS).get(USERS_KEY);
    const names = row === undefined ? {} : (JSON.parse(row.json) as IssueUsersRow['value']);
    if (names[assignee] !== name) {
        cache
            .confirm({ collection: ISSUE_USERS, scope: '', key: USERS_KEY, value: { ...names, [assignee]: name } })
            .catch(onError);
    }
}

/** Opens the scope's issue details on its cache.db. */
export function createIssueDetails(options: IssueDetailsOptions): IssueDetails {
    const { db, fetch, signal, cache, outbox, onGone, onError = () => {}, now } = options;
    return createBoundedStore<IssueDetail>({
        definition: ISSUE_DETAILS,
        db,
        fetch,
        signal,
        now,
        onError,
        isLocal: isLocalIssue,
        pinned: () => {
            const keys = new Set<string>();
            const box = outbox();
            for (const { lane } of box === null ? [] : [...box.rows(), ...box.unsent()]) {
                const key = issueOfLane(lane);
                if (key !== null) {
                    keys.add(key);
                }
            }
            return keys;
        },
        onGone: (key) => onGone?.(issueLanes(key)),
        onValue: (_key, detail) => refreshListRow(cache, detail, onError),
    });
}

/**
 * Follows the issues list (its poll): a held detail whose row came with a
 * newer `updatedAt` is read again, and so is any detail the phone holds whose
 * row left the list. A confirmation (this device's own, or a detail's
 * refresh) and an unchanged row ask nothing. Returns the unsubscribe.
 */
export function followIssueList(cache: Pick<SnapshotCache, 'subscribe'>, details: IssueDetails): () => void {
    return cache.subscribe((change) => {
        if (change.confirmed) {
            return;
        }
        for (const row of change.upserts) {
            if (row.collection !== ISSUES || row.scope !== '') {
                continue;
            }
            const shown = details.peek(row.key)?.state.value;
            if (shown != null && typeof row.version === 'number' && row.version > shown.issue.updatedAt) {
                void details.refreshKnown(row.key);
            }
        }
        for (const row of change.removes) {
            if (row.collection === ISSUES && row.scope === '') {
                void details.refreshKnown(row.key);
            }
        }
    });
}
