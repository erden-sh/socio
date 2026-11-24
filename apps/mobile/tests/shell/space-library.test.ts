import { describe, expect, it } from 'vitest';

import type { PageSummary } from '@socio/shared/pages/page-library';
import type { Space } from '@socio/shared/types';

import {
    EMPTY_PAGE,
    IN_PAGE_TEXT,
    librarySearch,
    PAGE_SEARCH_LABEL,
    pageCount,
    pageMatches,
    pagePath,
    pageTree,
    recentPages,
    spaceHeading,
    spaceUnavailable,
    toggleExpanded,
} from '../../src/shell/space-library';
import type { ServerSearchState } from '../../src/sync/server-search';

// A Space's library: the web's Recently edited order with excerpts,
// trails and covers, and the tree from shared's pageHierarchy, expanded and
// collapsed, where no page of the Space is ever hidden.

const summary = (id: string, title: string, fields: Partial<PageSummary> = {}): PageSummary => ({
    id,
    spaceId: 'ops',
    parentId: null,
    title,
    excerpt: `About ${title}`,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    sourceThreadId: null,
    createdBy: 'u-ada',
    cover: null,
    ...fields,
});

const D = Date.UTC(2026, 10, 8, 12);

describe('a Space’s library, Recent', () => {
    it('lists its pages newest change first, then by title, leaving another Space’s out', () => {
        const rows = recentPages(
            [
                summary('a', 'Alpha', { updatedAt: D }),
                summary('b', 'Beta', { updatedAt: D + 1 }),
                summary('c', 'Aardvark', { updatedAt: D }),
                summary('x', 'Elsewhere', { spaceId: 'other', updatedAt: D + 9 }),
            ],
            'ops',
        );
        expect(rows.map((row) => row.id)).toEqual(['b', 'c', 'a']);
    });

    it('says the web’s words for an empty page and an untitled one, the edit date, the trail and the cover', () => {
        const rows = recentPages(
            [
                summary('root', 'Handbook', { updatedAt: D }),
                summary('kid', '  ', {
                    parentId: 'root',
                    excerpt: '',
                    updatedAt: D + 1,
                    cover: { id: 'emb1', url: '/x' },
                }),
            ],
            'ops',
        );
        expect(rows[0]).toMatchObject({
            id: 'kid',
            title: 'Untitled page',
            excerpt: EMPTY_PAGE,
            edited: 'Edited Nov 8',
            trail: 'Handbook',
            coverId: 'emb1',
            accessibilityLabel: 'Untitled page, in Handbook, Edited Nov 8',
        });
        expect(rows[1]).toMatchObject({ id: 'root', trail: null, coverId: null, excerpt: 'About Handbook' });
    });
});

describe('a Space’s library, the tree', () => {
    const pages = [
        summary('h', 'Handbook'),
        summary('o', 'Onboarding', { parentId: 'h' }),
        summary('f', 'First week', { parentId: 'o' }),
        summary('a', 'Archive'),
        summary('orphan', 'Lost child', { parentId: 'gone' }),
        // A cycle a broken trail made: neither may vanish.
        summary('c1', 'Loop one', { parentId: 'c2' }),
        summary('c2', 'Loop two', { parentId: 'c1' }),
    ];

    it('shows the top level by title, a page whose parent the phone lacks among it, and every page of a cycle', () => {
        const rows = pageTree(pages, 'ops', new Set());
        expect(rows.map((row) => [row.id, row.depth])).toEqual([
            ['a', 0],
            ['h', 0],
            ['c1', 0],
            ['c2', 0],
            ['orphan', 0],
        ]);
        expect(rows.find((row) => row.id === 'h')).toMatchObject({
            children: 1,
            expanded: false,
            accessibilityLabel: 'Handbook, 1 subpage',
        });
        expect(rows.find((row) => row.id === 'a')).toMatchObject({ children: 0, accessibilityLabel: 'Archive' });
    });

    it('opens and closes a parent, its subpages one level in, and says each one’s state', () => {
        let expanded = toggleExpanded(new Set(), 'h');
        let rows = pageTree(pages, 'ops', expanded);
        expect(rows.map((row) => row.id).slice(0, 4)).toEqual(['a', 'h', 'o', 'c1']);
        expect(rows.find((row) => row.id === 'h')?.expanded).toBe(true);
        expect(rows.find((row) => row.id === 'o')).toMatchObject({ depth: 1, expanded: false, children: 1 });
        expanded = toggleExpanded(expanded, 'o');
        rows = pageTree(pages, 'ops', expanded);
        expect(rows.find((row) => row.id === 'f')).toMatchObject({ depth: 2, children: 0, expanded: false });
        // Closing the top hides the whole branch; its children keep their own state for next time.
        expanded = toggleExpanded(expanded, 'h');
        expect(pageTree(pages, 'ops', expanded).map((row) => row.id)).not.toContain('o');
        expect(expanded.has('o')).toBe(true);
        // A page with no subpages never reads as expanded.
        expect(pageTree(pages, 'ops', new Set(['a']))[0]).toMatchObject({ id: 'a', expanded: false });
    });

    it('leaves out another Space’s pages', () => {
        expect(pageTree([summary('x', 'X', { spaceId: 'other' })], 'ops', new Set())).toEqual([]);
    });
});

