import { afterEach, expect, it } from 'vitest';

import { freshnessLabel } from '@socio/shared/pages/page-search';
import { percentile } from '@socio/shared/pages/search-timing';
import { textSnippet } from '@socio/shared/pages/text-snippet';

import { editDistance, freshnessOf, queryWords, titleTier, USE_DAYS_KEPT } from '../src/server/pages/page-search.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

// Server page search: the store.
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 11, 12);
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function fixture() {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const [everyday] = workspace.spaces();
    const finance = workspace.createSpace('Finance', 'Money.');
    for (const [id, name] of [
        ['alice', 'Alice'],
        ['bob', 'Bob'],
        ['carol', 'Carol'],
    ]) {
        workspace.recordUser({ id, name, role: 'member' });
    }
    const { db, pages } = workspace;
    const spaces = () => workspace.spaces().map((space) => space.id);
    const search = (query: string, extra: Record<string, unknown> = {}) =>
        pages.search({ query, spaces: spaces(), now: NOW, ...extra });
    const ids = (query: string, extra: Record<string, unknown> = {}) =>
        search(query, extra).results.map((hit) => hit.title);
    const rows = () =>
        db
            .prepare('SELECT pageId, title, body FROM page_search ORDER BY id')
            .all()
            .map((row) => ({ ...row }));
    const integrity = () => {
        for (const table of ['page_search_fts', 'page_search_tri']) {
            db.prepare(`INSERT INTO ${table}(${table}, rank) VALUES ('integrity-check', 1)`).run();
        }
    };
    const age = (id: string, days: number) =>
        db.prepare('UPDATE pages SET updatedAt=? WHERE id=?').run(NOW - days * DAY, id);
    return {
        workspace,
        db,
        pages,
        everyday: everyday!,
        finance,
        search,
        ids,
        rows,
        integrity,
        age,
    };
}

it('runs on a SQLite with FTS5 and the trigram tokenizer', () => {
    const db = testDatabase();
    cleanup.push(() => db.close());
    const options = db
        .prepare('SELECT compile_options AS o FROM pragma_compile_options')
        .all()
        .map((row) => row.o);
    expect(options).toContain('ENABLE_FTS5');
    db.exec("CREATE VIRTUAL TABLE t USING fts5(a, tokenize='trigram')");
});

it('keeps the index in step with creates, edits, moves and deletes', async () => {
    const { pages, everyday, rows, integrity, db } = fixture();
    const parent = await pages.create(everyday.id, {
        title: 'Vendor contract',
        content: '# Terms\n\nThe **renewal** is in [March](https://x).',
    });
    const child = await pages.create(everyday.id, {
        title: 'Pricing',
        content: 'Notes',
        parentId: parent.id,
    });
    expect(rows()).toEqual([
        {
            pageId: parent.id,
            title: 'Vendor contract',
            body: 'Terms The renewal is in March.',
        },
        { pageId: child.id, title: 'Pricing', body: 'Notes' },
    ]);
    const edited = await pages.update(everyday.id, child.id, {
        title: 'Pricing 2027',
        content: 'New prices',
        expectedRevision: 1,
    });
    expect(rows()[1]).toEqual({
        pageId: child.id,
        title: 'Pricing 2027',
        body: 'New prices',
    });
    // A move changes neither: the row isn't rewritten.
    const before = db.prepare('SELECT id FROM page_search WHERE pageId=?').get(child.id);
    await pages.update(everyday.id, child.id, {
        parentId: null,
        expectedRevision: edited.revision,
    });
    expect(db.prepare('SELECT id FROM page_search WHERE pageId=?').get(child.id)).toEqual(before);
    integrity();
    await pages.create(everyday.id, { title: 'Keep', content: 'kept' });
    await pages.update(everyday.id, child.id, {
        parentId: parent.id,
        expectedRevision: edited.revision + 1,
    });
    await pages.delete(everyday.id, parent.id, { subpages: true });
    expect(rows().map((row) => row.title)).toEqual(['Keep']);
    integrity();
});

