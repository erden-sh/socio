/**
 * What other features may know of pages: tags and plain types, importing
 * only `effect`, `@socio/*`, other contracts, and `import type` from the
 * allowlist.
 * `pages/layer.ts` implements it; only the composition root and tests
 * import that.
 *
 * The page types other folders name were added here, with a tag for each
 * pages service the composition holds or another folder
 * calls: `PageStore` (the workspace's `Pages`), `PageConversations`
 * (`LegacyPages`) and `PageTools` (the socio's page tools). The pure
 * helpers other folders import moved to packages: `PageError` and
 * `insertBlock` to `@socio/foundation/pages/*`, `pageText`, `textSnippet`
 * and `percentile` to `@socio/shared/pages/*`. Pages reads no
 * `PlatformConfig` field, so there is no `PagesConfig`.
 */
import type { ToolDefinition } from '@copilotkit/runtime/v2';
import { Context } from 'effect';

import type { DotTurn } from '@socio/foundation/turns/turn';
import type { ThreadFollower } from '@socio/shared/auth';
import type {
    Page,
    PageCover,
    PageLibrary,
    PageSummary,
    PageTitle,
    PageTreeItem,
    ReviewedPage,
} from '@socio/shared/pages/page-library';
import type { SpaceRadar } from '@socio/shared/pages/page-radar';
import type { PageReviewDraft } from '@socio/shared/pages/page-review';
import type { PageRevisionStats, PageSearchResult, SearchStatsView } from '@socio/shared/pages/page-search';
import type { RunRefRecorder } from '@socio/shared/runs/run-refs';
import type { SpacePageItem } from '@socio/shared/spaces/space-items';
import type { Conversation } from '@socio/shared/types';

import type { ApprovalOutcome } from '../approvals/contract.js';
import type { DataSpaceShape } from '../dataspace/contract.js';
import type { MediaEmbedsShape } from '../media/contract.js';

export type { Page, ReviewedPage };

// ---- Page moves (step 2) --------------------------------------------------

/** What a move did: the page where it is now, and every page that went. */
export interface PageMove {
    page: Page;
    /** The Space it left. */
    from: string;
    /** The page's id first, then its subpages' (they go with it). */
    moved: string[];
}

export interface PageMoveInput {
    /** The Space the page is in now. */
    spaceId: string;
    id: string;
    /** The Space it goes to. */
    to: string;
    /** Its parent there; null (the default) puts it at the Space's root. */
    parentId?: string | null;
    /** When given, the page must still be at this revision (409 if not). */
    expectedRevision?: number;
    now?: number;
    /**
     * A picture's embed (an `image` fence's id, CB-358) or a link card's
     * media (an `embed` fence's `media[].id`, CB-362) as a copy in the
     * Space the page goes to, the way a cover is copied: the copy's id, or
     * undefined to leave that fence as it was. The pages are parsed before
     * the move's unit of work opens; this is called inside it, so the
     * copies and the rewritten text commit with it. A page that may hold
     * pictures and changed in between fails the move (409, `page_changed`).
     * None: the text moves unchanged.
     */
    copyImage?: (embedId: string) => Promise<string | undefined>;
    /**
     * The mover's rights, checked again inside the move's unit of work
     * before it writes (they were checked before planning, which yields):
     * throws as the first check did when they were taken away meanwhile.
     */
    recheck?: () => void;
}

/**
 * Moving pages between Spaces (CB-142). A page keeps its id, so its
 * revisions, conversations, review receipts and freshness stay with it,
 * and an old `/spaces/<old>/pages/<id>` link finds it again (`locate`).
 * Promise-based, as before: the store's checks throw `PageError`.
 */
export interface PageMovesShape {
    readonly move: (input: PageMoveInput) => Promise<PageMove>;
    /** The live Space a live page is in now, or undefined. */
    readonly locate: (id: string) => Promise<string | undefined>;
}

/**
 * Page moves, built once by the composition root instead of by
 * `WorkspaceStore`; features reach them through the root's `PageMoves` tag,
 * typed by this contract.
 */
export class PageMoves extends Context.Service<PageMoves, PageMovesShape>()('socio/pages/PageMoves') {}

// ---- Pages, tags, links and revisions (moved from pages.ts) -----------------

/** The fixed vocabulary of typed page-to-page edges (CB-328). */
export const PAGE_LINK_KINDS = ['index', 'derived_from', 'cites', 'related'] as const;
export type PageLinkKind = (typeof PAGE_LINK_KINDS)[number];

/** A tag on a page (CB-328). Tag names are workspace-global; rows are scoped
 * to a Space for visibility, which `pageAccess` still gates. */
