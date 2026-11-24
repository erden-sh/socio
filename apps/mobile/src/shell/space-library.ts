import { compareText, dateTimeFormat } from '@socio/shared/locale';
import { pageHierarchy } from '@socio/shared/pages/page-hierarchy';
import type { PageSummary } from '@socio/shared/pages/page-library';
import { foldText, freshnessLabel } from '@socio/shared/pages/page-search';
import type { Space } from '@socio/shared/types';

import type { ServerSearchState } from '../sync/server-search';

import { OFFLINE_LINE, WAITING_LINE } from './search';

// A Space's library, read-only:
// its pages by most recent change, as the web's library lists them
// (`SpaceLibrary.tsx`: newest first, then by title; the excerpt, else "An
// empty page, ready to write."; "Edited <date>" and the parent pages' trail),
// with each page's cover, and the same pages as a tree from shared's
// `pageHierarchy`, which the person expands and collapses; and its page search
// (`librarySearch`). No React Native, so tests/shell runs it under Node.

/** The web's line for a page with no text yet. */
export const EMPTY_PAGE = 'An empty page, ready to write.';
/** The web's title for a page whose title is blank. */
export const UNTITLED_PAGE = 'Untitled page';

/** The two ways the library shows a Space's pages. */
export type LibraryView = 'recent' | 'tree';

export const LIBRARY_VIEWS: readonly {
    readonly id: LibraryView;
    readonly label: string;
}[] = [
    { id: 'recent', label: 'Recent' },
    { id: 'tree', label: 'All pages' },
];

/** The Space as its header names it: its name, and whether it is private. */
export interface SpaceHeading {
    readonly name: string;
    readonly description: string | null;
    readonly private: boolean;
    /** The line under the big title: "Private" and the description; null with neither. */
    readonly subtitle: string | null;
}

/** The Space's heading, or null while the workspace doesn't list it (not yet, or no longer). */
export function spaceHeading(spaces: readonly Space[], spaceId: string): SpaceHeading | null {
    const space = spaces.find((item) => item.id === spaceId);
    if (space === undefined) {
        return null;
    }
    const description =
        typeof space.description === 'string' && space.description.trim() !== '' ? space.description : null;
    const isPrivate = space.private === true;
    const subtitle = [isPrivate ? 'Private' : null, description].filter(Boolean).join(' · ') || null;
    return { name: space.name, description, private: isPrivate, subtitle };
}

/**
 * A Space's first line, which the Spaces tile leads (`intro`): its heading's line ("Private" and the
 * description), else its pages counted, so the tile never sits alone.
 */
export const spaceIntro = (heading: SpaceHeading | null, pages: number): string =>
    heading?.subtitle ?? pageCount(pages);

/**
 * Whether the Space is gone for the person (deleted, or their access removed):
 * the workspace has answered (`listed`) and doesn't list it. Before that answer
 * the library waits; it never says "gone" for a Space not yet listed.
 */
export const spaceUnavailable = (spaces: readonly Space[], spaceId: string, listed: boolean): boolean =>
    listed && spaceHeading(spaces, spaceId) === null;

/** What the library says of a Space the person lost. */
export const SPACE_UNAVAILABLE = 'This Space isn’t available';

const titleOf = (page: Pick<PageSummary, 'title'>) => page.title.trim() || UNTITLED_PAGE;

/** A page row's badge, said after its title, while a save of it waits as a conflict. */
export const CHANGED_ELSEWHERE = 'Changed elsewhere';
const NO_CONFLICTS: ReadonlySet<string> = new Set();

const editedDate = dateTimeFormat({ month: 'short', day: 'numeric' });

/** One page in the Recent view. */
export interface RecentPageRow {
    readonly id: string;
    readonly title: string;
    /** The excerpt, else the web's empty-page line. */
    readonly excerpt: string;
    /** "Edited Nov 8". */
    readonly edited: string;
    /** The parent pages, root first, joined by " › "; null for a top-level page. */
    readonly trail: string | null;
    /** The cover's media embed id, or null without one. */
    readonly coverId: string | null;
    /** A new cover's upload (its local id) while it goes up: the phone's copy shows. */
    readonly coverUpload: string | null;
    /** A write of this phone waits for the server (the page writes' overlays). */
    readonly waiting: boolean;
    /** A save of it waits as a conflict: the row's badge. */
    readonly conflict: boolean;
    readonly accessibilityLabel: string;
}

/** A page as the library takes it: a summary, with this phone's pending writes said. */
export type LibraryPage = PageSummary & {
    readonly waiting?: boolean;
    readonly coverUpload?: string | null;
};

