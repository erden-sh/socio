import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writePrivate } from '@socio/data/backup';
import { checkPrefix, type ObjectStore } from '@socio/data/object-store';
import type { SecretBox } from '@socio/foundation/keys/secret-box';

import { BACKUP_CONTEXT, SEALED, listAll } from './backup-offsite.js';

/**
 * Litestream 0.5's file names: `<min txid>-<max txid>.ltx`, 16 hex digits
 * each. It writes `<name>.tmp` and renames it when the file is synced, so a
 * file being written never matches.
 */
export const LTX_NAME = /^[0-9a-f]{16}-[0-9a-f]{16}\.ltx$/;
const LEVEL = /^\d+$/;
/** An LTX file starts with `LTX1` and a 100-byte header, and ends in a 16-byte trailer. */
const LTX_MAGIC = Buffer.from('LTX1', 'ascii');
const LTX_HEADER = 100;
const LTX_TRAILER = 16;
/**
 * Where the files go under BACKUP_S3_PREFIX:
 * `litestream/<lineage>/ltx/<level>/<name>.ltx.sealed`. Each lineage is one
 * replica as one copy sent it, restorable on its own.
 */
export const LTX_REMOTE = 'litestream/';
/** A key under a lineage's `ltx/`: its `<level>/<name>`. */
const LEVEL_FILE = /^(\d+)\/([0-9a-f]{16}-[0-9a-f]{16}\.ltx)\.sealed$/;
/** A key under `litestream/`: its lineage, level and name. */
const REMOTE_FILE = /^([^/]+)\/ltx\/(\d+)\/([0-9a-f]{16}-[0-9a-f]{16}\.ltx)\.sealed$/;
/** The longest wait after failures. */
export const LTX_BACKOFF_MAX_MS = 30 * 60_000;

/** Whether the bytes are a whole LTX file, as far as its frame shows. */
export function isLtx(body: Uint8Array) {
    return body.length >= LTX_HEADER + LTX_TRAILER && Buffer.from(body.subarray(0, 4)).equals(LTX_MAGIC);
}

/** When the file's transaction was written: its header's timestamp (ms). */
export function ltxTimestamp(body: Uint8Array) {
    if (!isLtx(body)) {
        return undefined;
    }
    const at = Number(Buffer.from(body).readBigInt64BE(32));
    // Anything else isn't a time Litestream wrote.
    return at > Date.UTC(2020, 0, 1) && at < Date.UTC(2100, 0, 1) ? at : undefined;
}

/** One file sent: the local file as it was, and the sealed object. */
interface SentFile {
    size: number;
    modified: number;
    sha256: string;
    /** The data key it was sealed under (its id). */
    key: string;
    /** The sealed object's size. */
    sealed: number;
}

/** What the copy remembers (BACKUP_DIR/offsite-ltx.json). */
export interface LtxState {
    /**
     * The lineage it sends to. A new one starts when this file is new (a new
     * host, or its backups lost), when Litestream started over, or when the
     * lineage off-site has a file this copy didn't send or is ahead of the
     * replica (this file restored from an older copy, or shared by two
     * hosts), so a copy doesn't remove or overwrite files it didn't send.
     */
    lineage?: string;
    /** `<level>/<name>` → the file as sent. */
    sent: Record<string, SentFile>;
    /**
     * Files a send may have put without recording them in `sent` yet, saved
     * before the first put: a crash mid-send leaves them known as this copy's.
     */
    sending?: string[];
    lastAttemptAt?: number;
    /** When the last send that left nothing waiting started. */
    lastSentAt?: number;
    /** Files the last send left for the next one. */
    waiting?: number;
    /** Sends that failed in a row. */
    failures?: number;
    lastErrorAt?: number;
    lastError?: string;
}

export function readLtxState(path: string): LtxState {
    try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LtxState>;
        const sent = value.sent;
        return {
            ...value,
            sent: sent && typeof sent === 'object' && !Array.isArray(sent) ? sent : {},
            sending: Array.isArray(value.sending) ? value.sending : [],
        };
    } catch {
        return { sent: {}, sending: [] };
    }
}

/**
 * The replica's files, as `<level>/<name>`, level by level from the lowest.
 * Litestream writes a compacted file into the next level before it removes
 * the files it replaces, so in this order a file gone from one level has
 * its replacement listed in a later one.
 *
 * No `ltx/` at all is an empty replica (Litestream not started yet). A
 * directory that can't be read is `unreadable`, and a level gone while it
 * was listed (`ENOENT`) is `vanished`: either way the listing is short of
 * files Litestream has, so nothing off-site is removed by it.
 */
