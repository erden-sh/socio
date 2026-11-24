import { afterEach, describe, expect, it } from 'vitest';

import { HttpError, SnapshotShapeError } from '../../src/sync/errors';
import {
    COMPONENTS_KEY,
    ISSUE_COMPONENTS,
    ISSUE_USERS,
    ISSUES,
    ISSUES_SNAPSHOT,
    USERS_KEY,
} from '../../src/sync/issues';
import { openSnapshotCache } from '../../src/sync/snapshot-cache';
import { createSnapshotSource } from '../../src/sync/snapshot-source';

import { issue, metaOnDisk, rowsOnDisk, syncSetup } from './helpers';

// The issues kind against
// the fake server: `GET /api/issues` with its ETag, the summaries by number
// and the users map as one row, a 304, a format change, removed rows, a pull
// in flight against a confirmed write, and a 403 or 404 that keeps the rows.

type Setup = Awaited<ReturnType<typeof syncSetup>>;
const open: Setup[] = [];
afterEach(async () => {
    for (const s of open.splice(0)) {
        await s.close().catch(() => {});
    }
});

async function setup(options?: Parameters<typeof syncSetup>[0]) {
    const s = await syncSetup(options);
    open.push(s);
    const issues = createSnapshotSource({
        definition: ISSUES_SNAPSHOT,
        cache: s.cache,
        fetch: s.authed,
        signal: s.scope.signal,
    });
    return Object.assign(s, { issues });
}

/** Waits until the server holds `count` answers (the request has gone out). */
async function heldReach(s: Setup, count: number) {
    for (let turn = 0; turn < 100 && s.heldAnswers < count; turn += 1) {
        await new Promise((done) => setTimeout(done, 0));
    }
    expect(s.heldAnswers).toBe(count);
}

const titles = (s: Setup) =>
    Object.fromEntries(
        [...s.cache.rows(ISSUES)].map(([key, row]) => [key, (JSON.parse(row.json) as { title: string }).title]),
    );

describe('the issues kind', () => {
    it('loads itself on its first pull, fills the summaries by number and the names as one row, then answers 304', async () => {
        const s = await setup();
        expect(s.cache.loaded(ISSUES_SNAPSHOT)).toBe(false);
        const first = await s.issues.pull('', null);
        expect(s.cache.loaded(ISSUES_SNAPSHOT)).toBe(true);
        expect(first.outcome).toBe('changed');
        expect(titles(s)).toEqual({ '1': 'Login fails', '2': 'Search is slow' });
        expect(s.cache.rows(ISSUES).get('2')?.version).toBe(20);
        expect(JSON.parse(s.cache.rows(ISSUE_USERS).get(USERS_KEY)?.json ?? 'null')).toEqual({ 'u-ada': 'Ada' });
        expect(s.server.requests.at(-1)).toMatchObject({ path: '/api/issues', ifNoneMatch: undefined, status: 200 });

        const again = await s.issues.pull('', s.issues.cursor());
        expect(again.outcome).toBe('not-modified');
        expect(s.server.requests.at(-1)).toMatchObject({ path: '/api/issues', ifNoneMatch: first.cursor, status: 304 });

        await s.cache.flush();
        expect(Object.keys(await rowsOnDisk(s.db, ISSUES))).toEqual(['1', '2']);
        expect((await metaOnDisk(s.db, 'issues'))?.etag).toBe(first.cursor);
    });

    it('removes the rows a 200 no longer lists and sets the changed ones', async () => {
        const s = await setup();
        await s.issues.pull('', null);
        s.server.change('issues', (data) => {
            data.issues = [issue(2, 'Search is fast now', 30), issue(3, 'New one', 25)];
            data.users = {};
        });
        const result = await s.issues.pull('', s.issues.cursor());
        expect(result.removes.map(({ key }) => key)).toEqual(['1']);
        expect(titles(s)).toEqual({ '2': 'Search is fast now', '3': 'New one' });
        expect(JSON.parse(s.cache.rows(ISSUE_USERS).get(USERS_KEY)?.json ?? 'null')).toEqual({});
    });

    it('drops the ETag of rows of another format, so the next pull is full, and keeps the rows meanwhile', async () => {
        const s = await setup();
        await s.issues.pull('', null);
        await s.cache.flush();
        const next = { ...ISSUES_SNAPSHOT, format: ISSUES_SNAPSHOT.format + 1 };
        const later = await openSnapshotCache({ db: s.db, definitions: [next] });
        try {
            expect(later.cursor(next)).toBeNull();
            expect([...later.rows(ISSUES).keys()].sort()).toEqual(['1', '2']);
        } finally {
            await later.close();
        }
    });

    it('doesn’t undo a confirmed change with a pull that started before it', async () => {
        const s = await setup({ hold: true });
        const first = s.issues.pull('', null);
        await heldReach(s, 1);
        s.release();
        await first;

        const inFlight = s.issues.pull('', null);
        await heldReach(s, 1);
        s.server.change('issues', (data) => {
            data.issues = [issue(2, 'Renamed here', 40), issue(1, 'Login fails', 10)];
        });
        await s.cache.confirm({
            collection: ISSUES,
            scope: '',
            key: '2',
            value: issue(2, 'Renamed here', 40),
            version: 40,
        });
        s.release();
        const stale = await inFlight;
        expect(stale.cursor).toBeNull();
        expect(titles(s)).toEqual({ '1': 'Login fails', '2': 'Renamed here' });

        // The rerun is full and agrees.
        const rerun = s.issues.pull('', s.issues.cursor());
        await heldReach(s, 1);
        s.release();
        await rerun;
        expect(titles(s)).toEqual({ '1': 'Login fails', '2': 'Renamed here' });
    });

    it('keeps every row on a 403 or 404, which is an error, never a wipe', async () => {
        const s = await setup();
        await s.issues.pull('', null);
        const tag = s.issues.cursor();
        for (const status of [403, 404]) {
            s.server.refuseIssues(status);
            const failed = await s.issues.pull('', s.issues.cursor()).catch((error: unknown) => error);
            expect(failed).toBeInstanceOf(HttpError);
            expect((failed as HttpError).status).toBe(status);
            expect(titles(s)).toEqual({ '1': 'Login fails', '2': 'Search is slow' });
            expect(s.issues.cursor()).toBe(tag);
        }
        s.server.refuseIssues(null);
        expect((await s.issues.pull('', s.issues.cursor())).outcome).toBe('not-modified');
    });

    it('refuses a body that isn’t the list, applying nothing', () => {
        expect(() => ISSUES_SNAPSHOT.split({ issues: [{ title: 'No number', updatedAt: 1 }], users: {} })).toThrow(
            SnapshotShapeError,
        );
        expect(() => ISSUES_SNAPSHOT.split({ issues: [issue(1, 'x', Number.NaN)], users: {} })).toThrow(
            SnapshotShapeError,
        );
        expect(() => ISSUES_SNAPSHOT.split({ issues: [], users: { a: 1 } })).toThrow(SnapshotShapeError);
        expect(() => ISSUES_SNAPSHOT.split({ users: {} })).toThrow(SnapshotShapeError);
    });
});

