import { joinPath } from '../data';
import type { WorkspaceLayout } from '../data/layout';
import { prepareFilesFolder, type WorkspaceFilesDeps } from '../data/workspace-files';
import type { AuthedFetch } from '../net/authed-fetch';

// The files the Media file page opens (CB-558): a file's bytes, downloaded
// through the scope's authedFetch (the workspace's origin only, its cookie, no
// redirect) into the workspace's `files/` (iOS `complete`), never through a
// browser. The page previews, shares and saves that copy.
// - Each file sits in a folder of its own, `files/<key>.<stamp>/<name>`, under
//   its own name (made safe as a file name), so the system's preview, share
//   sheet and save panel show the name the person knows.
// - The key says what it is and which version: an item's id and `updatedAt`
//   (a file can be replaced under its id), an attachment's id (its bytes never
//   change), an issue attachment's id.
// - Written as `<key>.<stamp>.part/` and renamed once whole, so a kill
//   mid-write leaves a part folder the next launch deletes.
// - Bounded at 300 MB, the oldest dropped first; a file over 100 MB is never
//   downloaded. Clear cache and the sign-out wipe delete the folder.
// No React Native: src/platform/media-files.ts binds the file operations, and
// tests/sync runs this under Node.

/** The cache's bound. */
export const FILE_CACHE_MAX_BYTES = 300 * 1024 * 1024;
/** A file larger than this is never downloaded to open. */
export const FILE_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export interface FileCacheFiles {
    list(path: string): Promise<string[]>;
    /** Removes a file, or a folder with what it holds. */
    remove(path: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    /** A file's size in bytes, 0 when it isn't there. */
    size(path: string): Promise<number>;
    /** Writes `bytes` to a new file at `path`, whose directory exists. */
    write(path: string, bytes: Uint8Array): Promise<void>;
    /** Renames a folder beside itself, replacing what `to` held. */
    move(from: string, to: string): Promise<void>;
}

export interface FileCacheOptions {
    readonly fetch: AuthedFetch;
    readonly files: FileCacheFiles;
    readonly layout: WorkspaceLayout;
    readonly setFileProtection: WorkspaceFilesDeps['setFileProtection'];
    /** The scope's: once aborted (sign-out, Clear cache), no download writes anything. */
    readonly signal?: AbortSignal;
    readonly maxBytes?: number;
    readonly maxFileBytes?: number;
    readonly now?: () => number;
    readonly onError?: (error: unknown) => void;
}

/** What to download: its key, where its bytes are on the workspace, and its name. */
export interface FileSource {
    /** Letters, digits, `_` and `-`; anything else is dropped. */
    readonly key: string;
    /** The path on the workspace (`/api/media/items/<id>/content`). */
    readonly url: string;
    readonly name: string;
    /** Its size when known, so one too large is refused before any request. */
    readonly size?: number;
}

/** What a file's load came to: its copy, gone from the server, too large to open here, or not now. */
export type FileLoad =
    | { readonly state: 'ready'; readonly path: string; readonly bytes: number }
    | { readonly state: 'gone' }
    | { readonly state: 'too-large' }
    | { readonly state: 'failed' };

export interface FileCache {
    /** The copy held for a key, or null; synchronous once the cache has read its folder. */
    path(key: string): string | null;
    /** The file: from the folder, else downloaded once (calls in flight share it). */
    load(source: FileSource): Promise<FileLoad>;
}

interface Entry {
    readonly key: string;
    /** The entry's folder name, `<key>.<stamp>`. */
    readonly folder: string;
    /** The file's name inside it. */
    readonly name: string;
    readonly bytes: number;
    readonly stamp: number;
}

const cleanKey = (key: string) => key.replace(/[^A-Za-z0-9_-]/g, '');

/** `<key>.<stamp>`: the stamp (base 36) orders the eviction across launches. */
const FOLDER = /^([A-Za-z0-9_-]+)\.([0-9a-z]+)$/;

/** A download being written; never a cache entry (`FOLDER` doesn't match it). */
const PART = '.part';

const NAME_MAX = 120;

/**
 * A name safe as one path segment that other apps will read: no separators or control characters,
 * no leading dots, at most 120 characters with the extension kept; `file` when nothing is left.
 */
export function safeFileName(name: string): string {
    const base = (name.split(/[\\/]/).pop() ?? '')
        // oxlint-disable-next-line no-control-regex -- control characters are what goes
        .replace(/[\u0000-\u001f\u007f:*?"<>|]/g, '-')
        .replace(/^\.+/, '')
        .trim();
    if (base === '') {
        return 'file';
    }
    if (base.length <= NAME_MAX) {
        return base;
    }
    const dot = base.lastIndexOf('.');
    const extension = dot > 0 && base.length - dot <= 12 ? base.slice(dot) : '';
    return `${base.slice(0, NAME_MAX - extension.length)}${extension}`;
}

export function createFileCache(options: FileCacheOptions): FileCache {
    const { fetch, files, layout, setFileProtection, signal } = options;
    const {
        maxBytes = FILE_CACHE_MAX_BYTES,
        maxFileBytes = FILE_MAX_DOWNLOAD_BYTES,
        now = Date.now,
        onError = () => {},
    } = options;
    const stopped = () => signal?.aborted === true;
    const entries = new Map<string, Entry>();
    const loading = new Map<string, Promise<FileLoad>>();
    let lastStamp = 0;
    let total = 0;
    let indexed: Promise<void> | null = null;
    let ready = false;

    const pathOf = (entry: Entry) => joinPath(joinPath(layout.files, entry.folder), entry.name);

    /** Reads the folder once: what an earlier launch kept, and anything it can't name goes. */
    const index = () =>
        (indexed ??= (async () => {
            const folders = await files.list(layout.files).catch(() => [] as string[]);
            for (const folder of folders) {
                const match = FOLDER.exec(folder);
                const path = joinPath(layout.files, folder);
                // A partial write (`.part`), or something no build of this cache wrote.
                const names = match === null ? [] : await files.list(path).catch(() => [] as string[]);
                const name = names.length === 1 ? names[0] : undefined;
                if (match === null || name === undefined) {
                    await files.remove(path).catch(onError);
                    continue;
                }
                const key = match[1]!;
                const stamp = Number.parseInt(match[2]!, 36);
                const known = entries.get(key);
                if (known !== undefined && known.stamp >= stamp) {
                    await files.remove(path).catch(onError);
                    continue;
                }
                if (known !== undefined) {
                    total -= known.bytes;
                    await files.remove(joinPath(layout.files, known.folder)).catch(onError);
                }
                const bytes = await files.size(joinPath(path, name)).catch(() => 0);
                entries.set(key, { key, folder, name, bytes, stamp });
                total += bytes;
                lastStamp = Math.max(lastStamp, stamp);
            }
            ready = true;
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
            await files.remove(joinPath(layout.files, entry.folder)).catch(onError);
        }
    }

    async function download(source: FileSource, key: string): Promise<FileLoad> {
        if (stopped()) {
            return { state: 'failed' };
        }
        if (source.size !== undefined && source.size > maxFileBytes) {
            return { state: 'too-large' };
        }
        let response: Response;
        try {
            response = await fetch(source.url, signal === undefined ? {} : { signal });
        } catch {
            return { state: 'failed' };
        }
        if (response.status === 404 || response.status === 410) {
            await response.body?.cancel().catch(() => {});
            return { state: 'gone' };
        }
        const length = Number(response.headers.get('content-length') ?? '0');
        if (!response.ok || length > maxFileBytes) {
            await response.body?.cancel().catch(() => {});
            return { state: response.ok ? 'too-large' : 'failed' };
        }
        let bytes: Uint8Array;
        try {
            bytes = new Uint8Array(await response.arrayBuffer());
        } catch {
            return { state: 'failed' };
        }
        if (stopped()) {
            return { state: 'failed' };
        }
        if (bytes.byteLength > maxFileBytes) {
            return { state: 'too-large' };
        }
        const stamp = Math.max(now(), lastStamp + 1);
        lastStamp = stamp;
        const folder = `${key}.${stamp.toString(36)}`;
        const name = safeFileName(source.name);
        const whole = joinPath(layout.files, folder);
        // Written in a folder the index never takes, then renamed: a kill mid-write leaves
        // `<folder>.part`, which the next launch deletes, never a file cut short.
        const part = `${whole}${PART}`;
        try {
            await prepareFilesFolder({ fs: files, setFileProtection }, layout);
            if (stopped()) {
                return { state: 'failed' };
            }
            await files.remove(part).catch(() => {});
            await files.mkdir(part);
            await files.write(joinPath(part, name), bytes);
            if (stopped()) {
                await files.remove(part).catch(() => {});
                return { state: 'failed' };
            }
            await files.move(part, whole);
        } catch (error) {
            onError(error);
            await files.remove(part).catch(() => {});
            await files.remove(whole).catch(() => {});
            return { state: 'failed' };
        }
        if (stopped()) {
            // Closed during the write: the copy goes with the folder's wipe.
            await files.remove(whole).catch(() => {});
            return { state: 'failed' };
        }
        const entry: Entry = { key, folder, name, bytes: bytes.byteLength, stamp };
        entries.set(key, entry);
        total += bytes.byteLength;
        await evict(key);
        return { state: 'ready', path: pathOf(entry), bytes: entry.bytes };
    }

    return {
        path(key) {
            if (!ready) {
                void index();
                return null;
            }
            const entry = entries.get(cleanKey(key));
            return entry === undefined ? null : pathOf(entry);
        },
        load(source) {
            const key = cleanKey(source.key);
            if (key === '') {
                return Promise.resolve({ state: 'failed' });
            }
            const going = loading.get(key);
            if (going !== undefined) {
                return going;
            }
            const next = (async (): Promise<FileLoad> => {
                await index();
                const entry = entries.get(key);
                if (entry !== undefined) {
                    return { state: 'ready', path: pathOf(entry), bytes: entry.bytes };
                }
                return download(source, key);
            })().finally(() => loading.delete(key));
            loading.set(key, next);
            return next;
        },
    };
}