function listReplica(replica: string) {
    const root = join(replica, 'ltx');
    const files: string[] = [];
    let unreadable: string | undefined;
    let vanished = 0;
    const code = (error: unknown) => String((error as NodeJS.ErrnoException)?.code ?? 'unknown error');
    let levels: string[];
    try {
        levels = readdirSync(root).filter((name) => LEVEL.test(name));
    } catch (error) {
        if (code(error) !== 'ENOENT') {
            unreadable = code(error);
        }
        return { files, unreadable, vanished };
    }
    for (const level of levels.sort((a, b) => Number(a) - Number(b))) {
        let names: string[];
        try {
            names = readdirSync(join(root, level));
        } catch (error) {
            if (code(error) === 'ENOENT') {
                vanished++;
            } else {
                unreadable ??= code(error);
            }
            continue;
        }
        for (const name of names.filter((name) => LTX_NAME.test(name)).sort()) {
            files.push(`${level}/${name}`);
        }
    }
    return { files, unreadable, vanished };
}

export interface ContinuousOffsite {
    /** The off-site target (BACKUP_S3_*). */
    target: ObjectStore;
    /** `BACKUP_S3_PREFIX`: empty or ending in `/`. */
    prefix: string;
    /** The `backups` box: files are sealed under the data key. */
    box: SecretBox;
    /** LITESTREAM_REPLICA_DIR: its `ltx/<level>/` files are sent. */
    replica: string;
    /** Where the copy remembers what it sent (BACKUP_DIR/offsite-ltx.json). */
    state: string;
    /** A failure's short reason for the status, naming no path or key. */
    reason: (error: unknown) => string;
    now?: () => number;
}

/** A lineage's id: when it started, then a random part, so ids sort by age. */
export function newLineage(at: number) {
    const time = new Date(at).toISOString().replace(/[-:]|\.\d+/g, '');
    return `${time}-${randomBytes(3).toString('hex')}`;
}
/** The highest transaction of `<level>/<min>-<max>.ltx` files. */
function highestTxid(files: Iterable<string>) {
    let highest = 0n;
    for (const file of files) {
        const txid = BigInt(`0x${file.slice(-20, -4)}`);
        if (txid > highest) {
            highest = txid;
        }
    }
    return highest;
}
/** A `<level>/<min>-<max>.ltx` file's level and transactions. */
function span(file: string) {
    return {
        level: Number(file.slice(0, file.indexOf('/'))),
        min: BigInt(`0x${file.slice(-37, -21)}`),
        max: BigInt(`0x${file.slice(-20, -4)}`),
    };
}
/**
 * Whether `cover` holds what `file` holds, as Litestream replaces files:
 * compacted into a higher level, or a newer snapshot (level 9, from
 * transaction 1) in place of an older one.
 */
function covers(cover: string, file: string) {
    if (cover === file) {
        return false;
    }
    const a = span(cover);
    const b = span(file);
    return a.level >= b.level && a.min <= b.min && a.max >= b.max;
}

const sha256 = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
const mtime = (path: string) => {
    try {
        const stat = statSync(path);
        return { size: stat.size, modified: Math.round(stat.mtimeMs) };
    } catch {
        return undefined;
    }
};

/**
 * Sends the continuous copy off-site (CB-112): each new file of
 * Litestream's file replica, sealed under the data key like the rest of the
 * off-site copy, to `litestream/<lineage>/ltx/<level>/<name>.ltx.sealed`.
 * Incremental: a file goes when the target lacks it or it changed (size,
 * then hash); what was sent is in `state`, so a restart sends nothing twice.
 *
 * Only whole files go: Litestream renames each into place once written, and
 * one that isn't an LTX file, or changes while read, waits for the next
 * send. They go from the highest level down, the snapshots first and level
 * 0 last, each level from its oldest file, and a file that can't go (gone
 * before it was read, or waiting) and isn't off-site holds back the rest of
 * its level and the levels below it until the next send. Compaction and
 * retention are mirrored as far as a restore allows: a file Litestream
 * removed is removed off-site only when this copy sent it and another file
 * it sent, off-site as sent, holds the same transactions (compacted into a
 * higher level, or a newer snapshot). Nothing is removed while a file
 * waits (it may be the one that replaces them), when one went before it
 * was read, or when the replica has no files or can't all be read.
 *
 * So after every send, whole or cut short at any point, the newest lineage
 * holds a set Litestream can restore from (a snapshot, then transactions
 * with no gap), up to a transaction as recent as before the send or more.
 * Sent from level 0 up, a send cut short after level 0's newest files
 * could leave out the level 1 file that replaced the ones before them, and
 * a restore would stop at the gap.
 *
 * All of it happens within this copy's lineage. It starts a new one, and
 * leaves the others as they are, for a restore and for an admin to remove:
 * without a state file (a new host after a disaster, say), once Litestream
 * started over (its highest transaction is below the one sent, by a
 * listing of every level), or when the lineage off-site has a file this
 * copy didn't send or newer than the replica's (the state file restored
 * from an older copy, or a second host sending with a copy of it).
 */
