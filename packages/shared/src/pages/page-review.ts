import { z } from 'zod';

import type { ReviewedPage } from './page-library.js';

/** A reviewed draft as saved: the Space it went to is always known. */
export const pageReviewSchema = z
    .object({
        title: z.string().trim().min(1).max(160),
        // The same limit as any page (pageInput).
        content: z.string().min(1).max(100000),
        spaceId: z.string().min(1),
    })
    .strict();
export type PageReviewDraft = z.infer<typeof pageReviewSchema>;
/**
 * What the Dot sends. Like create_space_page, the Space may be left out for
 * the default one (the server picks it on save), and stray fields are
 * dropped: a draft the card cannot read would leave it waiting (CB-81).
 */
export const pageReviewArgsSchema = pageReviewSchema.extend({
    // Strict tool schemas make it nullable rather than optional.
    spaceId: z
        .string()
        .min(1)
        .nullish()
        .describe('Authorized Space ID. Defaults to the current page Space or the default destination.'),
});
export type PageReviewArgs = z.infer<typeof pageReviewArgsSchema>;
export const parsePageReviewArgs = (args: unknown) => pageReviewArgsSchema.strip().safeParse(args);
export const pageReviewTool = {
    name: 'review_space_page',
    description:
        'Present a Markdown draft for human review before saving it into an authorized Space. The user can approve and save, or decline. Do not create the page yourself after this tool: its approved result includes the saved page URL. Call once, then wait for the review result.',
    parameters: z.toJSONSchema(pageReviewArgsSchema),
};

/**
 * How a client calls the server's API, given by the client: a path under
 * `/api`, then the method and a JSON body. It resolves with the parsed
 * answer and rejects on an error status.
 */
export type PageReviewRequest = <T>(path: string, method?: 'GET' | 'POST', body?: unknown) => Promise<T>;

const reviewPath = (threadId: string) => `/conversations/${encodeURIComponent(threadId)}/reviewed-page`;

/** The page a review already saved, if it did (the receipt). */
export function restorePageReview(request: PageReviewRequest, threadId: string, toolCallId: string) {
    return request<ReviewedPage | null>(`${reviewPath(threadId)}/${encodeURIComponent(toolCallId)}`);
}

/**
 * The draft as the person edited it before saving: a title and Markdown in
 * place of the socio's. The Space stays the draft's.
 */
export type PageReviewEdits = Pick<PageReviewDraft, 'title' | 'content'>;

/** Whether a receipt holds this draft (the Space left out meaning the saved one). */
function sameDraft(saved: PageReviewDraft, draft: PageReviewArgs) {
    return (
        draft.title === saved.title &&
        draft.content === saved.content &&
        // A draft without a Space went to the default one, as saved.
        (draft.spaceId ?? saved.spaceId) === saved.spaceId
    );
}

/**
 * A review's tool result, as far as a receipt check needs it: the result
 * object, or its JSON text (CopilotKit hands the web the text).
 */
function reviewResultOf(result: unknown): { approved?: unknown; pageId?: unknown; edited?: unknown } | null {
    let value = result;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return null;
        }
    }
    return typeof value === 'object' && value !== null ? value : null;
}

/**
 * Whether a saved review is the review of this draft. The receipt holds the
 * draft as saved, so a draft the person edited before saving matches only
 * through its tool result: approved, edited, naming this page.
 */
export function matchesReviewedDraft(page: ReviewedPage, args: unknown, result?: unknown) {
    // Receipts created before draft binding have no original snapshot.
    if (!page.reviewDraft) {
        return true;
    }
    const draft = parsePageReviewArgs(args);
    if (draft.success && sameDraft(page.reviewDraft, draft.data)) {
        return true;
    }
    const decided = reviewResultOf(result);
    return decided?.approved === true && decided.edited === true && decided.pageId === page.id;
}

/**
 * The person's decision on a draft: the page it saved (now or before), or
 * null when declined. It always asks for a receipt first, so a save whose
 * answer was lost is never made twice. With `edits`, it saves the edited
 * title and Markdown, and a receipt counts only if it holds those edits
 * (a retry after a lost answer sends the same edits).
 */
export async function decidePageReview(
    request: PageReviewRequest,
    threadId: string,
    toolCallId: string,
    args: unknown,
    approved: boolean,
    edits?: PageReviewEdits,
): Promise<ReviewedPage | null> {
    const parsed = parsePageReviewArgs(args);
    // The edited draft, checked as the server checks it (the title trimmed).
    // Edits apply to a draft that reads: its Space is the one they go to.
    const edited =
        edits && parsed.success
            ? parsePageReviewArgs({ ...parsed.data, title: edits.title, content: edits.content })
            : undefined;
    // A previous save may have committed even if its response never arrived.
    const previous = await restorePageReview(request, threadId, toolCallId);
    if (previous) {
        const matches = !edits
            ? matchesReviewedDraft(previous, args)
            : !!edited?.success && (!previous.reviewDraft || sameDraft(previous.reviewDraft, edited.data));
        if (!matches) {
            throw new Error('This review was saved with a different draft. Start a new review for the changed draft.');
        }
        return previous;
    }
    if (!approved) {
        return null;
    }
    if (edited && !edited.success) {
        throw new Error(`This draft cannot be saved as edited (${draftProblem(edited.error)}).`);
    }
    const draft = edited ?? parsed;
    if (!draft.success) {
        throw new Error('This draft cannot be saved as sent.');
    }
    return request<ReviewedPage>(reviewPath(threadId), 'POST', {
        ...draft.data,
        toolCallId,
    });
}

/**
 * The tool's result once the draft is saved; `url` is the page's path in the
 * client. A draft the person edited first says so, so the socio reads the
 * page rather than trusting its own draft (and so a receipt holding the
 * edits still matches, `matchesReviewedDraft`).
 */
export const pageReviewApproved = (
    page: Pick<ReviewedPage, 'id' | 'spaceId'>,
    url: string,
    { edited = false }: { edited?: boolean } = {},
) => ({
    approved: true as const,
    pageId: page.id,
    spaceId: page.spaceId,
    url,
    ...(edited && {
        edited: true as const,
        message:
            'The owner edited this draft before saving it, so the saved page differs from what you sent. Read the page before referring to its text.',
    }),
});

/**
 * The tool's result when nothing was saved: declined, or sent back because
 * the draft doesn't read, with what to fix.
 */
export function pageReviewDeclined(args: unknown) {
    const draft = parsePageReviewArgs(args);
    return {
        approved: false as const,
        message: draft.success
            ? 'The owner declined this draft. Do not save it.'
            : `The owner sent this draft back: it cannot be saved as sent (${draftProblem(draft.error)}). Nothing was saved. Fix it and call ${pageReviewTool.name} again.`,
    };
}

/** The first thing wrong with a draft, said to the socio and the person. */
export function draftProblem(error?: z.ZodError) {
    const issue = error?.issues[0];
    return issue ? `${issue.path.join('.') || 'draft'}: ${issue.message}` : 'it is not a page draft';
}
