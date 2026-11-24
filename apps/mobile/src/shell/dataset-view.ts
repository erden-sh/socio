import type { FieldKind } from '@socio/shared/dataset-query/kinds';
import { OP_VALUE_SHAPE, operatorsFor, type FilterOp, type OpValueShape } from '@socio/shared/dataset-query/operators';
import type { FilterCondition, FilterNode, QueryGroup, QuerySort } from '@socio/shared/dataset-query/spec';
import type {
    Cell,
    FieldDisplay,
    ViewListResponse,
    ViewRow,
    ViewRowsPage,
    ViewRowsRequest,
} from '@socio/shared/dataset-views/contract';
import { rowsLimit } from '@socio/shared/dataset-views/contract';
import {
    CALENDAR_MODES,
    type CalendarMode,
    type ViewDefinition,
    type ViewLayout,
} from '@socio/shared/dataset-views/definition';
import { canEditField, fieldShowsAs, readViewDefinition, type ViewReading } from '@socio/shared/dataset-views/fallback';
import { cellDay, cellInstant, cellItems, formatCell, isChecked } from '@socio/shared/dataset-views/format';
import {
    boardColumns,
    calendarOpening,
    resolveCompact,
    resolveTitleField,
    visibleFields,
} from '@socio/shared/dataset-views/presentation';

import type { ToneName } from '../theme/theme';

// A dataset view on the phone (CB-469, CB-451), the view models every
// layout draws from, driven by @socio/shared/dataset-views: `readViewDefinition`
// (the fallbacks: an unknown layout opens as a list with its note, an unknown
// kind by its `fallback`, read-only), `formatCell`, `resolveCompact`,
// `boardColumns` and `calendarOpening`. Full parity: every visible field, every
// board column (hidden ones under "Hidden columns"), every calendar range is
// reachable; `priority` and `compact` only choose what shows first and in what
// order. What the person changes in a sheet (filters, sorts, grouping, fields,
// board columns, the calendar's fields) is a personal draft of the whole
// definition, parts this client can't read kept as they came; what they change
// in the layout (the column in focus, the calendar's range and day, a card
// expanded, a table read as a list) is view state on the device, never a draft.
// No React Native, so tests/shell runs it under Node with the shared fixtures.

export const UNTITLED_ROW = 'Untitled';
export const MORE_FIELDS = 'More fields';
export const HIDDEN_COLUMNS = 'Hidden columns';

/** How the phone formats a page's cells: the viewer's zone, the page's people and files. */
export interface CellFormat {
    readonly timeZone: string;
    readonly locale?: string;
}

/** A view as the phone opens it: its reading, the layout, notes, and the fields by name. */
export interface OpenedView {
    readonly reading: ViewReading;
    readonly layout: ViewLayout;
    /** The notes over the view: a newer layout, a filter from a newer version, parts skipped (editors only). */
    readonly notes: readonly string[];
    readonly fields: ReadonlyMap<string, FieldDisplay>;
    readonly titleField: string | null;
    /** What a small screen shows first, in order (the page's `compact`, else resolved here). */
    readonly compact: readonly string[];
    /** Every visible field, in view order. */
    readonly visible: readonly string[];
}

export function openView(
    list: Pick<ViewListResponse, 'fields' | 'rights'>,
    view: ViewDefinition,
    page: Pick<ViewRowsPage, 'compact'> | null,
    skipped: readonly { path: string; message: string }[] = [],
): OpenedView {
    const reading = readViewDefinition(view, 'phone');
    const fields = new Map(list.fields.map((f) => [f.field, f]));
    const notes = [
        reading.layoutNote,
        reading.queryNote,
        ...(list.rights.saveShared ? skipped.map((part) => part.message) : []),
    ].filter((note): note is string => typeof note === 'string');
    return {
        reading,
        layout: reading.layout,
        notes,
        fields,
        titleField: resolveTitleField(reading.view, list.fields),
        compact: page?.compact ?? resolveCompact(reading.view, list.fields),
        visible: visibleFields(reading.view, list.fields),
    };
}

/** One cell as text, by its field's kind (or fallback), in the viewer's locale and zone. */
export function cellText(
    value: unknown,
    field: FieldDisplay,
    page: Pick<ViewRowsPage, 'users' | 'files'>,
    format: CellFormat,
) {
    return formatCell(value, field, { ...format, users: page.users, files: page.files });
}

