/**
 * Plugin snapshots, the wire side (CB-458): the manifest a plugin answers
 * once its snapshot is ready, its limits, and the check the host runs on
 * it before it fetches anything. The SDK's restore side checks the same
 * rules.
 *
 * Pure: no I/O, no crypto.
 */

/** The snapshot protocol this check reads. */
export const PLUGIN_SNAPSHOT_PROTOCOL = 1;

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** Fixed chunk size: every chunk is exactly this, except an item's last. */
export const PLUGIN_CHUNK_BYTES = 4 * MiB;
/** An item above this lists its chunks, as every `database` item does (decision: 4 MiB chunks above 64 MiB). */
export const PLUGIN_WHOLE_ITEM_MAX_BYTES = 64 * MiB;
/** A snapshot's size by default; an admin raises it per plugin. */
export const PLUGIN_SNAPSHOT_MAX_BYTES = 20 * GiB;
/** Items per manifest. */
export const PLUGIN_SNAPSHOT_MAX_ITEMS = 200_000;
/** The `ready` answer's size, checked while it streams. */
export const PLUGIN_MANIFEST_MAX_BYTES = 16 * MiB;
/** An item's path: bytes (UTF-8) and segments. */
export const PLUGIN_PATH_MAX_BYTES = 1024;
export const PLUGIN_PATH_MAX_SEGMENTS = 32;
/** `pluginVersion` is shown, not trusted: kept short. */
const VERSION_MAX = 128;

/** A host-chosen snapshot id: a ULID (Crockford base32, 26 characters). */
export const PLUGIN_SNAPSHOT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMPANIONS = ['-wal', '-shm', '-journal'] as const;
export const PLUGIN_JOURNAL_MODES = ['delete', 'truncate', 'persist', 'memory', 'wal', 'off'] as const;
export type PluginJournalMode = (typeof PLUGIN_JOURNAL_MODES)[number];

/** One item of a snapshot: a file on one of the plugin's volumes. */
export interface PluginSnapshotItem {
    /** One of the manifest's non-ephemeral volumes. */
    volume: string;
    /** Relative to that volume's mount, `/`-separated. Data only: the host never writes it to disk. */
    path: string;
    kind: 'database' | 'file';
    size: number;
    /** The whole item's SHA-256, lower-case hex. */
    sha256: string;
    /**
     * Each 4 MiB chunk's SHA-256, in order. Listed for every `database`
     * item and any item over 64 MiB; an item without it is one chunk, its
     * `sha256`.
     */
    chunks?: string[];
    /** Its file mode bits. */
    mode?: number;
    /** A database's journal mode at the source, set back on restore. */
    journalMode?: PluginJournalMode;
}

/** The plugin's manifest, as the `ready` answer carries it. */
export interface PluginSnapshotManifest {
    protocol: number;
    /** As the plugin reports it, shown only: the host trusts its own record of the install. */
    pluginVersion: string;
    schemaVersion: number;
    createdAt: number;
    items: PluginSnapshotItem[];
    /** The plugin's own counts, which the drill compares. */
    stats?: Record<string, unknown>;
}

/** What the check holds a manifest to: the installed plugin's, and its limits. */
export interface PluginSnapshotRules {
    /** The installed manifest's non-ephemeral volumes, by name. */
    volumes: readonly string[];
    /** The installed manifest's `backup.schema`. */
    schema: number;
    /** The snapshot's size cap: PLUGIN_SNAPSHOT_MAX_BYTES unless an admin raised it. */
    maxBytes?: number;
}

export class PluginSnapshotError extends Error {
    override name = 'PluginSnapshotError';
}

const fail = (message: string): never => {
    throw new PluginSnapshotError(message);
};

/** How many chunks an item of `size` bytes has: at least one (an empty file is one empty chunk). */
export const chunkCount = (size: number) => Math.max(1, Math.ceil(size / PLUGIN_CHUNK_BYTES));

/** The size of an item's chunk `n` of `count`. */
export const chunkSize = (size: number, n: number, count: number) =>
    count === 1 ? size : n < count - 1 ? PLUGIN_CHUNK_BYTES : size - PLUGIN_CHUNK_BYTES * (count - 1);

