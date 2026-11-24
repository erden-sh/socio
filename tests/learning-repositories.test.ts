import { DatabaseSync } from 'node:sqlite';

import { getTableName } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { migrate } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';

import type { AnalysisRun } from '../src/server/learning/contract.js';
import { sqliteLearningRepositories } from '../src/server/learning/infra/sqlite/index.js';
import { learningTables } from '../src/server/learning/infra/sqlite/schema.js';
import { learningSchema } from '../src/server/learning/migrations.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

/*
 * Learning's repository contract (CB-110): what any implementation of
 * `learning/domain/repositories.ts` must keep, run against the SQLite one,
 * and the drift check of its Drizzle mirror.
 */

const cleanup: Array<() => void> = [];
afterEach(() => {
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn());
    vi.restoreAllMocks();
});

function context() {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [learningSchema]);
    const data = sqliteData(db);
    return { db, uow: data.uow, repos: sqliteLearningRepositories(data) };
}

const all = (db: DatabaseSync, sql: string) => db.prepare(sql).all();

const thread = {
    threadId: 't1',
    containerId: 'c1',
    dotId: 'dot-1',
    ownerId: 'alice',
};

it('mirrors the migrated Learning tables exactly, and only those', () => {
    const { db } = context();
    expect(schemaDrift(db, learningTables)).toEqual([]);
    const created = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
        )
        .all()
        .map((row) => String(row.name));
    expect(learningTables.map((table) => getTableName(table)).sort()).toEqual(created);
    // The workspace migrates them with its own.
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    expect(schemaDrift(workspace.db, learningTables)).toEqual([]);
});

it('reports a column the mirror does not know', () => {
    const { db } = context();
    db.exec('ALTER TABLE learning_runs ADD COLUMN note TEXT');
    expect(schemaDrift(db, learningTables)).toEqual([expect.stringContaining('note')]);
});

it('records evidence: a failed run keeps the last finish but is not eligible', () => {
    const { db, repos } = context();
    repos.evidence.recordNow({ ...thread, finished: true, at: 10 });
    expect(all(db, 'SELECT * FROM learning_evidence')).toEqual([{ ...thread, eligible: 1, finishedAt: 10 }]);
    repos.evidence.recordNow({ ...thread, finished: false, at: 20 });
    expect(all(db, 'SELECT eligible, finishedAt FROM learning_evidence')).toEqual([{ eligible: 0, finishedAt: 10 }]);
    // The thread keeps its container; a later finish makes it eligible again.
    repos.evidence.recordNow({
        ...thread,
        containerId: 'c2',
        finished: true,
        at: 30,
    });
    expect(all(db, 'SELECT * FROM learning_evidence')).toEqual([{ ...thread, eligible: 1, finishedAt: 30 }]);
});

it('moves an analysis cursor forward only', () => {
    const { db, repos } = context();
    repos.evidence.markAnalyzedNow('c1', 20);
    repos.evidence.markAnalyzedNow('c1', 10);
    repos.evidence.markAnalyzedNow('c2', 5);
    expect(all(db, 'SELECT * FROM learning_cursors ORDER BY 1')).toEqual([
        { containerId: 'c1', analyzedThrough: 20 },
        { containerId: 'c2', analyzedThrough: 5 },
    ]);
    repos.evidence.markAnalyzedNow('c1', 30);
    expect(all(db, "SELECT analyzedThrough FROM learning_cursors WHERE containerId='c1'")).toEqual([
        { analyzedThrough: 30 },
    ]);
});

it('adds skill and container revisions, and pins and unpins one', () => {
    const { db, repos } = context();
    const files = [{ path: 'SKILL.md', content: '---\nname: a\n---\nDo it.\n' }];
    repos.skills.insertRevisionNow({
        id: 'r1',
        containerId: 'c1',
        name: 'a',
        revision: 1,
        description: 'Does a.',
        files,
        createdAt: 10,
        createdBy: 'alice',
    });
    repos.skills.insertContainerRevisionNow({
        containerId: 'c1',
        revision: 1,
        skills: [{ name: 'a', revisionId: 'r1' }],
        createdAt: 10,
        createdBy: 'alice',
    });
    expect(all(db, 'SELECT files FROM learning_skill_revisions')).toEqual([{ files: JSON.stringify(files) }]);
    expect(all(db, 'SELECT skills FROM learning_container_revisions')).toEqual([
        { skills: '[{"name":"a","revisionId":"r1"}]' },
    ]);
    repos.skills.pinNow('c1', 1);
    repos.skills.pinNow('c1', 2);
    expect(all(db, 'SELECT * FROM learning_container_pins')).toEqual([{ containerId: 'c1', revision: 2 }]);
    repos.skills.unpinNow('c1');
    expect(all(db, 'SELECT * FROM learning_container_pins')).toEqual([]);
});

