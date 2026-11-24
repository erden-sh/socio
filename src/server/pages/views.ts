import { PageError } from '@socio/foundation/pages/page-error';
import {
    pageSummary,
    type PageLibrary,
    type PageSummary,
    type PageTitle,
    type PageTreeItem,
} from '@socio/shared/pages/page-library';
import type { SpaceRadar } from '@socio/shared/pages/page-radar';
import type { PageSearchResult } from '@socio/shared/pages/page-search';
import {
    SPACE_ITEMS_SCHEMA,
    spaceItemTree,
    spaceItemVersion,
    type SpaceItem,
    type SpaceItemsResponse,
} from '@socio/shared/spaces/space-items';

import type { DataSpaceShape } from '../dataspace/contract.js';
import type { SpaceAccessShape } from '../spaces/contract.js';

import type { PageCountersShape, PageSearchQuery, PagesViewsShape, PageStoreShape } from './contract.js';

/**
 * The page views: moved from the now-deleted `live/views/pages.ts` (the
 * pages read them through the `PagesViews` tag), and the Space's pages
 * version from `live/view-versions.ts`. Each takes what it reads, not the
 * platform.
 */
export interface PageViewSources {
    readonly spaceAccess: Pick<SpaceAccessShape, 'require' | 'readable'>;
    readonly pages: Pick<
        PageStoreShape,
        'list' | 'recent' | 'get' | 'hasCovers' | 'titles' | 'search' | 'tree' | 'radar' | 'items'
    >;
    readonly counters: PageCountersShape;
}

/**
 * `GET /api/spaces/:id/pages`: every live page of the Space, in its list's
 * order, with an excerpt instead of its body (CB-71); an open page reads
 * its body from `GET /api/spaces/:id/pages/:page`. A deleted or unknown
 * Space, or one the viewer may not read (CB-181), is a 404.
 */
export function spacePagesView(source: PageViewSources, viewer: string, spaceId: string): PageSummary[] {
    source.spaceAccess.require(spaceId, viewer);
    return source.pages.list(spaceId).map(pageSummary);
}

/**
 * `GET /api/spaces/:id/pages?bodies=false`: the library's first screen,
 * the `limit` most recently edited live pages without their bodies, and
 * `include` (the open page) as well when it is a live page of the Space.
 * A Space the viewer may not read is a 404 (CB-181).
 */
export function spaceLibraryView(
    source: PageViewSources,
    viewer: string,
    spaceId: string,
    { limit, include }: { limit: number; include?: string },
): PageLibrary {
    source.spaceAccess.require(spaceId, viewer);
    const { pages: store } = source;
    const { pages, total } = store.recent(spaceId, limit);
    if (include && !pages.some((page) => page.id === include)) {
        try {
            pages.push(store.get(spaceId, include));
        } catch (error) {
            // Deleted or not in this Space: the page view says so itself.
            if (!(error instanceof PageError)) {
                throw error;
            }
        }
    }
    return {
        spaceId,
        pages: pages.map(pageSummary),
        total,
        hasCovers: store.hasCovers(spaceId),
    };
}

/**
 * `GET /api/pages/titles`: every live page of every live Space the viewer
 * may read (CB-181), id, Space and title only, Space by Space in the
 * workspace's order and each Space's pages in its list's order: the ⌘K
 * palette's page search.
 */
export function pageTitlesView(source: PageViewSources, viewer: string): PageTitle[] {
    return source.spaceAccess.readable({ userId: viewer }).flatMap((space) => source.pages.titles(space.id));
}

/**
 * `GET /api/spaces/search`: live pages whose title or text matches `q`,
 * in every live Space the viewer may read (CB-181), or in `space` alone
 * (a deleted, unknown or unreadable one is a 404, as everywhere). A
 * Dot's search (`search_space_pages`) passes the Spaces it may read in
 * its chat to the same store method.
 */
export function pageSearchView(source: PageViewSources, viewer: string, query: PageSearchQuery): PageSearchResult {
    const spaces = source.spaceAccess.readable({ userId: viewer }).map((space) => space.id);
    if (query.space !== undefined && !spaces.includes(query.space)) {
        throw new PageError('Space not found.', 404);
    }
    return source.pages.search({
        query: query.q,
        spaces: query.space === undefined ? spaces : [query.space],
        limit: query.limit,
        offset: query.offset,
        exact: query.exact,
    });
}