describe('a Space’s heading and words', () => {
    const space = (fields: Partial<Space>) => ({ id: 'ops', name: 'Ops', createdAt: 1, ...fields }) as Space;

    it('names the Space with its description and privacy, or nothing while the workspace doesn’t list it', () => {
        expect(spaceHeading([space({ description: ' ', private: true })], 'ops')).toEqual({
            name: 'Ops',
            description: null,
            private: true,
            subtitle: 'Private',
        });
        expect(spaceHeading([space({ description: 'Runbooks' })], 'ops')?.description).toBe('Runbooks');
        // The line under the big title.
        expect(spaceHeading([space({ description: 'Runbooks' })], 'ops')?.subtitle).toBe('Runbooks');
        expect(spaceHeading([space({ description: 'Runbooks', private: true })], 'ops')?.subtitle).toBe(
            'Private · Runbooks',
        );
        expect(spaceHeading([space({})], 'ops')?.subtitle).toBeNull();
        expect(spaceHeading([], 'ops')).toBeNull();
    });

    it('says a Space is gone only once the workspace has answered without it', () => {
        expect(spaceUnavailable([], 'ops', true)).toBe(true);
        expect(spaceUnavailable([space({ id: 'other' })], 'ops', true)).toBe(true);
        // Not yet answered: the library waits rather than saying gone.
        expect(spaceUnavailable([], 'ops', false)).toBe(false);
        expect(spaceUnavailable([space({})], 'ops', true)).toBe(false);
    });

    it('counts pages and gives the web’s path of a page', () => {
        expect([pageCount(1), pageCount(3)]).toEqual(['1 page', '3 pages']);
        expect(pagePath('ops', 'p 1')).toBe('/spaces/ops/pages/p%201');
    });
});

describe('a Space’s page search', () => {
    const pages = [
        summary('a', 'Café menu', { excerpt: 'Prices for the week', updatedAt: D + 2 }),
        summary('b', 'Handbook', { excerpt: 'How we work: the cafe rota', updatedAt: D + 1 }),
        summary('c', 'Roadmap', { excerpt: 'Q4 plans', updatedAt: D }),
        summary('x', 'Cafe elsewhere', { spaceId: 'other' }),
    ];
    const rows = recentPages(pages, 'ops');
    const idle: ServerSearchState = { status: 'idle' };
    const hit = (id: string, spaceId = 'ops') => ({
        id,
        spaceId,
        title: id === 'c' ? 'Roadmap' : `Page ${id}`,
        updatedAt: D,
        snippet: [
            { text: 'the ', match: false },
            { text: 'cafe', match: true },
            { text: '  opens', match: false },
        ],
        matched: 'word' as const,
        freshness: { basis: 'edited' as const, at: D },
    });
    const done = (results: ReturnType<typeof hit>[]): ServerSearchState => ({
        status: 'done',
        answer: { query: 'cafe', pages: { query: 'cafe', corrected: null, results, more: false }, issues: null },
    });

    it('is the web’s field: "Search pages"', () => {
        expect(PAGE_SEARCH_LABEL).toBe('Search pages');
    });

    it('shows the library as it is with nothing typed', () => {
        expect(librarySearch({ query: '  ', spaceId: 'ops', rows, pages, server: idle })).toMatchObject({
            searching: false,
            local: [],
            text: [],
        });
    });

    it('filters the pages the phone holds by title and excerpt, case and accents folded, in Recent’s order', () => {
        expect([...pageMatches(pages, 'CAFÉ')].sort()).toEqual(['a', 'b', 'x']);
        const found = librarySearch({ query: 'cafe', spaceId: 'ops', rows, pages, server: idle });
        expect(found.local.map((row) => row.id)).toEqual(['a', 'b']);
        expect(found).toMatchObject({ searching: true, text: [], line: null, empty: null, count: '2 pages' });
        expect(
            librarySearch({ query: 'q4', spaceId: 'ops', rows, pages, server: idle }).local.map((r) => r.id),
        ).toEqual(['c']);
    });

    it('adds the server’s matches in the Space’s page text that the phone’s didn’t find, once', () => {
        const found = librarySearch({
            query: 'Cafe',
            spaceId: 'ops',
            rows,
            pages,
            server: done([hit('a'), hit('c'), hit('new'), hit('far', 'other')]),
            now: D,
        });
        expect(found.local.map((row) => row.id)).toEqual(['a', 'b']);
        expect(found.text.map((row) => [row.id, row.title, row.snippet])).toEqual([
            ['c', 'Roadmap', 'the cafe opens'],
            ['new', 'Page new', 'the cafe opens'],
        ]);
        expect(found.text[0]!.accessibilityLabel).toContain('Roadmap');
        expect(found.count).toBe('4 pages');
        expect(IN_PAGE_TEXT).toBe('In page text');
    });

    it('ignores an answer to another query', () => {
        const found = librarySearch({ query: 'roadmap', spaceId: 'ops', rows, pages, server: done([hit('new')]) });
        expect(found.text).toEqual([]);
    });

    it('filters locally offline and says the text search needs a connection', () => {
        const found = librarySearch({
            query: 'cafe',
            spaceId: 'ops',
            rows,
            pages,
            server: { status: 'offline', query: 'cafe' },
        });
        expect(found.local).toHaveLength(2);
        expect(found.line).toBe('Searching page text needs a connection');
        const none = librarySearch({ query: 'zzz', spaceId: 'ops', rows, pages, server: idle });
        expect(none.empty).toBe('Nothing matches “zzz”.');
        const waiting = librarySearch({
            query: 'zzz',
            spaceId: 'ops',
            rows,
            pages,
            server: { status: 'waiting', query: 'zzz' },
        });
        expect(waiting).toMatchObject({ empty: null, line: 'Searching pages…' });
    });
});
