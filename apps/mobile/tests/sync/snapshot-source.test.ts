import { afterEach, describe, expect, it } from 'vitest';

import { serverAway } from '../../src/net/reconnect';
import { HttpError, SnapshotShapeError } from '../../src/sync/errors';
import {
    CONVERSATIONS,
    DOTS,
    NOTICES,
    NOTICES_KEPT,
    SHELL,
    SPACES,
    STATE_SNAPSHOT,
    WORKSPACE_SNAPSHOT,
} from '../../src/sync/shell';
import { openSnapshotCache } from '../../src/sync/snapshot-cache';
import { createSnapshotSource } from '../../src/sync/snapshot-source';
import { answer, DAY, fakeFetch, httpDate, ORIGIN, sentHeaders } from '../net/helpers';

import { conversation, HOUR, metaOnDisk, type Notice, rowsOnDisk, syncSetup } from './helpers';

// The shell's snapshot sources against a fake server: conditional GETs of
// exactly /api/state and /api/workspace, the ETag sent back as received, 304s
// never parsed, and each 200 diffed and committed with its meta in one
// transaction.

type Setup = Awaited<ReturnType<typeof syncSetup>>;
const open: Setup[] = [];
async function setup(options?: Parameters<typeof syncSetup>[0]) {
    const s = await syncSetup(options);
    open.push(s);
    return s;
}
afterEach(async () => {
    for (const s of open.splice(0)) {
        await s.close().catch(() => {});
    }
});

const keys = (result: { upserts: readonly { collection: string; key: string }[] }) =>
    result.upserts.map(({ collection, key }) => `${collection}/${key}`).sort();

const notice = (id: string, createdAt: number): Notice => ({
    id,
    title: `Notice ${id}`,
    body: '',
    link: '/',
    createdAt,
});

