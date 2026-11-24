/**
 * The write contract's fixtures (CB-451): one request and one
 * answer for every write, picker and export shape, and every refusal a
 * client acts on. Both clients parse each one with the schema it names
 * (`tests/dataset-views-writes.test.ts` is the reference run): a parse
 * changes nothing, and `diffViews(mine, theirs)` gives `VIEW_CONFLICT`'s
 * `diff`.
 *
 * An `Acme tasks` table: an integer key the server assigns, a title, a
 * status select, an owner, an attachment and a due date. Ada is active;
 * Bo is deactivated, named but never offered in a picker.
 *
 * Plain JSON only: a client may load these through any JSON reader.
 */
import type {
    CellConflict,
    CellEditRequest,
    DatasetFileUploaded,
    ExportTooLarge,
    FieldConflict,
    FieldSettingEntry,
    FieldSettingsRequest,
    FieldSettingsResponse,
    FieldSettingsSaved,
    InvalidWrite,
    OptionsInUse,
    PeopleDirectory,
    PeopleLookup,
    PeopleLookupRequest,
    RowCreateRequest,
    RowWritten,
    ViewConflict,
    ViewCreateRequest,
    ViewDraftRequest,
    ViewDraftSaved,
    ViewSaved,
    ViewSaveRequest,
    WriteRefusal,
} from '../contract.js';
import type { ViewDefinition } from '../definition.js';

export const ACME_DATASET = 'ds_acme';
export const ACME_TABLE = 'tasks';
const GENERATION = 'Ac3eT9skQ2wR7yU1';

export const ACME_USERS = {
    u_ada: { name: 'Ada', avatar: null, active: true },
    u_bo: { name: 'Bo', avatar: null, active: false },
};
export const ACME_FILES = {
    f_acme_1: { name: 'acme-brief.pdf', size: 52_114, type: 'application/pdf', thumb: false },
};

/** The shared view as stored now: version 4, saved by Bo after Ada's draft started from 3. */
export const ACME_THEIRS: ViewDefinition = {
    schema: 1,
    id: 'v_acme_open',
    dataset: ACME_DATASET,
    table: ACME_TABLE,
    name: 'Open tasks',
    layout: 'table',
    query: {
        filter: { field: 'status', op: 'is_not', value: 'opt_done' },
        sort: [{ field: 'due', dir: 'asc' }],
    },
    fields: [{ field: 'title', width: 240 }, { field: 'status' }, { field: 'due' }, { field: 'owner' }],
    options: {},
    visibility: 'dataset',
    version: 4,
};

/** Ada's draft: another sort, the owner first and hidden notes, and an option key from a newer release kept as sent. */
export const ACME_MINE: ViewDefinition = {
    schema: 1,
    id: 'v_acme_open',
    dataset: ACME_DATASET,
    table: ACME_TABLE,
    name: 'Open tasks',
    layout: 'table',
    query: {
        filter: { field: 'status', op: 'is_not', value: 'opt_done' },
        sort: [{ field: 'title', dir: 'asc' }],
    },
    fields: [
        { field: 'owner', priority: 1 },
        { field: 'title', width: 240 },
        { field: 'status' },
        { field: 'notes', hidden: true },
    ],
    options: { rowHeight: 'tall' },
    visibility: 'dataset',
    version: 3,
};

const statusEntry: FieldSettingEntry = {
    field: 'status',
    label: 'Status',
    kind: 'select',
    fallback: 'text',
    editable: true,
    required: false,
    isKey: false,
    settings: {
        options: [
            { id: 'opt_todo', label: 'To do', color: 'gray' },
            { id: 'opt_doing', label: 'Doing', color: 'blue' },
            { id: 'opt_done', label: 'Done', color: 'green' },
        ],
    },
    type: 'TEXT',
    kinds: ['text', 'long_text', 'select', 'multi_select', 'person', 'file', 'url', 'email', 'phone', 'date'],
    version: 2,
};

const row = (stamp: number, values: Record<string, unknown>) => ({
    key: '1042',
    stamp: `${GENERATION}.${stamp}`,
    values: values as RowWritten['row']['values'],
});

