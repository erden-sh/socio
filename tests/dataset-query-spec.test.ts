import { describe, expect, it } from 'vitest';

import type { ColumnInfo, TableInfo } from '@socio/shared/data-types';
import {
    baseColumnType,
    FIELD_KINDS,
    inferFieldKind,
    kindFitsColumn,
    type FieldKind,
    type FieldSetting,
} from '@socio/shared/dataset-query/kinds';
import { FILTER_OPS, OP_VALUE_SHAPE, operatorsFor, type FilterOp } from '@socio/shared/dataset-query/operators';
import { isCalendarDate, isIsoDateTime, QUERY_SPEC_LIMITS, specPath } from '@socio/shared/dataset-query/spec';

import { checkSpec, specFields } from '../src/server/dataspace/query-spec/check.js';

const col = (name: string, type: string, primaryKey = false): ColumnInfo => ({
    name,
    type,
    notNull: false,
    primaryKey,
    defaultValue: null,
});

// One column per field kind (settings give the kinds types alone can't).
const table: TableInfo = {
    name: 'bookings',
    rowCount: 0,
    columns: [
        col('id', 'TEXT', true),
        col('title', 'TEXT'),
        col('notes', 'TEXT'),
        col('amount', 'REAL'),
        col('price_cents', 'INTEGER'),
        col('fee_eur', 'REAL'),
        col('total_usd', 'REAL'),
        col('rate', 'REAL'),
        col('paid', 'BOOLEAN'),
        col('due', 'TEXT'),
        col('event_on', 'DATE'),
        col('inferred_on', 'DATE'),
        col('starts_at', 'DATETIME'),
        col('status', 'TEXT'),
        col('tags', 'JSON'),
        col('owner', 'TEXT'),
        col('team', 'JSON'),
        col('photo', 'TEXT'),
        col('site', 'TEXT'),
        col('mail', 'TEXT'),
        col('phone', 'TEXT'),
        col('meta', 'JSON'),
        col('raw', 'BLOB'),
        col('bad name', 'TEXT'),
    ],
};
const settings: FieldSetting[] = [
    { column: 'notes', kind: 'long_text' },
    { column: 'price_cents', kind: 'currency', settings: { currency: 'usd', minorUnits: true } },
    { column: 'fee_eur', kind: 'currency', settings: { currency: 'EUR' } },
    { column: 'total_usd', kind: 'currency', settings: { currency: 'USD' } },
    { column: 'rate', kind: 'percent' },
    { column: 'due', kind: 'date' },
    {
        column: 'status',
        kind: 'select',
        settings: {
            options: [
                { id: 'open', label: 'Open' },
                { id: 'booked', label: 'Booked' },
                { id: 'closed', label: 'Closed' },
            ],
        },
    },
    {
        column: 'tags',
        kind: 'multi_select',
        settings: {
            options: [
                { id: 'a', label: 'A' },
                { id: 'b', label: 'B' },
            ],
        },
    },
    { column: 'owner', kind: 'person' },
    { column: 'team', kind: 'people' },
    { column: 'photo', kind: 'file' },
    { column: 'site', kind: 'url' },
    { column: 'mail', kind: 'email' },
    { column: 'phone', kind: 'phone' },
];
const source = { dataset: 'ds_1', table: 'bookings' };
const check = (spec: Record<string, unknown>, extra: { params?: string[]; table?: TableInfo } = {}) =>
    checkSpec({ source, ...spec }, { table: extra.table ?? table, settings, params: extra.params });
const ok = (spec: Record<string, unknown>, extra?: { params?: string[]; table?: TableInfo }) => {
    const result = check(spec, extra);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    return result;
};
/** The spec is refused with a problem at `path` whose message contains `text`. */
const refused = (
    spec: Record<string, unknown>,
    path: string,
    text: string | RegExp = '',
    extra?: { params?: string[]; table?: TableInfo },
) => {
    const result = check(spec, extra);
    expect(result.ok).toBe(false);
    // At the path, or (for a shape problem) inside it.
    const at = result.problems.filter(
        (p) => p.path === path || p.path.startsWith(`${path}.`) || p.path.startsWith(`${path}[`),
    );
    expect(at, JSON.stringify(result.problems)).not.toEqual([]);
    expect(at.map((p) => p.message)).toContainEqual(
        typeof text === 'string' ? expect.stringContaining(text) : expect.stringMatching(text),
    );
    return result;
};

/** The field of each kind in the fixture. */
const FIELD_OF: Record<FieldKind, string> = {
    text: 'title',
    long_text: 'notes',
    number: 'amount',
    currency: 'price_cents',
    percent: 'rate',
    checkbox: 'paid',
    date: 'due',
    datetime: 'starts_at',
    select: 'status',
    multi_select: 'tags',
    person: 'owner',
    people: 'team',
    file: 'photo',
    url: 'site',
    email: 'mail',
    phone: 'phone',
    json: 'meta',
    id: 'id',
    blob: 'raw',
};
/** A valid single value for each kind. */
const ONE: Record<FieldKind, unknown> = {
    text: 'x',
    long_text: 'x',
    number: 5,
    currency: 500,
    percent: 0.5,
    checkbox: true,
    date: '2026-11-20',
    datetime: '2026-11-20T10:00:00Z',
    select: 'open',
    multi_select: 'a',
    person: 'alice',
    people: 'alice',
    file: 'f',
    url: 'https://example.com',
    email: 'a@example.com',
    phone: '+1 555',
    json: '{}',
    id: 'row-1',
    blob: 'x',
};
const PAIR: Partial<Record<FieldKind, unknown[]>> = {
    number: [1, 10],
    currency: [100, 1000],
    percent: [0.1, 0.9],
    date: ['2026-01-01', '2026-12-31'],
    datetime: ['2026-01-01', '2026-12-31T23:59:59Z'],
};
const validValue = (kind: FieldKind, op: FilterOp) => {
    switch (OP_VALUE_SHAPE[op]) {
        case 'none':
            return undefined;
        case 'one':
            return ONE[kind];
        case 'pair':
            return PAIR[kind];
        case 'list':
            return [ONE[kind]];
        case 'range':
            return { relative: 'past', count: 7, unit: 'day' };
    }
};