export interface PageTag {
    pageId: string;
    spaceId: string;
    tag: string;
    createdBy: string | null;
    createdAt: number;
}

/** A typed, directed edge between two pages (CB-328). Cross-Space: both
 * endpoints' Space ids are stored so an edge can span Spaces. */
export interface PageLink {
    id: string;
    fromPageId: string;
    toPageId: string;
    fromSpaceId: string;
    toSpaceId: string;
    kind: PageLinkKind;
    createdBy: string | null;
    createdAt: number;
}

/** A kept earlier state of a page (`page_revisions`). */
export interface PageRevision {
    id: number;
    pageId: string;
    spaceId: string;
    /** The page's revision number of this state. */
    revision: number;
    title: string;
    /** The page's stored Markdown then (stored compressed: `revisionBody`). */
    body: string;
    /** Who made the edit that replaced it: a user id or `dot:<id>`. */
    authorId: string | null;
    /** When this state was saved (the page's `updatedAt` then). */
    createdAt: number;
    /** When the edit by `authorId` replaced it. */
    replacedAt: number;
}

/** A cover as a page shows it, from its media embed's id (`Pages.useCovers`). */
export type CoverView = (id: string) => PageCover | null;

/** A new page, as `pageInput` (pages.ts) takes it before its defaults. */
export interface PageInput {
    title: string;
    content?: string;
    parentId?: string | null;
    sourceUrl?: string;
    sourceTitle?: string;
}

/** An edit, as `pagePatch` (pages.ts) takes it. */
export interface PagePatch {
    title?: string;
    content?: string;
    parentId?: string | null;
    expectedRevision: number;
}

/** A page search (moved from page-search.ts). */
export interface SearchOptions {
    query: string;
    /** The Spaces the caller may read. */
    spaces: readonly string[];
    limit?: number;
    offset?: number;
    /** Don't correct misspelt words ("Search instead for …"). */
    exact?: boolean;
    now?: number;
}

/** Search timing and page-use retention, in days (operations' policy). */
export interface PageSearchRetention {
    pageUseDays: number;
    pageSearchDays: number;
}

/** One end of a typed page link. */
export interface PageRef {
    spaceId: string;
    pageId: string;
}

/**
 * The workspace's pages store (`Pages`, held as `WorkspaceStore.pages`):
 * the slice the composition root and other folders call.
 * Space access is the caller's to check; the store checks the Space
 * exists and the page is live, and throws `PageError`.
 */
