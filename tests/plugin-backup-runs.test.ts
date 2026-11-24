// Plugin backups, step 5 (CB-458): plugin snapshots in the scheduled run,
// Back up now, a plugin's own request (at most one an hour and four a day),
// the off-site layout, notices and status. The plugins are fakes: the SDK's
// own backup side over scratch volumes (`socio.backup.serve`), reached the
// way the ingress would, and hand-made servers that hang, fail or lie.
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { ObjectStore } from '@socio/data/object-store';
import { ENVELOPE_TTL_MS, newJti, requestTargetHash, signEnvelope } from '@socio/foundation/apps/envelope';
import { SecretBox } from '@socio/foundation/keys/secret-box';
import { GIB, type PluginBackupStatus } from '@socio/shared/plugins/plugin-backup';

import { socioApp } from '../packages/app-sdk/src/index.js';
import { BackupService, readBackupStatus } from '../src/server/backup/backup-service.js';
import { pluginBackupMaxBytes } from '../src/server/backup/layer.js';
import { pluginChunkName, pluginChunkNameKey } from '../src/server/backup/plugin-offsite.js';
import {
    PLUGIN_NOTICE_EVERY_MS,
    observeSnapshotNotices,
    recordAttempt,
    requestAllowed,
    withSnapshots,
    type PluginBackupTarget,
    type PluginHostRequest,
    type PluginSnapshotHost,
} from '../src/server/backup/plugin-snapshots.js';
import { PluginSnapshotStore, retainedPastRules } from '../src/server/backup/plugin-store.js';
import { pluginBackupLimitsFromEnv } from '../src/server/composition/config.js';
import { pluginSnapshotHost } from '../src/server/composition/lifecycle/backup.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});
const scratch = (name = 'plugin-runs-') => {
    const dir = mkdtempSync(join(tmpdir(), name));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

// ── Fake plugins ─────────────────────────────────────────────────────────

const KEY = randomBytes(32);

/** As `signHostEnvelope` signs it: one clock reading, so `exp - iat` is exactly the TTL the SDK allows. */
const hostEnvelope = (id: string, method: string, target: string) => {
    const now = Date.now();
    return signEnvelope(KEY, {
        aud: `plugin:${id}`,
        sub: 'host',
        acc: 'host',
        req: { m: method, p: requestTargetHash(target) },
        iat: now,
        exp: now + ENVELOPE_TTL_MS,
        jti: newJti(),
    });
};

type Handler = (request: Request) => Response | Promise<Response>;

/** A plugin that speaks the protocol through the SDK, over a scratch volume with a few files and a database. */
function sdkPlugin(id: string, options: { statfs?: () => Promise<{ bavail: number; bsize: number }> } = {}) {
    const volume = scratch(`${id}-volume-`);
    writeFileSync(join(volume, 'note-1.txt'), 'Ada wrote this.');
    mkdirSync(join(volume, 'uploads'));
    writeFileSync(join(volume, 'uploads', 'a.bin'), randomBytes(5000));
    const db = new DatabaseSync(join(volume, 'app.sqlite'));
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
    db.prepare('INSERT INTO notes (body) VALUES (?)').run('first');
    cleanup.push(() => db.close());
    const socio = socioApp({ appId: `plugin:${id}`, key: KEY.toString('base64url'), env: {} });
    const served = socio.backup.serve({
        volumes: { data: volume },
        schemaVersion: 3,
        pluginVersion: '1.4.0',
        exit: () => undefined,
        ...(options.statfs ? { statfs: options.statfs } : {}),
    });
    cleanup.push(() => served.close());
    const handler: Handler = socio.fetchHandler(() => new Response('acme app'));
    return { id, volume, db, handler };
}

/** One host call, as the ingress would deliver it: signed for the host, honoring the abort. */
function callInto(handlers: Record<string, Handler>, log: string[] = []): PluginHostRequest {
    return async (id, request) => {
        log.push(`${id} ${request.task} ${request.method} ${request.target}`);
        const handler = handlers[id];
        if (!handler) {
            return new Response(null, { status: 503 });
        }
        const answer = Promise.resolve(
            handler(
                new Request(`http://plugin.invalid${request.target}`, {
                    method: request.method,
                    headers: {
                        'x-cb-actor': hostEnvelope(id, request.method, request.target),
                        ...(request.body ? { 'content-type': 'application/json' } : {}),
                    },
                    ...(request.body !== undefined ? { body: request.body } : {}),
                }),
            ),
        );
        if (!request.signal) {
            return answer;
        }
        request.signal.throwIfAborted();
        return Promise.race([
            answer,
            new Promise<never>((_, fail) =>
                request.signal!.addEventListener('abort', () => fail(request.signal!.reason), { once: true }),
            ),
        ]);
    };
}

/** A plugin that never answers: every request hangs until its abort. */
const hangs: Handler = () => new Promise<Response>(() => undefined);

/** A plugin that starts a snapshot, then reports it failed with `error`. */
const failsWith =
    (error: string): Handler =>
    (request) => {
        if (request.method === 'POST') {
            return new Response('{}', { status: 202 });
        }
        if (request.method === 'DELETE') {
            return new Response(null, { status: 204 });
        }
        return Response.json({ state: 'failed', error });
    };

const target = (id: string, patch: Partial<PluginBackupTarget> = {}): PluginBackupTarget => ({
    id,
    name: id === 'acme-notes' ? 'Acme Notes' : id,
    running: true,
    version: '1.4.0',
    revision: 'rev-1',
    schema: 3,
    volumes: ['data'],
    settings: { region: 'east' },
    ...patch,
});

const statusOf = (id: string, patch: Partial<PluginBackupStatus> = {}): PluginBackupStatus => ({
    id,
    name: id === 'acme-notes' ? 'Acme Notes' : id,
    state: 'not_backed_up',
    declared: true,
    volumes: ['data'],
    ...patch,
});

/** A memory S3 store, recording the order of puts. */
function memoryStore() {
    const objects = new Map<string, Buffer>();
    const puts: string[] = [];
    /** Set: a put of a key it matches fails, as a dropped connection would. */
    const control: { fail?: (key: string) => boolean } = {};
    const store: ObjectStore = {
        driver: 's3',
        async ensureReady() {},
        async put(key, body) {
            if (control.fail?.(key)) {
                throw new Error('network');
            }
            objects.set(key, Buffer.from(body));
            puts.push(key);
        },
        async get(key) {
            return objects.get(key);
        },
        async head(key) {
            const body = objects.get(key);
            return body && { size: body.length };
        },
        async delete(key) {
            objects.delete(key);
        },
        async list(prefix, cursor) {
            const keys = [...objects.keys()]
                .filter((key) => key.startsWith(prefix) && (!cursor || key > cursor))
                .sort();
            const page = keys.slice(0, 50);
            return {
                keys: page.map((key) => ({ key, size: objects.get(key)!.length })),
                ...(keys.length > page.length ? { next: page[page.length - 1] } : {}),
            };
        },
    } as ObjectStore;
    return { store, objects, puts, control };
}

// ── The fixture ──────────────────────────────────────────────────────────

function fixture(
    options: {
        targets?: PluginBackupTarget[];
        handlers?: Record<string, Handler>;
        keep?: number;
        keys?: boolean;
        offsite?: boolean;
        maxBytes?: number;
        timeMs?: number;
        freeBytes?: number;
        tasks?: string[];
        now?: { value: number };
    } = {},
) {
    const root = scratch();
    const backupDir = join(root, 'backups');
    const userData = join(root, 'userdata');
    mkdirSync(userData, { recursive: true });
    const databasePath = join(root, 'workspace.sqlite');
    const workspace = new DatabaseSync(databasePath);
    workspace.exec('CREATE TABLE t (x)');
    workspace.close();
    const keys =
        options.keys === false ? { legacy: 'session secret' } : { current: randomBytes(32), legacy: 'session secret' };
    let targets = options.targets ?? [target('acme-notes')];
    const handlers = options.handlers ?? {};
    const log: string[] = [];
    const calls: string[] = [];
    const notices: { title: string; message: string; path: string }[] = [];
    const clock = options.now ?? { value: Date.UTC(2026, 10, 22, 9) };
    const host: PluginSnapshotHost = {
        targets: () => targets,
        tasks: async () => options.tasks ?? ['task-a', 'task-b'],
        call: callInto(handlers, calls),
    };
    const offsite = options.offsite ? memoryStore() : undefined;
    let tick = 0;
    const service = new BackupService({
        databasePath,
        userDataDir: userData,
        settings: {
            directory: backupDir,
            keep: options.keep ?? 3,
            intervalHours: 24,
            purgeBackupDays: 30,
            ...(offsite
                ? {
                      offsite: {
                          endpoint: 'https://s3.invalid',
                          region: 'auto',
                          bucket: 'acme-backups',
                          accessKeyId: 'x',
                          secretAccessKey: 'y',
                          prefix: 'acme/',
                      } as never,
                  }
                : {}),
        },
        ...(offsite ? { offsiteStore: offsite.store } : {}),
        keys,
        log: (line) => log.push(line),
        // Each read a second later, so runs get stamps of their own.
        now: () => clock.value + tick++ * 1000,
        plugins: () => targets.map((t) => statusOf(t.id, { name: t.name })),
        onPluginGap: async (notice) => {
            notices.push(notice);
        },
        pluginSnapshots: {
            host,
            maxBytes: () => options.maxBytes ?? 20 * GIB,
            pollMs: 5,
            endMs: 300,
            ...(options.timeMs ? { timeMs: options.timeMs } : {}),
            ...(options.freeBytes !== undefined ? { freeBytes: async () => options.freeBytes! } : {}),
        },
    });
    const store = () => new PluginSnapshotStore({ directory: backupDir, box: new SecretBox(keys as never, 'backups') });
    return {
        service,
        backupDir,
        keys,
        log,
        calls,
        notices,
        clock,
        offsite,
        store,
        setTargets: (next: PluginBackupTarget[]) => {
            targets = next;
        },
        status: (id: string) => service.status().plugins?.find((plugin) => plugin.id === id),
    };
}

// ── The scheduled run ────────────────────────────────────────────────────

describe('plugin snapshots in the scheduled run', () => {
    it('backs up a plugin that declares backups, so it is no longer "Not backed up"', async () => {
        const plugin = sdkPlugin('acme-notes');
        const f = fixture({ handlers: { 'acme-notes': plugin.handler } });
        expect(f.status('acme-notes')).toMatchObject({ state: 'not_backed_up', declared: true });

        const result = await f.service.run();
        expect(result).toBeDefined();
        expect(result!.plugins).toMatchObject({ taken: 1, failed: 0, skipped: 0 });
        const stamp = result!.database.match(/company-brain-(.+)\.sqlite$/)![1]!;

        const status = f.status('acme-notes')!;
        expect(status.state).toBe('ok');
        expect(status.lastSuccessAt).toBeGreaterThan(0);
        expect(status.sizeBytes).toBeGreaterThan(5000);
        expect(status.lastCheck).toMatchObject({ ok: true });
        expect(status.lastError).toBeUndefined();

        // In the store, with the run's stamp, the host's install and the plugin's files.
        const [snapshot] = f
            .store()
            .records('acme-notes')
            .records.map((r) => r.record);
        expect(snapshot).toMatchObject({
            reason: 'scheduled',
            run: stamp,
            install: { version: '1.4.0', revision: 'rev-1', schema: 3 },
            settings: { region: 'east' },
        });
        expect(snapshot!.manifest.items.map((item) => item.path).sort()).toEqual([
            'app.sqlite',
            'note-1.txt',
            'uploads/a.bin',
        ]);
        expect(f.service.pluginHistory('acme-notes')).toEqual([
            expect.objectContaining({ reason: 'scheduled', run: stamp, version: '1.4.0', bytes: snapshot!.bytes }),
        ]);

        // Every request of the snapshot went to one task, and its copy was dropped.
        const pinned = new Set(f.calls.map((line) => line.split(' ')[1]));
        expect(pinned).toEqual(new Set(['task-a']));
        expect(f.calls.some((line) => line.includes('DELETE /__cb/backup/'))).toBe(true);
        expect(f.log.some((line) => /^Backup: .*plugins: 1 snapshot\(s\) taken, 0 failed/.test(line))).toBe(true);
    });

    it('fetches only what changed on the next run', async () => {
        const plugin = sdkPlugin('acme-notes');
        const f = fixture({ handlers: { 'acme-notes': plugin.handler } });
        await f.service.run();
        writeFileSync(join(plugin.volume, 'note-2.txt'), 'Ada wrote more.');
        await f.service.run();
        const line = f.log.filter((entry) => entry.startsWith('Plugin backups: acme-notes (scheduled)')).at(-1)!;
        // The new note is new; the upload and the unchanged files are reused.
        expect(line).toMatch(/, [12] new chunk\(s\), [2-9]\d* reused\./);
    });

    it('fails a plugin that hangs alone: the workspace backup, the other plugins and the next run go on', async () => {
        const good = sdkPlugin('acme-notes');
        const f = fixture({
            targets: [target('acme-notes'), target('acme-stuck')],
            handlers: { 'acme-notes': good.handler, 'acme-stuck': hangs },
            // Ample for the real plugin under a loaded machine; the stuck one never answers.
            timeMs: 5_000,
            offsite: true,
        });
        const result = await f.service.run();
        expect(result!.plugins).toMatchObject({ taken: 1, failed: 1 });
        // The workspace's off-site copy, which a workspace upgrade waits for, still succeeds.
        expect(result!.offsiteError).toBeUndefined();
        expect(result!.offsite!.plugins).toMatchObject({ inRun: 1 });
        expect(readBackupStatus(f.backupDir).lastSuccessAt).toBeDefined();
        expect(readBackupStatus(f.backupDir).lastError).toBeUndefined();
        expect(f.status('acme-notes')!.state).toBe('ok');
        expect(f.status('acme-stuck')).toMatchObject({
            state: 'failing',
            lastError: 'The snapshot ran out of time.',
        });
        expect(f.notices.map((notice) => notice.title)).toEqual(['Plugin backup failed: acme-stuck']);
    });

    it('fails a plugin that hangs mid-snapshot alone, after it began', async () => {
        const f = fixture({
            targets: [target('acme-stuck')],
            handlers: {
                'acme-stuck': (request) =>
                    request.method === 'POST'
                        ? new Response('{}', { status: 202 })
                        : request.method === 'DELETE'
                          ? new Response(null, { status: 204 })
                          : Response.json({ state: 'preparing' }),
            },
            timeMs: 200,
        });
        const result = await f.service.run();
        expect(result!.plugins).toMatchObject({ taken: 0, failed: 1 });
        expect(f.status('acme-stuck')!.lastError).toBe('The snapshot ran out of time.');
        // The plugin's copy was still dropped.
        expect(f.calls.at(-1)).toMatch(/DELETE \/__cb\/backup\/[0-9A-Z]{26}$/);
    });

    it('fails a plugin short of space on its own volume with the plugin’s reason, and the rest of the run goes on', async () => {
        const full = sdkPlugin('acme-full', { statfs: async () => ({ bavail: 1, bsize: 512 }) });
        const good = sdkPlugin('acme-notes');
        const f = fixture({
            targets: [target('acme-full'), target('acme-notes')],
            handlers: { 'acme-full': full.handler, 'acme-notes': good.handler },
        });
        const result = await f.service.run();
        expect(result!.plugins).toMatchObject({ taken: 1, failed: 1 });
        expect(f.status('acme-full')).toMatchObject({
            state: 'failing',
            lastError:
                "The plugin couldn’t take its snapshot: There isn't enough free space on volume data to copy its files.",
        });
        expect(f.status('acme-notes')!.state).toBe('ok');
    });

    it('fails a plugin when the backup volume is short of space, before fetching anything', async () => {
        const plugin = sdkPlugin('acme-notes');
        const f = fixture({ handlers: { 'acme-notes': plugin.handler }, freeBytes: 100 });
        const result = await f.service.run();
        expect(result!.plugins).toMatchObject({ taken: 0, failed: 1 });
        expect(f.status('acme-notes')!.lastError).toMatch(
            /^The backup volume is short of space: the snapshot needs \d+ bytes and 100 are free\.$/,
        );
        expect(f.calls.some((line) => line.includes('/items/'))).toBe(false);
        expect(readBackupStatus(f.backupDir).lastError).toBeUndefined();
    });

    it('fails a plugin over the size cap in force, and passes once an admin raises it', async () => {
        const plugin = sdkPlugin('acme-notes');
        let cap = 1000;
        const f = fixture({ handlers: { 'acme-notes': plugin.handler } });
        // The service reads the cap at each snapshot.
        (
            f.service as unknown as { options: { pluginSnapshots: { maxBytes: () => number } } }
        ).options.pluginSnapshots.maxBytes = () => cap;
        await f.service.run();
        expect(f.status('acme-notes')!.lastError).toMatch(/over|larger|limit|cap/i);
        cap = 20 * GIB;
        await f.service.run();
        expect(f.status('acme-notes')!.state).toBe('ok');
    });

    it('reports a plugin that answers failed, or lies about a hash, without paths', async () => {
        const f = fixture({
            targets: [target('acme-broken')],
            handlers: { 'acme-broken': failsWith('Could not open /data/secret/ada.sqlite') },
        });
        await f.service.run();
        expect(f.status('acme-broken')!.lastError).toBe('The plugin couldn’t take its snapshot: Could not open …');

        const plugin = sdkPlugin('acme-notes');
        const liar: Handler = async (request) => {
            const answer = await plugin.handler(request);
            if (request.method === 'GET' && /\/items\/\d+/.test(new URL(request.url).pathname)) {
                const bytes = Buffer.from(await answer.arrayBuffer());
                bytes[0] = bytes[0]! ^ 0xff;
                return new Response(bytes, { status: 200 });
            }
            return answer;
        };
        const g = fixture({ handlers: { 'acme-notes': liar } });
        await g.service.run();
        expect(g.status('acme-notes')).toMatchObject({ state: 'failing' });
        expect(g.status('acme-notes')!.lastError).toMatch(/doesn't match its SHA-256/);
        expect(g.store().records('acme-notes').records).toEqual([]);
    });

    it('skips a disabled plugin, keeps its snapshots, and says since when', async () => {
        const plugin = sdkPlugin('acme-notes');
        const f = fixture({ handlers: { 'acme-notes': plugin.handler } });
        await f.service.run();
        expect(f.status('acme-notes'), f.log.join('\n')).toMatchObject({ state: 'ok' });
        f.setTargets([target('acme-notes', { running: false })]);
        const calls = f.calls.length;
        const result = await f.service.run();
        expect(result!.plugins).toMatchObject({ taken: 0, failed: 0, skipped: 1 });
        expect(f.calls.length).toBe(calls);
        const status = f.status('acme-notes')!;
        expect(status.state).toBe('disabled');
        expect(status.since).toBeGreaterThan(0);
        expect(status.lastSuccessAt).toBeDefined();
        expect(f.store().records('acme-notes').records).toHaveLength(1);
        expect(f.service.backUpPlugin('acme-notes', 'manual')).toMatchObject({ ok: false, status: 409 });
    });

    it('fails plugin snapshots without a data key, with a clear reason, and the run still succeeds', async () => {
        const plugin = sdkPlugin('acme-notes');
        const f = fixture({ handlers: { 'acme-notes': plugin.handler }, keys: false });
        const result = await f.service.run();
        expect(result!.plugins).toMatchObject({ taken: 0, failed: 1 });
        expect(f.status('acme-notes')!.lastError).toBe(
            'Plugin backups need DATA_ENCRYPTION_KEY: snapshots are sealed with it.',
        );
        expect(f.calls).toEqual([]);
    });

    it('fails a plugin with no running task, without reaching any', async () => {
        const plugin = sdkPlugin('acme-notes');
        const f = fixture({ handlers: { 'acme-notes': plugin.handler }, tasks: [] });
        await f.service.run();
        expect(f.status('acme-notes')!.lastError).toBe('The plugin isn’t running, so no snapshot could be taken.');
        expect(f.calls).toEqual([]);
    });
});

describe('review fixes (round 2)', () => {
    it('keeps every remote chunk a retained snapshot lists, even when one of them keeps failing to send', async () => {
        const f = fixture({ handlers: { 'acme-notes': sdkPlugin('acme-notes').handler }, offsite: true, keep: 1 });
        await (f.service.backUpPlugin('acme-notes', 'manual') as { done: Promise<unknown> }).done;
        await f.service.run();
        const manual = f
            .store()
            .records('acme-notes')
            .records.find((r) => r.record.reason === 'manual')!.record;
        const hashes = [...new Set(manual.manifest.items.flatMap((item) => item.chunks ?? [item.sha256]))];
        const nameKey = pluginChunkNameKey(f.keys.current!);
        const remote = (hash: string) => `acme/plugin-chunks/acme-notes/${pluginChunkName(nameKey, hash)}.sealed`;
        expect(hashes.every((hash) => f.offsite!.objects.has(remote(hash)))).toBe(true);
        // Its first chunk is damaged locally, and the plugin stops: its later snapshots don't relist them.
        writeFileSync(f.store().chunkFile('acme-notes', hashes[0]!), 'plaintext, not sealed');
        f.setTargets([target('acme-notes', { running: false })]);
        for (let n = 0; n < 4; n++) {
            await f.service.run();
        }
        // The manual snapshot is still kept, locally and off-site: so are all of its chunks.
        expect(
            f
                .store()
                .records('acme-notes')
                .records.some((r) => r.record.snapshotId === manual.snapshotId),
        ).toBe(true);
        expect(hashes.every((hash) => f.offsite!.objects.has(remote(hash)))).toBe(true);
    });

    it('sends a run’s plugin snapshot with a later copy when its first send failed, under the run it belongs to', async () => {
        const f = fixture({ handlers: { 'acme-notes': sdkPlugin('acme-notes').handler }, offsite: true, keep: 3 });
        f.offsite!.control.fail = (key) => key.includes('/plugins/acme-notes/');
        const first = await f.service.run();
        expect(first!.offsiteError).toBeUndefined();
        expect(first!.offsite!.plugins!.error).toMatch(/acme-notes/);
        const stamp = first!.database.match(/company-brain-(.+)\.sqlite$/)![1]!;
        const [record] = f.store().records('acme-notes').records;
        const key = `acme/snapshots/${stamp}/plugins/acme-notes/${record!.record.snapshotId}.json.sealed`;
        expect(f.offsite!.objects.has(key)).toBe(false);
        f.offsite!.control.fail = undefined;
        f.setTargets([target('acme-notes', { running: false })]);
        await f.service.run();
        expect(f.offsite!.objects.has(key)).toBe(true);
    });
});

describe('review fixes (round 1)', () => {
    it('keeps going when the plugin status file can’t be written: no unhandled rejection, the next plugin still runs', async () => {
        const f = fixture({
            targets: [target('acme-notes'), target('acme-tasks')],
            handlers: { 'acme-notes': sdkPlugin('acme-notes').handler, 'acme-tasks': sdkPlugin('acme-tasks').handler },
        });
        // A directory where the file goes: every write fails (as ENOSPC would).
        mkdirSync(join(f.backupDir, 'plugin-snapshots.json'), { recursive: true });
        const result = await f.service.run();
        expect(result).toBeDefined();
        expect(result!.plugins).toMatchObject({ taken: 2, failed: 0 });
        expect(f.calls.some((line) => line.startsWith('acme-tasks '))).toBe(true);
        expect(f.log.some((line) => line.startsWith('Plugin backups: recording acme-notes failed'))).toBe(true);
        // Back up now too.
        const manual = f.service.backUpPlugin('acme-notes', 'manual') as { done: Promise<{ ok: boolean }> };
        expect((await manual.done).ok).toBe(true);
    });

    it('sends DELETE when the start’s answer is lost, so the plugin’s copy doesn’t wait for its lease', async () => {
        const plugin = sdkPlugin('acme-notes');
        let lost = true;
        const f = fixture({
            handlers: {
                'acme-notes': async (request) => {
                    if (request.method === 'POST' && lost) {
                        lost = false;
                        await plugin.handler(request);
                        throw new TypeError('fetch failed');
                    }
                    return plugin.handler(request);
                },
            },
        });
        await f.service.run();
        expect(f.status('acme-notes')!.state).toBe('failing');
        expect(f.calls.map((line) => line.split(' ').slice(2).join(' '))).toEqual([
            'POST /__cb/backup',
            expect.stringMatching(/^DELETE \/__cb\/backup\/[0-9A-Z]{26}$/),
        ]);
    });

    it('completes the workspace off-site copy when one plugin’s files can’t be sent, and doesn’t advertise that snapshot', async () => {
        const f = fixture({
            targets: [target('acme-notes'), target('acme-tasks')],
            handlers: { 'acme-notes': sdkPlugin('acme-notes').handler, 'acme-tasks': sdkPlugin('acme-tasks').handler },
            offsite: true,
        });
        await f.service.run();
        // Damage one stored chunk of acme-notes: it no longer reads as sealed.
        const [record] = f.store().records('acme-notes').records;
        const hash = record!.record.manifest.items[0]!.chunks?.[0] ?? record!.record.manifest.items[0]!.sha256;
        writeFileSync(f.store().chunkFile('acme-notes', hash), 'plaintext, not sealed');
        f.setTargets([target('acme-notes', { running: false }), target('acme-tasks')]);
        const result = await f.service.run();
        expect(result!.offsiteError).toBeUndefined();
        const stamp = result!.database.match(/company-brain-(.+)\.sqlite$/)![1]!;
        const { objects } = f.offsite!;
        expect(objects.has(`acme/snapshots/${stamp}/complete`)).toBe(true);
        // The healthy plugin's run snapshot is in the run.
        expect([...objects.keys()].some((key) => key.startsWith(`acme/snapshots/${stamp}/plugins/acme-tasks/`))).toBe(
            true,
        );
        // The damaged one's record, now outside a kept run, isn't sent.
        expect([...objects.keys()].some((key) => key.startsWith('acme/plugin-snapshots/acme-notes/'))).toBe(false);
        expect(result!.offsite!.plugins!.error).toMatch(/acme-notes/);
    });
});

// ── Notices and status ───────────────────────────────────────────────────

describe('notices and status', () => {
    it('tells admins on the first failure, at most once a day while it fails, and when it recovers', async () => {
        let handler: Handler = failsWith('Disk is busy.');
        const clock = { value: Date.UTC(2026, 10, 22, 9) };
        const f = fixture({
            targets: [target('acme-notes')],
            handlers: { 'acme-notes': (r) => handler(r) },
            now: clock,
        });
        await f.service.run();
        await f.service.run();
        expect(f.notices.map((notice) => notice.title)).toEqual(['Plugin backup failed: Acme Notes']);
        expect(f.notices[0]).toMatchObject({ path: '/settings/plugins/acme-notes' });
        expect(f.notices[0]!.message).toContain('Disk is busy.');
        expect(f.notices[0]!.message).toContain('It has no good backup yet.');
        expect(f.status('acme-notes')).toMatchObject({ state: 'failing' });
        const since = f.status('acme-notes')!.since!;

        clock.value += PLUGIN_NOTICE_EVERY_MS;
        await f.service.run();
        expect(f.notices).toHaveLength(2);
        // Since the first failure in the row.
        expect(f.status('acme-notes')!.since).toBe(since);

        handler = sdkPlugin('acme-notes').handler;
        await f.service.run();
        expect(f.notices.map((notice) => notice.title).at(-1)).toBe('Plugin backup working again: Acme Notes');
        expect(f.status('acme-notes')).toMatchObject({ state: 'ok' });
        expect(f.status('acme-notes')!.since).toBeUndefined();
        await f.service.run();
        expect(f.notices).toHaveLength(3);
    });

    it('calls a plugin out of date after two intervals without a good snapshot, through the backups’ check', async () => {
        const clock = { value: Date.UTC(2026, 10, 22, 9) };
        const f = fixture({ handlers: { 'acme-notes': sdkPlugin('acme-notes').handler }, now: clock });
        await f.service.run();
        clock.value += 49 * HOUR;
        expect(f.status('acme-notes')!.state).toBe('stale');
        await f.service.checkPlugins();
        expect(f.notices.map((notice) => notice.title)).toEqual(['Plugin backup out of date: Acme Notes']);
        await f.service.checkPlugins();
        expect(f.notices).toHaveLength(1);
    });

    it('derives each state from the record, failing over stale, disabled over both', () => {
        const now = Date.UTC(2026, 10, 22, 9);
        const context = { now, intervalHours: 24, disabled: new Set<string>(), running: new Set<string>() };
        const base = [statusOf('a'), statusOf('b'), statusOf('c'), statusOf('d'), statusOf('e', { declared: false })];
        const out = withSnapshots(
            base,
            {
                a: { lastSuccessAt: now - HOUR, sizeBytes: 10 },
                b: { lastSuccessAt: now - 49 * HOUR },
                c: { lastSuccessAt: now - 49 * HOUR, lastError: 'Nope.', lastErrorAt: now, failingSince: now - DAY },
                d: { lastError: 'Nope.', lastErrorAt: now },
                e: { lastSuccessAt: now },
            },
            { ...context, disabled: new Set(['d']), running: new Set(['a']) },
        );
        expect(out.map((status) => status.state)).toEqual(['ok', 'stale', 'failing', 'disabled', 'not_backed_up']);
        expect(out[0]).toMatchObject({ running: true, sizeBytes: 10 });
        expect(out[2]!.since).toBe(now - DAY);
        // With scheduled backups off, nothing goes stale.
        expect(
            withSnapshots([statusOf('b')], { b: { lastSuccessAt: 0 } }, { ...context, intervalHours: 0 })[0]!.state,
        ).toBe('ok');
    });

    it('treats a snapshot that fails its check as a failure, and a good one as clearing the streak', () => {
        const ok = {
            id: 'a',
            ok: true as const,
            snapshotId: 'X',
            bytes: 5,
            fetched: { chunks: 1, bytes: 5 },
            reused: 0,
        };
        const bad = recordAttempt({ failingSince: 10 }, ok, 100, { ok: false, error: 'Item 0 is missing or damaged.' });
        expect(bad).toMatchObject({
            lastError: 'The snapshot failed its check: Item 0 is missing or damaged.',
            failingSince: 10,
            lastCheck: { at: 100, ok: false },
        });
        expect(bad.lastSuccessAt).toBeUndefined();
        const good = recordAttempt(bad, ok, 200, { ok: true });
        expect(good).toMatchObject({ lastSuccessAt: 200, sizeBytes: 5, lastCheck: { at: 200, ok: true } });
        expect(good.lastError).toBeUndefined();
        expect(good.failingSince).toBeUndefined();
    });

    it('owes no notice for plugins without a declared backup: the gap notices cover them', () => {
        expect(observeSnapshotNotices([statusOf('a', { declared: false, state: 'not_backed_up' })], {}, 0)).toEqual([]);
    });
});

// ── Back up now and the plugin's request ─────────────────────────────────

describe('Back up now and socio.backup.request', () => {
    it('takes one now in the background, joins a second ask to it, and lists it in the history', async () => {
        const plugin = sdkPlugin('acme-notes');
        const f = fixture({ handlers: { 'acme-notes': plugin.handler } });
        const first = f.service.backUpPlugin('acme-notes', 'manual');
        expect(first).toMatchObject({ ok: true, coalesced: false });
        expect(f.status('acme-notes')!.running).toBe(true);
        const second = f.service.backUpPlugin('acme-notes', 'manual');
        expect(second).toMatchObject({ ok: true, coalesced: true });
        const attempt = await (first as { done: Promise<{ ok: boolean }> }).done;
        expect(attempt.ok).toBe(true);
        expect(f.status('acme-notes')).toMatchObject({ state: 'ok' });
        expect(f.status('acme-notes')!.running).toBeUndefined();
        expect(f.service.pluginHistory('acme-notes').map((entry) => entry.reason)).toEqual(['manual']);
        expect(f.service.backUpPlugin('acme-elsewhere', 'manual')).toMatchObject({ ok: false, status: 404 });
    });

    it('waits for a run in progress instead of overlapping it, and the run waits for it', async () => {
        const plugin = sdkPlugin('acme-notes');
        const f = fixture({ handlers: { 'acme-notes': plugin.handler } });
        const run = f.service.run();
        const manual = f.service.backUpPlugin('acme-notes', 'manual') as { done: Promise<{ ok: boolean }> };
        expect((await manual.done).ok).toBe(true);
        expect((await run)!.plugins!.taken).toBe(1);
        const reasons = f.service.pluginHistory('acme-notes').map((entry) => entry.reason);
        expect(reasons.sort()).toEqual(['manual', 'scheduled']);
    });

    it('takes a plugin’s request with its reason, at most one an hour and four a day', async () => {
        const plugin = sdkPlugin('acme-notes');
        const clock = { value: Date.UTC(2026, 10, 22, 9) };
        const f = fixture({ handlers: { 'acme-notes': plugin.handler }, now: clock });
        const asked = f.service.requestPluginBackup('acme-notes', 'Imported 1,200 notes');
        expect(asked).toEqual({ ok: true, coalesced: false });
        // Joined while it runs: not counted.
        expect(f.service.requestPluginBackup('acme-notes', 'Again')).toEqual({ ok: true, coalesced: true });
        await waitUntil(() => f.status('acme-notes')!.state === 'ok');
        expect(f.service.pluginHistory('acme-notes')).toEqual([
            expect.objectContaining({ reason: 'request', note: 'Imported 1,200 notes' }),
        ]);
        const refused = f.service.requestPluginBackup('acme-notes', 'Once more');
        expect(refused).toMatchObject({ ok: false, status: 429 });
        expect((refused as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(3000);
        expect((refused as { retryAfterSeconds: number }).retryAfterSeconds).toBeLessThanOrEqual(3600);
        expect(f.service.requestPluginBackup('acme-elsewhere', 'Hello')).toMatchObject({ ok: false, status: 404 });
    });

    it('counts requests over the last hour and the last day', () => {
        const now = 10 * DAY;
        expect(requestAllowed(undefined, now)).toEqual({ ok: true, requests: [now] });
        expect(requestAllowed({ requests: [now - 10 * 60_000] }, now)).toEqual({ ok: false, retryAfterSeconds: 3000 });
        const four = [now - 20 * HOUR, now - 10 * HOUR, now - 5 * HOUR, now - 2 * HOUR];
        expect(requestAllowed({ requests: four }, now)).toEqual({ ok: false, retryAfterSeconds: 4 * 3600 });
        // A day old no longer counts.
        expect(requestAllowed({ requests: [now - DAY, ...four.slice(1)] }, now)).toMatchObject({ ok: true });
    });
});

// ── Retention ────────────────────────────────────────────────────────────

describe('retention (the owner’s decision, 2026-11-23)', () => {
    it('keeps a plugin’s newest good snapshot past BACKUP_KEEP until a newer one succeeds', async () => {
        let handler: Handler = sdkPlugin('acme-notes').handler;
        const f = fixture({ handlers: { 'acme-notes': (r) => handler(r) }, keep: 1 });
        await f.service.run();
        const [first] = f
            .store()
            .records('acme-notes')
            .records.map((r) => r.record.snapshotId);
        handler = failsWith('Down for maintenance.');
        await f.service.run();
        await f.service.run();
        // Its run aged out of BACKUP_KEEP=1, and it stays.
        expect(
            f
                .store()
                .records('acme-notes')
                .records.map((r) => r.record.snapshotId),
        ).toEqual([first]);
        handler = sdkPlugin('acme-notes').handler;
        await f.service.run();
        const after = f
            .store()
            .records('acme-notes')
            .records.map((r) => r.record.snapshotId);
        expect(after).toHaveLength(1);
        expect(after[0]).not.toBe(first);
    });

    it('is one function: the newest record, unless it is an uninstall snapshot', () => {
        expect(retainedPastRules([])).toEqual(new Set());
        expect(
            retainedPastRules([
                { snapshotId: 'A', takenAt: 1, reason: 'scheduled' },
                { snapshotId: 'C', takenAt: 3, reason: 'manual' },
                { snapshotId: 'B', takenAt: 2, reason: 'scheduled' },
            ]),
        ).toEqual(new Set(['C']));
        // An uninstall snapshot keeps PURGE_BACKUP_DAYS, never longer.
        expect(
            retainedPastRules([
                { snapshotId: 'A', takenAt: 1, reason: 'scheduled' },
                { snapshotId: 'U', takenAt: 2, reason: 'uninstall' },
            ]),
        ).toEqual(new Set());
    });

    it('keeps nothing past the rules for a plugin no longer installed', async () => {
        const f = fixture({ handlers: { 'acme-notes': sdkPlugin('acme-notes').handler }, keep: 1 });
        await f.service.run();
        expect(f.store().records('acme-notes').records).toHaveLength(1);
        f.setTargets([]);
        await f.service.run();
        expect(f.store().records('acme-notes').records).toHaveLength(0);
    });
});

// ── Off-site ─────────────────────────────────────────────────────────────

describe('the off-site layout', () => {
    it('sends the run’s snapshots inside it before complete, chunks once under HMAC names, the rest beside', async () => {
        const plugin = sdkPlugin('acme-notes');
        const f = fixture({ handlers: { 'acme-notes': plugin.handler }, offsite: true });
        const result = await f.service.run();
        expect(result!.offsiteError).toBeUndefined();
        const stamp = result!.database.match(/company-brain-(.+)\.sqlite$/)![1]!;
        const { objects, puts } = f.offsite!;
        const [record] = f.store().records('acme-notes').records;
        const manifestKey = `acme/snapshots/${stamp}/plugins/acme-notes/${record!.record.snapshotId}.json.sealed`;
        expect(objects.has(manifestKey)).toBe(true);
        expect(puts.indexOf(manifestKey)).toBeLessThan(puts.indexOf(`acme/snapshots/${stamp}/complete`));
        // Sealed as stored: the same bytes as the local record.
        expect(objects.get(manifestKey)!.equals(readFileSync(f.store().recordFile('acme-notes', record!.entry)))).toBe(
            true,
        );

        const hashes = new Set(record!.record.manifest.items.flatMap((item) => item.chunks ?? [item.sha256]));
        const nameKey = pluginChunkNameKey(f.keys.current!);
        const chunkKeys = [...objects.keys()].filter((key) => key.startsWith('acme/plugin-chunks/acme-notes/'));
        expect(chunkKeys.sort()).toEqual(
            [...hashes].map((hash) => `acme/plugin-chunks/acme-notes/${pluginChunkName(nameKey, hash)}.sealed`).sort(),
        );
        // No bare hash names off-site.
        for (const hash of hashes) {
            expect([...objects.keys()].some((key) => key.includes(hash))).toBe(false);
        }
        expect(result!.offsite!.plugins).toMatchObject({ inRun: 1, chunks: hashes.size, chunksSent: hashes.size });

        // Back up now goes beside the runs, with the next copy; unchanged chunks aren't sent again.
        await (f.service.backUpPlugin('acme-notes', 'manual') as { done: Promise<unknown> }).done;
        const second = await f.service.run();
        expect(second!.offsite!.plugins!.chunksSent).toBe(0);
        const manual = f
            .store()
            .records('acme-notes')
            .records.find((r) => r.record.reason === 'manual')!;
        expect(
            objects.has(
                `acme/plugin-snapshots/acme-notes/${manual.record.stamp}-${manual.record.snapshotId}/snapshot.json.sealed`,
            ),
        ).toBe(true);
    });

    it('removes chunks no snapshot lists once every kept run is newer, and out-of-run ones the store dropped', async () => {
        const plugin = sdkPlugin('acme-notes');
        const f = fixture({ handlers: { 'acme-notes': plugin.handler }, offsite: true, keep: 1 });
        await f.service.run();
        const { objects } = f.offsite!;
        const firstChunks = [...objects.keys()].filter((key) => key.startsWith('acme/plugin-chunks/'));
        rmSync(join(plugin.volume, 'uploads'), { recursive: true });
        writeFileSync(join(plugin.volume, 'note-1.txt'), 'Ada rewrote this.');
        await f.service.run();
        await f.service.run();
        const after = [...objects.keys()].filter((key) => key.startsWith('acme/plugin-chunks/'));
        const removed = firstChunks.filter((key) => !after.includes(key));
        expect(removed.length).toBeGreaterThanOrEqual(2);
        // Only one run is kept off-site, and its snapshot's chunks are all there.
        const runs = new Set(
            [...objects.keys()].filter((key) => key.startsWith('acme/snapshots/')).map((key) => key.split('/')[2]),
        );
        expect(runs.size).toBe(1);
    });
});

// ── The composition's host and the setting ───────────────────────────────

describe('the composition’s host and the size setting', () => {
    it('lists only service plugins that declare backups and keep state, and calls through the ingress with the pin', async () => {
        const seen: { url: string; init: RequestInit }[] = [];
        const row = (id: string, patch: Record<string, unknown> = {}) =>
            ({
                id,
                version: '2.0.0',
                revision: 'rev-9',
                enabled: true,
                replicas: 1,
                mode: 'service',
                config: { region: 'west' },
                manifest: {
                    name: id,
                    service: {
                        image: 'x',
                        port: 8080,
                        volumes: [
                            { name: 'data', mount: '/data' },
                            { name: 'cache', mount: '/cache', ephemeral: true },
                        ],
                        backup: { protocol: 1, schema: 7 },
                    },
                },
                ...patch,
            }) as never;
        const host = pluginSnapshotHost(
            {
                list: () => [
                    row('acme-notes'),
                    row('acme-off', { enabled: false }),
                    row('acme-plain', { manifest: { name: 'Plain', service: { image: 'x', port: 1 } } }),
                    row('acme-bundled', { mode: 'bundled' }),
                ],
                hostTarget: async (_id: string, request: { method: string; target: string; task?: string }) => ({
                    state: 'running' as const,
                    host: '127.0.0.1',
                    port: 9999,
                    headers: { 'x-cb-runtime-task': request.task ?? '' },
                }),
                hostTasks: async () => ['t1'],
            } as never,
            (async (url: string, init: RequestInit) => {
                seen.push({ url, init });
                return new Response('{}', { status: 202 });
            }) as never,
        );
        expect(host.targets()).toEqual([
            {
                id: 'acme-notes',
                name: 'acme-notes',
                running: true,
                version: '2.0.0',
                revision: 'rev-9',
                schema: 7,
                volumes: ['data'],
                settings: { region: 'west' },
            },
            expect.objectContaining({ id: 'acme-off', running: false }),
        ]);
        await host.call('acme-notes', { method: 'POST', target: '/__cb/backup', task: 't1', body: '{}' });
        expect(seen[0]!.url).toBe('http://127.0.0.1:9999/__cb/backup');
        expect(seen[0]!.init.headers).toMatchObject({ 'x-cb-runtime-task': 't1', 'content-type': 'application/json' });
    });

    it('reads PLUGIN_BACKUP_MAX_GB in its range, and an admin’s value over it', () => {
        expect(pluginBackupLimitsFromEnv({})).toEqual({});
        expect(pluginBackupLimitsFromEnv({ PLUGIN_BACKUP_MAX_GB: '64' })).toEqual({ pluginBackupMaxGb: 64 });
        expect(() => pluginBackupLimitsFromEnv({ PLUGIN_BACKUP_MAX_GB: '0' })).toThrow(/PLUGIN_BACKUP_MAX_GB/);
        expect(pluginBackupMaxBytes({}, undefined)).toBe(20 * GIB);
        expect(pluginBackupMaxBytes({ pluginBackupMaxGb: 64 }, undefined)).toBe(64 * GIB);
        expect(pluginBackupMaxBytes({ pluginBackupMaxGb: 64 }, { pluginBackupMaxGb: 100 })).toBe(100 * GIB);
    });
});

async function waitUntil(check: () => boolean) {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('Timed out.');
}
