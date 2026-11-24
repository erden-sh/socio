// The native view contract's writes, pickers and exports (CB-451,
// CB-469): every fixture parses with its schema unchanged, refusals carry
// what a client acts on, requests are checked, and a conflict's
// difference is computed the one way both sides agree on.
import { describe, expect, expectTypeOf, it } from 'vitest';

import * as contract from '@socio/shared/dataset-views/contract';
import {
    cellEditRequest,
    diffViews,
    fieldSettingsRequest,
    PEOPLE_DIRECTORY_PATH,
    PEOPLE_LOOKUP_PATH,
    peopleLookupRequest,
    rowCreateRequest,
    sameJson,
    type CellEditRequest,
    type JsonValue,
    type NewViewDefinition,
    type ViewCreateRequest,
    type ViewDraftRequest,
    type ViewSaveRequest,
    VIEW_WRITE_CODES,
    VIEW_WRITE_LIMITS,
    viewCreateRequest,
    viewDraftRequest,
    viewExportQuery,
    viewExportSearch,
    viewRoutes,
    viewSaveRequest,
} from '@socio/shared/dataset-views/contract';
import { readViewDefinition } from '@socio/shared/dataset-views/fallback';
import {
    ACME_DIFF,
    ACME_MINE,
    ACME_THEIRS,
    WRITE_FIXTURES,
    type WriteFixtureName,
} from '@socio/shared/dataset-views/fixtures/index';
import { parseRowKey, rowKey } from '@socio/shared/dataset-views/schema';

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const schemaOf = (name: WriteFixtureName) =>
    (
        contract as unknown as Record<
            string,
            { parse(v: unknown): unknown; safeParse(v: unknown): { success: boolean } }
        >
    )[name]!;

describe('write fixtures', () => {
    const cases = Object.entries(WRITE_FIXTURES).flatMap(([name, list]) =>
        (list as readonly unknown[]).map((value, i) => [`${name}[${i}]`, name as WriteFixtureName, value] as const),
    );

    it.each(cases)('%s is plain JSON and parses unchanged', (_label, name, value) => {
        expect(json(value)).toEqual(value);
        expect(schemaOf(name).parse(json(value))).toEqual(value);
    });

    it('covers every write shape the contract exports', () => {
        const expected = [
            'viewDraftRequest',
            'viewDraftSaved',
            'viewSaveRequest',
            'viewCreateRequest',
            'viewSaved',
            'viewConflict',
            'cellEditRequest',
            'rowCreateRequest',
            'rowWritten',
            'cellConflict',
            'invalidWrite',
            'writeRefusal',
            'fieldSettingsResponse',
            'fieldSettingsRequest',
            'fieldSettingsSaved',
            'fieldConflict',
            'optionsInUse',
            'exportTooLarge',
            'peopleDirectory',
            'peopleLookupRequest',
            'peopleLookup',
            'datasetFileUploaded',
        ];
        expect(Object.keys(WRITE_FIXTURES).sort()).toEqual([...expected].sort());
    });

    it('uses only codes the contract names', () => {
        const codes = new Set<string>(Object.values(VIEW_WRITE_CODES));
        for (const list of Object.values(WRITE_FIXTURES)) {
            for (const value of list as readonly Record<string, unknown>[]) {
                if ('code' in value) {
                    expect(codes.has(value.code as string)).toBe(true);
                }
            }
        }
    });

    it('keeps parts from a newer release: answers keep unknown keys, a draft its unknown options', () => {
        const draft = WRITE_FIXTURES.viewDraftRequest[0];
        const parsed = viewDraftRequest.parse(json(draft));
        expect(parsed.definition.options).toEqual({ rowHeight: 'tall' });
        expect(readViewDefinition(json(parsed.definition), 'phone').unknownOptions).toEqual(['rowHeight']);

        const answer = { ...json(WRITE_FIXTURES.rowWritten[0]), hint: 'later' };
        expect(contract.rowWritten.parse(answer)).toEqual(answer);
        const conflict = { ...json(WRITE_FIXTURES.cellConflict[0]), merge: 'later' };
        expect(contract.cellConflict.parse(conflict)).toEqual(conflict);
    });
});

