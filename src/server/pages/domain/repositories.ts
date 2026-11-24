/**
 * The Spaces pages context's repositories (CB-110): one per aggregate,
 * async, taking and returning plain domain types. Only `pages/infra`
 * implements them. Every write works inside or outside a unit of work:
 * outside one it opens its own.
 *
 * Wave 3 moved the writes here. The reads of `Pages` (`pages.ts`) stay
 * synchronous SQL for now: their callers (the workspace, chats, routes)
 * read them synchronously, and move with the workspace and chats contexts.
 */

/** A new page, at revision 1, last edited when it was made. */
export interface NewPage {
    id: string;
    spaceId: string;
    parentId: string | null;
    title: string;
    content: string;
    createdAt: number;
    sourceThreadId: string | null;
    createdBy: string | null;
    /** Where the page was imported from (a URL or Files path), or null (CB-328). */
    sourceUrl: string | null;
    /** The title at the source, or null (CB-328). */
    sourceTitle: string | null;
}

/** A tag on a page (CB-328). Tag names are workspace-global; rows are scoped
 * to a Space for visibility, which `pageAccess` still gates. */
export interface NewPageTag {
    pageId: string;
    spaceId: string;
    tag: string;
    createdBy: string | null;
    createdAt: number;
}

/** A typed, directed edge between two pages (CB-328). Cross-Space: both
 * endpoints' Space ids are stored so an edge can span Spaces. */
export interface NewPageLink {
    id: string;
    fromPageId: string;
    toPageId: string;
    fromSpaceId: string;
    toSpaceId: string;
    kind: 'index' | 'derived_from' | 'cites' | 'related';
    createdBy: string | null;
    createdAt: number;
}

/** What an edit sets (the rest of the row stays). */
export interface PageEdit {
    title: string;
    content: string;
    parentId: string | null;
}

/** Who deleted a page, and when; `with` names the page it went with. */
export interface PageDeletion {
    at: number;
    by: string | null;
    with: string | null;
}

/** Page: the Space's pages, hidden and kept once deleted (CB-64). */
export interface PageRepository {
    insert(page: NewPage): Promise<void>;
    /**
     * Saves an edit of the page at `revision` as the next revision, edited
     * `now`; nothing when it is no longer at `revision`.
     */
    edit(id: string, revision: number, edit: PageEdit, now: number): Promise<void>;
    /**
     * Moves a page to a Space and parent there, as its next revision
     * (CB-142); `content`, when given, is its text there (its pictures'
     * copies, CB-358).
     */
    move(id: string, spaceId: string, parentId: string | null, now: number, content?: string): Promise<void>;
    /**
     * Sets a live page's cover (CB-308) and its edit time, keeping its
     * revision: a cover isn't part of the page's text.
     */
    cover(id: string, coverId: string | null, now: number): Promise<void>;
    /** Hides a live page with its stamp; a deleted one stays as it was. */
    hide(id: string, deletion: PageDeletion): Promise<void>;
}

/** An earlier state of a page as stored (`revisionBody`). */
export interface StoredPageRevision {
    pageId: string;
    spaceId: string;
    revision: number;
    title: string;
    body: Uint8Array;
    encoding: 'br' | 'utf8';
    authorId: string | null;
    createdAt: number;
    replacedAt: number;
}

/** A page's kept revisions. */
export interface PageRevisionRepository {
    /** Who made the edit that kept the page's latest revision, and when. */
    latest(pageId: string): Promise<{ authorId: string | null; replacedAt: number } | undefined>;
    insert(revision: StoredPageRevision): Promise<void>;
}

/** A reviewed draft saved as a page, by the tool call that proposed it. */
export interface PageReviewReceipt {
    threadId: string;
    toolCallId: string;
    pageId: string;
    spaceId: string;
    /** The draft as saved, as JSON text. */
    draft: string;
}

export interface PageReviewRepository {
    insert(receipt: PageReviewReceipt): Promise<void>;
    /** A moved page's receipts open it where it is now (CB-142). */
    moveSpace(pageId: string, spaceId: string): Promise<void>;
}

/** A person's conversation about a page with a socio. */
export interface PageThreadKey {
    pageId: string;
    dotId: string;
    userId: string;
}

/** Page conversations: one per page, socio and person. */
export interface PageThreadRepository {
    /**
     * Keeps `threadId` for the conversation unless it has one, then leases
     * its creation until `leaseUntil` unless it is ready or another lease
     * runs past `now`. Whether this call holds the lease.
     */
    reserve(key: PageThreadKey, threadId: string, leaseUntil: number, now: number): Promise<boolean>;
    /** The conversation was made: it is ready. */
    finish(key: PageThreadKey): Promise<void>;
    /** Making it failed: a later call may lease it again. */
    release(key: PageThreadKey): Promise<void>;
    /** A deleted page's conversations stay as ordinary ones: the links go. */
    removeForPage(pageId: string): Promise<void>;
}

/** A live page's searchable text (`pageText`), in its Space. */
export interface PageSearchEntry {
    pageId: string;
    spaceId: string;
    title: string;
    body: string;
}

/**
 * The search index's rows: what the page search reads.
 * How it is searched is the store's (FTS5 on SQLite).
 */
export interface PageSearchIndex {
    /** Adds the page, or replaces its title and text. */
    put(entry: PageSearchEntry): Promise<void>;
    remove(pageId: string): Promise<void>;
    moveSpace(pageId: string, spaceId: string): Promise<void>;
}

/** A page's freshness from use. */
export interface StoredPageUse {
    score: number;
    scoredAt: number;
    usedAt: number;
}

/** Page use: the aggregate per page, and one use per person, page and day. */
export interface PageUseRepository {
    use(pageId: string): Promise<StoredPageUse | undefined>;
    put(pageId: string, use: StoredPageUse): Promise<void>;
    /** Counts the person's use of the page on `day`; false when it was. */
    addDay(pageId: string, userId: string, day: number): Promise<boolean>;
    /** Forgets the days before `day`. */
    pruneDaysBefore(day: number): Promise<void>;
    /** A deleted page's use goes (a restore starts from the edit date). */
    removeForPage(pageId: string): Promise<void>;
}

/** Page tags (CB-328): set and remove tags, and find pages by tag. */
export interface PageTagRepository {
    /** Sets a tag on a page (idempotent). */
    upsert(tag: NewPageTag): Promise<void>;
    /** Removes a tag from a page. Returns whether a row was removed. */
    remove(pageId: string, tag: string): Promise<boolean>;
}

/** Page links (CB-328): typed, directed, cross-Space edges. Soft-deleted. */
export interface PageLinkRepository {
    /** Creates an edge (idempotent on a live edge of the same kind). */
    upsert(link: NewPageLink): Promise<void>;
    /** Soft-deletes a live edge. Returns whether a row was removed. */
    remove(
        fromPageId: string,
        toPageId: string,
        kind: NewPageLink['kind'],
        at: number,
        by: string | null,
    ): Promise<boolean>;
}

export interface PageRepositories {
    pages: PageRepository;
    revisions: PageRevisionRepository;
    reviews: PageReviewRepository;
    threads: PageThreadRepository;
    search: PageSearchIndex;
    use: PageUseRepository;
    tags: PageTagRepository;
    links: PageLinkRepository;
}
