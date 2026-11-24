/**
 * The query spec (CB-451): what a view, a dashboard block, an agent
 * tool or a plugin page asks of one source, as typed JSON instead of
 * SQL. This schema checks its shape; the server checks it against the
 * source's live columns and field kinds
 * (`src/server/dataspace/query-spec/`) and compiles it to parameterized
 * SQL. Nothing here holds SQL, and nothing a person sends ever becomes
 * SQL text: field names must name real columns, and values are bound as
 * parameters.
 */
import { z } from 'zod';

import { FILTER_OPS, type FilterOp } from './operators.js';

/** The limits of one spec, checked when it is validated. */
export const QUERY_SPEC_LIMITS = {
    /** A filter's groups: the outer group and one level inside it. */
    filterDepth: 2,
    /** Conditions in one filter. */
    filterConditions: 50,
    /** Conditions across the whole spec (filter, measures, segments, verified), so a spec stays one statement SQLite can bind. */
    specConditions: 500,
    /** Values across the whole spec, list items counted one by one. */
    specValues: 5_000,
    /** Items in one list value (`is_any_of`, `has_all_of`, …). */
    listValues: 100,
    /** Characters in one text value. */
    textValue: 1_000,
    sorts: 5,
    /** Groupings of a query without measures (a view). */
    viewGroups: 2,
    /** Groupings of an aggregate (with measures or a time bucket). */
    aggregateGroups: 3,
    measures: 20,
    /** Operands and operators in one derived measure. */
    exprNodes: 20,
    exprDepth: 4,
    segments: 3,
    segmentRules: 50,
    /** Comparison windows of one block (`windows`). */
    windows: 4,
    /** Fields a time fallback may list (`coalesce`). */
    coalesce: 4,
    /** Days, weeks, … a relative date or `last_n` may count. */
    relativeCount: 3_660,
} as const;

/** A column name as a spec names it; the server checks it is one of the table's. */
const fieldName = z.string().min(1).max(128);
/** A measure, segment or parameter name: letters, digits and `_`. */
export const SPEC_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const name = z.string().regex(SPEC_NAME, 'Use letters, digits and _ (up to 63, starting with a letter or _).');

/** An ISO calendar date, `2026-11-20`. */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** An ISO date and time, with an optional offset; without one it is in the spec's zone. */
export const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/;

