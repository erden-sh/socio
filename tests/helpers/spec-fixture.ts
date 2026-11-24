/**
 * A data space with a dataset and tables for the query spec compiler's
 * tests (CB-451): rows go in through the engine, specs run through
 * `SpecRunner` and `DataSpace.query`, as `POST /api/data/specs/run` runs
 * them, with field settings from the `fieldSettings` hook.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ColumnType } from '@socio/shared/data-types';
import type { FieldSetting } from '@socio/shared/dataset-query/kinds';
import type { SpecResult } from '@socio/shared/dataset-query/result';

import { sqliteApprovals } from '../../src/server/approvals/services.js';
import {
    SpecRunner,
    type SpecRunOptions,
    type SpecRunRefusal,
    type SpecRunSources,
} from '../../src/server/dataspace/query-spec/run.js';
import { DataSpace } from '../../src/server/dataspace/space.js';

import { dataSpaceStorage } from './data-space-storage.js';
import { WorkspaceStore } from './stores.js';
import { testDatabase } from './test-database.js';

export interface SpecTable {
    name: string;
    columns: Array<{ name: string; type: ColumnType; primaryKey?: boolean }>;
    rows: Array<Record<string, unknown>>;
    settings?: FieldSetting[];
}

/** A stored cell: lists as JSON text, booleans as 0 or 1. */
const stored = (value: unknown) =>
    Array.isArray(value) ? JSON.stringify(value) : typeof value === 'boolean' ? Number(value) : value;

export async function specFixture(
    tables: SpecTable[],
    options: SpecRunOptions = {},
    limits: ConstructorParameters<typeof DataSpace>[1]['limits'] = {},
) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-spec-compile-'));
    const workspace = new WorkspaceStore(testDatabase());
    for (const [id, name, role] of [
        ['u_ana', 'Ana Ruiz', 'admin'],
        ['u_ben', 'Ben Okafor', 'member'],
        ['u_cam', 'Cam Lee', 'member'],
        ['ada', 'Ada', 'member'],
    ] as const) {
        workspace.recordUser({ id, name, role });
    }
    const approvals = sqliteApprovals(workspace.db, { dotName: (id) => workspace.dot(id)?.name });
    const space = new DataSpace(workspace.db, {
        dir,
        ...dataSpaceStorage(dir),
        secret: 'secret-0123456789abcdef-xyz',
        approvals,
        workspace,
        limits,
    });
    const dot = workspace.dots()[0]!;
    const socio = { kind: 'dot' as const, userId: 'u_ana', dotId: dot.id };
    const dataset = space.createDataset('u_ana', { name: 'Acme events' });
    space.setGrant('u_ana', { dotId: dot.id, datasetId: dataset.id, access: 'write' });
    for (const table of tables) {
        await space.write(socio, dataset.id, {
            op: 'create_table',
            input: { table: table.name, columns: table.columns },
        });
        for (let i = 0; i < table.rows.length; i += 500) {
            await space.write(socio, dataset.id, {
                op: 'insert',
                table: table.name,
                rows: table.rows
                    .slice(i, i + 500)
                    .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, stored(v)]))),
            });
        }
    }
    const settings = new Map(tables.map((t) => [t.name, t.settings ?? []]));
    const sources: SpecRunSources = {
        detailFor: (userId, id) => space.detailFor(userId, id),
        datasetVersion: (userId, id) => space.datasetVersion(userId, id),
        specPeople: () => space.specPeople(),
        query: (actor, id, sql, params) => space.query(actor, id, sql, params),
        // The field settings hook (build step 4 stores them).
        fieldSettings: (_datasetId, table) => settings.get(table) ?? [],
    };
    const runner = new SpecRunner(sources, { perMinute: 100_000, ...options });
    /** Runs a spec as `userId` (Ana by default); throws on problems, with them. */
    const run = async (
        spec: Record<string, unknown>,
        extra: { as?: string; timeZone?: string; params?: Record<string, never> } = {},
    ) => {
        const answer = await runner.run(extra.as ?? 'u_ana', {
            spec: { source: { dataset: dataset.id, table: tables[0]!.name }, ...spec },
            ...(extra.timeZone ? { timeZone: extra.timeZone } : {}),
            ...(extra.params ? { params: extra.params } : {}),
            fresh: true,
        });
        if ('ok' in answer) {
            throw new Error(`Spec refused: ${JSON.stringify((answer as SpecRunRefusal).problems)}`);
        }
        return answer as SpecResult;
    };
    const refusal = async (spec: Record<string, unknown>) => {
        const answer = await runner.run('u_ana', {
            spec: { source: { dataset: dataset.id, table: tables[0]!.name }, ...spec },
        });
        return 'ok' in answer ? (answer as SpecRunRefusal).problems : undefined;
    };
    const close = () => {
        space.close();
        workspace.close();
        rmSync(dir, { recursive: true, force: true });
    };
    return { space, dataset, runner, run, refusal, close, socio, sources };
}
