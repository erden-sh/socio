import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DatasetView } from '@socio/shared/data-types';
import type { SpecValidation } from '@socio/shared/dataset-query/spec';
import {
    fieldConflict,
    fieldSettingsResponse,
    fieldSettingsSaved,
    invalidWrite,
    optionsInUse,
    viewRoutes,
    type FieldSettingEntry,
    type FieldSettingsResponse,
} from '@socio/shared/dataset-views/contract';
import { checkFieldSetting, fieldDisplayFor } from '@socio/shared/dataset-views/field-settings';
import type { Space } from '@socio/shared/types';

import { roomsFixture } from './fixtures/rooms.js';

// Field settings (CB-451, build step 4): every field of a table with
// its kind and settings for whoever reads the dataset; saved by people who
// may write it, checked against the column's type and the version the save
// started from; removing options rows still use asks first; the query
// spec's validator reads them.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const json = async <T>(response: Promise<Response> | Response) => (await response).json() as Promise<T>;

/**
 * Ada's private Space "Deals" (Mo reads it as a member) holds her dataset
 * "Pipeline", whose table `deals` the company socio filled. Nina is outside
 * the Space; Alice is a workspace admin, who reads every Space.
 */
async function fixture() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = await roomsFixture(cleanup);
    const deals = (
        await json<Space>(
            f.as('ada')('/spaces', 'POST', {
                name: 'Deals',
                description: '',
                private: true,
                people: [{ userId: 'mo', role: 'member' }],
            }),
        )
    ).id;
    const made = await f.as('ada')('/data/datasets', 'POST', { name: 'Pipeline', sharedSpaceId: deals });
    expect(made.status).toBe(201);
    const dataset = await json<DatasetView>(made);
    f.platform.data.setGrant('ada', { dotId: f.company.id, datasetId: dataset.id, access: 'write' });
    const actor = { kind: 'dot' as const, userId: 'ada', dotId: f.company.id };
    await f.platform.data.write(
        actor,
        dataset.id,
        {
            op: 'create_table',
            input: {
                table: 'deals',
                columns: [
                    { name: 'id', type: 'TEXT', primaryKey: true },
                    { name: 'stage', type: 'TEXT' },
                    { name: 'amount', type: 'INTEGER' },
                    { name: 'price', type: 'REAL' },
                    { name: 'tags', type: 'JSON' },
                    { name: 'title', type: 'TEXT', notNull: true },
                ],
            },
        },
        true,
    );
    await f.platform.data.write(
        actor,
        dataset.id,
        {
            op: 'insert',
            table: 'deals',
            rows: [
                { id: 'd1', stage: 'won', amount: 1200, price: 1.5, tags: ['hot', 'new'], title: 'Acme renewal' },
                { id: 'd2', stage: 'won', amount: 800, price: 2, tags: ['hot'], title: 'Acme upsell' },
                { id: 'd3', stage: 'lost', amount: 50, price: 3, tags: [], title: 'Acme pilot' },
            ],
        },
        true,
    );
    const routes = local(viewRoutes(dataset.id, 'deals'));
    const fields = async (who: string) => {
        const response = await f.as(who)(routes.fields);
        return { status: response.status, body: (await response.json()) as FieldSettingsResponse & { error?: string } };
    };
    const save = async (who: string, field: string, body: Record<string, unknown>) => {
        const response = await f.as(who)(routes.field(field), 'PUT', { schema: 1, settings: {}, ...body });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    return { ...f, deals, dataset, routes, fields, save };
}

/** The view routes as the fixture's callers take them: under `/api` already. */
const local = (routes: ReturnType<typeof viewRoutes>) => ({
    fields: routes.fields.replace(/^\/api/, ''),
    field: (name: string) => routes.field(name).replace(/^\/api/, ''),
});

const byField = (answer: FieldSettingsResponse) =>
    Object.fromEntries(answer.fields.map((entry) => [entry.field, entry])) as Record<string, FieldSettingEntry>;

