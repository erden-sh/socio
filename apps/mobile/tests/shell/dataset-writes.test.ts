import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { VIEW_WRITE_CODES } from '@socio/shared/dataset-views/contract';
import { ACME_DIFF, ACME_MINE, TABLE_FIXTURE, WRITE_FIXTURES } from '@socio/shared/dataset-views/fixtures/index';

import {
    conflictLines,
    copyName,
    createIdOf,
    DATASET_FILE_UPLOADS,
    fieldForm,
    fieldFormProblems,
    fieldLine,
    fieldSave,
    missingRequired,
    movedOption,
    newOption,
    newRowFields,
    newRowValues,
    newViewDefinition,
    offersFileAdd,
    optionsInUseCopy,
    pickedPeople,
    pickedValue,
    pickerDate,
    personRows,
    problemsByField,
    REFUSAL_COPY,
    refusalCopy,
    saveChoices,
    savedByLine,
    settingsForKind,
    unresolvedPeople,
    withFile,
    withoutFile,
} from '../../src/shell/dataset-writes';
import { ACME_REF, createFixtureViewSource } from '../../src/sync/fixture-source';
import { LOCAL_WRITE_CODES } from '../../src/sync/view-source';

// The write screens' words and view models (CB-469, CB-451),
// under Node with the shared write fixtures.

describe('refusals in plain words', () => {
    it('words every code the contract names and the phone’s own, never the server’s text', () => {
        for (const code of [...Object.values(VIEW_WRITE_CODES), ...Object.values(LOCAL_WRITE_CODES)]) {
            expect(REFUSAL_COPY[code], code).toMatch(/\.$/);
        }
        for (const fixture of WRITE_FIXTURES.writeRefusal) {
            const said = refusalCopy({ code: fixture.code, body: { ...fixture, error: 'Server words' } });
            expect(said).toBe(REFUSAL_COPY[fixture.code as keyof typeof REFUSAL_COPY]);
        }
        expect(refusalCopy({ code: 'something_new', body: null })).toBe(REFUSAL_COPY.failed);
    });

    it('says an export’s counts, a wait’s seconds and the options in use', () => {
        const [tooLarge] = WRITE_FIXTURES.exportTooLarge;
        expect(refusalCopy({ code: tooLarge.code, body: tooLarge })).toBe(
            'This view has 140,000 rows; an export takes at most 100,000. Narrow its filter, then export again.',
        );
        expect(refusalCopy({ code: 'rate_limited', body: null, retryAfterSeconds: 1 })).toBe(
            'Too many at once. Try again in 1 second.',
        );
        expect(optionsInUseCopy(WRITE_FIXTURES.optionsInUse[0].inUse)).toEqual({
            title: 'Remove “Done”?',
            message: '12 rows use “Done”. They keep their values, shown as “Unknown option”.',
        });
        expect(
            optionsInUseCopy([
                { label: 'A', rows: 1 },
                { label: 'B', rows: 2 },
            ]).title,
        ).toBe('Remove 2 options?');
    });

    it('puts a 400’s problems under their fields', () => {
        expect(problemsByField(WRITE_FIXTURES.invalidWrite[0])).toEqual({
            fields: { title: 'Title is required.', status: '"opt_gone" is not an option of Status.' },
            other: [],
        });
        expect(problemsByField({ problems: [{ path: '$.createId', message: 'Bad id.' }] }).other).toEqual(['Bad id.']);
    });
});

describe('a view conflict, theirs beside yours', () => {
    it('lines up each part and each field of the fixture’s diff', async () => {
        const fields = (await createFixtureViewSource().list(ACME_REF)).fields;
        const lines = conflictLines(ACME_DIFF, fields);
        expect(lines.map((l) => [l.label, l.theirs, l.mine])).toEqual([
            ['Sort', 'Due, ascending', 'Title, ascending'],
            ['Fields: Title', 'Shown, 240 wide (moved)', 'Shown, 240 wide (moved)'],
            ['Fields: Status', 'Shown (moved)', 'Shown (moved)'],
            ['Fields: Due', 'Shown', 'Not listed'],
            ['Fields: Owner', 'Shown (moved)', 'Shown, first on small screens (moved)'],
            ['Fields: Notes', 'Not listed', 'Hidden'],
            ['Layout options', 'None', 'rowHeight'],
        ]);
        expect(savedByLine('u_bo', WRITE_FIXTURES.viewConflict[0].users)).toBe('Bo saved this view');
        expect(savedByLine(null, {})).toBe('Someone saved this view');
    });

    it('words a filter, grouping and who sees it', () => {
        const fields = TABLE_FIXTURE.list.fields;
        const lines = conflictLines(
            {
                parts: [
                    { part: 'filter', mine: undefined, theirs: { field: 'room', op: 'is', value: 'opt_a' } },
                    { part: 'groupBy', mine: [{ field: 'room' }], theirs: [] },
                    { part: 'visibility', mine: 'personal', theirs: 'dataset' },
                ],
                fields: [],
            },
            fields,
        );
        expect(lines.map((l) => [l.theirs, l.mine])).toEqual([
            ['Room is Room A', 'No filter'],
            ['Not grouped', 'Room'],
            ['Everyone', 'Only the owner'],
        ]);
    });

    it('offers Save for everyone only with the right, Save for a personal view, never for default', () => {
        expect(saveChoices({ id: 'v1', visibility: 'dataset' }, { saveShared: true })).toEqual({
            save: 'everyone',
            asNew: true,
        });
        expect(saveChoices({ id: 'v1', visibility: 'dataset' }, { saveShared: false }).save).toBeNull();
        expect(saveChoices({ id: 'v1', visibility: 'personal' }, { saveShared: false }).save).toBe('mine');
        expect(saveChoices({ id: 'default', visibility: 'dataset' }, { saveShared: true }).save).toBeNull();
        const made = newViewDefinition(ACME_MINE, '  Mine ', 'personal');
        expect(made).not.toHaveProperty('id');
        expect(made).not.toHaveProperty('version');
        expect(made).toMatchObject({ name: 'Mine', visibility: 'personal', options: { rowHeight: 'tall' } });
        expect(copyName('Open tasks')).toBe('Open tasks (copy)');
    });
});

