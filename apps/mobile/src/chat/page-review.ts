import type { ReviewedPage } from '@socio/shared/pages/page-library';
import {
    draftProblem,
    matchesReviewedDraft,
    type PageReviewRequest,
    parsePageReviewArgs,
    restorePageReview,
} from '@socio/shared/pages/page-review';
import { simpleHtmlToMarkdown } from '@socio/shared/text/simple-html';

import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';
import type { OverlayItem } from '../sync/outbox-overlay';
import type { EditorText } from '../sync/page-drafts';
import { type PageReviewOverlay, reviewedPagePath } from '../sync/page-review';
import { reviewEditsError } from '../sync/review-edits';

import type { Card } from './cards';
import { NO_ACCESS } from './composer';

// The page review's words: its card in the transcript and its sheet, the
// web's PageReviewCard's states with Save and Skip, and Edit.
// - The card says where the review stands: open ("Ready for your review",
//   which opens the sheet), the decision on its way ("Saving…",
//   "Skipping…"), refused (opens the sheet again: Retry, or Skip), or ended
//   (saved, with "Open page"; skipped, "No page was saved.").
// - The sheet shows the draft (its title and Markdown, through the
//   reply's renderer) and asks the receipt as it opens, online only: a decision
//   already saved is restored from it (Save reads "Continue", which answers
//   the socio with that page), one saved from another draft or deleted since
//   offers only Skip, as does a draft that doesn't read (Skip sends it back
//   with what to fix). Offline the receipt can't be had: Save and Skip still
//   queue, and the decision asks for the receipt itself before it saves.
// - Editing: wherever Save is offered, Edit opens the draft in the
//   page editor; the sheet then shows the person's version, Save saves it
//   (over the limits, Save waits with the web's words) and Discard edits goes
//   back to the socio's. Skip clears the edits too, so with edits it asks
//   first, as Discard edits does (`skipConfirm`). A review decided elsewhere, or saved from another
//   draft, keeps the edits with Copy and "Save as a new page"; so does one
//   saved elsewhere from the socio's draft, whose Continue answers with that
//   page and doesn't send the edits.
// No React Native here: tests/chat runs it under Node.

export type PageReviewCard = Extract<Card, { kind: 'page-review' }>;

export const REVIEW_READY = 'Ready for your review';
export const REVIEW_SAVED = 'Saved to your Space';
export const REVIEW_ENDED = 'Review ended';
export const REVIEW_NOT_SAVED = 'No page was saved.';
export const REVIEW_NOTHING_YET = 'Nothing is saved until you choose Save.';
export const REVIEW_ON_ITS_WAY = 'Draft on its way';
export const REVIEW_CHECKING = 'Checking whether this draft was already saved.';
export const REVIEW_CONFLICT = 'This review was saved with a different draft. Skip it, and ask for a new review.';
export const REVIEW_DELETED = 'The page saved from this review was deleted.';
export const REVIEW_EDITED = 'You edited this draft. Save keeps your version.';
export const REVIEW_EDITS_KEPT =
    'This review was decided elsewhere. Your edits are still on this phone: copy them, or save them as a new page.';
export const EDIT_DRAFT = 'Edit';
export const DISCARD_EDITS = 'Discard edits';

/** A confirm before the person's edits go: the title, the line and the destructive button. */
export interface EditsConfirm {
    readonly title: string;
    readonly message: string;
    readonly action: string;
}

/** Discard edits asks first. */
export const DISCARD_EDITS_CONFIRM: EditsConfirm = {
    title: 'Discard your edits?',
    message: 'The review goes back to the socio’s draft.',
    action: 'Discard',
};

/**
 * Skip with edits asks first too: a Skip clears them (sync/page-review.ts's
 * `reviewDecided`). It asks in Discard edits' words (its title and button), so
 * losing the edits reads the same from either button; only the line says what Skip does.
 */
export const SKIP_EDITS_CONFIRM: EditsConfirm = {
    title: DISCARD_EDITS_CONFIRM.title,
    message: 'The review is skipped: no page is saved, and your version of this draft is removed from this phone.',
    action: DISCARD_EDITS_CONFIRM.action,
};

/**
 * What Skip asks before it goes: the web's review ends with
 * nothing left over ("No page was saved."), so Skip still clears the edits,
 * but never silently: with edits it asks first, as Discard edits does.
 */
export function skipConfirm(edits: EditorText | null): EditsConfirm | null {
    return edits === null ? null : SKIP_EDITS_CONFIRM;
}

/** What a refused decision says, by its reason (never the server's text). */
export function refusalLine(reason: string | null): string {
    switch (reason) {
        case 'conflict':
            return REVIEW_CONFLICT;
        case 'deleted':
            return REVIEW_DELETED;
        case 'invalid-draft':
            return 'This draft can’t be saved as sent.';
        case 'gone':
            return NO_ACCESS;
        default:
            return 'Not sent. Try again, or skip it.';
    }
}

