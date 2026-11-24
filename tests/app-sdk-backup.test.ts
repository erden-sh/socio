import { createHash, randomBytes } from 'node:crypto';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ENVELOPE_TTL_MS, newJti, requestTargetHash, signEnvelope } from '@socio/foundation/apps/envelope';
import type { PluginSnapshotManifest } from '@socio/shared/plugins/plugin-snapshot';

import { newSnapshotId } from '../packages/app-sdk/src/backup-check.js';
import { defaultBackupHandler, globMatcher, type BackupHandler } from '../packages/app-sdk/src/backup.js';
import { socioApp, type BackupServeOptions, type BackupServer } from '../packages/app-sdk/src/index.js';

// CB-458 step 4: the SDK's backup side. The default handler's standalone
// SQLite copies, the exclude list, custom handlers, the quiesce lease, restore
// mode with its commit-then-exit, and the hold on outward work. Negative cases
// first in each block.

const KEY = randomBytes(32);
const PLUGIN = 'acme-notes';
const NOW = 1_800_000_000_000;
const MiB = 1024 * 1024;
let clock = NOW;

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    clock = NOW;
});

const volume = () => {
    const dir = mkdtempSync(join(tmpdir(), 'acme-volume-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

const makeSocio = (env: Record<string, string | undefined> = {}, fetchImpl?: typeof fetch) =>
    socioApp({
        appId: `plugin:${PLUGIN}`,
        key: KEY.toString('base64url'),
        now: () => clock,
        env,
        apiUrl: 'http://socio.test/api',
        serviceToken: () => 'acme-identity',
        pluginProof: 'acme-proof',
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });

type Socio = ReturnType<typeof makeSocio>;

const serve = (socio: Socio, options: Partial<BackupServeOptions> & { volumes: Record<string, string> }) => {
    const served = socio.backup.serve({ schemaVersion: 3, pluginVersion: '1.4.0', exit: () => undefined, ...options });
    cleanup.push(() => served.close());
    return served;
};

const hostEnvelope = (method: string, target: string, aud = `plugin:${PLUGIN}`) =>
    signEnvelope(KEY, {
        aud,
        sub: 'host',
        acc: 'host',
        req: { m: method, p: requestTargetHash(target) },
        iat: clock,
        exp: clock + ENVELOPE_TTL_MS,
        jti: newJti(),
    });

const personEnvelope = (method: string, target: string) =>
    signEnvelope(KEY, {
        aud: `plugin:${PLUGIN}`,
        sub: 'ada-0000000000000001',
        acc: 'owner',
        sid: 'session-000000000001',
        req: { m: method, p: requestTargetHash(target) },
        iat: clock,
        exp: clock + ENVELOPE_TTL_MS,
        jti: newJti(),
        ver: null,
    });

type Handler = (request: Request) => Response | Promise<Response>;

const appOf = (socio: Socio, inner?: (request: Request) => Response | Promise<Response>) =>
    socio.fetchHandler((request) => (inner ? inner(request) : new Response('acme app')));

const send = (
    app: Handler,
    method: string,
    target: string,
    body?: BodyInit | Uint8Array,
    envelope: string | null = hostEnvelope(method, target),
): Promise<Response> =>
    Promise.resolve(
        app(
            new Request(`http://plugin.invalid${target}`, {
                method,
                headers: envelope ? { 'x-cb-actor': envelope } : {},
                ...(body === undefined ? {} : { body, duplex: 'half' }),
            } as RequestInit),
        ),
    );

const jsonOf = async (response: Response) => (await response.json()) as Record<string, unknown>;

const begin = (app: Handler, snapshotId: string, quiesce = false, reason = 'manual') =>
    send(app, 'POST', '/__cb/backup', JSON.stringify({ snapshotId, reason, quiesce }));

/** Begins a snapshot, waits for it, and answers its `GET`. */
const snapshot = async (app: Handler, served: BackupServer, snapshotId = newSnapshotId(clock), quiesce = false) => {
    const started = await begin(app, snapshotId, quiesce);
    expect(started.status).toBe(202);
    await served.settled();
    const answer = await jsonOf(await send(app, 'GET', `/__cb/backup/${snapshotId}`));
    return { snapshotId, answer, manifest: answer.manifest as PluginSnapshotManifest };
};

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytesOf = async (response: Response) => Buffer.from(await response.arrayBuffer());

/** A WAL-mode SQLite database with `count` notes, its connection left open. */
const notesDb = (path: string, count = 3) => {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)');
    for (let i = 0; i < count; i += 1) {
        db.prepare('INSERT INTO notes(body) VALUES (?)').run(`note ${i}`);
    }
    cleanup.push(() => db.close());
    return db;
};

const countNotes = (path: string) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        return (db.prepare('SELECT count(*) AS n FROM notes').get() as { n: number }).n;
    } finally {
        db.close();
    }
};

describe('serve: setup', () => {
    it('refuses a mini app, no volumes, a relative mount, a bad schema and a second call', () => {
        const app = socioApp({ appId: 'tracker', key: KEY.toString('base64url'), env: {} });
        expect(() => app.backup.serve({ volumes: { data: '/data' }, schemaVersion: 1 })).toThrow(/service plugins/);
        const socio = makeSocio();
        expect(() => socio.backup.serve({ volumes: {}, schemaVersion: 1 })).toThrow(/at least one volume/);
        expect(() => socio.backup.serve({ volumes: { data: 'data' }, schemaVersion: 1 })).toThrow(/absolute/);
        expect(() => socio.backup.serve({ volumes: { data: '/data' }, schemaVersion: -1 })).toThrow(/whole number/);
        serve(socio, { volumes: { data: volume() } });
        expect(() => socio.backup.serve({ volumes: { data: '/data' }, schemaVersion: 1 })).toThrow(/already/);
    });

    it('refuses a CB_RESTORE_SNAPSHOT that is not a snapshot id', () => {
        const socio = makeSocio({ CB_RESTORE_SNAPSHOT: '../../etc' });
        expect(() => socio.backup.serve({ volumes: { data: volume() }, schemaVersion: 1 })).toThrow(
            /not a snapshot id/,
        );
    });
});

describe('the host envelope guards the backup routes', () => {
    it('answers 401 to no envelope, a person, another plugin and a replay; the host gets through', async () => {
        const socio = makeSocio();
        serve(socio, { volumes: { data: volume() } });
        const app = appOf(socio);
        const body = () => JSON.stringify({ snapshotId: newSnapshotId(), reason: 'manual', quiesce: false });
        expect((await send(app, 'POST', '/__cb/backup', body(), null)).status).toBe(401);
        expect((await send(app, 'POST', '/__cb/backup', body(), personEnvelope('POST', '/__cb/backup'))).status).toBe(
            401,
        );
        expect(
            (await send(app, 'POST', '/__cb/backup', body(), hostEnvelope('POST', '/__cb/backup', 'plugin:acme-other')))
                .status,
        ).toBe(401);
        const target = `/__cb/backup/${newSnapshotId()}`;
        const envelope = hostEnvelope('GET', target);
        expect((await send(app, 'GET', target, undefined, envelope)).status).toBe(404);
        expect((await send(app, 'GET', target, undefined, envelope)).status).toBe(401);
        expect((await send(app, 'POST', '/__cb/backup', body())).status).toBe(202);
    });

    it('verifies raw requests in handle, and leaves other paths to the app', async () => {
        const socio = makeSocio();
        const served = serve(socio, { volumes: { data: volume() } });
        const request = (envelope?: string) =>
            new Request('http://plugin.invalid/__cb/backup', {
                method: 'POST',
                headers: envelope ? { 'x-cb-actor': envelope } : {},
                body: JSON.stringify({ snapshotId: newSnapshotId(), reason: 'manual', quiesce: false }),
            });
        expect((await served.handle(request()))?.status).toBe(401);
        expect((await served.handle(request(personEnvelope('POST', '/__cb/backup'))))?.status).toBe(401);
        expect((await served.handle(request(hostEnvelope('POST', '/__cb/backup'))))?.status).toBe(202);
        expect(await served.handle(new Request('http://plugin.invalid/notes'))).toBeUndefined();
    });
});

