import type { AuthedFetch } from '../net/authed-fetch';

import { readAnswer } from './outbox-answers';

// Save as page (the web's chat header button; the PWA comparison's 2.1): the
// chat written into a page of the socio's Space by the server
// (`POST /api/conversations/:id/page {title}`), then opened. Online only,
// never queued or sent again by itself, as the web does it: the server writes
// the page with the model, and a second request would make a second page.
// Never the server's text: statuses only (10.2). No React Native:
// tests/sync runs it under Node.

/** The server's limit on the title. */
export const SAVED_PAGE_TITLE_MAX = 160;

export type SaveChatPageResult =
    | { readonly outcome: 'done'; readonly spaceId: string; readonly pageId: string }
    | { readonly outcome: 'offline' | 'no-answer' | 'invalid' | 'refused' | 'failed' };

/** The words for an outcome that isn't `done`. */
export const SAVE_CHAT_PAGE_COPY = {
    offline: 'Needs a connection to save the chat as a page.',
    'no-answer': 'No answer came. Check the Space’s pages before you save it again.',
    invalid: `Enter a title of 1 to ${SAVED_PAGE_TITLE_MAX} characters.`,
    refused: 'This chat can’t be saved as a page.',
    failed: 'Couldn’t save the chat as a page. Try again in a moment.',
} as const satisfies Record<Exclude<SaveChatPageResult['outcome'], 'done'>, string>;

/** The title as the server keeps it, or null when it isn't 1 to 160 characters. */
export function savedPageTitle(text: string): string | null {
    const title = text.trim();
    return title.length >= 1 && title.length <= SAVED_PAGE_TITLE_MAX ? title : null;
}

export const saveChatPagePath = (threadId: string) => `/api/conversations/${encodeURIComponent(threadId)}/page`;

/** Saves chat `threadId` as a page titled `title`: once, online only. */
export async function saveChatAsPage(
    context: { readonly fetch: AuthedFetch; readonly connected: boolean | null },
    input: { readonly threadId: string; readonly title: string },
): Promise<SaveChatPageResult> {
    const title = savedPageTitle(input.title);
    if (title === null) {
        return { outcome: 'invalid' };
    }
    if (context.connected === false) {
        return { outcome: 'offline' };
    }
    let answer: Awaited<ReturnType<typeof readAnswer>>;
    try {
        answer = await readAnswer(
            await context.fetch(saveChatPagePath(input.threadId), { method: 'POST', json: { title } }),
        );
    } catch {
        // It may have reached the server: never sent again by itself.
        return { outcome: 'no-answer' };
    }
    if (answer.status >= 200 && answer.status < 300) {
        const page = answer.body as { id?: unknown; spaceId?: unknown } | null;
        return page !== null && typeof page.id === 'string' && typeof page.spaceId === 'string'
            ? { outcome: 'done', spaceId: page.spaceId, pageId: page.id }
            : { outcome: 'failed' };
    }
    if (answer.status === 400) {
        return { outcome: 'invalid' };
    }
    if (answer.status === 403 || answer.status === 404 || answer.status === 410) {
        return { outcome: 'refused' };
    }
    return { outcome: 'failed' };
}
