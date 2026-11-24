import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { WORKSPACE_OWNER_ID, nonPersonOwnerId, type DataSpaceState, type QueryResult } from '@socio/shared/data-types';
import type { PluginBindingPlan, PluginNeedPlan } from '@socio/shared/plugins/bindings';

import { betterAuthSettingsFromEnv } from '../src/server/auth/settings.js';
import { readProblems, readsAs } from '../src/server/dataspace/domain/plugin-needs.js';
import { parseManifest } from '../src/server/plugins/catalog.js';

import { updateAcked } from './helpers/plugin-update.js';
import { cleanup, manifest, world } from './helpers/plugin-world.js';

// Workspace-allocated plugin datasets (CB-451): a plugin's manifest declares
// needs with read or write access; an admin binds each to a new or an existing
// workspace dataset, one writer per dataset; uninstalling unbinds and keeps
// the data; the `cbdt_` token reaches the bound datasets with their access;
// `plugin:<id>` datasets move to the workspace at boot.

afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

type World = Awaited<ReturnType<typeof world>>;

/** The table an events plugin writes and a dashboards plugin reads. */
const EVENTS_TABLE = {
    table: 'events',
    columns: [
        { name: 'id', type: 'TEXT', primaryKey: true },
        { name: 'event_day', type: 'TEXT' },
        { name: 'stated_total', type: 'INTEGER' },
        { name: 'as_of', type: 'DATETIME' },
    ],
};
/** What the dashboards plugin expects of it: a REAL reads an INTEGER, TEXT a DATETIME. */
const READS_EVENTS = {
    table: 'events',
    columns: [
        { name: 'id', type: 'TEXT' },
        { name: 'event_day', type: 'TEXT' },
        { name: 'stated_total', type: 'REAL' },
        { name: 'as_of', type: 'TEXT' },
    ],
};

/** Puts a manifest in the plugins' catalog, as a catalog refresh would. */
const offer = (f: World, id: string, name: string, datasets: unknown[], version = '1.0.0') =>
    (f.platform.plugins as unknown as { catalog: Map<string, unknown> }).catalog.set(
        id,
        parseManifest({ ...manifest(id, datasets), name, version }, 'catalog'),
    );

/** A plugin's token exchange, with its answer typed. */
async function token(f: World, id: string, body?: unknown) {
    const answer = await f.exchange(f.delivered(id), f.proof(id), body);
    return {
        status: answer.status,
        body: answer.body as unknown as {
            token: string;
            error?: string;
            datasets: Array<{ name: string; access: string; id: string; datasetName: string }>;
            unbound: Array<{ name: string; access: string }>;
        },
        api: f.withToken(answer.body.token),
    };
}

/** An events plugin writing its events, and a dashboards plugin offered to read them. */
async function eventsWorld() {
    const f = await world();
    offer(f, 'events', 'Events', [
        { name: 'events', access: 'write', description: 'Events, with source-stated figures', tables: [EVENTS_TABLE] },
    ]);
    offer(f, 'dashboards', 'Dashboards', [{ name: 'bookings', access: 'read', tables: [READS_EVENTS] }]);
    await f.platform.plugins.install('events');
    const events = await token(f, 'events');
    expect(events.status).toBe(200);
    expect(events.body.datasets).toMatchObject([{ name: 'events', access: 'write', datasetName: 'events' }]);
    const written = await events.api('/data/datasets/events/tables/events/rows', 'POST', {
        rows: [{ id: 'e1', event_day: '2026-11-20', stated_total: 1200, as_of: '2026-11-20T10:00:00Z' }],
    });
    expect(written.status).toBe(200);
    const datasetId = events.body.datasets[0]!.id;
    return { f, events, datasetId };
}

const need = (plan: PluginBindingPlan, name: string) => plan.needs.find((item) => item.need === name)!;

describe('the manifest (CB-451)', () => {
    it('takes read or write access on a need, and nothing else', () => {
        const parsed = parseManifest(
            manifest('dashboards', [
                { name: 'bookings', access: 'read', tables: [READS_EVENTS] },
                { name: 'notes', access: 'write' },
                { name: 'legacy' },
            ]),
            'catalog',
        );
        expect(parsed.datasets?.map((item) => item.access)).toEqual(['read', 'write', undefined]);
        expect(() => parseManifest(manifest('dashboards', [{ name: 'bookings', access: 'admin' }]), 'catalog')).toThrow(
            /access is read or write/,
        );
    });

    it('reads a column as the type a need expects only when it is the same or widens', () => {
        expect(readsAs('REAL', 'INTEGER')).toBe(true);
        expect(readsAs('TEXT', 'DATETIME')).toBe(true);
        expect(readsAs('TEXT', 'DATE')).toBe(true);
        expect(readsAs('DECIMAL(10,2)', 'BIGINT')).toBe(true);
        expect(readsAs(undefined, 'TEXT')).toBe(true);
        expect(readsAs('INTEGER', 'REAL')).toBe(false);
        expect(readsAs('TEXT', 'INTEGER')).toBe(false);
        expect(readsAs('DATETIME', 'TEXT')).toBe(false);
        const have = [
            {
                name: 'events',
                rowCount: 0,
                columns: [
                    { name: 'id', type: 'TEXT', notNull: false, primaryKey: true, defaultValue: null },
                    { name: 'extra', type: 'TEXT', notNull: false, primaryKey: false, defaultValue: null },
                ],
            },
        ];
        // Extra tables and columns are fine; missing ones are named.
        expect(readProblems([{ table: 'events', columns: [{ name: 'id' }] }], have)).toEqual([]);
        expect(
            readProblems(
                [
                    { table: 'events', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'gone' }] },
                    { table: 'other', columns: [{ name: 'a' }] },
                ],
                have,
            ),
        ).toEqual([
            'column "events.id" is TEXT, expected INTEGER',
            'column "events.gone" is missing',
            'table "other" is missing',
        ]);
    });
});

