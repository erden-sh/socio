import type { FilterNode, QuerySort } from '@socio/shared/dataset-query/spec';
import type {
    Cell,
    CellConflict,
    FieldDisplay,
    FieldSettingEntry,
    NewViewDefinition,
    RowChanges,
    RowLookup,
    RowWritten,
    ViewDefinitionResponse,
    ViewFile,
    ViewGroup,
    ViewIndexPage,
    ViewListResponse,
    ViewRow,
    ViewRowsPage,
    ViewRowsRequest,
    ViewUser,
    WriteCell,
    WriteRefusal,
} from '@socio/shared/dataset-views/contract';
import {
    DATASET_FILE_TYPES,
    DATASET_UPLOADS_PER_MINUTE,
    diffViews,
    EXPORT_LIST_SEPARATOR,
    rowsLimit,
    sameJson,
} from '@socio/shared/dataset-views/contract';
import type { ViewDefinition } from '@socio/shared/dataset-views/definition';
import { compareRows, matchesFilter, sortIsEvaluable } from '@socio/shared/dataset-views/evaluate';
import { readViewDefinition } from '@socio/shared/dataset-views/fallback';
import {
    BOOKINGS_ROWS,
    BOOKINGS_USERS,
    FIXTURE_CONTEXT,
    VIEW_FIXTURES,
    type ViewFixture,
} from '@socio/shared/dataset-views/fixtures/index';
import {
    ACME_DATASET,
    ACME_FILES,
    ACME_TABLE,
    ACME_THEIRS,
    WRITE_FIXTURES,
} from '@socio/shared/dataset-views/fixtures/writes';
import { cellDay, cellInstant, cellItems, formatCell, isChecked } from '@socio/shared/dataset-views/format';
import { boardColumns, resolveCompact, visibleFields } from '@socio/shared/dataset-views/presentation';
import { formatStamp, parseStamp } from '@socio/shared/dataset-views/schema';
import { csvField } from '@socio/shared/text/csv';

import { settingsForKind } from '../shell/dataset-writes';

import type {
    CellEdit,
    CellEditResult,
    DatasetUpload,
    ExportResult,
    FieldSave,
    FieldSaveResult,
    Refused,
    RowCreateResult,
    TableRef,
    UploadResult,
    ViewSaveResult,
    ViewSource,
} from './view-source';

// The fixture-backed `ViewSource` (CB-469), every read and write of the
// dataset views contract (CB-451) on the shared fixtures, until the server
// serves them. Two tables:
// - `ds_events`/`bookings`: the view fixtures (one per layout and one with
//   parts from a newer release) as one table with all six views. A view read
//   as its fixture asks (no draft, the fixture's own request, nothing written)
//   gets the fixture's page as it is, so the screens draw exactly what the
//   contract tests hold; anything else is computed over the table's rows with
//   the shared evaluator, in the fixtures' zone and clock.
// - `ds_acme`/`tasks`: the write fixtures (`fixtures/writes.ts`), with the
//   people, files, views and field settings they name, and their refusals'
//   words. Three writes from someone else land the first time the phone
//   writes over them, so the dev preview meets every conflict: Bo's change
//   to “Ship the Acme brief” (`cell_conflict`), Bo's save of “Open tasks”
//   after Ada's draft started (`view_conflict`, the phone opening with
//   `ACME_MINE` as its draft), and a save of Status's options (`field_conflict`),
//   then `options_in_use` when an option rows hold is removed. The Archive
//   view's export answers `413 too_many_rows`.
// Writes are the server's rules: a compare-and-set on
// the value read (a cell already at `to` answers 200), versions on views and
// field settings, a replayed `createId` answering its row, and every refusal
// `{ error, code }`.
// No React Native: tests/sync runs it under Node.

export const FIXTURE_DATASET = 'ds_events';
export const FIXTURE_TABLE = 'bookings';
export const FIXTURE_REF: TableRef = { datasetId: FIXTURE_DATASET, table: FIXTURE_TABLE };
export { ACME_DATASET, ACME_TABLE };
export const ACME_REF: TableRef = { datasetId: ACME_DATASET, table: ACME_TABLE };
/** The Acme row Bo changes, the view Bo saved and the export that is too large. */
export const ACME_CONFLICT_ROW = '1042';
export const ACME_OPEN_VIEW = ACME_THEIRS.id;
export const ACME_ARCHIVE_VIEW = 'v_acme_archive';
/** The largest file the fixtures take (a data space's `fileMaxBytes`). */
export const FIXTURE_FILE_MAX = 20 * 1024 * 1024;

/** A column's group key on the wire: the option or person id, `true`/`false`, or null. */
export const groupKey = (value: string | boolean | null): string | null => (value === null ? null : String(value));

const W = WRITE_FIXTURES;
/** Everyone in the fixtures' one workspace: both tables' people, a person field takes any of them. */
const WORKSPACE_PEOPLE: Readonly<Record<string, ViewUser>> = { ...BOOKINGS_USERS, ...W.peopleLookup[0].users };
const refusal = (fixture: WriteRefusal, status: number): Refused => ({
    outcome: 'refused',
    status,
    code: fixture.code,
    error: fixture.error,
    body: fixture,
});
const refusalByCode = (code: string, status: number): Refused =>
    refusal(
        W.writeRefusal.find((r) => r.code === code)!,
        status,
    );

