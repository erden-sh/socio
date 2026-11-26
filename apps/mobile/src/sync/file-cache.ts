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
//   sheet and save panel show the name the person knows. The name joins a
//   file:// root as one encoded path segment (`#`, `%`, `?` are a name's
//   letters there, never URL syntax).
// - The key says what it is: an item's id and `updatedAt`, an attachment's
//   id, an issue attachment's id. A file can be replaced under its id (an
//   attachment's too), so a copy is checked with the server when a page opens
//   it (`checkedSince`): If-None-Match with the ETag its download had (kept in
//   the folder as `.validator`, which no safe name can be), a 304 keeps it, a
//   200 replaces it, a 404 drops it. Offline, or on any other answer, the copy
//   is what the page has.
// - Written as `<key>.<stamp>.part/` and renamed once whole, so a kill
//   mid-write leaves a part folder the next launch deletes.
// - Bounded at 300 MB, the oldest dropped first, never one an open page holds
//   (`hold`); a file over 100 MB is never downloaded. A copy that is gone from
//   the disk all the same is downloaded again on its next load. Clear cache
//   and the sign-out wipe delete the folder.
// No React Native: src/platform/file-cache-files.ts binds the file operations,
// and tests/sync runs this under Node.

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
    /** Whether a file is there. */
    exists(path: string): Promise<boolean>;
    /** A small file's text; throws when it can't be read. */
    readText(path: string): Promise<string>;
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

export interface LoadOptions {
    /**
     * A copy the server last confirmed before this time (the cache's clock, `Date.now()` by default)
     * is checked with it first: a page passes the time it opened. Without it, a copy is used as it is.
     */
    readonly checkedSince?: number;
}

export interface FileCache {
    /** The copy held for a key, or null; synchronous once the cache has read its folder. */
    path(key: string): string | null;
    /**
     * The file: from the folder (checked with the server per `options`), else downloaded once. Calls
     * in flight for a key share one load.
     */
    load(source: FileSource, options?: LoadOptions): Promise<FileLoad>;
    /** Keeps a key's copy out of the eviction until the returned release is called (an open page). */
    hold(key: string): () => void;
}

/** What a download's answer said about its version, sent back on the next check. */
interface Validator {
    readonly etag?: string;
    readonly lastModified?: string;
}

interface Entry {
    readonly key: string;
    /** The entry's folder name, `<key>.<stamp>`. */
    readonly folder: string;
    /** The file's name inside it. */
    readonly name: string;
    readonly bytes: number;
    readonly stamp: number;
    /** When the server last confirmed the copy, on the cache's clock; 0 for one an earlier launch kept. */
    checkedAt: number;
}

const cleanKey = (key: string) => key.replace(/[^A-Za-z0-9_-]/g, '');

/** `<key>.<stamp>`: the stamp (base 36) orders the eviction across launches. */
const FOLDER = /^([A-Za-z0-9_-]+)\.([0-9a-z]+)$/;

/** A download being written; never a cache entry (`FOLDER` doesn't match it). */
const PART = '.part';

const NAME_MAX = 120;

/** The entry folder's validator file: a safe name never starts with a dot, so no file is named so. */
const VALIDATOR = '.validator';

/**
 * A name safe as one path segment that other apps will read: no separators, control characters or
 * `:` (a separator to Apple's older APIs), no leading dots (a hidden file in Files), at most 120
 * characters with the extension kept; `file` when nothing is left. The rest stays as the person named
 * it (`#`, `%`, `?`, spaces, any script), since the share sheet and iOS's save panel show this name.
 */
