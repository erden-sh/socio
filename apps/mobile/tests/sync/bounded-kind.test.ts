import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openCacheDb, type SqlConnection } from '../../src/data';
import type { AuthedFetch } from '../../src/net/authed-fetch';
import {
    BOUNDED_HANDOFF_MS,
    BOUNDED_MEMORY,
    type BoundedKindDefinition,
    type BoundedStoreOptions,
    createBoundedStore,
} from '../../src/sync/bounded-kind';
import { SnapshotShapeError } from '../../src/sync/errors';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';

import { CACHE_KEY } from './helpers';

// A bounded kind against a
// fake item endpoint, on a real cache.db (node:sqlite): reads on use, disk
// copies with their age, preload with no network, the memory and disk bounds
// (skipping shown and pinned items), the size bound, memory-only items, gone
// items, local keys, and reads a later value overtook.

interface Note {
    readonly id: string;
    readonly text: string;
    readonly rev: number;
}

const NOTES: BoundedKindDefinition<Note> = {
    name: 'note',
    format: 1,
    bounds: { items: 3, chars: 1_000_000 },
    path: (key) => `/api/notes/${key}`,
    parse(path, body) {
        const note = body as Partial<Note> | null;
        if (!note || typeof note.text !== 'string') {
            throw new SnapshotShapeError(path, 'no text.');
        }
        return note as Note;
    },
    version: (note) => note.rev,
};

function notesServer() {
    const notes = new Map<string, Note>();
    const refusals = new Map<string, number>();
    const requests: string[] = [];
    let gate: Promise<void> | null = null;
    let open = () => {};
    const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetch: AuthedFetch = async (input) => {
        requests.push(input);
        const key = decodeURIComponent(input.replace('/api/notes/', ''));
        // What the server had when asked, handed back once the gate opens.
        const note = notes.get(key);
        const refusal = refusals.get(key);
        if (gate) {
            await gate;
        }
        if (refusal !== undefined) {
            return json(refusal, { error: 'No.' });
        }
        return note === undefined ? json(404, { error: 'Not found.' }) : json(200, note);
    };
    return {
        fetch,
        requests,
        set: (id: string, text: string, rev = 1) => notes.set(id, { id, text, rev }),
        refuse: (id: string, status: number) => refusals.set(id, status),
        hold() {
            gate = new Promise<void>((done) => (open = done));
        },
        release() {
            gate = null;
            open();
        },
    };
}

type Server = ReturnType<typeof notesServer>;

interface Setup {
    directory: string;
    db: SqlConnection;
    server: Server;
    store: ReturnType<typeof createBoundedStore<Note>>;
    gone: string[];
    values: string[];
    errors: unknown[];
}

const setups: Setup[] = [];
afterEach(async () => {
    vi.useRealTimers();
    for (const s of setups.splice(0)) {
        await s.store.close().catch(() => {});
        await s.db.close().catch(() => {});
        rmSync(s.directory, { recursive: true, force: true });
    }
});

let clock = 1_000;
async function setup(
    options: Partial<BoundedStoreOptions<Note>> & { directory?: string; server?: Server } = {},
): Promise<Setup> {
    const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'socio-bounded-'));
    const { db } = await openCacheDb(createNodeSqliteDriver(), directory, CACHE_KEY);
    const server = options.server ?? notesServer();
    const gone: string[] = [];
    const values: string[] = [];
    const errors: unknown[] = [];
    const store = createBoundedStore<Note>({
        definition: NOTES,
        db,
        fetch: server.fetch,
        onGone: (key) => gone.push(key),
        onValue: (key) => values.push(key),
        onError: (error) => errors.push(error),
        now: () => (clock += 1),
        ...options,
    });
    const s = { directory, db, server, store, gone, values, errors };
    setups.push(s);
    return s;
}

/** Closes a setup's store and file, keeping the directory: a relaunch opens it again. */
async function relaunch(s: Setup, options: Partial<BoundedStoreOptions<Note>> = {}) {
    await s.store.close();
    await s.db.close();
    setups.splice(setups.indexOf(s), 1);
    return setup({ directory: s.directory, server: s.server, ...options });
}

async function keysOnDisk(db: SqlConnection) {
    const rows = await db.all<{ key: string }>("SELECT key FROM rows WHERE collection = 'note' ORDER BY key");
    return rows.map((row) => row.key);
}

