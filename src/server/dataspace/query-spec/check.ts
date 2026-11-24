/**
 * The query spec's checks against a live table (CB-451): the
 * compiler's first half. A spec is parsed (its shape, the shared zod
 * schema), then held against the table's columns and their field kinds:
 * every field exists and can be named, every operator fits its field's
 * kind, every value has the kind's type, every limit holds. Every problem
 * is reported at once, each with a JSON path into the spec, so an editor
 * or an agent can fix them all in one go.
 *
 * Nothing here builds SQL. What it guarantees is what the compiler relies
 * on: field names are the table's own columns and pass `identifier()`,
 * and values are typed literals the compiler binds as `?` parameters.
 */
import type { ZodError } from 'zod';

import type { ColumnInfo, TableInfo } from '@socio/shared/data-types';
import { offsetAt } from '@socio/shared/dataset-query/dates';
import {
    DATE_KINDS,
    GROUPABLE_KINDS,
    inferFieldKind,
    kindFitsColumn,
    NUMBER_KINDS,
    SORTABLE_KINDS,
    TEXT_KINDS,
    typeKind,
    type FieldKind,
    type FieldOption,
    type FieldSetting,
} from '@socio/shared/dataset-query/kinds';
import { OP_VALUE_SHAPE, operatorsFor, type FilterOp } from '@socio/shared/dataset-query/operators';
import {
    isCalendarDate,
    isIsoDateTime,
    QUERY_SPEC_LIMITS,
    querySpec,
    specPath,
    specSegments,
    type FilterNode,
    type FilterValue,
    type MeasureExpr,
    type QueryMeasure,
    type QuerySpec,
    type QueryWindow,
    type SpecProblem,
} from '@socio/shared/dataset-query/spec';
import { ianaTimeZone } from '@socio/shared/time-zone';

import { identifier } from '../sql.js';

type Path = Array<string | number>;

/** A column as the spec sees it: its kind and its kind's settings. */
export interface SpecField {
    name: string;
    type: string;
    kind: FieldKind;
    /** For `id`: the kind its stored type has, whose operators it takes. */
    baseKind: FieldKind;
    options?: FieldOption[];
    currency?: string;
    minorUnits?: boolean;
    /** Whether `identifier()` takes its name; one it doesn’t can’t be queried. */
    nameable: boolean;
}

/**
 * The table's fields: each column's kind from its field setting when
 * the setting fits the column's type, else from the type. A setting for
 * a column that is gone, or one that no longer fits, is ignored here
 * (loading forgives; saving refuses).
 */
export function specFields(columns: ColumnInfo[], settings: FieldSetting[] = []) {
    const byColumn = new Map(settings.map((s) => [s.column, s]));
    const out = new Map<string, SpecField>();
    for (const column of columns) {
        const setting = byColumn.get(column.name);
        const fits = setting && kindFitsColumn(setting.kind, column);
        const kind = fits ? setting.kind : inferFieldKind(column);
        let nameable = true;
        try {
            identifier(column.name, 'column');
        } catch {
            nameable = false;
        }
        out.set(column.name, {
            name: column.name,
            type: column.type,
            kind,
            baseKind: typeKind(column.type),
            ...(fits && setting.settings?.options ? { options: setting.settings.options } : {}),
            ...(fits && kind === 'currency' && setting.settings?.currency
                ? { currency: setting.settings.currency.toUpperCase() }
                : {}),
            ...(fits && kind === 'currency' && setting.settings?.minorUnits ? { minorUnits: true } : {}),
            nameable,
        });
    }
    return out;
}

export interface SpecContext {
    table: Pick<TableInfo, 'name' | 'columns' | 'kind'>;
    /** The table's field settings; inferred kinds without them. */
    settings?: FieldSetting[];
    /** The dashboard parameters the spec may use; a view has none. */
    params?: string[];
}

export interface SpecCheck {
    ok: boolean;
    problems: SpecProblem[];
    /** The parsed spec, defaults applied, when its shape is right. */
    spec?: QuerySpec;
    engine?: 'sqlite' | 'duckdb';
}

/** A spec's shape alone, without a table: the zod schema's problems as paths. */
export function parseSpec(input: unknown): { spec?: QuerySpec; problems: SpecProblem[] } {
    // The schema is recursive (filters, expressions): bound the nesting
    // first, without recursion, so a deep spec is a problem, not a stack overflow.
    if (nestingDepth(input, SPEC_MAX_NESTING) > SPEC_MAX_NESTING) {
        return {
            problems: [
                {
                    path: '$',
                    message: `This spec is nested too deeply: at most ${SPEC_MAX_NESTING} levels of objects and lists.`,
                },
            ],
        };
    }
    const parsed = querySpec.safeParse(input);
    if (parsed.success) {
        return { spec: parsed.data, problems: [] };
    }
    return { problems: zodProblems(parsed.error, input) };
}

