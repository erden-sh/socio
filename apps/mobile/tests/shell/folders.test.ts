import { describe, expect, it } from 'vitest';

import type { Page, PageSummary } from '@socio/shared/pages/page-library';
import type { SpaceRadar } from '@socio/shared/pages/page-radar';

import { conflictBanner } from '../../src/shell/page-conflict';
import {
    folderToggle,
    NEW_FOLDER_ACTION,
    NEW_PAGE_ACTION,
    offersFolders,
    pageMenu,
    pagesNotSaved,
    readerBar,
    TURN_INTO_FOLDER,
    TURN_INTO_PAGE,
    withPageWrites,
} from '../../src/shell/page-menus';
import { FOLDER_EMPTY, FOLDER_KEPT_TEXT, IN_THIS_FOLDER, pageView } from '../../src/shell/page-reader';
import { searchView } from '../../src/shell/search';
import { libraryTree } from '../../src/shell/space-items';
import { FOLDER, folderLine, librarySearch, pageMatches, pageTree, recentPages } from '../../src/shell/space-library';
import { radarView } from '../../src/shell/space-sections';
import { unsentListRows } from '../../src/shell/unsent';
import type { UnsentWrite } from '../../src/sync/outbox';
import type { OverlayItem } from '../../src/sync/outbox-overlay';
import type { PageConflict } from '../../src/sync/page-conflicts';
import { heldFolder, isFolder, knowsFolders, PAGE_FOLDER_KIND } from '../../src/sync/page-manage';
import { PAGES } from '../../src/sync/pages';
import type { ServerSearchState } from '../../src/sync/server-search';

// Folders in Spaces (CB-426): a folder is a page marked as one, its body kept
// but hidden. The release owner's rule: nothing derived from a folder's body
// shows anywhere in the app. Each place the app shows a page's body, excerpt or
// a match in its text is checked here with a folder whose hidden body (and an
// excerpt an older copy might still hold) says HIDDEN-BODY-TEXT.

const SECRET = 'HIDDEN-BODY-TEXT';
const D = Date.UTC(2026, 10, 20, 12);

const summary = (id: string, title: string, fields: Partial<PageSummary> = {}): PageSummary => ({
    id,
    spaceId: 'ops',
    parentId: null,
    title,
    excerpt: `About ${title}`,
    revision: 2,
    createdAt: D,
    updatedAt: D,
    sourceThreadId: null,
    createdBy: 'u-ada',
    cover: null,
    folder: false,
    ...fields,
});

const body = (id: string, fields: Partial<Page> = {}): Page => ({
    id,
    spaceId: 'ops',
    parentId: null,
    title: 'Plans',
    content: `${SECRET} in the kept body`,
    revision: 2,
    createdAt: D,
    updatedAt: D,
    sourceThreadId: null,
    createdBy: 'u-ada',
    cover: null,
    sourceUrl: null,
    sourceTitle: null,
    folder: true,
    ...fields,
});

/** A folder holding two pages and a nested folder; its excerpt as an older copy might hold it. */
const pages: PageSummary[] = [
    summary('plans', 'Plans', { folder: true, excerpt: `${SECRET} excerpt` }),
    summary('q1', 'Q1 goals', { parentId: 'plans' }),
    summary('q2', 'Q2 goals', { parentId: 'plans' }),
    summary('archive', 'Archive', { parentId: 'plans', folder: true, excerpt: '' }),
    summary('old', 'Old notes', { parentId: 'archive' }),
    summary('handbook', 'Handbook', { excerpt: 'How we work' }),
];

const hit = (id: string, title: string, text = `${SECRET} snippet`) => ({
    id,
    spaceId: 'ops',
    title,
    updatedAt: D,
    snippet: [{ text, match: true }],
    matched: 'word' as const,
    freshness: { basis: 'edited' as const, at: D },
});
const answered = (query: string, results: ReturnType<typeof hit>[]): ServerSearchState => ({
    status: 'done',
    answer: { query, pages: { query, corrected: null, results, more: false }, issues: null },
});

const json = (value: unknown) => JSON.stringify(value);