describe('the components’ labels (CB-442)', () => {
    const LABELS = {
        'plugin:forms': { label: 'Forms', kind: 'plugin', state: 'live' },
        'app:crm@7': { label: 'CRM', kind: 'app', state: 'deleted', ownerName: 'Ada' },
    };

    it('keeps the list’s label map as one row under the same ETag, so chips read offline', () => {
        const [, , components] = ISSUES_SNAPSHOT.split({ issues: [], users: {}, components: LABELS });
        expect(components).toEqual([expect.objectContaining({ key: COMPONENTS_KEY, value: LABELS })]);
        expect(ISSUES_SNAPSHOT.feeds.map((feed) => feed.collection)).toEqual([ISSUES, ISSUE_USERS, ISSUE_COMPONENTS]);
    });

    it('keeps null for a server from before components, so nothing offers them', () => {
        const [, , components] = ISSUES_SNAPSHOT.split({ issues: [], users: {} });
        expect(components![0]!.value).toBeNull();
    });

    it('refuses a label map that isn’t one, applying nothing', () => {
        expect(() => ISSUES_SNAPSHOT.split({ issues: [], users: {}, components: [] })).toThrow(SnapshotShapeError);
        expect(() =>
            ISSUES_SNAPSHOT.split({
                issues: [],
                users: {},
                components: { 'plugin:x': { label: 'X', kind: 'plugin' } },
            }),
        ).toThrow(SnapshotShapeError);
    });

    it('is format 2, so a copy kept before it is pulled in full and gets the map', () => {
        expect(ISSUES_SNAPSHOT.format).toBe(2);
    });
});

describe('loading a kind after the open', () => {
    it('tells its rows from cache.db once, and keeps memory’s confirmation over the stored row', async () => {
        const s = await setup();
        await s.issues.pull('', null);
        await s.cache.flush();
        const later = await openSnapshotCache({ db: s.db, definitions: [] });
        try {
            const told: string[] = [];
            later.subscribe((change) =>
                told.push(...change.upserts.map(({ collection, key }) => `${collection}/${key}`)),
            );
            await later.confirm({
                collection: ISSUES,
                scope: '',
                key: '1',
                value: issue(1, 'Fixed here', 50),
                version: 50,
            });
            told.length = 0;
            await Promise.all([later.load([ISSUES_SNAPSHOT]), later.load([ISSUES_SNAPSHOT])]);
            expect(told.sort()).toEqual([
                `${ISSUE_COMPONENTS}/${COMPONENTS_KEY}`,
                `${ISSUE_USERS}/${USERS_KEY}`,
                `${ISSUES}/2`,
            ]);
            expect(JSON.parse(later.rows(ISSUES).get('1')?.json ?? 'null')).toMatchObject({ title: 'Fixed here' });
            // The confirmation changed what the stored tag names: the next pull is full.
            expect(later.cursor(ISSUES_SNAPSHOT)).toBeNull();
        } finally {
            await later.close();
        }
    });
});