it('rolls back the search row with a failed reviewed save', async () => {
    const { workspace, pages, everyday, rows } = fixture();
    const dot = workspace.dots()[0]!;
    workspace.bindThread('t1', dot.id, 'Chat', 'alice');
    await pages.createReviewed(everyday.id, { title: 'Reviewed', content: 'From a review' }, 't1', 'call-1', 'alice');
    expect(rows().map((row) => row.title)).toEqual(['Reviewed']);
    // The receipt insert fails after the page: neither stays.
    workspace.db.exec("CREATE TRIGGER fail BEFORE INSERT ON page_reviews BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    await expect(
        pages.createReviewed(everyday.id, { title: 'Second', content: 'x' }, 't1', 'call-2', 'alice'),
    ).rejects.toMatchObject({
        // The repository's query error, caused by the trigger's.
        cause: expect.objectContaining({
            message: expect.stringContaining('disk full'),
        }),
    });
    expect(rows().map((row) => row.title)).toEqual(['Reviewed']);
    expect(pages.list(everyday.id).map((page) => page.title)).toEqual(['Reviewed']);
});

it('never returns deleted pages or pages of a deleted Space, even with their rows left behind', async () => {
    const { pages, everyday, finance, db, ids, search } = fixture();
    const gone = await pages.create(everyday.id, {
        title: 'Budget gone',
        content: 'budget',
    });
    await pages.create(finance.id, {
        title: 'Budget finance',
        content: 'budget',
    });
    await pages.create(everyday.id, { title: 'Budget kept', content: 'budget' });
    await pages.delete(everyday.id, gone.id);
    // A writer that skipped the store: the row is back, the page stays deleted.
    db.prepare('INSERT INTO page_search(pageId, spaceId, title, body) VALUES (?, ?, ?, ?)').run(
        gone.id,
        everyday.id,
        'Budget gone',
        'budget',
    );
    expect(ids('budget').sort()).toEqual(['Budget finance', 'Budget kept']);
    db.prepare('UPDATE spaces SET deletedAt=1 WHERE id=?').run(finance.id);
    expect(ids('budget')).toEqual(['Budget kept']);
    // A caller's Space list is the limit.
    expect(search('budget', { spaces: [finance.id] }).results.map((hit) => hit.title)).toEqual(['Budget finance']);
    expect(search('budget', { spaces: [] }).results).toEqual([]);
});

it('treats every input as literal text', async () => {
    const { pages, everyday, ids } = fixture();
    await pages.create(everyday.id, {
        title: 'Café plans',
        content: 'See CB-12.',
    });
    await pages.create(everyday.id, {
        title: 'C++ e-mail',
        content: 'Write the e-mail in C++.',
    });
    expect(ids('cafe')).toEqual(['Café plans']);
    expect(ids('CAFÉ')).toEqual(['Café plans']);
    expect(ids('cb-12')).toEqual(['Café plans']);
    expect(ids('cb-1')).toEqual(['Café plans']);
    expect(ids('e-mail')).toEqual(['C++ e-mail']);
    for (const input of [
        '"quoted',
        'AND',
        'or not',
        'near(x)',
        'title:secret',
        '^plan',
        'c++',
        '-plan',
        "'; DROP TABLE f; --",
        '(',
        '*',
        '"',
        'x'.repeat(300),
        '会議の予定',
        '🙂 plans',
    ]) {
        expect(() => ids(input), input).not.toThrow();
    }
    expect(ids('🙂 plans')).toEqual(['Café plans']);
    // Nothing to search: no letters, or under 2 characters in all.
    expect(queryWords('— * &&')).toEqual([]);
    expect(queryWords('a')).toEqual([]);
    expect(queryWords('a plan')).toEqual(['plan']);
    expect(queryWords('q3')).toEqual(['q3']);
    expect(queryWords('one two three four five six seven eight nine')).toEqual(
        'one two three four five six seven eight'.split(' '),
    );
});