describe('the workspace owner (CB-451)', () => {
    it('is no person’s id: auth refuses every non-person owner id', () => {
        expect(nonPersonOwnerId(WORKSPACE_OWNER_ID)).toBe(true);
        expect(WORKSPACE_OWNER_ID).toBe('ws:workspace');
        // A person may be called "workspace": no dataset is theirs by it.
        expect(nonPersonOwnerId('workspace')).toBe(false);
        const origin = 'https://socio.example';
        const settings = (links: Record<string, string>) =>
            betterAuthSettingsFromEnv(
                { AUTH_PROVIDER: 'betterauth', APP_ORIGIN: origin, AUTH_LINK_USERS: JSON.stringify(links) },
                [origin],
                'plugin-dataset-bindings-session-secret-0123',
                () => '',
                () => ({ scopes: [], labels: {} }),
            );
        for (const id of ['ws:workspace', 'ws:anything', 'plugin:events', 'socio:d1']) {
            expect(() => settings({ [id]: 'a@example.com' }), id).toThrow(/AUTH_LINK_USERS/);
        }
        expect(settings({ workspace: 'a@example.com' }).rules.links.get('a@example.com')).toBe('workspace');
    });
});

describe('workspace-allocated plugin datasets (CB-451)', () => {
    it('binds a reader to a writer’s dataset at install; its token reads with no person present and never writes', async () => {
        const { f, datasetId } = await eventsWorld();
        const alice = await f.as('alice');
        const bob = await f.as('bob');
        // The install screen's plan: a read need has no default; the events
        // dataset fits it, and says who writes it.
        const planned = await alice('/plugins/dashboards/bindings');
        expect(planned.status).toBe(200);
        const bookings = need(planned.body as unknown as PluginBindingPlan, 'bookings');
        expect(bookings).toMatchObject({ access: 'read', implicit: false, preselected: null });
        expect(bookings.candidates.find((item) => item.id === datasetId)).toEqual({
            id: datasetId,
            name: 'events',
            description: 'Events, with source-stated figures',
            writer: { id: 'events', name: 'Events' },
        });
        // Members neither see nor change bindings.
        expect((await bob('/plugins/dashboards/bindings')).status).toBe(403);
        expect((await bob('/plugins/dashboards/install', 'POST', {})).status).toBe(403);

        // Installed through the route with the admin's choice.
        const installed = await alice('/plugins/dashboards/install', 'POST', {
            bindings: { bookings: { datasetId } },
        });
        expect(installed.status).toBe(200);
        const binding = f.workspace.db
            .prepare('SELECT need, access, boundBy, unboundAt FROM data_plugin_bindings WHERE pluginId=?')
            .all('dashboards')
            .map((row) => ({ ...row }));
        expect(binding).toEqual([{ need: 'bookings', access: 'read', boundBy: 'alice', unboundAt: null }]);

        // Its own scheduled work: the identity exchanged for a token, no x-cb-obo.
        const reader = await token(f, 'dashboards');
        expect(reader.status).toBe(200);
        expect(reader.body.datasets).toEqual([
            { name: 'bookings', access: 'read', id: datasetId, datasetName: 'events', description: expect.any(String) },
        ]);
        expect(reader.body.unbound).toEqual([]);
        const read = await reader.api('/data/datasets/bookings/query', 'POST', {
            sql: 'SELECT id, stated_total FROM events',
        });
        expect(read.status).toBe(200);
        expect((read.body as unknown as QueryResult).rows).toEqual([['e1', 1200]]);
        expect((await reader.api('/data/datasets/bookings')).body).toMatchObject({ access: 'read' });

        // A reader token can't write: rows, batches, tables, indexes, history.
        for (const [path, method, body] of [
            ['/data/datasets/bookings/tables/events/rows', 'POST', { rows: [{ id: 'e2' }] }],
            ['/data/datasets/bookings/batch', 'POST', { statements: [{ sql: "UPDATE events SET event_day = 'x'" }] }],
            ['/data/datasets/bookings/tables', 'POST', { table: 'mine', columns: [{ name: 'a' }] }],
            ['/data/datasets/bookings/tables/events/columns', 'POST', { column: { name: 'mine' } }],
            ['/data/datasets/bookings/tables/events/indexes', 'POST', { name: 'by_day', columns: ['event_day'] }],
            ['/data/datasets/bookings/tables/events', 'PATCH', { history: false }],
        ] as const) {
            const refused = await reader.api(path, method, body);
            expect(refused.status, `${method} ${path}`).toBe(403);
        }
        const rows = await reader.api('/data/datasets/bookings/query', 'POST', { sql: 'SELECT count(*) FROM events' });
        expect((rows.body as unknown as QueryResult).rows).toEqual([[1]]);
        const denied = f.workspace.db
            .prepare(
                "SELECT count(*) AS n FROM data_audit WHERE actorId='dashboards' AND outcome='denied' AND detail='write on a read binding'",
            )
            .get() as { n: number };
        expect(Number(denied.n)).toBeGreaterThan(0);

        // The Data page names the writer and, for admins, the readers.
        const state = (await alice('/data?files=false')).body as unknown as DataSpaceState;
        expect(state.datasets.find((item) => item.id === datasetId)).toMatchObject({
            ownerUserId: 'ws:workspace',
            access: 'owner',
            plugin: { id: 'events', name: 'Events' },
            readers: [{ id: 'dashboards', name: 'Dashboards' }],
        });
    });

    it('never lets a plugin reach a dataset not bound to it', async () => {
        const { f, datasetId } = await eventsWorld();
        // Not now: the read need stays unbound, and the token answer says so.
        await f.platform.plugins.install('dashboards', {}, { bindings: { bookings: null }, by: 'alice' });
        const none = await token(f, 'dashboards');
        expect(none.status).toBe(404);
        expect(none.body.unbound).toEqual([{ name: 'bookings', access: 'read' }]);
        // Another plugin's workspace datasets, by id or by name, are out of reach.
        await f.platform.plugins.install('datasync');
        const datasync = await token(f, 'datasync');
        for (const ref of [datasetId, 'events', 'bookings']) {
            expect((await datasync.api(`/data/datasets/${ref}`)).status, ref).toBe(404);
            expect((await datasync.api(`/data/datasets/${ref}/query`, 'POST', { sql: 'SELECT 1' })).status, ref).toBe(
                404,
            );
        }
        // Narrowing to a need it doesn't have bound is refused.
        expect((await token(f, 'datasync', { datasets: ['events'] })).status).toBe(404);
        // Bound later on its page, the need is covered; unbound again, a token
        // made meanwhile stops reaching it at once.
        const alice = await f.as('alice');
        const bound = await alice('/plugins/dashboards/bindings/bookings', 'PUT', { choice: { datasetId } });
        expect(bound.status).toBe(200);
        expect(bound.body).toMatchObject({ need: 'bookings', bound: { datasetId, datasetName: 'events' } });
        const reader = await token(f, 'dashboards');
        expect(reader.status).toBe(200);
        expect((await reader.api('/data/datasets/bookings')).status).toBe(200);
        expect((await alice('/plugins/dashboards/bindings/bookings', 'PUT', { choice: null })).status).toBe(200);
        const after = await reader.api('/data/datasets/bookings');
        expect([401, 404]).toContain(after.status);
        const again = await token(f, 'dashboards');
        expect(again.status).toBe(404);
        // A write need is always bound while installed.
        expect((await alice('/plugins/events/bindings/events', 'PUT', { choice: null })).status).toBe(409);
        expect((await alice('/plugins/events/bindings/nope', 'PUT', { choice: null })).status).toBe(404);
        expect((await alice('/plugins/events/bindings/events', 'PUT', { choice: 'maybe' })).status).toBe(400);
    });

    it('refuses a second writer for a dataset', async () => {
        const { f, datasetId } = await eventsWorld();
        offer(f, 'copycat', 'Copycat', [{ name: 'events', access: 'write', tables: [EVENTS_TABLE] }]);
        const plan = f.platform.plugins.bindingPlan('copycat');
        expect(need(plan, 'events').preselected).toBe('new');
        expect(need(plan, 'events').candidates.find((item) => item.id === datasetId)?.problem).toMatch(
            /written by Events, and a dataset has one writer/,
        );
        await expect(
            f.platform.plugins.install('copycat', {}, { bindings: { events: { datasetId } } }),
        ).rejects.toThrow(/one writer/);
        // Nothing of the refused install stayed.
        expect(f.platform.plugins.get('copycat')).toBeUndefined();
        expect(
            f.workspace.db.prepare('SELECT count(*) AS n FROM data_plugin_bindings WHERE pluginId=?').get('copycat'),
        ).toEqual({ n: 0 });
        // The unique index holds it whatever the path: a second live writer row is refused.
        expect(() =>
            f.workspace.db
                .prepare(
                    "INSERT INTO data_plugin_bindings(id, pluginId, need, datasetId, access, boundBy, boundAt) VALUES ('x', 'copycat', 'events', ?, 'write', 'test', 1)",
                )
                .run(datasetId),
        ).toThrow(/UNIQUE/);

        // People, socios and admins read it, but don't write it.
        const alice = await f.as('alice');
        const dot = f.workspace.dots()[0]!;
        expect((await alice('/data/grants', 'PUT', { dotId: dot.id, datasetId, access: 'write' })).status).toBe(200);
        const chat = { kind: 'dot' as const, userId: 'alice', dotId: dot.id };
        await expect(
            f.platform.data.write(chat, datasetId, { op: 'insert', table: 'events', rows: [{ id: 'socio' }] }),
        ).rejects.toThrow(/Written by Events/);
        expect(
            (
                await alice(`/data/datasets/${datasetId}/tables/events/indexes`, 'POST', {
                    name: 'by_day',
                    columns: ['event_day'],
                })
            ).body,
        ).toMatchObject({ error: expect.stringMatching(/Written by Events/) });
        const read = await f.platform.data.query(chat, datasetId, 'SELECT count(*) FROM events');
        expect(read.rows).toEqual([[1]]);
    });

    it('refuses a bind the dataset’s columns don’t fit', async () => {
        const { f, datasetId } = await eventsWorld();
        offer(f, 'misfit', 'Misfit', [
            {
                name: 'bookings',
                access: 'read',
                tables: [{ table: 'events', columns: [{ name: 'id' }, { name: 'refunds', type: 'INTEGER' }] }],
            },
        ]);
        offer(f, 'strict', 'Strict', [
            {
                name: 'bookings',
                access: 'read',
                tables: [{ table: 'events', columns: [{ name: 'stated_total', type: 'TEXT' }] }],
            },
        ]);
        expect(need(f.platform.plugins.bindingPlan('misfit'), 'bookings').candidates[0]?.problem).toMatch(
            /column "events.refunds" is missing/,
        );
        await expect(
            f.platform.plugins.install('misfit', {}, { bindings: { bookings: { datasetId } } }),
        ).rejects.toThrow(/column "events.refunds" is missing/);
        await expect(
            f.platform.plugins.install('strict', {}, { bindings: { bookings: { datasetId } } }),
        ).rejects.toThrow(/column "events.stated_total" is INTEGER, expected TEXT/);
        // A read need never makes a dataset; a write need's existing dataset
        // takes its declared tables by the additive rule.
        await expect(f.platform.plugins.install('misfit', {}, { bindings: { bookings: 'new' } })).rejects.toThrow(
            /reads: bind it to an existing dataset/,
        );
        expect(f.platform.plugins.get('misfit')).toBeUndefined();
    });

    it('refuses a writer’s schema change that would break a reader, naming the reader', async () => {
        const { f, datasetId } = await eventsWorld();
        await f.platform.plugins.install('dashboards', {}, { bindings: { bookings: { datasetId } } });
        // Version 2 of the writer retypes a column the reader expects.
        offer(
            f,
            'events',
            'Events',
            [
                {
                    name: 'events',
                    access: 'write',
                    tables: [
                        {
                            ...EVENTS_TABLE,
                            columns: EVENTS_TABLE.columns.map((column) =>
                                column.name === 'stated_total' ? { ...column, type: 'TEXT' } : column,
                            ),
                        },
                    ],
                },
            ],
            '2.0.0',
        );
        await expect(updateAcked(f.platform.plugins, 'events', 'alice')).rejects.toThrow(
            /would break Dashboards, which reads it \(its need “bookings”\): column "events.stated_total" is TEXT, expected REAL/,
        );
        expect(f.platform.plugins.get('events')).toMatchObject({ version: '1.0.0' });
        // Disabled, the update is checked the same way before it is adopted.
        await f.platform.plugins.setEnabled('events', false);
        await expect(updateAcked(f.platform.plugins, 'events', 'alice')).rejects.toThrow(/would break Dashboards/);
        await f.platform.plugins.setEnabled('events', true);
        // An additive change never breaks a reader.
        offer(
            f,
            'events',
            'Events',
            [
                {
                    name: 'events',
                    access: 'write',
                    tables: [
                        {
                            ...EVENTS_TABLE,
                            columns: [...EVENTS_TABLE.columns, { name: 'balance_due', type: 'INTEGER' }],
                        },
                    ],
                },
            ],
            '2.1.0',
        );
        await expect(updateAcked(f.platform.plugins, 'events', 'alice')).resolves.toMatchObject({
            changed: true,
            to: '2.1.0',
        });
        // A reader's own update that no longer fits is refused too.
        offer(
            f,
            'dashboards',
            'Dashboards',
            [{ name: 'bookings', access: 'read', tables: [{ table: 'events', columns: [{ name: 'gone' }] }] }],
            '2.0.0',
        );
        await expect(updateAcked(f.platform.plugins, 'dashboards', 'alice')).rejects.toThrow(
            /would no longer fit “events”/,
        );
    });

    it('keeps the data when the writer is uninstalled, and offers it preselected on reinstall', async () => {
        const { f, datasetId } = await eventsWorld();
        await f.platform.plugins.install('dashboards', {}, { bindings: { bookings: { datasetId } } });
        const alice = await f.as('alice');
        expect((await alice('/plugins/events', 'DELETE')).status).toBe(200);
        // The dataset stays, the workspace's, with its rows; the writer's
        // binding ended, the reader's didn't.
        const bindings = () =>
            f.workspace.db
                .prepare(
                    'SELECT pluginId, access, unboundAt IS NOT NULL AS ended FROM data_plugin_bindings ORDER BY pluginId',
                )
                .all()
                .map((row) => ({ ...row }));
        expect(bindings()).toEqual([
            { pluginId: 'dashboards', access: 'read', ended: 0 },
            { pluginId: 'events', access: 'write', ended: 1 },
        ]);
        const state = (await alice('/data?files=false')).body as unknown as DataSpaceState;
        const kept = state.datasets.find((item) => item.id === datasetId)!;
        expect(kept).toMatchObject({ ownerUserId: 'ws:workspace', wasWrittenBy: { id: 'events' } });
        expect(kept.plugin).toBeUndefined();
        const reader = await token(f, 'dashboards');
        const rows = await reader.api('/data/datasets/bookings/query', 'POST', { sql: 'SELECT count(*) FROM events' });
        expect((rows.body as unknown as QueryResult).rows).toEqual([[1]]);
        // With no live writer, an admin's change is no longer refused: only a
        // live write binding makes a dataset one plugin's.
        expect(
            (
                await alice(`/data/datasets/${datasetId}/tables/events/indexes`, 'POST', {
                    name: 'by_day',
                    columns: ['event_day'],
                })
            ).status,
        ).toBe(200);

        // Reinstalling: the previous dataset is offered preselected.
        const plan = (await alice('/plugins/events/bindings')).body as unknown as PluginBindingPlan;
        const events: PluginNeedPlan = need(plan, 'events');
        expect(plan.installed).toBe(false);
        expect(events.previous).toEqual({ datasetId, datasetName: 'events' });
        expect(events.preselected).toEqual({ datasetId });
        // Nothing is taken back silently: without the choice, a new dataset.
        await f.platform.plugins.install('events');
        const fresh = await token(f, 'events');
        expect(fresh.body.datasets[0]!.id).not.toBe(datasetId);
        await f.platform.plugins.uninstall('events');
        // With the preselected choice, its data again.
        expect((await alice('/plugins/events/install', 'POST', { bindings: { events: { datasetId } } })).status).toBe(
            200,
        );
        const back = await token(f, 'events');
        expect(back.body.datasets[0]!.id).toBe(datasetId);
        const count = await back.api('/data/datasets/events/query', 'POST', { sql: 'SELECT count(*) FROM events' });
        expect((count.body as unknown as QueryResult).rows).toEqual([[1]]);
    });

    it('moves plugin:<id> datasets to the workspace at boot, keeping ids, grants, sharing and retention, with no gap for the previous release', async () => {
        const f = await world();
        await f.platform.plugins.install('datasync');
        const before = await token(f, 'datasync');
        await before.api('/data/datasets/stripe/tables', 'POST', {
            table: 'charges',
            columns: [{ name: 'id', type: 'TEXT', primaryKey: true }],
        });
        await before.api('/data/datasets/stripe/tables/charges/rows', 'POST', { rows: [{ id: 'ch_1' }] });
        const ids = Object.fromEntries(before.body.datasets.map((item) => [item.name, item.id]));
        const alice = await f.as('alice');
        const dot = f.workspace.dots()[0]!;
        const space = f.workspace.spaces()[0]!;
        await alice('/data/grants', 'PUT', { dotId: dot.id, datasetId: ids.stripe, access: 'read' });
        await alice(`/data/datasets/${ids.stripe}`, 'PATCH', { sharedSpaceId: space.id, retentionDays: 90 });

        // Back to how a release before CB-451 left them: owned by the plugin,
        // in its directory, with no bindings; and one of a plugin since uninstalled.
        const db = f.workspace.db;
        const data = f.platform.data;
        for (const id of Object.values(ids)) {
            const to = data.datasetPath({ id, ownerUserId: 'plugin:datasync' });
            mkdirSync(dirname(to), { recursive: true });
            renameSync(data.datasetPath({ id, ownerUserId: 'ws:workspace' }), to);
        }
        db.exec(
            "UPDATE data_datasets SET ownerUserId='plugin:datasync' WHERE ownerUserId='ws:workspace'; UPDATE data_grants SET ownerUserId='plugin:datasync' WHERE ownerUserId='ws:workspace'; DELETE FROM data_plugin_bindings;",
        );
        const gone = data.createDataset('plugin:gone', { name: 'old' });

        /**
         * The previous release's lookup of a plugin's datasets, as its
         * `pluginRows` and `datasetPath` read them: live rows owned by
         * `plugin:<id>`, by the names the manifest declares, whose file is in
         * that owner's directory.
         */
        const previousRelease = (pluginId: string, names: string[]) =>
            (
                db
                    .prepare(
                        'SELECT id, name, ownerUserId FROM data_datasets WHERE ownerUserId=? AND deletedAt IS NULL',
                    )
                    .all(`plugin:${pluginId}`) as Array<{ id: string; name: string; ownerUserId: string }>
            )
                .filter((row) => names.includes(row.name) && existsSync(data.datasetPath(row)))
                .map((row) => row.id)
                .sort();

        // A deploy: a runtime of the previous release still runs (registered,
        // without the workspace-datasets contract).
        const now = Date.now();
        db.prepare('INSERT INTO runtime_instances VALUES(?,?,?,?,NULL)').run('old-release', now, now, now + 60_000);
        expect(data.adoptPluginOwnedDatasets()).toEqual({ bound: 2, moved: 0 });
        // The previous release still finds them, where it looks, with their rows.
        expect(previousRelease('datasync', ['stripe', 'marts'])).toEqual(Object.values(ids).sort());
        // This release's token reaches them by their bindings, and names their
        // dataset ids too, which the previous release's runtimes check.
        const during = await token(f, 'datasync');
        expect(during.body.datasets.map((item) => item.id).sort()).toEqual(Object.values(ids).sort());
        const scope = data.tokens.resolve(during.body.token)!;
        expect(Object.values(ids).every((id) => scope.datasetIds?.includes(id))).toBe(true);
        const read = await during.api('/data/datasets/stripe/query', 'POST', { sql: 'SELECT count(*) FROM charges' });
        expect((read.body as unknown as QueryResult).rows).toEqual([[1]]);
        // A plugin installed during the deploy gets datasets the previous release finds too.
        offer(f, 'fresh', 'Fresh', [{ name: 'notes' }]);
        await f.platform.plugins.install('fresh');
        const notes = (await token(f, 'fresh')).body.datasets[0]!.id;
        expect(previousRelease('fresh', ['notes'])).toEqual([notes]);

        // The previous release's runtime stops: now they move.
        db.prepare('UPDATE runtime_instances SET releasedAt=? WHERE id=?').run(Date.now(), 'old-release');
        expect(data.adoptPluginOwnedDatasets()).toEqual({ bound: 0, moved: 4 });
        // Repeating it changes nothing.
        expect(data.adoptPluginOwnedDatasets()).toEqual({ bound: 0, moved: 0 });
        const rows = db
            .prepare('SELECT id, ownerUserId, sharedSpaceId, retentionDays FROM data_datasets ORDER BY name')
            .all()
            .map((row) => ({ ...row }));
        expect(rows).toEqual(
            expect.arrayContaining([
                { id: ids.stripe, ownerUserId: 'ws:workspace', sharedSpaceId: space.id, retentionDays: 90 },
                { id: ids.marts, ownerUserId: 'ws:workspace', sharedSpaceId: null, retentionDays: null },
                { id: gone.id, ownerUserId: 'ws:workspace', sharedSpaceId: null, retentionDays: null },
                { id: notes, ownerUserId: 'ws:workspace', sharedSpaceId: null, retentionDays: null },
            ]),
        );
        for (const id of [...Object.values(ids), gone.id, notes]) {
            expect(existsSync(data.datasetPath({ id, ownerUserId: 'ws:workspace' }))).toBe(true);
        }
        expect(db.prepare('SELECT ownerUserId, access FROM data_grants WHERE datasetId=?').get(ids.stripe)).toEqual({
            ownerUserId: 'ws:workspace',
            access: 'read',
        });
        // The installed plugin's datasets are bound write under their names;
        // the uninstalled one's is an unbound workspace dataset.
        expect(
            db
                .prepare('SELECT pluginId, need, datasetId, access FROM data_plugin_bindings ORDER BY need')
                .all()
                .map((row) => ({ ...row })),
        ).toEqual([
            { pluginId: 'datasync', need: 'marts', datasetId: ids.marts, access: 'write' },
            { pluginId: 'fresh', need: 'notes', datasetId: notes, access: 'write' },
            { pluginId: 'datasync', need: 'stripe', datasetId: ids.stripe, access: 'write' },
        ]);
        expect(
            db
                .prepare("SELECT count(*) AS n FROM data_audit WHERE action='adopt_plugin_dataset' AND outcome='ok'")
                .get(),
        ).toEqual({ n: 4 });
        // The socio's grant, the Space share and the plugin's token still work.
        const chat = { kind: 'dot' as const, userId: 'bob', dotId: dot.id };
        expect(data.visible(chat).find((item) => item.row.id === ids.stripe)).toMatchObject({ access: 'read' });
        const after = await token(f, 'datasync');
        expect(after.body.datasets.map((item) => item.id).sort()).toEqual(Object.values(ids).sort());
        const count = await after.api('/data/datasets/stripe/query', 'POST', { sql: 'SELECT count(*) FROM charges' });
        expect((count.body as unknown as QueryResult).rows).toEqual([[1]]);
        // A binding an admin ended is never made again by the boot step.
        await f.platform.plugins.uninstall('fresh');
        expect(data.adoptPluginOwnedDatasets()).toEqual({ bound: 0, moved: 0 });
    });

    it('keeps a failed update’s access out of reach, and puts the bindings back', async () => {
        const { f, datasetId } = await eventsWorld();
        await f.platform.plugins.uninstall('events');
        // A reader of the dataset, now writerless; its version 2 would write it.
        await f.platform.plugins.install('dashboards', {}, { bindings: { bookings: { datasetId } } });
        offer(f, 'dashboards', 'Dashboards', [{ name: 'bookings', access: 'write', tables: [EVENTS_TABLE] }], '2.0.0');
        const runtime = (f.platform.plugins as unknown as { options: { runtime: { provisionService: unknown } } })
            .options.runtime;
        const provision = runtime.provisionService;
        runtime.provisionService = async () => {
            throw new Error('the runtime refused it');
        };
        await expect(updateAcked(f.platform.plugins, 'dashboards', 'alice')).rejects.toThrow();
        runtime.provisionService = provision;
        expect(f.platform.plugins.get('dashboards')).toMatchObject({ version: '1.0.0' });
        const bindings = () =>
            f.workspace.db
                .prepare('SELECT need, access FROM data_plugin_bindings WHERE pluginId=? AND unboundAt IS NULL')
                .all('dashboards')
                .map((row) => ({ ...row }));
        expect(bindings()).toEqual([{ need: 'bookings', access: 'read' }]);
        // A fresh token still only reads.
        const reader = await token(f, 'dashboards');
        expect(reader.body.datasets).toMatchObject([{ name: 'bookings', access: 'read' }]);
        expect(
            (await reader.api('/data/datasets/bookings/tables/events/rows', 'POST', { rows: [{ id: 'x' }] })).status,
        ).toBe(403);
        // Even a write binding a staged update left behind writes nothing
        // while the installed manifest says read: the manifest is the ceiling.
        f.workspace.db.prepare("UPDATE data_plugin_bindings SET access='write' WHERE pluginId='dashboards'").run();
        const ceiling = await token(f, 'dashboards');
        expect(ceiling.body.datasets).toMatchObject([{ name: 'bookings', access: 'read' }]);
        expect(
            (await ceiling.api('/data/datasets/bookings/tables/events/rows', 'POST', { rows: [{ id: 'x' }] })).status,
        ).toBe(403);
        f.workspace.db.prepare("UPDATE data_plugin_bindings SET access='read' WHERE pluginId='dashboards'").run();
        // Adopted, the update writes.
        await updateAcked(f.platform.plugins, 'dashboards', 'alice');
        expect(bindings()).toEqual([{ need: 'bookings', access: 'write' }]);
        const writer = await token(f, 'dashboards');
        expect(
            (await writer.api('/data/datasets/bookings/tables/events/rows', 'POST', { rows: [{ id: 'x' }] })).status,
        ).toBe(200);
    });

    it('keeps a narrowed token to the needs and access it names', async () => {
        const f = await world();
        offer(f, 'both', 'Both', [
            { name: 'store', access: 'write', tables: [EVENTS_TABLE] },
            { name: 'view', access: 'read', tables: [READS_EVENTS] },
        ]);
        await f.platform.plugins.install('both', {}, { bindings: { view: null } });
        const store = (await token(f, 'both')).body.datasets[0]!.id;
        const alice = await f.as('alice');
        expect((await alice('/plugins/both/bindings/view', 'PUT', { choice: { datasetId: store } })).status).toBe(200);
        // Narrowed to the read need alone, on the dataset its write need writes.
        const narrow = await token(f, 'both', { datasets: ['view'] });
        expect(narrow.body.datasets).toMatchObject([{ name: 'view', access: 'read', id: store }]);
        // By the need, the id, or the dataset's own name: the same dataset, read only.
        for (const ref of ['view', store, 'store']) {
            const insert = await narrow.api(`/data/datasets/${ref}/tables/events/rows`, 'POST', {
                rows: [{ id: 'x' }],
            });
            expect(insert.status, ref).toBe(403);
            expect((await narrow.api(`/data/datasets/${ref}/query`, 'POST', { sql: 'SELECT 1' })).status, ref).toBe(
                200,
            );
        }
        // The whole token writes through its write need.
        const whole = await token(f, 'both');
        expect(
            (await whole.api('/data/datasets/store/tables/events/rows', 'POST', { rows: [{ id: 'y' }] })).status,
        ).toBe(200);
    });

    it('ends the bindings of needs an adopted manifest removes, and applies access changes, enabled or not', async () => {
        const { f, datasetId } = await eventsWorld();
        await f.platform.plugins.install('dashboards', {}, { bindings: { bookings: { datasetId } } });
        const live = (pluginId: string) =>
            f.workspace.db
                .prepare('SELECT need, access FROM data_plugin_bindings WHERE pluginId=? AND unboundAt IS NULL')
                .all(pluginId)
                .map((row) => ({ ...row }));
        // Disabled, the writer's update declares no need at all: its writer binding ends.
        await f.platform.plugins.setEnabled('events', false);
        offer(f, 'events', 'Events', [], '2.0.0');
        await updateAcked(f.platform.plugins, 'events', 'alice');
        expect(live('events')).toEqual([]);
        expect(f.platform.data.adoptPluginOwnedDatasets()).toEqual({ bound: 0, moved: 0 });
        // Another plugin may write the dataset now.
        offer(f, 'next', 'Next', [{ name: 'events', access: 'write', tables: [EVENTS_TABLE] }]);
        await f.platform.plugins.install('next', {}, { bindings: { events: { datasetId } } });
        expect(live('next')).toEqual([{ need: 'events', access: 'write' }]);
        // Enabled, an update that turns a write need into a read need keeps
        // the dataset, read only, and frees it for another writer.
        offer(f, 'next', 'Next', [{ name: 'events', access: 'read', tables: [READS_EVENTS] }], '2.0.0');
        await updateAcked(f.platform.plugins, 'next', 'alice');
        expect(live('next')).toEqual([{ need: 'events', access: 'read' }]);
        expect(
            f.workspace.db
                .prepare(
                    "SELECT count(*) AS n FROM data_plugin_bindings WHERE datasetId=? AND access='write' AND unboundAt IS NULL",
                )
                .get(datasetId),
        ).toEqual({ n: 0 });
        // Disabled, an update that removes the last need ends its binding too.
        await f.platform.plugins.setEnabled('dashboards', false);
        offer(f, 'dashboards', 'Dashboards', [], '2.0.0');
        await updateAcked(f.platform.plugins, 'dashboards', 'alice');
        expect(live('dashboards')).toEqual([]);
    });
});

