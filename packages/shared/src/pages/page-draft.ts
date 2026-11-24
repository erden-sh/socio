import type { Page } from './page-library.js';

/** What the editor can change on a page, and what an autosave sends. */
export type PageDraft = Pick<Page, 'title' | 'content' | 'parentId'>;

/** How long the editor waits after the last keystroke before saving. */
export const AUTOSAVE_DEBOUNCE_MS = 800;
/** The server's limits (`pageInput` and `pagePatch`): the title is counted after trimming. */
export const PAGE_TITLE_MAX = 160;
export const PAGE_CONTENT_MAX = 100000;

export const pageDraftOf = (page: Pick<Page, 'title' | 'content' | 'parentId'>): PageDraft => ({
    title: page.title,
    content: page.content,
    parentId: page.parentId,
});

export const sameDraft = (a: PageDraft, b: PageDraft) =>
    a.title === b.title && a.content === b.content && a.parentId === b.parentId;

/** The title as the server stores it: it trims what it is sent (`z.string().trim()`). */
export const pageTitle = (title: string) => title.trim();

/** The draft as the server will store it, so a client compares what it sent with what comes back. */
export const trimmedDraft = (draft: PageDraft): PageDraft => ({ ...draft, title: pageTitle(draft.title) });

/**
 * Why the server would refuse this draft, in the web's words, or undefined
 * when it may be saved. An invalid draft stays with the editor and is never sent.
 */
export function pageDraftError(draft: PageDraft): string | undefined {
    const title = pageTitle(draft.title);
    if (!title || title.length > PAGE_TITLE_MAX || draft.content.length > PAGE_CONTENT_MAX) {
        return 'Use a title up to 160 characters and a document up to 100,000 characters. Your draft is still here.';
    }
    return undefined;
}