export async function shipContinuousCopy(copy: ContinuousOffsite) {
    const now = copy.now ?? Date.now;
    const { target, box } = copy;
    const base = `${checkPrefix(copy.prefix)}${LTX_REMOTE}`;
    const state = readLtxState(copy.state);
    const startedAt = now();
    state.lastAttemptAt = startedAt;
    const save = () => writePrivate(copy.state, JSON.stringify(state));
    let sent = 0;
    let bytes = 0;
    let waiting = 0;
    let removed = 0;
    /** Removed before it was read and not off-site: its replacement may not be listed yet. */
    let missed = 0;
    const replica = listReplica(copy.replica);
    const local = replica.files;
    const listed = new Set(local);
    /** A lineage this send started, and how many others the target has. */
    let started: { lineage: string; others: number } | undefined;
    /** Files an earlier send may have put without recording them. */
    let sending = new Set(state.sending);
    /** Recorded as sent and off-site as sent, or maybe put by a send cut short. */
    const own = (file: string, size: number | undefined) => sending.has(file) || state.sent[file]?.sealed === size;
    try {
        await target.ensureReady();
        let root = `${base}${state.lineage}/ltx/`;
        /** A key of the lineage as `<level>/<name>`, unless it is something else. */
        const fileOf = (remote: string) => {
            const match = remote.slice(root.length).match(LEVEL_FILE);
            return match ? `${match[1]}/${match[2]}` : undefined;
        };
        let there = state.lineage ? await listAll(target, root) : new Map<string, number>();
        const offsite = [...there].flatMap(([remote, size]) => {
            const file = fileOf(remote);
            return file ? [{ file, size }] : [];
        });
        // Behind only by a whole listing: without a level (level 0 unreadable,
        // say) the replica's highest transaction looks lower than it is.
        const whole = !replica.unreadable && !replica.vanished;
        if (
            local.length &&
            (!state.lineage ||
                (whole &&
                    highestTxid(local) <
                        highestTxid([...Object.keys(state.sent), ...offsite.map(({ file }) => file)])) ||
                offsite.some(({ file, size }) => !own(file, size)))
        ) {
            const lineage = newLineage(startedAt);
            const others = new Set(
                [...(await listAll(target, base)).keys()].flatMap(
                    (key) => key.slice(base.length).match(REMOTE_FILE)?.[1] ?? [],
                ),
            );
            Object.assign(state, { lineage, sent: {}, sending: [] });
            sending = new Set();
            // Recorded before anything goes, so a crash doesn't start another.
            save();
            started = { lineage, others: others.size };
            root = `${base}${lineage}/ltx/`;
            there = await listAll(target, root);
        }
        const current = (entry: SentFile | undefined, size: number, remote: string) =>
            entry && entry.size === size && entry.key === box.currentKey && there.get(remote) === entry.sealed;
        // Removed since the listing: compacted into a file this send or the
        // next one sends. Whether it is missing off-site.
        const gone = (file: string, remote: string) => {
            const previous = state.sent[file];
            if (previous && there.get(remote) === previous.sealed) {
                return false;
            }
            missed++;
            return true;
        };
        const due: Array<{
            file: string;
            path: string;
            remote: string;
            /** None when it went since the listing. */
            before?: { size: number; modified: number };
        }> = [];
        // The highest level first, each level from its oldest file. Litestream
        // writes a file into a higher level before it removes the lower ones it
        // replaces, so whatever a send puts before it stops follows on from
        // what is off-site, with no gap in the transactions; a file that can't
        // go and isn't off-site holds back the rest (below).
        const order = [...local].sort((a, b) => span(b).level - span(a).level || (a < b ? -1 : 1));
        for (const file of order) {
            const path = join(copy.replica, 'ltx', ...file.split('/'));
            const remote = `${root}${file}${SEALED}`;
            const before = mtime(path);
            const previous = state.sent[file];
            if (!before) {
                due.push({ file, path, remote });
            } else if (
                sending.has(file) ||
                !current(previous, before.size, remote) ||
                previous!.modified !== before.modified
            ) {
                due.push({ file, path, remote, before });
            }
        }
        // Recorded before the first put, so a crash midway can't leave a file
        // off-site that this copy doesn't know it sent.
        const earlier = sending;
        const going = due.filter(({ before }) => before).map(({ file }) => file);
        if (going.some((file) => !sending.has(file))) {
            sending = new Set([...earlier, ...going]);
            state.sending = [...sending];
            save();
        }
        const put = new Set<string>();
        /**
         * A file that can't go and isn't off-site: what comes after it in this
         * level, and the levels below, would leave a gap in the transactions
         * (its replacement may be in a higher level listed before it was
         * written), so they wait for the next send.
         */
        let held = false;
        for (const { file, path, remote, before } of due) {
            const previous = state.sent[file];
            if (!before) {
                if (gone(file, remote)) {
                    held = true;
                }
                continue;
            }
            if (held) {
                waiting++;
                continue;
            }
            let body: Buffer;
            try {
                body = readFileSync(path);
            } catch {
                held = gone(file, remote);
                continue;
            }
            const after = mtime(path);
            if (
                !after ||
                after.size !== before.size ||
                after.modified !== before.modified ||
                body.length !== before.size ||
                !isLtx(body)
            ) {
                waiting++;
                held = !there.has(remote);
                continue;
            }
            const hash = sha256(body);
            if (!earlier.has(file) && current(previous, body.length, remote) && previous!.sha256 === hash) {
                state.sent[file] = { ...previous!, modified: after.modified };
                continue;
            }
            const sealed = box.sealBytes(body, BACKUP_CONTEXT);
            await target.put(remote, sealed);
            there.set(remote, sealed.length);
            put.add(file);
            state.sent[file] = {
                size: body.length,
                modified: after.modified,
                sha256: hash,
                key: box.currentKey,
                sealed: sealed.length,
            };
            sent++;
            bytes += sealed.length;
            if (sent % 20 === 0) {
                save();
            }
        }
        // Compaction and retention, once everything the replica has is there:
        // only files this copy sent, each once another holds its transactions.
        const complete = !waiting && !missed && whole;
        if (listed.size && complete) {
            /** Off-site as sent, the highest levels first. */
            const confirmed = local
                .filter(
                    (file) => !!state.sent[file] && there.get(`${root}${file}${SEALED}`) === state.sent[file].sealed,
                )
                .reverse();
            for (const [remote, size] of there) {
                const file = fileOf(remote);
                if (!file || listed.has(file) || !own(file, size)) {
                    continue;
                }
                if (!confirmed.some((cover) => covers(cover, file))) {
                    continue;
                }
                await target.delete(remote);
                there.delete(remote);
                delete state.sent[file];
                removed++;
            }
        }
        for (const file of Object.keys(state.sent)) {
            if (!listed.has(file) && !there.has(`${root}${file}${SEALED}`)) {
                delete state.sent[file];
            }
        }
        // Still this copy's: put by a send cut short, and not sent again since.
        state.sending = [...earlier].filter((file) => !put.has(file) && there.has(`${root}${file}${SEALED}`));
        if (replica.unreadable) {
            throw new Error(
                `Some of the continuous copy's files can't be read (${replica.unreadable}); nothing off-site is removed until they can.`,
            );
        }
        Object.assign(state, {
            waiting,
            failures: 0,
            lastErrorAt: undefined,
            lastError: undefined,
            ...(complete && local.length ? { lastSentAt: startedAt } : {}),
        });
        save();
    } catch (error) {
        state.waiting = Math.max(waiting, local.filter((file) => !state.sent[file]).length);
        state.failures = (state.failures ?? 0) + 1;
        state.lastErrorAt = startedAt;
        state.lastError = copy.reason(error);
        save();
        throw error;
    }
    return {
        files: local.length,
        sent,
        bytes,
        waiting,
        removed,
        ...(started ? { started } : {}),
    };
}

