/**
 * A view's filter and sort on rows a client already holds (CB-451): after
 * a `changes` read, a cache re-applies the view to the rows that changed, so a row that no longer matches leaves the cached
 * page and one that newly matches is placed in order.
 *
 * These are the semantics the compiler (build step 5) compiles every
 * operator to; the two must agree, and the fixtures hold both to them:
 *
 * - **Empty** is null or `''`; for a list kind (`multi_select`, `people`,
 *   `file`) it is no items, whether stored as an array or as JSON text
 *   (`'[]'`, `'[ ]'`). Text `'[]'` in a text field is not empty. Positive operators never match an empty value;
 *   negative ones (`is_not`, `not_contains`, `neq`, `is_none_of`,
 *   `has_none_of`) do, so "Status is not Done" keeps rows with no status.
 *   `is ""` on text matches empty values, and `is_not ""` the others.
 * - **Text** matches case-insensitively in ASCII and literally, as
 *   SQLite's `lower()` and `instr()` do, and sorts the same way (NOCASE,
 *   then code points).
 * - **Numbers**: `between` includes both ends. A number stored as text
 *   counts when it is a JSON number with optional spaces around it
 *   (`cellNumber`); other text is empty to filters and sorts.
 * - **Checkboxes**: a null is unchecked.
 * - **Dates** compare as calendar days; `today` and relative dates
 *   resolve in the view's zone (`./../dataset-query/dates.ts`, the same
 *   functions the compiler uses). A `datetime` compares as an instant: a
 *   day bound covers that day in the view's zone, and a date and time
 *   without an offset is in the view's zone too. A stored value without
 *   an offset is UTC (`cellInstant`).
 * - **Selects and people** compare by id; `$me` is the viewer.
 * - **Sort**: empties last unless `empty: "first"`, in either direction;
 *   selects by option order (unknown options after them), a person by
 *   name; ties by the row key, ascending. With no sort, by key.
 *
 * What this client can't evaluate (an unknown operator, kind or field,
 * a condition or group with a key or value shape it doesn't know, such
 * as a later release's period or option, a dashboard `$param`, a viewer it doesn't know for `$me`) makes
 * `matchesFilter` answer `undefined`: the client can't tell, so it marks
 * the span short and reads it again online.
 */
import { addDays, periodRange, relativeRange, todayIn, wallInstant, zoneStart } from '../dataset-query/dates.js';
import { SORTABLE_KINDS, type FieldKind } from '../dataset-query/kinds.js';
import { FILTER_OPS, operatorsFor, type FilterOp } from '../dataset-query/operators.js';
import {
    filterCondition,
    querySort,
    type FilterNode,
    type FilterValue,
    type QuerySort,
} from '../dataset-query/spec.js';

import type { Cell, FieldDisplay, ViewRow, ViewUser } from './contract.js';
import { isFieldKind } from './fallback.js';
import { cellDay, cellInstant, cellItems, cellNumber, isChecked } from './format.js';
import { parseRowKey, type KeyValue } from './schema.js';

export interface EvaluateContext {
    /** The table's fields (`ViewListResponse.fields`, or a page's). */
    fields: readonly FieldDisplay[];
    /** The view's zone: the viewer's. */
    timeZone: string;
    /** The viewer's user id, for `$me`. */
    me?: string;
    /** Now, for `today` and relative dates; the clock by default. */
    now?: number | Date;
    /** People by id, for sorting a person field by name. */
    users?: Record<string, ViewUser>;
}

type Values = Record<string, Cell | unknown>;

const NEGATIVE: readonly FilterOp[] = ['is_not', 'not_contains', 'neq', 'is_none_of', 'has_none_of'];
const TEXTLIKE: readonly FieldKind[] = ['text', 'long_text', 'url', 'email', 'phone'];
const NUMBERLIKE: readonly FieldKind[] = ['number', 'currency', 'percent'];

/** ASCII lower case, as SQLite's `lower()` without ICU. */
const fold = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Kinds that hold a list: an array, or JSON text of one (`'[ ]'` included). */
const LIST_KINDS: readonly FieldKind[] = ['multi_select', 'people', 'file'];

/** Empty as a kind reads it: a list kind by its items, any other kind null or `''`. */
const isEmpty = (value: unknown, kind?: FieldKind) =>
    kind !== undefined && LIST_KINDS.includes(kind)
        ? cellItems(value).length === 0
        : value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);

function isToken(value: unknown, key: string) {
    return !!value && typeof value === 'object' && !Array.isArray(value) && key in value;
}
const hasParam = (value: FilterValue | undefined): boolean =>
    Array.isArray(value) ? value.some((v) => isToken(v, '$param')) : isToken(value, '$param');