describe('begin', () => {
    it('refuses a bad id, a bad reason, a non-boolean quiesce and a quiesced begin with no hold', async () => {
        const socio = makeSocio();
        serve(socio, { volumes: { data: volume() } });
        const app = appOf(socio);
        const post = (body: unknown) => send(app, 'POST', '/__cb/backup', JSON.stringify(body));
        expect((await post({ snapshotId: 'acme-1', reason: 'manual', quiesce: false })).status).toBe(400);
        expect((await post({ snapshotId: newSnapshotId(), reason: 'whim', quiesce: false })).status).toBe(400);
        expect((await post({ snapshotId: newSnapshotId(), reason: 'manual', quiesce: 'yes' })).status).toBe(400);
        const held = await post({ snapshotId: newSnapshotId(), reason: 'pre-update', quiesce: true });
        expect(held.status).toBe(409);
        expect((await jsonOf(held)).error).toBe('not_held');
        expect((await send(app, 'POST', '/__cb/backup', 'not json')).status).toBe(400);
    });

    it('answers a repeated begin again, refuses the same id with other parameters, and caps open snapshots', async () => {
        const socio = makeSocio();
        serve(socio, { volumes: { data: volume() } });
        const app = appOf(socio);
        const id = newSnapshotId();
        expect((await begin(app, id)).status).toBe(202);
        expect((await begin(app, id)).status).toBe(202);
        expect((await begin(app, id, false, 'scheduled')).status).toBe(409);
        for (let i = 0; i < 3; i += 1) {
            expect((await begin(app, newSnapshotId())).status).toBe(202);
        }
        expect((await begin(app, newSnapshotId())).status).toBe(429);
    });
});