/** How long to wait after a send: the interval, doubled for each failure in a row. */
export function ltxWaitMs(intervalSeconds: number, failures = 0) {
    const interval = intervalSeconds * 1000;
    if (!failures) {
        return interval;
    }
    return Math.max(interval, Math.min(interval * 2 ** failures, LTX_BACKOFF_MAX_MS));
}

/** The lineages off-site, the newest first: each one's files and highest transaction. */
export async function listContinuousCopies(target: ObjectStore, prefix: string) {
    const base = `${checkPrefix(prefix)}${LTX_REMOTE}`;
    const lineages = new Map<string, string[]>();
    for (const key of (await listAll(target, base)).keys()) {
        const match = key.slice(base.length).match(REMOTE_FILE);
        if (!match) {
            continue;
        }
        const files = lineages.get(match[1]) ?? [];
        files.push(`${match[2]}/${match[3]}`);
        lineages.set(match[1], files);
    }
    return [...lineages]
        .sort(([a], [b]) => (a < b ? 1 : -1))
        .map(([lineage, files]) => ({
            lineage,
            files: files.length,
            highestTxid: highestTxid(files),
        }));
}

/**
 * A few sealed files of the newest lineage off-site, as stored, picked at
 * random (CB-322): what a recovery key check tries to open. None when
 * nothing is off-site.
 */