const draftRequest: ViewDraftRequest = { schema: 1, definition: ACME_MINE, baseVersion: 3 };
const draftSaved: ViewDraftSaved = {
    schema: 1,
    draft: { definition: ACME_MINE, baseVersion: 3, updatedAt: 1_795_280_000_000 },
};
const saveRequest: ViewSaveRequest = { schema: 1, definition: ACME_MINE, baseVersion: 3 };
const keepMine: ViewSaveRequest = { schema: 1, definition: ACME_MINE, baseVersion: 4, overwrite: true };
const saved: ViewSaved = { schema: 1, view: { ...ACME_MINE, version: 5 } };
const { id: _id, version: _version, ...unsaved } = ACME_MINE;
const createRequest: ViewCreateRequest = {
    schema: 1,
    definition: { ...unsaved, name: 'Open tasks (Ada)', visibility: 'personal' },
    fromDraft: 'v_acme_open',
};
const created: ViewSaved = {
    schema: 1,
    view: { ...ACME_MINE, id: 'v_acme_ada', name: 'Open tasks (Ada)', visibility: 'personal', version: 1 },
};

const viewConflictAnswer: ViewConflict = {
    error: 'Bo saved this view after you started changing it.',
    code: 'view_conflict',
    current: ACME_THEIRS,
    diff: {
        parts: [
            { part: 'sort', mine: [{ field: 'title', dir: 'asc' }], theirs: [{ field: 'due', dir: 'asc' }] },
            { part: 'fields', mine: ACME_MINE.fields, theirs: ACME_THEIRS.fields },
            { part: 'options', mine: { rowHeight: 'tall' }, theirs: {} },
        ],
        fields: [
            {
                field: 'title',
                mine: { field: 'title', width: 240 },
                theirs: { field: 'title', width: 240 },
                moved: true,
            },
            { field: 'status', mine: { field: 'status' }, theirs: { field: 'status' }, moved: true },
            { field: 'due', mine: null, theirs: { field: 'due' }, moved: false },
            { field: 'owner', mine: { field: 'owner', priority: 1 }, theirs: { field: 'owner' }, moved: true },
            { field: 'notes', mine: { field: 'notes', hidden: true }, theirs: null, moved: false },
        ],
    },
    savedBy: 'u_bo',
    savedAt: 1_795_279_000_000,
    users: { u_bo: ACME_USERS.u_bo },
};

const cellEdit: CellEditRequest = { schema: 1, field: 'status', from: 'opt_todo', to: 'opt_doing' };
const cellEdited: RowWritten = {
    schema: 1,
    row: row(2210, { id: 1042, title: 'Ship the Acme brief', status: 'opt_doing', owner: 'u_ada', file: ['f_acme_1'] }),
    users: { u_ada: ACME_USERS.u_ada },
    files: ACME_FILES,
};
const cellConflictAnswer: CellConflict = {
    error: 'Someone changed Status since you read it.',
    code: 'cell_conflict',
    field: 'status',
    current: 'opt_done',
    row: row(2209, { id: 1042, title: 'Ship the Acme brief', status: 'opt_done', owner: 'u_bo', file: ['f_acme_1'] }),
    users: { u_bo: ACME_USERS.u_bo },
    files: ACME_FILES,
};

const rowCreate: RowCreateRequest = {
    schema: 1,
    values: { title: 'Call Acme', status: 'opt_todo', owner: 'u_ada', due: '2026-11-30', file: [] },
    createId: 'c7f1e2a4-acme-0001',
};
const rowCreated: RowWritten = {
    schema: 1,
    row: {
        key: '1043',
        stamp: `${GENERATION}.2211`,
        values: {
            id: 1043,
            title: 'Call Acme',
            status: 'opt_todo',
            owner: 'u_ada',
            due: '2026-11-30',
            file: [],
            notes: null,
        },
    },
    users: { u_ada: ACME_USERS.u_ada },
    files: {},
};
const rowInvalid: InvalidWrite = {
    error: 'This row can’t be saved as written.',
    code: 'invalid',
    problems: [
        { path: '$.values.title', message: 'Title is required.' },
        { path: '$.values.status', message: '"opt_gone" is not an option of Status.' },
    ],
};
const keyTaken: WriteRefusal = { error: 'A row with this key exists.', code: 'key_taken' };
const rowGone: WriteRefusal = { error: 'This row was deleted.', code: 'row_gone' };
const readOnly: WriteRefusal = { error: 'You can read this dataset but not change it.', code: 'read_only' };

