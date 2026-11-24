// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory, IDBKeyRange as FakeKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
    chatHistory,
    chained,
    forgetHistories,
    historyScope,
    type ChatHistory,
} from '../src/modules/chat/sync/chat-history';
import { closeSyncStore, openSyncStore, type StoredRow } from '../src/modules/chat/sync/idb';
import { forgetSessionMemory } from '../src/shell/auth-channel';

import { FakeHistory } from './helpers/fake-history';

// CB-136: a chat's history on the client store. What the store keeps
// shows at once and only what came after it is asked for; another person
// never sees it; signing out empties it; it stays within its bounds.
let server: FakeHistory;
let fetched: string[];
let hold: Promise<void> | undefined;

beforeEach(async () => {
    await closeSyncStore();
    forgetHistories();
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', FakeKeyRange);
    server = new FakeHistory(3);
    fetched = [];
    hold = undefined;
    vi.stubGlobal('fetch', async (input: string) => {
        fetched.push(input);
        await hold;
        return server.respond(input, 'c1') ?? new Response(JSON.stringify({ error: 'Not here' }), { status: 404 });
    });
});
afterEach(async () => {
    forgetHistories();
    await closeSyncStore();
    vi.unstubAllGlobals();
});

const settled = async (history: ChatHistory) => {
    for (let i = 0; i < 200 && !history.state.settled; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(history.state.settled).toBe(true);
};
const ids = (history: ChatHistory) => history.list().flatMap((run) => run.messages.map((message) => message.id));
/** As a reload does: nothing in memory, the store as it was. */
const reload = async () => {
    forgetHistories();
    await closeSyncStore();
};

it('opens cold from the newest page, then from the store, asking only for what came after', async () => {
    for (let n = 1; n <= 5; n++) {
        server.turn(n);
    }
    const cold = chatHistory('alice', 'c1');
    await settled(cold);
    expect(server.asked).toEqual(['']);
    expect(ids(cold)).toEqual(['u3', 'a3', 'u4', 'a4', 'u5', 'a5']);
    expect(cold.state).toMatchObject({ ready: true, earlier: true });
    // The live query sees the same runs, in order.
    expect(cold.collection.toArray.map((run) => run.seq)).toEqual([30, 40, 50]);

    await reload();
    server.turn(6);
    // The server is slow: the store's runs show before it answers.
    let answer: () => void = () => {};
    hold = new Promise<void>((resolve) => (answer = resolve));
    const warm = chatHistory('alice', 'c1');
    for (let i = 0; i < 200 && !warm.state.ready; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(warm.state.ready).toBe(true);
    expect(ids(warm)).toEqual(['u3', 'a3', 'u4', 'a4', 'u5', 'a5']);
    answer();
    await settled(warm);
    expect(server.asked).toEqual(['', 'after=50']);
    expect(ids(warm).slice(-2)).toEqual(['u6', 'a6']);
    // The connection replays only what comes after the newest…
    expect(warm.connectAfter()).toBe(60);
    expect(warm.has('u6')).toBe(true);
    expect(warm.idsAfter(50).map((message) => message.id)).toEqual(['u6', 'a6']);
    // …unless the newest waits on the person (a page review): then it too.
    server.add([
        { id: 'u7', role: 'user', content: 'Draft the page' },
        {
            id: 'a7',
            role: 'assistant',
            content: '',
            toolCalls: [
                {
                    id: 'review-1',
                    type: 'function',
                    function: { name: 'review_space_page', arguments: '{}' },
                },
            ],
        },
    ]);
    await warm.pull();
    expect(warm.connectAfter()).toBe(60);
});

it('pages older turns in above, until the first', async () => {
    for (let n = 1; n <= 5; n++) {
        server.turn(n);
    }
    const history = chatHistory('alice', 'c1');
    await settled(history);
    await history.loadEarlier();
    expect(server.asked.at(-1)).toBe('before=30');
    expect(ids(history)).toEqual([1, 2, 3, 4, 5].flatMap((n) => [`u${n}`, `a${n}`]));
    expect(history.state.earlier).toBe(false);
    // Kept: a reload shows them all, from the store.
    await reload();
    const again = chatHistory('alice', 'c1');
    await settled(again);
    expect(ids(again)).toHaveLength(10);
    expect(server.asked.at(-1)).toBe('after=50');
});

it('starts again from the newest page when what came after does not follow on', async () => {
    for (let n = 1; n <= 3; n++) {
        server.turn(n);
    }
    const history = chatHistory('alice', 'c1');
    await settled(history);
    // Long away: more than a page came since.
    for (let n = 4; n <= 9; n++) {
        server.turn(n);
    }
    await history.pull();
    expect(server.asked.slice(-2)).toEqual(['after=30', '']);
    expect(ids(history)).toEqual(['u7', 'a7', 'u8', 'a8', 'u9', 'a9']);
    expect(history.state.earlier).toBe(true);
    // A store that lost the chain shows only what chains down from the newest.
    const runs = server.runs;
    expect(chained([runs[0], runs[1], runs[3], runs[4]]).map((r) => r.seq)).toEqual([40, 50]);
});

it('never shows one person’s chats to another, and forgets them on sign-out', async () => {
    server.turn(1);
    const alice = chatHistory('alice', 'c1');
    await settled(alice);
    // Kept for alice.
    const kept = await (await openSyncStore('alice'))!.read(historyScope('c1'));
    expect(kept).toHaveLength(1);
    // bob signs in on this browser: alice's are gone, here and on disk.
    const bob = chatHistory('bob', 'c1');
    expect(bob).not.toBe(alice);
    await settled(bob);
    await reload();
    expect(await (await openSyncStore('alice'))!.read(historyScope('c1'))).toEqual([]);
    // Signing out empties the store.
    const again = chatHistory('alice', 'c1');
    await settled(again);
    forgetSessionMemory();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await closeSyncStore();
    const store = await openSyncStore('alice');
    expect(await store!.read(historyScope('c1'))).toEqual([]);
});

it('drops a conversation that is gone, and replays as before without a history', async () => {
    vi.stubGlobal(
        'fetch',
        async () =>
            new Response(JSON.stringify({ error: 'Conversation not found.' }), {
                status: 404,
            }),
    );
    const history = chatHistory('alice', 'c1');
    await settled(history);
    expect(history.state).toMatchObject({ failed: true, ready: false });
    expect(history.connectAfter()).toBeUndefined();
});

it('keeps the store within its bounds: least recently used chats go first', async () => {
    const store = (await openSyncStore('alice'))!;
    const row = (scope: string, key: number, size: number): StoredRow<string> => ({
        scope,
        key,
        value: 'x',
        size,
    });
    const bounds = { scopes: 2, size: 100 };
    await store.write('chat:a', [row('chat:a', 1, 30)], [], bounds);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.write('chat:b', [row('chat:b', 1, 30)], [], bounds);
    await new Promise((resolve) => setTimeout(resolve, 2));
    // Reading a marks it used: b is now the oldest.
    await store.read('chat:a');
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.write('chat:c', [row('chat:c', 1, 30)], [], bounds);
    expect(await store.read('chat:b')).toEqual([]);
    expect(await store.read('chat:a')).toHaveLength(1);
    expect(await store.read('chat:c')).toHaveLength(1);
    // Too big together: the one used longest ago goes.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.write('chat:c', [row('chat:c', 2, 60)], [], bounds);
    expect(await store.read('chat:a')).toEqual([]);
    // One chat too big alone keeps its newest rows.
    await store.write('chat:c', [row('chat:c', 3, 40), row('chat:c', 4, 40)], [], bounds);
    expect((await store.read('chat:c')).map((kept) => kept.key)).toEqual([3, 4]);
});
