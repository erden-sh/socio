// The native view contract (CB-451): schema version, stamps and keys,
// definitions, fallbacks, requests, the evaluator, the formatter and the
// sync decisions. The fixtures have their own file
// (dataset-views-fixtures.test.ts).
import { describe, expect, it } from 'vitest';

import {
    rowLookupRequest,
    rowsLimit,
    spanDays,
    spanReadProblems,
    viewIndexRequest,
    viewRowsPage,
    viewRowsRequest,
    type FieldDisplay,
} from '@socio/shared/dataset-views/contract';
import { checkViewDefinition, viewDefinition, type ViewDefinition } from '@socio/shared/dataset-views/definition';
import { compareRowKeys, compareRows, matchesFilter, sortIsEvaluable } from '@socio/shared/dataset-views/evaluate';
import {
    canEditField,
    fallbackLayout,
    fieldShowsAs,
    NEWER_LAYOUT_NOTE,
    NEWER_QUERY_NOTE,
    readViewDefinition,
} from '@socio/shared/dataset-views/fallback';
import {
    BOARD_FIXTURE,
    BOOKINGS_FIELDS,
    FIXTURE_CONTEXT,
    TABLE_FIXTURE,
    VIEW_FIXTURES,
} from '@socio/shared/dataset-views/fixtures/index';
import { cellInstant, formatCell, sameText } from '@socio/shared/dataset-views/format';
import { boardColumns, resolveCompact, resolveTitleField } from '@socio/shared/dataset-views/presentation';
import {
    answerSchema,
    DATASET_VIEWS_SCHEMA,
    formatStamp,
    isStamp,
    parseRowKey,
    parseStamp,
    rowidKey,
    rowKey,
    stampsEqual,
} from '@socio/shared/dataset-views/schema';
import { lookupBatches, planReconcile, reconcileOrRefetch } from '@socio/shared/dataset-views/sync';

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const field = (name: string, kind: string, extra: Partial<FieldDisplay> = {}): FieldDisplay => ({
    field: name,
    label: name,
    kind,
    fallback: 'text',
    editable: true,
    required: false,
    isKey: false,
    settings: {},
    ...extra,
});
const ctx = { fields: BOOKINGS_FIELDS, timeZone: FIXTURE_CONTEXT.timeZone, me: 'u_ana', now: FIXTURE_CONTEXT.now };
const fmt = { locale: 'en-US', timeZone: 'America/New_York' };
const row = (values: Record<string, unknown>) => values as Record<string, never>;

describe('schema version', () => {
    it('answers in the highest schema both sides read', () => {
        expect(DATASET_VIEWS_SCHEMA).toBe(1);
        expect(answerSchema(1)).toBe(1);
        expect(answerSchema('1')).toBe(1);
        expect(answerSchema(7)).toBe(DATASET_VIEWS_SCHEMA);
        for (const odd of [undefined, null, 0, -1, 1.5, 'x', '', '01x']) {
            expect(answerSchema(odd)).toBe(1);
        }
    });
});

