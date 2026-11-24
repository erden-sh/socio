/**
 * The SQLite query spec compiler (CB-451, build step 5):
 * windows and time zones, running values over the source range, "this
 * year vs last year, by month", segments, totals, unverified rows,
 * injection attempts and the spec's limits, run through `SpecRunner`
 * and `DataSpace.query` as `POST /api/data/specs/run` runs them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FieldSetting } from '@socio/shared/dataset-query/kinds';
import { QUERY_SPEC_LIMITS, type FilterNode } from '@socio/shared/dataset-query/spec';

import { checkSpec, specFields } from '../src/server/dataspace/query-spec/check.js';
import { compileSpec } from '../src/server/dataspace/query-spec/compile.js';
import type { SpecQueryTiming } from '../src/server/dataspace/query-spec/run.js';

import { specFixture, type SpecTable } from './helpers/spec-fixture.js';

const NOW = Date.UTC(2026, 10, 20, 15); // Friday, November 20, 2026, 10:00 in New York

const PAYMENT_SETTINGS: FieldSetting[] = [
    { column: 'amount', kind: 'currency', settings: { currency: 'USD', minorUnits: true } },
    { column: 'event_on', kind: 'date' },
    { column: 'inferred_on', kind: 'date' },
    {
        column: 'kind',
        kind: 'select',
        settings: {
            options: [
                { id: 'charge', label: 'Charge' },
                { id: 'refund', label: 'Refund' },
            ],
        },
    },
    { column: 'payer', kind: 'person' },
];

const payments = (rows: Array<Record<string, unknown>>): SpecTable => ({
    name: 'payments',
    columns: [
        { name: 'id', type: 'INTEGER', primaryKey: true },
        { name: 'paid_at', type: 'DATETIME' },
        { name: 'event_on', type: 'TEXT' },
        { name: 'inferred_on', type: 'TEXT' },
        { name: 'amount', type: 'INTEGER' },
        { name: 'kind', type: 'TEXT' },
        { name: 'description', type: 'TEXT' },
        { name: 'matched', type: 'BOOLEAN' },
        { name: 'payer', type: 'TEXT' },
        { name: 'seats', type: 'REAL' },
    ],
    rows: rows.map((r, i) => ({ id: i + 1, ...r })),
    settings: PAYMENT_SETTINGS,
});

const ROWS = [
    // 100 in December, 10 in January: the running value's opening balance.
    {
        paid_at: '2025-12-10T12:00:00Z',
        amount: 100,
        kind: 'charge',
        description: 'Acme membership',
        matched: true,
        payer: 'ada',
        event_on: '2025-12-09',
    },
    {
        paid_at: '2026-01-10T12:00:00Z',
        amount: 10,
        kind: 'charge',
        description: 'Event ticket',
        matched: false,
        payer: 'u_ben',
        inferred_on: '2026-01-09',
    },
    // November 1 at 03:00 UTC is still October 31 in New York.
    {
        paid_at: '2026-11-01T03:00:00Z',
        amount: 5,
        kind: 'refund',
        description: 'Membership refund',
        matched: true,
        payer: 'ada',
        event_on: '2026-10-31',
    },
    {
        paid_at: '2025-03-15T12:00:00Z',
        amount: 40,
        kind: 'charge',
        description: 'Membership, annual',
        matched: true,
        payer: 'u_cam',
        event_on: '2025-03-14',
    },
    {
        paid_at: '2026-11-20T14:00:00Z',
        amount: 7,
        kind: 'charge',
        description: 'Workshop',
        matched: true,
        payer: 'ada',
        seats: 2,
    },
];

let f: Awaited<ReturnType<typeof specFixture>>;
const timings: SpecQueryTiming[] = [];
beforeAll(async () => {
    f = await specFixture([payments(ROWS)], { now: () => NOW, onQuery: (t) => timings.push(t) });
}, 60_000);
afterAll(() => f?.close());

const NY = 'America/New_York';
const sum = { name: 'gross', op: 'sum', field: 'amount' } as const;

describe('windows and time zones', () => {
    it('trailing 12 months on 2026-11-20: December through November, twelve buckets, November partial', async () => {
        const r = await f.run({
            time: { field: 'paid_at', bucket: 'month' },
            window: 'trailing_12_months',
            measures: [sum],
            timeZone: NY,
        });
        expect(r.window).toEqual({ label: 'trailing_12_months', from: '2025-12-01', to: '2026-11-20', partial: true });
        expect(r.rows.map((x) => x.values.paid_at)).toEqual([
            '2025-12-01',
            '2026-01-01',
            '2026-02-01',
            '2026-03-01',
            '2026-04-01',
            '2026-05-01',
            '2026-06-01',
            '2026-07-01',
            '2026-08-01',
            '2026-09-01',
            '2026-10-01',
            '2026-11-01',
        ]);
        expect(r.rows.filter((x) => x.partial).map((x) => x.values.paid_at)).toEqual(['2026-11-01']);
        // October holds the payment made at 03:00 UTC on November 1; empty months are null, not 0.
        expect(r.rows.map((x) => x.values.gross)).toEqual([
            100,
            10,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            5,
            7,
        ]);
    });

    it('buckets an instant by the spec’s zone: just after midnight UTC is the day before in a western zone', async () => {
        const spec = {
            time: { field: 'paid_at', bucket: 'month' },
            window: { between: ['2026-10-01', '2026-11-30'] },
            measures: [sum],
        };
        const ny = await f.run({ ...spec, timeZone: NY });
        const utc = await f.run({ ...spec, timeZone: 'UTC' });
        const tokyo = await f.run({ ...spec, timeZone: 'Asia/Tokyo' });
        expect(ny.rows.map((x) => x.values.gross)).toEqual([5, 7]);
        expect(utc.rows.map((x) => x.values.gross)).toEqual([null, 12]);
        expect(tokyo.rows.map((x) => x.values.gross)).toEqual([null, 12]);
    });

    it('takes the viewer’s zone when the spec has none, and UTC without either', async () => {
        const spec = {
            time: { field: 'paid_at', bucket: 'month' },
            window: { between: ['2026-10-01', '2026-10-31'] },
            measures: [sum],
        };
        expect((await f.run(spec, { timeZone: NY })).rows[0]!.values.gross).toBe(5);
        expect((await f.run(spec)).rows[0]!.values.gross).toBeNull();
    });

    it('filters a datetime by days in the zone, and a date field by its calendar day', async () => {
        const keys = async (filter: FilterNode, timeZone = NY) =>
            (await f.run({ filter, sort: [{ field: 'id', dir: 'asc' }] }, { timeZone })).rows.map((x) => x.values.id);
        expect(await keys({ field: 'paid_at', op: 'is', value: '2026-10-31' })).toEqual([3]);
        expect(await keys({ field: 'paid_at', op: 'is', value: '2026-10-31' }, 'UTC')).toEqual([]);
        expect(await keys({ field: 'paid_at', op: 'within', value: { period: 'this_month' } })).toEqual([5]);
        expect(await keys({ field: 'paid_at', op: 'is', value: 'today' })).toEqual([5]);
        expect(await keys({ field: 'event_on', op: 'within', value: { period: 'previous_year' } })).toEqual([1, 4]);
    });

    it('works across a clock change: each local day is whole', async () => {
        const g = await specFixture(
            [
                payments([
                    // March 8, 2026: New York springs forward at 07:00 UTC.
                    { paid_at: '2026-03-08T04:59:00Z', amount: 1 }, // March 7, 23:59 EST
                    { paid_at: '2026-03-08T05:00:00Z', amount: 2 }, // March 8, 00:00 EST
                    { paid_at: '2026-03-08T06:59:00Z', amount: 4 }, // 01:59 EST
                    { paid_at: '2026-03-08T07:00:00Z', amount: 8 }, // 03:00 EDT
                    { paid_at: '2026-03-09T03:59:00Z', amount: 16 }, // March 8, 23:59 EDT
                    { paid_at: '2026-03-09T04:00:00Z', amount: 32 }, // March 9, 00:00 EDT
                    // November 1, 2026: back at 06:00 UTC; 01:30 happens twice.
                    { paid_at: '2026-11-01T05:30:00Z', amount: 64 }, // 01:30 EDT
                    { paid_at: '2026-11-01T06:30:00Z', amount: 128 }, // 01:30 EST
                    { paid_at: '2026-11-02T04:59:00Z', amount: 256 }, // November 1, 23:59 EST
                ]),
            ],
            { now: () => NOW },
        );
        try {
            const day = async (between: [string, string]) =>
                (
                    await g.run({
                        time: { field: 'paid_at', bucket: 'day' },
                        window: { between },
                        measures: [sum],
                        timeZone: NY,
                    })
                ).rows.map((x) => [x.values.paid_at, x.values.gross]);
            expect(await day(['2026-03-07', '2026-03-09'])).toEqual([
                ['2026-03-07', 1],
                ['2026-03-08', 30],
                ['2026-03-09', 32],
            ]);
            expect(await day(['2026-11-01', '2026-11-01'])).toEqual([['2026-11-01', 448]]);
            // The same days as filters.
            const r = await g.run({
                filter: { field: 'paid_at', op: 'is', value: '2026-03-08' },
                measures: [sum],
                timeZone: NY,
            });
            expect(r.rows[0]!.values.gross).toBe(30);
        } finally {
            g.close();
        }
    });

    it('ytd and previous_year at a year’s end: Los Angeles is still in last year at 01:00 UTC on January 1', async () => {
        const g = await specFixture(
            [
                payments([
                    { paid_at: '2026-12-31T20:00:00Z', amount: 1 },
                    { paid_at: '2027-01-01T00:30:00Z', amount: 2 }, // December 31, 16:30 in Los Angeles
                    { paid_at: '2025-06-01T12:00:00Z', amount: 4 },
                ]),
            ],
            { now: () => Date.UTC(2027, 0, 1, 1) },
        );
        try {
            const spec = { time: { field: 'paid_at' }, windows: ['ytd', 'previous_year'], measures: [sum] };
            const la = await g.run({ ...spec, timeZone: 'America/Los_Angeles' });
            expect(la.today).toBe('2026-12-31');
            expect(la.rows[0]!.values).toEqual({ 'gross:ytd': 3, 'gross:previous_year': 4 });
            const utc = await g.run({ ...spec, timeZone: 'UTC' });
            expect(utc.today).toBe('2027-01-01');
            expect(utc.rows[0]!.values).toEqual({ 'gross:ytd': 2, 'gross:previous_year': 1 });
            expect(utc.windows).toEqual([
                { label: 'ytd', from: '2027-01-01', to: '2027-01-01', partial: true },
                { label: 'previous_year', from: '2026-01-01', to: '2026-12-31', partial: false },
            ]);
        } finally {
            g.close();
        }
    });
});

describe('running values read the source range, then keep the window', () => {
    const january = { between: ['2026-01-01', '2026-01-31'] };
    const running = (from?: string) => ({
        time: { field: 'paid_at', bucket: 'month' },
        window: january,
        measures: [sum, { name: 'balance', running: { of: 'gross', ...(from ? { from } : {}) } }],
        timeZone: NY,
    });

    it('100 in December and 10 in January: a January window shows 110, not 10', async () => {
        const r = await f.run(running());
        expect(r.rows).toEqual([{ values: { paid_at: '2026-01-01', gross: 10, balance: 150 } }]);
        // All history: the March 2025 payment (40) is in the opening balance too.
        expect(r.sourceRange).toEqual({ from: null, to: '2026-01-31' });
    });

    it('from "window" starts at the window; from a date starts there', async () => {
        expect((await f.run(running('window'))).rows[0]!.values.balance).toBe(10);
        expect((await f.run(running('2025-12-01'))).rows[0]!.values.balance).toBe(110);
        const fromMid = await f.run(running('2025-12-15'));
        expect(fromMid.rows[0]!.values.balance).toBe(10);
        expect(fromMid.sourceRange).toEqual({ from: '2025-12-15', to: '2026-01-31' });
    });

    it('carries the balance through empty buckets and into an empty first bucket', async () => {
        const r = await f.run({
            ...running(),
            window: { between: ['2026-02-01', '2026-04-30'] },
        });
        expect(r.rows.map((x) => [x.values.gross, x.values.balance])).toEqual([
            [null, 150],
            [null, 150],
            [null, 150],
        ]);
    });

    it('a running balance is a derived measure over two running sums', async () => {
        const r = await f.run({
            time: { field: 'paid_at', bucket: 'month' },
            window: { between: ['2026-10-01', '2026-11-30'] },
            measures: [
                { name: 'in', op: 'sum', field: 'amount', where: { field: 'kind', op: 'is', value: 'charge' } },
                { name: 'out', op: 'sum', field: 'amount', where: { field: 'kind', op: 'is', value: 'refund' } },
                { name: 'running_in', running: { of: 'in' } },
                { name: 'running_out', running: { of: 'out' } },
                { name: 'balance', expr: { sub: ['running_in', 'running_out'] } },
            ],
            timeZone: NY,
        });
        expect(r.rows.map((x) => x.values.balance)).toEqual([150 - 5, 157 - 5]);
    });

    it('a running value can follow a grouped field', async () => {
        const r = await f.run({
            groupBy: [{ field: 'payer' }],
            measures: [sum, { name: 'cumulative', running: { of: 'gross', order: 'payer' } }],
        });
        expect(r.rows.map((x) => [x.values.payer, x.values.gross, x.values.cumulative])).toEqual([
            ['ada', 112, 112],
            ['u_ben', 10, 122],
            ['u_cam', 40, 162],
        ]);
        expect(r.users).toEqual({ ada: { name: 'Ada' }, u_ben: { name: 'Ben Okafor' }, u_cam: { name: 'Cam Lee' } });
    });
});

describe('this year vs last year, by month (comparison windows with a bucket)', () => {
    const spec = {
        time: { field: 'paid_at', bucket: 'month' },
        windows: ['ytd', 'previous_year'],
        measures: [sum, { name: 'count', op: 'count' }],
        timeZone: NY,
    };

    it('gives one row per month, aligned by place in each window, with each window’s columns', async () => {
        const r = await f.run(spec);
        expect(r.rows).toHaveLength(12);
        expect(r.columns.map((c) => [c.name, c.role, c.window ?? null, c.partial ?? null])).toEqual([
            ['period', 'period', null, null],
            ['paid_at:ytd', 'time', 'ytd', true],
            ['gross:ytd', 'measure', 'ytd', true],
            ['count:ytd', 'measure', 'ytd', true],
            ['paid_at:previous_year', 'time', 'previous_year', false],
            ['gross:previous_year', 'measure', 'previous_year', false],
            ['count:previous_year', 'measure', 'previous_year', false],
        ]);
        expect(r.rows[0]).toEqual({
            values: {
                period: 1,
                'paid_at:ytd': '2026-01-01',
                'gross:ytd': 10,
                'count:ytd': 1,
                'paid_at:previous_year': '2025-01-01',
                'gross:previous_year': null,
                'count:previous_year': 0,
            },
        });
        expect(r.rows[2]!.values['gross:previous_year']).toBe(40);
        // October (the New York day of the November 1 refund) and a partial November.
        expect(r.rows[9]!.values['gross:ytd']).toBe(5);
        expect(r.rows[10]).toMatchObject({ values: { period: 11, 'gross:ytd': 7 }, partial: ['ytd'] });
        // December: last year's only; this year hasn't got one yet (null, not 0).
        expect(r.rows[11]!.values).toEqual({
            period: 12,
            'paid_at:ytd': null,
            'gross:ytd': null,
            'count:ytd': null,
            'paid_at:previous_year': '2025-12-01',
            'gross:previous_year': 100,
            'count:previous_year': 1,
        });
        expect(r.windows!.map((w) => [w.label, w.from, w.to, w.partial])).toEqual([
            ['ytd', '2026-01-01', '2026-11-20', true],
            ['previous_year', '2025-01-01', '2025-12-31', false],
        ]);
        expect(r.sourceRange).toEqual({ from: '2025-01-01', to: '2026-11-20' });
    });

    it('runs a running value within each window, or carries each window’s opening balance', async () => {
        const within = await f.run({
            ...spec,
            measures: [sum, { name: 'cum', running: { of: 'gross', from: 'window' } }],
        });
        expect(within.rows.map((x) => x.values['cum:ytd'])).toEqual([10, 10, 10, 10, 10, 10, 10, 10, 10, 15, 22, null]);
        expect(within.rows.at(-1)!.values['cum:previous_year']).toBe(140);
        const all = await f.run({ ...spec, measures: [sum, { name: 'cum', running: { of: 'gross' } }] });
        expect(all.rows[0]!.values['cum:ytd']).toBe(150);
        expect(all.rows[0]!.values['cum:previous_year']).toBeNull();
        expect(all.rows[2]!.values['cum:previous_year']).toBe(40);
    });

    it('totals each window, and groups align within a window', async () => {
        const r = await f.run({ ...spec, groupBy: [{ field: 'kind' }], totals: true, fill: false });
        expect(r.totals).toEqual({
            'gross:ytd': 22,
            'count:ytd': 3,
            'gross:previous_year': 140,
            'count:previous_year': 2,
        });
        expect(r.rows.find((x) => x.values.period === 10)!.values).toMatchObject({ kind: 'refund', 'gross:ytd': 5 });
    });

    it('without a bucket, gives one column per window (a "vs last year" tile)', async () => {
        const r = await f.run({
            time: { field: 'paid_at' },
            windows: ['ytd', 'previous_year'],
            measures: [sum],
            timeZone: NY,
        });
        expect(r.rows).toEqual([{ values: { 'gross:ytd': 22, 'gross:previous_year': 140 } }]);
    });

    it('refuses a display window beside comparison windows', async () => {
        expect(await f.refusal({ ...spec, window: 'ytd' })).toEqual([
            {
                path: '$.window',
                message:
                    'Use window or windows, not both: comparison windows are each shown whole, one column per window (with a bucket, one series per window).',
            },
        ]);
    });
});

describe('grouping, segments, measures and totals', () => {
    it('segments: the first rule that matches wins, and the rest go to "other"', async () => {
        const r = await f.run({
            groupBy: [{ segment: 'category' }],
            segments: {
                name: 'category',
                field: 'description',
                rules: [
                    { label: 'Refunds', when: { field: 'description', op: 'contains', value: 'refund' } },
                    { label: 'Memberships', when: { field: 'description', op: 'contains', value: 'MEMBERSHIP' } },
                ],
                other: 'Other',
            },
            measures: [sum],
        });
        expect(r.rows.map((x) => [x.values.category, x.values.gross])).toEqual([
            ['Refunds', 5],
            ['Memberships', 140],
            ['Other', 17],
        ]);
    });

    it('groups selects in option order with empty last, numbers by step, checkboxes as booleans', async () => {
        const byKind = await f.run({ groupBy: [{ field: 'kind' }], measures: [{ name: 'n', op: 'count' }] });
        expect(byKind.rows.map((x) => x.values.kind)).toEqual(['charge', 'refund']);
        const bySeats = await f.run({
            groupBy: [{ field: 'amount', bucket: { step: 50 } }],
            measures: [{ name: 'n', op: 'count' }],
        });
        expect(bySeats.rows.map((x) => [x.values.amount, x.values.n])).toEqual([
            [0, 4],
            [100, 1],
        ]);
        const byMatched = await f.run({ groupBy: [{ field: 'matched' }], measures: [{ name: 'n', op: 'count' }] });
        expect(byMatched.rows.map((x) => [x.values.matched, x.values.n])).toEqual([
            [false, 1],
            [true, 4],
        ]);
    });

    it('derived measures: null on zero, null stays null, never 0', async () => {
        const r = await f.run({
            groupBy: [{ field: 'kind' }],
            measures: [
                { name: 'refunds', op: 'sum', field: 'amount', where: { field: 'kind', op: 'is', value: 'refund' } },
                { name: 'gross', op: 'sum', field: 'amount' },
                { name: 'share', expr: { div: ['refunds', 'gross'] } },
                { name: 'zero', expr: { div: ['gross', 0] } },
                { name: 'avg_seats', op: 'avg', field: 'seats' },
            ],
        });
        expect(r.rows.map((x) => x.values)).toEqual([
            { kind: 'charge', refunds: null, gross: 157, share: null, zero: null, avg_seats: 2 },
            { kind: 'refund', refunds: 5, gross: 5, share: 1, zero: null, avg_seats: null },
        ]);
    });

    it('totals come from the database, so a cut-short answer still has them', async () => {
        const many = Array.from({ length: 30 }, (_, i) => ({
            paid_at: `2026-0${(i % 9) + 1}-10T12:00:00Z`,
            amount: i + 1,
            description: `Acme ${i}`,
        }));
        const g = await specFixture([payments(many)], { now: () => NOW }, { queryMaxRows: 10 });
        try {
            const r = await g.run({
                groupBy: [{ field: 'description' }],
                measures: [sum, { name: 'avg', op: 'avg', field: 'amount' }],
                totals: true,
            });
            expect(r.truncated).toBe(true);
            expect(r.rows.length).toBeLessThan(30);
            expect(r.totals).toEqual({ gross: 465, avg: 15.5 });
            const view = await g.run({ totals: true, groupBy: [{ field: 'description' }] });
            expect(view.truncated).toBe(true);
            expect(view.totals).toEqual({ count: 30 });
        } finally {
            g.close();
        }
    });

    it('unverified rows: marked per group, left out of totals and derived measures, and reported', async () => {
        const r = await f.run({
            source: { dataset: f.dataset.id, table: 'payments', verified: { field: 'matched', op: 'is', value: true } },
            groupBy: [{ field: 'kind' }],
            measures: [sum, { name: 'net', expr: { mul: ['gross', 1] } }],
            totals: true,
        });
        expect(r.rows).toEqual([
            { values: { kind: 'charge', gross: 157, net: 147 }, unverified: true },
            { values: { kind: 'refund', gross: 5, net: 5 } },
        ]);
        expect(r.totals).toEqual({ gross: 152, net: 152 });
        expect(r.excluded).toEqual({ rows: 1, value: { gross: 10 } });
    });

    it('two groupings get subtotals by each: a total row and a total column', async () => {
        const r = await f.run({
            time: { field: 'paid_at', bucket: 'year' },
            groupBy: [{ field: 'kind' }],
            measures: [sum],
            totals: true,
            fill: false,
            timeZone: NY,
        });
        expect(r.subtotals).toEqual({
            paid_at: [
                { values: { paid_at: '2025-01-01', gross: 140 } },
                { values: { paid_at: '2026-01-01', gross: 22 }, partial: true },
            ],
            kind: [{ values: { kind: 'charge', gross: 157 } }, { values: { kind: 'refund', gross: 5 } }],
        });
        expect(r.totals).toEqual({ gross: 162 });
    });

    it('a fallback date counts how many rows used each field', async () => {
        const r = await f.run({
            time: { field: { coalesce: ['event_on', 'inferred_on'] }, bucket: 'year' },
            window: { between: ['2025-01-01', '2026-12-31'] },
            measures: [sum],
            fill: false,
        });
        expect(r.coverage).toEqual({ fields: { event_on: 3, inferred_on: 1 }, none: 1 });
        expect(r.rows.map((x) => [x.values.event_on, x.values.gross])).toEqual([
            ['2025-01-01', 140],
            ['2026-01-01', 15],
        ]);
    });

    it('fills empty buckets by default (count 0, sums null), or not', async () => {
        const spec = {
            time: { field: 'paid_at', bucket: 'month' },
            window: { between: ['2026-01-01', '2026-03-31'] },
            measures: [sum, { name: 'n', op: 'count' }],
            timeZone: NY,
        };
        expect((await f.run(spec)).rows.map((x) => [x.values.n, x.values.gross])).toEqual([
            [1, 10],
            [0, null],
            [0, null],
        ]);
        expect((await f.run({ ...spec, fill: false })).rows).toHaveLength(1);
    });

    it('sorts an aggregate by a measure, empty last', async () => {
        const r = await f.run({
            groupBy: [{ field: 'payer' }],
            measures: [sum],
            sort: [{ field: 'gross', dir: 'desc' }],
        });
        expect(r.rows.map((x) => x.values.payer)).toEqual(['ada', 'u_cam', 'u_ben']);
    });

    it('a view: rows with keys, a date bucket and segments as columns, and a window on its time field', async () => {
        const r = await f.run({
            time: { field: 'paid_at' },
            window: 'ytd',
            groupBy: [{ field: 'paid_at', bucket: 'month' }],
            segments: {
                name: 'big',
                rules: [{ label: 'Big', when: { field: 'amount', op: 'gte', value: 10 } }],
                other: 'Small',
            },
            timeZone: NY,
        });
        expect(r.rows.map((x) => [x.key, x.values['paid_at:month'], x.values.big])).toEqual([
            ['2', '2026-01-01', 'Big'],
            ['3', '2026-10-01', 'Small'],
            ['5', '2026-11-01', 'Small'],
        ]);
    });
});

describe('injection attempts and limits', () => {
    const evil = `x'); DROP TABLE payments; --`;

    async function compiled(spec: Record<string, unknown>) {
        const table = f.space.detailFor('u_ana', f.dataset.id).tables.find((t) => t.name === 'payments')!;
        const input = { source: { dataset: f.dataset.id, table: 'payments' }, ...spec };
        const check = checkSpec(input, { table, settings: PAYMENT_SETTINGS });
        expect(check.problems).toEqual([]);
        return compileSpec({
            spec: check.spec!,
            fields: specFields(table.columns, PAYMENT_SETTINGS),
            table,
            timeZone: NY,
            now: NOW,
            me: evil,
        });
    }

    it('binds every value, label and constant as a parameter, never as SQL text', async () => {
        const spec = {
            filter: {
                any: [
                    { field: 'description', op: 'contains', value: evil },
                    { field: 'description', op: 'is', value: `"; SELECT * FROM sqlite_master; --` },
                    { field: 'payer', op: 'is', value: { $me: true } },
                ],
            },
            segments: {
                name: 'seg',
                rules: [{ label: evil, when: { field: 'description', op: 'starts_with', value: evil } }],
                other: `${evil} other`,
            },
            groupBy: [{ segment: 'seg' }],
            measures: [sum, { name: 'odd', expr: { mul: ['gross', 1.5] } }],
        };
        const { sql, params } = await compiled(spec);
        expect(sql).not.toContain('DROP');
        expect(sql).not.toContain('sqlite_master');
        expect(sql).not.toContain('1.5');
        expect(params).toContain(evil.toLowerCase().replace(/[A-Z]/g, (c) => c.toLowerCase()));
        expect(params).toContain(evil);
        // Nothing matches (no group to show), and the same spec over every row puts them in "other".
        expect((await f.run(spec)).rows).toEqual([]);
        const { filter: _, ...unfiltered } = spec;
        expect((await f.run(unfiltered)).rows).toEqual([{ values: { seg: `${evil} other`, gross: 162, odd: 243 } }]);
        // The table is still there.
        expect((await f.run({ measures: [{ name: 'n', op: 'count' }] })).rows[0]!.values.n).toBe(ROWS.length);
    });

    it('refuses field names that aren’t the table’s, with their paths', async () => {
        expect(await f.refusal({ filter: { field: 'amount" FROM payments; --', op: 'is_empty' } })).toEqual([
            { path: '$.filter.field', message: 'Unknown field "amount\\" FROM payments; --" in table "payments".' },
        ]);
        expect(await f.refusal({ sort: [{ field: 'sqlite_master', dir: 'asc' }] })).toEqual([
            { path: '$.sort[0].field', message: 'Unknown field "sqlite_master" in table "payments".' },
        ]);
    });

    it('substitutes dashboard parameters before checking, as values', async () => {
        const answer = await f.runner.run('u_ana', {
            spec: {
                source: { dataset: f.dataset.id, table: 'payments' },
                filter: { field: 'kind', op: 'is_any_of', value: [{ $param: 'kinds' }] },
                measures: [sum],
            },
            params: { kinds: ['refund'] },
        });
        expect(answer).toMatchObject({ rows: [{ values: { gross: 5 } }] });
        const injected = await f.runner.run('u_ana', {
            spec: {
                source: { dataset: f.dataset.id, table: 'payments' },
                filter: { field: 'kind', op: 'is', value: { $param: 'k' } },
            },
            params: { k: evil },
        });
        expect(injected).toMatchObject({ ok: false, problems: [{ path: '$.filter.value' }] });
    });

    it('runs a spec at the limits: 500 conditions and 5,000 values in one statement, refusing one more', async () => {
        const list = (n: number) => Array.from({ length: n }, (_, i) => i);
        // 5,000 values: 50 conditions of 100 values.
        const wide: FilterNode = {
            any: Array.from(
                { length: QUERY_SPEC_LIMITS.filterConditions },
                () => ({ field: 'description', op: 'is', value: 'x' }) as FilterNode,
            ),
        };
        const values = {
            filter: {
                any: Array.from({ length: 50 }, (_, k) => ({ field: 'amount', op: 'eq', value: k }) as FilterNode),
            },
            segments: [0, 1, 2].map((s) => ({
                name: `s${s}`,
                rules: Array.from({ length: 50 }, (_, r) => ({
                    label: `r${r}`,
                    when: { field: 'seats', op: 'eq', value: s * 1000 + r },
                })),
                other: 'other',
            })),
            measures: Array.from({ length: 6 }, (_, m) => ({
                name: `m${m}`,
                op: 'count',
                where: {
                    any: Array.from({ length: 50 }, (_, k) => ({
                        field: 'amount',
                        op: 'eq',
                        value: 10_000 + m * 100 + k,
                    })),
                },
            })),
        };
        // 50 + 150 + 300 = 500 conditions.
        const at = await f.run(values);
        expect(at.rows).toHaveLength(1);
        const over = await f.refusal({
            ...values,
            source: { dataset: f.dataset.id, table: 'payments', verified: { field: 'amount', op: 'gt', value: 0 } },
        });
        expect(over).toEqual([
            {
                path: '$',
                message:
                    'This spec has 501 conditions; at most 500 across its filter, measures, segments and verified rows.',
            },
        ]);
        expect(wide.any).toHaveLength(50);
        const manyValues = {
            filter: {
                any: Array.from({ length: 50 }, (_, k) => ({
                    field: 'kind',
                    op: 'is_any_of',
                    value: list(100).map((i) => ((i + k) % 2 ? 'charge' : 'refund')),
                })),
            },
            measures: [sum],
        };
        expect((await f.run(manyValues)).rows[0]!.values.gross).toBe(162);
        expect(
            await f.refusal({ ...manyValues, measures: [{ ...sum, where: { field: 'amount', op: 'eq', value: 1 } }] }),
        ).toEqual([{ path: '$', message: 'This spec has 5001 values; at most 5000.' }]);
    });
});

describe('the cache, the rate and the timings hook', () => {
    it('reuses an answer per dataset version, statement and viewer, never across viewers', async () => {
        const spec = {
            source: { dataset: f.dataset.id, table: 'payments' },
            filter: { field: 'payer', op: 'is', value: { $me: true } },
            measures: [sum],
        };
        const first = await f.runner.run('u_ana', { spec });
        const again = await f.runner.run('u_ana', { spec });
        expect(first).toMatchObject({ cached: false });
        expect(again).toMatchObject({ cached: true });
        // A new write is a new version.
        await f.space.write(f.socio, f.dataset.id, {
            op: 'insert',
            table: 'payments',
            rows: [{ id: 99, amount: 0, payer: 'u_ana' }],
        });
        expect(await f.runner.run('u_ana', { spec })).toMatchObject({ cached: false });
    });

    it('reports each query’s timings and outcome, without its values or who asked', () => {
        expect(timings.length).toBeGreaterThan(10);
        const t = timings.at(-1)!;
        expect(Object.keys(t).sort()).toEqual(
            [
                'bytes',
                'cached',
                'engine',
                'outcome',
                'readMs',
                'rows',
                'sourceKind',
                'sourceRef',
                'startedAt',
                'surface',
                'totalMs',
            ].sort(),
        );
        expect(t).toMatchObject({
            sourceKind: 'dataset',
            sourceRef: `${f.dataset.id}/payments`,
            engine: 'sqlite',
            surface: 'view',
            outcome: 'ok',
        });
        expect(JSON.stringify(timings)).not.toContain('u_ana');
        expect(timings.some((x) => x.cached)).toBe(true);
    });

    it('limits runs per viewer that miss the cache', async () => {
        const g = await specFixture([payments(ROWS)], { now: () => NOW, perMinute: 2 });
        try {
            await g.run({ measures: [sum] });
            await g.run({ measures: [{ name: 'n', op: 'count' }] });
            await expect(g.run({ measures: [{ name: 'x', op: 'max', field: 'amount' }] })).rejects.toThrow(
                /at most 2 a minute/,
            );
        } finally {
            g.close();
        }
    });

    it('answers only a person who may read the dataset', async () => {
        await expect(f.run({ measures: [sum] }, { as: 'u_ben' })).rejects.toThrow('Dataset not found.');
    });
});

describe('review: bounded statements, cache keys, calendars (CB-451 review)', () => {
    it('compiles derived measures once each: the statement grows with the spec, not with its references', async () => {
        const table = f.space.detailFor('u_ana', f.dataset.id).tables.find((t) => t.name === 'payments')!;
        const measures: Array<Record<string, unknown>> = [sum];
        for (let i = 1; i <= 19; i++) {
            measures.push({
                name: `d${i}`,
                expr: { add: Array.from({ length: 10 }, () => (i === 1 ? 'gross' : `d${i - 1}`)) },
            });
        }
        const input = {
            source: { dataset: f.dataset.id, table: 'payments' },
            groupBy: [{ field: 'kind' }],
            measures,
            totals: true,
        };
        const check = checkSpec(input, { table, settings: PAYMENT_SETTINGS });
        expect(check.problems).toEqual([]);
        const { sql } = compileSpec({
            spec: check.spec!,
            fields: specFields(table.columns, PAYMENT_SETTINGS),
            table,
            timeZone: NY,
            now: NOW,
            me: 'u_ana',
        });
        expect(sql.length).toBeLessThan(40_000);
        const r = await f.run({
            filter: { field: 'kind', op: 'is_not_empty' },
            groupBy: [{ field: 'kind' }],
            measures: measures.slice(0, 4),
            totals: true,
        });
        expect(r.rows.map((x) => x.values.d3)).toEqual([157_000, 5_000]);
        expect(r.totals).toMatchObject({ d3: 162_000 });
    });

    it('never answers one spec with another’s names from the cache', async () => {
        const g = await specFixture([payments(ROWS)], { now: () => NOW });
        try {
            const spec = (name: string) => ({
                source: { dataset: g.dataset.id, table: 'payments' },
                measures: [{ name, op: 'sum', field: 'amount' }],
            });
            expect(await g.runner.run('u_ana', { spec: spec('gross') })).toMatchObject({
                rows: [{ values: { gross: 162 } }],
            });
            expect(await g.runner.run('u_ana', { spec: spec('revenue') })).toMatchObject({
                rows: [{ values: { revenue: 162 } }],
            });
            const seg = (label: string) => ({
                source: { dataset: g.dataset.id, table: 'payments' },
                groupBy: [{ segment: 's' }],
                segments: {
                    name: 's',
                    rules: [{ label, when: { field: 'amount', op: 'gt', value: 0 } }],
                    other: 'Other',
                },
                measures: [{ name: 'n', op: 'count' }],
            });
            await g.runner.run('u_ana', { spec: seg('Paid') });
            expect(await g.runner.run('u_ana', { spec: seg('Charged') })).toMatchObject({
                rows: [{ values: { s: 'Charged' } }],
            });
        } finally {
            g.close();
        }
    });

    it('without filling, keeps every bucket however far apart; filling past the cap is refused, never cut', async () => {
        const g = await specFixture(
            [
                payments([
                    { paid_at: '2000-01-01T12:00:00Z', amount: 1 },
                    { paid_at: '2026-11-20T12:00:00Z', amount: 2 },
                ]),
            ],
            { now: () => NOW },
        );
        try {
            const r = await g.run({ time: { field: 'paid_at', bucket: 'day' }, measures: [sum], fill: false });
            expect(r.rows.map((x) => [x.values.paid_at, x.values.gross])).toEqual([
                ['2000-01-01', 1],
                ['2026-11-20', 2],
            ]);
            await expect(g.run({ time: { field: 'paid_at', bucket: 'day' }, measures: [sum] })).rejects.toThrow(
                /5,000 day buckets/,
            );
            await expect(
                g.run({
                    time: { field: 'paid_at', bucket: 'day' },
                    window: { between: ['2000-01-01', '2026-11-20'] },
                    measures: [sum],
                }),
            ).rejects.toThrow(/5,000 day buckets/);
            const months = await g.run({ time: { field: 'paid_at', bucket: 'year' }, measures: [sum] });
            expect(months.rows).toHaveLength(27);
        } finally {
            g.close();
        }
    });

    it('runs a time bucket without measures', async () => {
        const r = await f.run({ time: { field: 'paid_at', bucket: 'year' }, timeZone: NY });
        expect(r.rows.map((x) => x.values)).toEqual([{ paid_at: '2025-01-01' }, { paid_at: '2026-01-01' }]);
    });
});

describe('review 2: running values per bucket, in group order, and specs without base measures', () => {
    it('a running value over a non-additive measure is the same whatever window shows it', async () => {
        const g = await specFixture(
            [
                payments([
                    { paid_at: '2026-01-05T12:00:00Z', amount: 5 },
                    { paid_at: '2026-01-20T12:00:00Z', amount: 15 },
                    { paid_at: '2026-02-10T12:00:00Z', amount: 20 },
                    { paid_at: '2026-03-10T12:00:00Z', amount: 0 },
                ]),
            ],
            { now: () => NOW },
        );
        try {
            const spec = (between: [string, string]) => ({
                time: { field: 'paid_at', bucket: 'month' },
                window: { between },
                measures: [
                    { name: 'avg', op: 'avg', field: 'amount' },
                    { name: 'run', running: { of: 'avg' } },
                ],
                timeZone: 'UTC',
            });
            const wide = await g.run(spec(['2026-01-01', '2026-03-31']));
            const narrow = await g.run(spec(['2026-03-01', '2026-03-31']));
            expect(wide.rows.map((x) => x.values.run)).toEqual([10, 30, 30]);
            expect(narrow.rows.map((x) => x.values.run)).toEqual([30]);
            // A window starting mid-month: January's earlier rows are history, not part of the first bucket.
            const mid = await g.run(spec(['2026-01-10', '2026-02-28']));
            expect(mid.rows.map((x) => [x.values.avg, x.values.run])).toEqual([
                [15, 20],
                [20, 40],
            ]);
        } finally {
            g.close();
        }
    });

    it('a running value over a select follows its option order, not the ids', async () => {
        const g = await specFixture(
            [
                {
                    ...payments([
                        { kind: 'refund', amount: 10 },
                        { kind: 'charge', amount: 20 },
                    ]),
                    settings: [
                        {
                            column: 'kind',
                            kind: 'select',
                            settings: {
                                options: [
                                    { id: 'refund', label: 'Refund' },
                                    { id: 'charge', label: 'Charge' },
                                ],
                            },
                        },
                    ],
                },
            ],
            { now: () => NOW },
        );
        try {
            const r = await g.run({
                groupBy: [{ field: 'kind' }],
                measures: [sum, { name: 'cum', running: { of: 'gross', order: 'kind' } }],
            });
            expect(r.rows.map((x) => [x.values.kind, x.values.cum])).toEqual([
                ['refund', 10],
                ['charge', 30],
            ]);
        } finally {
            g.close();
        }
    });

    it('runs a bucket with totals and no measures, and a constant-only measure', async () => {
        const r = await f.run({ time: { field: 'paid_at', bucket: 'year' }, totals: true, fill: false, timeZone: NY });
        expect(r.rows.map((x) => x.values.paid_at)).toEqual(['2025-01-01', '2026-01-01']);
        expect(r.totals).toEqual({});
        const c = await f.run({ measures: [{ name: 'constant', expr: 5 }], totals: true });
        expect(c.rows).toEqual([{ values: { constant: 5 } }]);
        expect(c.totals).toEqual({ constant: 5 });
    });
});