describe('field settings', () => {
    const status = WRITE_FIXTURES.fieldSettingsResponse[0].fields[1]!;

    it('keeps only the kind’s settings and sends the fixture’s save', () => {
        expect(
            settingsForKind('select', { options: [{ id: 'a', label: 'A', color: 'red', extra: 1 }], unit: 'kg' }),
        ).toEqual({
            options: [{ id: 'a', label: 'A', color: 'red' }],
        });
        expect(settingsForKind('currency', { currency: 'EUR', minorUnits: true, unit: 'x' })).toEqual({
            currency: 'EUR',
            minorUnits: true,
        });
        expect(settingsForKind('text', { options: [] })).toEqual({});
        const form = fieldForm(status);
        const { schema: _schema, ...expected } = WRITE_FIXTURES.fieldSettingsRequest[0];
        const edited = {
            ...form,
            options: form.options
                .filter((o) => o.id !== 'opt_done')
                .map((o) => (o.id === 'opt_doing' ? { ...o, label: 'In progress' } : o)),
        };
        expect(fieldSave(edited, 2, true)).toEqual(expected);
    });

    it('checks a form before it is sent', () => {
        const form = fieldForm(status);
        expect(fieldFormProblems(form)).toEqual({});
        expect(fieldFormProblems({ ...form, label: ' ', options: [{ id: 'x', label: '', color: 'red' }] })).toEqual({
            label: 'A field needs a name.',
            options: 'Every option needs a name.',
        });
        expect(fieldFormProblems({ ...form, kind: 'currency', currency: 'dollars', decimals: '30' })).toEqual({
            currency: 'Use a three-letter currency code, like USD.',
            decimals: 'Use a whole number from 0 to 20.',
        });
    });

    it('adds options with fresh ids and the next color, and moves them', () => {
        const options = fieldForm(status).options;
        const added = newOption(options, 'a1b2-c3');
        expect(added).toEqual({ id: 'opt_a1b2c3', label: '', color: 'teal' });
        expect(newOption([...options, added], 'a1b2-c3').id).toBe('opt_a1b2c3_2');
        expect(movedOption(options, 'opt_done', -1).map((o) => o.id)).toEqual(['opt_todo', 'opt_done', 'opt_doing']);
        expect(movedOption(options, 'opt_todo', -1).map((o) => o.id)).toEqual(['opt_todo', 'opt_doing', 'opt_done']);
    });

    it('says why a field can’t change', () => {
        const [id, , budget] = WRITE_FIXTURES.fieldSettingsResponse[0].fields;
        expect(fieldLine(id!, true)).toEqual({ kind: 'ID', note: 'The table’s key', editable: false });
        expect(fieldLine(budget!, true)).toEqual({
            kind: 'Currency',
            note: 'Its column was removed from the table.',
            editable: false,
        });
        expect(fieldLine(status, true)).toEqual({ kind: 'Select', note: null, editable: true });
        expect(fieldLine(status, false).editable).toBe(false);
    });
});

describe('the person picker', () => {
    const directory = WRITE_FIXTURES.peopleDirectory[0].people;
    const known = WRITE_FIXTURES.peopleLookup[0].users;

    it('keeps a deactivated person the cell holds, muted, and never offers one', () => {
        expect(personRows(directory, ['u_bo'], known, '')).toEqual([
            { id: 'u_bo', name: 'Bo', chosen: true, muted: true, note: 'Deactivated' },
            { id: 'u_ada', name: 'Ada', chosen: false, muted: false },
        ]);
        expect(personRows(directory, ['u_gone'], {}, '')[0]).toMatchObject({
            name: 'Unknown person',
            note: 'Not in this workspace',
        });
        expect(personRows(directory, [], known, 'bo')).toEqual([]);
        expect(personRows(directory, [], known, 'AD').map((r) => r.id)).toEqual(['u_ada']);
    });

    it('picks one person or toggles people, and lists the names a page lacks', () => {
        expect(pickedPeople('u_bo', 'u_ada', false)).toBe('u_ada');
        expect(pickedPeople('u_ada', 'u_ada', false)).toBeNull();
        expect(pickedPeople(['u_bo'], 'u_ada', true)).toEqual(['u_bo', 'u_ada']);
        expect(pickedPeople(['u_bo', 'u_ada'], 'u_bo', true)).toEqual(['u_ada']);
        expect(unresolvedPeople(['u_ada', ['u_bo', 'u_cy'], null], { u_ada: known.u_ada! })).toEqual(['u_bo', 'u_cy']);
    });
});