/** The draft's title and Markdown as shown: the person's edits when there are some, else the socio's draft. */
export function reviewDraftShown(
    args: unknown,
    edits: EditorText | null = null,
): { readonly title: string; readonly content: string } {
    if (edits !== null) {
        return { title: edits.title.trim() || 'Untitled draft', content: edits.content };
    }
    const draft = parsePageReviewArgs(args);
    const value = (draft.success ? draft.data : (args ?? {})) as Record<string, unknown>;
    const title = typeof value.title === 'string' ? value.title.trim() : '';
    const content = typeof value.content === 'string' ? value.content : '';
    return { title: title || 'Untitled draft', content: simpleHtmlToMarkdown(content) };
}

/** The decision row laid over a review (the outbox's overlay of `PAGE_REVIEW_VIEW`), if any. */
export function reviewDecision(overlays: readonly OverlayItem[], toolCallId: string): OverlayItem | undefined {
    return overlays.find((item) => (item.value as PageReviewOverlay).toolCallId === toolCallId);
}

export interface ReviewCardView {
    readonly heading: string;
    readonly note: string | null;
    /** `review` opens the sheet; `open-page` the saved page on the web. */
    readonly action: { readonly kind: 'review' } | { readonly kind: 'open-page'; readonly href: string } | null;
    /** The person decides now: the card is drawn in the primary tone. */
    readonly waiting: boolean;
    readonly problem: boolean;
}

/**
 * The card's words. `open` is whether the chat's newest stored run waits on
 * this review (sync/page-review.ts's `openReviews`); `stored` whether the
 * call comes from a stored run (else from the live turn).
 */
export function reviewCardView(
    card: PageReviewCard,
    { open, stored, decision }: { open: boolean; stored: boolean; decision: OverlayItem | undefined },
): ReviewCardView {
    const view = (heading: string, note: string | null, action: ReviewCardView['action'] = null) => ({
        heading,
        note,
        action,
        waiting: false,
        problem: false,
    });
    if (card.result !== null) {
        const { page } = card.result;
        if (!card.result.approved) {
            return view(REVIEW_ENDED, REVIEW_NOT_SAVED);
        }
        return view(
            REVIEW_SAVED,
            null,
            page === null ? null : { kind: 'open-page', href: reviewedPagePath(page.spaceId, page.pageId) },
        );
    }
    if (decision !== undefined) {
        const approved = (decision.value as PageReviewOverlay).approved;
        switch (decision.state) {
            case 'unsent':
                return {
                    heading: approved ? 'Couldn’t save this page' : 'Couldn’t skip this review',
                    note: refusalLine(decision.reason),
                    action: { kind: 'review' },
                    waiting: false,
                    problem: true,
                };
            case 'sent':
                return approved ? view(REVIEW_SAVED, null) : view(REVIEW_ENDED, REVIEW_NOT_SAVED);
            default:
                return view(approved ? 'Saving…' : 'Skipping…', null);
        }
    }
    if (open) {
        return {
            heading: REVIEW_READY,
            note: REVIEW_NOTHING_YET,
            action: { kind: 'review' },
            waiting: true,
            problem: false,
        };
    }
    return stored ? view(REVIEW_ENDED, REVIEW_NOT_SAVED) : view(REVIEW_ON_ITS_WAY, null);
}

/** Where the receipt stands, as the sheet asked it (`GET …/reviewed-page/:toolCallId`). */
export type ReviewReceipt =
    | { readonly kind: 'checking' }
    /** Offline, or the server failed: decided without it (the decision asks again). */
    | { readonly kind: 'unknown' }
    | { readonly kind: 'none' }
    | { readonly kind: 'saved'; readonly page: ReviewedPage }
    /** The page this review saved was deleted since (410). */
    | { readonly kind: 'deleted' };

export interface ReviewSheetView {
    readonly heading: string;
    /** Lines under the draft: why Save isn't offered, a refusal, the receipt check. */
    readonly lines: readonly { readonly text: string; readonly problem: boolean }[];
    /** Save's label ("Save", or "Continue" for a review already saved), or null when not offered. */
    readonly save: string | null;
    readonly skip: boolean;
    /** The saved page's path, for "Open page". */
    readonly page: string | null;
    /** Offer Edit: wherever a new Save is. */
    readonly edit: boolean;
    /** Offer Discard edits: the person's edits are kept. */
    readonly discard: boolean;
    /** The edits outlived their review: offer Copy and "Save as a new page". */
    readonly keep: boolean;
    /**
     * Save sends the edits: false for Continue on a receipt that doesn't hold
     * them (saved elsewhere from the socio's draft, or an older receipt with
     * no draft), which answers with the stored page and keeps the edits.
     */
    readonly sendEdits: boolean;
}

/** Whether a receipt holds these edits (the web's check: the title trimmed). */
function holdsEdits(page: ReviewedPage, edits: EditorText | null): boolean {
    return (
        edits !== null &&
        page.reviewDraft !== undefined &&
        page.reviewDraft !== null &&
        page.reviewDraft.title === edits.title.trim() &&
        page.reviewDraft.content === edits.content
    );
}

