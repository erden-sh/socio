import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, createReadStream, readFileSync } from 'node:fs';
import {
    chmod,
    copyFile,
    lstat,
    mkdir,
    open,
    readdir,
    realpath,
    rename,
    rm,
    stat,
    statfs,
    utimes,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';

import {
    checkSnapshotManifest,
    itemChunks,
    itemChunkSize,
    PLUGIN_CHUNK_BYTES,
    PLUGIN_JOURNAL_MODES,
    PLUGIN_MANIFEST_MAX_BYTES,
    PLUGIN_SNAPSHOT_ID,
    PLUGIN_WHOLE_ITEM_MAX_BYTES,
    PluginSnapshotError,
    snapshotBytes,
    type PluginJournalMode,
    type PluginSnapshotItem,
    type PluginSnapshotManifest,
} from './snapshot.js';

/**
 * The plugin's side of workspace backups (CB-458):
 * `socio.backup.serve({ volumes })` answers the host's snapshot protocol on
 * `/__cb/backup/*` and its restore pushes on `/__cb/restore/*`, always
 * behind a host envelope.
 *
 * - **The default handler** walks each declared volume, copies every
 *   `*.sqlite` and `*.db` file with SQLite's online backup API into a
 *   standalone copy (`journal_mode=DELETE`, so no `-wal`, `-shm` or
 *   `-journal` file goes with it), takes every other file as it is, and
 *   skips symlinks, sockets, the SDK's own `.socio-*` entries, the
 *   `exclude` list, and `*.key`, `*.pem` and `.env` unless `include` lists
 *   them. A custom handler (`begin`, `openItem`, `end`) replaces it.
 * - **Quiesce.** `POST /__cb/backup/quiesce` holds writes on this task
 *   (writing requests answer 503 with `Retry-After`) for a 10-minute lease
 *   the host renews; the hold is its own resource, ended only by its own
 *   `DELETE`, the lease or the task stopping. A `.socio-quiesce` marker on
 *   the volumes holds a task that starts mid-snapshot.
 * - **Restore mode.** With `CB_RESTORE_SNAPSHOT` set and no `.socio-restore`
 *   marker for it, the SDK serves only `/healthz` and `/__cb/restore/*`:
 *   the host pushes the manifest and every item, the SDK checks each
 *   chunk's hash, the size and the item's hash, and on commit writes the
 *   marker and exits with status 0, so Swarm starts the task again on the
 *   restored data.
 * - **The hold on outward work.** `CB_RESTORE_HOLD` stays set after a
 *   restore: `restored.held` is true until the host's release writes a
 *   `.socio-release` marker, and `onRelease` callbacks run then.
 *
 * Self-contained so a plugin in another repository can vendor it: it
 * imports only Node's built-ins and `./snapshot.js`, a byte-identical copy
 * of `@socio/shared/plugins/plugin-snapshot` (tests/app-sdk.test.ts
 * checks). Request verification comes in as `verify` (the SDK's own).
 */

export const BACKUP_PATH = '/__cb/backup';
export const RESTORE_PATH = '/__cb/restore';
/** A snapshot the host stops asking about is dropped an hour after its last request. */
export const SNAPSHOT_LEASE_MS = 60 * 60_000;
/** A write hold lasts 10 minutes after its last renewal. */
export const QUIESCE_LEASE_MS = 10 * 60_000;
/** Seconds a refused write is told to wait. */
export const RETRY_AFTER_SECONDS = 5;
/** Files the default handler never takes unless `include` lists them. */
export const DEFAULT_EXCLUDES: readonly string[] = ['*.key', '*.pem', '.env'];
/** The SDK's own entries at a volume's root start with this; never backed up or restored. */
export const RESERVED_ENTRY_PREFIX = '.socio-';
export const QUIESCE_MARKER = '.socio-quiesce';
export const RESTORE_MARKER = '.socio-restore';
export const RELEASE_MARKER = '.socio-release';
const WORK_DIR = '.socio-snapshots';
const RESTORE_TMP = '.socio-restore-tmp';
/** How long a quiesce waits for writes in flight to finish. */
const DRAIN_MS = 30_000;
/** Snapshots held at once on one task. */
const MAX_LIVE = 4;
const SMALL_BODY = 4096;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\u0000', 'latin1');
const DATABASE_NAME = /\.(sqlite|db)$/;
const COMPANIONS = ['-wal', '-shm', '-journal'];

export type SnapshotReason = 'scheduled' | 'manual' | 'request' | 'pre-update' | 'uninstall';
export const SNAPSHOT_REASONS: readonly SnapshotReason[] = [
    'scheduled',
    'manual',
    'request',
    'pre-update',
    'uninstall',
];

/** An item as a handler lists it: the SDK reads it once to add its size, hashes and chunks. */
export interface BackupItemDraft {
    volume: string;
    path: string;
    kind: 'database' | 'file';
    /** When given, checked against what `openItem` yields. */
    size?: number;
    sha256?: string;
    mode?: number;
    journalMode?: PluginJournalMode;
}

/** What `begin` answers: the snapshot's items, and optionally its versions and counts. */
export interface BackupDraft {
    items: BackupItemDraft[];
    pluginVersion?: string;
    schemaVersion?: number;
    stats?: Record<string, unknown>;
}

export type ItemBytes = AsyncIterable<Uint8Array> | Iterable<Uint8Array> | ReadableStream<Uint8Array>;

/**
 * A custom snapshot handler: `begin` makes a consistent copy
 * and lists it, `openItem` streams one item whole, `end` drops the copy.
 */
export interface BackupHandler {
    begin(
        reason: SnapshotReason,
        context: { snapshotId: string; quiesce: boolean },
    ): BackupDraft | Promise<BackupDraft>;
    openItem(snapshotId: string, path: string, volume: string): ItemBytes | Promise<ItemBytes>;
    end(snapshotId: string): unknown;
}

export interface BackupServeOptions {
    /** Each non-ephemeral volume of the manifest, by name, and where it is mounted. */
    volumes: Record<string, string>;
    /** The data schema this build writes, at most the manifest's `backup.schema`. */
    schemaVersion: number;
    /** Shown in the workspace's backup history; the host trusts its own record. */
    pluginVersion?: string;
    /** Paths the default handler leaves out, relative to a volume's mount (`*`, `**`, `?`). */
    exclude?: readonly string[];
    /** Paths the default handler takes although `DEFAULT_EXCLUDES` matches them. */
    include?: readonly string[];
    /** Replaces the default handler. */
    handler?: BackupHandler;
    /** The plugin's own counts, in the manifest and `verify`, for the drill to compare. */
    stats?: () => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
    /** Which requests write, and are refused while writes are held. Default: any method but GET, HEAD and OPTIONS. */
    writing?: (request: { method: string; path: string }) => boolean;
    /** Called when a hold starts (pause your own jobs) and when it ends. */
    quiesce?: { hold?(snapshotId: string): unknown; resume?(snapshotId: string): unknown };
    /** The path `listenForRestore` answers as healthy; `/healthz`. */
    healthPath?: string;
    /** How restore mode ends; `process.exit`. */
    exit?: (code: number) => void;
    /** A volume's free space; `node:fs` `statfs`. Tests replace it. */
    statfs?: (path: string) => Promise<{ bavail: number; bsize: number }>;
}

/** A restored plugin's state. */
export interface RestoredState {
    snapshotId: string;
    /** When the restored snapshot was taken; null until its restore marker is read. */
    snapshotAt: number | null;
    /** True until an admin releases the hold: pause outward work meanwhile. */
    held: boolean;
}

/** How the SDK verifies a request: the host envelope opens `/__cb/` (the SDK's `verify`). */
export type BackupVerify = (request: {
    method: string;
    target: string;
    header: string | null | undefined;
}) => { ok: true; principal: { access: string } } | { ok: false; status: number; reason: string };

export interface BackupDeps {
    /** The plugin's id (`plugin:<id>` without the prefix); undefined for a mini app. */
    pluginId: string | undefined;
    verify: BackupVerify;
    apiUrl: string;
    credentials: () => Record<string, string> | undefined;
    fetch: typeof fetch;
    now: () => number;
    env: Record<string, string | undefined>;
}

/** The answer an adapter gives a request refused while writes are held or a restore runs. */
export interface BackupRefusal {
    status: 503;
    reason: 'writes_held' | 'restoring';
    retryAfter: number;
}

class BackupFailure extends Error {
    override name = 'BackupFailure';
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    });

