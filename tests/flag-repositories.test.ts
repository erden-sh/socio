import { DatabaseSync } from 'node:sqlite';

import { getTableName } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { migrate } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';

import type { StoredFlagRule } from '../src/server/flags/domain/repositories.js';
import { sqliteFlagRepositories } from '../src/server/flags/infra/sqlite/index.js';
import { flagTables } from '../src/server/flags/infra/sqlite/schema.js';
import { flagsSchema } from '../src/server/flags/service.js';

/*
 * The feature flags repository contract (CB-110): what any implementation
 * of `flags/domain/repositories.ts` must keep, run against the SQLite one,
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
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [flagsSchema]);
    const data = sqliteData(db);
    return { db, uow: data.uow, repos: sqliteFlagRepositories(data) };
}

const all = (db: DatabaseSync, sql: string) => db.prepare(sql).all();

const rule = (fields: Partial<StoredFlagRule> = {}): StoredFlagRule => ({
    scope: 'tenant',
    scopeId: 't1',
    flag: 'beta-board',
    enabled: true,
    roles: ['admin'],
    people: ['alice'],
    locked: false,
    updatedBy: 'alice',
    updatedAt: 10,
    ...fields,
});

it('mirrors the migrated flag tables exactly, and only those', () => {
    const { db } = context();
    expect(schemaDrift(db, flagTables)).toEqual([]);
    const created = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
        )
        .all()
        .map((row) => String(row.name));
    expect(flagTables.map((table) => getTableName(table)).sort()).toEqual(created);
});

it('reports a column the mirror does not know', () => {
    const { db } = context();
    db.exec('ALTER TABLE flag_tiers ADD COLUMN note TEXT');
    expect(schemaDrift(db, flagTables)).toEqual([expect.stringContaining('note')]);
});

it('saves a rule as the raw columns did, replaces it in place, and clears it', async () => {
    const { db, repos } = context();
    await repos.rules.save(rule());
    expect(all(db, 'SELECT * FROM flag_rules')).toEqual([
        {
            scope: 'tenant',
            scopeId: 't1',
            flag: 'beta-board',
            enabled: 1,
            roles: '["admin"]',
            people: '["alice"]',
            locked: 0,
            optIn: 0,
            updatedBy: 'alice',
            updatedAt: 10,
        },
    ]);
    await repos.rules.save(
        rule({
            enabled: false,
            roles: [],
            people: [],
            updatedAt: 20,
        }),
    );
    // Another scope's rule for the same flag is its own row.
    await repos.rules.save(rule({ scope: 'instance', scopeId: '', locked: true }));
    expect(all(db, 'SELECT scope, enabled, roles, locked, optIn, updatedAt FROM flag_rules ORDER BY scope')).toEqual([
        {
            scope: 'instance',
            enabled: 1,
            roles: '["admin"]',
            locked: 1,
            optIn: 0,
            updatedAt: 10,
        },
        {
            scope: 'tenant',
            enabled: 0,
            roles: '[]',
            locked: 0,
            optIn: 0,
            updatedAt: 20,
        },
    ]);
    expect(await repos.rules.clear('tenant', 't1', 'beta-board')).toBe(true);
    expect(await repos.rules.clear('tenant', 't1', 'beta-board')).toBe(false);
    expect(all(db, 'SELECT scope FROM flag_rules')).toEqual([{ scope: 'instance' }]);
});

it('retires stored opt-ins and choices, and keeps the previous release from writing new ones (flags 2, CB-503)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    // A database at flags 1, with what people and admins stored before.
    migrate(db, [{ ...flagsSchema, migrations: flagsSchema.migrations!.filter((m) => m.version === 1) }]);
    const insertRule = db.prepare(
        "INSERT INTO flag_rules (scope, scopeId, flag, enabled, roles, people, locked, optIn, updatedBy, updatedAt) VALUES (?, ?, ?, 0, '[]', '[]', 0, ?, 'a', 1)",
    );
    insertRule.run('tenant', 't1', 'beta-board', 1);
    insertRule.run('instance', '', 'beta-board', 1);
    insertRule.run('tenant', 't1', 'web-reads', 0);
    const insertChoice = db.prepare('INSERT INTO flag_choices (userId, flag, enabled, updatedAt) VALUES (?, ?, ?, 1)');
    insertChoice.run('alice', 'beta-board', 1);
    insertChoice.run('bob', 'beta-board', 0);
    migrate(db, [flagsSchema]);
    // Every rule stays, with opt-in cleared; every choice is gone.
    expect(all(db, 'SELECT scope, flag, enabled, optIn FROM flag_rules ORDER BY scope, flag')).toEqual([
        { scope: 'instance', flag: 'beta-board', enabled: 0, optIn: 0 },
        { scope: 'tenant', flag: 'beta-board', enabled: 0, optIn: 0 },
        { scope: 'tenant', flag: 'web-reads', enabled: 0, optIn: 0 },
    ]);
    expect(all(db, 'SELECT * FROM flag_choices')).toEqual([]);
    // The previous release, running on this schema during a start-first
    // deploy, writes as it did: its writes succeed and have no effect.
    insertRule.run('tenant', 't1', 'other', 1);
    db.prepare(
        "INSERT INTO flag_rules (scope, scopeId, flag, enabled, roles, people, locked, optIn, updatedBy, updatedAt) VALUES ('tenant', 't1', 'beta-board', 1, '[]', '[]', 0, 1, 'a', 2) ON CONFLICT (scope, scopeId, flag) DO UPDATE SET optIn = 1, enabled = 1",
    ).run();
    db.prepare("UPDATE flag_rules SET optIn = 1 WHERE flag = 'web-reads'").run();
    expect(all(db, 'SELECT flag, optIn FROM flag_rules WHERE optIn <> 0')).toEqual([]);
    expect(all(db, "SELECT enabled FROM flag_rules WHERE scope = 'tenant' AND flag = 'beta-board'")).toEqual([
        { enabled: 1 },
    ]);
    insertChoice.run('alice', 'beta-board', 1);
    db.prepare(
        "INSERT INTO flag_choices (userId, flag, enabled, updatedAt) VALUES ('alice', 'beta-board', 1, 2) ON CONFLICT (userId, flag) DO UPDATE SET enabled = 1",
    ).run();
    expect(all(db, 'SELECT * FROM flag_choices')).toEqual([]);
    // It is recorded once; a second run changes nothing.
    expect(all(db, "SELECT version FROM schema_migrations WHERE module = 'flags' ORDER BY version")).toEqual([
        { version: 1 },
        { version: 2 },
    ]);
    expect(migrate(db, [flagsSchema])).toEqual([]);
});

it('saves a plan keeping its creation time, and assigns it to a workspace', async () => {
    const { db, repos } = context();
    const tier = { id: 'pro', name: 'Pro', description: '', flags: { a: true } };
    await repos.tiers.save(tier, 'op', 10);
    await repos.tiers.save({ ...tier, name: 'Pro+', flags: { a: false } }, 'op2', 20);
    expect(all(db, 'SELECT * FROM flag_tiers')).toEqual([
        {
            id: 'pro',
            name: 'Pro+',
            description: '',
            flags: '{"a":false}',
            createdAt: 10,
            updatedBy: 'op2',
            updatedAt: 20,
        },
    ]);
    expect(await repos.tiers.exists('pro')).toBe(true);
    expect(await repos.tiers.exists('free')).toBe(false);
    expect(await repos.tiers.inUse('pro')).toBe(false);
    await repos.tiers.save({ ...tier, id: 'team' }, 'op', 30);
    await repos.tiers.assign('t1', 'pro', 'op', 40);
    await repos.tiers.assign('t1', 'team', 'op3', 50);
    expect(all(db, 'SELECT * FROM flag_tenant_tiers')).toEqual([
        { tenantId: 't1', tierId: 'team', updatedBy: 'op3', updatedAt: 50 },
    ]);
    expect(await repos.tiers.inUse('team')).toBe(true);
    await repos.tiers.unassign('t1');
    expect(all(db, 'SELECT * FROM flag_tenant_tiers')).toEqual([]);
    await repos.tiers.remove('pro');
    expect(all(db, 'SELECT id FROM flag_tiers')).toEqual([{ id: 'team' }]);
});

it('joins an open unit of work and rolls back with it', async () => {
    const { db, uow, repos } = context();
    await expect(
        uow.run(async () => {
            await repos.rules.save(rule());
            await repos.tiers.save({ id: 'pro', name: 'Pro', description: '', flags: {} }, 'op', 10);
            throw new Error('undo');
        }),
    ).rejects.toThrow('undo');
    expect(all(db, 'SELECT * FROM flag_rules')).toEqual([]);
    expect(all(db, 'SELECT * FROM flag_tiers')).toEqual([]);
});