describe('the default handler', () => {
    it('lists every file, skips symlinks, the SDK’s entries, the exclude list and secrets unless included', async () => {
        const data = volume();
        mkdirSync(join(data, 'uploads/2026'), { recursive: true });
        mkdirSync(join(data, 'cache'), { recursive: true });
        writeFileSync(join(data, 'uploads/2026/a.png'), 'acme image');
        chmodSync(join(data, 'uploads/2026/a.png'), 0o640);
        writeFileSync(join(data, 'cache/tmp.bin'), 'cached');
        writeFileSync(join(data, 'notes.tmp'), 'scratch');
        writeFileSync(join(data, 'server.key'), 'secret');
        writeFileSync(join(data, 'cert.pem'), 'secret');
        writeFileSync(join(data, '.env'), 'ACME_TOKEN=secret');
        writeFileSync(join(data, 'config.json'), '{}');
        writeFileSync(join(data, '.socio-quiesce-old'), 'x');
        mkdirSync(join(data, 'nested'), { recursive: true });
        writeFileSync(join(data, 'nested/.socio-kept'), 'only the root is reserved');
        symlinkSync('/etc/hostname', join(data, 'link'));
        const socio = makeSocio();
        const served = serve(socio, { volumes: { data }, exclude: ['cache/', '*.tmp'], include: ['cert.pem'] });
        const app = appOf(socio);
        const { answer, manifest } = await snapshot(app, served);
        expect(answer.state).toBe('ready');
        expect(manifest.items.map((item) => item.path)).toEqual([
            'cert.pem',
            'config.json',
            'nested/.socio-kept',
            'uploads/2026/a.png',
        ]);
        const image = manifest.items.find((item) => item.path === 'uploads/2026/a.png')!;
        expect(image).toMatchObject({
            volume: 'data',
            kind: 'file',
            size: 10,
            sha256: sha(Buffer.from('acme image')),
            mode: 0o640,
        });
        expect(image.chunks).toBeUndefined();
        expect(manifest).toMatchObject({ protocol: 1, pluginVersion: '1.4.0', schemaVersion: 3, createdAt: clock });
    });

    it('copies a WAL database standalone, with no -wal, -shm or -journal beside it', async () => {
        const data = volume();
        const db = notesDb(join(data, 'app.sqlite'));
        writeFileSync(join(data, 'app.sqlite-journal'), '');
        expect(existsSync(join(data, 'app.sqlite-wal'))).toBe(true);
        const socio = makeSocio();
        const served = serve(socio, { volumes: { data } });
        const app = appOf(socio);
        const { snapshotId, manifest } = await snapshot(app, served);
        db.prepare('INSERT INTO notes(body) VALUES (?)').run('after the snapshot');
        expect(manifest.items.map((item) => item.path)).toEqual(['app.sqlite']);
        const [item] = manifest.items;
        expect(item).toMatchObject({ kind: 'database', journalMode: 'wal' });
        expect(item.chunks).toEqual([item.sha256]);
        const bytes = await bytesOf(await send(app, 'GET', `/__cb/backup/${snapshotId}/items/0`));
        expect(sha(bytes)).toBe(item.sha256);
        // The copy is standalone: rollback journal mode in its header, every row in the file.
        expect(bytes[18]).toBe(1);
        const scratch = volume();
        writeFileSync(join(scratch, 'copy.sqlite'), bytes);
        expect(countNotes(join(scratch, 'copy.sqlite'))).toBe(3);
    });

    it('takes a *.db that is not SQLite as a file, and a database over 4 MiB in chunks', async () => {
        const data = volume();
        writeFileSync(join(data, 'plain.db'), 'not a database at all');
        const db = new DatabaseSync(join(data, 'big.sqlite'));
        db.exec('CREATE TABLE blobs(b BLOB)');
        db.prepare('INSERT INTO blobs VALUES (?)').run(randomBytes(5 * MiB));
        db.close();
        const socio = makeSocio();
        const served = serve(socio, { volumes: { data } });
        const app = appOf(socio);
        const { snapshotId, manifest } = await snapshot(app, served);
        const big = manifest.items.findIndex((item) => item.path === 'big.sqlite');
        const plain = manifest.items.find((item) => item.path === 'plain.db')!;
        expect(plain.kind).toBe('file');
        const item = manifest.items[big];
        expect(item.kind).toBe('database');
        expect(item.journalMode).toBe('delete');
        expect(item.chunks).toHaveLength(Math.ceil(item.size / (4 * MiB)));
        const parts: Buffer[] = [];
        for (const [n, hash] of item.chunks!.entries()) {
            const chunk = await bytesOf(await send(app, 'GET', `/__cb/backup/${snapshotId}/items/${big}?chunk=${n}`));
            expect(sha(chunk)).toBe(hash);
            parts.push(chunk);
        }
        expect(parts[0]).toHaveLength(4 * MiB);
        expect(sha(Buffer.concat(parts))).toBe(item.sha256);
        expect(
            (await send(app, 'GET', `/__cb/backup/${snapshotId}/items/${big}?chunk=${item.chunks!.length}`)).status,
        ).toBe(404);
        const plainIndex = manifest.items.indexOf(plain);
        expect((await send(app, 'GET', `/__cb/backup/${snapshotId}/items/${plainIndex}?chunk=0`)).status).toBe(404);
        expect((await send(app, 'GET', `/__cb/backup/${snapshotId}/items/${manifest.items.length}`)).status).toBe(404);
        expect((await send(app, 'GET', `/__cb/backup/${snapshotId}/items/01`)).status).toBe(404);
    });

    it('fails a snapshot when the volume lacks the space to copy its files, naming no path', async () => {
        const data = volume();
        notesDb(join(data, 'app.sqlite'));
        const statfs = vi.fn(async () => ({ bavail: 1, bsize: 4096 }));
        const socio = makeSocio();
        const served = serve(socio, { volumes: { data }, handler: defaultBackupHandler({ data }, {}, { statfs }) });
        const { answer } = await snapshot(appOf(socio), served);
        expect(statfs).toHaveBeenCalledWith(data);
        expect(answer.state).toBe('failed');
        expect(answer.error).toBe("There isn't enough free space on volume data to copy its files.");
    });

    it('drops its work directory on DELETE, and a snapshot is gone after it', async () => {
        const data = volume();
        writeFileSync(join(data, 'a.txt'), 'acme');
        const socio = makeSocio();
        const served = serve(socio, { volumes: { data } });
        const app = appOf(socio);
        const { snapshotId } = await snapshot(app, served);
        expect(existsSync(join(data, '.socio-snapshots', snapshotId))).toBe(true);
        expect((await send(app, 'DELETE', `/__cb/backup/${snapshotId}`)).status).toBe(200);
        expect(existsSync(join(data, '.socio-snapshots', snapshotId))).toBe(false);
        expect((await send(app, 'GET', `/__cb/backup/${snapshotId}`)).status).toBe(404);
        expect((await send(app, 'DELETE', `/__cb/backup/${snapshotId}`)).status).toBe(404);
    });

    it('sweeps work directories a stopped task left over an hour ago, and keeps newer ones', async () => {
        const data = volume();
        const old = join(data, '.socio-snapshots', newSnapshotId());
        const recent = join(data, '.socio-snapshots', newSnapshotId());
        mkdirSync(old, { recursive: true });
        mkdirSync(recent, { recursive: true });
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
        utimesSync(old, twoHoursAgo, twoHoursAgo);
        const served = serve(makeSocio(), { volumes: { data } });
        await served.settled();
        expect(existsSync(old)).toBe(false);
        expect(existsSync(recent)).toBe(true);
    });

    it('keeps a snapshot another task still serves when a second task starts on the shared volume', async () => {
        const shared = volume();
        writeFileSync(join(shared, 'a.txt'), 'acme');
        const first = makeSocio();
        const served = serve(first, { volumes: { data: shared } });
        const app = appOf(first);
        const { snapshotId, manifest } = await snapshot(app, served);
        const dir = join(shared, '.socio-snapshots', snapshotId);
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
        utimesSync(dir, twoHoursAgo, twoHoursAgo);
        // A minute on, the host's request renews the lease on the volume too.
        const later = Date.now() + 61_000;
        vi.spyOn(Date, 'now').mockReturnValue(later);
        expect((await send(app, 'GET', `/__cb/backup/${snapshotId}`)).status).toBe(200);
        await vi.waitFor(() => expect(statSync(dir).mtimeMs).toBeGreaterThan(later - 60_000));
        const late = serve(makeSocio(), { volumes: { data: shared } });
        await late.settled();
        const item = await send(app, 'GET', `/__cb/backup/${snapshotId}/items/0`);
        expect(item.status).toBe(200);
        expect(sha(await bytesOf(item))).toBe(manifest.items[0].sha256);
    });

    it('serves a file as listed even if it is written in place after the manifest', async () => {
        const data = volume();
        writeFileSync(join(data, 'state.json'), '{"notes":1}');
        const socio = makeSocio();
        const served = serve(socio, { volumes: { data } });
        const app = appOf(socio);
        const { snapshotId, manifest } = await snapshot(app, served);
        // Same inode, new bytes.
        writeFileSync(join(data, 'state.json'), '{"notes":2}');
        const bytes = await bytesOf(await send(app, 'GET', `/__cb/backup/${snapshotId}/items/0`));
        expect(bytes.toString()).toBe('{"notes":1}');
        expect(sha(bytes)).toBe(manifest.items[0].sha256);
    });

    it('serves a file as listed even if it is replaced after the manifest', async () => {
        const data = volume();
        writeFileSync(join(data, 'a.txt'), 'first');
        const socio = makeSocio();
        const served = serve(socio, { volumes: { data } });
        const app = appOf(socio);
        const { snapshotId, manifest } = await snapshot(app, served);
        rmSync(join(data, 'a.txt'));
        writeFileSync(join(data, 'a.txt'), 'second, longer');
        const bytes = await bytesOf(await send(app, 'GET', `/__cb/backup/${snapshotId}/items/0`));
        expect(sha(bytes)).toBe(manifest.items[0].sha256);
    });
});

describe('globMatcher', () => {
    it('matches names at any depth, anchored paths from the root, and directories with their contents', () => {
        expect(globMatcher('*.key')('a/b/server.key')).toBe(true);
        expect(globMatcher('*.key')('server.keys')).toBe(false);
        expect(globMatcher('cache/')('cache/x/y')).toBe(true);
        expect(globMatcher('logs/*.txt')('logs/a.txt')).toBe(true);
        expect(globMatcher('logs/*.txt')('x/logs/a.txt')).toBe(false);
        expect(globMatcher('a/**/z')('a/b/c/z')).toBe(true);
        expect(globMatcher('a/**/z')('a/z')).toBe(true);
        expect(globMatcher('n?te')('note')).toBe(true);
        expect(globMatcher('a.b')('axb')).toBe(false);
    });
});

