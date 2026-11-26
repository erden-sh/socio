import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { getTableName } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { sqliteData } from '@socio/data/open';

import type { NewPage } from '../../src/server/pages/domain/repositories.js';
import { sqlitePageRepositories } from '../../src/server/pages/infra/sqlite/index.js';
import { pageTables } from '../../src/server/pages/infra/sqlite/schema.js';
import { SqliteSearchStats } from '../../src/server/pages/infra/sqlite/search-stats.js';
import { WorkspaceStore } from '../helpers/stores.js';
import { testDatabase } from '../helpers/test-database.js';
import { PACKAGE_SOURCES } from '../support/package-sources.js';

/*
 * The pages repository contract (CB-110, wave 3): what any implementation
 * of `pages/domain/repositories.ts` must keep, run against the SQLite one;
 * the drift check of its Drizzle mirror; and the check that only the
 * repositories write the page tables.
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
    const data = sqliteData(db);
    return { db, uow: data.uow, repos: sqlitePageRepositories(data) };
}

const page = (fields: Partial<NewPage> = {}): NewPage => ({
    id: 'p1',
    spaceId: 's1',
    parentId: null,
    title: 'Notes',
    content: '# Notes',
    createdAt: 10,
    sourceThreadId: null,
    createdBy: 'alice',
    sourceUrl: null,
    sourceTitle: null,
    ...fields,
});

it('mirrors the migrated page tables exactly', () => {
    const { db } = context();
    expect(schemaDrift(db, pageTables)).toEqual([]);
});

it('reports a column the mirror does not know', () => {
    const { db } = context();
    db.exec('ALTER TABLE pages ADD COLUMN icon TEXT');
    expect(schemaDrift(db, pageTables)).toEqual([expect.stringContaining('icon')]);
});

it('adds, edits at a revision, moves and hides pages', async () => {
    const { db, repos } = context();
    const row = () => db.prepare("SELECT * FROM pages WHERE id='p1'").get();
    await repos.pages.insert(page());
    expect(row()).toMatchObject({
        revision: 1,
        createdAt: 10,
        updatedAt: 10,
        deletedAt: null,
    });
    const edit = { title: 'New', content: 'Body', parentId: null };
    await repos.pages.edit('p1', 1, edit, 20);
    expect(row()).toMatchObject({ ...edit, revision: 2, updatedAt: 20 });
    // At a revision it is no longer at: nothing.
    await repos.pages.edit('p1', 1, { ...edit, title: 'Stale' }, 30);
    expect(row()).toMatchObject({ title: 'New', revision: 2 });
    await repos.pages.move('p1', 's2', 'p0', 40);
    expect(row()).toMatchObject({
        spaceId: 's2',
        parentId: 'p0',
        revision: 3,
        updatedAt: 40,
    });
    await repos.pages.hide('p1', { at: 50, by: 'bob', with: 'page:p0' });
    expect(row()).toMatchObject({
        deletedAt: 50,
        deletedBy: 'bob',
        deletedWith: 'page:p0',
    });
    // A deleted page keeps its first stamp.
    await repos.pages.hide('p1', { at: 60, by: 'carol', with: null });
    expect(row()).toMatchObject({ deletedAt: 50, deletedBy: 'bob' });
    await expect(repos.pages.insert(page())).rejects.toThrow();
});

it('marks a page as a folder and back as its next revision, keeping its text (CB-426)', async () => {
    const { db, repos } = context();
    const row = () => db.prepare("SELECT folder, title, content, revision, updatedAt FROM pages WHERE id='p1'").get();
    await repos.pages.insert(page());
    expect(row()).toMatchObject({ folder: 0, revision: 1 });
    await repos.pages.folder('p1', true, 20);
    expect(row()).toEqual({ folder: 1, title: 'Notes', content: '# Notes', revision: 2, updatedAt: 20 });
    await repos.pages.folder('p1', false, 30);
    expect(row()).toEqual({ folder: 0, title: 'Notes', content: '# Notes', revision: 3, updatedAt: 30 });
    // Made as a folder.
    await repos.pages.insert(page({ id: 'p2', folder: true }));
    expect(db.prepare("SELECT folder FROM pages WHERE id='p2'").get()).toEqual({ folder: 1 });
});

it('keeps revisions and finds the latest by when it was replaced', async () => {
    const { db, repos } = context();
    expect(await repos.revisions.latest('p1')).toBeUndefined();
    const revision = {
        pageId: 'p1',
        spaceId: 's1',
        revision: 1,
        title: 'Notes',
        body: new Uint8Array([104, 105]),
        encoding: 'utf8' as const,
        authorId: 'alice',
        createdAt: 10,
        replacedAt: 20,
    };
    await repos.revisions.insert(revision);
    await repos.revisions.insert({ ...revision, authorId: 'bob' });
    await repos.revisions.insert({ ...revision, authorId: null, replacedAt: 15 });
    // The same time: the later one.
    expect(await repos.revisions.latest('p1')).toEqual({
        authorId: 'bob',
        replacedAt: 20,
    });
    const stored = db.prepare('SELECT body, encoding FROM page_revisions ORDER BY id LIMIT 1').get() as {
        body: Uint8Array;
        encoding: string;
    };
    expect([...stored.body]).toEqual([104, 105]);
    expect(stored.encoding).toBe('utf8');
});

it('keeps review receipts once per tool call, and moves them with the page', async () => {
    const { db, repos } = context();
    const receipt = {
        threadId: 't1',
        toolCallId: 'c1',
        pageId: 'p1',
        spaceId: 's1',
        draft: '{"title":"Notes"}',
    };
    await repos.reviews.insert(receipt);
    await repos.reviews.insert({ ...receipt, toolCallId: 'c2', pageId: 'p2' });
    await expect(repos.reviews.insert(receipt)).rejects.toThrow();
    await repos.reviews.moveSpace('p1', 's2');
    expect(db.prepare('SELECT toolCallId, spaceId, draft FROM page_reviews ORDER BY toolCallId').all()).toEqual([
        { toolCallId: 'c1', spaceId: 's2', draft: '{"title":"Notes"}' },
        { toolCallId: 'c2', spaceId: 's1', draft: '{"title":"Notes"}' },
    ]);
});

it('leases a page conversation’s creation to one caller until it is ready or released', async () => {
    const { db, repos } = context();
    const key = { pageId: 'p1', dotId: 'd1', userId: 'alice' };
    const row = () => db.prepare('SELECT threadId, ready, leaseUntil FROM page_threads').all();
    expect(await repos.threads.reserve(key, 't1', 1_060, 1_000)).toBe(true);
    // Leased: another caller waits, and the first thread id stays.
    expect(await repos.threads.reserve(key, 't2', 1_070, 1_010)).toBe(false);
    expect(row()).toEqual([{ threadId: 't1', ready: 0, leaseUntil: 1_060 }]);
    // The lease ran out: the next caller takes it, on the same thread.
    expect(await repos.threads.reserve(key, 't3', 1_200, 1_060)).toBe(true);
    await repos.threads.release(key);
    expect(row()).toEqual([{ threadId: 't1', ready: 0, leaseUntil: 0 }]);
    expect(await repos.threads.reserve(key, 't4', 1_300, 1_100)).toBe(true);
    await repos.threads.finish(key);
    // Ready: never leased again, and a release leaves it.
    expect(await repos.threads.reserve(key, 't5', 2_000, 5_000)).toBe(false);
    await repos.threads.release(key);
    expect(row()).toEqual([{ threadId: 't1', ready: 1, leaseUntil: 1_300 }]);
    // Another person's conversation about the page is their own.
    expect(await repos.threads.reserve({ ...key, userId: 'bob' }, 't6', 10, 0)).toBe(true);
    await repos.threads.removeForPage('p1');
    expect(row()).toEqual([]);
});

it('keeps the search rows in step: added, replaced, moved and removed', async () => {
    const { db, repos } = context();
    const rows = () => db.prepare('SELECT id, pageId, spaceId, title, body FROM page_search').all();
    const found = (word: string) =>
        db
            .prepare(
                'SELECT s.pageId FROM page_search_fts f JOIN page_search s ON s.id = f.rowid WHERE page_search_fts MATCH ?',
            )
            .all(word)
            .map((row) => row.pageId);
    await repos.search.put({
        pageId: 'p1',
        spaceId: 's1',
        title: 'Budget',
        body: 'invoice',
    });
    const [first] = rows();
    await repos.search.put({
        pageId: 'p1',
        spaceId: 'ignored',
        title: 'Roadmap',
        body: 'launch',
    });
    // Replaced in place: same key, same Space (a move changes that).
    expect(rows()).toEqual([
        {
            id: first!.id,
            pageId: 'p1',
            spaceId: 's1',
            title: 'Roadmap',
            body: 'launch',
        },
    ]);
    expect(found('invoice')).toEqual([]);
    expect(found('launch')).toEqual(['p1']);
    await repos.search.moveSpace('p1', 's2');
    expect(rows()).toMatchObject([{ spaceId: 's2' }]);
    await repos.search.remove('p1');
    expect(rows()).toEqual([]);
    expect(found('launch')).toEqual([]);
});

it('counts a person’s use of a page once a day, and forgets it with the page', async () => {
    const { repos } = context();
    expect(await repos.use.addDay('p1', 'alice', 100)).toBe(true);
    expect(await repos.use.addDay('p1', 'alice', 100)).toBe(false);
    expect(await repos.use.addDay('p1', 'bob', 100)).toBe(true);
    expect(await repos.use.addDay('p1', 'alice', 101)).toBe(true);
    expect(await repos.use.addDay('p2', 'alice', 99)).toBe(true);
    await repos.use.pruneDaysBefore(100);
    // Day 99 went, so it counts again.
    expect(await repos.use.addDay('p2', 'alice', 99)).toBe(true);
    expect(await repos.use.use('p1')).toBeUndefined();
    await repos.use.put('p1', { score: 1, scoredAt: 5, usedAt: 5 });
    await repos.use.put('p1', { score: 1.5, scoredAt: 6, usedAt: 6 });
    expect(await repos.use.use('p1')).toEqual({
        score: 1.5,
        scoredAt: 6,
        usedAt: 6,
    });
    await repos.use.removeForPage('p1');
    expect(await repos.use.use('p1')).toBeUndefined();
    expect(await repos.use.addDay('p1', 'alice', 100)).toBe(true);
});

it('writes the search rollup whole, and prunes old days', () => {
    const { db } = context();
    const stats = new SqliteSearchStats(db);
    const day = (name: string, queries: number) => ({
        day: name,
        queries,
        empty: 0,
        corrected: 0,
        trigram: 0,
        maxMs: 1.5,
        histogram: '{"3":1}',
        sizes: null,
    });
    stats.save([day('2026-10-01', 1), day('2026-10-02', 2)]);
    stats.save([day('2026-10-02', 5)], '2026-10-02');
    expect(stats.latest(5)).toEqual([day('2026-10-02', 5)]);
    expect(stats.day('2026-10-01')).toBeUndefined();
    // A failed write leaves the rollup as it was.
    db.exec(
        "CREATE TRIGGER fail BEFORE INSERT ON page_search_daily WHEN new.day = 'bad' BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    expect(() => stats.save([day('2026-10-03', 1), day('bad', 1)], '2026-10-03')).toThrow('disk full');
    expect(stats.latest(5)).toEqual([day('2026-10-02', 5)]);
});

it('rolls back every repository write in a failed unit of work', async () => {
    const { db, uow, repos } = context();
    await expect(
        uow.run(
            async () => {
                await repos.pages.insert(page());
                await repos.search.put({
                    pageId: 'p1',
                    spaceId: 's1',
                    title: 'Notes',
                    body: '',
                });
                await repos.threads.reserve({ pageId: 'p1', dotId: 'd1', userId: 'alice' }, 't1', 10, 0);
                throw new Error('Nope');
            },
            { label: 'create page' },
        ),
    ).rejects.toThrow('Nope');
    for (const table of ['pages', 'page_search', 'page_threads']) {
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({
            n: 0,
        });
    }
    expect(db.isTransaction).toBe(false);
});

/*
 * Only the pages repositories write the page tables (CB-110). Reads stay
 * in `Pages` until the workspace and chats contexts move theirs; the
 * migrations write them as they make them.
 */
