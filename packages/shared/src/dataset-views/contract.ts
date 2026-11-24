/**
 * The native view contract (CB-451, CB-469): what the view
 * routes under `/api/data/datasets/:id/tables/:table` answer and take,
 * as versioned, renderer-agnostic JSON that the server, the web client
 * and Socio Mobile import.
 *
 * Answers are parsed forgivingly (`z.looseObject`, open strings for
 * kinds and layouts): an answer from a newer server, with keys and
 * values a later release added, still parses, and the client falls back
 * (`./fallback.ts`). Requests are parsed by the server: known keys are
 * checked, unknown ones dropped, so a newer client's additions are
 * ignored rather than refused.
 *
 * Values in rows are raw, never formatted: person ids, file ids, option
 * ids. A client formats them by kind with `formatCell` (`./format.ts`).
 */
import { z } from 'zod';

import { isCalendarDate } from '../dataset-query/spec.js';

import { viewDefinitionWire, type ViewDefinition, type ViewField } from './definition.js';

/** Keys a later schema may add: kept by every parse. */
type Open = { [key: string]: unknown };

/** The bounds of one read. */
export const VIEW_READ_LIMITS = {
    /** Rows a page of a table or list reads by default, and at most. */
    tableRows: 100,
    maxRows: 500,
    /** Cards a board column reads per page. */
    boardRows: 50,
    galleryRows: 60,
    /** Rows a grouped list fills from the top before later groups start folded. */
    groupFillRows: 200,
    /** Days one calendar read covers, both ends counted: a month grid's six weeks fit. */
    rangeDays: 92,
    /** `{ key, stamp }` entries per index page, by default and at most. */
    indexEntries: 5_000,
    /** Keys per rows lookup. */
    lookupKeys: 500,
    /** Rows per changes answer before `next`. */
    changesRows: 1_000,
    /** A cursor's length: an opaque signed string. */
    cursor: 4_096,
    /** A row key's length (JCS JSON of a composite key can be long). */
    key: 2_048,
} as const;

// Field display ----------------------------------------------------------------

/** How a client shows a field whose `kind` it doesn't know. Read-only whatever it is. */
export const FIELD_FALLBACKS = ['text', 'number', 'json', 'hidden'] as const;
export type FieldFallback = (typeof FIELD_FALLBACKS)[number];

/** One option of a select field: a stable id, its label and a palette color name (never a CSS value). */
export interface FieldDisplayOption extends Open {
    id: string;
    label: string;
    color: string;
}

/** A field's display metadata: everything a client needs to show, sort and edit it without a lookup. */
export interface FieldDisplay extends Open {
    /** The column name. */
    field: string;
    label: string;
    /** A known kind (`FIELD_KINDS`), or one from a later release this client may not know. */
    kind: string;
    /** Set by the server for every field: what an unknown kind shows as. */
    fallback: FieldFallback | (string & {});
    /** The person may write it in place (never a key, a `json` or a `blob`). */
    editable: boolean;
    /** NOT NULL without a default. */
    required: boolean;
    isKey: boolean;
    /** Only the keys of its kind. */
    settings: {
        options?: FieldDisplayOption[];
        /** ISO 4217, for `currency`. */
        currency?: string;
        /** A `currency` stored as integer minor units (cents). */
        minorUnits?: boolean;
        decimals?: number;
        unit?: string;
        dateFormat?: 'date' | 'datetime' | (string & {});
        /** A `person` field that also takes socios (`socio:<id>`). */
        allowSocios?: boolean;
    } & Open;
    /** A setting whose column was dropped; sent to editors only. */
    missing?: true;
}

const fieldDisplayShape = {
    field: z.string().min(1),
    label: z.string(),
    kind: z.string().min(1),
    fallback: z.string().min(1),
    editable: z.boolean(),
    required: z.boolean(),
    isKey: z.boolean(),
    settings: z.looseObject({
        options: z.array(z.looseObject({ id: z.string(), label: z.string(), color: z.string() })).optional(),
        currency: z.string().optional(),
        minorUnits: z.boolean().optional(),
        decimals: z.number().int().min(0).max(20).optional(),
        unit: z.string().optional(),
        dateFormat: z.string().optional(),
        allowSocios: z.boolean().optional(),
    }),
    missing: z.literal(true).optional(),
};

export const fieldDisplay: z.ZodType<FieldDisplay> = z.looseObject(fieldDisplayShape);

// Cells and rows ---------------------------------------------------------------

/**
 * A raw cell value. A `blob` never leaves the server; it reads as
 * `{ $blob: true }`. A field of a kind from a later release may carry any
 * JSON, which a client shows through the field's `fallback`.
 */
export type Cell = string | number | boolean | null | Array<string | number> | { $blob: true };

/**
 * Cells parse as any value: an answer is parsed JSON, and a field of a
 * kind a later release added may carry any JSON, which a client shows
 * through the field's `fallback` (`formatCell`).
 */
const cells = z.record(z.string(), z.unknown()) as unknown as z.ZodType<Record<string, Cell>>;

/** One row of a view, by its key. */
export interface ViewRow extends Open {
    /** The primary key as JCS JSON of its value(s); `r:<rowid>` without one (`rowKey`, `./schema.ts`). */
    key: string;
    /** `<generation>.<value>` of the write that last changed it; null without row stamps. */
    stamp: string | null;
    /** The group it was sent under: a multi-value row comes once per group. */
    group?: string | null;
    /** Raw values by field: person ids, file ids, option ids. */
    values: Record<string, Cell>;
}

export const viewRow: z.ZodType<ViewRow> = z.looseObject({
    key: z.string().min(1).max(VIEW_READ_LIMITS.key),
    stamp: z.string().nullable(),
    group: z.string().nullable().optional(),
    values: cells,
});

/** A person in a page's `users` map: a deactivated one is still named, muted. */
export interface ViewUser extends Open {
    name: string;
    avatar: string | null;
    active: boolean;
}
/** A file in a page's `files` map: its name, size, type and whether a thumbnail exists. */
export interface ViewFile extends Open {
    name: string;
    size: number;
    type: string;
    thumb: boolean;
}
const viewUsers = z.record(
    z.string(),
    z.looseObject({ name: z.string(), avatar: z.string().nullable(), active: z.boolean() }),
);
const viewFiles = z.record(
    z.string(),
    z.looseObject({ name: z.string(), size: z.number(), type: z.string(), thumb: z.boolean() }),
);

