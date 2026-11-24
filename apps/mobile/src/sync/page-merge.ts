import { mergeTitledText } from '@socio/shared/pages/merge-lines';
import { pageTitle } from '@socio/shared/pages/page-draft';

// A page's text, compared and merged as the server stores it:
// titles trimmed, the body on lines through shared's `mergeTitledText`. Apart
// from page-save.ts so the editor's drafts (page-drafts.ts) merge with the
// same rule without importing the outbox kind.
//
// No React Native: tests/sync runs it under Node.

export interface PageText {
    readonly title: string;
    readonly content: string;
}

/** A text that may not be known: a save's base when the phone no longer held that revision. */
export interface MaybePageText {
    readonly title: string | null;
    readonly content: string | null;
}

/** Whether two texts are the same page, as the server stores them (titles trimmed). */
export const sameText = (a: PageText, b: MaybePageText) =>
    b.title !== null && b.content !== null && pageTitle(a.title) === pageTitle(b.title) && a.content === b.content;

/**
 * `ours`, an edit of `base`, merged onto `theirs` on lines (shared's
 * `mergeTitledText`, titles trimmed): the merged text, or null when it isn't
 * clean or the base's text isn't known.
 */
export function mergePageText(base: MaybePageText, ours: PageText, theirs: PageText): PageText | null {
    if (base.title === null || base.content === null) {
        return null;
    }
    const merged = mergeTitledText(
        { title: pageTitle(base.title), body: base.content },
        { title: pageTitle(ours.title), body: ours.content },
        { title: pageTitle(theirs.title), body: theirs.content },
    );
    return merged.clean ? { title: merged.title, content: merged.body.text } : null;
}
