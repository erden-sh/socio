import { describe, expect, it } from 'vitest';

import {
    cellConflict,
    datasetFileUploaded,
    diffViews,
    exportTooLarge,
    fieldConflict,
    fieldSettingsResponse,
    fieldSettingsSaved,
    invalidWrite,
    optionsInUse,
    peopleDirectory,
    peopleLookup,
    rowWritten,
    viewConflict,
    viewDefinitionResponse,
    viewDraftSaved,
    viewListResponse,
    viewRowsPage,
    viewSaved,
    writeRefusal,
} from '@socio/shared/dataset-views/contract';
import { ACME_DIFF, ACME_MINE, ACME_THEIRS, WRITE_FIXTURES } from '@socio/shared/dataset-views/fixtures/index';

import {
    ACME_ARCHIVE_VIEW,
    ACME_CONFLICT_ROW,
    ACME_OPEN_VIEW,
    ACME_REF,
    createFixtureViewSource,
    FIXTURE_FILE_MAX,
    FIXTURE_REF,
} from '../../src/sync/fixture-source';
import type { Refused } from '../../src/sync/view-source';

// The fixture source's writes (CB-469, CB-451), which back the
// dev preview for now: every answer parses with the shared schema a live
// answer would, and the Acme table meets each conflict the write fixtures hold
// the first time the phone writes over it.

const refusal = (result: { outcome: string }) => {
    expect(result.outcome).toBe('refused');
    const refused = result as Refused;
    expect(writeRefusal.safeParse(refused.body ?? { error: refused.error, code: refused.code }).success).toBe(true);
    return refused;
};

describe('the Acme table’s reads', () => {
    it('lists its views, Ada’s draft of Open tasks from version 3, and every field', async () => {
        const source = createFixtureViewSource();
        const list = viewListResponse.parse(await source.list(ACME_REF));
        expect(list.views.map((v) => [v.id, v.version, v.hasDraft])).toEqual([
            [ACME_OPEN_VIEW, 4, true],
            [ACME_ARCHIVE_VIEW, 1, false],
            ['default', 0, false],
        ]);
        expect(list.fields.map((f) => f.field)).toEqual(['id', 'title', 'status', 'owner', 'file', 'due', 'notes']);
        const definition = viewDefinitionResponse.parse(await source.definition(ACME_REF, ACME_OPEN_VIEW));
        expect(definition.view).toEqual(ACME_THEIRS);
        expect(definition.draft).toMatchObject({ definition: ACME_MINE, baseVersion: 3 });
        const page = viewRowsPage.parse(await source.rows(ACME_REF, ACME_OPEN_VIEW, { schema: 1 }));
        expect(page.draftUsed).toBe(true);
        // Ada's draft sorts by title; Done is filtered out.
        expect(page.rows.map((r) => r.values.title)).toEqual([
            'Book the kickoff call',
            'Draft the Acme proposal',
            'Ship the Acme brief',
        ]);
    });

    it('offers active people only and names a deactivated one', async () => {
        const source = createFixtureViewSource();
        const directory = peopleDirectory.parse(await source.people());
        expect(directory.people.map((p) => p.id)).toEqual(['u_ada', 'u_ana', 'u_ben']);
        const lookup = peopleLookup.parse(await source.lookupPeople(['u_bo', 'u_cam', 'socio:s_acme', 'u_nobody']));
        expect(lookup.users).toEqual({
            u_bo: { name: 'Bo', avatar: null, active: false },
            u_cam: { name: 'Cam Lee', avatar: null, active: false },
            'socio:s_acme': { name: 'Acme Helper', avatar: null, active: true },
        });
    });
});

describe('a cell edit and its conflict', () => {
    it('meets Bo’s change once: the fixture’s conflict, then Keep mine saves, and a replay is 200', async () => {
        const source = createFixtureViewSource();
        const edit = WRITE_FIXTURES.cellEditRequest[0];
        const first = await source.editCell(ACME_REF, ACME_CONFLICT_ROW, edit);
        expect(first.outcome).toBe('conflict');
        const conflict = first.outcome === 'conflict' ? cellConflict.parse(first.conflict) : null;
        expect(conflict).toMatchObject({
            error: WRITE_FIXTURES.cellConflict[0].error,
            field: 'status',
            current: 'opt_done',
            row: { key: '1042', values: { owner: 'u_bo' } },
            users: { u_bo: { active: false } },
        });
        const kept = await source.editCell(ACME_REF, ACME_CONFLICT_ROW, { ...edit, from: conflict!.current });
        expect(kept.outcome).toBe('saved');
        const row = kept.outcome === 'saved' ? rowWritten.parse(kept.written).row : null;
        expect(row?.values.status).toBe('opt_doing');
        // The same edit again (an outbox replay) is already applied: 200, nothing written.
        const again = await source.editCell(ACME_REF, ACME_CONFLICT_ROW, { ...edit, from: conflict!.current });
        expect(again).toMatchObject({ outcome: 'saved', written: { row: { stamp: row?.stamp } } });
    });

    it('refuses a gone row, a read-only field and a value the kind doesn’t take', async () => {
        const source = createFixtureViewSource();
        expect(refusal(await source.editCell(ACME_REF, '9999', { field: 'title', from: null, to: 'x' })).code).toBe(
            'row_gone',
        );
        expect(refusal(await source.editCell(ACME_REF, '1040', { field: 'id', from: 1040, to: 1 })).code).toBe(
            'read_only',
        );
        const bad = refusal(
            await source.editCell(ACME_REF, '1040', { field: 'status', from: 'opt_doing', to: 'opt_gone' }),
        );
        expect(invalidWrite.parse(bad.body).problems).toEqual([
            { path: '$.to', message: '"opt_gone" is not an option of Status.' },
        ]);
    });
});