/**
 * Whether a row's values match a view's filter: true, false, or
 * undefined when this client can't tell (see the module comment). No
 * filter matches every row.
 */
export function matchesFilter(
    values: Values,
    filter: FilterNode | undefined,
    ctx: EvaluateContext,
): boolean | undefined {
    if (filter === undefined) {
        return true;
    }
    const today = todayIn(ctx.timeZone, ctx.now ?? Date.now());
    const byName = new Map(ctx.fields.map((f) => [f.field, f]));
    const node = (n: FilterNode): boolean | undefined => {
        // A group or condition with a key, operator or value this client
        // doesn't know (a later release's) can't be evaluated here.
        const keys = n && typeof n === 'object' ? Object.keys(n) : [];
        if (keys.length === 1 && keys[0] === 'all' && Array.isArray((n as { all: unknown }).all)) {
            const all = (n as { all: FilterNode[] }).all;
            const results = all.map(node);
            return results.includes(false) ? false : results.includes(undefined) ? undefined : true;
        }
        if (keys.length === 1 && keys[0] === 'any' && Array.isArray((n as { any: unknown }).any)) {
            const any = (n as { any: FilterNode[] }).any;
            const results = any.map(node);
            return results.includes(true) ? true : results.includes(undefined) ? undefined : false;
        }
        const parsed = filterCondition.safeParse(n);
        if (!parsed.success) {
            return undefined;
        }
        return condition(parsed.data.field, parsed.data.op, parsed.data.value, values, byName, ctx, today);
    };
    return node(filter);
}

function condition(
    name: string,
    op: FilterOp,
    filterValue: FilterValue | undefined,
    values: Values,
    byName: Map<string, FieldDisplay>,
    ctx: EvaluateContext,
    today: string,
): boolean | undefined {
    const field = byName.get(name);
    if (
        !field ||
        !isFieldKind(field.kind) ||
        !(FILTER_OPS as readonly string[]).includes(op) ||
        hasParam(filterValue)
    ) {
        return undefined;
    }
    const raw = values[name];
    let kind: FieldKind = field.kind;
    if (kind === 'id') {
        const sample = Array.isArray(filterValue) ? filterValue[0] : filterValue;
        kind = typeof raw === 'number' || typeof sample === 'number' ? 'number' : 'text';
    }
    if (!operatorsFor(kind).includes(op)) {
        return undefined;
    }
    const empty = isEmpty(raw, kind);
    if (op === 'is_empty') {
        return empty;
    }
    if (op === 'is_not_empty') {
        return !empty;
    }
    const me = (v: unknown) => (isToken(v, '$me') ? ctx.me : v);
    const list = (Array.isArray(filterValue) ? filterValue : [filterValue]).map(me);
    if (list.some((v) => v === undefined)) {
        return undefined;
    }
    if (TEXTLIKE.includes(kind)) {
        const want = typeof filterValue === 'string' ? fold(filterValue) : undefined;
        if (want === undefined) {
            return undefined;
        }
        if (want === '' && (op === 'is' || op === 'is_not')) {
            return op === 'is' ? empty : !empty;
        }
        if (empty) {
            return NEGATIVE.includes(op);
        }
        const have = fold(typeof raw === 'string' ? raw : String(raw));
        switch (op) {
            case 'is':
                return have === want;
            case 'is_not':
                return have !== want;
            case 'contains':
                return have.includes(want);
            case 'not_contains':
                return !have.includes(want);
            case 'starts_with':
                return have.startsWith(want);
            case 'ends_with':
                return have.endsWith(want);
            default:
                return undefined;
        }
    }
    if (NUMBERLIKE.includes(kind)) {
        const nums = list.map((v) => (typeof v === 'number' ? v : NaN));
        if (nums.some(Number.isNaN)) {
            return undefined;
        }
        const have = cellNumber(raw);
        if (empty || have === undefined) {
            return NEGATIVE.includes(op);
        }
        const [x, y] = nums;
        switch (op) {
            case 'eq':
                return have === x;
            case 'neq':
                return have !== x;
            case 'lt':
                return have < x;
            case 'lte':
                return have <= x;
            case 'gt':
                return have > x;
            case 'gte':
                return have >= x;
            case 'between':
                return nums.length === 2 && have >= x && have <= y;
            default:
                return undefined;
        }
    }
    switch (kind) {
        case 'checkbox':
            return typeof filterValue === 'boolean' ? isChecked(raw) === filterValue : undefined;
        case 'date':
            return dateCondition(op, filterValue, raw, today);
        case 'datetime':
            return datetimeCondition(op, filterValue, raw, today, ctx);
        case 'select':
        case 'person': {
            const have = empty ? undefined : String(raw);
            const wanted = list.map(String);
            switch (op) {
                case 'is':
                    return have !== undefined && have === wanted[0];
                case 'is_not':
                    return have === undefined || have !== wanted[0];
                case 'is_any_of':
                    return have !== undefined && wanted.includes(have);
                case 'is_none_of':
                    return have === undefined || !wanted.includes(have);
                default:
                    return undefined;
            }
        }
        case 'multi_select':
        case 'people': {
            const have = new Set(cellItems(raw).map(String));
            const wanted = list.map(String);
            switch (op) {
                case 'has_any_of':
                    return wanted.some((w) => have.has(w));
                case 'has_all_of':
                    return have.size > 0 && wanted.every((w) => have.has(w));
                case 'has_none_of':
                    return !wanted.some((w) => have.has(w));
                default:
                    return undefined;
            }
        }
        default:
            return undefined;
    }
}

