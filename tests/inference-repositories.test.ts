import { DatabaseSync } from 'node:sqlite';

import { getTableName } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { migrate } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';

import type { StoredBackend } from '../src/server/inference/domain/repositories.js';
import { sqliteInferenceRepositories } from '../src/server/inference/infra/sqlite/index.js';
import { inferenceTables } from '../src/server/inference/infra/sqlite/schema.js';
import { inferenceSchema } from '../src/server/inference/migrations.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

/*
 * The Inference repository contract (CB-110): what any implementation of
 * `inference/domain/repositories.ts` must keep, run against the SQLite one.
 */

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);

function inference() {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [inferenceSchema]);
    const data = sqliteData(db);
    return { db, uow: data.uow, repos: sqliteInferenceRepositories(data) };
}

const backend = (fields: Partial<StoredBackend> = {}): StoredBackend => ({
    id: 'b1',
    kind: 'openai-compatible',
    label: 'Homelab',
    enabled: true,
    config: { baseUrl: 'http://orion.invalid/v1', model: 'qwen' },
    secrets: 'sealed-1',
    capabilities: { acceptsImages: false, maxCompletionTokens: 2200 },
    lastTest: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...fields,
});

it('mirrors the migrated inference tables exactly, and only those', () => {
    const { db } = inference();
    expect(schemaDrift(db, inferenceTables)).toEqual([]);
    const created = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
        )
        .all()
        .map((row) => String(row.name));
    expect(inferenceTables.map((table) => getTableName(table)).sort()).toEqual(created);
    // Every module's migrations together leave them as mirrored.
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    expect(schemaDrift(workspace.db, inferenceTables)).toEqual([]);
});

it('stores backends oldest first, with their JSON and sealed key as given', async () => {
    const { db, repos } = inference();
    expect(await repos.backends.any()).toBe(false);
    await repos.backends.insert(backend({ id: 'b2', createdAt: 2000 }));
    await repos.backends.insert(
        backend({
            secrets: null,
            config: { baseUrl: 'u', model: 'm', titleModelOptions: { a: 1 } },
        }),
    );
    expect(await repos.backends.any()).toBe(true);
    expect((await repos.backends.all()).map((row) => row.id)).toEqual(['b1', 'b2']);
    expect(await repos.backends.byId('b1')).toEqual(
        backend({
            secrets: null,
            config: { baseUrl: 'u', model: 'm', titleModelOptions: { a: 1 } },
        }),
    );
    expect(await repos.backends.byId('missing')).toBeUndefined();
    // Stored as the earlier code wrote them: JSON text and 0/1.
    expect(
        db.prepare('SELECT enabled, config, capabilities, lastTest FROM inference_backends WHERE id=?').get('b2'),
    ).toEqual({
        enabled: 1,
        config: JSON.stringify(backend().config),
        capabilities: JSON.stringify(backend().capabilities),
        lastTest: null,
    });
});

it('changes only the fields given, and removes a backend once', async () => {
    const { repos } = inference();
    await repos.backends.insert(backend());
    const test = { ok: true, at: 5, detail: 'Reachable.' };
    expect(
        await repos.backends.update('b1', {
            label: 'Lab',
            enabled: false,
            lastTest: test,
            secrets: undefined,
        }),
    ).toBe(true);
    expect(await repos.backends.byId('b1')).toMatchObject({
        label: 'Lab',
        enabled: false,
        lastTest: test,
        secrets: 'sealed-1',
        updatedAt: 1000,
    });
    expect(await repos.backends.update('b1', {})).toBe(true);
    expect(await repos.backends.update('missing', { label: 'x' })).toBe(false);
    expect(await repos.backends.update('missing', {})).toBe(false);
    await repos.backends.update('b1', { secrets: null });
    expect((await repos.backends.byId('b1'))?.secrets).toBeNull();
    expect(await repos.backends.remove('b1')).toBe(true);
    expect(await repos.backends.remove('b1')).toBe(false);
});

