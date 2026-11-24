import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it } from 'vitest';

import { migrate } from '@socio/data/migrate';

import { issuesSchema } from '../src/server/issues/migrations.js';
import { sqliteBoard } from '../src/server/issues/services.js';
import { ASSIGNEE_DEACTIVATED } from '../src/server/issues/store.js';

import { boardOf } from './helpers/board.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);
/** The connection each store from `issues()` is on, for raw reads. */
const connections = new WeakMap<object, DatabaseSync>();
function issues() {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    connections.set(boardOf(workspace).issues, workspace.db);
    return boardOf(workspace).issues;
}
/** The Board's issue service on a bare migrated connection. */
const issueStore = (db: DatabaseSync) =>
    sqliteBoard(db, {
        userExists: () => true,
        deactivated: () => false,
        dot: () => undefined,
    }).issues;

it('numbers issues CB-1, CB-2… and continues after imported numbers', async () => {
    const store = issues();
    expect((await store.create({ title: 'First issue' }, 'bob')).number).toBe(1);
    expect((await store.create({ title: 'Second issue' }, 'bob')).number).toBe(2);
    await store.import([
        {
            number: 17,
            title: 'Imported',
            body: '',
            status: 'done',
            priority: 'low',
            kind: 'bug',
            area: null,
            labels: [],
            resolution: null,
        },
    ]);
    expect((await store.create({ title: 'After import' }, 'bob')).number).toBe(18);
});

const imported = (number: number, title = `Imported ${number}`) => ({
    number,
    title,
    body: '',
    status: 'open' as const,
    priority: 'low' as const,
    kind: 'bug' as const,
    area: null,
    labels: [],
    resolution: null,
});

it('never reuses the number of a deleted issue (CB-39)', async () => {
    const store = issues();
    await store.create({ title: 'First issue' }, 'bob');
    const newest = await store.create({ title: 'Newest issue' }, 'bob');
    expect(newest.number).toBe(2);
    await store.remove(2);
    const next = await store.create({ title: 'After the delete' }, 'bob');
    expect(next.number).toBe(3);
    expect(await store.get(2)).toBeUndefined();
    // Deleting everything still doesn't start over.
    await store.remove(1);
    await store.remove(3);
    expect((await store.create({ title: 'Fresh start?' }, 'bob')).number).toBe(4);
});

it('keeps import and the counter consistent (CB-39)', async () => {
    const store = issues();
    expect((await store.create({ title: 'Filed first' }, 'bob')).number).toBe(1);
    // Imported numbers above the counter move it on.
    expect(await store.import([imported(1), imported(9), imported(5)])).toEqual({
        created: [9, 5],
        skipped: [1],
    });
    expect((await store.create({ title: 'After import' }, 'bob')).number).toBe(10);
    // Deleting the newest, then re-importing a lower number, doesn't rewind.
    await store.remove(10);
    await store.import([imported(7)]);
    expect((await store.create({ title: 'Next' }, 'bob')).number).toBe(11);
    // A deleted issue still in the snapshot stays deleted (CB-64: it is
    // kept; bringing it back is the admin view's), and its number is taken.
    await store.remove(9);
    expect(await store.import([imported(9, 'Restored')])).toEqual({
        created: [],
        skipped: [9],
    });
    expect(await store.get(9)).toBeUndefined();
    expect((await store.create({ title: 'And on' }, 'bob')).number).toBe(12);
});

it('seeds the counter from the highest number when migrating (CB-39)', async () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    // A database from before the counter: only the baseline ran.
    migrate(db, [{ ...issuesSchema, migrations: issuesSchema.migrations!.slice(0, 1) }]);
    const insert = db.prepare(
        "INSERT INTO issues (id, number, title, status, priority, kind, reporterId, createdAt, updatedAt) VALUES (?, ?, 't', 'open', 'low', 'bug', 'a', 0, 0)",
    );
    insert.run('a', 3);
    insert.run('b', 41);
    migrate(db, [issuesSchema]);
    expect(db.prepare('SELECT id, last FROM issue_counter').all()).toEqual([{ id: 1, last: 41 }]);
    const store = issueStore(db);
    await store.remove(41);
    expect((await store.create({ title: 'After the migration' }, 'a')).number).toBe(42);
    // A fresh database starts at zero.
    const fresh = new DatabaseSync(':memory:');
    cleanup.push(() => fresh.close());
    migrate(fresh, [issuesSchema]);
    expect(fresh.prepare('SELECT last FROM issue_counter').get()).toEqual({
        last: 0,
    });
});

