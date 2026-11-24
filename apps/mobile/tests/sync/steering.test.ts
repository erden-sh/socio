import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HistoryRun } from '@socio/shared/chat/chat-history';
import type { QueuedMessage, SteeringView } from '@socio/shared/chat/steering';

import { openCacheDb, type SqlConnection } from '../../src/data';
import type { AuthedFetch } from '../../src/net/authed-fetch';
import { createHistoryStore, type HistoryStore } from '../../src/sync/history';
import {
    createSteeringStore,
    OPEN_STEERING,
    queuedBubbles,
    type SteeringStore,
    type SteeringStoreOptions,
} from '../../src/sync/steering';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';
import { settle } from '../net/helpers';

import { CACHE_KEY } from './helpers';

// The steering snapshot against
// a fake server whose `/steering` and `/history` answer as
// src/server/context/steering-routes.ts and the history route do: the view,
// `limit` as maxQueued, a write's answer newer than a GET in flight, 404s,
// local ids, the memory bound, and the overlay rule across the hand-off
// (outbox row, then queued message, then a run in the history), which never
// shows a message twice.

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const queued = (id: string, text = `queued ${id}`, at = 1): QueuedMessage => ({
    id,
    text,
    createdAt: at,
    updatedAt: at,
});

/** A fake server's chats: each its steering queue and its finished runs. */
function steeringServer() {
    const queues = new Map<string, QueuedMessage[]>();
    const runs = new Map<string, HistoryRun[]>();
    const requests: string[] = [];
    let limit = 5;
    let running = false;
    let turn: string | undefined;
    /** Holds the next GET's answer until `release` is called, as a slow network does. */
    let hold: { release: () => void; promise: Promise<void> } | undefined;
    let failNext: number | undefined;
    let nextId = 1;

    const view = (threadId: string): SteeringView => ({
        messages: [...(queues.get(threadId) ?? [])],
        limit,
        ...(turn && { turn }),
        ...(running && { running: true }),
    });
    const fetch: AuthedFetch = async (input) => {
        requests.push(input);
        const url = new URL(input, 'https://brain.example.test');
        const match = /^\/api\/conversations\/([^/]+)\/(steering|history)$/.exec(url.pathname);
        const threadId = match ? decodeURIComponent(match[1]!) : '';
        if (!match || !queues.has(threadId)) {
            return json(404, { error: 'Conversation not found.' });
        }
        if (match[2] === 'history') {
            const after = Number(url.searchParams.get('after') ?? -1);
            return json(200, { runs: (runs.get(threadId) ?? []).filter((r) => r.seq > after), more: false });
        }
        if (failNext !== undefined) {
            const status = failNext;
            failNext = undefined;
            return json(status, { error: 'Something went wrong.' });
        }
        // The answer is what the queue held when the request arrived.
        const answer = view(threadId);
        if (hold) {
            await hold.promise;
        }
        return json(200, answer);
    };
    return {
        queues,
        runs,
        requests,
        fetch,
        view,
        chat(threadId: string) {
            queues.set(threadId, queues.get(threadId) ?? []);
        },
        /** POST …/steering: queues `text` and answers as the server does (201, the message and the view). */
        queue(threadId: string, text: string) {
            const message = queued(`m${nextId++}`, text, nextId);
            queues.get(threadId)!.push(message);
            return { message, ...view(threadId) };
        },
        /** A turn's safe point takes the queue: its messages become a run of the history. */
        deliver(threadId: string) {
            const taken = queues.get(threadId)!.splice(0);
            const list = runs.get(threadId) ?? [];
            const prev = list.at(-1)?.seq ?? null;
            const seq = (prev ?? 0) + 10;
            list.push({
                seq,
                prev,
                runId: `r${seq}`,
                status: 'completed' as HistoryRun['status'],
                startedAt: seq,
                finishedAt: seq + 1,
                messages: [
                    ...taken.map((m) => ({ id: m.id, role: 'user' as const, content: m.text })),
                    { id: `a${seq}`, role: 'assistant' as const, content: 'done' },
                ],
                times: { messages: [], tools: [], reasoning: [] },
                light: {},
                size: 4,
            });
            runs.set(threadId, list);
        },
        set(options: { limit?: number; running?: boolean; turn?: string }) {
            limit = options.limit ?? limit;
            running = options.running ?? running;
            turn = options.turn ?? turn;
        },
        holdNext() {
            let release = () => {};
            const promise = new Promise<void>((done) => (release = done));
            hold = {
                promise,
                release: () => {
                    hold = undefined;
                    release();
                },
            };
            return hold;
        },
        failNext(status: number) {
            failNext = status;
        },
    };
}

interface Setup {
    server: ReturnType<typeof steeringServer>;
    store: SteeringStore;
}

const stores: SteeringStore[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const store of stores.splice(0)) {
        await store.close();
    }
    for (const cleanup of cleanups.splice(0)) {
        await cleanup();
    }
});

