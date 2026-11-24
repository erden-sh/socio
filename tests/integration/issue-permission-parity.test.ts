import { expect, it } from 'vitest';

import { createRefusal, patchRefusal } from '@socio/foundation/issues/permissions';
import { canEditText, canTriage } from '@socio/shared/issues/issue-board';
import { ISSUE_STATUSES, type Issue } from '@socio/shared/issues/issue-types';
import type { User } from '@socio/shared/types';

// The clients hide controls with shared's can* helpers; the server
// decides with foundation's createRefusal and patchRefusal. Shared may not
// import foundation, so this table holds the two together: a control is
// shown exactly when the server would take the change it makes.

const people: User[] = [
    { id: 'olga', name: 'Olga', role: 'admin' },
    { id: 'ada', name: 'Ada', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
    { id: 'carol', name: 'Carol', role: 'member' },
];
const issue = (fields: Partial<Issue>) =>
    ({ id: 'i1', number: 1, reporterId: 'bob', status: 'triage', ...fields }) as Issue;
/** A new issue's fields as the route passes them (`IssueInput`). */
const filing = (user: User, input: { title: string } & Record<string, unknown>) =>
    createRefusal(user, input as Parameters<typeof createRefusal>[1]);
const issues = ISSUE_STATUSES.flatMap((status) => ['bob', 'ada'].map((reporterId) => issue({ status, reporterId })));

/** What the detail's triage controls change, one field each. */
const TRIAGE_CHANGES = [
    { status: 'open' },
    { priority: 'high' },
    { kind: 'feature' },
    { area: 'client' },
    { labels: ['ux'] },
    { resolution: 'Fixed' },
    { assigneeId: 'bob' },
];

it('shows the title and description editor exactly when the server takes the edit', () => {
    for (const user of people) {
        for (const item of issues) {
            for (const change of [{ title: 'New title' }, { body: 'New body' }, { title: 'T', body: 'B' }]) {
                const allowed = patchRefusal(user, item, change) === undefined;
                expect({
                    user: user.id,
                    status: item.status,
                    reporter: item.reporterId,
                    change,
                    shown: canEditText(item, user),
                }).toEqual({
                    user: user.id,
                    status: item.status,
                    reporter: item.reporterId,
                    change,
                    shown: allowed,
                });
            }
        }
    }
});

it('shows the triage controls exactly when the server takes each of their changes', () => {
    for (const user of people) {
        for (const item of issues) {
            for (const change of TRIAGE_CHANGES) {
                expect({ user: user.id, change, shown: canTriage(user) }).toEqual({
                    user: user.id,
                    change,
                    shown: patchRefusal(user, item, change) === undefined,
                });
            }
        }
        // Filing: the triage fields (a status past triage, labels, an assignee, a resolution).
        for (const change of [
            { status: 'open' as const },
            { labels: ['ux'] },
            { assigneeId: 'bob' },
            { resolution: 'x' },
        ]) {
            expect({ user: user.id, change, shown: canTriage(user) }).toEqual({
                user: user.id,
                change,
                shown: filing(user, { title: 'T', ...change }) === undefined,
            });
        }
        // The report form's own fields are everyone's.
        expect(
            filing(user, { title: 'T', body: 'B', kind: 'bug', priority: 'medium', area: 'client' }),
        ).toBeUndefined();
        expect(filing(user, { title: 'T', status: 'triage' })).toBeUndefined();
    }
});
