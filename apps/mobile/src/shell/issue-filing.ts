import { ISSUE_CREATE_KIND, type PendingIssue } from '../sync/issue-create';
import { type HoldGroup, OUTBOX_COPY } from '../sync/outbox';
import type { OverlayItem, OverlayState } from '../sync/outbox-overlay';

import { unsentWhy } from './unsent';

// Filings not yet numbered on the board: the `issue-create` kind's overlays,
// as rows at the top of Triage, newest first, each keyed by its local key
// (`pending-issue-…`, the row's view-model key and its route param) and
// labelled `CB-?`, since a local row has no number. Their words are the
// outbox's: "Waiting to send" while it waits or goes, "Couldn't confirm this
// was sent" with View (each candidate issue in turn) and Send again, "Not
// sent" with why, Edit, Copy and Discard. The Board draws them.
// No React Native: tests/shell runs it under Node.

/** What a filing shows in place of its number until the server gives one. */
export const PENDING_ISSUE_LABEL = 'CB-?';

/** Where the pending rows go: before every row of the Triage column, newest first. */
export const PENDING_ISSUE_COLUMN = 'triage';

export type PendingIssueAction = 'view' | 'send-again' | 'edit' | 'copy' | 'discard';

export interface PendingIssueRow {
    /** The local key: the view model's key and the issue screen's route param. */
    readonly key: string;
    readonly label: typeof PENDING_ISSUE_LABEL;
    readonly title: string;
    /** What Copy takes (`filingText`): the title, then the description. */
    readonly text: string;
    readonly state: OverlayState;
    /** The outbox's words for where it stands. */
    readonly words: string;
    /** With `unconfirmed`: the numbers (as keys) of the issues that may be it, oldest first, for View. */
    readonly candidates: readonly string[];
    readonly actions: readonly PendingIssueAction[];
    readonly createdAt: number;
    readonly accessibilityLabel: string;
}

const NOT_SENT = 'Not sent';

function wordsOf(item: OverlayItem): string {
    switch (item.state) {
        case 'unconfirmed':
            return OUTBOX_COPY.unconfirmed;
        case 'unsent':
            return `${NOT_SENT}: ${unsentWhy(item.reason ?? '')}`;
        default:
            return OUTBOX_COPY.waitingToSend;
    }
}

function actionsOf(state: OverlayState, candidates: readonly string[]): PendingIssueAction[] {
    switch (state) {
        case 'unconfirmed':
            return candidates.length > 0 ? ['view', 'send-again'] : ['send-again'];
        case 'unsent':
            return ['edit', 'copy', 'discard'];
        default:
            return [];
    }
}

/** The unconfirmed filings' candidates, by row id, from the outbox's hold groups. */
export function filingCandidates(groups: readonly HoldGroup[]): ReadonlyMap<string, readonly string[]> {
    const found = new Map<string, readonly string[]>();
    for (const { root } of groups) {
        if (root.kind === ISSUE_CREATE_KIND && root.cause === 'unconfirmed' && root.candidates?.length) {
            found.set(root.id, root.candidates);
        }
    }
    return found;
}

/** The board's pending rows: the filings' overlays (`overlaysOf`), newest first, for the top of Triage. */
export function pendingIssueRows(
    overlays: readonly OverlayItem[],
    candidates: ReadonlyMap<string, readonly string[]> = new Map(),
): PendingIssueRow[] {
    return overlays
        .filter((item) => item.collection === 'issues' && item.mode === 'insert')
        .map((item): PendingIssueRow => {
            const value = item.value as PendingIssue;
            const viewable = item.state === 'unconfirmed' ? (candidates.get(item.id) ?? []) : [];
            const words = wordsOf(item);
            return {
                key: item.id,
                label: PENDING_ISSUE_LABEL,
                title: value.title,
                text: filingText(value),
                state: item.state,
                words,
                candidates: viewable,
                actions: actionsOf(item.state, viewable),
                createdAt: item.createdAt,
                accessibilityLabel: `New issue, ${value.title}, ${words}`,
            };
        })
        .sort((a, b) => b.createdAt - a.createdAt || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

/**
 * View on an unconfirmed filing: the candidate issue to open next (its key,
 * the issue screen's route param), after `current`, from the first again past
 * the last; null with none.
 */
export function nextIssueCandidate(candidates: readonly string[], current: string | null): string | null {
    if (candidates.length === 0) {
        return null;
    }
    const at = current === null ? -1 : candidates.indexOf(current);
    return candidates[(at + 1) % candidates.length]!;
}

/** What Copy takes from a refused filing: its title, then its description. */
export const filingText = (value: Pick<PendingIssue, 'title' | 'body'>) =>
    value.body.trim() === '' ? value.title : `${value.title}\n\n${value.body}`;
