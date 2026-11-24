import { DatabaseSync } from 'node:sqlite';

import { getTableName } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { afterCommitEvents } from '@socio/data/events';
import { migrate } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';
import type { Issue, IssuePriority, IssueStatus } from '@socio/shared/issues/issue-types';

import type { BoardEvents } from '../src/server/issues/domain/events.js';
import type { BoardRepositories } from '../src/server/issues/domain/repositories.js';
import { sqliteBoardRepositories } from '../src/server/issues/infra/sqlite/index.js';
import { boardTables } from '../src/server/issues/infra/sqlite/schema.js';
import { issuesSchema } from '../src/server/issues/migrations.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

/*
 * The Board's repository contract (CB-110): what any implementation of
 * `issues/domain/repositories.ts` must keep, run against the SQLite one.
 */

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);

function board() {
    const db = testDatabase();
    cleanup.push(() => db.close());
    const data = sqliteData(db);
    return { db, uow: data.uow, repos: sqliteBoardRepositories(data) };
}

let next = 0;
function issue(fields: Partial<Issue> & { number: number }): Issue {
    return {
        id: `issue-${fields.number}`,
        title: `Issue ${fields.number}`,
        body: '',
        status: 'open' as IssueStatus,
        priority: 'medium' as IssuePriority,
        kind: 'bug',
        area: null,
        labels: [],
        reporterId: 'alice',
        assigneeId: null,
        resolution: null,
        source: 'web',
        createdAt: 1000 + next++,
        updatedAt: 1000,
        closedAt: null,
        ...fields,
    } as Issue;
}

async function seed(repos: BoardRepositories, ...issues: Issue[]) {
    for (const one of issues) {
        await repos.issues.insert(one);
    }
}

it('mirrors the migrated Board tables exactly, and only those', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [issuesSchema]);
    expect(schemaDrift(db, boardTables)).toEqual([]);
    const created = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
        )
        .all()
        .map((row) => String(row.name));
    expect(created).toHaveLength(21);
    expect(boardTables.map((table) => getTableName(table)).sort()).toEqual(created);
    // Every module's migrations together leave the Board's tables as mirrored.
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    expect(schemaDrift(workspace.db, boardTables)).toEqual([]);
});

it('reports a column the mirror does not know', () => {
    const db = testDatabase();
    cleanup.push(() => db.close());
    db.exec('ALTER TABLE issue_votes ADD COLUMN weight INTEGER');
    expect(schemaDrift(db, boardTables)).toEqual([expect.stringContaining('weight')]);
});

it('lists live issues in the board order and filters them', async () => {
    const { repos } = board();
    await seed(
        repos,
        issue({ number: 1, priority: 'low', updatedAt: 5 }),
        issue({ number: 2, priority: 'critical', updatedAt: 1, labels: ['ux'] }),
        issue({ number: 3, priority: 'medium', updatedAt: 9, title: '50% off_x' }),
        issue({ number: 4, priority: 'medium', updatedAt: 9 }),
        issue({ number: 5, priority: 'high', status: 'done' }),
    );
    await repos.issues.markDeleted('issue-5', 'alice', 2000);
    const numbers = async (filter?: Parameters<typeof repos.issues.list>[0]) =>
        (await repos.issues.list(filter)).map((one) => one.number);
    // Priority, then most recently updated, then the newest number.
    expect(await numbers()).toEqual([2, 4, 3, 1]);
    expect(await numbers({ label: 'ux' })).toEqual([2]);
    expect(await numbers({ priority: 'medium' })).toEqual([4, 3]);
    // LIKE wildcards in the query are literal.
    expect(await numbers({ q: '50%' })).toEqual([3]);
    expect(await numbers({ q: 'f_x' })).toEqual([3]);
    expect(await numbers({ q: '%' })).toEqual([3]);
    expect((await repos.issues.byNumber(2))?.labels).toEqual(['ux']);
    expect(await repos.issues.byNumber(5)).toBeUndefined();
    expect(await repos.issues.byId('issue-5')).toBeUndefined();
    expect(await repos.issues.withDeleted(5)).toMatchObject({
        deletedAt: 2000,
        deletedBy: 'alice',
    });
    expect((await repos.queries.titles({ open: true })).map((t) => t.number)).toEqual([2, 4, 3, 1]);
});

