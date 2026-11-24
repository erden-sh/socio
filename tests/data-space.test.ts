import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { backupUserData, mirrorObjects, snapshotObjects } from '@socio/data/backup';
import { VIEW_NO_ACCESS } from '@socio/shared/dataset-view';

import { sqliteApprovals } from '../src/server/approvals/services.js';
import { type DataActor } from '../src/server/dataspace/contract.js';
import { DatasetFileMissingError } from '../src/server/dataspace/engine.js';
import { makeDataModule } from '../src/server/dataspace/module.js';
import { DataSpace, sharedOwner } from '../src/server/dataspace/space.js';
import { DataTokens } from '../src/server/dataspace/tokens.js';
import type { ModuleContext } from '../src/server/modules/contract.js';
import { S3ObjectStore } from '../src/server/storage/s3-store.js';

import { startFakeS3, type FakeS3 } from './fixtures/fake-s3.js';
import { dataSpaceStorage } from './helpers/data-space-storage.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.useRealTimers();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

function fixture(limits = {}, secret = 'secret-0123456789abcdef-xyz') {
    const dir = mkdtempSync(join(tmpdir(), 'cb-data-space-'));
    const workspace = new WorkspaceStore(testDatabase());
    for (const [id, name, role] of [
        ['alice', 'Alice', 'admin'],
        ['bob', 'Bob', 'member'],
    ] as const) {
        workspace.recordUser({ id, name, role });
    }
    const approvals = sqliteApprovals(workspace.db, {
        dotName: (id) => workspace.dot(id)?.name,
    });
    const space = new DataSpace(workspace.db, {
        dir,
        ...dataSpaceStorage(dir),
        secret,
        approvals,
        workspace,
        limits,
    });
    cleanup.push(() => {
        space.close();
        workspace.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const dot = workspace.dots()[0];
    const other = workspace.createDot(dot.spaceId, 'Scout', 'Scouts.', false, false);
    // A person's own socio: its scratch is per user (CB-337 makes a company
    // socio's scratch its shared dataset instead).
    const personal = workspace.createDot(
        dot.spaceId,
        'Alice’s helper',
        'Helps.',
        false,
        false,
        [dot.spaceId],
        null,
        false,
        null,
        false,
        'alice',
    );
    const as = (userId: string, dotId = dot.id) => ({
        kind: 'dot' as const,
        userId,
        dotId,
    });
    const done = (result: Awaited<ReturnType<DataSpace['write']>>) => {
        expect(result.status).toBe('done');
        return result;
    };
    return { dir, workspace, approvals, space, dot, other, personal, as, done };
}
const table = {
    table: 'items',
    columns: [{ name: 'k', type: 'TEXT' as const, primaryKey: true }, { name: 'v' }],
};

it('creates one scratch dataset per (user, Dot), lazily, in the user’s own directory', async () => {
    const f = fixture();
    const mine = (userId: string) => f.as(userId, f.personal.id);
    expect(f.space.scratch('alice', f.personal.id, false)).toBeUndefined();
    f.done(
        await f.space.write(mine('alice'), undefined, {
            op: 'create_table',
            input: table,
        }),
    );
    // The same Dot acting for Bob gets its own scratch dataset, never Alice's.
    f.done(
        await f.space.write(mine('bob'), undefined, {
            op: 'create_table',
            input: table,
        }),
    );
    await f.space.write(mine('alice'), undefined, {
        op: 'insert',
        table: 'items',
        rows: [{ k: 'a', v: 'alice' }],
    });
    const alice = f.space.scratch('alice', f.personal.id)!;
    const bob = f.space.scratch('bob', f.personal.id)!;
    expect(alice.id).not.toBe(bob.id);
    expect(alice.name).toBe(`${f.personal.name} scratch`);
    expect(f.space.datasetPath(alice)).toBe(join(f.dir, 'alice', 'datasets', `${alice.id}.sqlite`));
    const bobs = await f.space.query(mine('bob'), undefined, 'SELECT count(*) FROM items');
    expect(bobs.rows).toEqual([[0]]);
    expect(f.space.list(mine('bob')).map((d) => d.id)).toEqual([bob.id]);
    // Another Dot of Alice's sees its own scratch, not this one.
    expect(f.space.list(f.as('alice', f.other.id)).map((d) => d.id)).not.toContain(alice.id);
});

it('resolves a company socio’s scratch to its shared dataset in chat as in its jobs (CB-337)', async () => {
    const f = fixture();
    // A job on the company socio Sebas, as `schedules/jobs.ts` scopes its token.
    const job: DataActor = {
        kind: 'token',
        purpose: 'job',
        userId: 'alice',
        dotId: f.dot.id,
        reach: 'socio',
        datasetIds: ['scratch'],
    };
    const chat = f.as('alice');
    f.done(await f.space.write(job, undefined, { op: 'create_table', input: table }));
    f.done(await f.space.write(job, 'scratch', { op: 'insert', table: 'items', rows: [{ k: 'a', v: 'job' }] }));
    const shared = f.space.scratch(sharedOwner(f.dot.id), f.dot.id, false)!;
    expect(f.space.datasetFor(job, 'scratch')?.id).toBe(shared.id);
    expect(f.space.datasetFor(chat, 'scratch')?.id).toBe(shared.id);
    // The chat reads what the job wrote, and the job what the chat writes.
    expect((await f.space.query(chat, undefined, 'SELECT v FROM items')).rows).toEqual([['job']]);
    f.done(await f.space.write(chat, undefined, { op: 'insert', table: 'items', rows: [{ k: 'b', v: 'chat' }] }));
    expect((await f.space.query(job, 'scratch', 'SELECT count(*) FROM items')).rows).toEqual([[2]]);
    expect(f.space.scratch('alice', f.dot.id, false)).toBeUndefined();
    // The shared area credits the chat's change to Alice, through the chat.
    const items = f.space.sharedAreas('alice').find((area) => area.dotId === f.dot.id)!.dataset!.tables[0]!;
    expect(items.created).toMatchObject({ via: 'computer' });
    expect(items.changed).toMatchObject({ by: 'Alice', via: 'chat' });
});

it('tells a chat once when its writes go to a company socio’s shared dataset (CB-337)', async () => {
    const f = fixture();
    const chat = { ...f.as('alice'), threadId: 't1' };
    const first = f.done(await f.space.write(chat, undefined, { op: 'create_table', input: table }));
    const shared = f.space.scratch(sharedOwner(f.dot.id), f.dot.id, false)!;
    expect(first).toMatchObject({
        notice: {
            kind: 'shared_dataset',
            text: expect.stringMatching(/shared dataset\. Admins and other people who use/),
            href: `/data/datasets/${shared.id}`,
        },
    });
    // Not on every row: the same chat's later writes say nothing.
    const later = f.done(await f.space.write(chat, undefined, { op: 'insert', table: 'items', rows: [{ k: 'a' }] }));
    expect(later).not.toHaveProperty('notice');
    // Another conversation is told once too.
    const other = await f.space.write({ ...chat, threadId: 't2' }, undefined, {
        op: 'insert',
        table: 'items',
        rows: [{ k: 'b' }],
    });
    expect(other).toHaveProperty('notice');
    // A job, and a personal socio's chat, get none.
    const job: DataActor = { kind: 'token', purpose: 'job', userId: 'alice', dotId: f.dot.id, reach: 'socio' };
    expect(
        await f.space.write(job, undefined, { op: 'insert', table: 'items', rows: [{ k: 'c' }] }),
    ).not.toHaveProperty('notice');
    const mine = { ...f.as('alice', f.personal.id), threadId: 't3' };
    expect(await f.space.write(mine, undefined, { op: 'create_table', input: table })).not.toHaveProperty('notice');
});

it('describes the scratch a company socio’s tools reach, not an older private one (CB-337)', async () => {
    const f = fixture();
    // Alice's private scratch for Sebas from before CB-337.
    const old = f.space.scratch('alice', f.dot.id)!;
    f.done(await f.space.write(f.as('alice'), undefined, { op: 'create_table', input: table }));
    const shared = f.space.scratch(sharedOwner(f.dot.id), f.dot.id, false)!;
    expect(shared.id).not.toBe(old.id);
    expect(f.space.summary('alice', f.dot.id).scratch).toMatchObject({ id: shared.id, tables: 1 });
    expect(f.space.summary('alice', f.personal.id).scratch).toBe('created on first use');
});

it('keeps a personal socio’s scratch the user’s own (CB-337)', async () => {
    const f = fixture();
    const chat = f.as('alice', f.personal.id);
    f.done(await f.space.write(chat, undefined, { op: 'create_table', input: table }));
    const own = f.space.scratch('alice', f.personal.id, false)!;
    expect(own.ownerUserId).toBe('alice');
    expect(f.space.datasetFor(chat, 'scratch')?.id).toBe(own.id);
    expect(f.space.scratch(sharedOwner(f.personal.id), f.personal.id, false)).toBeUndefined();
});

it('never shows a company socio’s shared scratch to a person without shared access (CB-337)', async () => {
    const f = fixture();
    // Alice (an operator) fills Sebas's shared dataset from a chat.
    f.done(await f.space.write(f.as('alice'), undefined, { op: 'create_table', input: table }));
    const shared = f.space.scratch(sharedOwner(f.dot.id), f.dot.id, false)!;
    // Bob, a member, has never used Sebas: no shared access.
    expect(f.space.canSeeShared('bob', f.dot.id)).toBe(false);
    const bob = f.as('bob');
    expect(f.space.visible(bob, false).map((item) => item.row.id)).not.toContain(shared.id);
    expect(f.space.datasetFor(bob, 'scratch')).toBeUndefined();
    expect(f.space.datasetFor(bob, shared.id)).toBeUndefined();
    expect(() => f.space.detailFor('bob', shared.id)).toThrow(/not found/);
    // A page view of it: for those who may see the shared area, no one else.
    expect(f.space.viewable('alice', shared.id, f.dot.spaceId)).toMatchObject({ socioShared: true });
    expect(() => f.space.viewable('bob', shared.id, f.dot.spaceId)).toThrow(VIEW_NO_ACCESS);
});

it('enforces grants: read, write, revocation, and other users’ datasets', async () => {
    const f = fixture();
    const shared = f.space.createDataset('alice', { name: 'Prices' });
    const scout = f.as('alice', f.other.id);
    await expect(f.space.query(scout, 'Prices', 'SELECT 1')).rejects.toThrow(/No dataset "Prices"/);
    const grant = f.space.setGrant('alice', {
        dotId: f.other.id,
        datasetId: shared.id,
        access: 'read',
    });
    expect((await f.space.query(scout, 'Prices', 'SELECT 1')).rows).toEqual([[1]]);
    await expect(f.space.write(scout, 'Prices', { op: 'create_table', input: table })).rejects.toThrow(/may only read/);
    f.space.setGrant('alice', {
        dotId: f.other.id,
        datasetId: shared.id,
        access: 'write',
    });
    f.done(await f.space.write(scout, shared.id, { op: 'create_table', input: table }));
    // Bob's turn with the same Dot never sees Alice's grant.
    await expect(f.space.query(f.as('bob', f.other.id), shared.id, 'SELECT 1')).rejects.toThrow(/No dataset/);
    // Bob can't grant Alice's dataset, nor read it in the app.
    expect(() =>
        f.space.setGrant('bob', {
            dotId: f.other.id,
            datasetId: shared.id,
            access: 'read',
        }),
    ).toThrow(/not found/);
    expect(() => f.space.detailFor('bob', shared.id)).toThrow(/not found/);
    await f.space.revokeGrant('alice', grant.id);
    await expect(f.space.query(scout, 'Prices', 'SELECT 1')).rejects.toThrow(/No dataset/);
    const audit = f.space.auditFor('alice');
    expect(audit.some((entry) => entry.action === 'access' && entry.outcome === 'denied')).toBe(true);
    expect(audit.some((entry) => entry.action === 'grant')).toBe(true);
    expect(audit.some((entry) => entry.action === 'revoke')).toBe(true);
    expect(f.space.auditFor('bob').some((entry) => entry.datasetId === shared.id)).toBe(false);
});

it('lets Space-shared datasets be read in the app by others, and writes to them need approval', async () => {
    const f = fixture();
    const shared = f.space.createDataset('alice', { name: 'Team list' });
    f.space.setGrant('alice', {
        dotId: f.dot.id,
        datasetId: shared.id,
        access: 'write',
    });
    f.space.updateDataset('alice', shared.id, { sharedSpaceId: f.dot.spaceId });
    expect(f.space.datasetsFor('bob').find((d) => d.id === shared.id)?.access).toBe('read');
    const pending = await f.space.write(f.as('alice'), shared.id, {
        op: 'create_table',
        input: table,
    });
    expect(pending.status).toBe('pending_approval');
    expect(f.space.detailFor('alice', shared.id).tables).toEqual([]);
    if (pending.status !== 'pending_approval') {
        throw new Error('expected pending');
    }
    // Only Alice decides her requests.
    await expect(f.approvals.decide(pending.approval.id, 'bob', true)).rejects.toThrow(/not found/);
    const decided = await f.approvals.decide(pending.approval.id, 'alice', true);
    expect(decided.status).toBe('approved');
    expect(decided.outcome).toMatch(/create table items/);
    expect(f.space.detailFor('bob', shared.id).tables.map((t) => t.name)).toEqual(['items']);
    // Bypass: the next write runs at once, and the audit says so.
    await f.approvals.setPolicy('alice', f.dot.id, 'data.write_shared', 'bypass');
    const bypassed = await f.space.write(f.as('alice'), shared.id, {
        op: 'insert',
        table: 'items',
        rows: [{ k: 'a' }],
    });
    expect(bypassed.status).toBe('done');
    const events = (await f.approvals.auditFor('alice')).map((entry) => entry.event);
    expect(events).toEqual(expect.arrayContaining(['requested', 'approved', 'executed', 'policy_changed', 'bypassed']));
});

it('creates datasets and changes grants for a Dot only through approvals', async () => {
    const f = fixture();
    const actor = { ...f.as('alice'), threadId: 't1' };
    const request = await f.space.requestDataset(actor, {
        name: 'Marketplace',
        description: 'Listings over time',
    });
    expect(request.status).toBe('pending_approval');
    expect(f.space.datasetsFor('alice').some((d) => d.name === 'Marketplace')).toBe(false);
    if (request.status !== 'pending_approval') {
        throw new Error('expected pending');
    }
    expect((await f.approvals.decide(request.id, 'alice', false)).status).toBe('denied');
    await expect(f.approvals.decide(request.id, 'alice', true)).rejects.toThrow(/already decided/);
    expect(f.space.datasetsFor('alice').some((d) => d.name === 'Marketplace')).toBe(false);
    await f.approvals.setPolicy('alice', f.dot.id, 'data.create_dataset', 'bypass');
    const bypass = await f.space.requestDataset(actor, {
        name: 'Marketplace',
        description: '',
    });
    expect(bypass.status).toBe('approved');
    // The Dot can write to the dataset it created.
    f.done(
        await f.space.write(actor, 'Marketplace', {
            op: 'create_table',
            input: table,
        }),
    );
    // Access to an existing dataset: grant.change, manual by default.
    const notes = f.space.createDataset('alice', { name: 'Notes' });
    const access = await f.space.requestAccess(actor, {
        dataset: 'notes',
        access: 'read',
        reason: 'To summarise them',
    });
    expect(access.status).toBe('pending_approval');
    if (access.status !== 'pending_approval') {
        throw new Error('expected pending');
    }
    await f.approvals.decide(access.id, 'alice', true);
    expect(f.space.grants('alice').some((g) => g.datasetId === notes.id && g.access === 'read')).toBe(true);
    await expect(
        f.space.requestAccess(f.as('bob'), {
            dataset: 'Notes',
            access: 'read',
            reason: 'x',
        }),
    ).rejects.toThrow(/no dataset/);
});

it('keeps a deleted Dot’s scratch datasets with each user and removes its grants', async () => {
    const f = fixture();
    const scout = f.as('alice', f.personal.id);
    f.done(await f.space.write(scout, undefined, { op: 'create_table', input: table }));
    f.done(
        await f.space.write(f.as('bob', f.personal.id), undefined, {
            op: 'create_table',
            input: table,
        }),
    );
    const shared = f.space.createDataset('alice', { name: 'Shared' });
    f.space.setGrant('alice', {
        dotId: f.personal.id,
        datasetId: shared.id,
        access: 'read',
    });
    const token = f.space.tokens.forCommand('alice', f.personal.id, 60_000, 'person').token;
    f.workspace.db.prepare('DELETE FROM dot_spaces WHERE dotId=?').run(f.personal.id);
    f.workspace.db.prepare('DELETE FROM dots WHERE id=?').run(f.personal.id);
    expect(f.space.reconcileDots()).toBe(1);
    for (const user of ['alice', 'bob']) {
        const scratch = f.space.datasetsFor(user).find((d) => d.scratchForDotId === f.personal.id)!;
        expect(scratch.fromDeletedDot).toBe(true);
        expect(f.space.detailFor(user, scratch.id).tables).toHaveLength(1);
    }
    expect(f.space.grants('alice')).toEqual([]);
    expect(f.space.tokens.resolve(token)).toBeUndefined();
    // The user deletes it when they choose to.
    const scratch = f.space.datasetsFor('alice').find((d) => d.scratchForDotId === f.personal.id)!;
    f.space.deleteDataset('alice', scratch.id);
    expect(f.space.datasetsFor('alice').some((d) => d.id === scratch.id)).toBe(false);
});

it('moves folder grants with their folder, merging into one already there, and ends them with it (CB-65)', async () => {
    const f = fixture();
    const grant = (dotId: string, folder: string, access: 'read' | 'write') =>
        f.space.setGrant('alice', { dotId, folder, access });
    grant(f.dot.id, 'a/b/', 'write');
    grant(f.dot.id, 'a/b/b/x/', 'read');
    grant(f.other.id, 'a/b/b/x/', 'read');
    grant(f.other.id, 'a/x/', 'write');
    grant(f.dot.id, 'a/', 'read');
    grant(f.dot.id, 'a/bc/', 'read');
    f.space.setGrant('bob', { dotId: f.dot.id, folder: 'a/b/', access: 'read' });
    const folders = (userId = 'alice') =>
        f.space
            .grants(userId)
            .map((g) => `${g.dotId === f.dot.id ? 'dot' : 'other'} ${g.folder} ${g.access}`)
            .sort();

    // a/b/ becomes a/: a/b/b/x/ lands on a/b/x/, which another grant just left.
    // The Dot's write on a/b/ merges into its read on a/, which stays read: a
    // move never widens access to files already in a/ (or a/bc/).
    expect(await f.space.moveFolderGrants('alice', 'a/b/', 'a/')).toBe(3);
    expect(folders()).toEqual([
        'dot a/ read',
        'dot a/b/x/ read',
        'dot a/bc/ read',
        'other a/b/x/ read',
        'other a/x/ write',
    ]);
    // Another user's grants don't move.
    expect(folders('bob')).toEqual(['dot a/b/ read']);
    const audit = f.space.auditFor('alice').filter((e) => e.action === 'grant_move');
    expect(audit.map((e) => [e.target, e.detail]).sort()).toEqual([
        ['a/', 'Sebas: write, from a/b/; merged into its read grant there'],
        ['a/b/x/', 'Scout: read, from a/b/b/x/'],
        ['a/b/x/', 'Sebas: read, from a/b/b/x/'],
    ]);

    // Deleting a/b/ ends what is on it and under it, not a/ or a/bc/.
    expect(await f.space.endFolderGrants('alice', 'a/b/')).toBe(2);
    expect(folders()).toEqual(['dot a/ read', 'dot a/bc/ read', 'other a/x/ write']);
    expect(
        f.space
            .auditFor('alice')
            .filter((e) => e.detail?.endsWith('the folder was deleted'))
            .map((e) => [e.action, e.target, e.detail])
            .sort(),
    ).toEqual([
        ['revoke', 'a/b/x/', 'Scout: read; the folder was deleted'],
        ['revoke', 'a/b/x/', 'Sebas: read; the folder was deleted'],
    ]);
    expect(await f.space.moveFolderGrants('alice', 'nothing/', 'here/')).toBe(0);
});

it('moves and ends only the folder named, not one that shares its prefix (CB-65)', async () => {
    const f = fixture();
    for (const folder of ['a/', 'ab/', 'a b/', 'a/c/']) {
        f.space.setGrant('alice', { dotId: f.dot.id, folder, access: 'read' });
    }
    const folders = () =>
        f.space
            .grants('alice')
            .map((g) => g.folder)
            .sort();
    // Without the slash, both would be "a" and "ab".
    expect(await f.space.moveFolderGrants('alice', 'a', 'z')).toBe(2);
    expect(folders()).toEqual(['a b/', 'ab/', 'z/', 'z/c/']);
    expect(await f.space.endFolderGrants('alice', 'z')).toBe(2);
    expect(await f.space.endFolderGrants('alice', 'a')).toBe(0);
    expect(folders()).toEqual(['a b/', 'ab/']);
});

it('encrypts files at rest, scoped to the Dot’s folder and granted folders', async () => {
    const f = fixture();
    const secret = 'TOP-SECRET-PLAINTEXT-4815162342';
    const saved = await f.space.putFile(f.as('alice'), 'report.md', Buffer.from(`# ${secret}`), 'text/markdown');
    expect(saved.path).toBe(`dots/${f.dot.id}/report.md`);
    const onDisk = readdirSync(join(f.dir, 'alice', 'files'));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]).not.toContain('report');
    const raw = readFileSync(join(f.dir, 'alice', 'files', onDisk[0]));
    expect(raw.toString('latin1')).not.toContain(secret);
    expect(raw.toString('latin1')).not.toContain('report');
    expect(statSync(join(f.dir, 'alice', 'files', onDisk[0])).mode & 0o077).toBe(0);
    expect((await f.space.getFile(f.as('alice'), 'report.md')).data.toString()).toBe(`# ${secret}`);
    // Another Dot, or the same Dot for Bob, can't read it.
    await expect(f.space.getFile(f.as('alice', f.other.id), `dots/${f.dot.id}/report.md`)).rejects.toThrow(
        /may not read/,
    );
    await expect(f.space.getFile(f.as('bob'), 'report.md')).rejects.toThrow(/No file/);
    await expect(f.space.putFile(f.as('alice'), 'shared/x.txt', Buffer.from('x'))).resolves.toMatchObject({
        path: `dots/${f.dot.id}/shared/x.txt`,
    });
    await expect(f.space.putFile(f.as('alice'), '../escape', Buffer.from('x'))).rejects.toThrow(/relative path/);
    f.space.setGrant('alice', {
        dotId: f.other.id,
        folder: 'reports',
        access: 'read',
    });
    await f.space.putFile({ kind: 'user', userId: 'alice' }, 'reports/q3.csv', Buffer.from('a,b'));
    expect((await f.space.getFile(f.as('alice', f.other.id), 'reports/q3.csv')).data.toString()).toBe('a,b');
    await expect(f.space.putFile(f.as('alice', f.other.id), 'reports/q4.csv', Buffer.from('x'))).rejects.toThrow(
        /may not write/,
    );
    expect(f.space.listFiles(f.as('alice', f.other.id)).map((file) => file.path)).toEqual(['reports/q3.csv']);
    // Under another SESSION_SECRET the files can't be opened.
    const other = new DataSpace(f.workspace.db, {
        dir: f.dir,
        ...dataSpaceStorage(f.dir),
        secret: 'another-secret-0123456789abcdef',
        approvals: sqliteApprovals(f.workspace.db),
        workspace: f.workspace,
    });
    cleanup.push(() => other.close());
    await expect(other.getFile({ kind: 'user', userId: 'alice' }, `dots/${f.dot.id}/report.md`)).rejects.toThrow();
});

