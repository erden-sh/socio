import { COMPONENT_KINDS, COMPONENT_STATES, type IssueComponentLabel } from '@socio/shared/issues/issue-components';
import type { IssueSummary } from '@socio/shared/issues/issue-types';

import { SnapshotShapeError } from './errors';
import type { SnapshotItem } from './merge';
import type { SnapshotDefinition } from './snapshot-cache';
import { list, object, singleton } from './snapshot-shape';

// The issues kind: the
// Improvements board's list, as the server gives it: `GET /api/issues` with no
// query (src/server/issues/routes.ts, through conditionalJsonAsync, so a poll
// with no change is a 304), the shape packages/shared's IssueList.
// - `issues` holds the summaries, keyed by their number (as a string, the
//   cache's keys), each versioned by its `updatedAt`: a pull begun before a
//   confirmed change never sets an older copy (merge.ts);
// - `issue-users` holds the list's `users` map (names for the assignees) as one
//   row, `users`, under the same ETag;
// - `issue-components` holds the list's `components` label map (CB-442: how
//   each component ref on the list reads for this reader) as one row,
//   `components`, under the same ETag, so the cards' chips read offline. Its
//   value is null for a server from before CB-442 (no map in the list): the
//   screens then offer no components at all, since that server's strict
//   create and patch would refuse the field. Format 2 drops a format-1 copy's
//   ETag, so the first pull after an update is full and brings the map.
// Rows are kept by key, so the server's order (`boardOrder`) isn't: the board
// sorts them itself. The board polls it every 15 s while it is in view, as the
// web's useIssues does (ISSUES_POLL_MS), and never in the background
// (scheduler.ts's `visiblePoll`).

export const ISSUES = 'issues';
export const ISSUE_USERS = 'issue-users';
/** The `issue-users` collection's one row. */
export const USERS_KEY = 'users';
export const ISSUE_COMPONENTS = 'issue-components';
/** The `issue-components` collection's one row. */
export const COMPONENTS_KEY = 'components';

/** How often the board, in view, asks for the list again (the web's ISSUES_POLL_MS). */
export const ISSUES_POLL_MS = 15_000;

/** The `issue-users` row: each assignee's name by user id. */
export interface IssueUsersRow {
    readonly id: typeof USERS_KEY;
    readonly value: Readonly<Record<string, string>>;
}

/**
 * The `issue-components` row: each component ref's label for this reader, or
 * null when the server has no components (before CB-442).
 */
export interface IssueComponentsRow {
    readonly id: typeof COMPONENTS_KEY;
    readonly value: Readonly<Record<string, IssueComponentLabel>> | null;
}

const ISSUES_PATH = '/api/issues';

/** The cache's key of an issue: its number as a string. */
export const issueKey = (number: number) => String(number);

function summaries(values: readonly unknown[]): SnapshotItem[] {
    return values.map((value) => {
        const { number, updatedAt } = object(ISSUES_PATH, value, 'an issue');
        if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
            throw new SnapshotShapeError(ISSUES_PATH, 'an issue has no number.');
        }
        if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
            throw new SnapshotShapeError(ISSUES_PATH, `issue ${number} has no updatedAt.`);
        }
        return { key: issueKey(number), json: JSON.stringify(value), version: updatedAt, value };
    });
}

function users(value: unknown): Record<string, string> {
    const names = object(ISSUES_PATH, value, 'users');
    for (const name of Object.values(names)) {
        if (typeof name !== 'string') {
            throw new SnapshotShapeError(ISSUES_PATH, 'a name in users is not text.');
        }
    }
    return names as Record<string, string>;
}

const oneOf = (values: readonly string[], value: unknown) => typeof value === 'string' && values.includes(value);

/** The list's label map, checked whole; null when the server sent none. */
function componentLabels(value: unknown): Record<string, IssueComponentLabel> | null {
    if (value === undefined || value === null) {
        return null;
    }
    const labels = object(ISSUES_PATH, value, 'components');
    for (const label of Object.values(labels)) {
        const fields = label as Partial<IssueComponentLabel> | null;
        if (
            !fields ||
            typeof fields !== 'object' ||
            typeof fields.label !== 'string' ||
            !oneOf(COMPONENT_KINDS, fields.kind) ||
            !oneOf(COMPONENT_STATES, fields.state) ||
            (fields.ownerName !== undefined && typeof fields.ownerName !== 'string')
        ) {
            throw new SnapshotShapeError(ISSUES_PATH, 'a component in components is not a label.');
        }
    }
    return labels as Record<string, IssueComponentLabel>;
}

/** `GET /api/issues`: the board's summaries by number, the assignees' names and the components' labels as one row each. */
export const ISSUES_SNAPSHOT: SnapshotDefinition = {
    id: 'issues',
    path: ISSUES_PATH,
    format: 2,
    feeds: [{ collection: ISSUES }, { collection: ISSUE_USERS }, { collection: ISSUE_COMPONENTS }],
    split(body) {
        const fields = object(ISSUES_PATH, body, 'the body');
        return [
            summaries(list(ISSUES_PATH, fields.issues, 'issues')),
            [singleton(USERS_KEY, users(fields.users))],
            [singleton(COMPONENTS_KEY, componentLabels(fields.components))],
        ];
    },
};

/** An issue's row as its collection holds it: the summary the server sent. */
export const issueRow = (_key: string, value: unknown): IssueSummary => value as IssueSummary;
