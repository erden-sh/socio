/**
 * The compiler and the client evaluator agree (CB-451):
 * the same specs run through the SQLite compiler (`POST …/specs/run`'s
 * path, through `DataSpace.query`) and through `matchesFilter` and
 * `compareRows` over the shared fixtures (`BOOKINGS_ROWS`) and a few
 * stored oddities, and must give the same rows in the same order, so a
 * view looks the same computed on the server or offline.
 */
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ColumnType } from '@socio/shared/data-types';
import type { FieldKind, FieldSetting } from '@socio/shared/dataset-query/kinds';
import { operatorsFor, OP_VALUE_SHAPE } from '@socio/shared/dataset-query/operators';
import type { FilterNode, QuerySort } from '@socio/shared/dataset-query/spec';
import type { FieldDisplay, ViewRow } from '@socio/shared/dataset-views/contract';
import { compareRows, matchesFilter, type EvaluateContext } from '@socio/shared/dataset-views/evaluate';
import {
    BOOKINGS_FIELDS,
    BOOKINGS_ROWS,
    BOOKINGS_USERS,
    FIXTURE_CONTEXT,
    VIEW_FIXTURES,
} from '@socio/shared/dataset-views/fixtures/index';
import { cellDay, cellInstant, cellItems, cellNumber, isChecked } from '@socio/shared/dataset-views/format';
import { rowKey } from '@socio/shared/dataset-views/schema';

import {
    checkedOf,
    dayOf,
    instantOf,
    ITEM_TYPES,
    itemsOf,
    numberOf,
    textOf,
    trimmedText,
} from '../src/server/dataspace/query-spec/sqlite.js';

import { specFixture } from './helpers/spec-fixture.js';

const TYPES: Record<string, ColumnType> = {
    id: 'TEXT',
    title: 'TEXT',
    room: 'TEXT',
    starts_at: 'DATETIME',
    ends_at: 'DATETIME',
    day: 'TEXT',
    amount: 'INTEGER',
    share: 'REAL',
    guests: 'INTEGER',
    done: 'BOOLEAN',
    owner: 'TEXT',
    team: 'JSON',
    tags: 'JSON',
    photo: 'TEXT',
    notes: 'TEXT',
    meta: 'JSON',
};

/** Stored oddities beside the fixtures: case, accents, offsets without a colon, long fractions, numbers as text, junk. */
const ODD_ROWS: ViewRow[] = [
    {
        key: '"b6"',
        stamp: null,
        values: {
            id: 'b6',
            title: 'ÉCOLE Acme',
            room: '',
            starts_at: '2026-11-21T04:30:00+0000',
            ends_at: ' 2026-11-21 23:59 ',
            day: '2026-11-21T23:00:00Z',
            amount: 1250,
            share: 0.25,
            guests: 'many',
            done: 'true',
            owner: 'u_ben',
            team: '["u_ana","u_ben"]',
            tags: '[]',
            photo: '',
            notes: 'Acme retro',
            meta: '[]',
        },
    },
    {
        key: '"b7"',
        stamp: null,
        values: {
            id: 'b7',
            title: 'a',
            room: 'opt_c',
            starts_at: '2026-11-22T04:59:59.999999',
            ends_at: '2026-11-23T14:00:00.5-05:00',
            day: '0099-01-01',
            amount: -500,
            share: 2.5,
            guests: 0,
            done: 0,
            owner: '',
            team: null,
            tags: '["t_y", 3]',
            photo: null,
            notes: 'A',
            meta: null,
        },
    },
    {
        key: '"b8"',
        stamp: null,
        values: {
            id: 'b8',
            title: 'A',
            room: 'opt_a',
            starts_at: 'soon',
            ends_at: '2026-02-30T10:00Z',
            day: 'not a date',
            amount: null,
            share: null,
            guests: '12abc',
            done: null,
            owner: 'u_ana',
            team: '[]',
            tags: '["t_x"]',
            photo: 'f_1',
            notes: 'x',
            meta: '{}',
        },
    },
];
const ROWS = [...BOOKINGS_ROWS, ...ODD_ROWS];

const SETTINGS: FieldSetting[] = BOOKINGS_FIELDS.filter((f) => f.kind !== 'id').map((f) => ({
    column: f.field,
    kind: f.kind as FieldKind,
    settings: {
        ...(f.settings.options ? { options: f.settings.options } : {}),
        ...(f.settings.currency ? { currency: f.settings.currency } : {}),
        ...(f.settings.minorUnits ? { minorUnits: true } : {}),
    },
}));

