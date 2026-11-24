/**
 * The query spec compiler for transactional tables (CB-451): a checked
 * spec (`checkSpec`) becomes one parameterized SQLite statement, run
 * through `DataSpace.query` so the
 * read-only authorizer, the query runner's process, the timeout and the
 * row and byte caps all apply.
 *
 * - **Nothing a person sent becomes SQL text.** Table and column names
 *   go through `identifier()`; every value (filter values, option ids,
 *   labels, dates, constants) is a numbered `?NNN` parameter. The rest is
 *   SQL this file wrote.
 * - **It agrees with the client evaluator** (`matchesFilter`,
 *   `compareRows` in `@socio/shared/dataset-views/evaluate`): the same
 *   empties, the same ASCII case folding, the same reading of stored
 *   numbers, days and instants (`./sqlite.ts`), the same date helpers
 *   (`@socio/shared/dataset-query/dates`).
 *
 * The statement is a chain of CTEs over the table:
 *
 * - `q0` names each column the spec reads (`f<n>`) and the row key;
 * - `q1` reads them as numbers, days, instants and checkboxes;
 * - `q2` keeps the rows the filter matches and works out local days in
 *   the spec's zone (SQLite has no zones: a balanced `CASE` over the
 *   zone's offsets, `zoneStretches`);
 * - `q3` adds the time, groupings, segments and each measure's flags.
 *
 * A view (no measures, no time bucket, no comparison windows) selects
 * rows from `q3`. An aggregate groups `q3` once per window (the display
 * window, or each comparison window), fills empty time buckets from a
 * calendar, computes running values with window functions over the
 * source range and only then keeps the display buckets, and puts
 * the database's totals first, so a cut-short answer keeps them.
 */
import { DataError } from '@socio/foundation/dataspace/data-error';
import type { ColumnInfo } from '@socio/shared/data-types';
import {
    addDays,
    bucketEnd,
    bucketsOf,
    bucketStart,
    containsDay,
    periodRange,
    relativeRange,
    todayIn,
    wallInstant,
    windowLabel,
    windowRange,
    zoneStart,
    zoneStretches,
    type ClosedRange,
    type DateRange,
} from '@socio/shared/dataset-query/dates';
import { DATE_KINDS, NUMBER_KINDS, TEXT_KINDS, type FieldKind } from '@socio/shared/dataset-query/kinds';
import type { FilterOp } from '@socio/shared/dataset-query/operators';
import {
    specSegments,
    type DateBucket,
    type FilterNode,
    type FilterValue,
    type MeasureExpr,
    type QueryMeasure,
    type QuerySegment,
    type QuerySpec,
    type RunningMeasure,
} from '@socio/shared/dataset-query/spec';

import { identifier } from '../sql.js';

import type { SpecField } from './check.js';
import {
    bucketOf,
    checkedOf,
    dayOf,
    instantOf,
    isBlank,
    ITEM_TYPES,
    itemsOf,
    nextBucket,
    noItems,
    numberOf,
    textOf,
    trimmedText,
} from './sqlite.js';

export type SqlParam = string | number | null;

export interface CompileInput {
    /** A spec `checkSpec` passed. */
    spec: QuerySpec;
    /** The table's fields (`specFields`). */
    fields: Map<string, SpecField>;
    table: { name: string; columns: ColumnInfo[] };
    /** The spec's zone, resolved: the spec's own, else the viewer's or the workspace's. */
    timeZone: string;
    now: number;
    /** The viewer, for `$me`. */
    me: string;
    /** People by id, to sort a person field by name. */
    people?: ReadonlyArray<{ id: string; name: string }>;
}

/** A grouping of the answer, as `run.ts` shapes it. */
export interface PlanGroup {
    /** The column name: the field, the segment, or `<field>:<bucket>` in a view. */
    name: string;
    field?: string;
    kind: FieldKind;
    /** A segment's labels by rule, and `other` last. */
    labels?: string[];
    checkbox?: boolean;
}
export interface PlanMeasure {
    name: string;
    kind: FieldKind;
    base: boolean;
    running: boolean;
    field?: string;
    currency?: string;
    minorUnits?: boolean;
}
export interface PlanWindow {
    label: string;
    range: ClosedRange | null;
}
export interface Plan {
    mode: 'rows' | 'aggregate';
    today: string;
    timeZone: string;
    sourceRange: DateRange;
    /** Rows: the table fields shown, in column order. */
    fields: Array<{ name: string; kind: FieldKind }>;
    /** Rows: the key columns (none: the rowid). */
    keys: string[];
    groups: PlanGroup[];
    /** The time bucket and the column it is shown in (aggregates). */
    bucket?: DateBucket;
    timeName?: string;
    timeKind?: FieldKind;
    measures: PlanMeasure[];
    /** The display window (one entry, or none), or the comparison windows. */
    windows: PlanWindow[];
    comparison: boolean;
    totals: boolean;
    subtotals: boolean;
    verified: boolean;
    coverage?: string[];
    /** Base measures, in `measures` order, by their index there. */
    baseMeasures: number[];
}

export interface CompiledSpec {
    sql: string;
    params: SqlParam[];
    plan: Plan;
}

/** The most buckets one window may fill (`bucketsOf`'s cap). */
export const MAX_BUCKETS = 5_000;

/** Numbered parameters, one per distinct value, so a value used twice is bound once. */
class Binder {
    readonly params: SqlParam[] = [];
    private index = new Map<string, number>();
    bind(value: SqlParam | boolean): string {
        const v = typeof value === 'boolean' ? Number(value) : value;
        const key = v === null ? 'null' : `${typeof v}:${v}`;
        let at = this.index.get(key);
        if (at === undefined) {
            this.params.push(v);
            at = this.params.length;
            this.index.set(key, at);
        }
        return `?${at}`;
    }
}

/** ASCII lower case, as SQLite's `lower()` and the evaluator's `fold`. */
const fold = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());
const LIST_KINDS: readonly FieldKind[] = ['multi_select', 'people', 'file'];
const and = (parts: string[]) => (parts.length ? `(${parts.join(' AND ')})` : '1');
const or = (parts: string[]) => (parts.length ? `(${parts.join(' OR ')})` : '0');

/**
 * The columns a spec reads, each named once in `q0` and read as the
 * kinds need in `q1` and `q2`.
 */