/** One view a fixture table stores. */
interface StoredView {
    definition: ViewDefinition;
    /** The view fixture it came from: its page answers its own request while nothing changed. */
    readonly fixture?: ViewFixture;
    savedBy: string | null;
    savedAt: number;
    /** What its export answers instead of a CSV. */
    readonly exportRefusal?: 'too_many_rows';
}

type Draft = NonNullable<ViewDefinitionResponse['draft']>;

/** A write from someone else that lands once, the first time the phone writes over it. */
interface Remote {
    row?: { readonly key: string; readonly row: ViewRow; readonly field: string; readonly error: string };
    field?: { readonly name: string; readonly entry: FieldSettingEntry };
}

interface FixtureTable {
    readonly ref: TableRef;
    readonly list: Pick<ViewListResponse, 'schema' | 'dataset' | 'table' | 'rights'>;
    /** Field settings, column order, `missing` ones last; the list's fields are the ones not missing. */
    settings: FieldSettingEntry[];
    rows: ViewRow[];
    readonly users: Record<string, ViewUser>;
    files: Record<string, ViewFile>;
    views: StoredView[];
    readonly drafts: Map<string, Draft>;
    readonly me: string;
    readonly generation: string;
    stamp: number;
    /** Rows written since the fixtures: a fixture's page no longer answers as it is. */
    edited: boolean;
    readonly created: Map<string, string>;
    readonly remote: Remote;
}

const displayOf = ({ type: _t, kinds: _k, version: _v, declaredBy: _d, ...display }: FieldSettingEntry) =>
    display as FieldDisplay;
const fieldsOf = (table: FixtureTable): FieldDisplay[] => table.settings.filter((s) => !s.missing).map(displayOf);
const token = (table: FixtureTable) => formatStamp(table.generation, table.stamp);

/** The kinds a column of `type` takes (`kindFitsColumn`), for the fixtures' settings. */
const KINDS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
    TEXT: W.fieldSettingsResponse[0].fields[1]!.kinds,
    INTEGER: ['number', 'currency', 'percent', 'checkbox', 'date', 'datetime', 'person', 'select'],
    REAL: ['number', 'currency', 'percent'],
};

const entry = (display: FieldDisplay, type: string, version = 0, kinds?: readonly string[]): FieldSettingEntry => ({
    ...display,
    type,
    kinds: [...(kinds ?? (display.isKey ? [display.kind] : (KINDS_BY_TYPE[type] ?? [display.kind])))],
    version,
});

// ----- The bookings table: the view fixtures -----

function bookingsTable(fixtures: readonly ViewFixture[], now: number): FixtureTable {
    const seen = new Map<string, FieldDisplay>();
    for (const fixture of fixtures) {
        for (const field of fixture.list.fields) {
            if (!seen.has(field.field)) {
                seen.set(field.field, field);
            }
        }
    }
    const typeOf = (field: FieldDisplay) =>
        field.kind === 'number' || field.kind === 'currency' || field.kind === 'percent'
            ? field.kind === 'currency'
                ? 'INTEGER'
                : 'REAL'
            : field.kind === 'checkbox'
              ? 'INTEGER'
              : 'TEXT';
    const extra = new Map<string, ViewRow>();
    for (const fixture of fixtures) {
        for (const row of fixture.page.rows) {
            extra.set(row.key, {
                ...(extra.get(row.key) ?? row),
                values: { ...extra.get(row.key)?.values, ...row.values },
            });
        }
    }
    const first = fixtures[0]!;
    const stamp = parseStamp(first.page.datasetToken);
    const users: Record<string, ViewUser> = { ...WORKSPACE_PEOPLE };
    const files: Record<string, ViewFile> = {};
    for (const fixture of fixtures) {
        Object.assign(users, fixture.page.users);
        Object.assign(files, fixture.page.files);
    }
    const { schema, dataset, table } = first.list;
    return {
        ref: FIXTURE_REF,
        list: { schema, dataset, table, rights: { read: true, write: true, saveShared: true } },
        settings: [...seen.values()].map((field) => entry(field, typeOf(field))),
        rows: BOOKINGS_ROWS.map((row) => ({ ...row, values: { ...row.values, ...extra.get(row.key)?.values } })),
        users,
        files,
        views: fixtures.map((fixture) => ({
            definition: fixture.definition.view,
            fixture,
            savedBy: null,
            savedAt: now,
        })),
        drafts: new Map(),
        me: FIXTURE_CONTEXT.me,
        generation: stamp?.generation ?? 'fixture',
        stamp: stamp?.value ?? 1,
        edited: false,
        created: new Map(),
        remote: {},
    };
}

// ----- The Acme table: the write fixtures -----

const acmeDisplay = (field: string, label: string, kind: string, extra: Partial<FieldDisplay> = {}): FieldDisplay => ({
    field,
    label,
    kind,
    fallback: 'text',
    editable: true,
    required: false,
    isKey: false,
    settings: {},
    ...extra,
});

