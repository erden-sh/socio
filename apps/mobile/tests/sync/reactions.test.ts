import { describe, expect, it } from 'vitest';

import type { AuthedFetch } from '../../src/net/authed-fetch';
import { createReactionsStore, OPEN_REACTIONS } from '../../src/sync/reactions';

// The scope's reactions store: GET on use, a write's view newer than a GET in flight.

const view = (mine: string[]) => ({ shared: false, messages: mine.length ? { a1: { counts: { up: 1 }, mine } } : {} });

function deferredFetch() {
    const pending: { path: string; resolve: (response: Response) => void }[] = [];
    const fetch: AuthedFetch = (path) => new Promise((resolve) => pending.push({ path, resolve }));
    return { fetch, pending };
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('reactions store', () => {
    it("asks the server as a chat opens, and a write's view wins over a GET sent before it", async () => {
        const { fetch, pending } = deferredFetch();
        const store = createReactionsStore({ fetch });
        const chat = store.reactions('c1');
        const release = chat.use();
        expect(pending[0]?.path).toBe('/api/conversations/c1/reactions');
        store.take('c1', view(['up']));
        pending[0]!.resolve(ok(view([])));
        await tick();
        expect(chat.state.view.messages.a1?.mine).toEqual(['up']);
        // Asked again, and that answer is taken.
        await tick();
        pending[1]!.resolve(ok(view([])));
        await tick();
        expect(chat.state).toMatchObject({ ready: true, failed: false, view: { messages: {} } });
        release();
    });

    it('keeps what it holds when a GET fails or answers something else, and never asks for a local chat', async () => {
        const { fetch, pending } = deferredFetch();
        const store = createReactionsStore({ fetch, isLocal: (id) => id.startsWith('local-') });
        store.take('c1', view(['up']));
        const chat = store.reactions('c1');
        void chat.refresh();
        pending[0]!.resolve(ok({ nope: true }));
        await tick();
        expect(chat.state).toMatchObject({ failed: true, view: { messages: { a1: { mine: ['up'] } } } });
        store.reactions('local-1').use();
        expect(pending).toHaveLength(1);
    });

    it('holds at most OPEN_REACTIONS chats, never one in use', () => {
        const store = createReactionsStore({ fetch: deferredFetch().fetch });
        const kept = store.reactions('kept');
        kept.use();
        store.take('kept', view(['up']));
        for (let i = 0; i < OPEN_REACTIONS + 2; i += 1) {
            store.reactions(`c${i}`);
        }
        expect(store.reactions('kept')).toBe(kept);
        expect(store.reactions('c0').state.ready).toBe(false);
    });
});
