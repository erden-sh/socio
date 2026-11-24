/**
 * The table every view fixture reads (CB-451): a `bookings`
 * table with a field of most kinds, five rows that exercise empties,
 * an option the field no longer has, a file outside the dataset's
 * attachments, an offset-less datetime and a deactivated person, and
 * the context (locale, zone, now, viewer) every expectation is computed in.
 *
 * Plain JSON only: a client may load these through any JSON reader.
 */
import type { FieldDisplay, ViewDefinitionResponse, ViewListResponse, ViewRow, ViewSummary } from '../contract.js';
import type { ViewDefinition } from '../definition.js';

/** What every expectation is computed in: Saturday, November 21, 2026, 10:00 in New York. */
export const FIXTURE_CONTEXT = {
    locale: 'en-US',
    timeZone: 'America/New_York',
    /** 2026-11-21T15:00:00Z. */
    now: 1_795_273_200_000,
    me: 'u_ana',
} as const;

export const FIXTURE_GENERATION = 'k7Hq2mZ0aB9xYw4L';
export const FIXTURE_TOKEN = `${FIXTURE_GENERATION}.1042`;

const field = (name: string, label: string, kind: string, extra: Partial<FieldDisplay> = {}): FieldDisplay => ({
    field: name,
    label,
    kind,
    fallback: 'text',
    editable: true,
    required: false,
    isKey: false,
    settings: {},
    ...extra,
});

/** Every field of `bookings`, in column order. */
export const BOOKINGS_FIELDS: FieldDisplay[] = [
    field('id', 'ID', 'id', { editable: false, required: true, isKey: true }),
    field('title', 'Title', 'text', { required: true }),
    field('room', 'Room', 'select', {
        settings: {
            options: [
                { id: 'opt_a', label: 'Room A', color: 'blue' },
                { id: 'opt_b', label: 'Room B', color: 'green' },
                { id: 'opt_c', label: 'Roof', color: 'orange' },
            ],
        },
    }),
    field('starts_at', 'Starts', 'datetime', { settings: { dateFormat: 'datetime' } }),
    field('ends_at', 'Ends', 'datetime', { settings: { dateFormat: 'datetime' } }),
    field('day', 'Day', 'date', { settings: { dateFormat: 'date' } }),
    field('amount', 'Amount', 'currency', { fallback: 'number', settings: { currency: 'USD', minorUnits: true } }),
    field('share', 'Share', 'percent', { fallback: 'number', settings: { decimals: 1 } }),
    field('guests', 'Guests', 'number', { fallback: 'number', settings: { decimals: 0, unit: 'people' } }),
    field('done', 'Done', 'checkbox'),
    field('owner', 'Owner', 'person', { settings: { allowSocios: false } }),
    field('team', 'Team', 'people'),
    field('tags', 'Tags', 'multi_select', {
        settings: {
            options: [
                { id: 't_x', label: 'External', color: 'red' },
                { id: 't_y', label: 'Catering', color: 'yellow' },
            ],
        },
    }),
    field('photo', 'Photo', 'file'),
    field('notes', 'Notes', 'long_text'),
    field('meta', 'Meta', 'json', { fallback: 'json', editable: false }),
];