describe('files and dates', () => {
    it('adds and removes a file id', () => {
        expect(withFile(['f_acme_1'], 'f_acme_2')).toEqual(['f_acme_1', 'f_acme_2']);
        expect(withFile(null, 'f_1')).toEqual(['f_1']);
        expect(withoutFile(['f_acme_1', 'f_acme_2'], 'f_acme_1')).toEqual(['f_acme_2']);
    });

    it('opens a date at noon UTC and writes back the day; an instant as it is', () => {
        expect(pickerDate('2026-11-30', false).toISOString()).toBe('2026-11-30T12:00:00.000Z');
        expect(pickedValue(pickerDate('2026-11-30', false), false)).toBe('2026-11-30');
        expect(pickerDate('2026-11-23T14:00:00Z', true).toISOString()).toBe('2026-11-23T14:00:00.000Z');
        expect(pickedValue(new Date('2026-11-23T14:30:00Z'), true)).toBe('2026-11-23T14:30:00.000Z');
        expect(pickerDate(null, true, 1_795_273_200_000).getTime()).toBe(1_795_273_200_000);
    });
});

describe('dataset file uploads (off until CB-532)', () => {
    const src = (file: string) => readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8');

    it('is off: the server has no route for a dataset’s files yet', () => {
        expect(DATASET_FILE_UPLOADS).toBe(false);
        expect(offersFileAdd(true)).toBe(false);
    });

    it('offers Add file in an editable cell only while uploads are on', () => {
        expect(offersFileAdd(true, false)).toBe(false);
        expect(offersFileAdd(true, true)).toBe(true);
        expect(offersFileAdd(false, true)).toBe(false);
    });

    it('puts every Add file behind the gate: the file cell is the only way to upload', () => {
        const pickers = src('screens/dataset-pickers.tsx');
        expect(pickers).toMatch(
            /\{offersFileAdd\(props\.editable\) \? \(\s*<ActionMenu[^>]*?testID=\{`\$\{props\.testID\}-add`\}/,
        );
        expect(pickers.match(/source\.uploadFile\(/g)).toHaveLength(1);
        // The record sheet and New row reach an upload only through FileCell's onAdd.
        expect(src('screens/dataset-sheets.tsx')).toMatch(
            /<FileCell[^/]*onAdd=\{\(from\) => props\.pickers\.onAddFile\(/,
        );
        expect(src('screens/dataset-new-row.tsx')).toMatch(
            /<FileCell[^/]*onAdd=\{\(from\) =>\s*void uploads\.upload\(/,
        );
        for (const screen of [
            'screens/dataset-view.tsx',
            'screens/dataset-new-row.tsx',
            'screens/dataset-sheets.tsx',
        ]) {
            expect(src(screen), screen).not.toMatch(/\.uploadFile\(/);
        }
    });
});

describe('New row', () => {
    it('asks the view’s fields then the rest, leaving out a key the server assigns', async () => {
        const source = createFixtureViewSource();
        const list = await source.list(ACME_REF);
        const types = Object.fromEntries((await source.fields(ACME_REF)).fields.map((f) => [f.field, f.type]));
        const form = newRowFields(ACME_MINE, list.fields, types);
        expect(form.keyAssigned).toBe(true);
        expect(form.fields.map((f) => [f.field.field, f.required])).toEqual([
            ['owner', false],
            ['title', true],
            ['status', false],
            ['notes', false],
            ['file', false],
            ['due', false],
        ]);
        // A text key is asked for, required.
        const bookings = newRowFields(TABLE_FIXTURE.definition.view, TABLE_FIXTURE.list.fields, { id: 'TEXT' });
        expect(bookings.keyAssigned).toBe(false);
        expect(bookings.fields.find((f) => f.field.field === 'id')).toMatchObject({
            required: true,
            field: { kind: 'text' },
        });
    });

    it('sends only what was set, checks the required ones, and makes a valid createId', () => {
        expect(newRowValues({ title: 'Call Acme', notes: '', file: [], owner: null, done: false })).toEqual({
            title: 'Call Acme',
            done: false,
        });
        const fields = [
            { field: { ...TABLE_FIXTURE.list.fields[1]!, field: 'title', label: 'Title' }, required: true },
        ];
        expect(missingRequired(fields, { title: '' })).toEqual({ title: 'Title is required.' });
        expect(missingRequired(fields, { title: 'x' })).toEqual({});
        expect(createIdOf('3f2b1c9e-0d4a-4b8f-9c1e-7a6b5c4d3e2f')).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
        expect(createIdOf('')).toBe('row-00000000');
    });
});
