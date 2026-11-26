import { attachmentContentUrl, mediaContentUrl } from '@socio/shared/media-types';
import { coverUrl } from '@socio/shared/pages/page-library';

import { joinPath } from '../data';
import type { WorkspaceLayout } from '../data/layout';
import { prepareImagesFolder, type WorkspaceFilesDeps } from '../data/workspace-files';
import type { AuthedFetch } from '../net/authed-fetch';

// The app's own image cache: the
// pictures a transcript shows by reference, downloaded through the scope's
// authedFetch (the workspace's origin only, its cookie, no redirect) into
// the workspace's `images/` (iOS `complete`), and shown from there as
// `file://` with expo-image's `cachePolicy: 'memory'`. expo-image's own disk
// cache never holds them. Keyed by the attachment's id plus its version (an
// attachment's bytes never change: version 0), bounded at 500 MB with the
// oldest dropped first. Clear cache and the sign-out wipe delete the folder.
// No React Native: src/platform/image-cache.ts binds the file operations, and
// tests/sync runs this under Node.

/** The cache's bound. */
export const IMAGE_CACHE_MAX_BYTES = 500 * 1024 * 1024;
/** A picture larger than this is never kept (the server's file limit). */
export const IMAGE_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export interface ImageCacheFiles {
    list(path: string): Promise<string[]>;
    remove(path: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    /** A file's size in bytes, 0 when it isn't there. */
    size(path: string): Promise<number>;
    /** Writes `bytes` to a new file at `path`, whose directory exists. */
    write(path: string, bytes: Uint8Array): Promise<void>;
    /** Renames a file in the same folder, replacing what `to` held. */
    move(from: string, to: string): Promise<void>;
}

export interface ImageCacheOptions {
    readonly fetch: AuthedFetch;
    readonly files: ImageCacheFiles;
    readonly layout: WorkspaceLayout;
    readonly setFileProtection: WorkspaceFilesDeps['setFileProtection'];
    /**
     * The scope's: once aborted (sign-out, Clear cache), no download writes
     * anything, so a wiped folder is never made again.
     */
    readonly signal?: AbortSignal;
    readonly maxBytes?: number;
    readonly now?: () => number;
    readonly onError?: (error: unknown) => void;
}

/**
 * What a picture is: an attachment (a chat's, by `cbatt_` id), a media embed
 * (a page's cover, `/api/media/embeds/<id>/content`), an issue's
 * attachment (`/api/issue-attachments/<id>`), or a file of the person's Media
 * library (`/api/media/items/<id>/content`, CB-558). The first three are
 * immutable by id, so version 0; a library file can be replaced under its id,
 * so its version is its `updatedAt`. Each kind has its own path on the workspace.
 */
export type ImageKind = 'attachment' | 'embed' | 'issue' | 'media';

const KEY_PREFIX: Readonly<Record<ImageKind, string>> = {
    attachment: '',
    embed: 'embed-',
    issue: 'issue-',
    media: 'media-',
};

/** What a picture's load came to: its file, gone from the server, or not now (offline, refused). */
export type ImageLoad =
    | { readonly state: 'ready'; readonly path: string }
    | { readonly state: 'gone' }
    | { readonly state: 'failed' };

export interface ImageCache {
    /** The file held for an attachment, or null; synchronous once the cache has read its folder. */
    path(id: string, version?: number, kind?: ImageKind): string | null;
    /** The attachment's (or embed's) picture: from the folder, else downloaded once (calls in flight share it). */
    load(id: string, version?: number, kind?: ImageKind): Promise<ImageLoad>;
    /** Any picture added or dropped. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
}

interface Entry {
    readonly key: string;
    readonly name: string;
    readonly bytes: number;
    readonly stamp: number;
}

/**
 * A key safe as a file name: the attachment ids are `cbatt_` base64url, the rest is dropped. An
 * embed's key starts `embed-`, an issue file's `issue-` and a library file's `media-`, so none meets
 * an attachment's.
 */
const keyOf = (id: string, version: number, kind: ImageKind = 'attachment') =>
    `${KEY_PREFIX[kind]}${id.replace(/[^A-Za-z0-9_-]/g, '')}.${Math.max(0, Math.floor(version))}`;

/** The picture's path on the workspace: the cache reads nothing else. */
const urlOf = (id: string, kind: ImageKind) =>
    kind === 'embed'
        ? coverUrl(encodeURIComponent(id))
        : kind === 'issue'
          ? `/api/issue-attachments/${encodeURIComponent(id)}`
          : kind === 'media'
            ? mediaContentUrl(id)
            : attachmentContentUrl(id);

/** `<key>.<stamp>`: the stamp (base 36) orders the eviction across launches. */
const NAME = /^([A-Za-z0-9_-]+\.\d+)\.([0-9a-z]+)$/;

/** A download being written; never a cache entry (`NAME` doesn't match it). */
const PART = '.part';

const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp)\b/i;

export function createImageCache(options: ImageCacheOptions): ImageCache {
    const { fetch, files, layout, setFileProtection, signal } = options;
    const stopped = () => signal?.aborted === true;
    const { maxBytes = IMAGE_CACHE_MAX_BYTES, now = Date.now, onError = () => {} } = options;
    const entries = new Map<string, Entry>();
    const loading = new Map<string, Promise<ImageLoad>>();
    const listeners = new Set<() => void>();
    let lastStamp = 0;
    let total = 0;
    let indexed: Promise<void> | null = null;
    let ready = false;

    const emit = () => {
        for (const listener of listeners) {
            listener();
        }
    };

    /** Reads the folder once: what an earlier launch kept, and anything it can't name goes. */
    const index = () =>
        (indexed ??= (async () => {
            const names = await files.list(layout.images).catch(() => [] as string[]);
            for (const name of names) {
                const match = NAME.exec(name);
                const path = joinPath(layout.images, name);
                if (match === null) {
                    // A partial write (`.part`), or a file no build of this cache wrote.
                    await files.remove(path).catch(onError);
                    continue;
                }
                const key = match[1]!;
                const stamp = Number.parseInt(match[2]!, 36);
                const bytes = await files.size(path).catch(() => 0);
                const known = entries.get(key);
                if (bytes <= 0 || (known !== undefined && known.stamp >= stamp)) {
                    await files.remove(path).catch(onError);
                    continue;
                }
                if (known !== undefined) {
                    total -= known.bytes;
                    await files.remove(joinPath(layout.images, known.name)).catch(onError);
                }
                entries.set(key, { key, name, bytes, stamp });
                total += bytes;
                lastStamp = Math.max(lastStamp, stamp);
            }
            ready = true;
            emit();
        })());

    /** Drops the oldest until the folder is within its bound. */
    async function evict(keep: string) {
        const oldest = [...entries.values()].sort((a, b) => a.stamp - b.stamp);
        for (const entry of oldest) {
            if (total <= maxBytes) {
                break;
            }
            if (entry.key === keep) {
                continue;
            }
            entries.delete(entry.key);
            total -= entry.bytes;
            await files.remove(joinPath(layout.images, entry.name)).catch(onError);
        }
    }

    async function download(id: string, key: string, kind: ImageKind): Promise<ImageLoad> {
        if (stopped()) {
            return { state: 'failed' };
        }
        let response: Response;
        try {
            response = await fetch(urlOf(id, kind), signal === undefined ? {} : { signal });
        } catch {
            return { state: 'failed' };
        }
        if (response.status === 404 || response.status === 410) {
            await response.body?.cancel().catch(() => {});
            return { state: 'gone' };
        }
        const type = response.headers.get('content-type') ?? '';
        const length = Number(response.headers.get('content-length') ?? '0');
        if (!response.ok || !IMAGE_TYPE.test(type) || length > IMAGE_MAX_DOWNLOAD_BYTES) {
            await response.body?.cancel().catch(() => {});
            return { state: 'failed' };
        }
        let bytes: Uint8Array;
        try {
            bytes = new Uint8Array(await response.arrayBuffer());
        } catch {
            return { state: 'failed' };
        }
        if (stopped() || bytes.byteLength === 0 || bytes.byteLength > IMAGE_MAX_DOWNLOAD_BYTES) {
            return { state: 'failed' };
        }
        const stamp = Math.max(now(), lastStamp + 1);
        lastStamp = stamp;
        const name = `${key}.${stamp.toString(36)}`;
        const path = joinPath(layout.images, name);
        // Written under a name the index never takes, then renamed: a kill mid-write leaves
        // `<name>.part`, which the next launch deletes, never a picture cut short.
        const part = `${path}${PART}`;
        try {
            if (stopped()) {
                return { state: 'failed' };
            }
            await prepareImagesFolder({ fs: files, setFileProtection }, layout);
            if (stopped()) {
                return { state: 'failed' };
            }
            await files.write(part, bytes);
            if (stopped()) {
                await files.remove(part).catch(() => {});
                return { state: 'failed' };
            }
            await files.move(part, path);
        } catch (error) {
            onError(error);
            await files.remove(part).catch(() => {});
            await files.remove(path).catch(() => {});
            return { state: 'failed' };
        }
        if (stopped()) {
            // Closed during the write: the picture goes with the folder's wipe.
            await files.remove(path).catch(() => {});
            return { state: 'failed' };
        }
        entries.set(key, { key, name, bytes: bytes.byteLength, stamp });
        total += bytes.byteLength;
        await evict(key);
        emit();
        return { state: 'ready', path };
    }

    return {
        path(id, version = 0, kind = 'attachment') {
            if (!ready) {
                void index();
                return null;
            }
            const entry = entries.get(keyOf(id, version, kind));
            return entry === undefined ? null : joinPath(layout.images, entry.name);
        },
        load(id, version = 0, kind = 'attachment') {
            const key = keyOf(id, version, kind);
            const going = loading.get(key);
            if (going !== undefined) {
                return going;
            }
            const next = (async (): Promise<ImageLoad> => {
                await index();
                const entry = entries.get(key);
                if (entry !== undefined) {
                    return { state: 'ready', path: joinPath(layout.images, entry.name) };
                }
                return download(id, key, kind);
            })().finally(() => loading.delete(key));
            loading.set(key, next);
            return next;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