// GET …/views and GET …/views/:viewId ------------------------------------------------

/** One view a person can open, as the list shows it. */
export interface ViewSummary extends Open {
    id: string;
    name: string;
    /** May be a layout this client doesn't know (`fallbackLayout`). */
    layout: string;
    visibility: 'personal' | 'dataset' | (string & {});
    version: number;
    hasDraft: boolean;
}

/** The person's rights on the table: `writtenBy` names the plugin that writes it, read-only to people. */
export interface ViewRights extends Open {
    read: true;
    write: boolean;
    saveShared: boolean;
    writtenBy?: string;
}

/**
 * `GET …/views`: the table's fields, the person's rights and the views
 * they can see. Its ETag covers the table's views and the person's
 * drafts, so it differs per person.
 */
export interface ViewListResponse extends Open {
    schema: number;
    dataset: { id: string; name: string; spaceId: string | null; version: number } & Open;
    table: { name: string; title: string; hasKey: boolean; analytical: boolean } & Open;
    rights: ViewRights;
    /** Every field of the table, in column order. */
    fields: FieldDisplay[];
    /** Shared first, then the person's own. */
    views: ViewSummary[];
    /** Per person; `default` when none. */
    lastUsedViewId: string;
}

export const viewListResponse: z.ZodType<ViewListResponse> = z.looseObject({
    schema: z.number().int().min(1),
    dataset: z.looseObject({
        id: z.string(),
        name: z.string(),
        spaceId: z.string().nullable(),
        version: z.number(),
    }),
    table: z.looseObject({ name: z.string(), title: z.string(), hasKey: z.boolean(), analytical: z.boolean() }),
    rights: z.looseObject({
        read: z.literal(true),
        write: z.boolean(),
        saveShared: z.boolean(),
        writtenBy: z.string().optional(),
    }),
    fields: z.array(fieldDisplay),
    views: z.array(
        z.looseObject({
            id: z.string(),
            name: z.string(),
            layout: z.string(),
            visibility: z.string(),
            version: z.number(),
            hasDraft: z.boolean(),
        }),
    ),
    lastUsedViewId: z.string(),
});

/** A part of a stored view that no longer fits its table, skipped when it loads. */
export interface SkippedPart extends Open {
    path: string;
    message: string;
}

/** `GET …/views/:viewId`: one view, the person's draft of it, and what was skipped. */
export interface ViewDefinitionResponse extends Open {
    schema: number;
    /** The view needs a later schema than the client asked for, and is sent as near as it goes. */
    degraded?: true;
    view: ViewDefinition;
    draft?: { definition: ViewDefinition; baseVersion: number; updatedAt: number } & Open;
    skipped: SkippedPart[];
    fields: FieldDisplay[];
}

export const viewDefinitionResponse: z.ZodType<ViewDefinitionResponse> = z.looseObject({
    schema: z.number().int().min(1),
    degraded: z.literal(true).optional(),
    view: viewDefinitionWire as z.ZodType<ViewDefinition>,
    draft: z
        .looseObject({
            definition: viewDefinitionWire as z.ZodType<ViewDefinition>,
            baseVersion: z.number().int().min(0),
            updatedAt: z.number(),
        })
        .optional(),
    skipped: z.array(z.looseObject({ path: z.string(), message: z.string() })),
    fields: z.array(fieldDisplay),
});

// POST …/views/:viewId/rows ---------------------------------------------------

/** A calendar read's dates: ISO dates, both included, at most `VIEW_READ_LIMITS.rangeDays`. */
export interface DateSpan {
    from: string;
    to: string;
}

/** Days from `from` to `to`, both counted; 0 when `to` is before `from`. */
export function spanDays(span: DateSpan): number {
    const day = (iso: string) =>
        Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
    return Math.max(0, Math.round((day(span.to) - day(span.from)) / 86_400_000) + 1);
}

const dateSpan = z.object({ from: z.string(), to: z.string() }).superRefine((span, ctx) => {
    for (const end of ['from', 'to'] as const) {
        if (!isCalendarDate(span[end])) {
            ctx.addIssue({
                code: 'custom',
                path: [end],
                message: `"${span[end]}" is not a calendar date (YYYY-MM-DD).`,
            });
        }
    }
    if (isCalendarDate(span.from) && isCalendarDate(span.to)) {
        if (span.to < span.from) {
            ctx.addIssue({ code: 'custom', message: 'A range runs from its first date to its last.' });
        } else if (spanDays(span) > VIEW_READ_LIMITS.rangeDays) {
            ctx.addIssue({ code: 'custom', message: `A range covers at most ${VIEW_READ_LIMITS.rangeDays} days.` });
        }
    }
});

const spanRead = {
    /** The highest schema the client reads; the answer is in `answerSchema(schema)`. */
    schema: z.number().int().min(1),
    /** Default true: the person's draft when they have one. */
    useDraft: z.boolean().optional(),
    /** From a previous answer's `next`; never built by a client. */
    cursor: z.string().min(1).max(VIEW_READ_LIMITS.cursor).optional(),
    /** Date-ordered views: open at today. The first page only. */
    around: z.literal('today').optional(),
    /** A board column or a group: its key, `null` for "No <field>". */
    group: z.string().max(VIEW_READ_LIMITS.key).nullable().optional(),
    /** A calendar's visible range; required for a calendar. */
    range: dateSpan.optional(),
};

const firstPageOnly = (body: { cursor?: string; around?: 'today' }, ctx: z.RefinementCtx) => {
    if (body.cursor !== undefined && body.around !== undefined) {
        ctx.addIssue({
            code: 'custom',
            path: ['around'],
            message: '"around" opens a first page; a cursor reads a later one.',
        });
    }
};

/** `POST …/views/:viewId/rows`: one page of a view, as the person. */
export const viewRowsRequest = z
    .object({
        ...spanRead,
        /** Table and list 100 (at most 500), board 50, gallery 60 (`rowsLimit`). */
        limit: z.number().int().min(1).max(VIEW_READ_LIMITS.maxRows).optional(),
    })
    .superRefine(firstPageOnly);