describe('the mark', () => {
    it('is a page when missing (a server or a cached copy from before folders), a folder only when true', () => {
        expect(isFolder({ folder: true })).toBe(true);
        expect(isFolder({ folder: false })).toBe(false);
        expect(isFolder({})).toBe(false);
        expect(isFolder(null)).toBe(false);
        expect(knowsFolders({})).toBe(false);
        expect(knowsFolders({ folder: false })).toBe(true);
    });

    it('reads a held Space list for the global search, false for one the phone lacks', () => {
        const rows = new Map([
            ['plans', { key: 'plans', json: json(pages[0]), version: 2 }],
            ['q1', { key: 'q1', json: json(pages[1]), version: 2 }],
            ['legacy', { key: 'legacy', json: json({ id: 'legacy', title: 'Old' }), version: 1 }],
        ]);
        const cache = {
            rows: (collection: string, scope?: string) => (collection === PAGES && scope === 'ops' ? rows : new Map()),
        };
        expect(heldFolder(cache, 'ops', 'plans')).toBe(true);
        expect(heldFolder(cache, 'ops', 'q1')).toBe(false);
        expect(heldFolder(cache, 'ops', 'legacy')).toBe(false);
        expect(heldFolder(cache, 'elsewhere', 'plans')).toBe(false);
    });
});

describe('a folder in the library', () => {
    it('Recent says what it holds where a page shows its excerpt, never the excerpt', () => {
        const rows = recentPages(pages, 'ops');
        const plans = rows.find((row) => row.id === 'plans')!;
        expect(plans).toMatchObject({ folder: true, excerpt: 'Folder · 3 inside' });
        expect(rows.find((row) => row.id === 'archive')).toMatchObject({ folder: true, excerpt: 'Folder · 1 inside' });
        expect(rows.find((row) => row.id === 'handbook')).toMatchObject({ folder: false, excerpt: 'How we work' });
        expect(json(rows)).not.toContain(SECRET);
        expect(plans.accessibilityLabel).toContain('Folder · 3 inside');
        expect(folderLine(0)).toBe('Empty folder');
    });

    it('the tree marks folders and counts what they hold in the web’s words', () => {
        const rows = pageTree(pages, 'ops', new Set(['plans']));
        expect(rows.map((row) => [row.id, row.folder, row.depth])).toEqual([
            ['handbook', false, 0],
            ['plans', true, 0],
            ['archive', true, 1],
            ['q1', false, 1],
            ['q2', false, 1],
        ]);
        expect(rows[1]!.accessibilityLabel).toBe('Plans, Folder · 3 inside');
        const withItems = libraryTree(pages, [], 'ops', new Set(['plans']));
        expect(withItems.find((row) => row.kind === 'page' && row.row.id === 'archive')).toMatchObject({
            row: { folder: true },
        });
    });

    it('its title alone matches the phone’s search; the server’s body-only match and its snippet never show', () => {
        expect([...pageMatches(pages, SECRET)]).toEqual([]);
        expect([...pageMatches(pages, 'plans')]).toEqual(['plans']);
        const rows = recentPages(pages, 'ops');
        const byBody = librarySearch({
            query: SECRET,
            spaceId: 'ops',
            rows,
            pages,
            server: answered(SECRET.toLowerCase(), [hit('plans', 'Plans'), hit('handbook', 'Handbook', 'how we work')]),
            now: D,
        });
        expect(byBody.local).toEqual([]);
        // The page's own match stays; the folder found only by its hidden body doesn't.
        expect(byBody.text.map((row) => row.id)).toEqual(['handbook']);
        const byTitle = librarySearch({
            query: 'arch',
            spaceId: 'ops',
            rows,
            pages: pages.map((page) => (page.id === 'archive' ? { ...page, title: 'Archive' } : page)),
            server: answered('arch', [hit('archive', 'Archive')]),
            now: D,
        });
        expect(byTitle.local.map((row) => row.id)).toEqual(['archive']);
        // A folder's server hit by its title shows with no snippet.
        const held = librarySearch({
            query: 'arch',
            spaceId: 'ops',
            rows: rows.filter((row) => row.id !== 'archive'),
            pages,
            server: answered('arch', [hit('archive', 'Archive')]),
            now: D,
        });
        expect(held.text).toMatchObject([{ id: 'archive', folder: true, snippet: '' }]);
        expect(held.text[0]!.accessibilityLabel).toContain(FOLDER);
        expect(json([byBody, byTitle, held])).not.toContain(SECRET);
    });

    it('a toggle waiting on the phone shows at once, with no excerpt', () => {
        const overlays: OverlayItem[] = [
            {
                id: 'row-1',
                collection: PAGES,
                key: 'handbook',
                mode: 'patch',
                value: { folder: true, excerpt: '' },
                state: 'queued',
            } as OverlayItem,
        ];
        const shown = withPageWrites(pages, overlays);
        expect(shown.find((page) => page.id === 'handbook')).toMatchObject({
            folder: true,
            excerpt: '',
            waiting: true,
        });
    });
});