export function safeFileName(name: string): string {
    const base = (name.split(/[\\/]/).pop() ?? '')
        // oxlint-disable-next-line no-control-regex -- control characters are what goes
        .replace(/[\u0000-\u001f\u007f:]/g, '-')
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

/** `name` inside `folder`: one encoded path segment under a file:// URI, as it is under a plain path. */
function inFolder(folder: string, name: string): string {
    return joinPath(folder, folder.startsWith('file://') ? encodeURIComponent(name) : name);
}

function validatorOf(response: Response): Validator | null {
    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');
    if (etag === null && lastModified === null) {
        return null;
    }
    return { ...(etag === null ? {} : { etag }), ...(lastModified === null ? {} : { lastModified }) };
}

function parseValidator(text: string): Validator | null {
    try {
        const value: unknown = JSON.parse(text);
        if (typeof value !== 'object' || value === null) {
            return null;
        }
        const { etag, lastModified } = value as Record<string, unknown>;
        const validator = {
            ...(typeof etag === 'string' ? { etag } : {}),
            ...(typeof lastModified === 'string' ? { lastModified } : {}),
        };
        return Object.keys(validator).length === 0 ? null : validator;
    } catch {
        return null;
    }
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
    /** Keys an open page holds, with how many pages hold each. */
    const held = new Map<string, number>();
    let lastStamp = 0;
    let total = 0;
    let indexed: Promise<void> | null = null;
    let ready = false;

    const folderOf = (entry: Entry) => joinPath(layout.files, entry.folder);
    const pathOf = (entry: Entry) => inFolder(folderOf(entry), entry.name);
    const readyOf = (entry: Entry): FileLoad => ({ state: 'ready', path: pathOf(entry), bytes: entry.bytes });

    /** Forgets an entry and deletes its folder. */
    async function drop(entry: Entry) {
        if (entries.get(entry.key) === entry) {
            entries.delete(entry.key);
            total -= entry.bytes;
        }
        await files.remove(folderOf(entry)).catch(onError);
    }

    /** Reads the folder once: what an earlier launch kept, and anything it can't name goes. */
    const index = () =>
        (indexed ??= (async () => {
            const folders = await files.list(layout.files).catch(() => [] as string[]);
            for (const folder of folders) {
                const match = FOLDER.exec(folder);
                const path = joinPath(layout.files, folder);
                // A partial write (`.part`), or something no build of this cache wrote.
                const names =
                    match === null
                        ? []
                        : (await files.list(path).catch(() => [] as string[])).filter((name) => name !== VALIDATOR);
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
                    await drop(known);
                }
                const bytes = await files.size(inFolder(path, name)).catch(() => 0);
                entries.set(key, { key, folder, name, bytes, stamp, checkedAt: 0 });
                total += bytes;
                lastStamp = Math.max(lastStamp, stamp);
            }
            ready = true;
        })());

    /** Drops the oldest until the folder is within its bound, never `keep` or a copy an open page holds. */
    async function evict(keep: string) {
        const oldest = [...entries.values()].sort((a, b) => a.stamp - b.stamp);
        for (const entry of oldest) {
            if (total <= maxBytes) {
                break;
            }
            if (entry.key === keep || held.has(entry.key)) {
                continue;
            }
            await drop(entry);
        }
    }

    const cancel = (response: Response) => response.body?.cancel().catch(() => {});

    /** Keeps an answer's bytes as the key's copy, in place of any copy it had. */
    async function store(source: FileSource, key: string, response: Response): Promise<FileLoad> {
        const length = Number(response.headers.get('content-length') ?? '0');
        if (length > maxFileBytes) {
            await cancel(response);
            return { state: 'too-large' };
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
        const validator = validatorOf(response);
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
            await files.write(inFolder(part, name), bytes);
            if (validator !== null) {
                await files.write(joinPath(part, VALIDATOR), new TextEncoder().encode(JSON.stringify(validator)));
            }
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
        const before = entries.get(key);
        if (before !== undefined) {
            await drop(before);
        }
        const entry: Entry = { key, folder, name, bytes: bytes.byteLength, stamp, checkedAt: now() };
        entries.set(key, entry);
        total += bytes.byteLength;
        await evict(key);
        return readyOf(entry);
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
            await cancel(response);
            return { state: 'gone' };
        }
        if (!response.ok) {
            await cancel(response);
            return { state: 'failed' };
        }
        return store(source, key, response);
    }

    /** Asks the server whether the copy is still the file: kept on a 304, replaced on a 200, dropped once gone. */
    async function revalidate(source: FileSource, entry: Entry): Promise<FileLoad> {
        if (stopped()) {
            return readyOf(entry);
        }
        const validator = await files
            .readText(joinPath(folderOf(entry), VALIDATOR))
            .then(parseValidator)
            .catch(() => null);
        const headers: Record<string, string> = {
            ...(validator?.etag === undefined ? {} : { 'If-None-Match': validator.etag }),
            ...(validator?.lastModified === undefined ? {} : { 'If-Modified-Since': validator.lastModified }),
        };
        let response: Response;
        try {
            response = await fetch(source.url, { headers, ...(signal === undefined ? {} : { signal }) });
        } catch {
            // Offline: the copy is what there is.
            return readyOf(entry);
        }
        if (response.status === 304) {
            await cancel(response);
            entry.checkedAt = now();
            return readyOf(entry);
        }
        if (response.status === 404 || response.status === 410) {
            await cancel(response);
            await drop(entry);
            return { state: 'gone' };
        }
        if (!response.ok) {
            await cancel(response);
            return readyOf(entry);
        }
        const stored = await store(source, entry.key, response);
        if (stored.state === 'too-large') {
            // Replaced by a file too large to open here: the old bytes are no longer the file.
            await drop(entry);
            return stored;
        }
        // A new copy that couldn't be written leaves the old one, if it is still there.
        return stored.state === 'ready' || entries.get(entry.key) !== entry ? stored : readyOf(entry);
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
        load(source, loadOptions = {}) {
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
                if (entry === undefined) {
                    return download(source, key);
                }
                // Deleted under the cache (by the system, or by hand): downloaded again.
                if (!(await files.exists(pathOf(entry)).catch(() => false))) {
                    await drop(entry);
                    return download(source, key);
                }
                const { checkedSince } = loadOptions;
                return checkedSince !== undefined && entry.checkedAt < checkedSince
                    ? revalidate(source, entry)
                    : readyOf(entry);
            })().finally(() => loading.delete(key));
            loading.set(key, next);
            return next;
        },
        hold(raw) {
            const key = cleanKey(raw);
            held.set(key, (held.get(key) ?? 0) + 1);
            let released = false;
            return () => {
                if (released) {
                    return;
                }
                released = true;
                const count = (held.get(key) ?? 1) - 1;
                if (count > 0) {
                    held.set(key, count);
                } else {
                    held.delete(key);
                }
            };
        },
    };
}