export type ViewRowsRequest = z.input<typeof viewRowsRequest>;

/** The rows a page reads: what was asked for, else the layout's default, never more than the maximum. */
export function rowsLimit(layout: string, requested?: number): number {
    const fallback =
        layout === 'board'
            ? VIEW_READ_LIMITS.boardRows
            : layout === 'gallery'
              ? VIEW_READ_LIMITS.galleryRows
              : VIEW_READ_LIMITS.tableRows;
    if (requested === undefined || !Number.isInteger(requested) || requested < 1) {
        return fallback;
    }
    return Math.min(requested, VIEW_READ_LIMITS.maxRows);
}

/** A rows or index read against its view's layout: a calendar must send its range. */
export function spanReadProblems(body: { range?: DateSpan }, layout: string): string[] {
    return layout === 'calendar' && !body.range ? ['A calendar reads a range: send { from, to }.'] : [];
}

/** One group of a page: a board column or a list's section, with its count, totals and its own cursor. */
export interface ViewGroup extends Open {
    key: string | null;
    label: string;
    count: number;
    totals?: Record<string, Cell>;
    next: string | null;
    folded: boolean;
}

/** `POST …/views/:viewId/rows`'s answer: one page, with everything needed to show it. */
export interface ViewRowsPage extends Open {
    schema: number;
    viewId: string;
    viewVersion: number;
    draftUsed: boolean;
    /** The dataset's sync token when read, `<generation>.<value>`: the next `changes?since=`. */
    datasetToken: string;
    /** The view's visible fields, in view order. */
    fields: FieldDisplay[];
    /** The priority fields, resolved: what a small screen shows first, never all it can show. */
    compact: string[];
    rows: ViewRow[];
    groups?: ViewGroup[];
    /** Column totals, over every matching row. */
    totals?: Record<string, Cell>;
    users: Record<string, ViewUser>;
    files: Record<string, ViewFile>;
    /** The following page's cursor; null at the end. */
    next: string | null;
    /** Where a date-ordered view opens, when earlier rows exist above it. */
    opensAt?: { group: string | null; row: string } & Open;
    /** A calendar's range back, with the fields it was drawn from and the zone. */
    range?: { from: string; to: string; dateField: string; endField?: string; timeZone: string } & Open;
    /** A group or range had more than it sent. */
    truncated: boolean;
    /** When it was read, in ms since the epoch. */
    at: number;
}

export const viewRowsPage: z.ZodType<ViewRowsPage> = z.looseObject({
    schema: z.number().int().min(1),
    viewId: z.string(),
    viewVersion: z.number(),
    draftUsed: z.boolean(),
    datasetToken: z.string(),
    fields: z.array(fieldDisplay),
    compact: z.array(z.string()),
    rows: z.array(viewRow),
    groups: z
        .array(
            z.looseObject({
                key: z.string().nullable(),
                label: z.string(),
                count: z.number(),
                totals: cells.optional(),
                next: z.string().nullable(),
                folded: z.boolean(),
            }),
        )
        .optional(),
    totals: cells.optional(),
    users: viewUsers,
    files: viewFiles,
    next: z.string().nullable(),
    opensAt: z.looseObject({ group: z.string().nullable(), row: z.string() }).optional(),
    range: z
        .looseObject({
            from: z.string(),
            to: z.string(),
            dateField: z.string(),
            endField: z.string().optional(),
            timeZone: z.string(),
        })
        .optional(),
    truncated: z.boolean(),
    at: z.number(),
});

// GET …/changes?since= --------------------------------------------------------

/**
 * `GET …/changes?since=<token>`: every row of the table written after the
 * token, all fields, and the keys deleted since. See `changesAction`
 * (`./sync.ts`) for what a client does with it.
 */
export interface RowChanges extends Open {
    schema: number;
    /** `<generation>.<value>` read up to: the next `since`. */
    token: string;
    /** Another generation, or `since` below the floor: no rows; reconcile the cache. */
    reconcile?: true;
    /** The table has no stamps (no primary key, or analytical): read the view again. */
    resync?: true;
    /** Rows written after `since`, all fields, in key order. */
    upserts: ViewRow[];
    deleted: Array<{ key: string; stamp: string } & Open>;
    /** More changes than one answer holds (`VIEW_READ_LIMITS.changesRows`). */
    next: string | null;
}

export const rowChanges: z.ZodType<RowChanges> = z.looseObject({
    schema: z.number().int().min(1),
    token: z.string(),
    reconcile: z.literal(true).optional(),
    resync: z.literal(true).optional(),
    upserts: z.array(viewRow),
    deleted: z.array(z.looseObject({ key: z.string(), stamp: z.string() })),
    next: z.string().nullable(),
});

// POST …/views/:viewId/index and POST …/rows/lookup ----------------------------

/** `POST …/views/:viewId/index`: a span's keys and stamps, with the same body as its first page read. */
export const viewIndexRequest = z
    .object({
        ...spanRead,
        /** Entries per page, by default and at most 5,000. */
        limit: z.number().int().min(1).max(VIEW_READ_LIMITS.indexEntries).optional(),
    })
    .superRefine(firstPageOnly);
export type ViewIndexRequest = z.input<typeof viewIndexRequest>;

/** One entry of an index: a row's key and stamp. */
export interface IndexEntry extends Open {
    key: string;
    stamp: string;
}

/** The index's answer: the span as a fresh read lists it now, keys and stamps only, in view order. */
export interface ViewIndexPage extends Open {
    schema: number;
    viewId: string;
    viewVersion: number;
    /** The token read at: the client's next `since`. */
    datasetToken: string;
    /** In view order, a multi-value row once per group. */
    entries: IndexEntry[];
    /** The same signed keyset cursor a rows page would give at this row. */
    next: string | null;
}

export const viewIndexPage: z.ZodType<ViewIndexPage> = z.looseObject({
    schema: z.number().int().min(1),
    viewId: z.string(),
    viewVersion: z.number(),
    datasetToken: z.string(),
    entries: z.array(z.looseObject({ key: z.string(), stamp: z.string() })),
    next: z.string().nullable(),
});