describe('field kinds', () => {
    it('infers a kind from each column type, and id from a primary key', () => {
        const cases: Array<[string, FieldKind]> = [
            ['TEXT', 'text'],
            ['INTEGER', 'number'],
            ['REAL', 'number'],
            ['NUMERIC', 'number'],
            ['DECIMAL(12,2)', 'number'],
            ['BOOLEAN', 'checkbox'],
            ['DATETIME', 'datetime'],
            ['TIMESTAMP', 'datetime'],
            ['DATE', 'date'],
            ['JSON', 'json'],
            ['BLOB', 'blob'],
            // Types a table made with SQL may have, by SQLite's affinity rules.
            ['VARCHAR(20)', 'text'],
            ['BIGINT', 'number'],
            ['DOUBLE PRECISION', 'number'],
            ['', 'blob'],
            ['whatever', 'number'],
        ];
        for (const [type, kind] of cases) {
            expect(inferFieldKind({ type }), type).toBe(kind);
        }
        expect(inferFieldKind({ type: 'INTEGER', primaryKey: true })).toBe('id');
        // Never person or select: only a setting says so.
        expect(FIELD_KINDS.filter((k) => ['person', 'select'].includes(k))).toHaveLength(2);
        expect(baseColumnType(' decimal(5, 2) ')).toBe('DECIMAL');
    });

    it('fits kinds to column types as the kind table says', () => {
        expect(kindFitsColumn('currency', { type: 'INTEGER' })).toBe(true);
        expect(kindFitsColumn('currency', { type: 'TEXT' })).toBe(false);
        expect(kindFitsColumn('people', { type: 'JSON' })).toBe(true);
        expect(kindFitsColumn('people', { type: 'TEXT' })).toBe(false);
        expect(kindFitsColumn('id', { type: 'TEXT', primaryKey: true })).toBe(true);
        expect(kindFitsColumn('id', { type: 'TEXT' })).toBe(false);
        expect(kindFitsColumn('date', { type: 'DATE' })).toBe(true);
        expect(kindFitsColumn('percent', { type: 'DECIMAL(5,4)' })).toBe(true);
    });

    it('applies settings that fit and ignores ones that don’t or whose column is gone', () => {
        const fields = specFields(table.columns, [
            ...settings,
            { column: 'title', kind: 'currency', settings: { currency: 'USD' } },
            { column: 'gone', kind: 'select' },
        ]);
        expect(fields.get('title')?.kind).toBe('text');
        expect(fields.get('gone')).toBeUndefined();
        expect(fields.get('price_cents')).toMatchObject({ kind: 'currency', currency: 'USD', minorUnits: true });
        expect(fields.get('bad name')?.nameable).toBe(false);
        // A sum over the misfit "currency" text column is still refused.
        const result = checkSpec(
            { source, measures: [{ name: 'total', op: 'sum', field: 'title' }] },
            { table, settings: [{ column: 'title', kind: 'currency' }] },
        );
        expect(result.problems).toContainEqual({
            path: '$.measures[0].op',
            message: expect.stringContaining('number'),
        });
    });
});