const root = join(import.meta.dirname, '../..');
const INFRA = 'src/server/pages/infra/';
/** Files that may write them, and why. */
const ALLOWED = new Map([
    // Its migrations (`pagesSchema`), before `export class Pages`.
    ['src/server/pages/pages.ts', 'migrations'],
    // A person's id change takes their page conversations along; it moves
    // with the workspace context (CB-110, a later wave). The People slice
    // (`migrateLegacyOwner`), split from workspace.ts.
    ['src/server/workspace/people.ts', 'workspace'],
    // CB-380: a workspace bundle's import, an operator's copy between two
    // Socio servers: pages with their ids, times, tags, links and search
    // rows, in its own chunked transactions.
    ['src/server/bundle/import.ts', 'bundle'],
]);

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return sources(path);
        }
        return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
}

const names = [...pageTables.map((table) => getTableName(table)), 'page_search_daily', 'page_deletions'];
/** SQL writing a page table: `INSERT INTO pages`, `UPDATE page_threads`, … */
const write = new RegExp(String.raw`\b(?:INTO|UPDATE|DELETE\s+FROM)\s+["'\x60\[]?(?:${names.join('|')})\b(?!\w)`);

it('spots SQL writing a page table', () => {
    for (const sql of [
        'INSERT INTO pages(id) VALUES (?)',
        'INSERT OR IGNORE INTO page_threads VALUES (?)',
        'UPDATE "page_search" SET spaceId=?',
        'DELETE FROM page_use_days WHERE day < ?',
        'INSERT OR REPLACE INTO page_search_daily VALUES (?)',
    ]) {
        expect(sql).toMatch(write);
    }
    for (const other of [
        'SELECT * FROM pages WHERE id=?',
        'INSERT INTO page_search_fts(rowid) VALUES (?)',
        'UPDATE pages_v2 SET x=1',
        'Delete the page from the Space',
    ]) {
        expect(other).not.toMatch(write);
    }
});

it('keeps writes to the page tables inside the pages repositories', () => {
    const offenders: string[] = [];
    for (const path of [
        ...sources(join(root, 'src')),
        ...sources(join(root, 'packages/client/src')),
        ...PACKAGE_SOURCES.flatMap((dir) => sources(join(root, dir))),
    ]) {
        const file = relative(root, path).replaceAll('\\', '/');
        if (file.startsWith(INFRA)) {
            continue;
        }
        let text = readFileSync(path, 'utf8');
        if (ALLOWED.get(file) === 'workspace' || ALLOWED.get(file) === 'bundle') {
            continue;
        }
        if (ALLOWED.get(file) === 'migrations') {
            text = text.slice(text.indexOf('export class Pages'));
        }
        for (const match of text.matchAll(new RegExp(write, 'g'))) {
            offenders.push(`${file}: ${match[0]}`);
        }
    }
    expect(offenders).toEqual([]);
});