/** `POST …/rows/lookup`: the current rows for up to 500 keys. */
export const rowLookupRequest = z.object({
    schema: z.number().int().min(1),
    keys: z.array(z.string().min(1).max(VIEW_READ_LIMITS.key)).min(1).max(VIEW_READ_LIMITS.lookupKeys),
});
export type RowLookupRequest = z.input<typeof rowLookupRequest>;

/** The lookup's answer: all fields; a key with no live row is left out. */
export interface RowLookup extends Open {
    schema: number;
    token: string;
    rows: ViewRow[];
    users: Record<string, ViewUser>;
    files: Record<string, ViewFile>;
}

export const rowLookup: z.ZodType<RowLookup> = z.looseObject({
    schema: z.number().int().min(1),
    token: z.string(),
    rows: z.array(viewRow),
    users: viewUsers,
    files: viewFiles,
});

// Writes, pickers and exports -------------------------------------------------
//
// What a client sends to change a view, a row, a field's settings or a
// dataset's files, and what it is answered. Every write is the person's,
// through the same rules as the web: `DataSpace.readable` decides
// whether the dataset exists for them (404), `DataSpace.write` and its
// row history decide what they may change, and a conflict is a `409`
// with what is there now, never a silent overwrite. Requests carry
// `schema`, the highest the client reads, like every read.

/** The bounds of one write. */
export const VIEW_WRITE_LIMITS = {
    /** Items of a list cell (multi-select, people, files) one write sets. */
    cellItems: 500,
    /** A text cell's length, in UTF-16 units (the 256 KB answer limit bounds a row anyway). */
    cellText: 65_536,
    /** Fields one new row sets. */
    rowFields: 500,
    /** A `createId`: what makes a replayed create add nothing. */
    createId: 64,
    /** Ids per people lookup. */
    lookupPeople: 500,
    /** Options a select field declares. */
    options: 500,
    /** An option's id and a field's or option's label. */
    optionId: 64,
    label: 100,
    unit: 32,
    /** Rows a view's CSV export writes; above it, the person narrows the filter. */
    exportRows: 100_000,
} as const;

/** The `code` of every refusal a write route answers, beside its `error` text. */
export const VIEW_WRITE_CODES = {
    /** 400: the body, a definition or a value is not acceptable; `problems` lists each. */
    invalid: 'invalid',
    /** 403: the person may read the dataset but not write it, or the field is not editable. */
    readOnly: 'read_only',
    /** 404: the row is gone (deleted since it was read). */
    rowGone: 'row_gone',
    /** 409: someone saved the shared view since `baseVersion`. */
    viewConflict: 'view_conflict',
    /** 409: the cell no longer holds `from`. */
    cellConflict: 'cell_conflict',
    /** 409: a new row's key is taken. */
    keyTaken: 'key_taken',
    /** 409: someone saved the field's settings since `baseVersion`. */
    fieldConflict: 'field_conflict',
    /** 409: options removed while rows still use them; send again with `confirmRemovedOptions`. */
    optionsInUse: 'options_in_use',
    /** 413: the export holds more rows than `VIEW_WRITE_LIMITS.exportRows`. */
    tooManyRows: 'too_many_rows',
    /** 413: the upload is larger than the data space's `fileMaxBytes`. */
    fileTooLarge: 'file_too_large',
    /** 415: the upload's content is not a type datasets take. */
    unsupportedFile: 'unsupported_file',
} as const;
export type ViewWriteCode = (typeof VIEW_WRITE_CODES)[keyof typeof VIEW_WRITE_CODES];

/** Every refusal: words for the person, and a code for the client to act on. */
export interface WriteRefusal extends Open {
    error: string;
    code: ViewWriteCode | (string & {});
}

/** A 400: every problem with a JSON path into the body (`$.definition.fields[2].priority`, `$.values.amount`). */
export interface InvalidWrite extends WriteRefusal {
    code: 'invalid';
    problems: Array<{ path: string; message: string } & Open>;
}

export const writeRefusal: z.ZodType<WriteRefusal> = z.looseObject({
    error: z.string(),
    code: z.string().min(1),
});

export const invalidWrite: z.ZodType<InvalidWrite> = z.looseObject({
    error: z.string(),
    code: z.literal('invalid'),
    problems: z.array(z.looseObject({ path: z.string(), message: z.string() })),
});

/**
 * A value a write sets: what a row reads, but never a blob, and lists of
 * strings or numbers only. The server checks it against the field's kind
 * (an option id for a select, a user id for a person, file ids in the
 * dataset's attachments for a file) and answers 400 otherwise.
 */
export type WriteCell = string | number | boolean | null | Array<string | number>;
export const writeCell: z.ZodType<WriteCell, WriteCell> = z.union([
    z.string().max(VIEW_WRITE_LIMITS.cellText),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.union([z.string().max(VIEW_WRITE_LIMITS.cellText), z.number()])).max(VIEW_WRITE_LIMITS.cellItems),
]);

/** Any JSON value: what a row may hold in a field of a kind from a later release, or written some other way. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const isBlob = (value: unknown) =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { $blob?: unknown }).$blob === true;

/**
 * A value as a row reads it: any JSON but a blob, unbounded, since it is
 * what a compare-and-set compares against (a malformed list, an object a
 * column held before its kind changed), never what is written.
 */
const readCell = z.custom<JsonValue>((value) => value !== undefined && !isBlob(value), {
    message: 'Send the value the cell held as read; a blob is never read, so it is never compared.',
});

const schemaField = z.number().int().min(1);
const fieldNameField = z.string().min(1).max(128);

// Routes ----------------------------------------------------------------------

const enc = encodeURIComponent;

/**
 * The paths of the view routes for one table, built the one way both
 * clients and the server's tests agree on. A row key is JCS JSON
 * (`"b1"`, `[1,"a"]`), so it is always encoded, and never reads as
 * `lookup`, which `…/rows/lookup` takes.
 */
