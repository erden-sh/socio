import { PRIORITY_LABEL, STATUS_LABEL } from '@socio/shared/issues/issue-board';
import {
    ISSUE_LABELS,
    ISSUE_PRIORITIES,
    ISSUE_STATUSES,
    type IssueLabel,
    type IssuePriority,
    type IssueStatus,
    type IssueSummary,
} from '@socio/shared/issues/issue-types';

import type { EditIssueInput, IssueEditResult } from '../sync/issue-edit';
import { issueKey } from '../sync/issues';
import type { OverlayItem } from '../sync/outbox-overlay';

import { labelWords, withIssueWrites } from './board';

// The Board's Select mode (O-4; the web's BatchBar, packages/client's
// modules/issues/BatchBar.tsx): an admin picks several issues and sets their
// status or priority, or adds or removes a label, in one go. The web offers
// those three menus and an `issues.batch` slot no module fills, so the app
// has every batch action the web has. Each change is IE's `editIssue` per
// issue, through the outbox: it works offline, folds into an issue's queued
// edit, and each row is marked "Waiting to send" until the server has it. An
// issue already at the chosen value is left alone, as on the web. What it
// did is said in the web's toast words ("Moved to Done: 2 issues"), shown in
// the action bar and told to screen readers. No React Native: tests/shell
// runs it under Node.

/** One batch change: what the action bar's sheets offer. */
export type BatchChoice =
    | { readonly kind: 'status'; readonly value: IssueStatus }
    | { readonly kind: 'priority'; readonly value: IssuePriority }
    | { readonly kind: 'add-label'; readonly value: IssueLabel }
    | { readonly kind: 'remove-label'; readonly value: IssueLabel };

/** The action bar's buttons, in the web's order. */
export type BatchMenu = 'status' | 'priority' | 'labels';

export const BATCH_MENUS: readonly { readonly menu: BatchMenu; readonly label: string }[] = [
    { menu: 'status', label: 'Status' },
    { menu: 'priority', label: 'Priority' },
    { menu: 'labels', label: 'Labels' },
];

/** A sheet's groups of choices: one for status and priority, Add and Remove for labels. */
export interface BatchGroup {
    readonly title: string | null;
    readonly choices: readonly { readonly choice: BatchChoice; readonly label: string; readonly testID: string }[];
}

export function batchGroups(menu: BatchMenu): readonly BatchGroup[] {
    switch (menu) {
        case 'status':
            return [
                {
                    title: null,
                    choices: ISSUE_STATUSES.map((value) => ({
                        choice: { kind: 'status', value },
                        label: STATUS_LABEL[value],
                        testID: `board-batch-status-${value}`,
                    })),
                },
            ];
        case 'priority':
            return [
                {
                    title: null,
                    choices: ISSUE_PRIORITIES.map((value) => ({
                        choice: { kind: 'priority', value },
                        label: PRIORITY_LABEL[value],
                        testID: `board-batch-priority-${value}`,
                    })),
                },
            ];
        case 'labels':
            return (['add-label', 'remove-label'] as const).map((kind) => ({
                title: kind === 'add-label' ? 'Add label' : 'Remove label',
                choices: ISSUE_LABELS.map((value) => ({
                    choice: { kind, value },
                    label: labelWords(value),
                    testID: `board-batch-${kind}-${value}`,
                })),
            }));
    }
}

/** What a choice did, in the web's toast words: "Moved to Done", "Priority set to High", "Added bug". */
export function batchWords(choice: BatchChoice): string {
    switch (choice.kind) {
        case 'status':
            return `Moved to ${STATUS_LABEL[choice.value]}`;
        case 'priority':
            return `Priority set to ${PRIORITY_LABEL[choice.value]}`;
        case 'add-label':
            return `Added ${labelWords(choice.value)}`;
        case 'remove-label':
            return `Removed ${labelWords(choice.value)}`;
    }
}

/**
 * The edit for one issue as it shows (its pending writes laid over), or
 * undefined when it already is what was chosen (the web's BatchChange). A
 * label goes as IE's `toggleLabel`, so it applies to the newest labels.
 */
export function batchEdit(
    choice: BatchChoice,
    issue: IssueSummary,
): Pick<EditIssueInput, 'changes' | 'toggleLabel'> | undefined {
    switch (choice.kind) {
        case 'status':
            return issue.status === choice.value ? undefined : { changes: { status: choice.value } };
        case 'priority':
            return issue.priority === choice.value ? undefined : { changes: { priority: choice.value } };
        case 'add-label':
            return issue.labels.includes(choice.value) ? undefined : { changes: {}, toggleLabel: choice.value };
        case 'remove-label':
            return issue.labels.includes(choice.value) ? { changes: {}, toggleLabel: choice.value } : undefined;
    }
}

const issuesWord = (n: number) => `${n} issue${n === 1 ? '' : 's'}`;

/** What the action bar says after a batch: the web's toast words. */
export function batchResult(what: string, changed: number, failed: number): string {
    if (failed > 0) {
        return `${what}: ${failed} not changed`;
    }
    return changed > 0 ? `${what}: ${issuesWord(changed)}` : 'Nothing to change';
}

/** The header's words in Select: "Select issues" with none picked, then "2 selected". */
export const selectionTitle = (picked: number) => (picked === 0 ? 'Select issues' : `${picked} selected`);

/** An issue picked or put back. */
export function toggleSelected(selection: ReadonlySet<number>, number: number): ReadonlySet<number> {
    const next = new Set(selection);
    if (!next.delete(number)) {
        next.add(number);
    }
    return next;
}

/** Whether every issue the filters let through is picked: the header then offers Deselect all. */
export const allSelected = (selection: ReadonlySet<number>, selectable: readonly number[]) =>
    selectable.length > 0 && selectable.every((number) => selection.has(number));

export interface ApplyBatchInput {
    readonly choice: BatchChoice;
    readonly selection: ReadonlySet<number>;
    /** The `issues` collection's rows: each edit's base (the server's values, never the overlay's). */
    readonly issues: readonly IssueSummary[];
    /** The board's overlays: what each issue shows now, which decides whether it changes. */
    readonly overlays: readonly OverlayItem[];
    /** IE's `editIssue` on the scope's outbox. */
    readonly edit: (input: EditIssueInput) => Promise<IssueEditResult>;
    readonly newId: () => string;
}

/** Applies a choice to every picked issue, one `editIssue` each; resolves with what to say. */
export async function applyBatch(input: ApplyBatchInput): Promise<string> {
    const shown = withIssueWrites(input.issues, input.overlays);
    let changed = 0;
    let failed = 0;
    for (const { issue } of shown) {
        if (!input.selection.has(issue.number)) {
            continue;
        }
        const edit = batchEdit(input.choice, issue);
        if (edit === undefined) {
            continue;
        }
        const base = input.issues.find((item) => item.number === issue.number)!;
        try {
            await input.edit({
                issue: issueKey(issue.number),
                changes: edit.changes,
                base: { status: base.status, priority: base.priority, labels: base.labels },
                newId: input.newId,
                ...(edit.toggleLabel === undefined ? {} : { toggleLabel: edit.toggleLabel }),
            });
            changed += 1;
        } catch (error) {
            console.warn(`[board] ${issueKey(issue.number)} not changed`, error);
            failed += 1;
        }
    }
    return batchResult(batchWords(input.choice), changed, failed);
}