/** A field and its value on a card, a line or the record sheet. */
export interface FieldValue {
    readonly field: string;
    readonly label: string;
    readonly text: string;
    /** An option's palette color (select and multi-select), for its chip. */
    readonly colors?: readonly string[];
}

const optionColors = (value: unknown, field: FieldDisplay): string[] | undefined => {
    const options = field.settings.options;
    if (options === undefined || !fieldShowsAs(field).known) {
        return undefined;
    }
    return cellItems(value)
        .map((id) => options.find((o) => o.id === id)?.color)
        .filter((c): c is string => typeof c === 'string');
};

function fieldValues(
    row: ViewRow,
    names: readonly string[],
    opened: OpenedView,
    page: Pick<ViewRowsPage, 'users' | 'files'>,
    format: CellFormat,
): FieldValue[] {
    return names.flatMap((name) => {
        const field = opened.fields.get(name);
        if (field === undefined) {
            return [];
        }
        const shows = fieldShowsAs(field);
        if (!shows.known && shows.fallback === 'hidden') {
            return [];
        }
        const colors = optionColors(row.values[name], field);
        return [
            {
                field: name,
                label: field.label,
                text: cellText(row.values[name], field, page, format),
                ...(colors === undefined || colors.length === 0 ? {} : { colors }),
            },
        ];
    });
}

/** A row as a list line, a card or a calendar entry: its title, the priority fields, and the rest. */
export interface RowCard {
    readonly key: string;
    readonly title: string;
    /** The priority fields after the title: the collapsed line or card. */
    readonly lead: readonly FieldValue[];
    /** Every other visible field, in view order: what expanding shows. */
    readonly more: readonly FieldValue[];
    readonly accessibilityLabel: string;
}

export function rowCard(
    row: ViewRow,
    opened: OpenedView,
    page: Pick<ViewRowsPage, 'users' | 'files'>,
    format: CellFormat,
): RowCard {
    const titleField = opened.titleField === null ? undefined : opened.fields.get(opened.titleField);
    const title =
        (titleField === undefined ? '' : cellText(row.values[titleField.field], titleField, page, format)).trim() ||
        UNTITLED_ROW;
    const leadNames = opened.compact.filter((name) => name !== opened.titleField);
    const lead = fieldValues(row, leadNames, opened, page, format);
    const moreNames = opened.visible.filter((name) => name !== opened.titleField && !leadNames.includes(name));
    const more = fieldValues(row, moreNames, opened, page, format);
    const said = lead.filter((f) => f.text !== '').map((f) => `${f.label} ${f.text}`);
    return { key: row.key, title, lead, more, accessibilityLabel: [title, ...said].join(', ') };
}

// ----- The first read -----

/** The first page's read for a layout: a calendar's range, a table's and gallery's page size, a date-ordered list at today. */
export function firstRequest(
    view: ViewDefinition,
    layout: ViewLayout,
    range: { from: string; to: string } | null,
): ViewRowsRequest {
    if (layout === 'calendar') {
        return range === null ? { schema: 1 } : { schema: 1, range };
    }
    if (layout === 'table' || layout === 'gallery') {
        return { schema: 1, limit: rowsLimit(layout) };
    }
    if (layout === 'list') {
        const first = (view.query.sort as Array<{ field: string; dir?: string }> | undefined)?.[0];
        const dated = first !== undefined && (first.dir ?? 'asc') === 'asc' && /(_at|date|day)$/.test(first.field);
        return dated ? { schema: 1, around: 'today' } : { schema: 1 };
    }
    return { schema: 1 };
}

// ----- Table (priority fields lead, a sticky first column, every other column sideways) -----

export interface TableColumn {
    readonly field: string;
    readonly label: string;
    /** Points: the view's width, which a phone may ignore, clamped to what a phone shows. */
    readonly width: number;
    readonly numeric: boolean;
}

export interface TableView {
    /** The sticky first column (the title, else the first visible field). */
    readonly sticky: TableColumn | null;
    readonly columns: readonly TableColumn[];
    readonly rows: readonly { readonly key: string; readonly first: string; readonly cells: readonly string[] }[];
    /** The totals row, formatted, by the sticky column then each column; null without totals. */
    readonly totals: { readonly first: string; readonly cells: readonly string[] } | null;
}

const NUMERIC: readonly string[] = ['number', 'currency', 'percent'];
const TOTAL_LABELS: Readonly<Record<string, string>> = {
    count: 'Count',
    filled: 'Filled',
    empty: 'Empty',
    sum: 'Sum',
    avg: 'Average',
    min: 'Min',
    max: 'Max',
};