it('enforces quotas, the per-minute rate and retention', async () => {
    const f = fixture({
        statementsPerMinute: 5,
        maxDatasets: 2,
        userMaxBytes: 230_000,
        fileMaxBytes: 50_000,
    });
    const actor = f.as('alice');
    f.space.list(actor);
    f.space.list(actor);
    f.space.list(actor);
    f.space.list(actor);
    f.space.list(actor);
    expect(() => f.space.list(actor)).toThrow(/at most 5 a minute/);
    expect(() => f.space.list(f.as('bob'))).not.toThrow();
    f.space.createDataset('alice', { name: 'One' });
    f.space.createDataset('alice', { name: 'Two' });
    // Scratch datasets don't count; Alice has hers from list().
    expect(() => f.space.createDataset('alice', { name: 'Three' })).toThrow(/most datasets/);
    await expect(f.space.putFile({ kind: 'user', userId: 'bob' }, 'big.bin', Buffer.alloc(60_000))).rejects.toThrow(
        /at most/,
    );
    await f.space.putFile({ kind: 'user', userId: 'bob' }, 'a.bin', Buffer.alloc(49_000));
    await f.space.putFile({ kind: 'user', userId: 'bob' }, 'b.bin', Buffer.alloc(49_000));
    await f.space.putFile({ kind: 'user', userId: 'bob' }, 'c.bin', Buffer.alloc(49_000));
    await f.space.putFile({ kind: 'user', userId: 'bob' }, 'd.bin', Buffer.alloc(49_000));
    await expect(f.space.putFile({ kind: 'user', userId: 'bob' }, 'e.bin', Buffer.alloc(49_000))).rejects.toThrow(
        /full/,
    );
    const kept = f.space.createDataset('bob', { name: 'Kept' });
    const old = f.space.createDataset('bob', { name: 'Old' });
    f.space.updateDataset('bob', old.id, { retentionDays: 7 });
    expect(f.space.applyRetention(Date.now() + 8 * 86_400_000)).toBe(1);
    expect(
        f.space
            .datasetsFor('bob')
            .filter((d) => d.kind === 'dataset')
            .map((d) => d.id),
    ).toEqual([kept.id]);
    expect(f.space.auditFor('bob').some((entry) => entry.action === 'retention_delete')).toBe(true);
});

