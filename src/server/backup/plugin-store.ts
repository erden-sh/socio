/**
 * The plugin snapshot store (CB-458): `BACKUP_DIR/plugins/<id>/`, one per
 * plugin.
 *
 * - `chunks/<sha256>.sealed`: content-addressed, each chunk stored once and
 *   referenced by every snapshot that lists it (the analytical parts'
 *   pattern, per chunk). Sealed under the data key (purpose `backups`),
 *   bound to the plugin id and the chunk's hash, so a chunk can't be moved
 *   to another plugin or another name.
 * - `snapshots/<stamp>-<snapshotId>.json`: the host's record of one
 *   snapshot (the checked manifest plus the install it was taken under),
 *   sealed too, bound to the plugin id and the snapshot id.
 *
 * Taking a snapshot: the plugin's `ready` answer is read under its cap and
 * checked against the installed plugin and the limits before anything is
 * fetched; then every chunk the store doesn't have is fetched, counted
 * against its declared size, hashed and sealed as it streams, and renamed
 * in only once its hash and size match. The record is written last, so a
 * failed snapshot leaves only unreferenced chunks, which the sweep removes.
 * The store is per plugin: a chunk one plugin has is never "already
 * present" for another.
 *
 * `prune` keeps run snapshots with their run, the newest three of each
 * other reason, and uninstall snapshots for PURGE_BACKUP_DAYS, and each
 * plugin's newest snapshot past those (`retainedPastRules`, the owner's
 * decision, 2026-11-23), then sweeps every chunk no kept snapshot lists.
 * `verify` is the level 1 drill: every chunk re-read, opened and hashed,
 * and every database assembled into scratch and checked in a worker.
 *
 * The source is the caller's (`plugin-source.ts` for the HTTP protocol,
 * driven by `plugin-snapshots.ts`). Callers hold the backup run's lock; the
 * store also runs one operation per plugin at a time within its process.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open, rename, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { writeAll } from '@socio/foundation/keys/sealed-files';
import { LEGACY_KEY, SEALED_START, type SecretBox } from '@socio/foundation/keys/secret-box';
import type { PluginSnapshotReason } from '@socio/shared/plugins/plugin-backup';
import { PLUGIN_ID } from '@socio/shared/plugins/plugin-service';
import {
    PLUGIN_MANIFEST_MAX_BYTES,
    PLUGIN_SNAPSHOT_ID,
    PluginSnapshotError,
    checkSnapshotManifest,
    itemChunkSize,
    itemChunks,
    snapshotBytes,
    type PluginSnapshotManifest,
} from '@socio/shared/plugins/plugin-snapshot';

/** `BACKUP_DIR/plugins`. */
export const PLUGIN_STORE = 'plugins';
/** For preparing and fetching, per plugin per run. */
export const PLUGIN_SNAPSHOT_TIME_MS = 30 * 60_000;
/** Snapshots outside a run kept per plugin, per reason. */
export const PLUGIN_OUT_OF_RUN_KEEP = 3;
/** Free space on BACKUP_DIR: the new chunks' bytes plus this share. */
export const PLUGIN_FREE_SPACE_MARGIN = 0.1;
/**
 * For the `DELETE` that ends a snapshot, on its own clock: it runs after a
 * fetch that ran out of time too, and a plugin that never answers it must
 * not hold the plugin's lock (the plugin's lease drops its copy anyway).
 */
export const PLUGIN_END_TIME_MS = 30_000;
/** The level 1 drill's time for one database's integrity check. */
export const PLUGIN_CHECK_TIME_MS = 10 * 60_000;
/** The most a stored record may take: the manifest's cap, the host's fields and the seal. */
const RECORD_MAX_BYTES = 2 * PLUGIN_MANIFEST_MAX_BYTES;
const DAY = 24 * 3_600_000;
/** The GCM tag's length, as `sealed-files.ts` writes it. */
const TAG = 16;

export type { PluginSnapshotReason };
const REASONS: readonly PluginSnapshotReason[] = ['scheduled', 'manual', 'request', 'pre-update', 'uninstall'];

/** A run's stamp, as the database copy names it: `YYYYMMDD-HHMMSS`, with a same-second suffix. */
const RUN_STAMP = /^\d{8}-\d{6}(?:-\d+)?$/;
const RECORD_NAME = /^(\d{8}-\d{6}(?:-\d+)?)-([0-9A-HJKMNP-TV-Z]{26})\.json$/;
const CHUNK_NAME = /^([0-9a-f]{64})\.sealed$/;
const DATABASE_COPY = /^company-brain-(\d{8}-\d{6}(?:-\d+)?)\.sqlite$/;

