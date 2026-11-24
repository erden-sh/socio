import { pageDraftError } from '@socio/shared/pages/page-draft';
import type { PageReviewEdits } from '@socio/shared/pages/page-review';

import { type Drafts, DraftError, reviewDraft } from './chat-drafts';
import type { OutboxRow } from './outbox';
import { createPageDrafts, type EditorDraft, type PageDrafts, parseEditorDraft } from './page-drafts';
import { type CreatePageOptions, pageCreateWrite } from './page-manage';

// A page review's edits: the person edits the socio's draft in the page editor
// before saving it. No React Native: tests/sync runs it under Node.
//
// - **Where they live:** `drafts`, scope `review:<threadId>:<toolCallId>`
//   (chat-drafts.ts's `reviewDraft`, exempt from `DRAFTS_KEPT`), as the page
//   editor's JSON (`EditorDraft`, revision 0: a draft has none), through
//   page-drafts.ts's throttled writes with no sink, so nothing queues and no
//   page lane is touched. A kill loses at most about 2 s, as a page's editor.
// - **The limits** are the page's and the review's: a title, at most
//   160 characters, and some text, at most 100,000 (`pageReviewSchema`'s
//   `min(1)`). Checked on the device, so Save never queues edits the server
//   would refuse (`reviewEditsError`).
// - **Save** sends them through the decision's row (page-review.ts), and they
//   go once this phone's decision reaches the chat. Discard edits deletes them,
//   so the review shows the socio's draft again.
// - **Decided elsewhere** (the web, another phone, a message that skipped it):
//   they stay, with Copy and "Save as a new page" (`saveEditsAsNewPage`, which
//   queues the page and deletes them in one transaction).

/** A review's edits have no revision. */
export const REVIEW_EDIT_REVISION = 0;

/** The words when a review's edits have no text left (`pageReviewSchema`'s `content` is `min(1)`). */
export const REVIEW_EDITS_EMPTY = 'Add some text to save this page.';

/** The web's words when the edits can't be saved as a page from this review, else undefined. */
export function reviewEditsError(edits: PageReviewEdits): string | undefined {
    return (
        pageDraftError({ title: edits.title, content: edits.content, parentId: null }) ??
        (edits.content.trim() === '' ? REVIEW_EDITS_EMPTY : undefined)
    );
}

/** The review drafts' open editors: page-drafts.ts's drafts on `review:` scopes, with no sink. */
export function createReviewDrafts(options: {
    readonly drafts: Drafts;
    readonly connected: () => boolean;
    readonly onError?: (error: unknown) => void;
}): PageDrafts {
    return createPageDrafts({
        ...options,
        // Keyed by the scope itself (`reviewDraft`), never a page's.
        scopeOf: (key) => key,
        check: reviewEditsError,
    });
}

/** The review's edits on disk, or undefined (none, unreadable, or a newer build's). */
export function storedEdits(
    drafts: Pick<Drafts, 'read'>,
    threadId: string,
    toolCallId: string,
): EditorDraft | undefined {
    const record = drafts.read(reviewDraft(threadId, toolCallId));
    return record.text ? parseEditorDraft(record.text) : undefined;
}

/** Deletes the review's edits (Discard edits, or this phone's decision reached the chat). Never throws. */
export function dropEdits(
    drafts: Pick<Drafts, 'read' | 'write'>,
    threadId: string,
    toolCallId: string,
    onError: (error: unknown) => void = () => {},
): void {
    const scope = reviewDraft(threadId, toolCallId);
    if (drafts.read(scope).text === '') {
        return;
    }
    try {
        drafts.write(scope, '');
    } catch (error) {
        // A newer build's (locked): left as it is.
        if (!(error instanceof DraftError)) {
            onError(error);
        }
    }
}

/** Where the review's editor starts: the edits kept, else the socio's draft (its Space, fixed). */
export function reviewEditStart(
    stored: EditorDraft | undefined,
    draft: { readonly title: string; readonly content: string; readonly spaceId?: string | null },
): EditorDraft {
    return (
        stored ?? {
            spaceId: draft.spaceId ?? '',
            revision: REVIEW_EDIT_REVISION,
            title: draft.title,
            content: draft.content,
        }
    );
}

/**
 * "Save as a new page" for edits whose review was decided elsewhere: queues
 * the page in `spaceId` from the edits on disk and deletes them in the
 * insert's transaction (`enqueueFromDraft`), so a second tap finds nothing.
 * Resolves with the page's local id, or null when nothing was left.
 */
export async function saveEditsAsNewPage(
    drafts: Pick<Drafts, 'enqueueFromDraft'>,
    threadId: string,
    toolCallId: string,
    options: Omit<CreatePageOptions, 'title' | 'content' | 'parentId'>,
): Promise<string | null> {
    let localId: string | null = null;
    const row: OutboxRow | null = await drafts.enqueueFromDraft(reviewDraft(threadId, toolCallId), (text) => {
        const edits = parseEditorDraft(text);
        if (edits === undefined) {
            throw new DraftError('These edits can’t be read.');
        }
        const made = pageCreateWrite({ ...options, title: edits.title, content: edits.content, parentId: null });
        localId = made.localId;
        return made.write;
    });
    return row === null ? null : localId;
}