export function viewRoutes(datasetId: string, table: string) {
    const dataset = `/api/data/datasets/${enc(datasetId)}`;
    const base = `${dataset}/tables/${enc(table)}`;
    return {
        views: `${base}/views`,
        view: (viewId: string) => `${base}/views/${enc(viewId)}`,
        draft: (viewId: string) => `${base}/views/${enc(viewId)}/draft`,
        rowsPage: (viewId: string) => `${base}/views/${enc(viewId)}/rows`,
        index: (viewId: string) => `${base}/views/${enc(viewId)}/index`,
        exportCsv: (viewId: string) => `${base}/views/${enc(viewId)}/export.csv`,
        changes: `${base}/changes`,
        lookup: `${base}/rows/lookup`,
        rows: `${base}/rows`,
        row: (key: string) => `${base}/rows/${enc(key)}`,
        fields: `${base}/fields`,
        field: (name: string) => `${base}/fields/${enc(name)}`,
        /** Dataset-wide, not per table: a dataset has one attachment namespace. */
        files: `${dataset}/files`,
        file: (fileId: string, options: { thumb?: boolean; download?: boolean } = {}) => {
            const query = [options.thumb ? 'thumb=1' : '', options.download ? 'download=1' : '']
                .filter(Boolean)
                .join('&');
            return `${dataset}/files/${enc(fileId)}${query ? `?${query}` : ''}`;
        },
    };
}

/** The workspace's people, for pickers: every member reads it. */
export const PEOPLE_DIRECTORY_PATH = '/api/people';
/** Names for ids, deactivated people included. */
export const PEOPLE_LOOKUP_PATH = '/api/people/lookup';

// Drafts and saves ------------------------------------------------------------

/**
 * A definition as a write sends it: the wire shape, read forgivingly so
 * parts a newer release added survive (drafts are saved whole); the
 * server then checks it with `checkViewDefinition` against its own
 * schema and the table, and refuses with every problem (400,
 * `invalid`). Its `id`, `dataset` and `table` must be the route's.
 */
const sentDefinition = viewDefinitionWire as unknown as z.ZodType<ViewDefinition, ViewDefinition>;

/** A new view's definition: the server gives it its id and version 1. */
export interface NewViewDefinition extends Open {
    schema: number;
    dataset: string;
    table: string;
    name: string;
    layout: ViewDefinition['layout'];
    query: ViewDefinition['query'];
    fields: ViewDefinition['fields'];
    options: ViewDefinition['options'];
    totals?: ViewDefinition['totals'];
    visibility: ViewDefinition['visibility'];
}

/**
 * `PUT …/views/:viewId/draft`: the person's draft of a view, whole.
 * `baseVersion` is the shared view's version the draft started from
 * (0 for `default`, which is never stored); a draft is personal, so it is
 * stored whatever the shared view's version is now, and the conflict, if
 * any, comes when it is saved for everyone. `definition.version` is
 * ignored: the base is `baseVersion`.
 */
export const viewDraftRequest = z.object({
    schema: schemaField,
    definition: sentDefinition,
    baseVersion: z.number().int().min(0),
});
export type ViewDraftRequest = z.input<typeof viewDraftRequest>;

/** The draft's answer: what `GET …/views/:viewId` will send as `draft`. `DELETE …/draft` answers `{ ok: true }`. */
export interface ViewDraftSaved extends Open {
    schema: number;
    draft: { definition: ViewDefinition; baseVersion: number; updatedAt: number } & Open;
}

export const viewDraftSaved: z.ZodType<ViewDraftSaved> = z.looseObject({
    schema: schemaField,
    draft: z.looseObject({
        definition: sentDefinition,
        baseVersion: z.number().int().min(0),
        updatedAt: z.number(),
    }),
});

/**
 * `POST …/views`: a new view, personal or (with `rights.saveShared`)
 * for everyone; "Save as new view" and a conflict's "save mine as a new
 * view". The server gives it an id and version 1, so the
 * definition has neither. `fromDraft` names the view whose draft this
 * was: that draft is removed once the new view is saved.
 */
export const viewCreateRequest = z.object({
    schema: schemaField,
    definition: viewDefinitionWire.omit({ id: true, version: true }) as unknown as z.ZodType<
        NewViewDefinition,
        NewViewDefinition
    >,
    fromDraft: z.string().min(1).max(64).optional(),
});
export type ViewCreateRequest = z.input<typeof viewCreateRequest>;

/**
 * `PUT …/views/:viewId`: save for everyone, or save a personal
 * view by its owner. It saves only while the stored view is still at
 * `baseVersion`; then `version` goes up by one and the person's draft of
 * it is removed. Otherwise `409 view_conflict` (`ViewConflict`).
 *
 * The conflict's three choices: **keep mine** sends again with
 * `baseVersion` set to the conflict's `current.version` and
 * `overwrite: true`, which the audit records as an overwrite (a save
 * in between conflicts again); **take theirs** deletes the draft;
 * **save mine as new** is `POST …/views` with `fromDraft`.
 * `default` is never stored, so it is not saved here (400): save it as a
 * new view.
 */
export const viewSaveRequest = z.object({
    schema: schemaField,
    definition: sentDefinition,
    baseVersion: z.number().int().min(0),
    /** Keep mine, after a conflict: recorded as an overwrite of `baseVersion`. */
    overwrite: z.literal(true).optional(),
});
export type ViewSaveRequest = z.input<typeof viewSaveRequest>;

/** A save's or a create's answer (200, 201): the view as stored, with its new version. */
export interface ViewSaved extends Open {
    schema: number;
    view: ViewDefinition;
}

export const viewSaved: z.ZodType<ViewSaved> = z.looseObject({
    schema: schemaField,
    view: sentDefinition,
});

/** The parts of a definition a conflict compares, each whole. A later release may add parts. */
export const VIEW_DIFF_PARTS = [
    'name',
    'layout',
    'filter',
    'sort',
    'groupBy',
    'segments',
    'fields',
    'options',
    'totals',
    'visibility',
] as const;
export type ViewDiffPart = (typeof VIEW_DIFF_PARTS)[number];

/** One field of a view whose entry differs: added, removed, changed or moved. */
export interface ViewFieldDiff extends Open {
    field: string;
    /** null: not listed on that side. */
    mine: ViewField | null;
    theirs: ViewField | null;
    /** Listed on both sides, at a different place among the fields both list. */
    moved: boolean;
}