it('re-seals a key, a connection and a setting only while unchanged', async () => {
    const { repos } = inference();
    await repos.backends.insert(backend());
    expect(await repos.backends.replaceSecrets('b1', 'other', 'sealed-2')).toBe(false);
    expect(await repos.backends.replaceSecrets('b1', 'sealed-1', 'sealed-2')).toBe(true);
    expect((await repos.backends.byId('b1'))?.secrets).toBe('sealed-2');
    await repos.connections.save({
        userId: 'bob',
        kind: 'byo-fake',
        credentials: 'c1',
        meta: {},
        createdAt: 1,
        updatedAt: 1,
    });
    expect(await repos.connections.replaceCredentials('bob', 'byo-fake', 'c0', 'c2')).toBe(false);
    expect(await repos.connections.replaceCredentials('bob', 'byo-fake', 'c1', 'c2')).toBe(true);
    expect((await repos.connections.get('bob', 'byo-fake'))?.credentials).toBe('c2');
    await repos.settings.set('envSeed', 's1');
    expect(await repos.settings.replace('envSeed', 's0', 's2')).toBe(false);
    expect(await repos.settings.replace('envSeed', 's1', 's2')).toBe(true);
    expect(await repos.settings.get('envSeed')).toBe('s2');
});

it('keeps settings by key', async () => {
    const { repos } = inference();
    expect(await repos.settings.get('defaultBackendId')).toBeUndefined();
    await repos.settings.set('defaultBackendId', 'b1');
    await repos.settings.set('defaultBackendId', 'b2');
    expect(await repos.settings.get('defaultBackendId')).toBe('b2');
    await repos.settings.remove('defaultBackendId');
    expect(await repos.settings.get('defaultBackendId')).toBeUndefined();
});

it('replaces a connection but keeps when it was first made, per person and kind', async () => {
    const { repos } = inference();
    const connection = {
        userId: 'bob',
        kind: 'byo-b',
        credentials: 'c1',
        meta: { plan: 'plus' },
        createdAt: 10,
        updatedAt: 10,
    };
    await repos.connections.save(connection);
    await repos.connections.save({ ...connection, kind: 'byo-a' });
    await repos.connections.save({ ...connection, userId: 'alice' });
    await repos.connections.save({
        ...connection,
        credentials: 'c2',
        meta: {},
        createdAt: 20,
        updatedAt: 20,
    });
    expect(await repos.connections.get('bob', 'byo-b')).toEqual({
        ...connection,
        credentials: 'c2',
        meta: {},
        updatedAt: 20,
        // The refresh-lease columns default to unset (per-user providers step 5).
        refreshLeasedUntil: 0,
        refreshLeasedBy: null,
    });
    expect(await repos.connections.kinds('bob')).toEqual(['byo-a', 'byo-b']);
    expect(await repos.connections.all()).toHaveLength(3);
    await repos.connections.remove('bob', 'byo-b');
    expect(await repos.connections.get('bob', 'byo-b')).toBeUndefined();
    expect(await repos.connections.kinds('bob')).toEqual(['byo-a']);
    expect(await repos.connections.kinds('carol')).toEqual([]);
});

it('keeps a model’s latest response times, newest first', async () => {
    const { repos } = inference();
    const timing = (at: number, ttftMs: number, key = 'shared:b1:qwen') => ({
        key,
        round: 'first' as const,
        at,
        promptChars: null,
        promptTokens: 100,
        uncachedTokens: 50,
        ttftMs,
    });
    for (let i = 0; i < 5; i++) {
        await repos.timings.add(timing(10 + i, i), 3);
    }
    // Same millisecond: the later one is newer.
    await repos.timings.add(timing(14, 99), 3);
    await repos.timings.add(timing(1, 7, 'other'), 3);
    expect((await repos.timings.latest('shared:b1:qwen', 10)).map((t) => t.ttftMs)).toEqual([99, 4, 3]);
    expect(await repos.timings.latest('shared:b1:qwen', 1)).toEqual([
        {
            round: 'first',
            promptChars: null,
            promptTokens: 100,
            uncachedTokens: 50,
            ttftMs: 99,
        },
    ]);
    expect(await repos.timings.latest('other', 10)).toHaveLength(1);
});

it('joins an open unit of work, and rolls back with it', async () => {
    const { repos, uow } = inference();
    await expect(
        uow.run(async () => {
            await repos.backends.insert(backend());
            await repos.settings.set('defaultBackendId', 'b1');
            throw new Error('stop');
        }),
    ).rejects.toThrow('stop');
    expect(await repos.backends.any()).toBe(false);
    expect(await repos.settings.get('defaultBackendId')).toBeUndefined();
});