it('defaults new issues to triage and records who filed them', async () => {
    const store = issues();
    const issue = await store.create({ title: 'Broken link', body: 'Click does nothing.' }, 'bob', 100);
    expect(issue).toMatchObject({
        status: 'triage',
        priority: 'medium',
        kind: 'bug',
        area: null,
        labels: [],
        reporterId: 'bob',
        assigneeId: null,
        source: 'web',
        createdAt: 100,
        closedAt: null,
    });
    expect(await store.events(issue.id)).toMatchObject([{ kind: 'created', actorId: 'bob', toValue: 'triage' }]);
});

it('takes the Web chat and Homepage areas, and keeps an issue’s area', async () => {
    const store = issues();
    const old = await store.create({ title: 'Old', area: 'client' }, 'bob', 1);
    const chat = await store.create({ title: 'Draft lost', area: 'chat' }, 'bob', 2);
    expect(chat.area).toBe('chat');
    expect(await store.update(chat.number, { area: 'homepage' }, 'alice', 3)).toMatchObject({ area: 'homepage' });
    expect((await store.get(old.number))?.area).toBe('client');
});

it('takes the Schedules area (CB-88)', async () => {
    const store = issues();
    const issue = await store.create({ title: 'Schedule page says little', area: 'schedules' }, 'bob', 1);
    expect((await store.get(issue.number))?.area).toBe('schedules');
    expect(await store.update(issue.number, { area: 'client' }, 'alice', 2)).toMatchObject({ area: 'client' });
});

it('enforces enums in the store and in the table', async () => {
    const store = issues();
    await expect(store.create({ title: 'Bad', status: 'closed' as never }, 'bob')).rejects.toThrow();
    await expect(store.create({ title: 'Bad labels', labels: ['wat' as never] }, 'bob')).rejects.toThrow();
    await expect(store.create({ title: 'Bad area', area: 'kitchen' as never }, 'bob')).rejects.toThrow();
    await expect(store.create({ title: 'x' }, 'bob')).rejects.toThrow();
    const db = testDatabase();
    cleanup.push(() => db.close());
    issueStore(db);
    expect(() =>
        db
            .prepare(
                "INSERT INTO issues (id, number, title, status, priority, kind, reporterId, createdAt, updatedAt) VALUES ('x', 1, 't', 'closed', 'low', 'bug', 'a', 0, 0)",
            )
            .run(),
    ).toThrow(/CHECK/);
});

it('writes a history row for every changed field and tracks closing', async () => {
    const store = issues();
    const { number, id } = await store.create({ title: 'Slow page' }, 'bob', 1);
    await store.update(
        number,
        {
            status: 'open',
            priority: 'high',
            labels: ['ux', 'performance'],
            area: 'client',
            assigneeId: 'alice',
            title: 'Slow page',
        },
        'alice',
        2,
    );
    const done = await store.update(number, { status: 'done', resolution: 'Fixed in abc1234' }, 'alice', 3);
    expect(done).toMatchObject({
        closedAt: 3,
        updatedAt: 3,
        labels: ['performance', 'ux'],
    });
    expect((await store.events(id)).map((e) => [e.kind, e.fromValue, e.toValue])).toEqual([
        ['created', null, 'triage'],
        ['status', 'triage', 'open'],
        ['priority', 'medium', 'high'],
        ['area', null, 'client'],
        ['assignee', null, 'alice'],
        ['labels', null, 'performance,ux'],
        ['status', 'open', 'done'],
        ['resolution', null, 'Fixed in abc1234'],
    ]);
    // No change, no history.
    await store.update(number, { status: 'done' }, 'alice', 4);
    expect(await store.events(id)).toHaveLength(8);
    expect((await store.update(number, { status: 'open' }, 'alice', 5)).closedAt).toBe(null);
    await expect(store.update(number, { assigneeId: 'mallory' }, 'alice')).rejects.toThrow(
        'Choose an assignee who has signed in.',
    );
});

