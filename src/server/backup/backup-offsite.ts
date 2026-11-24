import { closeSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { filesUnder, readManifest, writePrivate, type MirrorManifest } from '@socio/data/backup';
import { checkPrefix, type ObjectStore } from '@socio/data/object-store';
import { sealFile } from '@socio/foundation/keys/sealed-files';
import type { SecretBox } from '@socio/foundation/keys/secret-box';

import type { OffsiteResult } from './contract.js';
import { pluginOffsite, type PluginOffsiteCopy } from './plugin-offsite.js';

/** What sealed backup files are bound to (their AAD). */
export const BACKUP_CONTEXT = 'company-brain backup';
/** The suffix of files the off-site copy sealed itself. */
export const SEALED = '.sealed';
/** A snapshot's last object: one without it is from a failed run. */
export const COMPLETE = 'complete';

export interface OffsiteCopy {
    /** The S3-compatible target (BACKUP_S3_*). */
    target: ObjectStore;
    /** `BACKUP_S3_PREFIX`: where in the bucket; empty or ending in `/`. */
    prefix: string;
    /** The `backups` box: plaintext files are sealed under the data key. */
    box: SecretBox;
    /** This run's database backup (`company-brain-….sqlite`). */
    database: string;
    /** This run's `userdata-…` directory (its `objects/` is skipped). */
    userdata: string;
    /** The local object mirror and its manifest, when there is one. */
    mirror?: { dir: string; manifest: string };
    /** The local analytical parts' mirror (CB-369, BACKUP_DIR/parts), when there is one. */
    parts?: string;
    /** Where the copy remembers what it sent (BACKUP_DIR/offsite.json). */
    state: string;
    /** Snapshots kept off-site (BACKUP_KEEP). */
    keep: number;
    /** Plugin snapshots (CB-458, `plugin-offsite.ts`), with a data key. */
    plugins?: PluginOffsiteCopy;
}

/** The off-site copy's sealed file while it is sent, in BACKUP_DIR. */
export const SEALED_TMP = 'offsite.sealed.tmp';

/** A file's first bytes: enough to tell whether, and under which key, it is sealed. */
function headOf(path: string) {
    const head = Buffer.alloc(64);
    const fd = openSync(path, 'r');
    try {
        return head.subarray(0, readSync(fd, head, 0, head.length, 0));
    } finally {
        closeSync(fd);
    }
}

/** Every key under `prefix`, with its size. */
export async function listAll(store: ObjectStore, prefix: string) {
    const found = new Map<string, number>();
    let cursor: string | undefined;
    do {
        const page = await store.list(prefix, cursor);
        for (const { key, size } of page.keys) {
            found.set(key, size);
        }
        cursor = page.next;
    } while (cursor);
    return found;
}

/** What the copy remembers (BACKUP_DIR/offsite.json). */
interface OffsiteState {
    /** The objects sent, as the mirror's manifest described them. */
    sent: MirrorManifest;
    /** Objects gone from the source: the first snapshot without each. */
    gone: Record<string, string>;
    /** Analytical parts gone from the local mirror: the first snapshot without each. */
    partsGone: Record<string, string>;
    /** The data key id each part sent was sealed under (CB-369). */
    partsKey: Record<string, string>;
}
function readState(path: string): OffsiteState {
    const value = readManifest(path) as unknown as Partial<OffsiteState>;
    const object = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
    return {
        sent: object(value.sent) as MirrorManifest,
        gone: object(value.gone) as Record<string, string>,
        partsGone: object(value.partsGone) as Record<string, string>,
        partsKey: object(value.partsKey) as Record<string, string>,
    };
}
const newestFirst = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

/**
 * Copies a finished local backup to an S3-compatible target (CB-63), off
 * unless configured. Layout under the prefix:
 * `snapshots/<stamp>/company-brain.sqlite.sealed`,
 * `snapshots/<stamp>/userdata/…` (datasets sealed here, files as stored)
 * and `snapshots/<stamp>/complete`, written last; plus `objects/<key>`,
 * an incremental mirror of the object store, sent when the source object
 * changed or the target lacks it. The database and datasets are plaintext
 * on the backup volume, so they are sealed under the data key first;
 * everything else already is, and a file that isn't stops the copy.
 *
 * Keeps the newest `keep` complete snapshots; those of failed runs go. An
 * object gone from the source stays until every kept snapshot is newer
 * than the first one without it, so each kept snapshot has its objects.
 */
export async function copyOffsite(copy: OffsiteCopy): Promise<OffsiteResult> {
    const { target, box } = copy;
    const prefix = checkPrefix(copy.prefix);
    await target.ensureReady();
    const stamp = basename(copy.database).replace(/^company-brain-(.+)\.sqlite$/, '$1');
    const snapshot = `${prefix}snapshots/${stamp}/`;
    let sent = 0;
    let bytes = 0;
    const put = async (key: string, body: Uint8Array) => {
        await target.put(key, body);
        sent++;
        bytes += body.length;
    };
    /** A file, streamed where the target can (CB-378): never held whole. */
    const putFile = async (key: string, path: string) => {
        const size = target.putFile ? await target.putFile(key, path) : await putWhole(key, path);
        sent++;
        bytes += size;
        return size;
    };
    const putWhole = async (key: string, path: string) => {
        const body = readFileSync(path);
        await target.put(key, body);
        return body.length;
    };
    // Sealed into a file beside the state, then sent: the same bytes
    // `sealBytes` makes, a chunk at a time. Removed after each file, and
    // by `removeLeftovers` after a crash.
    const sealedTmp = join(dirname(copy.state), SEALED_TMP);
    const putSealed = async (key: string, path: string) => {
        try {
            await sealFile(box, path, sealedTmp, BACKUP_CONTEXT);
            await putFile(key, sealedTmp);
        } finally {
            rmSync(sealedTmp, { force: true });
        }
    };
    /** Files and objects go as stored, which is sealed; never plaintext. */
    const asStored = (path: string) => {
        if (!box.bytesKey(headOf(path))) {
            throw new Error('A file for the off-site copy isn’t sealed, so the copy stopped.');
        }
        return path;
    };
    await putSealed(`${snapshot}company-brain.sqlite${SEALED}`, copy.database);
    for (const file of filesUnder(copy.userdata)) {
        // Objects and analytical parts have mirrors of their own, sent once.
        if (file.startsWith('objects/') || /\.parts\//.test(file)) {
            continue;
        }
        const path = join(copy.userdata, ...file.split('/'));
        if (file.endsWith('.sqlite')) {
            await putSealed(`${snapshot}userdata/${file}${SEALED}`, path);
        } else {
            await putFile(`${snapshot}userdata/${file}`, asStored(path));
        }
    }

    // The object mirror, incrementally.
    const objectsPrefix = `${prefix}objects/`;
    const before = readState(copy.state);
    const state: OffsiteState = {
        sent: {},
        gone: { ...before.gone },
        partsGone: { ...before.partsGone },
        partsKey: { ...before.partsKey },
    };
    const save = (sent = state.sent) => writePrivate(copy.state, JSON.stringify({ ...state, sent }));
    let objects = 0;
    let objectsSent = 0;
    let objectsRemoved = 0;
    const there = copy.mirror ? await listAll(target, objectsPrefix) : new Map<string, number>();
    if (copy.mirror) {
        const source = readManifest(copy.mirror.manifest);
        for (const [key, entry] of Object.entries(source)) {
            objects++;
            delete state.gone[key];
            const remote = `${objectsPrefix}${key}`;
            const previous = before.sent[key];
            if (
                previous &&
                previous.size === entry.size &&
                previous.etag === entry.etag &&
                previous.modified === entry.modified &&
                there.get(remote) === entry.size
            ) {
                state.sent[key] = entry;
                continue;
            }
            const path = join(copy.mirror.dir, ...key.split('/'));
            try {
                headOf(path);
            } catch {
                continue;
            }
            there.set(remote, await putFile(remote, asStored(path)));
            state.sent[key] = entry;
            objectsSent++;
            if (objectsSent % 100 === 0) {
                save({ ...before.sent, ...state.sent });
            }
        }
        // Gone from the source: noted now, removed once no snapshot needs it.
        for (const remote of there.keys()) {
            const key = remote.slice(objectsPrefix.length);
            if (!(key in source) && !(key in state.gone)) {
                state.gone[key] = stamp;
            }
        }
    }
    for (const key of Object.keys(state.gone)) {
        if (!there.has(`${objectsPrefix}${key}`)) {
            delete state.gone[key];
        }
    }
    // Analytical parts (CB-369): `parts/<dataset>/<part>.parquet.sealed`,
    // sealed under the data key and sent once, since a part never changes;
    // sent again, under the current key, after the data key rotates, so no
    // kept snapshot needs a retired key. The snapshot's sealed dataset file
    // holds the catalog naming its parts.
    const partsPrefix = `${prefix}parts/`;
    let parts = 0;
    let partsSent = 0;
    let partsRemoved = 0;
    const local = copy.parts ? filesUnder(copy.parts).filter((file) => file.endsWith('.parquet')) : [];
    const partsThere = copy.parts ? await listAll(target, partsPrefix) : new Map<string, number>();
    const localKeys = new Set(local.map((file) => `${file}${SEALED}`));
    for (const file of local) {
        parts++;
        const key = `${file}${SEALED}`;
        delete state.partsGone[key];
        if (partsThere.has(`${partsPrefix}${key}`) && state.partsKey[key] === box.currentKey) {
            continue;
        }
        await putSealed(`${partsPrefix}${key}`, join(copy.parts!, ...file.split('/')));
        state.partsKey[key] = box.currentKey;
        partsSent++;
        if (partsSent % 100 === 0) {
            save();
        }
    }
    for (const remote of partsThere.keys()) {
        const key = remote.slice(partsPrefix.length);
        if (!localKeys.has(key) && !(key in state.partsGone)) {
            state.partsGone[key] = stamp;
        }
    }
    save();
    // Plugin snapshots (CB-458): this run's inside it, before `complete`.
    const plugins = copy.plugins ? pluginOffsite(copy.plugins, { target, prefix, box, putFile, listAll }) : undefined;
    // Never fatal to the workspace's copy: what failed is reported in `plugins.error` and sent next time.
    await plugins?.send(stamp).catch((error) => {
        plugins!.result.error = `Plugin snapshots weren't sent off-site: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`;
    });
    await put(`${snapshot}${COMPLETE}`, Buffer.from(`${stamp}\n`));

    // Retention: the newest `keep` complete snapshots.
    const snapshots = new Map<string, string[]>();
    for (const key of (await listAll(target, `${prefix}snapshots/`)).keys()) {
        const name = key.slice(`${prefix}snapshots/`.length).split('/')[0];
        snapshots.set(name, [...(snapshots.get(name) ?? []), key]);
    }
    const names = [...snapshots.keys()].sort(newestFirst);
    const kept = names
        .filter((name) => snapshots.get(name)!.includes(`${prefix}snapshots/${name}/${COMPLETE}`))
        .slice(0, copy.keep);
    const old = names.filter((name) => !kept.includes(name));
    for (const name of old) {
        for (const key of snapshots.get(name)!) {
            await target.delete(key);
        }
    }
    // The oldest kept snapshot is newer than the first one without it.
    const oldest = kept[kept.length - 1];
    for (const [key, since] of Object.entries(state.gone)) {
        if (oldest > since) {
            await target.delete(`${objectsPrefix}${key}`);
            delete state.gone[key];
            objectsRemoved++;
        }
    }
    for (const [key, since] of Object.entries(state.partsGone)) {
        if (oldest > since) {
            await target.delete(`${partsPrefix}${key}`);
            delete state.partsGone[key];
            delete state.partsKey[key];
            partsRemoved++;
        }
    }
    save();
    await plugins?.prune(oldest).catch(() => undefined);
    return {
        snapshot,
        ...(plugins ? { plugins: plugins.result } : {}),
        ...(parts || partsSent || partsRemoved ? { parts, partsSent, partsRemoved } : {}),
        sent,
        bytes,
        objects,
        objectsSent,
        objectsRemoved,
        /** Gone from the source, kept for the older snapshots. */
        objectsKept: Object.keys(state.gone).length,
        prunedSnapshots: old.length,
    };
}
