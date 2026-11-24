import { afterEach, describe, expect, it } from 'vitest';

import { compareVersions, type Confirmation, mergeSnapshot, type SnapshotItem } from '../../src/sync/merge';
import type { CachedRow, RowVersion } from '../../src/sync/rows';
import { CONVERSATIONS, SHELL, STATE_KEY, WORKSPACE_KEY } from '../../src/sync/shell';
import { settle } from '../net/helpers';

import { conversation, metaOnDisk, rowsOnDisk, syncSetup } from './helpers';

// The merge rules, ported from the web's mergePageSnapshot
// (packages/client/src/modules/pages/page-snapshots.ts) and applied to every
// kind: a pull that was in flight can't
// undo a write the server has just confirmed.

const item = (key: string, value: unknown, version: RowVersion = null): SnapshotItem => ({
    key,
    json: JSON.stringify(value),
    version,
    value,
});
const row = (key: string, value: unknown, version: RowVersion = null): CachedRow => ({
    key,
    json: JSON.stringify(value),
    version,
});
const known = (...rows: CachedRow[]) => new Map(rows.map((r) => [r.key, r]));
const upserted = (merged: { upserts: readonly SnapshotItem[] }) => merged.upserts.map((u) => u.key);
type Setup = Awaited<ReturnType<typeof syncSetup>>;
const value = (s: Setup, collection: string, key: string) =>
    JSON.parse(s.cache.rows(collection).get(key)?.json ?? 'null') as Record<string, unknown> | null;
const title = (s: Setup, key: string) => value(s, CONVERSATIONS, key)?.title;

describe('mergeSnapshot', () => {
    it('replaces the scope: sets what is new or changed, removes what is gone, leaves the same alone', () => {
        const merged = mergeSnapshot(
            known(row('a', { t: 1 }), row('b', { t: 1 }), row('c', { t: 1 })),
            [item('a', { t: 1 }), item('b', { t: 2 }), item('d', { t: 1 })],
            { startedAt: 1 },
        );
        expect(upserted(merged)).toEqual(['b', 'd']);
        expect(merged.removes).toEqual(['c']);
    });

    it('removes only within the rows it is given: another scope’s keys are never its to remove', () => {
        // One Space's older snapshot lacks a page that moved to another Space: it isn't in this scope's rows.
        const spaceA = known(row('p1', { space: 'a' }));
        const merged = mergeSnapshot(spaceA, [item('p1', { space: 'a' })], { startedAt: 1 });
        expect(merged).toEqual({ upserts: [], removes: [], withheld: [] });
    });

    it('sets an item only when its incoming version is at least the stored one', () => {
        const merged = mergeSnapshot(
            known(row('older', { r: 5 }, 5), row('same', { r: 5, cover: 'x' }, 5), row('newer', { r: 5 }, 5)),
            [item('older', { r: 4 }, 4), item('same', { r: 5, cover: 'y' }, 5), item('newer', { r: 6 }, 6)],
            { startedAt: 1 },
        );
        expect(upserted(merged)).toEqual(['same', 'newer']);
        expect(compareVersions('2026-11-02', '2026-11-01')).toBeGreaterThan(0);
        expect(compareVersions(3, '3')).toBeUndefined();
        expect(compareVersions(null, 1)).toBeUndefined();
    });

    it('holds this device’s confirmed writes against a pull that started before them', () => {
        const confirmed = new Map<string, Confirmation>([
            ['created', { at: 4, deleted: false }],
            ['renamed', { at: 4, deleted: false }],
            ['deleted', { at: 4, deleted: true }],
        ]);
        const local = known(row('created', { t: 'new' }), row('renamed', { t: 'Renamed' }));
        const older = [item('renamed', { t: 'Old name' }), item('deleted', { t: 'Gone' })];
        // Started at 4, before (or as) the confirmations came: they hold, and say where they kept the device's copy.
        expect(mergeSnapshot(local, older, { startedAt: 4, confirmed })).toEqual({
            upserts: [],
            removes: [],
            withheld: ['renamed', 'deleted', 'created'],
        });
        // Started at 5, after them: the truth again.
        const later = mergeSnapshot(local, older, { startedAt: 5, confirmed });
        expect(upserted(later)).toEqual(['renamed', 'deleted']);
        expect(later.removes).toEqual(['created']);
        expect(later.withheld).toEqual([]);
    });

    it('withholds nothing where the snapshot agrees with a held write', () => {
        const confirmed = new Map<string, Confirmation>([
            ['renamed', { at: 4, deleted: false }],
            ['deleted', { at: 4, deleted: true }],
        ]);
        const local = known(row('renamed', { t: 'Renamed' }));
        expect(mergeSnapshot(local, [item('renamed', { t: 'Renamed' })], { startedAt: 4, confirmed })).toEqual({
            upserts: [],
            removes: [],
            withheld: [],
        });
    });

    it('takes a newer version over a held write: someone changed it again after', () => {
        const confirmed = new Map<string, Confirmation>([['page', { at: 4, deleted: false }]]);
        const local = known(row('page', { r: 5 }, 5));
        expect(upserted(mergeSnapshot(local, [item('page', { r: 6 }, 6)], { startedAt: 3, confirmed }))).toEqual([
            'page',
        ]);
        const same = mergeSnapshot(local, [item('page', { r: 5, x: 1 }, 5)], { startedAt: 3, confirmed });
        expect(upserted(same)).toEqual([]);
        expect(same.withheld).toEqual(['page']);
    });

    it('keeps what the snapshot lacks when the kind is retained', () => {
        const merged = mergeSnapshot(known(row('n1', {})), [item('n2', {})], { startedAt: 1, retain: true });
        expect(upserted(merged)).toEqual(['n2']);
        expect(merged.removes).toEqual([]);
    });
});