it('issues scoped tokens that expire, narrow grants and end with their command', async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    const tokens = new DataTokens(1000);
    // Every command gets its own token (CB-224), for its run at most.
    const first = tokens.forCommand('alice', 'dot-1', 60_000, 'person');
    const again = tokens.forCommand('alice', 'dot-1', 500, 'person');
    expect(again.token).not.toBe(first.token);
    expect(again.session).not.toBe(first.session);
    expect(tokens.resolve(first.token)).toMatchObject({
        userId: 'alice',
        dotId: 'dot-1',
        purpose: 'computer',
    });
    vi.setSystemTime(Date.now() + 600);
    expect(tokens.resolve(again.token)).toBeUndefined();
    expect(tokens.resolve(first.token)).toBeDefined();
    // `ttlMs` caps a long command's token.
    vi.setSystemTime(Date.now() + 900);
    expect(tokens.resolve(first.token)).toBeUndefined();
    const second = tokens.forCommand('alice', 'dot-1', 60_000, 'person').token;
    const third = tokens.forCommand('bob', 'dot-1', 60_000, 'person');
    expect(tokens.resolve(third.token)?.reach).toBeUndefined();
    // A company socio's command: the scope says so (CB-224).
    const shared = tokens.forCommand('carol', 'dot-1', 60_000, 'socio');
    expect(tokens.resolve(shared.token)?.reach).toBe('socio');
    // Live command tokens, by value, for redaction; a revoked one drops out.
    expect(tokens.commandTokens('dot-1').sort()).toEqual([second, third.token, shared.token].sort());
    expect(tokens.commandTokens('dot-2')).toEqual([]);
    tokens.revokeSession(third.session);
    expect(tokens.resolve(third.token)).toBeUndefined();
    expect(tokens.commandTokens('dot-1')).not.toContain(third.token);
    expect(tokens.resolve(second)).toBeDefined();
    const job = tokens.issue({
        userId: 'alice',
        dotId: 'dot-1',
        purpose: 'job',
        session: 'job:1',
        datasetIds: ['x'],
    });
    tokens.revokeDot('dot-1', ['computer']);
    expect(tokens.resolve(second)).toBeUndefined();
    expect(tokens.resolve(job)).toBeDefined();
    tokens.revokeSession('job:1');
    expect(tokens.resolve(job)).toBeUndefined();
    expect(tokens.resolve('cbdt_forged')).toBeUndefined();
    vi.useRealTimers();
    // A narrowed token sees only its datasets.
    const f = fixture();
    const one = f.space.createDataset('alice', { name: 'One' });
    const two = f.space.createDataset('alice', { name: 'Two' });
    for (const id of [one.id, two.id]) {
        f.space.setGrant('alice', {
            dotId: f.dot.id,
            datasetId: id,
            access: 'read',
        });
    }
    const narrowed: DataActor = {
        kind: 'token',
        userId: 'alice',
        dotId: f.dot.id,
        datasetIds: [one.id],
    };
    expect(f.space.list(narrowed).map((d) => d.id)).toEqual([one.id]);
    await expect(f.space.query(narrowed, two.id, 'SELECT 1')).rejects.toThrow(/No dataset/);
});