/**
 * The size of an item's chunk `n`: 4 MiB each but the last when it lists
 * chunks; the whole item when it doesn't (one chunk, up to 64 MiB).
 */
export const itemChunkSize = (item: Pick<PluginSnapshotItem, 'size' | 'chunks'>, n: number) =>
    item.chunks ? chunkSize(item.size, n, item.chunks.length) : item.size;

/** An item's chunk hashes, in order: its list, or the item itself as one chunk. */
export const itemChunks = (item: Pick<PluginSnapshotItem, 'sha256' | 'chunks'>) => item.chunks ?? [item.sha256];

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

const wholeNumber = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;

/**
 * Whether `path` is one an item may have: relative,
 * `/`-separated, no empty, `.` or `..` segment, no NUL, backslash or
 * control character, and within the limits. Exported for the SDK's
 * restore side, which checks the same.
 */
export function pluginItemPathProblem(path: unknown): string | undefined {
    if (typeof path !== 'string' || path === '') {
        return 'has no path';
    }
    if (new TextEncoder().encode(path).length > PLUGIN_PATH_MAX_BYTES) {
        return `has a path over ${PLUGIN_PATH_MAX_BYTES} bytes`;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f\\]/.test(path)) {
        return 'has a control character or a backslash in its path';
    }
    const segments = path.split('/');
    if (segments.length > PLUGIN_PATH_MAX_SEGMENTS) {
        return `has a path over ${PLUGIN_PATH_MAX_SEGMENTS} segments`;
    }
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        return 'has an absolute path, or an empty, . or .. segment';
    }
    return undefined;
}

/**
 * The plugin's manifest, checked against the installed plugin and the
 * limits before anything is fetched, and returned
 * with only the fields the protocol has: anything else the plugin sent is
 * dropped, so what the host seals is what it checked. Throws
 * `PluginSnapshotError` naming the item by its index, never its path
 * (failure reasons are stored without paths).
 */
