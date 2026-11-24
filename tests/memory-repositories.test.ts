import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { getTableName } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { migrate, migrateDatabase, type SchemaSet } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';

import { sqliteMemoryRepositories } from '../src/server/memory/infra/sqlite/index.js';
import { baselineMemoryTables, memoryTables } from '../src/server/memory/infra/sqlite/schema.js';
import { memorySchema } from '../src/server/memory/migrations.js';
import { schemas } from '../src/server/modules/index.js';
import { coreSchema } from '../src/server/settings/store.js';

/*
 * The Memory context's repository contract (CB-110): what any
 * implementation of the repositories in `memory/contract.ts` must keep, run against
 * the SQLite one. Its tables moved out of `core` (Q7): core's history
 * stays, and the context's baseline is adopted over it.
 */

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);

function scratch(sets: readonly SchemaSet[] = [memorySchema]) {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, sets);
    return db;
}

function memory() {
    const db = scratch();
    const data = sqliteData(db);
    return { db, uow: data.uow, repos: sqliteMemoryRepositories(data) };
}

/** A table's columns and indexes, as SQLite describes them. */
function shape(db: DatabaseSync, tables: readonly (typeof memoryTables)[number][] = baselineMemoryTables) {
    return Object.fromEntries(
        tables.map((table) => {
            const name = getTableName(table);
            const indexes = db
                .prepare(`PRAGMA index_list("${name}")`)
                .all()
                .map((index) => ({
                    name: index.name,
                    unique: index.unique,
                    partial: index.partial,
                    columns: db
                        .prepare(`PRAGMA index_info("${String(index.name)}")`)
                        .all()
                        .map((column) => column.name),
                }))
                .sort((a, b) => String(a.name).localeCompare(String(b.name)));
            const columns = db
                .prepare(`PRAGMA table_xinfo("${name}")`)
                .all()
                .map(({ cid: _, ...column }) => column)
                .sort((a, b) => String(a.name).localeCompare(String(b.name)));
            return [name, { columns, indexes }];
        }),
    );
}

it('mirrors the migrated Memory tables exactly, however they were made', () => {
    // By the context's own baseline, by core's frozen history, by every set.
    const own = scratch();
    const core = scratch([coreSchema]);
    const all = scratch(schemas);
    for (const db of [own, all]) {
        expect(schemaDrift(db, memoryTables)).toEqual([]);
    }
    // Core's history made the baseline's tables only; episodes (CB-180) are
    // the context's own, version 2.
    expect(schemaDrift(core, baselineMemoryTables)).toEqual([]);
    // The baseline makes them as core's history left them.
    expect(shape(own)).toEqual(shape(core));
    expect(shape(all)).toEqual(shape(core));
    expect(shape(all, memoryTables)).toEqual(shape(own, memoryTables));
    const created = own
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
        )
        .all()
        .map((row) => String(row.name));
    expect(memoryTables.map((table) => getTableName(table)).sort()).toEqual(created);
    // Its CHECKs too: a status, a source or a zone they don't allow fails.
    for (const sql of [
        "INSERT INTO memories (id, text, createdAt, status) VALUES ('m', 't', 1, 'maybe')",
        "INSERT INTO memories (id, text, createdAt, source) VALUES ('m', 't', 1, 'web')",
        "INSERT INTO user_profiles (id, userId, fields, shareable, createdAt) VALUES ('p', 'u', 'nope', 0, 1)",
        "INSERT INTO time_zone_notes (userId, zone, createdAt) VALUES ('u', '', 1)",
    ]) {
        expect(() => own.exec(sql)).toThrow(/CHECK/);
        expect(() => core.exec(sql)).toThrow(/CHECK/);
    }
    for (const sql of [
        "INSERT INTO memory_episodes (id, userId, threadId, kind, key, text, occurredAt, createdAt) VALUES ('e', 'u', 't', 'memory', 'k', 'x', 1, 1)",
        "INSERT INTO memory_episodes (id, userId, threadId, kind, key, text, occurredAt, createdAt) VALUES ('e', '', 't', 'fact', 'k', 'x', 1, 1)",
        "INSERT INTO memory_episodes (id, userId, threadId, kind, key, text, occurredAt, createdAt) VALUES ('e', 'u', 't', 'fact', 'k', '', 1, 1)",
    ]) {
        expect(() => own.exec(sql)).toThrow(/CHECK/);
    }
});