it('backs up every dataset and the still-encrypted files', async () => {
    const f = fixture();
    f.done(
        await f.space.write(f.as('alice', f.personal.id), undefined, {
            op: 'create_table',
            input: table,
        }),
    );
    await f.space.write(f.as('alice', f.personal.id), undefined, {
        op: 'insert',
        table: 'items',
        rows: [{ k: 'a', v: 'kept' }],
    });
    await f.space.putFile(f.as('bob'), 'note.txt', Buffer.from('PLAINTEXT-NOTE'));
    const backups = mkdtempSync(join(tmpdir(), 'cb-data-backup-'));
    cleanup.push(() => rmSync(backups, { recursive: true, force: true }));
    const result = await backupUserData(f.dir, backups, 2);
    expect(result).toMatchObject({ datasets: 1, files: 1 });
    const scratch = f.space.scratch('alice', f.personal.id)!;
    const copy = join(result.path, 'alice', 'datasets', `${scratch.id}.sqlite`);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(copy, { readOnly: true });
    expect(db.prepare('SELECT v FROM items').all()).toEqual([{ v: 'kept' }]);
    db.close();
    const files = readdirSync(join(result.path, 'bob', 'files'));
    expect(readFileSync(join(result.path, 'bob', 'files', files[0])).toString('latin1')).not.toContain(
        'PLAINTEXT-NOTE',
    );
    await backupUserData(f.dir, backups, 2, new Date(Date.now() + 1000));
    await backupUserData(f.dir, backups, 2, new Date(Date.now() + 2000));
    expect(readdirSync(backups).filter((name) => name.startsWith('userdata-'))).toHaveLength(2);
});