function setup(options: Partial<SteeringStoreOptions> & { server?: ReturnType<typeof steeringServer> } = {}): Setup {
    const server = options.server ?? steeringServer();
    const store = createSteeringStore({ scopeId: `ws.${stores.length + 1}`, fetch: server.fetch, ...options });
    stores.push(store);
    return { server, store };
}

async function historyStore(fetch: AuthedFetch): Promise<HistoryStore> {
    const directory = mkdtempSync(join(tmpdir(), 'socio-steering-'));
    const { db }: { db: SqlConnection } = await openCacheDb(createNodeSqliteDriver(), directory, CACHE_KEY);
    const store = createHistoryStore({ scopeId: 'ws.history', db, fetch });
    cleanups.push(async () => {
        await store.close();
        await db.close();
        rmSync(directory, { recursive: true, force: true });
    });
    return store;
}

const ids = (messages: readonly { id: string }[]) => messages.map((m) => m.id);

describe('the steering snapshot', () => {
    it('reads the view as a chat opens: the queue in order, limit as maxQueued, the turn running', async () => {
        const { server, store } = setup();
        server.chat('c1');
        server.queue('c1', 'first');
        server.queue('c1', 'second');
        server.set({ limit: 3, running: true, turn: 'run-7' });
        const chat = store.steering('c1');
        expect(chat.state).toMatchObject({ ready: false, maxQueued: null });
        const release = chat.use();
        await vi.waitFor(() => expect(chat.state.ready).toBe(true));
        expect(server.requests).toEqual(['/api/conversations/c1/steering']);
        expect(chat.list().map((m) => m.text)).toEqual(['first', 'second']);
        expect(ids(chat.collection.toArray)).toEqual(['m1', 'm2']);
        expect(chat.collection.status).toBe('ready');
        expect(chat.state).toMatchObject({ ready: true, failed: false, maxQueued: 3, running: true, turn: 'run-7' });
        expect(chat.lists('m2')).toBe(true);
        expect(chat.lists('m9')).toBe(false);
        release();
    });

    it('takes a write’s view at once, and drops a GET that started before it', async () => {
        const { server, store } = setup();
        server.chat('c1');
        const chat = store.steering('c1');
        await chat.refresh();
        expect(chat.list()).toEqual([]);

        // A stream frame asks again; its answer is slow and holds the queue as it was.
        const held = server.holdNext();
        const refreshing = chat.refresh();
        await settle();
        // Meanwhile this device's POST answers with the message and the view.
        chat.writing()(server.queue('c1', 'while it runs'));
        expect(ids(chat.list())).toEqual(['m1']);
        held.release();
        await refreshing;
        // The older answer never undid the write's; the GET was asked again.
        expect(ids(chat.list())).toEqual(['m1']);
        expect(server.requests.filter((r) => r.endsWith('/steering'))).toHaveLength(3);
    });

    it('never takes a write’s late answer over a GET sent after the write', async () => {
        const { server, store } = setup();
        server.chat('c1');
        const chat = store.steering('c1');
        await chat.refresh();
        // The POST goes; the server queues it and a turn starts with it at once.
        const answered = chat.writing();
        const answer = server.queue('c1', 'steer it');
        server.set({ running: true, turn: 'run-1' });
        server.deliver('c1');
        server.set({ running: false });
        // A stream frame's GET, sent after the POST, answers first: the turn took it and ended.
        await chat.refresh();
        expect(chat.list()).toEqual([]);
        expect(chat.state.running).toBe(false);
        const before = server.requests.length;
        // The POST's answer comes late, with the queue and the run as they were then.
        answered({ ...answer, running: true });
        expect(chat.list()).toEqual([]);
        expect(chat.state.running).toBe(false);
        // It asks again instead, and what it holds stays the newest.
        await vi.waitFor(() => expect(server.requests.length).toBe(before + 1));
        await settle();
        expect(chat.list()).toEqual([]);
        expect(chat.state.running).toBe(false);
    });

    it('makes calls during a refresh one more refresh after it', async () => {
        const { server, store } = setup();
        server.chat('c1');
        const chat = store.steering('c1');
        const held = server.holdNext();
        const first = chat.refresh();
        void chat.refresh();
        void chat.refresh();
        await settle();
        server.queue('c1', 'later');
        held.release();
        await first;
        expect(server.requests).toHaveLength(2);
        expect(ids(chat.list())).toEqual(['m1']);
    });

    it('keeps unchanged messages’ identity, and updates and removes the rest', async () => {
        const { server, store } = setup();
        server.chat('c1');
        server.queue('c1', 'one');
        server.queue('c1', 'two');
        const chat = store.steering('c1');
        await chat.refresh();
        const kept = chat.collection.get('m1');
        const queue = server.queues.get('c1')!;
        queue[1] = { ...queue[1]!, text: 'two, edited', updatedAt: 99 };
        await chat.refresh();
        expect(chat.collection.get('m1')).toBe(kept);
        expect(chat.collection.get('m2')?.text).toBe('two, edited');
        queue.splice(0, 1);
        await chat.refresh();
        expect(ids(chat.collection.toArray)).toEqual(['m2']);
    });

    it('keeps what it holds when a refresh fails, and empties on a 404', async () => {
        const { server, store } = setup();
        server.chat('c1');
        server.queue('c1', 'kept');
        const listener: string[] = [];
        const chat = store.steering('c1');
        chat.subscribe(() => listener.push(chat.state.failed ? 'failed' : 'ok'));
        await chat.refresh();
        server.failNext(500);
        await chat.refresh();
        expect(chat.state).toMatchObject({ ready: true, failed: true, maxQueued: 5 });
        expect(ids(chat.list())).toEqual(['m1']);
        expect(listener).toEqual(['ok', 'failed']);

        // A body that isn't a view counts as a failure too.
        expect(() => chat.writing()({ messages: 'no' })).toThrow();
        expect(ids(chat.list())).toEqual(['m1']);

        server.queues.delete('c1');
        await chat.refresh();
        expect(chat.state).toMatchObject({ ready: false, gone: true, maxQueued: null });
        expect(chat.collection.size).toBe(0);
    });

    it('never asks the network for a chat not created yet', async () => {
        const { server, store } = setup({ isLocal: (threadId) => threadId.startsWith('local-') });
        const chat = store.steering('local-1');
        chat.use();
        await chat.refresh();
        expect(server.requests).toEqual([]);
        expect(chat.state).toMatchObject({ ready: true, maxQueued: null });
        expect(chat.collection.status).toBe('ready');
    });

    it('holds at most 8 chats in memory, never one a screen shows', async () => {
        const { server, store } = setup();
        for (let index = 0; index <= OPEN_STEERING + 1; index += 1) {
            server.chat(`c${index}`);
        }
        const shown = store.steering('c0');
        shown.use();
        for (let index = 1; index <= OPEN_STEERING + 1; index += 1) {
            store.steering(`c${index}`);
        }
        await settle();
        expect(store.held()).toHaveLength(OPEN_STEERING);
        expect(store.held()).toContain('c0');
        expect(store.held()).not.toContain('c1');
        expect(store.held()).not.toContain('c2');
    });

    it('ends every collection on close and takes no more', async () => {
        const { server, store } = setup();
        server.chat('c1');
        const chat = store.steering('c1');
        await chat.refresh();
        await store.close();
        expect(chat.collection.status).toBe('cleaned-up');
        expect(() => store.steering('c1')).toThrow(/closed/);
    });
});