class FieldRefs {
    private used = new Map<string, { alias: string; needs: Set<'n' | 'd' | 'ms' | 'c' | 'ld'> }>();
    constructor(private fields: Map<string, SpecField>) {}
    private entry(name: string) {
        let e = this.used.get(name);
        if (!e) {
            // Checked: the field exists and `identifier()` takes its name.
            identifier(name, 'column');
            e = { alias: `f${this.used.size}`, needs: new Set() };
            this.used.set(name, e);
        }
        return e;
    }
    raw(name: string) {
        return this.entry(name).alias;
    }
    private need(name: string, what: 'n' | 'd' | 'ms' | 'c' | 'ld') {
        const e = this.entry(name);
        e.needs.add(what);
        if (what === 'ld') {
            e.needs.add('ms');
        }
        return `${e.alias}_${what}`;
    }
    num = (name: string) => this.need(name, 'n');
    day = (name: string) => this.need(name, 'd');
    ms = (name: string) => this.need(name, 'ms');
    checked = (name: string) => this.need(name, 'c');
    /** A `datetime` field's calendar day in the spec's zone (or a `date` field's day). */
    localDay = (name: string) =>
        this.fields.get(name)?.kind === 'datetime' ? this.need(name, 'ld') : this.need(name, 'd');
    /** `q0`'s, `q1`'s and `q2`'s columns. */
    layers(zoneOffset: (ms: string) => string) {
        const q0: string[] = [];
        const q1: string[] = [];
        const q2: string[] = [];
        for (const [name, { alias, needs }] of this.used) {
            q0.push(`t.${identifier(name, 'column')} AS ${alias}`);
            if (needs.has('ms')) {
                q0.push(`${trimmedText(`t.${identifier(name, 'column')}`)} AS ${alias}_s`);
                q1.push(`${instantOf(alias, `${alias}_s`)} AS ${alias}_ms`);
            }
            if (needs.has('n')) {
                q1.push(`${numberOf(alias)} AS ${alias}_n`);
            }
            if (needs.has('d')) {
                q1.push(`${dayOf(alias)} AS ${alias}_d`);
            }
            if (needs.has('c')) {
                q1.push(`${checkedOf(alias)} AS ${alias}_c`);
            }
            if (needs.has('ld')) {
                q2.push(
                    `CASE WHEN ${alias}_ms IS NOT NULL THEN date((${alias}_ms + ${zoneOffset(`${alias}_ms`)}) / 1000.0, 'unixepoch') END AS ${alias}_ld`,
                );
            }
        }
        return { q0, q1, q2 };
    }
}

/** Compiles a checked spec to one SQLite statement and the plan to shape its rows. */
export function compileSpec(input: CompileInput): CompiledSpec {
    return new Compiler(input).compile();
}

class Compiler {
    private b = new Binder();
    private refs: FieldRefs;
    private spec: QuerySpec;
    private today: string;
    private zone: string;
    private segments: QuerySegment[];
    private measures: QueryMeasure[];
    private byName = new Map<string, QueryMeasure>();
    /** `q3`'s extra columns. */
    private q3: string[] = [];
    private span: { from: number; to: number } = { from: -Infinity, to: Infinity };

    constructor(private input: CompileInput) {
        this.spec = input.spec;
        this.zone = input.timeZone;
        this.today = todayIn(this.zone, input.now);
        this.refs = new FieldRefs(input.fields);
        this.segments = specSegments(this.spec);
        this.measures = this.spec.measures ?? [];
        for (const m of this.measures) {
            this.byName.set(m.name, m);
        }
    }

    private field(name: string): SpecField {
        const field = this.input.fields.get(name);
        if (!field) {
            // checkSpec refuses unknown fields; reaching here is a bug, not input.
            throw new Error(`Unknown field ${name}: run checkSpec first.`);
        }
        return field;
    }
    private kindOf(name: string): FieldKind {
        const field = this.field(name);
        return field.kind === 'id' ? field.baseKind : field.kind;
    }
    private get aggregate() {
        return !!this.measures.length || !!this.spec.time?.bucket || !!this.spec.windows?.length;
    }

    // Filters ----------------------------------------------------------------

    /** A filter as SQL that is 1 or 0, never null. */
    filter(node: FilterNode): string {
        if ('all' in node) {
            return and(node.all.map((n) => this.filter(n)));
        }
        if ('any' in node) {
            return or(node.any.map((n) => this.filter(n)));
        }
        return this.condition(node.field, node.op, node.value);
    }

    private empty(name: string, kind: FieldKind) {
        const raw = this.refs.raw(name);
        return LIST_KINDS.includes(kind) ? noItems(raw) : isBlank(raw);
    }

    /** A filter value with `$me` resolved to the viewer. */
    private resolve(value: unknown): unknown {
        return value && typeof value === 'object' && !Array.isArray(value) && '$me' in value ? this.input.me : value;
    }

    private condition(name: string, op: FilterOp, value: FilterValue | undefined): string {
        const kind = this.kindOf(name);
        const b = this.b;
        if (op === 'is_empty') {
            return this.empty(name, kind);
        }
        if (op === 'is_not_empty') {
            return `NOT ${this.empty(name, kind)}`;
        }
        const list = (Array.isArray(value) ? value : [value]).map((v) => this.resolve(v));
        const one = list[0];
        if (TEXT_KINDS.includes(kind)) {
            const want = fold(String(one));
            const empty = this.empty(name, kind);
            if (want === '' && (op === 'is' || op === 'is_not')) {
                return op === 'is' ? empty : `NOT ${empty}`;
            }
            const low = `lower(${this.refs.raw(name)})`;
            const p = b.bind(want);
            switch (op) {
                case 'is':
                    return `(NOT ${empty} AND ${low} = ${p})`;
                case 'is_not':
                    return `(${empty} OR ${low} <> ${p})`;
                case 'contains':
                    return `(NOT ${empty} AND instr(${low}, ${p}) > 0)`;
                case 'not_contains':
                    return `(${empty} OR instr(${low}, ${p}) = 0)`;
                case 'starts_with':
                    return `(NOT ${empty} AND instr(${low}, ${p}) = 1)`;
                case 'ends_with':
                    return `(NOT ${empty} AND length(${low}) >= length(${p}) AND substr(${low}, -length(${p})) = ${p})`;
            }
        }
        if (NUMBER_KINDS.includes(kind)) {
            const n = this.refs.num(name);
            const [x, y] = list.map((v) => b.bind(v as number));
            const ops: Partial<Record<FilterOp, string>> = { eq: '=', lt: '<', lte: '<=', gt: '>', gte: '>=' };
            if (op === 'neq') {
                return `(${n} IS NULL OR ${n} <> ${x})`;
            }
            if (op === 'between') {
                return `coalesce(${n} >= ${x} AND ${n} <= ${y}, 0)`;
            }
            return `coalesce(${n} ${ops[op]} ${x}, 0)`;
        }
        switch (kind) {
            case 'checkbox':
                return `(${this.refs.checked(name)} = ${one === true ? 1 : 0})`;
            case 'date':
                return this.dateCondition(name, op, value);
            case 'datetime':
                return this.datetimeCondition(name, op, value);
            case 'select':
            case 'person': {
                const raw = this.refs.raw(name);
                const empty = isBlank(raw);
                const text = `(${textOf(raw)})`;
                const wanted = list.map((v) => b.bind(String(v)));
                switch (op) {
                    case 'is':
                        return `(NOT ${empty} AND ${text} = ${wanted[0]})`;
                    case 'is_not':
                        return `(${empty} OR ${text} <> ${wanted[0]})`;
                    case 'is_any_of':
                        return `(NOT ${empty} AND ${text} IN (${wanted.join(', ')}))`;
                    case 'is_none_of':
                        return `(${empty} OR ${text} NOT IN (${wanted.join(', ')}))`;
                }
                break;
            }
            case 'multi_select':
            case 'people': {
                const items = `json_each(${itemsOf(this.refs.raw(name))})`;
                const distinct = [...new Set(list.map(String))];
                const wanted = distinct.map((v) => b.bind(v)).join(', ');
                const matching = `FROM ${items} WHERE ${ITEM_TYPES} AND (${textOf('value')}) IN (${wanted})`;
                switch (op) {
                    case 'has_any_of':
                        return `EXISTS (SELECT 1 ${matching})`;
                    case 'has_none_of':
                        return `NOT EXISTS (SELECT 1 ${matching})`;
                    case 'has_all_of':
                        return `((SELECT count(DISTINCT (${textOf('value')})) ${matching}) = ${distinct.length})`;
                }
                break;
            }
        }
        // checkSpec holds every operator to its kind.
        throw new Error(`No SQL for "${op}" on ${kind}: run checkSpec first.`);
    }