it('ranks by title tier, the title weight and freshness, and pages stably', async () => {
    const { pages, everyday, ids, search, age } = fixture();
    const body = await pages.create(everyday.id, {
        title: 'Quarter notes',
        content: 'The roadmap is in the roadmap doc about the roadmap.',
    });
    const words = await pages.create(everyday.id, {
        title: 'Product roadmap draft',
        content: 'Draft.',
    });
    const prefix = await pages.create(everyday.id, {
        title: 'Roadmap 2027',
        content: 'Plans.',
    });
    const exact = await pages.create(everyday.id, {
        title: 'Roadmap',
        content: 'Plans.',
    });
    for (const page of [body, words, prefix, exact]) {
        age(page.id, 400);
    }
    expect(ids('roadmap')).toEqual(['Roadmap', 'Roadmap 2027', 'Product roadmap draft', 'Quarter notes']);
    expect(titleTier('Product roadmap draft', ['road', 'dra'])).toBe(2);
    // Freshness within a tier: of two equal pages the fresher one first.
    const old = await pages.create(everyday.id, {
        title: 'Offsite A',
        content: 'travel',
    });
    const fresh = await pages.create(everyday.id, {
        title: 'Offsite B',
        content: 'travel',
    });
    age(old.id, 200);
    age(fresh.id, 2);
    expect(ids('travel')).toEqual(['Offsite B', 'Offsite A']);
    age(old.id, 1);
    expect(ids('travel')).toEqual(['Offsite A', 'Offsite B']);
    // Paging: the same order, `more` until the end.
    for (let index = 0; index < 11; index++) {
        await pages.create(everyday.id, {
            title: `Memo ${index}`,
            content: `budget ${'filler '.repeat(index)}`,
        });
    }
    const first = search('budget', { limit: 5 });
    const second = search('budget', { limit: 5, offset: 5 });
    const third = search('budget', { limit: 5, offset: 10 });
    const all = search('budget', { limit: 20 });
    expect([first, second, third].map((answer) => answer.more)).toEqual([true, true, false]);
    expect([first, second, third].flatMap((answer) => answer.results.map((hit) => hit.id))).toEqual(
        all.results.map((hit) => hit.id),
    );
    expect(all.results).toHaveLength(11);
    // Limits are clamped.
    expect(search('budget', { limit: 500 }).results).toHaveLength(11);
    expect(search('budget', { limit: 0 }).results).toHaveLength(1);
});

it('marks the matched words in snippets, and never indexes the markers', async () => {
    const { pages, everyday, search, db } = fixture();
    await pages.create(everyday.id, {
        title: 'Invoices',
        content: `Plan the **invoice** run.\u0001 Then the next invoice.`,
    });
    await pages.create(everyday.id, {
        title: 'Invoice only in the title',
        content: 'Nothing else here.',
    });
    const [hit, title] = search('invo').results;
    expect(hit!.snippet).toEqual([
        { text: 'Plan the ', match: false },
        { text: 'invoice', match: true },
        { text: ' run. Then the next ', match: false },
        { text: 'invoice', match: true },
        { text: '.', match: false },
    ]);
    expect(hit!.matched).toBe('word');
    // A title hit: the start of the body.
    expect(title!.snippet).toEqual([{ text: 'Nothing else here.', match: false }]);
    expect(
        db
            .prepare(
                "SELECT COUNT(*) AS n FROM page_search WHERE body GLOB '*[\u0001\u0002]*' OR title GLOB '*[\u0001\u0002]*'",
            )
            .get(),
    ).toEqual({ n: 0 });
});

it('fills in text inside words from the trigram index, after word hits', async () => {
    const { pages, everyday, search } = fixture();
    await pages.create(everyday.id, {
        title: 'Billing',
        content: 'Send the customer invoice before Friday.',
    });
    await pages.create(everyday.id, {
        title: 'Voice notes',
        content: 'Voicemail setup.',
    });
    const answer = search('voic');
    expect(answer.results.map((hit) => [hit.title, hit.matched])).toEqual([
        ['Voice notes', 'word'],
        ['Billing', 'text'],
    ]);
    expect(answer.results[1]!.snippet).toEqual([
        { text: 'Send the customer ', match: false },
        { text: 'invoice', match: true },
        { text: ' before Friday.', match: false },
    ]);
    // Under 3 characters a word can't be inside another: no trigram.
    expect(search('oi').results).toEqual([]);
    // Both words inside other words.
    expect(search('ustom nvoi').results.map((hit) => hit.title)).toEqual(['Billing']);
});

it('cuts trigram snippets at words and folds accents and case', () => {
    const body = `${'filler '.repeat(40)}the Résumé of the CAFÉ meeting ${'tail '.repeat(40)}`;
    const parts = textSnippet(body, ['sum', 'cafe']);
    expect(parts.filter((part) => part.match).map((part) => part.text)).toEqual(['Résumé', 'CAFÉ']);
    // Cut at spaces, never inside a word.
    const text = parts.map((part) => part.text).join('');
    expect(text).toMatch(/^…filler filler .* tail…$/);
});

