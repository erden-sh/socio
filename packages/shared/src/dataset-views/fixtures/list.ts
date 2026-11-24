/**
 * A list view: priority fields, a date-ordered view that
 * opens at today (`around`, `opensAt`), and a negative person filter
 * that keeps rows with no owner.
 */
import type { ViewDefinition } from '../definition.js';

import {
    BOOKINGS_FIELDS,
    BOOKINGS_FILES,
    BOOKINGS_USERS,
    definitionFor,
    EDITABLE_WITH_WRITE,
    FIXTURE_TOKEN,
    fieldsNamed,
    listFor,
    rowsKeyed,
} from './bookings.js';
import type { ViewFixture } from './types.js';

const view: ViewDefinition = {
    schema: 1,
    id: 'v_list',
    dataset: 'ds_events',
    table: 'bookings',
    name: 'Upcoming',
    layout: 'list',
    query: {
        filter: { field: 'owner', op: 'is_not', value: 'u_ben' },
        sort: [{ field: 'starts_at', dir: 'asc' }],
    },
    fields: [
        { field: 'title', priority: 2 },
        { field: 'starts_at', priority: 1 },
        { field: 'room' },
        { field: 'guests' },
        { field: 'owner' },
        { field: 'notes', hidden: true },
    ],
    options: {},
    visibility: 'personal',
    version: 2,
};

const visible = ['title', 'starts_at', 'room', 'guests', 'owner'];

export const LIST_FIXTURE: ViewFixture = {
    name: 'list',
    about: 'A list: priority fields lead, it opens at today with an earlier row above, and is_not on a person keeps unowned rows.',
    fields: BOOKINGS_FIELDS,
    list: listFor(view),
    definition: definitionFor(view),
    request: { schema: 1, around: 'today' },
    page: {
        schema: 1,
        viewId: 'v_list',
        viewVersion: 2,
        draftUsed: false,
        datasetToken: FIXTURE_TOKEN,
        fields: fieldsNamed(visible),
        compact: ['starts_at', 'title'],
        rows: rowsKeyed(['"b1"', '"b5"', '"b4"']),
        users: BOOKINGS_USERS,
        files: BOOKINGS_FILES,
        next: null,
        opensAt: { group: null, row: '"b1"' },
        truncated: false,
        at: 1_795_273_200_000,
    },
    expect: {
        web: { layout: 'list' },
        phone: { layout: 'list' },
        readOnly: { filter: false, sort: false, groupBy: false, calendarMode: false, totals: false },
        unknownOptions: [],
        titleField: 'title',
        compact: ['starts_at', 'title'],
        visible,
        editable: EDITABLE_WITH_WRITE,
        matches: { '"b1"': true, '"b2"': false, '"b3"': true, '"b4"': true, '"b5"': true },
        sortEvaluable: true,
        order: ['"b3"', '"b1"', '"b2"', '"b5"', '"b4"'],
        formatted: {
            '"b1"': {
                title: 'Standup',
                starts_at: 'Nov 23, 2026, 9:00 AM',
                room: 'Room A',
                guests: '6 people',
                owner: 'Ana Ruiz',
            },
            '"b5"': {
                title: 'Retro',
                starts_at: 'Nov 25, 2026, 10:00 AM',
                room: 'Roof',
                guests: '8 people',
                owner: 'Cam Lee',
            },
            '"b4"': {
                title: 'Offsite',
                starts_at: 'Dec 1, 2026, 10:00 AM',
                room: 'Unknown option',
                guests: '40 people',
                owner: 'Ana Ruiz',
            },
        },
    },
};
