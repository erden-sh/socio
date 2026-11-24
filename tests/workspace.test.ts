import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, it } from 'vitest';

import { migrateDatabase } from '@socio/data/migrate';
import { migrate } from '@socio/data/migrate';
import { characterOf, legacyCharacterFor, LOCALS, type LocalId } from '@socio/shared/mascot';

import { schemas } from '../src/server/modules/index.js';
import { workspaceSchema } from '../src/server/workspace/workspace.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase, testDatabaseFile } from './helpers/test-database.js';

it('persists spaces, specialist permissions, and canonical thread ownership', () => {
    const store = new WorkspaceStore(testDatabase());
    const space = store.createSpace('Design', 'Design decisions');
    const dot = store.createDot(space.id, 'Scout', 'Be concise', false, true);
    store.bindThread('thread-1', dot.id, 'Design research', 'owner');
    expect(store.requireThread('thread-1', dot.id).ownerId).toBe('owner');
    expect(() => store.requireThread('thread-1', 'another-dot')).toThrow();
    expect(() => store.requireThread('unknown')).toThrow();
    expect(store.dot(dot.id)?.researchAllowed).toBe(false);
    store.close();
});
it('rejects a dot in a nonexistent space and does not rebind an existing thread', () => {
    const store = new WorkspaceStore(testDatabase());
    expect(() => store.createDot('missing', 'Dot', 'Help', true, true)).toThrow();
    const dots = store.dots();
    store.bindThread('one', dots[0].id, 'First', 'owner');
    expect(() => store.bindThread('one', dots[0].id, 'Second', 'owner')).toThrow();
    store.close();
});

