import { lineChanges, type LineChange } from '@socio/shared/pages/merge-lines';
import { pageTitle } from '@socio/shared/pages/page-draft';

import { compareConflict, type PageConflict, type PageMergeChange } from '../sync/page-conflicts';

// What the page's conflict banner and its merge toast say, under Node. The
// web's page notice says "This page changed elsewhere. Your draft is safe.";
// the phone keeps that and offers the four ways out. Who changed it isn't
// named: "someone else".

/** The toast after a clean merge. */
export const MERGED_TOAST = 'Merged with changes made elsewhere';

export const USE_MINE = 'Use mine';
export const KEEP_THEIRS = 'Keep theirs';
export const SAVE_AS_NEW = 'Save mine as a new page';
export const COMPARE = 'Compare';
/** Compare's sheet's title. */
export const COMPARE_TITLE = 'Your version and theirs';

/** Use mine's confirm. */
export const USE_MINE_CONFIRM = {
    title: 'Replace the changes made elsewhere?',
    message: 'Your version replaces what someone else saved on this page.',
    action: 'Replace',
} as const;

/** Keep theirs' confirm. */
export const KEEP_THEIRS_CONFIRM = {
    title: 'Discard your version?',
    message: 'The page keeps the changes made elsewhere, and your version is removed from this phone.',
    action: 'Discard',
} as const;

/** Save mine as a new page: the Space picker's title, and the toast once it is queued. */
export const SAVE_AS_NEW_PICK = 'Save your version as a new page in';
export const SAVED_AS_NEW = 'Saved your version as a new page';

/** The Spaces Save as a new page offers: the page's own first, then the others by name. */
export function saveAsNewTargets<S extends { readonly id: string; readonly name: string }>(
    spaces: readonly S[],
    spaceId: string,
): S[] {
    return [
        ...spaces.filter((space) => space.id === spaceId),
        ...spaces.filter((space) => space.id !== spaceId).sort((a, b) => a.name.localeCompare(b.name)),
    ];
}

/** The banner over a page with conflicts, or null with none. */
export interface ConflictBanner {
    readonly heading: string;
    readonly line: string;
    /** The conflict its actions take: the oldest. */
    readonly conflict: PageConflict;
    /** Whether Compare has a version to compare with (an older build's conflict kept none). */
    readonly canCompare: boolean;
}

export function conflictBanner(conflicts: readonly PageConflict[]): ConflictBanner | null {
    const conflict = conflicts[0];
    if (conflict === undefined) {
        return null;
    }
    const more = conflicts.length - 1;
    return {
        heading: 'This page changed elsewhere',
        line:
            more === 0
                ? 'Someone else saved changes while yours were waiting. Your version is safe on this phone.'
                : `Someone else saved changes while yours were waiting. ${conflicts.length} versions of yours are safe on this phone; this is the oldest.`,
        conflict,
        canCompare: conflict.theirs !== null,
    };
}

/** The words of a line-by-line diff: Compare's, or the merge toast's "See what changed". */
export interface DiffWords {
    /** The line above the rows: what − and + mean. */
    readonly legend: string;
    /** What a screen reader says before a removed line, and an added one. */
    readonly removed: string;
    readonly added: string;
    readonly removedTitle: string;
    readonly addedTitle: string;
}

/** Compare (the conflict banner): theirs, now on the page, against yours. */
export const COMPARE_WORDS: DiffWords = {
    legend: '− Theirs, now on the page · + Yours',
    removed: 'Theirs',
    added: 'Yours',
    removedTitle: 'Their title',
    addedTitle: 'Your title',
};

/** The merge toast's action, and its sheet's title. */
export const SEE_WHAT_CHANGED = 'See what changed';
export const WHAT_CHANGED_TITLE = 'Changes made elsewhere';

/** "See what changed": what the person's save sent, against the merge it now stands on. */
export const MERGE_WORDS: DiffWords = {
    legend: '− Before the merge · + Changed elsewhere',
    removed: 'Before',
    added: 'Changed elsewhere',
    removedTitle: 'Title before',
    addedTitle: 'Title now',
};

