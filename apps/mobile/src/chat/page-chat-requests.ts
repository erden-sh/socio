// The page conversation's requests (CB-499), the web's PageChatRequests
// (packages/client/src/modules/pages/page-chat-requests.ts) as it is: opening a
// page's chat is tied to the page and socio that asked (`<pageId>:<dotId>`), so
// an answer that comes after the person picked another socio, or left the page
// (`select('')`), opens nothing. The app can't import the web's package, so the
// class is copied; tests/chat/page-chat-requests.test.ts holds the two the same.
// No React Native: the Node tests run it.

/** Keeps asynchronous chat setup tied to the page and specialist that requested it. */
export class PageChatRequests {
    private scope = '';
    private generation = 0;
    select(scope: string) {
        if (scope !== this.scope) {
            this.scope = scope;
            this.generation++;
        }
    }
    async run<T>(
        scope: string,
        load: () => Promise<T>,
        callbacks: {
            success: (value: T) => void;
            failure: (error: unknown) => void;
            settled: () => void;
        },
    ) {
        if (scope !== this.scope) {
            return;
        }
        const generation = ++this.generation;
        const current = () => this.scope === scope && this.generation === generation;
        try {
            const value = await load();
            if (current()) {
                callbacks.success(value);
            }
        } catch (error) {
            if (current()) {
                callbacks.failure(error);
            }
        } finally {
            if (current()) {
                callbacks.settled();
            }
        }
    }
}

/** The scope the web keys a page chat's requests by: the page, then the socio. */
export const pageChatScope = (pageId: string, dotId: string) => `${pageId}:${dotId}`;