function acmeTable(now: number): FixtureTable {
    const [settingsFixture] = W.fieldSettingsResponse;
    const byName = new Map(settingsFixture.fields.map((f) => [f.field, f]));
    const status = byName.get('status')!;
    const conflictRow = W.cellConflict[0].row;
    const generation = parseStamp(conflictRow.stamp)!.generation;
    const settings: FieldSettingEntry[] = [
        byName.get('id')!,
        entry(acmeDisplay('title', 'Title', 'text', { required: true }), 'TEXT'),
        status,
        entry(acmeDisplay('owner', 'Owner', 'person'), 'TEXT'),
        entry(acmeDisplay('file', 'Attachment', 'file'), 'TEXT'),
        entry(acmeDisplay('due', 'Due', 'date', { settings: { dateFormat: 'date' } }), 'TEXT'),
        entry(acmeDisplay('notes', 'Notes', 'long_text'), 'TEXT'),
        byName.get('budget')!,
    ];
    const row = (id: number, stamp: number, values: Record<string, Cell>): ViewRow => ({
        key: String(id),
        stamp: formatStamp(generation, stamp),
        values: { id, file: [], notes: null, ...values },
    });
    const rows = [
        row(1039, 2190, { title: 'Sign the Acme contract', status: 'opt_done', owner: 'u_ada', due: '2026-11-18' }),
        row(1040, 2201, { title: 'Draft the Acme proposal', status: 'opt_doing', owner: 'u_ada', due: '2026-11-25' }),
        row(1041, 2204, { title: 'Book the kickoff call', status: 'opt_todo', owner: null, due: '2026-11-27' }),
        // What the phone read before Bo's change (the conflict fixture's row, as it was).
        row(1042, 2205, {
            title: 'Ship the Acme brief',
            status: W.cellEditRequest[0].from as Cell,
            owner: 'u_ada',
            file: ['f_acme_1'],
            due: '2026-11-28',
        }),
    ];
    const allFields = settings.filter((s) => !s.missing).map((s) => ({ field: s.field }));
    const defaultView: ViewDefinition = {
        schema: 1,
        id: 'default',
        dataset: ACME_DATASET,
        table: ACME_TABLE,
        name: 'All tasks',
        layout: 'table',
        query: {},
        fields: allFields.filter((f) => f.field !== 'id'),
        options: {},
        visibility: 'dataset',
        version: 0,
    };
    const archive: ViewDefinition = {
        ...defaultView,
        id: ACME_ARCHIVE_VIEW,
        name: 'Archive',
        layout: 'list',
        query: { filter: { field: 'status', op: 'is', value: 'opt_done' }, sort: [{ field: 'due', dir: 'desc' }] },
        version: 1,
    };
    const [conflict] = W.viewConflict;
    return {
        ref: ACME_REF,
        list: {
            schema: 1,
            dataset: { id: ACME_DATASET, name: 'Acme', spaceId: null, version: 1 },
            table: { name: ACME_TABLE, title: 'Tasks', hasKey: true, analytical: false },
            rights: { read: true, write: true, saveShared: true },
        },
        settings,
        rows,
        users: { ...WORKSPACE_PEOPLE },
        files: { ...ACME_FILES },
        views: [
            { definition: ACME_THEIRS, savedBy: conflict.savedBy, savedAt: conflict.savedAt },
            { definition: archive, savedBy: 'u_ada', savedAt: now, exportRefusal: 'too_many_rows' },
            { definition: defaultView, savedBy: null, savedAt: now },
        ],
        // Ada's draft, started from version 3 before Bo saved 4.
        drafts: new Map([
            [ACME_OPEN_VIEW, { ...W.viewDraftSaved[0].draft, baseVersion: W.viewDraftRequest[0].baseVersion }],
        ]),
        me: 'u_ada',
        generation,
        stamp: parseStamp(rows.at(-1)!.stamp)!.value,
        edited: true,
        created: new Map(),
        remote: {
            row: {
                key: ACME_CONFLICT_ROW,
                row: conflictRow,
                field: W.cellConflict[0].field,
                error: W.cellConflict[0].error,
            },
            field: {
                name: 'status',
                entry: {
                    ...status,
                    settings: {
                        options: [
                            ...(status.settings.options ?? []),
                            { id: 'opt_blocked', label: 'Blocked', color: 'red' },
                        ],
                    },
                    version: status.version + 1,
                },
            },
        },
    };
}

export interface FixtureSourceOptions {
    readonly fixtures?: readonly ViewFixture[];
    /** Now, for relative dates and `at`; the fixtures' own by default, so their expectations hold. */
    readonly now?: number;
}