/**
 * The deepest a spec's JSON may nest. The deepest valid spec (a segment
 * rule's nested group, a list of `$me`, a measure's expression at its
 * depth limit) is well under it.
 */
export const SPEC_MAX_NESTING = 32;

/** How deep a JSON value nests, counted without recursion; stops past `max`. */
export function nestingDepth(input: unknown, max: number) {
    let deepest = 0;
    const stack: Array<[unknown, number]> = [[input, 0]];
    while (stack.length) {
        const [value, depth] = stack.pop()!;
        if (!value || typeof value !== 'object') {
            continue;
        }
        const level = depth + 1;
        deepest = Math.max(deepest, level);
        if (deepest > max) {
            return deepest;
        }
        for (const child of Array.isArray(value) ? value : Object.values(value)) {
            stack.push([child, level]);
        }
    }
    return deepest;
}

/** Checks a spec against a table: its shape, then its fields, kinds, values and limits. */
export function checkSpec(input: unknown, context: SpecContext): SpecCheck {
    const { spec, problems } = parseSpec(input);
    if (!spec) {
        return { ok: false, problems };
    }
    const checker = new Checker(spec, context);
    checker.run();
    const out = checker.problems;
    return out.length
        ? { ok: false, problems: out, spec }
        : { ok: true, problems: [], spec, engine: context.table.kind === 'analytical' ? 'duckdb' : 'sqlite' };
}

/**
 * Zod's issues as problems. A union that failed reports, of its
 * branches, the one the input was evidently meant to be (the fewest
 * missing or unknown keys, then the fewest issues), so a filter group
 * with a bad member says what is wrong with that member instead of
 * "Invalid input".
 */
function zodProblems(error: ZodError, input: unknown): SpecProblem[] {
    type Issue = ZodError['issues'][number];
    const out: SpecProblem[] = [];
    const valueAt = (path: PropertyKey[]) =>
        path.reduce<unknown>(
            (v, key) => (v && typeof v === 'object' ? (v as Record<PropertyKey, unknown>)[key] : undefined),
            input,
        );
    const walk = (issues: readonly Issue[]) => {
        for (const issue of issues) {
            if (issue.code === 'invalid_union' && issue.errors.length) {
                const at = issue.path;
                // A branch of the wrong type or with unknown keys misses
                // the input by far; one with a key missing, by a little.
                const misfits = (branch: readonly Issue[]) =>
                    branch.reduce(
                        (sum, i) =>
                            sum +
                            // Branch paths are relative to the union's.
                            ((i.code === 'unrecognized_keys' || i.code === 'invalid_type') && i.path.length === 0
                                ? 10
                                : i.code === 'invalid_type' &&
                                    i.path.length === 1 &&
                                    valueAt([...at, ...i.path]) === undefined
                                  ? 1
                                  : 0),
                        0,
                    );
                const best = [...issue.errors].sort((a, b) => misfits(a) - misfits(b) || a.length - b.length)[0];
                if (misfits(best) >= 10) {
                    // Nothing fits well enough to say more than the union's own message.
                    out.push({ path: specPath(at), message: unionMessage(valueAt(at)) });
                } else {
                    walk(best.map((i) => ({ ...i, path: [...at, ...i.path] })) as Issue[]);
                }
                continue;
            }
            out.push({ path: specPath(issue.path), message: issue.message });
        }
    };
    walk(error.issues);
    // One problem per path and message.
    return out.filter((p, i) => out.findIndex((q) => q.path === p.path && q.message === p.message) === i);
}

const unionMessage = (value: unknown) =>
    value === undefined ? 'Required.' : 'Not a valid value here: check its keys and types against the query spec.';

const describe = (value: unknown) => JSON.stringify(value)?.slice(0, 80) ?? String(value);
const kindLabel = (kind: FieldKind) => kind.replace('_', ' ');
const list = (items: readonly string[]) => items.join(', ');

/** The semantic checks, collecting problems. */
class Checker {
    readonly problems: SpecProblem[] = [];
    private fields: Map<string, SpecField>;
    private conditions = 0;
    private values = 0;
    private measures = new Map<string, QueryMeasure>();
    private aggregate: boolean;
    private timeFields: string[] = [];

    constructor(
        private spec: QuerySpec,
        private context: SpecContext,
    ) {
        this.fields = specFields(context.table.columns, context.settings);
        this.aggregate = !!spec.measures?.length || !!spec.time?.bucket || !!spec.windows?.length;
    }