it('hands out numbers after the counter or the highest in use', async () => {
    const { repos } = board();
    expect(await repos.issues.nextNumber()).toBe(1);
    await seed(repos, issue({ number: 17 }));
    expect(await repos.issues.nextNumber()).toBe(18);
    // The counter remembers a number even once its issue is deleted.
    await repos.issues.markDeleted('issue-17', null, 2000);
    await seed(repos, issue({ number: 3 }));
    expect(await repos.issues.nextNumber()).toBe(18);
});

it('orders history by seq and reads it from a cursor', async () => {
    const { repos } = board();
    await seed(repos, issue({ number: 1 }), issue({ number: 2 }));
    expect(await repos.history.lastSeq()).toBe(0);
    const event = (id: string, issueId: string, kind: 'status' | 'title') =>
        repos.history.append({
            id,
            issueId,
            actorId: 'alice',
            kind,
            fromValue: null,
            toValue: null,
            // The same millisecond: only seq tells them apart.
            createdAt: 5000,
        });
    await event('b', 'issue-1', 'status');
    await event('a', 'issue-1', 'title');
    const cursor = await repos.history.lastSeq();
    expect(cursor).toBe(2);
    await event('d', 'issue-2', 'status');
    await event('c', 'issue-1', 'status');
    expect((await repos.history.forIssue('issue-1')).map((e) => e.id)).toEqual(['b', 'a', 'c']);
    expect(await repos.history.after(cursor, { issueId: 'issue-1' })).toEqual([{ id: 'c', kind: 'status' }]);
    expect(await repos.history.after(0, { issueId: 'issue-1', kind: 'title' })).toEqual([{ id: 'a', kind: 'title' }]);
});

it('follows live blocked-by links, directly and through others', async () => {
    const { repos } = board();
    await seed(
        repos,
        issue({ number: 1 }),
        issue({ number: 2 }),
        issue({ number: 3, status: 'done' }),
        issue({ number: 4 }),
    );
    const link = (from: number, to: number) =>
        repos.issues.addLink({
            id: `link-${from}-${to}`,
            fromId: `issue-${from}`,
            toId: `issue-${to}`,
            createdBy: 'alice',
            createdAt: 1,
        });
    await link(1, 2);
    await link(2, 3);
    await link(1, 4);
    expect(await repos.issues.reaches('issue-1', 'issue-3')).toBe(true);
    expect(await repos.issues.reaches('issue-3', 'issue-1')).toBe(false);
    expect(await repos.issues.hasLink('issue-1', 'issue-3')).toBe(false);
    expect((await repos.issues.links('issue-1', 'blockedBy')).map((l) => l.number)).toEqual([2, 4]);
    expect((await repos.issues.links('issue-3', 'blocks')).map((l) => l.number)).toEqual([2]);
    // Closed blockers and deleted ones don't hold an issue up.
    await repos.issues.markDeleted('issue-4', null, 2);
    expect(await repos.queries.openBlockerNumbers()).toEqual(new Map([['issue-1', [2]]]));
    expect(await repos.issues.removeLink('issue-2', 'issue-3', 'alice', 3)).toBe(true);
    expect(await repos.issues.removeLink('issue-2', 'issue-3', 'alice', 4)).toBe(false);
    expect(await repos.issues.reaches('issue-1', 'issue-3')).toBe(false);
});

it('keeps one live vote per person per item', async () => {
    const { repos } = board();
    await seed(repos, issue({ number: 1 }), issue({ number: 2 }));
    const vote = (id: string, issueId: string, userId: string) =>
        repos.votes.insert({ id, issueId, userId, dotId: null, createdAt: 1 });
    await vote('v1', 'issue-1', 'alice');
    await vote('v2', 'issue-1', 'bob');
    await vote('v3', 'issue-2', 'alice');
    await expect(vote('v4', 'issue-1', 'alice')).rejects.toThrow();
    expect(await repos.votes.live('issue-1', 'alice')).toBe('v1');
    await repos.votes.withdraw('v1', 2);
    expect(await repos.votes.live('issue-1', 'alice')).toBeUndefined();
    await vote('v5', 'issue-1', 'alice');
    expect(await repos.votes.count('issue-1')).toBe(2);
    expect(await repos.votes.counts()).toEqual(
        new Map([
            ['issue-1', 2],
            ['issue-2', 1],
        ]),
    );
    expect(await repos.votes.mine('alice')).toEqual(new Set(['issue-1', 'issue-2']));
});

