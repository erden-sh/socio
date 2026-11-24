/**
 * A saved dataset view (CB-451): which rows of one table it shows (a
 * query spec without measures or windows), in which layout, with which
 * fields in which order, and the layout's options. Renderer-agnostic:
 * nothing here names a component, a CSS value or a size, except column
 * widths, which a phone may ignore.
 *
 * Two schemas, for the two directions:
 *
 * - `viewDefinition` is what a save must be, in the current schema:
 *   strict, every enum closed. With `checkViewDefinition` it lists every
 *   problem at once ("saving refuses"). The server then checks the
 *   definition against the table's live fields (build step 8).
 * - `viewDefinitionWire` is what a client reads: unknown keys are kept,
 *   and the values a later release may add to (layouts, calendar modes,
 *   filter operators, sorts, groupings) are open, so a definition from a
 *   newer server still parses. `readViewDefinition` (`./fallback.ts`)
 *   then says which parts this client can show and edit.
 */
import { z } from 'zod';

import {
    filterNode,
    QUERY_SPEC_LIMITS,
    queryGroup,
    querySegment,
    querySort,
    specPath,
    type FilterNode,
    type QueryGroup,
    type QuerySegment,
    type QuerySort,
    type SpecProblem,
} from '../dataset-query/spec.js';

import { DATASET_VIEWS_SCHEMA } from './schema.js';

/** The layouts of schema 1. A later one is an additive change; see `fallbackLayout`. */
export const VIEW_LAYOUTS = ['table', 'list', 'board', 'calendar', 'gallery'] as const;
export type ViewLayout = (typeof VIEW_LAYOUTS)[number];
export const isViewLayout = (value: unknown): value is ViewLayout =>
    typeof value === 'string' && (VIEW_LAYOUTS as readonly string[]).includes(value);

/** A calendar's ranges: every one is available on every screen. */
export const CALENDAR_MODES = ['day', 'week', 'month', 'agenda'] as const;
export type CalendarMode = (typeof CALENDAR_MODES)[number];
export const isCalendarMode = (value: unknown): value is CalendarMode =>
    typeof value === 'string' && (CALENDAR_MODES as readonly string[]).includes(value);

/** Who sees a view's definition: its owner only, or everyone who can read the dataset. */
export const VIEW_VISIBILITIES = ['personal', 'dataset'] as const;
export type ViewVisibility = (typeof VIEW_VISIBILITIES)[number];

/**
 * A column total of a table view, over every matching row. `sum`,
 * `avg`, `min` and `max` are for number kinds, which the server checks
 * against the table. A board sums one number field per column with a
 * `sum` here.
 */
export const VIEW_TOTAL_OPS = ['count', 'filled', 'empty', 'sum', 'avg', 'min', 'max'] as const;
export type ViewTotalOp = (typeof VIEW_TOTAL_OPS)[number];

/** The bounds of one definition. */
export const VIEW_LIMITS = {
    name: 160,
    /** Fields a view lists (a table has at most 2,000 columns; few have this many). */
    fields: 500,
    /** Board columns a view orders. */
    columns: 500,
    /** Column widths, which a phone may ignore. */
    minWidth: 40,
    maxWidth: 2_000,
    totals: 100,
} as const;

const id = z.string().min(1).max(64);
const fieldName = z.string().min(1).max(128);

// What a save must be (strict) -----------------------------------------------

/** One field of a view, in view order: `hidden`, a width, wrap, and a small screen's `priority`. */
export const viewField = z.strictObject({
    field: fieldName,
    hidden: z.boolean().optional(),
    width: z.number().int().min(VIEW_LIMITS.minWidth).max(VIEW_LIMITS.maxWidth).optional(),
    wrap: z.boolean().optional(),
    /** 1 is most important, unique within the view, on visible fields only. */
    priority: z.number().int().min(1).max(VIEW_LIMITS.fields).optional(),
});

/**
 * One board column: an option id, a person id, `true` or `false`,
 * or `null` for "No <field>", with `hidden` per column.
 */
export const boardColumn = z.strictObject({
    value: z.union([z.string().min(1).max(128), z.boolean(), z.null()]),
    hidden: z.boolean().optional(),
});