    private problem(path: Path, message: string) {
        this.problems.push({ path: specPath(path), message });
    }

    run() {
        const spec = this.spec;
        if (spec.timeZone !== undefined && !ianaTimeZone(spec.timeZone)) {
            this.problem(
                ['timeZone'],
                `"${spec.timeZone.slice(0, 64)}" is not an IANA time zone, such as America/New_York.`,
            );
        }
        if (spec.source.verified) {
            this.filter(spec.source.verified, ['source', 'verified']);
        }
        if (spec.filter) {
            this.filter(spec.filter, ['filter']);
        }
        this.time();
        this.segments();
        this.measureList();
        this.groups();
        this.windows();
        this.sorts();
        if (spec.totals && !this.aggregate && !spec.groupBy?.length) {
            this.problem(['totals'], 'Totals need measures or a grouping to total.');
        }
        if (this.conditions > QUERY_SPEC_LIMITS.specConditions) {
            this.problem(
                [],
                `This spec has ${this.conditions} conditions; at most ${QUERY_SPEC_LIMITS.specConditions} across its filter, measures, segments and verified rows.`,
            );
        }
        if (this.values > QUERY_SPEC_LIMITS.specValues) {
            this.problem([], `This spec has ${this.values} values; at most ${QUERY_SPEC_LIMITS.specValues}.`);
        }
    }

    /** A field by name, with a problem when it can’t be used. */
    private field(name: string, path: Path): SpecField | undefined {
        const field = this.fields.get(name);
        if (!field) {
            this.problem(path, `Unknown field ${describe(name)} in table "${this.context.table.name}".`);
            return undefined;
        }
        if (!field.nameable) {
            this.problem(path, `Field ${describe(name)} can’t be queried: rename it to letters, digits and _.`);
            return undefined;
        }
        if (field.kind === 'blob' || field.baseKind === 'blob') {
            this.problem(path, `Field "${name}" holds bytes, which views and dashboards never show.`);
            return undefined;
        }
        return field;
    }

    // Filters ---------------------------------------------------------------

    private filter(node: FilterNode, path: Path) {
        let count = 0;
        const walk = (n: FilterNode, at: Path, depth: number) => {
            if ('field' in n) {
                count++;
                this.condition(n, at);
                return;
            }
            const key = 'all' in n ? 'all' : 'any';
            const members = 'all' in n ? n.all : n.any;
            if (depth >= QUERY_SPEC_LIMITS.filterDepth) {
                this.problem(
                    at,
                    `Filters nest at most ${QUERY_SPEC_LIMITS.filterDepth} levels: a group, and groups inside it.`,
                );
                return;
            }
            members.forEach((m, i) => walk(m, [...at, key, i], depth + 1));
        };
        walk(node, path, 0);
        this.conditions += count;
        if (count > QUERY_SPEC_LIMITS.filterConditions) {
            this.problem(path, `This filter has ${count} conditions; at most ${QUERY_SPEC_LIMITS.filterConditions}.`);
        }
    }

    private condition(c: { field: string; op: FilterOp; value?: FilterValue }, path: Path) {
        const field = this.field(c.field, [...path, 'field']);
        if (!field) {
            return;
        }
        const ops = operatorsFor(field.kind, field.baseKind);
        if (!ops.includes(c.op)) {
            this.problem(
                [...path, 'op'],
                ops.length
                    ? `"${c.op}" doesn’t fit ${kindLabel(field.kind)} field "${field.name}"; use one of ${list(ops)}.`
                    : `${kindLabel(field.kind)} field "${field.name}" can’t be filtered on.`,
            );
            return;
        }
        const kind = field.kind === 'id' ? field.baseKind : field.kind;
        const at = [...path, 'value'];
        const value = c.value;
        switch (OP_VALUE_SHAPE[c.op]) {
            case 'none':
                if (value !== undefined) {
                    this.problem(at, `"${c.op}" takes no value.`);
                }
                return;
            case 'one':
                if (value === undefined || Array.isArray(value)) {
                    this.problem(at, `"${c.op}" takes one value.`);
                    return;
                }
                this.values++;
                this.value(field, kind, c.op, value, at);
                return;
            case 'pair': {
                if (this.param(value, at)) {
                    return;
                }
                if (!Array.isArray(value) || value.length !== 2) {
                    this.problem(at, `"between" takes two values, [from, to].`);
                    return;
                }
                this.values += 2;
                const okFrom = this.value(field, kind, c.op, value[0], [...at, 0]);
                const okTo = this.value(field, kind, c.op, value[1], [...at, 1]);
                const [from, to] = value;
                if (
                    okFrom &&
                    okTo &&
                    ((typeof from === 'number' && typeof to === 'number' && from > to) ||
                        (typeof from === 'string' && typeof to === 'string' && this.after(kind, from, to)))
                ) {
                    this.problem(at, `"between" runs from the smaller value to the larger: ${describe(value)}.`);
                }
                return;
            }
            case 'list': {
                if (this.param(value, at)) {
                    return;
                }
                if (!Array.isArray(value) || !value.length) {
                    this.problem(at, `"${c.op}" takes a list of values.`);
                    return;
                }
                this.values += value.length;
                value.forEach((v, i) => this.value(field, kind, c.op, v, [...at, i]));
                return;
            }
            case 'range': {
                if (this.param(value, at)) {
                    return;
                }
                this.values++;
                if (
                    !value ||
                    typeof value !== 'object' ||
                    Array.isArray(value) ||
                    !('relative' in value || 'period' in value)
                ) {
                    this.problem(
                        at,
                        `"within" takes a relative date ({ relative: "past" | "next", count, unit }) or a period ({ period: "this_month" }).`,
                    );
                }
                return;
            }
        }
    }

