import { type Collection, createLiveQueryCollection, createLiveQueryObserver, eq } from '@tanstack/db';
import { afterEach, describe, expect, it } from 'vitest';

import { openUserDb } from '../../src/data';
import { cleanupScopeCollections, createScopeCollections, type ScopeCollections } from '../../src/sync/collections';
import { readPending } from '../../src/sync/pending';
import { CONVERSATIONS, STATE_KEY, WORKSPACE_KEY } from '../../src/sync/shell';

import { conversation, syncSetup } from './helpers';

// A scope's TanStack DB collections, over
// the snapshot cache and a real cache.db: filled before they're returned,
// following every change the cache applies (a pull's, a confirmation's), rows
// that didn't change keep their identity, and `pending` comes from user.db.

type Setup = Awaited<ReturnType<typeof syncSetup>>;
const open: Setup[] = [];
const made: ScopeCollections[] = [];
async function setup(options?: Parameters<typeof syncSetup>[0]) {
    const s = await syncSetup(options);
    open.push(s);
    return s;
}
function collections(s: Setup, scopeId = 'scope-a', pending: Parameters<typeof createScopeCollections>[2] = []) {
    const result = createScopeCollections(scopeId, s.cache, pending);
    made.push(result);
    return result;
}
afterEach(async () => {
    for (const c of made.splice(0)) {
        await cleanupScopeCollections(c).catch(() => {});
    }
    for (const s of open.splice(0)) {
        await s.close().catch(() => {});
    }
});

const ids = (rows: Iterable<{ id: string }>) => [...rows].map((row) => row.id).sort();