/**
 * A writer on another runtime: a process that opens a dataset's file,
 * takes the write lock as every writer does (`BEGIN IMMEDIATE`), writes a
 * row, holds the lock a while, then commits. Resolves once it holds the lock.
 */
function otherRuntimeWriter(path: string, sql: string, holdMs: number) {
    const script = `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(process.argv[1]);
        db.exec('PRAGMA busy_timeout=5000');
        db.exec('BEGIN IMMEDIATE');
        db.exec(process.argv[2]);
        process.stdout.write('locked\\n');
        setTimeout(() => { db.exec('COMMIT'); db.close(); process.stdout.write('committed\\n'); }, Number(process.argv[3]));
    `;
    const child = spawn(process.execPath, ['-e', script, path, sql, String(holdMs)], {
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    const seen = (word: string) =>
        new Promise<void>((resolve, reject) => {
            const check = () => (out.includes(word) ? resolve() : undefined);
            child.stdout.on('data', (chunk: Buffer) => {
                out += chunk.toString();
                check();
            });
            child.on('exit', (code) => (out.includes(word) ? resolve() : reject(new Error(`writer exited ${code}`))));
            check();
        });
    return { locked: seen('locked'), done: seen('committed') };
}

describe('moving a dataset’s file under its write lock (CB-451)', () => {
    it('lets a write in flight on another runtime finish before the move, and loses no row', async () => {
        const f = await world();
        await f.platform.plugins.install('datasync');
        const api = (await token(f, 'datasync')).api;
        await api('/data/datasets/stripe/tables', 'POST', {
            table: 'charges',
            columns: [{ name: 'id', type: 'TEXT', primaryKey: true }],
        });
        await api('/data/datasets/stripe/tables/charges/rows', 'POST', { rows: [{ id: 'before' }] });
        const db = f.workspace.db;
        const data = f.platform.data;
        const id = (await token(f, 'datasync')).body.datasets.find((item) => item.name === 'stripe')!.id;
        // As the previous release left it: the plugin's, in its directory.
        const old = data.datasetPath({ id, ownerUserId: 'plugin:datasync' });
        mkdirSync(dirname(old), { recursive: true });
        renameSync(data.datasetPath({ id, ownerUserId: 'ws:workspace' }), old);
        db.prepare("UPDATE data_datasets SET ownerUserId='plugin:datasync' WHERE id=?").run(id);

        // A write is in flight when the move starts: the move waits for it.
        const writer = otherRuntimeWriter(old, "INSERT INTO charges(id) VALUES ('during')", 800);
        await writer.locked;
        const started = Date.now();
        expect(data.adoptPluginOwnedDatasets().moved).toBe(1);
        expect(Date.now() - started).toBeGreaterThanOrEqual(500);
        await writer.done;
        const moved = data.datasetPath({ id, ownerUserId: 'ws:workspace' });
        expect(existsSync(old)).toBe(false);
        expect(existsSync(`${moved}-journal`)).toBe(false);
        // Both rows are in the moved file, and the next write lands there too.
        await api('/data/datasets/stripe/tables/charges/rows', 'POST', { rows: [{ id: 'after' }] });
        const rows = await api('/data/datasets/stripe/query', 'POST', { sql: 'SELECT id FROM charges ORDER BY id' });
        expect((rows.body as unknown as QueryResult).rows).toEqual([['after'], ['before'], ['during']]);
        // A writer that read the old row is refused, never given an empty file there.
        expect(() => data.engine.whileLocked(old, () => undefined)).toThrow();
        expect(existsSync(old)).toBe(false);
    });

    it('lets a write in flight finish before a transfer links a person’s dataset, and loses no row', async () => {
        const f = await world();
        const data = f.platform.data;
        const mine = data.createDataset('alice', { name: 'mine' });
        const path = data.datasetPath({ id: mine.id, ownerUserId: 'alice' });
        const setup = otherRuntimeWriter(path, "CREATE TABLE t(id TEXT); INSERT INTO t VALUES ('before')", 0);
        await setup.done;
        const writer = otherRuntimeWriter(path, "INSERT INTO t VALUES ('during')", 800);
        await writer.locked;
        const handle = await data.prepareTransfer({ from: 'alice', to: 'bob', fromName: 'Alice', toName: 'Bob' });
        f.workspace.db.exec('BEGIN');
        handle.commit();
        f.workspace.db.exec('COMMIT');
        await writer.done;
        await handle.finish();
        const moved = data.datasetPath({ id: mine.id, ownerUserId: 'bob' });
        const read = await data.query({ kind: 'user', userId: 'bob' }, mine.id, 'SELECT id FROM t ORDER BY id');
        expect(read.rows).toEqual([['before'], ['during']]);
        expect(existsSync(moved)).toBe(true);
    });
});

describe('a plugin’s needs while an update is under way, and two needs on one dataset (CB-451)', () => {
    it('keeps existing tokens working while a staged update adds a write need, until it is adopted', async () => {
        const { f, events } = await eventsWorld();
        offer(
            f,
            'events',
            'Events',
            [
                { name: 'events', access: 'write', tables: [EVENTS_TABLE] },
                { name: 'archive', access: 'write' },
            ],
            '2.0.0',
        );
        // The runtime takes its time: the update waits there, its new need bound (staged).
        const runtime = (f.platform.plugins as unknown as { options: { runtime: { provisionService: unknown } } })
            .options.runtime;
        const provision = runtime.provisionService as (...args: unknown[]) => Promise<unknown>;
        let release!: () => void;
        const paused = new Promise<void>((resolve) => (release = resolve));
        runtime.provisionService = async (...args: unknown[]) => {
            await paused;
            return provision(...args);
        };
        const updating = updateAcked(f.platform.plugins, 'events', 'alice');
        const staged = () =>
            f.workspace.db
                .prepare(
                    "SELECT count(*) AS n FROM data_plugin_bindings WHERE pluginId='events' AND need='archive' AND unboundAt IS NULL",
                )
                .get() as { n: number };
        expect(Number(staged().n)).toBe(1);
        // Meanwhile the token it had, and a new one, work as before, without the staged need.
        const listed = await events.api('/data/datasets');
        expect(listed.status).toBe(200);
        expect((listed.body as unknown as Array<{ name: string }>).map((item) => item.name)).toEqual(['events']);
        expect((await events.api('/data/datasets/archive')).status).toBe(404);
        const during = await token(f, 'events');
        expect(during.status).toBe(200);
        expect(during.body.datasets.map((item) => item.name)).toEqual(['events']);
        expect(
            (await during.api('/data/datasets/events/tables/events/rows', 'POST', { rows: [{ id: 'during' }] })).status,
        ).toBe(200);
        // Adopted, the new need is the plugin's.
        release();
        await updating;
        runtime.provisionService = provision;
        const after = await token(f, 'events');
        expect(after.body.datasets.map((item) => [item.name, item.access])).toEqual([
            ['events', 'write'],
            ['archive', 'write'],
        ]);
    });

    for (const order of ['read first', 'write first'] as const) {
        it(`writes through the write need, by need or id, whichever binding is older (${order})`, async () => {
            const { f, datasetId } = await eventsWorld();
            await f.platform.plugins.uninstall('events');
            offer(f, 'both', 'Both', [
                { name: 'view', access: 'read', tables: [READS_EVENTS] },
                { name: 'store', access: 'write', tables: [EVENTS_TABLE] },
            ]);
            await f.platform.plugins.install(
                'both',
                {},
                {
                    bindings: { view: { datasetId }, store: { datasetId } },
                },
            );
            const db = f.workspace.db;
            const at = (need: string, boundAt: number) =>
                db
                    .prepare('UPDATE data_plugin_bindings SET boundAt=? WHERE pluginId=? AND need=?')
                    .run(boundAt, 'both', need);
            at('view', order === 'read first' ? 1 : 2);
            at('store', order === 'read first' ? 2 : 1);
            const whole = await token(f, 'both');
            expect(whole.body.datasets.map((item) => item.name)).toEqual(
                order === 'read first' ? ['view', 'store'] : ['store', 'view'],
            );
            const batch = (ref: string, id: string) =>
                whole.api(`/data/datasets/${ref}/batch`, 'POST', {
                    statements: [{ sql: `INSERT INTO events(id) VALUES ('${id}')` }],
                });
            expect((await batch('store', `${order}-need`)).status).toBe(200);
            expect((await batch(datasetId, `${order}-id`)).status).toBe(200);
            expect((await batch('events', `${order}-name`)).status).toBe(200);
            expect(
                (
                    await whole.api(`/data/datasets/${datasetId}/tables/events/rows`, 'POST', {
                        rows: [{ id: `${order}-row` }],
                    })
                ).status,
            ).toBe(200);
            // Through the read need, never.
            expect((await batch('view', `${order}-view`)).status).toBe(403);
            const narrow = await token(f, 'both', { datasets: ['view'] });
            const refused = await narrow.api(`/data/datasets/${datasetId}/batch`, 'POST', {
                statements: [{ sql: "INSERT INTO events(id) VALUES ('narrow')" }],
            });
            expect(refused.status).toBe(403);
            const rows = await whole.api('/data/datasets/store/query', 'POST', {
                sql: "SELECT count(*) FROM events WHERE id LIKE '%first%'",
            });
            expect((rows.body as unknown as QueryResult).rows).toEqual([[4]]);
        });
    }
});