it('corrects a misspelt word only when nothing matches, and says so', async () => {
    const { pages, everyday, finance, search } = fixture();
    await pages.create(everyday.id, {
        title: 'Billing',
        content: 'The invoice and the invoices; a middleware note.',
    });
    await pages.create(everyday.id, { title: 'Infra', content: 'middleware' });
    await pages.create(finance.id, { title: 'Secret', content: 'acquisition' });
    // A swap of two letters is one edit.
    expect(search('invioce')).toMatchObject({
        corrected: 'invoice',
        query: 'invoice',
        results: [{ title: 'Billing' }],
    });
    // A missing letter; and two edits from 8 letters.
    expect(search('midleware').corrected).toBe('middleware');
    expect(search('midlewere').corrected).toBe('middleware');
    // While typing: the start of a word, misspelt.
    expect(search('invioc').corrected).toBe('invoice');
    // Something matched: no correction.
    expect(search('invoice').corrected).toBeNull();
    // "Search instead for …".
    expect(search('invioce', { exact: true })).toMatchObject({
        corrected: null,
        results: [],
    });
    // Too far, or too short.
    expect(search('inxxxce').corrected).toBeNull();
    expect(search('ivo').corrected).toBeNull();
    // A caller limited to one Space never learns another's words.
    expect(search('acquisitoin', { spaces: [everyday.id] })).toMatchObject({
        corrected: null,
        results: [],
    });
    expect(search('acquisitoin').corrected).toBe('acquisition');
    expect(editDistance('invioce', 'invoice')).toBe(1);
    expect(editDistance('abc', 'abcdef', 1)).toBe(2);
});

it('counts one use per person, page and day toward freshness', async () => {
    const { pages, everyday, db, age, search, workspace } = fixture();
    const page = await pages.create(everyday.id, {
        title: 'Runbook',
        content: 'ops',
    });
    age(page.id, 300);
    expect(search('runbook').results[0]!.freshness).toEqual({
        basis: 'edited',
        at: NOW - 300 * DAY,
    });
    // Clicking ten times counts once.
    for (let index = 0; index < 10; index++) {
        await pages.noteUse(everyday.id, page.id, 'alice', NOW);
    }
    expect(db.prepare('SELECT * FROM page_use').all()).toEqual([
        { pageId: page.id, score: 1, scoredAt: NOW, usedAt: NOW },
    ]);
    expect(search('runbook').results[0]!.freshness).toEqual({
        basis: 'used',
        at: NOW,
    });
    // A second person counts; the same person the next day too.
    expect(await pages.noteUse(everyday.id, page.id, 'bob', NOW)).toBe(true);
    expect(await pages.noteUse(everyday.id, page.id, 'alice', NOW + DAY)).toBe(true);
    // Not a person: a service account, a team, someone unknown.
    workspace.recordUser({ id: 'svc', name: 'Sync', role: 'member' });
    db.prepare("INSERT INTO service_accounts(userId, createdAt) VALUES ('svc', 1)").run();
    for (const id of ['svc', 'telegram-team:1', 'nobody']) {
        expect(await pages.noteUse(everyday.id, page.id, id, NOW)).toBe(false);
    }
    // A wrong Space: ignored.
    expect(await pages.noteUse('elsewhere', page.id, 'carol', NOW)).toBe(false);
    // Dedupe rows go after a few days; the aggregate stays.
    await pages.noteUse(everyday.id, page.id, 'carol', NOW + USE_DAYS_KEPT * DAY);
    expect(
        db
            .prepare('SELECT userId, day FROM page_use_days ORDER BY day, userId')
            .all()
            .map((row) => `${row.userId}:${Number(row.day) - Math.floor(NOW / DAY)}`),
    ).toEqual(['alice:1', `carol:${USE_DAYS_KEPT}`]);
    // A deleted page: ignored, and its use rows go with it.
    await pages.delete(everyday.id, page.id);
    expect(await pages.noteUse(everyday.id, page.id, 'carol', NOW + 5 * DAY)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_use').get()).toEqual({
        n: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_use_days').get()).toEqual({
        n: 0,
    });
});