describe('the operator matrix', () => {
    it('takes exactly each kind’s operators, with a value of the kind’s type', () => {
        for (const kind of FIELD_KINDS) {
            const field = FIELD_OF[kind];
            const allowed = operatorsFor(kind, 'text');
            for (const op of FILTER_OPS) {
                const value = validValue(kind, op);
                const filter = { field, op, ...(value === undefined ? {} : { value }) };
                const result = check({ filter });
                if (kind === 'blob') {
                    expect(result.problems, `${kind} ${op}`).toContainEqual({
                        path: '$.filter.field',
                        message: expect.stringContaining('bytes'),
                    });
                } else if (allowed.includes(op)) {
                    expect(result.problems, `${kind} ${op}`).toEqual([]);
                } else {
                    expect(result.problems, `${kind} ${op}`).toContainEqual({
                        path: '$.filter.op',
                        message: expect.stringContaining(field),
                    });
                }
            }
        }
    });

    it('gives an id the operators of its stored type', () => {
        const numeric: TableInfo = { ...table, columns: [col('n', 'INTEGER', true)] };
        expect(checkSpec({ source, filter: { field: 'n', op: 'gt', value: 3 } }, { table: numeric }).ok).toBe(true);
        expect(checkSpec({ source, filter: { field: 'n', op: 'contains', value: '3' } }, { table: numeric }).ok).toBe(
            false,
        );
        ok({ filter: { field: 'id', op: 'starts_with', value: 'row' } });
        refused({ filter: { field: 'id', op: 'gt', value: 3 } }, '$.filter.op');
    });

    it('refuses values of the wrong type for each kind', () => {
        const cases: Array<[Record<string, unknown>, string, string]> = [
            [{ field: 'amount', op: 'eq', value: '5' }, '$.filter.value', 'use a number'],
            [{ field: 'title', op: 'is', value: 5 }, '$.filter.value', 'use a string'],
            [{ field: 'paid', op: 'is', value: 'true' }, '$.filter.value', 'true or false'],
            [{ field: 'due', op: 'is', value: '2026-02-30' }, '$.filter.value', 'YYYY-MM-DD'],
            [{ field: 'due', op: 'is', value: '20/11/2026' }, '$.filter.value', 'YYYY-MM-DD'],
            [{ field: 'due', op: 'is', value: '2026-11-20T10:00:00Z' }, '$.filter.value', 'YYYY-MM-DD'],
            [{ field: 'starts_at', op: 'after', value: '2026-11-20T25:00' }, '$.filter.value', 'ISO date and time'],
            [
                { field: 'starts_at', op: 'after', value: '2026-11-20T10:00+15:00' },
                '$.filter.value',
                'ISO date and time',
            ],
            [{ field: 'status', op: 'is', value: 'Open' }, '$.filter.value', 'Unknown option "Open"'],
            [{ field: 'tags', op: 'has_any_of', value: ['a', 'z'] }, '$.filter.value[1]', 'Unknown option "z"'],
            [{ field: 'title', op: 'is', value: { $me: true } }, '$.filter.value', '$me is a person'],
            [
                { field: 'due', op: 'is', value: { relative: 'past', count: 3, unit: 'day' } },
                '$.filter.value',
                'within',
            ],
            [{ field: 'amount', op: 'eq', value: { period: 'this_month' } }, '$.filter.value', 'only date fields'],
            [{ field: 'due', op: 'within', value: '2026-11-20' }, '$.filter.value', 'relative date'],
            [{ field: 'amount', op: 'between', value: [10, 1] }, '$.filter.value', 'smaller value'],
            [{ field: 'due', op: 'between', value: ['2026-12-01', '2026-01-01'] }, '$.filter.value', 'smaller value'],
            [{ field: 'amount', op: 'between', value: [1, 2, 3] }, '$.filter.value', 'two values'],
            [{ field: 'amount', op: 'between', value: 1 }, '$.filter.value', 'two values'],
            [{ field: 'status', op: 'is_any_of', value: [] }, '$.filter.value', 'list of values'],
            [{ field: 'status', op: 'is_any_of', value: 'open' }, '$.filter.value', 'list of values'],
            [{ field: 'status', op: 'is', value: ['open'] }, '$.filter.value', 'one value'],
            [{ field: 'price_cents', op: 'gte', value: 9.99 }, '$.filter.value', 'whole number'],
            [{ field: 'title', op: 'contains', value: '' }, '$.filter.value', 'is_empty'],
            [{ field: 'title', op: 'is_empty', value: 'x' }, '$.filter.value', 'takes no value'],
            [{ field: 'title', op: 'is' }, '$.filter.value', 'one value'],
            [{ field: 'owner', op: 'is', value: '' }, '$.filter.value', 'user ids'],
        ];
        for (const [filter, path, text] of cases) {
            refused({ filter }, path, text);
        }
    });

    it('takes the viewer, today, relative dates and periods where they fit', () => {
        ok({ filter: { field: 'owner', op: 'is', value: { $me: true } } });
        ok({ filter: { field: 'team', op: 'has_any_of', value: [{ $me: true }, 'bob'] } });
        ok({ filter: { field: 'due', op: 'on_or_after', value: 'today' } });
        ok({ filter: { field: 'starts_at', op: 'between', value: ['today', '2027-01-01'] } });
        ok({ filter: { field: 'starts_at', op: 'within', value: { relative: 'next', count: 30, unit: 'day' } } });
        ok({ filter: { field: 'due', op: 'within', value: { period: 'previous_quarter' } } });
        ok({ filter: { field: 'starts_at', op: 'before', value: '2026-11-20T10:00' } });
        ok({ filter: { field: 'starts_at', op: 'before', value: '2026-11-20 10:00:00.5-03:00' } });
        // "today" is only a token where a date goes; elsewhere it is text.
        ok({ filter: { field: 'title', op: 'is', value: 'today' } });
        refused({ filter: { field: 'amount', op: 'eq', value: 'today' } }, '$.filter.value', 'number');
        refused(
            { filter: { field: 'due', op: 'within', value: { relative: 'past', count: 0, unit: 'day' } } },
            '$.filter.value',
        );
        refused(
            { filter: { field: 'due', op: 'within', value: { relative: 'ago', count: 3, unit: 'day' } } },
            '$.filter.value',
        );
    });

    it('takes dashboard parameters only where the dashboard declares them', () => {
        const filter = { field: 'amount', op: 'gte', value: { $param: 'floor' } };
        refused({ filter }, '$.filter.value', 'belong to dashboards');
        ok({ filter }, { params: ['floor'] });
        refused({ filter }, '$.filter.value', 'Unknown parameter "floor"; this dashboard has min', { params: ['min'] });
        ok({ filter: { field: 'status', op: 'is_any_of', value: { $param: 'states' } } }, { params: ['states'] });
        ok({ filter: { field: 'due', op: 'within', value: { $param: 'period' } } }, { params: ['period'] });
    });
});

describe('injection attempts', () => {
    it('never takes a field that isn’t one of the table’s own, nameable columns', () => {
        const names = [
            'amount"; DROP TABLE bookings; --',
            'amount) OR 1=1 --',
            '"amount"',
            'Amount',
            'sqlite_master',
            '_history_bookings',
            '__proto__',
            'constructor',
            'toString',
            'amount\u0000',
        ];
        for (const name of names) {
            refused({ filter: { field: name, op: 'is_empty' } }, '$.filter.field', 'Unknown field');
            refused({ sort: [{ field: name }] }, '$.sort[0].field', 'Unknown field');
            refused({ groupBy: [{ field: name }] }, '$.groupBy[0].field', 'Unknown field');
            refused({ time: { field: name, bucket: 'month' } }, '$.time.field', 'Unknown field');
            refused({ measures: [{ name: 'm', op: 'sum', field: name }] }, '$.measures[0].field', 'Unknown field');
        }
        // A real column whose name identifier() refuses can't be queried either.
        refused({ filter: { field: 'bad name', op: 'is_empty' } }, '$.filter.field', 'can’t be queried');
    });

    it('takes SQL in values as plain values, bound later as parameters', () => {
        ok({ filter: { field: 'title', op: 'contains', value: "' OR 1=1 --" } });
        ok({ filter: { field: 'title', op: 'is', value: 'x"); DROP TABLE bookings; --' } });
        ok({ filter: { field: 'title', op: 'starts_with', value: '%_' } });
        ok({
            segments: {
                name: 'kind',
                rules: [{ label: "'; DROP TABLE x; --", when: { field: 'title', op: 'contains', value: 'x' } }],
                other: 'Other',
            },
            groupBy: [{ segment: 'kind' }],
        });
    });

    it('refuses names that aren’t plain identifiers, and keys the spec doesn’t have', () => {
        refused({ measures: [{ name: 'x"; DROP', op: 'count' }] }, '$.measures[0].name', 'letters, digits');
        refused(
            {
                measures: [
                    { name: 'n', op: 'count' },
                    { name: 'd', expr: { add: ['n', 'n) --'] } },
                ],
            },
            '$.measures[1].expr',
        );
        refused({ filter: { field: 'amount', op: 'gte', value: { $param: "p'; --" } } }, '$.filter.value');
        refused({ sql: 'SELECT * FROM bookings' }, '$', 'Unrecognized key');
        refused({ filter: { field: 'title', op: 'is', value: 'x', sql: '1=1' } }, '$.filter', 'Unrecognized key');
        refused({ filter: { field: 'title', op: 'raw', value: 'x' } }, '$.filter.op');
        refused({ filter: { field: 'title', op: 'is', value: { $me: false } } }, '$.filter.value');
        refused({ sort: [{ field: 'title', dir: 'asc; DROP' }] }, '$.sort[0].dir');
        refused({ groupBy: [{ field: 'due', bucket: 'month); --' }] }, '$.groupBy[0].bucket');
        refused({ timeZone: "UTC'; --" }, '$.timeZone', 'IANA');
        const notObject = checkSpec('SELECT 1', { table });
        expect(notObject.ok).toBe(false);
        expect(notObject.problems[0].path).toBe('$');
    });
});