    /**
     * Whether a `between`'s first bound is past its second: dates as
     * dates; dates and times as instants, an offset-less value in the
     * spec's zone (left unchecked when the spec names none and only one
     * bound has an offset, as the zone isn't known until it runs).
     */
    private after(kind: FieldKind, from: string, to: string): boolean {
        if (from === 'today' || to === 'today') {
            return false;
        }
        if (kind !== 'datetime') {
            return from > to;
        }
        const zoned = (v: string) => v.length > 10 && /(Z|[+-]\d{2}:\d{2})$/.test(v);
        const local = (v: string) => (v.length === 10 ? `${v}T00:00:00.000` : v.replace(' ', 'T'));
        if (!zoned(from) && !zoned(to)) {
            const norm = (v: string) => {
                const [day, time = '00:00'] = local(v).split('T');
                const [hour, minute, second = '00'] = time.split(':');
                const [whole, ms = ''] = second.split('.');
                return `${day}T${hour}:${minute}:${whole}.${ms.padEnd(3, '0')}`;
            };
            return norm(from) > norm(to);
        }
        const zone = this.spec.timeZone ? ianaTimeZone(this.spec.timeZone) : undefined;
        const instant = (v: string) => {
            if (zoned(v)) {
                return Date.parse(v.replace(' ', 'T'));
            }
            if (!zone) {
                return undefined;
            }
            const wall = Date.parse(`${local(v)}Z`);
            return wall - offsetAt(wall - offsetAt(wall, zone), zone);
        };
        const a = instant(from);
        const b = instant(to);
        return a !== undefined && b !== undefined && a > b;
    }