const stampOf = (time: number) => new Date(time).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** The seal's binding for one chunk: this plugin, this hash. */
export const chunkContext = (pluginId: string, sha256: string) =>
    `company-brain plugin backup chunk ${pluginId} ${sha256}`;
/** The seal's binding for one snapshot's record. */
export const recordContext = (pluginId: string, snapshotId: string) =>
    `company-brain plugin backup snapshot ${pluginId} ${snapshotId}`;

/**
 * A snapshot the plugin has ready, as the store reads it. `plugin-source.ts`
 * implements it over `/__cb/backup/{snapshotId}`; tests use a fake plugin
 * server.
 */
export interface PluginSnapshotSource {
    /** The body of the `ready` answer: `{ state: 'ready', manifest }`. */
    manifest(signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
    /** Item `index` whole (`chunk` undefined, an item without a chunk list), or its chunk `chunk`. */
    item(index: number, chunk: number | undefined, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
    /** Drops the plugin's copy (`DELETE`): always called, failed or not, and cut off at `signal`. */
    end(signal: AbortSignal): Promise<void>;
}

/** The installed plugin a snapshot is taken under, from the host's own record. */
export interface PluginSnapshotInstall {
    version: string;
    /** `socio.plugin.revision`: the install revision (CB-370) it was taken under. */
    revision?: string;
    /** The installed manifest's `backup.schema`. */
    schema: number;
    /** Its non-ephemeral volumes, by name. */
    volumes: readonly string[];
    /** Its settings, offered on restore. */
    settings?: Record<string, unknown>;
}

export interface TakePluginSnapshot {
    pluginId: string;
    /** The host's id for it, a ULID. */
    snapshotId: string;
    reason: PluginSnapshotReason;
    /** The run's stamp, for a snapshot in a scheduled run (`reason: 'scheduled'`). */
    run?: string;
    install: PluginSnapshotInstall;
    /** The plugin's own reason, for one it asked for (`request`): at most 200 characters, shown in its history. */
    note?: string;
    /** The plugin's size cap: PLUGIN_SNAPSHOT_MAX_BYTES unless an admin raised it. */
    maxBytes?: number;
    source: PluginSnapshotSource;
    signal?: AbortSignal;
}

/** One snapshot as the store keeps it, sealed. */
export interface StoredPluginSnapshot {
    format: 1;
    pluginId: string;
    snapshotId: string;
    /** The run's stamp, or the time it was taken at. Its file is `<stamp>-<snapshotId>.json`. */
    stamp: string;
    run?: string;
    reason: PluginSnapshotReason;
    /** The plugin's own reason, for one it asked for. */
    note?: string;
    takenAt: number;
    install: { version: string; revision?: string; schema: number };
    settings: Record<string, unknown>;
    bytes: number;
    manifest: PluginSnapshotManifest;
}

export interface TakenPluginSnapshot {
    snapshot: StoredPluginSnapshot;
    /** Chunks fetched and stored, and their bytes. */
    fetched: { chunks: number; bytes: number };
    /** Chunks the store already had, sealed under the current key. */
    reused: number;
    /** Whether the plugin acknowledged `DELETE`. */
    ended: boolean;
}

export interface PluginVerifyResult {
    ok: boolean;
    chunks: number;
    bytes: number;
    databases: number;
    /** Why not, naming items by index, never by path. */
    error?: string;
}

export interface PluginPruneResult {
    removed: { pluginId: string; snapshotId: string }[];
    chunks: number;
    /** Records that couldn't be opened: kept, and their plugin's chunks not swept. */
    unreadable: { pluginId: string; file: string }[];
}

export interface PluginStoreDeps {
    /** BACKUP_DIR. */
    directory: string;
    /** The data key's box, purpose `backups`. */
    box: SecretBox;
    now?: () => number;
    /** Free bytes on BACKUP_DIR; `statfs` by default. */
    freeBytes?: (directory: string) => Promise<number>;
    /** PLUGIN_SNAPSHOT_TIME_MS by default. */
    timeMs?: number;
    /** PLUGIN_CHECK_TIME_MS by default. */
    checkMs?: number;
    /** PLUGIN_END_TIME_MS by default. */
    endMs?: number;
}

/** The stamps of the runs BACKUP_DIR keeps, by their database copies: what run snapshots follow. */
export function keptRunStamps(directory: string): string[] {
    try {
        return readdirSync(directory)
            .map((name) => name.match(DATABASE_COPY)?.[1])
            .filter((stamp): stamp is string => stamp !== undefined)
            .sort();
    } catch {
        return [];
    }
}

/** A new snapshot id: a ULID, 48 bits of time and 80 random. */
export function newSnapshotId(now = Date.now()) {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let time = '';
    for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) {
        time = alphabet[t % 32] + time;
    }
    const bytes = randomBytes(16);
    let random = '';
    for (let i = 0; i < 16; i++) {
        random += alphabet[bytes[i]! % 32];
    }
    return time + random;
}

/** The sealed bytes ahead of a chunk's plaintext: header, IV and tag. */
const sealOverhead = (key: string) => (key === LEGACY_KEY ? 4 : 12) + 12 + TAG;

async function readCapped(body: AsyncIterable<Uint8Array>, cap: number, signal: AbortSignal) {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const piece of body) {
        signal.throwIfAborted();
        size += piece.length;
        if (size > cap) {
            throw new PluginSnapshotError(`The manifest is over ${cap} bytes.`);
        }
        parts.push(Buffer.from(piece));
    }
    return Buffer.concat(parts);
}