describe('GET …/tables/:table/fields', () => {
    it('infers every field from its column type, for whoever reads the dataset', async () => {
        const f = await fixture();
        const ada = await f.fields('ada');
        expect(ada.status).toBe(200);
        expect(fieldSettingsResponse.safeParse(ada.body).success).toBe(true);
        expect(ada.body.schema).toBe(1);
        expect(ada.body.canEdit).toBe(true);
        const fields = byField(ada.body);
        expect(ada.body.fields.map((entry) => [entry.field, entry.kind, entry.version])).toEqual([
            ['id', 'id', 0],
            ['stage', 'text', 0],
            ['amount', 'number', 0],
            ['price', 'number', 0],
            ['tags', 'json', 0],
            ['title', 'text', 0],
        ]);
        expect(fields.id).toMatchObject({ isKey: true, editable: false, type: 'TEXT', fallback: 'text' });
        expect(fields.id!.kinds).toContain('id');
        expect(fields.stage!.kinds).toEqual([
            'text',
            'long_text',
            'date',
            'select',
            'multi_select',
            'person',
            'file',
            'url',
            'email',
            'phone',
        ]);
        expect(fields.amount!.kinds).toEqual(['number', 'currency', 'checkbox', 'datetime']);
        expect(fields.price!.kinds).toEqual(['number', 'currency', 'percent']);
        expect(fields.title).toMatchObject({ required: true, editable: true, label: 'title', settings: {} });
        expect(fields.tags).toMatchObject({ editable: false, fallback: 'json' });

        // Mo reads the Space, so the dataset, but may not change its fields.
        const mo = await f.fields('mo');
        expect(mo.status).toBe(200);
        expect(mo.body.canEdit).toBe(false);
        expect(mo.body.fields.every((entry) => !entry.editable)).toBe(true);
        // An admin reads every Space, but a person's dataset is theirs to change.
        const alice = await f.fields('alice');
        expect([alice.status, alice.body.canEdit]).toEqual([200, false]);
        // Nobody else learns it exists.
        expect((await f.fields('nina')).status).toBe(404);
        expect(
            (await json<{ error: string }>(f.as('ada')(local(viewRoutes(f.dataset.id, 'nope')).fields))).error,
        ).toMatch(/no table "nope"/);
    });

    it('answers 304 until a field changes', async () => {
        const f = await fixture();
        const first = await f.as('ada')(f.routes.fields);
        const etag = first.headers.get('etag')!;
        expect(etag).toBeTruthy();
        const login = await f.app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 'ada' }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        const poll = () => f.app.request(`/api${f.routes.fields}`, { headers: { cookie, 'If-None-Match': etag } });
        expect((await poll()).status).toBe(304);
        expect((await f.save('ada', 'stage', { kind: 'long_text', baseVersion: 0 })).status).toBe(200);
        expect((await poll()).status).toBe(200);
    });
});