/** The fixture's data space, opened again with its files in a fake S3. */
async function overS3(f: ReturnType<typeof fixture>, fake?: FakeS3, secret = 'secret-0123456789abcdef-xyz') {
    const s3 = fake ?? (await startFakeS3());
    if (!fake) {
        cleanup.push(() => s3.close());
    }
    const space = new DataSpace(f.workspace.db, {
        dir: f.dir,
        ...dataSpaceStorage(f.dir),
        secret,
        approvals: sqliteApprovals(f.workspace.db),
        workspace: f.workspace,
        objects: new S3ObjectStore(s3.settings(), { backoffMs: 1 }),
        tenantId: 'acme',
    });
    cleanup.push(() => space.close());
    expect(await space.probeStorage()).toBe(true);
    return { s3, space };
}
const storageOf = (f: ReturnType<typeof fixture>) =>
    f.workspace.db.prepare('SELECT path, storage FROM data_files ORDER BY path').all() as Array<{
        path: string;
        storage: string;
    }>;
const alice = { kind: 'user' as const, userId: 'alice' };

it('keeps files sealed in S3 under opaque keys, by tenant and user', async () => {
    const f = fixture();
    const { s3, space } = await overS3(f);
    const secret = 'S3-PLAINTEXT-SECRET-2718281828';
    const saved = await space.putFile(
        alice,
        'reports/quarterly-report.md',
        Buffer.from(`# ${secret}`),
        'text/markdown',
        { name: 'Quarterly report.md' },
    );
    expect(saved.path).toBe('reports/quarterly-report.md');
    expect(space.storageStatus()).toBe('s3');
    // Nothing on the local disk; in S3 only sealed bytes under an id.
    expect(existsSync(join(f.dir, 'alice', 'files'))).toBe(false);
    expect([...s3.objects.keys()]).toEqual([
        expect.stringMatching(/^company-brain\/tenants\/acme\/users\/alice\/files\/[0-9a-f-]{36}$/),
    ]);
    for (const request of s3.requests) {
        const seen = `${request.path} ${JSON.stringify(request.query)} ${JSON.stringify(request.headers)} ${request.body.toString('latin1')}`;
        expect(seen).not.toContain(secret);
        expect(seen.toLowerCase()).not.toContain('quarterly');
    }
    expect(storageOf(f)).toEqual([
        {
            path: 'reports/quarterly-report.md',
            storage: 's3',
        },
    ]);
    expect((await space.getFile(alice, 'reports/quarterly-report.md')).data.toString()).toBe(`# ${secret}`);
    // By id; moved (metadata only: the same object); copied (a new one).
    const { id } = f.workspace.db.prepare('SELECT id FROM data_files').get() as {
        id: string;
    };
    expect((await space.getFileById(alice, id)).file.path).toBe('reports/quarterly-report.md');
    await expect(space.getFileById({ kind: 'user', userId: 'bob' }, id)).rejects.toThrow('No such file.');
    const puts = () => s3.requests.filter((request) => request.method === 'PUT').length;
    const before = puts();
    await space.moveFile('alice', 'reports/quarterly-report.md', 'archive/q3.md');
    expect(puts()).toBe(before);
    await space.putFile(alice, 'other.md', Buffer.from('other'));
    await expect(space.moveFile('alice', 'archive/q3.md', 'other.md')).rejects.toThrow(
        'There is a file at other.md already.',
    );
    const copy = await space.copyFile(alice, 'archive/q3.md', 'copies/q3.md');
    expect(copy.mediaType).toBe('text/markdown');
    expect((await space.getFile(alice, 'copies/q3.md')).data.toString()).toBe(`# ${secret}`);
    expect(s3.objects.size).toBe(3);
    // Another SESSION_SECRET can't open what S3 holds.
    const { space: wrong } = await overS3(f, s3, 'another-secret-0123456789abcdef');
    await expect(wrong.getFile(alice, 'archive/q3.md')).rejects.toThrow();
    // CB-64: a deleted file is hidden, and its sealed object is kept.
    await space.deleteFile('alice', 'archive/q3.md');
    expect(s3.objects.size).toBe(3);
    expect(space.listFiles(alice).map((file) => file.path)).toEqual(['copies/q3.md', 'other.md']);
    expect((await space.withDeletedContent(id)).toString()).toBe(`# ${secret}`);
});

