import { DatabaseSync } from 'node:sqlite';

import { getTableName } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { migrate } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';

import type { ApprovalRepositories, NewApprovalRequest } from '../src/server/approvals/domain/repositories.js';
import { sqliteApprovalRepositories } from '../src/server/approvals/infra/sqlite/index.js';
import { approvalTables } from '../src/server/approvals/infra/sqlite/schema.js';
import { approvalsSchema } from '../src/server/approvals/migrations.js';
import { schemas } from '../src/server/modules/index.js';

import { testDatabase } from './helpers/test-database.js';

/*
 * Approvals' repository contract (CB-110): what any implementation of
 * `approvals/domain/repositories.ts` must keep, run against the SQLite one.
 */

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);

function approvals() {
    const db = testDatabase();
    cleanup.push(() => db.close());
    const data = sqliteData(db);
    return { db, uow: data.uow, repos: sqliteApprovalRepositories(data) };
}

let next = 0;
function request(fields: Partial<NewApprovalRequest> = {}): NewApprovalRequest {
    next++;
    return {
        id: `r${next}`,
        userId: 'alice',
        dotId: 'dot-1',
        capability: 'data.create_dataset',
        summary: `Request ${next}`,
        details: [],
        payload: { n: next },
        threadId: null,
        runId: null,
        createdAt: 1000 + next,
        expiresAt: 10_000,
        ...fields,
    };
}

async function seed(repos: ApprovalRepositories, ...items: NewApprovalRequest[]) {
    for (const item of items) {
        await repos.requests.insert(item);
    }
}

it('mirrors the migrated approval tables exactly, and only those', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [approvalsSchema]);
    expect(schemaDrift(db, approvalTables)).toEqual([]);
    const created = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
        )
        .all()
        .map((row) => String(row.name));
    expect(created).toHaveLength(6);
    expect(approvalTables.map((table) => getTableName(table)).sort()).toEqual(created);
    // Every module's migrations together leave them as mirrored.
    const all = new DatabaseSync(':memory:');
    cleanup.push(() => all.close());
    migrate(all, schemas);
    expect(schemaDrift(all, approvalTables)).toEqual([]);
});

it('reports a column the mirror does not know', () => {
    const db = testDatabase();
    cleanup.push(() => db.close());
    db.exec('ALTER TABLE approval_notes ADD COLUMN seen INTEGER');
    expect(schemaDrift(db, approvalTables)).toEqual([expect.stringContaining('seen')]);
});

it('keeps one policy per person, socio and capability', async () => {
    const { repos } = approvals();
    const policy = { userId: 'alice', dotId: 'd2', capability: 'b' };
    await repos.policies.set({ ...policy, policy: 'bypass', updatedAt: 1 });
    await repos.policies.set({ ...policy, policy: 'auto', updatedAt: 2 });
    await repos.policies.set({
        ...policy,
        dotId: 'd1',
        policy: 'manual',
        updatedAt: 3,
    });
    await repos.policies.set({
        ...policy,
        userId: 'bob',
        policy: 'auto',
        updatedAt: 4,
    });
    expect(await repos.policies.get('alice', 'd2', 'b')).toBe('auto');
    expect(await repos.policies.get('alice', 'd2', 'other')).toBeUndefined();
    // By socio, then capability; the person's own only.
    expect(await repos.policies.list('alice')).toEqual([
        { dotId: 'd1', capability: 'b', policy: 'manual', updatedAt: 3 },
        { dotId: 'd2', capability: 'b', policy: 'auto', updatedAt: 2 },
    ]);
    expect(await repos.policies.list('alice', 'd2')).toHaveLength(1);
    await repos.policies.removeForDot('d2');
    expect(await repos.policies.list('alice')).toHaveLength(1);
    expect(await repos.policies.list('bob')).toEqual([]);

    await repos.guidance.set('alice', 'Small notes only.', 1);
    await repos.guidance.set('alice', 'Nothing big.', 2);
    expect(await repos.guidance.get('alice')).toBe('Nothing big.');
    await repos.guidance.clear('alice');
    expect(await repos.guidance.get('alice')).toBeUndefined();
});

