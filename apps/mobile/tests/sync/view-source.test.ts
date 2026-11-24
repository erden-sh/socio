import { describe, expect, it } from 'vitest';

import type { RowChanges, ViewRow } from '@socio/shared/dataset-views/contract';
import { PEOPLE_DIRECTORY_PATH, PEOPLE_LOOKUP_PATH, viewRoutes } from '@socio/shared/dataset-views/contract';
import { ACME_MINE, TABLE_FIXTURE, WRITE_FIXTURES } from '@socio/shared/dataset-views/fixtures/index';
import { ACME_DATASET, ACME_TABLE } from '@socio/shared/dataset-views/fixtures/writes';

import type { AuthedRequestInit } from '../../src/net/authed-fetch';
import { createFixtureViewSource, FIXTURE_REF } from '../../src/sync/fixture-source';
import {
    attachmentName,
    createLiveViewSource,
    refusedOf,
    reconcileSpan,
    type ViewSource,
    ViewSourceError,
    viewUrls,
} from '../../src/sync/view-source';

// The dataset views' data layer (CB-469; CB-451): the live
// source asks the contract's routes and parses their answers with the shared
// schemas (a 404 before step 8 is "not served"; a GET's ETag is sent back and
// a 304 answered from the copy), and a restore reconciles a cached span by its
// index and lookups, never a full resync, with the table fixture's sync data.

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function fakeFetch(answer: (path: string, init?: AuthedRequestInit) => Response) {
    const sent: Array<{ path: string; init?: AuthedRequestInit }> = [];
    const fetch = async (path: string, init?: AuthedRequestInit) => {
        sent.push({ path, ...(init === undefined ? {} : { init }) });
        return answer(path, init);
    };
    return { fetch, sent };
}

