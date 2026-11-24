// Plugin backups, step 3 (CB-458): the per-plugin chunk store under
// BACKUP_DIR. The manifest's checks and limits, fetching from a fake plugin
// server over the protocol, dedupe, sealing at rest, corruption detection
// (hash lies, size bombs, damaged chunks, the level 1 drill) and retention
// with the chunk sweep.
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { SecretBox } from '@socio/foundation/keys/secret-box';
import {
    PLUGIN_CHUNK_BYTES,
    PLUGIN_MANIFEST_MAX_BYTES,
    PLUGIN_SNAPSHOT_MAX_BYTES,
    PLUGIN_SNAPSHOT_MAX_ITEMS,
    PLUGIN_WHOLE_ITEM_MAX_BYTES,
    PluginSnapshotError,
    checkSnapshotManifest,
    type PluginSnapshotItem,
} from '@socio/shared/plugins/plugin-snapshot';

import { httpSnapshotSource } from '../src/server/backup/plugin-source.js';
import {
    PLUGIN_STORE,
    PluginSnapshotStore,
    keptRunStamps,
    newSnapshotId,
    type PluginSnapshotReason,
    type PluginStoreDeps,
} from '../src/server/backup/plugin-store.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});
const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-store-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const DAY = 24 * 3_600_000;
const keys = { current: randomBytes(32), legacy: 'session secret' };
const install = { version: '1.0.0', revision: 'rev-3', schema: 4, volumes: ['data'], settings: { region: 'east' } };

/** A file as a plugin lists it: its hash, and its chunks when it has or needs them. */
function itemOf(
    data: Buffer,
    patch: Partial<PluginSnapshotItem> & { chunked?: boolean } = {},
): PluginSnapshotItem & { data: Buffer } {
    const { chunked, ...rest } = patch;
    const kind = rest.kind ?? 'file';
    const chunks: string[] = [];
    for (let at = 0; at < Math.max(1, data.length); at += PLUGIN_CHUNK_BYTES) {
        chunks.push(sha(data.subarray(at, at + PLUGIN_CHUNK_BYTES)));
    }
    return {
        volume: 'data',
        path: 'a.bin',
        kind,
        size: data.length,
        sha256: sha(data),
        ...(chunked || kind === 'database' ? { chunks } : {}),
        ...rest,
        data,
    };
}

const manifestOf = (items: PluginSnapshotItem[], patch: Record<string, unknown> = {}) => ({
    protocol: 1,
    pluginVersion: '1.0.0',
    schemaVersion: 4,
    createdAt: 1_795_000_000_000,
    items: items.map(({ data: _data, ...item }: PluginSnapshotItem & { data?: Buffer }) => item),
    stats: { 'app.sqlite': { rows: { notes: 3 } } },
    ...patch,
});

/** A plugin answering the snapshot protocol for one ready snapshot. */
async function fakePlugin(
    items: (PluginSnapshotItem & { data: Buffer })[],
    options: {
        manifest?: unknown;
        answer?: string;
        /** Replaces what an item request sends. */
        body?: (index: number, chunk: number | undefined, bytes: Buffer) => Buffer | 'hang';
        status?: number;
    } = {},
) {
    const requests: string[] = [];
    const server: Server = createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        const url = new URL(req.url!, 'http://plugin');
        const match = url.pathname.match(/^\/__cb\/backup\/([0-9A-Z]{26})(?:\/items\/(\d+))?$/);
        if (!match) {
            res.writeHead(404).end();
            return;
        }
        if (req.method === 'DELETE') {
            res.writeHead(204).end();
            return;
        }
        if (options.status) {
            res.writeHead(options.status).end();
            return;
        }
        if (match[2] === undefined) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
                options.answer ?? JSON.stringify({ state: 'ready', manifest: options.manifest ?? manifestOf(items) }),
            );
            return;
        }
        const index = Number(match[2]);
        const chunk = url.searchParams.has('chunk') ? Number(url.searchParams.get('chunk')) : undefined;
        const data = items[index]!.data;
        const bytes =
            chunk === undefined ? data : data.subarray(chunk * PLUGIN_CHUNK_BYTES, (chunk + 1) * PLUGIN_CHUNK_BYTES);
        const body = options.body ? options.body(index, chunk, bytes) : bytes;
        if (body === 'hang') {
            res.writeHead(200);
            res.write(bytes.subarray(0, 1));
            return;
        }
        res.writeHead(200).end(body);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    cleanup.push(() => {
        server.closeAllConnections();
        return new Promise((done) => server.close(done));
    });
    const port = (server.address() as AddressInfo).port;
    const source = (snapshotId: string) =>
        httpSnapshotSource(snapshotId, ({ method, target, signal }) =>
            fetch(`http://127.0.0.1:${port}${target}`, { method, ...(signal ? { signal } : {}) }),
        );
    return { requests, source, fetches: () => requests.filter((line) => line.includes('/items/')) };
}