describe('the scope’s collections', () => {
    it('hold the cache’s rows, ready, as they’re returned, under ids that carry the scope’s', async () => {
        const first = await setup();
        await first.state.pull('', null);
        await first.workspace.pull('', null);
        await first.close({ remove: false });
        // A relaunch: cache.db has the rows, and nothing has been asked of the server yet.
        const s = await setup({ directory: first.directory });
        const c = collections(s, 'ws1.7');
        expect(s.fetch.calls).toEqual([]);
        for (const collection of Object.values(c)) {
            expect(collection.status).toBe('ready');
        }
        expect(ids(c.conversations.toArray)).toEqual(['c0', 'c1', 'c2']);
        expect(ids(c.spaces.toArray)).toEqual(['everyday']);
        expect(ids(c.dots.toArray)).toEqual(['sebas']);
        expect(ids(c.shell.toArray)).toEqual([STATE_KEY, WORKSPACE_KEY]);
        expect(c.shell.get(WORKSPACE_KEY)?.value).toMatchObject({ user: { id: 'u-ada' } });
        expect(c.shell.get(STATE_KEY)?.value).toMatchObject({ settings: { name: 'Acme' }, version: '0.54.0' });
        expect(c.notices.size).toBe(0);
        expect(c.pending.size).toBe(0);
        expect(Object.values(c).map((collection) => collection.id)).toEqual([
            'ws1.7/shell',
            'ws1.7/conversations',
            'ws1.7/spaces',
            'ws1.7/dots',
            'ws1.7/notices',
            'ws1.7/issues',
            'ws1.7/issue-users',
            'ws1.7/issue-components',
            'ws1.7/approvals',
            'ws1.7/room-invites',
            'ws1.7/memories',
            'ws1.7/memory-profile',
            'ws1.7/schedules',
            'ws1.7/goals',
            'ws1.7/jobs',
            'ws1.7/schedule-limits',
            'ws1.7/runs',
            'ws1.7/skills',
            'ws1.7/pending',
        ]);
    });

    it('follow each pull: a row set, a row removed, the rest left as they were, the same objects', async () => {
        const s = await setup();
        const c = collections(s);
        expect(c.conversations.size).toBe(0);
        await s.workspace.pull('', s.workspace.cursor());
        expect(ids(c.conversations.toArray)).toEqual(['c0', 'c1', 'c2']);
        const kickoff = c.conversations.get('c1');
        const space = c.spaces.get('everyday');
        s.server.change('workspace', (data) => {
            data.conversations = [conversation('c1', 'Kickoff', 3), conversation('c3', 'Launch', 4)];
        });
        const result = await s.workspace.pull('', s.workspace.cursor());
        expect(result.outcome).toBe('changed');
        expect(ids(c.conversations.toArray)).toEqual(['c0', 'c1', 'c3']);
        expect(c.conversations.get('c3')?.title).toBe('Launch');
        // Unchanged rows aren't written again, so a list re-renders only what changed.
        expect(c.conversations.get('c1')).toBe(kickoff);
        expect(c.spaces.get('everyday')).toBe(space);
        s.server.change('workspace', (data) => {
            data.conversations = [conversation('c1', 'Kickoff, renamed', 3)];
        });
        await s.workspace.pull('', s.workspace.cursor());
        expect(c.conversations.get('c1')?.title).toBe('Kickoff, renamed');
        expect(c.conversations.get('c1')).not.toBe(kickoff);
    });

    it('feed live queries, and take this device’s confirmed writes', async () => {
        const s = await setup();
        const c = collections(s);
        await s.workspace.pull('', s.workspace.cursor());
        const live = createLiveQueryCollection({
            query: (q) =>
                q
                    .from({ chat: c.conversations })
                    .where(({ chat }) => eq(chat.dotId, 'sebas'))
                    .orderBy(({ chat }) => chat.createdAt, 'desc'),
            startSync: true,
        });
        await live.preload();
        expect(live.toArray.map((chat) => chat.id)).toEqual(['c1', 'c2', 'c0']);
        await s.cache.confirm({
            collection: CONVERSATIONS,
            scope: '',
            key: 'c9',
            value: conversation('c9', 'Written here', 9),
        });
        expect(c.conversations.get('c9')?.title).toBe('Written here');
        expect(live.toArray.map((chat) => chat.id)).toEqual(['c9', 'c1', 'c2', 'c0']);
        await s.cache.confirm({ collection: CONVERSATIONS, scope: '', key: 'c2', deleted: true });
        expect(live.toArray.map((chat) => chat.id)).toEqual(['c9', 'c1', 'c0']);
    });

    it('load pending from user.db’s outbox, oldest first, payloads undecoded', async () => {
        const s = await setup();
        const user = await openUserDb(s.driver, s.directory, 'ab'.repeat(32));
        const insert =
            'INSERT INTO outbox (id, lane, kind, payload, payloadVersion, idempotencyKey, state, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
        await user.db.run(insert, ['o2', 'chat:c1', 'message', '{"text":"later"}', 1, 'k2', 'queued', 20]);
        await user.db.run(insert, ['o1', 'chat:c1', 'message', '{"text":"first"}', 7, 'k1', 'held', 10]);
        const pending = await readPending(user.db, user.state);
        await user.db.close();
        expect(pending.map((write) => write.id)).toEqual(['o1', 'o2']);
        expect(pending[0]).toEqual({
            id: 'o1',
            lane: 'chat:c1',
            kind: 'message',
            payload: '{"text":"first"}',
            payloadVersion: 7,
            dependsOn: null,
            state: 'held',
            attempts: 0,
            createdAt: 10,
            lastError: null,
        });
        const c = collections(s, 'scope-p', pending);
        expect(c.pending.toArray.map((write) => write.id).sort()).toEqual(['o1', 'o2']);
        // A file whose first migration failed has no outbox, and so nothing pending.
        expect(
            await readPending(user.db, { writable: false, reason: 'migration-failed', version: 0, error: null }),
        ).toEqual([]);
    });

    it('end with their live queries on cleanup, and hear no more of the cache', async () => {
        const s = await setup();
        const c = collections(s);
        await s.workspace.pull('', s.workspace.cursor());
        const live = createLiveQueryCollection({ query: (q) => q.from({ chat: c.conversations }), startSync: true });
        await live.preload();
        await cleanupScopeCollections(c);
        for (const collection of Object.values(c)) {
            expect(collection.status).toBe('cleaned-up');
            expect(collection.size).toBe(0);
        }
        expect(live.status).toBe('cleaned-up');
        s.server.change('workspace', (data) => {
            data.conversations = [conversation('c5', 'After', 5)];
        });
        await s.workspace.pull('', s.workspace.cursor());
        expect(c.conversations.size).toBe(0);
    });

    it('stay empty once cleaned up, whatever subscribes to them after, and hear no more of the cache', async () => {
        const s = await setup();
        const pending = [
            {
                id: 'o1',
                lane: 'chat:c1',
                kind: 'message',
                payload: '{"text":"first"}',
                payloadVersion: 1,
                dependsOn: null,
                state: 'queued' as const,
                attempts: 0,
                createdAt: 10,
                lastError: null,
            },
        ];
        const c = collections(s, 'scope-gone', pending);
        await s.workspace.pull('', s.workspace.cursor());
        await s.state.pull('', s.state.cursor());
        const observer = createLiveQueryObserver(
            createLiveQueryCollection({ query: (q) => q.from({ chat: c.conversations }), startSync: true }),
            { mode: 'wholesale' },
        );
        const unsubscribe = observer.subscribe(() => {});
        expect(observer.getSnapshot().data).toHaveLength(3);
        await cleanupScopeCollections(c);

        // A screen still under the old provider mounts its queries after the scope closed…
        const lives = Object.entries(c).map(([name, collection]: [string, Collection<object, string>]) => {
            const live = createLiveQueryCollection({ query: (q) => q.from({ row: collection }), startSync: true });
            const subscription = live.subscribeChanges(() => {}, { includeInitialState: true });
            return { name, live, subscription };
        });
        // …and a mounted one subscribes again (an effect run twice).
        unsubscribe();
        const again = observer.subscribe(() => {});
        await new Promise((resolve) => setImmediate(resolve));
        for (const { name, live } of lives) {
            expect([name, live.size]).toEqual([name, 0]);
        }
        for (const [name, collection] of Object.entries(c)) {
            expect([name, collection.size]).toEqual([name, 0]);
        }
        expect(observer.getSnapshot().data ?? []).toHaveLength(0);
        // The collections started again hear nothing of the cache, which is still open here.
        s.server.change('workspace', (data) => {
            data.conversations = [conversation('c5', 'After', 5)];
        });
        await s.workspace.pull('', s.workspace.cursor());
        expect(s.cache.rows(CONVERSATIONS).has('c5')).toBe(true);
        expect(c.conversations.size).toBe(0);
        for (const { live } of lives) {
            expect(live.size).toBe(0);
        }
        again();
        for (const { subscription } of lives) {
            subscription.unsubscribe();
        }
    });

    it('of two scopes never share a row', async () => {
        const a = await setup();
        const b = await setup();
        b.server.change('workspace', (data) => {
            data.conversations = [conversation('b1', 'B: kickoff', 1)];
            data.archived = [];
        });
        const ca = collections(a, 'scope-a');
        const cb = collections(b, 'scope-b');
        await a.workspace.pull('', null);
        await b.workspace.pull('', null);
        expect(ids(ca.conversations.toArray)).toEqual(['c0', 'c1', 'c2']);
        expect(ids(cb.conversations.toArray)).toEqual(['b1']);
        expect(ca.conversations.id).not.toBe(cb.conversations.id);
    });
});
