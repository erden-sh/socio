import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HistoryRun } from '@socio/shared/chat/chat-history';
import { HISTORY_FORMAT, historyScope } from '@socio/shared/chat/history-chain';

import { openCacheDb, type SqlConnection } from '../../src/data';
import type { AuthedFetch } from '../../src/net/authed-fetch';
import {
    createHistoryStore,
    HANDOFF_MS,
    type HistoryStore,
    type HistoryStoreOptions,
    OPEN_HISTORIES,
} from '../../src/sync/history';
import { HISTORY, HISTORY_RUN_MAX_CHARS } from '../../src/sync/history-disk';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';
import { settle } from '../net/helpers';

import { CACHE_KEY } from './helpers';

// The chat history store
// against a fake history endpoint that pages as the server's historyPage does
// (src/server/workspace/chat-history.ts), on a real cache.db (node:sqlite):
// the chain, gaps and `more`, older pages, 404s, previews, local ids, the
// streaming hold, and the memory and disk bounds.

const PAGE = 20;

function run(seq: number, prev: number | null, text = `reply ${seq}`): HistoryRun {
    return {
        seq,
        prev,
        runId: `r${seq}`,
        status: 'completed' as HistoryRun['status'],
        startedAt: seq,
        finishedAt: seq + 1,
        messages: [
            { id: `u${seq}`, role: 'user', content: `ask ${seq}` },
            { id: `a${seq}`, role: 'assistant', content: text },
        ],
        times: { messages: [], tools: [], reasoning: [] },
        light: {},
        size: text.length,
    };
}

/** A fake server's conversations: each a list of finished runs, chained by `prev`. */
function historyServer() {
    const threads = new Map<string, HistoryRun[]>();
    const requests: string[] = [];
    const results = new Map<string, string>();
    const add = (threadId: string, count = 1, text?: (seq: number) => string) => {
        const runs = threads.get(threadId) ?? [];
        for (let index = 0; index < count; index += 1) {
            const prev = runs.at(-1)?.seq ?? null;
            const seq = (prev ?? 0) + 10;
            runs.push(run(seq, prev, text?.(seq)));
        }
        threads.set(threadId, runs);
    };
    const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetch: AuthedFetch = async (input) => {
        requests.push(input);
        const url = new URL(input, 'https://brain.example.test');
        const match = /^\/api\/conversations\/([^/]+)\/(history|tool-results\/(.+))$/.exec(url.pathname);
        const runs = match ? threads.get(decodeURIComponent(match[1]!)) : undefined;
        if (!match || !runs) {
            return json(404, { error: 'Not found.' });
        }
        if (match[3] !== undefined) {
            const content = results.get(decodeURIComponent(match[3]));
            return content === undefined ? json(404, { error: 'Not found.' }) : json(200, { content });
        }
        const after = url.searchParams.get('after');
        const before = url.searchParams.get('before');
        if (after !== null) {
            const later = runs.filter((r) => r.seq > Number(after));
            return json(200, { runs: later.slice(0, PAGE), more: later.length > PAGE });
        }
        const older = before === null ? runs : runs.filter((r) => r.seq < Number(before));
        return json(200, { runs: older.slice(-PAGE), more: false });
    };
    return { threads, requests, results, add, fetch };
}

interface Setup {
    directory: string;
    db: SqlConnection;
    server: ReturnType<typeof historyServer>;
    store: HistoryStore;
    gone: string[];
    errors: unknown[];
}

const setups: Setup[] = [];
afterEach(async () => {
    for (const s of setups.splice(0)) {
        await s.store.close().catch(() => {});
        await s.db.close().catch(() => {});
        rmSync(s.directory, { recursive: true, force: true });
    }
});