describe('stamps and sync tokens: <generation>.<value>', () => {
    it('formats and parses', () => {
        expect(formatStamp('k7Hq2mZ0', 1042)).toBe('k7Hq2mZ0.1042');
        expect(parseStamp('k7Hq2mZ0.1042')).toEqual({ generation: 'k7Hq2mZ0', value: 1042 });
        expect(parseStamp('a-b_C.0')).toEqual({ generation: 'a-b_C', value: 0 });
        expect(parseStamp(formatStamp('g', Number.MAX_SAFE_INTEGER))?.value).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('refuses anything else', () => {
        for (const bad of [
            '',
            '1042',
            'g.',
            '.5',
            'g.01',
            'g.-1',
            'g.1.2',
            'a.b.3',
            'g h.1',
            'g.1e3',
            'g.99999999999999999',
            `${'x'.repeat(65)}.1`,
        ]) {
            expect(parseStamp(bad), bad).toBeUndefined();
            expect(isStamp(bad)).toBe(false);
        }
        expect(parseStamp(5)).toBeUndefined();
        expect(() => formatStamp('a.b', 1)).toThrow(RangeError);
        expect(() => formatStamp('g', -1)).toThrow(RangeError);
        expect(() => formatStamp('g', 1.5)).toThrow(RangeError);
    });

    it('equal only for the same write: same generation and value', () => {
        expect(stampsEqual('g1.650', 'g1.650')).toBe(true);
        // A restore reuses numbers under a new generation: never equal.
        expect(stampsEqual('g1.650', 'g2.650')).toBe(false);
        expect(stampsEqual('g1.650', 'g1.651')).toBe(false);
        expect(stampsEqual(null, null)).toBe(false);
        expect(stampsEqual(undefined, 'g1.1')).toBe(false);
        expect(stampsEqual('junk', 'junk')).toBe(false);
    });
});

describe('row keys', () => {
    it('are JCS JSON of the key, an array for a composite one, r:<rowid> without one', () => {
        expect(rowKey('b1')).toBe('"b1"');
        expect(rowKey(10)).toBe('10');
        expect(rowKey(['b1'])).toBe('"b1"');
        expect(rowKey(['acme', 7])).toBe('["acme",7]');
        expect(rowKey('é ')).toBe('"é "');
        expect(rowidKey(42)).toBe('r:42');
        expect(() => rowKey([])).toThrow(RangeError);
    });

    it('read back', () => {
        expect(parseRowKey('"b1"')).toEqual({ values: ['b1'] });
        expect(parseRowKey('["acme",7]')).toEqual({ values: ['acme', 7] });
        expect(parseRowKey('r:42')).toEqual({ rowid: 42 });
        for (const bad of ['r:x', 'r:', '{"a":1}', '[1]', 'nope']) {
            expect(parseRowKey(bad), bad).toBeUndefined();
        }
    });

    it('order by value: numbers as numbers, rowids as numbers', () => {
        expect(compareRowKeys('9', '10')).toBeLessThan(0);
        expect(compareRowKeys('r:9', 'r:10')).toBeLessThan(0);
        expect(compareRowKeys('["a",2]', '["a",10]')).toBeLessThan(0);
        expect(compareRowKeys('"b"', '"B"')).toBeGreaterThan(0);
        // Types are kept: null, then numbers (booleans as 0 and 1), then text.
        expect(compareRowKeys('[null,1]', '["null",1]')).toBeLessThan(0);
        expect(compareRowKeys('["a",null]', '["a",0]')).toBeLessThan(0);
        expect(compareRowKeys('[true,1]', '[1,2]')).toBeLessThan(0);
        expect(compareRowKeys('[false,1]', '[0,1]')).toBe(0);
        expect(compareRowKeys('[5,1]', '["5",1]')).toBeLessThan(0);
    });
});

describe('view definitions: saving refuses', () => {
    const base = TABLE_FIXTURE.definition.view;

    it('accepts every fixture of a known layout, and the parse changes nothing', () => {
        for (const fixture of VIEW_FIXTURES.filter((f) => f.name !== 'unknown')) {
            const checked = checkViewDefinition(json(fixture.definition.view));
            expect(checked.problems, fixture.name).toEqual([]);
            expect(checked.ok && json(checked.view)).toEqual(fixture.definition.view);
        }
    });

    it('lists every problem with its path', () => {
        const view: ViewDefinition = {
            ...json(base),
            layout: 'board',
            fields: [
                { field: 'title', priority: 1 },
                { field: 'title' },
                { field: 'room', priority: 1 },
                { field: 'notes', hidden: true, priority: 2 },
            ],
            options: { endField: 'ends_at', columns: [{ value: 'opt_a' }, { value: 'opt_a' }] },
            query: { groupBy: [{ segment: 'kind' }] },
        };
        const checked = checkViewDefinition(view);
        expect(checked.ok).toBe(false);
        expect(checked.problems.map((p) => p.path)).toEqual([
            '$.fields[1].field',
            '$.fields[2].priority',
            '$.fields[3].priority',
            '$.options.groupField',
            '$.options.endField',
            '$.options.columns[1].value',
            '$.query.groupBy[0].segment',
        ]);
    });

    it('refuses a calendar without a date field, measures in the query and unknown keys', () => {
        expect(checkViewDefinition({ ...json(base), layout: 'calendar' }).problems.map((p) => p.path)).toEqual([
            '$.options.dateField',
        ]);
        const measures = checkViewDefinition({ ...json(base), query: { measures: [{ name: 'n', op: 'count' }] } });
        expect(measures.ok).toBe(false);
        expect(viewDefinition.safeParse({ ...json(base), color: 'teal' }).success).toBe(false);
        expect(viewDefinition.safeParse({ ...json(base), layout: 'timeline' }).success).toBe(false);
        expect(viewDefinition.safeParse({ ...json(base), schema: 2 }).success).toBe(false);
        expect(viewDefinition.safeParse({ ...json(base), fields: [{ field: 'title', width: 10_000 }] }).success).toBe(
            false,
        );
        expect(
            viewDefinition.safeParse({
                ...json(base),
                query: { groupBy: [{ field: 'a' }, { field: 'b' }, { field: 'c' }] },
            }).success,
        ).toBe(false);
    });
});

describe('fallbacks: clients fall back, never fail', () => {
    it('opens an unknown layout as a table on the web and a list on a phone', () => {
        expect(fallbackLayout('board', 'phone')).toEqual({ layout: 'board' });
        expect(fallbackLayout('timeline', 'web')).toEqual({ layout: 'table', note: NEWER_LAYOUT_NOTE });
        expect(fallbackLayout('timeline', 'phone')).toEqual({ layout: 'list', note: NEWER_LAYOUT_NOTE });
    });

    it('shows an unknown kind by its fallback, a fallback it does not know as text, and edits neither', () => {
        expect(fieldShowsAs(field('a', 'currency'))).toEqual({ known: true, kind: 'currency' });
        expect(fieldShowsAs(field('a', 'rating', { fallback: 'number' }))).toEqual({
            known: false,
            fallback: 'number',
        });
        expect(fieldShowsAs(field('a', 'rating', { fallback: 'sparkles' }))).toEqual({
            known: false,
            fallback: 'text',
        });
        const rights = { write: true };
        expect(canEditField(field('a', 'text'), rights)).toBe(true);
        expect(canEditField(field('a', 'rating'), rights)).toBe(false);
        expect(canEditField(field('a', 'text', { editable: false }), rights)).toBe(false);
        expect(canEditField(field('a', 'text', { missing: true }), rights)).toBe(false);
        expect(canEditField(field('a', 'text'), { write: false })).toBe(false);
        expect(canEditField(field('a', 'text'), { write: true, writtenBy: 'events' })).toBe(false);
    });

    it('makes a query part it cannot read read-only, and keeps it', () => {
        const raw = {
            ...json(TABLE_FIXTURE.definition.view),
            query: {
                sort: [{ field: 'title', dir: 'asc', collate: 'de' }],
                filter: { field: 'title', op: 'is', value: 'x' },
            },
        };
        const reading = readViewDefinition(raw, 'phone');
        expect(reading.readOnly).toMatchObject({ filter: false, sort: true, groupBy: false });
        expect(reading.queryNote).toBe(NEWER_QUERY_NOTE);
        expect(json(reading.view)).toEqual(raw);
        expect(readViewDefinition(json(TABLE_FIXTURE.definition.view), 'web').queryNote).toBeUndefined();
    });

    it('fails only on what is not a view definition at all', () => {
        expect(() => readViewDefinition({ id: 'v' }, 'web')).toThrow();
        expect(() => readViewDefinition(null, 'web')).toThrow();
    });

    it('keeps unknown keys in answers too', () => {
        const page = {
            ...json(TABLE_FIXTURE.page),
            heatmap: [1, 2],
            rows: [{ ...json(TABLE_FIXTURE.page.rows[0]), pinned: true }],
        };
        expect(viewRowsPage.parse(page)).toEqual(page);
    });
});

describe('requests', () => {
    it('checks a calendar range: real dates, in order, at most 92 days', () => {
        expect(viewRowsRequest.safeParse({ schema: 1, range: { from: '2026-11-01', to: '2027-01-31' } }).success).toBe(
            true,
        );
        expect(spanDays({ from: '2026-11-01', to: '2027-01-31' })).toBe(92);
        expect(viewRowsRequest.safeParse({ schema: 1, range: { from: '2026-11-01', to: '2027-02-01' } }).success).toBe(
            false,
        );
        expect(viewRowsRequest.safeParse({ schema: 1, range: { from: '2026-11-02', to: '2026-11-01' } }).success).toBe(
            false,
        );
        expect(viewRowsRequest.safeParse({ schema: 1, range: { from: '2026-02-30', to: '2026-03-01' } }).success).toBe(
            false,
        );
        expect(spanReadProblems({}, 'calendar')).toHaveLength(1);
        expect(spanReadProblems({ range: { from: '2026-11-01', to: '2026-11-07' } }, 'calendar')).toEqual([]);
        expect(spanReadProblems({}, 'table')).toEqual([]);
    });

    it('bounds limits and keeps around to a first page', () => {
        expect(viewRowsRequest.safeParse({ schema: 1, limit: 501 }).success).toBe(false);
        expect(viewIndexRequest.safeParse({ schema: 1, limit: 5_000 }).success).toBe(true);
        expect(viewIndexRequest.safeParse({ schema: 1, limit: 5_001 }).success).toBe(false);
        expect(viewRowsRequest.safeParse({ schema: 1, around: 'today', cursor: 'c1' }).success).toBe(false);
        expect(rowsLimit('table')).toBe(100);
        expect(rowsLimit('board')).toBe(50);
        expect(rowsLimit('gallery')).toBe(60);
        expect(rowsLimit('list', 900)).toBe(500);
        expect(rowsLimit('timeline')).toBe(100);
    });

    it('drops what a newer client adds instead of refusing it', () => {
        expect(viewRowsRequest.parse({ schema: 3, sparkle: true })).toEqual({ schema: 3 });
    });

    it('takes at most 500 keys a lookup', () => {
        const keys = Array.from({ length: 501 }, (_, i) => String(i));
        expect(rowLookupRequest.safeParse({ schema: 1, keys }).success).toBe(false);
        expect(rowLookupRequest.safeParse({ schema: 1, keys: keys.slice(0, 500) }).success).toBe(true);
        expect(rowLookupRequest.safeParse({ schema: 1, keys: [] }).success).toBe(false);
    });
});

describe('matchesFilter', () => {
    it('matches text case-insensitively in ASCII only, and literally', () => {
        expect(matchesFilter(row({ title: 'Standup' }), { field: 'title', op: 'is', value: 'STANDUP' }, ctx)).toBe(
            true,
        );
        expect(matchesFilter(row({ title: 'Équipe' }), { field: 'title', op: 'is', value: 'équipe' }, ctx)).toBe(false);
        expect(matchesFilter(row({ title: '100% done' }), { field: 'title', op: 'contains', value: '%' }, ctx)).toBe(
            true,
        );
        expect(matchesFilter(row({ title: 'abc' }), { field: 'title', op: 'contains', value: '_' }, ctx)).toBe(false);
        expect(matchesFilter(row({ title: null }), { field: 'title', op: 'is', value: '' }, ctx)).toBe(true);
        expect(matchesFilter(row({ title: 'x' }), { field: 'title', op: 'is_not', value: '' }, ctx)).toBe(true);
        expect(matchesFilter(row({ title: null }), { field: 'title', op: 'not_contains', value: 'a' }, ctx)).toBe(true);
    });

    it('counts a null checkbox as unchecked and between as inclusive', () => {
        expect(matchesFilter(row({ done: null }), { field: 'done', op: 'is', value: false }, ctx)).toBe(true);
        expect(matchesFilter(row({ done: 1 }), { field: 'done', op: 'is', value: true }, ctx)).toBe(true);
        expect(matchesFilter(row({ guests: 10 }), { field: 'guests', op: 'between', value: [10, 12] }, ctx)).toBe(true);
        expect(matchesFilter(row({ guests: null }), { field: 'guests', op: 'neq', value: 3 }, ctx)).toBe(true);
        expect(matchesFilter(row({ guests: null }), { field: 'guests', op: 'lt', value: 3 }, ctx)).toBe(false);
    });

    it('reads a datetime day in the viewer zone, and an offset-less bound in it too', () => {
        // 04:30 UTC on the 22nd is 23:30 on the 21st in New York: still today.
        const late = row({ starts_at: '2026-11-22T04:30:00Z' });
        expect(matchesFilter(late, { field: 'starts_at', op: 'is', value: 'today' }, ctx)).toBe(true);
        expect(matchesFilter(late, { field: 'starts_at', op: 'after', value: '2026-11-21' }, ctx)).toBe(false);
        expect(matchesFilter(late, { field: 'starts_at', op: 'on_or_before', value: '2026-11-21' }, ctx)).toBe(true);
        expect(matchesFilter(late, { field: 'starts_at', op: 'before', value: '2026-11-21T23:31' }, ctx)).toBe(true);
        expect(matchesFilter(late, { field: 'starts_at', op: 'before', value: '2026-11-21T23:30' }, ctx)).toBe(false);
        expect(
            matchesFilter(late, { field: 'starts_at', op: 'between', value: ['2026-11-20', '2026-11-21'] }, ctx),
        ).toBe(true);
        expect(
            matchesFilter(
                row({ day: '2026-11-21' }),
                { field: 'day', op: 'within', value: { period: 'this_week' } },
                ctx,
            ),
        ).toBe(true);
        expect(matchesFilter(row({ day: null }), { field: 'day', op: 'before', value: 'today' }, ctx)).toBe(false);
    });

    it('matches lists stored as arrays or JSON text, and $me', () => {
        expect(
            matchesFilter(row({ team: '["u_ana"]' }), { field: 'team', op: 'has_any_of', value: [{ $me: true }] }, ctx),
        ).toBe(true);
        expect(matchesFilter(row({ tags: [] }), { field: 'tags', op: 'has_all_of', value: ['t_x'] }, ctx)).toBe(false);
        expect(matchesFilter(row({ tags: [] }), { field: 'tags', op: 'has_none_of', value: ['t_x'] }, ctx)).toBe(true);
        expect(matchesFilter(row({ tags: '[]' }), { field: 'tags', op: 'is_empty' }, ctx)).toBe(true);
    });

    it('answers undefined for what it cannot tell, and combines it as SQL three-valued logic would', () => {
        const unknown = { field: 'title', op: 'matches_regex' as never, value: 'x' };
        expect(matchesFilter(row({ title: 'x' }), unknown, ctx)).toBeUndefined();
        expect(matchesFilter(row({}), { field: 'nope', op: 'is_empty' }, ctx)).toBeUndefined();
        expect(
            matchesFilter(
                row({ owner: 'u_ana' }),
                { field: 'owner', op: 'is', value: { $me: true } },
                { ...ctx, me: undefined },
            ),
        ).toBeUndefined();
        expect(
            matchesFilter(row({ guests: 1 }), { field: 'guests', op: 'eq', value: { $param: 'n' } }, ctx),
        ).toBeUndefined();
        const yes = { field: 'title', op: 'is_not_empty' as const };
        const no = { field: 'title', op: 'is_empty' as const };
        expect(matchesFilter(row({ title: 'x' }), { any: [unknown, yes] }, ctx)).toBe(true);
        expect(matchesFilter(row({ title: 'x' }), { any: [unknown, no] }, ctx)).toBeUndefined();
        expect(matchesFilter(row({ title: 'x' }), { all: [unknown, no] }, ctx)).toBe(false);
        expect(matchesFilter(row({ title: 'x' }), { all: [unknown, yes] }, ctx)).toBeUndefined();
        expect(matchesFilter(row({}), undefined, ctx)).toBe(true);
    });

    it('does not evaluate a shape from a later release: a new period, or a new key on a condition or group', () => {
        const day = row({ day: '2026-11-21' });
        const fortnight = { field: 'day', op: 'within', value: { period: 'this_fortnight' } } as never;
        expect(matchesFilter(day, fortnight, ctx)).toBeUndefined();
        const unit = { field: 'day', op: 'within', value: { relative: 'past', count: 2, unit: 'fortnight' } } as never;
        expect(matchesFilter(day, unit, ctx)).toBeUndefined();
        const collated = { field: 'title', op: 'is', value: 'x', collate: 'de' } as never;
        expect(matchesFilter(row({ title: 'x' }), collated, ctx)).toBeUndefined();
        const group = { all: [{ field: 'title', op: 'is_not_empty' }], negate: true } as never;
        expect(matchesFilter(row({ title: 'x' }), group, ctx)).toBeUndefined();
    });

    it('reads emptiness by kind: list kinds by their items, text literally', () => {
        expect(matchesFilter(row({ title: '[]' }), { field: 'title', op: 'is', value: '[]' }, ctx)).toBe(true);
        expect(matchesFilter(row({ title: '[]' }), { field: 'title', op: 'is_empty' }, ctx)).toBe(false);
        expect(matchesFilter(row({ tags: '[ ]' }), { field: 'tags', op: 'is_empty' }, ctx)).toBe(true);
        expect(matchesFilter(row({ tags: '[ "t_x" ]' }), { field: 'tags', op: 'is_not_empty' }, ctx)).toBe(true);
        expect(matchesFilter(row({ photo: '[]' }), { field: 'photo', op: 'is_empty' }, ctx)).toBe(true);
        expect(matchesFilter(row({ tags: ' ["t_x"]' }), { field: 'tags', op: 'has_any_of', value: ['t_x'] }, ctx)).toBe(
            true,
        );
        expect(matchesFilter(row({ tags: '\n []' }), { field: 'tags', op: 'is_empty' }, ctx)).toBe(true);
        expect(
            matchesFilter(
                row({ team: ' [ "u_ana" ]' }),
                { field: 'team', op: 'has_all_of', value: [{ $me: true }] },
                ctx,
            ),
        ).toBe(true);
        expect(matchesFilter(row({ photo: '  []' }), { field: 'photo', op: 'is_empty' }, ctx)).toBe(true);
    });
});

describe('compareRows', () => {
    const a = { key: '"a"', values: { guests: null, title: 'b' } };
    const b = { key: '"b"', values: { guests: 3, title: 'B' } };

    it('puts empties last in either direction unless asked first, and breaks ties by key', () => {
        expect(compareRows(a, b, [{ field: 'guests', dir: 'asc' }], ctx)).toBeGreaterThan(0);
        expect(compareRows(a, b, [{ field: 'guests', dir: 'desc' }], ctx)).toBeGreaterThan(0);
        expect(compareRows(a, b, [{ field: 'guests', dir: 'desc', empty: 'first' }], ctx)).toBeLessThan(0);
        // "b" and "B" tie under NOCASE; the key decides.
        expect(compareRows(a, b, [{ field: 'title', dir: 'desc' }], ctx)).toBeLessThan(0);
        expect(compareRows({ key: '10', values: {} }, { key: '9', values: {} }, [], ctx)).toBeGreaterThan(0);
    });

    it('sorts a person by name', () => {
        const users = {
            u_1: { name: 'Zed', avatar: null, active: true },
            u_2: { name: 'Amy', avatar: null, active: true },
        };
        const x = { key: '1', values: { owner: 'u_1' } };
        const y = { key: '2', values: { owner: 'u_2' } };
        expect(compareRows(x, y, [{ field: 'owner', dir: 'asc' }], { ...ctx, users })).toBeGreaterThan(0);
    });

    it('knows which sorts it can evaluate', () => {
        expect(sortIsEvaluable([{ field: 'title', dir: 'asc' }], BOOKINGS_FIELDS)).toBe(true);
        expect(sortIsEvaluable([{ field: 'tags', dir: 'asc' }], BOOKINGS_FIELDS)).toBe(false);
        expect(sortIsEvaluable([{ field: 'title', dir: 'sideways' }], BOOKINGS_FIELDS)).toBe(false);
        expect(sortIsEvaluable(undefined, BOOKINGS_FIELDS)).toBe(true);
    });
});

describe('formatCell', () => {
    it('formats currencies by their own digits, minor units included', () => {
        const yen = field('p', 'currency', { settings: { currency: 'JPY', minorUnits: true } });
        expect(formatCell(1500, yen, fmt)).toBe('¥1,500');
        const usd = field('p', 'currency', { settings: { currency: 'USD', minorUnits: true, decimals: 0 } });
        expect(formatCell(12_550, usd, fmt)).toBe('$126');
        expect(formatCell(12.5, field('p', 'currency'), fmt)).toBe('12.5');
        expect(formatCell(3, field('p', 'currency', { settings: { currency: 'NOPE!' } }), fmt)).toBe('3 NOPE!');
    });

    it('formats dates as days, datetimes in the zone, and a date-only datetime as a day', () => {
        expect(formatCell('2026-11-21', field('d', 'date'), fmt)).toBe('Nov 21, 2026');
        expect(formatCell('2026-02-30', field('d', 'date'), fmt)).toBe('2026-02-30');
        expect(formatCell('2026-11-21', field('d', 'datetime'), fmt)).toBe('Nov 21, 2026');
        const day = field('d', 'datetime', { settings: { dateFormat: 'date' } });
        expect(formatCell('2026-11-22T04:30:00Z', day, fmt)).toBe('Nov 21, 2026');
        expect(sameText(formatCell('2026-11-22 04:30:00', field('d', 'datetime'), fmt), 'Nov 21, 2026, 11:30 PM')).toBe(
            true,
        );
        expect(cellInstant('2026-11-22T04:30:00+0100')).toBe(Date.parse('2026-11-22T03:30:00Z'));
        expect(cellInstant('soon')).toBeUndefined();
        // Finite numbers past what a date holds fall back to the raw value instead of throwing.
        expect(formatCell(1e16, field('d', 'date'), fmt)).toBe('10000000000000000');
        expect(formatCell(1e16, field('d', 'datetime'), fmt)).toBe('10000000000000000');
        expect(cellInstant(-1e16)).toBeUndefined();
        expect(matchesFilter(row({ day: 1e16 }), { field: 'day', op: 'before', value: 'today' }, ctx)).toBe(false);
        expect(
            formatCell(
                ' ["t_x"]',
                BOOKINGS_FIELDS.find((f) => f.field === 'tags')!,
                fmt,
            ),
        ).toBe('External');
    });

    it('shows empties, blobs and hidden fallbacks as nothing, and an unchecked box as No', () => {
        expect(formatCell(null, field('t', 'text'), fmt)).toBe('');
        expect(formatCell({ $blob: true }, field('b', 'blob'), fmt)).toBe('');
        expect(formatCell('x', field('s', 'vault', { fallback: 'hidden' }), fmt)).toBe('');
        expect(formatCell(null, field('c', 'checkbox'), fmt)).toBe('No');
        expect(formatCell(1, field('c', 'checkbox'), fmt)).toBe('Yes');
        expect(formatCell('u_x', field('o', 'person'), fmt)).toBe('Unknown person');
        expect(formatCell('{"a":1}', field('j', 'json'), fmt)).toBe('{"a":1}');
        expect(formatCell(0.25, field('p', 'percent'), fmt)).toBe('25%');
    });
});

describe('presentation', () => {
    const view = TABLE_FIXTURE.definition.view;

    it('leads with the title and the next three without priorities, and skips dropped fields', () => {
        expect(resolveCompact(view, BOOKINGS_FIELDS)).toEqual(['title', 'room', 'starts_at', 'amount']);
        const dropped = BOOKINGS_FIELDS.map((f) => (f.field === 'title' ? { ...f, missing: true as const } : f));
        expect(resolveTitleField(view, dropped)).toBe('id');
        expect(resolveCompact(view, dropped)).toEqual(['id', 'room', 'starts_at', 'amount']);
        expect(resolveTitleField({ ...view, fields: [] }, BOOKINGS_FIELDS)).toBe('id');
        expect(resolveTitleField({ ...view, fields: [] }, [field('n', 'number')])).toBeNull();
    });

    it('lists every checkbox column, and No <field> last when not listed', () => {
        const done = BOOKINGS_FIELDS.find((f) => f.field === 'done')!;
        expect(boardColumns({ fields: [], options: { columns: [{ value: false, hidden: true }] } }, done)).toEqual([
            { value: false, hidden: true },
            { value: true, hidden: false },
            { value: null, hidden: false },
        ]);
        // A listed option the field no longer has is left out; people come from the page.
        const room = BOOKINGS_FIELDS.find((f) => f.field === 'room')!;
        expect(
            boardColumns({ fields: [], options: { columns: [{ value: 'gone' }] } }, room).map((c) => c.value),
        ).toEqual(['opt_a', 'opt_b', 'opt_c', null]);
        const owner = BOOKINGS_FIELDS.find((f) => f.field === 'owner')!;
        expect(boardColumns({ fields: [], options: {} }, owner, ['u_ben']).map((c) => c.value)).toEqual([
            'u_ben',
            null,
        ]);
        // A listed "No <field>" keeps its place; listed people the page doesn't name are left out.
        expect(boardColumns(BOARD_FIXTURE.definition.view, owner, ['u_ben']).map((c) => c.value)).toEqual([
            null,
            'u_ben',
        ]);
    });
});

describe('sync decisions', () => {
    it('fetches a cached row without a stamp, and lists a multi-value row once', () => {
        const plan = planReconcile(
            [
                { key: '"a"', stamp: null },
                { key: '"b"', stamp: 'g.1' },
            ],
            [
                { key: '"a"', stamp: 'g.1' },
                { key: '"b"', stamp: 'g.1' },
                { key: '"b"', stamp: 'g.1' },
            ],
        );
        expect(plan).toEqual({ order: ['"a"', '"b"', '"b"'], keep: ['"b"'], fetch: ['"a"'], drop: [] });
    });

    it('refetches only without a cache or when the index costs more', () => {
        expect(reconcileOrRefetch({ rows: 0, bytes: 0 })).toBe('refetch');
        expect(reconcileOrRefetch({ rows: 100, bytes: 3_000 })).toBe('refetch');
        expect(reconcileOrRefetch({ rows: 100, bytes: 40_000 })).toBe('reconcile');
    });

    it('batches lookups by 500', () => {
        const keys = Array.from({ length: 1_001 }, (_, i) => String(i));
        expect(lookupBatches(keys).map((b) => b.length)).toEqual([500, 500, 1]);
    });
});
