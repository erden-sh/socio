/**
 * Who may change what on the board. Moved from `issues/permissions.ts`,
 * which re-exports it.
 */
import type { Issue, IssueStatus } from '@socio/shared/issues/issue-types';
import { isAdmin } from '@socio/shared/roles';
import type { User } from '@socio/shared/types';

/** Fields a member may set when filing; the rest is triage. Components are set when filing, then by admins only (CB-442). */
const MEMBER_CREATE = new Set(['title', 'body', 'kind', 'priority', 'area', 'components']);
const MEMBER_EDIT = new Set(['title', 'body']);

/**
 * Who may change what on the board, for the routes and for connected
 * agents acting as their person (CB-90): admins set and change any field;
 * members file into triage, and edit the title and description of their
 * own issues while in triage. Each returns why not, or undefined. `input`
 * and `patch` are a new issue's fields and a change to an issue
 * (`IssueInput` and `IssuePatch` in `issues/contract.ts`).
 */
export function createRefusal(user: User, input: { readonly status?: IssueStatus }) {
    if (isAdmin(user)) {
        return undefined;
    }
    if (input.status && input.status !== 'triage') {
        return 'New issues start in triage.';
    }
    if (Object.keys(input).some((key) => key !== 'status' && !MEMBER_CREATE.has(key))) {
        return 'Only an admin can change this.';
    }
    return undefined;
}

export function patchRefusal(user: User, issue: Issue, patch: object) {
    if (isAdmin(user)) {
        return undefined;
    }
    if (Object.keys(patch).some((key) => !MEMBER_EDIT.has(key))) {
        return 'Only an admin can change this.';
    }
    if (issue.reporterId !== user.id || issue.status !== 'triage') {
        return 'You can edit the title and description of your own issues while they are in triage.';
    }
    return undefined;
}