describe('a custom handler', () => {
    const custom = (over: Partial<BackupHandler> = {}) => {
        const calls: unknown[] = [];
        const bytes = Buffer.from('acme export');
        const handler: BackupHandler = {
            begin: (reason, context) => {
                calls.push(['begin', reason, context]);
                return { items: [{ volume: 'data', path: 'export.bin', kind: 'file' }], stats: { notes: 7 } };
            },
            openItem: (snapshotId, path, vol) => {
                calls.push(['openItem', snapshotId, path, vol]);
                return (async function* () {
                    yield bytes.subarray(0, 4);
                    yield bytes.subarray(4);
                })();
            },
            end: (snapshotId) => {
                calls.push(['end', snapshotId]);
            },
            ...over,
        };
        return { handler, calls, bytes };
    };

    it('gets begin(reason, { snapshotId, quiesce }), openItem by path and volume, and end on DELETE', async () => {
        const { handler, calls, bytes } = custom();
        const socio = makeSocio();
        const served = serve(socio, { volumes: { data: volume() }, handler });
        const app = appOf(socio);
        const { snapshotId, manifest } = await snapshot(app, served);
        expect(calls[0]).toEqual(['begin', 'manual', { snapshotId, quiesce: false }]);
        expect(calls[1]).toEqual(['openItem', snapshotId, 'export.bin', 'data']);
        expect(manifest.items[0]).toMatchObject({ size: bytes.length, sha256: sha(bytes) });
        expect(manifest.stats).toEqual({ notes: 7 });
        expect(sha(await bytesOf(await send(app, 'GET', `/__cb/backup/${snapshotId}/items/0`)))).toBe(sha(bytes));
        await send(app, 'DELETE', `/__cb/backup/${snapshotId}`);
        expect(calls.at(-1)).toEqual(['end', snapshotId]);
    });

    it('fails a snapshot whose handler lies about a size or hash, or lists what the host refuses', async () => {
        for (const items of [
            [{ volume: 'data', path: 'export.bin', kind: 'file' as const, size: 1 }],
            [{ volume: 'data', path: 'export.bin', kind: 'file' as const, sha256: 'f'.repeat(64) }],
            [{ volume: 'data', path: '../export.bin', kind: 'file' as const }],
            [{ volume: 'other', path: 'export.bin', kind: 'file' as const }],
            [
                { volume: 'data', path: 'app.sqlite', kind: 'database' as const },
                { volume: 'data', path: 'app.sqlite-wal', kind: 'file' as const },
            ],
        ]) {
            const { handler } = custom({ begin: () => ({ items }) });
            const socio = makeSocio();
            const served = serve(socio, { volumes: { data: volume() }, handler });
            const { answer } = await snapshot(appOf(socio), served);
            expect(answer.state).toBe('failed');
            expect(typeof answer.error).toBe('string');
        }
    });

    it('fails with an error that names no path, and ends a snapshot deleted while preparing once it settles', async () => {
        let release = () => undefined as void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { handler, calls } = custom({
            begin: async () => {
                await gate;
                throw Object.assign(new Error("ENOENT: no such file, open '/data/people/ada.json'"), {
                    code: 'ENOENT',
                });
            },
        });
        const socio = makeSocio();
        const served = serve(socio, { volumes: { data: volume() }, handler });
        const app = appOf(socio);
        const id = newSnapshotId();
        await begin(app, id);
        expect((await jsonOf(await send(app, 'GET', `/__cb/backup/${id}`))).state).toBe('preparing');
        const second = newSnapshotId();
        await begin(app, second);
        expect((await send(app, 'DELETE', `/__cb/backup/${id}`)).status).toBe(200);
        expect(calls.filter((call) => (call as unknown[])[0] === 'end')).toEqual([]);
        release();
        await served.settled();
        await vi.waitFor(() => expect(calls).toContainEqual(['end', id]));
        const failed = await jsonOf(await send(app, 'GET', `/__cb/backup/${second}`));
        expect(failed).toEqual({ state: 'failed', error: 'The snapshot failed reading the volume (ENOENT).' });
    });

    it('slices a chunk out of the whole stream', async () => {
        const big = randomBytes(9 * MiB);
        const { handler } = custom({
            begin: () => ({ items: [{ volume: 'data', path: 'big.bin', kind: 'database' }] }),
            openItem: () =>
                (async function* () {
                    for (let at = 0; at < big.length; at += 1_000_000) {
                        yield big.subarray(at, at + 1_000_000);
                    }
                })(),
        });
        const socio = makeSocio();
        const served = serve(socio, { volumes: { data: volume() }, handler });
        const app = appOf(socio);
        const { snapshotId, manifest } = await snapshot(app, served);
        expect(manifest.items[0].chunks).toHaveLength(3);
        const last = await bytesOf(await send(app, 'GET', `/__cb/backup/${snapshotId}/items/0?chunk=2`));
        expect(last).toEqual(big.subarray(8 * MiB));
        expect(sha(last)).toBe(manifest.items[0].chunks![2]);
    });
});

describe('the snapshot lease', () => {
    it('drops a snapshot an hour after its last request, and each request renews it', async () => {
        const data = volume();
        writeFileSync(join(data, 'a.txt'), 'acme');
        const socio = makeSocio();
        const served = serve(socio, { volumes: { data } });
        const app = appOf(socio);
        const { snapshotId } = await snapshot(app, served);
        clock += 59 * 60_000;
        await send(app, 'GET', `/__cb/backup/${snapshotId}`);
        clock += 59 * 60_000;
        await served.sweep();
        expect((await send(app, 'GET', `/__cb/backup/${snapshotId}`)).status).toBe(200);
        clock += 60 * 60_000;
        await served.sweep();
        expect((await send(app, 'GET', `/__cb/backup/${snapshotId}`)).status).toBe(404);
        expect(existsSync(join(data, '.socio-snapshots', snapshotId))).toBe(false);
    });
});