/** A column total as the table's last row says it: "Sum $1,149.50", "Filled 3". */
export function totalText(op: string, value: Cell | undefined, field: FieldDisplay, format: CellFormat): string {
    if (value === undefined || value === null) {
        return '';
    }
    const label = TOTAL_LABELS[op] ?? op;
    const counted = op === 'count' || op === 'filled' || op === 'empty';
    const text = counted ? String(value) : formatCell(value, field, { ...format });
    return `${label} ${text}`;
}

/** Order on a phone: the priority fields first, then every other visible field, in view order. */
export const phoneOrder = (opened: OpenedView): string[] => [
    ...opened.compact.filter((name) => opened.visible.includes(name)),
    ...opened.visible.filter((name) => !opened.compact.includes(name)),
];

export function tableView(page: ViewRowsPage, opened: OpenedView, format: CellFormat): TableView {
    const order = phoneOrder(opened);
    const stickyName =
        opened.titleField !== null && order.includes(opened.titleField) ? opened.titleField : (order[0] ?? null);
    const column = (name: string): TableColumn => {
        const field = opened.fields.get(name)!;
        const width = opened.reading.view.fields.find((f) => f.field === name)?.width;
        return {
            field: name,
            label: field.label,
            width: Math.min(220, Math.max(96, width ?? 140)),
            numeric: NUMERIC.includes(field.kind),
        };
    };
    const names = order.filter((name) => name !== stickyName && opened.fields.has(name));
    const sticky = stickyName === null || !opened.fields.has(stickyName) ? null : column(stickyName);
    const text = (row: ViewRow, name: string) => cellText(row.values[name], opened.fields.get(name)!, page, format);
    const totals = opened.reading.view.totals;
    const totalOf = (name: string) =>
        totals?.[name] === undefined
            ? ''
            : totalText(totals[name]!, page.totals?.[name], opened.fields.get(name)!, format);
    return {
        sticky,
        columns: names.map(column),
        rows: page.rows.map((row) => ({
            key: row.key,
            first: stickyName === null ? '' : text(row, stickyName) || UNTITLED_ROW,
            cells: names.map((name) => text(row, name)),
        })),
        totals:
            page.totals === undefined || totals === undefined
                ? null
                : { first: stickyName === null ? '' : totalOf(stickyName), cells: names.map(totalOf) },
    };
}

// ----- Board (one column in focus, swipes, the column chips) -----

/** What a board column with no cards says. */
export const emptyColumn = (label: string) => `Nothing in ${label}.`;

export interface BoardColumnView {
    /** The group key on the wire: an option or person id, `true`/`false`, or null for "No <field>". */
    readonly key: string | null;
    readonly label: string;
    readonly count: number;
    readonly hidden: boolean;
    /** The column's sum, when the view sums a field. */
    readonly total: string | null;
}

export interface BoardView {
    /** Every column in the view's order, hidden ones included. */
    readonly columns: readonly BoardColumnView[];
    /** The columns a swipe moves between: the visible ones, then a hidden one the person chose. */
    readonly swipeable: readonly BoardColumnView[];
    readonly focus: number;
    readonly cards: readonly RowCard[];
}

const columnKey = (value: string | boolean | null) => (value === null ? null : String(value));

/**
 * The board's columns from the page's groups in `options.columns` order (the server sends every
 * column's group on the first page), each with its count; the one in focus is the device's view
 * state, the first visible column by default. A hidden column is listed under "Hidden columns" and
 * may be focused like any other.
 */