    /** A filter's day: `today`, or `YYYY-MM-DD`. */
    private dayValue(value: unknown): string {
        return value === 'today' ? this.today : String(value);
    }
    /** A `within` value's dates. */
    private within(value: FilterValue | undefined): ClosedRange {
        const v = value as { relative?: 'past' | 'next'; count?: number; unit?: never; period?: never };
        return 'period' in v
            ? periodRange(v.period as never, this.today)
            : relativeRange(v.relative!, v.count!, v.unit!, this.today);
    }

    private dateCondition(name: string, op: FilterOp, value: FilterValue | undefined) {
        const d = this.refs.day(name);
        const b = this.b;
        if (op === 'within') {
            const range = this.within(value);
            return `coalesce(${d} >= ${b.bind(range.from)} AND ${d} <= ${b.bind(range.to)}, 0)`;
        }
        if (op === 'between') {
            const [from, to] = (value as unknown[]).map((v) => b.bind(this.dayValue(v)));
            return `coalesce(${d} >= ${from} AND ${d} <= ${to}, 0)`;
        }
        const ops: Partial<Record<FilterOp, string>> = {
            is: '=',
            before: '<',
            after: '>',
            on_or_before: '<=',
            on_or_after: '>=',
        };
        return `coalesce(${d} ${ops[op]} ${b.bind(this.dayValue(value))}, 0)`;
    }