describe('limits', () => {
    const conditions = (n: number) => Array.from({ length: n }, () => ({ field: 'amount', op: 'gt', value: 1 }));

    it('nests filters at most two levels and counts conditions per filter', () => {
        ok({ filter: { all: [{ any: conditions(2) }, { field: 'title', op: 'is_empty' }] } });
        refused({ filter: { all: [{ any: [{ all: conditions(1) }] }] } }, '$.filter.all[0].any[0]', 'at most 2 levels');
        ok({ filter: { all: [{ any: conditions(25) }, { any: conditions(25) }] } });
        refused({ filter: { all: [{ any: conditions(25) }, { any: conditions(26) }] } }, '$.filter', '51 conditions');
        refused({ filter: { all: conditions(51) } }, '$.filter.all');
        refused({ filter: { all: [] } }, '$.filter.all');
    });

    it('caps lists, text, sorts, groupings, measures, rules, windows and fallbacks', () => {
        refused({ filter: { field: 'status', op: 'is_any_of', value: Array(101).fill('open') } }, '$.filter.value');
        refused({ filter: { field: 'title', op: 'is', value: 'x'.repeat(1001) } }, '$.filter.value');
        ok({ filter: { field: 'title', op: 'is', value: 'x'.repeat(1000) } });
        const sorts = ['title', 'amount', 'due', 'paid', 'owner', 'site'].map((field) => ({ field }));
        ok({ sort: sorts.slice(0, 5) });
        refused({ sort: sorts }, '$.sort');
        const groups = [{ field: 'status' }, { field: 'owner' }, { field: 'paid' }, { field: 'title' }];
        ok({ groupBy: groups.slice(0, 2) });
        refused({ groupBy: groups.slice(0, 3) }, '$.groupBy', 'A view groups by at most 2');
        ok({ groupBy: groups.slice(0, 3), measures: [{ name: 'n', op: 'count' }] });
        refused({ groupBy: groups, measures: [{ name: 'n', op: 'count' }] }, '$.groupBy');
        const measures = Array.from({ length: 21 }, (_, i) => ({ name: `m${i}`, op: 'count' }));
        ok({ measures: measures.slice(0, 20) });
        refused({ measures }, '$.measures');
        const rules = (n: number) =>
            Array.from({ length: n }, (_, i) => ({
                label: `r${i}`,
                when: { field: 'title', op: 'contains', value: `${i}` },
            }));
        ok({ segments: { name: 's', rules: rules(50), other: 'Other' } });
        refused({ segments: { name: 's', rules: rules(51), other: 'Other' } }, '$.segments.rules');
        const time = { field: 'due' };
        const measure = [{ name: 'n', op: 'count' }];
        ok({ time, measures: measure, windows: ['ytd', 'previous_year', 'this_month', 'previous_month'] });
        refused(
            {
                time,
                measures: measure,
                windows: ['ytd', 'previous_year', 'this_month', 'previous_month', 'trailing_12_months'],
            },
            '$.windows',
        );
        refused(
            { time: { field: { coalesce: ['due', 'event_on', 'inferred_on', 'starts_at', 'due'] } } },
            '$.time.field',
        );
    });

    it('caps conditions and values across the whole spec, so it stays one bindable statement', () => {
        // 50 rules of 11 conditions each: every filter is within its own limit.
        const rule = (i: number) => ({ label: `r${i}`, when: { all: conditions(11) } });
        refused(
            { segments: { name: 's', rules: Array.from({ length: 50 }, (_, i) => rule(i)), other: 'Other' } },
            '$',
            '550 conditions',
        );
        // 50 conditions of 100 values is the most one filter holds; one more value is too many.
        const wide = Array.from({ length: 50 }, () => ({
            field: 'status',
            op: 'is_any_of',
            value: Array(100).fill('open'),
        }));
        ok({ filter: { all: wide } });
        refused(
            {
                filter: { all: wide },
                measures: [{ name: 'n', op: 'count', where: { field: 'amount', op: 'gt', value: 1 } }],
            },
            '$',
            '5001 values',
        );
    });

    it('caps derived measures’ terms and nesting', () => {
        const base = [{ name: 'a', op: 'count' }];
        const add = (n: number) => ({ add: Array(n).fill('a') });
        // Operators count as terms: 1 + (1 + 9) + (1 + 8) is 20.
        ok({ measures: [...base, { name: 'd', expr: { add: [add(9), add(8)] } }] });
        refused(
            { measures: [...base, { name: 'd', expr: { add: [add(10), add(9)] } }] },
            '$.measures[1].expr',
            'at most 20 terms',
        );
        ok({ measures: [...base, { name: 'd', expr: { add: [{ sub: [{ mul: ['a', 2] }, 1] }, 3] } }] });
        refused(
            {
                measures: [
                    ...base,
                    { name: 'd', expr: { add: [{ sub: [{ mul: [{ div: [{ add: ['a', 1] }, 2] }, 2] }, 1] }, 3] } },
                ],
            },
            '$.measures[1].expr.add[0].sub[0].mul[0].div[0]',
            'at most 4 levels',
        );
    });

    it('exports the limits the proposal states', () => {
        expect(QUERY_SPEC_LIMITS).toMatchObject({
            filterDepth: 2,
            filterConditions: 50,
            sorts: 5,
            viewGroups: 2,
            aggregateGroups: 3,
            segmentRules: 50,
        });
    });
});