it('routes a copy to shared/ to a company socio’s shared area, and tells a personal socio it has none (CB-268)', async () => {
    const f = fixture();
    // The default socio Sebas is a company socio (no owner): shared/ routes
    // to its shared computer folder (CB-224).
    await f.space.putFile({ kind: 'user', userId: 'alice' }, `dots/${f.dot.id}/scan.pdf`, Buffer.from('pdf'));
    const companyCopy = await f.space.copyFile(f.as('alice'), 'scan.pdf', 'shared/scan.pdf');
    expect(companyCopy.path).toBe(`dots/${f.dot.id}/scan.pdf`);
    // The shared copy lands in the socio's shared area; the original stays.
    expect(f.space.fileAt(sharedOwner(f.dot.id), `dots/${f.dot.id}/scan.pdf`)).toBeDefined();
    expect(f.space.fileAt('alice', `dots/${f.dot.id}/scan.pdf`)).toBeDefined();
    // A personal socio (owner set) has no shared folder: shared/ is not a
    // special destination for it. Say so clearly instead of silently writing
    // a literal shared/ subfolder into its own folder (CB-268).
    const own = f.workspace.createDot(
        f.dot.spaceId,
        'Alice’s helper',
        '',
        false,
        false,
        [f.dot.spaceId],
        null,
        false,
        null,
        false,
        'alice',
    );
    await f.space.putFile({ kind: 'user', userId: 'alice' }, `dots/${own.id}/scan.pdf`, Buffer.from('pdf'));
    await expect(f.space.copyFile(f.as('alice', own.id), 'scan.pdf', 'shared/scan.pdf')).rejects.toThrow(
        /company socio's shared computer folder/,
    );
    // A plain copy still works for the personal socio: its computer reaches
    // its own folder.
    const plain = await f.space.copyFile(f.as('alice', own.id), 'scan.pdf', 'erden-main.zip');
    expect(plain.path).toBe(`dots/${own.id}/erden-main.zip`);
});

it('serializes one user’s writes, so racing writes to a new path don’t collide', async () => {
    const f = fixture();
    const { space } = await overS3(f);
    const written = await Promise.all(
        ['one', 'two', 'three'].map((text) => space.putFile(alice, 'same.txt', Buffer.from(text))),
    );
    expect(written.map((file) => file.path)).toEqual(['same.txt', 'same.txt', 'same.txt']);
    expect((await space.getFile(alice, 'same.txt')).data.toString()).toBe('three');
    expect(space.listFiles(alice)).toHaveLength(1);
});

