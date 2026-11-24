/**
 * What running a query spec answers (CB-451): typed columns and
 * rows, totals the database computed, and the dates the answer covers.
 * `POST /api/data/specs/run` answers it; blocks and views draw from it.
 */
import { z } from 'zod';

import type { DateRange } from './dates.js';
import type { FieldKind } from './kinds.js';
import { filterValue, SPEC_NAME } from './spec.js';

/** One column of a result. */
export interface SpecColumn {
    /** The key in each row's `values`: a field, a grouping, a measure, or `<measure>:<window>`. */
    name: string;
    /** What it holds: a field's kind, `number` for counts and arithmetic. */
    kind: FieldKind;
    /**
     * Where it comes from: a table field (a row of a view), a grouping, the
     * time bucket, a segment, a measure, or `period` (the bucket's place in
     * each window, for windows with a bucket).
     */
    role: 'field' | 'group' | 'time' | 'segment' | 'measure' | 'period';
    /** The field it reads, for fields, groupings and base measures. */
    field?: string;
    /** The measure, for a measure column. */
    measure?: string;
    /** The comparison window's label, for a column of one (`ytd`, `previous_year`, `last_30_day`). */
    window?: string;
    /** The column's window contains today. */
    partial?: boolean;
    /** A currency measure's ISO 4217 code, and whether it is in minor units (cents). */
    currency?: string;
    minorUnits?: boolean;
}

export type SpecCell = string | number | boolean | null;

/** One row of a result. */
export interface SpecRow {
    /** A view's row: its key (`rowKey`). */
    key?: string;
    values: Record<string, SpecCell>;
    /**
     * The row's bucket contains today. For windows with a bucket,
     * the labels of the windows whose bucket in this row does.
     */
    partial?: true | string[];
    /** The group holds rows that aren't verified. */
    unverified?: true;
}

/** A window as the answer covers it: its dates in the spec's zone, and whether it contains today. */
export interface SpecWindow {
    label: string;
    from: string;
    to: string;
    partial: boolean;
}

export interface SpecResult {
    engine: 'sqlite' | 'duckdb';
    columns: SpecColumn[];
    rows: SpecRow[];
    /**
     * The total row (`totals: true`), computed by the database over the
     * same filters and windows, so it is right even when `rows` is cut
     * short. For a view, `{ count }`. Running values have none.
     */
    totals: Record<string, SpecCell> | null;
    /**
     * With two groupings (the time bucket counts as one), the totals by
     * each one alone: a total column and a total row. Keyed by the
     * grouping's column name.
     */
    subtotals?: Record<string, SpecRow[]>;
    /**
     * Rows left out of totals and derived measures because they aren't
     * verified: how many, and each measure column's sum of them.
     */
    excluded?: { rows: number; value: Record<string, number | null> };
    /** More rows than the caps allowed were left out (totals are still whole). */
    truncated: boolean;
    /** The spec's zone, and today in it. */
    timeZone: string;
    today: string;
    /** The display window. */
    window?: SpecWindow;
    /** The comparison windows, in order. */
    windows?: SpecWindow[];
    /** The rows read to compute it: wider than the window for running values and comparisons. */
    sourceRange: DateRange;
    /**
     * With a fallback time field (`coalesce`): how many rows in the
     * window took their date from each field, and how many had none.
     */
    coverage?: { fields: Record<string, number>; none: number };
    /** The people that `person` and `people` values name, by id. */
    users?: Record<string, { name: string }>;
    /** When it was computed (ms), and whether this answer came from the cache. */
    at: number;
    cached: boolean;
}

/** The body of `POST /api/data/specs/run`. */
export const specRunBody = z
    .object({
        spec: z.unknown(),
        /** Dashboard parameters' values, substituted before the spec is checked. */
        params: z
            .record(z.string().regex(SPEC_NAME), filterValue)
            .refine((p) => Object.keys(p).length <= 50, 'At most 50 parameters.')
            .optional(),
        /** The viewer's zone, for a spec without one. */
        timeZone: z.string().min(1).max(64).optional(),
        /** Skip the cache. */
        fresh: z.boolean().optional(),
    })
    .strict();
export type SpecRunBody = z.infer<typeof specRunBody>;