export async function sampleContinuousCopy(
    target: ObjectStore,
    prefix: string,
    count: number,
    random: () => number = Math.random,
): Promise<Buffer[]> {
    const [newest] = await listContinuousCopies(target, prefix);
    if (!newest) {
        return [];
    }
    const root = `${checkPrefix(prefix)}${LTX_REMOTE}${newest.lineage}/ltx/`;
    const keys = [...(await listAll(target, root)).keys()].filter((key) => LEVEL_FILE.test(key.slice(root.length)));
    const picked: Buffer[] = [];
    while (keys.length && picked.length < count) {
        const [key] = keys.splice(Math.floor(random() * keys.length), 1);
        const sealed = await target.get(key!);
        if (sealed) {
            picked.push(Buffer.from(sealed));
        }
    }
    return picked;
}

/**
 * Downloads the continuous copy from the off-site target and opens it into
 * `directory` as a Litestream file replica (`ltx/<level>/<name>`, each file
 * dated by its header), for `litestream restore -o <db> file://<directory>`.
 * The directory must be new or empty. It lists again until a listing
 * brings nothing new, so files the app sent meanwhile are there too.
 *
 * With more than one lineage off-site (a new host started sending before
 * the restore, say), it takes the one named and refuses to guess.
 */
export async function fetchContinuousCopy(options: {
    target: ObjectStore;
    prefix: string;
    box: SecretBox;
    directory: string;
    lineage?: string;
}): Promise<{
    lineage?: string;
    files: number;
    bytes: number;
    newestAt?: number;
}> {
    const { target, box, directory } = options;
    let existing: string[] = [];
    try {
        existing = readdirSync(directory);
    } catch {
        // New.
    }
    if (existing.length) {
        throw new Error('The directory for the replica must be new or empty.');
    }
    const copies = await listContinuousCopies(target, options.prefix);
    const lineage = options.lineage ?? copies[0]?.lineage;
    if (options.lineage && !copies.some((copy) => copy.lineage === lineage)) {
        throw new Error(`The off-site copy has no lineage ${options.lineage}.`);
    }
    if (!options.lineage && copies.length > 1) {
        throw new Error(
            [
                `The off-site copy has ${copies.length} lineages of the continuous copy; name the one to restore (the newest first):`,
                ...copies.map(
                    (copy) => `  ${copy.lineage}: ${copy.files} file(s), up to transaction ${copy.highestTxid}`,
                ),
            ].join('\n'),
        );
    }
    if (!lineage) {
        return { files: 0, bytes: 0 };
    }
    const root = `${checkPrefix(options.prefix)}${LTX_REMOTE}${lineage}/ltx/`;
    const fetched = new Set<string>();
    let bytes = 0;
    let newestAt: number | undefined;
    for (let round = 0; round < 10; round++) {
        const keys = [...(await listAll(target, root)).keys()].filter(
            (key) => !fetched.has(key) && LEVEL_FILE.test(key.slice(root.length)),
        );
        if (!keys.length) {
            break;
        }
        for (const key of keys.sort()) {
            fetched.add(key);
            const sealed = await target.get(key);
            // Removed since the listing: replaced by a file the next one shows.
            if (!sealed) {
                continue;
            }
            const body = box.openBytes(sealed, BACKUP_CONTEXT);
            const [, level, name] = key.slice(root.length).match(LEVEL_FILE)!;
            const path = join(directory, 'ltx', level, name);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(`${path}.tmp`, body, { mode: 0o600 });
            renameSync(`${path}.tmp`, path);
            const at = ltxTimestamp(body);
            if (at !== undefined) {
                utimesSync(path, at / 1000, at / 1000);
                if (newestAt === undefined || at > newestAt) {
                    newestAt = at;
                }
            }
            bytes += body.length;
        }
    }
    const files = listReplica(directory).files.length;
    return {
        lineage,
        files,
        bytes,
        ...(newestAt !== undefined ? { newestAt } : {}),
    };
}
