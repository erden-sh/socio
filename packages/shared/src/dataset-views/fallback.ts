/**
 * How a client meets what it doesn't know (CB-451): it falls
 * back, never fails.
 *
 * - An unknown `layout` opens as `table` on the web and `list` on a phone,
 *   with the note `NEWER_LAYOUT_NOTE`.
 * - An unknown field `kind` shows its value through the field's
 *   `fallback` (`text`, `number`, `json` or `hidden`) and is read-only.
 * - An unknown filter operator, sort or grouping option makes that part
 *   read-only in this client (`NEWER_QUERY_NOTE`) while the server still
 *   applies it; a draft is saved whole, so the client never drops it.
 * - An unknown key anywhere in a definition, `options` included, is kept
 *   and sent back unchanged.
 */
import { FIELD_KINDS, type FieldKind } from '../dataset-query/kinds.js';
import { filterNode, queryGroup, querySegment, querySort } from '../dataset-query/spec.js';

import { FIELD_FALLBACKS, type FieldDisplay, type FieldFallback, type ViewRights } from './contract.js';
import {
    isCalendarMode,
    isViewLayout,
    VIEW_TOTAL_OPS,
    viewDefinitionWire,
    type ViewDefinition,
    type ViewLayout,
} from './definition.js';

/** Which client reads: the web app, or Socio Mobile. They differ only in the fallback layout. */
export type ViewClient = 'web' | 'phone';

export const NEWER_LAYOUT_NOTE = 'This view type needs a newer app';
export const NEWER_QUERY_NOTE = 'Filter set in a newer version';

/** The layout a client opens a view in: its own when known, else `table` on the web and `list` on a phone. */
export function fallbackLayout(layout: string, client: ViewClient): { layout: ViewLayout; note?: string } {
    if (isViewLayout(layout)) {
        return { layout };
    }
    return { layout: client === 'web' ? 'table' : 'list', note: NEWER_LAYOUT_NOTE };
}

export const isFieldKind = (kind: unknown): kind is FieldKind =>
    typeof kind === 'string' && (FIELD_KINDS as readonly string[]).includes(kind);

/**
 * How a client shows a field: by its kind when it knows it, else by its
 * fallback. A fallback this client doesn't know either reads as `text`.
 */
export function fieldShowsAs(
    field: Pick<FieldDisplay, 'kind' | 'fallback'>,
): { known: true; kind: FieldKind } | { known: false; fallback: FieldFallback } {
    if (isFieldKind(field.kind)) {
        return { known: true, kind: field.kind };
    }
    const fallback = (FIELD_FALLBACKS as readonly string[]).includes(field.fallback)
        ? (field.fallback as FieldFallback)
        : 'text';
    return { known: false, fallback };
}

/**
 * Whether the person may edit this field in place, in this client: the
 * server says it is editable and they may write the table, and the
 * client knows its kind (an unknown kind is read-only), and its column
 * still exists.
 */
export function canEditField(field: FieldDisplay, rights: Pick<ViewRights, 'write' | 'writtenBy'>): boolean {
    return field.editable && rights.write && !rights.writtenBy && isFieldKind(field.kind) && !field.missing;
}

/** What a client can do with a definition it read. */
export interface ViewReading {
    /**
     * The definition as it came, every unknown part kept. Edit a copy of
     * it and send that back as the draft: the server checks it whole.
     */
    view: ViewDefinition;
    /** The layout to open it in. */
    layout: ViewLayout;
    /** Set when the view's own layout is unknown here. */
    layoutNote?: string;
    /**
     * Parts this client can't read, read-only here while the server still
     * applies them: the client shows them as set and never edits them.
     */
    readOnly: { filter: boolean; sort: boolean; groupBy: boolean; calendarMode: boolean; totals: boolean };
    /** `NEWER_QUERY_NOTE` when the filter, sort or grouping is read-only. */
    queryNote?: string;
    /** Option keys this client doesn't know, kept as they came. */
    unknownOptions: string[];
}

const KNOWN_OPTIONS = ['titleField', 'groupField', 'columns', 'cardCover', 'dateField', 'endField', 'calendarMode'];

/**
 * Reads a definition from an answer (`view`, or a draft's `definition`)
 * the forgiving way. Throws only when it isn't a view definition at all
 * (no id, no fields); everything a later release may add parses, and
 * `ViewReading` says what this client can show and edit of it.
 */
export function readViewDefinition(raw: unknown, client: ViewClient): ViewReading {
    const view = viewDefinitionWire.parse(raw) as ViewDefinition;
    const opened = fallbackLayout(view.layout, client);
    const q = view.query;
    const readOnly = {
        filter: q.filter !== undefined && !filterNode.safeParse(q.filter).success,
        sort: q.sort !== undefined && !q.sort.every((s) => querySort.safeParse(s).success),
        // A grouping by segment needs the segments; either part unknown makes both read-only.
        groupBy:
            (q.groupBy !== undefined && !q.groupBy.every((g) => queryGroup.safeParse(g).success)) ||
            (q.segments !== undefined &&
                !(Array.isArray(q.segments) ? q.segments : [q.segments]).every(
                    (s) => querySegment.safeParse(s).success,
                )),
        calendarMode: view.options.calendarMode !== undefined && !isCalendarMode(view.options.calendarMode),
        totals:
            view.totals !== undefined &&
            !Object.values(view.totals).every((op) => (VIEW_TOTAL_OPS as readonly string[]).includes(op)),
    };
    return {
        view,
        layout: opened.layout,
        ...(opened.note ? { layoutNote: opened.note } : {}),
        readOnly,
        ...(readOnly.filter || readOnly.sort || readOnly.groupBy ? { queryNote: NEWER_QUERY_NOTE } : {}),
        unknownOptions: Object.keys(view.options).filter((key) => !KNOWN_OPTIONS.includes(key)),
    };
}
