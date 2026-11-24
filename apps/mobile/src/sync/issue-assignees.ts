import type { IssueAssignees } from '@socio/shared/issues/issue-types';

import type { SqlConnection } from '../data';
import type { AuthedFetch } from '../net/authed-fetch';

import { type BoundedKindDefinition, type BoundedStore, createBoundedStore } from './bounded-kind';
import { SnapshotShapeError } from './errors';

// Who an admin can assign an issue to: `GET /api/issues/assignees`
// (admins only), a bounded kind (bounded-kind.ts) with one item under
// ASSIGNEES_KEY, kept in cache.db so the picker shows the last list offline,
// with its age. It is read only when an admin opens the assignee picker
// (`use()`), never polled: the web reads it when its admin fields mount. A
// refusal (a person no longer an admin) or no answer keeps the last list;
// nothing here is ever "gone". No React Native: tests/sync runs it under Node.

export const ISSUE_ASSIGNEES_KIND = 'issue-assignees';
/** The one key the list is kept under. */
export const ASSIGNEES_KEY = 'all';

function checkAssignees(path: string, body: unknown): IssueAssignees {
    const value = body as Partial<IssueAssignees> | null;
    if (!value || typeof value !== 'object' || !Array.isArray(value.users)) {
        throw new SnapshotShapeError(path, 'no users.');
    }
    const people = [...value.users, ...(Array.isArray(value.deactivated) ? value.deactivated : [])] as unknown[];
    for (const person of people) {
        const p = person as { id?: unknown; name?: unknown } | null;
        if (!p || typeof p.id !== 'string' || typeof p.name !== 'string') {
            throw new SnapshotShapeError(path, 'a person without an id or name.');
        }
    }
    return { users: value.users, deactivated: Array.isArray(value.deactivated) ? value.deactivated : [] };
}

export const ISSUE_ASSIGNEES: BoundedKindDefinition<IssueAssignees> = {
    name: ISSUE_ASSIGNEES_KIND,
    format: 1,
    bounds: { items: 1, chars: 2_000_000 },
    path: () => '/api/issues/assignees',
    parse: checkAssignees,
};

export type IssueAssigneeList = BoundedStore<IssueAssignees>;

export interface IssueAssigneesOptions {
    readonly db: SqlConnection;
    readonly fetch: AuthedFetch;
    readonly signal?: AbortSignal;
    readonly onError?: (error: unknown) => void;
    readonly now?: () => number;
}

/** Opens the scope's assignee list on its cache.db. */
export function createIssueAssignees(options: IssueAssigneesOptions): IssueAssigneeList {
    return createBoundedStore<IssueAssignees>({
        definition: ISSUE_ASSIGNEES,
        ...options,
        // The list is never gone: a refusal keeps the last one, with its age.
        isGone: () => false,
    });
}