it('gives a deactivated person no new issues; their assignments stay', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    const deactivated: string[] = [];
    workspace.useDeactivated(() => deactivated);
    const store = boardOf(workspace).issues;
    const kept = await store.create({ title: 'Bob’s', assigneeId: 'bob' }, 'alice');
    deactivated.push('bob');
    expect(workspace.isDeactivated('bob')).toBe(true);
    await expect(store.create({ title: 'New', assigneeId: 'bob' }, 'alice')).rejects.toThrow(ASSIGNEE_DEACTIVATED);
    const other = await store.create({ title: 'Other' }, 'alice');
    await expect(store.update(other.number, { assigneeId: 'bob' }, 'alice')).rejects.toThrow(ASSIGNEE_DEACTIVATED);
    // Bob keeps his issue: other changes, and a patch that names him again, pass.
    expect(await store.update(kept.number, { status: 'open', assigneeId: 'bob' }, 'alice')).toMatchObject({
        status: 'open',
        assigneeId: 'bob',
    });
    expect((await store.update(kept.number, { assigneeId: 'alice' }, 'alice')).assigneeId).toBe('alice');
    await expect(store.update(kept.number, { assigneeId: 'bob' }, 'alice')).rejects.toThrow(ASSIGNEE_DEACTIVATED);
    // Reactivated, he can be given issues again.
    deactivated.length = 0;
    expect((await store.update(other.number, { assigneeId: 'bob' }, 'alice')).assigneeId).toBe('bob');
});

it('filters, searches and orders by priority', async () => {
    const store = issues();
    await store.create({ title: 'Low thing', priority: 'low' }, 'bob', 1);
    await store.create({ title: 'Critical 100% outage', priority: 'critical' }, 'bob', 2);
    await store.create({ title: 'Medium thing', body: 'about telegram', labels: ['ux'] }, 'bob', 3);
    expect((await store.list()).map((issue) => issue.priority)).toEqual(['critical', 'medium', 'low']);
    expect((await store.list({ q: 'TELEGRAM' })).map((i) => i.number)).toEqual([3]);
    expect((await store.list({ q: '100%' })).map((i) => i.number)).toEqual([2]);
    expect((await store.list({ q: '%' })).map((i) => i.number)).toEqual([2]);
    expect((await store.list({ label: 'ux' })).map((i) => i.number)).toEqual([3]);
    expect((await store.list({ priority: 'low' })).map((i) => i.number)).toEqual([1]);
});

it('keeps comments with history, and deletes an issue with everything on it (hidden and kept, CB-64)', async () => {
    const store = issues();
    const { number, id } = await store.create({ title: 'Has comments' }, 'bob');
    const comment = await store.addComment(number, 'First!', 'bob');
    await store.editComment(number, comment.id, 'First, edited', 'bob');
    expect(await store.comments(id)).toMatchObject([{ body: 'First, edited', authorKind: 'user', authorId: 'bob' }]);
    await store.deleteComment(number, comment.id, 'alice');
    expect(await store.comments(id)).toEqual([]);
    expect((await store.events(id)).map((e) => e.kind)).toEqual([
        'created',
        'comment_added',
        'comment_edited',
        'comment_deleted',
    ]);
    const another = await store.addComment(number, 'Another', 'bob');
    await store.remove(number, 'alice');
    expect(await store.get(number)).toBeUndefined();
    expect(await store.byId(id)).toBeUndefined();
    expect(await store.list()).toEqual([]);
    expect(await store.comments(id)).toEqual([]);
    await expect(store.remove(number)).rejects.toThrow('Issue not found.');
    await expect(store.addComment(number, 'Late', 'bob')).rejects.toThrow('Issue not found.');
    // Kept: the row, its comments (the one deleted first keeps its own stamp)
    // and its history, which says it was deleted.
    expect(await store.withDeleted(number)).toMatchObject({
        title: 'Has comments',
        deletedBy: 'alice',
    });
    const rows = (commentId: string) =>
        connections
            .get(store)!
            .prepare('SELECT body, deletedBy, deletedWith FROM issue_comments WHERE id=?')
            .get(commentId);
    expect(rows(comment.id)).toEqual({
        body: 'First, edited',
        deletedBy: 'alice',
        deletedWith: null,
    });
    expect(rows(another.id)).toEqual({
        body: 'Another',
        deletedBy: 'alice',
        deletedWith: `issue:${id}`,
    });
    expect((await store.events(id)).map((e) => e.kind)).toEqual([
        'created',
        'comment_added',
        'comment_edited',
        'comment_deleted',
        'comment_added',
        'deleted',
    ]);
});
