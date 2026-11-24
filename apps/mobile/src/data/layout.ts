import type { DbFile } from './driver';
import { CACHE_DB, USER_DB } from './schema';

// Where the store's files live:
//
//   <root>/socio/registry.db          the app's list of workspaces (registry.ts)
//   <root>/socio/<id>/cache.db        one directory per workspace and person,
//   <root>/socio/<id>/user.db         with their -wal and -shm files,
//   <root>/socio/<id>/images/         the app's own image cache
//   <root>/socio/<id>/attachments/    and picked attachments
//
// `<root>` is the app's document directory, which the platform gives.
// `<id>` is the hex SHA-256 of the workspace's full origin (scheme, host and
// port), a newline and the app user id. Keying by host alone would mix three
// `localhost` servers on different ports; keying by origin alone would mix two
// people on one phone. The hash keeps both out of every file path. When the
// server gives workspaces ids of their own, the directory is renamed.
//
// Paths are joined with `/`, as expo-sqlite joins a directory and a file name,
// so `<root>` may be a path or a `file://` URI. The platform hands src/data a
// SHA-256 (expo-crypto) and a file system (expo-file-system), so
// nothing here loads either and the tests run under Node.

/** The store's folder under the app's document directory. */
export const STORE_DIR = 'socio';
/** The app-level registry, in the store's folder. */
export const REGISTRY_DB = 'registry.db';
/** The app's own image cache in a workspace's directory: Clear cache deletes it. */
export const IMAGES_DIR = 'images';
/** Attachments picked and not sent yet (user.db's `files`): Clear cache keeps them. */
export const ATTACHMENTS_DIR = 'attachments';

/**
 * SHA-256 of `text` as UTF-8, as 64 lowercase hex characters. The platform
 * binds expo-crypto's `digestStringAsync` (whose default encoding is hex);
 * tests bind node:crypto.
 */
export type Hasher = (text: string) => Promise<string>;

/**
 * What the store needs from the file system. Paths are absolute: a path or a
 * `file://` URI, as the platform's root is. The platform binds
 * expo-file-system; tests bind node:fs on a temporary directory. Both must pass
 * `tests/helpers/file-system-contract.ts`.
 *
 * A read that fails throws: it never answers "nothing there". expo-file-system
 * 58 doesn't hold to that by itself (the platform's adapter must): on Android,
 * `Directory.list()` answers [] when `listFiles()` fails, and `File.exists`,
 * `Directory.exists` and `Paths.info` answer false without read permission.
 * So launch never deletes on the listing alone: it checks a missing entry with
 * `exists`, and stops when the two disagree (store.ts).
 */
export interface FileSystem {
    /**
     * The names of the entries directly in the directory, files and
     * directories alike; [] when it doesn't exist. Throws when it can't be read.
     */
    list(path: string): Promise<string[]>;
    /** Deletes the file, or the directory and everything in it. Nothing happens when it doesn't exist. */
    remove(path: string): Promise<void>;
    /**
     * True for a file or a directory, false when nothing is there. Throws when
     * it can't tell. One call answers for both kinds: expo-file-system's
     * `File.exists` is false for a directory and `Directory.exists` for a file.
     */
    exists(path: string): Promise<boolean>;
    /** Makes the directory and any missing parent. Nothing happens when it exists. */
    mkdir(path: string): Promise<void>;
}

/**
 * The file system's listing and `exists` disagree about `path`: one of them
 * isn't answering what is on disk, so launch stops and deletes nothing.
 */
export class FileSystemMismatchError extends Error {
    override readonly name = 'FileSystemMismatchError';
    readonly path: string;
    /** Whether the listing named it; `exists` answered the other way. */
    readonly listed: boolean;

    constructor(path: string, listed: boolean) {
        super(
            listed
                ? `The file system lists ${path}, but exists() says it isn't there.`
                : `exists() finds ${path}, but the file system's listing leaves it out.`,
        );
        this.path = path;
        this.listed = listed;
    }
}

/** A workspace's directory id: 64 lowercase hex characters. */
const WORKSPACE_ID = /^[0-9a-f]{64}$/;

/** The id is a workspace directory's name: 64 lowercase hex characters. */
export function isWorkspaceId(id: string): boolean {
    return WORKSPACE_ID.test(id);
}

/** `parent/name`, with one `/` between them. */
export function joinPath(parent: string, name: string): string {
    return `${parent.replace(/\/+$/, '')}/${name.replace(/^\/+/, '')}`;
}

/**
 * The directory id of one workspace and person: the hex SHA-256 of `origin`,
 * a newline and `appUserId`.
 *
 * - `origin` is the workspace's exact origin, as `new URL(address).origin`
 *   gives it: http or https, lowercase, no default port, no path or trailing
 *   slash. Anything else is refused rather than normalized, so one workspace
 *   always gets one id. An origin holds no newline, so the newline separates
 *   the two parts and no two pairs hash the same text.
 * - `appUserId` is the app user id that owns the data, `user.id` from
 *   `GET /api/auth/session`, never the id the sign-in answer gives.
 */
export async function workspaceId(hash: Hasher, origin: string, appUserId: string): Promise<string> {
    if (!isExactOrigin(origin)) {
        throw new TypeError(`A workspace's directory needs an exact http or https origin, not "${origin}".`);
    }
    if (appUserId === '') {
        throw new TypeError('A workspace’s directory needs the app user id.');
    }
    const id = await hash(`${origin}\n${appUserId}`);
    if (!isWorkspaceId(id)) {
        throw new TypeError('The hasher must give SHA-256 as 64 lowercase hex characters.');
    }
    return id;
}

/** `origin` is exactly an http or https origin, as `new URL(…).origin` writes it. */
function isExactOrigin(origin: string): boolean {
    try {
        const url = new URL(origin);
        return url.origin === origin && (url.protocol === 'https:' || url.protocol === 'http:');
    } catch {
        return false;
    }
}

/** The store's folder: `<root>/socio`. */
export function storeDirectory(root: string): string {
    return joinPath(root, STORE_DIR);
}

/** The registry's file: `registry.db` in the store's folder. */
export function registryFile(root: string): DbFile {
    return { directory: storeDirectory(root), name: REGISTRY_DB };
}

/** Where one workspace's files are. */
export interface WorkspaceLayout {
    readonly id: string;
    /** `<root>/socio/<id>`: everything of the workspace is in it. */
    readonly directory: string;
    readonly cache: DbFile;
    readonly user: DbFile;
    readonly images: string;
    readonly attachments: string;
}

/** The paths of workspace `id` under `root`. */
export function workspaceLayout(root: string, id: string): WorkspaceLayout {
    if (!isWorkspaceId(id)) {
        throw new TypeError(`A workspace id is 64 lowercase hex characters, not "${id}".`);
    }
    const directory = joinPath(storeDirectory(root), id);
    return {
        id,
        directory,
        cache: { directory, name: CACHE_DB },
        user: { directory, name: USER_DB },
        images: joinPath(directory, IMAGES_DIR),
        attachments: joinPath(directory, ATTACHMENTS_DIR),
    };
}

/** The ids of the workspace directories in the store's folder. Other entries (the registry's files) aren't ids. */
export async function workspaceDirectories(fs: FileSystem, root: string): Promise<string[]> {
    return (await fs.list(storeDirectory(root))).filter(isWorkspaceId).sort();
}