/** A row with a write of this phone waiting. */
export const WAITING = 'Waiting to send';

/** The order of the web's "Recently edited": newest change first, then by title. */
const byRecent = (a: PageSummary, b: PageSummary) => b.updatedAt - a.updatedAt || compareText(a.title, b.title);

/**
 * The Space's pages by most recent change. `pages` may hold another Space's
 * rows: they are left out. `conflicted` holds the pages with a conflict.
 */
export function recentPages(
    pages: readonly LibraryPage[],
    spaceId: string,
    conflicted: ReadonlySet<string> = NO_CONFLICTS,
): RecentPageRow[] {
    const own = pages.filter((page) => page.spaceId === spaceId);
    const hierarchy = pageHierarchy(own, spaceId);
    return own.sort(byRecent).map((page) => {
        const title = titleOf(page);
        const parents = hierarchy.ancestors(page).map(titleOf);
        const trail = parents.length > 0 ? parents.join(' › ') : null;
        const edited = `Edited ${editedDate.format(page.updatedAt)}`;
        const excerpt = page.excerpt.trim() === '' ? EMPTY_PAGE : page.excerpt;
        const conflict = conflicted.has(page.id);
        return {
            id: page.id,
            title,
            excerpt,
            edited,
            trail,
            coverId: page.cover?.id ?? null,
            coverUpload: page.coverUpload ?? null,
            waiting: page.waiting === true,
            conflict,
            accessibilityLabel: [
                title,
                conflict ? CHANGED_ELSEWHERE : null,
                trail === null ? null : `in ${trail}`,
                edited,
                page.waiting === true ? WAITING : null,
            ]
                .filter(Boolean)
                .join(', '),
        };
    });
}

/** One visible row of the tree: a page at its depth, with whether it has subpages and shows them. */
export interface TreeRow {
    readonly id: string;
    readonly title: string;
    /** 0 for a top-level page. */
    readonly depth: number;
    /** How many direct subpages it has. */
    readonly children: number;
    /** Its subpages show (only when it has some). */
    readonly expanded: boolean;
    /** A save of it waits as a conflict: the row's badge. */
    readonly conflict: boolean;
    readonly accessibilityLabel: string;
}

const byTitle = (a: PageSummary, b: PageSummary) => compareText(titleOf(a), titleOf(b)) || (a.id < b.id ? -1 : 1);

/**
 * The Space's pages as a tree, flattened to the rows that show: top-level
 * pages by title, each expanded one followed by its subpages, by title. A page
 * whose parent the phone doesn't hold (not listed, another Space's) shows at
 * the top, and so does any page a broken trail (a cycle) would hide: every
 * page of the Space shows somewhere once its parents are expanded.
 */
export function pageTree(
    pages: readonly PageSummary[],
    spaceId: string,
    expanded: ReadonlySet<string>,
    conflicted: ReadonlySet<string> = NO_CONFLICTS,
): TreeRow[] {
    const own = pages.filter((page) => page.spaceId === spaceId).sort(byTitle);
    const hierarchy = pageHierarchy(own, spaceId);
    const ids = new Set(own.map((page) => page.id));
    const reached = new Set<string>();
    const reach = (page: PageSummary) => {
        if (reached.has(page.id)) {
            return;
        }
        reached.add(page.id);
        for (const child of hierarchy.children(page) as PageSummary[]) {
            reach(child);
        }
    };
    const roots = own.filter((page) => page.parentId === null || !ids.has(page.parentId));
    roots.forEach(reach);
    for (const page of own) {
        if (!reached.has(page.id)) {
            roots.push(page);
            reach(page);
        }
    }
    roots.sort(byTitle);

    const rows: TreeRow[] = [];
    const shown = new Set<string>();
    const add = (page: PageSummary, depth: number) => {
        if (shown.has(page.id)) {
            return;
        }
        shown.add(page.id);
        const children = (hierarchy.children(page) as PageSummary[]).filter((child) => !roots.includes(child));
        const open = children.length > 0 && expanded.has(page.id);
        const title = titleOf(page);
        const count = children.length === 1 ? '1 subpage' : `${children.length} subpages`;
        const conflict = conflicted.has(page.id);
        rows.push({
            id: page.id,
            title,
            depth,
            children: children.length,
            expanded: open,
            conflict,
            accessibilityLabel: [title, conflict ? CHANGED_ELSEWHERE : null, children.length > 0 ? count : null]
                .filter(Boolean)
                .join(', '),
        });
        if (open) {
            for (const child of children) {
                add(child, depth + 1);
            }
        }
    };
    for (const root of roots) {
        add(root, 0);
    }
    return rows;
}