const fieldSettings: FieldSettingsResponse = {
    schema: 1,
    canEdit: true,
    fields: [
        {
            field: 'id',
            label: 'ID',
            kind: 'id',
            fallback: 'number',
            editable: false,
            required: true,
            isKey: true,
            settings: {},
            type: 'INTEGER',
            kinds: ['id'],
            version: 0,
        },
        statusEntry,
        {
            field: 'budget',
            label: 'Budget',
            kind: 'currency',
            fallback: 'number',
            editable: false,
            required: false,
            isKey: false,
            settings: { currency: 'USD', minorUnits: true },
            type: '',
            kinds: [],
            version: 1,
            missing: true,
            declaredBy: 'plugin:acme-books',
        },
    ],
};
const fieldSave: FieldSettingsRequest = {
    schema: 1,
    kind: 'select',
    label: 'Status',
    settings: {
        options: [
            { id: 'opt_todo', label: 'To do', color: 'gray' },
            { id: 'opt_doing', label: 'In progress', color: 'blue' },
        ],
    },
    baseVersion: 2,
    confirmRemovedOptions: true,
};
const fieldSaved: FieldSettingsSaved = {
    schema: 1,
    field: {
        ...statusEntry,
        settings: { options: fieldSave.settings.options! },
        version: 3,
    },
};
const fieldConflictAnswer: FieldConflict = {
    error: 'Someone changed this field’s settings since you opened them.',
    code: 'field_conflict',
    current: statusEntry,
};
const optionsInUseAnswer: OptionsInUse = {
    error: '12 rows use Done. Remove it anyway?',
    code: 'options_in_use',
    inUse: [{ id: 'opt_done', label: 'Done', rows: 12 }],
};

const exportTooLargeAnswer: ExportTooLarge = {
    error: 'This view has 140,000 rows; export at most 100,000. Narrow the filter or export the table.',
    code: 'too_many_rows',
    rows: 140_000,
    limit: 100_000,
};

const directory: PeopleDirectory = {
    schema: 1,
    people: [{ id: 'u_ada', name: 'Ada', avatar: null }],
};
const peopleLookupRequestFixture: PeopleLookupRequest = { schema: 1, ids: ['u_ada', 'u_bo', 'socio:s_acme'] };
const peopleLookupAnswer: PeopleLookup = {
    schema: 1,
    users: { ...ACME_USERS, 'socio:s_acme': { name: 'Acme Helper', avatar: null, active: true } },
};

const uploaded: DatasetFileUploaded = {
    schema: 1,
    file: { id: 'f_acme_2', name: 'acme-logo.png', size: 8_204, type: 'image/png', thumb: true },
};
const unsupportedFile: WriteRefusal = {
    error: 'Datasets take images and PDFs.',
    code: 'unsupported_file',
};

/** Every write fixture, by the schema export (`../contract.ts`) that parses it. */
export const WRITE_FIXTURES = {
    viewDraftRequest: [draftRequest],
    viewDraftSaved: [draftSaved],
    viewSaveRequest: [saveRequest, keepMine],
    viewCreateRequest: [createRequest],
    viewSaved: [saved, created],
    viewConflict: [viewConflictAnswer],
    cellEditRequest: [cellEdit],
    rowCreateRequest: [rowCreate],
    rowWritten: [cellEdited, rowCreated],
    cellConflict: [cellConflictAnswer],
    invalidWrite: [rowInvalid],
    writeRefusal: [keyTaken, rowGone, readOnly, unsupportedFile],
    fieldSettingsResponse: [fieldSettings],
    fieldSettingsRequest: [fieldSave],
    fieldSettingsSaved: [fieldSaved],
    fieldConflict: [fieldConflictAnswer],
    optionsInUse: [optionsInUseAnswer],
    exportTooLarge: [exportTooLargeAnswer],
    peopleDirectory: [directory],
    peopleLookupRequest: [peopleLookupRequestFixture],
    peopleLookup: [peopleLookupAnswer],
    datasetFileUploaded: [uploaded],
} as const;

export type WriteFixtureName = keyof typeof WRITE_FIXTURES;

/** `diffViews(ACME_MINE, ACME_THEIRS)`, which a `409` carries. */
export const ACME_DIFF = viewConflictAnswer.diff;
