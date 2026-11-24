/**
 * The web's own parts of the board: its Tailwind tones, where closing an
 * issue goes, and the board/list choice. The words, filters, sorts and
 * control checks are shared with the native app in
 * `@socio/shared/issues/issue-board`.
 */
import { issueExcerpt, type IssuePriority, type IssueStatus } from '@socio/shared/issues/issue-types';

import type { Tone } from '../types';

/**
 * The navigation state of a link that opens an issue over where it was
 * clicked: the board (`fromIssues`) or a chat (`fromChat`, CB-119).
 */
export interface IssueOpenedFrom {
    fromIssues?: boolean;
    fromChat?: boolean;
}
export const OPENED_FROM_CHAT: IssueOpenedFrom = { fromChat: true };

/**
 * Where closing the open issue goes: back (-1) to the board or chat its
 * link was clicked in, so that page shows again as it was; else (a link
 * opened in a new tab, typed or reloaded elsewhere) the board, in place of
 * the issue.
 */
export function issueCloseTarget(state: unknown): -1 | '/issues' {
    const from = state as IssueOpenedFrom | null | undefined;
    return from?.fromIssues || from?.fromChat ? -1 : '/issues';
}

/** Badge colors on the tokens' neutrals plus one hue each, light and dark. */
export const STATUS_TONE: Record<IssueStatus, string> = {
    triage: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300',
    open: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300',
    ready: 'border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300',
    in_progress:
        'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
    in_review:
        'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300',
    blocked: 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300',
    done: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
    wont_fix: 'border-border bg-muted text-muted-foreground',
};
export const PRIORITY_TONE: Record<IssuePriority, string> = {
    critical: 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300',
    high: 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-300',
    medium: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300',
    low: 'border-border bg-muted text-muted-foreground',
};
/**
 * A priority's tone (tones.ts) for the priority pill: every level has a
 * color, the word always inside it.
 */
export const PRIORITY_PILL_TONE: Record<IssuePriority, Tone> = {
    critical: 'rose',
    high: 'orange',
    medium: 'sky',
    low: 'slate',
};
/**
 * A status as a small ring in its hue (border-current): half filled while
 * work is underway, filled when done, a grey ring when won't fix.
 */
export const STATUS_RING: Record<IssueStatus, string> = {
    triage: 'text-violet-500 dark:text-violet-400',
    open: 'text-sky-500 dark:text-sky-400',
    ready: 'text-teal-500 dark:text-teal-400',
    in_progress: 'text-amber-500 dark:text-amber-400 bg-[linear-gradient(90deg,currentColor_50%,transparent_50%)]',
    in_review: 'text-indigo-500 dark:text-indigo-400 bg-[linear-gradient(90deg,currentColor_50%,transparent_50%)]',
    blocked: 'text-red-500 dark:text-red-400',
    done: 'text-emerald-500 dark:text-emerald-400 bg-current',
    wont_fix: 'text-muted-foreground',
};
/** The colored edge of a list row. */
export const PRIORITY_BAR: Record<IssuePriority, string> = {
    critical: 'bg-red-500',
    high: 'bg-orange-500',
    medium: 'bg-sky-500',
    low: 'bg-muted-foreground/30',
};

/** The board or the list, chosen per browser. */
export type IssueView = 'board' | 'list';
const VIEW_KEY = 'issues-view';
/** The board/list choice, per browser. */
export function readView(): IssueView {
    try {
        return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'board';
    } catch {
        return 'board';
    }
}
export function writeView(view: IssueView) {
    try {
        localStorage.setItem(VIEW_KEY, view);
    } catch {
        // Storage off: the choice lasts for this visit.
    }
}

/** A description as one plain line: markdown syntax dropped, shortened. */
export const excerpt = issueExcerpt;