/** The sheet's state: what it says and which of Save, Skip and Edit it offers. */
export function reviewSheetView(
    card: PageReviewCard,
    {
        open,
        receipt,
        decision,
        edits = null,
    }: { open: boolean; receipt: ReviewReceipt; decision: OverlayItem | undefined; edits?: EditorText | null },
): ReviewSheetView {
    const cardView = reviewCardView(card, { open, stored: true, decision });
    const pageOf = (view: ReviewCardView) => (view.action?.kind === 'open-page' ? view.action.href : null);
    const refused = decision?.state === 'unsent';
    const edited = edits !== null;
    const none = { edit: false, discard: false, keep: false, sendEdits: false };
    /** The review can't take the edits any more: they stay, with Copy and Save as a new page. */
    const kept = edited ? { edit: false, discard: true, keep: true, sendEdits: false } : none;
    // Decided already (stored, or a decision on its way): nothing more to choose.
    if (card.result !== null || (decision !== undefined && !refused) || (!open && !refused)) {
        // This phone's own decision clears its edits; any left were decided elsewhere.
        const keep = edited && decision === undefined;
        return {
            heading: cardView.heading,
            lines: keep ? [{ text: REVIEW_EDITS_KEPT, problem: false }] : [],
            save: null,
            skip: false,
            page: pageOf(cardView),
            ...(keep ? kept : none),
        };
    }
    const lines: { text: string; problem: boolean }[] = [];
    if (refused) {
        lines.push({ text: refusalLine(decision.reason), problem: true });
    }
    const draft = parsePageReviewArgs(card.args);
    if (receipt.kind === 'saved') {
        if (!matchesReviewedDraft(receipt.page, card.args) && !holdsEdits(receipt.page, edits)) {
            lines.push({ text: REVIEW_CONFLICT, problem: true });
            return { heading: 'Review changed', lines, save: null, skip: true, page: null, ...kept };
        }
        // Saved with these edits: Continue sends them (edited: true) and they go.
        // Saved elsewhere from the socio's draft (or an older receipt with no
        // draft): Continue answers with that page, and the edits stay.
        const holds = holdsEdits(receipt.page, edits);
        if (edited && !holds) {
            lines.push({ text: REVIEW_EDITS_KEPT, problem: false });
        }
        return {
            heading: REVIEW_SAVED,
            lines,
            save: 'Continue',
            skip: false,
            page: reviewedPagePath(receipt.page.spaceId, receipt.page.id),
            ...(holds ? { ...none, sendEdits: true } : kept),
        };
    }
    if (receipt.kind === 'deleted') {
        lines.push({ text: REVIEW_DELETED, problem: true });
        return { heading: 'Saved, then deleted', lines, save: null, skip: true, page: null, ...kept };
    }
    if (!draft.success) {
        lines.push({
            text: `This draft can’t be saved as sent (${draftProblem(draft.error)}). Skip sends it back to be fixed.`,
            problem: true,
        });
        return { heading: 'Draft needs fixing', lines, save: null, skip: true, page: null, ...none };
    }
    if (refused && decision.reason === 'conflict' && edited) {
        // Saved elsewhere from another draft: these edits can't go to this review.
        return { heading: cardView.heading, lines, save: null, skip: true, page: null, ...kept };
    }
    const problem = edits === null ? undefined : reviewEditsError(edits);
    if (problem !== undefined) {
        lines.push({ text: problem, problem: true });
    } else if (receipt.kind === 'checking') {
        lines.push({ text: REVIEW_CHECKING, problem: false });
    } else if (edited && !refused) {
        lines.push({ text: REVIEW_EDITED, problem: false });
    } else if (!refused) {
        lines.push({ text: REVIEW_NOTHING_YET, problem: false });
    }
    return {
        heading: refused ? cardView.heading : REVIEW_READY,
        lines,
        save: problem === undefined ? 'Save' : null,
        skip: true,
        page: null,
        edit: true,
        discard: edited,
        keep: false,
        sendEdits: edited,
    };
}

/** A receipt request's answer that was neither 2xx nor 410. */
class ReceiptFailed extends Error {
    override name = 'ReceiptFailed';
}

/** The review's receipt, asked once as the sheet opens (shared's `restorePageReview`). Never throws. */
export async function readReviewReceipt(
    fetch: AuthedFetch,
    threadId: string,
    toolCallId: string,
    signal?: AbortSignal,
): Promise<ReviewReceipt> {
    let deleted = false;
    const request: PageReviewRequest = async <T>(path: string) => {
        const response = await fetch(`/api${path}`, { signal });
        if (response.status === 410) {
            deleted = true;
        }
        if (!response.ok) {
            throw new ReceiptFailed(`HTTP ${response.status}`);
        }
        return (await readJson(response, signal)) as T;
    };
    try {
        const page = await restorePageReview(request, threadId, toolCallId);
        return page === null ? { kind: 'none' } : { kind: 'saved', page };
    } catch {
        return deleted ? { kind: 'deleted' } : { kind: 'unknown' };
    }
}