/** A filter's date value as a day: `today`, or `YYYY-MM-DD`. */
const dayOf = (value: unknown, today: string) =>
    value === 'today' ? today : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;

function withinRange(value: unknown, today: string) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    if ('relative' in value && 'count' in value && 'unit' in value) {
        const v = value as { relative: 'past' | 'next'; count: number; unit: Parameters<typeof relativeRange>[2] };
        return relativeRange(v.relative, v.count, v.unit, today);
    }
    if ('period' in value) {
        return periodRange((value as { period: Parameters<typeof periodRange>[0] }).period, today);
    }
    return undefined;
}

function dateCondition(op: FilterOp, value: FilterValue | undefined, raw: unknown, today: string) {
    const have = cellDay(raw);
    if (op === 'within') {
        const range = withinRange(value, today);
        return range ? have !== undefined && have >= range.from && have <= range.to : undefined;
    }
    if (op === 'between') {
        const [from, to] = Array.isArray(value) ? value.map((v) => dayOf(v, today)) : [];
        return from && to ? have !== undefined && have >= from && have <= to : undefined;
    }
    const day = dayOf(value, today);
    if (!day) {
        return undefined;
    }
    if (have === undefined) {
        return false;
    }
    switch (op) {
        case 'is':
            return have === day;
        case 'before':
            return have < day;
        case 'after':
            return have > day;
        case 'on_or_before':
            return have <= day;
        case 'on_or_after':
            return have >= day;
        default:
            return undefined;
    }
}

function datetimeCondition(
    op: FilterOp,
    value: FilterValue | undefined,
    raw: unknown,
    today: string,
    ctx: EvaluateContext,
) {
    const zone = ctx.timeZone;
    const at = cellInstant(raw);
    // A bound as [first instant, first instant after]: a day covers the day in the zone.
    const bound = (v: unknown): [number, number] | undefined => {
        const day = dayOf(v, today);
        if (day) {
            return [zoneStart(day, zone), zoneStart(addDays(day, 1), zone)];
        }
        const instant = typeof v === 'string' ? wallInstant(v, zone) : undefined;
        return instant === undefined ? undefined : [instant, instant + 1];
    };
    if (op === 'within') {
        const range = withinRange(value, today);
        if (!range) {
            return undefined;
        }
        return at !== undefined && at >= zoneStart(range.from, zone) && at < zoneStart(addDays(range.to, 1), zone);
    }
    if (op === 'between') {
        const [from, to] = Array.isArray(value) ? value.map(bound) : [];
        return from && to ? at !== undefined && at >= from[0] && at < to[1] : undefined;
    }
    const b = bound(value);
    if (!b) {
        return undefined;
    }
    if (at === undefined) {
        return false;
    }
    const [start, end] = b;
    switch (op) {
        case 'is':
            return at >= start && at < end;
        case 'before':
            return at < start;
        case 'after':
            return at >= end;
        case 'on_or_before':
            return at < end;
        case 'on_or_after':
            return at >= start;
        default:
            return undefined;
    }
}

// Sorting ------------------------------------------------------------------------

/** Whether this client can order rows by `sort`: every entry well formed, on a known, sortable field. */
export function sortIsEvaluable(sort: readonly unknown[] | undefined, fields: readonly FieldDisplay[]): boolean {
    const byName = new Map(fields.map((f) => [f.field, f]));
    return (sort ?? []).every((s) => {
        const parsed = querySort.safeParse(s);
        if (!parsed.success) {
            return false;
        }
        const field = byName.get(parsed.data.field);
        return !!field && isFieldKind(field.kind) && SORTABLE_KINDS.includes(field.kind);
    });
}