describe('quiesce', () => {
    const writeApp = (socio: Socio, onWrite?: () => Promise<void>) =>
        appOf(socio, async (request) => {
            if (request.method !== 'GET') {
                await onWrite?.();
            }
            return new Response('written');
        });
    const write = (app: Handler) => send(app, 'POST', '/notes', '{}', personEnvelope('POST', '/notes'));
    const read = (app: Handler) => send(app, 'GET', '/notes', undefined, personEnvelope('GET', '/notes'));

    it('holds writes with 503 and Retry-After, through the snapshot’s DELETE, until the hold’s own DELETE', async () => {
        const data = volume();
        writeFileSync(join(data, 'a.txt'), 'acme');
        const hooks = { hold: vi.fn(), resume: vi.fn() };
        const socio = makeSocio();
        const served = serve(socio, { volumes: { data }, quiesce: hooks });
        const app = writeApp(socio);
        const id = newSnapshotId();
        expect((await write(app)).status).toBe(200);
        const hold = await send(app, 'POST', '/__cb/backup/quiesce', JSON.stringify({ snapshotId: id }));
        expect(hold.status).toBe(200);
        expect(hooks.hold).toHaveBeenCalledWith(id);
        const refused = await write(app);
        expect(refused.status).toBe(503);
        expect(refused.headers.get('retry-after')).toBe('5');
        expect((await read(app)).status).toBe(200);
        expect(socio.backup.quiesced()).toBe(true);
        const { answer } = await snapshot(app, served, id, true);
        expect(answer.state).toBe('ready');
        await send(app, 'DELETE', `/__cb/backup/${id}`);
        expect((await write(app)).status).toBe(503);
        expect(hooks.resume).not.toHaveBeenCalled();
        expect((await send(app, 'DELETE', `/__cb/backup/quiesce/${id}`)).status).toBe(200);
        expect(hooks.resume).toHaveBeenCalledWith(id);
        expect((await write(app)).status).toBe(200);
        expect(existsSync(join(data, '.socio-quiesce'))).toBe(false);
        expect((await send(app, 'DELETE', `/__cb/backup/quiesce/${id}`)).status).toBe(404);
    });

    it('ends a hold 10 minutes after its last renewal', async () => {
        const socio = makeSocio();
        const served = serve(socio, { volumes: { data: volume() } });
        const app = writeApp(socio);
        const id = newSnapshotId();
        await send(app, 'POST', '/__cb/backup/quiesce', JSON.stringify({ snapshotId: id }));
        clock += 9 * 60_000;
        await send(app, 'POST', '/__cb/backup/quiesce', JSON.stringify({ snapshotId: id }));
        clock += 9 * 60_000;
        await served.sweep();
        expect((await write(app)).status).toBe(503);
        clock += 2 * 60_000;
        await served.sweep();
        expect((await write(app)).status).toBe(200);
    });

    it('waits for a write in flight before it answers that writes are held', async () => {
        let finish = () => undefined as void;
        const inFlight = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const socio = makeSocio();
        serve(socio, { volumes: { data: volume() } });
        const app = writeApp(socio, () => inFlight);
        const writing = write(app);
        let held = false;
        const hold = send(app, 'POST', '/__cb/backup/quiesce', JSON.stringify({ snapshotId: newSnapshotId() })).then(
            (answer) => {
                held = true;
                return answer;
            },
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(held).toBe(false);
        expect((await write(app)).status).toBe(503);
        finish();
        expect((await writing).status).toBe(200);
        expect((await hold).status).toBe(200);
    });

    it('holds a task that starts mid-snapshot through the marker on the shared volume', async () => {
        const shared = volume();
        const first = makeSocio();
        serve(first, { volumes: { data: shared } });
        const id = newSnapshotId();
        await send(appOf(first), 'POST', '/__cb/backup/quiesce', JSON.stringify({ snapshotId: id }));
        const marker = JSON.parse(readFileSync(join(shared, '.socio-quiesce'), 'utf8')) as Record<string, unknown>;
        expect(marker).toEqual({ snapshotId: id, until: clock + 10 * 60_000 });
        const second = makeSocio();
        serve(second, { volumes: { data: shared } });
        const late = writeApp(second);
        expect((await write(late)).status).toBe(503);
        // Begin needs this task's own hold: the marker only holds writes.
        expect((await begin(late, id, true)).status).toBe(409);
        await send(appOf(first), 'DELETE', `/__cb/backup/quiesce/${id}`);
        clock += 2000;
        expect((await write(late)).status).toBe(200);
    });

    it('answers a retried quiesce only once writes in flight drained, and begin waits for that too', async () => {
        let finish = () => undefined as void;
        const inFlight = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const socio = makeSocio();
        const served = serve(socio, { volumes: { data: volume() } });
        const app = writeApp(socio, () => inFlight);
        const writing = write(app);
        const id = newSnapshotId();
        const answered: string[] = [];
        const first = send(app, 'POST', '/__cb/backup/quiesce', JSON.stringify({ snapshotId: id })).then((answer) => {
            answered.push('first');
            return answer;
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        const retry = send(app, 'POST', '/__cb/backup/quiesce', JSON.stringify({ snapshotId: id })).then((answer) => {
            answered.push('retry');
            return answer;
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(answered).toEqual([]);
        expect((await begin(app, id, true)).status).toBe(409);
        finish();
        expect((await writing).status).toBe(200);
        expect((await first).status).toBe(200);
        expect((await retry).status).toBe(200);
        const { answer } = await snapshot(app, served, id, true);
        expect(answer.state).toBe('ready');
    });

    it('runs the hold hook on a task that starts during another task’s hold, and resume when it ends', async () => {
        const shared = volume();
        const first = makeSocio();
        serve(first, { volumes: { data: shared } });
        const id = newSnapshotId();
        await send(appOf(first), 'POST', '/__cb/backup/quiesce', JSON.stringify({ snapshotId: id }));
        const hooks = { hold: vi.fn(), resume: vi.fn() };
        const second = makeSocio();
        const late = serve(second, { volumes: { data: shared }, quiesce: hooks });
        expect(hooks.hold).toHaveBeenCalledExactlyOnceWith(id);
        expect(second.backup.quiesced()).toBe(true);
        expect(hooks.hold).toHaveBeenCalledTimes(1);
        // The host's own quiesce on this task reuses the hook it already ran.
        expect(
            (await send(appOf(second), 'POST', '/__cb/backup/quiesce', JSON.stringify({ snapshotId: id }))).status,
        ).toBe(200);
        expect(hooks.hold).toHaveBeenCalledTimes(1);
        await send(appOf(second), 'DELETE', `/__cb/backup/quiesce/${id}`);
        expect(hooks.resume).toHaveBeenCalledExactlyOnceWith(id);
        // A hold only inherited resumes when its marker goes.
        const other = newSnapshotId();
        await send(appOf(first), 'POST', '/__cb/backup/quiesce', JSON.stringify({ snapshotId: other }));
        clock += 2000;
        await late.sweep();
        expect(hooks.hold).toHaveBeenLastCalledWith(other);
        await send(appOf(first), 'DELETE', `/__cb/backup/quiesce/${other}`);
        clock += 2000;
        await late.sweep();
        expect(hooks.resume).toHaveBeenLastCalledWith(other);
        expect(hooks.resume).toHaveBeenCalledTimes(2);
    });

    it('waits for an inherited hold hook before the host’s quiesce answers, and fails with it', async () => {
        const shared = volume();
        const first = makeSocio();
        serve(first, { volumes: { data: shared } });
        const id = newSnapshotId();
        await send(appOf(first), 'POST', '/__cb/backup/quiesce', JSON.stringify({ snapshotId: id }));
        let paused = () => undefined as void;
        const pausing = new Promise<void>((resolve) => {
            paused = resolve;
        });
        const second = makeSocio();
        serve(second, { volumes: { data: shared }, quiesce: { hold: () => pausing } });
        let answered = false;
        const hold = send(appOf(second), 'POST', '/__cb/backup/quiesce', JSON.stringify({ snapshotId: id })).then(
            (answer) => {
                answered = true;
                return answer;
            },
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(answered).toBe(false);
        paused();
        expect((await hold).status).toBe(200);

        const third = makeSocio();
        serve(third, {
            volumes: { data: shared },
            quiesce: {
                hold: async () => {
                    throw new Error('acme jobs would not pause');
                },
            },
        });
        const refused = await send(appOf(third), 'POST', '/__cb/backup/quiesce', JSON.stringify({ snapshotId: id }));
        expect(refused.status).toBe(503);
        expect((await jsonOf(refused)).error).toBe('hold_failed');
    });

    it('takes the plugin’s own idea of which routes write', async () => {
        const socio = makeSocio();
        serve(socio, { volumes: { data: volume() }, writing: ({ path }) => path.startsWith('/sync') });
        const app = writeApp(socio);
        await send(app, 'POST', '/__cb/backup/quiesce', JSON.stringify({ snapshotId: newSnapshotId() }));
        expect((await write(app)).status).toBe(200);
        expect((await send(app, 'GET', '/sync/run', undefined, personEnvelope('GET', '/sync/run'))).status).toBe(503);
    });

    it('drops the hold when the plugin’s hold hook throws', async () => {
        const socio = makeSocio();
        serve(socio, {
            volumes: { data: volume() },
            quiesce: {
                hold: () => {
                    throw new Error('acme jobs would not pause');
                },
            },
        });
        const app = writeApp(socio);
        const answer = await send(app, 'POST', '/__cb/backup/quiesce', JSON.stringify({ snapshotId: newSnapshotId() }));
        expect(answer.status).toBe(503);
        expect((await write(app)).status).toBe(200);
    });
});

describe('verify', () => {
    it('answers ok with the schema and the plugin’s counts, and not ok for a damaged database', async () => {
        const data = volume();
        notesDb(join(data, 'app.sqlite'));
        const socio = makeSocio();
        serve(socio, { volumes: { data }, stats: () => ({ notes: 3 }) });
        const app = appOf(socio);
        const answer = await send(app, 'POST', '/__cb/backup/verify', '{}');
        expect(await jsonOf(answer)).toEqual({ ok: true, schemaVersion: 3, stats: { notes: 3 } });
        const damaged = volume();
        const header = Buffer.alloc(4096);
        Buffer.from('SQLite format 3\u0000', 'latin1').copy(header);
        writeFileSync(join(damaged, 'bad.sqlite'), header);
        const other = makeSocio();
        serve(other, { volumes: { data: damaged } });
        expect((await jsonOf(await send(appOf(other), 'POST', '/__cb/backup/verify', '{}'))).ok).toBe(false);
    });
});

describe('restore', () => {
    /** A snapshot of `data` from a running task, and the bytes of each item. */
    const takeFrom = async (data: string) => {
        const socio = makeSocio();
        const served = serve(socio, { volumes: { data } });
        const app = appOf(socio);
        const { snapshotId, manifest } = await snapshot(app, served);
        const bytes: Buffer[] = [];
        for (const index of manifest.items.keys()) {
            bytes.push(await bytesOf(await send(app, 'GET', `/__cb/backup/${snapshotId}/items/${index}`)));
        }
        return { snapshotId, manifest, bytes };
    };

    const restoring = (snapshotId: string, data = volume(), env: Record<string, string> = {}) => {
        const exit = vi.fn();
        const socio = makeSocio({ CB_RESTORE_SNAPSHOT: snapshotId, CB_RESTORE_HOLD: snapshotId, ...env });
        const served = serve(socio, { volumes: { data }, exit });
        return { socio, served, exit, data, app: appOf(socio) };
    };

    it('answers 409 on the restore routes outside restore mode, and 503 on the backup routes in it', async () => {
        const socio = makeSocio();
        serve(socio, { volumes: { data: volume() } });
        const id = newSnapshotId();
        expect((await send(appOf(socio), 'POST', `/__cb/restore/${id}`, '{}')).status).toBe(409);
        const target = restoring(id);
        expect(target.served.restoreMode).toBe(true);
        expect((await begin(target.app, newSnapshotId())).status).toBe(503);
        expect((await send(target.app, 'GET', '/notes', undefined, personEnvelope('GET', '/notes'))).status).toBe(503);
        expect(
            (await send(target.app, 'POST', `/__cb/restore/${id}`, '{}', personEnvelope('POST', `/__cb/restore/${id}`)))
                .status,
        ).toBe(401);
    });

    it('refuses another snapshot, items before the manifest, a bad manifest and a second different one', async () => {
        const source = volume();
        notesDb(join(source, 'app.sqlite'));
        const { snapshotId, manifest } = await takeFrom(source);
        const { app } = restoring(snapshotId);
        const base = `/__cb/restore/${snapshotId}`;
        expect((await send(app, 'POST', `/__cb/restore/${newSnapshotId()}`, JSON.stringify(manifest))).status).toBe(
            409,
        );
        expect((await send(app, 'PUT', `${base}/items/0`, 'x')).status).toBe(409);
        expect((await send(app, 'POST', `${base}/commit`, '{}')).status).toBe(409);
        const companion = {
            ...manifest,
            items: [
                ...manifest.items,
                { volume: 'data', path: 'app.sqlite-wal', kind: 'file', size: 0, sha256: sha(Buffer.alloc(0)) },
            ],
        };
        expect((await send(app, 'POST', base, JSON.stringify(companion))).status).toBe(422);
        const reserved = {
            ...manifest,
            items: [{ volume: 'data', path: '.socio-restore', kind: 'file', size: 0, sha256: sha(Buffer.alloc(0)) }],
        };
        expect((await send(app, 'POST', base, JSON.stringify(reserved))).status).toBe(422);
        const newer = { ...manifest, schemaVersion: 4 };
        expect((await send(app, 'POST', base, JSON.stringify(newer))).status).toBe(422);
        expect((await send(app, 'POST', base, JSON.stringify(manifest))).status).toBe(200);
        expect((await send(app, 'POST', base, JSON.stringify(manifest))).status).toBe(200);
        const other = await send(app, 'POST', base, JSON.stringify({ ...manifest, createdAt: manifest.createdAt + 1 }));
        expect(other.status).toBe(409);
        expect((await jsonOf(other)).error).toBe('manifest_differs');
    });

    it('refuses an item with a bad chunk, too many or too few bytes, and writes nothing for it', async () => {
        const source = volume();
        const db = new DatabaseSync(join(source, 'big.sqlite'));
        db.exec('CREATE TABLE blobs(b BLOB)');
        db.prepare('INSERT INTO blobs VALUES (?)').run(randomBytes(5 * MiB));
        db.close();
        const { snapshotId, manifest, bytes } = await takeFrom(source);
        const { app, data } = restoring(snapshotId);
        const base = `/__cb/restore/${snapshotId}`;
        await send(app, 'POST', base, JSON.stringify(manifest));
        const flipped = Buffer.from(bytes[0]);
        flipped[4 * MiB + 10] ^= 0xff;
        const bad = await send(app, 'PUT', `${base}/items/0`, flipped);
        expect(bad.status).toBe(422);
        expect((await jsonOf(bad)).message).toMatch(/Chunk 1 of item 0/);
        expect((await send(app, 'PUT', `${base}/items/0`, Buffer.concat([bytes[0], Buffer.from('x')]))).status).toBe(
            422,
        );
        expect((await send(app, 'PUT', `${base}/items/0`, bytes[0].subarray(1))).status).toBe(422);
        expect((await send(app, 'PUT', `${base}/items/1`, 'x')).status).toBe(404);
        expect(existsSync(join(data, 'big.sqlite'))).toBe(false);
        expect((await send(app, 'POST', `${base}/commit`, '{}')).status).toBe(409);
    });

    it('refuses a manifest its volume has no room for: 507', async () => {
        const source = volume();
        writeFileSync(join(source, 'a.txt'), 'acme');
        const { snapshotId, manifest } = await takeFrom(source);
        const exit = vi.fn();
        const socio = makeSocio({ CB_RESTORE_SNAPSHOT: snapshotId });
        const statfs = vi.fn(async () => ({ bavail: 0, bsize: 4096 }));
        serve(socio, { volumes: { data: volume() }, exit, statfs });
        const answer = await send(appOf(socio), 'POST', `/__cb/restore/${snapshotId}`, JSON.stringify(manifest));
        expect(answer.status).toBe(507);
        expect(statfs).toHaveBeenCalled();
    });

    it('takes one manifest when two different ones arrive at once', async () => {
        const source = volume();
        writeFileSync(join(source, 'a.txt'), 'acme');
        const { snapshotId, manifest } = await takeFrom(source);
        const socio = makeSocio({ CB_RESTORE_SNAPSHOT: snapshotId });
        const statfs = vi.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { bavail: 1_000_000, bsize: 4096 };
        });
        serve(socio, { volumes: { data: volume() }, exit: vi.fn(), statfs });
        const app = appOf(socio);
        const base = `/__cb/restore/${snapshotId}`;
        const answers = await Promise.all([
            send(app, 'POST', base, JSON.stringify(manifest)),
            send(app, 'POST', base, JSON.stringify({ ...manifest, createdAt: manifest.createdAt + 1 })),
        ]);
        expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    });

    it('never writes through a symlink in the target volume', async () => {
        const source = volume();
        mkdirSync(join(source, 'uploads'));
        writeFileSync(join(source, 'uploads/a.png'), 'acme image');
        const { snapshotId, manifest, bytes } = await takeFrom(source);
        const outside = volume();
        const target = volume();
        symlinkSync(outside, join(target, 'uploads'));
        const { app } = restoring(snapshotId, target);
        const base = `/__cb/restore/${snapshotId}`;
        await send(app, 'POST', base, JSON.stringify(manifest));
        expect((await send(app, 'PUT', `${base}/items/0`, bytes[0])).status).toBe(422);
        expect(existsSync(join(outside, 'a.png'))).toBe(false);
    });

    it('restores the snapshot’s rows, not later ones, sets WAL back, commits, exits 0 and does not restore twice', async () => {
        const source = volume();
        const db = notesDb(join(source, 'app.sqlite'), 3);
        mkdirSync(join(source, 'uploads'));
        writeFileSync(join(source, 'uploads/a.png'), 'acme image');
        chmodSync(join(source, 'uploads/a.png'), 0o600);
        const { snapshotId, manifest, bytes } = await takeFrom(source);
        db.prepare('INSERT INTO notes(body) VALUES (?)').run('written after the snapshot');
        const { app, data, exit, served } = restoring(snapshotId);
        const base = `/__cb/restore/${snapshotId}`;
        expect((await send(app, 'POST', base, JSON.stringify(manifest))).status).toBe(200);
        for (const [index, body] of bytes.entries()) {
            expect((await send(app, 'PUT', `${base}/items/${index}`, body)).status).toBe(200);
        }
        expect(existsSync(join(data, 'app.sqlite-wal'))).toBe(false);
        const committed = await send(app, 'POST', `${base}/commit`, '{}');
        expect(committed.status).toBe(200);
        expect(await jsonOf(committed)).toEqual({ snapshotId, committed: true });
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
        expect(served.restoreMode).toBe(true);
        expect(existsSync(join(data, 'app.sqlite-wal'))).toBe(false);
        expect(readFileSync(join(data, 'app.sqlite'))[18]).toBe(2);
        expect(countNotes(join(data, 'app.sqlite'))).toBe(3);
        expect(statSync(join(data, 'uploads/a.png')).mode & 0o777).toBe(0o600);
        expect(existsSync(join(data, '.socio-restore-tmp'))).toBe(false);
        const marker = JSON.parse(readFileSync(join(data, '.socio-restore'), 'utf8')) as Record<string, unknown>;
        expect(marker).toMatchObject({ snapshotId, snapshotAt: manifest.createdAt });
        // The restarted task sees the marker: no second restore.
        const again = makeSocio({ CB_RESTORE_SNAPSHOT: snapshotId, CB_RESTORE_HOLD: snapshotId });
        const restarted = serve(again, { volumes: { data } });
        expect(restarted.restoreMode).toBe(false);
        expect((await send(appOf(again), 'POST', base, JSON.stringify(manifest))).status).toBe(409);
    });

    it('runs its own server in restore mode: health, the restore routes for the host only, 503 else, exit after commit', async () => {
        const source = volume();
        writeFileSync(join(source, 'a.txt'), 'acme');
        const { snapshotId, manifest, bytes } = await takeFrom(source);
        const { served, exit } = restoring(snapshotId);
        const server = await served.listenForRestore({ port: 0, host: '127.0.0.1' });
        cleanup.push(() => server.close());
        const url = `http://127.0.0.1:${server.port}`;
        const http = (
            method: string,
            target: string,
            body?: BodyInit | Uint8Array,
            envelope: string | null = hostEnvelope(method, target),
        ) =>
            fetch(`${url}${target}`, {
                method,
                headers: envelope ? { 'x-cb-actor': envelope } : {},
                ...(body === undefined ? {} : { body, duplex: 'half' }),
            } as RequestInit);
        expect((await http('GET', '/healthz', undefined, null)).status).toBe(200);
        expect((await http('GET', '/notes', undefined, null)).status).toBe(503);
        const base = `/__cb/restore/${snapshotId}`;
        expect((await http('POST', base, JSON.stringify(manifest), null)).status).toBe(401);
        expect((await http('POST', base, JSON.stringify(manifest))).status).toBe(200);
        expect((await http('PUT', `${base}/items/0`, bytes[0])).status).toBe(200);
        expect((await http('POST', `${base}/commit`, '{}')).status).toBe(200);
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(exit).toHaveBeenCalledTimes(1);
    });
});

describe('the hold on outward work', () => {
    it('reads as held from CB_RESTORE_HOLD until released, even before serve; undefined without it', () => {
        expect(makeSocio().backup.restored).toBeUndefined();
        const id = newSnapshotId();
        expect(makeSocio({ CB_RESTORE_HOLD: id }).backup.restored).toEqual({
            snapshotId: id,
            snapshotAt: null,
            held: true,
        });
        expect(makeSocio({ CB_RESTORE_HOLD: 'not-an-id' }).backup.restored).toBeUndefined();
    });

    it('releases only its own hold, once, runs onRelease, and stays released across restarts', async () => {
        const data = volume();
        const id = newSnapshotId();
        writeFileSync(join(data, '.socio-restore'), JSON.stringify({ snapshotId: id, snapshotAt: NOW - 1000 }));
        const socio = makeSocio({ CB_RESTORE_SNAPSHOT: id, CB_RESTORE_HOLD: id });
        const served = serve(socio, { volumes: { data } });
        expect(served.restoreMode).toBe(false);
        expect(socio.backup.restored).toEqual({ snapshotId: id, snapshotAt: NOW - 1000, held: true });
        const released = vi.fn();
        socio.backup.onRelease(released);
        const unsubscribed = vi.fn();
        socio.backup.onRelease(unsubscribed)();
        const app = appOf(socio);
        const release = (snapshotId: string) =>
            send(app, 'POST', '/__cb/restore/release', JSON.stringify({ snapshotId }));
        expect((await release(newSnapshotId())).status).toBe(409);
        expect((await send(app, 'POST', '/__cb/restore/release', '{}')).status).toBe(400);
        expect(
            (
                await send(
                    app,
                    'POST',
                    '/__cb/restore/release',
                    JSON.stringify({ snapshotId: id }),
                    personEnvelope('POST', '/__cb/restore/release'),
                )
            ).status,
        ).toBe(401);
        expect(socio.backup.restored?.held).toBe(true);
        expect((await release(id)).status).toBe(200);
        expect(socio.backup.restored?.held).toBe(false);
        expect(released).toHaveBeenCalledExactlyOnceWith(id);
        expect(unsubscribed).not.toHaveBeenCalled();
        expect((await release(id)).status).toBe(200);
        expect(released).toHaveBeenCalledTimes(1);
        const restarted = makeSocio({ CB_RESTORE_HOLD: id });
        serve(restarted, { volumes: { data } });
        expect(restarted.backup.restored?.held).toBe(false);
    });

    it('runs every replica’s onRelease once, whichever replica the release reached', async () => {
        const shared = volume();
        const id = newSnapshotId();
        writeFileSync(join(shared, '.socio-restore'), JSON.stringify({ snapshotId: id, snapshotAt: NOW - 1000 }));
        const a = makeSocio({ CB_RESTORE_HOLD: id });
        const b = makeSocio({ CB_RESTORE_HOLD: id });
        const c = makeSocio({ CB_RESTORE_HOLD: id });
        const onA = vi.fn();
        const onB = vi.fn();
        const onC = vi.fn();
        a.backup.onRelease(onA);
        b.backup.onRelease(onB);
        c.backup.onRelease(onC);
        serve(a, { volumes: { data: shared } });
        const servedB = serve(b, { volumes: { data: shared } });
        serve(c, { volumes: { data: shared } });
        const release = (socio: Socio) =>
            send(appOf(socio), 'POST', '/__cb/restore/release', JSON.stringify({ snapshotId: id }));
        expect((await release(a)).status).toBe(200);
        expect(onA).toHaveBeenCalledExactlyOnceWith(id);
        // B sees the marker on its next sweep.
        clock += 2000;
        await servedB.sweep();
        expect(onB).toHaveBeenCalledExactlyOnceWith(id);
        // C gets the host's retry itself after A wrote the marker.
        expect((await release(c)).status).toBe(200);
        expect(onC).toHaveBeenCalledExactlyOnceWith(id);
        await release(b);
        expect(onB).toHaveBeenCalledTimes(1);
        // A process started after the release runs nothing.
        const d = makeSocio({ CB_RESTORE_HOLD: id });
        const onD = vi.fn();
        d.backup.onRelease(onD);
        const servedD = serve(d, { volumes: { data: shared } });
        await servedD.sweep();
        expect(d.backup.restored?.held).toBe(false);
        expect(onD).not.toHaveBeenCalled();
    });

    it('refuses a release when no hold is set', async () => {
        const socio = makeSocio();
        serve(socio, { volumes: { data: volume() } });
        const answer = await send(
            appOf(socio),
            'POST',
            '/__cb/restore/release',
            JSON.stringify({ snapshotId: newSnapshotId() }),
        );
        expect(answer.status).toBe(409);
    });
});

describe('socio.backup.request', () => {
    it('asks the workspace with the plugin’s identity and proof, and refuses a bad reason', async () => {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        const fake = (async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return new Response(null, { status: 202 });
        }) as unknown as typeof fetch;
        const socio = makeSocio({}, fake);
        expect(await socio.backup.request({ reason: 'Acme import finished' })).toEqual({ ok: true, status: 202 });
        expect(calls[0].url).toBe('http://socio.test/api/plugins/acme-notes/backup/request');
        expect(calls[0].init.headers).toMatchObject({
            authorization: 'Bearer acme-identity',
            'x-cb-plugin-proof': 'acme-proof',
        });
        expect(JSON.parse(String(calls[0].init.body))).toEqual({ reason: 'Acme import finished' });
        await expect(socio.backup.request({ reason: ' ' })).rejects.toThrow(/reason/);
        await expect(socio.backup.request({ reason: 'x'.repeat(201) })).rejects.toThrow(/reason/);
        const unconfigured = socioApp({ appId: `plugin:${PLUGIN}`, key: KEY.toString('base64url'), env: {} });
        await expect(unconfigured.backup.request({ reason: 'Acme' })).rejects.toThrow(/not configured/);
        const app = socioApp({ appId: 'tracker', key: KEY.toString('base64url'), env: {} });
        await expect(app.backup.request({ reason: 'Acme' })).rejects.toThrow(/service plugins/);
    });
});

describe('the Node adapters', () => {
    const listen = async (server: Server) => {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };

    it('node(): routes the host’s backup calls, streams items, and holds writes', async () => {
        const data = volume();
        writeFileSync(join(data, 'a.txt'), 'acme');
        const socio = makeSocio();
        const served = serve(socio, { volumes: { data } });
        const url = await listen(
            createServer(
                socio.node((_request, response) => {
                    response.writeHead(200);
                    response.end('acme app');
                }),
            ),
        );
        const http = (method: string, target: string, body?: string, envelope = hostEnvelope(method, target)) =>
            fetch(`${url}${target}`, { method, headers: { 'x-cb-actor': envelope }, ...(body ? { body } : {}) });
        const id = newSnapshotId();
        expect(
            (await http('POST', '/__cb/backup', JSON.stringify({ snapshotId: id, reason: 'manual', quiesce: false })))
                .status,
        ).toBe(202);
        await served.settled();
        const ready = (await (await http('GET', `/__cb/backup/${id}`)).json()) as { manifest: PluginSnapshotManifest };
        expect(ready.manifest.items[0].path).toBe('a.txt');
        expect(await (await http('GET', `/__cb/backup/${id}/items/0`)).text()).toBe('acme');
        await http('POST', '/__cb/backup/quiesce', JSON.stringify({ snapshotId: id }));
        const held = await http('POST', '/notes', '{}', personEnvelope('POST', '/notes'));
        expect(held.status).toBe(503);
        expect(held.headers.get('retry-after')).toBe('5');
        expect((await http('GET', '/notes', undefined, personEnvelope('GET', '/notes'))).status).toBe(200);
    });

    it('express(): requirePrincipal answers the host’s routes itself', async () => {
        const data = volume();
        writeFileSync(join(data, 'a.txt'), 'acme');
        const socio = makeSocio();
        serve(socio, { volumes: { data } });
        const { requirePrincipal } = socio.express();
        const url = await listen(
            createServer((request, response) =>
                requirePrincipal(request, response, () => {
                    response.writeHead(200);
                    response.end('acme app');
                }),
            ),
        );
        const target = '/__cb/backup';
        const answer = await fetch(`${url}${target}`, {
            method: 'POST',
            headers: { 'x-cb-actor': hostEnvelope('POST', target) },
            body: JSON.stringify({ snapshotId: newSnapshotId(), reason: 'manual', quiesce: false }),
        });
        expect(answer.status).toBe(202);
    });

    it('hono(): requirePrincipal answers the host’s routes and holds writes', async () => {
        const socio = makeSocio();
        serve(socio, { volumes: { data: volume() } });
        const { requirePrincipal } = socio.hono();
        const run = async (request: Request) => {
            let reached = false;
            const c = {
                req: { raw: request },
                set: () => undefined,
                get: () => undefined,
                text: (body: string, status: number) => new Response(body, { status }),
            };
            const answer = await requirePrincipal()(c, async () => {
                reached = true;
            });
            return { answer, reached };
        };
        const hold = await run(
            new Request('http://plugin.invalid/__cb/backup/quiesce', {
                method: 'POST',
                headers: { 'x-cb-actor': hostEnvelope('POST', '/__cb/backup/quiesce') },
                body: JSON.stringify({ snapshotId: newSnapshotId() }),
            }),
        );
        expect(hold.answer?.status).toBe(200);
        expect(hold.reached).toBe(false);
        const write = await run(
            new Request('http://plugin.invalid/notes', {
                method: 'POST',
                headers: { 'x-cb-actor': personEnvelope('POST', '/notes') },
            }),
        );
        expect(write.answer?.status).toBe(503);
        expect(write.reached).toBe(false);
    });
});

describe('vendoring', () => {
    const root = join(import.meta.dirname, '..');
    const read = (path: string) => readFileSync(join(root, path), 'utf8');

    it('ships the SDK with a byte-identical copy of the snapshot check', () => {
        expect(read('packages/app-sdk/src/snapshot.ts')).toBe(read('packages/shared/src/plugins/plugin-snapshot.ts'));
    });

    it('keeps the backup side and its kit to Node built-ins and the files they name', () => {
        const imports = (path: string) =>
            [...read(path).matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1]).sort();
        expect(imports('packages/app-sdk/src/backup.ts').filter((name) => !name.startsWith('node:'))).toEqual([
            './snapshot.js',
        ]);
        expect(imports('packages/app-sdk/src/backup-check.ts').filter((name) => !name.startsWith('node:'))).toEqual([
            './envelope.js',
            './snapshot.js',
        ]);
        expect(imports('packages/app-sdk/src/snapshot.ts')).toEqual([]);
    });
});