function store(patch: Partial<PluginStoreDeps> = {}) {
    const directory = patch.directory ?? scratch();
    const box = new SecretBox(keys, 'backups');
    return {
        directory,
        box,
        store: new PluginSnapshotStore({ directory, box, freeBytes: async () => 1e15, ...patch }),
    };
}

/** A SQLite file of about `rows` × 4 KiB, its pages in place, as the SDK's copy keeps them. */
function sqliteFile(dir: string, rows = 2500) {
    const path = join(dir, `db-${randomBytes(4).toString('hex')}.sqlite`);
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE notes (id INTEGER PRIMARY KEY, body BLOB)');
    const insert = db.prepare('INSERT INTO notes (body) VALUES (?)');
    db.exec('BEGIN');
    for (let i = 0; i < rows; i++) {
        insert.run(randomBytes(4000));
    }
    db.exec('COMMIT');
    db.close();
    return path;
}

const take = (
    s: PluginSnapshotStore,
    plugin: Awaited<ReturnType<typeof fakePlugin>>,
    patch: { pluginId?: string; reason?: PluginSnapshotReason; run?: string; maxBytes?: number } = {},
) => {
    const snapshotId = newSnapshotId();
    const reason = patch.reason ?? (patch.run ? 'scheduled' : 'manual');
    return s.take({
        pluginId: patch.pluginId ?? 'notes',
        snapshotId,
        reason,
        ...(patch.run ? { run: patch.run } : {}),
        install,
        ...(patch.maxBytes !== undefined ? { maxBytes: patch.maxBytes } : {}),
        source: plugin.source(snapshotId),
    });
};

// ── The manifest ─────────────────────────────────────────────────────────

describe('the manifest check', () => {
    const rules = { volumes: ['data', 'files'], schema: 4 };
    const one = (patch: Record<string, unknown>) =>
        manifestOf([{ ...itemOf(Buffer.from('notes by Ada')), ...patch } as PluginSnapshotItem & { data: Buffer }]);
    const refused = (value: unknown, message: RegExp, extra: Partial<typeof rules & { maxBytes: number }> = {}) =>
        expect(() => checkSnapshotManifest(value, { ...rules, ...extra })).toThrow(message);

    it('accepts a good manifest and keeps only the protocol fields', () => {
        const checked = checkSnapshotManifest({ ...one({ mode: 0o644, extra: 'dropped' }), injected: true }, rules);
        expect(checked.items[0]).toEqual({
            volume: 'data',
            path: 'a.bin',
            kind: 'file',
            size: 12,
            sha256: sha(Buffer.from('notes by Ada')),
            mode: 0o644,
        });
        expect(checked).not.toHaveProperty('injected');
        expect(checked.stats).toEqual({ 'app.sqlite': { rows: { notes: 3 } } });
    });

    it('refuses paths the host must never take: .., ., absolute, empty segments, NUL, backslash, control characters', () => {
        for (const path of ['../x', 'a/../x', './x', '/etc/passwd', 'a//b', 'a/', '', 'a\u0000b', 'a\\b', 'a\nb']) {
            refused(one({ path }), /^Item 0 /);
        }
        refused(one({ path: 'a/'.repeat(32) + 'b' }), /over 32 segments/);
        refused(one({ path: 'é'.repeat(513) }), /over 1024 bytes/);
        expect(() => checkSnapshotManifest(one({ path: 'uploads/2026/11/a.png' }), rules)).not.toThrow();
    });

    it('names items by index, never by path', () => {
        try {
            checkSnapshotManifest(one({ path: 'secret/alice-medical.txt', volume: 'cache' }), rules);
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(PluginSnapshotError);
            expect((error as Error).message).not.toContain('alice');
        }
    });

    it('refuses an undeclared or ephemeral volume, duplicates, and companions beside a database', () => {
        refused(one({ volume: 'cache' }), /Item 0 names no volume/);
        const a = itemOf(Buffer.from('a'), { path: 'x' });
        refused(manifestOf([a, { ...a }]), /Item 1 is listed twice/);
        // The same path on another volume is another file.
        expect(() => checkSnapshotManifest(manifestOf([a, { ...a, volume: 'files' }]), rules)).not.toThrow();
        const database = itemOf(Buffer.from('db'), { kind: 'database', path: 'app.sqlite' });
        for (const suffix of ['-wal', '-shm', '-journal']) {
            refused(
                manifestOf([database, itemOf(Buffer.from('w'), { path: `app.sqlite${suffix}` })]),
                /beside a database/,
            );
        }
        // A companion name beside a plain file is just a file.
        expect(() =>
            checkSnapshotManifest(manifestOf([a, itemOf(Buffer.from('w'), { path: 'x-wal' })]), rules),
        ).not.toThrow();
    });

    it('refuses a bad protocol, a newer schema, and bad hashes, sizes, modes and journal modes', () => {
        refused({ ...one({}), protocol: 2 }, /protocol must be 1/);
        refused({ ...one({}), schemaVersion: 5 }, /data version \(5\) is above what the installed version reads \(4\)/);
        refused({ ...one({}), schemaVersion: -1 }, /schemaVersion/);
        refused(one({ sha256: 'ABC' }), /no SHA-256/);
        refused(one({ size: 1.5 }), /size/);
        refused(one({ mode: 0o17777 }), /mode/);
        refused(one({ journalMode: 'wal' }), /journal mode/);
        refused(one({ kind: 'symlink' }), /kind/);
        refused('not an object', /not an object/);
    });

    it('holds chunk lists to 4 MiB chunks: every database and every item over 64 MiB lists them', () => {
        refused(one({ kind: 'database' }), /lists no chunks/);
        refused(one({ size: PLUGIN_WHOLE_ITEM_MAX_BYTES + 1 }), /lists no chunks/);
        refused(one({ size: PLUGIN_CHUNK_BYTES + 1, chunks: ['a'.repeat(64)] }), /lists 1 chunks where its size has 2/);
        refused(one({ chunks: ['b'.repeat(64)] }), /one chunk whose hash isn't the item's/);
        // An item up to 64 MiB may be one chunk.
        expect(() => checkSnapshotManifest(one({ size: PLUGIN_WHOLE_ITEM_MAX_BYTES }), rules)).not.toThrow();
    });

    it('holds the snapshot to 20 GiB by default, to a raised limit, and to 200,000 items', () => {
        const big = (count: number) =>
            manifestOf(
                Array.from({ length: count }, (_, n) =>
                    itemOf(Buffer.alloc(0), {
                        path: `f${n}`,
                        size: 10 * 1024 ** 3,
                        chunks: Array.from({ length: (10 * 1024 ** 3) / PLUGIN_CHUNK_BYTES }, () => 'c'.repeat(64)),
                    }),
                ),
            );
        expect(PLUGIN_SNAPSHOT_MAX_BYTES).toBe(20 * 1024 ** 3);
        expect(() => checkSnapshotManifest(big(2), rules)).not.toThrow();
        refused(big(3), /over its size limit/);
        expect(() => checkSnapshotManifest(big(3), { ...rules, maxBytes: 40 * 1024 ** 3 })).not.toThrow();
        const many = manifestOf([]);
        many.items = Array.from({ length: PLUGIN_SNAPSHOT_MAX_ITEMS + 1 }, (_, n) => ({
            volume: 'data',
            path: `f${n}`,
            kind: 'file' as const,
            size: 0,
            sha256: sha(Buffer.alloc(0)),
        }));
        refused(many, /more than 200000 items/);
    });
});

