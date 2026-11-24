import { afterEach, expect, it } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { sqliteData, transactionSync } from '@socio/data/open';

import type { SoulRecord } from '../src/server/souls/contract.js';
import { soulTables } from '../src/server/souls/infra/sqlite/schema.js';
import { SqliteSouls } from '../src/server/souls/infra/sqlite/souls.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

/*
 * The Souls repository contract (CB-110): what any implementation of
 * `SoulRepository` (`souls/contract.ts`) must keep, run against the SQLite one,
 * and the drift check of its Drizzle mirror.
 */

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);

function context() {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const { db } = workspace;
    const dotId = String((db.prepare('SELECT id FROM dots LIMIT 1').get() as { id: string }).id);
    return { db, dotId, souls: new SqliteSouls(sqliteData(db)) };
}

const soul = (dotId: string, fields: Partial<SoulRecord> = {}): SoulRecord => ({
    dotId,
    version: 2,
    instructions: 'Answer briefly.',
    voice: 'Warm.',
    values: 'Honesty.',
    style: 'Plain.',
    createdAt: 10,
    createdBy: 'alice',
    source: 'edited',
    restoredFrom: null,
    ...fields,
});

it('mirrors the migrated socio_souls table', () => {
    const { db } = context();
    expect(schemaDrift(db, soulTables)).toEqual([]);
    db.exec('ALTER TABLE socio_souls ADD COLUMN note TEXT');
    expect(schemaDrift(db, soulTables)).toEqual([expect.stringContaining('note')]);
});

it('appends a version and copies its instructions to the socio', () => {
    const { db, dotId, souls } = context();
    souls.appendNow(soul(dotId));
    souls.appendNow(
        soul(dotId, {
            version: 3,
            instructions: 'Answer at length.',
            source: 'restored',
            restoredFrom: 1,
        }),
    );
    expect(db.prepare('SELECT * FROM socio_souls WHERE dotId=? AND version>1 ORDER BY version').all(dotId)).toEqual([
        { ...soul(dotId) },
        {
            ...soul(dotId),
            version: 3,
            instructions: 'Answer at length.',
            source: 'restored',
            restoredFrom: 1,
        },
    ]);
    expect(db.prepare('SELECT instructions FROM dots WHERE id=?').get(dotId)).toEqual({
        instructions: 'Answer at length.',
    });
    // A version is never written twice.
    expect(() => souls.appendNow(soul(dotId))).toThrow();
});

it('runs in the caller’s transaction and rolls back with it', () => {
    const { db, dotId, souls } = context();
    const before = db.prepare('SELECT instructions FROM dots WHERE id=?').get(dotId);
    expect(() =>
        transactionSync(db, 'test', () => {
            souls.appendNow(soul(dotId));
            throw new Error('undo');
        }),
    ).toThrow('undo');
    expect(db.prepare('SELECT COUNT(*) AS n FROM socio_souls WHERE dotId=? AND version=2').get(dotId)).toEqual({
        n: 0,
    });
    expect(db.prepare('SELECT instructions FROM dots WHERE id=?').get(dotId)).toEqual(before);
});