export function createFixtureViewSource(options: FixtureSourceOptions = {}): ViewSource {
    const fixtures = options.fixtures ?? VIEW_FIXTURES;
    const now = options.now ?? FIXTURE_CONTEXT.now;
    const tables = [bookingsTable(fixtures, now), acmeTable(now)];
    const uploads: number[] = [];
    let uploadCount = 0;

    const tableOf = (ref: Pick<TableRef, 'datasetId'> & { table?: string }) => {
        const table = tables.find(
            (t) => t.ref.datasetId === ref.datasetId && (ref.table === undefined || t.ref.table === ref.table),
        );
        if (table === undefined) {
            throw new Error(`No fixture table ${ref.datasetId}/${ref.table ?? ''}.`);
        }
        return table;
    };
    const viewOf = (table: FixtureTable, viewId: string) => {
        const view = table.views.find((v) => v.definition.id === viewId);
        if (view === undefined) {
            throw new Error(`No fixture view ${viewId}.`);
        }
        return view;
    };
    const ctxOf = (table: FixtureTable) => ({
        fields: fieldsOf(table),
        timeZone: FIXTURE_CONTEXT.timeZone,
        me: table.me,
        now,
    });
    /** The people and files a row's values name, as a write's answer carries them. */
    const mentions = (table: FixtureTable, row: ViewRow) => {
        const users: Record<string, ViewUser> = {};
        const files: Record<string, ViewFile> = {};
        for (const field of fieldsOf(table)) {
            for (const id of cellItems(row.values[field.field])) {
                if ((field.kind === 'person' || field.kind === 'people') && table.users[String(id)]) {
                    users[String(id)] = table.users[String(id)]!;
                }
                if (field.kind === 'file' && table.files[String(id)]) {
                    files[String(id)] = table.files[String(id)]!;
                }
            }
        }
        return { users, files };
    };
    const written = (table: FixtureTable, row: ViewRow): RowWritten => ({ schema: 1, row, ...mentions(table, row) });

    /** The rows a view matches, in its order (every one, before a page's limit). */
    function matching(table: FixtureTable, stored: StoredView, view: ViewDefinition): ViewRow[] {
        const reading = readViewDefinition(view, 'phone');
        const fields = fieldsOf(table);
        const ctx = ctxOf(table);
        const sent = new Set((stored.fixture?.page.rows ?? table.rows).map((row) => row.key));
        const filter = reading.readOnly.filter ? undefined : (view.query.filter as FilterNode | undefined);
        let rows = table.rows.filter((row) => {
            if (reading.readOnly.filter) {
                return sent.has(row.key);
            }
            const match = matchesFilter(row.values, filter, ctx);
            return match === undefined ? sent.has(row.key) : match;
        });
        const sort = view.query.sort as QuerySort[] | undefined;
        if (sortIsEvaluable(sort, fields)) {
            rows = [...rows].sort((a, b) => compareRows(a, b, sort, { ...ctx, users: table.users }));
        }
        return rows;
    }

    function compute(
        table: FixtureTable,
        stored: StoredView,
        view: ViewDefinition,
        request: ViewRowsRequest,
        draftUsed: boolean,
    ): ViewRowsPage {
        const reading = readViewDefinition(view, 'phone');
        const fields = fieldsOf(table);
        let rows = matching(table, stored, view);
        const sort = view.query.sort as QuerySort[] | undefined;
        const dateField = view.options.dateField;
        const endField = view.options.endField;
        if (reading.layout === 'calendar' && request.range !== undefined && dateField !== undefined) {
            const { from, to } = request.range;
            const field = fields.find((f) => f.field === dateField);
            const dayOf = (value: unknown) =>
                field?.kind === 'date' ? cellDay(value) : dayIn(cellInstant(value), FIXTURE_CONTEXT.timeZone);
            rows = rows.filter((row) => {
                const start = dayOf(row.values[dateField]);
                const end = endField === undefined ? start : (dayOf(row.values[endField]) ?? start);
                return start !== undefined && start <= to && (end ?? start) >= from;
            });
        }
        const visible = visibleFields(view, fields);
        const pageFields = visible.map((name) => fields.find((f) => f.field === name)!).filter(Boolean);
        let pageRows: ViewRow[] = rows;
        let groups: ViewGroup[] | undefined;
        const groupField = fields.find((f) => f.field === view.options.groupField);
        if (reading.layout === 'board' && groupField !== undefined) {
            const columns = boardColumns(view, groupField);
            const known = new Set(columns.map((c) => groupKey(c.value)));
            const valueOf = (row: ViewRow): string | null => {
                const raw = row.values[groupField.field];
                const key =
                    groupField.kind === 'checkbox'
                        ? String(isChecked(raw))
                        : raw === null || raw === undefined || raw === ''
                          ? null
                          : String(raw);
                return key !== null && known.has(key) ? key : null;
            };
            const sum =
                view.totals !== undefined
                    ? Object.keys(view.totals).find((k) => view.totals?.[k] === 'sum')
                    : undefined;
            groups = columns.map((column) => {
                const key = groupKey(column.value);
                const members = rows.filter((row) => valueOf(row) === key);
                const label =
                    column.value === null
                        ? `No ${groupField.label}`
                        : groupField.kind === 'checkbox'
                          ? column.value === true
                              ? 'Checked'
                              : 'Unchecked'
                          : (groupField.settings.options?.find((o) => o.id === column.value)?.label ??
                            String(column.value));
                return {
                    key,
                    label,
                    count: members.length,
                    ...(sum === undefined ? {} : { totals: { [sum]: total(members, sum, 'sum') } }),
                    next: null,
                    folded: column.hidden,
                };
            });
            const shown = new Set(columns.filter((c) => !c.hidden).map((c) => groupKey(c.value)));
            pageRows = rows
                .filter((row) =>
                    request.group !== undefined ? valueOf(row) === request.group : shown.has(valueOf(row)),
                )
                .map((row) => ({ ...row, group: valueOf(row) }));
            // In column order, each column's cards in the view's sort.
            const order = columns.map((c) => groupKey(c.value));
            pageRows = [...pageRows].sort((a, b) => order.indexOf(a.group ?? null) - order.indexOf(b.group ?? null));
        }
        // A date-ordered view opens at today: the page starts at the first row on or after it.
        let opensAt: { group: string | null; row: string } | undefined;
        const first = sort?.[0];
        const firstField = first === undefined ? undefined : fields.find((f) => f.field === first.field);
        if (request.around === 'today' && firstField !== undefined && (first?.dir ?? 'asc') === 'asc') {
            const today = dayIn(now, FIXTURE_CONTEXT.timeZone) ?? '';
            const dayOfRow = (row: ViewRow) =>
                firstField.kind === 'date'
                    ? cellDay(row.values[firstField.field])
                    : dayIn(cellInstant(row.values[firstField.field]), FIXTURE_CONTEXT.timeZone);
            const at = pageRows.findIndex((row) => (dayOfRow(row) ?? '') >= today);
            if (at > 0) {
                opensAt = { group: null, row: pageRows[at]!.key };
                pageRows = pageRows.slice(at);
            }
        }
        const limit = rowsLimit(reading.layout, request.limit);
        const totals =
            view.totals === undefined || reading.readOnly.totals
                ? undefined
                : Object.fromEntries(Object.entries(view.totals).map(([field, op]) => [field, total(rows, field, op)]));
        return {
            schema: 1,
            viewId: view.id,
            viewVersion: view.version,
            draftUsed,
            datasetToken: token(table),
            fields: pageFields,
            compact: resolveCompact(view, fields),
            rows: pageRows.slice(0, limit),
            ...(groups === undefined ? {} : { groups }),
            ...(totals === undefined ? {} : { totals }),
            users: { ...stored.fixture?.page.users, ...table.users },
            files: { ...stored.fixture?.page.files, ...table.files },
            next: null,
            ...(opensAt === undefined ? {} : { opensAt }),
            ...(request.range === undefined || dateField === undefined
                ? {}
                : {
                      range: {
                          ...request.range,
                          dateField,
                          ...(endField === undefined ? {} : { endField }),
                          timeZone: FIXTURE_CONTEXT.timeZone,
                      },
                  }),
            truncated: pageRows.length > limit,
            at: now,
        };
    }

    /** Applies someone else's pending change to a row, the first time the phone writes it. */
    const landRemoteRow = (table: FixtureTable, key: string) => {
        const remote = table.remote.row;
        if (remote === undefined || remote.key !== key) {
            return undefined;
        }
        delete table.remote.row;
        table.rows = table.rows.map((row) =>
            row.key === key
                ? { ...row, stamp: remote.row.stamp, values: { ...row.values, ...remote.row.values } }
                : row,
        );
        table.edited = true;
        return remote;
    };

    /** A value a write sets, checked against the field's kind as the server does. */
    function valueProblem(table: FixtureTable, field: FieldDisplay, value: WriteCell): string | null {
        if (value === null) {
            return null;
        }
        const items = cellItems(value).map(String);
        switch (field.kind) {
            case 'select':
            case 'multi_select': {
                const ids = new Set((field.settings.options ?? []).map((o) => o.id));
                const bad = items.find((id) => !ids.has(id));
                return bad === undefined ? null : `"${bad}" is not an option of ${field.label}.`;
            }
            case 'person':
            case 'people': {
                const bad = items.find((id) => table.users[id] === undefined);
                return bad === undefined ? null : `"${bad}" is not a person in this workspace.`;
            }
            case 'file': {
                const bad = items.find((id) => table.files[id] === undefined);
                return bad === undefined ? null : `"${bad}" is not a file of this dataset.`;
            }
            case 'date':
                return typeof value === 'string' && cellDay(value) === value ? null : `${field.label} takes a date.`;
            case 'datetime':
                return cellInstant(value) === undefined ? `${field.label} takes a date and time.` : null;
            case 'number':
            case 'currency':
            case 'percent':
                return typeof value === 'number' ? null : `${field.label} takes a number.`;
            default:
                return null;
        }
    }

    const invalid = (problems: Array<{ path: string; message: string }>, error = W.invalidWrite[0].error) =>
        ({
            outcome: 'refused',
            status: 400,
            code: 'invalid',
            error,
            body: { error, code: 'invalid', problems },
        }) as const satisfies Refused;

    return {
        live: false,
        async list(ref): Promise<ViewListResponse> {
            const table = tableOf(ref);
            return {
                ...table.list,
                fields: fieldsOf(table),
                views: table.views.map((stored) => ({
                    ...stored.fixture?.list.views[0],
                    id: stored.definition.id,
                    name: stored.definition.name,
                    layout: stored.definition.layout,
                    visibility: stored.definition.visibility,
                    version: stored.definition.version,
                    hasDraft: table.drafts.has(stored.definition.id),
                })),
                lastUsedViewId: table.views[0]!.definition.id,
            };
        },
        async definition(ref, viewId): Promise<ViewDefinitionResponse> {
            const table = tableOf(ref);
            const stored = viewOf(table, viewId);
            const draft = table.drafts.get(viewId);
            return {
                ...(stored.fixture?.definition ?? { schema: 1, skipped: [] }),
                view: stored.definition,
                fields: fieldsOf(table),
                ...(draft === undefined ? {} : { draft }),
            };
        },
        async rows(ref, viewId, request) {
            const table = tableOf(ref);
            const stored = viewOf(table, viewId);
            const draft = table.drafts.get(viewId);
            const useDraft = request.useDraft !== false && draft !== undefined;
            const fixture = stored.fixture;
            if (
                fixture !== undefined &&
                !table.edited &&
                !useDraft &&
                stored.definition === fixture.definition.view &&
                sameRequest(request, fixture.request)
            ) {
                return { ...fixture.page, at: now };
            }
            return compute(table, stored, useDraft ? draft.definition : stored.definition, request, useDraft);
        },
        async index(ref, viewId, request): Promise<ViewIndexPage> {
            const page = await this.rows(ref, viewId, request);
            return {
                schema: 1,
                viewId,
                viewVersion: page.viewVersion,
                datasetToken: page.datasetToken,
                entries: page.rows.map((row) => ({ key: row.key, stamp: row.stamp ?? '' })),
                next: null,
            };
        },
        async lookup(ref, keys): Promise<RowLookup> {
            const table = tableOf(ref);
            const wanted = new Set(keys);
            return {
                schema: 1,
                token: token(table),
                rows: table.rows.filter((row) => wanted.has(row.key)),
                users: table.users,
                files: table.files,
            };
        },
        async changes(ref, since): Promise<RowChanges> {
            const table = tableOf(ref);
            const from = parseStamp(since);
            if (from === undefined || from.generation !== table.generation) {
                return { schema: 1, token: token(table), reconcile: true, upserts: [], deleted: [], next: null };
            }
            const upserts = table.rows.filter((row) => (parseStamp(row.stamp)?.value ?? 0) > from.value);
            return { schema: 1, token: token(table), upserts, deleted: [], next: null };
        },
        async fields(ref) {
            const table = tableOf(ref);
            const canEdit = table.list.rights.write && table.list.rights.writtenBy === undefined;
            return { schema: 1, canEdit, fields: table.settings.filter((s) => canEdit || !s.missing) };
        },
        async people() {
            const people = new Map<string, { id: string; name: string; avatar: string | null }>();
            for (const person of W.peopleDirectory[0].people) {
                people.set(person.id, person);
            }
            for (const [id, user] of Object.entries(BOOKINGS_USERS)) {
                if (user.active) {
                    people.set(id, { id, name: user.name, avatar: user.avatar });
                }
            }
            const sorted = [...people.values()].sort(
                (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
            );
            return { schema: 1, people: sorted };
        },
        async lookupPeople(ids) {
            const known: Record<string, ViewUser> = { ...BOOKINGS_USERS, ...W.peopleLookup[0].users };
            return {
                schema: 1,
                users: Object.fromEntries(ids.filter((id) => known[id] !== undefined).map((id) => [id, known[id]!])),
            };
        },

        async saveDraft(ref, viewId, definition, baseVersion) {
            const table = tableOf(ref);
            viewOf(table, viewId);
            if (definition.id !== viewId || definition.dataset !== ref.datasetId || definition.table !== ref.table) {
                return invalid([{ path: '$.definition.id', message: 'A draft is of its route’s view.' }]);
            }
            const draft = { definition, baseVersion, updatedAt: now };
            table.drafts.set(viewId, draft);
            return { outcome: 'saved', saved: { schema: 1, draft } };
        },
        async dropDraft(ref, viewId) {
            tableOf(ref).drafts.delete(viewId);
            return { outcome: 'saved' };
        },
        async saveView(ref, viewId, definition, baseVersion, overwrite): Promise<ViewSaveResult> {
            const table = tableOf(ref);
            const stored = viewOf(table, viewId);
            if (viewId === 'default') {
                return invalid([
                    { path: '$.definition.id', message: 'The default view isn’t stored: save it as a new view.' },
                ]);
            }
            if (stored.definition.visibility !== 'personal' && !table.list.rights.saveShared) {
                return refusalByCode('read_only', 403);
            }
            if (stored.definition.version !== baseVersion) {
                const [fixture] = W.viewConflict;
                const savedBy = stored.savedBy;
                const name = savedBy === null ? 'Someone' : (table.users[savedBy]?.name ?? 'Someone');
                return {
                    outcome: 'conflict',
                    conflict: {
                        error:
                            savedBy === fixture.savedBy
                                ? fixture.error
                                : `${name} saved this view after you started changing it.`,
                        code: 'view_conflict',
                        current: stored.definition,
                        diff: diffViews(definition, stored.definition),
                        savedBy,
                        savedAt: stored.savedAt,
                        users:
                            savedBy === null || table.users[savedBy] === undefined
                                ? {}
                                : { [savedBy]: table.users[savedBy]! },
                    },
                };
            }
            void overwrite;
            stored.definition = { ...definition, id: viewId, version: baseVersion + 1 };
            stored.savedBy = table.me;
            stored.savedAt = now;
            table.drafts.delete(viewId);
            return { outcome: 'saved', saved: { schema: 1, view: stored.definition } };
        },
        async createView(ref, definition: NewViewDefinition, fromDraft) {
            const table = tableOf(ref);
            if (definition.visibility !== 'personal' && !table.list.rights.saveShared) {
                return refusalByCode('read_only', 403);
            }
            if (definition.name.trim() === '') {
                return invalid([{ path: '$.definition.name', message: 'A view needs a name.' }]);
            }
            const firstAcme =
                table === tables[1] && !table.views.some((v) => v.definition.id === W.viewSaved[1].view.id);
            const id = firstAcme ? W.viewSaved[1].view.id : `v_new_${table.views.length + 1}`;
            const view = { ...definition, id, version: 1 } as ViewDefinition;
            table.views.push({ definition: view, savedBy: table.me, savedAt: now });
            if (fromDraft !== undefined) {
                table.drafts.delete(fromDraft);
            }
            return { outcome: 'saved', saved: { schema: 1, view } };
        },
        async editCell(ref, key, edit: CellEdit): Promise<CellEditResult> {
            const table = tableOf(ref);
            const remote = landRemoteRow(table, key);
            const row = table.rows.find((r) => r.key === key);
            if (row === undefined) {
                return refusalByCode('row_gone', 404);
            }
            const field = fieldsOf(table).find((f) => f.field === edit.field);
            if (field === undefined || !field.editable || field.isKey || !table.list.rights.write) {
                return refusalByCode('read_only', 403);
            }
            const problem = valueProblem(table, field, edit.to);
            if (problem !== null) {
                return invalid([{ path: '$.to', message: problem }]);
            }
            const current = (row.values[edit.field] ?? null) as Cell;
            if (sameJson(current, edit.to)) {
                return { outcome: 'saved', written: written(table, row) };
            }
            if (!sameJson(current, edit.from ?? null)) {
                const conflict: CellConflict = {
                    error:
                        remote?.field === edit.field
                            ? remote.error
                            : `Someone changed ${field.label} since you read it.`,
                    code: 'cell_conflict',
                    field: edit.field,
                    current,
                    ...written(table, row),
                };
                return { outcome: 'conflict', conflict };
            }
            table.stamp += 1;
            const next: ViewRow = { ...row, stamp: token(table), values: { ...row.values, [edit.field]: edit.to } };
            table.rows = table.rows.map((r) => (r.key === key ? next : r));
            table.edited = true;
            return { outcome: 'saved', written: written(table, next) };
        },
        async createRow(ref, values, createId): Promise<RowCreateResult> {
            const table = tableOf(ref);
            const { rights, table: about } = table.list;
            if (!rights.write || rights.writtenBy !== undefined || !about.hasKey || about.analytical) {
                return refusalByCode('read_only', 403);
            }
            if (createId !== undefined) {
                const made = table.created.get(createId);
                const row = made === undefined ? undefined : table.rows.find((r) => r.key === made);
                if (row !== undefined) {
                    return { outcome: 'created', written: written(table, row), replayed: true };
                }
            }
            const fields = fieldsOf(table);
            const keys = table.settings.filter((s) => s.isKey);
            const assigned = keys.length === 1 && keys[0]!.type.toUpperCase() === 'INTEGER';
            const problems: Array<{ path: string; message: string }> = [];
            for (const [name, value] of Object.entries(values)) {
                const field = fields.find((f) => f.field === name);
                if (field === undefined) {
                    problems.push({ path: `$.values.${name}`, message: `This table has no field "${name}".` });
                    continue;
                }
                const problem = field.isKey ? null : valueProblem(table, field, value);
                if (problem !== null) {
                    problems.push({ path: `$.values.${name}`, message: problem });
                }
            }
            const empty = (value: unknown) => value === undefined || value === null || value === '';
            for (const field of fields) {
                if ((field.required && !field.isKey) || (field.isKey && !assigned)) {
                    if (empty(values[field.field])) {
                        problems.push({ path: `$.values.${field.field}`, message: `${field.label} is required.` });
                    }
                }
            }
            if (problems.length > 0) {
                const body = { error: W.invalidWrite[0].error, code: 'invalid' as const, problems };
                return { outcome: 'invalid', invalid: body };
            }
            let key: string;
            const keyValues: Record<string, Cell> = {};
            if (assigned) {
                const name = keys[0]!.field;
                const next = Math.max(0, ...table.rows.map((r) => Number(r.values[name]) || 0)) + 1;
                keyValues[name] = next;
                key = JSON.stringify(next);
            } else {
                const parts = keys.map((k) => values[k.field] as Cell);
                key = JSON.stringify(parts.length === 1 ? parts[0] : parts);
                if (table.rows.some((r) => r.key === key)) {
                    return refusal(
                        W.writeRefusal.find((r) => r.code === 'key_taken')!,
                        409,
                    );
                }
            }
            table.stamp += 1;
            const blank = Object.fromEntries(fields.map((f) => [f.field, null]));
            const row: ViewRow = { key, stamp: token(table), values: { ...blank, ...values, ...keyValues } };
            table.rows = [...table.rows, row];
            table.edited = true;
            if (createId !== undefined) {
                table.created.set(createId, key);
            }
            return { outcome: 'created', written: written(table, row), replayed: false };
        },
        async saveField(ref, name, save: FieldSave): Promise<FieldSaveResult> {
            const table = tableOf(ref);
            const canEdit = table.list.rights.write && table.list.rights.writtenBy === undefined;
            if (!canEdit) {
                return refusalByCode('read_only', 403);
            }
            const remote = table.remote.field;
            if (remote !== undefined && remote.name === name) {
                delete table.remote.field;
                table.settings = table.settings.map((s) => (s.field === name ? remote.entry : s));
            }
            const stored = table.settings.find((s) => s.field === name);
            if (stored === undefined || stored.missing) {
                return invalid([{ path: '$.field', message: 'This column isn’t in the table any more.' }]);
            }
            if (stored.version !== save.baseVersion) {
                const [fixture] = W.fieldConflict;
                return {
                    outcome: 'conflict',
                    conflict: { error: fixture.error, code: 'field_conflict', current: stored },
                };
            }
            if (!stored.kinds.includes(save.kind)) {
                return invalid([{ path: '$.kind', message: `A ${stored.type} column doesn’t take ${save.kind}.` }]);
            }
            const hadOptions = stored.kind === 'select' || stored.kind === 'multi_select';
            const hasOptions = save.kind === 'select' || save.kind === 'multi_select';
            if (hadOptions && hasOptions && save.confirmRemovedOptions !== true) {
                const kept = new Set((save.settings.options ?? []).map((o) => o.id));
                const inUse = (stored.settings.options ?? [])
                    .filter((o) => !kept.has(o.id))
                    .map((o) => ({
                        id: o.id,
                        label: o.label,
                        rows: table.rows.filter((r) => cellItems(r.values[name]).map(String).includes(o.id)).length,
                    }))
                    .filter((o) => o.rows > 0);
                if (inUse.length > 0) {
                    const rows = inUse.reduce((n, o) => n + o.rows, 0);
                    const labels = inUse.map((o) => o.label).join(', ');
                    return {
                        outcome: 'in-use',
                        inUse: {
                            error: `${rows} ${rows === 1 ? 'row uses' : 'rows use'} ${labels}. Remove ${inUse.length === 1 ? 'it' : 'them'} anyway?`,
                            code: 'options_in_use',
                            inUse,
                        },
                    };
                }
            }
            const next: FieldSettingEntry = {
                ...stored,
                kind: save.kind,
                label: save.label ?? stored.label,
                settings: settingsForKind(save.kind, save.settings),
                version: stored.version + 1,
            };
            table.settings = table.settings.map((s) => (s.field === name ? next : s));
            table.edited = true;
            return { outcome: 'saved', saved: { schema: 1, field: next } };
        },
        async uploadFile(datasetId, upload: DatasetUpload): Promise<UploadResult> {
            const table = tableOf({ datasetId });
            if (!table.list.rights.write) {
                return refusalByCode('read_only', 403);
            }
            const at = now + uploadCount;
            while (uploads.length > 0 && uploads[0]! < at - 60_000) {
                uploads.shift();
            }
            if (uploads.length >= DATASET_UPLOADS_PER_MINUTE) {
                return {
                    outcome: 'refused',
                    status: 429,
                    code: 'rate_limited',
                    error: 'Too many uploads.',
                    body: null,
                    retryAfterSeconds: 60,
                };
            }
            uploads.push(at);
            if (!(DATASET_FILE_TYPES as readonly string[]).includes(upload.type ?? '')) {
                return refusalByCode('unsupported_file', 415);
            }
            if (upload.bytes > FIXTURE_FILE_MAX) {
                return {
                    outcome: 'refused',
                    status: 413,
                    code: 'file_too_large',
                    error: 'This file is larger than this dataset takes.',
                    body: { error: 'This file is larger than this dataset takes.', code: 'file_too_large' },
                };
            }
            uploadCount += 1;
            const [fixture] = W.datasetFileUploaded;
            const id =
                table === tables[1] && table.files[fixture.file.id] === undefined
                    ? fixture.file.id
                    : `f_${datasetId}_${uploadCount}`;
            const file = {
                id,
                name: upload.name,
                size: upload.bytes,
                type: upload.type!,
                thumb: upload.type!.startsWith('image/'),
            };
            const { id: _id, ...entry } = file;
            for (const t of tables.filter((t) => t.ref.datasetId === datasetId)) {
                t.files = { ...t.files, [id]: entry };
            }
            return { outcome: 'uploaded', uploaded: { schema: 1, file } };
        },
        async exportCsv(ref, viewId, { useDraft, name }): Promise<ExportResult> {
            const table = tableOf(ref);
            const stored = viewOf(table, viewId);
            if (stored.exportRefusal === 'too_many_rows') {
                return { outcome: 'too-large', tooLarge: W.exportTooLarge[0] };
            }
            const draft = useDraft === false ? undefined : table.drafts.get(viewId);
            const view = draft?.definition ?? stored.definition;
            const fields = fieldsOf(table);
            const shown = visibleFields(view, fields)
                .map((field) => fields.find((f) => f.field === field)!)
                .filter(Boolean);
            const ctx = { locale: 'en-US', timeZone: FIXTURE_CONTEXT.timeZone, users: table.users, files: table.files };
            const LIST_KINDS = new Set(['multi_select', 'people', 'file']);
            const cell = (row: ViewRow, field: FieldDisplay) =>
                LIST_KINDS.has(field.kind)
                    ? cellItems(row.values[field.field])
                          .map((item) => formatCell([item], field, ctx))
                          .join(EXPORT_LIST_SEPARATOR)
                    : formatCell(row.values[field.field], field, ctx);
            const lines = [
                shown.map((f) => csvField(f.label)).join(','),
                ...matching(table, stored, view).map((row) => shown.map((f) => csvField(cell(row, f))).join(',')),
            ];
            return { outcome: 'csv', name: `${name}.csv`, text: `﻿${lines.join('\r\n')}\r\n` };
        },
    };
}

const sameRequest = (a: ViewRowsRequest, b: ViewRowsRequest) => {
    const strip = ({ schema: _schema, ...rest }: ViewRowsRequest) => rest;
    return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
};

/** A column total over `rows`: count, filled, empty, or a number kind's sum, avg, min and max. */
export function total(rows: readonly ViewRow[], field: string, op: string): Cell {
    const values = rows.map((row) => row.values[field]);
    const filled = values.filter((v) => v !== null && v !== undefined && v !== '' && cellItems(v).length > 0);
    const numbers = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    switch (op) {
        case 'count':
            return rows.length;
        case 'filled':
            return filled.length;
        case 'empty':
            return rows.length - filled.length;
        case 'sum':
            return numbers.length === 0 ? null : numbers.reduce((a, b) => a + b, 0);
        case 'avg':
            return numbers.length === 0 ? null : numbers.reduce((a, b) => a + b, 0) / numbers.length;
        case 'min':
            return numbers.length === 0 ? null : Math.min(...numbers);
        case 'max':
            return numbers.length === 0 ? null : Math.max(...numbers);
        default:
            return null;
    }
}

/** The calendar day an instant falls on in `timeZone`, `YYYY-MM-DD`. */
export function dayIn(at: number | undefined, timeZone: string): string | undefined {
    if (at === undefined) {
        return undefined;
    }
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(at);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
}
