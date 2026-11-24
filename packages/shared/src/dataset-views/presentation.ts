/**
 * What a view shows first and in what order (CB-451):
 * the title field, the priority (`compact`) fields, a board's columns
 * and a calendar's opening range.
 *
 * These choose a default presentation and an order, never what is
 * reachable. Mobile keeps full parity: every visible field is one tap
 * away on every screen, every board column (hidden ones under "Hidden
 * columns") and every calendar range is there on a phone, and nothing
 * here removes a field, a column, a range or an action.
 */
import type { FieldDisplay } from './contract.js';
import { isCalendarMode, type BoardColumn, type CalendarMode, type ViewDefinition } from './definition.js';
import type { ViewClient } from './fallback.js';

type ViewParts = Pick<ViewDefinition, 'fields' | 'options'>;

/** How many fields lead a small screen when no field has a priority: the title and the next three. */
export const DEFAULT_COMPACT_FIELDS = 4;

/**
 * The view's visible fields, in view order: listed, not hidden, and
 * still in the table (`fields`, every field the client was sent). A
 * field the view doesn't list is hidden.
 */
export function visibleFields(view: ViewParts, fields: readonly FieldDisplay[]): string[] {
    const present = new Set(fields.filter((f) => !f.missing).map((f) => f.field));
    return view.fields.filter((f) => !f.hidden && present.has(f.field)).map((f) => f.field);
}

/**
 * The field a list line, card or calendar entry is titled by:
 * `options.titleField` when it is still in the table, else the first
 * visible text field, else the key. Null for a table with neither.
 */
export function resolveTitleField(view: ViewParts, fields: readonly FieldDisplay[]): string | null {
    const byName = new Map(fields.filter((f) => !f.missing).map((f) => [f.field, f]));
    const chosen = view.options.titleField;
    if (chosen && byName.has(chosen)) {
        return chosen;
    }
    const text = visibleFields(view, fields).find((name) => byName.get(name)?.kind === 'text');
    if (text) {
        return text;
    }
    return fields.find((f) => f.isKey && !f.missing)?.field ?? null;
}

/**
 * The fields a small screen shows first, in order (`compact`): the
 * visible fields with a priority, in priority order; without any, the
 * title field and the next three visible fields. The server sends this
 * resolved with every page; a client computes it the same way for a
 * draft it is editing.
 */
export function resolveCompact(view: ViewParts, fields: readonly FieldDisplay[]): string[] {
    const visible = visibleFields(view, fields);
    const shown = new Set(visible);
    const prioritized = view.fields
        .filter((f) => typeof f.priority === 'number' && shown.has(f.field))
        .sort((a, b) => (a.priority as number) - (b.priority as number))
        .map((f) => f.field);
    if (prioritized.length) {
        return [...new Set(prioritized)];
    }
    const title = resolveTitleField(view, fields);
    const lead = title ? [title] : [];
    return [...lead, ...visible.filter((name) => name !== title)].slice(0, DEFAULT_COMPACT_FIELDS);
}

/** One column of a board, in the order to show it, with `hidden` as the view sets it. */
export interface BoardColumnState {
    /** An option id, a person id, `true` or `false`; `null` is "No <field>". */
    value: string | boolean | null;
    hidden: boolean;
}

/**
 * A board's columns in order: the ones `options.columns` lists, in
 * its order, then the rest in option order, then "No <field>" (`null`)
 * last unless listed. Hidden columns stay in the list with `hidden: true`,
 * so a phone's column picker shows them under "Hidden columns".
 *
 * `values` are the columns the group field has: for a select its option
 * ids (the default), for a checkbox `true` and `false` (the default), for
 * a person field the person ids the page's groups name. A listed value
 * the field no longer has is left out.
 */
export function boardColumns(
    view: ViewParts,
    groupField: FieldDisplay,
    values?: ReadonlyArray<string | boolean>,
): BoardColumnState[] {
    const available: Array<string | boolean> =
        values !== undefined
            ? [...values]
            : groupField.kind === 'checkbox'
              ? [true, false]
              : (groupField.settings.options ?? []).map((o) => o.id);
    const id = (v: string | boolean | null) => JSON.stringify(v);
    const has = new Set(available.map(id));
    const out: BoardColumnState[] = [];
    const placed = new Set<string>();
    for (const column of (view.options.columns ?? []) as BoardColumn[]) {
        const key = id(column.value);
        if (placed.has(key) || (column.value !== null && !has.has(key))) {
            continue;
        }
        placed.add(key);
        out.push({ value: column.value, hidden: !!column.hidden });
    }
    for (const value of available) {
        if (!placed.has(id(value))) {
            placed.add(id(value));
            out.push({ value, hidden: false });
        }
    }
    if (!placed.has('null')) {
        out.push({ value: null, hidden: false });
    }
    return out;
}

/**
 * The range a calendar opens on. The web opens on
 * `options.calendarMode` (a month when unset or unknown here); a phone
 * opens on the day, or the agenda when the view's mode is `agenda`.
 * Every range stays one switch away on both.
 */
export function calendarOpening(view: ViewParts, client: ViewClient): CalendarMode {
    const mode = isCalendarMode(view.options.calendarMode) ? view.options.calendarMode : undefined;
    if (client === 'phone') {
        return mode === 'agenda' ? 'agenda' : 'day';
    }
    return mode ?? 'month';
}
