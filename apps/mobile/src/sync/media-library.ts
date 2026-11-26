import type { AttachmentView, MediaItem, MediaKind, MediaListing } from '@socio/shared/media-types';

import type { SqlConnection } from '../data';
import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';

import { type BoundedItem, type BoundedKindDefinition, type BoundedStore, createBoundedStore } from './bounded-kind';
import { httpError, SnapshotShapeError } from './errors';

// The Media library (CB-558; the web's modules/media): the person's own files
// by folder, `GET /api/media`, through the workspace's authedFetch.
// - A folder's first page (by kind filter) is a bounded kind
//   (`media-listing`, keyed `<kind or all>/<folder>`): read as its screen holds
//   it (`use()`), so the last answer shows offline. Nothing polls it.
// - A search (`q`) and the pages after the first (`cursor`) are read online
//   only and never kept: `readMediaListing`.
// - One file's record (`readMediaItem`) and one attachment's
//   (`readAttachment`) are read online as the file page opens.
// - A chat attachment is a file in its sender's library, linked to the chat
//   (the server's media_attachments row: its owner, the file, the thread). The
//   library lists only the reader's own files, so someone else's attachment in
//   a room, or one whose file was deleted, has no item: `findAttachmentItem`
//   asks the library's folder for the attachment's path and takes only an item
//   that names this attachment, else null, and the file page shows the
//   attachment by its own id.
// No React Native: tests/sync runs it under Node.

export const MEDIA_PATH = '/api/media';

/** What a listing is asked for: the web's `MediaQuery`. */
export interface MediaQuery {
    /** '' for the root, else ending in `/`. */
    readonly folder: string;
    readonly q?: string;
    readonly kind?: MediaKind | '';
    readonly cursor?: string;
}

/** `/api/media` with the query's parts, as the web's `listMedia` builds it. */
export function mediaListingPath(query: MediaQuery): string {
    const parts: string[] = [];
    const add = (name: string, value: string | undefined) => {
        if (value !== undefined && value !== '') {
            parts.push(`${name}=${encodeURIComponent(value)}`);
        }
    };
    add('folder', query.folder);
    add('q', query.q?.trim());
    add('kind', query.kind);
    add('cursor', query.cursor);
    return parts.length === 0 ? MEDIA_PATH : `${MEDIA_PATH}?${parts.join('&')}`;
}

const isItem = (value: unknown): value is MediaItem => {
    const item = value as Partial<MediaItem> | null;
    return (
        item !== null &&
        typeof item === 'object' &&
        typeof item.id === 'string' &&
        typeof item.path === 'string' &&
        typeof item.name === 'string' &&
        typeof item.folder === 'string' &&
        typeof item.size === 'number' &&
        typeof item.mediaType === 'string' &&
        typeof item.kind === 'string' &&
        typeof item.updatedAt === 'number' &&
        Array.isArray(item.attachments)
    );
};

const isStrings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/** A 200's body as a listing. Throws SnapshotShapeError on anything else. */
export function parseMediaListing(path: string, body: unknown): MediaListing {
    const listing = body as Partial<MediaListing> | null;
    if (listing === null || typeof listing !== 'object' || typeof listing.folder !== 'string') {
        throw new SnapshotShapeError(path, 'no folder.');
    }
    if (!isStrings(listing.folders) || !isStrings(listing.tree)) {
        throw new SnapshotShapeError(path, 'no folders or tree.');
    }
    if (!Array.isArray(listing.items) || !listing.items.every(isItem)) {
        throw new SnapshotShapeError(path, 'no files.');
    }
    if (typeof listing.usage?.totalBytes !== 'number' || typeof listing.limits?.userMaxBytes !== 'number') {
        throw new SnapshotShapeError(path, 'no usage or limits.');
    }
    return listing as MediaListing;
}

/** One listing, read now and never kept: a search, or a page after the first. A refusal throws. */
export async function readMediaListing(
    fetch: AuthedFetch,
    query: MediaQuery,
    signal?: AbortSignal,
): Promise<MediaListing> {
    const path = mediaListingPath(query);
    const response = await fetch(path, signal === undefined ? {} : { signal });
    if (!response.ok) {
        throw await httpError(response, signal);
    }
    return parseMediaListing(path, await readJson(response, signal));
}

export const MEDIA_LISTINGS_KIND = 'media-listing';
/** Folders kept on disk at most. */
export const MEDIA_LISTINGS_KEPT = 60;
/** About how many characters of them are kept on disk at most. */
export const MEDIA_LISTINGS_CHARS = 4_000_000;

const KINDS: readonly string[] = ['image', 'text', 'pdf', 'file'];

/** A kept listing's key: the kind filter (`all` for none), then the folder. */
export const mediaListingKey = (folder: string, kind: MediaKind | '' = '') => `${kind === '' ? 'all' : kind}/${folder}`;