const ctx: EvaluateContext = {
    fields: BOOKINGS_FIELDS,
    timeZone: FIXTURE_CONTEXT.timeZone,
    me: FIXTURE_CONTEXT.me,
    now: FIXTURE_CONTEXT.now,
    users: BOOKINGS_USERS,
};

let f: Awaited<ReturnType<typeof specFixture>>;
/** The rows as SQLite gives them back, which a client caches and evaluates too. */
let stored: ViewRow[];

beforeAll(async () => {
    f = await specFixture(
        [
            {
                name: 'bookings',
                columns: BOOKINGS_FIELDS.map((field) => ({
                    name: field.field,
                    type: TYPES[field.field]!,
                    ...(field.isKey ? { primaryKey: true } : {}),
                })),
                rows: ROWS.map((r) => r.values),
                settings: SETTINGS,
            },
        ],
        { now: () => FIXTURE_CONTEXT.now },
    );
    const all = await f.run({ timeZone: FIXTURE_CONTEXT.timeZone });
    stored = all.rows.map((r) => ({ key: r.key!, stamp: null, values: r.values }));
}, 60_000);
afterAll(() => f?.close());

const serverKeys = async (spec: { filter?: FilterNode; sort?: QuerySort[] }) =>
    (await f.run({ ...spec, timeZone: FIXTURE_CONTEXT.timeZone })).rows.map((r) => r.key);

/** What the evaluator gives over some rows: the matching keys in view order, or the rows it can't tell. */
function clientKeys(rows: ViewRow[], spec: { filter?: FilterNode; sort?: QuerySort[] }) {
    const unknown = rows.filter((r) => matchesFilter(r.values, spec.filter, ctx) === undefined).map((r) => r.key);
    const kept = rows.filter((r) => matchesFilter(r.values, spec.filter, ctx) === true);
    return { unknown, keys: [...kept].sort((a, b) => compareRows(a, b, spec.sort, ctx)).map((r) => r.key) };
}

/** Values to try for each kind, by the shape the operator takes. */
const ONE: Partial<Record<FieldKind, unknown[]>> = {
    text: ['standup', 'STAND', 'o', 'Retro', '', 'é', 'ACME', 'r', 'a'],
    long_text: ['sheet', 'RETRO', '', 'a', 'two nights'],
    id: ['b1', 'B', '1'],
    number: [0, 6, 12, -500, 8.5],
    currency: [0, 2500, 12550, -500],
    percent: [0, 0.125, 1, 0.25],
    checkbox: [true, false],
    date: ['today', '2026-11-23', '2026-11-20', '2026-12-01', '2026-11-21'],
    datetime: [
        'today',
        '2026-11-23',
        '2026-11-21',
        '2026-11-23T09:00',
        '2026-11-23T14:00:00Z',
        '2026-12-01T10:00:00-05:00',
    ],
    select: ['opt_a', 'opt_b', 'opt_c'],
    person: ['u_ana', { $me: true }, 'u_cam', 'u_ben'],
};
const PAIR: Partial<Record<FieldKind, unknown[][]>> = {
    number: [
        [0, 12],
        [6, 6],
    ],
    currency: [[0, 12550]],
    percent: [[0.1, 0.5]],
    date: [
        ['2026-11-20', '2026-11-24'],
        ['today', '2026-12-31'],
    ],
    datetime: [
        ['2026-11-20', '2026-11-24'],
        ['2026-11-23T09:00', '2026-11-24T14:00:00Z'],
    ],
};
const LIST: Partial<Record<FieldKind, unknown[][]>> = {
    select: [['opt_a', 'opt_c'], ['opt_b']],
    person: [['u_ana', 'u_ben'], [{ $me: true }]],
    multi_select: [['t_x'], ['t_x', 't_y'], ['t_y']],
    people: [['u_ana'], ['u_cam', 'u_ben'], [{ $me: true }]],
};
const RANGES = [
    { relative: 'past', count: 7, unit: 'day' },
    { relative: 'next', count: 1, unit: 'week' },
    { relative: 'next', count: 2, unit: 'month' },
    { period: 'this_month' },
    { period: 'next_month' },
    { period: 'this_week' },
    { period: 'previous_year' },
];