describe('queued bubbles across the hand-off', () => {
    it('shows a message once: outbox row, then queued message, then a run of the history', async () => {
        const { server, store } = setup();
        server.chat('c1');
        const histories = await historyStore(server.fetch);
        const chat = store.steering('c1');
        const history = histories.history('c1');
        await Promise.all([chat.refresh(), history.pull()]);

        const bubbles = (outbox: { rowId: string; serverId?: string | null }[]) => {
            const shown = queuedBubbles(outbox, chat.list(), (id) => history.has(id));
            return [...shown.outbox.map((row) => `outbox:${row.rowId}`), ...shown.queued.map((m) => `queued:${m.id}`)];
        };

        // Queued on the device, not sent yet.
        const row: { rowId: string; serverId?: string | null } = { rowId: 'o1' };
        expect(bubbles([row])).toEqual(['outbox:o1']);

        // The POST answers 201; the hand-off records the server id and applies the view.
        const answer = server.queue('c1', 'steer it');
        row.serverId = answer.message.id;
        expect(bubbles([row])).toEqual(['outbox:o1']);
        chat.writing()(answer);
        expect(bubbles([row])).toEqual(['queued:m1']);
        // The outbox row goes once the hand-off deletes it.
        expect(bubbles([])).toEqual(['queued:m1']);

        // The turn takes it: the history has it before the steering snapshot drops it.
        server.deliver('c1');
        await history.pull();
        expect(chat.lists('m1')).toBe(true);
        expect(bubbles([row])).toEqual([]);
        await chat.refresh();
        expect(bubbles([])).toEqual([]);
        expect(history.has('m1')).toBe(true);
    });

    it('hides an outbox row the server answered as delivered, once the history holds it', async () => {
        const { server, store } = setup();
        server.chat('c1');
        const histories = await historyStore(server.fetch);
        const chat = store.steering('c1');
        const history = histories.history('c1');
        await Promise.all([chat.refresh(), history.pull()]);

        // A 200 `delivered: true`: the view no longer lists it.
        const answer = server.queue('c1', 'taken at once');
        server.deliver('c1');
        chat.writing()({ ...answer, ...server.view('c1'), delivered: true });
        const row = { rowId: 'o1', serverId: answer.message.id };
        const shown = () => queuedBubbles([row], chat.list(), (id) => history.has(id));
        expect(shown().outbox).toEqual([row]);
        await history.pull();
        expect(shown()).toEqual({ outbox: [], queued: [] });
    });
});