/**
 * The difference a conflict shows, part by part and field by field, from
 * the person's definition (`mine`) to the stored one (`theirs`). Nothing
 * is merged: the person chooses (`viewSaveRequest`).
 */
export interface ViewDiff extends Open {
    parts: Array<{ part: ViewDiffPart | (string & {}); mine: unknown; theirs: unknown } & Open>;
    /** Per field, when `fields` is among `parts`; in `theirs` order, then fields only `mine` lists. */
    fields: ViewFieldDiff[];
}

/** `409 view_conflict`: the stored view now, who saved it, and the difference. */
export interface ViewConflict extends WriteRefusal {
    code: 'view_conflict';
    current: ViewDefinition;
    diff: ViewDiff;
    /** Who saved `current`, when it is known; their name is in `users`. */
    savedBy: string | null;
    savedAt: number;
    users: Record<string, ViewUser>;
}

const viewFieldWire = z.looseObject({
    field: z.string(),
    hidden: z.boolean().optional(),
    width: z.number().optional(),
    wrap: z.boolean().optional(),
    priority: z.number().optional(),
}) as z.ZodType<ViewField>;

export const viewDiff: z.ZodType<ViewDiff> = z.looseObject({
    parts: z.array(z.looseObject({ part: z.string(), mine: z.unknown(), theirs: z.unknown() })),
    fields: z.array(
        z.looseObject({
            field: z.string(),
            mine: viewFieldWire.nullable(),
            theirs: viewFieldWire.nullable(),
            moved: z.boolean(),
        }),
    ),
}) as z.ZodType<ViewDiff>;

export const viewConflict: z.ZodType<ViewConflict> = z.looseObject({
    error: z.string(),
    code: z.literal('view_conflict'),
    current: sentDefinition,
    diff: viewDiff,
    savedBy: z.string().nullable(),
    savedAt: z.number(),
    users: viewUsers,
});

/** JSON equality, keys in any order: how a part or a field entry is compared. */
export function sameJson(a: unknown, b: unknown): boolean {
    if (a === b) {
        return true;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const left = Object.entries(a as Record<string, unknown>).filter(([, v]) => v !== undefined);
        const right = Object.entries(b as Record<string, unknown>).filter(([, v]) => v !== undefined);
        const other = b as Record<string, unknown>;
        return left.length === right.length && left.every(([k, v]) => sameJson(v, other[k]));
    }
    return false;
}

/** A part of a definition, as `ViewDiff` holds it: a query part, or a top-level key. */
function viewPart(view: ViewDefinition, part: string): unknown {
    return part === 'filter' || part === 'sort' || part === 'groupBy' || part === 'segments'
        ? view.query?.[part]
        : view[part];
}

/**
 * The difference from `mine` to `theirs`: every part of
 * `VIEW_DIFF_PARTS` that differs, and, when the fields do, each field
 * entry that was added, removed, changed or moved. The server computes
 * it for a `409`; a client may compute it again from the two sides.
 */
export function diffViews(mine: ViewDefinition, theirs: ViewDefinition): ViewDiff {
    const parts = VIEW_DIFF_PARTS.flatMap((part) => {
        const a = viewPart(mine, part);
        const b = viewPart(theirs, part);
        return sameJson(a, b) ? [] : [{ part, mine: a ?? null, theirs: b ?? null }];
    });
    const fields: ViewFieldDiff[] = [];
    if (parts.some((p) => p.part === 'fields')) {
        const mineList = mine.fields ?? [];
        const theirsList = theirs.fields ?? [];
        const mineBy = new Map(mineList.map((f) => [f.field, f]));
        const theirsBy = new Map(theirsList.map((f) => [f.field, f]));
        const both = (list: readonly ViewField[], other: Map<string, ViewField>) =>
            list.filter((f) => other.has(f.field)).map((f) => f.field);
        const mineOrder = both(mineList, theirsBy);
        const theirsOrder = both(theirsList, mineBy);
        for (const f of theirsList) {
            const own = mineBy.get(f.field) ?? null;
            const moved = own !== null && mineOrder.indexOf(f.field) !== theirsOrder.indexOf(f.field);
            if (!own || moved || !sameJson(own, f)) {
                fields.push({ field: f.field, mine: own, theirs: f, moved });
            }
        }
        for (const f of mineList) {
            if (!theirsBy.has(f.field)) {
                fields.push({ field: f.field, mine: f, theirs: null, moved: false });
            }
        }
    }
    return { parts, fields };
}

// Rows: a cell edit and a new row -------------------------------------------------

/**
 * `PATCH …/rows/:key`: one cell, as a compare-and-set. `from` is
 * the raw value the edit replaces, as the client read it; the write is
 * `UPDATE … SET field = to WHERE key = ? AND field IS from`. A cell that
 * already holds `to` answers 200 unchanged, so an outbox replay that
 * landed before is not a conflict. Lists compare as JSON values.
 * Needs `rights.write` and `FieldDisplay.editable` (403 `read_only`);
 * tables without a key are read-only in views.
 */
export const cellEditRequest = z.object({
    schema: schemaField,
    field: fieldNameField,
    /** As read, so any readable value: the write limits and kinds bound `to` only. */
    from: readCell,
    to: writeCell,
});
export type CellEditRequest = z.input<typeof cellEditRequest>;

/**
 * `POST …/rows`: a new row, by a person in a view. `values` are by field;
 * fields left out take their defaults, a required one left out is a 400
 * (`invalid`, with its path). The key: a single `INTEGER PRIMARY KEY`
 * left out is assigned by SQLite; any other key's fields must be sent,
 * and a taken one answers `409 key_taken`. `createId`, a client-made id,
 * makes a replay add nothing: the same id within a day answers the row
 * it made (200, not 201), as it is now. A body with `rows` (and no
 * `schema`) is the existing token batch insert or upsert, unchanged.
 */
