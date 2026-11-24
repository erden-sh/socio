import type { Page } from '@socio/shared/pages/page-library';

import type { BoundedKindDefinition } from './bounded-kind';
import { SnapshotShapeError } from './errors';
import type { SnapshotDefinition } from './snapshot-cache';
import { keyed, list } from './snapshot-shape';

// A Space's pages, as the server
// gives them:
// - `pages`, a scoped snapshot kind: `GET /api/spaces/:id/pages` (every live
//   page of the Space with its excerpt, no bodies; conditionalJson, so a poll
//   with no change is a 304), one cache scope per Space (the Space's id), each
//   summary keyed by its page id and versioned by its `revision`;
// - `page-body`, a bounded kind (bounded-kind.ts) of
//   `GET /api/spaces/:spaceId/pages/:id`, keyed by the Space and the page
//   (`pageBodyKey`), versioned by its `revision`: the 200 most recently used on
//   disk, about 20 M characters, never one over 4 MB.
// The store that keeps both is page-store.ts.

export const PAGES = 'pages';
export const PAGE_BODIES_KIND = 'page-body';
/** How often a Space in view asks for its pages again (the web's open Space polls every 15 s). */
export const PAGES_POLL_MS = 15_000;
/** Page bodies kept on disk at most. */
export const PAGE_BODIES_KEPT = 200;
/** About how many characters of page bodies are kept on disk at most. */
export const PAGE_BODIES_CHARS = 20_000_000;

const PAGES_PATH = '/api/spaces/:id/pages';
const spacePath = (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}`;

/** `GET /api/spaces/:id/pages`: one Space's summaries by page id, versioned by revision. */
export const PAGES_SNAPSHOT: SnapshotDefinition = {
    id: PAGES,
    path: PAGES_PATH,
    scopedPath: (spaceId) => `${spacePath(spaceId)}/pages`,
    format: 1,
    feeds: [{ collection: PAGES }],
    split: (body) => [
        keyed(PAGES_PATH, list(PAGES_PATH, body, 'the body'), 'pages', { key: 'id', version: 'revision' }),
    ],
};

/** The bounded kind's key of a page's body: its Space and its id, each URI-encoded, joined by a slash. */
export const pageBodyKey = (spaceId: string, pageId: string) =>
    `${encodeURIComponent(spaceId)}/${encodeURIComponent(pageId)}`;

/** Every body key of Space `spaceId` starts with this. */
export const spaceBodyPrefix = (spaceId: string) => `${encodeURIComponent(spaceId)}/`;

/** The Space and page a body key names, or null for one that isn't a body key. */
export function parsePageBodyKey(key: string): { spaceId: string; pageId: string } | null {
    const at = key.indexOf('/');
    if (at <= 0 || at === key.length - 1 || key.indexOf('/', at + 1) !== -1) {
        return null;
    }
    try {
        return { spaceId: decodeURIComponent(key.slice(0, at)), pageId: decodeURIComponent(key.slice(at + 1)) };
    } catch {
        return null;
    }
}

function checkPage(path: string, body: unknown): Page {
    const page = body as Partial<Page> | null;
    if (!page || typeof page !== 'object' || Array.isArray(page)) {
        throw new SnapshotShapeError(path, 'no page.');
    }
    if (typeof page.id !== 'string' || typeof page.spaceId !== 'string' || typeof page.title !== 'string') {
        throw new SnapshotShapeError(path, 'a page without its id, Space or title.');
    }
    if (typeof page.content !== 'string' || typeof page.revision !== 'number') {
        throw new SnapshotShapeError(path, 'a page without its content or revision.');
    }
    return page as Page;
}

export const PAGE_BODIES: BoundedKindDefinition<Page> = {
    name: PAGE_BODIES_KIND,
    format: 1,
    bounds: { items: PAGE_BODIES_KEPT, chars: PAGE_BODIES_CHARS },
    path: (key) => {
        const parts = parsePageBodyKey(key);
        if (parts === null) {
            throw new TypeError(`"${key}" names no page.`);
        }
        return `${spacePath(parts.spaceId)}/pages/${encodeURIComponent(parts.pageId)}`;
    },
    parse: checkPage,
    version: (page) => page.revision,
};

/** Where a page lives now (`GET /api/pages/:id/location`): an old link to a moved page. */
export const pageLocationPath = (pageId: string) => `/api/pages/${encodeURIComponent(pageId)}/location`;

/**
 * The lanes of page `pageId`'s writes (page-save.ts, page-manage.ts: its saves, move and delete;
 * its cover). Its conflict lane (`page-conflict:`) holds only refused rows already.
 */
export const pageLanes = (pageId: string) => [`page:${pageId}`, `cover:${pageId}`];

const LANE = /^(?:page|cover|page-conflict):(.+)$/;

/** The page a lane's writes are for, or null for another kind's lane. */
export function pageOfLane(lane: string): string | null {
    return LANE.exec(lane)?.[1] ?? null;
}