/** The integrity check, in a worker, on a scratch copy: read-only, defensive, no trusted schema. */
const CHECK_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let ok = false;
try {
  const db = new DatabaseSync(workerData.path, { readOnly: true, defensive: true, allowExtension: false });
  try {
    db.exec('PRAGMA trusted_schema=OFF');
    const rows = db.prepare('PRAGMA integrity_check').all();
    ok = rows.length === 1 && rows[0].integrity_check === 'ok';
  } finally {
    db.close();
  }
} catch {
  ok = false;
}
parentPort.postMessage({ ok });`;

function checkScratch(path: string, timeMs: number) {
    return new Promise<boolean>((done) => {
        const worker = new Worker(CHECK_WORKER, { eval: true, workerData: { path }, execArgv: [] });
        const timer = setTimeout(() => {
            void worker.terminate();
            done(false);
        }, timeMs);
        const finish = (ok: boolean) => {
            clearTimeout(timer);
            done(ok);
        };
        worker.once('message', (message: { ok: boolean }) => finish(message.ok === true));
        worker.once('error', () => finish(false));
        worker.once('exit', () => finish(false));
    });
}

/**
 * The snapshots kept past the retention rules: an installed plugin's newest
 * good snapshot stays even after its run ages out of BACKUP_KEEP (or its
 * reason's newest three move on), until a newer one succeeds, so a plugin whose
 * snapshots keep failing never ends up with none. Every stored record is a good
 * snapshot: a failed one never writes its record. An uninstall snapshot is
 * never kept past PURGE_BACKUP_DAYS by this, and `prune` asks only for
 * installed plugins, so nothing outlives its plugin here.
 *
 * Decided by the owner on 2026-11-23 (CB-458, step 5): yes.
 */
export function retainedPastRules(
    records: readonly Pick<StoredPluginSnapshot, 'snapshotId' | 'takenAt' | 'reason'>[],
): Set<string> {
    let newest: Pick<StoredPluginSnapshot, 'snapshotId' | 'takenAt' | 'reason'> | undefined;
    for (const record of records) {
        if (!newest || record.takenAt >= newest.takenAt) {
            newest = record;
        }
    }
    return new Set(newest && newest.reason !== 'uninstall' ? [newest.snapshotId] : []);
}

export class PluginSnapshotStore {
    private readonly now: () => number;
    private readonly locks = new Map<string, Promise<unknown>>();

    constructor(private readonly deps: PluginStoreDeps) {
        this.now = deps.now ?? Date.now;
    }

    /** `BACKUP_DIR/plugins/<id>`. */
    pluginDir(pluginId: string) {
        if (!PLUGIN_ID.test(pluginId)) {
            throw new PluginSnapshotError('Not a plugin id.');
        }
        return join(this.deps.directory, PLUGIN_STORE, pluginId);
    }
    private chunkPath(pluginId: string, sha256: string) {
        return join(this.pluginDir(pluginId), 'chunks', `${sha256}.sealed`);
    }
    /** Where one stored chunk is, as stored (sealed): the off-site copy sends it as it is. */
    chunkFile(pluginId: string, sha256: string) {
        if (!/^[0-9a-f]{64}$/.test(sha256)) {
            throw new PluginSnapshotError('Not a chunk hash.');
        }
        return this.chunkPath(pluginId, sha256);
    }
    /** Where one snapshot's sealed record is, as stored. */
    recordFile(pluginId: string, entry: { file: string }) {
        return join(this.pluginDir(pluginId), 'snapshots', entry.file);
    }

    /** One operation per plugin at a time, in this process. */
    private exclusive<T>(pluginId: string, work: () => Promise<T>): Promise<T> {
        const before = this.locks.get(pluginId) ?? Promise.resolve();
        const run = before.then(work, work);
        const settled = run.then(
            () => undefined,
            () => undefined,
        );
        this.locks.set(pluginId, settled);
        void settled.then(() => {
            if (this.locks.get(pluginId) === settled) {
                this.locks.delete(pluginId);
            }
        });
        return run;
    }

    /**
     * Whether the store has this chunk, sealed under the current key and of
     * this size. One under an older key counts as missing: it's fetched
     * again and sealed under the current one, so a key rotation reaches the
     * chunks of every snapshot that lists them.
     */
    private async hasChunk(pluginId: string, sha256: string, size: number) {
        let file;
        try {
            file = await open(this.chunkPath(pluginId, sha256), 'r');
        } catch {
            return false;
        }
        try {
            const head = Buffer.alloc(SEALED_START);
            const { bytesRead } = await file.read(head, 0, head.length, 0);
            const key = this.deps.box.bytesKey(head.subarray(0, bytesRead));
            if (key === undefined || key !== this.deps.box.currentKey) {
                return false;
            }
            return (await file.stat()).size - sealOverhead(key) === size;
        } finally {
            await file.close();
        }
    }

    /**
     * One chunk from `body` into the store: counted while it streams and cut
     * at `size`, hashed, and sealed into a temporary file, renamed in only
     * when the size and hash match.
     */
    private async putChunk(
        pluginId: string,
        sha256: string,
        size: number,
        body: AsyncIterable<Uint8Array>,
        signal: AbortSignal,
        where: string,
    ) {
        const target = this.chunkPath(pluginId, sha256);
        const partial = `${target}.tmp-${randomUUID()}`;
        const { start, cipher } = this.deps.box.beginSeal(chunkContext(pluginId, sha256));
        const out = await open(partial, 'wx', 0o600);
        try {
            try {
                await writeAll(out, Buffer.concat([start, Buffer.alloc(TAG)]));
                const hash = createHash('sha256');
                let read = 0;
                for await (const piece of body) {
                    signal.throwIfAborted();
                    read += piece.length;
                    if (read > size) {
                        throw new PluginSnapshotError(`${where} is larger than declared.`);
                    }
                    hash.update(piece);
                    await writeAll(out, cipher.update(piece));
                }
                signal.throwIfAborted();
                if (read !== size) {
                    throw new PluginSnapshotError(`${where} is shorter than declared.`);
                }
                if (hash.digest('hex') !== sha256) {
                    throw new PluginSnapshotError(`${where} doesn't match its SHA-256.`);
                }
                const last = cipher.final();
                if (last.length) {
                    await writeAll(out, last);
                }
                await writeAll(out, cipher.getAuthTag(), start.length);
                await out.sync();
            } finally {
                await out.close();
            }
            await rename(partial, target);
        } catch (error) {
            await rm(partial, { force: true });
            throw error;
        }
    }

    /**
     * Takes one snapshot from `source` into the store. Throws
     * `PluginSnapshotError` (or the abort) on any failure, after calling
     * `source.end()`; what it stored then is only unreferenced chunks.
     */
    async take(request: TakePluginSnapshot): Promise<TakenPluginSnapshot> {
        const { pluginId, snapshotId, reason, run } = request;
        this.pluginDir(pluginId);
        if (!PLUGIN_SNAPSHOT_ID.test(snapshotId)) {
            throw new PluginSnapshotError('A snapshot id is a ULID.');
        }
        if (!REASONS.includes(reason)) {
            throw new PluginSnapshotError('Not a snapshot reason.');
        }
        if (request.note !== undefined && (typeof request.note !== 'string' || request.note.length > 200)) {
            throw new PluginSnapshotError('A note is at most 200 characters.');
        }
        if ((reason === 'scheduled') !== (run !== undefined) || (run !== undefined && !RUN_STAMP.test(run))) {
            throw new PluginSnapshotError("A scheduled snapshot names its run's stamp, and only it does.");
        }
        return this.exclusive(pluginId, async () => {
            const timeout = AbortSignal.timeout(this.deps.timeMs ?? PLUGIN_SNAPSHOT_TIME_MS);
            const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
            let ended = false;
            try {
                const taken = await this.fetchAll(request, signal);
                ended = await this.end(request.source);
                return { ...taken, ended };
            } finally {
                if (!ended) {
                    await this.end(request.source);
                }
            }
        });
    }

    private async end(source: PluginSnapshotSource) {
        const ms = this.deps.endMs ?? PLUGIN_END_TIME_MS;
        let timer: NodeJS.Timeout | undefined;
        try {
            // Bounded even when the source ignores the signal.
            await Promise.race([
                source.end(AbortSignal.timeout(ms)),
                new Promise<never>((_, fail) => {
                    timer = setTimeout(() => fail(new Error('The plugin didn’t end its snapshot in time.')), ms);
                }),
            ]);
            return true;
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    private async fetchAll(request: TakePluginSnapshot, signal: AbortSignal) {
        const { pluginId, snapshotId, source, install } = request;
        const dir = this.pluginDir(pluginId);
        const takenAt = this.now();
        const stamp = request.run ?? stampOf(takenAt);
        const recordPath = join(dir, 'snapshots', `${stamp}-${snapshotId}.json`);
        if (this.list(pluginId).some((entry) => entry.snapshotId === snapshotId)) {
            throw new PluginSnapshotError('This snapshot id is already in the store.');
        }

        // 1. The manifest, under its cap, checked before any fetch.
        let answer: unknown;
        try {
            answer = JSON.parse(
                (await readCapped(await source.manifest(signal), PLUGIN_MANIFEST_MAX_BYTES, signal)).toString('utf8'),
            );
        } catch (error) {
            if (error instanceof PluginSnapshotError || signal.aborted) {
                throw signal.aborted ? timeOrAbort(signal) : error;
            }
            throw new PluginSnapshotError("The plugin's snapshot answer couldn't be read.");
        }
        const ready = answer as { state?: unknown; manifest?: unknown } | null;
        if (!ready || typeof ready !== 'object' || ready.state !== 'ready') {
            throw new PluginSnapshotError('The plugin has no ready snapshot for this id.');
        }
        const manifest = checkSnapshotManifest(ready.manifest, {
            volumes: install.volumes,
            schema: install.schema,
            ...(request.maxBytes !== undefined ? { maxBytes: request.maxBytes } : {}),
        });

        // 2. What the store doesn't have yet: each hash once.
        mkdirSync(join(dir, 'chunks'), { recursive: true, mode: 0o700 });
        mkdirSync(join(dir, 'snapshots'), { recursive: true, mode: 0o700 });
        const wanted = new Map<string, { size: number; index: number; chunk: number | undefined }>();
        for (const [index, item] of manifest.items.entries()) {
            const hashes = itemChunks(item);
            for (const [n, hash] of hashes.entries()) {
                if (!wanted.has(hash)) {
                    wanted.set(hash, {
                        size: itemChunkSize(item, n),
                        index,
                        chunk: item.chunks ? n : undefined,
                    });
                }
            }
        }
        const missing: [string, { size: number; index: number; chunk: number | undefined }][] = [];
        let reused = 0;
        for (const entry of wanted) {
            if (signal.aborted) {
                throw timeOrAbort(signal);
            }
            if (await this.hasChunk(pluginId, entry[0], entry[1].size)) {
                reused++;
            } else {
                missing.push(entry);
            }
        }

        // 3. Room for the new chunks, sealed, plus the margin: short is a failure, never a partial snapshot.
        const needed = missing.reduce((sum, [, { size }]) => sum + size + sealOverhead(this.deps.box.currentKey), 0);
        if (needed > 0) {
            const free = await (this.deps.freeBytes ?? diskFree)(this.deps.directory);
            if (free < needed * (1 + PLUGIN_FREE_SPACE_MARGIN)) {
                throw new PluginSnapshotError(
                    `The backup volume is short of space: the snapshot needs ${Math.ceil(needed * (1 + PLUGIN_FREE_SPACE_MARGIN))} bytes and ${free} are free.`,
                );
            }
        }

        // 4. Fetch, check and seal each.
        let bytes = 0;
        for (const [hash, { size, index, chunk }] of missing) {
            const where = chunk === undefined ? `Item ${index}` : `Item ${index} chunk ${chunk}`;
            try {
                await this.putChunk(pluginId, hash, size, await source.item(index, chunk, signal), signal, where);
            } catch (error) {
                if (signal.aborted) {
                    throw timeOrAbort(signal);
                }
                throw error instanceof PluginSnapshotError
                    ? error
                    : new PluginSnapshotError(`${where} couldn't be fetched.`);
            }
            bytes += size;
        }

        // 5. The record, sealed, written last: never for a snapshot cancelled or out of time.
        if (signal.aborted) {
            throw timeOrAbort(signal);
        }
        const snapshot: StoredPluginSnapshot = {
            format: 1,
            pluginId,
            snapshotId,
            stamp,
            ...(request.run !== undefined ? { run: request.run } : {}),
            reason: request.reason,
            ...(request.note !== undefined ? { note: request.note } : {}),
            takenAt,
            install: {
                version: install.version,
                ...(install.revision !== undefined ? { revision: install.revision } : {}),
                schema: install.schema,
            },
            settings: install.settings ?? {},
            bytes: snapshotBytes(manifest),
            manifest,
        };
        const sealed = this.deps.box.sealBytes(
            Buffer.from(JSON.stringify(snapshot), 'utf8'),
            recordContext(pluginId, snapshotId),
        );
        const partial = `${recordPath}.tmp-${randomUUID()}`;
        try {
            writeFileSync(partial, sealed, { mode: 0o600, flag: 'wx' });
            renameSync(partial, recordPath);
        } catch (error) {
            rmSync(partial, { force: true });
            throw error;
        }
        return { snapshot, fetched: { chunks: missing.length, bytes }, reused };
    }

    /** The plugin's snapshots, oldest first, by their file names: no record opened. */
    list(pluginId: string): { stamp: string; snapshotId: string; file: string }[] {
        let names: string[];
        try {
            names = readdirSync(join(this.pluginDir(pluginId), 'snapshots'));
        } catch {
            return [];
        }
        return names
            .map((file) => {
                const match = file.match(RECORD_NAME);
                return match ? { stamp: match[1]!, snapshotId: match[2]!, file } : undefined;
            })
            .filter((entry): entry is { stamp: string; snapshotId: string; file: string } => entry !== undefined)
            .sort((a, b) => a.file.localeCompare(b.file));
    }

    /**
     * Drops one snapshot's record (one that failed its check, so it is not
     * a good snapshot); its chunks go with the next sweep.
     */
    discard(pluginId: string, snapshotId: string): Promise<boolean> {
        return this.exclusive(pluginId, async () => {
            const entry = this.list(pluginId).find((candidate) => candidate.snapshotId === snapshotId);
            if (!entry) {
                return false;
            }
            rmSync(this.recordFile(pluginId, entry), { force: true });
            return true;
        });
    }

    /** The plugins with a directory in the store. */
    plugins(): string[] {
        try {
            return readdirSync(join(this.deps.directory, PLUGIN_STORE), { withFileTypes: true })
                .filter((entry) => entry.isDirectory() && PLUGIN_ID.test(entry.name))
                .map((entry) => entry.name)
                .sort();
        } catch {
            return [];
        }
    }

    /** The plugin's snapshots that open, oldest first, with their files; one that doesn't is in `unreadable`. */
    records(pluginId: string): {
        records: { entry: { stamp: string; snapshotId: string; file: string }; record: StoredPluginSnapshot }[];
        unreadable: number;
    } {
        const records: { entry: { stamp: string; snapshotId: string; file: string }; record: StoredPluginSnapshot }[] =
            [];
        let unreadable = 0;
        for (const entry of this.list(pluginId)) {
            try {
                records.push({ entry, record: this.readFile(pluginId, entry) });
            } catch {
                unreadable++;
            }
        }
        return { records, unreadable };
    }

    /** One snapshot's record, opened; throws when it's missing, damaged or another's. */
    read(pluginId: string, snapshotId: string): StoredPluginSnapshot {
        const entry = this.list(pluginId).find((candidate) => candidate.snapshotId === snapshotId);
        if (!entry) {
            throw new PluginSnapshotError('No such snapshot.');
        }
        return this.readFile(pluginId, entry);
    }

    private readFile(pluginId: string, entry: { stamp: string; snapshotId: string; file: string }) {
        const path = join(this.pluginDir(pluginId), 'snapshots', entry.file);
        if (statSync(path).size > RECORD_MAX_BYTES) {
            throw new PluginSnapshotError('The snapshot record is over its cap.');
        }
        const record = JSON.parse(
            this.deps.box.openBytes(readFileSync(path), recordContext(pluginId, entry.snapshotId)).toString('utf8'),
        ) as StoredPluginSnapshot;
        if (
            record.format !== 1 ||
            record.pluginId !== pluginId ||
            record.snapshotId !== entry.snapshotId ||
            record.stamp !== entry.stamp
        ) {
            throw new PluginSnapshotError("The snapshot record doesn't match its name.");
        }
        return record;
    }

    /**
     * The level 1 drill for one snapshot: every chunk it lists re-read, its
     * seal opened, its size and hash checked, and each item's whole hash;
     * each database assembled into scratch and run through
     * `PRAGMA integrity_check` in a worker. Never throws for what it finds.
     */
    verify(pluginId: string, snapshotId: string): Promise<PluginVerifyResult> {
        return this.exclusive(pluginId, async () => {
            const result: PluginVerifyResult = { ok: false, chunks: 0, bytes: 0, databases: 0 };
            let snapshot: StoredPluginSnapshot;
            try {
                snapshot = this.read(pluginId, snapshotId);
            } catch {
                return { ...result, error: "The snapshot's record couldn't be opened." };
            }
            const scratchDir = join(this.pluginDir(pluginId), 'scratch');
            try {
                return await this.verifyItems(pluginId, snapshot, scratchDir, result);
            } finally {
                rmSync(scratchDir, { recursive: true, force: true });
            }
        });
    }

    private async verifyItems(
        pluginId: string,
        snapshot: StoredPluginSnapshot,
        scratchDir: string,
        result: PluginVerifyResult,
    ): Promise<PluginVerifyResult> {
        for (const [index, item] of snapshot.manifest.items.entries()) {
            const scratch = item.kind === 'database' ? join(scratchDir, `${randomUUID()}.sqlite`) : undefined;
            try {
                if (scratch) {
                    mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
                }
                const out = scratch ? await open(scratch, 'wx', 0o600) : undefined;
                const whole = createHash('sha256');
                try {
                    for (const [n, hash] of itemChunks(item).entries()) {
                        const where = item.chunks ? `Item ${index} chunk ${n}` : `Item ${index}`;
                        const ok = await this.openChunk(pluginId, hash, itemChunkSize(item, n), (piece) => {
                            whole.update(piece);
                            return out ? writeAll(out, piece) : undefined;
                        });
                        if (!ok) {
                            return { ...result, error: `${where} is missing or damaged.` };
                        }
                        result.chunks++;
                        result.bytes += itemChunkSize(item, n);
                    }
                } finally {
                    await out?.close();
                }
                if (whole.digest('hex') !== item.sha256) {
                    return { ...result, error: `Item ${index} doesn't match its SHA-256.` };
                }
                if (scratch) {
                    result.databases++;
                    if (!(await checkScratch(scratch, this.deps.checkMs ?? PLUGIN_CHECK_TIME_MS))) {
                        return { ...result, error: `Item ${index} fails its integrity check.` };
                    }
                }
            } finally {
                if (scratch) {
                    rmSync(scratch, { force: true });
                }
            }
        }
        return { ...result, ok: true };
    }

    /** One stored chunk opened a piece at a time into `each`; false when it's missing, damaged or the wrong size or hash. */
    private async openChunk(
        pluginId: string,
        sha256: string,
        size: number,
        each: (piece: Buffer) => Promise<void> | undefined,
    ) {
        let file;
        try {
            file = await open(this.chunkPath(pluginId, sha256), 'r');
        } catch {
            return false;
        }
        try {
            const head = Buffer.alloc(SEALED_START);
            const { bytesRead } = await file.read(head, 0, head.length, 0);
            const { decipher, body } = this.deps.box.beginOpen(
                head.subarray(0, bytesRead),
                chunkContext(pluginId, sha256),
            );
            const hash = createHash('sha256');
            let read = 0;
            const take = async (piece: Buffer) => {
                read += piece.length;
                if (read > size) {
                    throw new Error('Over its size.');
                }
                hash.update(piece);
                await each(piece);
            };
            for await (const piece of file.createReadStream({ start: body, autoClose: false })) {
                await take(decipher.update(piece as Buffer));
            }
            await take(decipher.final());
            return read === size && hash.digest('hex') === sha256;
        } catch {
            return false;
        } finally {
            await file.close();
        }
    }

    /**
     * Retention, then the sweep, for every plugin in the store: a run
     * snapshot stays while its run is kept (`runs`, the kept runs' stamps),
     * an uninstall snapshot for `purgeDays`, and the newest
     * PLUGIN_OUT_OF_RUN_KEEP of each other reason, and an installed plugin's
     * newest good snapshot past those (`retainedPastRules`). Then every chunk no kept
     * snapshot lists goes, and any temporary or scratch file. A record that
     * can't be opened is kept, and its plugin's chunks aren't swept, since
     * what it lists is unknown. Run after a run completes, as `pruneParts`.
     */
    async prune({
        runs,
        purgeDays,
        installed,
    }: {
        runs: readonly string[];
        purgeDays: number;
        /** The installed plugins, whose newest good snapshot `retainedPastRules` keeps; all when left out. */
        installed?: ReadonlySet<string>;
    }): Promise<PluginPruneResult> {
        const result: PluginPruneResult = { removed: [], chunks: 0, unreadable: [] };
        const keptRuns = new Set(runs);
        for (const pluginId of this.plugins()) {
            await this.exclusive(pluginId, async () => {
                const dir = this.pluginDir(pluginId);
                const kept: StoredPluginSnapshot[] = [];
                const drop: StoredPluginSnapshot[] = [];
                let blocked = false;
                const all: StoredPluginSnapshot[] = [];
                const byReason = new Map<PluginSnapshotReason, StoredPluginSnapshot[]>();
                // Oldest first, as listed.
                for (const entry of this.list(pluginId)) {
                    let record: StoredPluginSnapshot;
                    try {
                        record = this.readFile(pluginId, entry);
                    } catch {
                        blocked = true;
                        result.unreadable.push({ pluginId, file: entry.file });
                        continue;
                    }
                    all.push(record);
                    const stays =
                        record.run !== undefined
                            ? keptRuns.has(record.run)
                            : record.reason === 'uninstall'
                              ? this.now() - record.takenAt < purgeDays * DAY
                              : undefined;
                    if (stays === true) {
                        kept.push(record);
                    } else if (stays === false) {
                        drop.push(record);
                    } else {
                        byReason.set(record.reason, [...(byReason.get(record.reason) ?? []), record]);
                    }
                }
                for (const records of byReason.values()) {
                    // The newest few stay.
                    const cut = Math.max(0, records.length - PLUGIN_OUT_OF_RUN_KEEP);
                    for (const [n, record] of records.entries()) {
                        (n < cut ? drop : kept).push(record);
                    }
                }
                // What stays past the rules above: see `retainedPastRules`.
                const pinned =
                    installed === undefined || installed.has(pluginId) ? retainedPastRules(all) : new Set<string>();
                for (const record of drop.filter((candidate) => pinned.has(candidate.snapshotId))) {
                    drop.splice(drop.indexOf(record), 1);
                    kept.push(record);
                }
                for (const record of drop) {
                    rmSync(join(dir, 'snapshots', `${record.stamp}-${record.snapshotId}.json`), { force: true });
                    result.removed.push({ pluginId, snapshotId: record.snapshotId });
                }
                for (const leftovers of ['snapshots', 'chunks']) {
                    for (const name of safeList(join(dir, leftovers))) {
                        if (name.includes('.tmp-')) {
                            rmSync(join(dir, leftovers, name), { force: true });
                        }
                    }
                }
                rmSync(join(dir, 'scratch'), { recursive: true, force: true });
                if (blocked) {
                    return;
                }
                const listed = new Set(kept.flatMap((record) => record.manifest.items.flatMap(itemChunks)));
                for (const name of safeList(join(dir, 'chunks'))) {
                    const hash = name.match(CHUNK_NAME)?.[1];
                    if (hash !== undefined && !listed.has(hash)) {
                        rmSync(join(dir, 'chunks', name), { force: true });
                        result.chunks++;
                    }
                }
                if (!kept.length && !safeList(join(dir, 'chunks')).length && !safeList(join(dir, 'snapshots')).length) {
                    rmSync(dir, { recursive: true, force: true });
                }
            });
        }
        return result;
    }
}

function safeList(dir: string) {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

async function diskFree(directory: string) {
    const stats = await statfs(directory);
    return Number(stats.bavail) * Number(stats.bsize);
}

function timeOrAbort(signal: AbortSignal) {
    const reason = signal.reason as { name?: string } | undefined;
    return reason?.name === 'TimeoutError'
        ? new PluginSnapshotError('The snapshot ran out of time.')
        : new PluginSnapshotError('The snapshot was cancelled.');
}