/** A layout's options. Each layout reads the keys it needs and keeps the rest. */
export const viewOptions = z.strictObject({
    /** The field a list line, card or calendar entry is titled by. */
    titleField: fieldName.optional(),
    /** A board's columns: a select, person or checkbox field. */
    groupField: fieldName.optional(),
    /** A board's column order and hidden columns. */
    columns: z.array(boardColumn).max(VIEW_LIMITS.columns).optional(),
    /** A gallery's cover: a `file` field. */
    cardCover: fieldName.optional(),
    /** A calendar's date or datetime field, and an optional end. */
    dateField: fieldName.optional(),
    endField: fieldName.optional(),
    /** A calendar's opening range on a wide screen. */
    calendarMode: z.enum(CALENDAR_MODES).optional(),
});

/** A view's query: the query spec without its source, measures, windows or time. */
export const viewQuery = z.strictObject({
    filter: filterNode.optional(),
    sort: z.array(querySort).max(QUERY_SPEC_LIMITS.sorts).optional(),
    groupBy: z.array(queryGroup).max(QUERY_SPEC_LIMITS.viewGroups).optional(),
    segments: z.union([querySegment, z.array(querySegment).min(1).max(QUERY_SPEC_LIMITS.segments)]).optional(),
});

const definitionShape = {
    /** The schema it was saved under. */
    schema: z.literal(DATASET_VIEWS_SCHEMA),
    /** `default` for the implicit view. */
    id,
    dataset: id,
    table: fieldName,
    name: z.string().trim().min(1).max(VIEW_LIMITS.name),
    layout: z.enum(VIEW_LAYOUTS),
    query: viewQuery,
    fields: z.array(viewField).max(VIEW_LIMITS.fields),
    options: viewOptions,
    totals: z.record(fieldName, z.enum(VIEW_TOTAL_OPS)).optional(),
    visibility: z.enum(VIEW_VISIBILITIES),
    version: z.number().int().min(0),
};

/** A view definition in the current schema, as a save must send it. See `checkViewDefinition`. */
export const viewDefinition = z.strictObject(definitionShape);
export type SavedViewDefinition = z.output<typeof viewDefinition>;

// What a client reads (forgiving) --------------------------------------------

/**
 * The same definition as a client reads it: every key it doesn't know
 * kept, open strings where a later release may add values, and the query's
 * parts unparsed (a filter may hold an operator from a newer release,
 * which the server still applies). Parsing never changes a value, so a
 * definition read and sent back is the one that came.
 */
export const viewDefinitionWire = z.looseObject({
    schema: z.number().int().min(1),
    id,
    dataset: id,
    table: fieldName,
    name: z.string(),
    layout: z.string(),
    query: z.looseObject({
        filter: z.unknown().optional(),
        sort: z.array(z.unknown()).optional(),
        groupBy: z.array(z.unknown()).optional(),
        segments: z.unknown().optional(),
    }),
    fields: z.array(
        z.looseObject({
            field: z.string(),
            hidden: z.boolean().optional(),
            width: z.number().optional(),
            wrap: z.boolean().optional(),
            priority: z.number().optional(),
        }),
    ),
    options: z.looseObject({
        titleField: z.string().optional(),
        groupField: z.string().optional(),
        columns: z
            .array(
                z.looseObject({ value: z.union([z.string(), z.boolean(), z.null()]), hidden: z.boolean().optional() }),
            )
            .optional(),
        cardCover: z.string().optional(),
        dateField: z.string().optional(),
        endField: z.string().optional(),
        calendarMode: z.string().optional(),
    }),
    totals: z.record(z.string(), z.string()).optional(),
    visibility: z.string(),
    version: z.number().int().min(0),
});

/** Keys a later schema may add, anywhere in a definition: kept and sent back unchanged. */
type Open = { [key: string]: unknown };

export type ViewField = z.output<typeof viewField> & Open;
export type BoardColumn = z.output<typeof boardColumn> & Open;
export type ViewOptions = Omit<z.output<typeof viewOptions>, 'calendarMode' | 'columns'> & {
    columns?: BoardColumn[];
    /** One of `CALENDAR_MODES`, or one from a later release. */
    calendarMode?: CalendarMode | (string & {});
} & Open;
export interface ViewQuery extends Open {
    filter?: FilterNode;
    sort?: QuerySort[];
    groupBy?: QueryGroup[];
    segments?: QuerySegment | QuerySegment[];
}