it('migrates legacy Space ownership once and never restores revoked access on restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'company-brain-access-'));
    const path = join(dir, 'workspace.sqlite');
    try {
        const legacy = new DatabaseSync(path);
        legacy.exec(`CREATE TABLE spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      INSERT INTO spaces VALUES ('old', 'Original', '', 1), ('new', 'New', '', 2);
      INSERT INTO dots VALUES ('dot', 'old', 'Dot', 'Help', 1, 1, 1);`);
        legacy.close();
        migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
        const ws = new WorkspaceStore(path);
        const dot = ws.dot('dot')!;
        expect(dot.spaceIds).toEqual(['old']);
        expect(ws.canAccessSpace('dot', 'new')).toBe(false);
        expect(() => ws.updateDot('dot', { ...dot, spaceIds: ['missing'] })).toThrow();
        expect(ws.dot('dot')?.spaceIds).toEqual(['old']);
        ws.bindThread('existing-thread', 'dot', 'Keep me', 'owner');
        ws.updateDot('dot', { ...dot, spaceId: 'new', spaceIds: ['new'] });
        ws.close();
        const reopened = new WorkspaceStore(path);
        expect(reopened.dot('dot')?.spaceIds).toEqual(['new']);
        expect(reopened.canAccessSpace('dot', 'old')).toBe(false);
        expect(reopened.requireThread('existing-thread').dotId).toBe('dot');
        reopened.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// CB-177: the first socio of a brand-new workspace is Sebas; a workspace
// that already has socios keeps them.
it('seeds Sebas in a new workspace and leaves an existing one alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'company-brain-seed-'));
    const file = testDatabaseFile(join(dir, 'workspace.db'));
    try {
        const fresh = new WorkspaceStore(file);
        expect(fresh.dots().map((dot) => dot.name)).toEqual(['Sebas']);
        fresh.db.prepare("UPDATE dots SET name='Socio'").run();
        fresh.close();
        const again = new WorkspaceStore(file);
        expect(again.dots().map((dot) => dot.name)).toEqual(['Socio']);
        again.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// The seeded Sebas stores its character (CB-256), whatever its id hashes to.
it('gives the seeded socio the Sebas look every time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'company-brain-seed-'));
    try {
        for (let i = 0; i < 3; i++) {
            const fresh = new WorkspaceStore(testDatabaseFile(join(dir, `workspace-${i}.db`)));
            const [sebas] = fresh.dots();
            expect(sebas.character).toBe('sebas');
            expect(fresh.db.prepare('SELECT character FROM dots WHERE id=?').get(sebas.id)).toEqual({
                character: 'sebas',
            });
            fresh.close();
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// CB-256 + CB-294: a database from before the character column keeps every
// socio's original look once migration 19 freezes it with the legacy four-Local
// roster; the column is NULL only before migration 18 completes.
it('keeps existing socios’ characters through the character migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'company-brain-character-'));
    const file = join(dir, 'workspace.db');
    try {
        const old = new DatabaseSync(file);
        migrate(old, [
            {
                id: 'workspace',
                migrations: workspaceSchema.migrations!.filter((migration) => migration.version < 16),
            },
        ]);
        old.exec("INSERT INTO spaces (id, name, description, createdAt) VALUES ('s1', 'Everyday', '', 1)");
        const ids = Array.from({ length: 12 }, (_, i) => `legacy-socio-${i}`);
        for (const id of ids) {
            old.prepare(
                "INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt) VALUES (?, 's1', ?, 'Help.', 1, 1, 1)",
            ).run(id, id);
            old.prepare("INSERT INTO dot_spaces VALUES (?, 's1')").run(id);
        }
        // Existing socios from the pre-CB-272 era would have been assigned with the
        // four-Local hash; migration 19 must restore that assignment, not recompute
        // with the current eight-Local roster.
        expect(new Set(ids.map((id) => legacyCharacterFor(id))).size).toBeGreaterThanOrEqual(2);
        old.close();

        migrateDatabase(file, schemas, { backupDirectory: join(dir, 'backups') });
        const store = new WorkspaceStore(file);
        for (const id of ids) {
            expect(store.dot(id)!.character).toBe(legacyCharacterFor(id));
        }
        expect(store.db.prepare('SELECT COUNT(*) AS n FROM dots WHERE character IS NULL').get()).toEqual({ n: 0 });

        // A choice is stored and audited; saving the same look stores nothing.
        const [first, second] = ids.map((id) => store.dot(id)!);
        const other = LOCALS.find((local) => local !== characterOf(first!))!;
        store.updateDot(first!.id, { ...first!, character: other }, 'alice');
        store.updateDot(second!.id, { ...second!, name: 'Renamed' }, 'alice');
        store.close();

        const again = new WorkspaceStore(file);
        expect(again.dot(first!.id)!.character).toBe(other);
        expect(again.dot(second!.id)!.character).toBe(legacyCharacterFor(second!.id));
        expect(
            again.db
                .prepare('SELECT id FROM dots WHERE character IS NOT NULL')
                .all()
                .map((row) => row.id),
        ).toEqual(ids);
        expect(again.dotAudit(first!.id).at(-1)).toMatchObject({
            actor: 'alice',
            action: 'update',
            detail: `character: ${legacyCharacterFor(first!.id)} → ${other}`,
        });
        expect(again.dotAudit(second!.id).at(-1)?.detail).toBe('name');
        again.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

it('creates a socio with a chosen character, duplicates allowed, and refuses one outside the cast', () => {
    const store = new WorkspaceStore(testDatabase());
    const [space] = store.spaces();
    const make = (character: LocalId | null) =>
        store.createDot(
            space!.id,
            'Twin',
            'Help.',
            true,
            true,
            [space!.id],
            null,
            false,
            null,
            false,
            'bob',
            'bob',
            character,
        );
    const one = make('rulo');
    const two = make('rulo');
    expect([one.character, two.character]).toEqual(['rulo', 'rulo']);
    expect(store.dot(two.id)!.character).toBe('rulo');
    expect(store.dotAudit(one.id)[0]).toMatchObject({
        action: 'create',
        detail: 'personal; character: rulo',
    });
    expect(make(null).character).toBeDefined();
    expect(() => make('godzilla' as never)).toThrow(/characters/);
    expect(() => store.updateDot(one.id, { ...one, character: 'godzilla' as never })).toThrow(/characters/);
    store.close();
});