const problem = (status: number, error: string, message: string) => json(status, { error, message });

const asIterable = (bytes: ItemBytes): AsyncIterable<Uint8Array> => {
    if (Symbol.asyncIterator in bytes) {
        return bytes as AsyncIterable<Uint8Array>;
    }
    if ('getReader' in bytes) {
        return Readable.fromWeb(bytes as unknown as import('node:stream/web').ReadableStream<Uint8Array>);
    }
    return Readable.from(bytes as Iterable<Uint8Array>);
};

/** Bytes `[start, end)` of a stream. */
async function* slice(source: AsyncIterable<Uint8Array>, start: number, end: number) {
    let at = 0;
    for await (const piece of source) {
        const from = Math.max(start - at, 0);
        const to = Math.min(end - at, piece.length);
        if (to > from) {
            yield piece.subarray(from, to);
        }
        at += piece.length;
        if (at >= end) {
            return;
        }
    }
}

/** A request body, cut at `max` bytes. */
async function readBody(request: Request, max: number) {
    const parts: Uint8Array[] = [];
    let size = 0;
    if (request.body) {
        for await (const piece of request.body as unknown as AsyncIterable<Uint8Array>) {
            size += piece.length;
            if (size > max) {
                throw new BackupFailure('The request body is too large.');
            }
            parts.push(piece);
        }
    }
    return Buffer.concat(parts);
}

async function readJson(request: Request, max: number): Promise<unknown> {
    const body = await readBody(request, max);
    try {
        return JSON.parse(body.toString('utf8')) as unknown;
    } catch {
        throw new BackupFailure('The request body is not JSON.');
    }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

/** A failure's message without paths: fs errors carry the path, so only their code is kept. */
const failureMessage = (error: unknown) => {
    if (error instanceof BackupFailure || error instanceof PluginSnapshotError) {
        return error.message;
    }
    const code = (error as { code?: unknown } | undefined)?.code;
    return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)
        ? `The snapshot failed reading the volume (${code}).`
        : 'The snapshot failed in the plugin.';
};