/** One line of a diff: in both, only on the − side, or only on the + side. */
export interface CompareLine {
    readonly key: string;
    readonly kind: 'same' | 'removed' | 'added';
    readonly text: string;
    /** What a screen reader says before the line. */
    readonly label: string | null;
}

/** Lines in both that are shown around each change; the rest fold into "N unchanged lines". */
export const COMPARE_CONTEXT = 2;

/** A diff's rows: the title when it differs, then the body's changes with a little context around them. */
function diffRows(
    title: { readonly removed: string; readonly added: string } | null,
    lines: readonly LineChange[],
    words: DiffWords,
): CompareLine[] {
    const rows: CompareLine[] = [];
    if (title !== null) {
        rows.push({ key: 'title-removed', kind: 'removed', text: title.removed, label: words.removedTitle });
        rows.push({ key: 'title-added', kind: 'added', text: title.added, label: words.addedTitle });
    }
    lines.forEach((change: LineChange, index) => {
        const split = change.text.replace(/\n$/, '').split('\n');
        if (change.kind === 'same') {
            const first = index === 0 ? [] : split.slice(0, COMPARE_CONTEXT);
            const last = index === lines.length - 1 ? [] : split.slice(-COMPARE_CONTEXT);
            const folded = split.length - first.length - last.length;
            if (folded <= 1) {
                // One line folded takes as much room as the line itself.
                split.forEach((text, at) => rows.push({ key: `${index}-${at}`, kind: 'same', text, label: null }));
                return;
            }
            first.forEach((text, at) => rows.push({ key: `${index}-a${at}`, kind: 'same', text, label: null }));
            rows.push({
                key: `${index}-fold`,
                kind: 'same',
                text: `${folded} unchanged lines`,
                label: null,
            });
            last.forEach((text, at) => rows.push({ key: `${index}-z${at}`, kind: 'same', text, label: null }));
            return;
        }
        const kind = change.kind === 'removed' ? 'removed' : 'added';
        split.forEach((text, at) =>
            rows.push({ key: `${index}-${at}`, kind, text, label: kind === 'removed' ? words.removed : words.added }),
        );
    });
    return rows;
}

/** Compare's rows: theirs (−) against yours (+). */
export function compareLines(conflict: PageConflict): CompareLine[] {
    const { title, lines } = compareConflict(conflict);
    return diffRows(title === null ? null : { removed: title.theirs, added: title.mine }, lines, COMPARE_WORDS);
}

/** "See what changed" after a clean merge: what the save sent (−) against the merge (+), from shared's `lineChanges`. */
export function mergeChangeLines(change: PageMergeChange): CompareLine[] {
    const before = pageTitle(change.before.title);
    const after = pageTitle(change.after.title);
    return diffRows(
        before === after ? null : { removed: before, added: after },
        lineChanges(change.before.content, change.after.content),
        MERGE_WORDS,
    );
}

/**
 * One diff sheet (the owner's choice): Compare and "See what
 * changed" open the same sheet, each with its title, legend and rows.
 */
export interface DiffSheet {
    readonly title: string;
    readonly legend: string;
    readonly rows: readonly CompareLine[];
    /** The sheet's testID; its rows are `${testID}-lines`, its button `${testID}-done`. */
    readonly testID: string;
}

/** Compare's sheet: theirs, now on the page, against yours. */
export function compareSheet(conflict: PageConflict): DiffSheet {
    return {
        title: COMPARE_TITLE,
        legend: COMPARE_WORDS.legend,
        rows: compareLines(conflict),
        testID: 'page-conflict-compare-sheet',
    };
}

/** "See what changed"'s sheet: what the save sent against the merge. */
export function whatChangedSheet(change: PageMergeChange): DiffSheet {
    return {
        title: WHAT_CHANGED_TITLE,
        legend: MERGE_WORDS.legend,
        rows: mergeChangeLines(change),
        testID: 'page-what-changed',
    };
}