it('stores a request’s JSON as written and decides it once', async () => {
    const { db, repos } = approvals();
    await seed(
        repos,
        request({ id: 'plain', payload: undefined, details: ['One', 'Two'] }),
        request({ id: 'chat', threadId: 't1', runId: 'run-1' }),
    );
    // An absent payload is stored as JSON null, as before CB-110.
    expect(db.prepare("SELECT payload, details FROM approval_requests WHERE id='plain'").get()).toEqual({
        payload: 'null',
        details: '["One","Two"]',
    });
    expect(await repos.requests.byId('plain')).toMatchObject({
        status: 'pending',
        payload: null,
        details: ['One', 'Two'],
        undoData: null,
        continuation: null,
    });
    const decide = (id: string) =>
        repos.requests.decide(id, {
            status: 'approved',
            via: 'user',
            at: 5,
            deciding: true,
        });
    expect(await decide('plain')).toBe(true);
    expect(await decide('plain')).toBe(false);
    expect(await decide('chat')).toBe(true);
    // Only a request from a conversation joins its turn's batch.
    expect(await repos.requests.byId('plain')).toMatchObject({
        status: 'approved',
        decidedVia: 'user',
        decidedAt: 5,
        continuation: null,
    });
    expect((await repos.requests.byId('chat'))?.continuation).toBe('deciding');
    // A handler's undo data, `null` included, is kept as JSON.
    await repos.requests.recordExecution('plain', 'Done.', null);
    expect(db.prepare("SELECT undoData FROM approval_requests WHERE id='plain'").get()).toEqual({ undoData: 'null' });
    await repos.requests.recordExecution('chat', 'Done.', { id: 7 });
    expect(await repos.requests.byId('chat')).toMatchObject({
        outcome: 'Done.',
        undoData: { id: 7 },
    });
    await repos.requests.recordFailure('chat', 'It broke.');
    expect(await repos.requests.byId('chat')).toMatchObject({
        status: 'failed',
        outcome: 'It broke.',
    });
});

it('lists, finds pending and overdue requests, and expires them once', async () => {
    const { repos } = approvals();
    await seed(
        repos,
        request({ id: 'old', expiresAt: 50 }),
        request({ id: 'mine', dotId: 'dot-2' }),
        request({ id: 'other', capability: 'goal.set' }),
        request({ id: 'bob', userId: 'bob' }),
    );
    expect((await repos.requests.list('alice', { limit: 10 })).map((r) => r.id)).toEqual(['other', 'mine', 'old']);
    expect((await repos.requests.list('alice', { limit: 1, dotId: 'dot-2' })).map((r) => r.id)).toEqual(['mine']);
    expect((await repos.requests.pending('alice', 'dot-1', 'data.create_dataset')).map((r) => r.id)).toEqual(['old']);
    expect((await repos.requests.overdue(100)).map((r) => r.id)).toEqual(['old']);
    expect(await repos.requests.expire('old', 100)).toBe(true);
    expect(await repos.requests.expire('old', 100)).toBe(false);
    expect(await repos.requests.byId('old')).toMatchObject({
        status: 'expired',
        decidedVia: 'expiry',
        decidedAt: 100,
        outcome: null,
    });
    expect((await repos.requests.list('alice', { limit: 10, status: 'expired' })).map((r) => r.id)).toEqual(['old']);
    expect((await repos.requests.pendingOfDot('dot-2')).map((r) => r.id)).toEqual(['mine']);
    expect(await repos.requests.expire('mine', 200, 'The socio was deleted.')).toBe(true);
    expect((await repos.requests.byId('mine'))?.outcome).toBe('The socio was deleted.');
    // Only requests an auto review saw, and the person's own.
    await repos.reviews.insert({
        id: 'a1',
        requestId: 'other',
        userId: 'alice',
        dotId: 'dot-1',
        capability: 'goal.set',
        verdict: 'escalated',
        cause: 'model',
        modelDecision: 'escalate',
        risk: 'medium',
        reason: 'Unsure.',
        model: null,
        backend: null,
        latencyMs: 3,
        inputHash: null,
        createdAt: 10,
    });
    expect((await repos.requests.list('alice', { limit: 10, auto: true })).map((r) => r.id)).toEqual(['other']);
    expect(await repos.requests.list('bob', { limit: 10, auto: true })).toEqual([]);
    expect(await repos.requests.recentDecided('alice', 'data.create_dataset', 'x', 5)).toEqual([
        { summary: expect.any(String), status: 'expired', decidedVia: 'expiry' },
        { summary: expect.any(String), status: 'expired', decidedVia: 'expiry' },
    ]);
});

it('tracks how a turn carries on after its decisions', async () => {
    const { repos } = approvals();
    const turn = { threadId: 't1', runId: 'run-1', createdAt: 5 };
    await seed(
        repos,
        request({ id: 'a', ...turn }),
        request({ id: 'b', ...turn }),
        request({ id: 'c', ...turn, expiresAt: 50 }),
        request({ id: 'other', threadId: 't2', runId: 'run-2' }),
    );
    await repos.requests.decide('a', {
        status: 'approved',
        via: 'user',
        at: 6,
        deciding: true,
    });
    // `b` waits for its person, `a` is still running its action.
    expect(await repos.requests.outstandingInRun('t1', 'run-1', 'c', 10)).toBe(2);
    // At 60, `c` is overdue and doesn't count.
    expect(await repos.requests.outstandingInRun('t1', 'run-1', 'a', 60)).toBe(1);
    await repos.requests.setContinuation(['a'], 'waiting');
    await repos.requests.decide('b', { status: 'denied', via: 'user', at: 7 });
    await repos.requests.setContinuation(['b'], 'waiting');
    // The order they were made in, the same millisecond included.
    expect((await repos.requests.waitingIn('t1')).map((r) => r.id)).toEqual(['a', 'b']);
    expect(await repos.requests.waitingThreads()).toEqual(['t1']);
    await repos.requests.setContinuation(['a', 'b'], 'running', {
        continuationId: 'note-1',
        detail: null,
    });
    await repos.requests.setContinuation(['a'], 'done', { detail: 'Fine.' });
    expect(await repos.requests.byId('a')).toMatchObject({
        continuation: 'done',
        continuationId: 'note-1',
        continuationDetail: 'Fine.',
    });
    await repos.requests.setContinuation(['c'], 'deciding');
    await repos.requests.endRunning('Restarted.');
    expect(await repos.requests.byId('b')).toMatchObject({
        continuation: 'failed',
        continuationDetail: 'Restarted.',
    });
    expect((await repos.requests.byId('c'))?.continuation).toBe('waiting');
    expect(await repos.requests.waitingThreads()).toEqual(['t1']);
});