/** The folder and kind a key names, or null for one that isn't a listing's key. */
export function parseMediaListingKey(key: string): { folder: string; kind: MediaKind | '' } | null {
    const at = key.indexOf('/');
    if (at <= 0) {
        return null;
    }
    const kind = key.slice(0, at);
    const folder = key.slice(at + 1);
    if ((kind !== 'all' && !KINDS.includes(kind)) || (folder !== '' && !folder.endsWith('/'))) {
        return null;
    }
    return { folder, kind: kind === 'all' ? '' : (kind as MediaKind) };
}

/** A folder's first page, as `/api/media` answers it. */
export const MEDIA_LISTINGS: BoundedKindDefinition<MediaListing> = {
    name: MEDIA_LISTINGS_KIND,
    format: 1,
    bounds: { items: MEDIA_LISTINGS_KEPT, chars: MEDIA_LISTINGS_CHARS },
    path(key) {
        const parts = parseMediaListingKey(key);
        if (parts === null) {
            throw new TypeError(`${key} isn't a media listing's key.`);
        }
        return mediaListingPath(parts);
    },
    parse: parseMediaListing,
};

export type MediaListings = BoundedStore<MediaListing>;

export interface MediaListingsOptions {
    readonly db: SqlConnection;
    readonly fetch: AuthedFetch;
    readonly signal?: AbortSignal;
    readonly onError?: (error: unknown) => void;
    readonly now?: () => number;
}

/** Opens the scope's media listings on its cache.db. */
export function createMediaListings(options: MediaListingsOptions): MediaListings {
    return createBoundedStore<MediaListing>({
        ...options,
        definition: MEDIA_LISTINGS,
        // A key that isn't a listing's never reads the network.
        isLocal: (key) => parseMediaListingKey(key) === null,
    });
}

/** Folder `folder`'s first page under a kind filter; hold it with `use()` in the same turn. */
export const mediaListing = (
    listings: MediaListings,
    folder: string,
    kind: MediaKind | '' = '',
): BoundedItem<MediaListing> => listings.item(mediaListingKey(folder, kind));

export const mediaItemPath = (id: string) => `${MEDIA_PATH}/items/${encodeURIComponent(id)}`;
export const mediaAttachmentPath = (id: string) => `${MEDIA_PATH}/attachments/${encodeURIComponent(id)}`;

/** What a read of one record came to: it, or gone (a 404: deleted, or not the reader's to see). */
export type MediaRead<T> = { readonly state: 'there'; readonly value: T } | { readonly state: 'gone' };

async function readOne<T>(
    fetch: AuthedFetch,
    path: string,
    check: (body: unknown) => body is T,
    signal?: AbortSignal,
): Promise<MediaRead<T>> {
    const response = await fetch(path, signal === undefined ? {} : { signal });
    if (response.status === 404) {
        await response.body?.cancel().catch(() => {});
        return { state: 'gone' };
    }
    if (!response.ok) {
        throw await httpError(response, signal);
    }
    const body = await readJson(response, signal);
    if (!check(body)) {
        throw new SnapshotShapeError(path, 'not the record asked for.');
    }
    return { state: 'there', value: body };
}

/** One of the person's own files, `GET /api/media/items/:id`. */
export const readMediaItem = (fetch: AuthedFetch, id: string, signal?: AbortSignal) =>
    readOne(fetch, mediaItemPath(id), isItem, signal);

const isAttachment = (value: unknown): value is AttachmentView => {
    const view = value as Partial<AttachmentView> | null;
    return (
        view !== null &&
        typeof view === 'object' &&
        typeof view.id === 'string' &&
        typeof view.name === 'string' &&
        typeof view.mediaType === 'string' &&
        typeof view.size === 'number' &&
        typeof view.kind === 'string' &&
        typeof view.createdAt === 'number' &&
        (view.path === null || typeof view.path === 'string')
    );
};

/** A chat attachment the person may see (their own, or one posted in a chat they read), `GET /api/media/attachments/:id`. */
export const readAttachment = (fetch: AuthedFetch, id: string, signal?: AbortSignal) =>
    readOne(fetch, mediaAttachmentPath(id), isAttachment, signal);

/** `reports/q3/plan.pdf` → `reports/q3/`; '' for a file at the root. */
export const folderOfPath = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);

/**
 * The library item behind an attachment, or null when the library has none: someone else's file
 * (a room), or one that was deleted. Asks the attachment's folder for its stored name and takes
 * only an item at that path that names this attachment, so a file of the reader's own that
 * happens to sit at the same path is never taken for it.
 */
export async function findAttachmentItem(
    fetch: AuthedFetch,
    attachment: Pick<AttachmentView, 'id' | 'path'>,
    signal?: AbortSignal,
): Promise<MediaItem | null> {
    const { path } = attachment;
    if (path === null) {
        return null;
    }
    const folder = folderOfPath(path);
    const stored = path.slice(folder.length);
    if (stored === '' || stored.length > 200) {
        return null;
    }
    const listing = await readMediaListing(fetch, { folder, q: stored }, signal);
    return (
        listing.items.find(
            (item) => item.path === path && item.attachments.some((from) => from.id === attachment.id),
        ) ?? null
    );
}