export function boardView(
    page: ViewRowsPage,
    opened: OpenedView,
    format: CellFormat,
    focusKey: string | null | undefined,
    columnRows?: readonly ViewRow[],
): BoardView {
    const groupField = opened.fields.get(opened.reading.view.options.groupField ?? '');
    const order = groupField === undefined ? [] : boardColumns(opened.reading.view, groupField);
    const groups = new Map((page.groups ?? []).map((g) => [g.key, g]));
    const sumField = Object.entries(opened.reading.view.totals ?? {}).find(([, op]) => op === 'sum')?.[0];
    const columns: BoardColumnView[] = (
        order.length > 0
            ? order.map((c) => ({ key: columnKey(c.value), hidden: c.hidden }))
            : (page.groups ?? []).map((g) => ({ key: g.key, hidden: g.folded }))
    ).map(({ key, hidden }) => {
        const group = groups.get(key);
        const label =
            group?.label ??
            (key === null
                ? `No ${groupField?.label ?? 'value'}`
                : (groupField?.settings.options?.find((o) => o.id === key)?.label ?? key));
        const sum = sumField === undefined ? undefined : group?.totals?.[sumField];
        const field = sumField === undefined ? undefined : opened.fields.get(sumField);
        return {
            key,
            label,
            count: group?.count ?? 0,
            hidden,
            total:
                field === undefined || sum === undefined || sum === null ? null : totalText('sum', sum, field, format),
        };
    });
    const visible = columns.filter((c) => !c.hidden);
    // Until the person picks one, the board opens on its first visible column with cards, as a
    // column of none would read as an empty view (the fixture's Room B leads with 0).
    const focused =
        columns.find((c) => c.key === focusKey) ?? visible.find((c) => c.count > 0) ?? visible[0] ?? columns[0];
    const swipeable = focused !== undefined && focused.hidden ? [...visible, focused] : visible;
    const focus = Math.max(
        0,
        swipeable.findIndex((c) => c.key === focused?.key),
    );
    const rows = columnRows ?? page.rows.filter((row) => (row.group ?? null) === (focused?.key ?? null));
    return { columns, swipeable, focus, cards: rows.map((row) => rowCard(row, opened, page, format)) };
}

/** The column picker's two lists: the visible columns, then "Hidden columns". */
export const columnPicker = (board: BoardView) => ({
    shown: board.columns.filter((c) => !c.hidden),
    hidden: board.columns.filter((c) => c.hidden),
});

/** A "Move to" choice for a card: every column, the one it is in checked. */
export function moveTargets(board: BoardView, current: string | null) {
    return board.columns.map((c) => ({ key: c.key, label: c.label, checked: c.key === current }));
}

/** The value a card moved into column `key` writes to the group field. */
export function columnValue(key: string | null, field: FieldDisplay): Cell {
    if (key === null) {
        return field.kind === 'checkbox' ? false : null;
    }
    return field.kind === 'checkbox' ? key === 'true' : key;
}

// ----- Calendar (opens on the day, switches to week, month and agenda) -----

export const CALENDAR_LABELS: Readonly<Record<CalendarMode, string>> = {
    day: 'Day',
    week: 'Week',
    month: 'Month',
    agenda: 'Agenda',
};
export const PHONE_CALENDAR_MODES: readonly CalendarMode[] = CALENDAR_MODES;

/** The calendar's opening range on a phone (`calendarOpening`): the day, or the agenda. */
export const phoneCalendarOpening = (view: ViewDefinition) => calendarOpening(view, 'phone');

const ymd = (date: Date) => date.toISOString().slice(0, 10);
const utc = (day: string) => new Date(`${day}T00:00:00Z`);
/** `day` moved by `n` days. */
export const addDays = (day: string, n: number) => ymd(new Date(utc(day).getTime() + n * 86_400_000));
/** The Sunday that starts `day`'s week (en-US weeks). */
export const weekStart = (day: string) => addDays(day, -utc(day).getUTCDay());

/**
 * The range a calendar reads for a mode around `day` (the visible range only, at most 92
 * days): a day, its week, the month grid's six weeks, or the agenda's next 30 days.
 */
export function calendarRange(mode: CalendarMode, day: string): { from: string; to: string } {
    switch (mode) {
        case 'day':
            return { from: day, to: day };
        case 'week': {
            const from = weekStart(day);
            return { from, to: addDays(from, 6) };
        }
        case 'month': {
            const from = weekStart(`${day.slice(0, 7)}-01`);
            return { from, to: addDays(from, 41) };
        }
        case 'agenda':
            return { from: day, to: addDays(day, 29) };
    }
}

/** Where Previous and Next take a mode's anchor day. */
export function stepCalendar(mode: CalendarMode, day: string, by: 1 | -1): string {
    if (mode === 'month') {
        const date = utc(`${day.slice(0, 7)}-01`);
        date.setUTCMonth(date.getUTCMonth() + by);
        return ymd(date);
    }
    return addDays(day, by * (mode === 'day' ? 1 : mode === 'week' ? 7 : 30));
}

/** One entry on the calendar: its card, its days, and (timed) its minutes in the day. */
export interface CalendarEntry {
    readonly card: RowCard;
    readonly startDay: string;
    readonly endDay: string;
    /** Minutes from midnight in the viewer's zone; null for an all-day (date) entry. */
    readonly startMinute: number | null;
    readonly endMinute: number | null;
    /** Spans more than one day: drawn across the top of a day or week, not on the time grid. */
    readonly multiDay: boolean;
    readonly time: string | null;
}