/** Every row of `bookings`, in key order, all fields. */
export const BOOKINGS_ROWS: ViewRow[] = [
    {
        key: '"b1"',
        stamp: `${FIXTURE_GENERATION}.1001`,
        values: {
            id: 'b1',
            title: 'Standup',
            room: 'opt_a',
            starts_at: '2026-11-23T14:00:00Z',
            ends_at: '2026-11-23T14:30:00Z',
            day: '2026-11-23',
            amount: 12550,
            share: 0.125,
            guests: 6,
            done: true,
            owner: 'u_ana',
            team: ['u_ana', 'u_ben'],
            tags: ['t_x'],
            photo: 'f_1',
            notes: 'Bring the =SUM(A1) sheet',
            meta: '{"source":"import"}',
        },
    },
    {
        key: '"b2"',
        stamp: `${FIXTURE_GENERATION}.1017`,
        values: {
            id: 'b2',
            title: 'Board review',
            room: 'opt_b',
            starts_at: '2026-11-24T19:00:00Z',
            ends_at: '2026-11-24T21:00:00Z',
            day: '2026-11-24',
            amount: 0,
            share: 1,
            guests: 12,
            done: false,
            owner: 'u_ben',
            team: [],
            tags: [],
            photo: null,
            notes: null,
            meta: null,
        },
    },
    {
        key: '"b3"',
        stamp: `${FIXTURE_GENERATION}.990`,
        values: {
            id: 'b3',
            title: 'lunch',
            room: null,
            starts_at: '2026-11-20T17:00:00Z',
            ends_at: null,
            day: '2026-11-20',
            amount: null,
            share: null,
            guests: null,
            done: null,
            owner: null,
            team: '["u_cam"]',
            tags: '["t_x","t_y"]',
            photo: 'f_gone',
            notes: '',
            meta: null,
        },
    },
    {
        key: '"b4"',
        stamp: `${FIXTURE_GENERATION}.1040`,
        values: {
            id: 'b4',
            title: 'Offsite',
            room: 'opt_old',
            starts_at: '2026-12-01 15:00:00',
            ends_at: '2026-12-03 15:00:00',
            day: '2026-12-01',
            amount: 99900,
            share: 0.5,
            guests: 40,
            done: 1,
            owner: 'u_ana',
            team: ['u_cam'],
            tags: ['t_y'],
            photo: 'f_2',
            notes: 'Two nights',
            meta: '{"budget":true}',
        },
    },
    {
        key: '"b5"',
        stamp: `${FIXTURE_GENERATION}.1041`,
        values: {
            id: 'b5',
            title: 'Retro',
            room: 'opt_c',
            starts_at: 1_795_618_800_000,
            ends_at: null,
            day: null,
            amount: 2500,
            share: 0,
            guests: 8,
            done: false,
            owner: 'u_cam',
            team: ['u_ben'],
            tags: ['t_x', 't_y'],
            photo: null,
            notes: 'retro board',
            meta: null,
        },
    },
];

/** The page maps every fixture sends: a deactivated person and a file outside the namespace (absent). */
export const BOOKINGS_USERS = {
    u_ana: { name: 'Ana Ruiz', avatar: null, active: true },
    u_ben: { name: 'Ben Okafor', avatar: '/api/people/u_ben/avatar', active: true },
    u_cam: { name: 'Cam Lee', avatar: null, active: false },
};
export const BOOKINGS_FILES = {
    f_1: { name: 'room-a.jpg', size: 48_213, type: 'image/jpeg', thumb: true },
    f_2: { name: 'agenda.pdf', size: 120_044, type: 'application/pdf', thumb: false },
};

/** The fields of `BOOKINGS_FIELDS` with these names, in this order: a page's `fields`. */
export const fieldsNamed = (names: readonly string[]): FieldDisplay[] =>
    names.map((name) => {
        const found = BOOKINGS_FIELDS.find((f) => f.field === name);
        if (!found) {
            throw new Error(`No fixture field ${name}.`);
        }
        return found;
    });

/** The rows of `BOOKINGS_ROWS` with these keys, in this order, optionally under a group. */
export const rowsKeyed = (keys: readonly string[], group?: (row: ViewRow) => string | null): ViewRow[] =>
    keys.map((key) => {
        const found = BOOKINGS_ROWS.find((r) => r.key === key);
        if (!found) {
            throw new Error(`No fixture row ${key}.`);
        }
        return group ? { ...found, group: group(found) } : found;
    });

/** `GET …/views` for a fixture's view. */
export const listFor = (view: ViewDefinition, extra: Partial<ViewSummary> = {}): ViewListResponse => ({
    schema: 1,
    dataset: { id: 'ds_events', name: 'Events', spaceId: 'sp_ops', version: 1_795_300_000_000 },
    table: { name: 'bookings', title: 'Bookings', hasKey: true, analytical: false },
    rights: { read: true, write: true, saveShared: false },
    fields: BOOKINGS_FIELDS,
    views: [
        {
            id: view.id,
            name: view.name,
            layout: view.layout,
            visibility: view.visibility,
            version: view.version,
            hasDraft: false,
            ...extra,
        },
    ],
    lastUsedViewId: view.id,
});

/** `GET …/views/:viewId` for a fixture's view. */
export const definitionFor = (view: ViewDefinition): ViewDefinitionResponse => ({
    schema: 1,
    view,
    skipped: [],
    fields: BOOKINGS_FIELDS,
});

/** The fields a person who may write `bookings` edits in place: every one but the key and the `json` field. */
export const EDITABLE_WITH_WRITE = [
    'title',
    'room',
    'starts_at',
    'ends_at',
    'day',
    'amount',
    'share',
    'guests',
    'done',
    'owner',
    'team',
    'tags',
    'photo',
    'notes',
];