let clock = 1_000;
async function setup(
    options: Partial<HistoryStoreOptions> & { directory?: string; server?: ReturnType<typeof historyServer> } = {},
): Promise<Setup> {
    const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'socio-history-'));
    const { db } = await openCacheDb(createNodeSqliteDriver(), directory, CACHE_KEY);
    const server = options.server ?? historyServer();
    const gone: string[] = [];
    const errors: unknown[] = [];
    const store = createHistoryStore({
        scopeId: `ws.${setups.length + 1}`,
        db,
        fetch: server.fetch,
        onGone: (threadId) => gone.push(threadId),
        onError: (error) => errors.push(error),
        now: () => (clock += 1),
        ...options,
    });
    const s = { directory, db, server, store, gone, errors };
    setups.push(s);
    return s;
}

/** Closes a setup's store and file, keeping the directory: a relaunch opens it again. */
async function relaunch(s: Setup, options: Partial<HistoryStoreOptions> = {}) {
    await s.store.close();
    await s.db.close();
    setups.splice(setups.indexOf(s), 1);
    return setup({ directory: s.directory, server: s.server, ...options });
}

const seqs = (runs: readonly HistoryRun[]) => runs.map((r) => r.seq);

/**
 * A fetch that holds the answers to paths `holds` matches: each is what the
 * server had when asked, handed back only once `release()` is called.
 */
function gatedFetch(server: ReturnType<typeof historyServer>, holds: RegExp) {
    let release = () => {};
    let gate: Promise<void> | null = null;
    const asked: string[] = [];
    const fetch: AuthedFetch = async (input, init) => {
        const answer = await server.fetch(input, init);
        if (gate && holds.test(input)) {
            asked.push(input);
            await gate;
        }
        return answer;
    };
    return {
        fetch,
        asked,
        hold() {
            gate = new Promise<void>((done) => (release = done));
        },
        release() {
            gate = null;
            release();
        },
    };
}
async function seqsOnDisk(db: SqlConnection, threadId: string) {
    const rows = await db.all<{ key: string }>('SELECT key FROM rows WHERE collection = ? AND scope = ?', [
        HISTORY,
        historyScope(threadId),
    ]);
    return rows.map((row) => Number(row.key)).sort((a, b) => a - b);
}