it('answers 503 while S3 is down, says so in setup, and recovers', async () => {
    const f = fixture();
    const { s3, space } = await overS3(f);
    await space.putFile(alice, 'kept.txt', Buffer.from('kept'));
    s3.failNext(3, 503);
    await expect(space.putFile(alice, 'new.txt', Buffer.from('new'))).rejects.toMatchObject({
        message: 'File storage is unavailable; try again.',
        status: 503,
    });
    // Nothing half-written: no row without its object.
    expect(space.listFiles(alice).map((file) => file.path)).toEqual(['kept.txt']);
    expect(space.storageStatus()).toBe('s3_unreachable');
    s3.dropNext(3);
    await expect(space.getFile(alice, 'kept.txt')).rejects.toMatchObject({
        status: 503,
    });
    expect(space.listFiles(alice).map((file) => file.path)).toEqual(['kept.txt']);
    expect((await space.getFile(alice, 'kept.txt')).data.toString()).toBe('kept');
    expect(space.storageStatus()).toBe('s3');
});

it('moves local files into S3 once, idempotently, surviving a crash midway', async () => {
    const f = fixture();
    for (const name of ['a', 'b', 'c']) {
        await f.space.putFile(alice, `notes/${name}.txt`, Buffer.from(`note ${name}`));
    }
    await f.space.putFile({ kind: 'user', userId: 'bob' }, 'bob.txt', Buffer.from('bob'));
    expect(storageOf(f).map((row) => row.storage)).toEqual(['local', 'local', 'local', 'local']);
    const { s3, space } = await overS3(f);
    expect(space.pendingLocalFiles()).toBe(4);
    expect(space.migrationDue()).toBe(true);
    // Rows still on the local disk read from there meanwhile.
    expect((await space.getFile(alice, 'notes/a.txt')).data.toString()).toBe('note a');
    // A crash between the PUT and the row's update: the check's HEAD fails.
    s3.failNext(3, 500, 'HEAD');
    const crashed = await space.migrateToObjectStore();
    expect(crashed).toMatchObject({ moved: 0, unavailable: true });
    expect(s3.objects.size).toBe(1);
    expect(space.pendingLocalFiles()).toBe(4);
    s3.requests.length = 0;
    expect(await space.migrateToObjectStore()).toEqual({
        moved: 4,
        missing: 0,
        mismatched: 0,
        cleaned: 0,
        unavailable: false,
    });
    expect(space.pendingLocalFiles()).toBe(0);
    // Swept on this run too: the hourly tick has nothing left to do.
    expect(space.migrationDue()).toBe(false);
    expect(storageOf(f).map((row) => row.storage)).toEqual(['s3', 's3', 's3', 's3']);
    // The local files are gone; every file reads the same from S3.
    expect(readdirSync(join(f.dir, 'alice', 'files'))).toEqual([]);
    expect(readdirSync(join(f.dir, 'bob', 'files'))).toEqual([]);
    for (const name of ['a', 'b', 'c']) {
        expect((await space.getFile(alice, `notes/${name}.txt`)).data.toString()).toBe(`note ${name}`);
    }
    expect((await space.getFile({ kind: 'user', userId: 'bob' }, 'bob.txt')).data.toString()).toBe('bob');
    expect(s3.allBytes().toString('latin1')).not.toContain('note');
    // Again: nothing to do, no PUTs.
    s3.requests.length = 0;
    expect(await space.migrateToObjectStore()).toMatchObject({ moved: 0 });
    expect(s3.requests.filter((request) => request.method === 'PUT')).toEqual([]);
});

it('sweeps local copies left by a crash after the update, and leaves rows without a local file', async () => {
    const f = fixture();
    await f.space.putFile(alice, 'kept.txt', Buffer.from('kept'));
    await f.space.putFile(alice, 'lost.txt', Buffer.from('lost'));
    const files = join(f.dir, 'alice', 'files');
    const rows = f.workspace.db.prepare('SELECT id, path FROM data_files ORDER BY path').all() as Array<{
        id: string;
        path: string;
    }>;
    const kept = readFileSync(join(files, `${rows[0].id}.bin`));
    rmSync(join(files, `${rows[1].id}.bin`));
    const first = await overS3(f);
    expect(await first.space.migrateToObjectStore()).toMatchObject({
        moved: 1,
        missing: 1,
    });
    expect(storageOf(f).map((row) => [row.path, row.storage])).toEqual([
        ['kept.txt', 's3'],
        ['lost.txt', 'local'],
    ]);
    // As if the process died after marking the row, before the delete.
    writeFileSync(join(files, `${rows[0].id}.bin`), kept);
    const next = await overS3(f, first.s3);
    expect(await next.space.migrateToObjectStore()).toMatchObject({
        moved: 0,
        missing: 1,
        cleaned: 1,
    });
    expect(readdirSync(files)).toEqual([]);
    expect((await next.space.getFile(alice, 'kept.txt')).data.toString()).toBe('kept');
    await expect(next.space.getFile(alice, 'lost.txt')).rejects.toThrow('The contents of lost.txt are missing.');
});

it('keeps a deleted file’s object, and drops a stray copy the move left in the other store', async () => {
    const f = fixture();
    await f.space.putFile(alice, 'gone.txt', Buffer.from('gone'));
    const files = join(f.dir, 'alice', 'files');
    const [{ id }] = f.workspace.db.prepare('SELECT id FROM data_files').all() as Array<{ id: string }>;
    const sealed = readFileSync(join(files, `${id}.bin`));
    const { s3, space } = await overS3(f);
    expect(await space.migrateToObjectStore()).toMatchObject({ moved: 1 });
    // As if the process died after marking the row, before the delete.
    writeFileSync(join(files, `${id}.bin`), sealed);
    await space.deleteFile('alice', 'gone.txt');
    expect(readdirSync(files)).toEqual([]);
    expect(s3.objects.size).toBe(1);
    expect((await space.withDeletedContent(id)).toString()).toBe('gone');
});

