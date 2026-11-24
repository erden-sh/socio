/**
 * The shape of a view fixture (CB-451): the answers a server
 * gives for one view, and what a client must make of them. The web
 * client and Socio Mobile run every fixture in `./index.ts` as a
 * contract test (`tests/dataset-views-fixtures.test.ts` is the reference
 * run):
 *
 * 1. Every answer parses (`viewListResponse`, `viewDefinitionResponse`,
 *    `viewRowsPage`, and the sync answers), and a definition read with
 *    `readViewDefinition` and serialized again is the one that came.
 * 2. `expect.web` and `expect.phone` are the layouts it opens in.
 * 3. `matchesFilter` and `compareRows` over `BOOKINGS_ROWS` give
 *    `expect.matches` and `expect.order`, and the page's rows are the
 *    matching ones in that order (per group, for a board).
 * 4. `formatCell` gives `expect.formatted` for every row and field the
 *    page sends, compared with `sameText`.
 */
import type {
    FieldDisplay,
    RowChanges,
    RowLookup,
    ViewDefinitionResponse,
    ViewIndexPage,
    ViewListResponse,
    ViewRowsPage,
    ViewRowsRequest,
} from '../contract.js';
import type { CalendarMode, ViewLayout } from '../definition.js';
import type { BoardColumnState } from '../presentation.js';
import type { ReconcilePlan } from '../sync.js';

export interface ViewFixture {
    name: string;
    /** What it holds a client to. */
    about: string;
    /** Every field the evaluator and formatter read: the list's `fields`. */
    fields: FieldDisplay[];
    list: ViewListResponse;
    definition: ViewDefinitionResponse;
    request: ViewRowsRequest;
    page: ViewRowsPage;
    expect: {
        web: { layout: ViewLayout; note?: string };
        phone: { layout: ViewLayout; note?: string };
        readOnly: { filter: boolean; sort: boolean; groupBy: boolean; calendarMode: boolean; totals: boolean };
        unknownOptions: string[];
        titleField: string | null;
        /** `resolveCompact`, which the page's `compact` equals. */
        compact: string[];
        visible: string[];
        /** Fields `canEditField` allows, in column order. */
        editable: string[];
        /** `matchesFilter` per row key of `BOOKINGS_ROWS`; null where the client can't tell. */
        matches: Record<string, boolean | null>;
        /** Whether this client can order rows by the view's sort. */
        sortEvaluable: boolean;
        /** Every row key of `BOOKINGS_ROWS` in view order. */
        order: string[];
        /** `formatCell` per page row key and page field. */
        formatted: Record<string, Record<string, string>>;
        board?: BoardColumnState[];
        calendar?: { web: CalendarMode; phone: CalendarMode };
    };
    /** A cache's sync against this view. */
    sync?: {
        /** The rows a span cached, with their stamps. */
        cached: Array<{ key: string; stamp: string | null }>;
        changes: { apply: RowChanges; reconcile: RowChanges; resync: RowChanges };
        index: ViewIndexPage;
        lookup: RowLookup;
        plan: ReconcilePlan;
    };
}