/**
 * `GET /api/spaces/:id/page-tree`: the Space's live pages, id, parent and
 * title only, in its list's order: the sidebar's page tree. A deleted,
 * unknown or unreadable Space (CB-181) is a 404.
 */
export function pageTreeView(source: PageViewSources, viewer: string, spaceId: string): PageTreeItem[] {
    source.spaceAccess.require(spaceId, viewer);
    return source.pages.tree(spaceId);
}

/**
 * `GET /api/spaces/:id/items` (CB-451): the Space's live
 * pages and the datasets placed in it, in tree order. A dataset sits under
 * a live page of the Space or at its root; one whose page is gone reads as
 * a root item, never dropped. The same for every reader; a deleted,
 * unknown or unreadable Space is a 404, as the page tree is.
 */
export function spaceItemsView(
    source: Pick<PageViewSources, 'spaceAccess' | 'pages'> & {
        readonly data: Pick<DataSpaceShape, 'spaceDatasetItems'>;
    },
    viewer: string,
    spaceId: string,
): SpaceItemsResponse {
    source.spaceAccess.require(spaceId, viewer);
    const pages = source.pages.items(spaceId);
    const live = new Set(pages.map((page) => page.id));
    const datasets = source.data.spaceDatasetItems(viewer, spaceId).map((item) => {
        if (item.parentId === null || live.has(item.parentId)) {
            return item;
        }
        // Its page is gone: at the root, and so a new version.
        const moved = { ...item, parentId: null };
        return { ...moved, version: spaceItemVersion(moved) };
    });
    return { schema: SPACE_ITEMS_SCHEMA, spaceId, items: spaceItemTree<SpaceItem>([...pages, ...datasets]) };
}

/**
 * The items list's version (CB-451): the Space's pages, the datasets in it
 * (`space-data:<spaceId>`), who reads it, and the socios' and plugins'
 * names its dataset items show.
 */
export const spaceItemsVersion = (source: Pick<PageViewSources, 'counters'>, spaceId: string) =>
    source.counters.read(['spaces', `pages:${spaceId}`, `space-data:${spaceId}`, 'dots', 'plugins']);

/**
 * `GET /api/spaces/:id/radar`: the Space's change radar (CB-282). Recent
 * changes, open decision/experiment markers, and stale pages, computed
 * from existing page and revision data. A deleted, unknown or unreadable
 * Space (CB-181) is a 404, as the page-tree and pages views are. `rootId`
 * narrows the scope to a page and its descendants; `staleDays` overrides
 * the default threshold.
 */
export function spaceRadarView(
    source: PageViewSources,
    viewer: string,
    spaceId: string,
    options: { rootId?: string; staleDays?: number } = {},
): SpaceRadar {
    source.spaceAccess.require(spaceId, viewer);
    return source.pages.radar(spaceId, options);
}

/**
 * `GET /api/spaces/:id/pages` (both forms) and `/page-tree`: the Space's
 * pages, and the Spaces (a deleted one is a 404). The same for everyone.
 */
export const spacePagesVersion = (source: Pick<PageViewSources, 'counters'>, spaceId: string) =>
    source.counters.read(['spaces', `pages:${spaceId}`]);

/** The page views over their sources, as the `PagesViews` tag offers them. */
export function pagesViews(source: PageViewSources): PagesViewsShape {
    return {
        spacePagesView: (viewer, spaceId) => spacePagesView(source, viewer, spaceId),
        spaceLibraryView: (viewer, spaceId, options) => spaceLibraryView(source, viewer, spaceId, options),
        pageTitlesView: (viewer) => pageTitlesView(source, viewer),
        pageSearchView: (viewer, query) => pageSearchView(source, viewer, query),
        pageTreeView: (viewer, spaceId) => pageTreeView(source, viewer, spaceId),
        spaceRadarView: (viewer, spaceId, options) => spaceRadarView(source, viewer, spaceId, options),
        spacePagesVersion: (spaceId) => spacePagesVersion(source, spaceId),
    };
}