    /** A `$param` value: true when it is one (checked here). */
    private param(value: FilterValue | undefined, path: Path) {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !('$param' in value)) {
            return false;
        }
        this.values++;
        const params = this.context.params;
        if (!params) {
            this.problem(path, 'Parameters ($param) belong to dashboards; this query has none.');
        } else if (!params.includes(value.$param)) {
            this.problem(
                path,
                `Unknown parameter "${value.$param}"${params.length ? `; this dashboard has ${list(params)}` : ''}.`,
            );
        }
        return true;
    }

    /** One value of a condition, against its field's kind. True when it is fine. */
    private value(field: SpecField, kind: FieldKind, op: FilterOp, value: unknown, path: Path): boolean {
        if (this.param(value as FilterValue, path)) {
            return true;
        }
        const fail = (message: string) => {
            this.problem(path, message);
            return false;
        };
        const isObject = !!value && typeof value === 'object' && !Array.isArray(value);
        if (isObject && '$me' in (value as object)) {
            return kind === 'person' || kind === 'people'
                ? true
                : fail(`$me is a person; "${field.name}" is a ${kindLabel(kind)} field.`);
        }
        if (isObject && ('relative' in (value as object) || 'period' in (value as object))) {
            return fail(
                DATE_KINDS.includes(kind)
                    ? `A relative date or period goes with "within"; "${op}" takes a date.`
                    : `A relative date fits only date fields; "${field.name}" is a ${kindLabel(kind)} field.`,
            );
        }
        if (TEXT_KINDS.includes(kind)) {
            if (typeof value !== 'string') {
                return fail(`"${field.name}" holds text; use a string.`);
            }
            if (!value && op !== 'is' && op !== 'is_not') {
                return fail(`"${op}" needs some text; use is_empty to find empty values.`);
            }
            return true;
        }
        if (NUMBER_KINDS.includes(kind)) {
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                return fail(`"${field.name}" holds numbers; use a number.`);
            }
            if (field.minorUnits && !Number.isInteger(value)) {
                return fail(`"${field.name}" is stored in minor units (cents); use a whole number.`);
            }
            return true;
        }
        switch (kind) {
            case 'checkbox':
                return typeof value === 'boolean' ? true : fail(`"${field.name}" is a checkbox; use true or false.`);
            case 'date':
                return value === 'today' || (typeof value === 'string' && isCalendarDate(value))
                    ? true
                    : fail(`"${field.name}" holds dates; use YYYY-MM-DD or "today".`);
            case 'datetime':
                return value === 'today' ||
                    (typeof value === 'string' && (isCalendarDate(value) || isIsoDateTime(value)))
                    ? true
                    : fail(`"${field.name}" holds dates and times; use YYYY-MM-DD, an ISO date and time, or "today".`);
            case 'select':
            case 'multi_select':
                if (typeof value !== 'string') {
                    return fail(`"${field.name}" takes option ids, as strings.`);
                }
                if (field.options && !field.options.some((o) => o.id === value)) {
                    return fail(
                        `Unknown option ${describe(value)} of "${field.name}"; its options are ${list(field.options.map((o) => o.id))}.`,
                    );
                }
                return true;
            case 'person':
            case 'people':
                return typeof value === 'string' && value.length > 0 && value.length <= 128
                    ? true
                    : fail(`"${field.name}" takes user ids, or { "$me": true }.`);
            default:
                return fail(`"${field.name}" can’t be compared with a value.`);
        }
    }

    // Time and windows ---------------------------------------------------------

    private time() {
        const time = this.spec.time;
        if (!time) {
            return;
        }
        const names = typeof time.field === 'string' ? [time.field] : time.field.coalesce;
        const path: Path = typeof time.field === 'string' ? ['time', 'field'] : ['time', 'field', 'coalesce'];
        const kinds = new Set<FieldKind>();
        names.forEach((name, i) => {
            const at = typeof time.field === 'string' ? path : [...path, i];
            if (names.indexOf(name) !== i) {
                this.problem(at, `"${name}" is listed twice.`);
                return;
            }
            const field = this.field(name, at);
            if (!field) {
                return;
            }
            if (!DATE_KINDS.includes(field.kind)) {
                this.problem(
                    at,
                    `The time field must be a date or date and time; "${name}" is a ${kindLabel(field.kind)} field.`,
                );
                return;
            }
            kinds.add(field.kind);
            this.timeFields.push(name);
        });
        if (kinds.size > 1) {
            this.problem(path, 'The fallback fields must all be dates, or all dates and times.');
        }
    }

    private windows() {
        const spec = this.spec;
        const windows: Array<[QueryWindow, Path]> = [
            ...(spec.window ? [[spec.window, ['window']] as [QueryWindow, Path]] : []),
            ...(spec.windows ?? []).map((w, i) => [w, ['windows', i]] as [QueryWindow, Path]),
        ];
        if (!windows.length) {
            return;
        }
        if (!spec.time) {
            this.problem([spec.window ? 'window' : 'windows'], 'A window needs the date it limits: set time.field.');
        }
        for (const [window, path] of windows) {
            if (typeof window === 'object' && 'between' in window) {
                const [from, to] = window.between;
                window.between.forEach((d, i) => {
                    if (!isCalendarDate(d)) {
                        this.problem([...path, 'between', i], `${describe(d)} is not a calendar date.`);
                    }
                });
                if (from > to) {
                    this.problem([...path, 'between'], 'A window runs from its first date to its last.');
                }
            }
        }
        if (spec.windows?.length) {
            if (!spec.measures?.length) {
                this.problem(['windows'], 'Comparison windows compare measures: add one.');
            }
            if (spec.window) {
                // With comparison windows, the windows are what is shown.
                this.problem(
                    ['window'],
                    'Use window or windows, not both: comparison windows are each shown whole, one column per window (with a bucket, one series per window).',
                );
            }
            const keys = spec.windows.map((w) => JSON.stringify(w));
            keys.forEach((k, i) => {
                if (keys.indexOf(k) !== i) {
                    this.problem(['windows', i], 'This window is listed twice.');
                }
            });
        }
    }

    // Segments ---------------------------------------------------------------

    private segmentNames = new Set<string>();
    private segments() {
        const segments = specSegments(this.spec);
        segments.forEach((segment, s) => {
            const path: Path = Array.isArray(this.spec.segments) ? ['segments', s] : ['segments'];
            if (this.segmentNames.has(segment.name)) {
                this.problem([...path, 'name'], `Segment "${segment.name}" is defined twice.`);
            }
            this.segmentNames.add(segment.name);
            if (this.fields.has(segment.name)) {
                this.problem(
                    [...path, 'name'],
                    `"${segment.name}" is a field of this table; name the segment otherwise.`,
                );
            }
            if (segment.field !== undefined) {
                this.field(segment.field, [...path, 'field']);
            }
            const labels = new Set<string>();
            segment.rules.forEach((rule, r) => {
                if (labels.has(rule.label)) {
                    this.problem([...path, 'rules', r, 'label'], `Label "${rule.label}" is used by an earlier rule.`);
                }
                labels.add(rule.label);
                this.filter(rule.when, [...path, 'rules', r, 'when']);
            });
            if (labels.has(segment.other)) {
                this.problem(
                    [...path, 'other'],
                    `"other" must differ from every rule's label; "${segment.other}" is one.`,
                );
            }
        });
    }

    // Measures -----------------------------------------------------------------

    private measureList() {
        const measures = this.spec.measures ?? [];
        const grouped = new Set((this.spec.groupBy ?? []).flatMap((g) => ('field' in g ? [g.field] : [])));
        measures.forEach((m, i) => {
            if (this.measures.has(m.name)) {
                this.problem(['measures', i, 'name'], `Measure "${m.name}" is defined twice.`);
                return;
            }
            if (this.segmentNames.has(m.name) || grouped.has(m.name) || this.timeFields.includes(m.name)) {
                this.problem(
                    ['measures', i, 'name'],
                    `"${m.name}" is already a grouping of this query; name the measure otherwise.`,
                );
            }
            this.measures.set(m.name, m);
        });
        measures.forEach((m, i) => {
            const path: Path = ['measures', i];
            if ('op' in m) {
                this.baseMeasure(m, path);
            } else if ('expr' in m) {
                this.expr(m.name, m.expr, [...path, 'expr']);
            } else {
                this.running(m, path);
            }
        });
        // Cycles, and each derived measure's currency.
        measures.forEach((m, i) => {
            if (this.measures.get(m.name) !== m) {
                return;
            }
            if (this.cycle(m.name)) {
                this.problem(['measures', i], `Measure "${m.name}" depends on itself.`);
                return;
            }
            if ('expr' in m) {
                const units = new Set<string>();
                this.units(m.name, units, new Set());
                if (units.size > 1) {
                    this.problem(
                        ['measures', i, 'expr'],
                        `Measure "${m.name}" mixes ${list([...units].sort().map((u) => u.replace('|minor', ' in minor units')))}; keep one currency and unit per measure.`,
                    );
                }
            }
        });
    }

    private baseMeasure(m: Extract<QueryMeasure, { op: string }>, path: Path) {
        if (m.where) {
            this.filter(m.where, [...path, 'where']);
        }
        if (m.verified) {
            this.filter(m.verified, [...path, 'verified']);
        }
        if (m.field === undefined) {
            if (m.op !== 'count') {
                this.problem([...path, 'field'], `"${m.op}" needs a field.`);
            }
            return;
        }
        const field = this.field(m.field, [...path, 'field']);
        if (!field) {
            return;
        }
        const kind = field.kind === 'id' ? field.baseKind : field.kind;
        const fits =
            m.op === 'count' || m.op === 'count_distinct'
                ? kind !== 'json' && kind !== 'file'
                : m.op === 'sum' || m.op === 'avg'
                  ? NUMBER_KINDS.includes(kind)
                  : NUMBER_KINDS.includes(kind) || DATE_KINDS.includes(kind);
        if (!fits) {
            this.problem(
                [...path, 'op'],
                `"${m.op}" doesn’t fit ${kindLabel(field.kind)} field "${field.name}"${m.op === 'sum' || m.op === 'avg' ? '; it needs a number' : ''}.`,
            );
        }
    }

    private exprNodes = 0;
    private expr(owner: string, expr: MeasureExpr, path: Path, depth = 1): void {
        if (depth === 1) {
            this.exprNodes = 0;
        }
        this.exprNodes++;
        if (this.exprNodes === QUERY_SPEC_LIMITS.exprNodes + 1) {
            this.problem(path, `A derived measure has at most ${QUERY_SPEC_LIMITS.exprNodes} terms and operators.`);
        }
        if (typeof expr === 'number') {
            if (!Number.isFinite(expr)) {
                this.problem(path, 'Use a finite number.');
            }
            return;
        }
        if (typeof expr === 'string') {
            if (expr === owner) {
                this.problem(path, `Measure "${owner}" can’t use itself.`);
            } else if (this.measures.has(expr) && this.isDateMeasure(expr)) {
                this.problem(path, `Measure "${expr}" is a date; arithmetic takes a number.`);
            } else if (!this.measures.has(expr)) {
                this.problem(
                    path,
                    `Unknown measure "${expr}"${this.measures.size ? `; this query has ${list([...this.measures.keys()])}` : ''}.`,
                );
            }
            return;
        }
        if (depth > QUERY_SPEC_LIMITS.exprDepth) {
            this.problem(path, `A derived measure nests at most ${QUERY_SPEC_LIMITS.exprDepth} levels.`);
            return;
        }
        const [op, args] = Object.entries(expr)[0] as [string, MeasureExpr[]];
        args.forEach((a, i) => this.expr(owner, a, [...path, op, i], depth + 1));
    }

    private running(m: Extract<QueryMeasure, { running: unknown }>, path: Path) {
        const { of, order, from } = m.running;
        const target = this.measures.get(of);
        if (!target) {
            this.problem([...path, 'running', 'of'], `Unknown measure "${of}".`);
        } else if (of === m.name) {
            this.problem([...path, 'running', 'of'], `Measure "${m.name}" can’t run over itself.`);
        } else if (this.isDateMeasure(of)) {
            this.problem([...path, 'running', 'of'], `Measure "${of}" is a date; a running value sums a number.`);
        } else if (this.dependsOnRunning(of, new Set())) {
            this.problem([...path, 'running', 'of'], 'A running value sums a measure, not another running value.');
        }
        const groupFields = (this.spec.groupBy ?? []).flatMap((g) => ('field' in g ? [g.field] : []));
        if (order !== undefined) {
            if (!this.timeFields.includes(order) && !groupFields.includes(order)) {
                this.problem(
                    [...path, 'running', 'order'],
                    `A running value follows the time field or a grouped field; "${order}" is neither.`,
                );
            }
        } else if (!this.spec.time?.bucket) {
            this.problem(
                [...path, 'running'],
                'A running value needs an order: set time.bucket, or running.order to a grouped field.',
            );
        }
        if (from !== undefined && from !== 'all' && from !== 'window') {
            if (!isCalendarDate(from)) {
                this.problem([...path, 'running', 'from'], `${describe(from)} is not a calendar date.`);
            }
        }
        if (from !== undefined && from !== 'all' && from !== 'window' && !this.spec.time) {
            this.problem(
                [...path, 'running', 'from'],
                'A running value that starts on a date needs the date it starts by: set time.field.',
            );
        }
        if (order !== undefined && this.timeFields.includes(order) && !this.spec.time?.bucket) {
            this.problem(
                [...path, 'running', 'order'],
                'A running value over the time field needs time.bucket to follow.',
            );
        }
        if (from === 'window' && !this.spec.window && !this.spec.windows?.length) {
            this.problem(
                [...path, 'running', 'from'],
                '"window" starts at the display window; set window, or use "all".',
            );
        }
    }

    /** Whether a measure's result is a date or an instant (`min` or `max` of one), not a number. */
    private isDateMeasure(name: string) {
        const m = this.measures.get(name);
        if (!m || !('op' in m) || (m.op !== 'min' && m.op !== 'max') || !m.field) {
            return false;
        }
        const field = this.fields.get(m.field);
        return !!field && DATE_KINDS.includes(field.kind === 'id' ? field.baseKind : field.kind);
    }

    /** The measures a measure reads. */
    private deps(name: string): string[] {
        const m = this.measures.get(name);
        if (!m || 'op' in m) {
            return [];
        }
        if ('running' in m) {
            return [m.running.of];
        }
        const out: string[] = [];
        const walk = (e: MeasureExpr) => {
            if (typeof e === 'string') {
                out.push(e);
            } else if (typeof e === 'object') {
                Object.values(e)[0].forEach(walk);
            }
        };
        walk(m.expr);
        return out;
    }
    /**
     * The measures on a cycle, worked out once: a depth-first walk that
     * visits each measure and each dependency once, so measures sharing
     * dependencies cost no more than measures that don't.
     */
    private cyclic?: Set<string>;
    private cycle(name: string): boolean {
        if (!this.cyclic) {
            const cyclic = new Set<string>();
            const state = new Map<string, 'visiting' | 'done'>();
            const visit = (n: string, stack: string[]) => {
                const at = state.get(n);
                if (at === 'visiting') {
                    for (const m of stack.slice(stack.indexOf(n))) {
                        cyclic.add(m);
                    }
                    return;
                }
                if (at === 'done') {
                    return;
                }
                state.set(n, 'visiting');
                stack.push(n);
                for (const d of new Set(this.deps(n))) {
                    if (d !== n && this.measures.has(d)) {
                        visit(d, stack);
                    }
                }
                stack.pop();
                state.set(n, 'done');
            };
            for (const n of this.measures.keys()) {
                visit(n, []);
            }
            this.cyclic = cyclic;
        }
        return this.cyclic.has(name);
    }
    private dependsOnRunning(name: string, seen: Set<string>): boolean {
        const m = this.measures.get(name);
        if (!m || seen.has(name)) {
            return false;
        }
        seen.add(name);
        return 'running' in m || this.deps(name).some((d) => this.dependsOnRunning(d, seen));
    }
    /** The currencies (with their unit) a measure carries, through derived measures. */
    private units(name: string, out: Set<string>, seen: Set<string>) {
        const m = this.measures.get(name);
        if (!m || seen.has(name)) {
            return;
        }
        seen.add(name);
        if ('op' in m) {
            const field = m.field ? this.fields.get(m.field) : undefined;
            if (field?.kind === 'currency' && m.op !== 'count' && m.op !== 'count_distinct') {
                out.add(`${field.currency ?? 'an unnamed currency'}${field.minorUnits ? '|minor' : ''}`);
            }
            return;
        }
        for (const d of this.deps(name)) {
            this.units(d, out, seen);
        }
    }

    // Grouping and sorting ---------------------------------------------------

    private groups() {
        const groups = this.spec.groupBy ?? [];
        const max = this.aggregate ? QUERY_SPEC_LIMITS.aggregateGroups : QUERY_SPEC_LIMITS.viewGroups;
        if (groups.length > max) {
            this.problem(
                ['groupBy'],
                this.aggregate
                    ? `An aggregate groups by at most ${max} fields.`
                    : `A view groups by at most ${max} fields; add a measure to group by up to ${QUERY_SPEC_LIMITS.aggregateGroups}.`,
            );
        }
        const seen = new Set<string>();
        groups.forEach((g, i) => {
            const path: Path = ['groupBy', i];
            const key = JSON.stringify(g);
            if (seen.has(key)) {
                this.problem(path, 'This grouping is listed twice.');
            }
            seen.add(key);
            if ('segment' in g) {
                if (!this.segmentNames.has(g.segment)) {
                    this.problem([...path, 'segment'], `Unknown segment "${g.segment}".`);
                }
                return;
            }
            const field = this.field(g.field, [...path, 'field']);
            if (!field) {
                return;
            }
            if (this.spec.time?.bucket && this.timeFields.includes(g.field)) {
                this.problem([...path, 'field'], `"${g.field}" is already the time bucket; group by another field.`);
                return;
            }
            if (!GROUPABLE_KINDS.includes(field.kind)) {
                this.problem([...path, 'field'], `${kindLabel(field.kind)} field "${field.name}" can’t be grouped on.`);
                return;
            }
            const kind = field.kind === 'id' ? field.baseKind : field.kind;
            if (typeof g.bucket === 'string' && !DATE_KINDS.includes(kind)) {
                this.problem(
                    [...path, 'bucket'],
                    `A ${g.bucket} bucket fits date fields; "${field.name}" is a ${kindLabel(field.kind)} field.`,
                );
            }
            if (typeof g.bucket === 'object' && !NUMBER_KINDS.includes(kind)) {
                this.problem(
                    [...path, 'bucket'],
                    `A step fits number fields; "${field.name}" is a ${kindLabel(field.kind)} field.`,
                );
            }
        });
    }

    private sorts() {
        const sorts = this.spec.sort ?? [];
        const outputs = new Set<string>([
            ...(this.spec.groupBy ?? []).map((g) => ('field' in g ? g.field : g.segment)),
            ...this.measures.keys(),
            ...(this.spec.time?.bucket ? this.timeFields : []),
        ]);
        const seen = new Set<string>();
        sorts.forEach((s, i) => {
            const path: Path = ['sort', i, 'field'];
            if (seen.has(s.field)) {
                this.problem(path, `"${s.field}" is sorted on twice.`);
            }
            seen.add(s.field);
            if (this.aggregate) {
                if (!outputs.has(s.field)) {
                    this.problem(
                        path,
                        `Sort by a grouping or a measure of this query (${list([...outputs])}); "${s.field}" is neither.`,
                    );
                }
                return;
            }
            const field = this.field(s.field, path);
            if (field && !SORTABLE_KINDS.includes(field.kind)) {
                this.problem(path, `${kindLabel(field.kind)} field "${field.name}" can’t be sorted on.`);
            }
        });
    }
}
