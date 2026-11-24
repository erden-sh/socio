/**
 * Plugin snapshots off-site (CB-458), as part of `copyOffsite`, for the
 * app's scheduled runs and `pnpm run backup` alike. Layout under
 * BACKUP_S3_PREFIX:
 *
 * - `snapshots/<stamp>/plugins/<id>/<snapshotId>.json.sealed`: each of this
 *   run's plugin snapshots, inside the run, before its `complete`, so they
 *   go with the run's retention.
 * - `plugin-snapshots/<id>/<stamp>-<snapshotId>/snapshot.json.sealed`: every
 *   snapshot the local store keeps outside a kept run (Back up now, a
 *   plugin's request, and the newest good one kept past its run). Off-site
 *   follows the local store: one it no longer keeps is removed.
 * - `plugin-chunks/<id>/<name>.sealed`: each chunk once, named by an HMAC of
 *   its SHA-256 under a key derived from the data key, so a bucket reader
 *   can't confirm a guessed file by its hash. Sent again when the local
 *   chunk is sealed under another key (after a rotation). A chunk no local
 *   snapshot lists stays until every kept off-site run is newer than the
 *   first one without it, as analytical parts do.
 *
 * Records and chunks are sealed on the backup volume already, so they go
 * as stored. `asStored` refuses anything that isn't sealed.
 */
import { createHmac, hkdfSync } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';

import { readManifest, writePrivate } from '@socio/data/backup';
import type { ObjectStore } from '@socio/data/object-store';
import type { SecretBox } from '@socio/foundation/keys/secret-box';
import { itemChunks } from '@socio/shared/plugins/plugin-snapshot';

import type { PluginSnapshotStore } from './plugin-store.js';

/** The off-site name of one chunk: an HMAC of its hash. */
export function pluginChunkName(nameKey: Uint8Array, sha256: string) {
    return createHmac('sha256', nameKey).update(sha256).digest('hex');
}

/** The chunk names' key, derived from the data key: never the data key itself. */
export function pluginChunkNameKey(dataKey: Uint8Array) {
    return Buffer.from(hkdfSync('sha256', dataKey, 'company-brain', 'plugin backup chunk names v1', 32));
}

/** What the off-site copy remembers of plugin chunks (`BACKUP_DIR/offsite-plugins.json`). */
interface PluginOffsiteState {
    /** `<id>/<name>` → the key id its bytes were sealed under when sent. */
    sent: Record<string, string>;
    /** `<id>/<name>` → the first run stamp no local snapshot listed it. */
    gone: Record<string, string>;
}

function readState(path: string): PluginOffsiteState {
    const value = readManifest(path) as unknown as Partial<PluginOffsiteState>;
    const object = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
    return {
        sent: object(value.sent) as Record<string, string>,
        gone: object(value.gone) as Record<string, string>,
    };
}

/** A run's last object off-site (`backup-offsite.ts`'s `COMPLETE`). */
const COMPLETE_MARKER = 'complete';