it('reports a column the mirror does not know', () => {
    const db = scratch();
    db.exec('ALTER TABLE memories ADD COLUMN pinned INTEGER');
    expect(schemaDrift(db, memoryTables)).toEqual([expect.stringContaining('pinned')]);
});

it('adopts its baseline on a database core made the tables in, changing nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-memory-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'app.sqlite');
    const backupDirectory = join(dir, 'backups');
    // A database from before the move: every set but the Memory context's.
    const before = schemas.filter((set) => set.id !== memorySchema.id);
    migrateDatabase(path, before, { backupDirectory });
    const db = new DatabaseSync(path);
    db.exec(`INSERT INTO memories (id, text, createdAt, userId) VALUES ('m', 'Likes tea', 1, 'alice');
    INSERT INTO user_profiles (id, userId, fields, shareable, createdAt) VALUES ('p', 'alice', '{"name":"Al"}', 1, 2);
    INSERT INTO time_zone_notes (userId, zone, createdAt) VALUES ('alice', 'Europe/Madrid', 3);`);
    const rows = () =>
        ['memories', 'user_profiles', 'time_zone_notes'].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const kept = rows();
    const schema = shape(db);
    const { steps } = migrateDatabase(path, schemas, { backupDirectory });
    expect(steps).toEqual([
        { module: 'memories', version: 1, name: 'baseline', action: 'adopt' },
        // CB-180: a new table, expand-only; nothing of the others changes.
        { module: 'memories', version: 2, name: 'episodes', action: 'apply' },
        // CB-181: a Space's shared memory, a new table, expand-only.
        { module: 'memories', version: 3, name: 'space memory', action: 'apply' },
    ]);
    expect(rows()).toEqual(kept);
    expect(shape(db)).toEqual(schema);
    // Core's history is still core's: none of it moved.
    expect(
        db
            .prepare('SELECT module, version FROM schema_migrations WHERE module IN (?, ?) ORDER BY module, version')
            .all('core', 'memories')
            .map((row) => `${String(row.module)} ${String(row.version)}`),
    ).toEqual([...coreSchema.migrations!.map((m) => `core ${m.version}`), 'memories 1', 'memories 2', 'memories 3']);
    db.close();
});

it('keeps a person’s memories to them, newest first, and forgets by stamping', async () => {
    const { repos } = memory();
    const { memories } = repos;
    const tea = await memories.add({ userId: 'alice', text: 'Likes tea', source: 'person' }, 10);
    const same = await memories.add({ userId: 'alice', text: 'Works late', source: 'person', shareable: true }, 20);
    // The same millisecond: the later one first.
    const later = await memories.add({ userId: 'alice', text: 'Lives in Lyon', source: 'person' }, 20);
    await memories.add({ userId: 'bob', text: 'Likes coffee', source: 'person' });
    expect(tea).toMatchObject({
        status: 'active',
        source: 'person',
        shareable: false,
        dotId: null,
        threadId: null,
        createdAt: 10,
        updatedAt: 10,
        confirmedAt: 10,
    });
    expect((await memories.list('alice')).map((m) => m.text)).toEqual(['Lives in Lyon', 'Works late', 'Likes tea']);
    expect((await memories.active('alice', { shareableOnly: true })).map((m) => m.id)).toEqual([same.id]);
    // Nobody else's: Bob can't read, change or forget it.
    expect(await memories.get(tea.id, 'bob')).toBeUndefined();
    expect(await memories.update(tea.id, 'bob', { text: 'Mine' })).toBeUndefined();
    expect(await memories.forget(tea.id, 'bob')).toBe(false);

    expect(await memories.update(tea.id, 'alice', { shareable: true }, 30)).toMatchObject({
        text: 'Likes tea',
        shareable: true,
        updatedAt: 30,
    });
    expect(await memories.confirm(tea.id, 'alice', 40)).toMatchObject({
        confirmedAt: 40,
    });
    expect(await memories.forget(later.id, 'alice', 50)).toBe(true);
    expect(await memories.forget(later.id, 'alice', 60)).toBe(false);
    expect(await memories.get(later.id, 'alice')).toBeUndefined();
    expect(await memories.withDeleted(later.id)).toMatchObject({
        text: 'Lives in Lyon',
        userId: 'alice',
        deletedAt: 50,
        deletedBy: 'alice',
    });
    expect((await memories.active('alice')).map((m) => m.text)).toEqual(['Works late', 'Likes tea']);
});