describe('a conflict on save for everyone', () => {
    it('diffs part by part and field by field, from mine to theirs', () => {
        expect(diffViews(json(ACME_MINE), json(ACME_THEIRS))).toEqual(ACME_DIFF);
    });

    it('is empty for the same view, keys in any order', () => {
        const reordered = json(ACME_THEIRS);
        reordered.query = { sort: reordered.query.sort, filter: reordered.query.filter };
        expect(diffViews(reordered, ACME_THEIRS)).toEqual({ parts: [], fields: [] });
    });

    it('lists no fields when only another part differs', () => {
        const renamed = { ...json(ACME_THEIRS), name: 'Open' };
        expect(diffViews(renamed, ACME_THEIRS)).toEqual({
            parts: [{ part: 'name', mine: 'Open', theirs: 'Open tasks' }],
            fields: [],
        });
    });

    it('compares JSON values, not references or key order', () => {
        expect(sameJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
        expect(sameJson({ a: 1, b: undefined }, { a: 1 })).toBe(true);
        expect(sameJson([1, 2], [2, 1])).toBe(false);
        expect(sameJson({ a: 1 }, { a: '1' })).toBe(false);
        expect(sameJson(null, {})).toBe(false);
    });

    it('takes keep mine as an overwrite of the current version', () => {
        expect(viewSaveRequest.parse(json(WRITE_FIXTURES.viewSaveRequest[1])).overwrite).toBe(true);
        expect(
            viewSaveRequest.safeParse({ ...json(WRITE_FIXTURES.viewSaveRequest[0]), overwrite: false }).success,
        ).toBe(false);
    });

    it('creates a view from a definition without an id or a version', () => {
        const sent = { ...json(WRITE_FIXTURES.viewCreateRequest[0]) };
        expect(viewCreateRequest.safeParse(sent).success).toBe(true);
        expect(viewCreateRequest.safeParse({ schema: 1, definition: { name: 'x' } }).success).toBe(false);
    });
});

describe('row writes', () => {
    it('edits one cell as compare-and-set: field, from and to, with the schema', () => {
        expect(cellEditRequest.safeParse({ field: 'status', from: 'a', to: 'b' }).success).toBe(false);
        expect(cellEditRequest.safeParse({ schema: 1, field: 'status', to: 'b' }).success).toBe(false);
        expect(cellEditRequest.safeParse({ schema: 1, field: 'team', from: null, to: ['u_ada'] }).success).toBe(true);
        // A blob never leaves the server, so it is never written back.
        expect(cellEditRequest.safeParse({ schema: 1, field: 'raw', from: { $blob: true }, to: null }).success).toBe(
            false,
        );
        expect(
            cellEditRequest.safeParse({
                schema: 1,
                field: 'team',
                from: null,
                to: Array.from({ length: VIEW_WRITE_LIMITS.cellItems + 1 }, (_, i) => `u_${i}`),
            }).success,
        ).toBe(false);
    });

    it('compares against any value the row holds: the write limits bound only the new value', () => {
        const long = 'x'.repeat(VIEW_WRITE_LIMITS.cellText + 5_000);
        const many = Array.from({ length: VIEW_WRITE_LIMITS.cellItems + 1 }, (_, i) => `u_${i}`);
        expect(cellEditRequest.safeParse({ schema: 1, field: 'notes', from: long, to: 'short' }).success).toBe(true);
        expect(cellEditRequest.safeParse({ schema: 1, field: 'team', from: many, to: ['u_ada'] }).success).toBe(true);
        expect(cellEditRequest.safeParse({ schema: 1, field: 'notes', from: 'short', to: long }).success).toBe(false);
        // A malformed list or an object a column held before its kind changed is repaired the same way.
        expect(
            cellEditRequest.safeParse({ schema: 1, field: 'owners', from: [null, 'u_ada'], to: ['u_ada'] }).success,
        ).toBe(true);
        expect(
            cellEditRequest.safeParse({ schema: 1, field: 'owners', from: { a: [1, { b: 2 }] }, to: null }).success,
        ).toBe(true);
        expect(cellEditRequest.safeParse({ schema: 1, field: 'owners', from: null, to: [null, 'u_ada'] }).success).toBe(
            false,
        );
        expect(cellEditRequest.safeParse({ schema: 1, field: 'owners', from: null, to: { a: 1 } }).success).toBe(false);
    });

    it('creates a row by values, with an optional create id that makes a replay add nothing', () => {
        expect(rowCreateRequest.safeParse({ schema: 1, values: {} }).success).toBe(true);
        expect(rowCreateRequest.safeParse({ schema: 1, values: {}, createId: 'short' }).success).toBe(false);
        expect(rowCreateRequest.safeParse({ schema: 1, values: {}, createId: 'has space in it' }).success).toBe(false);
        // The token batch is another body: it doesn't parse as a person's create.
        expect(rowCreateRequest.safeParse({ rows: [{ title: 'x' }], key: ['id'] }).success).toBe(false);
        const many = Object.fromEntries(
            Array.from({ length: VIEW_WRITE_LIMITS.rowFields + 1 }, (_, i) => [`f${i}`, i]),
        );
        expect(rowCreateRequest.safeParse({ schema: 1, values: many }).success).toBe(false);
    });

    it('answers a new row with the key the server assigned and the stamp of its write', () => {
        const created = WRITE_FIXTURES.rowWritten[1];
        expect(parseRowKey(created.row.key)).toEqual({ values: [1043] });
        expect(created.row.key).toBe(rowKey(1043));
        expect(created.row.stamp).toMatch(/^[A-Za-z0-9_-]+\.\d+$/);
    });

    it('answers a conflict with the current value and the row read with it', () => {
        const conflict = WRITE_FIXTURES.cellConflict[0];
        expect(conflict.row.values[conflict.field]).toEqual(conflict.current);
    });
});

describe('field settings', () => {
    it('checks a save: options with unique ids, an ISO currency, a known date format', () => {
        const base = { schema: 1, kind: 'select', baseVersion: 0 };
        expect(fieldSettingsRequest.safeParse({ ...base, settings: {} }).success).toBe(true);
        const twice = {
            ...base,
            settings: {
                options: [
                    { id: 'a', label: 'A', color: 'red' },
                    { id: 'a', label: 'B', color: 'blue' },
                ],
            },
        };
        expect(fieldSettingsRequest.safeParse(twice).success).toBe(false);
        expect(fieldSettingsRequest.safeParse({ ...base, settings: { currency: 'usd' } }).success).toBe(false);
        expect(fieldSettingsRequest.safeParse({ ...base, settings: { dateFormat: 'week' } }).success).toBe(false);
        expect(fieldSettingsRequest.safeParse({ ...base, settings: {}, confirmRemovedOptions: false }).success).toBe(
            false,
        );
    });

    it('drops settings keys a newer client adds instead of refusing them', () => {
        const parsed = fieldSettingsRequest.parse({
            schema: 1,
            kind: 'number',
            baseVersion: 1,
            settings: { decimals: 2, spark: true },
        });
        expect(parsed.settings).toEqual({ decimals: 2 });
    });
});

describe('people for person fields', () => {
    it('lists only active people to pick, and names deactivated ones by id', () => {
        const directory = WRITE_FIXTURES.peopleDirectory[0];
        const lookup = WRITE_FIXTURES.peopleLookup[0];
        expect(directory.people.map((p) => p.id)).toEqual(['u_ada']);
        expect(lookup.users.u_bo).toEqual({ name: 'Bo', avatar: null, active: false });
        expect(PEOPLE_DIRECTORY_PATH).toBe('/api/people');
        expect(PEOPLE_LOOKUP_PATH).toBe('/api/people/lookup');
    });

    it('looks up at most 500 ids', () => {
        const ids = Array.from({ length: VIEW_WRITE_LIMITS.lookupPeople + 1 }, (_, i) => `u_${i}`);
        expect(peopleLookupRequest.safeParse({ schema: 1, ids }).success).toBe(false);
        expect(peopleLookupRequest.safeParse({ schema: 1, ids: [] }).success).toBe(false);
    });
});

describe('routes', () => {
    const routes = viewRoutes('ds_acme', 'tasks');

    it('builds every path under the table, the files under the dataset', () => {
        expect(routes.views).toBe('/api/data/datasets/ds_acme/tables/tasks/views');
        expect(routes.draft('default')).toBe('/api/data/datasets/ds_acme/tables/tasks/views/default/draft');
        expect(routes.exportCsv('v_acme_open')).toBe(
            '/api/data/datasets/ds_acme/tables/tasks/views/v_acme_open/export.csv',
        );
        expect(routes.rows).toBe('/api/data/datasets/ds_acme/tables/tasks/rows');
        expect(routes.fields).toBe('/api/data/datasets/ds_acme/tables/tasks/fields');
        expect(routes.field('due date')).toBe('/api/data/datasets/ds_acme/tables/tasks/fields/due%20date');
        expect(routes.files).toBe('/api/data/datasets/ds_acme/files');
        expect(routes.file('f_acme_1', { thumb: true })).toBe('/api/data/datasets/ds_acme/files/f_acme_1?thumb=1');
        expect(routes.file('f_acme_1')).toBe('/api/data/datasets/ds_acme/files/f_acme_1');
    });

    it('encodes a row key, so no key reads as lookup', () => {
        expect(routes.row(rowKey('lookup'))).toBe('/api/data/datasets/ds_acme/tables/tasks/rows/%22lookup%22');
        expect(routes.row(rowKey([1, 'a/b']))).toBe(
            '/api/data/datasets/ds_acme/tables/tasks/rows/%5B1%2C%22a%2Fb%22%5D',
        );
        expect(decodeURIComponent(routes.row('1042').split('/').pop()!)).toBe('1042');
    });

    it('writes and reads the export query', () => {
        expect(viewExportSearch({ schema: 1 })).toBe('schema=1');
        expect(viewExportSearch({ schema: 1, useDraft: false })).toBe('schema=1&useDraft=false');
        const query = Object.fromEntries(new URLSearchParams(viewExportSearch({ schema: 1, useDraft: true })));
        expect(viewExportQuery.parse(query)).toEqual({ schema: 1, useDraft: 'true' });
        expect(viewExportQuery.safeParse({ schema: '0' }).success).toBe(false);
    });
});

describe('request types', () => {
    it('keep their properties for the clients that build them', () => {
        expectTypeOf<ViewDraftRequest['definition']['name']>().toEqualTypeOf<string>();
        expectTypeOf<ViewSaveRequest['definition']['version']>().toEqualTypeOf<number>();
        expectTypeOf<ViewCreateRequest['definition']>().toEqualTypeOf<NewViewDefinition>();
        expectTypeOf<NewViewDefinition['name']>().toEqualTypeOf<string>();
        expectTypeOf<CellEditRequest['from']>().toEqualTypeOf<JsonValue>();
        expectTypeOf<CellEditRequest['to']>().toEqualTypeOf<
            string | number | boolean | null | Array<string | number>
        >();
        // @ts-expect-error A new view's definition needs its name, layout, query, fields and the rest.
        const missing: ViewCreateRequest = { schema: 1, definition: {} };
        expect(missing).toBeDefined();
    });
});