/** A short reason that names no path. */
const reasonOf = (error: unknown) => {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) {
        return `file system error (${code})`;
    }
    return (error instanceof Error ? error.message : 'unknown error').replace(/(\/[^\s'"]+)+/g, '…').slice(0, 200);
};

function headOf(path: string) {
    const head = Buffer.alloc(64);
    const fd = openSync(path, 'r');
    try {
        return head.subarray(0, readSync(fd, head, 0, head.length, 0));
    } finally {
        closeSync(fd);
    }
}

export interface PluginOffsiteCopy {
    store: PluginSnapshotStore;
    /** `pluginChunkNameKey(DATA_ENCRYPTION_KEY)`. */
    nameKey: Uint8Array;
    /** The kept runs' stamps locally: a run snapshot outside them goes with the out-of-run ones. */
    keptRuns: readonly string[];
    /** `BACKUP_DIR/offsite-plugins.json`. */
    state: string;
}

export interface PluginOffsiteResult {
    /** This run's snapshots, sent inside it. */
    inRun: number;
    /** Snapshots outside a kept run: sent now, and removed off-site. */
    outOfRun: number;
    outOfRunRemoved: number;
    chunks: number;
    chunksSent: number;
    chunksRemoved: number;
    /** Snapshots that couldn't be sent this time (a damaged or missing file): the workspace's copy went on. */
    error?: string;
}

/**
 * The plugin part of one off-site copy: `send` before the run's `complete`,
 * `prune` once the kept runs are known.
 */
export function pluginOffsite(
    copy: PluginOffsiteCopy,
    io: {
        target: ObjectStore;
        prefix: string;
        box: SecretBox;
        putFile: (key: string, path: string) => Promise<number>;
        listAll: (store: ObjectStore, prefix: string) => Promise<Map<string, number>>;
    },
) {
    const { store, nameKey } = copy;
    const { target, prefix, box } = io;
    const before = readState(copy.state);
    const state: PluginOffsiteState = { sent: { ...before.sent }, gone: { ...before.gone } };
    const save = () => writePrivate(copy.state, JSON.stringify(state));
    const keptRuns = new Set(copy.keptRuns);
    const result: PluginOffsiteResult = {
        inRun: 0,
        outOfRun: 0,
        outOfRunRemoved: 0,
        chunks: 0,
        chunksSent: 0,
        chunksRemoved: 0,
    };
    const chunksPrefix = `${prefix}plugin-chunks/`;
    const outPrefix = `${prefix}plugin-snapshots/`;
    /** Files go as stored, which is sealed; never plaintext. */
    const asStored = (path: string) => {
        if (!box.bytesKey(headOf(path))) {
            throw new Error('A plugin backup file for the off-site copy isn’t sealed, so the copy stopped.');
        }
        return path;
    };

    /** Every chunk a local snapshot lists: noted as wanted, sent unless it is there under the same key. */
    const wantedChunks = new Set<string>();
    /** A chunk a kept snapshot lists: never gone off-site, whether or not it is sent this time. */
    function markWanted(pluginId: string, hash: string) {
        const name = `${pluginId}/${pluginChunkName(nameKey, hash)}`;
        if (!wantedChunks.has(name)) {
            wantedChunks.add(name);
            result.chunks++;
        }
        delete state.gone[name];
        return name;
    }
    async function sendChunk(pluginId: string, hash: string, chunksThere: Map<string, number>) {
        const name = markWanted(pluginId, hash);
        const path = store.chunkFile(pluginId, hash);
        const key = box.bytesKey(headOf(path));
        const remote = `${chunksPrefix}${name}.sealed`;
        if (chunksThere.has(remote) && state.sent[name] === key) {
            return;
        }
        await io.putFile(remote, asStored(path));
        chunksThere.set(remote, 0);
        state.sent[name] = key!;
        result.chunksSent++;
        if (result.chunksSent % 100 === 0) {
            save();
        }
    }

    async function send(stamp: string) {
        const snapshot = `${prefix}snapshots/${stamp}/`;
        const chunksThere = await io.listAll(target, chunksPrefix);
        const outThere = await io.listAll(target, outPrefix);
        // The kept runs off-site, and what is in them: a run snapshot whose first send failed goes into its own run later.
        const runsThere = await io.listAll(target, `${prefix}snapshots/`);
        const wantedOut = new Set<string>();
        /** Plugins with a record that couldn't be opened: what it lists is unknown, so none of their chunks is gone. */
        const blocked = new Set<string>();
        const failures: string[] = [];
        for (const pluginId of store.plugins()) {
            let records: ReturnType<PluginSnapshotStore['records']>['records'];
            try {
                const listed = store.records(pluginId);
                records = listed.records;
                if (listed.unreadable) {
                    blocked.add(pluginId);
                }
            } catch {
                blocked.add(pluginId);
                failures.push(`${pluginId}: its snapshots couldn't be read`);
                continue;
            }
            for (const { entry, record } of records) {
                const inRun = record.run === stamp;
                const outKey =
                    !inRun && (record.run === undefined || !keptRuns.has(record.run))
                        ? `${outPrefix}${pluginId}/${record.stamp}-${record.snapshotId}/snapshot.json.sealed`
                        : undefined;
                if (outKey) {
                    // Kept off-site while kept locally, sent or not: a failed send is retried next time.
                    wantedOut.add(outKey);
                }
                const hashes = new Set(record.manifest.items.flatMap(itemChunks));
                // Every chunk it lists stays wanted before any send is tried, so a failure never lets one go.
                for (const hash of hashes) {
                    markWanted(pluginId, hash);
                }
                const runKey =
                    record.run !== undefined && !inRun && !outKey
                        ? `${prefix}snapshots/${record.run}/plugins/${pluginId}/${record.snapshotId}.json.sealed`
                        : undefined;
                const runMissing =
                    runKey !== undefined &&
                    !runsThere.has(runKey) &&
                    runsThere.has(`${prefix}snapshots/${record.run}/${COMPLETE_MARKER}`);
                try {
                    // Its chunks first: a record goes only once everything it lists is there.
                    for (const hash of hashes) {
                        await sendChunk(pluginId, hash, chunksThere);
                    }
                    if (runMissing) {
                        await io.putFile(runKey!, asStored(store.recordFile(pluginId, entry)));
                        result.inRun++;
                    } else if (inRun) {
                        await io.putFile(
                            `${snapshot}plugins/${pluginId}/${record.snapshotId}.json.sealed`,
                            asStored(store.recordFile(pluginId, entry)),
                        );
                        result.inRun++;
                    } else if (outKey) {
                        result.outOfRun++;
                        if (!outThere.has(outKey)) {
                            await io.putFile(outKey, asStored(store.recordFile(pluginId, entry)));
                        }
                    }
                } catch (error) {
                    // One plugin's damaged or missing file never stops the workspace's copy.
                    failures.push(`${pluginId} snapshot ${record.snapshotId}: ${reasonOf(error)}`);
                }
            }
        }
        if (failures.length) {
            result.error =
                `${failures.length} plugin snapshot(s) not sent off-site: ${failures.slice(0, 3).join('; ')}`.slice(
                    0,
                    500,
                );
        }
        // Out-of-run snapshots follow the local store.
        for (const key of outThere.keys()) {
            const pluginId = key.slice(outPrefix.length).split('/')[0]!;
            if (!wantedOut.has(key) && !blocked.has(pluginId)) {
                await target.delete(key);
                result.outOfRunRemoved++;
            }
        }
        // Chunks no local snapshot lists: noted now, removed once no kept run needs them.
        for (const remote of chunksThere.keys()) {
            const name = remote.slice(chunksPrefix.length).replace(/\.sealed$/, '');
            const pluginId = name.split('/')[0]!;
            if (!wantedChunks.has(name) && !blocked.has(pluginId) && !(name in state.gone)) {
                state.gone[name] = stamp;
            }
        }
        for (const name of Object.keys(state.sent)) {
            if (!wantedChunks.has(name) && !chunksThere.has(`${chunksPrefix}${name}.sealed`)) {
                delete state.sent[name];
            }
        }
        save();
    }

    /** After retention: every chunk gone since before the oldest kept run is removed. */
    async function prune(oldest: string | undefined) {
        if (oldest === undefined) {
            return;
        }
        for (const [name, since] of Object.entries(state.gone)) {
            if (oldest > since) {
                await target.delete(`${chunksPrefix}${name}.sealed`);
                delete state.gone[name];
                delete state.sent[name];
                result.chunksRemoved++;
            }
        }
        save();
    }

    return { send, prune, result };
}