describe('measures', () => {
    it('fits each base measure to its field’s kind', () => {
        ok({ measures: [{ name: 'n', op: 'count' }] });
        ok({ measures: [{ name: 'n', op: 'count', field: 'owner' }] });
        ok({ measures: [{ name: 'n', op: 'count_distinct', field: 'owner' }] });
        ok({ measures: [{ name: 's', op: 'sum', field: 'price_cents' }] });
        ok({ measures: [{ name: 'a', op: 'avg', field: 'rate' }] });
        ok({ measures: [{ name: 'first', op: 'min', field: 'starts_at' }] });
        ok({ measures: [{ name: 'last', op: 'max', field: 'due' }] });
        refused({ measures: [{ name: 's', op: 'sum', field: 'title' }] }, '$.measures[0].op', 'needs a number');
        refused({ measures: [{ name: 'a', op: 'avg', field: 'due' }] }, '$.measures[0].op');
        refused({ measures: [{ name: 'm', op: 'max', field: 'status' }] }, '$.measures[0].op');
        refused({ measures: [{ name: 'c', op: 'count_distinct' }] }, '$.measures[0].field', 'needs a field');
        refused({ measures: [{ name: 's', op: 'sum' }] }, '$.measures[0].field', 'needs a field');
        refused({ measures: [{ name: 'c', op: 'count_distinct', field: 'meta' }] }, '$.measures[0].op');
        refused({ measures: [{ name: 'c', op: 'median', field: 'amount' }] }, '$.measures[0]');
    });

    it('checks filtered measures, names and references', () => {
        ok({
            measures: [
                { name: 'gross', op: 'sum', field: 'amount', where: { field: 'status', op: 'is', value: 'booked' } },
                { name: 'refunds', op: 'sum', field: 'amount', where: { field: 'status', op: 'is', value: 'closed' } },
                { name: 'net', expr: { sub: ['gross', 'refunds'] } },
                { name: 'share', expr: { div: ['net', 'gross'] } },
            ],
        });
        refused(
            {
                measures: [
                    { name: 'g', op: 'sum', field: 'amount', where: { field: 'status', op: 'is', value: 'nope' } },
                ],
            },
            '$.measures[0].where.value',
            'Unknown option',
        );
        refused(
            {
                measures: [
                    { name: 'n', op: 'count' },
                    { name: 'n', op: 'count' },
                ],
            },
            '$.measures[1].name',
            'twice',
        );
        refused(
            { measures: [{ name: 'd', expr: { add: ['nope', 1] } }] },
            '$.measures[0].expr.add[0]',
            'Unknown measure',
        );
        refused({ measures: [{ name: 'd', expr: { add: ['d', 1] } }] }, '$.measures[0].expr.add[0]', 'itself');
        refused(
            {
                measures: [
                    { name: 'a', expr: { add: ['b', 1] } },
                    { name: 'b', expr: { add: ['a', 1] } },
                ],
            },
            '$.measures[0]',
            'depends on itself',
        );
        refused(
            { groupBy: [{ field: 'status' }], measures: [{ name: 'status', op: 'count' }] },
            '$.measures[0].name',
            'already a grouping',
        );
        refused({ measures: [{ name: 'd', expr: { sub: ['a'] } }] }, '$.measures[0].expr');
        refused({ measures: [{ name: 'd', expr: { pow: ['a', 2] } }] }, '$.measures[0].expr');
    });

    it('refuses mixing currencies, or minor and major units, in one measure', () => {
        const base = [
            { name: 'usd_cents', op: 'sum', field: 'price_cents' },
            { name: 'usd', op: 'sum', field: 'total_usd' },
            { name: 'eur', op: 'sum', field: 'fee_eur' },
            { name: 'usd2', op: 'avg', field: 'total_usd' },
        ];
        refused(
            { measures: [...base, { name: 'x', expr: { add: ['usd', 'eur'] } }] },
            '$.measures[4].expr',
            'mixes EUR, USD',
        );
        refused(
            { measures: [...base, { name: 'x', expr: { sub: ['usd', 'usd_cents'] } }] },
            '$.measures[4].expr',
            'minor units',
        );
        // Through another derived measure as well.
        refused(
            {
                measures: [
                    ...base,
                    { name: 'x', expr: { mul: ['usd', 2] } },
                    { name: 'y', expr: { add: ['x', 'eur'] } },
                ],
            },
            '$.measures[5].expr',
            'mixes',
        );
        ok({ measures: [...base, { name: 'x', expr: { add: ['usd', 'usd2', 10] } }] });
        ok({
            measures: [
                ...base,
                { name: 'n', op: 'count', field: 'fee_eur' },
                { name: 'x', expr: { div: ['usd', 'n'] } },
            ],
        });
    });

    it('checks running values: what they sum, their order and where they start', () => {
        const time = { field: 'due', bucket: 'month' };
        ok({
            time,
            window: 'trailing_12_months',
            measures: [
                { name: 'in', op: 'sum', field: 'amount', where: { field: 'paid', op: 'is', value: true } },
                { name: 'out', op: 'sum', field: 'amount', where: { field: 'paid', op: 'is', value: false } },
                { name: 'running_in', running: { of: 'in' } },
                { name: 'running_out', running: { of: 'out', from: 'all' } },
                { name: 'balance', expr: { sub: ['running_in', 'running_out'] } },
                { name: 'since', running: { of: 'in', from: '2025-06-01' } },
                { name: 'shown', running: { of: 'in', from: 'window' } },
            ],
        });
        const measures = (running: Record<string, unknown>) => [
            { name: 'n', op: 'count' },
            { name: 'r', running },
        ];
        refused({ measures: measures({ of: 'n' }) }, '$.measures[1].running', 'needs an order');
        ok({ groupBy: [{ field: 'status' }], measures: measures({ of: 'n', order: 'status' }) });
        refused(
            { groupBy: [{ field: 'status' }], measures: measures({ of: 'n', order: 'owner' }) },
            '$.measures[1].running.order',
        );
        refused({ time, measures: measures({ of: 'nope' }) }, '$.measures[1].running.of', 'Unknown measure');
        refused(
            { time, measures: measures({ of: 'n', from: 'window' }) },
            '$.measures[1].running.from',
            'display window',
        );
        refused({ time, measures: measures({ of: 'n', from: '2025-02-30' }) }, '$.measures[1].running.from');
        refused({ time, measures: measures({ of: 'n', from: 'yesterday' }) }, '$.measures[1].running.from');
        refused(
            { time, measures: [...measures({ of: 'n' }), { name: 'rr', running: { of: 'r' } }] },
            '$.measures[2].running.of',
            'not another running value',
        );
        refused(
            {
                time,
                measures: [
                    ...measures({ of: 'n' }),
                    { name: 'd', expr: { mul: ['r', 2] } },
                    { name: 'rr', running: { of: 'd' } },
                ],
            },
            '$.measures[3].running.of',
            'not another running value',
        );
    });
});