/**
 * A view definition as every party holds it. Its enums are open:
 * a client meets a layout or a calendar mode from a later release as a
 * string it doesn't know, and `readViewDefinition` says what to do.
 */
export interface ViewDefinition extends Open {
    schema: number;
    id: string;
    dataset: string;
    table: string;
    name: string;
    /** One of `VIEW_LAYOUTS`, or one from a later release. */
    layout: ViewLayout | (string & {});
    query: ViewQuery;
    fields: ViewField[];
    options: ViewOptions;
    totals?: Record<string, ViewTotalOp | (string & {})>;
    visibility: ViewVisibility | (string & {});
    version: number;
}

/**
 * A definition as a save checks it, before the server checks it against
 * the table: the strict shape, then the rules
 * between its parts, every problem with a JSON path (`$.fields[2].priority`).
 */
export function checkViewDefinition(
    input: unknown,
): { ok: true; view: SavedViewDefinition; problems: [] } | { ok: false; problems: SpecProblem[] } {
    const parsed = viewDefinition.safeParse(input);
    if (!parsed.success) {
        return {
            ok: false,
            problems: parsed.error.issues.map((issue) => ({ path: specPath(issue.path), message: issue.message })),
        };
    }
    const problems = viewDefinitionProblems(parsed.data);
    return problems.length ? { ok: false, problems } : { ok: true, view: parsed.data, problems: [] };
}

/** The rules between a well-shaped definition's parts. */
export function viewDefinitionProblems(view: SavedViewDefinition): SpecProblem[] {
    const problems: SpecProblem[] = [];
    const problem = (path: Array<string | number>, message: string) => problems.push({ path: specPath(path), message });

    const seen = new Map<string, number>();
    const priorities = new Map<number, number>();
    view.fields.forEach((f, i) => {
        if (seen.has(f.field)) {
            problem(['fields', i, 'field'], `"${f.field}" is listed twice (first at fields[${seen.get(f.field)}]).`);
        } else {
            seen.set(f.field, i);
        }
        if (f.priority === undefined) {
            return;
        }
        if (f.hidden) {
            problem(['fields', i, 'priority'], `"${f.field}" is hidden; only a visible field takes a priority.`);
        }
        const other = priorities.get(f.priority);
        if (other !== undefined) {
            problem(
                ['fields', i, 'priority'],
                `Priority ${f.priority} is already "${view.fields[other].field}"'s; each priority is used once.`,
            );
        } else {
            priorities.set(f.priority, i);
        }
    });

    const o = view.options;
    if (view.layout === 'board' && !o.groupField) {
        problem(['options', 'groupField'], 'A board needs a group field: a select, person or checkbox field.');
    }
    if (view.layout === 'calendar' && !o.dateField) {
        problem(['options', 'dateField'], 'A calendar needs a date field: a date or a date and time.');
    }
    if (o.endField !== undefined) {
        if (!o.dateField) {
            problem(['options', 'endField'], 'An end field goes with a date field.');
        } else if (o.endField === o.dateField) {
            problem(['options', 'endField'], 'The end field must differ from the date field.');
        }
    }
    const columns = new Set<string>();
    o.columns?.forEach((c, i) => {
        const value = JSON.stringify(c.value);
        if (columns.has(value)) {
            problem(['options', 'columns', i, 'value'], `Column ${value} is listed twice.`);
        }
        columns.add(value);
    });
    if (view.totals && Object.keys(view.totals).length > VIEW_LIMITS.totals) {
        problem(['totals'], `At most ${VIEW_LIMITS.totals} column totals.`);
    }
    view.query.groupBy?.forEach((g, i) => {
        if ('segment' in g) {
            const names = view.query.segments
                ? (Array.isArray(view.query.segments) ? view.query.segments : [view.query.segments]).map((s) => s.name)
                : [];
            if (!names.includes(g.segment)) {
                problem(['query', 'groupBy', i, 'segment'], `No segment "${g.segment}" in this view's query.`);
            }
        }
    });
    return problems;
}