/** Every operator of every field, with each of its kind's values. */
function conditionMatrix(): FilterNode[] {
    const out: FilterNode[] = [];
    for (const field of BOOKINGS_FIELDS) {
        const kind = field.kind as FieldKind;
        const valuesKind: FieldKind = kind === 'id' ? 'id' : kind;
        for (const op of operatorsFor(kind, 'text')) {
            const shape = OP_VALUE_SHAPE[op];
            const values =
                shape === 'none'
                    ? [undefined]
                    : shape === 'one'
                      ? (ONE[valuesKind] ?? []).filter((v) => v !== '' || op === 'is' || op === 'is_not')
                      : shape === 'pair'
                        ? (PAIR[valuesKind] ?? [])
                        : shape === 'list'
                          ? (LIST[valuesKind] ?? [])
                          : RANGES;
            for (const value of values) {
                out.push({ field: field.field, op, ...(value === undefined ? {} : { value }) } as FilterNode);
            }
        }
    }
    return out;
}

describe('filters: the compiler and the evaluator keep the same rows', () => {
    it('for every operator of every kind, over the fixtures and over the rows as stored', async () => {
        const mismatches: unknown[] = [];
        const conditions = conditionMatrix();
        expect(conditions.length).toBeGreaterThan(150);
        for (const condition of conditions) {
            const spec = { filter: condition };
            const server = await serverKeys(spec);
            for (const [source, rows] of [
                ['fixture', ROWS],
                ['stored', stored],
            ] as const) {
                const client = clientKeys(rows, spec);
                if (client.unknown.length) {
                    mismatches.push({ condition, source, unknown: client.unknown });
                } else if (JSON.stringify(client.keys) !== JSON.stringify(server)) {
                    mismatches.push({ condition, source, server, client: client.keys });
                }
            }
        }
        expect(mismatches).toEqual([]);
    }, 120_000);

    it('for groups of conditions, nested, and every view fixture', async () => {
        const groups: Array<{ filter?: FilterNode; sort?: QuerySort[] }> = [
            {
                filter: {
                    all: [
                        { field: 'room', op: 'is_not', value: 'opt_b' },
                        {
                            any: [
                                { field: 'guests', op: 'gte', value: 8 },
                                { field: 'owner', op: 'is', value: { $me: true } },
                            ],
                        },
                    ],
                },
            },
            {
                filter: {
                    any: [
                        { field: 'tags', op: 'has_none_of', value: ['t_x'] },
                        {
                            all: [
                                { field: 'done', op: 'is', value: true },
                                { field: 'notes', op: 'is_not_empty' },
                            ],
                        },
                    ],
                },
            },
            ...VIEW_FIXTURES.filter((v) => v.expect.sortEvaluable && v.name !== 'unknown').map((v) => ({
                ...(v.definition.view.query.filter ? { filter: v.definition.view.query.filter as FilterNode } : {}),
                ...(v.definition.view.query.sort ? { sort: v.definition.view.query.sort as QuerySort[] } : {}),
            })),
        ];
        for (const spec of groups) {
            const server = await serverKeys(spec);
            expect(clientKeys(ROWS, spec)).toEqual({ unknown: [], keys: server });
            expect(clientKeys(stored, spec)).toEqual({ unknown: [], keys: server });
        }
    }, 60_000);

    it('keeps the fixtures’ own expectations', async () => {
        for (const fixture of VIEW_FIXTURES.filter((v) => v.name !== 'unknown')) {
            const filter = fixture.definition.view.query.filter as FilterNode | undefined;
            expect(filter).toBeDefined();
            const server = new Set(await serverKeys(filter ? { filter } : {}));
            for (const [key, expected] of Object.entries(fixture.expect.matches)) {
                if (expected !== null) {
                    expect([fixture.name, key, server.has(key)]).toEqual([fixture.name, key, expected]);
                }
            }
        }
    });
});

describe('sorts: the compiler and the evaluator order rows the same', () => {
    it('for every sortable field, both directions, empties first and last', async () => {
        const mismatches: unknown[] = [];
        const sortable = BOOKINGS_FIELDS.filter((field) =>
            [
                'id',
                'title',
                'room',
                'starts_at',
                'ends_at',
                'day',
                'amount',
                'share',
                'guests',
                'done',
                'owner',
                'notes',
            ].includes(field.field),
        );
        for (const field of sortable) {
            for (const dir of ['asc', 'desc'] as const) {
                for (const empty of [undefined, 'first', 'last'] as const) {
                    const sort: QuerySort[] = [{ field: field.field, dir, ...(empty ? { empty } : {}) }];
                    const server = await serverKeys({ sort });
                    for (const [source, rows] of [
                        ['fixture', ROWS],
                        ['stored', stored],
                    ] as const) {
                        const client = clientKeys(rows, { sort });
                        if (JSON.stringify(client.keys) !== JSON.stringify(server)) {
                            mismatches.push({ sort, source, server, client: client.keys });
                        }
                    }
                }
            }
        }
        expect(mismatches).toEqual([]);
    }, 120_000);

    it('for two sorts at once, the second breaking the first’s ties', async () => {
        const sort: QuerySort[] = [
            { field: 'done', dir: 'desc' },
            { field: 'title', dir: 'asc' },
        ];
        expect(clientKeys(ROWS, { sort }).keys).toEqual(await serverKeys({ sort }));
    });
});