describe('a draft and save for everyone', () => {
    it('conflicts with Bo’s save (the fixture’s diff), Keep mine overwrites at 4, and the draft goes', async () => {
        const source = createFixtureViewSource();
        const result = await source.saveView(ACME_REF, ACME_OPEN_VIEW, ACME_MINE, 3);
        expect(result.outcome).toBe('conflict');
        const conflict = result.outcome === 'conflict' ? viewConflict.parse(result.conflict) : null;
        expect(conflict?.diff).toEqual(ACME_DIFF);
        expect(conflict).toMatchObject({
            error: WRITE_FIXTURES.viewConflict[0].error,
            savedBy: 'u_bo',
            current: { version: 4 },
        });
        const kept = await source.saveView(ACME_REF, ACME_OPEN_VIEW, ACME_MINE, conflict!.current.version, true);
        expect(kept.outcome === 'saved' && viewSaved.parse(kept.saved).view.version).toBe(5);
        expect((await source.definition(ACME_REF, ACME_OPEN_VIEW)).draft).toBeUndefined();
        // A save at a stale version conflicts again, even as Keep mine.
        expect((await source.saveView(ACME_REF, ACME_OPEN_VIEW, ACME_MINE, 4, true)).outcome).toBe('conflict');
    });

    it('saves a draft with its base, saves it as a new view, and never stores default', async () => {
        const source = createFixtureViewSource();
        const draft = await source.saveDraft(ACME_REF, ACME_OPEN_VIEW, ACME_MINE, 3);
        expect(draft.outcome === 'saved' && viewDraftSaved.parse(draft.saved).draft.baseVersion).toBe(3);
        const { id: _id, version: _version, ...rest } = ACME_MINE;
        const created = await source.createView(
            ACME_REF,
            { ...rest, name: 'Open tasks (Ada)', visibility: 'personal' },
            ACME_OPEN_VIEW,
        );
        expect(created.outcome === 'saved' && viewSaved.parse(created.saved).view).toMatchObject({
            id: WRITE_FIXTURES.viewSaved[1].view.id,
            version: 1,
            visibility: 'personal',
        });
        expect((await source.list(ACME_REF)).views.find((v) => v.id === ACME_OPEN_VIEW)?.hasDraft).toBe(false);
        const defaultView = (await source.definition(ACME_REF, 'default')).view;
        expect(refusal(await source.saveView(ACME_REF, 'default', defaultView, 0)).code).toBe('invalid');
        expect(diffViews(ACME_MINE, ACME_THEIRS)).toEqual(ACME_DIFF);
    });
});

describe('field settings', () => {
    it('conflicts once with Status’s other save, asks before removing used options, then saves', async () => {
        const source = createFixtureViewSource();
        const settings = fieldSettingsResponse.parse(await source.fields(ACME_REF));
        expect(settings.canEdit).toBe(true);
        expect(settings.fields.find((f) => f.field === 'budget')).toMatchObject({
            missing: true,
            declaredBy: 'plugin:acme-books',
        });
        const { schema: _schema, confirmRemovedOptions: _confirm, ...save } = WRITE_FIXTURES.fieldSettingsRequest[0];
        const conflict = await source.saveField(ACME_REF, 'status', save);
        expect(conflict.outcome).toBe('conflict');
        const current = conflict.outcome === 'conflict' ? fieldConflict.parse(conflict.conflict).current : null;
        expect(current?.version).toBe(3);
        expect(current?.settings.options?.map((o) => o.id)).toContain('opt_blocked');
        const inUse = await source.saveField(ACME_REF, 'status', { ...save, baseVersion: 3 });
        expect(inUse.outcome === 'in-use' && optionsInUse.parse(inUse.inUse).inUse).toEqual([
            { id: 'opt_done', label: 'Done', rows: 1 },
        ]);
        const saved = await source.saveField(ACME_REF, 'status', {
            ...save,
            baseVersion: 3,
            confirmRemovedOptions: true,
        });
        expect(saved.outcome === 'saved' && fieldSettingsSaved.parse(saved.saved).field).toMatchObject({
            version: 4,
            settings: { options: save.settings.options },
        });
        // The view reads the new options: a removed one reads as unknown.
        const page = await source.rows(ACME_REF, ACME_OPEN_VIEW, { schema: 1 });
        expect(page.fields.find((f) => f.field === 'status')?.settings.options?.map((o) => o.label)).toEqual([
            'To do',
            'In progress',
        ]);
        expect(refusal(await source.saveField(ACME_REF, 'budget', { ...save, baseVersion: 1 })).code).toBe('invalid');
        expect(
            refusal(await source.saveField(ACME_REF, 'title', { kind: 'blob', settings: {}, baseVersion: 0 })).code,
        ).toBe('invalid');
    });
});