/** `expanded` with `id` flipped. */
export function toggleExpanded(expanded: ReadonlySet<string>, id: string): ReadonlySet<string> {
    const next = new Set(expanded);
    if (!next.delete(id)) {
        next.add(id);
    }
    return next;
}

/** "3 pages". */
export const pageCount = (n: number) => `${n} ${n === 1 ? 'page' : 'pages'}`;

/** The web's path of a page: the reader's Edit opens it until the native page editor. */
export const pagePath = (spaceId: string, pageId: string) =>
    `/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}`;

// ----- Page search (the web's SpaceLibrary search) -----

/** The library's search field: its label for screen readers and its placeholder, the web's words. */
export const PAGE_SEARCH_LABEL = 'Search pages';
/** The section of the server's matches in the pages' text the phone's titles and excerpts missed. */
export const IN_PAGE_TEXT = 'In page text';

/** A page the server found by its text (`/api/spaces/search` scoped to the Space). */
export interface PageTextRow {
    readonly id: string;
    readonly title: string;
    /** The text around the match, plain. */
    readonly snippet: string;
    /** "Edited Nov 8", or when it was last used: shared's freshness. */
    readonly fresh: string;
    readonly accessibilityLabel: string;
}

export interface LibrarySearchView {
    /** Whether anything is typed: the library shows the matches in place of its views. */
    readonly searching: boolean;
    /** The pages the phone holds whose title or excerpt hold the query, in Recent's order. */
    readonly local: readonly RecentPageRow[];
    /** The server's matches the local ones don't show. */
    readonly text: readonly PageTextRow[];
    /** "Searching page text needs a connection", "Searching pages…", or null. */
    readonly line: string | null;
    /** "Nothing matches “…”." once nothing matched and nothing more is coming. */
    readonly empty: string | null;
    /** The count heading over the matches: "2 pages". */
    readonly count: string;
}

/** The pages whose title or excerpt hold `query`, folded as the palette folds (case, accents, spacing). */
export function pageMatches(
    pages: readonly Pick<PageSummary, 'id' | 'title' | 'excerpt'>[],
    query: string,
): Set<string> {
    const folded = foldText(query);
    return new Set(
        pages.filter((page) => foldText(`${page.title} ${page.excerpt ?? ''}`).includes(folded)).map((page) => page.id),
    );
}

/**
 * What the library shows for a search: the phone's pages filtered by title and excerpt (`rows` is
 * Recent's, `pages` what they came from), then, from two characters online, the server's matches
 * in the Space's page text (`server`, server-search.ts with the Space's filter) that aren't among
 * them. Offline it filters what it holds and says the text search needs a connection.
 */
export function librarySearch(input: {
    readonly query: string;
    readonly spaceId: string;
    readonly rows: readonly RecentPageRow[];
    readonly pages: readonly Pick<PageSummary, 'id' | 'title' | 'excerpt'>[];
    readonly server: ServerSearchState;
    readonly now?: number;
}): LibrarySearchView {
    const folded = foldText(input.query);
    if (folded === '') {
        return { searching: false, local: [], text: [], line: null, empty: null, count: pageCount(input.rows.length) };
    }
    const ids = pageMatches(input.pages, input.query);
    const local = input.rows.filter((row) => ids.has(row.id));
    const { server } = input;
    const answer = server.status === 'done' && server.answer.query === folded ? server.answer.pages : null;
    const shown = new Set(local.map((row) => row.id));
    const titles = new Map(input.rows.map((row) => [row.id, row.title]));
    const text = (answer?.results ?? [])
        .filter((hit) => hit.spaceId === input.spaceId && !shown.has(hit.id))
        .map((hit): PageTextRow => {
            const title = titles.get(hit.id) ?? (hit.title.trim() || UNTITLED_PAGE);
            const snippet = hit.snippet
                .map((part) => part.text)
                .join('')
                .replace(/\s+/g, ' ')
                .trim();
            const fresh = freshnessLabel(hit.freshness, input.now);
            return {
                id: hit.id,
                title,
                snippet,
                fresh,
                accessibilityLabel: [title, fresh, snippet].filter((part) => part !== '').join(', '),
            };
        });
    const waiting = server.status === 'waiting' && server.query === folded;
    const offline = server.status === 'offline' && server.query === folded;
    const line = offline ? OFFLINE_LINE : waiting ? WAITING_LINE : null;
    const total = local.length + text.length;
    return {
        searching: true,
        local,
        text,
        line,
        empty: total === 0 && !waiting ? `Nothing matches “${input.query.trim()}”.` : null,
        count: pageCount(total),
    };
}