describe('time, windows and time zones', () => {
    const measures = [{ name: 'n', op: 'count' }];

    it('takes a date or date-and-time field, or a fallback of the same kind', () => {
        ok({ time: { field: 'due', bucket: 'month' }, measures });
        ok({ time: { field: 'starts_at', bucket: 'week' }, measures });
        ok({ time: { field: { coalesce: ['event_on', 'inferred_on'] }, bucket: 'month' }, measures });
        refused({ time: { field: 'amount' } }, '$.time.field', 'date or date and time');
        refused({ time: { field: { coalesce: ['event_on', 'starts_at'] } } }, '$.time.field.coalesce', 'all dates');
        refused({ time: { field: { coalesce: ['event_on', 'event_on'] } } }, '$.time.field.coalesce[1]', 'twice');
        refused({ time: { field: { coalesce: ['event_on'] } } }, '$.time.field.coalesce');
        refused({ time: { field: 'due', bucket: 'fortnight' } }, '$.time.bucket');
    });

    it('needs a date for windows, and checks fixed ones', () => {
        refused({ window: 'ytd', measures }, '$.window', 'time.field');
        ok({ time: { field: 'due', bucket: 'month' }, window: { between: ['2026-01-01', '2026-03-31'] }, measures });
        ok({ time: { field: 'due' }, window: { last_n: { count: 30, unit: 'day' } } });
        refused(
            { time: { field: 'due' }, window: { between: ['2026-03-31', '2026-01-01'] } },
            '$.window.between',
            'first date',
        );
        refused({ time: { field: 'due' }, window: { between: ['2026-13-01', '2026-12-31'] } }, '$.window.between[0]');
        refused({ time: { field: 'due' }, window: 'last_week' }, '$.window');
        refused({ time: { field: 'due' }, window: { last_n: { count: 0, unit: 'day' } } }, '$.window.last_n.count');
        // Comparison windows: a column per window, or with a bucket a series per window ("this year vs last year, by month").
        ok({ time: { field: 'due' }, windows: ['ytd', 'previous_year'], measures });
        ok({ time: { field: 'due', bucket: 'month' }, windows: ['ytd', 'previous_year'], measures });
        refused({ time: { field: 'due' }, windows: ['ytd'] }, '$.windows', 'measures');
        refused(
            { time: { field: 'due', bucket: 'month' }, window: 'ytd', windows: ['previous_year'], measures },
            '$.window',
            'not both',
        );
        ok({
            time: { field: 'due', bucket: 'month' },
            windows: ['ytd', 'previous_year'],
            measures: [...measures, { name: 'cum', running: { of: measures[0].name, from: 'window' } }],
        });
        refused({ time: { field: 'due' }, windows: ['ytd', 'ytd'], measures }, '$.windows[1]', 'twice');
    });

    it('refuses what the compiler couldn’t name or order (build step 5)', () => {
        refused(
            { time: { field: 'due', bucket: 'month' }, groupBy: [{ field: 'due' }], measures },
            '$.groupBy[0].field',
            'already the time bucket',
        );
        refused(
            {
                segments: {
                    name: 'status',
                    rules: [{ label: 'A', when: { field: 'status', op: 'is_empty' } }],
                    other: 'B',
                },
            },
            '$.segments.name',
            'a field of this table',
        );
        refused(
            { time: { field: 'due' }, measures: [...measures, { name: 'cum', running: { of: 'n', order: 'due' } }] },
            '$.measures[1].running.order',
            'needs time.bucket',
        );
    });

    it('takes IANA time zones only', () => {
        for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'america/new_york', 'Etc/GMT+5']) {
            ok({ timeZone: zone });
        }
        for (const zone of ['Mars/Olympus', '+05:00', 'GMT+5:30', 'America/New York', '']) {
            const result = check({ timeZone: zone });
            expect(result.ok, zone).toBe(false);
            expect(result.problems[0].path, zone).toBe('$.timeZone');
        }
    });
});