describe('files and new rows', () => {
    it('uploads what a dataset takes, refuses the rest by code, and writes the id with a cell edit', async () => {
        const source = createFixtureViewSource();
        const bytes = new Uint8Array([1]);
        const png = await source.uploadFile(ACME_REF.datasetId, {
            body: bytes,
            name: 'acme-logo.png',
            type: 'image/png',
            bytes: 8_204,
        });
        expect(png.outcome === 'uploaded' && datasetFileUploaded.parse(png.uploaded).file).toEqual(
            WRITE_FIXTURES.datasetFileUploaded[0].file,
        );
        expect(
            refusal(
                await source.uploadFile(ACME_REF.datasetId, {
                    body: bytes,
                    name: 'a.svg',
                    type: 'image/svg+xml',
                    bytes: 10,
                }),
            ).code,
        ).toBe('unsupported_file');
        expect(
            refusal(
                await source.uploadFile(ACME_REF.datasetId, {
                    body: bytes,
                    name: 'big.pdf',
                    type: 'application/pdf',
                    bytes: FIXTURE_FILE_MAX + 1,
                }),
            ).status,
        ).toBe(413);
        const written = await source.editCell(ACME_REF, '1040', { field: 'file', from: [], to: ['f_acme_2'] });
        expect(written).toMatchObject({
            outcome: 'saved',
            written: { files: { f_acme_2: { name: 'acme-logo.png', thumb: true } } },
        });
    });

    it('creates a row with the server’s key, answers a replay with the same row, and words its problems', async () => {
        const source = createFixtureViewSource();
        const [request] = WRITE_FIXTURES.rowCreateRequest;
        const invalid = await source.createRow(ACME_REF, { status: 'opt_gone' }, 'c7f1e2a4-acme-0002');
        expect(invalid.outcome === 'invalid' && invalidWrite.parse(invalid.invalid).problems).toEqual([
            { path: '$.values.status', message: '"opt_gone" is not an option of Status.' },
            { path: '$.values.title', message: 'Title is required.' },
        ]);
        const created = await source.createRow(ACME_REF, request.values, request.createId);
        expect(created.outcome === 'created' && rowWritten.parse(created.written).row).toMatchObject({
            key: WRITE_FIXTURES.rowWritten[1].row.key,
            values: { id: 1043, title: 'Call Acme', notes: null },
        });
        expect(await source.createRow(ACME_REF, request.values, request.createId)).toMatchObject({
            outcome: 'created',
            replayed: true,
            written: { row: { key: '1043' } },
        });
        expect((await source.lookup(ACME_REF, ['1043'])).rows).toHaveLength(1);
        // Bookings' key is text: it must be sent, and a taken one is 409 key_taken.
        expect(refusal(await source.createRow(FIXTURE_REF, { id: 'b1', title: 'Again' })).code).toBe('key_taken');
        expect(await source.createRow(FIXTURE_REF, { title: 'No key' })).toMatchObject({ outcome: 'invalid' });
    });
});

describe('the CSV export', () => {
    it('writes the view as shown, with a byte-order mark and CRLF, and the Archive answers 413', async () => {
        const source = createFixtureViewSource();
        const csv = await source.exportCsv(ACME_REF, ACME_OPEN_VIEW, { name: 'Open tasks' });
        expect(csv.outcome).toBe('csv');
        const text = csv.outcome === 'csv' ? csv.text : '';
        expect(csv.outcome === 'csv' && csv.name).toBe('Open tasks.csv');
        expect(text.startsWith('﻿Owner,Title,Status\r\n')).toBe(true);
        expect(text).toContain('Ada,Ship the Acme brief,To do\r\n');
        const shared = await source.exportCsv(ACME_REF, ACME_OPEN_VIEW, { name: 'Open tasks', useDraft: false });
        expect(shared.outcome === 'csv' && shared.text.split('\r\n')[0]).toBe('﻿Title,Status,Due,Owner');
        const archive = await source.exportCsv(ACME_REF, ACME_ARCHIVE_VIEW, { name: 'Archive' });
        expect(archive.outcome === 'too-large' && exportTooLarge.parse(archive.tooLarge)).toEqual(
            WRITE_FIXTURES.exportTooLarge[0],
        );
    });
});