    /** A bound as [first instant, first instant after]: a day covers the day in the zone. */
    private instantBound(value: unknown): [number, number] {
        if (value === 'today' || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))) {
            const day = this.dayValue(value);
            return [zoneStart(day, this.zone), zoneStart(addDays(day, 1), this.zone)];
        }
        const at = wallInstant(String(value), this.zone);
        if (at === undefined) {
            throw new Error(`Not a date and time: ${String(value).slice(0, 40)}; run checkSpec first.`);
        }
        return [at, at + 1];
    }

    private datetimeCondition(name: string, op: FilterOp, value: FilterValue | undefined) {
        const ms = this.refs.ms(name);
        const b = this.b;
        const range = (from: number, to: number) => `coalesce(${ms} >= ${b.bind(from)} AND ${ms} < ${b.bind(to)}, 0)`;
        if (op === 'within') {
            const days = this.within(value);
            return range(zoneStart(days.from, this.zone), zoneStart(addDays(days.to, 1), this.zone));
        }
        if (op === 'between') {
            const [from, to] = (value as unknown[]).map((v) => this.instantBound(v));
            return range(from[0], to[1]);
        }
        const [start, end] = this.instantBound(value);
        switch (op) {
            case 'is':
                return range(start, end);
            case 'before':
                return `coalesce(${ms} < ${b.bind(start)}, 0)`;
            case 'after':
                return `coalesce(${ms} >= ${b.bind(end)}, 0)`;
            case 'on_or_before':
                return `coalesce(${ms} < ${b.bind(end)}, 0)`;
            case 'on_or_after':
                return `coalesce(${ms} >= ${b.bind(start)}, 0)`;
        }
        throw new Error(`No SQL for "${op}" on datetime: run checkSpec first.`);
    }

    // Sorting rows, as `compareRows` ---------------------------------------------

    /** ORDER BY terms for one field: empties last (or first), then its sort key in `dir`. */
    private fieldSort(name: string, dir: 'asc' | 'desc', empty: 'first' | 'last' = 'last'): string[] {
        const field = this.field(name);
        const kind = field.kind;
        const raw = this.refs.raw(name);
        const d = dir === 'desc' ? ' DESC' : '';
        const emptyLast = (isEmpty: string) =>
            `(CASE WHEN ${isEmpty} THEN ${empty === 'first' ? 0 : 1} ELSE ${empty === 'first' ? 1 : 0} END)`;
        switch (kind) {
            case 'checkbox':
                return [`${this.refs.checked(name)}${d}`];
            case 'number':
            case 'currency':
            case 'percent': {
                const n = this.refs.num(name);
                return [emptyLast(`${n} IS NULL`), `${n}${d}`];
            }
            case 'date': {
                const day = this.refs.day(name);
                return [emptyLast(`${day} IS NULL`), `${day}${d}`];
            }
            case 'datetime': {
                const ms = this.refs.ms(name);
                return [emptyLast(`${ms} IS NULL`), `${ms}${d}`];
            }
            case 'select': {
                const options = field.options ?? [];
                const text = `(${textOf(raw)})`;
                const index = options.length
                    ? `CASE ${text} ${options.map((o, i) => `WHEN ${this.b.bind(o.id)} THEN ${i}`).join(' ')} ELSE ${options.length} END`
                    : '0';
                const keyed = (key: string) => `(CASE WHEN ${isBlank(raw)} THEN NULL ELSE ${key} END)${d}`;
                return [
                    emptyLast(isBlank(raw)),
                    keyed(index),
                    keyed(`lower(${text})`),
                    keyed(`${text} COLLATE BINARY`),
                ];
            }
            case 'person': {
                const people = this.input.people ?? [];
                const text = `(${textOf(raw)})`;
                // Names bound as parameters; past 2,000 people, by id.
                const name =
                    people.length && people.length <= 2_000
                        ? `(CASE ${text} ${people.map((p) => `WHEN ${this.b.bind(p.id)} THEN ${this.b.bind(p.name)}`).join(' ')} ELSE ${text} END)`
                        : text;
                const keyed = (key: string) => `(CASE WHEN ${isBlank(raw)} THEN NULL ELSE ${key} END)${d}`;
                return [emptyLast(isBlank(raw)), keyed(`lower(${name})`), keyed(`${name} COLLATE BINARY`)];
            }
            default: {
                // Text, ids: numbers before text, then text as NOCASE and code points.
                const numeric = `typeof(${raw}) IN ('integer', 'real')`;
                const keyed = (key: string) => `(CASE WHEN ${isBlank(raw)} THEN NULL ELSE ${key} END)${d}`;
                return [
                    emptyLast(isBlank(raw)),
                    keyed(`(CASE WHEN ${numeric} THEN 0 ELSE 1 END)`),
                    keyed(`(CASE WHEN ${numeric} THEN ${raw} END)`),
                    keyed(`lower(${raw})`),
                    keyed(`${raw} COLLATE BINARY`),
                ];
            }
        }
    }

    // Time, groupings and segments --------------------------------------------

    /** The spec's time fields, in fallback order. */
    private timeFields(): string[] {
        const time = this.spec.time;
        if (!time) {
            return [];
        }
        return typeof time.field === 'string' ? [time.field] : time.field.coalesce;
    }
    /** `q3`'s `c_t` (the row's day in the zone) and `c_tf` (which fallback field gave it). */
    private timeColumns() {
        const names = this.timeFields();
        if (!names.length) {
            return;
        }
        const days = names.map((n) => this.refs.localDay(n));
        this.q3.push(days.length === 1 ? `${days[0]} AS c_t` : `coalesce(${days.join(', ')}) AS c_t`);
        if (days.length > 1) {
            this.q3.push(`CASE ${days.map((d, i) => `WHEN ${d} IS NOT NULL THEN ${i}`).join(' ')} END AS c_tf`);
        }
    }

    /** A grouping's key in `q3` (`c_g<n>`) and its natural order (option order, empty last). */
    private groupKey(
        group: NonNullable<QuerySpec['groupBy']>[number],
        n: number,
    ): PlanGroup & { order: (key: string, dir: string) => string[] } {
        const alias = `c_g${n}`;
        if ('segment' in group) {
            const segment = this.segments.find((s) => s.name === group.segment)!;
            const rules = segment.rules.map((r, i) => `WHEN ${this.filter(r.when)} THEN ${i}`).join(' ');
            this.q3.push(`CASE ${rules} ELSE ${segment.rules.length} END AS ${alias}`);
            return {
                name: segment.name,
                kind: 'text',
                labels: [...segment.rules.map((r) => r.label), segment.other],
                order: (key, dir) => [`${key}${dir}`],
            };
        }
        const field = this.field(group.field);
        const kind = this.kindOf(group.field);
        const raw = this.refs.raw(group.field);
        const nullsLast = (key: string, dir: string) => [`(${key} IS NULL)`, `${key}${dir}`];
        let key: string;
        let order = nullsLast;
        let shownKind: FieldKind = field.kind;
        if (DATE_KINDS.includes(kind)) {
            const day = this.refs.localDay(group.field);
            key = typeof group.bucket === 'string' ? bucketOf(day, group.bucket) : day;
            shownKind = 'date';
        } else if (NUMBER_KINDS.includes(kind)) {
            const num = this.refs.num(group.field);
            key =
                typeof group.bucket === 'object'
                    ? `(floor(${num} / ${this.b.bind(group.bucket.step)}) * ${this.b.bind(group.bucket.step)})`
                    : num;
        } else if (kind === 'checkbox') {
            key = this.refs.checked(group.field);
        } else {
            key = `CASE WHEN ${isBlank(raw)} THEN NULL ELSE ${raw} END`;
            if (field.kind === 'select' && field.options?.length) {
                const options = field.options;
                order = (k, dir) => [
                    `(${k} IS NULL)`,
                    `(CASE ${k} COLLATE BINARY ${options.map((o, i) => `WHEN ${this.b.bind(o.id)} THEN ${i}`).join(' ')} ELSE ${options.length} END)${dir}`,
                    `${k}${dir}`,
                ];
            }
        }
        this.q3.push(`${key} AS ${alias}`);
        const bucketed = typeof group.bucket === 'string' && !this.aggregate;
        return {
            name: bucketed ? `${group.field}:${group.bucket}` : group.field,
            field: group.field,
            kind: shownKind,
            ...(kind === 'checkbox' ? { checkbox: true } : {}),
            order,
        };
    }

    // The zone -------------------------------------------------------------------

    /** The zone's offset at an instant, as a balanced CASE over its offsets in the span read. */
    private zoneOffset(ms: string): string {
        const all = zoneStretches(this.zone);
        const lo = this.span.from;
        const hi = this.span.to;
        let first = 0;
        while (first + 1 < all.length && all[first + 1]!.at <= lo) {
            first++;
        }
        const stretches = all.slice(first).filter((s, i) => i === 0 || s.at <= hi);
        const tree = (items: typeof stretches): string => {
            if (items.length === 1) {
                return this.b.bind(items[0]!.offset);
            }
            const mid = Math.ceil(items.length / 2);
            return `CASE WHEN ${ms} < ${this.b.bind(items[mid]!.at)} THEN ${tree(items.slice(0, mid))} ELSE ${tree(items.slice(mid))} END`;
        };
        return `(${tree(stretches)})`;
    }

    // Compile ------------------------------------------------------------------------

    compile(): CompiledSpec {
        return this.aggregate ? this.compileAggregate() : this.compileRows();
    }

    /** The windows: the display window (or all time), or each comparison window. */
    private windowPlan(): { windows: PlanWindow[]; comparison: boolean } {
        const spec = this.spec;
        if (spec.windows?.length) {
            return {
                windows: spec.windows.map((w) => ({ label: windowLabel(w), range: windowRange(w, this.today) })),
                comparison: true,
            };
        }
        return {
            windows: [
                {
                    label: spec.window ? windowLabel(spec.window) : 'all',
                    range: spec.window ? windowRange(spec.window, this.today) : null,
                },
            ],
            comparison: false,
        };
    }

    /** Sets the span the zone's offsets must cover: the days read, a day either side. */
    private setSpan(range: DateRange) {
        this.span = {
            from: range.from === null ? -Infinity : Date.parse(`${range.from}T00:00:00Z`) - 2 * 86_400_000,
            to: range.to === null ? Infinity : Date.parse(`${range.to}T00:00:00Z`) + 3 * 86_400_000,
        };
    }

    private head(where: string) {
        const t = identifier(this.input.table.name, 'table');
        const keys = this.keyColumns();
        const keyCols = keys.length ? keys.map((k, i) => `t.${identifier(k, 'column')} AS k${i}`) : ['t.rowid AS k0'];
        const { q0, q1, q2 } = this.refs.layers((ms) => this.zoneOffset(ms));
        return [
            `q0 AS (SELECT ${[...keyCols, ...q0].join(', ')} FROM ${t} AS t)`,
            `q1 AS (SELECT ${['*', ...q1].join(', ')} FROM q0)`,
            `q2 AS (SELECT ${['*', ...q2].join(', ')} FROM q1 WHERE ${where})`,
            `q3 AS (SELECT ${['*', ...this.q3].join(', ')} FROM q2)`,
        ];
    }

    /** A `datetime` grouping other than the time: its days may lie outside the rows' dates. */
    private wholeSpan() {
        return (this.spec.groupBy ?? []).some(
            (g) => 'field' in g && this.field(g.field).kind === 'datetime' && !this.timeFields().includes(g.field),
        );
    }

    private keyColumns() {
        return this.input.table.columns.filter((c) => c.primaryKey).map((c) => c.name);
    }

    /** The condition that a row's day falls in a range (no range: every row). */
    private inRange(range: DateRange | null) {
        if (!range || (range.from === null && range.to === null)) {
            return '1';
        }
        const parts = ['c_t IS NOT NULL'];
        if (range.from !== null) {
            parts.push(`c_t >= ${this.b.bind(range.from)}`);
        }
        if (range.to !== null) {
            parts.push(`c_t <= ${this.b.bind(range.to)}`);
        }
        return and(parts);
    }

    // A view: rows ----------------------------------------------------------------------

    private compileRows(): CompiledSpec {
        const spec = this.spec;
        const where = spec.filter ? this.filter(spec.filter) : '1';
        const shown = [...this.input.fields.values()].filter(
            (f) => f.nameable && f.kind !== 'blob' && f.baseKind !== 'blob',
        );
        for (const f of shown) {
            this.refs.raw(f.name);
        }
        this.timeColumns();
        const range = spec.window ? windowRange(spec.window, this.today) : null;
        this.setSpan(this.wholeSpan() ? { from: null, to: null } : (range ?? { from: null, to: null }));
        const groups = (spec.groupBy ?? []).map((g, i) => this.groupKey(g, i));
        // Segments not grouped on still show, as a column each.
        const segmentCols: PlanGroup[] = [];
        this.segments.forEach((segment, i) => {
            if ((spec.groupBy ?? []).some((g) => 'segment' in g && g.segment === segment.name)) {
                return;
            }
            const rules = segment.rules.map((r, k) => `WHEN ${this.filter(r.when)} THEN ${k}`).join(' ');
            this.q3.push(`CASE ${rules} ELSE ${segment.rules.length} END AS c_s${i}`);
            segmentCols.push({
                name: segment.name,
                kind: 'text',
                labels: [...segment.rules.map((r) => r.label), segment.other],
            });
        });
        const order: string[] = [];
        groups.forEach((g, i) => order.push(...g.order(`c_g${i}`, '')));
        for (const s of spec.sort ?? []) {
            order.push(...this.fieldSort(s.field, s.dir, s.empty));
        }
        const keys = this.keyColumns();
        order.push(...(keys.length ? keys.map((_, i) => `k${i}`) : ['k0']));
        const select = [
            ...(keys.length ? keys.map((_, i) => `k${i}`) : ['k0']),
            ...shown.map((f) => this.refs.raw(f.name)),
            ...groups.map((_, i) => `c_g${i}`),
            ...segmentCols.map((_, i) => `c_s${this.segments.findIndex((s) => s.name === segmentCols[i]!.name)}`),
            'count(*) OVER () AS c_n',
        ];
        const head = this.head(where);
        const sql = `WITH ${head.join(',\n')}\nSELECT ${select.join(', ')} FROM q3 WHERE ${this.inRange(range)} ORDER BY ${order.join(', ')}`;
        return {
            sql,
            params: this.b.params,
            plan: {
                mode: 'rows',
                today: this.today,
                timeZone: this.zone,
                sourceRange: range ?? { from: null, to: null },
                fields: shown.map((f) => ({ name: f.name, kind: f.kind })),
                keys,
                groups: [...groups.map(({ order: _, ...g }) => g), ...segmentCols],
                measures: [],
                windows: range ? [{ label: windowLabel(spec.window!), range }] : [],
                comparison: false,
                totals: !!spec.totals,
                subtotals: false,
                verified: false,
                baseMeasures: [],
            },
        };
    }

    // Aggregates ----------------------------------------------------------------------

    private hasVerified() {
        return !!this.spec.source.verified || this.measures.some((m) => 'op' in m && !!m.verified);
    }

    /** A measure's kind and currency in the answer. */
    private plans = new Map<string, PlanMeasure>();
    /** Each measure's plan, worked out once (derived ones read their inputs'). */
    private measurePlan(m: QueryMeasure): PlanMeasure {
        let plan = this.plans.get(m.name);
        if (!plan) {
            // A placeholder first, so a (refused) cycle can't recurse.
            this.plans.set(m.name, { name: m.name, kind: 'number', base: false, running: false });
            plan = this.planOf(m);
            this.plans.set(m.name, plan);
        }
        return plan;
    }
    private planOf(m: QueryMeasure): PlanMeasure {
        if ('op' in m) {
            const field = m.field ? this.field(m.field) : undefined;
            const kind = m.field ? this.kindOf(m.field) : undefined;
            const counts = m.op === 'count' || m.op === 'count_distinct';
            const shown: FieldKind = counts
                ? 'number'
                : (m.op === 'min' || m.op === 'max') && kind && DATE_KINDS.includes(kind)
                  ? kind
                  : field && NUMBER_KINDS.includes(field.kind)
                    ? field.kind
                    : 'number';
            return {
                name: m.name,
                kind: shown,
                base: true,
                running: false,
                field: m.field,
                ...(!counts && field?.kind === 'currency' && field.currency ? { currency: field.currency } : {}),
                ...(!counts && field?.kind === 'currency' && field.minorUnits ? { minorUnits: true } : {}),
            };
        }
        // Derived and running measures carry their inputs' currency (checkSpec allows one).
        const deps = this.depsOf(m);
        const units = deps.map((d) => this.measurePlan(this.byName.get(d)!)).filter((p) => p.currency);
        return {
            name: m.name,
            kind: units.length ? 'currency' : 'number',
            base: false,
            running: 'running' in m || deps.some((d) => this.measurePlan(this.byName.get(d)!).running),
            ...(units[0]?.currency ? { currency: units[0].currency } : {}),
            ...(units[0]?.minorUnits ? { minorUnits: true } : {}),
        };
    }
    private depsOf(m: QueryMeasure): string[] {
        if ('op' in m) {
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
    private isRunning(name: string, seen = new Set<string>()): boolean {
        const m = this.byName.get(name);
        if (!m || seen.has(name)) {
            return false;
        }
        seen.add(name);
        return 'running' in m || this.depsOf(m).some((d) => this.isRunning(d, seen));
    }

    /**
     * The column another measure reads a measure from: a base measure's
     * aggregate (`c_m<n>`, or its verified part `c_v<n>` when any rows
     * are checked), any other measure's own column (`c_r<n>`).
     */
    private inputCol(name: string): string {
        const m = this.byName.get(name)!;
        const i = this.measures.indexOf(m);
        return 'op' in m ? (this.hasVerified() ? `c_v${i}` : `c_m${i}`) : `c_r${i}`;
    }
    /** A derived measure's arithmetic over its inputs' columns: each one named once, never inlined. */
    private exprSql(e: MeasureExpr): string {
        if (typeof e === 'number') {
            return this.b.bind(e);
        }
        if (typeof e === 'string') {
            return this.inputCol(e);
        }
        const [op, args] = Object.entries(e)[0] as [string, MeasureExpr[]];
        const parts = args.map((x) => this.exprSql(x));
        switch (op) {
            case 'add':
                return `(${parts.join(' + ')})`;
            case 'sub':
                return `(${parts[0]} - ${parts[1]})`;
            case 'mul':
                return `(${parts.join(' * ')})`;
            default:
                // Null on zero.
                return `(CASE WHEN ${parts[1]} = 0 THEN NULL ELSE (${parts[0]}) * 1.0 / ${parts[1]} END)`;
        }
    }
    /** A measure's level: base measures 0, any other one past every measure it reads (checkSpec refuses cycles). */
    private levels = new Map<string, number>();
    private levelOf(name: string, depth = 0): number {
        const known = this.levels.get(name);
        if (known !== undefined) {
            return known;
        }
        const m = this.byName.get(name)!;
        const level =
            'op' in m || depth > this.measures.length
                ? 0
                : 1 + Math.max(0, ...this.depsOf(m).map((d) => this.levelOf(d, depth + 1)));
        this.levels.set(name, level);
        return level;
    }
    /**
     * `from` with every measure's column `c_r<n>`, one subquery per level,
     * so each measure is computed once and a measure that reads another
     * reads its column: the statement grows with the spec, not with how
     * often measures refer to each other. Base measures show every row,
     * or (for totals) the verified ones; without `running`, running
     * values are null.
     */
    private layered(
        from: string,
        options: { base: 'all' | 'verified'; running?: (of: string, m: RunningMeasure) => string },
    ): string {
        const base = this.measures.flatMap((m, i) =>
            'op' in m ? [`${options.base === 'verified' ? `c_v${i}` : `c_m${i}`} AS c_r${i}`] : [],
        );
        let sql = `SELECT ${['*', ...base].join(', ')} FROM ${from}`;
        const levels = this.measures.map((m) => this.levelOf(m.name));
        for (let level = 1; level <= Math.max(0, ...levels); level++) {
            const cols = this.measures.flatMap((m, i) => {
                if (levels[i] !== level || 'op' in m) {
                    return [];
                }
                if ('running' in m) {
                    return [`${options.running ? options.running(this.inputCol(m.running.of), m) : 'NULL'} AS c_r${i}`];
                }
                return [`${this.exprSql(m.expr)} AS c_r${i}`];
            });
            sql = `SELECT ${['*', ...cols].join(', ')} FROM (${sql})`;
        }
        return `(${sql})`;
    }

    /** A bucket's place in a window: how many buckets after the window's first (`first`, a bucket start) it starts. */
    private bucketPlace(b: string, first: string, bucket: DateBucket): string {
        const months = (d: string) =>
            `(CAST(strftime('%Y', ${d}) AS INTEGER) * 12 + CAST(strftime('%m', ${d}) AS INTEGER))`;
        const f = this.b.bind(first);
        switch (bucket) {
            case 'day':
                return `CAST(round(julianday(${b}) - julianday(${f})) AS INTEGER)`;
            case 'week':
                return `CAST(round((julianday(${b}) - julianday(${f})) / 7) AS INTEGER)`;
            case 'month':
                return `(${months(b)} - ${months(f)})`;
            case 'quarter':
                return `((${months(b)} - ${months(f)}) / 3)`;
            case 'year':
                return `(CAST(strftime('%Y', ${b}) AS INTEGER) - CAST(strftime('%Y', ${f}) AS INTEGER))`;
        }
    }

    /** The aggregates of each base measure (`c_m`), its verified part (`c_v`) and its excluded part (`c_x`). */
    private baseAggregates(inWindow: string, empty: boolean): string[] {
        const out: string[] = [];
        const verified = this.hasVerified();
        this.measures.forEach((m, i) => {
            if (!('op' in m)) {
                return;
            }
            const value = `c_val${i}`;
            const flag = `c_in${i}`;
            const agg = (extra: string) => {
                const when = and([inWindow, flag, ...(extra ? [extra] : [])].filter((p) => p !== '1'));
                switch (m.op) {
                    case 'count':
                        return `count(CASE WHEN ${when} AND ${value} IS NOT NULL THEN 1 END)`;
                    case 'count_distinct':
                        return `count(DISTINCT CASE WHEN ${when} THEN ${value} END)`;
                    default:
                        return `${m.op}(CASE WHEN ${when} THEN ${value} END)`;
                }
            };
            out.push(`${empty ? 'NULL' : agg('')} AS c_m${i}`);
            if (verified) {
                out.push(`${empty ? 'NULL' : agg(`c_ok${i}`)} AS c_v${i}`);
                out.push(`${empty ? 'NULL' : agg(`NOT c_ok${i}`)} AS c_x${i}`);
            }
        });
        if (verified) {
            out.push(`${empty ? 'NULL' : `count(CASE WHEN ${inWindow} AND c_unv THEN 1 END)`} AS c_unv`);
        }
        return out;
    }

    /** `q3`'s per-measure value, filter and verified flags. */
    private measureColumns() {
        const verified = this.hasVerified();
        const source = this.spec.source.verified ? this.filter(this.spec.source.verified) : '1';
        const oks: string[] = [];
        this.measures.forEach((m, i) => {
            if (!('op' in m)) {
                return;
            }
            let value = '1';
            if (m.field) {
                const kind = this.kindOf(m.field);
                if (m.op === 'count' || m.op === 'count_distinct') {
                    const raw = this.refs.raw(m.field);
                    value = `CASE WHEN ${this.empty(m.field, kind)} THEN NULL ELSE ${raw} END`;
                } else if (NUMBER_KINDS.includes(kind)) {
                    value = this.refs.num(m.field);
                } else if (kind === 'date') {
                    value = this.refs.day(m.field);
                } else {
                    value = this.refs.ms(m.field);
                }
            }
            this.q3.push(`${value} AS c_val${i}`);
            this.q3.push(`${m.where ? this.filter(m.where) : '1'} AS c_in${i}`);
            if (verified) {
                const ok = and([source, ...(m.verified ? [this.filter(m.verified)] : [])].filter((p) => p !== '1'));
                this.q3.push(`${ok} AS c_ok${i}`);
                oks.push(`c_ok${i}`);
            }
        });
        if (verified) {
            // A row is unverified when the source's check, or any measure's, leaves it out.
            const ok = and(
                [
                    source,
                    ...this.measures.flatMap((m) => ('op' in m && m.verified ? [this.filter(m.verified)] : [])),
                ].filter((p) => p !== '1'),
            );
            this.q3.push(`NOT ${ok} AS c_unv`);
        }
    }

    private compileAggregate(): CompiledSpec {
        const spec = this.spec;
        const bucket = spec.time?.bucket;
        const { windows, comparison } = this.windowPlan();
        const where = spec.filter ? this.filter(spec.filter) : '1';
        this.timeColumns();
        const groups = (spec.groupBy ?? []).map((g, i) => this.groupKey(g, i));
        this.measureColumns();
        const verified = this.hasVerified();
        const runnings = this.measures.filter((m): m is RunningMeasure => 'running' in m);
        const timeOrdered = (m: (typeof runnings)[number]) =>
            !!bucket && (m.running.order === undefined || this.timeFields().includes(m.running.order));
        // The rows each window reads: the display window, widened back
        // to the earliest date a running value needs. Rows before the window
        // count only as opening balances, so they fold into opening keys that
        // sort before every bucket: '' for all earlier history, then ' 1',
        // ' 2', … from each running value's start date on.
        const reads = windows.map((w) => {
            if (!w.range) {
                return { from: null, to: null, openings: [] as string[], all: false };
            }
            const display = w.range;
            let all = false;
            const starts = new Set<string>();
            for (const r of runnings.filter(timeOrdered)) {
                const start = r.running.from ?? 'all';
                if (start === 'all') {
                    all = true;
                } else if (start !== 'window' && start < display.from) {
                    starts.add(start);
                }
            }
            const openings = [...starts].sort();
            return { from: all ? null : (openings[0] ?? display.from), to: display.to, openings, all };
        });
        const sourceRange: DateRange = windows.every((w) => w.range)
            ? {
                  from: reads.some((r) => r.from === null)
                      ? null
                      : reads.reduce((min, r) => (r.from! < min ? r.from! : min), reads[0]!.from!),
                  to: reads.reduce((max, r) => (r.to! > max ? r.to! : max), reads[0]!.to!),
              }
            : { from: null, to: null };
        this.setSpan(this.wholeSpan() ? { from: null, to: null } : sourceRange);
        const g = groups.map((_, i) => `c_g${i}`);
        const blocks: string[] = [];
        const selects: string[] = [];
        // The union's columns, in order.
        const measureCols = this.measures.map((_, i) => `c_r${i}`);
        const baseIdx = this.measures.flatMap((m, i) => ('op' in m ? [i] : []));
        const extra = [
            ...(verified ? ['c_unv', ...baseIdx.map((i) => `c_x${i}`)] : []),
            ...(this.timeFields().length > 1 ? [...this.timeFields().map((_, i) => `c_cov${i}`), 'c_none'] : []),
        ];
        const columns = () => ['c_kind', 'c_w', 'c_i', 'c_b', ...g, ...measureCols, ...extra];
        const row = (values: Record<string, string>) =>
            columns()
                .map((c) => `${values[c] ?? 'NULL'} AS ${c}`)
                .join(', ');
        const measureValues = Object.fromEntries(this.measures.map((_, i) => [`c_r${i}`, `c_r${i}`]));
        // Filling an open-ended calendar past the cap is refused when shaped, never cut short.
        const openFill = !!bucket && spec.fill !== false && windows.some((w) => !w.range);
        if (openFill) {
            extra.push('c_over');
        }

        windows.forEach((w, j) => {
            const read = reads[j]!;
            const display = w.range;
            const keys = [...(bucket ? ['c_b'] : []), ...g];
            let bucketExpr = bucket ? bucketOf('c_t', bucket) : null;
            // Rows before the window keep their own buckets, so every measure
            // is computed per bucket as it would be if shown. A start
            // (the window's, or a running value's) inside a bucket splits off
            // the bucket's earlier rows under a key that sorts just before it.
            const bounds = bucket && display ? [...new Set([...read.openings, display.from])].sort() : [];
            const split = bounds.filter((b) => bucketStart(b, bucket!) < b);
            const splitKey = (b: string) => `${addDays(bucketStart(b, bucket!), -1)}~${split.indexOf(b)}`;
            if (split.length) {
                bucketExpr = `CASE ${split.map((b) => `WHEN c_t >= ${this.b.bind(bucketStart(b, bucket!))} AND c_t < ${this.b.bind(b)} THEN ${this.b.bind(splitKey(b))}`).join(' ')} ELSE ${bucketExpr} END`;
            }
            /** The first key of rows on or after `start`, before the window. */
            const keyFrom = (start: string) => {
                const first = bucketStart(start, bucket!);
                if (first === start) {
                    return first;
                }
                const next = split.find((b) => b > start && bucketStart(b, bucket!) === first);
                return next ? splitKey(next) : first;
            };
            const readCond = bucket ? and(['c_t IS NOT NULL', this.inRange(read)]) : this.inRange(display);
            // a: the grouped rows the window reads.
            blocks.push(
                `a${j} AS (SELECT ${[...(bucket ? [`${bucketExpr} AS c_b`] : []), ...g, ...this.baseAggregates('1', false), 'count(*) AS c_rows'].join(', ')} FROM q3 WHERE ${readCond}${keys.length ? ` GROUP BY ${keys.join(', ')}` : ''})`,
            );
            let filled = `a${j}`;
            if (bucket) {
                const aggCols = this.measures.flatMap((m, i) =>
                    'op' in m ? [`c_m${i}`, ...(verified ? [`c_v${i}`, `c_x${i}`] : [])] : [],
                );
                if (verified) {
                    aggCols.push('c_unv');
                }
                const firstBucket = display ? bucketStart(display.from, bucket) : null;
                let inWindow: string;
                if (spec.fill === false) {
                    // Only the buckets with rows, each with its place in the window worked out, not looked up.
                    const place = firstBucket ? this.bucketPlace('a.c_b', firstBucket, bucket) : '0';
                    inWindow = `SELECT ${['a.c_b AS c_b', `${place} AS c_i`, ...g.map((x) => `a.${x}`), ...aggCols.map((col) => `a.${col}`)].join(', ')} FROM a${j} a${firstBucket ? ` WHERE a.c_b >= ${this.b.bind(firstBucket)}` : ''}`;
                } else {
                    if (display) {
                        try {
                            bucketsOf(display, bucket, this.today, MAX_BUCKETS);
                        } catch {
                            throw tooManyBuckets(bucket);
                        }
                    }
                    // c: the window's calendar of buckets, with each one's place in it.
                    const first = firstBucket ? this.b.bind(firstBucket) : `(SELECT min(c_b) FROM a${j})`;
                    const last = display ? this.b.bind(display.to) : `(SELECT max(c_b) FROM a${j})`;
                    blocks.push(
                        `c${j}(c_b, c_i) AS (SELECT ${first}, 0 WHERE ${first} IS NOT NULL UNION ALL SELECT ${nextBucket('c_b', bucket)}, c_i + 1 FROM c${j} WHERE ${nextBucket('c_b', bucket)} <= ${last} LIMIT ${MAX_BUCKETS + 1})`,
                    );
                    const zeroed = (col: string) => {
                        const i = Number(col.replace(/^c_[mvx]/, ''));
                        const m = this.measures[i];
                        const count = !!m && 'op' in m && (m.op === 'count' || m.op === 'count_distinct');
                        return col === 'c_unv' || count ? `coalesce(a.${col}, 0) AS ${col}` : `a.${col} AS ${col}`;
                    };
                    inWindow = `SELECT ${['c.c_b AS c_b', 'c.c_i AS c_i', ...g.map((x) => `k.${x}`), ...aggCols.map(zeroed)].join(', ')} FROM c${j} c CROSS JOIN (${g.length ? `SELECT DISTINCT ${g.join(', ')} FROM a${j}` : 'SELECT 1'}) k LEFT JOIN a${j} a ON a.c_b = c.c_b${g.map((x) => ` AND a.${x} IS k.${x}`).join('')}`;
                }
                // Rows before the window feed running values only (their c_i is null).
                const before = firstBucket
                    ? ` UNION ALL SELECT ${['c_b', 'NULL', ...g, ...aggCols].join(', ')} FROM a${j} WHERE c_b < ${this.b.bind(firstBucket)}`
                    : '';
                blocks.push(`f${j} AS (${inWindow}${before})`);
                filled = `f${j}`;
            }
            // m: measures over the grouped rows, running values over the source range.
            const running = (of: string, m: (typeof runnings)[number]) => {
                const ordered = timeOrdered(m);
                const gi = (spec.groupBy ?? []).findIndex((x) => 'field' in x && x.field === m.running.order);
                const orderKey = ordered ? 'c_b' : `c_g${gi}`;
                // In the order the groups are shown: option order, empty last.
                const orderBy = ordered ? ['c_b'] : groups[gi]!.order(orderKey, '');
                const partition = keys.filter((k) => k !== orderKey);
                const start = m.running.from ?? 'all';
                const gate =
                    !ordered || start === 'all'
                        ? '1'
                        : start === 'window'
                          ? display
                              ? `c_b >= ${this.b.bind(bucketStart(display.from, bucket!))}`
                              : '1'
                          : display && start < display.from
                            ? `c_b >= ${this.b.bind(keyFrom(start))}`
                            : `c_b >= ${this.b.bind(bucketStart(start, bucket!))}`;
                const value = gate === '1' ? of : `CASE WHEN ${gate} THEN ${of} END`;
                return `sum(${value}) OVER (${partition.length ? `PARTITION BY ${partition.join(', ')} ` : ''}ORDER BY ${orderBy.join(', ')} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;
            };
            const unverifiedCol: Record<string, string> = verified ? { c_unv: 'c_unv' } : {};
            blocks.push(
                `m${j} AS (SELECT ${row({
                    c_kind: '9',
                    c_w: String(j),
                    c_i: bucket ? 'c_i' : 'NULL',
                    c_b: bucket ? 'c_b' : 'NULL',
                    ...Object.fromEntries(g.map((x) => [x, x])),
                    ...measureValues,
                    ...unverifiedCol,
                    ...(openFill && !display ? { c_over: `(SELECT count(*) > ${MAX_BUCKETS} FROM c${j})` } : {}),
                })} FROM ${this.layered(filled, { base: 'all', running })})`,
            );
            selects.push(`SELECT * FROM m${j}${bucket ? ' WHERE c_i IS NOT NULL' : ''}`);

            // Totals over the display window, by the database, first in the answer.
            if (spec.totals || verified || this.timeFields().length > 1) {
                const inWin = this.inRange(display);
                const totals = (kind: number, by: string[]) => {
                    const aggs = this.baseAggregates('1', false);
                    const keyed = by.map((k) => (k === 'c_b' ? `${bucketOf('c_t', bucket!)} AS c_b` : k));
                    const inner = `SELECT ${[...keyed, ...aggs, 'count(*) AS c_rows', ...(kind === 0 && this.timeFields().length > 1 ? [...this.timeFields().map((_, i) => `count(CASE WHEN c_tf = ${i} THEN 1 END) AS c_cov${i}`), `(SELECT count(*) FROM q3 WHERE c_t IS NULL) AS c_none`] : [])].join(', ')} FROM q3 WHERE ${and([inWin, ...(by.includes('c_b') ? ['c_t IS NOT NULL'] : [])].filter((p) => p !== '1'))}${by.length ? ` GROUP BY ${by.join(', ')}` : ''}`;
                    const values: Record<string, string> = {
                        c_kind: String(kind),
                        c_w: String(j),
                        c_b: by.includes('c_b') ? 'z.c_b' : 'NULL',
                        c_i:
                            by.includes('c_b') && display
                                ? this.bucketPlace('z.c_b', bucketStart(display.from, bucket!), bucket!)
                                : by.includes('c_b')
                                  ? '0'
                                  : 'NULL',
                        ...Object.fromEntries(g.filter((x) => by.includes(x)).map((x) => [x, `z.${x}`])),
                        ...Object.fromEntries(this.measures.map((_, i) => [`c_r${i}`, `z.c_r${i}`])),
                        ...(verified
                            ? { c_unv: 'z.c_unv', ...Object.fromEntries(baseIdx.map((i) => [`c_x${i}`, `z.c_x${i}`])) }
                            : {}),
                        ...(kind === 0 && this.timeFields().length > 1
                            ? {
                                  ...Object.fromEntries(this.timeFields().map((_, i) => [`c_cov${i}`, `z.c_cov${i}`])),
                                  c_none: 'z.c_none',
                              }
                            : {}),
                    };
                    selects.unshift(
                        `SELECT ${row(values)} FROM ${this.layered(`(${inner})`, { base: verified ? 'verified' : 'all' })} z`,
                    );
                };
                const dims = [...(bucket ? ['c_b'] : []), ...g];
                if (spec.totals && dims.length === 2) {
                    totals(2, [dims[1]!]);
                    totals(1, [dims[0]!]);
                }
                totals(0, []);
            }
        });

        // Order: totals first, then the data in the spec's order or the natural one.
        const order: string[] = ['c_kind'];
        const groupOrders = groups.map((grp, i) => grp.order(`c_g${i}`, ''));
        const sortKey = (name: string, dir: string, empty: 'first' | 'last' = 'last') => {
            const desc = dir === 'desc' ? ' DESC' : '';
            if (bucket && this.timeFields().includes(name)) {
                return comparison ? [`c_i${desc}`] : [`c_b${desc}`];
            }
            const gi = (spec.groupBy ?? []).findIndex((x) => ('field' in x ? x.field : x.segment) === name);
            if (gi >= 0) {
                return groups[gi]!.order(`c_g${gi}`, desc);
            }
            const mi = this.measures.findIndex((m) => m.name === name);
            const key = comparison ? `c_s${mi}` : `c_r${mi}`;
            return [`(${key} IS NULL) ${empty === 'first' ? 'DESC' : ''}`.trim(), `${key}${desc}`];
        };
        for (const s of spec.sort ?? []) {
            order.push(...sortKey(s.field, s.dir, s.empty));
        }
        if (bucket) {
            order.push(comparison ? 'c_i' : 'c_b');
        }
        groupOrders.forEach((o) => order.push(...o));
        order.push('c_w');
        // With comparison windows, a measure sorts by its first window's value.
        const sortMeasures = comparison
            ? (spec.sort ?? []).flatMap((s) => {
                  const mi = this.measures.findIndex((m) => m.name === s.field);
                  const part = [...(bucket ? ['c_i'] : []), ...g];
                  return mi >= 0
                      ? [
                            `max(CASE WHEN c_w = 0 THEN c_r${mi} END) OVER (PARTITION BY c_kind${part.map((p) => `, ${p}`).join('')}) AS c_s${mi}`,
                        ]
                      : [];
              })
            : [];
        const union = selects.join('\nUNION ALL\n');
        const sql = `WITH RECURSIVE ${[...this.head(where), ...blocks].join(',\n')}\nSELECT ${columns().join(', ')} FROM (SELECT *${sortMeasures.map((s) => `, ${s}`).join('')} FROM (${union})) ORDER BY ${order.join(', ')}`;
        const timeNames = this.timeFields();
        return {
            sql,
            params: this.b.params,
            plan: {
                mode: 'aggregate',
                today: this.today,
                timeZone: this.zone,
                sourceRange,
                fields: [],
                keys: [],
                groups: groups.map(({ order: _, ...grp }) => grp),
                ...(bucket ? { bucket, timeName: timeNames[0], timeKind: 'date' as FieldKind } : {}),
                measures: this.measures.map((m) => this.measurePlan(m)),
                windows,
                comparison,
                totals: !!spec.totals,
                subtotals: !!spec.totals && [...(bucket ? ['c_b'] : []), ...g].length === 2,
                verified,
                ...(timeNames.length > 1 ? { coverage: timeNames } : {}),
                baseMeasures: baseIdx,
            },
        };
    }
}

/** A filled answer past the bucket cap: refused, never cut short. */
export function tooManyBuckets(bucket: DateBucket) {
    return new DataError(
        `This answer would fill more than 5,000 ${bucket} buckets: use a larger bucket, a shorter window, or fill: false.`,
        400,
    );
}

/** Whether a bucket starting on `start` contains today. */
export function bucketPartial(start: string, bucket: DateBucket, today: string) {
    return containsDay({ from: start, to: bucketEnd(start, bucket) }, today);
}