it('records auto reviews, counts approvals and undoes once', async () => {
    const { repos } = approvals();
    const review = (id: string, verdict: 'approved' | 'escalated', at: number) =>
        repos.reviews.insert({
            id,
            requestId: 'r',
            userId: 'alice',
            dotId: 'dot-1',
            capability: 'c',
            verdict,
            cause: 'model',
            modelDecision: null,
            risk: 'low',
            reason: 'Fine.',
            model: 'judge',
            backend: 'shared',
            latencyMs: 1,
            inputHash: null,
            createdAt: at,
        });
    await review('first', 'escalated', 10);
    await review('second', 'approved', 10);
    await review('older', 'approved', 5);
    // The newest; in the same millisecond, the one written last.
    expect((await repos.reviews.latest('r'))?.id).toBe('second');
    expect(await repos.reviews.approvedSince('dot-1', 4)).toBe(2);
    expect(await repos.reviews.approvedSince('dot-1', 5)).toBe(1);
    expect(await repos.reviews.claimUndo('second', 20)).toBe(true);
    expect(await repos.reviews.claimUndo('second', 21)).toBe(false);
    await repos.reviews.releaseUndo('second', 'Locked.');
    expect(await repos.reviews.latest('r')).toMatchObject({
        undoneAt: null,
        undoOutcome: 'Locked.',
    });
    expect(await repos.reviews.claimUndo('second', 22)).toBe(true);
    await repos.reviews.recordUndo('second', 'Removed.');
    expect(await repos.reviews.latest('r')).toMatchObject({
        undoneAt: 22,
        undoOutcome: 'Removed.',
    });
});

it('reads the audit newest first, by person and by socio, and the notes', async () => {
    const { repos } = approvals();
    const entry = (id: string, dotId: string, createdAt: number) =>
        repos.audit.append({
            id,
            userId: 'alice',
            dotId,
            capability: 'c',
            requestId: null,
            event: 'requested',
            actor: `dot:${dotId}`,
            detail: null,
            createdAt,
        });
    await entry('e1', 'd1', 10);
    await entry('e2', 'd1', 10);
    await entry('e3', 'd2', 20);
    expect((await repos.audit.forUser('alice', 10)).map((e) => e.id)).toEqual(['e3', 'e2', 'e1']);
    expect(await repos.audit.forUser('alice', 1)).toEqual([
        {
            id: 'e3',
            dotId: 'd2',
            capability: 'c',
            requestId: null,
            event: 'requested',
            actor: 'dot:d2',
            detail: null,
            createdAt: 20,
        },
    ]);
    expect(await repos.audit.forDot('d1', 10, 5)).toEqual([
        expect.objectContaining({
            userId: 'alice',
            event: 'requested',
            createdAt: 10,
        }),
        expect.objectContaining({ createdAt: 10 }),
    ]);
    expect(await repos.audit.forDot('d2', 19, 5)).toEqual([]);

    await repos.notes.insert({
        id: 'n1',
        threadId: 't1',
        userId: 'alice',
        content: 'Carry on.',
        createdAt: 1,
    });
    expect(await repos.notes.byId('n1')).toMatchObject({ threadId: 't1' });
    expect(await repos.notes.byId('n2')).toBeUndefined();
});

it('rolls back every repository write in a failed unit of work', async () => {
    const { db, uow, repos } = approvals();
    await expect(
        uow.run(
            async () => {
                await seed(repos, request({ id: 'gone' }));
                await repos.policies.set({
                    userId: 'alice',
                    dotId: 'd',
                    capability: 'c',
                    policy: 'bypass',
                    updatedAt: 1,
                });
                throw new Error('Nope');
            },
            { label: 'request and policy' },
        ),
    ).rejects.toThrow('Nope');
    expect(await repos.requests.byId('gone')).toBeUndefined();
    expect(await repos.policies.list('alice')).toEqual([]);
    expect(db.isTransaction).toBe(false);
});
