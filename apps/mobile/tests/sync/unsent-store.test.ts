import { describe, expect, it } from 'vitest';

import type { HoldGroup, UnsentWrite } from '../../src/sync/outbox';
import { sameItems, unsentStore } from '../../src/sync/unsent-store';

// The Unsent list's store (useUnsent): shared by every screen, it goes
// stale while nobody listens, so each subscription looks once.

function write(id: string): UnsentWrite {
    return { id, kind: 'chat-message', lane: 'chat:c-1', payload: '{}', reason: 'gone', createdAt: 1 } as UnsentWrite;
}

function fakeOutbox() {
    const state = { unsent: [] as UnsentWrite[], holds: [] as HoldGroup[] };
    const listeners = new Set<() => void>();
    return {
        state,
        tell: () => {
            for (const listener of listeners) {
                listener();
            }
        },
        outbox: {
            unsent: () => state.unsent,
            holds: () => state.holds,
            onUnsent: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)),
            subscribe: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)),
        },
    };
}

describe('unsentStore', () => {
    it('keeps one snapshot between changes and a new one after', () => {
        const fake = fakeOutbox();
        const store = unsentStore(fake.outbox as never);
        expect(unsentStore(fake.outbox as never)).toBe(store);
        const stop = store.subscribe(() => {});
        const first = store.get();
        expect(store.get()).toBe(first);
        fake.state.unsent = [write('u-1')];
        fake.tell();
        expect(store.get()).not.toBe(first);
        expect(store.get().writes).toHaveLength(1);
        stop();
    });

    it('catches up on what changed while nobody listened', () => {
        const fake = fakeOutbox();
        const store = unsentStore(fake.outbox as never);
        const stop = store.subscribe(() => {});
        const seen = store.get();
        stop();
        // The last screen went; a refusal lands; the next screen renders the old copy.
        fake.state.unsent = [write('u-1')];
        expect(store.get()).toBe(seen);
        let told = 0;
        const again = store.subscribe(() => (told += 1));
        expect(told).toBe(1);
        expect(store.get().writes.map((w) => w.id)).toEqual(['u-1']);
        again();

        // Nothing changed: no extra render.
        const quiet = store.subscribe(() => (told += 1));
        expect(told).toBe(1);
        quiet();
    });

    it('compares items by identity', () => {
        const a = write('a');
        expect(sameItems([a], [a])).toBe(true);
        expect(sameItems([a], [write('a')])).toBe(false);
        expect(sameItems([], [a])).toBe(false);
    });
});