export const rowCreateRequest = z.object({
    schema: schemaField,
    values: z
        .record(fieldNameField, writeCell)
        .refine((values) => Object.keys(values).length <= VIEW_WRITE_LIMITS.rowFields, {
            message: `A row sets at most ${VIEW_WRITE_LIMITS.rowFields} fields.`,
        }),
    createId: z
        .string()
        .regex(/^[A-Za-z0-9_-]{8,64}$/, 'A create id is 8 to 64 letters, digits, "-" or "_".')
        .optional(),
});
export type RowCreateRequest = z.input<typeof rowCreateRequest>;

/**
 * A row write's answer: the row as stored now, with its key (assigned by
 * the server for a new row) and the stamp of this write, and the names
 * and files its values mention. 201 for a new row, 200 otherwise.
 */
export interface RowWritten extends Open {
    schema: number;
    row: ViewRow;
    users: Record<string, ViewUser>;
    files: Record<string, ViewFile>;
}

export const rowWritten: z.ZodType<RowWritten> = z.looseObject({
    schema: schemaField,
    row: viewRow,
    users: viewUsers,
    files: viewFiles,
});

/**
 * `409 cell_conflict`: the cell no longer holds `from`. `current` is
 * what it holds now, and `row` the whole row as read with it, so the
 * phone offers Keep mine (the same edit with `from: current`) or Keep
 * theirs (`row` replaces the cached one).
 */
export interface CellConflict extends WriteRefusal {
    code: 'cell_conflict';
    field: string;
    current: Cell;
    row: ViewRow;
    users: Record<string, ViewUser>;
    files: Record<string, ViewFile>;
}

export const cellConflict: z.ZodType<CellConflict> = z.looseObject({
    error: z.string(),
    code: z.literal('cell_conflict'),
    field: z.string(),
    current: z.unknown() as z.ZodType<Cell>,
    row: viewRow,
    users: viewUsers,
    files: viewFiles,
}) as z.ZodType<CellConflict>;

// Field settings --------------------------------------------------------------

/** One field's settings as the Fields sheet edits them. */
export interface FieldSettingEntry extends FieldDisplay {
    /** The column's stored type (`TEXT`, `DECIMAL(12,2)`); empty for a missing column. */
    type: string;
    /** Every kind that fits the column's type (`kindFitsColumn`), the current one included. */
    kinds: string[];
    /** The setting's version; 0 while it is inferred from the type and never saved. */
    version: number;
    /** Set by a plugin's manifest rather than a person. */
    declaredBy?: string;
}

const fieldSettingEntry: z.ZodType<FieldSettingEntry> = z.looseObject({
    ...fieldDisplayShape,
    type: z.string(),
    kinds: z.array(z.string()),
    version: z.number().int().min(0),
    declaredBy: z.string().optional(),
}) as unknown as z.ZodType<FieldSettingEntry>;

/**
 * `GET …/fields`: every field of the table with its settings, in column
 * order, then settings whose column was dropped (`missing`), which only
 * people who may write see. Conditional (ETag, 304).
 */
export interface FieldSettingsResponse extends Open {
    schema: number;
    /** May save field settings: the people who may write the dataset. */
    canEdit: boolean;
    fields: FieldSettingEntry[];
}

export const fieldSettingsResponse: z.ZodType<FieldSettingsResponse> = z.looseObject({
    schema: schemaField,
    canEdit: z.boolean(),
    fields: z.array(fieldSettingEntry),
});

const optionColor = z.string().min(1).max(32);

/** The settings a write may set: only the keys of the kind are kept, every one checked. */
export const fieldSettingsInput = z.object({
    options: z
        .array(
            z.object({
                id: z.string().min(1).max(VIEW_WRITE_LIMITS.optionId),
                label: z.string().trim().min(1).max(VIEW_WRITE_LIMITS.label),
                color: optionColor,
            }),
        )
        .max(VIEW_WRITE_LIMITS.options)
        .superRefine((options, ctx) => {
            const seen = new Set<string>();
            options.forEach((option, i) => {
                if (seen.has(option.id)) {
                    ctx.addIssue({
                        code: 'custom',
                        path: [i, 'id'],
                        message: `Option "${option.id}" is listed twice.`,
                    });
                }
                seen.add(option.id);
            });
        })
        .optional(),
    currency: z
        .string()
        .regex(/^[A-Z]{3}$/, 'A currency is an ISO 4217 code, like USD.')
        .optional(),
    minorUnits: z.boolean().optional(),
    decimals: z.number().int().min(0).max(20).optional(),
    unit: z.string().max(VIEW_WRITE_LIMITS.unit).optional(),
    dateFormat: z.enum(['date', 'datetime']).optional(),
    allowSocios: z.boolean().optional(),
});

/**
 * `PUT …/fields/:field`: a field's kind, label and settings, by
 * people who may write the dataset. Saved only while the stored setting
 * is still at `baseVersion` (0 for one never saved), else
 * `409 field_conflict` with the current one. A kind the column's type
 * doesn't take is a 400 naming the type. Removing options that rows
 * still use answers `409 options_in_use` with the counts, until it is
 * sent again with `confirmRemovedOptions: true`; the rows keep their
 * raw values, shown as "Unknown option".
 */
export const fieldSettingsRequest = z.object({
    schema: schemaField,
    kind: z.string().min(1).max(32),
    label: z.string().trim().min(1).max(VIEW_WRITE_LIMITS.label).optional(),
    settings: fieldSettingsInput,
    baseVersion: z.number().int().min(0),
    confirmRemovedOptions: z.literal(true).optional(),
});
export type FieldSettingsRequest = z.input<typeof fieldSettingsRequest>;

/** The save's answer: the field as stored, with its new version. */
export interface FieldSettingsSaved extends Open {
    schema: number;
    field: FieldSettingEntry;
}

export const fieldSettingsSaved: z.ZodType<FieldSettingsSaved> = z.looseObject({
    schema: schemaField,
    field: fieldSettingEntry,
});

/** `409 field_conflict`: someone saved the field since `baseVersion`. */
export interface FieldConflict extends WriteRefusal {
    code: 'field_conflict';
    current: FieldSettingEntry;
}

export const fieldConflict: z.ZodType<FieldConflict> = z.looseObject({
    error: z.string(),
    code: z.literal('field_conflict'),
    current: fieldSettingEntry,
}) as z.ZodType<FieldConflict>;