describe('grouping, sorting, segments and totals', () => {
    it('groups on groupable kinds, with buckets that fit', () => {
        ok({ groupBy: [{ field: 'status' }, { field: 'due', bucket: 'month' }] });
        ok({ groupBy: [{ field: 'amount', bucket: { step: 100 } }], measures: [{ name: 'n', op: 'count' }] });
        refused({ groupBy: [{ field: 'title', bucket: 'month' }] }, '$.groupBy[0].bucket', 'date fields');
        refused({ groupBy: [{ field: 'due', bucket: { step: 7 } }] }, '$.groupBy[0].bucket', 'number fields');
        refused({ groupBy: [{ field: 'amount', bucket: { step: 0 } }] }, '$.groupBy[0].bucket');
        for (const field of ['meta', 'tags', 'team', 'photo', 'notes']) {
            refused({ groupBy: [{ field }] }, '$.groupBy[0].field', 'can’t be grouped on');
        }
        refused({ groupBy: [{ field: 'status' }, { field: 'status' }] }, '$.groupBy[1]', 'twice');
        refused({ groupBy: [{ segment: 'nope' }] }, '$.groupBy[0].segment', 'Unknown segment');
    });

    it('sorts a view by its columns and an aggregate by its outputs', () => {
        ok({ sort: [{ field: 'due', dir: 'desc', empty: 'last' }, { field: 'notes' }] });
        ok({ groupBy: [{ field: 'status' }], sort: [{ field: 'amount' }] });
        refused({ sort: [{ field: 'meta' }] }, '$.sort[0].field', 'can’t be sorted on');
        refused({ sort: [{ field: 'due' }, { field: 'due', dir: 'desc' }] }, '$.sort[1].field', 'twice');
        const aggregate = { groupBy: [{ field: 'status' }], measures: [{ name: 'n', op: 'count' }] };
        ok({ ...aggregate, sort: [{ field: 'n', dir: 'desc' }, { field: 'status' }] });
        refused({ ...aggregate, sort: [{ field: 'amount' }] }, '$.sort[0].field', 'grouping or a measure');
        ok({
            time: { field: 'due', bucket: 'month' },
            measures: [{ name: 'n', op: 'count' }],
            sort: [{ field: 'due' }],
        });
    });

    it('checks segments: their rules, unique labels and a required other', () => {
        const segment = {
            name: 'category',
            field: 'title',
            rules: [
                { label: 'Memberships', when: { field: 'title', op: 'contains', value: 'membership' } },
                {
                    label: 'Events',
                    when: {
                        any: [
                            { field: 'title', op: 'contains', value: 'event' },
                            { field: 'status', op: 'is', value: 'booked' },
                        ],
                    },
                },
            ],
            other: 'Other',
        };
        ok({ segments: segment, groupBy: [{ segment: 'category' }], measures: [{ name: 'n', op: 'count' }] });
        ok({ segments: [segment, { ...segment, name: 'again' }], groupBy: [{ segment: 'again' }] });
        refused({ segments: { ...segment, other: undefined } }, '$.segments.other');
        refused({ segments: { ...segment, other: '  ' } }, '$.segments.other');
        refused({ segments: { ...segment, other: 'Events' } }, '$.segments.other', 'differ');
        refused(
            { segments: { ...segment, rules: [segment.rules[0], segment.rules[0]] } },
            '$.segments.rules[1].label',
            'earlier rule',
        );
        refused(
            { segments: { ...segment, rules: [{ label: 'X', when: { field: 'nope', op: 'is_empty' } }] } },
            '$.segments.rules[0].when.field',
            'Unknown field',
        );
        refused({ segments: [segment, segment] }, '$.segments[1].name', 'twice');
        refused({ segments: { ...segment, field: 'nope' } }, '$.segments.field', 'Unknown field');
        refused(
            { segments: segment, measures: [{ name: 'category', op: 'count' }] },
            '$.measures[0].name',
            'already a grouping',
        );
    });

    it('totals measures or groups, and checks what counts as verified', () => {
        ok({ totals: true, measures: [{ name: 'n', op: 'count' }] });
        ok({ totals: true, groupBy: [{ field: 'status' }] });
        refused({ totals: true }, '$.totals', 'measures or a grouping');
        ok({
            source: { ...source, verified: { field: 'paid', op: 'is', value: true } },
            measures: [
                { name: 's', op: 'sum', field: 'amount', verified: { field: 'status', op: 'is', value: 'closed' } },
            ],
        });
        refused({ source: { ...source, verified: { field: 'nope', op: 'is_empty' } } }, '$.source.verified.field');
        refused(
            { measures: [{ name: 's', op: 'sum', field: 'amount', verified: { field: 'paid', op: 'is', value: 1 } }] },
            '$.measures[0].verified.value',
        );
    });
});

describe('the whole check', () => {
    it('reports every problem at once, each at its JSON path', () => {
        const result = check({
            filter: {
                all: [
                    { field: 'nope', op: 'is_empty' },
                    { field: 'amount', op: 'contains', value: 'x' },
                ],
            },
            sort: [{ field: 'meta' }],
            measures: [{ name: 's', op: 'sum', field: 'title' }],
            timeZone: 'Nowhere/Land',
        });
        expect(result.problems.map((p) => p.path)).toEqual([
            '$.timeZone',
            '$.filter.all[0].field',
            '$.filter.all[1].op',
            '$.measures[0].op',
            '$.sort[0].field',
        ]);
    });

    it('reports shape problems inside a filter group at the member’s own path', () => {
        const result = check({
            filter: {
                all: [
                    { field: 'title', op: 'is', value: 'x' },
                    { field: 'amount', op: 'nope', value: 1 },
                ],
            },
        });
        expect(result.problems).toEqual([{ path: '$.filter.all[1].op', message: expect.any(String) }]);
        refused({ filter: { all: [{ field: 'title' }] } }, '$.filter.all[0].op');
        expect(checkSpec({}, { table }).problems).toEqual([{ path: '$.source', message: expect.any(String) }]);
        expect(checkSpec({ source: { dataset: 'ds_1' } }, { table }).problems[0].path).toMatch(/^\$\.source/);
    });

    it('applies defaults and names the engine by the table’s kind', () => {
        const result = ok({ sort: [{ field: 'title' }] });
        expect(result.spec?.sort?.[0].dir).toBe('asc');
        expect(result.engine).toBe('sqlite');
        const analytical: TableInfo = {
            name: 'events',
            rowCount: 0,
            kind: 'analytical',
            columns: [col('at', 'TIMESTAMP'), col('day', 'DATE'), col('amount', 'DECIMAL(12,2)'), col('kind', 'TEXT')],
        };
        const spec = {
            source: { dataset: 'ds_1', table: 'events' },
            time: { field: 'at', bucket: 'day' },
            window: 'trailing_12_months',
            measures: [{ name: 'total', op: 'sum', field: 'amount' }],
            groupBy: [{ field: 'kind' }],
            totals: true,
        };
        expect(checkSpec(spec, { table: analytical })).toMatchObject({ ok: true, engine: 'duckdb' });
    });

    it('writes JSON paths as the problems give them', () => {
        expect(specPath([])).toBe('$');
        expect(specPath(['filter', 'all', 1, 'op'])).toBe('$.filter.all[1].op');
        expect(specPath(['a b'])).toBe('$["a b"]');
        expect(isCalendarDate('2024-02-29')).toBe(true);
        expect(isCalendarDate('2026-02-29')).toBe(false);
        expect(isIsoDateTime('2026-11-20T23:59:59.999Z')).toBe(true);
        expect(isIsoDateTime('2026-11-20T24:00')).toBe(false);
    });
});