function zoned(at: number, timeZone: string): { day: string; minute: number } {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(at);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
    return {
        day: `${part('year')}-${part('month')}-${part('day')}`,
        minute: Number(part('hour')) * 60 + Number(part('minute')),
    };
}

/** The page's rows as calendar entries, by the answer's `range.dateField` and `endField` (never guessed). */
export function calendarEntries(page: ViewRowsPage, opened: OpenedView, format: CellFormat): CalendarEntry[] {
    const dateName = page.range?.dateField ?? opened.reading.view.options.dateField;
    const endName = page.range?.endField ?? opened.reading.view.options.endField;
    const dateField = dateName === undefined ? undefined : opened.fields.get(dateName);
    if (dateField === undefined) {
        return [];
    }
    const timed = dateField.kind === 'datetime';
    const time = new Intl.DateTimeFormat(format.locale ?? 'en-US', {
        timeZone: format.timeZone,
        hour: 'numeric',
        minute: '2-digit',
    });
    return page.rows.flatMap((row): CalendarEntry[] => {
        const start = row.values[dateField.field];
        const end = endName === undefined ? undefined : row.values[endName];
        const card = rowCard(row, opened, page, format);
        if (!timed) {
            const startDay = cellDay(start);
            if (startDay === undefined) {
                return [];
            }
            const endDay = cellDay(end) ?? startDay;
            return [
                { card, startDay, endDay, startMinute: null, endMinute: null, multiDay: endDay > startDay, time: null },
            ];
        }
        const at = cellInstant(start);
        if (at === undefined) {
            return [];
        }
        const until = cellInstant(end);
        const s = zoned(at, format.timeZone);
        const e =
            until === undefined
                ? { day: s.day, minute: Math.min(24 * 60, s.minute + 60) }
                : zoned(until, format.timeZone);
        return [
            {
                card,
                startDay: s.day,
                endDay: e.day < s.day ? s.day : e.day,
                startMinute: s.minute,
                endMinute: e.day > s.day ? 24 * 60 : Math.max(e.minute, s.minute + 15),
                multiDay: e.day > s.day,
                time: time.format(at),
            },
        ];
    });
}

/** The entries on `day`. */
export const entriesOn = (entries: readonly CalendarEntry[], day: string) =>
    entries.filter((entry) => entry.startDay <= day && entry.endDay >= day);

/** The days of a range, in order. */
export function daysOf(range: { from: string; to: string }): string[] {
    const days: string[] = [];
    for (let day = range.from; day <= range.to; day = addDays(day, 1)) {
        days.push(day);
    }
    return days;
}