export interface PageStoreShape {
    readonly get: (spaceId: string, id: string) => Page;
    readonly list: (spaceId: string) => Page[];
    readonly titles: (spaceId: string, now?: number) => PageTitle[];
    readonly tree: (spaceId: string) => PageTreeItem[];
    /** The Space's live pages as its items list shows them (CB-451), in `tree`'s order. */
    readonly items: (spaceId: string) => SpacePageItem[];
    /** The latest edited pages of a Space, and how many it has. */
    readonly recent: (spaceId: string, limit: number) => { pages: Page[]; total: number };
    /** Whether any live page of a Space shows a cover. */
    readonly hasCovers: (spaceId: string) => boolean;
    /**
     * Of `ids`, the media embeds some page names (CB-524): any page, live or
     * deleted, in its text, a kept revision or as its cover, so the clean-up
     * of Space uploads never removes one a page or a restore would show.
     * `revisions: false` reads the pages only (a quick re-check).
     */
    readonly embedsNamed: (ids: readonly string[], options?: { revisions?: boolean }) => Set<string>;
    readonly radar: (
        spaceId: string,
        options?: { rootId?: string | null; staleDays?: number; now?: number },
    ) => SpaceRadar;
    readonly search: (options: SearchOptions) => PageSearchResult;
    /** The search timing rollup and index sizes (operators). */
    readonly searchStats: (days?: number) => SearchStatsView;
    readonly revisionStats: () => PageRevisionStats;
    /** Writes pending search timings (at shutdown). */
    readonly flushSearchStats: () => void;
    readonly noteUse: (spaceId: string, id: string, userId: string, now?: number) => Promise<boolean>;
    readonly canEdit: (userId: string, spaceId: string) => boolean;
    readonly create: (
        spaceId: string,
        input: PageInput,
        sourceThreadId?: string | null,
        createdBy?: string | null,
    ) => Promise<Page>;
    readonly createReviewed: (
        spaceId: string,
        input: Pick<PageReviewDraft, 'title' | 'content'>,
        threadId: string,
        toolCallId: string,
        createdBy?: string | null,
    ) => Promise<ReviewedPage>;
    readonly reviewReceipt: (
        threadId: string,
        toolCallId: string,
    ) => { pageId: string; spaceId: string; draft: PageReviewDraft | null } | null;
    readonly update: (
        spaceId: string,
        id: string,
        input: PagePatch,
        options?: { by?: string | null; now?: number },
    ) => Promise<Page>;
    readonly setCover: (
        spaceId: string,
        id: string,
        coverId: string | null,
        now?: number,
    ) => Promise<{ page: Page; previous: string | null }>;
    readonly delete: (
        spaceId: string,
        id: string,
        options?: { subpages?: boolean; allowed?: (page: Page) => boolean; by?: string | null },
    ) => Promise<{ deleted: string[] }>;
    // Page conversations.
    readonly thread: (
        pageId: string,
        dotId: string,
        userId: string,
    ) => { threadId: string; ready: boolean } | undefined;
    readonly reserveThread: (pageId: string, dotId: string, userId: string, threadId: string) => Promise<boolean>;
    readonly finishThread: (pageId: string, dotId: string, userId: string) => Promise<void>;
    readonly releaseThread: (pageId: string, dotId: string, userId: string) => Promise<void>;
    readonly forThread: (threadId: string, spaceId?: string) => Page | undefined;
    // Tags and links (CB-328).
    readonly tagPage: (spaceId: string, pageId: string, tag: string, by?: string | null) => Promise<PageTag>;
    readonly untagPage: (spaceId: string, pageId: string, tag: string) => Promise<boolean>;
    readonly pagesByTag: (tag: string, spaces: readonly string[]) => { id: string; spaceId: string; title: string }[];
    readonly linkPages: (from: PageRef, to: PageRef, kind: PageLinkKind, by?: string | null) => Promise<PageLink>;
    readonly unlinkPages: (from: PageRef, to: PageRef, kind: PageLinkKind, by?: string | null) => Promise<boolean>;
    readonly linksFrom: (spaceId: string, pageId: string) => PageLink[];
    readonly linksTo: (spaceId: string, pageId: string) => PageLink[];
    // Set once by the composition root.
    /** How covers are shown (the media module, CB-308). */
    readonly useCovers: (view: CoverView) => void;
    readonly setSearchRetention: (retention: () => PageSearchRetention) => void;
    /**
     * Told, inside the transaction, when pages leave a Space (deleted, or
     * moved to another): the data space moves the datasets placed under
     * them to `parentId` (CB-451).
     */
    readonly usePagesGone: (gone: PagesGone) => void;
    /** Tells the listener `usePagesGone` set (page moves, `SqlitePageMoves`). */
    readonly pagesGone: PagesGone;
}

/** Pages that left `spaceId`; what sat under them goes to `parentId` (a live page, or the root). */
export type PagesGone = (spaceId: string, pageIds: readonly string[], parentId: string | null) => void;

/**
 * The workspace's pages store (`WorkspaceStore.pages` today; `Pages`
 * implements the shape).
 */
export class PageStore extends Context.Service<PageStore, PageStoreShape>()('socio/pages/PageStore') {}

// ---- Page conversations (LegacyPages) -----------------------------------------

/** A person's conversations with a socio about a page (`PageService`). */
export interface PageConversationsShape {
    /** The user's conversation about a page with a socio, created on first use. */
    readonly conversation: (spaceId: string, pageId: string, dotId: string, userId: string) => Promise<Conversation>;
    /** Saves a conversation's text as a new page. */
    readonly saveConversation: (threadId: string, title: string, parentId: string | null) => Promise<Page>;
}

export class PageConversations extends Context.Service<PageConversations, PageConversationsShape>()(
    'socio/pages/PageConversations',
) {}

// ---- A socio's page tools (page-tools.ts) -------------------------------------

/** A turn's page access: whose chat, and what it records (`pageAccess`). */
export interface PageAccessInput {
    /** The socio's own Space: the default for page calls. */
    spaceId: string;
    threadId: string;
    /** Throws once the turn is stopped. */
    check: () => void;
    /**
     * The person whose page reads count toward freshness; null for turns
     * nobody is waiting on. Left out: the chat's owner.
     */
    usedBy?: string | null;
    /** Where the turn records what grounded it (CB-194). */
    ref?: RunRefRecorder;
    /** Page moves; left out where nothing moves pages (`move` then refuses). */
    moves?: PageMovesShape;
    /**
     * What a move copies its pages' media embeds with (media's cover
     * contract, CB-362); without it `move` refuses too, so no page moves
     * with its media left behind in the old Space.
     */
    media?: Pick<MediaEmbedsShape, 'coverFromEmbed' | 'copyEmbedToSpace'>;
}

/** A page as a socio sees it: with its path. */
export type LinkedPage = Page & { url: string };

/**
 * The page calls other folders make through a turn's access (link
 * unfurling), each checked against the Spaces the socio may read.
 */