describe('a pull that started before a confirmation', () => {
    const open: Array<Awaited<ReturnType<typeof syncSetup>>> = [];
    afterEach(async () => {
        for (const s of open.splice(0)) {
            await s.close().catch(() => {});
        }
    });

    it('doesn’t undo a later local write with its older snapshot; the next pull agrees', async () => {
        const s = await syncSetup({ hold: true });
        open.push(s);
        const first = s.workspace.pull('', null);
        s.release();
        await first;

        // A pull goes out; the server answers from before the writes below, and the answer is slow.
        const inFlight = s.workspace.pull('', null);
        await new Promise((done) => setTimeout(done, 0));
        expect(s.heldAnswers).toBe(1);

        // Meanwhile this device renamed c1, created c3 and deleted c2, and the server confirmed each.
        s.server.change('workspace', (data) => {
            data.conversations = [conversation('c3', 'New chat', 4), conversation('c1', 'Renamed', 3)];
        });
        await s.cache.confirm({
            collection: CONVERSATIONS,
            scope: '',
            key: 'c1',
            value: conversation('c1', 'Renamed', 3),
        });
        await s.cache.confirm({
            collection: CONVERSATIONS,
            scope: '',
            key: 'c3',
            value: conversation('c3', 'New chat', 4),
        });
        await s.cache.confirm({ collection: CONVERSATIONS, scope: '', key: 'c2', deleted: true });
        // The hand-off writes at once, outside the cadence.
        expect(await rowsOnDisk(s.db, CONVERSATIONS)).toEqual({
            c0: expect.anything(),
            c1: conversation('c1', 'Renamed', 3),
            c3: conversation('c3', 'New chat', 4),
        });

        s.release();
        const stale = await inFlight;
        expect(stale.outcome).toBe('unchanged');
        const titles = () =>
            Object.fromEntries(
                [...s.cache.rows(CONVERSATIONS)].map(([key, r]) => [
                    key,
                    (JSON.parse(r.json) as { title: string }).title,
                ]),
            );
        expect(titles()).toEqual({ c0: 'Old', c1: 'Renamed', c3: 'New chat' });

        // A pull that started after the confirmations is the truth again, and agrees.
        const next = s.workspace.pull('', s.workspace.cursor());
        s.release();
        expect((await next).outcome).toBe('unchanged');
        expect(titles()).toEqual({ c0: 'Old', c1: 'Renamed', c3: 'New chat' });

        // And then it removes c3 when someone else deletes it: no confirmation holds it any more.
        s.server.change('workspace', (data) => {
            data.conversations = [conversation('c1', 'Renamed', 3)];
        });
        const after = s.workspace.pull('', s.workspace.cursor());
        s.release();
        expect((await after).removes).toEqual([{ collection: CONVERSATIONS, scope: '', key: 'c3' }]);
    });

    it('drops an answer to a pull that a later one overtook', async () => {
        const s = await syncSetup({ hold: true });
        open.push(s);
        const older = s.workspace.pull('', null);
        await new Promise((done) => setTimeout(done, 0));
        s.server.change('workspace', (data) => {
            data.conversations = [];
        });
        const newer = s.workspace.pull('', null);
        await new Promise((done) => setTimeout(done, 0));
        // The newer answer lands first; the older one, with c1 and c2 still in it, after.
        s.release(1);
        expect((await newer).outcome).toBe('changed');
        s.release(0);
        expect(await older).toEqual({
            outcome: 'superseded',
            upserts: [],
            removes: [],
            cursor: s.workspace.cursor(),
        });
        expect([...s.cache.rows(CONVERSATIONS).keys()]).toEqual(['c0']);
    });

    it('doesn’t keep the ETag of an answer it held a row against, so the rerun takes the server’s copy', async () => {
        const s = await syncSetup({ hold: true });
        open.push(s);
        const first = s.workspace.pull('', null);
        s.release();
        await first;

        // The server commits this device's rename of c1, then someone else renames it again.
        s.server.change('workspace', (data) => {
            data.conversations = [conversation('c1', 'Mine', 3), conversation('c2', 'Roadmap', 2)];
        });
        s.server.change('workspace', (data) => {
            data.conversations = [conversation('c1', 'Theirs', 3), conversation('c2', 'Roadmap', 2)];
        });
        // A pull goes out and the server answers with "Theirs", slowly; the confirmation of "Mine" lands first.
        const inFlight = s.workspace.pull('', s.workspace.cursor());
        await settle();
        await s.cache.confirm({
            collection: CONVERSATIONS,
            scope: '',
            key: 'c1',
            value: conversation('c1', 'Mine', 3),
        });
        s.release();
        const held = await inFlight;
        expect(held.outcome).toBe('unchanged');
        expect(title(s, 'c1')).toBe('Mine');
        // Its tag names a body the device doesn't hold, so it isn't kept, in memory or on disk.
        expect(held.cursor).toBeNull();
        expect(s.workspace.cursor()).toBeNull();
        await s.cache.flush();
        expect((await metaOnDisk(s.db, 'workspace'))?.etag).toBeNull();

        // The rerun started after the confirmation: a full pull, and the server's copy.
        const rerun = s.workspace.pull('', s.workspace.cursor());
        s.release();
        expect((await rerun).outcome).toBe('changed');
        expect(s.server.requests.at(-1)).toMatchObject({ ifNoneMatch: undefined, status: 200 });
        expect(title(s, 'c1')).toBe('Theirs');
        expect(s.workspace.cursor()).not.toBeNull();
    });

    it('nor of one it kept a created row against, which the server no longer has', async () => {
        const s = await syncSetup({ hold: true });
        open.push(s);
        const first = s.workspace.pull('', null);
        s.release();
        await first;

        // The server commits this device's new chat c3, then someone else deletes it.
        s.server.change('workspace', (data) => {
            data.conversations = [conversation('c3', 'New chat', 4), ...data.conversations];
        });
        s.server.change('workspace', (data) => {
            data.conversations = data.conversations.filter((chat) => chat.id !== 'c3');
        });
        // The full poll goes out; its answer, without c3, is slow.
        const inFlight = s.workspace.pull('', null);
        await settle();
        await s.cache.confirm({
            collection: CONVERSATIONS,
            scope: '',
            key: 'c3',
            value: conversation('c3', 'New chat', 4),
        });
        s.release();
        const held = await inFlight;
        expect(held.removes).toEqual([]);
        expect(held.cursor).toBeNull();

        const rerun = s.workspace.pull('', s.workspace.cursor());
        s.release();
        expect((await rerun).removes).toEqual([{ collection: CONVERSATIONS, scope: '', key: 'c3' }]);
        expect(s.server.requests.at(-1)?.status).toBe(200);
    });

    it('keeps a held shell row of one source while the other source’s pulls land', async () => {
        const s = await syncSetup({ hold: true });
        open.push(s);
        for (const source of [s.workspace, s.state]) {
            const pulled = source.pull('', null);
            s.release();
            await pulled;
        }

        // A workspace full poll goes out; its answer is from before the write below, and slow.
        const inFlight = s.workspace.pull('', null);
        await settle();
        const confirmed = { ...value(s, SHELL, WORKSPACE_KEY), preferences: { theme: 'dark' } };
        await s.cache.confirm({ collection: SHELL, scope: '', key: WORKSPACE_KEY, value: confirmed });
        // /api/state changes, and a state poll that started after the confirmation lands first.
        s.server.change('state', (data) => {
            data.settings = { ...data.settings, name: 'Acme 2' };
        });
        const statePoll = s.state.pull('', s.state.cursor());
        await settle();
        s.release(1);
        expect((await statePoll).outcome).toBe('changed');
        // The old workspace answer then finds the workspace row still held.
        s.release(0);
        await inFlight;
        expect(value(s, SHELL, WORKSPACE_KEY)).toEqual(confirmed);
        expect(value(s, SHELL, STATE_KEY)?.settings).toMatchObject({ name: 'Acme 2' });
    });

    it('keeps a held shell state row while a workspace pull lands', async () => {
        const s = await syncSetup({ hold: true });
        open.push(s);
        for (const source of [s.workspace, s.state]) {
            const pulled = source.pull('', null);
            s.release();
            await pulled;
        }

        // A state full poll goes out; its answer is from before the write below, and slow.
        const inFlight = s.state.pull('', null);
        await settle();
        const confirmed = { ...value(s, SHELL, STATE_KEY), settings: { name: 'Acme', paused: true } };
        await s.cache.confirm({ collection: SHELL, scope: '', key: STATE_KEY, value: confirmed });
        s.server.change('workspace', (data) => {
            data.spaces = [...data.spaces, { id: 'ops', name: 'Ops', description: '', createdAt: 2 }];
        });
        const workspacePoll = s.workspace.pull('', s.workspace.cursor());
        await settle();
        s.release(1);
        expect((await workspacePoll).outcome).toBe('changed');
        s.release(0);
        await inFlight;
        expect(value(s, SHELL, STATE_KEY)).toEqual(confirmed);
    });
});

