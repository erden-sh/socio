/**
 * A board view: columns in `options.columns`
 * order with "No Room" listed in the middle and a hidden column, an
 * unlisted option after them, every column's group on the first page
 * (the hidden one with its count and cursor only), a sum per column,
 * and a multi-select filter on a list stored as JSON text.
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
    id: 'v_board',
    dataset: 'ds_events',
    table: 'bookings',
    name: 'By room',
    layout: 'board',
    query: {
        filter: { field: 'tags', op: 'has_any_of', value: ['t_x'] },
        sort: [{ field: 'amount', dir: 'desc' }],
    },
    fields: [{ field: 'title' }, { field: 'owner', priority: 1 }, { field: 'amount' }, { field: 'tags' }],
    options: {
        titleField: 'title',
        groupField: 'room',
        columns: [{ value: 'opt_b' }, { value: null }, { value: 'opt_a', hidden: true }],
    },
    totals: { amount: 'sum' },
    visibility: 'dataset',
    version: 3,
};

const visible = ['title', 'owner', 'amount', 'tags'];

export const BOARD_FIXTURE: ViewFixture = {
    name: 'board',
    about: 'A board: listed columns first (No Room listed mid-way, Room A hidden), Roof after them, a sum per column.',
    fields: BOOKINGS_FIELDS,
    list: listFor(view),
    definition: definitionFor(view),
    request: { schema: 1 },
    page: {
        schema: 1,
        viewId: 'v_board',
        viewVersion: 3,
        draftUsed: false,
        datasetToken: FIXTURE_TOKEN,
        fields: fieldsNamed(visible),
        compact: ['owner'],
        rows: rowsKeyed(['"b3"', '"b5"'], (row) => (row.values.room as string | null) ?? null),
        groups: [
            { key: 'opt_b', label: 'Room B', count: 0, totals: { amount: null }, next: null, folded: false },
            { key: null, label: 'No Room', count: 1, totals: { amount: null }, next: null, folded: false },
            { key: 'opt_a', label: 'Room A', count: 1, totals: { amount: 12_550 }, next: 'c.opt_a.0', folded: true },
            { key: 'opt_c', label: 'Roof', count: 1, totals: { amount: 2_500 }, next: null, folded: false },
        ],
        users: BOOKINGS_USERS,
        files: BOOKINGS_FILES,
        next: null,
        truncated: false,
        at: 1_795_273_200_000,
    },
    expect: {
        web: { layout: 'board' },
        phone: { layout: 'board' },
        readOnly: { filter: false, sort: false, groupBy: false, calendarMode: false, totals: false },
        unknownOptions: [],
        titleField: 'title',
        compact: ['owner'],
        visible,
        editable: EDITABLE_WITH_WRITE,
        matches: { '"b1"': true, '"b2"': false, '"b3"': true, '"b4"': false, '"b5"': true },
        sortEvaluable: true,
        order: ['"b4"', '"b1"', '"b5"', '"b2"', '"b3"'],
        formatted: {
            '"b3"': {
                title: 'lunch',
                owner: '',
                amount: '',
                tags: 'External, Catering',
            },
            '"b5"': {
                title: 'Retro',
                owner: 'Cam Lee',
                amount: '$25.00',
                tags: 'External, Catering',
            },
        },
        board: [
            { value: 'opt_b', hidden: false },
            { value: null, hidden: false },
            { value: 'opt_a', hidden: true },
            { value: 'opt_c', hidden: false },
        ],
    },
};