export function checkSnapshotManifest(value: unknown, rules: PluginSnapshotRules): PluginSnapshotManifest {
    if (!isRecord(value)) {
        return fail('The manifest is not an object.');
    }
    if (value.protocol !== PLUGIN_SNAPSHOT_PROTOCOL) {
        fail(`The manifest's protocol must be ${PLUGIN_SNAPSHOT_PROTOCOL}.`);
    }
    if (typeof value.pluginVersion !== 'string' || value.pluginVersion.length > VERSION_MAX) {
        fail(`The manifest's pluginVersion must be a string of at most ${VERSION_MAX} characters.`);
    }
    if (!wholeNumber(value.schemaVersion)) {
        fail("The manifest's schemaVersion must be a whole number.");
    }
    if ((value.schemaVersion as number) > rules.schema) {
        fail(
            `The snapshot's data version (${value.schemaVersion as number}) is above what the installed version reads (${rules.schema}).`,
        );
    }
    if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) {
        fail("The manifest's createdAt must be a time.");
    }
    if (value.stats !== undefined && !isRecord(value.stats)) {
        fail("The manifest's stats must be an object.");
    }
    if (!Array.isArray(value.items)) {
        return fail("The manifest's items must be a list.");
    }
    if (value.items.length > PLUGIN_SNAPSHOT_MAX_ITEMS) {
        fail(`The manifest lists more than ${PLUGIN_SNAPSHOT_MAX_ITEMS} items.`);
    }
    const maxBytes = rules.maxBytes ?? PLUGIN_SNAPSHOT_MAX_BYTES;
    const volumes = new Set(rules.volumes);
    const seen = new Set<string>();
    const databases: string[] = [];
    // A chunk is named by its hash: one hash with two sizes can't be both.
    const sizes = new Map<string, number>();
    const items: PluginSnapshotItem[] = [];
    let total = 0;
    for (const [index, raw] of (value.items as unknown[]).entries()) {
        const bad = (why: string): never => fail(`Item ${index} ${why}.`);
        if (!isRecord(raw)) {
            return bad('is not an object');
        }
        if (typeof raw.volume !== 'string' || !volumes.has(raw.volume)) {
            bad('names no volume the installed plugin backs up');
        }
        const problem = pluginItemPathProblem(raw.path);
        if (problem) {
            bad(problem);
        }
        if (raw.kind !== 'database' && raw.kind !== 'file') {
            bad('has a kind other than database or file');
        }
        if (!wholeNumber(raw.size)) {
            bad('has no whole-number size');
        }
        if (typeof raw.sha256 !== 'string' || !SHA256.test(raw.sha256)) {
            bad('has no SHA-256');
        }
        const size = raw.size as number;
        total += size;
        if (total > maxBytes) {
            fail(`The snapshot is over its size limit (${maxBytes} bytes).`);
        }
        const count = chunkCount(size);
        let chunks: string[] | undefined;
        if (raw.chunks !== undefined) {
            if (
                !Array.isArray(raw.chunks) ||
                raw.chunks.some((hash) => typeof hash !== 'string' || !SHA256.test(hash))
            ) {
                bad('has a chunk list that is not SHA-256 hashes');
            }
            chunks = [...(raw.chunks as string[])];
            if (chunks.length !== count) {
                bad(`lists ${chunks.length} chunks where its size has ${count}`);
            }
            if (count === 1 && chunks[0] !== raw.sha256) {
                bad("has one chunk whose hash isn't the item's");
            }
        } else if (raw.kind === 'database' || size > PLUGIN_WHOLE_ITEM_MAX_BYTES) {
            bad('lists no chunks (every database item, and every item over 64 MiB, does)');
        }
        for (const [n, hash] of (chunks ?? [raw.sha256 as string]).entries()) {
            const bytes = chunks ? chunkSize(size, n, count) : size;
            const known = sizes.get(hash);
            if (known !== undefined && known !== bytes) {
                bad('lists a chunk hash another item lists with another size');
            }
            sizes.set(hash, bytes);
        }
        if (raw.mode !== undefined && !wholeNumber(raw.mode, 0o7777)) {
            bad('has a mode that is not file mode bits');
        }
        if (raw.journalMode !== undefined) {
            if (raw.kind !== 'database' || !(PLUGIN_JOURNAL_MODES as readonly unknown[]).includes(raw.journalMode)) {
                bad('has a journal mode that is not a database one');
            }
        }
        const key = `${raw.volume as string}\u0000${raw.path as string}`;
        if (seen.has(key)) {
            bad('is listed twice');
        }
        seen.add(key);
        if (raw.kind === 'database') {
            databases.push(key);
        }
        items.push({
            volume: raw.volume as string,
            path: raw.path as string,
            kind: raw.kind as PluginSnapshotItem['kind'],
            size,
            sha256: raw.sha256 as string,
            ...(chunks ? { chunks } : {}),
            ...(raw.mode !== undefined ? { mode: raw.mode as number } : {}),
            ...(raw.journalMode !== undefined ? { journalMode: raw.journalMode as PluginJournalMode } : {}),
        });
    }
    // No -wal, -shm or -journal beside a database: restoring them would
    // replay changes made after the snapshot.
    for (const database of databases) {
        for (const suffix of COMPANIONS) {
            if (seen.has(database + suffix)) {
                const index = items.findIndex((item) => `${item.volume}\u0000${item.path}` === database + suffix);
                fail(`Item ${index} is a ${suffix.slice(1)} file beside a database item.`);
            }
        }
    }
    return {
        protocol: PLUGIN_SNAPSHOT_PROTOCOL,
        pluginVersion: value.pluginVersion as string,
        schemaVersion: value.schemaVersion as number,
        createdAt: value.createdAt as number,
        items,
        ...(value.stats !== undefined ? { stats: value.stats as Record<string, unknown> } : {}),
    };
}

/** A snapshot's size: every item's bytes. */
export const snapshotBytes = (manifest: Pick<PluginSnapshotManifest, 'items'>) =>
    manifest.items.reduce((sum, item) => sum + item.size, 0);