/** `409 options_in_use`: the removed options rows still hold, with how many rows each. */
export interface OptionsInUse extends WriteRefusal {
    code: 'options_in_use';
    inUse: Array<{ id: string; label: string; rows: number } & Open>;
}

export const optionsInUse: z.ZodType<OptionsInUse> = z.looseObject({
    error: z.string(),
    code: z.literal('options_in_use'),
    inUse: z.array(z.looseObject({ id: z.string(), label: z.string(), rows: z.number().int().min(1) })),
}) as z.ZodType<OptionsInUse>;

// CSV export of a view ----------------------------------------------------------

/**
 * `GET …/views/:viewId/export.csv?schema=1&useDraft=false`: what the
 * view shows, as the person: its filter, sort and visible fields,
 * labels as headers, values formatted by kind, RFC 4180 through
 * `csvField`, CRLF, a UTF-8 byte-order mark, streamed. `useDraft`
 * defaults to true, as a page read. Answers `text/csv; charset=utf-8`
 * as an attachment named after the view, `Cache-Control: no-store`; more
 * than `VIEW_WRITE_LIMITS.exportRows` matching rows is `413
 * too_many_rows` (`ExportTooLarge`) before any byte is sent. Audited as
 * `export_csv` with the view id. A GET, so a phone hands the URL's
 * download to the share sheet.
 */
export const viewExportQuery = z.object({
    schema: z.coerce.number().int().min(1),
    useDraft: z.enum(['true', 'false']).optional(),
});
export type ViewExportQuery = z.input<typeof viewExportQuery>;

/** The export's query string, as `viewExportQuery` reads it. */
export function viewExportSearch(options: { schema: number; useDraft?: boolean }): string {
    return `schema=${options.schema}${options.useDraft === undefined ? '' : `&useDraft=${options.useDraft}`}`;
}

/** What an export joins a list cell's items with. */
export const EXPORT_LIST_SEPARATOR = '; ';

/** `413 too_many_rows`: the rows the view matches, and the limit. */
export interface ExportTooLarge extends WriteRefusal {
    code: 'too_many_rows';
    rows: number;
    limit: number;
}

export const exportTooLarge: z.ZodType<ExportTooLarge> = z.looseObject({
    error: z.string(),
    code: z.literal('too_many_rows'),
    rows: z.number().int(),
    limit: z.number().int(),
}) as z.ZodType<ExportTooLarge>;

// People for person fields ----------------------------------------------------

/** One person a picker offers: active, never a socio, a service account or a sentinel. */
export interface DirectoryPerson extends Open {
    id: string;
    name: string;
    avatar: string | null;
}

/**
 * `GET /api/people`: the workspace's directory, for picking people.
 * Every signed-in member reads it. Only active people are
 * listed, by name then id; a deactivated person is never offered, but
 * stays resolvable by id through `PEOPLE_LOOKUP_PATH` and every page's
 * `users` map. Socios for a field with `allowSocios` come from the
 * workspace's socios, not from here. Conditional (ETag, 304).
 */
export interface PeopleDirectory extends Open {
    schema: number;
    people: DirectoryPerson[];
}

export const peopleDirectory: z.ZodType<PeopleDirectory> = z.looseObject({
    schema: schemaField,
    people: z.array(z.looseObject({ id: z.string().min(1), name: z.string(), avatar: z.string().nullable() })),
});

/** `POST /api/people/lookup`: names for up to 500 ids, as a page's `users` map has them. */
export const peopleLookupRequest = z.object({
    schema: schemaField,
    ids: z.array(z.string().min(1).max(128)).min(1).max(VIEW_WRITE_LIMITS.lookupPeople),
});
export type PeopleLookupRequest = z.input<typeof peopleLookupRequest>;

/**
 * The lookup's answer: each known id, deactivated people included with
 * `active: false`, and `socio:<id>` values by the socio's name; an id
 * nobody has is left out (shown as "Unknown person").
 */
export interface PeopleLookup extends Open {
    schema: number;
    users: Record<string, ViewUser>;
}

export const peopleLookup: z.ZodType<PeopleLookup> = z.looseObject({
    schema: schemaField,
    users: viewUsers,
});

// Files for file fields --------------------------------------------------------

/** The header a raw upload needs, as `/api/media/uploads` does: a CSRF guard that forces a preflight. */
export const DATASET_UPLOAD_HEADER = 'X-CB-Upload';
/** The file's name, URI-encoded. */
export const DATASET_UPLOAD_NAME_HEADER = 'X-File-Name';
/** What the client thinks it is; advisory, the server checks the content. */
export const DATASET_UPLOAD_TYPE_HEADER = 'X-File-Type';

/** What a dataset takes by default, checked by content, never by name. SVG is refused. */
export const DATASET_FILE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'] as const;
/** Uploads a minute, per person. */
export const DATASET_UPLOADS_PER_MINUTE = 60;

/**
 * `POST /api/data/datasets/:id/files`: one file into the dataset's
 * attachment namespace, as `/api/media/uploads` takes one: the
 * bytes as `application/octet-stream`, `X-CB-Upload: 1`, `X-File-Name`
 * (URI-encoded) and an optional `X-File-Type`. Needs write access to
 * the dataset (403 `read_only`). The server stores it with
 * `DataSpace.putFile` under the dataset owner's
 * `datasets/<datasetId>/files/`, under their quota, and records it in
 * `data_dataset_files`; too large is `413 file_too_large`, a type it
 * doesn't take `415 unsupported_file`, too fast 429. Nothing is set in a
 * row: the client then writes the id into a file field with a cell edit
 * (`PATCH …/rows/:key`) or a new row.
 */
export interface DatasetFileUploaded extends Open {
    schema: number;
    /** The id a `file` cell holds, and the entry the `files` map will send for it. */
    file: ViewFile & { id: string };
}

export const datasetFileUploaded: z.ZodType<DatasetFileUploaded> = z.looseObject({
    schema: schemaField,
    file: z.looseObject({
        id: z.string().min(1),
        name: z.string(),
        size: z.number().int().min(0),
        type: z.string(),
        thumb: z.boolean(),
    }),
});