const run = (fields: Partial<AnalysisRun> = {}): AnalysisRun => ({
    id: 'run-1',
    containerId: 'c1',
    trigger: 'manual',
    status: 'running',
    startedAt: 10,
    finishedAt: null,
    threads: 0,
    proposals: 0,
    dropped: 0,
    dropReasons: {},
    skipped: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    error: null,
    startedBy: 'alice',
    ...fields,
});

it('starts, counts and finishes a run, and fails the ones left running', () => {
    const { db, repos } = context();
    repos.runs.startSoon(run());
    expect(all(db, 'SELECT * FROM learning_runs')).toEqual([{ ...run(), dropReasons: '{}' }]);
    repos.runs.recordDropsNow('run-1', 2, { rejected: 1, malformed: 1 });
    repos.runs.recordProposalCountNow('run-1', 3);
    expect(all(db, 'SELECT dropped, dropReasons, proposals FROM learning_runs')).toEqual([
        {
            dropped: 2,
            dropReasons: '{"rejected":1,"malformed":1}',
            proposals: 3,
        },
    ]);
    repos.runs.finishNow(
        run({
            status: 'succeeded',
            finishedAt: 20,
            threads: 4,
            proposals: 3,
            dropped: 2,
            dropReasons: { rejected: 2 },
            skipped: 1,
            inputTokens: 100,
            outputTokens: 50,
            costUsd: 0.25,
        }),
    );
    expect(all(db, 'SELECT * FROM learning_runs')).toEqual([
        {
            ...run(),
            status: 'succeeded',
            finishedAt: 20,
            threads: 4,
            proposals: 3,
            dropped: 2,
            dropReasons: '{"rejected":2}',
            skipped: 1,
            inputTokens: 100,
            outputTokens: 50,
            costUsd: 0.25,
        },
    ]);
    repos.runs.startSoon(run({ id: 'run-2', trigger: 'schedule' }));
    expect(repos.runs.failRunningNow('Interrupted by a restart.', 30)).toBe(1);
    expect(all(db, 'SELECT id, status, error, finishedAt FROM learning_runs ORDER BY id')).toEqual([
        { id: 'run-1', status: 'succeeded', error: null, finishedAt: 20 },
        {
            id: 'run-2',
            status: 'failed',
            error: 'Interrupted by a restart.',
            finishedAt: 30,
        },
    ]);
});

it('queues a run’s start behind an open unit of work', async () => {
    const { db, uow, repos } = context();
    let release!: () => void;
    const held = uow.run(() => new Promise<void>((resolve) => (release = resolve)), { label: 'held' });
    await Promise.resolve();
    repos.runs.startSoon(run());
    expect(all(db, 'SELECT id FROM learning_runs')).toEqual([]);
    release();
    await held;
    await vi.waitFor(() => expect(all(db, 'SELECT id FROM learning_runs')).toEqual([{ id: 'run-1' }]));
});

it('stores a proposal pending and records its review', () => {
    const { db, repos } = context();
    repos.proposals.insertNow({
        id: 'p1',
        containerId: 'c1',
        runId: 'run-1',
        name: 'a',
        description: 'Does a.',
        skillMd: 'Do it.',
        rationale: 'Seen twice.',
        evidenceThreadIds: ['t1', 't2'],
        createdAt: 10,
    });
    expect(all(db, 'SELECT * FROM learning_proposals')).toEqual([
        {
            id: 'p1',
            containerId: 'c1',
            runId: 'run-1',
            name: 'a',
            description: 'Does a.',
            skillMd: 'Do it.',
            rationale: 'Seen twice.',
            evidenceThreadIds: '["t1","t2"]',
            status: 'pending',
            createdAt: 10,
            reviewedBy: null,
            reviewedAt: null,
            revisionId: null,
        },
    ]);
    repos.proposals.reviewNow('p1', {
        name: 'b',
        description: 'Does b.',
        skillMd: 'Do b.',
        status: 'published',
        revisionId: 'r1',
        reviewedBy: 'bob',
        reviewedAt: 20,
    });
    expect(
        all(
            db,
            'SELECT name, description, skillMd, status, revisionId, reviewedBy, reviewedAt, rationale FROM learning_proposals',
        ),
    ).toEqual([
        {
            name: 'b',
            description: 'Does b.',
            skillMd: 'Do b.',
            status: 'published',
            revisionId: 'r1',
            reviewedBy: 'bob',
            reviewedAt: 20,
            rationale: 'Seen twice.',
        },
    ]);
});