describe('the chat history store', () => {
    it('pulls the newest page on a cold open, keeps it, and reads it back with no request', async () => {
        const s = await setup();
        s.server.add('c1', 25);
        const chat = s.store.history('c1');
        const release = chat.use();
        await chat.pull();
        await s.store.flush();
        expect(s.server.requests).toEqual(['/api/conversations/c1/history']);
        expect(seqs(chat.collection.toArray)).toEqual(seqs(s.server.threads.get('c1')!.slice(-PAGE)));
        expect(chat.state).toMatchObject({ ready: true, settled: true, failed: false, earlier: true });
        expect(await seqsOnDisk(s.db, 'c1')).toEqual(seqs(chat.list()));
        release();

        const again = await relaunch(s);
        const kept = await again.store.preload('c1');
        expect(again.server.requests).toHaveLength(1);
        expect(kept.collection.status).toBe('ready');
        expect(seqs(kept.collection.toArray)).toEqual(seqs(chat.list()));
        expect(kept.state.ready).toBe(true);
        expect(kept.connectAfter()).toBe(250);

        // Opening it asks only for what came after the newest.
        again.server.add('c1', 2);
        kept.use();
        await kept.pull();
        expect(again.server.requests.at(-1)).toBe('/api/conversations/c1/history?after=250');
        expect(seqs(kept.list()).slice(-3)).toEqual([250, 260, 270]);
    });

    it('re-pulls the newest page when an `after` page says more, or doesn’t chain', async () => {
        const s = await setup();
        s.server.add('c1', 3);
        const chat = s.store.history('c1');
        await chat.pull();
        // Weeks away: more than a page came since.
        s.server.add('c1', 30);
        await chat.pull();
        expect(s.server.requests.slice(-2)).toEqual([
            '/api/conversations/c1/history?after=30',
            '/api/conversations/c1/history',
        ]);
        expect(seqs(chat.list())).toEqual(seqs(s.server.threads.get('c1')!.slice(-PAGE)));
        await s.store.flush();
        expect(await seqsOnDisk(s.db, 'c1')).toEqual(seqs(chat.list()));

        // A page whose first run doesn't follow the newest held (a gap) replaces what's held.
        const runs = s.server.threads.get('c1')!;
        runs.push(run(1000, 990), run(1010, 1000));
        await chat.pull();
        expect(s.server.requests.slice(-2)).toEqual([
            '/api/conversations/c1/history?after=330',
            '/api/conversations/c1/history',
        ]);
        expect(seqs(chat.list()).slice(-3)).toEqual([330, 1000, 1010]);
    });

    it('pages older runs in only when they end where the held ones begin', async () => {
        const s = await setup();
        s.server.add('c1', 45);
        const chat = s.store.history('c1');
        await chat.pull();
        expect(chat.state.earlier).toBe(true);
        await chat.loadEarlier();
        expect(s.server.requests.at(-1)).toBe('/api/conversations/c1/history?before=260');
        expect(chat.list()).toHaveLength(40);
        await chat.loadEarlier();
        expect(chat.list()).toHaveLength(45);
        expect(chat.state).toMatchObject({ earlier: false, loadingEarlier: false });
        const before = s.server.requests.length;
        await chat.loadEarlier();
        expect(s.server.requests).toHaveLength(before);
        await s.store.flush();
        expect(await seqsOnDisk(s.db, 'c1')).toHaveLength(45);
    });

    it('drops a chat the server says is gone, here and on disk, and tells the Unsent list', async () => {
        const s = await setup();
        s.server.add('c1', 3);
        const chat = s.store.history('c1');
        await chat.pull();
        await s.store.flush();
        expect(await seqsOnDisk(s.db, 'c1')).toHaveLength(3);
        s.server.threads.delete('c1');
        await chat.pull();
        await s.store.flush();
        expect(chat.list()).toEqual([]);
        expect(chat.collection.size).toBe(0);
        expect(chat.state).toMatchObject({ gone: true, ready: false });
        expect(s.gone).toEqual(['c1']);
        expect(await seqsOnDisk(s.db, 'c1')).toEqual([]);
        expect(await s.db.get('SELECT * FROM scopes WHERE scope = ?', [historyScope('c1')])).toBeNull();
    });

    it('keeps what it holds when the server is away, and fails only with nothing to show', async () => {
        const server = historyServer();
        server.add('c1', 2);
        let away = false;
        const fetch: AuthedFetch = async (input, init) =>
            away ? new Response('', { status: 502 }) : server.fetch(input, init);
        const s = await setup({ server, fetch });
        const chat = s.store.history('c1');
        await chat.pull();
        away = true;
        await chat.pull();
        expect(chat.state).toMatchObject({ ready: true, failed: false });
        expect(chat.list()).toHaveLength(2);
        const empty = s.store.history('c2');
        await empty.pull();
        expect(empty.state).toMatchObject({ ready: false, failed: true });
        expect(s.gone).toEqual([]);
    });

    it('never reads the network for a chat with a local id', async () => {
        const s = await setup({ isLocal: (threadId) => threadId.startsWith('local-') });
        const chat = await s.store.preload('local-1');
        chat.use();
        await chat.pull();
        await chat.loadEarlier();
        await expect(chat.fullResult('call-1')).rejects.toThrow();
        expect(s.server.requests).toEqual([]);
        expect(chat.state).toMatchObject({ ready: true, settled: true, gone: false });
        expect(chat.connectAfter()).toBe(0);
    });

    it('fetches a preview’s whole result once, and asks again after a failure', async () => {
        const s = await setup();
        s.server.add('c1', 1);
        const chat = s.store.history('c1');
        await expect(chat.fullResult('call-1')).rejects.toThrow();
        s.server.results.set('call-1', 'the whole result');
        expect(await chat.fullResult('call-1')).toBe('the whole result');
        expect(await chat.fullResult('call-1')).toBe('the whole result');
        expect(s.server.requests.filter((path) => path.endsWith('/tool-results/call-1'))).toHaveLength(2);
    });

    it('writes nothing while a run streams, then all of it as the run ends', async () => {
        const s = await setup();
        s.server.add('c1', 2);
        const chat = s.store.history('c1');
        const end = chat.streaming();
        await chat.pull();
        s.server.add('c1', 1);
        await chat.pull();
        await s.store.flush();
        expect(chat.list()).toHaveLength(3);
        expect(await seqsOnDisk(s.db, 'c1')).toEqual([]);
        end();
        end();
        await settle();
        await s.store.flush();
        expect(await seqsOnDisk(s.db, 'c1')).toEqual([10, 20, 30]);
    });

    it('never keeps a run over 4 MB on disk, but shows it', async () => {
        const s = await setup();
        s.server.add('c1', 2, (seq) => (seq === 20 ? 'x'.repeat(HISTORY_RUN_MAX_CHARS) : 'short'));
        const chat = s.store.history('c1');
        await chat.pull();
        await s.store.flush();
        expect(seqs(chat.list())).toEqual([10, 20]);
        expect(await seqsOnDisk(s.db, 'c1')).toEqual([10]);
    });

    it('holds at most 8 chats in memory, never evicting one a screen shows', async () => {
        const s = await setup();
        const shown = s.store.history('c0');
        shown.use();
        const first = s.store.history('c1');
        for (let index = 2; index <= OPEN_HISTORIES + 2; index += 1) {
            s.store.history(`c${index}`);
        }
        const held = s.store.held();
        expect(held).toHaveLength(OPEN_HISTORIES);
        expect(held).toContain('c0');
        expect(held.at(-1)).toBe(`c${OPEN_HISTORIES + 2}`);
        expect(held).not.toContain('c1');
        // An evicted chat's collection is ended for good.
        await settle();
        await s.store.flush();
        await settle();
        expect(first.collection.status).toBe('cleaned-up');
    });

    it('evicts the least recently used chats past the disk bounds, never a shown or pinned one', async () => {
        const pins = new Set<string>();
        const s = await setup({ bounds: { chats: 3, chars: 1_000_000 }, pinned: () => pins });
        for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) {
            s.server.add(id, 1);
        }
        pins.add('c1');
        const shown = s.store.history('c2');
        shown.use();
        await shown.pull();
        for (const id of ['c1', 'c3', 'c4', 'c5']) {
            await s.store.history(id).pull();
        }
        await s.store.flush();
        const scopes = await s.db.all<{ scope: string }>('SELECT scope FROM scopes ORDER BY scope');
        expect(scopes.map((row) => row.scope)).toEqual([historyScope('c1'), historyScope('c2'), historyScope('c5')]);
        expect(await seqsOnDisk(s.db, 'c3')).toEqual([]);
        expect(await seqsOnDisk(s.db, 'c4')).toEqual([]);
        // An evicted chat that no screen shows leaves memory too.
        expect(s.store.held()).not.toContain('c3');
    });

    it('evicts by size too', async () => {
        const s = await setup({ bounds: { chats: 100, chars: 3_000 } });
        for (const id of ['c1', 'c2', 'c3']) {
            s.server.add(id, 1, () => 'y'.repeat(1_000));
            await s.store.history(id).pull();
        }
        await s.store.flush();
        const scopes = await s.db.all<{ scope: string; bytes: number }>(
            'SELECT scope, bytes FROM scopes ORDER BY scope',
        );
        expect(scopes.map((row) => row.scope)).toEqual([historyScope('c2'), historyScope('c3')]);
        expect(scopes.every((row) => row.bytes > 1_000)).toBe(true);
    });

    it('drops only the runs kept in another format as it opens', async () => {
        const s = await setup();
        s.server.add('c1', 1);
        await s.store.history('c1').pull();
        await s.store.flush();
        const old = `chat:${HISTORY_FORMAT - 1}:c9`;
        await s.db.run(
            "INSERT INTO rows (collection, scope, key, json, version, seenAt) VALUES (?, ?, '10', '{}', 10, 1)",
            [HISTORY, old],
        );
        await s.db.run('INSERT INTO scopes (scope, lastUsed, bytes) VALUES (?, 1, 2)', [old]);
        const again = await relaunch(s);
        await again.store.flush();
        expect(await again.db.all('SELECT * FROM rows WHERE scope = ?', [old])).toEqual([]);
        expect(await again.db.all('SELECT * FROM scopes WHERE scope = ?', [old])).toEqual([]);
        expect(await seqsOnDisk(again.db, 'c1')).toEqual([10]);
    });

    it('writes what waits as it closes, and takes nothing after', async () => {
        const s = await setup();
        s.server.add('c1', 1);
        const chat = s.store.history('c1');
        chat.streaming();
        await chat.pull();
        await s.store.close();
        expect(await seqsOnDisk(s.db, 'c1')).toEqual([10]);
        expect(() => s.store.history('c2')).toThrow();
        expect(chat.collection.status).toBe('cleaned-up');
    });

    it('drops an older page that comes after a pull replaced the runs, leaving no gap', async () => {
        const server = historyServer();
        server.add('c1', 45);
        const gated = gatedFetch(server, /before=/);
        const s = await setup({ server, fetch: gated.fetch });
        const chat = s.store.history('c1');
        await chat.pull();
        gated.hold();
        const earlier = chat.loadEarlier();
        await vi.waitFor(() => expect(gated.asked).toHaveLength(1));
        // Weeks of runs since: the pull replaces what's held with the newest page.
        server.add('c1', 30);
        await chat.pull();
        const newest = seqs(server.threads.get('c1')!.slice(-PAGE));
        expect(seqs(chat.list())).toEqual(newest);
        gated.release();
        await earlier;
        await s.store.flush();
        expect(seqs(chat.list())).toEqual(newest);
        expect(await seqsOnDisk(s.db, 'c1')).toEqual(newest);
        expect(chat.state.loadingEarlier).toBe(false);
    });

    it('waits for a pull in flight before asking for an older page', async () => {
        const server = historyServer();
        server.add('c1', 45);
        const gated = gatedFetch(server, /history$|after=/);
        const s = await setup({ server, fetch: gated.fetch });
        const chat = s.store.history('c1');
        await chat.pull();
        server.add('c1', 30);
        gated.hold();
        const pulling = chat.pull();
        const earlier = chat.loadEarlier();
        await vi.waitFor(() => expect(gated.asked.length).toBeGreaterThan(0));
        expect(server.requests.some((path) => path.includes('before='))).toBe(false);
        gated.release();
        await Promise.all([pulling, earlier]);
        // The older page asked goes before what the pull left.
        const oldest = server.threads.get('c1')!.at(-PAGE)!;
        expect(server.requests.at(-1)).toBe(`/api/conversations/c1/history?before=${oldest.seq}`);
        expect(chat.list()).toHaveLength(2 * PAGE);
        expect(seqs(chat.list()).at(-1)).toBe(server.threads.get('c1')!.at(-1)!.seq);
    });

    it('never writes an older page back for a chat a 404 dropped meanwhile', async () => {
        const server = historyServer();
        server.add('c1', 45);
        const gated = gatedFetch(server, /before=/);
        const s = await setup({ server, fetch: gated.fetch });
        const chat = s.store.history('c1');
        await chat.pull();
        gated.hold();
        const earlier = chat.loadEarlier();
        await vi.waitFor(() => expect(gated.asked).toHaveLength(1));
        server.threads.delete('c1');
        await chat.pull();
        expect(chat.state.gone).toBe(true);
        gated.release();
        await earlier;
        await s.store.flush();
        expect(chat.list()).toEqual([]);
        expect(chat.state).toMatchObject({ gone: true, ready: false, earlier: false });
        expect(await seqsOnDisk(s.db, 'c1')).toEqual([]);
        expect(s.gone).toEqual(['c1']);
    });

    it('keeps a preloaded chat in memory until its screen uses it, however many chats open meanwhile', async () => {
        const s = await setup();
        s.server.add('c1', 2);
        const warm = s.store.history('c1');
        await warm.pull();
        await s.store.flush();
        const preloading = s.store.preload('c1');
        for (let index = 2; index <= OPEN_HISTORIES + 3; index += 1) {
            s.store.history(`c${index}`);
        }
        const chat = await preloading;
        for (let index = OPEN_HISTORIES + 4; index <= 2 * OPEN_HISTORIES + 4; index += 1) {
            s.store.history(`c${index}`);
        }
        await settle();
        expect(chat).toBe(warm);
        expect(chat.collection.status).not.toBe('cleaned-up');
        expect(s.store.held()).toContain('c1');
        expect(s.store.history('c1')).toBe(chat);
        const release = chat.use();
        s.server.add('c1', 1);
        expect(await chat.pull()).toBe(true);
        expect(seqs(chat.list())).toEqual([10, 20, 30]);
        // Released, it is an ordinary chat again: the next opens may evict it.
        release();
        for (let index = 100; index < 100 + OPEN_HISTORIES; index += 1) {
            s.store.history(`c${index}`);
        }
        expect(s.store.held()).not.toContain('c1');
    });

    it('lets a preloaded chat nobody used go after HANDOFF_MS', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const s = await setup();
            const chat = await s.store.preload('c1');
            for (let index = 2; index <= OPEN_HISTORIES + 1; index += 1) {
                s.store.history(`c${index}`);
            }
            expect(s.store.held()).toContain('c1');
            vi.advanceTimersByTime(HANDOFF_MS);
            // The least recently used again: the next open evicts it.
            s.store.history('c99');
            expect(s.store.held()).not.toContain('c1');
            expect(s.store.held()).toHaveLength(OPEN_HISTORIES);
            vi.useRealTimers();
            await settle();
            await s.store.flush();
            expect(chat.collection.status).toBe('cleaned-up');
        } finally {
            vi.useRealTimers();
        }
    });

    it('takes no late answer and writes nothing once a chat left memory', async () => {
        const server = historyServer();
        server.add('c1', 2);
        const gated = gatedFetch(server, /after=/);
        const s = await setup({ server, fetch: gated.fetch });
        const chat = s.store.history('c1');
        await chat.pull();
        await s.store.flush();
        const end = chat.streaming();
        server.add('c1', 1);
        gated.hold();
        const late = chat.pull();
        await vi.waitFor(() => expect(gated.asked).toHaveLength(1));
        // Evicted from memory while its pull is out.
        for (let index = 2; index <= OPEN_HISTORIES + 1; index += 1) {
            s.store.history(`c${index}`);
        }
        expect(s.store.held()).not.toContain('c1');
        gated.release();
        expect(await late).toBe(false);
        end();
        await settle();
        await s.store.flush();
        expect(seqs(chat.list())).toEqual([10, 20]);
        expect(await seqsOnDisk(s.db, 'c1')).toEqual([10, 20]);
        // A later copy reads what disk has and pulls the rest itself.
        const again = s.store.history('c1');
        expect(again).not.toBe(chat);
        await again.pull();
        await s.store.flush();
        expect(await seqsOnDisk(s.db, 'c1')).toEqual([10, 20, 30]);
        expect(chat.use()).toBeTypeOf('function');
        expect(await chat.pull()).toBe(false);
    });
});
