import { afterEach, describe, expect, it } from 'vitest';

import type { FieldSettingsResponse } from '@socio/shared/dataset-views/contract';
import type { PluginDataset } from '@socio/shared/plugins/plugins';

import { parseManifest } from '../src/server/plugins/catalog.js';

import { cleanup, manifest, world } from './helpers/plugin-world.js';

// Field settings a plugin's manifest declares on its columns (CB-451):
// checked when the manifest is read, applied at install and update like
// the columns, added when missing and never overwriting an admin's change.

afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const STAGES = [
    { id: 'open', label: 'Open', color: 'blue' },
    { id: 'booked', label: 'Booked', color: 'green' },
];

/** Acme's events plugin: an `events` table whose columns say what they mean. */
const eventsNeed = (columns: unknown[] = []) => ({
    name: 'events',
    access: 'write',
    tables: [
        {
            table: 'events',
            columns: [
                { name: 'id', type: 'TEXT', primaryKey: true },
                { name: 'status', type: 'TEXT', field: { kind: 'select', label: 'Status', options: STAGES } },
                {
                    name: 'stated_total',
                    type: 'INTEGER',
                    field: { kind: 'currency', currency: 'USD', minorUnits: true },
                },
                { name: 'host', type: 'TEXT', field: { kind: 'person' } },
                { name: 'notes', type: 'TEXT' },
                ...columns,
            ],
        },
    ],
});
const acme = (columns?: unknown[]) => ({
    ...manifest('acme-events', [eventsNeed(columns)]),
    name: 'Acme events',
    permissions: ['person:read'],
});

describe('a manifest’s field settings', () => {
    it('are checked against the declared column type when the manifest is read', () => {
        expect(parseManifest(acme(), 'catalog').datasets![0]!.tables![0]!.columns[1]).toEqual({
            name: 'status',
            type: 'TEXT',
            field: { kind: 'select', label: 'Status', options: STAGES },
        });
        const refused =
            (column: unknown, permissions = ['person:read']) =>
            () =>
                parseManifest({ ...acme([column]), permissions }, 'catalog');
        expect(refused({ name: 'paid', type: 'TEXT', field: { kind: 'currency', currency: 'USD' } })).toThrow(
            /column paid field kind: .*stored as TEXT, which can't hold a currency field/,
        );
        expect(refused({ name: 'paid', type: 'REAL', field: { kind: 'currency', minorUnits: true } })).toThrow(
            /minor units/,
        );
        expect(refused({ name: 'paid', type: 'REAL', field: { kind: 'money' } })).toThrow(/not a field kind/);
        expect(refused({ name: 'paid', type: 'REAL', field: { kind: 'number', colour: 'red' } })).toThrow(
            /field colour is not allowed/,
        );
        expect(refused({ name: 'paid', type: 'REAL', field: 'number' })).toThrow(/field is an object/);
        // People's ids need person:read.
        expect(() => parseManifest({ ...acme(), permissions: [] }, 'catalog')).toThrow(/person field .*person:read/);
    });

    it('are applied at install, kept through updates, and an admin’s change stays', async () => {
        const f = await world({}, [acme()]);
        await f.platform.plugins.install('acme-events');
        const [dataset] = f.datasetRows('plugin:acme-events');
        const alice = await f.as('alice');
        const path = `/data/datasets/${dataset!.id}/tables/events/fields`;
        const read = async () => (await alice(path)).body as unknown as FieldSettingsResponse;
        const fields = await read();
        expect(fields.canEdit).toBe(true);
        expect(fields.fields.map((entry) => [entry.field, entry.kind, entry.version, entry.declaredBy])).toEqual([
            ['id', 'id', 0, undefined],
            ['status', 'select', 1, 'acme-events'],
            ['stated_total', 'currency', 1, 'acme-events'],
            ['host', 'person', 1, 'acme-events'],
            ['notes', 'text', 0, undefined],
        ]);
        expect(fields.fields[1]).toMatchObject({ label: 'Status', settings: { options: STAGES } });
        expect(fields.fields[2]!.settings).toEqual({ currency: 'USD', minorUnits: true });
        // The plugin writes the dataset, so people edit no cells; an admin still sets its fields.
        expect(fields.fields.every((entry) => !entry.editable)).toBe(true);

        // A member who can't read the workspace's dataset gets nothing.
        expect((await (await f.as('bob'))(path)).status).toBe(404);

        // An admin renames an option; the manifest's next run leaves it.
        const saved = await alice(`${path}/status`, 'PUT', {
            schema: 1,
            kind: 'select',
            label: 'Stage',
            settings: { options: [STAGES[0], { ...STAGES[1], label: 'Confirmed' }] },
            baseVersion: 1,
        });
        expect(saved.status).toBe(200);
        expect(saved.body.field).toMatchObject({ label: 'Stage', version: 2 });
        expect(saved.body.field).not.toHaveProperty('declaredBy');

        // An update that declares a new column with a field, and other words for the old ones.
        const update = parseManifest(
            acme([{ name: 'room', type: 'TEXT', field: { kind: 'select', options: [] } }]),
            'catalog',
        ).datasets as PluginDataset[];
        (update[0]!.tables![0]!.columns[1]!.field as { label?: string }).label = 'State';
        f.platform.data.ensurePluginDatasets('acme-events', update);
        const after = await read();
        expect(after.fields.map((entry) => [entry.field, entry.label, entry.version])).toEqual([
            ['id', 'id', 0],
            ['status', 'Stage', 2],
            ['stated_total', 'stated_total', 1],
            ['host', 'host', 1],
            ['notes', 'notes', 0],
            ['room', 'room', 1],
        ]);
        expect(after.fields[5]).toMatchObject({ kind: 'select', declaredBy: 'acme-events' });
        const audit = f.workspace.db
            .prepare(
                "SELECT actorKind, actorId, target FROM data_audit WHERE action = 'field_settings' ORDER BY createdAt, rowid",
            )
            .all()
            .map((row) => ({ ...row }));
        expect(audit).toEqual([
            { actorKind: 'plugin', actorId: 'acme-events', target: expect.stringMatching(/\.events\.status$/) },
            { actorKind: 'plugin', actorId: 'acme-events', target: expect.stringMatching(/\.events\.stated_total$/) },
            { actorKind: 'plugin', actorId: 'acme-events', target: expect.stringMatching(/\.events\.host$/) },
            { actorKind: 'user', actorId: 'alice', target: expect.stringMatching(/\.events\.status$/) },
            { actorKind: 'plugin', actorId: 'acme-events', target: expect.stringMatching(/\.events\.room$/) },
        ]);
    });
});