/** "Mon 23", "November 2026", "Nov 22 – 28": the calendar's heading for a mode. */
export function calendarTitle(mode: CalendarMode, day: string): string {
    const date = utc(day);
    const f = (options: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(date);
    if (mode === 'month') {
        return f({ month: 'long', year: 'numeric' });
    }
    if (mode === 'day') {
        return f({ weekday: 'long', month: 'short', day: 'numeric' });
    }
    const range = calendarRange(mode, day);
    const g = (d: string, options: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(utc(d));
    return `${g(range.from, { month: 'short', day: 'numeric' })} – ${g(range.to, { month: 'short', day: 'numeric' })}`;
}

/** Today in the viewer's zone. */
export const todayIn = (timeZone: string, now: number = Date.now()) => zoned(now, timeZone).day;

// ----- The record sheet (every field, hidden ones under "More fields") -----

/** How a field is edited on the phone, from its kind (the contract's `FieldDisplay`). */
export type FieldEditor =
    | { readonly kind: 'text'; readonly multiline: boolean; readonly keyboard: 'default' | 'url' | 'email' | 'phone' }
    | { readonly kind: 'number' }
    | { readonly kind: 'checkbox' }
    | { readonly kind: 'select'; readonly options: readonly { id: string; label: string; color: string }[] }
    | { readonly kind: 'multi'; readonly options: readonly { id: string; label: string; color: string }[] }
    | { readonly kind: 'person'; readonly many: boolean }
    | { readonly kind: 'date'; readonly time: boolean }
    | { readonly kind: 'file' }
    | { readonly kind: 'readonly' };

export function fieldEditor(
    field: FieldDisplay,
    rights: Pick<ViewListResponse['rights'], 'write' | 'writtenBy'>,
): FieldEditor {
    if (!canEditField(field, rights)) {
        return { kind: 'readonly' };
    }
    const kind = field.kind as FieldKind;
    switch (kind) {
        case 'text':
        case 'long_text':
            return { kind: 'text', multiline: kind === 'long_text', keyboard: 'default' };
        case 'url':
            return { kind: 'text', multiline: false, keyboard: 'url' };
        case 'email':
            return { kind: 'text', multiline: false, keyboard: 'email' };
        case 'phone':
            return { kind: 'text', multiline: false, keyboard: 'phone' };
        case 'number':
        case 'currency':
        case 'percent':
            return { kind: 'number' };
        case 'checkbox':
            return { kind: 'checkbox' };
        case 'select':
            return { kind: 'select', options: field.settings.options ?? [] };
        case 'multi_select':
            return { kind: 'multi', options: field.settings.options ?? [] };
        case 'person':
        case 'people':
            return { kind: 'person', many: kind === 'people' };
        case 'date':
        case 'datetime':
            return { kind: 'date', time: kind === 'datetime' };
        case 'file':
            return { kind: 'file' };
        default:
            return { kind: 'readonly' };
    }
}

/** One field on the record sheet. */
export interface RecordField extends FieldValue {
    readonly editor: FieldEditor;
    readonly raw: Cell;
}

export interface RecordView {
    readonly title: string;
    readonly fields: readonly RecordField[];
    /** The fields the view hides, still the record's: under "More fields". */
    readonly more: readonly RecordField[];
}

export function recordView(
    row: ViewRow,
    opened: OpenedView,
    rights: Pick<ViewListResponse['rights'], 'write' | 'writtenBy'>,
    page: Pick<ViewRowsPage, 'users' | 'files'>,
    format: CellFormat,
): RecordView {
    const card = rowCard(row, opened, page, format);
    const field = (name: string): RecordField[] => {
        const display = opened.fields.get(name);
        if (display === undefined || display.missing) {
            return [];
        }
        const shows = fieldShowsAs(display);
        if (!shows.known && shows.fallback === 'hidden') {
            return [];
        }
        const raw = (row.values[name] ?? null) as Cell;
        const colors = optionColors(raw, display);
        return [
            {
                field: name,
                label: display.label,
                text: cellText(raw, display, page, format),
                ...(colors === undefined || colors.length === 0 ? {} : { colors }),
                editor: fieldEditor(display, rights),
                raw,
            },
        ];
    };
    const shown = phoneOrder(opened);
    const rest = [...opened.fields.keys()].filter((name) => !shown.includes(name));
    return { title: card.title, fields: shown.flatMap(field), more: rest.flatMap(field) };
}

/** What a typed value becomes for a field, or why it can't (the edit's `to`). */
export function parseEdit(
    text: string,
    editor: FieldEditor,
): { ok: true; value: Cell } | { ok: false; message: string } {
    const trimmed = text.trim();
    switch (editor.kind) {
        case 'text':
            return { ok: true, value: text === '' ? null : text };
        case 'number': {
            if (trimmed === '') {
                return { ok: true, value: null };
            }
            const value = Number(trimmed.replace(/,/g, ''));
            return Number.isFinite(value) ? { ok: true, value } : { ok: false, message: 'Type a number.' };
        }
        case 'date': {
            if (trimmed === '') {
                return { ok: true, value: null };
            }
            if (!editor.time) {
                return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) && cellDay(trimmed) === trimmed
                    ? { ok: true, value: trimmed }
                    : { ok: false, message: 'Type a date as YYYY-MM-DD.' };
            }
            const at = cellInstant(trimmed);
            return at === undefined
                ? { ok: false, message: 'Type a date and time as YYYY-MM-DD HH:MM.' }
                : { ok: true, value: new Date(at).toISOString() };
        }
        default:
            return { ok: false, message: 'This field isn’t edited by typing.' };
    }
}

/** The text a field's prompt starts with: the raw value, as it would be typed. */
export function editText(raw: Cell, editor: FieldEditor): string {
    if (raw === null || raw === undefined) {
        return '';
    }
    if (editor.kind === 'date' && editor.time) {
        const at = cellInstant(raw);
        return at === undefined ? String(raw) : new Date(at).toISOString().slice(0, 16).replace('T', ' ');
    }
    return Array.isArray(raw) ? raw.join(', ') : String(raw);
}

/** A checkbox's value turned over, as the edit's `to`. */
export const toggled = (raw: Cell): Cell => !isChecked(raw);

/** A multi-select's value with option `id` turned on or off. */
export function toggledOption(raw: Cell, id: string): Cell {
    const items = cellItems(raw).map(String);
    return items.includes(id) ? items.filter((item) => item !== id) : [...items, id];
}

// ----- The sheets: filters, sorts, grouping, fields (drafts saved whole) -----

/** A filter as the sheet edits it: one level, all of or any of its conditions. */
export interface FilterDraft {
    readonly mode: 'all' | 'any';
    readonly conditions: readonly FilterCondition[];
}

/** The view's filter as the sheet shows it; a nested group shows as set and stays read-only. */
export function filterDraft(filter: FilterNode | undefined): FilterDraft & { readonly nested: boolean } {
    if (filter === undefined) {
        return { mode: 'all', conditions: [], nested: false };
    }
    if ('all' in filter || 'any' in filter) {
        const mode = 'all' in filter ? 'all' : 'any';
        const list = 'all' in filter ? filter.all : filter.any;
        const conditions = list.filter((n): n is FilterCondition => 'field' in n);
        return { mode, conditions, nested: conditions.length !== list.length };
    }
    return { mode: 'all', conditions: [filter], nested: false };
}

/** The sheet's filter as the definition's (none, one condition, or a group). */
export function filterNode(draft: FilterDraft): FilterNode | undefined {
    if (draft.conditions.length === 0) {
        return undefined;
    }
    if (draft.conditions.length === 1 && draft.mode === 'all') {
        return draft.conditions[0];
    }
    return draft.mode === 'all' ? { all: [...draft.conditions] } : { any: [...draft.conditions] };
}

/** The operators a field takes (every one the web has), with the value each wants. */
export function operatorChoices(field: FieldDisplay): readonly { op: FilterOp; label: string; shape: OpValueShape }[] {
    if (!fieldShowsAs(field).known) {
        return [];
    }
    return operatorsFor(field.kind as FieldKind).map((op) => ({ op, label: OP_LABELS[op], shape: OP_VALUE_SHAPE[op] }));
}

export const OP_LABELS: Readonly<Record<FilterOp, string>> = {
    is: 'is',
    is_not: 'is not',
    contains: 'contains',
    not_contains: 'doesn’t contain',
    starts_with: 'starts with',
    ends_with: 'ends with',
    eq: '=',
    neq: '≠',
    lt: '<',
    lte: '≤',
    gt: '>',
    gte: '≥',
    between: 'is between',
    before: 'is before',
    after: 'is after',
    on_or_before: 'is on or before',
    on_or_after: 'is on or after',
    within: 'is within',
    is_any_of: 'is any of',
    is_none_of: 'is none of',
    has_any_of: 'has any of',
    has_all_of: 'has all of',
    has_none_of: 'has none of',
    is_empty: 'is empty',
    is_not_empty: 'is not empty',
};

/** A condition said in words: "Room is not Room B". */
export function conditionText(condition: FilterCondition, fields: ReadonlyMap<string, FieldDisplay>): string {
    const field = fields.get(condition.field);
    const label = field?.label ?? condition.field;
    const op = OP_LABELS[condition.op] ?? condition.op;
    const value = condition.value;
    if (value === undefined) {
        return `${label} ${op}`;
    }
    const one = (v: unknown): string => {
        if (v !== null && typeof v === 'object') {
            const token = v as { $me?: true; relative?: string; count?: number; unit?: string; period?: string };
            if (token.$me) {
                return 'me';
            }
            if (token.relative !== undefined) {
                return `the ${token.relative} ${token.count} ${token.unit}${token.count === 1 ? '' : 's'}`;
            }
            if (token.period !== undefined) {
                return token.period.replace(/_/g, ' ');
            }
            return JSON.stringify(v);
        }
        const option = field?.settings.options?.find((o) => o.id === v);
        return option?.label ?? String(v);
    };
    return `${label} ${op} ${Array.isArray(value) ? value.map(one).join(', ') : one(value)}`;
}

/** The fields a filter, sort or grouping may name: known kinds the operators take. */
export const filterableFields = (fields: readonly FieldDisplay[]) =>
    fields.filter((f) => !f.missing && fieldShowsAs(f).known && operatorsFor(f.kind as FieldKind).length > 0);

/** The fields a grouping takes: select, person, checkbox, dates (by bucket) and numbers. */
export const groupableFields = (fields: readonly FieldDisplay[]) =>
    fields.filter(
        (f) =>
            !f.missing &&
            ['select', 'multi_select', 'person', 'people', 'checkbox', 'date', 'datetime', 'number', 'text'].includes(
                f.kind,
            ),
    );

/** A copy of the definition with its query's filter, sort or grouping replaced (the rest as it came). */
export function withQuery(
    view: ViewDefinition,
    change: { filter?: FilterNode | null; sort?: QuerySort[] | null; groupBy?: QueryGroup[] | null },
): ViewDefinition {
    const query = { ...view.query };
    for (const key of ['filter', 'sort', 'groupBy'] as const) {
        if (key in change) {
            const next = change[key];
            if (next === null || next === undefined || (Array.isArray(next) && next.length === 0)) {
                delete query[key];
            } else {
                (query as Record<string, unknown>)[key] = next;
            }
        }
    }
    return { ...view, query };
}

/** A copy with one field shown or hidden (a field the view doesn't list joins at the end). */
export function withFieldHidden(view: ViewDefinition, field: string, hidden: boolean): ViewDefinition {
    const listed = view.fields.some((f) => f.field === field);
    const fields = listed
        ? view.fields.map((f) => {
              if (f.field !== field) {
                  return f;
              }
              const { priority: _priority, ...rest } = f;
              return hidden ? { ...rest, hidden: true } : { ...f, hidden: false };
          })
        : [...view.fields, { field, ...(hidden ? { hidden: true } : {}) }];
    return { ...view, fields };
}

/** A copy with a field moved one place up or down in view order. */
export function withFieldMoved(view: ViewDefinition, field: string, by: -1 | 1): ViewDefinition {
    const index = view.fields.findIndex((f) => f.field === field);
    const to = index + by;
    if (index < 0 || to < 0 || to >= view.fields.length) {
        return view;
    }
    const fields = [...view.fields];
    [fields[index], fields[to]] = [fields[to]!, fields[index]!];
    return { ...view, fields };
}

/** A copy with "Show first on small screens" turned on (the next priority) or off, priorities kept unique. */
export function withPriority(view: ViewDefinition, field: string, on: boolean): ViewDefinition {
    const highest = Math.max(0, ...view.fields.map((f) => (typeof f.priority === 'number' ? f.priority : 0)));
    return {
        ...view,
        fields: view.fields.map((f) => {
            if (f.field !== field) {
                return f;
            }
            const { priority: _priority, ...rest } = f;
            return on ? { ...rest, hidden: false, priority: highest + 1 } : rest;
        }),
    };
}

/** A copy with an option set or cleared (unknown options kept as they came). */
export function withOption(view: ViewDefinition, key: string, value: unknown): ViewDefinition {
    const options = { ...view.options };
    if (value === undefined || value === null || value === '') {
        delete (options as Record<string, unknown>)[key];
    } else {
        (options as Record<string, unknown>)[key] = value;
    }
    return { ...view, options };
}

/** A copy with a board column shown or hidden (`options.columns`, every known column listed). */
export function withColumnHidden(
    view: ViewDefinition,
    board: BoardView,
    key: string | null,
    hidden: boolean,
): ViewDefinition {
    const columns = board.columns.map((c) => {
        const value = c.key === null ? null : c.key === 'true' ? true : c.key === 'false' ? false : c.key;
        const isIt = c.key === key;
        const hide = isIt ? hidden : c.hidden;
        return hide ? { value, hidden: true } : { value };
    });
    return withOption(view, 'columns', columns);
}

/** The layout icons the switcher draws, by layout (an unknown one as a list's). */
export const LAYOUT_ICONS: Readonly<Record<string, 'table' | 'list' | 'kanban' | 'calendar' | 'layout-grid'>> = {
    table: 'table',
    list: 'list',
    board: 'kanban',
    calendar: 'calendar',
    gallery: 'layout-grid',
};

export const layoutIcon = (layout: string) => LAYOUT_ICONS[layout] ?? 'list';

/** An option's palette color (a name, `FieldDisplayOption.color`) as one of the app's tones. */
const PALETTE_TONES: Readonly<Record<string, ToneName>> = {
    blue: 'sky',
    sky: 'sky',
    green: 'emerald',
    emerald: 'emerald',
    teal: 'mint',
    mint: 'mint',
    orange: 'orange',
    yellow: 'amber',
    amber: 'amber',
    red: 'rose',
    pink: 'rose',
    rose: 'rose',
    purple: 'violet',
    violet: 'violet',
    indigo: 'indigo',
    gray: 'slate',
    grey: 'slate',
    slate: 'slate',
};

export const paletteTone = (color: string | undefined): ToneName => PALETTE_TONES[color ?? ''] ?? 'slate';
