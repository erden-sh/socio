/**
 * A view from a newer release: an unknown layout, field kinds
 * this client doesn't know (with each fallback, and one fallback it
 * doesn't know either), an unknown filter operator and grouping bucket,
 * an unknown total, calendar mode and option key, unknown keys on the
 * definition and a field, a `degraded` answer and a skipped part. A
 * client opens it, shows every value, edits none of the unknown parts,
 * and sends the definition back exactly as it came.
 */
import type { Cell, FieldDisplay, ViewRow } from '../contract.js';
import type { ViewDefinition } from '../definition.js';

import {
    BOOKINGS_FIELDS,
    BOOKINGS_FILES,
    BOOKINGS_ROWS,
    BOOKINGS_USERS,
    EDITABLE_WITH_WRITE,
    FIXTURE_TOKEN,
    listFor,
} from './bookings.js';
import type { ViewFixture } from './types.js';

const later = (field: string, label: string, kind: string, fallback: string): FieldDisplay => ({
    field,
    label,
    kind,
    fallback,
    editable: true,
    required: false,
    isKey: false,
    settings: { stars: 5 },
});

const FIELDS: FieldDisplay[] = [
    ...BOOKINGS_FIELDS,
    later('rating', 'Rating', 'rating', 'number'),
    later('place', 'Place', 'geo', 'json'),
    later('mood', 'Mood', 'sparkle', 'glitter'),
    later('secret', 'Secret', 'vault', 'hidden'),
];

// Values of kinds a later release added may be any JSON.
const laterValues: Record<string, Record<string, unknown>> = {
    '"b1"': { rating: 4, place: { lat: 40.7, lng: -74 }, mood: 'calm', secret: 's3cr3t' },
    '"b2"': { rating: null, place: null, mood: ['busy', 'late'], secret: null },
};
const rows: ViewRow[] = BOOKINGS_ROWS.filter((r) => r.key in laterValues).map((r) => ({
    ...r,
    values: { ...r.values, ...(laterValues[r.key] as Record<string, Cell>) },
}));

const view: ViewDefinition = {
    schema: 1,
    id: 'v_future',
    dataset: 'ds_events',
    table: 'bookings',
    name: 'Timeline',
    layout: 'timeline',
    query: {
        filter: { all: [{ field: 'title', op: 'matches_regex', value: '^S' } as never] },
        sort: [{ field: 'title', dir: 'asc' }],
        groupBy: [{ field: 'starts_at', bucket: 'fortnight' } as never],
        pivot: { by: 'room' },
    },
    fields: [
        { field: 'title', pin: true },
        { field: 'rating', priority: 1 },
        { field: 'place' },
        { field: 'mood' },
        { field: 'secret' },
        { field: 'starts_at' },
    ],
    options: { titleField: 'title', calendarMode: 'year', swimlanes: { by: 'room', collapsed: ['opt_c'] } },
    totals: { rating: 'median' },
    visibility: 'dataset',
    version: 12,
    color: 'teal',
};

const visible = ['title', 'rating', 'place', 'mood', 'secret', 'starts_at'];

export const UNKNOWN_FIXTURE: ViewFixture = {
    name: 'unknown',
    about: 'Parts from a newer release: the view opens as a table (web) or a list (phone), shows every value by fallback, and round-trips unchanged.',
    fields: FIELDS,
    list: { ...listFor(view), fields: FIELDS, layouts: ['timeline'] },
    definition: {
        schema: 1,
        degraded: true,
        view,
        skipped: [{ path: '$.fields[6]', message: 'The column "legacy" was dropped; this field is skipped.' }],
        fields: FIELDS,
        hint: 'later releases may add keys here',
    },
    request: { schema: 2 },
    page: {
        schema: 1,
        viewId: 'v_future',
        viewVersion: 12,
        draftUsed: false,
        datasetToken: FIXTURE_TOKEN,
        fields: FIELDS.filter((f) => visible.includes(f.field)).sort(
            (a, b) => visible.indexOf(a.field) - visible.indexOf(b.field),
        ),
        compact: ['rating'],
        rows,
        users: BOOKINGS_USERS,
        files: BOOKINGS_FILES,
        next: null,
        truncated: false,
        at: 1_795_273_200_000,
        heatmap: { buckets: 3 },
    },
    expect: {
        web: { layout: 'table', note: 'This view type needs a newer app' },
        phone: { layout: 'list', note: 'This view type needs a newer app' },
        readOnly: { filter: true, sort: false, groupBy: true, calendarMode: true, totals: true },
        unknownOptions: ['swimlanes'],
        titleField: 'title',
        compact: ['rating'],
        visible,
        editable: EDITABLE_WITH_WRITE,
        matches: { '"b1"': null, '"b2"': null, '"b3"': null, '"b4"': null, '"b5"': null },
        sortEvaluable: true,
        order: ['"b2"', '"b3"', '"b4"', '"b5"', '"b1"'],
        formatted: {
            '"b1"': {
                title: 'Standup',
                rating: '4',
                place: '{"lat":40.7,"lng":-74}',
                mood: 'calm',
                secret: '',
                starts_at: 'Nov 23, 2026, 9:00 AM',
            },
            '"b2"': {
                title: 'Board review',
                rating: '',
                place: '',
                mood: '["busy","late"]',
                secret: '',
                starts_at: 'Nov 24, 2026, 2:00 PM',
            },
        },
    },
};
