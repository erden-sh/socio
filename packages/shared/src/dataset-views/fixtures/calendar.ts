/**
 * A calendar view: a relative-date filter
 * resolved in the viewer's zone, a datetime stored as ms, a week's
 * range read with the date and end fields and zone sent back, and the
 * opening range (the week on the web, the day on a phone).
 */
import type { ViewDefinition } from '../definition.js';

import {
    BOOKINGS_FIELDS,
    BOOKINGS_FILES,
    BOOKINGS_USERS,
    definitionFor,
    EDITABLE_WITH_WRITE,
    FIXTURE_CONTEXT,
    FIXTURE_TOKEN,
    fieldsNamed,
    listFor,
    rowsKeyed,
} from './bookings.js';
import type { ViewFixture } from './types.js';

const view: ViewDefinition = {
    schema: 1,
    id: 'v_calendar',
    dataset: 'ds_events',
    table: 'bookings',
    name: 'This week',
    layout: 'calendar',
    query: {
        filter: { field: 'starts_at', op: 'within', value: { relative: 'next', count: 7, unit: 'day' } },
        sort: [{ field: 'starts_at', dir: 'asc' }],
    },
    fields: [{ field: 'title' }, { field: 'room' }, { field: 'starts_at' }, { field: 'ends_at' }],
    options: { dateField: 'starts_at', endField: 'ends_at', calendarMode: 'week' },
    visibility: 'dataset',
    version: 1,
};

const visible = ['title', 'room', 'starts_at', 'ends_at'];

export const CALENDAR_FIXTURE: ViewFixture = {
    name: 'calendar',
    about: 'A calendar: "next 7 days" from Saturday in New York, a ms datetime, a range read, and the opening range per client.',
    fields: BOOKINGS_FIELDS,
    list: listFor(view),
    definition: definitionFor(view),
    request: { schema: 1, range: { from: '2026-11-23', to: '2026-11-29' } },
    page: {
        schema: 1,
        viewId: 'v_calendar',
        viewVersion: 1,
        draftUsed: false,
        datasetToken: FIXTURE_TOKEN,
        fields: fieldsNamed(visible),
        compact: ['title', 'room', 'starts_at', 'ends_at'],
        rows: rowsKeyed(['"b1"', '"b2"', '"b5"']),
        users: BOOKINGS_USERS,
        files: BOOKINGS_FILES,
        next: null,
        range: {
            from: '2026-11-23',
            to: '2026-11-29',
            dateField: 'starts_at',
            endField: 'ends_at',
            timeZone: FIXTURE_CONTEXT.timeZone,
        },
        truncated: false,
        at: 1_795_273_200_000,
    },
    expect: {
        web: { layout: 'calendar' },
        phone: { layout: 'calendar' },
        readOnly: { filter: false, sort: false, groupBy: false, calendarMode: false, totals: false },
        unknownOptions: [],
        titleField: 'title',
        compact: ['title', 'room', 'starts_at', 'ends_at'],
        visible,
        editable: EDITABLE_WITH_WRITE,
        matches: { '"b1"': true, '"b2"': true, '"b3"': false, '"b4"': false, '"b5"': true },
        sortEvaluable: true,
        order: ['"b3"', '"b1"', '"b2"', '"b5"', '"b4"'],
        formatted: {
            '"b1"': {
                title: 'Standup',
                room: 'Room A',
                starts_at: 'Nov 23, 2026, 9:00 AM',
                ends_at: 'Nov 23, 2026, 9:30 AM',
            },
            '"b2"': {
                title: 'Board review',
                room: 'Room B',
                starts_at: 'Nov 24, 2026, 2:00 PM',
                ends_at: 'Nov 24, 2026, 4:00 PM',
            },
            '"b5"': {
                title: 'Retro',
                room: 'Roof',
                starts_at: 'Nov 25, 2026, 10:00 AM',
                ends_at: '',
            },
        },
        calendar: { web: 'week', phone: 'day' },
    },
};