/** Whether `value` is a real calendar date (`2026-02-30` is not). */
export function isCalendarDate(value: string) {
    if (!ISO_DATE.test(value)) {
        return false;
    }
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Whether `value` is a real ISO date and time (`2026-11-20T25:00` is not). */
export function isIsoDateTime(value: string) {
    if (!ISO_DATETIME.test(value) || !isCalendarDate(value.slice(0, 10))) {
        return false;
    }
    const [hour, minute, second = '0'] = value
        .slice(11, 19)
        .replace(/[Z+-].*$/, '')
        .split(':');
    const offset = /([+-])(\d{2}):(\d{2})$/.exec(value);
    return (
        Number(hour) <= 23 &&
        Number(minute) <= 59 &&
        Number(second) <= 59 &&
        (!offset || (Number(offset[2]) <= 14 && Number(offset[3]) <= 59))
    );
}

export const RELATIVE_UNITS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export type RelativeUnit = (typeof RELATIVE_UNITS)[number];
/** Whole calendar periods a date filter may name (`within`). Weeks start on Monday. */
export const DATE_PERIODS = [
    'this_week',
    'this_month',
    'this_quarter',
    'this_year',
    'previous_week',
    'previous_month',
    'previous_quarter',
    'previous_year',
    'next_week',
    'next_month',
    'next_quarter',
    'next_year',
] as const;
export type DatePeriod = (typeof DATE_PERIODS)[number];

const count = z.number().int().min(1).max(QUERY_SPEC_LIMITS.relativeCount);

/** The viewer: resolved per person, so results differ by who looks. */
export const meToken = z.object({ $me: z.literal(true) }).strict();
/** A dashboard parameter, by name. */
export const paramToken = z.object({ $param: name }).strict();
/** The last or next `count` units, today included. */
export const relativeDate = z
    .object({ relative: z.enum(['past', 'next']), count, unit: z.enum(RELATIVE_UNITS) })
    .strict();
/** A whole calendar period around today. */
export const periodDate = z.object({ period: z.enum(DATE_PERIODS) }).strict();

/**
 * A filter value: a literal, or a token the server resolves. The string
 * `today` is a token only where a date is expected (a literal date is
 * always `YYYY-MM-DD`, so it can't be mistaken for one).
 */
const scalar = z.union([z.string().max(QUERY_SPEC_LIMITS.textValue), z.number(), z.boolean()]);
const token = z.union([meToken, paramToken, relativeDate, periodDate]);
const item = z.union([scalar, token]);
export const filterValue = z.union([item, z.array(item).max(QUERY_SPEC_LIMITS.listValues)]);
export type FilterValue = z.infer<typeof filterValue>;

export interface FilterCondition {
    field: string;
    op: FilterOp;
    value?: FilterValue;
}
export interface FilterAll {
    all: FilterNode[];
}
export interface FilterAny {
    any: FilterNode[];
}
export type FilterGroup = FilterAll | FilterAny;
/** A condition, or a group of conditions and groups. */
export type FilterNode = FilterCondition | FilterGroup;

export const filterCondition = z
    .object({
        field: fieldName,
        op: z.enum(FILTER_OPS),
        value: filterValue.optional(),
    })
    .strict();
// Structurally recursive; the server holds it to two levels and the
// condition counts (QUERY_SPEC_LIMITS), with a path for each problem.
export const filterNode: z.ZodType<FilterNode> = z.lazy(() =>
    z.union([
        filterCondition,
        z.object({ all: z.array(filterNode).min(1).max(QUERY_SPEC_LIMITS.filterConditions) }).strict(),
        z.object({ any: z.array(filterNode).min(1).max(QUERY_SPEC_LIMITS.filterConditions) }).strict(),
    ]),
);

/** A dataset table, or a plugin's declared data source. */
export const querySource = z.union([
    z
        .object({
            dataset: z.string().min(1).max(64),
            table: fieldName,
            /** The rows that count as verified. */
            verified: filterNode.optional(),
        })
        .strict(),
    z
        .object({
            plugin: z.string().min(1).max(64),
            source: fieldName,
            verified: filterNode.optional(),
        })
        .strict(),
]);
export type QuerySource = z.infer<typeof querySource>;

export const SORT_DIRS = ['asc', 'desc'] as const;
export const querySort = z
    .object({
        field: fieldName,
        dir: z.enum(SORT_DIRS).default('asc'),
        empty: z.enum(['first', 'last']).optional(),
    })
    .strict();
export type QuerySort = z.infer<typeof querySort>;

export const DATE_BUCKETS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export type DateBucket = (typeof DATE_BUCKETS)[number];
export const queryGroup = z.union([
    z
        .object({
            field: fieldName,
            /** A date bucket for date fields; `{ step }` for numbers. */
            bucket: z.union([z.enum(DATE_BUCKETS), z.object({ step: z.number().positive() }).strict()]).optional(),
        })
        .strict(),
    z.object({ segment: name }).strict(),
]);
export type QueryGroup = z.infer<typeof queryGroup>;

export const BASE_MEASURE_OPS = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'] as const;
export type BaseMeasureOp = (typeof BASE_MEASURE_OPS)[number];

/** A derived measure's arithmetic: measure names, numbers, `add`, `sub`, `mul`, `div`. */
export type MeasureExpr =
    | string
    | number
    | { add: MeasureExpr[] }
    | { sub: MeasureExpr[] }
    | { mul: MeasureExpr[] }
    | { div: MeasureExpr[] };
export const measureExpr: z.ZodType<MeasureExpr> = z.lazy(() =>
    z.union([
        name,
        z.number(),
        z.object({ add: z.array(measureExpr).min(2).max(10) }).strict(),
        z.object({ sub: z.array(measureExpr).length(2) }).strict(),
        z.object({ mul: z.array(measureExpr).min(2).max(10) }).strict(),
        z.object({ div: z.array(measureExpr).length(2) }).strict(),
    ]),
);

export const baseMeasure = z
    .object({
        name,
        op: z.enum(BASE_MEASURE_OPS),
        /** Absent for `count`: rows. */
        field: fieldName.optional(),
        /** A filtered measure. */
        where: filterNode.optional(),
        /** The rows of this measure that count as verified. */
        verified: filterNode.optional(),
    })
    .strict();
export const derivedMeasure = z.object({ name, expr: measureExpr }).strict();
/**
 * A running value: the cumulative sum of another measure over the
 * result's order. `from: "all"` (the default) or a date carries the
 * opening balance into the first bucket shown.
 */
export const runningMeasure = z
    .object({
        name,
        running: z
            .object({
                of: name,
                /** The time field or a grouped field; the time bucket when absent. */
                order: fieldName.optional(),
                from: z.union([z.enum(['window', 'all']), z.string().regex(ISO_DATE)]).optional(),
            })
            .strict(),
    })
    .strict();
export const queryMeasure = z.union([baseMeasure, derivedMeasure, runningMeasure]);
export type BaseMeasure = z.infer<typeof baseMeasure>;
export type DerivedMeasure = z.infer<typeof derivedMeasure>;
export type RunningMeasure = z.infer<typeof runningMeasure>;
export type QueryMeasure = z.infer<typeof queryMeasure>;

/** Windows relative to today in the spec's zone. */
export const NAMED_WINDOWS = ['ytd', 'previous_year', 'trailing_12_months', 'this_month', 'previous_month'] as const;
export type NamedWindow = (typeof NAMED_WINDOWS)[number];
export const queryWindow = z.union([
    z.enum(NAMED_WINDOWS),
    z.object({ last_n: z.object({ count, unit: z.enum(RELATIVE_UNITS) }).strict() }).strict(),
    z.object({ between: z.tuple([z.string().regex(ISO_DATE), z.string().regex(ISO_DATE)]) }).strict(),
]);
export type QueryWindow = z.infer<typeof queryWindow>;

/** The date a query sums by: one field, or the first non-empty of several. */
export const timeField = z.union([
    fieldName,
    z.object({ coalesce: z.array(fieldName).min(2).max(QUERY_SPEC_LIMITS.coalesce) }).strict(),
]);
export const queryTime = z
    .object({
        field: timeField,
        bucket: z.enum(DATE_BUCKETS).optional(),
    })
    .strict();
export type QueryTime = z.infer<typeof queryTime>;

/** A computed grouping from ordered rules; the first that matches wins. */
export const querySegment = z
    .object({
        name,
        /** The field the rules are mostly about, for display. */
        field: fieldName.optional(),
        rules: z
            .array(z.object({ label: z.string().trim().min(1).max(80), when: filterNode }).strict())
            .min(1)
            .max(QUERY_SPEC_LIMITS.segmentRules),
        /** The bucket for rows no rule matches; required, so nothing disappears. */
        other: z.string().trim().min(1).max(80),
    })
    .strict();
export type QuerySegment = z.infer<typeof querySegment>;

export const querySpec = z
    .object({
        source: querySource,
        filter: filterNode.optional(),
        sort: z.array(querySort).max(QUERY_SPEC_LIMITS.sorts).optional(),
        groupBy: z.array(queryGroup).max(QUERY_SPEC_LIMITS.aggregateGroups).optional(),
        measures: z.array(queryMeasure).max(QUERY_SPEC_LIMITS.measures).optional(),
        time: queryTime.optional(),
        /** The display window: the buckets or rows the block shows. */
        window: queryWindow.optional(),
        /** Comparison windows: one column per window and measure (a "vs last year" tile). */
        windows: z.array(queryWindow).min(1).max(QUERY_SPEC_LIMITS.windows).optional(),
        /** One segment, or a list of them. */
        segments: z.union([querySegment, z.array(querySegment).min(1).max(QUERY_SPEC_LIMITS.segments)]).optional(),
        /** A total row (and column, for two-way groupings), computed by the database. */
        totals: z.boolean().optional(),
        /** An IANA zone; views default to the viewer's, dashboards to the workspace's. */
        timeZone: z.string().min(1).max(64).optional(),
        /** Fill empty time buckets (the default for time buckets). */
        fill: z.boolean().optional(),
    })
    .strict();
export type QuerySpec = z.infer<typeof querySpec>;
export type QuerySpecInput = z.input<typeof querySpec>;

/** A spec's segments as a list, whichever form it used. */
export const specSegments = (spec: Pick<QuerySpec, 'segments'>): QuerySegment[] =>
    spec.segments === undefined ? [] : Array.isArray(spec.segments) ? spec.segments : [spec.segments];

/** One problem of a spec: a JSON path into it (`$.filter.all[1].op`) and what is wrong. */
export interface SpecProblem {
    path: string;
    message: string;
}

/** The answer of `POST /api/data/specs/validate`. */
export interface SpecValidation {
    ok: boolean;
    problems: SpecProblem[];
    /** The engine the spec would run on, when it is valid: SQLite for transactional tables, DuckDB for analytical ones. */
    engine?: 'sqlite' | 'duckdb';
}

/** The validate route's body: the spec, and the dashboard parameters it may use. */
export const specValidateBody = z
    .object({
        spec: z.unknown(),
        params: z.array(name).max(50).optional(),
    })
    .strict();
export type SpecValidateBody = z.infer<typeof specValidateBody>;

/** A JSON path as problems give it: `$`, `.key`, `[index]`. */
export function specPath(parts: ReadonlyArray<string | number | symbol>) {
    let out = '$';
    for (const part of parts) {
        if (typeof part === 'number') {
            out += `[${part}]`;
        } else {
            const key = String(part);
            out += /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
        }
    }
    return out;
}