describe('a bounded kind', () => {
    it('reads an item as a screen uses it, keeps it on disk with its age, and shows that copy offline', async () => {
        const s = await setup();
        s.server.set('a', 'first');
        const item = s.store.item('a');
        const release = item.use();
        await item.refresh();
        expect(item.state).toMatchObject({ value: { text: 'first' }, settled: true, failed: false, gone: false });
        const fetchedAt = item.state.fetchedAt;
        expect(fetchedAt).not.toBeNull();
        release();
        await s.store.flush();
        expect(await keysOnDisk(s.db)).toEqual(['a']);
        expect(await s.store.stored('a')).toBe(true);

        // Offline: the preload shows disk's copy, with when it was fetched, and asks nothing.
        const offline = await relaunch(s);
        offline.server.refuse('a', 503);
        const before = offline.server.requests.length;
        const again = await offline.store.preload('a');
        expect(again.state).toMatchObject({ value: { text: 'first' }, fetchedAt, loaded: true });
        expect(offline.server.requests.length).toBe(before);
        const outcome = await again.refresh();
        expect(outcome.outcome).toBe('failed');
        expect(again.state).toMatchObject({ value: { text: 'first' }, failed: true });
    });

    it('drops a 404 or 410 from memory and disk and tells onGone', async () => {
        for (const status of [404, 410]) {
            const s = await setup();
            s.server.set('a', 'here');
            const item = s.store.item('a');
            await item.refresh();
            await s.store.flush();
            s.server.refuse('a', status);
            expect(await item.refresh()).toEqual({ outcome: 'gone', status });
            await s.store.flush();
            expect(item.state).toMatchObject({ value: null, gone: true });
            expect(s.gone).toEqual(['a']);
            expect(await keysOnDisk(s.db)).toEqual([]);
        }
    });

    it('never reads the network for a local key', async () => {
        const s = await setup({ isLocal: (key) => key.startsWith('pending-') });
        const item = s.store.item('pending-1');
        const release = item.use();
        expect(await item.refresh()).toEqual({ outcome: 'local' });
        await item.loaded;
        expect(item.state.settled).toBe(true);
        release();
        expect(s.server.requests).toEqual([]);
    });

    it('keeps at most BOUNDED_MEMORY items in memory, never one a screen uses', async () => {
        const s = await setup();
        const shown = s.store.item('shown');
        const release = shown.use();
        for (let index = 0; index < BOUNDED_MEMORY + 3; index += 1) {
            s.store.item(`k${index}`);
        }
        const held = s.store.held();
        expect(held).toHaveLength(BOUNDED_MEMORY);
        expect(held).toContain('shown');
        expect(held.at(-1)).toBe(`k${BOUNDED_MEMORY + 2}`);
        release();
    });

    it('keeps a preloaded item in memory until its first use, or the hand-off', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const s = await setup();
        await s.store.preload('kept');
        for (let index = 0; index < BOUNDED_MEMORY + 2; index += 1) {
            s.store.item(`k${index}`);
        }
        expect(s.store.held()).toContain('kept');
        await vi.advanceTimersByTimeAsync(BOUNDED_HANDOFF_MS);
        // No longer kept: the least recently used, it leaves with the next item.
        s.store.item('one-more');
        expect(s.store.held()).not.toContain('kept');
    });

    it('evicts the least recently used past the disk bounds, skipping shown and pinned items', async () => {
        const pinned = new Set(['p']);
        const s = await setup({ pinned: () => pinned });
        for (const key of ['p', 'shown', 'a', 'b', 'c']) {
            s.server.set(key, key);
        }
        await s.store.item('p').refresh();
        const shown = s.store.item('shown');
        const release = shown.use();
        await shown.refresh();
        await s.store.item('a').refresh();
        await s.store.item('b').refresh();
        await s.store.flush();
        // Four kept, bound 3: `p` and `shown` are oldest but protected, so `a` goes.
        expect(await keysOnDisk(s.db)).toEqual(['b', 'p', 'shown']);
        release();
        pinned.clear();
        await s.store.item('c').refresh();
        await s.store.flush();
        expect(await keysOnDisk(s.db)).toEqual(['b', 'c', 'shown']);
    });

    it('never keeps an item over the size bound, and deletes its older copy', async () => {
        const s = await setup({ definition: { ...NOTES, itemMaxChars: 100 } });
        s.server.set('a', 'small');
        const item = s.store.item('a');
        await item.refresh();
        await s.store.flush();
        expect(await keysOnDisk(s.db)).toEqual(['a']);
        s.server.set('a', 'x'.repeat(200), 2);
        await item.refresh();
        await s.store.flush();
        expect(item.state.value?.text).toHaveLength(200);
        expect(await keysOnDisk(s.db)).toEqual([]);
    });

    it('never writes a memory-only item, and deletes a copy kept before', async () => {
        const s = await setup();
        s.server.set('mine', 'mine');
        s.server.set('theirs', 'secret');
        await s.store.item('theirs').refresh();
        await s.store.flush();
        expect(await keysOnDisk(s.db)).toEqual(['theirs']);

        const later = await relaunch(s, { memoryOnly: (key) => key === 'theirs' });
        const theirs = await later.store.preload('theirs');
        await later.store.flush();
        expect(theirs.state.value).toBeNull();
        expect(await keysOnDisk(later.db)).toEqual([]);
        await theirs.refresh();
        await later.store.item('mine').refresh();
        await later.store.flush();
        expect(theirs.state.value?.text).toBe('secret');
        expect(await keysOnDisk(later.db)).toEqual(['mine']);
        const raw = await later.db.all<{ json: string }>('SELECT json FROM rows');
        expect(raw.some((row) => row.json.includes('secret'))).toBe(false);
    });

    it('drops an answer to a read that began before a value was put', async () => {
        const s = await setup();
        s.server.set('a', 'old', 1);
        const item = s.store.item('a');
        s.server.hold();
        const reading = item.refresh();
        await vi.waitFor(() => expect(s.server.requests).toHaveLength(1));
        await s.store.put('a', { id: 'a', text: 'from the write', rev: 2 });
        s.server.release();
        expect(await reading).toEqual({ outcome: 'superseded' });
        expect(item.state.value?.text).toBe('from the write');
        await s.store.flush();
        const relaunched = await relaunch(s);
        expect((await relaunched.store.preload('a')).state.value?.text).toBe('from the write');
    });

    it('makes calls while a read runs one more read after it', async () => {
        const s = await setup();
        s.server.set('a', 'one');
        const item = s.store.item('a');
        s.server.hold();
        const first = item.refresh();
        await vi.waitFor(() => expect(s.server.requests).toHaveLength(1));
        const second = item.refresh();
        void item.refresh();
        s.server.set('a', 'two', 2);
        s.server.release();
        await Promise.all([first, second]);
        expect(s.server.requests).toHaveLength(2);
        expect(item.state.value?.text).toBe('two');
    });

    it('reads again only what the phone holds (refreshKnown)', async () => {
        const s = await setup();
        s.server.set('a', 'a');
        expect(await s.store.refreshKnown('a')).toBeNull();
        expect(s.server.requests).toEqual([]);
        await s.store.put('a', { id: 'a', text: 'put', rev: 1 });
        // On disk only: it comes into memory and is read.
        expect(await s.store.refreshKnown('a')).toEqual({ outcome: 'fresh' });
        expect(s.store.peek('a')?.state.value?.text).toBe('a');
    });

    it('reads every item refreshKnown is asked for at once, past the memory bound, and drops each gone one', async () => {
        const count = BOUNDED_MEMORY + 2;
        const keys = Array.from({ length: count }, (_, index) => `k${index}`);
        const s = await setup({ definition: { ...NOTES, bounds: { items: 100, chars: 1_000_000 } } });
        for (const key of keys) {
            await s.store.put(key, { id: key, text: key, rev: 1 });
        }
        expect(await keysOnDisk(s.db)).toHaveLength(count);
        // Every one left its list together, and the server refuses them all.
        const outcomes = await Promise.all(keys.map((key) => s.store.refreshKnown(key)));
        expect(outcomes).toEqual(keys.map(() => ({ outcome: 'gone', status: 404 })));
        expect(s.server.requests).toHaveLength(count);
        expect([...s.gone].sort()).toEqual([...keys].sort());
        await s.store.flush();
        expect(await keysOnDisk(s.db)).toEqual([]);
        // Once read, they are held no longer.
        expect(s.store.held().length).toBeLessThanOrEqual(BOUNDED_MEMORY);
    });

    it('still drops an item and tells onGone when its 404 comes after it left memory', async () => {
        const s = await setup();
        s.server.set('a', 'here');
        const item = s.store.item('a');
        await item.refresh();
        await s.store.flush();
        s.server.refuse('a', 404);
        s.server.hold();
        const reading = item.refresh();
        await vi.waitFor(() => expect(s.server.requests).toHaveLength(2));
        for (let index = 0; index < BOUNDED_MEMORY + 1; index += 1) {
            s.store.item(`k${index}`);
        }
        expect(s.store.held()).not.toContain('a');
        s.server.release();
        expect(await reading).toEqual({ outcome: 'gone', status: 404 });
        expect(s.gone).toEqual(['a']);
        await s.store.flush();
        expect(await keysOnDisk(s.db)).toEqual([]);
    });

    it('drops copies of another format when it opens, and keeps other kinds’', async () => {
        const s = await setup();
        s.server.set('a', 'a');
        await s.store.item('a').refresh();
        await s.store.flush();
        await s.db.run("INSERT INTO scopes (scope, lastUsed, bytes) VALUES ('chat:1:t', 1, 1)");
        const later = await relaunch(s, { definition: { ...NOTES, format: 2 } });
        await later.store.flush();
        expect(await keysOnDisk(later.db)).toEqual([]);
        const scopes = await later.db.all<{ scope: string }>('SELECT scope FROM scopes');
        expect(scopes.map((row) => row.scope)).toEqual(['chat:1:t']);
    });

    it('tells a body that isn’t the item to onError, and refuses a name it can’t keep apart', async () => {
        const s = await setup();
        const item = s.store.item('a');
        s.server.set('a', 5 as unknown as string);
        await item.refresh();
        expect(s.errors.some((error) => error instanceof SnapshotShapeError)).toBe(true);
        const db = s.db;
        expect(() =>
            createBoundedStore({ definition: { ...NOTES, name: 'chat' }, db, fetch: s.server.fetch }),
        ).toThrow();
        expect(() =>
            createBoundedStore({ definition: { ...NOTES, name: 'a_b' }, db, fetch: s.server.fetch }),
        ).toThrow();
    });
});
