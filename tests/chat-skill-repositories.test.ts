import { DatabaseSync } from 'node:sqlite';

import { getTableName } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { migrate } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';

import type { SkillContent } from '../src/server/skills/contract.js';
import { chatSkillTables } from '../src/server/skills/infra/sqlite/schema.js';
import { chatSkillsSchema } from '../src/server/skills/migrations.js';
import { skillSessions, skillsRepository } from '../src/server/skills/repository.js';

/*
 * The chat skills repository contract (CB-110): what any implementation of
 * `skills/domain/repositories.ts` must keep, run against the SQLite one,
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
    migrate(db, [chatSkillsSchema]);
    return {
        db,
        uow: sqliteData(db).uow,
        skills: skillsRepository(db),
        sessions: skillSessions(db),
    };
}

const all = (db: DatabaseSync, sql: string) => db.prepare(sql).all();

const content = (fields: Partial<SkillContent> = {}): SkillContent => ({
    name: 'triage',
    description: 'Triage an issue.',
    instructions: 'Read it, then label it.',
    mode: 'turn',
    ...fields,
});

const provenance = {
    url: 'https://github.com/example/skills',
    path: 'triage/SKILL.md',
    ref: 'main',
    commit: 'a'.repeat(40),
    sha256: 'f'.repeat(64),
    license: 'MIT',
    licenseText: 'MIT License',
};

it('mirrors the migrated chat skill tables exactly, and only those', () => {
    const { db } = context();
    expect(schemaDrift(db, chatSkillTables)).toEqual([]);
    const created = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
        )
        .all()
        .map((row) => String(row.name));
    expect(chatSkillTables.map((table) => getTableName(table)).sort()).toEqual(created);
});

it('reports a column the mirror does not know', () => {
    const { db } = context();
    db.exec('ALTER TABLE chat_skill_sessions ADD COLUMN note TEXT');
    expect(schemaDrift(db, chatSkillTables)).toEqual([expect.stringContaining('note')]);
});

it('adds a revision only when the content changes, and keeps every one', async () => {
    const { db, skills } = context();
    const first = await skills.save(content(), 'alice', 10);
    expect(first).toMatchObject({
        name: 'triage',
        revision: 1,
        source: 'workspace',
        sourceMetadata: null,
        createdAt: 10,
        updatedAt: 10,
    });
    // The same content keeps the revision.
    expect((await skills.save(content(), 'bob', 20)).revision).toBe(1);
    const second = await skills.save(content({ instructions: 'Label it first.' }), 'bob', 30);
    expect(second).toMatchObject({
        id: first.id,
        revision: 2,
        createdBy: 'alice',
        updatedBy: 'bob',
        updatedAt: 30,
    });
    expect((await skills.revisions('triage')).map(({ revision, createdBy }) => [revision, createdBy])).toEqual([
        [2, 'bob'],
        [1, 'alice'],
    ]);
    expect(all(db, 'SELECT id, name, revision FROM chat_skills')).toEqual([
        { id: first.id, name: 'triage', revision: 2 },
    ]);
    expect(await skills.list()).toEqual([second]);
});

it('imports with provenance, refuses a stale preview, and marks a later edit as local', async () => {
    const { skills } = context();
    await expect(
        skills.import(content(), provenance, { id: 'x', revision: 1, sha256: 'y' }, 'alice', 10),
    ).rejects.toThrow('changed since preview');
    const imported = await skills.import(content(), provenance, null, 'alice', 10);
    expect(imported).toMatchObject({
        source: 'git',
        sourceUrl: provenance.url,
        sourceCommit: provenance.commit,
    });
    expect(JSON.parse(imported.sourceMetadata!)).toEqual({
        sha256: provenance.sha256,
        license: 'MIT',
        licenseText: 'MIT License',
        locallyModified: false,
    });
    const edited = await skills.save(content({ description: 'Triage it.' }), 'bob', 20);
    expect(edited.source).toBe('git');
    expect(JSON.parse(edited.sourceMetadata!).locallyModified).toBe(true);
});

it('rolls back to an earlier revision as a new one, and removes by hiding', async () => {
    const { db, skills } = context();
    await skills.save(content(), 'alice', 10);
    await skills.save(content({ mode: 'until-done' }), 'alice', 20);
    expect(await skills.rollback('triage', 9, 'bob', 30)).toBeUndefined();
    const back = await skills.rollback('triage', 1, 'bob', 30);
    expect(back).toMatchObject({ revision: 3, mode: 'turn' });
    expect((await skills.revisions('triage'))[0]).toMatchObject({
        revision: 3,
        restoredFrom: 1,
    });
    expect(await skills.remove('triage', 'bob', 40)).toBe(true);
    expect(await skills.remove('triage', 'bob', 40)).toBe(false);
    expect(await skills.get('triage')).toBeUndefined();
    expect(all(db, 'SELECT deletedAt, deletedBy FROM chat_skills')).toEqual([{ deletedAt: 40, deletedBy: 'bob' }]);
    // Its name is free again.
    expect((await skills.save(content(), 'carol', 50)).revision).toBe(1);
});

it('keeps one session on per person and chat, replacing the one before', async () => {
    const { db, sessions } = context();
    await sessions.start('t', 'grill-me', 'bob', 10);
    await sessions.start('t', 'report', 'bob', 20);
    await sessions.start('t', 'grill-me', 'carol', 30);
    expect(await sessions.active('t', 'bob')).toEqual({
        skill: 'report',
        startedAt: 20,
        startedBy: 'bob',
    });
    expect(await sessions.end('t', 'bob', 'done', 40)).toMatchObject({
        skill: 'report',
    });
    expect(await sessions.end('t', 'bob', 'done', 50)).toBeUndefined();
    expect(
        all(db, 'SELECT skill, startedBy, endedAt, endedBy, endReason FROM chat_skill_sessions ORDER BY startedAt'),
    ).toEqual([
        {
            skill: 'grill-me',
            startedBy: 'bob',
            endedAt: 20,
            endedBy: 'bob',
            endReason: 'replaced',
        },
        {
            skill: 'report',
            startedBy: 'bob',
            endedAt: 40,
            endedBy: 'bob',
            endReason: 'done',
        },
        {
            skill: 'grill-me',
            startedBy: 'carol',
            endedAt: null,
            endedBy: null,
            endReason: null,
        },
    ]);
});

it('a save joins an open unit of work and rolls back with it', async () => {
    const { db, uow, skills } = context();
    await expect(
        uow.run(async () => {
            await skills.save(content(), 'alice', 10);
            throw new Error('undo');
        }),
    ).rejects.toThrow('undo');
    expect(all(db, 'SELECT * FROM chat_skills')).toEqual([]);
    expect(all(db, 'SELECT * FROM chat_skill_revisions')).toEqual([]);
});