it('applies saved page-history retention and keeps history at zero', async () => {
    const { pages, everyday, db } = fixture();
    const page = await pages.create(everyday.id, {
        title: 'Retention runbook',
        content: 'ops',
    });
    pages.setSearchRetention(() => ({ pageUseDays: 0, pageSearchDays: 0 }));
    await pages.noteUse(everyday.id, page.id, 'alice', NOW - 500 * DAY);
    await pages.noteUse(everyday.id, page.id, 'alice', NOW);
    expect(db.prepare('SELECT COUNT(*) n FROM page_use_days').get()?.n).toBe(2);
    // Flush at today's real clock: persisted old daily search history survives.
    db.prepare(
        "INSERT INTO page_search_daily(day,queries,empty,corrected,trigram,maxMs,histogram,sizes) VALUES (?,1,0,0,0,1,'{}','{}')",
    ).run(new Date(NOW - 500 * DAY).toISOString().slice(0, 10));
    pages.search({ query: 'runbook', spaces: [everyday.id], now: NOW });
    pages.flushSearchStats();
    expect(db.prepare('SELECT COUNT(*) n FROM page_search_daily').get()?.n).toBe(2);
    pages.setSearchRetention(() => ({ pageUseDays: 10, pageSearchDays: 10 }));
    await pages.noteUse(everyday.id, page.id, 'bob', NOW);
    pages.search({ query: 'runbook', spaces: [everyday.id], now: Date.now() });
    pages.flushSearchStats();
    expect(db.prepare('SELECT MIN(day) n FROM page_use_days').get()?.n).toBe(Math.floor(NOW / DAY));
    expect(String(db.prepare('SELECT MIN(day) n FROM page_search_daily').get()?.n)).toBe(
        new Date(Date.now()).toISOString().slice(0, 10),
    );
});

it('weighs freshness from edits and uses on one curve', () => {
    const half = 30 * DAY;
    expect(freshnessOf(NOW, undefined, NOW).value).toBe(1);
    expect(freshnessOf(NOW - half, undefined, NOW).value).toBeCloseTo(0.5);
    // One use today counts a third of an edit today; three count fully.
    const use = (score: number) => ({ score, scoredAt: NOW, usedAt: NOW });
    expect(freshnessOf(NOW - 365 * DAY, use(1), NOW)).toMatchObject({
        basis: 'used',
    });
    expect(freshnessOf(NOW - 365 * DAY, use(1), NOW).value).toBeCloseTo(1 / 3);
    expect(freshnessOf(NOW - 365 * DAY, use(5), NOW).value).toBe(1);
    // An edit fresher than the uses wins.
    expect(freshnessOf(NOW - DAY, use(1), NOW).basis).toBe('edited');
    expect(freshnessLabel({ basis: 'edited', at: NOW - 3 * DAY }, NOW)).toBe('Edited 3 days ago');
    expect(freshnessLabel({ basis: 'edited', at: NOW }, NOW)).toBe('Edited today');
    expect(freshnessLabel({ basis: 'edited', at: NOW - 20 * DAY }, NOW)).toBe('Edited 2 weeks ago');
    expect(freshnessLabel({ basis: 'edited', at: NOW - 400 * DAY }, NOW)).toBe('Edited 1 year ago');
    expect(freshnessLabel({ basis: 'used', at: NOW - 3 * DAY }, NOW)).toBe('Used this week');
    expect(freshnessLabel({ basis: 'used', at: NOW - 70 * DAY }, NOW)).toBe('Used 2 months ago');
});

it('keeps a daily timing rollup without query text', async () => {
    const { pages, everyday, search, db } = fixture();
    await pages.create(everyday.id, {
        title: 'Secret merger plan',
        content: 'confidential',
    });
    search('merger');
    search('confidential');
    search('zebra');
    search('mreger');
    search('a'); // Nothing to search: not counted.
    const stats = pages.searchStats();
    expect(stats.days).toHaveLength(1);
    expect(stats.days[0]).toMatchObject({
        day: '2026-10-11',
        queries: 4,
        empty: 1,
        corrected: 1,
        trigram: 0,
    });
    expect(stats.days[0]!.p50).toBeGreaterThan(0);
    expect(stats.days[0]!.p99).toBeGreaterThanOrEqual(stats.days[0]!.p50!);
    expect(stats.days[0]!.p99).toBeLessThanOrEqual(stats.days[0]!.maxMs);
    expect(stats.days[0]!.sizes).toMatchObject({ pages: 1 });
    expect(stats.now.wordBytes).toBeGreaterThan(0);
    expect(stats.now.trigramBytes).toBeGreaterThan(0);
    expect(stats.now.textBytes).toBeGreaterThan(0);
    const stored = JSON.stringify(db.prepare('SELECT * FROM page_search_daily').all());
    for (const word of ['merger', 'confidential', 'zebra', 'mreger']) {
        expect(stored).not.toContain(word);
    }
    // A second flush adds to the same day.
    search('merger');
    expect(pages.searchStats().days[0]!.queries).toBe(5);
    expect(percentile({ 10: 98, 40: 2 }, 50)).toBeLessThan(percentile({ 10: 98, 40: 2 }, 99)!);
    expect(percentile({}, 50)).toBeNull();
});
