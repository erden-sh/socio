/**
 * A table view: a negative filter that keeps empty values,
 * a sort by option order with an unknown option and an empty last,
 * column totals, a hidden field, and a cache's sync: `changes` in its
 * three forms, an index after a restore and the reconcile plan.
 */
import type { ViewDefinition } from '../definition.js';

import {
    BOOKINGS_FIELDS,
    BOOKINGS_FILES,
    BOOKINGS_USERS,
    definitionFor,
    EDITABLE_WITH_WRITE,
    FIXTURE_GENERATION,
    FIXTURE_TOKEN,
    fieldsNamed,
    listFor,
    rowsKeyed,
} from './bookings.js';
import type { ViewFixture } from './types.js';

const RESTORED = 'Zp3vQ8cR1nT6uW2e';

const view: ViewDefinition = {
    schema: 1,
    id: 'v_table',
    dataset: 'ds_events',
    table: 'bookings',
    name: 'All bookings',
    layout: 'table',
    query: {
        filter: { field: 'room', op: 'is_not', value: 'opt_b' },
        sort: [{ field: 'room', dir: 'asc' }],
    },
    fields: [
        { field: 'title', width: 220 },
        { field: 'room' },
        { field: 'starts_at', width: 160 },
        { field: 'amount' },
        { field: 'done' },
        { field: 'owner' },
        { field: 'tags', wrap: true },
        { field: 'photo' },
        { field: 'notes', hidden: true },
    ],
    options: {},
    totals: { amount: 'sum', owner: 'filled' },
    visibility: 'dataset',
    version: 7,
};

const visible = ['title', 'room', 'starts_at', 'amount', 'done', 'owner', 'tags', 'photo'];

export const TABLE_FIXTURE: ViewFixture = {
    name: 'table',
    about: 'A table: is_not keeps empties, select order with an unknown option and an empty last, totals, and a reconcile after a restore.',
    fields: BOOKINGS_FIELDS,
    list: listFor(view),
    definition: definitionFor(view),
    request: { schema: 1, limit: 100 },
    page: {
        schema: 1,
        viewId: 'v_table',
        viewVersion: 7,
        draftUsed: false,
        datasetToken: FIXTURE_TOKEN,
        fields: fieldsNamed(visible),
        compact: ['title', 'room', 'starts_at', 'amount'],
        rows: rowsKeyed(['"b1"', '"b5"', '"b4"', '"b3"']),
        totals: { amount: 114_950, owner: 3 },
        users: BOOKINGS_USERS,
        files: BOOKINGS_FILES,
        next: null,
        truncated: false,
        at: 1_795_273_200_000,
    },
    expect: {
        web: { layout: 'table' },
        phone: { layout: 'table' },
        readOnly: { filter: false, sort: false, groupBy: false, calendarMode: false, totals: false },
        unknownOptions: [],
        titleField: 'title',
        compact: ['title', 'room', 'starts_at', 'amount'],
        visible,
        editable: EDITABLE_WITH_WRITE,
        matches: { '"b1"': true, '"b2"': false, '"b3"': true, '"b4"': true, '"b5"': true },
        sortEvaluable: true,
        order: ['"b1"', '"b2"', '"b5"', '"b4"', '"b3"'],
        formatted: {
            '"b1"': {
                title: 'Standup',
                room: 'Room A',
                starts_at: 'Nov 23, 2026, 9:00 AM',
                amount: '$125.50',
                done: 'Yes',
                owner: 'Ana Ruiz',
                tags: 'External',
                photo: 'room-a.jpg',
            },
            '"b5"': {
                title: 'Retro',
                room: 'Roof',
                starts_at: 'Nov 25, 2026, 10:00 AM',
                amount: '$25.00',
                done: 'No',
                owner: 'Cam Lee',
                tags: 'External, Catering',
                photo: '',
            },
            '"b4"': {
                title: 'Offsite',
                room: 'Unknown option',
                starts_at: 'Dec 1, 2026, 10:00 AM',
                amount: '$999.00',
                done: 'Yes',
                owner: 'Ana Ruiz',
                tags: 'Catering',
                photo: 'agenda.pdf',
            },
            '"b3"': {
                title: 'lunch',
                room: '',
                starts_at: 'Nov 20, 2026, 12:00 PM',
                amount: '',
                done: 'No',
                owner: '',
                tags: 'External, Catering',
                photo: 'File not available',
            },
        },
    },
    sync: {
        cached: [
            { key: '"b1"', stamp: `${FIXTURE_GENERATION}.1001` },
            { key: '"b5"', stamp: `${FIXTURE_GENERATION}.1041` },
            { key: '"b4"', stamp: `${FIXTURE_GENERATION}.1040` },
            { key: '"b3"', stamp: `${FIXTURE_GENERATION}.990` },
        ],
        changes: {
            apply: {
                schema: 1,
                token: `${FIXTURE_GENERATION}.1044`,
                upserts: [
                    {
                        ...rowsKeyed(['"b2"'])[0],
                        stamp: `${FIXTURE_GENERATION}.1043`,
                        values: { ...rowsKeyed(['"b2"'])[0].values, room: 'opt_a' },
                    },
                ],
                deleted: [{ key: '"b3"', stamp: `${FIXTURE_GENERATION}.1044` }],
                next: null,
            },
            reconcile: { schema: 1, token: `${RESTORED}.1020`, reconcile: true, upserts: [], deleted: [], next: null },
            resync: {
                schema: 1,
                token: `${FIXTURE_GENERATION}.1044`,
                resync: true,
                upserts: [],
                deleted: [],
                next: null,
            },
        },
        // A restore to a backup taken at 1010, under a new generation that has since reached 1020:
        // b1 kept its stamp from the backup, b4 went back to its version of 1003, b5 was written
        // again after the restore, b6 came back with the backup, and b3 is gone.
        index: {
            schema: 1,
            viewId: 'v_table',
            viewVersion: 7,
            datasetToken: `${RESTORED}.1020`,
            entries: [
                { key: '"b1"', stamp: `${FIXTURE_GENERATION}.1001` },
                { key: '"b6"', stamp: `${FIXTURE_GENERATION}.640` },
                { key: '"b5"', stamp: `${RESTORED}.1018` },
                { key: '"b4"', stamp: `${FIXTURE_GENERATION}.1003` },
            ],
            next: null,
        },
        lookup: {
            schema: 1,
            token: `${RESTORED}.1020`,
            rows: [
                {
                    key: '"b6"',
                    stamp: `${FIXTURE_GENERATION}.640`,
                    values: { ...rowsKeyed(['"b5"'])[0].values, id: 'b6', title: 'Kickoff', room: 'opt_a' },
                },
                { ...rowsKeyed(['"b5"'])[0], stamp: `${RESTORED}.1018` },
                {
                    ...rowsKeyed(['"b4"'])[0],
                    stamp: `${FIXTURE_GENERATION}.1003`,
                    values: { ...rowsKeyed(['"b4"'])[0].values, title: 'Offsite (draft)' },
                },
            ],
            users: BOOKINGS_USERS,
            files: BOOKINGS_FILES,
        },
        plan: {
            order: ['"b1"', '"b6"', '"b5"', '"b4"'],
            keep: ['"b1"'],
            fetch: ['"b6"', '"b5"', '"b4"'],
            drop: ['"b3"'],
        },
    },
};