// ── Taking a snapshot ────────────────────────────────────────────────────

describe('taking a snapshot', () => {
    it('fetches each chunk, seals chunks and the record at rest, and always ends the snapshot', async () => {
        const dir = scratch();
        const db = readFileSync(sqliteFile(dir));
        const note = Buffer.from('PLAINTEXT-MARKER '.repeat(100));
        const items = [
            itemOf(db, { kind: 'database', path: 'app.sqlite', journalMode: 'wal' }),
            itemOf(note, { path: 'uploads/alice.txt', mode: 0o644 }),
        ];
        const plugin = await fakePlugin(items);
        const { store: s, directory } = store();
        const taken = await take(s, plugin);

        const count = Math.ceil(db.length / PLUGIN_CHUNK_BYTES);
        expect(count).toBeGreaterThan(1);
        expect(taken.fetched.chunks).toBe(count + 1);
        expect(taken.reused).toBe(0);
        expect(taken.ended).toBe(true);
        expect(plugin.requests.at(-1)).toBe(`DELETE /__cb/backup/${taken.snapshot.snapshotId}`);
        expect(plugin.fetches()).toContain(`GET /__cb/backup/${taken.snapshot.snapshotId}/items/0?chunk=1`);
        expect(plugin.fetches()).toContain(`GET /__cb/backup/${taken.snapshot.snapshotId}/items/1`);

        // Sealed at rest: no plaintext in a chunk or the record, files 0600.
        const root = join(directory, PLUGIN_STORE, 'notes');
        const chunks = readdirSync(join(root, 'chunks'));
        expect(chunks).toContain(`${items[1]!.sha256}.sealed`);
        for (const name of chunks) {
            const bytes = readFileSync(join(root, 'chunks', name));
            expect(bytes.subarray(0, 4).toString()).toBe('CBF2');
            expect(bytes.includes(Buffer.from('PLAINTEXT-MARKER'))).toBe(false);
            expect(bytes.includes(Buffer.from('SQLite format 3'))).toBe(false);
        }
        const [record] = readdirSync(join(root, 'snapshots'));
        expect(record).toMatch(new RegExp(`^\\d{8}-\\d{6}-${taken.snapshot.snapshotId}\\.json$`));
        const recordBytes = readFileSync(join(root, 'snapshots', record!));
        expect(recordBytes.includes(Buffer.from('alice'))).toBe(false);
        expect(recordBytes.includes(Buffer.from('east'))).toBe(false);

        // The record holds the host's fields and the checked manifest.
        const read = s.read('notes', taken.snapshot.snapshotId);
        expect(read).toMatchObject({
            pluginId: 'notes',
            reason: 'manual',
            install: { version: '1.0.0', revision: 'rev-3', schema: 4 },
            settings: { region: 'east' },
            bytes: db.length + note.length,
        });
        expect(read.manifest.items.map((item) => item.path)).toEqual(['app.sqlite', 'uploads/alice.txt']);
        expect(read.manifest.items[0]!.journalMode).toBe('wal');
        expect(await s.verify('notes', taken.snapshot.snapshotId)).toMatchObject({ ok: true, databases: 1 });
    });

    it('dedupes: unchanged chunks are never fetched again, and one hash listed twice is fetched once', async () => {
        const dir = scratch();
        const path = sqliteFile(dir);
        const { store: s } = store();
        const first = await take(
            s,
            await fakePlugin([itemOf(readFileSync(path), { kind: 'database', path: 'app.sqlite' })]),
        );
        const count = first.fetched.chunks;

        const again = await fakePlugin([itemOf(readFileSync(path), { kind: 'database', path: 'app.sqlite' })]);
        const second = await take(s, again);
        expect(second.fetched.chunks).toBe(0);
        expect(second.reused).toBe(count);
        expect(again.fetches()).toEqual([]);

        // One row changed: only the pages that hold it (and the header) are new.
        const db = new DatabaseSync(path);
        db.prepare('UPDATE notes SET body = ? WHERE id = 2400').run(randomBytes(4000));
        db.close();
        const third = await take(
            s,
            await fakePlugin([itemOf(readFileSync(path), { kind: 'database', path: 'app.sqlite' })]),
        );
        expect(third.fetched.chunks).toBeGreaterThan(0);
        expect(third.fetched.chunks).toBeLessThan(count);

        const same = Buffer.from('same bytes');
        const twice = await fakePlugin([itemOf(same, { path: 'a' }), itemOf(same, { path: 'b' })]);
        const taken = await take(s, twice);
        expect(taken.fetched.chunks).toBe(1);
        expect(twice.fetches()).toHaveLength(1);
        expect(await s.verify('notes', taken.snapshot.snapshotId)).toMatchObject({ ok: true });
    });

    it("keeps a store per plugin: another plugin's chunk is fetched anyway, never shared", async () => {
        const data = Buffer.from('a file both plugins list');
        const { store: s, directory } = store();
        await take(s, await fakePlugin([itemOf(data)]), { pluginId: 'notes' });
        const other = await fakePlugin([itemOf(data)]);
        const taken = await take(s, other, { pluginId: 'tasks' });
        expect(taken.fetched.chunks).toBe(1);
        expect(other.fetches()).toHaveLength(1);
        expect(existsSync(join(directory, PLUGIN_STORE, 'tasks', 'chunks', `${sha(data)}.sealed`))).toBe(true);

        // Sealed to its plugin: one plugin's chunk copied into another's store doesn't open.
        const lone = Buffer.from('only notes has this');
        await take(s, await fakePlugin([itemOf(lone)]), { pluginId: 'notes' });
        const forged = await fakePlugin([itemOf(lone)], { body: () => Buffer.from('nope') });
        const name = `${sha(lone)}.sealed`;
        cpSync(
            join(directory, PLUGIN_STORE, 'notes', 'chunks', name),
            join(directory, PLUGIN_STORE, 'tasks', 'chunks', name),
        );
        // The store sees a chunk of the right size, so it isn't fetched; the drill finds it doesn't open.
        const planted = await take(s, forged, { pluginId: 'tasks' });
        expect(planted.reused).toBe(1);
        expect(await s.verify('tasks', planted.snapshot.snapshotId)).toMatchObject({
            ok: false,
            error: 'Item 0 is missing or damaged.',
        });
    });

    it('fails a hash lie, stores nothing for it, and still ends the snapshot', async () => {
        const plugin = await fakePlugin([itemOf(Buffer.from('the real bytes'))], {
            body: () => Buffer.from('other  bytes!!'),
        });
        const { store: s, directory } = store();
        await expect(take(s, plugin)).rejects.toThrow("Item 0 doesn't match its SHA-256.");
        expect(plugin.requests.at(-1)).toMatch(/^DELETE /);
        expect(readdirSync(join(directory, PLUGIN_STORE, 'notes', 'chunks'))).toEqual([]);
        expect(s.list('notes')).toEqual([]);
    });

    it('cuts a chunk at its declared size, and fails a short one', async () => {
        const data = Buffer.from('twelve bytes');
        const { store: s, directory } = store();
        const bomb = await fakePlugin([itemOf(data)], { body: () => Buffer.alloc(8 * 1024 * 1024, 1) });
        await expect(take(s, bomb)).rejects.toThrow('Item 0 is larger than declared.');
        const short = await fakePlugin([itemOf(data)], { body: (_i, _c, bytes) => bytes.subarray(0, 4) });
        await expect(take(s, short)).rejects.toThrow('Item 0 is shorter than declared.');
        expect(readdirSync(join(directory, PLUGIN_STORE, 'notes', 'chunks'))).toEqual([]);
    });

    it('checks the manifest before fetching anything: its cap, its limits, its checks', async () => {
        const { store: s } = store();
        const items = [itemOf(Buffer.alloc(1000, 7))];
        const huge = await fakePlugin(items, {
            answer: JSON.stringify({
                state: 'ready',
                manifest: manifestOf(items),
                pad: 'x'.repeat(PLUGIN_MANIFEST_MAX_BYTES),
            }),
        });
        await expect(take(s, huge)).rejects.toThrow(`The manifest is over ${PLUGIN_MANIFEST_MAX_BYTES} bytes.`);
        expect(huge.fetches()).toEqual([]);
        expect(huge.requests.at(-1)).toMatch(/^DELETE /);

        const over = await fakePlugin(items);
        await expect(take(s, over, { maxBytes: 999 })).rejects.toThrow('over its size limit (999 bytes)');
        expect(over.fetches()).toEqual([]);
        // An admin's raised limit lets it through.
        await expect(take(s, over, { maxBytes: 1000 })).resolves.toMatchObject({ fetched: { chunks: 1 } });

        const traversal = await fakePlugin(items, { manifest: manifestOf([{ ...items[0]!, path: '../../etc/x' }]) });
        await expect(take(s, traversal)).rejects.toThrow(/^Item 0 /);
        expect(traversal.fetches()).toEqual([]);

        const preparing = await fakePlugin(items, { answer: JSON.stringify({ state: 'preparing' }) });
        await expect(take(s, preparing)).rejects.toThrow('The plugin has no ready snapshot for this id.');
        const garbled = await fakePlugin(items, { answer: '{not json' });
        await expect(take(s, garbled)).rejects.toThrow("The plugin's snapshot answer couldn't be read.");
        const down = await fakePlugin(items, { status: 503 });
        await expect(take(s, down)).rejects.toThrow('The plugin answered 503 for its snapshot.');
    });

    it('refuses when the backup volume is short of the new chunks plus 10%, before fetching', async () => {
        const data = Buffer.alloc(100_000, 3);
        const plugin = await fakePlugin([itemOf(data)]);
        const { store: s } = store({ freeBytes: async () => 100_000 });
        await expect(take(s, plugin)).rejects.toThrow(/short of space/);
        expect(plugin.fetches()).toEqual([]);
        const { store: roomy } = store({ freeBytes: async () => 111_000 });
        await expect(take(roomy, plugin)).resolves.toMatchObject({ fetched: { chunks: 1 } });
    });

    it('fails a plugin that runs out of time, and ends its snapshot', async () => {
        const plugin = await fakePlugin([itemOf(Buffer.alloc(5000, 1))], { body: () => 'hang' });
        const { store: s, directory } = store({ timeMs: 300 });
        await expect(take(s, plugin)).rejects.toThrow('The snapshot ran out of time.');
        expect(plugin.requests.at(-1)).toMatch(/^DELETE /);
        expect(readdirSync(join(directory, PLUGIN_STORE, 'notes', 'chunks'))).toEqual([]);
    });

    it('refuses bad ids, reasons and run stamps before calling the plugin', async () => {
        const plugin = await fakePlugin([itemOf(Buffer.from('x'))]);
        const { store: s } = store();
        const base = { install, source: plugin.source(newSnapshotId()) };
        await expect(
            s.take({ ...base, pluginId: '../x', snapshotId: newSnapshotId(), reason: 'manual' }),
        ).rejects.toThrow('Not a plugin id.');
        await expect(s.take({ ...base, pluginId: 'notes', snapshotId: '../../x', reason: 'manual' })).rejects.toThrow(
            'A snapshot id is a ULID.',
        );
        await expect(
            s.take({ ...base, pluginId: 'notes', snapshotId: newSnapshotId(), reason: 'scheduled' }),
        ).rejects.toThrow(/run's stamp/);
        await expect(
            s.take({
                ...base,
                pluginId: 'notes',
                snapshotId: newSnapshotId(),
                reason: 'manual',
                run: '20261121-010000',
            }),
        ).rejects.toThrow(/run's stamp/);
        expect(plugin.requests).toEqual([]);
    });

    it('seals a chunk again under the current key after a rotation', async () => {
        const data = Buffer.from('kept across a rotation');
        const directory = scratch();
        const old = { current: randomBytes(32), legacy: 'session secret' };
        const before = new PluginSnapshotStore({
            directory,
            box: new SecretBox(old, 'backups'),
            freeBytes: async () => 1e15,
        });
        await take(before, await fakePlugin([itemOf(data)]));

        const rotated = new SecretBox(
            { current: randomBytes(32), previous: old.current, legacy: old.legacy },
            'backups',
        );
        const after = new PluginSnapshotStore({ directory, box: rotated, freeBytes: async () => 1e15 });
        const again = await fakePlugin([itemOf(data)]);
        const taken = await take(after, again);
        expect(taken.fetched.chunks).toBe(1);
        const sealed = readFileSync(join(directory, PLUGIN_STORE, 'notes', 'chunks', `${sha(data)}.sealed`));
        expect(rotated.bytesKey(sealed)).toBe(rotated.currentKey);
        // Every snapshot that lists it reads the new seal.
        for (const { snapshotId } of after.list('notes')) {
            expect(await after.verify('notes', snapshotId)).toMatchObject({ ok: true });
        }
    });
});

// ── The level 1 drill ────────────────────────────────────────────────────

describe('level 1 verification', () => {
    it('catches a damaged, missing or swapped chunk', async () => {
        const dir = scratch();
        const db = readFileSync(sqliteFile(dir));
        const { store: s, directory } = store();
        const taken = await take(s, await fakePlugin([itemOf(db, { kind: 'database', path: 'app.sqlite' })]));
        const id = taken.snapshot.snapshotId;
        const item = taken.snapshot.manifest.items[0]!;
        const chunkFile = (n: number) => join(directory, PLUGIN_STORE, 'notes', 'chunks', `${item.chunks![n]}.sealed`);

        const original = readFileSync(chunkFile(1));
        const damaged = Buffer.from(original);
        damaged[damaged.length - 10]! ^= 1;
        writeFileSync(chunkFile(1), damaged);
        expect(await s.verify('notes', id)).toMatchObject({
            ok: false,
            error: 'Item 0 chunk 1 is missing or damaged.',
        });

        // Another chunk's seal under this name: bound to its hash, it doesn't open.
        writeFileSync(chunkFile(1), readFileSync(chunkFile(0)));
        expect(await s.verify('notes', id)).toMatchObject({
            ok: false,
            error: 'Item 0 chunk 1 is missing or damaged.',
        });

        rmSync(chunkFile(1));
        expect(await s.verify('notes', id)).toMatchObject({
            ok: false,
            error: 'Item 0 chunk 1 is missing or damaged.',
        });
        writeFileSync(chunkFile(1), original);
        expect(await s.verify('notes', id)).toMatchObject({ ok: true, chunks: item.chunks!.length, bytes: db.length });
    });

    it("fails a database whose hashes match but which isn't a sound database", async () => {
        const dir = scratch();
        const db = readFileSync(sqliteFile(dir, 50));
        // Page 2 onwards overwritten, as a plugin's broken copy would be.
        randomBytes(db.length - 4096).copy(db, 4096);
        const { store: s } = store();
        const taken = await take(s, await fakePlugin([itemOf(db, { kind: 'database', path: 'app.sqlite' })]));
        expect(await s.verify('notes', taken.snapshot.snapshotId)).toMatchObject({
            ok: false,
            databases: 1,
            error: 'Item 0 fails its integrity check.',
        });
        // The scratch copy is gone.
        expect(existsSync(join(s.pluginDir('notes'), 'scratch'))).toBe(false);
        expect(readdirSync(s.pluginDir('notes'))).toEqual(['chunks', 'snapshots']);
    });

    it("can't be opened for a record that is damaged or isn't there", async () => {
        const { store: s } = store();
        const taken = await take(s, await fakePlugin([itemOf(Buffer.from('x'))]));
        expect(await s.verify('notes', newSnapshotId())).toMatchObject({ ok: false });
        const [file] = readdirSync(join(s.pluginDir('notes'), 'snapshots'));
        const path = join(s.pluginDir('notes'), 'snapshots', file!);
        const bytes = readFileSync(path);
        bytes[bytes.length - 1]! ^= 1;
        writeFileSync(path, bytes);
        expect(await s.verify('notes', taken.snapshot.snapshotId)).toEqual({
            ok: false,
            chunks: 0,
            bytes: 0,
            databases: 0,
            error: "The snapshot's record couldn't be opened.",
        });
    });
});

// ── Retention and the sweep ──────────────────────────────────────────────

describe('pruning and the sweep', () => {
    it('keeps run snapshots with their run, three of each other reason, uninstalls for the purge days; sweeps the rest', async () => {
        let now = Date.UTC(2026, 10, 1);
        const { store: s } = store({ now: () => now });
        const snap = async (label: string, patch: Parameters<typeof take>[2]) => {
            now += 60_000;
            const taken = await take(s, await fakePlugin([itemOf(Buffer.from(label))]), patch);
            return { id: taken.snapshot.snapshotId, hash: sha(Buffer.from(label)) };
        };
        const runs = [
            await snap('run 1', { run: '20261101-000000' }),
            await snap('run 2', { run: '20261102-000000' }),
            await snap('run 3', { run: '20261102-000000-1' }),
        ];
        const manual = [];
        for (let n = 0; n < 5; n++) {
            manual.push(await snap(`manual ${n}`, { reason: 'manual' }));
        }
        const requested = await snap('request', { reason: 'request' });
        const uninstall = await snap('uninstall', { reason: 'uninstall' });
        const shared = await snap('run 2', { reason: 'pre-update' });
        // A failed snapshot's chunk and a leftover temporary file.
        const leftover = join(s.pluginDir('notes'), 'chunks', `${'d'.repeat(64)}.sealed`);
        writeFileSync(leftover, 'orphan');
        writeFileSync(`${leftover}.tmp-123`, 'partial');

        now += 10 * DAY;
        const result = await s.prune({ runs: ['20261102-000000', '20261102-000000-1'], purgeDays: 30 });
        const left = s.list('notes').map((entry) => entry.snapshotId);
        expect(left).not.toContain(runs[0]!.id);
        expect(left).toEqual(
            expect.arrayContaining([
                runs[1]!.id,
                runs[2]!.id,
                ...manual.slice(2).map((m) => m.id),
                requested.id,
                uninstall.id,
            ]),
        );
        expect(left).not.toContain(manual[0]!.id);
        expect(left).not.toContain(manual[1]!.id);
        expect(result.removed.map((entry) => entry.snapshotId).sort()).toEqual(
            [runs[0]!.id, manual[0]!.id, manual[1]!.id].sort(),
        );
        // run 1, manual 0 and 1, and the orphan were swept; run 2's chunk stays, listed by a run and the pre-update.
        expect(result.chunks).toBe(4);
        const chunks = readdirSync(join(s.pluginDir('notes'), 'chunks'));
        expect(chunks).toContain(`${shared.hash}.sealed`);
        expect(chunks).not.toContain(`${runs[0]!.hash}.sealed`);
        expect(chunks.some((name) => name.includes('.tmp-'))).toBe(false);
        for (const id of left) {
            expect(await s.verify('notes', id)).toMatchObject({ ok: true });
        }

        // Past the purge days the uninstall snapshot goes; with no runs kept, nothing of this plugin is left.
        now += 30 * DAY;
        await s.prune({ runs: [], purgeDays: 30 });
        expect(s.list('notes').map((entry) => entry.snapshotId)).not.toContain(uninstall.id);
        expect(s.list('notes')).toHaveLength(5);
    });

    it("removes a plugin's directory once nothing is kept", async () => {
        let now = Date.UTC(2026, 10, 1);
        const { store: s, directory } = store({ now: () => now });
        await take(s, await fakePlugin([itemOf(Buffer.from('gone'))]), { reason: 'uninstall' });
        now += 31 * DAY;
        await s.prune({ runs: [], purgeDays: 30 });
        expect(existsSync(join(directory, PLUGIN_STORE, 'notes'))).toBe(false);
        expect(s.plugins()).toEqual([]);
    });

    it("keeps an unreadable record and doesn't sweep its plugin's chunks", async () => {
        const { store: s } = store();
        await take(s, await fakePlugin([itemOf(Buffer.from('one'))]), { run: '20261101-000000' });
        await take(s, await fakePlugin([itemOf(Buffer.from('two'))]), { run: '20261102-000000' });
        const [first] = s.list('notes');
        const path = join(s.pluginDir('notes'), 'snapshots', first!.file);
        writeFileSync(path, 'damaged');
        const result = await s.prune({ runs: [], purgeDays: 30 });
        expect(result.unreadable).toEqual([{ pluginId: 'notes', file: first!.file }]);
        expect(result.chunks).toBe(0);
        // The second run aged out, but it is the newest good snapshot (step 5, `retainedPastRules`).
        expect(s.list('notes')).toHaveLength(2);
        expect(s.list('notes')[0]!.file).toBe(first!.file);
        const gone = await s.prune({ runs: [], purgeDays: 30, installed: new Set() });
        expect(gone.removed).toHaveLength(1);
        expect(s.list('notes').map((entry) => entry.file)).toEqual([first!.file]);
        expect(readdirSync(join(s.pluginDir('notes'), 'chunks'))).toHaveLength(2);
    });

    it('reads the kept runs from the database copies', () => {
        const dir = scratch();
        for (const name of [
            'company-brain-20261101-000000.sqlite',
            'company-brain-20261102-000000-1.sqlite',
            'company-brain-20261103-000000.sqlite.partial',
            'userdata-20261104-000000',
        ]) {
            writeFileSync(join(dir, name), '');
        }
        mkdirSync(join(dir, PLUGIN_STORE));
        expect(keptRunStamps(dir)).toEqual(['20261101-000000', '20261102-000000-1']);
        expect(keptRunStamps(join(dir, 'missing'))).toEqual([]);
    });
});

describe('the HTTP source', () => {
    it('treats a snapshot already gone as ended, and any other refusal of DELETE as not', async () => {
        const answer = (status: number) =>
            httpSnapshotSource(newSnapshotId(), async () => new Response(null, { status })).end(
                AbortSignal.timeout(1000),
            );
        await expect(answer(204)).resolves.toBeUndefined();
        await expect(answer(404)).resolves.toBeUndefined();
        await expect(answer(500)).rejects.toThrow('The plugin answered 500 to ending its snapshot.');
        expect(() => httpSnapshotSource('x/../y', async () => new Response())).toThrow('A snapshot id is a ULID.');
    });

    it('makes ULIDs: 26 Crockford characters, ordered by time', () => {
        const a = newSnapshotId(1_795_000_000_000);
        const b = newSnapshotId(1_795_000_000_001);
        expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
    });
});

describe('review round 1', () => {
    it('stores and verifies an unchunked file between 4 and 64 MiB as one chunk', async () => {
        const data = randomBytes(5 * 1024 * 1024);
        const plugin = await fakePlugin([itemOf(data, { path: 'big.bin' })]);
        const { store: s } = store();
        const taken = await take(s, plugin);
        expect(taken.fetched).toEqual({ chunks: 1, bytes: data.length });
        expect(plugin.fetches()).toEqual([`GET /__cb/backup/${taken.snapshot.snapshotId}/items/0`]);
        expect(await s.verify('notes', taken.snapshot.snapshotId)).toMatchObject({
            ok: true,
            chunks: 1,
            bytes: data.length,
        });
    });

    it('bounds the DELETE at the end, so a plugin that never answers it frees its lock', async () => {
        const data = Buffer.from('ends');
        const { store: s } = store({ endMs: 200 });
        const snapshotId = newSnapshotId();
        const plugin = await fakePlugin([itemOf(data)]);
        const real = plugin.source(snapshotId);
        const stalled = {
            ...real,
            end: (signal?: AbortSignal) =>
                new Promise<void>((_, fail) => signal?.addEventListener('abort', () => fail(signal.reason))),
        };
        const taken = await s.take({ pluginId: 'notes', snapshotId, reason: 'manual', install, source: stalled });
        expect(taken.ended).toBe(false);
        // The lock is free: the next operation on the plugin runs.
        expect(await s.verify('notes', snapshotId)).toMatchObject({ ok: true });
    });
});

describe('review round 2', () => {
    it('refuses one hash listed with two sizes before fetching or recording anything', async () => {
        const data = Buffer.from('six b!');
        const liar = { ...itemOf(data, { path: 'b' }), size: 99, data: Buffer.alloc(99) };
        const plugin = await fakePlugin([itemOf(data, { path: 'a' }), liar]);
        const { store: s } = store();
        await expect(take(s, plugin)).rejects.toThrow(
            'Item 1 lists a chunk hash another item lists with another size.',
        );
        expect(plugin.fetches()).toEqual([]);
        expect(s.list('notes')).toEqual([]);
    });

    it('fails a cancelled snapshot even when every chunk is already stored', async () => {
        const data = Buffer.from('already here');
        const { store: s } = store();
        await take(s, await fakePlugin([itemOf(data)]));
        const plugin = await fakePlugin([itemOf(data)]);
        const controller = new AbortController();
        const snapshotId = newSnapshotId();
        const source = plugin.source(snapshotId);
        const cancelling = {
            ...source,
            manifest: async (signal: AbortSignal) => {
                const body = await source.manifest(signal);
                // Cancelled once the whole answer is read: during the reuse scan.
                return (async function* () {
                    yield* body;
                    controller.abort();
                })();
            },
        };
        await expect(
            s.take({
                pluginId: 'notes',
                snapshotId,
                reason: 'manual',
                install,
                source: cancelling,
                signal: controller.signal,
            }),
        ).rejects.toThrow('The snapshot was cancelled.');
        expect(s.list('notes')).toHaveLength(1);
    });
});