describe('cell readers: each SQL reader is its JavaScript twin', () => {
    const db = new DatabaseSync(':memory:');
    const one = (sql: string, value: unknown) =>
        (db.prepare(`SELECT ${sql} AS v`).get(value as never) as { v: unknown }).v;

    it('reads instants and days as cellInstant and cellDay do', () => {
        const values = [
            '2026-11-23T14:00',
            '2026-11-23T14:00:00Z',
            '2026-11-23 14:00:00.1239Z',
            '2026-11-23T14:00:00z',
            '2026-11-23T14:00+0500',
            '2026-11-23T14:00+05:00',
            ' 2026-11-23T14:00Z ',
            '\t2026-11-23\n',
            '2026-02-30T10:00Z',
            '2026-11-23',
            '2026-11-23T24:00Z',
            '2026-11-23T24:30Z',
            '2026-11-23T24:00:00.000Z',
            '2026-11-23T24:00:00.001Z',
            '2026-11-23T24:00:01Z',
            '2026-11-23T23:60Z',
            '2026-11-23T25:00Z',
            '2026-11-23T14:00+23:59',
            '2026-11-23T14:00+24:00',
            '2026-11-23T14:00+05:60',
            '2026-11-23T14:00-2400',
            '2026-11-23T14:00:60Z',
            '2026-11-23T14:00:00.5',
            '2026-11-23T14:00junk',
            '2026-11-23T14:00:00.123456789Z',
            '2026-11-23T14:00:00+14:59',
            '2026-11-23T14:00:00-0000',
            '2026-11-23T14:00+25:00',
            '0050-01-01T00:00Z',
            '0099-01-01',
            '0100-01-01',
            '2026-13-01',
            '2026-12-32T00:00',
            '1969-12-31T23:59:59.5Z',
            '2026-11-23t14:00',
            '2026-11-23T1:00',
            '2026-11-23T14:00 +05:00',
            '2026-11-23T14:00:00.Z',
            '12',
            '',
            1_795_442_400_000,
            1.5,
            -1,
            9e15,
            null,
        ];
        for (const value of values) {
            const ms = one(instantOf('?1', trimmedText('?1')), value);
            expect([value, ms === null ? null : Number(ms)]).toEqual([value, cellInstant(value) ?? null]);
            expect([value, one(dayOf('?1'), value)]).toEqual([value, cellDay(value) ?? null]);
        }
    });

    it('reads numbers as cellNumber does: JSON numbers only', () => {
        for (const value of [
            '12',
            ' 12 ',
            '1e3',
            '.5',
            '5.',
            '+5',
            '-0',
            '0x10',
            'Infinity',
            '\t5',
            '1 2',
            '00',
            '-1.5e-3',
            'abc',
            '',
            7,
            7.5,
            null,
        ]) {
            expect([value, one(numberOf('?1'), value)]).toEqual([value, cellNumber(value) ?? null]);
        }
    });

    it('reads lists as cellItems does, and checkboxes as isChecked', () => {
        for (const value of [
            '["a","b"]',
            '[ ]',
            '[1, 2.5, true, null, "x", ""]',
            'a',
            '',
            ' [1]',
            '[1,',
            '"x"',
            5,
            null,
            '{"a":1}',
        ]) {
            const items = (
                db
                    .prepare(
                        `SELECT json_group_array(${textOf('value')}) AS v FROM json_each(${itemsOf('?1')}) WHERE ${ITEM_TYPES}`,
                    )
                    .get(value as never) as { v: string }
            ).v;
            expect([value, items]).toEqual([value, JSON.stringify(cellItems(value).map(String))]);
        }
        for (const value of [1, 0, '1', 'true', 'TRUE', 2, null, 'yes']) {
            expect([value, !!one(checkedOf('?1'), value)]).toEqual([value, isChecked(value)]);
        }
    });

    it('keys rows as rowKey does', () => {
        expect(stored.map((r) => r.key)).toEqual(ROWS.map((r) => rowKey(r.values.id as string)));
    });
});

export type { FieldDisplay };