describe('the global search', () => {
    const base = { chats: [], socios: [], role: 'member' as const, now: D };
    const spaces = [{ id: 'ops', name: 'Ops', description: null, private: false, accessibilityLabel: 'Ops' }];
    const isFolderHere = (spaceId: string, pageId: string) =>
        spaceId === 'ops' && (pageId === 'plans' || pageId === 'archive');

    it('drops a folder only its hidden body matched, and shows one its title matched with no snippet', () => {
        const byBody = searchView({
            ...base,
            query: SECRET,
            spaces,
            server: answered(SECRET.toLowerCase(), [hit('plans', 'Plans'), hit('handbook', 'Handbook', 'how we work')]),
            isFolder: isFolderHere,
        });
        const items = byBody.sections.flatMap((section) => section.items);
        expect(items.map((item) => item.key)).toEqual(['page-handbook']);
        const byTitle = searchView({
            ...base,
            query: 'archive',
            spaces,
            server: answered('archive', [hit('archive', 'Archive')]),
            isFolder: isFolderHere,
        });
        const archive = byTitle.sections
            .flatMap((section) => section.items)
            .find((item) => item.key === 'page-archive');
        expect(archive).toMatchObject({ subtitleLines: 1 });
        expect((archive as { subtitle: string }).subtitle).toMatch(/^Ops · Folder · /);
        expect(json(byTitle)).not.toContain(SECRET);
    });
});

describe('the radar', () => {
    it('shows no excerpt of a folder, even an older copy’s', () => {
        const entry = (id: string, title: string, excerpt: string) => ({
            id,
            title,
            excerpt,
            updatedAt: D,
            revisions: 0,
            spaceId: 'ops',
            parentId: null,
            revision: 2,
            createdAt: D,
        });
        const radar = {
            total: 2,
            staleDays: 30,
            recent: [entry('plans', 'Plans', `${SECRET} excerpt`), entry('handbook', 'Handbook', 'How we work')],
            open: [{ ...entry('plans', 'Plans', `${SECRET} decision`), markers: ['decision'] }],
            stale: [{ ...entry('plans', 'Plans', `${SECRET}`), ageDays: 40 }],
        } as unknown as SpaceRadar;
        const view = radarView(radar, new Set(['plans']));
        expect(json(view)).not.toContain(SECRET);
        expect(view.sections[0]!.rows.map((row) => row.excerpt)).toEqual([null, 'How we work']);
    });
});

describe('the folder view (the page reader)', () => {
    it('lists what it holds and never its body or excerpt, even when the phone holds the body', () => {
        const view = pageView(pages, 'ops', 'plans', body('plans'))!;
        expect(view).toMatchObject({ folder: true, content: null, excerpt: '', keptText: true, foldersKnown: true });
        expect(view.children.map((child) => [child.id, child.folder])).toEqual([
            ['q1', false],
            ['q2', false],
            ['archive', true],
        ]);
        expect(json(view)).not.toContain(SECRET);
        expect([IN_THIS_FOLDER, FOLDER_EMPTY, FOLDER_KEPT_TEXT]).toEqual([
            'In this folder',
            'This folder is empty.',
            'This folder keeps its page text. Turn it back into a page to see it.',
        ]);
    });

    it('offline with no body, a folder shows neither the excerpt nor the body line', () => {
        const view = pageView(pages, 'ops', 'plans', null)!;
        expect(view).toMatchObject({ folder: true, content: null, excerpt: '', keptText: false });
        expect(json(view)).not.toContain(SECRET);
    });

    it('the newer copy says whether it is one, and a toggle waiting on the phone wins over both', () => {
        // Turned back into a page elsewhere: the list's newer summary says so, and the body shows again.
        const back = pages.map((page) => (page.id === 'plans' ? { ...page, folder: false, revision: 3 } : page));
        expect(pageView(back, 'ops', 'plans', body('plans', { revision: 3, folder: false }))).toMatchObject({
            folder: false,
            content: `${SECRET} in the kept body`,
        });
        // A newer body that is a folder hides the text even while the list is behind.
        const behind = pages.map((page) => (page.id === 'plans' ? { ...page, folder: false } : page));
        expect(pageView(behind, 'ops', 'plans', body('plans', { revision: 5 }))).toMatchObject({
            folder: true,
            content: null,
        });
        // Turned into a page on this phone, offline: the person's own kept text shows at once.
        expect(pageView(pages, 'ops', 'plans', body('plans'), null, false)).toMatchObject({ folder: false });
        // Turned into a folder on this phone: hidden at once.
        expect(pageView(pages, 'ops', 'handbook', body('handbook', { folder: false }), null, true)).toMatchObject({
            folder: true,
            content: null,
            excerpt: '',
        });
    });

    it('a copy from a server before folders is a page and offers no toggle', () => {
        const legacy = pages.map(({ folder: _, ...page }) => page as PageSummary);
        const { folder: _, ...old } = body('handbook', { content: 'Plain' });
        const view = pageView(legacy, 'ops', 'handbook', old as Page)!;
        expect(view).toMatchObject({ folder: false, foldersKnown: false, content: 'Plain' });
        expect(readerBar(view).more).toEqual([]);
    });

    it('the bar: a folder has no Edit and no Ask (they read the body), New page and New folder, and Turn into page', () => {
        expect(readerBar({ folder: true, foldersKnown: true })).toEqual({
            edit: false,
            ask: false,
            add: [NEW_PAGE_ACTION, NEW_FOLDER_ACTION],
            more: [TURN_INTO_PAGE],
        });
        expect(readerBar({ folder: false, foldersKnown: true })).toEqual({
            edit: true,
            ask: true,
            add: [],
            more: [TURN_INTO_FOLDER],
        });
        expect(TURN_INTO_FOLDER.label).toBe('Turn into folder');
        expect(TURN_INTO_PAGE.label).toBe('Turn into page');
    });

    it('a conflict on a folder has no Compare: theirs is the hidden body', () => {
        const conflict = {
            id: 'c1',
            pageId: 'plans',
            spaceId: 'ops',
            mine: { title: 'Plans', content: 'Mine' },
            theirs: { spaceId: 'ops', title: 'Plans', content: SECRET, revision: 3 },
            payload: {} as PageConflict['payload'],
            createdAt: 1,
        } satisfies PageConflict;
        expect(conflictBanner([conflict])?.canCompare).toBe(true);
        expect(conflictBanner([conflict], true)?.canCompare).toBe(false);
    });
});