it('moves triage from pending to proposed to decided, once', async () => {
    const { repos } = board();
    await seed(repos, issue({ number: 1 }), issue({ number: 2 }));
    await repos.triage.insertPending('issue-1', 100);
    await repos.triage.insertPending('issue-2', 200);
    expect(await repos.triage.startedSince(150)).toBe(1);
    // Deciding before a proposal does nothing.
    expect(await repos.triage.decide('issue-1', 'applied', 'alice', 300)).toBe(false);
    await repos.triage.propose(
        'issue-1',
        {
            kind: 'feature',
            area: null,
            priority: 'high',
            labels: ['ux'],
            components: [],
            reason: 'Why',
        },
        'comment-1',
    );
    expect(await repos.triage.get('issue-1')).toMatchObject({
        state: 'proposed',
        labels: ['ux'],
        commentId: 'comment-1',
    });
    expect(await repos.triage.decide('issue-1', 'ignored', 'alice', 300)).toBe(true);
    expect(await repos.triage.decide('issue-1', 'applied', 'alice', 400)).toBe(false);
    expect(await repos.triage.failPending('Restarted')).toBe(1);
    expect(await repos.triage.get('issue-2')).toMatchObject({
        state: 'failed',
        error: 'Restarted',
    });
    await expect(repos.triage.insertPending('issue-1', 500)).rejects.toThrow();
});

it('summarises requests and notices for the person a socio asked for', async () => {
    const { repos } = board();
    await seed(
        repos,
        issue({ number: 1, kind: 'request', createdAt: 10 }),
        issue({ number: 2, kind: 'request', createdAt: 20 }),
    );
    for (const n of [1, 2]) {
        await repos.requests.insert({
            issueId: `issue-${n}`,
            key: 'export pdf',
            capability: 'Export PDF',
            createdAt: n,
        });
    }
    const ask = (id: string, issueId: string, dotId: string, at: number) =>
        repos.requests.addRequester({
            id,
            issueId,
            dotId,
            userId: 'alice',
            why: 'Why',
            example: 'Example',
            createdAt: at,
        });
    await ask('r1', 'issue-1', 'dot-b', 5);
    await ask('r2', 'issue-1', 'dot-a', 5);
    await ask('r3', 'issue-2', 'dot-a', 6);
    expect(await repos.queries.openRequest('export pdf')).toEqual({
        issueId: 'issue-1',
        capability: 'Export PDF',
    });
    expect(await repos.requests.dotsFor('issue-1', 'alice')).toEqual(['dot-b', 'dot-a']);
    expect(await repos.requests.demandOf('issue-1')).toBe(2);
    expect(await repos.queries.demand()).toEqual(
        new Map([
            ['issue-1', 2],
            ['issue-2', 1],
        ]),
    );
    expect(await repos.requests.countSince({ dotId: 'dot-a' }, 5)).toBe(1);

    await repos.issues.update('issue-1', { status: 'done', closedAt: 50 });
    expect(await repos.queries.openRequest('export pdf')).toMatchObject({
        issueId: 'issue-2',
    });
    const summaries = (closed: boolean, unannounced = false) =>
        repos.queries
            .requestSummaries('dot-a', 'alice', { closed, unannounced })
            .then((rows) => rows.map((row) => row.number));
    expect(await summaries(true)).toEqual([1]);
    expect(await summaries(false)).toEqual([2]);
    await repos.requests.markAnnounced('issue-1', 'dot-a', 'alice', 60);
    expect(await summaries(true, true)).toEqual([]);
    await repos.requests.resetAnnounced('issue-1');
    expect(await summaries(true, true)).toEqual([1]);

    for (const id of ['n1', 'n2']) {
        await repos.requests.addNotice({
            id,
            issueId: 'issue-1',
            userId: 'alice',
            status: 'done',
            resolution: null,
            createdAt: 70,
        });
    }
    // Newest first; the same millisecond falls back to the later row first.
    expect((await repos.queries.notices('alice')).map((n) => n.id)).toEqual(['n2', 'n1']);
    expect(await repos.requests.markSeen('bob', 'n2', 80)).toBe(false);
    expect(await repos.requests.markSeen('alice', 'n2', 80)).toBe(true);
    expect(await repos.requests.markSeen('alice', 'n2', 90)).toBe(false);
    expect((await repos.queries.notices('alice')).map((n) => n.id)).toEqual(['n1']);
    // A deleted request's notices go with it.
    await repos.issues.markDeleted('issue-1', null, 100);
    expect(await repos.queries.notices('alice')).toEqual([]);
});