it('waits for the person on a socio’s proposal, once per wording', async () => {
    const { repos } = memory();
    const { memories } = repos;
    const proposal = await memories.add(
        {
            userId: 'alice',
            text: 'Prefers tea over coffee.',
            source: 'socio',
            dotId: 'dot-1',
            threadId: 'chat-1',
        },
        10,
    );
    expect(proposal).toMatchObject({
        status: 'proposed',
        confirmedAt: null,
        dotId: 'dot-1',
        threadId: 'chat-1',
    });
    // The same words but for case, spaces and the stop: the same one.
    const again = await memories.add({ userId: 'alice', text: 'prefers  tea over coffee', source: 'notes' }, 20);
    expect(again.id).toBe(proposal.id);
    expect(await memories.waiting('alice')).toBe(1);
    expect(await memories.active('alice')).toEqual([]);
    // Confirming a proposal does nothing; approving makes it active.
    expect(await memories.confirm(proposal.id, 'alice', 25)).toMatchObject({
        confirmedAt: null,
    });
    // Asked of a socio by the person (CB-172): it approves the one waiting.
    const asked = await memories.add(
        {
            userId: 'alice',
            text: 'Prefers tea over coffee',
            source: 'person',
            dotId: 'dot-1',
        },
        30,
    );
    expect(asked).toMatchObject({
        id: proposal.id,
        status: 'active',
        confirmedAt: 30,
        updatedAt: 30,
    });
    expect(await memories.waiting('alice')).toBe(0);
    // Approving what is active already leaves it as it is.
    expect(await memories.approve(proposal.id, 'alice', 40)).toMatchObject({
        confirmedAt: 30,
    });
    // One the person adds in Memories themselves is always a new one.
    const own = await memories.add({ userId: 'alice', text: 'Prefers tea over coffee', source: 'person' }, 50);
    expect(own.id).not.toBe(proposal.id);
});

it('gives memories from before user accounts to a user', async () => {
    const { db, repos } = memory();
    db.exec("INSERT INTO memories (id, text, createdAt) VALUES ('old', 'Old memory', 1)");
    expect(await repos.memories.assignUnowned('alice')).toBe(1);
    expect(await repos.memories.assignUnowned('alice')).toBe(0);
    expect(await repos.memories.get('old', 'alice')).toMatchObject({
        status: 'active',
        source: 'person',
        shareable: false,
        updatedAt: 1,
    });
});

it('keeps one live profile per person and every earlier version', async () => {
    const { db, repos } = memory();
    const { profiles } = repos;
    expect(await profiles.get('alice')).toBeNull();
    expect(await profiles.cleared('alice')).toBe(false);
    expect(
        await profiles.save(
            'alice',
            {
                fields: { name: ' Al ', role: '', timezone: 'Europe/Madrid' },
                shareable: true,
                timezoneDetected: true,
            },
            10,
        ),
    ).toEqual({
        fields: { name: 'Al', timezone: 'Europe/Madrid' },
        shareable: true,
        timezoneDetected: true,
        updatedAt: 10,
    });
    // Saved again with the same zone, it stays detected; another zone isn't.
    expect(
        await profiles.save('alice', { fields: { name: 'Al', timezone: 'Europe/Madrid' }, shareable: false }, 20),
    ).toMatchObject({ timezoneDetected: true, shareable: false });
    expect(
        await profiles.save('alice', { fields: { name: 'Al', timezone: 'Asia/Tokyo' }, shareable: false }, 30),
    ).not.toHaveProperty('timezoneDetected');
    expect(await profiles.get('bob')).toBeNull();
    // No fields at all clears it.
    expect(await profiles.save('alice', { fields: { name: ' ' }, shareable: true })).toBeNull();
    expect(await profiles.cleared('alice')).toBe(true);
    expect(await profiles.clear('alice')).toBe(false);
    await profiles.save('alice', { fields: { name: 'Al' }, shareable: false });
    expect(await profiles.cleared('alice')).toBe(false);
    expect(await profiles.clear('alice', 50)).toBe(true);
    expect(await profiles.cleared('alice')).toBe(true);
    expect(db.prepare("SELECT count(*) AS n FROM user_profiles WHERE userId='alice'").get()).toEqual({ n: 4 });
});