it('mirrors the tenant’s S3 objects into the data space backup, still sealed', async () => {
    const f = fixture();
    const { s3, space } = await overS3(f);
    await space.putFile(alice, 'secret.txt', Buffer.from('BACKUP-PLAINTEXT'));
    // Another tenant's object in the same bucket stays out of it.
    s3.objects.set('company-brain/tenants/other/users/x/files/y', Buffer.from('z'));
    const backups = mkdtempSync(join(tmpdir(), 'cb-data-backup-'));
    cleanup.push(() => rmSync(backups, { recursive: true, force: true }));
    const data = await backupUserData(f.dir, backups, 2);
    const result = await mirrorObjects(
        space.objects,
        'tenants/acme/',
        join(backups, 'objects'),
        join(backups, 'objects.json'),
    );
    expect(result).toMatchObject({ objects: 1, fetched: 1 });
    snapshotObjects(join(backups, 'objects'), data.path);
    const dir = join(data.path, 'objects', 'tenants', 'acme', 'users', 'alice', 'files');
    const [file] = readdirSync(dir);
    expect(readFileSync(join(dir, file)).toString('latin1')).not.toContain('BACKUP-PLAINTEXT');
    expect(existsSync(join(data.path, 'objects', 'tenants', 'other'))).toBe(false);
    expect(existsSync(join(data.path, 'objects.partial'))).toBe(false);
});

it('says a file is out of reach when S3 is no longer configured, and won’t replace it then', async () => {
    const f = fixture();
    const { space } = await overS3(f);
    await space.putFile(alice, 'in-s3.txt', Buffer.from('remote'));
    const outOfReach = {
        message: 'This file is in object storage, which isn’t configured here (S3_ENDPOINT).',
        status: 503,
    };
    await expect(f.space.getFile(alice, 'in-s3.txt')).rejects.toMatchObject(outOfReach);
    // An overwrite keeps the previous bytes, which it can't read
    // here; replacing the file would lose them.
    await expect(f.space.putFile(alice, 'in-s3.txt', Buffer.from('local again'))).rejects.toMatchObject(outOfReach);
    expect(storageOf(f).map((row) => row.storage)).toEqual(['s3']);
    // With S3 back, the overwrite keeps the remote bytes as a version.
    await space.putFile(alice, 'in-s3.txt', Buffer.from('remote again'));
    const live = f.space.fileRecords('alice')[0];
    const [version] = space.withDeletedVersions(live.id);
    expect((await space.withDeletedContent(version.id)).toString()).toBe('remote');
    await f.space.deleteFile('alice', 'in-s3.txt');
    await f.space.putFile(alice, 'in-s3.txt', Buffer.from('local again'));
    expect((await f.space.getFile(alice, 'in-s3.txt')).data.toString()).toBe('local again');
    // CB-64: deleting needs no store; the row is kept with its bytes.
    await space.putFile(alice, 'also-s3.txt', Buffer.from('remote'));
    await f.space.deleteFile('alice', 'also-s3.txt');
    expect(f.space.listFiles(alice).map((file) => file.path)).toEqual(['in-s3.txt']);
    // The deleted S3 file, its version, the deleted file and the new one.
    expect(
        storageOf(f)
            .map((row) => `${row.path} ${row.storage}`)
            .sort(),
    ).toEqual(['also-s3.txt s3', 'in-s3.txt local', 'in-s3.txt s3', 'in-s3.txt s3']);
});

it('keeps deleted datasets and files in backups, and moves deleted files into S3 too (CB-64)', async () => {
    const f = fixture();
    const dataset = f.space.createDataset('alice', { name: 'Old prices' });
    f.space.deleteDataset('alice', dataset.id);
    await f.space.putFile(alice, 'old.txt', Buffer.from('old notes'));
    const [{ id }] = f.workspace.db.prepare('SELECT id FROM data_files').all() as Array<{ id: string }>;
    await f.space.deleteFile('alice', 'old.txt');
    expect(f.space.listFiles(alice)).toEqual([]);
    const backups = mkdtempSync(join(tmpdir(), 'cb-data-backup-'));
    cleanup.push(() => rmSync(backups, { recursive: true, force: true }));
    expect(await backupUserData(f.dir, backups, 2)).toMatchObject({
        datasets: 1,
        files: 1,
    });
    // The move to S3 takes deleted files' objects too; they stay deleted.
    const { s3, space } = await overS3(f);
    expect(space.pendingLocalFiles()).toBe(1);
    expect(await space.migrateToObjectStore()).toMatchObject({ moved: 1 });
    expect(storageOf(f)).toEqual([{ path: 'old.txt', storage: 's3' }]);
    expect(space.listFiles(alice)).toEqual([]);
    expect((await space.withDeletedContent(id)).toString()).toBe('old notes');
    // The object mirror keeps deleted files' objects too.
    expect(
        await mirrorObjects(space.objects, 'tenants/acme/', join(backups, 'objects'), join(backups, 'objects.json')),
    ).toMatchObject({ objects: 1 });
    expect(s3.objects.size).toBe(1);
});

it('fails reads and writes of a registered dataset whose file is missing, and reports it (CB-340)', async () => {
    const f = fixture();
    const kept = f.space.createDataset('alice', { name: 'Kept' });
    const lost = f.space.createDataset('alice', { name: 'Lost' });
    // Creating a brand-new dataset still makes its file.
    const path = f.space.datasetPath({ id: lost.id, ownerUserId: 'alice' });
    expect(existsSync(path)).toBe(true);
    expect(f.space.missingDatasetFiles()).toEqual({ missing: 0, ids: [] });

    f.space.setGrant('alice', { dotId: f.other.id, datasetId: lost.id, access: 'write' });
    const scout = f.as('alice', f.other.id);
    f.done(await f.space.write(scout, lost.id, { op: 'create_table', input: table }));
    // The volume moved without it (CB-340).
    rmSync(path);
    await expect(f.space.write(scout, lost.id, { op: 'create_table', input: table })).rejects.toThrow(
        DatasetFileMissingError,
    );
    await expect(f.space.query(scout, lost.id, 'SELECT 1')).rejects.toThrow(DatasetFileMissingError);
    expect(() => f.space.detailFor('alice', lost.id)).toThrow(DatasetFileMissingError);
    // No empty file stands in for the lost one.
    expect(existsSync(path)).toBe(false);

    const report = f.space.missingDatasetFiles();
    expect(report).toMatchObject({ missing: 1, ids: [lost.id] });
    expect(report.warning).toMatch(/1 registered dataset file\(s\) missing/);
    expect(report.ids).not.toContain(kept.id);
    // `/healthz` gets it through the module's health hook.
    const module = makeDataModule(() => {
        throw new Error('unused');
    });
    const context = { services: { get: () => f.space } } as unknown as ModuleContext;
    expect(module.health?.(context)).toEqual({ datasetFiles: report });
});