describe('PUT …/tables/:table/fields/:field', () => {
    it('lets only people who may write the dataset save, and audits it', async () => {
        const f = await fixture();
        const mo = await f.save('mo', 'stage', { kind: 'long_text', baseVersion: 0 });
        expect(mo.status).toBe(403);
        expect(mo.body).toMatchObject({ code: 'read_only', error: expect.stringContaining('Pipeline') });
        expect((await f.save('nina', 'stage', { kind: 'long_text', baseVersion: 0 })).status).toBe(404);
        expect((await f.save('alice', 'stage', { kind: 'long_text', baseVersion: 0 })).status).toBe(403);
        expect((await f.fields('ada')).body.fields.find((entry) => entry.field === 'stage')!.version).toBe(0);

        const ada = await f.save('ada', 'stage', { kind: 'long_text', label: ' Stage ', baseVersion: 0 });
        expect(ada.status).toBe(200);
        expect(fieldSettingsSaved.safeParse(ada.body).success).toBe(true);
        expect(ada.body.field).toMatchObject({ field: 'stage', kind: 'long_text', label: 'Stage', version: 1 });
        // Mo now sees Ada's setting.
        expect(byField((await f.fields('mo')).body).stage).toMatchObject({ kind: 'long_text', label: 'Stage' });
        const audit = f.workspace.db
            .prepare("SELECT actorId, action, outcome, target FROM data_audit WHERE action = 'field_settings'")
            .all()
            .map((row) => ({ ...row }));
        expect(audit).toEqual([
            { actorId: 'mo', action: 'field_settings', outcome: 'denied', target: 'Pipeline.deals.stage' },
            { actorId: 'alice', action: 'field_settings', outcome: 'denied', target: 'Pipeline.deals.stage' },
            { actorId: 'ada', action: 'field_settings', outcome: 'ok', target: 'Pipeline.deals.stage' },
        ]);
    });

    it('audits every refusal with its code', async () => {
        const f = await fixture();
        const options = [{ id: 'won', label: 'Won', color: 'green' }];
        expect((await f.save('ada', 'stage', { kind: 'select', settings: { options }, baseVersion: 0 })).status).toBe(
            200,
        );
        expect((await f.save('ada', 'stage', { kind: 'text' })).status).toBe(400);
        expect((await f.save('ada', 'stage', { kind: 'currency', baseVersion: 1 })).status).toBe(400);
        expect((await f.save('ada', 'stage', { kind: 'text', baseVersion: 0 })).status).toBe(409);
        expect(
            (await f.save('ada', 'stage', { kind: 'select', settings: { options: [] }, baseVersion: 1 })).status,
        ).toBe(409);
        const audit = f.workspace.db
            .prepare("SELECT outcome, detail FROM data_audit WHERE action = 'field_settings' ORDER BY createdAt, rowid")
            .all()
            .map((row) => ({ ...row }));
        expect(audit).toEqual([
            { outcome: 'ok', detail: 'select' },
            { outcome: 'denied', detail: 'invalid' },
            { outcome: 'denied', detail: 'invalid' },
            { outcome: 'denied', detail: 'field_conflict' },
            { outcome: 'denied', detail: 'options_in_use' },
        ]);
    });

    it('refuses a kind or a setting the column type doesn’t take, naming the type', async () => {
        const f = await fixture();
        const currency = await f.save('ada', 'stage', {
            kind: 'currency',
            settings: { currency: 'USD' },
            baseVersion: 0,
        });
        expect(currency.status).toBe(400);
        expect(invalidWrite.safeParse(currency.body).success).toBe(true);
        expect(currency.body.problems).toEqual([
            { path: '$.kind', message: expect.stringMatching(/stored as TEXT, which can't hold a currency field/) },
        ]);
        const cents = await f.save('ada', 'price', {
            kind: 'currency',
            settings: { currency: 'USD', minorUnits: true },
            baseVersion: 0,
        });
        expect(cents.status).toBe(400);
        expect(cents.body.problems).toEqual([
            { path: '$.settings.minorUnits', message: expect.stringContaining('stored as REAL') },
        ]);
        const id = await f.save('ada', 'title', { kind: 'id', baseVersion: 0 });
        expect((id.body.problems as Array<{ message: string }>)[0]!.message).toMatch(/not the table's key/);
        const unknown = await f.save('ada', 'title', { kind: 'rating', baseVersion: 0 });
        expect(unknown.body.problems).toEqual([
            { path: '$.kind', message: expect.stringContaining('not a field kind') },
        ]);
        const shape = await f.save('ada', 'price', {
            kind: 'currency',
            settings: { currency: 'dollars', decimals: -1 },
            baseVersion: 0,
        });
        expect(shape.status).toBe(400);
        expect((shape.body.problems as Array<{ path: string }>).map((problem) => problem.path)).toEqual([
            '$.settings.currency',
            '$.settings.decimals',
        ]);
        const noVersion = await f.save('ada', 'title', { kind: 'text' });
        expect(noVersion.status).toBe(400);
        expect(noVersion.body).toMatchObject({ code: 'invalid', problems: [{ path: '$.baseVersion' }] });
        expect((await f.save('ada', 'gone', { kind: 'text', baseVersion: 0 })).status).toBe(404);
        // Nothing was saved.
        expect((await f.fields('ada')).body.fields.every((entry) => entry.version === 0)).toBe(true);

        // What fits is kept, with only its kind's settings.
        const fits = await f.save('ada', 'amount', {
            kind: 'currency',
            settings: { currency: 'EUR', minorUnits: true, decimals: 2, unit: 'kg', options: [] },
            baseVersion: 0,
        });
        expect(fits.status).toBe(200);
        expect((fits.body.field as FieldSettingEntry).settings).toEqual({
            currency: 'EUR',
            minorUnits: true,
            decimals: 2,
        });
    });

    it('saves by version: a stale save is a 409 with the field as it is now', async () => {
        const f = await fixture();
        const options = [
            { id: 'won', label: 'Won', color: 'green' },
            { id: 'lost', label: 'Lost', color: 'red' },
        ];
        const first = await f.save('ada', 'stage', { kind: 'select', settings: { options }, baseVersion: 0 });
        expect(first.status).toBe(200);
        expect((first.body.field as FieldSettingEntry).version).toBe(1);
        // A second tab that opened the field before that save.
        const stale = await f.save('ada', 'stage', { kind: 'text', baseVersion: 0 });
        expect(stale.status).toBe(409);
        expect(fieldConflict.safeParse(stale.body).success).toBe(true);
        expect(stale.body.current).toMatchObject({ field: 'stage', kind: 'select', version: 1, settings: { options } });
        const ahead = await f.save('ada', 'stage', { kind: 'text', baseVersion: 7 });
        expect(ahead.status).toBe(409);
        const next = await f.save('ada', 'stage', {
            kind: 'select',
            label: 'Stage',
            settings: { options: [...options, { id: 'open', label: 'Open', color: 'blue' }] },
            baseVersion: 1,
        });
        expect(next.status).toBe(200);
        expect(next.body.field).toMatchObject({ version: 2, label: 'Stage' });
    });

    it('asks before removing options rows still use, with each one’s count', async () => {
        const f = await fixture();
        const options = [
            { id: 'won', label: 'Won', color: 'green' },
            { id: 'lost', label: 'Lost', color: 'red' },
            { id: 'open', label: 'Open', color: 'blue' },
        ];
        expect((await f.save('ada', 'stage', { kind: 'select', settings: { options }, baseVersion: 0 })).status).toBe(
            200,
        );
        // `open` is unused: removing it alone needs no confirmation.
        const unused = await f.save('ada', 'stage', {
            kind: 'select',
            settings: { options: options.slice(0, 2) },
            baseVersion: 1,
        });
        expect(unused.status).toBe(200);
        const used = await f.save('ada', 'stage', { kind: 'select', settings: { options: [] }, baseVersion: 2 });
        expect(used.status).toBe(409);
        expect(optionsInUse.safeParse(used.body).success).toBe(true);
        expect(used.body).toMatchObject({
            code: 'options_in_use',
            error: expect.stringContaining('3 rows still use'),
            inUse: [
                { id: 'won', label: 'Won', rows: 2 },
                { id: 'lost', label: 'Lost', rows: 1 },
            ],
        });
        expect(byField((await f.fields('ada')).body).stage!.version).toBe(2);
        const confirmed = await f.save('ada', 'stage', {
            kind: 'select',
            settings: { options: [] },
            baseVersion: 2,
            confirmRemovedOptions: true,
        });
        expect(confirmed.status).toBe(200);
        expect(confirmed.body.field).toMatchObject({ version: 3, settings: { options: [] } });
        // The rows keep their raw values.
        const rows = await json<{ rows: unknown[][] }>(f.as('ada')(`/data/datasets/${f.dataset.id}/tables/deals/rows`));
        expect(rows.rows.map((row) => row[1])).toEqual(['won', 'won', 'lost']);

        // A multi-select counts the rows whose list holds the option.
        const tags = [
            { id: 'hot', label: 'Hot', color: 'orange' },
            { id: 'new', label: 'New', color: 'blue' },
        ];
        const multi = await f.save('ada', 'tags', {
            kind: 'multi_select',
            settings: { options: tags },
            baseVersion: 0,
        });
        expect(multi.status).toBe(200);
        const dropHot = await f.save('ada', 'tags', {
            kind: 'multi_select',
            settings: { options: tags.slice(1) },
            baseVersion: 1,
        });
        expect(dropHot.body).toMatchObject({ code: 'options_in_use', inUse: [{ id: 'hot', rows: 2 }] });
    });

    it('feeds the query spec’s validator: operators follow the saved kind', async () => {
        const f = await fixture();
        const spec = {
            source: { dataset: f.dataset.id, table: 'deals' },
            filter: { field: 'stage', op: 'is_any_of', value: ['won'] },
        };
        const validate = () => json<SpecValidation>(f.as('ada')('/data/specs/validate', 'POST', { spec }));
        expect((await validate()).problems.map((problem) => problem.path)).toEqual(['$.filter.op']);
        const options = [{ id: 'won', label: 'Won', color: 'green' }];
        expect((await f.save('ada', 'stage', { kind: 'select', settings: { options }, baseVersion: 0 })).status).toBe(
            200,
        );
        expect(await validate()).toMatchObject({ ok: true, problems: [] });
    });

    it('shows a setting whose column is gone to editors only, as missing', async () => {
        const f = await fixture();
        expect((await f.save('ada', 'title', { kind: 'long_text', baseVersion: 0 })).status).toBe(200);
        // As a rename leaves it: the setting names a column the table no longer has.
        f.workspace.db
            .prepare("UPDATE data_field_settings SET columnName = 'headline' WHERE columnName = 'title'")
            .run();
        const ada = byField((await f.fields('ada')).body);
        expect(ada.title).toMatchObject({ kind: 'text', version: 0 });
        expect(ada.headline).toMatchObject({ missing: true, kind: 'long_text', version: 1, editable: false, type: '' });
        expect(byField((await f.fields('mo')).body).headline).toBeUndefined();
        expect((await f.save('ada', 'headline', { kind: 'text', baseVersion: 1 })).status).toBe(404);
    });
});

describe('the shared checks', () => {
    it('drops another kind’s settings and forgives a stored kind that no longer fits', () => {
        expect(
            checkFieldSetting(
                { name: 'n', type: 'INTEGER' },
                { kind: 'number', settings: { unit: 'kg', currency: 'nope', options: 'x' } },
            ),
        ).toEqual({ ok: true, kind: 'number', label: null, settings: { unit: 'kg' } });
        // A column retyped after its setting was saved shows the kind its type gives.
        expect(
            fieldDisplayFor(
                { name: 'n', type: 'TEXT' },
                {
                    column: 'n',
                    kind: 'currency',
                    label: 'Amount',
                    settings: { currency: 'USD' },
                    version: 2,
                    declaredBy: null,
                },
                { write: true },
            ),
        ).toMatchObject({ kind: 'text', label: 'Amount', settings: {}, editable: true });
    });
});