/** Strings by code point, as SQLite compares UTF-8 text. */
function codePoints(a: string, b: string) {
    if (a === b) {
        return 0;
    }
    const x = [...a];
    const y = [...b];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const d = (x[i].codePointAt(0) as number) - (y[i].codePointAt(0) as number);
        if (d) {
            return d < 0 ? -1 : 1;
        }
    }
    return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}
/** Text as NOCASE orders it: ASCII case folded, then code points. */
const compareText = (a: string, b: string) => codePoints(fold(a), fold(b)) || codePoints(a, b);

/** A sort key: a number or a text, or undefined for empty. */
function sortKey(value: unknown, field: FieldDisplay, ctx: EvaluateContext): number | string | undefined {
    const kind = field.kind as FieldKind;
    if (kind === 'checkbox') {
        return isChecked(value) ? 1 : 0;
    }
    if (isEmpty(value)) {
        return undefined;
    }
    switch (kind) {
        case 'number':
        case 'currency':
        case 'percent':
            return cellNumber(value);
        case 'date':
            return cellDay(value);
        case 'datetime':
            return cellInstant(value);
        case 'select': {
            const options = field.settings.options ?? [];
            const index = options.findIndex((o) => o.id === value);
            // Unknown options after the known ones (by id, in compareRows).
            return index >= 0 ? index : options.length;
        }
        case 'person':
            return ctx.users?.[String(value)]?.name ?? String(value);
        default:
            return typeof value === 'number' ? value : String(value);
    }
}

function compareKeys(a: number | string, b: number | string) {
    if (typeof a === 'number' && typeof b === 'number') {
        return a < b ? -1 : a > b ? 1 : 0;
    }
    if (typeof a === 'number') {
        return -1;
    }
    if (typeof b === 'number') {
        return 1;
    }
    return compareText(a, b);
}

/**
 * Two key values as SQLite orders them: null first, then numbers (a
 * boolean is the integer SQLite stores, 0 or 1), then text by code
 * point, as a key's default BINARY collation does.
 */
function compareKeyValues(p: KeyValue, q: KeyValue): number {
    const rank = (v: KeyValue) => (v === null ? 0 : typeof v === 'string' ? 2 : 1);
    const d = rank(p) - rank(q);
    if (d || p === null || q === null) {
        return Math.sign(d);
    }
    const num = (v: number | boolean) => (typeof v === 'boolean' ? Number(v) : v);
    return typeof p === 'string' ? codePoints(p, q as string) : compareKeys(num(p), num(q as number | boolean));
}

/** Row keys in key order: values element by element (null, then numbers, then text), rowids by number. */
export function compareRowKeys(a: string, b: string): number {
    const x = parseRowKey(a);
    const y = parseRowKey(b);
    if (x && y && 'rowid' in x && 'rowid' in y) {
        return Math.sign(x.rowid - y.rowid);
    }
    if (x && y && 'values' in x && 'values' in y) {
        for (let i = 0; i < Math.min(x.values.length, y.values.length); i++) {
            const p = x.values[i];
            const q = y.values[i];
            const d = compareKeyValues(p, q);
            if (d) {
                return d;
            }
        }
        return Math.sign(x.values.length - y.values.length);
    }
    return codePoints(a, b);
}

/**
 * Two rows in a view's order: by each sort entry, then by key.
 * Check `sortIsEvaluable` first; an entry this client can't evaluate
 * counts as a tie.
 */
export function compareRows(
    a: Pick<ViewRow, 'key' | 'values'>,
    b: Pick<ViewRow, 'key' | 'values'>,
    sort: readonly QuerySort[] | undefined,
    ctx: EvaluateContext,
): number {
    const byName = new Map(ctx.fields.map((f) => [f.field, f]));
    for (const s of sort ?? []) {
        const field = byName.get(s.field);
        if (!field || !isFieldKind(field.kind) || !SORTABLE_KINDS.includes(field.kind)) {
            continue;
        }
        const x = sortKey(a.values[s.field], field, ctx);
        const y = sortKey(b.values[s.field], field, ctx);
        if (x === undefined || y === undefined) {
            if (x === y) {
                continue;
            }
            const emptyFirst = s.empty === 'first';
            return (x === undefined) === emptyFirst ? -1 : 1;
        }
        let d = compareKeys(x, y);
        if (!d && field.kind === 'select') {
            // Two unknown options: by id.
            d = compareText(String(a.values[s.field]), String(b.values[s.field]));
        }
        if (d) {
            return s.dir === 'desc' ? -d : d;
        }
    }
    return compareRowKeys(a.key, b.key);
}