/** A glob (`*`, `**`, `?`) as a test on a `/`-separated path; without a `/` it matches a name at any depth. */
export function globMatcher(pattern: string) {
    const anchored = pattern.replace(/\/+$/, '').includes('/');
    const body = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
    let source = '';
    for (let i = 0; i < body.length; i += 1) {
        const char = body[i];
        if (char === '*' && body[i + 1] === '*') {
            source += '.*';
            i += body[i + 2] === '/' ? 2 : 1;
        } else if (char === '*') {
            source += '[^/]*';
        } else if (char === '?') {
            source += '[^/]';
        } else {
            source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    const re = new RegExp(`${anchored ? '^' : '(^|/)'}${source}(/.*)?$`);
    return (path: string) => re.test(path);
}

interface VolumeFile {
    volume: string;
    path: string;
    abs: string;
    size: number;
    mode: number;
}

/** Whether the file starts with SQLite's header. */
async function looksLikeSqlite(abs: string) {
    const handle = await open(abs, 'r');
    try {
        const header = Buffer.alloc(SQLITE_MAGIC.length);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        return bytesRead === header.length && header.equals(SQLITE_MAGIC);
    } finally {
        await handle.close();
    }
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every regular file of each volume the rules take, in a stable order, without following symlinks. */
async function walkVolumes(
    volumes: Record<string, string>,
    rules: { exclude: readonly string[]; include: readonly string[] },
) {
    const exclude = rules.exclude.map(globMatcher);
    const include = rules.include.map(globMatcher);
    const defaults = DEFAULT_EXCLUDES.map(globMatcher);
    const files: VolumeFile[] = [];
    for (const volume of Object.keys(volumes).sort(byName)) {
        const mount = volumes[volume];
        const visit = async (dir: string, prefix: string) => {
            const entries = await readdir(join(mount, dir), { withFileTypes: true });
            entries.sort((a, b) => byName(a.name, b.name));
            for (const entry of entries) {
                const path = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (!prefix && entry.name.startsWith(RESERVED_ENTRY_PREFIX)) {
                    continue;
                }
                if (exclude.some((test) => test(path))) {
                    continue;
                }
                if (entry.isDirectory()) {
                    await visit(join(dir, entry.name), path);
                    continue;
                }
                if (!entry.isFile()) {
                    // Symlinks, sockets, FIFOs and devices are never taken.
                    continue;
                }
                if (defaults.some((test) => test(path)) && !include.some((test) => test(path))) {
                    continue;
                }
                const abs = join(mount, dir, entry.name);
                const info = await lstat(abs);
                if (info.isFile()) {
                    files.push({ volume, path, abs, size: info.size, mode: info.mode & 0o7777 });
                }
            }
        };
        await visit('', '');
    }
    return files;
}

/** The files the default handler copies as databases: named `*.sqlite` or `*.db` with SQLite's header. */
async function databasesOf(files: VolumeFile[]) {
    const databases = new Set<VolumeFile>();
    for (const file of files) {
        if (DATABASE_NAME.test(file.path) && file.size >= SQLITE_MAGIC.length && (await looksLikeSqlite(file.abs))) {
            databases.add(file);
        }
    }
    return databases;
}

const journalModeOf = (db: DatabaseSync): PluginJournalMode => {
    const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined;
    const mode = String(row?.journal_mode ?? 'delete').toLowerCase();
    return (PLUGIN_JOURNAL_MODES as readonly string[]).includes(mode) ? (mode as PluginJournalMode) : 'delete';
};

/**
 * The default handler: standalone SQLite copies through the
 * online backup API, every other file as it is, copied into the
 * snapshot's work directory (a reflink where the file system has them), so
 * a file written, replaced or removed meanwhile is still the one listed.
 */
export function defaultBackupHandler(
    volumes: Record<string, string>,
    rules: { exclude?: readonly string[]; include?: readonly string[] } = {},
    io: { statfs: (path: string) => Promise<{ bavail: number; bsize: number }> } = { statfs },
) {
    const snapshots = new Map<string, Map<string, string>>();
    const key = (volume: string, path: string) => `${volume}\u0000${path}`;
    const workDir = (volume: string, snapshotId: string) => join(volumes[volume], WORK_DIR, snapshotId);
    const touched = new Map<string, number>();
    const handler: BackupHandler & {
        openRange(snapshotId: string, path: string, volume: string, start: number, end: number): ItemBytes;
        touch(snapshotId: string): Promise<void>;
    } = {
        async begin(_reason, { snapshotId }) {
            const files = await walkVolumes(volumes, { exclude: rules.exclude ?? [], include: rules.include ?? [] });
            const databases = await databasesOf(files);
            const companions = new Set<string>();
            for (const database of databases) {
                for (const suffix of COMPANIONS) {
                    companions.add(key(database.volume, database.path + suffix));
                }
            }
            // Every file is copied: a database needs about its size (and its WAL's) free on its volume.
            for (const volume of Object.keys(volumes)) {
                let needed = 0;
                for (const file of files) {
                    if (file.volume !== volume || companions.has(key(file.volume, file.path))) {
                        continue;
                    }
                    needed += file.size;
                    if (databases.has(file)) {
                        const wal = await stat(`${file.abs}-wal`).catch(() => undefined);
                        needed += wal?.size ?? 0;
                    }
                }
                if (needed > 0) {
                    const space = await io.statfs(volumes[volume]);
                    if (space.bavail * space.bsize < needed) {
                        throw new BackupFailure(`There isn't enough free space on volume ${volume} to copy its files.`);
                    }
                }
            }
            const sources = new Map<string, string>();
            snapshots.set(snapshotId, sources);
            const items: BackupItemDraft[] = [];
            let n = 0;
            for (const file of files) {
                const id = key(file.volume, file.path);
                if (companions.has(id)) {
                    continue;
                }
                const dir = workDir(file.volume, snapshotId);
                await mkdir(dir, { recursive: true, mode: 0o700 });
                const copy = join(dir, String(n++));
                if (databases.has(file)) {
                    const source = new DatabaseSync(file.abs, { readOnly: true });
                    let journalMode: PluginJournalMode;
                    try {
                        journalMode = journalModeOf(source);
                        await sqliteBackup(source, copy);
                    } finally {
                        source.close();
                    }
                    // Standalone: every page in the file, no companion needed.
                    const standalone = new DatabaseSync(copy);
                    try {
                        standalone.exec('PRAGMA journal_mode=DELETE');
                    } finally {
                        standalone.close();
                    }
                    sources.set(id, copy);
                    items.push({
                        volume: file.volume,
                        path: file.path,
                        kind: 'database',
                        mode: file.mode,
                        journalMode,
                    });
                    continue;
                }
                // A copy of its own (a reflink where the file system has them), so a
                // write in place after the manifest never changes what is served.
                await copyFile(file.abs, copy, fsConstants.COPYFILE_FICLONE);
                sources.set(id, copy);
                items.push({ volume: file.volume, path: file.path, kind: 'file', mode: file.mode });
            }
            return { items };
        },
        openItem(snapshotId, path, volume) {
            return handler.openRange(snapshotId, path, volume, 0, Number.POSITIVE_INFINITY);
        },
        openRange(snapshotId, path, volume, start, end) {
            const source = snapshots.get(snapshotId)?.get(key(volume, path));
            if (!source) {
                throw new BackupFailure('That item is not in this snapshot.');
            }
            return createReadStream(source, {
                start,
                ...(Number.isFinite(end) ? { end: Math.max(end - 1, start) } : {}),
            }) as AsyncIterable<Uint8Array>;
        },
        /**
         * Renews the lease on the volume too: another task that starts on a
         * shared volume sweeps work directories by their time, so a
         * snapshot the host still reads must look fresh (at most a minute old).
         */
        async touch(snapshotId) {
            const at = Date.now();
            if (!snapshots.has(snapshotId) || at - (touched.get(snapshotId) ?? 0) < 60_000) {
                return;
            }
            touched.set(snapshotId, at);
            for (const volume of Object.keys(volumes)) {
                const when = new Date(at);
                await utimes(workDir(volume, snapshotId), when, when).catch(() => undefined);
            }
        },
        async end(snapshotId) {
            snapshots.delete(snapshotId);
            touched.delete(snapshotId);
            for (const volume of Object.keys(volumes)) {
                await rm(workDir(volume, snapshotId), { recursive: true, force: true });
            }
        },
    };
    return handler;
}

interface Snapshot {
    id: string;
    reason: SnapshotReason;
    quiesce: boolean;
    state: 'preparing' | 'ready' | 'failed';
    manifest?: PluginSnapshotManifest;
    error?: string;
    seen: number;
    ended: boolean;
    work: Promise<void>;
}

interface Marker {
    snapshotId?: unknown;
    until?: unknown;
    snapshotAt?: unknown;
}

const readMarker = (path: string): Marker | undefined => {
    try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        return isRecord(value) ? value : undefined;
    } catch {
        return undefined;
    }
};

/** Writes `body` to `path` through a temporary name, synced, so a crash never leaves half a marker. */
async function writeDurably(path: string, body: string) {
    const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await open(temporary, 'w', 0o600);
    try {
        await handle.writeFile(body);
        await handle.sync();
    } finally {
        await handle.close();
    }
    await rename(temporary, path);
    await syncDir(join(path, '..'));
}

async function syncDir(dir: string) {
    try {
        const handle = await open(dir, 'r');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch {
        // Not every filesystem syncs a directory.
    }
}

/** The SDK's routes under the reserved prefix. */
export const isBackupRoute = (path: string) =>
    path === BACKUP_PATH ||
    path.startsWith(`${BACKUP_PATH}/`) ||
    path === RESTORE_PATH ||
    path.startsWith(`${RESTORE_PATH}/`);

const pathOf = (target: string) => target.split(/[?#]/, 1)[0];
const INDEX = /^(0|[1-9][0-9]{0,8})$/;

/** The served backup side of one plugin task. */
export interface BackupServer {
    /** True when this task must restore before the app starts: call `listenForRestore` instead of starting it. */
    restoreMode: boolean;
    /** The volumes served, by name. */
    volumes: readonly string[];
    /** A raw `Request`: verified, then answered if it is one of the SDK's routes; undefined otherwise. */
    handle(request: Request): Promise<Response | undefined>;
    /** A request to the SDK's routes that an adapter already verified as the host's. */
    route(request: Request): Promise<Response>;
    /** What an adapter answers a request before the app sees it, or undefined to let it through. */
    refusal(method: string, target: string, isPublic: boolean): BackupRefusal | undefined;
    /** Counts a writing request in flight; call the result when it ends. */
    enter(method: string, target: string): () => void;
    /** Whether writes are held for a snapshot now. */
    quiesced(): boolean;
    /** Runs the leases now (the SDK also runs them every minute). */
    sweep(): Promise<void>;
    /** Restore mode's own server: `/healthz` and `/__cb/restore/*`; exits 0 after the commit. */
    listenForRestore(listen?: { port?: number; host?: string }): Promise<{ port: number; close: () => Promise<void> }>;
    /** Stops the lease timer. */
    close(): void;
    /** Settles once every snapshot this task holds is prepared, and the start's sweep of stale work directories is done. */
    settled(): Promise<void>;
    restored(): RestoredState | undefined;
}

/**
 * The backup side for one app: `serve`, `request`, `restored` and
 * `onRelease`. `socioApp()` builds it as `socio.backup`; a vendored copy
 * builds it with the SDK's `verify` and its credentials.
 */
export function backupSide(deps: BackupDeps) {
    const releaseListeners = new Set<(snapshotId: string) => unknown>();
    let served: BackupServer | undefined;

    const holdId = () => {
        const value = deps.env.CB_RESTORE_HOLD;
        return value && PLUGIN_SNAPSHOT_ID.test(value) ? value : undefined;
    };

    const serve = (options: BackupServeOptions): BackupServer => {
        if (served) {
            throw new Error('socio.backup.serve was already called.');
        }
        if (deps.pluginId === undefined) {
            throw new Error('Backups are for service plugins: CB_APP_ID must be plugin:<id>.');
        }
        const volumes = { ...options.volumes };
        const names = Object.keys(volumes).sort(byName);
        if (!names.length) {
            throw new Error('socio.backup.serve needs at least one volume.');
        }
        for (const name of names) {
            if (typeof volumes[name] !== 'string' || !volumes[name].startsWith('/')) {
                throw new Error(`Volume ${name} needs its absolute mount path.`);
            }
        }
        if (!Number.isSafeInteger(options.schemaVersion) || options.schemaVersion < 0) {
            throw new Error('schemaVersion must be a whole number.');
        }
        const now = deps.now;
        const freeSpace = options.statfs ?? statfs;
        const handler = options.handler ?? defaultBackupHandler(volumes, options, { statfs: freeSpace });
        const ranged = options.handler ? undefined : (handler as ReturnType<typeof defaultBackupHandler>);
        const writing =
            options.writing ?? ((request: { method: string }) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method));
        const exitWith = options.exit ?? ((code: number) => process.exit(code));
        let exited = false;
        const exit = (code: number) => {
            if (!exited) {
                exited = true;
                exitWith(code);
            }
        };
        const healthPath = options.healthPath ?? '/healthz';
        const snapshots = new Map<string, Snapshot>();
        /** This task's own write holds; `ready` once the hook ran and writes in flight drained. */
        const holds = new Map<string, { until: number; ready: boolean; init?: Promise<string | undefined> }>();
        /** Holds another task took, read from the shared volume's marker: the hook ran for them here too. */
        const inherited = new Map<string, Promise<boolean>>();
        let inflight = 0;
        const drained = new Set<() => void>();

        // ---- restore mode ------------------------------------------------------
        const restoreValue = deps.env.CB_RESTORE_SNAPSHOT;
        if (restoreValue !== undefined && restoreValue !== '' && !PLUGIN_SNAPSHOT_ID.test(restoreValue)) {
            throw new Error('CB_RESTORE_SNAPSHOT is not a snapshot id.');
        }
        const restoreId = restoreValue || undefined;
        const markerOn = (volume: string, name: string) => readMarker(join(volumes[volume], name));
        const restoreMode =
            restoreId !== undefined &&
            names.some((volume) => markerOn(volume, RESTORE_MARKER)?.snapshotId !== restoreId);
        let pushed: PluginSnapshotManifest | undefined;
        let pushedJson = '';
        const received = new Set<number>();
        let committed = false;
        let exiting = false;
        const scheduleExit = () => {
            if (!exiting) {
                exiting = true;
                // Long enough for the commit's answer to leave; `listenForRestore` exits sooner.
                setTimeout(() => exit(0), 250);
            }
        };

        // ---- the hold on outward work -----------------------------------------
        let released = false;
        /** Whether this process ran its `onRelease` callbacks (or saw the hold released before it started). */
        let delivered = false;
        let releaseCache: { at: number; value: boolean } | undefined;
        const releasedOnVolume = (snapshotId: string) => {
            if (releaseCache && now() - releaseCache.at < 1000) {
                return releaseCache.value;
            }
            const value = names.some((volume) => markerOn(volume, RELEASE_MARKER)?.snapshotId === snapshotId);
            releaseCache = { at: now(), value };
            return value;
        };
        const restored = (): RestoredState | undefined => {
            const snapshotId = holdId();
            if (!snapshotId) {
                return undefined;
            }
            const marker = names
                .map((volume) => markerOn(volume, RESTORE_MARKER))
                .find((m) => m?.snapshotId === snapshotId);
            const snapshotAt = typeof marker?.snapshotAt === 'number' ? marker.snapshotAt : null;
            const held = !released && !releasedOnVolume(snapshotId);
            if (!held && !delivered) {
                void deliverRelease(snapshotId);
            }
            return { snapshotId, snapshotAt, held };
        };
        /**
         * Runs this process's `onRelease` callbacks once, whichever replica
         * the host's release reached: this one, or another that wrote the
         * marker on the shared volume.
         */
        const deliverRelease = async (snapshotId: string) => {
            if (delivered) {
                return;
            }
            delivered = true;
            released = true;
            for (const listener of [...releaseListeners]) {
                try {
                    await listener(snapshotId);
                } catch {
                    // A listener's failure never undoes the release.
                }
            }
        };
        {
            // Released before this process started: the plugin reads `held` as false, with no callback.
            const hold = holdId();
            if (hold && releasedOnVolume(hold)) {
                delivered = true;
                released = true;
            }
        }

        // ---- quiesce -----------------------------------------------------------
        let quiesceCache: { at: number; value: string | undefined } | undefined;
        /** The snapshot id of a live hold some task wrote on the volumes, if any. */
        const markerHold = () => {
            if (quiesceCache && now() - quiesceCache.at < 1000) {
                return quiesceCache.value;
            }
            let value: string | undefined;
            for (const volume of names) {
                const marker = markerOn(volume, QUIESCE_MARKER);
                if (
                    typeof marker?.until === 'number' &&
                    marker.until > now() &&
                    typeof marker.snapshotId === 'string'
                ) {
                    value = marker.snapshotId;
                    break;
                }
            }
            quiesceCache = { at: now(), value };
            return value;
        };
        const runHook = async (hook: 'hold' | 'resume', snapshotId: string) => {
            try {
                await options.quiesce?.[hook]?.(snapshotId);
                return true;
            } catch {
                return false;
            }
        };
        /**
         * A hold another task took reaches this task's own jobs too: the
         * `hold` hook runs when the marker appears, `resume` when it goes.
         */
        const syncInherited = () => {
            const marked = markerHold();
            if (marked && !holds.has(marked) && !inherited.has(marked)) {
                inherited.set(marked, runHook('hold', marked));
            }
            for (const id of [...inherited.keys()]) {
                if (id !== marked && !holds.has(id)) {
                    inherited.delete(id);
                    void runHook('resume', id);
                }
            }
        };
        const endHold = async (snapshotId: string) => {
            holds.delete(snapshotId);
            inherited.delete(snapshotId);
            for (const volume of names) {
                const path = join(volumes[volume], QUIESCE_MARKER);
                if (readMarker(path)?.snapshotId === snapshotId) {
                    await rm(path, { force: true });
                }
            }
            quiesceCache = undefined;
            // The plugin's hook: its failure never keeps writes held.
            await runHook('resume', snapshotId);
        };
        const quiesced = () => {
            for (const [id, hold] of holds) {
                if (hold.until <= now()) {
                    void endHold(id);
                }
            }
            syncInherited();
            return holds.size > 0 || markerHold() !== undefined;
        };
        const waitDrained = () =>
            new Promise<boolean>((resolve) => {
                if (inflight === 0) {
                    resolve(true);
                    return;
                }
                const timer = setTimeout(() => {
                    drained.delete(done);
                    resolve(false);
                }, DRAIN_MS);
                const done = () => {
                    clearTimeout(timer);
                    drained.delete(done);
                    resolve(true);
                };
                drained.add(done);
            });

        // ---- snapshots -----------------------------------------------------------
        const hashItems = async (snapshotId: string, draft: BackupDraft) => {
            if (!isRecord(draft) || !Array.isArray(draft.items)) {
                throw new BackupFailure("The handler's begin answered no items.");
            }
            const items: PluginSnapshotItem[] = [];
            for (const [index, raw] of draft.items.entries()) {
                const whole = createHash('sha256');
                const chunks: string[] = [];
                let chunk = createHash('sha256');
                let inChunk = 0;
                let size = 0;
                for await (const piece of asIterable(await handler.openItem(snapshotId, raw.path, raw.volume))) {
                    whole.update(piece);
                    size += piece.length;
                    let at = 0;
                    while (at < piece.length) {
                        const take = Math.min(PLUGIN_CHUNK_BYTES - inChunk, piece.length - at);
                        chunk.update(piece.subarray(at, at + take));
                        inChunk += take;
                        at += take;
                        if (inChunk === PLUGIN_CHUNK_BYTES) {
                            chunks.push(chunk.digest('hex'));
                            chunk = createHash('sha256');
                            inChunk = 0;
                        }
                    }
                }
                if (inChunk > 0 || chunks.length === 0) {
                    chunks.push(chunk.digest('hex'));
                }
                const sha256 = whole.digest('hex');
                if (raw.size !== undefined && raw.size !== size) {
                    throw new BackupFailure(`Item ${index} changed size while it was read.`);
                }
                if (raw.sha256 !== undefined && raw.sha256 !== sha256) {
                    throw new BackupFailure(`Item ${index} isn't the bytes its hash names.`);
                }
                items.push({
                    volume: raw.volume,
                    path: raw.path,
                    kind: raw.kind,
                    size,
                    sha256,
                    ...(raw.kind === 'database' || size > PLUGIN_WHOLE_ITEM_MAX_BYTES ? { chunks } : {}),
                    ...(raw.mode !== undefined ? { mode: raw.mode } : {}),
                    ...(raw.journalMode !== undefined ? { journalMode: raw.journalMode } : {}),
                });
            }
            const stats = draft.stats ?? (await options.stats?.());
            // The host's own check: never answer a manifest it would refuse.
            return checkSnapshotManifest(
                {
                    protocol: 1,
                    pluginVersion: draft.pluginVersion ?? options.pluginVersion ?? 'unknown',
                    schemaVersion: draft.schemaVersion ?? options.schemaVersion,
                    createdAt: now(),
                    items,
                    ...(stats !== undefined ? { stats } : {}),
                },
                { volumes: names, schema: options.schemaVersion, maxBytes: Number.MAX_SAFE_INTEGER },
            );
        };

        const finish = async (snapshot: Snapshot) => {
            try {
                await handler.end(snapshot.id);
            } catch {
                // Its files go with the lease or the next start.
            }
        };

        const prepare = async (snapshot: Snapshot) => {
            try {
                const draft = await handler.begin(snapshot.reason, {
                    snapshotId: snapshot.id,
                    quiesce: snapshot.quiesce,
                });
                snapshot.manifest = await hashItems(snapshot.id, draft);
                snapshot.state = 'ready';
            } catch (error) {
                snapshot.state = 'failed';
                snapshot.error = failureMessage(error);
            }
            if (snapshot.ended) {
                await finish(snapshot);
            }
        };

        const drop = async (snapshot: Snapshot) => {
            snapshots.delete(snapshot.id);
            if (snapshot.ended) {
                return;
            }
            snapshot.ended = true;
            if (snapshot.state !== 'preparing') {
                await finish(snapshot);
            }
        };

        /** Leases: a snapshot an hour after its last request, a hold 10 minutes after its last renewal. */
        const sweep = async () => {
            for (const snapshot of [...snapshots.values()]) {
                if (now() - snapshot.seen >= SNAPSHOT_LEASE_MS) {
                    await drop(snapshot);
                }
            }
            for (const [id, hold] of [...holds]) {
                if (hold.until <= now()) {
                    await endHold(id);
                }
            }
            syncInherited();
            const hold = holdId();
            if (hold && !delivered && releasedOnVolume(hold)) {
                await deliverRelease(hold);
            }
        };

        // Work directories a stopped task left behind (older than any live lease).
        const stale: Array<Promise<unknown>> = [];
        if (!restoreMode && !options.handler) {
            for (const volume of names) {
                const dir = join(volumes[volume], WORK_DIR);
                const swept = readdir(dir)
                    .then(async (entries) => {
                        for (const entry of entries) {
                            const info = await lstat(join(dir, entry)).catch(() => undefined);
                            if (info && Date.now() - info.mtimeMs > SNAPSHOT_LEASE_MS) {
                                await rm(join(dir, entry), { recursive: true, force: true });
                            }
                        }
                    })
                    .catch(() => undefined);
                stale.push(swept);
            }
        }
        if (!restoreMode) {
            syncInherited();
        }
        // Often enough that a task holding another's writes resumes soon after.
        const timer = setInterval(() => void sweep(), 10_000);
        timer.unref?.();

        const snapshotIdFrom = (value: unknown) =>
            typeof value === 'string' && PLUGIN_SNAPSHOT_ID.test(value) ? value : undefined;

        const begin = async (request: Request) => {
            const body = await readJson(request, SMALL_BODY);
            const snapshotId = isRecord(body) ? snapshotIdFrom(body.snapshotId) : undefined;
            if (!isRecord(body) || !snapshotId) {
                return problem(400, 'bad_snapshot_id', 'A snapshot id is a ULID.');
            }
            const reason = body.reason as SnapshotReason;
            if (!SNAPSHOT_REASONS.includes(reason)) {
                return problem(400, 'bad_reason', 'That is not a snapshot reason.');
            }
            if (typeof body.quiesce !== 'boolean') {
                return problem(400, 'bad_quiesce', 'quiesce is true or false.');
            }
            const known = snapshots.get(snapshotId);
            if (known) {
                known.seen = now();
                void ranged?.touch(snapshotId);
                return known.reason === reason && known.quiesce === body.quiesce
                    ? json(202, { snapshotId })
                    : problem(409, 'snapshot_exists', 'That snapshot id is taken, with other parameters.');
            }
            const hold = holds.get(snapshotId);
            if (body.quiesce && !(hold?.ready && hold.until > now())) {
                return problem(409, 'not_held', 'A quiesced snapshot needs its write hold first.');
            }
            if (snapshots.size >= MAX_LIVE) {
                return problem(429, 'busy', 'Too many snapshots are open on this task.');
            }
            const snapshot: Snapshot = {
                id: snapshotId,
                reason,
                quiesce: body.quiesce,
                state: 'preparing',
                seen: now(),
                ended: false,
                work: Promise.resolve(),
            };
            snapshots.set(snapshotId, snapshot);
            snapshot.work = prepare(snapshot);
            return json(202, { snapshotId });
        };

        const itemBytes = (
            snapshot: Snapshot,
            index: number,
            start: number,
            end: number,
        ): Promise<ItemBytes> | ItemBytes => {
            const item = snapshot.manifest!.items[index];
            if (ranged) {
                return ranged.openRange(snapshot.id, item.path, item.volume, start, end);
            }
            return Promise.resolve(handler.openItem(snapshot.id, item.path, item.volume)).then((bytes) =>
                slice(asIterable(bytes), start, end),
            );
        };

        const serveItem = async (snapshot: Snapshot, index: number, search: URLSearchParams) => {
            if (snapshot.state !== 'ready' || !snapshot.manifest) {
                return problem(409, 'not_ready', 'The snapshot is not ready.');
            }
            const item = snapshot.manifest.items[index];
            if (!item) {
                return problem(404, 'no_item', 'The snapshot has no item at that index.');
            }
            const chunkParam = search.get('chunk');
            let start = 0;
            let length = item.size;
            if (chunkParam !== null) {
                if (!INDEX.test(chunkParam) || !item.chunks || Number(chunkParam) >= item.chunks.length) {
                    return problem(404, 'no_chunk', 'The item has no chunk at that index.');
                }
                const n = Number(chunkParam);
                start = n * PLUGIN_CHUNK_BYTES;
                length = itemChunkSize(item, n);
            }
            const bytes = asIterable(await itemBytes(snapshot, index, start, start + length));
            return new Response(Readable.toWeb(Readable.from(bytes)) as ReadableStream<Uint8Array>, {
                status: 200,
                headers: { 'content-type': 'application/octet-stream', 'content-length': String(length) },
            });
        };

        const quiesce = async (request: Request) => {
            const body = await readJson(request, SMALL_BODY);
            const snapshotId = isRecord(body) ? snapshotIdFrom(body.snapshotId) : undefined;
            if (!snapshotId) {
                return problem(400, 'bad_snapshot_id', 'A snapshot id is a ULID.');
            }
            const refused = (code: string) =>
                code === 'hold_failed'
                    ? problem(503, 'hold_failed', 'The plugin could not hold its writes.')
                    : problem(503, 'writes_busy', 'Writes in flight did not finish in time.');
            let hold = holds.get(snapshotId);
            if (hold && !hold.ready) {
                // A retry while the first is still draining: its answer is the first's.
                const failed = await hold.init;
                if (failed) {
                    return refused(failed);
                }
                hold = holds.get(snapshotId);
            }
            const until = now() + QUIESCE_LEASE_MS;
            if (hold) {
                hold.until = until;
            } else {
                // Held first, so no new write starts while the ones in flight finish.
                const entry: { until: number; ready: boolean; init?: Promise<string | undefined> } = {
                    until,
                    ready: false,
                };
                holds.set(snapshotId, entry);
                entry.init = (async () => {
                    // A hold inherited from the marker already started the hook here: its result is this one's.
                    const started = inherited.get(snapshotId);
                    inherited.delete(snapshotId);
                    if (!(await (started ?? runHook('hold', snapshotId)))) {
                        await endHold(snapshotId);
                        return 'hold_failed';
                    }
                    if (!(await waitDrained())) {
                        await endHold(snapshotId);
                        return 'writes_busy';
                    }
                    entry.ready = true;
                    return undefined;
                })();
                const failed = await entry.init;
                if (failed) {
                    return refused(failed);
                }
                if (holds.get(snapshotId) !== entry) {
                    return problem(409, 'hold_ended', 'The hold ended before writes were held.');
                }
            }
            const marker = JSON.stringify({ snapshotId, until });
            for (const volume of names) {
                await writeDurably(join(volumes[volume], QUIESCE_MARKER), marker);
            }
            quiesceCache = undefined;
            return json(200, { snapshotId, held: true, until });
        };

        const unquiesce = async (snapshotId: string) => {
            const byMarker = names.some((volume) => markerOn(volume, QUIESCE_MARKER)?.snapshotId === snapshotId);
            if (!holds.has(snapshotId) && !byMarker) {
                return problem(404, 'not_held', 'No write hold has that id.');
            }
            await endHold(snapshotId);
            return json(200, { snapshotId, held: false });
        };

        /** `POST /__cb/backup/verify`: every database passes `integrity_check`, and the plugin's counts. */
        const verifyVolumes = async () => {
            const files = await walkVolumes(volumes, {
                exclude: options.exclude ?? [],
                include: options.include ?? [],
            });
            let ok = true;
            for (const database of await databasesOf(files)) {
                try {
                    const db = new DatabaseSync(database.abs, { readOnly: true });
                    try {
                        const rows = db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
                        ok &&= rows.length === 1 && Object.values(rows[0])[0] === 'ok';
                    } finally {
                        db.close();
                    }
                } catch {
                    ok = false;
                }
            }
            const stats = await options.stats?.();
            return json(200, { ok, schemaVersion: options.schemaVersion, ...(stats !== undefined ? { stats } : {}) });
        };

        // ---- restore -----------------------------------------------------------
        /** Where an item lands: under its volume's mount, through no symlink. */
        const targetPath = async (item: PluginSnapshotItem) => {
            const mount = await realpath(volumes[item.volume]);
            const segments = item.path.split('/');
            let dir = mount;
            for (const segment of segments.slice(0, -1)) {
                dir = join(dir, segment);
                const info = await lstat(dir).catch(() => undefined);
                if (!info) {
                    await mkdir(dir, { mode: 0o755 });
                } else if (!info.isDirectory()) {
                    throw new BackupFailure('An item would be written through a symlink or a file.');
                }
            }
            const target = join(dir, segments[segments.length - 1]);
            if (!target.startsWith(`${mount}/`)) {
                throw new BackupFailure('An item would be written outside its volume.');
            }
            const existing = await lstat(target).catch(() => undefined);
            if (existing && !existing.isFile()) {
                throw new BackupFailure('An item would replace a symlink or a directory.');
            }
            return target;
        };

        const acceptManifest = async (snapshotId: string, request: Request) => {
            const raw = await readJson(request, PLUGIN_MANIFEST_MAX_BYTES);
            let manifest: PluginSnapshotManifest;
            try {
                manifest = checkSnapshotManifest(raw, {
                    volumes: names,
                    schema: options.schemaVersion,
                    maxBytes: Number.MAX_SAFE_INTEGER,
                });
            } catch (error) {
                return problem(422, 'bad_manifest', failureMessage(error));
            }
            const reserved = manifest.items.findIndex((item) => item.path.startsWith(RESERVED_ENTRY_PREFIX));
            if (reserved >= 0) {
                return problem(422, 'bad_manifest', `Item ${reserved} names one of the SDK's own entries.`);
            }
            const canonical = JSON.stringify(manifest);
            if (pushed) {
                return canonical === pushedJson
                    ? json(200, { snapshotId, items: pushed.items.length })
                    : problem(409, 'manifest_differs', 'Another manifest was pushed for this snapshot.');
            }
            for (const volume of names) {
                const bytes = manifest.items
                    .filter((item) => item.volume === volume)
                    .reduce((sum, item) => sum + item.size, 0);
                const space = await freeSpace(volumes[volume]);
                if (space.bavail * space.bsize < bytes) {
                    return problem(507, 'no_space', `There isn't enough free space on volume ${volume}.`);
                }
            }
            // Another push may have landed while free space was checked.
            const landed = pushed as PluginSnapshotManifest | undefined;
            if (landed) {
                return canonical === pushedJson
                    ? json(200, { snapshotId, items: landed.items.length })
                    : problem(409, 'manifest_differs', 'Another manifest was pushed for this snapshot.');
            }
            pushed = manifest;
            pushedJson = canonical;
            return json(200, { snapshotId, items: manifest.items.length, bytes: snapshotBytes(manifest) });
        };

        const acceptItem = async (index: number, request: Request) => {
            if (!pushed) {
                return problem(409, 'no_manifest', 'Push the manifest first.');
            }
            if (committed) {
                return problem(409, 'committed', 'The restore is committed.');
            }
            const item = pushed.items[index];
            if (!item) {
                return problem(404, 'no_item', 'The manifest has no item at that index.');
            }
            const expected = itemChunks(item);
            const tmpDir = join(volumes[item.volume], RESTORE_TMP);
            await mkdir(tmpDir, { recursive: true, mode: 0o700 });
            const temporary = join(tmpDir, `${index}-${randomBytes(6).toString('hex')}.part`);
            const handle = await open(temporary, 'w', 0o600);
            let ok = false;
            try {
                const whole = createHash('sha256');
                let chunk = createHash('sha256');
                let n = 0;
                let inChunk = 0;
                let size = 0;
                const closeChunk = () => {
                    if (chunk.digest('hex') !== expected[n]) {
                        throw new BackupFailure(`Chunk ${n} of item ${index} doesn't match its hash.`);
                    }
                    n += 1;
                    chunk = createHash('sha256');
                    inChunk = 0;
                };
                for await (const piece of (request.body ?? []) as AsyncIterable<Uint8Array>) {
                    size += piece.length;
                    if (size > item.size) {
                        throw new BackupFailure(`Item ${index} is larger than its manifest says.`);
                    }
                    let at = 0;
                    while (at < piece.length) {
                        const want = itemChunkSize(item, n) - inChunk;
                        const take = Math.min(want, piece.length - at);
                        if (take <= 0) {
                            throw new BackupFailure(`Item ${index} is larger than its manifest says.`);
                        }
                        chunk.update(piece.subarray(at, at + take));
                        inChunk += take;
                        at += take;
                        if (inChunk === itemChunkSize(item, n) && n < expected.length - 1) {
                            closeChunk();
                        }
                    }
                    whole.update(piece);
                    await handle.write(piece);
                }
                if (size !== item.size) {
                    throw new BackupFailure(`Item ${index} is smaller than its manifest says.`);
                }
                closeChunk();
                if (whole.digest('hex') !== item.sha256) {
                    throw new BackupFailure(`Item ${index} doesn't match its hash.`);
                }
                await handle.sync();
                ok = true;
            } catch (error) {
                return problem(422, 'item_mismatch', failureMessage(error));
            } finally {
                await handle.close();
                if (!ok) {
                    await rm(temporary, { force: true });
                }
            }
            try {
                await chmod(temporary, item.mode ?? 0o644);
                const target = await targetPath(item);
                await rename(temporary, target);
                await syncDir(join(target, '..'));
            } catch (error) {
                await rm(temporary, { force: true });
                return problem(422, 'bad_target', failureMessage(error));
            }
            received.add(index);
            return json(200, { index, received: received.size, of: pushed.items.length });
        };

        const commit = async (snapshotId: string) => {
            if (!pushed) {
                return problem(409, 'no_manifest', 'Push the manifest first.');
            }
            const missing = pushed.items.length - received.size;
            if (missing > 0) {
                return problem(409, 'items_missing', `${missing} items have not arrived.`);
            }
            if (!committed) {
                // Only `wal` lives in the file; the other modes are a connection's.
                for (const item of pushed.items) {
                    if (item.kind === 'database' && item.journalMode === 'wal') {
                        const db = new DatabaseSync(join(volumes[item.volume], item.path));
                        try {
                            db.exec('PRAGMA journal_mode=WAL');
                        } finally {
                            db.close();
                        }
                    }
                }
                const marker = JSON.stringify({ snapshotId, snapshotAt: pushed.createdAt, committedAt: now() });
                for (const volume of names) {
                    await rm(join(volumes[volume], RESTORE_TMP), { recursive: true, force: true });
                    await writeDurably(join(volumes[volume], RESTORE_MARKER), marker);
                }
                committed = true;
            }
            scheduleExit();
            return json(200, { snapshotId, committed: true });
        };

        const release = async (request: Request) => {
            const body = await readJson(request, SMALL_BODY);
            const snapshotId = isRecord(body) ? snapshotIdFrom(body.snapshotId) : undefined;
            const hold = holdId();
            if (!snapshotId) {
                return problem(400, 'bad_snapshot_id', 'A snapshot id is a ULID.');
            }
            if (!hold || snapshotId !== hold) {
                return problem(409, 'not_held', 'No hold on outward work has that id.');
            }
            if (!released && !releasedOnVolume(hold)) {
                const marker = JSON.stringify({ snapshotId, releasedAt: now() });
                for (const volume of names) {
                    await writeDurably(join(volumes[volume], RELEASE_MARKER), marker);
                }
                releaseCache = undefined;
            }
            await deliverRelease(snapshotId);
            return json(200, { snapshotId, released: true });
        };

        /**
         * One host request to the SDK's routes, already verified (the
         * adapters do it; `handle` does it for a raw `Request`).
         */
        const route = async (request: Request): Promise<Response> => {
            const url = new URL(request.url, 'http://plugin.invalid');
            const path = url.pathname;
            const method = request.method;
            try {
                if (path === `${RESTORE_PATH}/release` && method === 'POST') {
                    return await release(request);
                }
                if (path === RESTORE_PATH || path.startsWith(`${RESTORE_PATH}/`)) {
                    if (!restoreMode) {
                        return problem(409, 'not_restoring', 'This task is not in restore mode.');
                    }
                    const [id, rest, index, extra] = path.slice(RESTORE_PATH.length + 1).split('/');
                    if (id !== restoreId) {
                        return problem(409, 'wrong_snapshot', 'This task restores another snapshot.');
                    }
                    if (rest === undefined && method === 'POST') {
                        return await acceptManifest(id, request);
                    }
                    if (
                        rest === 'items' &&
                        index !== undefined &&
                        INDEX.test(index) &&
                        extra === undefined &&
                        method === 'PUT'
                    ) {
                        return await acceptItem(Number(index), request);
                    }
                    if (rest === 'commit' && index === undefined && method === 'POST') {
                        return await commit(id);
                    }
                    return problem(404, 'no_route', 'No such restore route.');
                }
                if (restoreMode) {
                    return problem(503, 'restoring', 'This task is restoring a snapshot.');
                }
                if (path === BACKUP_PATH && method === 'POST') {
                    return await begin(request);
                }
                if (path === `${BACKUP_PATH}/quiesce` && method === 'POST') {
                    return await quiesce(request);
                }
                if (path === `${BACKUP_PATH}/verify` && method === 'POST') {
                    return await verifyVolumes();
                }
                const [id, rest, index, extra] = path.slice(BACKUP_PATH.length + 1).split('/');
                if (id === 'quiesce' && rest !== undefined && index === undefined && method === 'DELETE') {
                    return snapshotIdFrom(rest)
                        ? await unquiesce(rest)
                        : problem(400, 'bad_snapshot_id', 'A snapshot id is a ULID.');
                }
                if (!snapshotIdFrom(id)) {
                    return problem(404, 'no_route', 'No such backup route.');
                }
                const snapshot = snapshots.get(id);
                if (!snapshot) {
                    return problem(404, 'no_snapshot', 'No snapshot has that id on this task.');
                }
                snapshot.seen = now();
                void ranged?.touch(id);
                if (rest === undefined && method === 'GET') {
                    return json(
                        200,
                        snapshot.state === 'ready'
                            ? { state: 'ready', manifest: snapshot.manifest }
                            : snapshot.state === 'failed'
                              ? { state: 'failed', error: snapshot.error }
                              : { state: 'preparing' },
                    );
                }
                if (rest === undefined && method === 'DELETE') {
                    await drop(snapshot);
                    return json(200, { snapshotId: id, ended: true });
                }
                if (
                    rest === 'items' &&
                    index !== undefined &&
                    INDEX.test(index) &&
                    extra === undefined &&
                    method === 'GET'
                ) {
                    return await serveItem(snapshot, Number(index), url.searchParams);
                }
                return problem(404, 'no_route', 'No such backup route.');
            } catch (error) {
                if (error instanceof BackupFailure) {
                    return problem(400, 'bad_request', error.message);
                }
                return problem(500, 'failed', failureMessage(error));
            }
        };

        /** A raw `Request` to the SDK's routes: verified here, for a plugin that routes them itself. */
        const handle = async (request: Request): Promise<Response | undefined> => {
            const url = new URL(request.url, 'http://plugin.invalid');
            const target = `${url.pathname}${url.search}`;
            if (!isBackupRoute(url.pathname)) {
                return undefined;
            }
            const verdict = deps.verify({
                method: request.method,
                target,
                header: request.headers.get('x-cb-actor'),
            });
            if (!verdict.ok || verdict.principal.access !== 'host') {
                return problem(401, 'host_only', 'Only the workspace calls this route.');
            }
            return route(request);
        };

        /**
         * What an adapter answers a request before the app sees it: 503 for
         * anything but health and the SDK's routes in restore mode, and for
         * a writing request while writes are held. Undefined: let it through.
         */
        const refusal = (method: string, target: string, isPublic: boolean): BackupRefusal | undefined => {
            const path = pathOf(target);
            if (isBackupRoute(path)) {
                return undefined;
            }
            if (restoreMode && !isPublic) {
                return { status: 503, reason: 'restoring', retryAfter: RETRY_AFTER_SECONDS };
            }
            if (writing({ method, path }) && quiesced()) {
                return { status: 503, reason: 'writes_held', retryAfter: RETRY_AFTER_SECONDS };
            }
            return undefined;
        };

        /** Counts a writing request in flight; a quiesce waits for these. Call the result when it ends. */
        const enter = (method: string, target: string) => {
            if (!writing({ method, path: pathOf(target) })) {
                return () => undefined;
            }
            inflight += 1;
            let left = false;
            return () => {
                if (left) {
                    return;
                }
                left = true;
                inflight -= 1;
                if (inflight === 0) {
                    for (const done of [...drained]) {
                        done();
                    }
                }
            };
        };

        /**
         * Restore mode's server: `/healthz` and
         * `/__cb/restore/*` only, on `port` (`PORT`, else 8080). After the
         * commit's answer leaves, the process exits with status 0.
         */
        const listenForRestore = (listen: { port?: number; host?: string } = {}) =>
            new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
                const server = createServer((req, res) => {
                    void (async () => {
                        const target = req.url ?? '/';
                        const path = pathOf(target);
                        if ((req.method === 'GET' || req.method === 'HEAD') && path === healthPath) {
                            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
                            res.end('restoring');
                            return;
                        }
                        if (!isBackupRoute(path)) {
                            res.writeHead(503, { 'retry-after': String(RETRY_AFTER_SECONDS) });
                            res.end('restoring');
                            return;
                        }
                        const header = req.headers['x-cb-actor'];
                        const verdict = deps.verify({
                            method: req.method ?? 'GET',
                            target,
                            header: typeof header === 'string' ? header : undefined,
                        });
                        if (!verdict.ok || verdict.principal.access !== 'host') {
                            res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
                            res.end('Only the workspace calls this route.');
                            return;
                        }
                        const response = await route(toWebRequest(req, target));
                        res.on('finish', () => {
                            if (exiting) {
                                server.close();
                                exit(0);
                            }
                        });
                        await sendWebResponse(res, response);
                    })().catch(() => {
                        if (!res.headersSent) {
                            res.writeHead(500);
                        }
                        res.end();
                    });
                });
                server.on('error', reject);
                server.listen(listen.port ?? Number(deps.env.PORT ?? 8080), listen.host, () => {
                    const address = server.address();
                    resolve({
                        port: typeof address === 'object' && address ? address.port : 0,
                        close: () => new Promise<void>((done) => server.close(() => done())),
                    });
                });
            });

        const close = () => clearInterval(timer);

        served = {
            restoreMode,
            volumes: names,
            handle,
            route,
            refusal,
            enter,
            quiesced,
            sweep,
            listenForRestore,
            close,
            settled: () =>
                Promise.all([...stale, ...[...snapshots.values()].map((snapshot) => snapshot.work)]).then(
                    () => undefined,
                ),
            restored,
        };
        return served;
    };

    /**
     * Asks the workspace for a snapshot: coalesced and
     * rate-limited by the host, its reason shown in the backup history.
     */
    const request = async ({ reason }: { reason: string }) => {
        if (deps.pluginId === undefined) {
            throw new Error('Backups are for service plugins.');
        }
        if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 200) {
            throw new Error('A backup request needs a reason of at most 200 characters.');
        }
        const auth = deps.credentials();
        if (!deps.apiUrl || !auth) {
            throw new Error('Socio’s API is not configured for this plugin.');
        }
        const answer = await deps.fetch(`${deps.apiUrl}/plugins/${encodeURIComponent(deps.pluginId)}/backup/request`, {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ reason }),
        });
        await answer.body?.cancel().catch(() => undefined);
        return { ok: answer.ok, status: answer.status };
    };

    return {
        serve,
        request,
        /**
         * After a restore: `{ snapshotId, snapshotAt, held }`
         * while `CB_RESTORE_HOLD` is set, else undefined. Before `serve`,
         * with no volume to read a release from, it reads as held.
         */
        get restored(): RestoredState | undefined {
            if (served) {
                return served.restored();
            }
            const snapshotId = holdId();
            return snapshotId ? { snapshotId, snapshotAt: null, held: true } : undefined;
        },
        /** Runs `callback` when an admin releases the hold on outward work; returns an unsubscribe. */
        onRelease(callback: (snapshotId: string) => unknown) {
            releaseListeners.add(callback);
            return () => releaseListeners.delete(callback);
        },
        /** Whether writes are held for a snapshot now: pause your own writing jobs while true. */
        quiesced: () => served?.quiesced() ?? false,
        /** The served side, once `serve` ran. */
        get server() {
            return served;
        },
    };
}

export type SocioBackup = ReturnType<typeof backupSide>;

/** A Node request as a fetch `Request`, its body streamed, at its raw request-target. */
export function toWebRequest(req: IncomingMessage, target: string) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') {
            headers.set(name, value);
        } else if (Array.isArray(value)) {
            for (const each of value) {
                headers.append(name, each);
            }
        }
    }
    const method = req.method ?? 'GET';
    const hasBody = method !== 'GET' && method !== 'HEAD';
    return new Request(`http://plugin.invalid${target}`, {
        method,
        headers,
        ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
    } as RequestInit);
}

/** Writes a fetch `Response` to a Node response, streaming its body. */
export async function sendWebResponse(res: ServerResponse, response: Response) {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
        headers[name] = value;
    });
    res.writeHead(response.status, headers);
    if (!response.body) {
        res.end();
        return;
    }
    for await (const piece of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (!res.write(piece)) {
            await new Promise<void>((resolve) => res.once('drain', () => resolve()));
        }
    }
    res.end();
}