describe('the page menus', () => {
    it('offer the web’s toggle once the server sends the mark, beside Move and the cover', () => {
        const shown = withPageWrites(pages, []);
        const plans = shown.find((page) => page.id === 'plans')!;
        const handbook = shown.find((page) => page.id === 'handbook')!;
        expect(pageMenu(plans, false).map((action) => action.name)).toEqual(['move', 'set-cover', 'turn-into-page']);
        expect(pageMenu(handbook, true).map((action) => action.name)).toEqual([
            'move',
            'set-cover',
            'turn-into-folder',
            'delete',
        ]);
        const { folder: _, ...legacy } = handbook;
        expect(folderToggle(legacy)).toBeNull();
        expect(pageMenu(legacy as typeof handbook, false).map((action) => action.name)).toEqual(['move', 'set-cover']);
    });

    it('New folder shows once a page carries the mark, or in an empty Space', () => {
        expect(offersFolders(pages)).toBe(true);
        expect(offersFolders([])).toBe(true);
        const { folder: _, ...legacy } = pages[5]!;
        expect(offersFolders([legacy])).toBe(false);
    });

    it('say a refused toggle and a refused New folder in words, in the library and the Unsent list', () => {
        const unsent: UnsentWrite[] = [
            {
                id: 'w1',
                kind: PAGE_FOLDER_KIND,
                lane: 'page:handbook',
                dependsOn: null,
                payload: json({ spaceId: 'ops', pageId: 'handbook', folder: true, revision: 2 }),
                payloadVersion: 1,
                reason: 'page-refused',
                createdAt: 1,
            },
            {
                id: 'local-page-1',
                kind: 'page-create',
                lane: 'page:local-page-1',
                dependsOn: null,
                payload: json({
                    spaceId: 'ops',
                    pageId: 'local-page-1',
                    title: 'Later',
                    content: '',
                    parentId: null,
                    createdBy: 'u-ada',
                    serverAt: null,
                    known: [],
                    folder: true,
                }),
                payloadVersion: 1,
                reason: 'page-invalid',
                createdAt: 2,
            },
        ];
        const library = pagesNotSaved(unsent, pages, 'ops', () => null);
        expect(library.map((item) => item.text.split('.')[0])).toEqual([
            'Couldn’t turn “Handbook” into a folder',
            'Couldn’t create the folder “Later”',
        ]);
        const list = unsentListRows(unsent, [], {
            chatTitle: () => null,
            resolve: () => null,
            spaceName: () => 'Ops',
            pageTitle: (_space, id) => pages.find((page) => page.id === id)?.title ?? null,
        });
        expect(list.map((row) => row.what)).toEqual(['Turn “Handbook” into a folder', 'New folder “Later”']);
    });
});