describe('review round 1', () => {
    it('checks measures that share dependencies in linear time', () => {
        // Each derived measure adds ten references to the one before it.
        const measures: Array<Record<string, unknown>> = [{ name: 'm0', op: 'count' }];
        for (let i = 1; i < 20; i++) {
            measures.push({ name: `m${i}`, expr: { add: Array(10).fill(`m${i - 1}`) } });
        }
        const started = performance.now();
        const result = check({ measures });
        expect(result.problems).toEqual([]);
        expect(performance.now() - started).toBeLessThan(500);
    });

    it('refuses deep nesting before parsing it, with a problem instead of a stack overflow', () => {
        let filter: Record<string, unknown> = { field: 'title', op: 'is_empty' };
        for (let i = 0; i < 2_000; i++) {
            filter = { all: [filter] };
        }
        const result = check({ filter });
        expect(result.ok).toBe(false);
        expect(result.problems).toEqual([{ path: '$', message: expect.stringContaining('nested too deeply') }]);
        let expr: unknown = 'a';
        for (let i = 0; i < 2_000; i++) {
            expr = { add: [expr, 1] };
        }
        const deep = check({
            measures: [
                { name: 'a', op: 'count' },
                { name: 'd', expr },
            ],
        });
        expect(deep.problems).toEqual([{ path: '$', message: expect.stringContaining('nested too deeply') }]);
        // An ordinary deep-ish spec is still fine.
        ok({ filter: { all: [{ any: [{ field: 'team', op: 'has_any_of', value: [{ $me: true }] }] }] } });
    });

    it('compares date-and-time bounds as instants, offsets included', () => {
        ok({
            filter: { field: 'starts_at', op: 'between', value: ['2026-11-20T10:00:00+02:00', '2026-11-20T09:00:00Z'] },
        });
        refused(
            {
                filter: {
                    field: 'starts_at',
                    op: 'between',
                    value: ['2026-11-20T09:00:00Z', '2026-11-20T10:00:00+02:00'],
                },
            },
            '$.filter.value',
            'smaller value',
        );
        // Without offsets, in the spec's zone: 10:00 in New York is after 14:00 UTC.
        ok({
            timeZone: 'America/New_York',
            filter: { field: 'starts_at', op: 'between', value: ['2026-11-20T14:00Z', '2026-11-20T10:00'] },
        });
        refused(
            {
                timeZone: 'America/New_York',
                filter: { field: 'starts_at', op: 'between', value: ['2026-11-20T16:00Z', '2026-11-20T10:00'] },
            },
            '$.filter.value',
            'smaller value',
        );
        // A date is its first instant.
        ok({ filter: { field: 'starts_at', op: 'between', value: ['2026-11-20', '2026-11-20T00:00'] } });
        refused(
            { filter: { field: 'starts_at', op: 'between', value: ['2026-11-21', '2026-11-20T23:00'] } },
            '$.filter.value',
        );
    });

    it('never takes a primary key stored as bytes', () => {
        const blobKey: TableInfo = { ...table, columns: [col('key', 'BLOB', true), col('n', 'INTEGER')] };
        const run = (spec: Record<string, unknown>) => checkSpec({ source, ...spec }, { table: blobKey });
        expect(run({ groupBy: [{ field: 'key' }] }).problems[0]).toMatchObject({ path: '$.groupBy[0].field' });
        expect(run({ sort: [{ field: 'key' }] }).problems[0]).toMatchObject({ path: '$.sort[0].field' });
        expect(run({ measures: [{ name: 'k', op: 'count_distinct', field: 'key' }] }).problems[0]).toMatchObject({
            path: '$.measures[0].field',
            message: expect.stringContaining('bytes'),
        });
        expect(run({ filter: { field: 'key', op: 'is_empty' } }).ok).toBe(false);
    });
});

describe('review round 2', () => {
    it('does arithmetic and running sums on numbers only, never on date measures', () => {
        for (const field of ['due', 'starts_at']) {
            const earliest = { name: 'earliest', op: 'min', field };
            refused(
                { measures: [earliest, { name: 'd', expr: { mul: ['earliest', 2] } }] },
                '$.measures[1].expr.mul[0]',
                'number',
            );
            refused(
                {
                    time: { field: 'due', bucket: 'month' },
                    measures: [earliest, { name: 'r', running: { of: 'earliest' } }],
                },
                '$.measures[1].running.of',
                'number',
            );
        }
        ok({
            measures: [
                { name: 'top', op: 'max', field: 'amount' },
                { name: 'd', expr: { mul: ['top', 2] } },
            ],
        });
    });

    it('needs a time field for a running value that starts on a date', () => {
        const spec = {
            groupBy: [{ field: 'amount' }],
            measures: [
                { name: 'n', op: 'count' },
                { name: 'r', running: { of: 'n', order: 'amount', from: '2026-01-01' } },
            ],
        };
        refused(spec, '$.measures[1].running.from', 'time.field');
        ok({ ...spec, time: { field: 'due' } });
    });
});