it('shows a moved time zone’s note once in each place, the latest move’s', async () => {
    const { repos } = memory();
    const notes = repos.timeZoneNotes;
    expect(await notes.pending('alice', 'chat')).toBeNull();
    await notes.add('alice', 'Europe/Madrid', 10);
    expect(await notes.pending('alice', 'chat')).toBe('Europe/Madrid');
    expect(await notes.pending('alice', 'page')).toBe('Europe/Madrid');
    expect(await notes.shown('alice', 'chat', 'Asia/Tokyo')).toBe(false);
    expect(await notes.shown('alice', 'chat', 'Europe/Madrid', 20)).toBe(true);
    expect(await notes.shown('alice', 'chat', 'Europe/Madrid', 30)).toBe(false);
    expect(await notes.pending('alice', 'chat')).toBeNull();
    expect(await notes.pending('alice', 'page')).toBe('Europe/Madrid');
    // A newer move starts it over, in both places.
    await notes.add('alice', 'Asia/Tokyo', 40);
    expect(await notes.pending('alice', 'chat')).toBe('Asia/Tokyo');
    expect(await notes.pending('bob', 'chat')).toBeNull();
});

it('rolls back every repository write in a failed unit of work', async () => {
    const { db, uow, repos } = memory();
    await expect(
        uow.run(
            async () => {
                await repos.memories.add({
                    userId: 'alice',
                    text: 'Likes tea',
                    source: 'person',
                });
                await repos.profiles.save('alice', {
                    fields: { name: 'Al' },
                    shareable: false,
                });
                await repos.timeZoneNotes.add('alice', 'Europe/Madrid');
                throw new Error('Nope');
            },
            { label: 'remember' },
        ),
    ).rejects.toThrow('Nope');
    expect(await repos.memories.list('alice')).toEqual([]);
    expect(await repos.profiles.get('alice')).toBeNull();
    expect(await repos.profiles.cleared('alice')).toBe(false);
    expect(await repos.timeZoneNotes.pending('alice', 'chat')).toBeNull();
    expect(db.isTransaction).toBe(false);
});

it('queues its writes behind another chain’s open unit of work', async () => {
    const { uow, repos } = memory();
    const order: string[] = [];
    let release!: () => void;
    const held = uow.run(
        async () => {
            order.push('unit open');
            await new Promise<void>((resolve) => (release = resolve));
            order.push('unit done');
        },
        { label: 'another chain' },
    );
    // Started while the other unit is open: each waits for it.
    const writes = Promise.all([
        repos.memories.add({ userId: 'alice', text: 'Likes tea', source: 'socio' }).then(() => order.push('memory')),
        repos.profiles.save('alice', { fields: { name: 'Al' }, shareable: false }).then(() => order.push('profile')),
        repos.timeZoneNotes.add('alice', 'Europe/Madrid').then(() => order.push('note')),
    ]);
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
    expect(order).toEqual(['unit open']);
    release();
    await held.catch(() => {});
    await writes;
    expect(order).toEqual(['unit open', 'unit done', 'memory', 'profile', 'note']);
    expect(await repos.memories.waiting('alice')).toBe(1);
});
