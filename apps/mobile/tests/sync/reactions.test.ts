import { afterEach, describe, expect, it, vi } from 'vitest';

import { reportMark } from '../../src/chat/reply-reports';
import type { AuthedFetch } from '../../src/net/authed-fetch';
import { createReactionsStore, OPEN_REACTIONS, REPORT_POLL_MS } from '../../src/sync/reactions';

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

    it('keeps a report’s outcome with the view, numbered, and the replies to offer "Report it now?" (CB-382)', () => {
        const store = createReactionsStore({ fetch: deferredFetch().fetch });
        const chat = store.reactions('c1');
        const seen: unknown[] = [];
        chat.subscribe(() => seen.push(chat.state.report));
        store.take(
            'c1',
            { ...view(['down']), report: 'consent-changed' },
            { messageId: 'a1', outcome: 'consent-changed' },
        );
        expect(chat.state.report).toEqual({ messageId: 'a1', outcome: 'consent-changed', seq: 1 });
        // The view's own `report` (the answer's) isn't kept as a field of the view.
        expect(chat.state.view).toEqual(view(['down']));
        store.take('c1', view(['down']));
        expect(chat.state.report?.seq).toBe(1);
        store.take('c1', view(['down']), { messageId: 'a1', outcome: 'consent-changed' });
        expect(chat.state.report?.seq).toBe(2);
        chat.offer('a1', true);
        chat.offer('a1', true);
        expect(chat.state.offers).toEqual(['a1']);
        store.take('c1', view([]));
        expect(chat.state.offers).toEqual(['a1']);
        chat.offer('a1', false);
        expect(chat.state.offers).toEqual([]);
        expect(seen.length).toBe(6);
    });

    describe('a queued report while the chat stays open (CB-382)', () => {
        afterEach(() => {
            vi.useRealTimers();
        });
        const withReport = (report: string) => ({
            shared: false,
            messages: { a1: { counts: { down: 1 }, mine: ['down'], report } },
        });

        it('asks again until the collector has it, so the reply shows shared without reopening', async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const { fetch, pending } = deferredFetch();
            const store = createReactionsStore({ fetch });
            const chat = store.reactions('c1');
            const release = chat.use();
            const unwatch = chat.watchQueued();
            pending[0]!.resolve(ok(withReport('queued')));
            await vi.advanceTimersByTimeAsync(0);
            expect(reportMark(chat.state.view, 'a1')).toBeNull();
            // Still queued: asked again after the interval, and again after that.
            await vi.advanceTimersByTimeAsync(REPORT_POLL_MS);
            expect(pending).toHaveLength(2);
            pending[1]!.resolve(ok(withReport('queued')));
            await vi.advanceTimersByTimeAsync(REPORT_POLL_MS);
            expect(pending).toHaveLength(3);
            // The collector took it: shared, and no more asking.
            pending[2]!.resolve(ok(withReport('shared')));
            await vi.advanceTimersByTimeAsync(0);
            expect(reportMark(chat.state.view, 'a1')).toBe('Shared with Ingenio');
            await vi.advanceTimersByTimeAsync(REPORT_POLL_MS * 4);
            expect(pending).toHaveLength(3);
            unwatch();
            release();
        });

        it('starts from a write’s queued answer, and asks nothing unwatched or with none queued', async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const { fetch, pending } = deferredFetch();
            const store = createReactionsStore({ fetch });
            const chat = store.reactions('c1');
            store.take('c1', withReport('queued'));
            await vi.advanceTimersByTimeAsync(REPORT_POLL_MS * 2);
            expect(pending).toHaveLength(0);
            const unwatch = chat.watchQueued();
            await vi.advanceTimersByTimeAsync(REPORT_POLL_MS);
            expect(pending).toHaveLength(1);
            // Leaving (the screen, the foreground or the connection) stops it.
            unwatch();
            pending[0]!.resolve(ok(withReport('queued')));
            await vi.advanceTimersByTimeAsync(REPORT_POLL_MS * 2);
            expect(pending).toHaveLength(1);
            // Watched with nothing queued: nothing.
            store.take('c1', withReport('shared'));
            const again = chat.watchQueued();
            await vi.advanceTimersByTimeAsync(REPORT_POLL_MS * 2);
            expect(pending).toHaveLength(1);
            again();
        });
    });
});
