import {
    chmodSync,
    closeSync,
    constants,
    copyFileSync,
    existsSync,
    fchmodSync,
    fstatSync,
    linkSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    rmdirSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

import { SqliteRuntimeCopy } from './infra/sqlite/runtime-copy.js';
import { checkKey, type ListedObject, type ObjectStore } from './object-store.js';

const NAME = /^company-brain-(\d{8}-\d{6})(?:-(\d+))?\.sqlite$/;
const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
/**
 * An online copy takes every page in one step: node runs the step off the
 * main thread, so the server keeps answering, and one read transaction
 * gives a consistent copy. A copy taken a few pages at a time starts over
 * whenever another connection writes, so on a busy server it never ends.
 * SQLite takes a negative count as "all pages", but Node 24.21 and later
 * accept only a positive integer, so this is the largest one: more pages
 * than any database has, in one step.
 */
export const ALL_PAGES = 2_147_483_647;

/** A free `company-brain-…sqlite` path for `now` in `directory`. */
function databaseTarget(directory: string, now: Date) {
    let target = join(directory, `company-brain-${stamp(now)}.sqlite`);
    for (let n = 1; existsFile(target); n++) {
        target = join(directory, `company-brain-${stamp(now)}-${n}.sqlite`);
    }
    return target;
}
/** Newest first: by timestamp, then by same-second suffix. */
function prune(directory: string, pattern: RegExp, keep: number, remove: (path: string) => void) {
    const order = (name: string) => {
        const [, time, n] = name.match(pattern)!;
        return `${time}-${(n ?? '0').padStart(6, '0')}`;
    };
    const removed = readdirSync(directory)
        .filter((name) => pattern.test(name))
        .sort((a, b) => order(b).localeCompare(order(a)))
        .slice(keep);
    for (const name of removed) {
        remove(join(directory, name));
    }
    return removed;
}
function checkIntegrity(path: string) {
    const check = new DatabaseSync(path, { readOnly: true });
    try {
        const result = check.prepare('PRAGMA integrity_check').get() as {
            integrity_check: string;
        };
        if (result.integrity_check !== 'ok') {
            throw new Error('The backup failed its integrity check.');
        }
    } finally {
        check.close();
    }
}
/**
 * Boot: makes the database backups already in `directory` private. Earlier
 * versions wrote the one taken before migrations as 0644. Only the app's own
 * `company-brain-…sqlite` files, and never through a symlink. Returns how
 * many it tightened.
 */
export function tightenBackups(directory: string) {
    if (!existsSync(directory)) {
        return 0;
    }
    let tightened = 0;
    for (const name of readdirSync(directory).filter((n) => NAME.test(n))) {
        let fd: number | undefined;
        try {
            // O_NOFOLLOW: a symlink fails to open instead of being chmodded.
            fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
            const info = fstatSync(fd);
            if (info.isFile() && (info.mode & 0o077) !== 0) {
                fchmodSync(fd, 0o600);
                tightened++;
            }
        } catch {
            // A symlink, or a file gone or not ours to change: left as it is.
        } finally {
            if (fd !== undefined) {
                closeSync(fd);
            }
        }
    }
    return tightened;
}
const checkKeep = (keep: number) => {
    if (!Number.isInteger(keep) || keep < 1) {
        throw new Error('Keep at least one backup.');
    }
};

/**
 * Backs up the live database with `VACUUM INTO`: a consistent, compacted
 * copy taken through a separate connection while the server keeps running
 * (WAL mode). Files are named `company-brain-YYYYMMDD-HHMMSS.sqlite` (UTC);
 * only the newest `keep` are retained. Synchronous: the migrations' backup
 * at boot, before anything else runs.
 */
/**
 * Nothing in a copy is running (CB-108): its runtimes and their leases
 * are released, so a server opened on the restored copy closes the turns
 * and runs they held at once instead of waiting out their leases.
 */
function releaseRuntimes(path: string) {
    const copy = new DatabaseSync(path);
    try {
        if (!copy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_instances'").get()) {
            return;
        }
        copy.exec('BEGIN');
        new SqliteRuntimeCopy(copy).releaseAllNow(Date.now());
        copy.exec('COMMIT');
    } finally {
        copy.close();
    }
}

export function backupDatabase(databasePath: string, directory: string, keep = 14, now = new Date()) {
    checkKeep(keep);
    mkdirSync(directory, { recursive: true });
    const target = databaseTarget(directory, now);
    // Private from its first byte: an empty 0600 file is what VACUUM INTO
    // fills, and the name it ends up under appears only once it is complete.
    const partial = `${target}.partial`;
    rmSync(partial, { force: true });
    writeFileSync(partial, '', { mode: 0o600, flag: 'wx' });
    try {
        const db = new DatabaseSync(databasePath, { readOnly: true });
        try {
            db.exec('PRAGMA busy_timeout=5000');
            db.prepare('VACUUM INTO ?').run(partial);
        } finally {
            db.close();
        }
        releaseRuntimes(partial);
        chmodSync(partial, 0o600);
        // A damaged copy isn't a backup: it would count against `keep`.
        checkIntegrity(partial);
    } catch (error) {
        rmSync(partial, { force: true });
        throw error;
    }
    renameSync(partial, target);
    const removed = prune(directory, NAME, keep, (path) => rmSync(path));
    return { path: target, removed };
}

/**
 * The same backup, taken online with SQLite's backup API (CB-63): the
 * copy and the integrity check both off the main thread, so a running
 * server keeps answering. Written to `<name>.partial` first: a failed or
 * damaged copy never looks complete.
 */
export async function backupDatabaseOnline(
    databasePath: string,
    directory: string,
    keep = 14,
    now = new Date(),
    options: { prune?: boolean } = {},
) {
    checkKeep(keep);
    mkdirSync(directory, { recursive: true });
    const target = databaseTarget(directory, now);
    // Checked before it gets its name: a damaged copy never counts as a backup.
    await copyDatabase(databasePath, target, { verify: true });
    const removed = options.prune === false ? [] : prune(directory, NAME, keep, (path) => rmSync(path));
    return { path: target, removed };
}
async function copyDatabase(from: string, to: string, options: { verify?: boolean } = {}) {
    const partial = `${to}.partial`;
    rmSync(partial, { force: true });
    const db = new DatabaseSync(from, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout=5000');
        await backup(db, partial, { rate: ALL_PAGES });
    } catch (error) {
        rmSync(partial, { force: true });
        throw error;
    } finally {
        db.close();
    }
    // The copy keeps the source's WAL mode; a single file is what a backup
    // should be (no -wal or -shm left beside it), and a private one.
    const copy = new DatabaseSync(partial);
    try {
        copy.exec('PRAGMA journal_mode=DELETE');
    } finally {
        copy.close();
    }
    for (const suffix of ['-wal', '-shm']) {
        rmSync(`${partial}${suffix}`, { force: true });
    }
    chmodSync(partial, 0o600);
    if (options.verify) {
        try {
            await checkIntegrityApart(partial);
        } catch (error) {
            rmSync(partial, { force: true });
            throw error;
        }
    }
    renameSync(partial, to);
}
/** The integrity check, run by a worker. */
const INTEGRITY_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData, { readOnly: true });
try {
  parentPort.postMessage(db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok');
} finally {
  db.close();
}`;
/**
 * `PRAGMA integrity_check` in a worker thread: it reads the whole file, so
 * on a large database the server would stop answering meanwhile.
 */
function checkIntegrityApart(path: string) {
    return new Promise<void>((resolve, reject) => {
        const worker = new Worker(INTEGRITY_WORKER, {
            eval: true,
            workerData: path,
            // Nothing of the parent's loaders or flags: it needs node:sqlite only.
            execArgv: [],
        });
        worker.once('message', (ok: boolean) =>
            ok ? resolve() : reject(new Error('The backup failed its integrity check.')),
        );
        worker.once('error', () => reject(new Error('The backup’s integrity check failed to run.')));
        worker.once('exit', () => reject(new Error('The backup’s integrity check stopped.')));
    });
}
function existsFile(path: string) {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

const USERDATA = /^userdata-(\d{8}-\d{6})(?:-(\d+))?$/;
const LEFTOVER =
    /^(?:company-brain-[\d-]+\.sqlite\.partial(?:-wal|-shm)?|userdata-[\d-]+\.partial|.+\.json\.tmp|offsite\.sealed\.tmp)$/;

/**
 * Removes what a run cut off (a crash, a redeploy) left in `directory`:
 * `.partial` copies and temporary files (the off-site copy's sealed file
 * among them). Only under the backup lock, so
 * never another run's.
 */
export function removeLeftovers(directory: string) {
    if (!existsSync(directory)) {
        return 0;
    }
    const names = readdirSync(directory).filter((name) => LEFTOVER.test(name));
    for (const name of names) {
        rmSync(join(directory, name), { recursive: true, force: true });
    }
    return names.length;
}

/**
 * Backs up the users' data spaces (USER_DATA_DIR) next to the database
 * backups, as `userdata-YYYYMMDD-HHMMSS/`: every dataset with SQLite's
 * backup API (consistent while the server writes) and every file as it is
 * stored, still encrypted. The database backup holds their metadata
 * (datasets, grants, audit); take both. Keeps the newest `keep`.
 */
export async function backupUserData(
    userDataDir: string,
    directory: string,
    keep = 14,
    now = new Date(),
    options: {
        prune?: boolean;
        /** Adds to the copy before it gets its name (the objects' snapshot). */
        extra?: (partial: string) => void;
    } = {},
) {
    const partsMirror = join(directory, PARTS_MIRROR);
    let parts = 0;
    let missingParts = 0;
    checkKeep(keep);
    mkdirSync(directory, { recursive: true });
    let name = `userdata-${stamp(now)}`;
    for (let n = 1; existsSync(join(directory, name)); n++) {
        name = `userdata-${stamp(now)}-${n}`;
    }
    const target = join(directory, name);
    const partial = `${target}.partial`;
    rmSync(partial, { recursive: true, force: true });
    let datasets = 0;
    let files = 0;
    const users = existsSync(userDataDir)
        ? readdirSync(userDataDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
        : [];
    for (const user of users) {
        const from = join(userDataDir, user.name);
        const datasetDir = join(from, 'datasets');
        if (existsSync(datasetDir)) {
            for (const file of readdirSync(datasetDir).filter((f) => f.endsWith('.sqlite'))) {
                mkdirSync(join(partial, user.name, 'datasets'), { recursive: true });
                const copy = join(partial, user.name, 'datasets', file);
                await copyDatabase(join(datasetDir, file), copy);
                leaveGenerationPending(copy);
                datasets++;
                // Its analytical parts (CB-369), as the copied catalog lists them.
                const linked = linkParts(copy, join(datasetDir, file), partsMirror);
                parts += linked.parts;
                missingParts += linked.missing;
            }
        }
        const fileDir = join(from, 'files');
        if (existsSync(fileDir)) {
            for (const file of readdirSync(fileDir).filter((f) => f.endsWith('.bin'))) {
                mkdirSync(join(partial, user.name, 'files'), { recursive: true });
                const copy = join(partial, user.name, 'files', file);
                copyFileSync(join(fileDir, file), copy);
                chmodSync(copy, 0o600);
                files++;
            }
        }
    }
    mkdirSync(partial, { recursive: true });
    options.extra?.(partial);
    renameSync(partial, target);
    const removed =
        options.prune === false
            ? []
            : prune(directory, USERDATA, keep, (path) => rmSync(path, { recursive: true, force: true }));
    if (options.prune !== false) {
        pruneParts(directory);
    }
    return { path: target, datasets, files, removed, parts, missingParts };
}

/**
 * A dataset's backup copy is never written, only restored, and a restore
 * rewinds the file's history: so the copy keeps no row stamps' generation
 * (CB-451). The engine gives each restore of it a new one when it first
 * opens it, so a client's sync token from before the restore reconciles,
 * and two restores of the same backup never share a generation. The rows
 * keep their own stamps.
 */
function leaveGenerationPending(copy: string) {
    const db = new DatabaseSync(copy);
    try {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_stamp_seq'").get()) {
            db.exec("UPDATE _stamp_seq SET generation='' WHERE id=1");
        }
    } finally {
        db.close();
    }
}

/**
 * The analytical parts' mirror (CB-369): `BACKUP_DIR/parts/<dataset>/
 * <part>.parquet`, each part copied once (it never changes), then
 * hard-linked into every run whose catalog lists it, so unchanged parts
 * take no new space across the kept runs. On the backup volume itself:
 * `USER_DATA_DIR` is another volume, so links straight from it can't be.
 */
export const PARTS_MIRROR = 'parts';
const PART_ID = /^[a-f0-9-]{8,64}$/;
const PARTITION = /^\d{4}-\d{2}(-\d{2})?$/;

/**
 * Links the parts a copied dataset's catalog lists (live, and retired but
 * not swept) into the run, beside the copy: `<id>.parts/<table>/<partition>/
 * <part>.parquet`. A listed part missing on disk is counted, not fatal.
 */
function linkParts(copy: string, source: string, mirror: string) {
    const out = { parts: 0, missing: 0 };
    const listed = (() => {
        const db = new DatabaseSync(copy, { readOnly: true });
        try {
            const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_olap_parts'").get();
            return has
                ? (db.prepare('SELECT id, table_id AS tableId, partition FROM _olap_parts').all() as Array<{
                      id: string;
                      tableId: string;
                      partition: string;
                  }>)
                : [];
        } finally {
            db.close();
        }
    })();
    if (!listed.length) {
        return out;
    }
    const dataset = source.slice(source.lastIndexOf(sep) + 1).replace(/\.sqlite$/, '');
    const sourceParts = source.replace(/\.sqlite$/, '.parts');
    const copyParts = copy.replace(/\.sqlite$/, '.parts');
    for (const part of listed) {
        if (!PART_ID.test(part.id) || !PART_ID.test(part.tableId) || !PARTITION.test(part.partition)) {
            out.missing++;
            continue;
        }
        const mirrored = join(mirror, dataset, `${part.id}.parquet`);
        if (!existsFile(mirrored)) {
            const from = join(sourceParts, part.tableId, part.partition, `${part.id}.parquet`);
            if (!existsFile(from)) {
                out.missing++;
                continue;
            }
            mkdirSync(dirname(mirrored), { recursive: true });
            copyFileSync(from, `${mirrored}.tmp`);
            chmodSync(`${mirrored}.tmp`, 0o400);
            renameSync(`${mirrored}.tmp`, mirrored);
        }
        const into = join(copyParts, part.tableId, part.partition, `${part.id}.parquet`);
        mkdirSync(dirname(into), { recursive: true });
        linkSync(mirrored, into);
        out.parts++;
    }
    return out;
}

/** Drops mirrored parts no kept run links any more (only the mirror's own link is left). */
export function pruneParts(directory: string) {
    const mirror = join(directory, PARTS_MIRROR);
    let removed = 0;
    for (const file of filesUnder(mirror)) {
        const path = join(mirror, ...file.split('/'));
        try {
            if (path.endsWith('.tmp') || statSync(path).nlink <= 1) {
                rmSync(path, { force: true });
                removed++;
            }
        } catch {
            // Gone meanwhile.
        }
    }
    pruneEmpty(mirror);
    return removed;
}

/**
 * Keeps the newest `keep` database copies and `userdata-…` directories.
 * Scheduled runs prune only once a run is complete, so failed ones never
 * push good backups out.
 */
export function pruneBackups(directory: string, keep: number) {
    checkKeep(keep);
    const removed = [
        ...prune(directory, NAME, keep, (path) => rmSync(path)),
        ...prune(directory, USERDATA, keep, (path) => rmSync(path, { recursive: true, force: true })),
    ];
    // Parts only the pruned runs linked (CB-369).
    pruneParts(directory);
    return removed;
}

/** What the mirror knows of an object: enough to tell it changed. */
export interface MirroredObject {
    size: number;
    etag?: string;
    modified?: number;
}
export type MirrorManifest = Record<string, MirroredObject>;

/** Unchanged: the same size and ETag, or without ETags the same LastModified. */
export function sameObject(known: MirroredObject, listed: ListedObject) {
    if (known.size !== listed.size) {
        return false;
    }
    if (known.etag && listed.etag) {
        return known.etag === listed.etag;
    }
    return known.modified !== undefined && listed.modified !== undefined && known.modified === listed.modified;
}

export function readManifest(path: string): MirrorManifest {
    try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        return value && typeof value === 'object' && !Array.isArray(value) ? (value as MirrorManifest) : {};
    } catch {
        return {};
    }
}
/** Atomic, private: a temporary file, then a rename. */
export function writePrivate(path: string, body: Uint8Array | string) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
}

/** Every regular file under `root`, as `/`-separated relative paths. */
export function filesUnder(root: string): string[] {
    if (!existsSync(root)) {
        return [];
    }
    const found: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(path);
            } else if (entry.isFile()) {
                found.push(relative(root, path).split(sep).join('/'));
            }
        }
    };
    walk(root);
    return found.sort();
}
/** Removes empty directories under `root` (not `root` itself). */
function pruneEmpty(root: string) {
    if (!existsSync(root)) {
        return;
    }
    const walk = (dir: string): boolean => {
        let empty = true;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory() || !walk(join(dir, entry.name))) {
                empty = false;
            }
        }
        if (empty && dir !== root) {
            rmdirSync(dir);
        }
        return empty;
    };
    walk(root);
}

/**
 * An object into `path`, atomically and privately as `writePrivate`
 * writes: streamed where the store can (CB-378), so a large object never
 * sits in memory whole. Its size, or `undefined` when it is gone.
 */
async function fetchObject(store: ObjectStore, key: string, path: string) {
    if (!store.getFile) {
        const body = await store.get(key);
        if (body) {
            writePrivate(path, body);
        }
        return body?.length;
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    try {
        const size = await store.getFile(key, tmp);
        if (size === undefined) {
            rmSync(tmp, { force: true });
            return undefined;
        }
        renameSync(tmp, path);
        return size;
    } catch (error) {
        rmSync(tmp, { force: true });
        throw error;
    }
}

/**
 * With S3 (CB-54, CB-63): keeps `mirror` an incremental copy of the
 * objects under `prefix`, still sealed, key by key: an object is fetched
 * only when its size and ETag (or LastModified) differ from the manifest's,
 * and objects gone from the source are removed. Writes are atomic, and the
 * manifest is saved as it goes, so an interrupted run resumes where it
 * stopped. Restoring needs the data key the objects are sealed with.
 */
export async function mirrorObjects(store: ObjectStore, prefix: string, mirror: string, manifestPath: string) {
    const manifest = readManifest(manifestPath);
    const seen = new Set<string>();
    let fetched = 0;
    let unchanged = 0;
    let bytes = 0;
    let fetchedBytes = 0;
    let cursor: string | undefined;
    mkdirSync(mirror, { recursive: true });
    try {
        do {
            const page = await store.list(prefix, cursor);
            for (const listed of page.keys) {
                const path = join(mirror, ...checkKey(listed.key).split('/'));
                const known = manifest[listed.key];
                if (known && sameObject(known, listed) && existsFile(path) && statSync(path).size === listed.size) {
                    seen.add(listed.key);
                    unchanged++;
                    bytes += listed.size;
                    continue;
                }
                const size = await fetchObject(store, listed.key, path);
                // Deleted since the listing.
                if (size === undefined) {
                    continue;
                }
                seen.add(listed.key);
                // A change between the listing and the GET shows next time.
                manifest[listed.key] = {
                    size,
                    ...(listed.etag ? { etag: listed.etag } : {}),
                    ...(listed.modified !== undefined ? { modified: listed.modified } : {}),
                };
                fetched++;
                bytes += size;
                fetchedBytes += size;
                if (fetched % 100 === 0) {
                    writePrivate(manifestPath, JSON.stringify(manifest));
                }
            }
            cursor = page.next;
        } while (cursor);
    } catch (error) {
        // What was fetched so far counts: the next run skips it.
        writePrivate(manifestPath, JSON.stringify(manifest));
        throw error;
    }
    // Gone from the source (or left by a crash): removed from the mirror.
    let removed = 0;
    for (const file of filesUnder(mirror)) {
        if (!seen.has(file)) {
            rmSync(join(mirror, ...file.split('/')), { force: true });
            if (!file.endsWith('.tmp')) {
                removed++;
            }
        }
    }
    for (const key of Object.keys(manifest)) {
        if (!seen.has(key)) {
            delete manifest[key];
        }
    }
    pruneEmpty(mirror);
    writePrivate(manifestPath, JSON.stringify(manifest));
    return {
        objects: seen.size,
        fetched,
        unchanged,
        removed,
        bytes,
        fetchedBytes,
    };
}

/**
 * The mirror as of this backup, in `<target>/objects/`: hard links, so
 * unchanged objects take no space, and an object deleted or replaced later
 * stays in this backup until it is pruned (BACKUP_KEEP). Copies where links
 * aren't possible. Written to `objects.partial` first.
 */
export function snapshotObjects(mirror: string, target: string) {
    const partial = join(target, 'objects.partial');
    rmSync(partial, { recursive: true, force: true });
    const files = filesUnder(mirror);
    for (const file of files) {
        const from = join(mirror, ...file.split('/'));
        const to = join(partial, ...file.split('/'));
        mkdirSync(dirname(to), { recursive: true });
        try {
            linkSync(from, to);
        } catch {
            copyFileSync(from, to);
            chmodSync(to, 0o600);
        }
    }
    mkdirSync(partial, { recursive: true });
    rmSync(join(target, 'objects'), { recursive: true, force: true });
    renameSync(partial, join(target, 'objects'));
    return { path: join(target, 'objects'), objects: files.length };
}

/** Bytes of the regular files under `path` (or of `path`). */
export function sizeOf(path: string): number {
    if (!existsSync(path)) {
        return 0;
    }
    const info = statSync(path);
    if (info.isFile()) {
        return info.size;
    }
    return filesUnder(path).reduce((total, file) => total + statSync(join(path, ...file.split('/'))).size, 0);
}