describe('the live view source', () => {
    const ref = { datasetId: 'ds 1', table: 'bookings' };

    it('asks the contract’s routes with the schema it reads', async () => {
        const { fetch, sent } = fakeFetch((path) =>
            path.includes('/views/v_table/rows')
                ? json(TABLE_FIXTURE.page)
                : path.endsWith('/rows/lookup')
                  ? json(TABLE_FIXTURE.sync!.lookup)
                  : path.includes('/index')
                    ? json(TABLE_FIXTURE.sync!.index)
                    : path.includes('/views/v_table?')
                      ? json(TABLE_FIXTURE.definition)
                      : json(TABLE_FIXTURE.list),
        );
        const source = createLiveViewSource({ fetch });
        expect((await source.list(ref)).views[0]?.id).toBe('v_table');
        expect((await source.definition(ref, 'v_table')).view.id).toBe('v_table');
        expect((await source.rows(ref, 'v_table', { schema: 1, limit: 100 })).rows).toHaveLength(4);
        expect((await source.index(ref, 'v_table', { schema: 1 })).entries).toHaveLength(4);
        expect((await source.lookup(ref, ['"b6"'])).rows[0]?.key).toBe('"b6"');
        expect(sent.map((s) => s.path)).toEqual([
            '/api/data/datasets/ds%201/tables/bookings/views?schema=1',
            '/api/data/datasets/ds%201/tables/bookings/views/v_table?schema=1',
            '/api/data/datasets/ds%201/tables/bookings/views/v_table/rows',
            '/api/data/datasets/ds%201/tables/bookings/views/v_table/index',
            '/api/data/datasets/ds%201/tables/bookings/rows/lookup',
        ]);
        expect(sent[2]?.init).toEqual({ method: 'POST', json: { schema: 1, limit: 100 } });
        expect(sent[4]?.init).toEqual({ method: 'POST', json: { schema: 1, keys: ['"b6"'] } });
        expect(viewUrls(ref).changesSince('g.1')).toBe(
            '/api/data/datasets/ds%201/tables/bookings/changes?since=g.1&schema=1',
        );
    });

    it('sends a GET’s ETag back and answers a 304 from its copy', async () => {
        let calls = 0;
        const { fetch, sent } = fakeFetch(() =>
            calls++ === 0 ? json(TABLE_FIXTURE.list, 200, { etag: 'W/"v1"' }) : new Response(null, { status: 304 }),
        );
        const source = createLiveViewSource({ fetch });
        await source.list(ref);
        const again = await source.list(ref);
        expect(again.views[0]?.id).toBe('v_table');
        expect(sent[1]?.init).toEqual({ headers: { 'if-none-match': 'W/"v1"' } });
    });

    it('says a server before step 8 doesn’t serve views, and a stale cursor is its own error', async () => {
        const notServed = createLiveViewSource({ fetch: fakeFetch(() => json({ error: 'Not found' }, 404)).fetch });
        await expect(notServed.list(ref)).rejects.toMatchObject({ kind: 'not-served' });
        const stale = createLiveViewSource({
            fetch: fakeFetch(() => json({ error: 'The view changed.', code: 'cursor_stale' }, 409)).fetch,
        });
        await expect(stale.rows(ref, 'v_table', { schema: 1, cursor: 'c' })).rejects.toBeInstanceOf(ViewSourceError);
        await expect(stale.rows(ref, 'v_table', { schema: 1, cursor: 'c' })).rejects.toMatchObject({
            kind: 'cursor-stale',
        });
    });

    it('edits a cell as compare-and-set on shared’s route, a 409 bringing the conflict whole', async () => {
        const [edited] = WRITE_FIXTURES.rowWritten;
        const [conflict] = WRITE_FIXTURES.cellConflict;
        let answer = json(edited);
        const { fetch, sent } = fakeFetch(() => answer);
        const source = createLiveViewSource({ fetch });
        const edit = { field: 'status', from: 'opt_todo', to: 'opt_doing' } as const;
        expect(await source.editCell(ref, '1042', edit)).toEqual({ outcome: 'saved', written: edited });
        expect(sent[0]).toEqual({
            path: `${viewRoutes('ds 1', 'bookings').row('1042')}`,
            init: { method: 'PATCH', json: WRITE_FIXTURES.cellEditRequest[0] },
        });
        // A row key is JCS JSON: encoded whole, never read as a path.
        await source.editCell(ref, '[1,"a/b"]', edit);
        expect(sent[1]?.path).toBe('/api/data/datasets/ds%201/tables/bookings/rows/%5B1%2C%22a%2Fb%22%5D');
        answer = json(conflict, 409);
        expect(await source.editCell(ref, '1042', edit)).toEqual({ outcome: 'conflict', conflict });
        answer = json(WRITE_FIXTURES.writeRefusal[1], 404);
        expect(await source.editCell(ref, '1042', edit)).toMatchObject({
            outcome: 'refused',
            status: 404,
            code: 'row_gone',
        });
        answer = json({ error: 'Changed', code: 'cell_conflict' }, 409);
        expect(await source.editCell(ref, '1042', edit)).toMatchObject({ outcome: 'refused', code: 'unreadable' });
    });
});

