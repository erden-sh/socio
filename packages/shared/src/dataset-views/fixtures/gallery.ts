/**
 * A gallery view: a file cover from the dataset's own
 * attachments, one file outside them, priority fields under the cover,
 * an `any` filter with `$me`, a descending sort with an empty last, and
 * a plugin-written table, read-only to people.
 */
import type { ViewDefinition } from '../definition.js';

import {
    BOOKINGS_FIELDS,
    BOOKINGS_FILES,
    BOOKINGS_USERS,
    definitionFor,
    FIXTURE_TOKEN,
    fieldsNamed,
    listFor,
    rowsKeyed,
} from './bookings.js';
import type { ViewFixture } from './types.js';

const view: ViewDefinition = {
    schema: 1,
    id: 'v_gallery',
    dataset: 'ds_events',
    table: 'bookings',
    name: 'Covers',
    layout: 'gallery',
    query: {
        filter: {
            any: [
                { field: 'guests', op: 'gte', value: 10 },
                { field: 'owner', op: 'is', value: { $me: true } },
            ],
        },
        sort: [{ field: 'guests', dir: 'desc', empty: 'last' }],
    },
    fields: [
        { field: 'photo' },
        { field: 'title', priority: 1 },
        { field: 'guests', priority: 2 },
        { field: 'notes', hidden: true },
        { field: 'owner' },
        { field: 'share' },
    ],
    options: { cardCover: 'photo' },
    visibility: 'dataset',
    version: 4,
};

const visible = ['photo', 'title', 'guests', 'owner', 'share'];
const list = listFor(view);

export const GALLERY_FIXTURE: ViewFixture = {
    name: 'gallery',
    about: 'A gallery: covers from the attachments only, any-of with $me, guests descending with empties last, written by a plugin.',
    fields: BOOKINGS_FIELDS,
    list: { ...list, rights: { read: true, write: false, saveShared: false, writtenBy: 'events' } },
    definition: definitionFor(view),
    request: { schema: 1, limit: 60 },
    page: {
        schema: 1,
        viewId: 'v_gallery',
        viewVersion: 4,
        draftUsed: false,
        datasetToken: FIXTURE_TOKEN,
        fields: fieldsNamed(visible),
        compact: ['title', 'guests'],
        rows: rowsKeyed(['"b4"', '"b2"', '"b1"']),
        users: BOOKINGS_USERS,
        files: BOOKINGS_FILES,
        next: null,
        truncated: false,
        at: 1_795_273_200_000,
    },
    expect: {
        web: { layout: 'gallery' },
        phone: { layout: 'gallery' },
        readOnly: { filter: false, sort: false, groupBy: false, calendarMode: false, totals: false },
        unknownOptions: [],
        titleField: 'title',
        compact: ['title', 'guests'],
        visible,
        editable: [],
        matches: { '"b1"': true, '"b2"': true, '"b3"': false, '"b4"': true, '"b5"': false },
        sortEvaluable: true,
        order: ['"b4"', '"b2"', '"b5"', '"b1"', '"b3"'],
        formatted: {
            '"b4"': {
                photo: 'agenda.pdf',
                title: 'Offsite',
                guests: '40 people',
                owner: 'Ana Ruiz',
                share: '50.0%',
            },
            '"b2"': {
                photo: '',
                title: 'Board review',
                guests: '12 people',
                owner: 'Ben Okafor',
                share: '100.0%',
            },
            '"b1"': {
                photo: 'room-a.jpg',
                title: 'Standup',
                guests: '6 people',
                owner: 'Ana Ruiz',
                share: '12.5%',
            },
        },
    },
};