export interface PageAccessShape {
    /** The chat's page, while this socio may read its Space. */
    readonly context: () => Page | undefined;
    /** The Space a page call with `requested` would use, checked. */
    readonly space: (requested?: string) => string;
    readonly read: (id: string, requested?: string) => Promise<LinkedPage>;
    readonly create: (input: PageInput, requested?: string) => Promise<LinkedPage>;
    readonly edit: (id: string, input: PagePatch, requested?: string) => Promise<LinkedPage>;
    readonly tag: (id: string, tag: string, requested?: string) => Promise<PageTag>;
    readonly link: (
        from: { spaceId?: string; pageId: string },
        to: { spaceId?: string; pageId: string },
        kind: PageLinkKind,
    ) => Promise<PageLink>;
}

/** What `create_space` asks of the Spaces (`SpaceCreation.propose`). */
export interface SpaceProposals {
    readonly propose: (
        turn: { userId: string; dotId: string; threadId: string },
        input: { name: string; description?: string; visibility?: 'private' | 'workspace' },
    ) => Promise<ApprovalOutcome & { usableHere: boolean; note?: string }>;
}

/**
 * A socio's page tools, which the spaces and data modules offer and link
 * unfurling uses: `pageAccess`, `pageTools`, `createSpaceTool` and
 * `datasetViewTools` over the workspace (`WorkspacePageTools`).
 */
export interface PageToolsShape {
    readonly access: (input: PageAccessInput) => PageAccessShape;
    /** The page tools every socio has (list, search, read, create, edit, ...). */
    readonly tools: (input: PageAccessInput) => ToolDefinition[];
    /** `create_space`: a new Space, on the person's approval (CB-271). */
    readonly createSpace: (creation: SpaceProposals, turn: DotTurn) => ToolDefinition;
    /** `insert_dataset_view`: a live view of a dataset in a page. */
    readonly datasetViews: (data: DataSpaceShape, turn: DotTurn) => ToolDefinition[];
}

export class PageTools extends Context.Service<PageTools, PageToolsShape>()('socio/pages/PageTools') {}

// ---- The page views (once live/views/pages.ts) -----------------------------

/**
 * The change counters the page views' version reads (`spacePagesVersion`):
 * live's `Counters` satisfies it. Declared here so `pages/` doesn't import
 * `live/`, which sits above it in the folder order.
 */
export interface PageCountersShape {
    /** `key=n` for each key, in the order given; 0 for one never bumped. */
    read(keys: readonly string[]): string;
}

export class PageCounters extends Context.Service<PageCounters, PageCountersShape>()('socio/pages/PageCounters') {}

/** A page search as `GET /api/spaces/search` takes it. */
export interface PageSearchQuery {
    q: string;
    space?: string;
    limit?: number;
    offset?: number;
    exact?: boolean;
}

/**
 * The page views, for the viewer: the routes and page loaders answer with
 * them. Each checks the viewer may read the Space (CB-181) and throws
 * `PageError` or `SpaceAccessError` (404) when not.
 */
export interface PagesViewsShape {
    /** `GET /api/spaces/:id/pages`: every live page of the Space, with excerpts. */
    readonly spacePagesView: (viewer: string, spaceId: string) => PageSummary[];
    /** `GET /api/spaces/:id/pages?bodies=false`: the library's first screen. */
    readonly spaceLibraryView: (
        viewer: string,
        spaceId: string,
        options: { limit: number; include?: string },
    ) => PageLibrary;
    /** `GET /api/pages/titles`: every readable live page's title (the ⌘K palette). */
    readonly pageTitlesView: (viewer: string) => PageTitle[];
    /** `GET /api/spaces/search`. */
    readonly pageSearchView: (viewer: string, query: PageSearchQuery) => PageSearchResult;
    /** `GET /api/spaces/:id/page-tree`: the sidebar's page tree. */
    readonly pageTreeView: (viewer: string, spaceId: string) => PageTreeItem[];
    /** `GET /api/spaces/:id/radar`: the Space's change radar (CB-282). */
    readonly spaceRadarView: (
        viewer: string,
        spaceId: string,
        options?: { rootId?: string; staleDays?: number },
    ) => SpaceRadar;
    /** The version of a Space's pages views (`conditionalJson`): the same for everyone. */
    readonly spacePagesVersion: (spaceId: string) => string;
}

export class PagesViews extends Context.Service<PagesViews, PagesViewsShape>()('socio/pages/PagesViews') {}

/**
 * A moved conversation's page link (CB-360's transfer): it becomes the new
 * owner's page chat, or is dropped where they have one for that page and
 * socio already. `infra/sqlite/ownership.ts` implements it.
 */
export type PageThreadOwnershipShape = ThreadFollower;