describe('a confirmation', () => {
    const open: Array<Awaited<ReturnType<typeof syncSetup>>> = [];
    afterEach(async () => {
        for (const s of open.splice(0)) {
            await s.close().catch(() => {});
        }
    });

    it('drops the ETag of the source its row came from, with the row, and of no other', async () => {
        const s = await syncSetup();
        open.push(s);
        await s.workspace.pull('', null);
        await s.state.pull('', null);
        const workspaceTag = s.workspace.cursor();
        expect(s.state.cursor()).not.toBeNull();

        // A row confirmed as the device holds it already changes nothing the tag names.
        const c2 = value(s, CONVERSATIONS, 'c2');
        await s.cache.confirm({ collection: CONVERSATIONS, scope: '', key: 'c2', value: c2 });
        expect(s.workspace.cursor()).toBe(workspaceTag);

        // The shell's state row is /api/state's alone.
        const paused = { ...value(s, SHELL, STATE_KEY), settings: { name: 'Acme', paused: true } };
        await s.cache.confirm({ collection: SHELL, scope: '', key: STATE_KEY, value: paused });
        expect(s.state.cursor()).toBeNull();
        expect(s.workspace.cursor()).toBe(workspaceTag);
        expect((await metaOnDisk(s.db, 'state'))?.etag).toBeNull();

        // A delete changes what the tag names too.
        await s.cache.confirm({ collection: CONVERSATIONS, scope: '', key: 'c2', deleted: true });
        expect(s.workspace.cursor()).toBeNull();
        expect((await metaOnDisk(s.db, 'workspace'))?.etag).toBeNull();
    });

    it('so a 304 can’t vouch for a body the confirmed row contradicts', async () => {
        const s = await syncSetup();
        open.push(s);
        await s.workspace.pull('', null);
        // The write's answer carries fields the list doesn't show (PATCH answers with the thread, not
        // the list's item), and the list's body stays as it was.
        s.server.change('workspace', () => {});
        const patched = { ...conversation('c1', 'Kickoff', 3), model: 'm-1' };
        await s.cache.confirm({ collection: CONVERSATIONS, scope: '', key: 'c1', value: patched });

        const next = await s.workspace.pull('', s.workspace.cursor());
        expect(s.server.requests.at(-1)).toMatchObject({ path: '/api/workspace', ifNoneMatch: undefined, status: 200 });
        expect(next.outcome).toBe('changed');
        expect(value(s, CONVERSATIONS, 'c1')).toEqual(conversation('c1', 'Kickoff', 3));
    });

    it('drops a 304 to a pull that was in flight, which vouches for the body before it', async () => {
        const s = await syncSetup({ hold: true });
        open.push(s);
        const first = s.workspace.pull('', null);
        s.release();
        await first;

        // The server commits this device's new chat c3, then someone else deletes it: the body is
        // the one the device's tag names again, so the poll in flight gets a 304.
        s.server.change('workspace', (data) => {
            data.conversations = [conversation('c3', 'New chat', 4), ...data.conversations];
        });
        s.server.change('workspace', (data) => {
            data.conversations = data.conversations.filter((chat) => chat.id !== 'c3');
        });
        const inFlight = s.workspace.pull('', s.workspace.cursor());
        await settle();
        await s.cache.confirm({
            collection: CONVERSATIONS,
            scope: '',
            key: 'c3',
            value: conversation('c3', 'New chat', 4),
        });
        s.release();
        expect(s.server.requests.at(-1)?.status).toBe(304);
        expect(await inFlight).toMatchObject({ outcome: 'superseded', cursor: null });

        const rerun = s.workspace.pull('', s.workspace.cursor());
        s.release();
        expect((await rerun).removes).toEqual([{ collection: CONVERSATIONS, scope: '', key: 'c3' }]);
        expect(s.server.requests.at(-1)).toMatchObject({ ifNoneMatch: undefined, status: 200 });
    });
});