describe('the live source’s writes', () => {
    const ref = { datasetId: ACME_DATASET, table: ACME_TABLE };
    const routes = viewRoutes(ACME_DATASET, ACME_TABLE);

    it('saves a draft and drops it, at the view’s base version', async () => {
        const { fetch, sent } = fakeFetch((_path, init) =>
            init?.method === 'DELETE' ? json({ ok: true }) : json(WRITE_FIXTURES.viewDraftSaved[0]),
        );
        const source = createLiveViewSource({ fetch });
        const [draft] = WRITE_FIXTURES.viewDraftRequest;
        expect(await source.saveDraft(ref, ACME_MINE.id, draft.definition, draft.baseVersion)).toEqual({
            outcome: 'saved',
            saved: WRITE_FIXTURES.viewDraftSaved[0],
        });
        expect(await source.dropDraft(ref, ACME_MINE.id)).toEqual({ outcome: 'saved' });
        expect(sent.map((s) => [s.path, s.init?.method])).toEqual([
            [routes.draft(ACME_MINE.id), 'PUT'],
            [routes.draft(ACME_MINE.id), 'DELETE'],
        ]);
        expect(sent[0]?.init?.json).toEqual(draft);
    });

    it('saves for everyone; a 409 is the conflict, and Keep mine overwrites at its version', async () => {
        let answer = json(WRITE_FIXTURES.viewConflict[0], 409);
        const { fetch, sent } = fakeFetch(() => answer);
        const source = createLiveViewSource({ fetch });
        const conflict = await source.saveView(ref, ACME_MINE.id, ACME_MINE, 3);
        expect(conflict).toEqual({ outcome: 'conflict', conflict: WRITE_FIXTURES.viewConflict[0] });
        expect(sent[0]?.init?.json).toEqual(WRITE_FIXTURES.viewSaveRequest[0]);
        answer = json(WRITE_FIXTURES.viewSaved[0]);
        const current = conflict.outcome === 'conflict' ? conflict.conflict.current.version : -1;
        expect(await source.saveView(ref, ACME_MINE.id, ACME_MINE, current, true)).toEqual({
            outcome: 'saved',
            saved: WRITE_FIXTURES.viewSaved[0],
        });
        expect(sent[1]).toEqual({
            path: routes.view(ACME_MINE.id),
            init: { method: 'PUT', json: WRITE_FIXTURES.viewSaveRequest[1] },
        });
        answer = json(WRITE_FIXTURES.viewSaved[1], 201);
        const [create] = WRITE_FIXTURES.viewCreateRequest;
        expect(await source.createView(ref, create.definition, create.fromDraft)).toMatchObject({ outcome: 'saved' });
        expect(sent[2]).toEqual({ path: routes.views, init: { method: 'POST', json: create } });
    });

    it('creates a row with its createId: 201 new, 200 a replay, 400 its problems, 409 key_taken', async () => {
        let answer = json(WRITE_FIXTURES.rowWritten[1], 201);
        const { fetch, sent } = fakeFetch(() => answer);
        const source = createLiveViewSource({ fetch });
        const [request] = WRITE_FIXTURES.rowCreateRequest;
        expect(await source.createRow(ref, request.values, request.createId)).toEqual({
            outcome: 'created',
            written: WRITE_FIXTURES.rowWritten[1],
            replayed: false,
        });
        expect(sent[0]).toEqual({ path: routes.rows, init: { method: 'POST', json: request } });
        answer = json(WRITE_FIXTURES.rowWritten[1], 200);
        expect(await source.createRow(ref, request.values, request.createId)).toMatchObject({ replayed: true });
        answer = json(WRITE_FIXTURES.invalidWrite[0], 400);
        expect(await source.createRow(ref, {}, request.createId)).toEqual({
            outcome: 'invalid',
            invalid: WRITE_FIXTURES.invalidWrite[0],
        });
        answer = json(WRITE_FIXTURES.writeRefusal[0], 409);
        expect(await source.createRow(ref, request.values)).toMatchObject({ outcome: 'refused', code: 'key_taken' });
    });

    it('reads and saves field settings: a conflict, options in use, then saved', async () => {
        const answers = [
            json(WRITE_FIXTURES.fieldSettingsResponse[0], 200, { etag: 'W/"f1"' }),
            json(WRITE_FIXTURES.fieldConflict[0], 409),
            json(WRITE_FIXTURES.optionsInUse[0], 409),
            json(WRITE_FIXTURES.fieldSettingsSaved[0]),
        ];
        const { fetch, sent } = fakeFetch(() => answers.shift()!);
        const source = createLiveViewSource({ fetch });
        expect((await source.fields(ref)).canEdit).toBe(true);
        expect(sent[0]?.path).toBe(`${routes.fields}?schema=1`);
        const { schema: _schema, ...save } = WRITE_FIXTURES.fieldSettingsRequest[0];
        expect(await source.saveField(ref, 'status', save)).toMatchObject({ outcome: 'conflict' });
        expect(await source.saveField(ref, 'status', save)).toMatchObject({
            outcome: 'in-use',
            inUse: { inUse: [{ id: 'opt_done', rows: 12 }] },
        });
        expect(await source.saveField(ref, 'status', save)).toMatchObject({ outcome: 'saved' });
        expect(sent[1]).toEqual({
            path: routes.field('status'),
            init: { method: 'PUT', json: WRITE_FIXTURES.fieldSettingsRequest[0] },
        });
    });

    it('reads the people directory with its ETag, and looks names up 500 at a time', async () => {
        const asked: unknown[] = [];
        const { fetch, sent } = fakeFetch((path, init) => {
            if (path === PEOPLE_LOOKUP_PATH) {
                const { ids } = (init!.json ?? { ids: [] }) as { ids: string[] };
                asked.push(ids.length);
                return json({
                    schema: 1,
                    users: Object.fromEntries(ids.map((id) => [id, { name: id, avatar: null, active: false }])),
                });
            }
            return sent.length === 1
                ? json(WRITE_FIXTURES.peopleDirectory[0], 200, { etag: 'W/"p1"' })
                : new Response(null, { status: 304 });
        });
        const source = createLiveViewSource({ fetch });
        expect((await source.people()).people.map((p) => p.id)).toEqual(['u_ada']);
        expect((await source.people()).people.map((p) => p.id)).toEqual(['u_ada']);
        expect(sent[1]).toEqual({ path: PEOPLE_DIRECTORY_PATH, init: { headers: { 'if-none-match': 'W/"p1"' } } });
        const ids = Array.from({ length: 1_001 }, (_, i) => `u_${i}`);
        const found = await source.lookupPeople([...ids, 'u_0']);
        expect(asked).toEqual([500, 500, 1]);
        expect(Object.keys(found.users)).toHaveLength(1_001);
        expect(found.users.u_7).toEqual({ name: 'u_7', avatar: null, active: false });
    });

    it('uploads a file’s bytes raw to the dataset’s files, and words 413, 415 and 429 by code', async () => {
        let answer = json(WRITE_FIXTURES.datasetFileUploaded[0], 201);
        const { fetch, sent } = fakeFetch(() => answer);
        const source = createLiveViewSource({ fetch });
        const body = new Uint8Array([0x89, 0x50]);
        const upload = { body, name: 'acme-logo.png', type: 'image/png', bytes: 2 };
        expect(await source.uploadFile(ACME_DATASET, upload)).toEqual({
            outcome: 'uploaded',
            uploaded: WRITE_FIXTURES.datasetFileUploaded[0],
        });
        expect(sent[0]).toEqual({
            path: routes.files,
            init: { method: 'POST', upload: { body, name: 'acme-logo.png', type: 'image/png' } },
        });
        answer = json(WRITE_FIXTURES.writeRefusal[3], 415);
        expect(await source.uploadFile(ACME_DATASET, upload)).toMatchObject({ code: 'unsupported_file', status: 415 });
        answer = json({ error: 'Too large', code: 'file_too_large' }, 413);
        expect(await source.uploadFile(ACME_DATASET, upload)).toMatchObject({ code: 'file_too_large' });
        answer = new Response('slow down', { status: 429, headers: { 'retry-after': '30' } });
        expect(await source.uploadFile(ACME_DATASET, upload)).toMatchObject({
            code: 'rate_limited',
            retryAfterSeconds: 30,
        });
        const offline = createLiveViewSource({
            fetch: async () => {
                throw new Error('offline');
            },
        });
        expect(await offline.uploadFile(ACME_DATASET, upload)).toMatchObject({ code: 'network', status: null });
    });

    it('exports CSV with its name from the server, and a 413 too_many_rows with its counts', async () => {
        let answer = new Response('\uFEFFTitle\r\nShip\r\n', {
            status: 200,
            headers: {
                'content-type': 'text/csv; charset=utf-8',
                'content-disposition': `attachment; filename="open.csv"; filename*=UTF-8''Open%20tasks.csv`,
            },
        });
        const { fetch, sent } = fakeFetch(() => answer);
        const source = createLiveViewSource({ fetch });
        expect(await source.exportCsv(ref, ACME_MINE.id, { name: 'Open tasks' })).toEqual({
            outcome: 'csv',
            name: 'Open tasks.csv',
            text: '\uFEFFTitle\r\nShip\r\n',
        });
        expect(sent[0]?.path).toBe(`${routes.exportCsv(ACME_MINE.id)}?schema=1`);
        answer = json(WRITE_FIXTURES.exportTooLarge[0], 413);
        expect(await source.exportCsv(ref, ACME_MINE.id, { name: 'Open tasks', useDraft: false })).toEqual({
            outcome: 'too-large',
            tooLarge: WRITE_FIXTURES.exportTooLarge[0],
        });
        expect(sent[1]?.path).toBe(`${routes.exportCsv(ACME_MINE.id)}?schema=1&useDraft=false`);
    });

    it('names an export safely whatever the header says', () => {
        expect(attachmentName(null, 'Open tasks.csv')).toBe('Open tasks.csv');
        expect(attachmentName('attachment; filename="../../etc/passwd"', 'x.csv')).toBe('etc-passwd');
        expect(attachmentName("attachment; filename*=UTF-8''Caf%C3%A9.csv", 'x.csv')).toBe('Café.csv');
        expect(attachmentName('attachment; filename=plain.csv', 'x.csv')).toBe('plain.csv');
        expect(attachmentName('attachment; filename=""', 'Fallback.csv')).toBe('Fallback.csv');
    });

    it('reads a refusal’s code, else the phone’s for its status', () => {
        expect(refusedOf(403, WRITE_FIXTURES.writeRefusal[2])).toMatchObject({ code: 'read_only' });
        expect(refusedOf(404, { error: 'Not found' })).toMatchObject({ code: 'not_served' });
        expect(refusedOf(429, 'busy', '12')).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 12 });
        expect(refusedOf(500, null)).toMatchObject({ code: 'failed', status: 500 });
    });
});

