import type { ApprovalView } from '@socio/shared/approvals';

import type { SnapshotDefinition } from './snapshot-cache';
import { keyed, list, object } from './snapshot-shape';

// The approvals kind: the
// person's own requests as the server gives them, `GET /api/approvals`
// (src/server/approvals/routes.ts, the shape packages/shared's ApprovalsState).
// - `approvals` holds the requests by id, unversioned (a decision changes a
//   request with no version): those waiting (`pending`) and the recent
//   decisions (`recent`). The server reads both from the person's 100 most
//   recent requests (views.ts), so the kind never holds more than 100. Rows are
//   kept by key, so the order isn't: a screen sorts by `createdAt`.
// - The page's other parts (capabilities, policies, the audit, the guidance)
//   are the web's settings and stay out of it.
// The path sends no ETag (a plain c.json), so the source keeps a hash of the
// body in its place (`hashBody`, snapshot-source.ts). It is pulled with the
// shell (a start, a return), for the Inbox and the badge, and every 60 s while
// an approvals screen or the Inbox is in view. Decisions and the direct reads
// are approval-actions.ts's.

export const APPROVALS = 'approvals';

/** How often an approvals screen or the Inbox, in view, asks again. */
export const APPROVALS_POLL_MS = 60_000;

const APPROVALS_PATH = '/api/approvals';

/** `GET /api/approvals`: the requests waiting and the recent decisions, by id. */
export const APPROVALS_SNAPSHOT: SnapshotDefinition = {
    id: 'approvals',
    path: APPROVALS_PATH,
    format: 1,
    hashBody: true,
    feeds: [{ collection: APPROVALS }],
    split(body) {
        const fields = object(APPROVALS_PATH, body, 'the body');
        return [
            [
                ...keyed(APPROVALS_PATH, list(APPROVALS_PATH, fields.pending, 'pending'), 'pending', { key: 'id' }),
                ...keyed(APPROVALS_PATH, list(APPROVALS_PATH, fields.recent, 'recent'), 'recent', { key: 'id' }),
            ],
        ];
    },
};

/** A request's row as its collection holds it: the view the server sent. */
export const approvalRow = (_key: string, value: unknown): ApprovalView => value as ApprovalView;