describe('the shell’s snapshot sources', () => {
    it('asks exactly /api/state and /api/workspace, with no query and no presence header', async () => {
        const s = await setup();
        await s.state.pull('', s.state.cursor());
        await s.workspace.pull('', s.workspace.cursor());
        expect(s.fetch.calls.map((call) => call.url)).toEqual([`${ORIGIN}/api/state`, `${ORIGIN}/api/workspace`]);
        for (const call of s.fetch.calls) {
            expect(Object.keys(sentHeaders(call)).sort()).toEqual(['accept', 'cookie', 'origin', 'user-agent']);
        }
        // A whole kind takes no other scope, and nothing is sent for one.
        await expect(s.state.pull('everyday', null)).rejects.toBeInstanceOf(TypeError);
        expect(s.fetch.calls).toHaveLength(2);
        expect(STATE_SNAPSHOT.path).toBe('/api/state');
        expect(WORKSPACE_SNAPSHOT.path).toBe('/api/workspace');
    });

    it('takes a 200, then a 304 that changes nothing, then a 200 with removes', async () => {
        const s = await setup();
        const first = await s.workspace.pull('', s.workspace.cursor());
        expect(first.outcome).toBe('changed');
        expect(keys(first)).toEqual([
            'conversations/c0',
            'conversations/c1',
            'conversations/c2',
            'dots/sebas',
            'shell/workspace',
            'spaces/everyday',
        ]);
        expect(first.removes).toEqual([]);
        expect(first.cursor).toMatch(/^W\/"[\w-]+\.[\w-]+"$/);

        const second = await s.workspace.pull('', first.cursor);
        expect(second).toEqual({ outcome: 'not-modified', upserts: [], removes: [], cursor: first.cursor });
        expect(s.server.requests[1]).toEqual({ path: '/api/workspace', ifNoneMatch: first.cursor, status: 304 });
        // A version match: the server didn't even build the body.
        expect(s.server.builds).toBe(1);

        s.server.change('workspace', (data) => {
            data.conversations = [conversation('c1', 'Kickoff, renamed', 3)];
            data.spaces = [];
        });
        const third = await s.workspace.pull('', second.cursor);
        expect(third.outcome).toBe('changed');
        expect(keys(third)).toEqual(['conversations/c1']);
        expect(third.removes.map(({ collection, key }) => `${collection}/${key}`).sort()).toEqual([
            'conversations/c2',
            'spaces/everyday',
        ]);
        expect(third.cursor).not.toBe(first.cursor);
        expect([...s.cache.rows(CONVERSATIONS).keys()].sort()).toEqual(['c0', 'c1']);
        expect(s.cache.rows(SPACES).size).toBe(0);

        await s.cache.flush();
        expect(Object.keys(await rowsOnDisk(s.db, CONVERSATIONS))).toEqual(['c0', 'c1']);
        expect(await rowsOnDisk(s.db, SPACES)).toEqual({});
        expect((await metaOnDisk(s.db, 'workspace'))?.etag).toBe(third.cursor);
    });

    it('sends a W/ tag back exactly as received, and keeps a strong one strong', async () => {
        const weak = await setup({ gzip: true });
        const { cursor } = await weak.state.pull('', null);
        expect(cursor).toMatch(/^W\/"/);
        expect(weak.cache.cursor(STATE_SNAPSHOT)).toBe(cursor);
        await weak.state.pull('', cursor);
        expect(sentHeaders(weak.fetch.calls[1])['if-none-match']).toBe(cursor);
        expect(weak.server.requests.map((request) => request.status)).toEqual([200, 304]);

        const strong = await setup({ gzip: false });
        const first = await strong.state.pull('', null);
        expect(first.cursor).toMatch(/^"[\w-]+\.[\w-]+"$/);
        await strong.state.pull('', first.cursor);
        expect(sentHeaders(strong.fetch.calls[1])['if-none-match']).toBe(first.cursor);
    });

    it('never parses a 304: the fake’s 304 throws on any read', async () => {
        const s = await setup();
        const { cursor } = await s.state.pull('', null);
        await expect(s.state.pull('', cursor)).resolves.toMatchObject({ outcome: 'not-modified' });
    });

    it('keeps a 304’s new tag after a restart: the same body, named anew', async () => {
        const s = await setup();
        const { cursor } = await s.state.pull('', null);
        s.server.restart();
        const after = await s.state.pull('', cursor);
        expect(after.outcome).toBe('not-modified');
        // The body hash matched, so the server built it once more and named it with its new version part.
        expect(s.server.builds).toBe(2);
        expect(after.cursor).not.toBe(cursor);
        await s.state.pull('', after.cursor);
        expect(s.server.builds).toBe(2);
        await s.cache.flush();
        expect((await metaOnDisk(s.db, 'state'))?.etag).toBe(after.cursor);
    });

    it('slides the session on a 304’s Set-Cookie, through authedFetch', async () => {
        const s = await setup();
        const { cursor } = await s.state.pull('', null);
        const before = s.jar.sessionExpiresAt();
        s.clock.server += DAY + HOUR;
        const result = await s.state.pull('', cursor);
        expect(result.outcome).toBe('not-modified');
        expect(s.server.requests.at(-1)?.status).toBe(304);
        expect(s.jar.sessionExpiresAt()).toBe(s.clock.server + 7 * DAY);
        expect(s.jar.sessionExpiresAt()).toBeGreaterThan((before ?? 0) + DAY);
    });

    it('commits /api/workspace’s four collections and its ETag together, in one transaction', async () => {
        const s = await setup();
        const { cursor } = await s.workspace.pull('', null);
        const from = s.driver.log.length;
        await s.cache.flush();
        const statements = s.driver.log.slice(from).map((line) => line.replace(/^cache\.db: /, ''));
        expect(statements[0]).toBe('BEGIN IMMEDIATE');
        expect(statements.at(-1)).toBe('COMMIT');
        expect(statements.filter((sql) => sql === 'BEGIN IMMEDIATE')).toHaveLength(1);
        expect(statements.some((sql) => sql.startsWith('INSERT INTO rows'))).toBe(true);
        expect(statements.some((sql) => sql.startsWith('INSERT INTO meta'))).toBe(true);
        for (const collection of [SHELL, CONVERSATIONS, SPACES, DOTS]) {
            expect(Object.keys(await rowsOnDisk(s.db, collection)).length).toBeGreaterThan(0);
        }
        expect(await metaOnDisk(s.db, 'workspace')).toMatchObject({ etag: cursor, schemaVersion: 1 });
        const shell = await rowsOnDisk(s.db, SHELL);
        expect(Object.keys(shell)).toEqual(['workspace']);
        // The lists live in their own collections, not in the shell's row.
        expect(shell.workspace).toEqual({
            user: { id: 'u-ada', name: 'Ada', role: 'admin' },
            setup: { inference: true },
            calls: [],
        });
    });

    it('leaves the file as it was when the write fails: rows and meta roll back together, and go with the next write', async () => {
        const s = await setup();
        await s.workspace.pull('', null);
        await s.cache.flush();
        const before = await rowsOnDisk(s.db, CONVERSATIONS);
        const etag = (await metaOnDisk(s.db, 'workspace'))?.etag;

        s.server.change('workspace', (data) => {
            data.conversations = [];
        });
        const changed = await s.workspace.pull('', s.workspace.cursor());
        // The meta statement fails, after the rows' statements ran.
        const realRun = s.db.transaction.bind(s.db);
        let fail = true;
        s.db.transaction = (task) =>
            realRun((tx) =>
                task({
                    ...tx,
                    run: async (sql, params) => {
                        if (fail && sql.startsWith('INSERT INTO meta')) {
                            throw new Error('disk full');
                        }
                        return tx.run(sql, params);
                    },
                }),
            );
        await expect(s.cache.flush()).rejects.toThrow('disk full');
        expect(await rowsOnDisk(s.db, CONVERSATIONS)).toEqual(before);
        expect((await metaOnDisk(s.db, 'workspace'))?.etag).toBe(etag);

        fail = false;
        await s.cache.flush();
        expect(await rowsOnDisk(s.db, CONVERSATIONS)).toEqual({ c0: expect.anything() });
        expect((await metaOnDisk(s.db, 'workspace'))?.etag).toBe(changed.cursor);
    });

    it('reopens from cache.db with its rows and ETag, so the next pull is a 304', async () => {
        const first = await setup();
        await first.state.pull('', null);
        await first.workspace.pull('', null);
        await first.close({ remove: false });
        open.splice(open.indexOf(first), 1);

        const again = await setup({ directory: first.directory, driver: first.driver });
        expect([...again.cache.rows(CONVERSATIONS).keys()].sort()).toEqual(['c0', 'c1', 'c2']);
        expect(again.cache.rows(SHELL).has('state')).toBe(true);
        // A new fake server: the same data under a new boot id, so the body hash answers.
        const result = await again.workspace.pull('', again.workspace.cursor());
        expect(sentHeaders(again.fetch.calls[0])['if-none-match']).toBe(first.cache.meta(WORKSPACE_SNAPSHOT)?.etag);
        expect(result.outcome).toBe('not-modified');
    });

    it('asks without the tag for a full poll, and a 200 with nothing new changes nothing', async () => {
        const s = await setup();
        const { cursor } = await s.state.pull('', null);
        const full = await s.state.pull('', null);
        expect(sentHeaders(s.fetch.calls[1])['if-none-match']).toBeUndefined();
        expect(full).toEqual({ outcome: 'unchanged', upserts: [], removes: [], cursor });
    });

    it('keeps notices on the device after the server’s 24 hours, at most NOTICES_KEPT, the newest', async () => {
        const s = await setup();
        s.server.change('state', (data) => {
            data.notices = [notice('n1', s.clock.server - HOUR), notice('n2', s.clock.server)];
        });
        await s.state.pull('', null);
        s.clock.server += 25 * HOUR;
        s.server.change('state', (data) => {
            data.notices.push(notice('n3', s.clock.server));
        });
        const later = await s.state.pull('', s.state.cursor());
        expect(s.server.requests.at(-1)?.status).toBe(200);
        // Only the notices changed: the shell's row holds State without them.
        expect(keys(later)).toEqual(['notices/n3']);
        expect(later.removes).toEqual([]);
        expect([...s.cache.rows(NOTICES).keys()].sort()).toEqual(['n1', 'n2', 'n3']);
        // The shell's row holds State without its notices.
        expect(JSON.parse(s.cache.rows(SHELL).get('state')?.json ?? '{}')).not.toHaveProperty('notices');

        // Over the bound, the oldest go.
        const start = s.clock.server;
        for (let round = 0; round < NOTICES_KEPT / 5; round++) {
            s.clock.server = start + (round + 1) * 25 * HOUR;
            s.server.change('state', (data) => {
                data.notices = Array.from({ length: 5 }, (_, i) => notice(`r${round}-${i}`, s.clock.server + i));
            });
            await s.state.pull('', s.state.cursor());
        }
        const kept = s.cache.rows(NOTICES);
        expect(kept.size).toBe(NOTICES_KEPT);
        expect(['n1', 'n2', 'n3'].some((id) => kept.has(id))).toBe(false);
        await s.cache.flush();
        expect(Object.keys(await rowsOnDisk(s.db, NOTICES))).toHaveLength(NOTICES_KEPT);
    });

    it('rejects a failed answer with an HttpError serverAway reads, having applied nothing', async () => {
        const s = await setup();
        await s.workspace.pull('', null);
        s.server.end();
        const unauthorized = await s.workspace.pull('', s.workspace.cursor()).catch((error: unknown) => error);
        expect(unauthorized).toBeInstanceOf(HttpError);
        expect(unauthorized).toMatchObject({ status: 401, code: 'sign_in', message: 'Sign in to continue.' });
        expect(serverAway(unauthorized)).toBe(false);
        expect(s.ends).toEqual(['ended']);
        expect(s.cache.rows(CONVERSATIONS).size).toBe(3);

        for (const [status, body, away] of [
            [502, '<html>Bad gateway</html>', true],
            [503, { error: 'Restarting.', code: 'draining' }, true],
            [503, '<html>Unavailable</html>', true],
            [500, { error: 'Boom.' }, false],
        ] as const) {
            const fetch = fakeFetch(() =>
                typeof body === 'string'
                    ? new Response(body, { status, headers: { date: httpDate(s.clock.server) } })
                    : answer(status, { body, date: httpDate(s.clock.server) }),
            );
            const source = createSnapshotSource({
                definition: STATE_SNAPSHOT,
                cache: s.cache,
                fetch: (input) => fetch(new URL(input, ORIGIN).href, {}),
            });
            const error = await source.pull('', null).catch((caught: unknown) => caught);
            expect(error, String(status)).toBeInstanceOf(HttpError);
            expect(serverAway(error), String(status)).toBe(away);
        }
    });

    it('applies nothing of a 200 that isn’t the snapshot', async () => {
        const s = await setup();
        await s.workspace.pull('', null);
        for (const body of [
            '<html>Sign in to the hotel Wi-Fi</html>',
            '{"user":{},"spaces":[],"dots":[]}',
            '{"user":{},"spaces":[],"dots":[],"conversations":[{"title":"no id"}]}',
        ]) {
            const source = createSnapshotSource({
                definition: WORKSPACE_SNAPSHOT,
                cache: s.cache,
                fetch: async () => new Response(body, { status: 200, headers: { etag: '"x.y"' } }),
            });
            await expect(source.pull('', null), body).rejects.toBeInstanceOf(SnapshotShapeError);
        }
        expect(s.cache.rows(CONVERSATIONS).size).toBe(3);
        expect(s.cache.cursor(WORKSPACE_SNAPSHOT)).not.toBe('"x.y"');
    });

    it('applies nothing once the scope has closed', async () => {
        const s = await setup({ hold: true });
        const pull = s.workspace.pull('', null);
        await new Promise((done) => setTimeout(done, 0));
        s.scope.abort();
        s.release();
        await expect(pull).rejects.toMatchObject({ name: 'AbortError' });
        expect(s.cache.rows(CONVERSATIONS).size).toBe(0);
    });

    it('drops a source’s ETag when its rows are of another format, so the next pull is full', async () => {
        const s = await setup();
        await s.state.pull('', null);
        await s.cache.close();
        const newer = { ...STATE_SNAPSHOT, format: 2 };
        const cache = await openSnapshotCache({ db: s.db, definitions: [newer] });
        expect(cache.meta(newer)?.etag).toMatch(/^W\//);
        expect(cache.cursor(newer)).toBeNull();
        await cache.close();
    });
});

describe('the cache’s listeners', () => {
    it('hear each change as it applies, a pull’s or a confirmation’s, and nothing of an answer that changed nothing', async () => {
        const s = await setup();
        const heard: { upserts: string[]; removes: string[]; confirmed: boolean }[] = [];
        const unsubscribe = s.cache.subscribe((change) => {
            heard.push({
                upserts: change.upserts.map(({ collection, key }) => `${collection}/${key}`).sort(),
                removes: change.removes.map(({ collection, key }) => `${collection}/${key}`).sort(),
                confirmed: change.confirmed,
            });
        });
        await s.workspace.pull('', s.workspace.cursor());
        expect(heard).toHaveLength(1);
        expect(heard[0]?.upserts).toContain('conversations/c1');
        expect(heard[0]?.confirmed).toBe(false);
        // A 304, and a 200 with nothing new, tell nothing.
        await s.workspace.pull('', s.workspace.cursor());
        await s.workspace.pull('', null);
        expect(heard).toHaveLength(1);
        await s.cache.confirm({ collection: CONVERSATIONS, scope: '', key: 'c2', deleted: true });
        // The same row confirmed again tells nothing either.
        await s.cache.confirm({ collection: CONVERSATIONS, scope: '', key: 'c2', deleted: true });
        expect(heard.slice(1)).toEqual([{ upserts: [], removes: ['conversations/c2'], confirmed: true }]);
        s.server.change('workspace', (data) => {
            data.conversations = [conversation('c1', 'Kickoff', 3)];
        });
        unsubscribe();
        await s.workspace.pull('', s.workspace.cursor());
        expect(heard).toHaveLength(2);
    });

    it('get no rows once the cache has closed, and a listener added then is never kept', async () => {
        const s = await setup();
        await s.workspace.pull('', null);
        expect(s.cache.rows(CONVERSATIONS).size).toBe(3);
        await s.cache.close();
        // A reader left over after the scope closed (a collection started again) gets nothing.
        expect(s.cache.rows(CONVERSATIONS).size).toBe(0);
        expect(s.cache.rows(SHELL).size).toBe(0);
        const unsubscribe = s.cache.subscribe(() => {
            throw new Error('A closed cache tells nothing.');
        });
        unsubscribe();
        // The rows reached cache.db all the same.
        expect(Object.keys(await rowsOnDisk(s.db, CONVERSATIONS)).sort()).toEqual(['c0', 'c1', 'c2']);
    });
});