it('answers titles by id, deleted issues only when asked', async () => {
    const { repos } = board();
    await seed(repos, issue({ number: 1 }), issue({ number: 2 }));
    await repos.issues.markDeleted('issue-2', null, 5);
    expect(await repos.queries.titlesById(['issue-1', 'issue-2', 'issue-1', 'nope'])).toEqual(
        new Map([['issue-1', { number: 1, title: 'Issue 1', status: 'open' }]]),
    );
    expect([...(await repos.queries.titlesById(['issue-2'], { deleted: true }))]).toEqual([
        ['issue-2', { number: 2, title: 'Issue 2', status: 'open' }],
    ]);
    expect(await repos.queries.titlesById([])).toEqual(new Map());
});

it('rolls back every repository write in a failed unit of work', async () => {
    const { db, uow, repos } = board();
    await expect(
        uow.run(
            async () => {
                await seed(repos, issue({ number: 1 }));
                await repos.votes.insert({
                    id: 'v1',
                    issueId: 'issue-1',
                    userId: 'alice',
                    dotId: null,
                    createdAt: 1,
                });
                throw new Error('Nope');
            },
            { label: 'file and vote' },
        ),
    ).rejects.toThrow('Nope');
    expect(await repos.issues.list()).toEqual([]);
    expect(await repos.votes.count('issue-1')).toBe(0);
    // The counter moved back too.
    expect(await repos.issues.nextNumber()).toBe(1);
    expect(db.isTransaction).toBe(false);
});

it('delivers Board events after commit, and never for a rollback', async () => {
    const { uow, repos } = board();
    const failures: Array<keyof BoardEvents> = [];
    const events = afterCommitEvents<BoardEvents>(uow, (type) => failures.push(type));
    const seen: Array<[number, number]> = [];
    events.subscribe('created', async ({ issue: created }) => {
        // After commit: the issue is there for any reader.
        seen.push([created.number, (await repos.issues.list()).length]);
    });
    events.subscribe('created', () => {
        throw new Error('Listener broke');
    });
    await uow.run(
        async () => {
            const one = issue({ number: 1 });
            await seed(repos, one);
            events.publish('created', { issue: one });
            expect(seen).toEqual([]);
        },
        { label: 'file' },
    );
    await expect(
        uow.run(
            async () => {
                const two = issue({ number: 2 });
                await seed(repos, two);
                events.publish('created', { issue: two });
                throw new Error('Nope');
            },
            { label: 'file' },
        ),
    ).rejects.toThrow('Nope');
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual([[1, 1]]);
    expect(failures).toEqual(['created']);
});

it('status history follows persisted sequence for legacy inserts even when timestamps tie or move backwards', async () => {
    const { db, repos } = board();
    const insert = db.prepare(
        'INSERT INTO issue_events(id,issueId,actorId,kind,fromValue,toValue,createdAt) VALUES(?,?,?,?,?,?,?)',
    );
    insert.run('created-history', 'issue-a', 'private-actor', 'created', null, 'triage', 1000);
    insert.run('unrelated-body', 'issue-a', 'private-actor', 'body', 'old', 'new', 2000);
    insert.run('status-history', 'issue-a', 'private-actor', 'status', 'triage', 'open', 900);
    const first = await repos.history.statusEvents('issue-a', 0, 1);
    expect(first).toMatchObject([{ kind: 'created', at: 1000, from: null, to: 'triage' }]);
    const second = await repos.history.statusEvents('issue-a', first[0]!.sequence, 2);
    expect(second).toMatchObject([{ kind: 'status', at: 900, from: 'triage', to: 'open' }]);
    expect(second[0]!.sequence).toBeGreaterThan(first[0]!.sequence);
    expect(JSON.stringify([...first, ...second])).not.toMatch(/private-actor|actorId|unrelated-body/);
});