/** A source answering the table fixture's sync data, counting what it is asked. */
function syncSource(changes: RowChanges) {
    const sync = TABLE_FIXTURE.sync!;
    const asked = { index: [] as unknown[], lookup: [] as string[][] };
    const base = createFixtureViewSource();
    const source: ViewSource = {
        ...base,
        changes: async () => changes,
        index: async (_ref, _view, request) => {
            asked.index.push(request);
            return sync.index;
        },
        lookup: async (_ref, keys) => {
            asked.lookup.push([...keys]);
            return { ...sync.lookup, rows: sync.lookup.rows.filter((row) => keys.includes(row.key)) };
        },
    };
    return { source, asked };
}

describe('a restore reconciles, never a full resync', () => {
    const sync = TABLE_FIXTURE.sync!;
    const cachedRows: ViewRow[] = TABLE_FIXTURE.page.rows;
    const span = { viewId: 'v_table', request: TABLE_FIXTURE.request, rows: cachedRows, bytes: 4_000 };

    it('reads the span’s index with its own request, fetches only changed or new keys, keeps the rest', async () => {
        const { source, asked } = syncSource(sync.changes.reconcile);
        const result = await reconcileSpan(source, FIXTURE_REF, span, 'k7Hq2mZ0aB9xYw4L.1042');
        expect(result.kind).toBe('reconciled');
        if (result.kind !== 'reconciled') {
            return;
        }
        expect(asked.index).toEqual([{ schema: 1 }]);
        expect(asked.lookup).toEqual([sync.plan.fetch]);
        expect(result.rows.map((row) => row.key)).toEqual(sync.plan.order);
        expect(result.kept).toBe(sync.plan.keep.length);
        expect(result.fetched).toBe(3);
        // The kept row is the cached object itself: nothing fetched for it.
        expect(result.rows[0]).toBe(cachedRows[0]);
        expect(result.rows.find((row) => row.key === '"b4"')?.values.title).toBe('Offsite (draft)');
        expect(result.token).toBe(sync.index.datasetToken);
    });

    it('applies plain changes in place, and reads again only without stamps or a cache worth keeping', async () => {
        const applied = await reconcileSpan(syncSource(sync.changes.apply).source, FIXTURE_REF, span, 'x.1');
        expect(applied).toMatchObject({ kind: 'applied', removed: ['"b3"'] });
        expect(applied.kind === 'applied' && applied.rows.map((r) => r.key)).toEqual(['"b1"', '"b5"', '"b4"']);
        expect(await reconcileSpan(syncSource(sync.changes.resync).source, FIXTURE_REF, span, 'x.1')).toEqual({
            kind: 'refetch',
            why: 'resync',
        });
        expect(
            await reconcileSpan(
                syncSource(sync.changes.reconcile).source,
                FIXTURE_REF,
                { ...span, rows: [], bytes: 0 },
                'x.1',
            ),
        ).toEqual({ kind: 'refetch', why: 'no-cache' });
        expect(
            await reconcileSpan(syncSource(sync.changes.reconcile).source, FIXTURE_REF, { ...span, bytes: 40 }, 'x.1'),
        ).toEqual({ kind: 'refetch', why: 'cheaper' });
    });

    it('asks the fixture source for a reconcile after another generation', async () => {
        const source = createFixtureViewSource();
        expect((await source.changes(FIXTURE_REF, 'other.1')).reconcile).toBe(true);
        const fresh = await source.changes(FIXTURE_REF, TABLE_FIXTURE.page.datasetToken);
        expect(fresh.reconcile).toBeUndefined();
        expect(fresh.upserts).toEqual([]);
    });
});
