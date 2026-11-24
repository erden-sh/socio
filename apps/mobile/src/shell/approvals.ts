import type { ApprovalView } from '@socio/shared/approvals';
import { inertText } from '@socio/shared/text/inert-text';

import { asksTo, NEEDS_YOUR_APPROVAL } from '../chat/approval-card';

// The approvals list and the Inbox's approval rows, under Node. The rows are
// the scope's `approvals` collection: the person's own requests, waiting and
// recently decided, at most the server's 100 most recent. Each card on the
// list and the request's own page is the chat's approval card
// (src/chat/approval-card.ts); this says which show, in what order.
// - **The list** (`/approvals`, the web's page): the requests waiting first,
//   then the recent decisions, each newest first, the decisions at most the
//   server's 50 (src/server/approvals/views.ts).
// - **The Inbox:** the requests waiting come first, the newest few as rows
//   that open the request's page, then "See all" with the count, which opens
//   the list.

/** How many recent decisions the list shows: the web's (the server's `recent`). */
export const RECENT_SHOWN = 50;

/** How many waiting requests the Inbox shows as rows before "See all". */
export const INBOX_APPROVALS_SHOWN = 3;

export const WAITING_TITLE = 'Waiting for you';
export const RECENT_TITLE = 'Recent decisions';
export const NOTHING_WAITING = 'Nothing is waiting.';
export const NO_DECISIONS = 'None yet.';
export const SEE_ALL = 'See all approvals';
export const REQUEST_TITLE = 'Approval request';
export const READING_REQUEST = 'Reading the request…';
export const READ_WHEN_ONLINE = 'This request is read once you’re online.';

/** The web's path for the list, and for one request (Telegram's notices link there too). */
export const APPROVALS_PATH = '/approvals';
export const approvalPath = (id: string) => `${APPROVALS_PATH}/${encodeURIComponent(id)}`;

export interface ApprovalsListView {
    /** Waiting, newest first. */
    readonly waiting: readonly ApprovalView[];
    /** Decided, newest decision first, at most RECENT_SHOWN. */
    readonly recent: readonly ApprovalView[];
    /** "3 waiting", for the header; null when nothing waits. */
    readonly waitingLabel: string | null;
}

const decidedAt = (view: ApprovalView) => view.decidedAt ?? view.createdAt;

export function approvalsList(views: readonly ApprovalView[]): ApprovalsListView {
    const waiting = views.filter((view) => view.status === 'pending').sort((a, b) => b.createdAt - a.createdAt);
    const recent = views
        .filter((view) => view.status !== 'pending')
        .sort((a, b) => decidedAt(b) - decidedAt(a) || b.createdAt - a.createdAt)
        .slice(0, RECENT_SHOWN);
    return { waiting, recent, waitingLabel: waiting.length === 0 ? null : `${waiting.length} waiting` };
}

/** One waiting request as an Inbox row. */
export interface ApprovalRow {
    readonly id: string;
    /** "Ada asks to create datasets". */
    readonly title: string;
    /** The module's one line, as inert text; null when it has none. */
    readonly summary: string | null;
    readonly accessibilityLabel: string;
}

export interface InboxApprovals {
    /** The newest waiting requests, at most INBOX_APPROVALS_SHOWN. */
    readonly rows: readonly ApprovalRow[];
    /** How many wait in all. */
    readonly waiting: number;
    /** "See all approvals" with the count, for a screen reader. */
    readonly seeAllLabel: string;
}

export function inboxApprovals(views: readonly ApprovalView[]): InboxApprovals {
    const { waiting } = approvalsList(views);
    const rows = waiting.slice(0, INBOX_APPROVALS_SHOWN).map((view) => {
        const title = asksTo(view);
        const summary = view.summary.trim() === '' ? null : inertText(view.summary, { max: 400 });
        return {
            id: view.id,
            title,
            summary,
            accessibilityLabel: `${title}. ${NEEDS_YOUR_APPROVAL}${summary === null ? '' : `. ${summary}`}`,
        };
    });
    return {
        rows,
        waiting: waiting.length,
        seeAllLabel: `${SEE_ALL}, ${waiting.length} waiting`,
    };
}
