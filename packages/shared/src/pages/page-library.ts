import type { PageReviewDraft } from './page-review.js';
import type { Freshness } from './page-search.js';

/**
 * A page as the server stores and returns it. Client-safe: every field is
 * a primitive or a type already shared (`PageCover`). Moved here from
 * `server/pages/pages.ts` (CB-317) so the client no longer imports the type from
 * the server module.
 */
export interface Page {
    id: string;
    spaceId: string;
    parentId: string | null;
    title: string;
    content: string;
    revision: number;
    createdAt: number;
    updatedAt: number;
    sourceThreadId: string | null;
    /** Who created it (the person, or the owner of the Dot conversation that
     * did); null for pages from before it was recorded. */
    createdBy: string | null;
    /** Its cover (CB-308), or null without one. */
    cover: PageCover | null;
    /** Where the page was imported from (a URL or Files path), or null (CB-328). */
    sourceUrl: string | null;
    /** The title at the source, or null (CB-328). */
    sourceTitle: string | null;
    /**
     * A folder (CB-426): a page shown as a container of the pages inside
     * it. Its body is kept but hidden; turned back into a page, it shows.
     */
    folder: boolean;
}

/** A page saved through the review flow, with the draft that was reviewed. */
export type ReviewedPage = Page & {
    reviewDraft: PageReviewDraft | null;
};

/**
 * A page without its body, as the library lists it: every page of the
 * Space (`GET /api/spaces/:id/pages`, polled), or its first screen, what
 * the page loader returns (`GET /api/spaces/:id/pages?bodies=false`). The
 * first screen is the part a page load carries, so it stays small however
 * large the Space grows.
 */
export interface PageSummary {
    id: string;
    spaceId: string;
    parentId: string | null;
    title: string;
    /** The start of the page as the library's card shows it. */
    excerpt: string;
    revision: number;
    createdAt: number;
    updatedAt: number;
    sourceThreadId: string | null;
    createdBy: string | null;
    /** The page's cover (CB-308), or null without one. */
    cover: PageCover | null;
    /** A folder (CB-426): its body is hidden, so its excerpt is empty. */
    folder: boolean;
}

/**
 * A page's cover (CB-308): an image recorded as a media embed (CB-230),
 * so it is served to whoever may read the Space, by its own id.
 */
export interface PageCover {
    /** The media embed's id. */
    id: string;
    /** `/api/media/embeds/<id>/content`. */
    url: string;
}

/**
 * An image of a Space the cover picker offers ("From this Space",
 * `GET /api/spaces/:id/cover-images`): a link card's or a page cover's.
 */
export interface CoverImage {
    /** The media embed's id, which `PUT …/cover` takes as `embedId`. */
    id: string;
    url: string;
    name: string;
    mediaType: string;
    createdAt: number;
}

/** A page cover's largest image (CB-308): 5 MB. */
export const COVER_MAX_BYTES = 5 * 1048576;

/**
 * The image types the cover picker uploads (CB-308). The server takes any
 * image a model reads; the picker offers the three a cover is made of.
 */
export const COVER_UPLOAD_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];

/** Where a cover's image is served from. */
export const coverUrl = (id: string) => `/api/media/embeds/${id}/content`;

export interface PageLibrary {
    spaceId: string;
    /** The most recently edited pages, newest first. */
    pages: PageSummary[];
    /** How many live pages the Space has. */
    total: number;
    /**
     * Whether any live page of the Space has a cover, including pages past
     * the first screen: the library then shows a band on every card.
     */
    hasCovers: boolean;
}

/**
 * A live page as the ⌘K palette's page search has it
 * (`GET /api/pages/titles`): no body, no excerpt; its freshness line.
 */
export interface PageTitle {
    id: string;
    spaceId: string;
    title: string;
    freshness: Freshness;
}

/**
 * A live page as the sidebar's page tree has it
 * (`GET /api/spaces/:id/page-tree`): where it sits and its title.
 */
export interface PageTreeItem {
    id: string;
    parentId: string | null;
    title: string;
    /** A folder (CB-426). */
    folder: boolean;
}

/**
 * A folder as a socio is told about it (CB-426): its name and the pages
 * and folders directly inside it, by title. Never its body, which a
 * folder keeps but hides: nothing derived from it reaches a socio for
 * "this page" (the page chat's turns, the Ask panel).
 */
export interface FolderContext {
    id: string;
    spaceId: string;
    parentId: string | null;
    title: string;
    folder: true;
    revision: number;
    updatedAt: number;
    /** What it holds, in the tree's order. */
    pages: Array<{ id: string; title: string; folder: boolean }>;
}

/** The folder context of `page`, a folder, from its Space's page tree. */
export function folderContext(page: Page, tree: readonly PageTreeItem[]): FolderContext {
    return {
        id: page.id,
        spaceId: page.spaceId,
        parentId: page.parentId,
        title: page.title,
        folder: true,
        revision: page.revision,
        updatedAt: page.updatedAt,
        pages: tree.filter((item) => item.parentId === page.id).map(({ id, title, folder }) => ({ id, title, folder })),
    };
}

/**
 * A page as the library lists it (CB-71): its excerpt instead of its
 * body. The same on the server and in the browser, after a save.
 */
export function pageSummary({
    content,
    sourceUrl: _sourceUrl,
    sourceTitle: _sourceTitle,
    ...page
}: Omit<PageSummary, 'excerpt'> & {
    content: string;
    sourceUrl?: string | null;
    sourceTitle?: string | null;
}): PageSummary {
    // A folder's body is hidden (CB-426): no excerpt of it.
    return { ...page, excerpt: page.folder ? '' : pageExcerpt(content, page.title) };
}

/** How many pages the library's first screen carries. */
export const LIBRARY_FIRST_SCREEN = 60;

/** A page's body as one line of plain text, for the library's cards. */
export function pageExcerpt(content: string, title?: string) {
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    return withoutTitleLine(body, title)
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
        .replace(/```[\s\S]*?```/g, 'Code block')
        .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[#>*_`|~]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 150);
}

/** A line as plain words: no heading marks, emphasis or extra spaces. */
const plainLine = (line: string) =>
    line
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/[*_`~]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

/**
 * The body without its first line when that line only repeats the title
 * (often a `# Title` heading), so a card doesn't show the title twice
 * (CB-308).
 */
function withoutTitleLine(body: string, title: string | undefined) {
    const wanted = title && plainLine(title);
    if (!wanted) {
        return body;
    }
    const match = /^\s*([^\r\n]*)(?:\r?\n|$)/.exec(body);
    return match && plainLine(match[1]) === wanted ? body.slice(match[0].length) : body;
}
